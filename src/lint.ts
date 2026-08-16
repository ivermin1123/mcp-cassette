/**
 * Tool-description safety lint.
 *
 * Turns prose guidance from the MCP security literature (tool-poisoning
 * research, SAFE-MCP techniques, OWASP Agentic Top 10) into fast, explainable
 * heuristics. These are heuristics, not proofs: they catch the known shapes of
 * description-borne attacks and context abuse.
 */

import type { Tool } from "./client.js";
import { cassetteEra, type Cassette, type FrameEntry } from "./cassette.js";
import { isRequest, type JsonRpcRequest } from "./jsonrpc.js";

import { LINT_RULES, type LintRule, type LintSeverity } from "./lint-rules.js";

export { LINT_RULES } from "./lint-rules.js";
export type { LintEvidence, LintRule, LintSeverity } from "./lint-rules.js";



export interface LintFinding {
  rule: string;
  severity: LintSeverity;
  toolName: string;
  message: string;
  excerpt?: string;
}


export function lintTool(tool: Tool): LintFinding[] {
  const findings: LintFinding[] = [];
  const surfaces: Array<[string, string]> = [];
  if (typeof tool.description === "string") surfaces.push(["description", tool.description]);
  if (typeof tool.title === "string") surfaces.push(["title", tool.title]);
  // Attackers also hide instructions inside the schema — and not only in its
  // descriptions. SAFE-T1501 calls it full-schema poisoning.
  collectSchemaText(tool.inputSchema, "inputSchema", surfaces);
  // Annotations are rendered to the user and read by the model just the same,
  // so they are part of the schema an attacker gets to write.
  collectSchemaText(tool.annotations, "annotations", surfaces);

  for (const [where, text] of surfaces) {
    for (const rule of LINT_RULES) {
      const evidence = rule.find(text);
      if (evidence !== null) {
        findings.push({
          rule: rule.id,
          severity: rule.severity,
          toolName: tool.name,
          message: `${rule.describe} (in ${where})`,
          excerpt: evidence,
        });
      }
    }
  }
  return findings;
}

/**
 * Schema fields that carry free text to the model. `description` was the only
 * one scanned until full-schema poisoning (SAFE-T1501) made the point that an
 * attacker writes the whole schema, not just its prose: a `default` string, an
 * `enum` member or a `title` reaches the model the same way and was previously
 * unread.
 */
const TEXT_KEYS = ["description", "title", "default", "const"] as const;
/** The same, where the schema holds several values instead of one. */
const TEXT_LIST_KEYS = ["enum", "examples"] as const;

const CHILD_KEYS = ["properties", "items", "anyOf", "oneOf", "allOf", "$defs", "definitions"];

function collectSchemaText(node: unknown, path: string, out: Array<[string, string]>, depth = 0): void {
  if (!node || typeof node !== "object" || depth > 6) return;
  const obj = node as Record<string, unknown>;

  for (const key of TEXT_KEYS) {
    const value = obj[key];
    // Only strings: a numeric `default` carries no instructions.
    if (typeof value === "string") out.push([`${path}.${key}`, value]);
  }
  for (const key of TEXT_LIST_KEYS) {
    const value = obj[key];
    if (!Array.isArray(value)) continue;
    value.forEach((member, i) => {
      if (typeof member === "string") out.push([`${path}.${key}[${i}]`, member]);
    });
  }

  for (const key of CHILD_KEYS) {
    const child = obj[key];
    if (Array.isArray(child)) {
      child.forEach((c, i) => collectSchemaText(c, `${path}.${key}[${i}]`, out, depth + 1));
    } else if (child && typeof child === "object") {
      for (const [name, sub] of Object.entries(child as Record<string, unknown>)) {
        collectSchemaText(sub, `${path}.${key}.${name}`, out, depth + 1);
      }
    }
  }
}

/**
 * Cassette consistency: does the file's header agree with the frames under it?
 *
 * A cassette is an open text format, so it gets hand-edited — and a header that
 * contradicts its own transcript fails confusingly at replay time (§4.3), where
 * the era decides behavior and is never re-derived from frames. Lint is where
 * that contradiction should surface instead.
 */
export interface CassetteFinding {
  rule: string;
  message: string;
}

export function lintCassette(cassette: Cassette): CassetteFinding[] {
  const findings: CassetteFinding[] = [];
  const { header, entries } = cassette;
  const era = cassetteEra(header);
  const add = (rule: string, message: string) => findings.push({ rule, message });

  const requests = entries.filter((e) => e.type === "frame" && e.dir === "c2s" && isRequest(e.frame));
  const asked = (method: string) =>
    requests.some((e) => ((e as FrameEntry).frame as JsonRpcRequest).method === method);

  if (era === "modern") {
    // The modern era has no handshake at all, so recorded handshake traffic
    // means the header is lying about one of the two.
    if (asked("initialize")) {
      add("era-handshake", 'era is "modern" but the cassette records an `initialize` request — the modern era has no handshake');
    }
    if (header.sessioned) {
      add("era-sessioned", 'era is "modern" but the header says `sessioned` — the modern era removed sessions entirely');
    }
    if (entries.some((e) => e.type === "chunks" && e.via === "get")) {
      add("era-get-stream", 'era is "modern" but a stream is recorded as `via:"get"` — the modern era removed the standalone GET stream');
    }
  }

  if (header.transport === "stdio") {
    // stdio has no URL and no SSE; either field means the header's transport is wrong.
    if (header.url) add("transport-url", 'transport is "stdio" but the header carries a `url`');
    if (entries.some((e) => e.type === "chunks")) {
      add("transport-chunks", 'transport is "stdio" but the cassette records a streamed answer — `chunks` entries only come from HTTP');
    }
  } else if (header.command) {
    add("transport-command", 'transport is "http" but the header carries a spawn `command`');
  }

  return findings;
}
