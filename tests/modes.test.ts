/**
 * Record modes (`--mode once|all`) and replay miss handling
 * (`--on-miss error|warn|passthrough`) through the built CLI, end to end.
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { MiniClient } from "../src/client.js";
import { readCassette } from "../src/cassette.js";
import type { JsonRpcFrame, JsonRpcResponse } from "../src/jsonrpc.js";

const ROOT = path.resolve(__dirname, "..");
const TINY = path.join(ROOT, "tests/fixtures/tiny-server.mjs");
const CLI = path.join(ROOT, "dist/cli.js");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cassette-modes-"));

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Record one real echo session through the proxy into `cassettePath`. */
async function recordEchoSession(cassettePath: string, extra: string[] = []): Promise<void> {
  const { client } = await MiniClient.connect({
    kind: "stdio",
    command: ["node", CLI, "record", "-o", cassettePath, ...extra, "--", "node", TINY],
  });
  await client.request("tools/call", { name: "echo", arguments: { message: "hello" } });
  await client.close();
  await new Promise((r) => setTimeout(r, 400));
}

/**
 * Drive a replay process with raw frames and observe its real exit code —
 * MiniClient can't, because closing it SIGTERMs the child.
 */
function replaySession(
  args: string[],
  frames: JsonRpcFrame[]
): Promise<{ code: number; out: JsonRpcFrame[]; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [CLI, "replay", ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      const out = stdout
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as JsonRpcFrame);
      resolve({ code: code ?? -1, out, stderr });
    });
    for (const frame of frames) child.stdin.write(JSON.stringify(frame) + "\n");
    child.stdin.end();
  });
}

const initFrame: JsonRpcFrame = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
};
const initializedNote: JsonRpcFrame = { jsonrpc: "2.0", method: "notifications/initialized" };
// A fingerprint miss alone is not enough to reach --on-miss: replay falls back
// to the next unconsumed same-method response. The burner call eats that
// fallback, so the call after it is a true miss.
const burnerCall: JsonRpcFrame = {
  jsonrpc: "2.0",
  id: 6,
  method: "tools/call",
  params: { name: "echo", arguments: { message: "burner" } },
};
const missCall: JsonRpcFrame = {
  jsonrpc: "2.0",
  id: 7,
  method: "tools/call",
  params: { name: "echo", arguments: { message: "never-recorded" } },
};

describe("record --mode", () => {
  it("once (default) refuses to overwrite an existing cassette", async () => {
    const cassettePath = path.join(tmpDir, "once.cassette.jsonl");
    await recordEchoSession(cassettePath);
    const before = fs.readFileSync(cassettePath, "utf8");

    const second = spawnSync("node", [CLI, "record", "-o", cassettePath, "--", "node", TINY], {
      encoding: "utf8",
    });
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("--mode all");
    expect(fs.readFileSync(cassettePath, "utf8")).toBe(before);
  }, 30_000);

  it("all re-records over an existing cassette", async () => {
    const cassettePath = path.join(tmpDir, "all.cassette.jsonl");
    await recordEchoSession(cassettePath);
    const before = readCassette(cassettePath);

    await recordEchoSession(cassettePath, ["--mode", "all"]);
    const after = readCassette(cassettePath);
    // A fresh header (new startedAt) proves a rewrite, not an append.
    expect(after.header.startedAt).not.toBe(before.header.startedAt);
    expect(after.entries.filter((e) => e.type === "frame").length).toBeGreaterThan(0);
  }, 30_000);

  it("rejects an unknown mode", () => {
    const out = spawnSync(
      "node",
      [CLI, "record", "-o", path.join(tmpDir, "x.jsonl"), "--mode", "sometimes", "--", "node", TINY],
      { encoding: "utf8" }
    );
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('unknown --mode "sometimes"');
  });
});

describe("replay --on-miss", () => {
  const recorded = path.join(tmpDir, "base.cassette.jsonl");
  const ensureRecorded = async () => {
    if (!fs.existsSync(recorded)) await recordEchoSession(recorded);
  };

  it("error (default): answers the miss with a JSON-RPC error and exits 1", async () => {
    await ensureRecorded();
    const { code, out, stderr } = await replaySession([recorded], [initFrame, initializedNote, burnerCall, missCall]);
    const miss = out.find((f) => "id" in f && f.id === 7) as JsonRpcResponse;
    expect(miss.error?.code).toBe(-32601);
    // Near-miss diagnostics name the exact diverging component.
    expect(miss.error?.message).toContain("arguments differ at");
    expect(miss.error?.message).toContain('/message (recorded "hello", got "never-recorded")');
    expect(stderr).toContain("fingerprint miss");
    expect(code).toBe(1);
  }, 30_000);

  it("error: a session with no misses exits 0", async () => {
    await ensureRecorded();
    const okCall: JsonRpcFrame = {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "echo", arguments: { message: "hello" } },
    };
    const { code, out } = await replaySession([recorded], [initFrame, initializedNote, okCall]);
    const hit = out.find((f) => "id" in f && f.id === 8) as JsonRpcResponse;
    expect(hit.error).toBeUndefined();
    expect(code).toBe(0);
  }, 30_000);

  it("warn: same JSON-RPC error, but the session exits 0", async () => {
    await ensureRecorded();
    const { code, out, stderr } = await replaySession(
      [recorded, "--on-miss", "warn"],
      [initFrame, initializedNote, burnerCall, missCall]
    );
    const miss = out.find((f) => "id" in f && f.id === 7) as JsonRpcResponse;
    expect(miss.error?.code).toBe(-32601);
    expect(stderr).toContain("fingerprint miss");
    expect(code).toBe(0);
  }, 30_000);

  it("passthrough without a server command fails up front with a clear message", async () => {
    await ensureRecorded();
    const out = spawnSync("node", [CLI, "replay", recorded, "--on-miss", "passthrough"], {
      encoding: "utf8",
    });
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("needs the real server command");
  });

  it("rejects an unknown --on-miss mode", async () => {
    await ensureRecorded();
    const out = spawnSync("node", [CLI, "replay", recorded, "--on-miss", "maybe"], { encoding: "utf8" });
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('unknown --on-miss "maybe"');
  });

  it("passthrough forwards the miss to the real server and appends it with origin:\"live\"", async () => {
    const cassettePath = path.join(tmpDir, "spy.cassette.jsonl");
    await recordEchoSession(cassettePath);
    const entriesBefore = readCassette(cassettePath).entries.length;

    const { code, out } = await replaySession(
      [cassettePath, "--on-miss", "passthrough", "--", "node", TINY],
      [initFrame, initializedNote, burnerCall, missCall]
    );
    expect(code).toBe(0);

    // The client got a real answer, not a -32601.
    const forwarded = out.find((f) => "id" in f && f.id === 7) as JsonRpcResponse;
    expect(forwarded.error).toBeUndefined();
    expect(JSON.stringify(forwarded.result)).toContain("echo:never-recorded");

    // The cassette grew by exactly one interaction, tagged and re-keyed.
    const after = readCassette(cassettePath);
    const appended = after.entries.filter((e) => e.type === "frame" && e.origin === "live");
    expect(appended).toHaveLength(2);
    expect(after.entries.length).toBe(entriesBefore + 2);
    const [c2s, s2c] = appended as Array<Extract<(typeof after.entries)[number], { type: "frame" }>>;
    expect(c2s!.dir).toBe("c2s");
    expect(s2c!.dir).toBe("s2c");
    expect((c2s!.frame as { id?: unknown }).id).toBe("live-1");
    expect((s2c!.frame as { id?: unknown }).id).toBe("live-1");

    // The grown cassette now replays the once-missing call offline.
    const replayAgain = await replaySession([cassettePath], [initFrame, initializedNote, burnerCall, missCall]);
    const hit = replayAgain.out.find((f) => "id" in f && f.id === 7) as JsonRpcResponse;
    expect(hit.error).toBeUndefined();
    expect(JSON.stringify(hit.result)).toContain("echo:never-recorded");
    expect(replayAgain.code).toBe(0);

    // A second passthrough session must continue the live-N sequence, not
    // reuse live-1 — duplicate ids would cross-wire request/response pairing.
    const missCall2: JsonRpcFrame = {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "echo", arguments: { message: "second-session" } },
    };
    // burner + missCall drain the two recorded echo responses, so missCall2
    // is again a true miss.
    const second = await replaySession(
      [cassettePath, "--on-miss", "passthrough", "--", "node", TINY],
      [initFrame, initializedNote, burnerCall, missCall, missCall2]
    );
    expect(second.code).toBe(0);
    const liveIds = readCassette(cassettePath)
      .entries.filter((e) => e.type === "frame" && e.origin === "live" && e.dir === "c2s")
      .map((e) => ((e as { frame: { id?: unknown } }).frame.id));
    expect(liveIds).toEqual(["live-1", "live-2"]);

    // …and the grown cassette still pairs each request with its own response.
    const third = await replaySession([cassettePath], [initFrame, initializedNote, missCall, missCall2]);
    const first = third.out.find((f) => "id" in f && f.id === 7) as JsonRpcResponse;
    const secondHit = third.out.find((f) => "id" in f && f.id === 9) as JsonRpcResponse;
    expect(JSON.stringify(first.result)).toContain("echo:never-recorded");
    expect(JSON.stringify(secondHit.result)).toContain("echo:second-session");
  }, 30_000);

  it("passthrough exits 1 when the live server cannot be reached, and appends nothing", async () => {
    const cassettePath = path.join(tmpDir, "spy-broken.cassette.jsonl");
    await recordEchoSession(cassettePath);
    const entriesBefore = readCassette(cassettePath).entries.length;

    const { code, out, stderr } = await replaySession(
      [cassettePath, "--on-miss", "passthrough", "--", "no-such-binary-xyz"],
      [initFrame, initializedNote, burnerCall, missCall]
    );
    const miss = out.find((f) => "id" in f && f.id === 7) as JsonRpcResponse;
    expect(miss.error?.code).toBe(-32603);
    expect(miss.error?.message).toContain("passthrough to live server failed");
    expect(stderr).toContain("FAILED");
    expect(code).toBe(1);
    expect(readCassette(cassettePath).entries.length).toBe(entriesBefore);
  }, 30_000);

  it("passthrough keeps a redacted cassette redacted when appending live interactions", async () => {
    /** Shaped like GitHub PATs, valid nowhere. */
    const TOKEN_RECORDED = "ghp_NOTAREALTOKENUSEDINTESTSONLY000000";
    const TOKEN_LIVE = "ghp_NOTAREALTOKENUSEDINTESTSONLY111111";
    const secretsServer = [
      process.execPath,
      "-e",
      `process.env.TINY_SECRETS="1";import(${JSON.stringify(TINY)})`,
    ];

    // Record (redaction on by default) one leak call.
    const cassettePath = path.join(tmpDir, "spy-redacted.cassette.jsonl");
    const { client } = await MiniClient.connect({
      kind: "stdio",
      command: ["node", CLI, "record", "-o", cassettePath, "--", ...secretsServer],
    });
    await client.request("tools/call", { name: "leak", arguments: { token: TOKEN_RECORDED } });
    await client.close();
    await new Promise((r) => setTimeout(r, 400));

    // Burner exhausts the recorded leak response; the second call is a true
    // miss carrying a live token, forwarded to the real secrets server.
    const leakBurner: JsonRpcFrame = {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "leak", arguments: { token: "not-the-recorded-one" } },
    };
    const leakMiss: JsonRpcFrame = {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "leak", arguments: { token: TOKEN_LIVE } },
    };
    const { code, out } = await replaySession(
      [cassettePath, "--on-miss", "passthrough", "--", ...secretsServer],
      [initFrame, initializedNote, leakBurner, leakMiss]
    );
    expect(code).toBe(0);

    // The wire answer to the client carries the live server's real reply…
    const forwarded = out.find((f) => "id" in f && f.id === 7) as JsonRpcResponse;
    expect(JSON.stringify(forwarded.result)).toContain(`received:${TOKEN_LIVE}`);

    // …but the file gained only placeholders: passthrough must not be the
    // door through which raw secrets enter a redacted cassette.
    const onDisk = fs.readFileSync(cassettePath, "utf8");
    expect(onDisk).not.toContain(TOKEN_LIVE);
    expect(onDisk).not.toContain(TOKEN_RECORDED);
    const appended = readCassette(cassettePath).entries.filter(
      (e) => e.type === "frame" && e.origin === "live"
    );
    expect(appended).toHaveLength(2);
    expect(JSON.stringify(appended)).toContain("[REDACTED:");
  }, 30_000);
});
