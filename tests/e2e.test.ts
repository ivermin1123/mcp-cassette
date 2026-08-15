/**
 * End-to-end: real child processes, the built CLI (dist/), and the tiny
 * fixture server. `npm test` builds first (pretest), so dist/ exists.
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
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

describe("secrets redaction end to end", () => {
  /** Must match tests/fixtures/tiny-server.mjs. */
  const FAKE_GITHUB_TOKEN = "ghp_Fak3T0k3nF0rR3d4ct10nT3st0000000000";

  /** The fixture server with its credential-echoing tool enabled. */
  const secretServer = [
    process.execPath,
    "-e",
    `process.env.TINY_SECRETS="1";import(${JSON.stringify(TINY)})`,
    // a token passed as a CLI argument — the server ignores it, the header records it
    "--",
    `--token=${FAKE_GITHUB_TOKEN}`,
  ];

  const recordSession = async (cassettePath: string, extra: string[] = []) => {
    const { client } = await MiniClient.connect({
      kind: "stdio",
      command: ["node", CLI, "record", "-o", cassettePath, ...extra, "--", ...secretServer],
    });
    const call = await client.request("tools/call", {
      name: "leak",
      arguments: { token: FAKE_GITHUB_TOKEN },
    });
    expect(JSON.stringify(call.result)).toContain(FAKE_GITHUB_TOKEN); // live session is untouched
    await client.close();
    await new Promise((r) => setTimeout(r, 400));
  };

  it("keeps the token out of the cassette and still replays the recorded response", async () => {
    const cassettePath = path.join(tmpDir, "redacted.cassette.jsonl");
    await recordSession(cassettePath);

    // 1) Nothing on disk carries the credential — request, response, or header.
    const onDisk = fs.readFileSync(cassettePath, "utf8");
    expect(onDisk).not.toContain(FAKE_GITHUB_TOKEN);
    expect(onDisk).toContain("[REDACTED:github:"); // the token in the server's reply
    expect(onDisk).toContain("[REDACTED:keyctx:"); // the token under the "token" argument

    const cassette = readCassette(cassettePath);
    expect(cassette.header.redaction).toEqual({ applied: true });
    expect(cassette.header.command?.join(" ")).toContain("--token=[REDACTED:github:");

    // 2) Replay: the client still sends the live token and still gets its answer.
    const replayTarget = {
      kind: "stdio" as const,
      command: ["node", CLI, "replay", cassettePath],
    };
    const { client: rc } = await MiniClient.connect(replayTarget);
    const replayed = await rc.request("tools/call", {
      name: "leak",
      arguments: { token: FAKE_GITHUB_TOKEN },
    });
    await rc.close();

    expect(replayed.error).toBeUndefined();
    const text = JSON.stringify(replayed.result);
    expect(text).toContain("[REDACTED:github:");
    expect(text).not.toContain(FAKE_GITHUB_TOKEN);
  }, 30_000);

  it("--no-redact records verbatim, and `redact` audits and cleans it afterwards", async () => {
    const rawPath = path.join(tmpDir, "raw.cassette.jsonl");
    await recordSession(rawPath, ["--no-redact"]);

    expect(fs.readFileSync(rawPath, "utf8")).toContain(FAKE_GITHUB_TOKEN);
    expect(readCassette(rawPath).header.redaction).toEqual({ applied: false });

    // audit mode: reports the hits, writes nothing, fails CI
    const scan = spawnSync("node", [CLI, "redact", rawPath, "--scan"], { encoding: "utf8" });
    expect(scan.status).toBe(1);
    expect(scan.stdout).toContain("[github]");
    expect(scan.stdout).toContain("[keyctx]");
    expect(scan.stdout).not.toContain(FAKE_GITHUB_TOKEN); // excerpts stay masked
    expect(fs.readFileSync(rawPath, "utf8")).toContain(FAKE_GITHUB_TOKEN);

    // clean it up, then a re-scan passes
    const cleanPath = path.join(tmpDir, "cleaned.cassette.jsonl");
    const clean = spawnSync("node", [CLI, "redact", rawPath, "-o", cleanPath], { encoding: "utf8" });
    expect(clean.status).toBe(0);
    expect(fs.readFileSync(cleanPath, "utf8")).not.toContain(FAKE_GITHUB_TOKEN);
    expect(readCassette(cleanPath).header.redaction).toEqual({ applied: true });

    const rescan = spawnSync("node", [CLI, "redact", cleanPath, "--scan"], { encoding: "utf8" });
    expect(rescan.status).toBe(0);
    expect(rescan.stdout).toContain("CLEAN");
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
