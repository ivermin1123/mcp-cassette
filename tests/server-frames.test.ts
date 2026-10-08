/**
 * Replaying what the server said on its own.
 *
 * A recorded change notification is not an answer to anything, so the only
 * question worth testing is *when* replay sends it. The position rule is one
 * sentence and every test here is a reading of it: a server-initiated frame
 * belongs right after the recorded answer that preceded it, and a frame whose
 * anchor the client never asks for is reported rather than emitted at some
 * convenient moment of replay's choosing.
 *
 * Both eras and both transports appear, because the two of them disagree about
 * where such a frame travels: the legacy era pushes it unsolicited (on stdio,
 * or on the standalone GET stream), while 2026-07-28 made the client ask for it
 * with `subscriptions/listen` and tag every frame with that request's id.
 */

import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  buildReplayIndex,
  diagnoseMiss,
  handleExchange,
  handleFrame,
  pendingServerFrames,
  reportServerFrames,
  SUBSCRIPTION_ID_KEY,
} from "../src/replay.js";
import { startHttpReplay } from "../src/http-replay.js";
import { readCassette, type Cassette, type CassetteEntry } from "../src/cassette.js";
import { parseFrame, type JsonRpcFrame, type JsonRpcRequest } from "../src/jsonrpc.js";

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "dist/cli.js");
const PUSHY = path.join(ROOT, "tests/fixtures/pushy-server.mjs");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cassette-serverframes-"));
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const ask = (id: number, method: string, params: unknown = {}): JsonRpcRequest => ({ jsonrpc: "2.0", id, method, params });
const CHANGED = { jsonrpc: "2.0" as const, method: "notifications/tools/list_changed" };

/** A hand-written stdio cassette: these tests are about position, not about the recorder. */
function stdioCassette(entries: CassetteEntry[], era: "legacy" | "modern" = "legacy"): Cassette {
  return {
    header: { type: "header", cassetteVersion: 2, recorder: "test", startedAt: "2026-10-08T00:00:00Z", transport: "stdio", era },
    entries: entries as Cassette["entries"],
  };
}
const c2s = (t: number, frame: unknown): CassetteEntry => ({ type: "frame", t, dir: "c2s", frame }) as CassetteEntry;
const s2c = (t: number, frame: unknown): CassetteEntry => ({ type: "frame", t, dir: "s2c", frame }) as CassetteEntry;

/**
 * Run a stdio process, feed it these frames, and collect every frame it wrote.
 * Nothing here is a client: the point is to see exactly what came back and in
 * what order, which a client would hide behind its own correlation.
 */
function drive(command: string[], frames: unknown[], settleMs = 500): Promise<{ out: JsonRpcFrame[]; err: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (err += c.toString("utf8")));
    for (const frame of frames) child.stdin.write(JSON.stringify(frame) + "\n");
    // The last frames are pushed, not answered, so there is no reply to wait
    // for: give the process a moment to say them before closing its input.
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

const methodsOf = (frames: JsonRpcFrame[]) => frames.map((f) => ("method" in f ? f.method : `#${String((f as { id: unknown }).id)}`));

/** Capture stderr for the duration of one call: what replay reports is asserted behavior. */
async function withStderr<T>(run: () => Promise<T>): Promise<[T, string]> {
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => (lines.push(String(chunk)), true)) as typeof process.stderr.write;
  try {
    return [await run(), lines.join("")];
  } finally {
    process.stderr.write = write;
  }
}

describe("the position rule", () => {
  const RECORDING = stdioCassette([
    c2s(0, ask(1, "tools/list")),
    s2c(1, { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "echo" }] } }),
    c2s(2, ask(2, "tools/call", { name: "add_tool", arguments: { name: "extra" } })),
    s2c(3, { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "installed" }] } }),
    s2c(4, CHANGED),
    c2s(5, ask(3, "resources/list")),
    s2c(6, { jsonrpc: "2.0", id: 3, result: { resources: [] } }),
  ]);

  it("sends a pushed notification right after the answer it followed, and not before", () => {
    const index = buildReplayIndex(RECORDING);

    // The recording pushed nothing after tools/list, so nothing follows it.
    expect(methodsOf(handleExchange(index, ask(90, "tools/list")))).toEqual(["#90"]);
    // It pushed the change right after this call was answered, so here it is.
    expect(methodsOf(handleExchange(index, ask(91, "tools/call", { name: "add_tool", arguments: { name: "extra" } })))).toEqual([
      "#91",
      "notifications/tools/list_changed",
    ]);
    expect(pendingServerFrames(index)).toBe(0);
  });

  it("reports a frame whose anchor the client never sends, instead of emitting it anyway", () => {
    const index = buildReplayIndex(RECORDING);
    // The client skips the call the change notification follows.
    expect(methodsOf(handleExchange(index, ask(90, "tools/list")))).toEqual(["#90"]);
    expect(methodsOf(handleExchange(index, ask(92, "resources/list")))).toEqual(["#92"]);
    expect(pendingServerFrames(index)).toBe(1);
  });

  it("keeps one answer per request for a recording whose server never spoke on its own", () => {
    const quiet = stdioCassette([
      c2s(0, ask(1, "tools/list")),
      s2c(1, { jsonrpc: "2.0", id: 1, result: { tools: [] } }),
    ]);
    const index = buildReplayIndex(quiet);
    expect(handleExchange(index, ask(7, "tools/list"))).toEqual([{ jsonrpc: "2.0", id: 7, result: { tools: [] } }]);
    expect(pendingServerFrames(index)).toBe(0);
  });

  it("sends a frame recorded while a request was outstanding before that request's answer", () => {
    // Progress for request 2, recorded between the request and its response.
    // Anchoring it to the previous answer would send a call's own progress
    // before the client has sent the call.
    const PROGRESS = { jsonrpc: "2.0" as const, method: "notifications/progress", params: { progressToken: "p", progress: 1 } };
    const index = buildReplayIndex(
      stdioCassette([
        c2s(0, ask(1, "tools/list")),
        s2c(1, { jsonrpc: "2.0", id: 1, result: { tools: [] } }),
        c2s(2, ask(2, "tools/call", { name: "slow", arguments: {} })),
        s2c(3, PROGRESS),
        s2c(4, { jsonrpc: "2.0", id: 2, result: { content: "done" } }),
      ])
    );
    expect(methodsOf(handleExchange(index, ask(90, "tools/list")))).toEqual(["#90"]);
    expect(methodsOf(handleExchange(index, ask(91, "tools/call", { name: "slow", arguments: {} })))).toEqual([
      "notifications/progress",
      "#91",
    ]);
  });

  it("does not let a request the server never answered hold later frames back", () => {
    // `block` is outstanding for the rest of the recording. It has no answer, so
    // nothing can be emitted before one, and the change notification keeps the
    // position it had: right after the call that produced it.
    const index = buildReplayIndex(
      stdioCassette([
        c2s(0, ask(1, "block")),
        c2s(1, ask(2, "tools/call", { name: "add_tool", arguments: {} })),
        s2c(2, { jsonrpc: "2.0", id: 2, result: { content: "ok" } }),
        s2c(3, CHANGED),
        c2s(4, ask(3, "tools/list")),
        s2c(5, { jsonrpc: "2.0", id: 3, result: { tools: [] } }),
      ])
    );
    expect(methodsOf(handleExchange(index, ask(90, "tools/call", { name: "add_tool", arguments: {} })))).toEqual([
      "#90",
      "notifications/tools/list_changed",
    ]);
  });

  it("anchors by the timestamps the recorder stamped, not by the order the entries were written", () => {
    // An HTTP recording writes a whole stream in one entry when the stream
    // closes, so file order puts its frames after requests they preceded.
    const PUSHED = { jsonrpc: "2.0" as const, method: "notifications/resources/updated", params: { uri: "file:///a" } };
    const cassette: Cassette = {
      header: { type: "header", cassetteVersion: 2, recorder: "test", startedAt: "2026-10-08T00:00:00Z", transport: "http", era: "legacy" },
      entries: [
        c2s(0, ask(1, "initialize")),
        s2c(1, { jsonrpc: "2.0", id: 1, result: {} }),
        c2s(6, ask(2, "tools/list")),
        s2c(7, { jsonrpc: "2.0", id: 2, result: { tools: [] } }),
        // Written last, stamped between the two exchanges above.
        { type: "chunks", t: 8, dir: "s2c", via: "get", chunks: [{ t: 3, frame: PUSHED }] },
      ] as Cassette["entries"],
    };
    const index = buildReplayIndex(cassette);
    expect(methodsOf(handleExchange(index, ask(90, "initialize")))).toEqual(["#90", "notifications/resources/updated"]);
    expect(methodsOf(handleExchange(index, ask(91, "tools/list")))).toEqual(["#91"]);
  });

  it("hangs a frame off the recording it belongs to, not off every recording of that fingerprint", () => {
    const twice = stdioCassette([
      c2s(0, ask(1, "tools/call", { name: "echo", arguments: { m: "x" } })),
      s2c(1, { jsonrpc: "2.0", id: 1, result: { content: "first" } }),
      c2s(2, ask(2, "tools/call", { name: "echo", arguments: { m: "x" } })),
      s2c(3, { jsonrpc: "2.0", id: 2, result: { content: "second" } }),
      s2c(4, CHANGED),
    ]);
    const index = buildReplayIndex(twice);
    const call = ask(50, "tools/call", { name: "echo", arguments: { m: "x" } });
    // The change followed the *second* recording, so the first call gets nothing.
    expect(methodsOf(handleExchange(index, call))).toEqual(["#50"]);
    expect(methodsOf(handleExchange(index, { ...call, id: 51 }))).toEqual(["#51", "notifications/tools/list_changed"]);
  });
});

describe("subscriptions/listen", () => {
  const LISTEN = ask(2, "subscriptions/listen", { notifications: { toolsListChanged: true } });
  const ACK = {
    jsonrpc: "2.0" as const,
    method: "notifications/subscriptions/acknowledged",
    params: { _meta: { [SUBSCRIPTION_ID_KEY]: 2 }, notifications: { toolsListChanged: true } },
  };
  const TAGGED = { jsonrpc: "2.0" as const, method: "notifications/tools/list_changed", params: { _meta: { [SUBSCRIPTION_ID_KEY]: 2 } } };
  const MODERN = stdioCassette(
    [
      c2s(0, ask(1, "server/discover")),
      s2c(1, { jsonrpc: "2.0", id: 1, result: { resultType: "complete", supportedVersions: ["2026-07-28"] } }),
      c2s(2, LISTEN),
      s2c(3, ACK),
      c2s(4, ask(3, "tools/call", { name: "add_tool", arguments: { name: "extra" } })),
      s2c(5, { jsonrpc: "2.0", id: 3, result: { resultType: "complete", content: [] } }),
      s2c(6, TAGGED),
    ],
    "modern"
  );

  it("is answered by its acknowledgment rather than missed, and never gets a JSON-RPC response", () => {
    const index = buildReplayIndex(MODERN);
    const out = handleExchange(index, { ...LISTEN, id: 77 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ method: "notifications/subscriptions/acknowledged" });
    expect(out[0]).not.toHaveProperty("id");
  });

  it("tags the acknowledgment and every later notification with the client's own subscription id", () => {
    const index = buildReplayIndex(MODERN);
    const [acknowledged] = handleExchange(index, { ...LISTEN, id: 77 });
    expect((acknowledged as { params: { _meta: Record<string, unknown> } }).params._meta[SUBSCRIPTION_ID_KEY]).toBe(77);

    const after = handleExchange(index, ask(78, "tools/call", { name: "add_tool", arguments: { name: "extra" } }));
    expect(methodsOf(after)).toEqual(["#78", "notifications/tools/list_changed"]);
    expect((after[1] as { params: { _meta: Record<string, unknown> } }).params._meta[SUBSCRIPTION_ID_KEY]).toBe(77);
  });

  it("replays the server's graceful closure as the subscription's last frame", () => {
    const closing = stdioCassette(
      [
        c2s(0, LISTEN),
        s2c(1, ACK),
        c2s(2, ask(3, "tools/list")),
        s2c(3, { jsonrpc: "2.0", id: 3, result: { resultType: "complete", tools: [] } }),
        s2c(4, { jsonrpc: "2.0", id: 2, result: { resultType: "complete", _meta: { [SUBSCRIPTION_ID_KEY]: 2 } } }),
      ],
      "modern"
    );
    const index = buildReplayIndex(closing);
    handleExchange(index, { ...LISTEN, id: 77 });
    const [, closure] = handleExchange(index, ask(78, "tools/list"));
    // The closure is the response to the listen request, so it carries the id
    // the client's own listen used, not the recording's.
    expect(closure).toMatchObject({ id: 77, result: { resultType: "complete", _meta: { [SUBSCRIPTION_ID_KEY]: 77 } } });
  });

  it("keeps two concurrent subscriptions apart, each tagged with its own client id", () => {
    const listenFor = (id: number, filter: Record<string, unknown>) => ask(id, "subscriptions/listen", { notifications: filter });
    const ackFor = (id: number, filter: Record<string, unknown>) => ({
      jsonrpc: "2.0" as const,
      method: "notifications/subscriptions/acknowledged",
      params: { _meta: { [SUBSCRIPTION_ID_KEY]: id }, notifications: filter },
    });
    const tools = { toolsListChanged: true };
    const resources = { resourcesListChanged: true };
    const two = stdioCassette(
      [
        c2s(0, listenFor(1, tools)),
        s2c(1, ackFor(1, tools)),
        c2s(2, listenFor(2, resources)),
        s2c(3, ackFor(2, resources)),
        c2s(4, ask(3, "tools/call", { name: "add_tool", arguments: { name: "extra" } })),
        s2c(5, { jsonrpc: "2.0", id: 3, result: { resultType: "complete", content: [] } }),
        s2c(6, { jsonrpc: "2.0", method: "notifications/tools/list_changed", params: { _meta: { [SUBSCRIPTION_ID_KEY]: 1 } } }),
        s2c(7, { jsonrpc: "2.0", method: "notifications/resources/list_changed", params: { _meta: { [SUBSCRIPTION_ID_KEY]: 2 } } }),
      ],
      "modern"
    );
    const index = buildReplayIndex(two);
    // The client picks its own ids, and in the other order.
    const [ackB] = handleExchange(index, listenFor(300, resources));
    const [ackA] = handleExchange(index, listenFor(400, tools));
    const meta = (f: JsonRpcFrame) => (f as { params: { _meta: Record<string, unknown> } }).params._meta[SUBSCRIPTION_ID_KEY];
    expect(meta(ackB!)).toBe(300);
    expect(meta(ackA!)).toBe(400);

    const after = handleExchange(index, ask(500, "tools/call", { name: "add_tool", arguments: { name: "extra" } }));
    expect(methodsOf(after)).toEqual(["#500", "notifications/tools/list_changed", "notifications/resources/list_changed"]);
    // Each notification names the subscription that asked for it, re-keyed to
    // the id that subscription's own listen request carried.
    expect(meta(after[1]!)).toBe(400);
    expect(meta(after[2]!)).toBe(300);
  });

  it("holds back a notification for a subscription this client never opened", () => {
    const index = buildReplayIndex(MODERN);
    // The client skips the listen and makes the call the change followed. The
    // recorded tag names a subscription it has never heard of, and a conforming
    // client correlates on exactly that tag, so the frame is held back.
    const out = handleExchange(index, ask(78, "tools/call", { name: "add_tool", arguments: { name: "extra" } }));
    expect(methodsOf(out)).toEqual(["#78"]);

    const said: string[] = [];
    reportServerFrames(index, 0, 0, (message) => said.push(message));
    expect(said.join("\n")).toContain("belong to a subscription this client never opened");
  });

  it("misses a listen the recording never held, and says so without inventing a stream", () => {
    const index = buildReplayIndex(stdioCassette([c2s(0, ask(1, "tools/list")), s2c(1, { jsonrpc: "2.0", id: 1, result: {} })]));
    const [out] = handleExchange(index, { ...LISTEN, id: 77 });
    expect(out).toMatchObject({ id: 77, error: { code: -32601 } });
  });
});

describe("a listen the recording holds but cannot serve", () => {
  const LISTEN = ask(2, "subscriptions/listen", { notifications: { toolsListChanged: true } });
  const ACK = {
    jsonrpc: "2.0" as const,
    method: "notifications/subscriptions/acknowledged",
    params: { _meta: { [SUBSCRIPTION_ID_KEY]: 2 }, notifications: { toolsListChanged: true } },
  };
  const ONE = stdioCassette([c2s(0, LISTEN), s2c(1, ACK), c2s(2, ask(3, "tools/list")), s2c(3, { jsonrpc: "2.0", id: 3, result: {} })], "modern");

  it("says the subscription is already open rather than that the method was never recorded", () => {
    const index = buildReplayIndex(ONE);
    handleExchange(index, { ...LISTEN, id: 77 });
    const diagnosis = diagnoseMiss(index, { ...LISTEN, id: 78 });
    expect(diagnosis).toContain("this exact subscription was recorded 1 time(s), and every one is already open");
    expect(diagnosis).not.toContain("no recorded request has method");
  });

  it("names the filter that drifted rather than the method, when the client asks for other notifications", () => {
    const index = buildReplayIndex(ONE);
    const diagnosis = diagnoseMiss(index, ask(77, "subscriptions/listen", { notifications: { resourcesListChanged: true } }));
    expect(diagnosis).toContain("/notifications/toolsListChanged");
    expect(diagnosis).not.toContain("no recorded request has method");
  });
});

describe("handleFrame", () => {
  it("returns the answer, not a frame the recording put in front of it", () => {
    const PROGRESS = { jsonrpc: "2.0" as const, method: "notifications/progress", params: { progressToken: "p", progress: 1 } };
    const index = buildReplayIndex(
      stdioCassette([
        c2s(0, ask(1, "tools/call", { name: "slow", arguments: {} })),
        s2c(1, PROGRESS),
        s2c(2, { jsonrpc: "2.0", id: 1, result: { content: "done" } }),
      ])
    );
    // The single-frame API means "the frame to send back", and a cassette that
    // happens to carry progress must not turn that into a notification.
    expect(handleFrame(index, ask(90, "tools/call", { name: "slow", arguments: {} }))).toMatchObject({
      id: 90,
      result: { content: "done" },
    });
  });

  it("returns the acknowledgment for a recorded listen", () => {
    const LISTEN = ask(1, "subscriptions/listen", { notifications: { toolsListChanged: true } });
    const index = buildReplayIndex(
      stdioCassette(
        [
          c2s(0, LISTEN),
          s2c(1, {
            jsonrpc: "2.0",
            method: "notifications/subscriptions/acknowledged",
            params: { _meta: { [SUBSCRIPTION_ID_KEY]: 1 }, notifications: { toolsListChanged: true } },
          }),
        ],
        "modern"
      )
    );
    expect(handleFrame(index, { ...LISTEN, id: 55 })).toMatchObject({
      method: "notifications/subscriptions/acknowledged",
      params: { _meta: { [SUBSCRIPTION_ID_KEY]: 55 } },
    });
  });
});

describe("a recorded request the server never answered", () => {
  const CUT_SHORT = stdioCassette([
    c2s(0, ask(1, "tools/list")),
    s2c(1, { jsonrpc: "2.0", id: 1, result: { tools: [] } }),
    c2s(2, ask(2, "tools/call", { name: "slow", arguments: { n: 1 } })),
  ]);

  it("is diagnosed as recorded-but-unanswered, not as a method nobody recorded", () => {
    const index = buildReplayIndex(CUT_SHORT);
    const diagnosis = diagnoseMiss(index, ask(9, "tools/call", { name: "slow", arguments: { n: 1 } }));
    expect(diagnosis).toContain("this exact request was recorded");
    expect(diagnosis).toContain("the recording holds no response for it");
    expect(diagnosis).not.toContain("no recorded request has method");
  });

  it("names the method as recorded when another call of it drifted, instead of calling it unknown", () => {
    const index = buildReplayIndex(CUT_SHORT);
    const diagnosis = diagnoseMiss(index, ask(9, "tools/call", { name: "slow", arguments: { n: 2 } }));
    expect(diagnosis).toContain('"tools/call" was recorded, but no recording of it holds a response');
  });

  it("holds a listen the recording never acknowledged open, rather than calling it a miss", () => {
    const index = buildReplayIndex(
      stdioCassette([c2s(0, ask(1, "subscriptions/listen", { notifications: {} }))], "modern")
    );
    // The recorded server said nothing to this listen. Replay says nothing
    // either: the request stays open, exactly as the recording left it.
    expect(handleExchange(index, ask(9, "subscriptions/listen", { notifications: {} }))).toEqual([]);
  });
});

describe("the legacy era over stdio, end to end", () => {
  it("records an unsolicited list_changed and replays it after the call it followed", async () => {
    const cassettePath = path.join(tmpDir, "legacy.cassette.jsonl");
    const session = [
      ask(1, "initialize", { protocolVersion: "2025-06-18" }),
      ask(2, "tools/list"),
      ask(3, "tools/call", { name: "add_tool", arguments: { name: "extra" } }),
    ];

    const recorded = await drive(["node", CLI, "record", "-o", cassettePath, "--", "node", PUSHY], session);
    expect(methodsOf(recorded.out)).toEqual(["#1", "#2", "#3", "notifications/tools/list_changed"]);

    const cassette = readCassette(cassettePath);
    const pushedFrames = cassette.entries.filter(
      (e) => e.type === "frame" && e.dir === "s2c" && "method" in e.frame
    );
    expect(pushedFrames).toHaveLength(1);

    const replayed = await drive(["node", CLI, "replay", cassettePath], session);
    expect(methodsOf(replayed.out)).toEqual(["#1", "#2", "#3", "notifications/tools/list_changed"]);
    expect(replayed.code).toBe(0);
    expect(replayed.err).toContain("1 server-initiated frame(s) replayed at their recorded position");
    // The old refusal is gone: this frame is replayed, so nothing claims it is not.
    expect(replayed.err).not.toContain("are not replayed");
  }, 30_000);

  it("reports the pushed frame instead of emitting it when the client skips the call it followed", async () => {
    const cassettePath = path.join(tmpDir, "legacy-skipped.cassette.jsonl");
    await drive(
      ["node", CLI, "record", "-o", cassettePath, "--", "node", PUSHY],
      [ask(1, "initialize", {}), ask(2, "tools/call", { name: "add_tool", arguments: { name: "extra" } })]
    );

    const replayed = await drive(["node", CLI, "replay", cassettePath], [ask(1, "initialize", {})]);
    expect(methodsOf(replayed.out)).toEqual(["#1"]);
    expect(replayed.err).toContain("the client never sent the request each one follows");
  }, 30_000);
});

describe("the modern era over stdio, end to end", () => {
  it("acknowledges a recorded listen, holds it open, and pushes the change at its recorded position", async () => {
    const cassettePath = path.join(tmpDir, "modern.cassette.jsonl");
    const session = [
      ask(1, "server/discover"),
      ask(2, "subscriptions/listen", { notifications: { toolsListChanged: true } }),
      ask(3, "tools/call", { name: "add_tool", arguments: { name: "extra" } }),
    ];
    const record = spawnPushy(cassettePath);
    const recorded = await drive(record, session);
    expect(methodsOf(recorded.out)).toEqual([
      "#1",
      "notifications/subscriptions/acknowledged",
      "#3",
      "notifications/tools/list_changed",
    ]);

    // The listen request is in the cassette with no response of its own: this is
    // exactly the shape that used to be a miss.
    const cassette = readCassette(cassettePath);
    const answers = cassette.entries.filter((e) => e.type === "frame" && e.dir === "s2c" && !("method" in e.frame));
    expect(answers.map((e) => String((e as { frame: { id: unknown } }).frame.id))).toEqual(["1", "3"]);

    const replayed = await drive(["node", CLI, "replay", cassettePath], session.map((f, i) => ({ ...f, id: 100 + i })));
    expect(methodsOf(replayed.out)).toEqual([
      "#100",
      "notifications/subscriptions/acknowledged",
      "#102",
      "notifications/tools/list_changed",
    ]);
    expect(replayed.code).toBe(0); // the listen is answered by its acknowledgment, so nothing missed
    expect(replayed.err).toContain("1 subscription(s) acknowledged and held open");

    const tagged = replayed.out.filter((f) => "method" in f) as { params: { _meta: Record<string, unknown> } }[];
    // Both frames name the client's listen id (101), never the recording's (2).
    expect(tagged.map((f) => f.params._meta[SUBSCRIPTION_ID_KEY])).toEqual([101, 101]);
  }, 30_000);

  function spawnPushy(cassettePath: string): string[] {
    // `record` spawns the server, so the era flag travels through a tiny wrapper
    // rather than through a Target field that does not exist.
    return [
      "node",
      CLI,
      "record",
      "-o",
      cassettePath,
      "--",
      process.execPath,
      "-e",
      `process.env.PUSHY_ERA="modern";import(${JSON.stringify(PUSHY)})`,
    ];
  }
});

describe("the legacy standalone stream opened late", () => {
  const PUSHED = { jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri: "file:///config.json" } };

  /** One `initialize`, answered, and one frame the server pushed after it on the GET stream. */
  function standaloneCassette(name: string): string {
    const file = path.join(tmpDir, `${name}.cassette.jsonl`);
    const head = {
      type: "header",
      cassetteVersion: 2,
      recorder: "mcp-cassette@test",
      startedAt: "2026-10-08T00:00:00Z",
      transport: "http",
      era: "legacy",
    };
    const entries: CassetteEntry[] = [
      c2s(0, ask(1, "initialize")),
      s2c(1, { jsonrpc: "2.0", id: 1, result: {} }),
      { type: "chunks", t: 2, dir: "s2c", via: "get", chunks: [{ t: 2, frame: PUSHED }] } as CassetteEntry,
    ];
    fs.writeFileSync(file, [head, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n");
    return file;
  }

  it("says so when an untagged frame comes due and nobody ever opened the stream", async () => {
    const file = standaloneCassette("get-never-opened");
    const [, stderr] = await withStderr(async () => {
      const server = await startHttpReplay(file, { listen: "127.0.0.1:0" });
      // The anchor is answered, so the frame is due, and the GET endpoint it
      // belongs on was never opened: it waits, and the session says so.
      await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ask(9, "initialize")),
      }).then((r) => r.text());
      await server.close();
    });
    expect(stderr).toContain("came due with no stream open to carry them");
  }, 20_000);

  it("delivers what is already due the moment the client connects", async () => {
    const file = standaloneCassette("late-get");
    const server = await startHttpReplay(file, { listen: "127.0.0.1:0" });
    // The anchor is answered before the stream exists, so the frame is waiting
    // rather than lost: this is the position it has in *this* session.
    const url = server.url;
    await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ask(9, "initialize")) }).then((r) => r.text());
    const stream = await fetch(url, { method: "GET", headers: { accept: "text/event-stream" } });
    const chunk = await stream.body!.getReader().read();
    expect(new TextDecoder().decode(chunk.value)).toContain('"notifications/resources/updated"');
    await server.close();
  }, 20_000);
});

describe("the modern era over HTTP", () => {
  const LISTEN = ask(2, "subscriptions/listen", { notifications: { toolsListChanged: true } });
  const TAGGED = { jsonrpc: "2.0", method: "notifications/tools/list_changed", params: { _meta: { [SUBSCRIPTION_ID_KEY]: 2 } } };
  const ENTRIES: CassetteEntry[] = [
    c2s(0, ask(1, "server/discover")),
    s2c(1, { jsonrpc: "2.0", id: 1, result: { resultType: "complete", supportedVersions: ["2026-07-28"] } }),
    c2s(2, LISTEN),
    {
      type: "chunks",
      t: 3,
      dir: "s2c",
      id: 2,
      chunks: [
        { t: 3, frame: { jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged", params: { _meta: { [SUBSCRIPTION_ID_KEY]: 2 }, notifications: { toolsListChanged: true } } } },
        // Stamped where the wire put them: after the call that changed the tool
        // list, and after the next answer, not where the stream entry sits.
        { t: 6, frame: TAGGED },
        { t: 9, frame: { jsonrpc: "2.0", id: 2, result: { resultType: "complete", _meta: { [SUBSCRIPTION_ID_KEY]: 2 } } } },
      ],
    } as CassetteEntry,
    c2s(4, ask(3, "tools/call", { name: "add_tool", arguments: { name: "extra" } })),
    s2c(5, { jsonrpc: "2.0", id: 3, result: { resultType: "complete", content: [] } }),
    c2s(7, ask(4, "tools/list")),
    s2c(8, { jsonrpc: "2.0", id: 4, result: { resultType: "complete", tools: [] } }),
  ];

  function cassetteFile(name: string): string {
    const file = path.join(tmpDir, `${name}.cassette.jsonl`);
    const head = {
      type: "header",
      cassetteVersion: 2,
      recorder: "mcp-cassette@test",
      startedAt: "2026-10-08T00:00:00Z",
      transport: "http",
      era: "modern",
    };
    fs.writeFileSync(file, [head, ...ENTRIES].map((e) => JSON.stringify(e)).join("\n") + "\n");
    return file;
  }

  const post = (url: string, body: unknown) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  /** One SSE `data:` payload at a time, so arrival order is observed rather than inferred. */
  function reader(res: Response) {
    const stream = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    return {
      async next(): Promise<unknown | null> {
        for (;;) {
          const split = buffer.indexOf("\n\n");
          if (split !== -1) {
            const event = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            return JSON.parse(event.replace(/^data: /, ""));
          }
          const { done, value } = await stream.read();
          if (done) return null;
          buffer += decoder.decode(value, { stream: true });
        }
      },
    };
  }

  it("answers the listen with its acknowledgment, holds the stream, and feeds it at the recorded positions", async () => {
    const server = await startHttpReplay(cassetteFile("modern-http"), { listen: "127.0.0.1:0" });
    const opened = await post(server.url, { ...LISTEN, id: 77 });

    expect(opened.status).toBe(200);
    expect(opened.headers.get("content-type")).toBe("text/event-stream");
    const read = reader(opened);
    expect(await read.next()).toMatchObject({
      method: "notifications/subscriptions/acknowledged",
      params: { _meta: { [SUBSCRIPTION_ID_KEY]: 77 } },
    });

    // Nothing more yet: the change notification waits for the call it followed.
    const next = read.next();
    expect(await Promise.race([next, new Promise((r) => setTimeout(() => r("nothing yet"), 100))])).toBe("nothing yet");

    const called = await post(server.url, ask(78, "tools/call", { name: "add_tool", arguments: { name: "extra" } }));
    expect(JSON.parse(await called.text())).toMatchObject({ id: 78 });
    expect(await next).toMatchObject({ method: "notifications/tools/list_changed", params: { _meta: { [SUBSCRIPTION_ID_KEY]: 77 } } });

    // The recorded graceful closure follows the next answer, and ends the stream.
    await post(server.url, ask(79, "tools/list")).then((r) => r.text());
    expect(await read.next()).toMatchObject({ id: 77, result: { resultType: "complete" } });
    expect(await read.next()).toBeNull();

    await server.close();
    expect(server.misses()).toBe(0);
  }, 20_000);

  it("feeds two open subscriptions their own notifications and nothing else", async () => {
    const file = path.join(tmpDir, "two-subs.cassette.jsonl");
    const listenFor = (id: number, filter: Record<string, unknown>) => ask(id, "subscriptions/listen", { notifications: filter });
    const stream = (id: number, filter: Record<string, unknown>, method: string, at: number): CassetteEntry =>
      ({
        type: "chunks",
        t: at,
        dir: "s2c",
        id,
        chunks: [
          { t: at, frame: { jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged", params: { _meta: { [SUBSCRIPTION_ID_KEY]: id }, notifications: filter } } },
          { t: 9, frame: { jsonrpc: "2.0", method, params: { _meta: { [SUBSCRIPTION_ID_KEY]: id } } } },
        ],
      }) as CassetteEntry;
    const head = {
      type: "header",
      cassetteVersion: 2,
      recorder: "mcp-cassette@test",
      startedAt: "2026-10-08T00:00:00Z",
      transport: "http",
      era: "modern",
    };
    const entries: CassetteEntry[] = [
      c2s(0, listenFor(1, { toolsListChanged: true })),
      stream(1, { toolsListChanged: true }, "notifications/tools/list_changed", 1),
      c2s(2, listenFor(2, { resourcesListChanged: true })),
      stream(2, { resourcesListChanged: true }, "notifications/resources/list_changed", 3),
      c2s(4, ask(3, "tools/call", { name: "add_tool", arguments: { name: "extra" } })),
      s2c(8, { jsonrpc: "2.0", id: 3, result: { resultType: "complete", content: [] } }),
    ];
    fs.writeFileSync(file, [head, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n");

    const server = await startHttpReplay(file, { listen: "127.0.0.1:0" });
    const toolsStream = reader(await post(server.url, listenFor(900, { toolsListChanged: true })));
    const resourcesStream = reader(await post(server.url, listenFor(800, { resourcesListChanged: true })));
    expect(await toolsStream.next()).toMatchObject({ params: { _meta: { [SUBSCRIPTION_ID_KEY]: 900 } } });
    expect(await resourcesStream.next()).toMatchObject({ params: { _meta: { [SUBSCRIPTION_ID_KEY]: 800 } } });

    await post(server.url, ask(78, "tools/call", { name: "add_tool", arguments: { name: "extra" } })).then((r) => r.text());
    // Each stream gets its own notification, tagged with the id its own listen
    // request carried. A stream that got the other one would be lying.
    expect(await toolsStream.next()).toMatchObject({
      method: "notifications/tools/list_changed",
      params: { _meta: { [SUBSCRIPTION_ID_KEY]: 900 } },
    });
    expect(await resourcesStream.next()).toMatchObject({
      method: "notifications/resources/list_changed",
      params: { _meta: { [SUBSCRIPTION_ID_KEY]: 800 } },
    });

    await server.close();
    expect(server.misses()).toBe(0);
  }, 20_000);

  it("holds back a notification for a subscription nobody opened, and names that reason", async () => {
    const [server, stderr] = await withStderr(async () => {
      const s = await startHttpReplay(cassetteFile("modern-http-nostream"), { listen: "127.0.0.1:0" });
      // The call that the change notification follows, with nobody listening.
      await post(s.url, ask(78, "tools/call", { name: "add_tool", arguments: { name: "extra" } })).then((r) => r.text());
      await s.close();
      return s;
    });
    expect(server.misses()).toBe(0);
    expect(stderr).toContain("belong to a subscription this client never opened");
  }, 20_000);

  it("holds nothing hostage: a session with an open subscription still closes", async () => {
    const server = await startHttpReplay(cassetteFile("modern-http-close"), { listen: "127.0.0.1:0" });
    const opened = await post(server.url, { ...LISTEN, id: 5 });
    await reader(opened).next();
    await expect(server.close()).resolves.toBeUndefined();
  }, 20_000);
});
