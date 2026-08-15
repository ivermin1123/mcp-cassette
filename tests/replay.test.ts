import { describe, expect, it } from "vitest";
import { buildReplayIndex, fingerprint, handleFrame } from "../src/replay.js";
import { redactFrame } from "../src/redact.js";
import type { Cassette } from "../src/cassette.js";
import type { JsonRpcRequest, JsonRpcResponse } from "../src/jsonrpc.js";

function cassetteWith(
  pairs: Array<[JsonRpcRequest, JsonRpcResponse]>,
  redaction?: { applied: boolean }
): Cassette {
  const entries = pairs.flatMap(([req, res], i) => [
    { type: "frame" as const, t: i * 2, dir: "c2s" as const, frame: req },
    { type: "frame" as const, t: i * 2 + 1, dir: "s2c" as const, frame: res },
  ]);
  return {
    header: {
      type: "header",
      cassetteVersion: 1,
      recorder: "test",
      startedAt: "2026-01-01T00:00:00Z",
      transport: "stdio",
      ...(redaction ? { redaction } : {}),
    },
    entries,
  };
}

const req = (id: number, method: string, params?: unknown): JsonRpcRequest => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params !== undefined ? { params } : {}),
});
const res = (id: number, result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });

describe("fingerprint", () => {
  it("matches initialize by method only (clientInfo varies)", () => {
    expect(fingerprint({ method: "initialize", params: { clientInfo: { name: "a" } } })).toBe(
      fingerprint({ method: "initialize", params: { clientInfo: { name: "b" } } })
    );
  });

  it("matches tools/call by name + arguments and ignores _meta", () => {
    const a = fingerprint({
      method: "tools/call",
      params: { name: "echo", arguments: { x: 1 }, _meta: { progressToken: "p1" } },
    });
    const b = fingerprint({ method: "tools/call", params: { name: "echo", arguments: { x: 1 } } });
    const c = fingerprint({ method: "tools/call", params: { name: "echo", arguments: { x: 2 } } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("replay matching", () => {
  it("replays recorded responses re-keyed to the incoming id", () => {
    const cassette = cassetteWith([
      [req(1, "initialize", { protocolVersion: "2025-06-18" }), res(1, { serverInfo: { name: "s" } })],
      [req(2, "tools/list", {}), res(2, { tools: [{ name: "echo" }] })],
    ]);
    const index = buildReplayIndex(cassette);

    const out1 = handleFrame(index, req(101, "initialize", { protocolVersion: "other" }))!;
    expect(out1).toMatchObject({ id: 101, result: { serverInfo: { name: "s" } } });

    const out2 = handleFrame(index, req(102, "tools/list", {}))!;
    expect(out2).toMatchObject({ id: 102, result: { tools: [{ name: "echo" }] } });
  });

  it("consumes repeated identical calls in recorded order", () => {
    const cassette = cassetteWith([
      [req(1, "tools/call", { name: "echo", arguments: { m: "x" } }), res(1, { content: "first" })],
      [req(2, "tools/call", { name: "echo", arguments: { m: "x" } }), res(2, { content: "second" })],
    ]);
    const index = buildReplayIndex(cassette);
    expect(handleFrame(index, req(11, "tools/call", { name: "echo", arguments: { m: "x" } }))).toMatchObject({
      result: { content: "first" },
    });
    expect(handleFrame(index, req(12, "tools/call", { name: "echo", arguments: { m: "x" } }))).toMatchObject({
      result: { content: "second" },
    });
  });

  it("falls back to same-method responses on fingerprint miss", () => {
    const cassette = cassetteWith([
      [req(1, "tools/call", { name: "echo", arguments: { m: "recorded" } }), res(1, { content: "ok" })],
    ]);
    const index = buildReplayIndex(cassette);
    const out = handleFrame(index, req(9, "tools/call", { name: "echo", arguments: { m: "different" } }))!;
    expect(out).toMatchObject({ result: { content: "ok" } });
  });

  it("returns a clear JSON-RPC error when nothing is recorded", () => {
    const cassette = cassetteWith([]);
    const index = buildReplayIndex(cassette);
    const out = handleFrame(index, req(1, "tools/call", { name: "missing", arguments: {} }))!;
    expect(out).toMatchObject({ id: 1, error: { code: -32601 } });
  });

  it("answers ping even when not recorded, ignores notifications", () => {
    const index = buildReplayIndex(cassetteWith([]));
    expect(handleFrame(index, req(5, "ping"))).toMatchObject({ id: 5, result: {} });
    expect(handleFrame(index, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });
});

describe("replay matching after redaction", () => {
  // The recorded cassette only ever saw placeholders; the live client still
  // sends the real credentials. Both must land on the same fingerprint.
  const TOKEN_A = "ghp_NOTAREALTOKENAAAAAAAAAAAAAAAAAAAA";
  const TOKEN_B = "ghp_NOTAREALTOKENBBBBBBBBBBBBBBBBBBBB";

  const callWith = (id: number, token: string): JsonRpcRequest =>
    req(id, "tools/call", { name: "deploy", arguments: { token } });

  /** Two calls that differ only by the secret — so a wrong match is visible. */
  const redactedCassette = () =>
    cassetteWith(
      [
        [redactFrame(callWith(1, TOKEN_A)) as JsonRpcRequest, res(1, { content: "A" })],
        [redactFrame(callWith(2, TOKEN_B)) as JsonRpcRequest, res(2, { content: "B" })],
      ],
      { applied: true }
    );

  it("matches a live secret against its redacted recording", () => {
    const index = buildReplayIndex(redactedCassette());
    expect(handleFrame(index, callWith(99, TOKEN_B))).toMatchObject({
      id: 99,
      result: { content: "B" },
    });
    expect(handleFrame(index, callWith(100, TOKEN_A))).toMatchObject({
      id: 100,
      result: { content: "A" },
    });
  });

  it("also matches a request that is already redacted", () => {
    const index = buildReplayIndex(redactedCassette());
    const already = redactFrame(callWith(7, TOKEN_B)) as JsonRpcRequest;
    expect(handleFrame(index, already)).toMatchObject({ id: 7, result: { content: "B" } });
  });

  it("would mismatch without redaction-aware matching", () => {
    // Same cassette, header claims no redaction: the live token no longer
    // fingerprints, so matching degrades to the recorded-order fallback.
    const notMarked = redactedCassette();
    delete notMarked.header.redaction;
    const index = buildReplayIndex(notMarked);
    expect(handleFrame(index, callWith(99, TOKEN_B))).toMatchObject({ result: { content: "A" } });
  });

  it("leaves unredacted cassettes matching on raw values", () => {
    const index = buildReplayIndex(
      cassetteWith([[callWith(1, TOKEN_A), res(1, { content: "raw" })]])
    );
    expect(index.redactRequests).toBe(false);
    expect(handleFrame(index, callWith(50, TOKEN_A))).toMatchObject({ result: { content: "raw" } });
  });
});
