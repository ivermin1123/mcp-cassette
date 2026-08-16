/**
 * `replay --listen --on-miss passthrough`, and the cassette lint beside it.
 *
 * Passthrough is the one path where replay writes. Everything asserted here is
 * about that write being trustworthy: it appends rather than rewrites, it keeps
 * the file's redaction promise, it re-keys live pairs so a re-read still pairs
 * them, and a streamed live answer lands as a `chunks` entry rather than being
 * flattened into the single frame it never was (§1.3, §3.1).
 *
 * The property that closes the loop is idempotence, which v1 already promised:
 * replaying the appended cassette answers everything it just learned, offline.
 */

import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { AddressInfo } from "node:net";
import { readCassette, type CassetteEntry, type ChunksEntry, type FrameEntry } from "../src/cassette.js";
import { startHttpReplay } from "../src/http-replay.js";
import { lintCassette } from "../src/lint.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cassette-pass-"));
const servers: http.Server[] = [];
afterAll(async () => {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

type Answer = (body: Record<string, unknown>, res: http.ServerResponse) => void;

/** A live MCP server the passthrough can reach: a URL after `--`. */
async function liveServer(answer: Answer): Promise<string> {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += String(c)));
    req.on("end", () => answer(raw ? (JSON.parse(raw) as Record<string, unknown>) : {}, res));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

const json = (res: http.ServerResponse, body: unknown) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

function cassette(name: string, header: Record<string, unknown>, entries: CassetteEntry[]): string {
  const file = path.join(tmpDir, `${name}.cassette.jsonl`);
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

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const quiet = async <T>(run: () => Promise<T>): Promise<T> => {
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return await run();
  } finally {
    process.stderr.write = write;
  }
};

/** A legacy cassette that knows `initialize` and nothing else — everything else misses. */
const RECORDED: CassetteEntry[] = [
  { type: "frame", t: 0, dir: "c2s", frame: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} } },
  { type: "frame", t: 1, dir: "s2c", frame: { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } } },
] as CassetteEntry[];

const ask = (id: number, method: string, params: unknown = {}) => ({ jsonrpc: "2.0", id, method, params });

describe("forwarding a miss to the live server", () => {
  it("answers from the live server and appends the pair, without touching what was already there", async () => {
    const url = await liveServer((body, res) => json(res, { jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "live" }] } }));
    const file = cassette("forward", { era: "legacy" }, RECORDED);
    const before = fs.readFileSync(file, "utf8");

    const server = await startHttpReplay(file, { listen: "127.0.0.1:0", onMiss: "passthrough", serverCommand: [url] });
    const answered = await quiet(() => post(server.url, ask(9, "tools/list")));
    const body = await answered.json();
    await server.close();

    expect(body).toEqual({ jsonrpc: "2.0", id: 9, result: { tools: [{ name: "live" }] } });
    expect(server.appended()).toBe(1);
    expect(server.forwardFailures()).toBe(0);

    // An append, not a rewrite: the original bytes are still the file's prefix.
    const after = fs.readFileSync(file, "utf8");
    expect(after.startsWith(before)).toBe(true);

    const added = readCassette(file).entries.slice(RECORDED.length) as FrameEntry[];
    expect(added.map((e) => e.dir)).toEqual(["c2s", "s2c"]);
    expect(added.every((e) => e.origin === "live")).toBe(true);
    // Re-keyed to their own id, so the pair still pairs on re-read and cannot
    // collide with the recording's ids or a future client's.
    expect(added.map((e) => (e.frame as { id: unknown }).id)).toEqual(["live-1", "live-1"]);
  });

  it("writes a streamed live answer as chunks, not as the single frame it never was", async () => {
    const progress = { jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } };
    const url = await liveServer((body, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify(progress)}\n\n`);
      res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { streamed: true } })}\n\n`);
    });
    const file = cassette("streamed", { era: "legacy" }, RECORDED);

    const server = await startHttpReplay(file, { listen: "127.0.0.1:0", onMiss: "passthrough", serverCommand: [url] });
    const answered = await quiet(() => post(server.url, ask(4, "tools/list")));
    // The client sees the live answer in the shape the live server gave it.
    expect(answered.headers.get("content-type")).toBe("text/event-stream");
    expect(await answered.text()).toContain('"streamed":true');
    await server.close();

    const appended = readCassette(file).entries.slice(RECORDED.length);
    expect(appended.map((e) => e.type)).toEqual(["frame", "chunks"]);
    const chunks = appended[1] as ChunksEntry;
    expect(chunks.origin).toBe("live");
    expect(chunks.id).toBe("live-1");
    expect(chunks.chunks.map((c) => c.frame)).toEqual([progress, { jsonrpc: "2.0", id: "live-1", result: { streamed: true } }]);
  });

  it("keeps a redacted cassette redacted when it appends", async () => {
    const secret = "ghp_NOTAREALTOKENUSEDINTESTSONLY000000";
    const url = await liveServer((body, res) => json(res, { jsonrpc: "2.0", id: body.id, result: { token: secret } }));
    const file = cassette("redacted", { era: "legacy", redaction: { applied: true } }, RECORDED);

    const server = await startHttpReplay(file, { listen: "127.0.0.1:0", onMiss: "passthrough", serverCommand: [url] });
    const answered = await quiet(() => post(server.url, ask(3, "tools/call", { name: "leak", arguments: {} })));
    expect(JSON.stringify(await answered.json())).toContain(secret); // the client still gets the real one
    await server.close();

    const raw = fs.readFileSync(file, "utf8");
    expect(raw).not.toContain(secret);
    expect(raw).toContain("REDACTED");
  });

  it("replays clean on a re-run, which is the whole point of appending", async () => {
    const url = await liveServer((body, res) => json(res, { jsonrpc: "2.0", id: body.id, result: { tools: [] } }));
    const file = cassette("idempotent", { era: "legacy" }, RECORDED);

    const first = await startHttpReplay(file, { listen: "127.0.0.1:0", onMiss: "passthrough", serverCommand: [url] });
    await quiet(() => post(first.url, ask(1, "tools/list")));
    await first.close();

    // Same request again, offline this time: no live server involved, no miss.
    const second = await startHttpReplay(file, { listen: "127.0.0.1:0", onMiss: "error" });
    const replayed = await quiet(() => post(second.url, ask(50, "tools/list")));
    await second.close();

    expect(await replayed.json()).toEqual({ jsonrpc: "2.0", id: 50, result: { tools: [] } });
    expect(second.misses()).toBe(0);
  });

  it("reports a forward that never reached the server, and appends nothing for it", async () => {
    const file = cassette("unreachable", { era: "legacy" }, RECORDED);
    const before = fs.readFileSync(file, "utf8");
    const server = await startHttpReplay(file, {
      listen: "127.0.0.1:0",
      onMiss: "passthrough",
      serverCommand: ["http://127.0.0.1:1/mcp"], // nothing listens there
    });
    const answered = await quiet(() => post(server.url, ask(2, "tools/list")));
    const body = (await answered.json()) as { error: { message: string } };
    await server.close();

    expect(body.error.message).toContain("passthrough to live server failed");
    expect(server.forwardFailures()).toBe(1);
    expect(server.appended()).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("refuses passthrough with no server to pass through to", async () => {
    const file = cassette("nocommand", { era: "legacy" }, RECORDED);
    await expect(startHttpReplay(file, { listen: "127.0.0.1:0", onMiss: "passthrough" })).rejects.toThrow(
      "needs the real server command"
    );
  });
});

describe("cassette lint: does the header agree with the frames?", () => {
  it("flags a modern cassette that records a handshake", () => {
    const file = cassette("modern-init", { era: "modern" }, RECORDED);
    const findings = lintCassette(readCassette(file));
    expect(findings.map((f) => f.rule)).toEqual(["era-handshake"]);
    expect(findings[0]!.message).toContain("the modern era has no handshake");
  });

  it("flags sessions and GET streams the modern era removed", () => {
    const file = cassette("modern-session", { era: "modern", sessioned: true }, [
      { type: "chunks", t: 1, dir: "s2c", via: "get", chunks: [] },
    ] as CassetteEntry[]);
    expect(lintCassette(readCassette(file)).map((f) => f.rule)).toEqual(["era-sessioned", "era-get-stream"]);
  });

  it("flags a transport that contradicts its own entries", () => {
    const stdio = cassette("stdio-stream", { transport: "stdio", url: "https://example.com/mcp" }, [
      { type: "chunks", t: 1, dir: "s2c", id: 1, chunks: [] },
    ] as CassetteEntry[]);
    const http = cassette("http-command", { era: "legacy", command: ["node", "server.js"] }, RECORDED);

    expect(lintCassette(readCassette(stdio)).map((f) => f.rule)).toEqual(["transport-url", "transport-chunks"]);
    expect(lintCassette(readCassette(http)).map((f) => f.rule)).toEqual(["transport-command"]);
  });

  it("says nothing about a cassette that agrees with itself", () => {
    const legacy = cassette("consistent-legacy", { era: "legacy", sessioned: true }, RECORDED);
    // A failed `server/discover` probe before falling back is honest legacy
    // traffic (§4.1), so it must not be flagged.
    const probed = cassette("consistent-probe", { era: "legacy" }, [
      { type: "frame", t: 0, dir: "c2s", frame: { jsonrpc: "2.0", id: 1, method: "server/discover", params: {} } },
      { type: "frame", t: 1, dir: "s2c", frame: { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "no" } } },
      ...RECORDED,
    ] as CassetteEntry[]);

    expect(lintCassette(readCassette(legacy))).toEqual([]);
    expect(lintCassette(readCassette(probed))).toEqual([]);
  });
});
