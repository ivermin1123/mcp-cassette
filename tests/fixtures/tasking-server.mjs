#!/usr/bin/env node
/**
 * A stdio MCP server that answers with task handles instead of results, so the
 * suite has a session that uses the `io.modelcontextprotocol/tasks` extension.
 *
 * No dependencies, plain newline-delimited JSON-RPC, like the other fixtures.
 * It speaks the 2026-07-28 lifecycle only: there is no `initialize`, and
 * `server/discover` advertises the extension.
 *
 * One `tools/call` creates one task, and the recorded state sequence is fixed
 * so a cassette of it is deterministic:
 *
 *   poll 1  working
 *   poll 2  input_required   (parks here until tasks/update arrives)
 *   poll 3  working
 *   poll 4  completed        (and stays completed)
 *
 * Env flags:
 *   TASKING_STALL=1   the task never leaves `working`, which is how a recording
 *                     that stopped before the task finished is made.
 */

import readline from "node:readline";

const stall = process.env.TASKING_STALL === "1";
const PROTOCOL = "2026-07-28";
const SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";
const TASK_ID = "task-0001";

const tools = [
  {
    name: "build",
    description: "Start a build, which takes long enough to be a task.",
    inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
  },
];

const rl = readline.createInterface({ input: process.stdin, terminal: false });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const result = (id, payload) => send({ jsonrpc: "2.0", id, result: { resultType: "complete", ...payload } });

/** Subscriptions the client opened: listen request id -> the filter the server honored. */
const subscriptions = new Map();

let polls = 0;
let awaitingInput = false;
let cancelled = false;
let finished = null;

/** The timestamps are fixed so two recordings of this fixture compare equal. */
const CREATED_AT = "2026-10-08T00:00:00Z";
const stamps = { createdAt: CREATED_AT, lastUpdatedAt: CREATED_AT, ttlMs: 60000, pollIntervalMs: 50 };

/** The task as it stands, advancing the scripted sequence when a poll is due one. */
function advance() {
  if (finished) return finished;
  if (cancelled) {
    finished = { taskId: TASK_ID, status: "cancelled", statusMessage: "cancelled by the client", ...stamps };
    return finished;
  }
  if (awaitingInput) {
    return {
      taskId: TASK_ID,
      status: "input_required",
      statusMessage: "waiting for the target to confirm",
      inputRequests: { confirm: { method: "elicitation/create", params: { message: "Deploy to production?" } } },
      ...stamps,
    };
  }
  polls++;
  if (!stall && polls === 2) {
    awaitingInput = true;
    return advance();
  }
  if (!stall && polls >= 4) {
    finished = {
      taskId: TASK_ID,
      status: "completed",
      statusMessage: "build finished",
      result: { content: [{ type: "text", text: "built: ok" }], isError: false },
      ...stamps,
    };
    return finished;
  }
  return { taskId: TASK_ID, status: "working", statusMessage: `poll ${polls}`, ...stamps };
}

/** Push the full task state to every open subscription, as the extension allows. */
function announce(task) {
  for (const id of subscriptions.keys()) {
    send({ jsonrpc: "2.0", method: "notifications/tasks", params: { _meta: { [SUBSCRIPTION_ID]: id }, ...task } });
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
    case "server/discover":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          resultType: "complete",
          supportedVersions: [PROTOCOL],
          capabilities: { tools: {}, extensions: { "io.modelcontextprotocol/tasks": {} } },
          _meta: { "io.modelcontextprotocol/serverInfo": { name: "tasking-server", version: "1.0.0" } },
        },
      });
      break;
    case "tools/list":
      result(id, { tools, ttlMs: 60000, cacheScope: "public" });
      break;
    case "tools/call":
      // The handle, not the result: resultType says which shape arrived.
      send({
        jsonrpc: "2.0",
        id,
        result: { resultType: "task", taskId: TASK_ID, status: "working", statusMessage: "queued", ...stamps },
      });
      break;
    case "tasks/get": {
      const task = advance();
      send({ jsonrpc: "2.0", id, result: { resultType: "complete", ...task } });
      // A terminal state is worth telling a listener about without another poll.
      if (task === finished) announce(task);
      break;
    }
    case "tasks/update":
      awaitingInput = false;
      result(id, {});
      announce({ taskId: TASK_ID, status: "working", statusMessage: "input accepted", ...stamps });
      break;
    case "tasks/cancel":
      cancelled = true;
      awaitingInput = false;
      result(id, {});
      break;
    case "subscriptions/listen": {
      const asked = params?.notifications ?? {};
      subscriptions.set(id, asked);
      send({
        jsonrpc: "2.0",
        method: "notifications/subscriptions/acknowledged",
        params: { _meta: { [SUBSCRIPTION_ID]: id }, notifications: asked },
      });
      break;
    }
    default:
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
});
