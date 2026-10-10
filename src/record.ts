/**
 * `mcp-cassette record -o out.cassette.jsonl -- <server command...>`
 *
 * Transparent stdio proxy: the MCP client talks to this process as if it were
 * the server; every byte is forwarded verbatim in both directions while every
 * JSON-RPC frame is captured into the cassette. Works with any server,
 * any SDK, any spec revision: recording happens at the transport level.
 *
 * Frames are redacted on the way into the cassette (see redact.ts) so the file
 * is safe to commit; the bytes forwarded to the client and the server are the
 * originals, so redaction stays invisible to the live session.
 */

import fs from "node:fs";
import { spawn } from "node:child_process";
import {
  cassetteEra,
  cassetteExists,
  readCassette,
  CassetteWriter,
  CASSETTE_VERSION,
  type Cassette,
  type CassetteHeader,
  type Direction,
  type FrameEntry,
  type RawEntry,
} from "./cassette.js";
import { isRequest, LineBuffer, parseFrame } from "./jsonrpc.js";
import { highestLiveId, liveId, SUBSCRIPTION_ID_KEY } from "./replay.js";
import { redactCommand, redactFrame, redactRawLine, BUILTIN_REDACTION, type CompiledRedactConfig } from "./redact.js";
import { RECORDER } from "./version.js";
import type { JsonRpcFrame, JsonRpcId } from "./jsonrpc.js";

export type RecordMode = "once" | "all" | "append";

export interface RecordOptions {
  out: string;
  command: string[];
  /** Redact secrets before writing. Default: true. */
  redact?: boolean;
  /**
   * "once" (default): refuse to overwrite an existing cassette. "all": always
   * re-record. "append": add this session to the cassette already there.
   */
  mode?: RecordMode;
  /** The user's own redaction rules, compiled. Built-ins only when absent. */
  redactConfig?: CompiledRedactConfig;
}

/** What the stdio recorder writes into: the truncating writer, or the appender. */
type RecordSink = Pick<CassetteWriter, "frame" | "raw" | "close" | "discard">;

/**
 * `--mode once` protects a cassette you already have. It does not protect a
 * zero-byte leftover from a crashed run: that file holds nothing to replay,
 * and refusing to overwrite it would strand the user with a path they have to
 * delete by hand.
 */
export function ensureWritable(out: string, mode: RecordMode): void {
  if (mode !== "once" || !fs.existsSync(out)) return;
  if (cassetteExists(out)) {
    throw new Error(`record: ${out} already exists. Replay it, or pass --mode all to re-record over it`);
  }
  process.stderr.write(
    `mcp-cassette: ${out} exists but holds no cassette header (a recording that never flushed); re-recording over it\n`
  );
}

/**
 * The cassette `--mode append` writes into, or null when the path holds none
 * yet and this session is the one that creates it.
 *
 * A header on disk is never rewritten, so a session that contradicts it has to
 * be refused instead. `lint` reads a cassette's header against its own frames,
 * and a file that fails it fails confusingly at replay time, where the header
 * decides behaviour and is never re-derived from the frames. Every field
 * compared here is one `lint` or `replay` acts on.
 */
function appendTarget(out: string, session: CassetteHeader, quiet = false): Cassette | null {
  if (!cassetteExists(out)) return null;
  const cassette = readCassette(out, quiet ? () => undefined : undefined);
  const header = cassette.header;
  const refuse = (why: string): never => {
    throw new Error(`record --mode append: ${out} ${why}`);
  };

  if (header.transport !== session.transport) {
    refuse(
      `is a ${header.transport} recording and this session is a ${session.transport} one; one cassette holds one transport`
    );
  }
  if (!Number.isFinite(Date.parse(header.startedAt))) {
    refuse(
      `has no readable \`startedAt\` in its header (${JSON.stringify(header.startedAt)}), so the appended frames have no time origin`
    );
  }
  if (JSON.stringify(header.command ?? null) !== JSON.stringify(session.command ?? null)) {
    refuse(
      `records ${JSON.stringify(header.command)} and this session runs ${JSON.stringify(session.command)}; ` +
        "the header names the one server that produced the file"
    );
  }
  // Redaction runs before replay fingerprints a request, so two rule sets in
  // one file hash different text and half of it stops matching. Replay refuses
  // a cassette whose recorded hash is not the config's; this refuses building
  // the cassette that would trip it.
  const applied = header.redaction?.applied === true;
  if (applied !== (session.redaction?.applied === true)) {
    refuse(
      `was recorded with redaction ${applied ? "on" : "off"} and this session has it ${applied ? "off" : "on"}; ` +
        "replay matches on the redacted text, so one cassette cannot hold both"
    );
  }
  if ((header.redaction?.configHash ?? null) !== (session.redaction?.configHash ?? null)) {
    refuse(
      "was recorded under a different --redact-config; replay refuses a cassette whose recorded hash is not the config's"
    );
  }
  return cassette;
}

/**
 * Does this file need a newline before the next line is appended?
 *
 * Every cassette this tool writes ends in one, but a cassette is an open text
 * format and gets hand-edited; without this check the first appended entry
 * would land on the end of the last line and take it with it.
 */
function needsNewline(path: string): boolean {
  const size = fs.statSync(path).size;
  if (size === 0) return false;
  const fd = fs.openSync(path, "r");
  try {
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    fs.closeSync(fd);
  }
}

/** The one frame a stdio session can record that an era of `"modern"` forbids. */
function isHandshake(entry: FrameEntry | RawEntry): boolean {
  return entry.type === "frame" && entry.dir === "c2s" && isRequest(entry.frame) && entry.frame.method === "initialize";
}

/**
 * The subscription a 2026-07-28 frame belongs to is the id of the
 * `subscriptions/listen` that opened it, carried in `_meta`. It is one of this
 * session's own ids, so it is minted with them; otherwise the acknowledgment
 * and the change notifications stop naming their own listen.
 */
function remapSubscription(container: unknown, mint: (id: JsonRpcId) => JsonRpcId): unknown {
  if (!container || typeof container !== "object") return container;
  const obj = container as Record<string, unknown>;
  const meta = obj._meta as Record<string, unknown> | undefined;
  const id = meta?.[SUBSCRIPTION_ID_KEY];
  if (id === undefined || id === null) return container;
  return { ...obj, _meta: { ...meta, [SUBSCRIPTION_ID_KEY]: mint(id as JsonRpcId) } };
}

/**
 * `--mode append`: this session's frames, added to a cassette that already has
 * a header, in one block when the session ends.
 *
 * Three disciplines, each paying for itself.
 *
 * **Nothing reaches disk before the session ends.** The header cannot be
 * rewritten, so a session that would contradict it has to leave the file
 * exactly as it found it, and whether it contradicts it is only settled once
 * every frame is in hand.
 *
 * **The block goes out in one append.** Two recorders overlap whenever a client
 * opens its second connection before closing the first, and a single
 * `appendFileSync` under `O_APPEND` cannot land inside another process's line.
 * It also reads the file at that moment rather than at startup, so a sibling
 * that finished first is already visible.
 *
 * **Ids are minted, not copied.** Both connections of one client start at id 1,
 * and a reader pairs a response with its request by id, so this session's ids
 * are re-keyed into the same `live-N` sequence the passthrough spy mints from.
 */
export class CassetteAppender {
  private start = Date.now();
  private header: CassetteHeader;
  private block: (FrameEntry | RawEntry)[] = [];

  constructor(
    private path: string,
    command?: string[],
    redaction: { applied: boolean; configHash?: string } = { applied: false }
  ) {
    this.header = {
      type: "header",
      cassetteVersion: CASSETTE_VERSION,
      recorder: RECORDER,
      startedAt: new Date().toISOString(),
      transport: "stdio",
      command,
      redaction,
    };
    // Refuse before the caller spawns anything: a contradiction found after the
    // session is a recording nobody can keep.
    appendTarget(path, this.header);
  }

  frame(dir: Direction, frame: JsonRpcFrame): void {
    this.block.push({ type: "frame", t: Date.now() - this.start, dir, frame });
  }

  raw(dir: Direction, data: string): void {
    this.block.push({ type: "raw", t: Date.now() - this.start, dir, data });
  }

  /** Abandon the session: a server that never started leaves the file as it was. */
  discard(): Promise<void> {
    this.block = [];
    return Promise.resolve();
  }

  async close(): Promise<void> {
    // Twice at most: another recorder may create the cassette between the look
    // and the write, and then this block belongs under that header.
    for (let attempt = 0; attempt < 2; attempt++) {
      const target = appendTarget(this.path, this.header, true);
      if (target) {
        this.append(target);
        return;
      }
      if (this.create()) return;
    }
    throw new Error(`record --mode append: ${this.path} could not be read as a cassette, and could not be created`);
  }

  /**
   * Nobody has recorded here yet, so this session writes the header too. `wx`
   * loses to a sibling that got in first rather than truncating it; a file that
   * holds no header is not a cassette, and is replaced the way `--mode once`
   * steps over the same leftover.
   */
  private create(): boolean {
    const lines = [this.header, ...this.block].map((entry) => JSON.stringify(entry) + "\n").join("");
    const leftover = fs.existsSync(this.path);
    if (leftover) {
      process.stderr.write(
        `mcp-cassette: ${this.path} exists but holds no cassette header (a recording that never flushed); recording into it as a new one\n`
      );
    }
    try {
      fs.writeFileSync(this.path, lines, { flag: leftover ? "w" : "wx" });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
  }

  private append(target: Cassette): void {
    if (this.block.length === 0) return; // nothing recorded; the file stays as it was
    if (cassetteEra(target.header) === "modern" && this.block.some(isHandshake)) {
      throw new Error(
        `record --mode append: ${this.path} declares the modern era, which has no handshake, and this session ` +
          "recorded an `initialize` request. Record it into a file of its own"
      );
    }
    // One file, one timeline. Every `t` is the offset from the header's own
    // `startedAt`, so a reader that sorts by it keeps the two connections in
    // the order they happened, which is how replay decides where a
    // server-initiated frame belongs.
    const delta = Math.max(0, this.start - Date.parse(target.header.startedAt));
    let seq = highestLiveId(target.entries);
    const minted = new Map<string, JsonRpcId>();
    const mint = (id: JsonRpcId): JsonRpcId => {
      const key = String(id);
      let next = minted.get(key);
      if (next === undefined) {
        next = liveId(++seq);
        minted.set(key, next);
      }
      return next;
    };
    const lines = this.block
      .map((entry) => JSON.stringify(entry.type === "raw" ? { ...entry, t: entry.t + delta } : rekey(entry, delta, mint)))
      .join("\n");
    fs.appendFileSync(this.path, (needsNewline(this.path) ? "\n" : "") + lines + "\n");
  }
}

/**
 * One entry as it goes into the file: this session's `t` moved onto the file's
 * own origin, and every id it carries minted. A frame names at most two, its
 * own JSON-RPC id and the subscription it belongs to.
 */
function rekey(entry: FrameEntry, delta: number, mint: (id: JsonRpcId) => JsonRpcId): FrameEntry {
  const next = { ...entry.frame } as JsonRpcFrame & { id?: JsonRpcId; params?: unknown; result?: unknown };
  if (next.id !== undefined && next.id !== null) next.id = mint(next.id);
  if ("params" in next) next.params = remapSubscription(next.params, mint);
  if ("result" in next) next.result = remapSubscription(next.result, mint);
  return { ...entry, t: entry.t + delta, frame: next };
}

export function runRecord(opts: RecordOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = opts.command;
    if (!cmd) {
      reject(new Error("record: missing server command after --"));
      return;
    }

    const mode = opts.mode ?? "once";
    const redact = opts.redact !== false;
    const cfg = opts.redactConfig ?? BUILTIN_REDACTION;
    const command = redact ? redactCommand(opts.command, cfg) : opts.command;
    // The hash goes in only when redaction actually ran: a --no-redact
    // recording was written under no rules at all, whatever file was passed.
    const redaction = { applied: redact, ...(redact && cfg.hash ? { configHash: cfg.hash } : {}) };
    let writer: RecordSink;
    try {
      ensureWritable(opts.out, mode);
      writer =
        mode === "append"
          ? new CassetteAppender(opts.out, command, redaction)
          : new CassetteWriter(opts.out, command, redaction);
    } catch (err) {
      reject(err as Error);
      return;
    }
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"] });

    const c2sBuf = new LineBuffer();
    const s2cBuf = new LineBuffer();

    const capture = (dir: "c2s" | "s2c", lines: string[]) => {
      for (const line of lines) {
        if (line.trim() === "") continue;
        const frame = parseFrame(line);
        if (frame) writer.frame(dir, redact ? (redactFrame(frame, cfg) as JsonRpcFrame) : frame);
        else writer.raw(dir, redact ? redactRawLine(line, cfg) : line);
      }
    };

    // client -> server: forward verbatim, capture in parallel
    process.stdin.on("data", (chunk: Buffer) => {
      child.stdin.write(chunk);
      capture("c2s", c2sBuf.feed(chunk.toString("utf8")));
    });
    process.stdin.on("end", () => child.stdin.end());

    // server -> client: forward verbatim, capture in parallel
    child.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      capture("s2c", s2cBuf.feed(chunk.toString("utf8")));
    });

    child.on("error", (err) => {
      // A server that never started must not leave a cassette behind for the
      // next `--mode once` run to trip over. The stdio writer puts its header on
      // disk immediately, so discarding the buffer is not enough: the file that
      // this run created, and already truncated, goes with it. `--mode append`
      // wrote nothing, and the file it would have been added to belongs to the
      // runs before this one.
      void writer.discard().then(() => {
        if (mode !== "append") fs.rmSync(opts.out, { force: true });
        reject(new Error(`record: failed to start server command: ${err.message}`));
      });
    });

    const finish = (code: number) => {
      capture("c2s", [c2sBuf.flush()]);
      capture("s2c", [s2cBuf.flush()]);
      // An append refuses the whole session when it would contradict the header
      // it cannot rewrite, so closing is a step that can fail.
      writer.close().then(() => resolve(code), reject);
    };

    child.on("close", (code) => finish(code ?? 0));

    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.on(sig, () => {
        child.kill(sig);
      });
    }
  });
}
