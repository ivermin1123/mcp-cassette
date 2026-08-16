/**
 * A miss as data.
 *
 * Two things are worth pinning here, and they pull in opposite directions.
 *
 * The first is that the union actually discriminates: every cause a caller
 * might act on differently has to arrive as a different `kind`, carrying the
 * payload that makes the fix obvious. That is the whole reason the type exists,
 * so each variant gets a row.
 *
 * The second is that splitting the answer from its rendering did not move a
 * single byte of what people already read in their terminals. `diagnoseMiss` is
 * now `formatMiss ∘ diagnoseMissReason`, and the round-trip test below is what
 * keeps those two from drifting apart later, because a second formatter growing
 * somewhere else is exactly the failure this refactor exists to prevent.
 */

import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildReplayIndex,
  diagnoseMiss,
  diagnoseMissReason,
  formatMiss,
  handleFrame,
  type MissReason,
} from "../src/replay.js";
import { startHttpReplay } from "../src/http-replay.js";
import type { Cassette } from "../src/cassette.js";
import type { CassetteEntry } from "../src/cassette.js";
import type { JsonRpcRequest, JsonRpcResponse } from "../src/jsonrpc.js";

const req = (id: number, method: string, params?: unknown): JsonRpcRequest => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params !== undefined ? { params } : {}),
});
const res = (id: number, result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
const call = (id: number, name: string, args: unknown) => req(id, "tools/call", { name, arguments: args });

function cassetteWith(pairs: Array<[JsonRpcRequest, JsonRpcResponse]>): Cassette {
  const entries = pairs.flatMap(([q, a], i) => [
    { type: "frame" as const, t: i * 2, dir: "c2s" as const, frame: q },
    { type: "frame" as const, t: i * 2 + 1, dir: "s2c" as const, frame: a },
  ]);
  return {
    header: {
      type: "header",
      cassetteVersion: 1,
      recorder: "test",
      startedAt: "2026-01-01T00:00:00Z",
      transport: "stdio",
    },
    entries,
  };
}

const reasonFor = (pairs: Array<[JsonRpcRequest, JsonRpcResponse]>, incoming: JsonRpcRequest): MissReason =>
  diagnoseMissReason(buildReplayIndex(cassetteWith(pairs)), incoming);

describe("MissReason names the cause", () => {
  it("empty-cassette: nothing was ever recorded", () => {
    expect(reasonFor([], call(1, "echo", {}))).toEqual({ kind: "empty-cassette" });
  });

  it("exhausted: recorded, but every response is spent", () => {
    const index = buildReplayIndex(cassetteWith([[call(1, "echo", { m: "x" }), res(1, { ok: 1 })]]));
    // Consume the only recording, then ask again.
    handleFrame(index, call(10, "echo", { m: "x" }));
    const reason = diagnoseMissReason(index, call(11, "echo", { m: "x" }));
    expect(reason.kind).toBe("exhausted");
    if (reason.kind !== "exhausted") throw new Error("unreachable");
    expect(reason.recordedCount).toBe(1);
    expect(reason.fingerprint).toContain("tools/call");
  });

  it("unknown-method: the method was never recorded, and the recorded ones are listed", () => {
    const reason = reasonFor([[req(1, "resources/read", { uri: "a" }), res(1, {})]], req(2, "prompts/get", { name: "x" }));
    expect(reason).toEqual({
      kind: "unknown-method",
      method: "prompts/get",
      recordedMethods: ["resources/read"],
    });
  });

  it("unknown-tool: the tool was never recorded, and the recorded ones are listed sorted", () => {
    const reason = reasonFor(
      [
        [call(1, "echo", { m: "x" }), res(1, {})],
        [call(2, "add", { a: 1 }), res(2, {})],
      ],
      call(9, "slugify", { title: "t" })
    );
    expect(reason).toEqual({ kind: "unknown-tool", tool: "slugify", recordedTools: ["add", "echo"] });
  });

  it("arguments-differ: a recorded tool, with the diverging paths as data", () => {
    const reason = reasonFor(
      [
        [call(1, "echo", { m: "recorded", extra: 1 }), res(1, {})],
        [call(2, "echo", { m: "other", flag: true, extra: 2 }), res(2, {})],
      ],
      call(9, "echo", { m: "incoming", extra: 1 })
    );
    expect(reason.kind).toBe("arguments-differ");
    if (reason.kind !== "arguments-differ") throw new Error("unreachable");
    // The nearest recording is the {m,extra} one, so /m is the only divergence.
    expect(reason.changes).toEqual([{ path: "/m", recorded: "recorded", live: "incoming" }]);
  });

  it("params-differ: a recorded method, with the diverging paths as data", () => {
    const reason = reasonFor([[req(1, "resources/read", { uri: "a" }), res(1, {})]], req(2, "resources/read", { uri: "b" }));
    expect(reason.kind).toBe("params-differ");
    if (reason.kind !== "params-differ") throw new Error("unreachable");
    expect(reason.changes).toEqual([{ path: "/uri", recorded: "a", live: "b" }]);
  });

  it("separates 'nothing matched' from 'something came close'", () => {
    const nothingMatched: MissReason["kind"][] = [
      "empty-cassette",
      "exhausted",
      "stream-exhausted",
      "unknown-method",
      "unknown-tool",
    ];
    // The two near-miss reasons are the only ones carrying paths, which is what
    // lets a caller tell "re-record this" from "fix these arguments".
    for (const kind of nothingMatched) {
      expect(["arguments-differ", "params-differ"]).not.toContain(kind);
    }
    const near = reasonFor([[call(1, "echo", { m: "a" }), res(1, {})]], call(2, "echo", { m: "b" }));
    expect(near).toHaveProperty("changes");
  });
});

describe("formatMiss is the only renderer", () => {
  const cases: Array<[string, Array<[JsonRpcRequest, JsonRpcResponse]>, JsonRpcRequest]> = [
    ["empty-cassette", [], call(1, "echo", {})],
    ["unknown-method", [[req(1, "resources/read", { uri: "a" }), res(1, {})]], req(2, "prompts/get", { name: "x" })],
    [
      "unknown-tool",
      [
        [call(1, "echo", { m: "x" }), res(1, {})],
        [call(2, "add", { a: 1 }), res(2, {})],
      ],
      call(9, "slugify", { title: "t" }),
    ],
    ["arguments-differ", [[call(1, "echo", { m: "recorded" }), res(1, {})]], call(9, "echo", { m: "incoming" })],
    ["params-differ", [[req(1, "resources/read", { uri: "a" }), res(1, {})]], req(2, "resources/read", { uri: "b" })],
  ];

  // The invariant that keeps a second formatter from growing elsewhere.
  it.each(cases)("diagnoseMiss(%s) is formatMiss ∘ diagnoseMissReason", (_name, pairs, incoming) => {
    const index = buildReplayIndex(cassetteWith(pairs));
    expect(diagnoseMiss(index, incoming)).toBe(formatMiss(diagnoseMissReason(index, incoming)));
  });

  it("renders the exact sentences the terminal used to print", () => {
    expect(formatMiss({ kind: "empty-cassette" })).toBe("the cassette contains no request/response pairs at all");
    expect(formatMiss({ kind: "unknown-method", method: "prompts/get", recordedMethods: ["resources/read"] })).toBe(
      'no recorded request has method "prompts/get" — recorded methods: resources/read'
    );
    expect(formatMiss({ kind: "unknown-tool", tool: "slugify", recordedTools: ["add", "echo"] })).toBe(
      'no recorded tools/call for tool "slugify" — recorded tools: add, echo'
    );
    expect(formatMiss({ kind: "exhausted", fingerprint: "fp", recordedCount: 1 })).toBe(
      "this exact fingerprint was recorded 1 time(s), but every recorded response was already consumed " +
        "earlier in this session — the client is calling it more often than the recording did"
    );
    // Byte for byte what http-replay used to build inline.
    expect(formatMiss({ kind: "stream-exhausted", fingerprint: "fp", recordedCount: 2 })).toBe(
      "this request's answer was recorded as a stream 2 time(s), but every one was already replayed " +
        "earlier in this session"
    );
  });

  it("shows at most three paths and counts the rest", () => {
    const changes = ["a", "b", "c", "d", "e"].map((p) => ({ path: `/${p}`, recorded: 1, live: 2 }));
    const rendered = formatMiss({ kind: "params-differ", changes });
    expect(rendered).toBe(
      "method and tool match a recording, but params differ at: /a (recorded 1, got 2); " +
        "/b (recorded 1, got 2); /c (recorded 1, got 2) and 2 more path(s)"
    );
  });

  it("keeps the no-candidates wording rather than rendering an empty list", () => {
    expect(formatMiss({ kind: "arguments-differ", changes: [] })).toBe(
      "arguments could not be compared to any recording"
    );
  });
});

describe("ReplayServer.takeMisses", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cassette-missdrain-"));
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const frame = (dir: "c2s" | "s2c", f: unknown): CassetteEntry => ({ type: "frame", t: 1, dir, frame: f }) as CassetteEntry;

  function httpCassette(name: string): string {
    const file = path.join(tmpDir, `${name}.cassette.jsonl`);
    const head = {
      type: "header",
      cassetteVersion: 2,
      recorder: "mcp-cassette@test",
      startedAt: "2026-08-16T00:00:00Z",
      transport: "http",
      era: "modern",
    };
    const entries = [
      frame("c2s", call(1, "echo", { m: "recorded" })),
      frame("s2c", res(1, { ok: true })),
    ];
    fs.writeFileSync(file, [head, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n");
    return file;
  }

  const post = (url: string, body: unknown) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("drains what happened since the last call, while misses() keeps counting", async () => {
    const server = await startHttpReplay(httpCassette("drain"), { listen: "127.0.0.1:0", onMiss: "warn" });
    try {
      // matchResponse falls back to the method pool when the fingerprint misses,
      // so the first wrong-argument call is *answered*, not missed. That is the
      // engine's loose matching, and it has to be spent before a miss can happen.
      const answered = await post(server.url, call(1, "echo", { m: "wrong" }));
      expect(await answered.json()).toMatchObject({ result: { ok: true } });
      expect(server.takeMisses()).toEqual([]);

      await post(server.url, call(2, "echo", { m: "wrong" }));
      const first = server.takeMisses();
      expect(first).toHaveLength(1);
      expect(first[0]!.method).toBe("tools/call");
      // Typed, so a caller never has to read the sentence to know what to fix.
      expect(first[0]!.reason.kind).toBe("arguments-differ");

      // Drained: the same miss must not be reported to whoever asks next.
      expect(server.takeMisses()).toEqual([]);

      await post(server.url, call(3, "nope", {}));
      const second = server.takeMisses();
      expect(second).toHaveLength(1);
      expect(second[0]!.reason.kind).toBe("unknown-tool");

      // Cumulative, because it is what decides the session's exit code.
      expect(server.misses()).toBe(2);
      expect(server.takeMisses()).toEqual([]);
      expect(server.misses()).toBe(2);
    } finally {
      await server.close();
    }
  });
});
