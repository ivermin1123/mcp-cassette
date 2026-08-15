/**
 * Cassette format v2 — an open, append-only JSONL file.
 *
 * Line 1:   { "type": "header", ... }
 * Line 2+:  { "type": "frame",  "t": <ms offset>, "dir": "c2s"|"s2c", "frame": {...} }
 *           { "type": "raw",    "t": <ms offset>, "dir": "c2s"|"s2c", "data": "..." }
 *           { "type": "chunks", "t": <ms offset>, "dir": "s2c", "chunks": [...] }
 *
 * "c2s" = client → server, "s2c" = server → client.
 * "raw" entries preserve non-JSON-RPC lines (e.g. a server that logs to stdout);
 * "chunks" entries hold a streamed (SSE) response, frame by frame as it
 * appeared on the wire, because a merged payload never existed there.
 *
 * v2 is v1 plus optional fields — nothing renamed, removed, or re-typed.
 * v1 files read forever; a missing `era` means `"legacy"`. Unknown entry types
 * are skipped with a warning; a future-version file is refused, not half-read.
 */

import fs from "node:fs";
import { JsonRpcFrame } from "./jsonrpc.js";
import { RECORDER } from "./version.js";

export const CASSETTE_VERSION = 2;
const SUPPORTED_VERSIONS = [1, 2];

export type Direction = "c2s" | "s2c";

/** "legacy" = classic initialize handshake (≤ 2025-11-25); "modern" = stateless lifecycle (2026-07-28). */
export type Era = "legacy" | "modern";

export interface CassetteHeader {
  type: "header";
  cassetteVersion: number;
  recorder: string;
  startedAt: string;
  transport: "stdio" | "http";
  command?: string[];
  /** HTTP recordings only: the upstream URL, redacted like command args. */
  url?: string;
  /** Absent on v1 cassettes and undecided sessions — treat as "legacy". */
  era?: Era;
  /** Legacy-era HTTP only: the recorded server minted an Mcp-Session-Id. The value itself is never stored. */
  sessioned?: boolean;
  /** Absent on cassettes written before redaction existed — treat as not applied. */
  redaction?: { applied: boolean };
}

/** The era a cassette speaks; a missing header field means "legacy" (the v1→v2 migration rule). */
export function cassetteEra(header: CassetteHeader): Era {
  return header.era ?? "legacy";
}

export interface FrameEntry {
  type: "frame";
  t: number;
  dir: Direction;
  frame: JsonRpcFrame;
  /** Present on entries appended by `replay --on-miss passthrough`, absent on originally recorded ones. */
  origin?: "live";
  /**
   * Only when the HTTP status is not the derivable default (request → 200,
   * notification → 202, SSE → 200) — e.g. a modern-era 400 that replay must
   * reproduce faithfully.
   */
  http?: { status: number };
}

export interface RawEntry {
  type: "raw";
  t: number;
  dir: Direction;
  data: string;
}

export interface ChunksEntry {
  type: "chunks";
  t: number;
  dir: Direction;
  /** Request id the stream answers; absent for a legacy standalone GET stream. */
  id?: number | string;
  /** How the stream was opened: "post" (default, may be omitted) or "get". */
  via?: "post" | "get";
  /** Each streamed frame as it appeared on the wire; `t` is the ms offset from session start. */
  chunks: { t: number; frame: JsonRpcFrame }[];
  /** Present on entries appended by `replay --on-miss passthrough`, absent on originally recorded ones. */
  origin?: "live";
}

export type CassetteEntry = CassetteHeader | FrameEntry | RawEntry | ChunksEntry;

export interface Cassette {
  header: CassetteHeader;
  entries: (FrameEntry | RawEntry | ChunksEntry)[];
}

export interface CassetteWriterOptions {
  transport?: "stdio" | "http";
  url?: string;
  era?: Era;
  sessioned?: boolean;
  /**
   * Buffer entries in memory so the era — decided only by the first successful
   * exchange — can still make it into line 1. `setEra()` flushes; an undecided
   * session flushes at close with `era` omitted (readers default to "legacy").
   */
  deferHeader?: boolean;
}

export class CassetteWriter {
  private stream: fs.WriteStream;
  private start = Date.now();
  private header: CassetteHeader;
  /** Buffered entry lines while the header is deferred; null once the header is on disk. */
  private pending: string[] | null;

  constructor(
    path: string,
    command?: string[],
    redaction: { applied: boolean } = { applied: false },
    options: CassetteWriterOptions = {}
  ) {
    this.stream = fs.createWriteStream(path, { flags: "w" });
    this.header = {
      type: "header",
      cassetteVersion: CASSETTE_VERSION,
      recorder: RECORDER,
      startedAt: new Date().toISOString(),
      transport: options.transport ?? "stdio",
      url: options.url,
      command,
      era: options.era,
      sessioned: options.sessioned,
      redaction,
    };
    this.pending = options.deferHeader ? [] : null;
    if (this.pending === null) this.stream.write(JSON.stringify(this.header) + "\n");
  }

  /**
   * The upstream minted a session id. Only the fact is recorded, never the
   * value; once the header is on disk there is nothing left to amend.
   */
  markSessioned(): void {
    if (this.pending !== null) this.header.sessioned = true;
  }

  /** Deferred-header mode only: record the decided era and flush header + buffered entries. */
  setEra(era: Era): void {
    if (this.pending === null) {
      throw new Error("cassette header already written — the era can no longer change");
    }
    this.header.era = era;
    this.flushPending();
  }

  private flushPending(): void {
    if (this.pending === null) return;
    this.stream.write(JSON.stringify(this.header) + "\n");
    for (const line of this.pending) this.stream.write(line);
    this.pending = null;
  }

  private emit(entry: FrameEntry | RawEntry | ChunksEntry): void {
    const line = JSON.stringify(entry) + "\n";
    if (this.pending !== null) this.pending.push(line);
    else this.stream.write(line);
  }

  frame(dir: Direction, frame: JsonRpcFrame, http?: { status: number }): void {
    this.emit({ type: "frame", t: Date.now() - this.start, dir, frame, ...(http ? { http } : {}) });
  }

  raw(dir: Direction, data: string): void {
    this.emit({ type: "raw", t: Date.now() - this.start, dir, data });
  }

  close(): Promise<void> {
    this.flushPending();
    return new Promise((resolve) => this.stream.end(() => resolve()));
  }

  /**
   * Abandon the recording: drop whatever is buffered and close without writing
   * a header. A session that never started must not leave a valid-looking
   * cassette behind — the next run would refuse to overwrite it. In deferred
   * mode nothing has reached disk yet, so the file is left at zero bytes, which
   * `cassetteExists` reads as "no cassette here". Anything already written
   * stays written; this cannot unwrite it.
   */
  discard(): Promise<void> {
    this.pending = null;
    return new Promise((resolve) => this.stream.end(() => resolve()));
  }
}

/**
 * Is there a cassette at this path? An empty file, or one whose first line is
 * not a header, is a recording that died before its header reached disk — not
 * a cassette worth protecting. Anything we cannot prove broken counts as real.
 */
export function cassetteExists(path: string): boolean {
  let size: number;
  try {
    size = fs.statSync(path).size;
  } catch {
    return false;
  }
  if (size === 0) return false;
  const fd = fs.openSync(path, "r");
  try {
    const buf = Buffer.alloc(Math.min(size, 64 * 1024));
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, read).toString("utf8");
    const newline = text.indexOf("\n");
    if (newline === -1 && read < size) return true; // a header longer than we looked
    try {
      return (JSON.parse(newline === -1 ? text : text.slice(0, newline)) as { type?: string }).type === "header";
    } catch {
      return false;
    }
  } finally {
    fs.closeSync(fd);
  }
}

export function readCassette(
  path: string,
  warn: (message: string) => void = (message) => process.stderr.write(`mcp-cassette: ${message}\n`)
): Cassette {
  const content = fs.readFileSync(path, "utf8");
  const lines = content.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) throw new Error(`Cassette is empty: ${path}`);

  const first = JSON.parse(lines[0]!) as CassetteEntry;
  if (first.type !== "header") {
    throw new Error(`Cassette has no header line: ${path}`);
  }
  const version = first.cassetteVersion;
  if (!SUPPORTED_VERSIONS.includes(version)) {
    const supported = SUPPORTED_VERSIONS.join(", ");
    throw new Error(
      typeof version === "number" && version > CASSETTE_VERSION
        ? `Cassette version ${version} was recorded with a newer mcp-cassette (this build supports ${supported}) — upgrade mcp-cassette to read ${path}`
        : `Unsupported cassette version ${version} (supported: ${supported})`
    );
  }

  const entries: (FrameEntry | RawEntry | ChunksEntry)[] = [];
  for (const line of lines.slice(1)) {
    const entry = JSON.parse(line) as CassetteEntry;
    if (entry.type === "frame" || entry.type === "raw" || entry.type === "chunks") {
      entries.push(entry);
    } else {
      warn(`skipping unknown cassette entry type "${String(entry.type)}" in ${path} (recorded with a newer mcp-cassette?)`);
    }
  }
  return { header: first, entries };
}

/** Write a cassette back out in the same append-only JSONL shape. */
export function writeCassette(path: string, cassette: Cassette): void {
  const lines = [cassette.header, ...cassette.entries].map((e) => JSON.stringify(e));
  fs.writeFileSync(path, lines.join("\n") + "\n");
}
