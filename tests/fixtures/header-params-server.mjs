#!/usr/bin/env node
/**
 * Classic-lifecycle stdio server whose tool list carries `x-mcp-header`
 * annotations, one of them malformed.
 *
 * It exists to prove the negative: the annotation is a Streamable HTTP
 * concern, so a stdio client mirrors nothing and withholds nothing, and both
 * tools stay listable.
 */

import readline from "node:readline";

const tools = [
  {
    name: "route",
    description: "Run a query in one region.",
    inputSchema: {
      type: "object",
      properties: {
        region: { type: "string", description: "Region to run in", "x-mcp-header": "Region" },
        query: { type: "string", description: "The query to run" },
      },
      required: ["region", "query"],
    },
  },
  {
    name: "broken",
    description: "Declares a header name no field name may spell.",
    inputSchema: {
      type: "object",
      properties: { tenant: { type: "string", description: "Tenant", "x-mcp-header": "Tenant Id" } },
    },
  },
];

const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.id === undefined) return; // notification
  if (req.method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "header-params", version: "1.0.0" },
      },
    });
  }
  if (req.method === "tools/list") return send({ jsonrpc: "2.0", id: req.id, result: { tools } });
  send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `no method ${req.method}` } });
});
