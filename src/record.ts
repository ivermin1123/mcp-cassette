/**
 * `mcp-cassette record -o out.cassette.jsonl -- <server command...>`
 *
 * Transparent stdio proxy: the MCP client talks to this process as if it were
 * the server; every byte is forwarded verbatim in both directions while every
 * JSON-RPC frame is captured into the cassette. Works with any server,
 * any SDK, any spec revision — recording happens at the transport level.
 *
 * Frames are redacted on the way into the cassette (see redact.ts) so the file
 * is safe to commit; the bytes forwarded to the client and the server are the
 * originals, so redaction stays invisible to the live session.
 */

import fs from "node:fs";
import { spawn } from "node:child_process";
import { cassetteExists, CassetteWriter } from "./cassette.js";
import { LineBuffer, parseFrame } from "./jsonrpc.js";
import { redactCommand, redactFrame, redactRawLine } from "./redact.js";
import type { JsonRpcFrame } from "./jsonrpc.js";

export type RecordMode = "once" | "all";

export interface RecordOptions {
  out: string;
  command: string[];
  /** Redact secrets before writing. Default: true. */
  redact?: boolean;
  /** "once" (default): refuse to overwrite an existing cassette. "all": always re-record. */
  mode?: RecordMode;
}

/**
 * `--mode once` protects a cassette you already have. It does not protect a
 * zero-byte leftover from a crashed run: that file holds nothing to replay,
 * and refusing to overwrite it would strand the user with a path they have to
 * delete by hand.
 */
export function ensureWritable(out: string, mode: RecordMode): void {
  if (mode !== "once" || !fs.existsSync(out)) return;
  if (cassetteExists(out)) {
    throw new Error(`record: ${out} already exists — replay it, or pass --mode all to re-record over it`);
  }
  process.stderr.write(
    `mcp-cassette: ${out} exists but holds no cassette header (a recording that never flushed) — re-recording over it\n`
  );
}

export function runRecord(opts: RecordOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = opts.command;
    if (!cmd) {
      reject(new Error("record: missing server command after --"));
      return;
    }
    try {
      ensureWritable(opts.out, opts.mode ?? "once");
    } catch (err) {
      reject(err as Error);
      return;
    }

    const redact = opts.redact !== false;
    const writer = new CassetteWriter(
      opts.out,
      redact ? redactCommand(opts.command) : opts.command,
      { applied: redact }
    );
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"] });

    const c2sBuf = new LineBuffer();
    const s2cBuf = new LineBuffer();

    const capture = (dir: "c2s" | "s2c", lines: string[]) => {
      for (const line of lines) {
        if (line.trim() === "") continue;
        const frame = parseFrame(line);
        if (frame) writer.frame(dir, redact ? (redactFrame(frame) as JsonRpcFrame) : frame);
        else writer.raw(dir, redact ? redactRawLine(line) : line);
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
      // disk immediately, so discarding the buffer is not enough — the file that
      // this run created, and already truncated, goes with it.
      void writer.discard().then(() => {
        fs.rmSync(opts.out, { force: true });
        reject(new Error(`record: failed to start server command: ${err.message}`));
      });
    });

    const finish = (code: number) => {
      capture("c2s", [c2sBuf.flush()]);
      capture("s2c", [s2cBuf.flush()]);
      void writer.close().then(() => resolve(code));
    };

    child.on("close", (code) => finish(code ?? 0));

    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.on(sig, () => {
        child.kill(sig);
      });
    }
  });
}
