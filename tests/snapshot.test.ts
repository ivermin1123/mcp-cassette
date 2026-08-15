import { describe, expect, it } from "vitest";
import { diffContracts, type ContractSnapshot } from "../src/snapshot.js";

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

describe("diffContracts", () => {
  it("reports no changes for identical contracts", () => {
    expect(diffContracts(snap([baseTool]), snap([baseTool]))).toEqual([]);
  });

  it("classifies removed tool as breaking, added tool as minor", () => {
    const changes = diffContracts(
      snap([baseTool, { name: "old", inputSchema: { type: "object" } }]),
      snap([baseTool, { name: "new", inputSchema: { type: "object" } }])
    );
    expect(changes).toContainEqual({ kind: "breaking", subject: "old", message: "tool removed" });
    expect(changes).toContainEqual({ kind: "minor", subject: "new", message: "tool added" });
  });

  it("classifies newly-required parameter as breaking", () => {
    const next = {
      ...baseTool,
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" }, c: { type: "number" } },
        required: ["a", "b", "c"],
      },
    };
    const changes = diffContracts(snap([baseTool]), snap([next]));
    expect(changes.some((c) => c.kind === "breaking" && /"c" (is now required|added)/.test(c.message))).toBe(true);
  });

  it("classifies added optional parameter as minor", () => {
    const next = {
      ...baseTool,
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" }, verbose: { type: "boolean" } },
        required: ["a", "b"],
      },
    };
    const changes = diffContracts(snap([baseTool]), snap([next]));
    expect(changes).toEqual([{ kind: "minor", subject: "add", message: 'parameter "verbose" added' }]);
  });

  it("classifies parameter type change and removed parameter as breaking", () => {
    const next = {
      ...baseTool,
      inputSchema: {
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
      },
    };
    const changes = diffContracts(snap([baseTool]), snap([next]));
    expect(changes.some((c) => c.kind === "breaking" && c.message.includes('type changed'))).toBe(true);
    expect(changes.some((c) => c.kind === "breaking" && c.message.includes('"b" removed'))).toBe(true);
  });

  it("classifies enum narrowing as breaking, widening as minor", () => {
    const withEnum = (values: string[]) => ({
      name: "mode",
      inputSchema: {
        type: "object",
        properties: { m: { type: "string", enum: values } },
        required: ["m"],
      },
    });
    const narrowed = diffContracts(snap([withEnum(["a", "b"])]), snap([withEnum(["a"])]));
    expect(narrowed.some((c) => c.kind === "breaking" && c.message.includes("removed"))).toBe(true);
    const widened = diffContracts(snap([withEnum(["a"])]), snap([withEnum(["a", "b"])]));
    expect(widened).toEqual([
      { kind: "minor", subject: "mode", message: 'parameter "m" enum value "b" added' },
    ]);
  });

  it("classifies description change as info", () => {
    const changes = diffContracts(snap([baseTool]), snap([{ ...baseTool, description: "Sum" }]));
    expect(changes).toEqual([{ kind: "info", subject: "add", message: "description changed" }]);
  });

  it("treats unclassified structural schema changes conservatively as breaking", () => {
    const next = {
      ...baseTool,
      inputSchema: { ...baseTool.inputSchema, additionalProperties: false },
    };
    const changes = diffContracts(snap([baseTool]), snap([next]));
    expect(changes.some((c) => c.kind === "breaking")).toBe(true);
  });
});
