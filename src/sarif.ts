/**
 * SARIF 2.1.0 output for `check`.
 *
 * SARIF is what GitHub code scanning reads, so this is the format that turns a
 * safety finding into a row in the Security tab instead of a line in a log
 * nobody opens. The rule ids are the same `CAS-Lxxx` / `CAS-Cxxx` the CLI
 * prints: one identifier, wherever you meet it.
 *
 * One thing is deliberately absent: `physicalLocation`. `check` inspects a
 * *live server*, reached by spawning a command or opening a URL; there is no
 * file in the repository the finding sits at, and inventing a line number for
 * one would be a lie a reader would act on. Findings carry `logicalLocations`
 * instead, the tool the finding is about, which is what SARIF provides for
 * exactly this case; the field the text was found in stays in the message.
 * GitHub shows such results against the repository rather than against a line.
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

function toResult(finding: CheckFinding) {
  return {
    ruleId: finding.code,
    level: LEVELS[finding.level],
    message: { text: finding.excerpt ? `${finding.message}: ${finding.excerpt}` : finding.message },
    partialFingerprints: { mcpCassetteFindingV1: fingerprintOf(finding) },
    locations: [
      {
        logicalLocations: [{ fullyQualifiedName: finding.subject, kind: "member" }],
      },
    ],
  };
}

export function toSarif(report: CheckReport): unknown {
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
        results: report.findings.map(toResult),
      },
    ],
  };
}
