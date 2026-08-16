/**
 * `mcp-cassette snapshot` — contract snapshots & breaking-change detection.
 *
 * Captures the server's tool surface (names + schemas + annotations) into a
 * canonical snapshot file. `--check` diffs the live server against the stored
 * snapshot and classifies every change into four tiers:
 *
 *   breaking  : removed tool, removed property, newly-required property,
 *               type change, narrowed enum, other structural schema change
 *   dangerous : compiles everywhere, changes behaviour somewhere — widened
 *               enum, changed default, newly-added optional property
 *   minor     : added tool, relaxed requirement
 *   info      : description/annotation changes
 *
 * The `dangerous` tier is GraphQL-Inspector's trichotomy applied to JSON
 * Schema. An agent that switch-cases over an enum, or a caller that relied on
 * a default, keeps type-checking and starts behaving differently — which is
 * exactly the class of drift a snapshot gate exists to surface. It is reported
 * always and gated on demand (`--fail-on dangerous`), so the default exit-code
 * contract is unchanged.
 *
 * Every change also carries a stable `rule` ID (oasdiff-style, e.g.
 * `tool-removed`, `input-enum-value-added`). Rule IDs are part of the public
 * contract: they are what a downstream policy — a CI allowlist, a PR bot, a
 * review checklist — matches on, and they must stay stable across releases
 * even when the human-readable message is reworded.
 *
 * Exit code 1 when the configured tier is reached — wire it into CI and no PR
 * silently breaks the agents that depend on your server.
 */

import fs from "node:fs";
import { EraOption, MiniClient, Target, Tool } from "./client.js";
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

export type ChangeKind = "breaking" | "dangerous" | "minor" | "info";

/** Most-severe first. Drives report ordering and the `--fail-on` threshold. */
export const CHANGE_KINDS: readonly ChangeKind[] = Object.freeze([
  "breaking",
  "dangerous",
  "minor",
  "info",
]);

/**
 * Stable machine-readable identifiers for every classified change, in the shape
 * oasdiff popularized: `<subject>-<what-happened>`, kebab-case, no version in
 * the name. Renaming one is a breaking change for anyone matching on it, so add
 * a new ID instead of repurposing an old one.
 */
export const CONTRACT_RULES = Object.freeze({
  toolRemoved: "tool-removed",
  toolAdded: "tool-added",
  toolDescriptionChanged: "tool-description-changed",
  toolAnnotationsChanged: "tool-annotations-changed",
  inputSchemaReplaced: "input-schema-replaced",
  inputSchemaTypeChanged: "input-schema-type-changed",
  inputSchemaChangedUnclassified: "input-schema-changed-unclassified",
  inputPropertyBecameRequired: "input-property-became-required",
  inputPropertyBecameOptional: "input-property-became-optional",
  inputPropertyRemoved: "input-property-removed",
  inputPropertyAddedRequired: "input-property-added-required",
  inputPropertyAddedOptional: "input-property-added-optional",
  inputPropertyTypeChanged: "input-property-type-changed",
  inputPropertyDefaultChanged: "input-property-default-changed",
  inputEnumValueRemoved: "input-enum-value-removed",
  inputEnumValueAdded: "input-enum-value-added",
} as const);

export type ContractRule = (typeof CONTRACT_RULES)[keyof typeof CONTRACT_RULES];

export interface ContractChange {
  kind: ChangeKind;
  /** Stable rule ID from `CONTRACT_RULES` — match on this, not on `message`. */
  rule: ContractRule;
  subject: string;
  message: string;
}

/** Lowest tier that makes `snapshot --check` exit non-zero. */
export type FailOn = "breaking" | "dangerous";

export type ChangeCounts = Record<ChangeKind, number>;

export function countChanges(changes: readonly ContractChange[]): ChangeCounts {
  const counts = { breaking: 0, dangerous: 0, minor: 0, info: 0 } satisfies ChangeCounts;
  for (const change of changes) counts[change.kind]++;
  return counts;
}

/** Does this diff trip the gate at the configured threshold? */
export function shouldFail(changes: readonly ContractChange[], failOn: FailOn = "breaking"): boolean {
  return changes.some(
    (c) => c.kind === "breaking" || (failOn === "dangerous" && c.kind === "dangerous")
  );
}

export async function captureContract(target: Target, era: EraOption = "auto"): Promise<ContractSnapshot> {
  const { client, init } = await MiniClient.connect(target, undefined, era);
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
      changes.push({
        kind: "breaking",
        rule: CONTRACT_RULES.toolRemoved,
        subject: name,
        message: "tool removed",
      });
    }
  }
  for (const [name] of newTools) {
    if (!oldTools.has(name)) {
      changes.push({
        kind: "minor",
        rule: CONTRACT_RULES.toolAdded,
        subject: name,
        message: "tool added",
      });
    }
  }

  for (const [name, oldTool] of oldTools) {
    const newTool = newTools.get(name);
    if (!newTool) continue;
    if ((oldTool.description ?? "") !== (newTool.description ?? "")) {
      changes.push({
        kind: "info",
        rule: CONTRACT_RULES.toolDescriptionChanged,
        subject: name,
        message: "description changed",
      });
    }
    if (stableStringify(oldTool.annotations ?? {}) !== stableStringify(newTool.annotations ?? {})) {
      changes.push({
        kind: "info",
        rule: CONTRACT_RULES.toolAnnotationsChanged,
        subject: name,
        message: "annotations changed",
      });
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
    changes.push({
      kind: "breaking",
      rule: CONTRACT_RULES.inputSchemaReplaced,
      subject: tool,
      message: "inputSchema replaced entirely",
    });
    return;
  }

  const emitted = changes.length;

  // A `$ref` moves the contract somewhere this diff does not follow. Two schemas
  // can carry byte-identical `{"$ref": "#/$defs/User"}` while `User` itself
  // changed from a string field to an integer one — so every comparison below
  // reads "unchanged" on a schema that changed completely.
  //
  // This is not hypothetical: FastMCP hands Pydantic the argument model, and
  // Pydantic emits `$defs`/`$ref` for any nested model, reused model, or Enum.
  // See tests/fixtures/contracts/ for the frozen shape.
  //
  // Until references are resolved, presence of one means the change cannot be
  // localised, and an unlocalisable change to a contract is not evidence of
  // safety. Deliberately *not* folded into the fallback at the end of this
  // function: that one only fires when nothing else was reported, and a root
  // change of any kind — even a `minor` one — would otherwise suppress it and
  // return the exact silence this guard exists to prevent.
  const unresolvedRef = containsRef(o) || containsRef(n);

  // type change at root
  if (o.type !== undefined && n.type !== undefined && stableStringify(o.type) !== stableStringify(n.type)) {
    changes.push({
      kind: "breaking",
      rule: CONTRACT_RULES.inputSchemaTypeChanged,
      subject: tool,
      message: `schema type changed: ${o.type} → ${n.type}`,
    });
  }

  // required
  const oldReq = new Set((o.required as string[] | undefined) ?? []);
  const newReq = new Set((n.required as string[] | undefined) ?? []);
  for (const r of newReq) {
    if (!oldReq.has(r)) {
      changes.push({
        kind: "breaking",
        rule: CONTRACT_RULES.inputPropertyBecameRequired,
        subject: tool,
        message: `parameter "${r}" is now required`,
      });
    }
  }
  for (const r of oldReq) {
    if (!newReq.has(r)) {
      changes.push({
        kind: "minor",
        rule: CONTRACT_RULES.inputPropertyBecameOptional,
        subject: tool,
        message: `parameter "${r}" is no longer required`,
      });
    }
  }

  // properties
  const oldProps = asObj(o.properties) ?? {};
  const newProps = asObj(n.properties) ?? {};
  for (const key of Object.keys(oldProps)) {
    if (!(key in newProps)) {
      changes.push({
        kind: "breaking",
        rule: CONTRACT_RULES.inputPropertyRemoved,
        subject: tool,
        message: `parameter "${key}" removed`,
      });
    }
  }
  for (const key of Object.keys(newProps)) {
    if (key in oldProps) continue;
    // An added *optional* parameter is dangerous, not minor: a caller that
    // rejects unknown fields, or a schema with additionalProperties:false one
    // level up, meets a surface it was never validated against — and an agent
    // choosing arguments from the schema starts sending a parameter the server
    // may treat as significant. Reported, not gated, unless --fail-on dangerous.
    changes.push(
      newReq.has(key)
        ? {
            kind: "breaking",
            rule: CONTRACT_RULES.inputPropertyAddedRequired,
            subject: tool,
            message: `parameter "${key}" added (required)`,
          }
        : {
            kind: "dangerous",
            rule: CONTRACT_RULES.inputPropertyAddedOptional,
            subject: tool,
            message: `parameter "${key}" added`,
          }
    );
  }
  for (const key of Object.keys(oldProps)) {
    if (!(key in newProps)) continue;
    const op = asObj(oldProps[key]);
    const np = asObj(newProps[key]);
    if (!op || !np) continue;
    if (op.type !== undefined && np.type !== undefined && stableStringify(op.type) !== stableStringify(np.type)) {
      changes.push({
        kind: "breaking",
        rule: CONTRACT_RULES.inputPropertyTypeChanged,
        subject: tool,
        message: `parameter "${key}" type changed: ${op.type} → ${np.type}`,
      });
    }
    diffDefault(tool, key, op, np, changes);
    diffEnum(tool, key, op, np, changes);
  }

  // Schemas differ and either nothing specific was detected, or a `$ref` means
  // what was detected cannot be trusted to be the whole story. Same rule id in
  // both cases — the id is the contract consumers match on, and both are the
  // same statement: this diff does not know what changed.
  if (changes.length === emitted || unresolvedRef) {
    changes.push({
      kind: "breaking",
      rule: CONTRACT_RULES.inputSchemaChangedUnclassified,
      subject: tool,
      message: unresolvedRef
        ? "inputSchema changed and contains a $ref this diff does not resolve, " +
          "so the change cannot be localised (unclassified — treated as breaking)"
        : "inputSchema changed structurally (unclassified — treated as breaking)",
    });
  }
}

/** Does this schema carry a `$ref` anywhere, at any depth? */
function containsRef(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(containsRef);
  const obj = asObj(node);
  if (!obj) return false;
  if (typeof obj.$ref === "string") return true;
  return Object.values(obj).some(containsRef);
}

/**
 * A moved default is the textbook dangerous change: every existing call still
 * validates, and the ones that omitted the parameter silently get different
 * behaviour. Adding or removing a default is the same hazard — the value a
 * caller ends up with changes without the caller changing.
 */
function diffDefault(
  tool: string,
  key: string,
  op: Record<string, unknown>,
  np: Record<string, unknown>,
  changes: ContractChange[]
): void {
  const had = "default" in op;
  const has = "default" in np;
  if (!had && !has) return;
  if (had && has && stableStringify(op.default) === stableStringify(np.default)) return;

  const message = !had
    ? `parameter "${key}" default added: ${JSON.stringify(np.default)}`
    : !has
      ? `parameter "${key}" default removed (was ${JSON.stringify(op.default)})`
      : `parameter "${key}" default changed: ${JSON.stringify(op.default)} → ${JSON.stringify(np.default)}`;

  changes.push({
    kind: "dangerous",
    rule: CONTRACT_RULES.inputPropertyDefaultChanged,
    subject: tool,
    message,
  });
}

/**
 * Narrowing an enum rejects arguments that used to work — breaking. Widening
 * one is dangerous: the schema still accepts everything it did, but a caller
 * that exhaustively handles the old members now meets a value it has no branch
 * for, and that failure surfaces at runtime rather than at validation.
 */
function diffEnum(
  tool: string,
  key: string,
  op: Record<string, unknown>,
  np: Record<string, unknown>,
  changes: ContractChange[]
): void {
  const oldEnum = (op.enum as unknown[] | undefined) ?? null;
  const newEnum = (np.enum as unknown[] | undefined) ?? null;
  if (!oldEnum || !newEnum) return;

  const newSet = new Set(newEnum.map((v) => stableStringify(v)));
  const oldSet = new Set(oldEnum.map((v) => stableStringify(v)));
  for (const v of oldEnum) {
    if (!newSet.has(stableStringify(v))) {
      changes.push({
        kind: "breaking",
        rule: CONTRACT_RULES.inputEnumValueRemoved,
        subject: tool,
        message: `parameter "${key}" enum value ${JSON.stringify(v)} removed`,
      });
    }
  }
  for (const v of newEnum) {
    if (!oldSet.has(stableStringify(v))) {
      changes.push({
        kind: "dangerous",
        rule: CONTRACT_RULES.inputEnumValueAdded,
        subject: tool,
        message: `parameter "${key}" enum value ${JSON.stringify(v)} added`,
      });
    }
  }
}

export function printChanges(changes: ContractChange[], failOn: FailOn = "breaking"): void {
  const line = (s = "") => process.stdout.write(s + "\n");
  if (changes.length === 0) {
    line("[OK] contract unchanged");
    return;
  }
  for (const kind of CHANGE_KINDS) {
    for (const c of changes.filter((x) => x.kind === kind)) {
      line(`[${kind.toUpperCase()}] ${c.subject}: ${c.message} (${c.rule})`);
    }
  }
  const counts = countChanges(changes);
  line();
  line(
    `result: ${shouldFail(changes, failOn) ? "FAIL" : "PASS"} ` +
      `(${counts.breaking} breaking, ${counts.dangerous} dangerous, ${counts.minor} minor, ` +
      `${counts.info} info; gate: ${failOn})`
  );
}
