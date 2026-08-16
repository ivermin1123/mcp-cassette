import { describe, expect, it } from "vitest";
import { CONTRACT_RULES, diffContracts, type ContractSnapshot } from "../src/snapshot.js";

function snap(inputSchema: unknown): ContractSnapshot {
  return {
    mcpCassetteContract: 1,
    capturedAt: "2026-01-01T00:00:00Z",
    tools: [{ name: "add", description: "Add numbers", inputSchema }],
  };
}

function diff(before: unknown, after: unknown) {
  return diffContracts(snap(before), snap(after));
}

const rules = (before: unknown, after: unknown) => diff(before, after).map((c) => c.rule);

/**
 * The defect these cover is the one a contract gate can least afford: the engine
 * asked whether the *whole tool* had produced any finding, so one `minor` at the
 * root swallowed every breaking change nested below it and the gate went green.
 */
describe("nested changes survive a finding at the root", () => {
  it("reports a nested type change even when the root emits a minor", () => {
    const changes = diff(
      {
        type: "object",
        properties: { a: { type: "object", properties: { x: { type: "string" } } } },
        required: ["a"],
      },
      {
        type: "object",
        properties: { a: { type: "object", properties: { x: { type: "number" } } } },
        required: [],
      }
    );

    expect(changes.map((c) => c.rule)).toContain(CONTRACT_RULES.inputPropertyBecameOptional);
    const nested = changes.find((c) => c.rule === CONTRACT_RULES.inputPropertyTypeChanged);
    expect(nested).toBeDefined();
    expect(nested?.kind).toBe("breaking");
    expect(nested?.message).toContain("/properties/a");
  });

  it("reports a nested property removal even when the root emits a dangerous add", () => {
    const changes = diff(
      {
        type: "object",
        properties: { a: { type: "object", properties: { y: { type: "string" } } } },
      },
      {
        type: "object",
        properties: { a: { type: "object", properties: {} }, z: { type: "string" } },
      }
    );

    expect(changes.map((c) => c.rule)).toContain(CONTRACT_RULES.inputPropertyAddedOptional);
    const removed = changes.find((c) => c.rule === CONTRACT_RULES.inputPropertyRemoved);
    expect(removed?.kind).toBe("breaking");
    expect(removed?.message).toContain("/properties/a");
  });

  it("reports a nested required addition at its pointer", () => {
    const changes = diff(
      { type: "object", properties: { a: { type: "object", required: [], properties: { x: { type: "string" } } } } },
      { type: "object", properties: { a: { type: "object", required: ["x"], properties: { x: { type: "string" } } } } }
    );
    const found = changes.find((c) => c.rule === CONTRACT_RULES.inputPropertyBecameRequired);
    expect(found?.kind).toBe("breaking");
    expect(found?.message).toContain("/properties/a");
  });

  it("reports an unclassified keyword at the node that carries it, not at the root", () => {
    const changes = diff(
      { type: "object", properties: { a: { type: "string", maxLength: 100 } } },
      { type: "object", properties: { a: { type: "string", maxLength: 10 } } }
    );
    const found = changes.find((c) => c.rule === CONTRACT_RULES.inputSchemaChangedUnclassified);
    expect(found?.kind).toBe("breaking");
    expect(found?.message).toContain("/properties/a");
  });
});

/**
 * Order is not meaning. Every case here used to be reported as breaking, which
 * turns a consumer's CI red for a change that binds nobody.
 */
describe("spellings of the same meaning are not changes", () => {
  it("ignores required order", () => {
    expect(
      rules(
        { type: "object", properties: { a: {}, b: {} }, required: ["a", "b"] },
        { type: "object", properties: { a: {}, b: {} }, required: ["b", "a"] }
      )
    ).toEqual([]);
  });

  it("ignores enum order", () => {
    expect(
      rules(
        { type: "object", properties: { a: { enum: ["x", "y"] } } },
        { type: "object", properties: { a: { enum: ["y", "x"] } } }
      )
    ).toEqual([]);
  });

  it("ignores union type order", () => {
    expect(
      rules(
        { type: "object", properties: { a: { type: ["string", "null"] } } },
        { type: "object", properties: { a: { type: ["null", "string"] } } }
      )
    ).toEqual([]);
  });

  it("treats absent, empty-object and true additionalProperties as one thing", () => {
    expect(
      rules(
        { type: "object", properties: { a: {} } },
        { type: "object", properties: { a: {} }, additionalProperties: {} }
      )
    ).toEqual([]);
    expect(
      rules(
        { type: "object", properties: { a: {} }, additionalProperties: true },
        { type: "object", properties: { a: {} } }
      )
    ).toEqual([]);
  });
});

describe("prose changes report as info, never as breaking", () => {
  it("classifies a changed parameter description as info", () => {
    const changes = diff(
      { type: "object", properties: { a: { type: "string", description: "before" } } },
      { type: "object", properties: { a: { type: "string", description: "after" } } }
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]!.rule).toBe(CONTRACT_RULES.inputAnnotationChanged);
    expect(changes[0]!.kind).toBe("info");
  });

  it("classifies a deeply nested description change as info", () => {
    const changes = diff(
      { type: "object", properties: { a: { type: "object", properties: { x: { title: "before" } } } } },
      { type: "object", properties: { a: { type: "object", properties: { x: { title: "after" } } } } }
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe("info");
  });

  it("does not let a prose change hide a real one", () => {
    const changes = diff(
      { type: "object", properties: { a: { type: "string", description: "before" } } },
      { type: "object", properties: { a: { type: "number", description: "after" } } }
    );
    expect(changes.map((c) => c.rule)).toContain(CONTRACT_RULES.inputPropertyTypeChanged);
  });
});

/**
 * Reference resolution is not implemented. The honest failure is to say so; the
 * dangerous one is to emit a specific rule ID about a shape never inspected.
 */
describe("$ref guard", () => {
  const withRef = (target: string) => ({
    type: "object",
    properties: { a: { $ref: "#/$defs/thing" } },
    $defs: { thing: { type: target } },
  });

  it("stays silent when a $ref schema is unchanged", () => {
    expect(rules(withRef("string"), withRef("string"))).toEqual([]);
  });

  it("reports one unclassified breaking change and no specific rule", () => {
    const changes = diff(withRef("string"), withRef("number"));
    expect(changes).toHaveLength(1);
    expect(changes[0]!.rule).toBe(CONTRACT_RULES.inputSchemaRefUnclassified);
    expect(changes[0]!.kind).toBe("breaking");
    expect(changes[0]!.message).toContain("$ref");
  });

  it("guards even when the $ref appears only on the new side", () => {
    const changes = diff(
      { type: "object", properties: { a: { type: "string" } } },
      { type: "object", properties: { a: { $ref: "#/$defs/thing" } }, $defs: { thing: { type: "string" } } }
    );
    expect(changes.map((c) => c.rule)).toEqual([CONTRACT_RULES.inputSchemaRefUnclassified]);
  });
});

describe("delegation never swallows a difference", () => {
  it("still reports an items change that cannot be recursed into", () => {
    const changes = diff(
      { type: "object", properties: { tags: { type: "array", items: { type: "string" } } } },
      { type: "object", properties: { tags: { type: "array", items: [{ type: "string" }] } } }
    );
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.some((c) => c.kind === "breaking")).toBe(true);
  });

  it("reports a change inside items at its pointer", () => {
    const changes = diff(
      { type: "object", properties: { tags: { type: "array", items: { type: "string", maxLength: 5 } } } },
      { type: "object", properties: { tags: { type: "array", items: { type: "string", maxLength: 50 } } } }
    );
    const found = changes.find((c) => c.rule === CONTRACT_RULES.inputSchemaChangedUnclassified);
    expect(found?.message).toContain("/properties/tags/items");
  });

  it("still reports a root-level default change", () => {
    const changes = diff(
      { type: "object", properties: { a: { type: "string", default: "x" } } },
      { type: "object", properties: { a: { type: "string", default: "y" } } }
    );
    expect(changes.map((c) => c.rule)).toContain(CONTRACT_RULES.inputPropertyDefaultChanged);
  });
});
