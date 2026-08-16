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
    // env can't be passed through Target yet, so spawn via env wrapper instead
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

    // 2) Replay: the "server" is now just the cassette; tiny-server never runs.
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
  const FAKE_GITHUB_TOKEN = "ghp_NOTAREALTOKENUSEDINTESTSONLY000000";

  /** The fixture server with its credential-echoing tool enabled. */
  const secretServer = [
    process.execPath,
    "-e",
    `process.env.TINY_SECRETS="1";import(${JSON.stringify(TINY)})`,
    // a token passed as a CLI argument: the server ignores it, the header records it
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

    // 1) Nothing on disk carries the credential: request, response, or header.
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

  it("forwards bytes verbatim to both sides while the cassette holds only placeholders", async () => {
    // The invariant redaction must never break: the real server has to receive
    // the real credential, or every recording against an authenticated server
    // would fail. Redaction is a property of the file, not of the wire.
    const cassettePath = path.join(tmpDir, "verbatim.cassette.jsonl");
    const { client } = await MiniClient.connect({
      kind: "stdio",
      command: ["node", CLI, "record", "-o", cassettePath, "--", ...secretServer],
    });
    const call = await client.request("tools/call", {
      name: "leak",
      arguments: { token: FAKE_GITHUB_TOKEN },
    });
    await client.close();
    await new Promise((r) => setTimeout(r, 400));

    // The server echoes back what it actually parsed, proof it got the original.
    const text = JSON.stringify(call.result);
    expect(text).toContain(`received:${FAKE_GITHUB_TOKEN}`);
    // ...and the client got the server's own token through the proxy untouched.
    expect(text).toContain(`server token: ${FAKE_GITHUB_TOKEN}`);
    // Only the file is redacted.
    expect(fs.readFileSync(cassettePath, "utf8")).not.toContain(FAKE_GITHUB_TOKEN);
  }, 30_000);

  it("redacts a raw non-JSON-RPC line by key context, keeping its other bytes", async () => {
    // The server logs a JSON line with no "jsonrpc" tag: stored as a raw entry,
    // so the shape rules alone would never see arguments.password.
    const cassettePath = path.join(tmpDir, "rawline.cassette.jsonl");
    await recordSession(cassettePath);

    const raw = readCassette(cassettePath).entries.find(
      (e): e is Extract<typeof e, { type: "raw" }> => e.type === "raw"
    );
    expect(raw).toBeDefined();

    // (a) the secret is gone, (c) every other byte of the line is untouched
    expect(raw!.data).not.toContain("correct-horse-battery-staple");
    expect(raw!.data).toContain("[REDACTED:keyctx:");
    expect(raw!.data).toContain('"level":"debug"');
    expect(raw!.data).toContain('"msg":"calling upstream"');
    expect(raw!.data.startsWith('{"level":"debug","msg":"calling upstream","params":')).toBe(true);
    expect(raw!.data.endsWith("}}}")).toBe(true);
    expect(fs.readFileSync(cassettePath, "utf8")).not.toContain("correct-horse-battery-staple");

    // (b) an unredacted recording of the same session fails the audit and names it
    const rawPath = path.join(tmpDir, "rawline-unredacted.cassette.jsonl");
    await recordSession(rawPath, ["--no-redact"]);
    expect(fs.readFileSync(rawPath, "utf8")).toContain("correct-horse-battery-staple");

    const scan = spawnSync("node", [CLI, "redact", rawPath, "--scan"], { encoding: "utf8" });
    expect(scan.status).toBe(1);
    expect(scan.stdout).toContain("[keyctx] s2c params.arguments.password");
    expect(scan.stdout).not.toContain("correct-horse-battery-staple");
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

  it("refuses redact invocations that would silently do nothing", async () => {
    const cassettePath = path.join(tmpDir, "guards.cassette.jsonl");
    await recordSession(cassettePath);

    const neither = spawnSync("node", [CLI, "redact", cassettePath], { encoding: "utf8" });
    expect(neither.status).toBe(2);
    expect(neither.stderr).toContain("--scan");

    // -o with --scan reads as "clean this file"; it would write nothing.
    const both = spawnSync(
      "node",
      [CLI, "redact", cassettePath, "--scan", "-o", path.join(tmpDir, "never.jsonl")],
      { encoding: "utf8" }
    );
    expect(both.status).toBe(2);
    expect(fs.existsSync(path.join(tmpDir, "never.jsonl"))).toBe(false);
  }, 30_000);

  it("emits the complete --scan report through a pipe", async () => {
    // The report is unbounded, so `--scan` finishes by setting process.exitCode
    // and letting stdout drain rather than calling process.exit(), which can drop
    // queued output on platforms where a piped stdout is asynchronous. That
    // truncation does not reproduce on macOS/node 24 at any size tried, so this
    // pins the contract, a complete report, rather than the platform bug.
    const many = path.join(tmpDir, "many.cassette.jsonl");
    const header = {
      type: "header",
      cassetteVersion: 1,
      recorder: "test",
      startedAt: "2026-01-01T00:00:00Z",
      transport: "stdio",
    };
    const lines = [JSON.stringify(header)];
    for (let i = 0; i < 4000; i++) {
      lines.push(
        JSON.stringify({
          type: "frame",
          t: i,
          dir: "c2s",
          frame: {
            jsonrpc: "2.0",
            id: i,
            method: "tools/call",
            params: { name: "leak", arguments: { token: `${FAKE_GITHUB_TOKEN}${i}` } },
          },
        })
      );
    }
    fs.writeFileSync(many, lines.join("\n") + "\n");

    const piped = spawnSync("sh", ["-c", `node ${CLI} redact ${many} --scan | cat`], {
      encoding: "utf8",
    });
    const reported = piped.stdout.split("\n").filter((l) => l.startsWith("[keyctx]")).length;
    expect(reported).toBe(4000);
    expect(piped.stdout).toContain("result: FOUND (4000 secret(s) detected)");
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
    // v2 also adds an optional `mode` parameter: valid for every existing
    // caller, and still a behaviour change an agent can trip over, so dangerous.
    expect(
      changes.some(
        (c) =>
          c.kind === "dangerous" &&
          c.rule === "input-property-added-optional" &&
          c.message.includes('"mode"')
      )
    ).toBe(true);
  }, 20_000);
});
