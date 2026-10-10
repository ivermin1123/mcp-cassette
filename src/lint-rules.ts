/**
 * The safety-lint rule catalogue.
 *
 * Split out of lint.ts so the list of *what* is detected reads separately from
 * the machinery that walks a tool and applies it. Nothing here knows how a
 * finding is reported; nothing in lint.ts knows what any individual rule looks
 * for.
 *
 * Every rule that matches with a regex publishes it, so scripts/recheck-rules.mjs
 * can prove it free of super-linear backtracking. See LintRule.pattern.
 *
 * Every rule also declares the surfaces it runs on. A rule is not a detector
 * looking for everything everywhere: a pattern written for a sentence reads a
 * resource name wrong, and one written for a declaration reads a returned
 * document wrong. See LintRule.surfaces, and `rulesForSurface`, which is what
 * the scanners ask instead of carrying lists of their own.
 */


export type LintSeverity = "error" | "warn";

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

/**
 * A surface a rule can run on: one population of text, not one field.
 *
 * The split is by what the text *is*, because that is what decides whether a
 * rule reads it correctly. A tool description and a schema `default` are the
 * same population, written by the same hand for the same reader, so they are
 * one surface. A resource `name` is a different one: it is display text that
 * is usually an identifier, and a rule that reads a sentence sees `.env` and
 * reports a server for naming its own file.
 *
 * `"tool"`      the tool's `description`, `title`, `annotations` and every
 *               text field of its input schema.
 * `"prompt"`    a prompt's `description` and `title`, and each argument's.
 * `"resource"`  the `title` and `description` of a resource or a resource
 *               template. Both kinds, because nothing a rule reads differs
 *               between them.
 * `"name"`      the `name` of a resource or a resource template, which the
 *               specification has stand in for `title` when none is given.
 * `"output"`    text a recorded server returned. Narrower by measurement: see
 *               `OUTPUT_RULE_IDS` in lint.ts.
 */
export type LintSurface = "tool" | "prompt" | "resource" | "name" | "output";

export interface LintRule {
  id: string;
  severity: LintSeverity;
  describe: string;
  /** Whether text alone can tell an attack from a legitimate tool. */
  evidence: LintEvidence;
  /**
   * The surfaces this rule runs on, and the only place that is written down.
   *
   * Both lists that used to be kept by hand are derived from it: the rules
   * that read a recorded answer (`OUTPUT_RULE_IDS` in lint.ts) and the rules
   * that read a resource name. Every rule in this catalogue declares its own,
   * because a reach nobody wrote down is a reach nobody checked.
   *
   * Optional, and omitting it means every surface a server declares (`"tool"`,
   * `"prompt"`, `"resource"` and `"name"`) but not recorded output, with no
   * ceiling. That is what every rule here ran on before the declaration
   * existed, so a rule a consumer pushes into `LINT_RULES` without one keeps
   * behaving exactly as it did.
   */
  surfaces?: readonly LintSurface[];
  /**
   * The highest level this rule may ever report on a surface, where that is
   * lower than its own severity.
   *
   * This is not the release-discipline cap. That one holds every finding on a
   * surface new to a release at `warn` for a minor and is then lifted, and it
   * lives in check.ts because it is a property of the release rather than of
   * the rule. A ceiling here says the pairing itself is wrong at a higher
   * level and always will be, so the minor that lifts the other cap cannot
   * lift this one: it would have to delete a declaration to do it.
   */
  cap?: Readonly<Partial<Record<LintSurface, LintSeverity>>>;
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

/**
 * Every surface a server declares, a name among them.
 *
 * The rules that carry this look for something *concealed* in text, and a name
 * conceals as well as a sentence does: the markers, the invisible code points,
 * the bidi override and the homoglyph all work exactly as well in a name, and
 * the name is the part a reader sees before anything is fetched.
 */
const DECLARED: readonly LintSurface[] = ["tool", "prompt", "resource", "name"];

/**
 * The declared surfaces that hold prose, so a name is left out.
 *
 * For the rules that read their subject as a sentence. Measured over 63
 * subjects (the measurement is in BACKLOG): on a name they report a dotfile, a
 * credential file, `shell` and `exec.ts` as attacks, which is a filesystem
 * server being a filesystem server. They keep running on the `title` and the
 * `description` of the same subject, where the text really is prose.
 */
const PROSE: readonly LintSurface[] = ["tool", "prompt", "resource"];

/** Everything declared, plus text a recorded server returned. */
const DECLARED_AND_OUTPUT: readonly LintSurface[] = [...DECLARED, "output"];

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
  surfaces: DECLARED,
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
    surfaces: DECLARED_AND_OUTPUT,
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
    surfaces: DECLARED_AND_OUTPUT,
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
    surfaces: DECLARED,
    severity: "warn",
    describe: "tool declares priority over another tool, verify intended",
    owasp: ["MCP02:2025", "MCP06:2025"],
    safeMcp: ["SAFE-T1301"],
    pattern: /\b(instead of|rather than|in place of)\s+(the\s+)?[\w.-]{1,40}\s+(tool|server|function)\b|\balways\s+(use|call|prefer|invoke)\s+this\b/i,
  }),
  regexRule({
    id: "CAS-L012",
    evidence: "intent",
    surfaces: PROSE,
    severity: "warn",
    describe: "tool declares command execution, verify intended",
    owasp: ["MCP05:2025"],
    safeMcp: ["SAFE-T1102"],
    pattern: /\b(exec|eval|subprocess|child_process|shell)\b|\brm\s+-rf\b|\|\s*(sh|bash)\b/i,
  }),
  regexRule({
    id: "CAS-L013",
    evidence: "shape",
    surfaces: DECLARED_AND_OUTPUT,
    // A persona is the product anywhere in a prompt, its title and argument
    // text included. "Act as a system administrator and diagnose the issue" is
    // what a prompt template is for, and a server that ships one is not
    // impersonating anybody to the model: the user picked the template. The
    // rule stays on the surface, because the same sentence in a resource
    // description is still worth reading, and it never gates there.
    cap: { prompt: "warn" },
    severity: "error",
    describe: "role or authority impersonation aimed at the model",
    owasp: ["MCP06:2025"],
    safeMcp: ["SAFE-T1102"],
    pattern: /\byou\s+are\s+(now\s+)?(in\s+)?(a\s+|an\s+|the\s+)?(developer|debug|god|admin|root|unrestricted|jailbreak)\b|\bact\s+as\s+(a\s+|an\s+|the\s+)?(system|admin|root|developer)\b|\bpretend\s+(that\s+)?you\s+are\b/i,
  }),
  regexRule({
    id: "CAS-L014",
    evidence: "intent",
    surfaces: DECLARED,
    severity: "warn",
    describe: "tool asks for a credential in its input, verify intended",
    owasp: ["MCP01:2025", "MCP07:2025"],
    safeMcp: ["SAFE-T1001"],
    pattern: /\b(include|attach|provide|supply|pass|paste)\s+(your\s+|the\s+)?(api[_ -]?key|access[_ -]?token|password|secret|credentials?)\b/i,
  }),
  {
    id: "CAS-L015",
    evidence: "shape",
    surfaces: DECLARED,
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
      surfaces: DECLARED,
      severity: "warn",
      describe: "tool declares a fetch from an unpinned remote source, verify intended",
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
    surfaces: DECLARED_AND_OUTPUT,
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
    surfaces: PROSE,
    severity: "warn",
    describe: "large opaque blob (base64-like) embedded in description",
    owasp: ["MCP03:2025"],
    safeMcp: ["SAFE-T1402"],
    pattern: OPAQUE_BLOB,
    find: (text) => {
      const m = OPAQUE_BLOB.exec(text);
      return m ? `${m[0]!.slice(0, 40)}... (${m[0]!.length} chars)` : null;
    },
  },
  {
    id: "CAS-L008",
    evidence: "shape",
    surfaces: PROSE,
    severity: "warn",
    describe: "oversized description (context-window bloat)",
    owasp: ["MCP10:2025"],
    safeMcp: [],
    // No pattern on purpose: this is a length comparison, not a match. The
    // exemption is declared by id in scripts/recheck-rules.mjs.
    find: (text) => (text.length > 1500 ? `${text.length} chars (recommended < 1500)` : null),
  },
];

/**
 * CAS-L006, narrowed for text a server *returned* rather than declared.
 *
 * The catalogue rule matches a single invisible code point, which is right for
 * a description: nothing honest puts one there. Returned data is a different
 * population. A web editor leaves a lone U+200B in about three percent of real
 * GitHub issue bodies, a file authored on Windows and read back through
 * `resources/read` opens with a U+FEFF byte-order mark, and every ZWJ emoji
 * sequence is a U+200D by construction. Reporting those teaches a reader to
 * ignore the rule, which costs more than the rule catches.
 *
 * Both encodings the rule exists for survive the narrowing, because neither can
 * express anything in one code point: zero-width binary needs one per bit, and
 * the Tags block never appears in ordinary text at all, so a single Tags code
 * point still counts. Measured over 1196 issue bodies and 5549 files, this
 * removes every ordinary-data hit and keeps every payload.
 *
 * Exported as its own rule rather than replacing the catalogue entry: a lone
 * zero-width character in a tool description stays suspicious, and the two
 * surfaces are allowed to disagree about the same id.
 */
const INVISIBLE_RUN = /(?:[\u200B-\u200F\u2060\uFEFF]|[\u{E0000}-\u{E007F}]){2,}|[\u{E0000}-\u{E007F}]/u;

export const INVISIBLE_RUN_RULE: LintRule = {
  id: "CAS-L006",
  evidence: "shape",
  // The one surface it exists for. The catalogue entry carries `"output"` too,
  // because the id does run there; `rulesForSurface` is what swaps this in.
  surfaces: ["output"],
  severity: "error",
  describe: "invisible/steganographic Unicode in description",
  owasp: ["MCP03:2025"],
  safeMcp: ["SAFE-T1402"],
  pattern: INVISIBLE_RUN,
  find: (text) => {
    const m = INVISIBLE_RUN.exec(text);
    if (!m) return null;
    const run = [...m[0]];
    return (
      `contains U+${run[0]!.codePointAt(0)!.toString(16).toUpperCase()}` +
      ` (${run.length} invisible code point${run.length === 1 ? "" : "s"} in a row)`
    );
  },
};

/**
 * The rules that run on one surface, in catalogue order.
 *
 * The replacement for two lists that used to be kept by hand, and the reason
 * `LintRule.surfaces` exists: a rule's reach is declared once, beside the rule,
 * and everything that needs to know asks here.
 */
export function rulesForSurface(surface: LintSurface): LintRule[] {
  // A rule that declares nothing runs on every declared surface, which is what
  // the whole catalogue ran on before `surfaces` existed. See `LintRule`.
  return LINT_RULES.filter((rule) => (rule.surfaces ?? DECLARED).includes(surface)).map((rule) =>
    // CAS-L006 is the one id whose threshold differs by surface: a lone
    // invisible code point is suspicious in a declaration and ordinary in
    // returned data. See `INVISIBLE_RUN_RULE` for the measurement.
    surface === "output" && rule.id === INVISIBLE_RUN_RULE.id ? INVISIBLE_RUN_RULE : rule
  );
}

/**
 * The severity a rule can reach on a surface: its own, unless the pairing
 * carries a lower ceiling.
 *
 * The release-discipline cap in check.ts is a separate thing and is applied
 * after this one; see `LintRule.cap`.
 */
export function severityOn(rule: LintRule, surface: LintSurface): LintSeverity {
  return rule.cap?.[surface] === "warn" ? "warn" : rule.severity;
}

export const LINT_RULES: LintRule[] = [
  regexRule({
    id: "CAS-L001",
    evidence: "shape",
    surfaces: DECLARED_AND_OUTPUT,
    severity: "error",
    describe: "instruction-override phrasing (classic prompt-injection)",
    owasp: ["MCP06:2025"],
    safeMcp: ["SAFE-T1102"],
    pattern: /ignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions?|rules?|prompts?)/i,
  }),
  regexRule({
    id: "CAS-L002",
    evidence: "shape",
    surfaces: DECLARED,
    severity: "error",
    describe: "hidden-instruction markers in description",
    owasp: ["MCP03:2025"],
    safeMcp: ["SAFE-T1001"],
    pattern: /<\s*(system|important|secret|hidden|instructions?)\s*>|<!--/i,
  }),
  regexRule({
    id: "CAS-L003",
    evidence: "shape",
    surfaces: DECLARED_AND_OUTPUT,
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
    surfaces: PROSE,
    severity: "error",
    describe: "references sensitive local material (SSH keys, .env, credentials)",
    owasp: ["MCP01:2025"],
    safeMcp: ["SAFE-T1001"],
    pattern: /(\.ssh\b|id_rsa|\.env\b|credentials?\.json|api[_-]?keys?\b[^.]{0,30}(read|collect|include|attach))/i,
  }),
  ...TAIL_RULES,
  ...NEW_RULES,
];
