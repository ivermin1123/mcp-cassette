/** Expected verdict: 1 passed. A recorded call is answered from the cassette. */
import { describe, expect, it } from "vitest";
import { useCassette } from "../../../src/vitest/index.js";
import { call, post } from "./helpers.js";

describe("recorded call", () => {
  const tape = useCassette(new URL("tape.http.jsonl", import.meta.url).pathname);

  it("is answered from the cassette", async () => {
    const res = await post(tape.url, call(1, "echo", { m: "recorded" }));
    expect(await res.json()).toMatchObject({ result: { content: [{ text: "recorded" }] } });
  });
});
