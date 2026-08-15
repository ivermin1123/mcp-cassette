/**
 * Cassette format v1 — an open, append-only JSONL file.
 *
 * Line 1:   { "type": "header", ... }
 * Line 2+:  { "type": "frame", "t": <ms offset>, "dir": "c2s"|"s2c", "frame": {...} }
 *           { "type": "raw",   "t": <ms offset>, "dir": "c2s"|"s2c", "data": "..." }
 *
 * "c2s" = client → server, "s2c" = server → client.
 * "raw" entries preserve non-JSON-RPC lines (e.g. a server that logs to stdout)
 * so a recording is a faithful transcript even of misbehaving servers.
 */

import fs from "node:fs";
import { JsonRpcFrame } from "./jsonrpc.js";

export const CASSETTE_VERSION = 1;

export type Direction = "c2s" | "s2c";

export interface CassetteHeader {
  type: "header";
  cassetteVersion: number;
  recorder: string;
  startedAt: string;
  transport: "stdio";
  command?: string[];
  /** Absent on cassettes written before redaction existed — treat as not applied. */
  redaction?: { applied: boolean };
}

export interface FrameEntry {
  type: "frame";
  t: number;
  dir: Direction;
  frame: JsonRpcFrame;
}

export interface RawEntry {
  type: "raw";
  t: number;
  dir: Direction;
  data: string;
}

export type CassetteEntry = CassetteHeader | FrameEntry | RawEntry;

export interface Cassette {
  header: CassetteHeader;
  entries: (FrameEntry | RawEntry)[];
}

export class CassetteWriter {
  private stream: fs.WriteStream;
  private start = Date.now();

  constructor(path: string, command?: string[], redaction: { applied: boolean } = { applied: false }) {
    this.stream = fs.createWriteStream(path, { flags: "w" });
    const header: CassetteHeader = {
      type: "header",
      cassetteVersion: CASSETTE_VERSION,
      recorder: "mcp-cassette@0.1.0",
      startedAt: new Date().toISOString(),
      transport: "stdio",
      command,
      redaction,
    };
    this.stream.write(JSON.stringify(header) + "\n");
  }

  frame(dir: Direction, frame: JsonRpcFrame): void {
    const entry: FrameEntry = { type: "frame", t: Date.now() - this.start, dir, frame };
    this.stream.write(JSON.stringify(entry) + "\n");
  }

  raw(dir: Direction, data: string): void {
    const entry: RawEntry = { type: "raw", t: Date.now() - this.start, dir, data };
    this.stream.write(JSON.stringify(entry) + "\n");
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.stream.end(() => resolve()));
  }
}

export function readCassette(path: string): Cassette {
  const content = fs.readFileSync(path, "utf8");
  const lines = content.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) throw new Error(`Cassette is empty: ${path}`);

  const first = JSON.parse(lines[0]!) as CassetteEntry;
  if (first.type !== "header") {
    throw new Error(`Cassette has no header line: ${path}`);
  }
  if (first.cassetteVersion !== CASSETTE_VERSION) {
    throw new Error(
      `Unsupported cassette version ${first.cassetteVersion} (supported: ${CASSETTE_VERSION})`
    );
  }

  const entries: (FrameEntry | RawEntry)[] = [];
  for (const line of lines.slice(1)) {
    const entry = JSON.parse(line) as CassetteEntry;
    if (entry.type === "frame" || entry.type === "raw") entries.push(entry);
  }
  return { header: first, entries };
}

/** Write a cassette back out in the same append-only JSONL shape. */
export function writeCassette(path: string, cassette: Cassette): void {
  const lines = [cassette.header, ...cassette.entries].map((e) => JSON.stringify(e));
  fs.writeFileSync(path, lines.join("\n") + "\n");
}
