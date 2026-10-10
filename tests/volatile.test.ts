/**
 * Declared volatility: the request fields a user says change every run.
 *
 * Replay matches exactly, which is the right default and also the reason a
 * timestamp or a generated id in a request turns a green suite red. The old
 * same-method fallback papered over that by answering with some other
 * recording of the same method; a declaration is the precise version of the
 * same tolerance, and the only one that still refuses a request that really is
 * different.
 *
 * So the tests below come in pairs. Every one that proves a declared field is
 * ignored has a sibling proving an undeclared one is not, because a matcher
 * that matches everything is not a matcher. The rest guard the edges a
 * declaration must not bend: the MRTR retry rule, the `tasks/get` pool and its
 * terminal state, and the miss diagnosis, which must never send a reader after
 * a field the session already said would move.
 */

import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  buildReplayIndex,
  diagnoseMiss,
  diagnoseMissReason,
  fingerprint,
  handleFrame,
  matchFallback,
} from "../src/replay.js";
import { startHttpReplay } from "../src/http-replay.js";
import { readCassette, type Cassette, type CassetteEntry, type CassetteHeader } from "../src/cassette.js";
import { redactFrame } from "../src/redact.js";
import { useCassette } from "../src/vitest/index.js";
import type { JsonRpcFrame, JsonRpcRequest, JsonRpcResponse } from "../src/jsonrpc.js";

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "dist/cli.js");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cassette-volatile-"));
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const c2s = (t: number, frame: unknown): CassetteEntry => ({ type: "frame", t, dir: "c2s", frame }) as CassetteEntry;
const s2c = (t: number, frame: unknown): CassetteEntry => ({ type: "frame", t, dir: "s2c", frame }) as CassetteEntry;

const HEAD: CassetteHeader = {
  type: "header",
  cassetteVersion: 2,
  recorder: "mcp-cassette@test",
  startedAt: "2026-10-09T00:00:00Z",
  transport: "stdio",
  era: "modern",
};

function cassette(entries: CassetteEntry[], header: Partial<CassetteHeader> = {}): Cassette {
  return { header: { ...HEAD, ...header }, entries: entries as Cassette["entries"] };
}

/** One `tools/call` of `echo`, with whatever arguments the test cares about. */
const call = (id: number, args: Record<string, unknown>): JsonRpcRequest => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "echo", arguments: args },
});

const answer = (id: number, text: string): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  result: { content: [{ type: "text", text }] },
});

/** A recording of one `echo` call, stamped with the moment it was recorded. */
function recorded(args: Record<string, unknown>, text = "recorded"): Cassette {
  return cassette([c2s(0, call(1, args)), s2c(1, answer(1, text))]);
}

const textOf = (frame: JsonRpcFrame | null) =>
  (frame as { result?: { content?: { text?: string }[] } } | null)?.result?.content?.[0]?.text;
const errorOf = (frame: JsonRpcFrame | null) => (frame as { error?: { message?: string } } | null)?.error?.message;

const AT = "/arguments/requestedAt";

describe("a declared field is dropped before the fingerprint", () => {
  it("answers a request that differs only in that field", () => {
    const index = buildReplayIndex(recorded({ m: "hi", requestedAt: "2026-10-09T00:00:00Z" }), { volatile: [AT] });
    // A different stamp, every other argument identical: the recording answers.
    expect(textOf(handleFrame(index, call(9, { m: "hi", requestedAt: "2031-01-01T12:00:00Z" })))).toBe("recorded");
  });

  it("still misses when an undeclared field differs", () => {
    const index = buildReplayIndex(recorded({ m: "hi", requestedAt: "2026-10-09T00:00:00Z" }), { volatile: [AT] });
    const miss = handleFrame(index, call(9, { m: "bye", requestedAt: "2031-01-01T12:00:00Z" }));
    expect(errorOf(miss)).toContain("no recorded response");
    // The one path that really diverged, and not the one the session declared.
    expect(errorOf(miss)).toContain("/m");
    expect(errorOf(miss)).not.toContain("requestedAt");
  });

  it("drops the field from the recorded side too, not just the live one", () => {
    // Neither stamp is the other's: only dropping both can make them equal.
    const index = buildReplayIndex(recorded({ m: "hi", requestedAt: "2020-01-01T00:00:00Z" }), { volatile: [AT] });
    expect(textOf(handleFrame(index, call(9, { m: "hi", requestedAt: "2031-01-01T12:00:00Z" })))).toBe("recorded");
  });

  it("leaves a request alone when the declared path is not in it", () => {
    const plain = recorded({ m: "hi" });
    expect(fingerprint(call(1, { m: "hi" }), ["/arguments/nothingHere"])).toBe(fingerprint(call(1, { m: "hi" })));
    const index = buildReplayIndex(plain, { volatile: ["/arguments/nothingHere"] });
    expect(textOf(handleFrame(index, call(9, { m: "hi" })))).toBe("recorded");
  });

  it("declares nothing by default, and leaves every fingerprint exactly where it was", () => {
    const index = buildReplayIndex(recorded({ m: "hi", requestedAt: "2026-10-09T00:00:00Z" }));
    expect(index.volatile).toEqual([]);
    expect(errorOf(handleFrame(index, call(9, { m: "hi", requestedAt: "2031-01-01T12:00:00Z" })))).toContain(
      "no recorded response"
    );
  });

  it("blanks a declared array element instead of re-indexing the rest", () => {
    const index = buildReplayIndex(recorded({ ids: ["run-1", "keep"] }), { volatile: ["/arguments/ids/0"] });
    expect(textOf(handleFrame(index, call(9, { ids: ["run-2", "keep"] })))).toBe("recorded");
    // The tail did not shift up into the blanked slot: it is still compared.
    const index2 = buildReplayIndex(recorded({ ids: ["run-1", "keep"] }), { volatile: ["/arguments/ids/0"] });
    expect(errorOf(handleFrame(index2, call(9, { ids: ["run-2", "moved"] })))).toContain("no recorded response");
  });
});

describe("scoping a declaration to one method", () => {
  const session = () =>
    cassette([
      c2s(0, call(1, { m: "hi", requestedAt: "2026-10-09T00:00:00Z" })),
      s2c(1, answer(1, "called")),
      c2s(2, { jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "file:///a", requestedAt: "2026-10-09T00:00:00Z" } }),
      s2c(3, { jsonrpc: "2.0", id: 2, result: { contents: [] } }),
    ]);

  it("drops the pointer on the named method only", () => {
    const index = buildReplayIndex(session(), { volatile: [`tools/call:${AT}`] });
    expect(textOf(handleFrame(index, call(9, { m: "hi", requestedAt: "2031-01-01T12:00:00Z" })))).toBe("called");
    const other = handleFrame(index, {
      jsonrpc: "2.0",
      id: 10,
      method: "resources/read",
      params: { uri: "file:///a", requestedAt: "2031-01-01T12:00:00Z" },
    });
    expect(errorOf(other)).toContain("no recorded response");
  });

  it("drops an unscoped pointer on every method", () => {
    const index = buildReplayIndex(session(), { volatile: ["/requestedAt", AT] });
    expect(textOf(handleFrame(index, call(9, { m: "hi", requestedAt: "2031-01-01T12:00:00Z" })))).toBe("called");
    const other = handleFrame(index, {
      jsonrpc: "2.0",
      id: 10,
      method: "resources/read",
      params: { uri: "file:///a", requestedAt: "2031-01-01T12:00:00Z" },
    });
    expect(errorOf(other)).toBeUndefined();
  });

  it("reads a colon inside a pointer as part of the pointer, not as a scope", () => {
    const index = buildReplayIndex(recorded({ "run:id": "a" }), { volatile: ["/arguments/run:id"] });
    expect(textOf(handleFrame(index, call(9, { "run:id": "b" })))).toBe("recorded");
  });
});

describe("where the declarations come from", () => {
  const twoFields = () => recorded({ m: "hi", requestedAt: "2026-10-09T00:00:00Z", runId: "run-1" });
  /** The same recording, with the cassette declaring the given fields itself. */
  const declaring = (...volatile: string[]) => ({ ...twoFields(), header: { ...HEAD, volatile } });

  it("reads the cassette header's own list", () => {
    const index = buildReplayIndex(declaring(AT, "/arguments/runId"));
    expect(index.volatile).toEqual([AT, "/arguments/runId"]);
    expect(textOf(handleFrame(index, call(9, { m: "hi", requestedAt: "2031-01-01T00:00:00Z", runId: "run-2" })))).toBe(
      "recorded"
    );
  });

  it("combines the header's list with the invocation's, and needs both", () => {
    const withHeader = declaring(AT);
    const combined = buildReplayIndex(withHeader, { volatile: ["/arguments/runId"] });
    expect(combined.volatile).toEqual([AT, "/arguments/runId"]);
    const drifted = () => call(9, { m: "hi", requestedAt: "2031-01-01T00:00:00Z", runId: "run-2" });
    expect(textOf(handleFrame(combined, drifted()))).toBe("recorded");
    // Either half alone leaves one field undeclared, so the same request misses.
    expect(errorOf(handleFrame(buildReplayIndex(withHeader), drifted()))).toContain("no recorded response");
    expect(
      errorOf(handleFrame(buildReplayIndex(twoFields(), { volatile: ["/arguments/runId"] }), drifted()))
    ).toContain("no recorded response");
  });
});

describe("a malformed declaration", () => {
  const build = (spec: string) => () => buildReplayIndex(recorded({ m: "hi" }), { volatile: [spec] });

  it("is refused while the index is built, naming the declaration", () => {
    expect(build("requestedAt")).toThrow(/"requestedAt".*A volatile declaration is a JSON Pointer/s);
    expect(build("requestedAt")).toThrow(/neither a JSON Pointer nor a method-scoped one/);
  });

  it("refuses an empty method scope and a scope without a pointer", () => {
    expect(build(":/arguments/requestedAt")).toThrow(/the method scope is empty/);
    expect(build("tools/call:arguments")).toThrow(/does not start with "\/"/);
  });

  it("refuses a declaration that names no field, rather than calling it malformed", () => {
    // RFC 6901 calls "" a pointer, the whole document. Erasing all of `params`
    // is never what a user means, so the refusal says that and not "invalid".
    expect(build("")).toThrow(/the declaration names no field/);
    expect(build("tools/call:")).toThrow(/names no field, only the method "tools\/call"/);
  });

  it("says what a declaration should look like", () => {
    expect(build("requestedAt")).toThrow(/tools\/call:\/arguments\/requestedAt/);
  });

  it("refuses a header declaration the same way", () => {
    expect(() => buildReplayIndex({ ...recorded({ m: "hi" }), header: { ...HEAD, volatile: ["nope"] } })).toThrow(
      /volatile declaration/
    );
  });

  it("refuses a header whose volatile is not a list of strings, by name", () => {
    // Hand-editing the header is how a declaration gets into a cassette today,
    // so the list's own shape is the first thing a user can get wrong.
    const withHeader = (volatile: unknown) =>
      () => buildReplayIndex({ ...recorded({ m: "hi" }), header: { ...HEAD, volatile } as CassetteHeader });
    expect(withHeader({ a: 1 })).toThrow(/the cassette header's "volatile" must be a list of strings/);
    expect(withHeader([42])).toThrow(/must be a list of strings, got \[42\]/);
    expect(withHeader("/arguments/requestedAt")).toThrow(/must be a list of strings/);
    // The shape it asks for is still accepted.
    expect(withHeader(["/arguments/requestedAt"])).not.toThrow();
  });
});

describe("a declaration on a field replay matches a rule on", () => {
  const build = (spec: string) => () => buildReplayIndex(recorded({ m: "hi" }), { volatile: [spec] });

  // Each of the three below was a silent wrong answer before it was refused:
  // the request matched, and the recording it matched belonged to another tool,
  // another retry or another task. Refusing the declaration is what keeps the
  // feature from reintroducing the thing it exists to replace.

  it("refuses /taskId, which would pool every task's polls together", () => {
    expect(build("tasks/get:/taskId")).toThrow(/pool every task's polls together/);
    // Unscoped, it reaches `tasks/get` all the same.
    expect(build("/taskId")).toThrow(/pool every task's polls together/);
    expect(build("tasks/get:/taskId")).toThrow(/Scope the declaration to a method that does not match on it/);
  });

  it("refuses /inputResponses, which would collapse a retry onto the call it retried", () => {
    expect(build("/inputResponses")).toThrow(/answer a retry with the recording of the call it retried/);
    // A pointer into it is the same erasure one level down.
    expect(build("/inputResponses/0/value")).toThrow(/answer a retry with the recording/);
    // `isMrtrRetry` reads the field on every method, and `tasks/update` carries
    // it too, so the refusal is not scoped to `tools/call`.
    expect(build("tasks/update:/inputResponses")).toThrow(/on every method/);
  });

  it("refuses /requestState, which a retry carrying no inputResponses is matched on", () => {
    // `mrtrPart` reads both fields, so a request carrying only `requestState`
    // is still a retry. Dropping it would leave that request keyed on nothing a
    // retry is keyed on, and it would land in the pool of the call it retried.
    expect(build("/requestState")).toThrow(/answer a retry carrying no \/inputResponses/);
    expect(build("tools/call:/requestState")).toThrow(/on every method/);
  });

  it("refuses /name on tools/call, which would answer one tool with another's recording", () => {
    expect(build("tools/call:/name")).toThrow(/answer a call with another tool's recording/);
    expect(build("/name")).toThrow(/answer a call with another tool's recording/);
  });

  it("leaves the same names declarable on a method that does not match on them", () => {
    expect(build("prompts/get:/name")).not.toThrow();
    expect(build("tasks/update:/taskId")).not.toThrow();
    expect(build("/arguments/requestState")).not.toThrow();
    // Only the first segment is the rule's; an argument of the same name is fine.
    expect(build("tools/call:/arguments/name")).not.toThrow();
  });

  it("refuses a reserved field in the cassette header too", () => {
    expect(() =>
      buildReplayIndex({ ...recorded({ m: "hi" }), header: { ...HEAD, volatile: ["tasks/get:/taskId"] } })
    ).toThrow(/pool every task's polls together/);
  });
});

describe("the miss diagnosis", () => {
  it("names only the undeclared paths that diverged", () => {
    const index = buildReplayIndex(recorded({ m: "hi", requestedAt: "2026-10-09T00:00:00Z" }), { volatile: [AT] });
    const reason = diagnoseMissReason(index, call(9, { m: "bye", requestedAt: "2031-01-01T00:00:00Z" }));
    expect(reason.kind).toBe("arguments-differ");
    const paths = reason.kind === "arguments-differ" ? reason.changes.map((c) => c.path) : [];
    expect(paths).toEqual(["/m"]);
  });

  it("reports a spent recording rather than a drifted stamp", () => {
    const index = buildReplayIndex(recorded({ m: "hi", requestedAt: "2026-10-09T00:00:00Z" }), { volatile: [AT] });
    handleFrame(index, call(9, { m: "hi", requestedAt: "2031-01-01T00:00:00Z" })); // spends the one recording
    expect(diagnoseMiss(index, call(10, { m: "hi", requestedAt: "2031-01-01T00:00:01Z" }))).toContain(
      "already consumed"
    );
  });
});

describe("the rules a declaration does not bend", () => {
  const retry = (id: number, args: Record<string, unknown>, answered: string): JsonRpcRequest => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "deploy", arguments: args, inputResponses: [{ value: answered }], requestState: "state-1" },
  });

  const retried = () =>
    cassette([
      c2s(0, retry(1, { target: "prod", requestedAt: "2026-10-09T00:00:00Z" }, "yes")),
      s2c(1, answer(1, "deployed")),
    ]);

  it("matches an MRTR retry whose declared field moved", () => {
    const index = buildReplayIndex(retried(), { volatile: [AT] });
    expect(textOf(handleFrame(index, retry(9, { target: "prod", requestedAt: "2031-01-01T00:00:00Z" }, "yes")))).toBe(
      "deployed"
    );
  });

  it("still refuses a retry that answered differently, and never lends it one", () => {
    const index = buildReplayIndex(retried(), { volatile: [AT] });
    const declined = retry(9, { target: "prod", requestedAt: "2031-01-01T00:00:00Z" }, "no");
    expect(errorOf(handleFrame(index, declined))).toContain("no recorded response");
    // warn's tolerance is the one thing a retry never gets, declaration or not.
    expect(matchFallback(index, declined)).toBeNull();
    expect(diagnoseMiss(index, declined)).toContain("inputResponses");
  });

  const poll = (id: number, taskId: string, at: string): JsonRpcRequest => ({
    jsonrpc: "2.0",
    id,
    method: "tasks/get",
    params: { taskId, requestedAt: at },
  });
  const state = (id: number, taskId: string, status: string): JsonRpcResponse => ({
    jsonrpc: "2.0",
    id,
    result: { resultType: "complete", taskId, status },
  });

  /** Three polls for one task, each stamped with the moment the client sent it. */
  const polled = (final: string) =>
    cassette([
      c2s(0, poll(1, "task-1", "2026-10-09T00:00:00Z")),
      s2c(1, state(1, "task-1", "working")),
      c2s(2, poll(2, "task-1", "2026-10-09T00:00:01Z")),
      s2c(3, state(2, "task-1", "working")),
      c2s(4, poll(3, "task-1", "2026-10-09T00:00:02Z")),
      s2c(5, state(3, "task-1", final)),
    ]);

  const statusOf = (frame: JsonRpcFrame | null) => (frame as { result?: { status?: string } } | null)?.result?.status;

  it("pools a task's polls together once their stamps are declared", () => {
    // Without the declaration each stamp is its own fingerprint, so the three
    // polls would be three pools of one rather than the task's sequence.
    const index = buildReplayIndex(polled("completed"), { volatile: ["tasks/get:/requestedAt"] });
    const stamps = ["2031-01-01T00:00:00Z", "2031-01-01T00:00:05Z", "2031-01-01T00:00:09Z"];
    expect(stamps.map((at, i) => statusOf(handleFrame(index, poll(90 + i, "task-1", at))))).toEqual([
      "working",
      "working",
      "completed",
    ]);
    // Past the pool the terminal rule still answers, at a stamp nobody recorded.
    expect(statusOf(handleFrame(index, poll(99, "task-1", "2031-02-02T00:00:00Z")))).toBe("completed");
  });

  it("keeps a poll about another task a miss, declaration or not", () => {
    const index = buildReplayIndex(polled("completed"), { volatile: ["tasks/get:/requestedAt"] });
    const other = poll(99, "task-2", "2031-01-01T00:00:00Z");
    expect(errorOf(handleFrame(index, other))).toContain("no recorded response");
    // `tasks/get` is one of the methods warn refuses to borrow for.
    expect(matchFallback(index, other)).toBeNull();
  });

  it("reports a non-terminal recording by task and status, not by stamp", () => {
    const index = buildReplayIndex(polled("working"), { volatile: ["tasks/get:/requestedAt"] });
    for (const i of [0, 1, 2]) handleFrame(index, poll(90 + i, "task-1", `2031-01-01T00:00:0${i}Z`));
    const reason = diagnoseMissReason(index, poll(99, "task-1", "2031-02-02T00:00:00Z"));
    expect(reason).toMatchObject({ kind: "task-not-terminal", taskId: "task-1", status: "working" });
  });

  it("matches a subscriptions/listen whose declared field moved", () => {
    const listen = (id: number, at: string): JsonRpcRequest => ({
      jsonrpc: "2.0",
      id,
      method: "subscriptions/listen",
      params: { uri: "file:///a", openedAt: at },
    });
    const index = buildReplayIndex(
      cassette([
        c2s(0, listen(1, "2026-10-09T00:00:00Z")),
        s2c(1, {
          jsonrpc: "2.0",
          method: "notifications/subscriptions/acknowledged",
          params: { _meta: { "io.modelcontextprotocol/subscriptionId": 1 } },
        }),
      ]),
      { volatile: ["subscriptions/listen:/openedAt"] }
    );
    const acknowledged = handleFrame(index, listen(9, "2031-01-01T00:00:00Z"));
    expect(acknowledged).toMatchObject({ method: "notifications/subscriptions/acknowledged" });
  });

  it("drops the declared field on the redacted path as well", () => {
    // Redaction rewrites the token on both sides; the declaration drops the
    // stamp on both sides. The match needs the two to compose.
    const live = call(1, { token: "ghp_abcdefghijklmnop0123", requestedAt: "2026-10-09T00:00:00Z" });
    const index = buildReplayIndex(
      cassette([c2s(0, redactFrame(live)), s2c(1, answer(1, "recorded"))], { redaction: { applied: true } }),
      { volatile: [AT] }
    );
    const now = call(9, { token: "ghp_abcdefghijklmnop0123", requestedAt: "2031-01-01T00:00:00Z" });
    expect(textOf(handleFrame(index, now))).toBe("recorded");
  });
});

describe("over HTTP", () => {
  const HTTP_HEAD = { ...HEAD, transport: "http" as const };

  function file(name: string, entries: CassetteEntry[], header: Partial<CassetteHeader> = {}): string {
    const target = path.join(tmpDir, name);
    fs.writeFileSync(
      target,
      [{ ...HTTP_HEAD, ...header }, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n"
    );
    return target;
  }

  const post = (url: string, body: unknown) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("answers a JSON recording whose declared field moved", async () => {
    const cassettePath = file("json.jsonl", [
      c2s(0, call(1, { m: "hi", requestedAt: "2026-10-09T00:00:00Z" })),
      s2c(1, answer(1, "recorded")),
    ]);
    const server = await startHttpReplay(cassettePath, { listen: "127.0.0.1:0", volatile: [AT] });
    try {
      const res = await post(server.url, call(9, { m: "hi", requestedAt: "2031-01-01T00:00:00Z" }));
      expect(textOf((await res.json()) as JsonRpcFrame)).toBe("recorded");
      expect(server.misses()).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("keys a streamed answer's pool by the same dropped fingerprint", async () => {
    // The pool of streams is built separately from the engine's index, so a
    // declaration that reached one and not the other would miss here.
    const cassettePath = file("streamed.jsonl", [
      c2s(0, call(1, { m: "hi", requestedAt: "2026-10-09T00:00:00Z" })),
      {
        type: "chunks",
        t: 1,
        dir: "s2c",
        id: 1,
        chunks: [{ t: 1, frame: answer(1, "streamed") }],
      } as CassetteEntry,
    ]);
    const server = await startHttpReplay(cassettePath, { listen: "127.0.0.1:0", volatile: [AT] });
    try {
      const res = await post(server.url, call(9, { m: "hi", requestedAt: "2031-01-01T00:00:00Z" }));
      expect(await res.text()).toContain('"streamed"');
      expect(server.misses()).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("refuses a malformed declaration before it binds a port", async () => {
    const cassettePath = file("bad.jsonl", [c2s(0, call(1, { m: "hi" })), s2c(1, answer(1, "recorded"))]);
    await expect(startHttpReplay(cassettePath, { listen: "127.0.0.1:0", volatile: ["nope"] })).rejects.toThrow(
      /volatile declaration/
    );
  });
});

describe("the replay command", () => {
  it("names a malformed --volatile and exits 1", () => {
    const cassettePath = path.join(tmpDir, "cli.jsonl");
    fs.writeFileSync(
      cassettePath,
      [HEAD, c2s(0, call(1, { m: "hi" })), s2c(1, answer(1, "recorded"))].map((e) => JSON.stringify(e)).join("\n") + "\n"
    );
    let stderr = "";
    let code = 0;
    try {
      execFileSync(process.execPath, [CLI, "replay", cassettePath, "--volatile", "requestedAt"], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        input: "",
      });
    } catch (err) {
      const failure = err as { stderr?: string; status?: number };
      stderr = failure.stderr ?? "";
      code = failure.status ?? 0;
    }
    expect(code).toBe(1);
    expect(stderr).toContain("volatile declaration");
  });

  it("reads the declarations the header carries, with no flag at all", () => {
    const cassettePath = path.join(tmpDir, "header.jsonl");
    fs.writeFileSync(
      cassettePath,
      [
        { ...HEAD, volatile: [AT] },
        c2s(0, call(1, { m: "hi", requestedAt: "2026-10-09T00:00:00Z" })),
        s2c(1, answer(1, "recorded")),
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n"
    );
    const stdout = execFileSync(process.execPath, [CLI, "replay", cassettePath], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      input: JSON.stringify(call(9, { m: "hi", requestedAt: "2031-01-01T00:00:00Z" })) + "\n",
    });
    expect(textOf(JSON.parse(stdout.trim()) as JsonRpcFrame)).toBe("recorded");
  });

  it("round-trips a header declaration through readCassette", () => {
    const cassettePath = path.join(tmpDir, "header.jsonl");
    expect(readCassette(cassettePath).header.volatile).toEqual([AT]);
  });
});

describe("through the vitest adapter", () => {
  const tape = useCassette(path.join(ROOT, "tests/fixtures/volatile.http.jsonl"), {
    volatile: ["/arguments/runId"],
  });

  it("answers a call whose declared fields moved, header and option together", async () => {
    // The cassette declares the stamp, the option declares the run id: the
    // request below moved both, and neither is what it is matched on.
    const res = await fetch(tape.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(call(9, { m: "hi", requestedAt: "2031-01-01T00:00:00Z", runId: "run-2" })),
    });
    expect(textOf((await res.json()) as JsonRpcFrame)).toBe("recorded");
  });
});

describe("a stdio cassette through the adapter", () => {
  const tape = useCassette(path.join(ROOT, "tests/fixtures/stdio-tape.jsonl"), {
    volatile: [AT, "tools/call:/arguments/runId"],
  });

  it("carries the declarations on the command it hands back", () => {
    // The process the client spawns is the one that has to honor them, so they
    // travel as flags rather than staying in this process.
    expect(tape.command.slice(-4)).toEqual([
      "--volatile",
      AT,
      "--volatile",
      "tools/call:/arguments/runId",
    ]);
  });
});
