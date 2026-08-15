/**
 * `mcp-cassette record -o out.cassette.jsonl -- <server command...>`
 *
 * Transparent stdio proxy: the MCP client talks to this process as if it were
 * the server; every byte is forwarded verbatim in both directions while every
 * JSON-RPC frame is captured into the cassette. Works with any server,
 * any SDK, any spec revision — recording happens at the transport level.
 */

import { spawn } from "node:child_process";
import { CassetteWriter } from "./cassette.js";
import { LineBuffer, parseFrame } from "./jsonrpc.js";

export interface RecordOptions {
  out: string;
  command: string[];
}

export function runRecord(opts: RecordOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = opts.command;
    if (!cmd) {
      reject(new Error("record: missing server command after --"));
      return;
    }

    const writer = new CassetteWriter(opts.out, opts.command);
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"] });

    const c2sBuf = new LineBuffer();
    const s2cBuf = new LineBuffer();

    const capture = (dir: "c2s" | "s2c", lines: string[]) => {
      for (const line of lines) {
        if (line.trim() === "") continue;
        const frame = parseFrame(line);
        if (frame) writer.frame(dir, frame);
        else writer.raw(dir, line);
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
      void writer.close();
      reject(new Error(`record: failed to start server command: ${err.message}`));
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
