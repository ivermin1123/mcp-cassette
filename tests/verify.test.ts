import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { diffValues, splitPointer } from "../src/diff.js";
import {
  classifyPair,
  collectVerifyPairs,
  isAllowedChange,
  normalizeForDiff,
  removePointer,
  verifyAgainstServer,
  verifyFailed,
} from "../src/verify.js";
import type { Cassette } from "../src/cassette.js";
import type { JsonRpcRequest, JsonRpcResponse } from "../src/jsonrpc.js";

const req = (id: number, method: string, params?: unknown): JsonRpcRequest => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params !== undefined ? { params } : {}),
});
const res = (id: number, result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
const errRes = (id: number, code: number, message: string): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

describe("diffValues", () => {
  it("reports nested object paths as JSON Pointers", () => {
    const changes = diffValues({ a: { b: 1, c: 2 } }, { a: { b: 1, c: 3 } });
    expect(changes).toEqual([{ path: "/a/c", recorded: 2, live: 3 }]);
  });

  it("reports added and removed keys", () => {
    const changes = diffValues({ a: 1 }, { b: 1 });
    expect(changes.map((c) => c.path).sort()).toEqual(["/a", "/b"]);
  });

  it("compares arrays positionally, including length changes", () => {
    expect(diffValues([1, 2], [1, 3]).map((c) => c.path)).toEqual(["/1"]);
    expect(diffValues([1], [1, 2]).map((c) => c.path)).toEqual(["/1"]);
  });

  it("escapes / and ~ in keys per RFC 6901", () => {
    const changes = diffValues({ "a/b": 1, "c~d": 2 }, { "a/b": 9, "c~d": 8 });
    expect(changes.map((c) => c.path).sort()).toEqual(["/a~1b", "/c~0d"]);
    expect(splitPointer("/a~1b")).toEqual(["a/b"]);
  });

  it("treats a container/primitive type change as one diff at that path", () => {
    expect(diffValues({ a: [1] }, { a: 1 })).toEqual([{ path: "/a", recorded: [1], live: 1 }]);
  });
});

describe("normalizeForDiff", () => {
  it("drops _meta and ttlMs at any depth", () => {
    const value = { _meta: { x: 1 }, deep: { ttlMs: 500, keep: true } };
    expect(normalizeForDiff(value)).toEqual({ deep: { keep: true } });
  });

  it("masks ISO timestamps, uuids, and epoch-like numbers to the same sentinel", () => {
    const a = normalizeForDiff({
      at: "2026-08-15T09:00:00Z",
      id: "123e4567-e89b-12d3-a456-426614174000",
      ts: 1755241200000,
      tsSec: 1755241200,
    });
    const b = normalizeForDiff({
      at: "2025-01-01 00:00:00.123+07:00",
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      ts: 1600000000000,
      tsSec: 1600000000,
    });
    expect(a).toEqual(b);
  });

  it("leaves ordinary values alone", () => {
    const value = { text: "hello 2026", n: 42, pi: 1234.5, arr: [1, "a"] };
    expect(normalizeForDiff(value)).toEqual(value);
  });
});

describe("removePointer", () => {
  it("removes object members and array elements; missing paths are a no-op", () => {
    const value: Record<string, unknown> = { a: { b: [10, 20, 30] }, keep: 1 };
    removePointer(value, "/a/b/1");
    expect(value).toEqual({ a: { b: [10, 30] }, keep: 1 });
    removePointer(value, "/does/not/exist");
    expect(value).toEqual({ a: { b: [10, 30] }, keep: 1 });
  });
});

describe("classifyPair", () => {
  it("MATCH when payloads agree after volatile stripping", () => {
    const recorded = res(1, { content: "x", _meta: { t: 1 }, at: "2026-01-01T00:00:00Z" });
    const live = res(9, { content: "x", at: "2026-08-15T00:00:00Z" });
    expect(classifyPair(recorded, live).status).toBe("MATCH");
  });

  it("CHANGED with the specific paths", () => {
    const { status, changes } = classifyPair(res(1, { a: 1, b: { c: "x" } }), res(2, { a: 1, b: { c: "y" } }));
    expect(status).toBe("CHANGED");
    expect(changes).toEqual([{ path: "/b/c", recorded: "x", live: "y" }]);
  });

  it("ERROR-SHAPE-CHANGED in both directions", () => {
    expect(classifyPair(res(1, {}), errRes(2, -32602, "bad")).status).toBe("ERROR-SHAPE-CHANGED");
    expect(classifyPair(errRes(1, -32602, "bad"), res(2, {})).status).toBe("ERROR-SHAPE-CHANGED");
  });

  it("diffs two errors by code/message", () => {
    expect(classifyPair(errRes(1, -32602, "bad"), errRes(2, -32602, "bad")).status).toBe("MATCH");
    const changed = classifyPair(errRes(1, -32602, "bad"), errRes(2, -32000, "bad"));
    expect(changed.status).toBe("CHANGED");
    expect(changed.changes.map((c) => c.path)).toEqual(["/code"]);
  });

  it("honors --ignore pointers relative to the payload", () => {
    const recorded = res(1, { stable: 1, count: 5 });
    const live = res(2, { stable: 1, count: 6 });
    expect(classifyPair(recorded, live).status).toBe("CHANGED");
    expect(classifyPair(recorded, live, { ignore: ["/count"] }).status).toBe("MATCH");
  });
});

describe("isAllowedChange", () => {
  it("matches exact pointers and nested paths, not prefixes of longer keys", () => {
    expect(isAllowedChange("/tools/0/description", ["/tools"])).toBe(true);
    expect(isAllowedChange("/tools", ["/tools"])).toBe(true);
    expect(isAllowedChange("/toolsExtra", ["/tools"])).toBe(false);
    expect(isAllowedChange("/anything", [""])).toBe(true);
    expect(isAllowedChange("/anything", [])).toBe(false);
  });
});

describe("collectVerifyPairs", () => {
  it("keeps ordered answered requests, skips initialize, notifications, and unanswered", () => {
    const cassette: Cassette = {
      header: {
        type: "header",
        cassetteVersion: 1,
        recorder: "test",
        startedAt: "2026-01-01T00:00:00Z",
        transport: "stdio",
      },
      entries: [
        { type: "frame", t: 0, dir: "c2s", frame: req(1, "initialize", {}) },
        { type: "frame", t: 1, dir: "s2c", frame: res(1, { ok: true }) },
        { type: "frame", t: 2, dir: "c2s", frame: { jsonrpc: "2.0", method: "notifications/initialized" } },
        { type: "frame", t: 3, dir: "c2s", frame: req(2, "tools/list", {}) },
        { type: "frame", t: 4, dir: "s2c", frame: res(2, { tools: [] }) },
        { type: "frame", t: 5, dir: "c2s", frame: req(3, "tools/call", { name: "echo", arguments: {} }) },
        // id 3 never answered → not verifiable
      ],
    };
    const pairs = collectVerifyPairs(cassette);
    expect(pairs.map((p) => p.request.method)).toEqual(["tools/list"]);
  });
});

describe("verify against a live server (e2e)", () => {
  const ROOT = path.resolve(__dirname, "..");
  const TINY = path.join(ROOT, "tests/fixtures/tiny-server.mjs");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cassette-verify-"));

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const header = {
    type: "header" as const,
    cassetteVersion: 1,
    recorder: "test",
    startedAt: "2026-01-01T00:00:00Z",
    transport: "stdio" as const,
  };

  const baseCassette = (): Cassette => ({
    header,
    entries: [
      { type: "frame", t: 0, dir: "c2s", frame: req(1, "tools/list", {}) },
      {
        type: "frame",
        t: 1,
        dir: "s2c",
        frame: res(1, {
          tools: [
            {
              name: "echo",
              description: "Echo a message back to the caller.",
              inputSchema: {
                type: "object",
                properties: { message: { type: "string", description: "Message to echo" } },
                required: ["message"],
              },
            },
            {
              name: "add",
              description: "Add two numbers.",
              inputSchema: {
                type: "object",
                properties: { a: { type: "number" }, b: { type: "number" } },
                required: ["a", "b"],
              },
            },
            {
              name: "slugify",
              description: "Turn a title into a URL slug.",
              inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
            },
          ],
        }),
      },
      { type: "frame", t: 2, dir: "c2s", frame: req(2, "tools/call", { name: "echo", arguments: { message: "hi" } }) },
      {
        type: "frame",
        t: 3,
        dir: "s2c",
        frame: res(2, { content: [{ type: "text", text: "echo:hi #1" }] }),
      },
    ],
  });

  it("MATCHes a cassette that is still true, exit-clean", async () => {
    const results = await verifyAgainstServer(baseCassette(), ["node", TINY]);
    expect(results.map((r) => [r.label, r.status])).toEqual([
      ["tools/list", "MATCH"],
      ["tools/call echo", "MATCH"],
    ]);
    expect(verifyFailed(results)).toBe(false);
  }, 20_000);

  it("flags CHANGED with concrete paths when the server drifts (v2 fixture)", async () => {
    const v2 = [process.execPath, "-e", `process.env.TINY_V2="1";import(${JSON.stringify(TINY)})`];
    const results = await verifyAgainstServer(baseCassette(), v2);
    const toolsList = results[0]!;
    expect(toolsList.status).toBe("CHANGED");
    // v2 removed slugify and changed add's schema — the paths say so.
    expect(toolsList.changes.some((c) => c.path.startsWith("/tools/"))).toBe(true);
    expect(verifyFailed(results)).toBe(true);
  }, 20_000);

  it("waives drift under --allow-changed-paths but nothing else", async () => {
    const v2 = [process.execPath, "-e", `process.env.TINY_V2="1";import(${JSON.stringify(TINY)})`];
    const waived = await verifyAgainstServer(baseCassette(), v2, { allowChangedPaths: ["/tools"] });
    expect(waived[0]!.status).toBe("CHANGED");
    expect(waived[0]!.allowed).toBe(true);
    // echo's reply also drifts in v2? It does not — the call still matches.
    expect(verifyFailed(waived)).toBe(false);

    const notCovering = await verifyAgainstServer(baseCassette(), v2, { allowChangedPaths: ["/unrelated"] });
    expect(verifyFailed(notCovering)).toBe(true);
  }, 20_000);

  it("classifies ERROR-SHAPE-CHANGED and MISSING", async () => {
    const cassette: Cassette = {
      header,
      entries: [
        // Recorded a result for a method the live server rejects → error shape flips.
        { type: "frame", t: 0, dir: "c2s", frame: req(1, "gone/method", {}) },
        { type: "frame", t: 1, dir: "s2c", frame: res(1, { ok: true }) },
        // Recorded a response for a method the live server never answers → MISSING.
        { type: "frame", t: 2, dir: "c2s", frame: req(2, "block", {}) },
        { type: "frame", t: 3, dir: "s2c", frame: res(2, { ok: true }) },
      ],
    };
    const results = await verifyAgainstServer(cassette, ["node", TINY], { timeoutMs: 1500 });
    expect(results[0]!.status).toBe("ERROR-SHAPE-CHANGED");
    expect(results[0]!.detail).toContain("-32601");
    expect(results[1]!.status).toBe("MISSING");
    expect(verifyFailed(results)).toBe(true);
  }, 20_000);
});
