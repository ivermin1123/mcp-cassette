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
import { isRequest, isResponse, type JsonRpcFrame, type JsonRpcId, type JsonRpcRequest } from "./jsonrpc.js";
// Both reused rather than reimplemented: replay owns what a volatile
// declaration means, and redact owns what a placeholder looks like. A second
// copy of either would be a second thing to keep true.
import { validateVolatile } from "./replay.js";
import { placeholderSpans } from "./redact.js";

import { INVISIBLE_RUN_RULE, LINT_RULES, type LintRule, type LintSeverity } from "./lint-rules.js";

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
  /**
   * Whether this finding decides the exit code.
   *
   * A header that contradicts its own frames is an `"error"`: the file says
   * one thing and contains another, and replay will act on the header. The
   * newer header fields are checked at `"warn"`, because they were never
   * checked here before and a cassette that passed must keep passing.
   */
  severity: LintSeverity;
  message: string;
}

export function lintCassette(cassette: Cassette): CassetteFinding[] {
  const findings: CassetteFinding[] = [];
  const { header, entries } = cassette;
  const era = cassetteEra(header);
  const add = (rule: string, message: string) =>
    findings.push({ rule, severity: "error", message });
  const warn = (rule: string, message: string) =>
    findings.push({ rule, severity: "warn", message });

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

  lintHeaderFields(header, warn);
  return findings;
}

/**
 * The header fields newer than this lint, checked for the shape they promise.
 *
 * Both are read by something that refuses rather than degrades: replay throws
 * on a malformed `volatile` declaration, and on a `configHash` it was not
 * given the matching config for. A hand-edited cassette therefore fails at the
 * far end of a run, inside whatever process replay was spawned in, when the
 * mistake is visible here in a file somebody can open. Reported at `warn`,
 * because this lint never looked at these fields and a cassette that passed it
 * has to keep passing it; the failure they predict is still a failure.
 */
function lintHeaderFields(
  header: Cassette["header"],
  warn: (rule: string, message: string) => void
): void {
  // `null` is treated as absent, not as a malformed list, because replay reads
  // it that way (`header.volatile ?? []`) and runs. This lint reports what
  // replay would refuse; a finding on a cassette that replays cleanly is a
  // finding nobody can act on.
  if (header.volatile !== undefined && header.volatile !== null) {
    if (!Array.isArray(header.volatile)) {
      warn("volatile-type", 'header `volatile` is not a list; it must be a list of declaration strings');
    } else {
      header.volatile.forEach((spec, i) => {
        if (typeof spec !== "string") {
          warn("volatile-type", `header \`volatile\`[${i}] is not a string; every declaration is a string`);
          return;
        }
        try {
          // Replay's own parser, one declaration at a time so a list with two
          // mistakes in it reports both rather than only the first.
          validateVolatile([spec]);
        } catch (err) {
          warn("volatile-declaration", `header \`volatile\`[${i}] is not a valid declaration: ${(err as Error).message}`);
        }
      });
    }
  }

  const redaction = header.redaction;
  if (redaction !== undefined && redaction !== null && typeof redaction === "object") {
    const hash = (redaction as { configHash?: unknown }).configHash;
    // The documented shape is the sha256 hex digest `redact` writes, which is
    // what replay compares its own config's hash against; anything else can
    // only ever mismatch, so it is worth naming now rather than at replay.
    if (hash !== undefined && (typeof hash !== "string" || !CONFIG_HASH.test(hash))) {
      warn(
        "redaction-config-hash",
        'header `redaction.configHash` is not a sha256 hex digest; `redact` writes 64 lowercase hex characters'
      );
    }
  }
}

/** The digest `hashConfig` produces in redact.ts: sha256, lowercase hex. */
const CONFIG_HASH = /^[0-9a-f]{64}$/;

/**
 * Indirect prompt injection: the text a server *returned*, not the text it declared.
 *
 * A tool description is a promise a server makes before it is called. A tool
 * result is data it hands back afterwards, and that data reaches the model with
 * the same authority: a file whose contents say "ignore your instructions" is
 * the published attack on retrieval-augmented agents, and nothing about the
 * declaration lint sees it. Only a tool that keeps a recording can read what
 * actually came back, which is why this lives on a cassette rather than on a
 * live `check`.
 *
 * The rule set is narrower than the lint's, and narrowed by measurement rather
 * than by taste. `LintRule.evidence` already separates the rules that can tell
 * an attack from a legitimate description (`shape`) from those that only report
 * what was declared (`intent`), and an `intent` rule is meaningless here: a
 * result that mentions a shell is a result about a shell. That leaves the
 * twelve `shape` rules, and six of those fire on ordinary recorded data:
 *
 *   CAS-L002  `<!--` matches every HTML comment a page-fetching server returns
 *   CAS-L004  "send the manifest to https://..." is ordinary API documentation
 *   CAS-L005  a directory listing or a config body names dotfiles for a living
 *   CAS-L007  an inline `data:` URI and a bearer token are both opaque blobs
 *   CAS-L008  a length limit written for a description, meaningless for a body
 *   CAS-L015  "842 μs" is a unit symbol, not homoglyph obfuscation
 *
 * A rule that fires on ordinary data teaches everyone to ignore the lint, which
 * costs more than the rule catches. What survives is listed below, and the six
 * exclusions are not permanent judgements about the rules: they are judgements
 * about running *these* patterns against *this* surface, recorded in BACKLOG so
 * a narrowed output variant can be argued for with the measurement in hand.
 */
export const OUTPUT_RULE_IDS: readonly string[] = Object.freeze([
  "CAS-L001", // instruction-override phrasing
  "CAS-L003", // concealment directive
  "CAS-L006", // invisible or steganographic Unicode
  "CAS-L009", // bidirectional override
  "CAS-L010", // variation selectors as a data channel
  "CAS-L013", // role or authority impersonation
]);

/**
 * The rules themselves, resolved from the catalogue rather than copied out of
 * it, so a rule's severity and wording stay in one place. An id that no longer
 * resolves is a catalogue change this list has not been told about, which is
 * what `tests/lint-cassette.test.ts` pins.
 */
const OUTPUT_RULES: LintRule[] = LINT_RULES.filter((rule) => OUTPUT_RULE_IDS.includes(rule.id)).map(
  // CAS-L006 is the one rule whose threshold differs by surface: a lone
  // invisible code point is suspicious in a declaration and ordinary in
  // returned data. See `INVISIBLE_RUN_RULE` for the measurement.
  (rule) => (rule.id === INVISIBLE_RUN_RULE.id ? INVISIBLE_RUN_RULE : rule)
);

/** One finding about text a recorded server returned. */
export interface OutputFinding {
  /** The `CAS-L` rule that matched. */
  rule: string;
  /**
   * Always `"warn"`, whatever the rule's own level.
   *
   * Returned text is data, and this surface is new: a cassette that passed
   * before must keep its exit code, so these are reported and never gated.
   */
  severity: LintSeverity;
  /** The id of the request this answers, so the exchange can be found in the file. */
  requestId: JsonRpcId | null;
  /** The method that request called. */
  method: string;
  /** JSON path of the matching string, from the frame root (`/result/content/0/text`). */
  path: string;
  message: string;
  excerpt?: string;
}

/**
 * The methods whose answers carry text written for the model to read.
 *
 * Deliberately a list rather than "every response": a `tools/list` answer is
 * declarations, which `check` already lints and which would be reported twice,
 * and an `initialize` answer is protocol. These three are the surfaces where a
 * third party's text arrives as data.
 */
const OUTPUT_METHODS = new Set([
  "tools/call",
  // A task-augmented call answers with a handle and delivers the tool's real
  // output later, so the text this lint exists to read arrives here instead.
  "tasks/get",
  "tasks/result",
  "resources/read",
  "prompts/get",
]);

/**
 * Keys whose values are never scanned.
 *
 * `blob` on a resource and `data` on an image or audio block are both base64 by
 * specification. Neither is decoded and neither is scanned, by decision rather
 * than oversight: decoding would mean running an attacker's bytes through an
 * expansion this tool would then have to bound, and a lint that silently
 * decodes is a lint nobody can predict. A cassette carrying a poisoned blob is
 * outside what this reports, and the README says so.
 */
const UNSCANNED_KEYS = new Set(["blob", "data"]);

/**
 * The text with its redaction placeholders blanked out.
 *
 * A placeholder is this tool's own writing, not the server's, so matching a
 * rule against one would report mcp-cassette to its user as an attacker. The
 * surrounding text is still scanned, which is why this blanks the spans rather
 * than skipping the whole string: a sentence does not stop being an injection
 * because a token in it was redacted.
 */
function withoutPlaceholders(text: string): string {
  const spans = placeholderSpans(text);
  if (spans.length === 0) return text;
  let out = "";
  let at = 0;
  for (const [start, end] of spans) {
    out += text.slice(at, start) + " ".repeat(end - start);
    at = end;
  }
  return out + text.slice(at);
}

/**
 * Every string inside a payload, with the JSON path that reaches it.
 *
 * Twelve levels deep and no further, the bound `collectSchemaText` already uses
 * for schemas. A tool result nested deeper than that is not something this
 * reports, which is a stated limit rather than a silent one.
 */
function eachString(node: unknown, path: string, out: Array<[string, string]>, depth = 0): void {
  if (depth > 12) return;
  if (typeof node === "string") {
    out.push([path, node]);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => eachString(item, `${path}/${i}`, out, depth + 1));
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (UNSCANNED_KEYS.has(key)) continue;
    eachString(value, `${path}/${key}`, out, depth + 1);
  }
}

/**
 * A request id, keyed so that a numeric `1` and a string `"1"` stay apart.
 *
 * JSON-RPC allows either, and two clients on one recording may well pick
 * different spellings of the same number.
 */
function idKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

/**
 * Scan what the recorded server returned for indirect prompt injection.
 *
 * Findings are additive: `lintCassette` keeps answering the question it always
 * answered, about the header and the frames, and this answers a different one
 * about their contents. Both are reported by `lint <cassette>`; only the
 * header-versus-frames contradictions decide its exit code.
 */
export function lintCassetteOutput(cassette: Cassette): OutputFinding[] {
  // An id identifies a request only until it is answered. Clients restart ids
  // per connection, and one HTTP recording holds every client that spoke to the
  // proxy, so a file can carry several requests with the same id. Reading the
  // whole file into one map first would let the last of them name every answer,
  // which silently attributes a tools/call answer to a tools/list and the other
  // way round. Pairing each answer with the most recent request still waiting
  // for one is what the wire itself means.
  const pending = new Map<string, string>();
  const findings: OutputFinding[] = [];

  const scanResponse = (frame: JsonRpcFrame): void => {
    if (!isResponse(frame)) return;
    const key = idKey(frame.id);
    const method = pending.get(key);
    pending.delete(key);
    if (frame.result === undefined || method === undefined || !OUTPUT_METHODS.has(method)) return;

    const strings: Array<[string, string]> = [];
    eachString(frame.result, "/result", strings);
    for (const [path, raw] of strings) {
      const text = withoutPlaceholders(raw);
      for (const rule of OUTPUT_RULES) {
        const evidence = rule.find(text);
        if (evidence === null) continue;
        findings.push({
          rule: rule.id,
          severity: "warn",
          requestId: frame.id ?? null,
          method,
          path,
          // Several rules name the surface they were written for inside their
          // own wording, which is wrong here and nowhere else; `scan` rewrites
          // the same kind of phrase for prompts and resources.
          message: `${rule.describe.replace(/ in description$/, "")} (in recorded output)`,
          excerpt: evidence,
        });
      }
    }
  };

  for (const entry of cassette.entries) {
    if (entry.type === "frame" && entry.dir === "c2s" && isRequest(entry.frame)) {
      pending.set(idKey(entry.frame.id), entry.frame.method);
    }
    if (entry.type === "frame" && entry.dir === "s2c") scanResponse(entry.frame);
    // A streamed answer is the same answer, delivered in pieces.
    if (entry.type === "chunks") for (const chunk of entry.chunks) scanResponse(chunk.frame);
  }
  return findings;
}
