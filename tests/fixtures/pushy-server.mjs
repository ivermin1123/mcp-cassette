#!/usr/bin/env node
/**
 * A stdio MCP server that speaks on its own, which the other fixture server
 * never does: it pushes change notifications no request asked for.
 *
 * No dependencies, plain newline-delimited JSON-RPC, like tiny-server.mjs.
 *
 * Env flags:
 *   PUSHY_ERA=legacy (default)  classic lifecycle; an unsolicited
 *                               notifications/tools/list_changed follows the
 *                               tools/call that changed the tool list.
 *   PUSHY_ERA=modern            the 2026-07-28 lifecycle: server/discover, a
 *                               long-lived subscriptions/listen acknowledged
 *                               but never answered, and change notifications
 *                               tagged with that subscription's id.
 */

import readline from "node:readline";

const modern = process.env.PUSHY_ERA === "modern";
const PROTOCOL = modern ? "2026-07-28" : "2025-06-18";
const SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";

const tools = [
  {
    name: "echo",
    description: "Echo a message back to the caller.",
    inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
  },
  {
    name: "add_tool",
    description: "Install one more tool, which changes the tool list.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
];

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/** The modern era requires a resultType on every result; the legacy era has no such field. */
const result = (id, payload) => send({ jsonrpc: "2.0", id, result: modern ? { resultType: "complete", ...payload } : payload });

/** Subscriptions the client opened: listen request id -> the filter the server honored. */
const subscriptions = new Map();

/** Push a change notification to every subscription that asked for this type. */
function announce(method, filter) {
  if (!modern) {
    send({ jsonrpc: "2.0", method }); // the legacy era pushes unsolicited, to everyone
    return;
  }
  for (const [id, honored] of subscriptions) {
    if (honored[filter]) send({ jsonrpc: "2.0", method, params: { _meta: { [SUBSCRIPTION_ID]: id } } });
  }
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (id === undefined) return; // notification

  switch (method) {
    // The modern era removed the handshake outright, so a modern server has no
    // `initialize` to answer: it falls through to method-not-found, which is
    // what makes a probing client ask `server/discover` instead.
    case "initialize":
      if (modern) {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found: initialize" } });
        break;
      }
      result(id, {
        protocolVersion: params?.protocolVersion ?? PROTOCOL,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "pushy-server", version: "1.0.0" },
      });
      break;
    case "server/discover":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          resultType: "complete",
          supportedVersions: [PROTOCOL],
          capabilities: { tools: { listChanged: true } },
          _meta: { "io.modelcontextprotocol/serverInfo": { name: "pushy-server", version: "1.0.0" } },
        },
      });
      break;
    case "subscriptions/listen": {
      // No response: the acknowledgment is the answer, and the request stays
      // open until the server ends the subscription or the transport does.
      const asked = params?.notifications ?? {};
      const honored = { toolsListChanged: asked.toolsListChanged === true };
      subscriptions.set(id, honored);
      send({
        jsonrpc: "2.0",
        method: "notifications/subscriptions/acknowledged",
        params: { _meta: { [SUBSCRIPTION_ID]: id }, notifications: honored },
      });
      break;
    }
    case "tools/list":
      // The modern era requires the CacheableResult freshness fields on a list.
      result(id, modern ? { tools, ttlMs: 60_000, cacheScope: "public" } : { tools });
      break;
    case "tools/call": {
      const name = params?.name;
      if (name === "echo") {
        result(id, { content: [{ type: "text", text: `echo:${params?.arguments?.message}` }] });
      } else if (name === "add_tool") {
        const added = String(params?.arguments?.name ?? "extra");
        tools.push({ name: added, description: "Installed at runtime.", inputSchema: { type: "object" } });
        result(id, { content: [{ type: "text", text: `installed:${added}` }] });
        // The tool list changed, so everyone listening hears about it, after
        // the answer to the call that changed it.
        announce("notifications/tools/list_changed", "toolsListChanged");
      } else {
        send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${name}` } });
      }
      break;
    }
    default:
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
});
