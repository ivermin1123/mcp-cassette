/**
 * Replaying a recorded stream as SSE.
 *
 * Two kinds of stream, and the difference is the whole design (§3.2): an answer
 * to a request ends when its final frame lands, while the legacy standalone
 * stream answered nothing and so completes nothing, so it is held open. Both are
 * asserted here through a raw reader rather than a buffered body, because
 * "the client consumed progress and *then* the result" is a claim about
 * arrival order that a buffered read cannot make.
 *
 * The risk the design names is not a wrong answer, it is a socket nobody
 * closes, so every test that opens a stream also proves the session can end.
 */

import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { startHttpReplay } from "../src/http-replay.js";
import { MiniClient } from "../src/client.js";
import type { CassetteEntry } from "../src/cassette.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cassette-ssereplay-"));
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

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

const post = (url: string, body: unknown, init: RequestInit = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...init });

/** Read one SSE event at a time, so arrival order is observable rather than inferred. */
function reader(res: Response) {
  const stream = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    /** The next `data:` payload, or null once the server closed the stream. */
    async next(): Promise<unknown | null> {
      for (;;) {
        const split = buffer.indexOf("\n\n");
        if (split !== -1) {
          const event = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          return JSON.parse(event.replace(/^data: /, ""));
        }
        const { done, value } = await stream.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
      }
    },
    cancel: () => stream.cancel().catch(() => undefined),
  };
}

const progress = (n: number) => ({
  jsonrpc: "2.0",
  method: "notifications/progress",
  params: { progressToken: "recorded-token", progress: n },
});
const result = { jsonrpc: "2.0", id: 4, result: { content: [{ type: "text", text: "done" }] } };

/** A call answered by a three-frame stream: two progress notifications, then the response. */
const STREAMED: CassetteEntry[] = [
  { type: "frame", t: 0, dir: "c2s", frame: { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "build", arguments: {} } } },
  {
    type: "chunks",
    t: 10,
    dir: "s2c",
    id: 4,
    chunks: [
      { t: 10, frame: progress(1) },
      { t: 40, frame: progress(2) },
      { t: 90, frame: result },
    ],
  },
] as CassetteEntry[];

const call = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "build", arguments: {} } });

describe("a streamed answer to a POST", () => {
  it("delivers progress first, then the result, then closes the stream", async () => {
    const file = cassette("streamed", { era: "legacy" }, STREAMED);
    const server = await startHttpReplay(file, { listen: "127.0.0.1:0" });
    const res = await post(server.url, call(31));

    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const read = reader(res);
    expect(await read.next()).toEqual(progress(1));
    expect(await read.next()).toEqual(progress(2));
    // Only the final response frame is re-keyed; the notifications came through
    // exactly as recorded, recorded progressToken and all.
    expect(await read.next()).toEqual({ ...result, id: 31 });
    expect(await read.next()).toBeNull(); // "response SHOULD terminate the stream"

    await server.close();
    expect(server.misses()).toBe(0);
  });

  it("consumes the recorded stream exactly once, then diagnoses the extra call", async () => {
    const file = cassette("exhaust", { era: "legacy" }, STREAMED);
    const server = await startHttpReplay(file, { listen: "127.0.0.1:0" });
    const first = await post(server.url, call(1));
    await first.text();

    const lines: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: string) => (lines.push(String(c)), true)) as typeof process.stderr.write;
    let second: Response;
    try {
      second = await post(server.url, call(2));
    } finally {
      process.stderr.write = write;
    }
    const body = JSON.parse(await second.text());
    await server.close();

    expect(second.headers.get("content-type")).toBe("application/json"); // no stream left to give
    expect(body.error.message).toContain("recorded as a stream 1 time(s)");
    expect(body.error.message).toContain("already replayed earlier in this session");
    expect(server.misses()).toBe(1);
    expect(lines.join("")).toContain("fingerprint miss");
  });

  it("stops writing when the client walks away, and keeps the answer consumed", async () => {
    const file = cassette("disconnect", { era: "legacy" }, STREAMED);
    const server = await startHttpReplay(file, { listen: "127.0.0.1:0", timing: "recorded" });
    const abort = new AbortController();
    const res = await post(server.url, call(5), { signal: abort.signal });
    const read = reader(res);
    expect(await read.next()).toEqual(progress(1));
    abort.abort(); // gone, mid-stream

    // §3.3 rejected un-consuming on cancel as racy: the answer stays spent.
    const again = await post(server.url, call(6));
    const body = JSON.parse(await again.text());
    expect(body.error.message).toContain("already replayed earlier in this session");

    // And the session still closes: a half-emitted stream is not a hostage.
    await expect(server.close()).resolves.toBeUndefined();
  });

  it("reaches a real client, which sees the streamed answer as its answer", async () => {
    const file = cassette("miniclient", { era: "modern" }, [
      { type: "frame", t: 0, dir: "c2s", frame: { jsonrpc: "2.0", id: 1, method: "server/discover", params: {} } },
      { type: "frame", t: 1, dir: "s2c", frame: { jsonrpc: "2.0", id: 1, result: { supportedVersions: ["2026-07-28"] } } },
      ...STREAMED,
    ] as CassetteEntry[]);
    const server = await startHttpReplay(file, { listen: "127.0.0.1:0" });
    const { client } = await MiniClient.connect({ kind: "http", url: server.url }, 5000, "modern").catch(
      async (err: Error) => {
        await server.close();
        throw err;
      }
    );
    const answered = await client.request("tools/call", { name: "build", arguments: {} });
    await client.close();
    await server.close();

    expect(answered.result).toEqual({ content: [{ type: "text", text: "done" }] });
  });
});

describe("--timing", () => {
  const elapsed = async (mode: "none" | "recorded"): Promise<number> => {
    const file = cassette(`timing-${mode}`, { era: "legacy" }, STREAMED);
    const server = await startHttpReplay(file, { listen: "127.0.0.1:0", timing: mode });
    const started = Date.now();
    const res = await post(server.url, call(9));
    await res.text(); // drains until the server closes after the final frame
    const took = Date.now() - started;
    await server.close();
    return took;
  };

  // Deliberately loose: the claim is "recorded pacing is honored, none is not",
  // not a stopwatch reading. Recorded offsets span 10→90ms, so ~80ms of spacing.
  it("emits back to back by default", async () => {
    expect(await elapsed("none")).toBeLessThan(60);
  });

  it("honors the recorded offsets when asked", async () => {
    expect(await elapsed("recorded")).toBeGreaterThanOrEqual(70);
  });
});

describe("--timing at the command line", () => {
  const CLI = path.join(path.resolve(__dirname, ".."), "dist/cli.js");

  it("refuses pacing where there is no stream to pace, and refuses a mode it does not have", () => {
    const file = cassette("cli-timing", { era: "legacy" }, STREAMED);
    const noListen = spawnSync("node", [CLI, "replay", file, "--timing", "recorded"], { encoding: "utf8" });
    const unknown = spawnSync("node", [CLI, "replay", file, "--listen", "127.0.0.1:0", "--timing", "swiftly"], {
      encoding: "utf8",
    });

    expect(noListen.status).toBe(1);
    expect(noListen.stderr).toContain("--timing applies to streamed answers, which only --listen serves");
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('unknown --timing "swiftly"');
  });
});

describe("the legacy standalone GET stream", () => {
  const PUSHED = { jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "pushed" } };
  const WITH_GET: CassetteEntry[] = [
    { type: "frame", t: 0, dir: "c2s", frame: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} } },
    { type: "frame", t: 1, dir: "s2c", frame: { jsonrpc: "2.0", id: 1, result: {} } },
    { type: "chunks", t: 2, dir: "s2c", via: "get", chunks: [{ t: 2, frame: PUSHED }] },
  ] as CassetteEntry[];

  it("serves it, delivers what the server pushed, and holds it open", async () => {
    const file = cassette("getstream", { era: "legacy" }, WITH_GET);
    const server = await startHttpReplay(file, { listen: "127.0.0.1:0" });
    const res = await fetch(server.url, { method: "GET", headers: { accept: "text/event-stream" } });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const read = reader(res);
    expect(await read.next()).toEqual(PUSHED);

    // Still open: nothing followed the last recorded frame, and no close came
    // either: the standalone stream answers no request, so it completes none.
    const raced = await Promise.race([read.next(), new Promise((r) => setTimeout(() => r("still open"), 150))]);
    expect(raced).toBe("still open");

    // The session closes it anyway: this is the dangling socket the design warns about.
    await expect(server.close()).resolves.toBeUndefined();
    expect(await read.next()).toBeNull();
  });

  it("joins Allow when it exists, and a modern cassette still refuses GET", async () => {
    const legacy = cassette("get-allow", { era: "legacy", sessioned: true }, WITH_GET);
    const modern = cassette("get-modern", { era: "modern" }, WITH_GET);
    const open = await startHttpReplay(legacy, { listen: "127.0.0.1:0" });
    const refused = await startHttpReplay(modern, { listen: "127.0.0.1:0" });

    const allowed = await fetch(open.url, { method: "PUT" });
    const blocked = await fetch(refused.url, { method: "GET" });
    await Promise.all([open.close(), refused.close()]);

    expect(allowed.headers.get("allow")).toBe("GET, POST, DELETE");
    expect(blocked.status).toBe(405); // the modern era removed GET outright
    expect(blocked.headers.get("allow")).toBe("POST");
  });

  it("does not hold the session open when nobody ever opened the stream", async () => {
    const file = cassette("get-unopened", { era: "legacy" }, WITH_GET);
    const server = await startHttpReplay(file, { listen: "127.0.0.1:0" });
    await expect(server.close()).resolves.toBeUndefined();
  });
});
