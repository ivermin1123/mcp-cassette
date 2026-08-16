/**
 * Capturing a streamed answer: the parser, then the proxy around it.
 *
 * The parser half is measured against WHATWG HTML's own worked examples for
 * "interpreting an event stream". If the spec says a stream fires two events
 * with these exact data strings, so must we, plus the property the spec's
 * prose implies but never illustrates: where the reads fall must not matter.
 *
 * The proxy half asserts the two things §1.3 and §2.5 promise. What reaches
 * the client is the upstream's own bytes; what reaches the file is frames,
 * redacted, and nothing that only existed to make a stream resumable.
 */

import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { AddressInfo } from "node:net";
import { readCassette, type ChunksEntry } from "../src/cassette.js";
import { startHttpRecord } from "../src/proxy.js";
import { SseParser, type SseEvent } from "../src/sse.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cassette-sse-"));
const servers: http.Server[] = [];
afterAll(async () => {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const out = (name: string) => path.join(tmpDir, name);

/** Feed a whole stream in fixed-size pieces, as TCP would hand it over, then end it. */
function feed(text: string, size = text.length): SseEvent[] {
  const parser = new SseParser();
  const events: SseEvent[] = [];
  for (let i = 0; i < text.length; i += size) events.push(...parser.feed(text.slice(i, i + size)));
  return [...events, ...parser.end()];
}

const seen = (text: string) => feed(text).map((e) => e.data);

describe("the SSE parser, against the spec's own examples", () => {
  it("fires the three events of the spec's test stream, ids and leading space included", () => {
    const events = feed(": test stream\n\ndata: first event\nid: 1\n\ndata:second event\nid\n\ndata:  third event\n\n");
    expect(events).toEqual([
      { type: "message", data: "first event", lastEventId: "1" },
      { type: "message", data: "second event", lastEventId: "" }, // a bare `id` resets it
      { type: "message", data: " third event", lastEventId: "" }, // one space is stripped, not both
    ]);
  });

  it("knows an empty data buffer from an empty data line, and drops an unterminated block", () => {
    // The spec's second example: two events, then a block with no blank line after it.
    expect(seen("data\n\ndata\ndata\n\ndata:\n")).toEqual(["", "\n"]);
  });

  it("ignores the one space after the colon, and only the one", () => {
    expect(seen("data:test\n\ndata: test\n\ndata:  test\n\n")).toEqual(["test", "test", " test"]);
  });

  it("accepts every line ending the spec allows", () => {
    const expected = ["one", "two"];
    expect(seen("data: one\n\ndata: two\n\n")).toEqual(expected);
    expect(seen("data: one\r\n\r\ndata: two\r\n\r\n")).toEqual(expected);
    expect(seen("data: one\r\rdata: two\r\r")).toEqual(expected);
  });

  it("names the event type, ignores comments and unknown fields, and takes retry only as digits", () => {
    const parser = new SseParser();
    const events = parser.feed(
      ": keep-alive\nretry: 4000\nevent: progress\ndata: {}\n\nretry: soon\nfield: value\ndata: {}\n\n"
    );
    expect(events.map((e) => e.type)).toEqual(["progress", "message"]);
    expect(events.map((e) => e.data)).toEqual(["{}", "{}"]);
    expect(parser.retry).toBe(4000); // "soon" is not digits, so it did not overwrite it
  });

  it("ignores an id carrying a NUL and keeps the one before it", () => {
    const events = feed("data: a\nid: 7\n\ndata: b\nid: bad\0id\n\n");
    expect(events.map((e) => e.lastEventId)).toEqual(["7", "7"]);
  });

  it("splits the same events no matter where the reads fall", () => {
    const stream = ": hi\r\ndata: one\r\nid: 1\r\n\r\nevent: p\ndata: {\"a\":1}\ndata: tail\n\ndata: three\r\r";
    const whole = feed(stream);
    expect(whole).toHaveLength(3);
    for (let size = 1; size <= stream.length; size++) {
      expect(feed(stream, size), `read size ${size}`).toEqual(whole);
    }
  });
});

// ---------------------------------------------------------------------------

type Upstream = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

/** An upstream that writes raw bytes, so a test picks its own framing and cut points. */
async function upstream(handler: Upstream): Promise<string> {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += String(c)));
    req.on("end", () => handler(req, res, raw));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

const stream = (res: http.ServerResponse, headers: Record<string, string> = {}) =>
  res.writeHead(200, { "content-type": "text/event-stream", "x-accel-buffering": "no", ...headers });

const event = (frame: unknown) => `data: ${JSON.stringify(frame)}\n\n`;

const post = (url: string, frame: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(frame) });

const json = (res: http.ServerResponse, body: unknown) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const call = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "build" } };
const progress = (n: number) => ({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: n } });
const done = { jsonrpc: "2.0", id: 7, result: { content: [] } };

describe("capturing a POST stream", () => {
  it("relays it byte for byte and records one entry: the frames, in order, nothing else", async () => {
    const file = out("post.cassette.jsonl");
    const wire = (
      ": keep-alive\n\n" +
      `retry: 3000\nid: e1\n${event(progress(1))}` +
      `id: e2\n${event(progress(2))}` +
      `id: e3\n${event(done)}`
    ).replace(/\n/g, "\r\n");
    // Between the CR and the LF that end the first progress frame's data line:
    // the nastiest place a read can stop, and one a real one does stop at.
    const cut = wire.indexOf("\r\n", wire.indexOf('"progress":1')) + 1;
    const url = await upstream((_req, res, body) => {
      if (String(body).includes("initialize")) return json(res, { jsonrpc: "2.0", id: 1, result: {} });
      stream(res);
      res.write(wire.slice(0, cut));
      res.write(wire.slice(cut, cut + 30));
      res.end(wire.slice(cut + 30));
    });
    const proxy = await startHttpRecord({ out: file, url, listen: "127.0.0.1:0" });

    await post(proxy.url, { jsonrpc: "2.0", id: 1, method: "initialize" });
    const live = await post(proxy.url, call);
    const text = await live.text();
    await proxy.close();

    expect(live.headers.get("x-accel-buffering")).toBe("no"); // the "do not buffer me" hint survives
    expect(text).toBe(wire); // byte for byte, however the reads fell

    const entries = readCassette(file).entries;
    expect(entries.map((e) => e.type)).toEqual(["frame", "frame", "frame", "chunks"]);
    const chunks = entries[3] as ChunksEntry;
    expect(chunks.dir).toBe("s2c");
    expect(chunks.id).toBe(7); // the request the stream answers
    expect(chunks).not.toHaveProperty("via"); // "post" is the default, so it is left out
    expect(chunks.chunks.map((c) => c.frame)).toEqual([progress(1), progress(2), done]);
    expect(chunks.t).toBeLessThanOrEqual(chunks.chunks[0]!.t);
    expect(chunks.chunks[2]!.t).toBeGreaterThanOrEqual(chunks.chunks[0]!.t);

    // Event ids, retry, and comment lines are parsed and dropped (§1.3).
    const raw = fs.readFileSync(file, "utf8");
    for (const dropped of ["e1", "e2", "e3", "3000", "keep-alive"]) expect(raw).not.toContain(dropped);
  });

  it("keeps a secret that streams past out of the file, checked in raw bytes", async () => {
    const file = out("redact.cassette.jsonl");
    const secret = "ghp_NOTAREALTOKENUSEDINTESTSONLY000000";
    const url = await upstream((_req, res) => {
      stream(res);
      res.write(event({ jsonrpc: "2.0", method: "notifications/progress", params: { message: `using ${secret}` } }));
      res.end(event(done));
    });
    const proxy = await startHttpRecord({ out: file, url, listen: "127.0.0.1:0" });

    const live = await post(proxy.url, call);
    expect(await live.text()).toContain(secret); // the client still sees the real bytes
    await proxy.close();

    const raw = fs.readFileSync(file, "utf8");
    expect(raw).not.toContain(secret);
    expect(raw).toContain("REDACTED");
  });

  it("records the entry even when the stream carried nothing it could parse", async () => {
    const file = out("opaque.cassette.jsonl");
    const url = await upstream((_req, res) => {
      stream(res);
      res.end(": ping\n\ndata: not json at all\n\n");
    });
    const proxy = await startHttpRecord({ out: file, url, listen: "127.0.0.1:0" });
    await post(proxy.url, call);
    await proxy.close();

    // Transcript honesty: a stream happened, so the transcript says one did.
    const entries = readCassette(file).entries;
    expect(entries.map((e) => e.type)).toEqual(["frame", "chunks"]);
    expect((entries[1] as ChunksEntry).chunks).toEqual([]);
  });
});

describe("era decided by an answer that streamed (§4.1)", () => {
  const eraOf = async (name: string, method: string, sessionHeader = false) => {
    const file = out(`${name}.cassette.jsonl`);
    const url = await upstream((_req, res, body) => {
      const id = (JSON.parse(String(body)) as { id: number }).id;
      stream(res, sessionHeader ? { "mcp-session-id": "SESSION-abc-123" } : {});
      res.write(event(progress(1)));
      res.end(event({ jsonrpc: "2.0", id, result: { ok: true } }));
    });
    const proxy = await startHttpRecord({ out: file, url, listen: "127.0.0.1:0" });
    await post(proxy.url, { jsonrpc: "2.0", id: 1, method, params: {} });
    await proxy.close();
    return { file, ...readCassette(file) };
  };

  it("stamps legacy when initialize is answered over SSE, and still sees the session id", async () => {
    const { header, file } = await eraOf("sse-legacy", "initialize", true);
    expect(header.era).toBe("legacy");
    expect(header.sessioned).toBe(true); // the header fact is taken before the stream branch
    expect(fs.readFileSync(file, "utf8")).not.toContain("SESSION-abc-123"); // the value never lands
  });

  it("stamps modern when server/discover is answered over SSE", async () => {
    const { header } = await eraOf("sse-modern", "server/discover");
    expect(header.era).toBe("modern");
  });

  it("leaves era undecided when the streamed answer is an error", async () => {
    const file = out("sse-error.cassette.jsonl");
    const url = await upstream((_req, res) => {
      stream(res);
      res.end(event({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "no" } }));
    });
    const proxy = await startHttpRecord({ out: file, url, listen: "127.0.0.1:0" });
    await post(proxy.url, { jsonrpc: "2.0", id: 1, method: "server/discover" });
    await proxy.close();

    const { header, entries } = readCassette(file);
    expect(header).not.toHaveProperty("era"); // only a *successful* answer decides
    expect((entries[1] as ChunksEntry).chunks).toHaveLength(1); // but the failure is recorded
  });
});

describe("streams the POST path does not own", () => {
  it("captures a legacy standalone GET stream id-less, as via:\"get\"", async () => {
    const file = out("get.cassette.jsonl");
    const push = { jsonrpc: "2.0", id: "s1", method: "sampling/createMessage", params: {} };
    const url = await upstream((req, res) => {
      if (req.method !== "GET") return json(res, { jsonrpc: "2.0", id: 1, result: {} });
      stream(res);
      res.write(event(progress(1)));
      res.end(event(push));
    });
    const proxy = await startHttpRecord({ out: file, url, listen: "127.0.0.1:0" });

    await post(proxy.url, { jsonrpc: "2.0", id: 1, method: "initialize" });
    const opened = await fetch(proxy.url, { method: "GET", headers: { accept: "text/event-stream" } });
    expect(await opened.text()).toBe(event(progress(1)) + event(push));
    await proxy.close();

    const entry = readCassette(file).entries[2] as ChunksEntry;
    expect(entry.type).toBe("chunks");
    expect(entry.via).toBe("get");
    expect(entry).not.toHaveProperty("id"); // it answers no request
    expect(entry.chunks.map((c) => c.frame)).toEqual([progress(1), push]);
  });

  it("relays a DELETE without capturing it — teardown is not this PR's business", async () => {
    const file = out("delete.cassette.jsonl");
    const url = await upstream((req, res) => {
      if (req.method !== "DELETE") return json(res, { jsonrpc: "2.0", id: 1, result: {} });
      stream(res);
      res.end(event(progress(9)));
    });
    const proxy = await startHttpRecord({ out: file, url, listen: "127.0.0.1:0" });

    await post(proxy.url, { jsonrpc: "2.0", id: 1, method: "initialize" });
    const gone = await fetch(proxy.url, { method: "DELETE" });
    expect(await gone.text()).toBe(event(progress(9))); // still relayed
    await proxy.close();

    expect(readCassette(file).entries.map((e) => e.type)).toEqual(["frame", "frame"]);
  });

  it("flushes a stream still open when the session ends, with what it showed (§2.5)", async () => {
    const file = out("open.cassette.jsonl");
    const url = await upstream((_req, res) => {
      stream(res);
      res.write(event(progress(1)));
      res.write(event(progress(2)));
      res.write("data: {\"jsonrpc\":\"2.0\""); // a half-written frame, never terminated
    });
    const proxy = await startHttpRecord({ out: file, url, listen: "127.0.0.1:0" });

    const live = await post(proxy.url, call);
    const reader = live.body!.getReader();
    let text = "";
    while (!text.includes('"progress":2')) text += new TextDecoder().decode((await reader.read()).value);
    await proxy.close(); // the stream is still open, and the operator stops here

    const entry = readCassette(file).entries[1] as ChunksEntry;
    expect(entry.chunks.map((c) => c.frame)).toEqual([progress(1), progress(2)]);
    expect(fs.readFileSync(file, "utf8")).not.toContain('"jsonrpc":"2.0"}'); // the half frame is not invented
  });
});
