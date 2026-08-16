/**
 * Serving a cassette over Streamable HTTP.
 *
 * The design calls status fidelity the risk worth mitigating with a table, so
 * §3.2's matrix is a table here: one row per (era, sessioned, method), one row
 * per kind of POST. The rest asserts what §3.3 separates — what replay must be
 * faithful about (recorded statuses, 202, 405, a session id minted fresh) from
 * what it must not (strictness: a wrong header is a warning and a correct
 * answer, never a 400).
 *
 * The client is the real MiniClient from the transport split, driven in both
 * eras, because a replay server that only satisfies `fetch` has not been tested
 * against anything that behaves like a client.
 */

import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCassette, type CassetteEntry, type Era } from "../src/cassette.js";
import { startHttpReplay } from "../src/http-replay.js";
import { MiniClient } from "../src/client.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cassette-httpreplay-"));
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const frame = (dir: "c2s" | "s2c", f: unknown, http?: { status: number }): CassetteEntry =>
  ({ type: "frame", t: 1, dir, frame: f, ...(http ? { http } : {}) }) as CassetteEntry;

/** Write a cassette by hand: these tests are about the front-end, not the recorder. */
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

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

/** Capture stderr for the duration of one call — §3.3's warnings are an asserted behavior. */
async function withStderr<T>(run: () => Promise<T>): Promise<[T, string]> {
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => (lines.push(String(chunk)), true)) as typeof process.stderr.write;
  try {
    return [await run(), lines.join("")];
  } finally {
    process.stderr.write = write;
  }
}

const ask = (id: number, method: string, params: unknown = {}) => ({ jsonrpc: "2.0", id, method, params });

// A legacy recording with one of everything §3.2 distinguishes.
const LEGACY_ENTRIES: CassetteEntry[] = [
  frame("c2s", ask(1, "initialize")),
  frame("s2c", { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", serverInfo: { name: "taped" } } }),
  frame("c2s", ask(2, "tools/list")),
  frame("s2c", { jsonrpc: "2.0", id: 2, result: { tools: [{ name: "build" }] } }),
  frame("c2s", ask(3, "prompts/list")),
  frame("s2c", { jsonrpc: "2.0", id: 3, error: { code: -32022, message: "Unsupported" } }, { status: 400 }),
  frame("c2s", ask(4, "resources/list")),
  { type: "chunks", t: 5, dir: "s2c", id: 4, chunks: [{ t: 5, frame: { jsonrpc: "2.0", id: 4, result: { resources: [] } } }] } as CassetteEntry,
];

describe("the §3.2 method matrix", () => {
  const MATRIX: { era: Era; sessioned: boolean; method: string; status: number; allow: string | null }[] = [
    { era: "legacy", sessioned: true, method: "GET", status: 405, allow: "POST, DELETE" },
    { era: "legacy", sessioned: true, method: "DELETE", status: 200, allow: null },
    { era: "legacy", sessioned: false, method: "GET", status: 405, allow: "POST" },
    { era: "legacy", sessioned: false, method: "DELETE", status: 405, allow: "POST" },
    { era: "modern", sessioned: false, method: "GET", status: 405, allow: "POST" },
    { era: "modern", sessioned: false, method: "DELETE", status: 405, allow: "POST" },
    // The modern era removed sessions outright, so the header flag cannot revive them.
    { era: "modern", sessioned: true, method: "DELETE", status: 405, allow: "POST" },
  ];

  it.each(MATRIX)("$era (sessioned=$sessioned) answers $method with $status", async (row) => {
    const file = cassette(`matrix-${row.era}-${row.sessioned}-${row.method}`, { era: row.era, sessioned: row.sessioned }, LEGACY_ENTRIES);
    const server = await startHttpReplay(file, { listen: "127.0.0.1:0" });
    const res = await fetch(server.url, { method: row.method });
    await server.close();

    expect(res.status).toBe(row.status);
    expect(res.headers.get("allow")).toBe(row.allow); // RFC 9110: a 405 names what is accepted
    if (row.status === 200) expect(await res.text()).toBe("");
  });
});

describe("the §3.2 POST rows", () => {
  const POSTS: { slug: string; what: string; send: unknown; status: number; expect: (body: string) => void }[] = [
    {
      slug: "matched",
      what: "a matched JSON answer, re-keyed to the incoming id",
      send: ask(77, "tools/list"),
      status: 200,
      expect: (b) => expect(JSON.parse(b)).toEqual({ jsonrpc: "2.0", id: 77, result: { tools: [{ name: "build" }] } }),
    },
    {
      slug: "status",
      what: "a recorded status the client could not derive",
      send: ask(78, "prompts/list"),
      status: 400,
      expect: (b) => expect(JSON.parse(b).error.code).toBe(-32022),
    },
    {
      slug: "notify",
      what: "a notification, acknowledged and never answered",
      send: { jsonrpc: "2.0", method: "notifications/initialized" },
      status: 202,
      expect: (b) => expect(b).toBe(""),
    },
    {
      slug: "miss",
      what: "a miss, whose diagnosis travels in the body",
      send: { jsonrpc: "2.0", id: 79, method: "tools/call", params: { name: "ship", arguments: {} } },
      status: 200, // the transport worked; the protocol answer is the error
      expect: (b) => {
        const error = JSON.parse(b).error;
        expect(error.message).toContain("no recorded response");
        expect(error.message).toContain('no recorded request has method "tools/call"');
      },
    },
    {
      slug: "streamed",
      what: "an answer the cassette has but cannot serve yet",
      send: ask(80, "resources/list"),
      status: 200,
      expect: (b) =>
        expect(JSON.parse(b).error.message).toContain("is streamed; SSE replay lands in PR 7"),
    },
  ];

  it.each(POSTS)("answers $what", async (row) => {
    const file = cassette(`post-${row.slug}`, { era: "legacy" }, LEGACY_ENTRIES);
    const server = await startHttpReplay(file, { listen: "127.0.0.1:0" });
    const [res] = await withStderr(() => post(server.url, row.send));
    const body = await res.text();
    await server.close();

    expect(res.status).toBe(row.status);
    row.expect(body);
  });

  it("counts a miss but never a streamed answer — the cassette does have one of those", async () => {
    const file = cassette("counting", { era: "legacy" }, LEGACY_ENTRIES);
    const server = await startHttpReplay(file, { listen: "127.0.0.1:0" });
    await withStderr(async () => {
      await post(server.url, ask(1, "resources/list")); // streamed: known, just not served here
      expect(server.misses()).toBe(0);
      await post(server.url, ask(2, "roots/list")); // genuinely absent
    });
    expect(server.misses()).toBe(1);
    await server.close();
  });
});

describe("what replay is faithful about, and what it refuses to be", () => {
  it("mints a session id that is nowhere in the cassette, and a different one next session", async () => {
    const file = cassette("sessions", { era: "legacy", sessioned: true }, LEGACY_ENTRIES);
    const first = await startHttpReplay(file, { listen: "127.0.0.1:0" });
    const opened = await post(first.url, ask(1, "initialize"));
    const minted = opened.headers.get("mcp-session-id")!;
    // It is accepted afterwards, and a plain request does not re-mint.
    const next = await post(first.url, ask(2, "tools/list"), { "mcp-session-id": minted });
    await first.close();

    const second = await startHttpReplay(file, { listen: "127.0.0.1:0" });
    const again = await post(second.url, ask(1, "initialize"));
    const remint = again.headers.get("mcp-session-id")!;
    await second.close();

    expect(minted).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(next.headers.get("mcp-session-id")).toBeNull();
    expect(remint).not.toBe(minted); // fresh per session, never a recorded value
    // The recorded value was never written, so there is nothing in the file to have reused.
    const raw = fs.readFileSync(file, "utf8");
    expect(raw).not.toContain(minted);
    expect(raw).not.toContain(remint);
    expect(raw.toLowerCase()).not.toContain("mcp-session-id");
  });

  it("answers a request whose headers are all wrong, and says so on stderr", async () => {
    const file = cassette("lenient", { era: "modern", sessioned: false }, [
      frame("c2s", { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } }),
      frame("s2c", { jsonrpc: "2.0", id: 1, result: { tools: [] } }),
    ]);
    const server = await startHttpReplay(file, { listen: "127.0.0.1:0" });
    const [res, stderr] = await withStderr(() =>
      post(server.url, ask(9, "tools/list"), {
        "mcp-method": "tools/call", // contradicts the body
        "mcp-protocol-version": "1999-01-01", // not what was recorded
        "mcp-session-id": "not-the-minted-one",
      })
    );
    await server.close();

    expect(res.status).toBe(200); // never a 400: conformance is verify's job, not replay's
    expect(JSON.parse(await res.text()).result).toEqual({ tools: [] });
    expect(stderr).toContain('Mcp-Method "tools/call" does not match');
    expect(stderr).toContain('MCP-Protocol-Version "1999-01-01" is not the recorded "2026-07-28"');
  });

  it("refuses a stdio cassette loudly instead of serving something it never recorded", async () => {
    const file = cassette("stdio", { transport: "stdio", command: ["node", "server.js"] }, []);
    await expect(startHttpReplay(file, { listen: "127.0.0.1:0" })).rejects.toThrow(
      /serves HTTP cassettes; .* was recorded over stdio/
    );
  });

  it("counts the streamed answers out loud at startup, and blocks a non-local Origin", async () => {
    const file = cassette("startup", { era: "legacy" }, LEGACY_ENTRIES);
    const [server, stderr] = await withStderr(() => startHttpReplay(file, { listen: "127.0.0.1:0" }));
    const blocked = await fetch(server.url, { method: "POST", headers: { origin: "https://evil.example.com" } });
    await server.close();

    expect(stderr).toContain("1 streamed answer(s) in the cassette — served in PR 7");
    expect(stderr).toContain("as a legacy server at");
    expect(blocked.status).toBe(403);
  });
});

describe("a real client, in both eras", () => {
  it("runs a legacy session end to end: handshake, request, session teardown", async () => {
    const file = cassette("client-legacy", { era: "legacy", sessioned: true }, LEGACY_ENTRIES);
    const server = await startHttpReplay(file, { listen: "127.0.0.1:0" });
    const [{ client, init }] = await withStderr(() =>
      MiniClient.connect({ kind: "http", url: server.url }, 5000, "legacy")
    );

    expect(init.serverInfo).toEqual({ name: "taped" });
    expect(init.protocolVersion).toBe("2025-06-18");
    const tools = await client.request("tools/list");
    expect(tools.result).toEqual({ tools: [{ name: "build" }] });
    await client.close(); // sends DELETE with the minted id; a 405 here would throw
    await server.close();
    expect(server.misses()).toBe(0);
  });

  it("runs a modern session with no handshake at all", async () => {
    const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28" };
    const file = cassette("client-modern", { era: "modern" }, [
      frame("c2s", { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: meta } }),
      frame("s2c", {
        jsonrpc: "2.0",
        id: 1,
        result: {
          resultType: "complete",
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: {} },
          _meta: { "io.modelcontextprotocol/serverInfo": { name: "stateless" } },
        },
      }),
      frame("c2s", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "build", arguments: {}, _meta: meta } }),
      frame("s2c", { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "ok" }] } }),
    ]);
    const server = await startHttpReplay(file, { listen: "127.0.0.1:0" });
    const [{ client, init }, stderr] = await withStderr(() =>
      MiniClient.connect({ kind: "http", url: server.url }, 5000, "modern")
    );

    expect(init.serverInfo).toEqual({ name: "stateless" });
    expect(init.capabilities).toEqual({ tools: {} });
    // The live client's `_meta` differs from the recorded one and still matches:
    // fingerprinting drops it, which is what keeps one cassette valid per era.
    const called = await client.request("tools/call", { name: "build", arguments: {} });
    expect(called.result).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(stderr).not.toContain("does not match"); // a correct client earns no warnings
    await client.close();
    await server.close();
    expect(server.misses()).toBe(0);
  });
});

describe("the engine underneath is the one v1 shipped", () => {
  it("keeps the recorded cassette untouched — replay reads, it never writes", async () => {
    const file = cassette("readonly", { era: "legacy" }, LEGACY_ENTRIES);
    const before = fs.readFileSync(file, "utf8");
    const server = await startHttpReplay(file, { listen: "127.0.0.1:0" });
    await withStderr(async () => {
      await post(server.url, ask(1, "tools/list"));
      await post(server.url, ask(2, "nothing/recorded"));
    });
    await server.close();

    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(readCassette(file).entries).toHaveLength(LEGACY_ENTRIES.length);
  });

  it("exhausts a recorded pool exactly once, then diagnoses the extra call", async () => {
    const file = cassette("pool", { era: "legacy" }, LEGACY_ENTRIES);
    const server = await startHttpReplay(file, { listen: "127.0.0.1:0" });
    const [second] = await withStderr(async () => {
      await post(server.url, ask(1, "tools/list"));
      return post(server.url, ask(2, "tools/list"));
    });
    await server.close();

    expect(JSON.parse(await second.text()).error.message).toContain("already consumed earlier in this session");
  });
});
