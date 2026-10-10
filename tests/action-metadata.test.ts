/**
 * GitHub Marketplace reads `name`, `description` and `branding` from
 * `action.yml`, and refuses to list an action whose description is 125
 * characters or longer. Nothing else checks that: the action runs the same
 * with any description, so 0.9.0 shipped one of 136 characters and the refusal
 * would have been the first anyone heard of it.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const yaml = fs.readFileSync(path.resolve(__dirname, "../action.yml"), "utf8");

/** The top-level `description:`, a folded `>-` block, joined as YAML folds it. */
const description = (): string | undefined => {
  const block = /^description: >-\n((?: {2}.*\n)+)/m.exec(yaml)?.[1];
  return block
    ?.split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
};

describe("the action's Marketplace metadata", () => {
  it("has a description Marketplace accepts", () => {
    const text = description();
    expect(text, "action.yml's top-level `description`").toBeTruthy();
    expect(text!.length, text).toBeLessThan(125);
  });

  it("names the action and brands it", () => {
    expect(yaml).toMatch(/^name: \S/m);
    expect(yaml).toMatch(/^branding:\n {2}icon: \S+\n {2}color: \S+$/m);
  });
});
