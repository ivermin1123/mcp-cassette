/**
 * Safety lint for the text a server publishes to the model.
 *
 * Turns prose guidance from the MCP security literature (tool-poisoning
 * research, SAFE-MCP techniques, OWASP Agentic Top 10) into fast, explainable
 * heuristics. These are heuristics, not proofs: they catch the known shapes of
 * description-borne attacks and context abuse.
 *
 * Tool descriptions were the first surface and are still the best understood,
 * but they are not the only text a model reads: a prompt template and a
 * resource listing reach it the same way and are written by the same hand. So
 * the rules are applied by one scanner over three kinds of subject, and what
 * differs between `lintTool`, `lintPrompt` and `lintResource` is only which
 * fields each hands over as text.
 */

import type { Tool } from "./client.js";
import { cassetteEra, type Cassette, type FrameEntry } from "./cassette.js";
import { isRequest, type JsonRpcRequest } from "./jsonrpc.js";

import { LINT_RULES, type LintRule, type LintSeverity } from "./lint-rules.js";

export { LINT_RULES } from "./lint-rules.js";
export type { LintEvidence, LintRule, LintSeverity } from "./lint-rules.js";



/**
 * What a finding's `subject` names.
 *
 * `"tool"` is more than a label. It is the surface every rule in the set was
 * written against and has been running on since the rule set existed, and the
 * one whose findings are already triaged in somebody's Security tab. `check`
 * and the SARIF writer both treat the others as new, and say so where they do.
 */
export type SubjectKind = "tool" | "prompt" | "resource" | "resource-template";

export interface LintFinding {
  rule: string;
  severity: LintSeverity;
  /** What `subject` names. */
  kind: SubjectKind;
  /** The tool, prompt or resource whose text matched. */
  subject: string;
  message: string;
  excerpt?: string;
}

/**
 * The model-facing parts of a prompt, as `prompts/list` returns them.
 *
 * Declared structurally rather than imported from the client because that is
 * all the lint needs to be true: it reads strings off whatever the server
 * sent, in either protocol era, and nothing here depends on the rest of the
 * listing being well formed.
 */
export interface PromptArgument {
  name?: string;
  title?: string;
  description?: string;
  [key: string]: unknown;
}

export interface Prompt {
  name?: string;
  title?: string;
  description?: string;
  arguments?: PromptArgument[];
  [key: string]: unknown;
}

/**
 * The same for `resources/list` and `resources/templates/list`. A template is
 * a resource that carries a `uriTemplate` where a resource carries a `uri`;
 * everything the lint reads is common to both.
 */
export interface Resource {
  uri?: string;
  uriTemplate?: string;
  name?: string;
  title?: string;
  description?: string;
  [key: string]: unknown;
}

/** Collect a field only when it holds text; a number carries no instructions. */
function pushText(out: Array<[string, string]>, where: string, value: unknown): void {
  if (typeof value === "string") out.push([where, value]);
}

/** A subject a reader can act on, even from a server that sent no identifier. */
function subjectOf(value: unknown, kind: SubjectKind): string {
  return typeof value === "string" && value.length > 0 ? value : `(unnamed ${kind})`;
}

/**
 * Run every rule over every surface of one subject.
 *
 * The shared half of the lint. A rule that fires on a tool description fires
 * on a prompt description for the same reason, so there is one loop and the
 * callers differ only in what they collect.
 */
function scan(kind: SubjectKind, subject: string, surfaces: Array<[string, string]>): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const [where, text] of surfaces) {
    for (const rule of LINT_RULES) {
      const evidence = rule.find(text);
      if (evidence !== null) {
        // Several rules describe themselves as what a *tool* declares, which
        // is what they were written for and what a tool finding must keep
        // saying, byte for byte. On the other kinds the subject is named
        // instead, and the field is prefixed with it, because "description" on
        // its own no longer says what was read.
        const describe = kind === "tool" ? rule.describe : rule.describe.replace(/^tool\b/, kind);
        findings.push({
          rule: rule.id,
          severity: rule.severity,
          kind,
          subject,
          message: `${describe} (in ${kind === "tool" ? where : `${kind} ${where}`})`,
          excerpt: evidence,
        });
      }
    }
  }
  return findings;
}

export function lintTool(tool: Tool): LintFinding[] {
  const surfaces: Array<[string, string]> = [];
  pushText(surfaces, "description", tool.description);
  pushText(surfaces, "title", tool.title);
  // Attackers also hide instructions inside the schema, and not only in its
  // descriptions. SAFE-T1501 calls it full-schema poisoning.
  collectSchemaText(tool.inputSchema, "inputSchema", surfaces);
  // Annotations are rendered to the user and read by the model just the same,
  // so they are part of the schema an attacker gets to write.
  collectSchemaText(tool.annotations, "annotations", surfaces);
  return scan("tool", tool.name, surfaces);
}

/**
 * A prompt: a template the server hands the model, with the arguments it takes.
 *
 * Its `name` is not read, because it is what `prompts/get` is called with, and
 * linting identifiers would report the server's own naming as an attack. A
 * resource's `name` is the opposite case; see `lintResource`.
 */
export function lintPrompt(prompt: Prompt): LintFinding[] {
  // A listing may hold anything a broken server put there. Skipping the entry
  // is what `check` did before it linted these surfaces, and the alternative
  // is a throw its caller reports as the listing having failed.
  if (!prompt || typeof prompt !== "object") return [];
  const surfaces: Array<[string, string]> = [];
  pushText(surfaces, "description", prompt.description);
  pushText(surfaces, "title", prompt.title);
  if (Array.isArray(prompt.arguments)) {
    prompt.arguments.forEach((argument, i) => {
      if (!argument || typeof argument !== "object") return;
      pushText(surfaces, `arguments[${i}].description`, argument.description);
      pushText(surfaces, `arguments[${i}].title`, argument.title);
    });
  }
  return scan("prompt", subjectOf(prompt.name, "prompt"), surfaces);
}

/**
 * A resource, or a resource template.
 *
 * Here `name` *is* read, because it is display text: the specification has it
 * stand in for `title` when none is given, and `resources/read` is keyed by
 * `uri`, so the name is never what a client calls with. That `uri` (the
 * `uriTemplate`, for a template) is the identifier, and it is what the finding
 * names.
 */
export function lintResource(resource: Resource): LintFinding[] {
  // See `lintPrompt`: a listing entry that is not an object is skipped.
  if (!resource || typeof resource !== "object") return [];
  const surfaces: Array<[string, string]> = [];
  pushText(surfaces, "name", resource.name);
  pushText(surfaces, "title", resource.title);
  pushText(surfaces, "description", resource.description);
  const isTemplate = typeof resource.uriTemplate === "string";
  const kind: SubjectKind = isTemplate ? "resource-template" : "resource";
  return scan(kind, subjectOf(isTemplate ? resource.uriTemplate : resource.uri ?? resource.name, kind), surfaces);
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
      add("era-handshake", 'era is "modern" but the cassette records an `initialize` request; the modern era has no handshake');
    }
    if (header.sessioned) {
      add("era-sessioned", 'era is "modern" but the header says `sessioned`; the modern era removed sessions entirely');
    }
    if (entries.some((e) => e.type === "chunks" && e.via === "get")) {
      add("era-get-stream", 'era is "modern" but a stream is recorded as `via:"get"`; the modern era removed the standalone GET stream');
    }
  }

  if (header.transport === "stdio") {
    // stdio has no URL and no SSE; either field means the header's transport is wrong.
    if (header.url) add("transport-url", 'transport is "stdio" but the header carries a `url`');
    if (entries.some((e) => e.type === "chunks")) {
      add("transport-chunks", 'transport is "stdio" but the cassette records a streamed answer; `chunks` entries only come from HTTP');
    }
  } else if (header.command) {
    add("transport-command", 'transport is "http" but the header carries a spawn `command`');
  }

  return findings;
}
