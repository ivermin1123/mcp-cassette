/**
 * The two eras, and how MiniClient decides which one it is talking to.
 *
 * The detection matrix is §4.2 of the v0.3 design, and it is deliberately
 * asymmetric: HTTP asks modern first because a 400's *body* tells the eras
 * apart, stdio asks legacy first because a classic server meeting an unknown
 * pre-initialize request may log, error, or simply stall. Each row below is one
 * server the wild actually contains.
 */

import { afterAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { AddressInfo } from "node:net";
import { InputRequiredError, MiniClient } from "../src/client.js";
import { encodeHeaderValue, HttpTransport } from "../src/transport.js";
import { verifyAgainstServer } from "../src/verify.js";
import type { Cassette } from "../src/cassette.js";
import type { JsonRpcRequest } from "../src/jsonrpc.js";

const CLI = path.join(path.resolve(__dirname, ".."), "dist/cli.js");
const MODERN = "2026-07-28";
const DISCOVER_RESULT = {
  resultType: "complete",
  supportedVersions: [MODERN],
  capabilities: { tools: {} },
  _meta: { "io.modelcontextprotocol/serverInfo": { name: "modern-server", version: "1.0.0" } },
};

type Seen = { headers: http.IncomingHttpHeaders; body: JsonRpcRequest };
type Reply = (req: JsonRpcRequest, res: http.ServerResponse, n: number) => void;

const servers: http.Server[] = [];
afterAll(async () => {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
});

async function stub(reply: Reply): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    if (req.method !== "POST") return void res.writeHead(200).end();
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const frame = JSON.parse(body) as JsonRpcRequest;
      seen.push({ headers: req.headers, body: frame });
      reply(frame, res, seen.length);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, seen };
}

const json = (res: http.ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const ok = (res: http.ServerResponse, id: unknown, result: unknown) =>
  json(res, { jsonrpc: "2.0", id, result });
const rpcError = (res: http.ServerResponse, id: unknown, code: number, message: string, data?: unknown, status = 400) =>
  json(res, { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } }, status);

/** A stdio server, inline, that answers whichever methods the test names. */
const stdioServer = (body: string) => [
  process.execPath,
  "-e",
  `let b="";process.stdin.on("data",d=>{b+=d;let i;while((i=b.indexOf("\\n"))>=0){const l=b.slice(0,i);b=b.slice(i+1);
   if(!l.trim())continue;const m=JSON.parse(l);if(m.id===undefined)continue;const answer=(${body});
   const r=answer(m);if(r)process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,...r})+"\\n")}})`,
];

describe("era detection over HTTP (modern-first)", () => {
  it("takes a 2xx modern result as modern, and reads identity out of result._meta", async () => {
    const { url, seen } = await stub((req, res) => ok(res, req.id, DISCOVER_RESULT));
    const { client, init } = await MiniClient.connect({ kind: "http", url }, 2000);

    expect(client.era).toBe("modern");
    expect(init.serverInfo).toEqual({ name: "modern-server", version: "1.0.0" });
    expect(init.protocolVersion).toBe(MODERN);
    expect(seen[0]!.body.method).toBe("server/discover");
    expect(seen[0]!.headers["mcp-method"]).toBe("server/discover");
    expect(seen[0]!.headers["mcp-protocol-version"]).toBe(MODERN);
    expect((seen[0]!.body.params as Record<string, Record<string, unknown>>)._meta).toMatchObject({
      "io.modelcontextprotocol/protocolVersion": MODERN,
      "io.modelcontextprotocol/clientCapabilities": {},
    });
    await client.close();
  });

  it("stays modern on a 400 that carries -32022, retrying at a version the server named", async () => {
    const { url, seen } = await stub((req, res, n) =>
      n === 1
        ? rpcError(res, req.id, -32022, "Unsupported protocol version", {
            supported: ["2025-11-25"],
            requested: MODERN,
          })
        : ok(res, req.id, { ...DISCOVER_RESULT, supportedVersions: ["2025-11-25"] })
    );
    const { client, init } = await MiniClient.connect({ kind: "http", url }, 2000);

    expect(client.era).toBe("modern"); // a recognized modern error is not a reason to fall back
    expect(init.protocolVersion).toBe("2025-11-25");
    // Header and _meta must agree, or the server answers -32020 next time.
    expect(seen[1]!.headers["mcp-protocol-version"]).toBe("2025-11-25");
    expect(
      (seen[1]!.body.params as Record<string, Record<string, unknown>>)._meta!
        ["io.modelcontextprotocol/protocolVersion"]
    ).toBe("2025-11-25");
    await client.close();
  });

  it("falls back to initialize when a 400 carries no modern error body", async () => {
    const { url, seen } = await stub((req, res) =>
      req.method === "server/discover"
        ? void res.writeHead(400).end()
        : ok(res, req.id, { protocolVersion: "2025-06-18", serverInfo: { name: "legacy-server" } })
    );
    const { client, init } = await MiniClient.connect({ kind: "http", url }, 2000);

    expect(client.era).toBe("legacy");
    expect(init.serverInfo?.name).toBe("legacy-server");
    expect(seen.map((s) => s.body.method)).toEqual([
      "server/discover",
      "initialize",
      "notifications/initialized",
    ]);
    await client.close();
  });

  it("falls back on a 404 from a server that does not host a modern endpoint", async () => {
    const { url } = await stub((req, res) =>
      req.method === "server/discover"
        ? void res.writeHead(404).end("<html>not found</html>")
        : ok(res, req.id, { protocolVersion: "2025-06-18", serverInfo: { name: "old" } })
    );
    const { client } = await MiniClient.connect({ kind: "http", url }, 2000);
    expect(client.era).toBe("legacy");
    await client.close();
  });

  it("reports both failures verbatim when neither era answers", async () => {
    const { url } = await stub((_req, res) => void res.writeHead(500).end());
    await expect(MiniClient.connect({ kind: "http", url }, 2000)).rejects.toThrow(
      /neither era.*modern: HTTP 500.*legacy: initialize failed/s
    );
  });
});

describe("era detection over stdio (legacy-first)", () => {
  it("prefers initialize on a server that would answer both", async () => {
    const dual = stdioServer(`(m)=>({result:m.method==="server/discover"
      ?{resultType:"complete",supportedVersions:["${MODERN}"],capabilities:{}}
      :{protocolVersion:"2025-06-18",serverInfo:{name:"dual"}}})`);
    const { client, init } = await MiniClient.connect({ kind: "stdio", command: dual }, 3000);
    expect(client.era).toBe("legacy"); // ordering is the whole assertion
    expect(init.serverInfo?.name).toBe("dual");
    await client.close();
  }, 15_000);

  it("falls forward to server/discover when initialize errors", async () => {
    const modernOnly = stdioServer(`(m)=>m.method==="server/discover"
      ?{result:{resultType:"complete",supportedVersions:["${MODERN}"],capabilities:{},
        _meta:{"io.modelcontextprotocol/serverInfo":{name:"stateless"}}}}
      :{error:{code:-32601,message:"Method not found"}}`);
    const { client, init } = await MiniClient.connect({ kind: "stdio", command: modernOnly }, 3000);
    expect(client.era).toBe("modern");
    expect(init.serverInfo?.name).toBe("stateless");
    await client.close();
  }, 15_000);

  it("falls forward when initialize times out instead of answering", async () => {
    const silent = stdioServer(`(m)=>m.method==="server/discover"
      ?{result:{resultType:"complete",supportedVersions:["${MODERN}"],capabilities:{}}}:null`);
    const { client } = await MiniClient.connect({ kind: "stdio", command: silent }, 400);
    expect(client.era).toBe("modern");
    await client.close();
  }, 15_000);
});

describe("modern request dialect", () => {
  it("mirrors method and name into headers, Base64-encoding what a header cannot hold", async () => {
    const { url, seen } = await stub((req, res) =>
      ok(res, req.id, req.method === "server/discover" ? DISCOVER_RESULT : { content: [] })
    );
    const { client } = await MiniClient.connect({ kind: "http", url }, 2000, "modern");
    await client.request("tools/call", { name: "get_weather", arguments: {} });
    await client.request("resources/read", { uri: "file:///日本語.json" });
    await client.request("tools/list", {});

    expect(seen[1]!.headers["mcp-name"]).toBe("get_weather");
    expect(seen[2]!.headers["mcp-name"]).toBe(encodeHeaderValue("file:///日本語.json"));
    expect(seen[2]!.headers["mcp-name"]).toMatch(/^=\?base64\?.*\?=$/);
    expect(seen[3]!.headers["mcp-name"]).toBeUndefined(); // tools/list names nothing
    expect(seen[3]!.headers["mcp-method"]).toBe("tools/list");
    await client.close();
  });

  it("encodes exactly the values a header cannot carry as-is", () => {
    expect(encodeHeaderValue("us-west1")).toBe("us-west1");
    expect(encodeHeaderValue("Hello, 世界")).toBe("=?base64?SGVsbG8sIOS4lueVjA==?=");
    expect(encodeHeaderValue(" padded ")).toBe("=?base64?IHBhZGRlZCA=?=");
    expect(encodeHeaderValue("line1\nline2")).toBe("=?base64?bGluZTEKbGluZTI=?=");
    // A plain value shaped like the sentinel must be encoded, or it reads as one.
    expect(encodeHeaderValue("=?base64?literal?=")).toBe("=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=");
  });

  it("treats a result without resultType as complete, and input_required as an error", async () => {
    const { url } = await stub((req, res) => {
      if (req.method === "server/discover") return ok(res, req.id, DISCOVER_RESULT);
      if (req.method === "tools/list") return ok(res, req.id, { tools: [] }); // no resultType
      ok(res, req.id, { resultType: "input_required", inputRequests: [{ method: "elicitation/create" }] });
    });
    const { client } = await MiniClient.connect({ kind: "http", url }, 2000, "modern");

    await expect(client.request("tools/list", {})).resolves.toMatchObject({ result: { tools: [] } });
    await expect(client.request("tools/call", { name: "ask" })).rejects.toBeInstanceOf(InputRequiredError);
    await client.close();
  });

  it("sends no session id in the modern era even if a server minted one", async () => {
    const { url, seen } = await stub((req, res) => {
      res.setHeader("mcp-session-id", "sess-1");
      ok(res, req.id, req.method === "server/discover" ? DISCOVER_RESULT : { tools: [] });
    });
    const { client } = await MiniClient.connect({ kind: "http", url }, 2000, "modern");
    await client.request("tools/list", {});
    expect(seen[1]!.headers["mcp-session-id"]).toBeUndefined();
    await client.close();
  });
});

describe("session teardown", () => {
  it("gives up on a DELETE the server never answers instead of hanging the process", async () => {
    const { url } = await stub((req, res) => {
      res.setHeader("mcp-session-id", "sess-1");
      ok(res, req.id, { tools: [] });
    });
    // The stub answers non-POST immediately, so hold the DELETE open here.
    const held = http.createServer((req, res) => {
      if (req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
        return void res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
      }
      // never respond
    });
    await new Promise<void>((r) => held.listen(0, "127.0.0.1", r));
    servers.push(held);
    const heldUrl = `http://127.0.0.1:${(held.address() as AddressInfo).port}/mcp`;

    const t = new HttpTransport(heldUrl);
    await t.request({ jsonrpc: "2.0", id: 1, method: "initialize" }, 2000);
    const started = process.hrtime.bigint();
    await t.close();
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeLessThan(4000); // the 2s leash, with room for a slow CI box
    expect(url).toContain("http://"); // (the first stub is only here for its port)
  }, 15_000);
});

describe("CLI surface", () => {
  it("verifies a cassette against an HTTP server given with --url", async () => {
    const { url } = await stub((req, res) =>
      ok(res, req.id, req.method === "initialize"
        ? { protocolVersion: "2025-06-18", serverInfo: { name: "legacy" } }
        : { content: [{ type: "text", text: "42" }] })
    );
    const cassette: Cassette = {
      header: { type: "header", cassetteVersion: 2, recorder: "t", startedAt: "t", transport: "http", url },
      entries: [
        { type: "frame", t: 1, dir: "c2s", frame: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "answer" } } },
        { type: "frame", t: 2, dir: "s2c", frame: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "42" }] } } },
      ],
    };
    const results = await verifyAgainstServer(cassette, { kind: "http", url }, { timeoutMs: 2000, era: "legacy" });
    expect(results[0]).toMatchObject({ status: "MATCH" });
  });

  it("rejects an --era value that is not an era", () => {
    const run = spawnSync(process.execPath, [CLI, "check", "--url", "http://127.0.0.1:1/mcp", "--era", "retro"], {
      encoding: "utf8",
    });
    expect(run.stderr).toContain("--era must be legacy | modern | auto");
    expect(run.status).toBe(2);
  }, 15_000);
});
