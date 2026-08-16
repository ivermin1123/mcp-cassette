import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { CONTRACT_RULES, diffContracts, shouldFail } from "../src/snapshot.js";
import type { ContractSnapshot } from "../src/snapshot.js";

/**
 * These fixtures were captured from a running FastMCP server, not written here.
 * See tests/fixtures/contracts/README.md for the toolchain and the two edits
 * that separate them. The point of the exercise is that Pydantic pushes the
 * whole argument contract into `$defs` and leaves the tool's own `properties`
 * as a single `$ref`, so the interesting change is invisible at the top level.
 */
const load = (name: string): ContractSnapshot =>
  JSON.parse(readFileSync(`tests/fixtures/contracts/${name}`, "utf8")) as ContractSnapshot;

const BASE = "pydantic-nested.contract.json";
const DEFS_ONLY = "pydantic-nested-defs-changed.contract.json";
const DEFS_AND_ROOT = "pydantic-nested-defs-changed-and-root-relaxed.contract.json";

const unclassified = (changes: readonly { rule: string }[]) =>
  changes.filter((c) => c.rule === CONTRACT_RULES.inputSchemaChangedUnclassified);

describe("a $ref the diff cannot resolve", () => {
  it("is what the fixture actually contains, or the rest of this file proves nothing", () => {
    const tool = load(BASE).tools[0]!;
    const json = JSON.stringify(tool.inputSchema);
    expect(json).toContain('"$defs"');
    expect(json.match(/"\$ref"/g)).toHaveLength(4);
    // The whole contract is one level down: the tool's own property is a pointer.
    expect((tool.inputSchema as { properties: Record<string, unknown> }).properties.user).toEqual({
      $ref: "#/$defs/User",
    });
  });

  it("fails the gate when only $defs changed", () => {
    const changes = diffContracts(load(BASE), load(DEFS_ONLY));
    expect(unclassified(changes)).toHaveLength(1);
    expect(shouldFail(changes, "breaking")).toBe(true);
  });

  // The regression. Before the guard this returned `PASS (0 breaking, 1
  // dangerous, 1 minor)` and exit 0 — a required nested field went from string
  // to integer and CI stayed green, because the root-level `minor` below
  // suppressed the fallback that would otherwise have caught it.
  it("still fails the gate when a root-level change reports first", () => {
    const changes = diffContracts(load(BASE), load(DEFS_AND_ROOT));

    expect(changes.map((c) => c.rule)).toContain(CONTRACT_RULES.inputPropertyBecameOptional);
    expect(changes.map((c) => c.rule)).toContain(CONTRACT_RULES.inputPropertyDefaultChanged);

    expect(unclassified(changes)).toHaveLength(1);
    expect(shouldFail(changes, "breaking")).toBe(true);
  });

  it("says why it gave up, so the message is actionable", () => {
    const [finding] = unclassified(diffContracts(load(BASE), load(DEFS_ONLY)));
    expect(finding!.message).toContain("$ref");
    expect(finding!.kind).toBe("breaking");
  });

  it("stays quiet when a schema carrying a $ref did not change", () => {
    expect(diffContracts(load(BASE), load(BASE))).toEqual([]);
  });

  it("does not fire on schemas that carry no $ref", () => {
    const snap = (inputSchema: unknown): ContractSnapshot =>
      ({
        mcpCassetteContract: 1,
        capturedAt: "2026-08-16T00:00:00.000Z",
        server: { name: "s", version: "1" },
        protocolVersion: "2025-06-18",
        tools: [{ name: "t", description: "d", inputSchema }],
      }) as ContractSnapshot;

    const changes = diffContracts(
      snap({ type: "object", required: ["a"], properties: { a: { type: "string" } } }),
      snap({ type: "object", required: [], properties: { a: { type: "string" } } })
    );

    expect(changes.map((c) => c.rule)).toEqual([CONTRACT_RULES.inputPropertyBecameOptional]);
    expect(shouldFail(changes, "breaking")).toBe(false);
  });
});
