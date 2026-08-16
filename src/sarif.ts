/**
 * SARIF 2.1.0 output for `check`.
 *
 * SARIF is what GitHub code scanning reads, so this is the format that turns a
 * safety finding into a row in the Security tab instead of a line in a log
 * nobody opens. The rule ids are the same `CAS-Lxxx` / `CAS-Cxxx` the CLI
 * prints: one identifier, wherever you meet it.
 *
 * `check` inspects a *live server*, so for a long time this emitted
 * `logicalLocations` and nothing else: there is no source file the server's
 * behaviour lives in, and a fabricated line number is a lie a reader would act
 * on. That reasoning was right about fabrication and wrong about the
 * conclusion. GitHub code scanning rejects every result without a
 * `physicalLocation` ("expected a physical location"), so the document uploaded
 * cleanly and then produced no alerts at all.
 *
 * The repair is an anchor that is true rather than convenient. When a contract
 * snapshot is present, the tool surface the finding describes **is** recorded
 * in that committed file, at a line this module can locate, and that file is
 * where a developer goes to see what their server advertises. Pointing there
 * invents nothing.
 *
 * So: `physicalLocation` exists only when a real file was resolved, never
 * otherwise, and `logicalLocations` stays alongside it for consumers that read
 * logical locations. With no anchor the document is still emitted, still valid,
 * and the caller warns that GitHub will discard it.
 */

import { createHash } from "node:crypto";
import { LINT_RULES } from "./lint-rules.js";
import { VERSION } from "./version.js";
import type { CheckFinding, CheckReport, FindingLevel } from "./check.js";

/** NUL cannot occur in a rule id or a tool name, so it cannot forge a collision. */
const SEP = "\u0000";

const SCHEMA_URL = "https://json.schemastore.org/sarif-2.1.0.json";
const DOCS = "https://github.com/ivermin1123/mcp-cassette#safety-lint-rules";

/** SARIF has no "warn"; the spec's word is "warning". */
const LEVELS: Record<FindingLevel, string> = { error: "error", warn: "warning", info: "note" };

/** The `check`-side codes, which have no LintRule to describe them. */
const CONTRACT_RULES: Array<[string, string]> = [
  ["CAS-C001", "duplicate tool name"],
  ["CAS-C002", "tool name outside the recommended charset or length"],
  ["CAS-C003", "missing description"],
  ["CAS-C004", "missing inputSchema"],
  ["CAS-C005", "inputSchema is not valid JSON Schema"],
  ["CAS-C006", "advertised capability failed to list"],
  ["CAS-C007", "advertised capability failed to list"],
];

/**
 * A real file to hang findings on, and where inside it each subject sits.
 *
 * `uri` is always a path that exists, relative to the repository root, because
 * a path that does not exist is worse than no location at all: code scanning
 * would accept it and then show a developer a file they cannot open.
 */
export interface SarifAnchor {
  uri: string;
  /** 1-based line for a subject; 1 when the subject cannot be located in the file. */
  lineOf(subject: string): number;
}

/**
 * Line of each tool's `"name"` inside a contract snapshot, keyed by tool name.
 *
 * Snapshots are written with `JSON.stringify(..., 2)`, but this does not lean
 * on that indentation. It tracks bracket depth outside string literals, so it
 * only reads `"name"` keys that are direct members of an element of the `tools`
 * array. A description containing the text `"name": "add"` is inside a string
 * and never counted.
 *
 * A subject with no entry is absent from the map rather than guessed at, which
 * is what lets the caller fall back to line 1 instead of pointing at a line
 * that means something else.
 */
export function snapshotToolLines(text: string): Map<string, number> {
  const lines = new Map<string, number>();
  let depth = 0;
  let toolsDepth = -1; // depth *inside* the tools array, once found
  let inString = false;
  let escaped = false;
  let line = 1;
  let token = ""; // the current line's text, for matching keys

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\n") {
      line++;
      token = "";
      continue;
    }
    token += ch;

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      // `"tools": [` opens the array; its elements sit one level deeper.
      if (ch === "[" && toolsDepth === -1 && /"tools"\s*:\s*\[$/.test(token)) toolsDepth = depth + 1;
      depth++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth--;
      if (toolsDepth !== -1 && depth < toolsDepth) toolsDepth = -1; // left the array
      continue;
    }
    // A tool object is an element of the array, so its keys sit at toolsDepth + 1.
    if (ch === "," || ch === ":") {
      if (toolsDepth !== -1 && depth === toolsDepth + 1) {
        const m = /"name"\s*:\s*("(?:[^"\\]|\\.)*")\s*[,}]?$/.exec(token);
        if (m) {
          const name = JSON.parse(m[1]!) as string;
          if (!lines.has(name)) lines.set(name, line);
        }
      }
    }
  }
  return lines;
}

/** Anchor findings to a contract snapshot, mapping each tool to its own line. */
export function snapshotAnchor(uri: string, text: string): SarifAnchor {
  const lines = snapshotToolLines(text);
  return { uri, lineOf: (subject) => lines.get(subject) ?? 1 };
}

/**
 * Anchor findings to a file whose contents carry no line for a tool: a server
 * script, say. The file is real, so code scanning accepts it; line 1 is stated
 * rather than searched for, because nothing here knows better.
 */
export function fileAnchor(uri: string): SarifAnchor {
  return { uri, lineOf: () => 1 };
}

interface SarifRule {
  id: string;
  name?: string;
  shortDescription: { text: string };
  helpUri: string;
  properties?: { tags?: string[]; "security-severity"?: string };
}

/**
 * The rule catalogue, with the standards mapping carried through as tags.
 *
 * Tags are how GitHub surfaces a taxonomy, so the OWASP and SAFE-MCP ids that
 * `LintRule` has been carrying since the foundation pair end up visible in the
 * UI rather than only in our own JSON.
 */
function describeRules(): SarifRule[] {
  const lint: SarifRule[] = LINT_RULES.map((rule) => ({
    id: rule.id,
    name: rule.id,
    shortDescription: { text: rule.describe },
    helpUri: DOCS,
    properties: {
      tags: ["security", `evidence/${rule.evidence}`, ...rule.owasp.map((o) => `OWASP/${o}`), ...rule.safeMcp],
    },
  }));
  const contract: SarifRule[] = CONTRACT_RULES.map(([id, text]) => ({
    id,
    name: id,
    shortDescription: { text },
    helpUri: DOCS,
    properties: { tags: ["contract"] },
  }));
  return [...lint, ...contract];
}

/**
 * A fingerprint GitHub can use to recognise the same finding across runs.
 *
 * The rule and the subject tool, and deliberately nothing else. Not the
 * excerpt: it moves whenever the surrounding prose is reworded, and a
 * fingerprint that moved with it would report every edit as a brand-new alert
 * and drop whatever triage state the old one carried.
 *
 * The consequence is that one rule firing on two fields of the same tool
 * collapses into a single alert. That is the right trade: it is one problem
 * with one fix, and the message still names both fields.
 */
function fingerprintOf(finding: CheckFinding): string {
  const parts = [finding.code, finding.subject].join(SEP);
  return createHash("sha256").update(parts).digest("hex").slice(0, 16);
}

function toResult(finding: CheckFinding, anchor?: SarifAnchor) {
  const location: Record<string, unknown> = {
    logicalLocations: [{ fullyQualifiedName: finding.subject, kind: "member" }],
  };
  if (anchor) {
    location.physicalLocation = {
      artifactLocation: { uri: anchor.uri },
      region: { startLine: anchor.lineOf(finding.subject) },
    };
  }
  return {
    ruleId: finding.code,
    level: LEVELS[finding.level],
    message: { text: finding.excerpt ? `${finding.message}: ${finding.excerpt}` : finding.message },
    partialFingerprints: { mcpCassetteFindingV1: fingerprintOf(finding) },
    locations: [location],
  };
}

export function toSarif(report: CheckReport, anchor?: SarifAnchor): unknown {
  // Only rules that actually fired are worth describing: a catalogue of
  // sixteen against two findings is noise in the Security tab.
  const fired = new Set(report.findings.map((f) => f.code));
  return {
    $schema: SCHEMA_URL,
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "mcp-cassette",
            version: VERSION,
            informationUri: "https://mcpcassette.dev",
            rules: describeRules().filter((r) => fired.has(r.id)),
          },
        },
        // What was inspected, recorded as prose because it is a server, not a file.
        invocations: [{ executionSuccessful: report.ok, workingDirectory: { uri: `file://${process.cwd()}/` } }],
        properties: { target: report.target, toolCount: report.toolCount },
        results: report.findings.map((f) => toResult(f, anchor)),
      },
    ],
  };
}
