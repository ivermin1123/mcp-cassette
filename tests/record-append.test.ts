/**
 * `record --mode append`: one cassette, more than one connection.
 *
 * A client that probes the server on a throwaway connection and then opens a
 * second one for the session spawns a recorder per connection, both pointed at
 * the same file. `--mode all` makes the second truncate the first, `--mode once`
 * makes it refuse to start, and `--mode append` makes both land in one cassette
 * that replays either connection. Every test here records with the repo's own
 * fixtures and replays offline; nothing reaches the network.
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { readCassette, type CassetteEntry } from "../src/cassette.js";
import { parseFrame, type JsonRpcFrame, type JsonRpcRequest, type JsonRpcResponse } from "../src/jsonrpc.js";
import { runRecord, type RecordMode } from "../src/record.js";

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "dist/cli.js");
const TINY = path.join(ROOT, "tests/fixtures/tiny-server.mjs");
const PUSHY = path.join(ROOT, "tests/fixtures/pushy-server.mjs");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cassette-append-"));
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const ask = (id: number | string, method: string, params: unknown = {}): JsonRpcRequest => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});

/** Run a stdio process, feed it these frames, and collect every frame it wrote. */
function drive(command: string[], frames: unknown[], settleMs = 500): Promise<{ out: JsonRpcFrame[]; err: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (err += c.toString("utf8")));
    for (const frame of frames) child.stdin.write(JSON.stringify(frame) + "\n");
    // Some of the last frames are pushed rather than answered, so there is no
    // reply to wait for: give the process a moment to say them.
    setTimeout(() => child.stdin.end(), settleMs);
    child.on("close", (code) => {
      const out = stdout
        .split("\n")
        .map((line) => parseFrame(line))
        .filter((f): f is JsonRpcFrame => f !== null);
      resolve({ out, err, code: code ?? 0 });
    });
  });
}

/** `record` spawns the server, so the era flag travels through a tiny wrapper. */
const modernPushy = (out: string, mode: string[] = []): string[] => [
  "node",
  CLI,
  "record",
  "-o",
  out,
  ...mode,
  "--",
  process.execPath,
  "-e",
  `process.env.PUSHY_ERA="modern";import(${JSON.stringify(PUSHY)})`,
];

const recordTiny = (out: string, mode: string[] = []): string[] => ["node", CLI, "record", "-o", out, ...mode, "--", "node", TINY];

const methodsOf = (frames: JsonRpcFrame[]) =>
  frames.map((f) => ("method" in f ? f.method : `#${String((f as { id: unknown }).id)}`));

const idsOf = (file: string, dir: "c2s" | "s2c" = "c2s") =>
  readCassette(file)
    .entries.filter((e) => e.type === "frame" && e.dir === dir)
    .map((e) => (e as { frame: { id?: unknown } }).frame.id);

const lint = (file: string) => spawnSync("node", [CLI, "lint", file], { encoding: "utf8" });

/** A hand-written stdio cassette, for the headers a recorder would never write itself. */
function handWritten(name: string, header: Record<string, unknown>, entries: CassetteEntry[] = []): string {
  const file = path.join(tmpDir, `${name}.cassette.jsonl`);
  const head = { type: "header", cassetteVersion: 2, recorder: "mcp-cassette@test", startedAt: "2026-10-08T00:00:00Z", ...header };
  fs.writeFileSync(file, [head, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n");
  return file;
}

describe("record --mode append", () => {
  it("creates the cassette, header and all, when the path holds none yet", async () => {
    const file = path.join(tmpDir, "fresh.cassette.jsonl");
    await drive(recordTiny(file, ["--mode", "append"]), [ask(1, "initialize", { protocolVersion: "2025-06-18" })]);

    const cassette = readCassette(file);
    expect(cassette.header.transport).toBe("stdio");
    expect(cassette.header.command).toEqual(["node", TINY]);
    // A first session owns its own ids: nothing is minted until there is a
    // header this session did not write.
    expect(idsOf(file)).toEqual([1]);
    expect(lint(file).status).toBe(0);
  }, 30_000);

  it("keeps both connections of a pinned modern session, and replays either one", async () => {
    const file = path.join(tmpDir, "pin-mode.cassette.jsonl");
    // Connection 1: the throwaway probe. Connection 2: the session, which opens
    // a subscription and makes the call that changes the tool list. Both start
    // at id 1, the way two connections of one client do.
    const probe = await drive(modernPushy(file, ["--mode", "append"]), [ask(1, "server/discover")]);
    expect(methodsOf(probe.out)).toEqual(["#1"]);
    const session = await drive(modernPushy(file, ["--mode", "append"]), [
      ask(1, "subscriptions/listen", { notifications: { toolsListChanged: true } }),
      ask(2, "tools/call", { name: "add_tool", arguments: { name: "extra" } }),
    ]);
    expect(methodsOf(session.out)).toEqual([
      "notifications/subscriptions/acknowledged",
      "#2",
      "notifications/tools/list_changed",
    ]);

    // One file, one header, both transcripts, and the appended connection's ids
    // minted so neither response can be paired with the other connection's
    // request.
    const cassette = readCassette(file);
    expect(cassette.entries.filter((e) => e.type === "frame")).toHaveLength(7);
    expect(idsOf(file)).toEqual([1, "live-1", "live-2"]);
    expect(lint(file).status).toBe(0);

    // The probe connection replays: its own answer, and no pretending that the
    // session connection's frames belong to it.
    const replayProbe = await drive(["node", CLI, "replay", file], [ask(9, "server/discover")]);
    const discovered = replayProbe.out.find((f) => "id" in f && f.id === 9) as JsonRpcResponse;
    expect(JSON.stringify(discovered.result)).toContain("2026-07-28");
    expect(replayProbe.code).toBe(0);

    // The session connection replays, acknowledgment and pushed change
    // included, each tagged with this client's own listen id.
    const replaySession = await drive(["node", CLI, "replay", file], [
      ask(5, "subscriptions/listen", { notifications: { toolsListChanged: true } }),
      ask(6, "tools/call", { name: "add_tool", arguments: { name: "extra" } }),
    ]);
    expect(methodsOf(replaySession.out)).toEqual([
      "notifications/subscriptions/acknowledged",
      "#6",
      "notifications/tools/list_changed",
    ]);
    const tagged = replaySession.out.filter((f) => "method" in f) as { params: { _meta: Record<string, unknown> } }[];
    expect(tagged.map((f) => f.params._meta["io.modelcontextprotocol/subscriptionId"])).toEqual([5, 5]);
    expect(replaySession.code).toBe(0);
  }, 60_000);

  it("pairs each connection's answer with its own request when both handshake at id 1", async () => {
    const file = path.join(tmpDir, "two-handshakes.cassette.jsonl");
    await drive(recordTiny(file, ["--mode", "append"]), [
      ask(1, "initialize", { protocolVersion: "2025-06-18" }),
      ask(2, "tools/call", { name: "echo", arguments: { message: "first" } }),
    ]);
    await drive(recordTiny(file, ["--mode", "append"]), [
      ask(1, "initialize", { protocolVersion: "2025-06-18" }),
      ask(2, "tools/call", { name: "slugify", arguments: { title: "Hello There" } }),
    ]);

    expect(idsOf(file)).toEqual([1, 2, "live-1", "live-2"]);
    expect(lint(file).status).toBe(0);

    // Each call is answered out of its own recording, not out of the one that
    // happened to share its id.
    const replayed = await drive(["node", CLI, "replay", file], [
      ask(7, "initialize", { protocolVersion: "2025-06-18" }),
      ask(8, "tools/call", { name: "echo", arguments: { message: "first" } }),
      ask(9, "tools/call", { name: "slugify", arguments: { title: "Hello There" } }),
    ]);
    const answer = (id: number) => replayed.out.find((f) => "id" in f && f.id === id) as JsonRpcResponse;
    expect(JSON.stringify(answer(8).result)).toContain("echo:first");
    expect(JSON.stringify(answer(9).result)).toContain("hello-there");
    expect(replayed.code).toBe(0);
  }, 60_000);

  it("stamps the appended frames on the file's own timeline, never back at zero", async () => {
    const file = path.join(tmpDir, "timeline.cassette.jsonl");
    await drive(recordTiny(file, ["--mode", "append"]), [ask(1, "initialize", {})]);
    const firstEnd = Math.max(...readCassette(file).entries.map((e) => e.t));
    await new Promise((r) => setTimeout(r, 150));
    await drive(recordTiny(file, ["--mode", "append"]), [ask(1, "tools/list")]);

    // Replay sorts the transcript by `t` when it decides where a
    // server-initiated frame belongs, so a second connection that restarted at
    // zero would be read as having happened first.
    const stamps = readCassette(file).entries.map((e) => e.t);
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
    expect(Math.min(...stamps.slice(2))).toBeGreaterThan(firstEnd);
  }, 60_000);

  it("mints past the ids a passthrough session already left behind", async () => {
    const file = path.join(tmpDir, "after-spy.cassette.jsonl");
    await drive(recordTiny(file, ["--mode", "append"]), [ask(1, "initialize", {})]);
    // A passthrough session appends a pair of its own, as `live-1`.
    await drive(
      ["node", CLI, "replay", file, "--on-miss", "passthrough", "--", "node", TINY],
      [ask(1, "initialize", {}), ask(2, "tools/call", { name: "echo", arguments: { message: "spied" } })]
    );
    expect(idsOf(file)).toEqual([1, "live-1"]);

    // The next append continues the one sequence rather than reusing `live-1`.
    await drive(recordTiny(file, ["--mode", "append"]), [ask(1, "tools/list")]);
    expect(idsOf(file)).toEqual([1, "live-1", "live-2"]);
    expect(lint(file).status).toBe(0);
  }, 60_000);

  it("keeps whole lines when two recorders overlap in time", async () => {
    const file = path.join(tmpDir, "overlap.cassette.jsonl");
    await drive(recordTiny(file, ["--mode", "append"]), [ask(1, "initialize", {})]);

    // Both sessions are open at once, and the second outlives the first.
    const first = drive(recordTiny(file, ["--mode", "append"]), [ask(1, "tools/list")], 300);
    const second = drive(recordTiny(file, ["--mode", "append"]), [ask(1, "ping")], 900);
    await Promise.all([first, second]);

    // Every line parses on its own, which is what an interleaved append would
    // have cost, and the two sessions hold different ids.
    const cassette = readCassette(file);
    expect(cassette.entries).toHaveLength(6);
    const appended = idsOf(file).filter((id) => typeof id === "string");
    expect(new Set(appended).size).toBe(appended.length);
    expect(lint(file).status).toBe(0);
  }, 60_000);

  it("opens a line of its own on a hand-edited cassette that ends without a newline", async () => {
    const file = handWritten(
      "no-trailing-newline",
      { transport: "stdio", command: ["node", TINY], redaction: { applied: true } },
      [{ type: "frame", t: 0, dir: "c2s", frame: ask(1, "ping") } as CassetteEntry]
    );
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/\n$/, ""));

    await drive(recordTiny(file, ["--mode", "append"]), [ask(1, "tools/list")]);
    // Every line still parses, which an append onto the last one would have cost.
    expect(readCassette(file).entries).toHaveLength(3);
    expect(lint(file).status).toBe(0);
  }, 30_000);

  it("appends nothing when the server command never starts, and keeps the cassette", () => {
    // The header names the same command this run tries to spawn, so the run
    // gets past the header check and dies on the spawn instead.
    const file = handWritten("no-server", {
      transport: "stdio",
      command: ["no-such-binary-xyz"],
      redaction: { applied: true },
    });
    const before = fs.readFileSync(file, "utf8");

    const failed = spawnSync("node", [CLI, "record", "-o", file, "--mode", "append", "--", "no-such-binary-xyz"], {
      encoding: "utf8",
    });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("failed to start server command");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  }, 30_000);

  it("creates no cassette when the server command never starts and the path held no file", async () => {
    // Driven through `runRecord` rather than the CLI: the CLI exits on the
    // rejection, and the rejection lands before the child's `close` event,
    // which is where a leftover header would be written.
    for (const mode of ["once", "all", "append"] as RecordMode[]) {
      const file = path.join(tmpDir, `never-started-${mode}.cassette.jsonl`);
      await expect(runRecord({ out: file, command: ["no-such-binary-xyz"], mode })).rejects.toThrow(
        "failed to start server command"
      );

      // The rejection is a microtask after the spawn error and the `close` is a
      // turn of the loop later, so the file gets that turn to appear before the
      // path is read. A leftover here is one the next run has to delete by hand.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(fs.existsSync(file)).toBe(false);
    }
  }, 30_000);
});

describe("record --mode append refuses a header it would contradict", () => {
  const refusal = (file: string, extra: string[] = []) =>
    spawnSync("node", [CLI, "record", "-o", file, "--mode", "append", ...extra, "--", "node", TINY], {
      encoding: "utf8",
    });

  it("refuses a cassette recorded over another transport", () => {
    const file = handWritten("http-target", { transport: "http", url: "http://127.0.0.1:3000/mcp", era: "legacy" });
    const before = fs.readFileSync(file, "utf8");
    const out = refusal(file);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("is a http recording and this session is a stdio one");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("refuses a cassette whose header names a different server command", () => {
    const file = handWritten("other-command", {
      transport: "stdio",
      command: ["node", "some-other-server.mjs"],
      redaction: { applied: true },
    });
    const out = refusal(file);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("the header names the one server that produced the file");
  });

  it("refuses to mix a redacted recording with an unredacted session", async () => {
    const file = path.join(tmpDir, "redacted.cassette.jsonl");
    await drive(recordTiny(file, ["--mode", "append"]), [ask(1, "initialize", {})]);
    const before = fs.readFileSync(file, "utf8");

    const out = refusal(file, ["--no-redact"]);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("replay matches on the redacted text");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  }, 30_000);

  it("refuses to record a handshake into a cassette that declares the modern era", () => {
    // Only a hand-edited header says `modern` on stdio, and `lint` errors on
    // one that does while the transcript holds an `initialize`. The session is
    // refused at the end, with the file exactly as it was.
    const file = handWritten("modern-stdio", {
      transport: "stdio",
      command: ["node", TINY],
      era: "modern",
      redaction: { applied: true },
    });
    const before = fs.readFileSync(file, "utf8");

    const out = spawnSync("node", [CLI, "record", "-o", file, "--mode", "append", "--", "node", TINY], {
      encoding: "utf8",
      input: JSON.stringify(ask(1, "initialize", { protocolVersion: "2025-06-18" })) + "\n",
    });
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("declares the modern era, which has no handshake");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(lint(file).status).toBe(0);
  }, 30_000);

  it("refuses a cassette whose last line was truncated, and says the file is as it was", () => {
    const file = handWritten(
      "truncated-tail",
      { transport: "stdio", command: ["node", TINY], redaction: { applied: true } },
      [{ type: "frame", t: 0, dir: "c2s", frame: ask(1, "ping") } as CassetteEntry]
    );
    // What a run killed mid-write leaves: a header that still parses and a last
    // line that does not.
    const whole = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, whole.slice(0, whole.length - 12));
    const before = fs.readFileSync(file, "utf8");

    const out = refusal(file);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain(`record --mode append: ${file} could not be read as a cassette`);
    expect(out.stderr).toContain("it was left untouched");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("refuses the mode on an HTTP recording, where one run already captures every connection", () => {
    const file = path.join(tmpDir, "http-append.cassette.jsonl");
    const out = spawnSync("node", [CLI, "record", "-o", file, "--mode", "append", "--http", "http://127.0.0.1:1/mcp"], {
      encoding: "utf8",
    });
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("record --mode append is for stdio recordings");
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("record --mode", () => {
  it("names append in its help and in the error for an unknown mode", () => {
    const help = spawnSync("node", [CLI, "record", "--help"], { encoding: "utf8" });
    expect(help.stdout).toContain("append");
    const bad = spawnSync("node", [CLI, "record", "-o", path.join(tmpDir, "x.jsonl"), "--mode", "sometimes", "--", "node", TINY], {
      encoding: "utf8",
    });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('unknown --mode "sometimes" (expected once, all or append)');
  });
});
