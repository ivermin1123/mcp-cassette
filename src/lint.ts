/**
 * Tool-description safety lint.
 *
 * Turns prose guidance from the MCP security literature (tool-poisoning
 * research, SAFE-MCP techniques, OWASP Agentic Top 10) into fast, explainable
 * heuristics. These are heuristics, not proofs: they catch the known shapes of
 * description-borne attacks and context abuse.
 */

import type { Tool } from "./client.js";

export type LintSeverity = "error" | "warn";

export interface LintFinding {
  rule: string;
  severity: LintSeverity;
  toolName: string;
  message: string;
  excerpt?: string;
}

interface Rule {
  id: string;
  severity: LintSeverity;
  describe: string;
  find: (text: string) => string | null; // returns evidence excerpt or null
}

function excerptAround(text: string, index: number, len = 60): string {
  const start = Math.max(0, index - 20);
  return text.slice(start, start + len).replace(/\s+/g, " ").trim();
}

function regexRule(id: string, severity: LintSeverity, describe: string, re: RegExp): Rule {
  return {
    id,
    severity,
    describe,
    find: (text) => {
      const m = re.exec(text);
      return m ? excerptAround(text, m.index) : null;
    },
  };
}

export const LINT_RULES: Rule[] = [
  regexRule(
    "CAS-L001",
    "error",
    "instruction-override phrasing (classic prompt-injection)",
    /ignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions?|rules?|prompts?)/i
  ),
  regexRule(
    "CAS-L002",
    "error",
    "hidden-instruction markers in description",
    /<\s*(system|important|secret|hidden|instructions?)\s*>|<!--/i
  ),
  regexRule(
    "CAS-L003",
    "error",
    "concealment directive (do not tell/inform the user)",
    /do\s+not\s+(tell|inform|mention|reveal|show|notify|alert)[^.]{0,40}(user|human|operator)/i
  ),
  regexRule(
    "CAS-L004",
    "error",
    "exfiltration-shaped directive (send/post/upload data to a URL)",
    /(send|post|upload|forward|transmit)[^.]{0,60}https?:\/\//i
  ),
  regexRule(
    "CAS-L005",
    "error",
    "references sensitive local material (SSH keys, .env, credentials)",
    /(\.ssh\b|id_rsa|\.env\b|credentials?\.json|api[_-]?keys?\b[^.]{0,30}(read|collect|include|attach))/i
  ),
  {
    id: "CAS-L006",
    severity: "error",
    describe: "invisible/steganographic Unicode in description",
    find: (text) => {
      const re = /[\u200B-\u200F\u2060\uFEFF]|[\u{E0000}-\u{E007F}]/u;
      const m = re.exec(text);
      if (!m) return null;
      return `contains U+${m[0]!.codePointAt(0)!.toString(16).toUpperCase()}`;
    },
  },
  {
    id: "CAS-L007",
    severity: "warn",
    describe: "large opaque blob (base64-like) embedded in description",
    find: (text) => {
      const m = /[A-Za-z0-9+/=]{120,}/.exec(text);
      return m ? `${m[0]!.slice(0, 40)}… (${m[0]!.length} chars)` : null;
    },
  },
  {
    id: "CAS-L008",
    severity: "warn",
    describe: "oversized description (context-window bloat)",
    find: (text) => (text.length > 1500 ? `${text.length} chars (recommended < 1500)` : null),
  },
];

export function lintTool(tool: Tool): LintFinding[] {
  const findings: LintFinding[] = [];
  const surfaces: Array<[string, string]> = [];
  if (typeof tool.description === "string") surfaces.push(["description", tool.description]);
  // Attackers also hide instructions inside schema descriptions.
  collectSchemaDescriptions(tool.inputSchema, "inputSchema", surfaces);

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

function collectSchemaDescriptions(
  node: unknown,
  path: string,
  out: Array<[string, string]>,
  depth = 0
): void {
  if (!node || typeof node !== "object" || depth > 6) return;
  const obj = node as Record<string, unknown>;
  if (typeof obj.description === "string") out.push([path + ".description", obj.description]);
  for (const key of ["properties", "items", "anyOf", "oneOf", "allOf", "$defs", "definitions"]) {
    const child = obj[key];
    if (Array.isArray(child)) {
      child.forEach((c, i) => collectSchemaDescriptions(c, `${path}.${key}[${i}]`, out, depth + 1));
    } else if (child && typeof child === "object") {
      for (const [name, sub] of Object.entries(child as Record<string, unknown>)) {
        collectSchemaDescriptions(sub, `${path}.${key}.${name}`, out, depth + 1);
      }
    }
  }
}
