/**
 * `mcp-cassette check` — one-shot health & safety check of an MCP server.
 *
 * Connects, performs the lifecycle handshake, lists tools/resources/prompts,
 * validates every tool inputSchema as JSON Schema 2020-12 (ajv), and runs the
 * description safety lint. Exit code 1 if any error-level finding exists —
 * built for CI.
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
import { MiniClient, Target, Tool } from "./client.js";
import { lintTool, LintFinding } from "./lint.js";

export type FindingLevel = "error" | "warn" | "info";

export interface CheckFinding {
  level: FindingLevel;
  code: string;
  subject: string;
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
  ok: boolean;
}

const TOOL_NAME_RE = /^[a-zA-Z0-9_.-]{1,128}$/;

export async function runCheck(target: Target, targetLabel: string): Promise<CheckReport> {
  const findings: CheckFinding[] = [];
  const { client, init } = await MiniClient.connect(target);

  try {
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
      }

      // ---- safety lint -----------------------------------------------------
      for (const f of lintTool(tool)) {
        findings.push({
          level: f.severity === "error" ? "error" : "warn",
          code: f.rule,
          subject: f.toolName,
          message: f.message,
          excerpt: f.excerpt,
        });
      }
    }

    // ---- optional surfaces -------------------------------------------------
    let resourceCount: number | undefined;
    let promptCount: number | undefined;
    const caps = (init.capabilities ?? {}) as Record<string, unknown>;
    if (caps.resources) {
      try {
        resourceCount = (await client.listAll("resources/list", "resources")).length;
      } catch (err) {
        findings.push({
          level: "warn",
          code: "CAS-C006",
          subject: "resources/list",
          message: `capability advertised but listing failed: ${(err as Error).message}`,
        });
      }
    }
    if (caps.prompts) {
      try {
        promptCount = (await client.listAll("prompts/list", "prompts")).length;
      } catch (err) {
        findings.push({
          level: "warn",
          code: "CAS-C007",
          subject: "prompts/list",
          message: `capability advertised but listing failed: ${(err as Error).message}`,
        });
      }
    }

    const ok = !findings.some((f) => f.level === "error");
    return {
      target: targetLabel,
      server: init.serverInfo,
      protocolVersion: init.protocolVersion,
      toolCount: tools.length,
      resourceCount,
      promptCount,
      findings,
      ok,
    };
  } finally {
    await client.close();
  }
}

export function printReport(report: CheckReport): void {
  const line = (s = "") => process.stdout.write(s + "\n");
  line();
  line(`mcp-cassette check — ${report.target}`);
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
  line(`result: ${report.ok ? "PASS" : "FAIL"} (${errors} error(s), ${warns} warning(s))`);
}
