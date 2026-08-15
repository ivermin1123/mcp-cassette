#!/usr/bin/env node
/**
 * Minimal MCP client built on the *official* SDK, used only by the weekly
 * foundation-canary workflow.
 *
 * mcp-cassette speaks the wire protocol itself — it has no SDK dependency, by
 * design, because a recorder that shares a client implementation with the thing
 * it records cannot see that implementation drift. The cost of that choice is
 * that nothing in the normal test suite ever notices when the SDK changes how a
 * client behaves on the wire. This script is that missing sensor: it drives the
 * same fixture server the suite uses, through `@modelcontextprotocol/sdk@latest`,
 * over the classic (non-stateless) lifecycle mcp-cassette v0.1 supports.
 *
 * A failure here is not a defect in this repository. It means the SDK's latest
 * release talks to a plain classic-lifecycle stdio server differently than it
 * used to, which is advance notice that recordings, replay, or both may need to
 * follow.
 *
 * Run:
 *   node sdk-next-client.mjs <path-to-server.mjs>
 *
 * Resolution note: this file is copied next to a throwaway `npm install` of the
 * SDK before it runs. ESM resolves bare specifiers relative to the importing
 * file, not the working directory, so it has to sit inside that install — it
 * cannot import the SDK from where it lives in the repository.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";

const serverPath = process.argv[2];
if (!serverPath) {
  console.error("usage: node sdk-next-client.mjs <path-to-server.mjs>");
  process.exit(2);
}

/**
 * Read from the install tree rather than `require("…/sdk/package.json")`: the
 * SDK's `exports` map does not expose its own manifest, and that import
 * resolves to something without a `version`, which reports "undefined" in the
 * one line of this log a human actually needs.
 */
function readSdkVersion() {
  const manifest = path.join(import.meta.dirname, "node_modules", "@modelcontextprotocol", "sdk", "package.json");
  try {
    return JSON.parse(fs.readFileSync(manifest, "utf8")).version;
  } catch {
    return "unknown";
  }
}

const sdkVersion = readSdkVersion();
console.log(`sdk version: ${sdkVersion}`);
console.log(`server:      node ${serverPath}`);

const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
const client = new Client({ name: "mcp-cassette-foundation-canary", version: "1" });

let failed = false;

/** Report a step without aborting the rest: one canary run should surface every signal it can. */
function step(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then((detail) => console.log(`[ok]   ${label}${detail ? ` — ${detail}` : ""}`))
    .catch((err) => {
      failed = true;
      console.log(`[FAIL] ${label} — ${err?.message ?? err}`);
    });
}

await step("initialize (classic lifecycle)", async () => {
  await client.connect(transport);
  const info = client.getServerVersion();
  const protocol = client.getServerCapabilities() ? "negotiated" : "no capabilities reported";
  return `server ${info?.name ?? "?"}@${info?.version ?? "?"}, ${protocol}`;
});

// Only meaningful once the handshake succeeded; the SDK throws a clear error on
// a client that never connected, which would be noise rather than signal.
if (!failed) {
  await step("tools/list", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    if (!names.includes("echo")) {
      throw new Error(`expected the "echo" tool, got [${names.join(", ")}]`);
    }
    return `${names.length} tools: ${names.join(", ")}`;
  });

  await step("tools/call echo", async () => {
    const res = await client.callTool({ name: "echo", arguments: { message: "canary" } });
    const text = res?.content?.[0]?.text ?? "";
    if (!String(text).includes("canary")) {
      throw new Error(`echo did not return the message: ${JSON.stringify(res)}`);
    }
    return JSON.stringify(text);
  });
}

await client.close().catch(() => {});

console.log(failed ? "\nresult: SDK DRIFT SIGNAL — see the failures above" : "\nresult: the latest SDK still speaks the classic lifecycle");
process.exit(failed ? 1 : 0);
