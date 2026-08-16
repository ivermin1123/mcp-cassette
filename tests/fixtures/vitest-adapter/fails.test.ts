/**
 * Expected verdict: 1 passed, 2 failed.
 *
 * The point of the whole fixture project: a miss has to *fail the test*, not
 * arrive as a JSON-RPC error the assertion never looks at. Both failures also
 * have to be attributed to the test that caused them, which is what proves the
 * afterEach drain — the second failure must not inherit the first one's miss.
 */
import { describe, expect, it } from "vitest";
import { useCassette } from "../../../src/vitest/index.js";
import { call, post } from "./helpers.js";

describe("misses fail the test that caused them", () => {
  const tape = useCassette(new URL("tape.http.jsonl", import.meta.url).pathname);

  // Spends the single recording, so the two tests after it genuinely miss
  // instead of being answered by the engine's method-pool fallback.
  it("spends the recording", async () => {
    const res = await post(tape.url, call(1, "echo", { m: "recorded" }));
    expect(await res.json()).toMatchObject({ result: {} });
  });

  it("fails with a mismatch when the arguments drifted", async () => {
    await post(tape.url, call(2, "echo", { m: "drifted" }));
    // No assertion here on purpose: afterEach is what must fail this test.
  });

  it("fails with a miss when the tool was never recorded", async () => {
    await post(tape.url, call(3, "never-recorded", {}));
  });
});
