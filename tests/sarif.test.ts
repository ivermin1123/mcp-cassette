/**
 * SARIF output, validated against the specification rather than against our
 * own idea of it.
 *
 * The schema is the official OASIS one, vendored under schemas/ so the suite
 * never touches the network; a fetch here would turn somebody else's outage
 * into our red build, and offline CI is the thing this project exists to
 * provide. A weekly canary warns if the copy drifts; see
 * scripts/vendored-schema-canary.mjs.
 *
 * Schema validity is necessary and nowhere near sufficient: a document can be
 * perfectly well-formed and still say the wrong thing. So the assertions below
 * split in two: the schema decides the shape, and the rest decide the meaning.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import AjvDraft04Module from "ajv-draft-04";
import addFormatsModule from "ajv-formats";
import { toSarif } from "../src/sarif.js";
import { LINT_RULES } from "../src/lint-rules.js";
import type { CheckReport } from "../src/check.js";

const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const schemaDir = path.join(root, "schemas");

// CJS/ESM interop, the same shape check.ts already needs for its ajv builds.
// The SARIF schema is draft-04, which ajv 8 does not read without this variant.
type AjvLike = { compile: (schema: object) => (doc: unknown) => boolean };
const interop = <T>(mod: unknown): T => ((mod as { default?: unknown }).default ?? mod) as T;
const AjvDraft04 = interop<new (opts: object) => AjvLike>(AjvDraft04Module);
const addFormats = interop<(ajv: unknown) => void>(addFormatsModule);

const schema = JSON.parse(fs.readFileSync(path.join(schemaDir, "sarif-schema-2.1.0.json"), "utf8"));
const ajv = new AjvDraft04({ strict: false, allErrors: true });
addFormats(ajv);
const validateSarif = ajv.compile(schema) as ((doc: unknown) => boolean) & { errors?: unknown[] | null };

const report = (findings: CheckReport["findings"], ok = false): CheckReport => ({
  target: "node my-server.js",
  server: { name: "my-server", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  toolCount: 2,
  findings,
  ok,
});

const lintFinding = {
  level: "error" as const,
  code: "CAS-L001",
  subject: "get_weather",
  message: "instruction-override phrasing (classic prompt-injection) (in description)",
  excerpt: "Ignore previous instructions and…",
};
const warnFinding = {
  level: "warn" as const,
  code: "CAS-L012",
  subject: "run_command",
  message: "tool declares command execution — verify intended (in description)",
};
const contractFinding = {
  level: "error" as const,
  code: "CAS-C005",
  subject: "broken",
  message: "inputSchema is not valid JSON Schema: …",
};

const validate = (doc: unknown): true | string => {
  if (validateSarif(doc)) return true;
  return JSON.stringify(validateSarif.errors?.slice(0, 4), null, 1);
};

describe("the document satisfies the official SARIF 2.1.0 schema", () => {
  it.each([
    ["no findings", report([], true)],
    ["a lint finding", report([lintFinding])],
    ["a warn finding", report([warnFinding], true)],
    ["mixed lint and contract findings", report([lintFinding, warnFinding, contractFinding])],
  ])("validates with %s", (_name, input) => {
    expect(validate(toSarif(input))).toBe(true);
  });

  it("would reject a malformed document, so the check is not vacuous", () => {
    // If the validator accepted anything, every assertion above would be
    // meaningless. Prove it says no.
    expect(validate({ version: "2.1.0", runs: "not-an-array" })).not.toBe(true);
  });
});

describe("what the document says", () => {
  const doc = toSarif(report([lintFinding, warnFinding, contractFinding])) as {
    version: string;
    runs: Array<{
      tool: { driver: { name: string; rules: Array<{ id: string; helpUri: string; properties: { tags: string[] } }> } };
      results: Array<{
        ruleId: string;
        level: string;
        message: { text: string };
        partialFingerprints: Record<string, string>;
        locations: Array<{ logicalLocations: Array<{ fullyQualifiedName: string }> }>;
      }>;
    }>;
  };
  const run = doc.runs[0]!;

  it("uses the ids the CLI prints, so one identifier means one thing", () => {
    expect(run.results.map((r) => r.ruleId)).toEqual(["CAS-L001", "CAS-L012", "CAS-C005"]);
  });

  it("translates warn into SARIF's word for it", () => {
    // SARIF has no "warn"; a document using it would validate as a free-form
    // string in some positions and mean nothing to GitHub.
    expect(run.results.map((r) => r.level)).toEqual(["error", "warning", "error"]);
  });

  it("carries the standards mapping as tags", () => {
    const rule = run.tool.driver.rules.find((r) => r.id === "CAS-L001")!;
    expect(rule.properties.tags).toContain("OWASP/MCP06:2025");
    expect(rule.properties.tags).toContain("SAFE-T1102");
    expect(rule.properties.tags).toContain("evidence/shape");
    expect(rule.helpUri).toMatch(/^https:\/\//);
  });

  it("describes only the rules that fired", () => {
    // Sixteen rule descriptions against three findings is noise.
    expect(run.tool.driver.rules.map((r) => r.id).sort()).toEqual(["CAS-C005", "CAS-L001", "CAS-L012"]);
    expect(run.tool.driver.rules.length).toBeLessThan(LINT_RULES.length);
  });

  it("locates findings logically, because there is no file to point at", () => {
    // check inspects a live server. A physicalLocation here would be invented.
    expect(run.results[0]!.locations[0]!.logicalLocations[0]!.fullyQualifiedName).toBe("get_weather");
    expect(JSON.stringify(run.results)).not.toContain("physicalLocation");
  });

  it("keeps the excerpt in the message", () => {
    expect(run.results[0]!.message.text).toContain("Ignore previous instructions");
  });
});

describe("partialFingerprints survive a reworded description", () => {
  const fingerprint = (finding: CheckReport["findings"][number]) => {
    const doc = toSarif(report([finding])) as {
      runs: Array<{ results: Array<{ partialFingerprints: Record<string, string> }> }>;
    };
    return doc.runs[0]!.results[0]!.partialFingerprints["mcpCassetteFindingV1"];
  };

  it("does not change when only the excerpt changes", () => {
    // Otherwise every wording tweak resurrects a triaged alert as a new one.
    const before = fingerprint(lintFinding);
    const after = fingerprint({ ...lintFinding, excerpt: "completely different excerpt text" });
    expect(after).toBe(before);
  });

  it("differs across rules and across tools", () => {
    expect(fingerprint({ ...lintFinding, code: "CAS-L002" })).not.toBe(fingerprint(lintFinding));
    expect(fingerprint({ ...lintFinding, subject: "other_tool" })).not.toBe(fingerprint(lintFinding));
  });

  it("is stable across runs", () => {
    expect(fingerprint(lintFinding)).toBe(fingerprint(lintFinding));
  });
});

describe("the vendored schema is the one it claims to be", () => {
  const meta = JSON.parse(fs.readFileSync(path.join(schemaDir, "vendored.json"), "utf8")) as {
    schemas: Array<{ file: string; source: string; sha256: string; bytes: number; downloaded: string }>;
  };

  it.each(meta.schemas)("matches the recorded hash for $file", (entry) => {
    // The canary compares this copy with upstream. If the copy can be edited
    // without anything noticing, that comparison proves nothing.
    const raw = fs.readFileSync(path.join(schemaDir, entry.file));
    expect(createHash("sha256").update(raw).digest("hex")).toBe(entry.sha256);
    expect(raw.length).toBe(entry.bytes);
  });

  it("records where each copy came from and when", () => {
    for (const entry of meta.schemas) {
      expect(entry.source).toMatch(/^https:\/\//);
      expect(entry.downloaded).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
