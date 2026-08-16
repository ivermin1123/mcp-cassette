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

export type LintSeverity = "error" | "warn";

export interface LintFinding {
  rule: string;
  severity: LintSeverity;
  toolName: string;
  message: string;
  excerpt?: string;
}

/**
 * Can text alone separate the legitimate case from the attack?
 *
 * `"shape"` — yes. The finding *is* the attack: no honest description carries
 * an unbalanced bidi override or a Cyrillic letter inside a Latin word. A
 * legitimate tool must therefore produce **no finding at all**, and a rule that
 * fires on ordinary Arabic or Chinese prose is not strict, it is broken — it
 * teaches everyone outside its assumptions to ignore the lint.
 *
 * `"intent"` — no. The finding is *true*: this tool really does describe
 * running a shell command. What the lint cannot see is whether that is supposed
 * to be there, and a terminal server is not lying. Severity is where that
 * ignorance is encoded, so these rules are always `warn`, and they report what
 * was declared instead of accusing.
 */
export type LintEvidence = "shape" | "intent";

export interface LintRule {
  id: string;
  severity: LintSeverity;
  describe: string;
  /** Whether text alone can tell an attack from a legitimate tool. */
  evidence: LintEvidence;
  /**
   * OWASP MCP Top 10 risk IDs this rule speaks to.
   * https://owasp.org/www-project-mcp-top-10/
   */
  owasp: string[];
  /**
   * SAFE-MCP technique IDs, which name the attack more precisely than a risk
   * category can. https://github.com/fkautz/safe-mcp
   */
  safeMcp: string[];
  /**
   * The pattern, published rather than closed over, so CI can prove it runs in
   * linear time. A rule that matches with a regex MUST expose it here — a
   * pattern hidden inside `find` is a pattern nobody checked. The exceptions
   * are listed, by id, in scripts/recheck-rules.mjs.
   */
  pattern?: RegExp;
  find: (text: string) => string | null; // returns evidence excerpt or null
}

function excerptAround(text: string, index: number, len = 60): string {
  const start = Math.max(0, index - 20);
  return text.slice(start, start + len).replace(/\s+/g, " ").trim();
}

function regexRule(spec: Omit<LintRule, "find">): LintRule {
  const re = spec.pattern!;
  return {
    ...spec,
    find: (text) => {
      const m = re.exec(text);
      return m ? excerptAround(text, m.index) : null;
    },
  };
}

/**
 * Zero-width binary encoding uses U+200B for 0 and U+200C for 1, and the
 * Unicode Tags block maps each ASCII byte to U+E0000 + its codepoint. Those are
 * the two schemes arXiv:2603.00164 measured LLMs actually decoding. The range
 * also takes in the neighbouring joiners and the byte-order mark, which render
 * as nothing just the same.
 */
const INVISIBLE_UNICODE = /[\u200B-\u200F\u2060\uFEFF]|[\u{E0000}-\u{E007F}]/u;

const OPAQUE_BLOB = /[A-Za-z0-9+/=]{120,}/;

const EXFIL_URL = /https?:\/\//gi;
const EXFIL_VERBS = ["send", "post", "upload", "forward", "transmit"];
/** How far back from a URL a verb still reads as an instruction about it. */
const EXFIL_WINDOW = 60;

/**
 * "…send the transcript to https://evil.example" — a directive to move data
 * out. Written as a scan rather than one regex on purpose.
 *
 * The obvious pattern, `(send|post|…)[^.]{0,60}https?:\/\/`, is *polynomial*:
 * recheck derives the attack string `"TPOST".repeat(24495) + "."` for it,
 * because every one of those overlapping prefixes is a start position the
 * engine re-scans a 60-character window from. Lint reads text an attacker
 * wrote, so that is a denial of service against the job checking the attacker.
 *
 * Anchoring on the URL instead inverts the cost: the published pattern scans
 * the text once, and each hit does a fixed amount of work in a bounded
 * look-back. Linear by construction, with no regex applied to the window.
 */
const EXFILTRATION_RULE: LintRule = {
  id: "CAS-L004",
  evidence: "shape",
  severity: "error",
  describe: "exfiltration-shaped directive (send/post/upload data to a URL)",
  owasp: ["MCP10:2025"],
  safeMcp: ["SAFE-T1910"],
  pattern: EXFIL_URL,
  find: (text) => {
    EXFIL_URL.lastIndex = 0; // the `g` flag makes exec stateful across calls
    let match: RegExpExecArray | null;
    while ((match = EXFIL_URL.exec(text)) !== null) {
      const window = text.slice(Math.max(0, match.index - EXFIL_WINDOW), match.index).toLowerCase();
      // A sentence boundary breaks the link between verb and URL, so only the
      // text after the last one counts — the `[^.]` of the original pattern.
      const clause = window.slice(window.lastIndexOf(".") + 1);
      if (EXFIL_VERBS.some((verb) => clause.includes(verb))) return excerptAround(text, match.index);
    }
    return null;
  },
};

/**
 * A verb aimed at a URL, scanned the way CAS-L004 has to be: anchored on the
 * URL with a bounded look-back, never `verb[^.]{0,60}url` — see EXFILTRATION_RULE
 * for the polynomial that shape produces.
 */
function urlDirectiveRule(spec: Omit<LintRule, "find" | "pattern">, verbs: string[]): LintRule {
  const url = /https?:\/\//gi;
  return {
    ...spec,
    pattern: url,
    find: (text) => {
      url.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = url.exec(text)) !== null) {
        const window = text.slice(Math.max(0, match.index - EXFIL_WINDOW), match.index).toLowerCase();
        const clause = window.slice(window.lastIndexOf(".") + 1);
        if (verbs.some((verb) => clause.includes(verb))) return excerptAround(text, match.index);
      }
      return null;
    },
  };
}

/**
 * Trojan Source, in a tool description.
 *
 * Only two shapes are reported, and the restraint is the point: legitimate
 * Arabic and Hebrew prose needs *no* explicit control at all — the bidi
 * algorithm handles direction on its own. What no honest description contains
 * is an explicit override (LRO/RLO), which exists to make displayed order
 * disagree with stored order, or an embedding left unclosed.
 */
const BIDI_OVERRIDE = /[‭‮]/u;
const BIDI_OPEN = /[‪‫⁦⁧⁨]/gu;
const BIDI_CLOSE = /[‬⁩]/gu;

const countOf = (text: string, re: RegExp): number => {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text) !== null) n++;
  return n;
};

/**
 * Variation selectors, which recent "emoji smuggling" work turns into a data
 * channel: a run of them after one base character carries bytes nothing renders.
 *
 * A single VS15/VS16 is how every ⚠️ on earth is written, so it is allowed. The
 * ideographic selectors (VS17+) never appear in a tool description at all.
 */
const VS_LOW = /[︀-️]/gu;
const VS_EMOJI_PRESENTATION = /[︎️]/u;
const VS_IDEOGRAPHIC = /[\u{E0100}-\u{E01EF}]/u;

/**
 * Homoglyphs: a Latin word with a Cyrillic or Greek letter hiding inside it.
 *
 * Restricted to those two scripts on purpose. They are the ones whose letters
 * are visually identical to Latin ones — Han, Kana, Hangul and Arabic are not
 * confusable, and CJK text has no spaces, so a token like "使用Google搜索" would
 * make a naive any-mixed-script rule fire on perfectly ordinary Chinese.
 */
const MIXED_SCRIPT = /\p{Script=Latin}[\p{Script=Cyrillic}\p{Script=Greek}]|[\p{Script=Cyrillic}\p{Script=Greek}]\p{Script=Latin}/u;

const NEW_RULES: LintRule[] = [
  {
    id: "CAS-L009",
    evidence: "shape",
    severity: "error",
    describe: "bidirectional override or unbalanced embedding (Trojan Source)",
    owasp: ["MCP03:2025"],
    safeMcp: ["SAFE-T1402"],
    pattern: BIDI_OVERRIDE,
    find: (text) => {
      const override = BIDI_OVERRIDE.exec(text);
      if (override) {
        return `contains U+${override[0]!.codePointAt(0)!.toString(16).toUpperCase()} (bidi override)`;
      }
      const opened = countOf(text, BIDI_OPEN);
      const closed = countOf(text, BIDI_CLOSE);
      if (opened !== closed) return `${opened} bidi embedding(s) opened, ${closed} closed`;
      return null;
    },
  },
  {
    id: "CAS-L010",
    evidence: "shape",
    severity: "error",
    describe: "variation selectors used as a data channel",
    owasp: ["MCP03:2025"],
    safeMcp: ["SAFE-T1402"],
    pattern: VS_IDEOGRAPHIC,
    find: (text) => {
      if (VS_IDEOGRAPHIC.test(text)) return "contains an ideographic variation selector (U+E0100+)";
      VS_LOW.lastIndex = 0;
      let run = 0;
      let previousEnd = -1;
      let match: RegExpExecArray | null;
      while ((match = VS_LOW.exec(text)) !== null) {
        run = match.index === previousEnd ? run + 1 : 1;
        previousEnd = match.index + match[0].length;
        // Two in a row carry no presentation meaning — that is payload.
        if (run >= 2) return `${run} consecutive variation selectors`;
        if (!VS_EMOJI_PRESENTATION.test(match[0])) {
          return `contains U+${match[0].codePointAt(0)!.toString(16).toUpperCase()} (not an emoji presentation selector)`;
        }
      }
      return null;
    },
  },
  regexRule({
    id: "CAS-L011",
    evidence: "intent",
    severity: "warn",
    describe: "tool declares priority over another tool — verify intended",
    owasp: ["MCP02:2025", "MCP06:2025"],
    safeMcp: ["SAFE-T1301"],
    pattern: /\b(instead of|rather than|in place of)\s+(the\s+)?[\w.-]{1,40}\s+(tool|server|function)\b|\balways\s+(use|call|prefer|invoke)\s+this\b/i,
  }),
  regexRule({
    id: "CAS-L012",
    evidence: "intent",
    severity: "warn",
    describe: "tool declares command execution — verify intended",
    owasp: ["MCP05:2025"],
    safeMcp: ["SAFE-T1102"],
    pattern: /\b(exec|eval|subprocess|child_process|shell)\b|\brm\s+-rf\b|\|\s*(sh|bash)\b/i,
  }),
  regexRule({
    id: "CAS-L013",
    evidence: "shape",
    severity: "error",
    describe: "role or authority impersonation aimed at the model",
    owasp: ["MCP06:2025"],
    safeMcp: ["SAFE-T1102"],
    pattern: /\byou\s+are\s+(now\s+)?(in\s+)?(a\s+|an\s+|the\s+)?(developer|debug|god|admin|root|unrestricted|jailbreak)\b|\bact\s+as\s+(a\s+|an\s+|the\s+)?(system|admin|root|developer)\b|\bpretend\s+(that\s+)?you\s+are\b/i,
  }),
  regexRule({
    id: "CAS-L014",
    evidence: "intent",
    severity: "warn",
    describe: "tool asks for a credential in its input — verify intended",
    owasp: ["MCP01:2025", "MCP07:2025"],
    safeMcp: ["SAFE-T1001"],
    pattern: /\b(include|attach|provide|supply|pass|paste)\s+(your\s+|the\s+)?(api[_ -]?key|access[_ -]?token|password|secret|credentials?)\b/i,
  }),
  {
    id: "CAS-L015",
    evidence: "shape",
    severity: "warn",
    describe: "mixed-script word (homoglyph obfuscation)",
    owasp: ["MCP03:2025"],
    safeMcp: ["SAFE-T1405"],
    pattern: MIXED_SCRIPT,
    find: (text) => {
      const m = MIXED_SCRIPT.exec(text);
      if (!m) return null;
      // Name the word, not the two characters: the word is what looked normal.
      const before = text.lastIndexOf(" ", m.index) + 1;
      const after = text.indexOf(" ", m.index);
      const word = text.slice(before, after === -1 ? undefined : after);
      return `"${word}" mixes Latin with Cyrillic or Greek letters`;
    },
  },
  urlDirectiveRule(
    {
      id: "CAS-L016",
      evidence: "intent",
      severity: "warn",
      describe: "tool declares a fetch from an unpinned remote source — verify intended",
      owasp: ["MCP04:2025"],
      safeMcp: ["SAFE-T1201"],
    },
    ["download", "fetch", "retrieve", "install", "curl", "wget"]
  ),
];

const TAIL_RULES: LintRule[] = [
  {
    id: "CAS-L006",
    evidence: "shape",
    severity: "error",
    describe: "invisible/steganographic Unicode in description",
    owasp: ["MCP03:2025"],
    safeMcp: ["SAFE-T1402"],
    pattern: INVISIBLE_UNICODE,
    find: (text) => {
      const m = INVISIBLE_UNICODE.exec(text);
      if (!m) return null;
      return `contains U+${m[0]!.codePointAt(0)!.toString(16).toUpperCase()}`;
    },
  },
  {
    id: "CAS-L007",
    evidence: "shape",
    severity: "warn",
    describe: "large opaque blob (base64-like) embedded in description",
    owasp: ["MCP03:2025"],
    safeMcp: ["SAFE-T1402"],
    pattern: OPAQUE_BLOB,
    find: (text) => {
      const m = OPAQUE_BLOB.exec(text);
      return m ? `${m[0]!.slice(0, 40)}… (${m[0]!.length} chars)` : null;
    },
  },
  {
    id: "CAS-L008",
    evidence: "shape",
    severity: "warn",
    describe: "oversized description (context-window bloat)",
    owasp: ["MCP10:2025"],
    safeMcp: [],
    // No pattern on purpose: this is a length comparison, not a match. The
    // exemption is declared by id in scripts/recheck-rules.mjs.
    find: (text) => (text.length > 1500 ? `${text.length} chars (recommended < 1500)` : null),
  },
];

export const LINT_RULES: LintRule[] = [
  regexRule({
    id: "CAS-L001",
    evidence: "shape",
    severity: "error",
    describe: "instruction-override phrasing (classic prompt-injection)",
    owasp: ["MCP06:2025"],
    safeMcp: ["SAFE-T1102"],
    pattern: /ignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions?|rules?|prompts?)/i,
  }),
  regexRule({
    id: "CAS-L002",
    evidence: "shape",
    severity: "error",
    describe: "hidden-instruction markers in description",
    owasp: ["MCP03:2025"],
    safeMcp: ["SAFE-T1001"],
    pattern: /<\s*(system|important|secret|hidden|instructions?)\s*>|<!--/i,
  }),
  regexRule({
    id: "CAS-L003",
    evidence: "shape",
    severity: "error",
    describe: "concealment directive (do not tell/inform the user)",
    owasp: ["MCP03:2025"],
    safeMcp: ["SAFE-T1001"],
    pattern: /do\s+not\s+(tell|inform|mention|reveal|show|notify|alert)[^.]{0,40}(user|human|operator)/i,
  }),
  EXFILTRATION_RULE,
  regexRule({
    id: "CAS-L005",
    evidence: "shape",
    severity: "error",
    describe: "references sensitive local material (SSH keys, .env, credentials)",
    owasp: ["MCP01:2025"],
    safeMcp: ["SAFE-T1001"],
    pattern: /(\.ssh\b|id_rsa|\.env\b|credentials?\.json|api[_-]?keys?\b[^.]{0,30}(read|collect|include|attach))/i,
  }),
  ...TAIL_RULES,
  ...NEW_RULES,
];

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
