/**
 * Replaying a session that used the `io.modelcontextprotocol/tasks` extension.
 *
 * A task is the one thing in the protocol whose answer is a sequence rather
 * than a value: the server hands back a handle, and the client polls `tasks/get`
 * until the status is terminal. Every poll for one task carries the same params,
 * so they share a fingerprint and come out of one pool in recorded order. That
 * means the interval the client polls at never matters, and the only question
 * worth testing is what happens at the two ends of the recorded sequence: a poll
 * after the recording's last one, and a recording that stopped before the task
 * finished.
 *
 * `notifications/tasks` is deliberately not a path of its own here. It is a
 * server-initiated notification on a `subscriptions/listen` stream, so it is
 * replayed by the same anchoring the rest of them are, and the tests below
 * assert exactly that rather than a second mechanism.
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
  SUBSCRIPTION_ID_KEY,
  TASK_NOTIFICATION_METHOD,
} from "../src/replay.js";
import { startHttpReplay } from "../src/http-replay.js";
import { classifyPair, collectVerifyPairs, normalizeForDiff } from "../src/verify.js";
import { readCassette, type Cassette, type CassetteEntry } from "../src/cassette.js";
import { parseFrame, type JsonRpcFrame, type JsonRpcRequest, type JsonRpcResponse } from "../src/jsonrpc.js";

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "dist/cli.js");
const TASKING = path.join(ROOT, "tests/fixtures/tasking-server.mjs");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cassette-tasks-"));
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const TASK_ID = "task-0001";
const ask = (id: number, method: string, params: unknown = {}): JsonRpcRequest => ({ jsonrpc: "2.0", id, method, params });
const poll = (id: number, taskId = TASK_ID) => ask(id, "tasks/get", { taskId });
const c2s = (t: number, frame: unknown): CassetteEntry => ({ type: "frame", t, dir: "c2s", frame }) as CassetteEntry;
const s2c = (t: number, frame: unknown): CassetteEntry => ({ type: "frame", t, dir: "s2c", frame }) as CassetteEntry;

const STAMPS = { createdAt: "2026-10-08T00:00:00Z", lastUpdatedAt: "2026-10-08T00:00:00Z", ttlMs: 60000, pollIntervalMs: 50 };
/** One `tasks/get` answer, in the shape the extension defines. */
const state = (id: number, status: string, extra: Record<string, unknown> = {}): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  result: { resultType: "complete", taskId: TASK_ID, status, ...STAMPS, ...extra },
});

function cassette(entries: CassetteEntry[]): Cassette {
  return {
    header: { type: "header", cassetteVersion: 2, recorder: "test", startedAt: "2026-10-08T00:00:00Z", transport: "stdio", era: "modern" },
    entries: entries as Cassette["entries"],
  };
}

/** A recording of N polls, the last of them carrying `final`. */
function polled(final: string, extra: Record<string, unknown> = {}, before = ["working", "working"]): Cassette {
  const entries: CassetteEntry[] = [];
  let t = 0;
  before.forEach((status, i) => {
    entries.push(c2s(t++, poll(10 + i)), s2c(t++, state(10 + i, status, { statusMessage: `poll ${i + 1}` })));
  });
  const last = 10 + before.length;
  entries.push(c2s(t++, poll(last)), s2c(t++, state(last, final, extra)));
  return cassette(entries);
}

const statusOf = (frame: JsonRpcFrame | null) => (frame as { result?: { status?: string } } | null)?.result?.status;

const HTTP_HEAD = {
  type: "header",
  cassetteVersion: 2,
  recorder: "mcp-cassette@test",
  startedAt: "2026-10-08T00:00:00Z",
  transport: "http",
  era: "modern",
};

/** An HTTP cassette on disk, ready for `startHttpReplay`. */
function httpCassette(name: string, entries: CassetteEntry[]): string {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, [HTTP_HEAD, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n");
  return file;
}

/** A streamed answer: what a `chunks` entry holds for one request the server answered as SSE. */
const stream = (t: number, id: number, frames: unknown[]): CassetteEntry =>
  ({ type: "chunks", t, dir: "s2c", id, chunks: frames.map((frame, i) => ({ t: i, frame })) }) as CassetteEntry;

/** `polled`, with every answer streamed: the shape an SDK server over HTTP records by default. */
function streamedPolls(final: string, extra: Record<string, unknown> = {}, before = ["working", "working"]): CassetteEntry[] {
  const entries: CassetteEntry[] = [];
  let t = 0;
  before.forEach((status, i) => {
    entries.push(c2s(t++, poll(10 + i)), stream(t++, 10 + i, [state(10 + i, status, { statusMessage: `poll ${i + 1}` })]));
  });
  const last = 10 + before.length;
  entries.push(c2s(t++, poll(last)), stream(t++, last, [state(last, final, extra)]));
  return entries;
}

const postTo = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Run a stdio process, feed it these frames, and collect every frame it wrote. */
function drive(command: string[], frames: unknown[], settleMs = 500): Promise<{ out: JsonRpcFrame[]; err: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (err += c.toString("utf8")));
    for (const frame of frames) child.stdin.write(JSON.stringify(frame) + "\n");
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

describe("polling a recorded task", () => {
  it("serves the recorded states in order, whatever the client's interval", () => {
    const index = buildReplayIndex(polled("completed", { result: { content: [{ type: "text", text: "built" }] } }));
    // Three polls, three states, in the order the recording holds them. Nothing
    // here depends on wall time: the pool is consumed, not scheduled.
    expect([90, 91, 92].map((id) => statusOf(handleFrame(index, poll(id))))).toEqual(["working", "working", "completed"]);
  });

  it("answers every poll a client that stops early does send", () => {
    const index = buildReplayIndex(polled("completed"));
    expect(statusOf(handleFrame(index, poll(90)))).toBe("working");
    // The client walked away with one recording unused. That is a client that
    // lost interest, not a session that went wrong, so nothing here is a miss.
    expect(handleFrame(index, poll(91))).toMatchObject({ result: { status: "working" } });
  });

  it("serves the terminal answer again for every poll past the recording", () => {
    const completed = { result: { content: [{ type: "text", text: "built" }], isError: false } };
    const index = buildReplayIndex(polled("completed", completed));
    for (const id of [90, 91, 92]) handleFrame(index, poll(id));

    // A task that finished is still finished, so the answer does not run out.
    for (const id of [93, 94, 95]) {
      expect(handleFrame(index, poll(id))).toMatchObject({ id, result: { status: "completed", ...completed } });
    }
  });

  it("treats failed and cancelled as terminal too", () => {
    for (const status of ["failed", "cancelled"]) {
      const index = buildReplayIndex(polled(status, status === "failed" ? { error: { code: -32000, message: "boom" } } : {}));
      for (const id of [90, 91, 92]) handleFrame(index, poll(id));
      expect(handleFrame(index, poll(93))).toMatchObject({ id: 93, result: { status } });
    }
  });

  it("answers a task id the client kept across its own restart, as long as replay kept running", () => {
    const index = buildReplayIndex(polled("completed"));
    for (const id of [90, 91, 92, 93]) handleFrame(index, poll(id));
    // The client went away and came back holding only the id. Replay still
    // holds the spent pool, so the finished task still reads finished.
    expect(statusOf(handleFrame(index, poll(94)))).toBe("completed");
    // Replay restarting too is a different thing, and the honest one to pin: a
    // fresh session has every recorded poll left, so the same id reads the
    // recorded sequence from its start rather than from its end.
    expect(statusOf(handleFrame(buildReplayIndex(polled("completed")), poll(95)))).toBe("working");
  });
});

describe("a recording that stopped before the task finished", () => {
  const STALLED = polled("working", { statusMessage: "still building" });

  it("misses the extra poll and names the task in the reason", () => {
    const index = buildReplayIndex(STALLED);
    for (const id of [90, 91, 92]) handleFrame(index, poll(id));

    const out = handleFrame(index, poll(93))!;
    expect(out).toMatchObject({ id: 93, error: { code: -32601 } });
    const diagnosis = diagnoseMiss(index, poll(94));
    expect(diagnosis).toContain(`task "${TASK_ID}"`);
    expect(diagnosis).toContain('status "working", which is not terminal');
    expect(diagnosis).toContain("3 poll(s)");
    // The generic "every recorded response was already consumed" would be true
    // and useless: it would not say that re-recording has to run longer.
    expect(diagnosis).not.toContain("every recorded response");
  });

  it("still serves every poll the recording does hold", () => {
    const index = buildReplayIndex(STALLED);
    expect([90, 91, 92].map((id) => statusOf(handleFrame(index, poll(id))))).toEqual(["working", "working", "working"]);
  });

  it("never lends another task's state to a poll, under warn either", () => {
    const OTHER = "task-0002";
    const index = buildReplayIndex(
      cassette([
        c2s(0, poll(1)),
        s2c(1, state(1, "working")),
        c2s(2, poll(2, OTHER)),
        s2c(3, state(2, "completed", { taskId: OTHER })),
      ])
    );
    expect(statusOf(handleFrame(index, poll(90), "warn"))).toBe("working");
    // The only recording left is an answer about a different task. Handing it
    // over would tell this client its own task finished, which it did not.
    expect(handleFrame(index, poll(91), "warn")).toMatchObject({ error: { code: -32601 } });
  });

  it("leaves a task whose answers carry no readable status to the ordinary pool", () => {
    // A server that answered a poll with an error said nothing about whether
    // the task finished, so replay claims nothing about it either.
    const index = buildReplayIndex(
      cassette([c2s(0, poll(1)), s2c(1, { jsonrpc: "2.0", id: 1, error: { code: -32002, message: "task not found" } })])
    );
    expect(handleFrame(index, poll(90))).toMatchObject({ error: { code: -32002 } });
    expect(diagnoseMiss(index, poll(91))).toContain("every recorded response");
  });
});

describe("a task whose polls the server answered as a stream", () => {
  // Over HTTP an answer arrives as SSE unless the server was configured to send
  // JSON, which is not the default, so this is the ordinary shape of a recorded
  // poll rather than a corner of the format. The rule has to reach it.
  const frameOf = async (res: Response) => JSON.parse((await res.text()).replace(/^data: /, "").trim());

  it("serves the terminal answer again, still streamed, for every poll past the recording", async () => {
    const file = httpCassette("tasks-streamed.cassette.jsonl", streamedPolls("completed", { result: { content: [] } }));
    const server = await startHttpReplay(file, { listen: "127.0.0.1:0" });

    const seen: string[] = [];
    for (const id of [50, 51, 52, 53, 54]) {
      const res = await postTo(server.url, poll(id));
      // The recording answered this poll by streaming, so replay does too: a
      // client that negotiated SSE is not handed a different shape at the end.
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      const frame = await frameOf(res);
      expect(frame.id).toBe(id);
      seen.push(frame.result.status);
    }
    expect(seen).toEqual(["working", "working", "completed", "completed", "completed"]);

    await server.close();
    expect(server.misses()).toBe(0);
  }, 20_000);

  it("misses the poll past a streamed recording that stopped while the task was working", async () => {
    const file = httpCassette("tasks-streamed-stalled.cassette.jsonl", streamedPolls("working"));
    const server = await startHttpReplay(file, { listen: "127.0.0.1:0" });

    for (const id of [50, 51, 52]) await postTo(server.url, poll(id)).then((r) => r.text());
    const extra = await postTo(server.url, poll(53));
    expect(await extra.json()).toMatchObject({ id: 53, error: { code: -32601 } });

    // Not "the stream pool is spent", which would send the reader looking for a
    // transport problem: the recording simply never saw this task finish.
    const [miss] = server.takeMisses();
    expect(miss!.reason).toMatchObject({ kind: "task-not-terminal", taskId: TASK_ID, status: "working", recordedPolls: 3 });

    await server.close();
    expect(server.misses()).toBe(1);
  }, 20_000);
});

describe("tasks/update and tasks/cancel", () => {
  const INPUT_REQUESTS = { confirm: { method: "elicitation/create", params: { message: "Deploy?" } } };
  const accept = (id: number, input: string) =>
    ask(id, "tasks/update", { taskId: TASK_ID, inputResponses: { confirm: { action: "accept", content: { input } } } });

  const WITH_INPUT = cassette([
    c2s(0, poll(1)),
    s2c(1, state(1, "input_required", { inputRequests: INPUT_REQUESTS })),
    c2s(2, accept(2, "production")),
    s2c(3, { jsonrpc: "2.0", id: 2, result: { resultType: "complete" } }),
    c2s(4, poll(3)),
    s2c(5, state(3, "completed", { result: { content: [{ type: "text", text: "deployed" }] } })),
  ]);

  it("replays an input the client gave, and the state that followed it", () => {
    const index = buildReplayIndex(WITH_INPUT);
    expect(handleFrame(index, poll(90))).toMatchObject({ result: { status: "input_required", inputRequests: INPUT_REQUESTS } });
    expect(handleFrame(index, accept(91, "production"))).toMatchObject({ id: 91, result: { resultType: "complete" } });
    expect(statusOf(handleFrame(index, poll(92)))).toBe("completed");
  });

  it("never answers a different input with the recorded acknowledgment, even under warn", () => {
    for (const onMiss of ["error", "warn"] as const) {
      const index = buildReplayIndex(WITH_INPUT);
      handleFrame(index, poll(90));
      // The answer the client gave is what the rest of the task was built on,
      // so an acknowledgment of a different answer would be a lie about it.
      expect(handleFrame(index, accept(91, "staging"), onMiss)).toMatchObject({ error: { code: -32601 } });
    }
  });

  it("replays tasks/cancel and the cancelled state the recording holds after it", () => {
    const index = buildReplayIndex(
      cassette([
        c2s(0, ask(1, "tasks/cancel", { taskId: TASK_ID })),
        s2c(1, { jsonrpc: "2.0", id: 1, result: { resultType: "complete" } }),
        c2s(2, poll(2)),
        s2c(3, state(2, "cancelled", { statusMessage: "cancelled by the client" })),
      ])
    );
    expect(handleFrame(index, ask(90, "tasks/cancel", { taskId: TASK_ID }))).toMatchObject({ id: 90, result: {} });
    expect(statusOf(handleFrame(index, poll(91)))).toBe("cancelled");
    // Cancelled is terminal, so the poll after it is answered rather than missed.
    expect(statusOf(handleFrame(index, poll(92)))).toBe("cancelled");
  });
});

describe("notifications/tasks", () => {
  const LISTEN = ask(2, "subscriptions/listen", { notifications: { tasks: true } });
  const ACK = {
    jsonrpc: "2.0" as const,
    method: "notifications/subscriptions/acknowledged",
    params: { _meta: { [SUBSCRIPTION_ID_KEY]: 2 }, notifications: { tasks: true } },
  };
  const PUSHED = {
    jsonrpc: "2.0" as const,
    method: TASK_NOTIFICATION_METHOD,
    params: { _meta: { [SUBSCRIPTION_ID_KEY]: 2 }, taskId: TASK_ID, status: "completed", ...STAMPS },
  };
  const SUBSCRIBED = cassette([
    c2s(0, LISTEN),
    s2c(1, ACK),
    c2s(2, poll(3)),
    s2c(3, state(3, "completed", { result: { content: [] } })),
    s2c(4, PUSHED),
  ]);

  it("arrives on the subscription that asked for it, at the position the recording put it", () => {
    const index = buildReplayIndex(SUBSCRIBED);
    const [acknowledged] = handleExchange(index, { ...LISTEN, id: 77 });
    expect(acknowledged).toMatchObject({ method: "notifications/subscriptions/acknowledged" });

    const after = handleExchange(index, poll(78));
    expect(methodsOf(after)).toEqual(["#78", TASK_NOTIFICATION_METHOD]);
    // Re-keyed like every other frame on a subscription: the client correlates
    // on the id its own listen request carried.
    expect(after[1]).toMatchObject({ params: { _meta: { [SUBSCRIPTION_ID_KEY]: 77 }, taskId: TASK_ID, status: "completed" } });
  });

  it("is held back when the client polls without subscribing", () => {
    const index = buildReplayIndex(SUBSCRIBED);
    expect(methodsOf(handleExchange(index, poll(78)))).toEqual(["#78"]);
  });

  it("reaches a client over HTTP on the stream its listen opened", async () => {
    const file = path.join(tmpDir, "tasks-http.cassette.jsonl");
    const head = {
      type: "header",
      cassetteVersion: 2,
      recorder: "mcp-cassette@test",
      startedAt: "2026-10-08T00:00:00Z",
      transport: "http",
      era: "modern",
    };
    const entries: CassetteEntry[] = [
      c2s(0, LISTEN),
      {
        type: "chunks",
        t: 1,
        dir: "s2c",
        id: 2,
        chunks: [
          { t: 1, frame: ACK },
          { t: 4, frame: PUSHED },
        ],
      } as CassetteEntry,
      c2s(2, poll(3)),
      s2c(3, state(3, "completed", { result: { content: [] } })),
    ];
    fs.writeFileSync(file, [head, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n");

    const server = await startHttpReplay(file, { listen: "127.0.0.1:0" });
    const post = (body: unknown) =>
      fetch(server.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const opened = await post({ ...LISTEN, id: 55 });
    const reader = opened.body!.getReader();
    const decoder = new TextDecoder();
    const read = async () => JSON.parse(decoder.decode((await reader.read()).value).replace(/^data: /, "").trim());

    expect(await read()).toMatchObject({ method: "notifications/subscriptions/acknowledged" });
    await post(poll(56)).then((r) => r.text());
    expect(await read()).toMatchObject({
      method: "notifications/tasks",
      params: { _meta: { [SUBSCRIPTION_ID_KEY]: 55 }, status: "completed" },
    });

    await server.close();
    expect(server.misses()).toBe(0);
  }, 20_000);
});

describe("verify against a live server", () => {
  it("skips the calls whose task handle died with the recording, and keeps the one that made it", () => {
    const pairs = collectVerifyPairs(
      cassette([
        c2s(0, ask(1, "tools/call", { name: "build", arguments: { target: "release" } })),
        s2c(1, { jsonrpc: "2.0", id: 1, result: { resultType: "task", taskId: TASK_ID, status: "working", ...STAMPS } }),
        c2s(2, poll(2)),
        s2c(3, state(2, "completed", { result: { content: [] } })),
        c2s(4, ask(3, "tasks/cancel", { taskId: TASK_ID })),
        s2c(5, { jsonrpc: "2.0", id: 3, result: { resultType: "complete" } }),
      ])
    );
    // A live server has never heard of the recorded handle, so re-firing a poll
    // at it asks a question about nothing. The call that created the task is
    // still worth re-firing.
    expect(pairs.map((pair) => pair.request.method)).toEqual(["tools/call"]);
  });

  it("does not report a freshly minted handle as drift", () => {
    const recorded = { resultType: "task", taskId: TASK_ID, status: "working", ...STAMPS };
    const live = { resultType: "task", taskId: "task-9999", status: "working", ...STAMPS, pollIntervalMs: 250 };
    expect(normalizeForDiff(live)).toEqual(normalizeForDiff(recorded));
  });

  it("still reports a taskId that changed inside an ordinary tool result", () => {
    // Only a task handle mints a fresh id on every run. A tool that returns a
    // field by that name is returning data, and data that moved is drift.
    const answer = (taskId: string): JsonRpcResponse => ({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "ok" }], taskId, pollIntervalMs: 50 },
    });
    const { status, changes } = classifyPair(answer("a"), answer("b"));
    expect(status).toBe("CHANGED");
    expect(changes.map((change) => change.path)).toEqual(["/taskId"]);
  });
});

describe("the fixture server, end to end", () => {
  const session = (polls: number[]) => [
    ask(1, "server/discover"),
    ask(2, "subscriptions/listen", { notifications: { tasks: true } }),
    ask(3, "tools/call", { name: "build", arguments: { target: "release" } }),
    ...polls.map((id) => poll(id)),
  ];

  it("records a task from handle to completion and replays it identically", async () => {
    const cassettePath = path.join(tmpDir, "tasks.cassette.jsonl");
    // Poll, hit input_required, answer it, then poll through to completed.
    const frames = [
      ...session([10, 11]),
      ask(12, "tasks/update", { taskId: TASK_ID, inputResponses: { confirm: { action: "accept", content: { input: "yes" } } } }),
      poll(13),
      poll(14),
    ];

    const recorded = await drive(["node", CLI, "record", "-o", cassettePath, "--", "node", TASKING], frames);
    const live = recorded.out.map((f) => ("method" in f ? f.method : statusOf(f) ?? `#${String((f as { id: unknown }).id)}`));
    expect(live).toContain(TASK_NOTIFICATION_METHOD);
    expect(live).toContain("completed");

    const file = readCassette(cassettePath);
    const handle = file.entries.find(
      (e) => e.type === "frame" && e.dir === "s2c" && (e.frame as { result?: { resultType?: string } }).result?.resultType === "task"
    );
    expect(handle).toBeDefined(); // the tools/call was answered with a task, not a result

    const replayed = await drive(["node", CLI, "replay", cassettePath], frames);
    expect(replayed.out.map((f) => ("method" in f ? f.method : statusOf(f) ?? `#${String((f as { id: unknown }).id)}`))).toEqual(live);
    expect(replayed.code).toBe(0);
  }, 30_000);

  it("names the task when the recording stopped while it was still working", async () => {
    const cassettePath = path.join(tmpDir, "tasks-stalled.cassette.jsonl");
    const stalling = [
      "node",
      CLI,
      "record",
      "-o",
      cassettePath,
      "--",
      process.execPath,
      "-e",
      `process.env.TASKING_STALL="1";import(${JSON.stringify(TASKING)})`,
    ];
    await drive(stalling, session([10, 11]));

    // The replayed client polls once more than the recording ever did.
    const replayed = await drive(["node", CLI, "replay", cassettePath], session([10, 11, 12]));
    expect(replayed.code).toBe(1); // --on-miss error is the default
    expect(replayed.err).toContain(`task "${TASK_ID}"`);
    expect(replayed.err).toContain("which is not terminal");
  }, 30_000);
});
