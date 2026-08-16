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
  inputAnnotationChanged: "input-annotation-changed",
  inputSchemaRefUnclassified: "input-schema-ref-unclassified",
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

/**
 * Keys that carry prose for a reader, not obligation for a caller. Changing one
 * cannot break anybody, so they are lifted out before structural comparison and
 * reported on their own at `info` — otherwise every reworded description lands
 * in the conservative-breaking bucket and turns a consumer's CI red for a typo
 * fix.
 */
const ANNOTATION_KEYS = new Set(["description", "title", "$comment", "examples"]);

/**
 * Keywords every node accounts for itself: `type` and `required` are classified
 * here, and `properties` is fully covered by the add/remove/recurse pass. What
 * is left after removing these — and whatever else the caller reports having
 * delegated — is a keyword this engine cannot classify yet, which is exactly
 * what should trip the conservative fallback.
 */
const NODE_OWN_KEYS = ["type", "required", "properties"];

/**
 * Normalise the ways one meaning can be spelled, so that only real differences
 * survive to the rules. This emits nothing; it *prevents* findings. Deliberately
 * NOT normalised: `items: [X]` (draft-04 tuple) against `items: X` — those mean
 * different things, and folding them would be inventing agreement.
 */
function canonicalizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeSchema);
  const node = asObj(value);
  if (!node) return value;

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(node)) {
    if (ANNOTATION_KEYS.has(key)) continue;
    switch (key) {
      // order carries no meaning in any of these three
      case "required":
        out.required = Array.isArray(val) ? [...new Set(val as string[])].sort() : val;
        break;
      case "enum":
        out.enum = Array.isArray(val)
          ? [...val].sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)))
          : val;
        break;
      case "type":
        out.type = Array.isArray(val) ? [...new Set(val as string[])].sort() : val;
        break;
      // `absent`, `{}` and `true` are three spellings of "anything else is allowed"
      case "additionalProperties": {
        const asSchema = asObj(val);
        out.additionalProperties =
          val === true || (asSchema && Object.keys(asSchema).length === 0)
            ? true
            : canonicalizeSchema(val);
        break;
      }
      case "properties":
      case "patternProperties":
      case "$defs":
      case "definitions": {
        const map = asObj(val);
        if (!map) {
          out[key] = val;
          break;
        }
        const canon: Record<string, unknown> = {};
        for (const name of Object.keys(map).sort()) canon[name] = canonicalizeSchema(map[name]);
        out[key] = canon;
        break;
      }
      default:
        out[key] = canonicalizeSchema(val);
    }
  }
  if (!("additionalProperties" in out) && ("properties" in out || out.type === "object")) {
    out.additionalProperties = true;
  }
  return out;
}

/**
 * The prose of a schema, with its structure discarded. Two schemas that
 * canonicalize the same may still differ here (a reworded description) or not
 * at all (a reordered `required`) — and only the first is worth a line of
 * output. Without this split, every reordering would be announced as a
 * description change.
 */
function annotationShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(annotationShape);
  const node = asObj(value);
  if (!node) return {};
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(node)) {
    if (ANNOTATION_KEYS.has(key)) {
      out[key] = val;
      continue;
    }
    const child = annotationShape(val);
    if (stableStringify(child) !== "{}") out[key] = child;
  }
  return out;
}

/** Does a `$ref` appear anywhere below here? */
function containsRef(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsRef);
  const node = asObj(value);
  if (!node) return false;
  if (typeof node.$ref === "string") return true;
  return Object.values(node).some(containsRef);
}

/**
 * What is left of a node once the keywords somebody has already accounted for
 * are removed. A key is only dropped when it was genuinely handled — an `items`
 * that could not be recursed into (a tuple against a single schema, say) stays,
 * so the difference still surfaces instead of disappearing.
 */
function shallowShape(node: Record<string, unknown>, delegated: readonly string[]): string {
  const rest: Record<string, unknown> = { ...node };
  for (const key of [...NODE_OWN_KEYS, ...delegated]) delete rest[key];
  return stableStringify(rest);
}

function at(pointer: string): string {
  return pointer === "" ? "" : ` at ${pointer}`;
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

  const canonOld = canonicalizeSchema(o);
  const canonNew = canonicalizeSchema(n);

  // The raw schemas differ but nothing a caller is bound by does. That is either
  // reworded prose, which is worth one info line, or a difference of spelling
  // only — a reordered `required`, `additionalProperties` written three ways —
  // which is worth nothing at all.
  if (stableStringify(canonOld) === stableStringify(canonNew)) {
    if (stableStringify(annotationShape(o)) !== stableStringify(annotationShape(n))) {
      changes.push({
        kind: "info",
        rule: CONTRACT_RULES.inputAnnotationChanged,
        subject: tool,
        message: "inputSchema annotations changed (description/title/examples only)",
      });
    }
    return;
  }

  // A `$ref` means the shape being compared is not the shape in front of us, so
  // whatever this diff does find cannot be trusted to be the whole story. Say
  // that, and say it *in addition to* everything that could still be classified:
  // returning early here would hide a removed parameter simply because a `$ref`
  // sat somewhere else in the schema — a guard against silent drift causing it.
  // The generic per-node fallback is suppressed instead, because this rule is
  // the same statement with a reason attached.
  const unresolvedRef = containsRef(canonOld) || containsRef(canonNew);

  diffSchemaNode(
    tool,
    "",
    canonOld as Record<string, unknown>,
    canonNew as Record<string, unknown>,
    changes,
    true,
    unresolvedRef
  );

  if (unresolvedRef) {
    changes.push({
      kind: "breaking",
      rule: CONTRACT_RULES.inputSchemaRefUnclassified,
      subject: tool,
      message:
        "inputSchema changed and uses $ref — reference resolution is not implemented, " +
        "so the change is unclassified and treated as breaking",
    });
  }
}

/**
 * One schema node, then its children. The fallback is per node, not per tool:
 * the earlier version only asked whether the *whole tool* had produced any
 * finding, so a single `minor` at the root swallowed every breaking change
 * nested underneath it — a contract-drift detector silently dropping contract
 * drift.
 */
function diffSchemaNode(
  tool: string,
  pointer: string,
  o: Record<string, unknown>,
  n: Record<string, unknown>,
  changes: ContractChange[],
  isRoot: boolean,
  unresolvedRef: boolean
): void {
  const emitted = changes.length;
  // `enum` and `default` on a non-root node were already classified by the
  // parent, which owns the per-property rules; at the root nobody else does.
  const delegated: string[] = isRoot ? [] : ["enum", "default"];

  // A nested node's own `type` is reported by its parent as a property type
  // change, so only the root reports its own.
  if (isRoot && o.type !== undefined && n.type !== undefined && stableStringify(o.type) !== stableStringify(n.type)) {
    changes.push({
      kind: "breaking",
      rule: CONTRACT_RULES.inputSchemaTypeChanged,
      subject: tool,
      message: `schema type changed: ${o.type} → ${n.type}`,
    });
  }

  const oldReq = new Set((o.required as string[] | undefined) ?? []);
  const newReq = new Set((n.required as string[] | undefined) ?? []);
  for (const r of newReq) {
    if (!oldReq.has(r)) {
      changes.push({
        kind: "breaking",
        rule: CONTRACT_RULES.inputPropertyBecameRequired,
        subject: tool,
        message: `parameter "${r}" is now required${at(pointer)}`,
      });
    }
  }
  for (const r of oldReq) {
    if (!newReq.has(r)) {
      changes.push({
        kind: "minor",
        rule: CONTRACT_RULES.inputPropertyBecameOptional,
        subject: tool,
        message: `parameter "${r}" is no longer required${at(pointer)}`,
      });
    }
  }

  const oldProps = asObj(o.properties) ?? {};
  const newProps = asObj(n.properties) ?? {};
  for (const key of Object.keys(oldProps)) {
    if (!(key in newProps)) {
      changes.push({
        kind: "breaking",
        rule: CONTRACT_RULES.inputPropertyRemoved,
        subject: tool,
        message: `parameter "${key}" removed${at(pointer)}`,
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
            message: `parameter "${key}" added (required)${at(pointer)}`,
          }
        : {
            kind: "dangerous",
            rule: CONTRACT_RULES.inputPropertyAddedOptional,
            subject: tool,
            message: `parameter "${key}" added${at(pointer)}`,
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
        message: `parameter "${key}" type changed: ${op.type} → ${np.type}${at(pointer)}`,
      });
    }
    diffDefault(tool, key, op, np, changes);
    diffEnum(tool, key, op, np, changes);
    if (stableStringify(op) !== stableStringify(np)) {
      diffSchemaNode(tool, `${pointer}/properties/${key}`, op, np, changes, false, unresolvedRef);
    }
  }

  // Array members and the open-ended tail are schemas too.
  for (const [key, childPointer] of [
    ["items", `${pointer}/items`],
    ["additionalProperties", `${pointer}/additionalProperties`],
  ] as const) {
    const oc = asObj(o[key]);
    const nc = asObj(n[key]);
    if (!oc || !nc) continue;
    delegated.push(key);
    if (stableStringify(oc) === stableStringify(nc)) continue;
    diffSchemaNode(tool, childPointer, oc, nc, changes, false, unresolvedRef);
  }

  // This node differs in a keyword nothing above classified → say so, here,
  // rather than letting a sibling's finding stand in for it.
  if (!unresolvedRef && changes.length === emitted && shallowShape(o, delegated) !== shallowShape(n, delegated)) {
    changes.push({
      kind: "breaking",
      rule: CONTRACT_RULES.inputSchemaChangedUnclassified,
      subject: tool,
      message: `inputSchema changed structurally${at(pointer)} (unclassified — treated as breaking)`,
    });
  }
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
