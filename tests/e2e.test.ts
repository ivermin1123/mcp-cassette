/**
 * End-to-end: real child processes, the built CLI (dist/), and the tiny
 * fixture server. `npm test` builds first (pretest), so dist/ exists.
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MiniClient, Tool } from "../src/client.js";
import { runCheck } from "../src/check.js";
import { captureContract, diffContracts } from "../src/snapshot.js";
import { readCassette } from "../src/cassette.js";

const ROOT = path.resolve(__dirname, "..");
const TINY = path.join(ROOT, "tests/fixtures/tiny-server.mjs");
const CLI = path.join(ROOT, "dist/cli.js");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cassette-"));

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const tinyTarget = { kind: "stdio" as const, command: ["node", TINY] };

describe("check against a live server", () => {
  it("passes a clean server", async () => {
    const report = await runCheck(tinyTarget, "tiny");
    expect(report.ok).toBe(true);
    expect(report.toolCount).toBe(3);
    expect(report.server?.name).toBe("tiny-server");
  }, 20_000);

  it("fails a poisoned server with lint + schema findings", async () => {
    const report = await runCheck(
      { kind: "stdio", command: ["node", TINY], },
      "tiny-evil"
    ).catch(() => null);
    // env can't be passed through Target yet — spawn via env wrapper instead
    const evilReport = await runCheck(
      { kind: "stdio", command: [process.execPath, "-e",
        `process.env.TINY_EVIL="1";import(${JSON.stringify(TINY)})`] },
      "tiny-evil"
    );
    expect(report).not.toBeNull();
    expect(evilReport.ok).toBe(false);
    const codes = evilReport.findings.map((f) => f.code);
    expect(codes).toContain("CAS-L001"); // instruction override
    expect(codes).toContain("CAS-L003"); // concealment
    expect(codes).toContain("CAS-L004"); // exfiltration URL
    expect(codes).toContain("CAS-C005"); // invalid schema
  }, 20_000);
});

describe("record → replay round trip", () => {
  it("records a session through the proxy and replays it deterministically offline", async () => {
    const cassettePath = path.join(tmpDir, "session.cassette.jsonl");

    // 1) Drive a real session THROUGH the record proxy.
    const recordTarget = {
      kind: "stdio" as const,
      command: ["node", CLI, "record", "-o", cassettePath, "--", "node", TINY],
    };
    const { client, init } = await MiniClient.connect(recordTarget);
    expect(init.serverInfo?.name).toBe("tiny-server");
    const tools = await client.listAll<Tool>("tools/list", "tools");
    expect(tools.map((t) => t.name).sort()).toEqual(["add", "echo", "slugify"]);
    const call = await client.request("tools/call", {
      name: "echo",
      arguments: { message: "hello" },
    });
    expect(JSON.stringify(call.result)).toContain("echo:hello");
    await client.close();

    // Give the writer a moment to flush after process exit.
    await new Promise((r) => setTimeout(r, 400));

    const cassette = readCassette(cassettePath);
    const methods = cassette.entries
      .filter((e) => e.type === "frame" && e.dir === "c2s")
      .map((e) => (e as { frame: { method?: string } }).frame.method);
    expect(methods).toContain("initialize");
    expect(methods).toContain("tools/call");

    // 2) Replay: the "server" is now just the cassette — tiny-server never runs.
    const replayTarget = {
      kind: "stdio" as const,
      command: ["node", CLI, "replay", cassettePath],
    };
    const replayReport = await runCheck(replayTarget, "replay");
    expect(replayReport.ok).toBe(true);
    expect(replayReport.toolCount).toBe(3);
    expect(replayReport.server?.name).toBe("tiny-server");

    // 3) Recorded tool call replays with the recorded payload.
    const { client: rc } = await MiniClient.connect(replayTarget);
    const replayed = await rc.request("tools/call", {
      name: "echo",
      arguments: { message: "hello" },
    });
    expect(JSON.stringify(replayed.result)).toContain("echo:hello");
    const miss = await rc.request("tools/call", { name: "never-recorded", arguments: {} });
    expect(miss.error?.code).toBe(-32601);
    await rc.close();
  }, 30_000);
});

describe("snapshot contract diff across server versions", () => {
  it("detects breaking changes between v1 and v2 of the fixture server", async () => {
    const v1 = await captureContract(tinyTarget);
    const v2 = await captureContract({
      kind: "stdio",
      command: [process.execPath, "-e", `process.env.TINY_V2="1";import(${JSON.stringify(TINY)})`],
    });
    const changes = diffContracts(v1, v2);
    const breaking = changes.filter((c) => c.kind === "breaking");
    expect(breaking.some((c) => c.subject === "slugify" && c.message === "tool removed")).toBe(true);
    expect(
      breaking.some((c) => c.subject === "add" && c.message.includes('"precision"'))
    ).toBe(true);
    expect(changes.some((c) => c.kind === "minor" && c.message.includes('"mode"'))).toBe(true);
  }, 20_000);
});
