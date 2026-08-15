/**
 * `mcp-cassette snapshot` — contract snapshots & breaking-change detection.
 *
 * Captures the server's tool surface (names + schemas + annotations) into a
 * canonical snapshot file. `--check` diffs the live server against the stored
 * snapshot and classifies every change:
 *
 *   breaking : removed tool, removed property, newly-required property,
 *              type change, narrowed enum, other structural schema change
 *   minor    : added tool, added optional property, widened enum
 *   info     : description/annotation changes
 *
 * Exit code 1 when breaking changes are found — wire it into CI and no PR
 * silently breaks the agents that depend on your server.
 */

import fs from "node:fs";
import { MiniClient, Target, Tool } from "./client.js";
import { stableStringify } from "./jsonrpc.js";

export interface ContractSnapshot {
  mcpCassetteContract: 1;
  capturedAt: string;
  server?: { name?: string; version?: string };
  protocolVersion?: string;
  tools: ContractTool[];
}

export interface ContractTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
}

export type ChangeKind = "breaking" | "minor" | "info";

export interface ContractChange {
  kind: ChangeKind;
  subject: string;
  message: string;
}

export async function captureContract(target: Target): Promise<ContractSnapshot> {
  const { client, init } = await MiniClient.connect(target);
  try {
    const tools = await client.listAll<Tool>("tools/list", "tools");
    return {
      mcpCassetteContract: 1,
      capturedAt: new Date().toISOString(),
      server: init.serverInfo,
      protocolVersion: init.protocolVersion,
      tools: tools
        .map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: t.annotations,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  } finally {
    await client.close();
  }
}

export function writeSnapshot(path: string, snap: ContractSnapshot): void {
  fs.writeFileSync(path, JSON.stringify(snap, null, 2) + "\n");
}

export function readSnapshot(path: string): ContractSnapshot {
  const snap = JSON.parse(fs.readFileSync(path, "utf8")) as ContractSnapshot;
  if (snap.mcpCassetteContract !== 1) {
    throw new Error(`Unsupported contract snapshot version in ${path}`);
  }
  return snap;
}

export function diffContracts(oldSnap: ContractSnapshot, newSnap: ContractSnapshot): ContractChange[] {
  const changes: ContractChange[] = [];
  const oldTools = new Map(oldSnap.tools.map((t) => [t.name, t]));
  const newTools = new Map(newSnap.tools.map((t) => [t.name, t]));

  for (const [name] of oldTools) {
    if (!newTools.has(name)) {
      changes.push({ kind: "breaking", subject: name, message: "tool removed" });
    }
  }
  for (const [name] of newTools) {
    if (!oldTools.has(name)) {
      changes.push({ kind: "minor", subject: name, message: "tool added" });
    }
  }

  for (const [name, oldTool] of oldTools) {
    const newTool = newTools.get(name);
    if (!newTool) continue;
    if ((oldTool.description ?? "") !== (newTool.description ?? "")) {
      changes.push({ kind: "info", subject: name, message: "description changed" });
    }
    if (stableStringify(oldTool.annotations ?? {}) !== stableStringify(newTool.annotations ?? {})) {
      changes.push({ kind: "info", subject: name, message: "annotations changed" });
    }
    diffSchema(name, oldTool.inputSchema, newTool.inputSchema, changes);
  }
  return changes;
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function diffSchema(tool: string, oldS: unknown, newS: unknown, changes: ContractChange[]): void {
  if (stableStringify(oldS ?? null) === stableStringify(newS ?? null)) return;

  const o = asObj(oldS);
  const n = asObj(newS);
  if (!o || !n) {
    changes.push({ kind: "breaking", subject: tool, message: "inputSchema replaced entirely" });
    return;
  }

  const emitted = changes.length;

  // type change at root
  if (o.type !== undefined && n.type !== undefined && stableStringify(o.type) !== stableStringify(n.type)) {
    changes.push({ kind: "breaking", subject: tool, message: `schema type changed: ${o.type} → ${n.type}` });
  }

  // required
  const oldReq = new Set((o.required as string[] | undefined) ?? []);
  const newReq = new Set((n.required as string[] | undefined) ?? []);
  for (const r of newReq) {
    if (!oldReq.has(r)) {
      changes.push({ kind: "breaking", subject: tool, message: `parameter "${r}" is now required` });
    }
  }
  for (const r of oldReq) {
    if (!newReq.has(r)) {
      changes.push({ kind: "minor", subject: tool, message: `parameter "${r}" is no longer required` });
    }
  }

  // properties
  const oldProps = asObj(o.properties) ?? {};
  const newProps = asObj(n.properties) ?? {};
  for (const key of Object.keys(oldProps)) {
    if (!(key in newProps)) {
      changes.push({ kind: "breaking", subject: tool, message: `parameter "${key}" removed` });
    }
  }
  for (const key of Object.keys(newProps)) {
    if (!(key in oldProps)) {
      const kind: ChangeKind = newReq.has(key) ? "breaking" : "minor";
      changes.push({
        kind,
        subject: tool,
        message: `parameter "${key}" added${newReq.has(key) ? " (required)" : ""}`,
      });
    }
  }
  for (const key of Object.keys(oldProps)) {
    if (!(key in newProps)) continue;
    const op = asObj(oldProps[key]);
    const np = asObj(newProps[key]);
    if (!op || !np) continue;
    if (op.type !== undefined && np.type !== undefined && stableStringify(op.type) !== stableStringify(np.type)) {
      changes.push({
        kind: "breaking",
        subject: tool,
        message: `parameter "${key}" type changed: ${op.type} → ${np.type}`,
      });
    }
    const oldEnum = (op.enum as unknown[] | undefined) ?? null;
    const newEnum = (np.enum as unknown[] | undefined) ?? null;
    if (oldEnum && newEnum) {
      const newSet = new Set(newEnum.map((v) => stableStringify(v)));
      const oldSet = new Set(oldEnum.map((v) => stableStringify(v)));
      for (const v of oldEnum) {
        if (!newSet.has(stableStringify(v))) {
          changes.push({
            kind: "breaking",
            subject: tool,
            message: `parameter "${key}" enum value ${JSON.stringify(v)} removed`,
          });
        }
      }
      for (const v of newEnum) {
        if (!oldSet.has(stableStringify(v))) {
          changes.push({
            kind: "minor",
            subject: tool,
            message: `parameter "${key}" enum value ${JSON.stringify(v)} added`,
          });
        }
      }
    }
  }

  // schemas differ but nothing specific detected → be conservative
  if (changes.length === emitted) {
    changes.push({
      kind: "breaking",
      subject: tool,
      message: "inputSchema changed structurally (unclassified — treated as breaking)",
    });
  }
}

export function printChanges(changes: ContractChange[]): void {
  const line = (s = "") => process.stdout.write(s + "\n");
  if (changes.length === 0) {
    line("[OK] contract unchanged");
    return;
  }
  const order: ChangeKind[] = ["breaking", "minor", "info"];
  for (const kind of order) {
    for (const c of changes.filter((x) => x.kind === kind)) {
      const tag = kind === "breaking" ? "[BREAKING]" : kind === "minor" ? "[MINOR]" : "[INFO]";
      line(`${tag} ${c.subject}: ${c.message}`);
    }
  }
  const b = changes.filter((c) => c.kind === "breaking").length;
  const m = changes.filter((c) => c.kind === "minor").length;
  const i = changes.filter((c) => c.kind === "info").length;
  line();
  line(`result: ${b > 0 ? "FAIL" : "PASS"} (${b} breaking, ${m} minor, ${i} info)`);
}
