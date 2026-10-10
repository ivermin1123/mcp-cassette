/**
 * `mcp-cassette check`: one-shot health & safety check of an MCP server.
 *
 * Connects, performs the lifecycle handshake, lists tools/resources/prompts,
 * validates every tool inputSchema as JSON Schema 2020-12 (ajv), and runs the
 * safety lint over every model-facing text the server publishes: tools,
 * prompts, resources and resource templates alike. Built for CI: the caller
 * exits 1 on a finding at or above its gate, `failOn` for the structural CAS-C
 * checks and `lintFailOn` for the CAS-L lint, and 2 when the server could not
 * be inspected at all.
 */

import Ajv2020 from "ajv/dist/2020.js";
import AjvDraft7 from "ajv";
import addFormatsModule from "ajv-formats";

// CJS/ESM interop: these packages ship CJS with an `exports.default`.
type AjvLike = { compile: (schema: object) => unknown };
type AjvCtorT = new (opts: object) => AjvLike;
const interop = <T>(mod: unknown): T =>
  (((mod as { default?: unknown }).default ?? mod) as T);
const Ajv2020Ctor = interop<AjvCtorT>(Ajv2020);
const Ajv7Ctor = interop<AjvCtorT>(AjvDraft7);
const addFormats = interop<(ajv: unknown) => void>(addFormatsModule);

/**
 * The MCP spec defaults to JSON Schema 2020-12, but much of the ecosystem
 * ships draft-07 (zod-to-json-schema's default). Validate each schema with
 * the dialect it declares.
 */
function isDraft7(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;
  const id = (schema as Record<string, unknown>).$schema;
  return typeof id === "string" && id.includes("draft-07");
}
import { EraOption, MiniClient, Target, Tool } from "./client.js";
import {
  lintPrompt,
  lintResource,
  lintTool,
  type LintFinding,
  type Prompt,
  type Resource,
  type SubjectKind,
} from "./lint.js";
import { resolveHeaderParams } from "./transport.js";

export type FindingLevel = "error" | "warn" | "info";

export interface CheckFinding {
  level: FindingLevel;
  code: string;
  subject: string;
  /**
   * What `subject` names, when naming it is not enough.
   *
   * Absent for a tool, and for the list method CAS-C006 and CAS-C007 name.
   * Writing `"tool"` out would be tidier and would also change the JSON and
   * the SARIF fingerprint of every finding issued before prompts and resources
   * were linted, and a fingerprint is triage state in somebody's Security
   * tab. So absent is the old surface and present is a new one, in the report
   * and in the hash alike.
   */
  kind?: SubjectKind;
  message: string;
  excerpt?: string;
}

export interface CheckReport {
  target: string;
  server?: { name?: string; version?: string };
  protocolVersion?: string;
  toolCount: number;
  resourceCount?: number;
  promptCount?: number;
  findings: CheckFinding[];
  /** The gates `ok` was decided against, so a verdict can be read without the flags. */
  failOn: CheckFailOn;
  lintFailOn: LintFailOn;
  ok: boolean;
}

const TOOL_NAME_RE = /^[a-zA-Z0-9_.-]{1,128}$/;

/**
 * The lowest finding level that makes the run fail.
 *
 * `error` is the default because the warn tier is mostly `intent`-class lint,
 * findings that are true about a tool without being wrong (a terminal server
 * really does run commands). Turning those red by default would teach everyone
 * to pass a mute flag, which is the one outcome worse than not reporting them.
 * `warn` is there for anyone who wants the stricter gate deliberately, and it
 * reads the same way as `snapshot --fail-on`.
 */
export type CheckFailOn = "error" | "warn";

/**
 * The same, for the `CAS-L*` safety lint alone, which is the only part of a
 * check that is an opinion about text an attacker wrote.
 *
 * It has a `never` the structural gate does not, because the two failures are
 * not the same kind of thing. A new lint rule firing on an unchanged server is
 * an adoption problem, and the move it used to force (dropping the lint from
 * the gate) threw away the report along with the gate. `CAS-C*` is the other
 * kind: a duplicate tool name or an `inputSchema` that is not valid JSON Schema
 * is the server being broken, not the linter having an opinion, so `never` does
 * not reach it and such a run still fails.
 *
 * It defaults to whatever `--fail-on` is set to, so the stricter gate still
 * covers the lint: `--fail-on warn` gates lint warnings exactly as it did
 * before this level existed.
 */
export type LintFailOn = CheckFailOn | "never";

/**
 * Which gate a finding answers to. The `CAS-L` prefix is load-bearing rather
 * than cosmetic, and `tests/lint-foundation.test.ts` holds every rule id to it
 * so a new rule cannot quietly land outside the lint gate it belongs to.
 */
function isLintFinding(finding: CheckFinding): boolean {
  return finding.code.startsWith("CAS-L");
}

function fails(finding: CheckFinding, failOn: CheckFailOn, lintFailOn: LintFailOn): boolean {
  const gate = isLintFinding(finding) ? lintFailOn : failOn;
  if (gate === "never") return false;
  return gate === "warn" ? finding.level !== "info" : finding.level === "error";
}

/**
 * A lint finding, as `check` reports it.
 *
 * A rule keeps its own severity on the tool surface, where it has been running
 * since the rule set existed. On the prompt and resource surfaces it is capped
 * at `warn` whatever the rule says, so an upgrade cannot turn an unchanged
 * server's default gate red on the day it lands; they graduate to the rule's
 * own level in the next minor. That is the discipline CONTRIBUTING states
 * under "A new rule ships at `warn` before it may gate", and it covers an
 * existing rule pointed at a surface it did not scan before exactly as it
 * covers a new rule.
 *
 * That cap is this release's, and the minor that graduates these surfaces
 * removes it from the line below. The ceilings a rule declares for itself are
 * not removed with it: `severityOn` has already applied them, so
 * `finding.severity` arrives at its permanent level and a pairing the
 * catalogue holds at `warn` for good cannot be graduated from here. See
 * `LintRule.cap`, which CAS-L013 over a prompt description carries.
 */
function asFinding(finding: LintFinding): CheckFinding {
  const isTool = finding.kind === "tool";
  return {
    level: isTool && finding.severity === "error" ? "error" : "warn",
    code: finding.rule,
    subject: finding.subject,
    // Absent for a tool; see `kind` on CheckFinding.
    ...(isTool ? {} : { kind: finding.kind }),
    message: finding.message,
    excerpt: finding.excerpt,
  };
}

export async function runCheck(
  target: Target,
  targetLabel: string,
  era: EraOption = "auto",
  failOn: CheckFailOn = "error",
  lintFailOn: LintFailOn = failOn
): Promise<CheckReport> {
  const findings: CheckFinding[] = [];
  const { client, init } = await MiniClient.connect(target, undefined, era);

  try {
    // The raw list, not the one a calling client would keep: `check` lints
    // what the server advertises to every client, and a tool a 2026-07-28 HTTP
    // client must refuse is still served to a stdio client and to every client
    // predating the annotation. Dropping it here would let a server silence a
    // lint finding with a one-key edit; the declaration is reported instead.
    const tools = await client.listAll<Tool>("tools/list", "tools");

    // ---- structural checks -------------------------------------------------
    const seen = new Map<string, number>();
    for (const tool of tools) {
      seen.set(tool.name, (seen.get(tool.name) ?? 0) + 1);
    }
    for (const [name, count] of seen) {
      if (count > 1) {
        findings.push({
          level: "error",
          code: "CAS-C001",
          subject: name,
          message: `duplicate tool name (${count} occurrences)`,
        });
      }
    }

    const ajvOpts = { strict: false, allErrors: true, validateFormats: true };
    const ajv2020 = new Ajv2020Ctor(ajvOpts);
    const ajv7 = new Ajv7Ctor(ajvOpts);
    addFormats(ajv2020);
    addFormats(ajv7);

    for (const tool of tools) {
      if (!TOOL_NAME_RE.test(tool.name)) {
        findings.push({
          level: "warn",
          code: "CAS-C002",
          subject: tool.name,
          message: "tool name outside recommended charset/length ([a-zA-Z0-9_.-], ≤128)",
        });
      }
      if (!tool.description || tool.description.trim().length === 0) {
        findings.push({
          level: "warn",
          code: "CAS-C003",
          subject: tool.name,
          message: "missing description (models select tools by description)",
        });
      }
      if (tool.inputSchema === undefined) {
        findings.push({
          level: "error",
          code: "CAS-C004",
          subject: tool.name,
          message: "missing inputSchema (required by the MCP specification)",
        });
      } else {
        try {
          const ajv = isDraft7(tool.inputSchema) ? ajv7 : ajv2020;
          ajv.compile(tool.inputSchema as object);
        } catch (err) {
          findings.push({
            level: "error",
            code: "CAS-C005",
            subject: tool.name,
            message: `inputSchema is not valid JSON Schema: ${(err as Error).message}`,
          });
        }
        // A tool no conformant client will call is a contract defect of the
        // same class as the two above, and it is a property of the schema
        // rather than of the wire, so it is reported on every transport.
        const declared = resolveHeaderParams(tool.inputSchema);
        if ("invalid" in declared) {
          findings.push({
            level: "warn",
            code: "CAS-C008",
            subject: tool.name,
            message:
              "invalid x-mcp-header declaration, so a 2026-07-28 Streamable HTTP client must " +
              `refuse this tool whatever transport it is served over: ${declared.invalid}`,
          });
        }
      }

      // ---- safety lint -----------------------------------------------------
      for (const f of lintTool(tool)) findings.push(asFinding(f));
    }

    // ---- optional surfaces -------------------------------------------------
    // A prompt template and a resource listing are read by the model exactly
    // as a tool description is, and are written by the same hand, so the same
    // rules run over them. Both eras answer these methods with the same list
    // shapes, and `listAll` is what knows the difference.
    let resourceCount: number | undefined;
    let promptCount: number | undefined;
    const caps = (init.capabilities ?? {}) as Record<string, unknown>;
    if (caps.resources) {
      try {
        const resources = await client.listAll<Resource>("resources/list", "resources");
        resourceCount = resources.length;
        for (const resource of resources) {
          for (const f of lintResource(resource)) findings.push(asFinding(f));
        }
      } catch (err) {
        findings.push({
          level: "warn",
          code: "CAS-C006",
          subject: "resources/list",
          message: `capability advertised but listing failed: ${(err as Error).message}`,
        });
      }
      // Templates live under the same capability but a separate method, and a
      // server that has none commonly answers it with "method not found"
      // rather than an empty list. Reporting that would fire on servers doing
      // nothing wrong, which is how a check stops being read; templates that
      // *are* listed are linted like any other resource.
      try {
        const templates = await client.listAll<Resource>("resources/templates/list", "resourceTemplates");
        for (const template of templates) {
          for (const f of lintResource(template)) findings.push(asFinding(f));
        }
      } catch {
        // Intentionally silent; see above.
      }
    }
    if (caps.prompts) {
      try {
        const prompts = await client.listAll<Prompt>("prompts/list", "prompts");
        promptCount = prompts.length;
        for (const prompt of prompts) {
          for (const f of lintPrompt(prompt)) findings.push(asFinding(f));
        }
      } catch (err) {
        findings.push({
          level: "warn",
          code: "CAS-C007",
          subject: "prompts/list",
          message: `capability advertised but listing failed: ${(err as Error).message}`,
        });
      }
    }

    const ok = !findings.some((f) => fails(f, failOn, lintFailOn));
    return {
      target: targetLabel,
      server: init.serverInfo,
      protocolVersion: init.protocolVersion,
      toolCount: tools.length,
      resourceCount,
      promptCount,
      findings,
      failOn,
      lintFailOn,
      ok,
    };
  } finally {
    await client.close();
  }
}

export function printReport(report: CheckReport): void {
  const line = (s = "") => process.stdout.write(s + "\n");
  line();
  line(`mcp-cassette check: ${report.target}`);
  line(
    `server: ${report.server?.name ?? "unknown"}@${report.server?.version ?? "?"}  protocol: ${
      report.protocolVersion ?? "?"
    }`
  );
  const counts = [`${report.toolCount} tools`];
  if (report.resourceCount !== undefined) counts.push(`${report.resourceCount} resources`);
  if (report.promptCount !== undefined) counts.push(`${report.promptCount} prompts`);
  line(`surface: ${counts.join(", ")}`);
  line();

  if (report.findings.length === 0) {
    line("[OK] no findings");
  } else {
    for (const f of report.findings) {
      const tag = f.level === "error" ? "[FAIL]" : f.level === "warn" ? "[WARN]" : "[INFO]";
      line(`${tag} ${f.code} ${f.subject}: ${f.message}`);
      if (f.excerpt) line(`       evidence: "${f.excerpt}"`);
    }
  }
  line();
  const errors = report.findings.filter((f) => f.level === "error").length;
  const warns = report.findings.filter((f) => f.level === "warn").length;
  const gate =
    report.lintFailOn === report.failOn
      ? `gate: ${report.failOn}`
      : `gate: ${report.failOn}, lint: ${report.lintFailOn}`;
  line(`result: ${report.ok ? "PASS" : "FAIL"} (${errors} error(s), ${warns} warning(s), ${gate})`);
}
