import { describe, expect, it } from "vitest";
import {
  CONTRACT_RULES,
  countChanges,
  diffContracts,
  shouldFail,
  type ContractChange,
  type ContractSnapshot,
} from "../src/snapshot.js";

function snap(tools: ContractSnapshot["tools"]): ContractSnapshot {
  return { mcpCassetteContract: 1, capturedAt: "2026-01-01T00:00:00Z", tools };
}

const baseTool = {
  name: "add",
  description: "Add numbers",
  inputSchema: {
    type: "object",
    properties: { a: { type: "number" }, b: { type: "number" } },
    required: ["a", "b"],
  },
};

/** The same tool with a replaced inputSchema — the shape most cases vary. */
function withSchema(inputSchema: unknown) {
  return { ...baseTool, inputSchema };
}

function ruleOf(changes: ContractChange[], rule: string): ContractChange | undefined {
  return changes.find((c) => c.rule === rule);
}

describe("diffContracts", () => {
  it("reports no changes for identical contracts", () => {
    expect(diffContracts(snap([baseTool]), snap([baseTool]))).toEqual([]);
  });

  it("classifies removed tool as breaking, added tool as minor", () => {
    const changes = diffContracts(
      snap([baseTool, { name: "old", inputSchema: { type: "object" } }]),
      snap([baseTool, { name: "new", inputSchema: { type: "object" } }])
    );
    expect(changes).toContainEqual({
      kind: "breaking",
      rule: CONTRACT_RULES.toolRemoved,
      subject: "old",
      message: "tool removed",
    });
    expect(changes).toContainEqual({
      kind: "minor",
      rule: CONTRACT_RULES.toolAdded,
      subject: "new",
      message: "tool added",
    });
  });

  it("classifies newly-required parameter as breaking", () => {
    const changes = diffContracts(
      snap([baseTool]),
      snap([
        withSchema({
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" }, c: { type: "number" } },
          required: ["a", "b", "c"],
        }),
      ])
    );
    expect(ruleOf(changes, CONTRACT_RULES.inputPropertyBecameRequired)?.kind).toBe("breaking");
    expect(ruleOf(changes, CONTRACT_RULES.inputPropertyAddedRequired)?.kind).toBe("breaking");
  });

  it("classifies a relaxed requirement as minor", () => {
    const changes = diffContracts(
      snap([baseTool]),
      snap([
        withSchema({
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a"],
        }),
      ])
    );
    expect(changes).toEqual([
      {
        kind: "minor",
        rule: CONTRACT_RULES.inputPropertyBecameOptional,
        subject: "add",
        message: 'parameter "b" is no longer required',
      },
    ]);
  });

  it("classifies an added optional parameter as dangerous", () => {
    const changes = diffContracts(
      snap([baseTool]),
      snap([
        withSchema({
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" }, verbose: { type: "boolean" } },
          required: ["a", "b"],
        }),
      ])
    );
    expect(changes).toEqual([
      {
        kind: "dangerous",
        rule: CONTRACT_RULES.inputPropertyAddedOptional,
        subject: "add",
        message: 'parameter "verbose" added',
      },
    ]);
  });

  it("classifies parameter type change and removed parameter as breaking", () => {
    const changes = diffContracts(
      snap([baseTool]),
      snap([withSchema({ type: "object", properties: { a: { type: "string" } }, required: ["a"] })])
    );
    expect(ruleOf(changes, CONTRACT_RULES.inputPropertyTypeChanged)).toEqual({
      kind: "breaking",
      rule: CONTRACT_RULES.inputPropertyTypeChanged,
      subject: "add",
      message: 'parameter "a" type changed: number → string',
    });
    expect(ruleOf(changes, CONTRACT_RULES.inputPropertyRemoved)?.kind).toBe("breaking");
  });

  it("classifies a root schema type change as breaking", () => {
    const changes = diffContracts(
      snap([withSchema({ type: "object", properties: {} })]),
      snap([withSchema({ type: "array", properties: {} })])
    );
    expect(ruleOf(changes, CONTRACT_RULES.inputSchemaTypeChanged)?.kind).toBe("breaking");
  });

  it("classifies a non-object inputSchema swap as a wholesale replacement", () => {
    const changes = diffContracts(snap([withSchema({ type: "object" })]), snap([withSchema("nonsense")]));
    expect(changes).toEqual([
      {
        kind: "breaking",
        rule: CONTRACT_RULES.inputSchemaReplaced,
        subject: "add",
        message: "inputSchema replaced entirely",
      },
    ]);
  });

  it("classifies enum narrowing as breaking, widening as dangerous", () => {
    const withEnum = (values: string[]) => ({
      name: "mode",
      inputSchema: {
        type: "object",
        properties: { m: { type: "string", enum: values } },
        required: ["m"],
      },
    });
    const narrowed = diffContracts(snap([withEnum(["a", "b"])]), snap([withEnum(["a"])]));
    expect(ruleOf(narrowed, CONTRACT_RULES.inputEnumValueRemoved)?.kind).toBe("breaking");

    const widened = diffContracts(snap([withEnum(["a"])]), snap([withEnum(["a", "b"])]));
    expect(widened).toEqual([
      {
        kind: "dangerous",
        rule: CONTRACT_RULES.inputEnumValueAdded,
        subject: "mode",
        message: 'parameter "m" enum value "b" added',
      },
    ]);
  });

  it("classifies every shape of default-value drift as dangerous", () => {
    const withDefault = (prop: Record<string, unknown>) =>
      withSchema({
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number", ...prop } },
        required: ["a"],
      });

    const cases: Array<[Record<string, unknown>, Record<string, unknown>, string]> = [
      [{}, { default: 2 }, 'parameter "b" default added: 2'],
      [{ default: 2 }, {}, 'parameter "b" default removed (was 2)'],
      [{ default: 2 }, { default: 3 }, 'parameter "b" default changed: 2 → 3'],
    ];

    for (const [before, after, message] of cases) {
      const changes = diffContracts(snap([withDefault(before)]), snap([withDefault(after)]));
      expect(changes).toEqual([
        { kind: "dangerous", rule: CONTRACT_RULES.inputPropertyDefaultChanged, subject: "add", message },
      ]);
    }
  });

  it("classifies description and annotation changes as info", () => {
    expect(diffContracts(snap([baseTool]), snap([{ ...baseTool, description: "Sum" }]))).toEqual([
      {
        kind: "info",
        rule: CONTRACT_RULES.toolDescriptionChanged,
        subject: "add",
        message: "description changed",
      },
    ]);
    expect(
      diffContracts(snap([baseTool]), snap([{ ...baseTool, annotations: { readOnlyHint: true } }]))
    ).toEqual([
      {
        kind: "info",
        rule: CONTRACT_RULES.toolAnnotationsChanged,
        subject: "add",
        message: "annotations changed",
      },
    ]);
  });

  it("treats unclassified structural schema changes conservatively as breaking", () => {
    const changes = diffContracts(
      snap([baseTool]),
      snap([withSchema({ ...baseTool.inputSchema, additionalProperties: false })])
    );
    expect(ruleOf(changes, CONTRACT_RULES.inputSchemaChangedUnclassified)?.kind).toBe("breaking");
  });

  it("gives every emitted change a rule ID drawn from CONTRACT_RULES", () => {
    const known = new Set<string>(Object.values(CONTRACT_RULES));
    const changes = diffContracts(
      snap([baseTool, { name: "gone", inputSchema: { type: "object" } }]),
      snap([
        { ...withSchema({ type: "object", properties: { a: { type: "string" }, z: {} } }), description: "x" },
        { name: "fresh", inputSchema: { type: "object" } },
      ])
    );
    expect(changes.length).toBeGreaterThan(0);
    for (const change of changes) expect(known).toContain(change.rule);
  });
});

describe("shouldFail", () => {
  const change = (kind: ContractChange["kind"]): ContractChange => ({
    kind,
    rule: CONTRACT_RULES.toolAdded,
    subject: "t",
    message: "m",
  });

  it("fails on breaking at either threshold", () => {
    expect(shouldFail([change("breaking")], "breaking")).toBe(true);
    expect(shouldFail([change("breaking")], "dangerous")).toBe(true);
  });

  it("gates dangerous only at the dangerous threshold", () => {
    expect(shouldFail([change("dangerous")], "breaking")).toBe(false);
    expect(shouldFail([change("dangerous")], "dangerous")).toBe(true);
  });

  it("never fails on minor or info", () => {
    const soft = [change("minor"), change("info")];
    expect(shouldFail(soft, "breaking")).toBe(false);
    expect(shouldFail(soft, "dangerous")).toBe(false);
  });

  it("defaults to the breaking threshold, preserving the pre-tier exit contract", () => {
    expect(shouldFail([change("dangerous")])).toBe(false);
  });
});

describe("countChanges", () => {
  it("reports a zero for every tier that is absent", () => {
    expect(countChanges([])).toEqual({ breaking: 0, dangerous: 0, minor: 0, info: 0 });
  });

  it("counts each tier independently", () => {
    const changes = diffContracts(
      snap([baseTool]),
      snap([
        {
          ...withSchema({
            type: "object",
            properties: { a: { type: "string" }, verbose: { type: "boolean" } },
            required: ["a"],
          }),
          description: "Sum",
        },
      ])
    );
    const counts = countChanges(changes);
    expect(counts.breaking).toBeGreaterThan(0);
    expect(counts.dangerous).toBeGreaterThan(0);
    expect(counts.minor).toBeGreaterThan(0);
    expect(counts.info).toBeGreaterThan(0);
  });
});
