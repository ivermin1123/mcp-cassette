/**
 * Properties of the contract diff.
 *
 * The gate is only worth wiring into CI if it is quiet when nothing changed.
 * A diff that invents a finding on an unchanged contract trains everyone to
 * ignore it, which costs more than having no gate at all.
 *
 * `diff(s, s) = ∅` is the reflexivity law, and it is not free: the diff walks
 * schemas structurally, and any place it compares two values by identity or by
 * unsorted serialization is a place where a contract equals itself and still
 * reports drift.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  CONTRACT_RULES,
  countChanges,
  diffContracts,
  shouldFail,
  type ContractSnapshot,
} from "../../src/snapshot.js";

const jsonSchema = fc.letrec((tie) => ({
  schema: fc.record(
    {
      type: fc.constantFrom("object", "string", "number", "integer", "boolean", "array"),
      description: fc.string({ maxLength: 20 }),
      default: fc.jsonValue(),
      enum: fc.array(fc.oneof(fc.string(), fc.integer()), { maxLength: 4 }),
      required: fc.array(fc.string({ minLength: 1, maxLength: 6 }), { maxLength: 4 }),
      properties: fc.dictionary(fc.string({ minLength: 1, maxLength: 6 }), tie("schema"), {
        maxKeys: 4,
      }),
    },
    { requiredKeys: [] }
  ),
})).schema;

const contractTool = fc.record(
  {
    name: fc.string({ minLength: 1, maxLength: 10 }),
    description: fc.string({ maxLength: 30 }),
    inputSchema: jsonSchema,
    annotations: fc.dictionary(fc.string({ minLength: 1, maxLength: 6 }), fc.jsonValue(), {
      maxKeys: 3,
    }),
  },
  { requiredKeys: ["name"] }
);

const snapshot: fc.Arbitrary<ContractSnapshot> = fc
  .record({
    mcpCassetteContract: fc.constant(1 as const),
    capturedAt: fc.string(),
    tools: fc.uniqueArray(contractTool, { selector: (t) => t.name, maxLength: 6 }),
  })
  .map((value) => JSON.parse(JSON.stringify(value)) as ContractSnapshot);

/** Same tools, different array order. */
function rotate<T>(items: readonly T[], by: number): T[] {
  if (items.length === 0) return [];
  const at = by % items.length;
  return [...items.slice(at), ...items.slice(0, at)];
}

describe("diffContracts", () => {
  it("reports nothing when a contract is compared with itself", () => {
    fc.assert(
      fc.property(snapshot, (snap) => {
        expect(diffContracts(snap, snap)).toEqual([]);
      })
    );
  });

  it("reports nothing when a contract is compared with a fresh copy of itself", () => {
    // Structural sharing could hide an identity comparison; a deep copy cannot.
    fc.assert(
      fc.property(snapshot, (snap) => {
        expect(diffContracts(snap, JSON.parse(JSON.stringify(snap)))).toEqual([]);
      })
    );
  });

  it("ignores the order tools were listed in, and when they were captured", () => {
    fc.assert(
      fc.property(snapshot, fc.nat({ max: 10 }), fc.string(), (snap, by, capturedAt) => {
        expect(diffContracts(snap, { ...snap, capturedAt, tools: rotate(snap.tools, by) })).toEqual(
          []
        );
      })
    );
  });

  it("notices every removed tool, and only those, when tools are dropped", () => {
    fc.assert(
      fc.property(snapshot, fc.nat({ max: 10 }), (snap, drop) => {
        fc.pre(snap.tools.length > 0);
        const keep = snap.tools.slice(0, drop % snap.tools.length);
        const removed = snap.tools.slice(keep.length).map((t) => t.name);
        const changes = diffContracts(snap, { ...snap, tools: keep });

        expect(changes.map((c) => c.rule)).toEqual(removed.map(() => CONTRACT_RULES.toolRemoved));
        expect(changes.map((c) => c.subject).sort()).toEqual([...removed].sort());
      })
    );
  });

  it("keeps counts consistent with the changes they summarize", () => {
    fc.assert(
      fc.property(snapshot, snapshot, (before, after) => {
        const changes = diffContracts(before, after);
        const counts = countChanges(changes);
        expect(counts.breaking + counts.dangerous + counts.minor + counts.info).toBe(changes.length);
        expect(shouldFail(changes, "breaking")).toBe(counts.breaking > 0);
        expect(shouldFail(changes, "dangerous")).toBe(counts.breaking + counts.dangerous > 0);
      })
    );
  });
});
