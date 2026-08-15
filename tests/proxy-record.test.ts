/**
 * Recording a Streamable HTTP session through the reverse proxy.
 *
 * Two properties carry the design (§1, §2, §4.1): what the client and the
 * upstream exchange must be untouched by the proxy, and what lands in the file
 * must be narrower than what crossed the wire — frames, redacted, and never a
 * header value. The secret checks grep the raw bytes rather than the parsed
 * cassette, because a leak that a parser hides is still a leak.
 */

import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import zlib from "node:zlib";
import { AddressInfo } from "node:net";
import { cassetteExists, readCassette, type FrameEntry } from "../src/cassette.js";
import { startHttpRecord, isLocalOrigin, parseListen } from "../src/proxy.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cassette-proxy-"));
const servers: http.Server[] = [];
afterAll(async () => {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const out = (name: string) => path.join(tmpDir, name);
type Handler = (body: Record<string, unknown>, res: http.ServerResponse, headers: http.IncomingHttpHeaders) => void;

async function upstream(handler: Handler): Promise<{ url: string; seen: http.IncomingHttpHeaders[] }> {
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push(req.headers);
      handler(raw ? (JSON.parse(raw) as Record<string, unknown>) : {}, res, req.headers);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, seen };
}

const post = (url: string, frame: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(frame) });

const reply = (res: http.ServerResponse, body: unknown, status = 200, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

const initFrame = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } };

describe("recording a legacy HTTP session", () => {
  it("relays both directions untouched and records the exchange, session id as a boolean only", async () => {
    const file = out("legacy.cassette.jsonl");
    const up = await upstream((body, res) =>
      reply(res, { jsonrpc: "2.0", id: body.id, result: { serverInfo: { name: "up" } } }, 200, {
        "mcp-session-id": "SESSION-abc-123",
      })
    );
    const proxy = await startHttpRecord({ out: file, url: up.url, listen: "127.0.0.1:0" });

    const live = await post(proxy.url, initFrame, {
      authorization: "Bearer sk-ant-api03-NOTAREALKEYFORTESTS",
      "mcp-session-id": "SESSION-abc-123",
    });
    const body = await live.json();
    await proxy.close();

    // Forwarded verbatim in both directions.
    expect(body).toEqual({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "up" } } });
    expect(live.headers.get("mcp-session-id")).toBe("SESSION-abc-123");
    expect(up.seen[0]!.authorization).toBe("Bearer sk-ant-api03-NOTAREALKEYFORTESTS");
    expect(up.seen[0]!["mcp-session-id"]).toBe("SESSION-abc-123");

    const { header, entries } = readCassette(file);
    expect(header.transport).toBe("http");
    expect(header.url).toBe(up.url);
    expect(header.era).toBe("legacy"); // decided by the successful initialize
    expect(header.sessioned).toBe(true);
    expect(entries.map((e) => e.dir)).toEqual(["c2s", "s2c"]);

    // The allowlist, checked against the raw bytes: no header value at all.
    const raw = fs.readFileSync(file, "utf8");
    expect(raw).not.toContain("SESSION-abc-123");
    expect(raw).not.toContain("NOTAREALKEYFORTESTS");
    expect(raw).not.toContain("authorization");
  });

  it("forwards a notification's 202 and writes no status for it", async () => {
    const file = out("notify.cassette.jsonl");
    const up = await upstream((body, res) =>
      body.id === undefined ? res.writeHead(202).end() : reply(res, { jsonrpc: "2.0", id: body.id, result: {} })
    );
    const proxy = await startHttpRecord({ out: file, url: up.url, listen: "127.0.0.1:0" });

    await post(proxy.url, initFrame);
    const note = await post(proxy.url, { jsonrpc: "2.0", method: "notifications/initialized" });
    await proxy.close();

    expect(note.status).toBe(202);
    expect(await note.text()).toBe("");
    const { entries } = readCassette(file);
    expect(entries.map((e) => e.type)).toEqual(["frame", "frame", "frame"]); // init pair + the notification
    expect(entries.every((e) => !("http" in e))).toBe(true); // 200 and 202 are derivable
  });

  it("records a status the client could not derive, so replay can reproduce it", async () => {
    const file = out("status.cassette.jsonl");
    const up = await upstream((body, res) =>
      body.method === "initialize"
        ? reply(res, { jsonrpc: "2.0", id: body.id, result: {} })
        : reply(res, { jsonrpc: "2.0", id: body.id, error: { code: -32022, message: "Unsupported" } }, 400)
    );
    const proxy = await startHttpRecord({ out: file, url: up.url, listen: "127.0.0.1:0" });

    await post(proxy.url, initFrame);
    const bad = await post(proxy.url, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    await proxy.close();

    expect(bad.status).toBe(400);
    const entries = readCassette(file).entries as FrameEntry[];
    expect(entries[1]).not.toHaveProperty("http");
    expect(entries[3]).toMatchObject({ http: { status: 400 } });
  });

  it("redacts request bodies on the way in while the upstream still sees the secret", async () => {
    const file = out("redact.cassette.jsonl");
    const up = await upstream((body, res) => reply(res, { jsonrpc: "2.0", id: body.id, result: {} }));
    const proxy = await startHttpRecord({ out: file, url: up.url, listen: "127.0.0.1:0" });

    await post(proxy.url, initFrame);
    await post(proxy.url, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "deploy", arguments: { token: "ghp_NOTAREALTOKENUSEDINTESTSONLY000000" } },
    });
    await proxy.close();

    const raw = fs.readFileSync(file, "utf8");
    expect(raw).not.toContain("ghp_NOTAREALTOKENUSEDINTESTSONLY000000");
    expect(raw).toContain("REDACTED");
    expect(readCassette(file).header.redaction?.applied).toBe(true);
  });
});

describe("relaying what the proxy does not record", () => {
  it("does not claim an encoding the body no longer has", async () => {
    const file = out("gzip.cassette.jsonl");
    const payload = { jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "compressed" } } };
    const up = await upstream((_body, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end(zlib.gzipSync(JSON.stringify(payload)));
    });
    const proxy = await startHttpRecord({ out: file, url: up.url, listen: "127.0.0.1:0" });

    const live = await post(proxy.url, initFrame);
    const body = await live.json();
    await proxy.close();

    // fetch decoded it upstream; forwarding the header would claim gzip over plaintext.
    expect(live.headers.get("content-encoding")).toBeNull();
    expect(body).toEqual(payload);
    const entries = readCassette(file).entries as FrameEntry[];
    expect(entries[1]!.frame).toEqual(payload); // recorded decompressed, like any other frame
  });

  it("warns once per session that a streamed answer was relayed but not captured", async () => {
    const file = out("sse.cassette.jsonl");
    const up = await upstream((body, res) => {
      if (body.method === "initialize") return reply(res, { jsonrpc: "2.0", id: body.id, result: {} });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} })}\n\n`);
    });

    const stderr: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => (stderr.push(String(chunk)), true)) as typeof process.stderr.write;
    let proxy;
    try {
      proxy = await startHttpRecord({ out: file, url: up.url, listen: "127.0.0.1:0" });
      await post(proxy.url, initFrame);
      const first = await post(proxy.url, { jsonrpc: "2.0", id: 2, method: "tools/list" });
      const second = await post(proxy.url, { jsonrpc: "2.0", id: 3, method: "tools/list" });
      expect(await first.text()).toContain("data:"); // relayed verbatim
      expect(await second.text()).toContain("data:");
    } finally {
      process.stderr.write = write;
    }
    await proxy!.close();

    const warnings = stderr.join("").split("\n").filter((l) => l.includes("streamed answer relayed"));
    expect(warnings).toHaveLength(1); // two streams, one warning
  });
});

describe("passive era detection", () => {
  it("classifies probe-then-fallback traffic as legacy, keeping the failed probe in the transcript", async () => {
    const file = out("probe.cassette.jsonl");
    const up = await upstream((body, res) =>
      body.method === "server/discover"
        ? reply(res, { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } }, 404)
        : reply(res, { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } })
    );
    const proxy = await startHttpRecord({ out: file, url: up.url, listen: "127.0.0.1:0" });

    await post(proxy.url, { jsonrpc: "2.0", id: 1, method: "server/discover", params: {} });
    await post(proxy.url, { ...initFrame, id: 2 });
    await proxy.close();

    const { header, entries } = readCassette(file);
    expect(header.era).toBe("legacy"); // the failed probe does not decide
    expect(entries).toHaveLength(4); // but it is recorded, honestly
    expect(header.sessioned).toBeUndefined();
  });

  it("classifies a session that never handshook as modern", async () => {
    const file = out("modern.cassette.jsonl");
    const up = await upstream((body, res) =>
      reply(res, { jsonrpc: "2.0", id: body.id, result: { resultType: "complete", supportedVersions: ["2026-07-28"] } })
    );
    const proxy = await startHttpRecord({ out: file, url: up.url, listen: "127.0.0.1:0" });
    await post(proxy.url, { jsonrpc: "2.0", id: 1, method: "server/discover", params: {} });
    await proxy.close();

    expect(readCassette(file).header.era).toBe("modern");
  });

  it("leaves era off a session with no successful exchange, and still writes a readable file", async () => {
    const file = out("undecided.cassette.jsonl");
    const up = await upstream((body, res) =>
      reply(res, { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "nope" } }, 500)
    );
    const proxy = await startHttpRecord({ out: file, url: up.url, listen: "127.0.0.1:0" });
    await post(proxy.url, initFrame);
    await proxy.close();

    const { header, entries } = readCassette(file);
    expect(header).not.toHaveProperty("era");
    expect(entries).toHaveLength(2);
  });
});

describe("binding and origin", () => {
  it("fails loudly when the port is taken instead of silently moving", async () => {
    const squatter = http.createServer(() => {});
    await new Promise<void>((r) => squatter.listen(0, "127.0.0.1", r));
    servers.push(squatter);
    const taken = (squatter.address() as AddressInfo).port;

    await expect(
      startHttpRecord({ out: out("taken.cassette.jsonl"), url: "http://127.0.0.1:1/mcp", listen: `127.0.0.1:${taken}` })
    ).rejects.toThrow(new RegExp(`127\\.0\\.0\\.1:${taken} is already in use by .+`));
  });

  it("leaves nothing behind when the bind fails, so the next run is not blocked by it", async () => {
    const file = out("failed-start.cassette.jsonl");
    const squatter = http.createServer(() => {});
    await new Promise<void>((r) => squatter.listen(0, "127.0.0.1", r));
    servers.push(squatter);
    const taken = (squatter.address() as AddressInfo).port;
    const up = await upstream((body, res) => reply(res, { jsonrpc: "2.0", id: body.id, result: {} }));

    await expect(
      startHttpRecord({ out: file, url: up.url, listen: `127.0.0.1:${taken}`, mode: "once" })
    ).rejects.toThrow("already in use");

    // The rejection waits for the file to settle, so this reads the final state.
    expect(cassetteExists(file)).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("");

    // And the retry on the same path is not blocked by the corpse of the first.
    const proxy = await startHttpRecord({ out: file, url: up.url, listen: "127.0.0.1:0", mode: "once" });
    await post(proxy.url, initFrame);
    await proxy.close();
    expect(readCassette(file).entries).toHaveLength(2);
  });

  it("answers 403 to a non-local Origin, the DNS-rebinding case", async () => {
    const file = out("origin.cassette.jsonl");
    const up = await upstream((body, res) => reply(res, { jsonrpc: "2.0", id: body.id, result: {} }));
    const proxy = await startHttpRecord({ out: file, url: up.url, listen: "127.0.0.1:0" });

    const blocked = await post(proxy.url, initFrame, { origin: "https://evil.example.com" });
    const allowed = await post(proxy.url, initFrame, { origin: "http://localhost:3000" });
    await proxy.close();

    expect(blocked.status).toBe(403);
    expect(allowed.status).toBe(200);
    expect(up.seen).toHaveLength(1); // the blocked request never reached the upstream
  });

  it("knows a local origin from a remote one, and a host:port from a typo", () => {
    expect(isLocalOrigin("http://127.0.0.1:6402")).toBe(true);
    expect(isLocalOrigin("http://localhost")).toBe(true);
    expect(isLocalOrigin("https://evil.example.com")).toBe(false);
    expect(isLocalOrigin("not a url")).toBe(false);
    expect(parseListen("0.0.0.0:7000")).toEqual({ host: "0.0.0.0", port: 7000 });
    expect(() => parseListen("127.0.0.1:not-a-port")).toThrow("--listen expects host:port");
  });
});

describe("--mode once and a recording that never flushed", () => {
  it("overwrites a headerless leftover, explains why, and still refuses a real cassette", async () => {
    const file = out("leftover.cassette.jsonl");
    fs.writeFileSync(file, ""); // what a crash before the first flush leaves behind
    const up = await upstream((body, res) => reply(res, { jsonrpc: "2.0", id: body.id, result: {} }));

    const stderr: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => (stderr.push(String(chunk)), true)) as typeof process.stderr.write;
    try {
      const proxy = await startHttpRecord({ out: file, url: up.url, listen: "127.0.0.1:0", mode: "once" });
      await post(proxy.url, initFrame);
      await proxy.close();
    } finally {
      process.stderr.write = write;
    }
    expect(stderr.join("")).toContain("holds no cassette header");
    expect(readCassette(file).entries).toHaveLength(2);

    // Now that a real cassette is there, `once` protects it again.
    await expect(
      startHttpRecord({ out: file, url: up.url, listen: "127.0.0.1:0", mode: "once" })
    ).rejects.toThrow("already exists");
  });
});
