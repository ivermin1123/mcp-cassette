/**
 * Expected verdict: 2 passed.
 *
 * `onMiss: "warn"` leaves the JSON-RPC error frame as the only signal, for
 * suites that assert on it directly. The miss must still be drained, or it
 * would be reported against whichever test ran next.
 */
import { describe, expect, it } from "vitest";
import { useCassette } from "../../../src/vitest/index.js";
import { call, post } from "./helpers.js";

describe("warn mode", () => {
  const tape = useCassette(new URL("tape.http.jsonl", import.meta.url).pathname, { onMiss: "warn" });

  it("spends the recording", async () => {
    const res = await post(tape.url, call(1, "echo", { m: "recorded" }));
    expect(await res.json()).toMatchObject({ result: {} });
  });

  it("hands the miss back as a JSON-RPC error instead of failing", async () => {
    const res = await post(tape.url, call(2, "echo", { m: "drifted" }));
    const body = (await res.json()) as { error?: { code: number; message: string } };
    expect(body.error?.code).toBe(-32601);
    expect(tape.server.misses()).toBe(1);
  });
});
