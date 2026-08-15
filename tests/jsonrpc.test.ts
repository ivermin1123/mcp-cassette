import { describe, expect, it } from "vitest";
import { LineBuffer, parseFrame, stableStringify, isRequest, isNotification, isResponse } from "../src/jsonrpc.js";

describe("LineBuffer", () => {
  it("emits complete lines and buffers partials across chunks", () => {
    const buf = new LineBuffer();
    expect(buf.feed('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(buf.feed(':2}\n')).toEqual(['{"b":2}']);
    expect(buf.feed("no newline yet")).toEqual([]);
    expect(buf.flush()).toBe("no newline yet");
  });

  it("handles multiple frames in one chunk", () => {
    const buf = new LineBuffer();
    expect(buf.feed("a\nb\nc\n")).toEqual(["a", "b", "c"]);
  });
});

describe("parseFrame", () => {
  it("accepts JSON-RPC frames and rejects other lines", () => {
    expect(parseFrame('{"jsonrpc":"2.0","id":1,"method":"x"}')).not.toBeNull();
    expect(parseFrame("plain log output")).toBeNull();
    expect(parseFrame('{"not":"jsonrpc"}')).toBeNull();
    expect(parseFrame("")).toBeNull();
  });

  it("classifies frames", () => {
    const req = parseFrame('{"jsonrpc":"2.0","id":1,"method":"m"}')!;
    const notif = parseFrame('{"jsonrpc":"2.0","method":"m"}')!;
    const res = parseFrame('{"jsonrpc":"2.0","id":1,"result":{}}')!;
    expect(isRequest(req)).toBe(true);
    expect(isNotification(notif)).toBe(true);
    expect(isResponse(res)).toBe(true);
    expect(isRequest(notif)).toBe(false);
    expect(isNotification(req)).toBe(false);
  });
});

describe("stableStringify", () => {
  it("is order-insensitive for object keys, order-sensitive for arrays", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });
});
