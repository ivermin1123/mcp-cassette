/**
 * The debts v0.3 wrote down while shipping, paid at the end of the chain.
 *
 * Each of these was found during a review whose PR had no room for it, so each
 * is small, unrelated to the others, and only worth writing down because the
 * failure it prevents is silent: a cassette that survives a server that never
 * started, a warning aimed at the wrong version, a stream nobody mentioned.
 */

import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cassetteExists, type CassetteEntry } from "../src/cassette.js";
import { ensureWritable, runRecord } from "../src/record.js";
import { startHttpReplay } from "../src/http-replay.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cassette-sweep-"));
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const out = (name: string) => path.join(tmpDir, name);

function cassette(name: string, header: Record<string, unknown>, entries: CassetteEntry[]): string {
  const file = out(`${name}.cassette.jsonl`);
  const head = {
    type: "header",
    cassetteVersion: 2,
    recorder: "mcp-cassette@test",
    startedAt: "2026-08-16T00:00:00Z",
    transport: "http",
    ...header,
  };
  fs.writeFileSync(file, [head, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n");
  return file;
}

async function stderrOf(run: () => Promise<{ close(): Promise<void> }>): Promise<string> {
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((c: string) => (lines.push(String(c)), true)) as typeof process.stderr.write;
  try {
    const server = await run();
    await server.close();
  } finally {
    process.stderr.write = write;
  }
  return lines.join("");
}

describe("a stdio recording whose server never started", () => {
  it("leaves nothing behind, so the next run on the same path is not blocked by it", async () => {
    const file = out("never-started.cassette.jsonl");
    await expect(
      runRecord({ out: file, command: ["definitely-not-a-real-binary-xyz"], mode: "once" })
    ).rejects.toThrow("failed to start server command");

    // The writer put a header on disk the moment it opened. A cassette that
    // records nothing is not a cassette, and `--mode once` must not defend it.
    expect(fs.existsSync(file)).toBe(false);
    expect(cassetteExists(file)).toBe(false);

    // And the retry on that same path is free to proceed: `--mode once` has
    // nothing left to defend.
    expect(() => ensureWritable(file, "once")).not.toThrow();
  });
});

describe("which frames may state the protocol version", () => {
  const spoke = (entries: CassetteEntry[], header: Record<string, unknown> = { era: "legacy" }) =>
    stderrOf(async () => {
      const server = await startHttpReplay(cassette(`version-${Math.abs(hash(JSON.stringify(entries)))}`, header, entries), {
        listen: "127.0.0.1:0",
      });
      await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json", "mcp-protocol-version": "1999-01-01" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }),
      });
      return server;
    });

  // A stable name per fixture without leaning on the clock.
  const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);

  const initialize: CassetteEntry[] = [
    { type: "frame", t: 0, dir: "c2s", frame: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} } },
    { type: "frame", t: 1, dir: "s2c", frame: { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } } },
    { type: "frame", t: 2, dir: "c2s", frame: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} } },
    { type: "frame", t: 3, dir: "s2c", frame: { jsonrpc: "2.0", id: 2, result: { tools: [] } } },
  ] as CassetteEntry[];

  it("takes it from the initialize result", async () => {
    expect(await spoke(initialize)).toContain('is not the recorded "2025-06-18"');
  });

  it("ignores a tool result that merely has a field by that name", async () => {
    const decoy: CassetteEntry[] = [
      { type: "frame", t: 0, dir: "c2s", frame: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "probe", arguments: {} } } },
      { type: "frame", t: 1, dir: "s2c", frame: { jsonrpc: "2.0", id: 1, result: { protocolVersion: "not-the-protocol" } } },
      { type: "frame", t: 2, dir: "c2s", frame: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} } },
      { type: "frame", t: 3, dir: "s2c", frame: { jsonrpc: "2.0", id: 2, result: { tools: [] } } },
    ] as CassetteEntry[];
    const stderr = await spoke(decoy);
    // The server's own data never becomes the protocol's, so there is nothing
    // to compare against and no warning to give.
    expect(stderr).not.toContain("not-the-protocol");
    expect(stderr).not.toContain("MCP-Protocol-Version");
  });

  it("takes it from a modern request's _meta", async () => {
    const modern: CassetteEntry[] = [
      {
        type: "frame",
        t: 0,
        dir: "c2s",
        frame: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
        },
      },
      { type: "frame", t: 1, dir: "s2c", frame: { jsonrpc: "2.0", id: 1, result: { tools: [] } } },
    ] as CassetteEntry[];
    expect(await spoke(modern, { era: "modern" })).toContain('is not the recorded "2026-07-28"');
  });
});

describe("more standalone streams than there are endpoints to serve them", () => {
  const stream = (n: number): CassetteEntry =>
    ({
      type: "chunks",
      t: n,
      dir: "s2c",
      via: "get",
      chunks: [{ t: n, frame: { jsonrpc: "2.0", method: "notifications/message", params: { data: `stream-${n}` } } }],
    }) as CassetteEntry;

  it("serves the first and says so, rather than picking one in silence", async () => {
    const file = cassette("two-standalone", { era: "legacy" }, [stream(1), stream(2)]);
    const server = await startHttpReplay(file, { listen: "127.0.0.1:0" });
    const opened = await fetch(server.url, { method: "GET" });
    // The standalone stream is held open by design, so the read only finishes
    // once the session ends it.
    const reading = opened.text();
    await server.close();
    const body = await reading;
    expect(body).toContain("stream-1");
    expect(body).not.toContain("stream-2");

    const stderr = await stderrOf(() => startHttpReplay(file, { listen: "127.0.0.1:0" }));
    expect(stderr).toContain("2 standalone GET stream(s) recorded; only the first is served");
  });

  it("stays quiet when there is only one", async () => {
    const file = cassette("one-standalone", { era: "legacy" }, [stream(1)]);
    expect(await stderrOf(() => startHttpReplay(file, { listen: "127.0.0.1:0" }))).not.toContain("only the first is served");
  });
});
