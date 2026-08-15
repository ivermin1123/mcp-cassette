/**
 * Transports, unit by unit: what a frame does on the way out and what the
 * answer has to look like on the way back. The last case is the one that
 * matters most — `verify` never mentions a transport, so pointing it at an
 * HTTP server must work with no verify-side change at all. That invariant is
 * the whole point of the split; it is pinned here before anything is built on
 * top of it.
 */

import { afterAll, describe, expect, it } from "vitest";
import http from "node:http";
import { AddressInfo } from "node:net";
import { HttpTransport, StdioTransport } from "../src/transport.js";
import { verifyAgainstServer } from "../src/verify.js";
import type { Cassette } from "../src/cassette.js";
import type { JsonRpcFrame, JsonRpcRequest } from "../src/jsonrpc.js";

type Reply = (req: JsonRpcRequest, res: http.ServerResponse) => void;

const servers: http.Server[] = [];
afterAll(async () => {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
});

/** A stub HTTP MCP endpoint. Returns its URL and the headers it saw, per request. */
async function stub(reply: Reply): Promise<{ url: string; seen: http.IncomingHttpHeaders[] }> {
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    // Session teardown (DELETE) carries no body and is not the stub's business.
    if (req.method !== "POST") return void res.writeHead(200).end();
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push(req.headers);
      reply(JSON.parse(body) as JsonRpcRequest, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/mcp`, seen };
}

const json = (res: http.ServerResponse, frame: JsonRpcFrame, headers: Record<string, string> = {}) => {
  res.writeHead(200, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(frame));
};

const request = (id: number, method: string, params?: unknown): JsonRpcRequest => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params !== undefined ? { params } : {}),
});

describe("StdioTransport", () => {
  it("times out on a server that never answers, naming the method and the budget", async () => {
    const t = new StdioTransport(["node", "-e", "process.stdin.resume()"]);
    await expect(t.request(request(1, "tools/list"), 120)).rejects.toThrow(
      'timeout after 120ms waiting for "tools/list"'
    );
    await t.close();
  });

  it("refuses an empty command instead of spawning something arbitrary", () => {
    expect(() => new StdioTransport([])).toThrow("empty command");
  });

  it("closes the child process it spawned", async () => {
    const t = new StdioTransport(["node", "-e", "process.stdin.resume()"]);
    await t.close(); // resolves only once the process is gone — a hang here is the regression
  });
});

describe("HttpTransport", () => {
  it("treats 202 as a delivered notification and as a missing response body", async () => {
    const { url } = await stub((_req, res) => res.writeHead(202).end());
    const t = new HttpTransport(url);
    await expect(t.notify({ jsonrpc: "2.0", method: "notifications/initialized" }, 2000)).resolves.toBeUndefined();
    await expect(t.request(request(1, "tools/list"), 2000)).rejects.toThrow("returned no body");
  });

  it("parses the response out of an SSE stream, past the notifications before it", async () => {
    const { url } = await stub((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}\n\n`);
      res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { tools: [] } })}\n\n`);
      res.end();
    });
    const answer = await new HttpTransport(url).request(request(7, "tools/list"), 2000);
    expect(answer).toEqual({ jsonrpc: "2.0", id: 7, result: { tools: [] } });
  });

  it("echoes the session id the server minted, and the negotiated protocol version", async () => {
    const { url, seen } = await stub((req, res) =>
      json(res, { jsonrpc: "2.0", id: req.id, result: {} }, { "mcp-session-id": "sess-1" })
    );
    const t = new HttpTransport(url, { authorization: "Bearer token" });
    await t.request(request(1, "initialize"), 2000);
    t.setProtocolVersion("2025-06-18");
    await t.request(request(2, "tools/list"), 2000);

    expect(seen[0]!["mcp-session-id"]).toBeUndefined(); // nothing to echo yet
    expect(seen[0]!.authorization).toBe("Bearer token");
    expect(seen[1]!["mcp-session-id"]).toBe("sess-1");
    expect(seen[1]!["mcp-protocol-version"]).toBe("2025-06-18");
    await t.close();
  });

  it("surfaces a transport-level failure as the status, not as a parse error", async () => {
    const { url } = await stub((_req, res) => res.writeHead(500).end("upstream exploded"));
    await expect(new HttpTransport(url).request(request(1, "tools/list"), 2000)).rejects.toThrow(
      "HTTP 500 from server"
    );
  });
});

describe("verify over the HTTP transport", () => {
  it("re-fires the recorded requests at an HTTP server with no verify-side change", async () => {
    const { url } = await stub((req, res) => {
      if (req.method === "initialize") {
        return json(res, { jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2025-06-18" } });
      }
      if (req.method === "tools/call") {
        return json(res, { jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "42" }] } });
      }
      res.writeHead(202).end(); // notifications/initialized
    });

    const cassette: Cassette = {
      header: {
        type: "header",
        cassetteVersion: 2,
        recorder: "mcp-cassette@test",
        startedAt: "2026-08-15T09:00:00Z",
        transport: "http",
        url,
      },
      entries: [
        { type: "frame", t: 1, dir: "c2s", frame: request(1, "tools/call", { name: "answer", arguments: {} }) },
        {
          type: "frame",
          t: 2,
          dir: "s2c",
          frame: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "42" }] } },
        },
      ],
    };

    const results = await verifyAgainstServer(cassette, { kind: "http", url }, { timeoutMs: 2000 });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ label: "tools/call answer", status: "MATCH" });
  });
});
