/**
 * Secrets redaction for cassettes.
 *
 * A cassette is meant to be committed next to the tests that consume it, so a
 * recording must not carry live credentials. Every captured string is matched
 * against an ordered list of token shapes; each hit becomes
 * `[REDACTED:<rule>:<hash8>]`, where hash8 is the first 8 hex characters of the
 * SHA-256 of the secret itself.
 *
 * The placeholder is deterministic: the same secret always collapses to the
 * same text. That is what lets replay keep matching — a live token sent by the
 * client redacts to exactly the placeholder that was recorded (see replay.ts).
 *
 * Pattern matching is a tripwire, not a proof: a credential with no recognizable
 * shape, under a key nobody would call "token", goes through untouched.
 */

import { createHash } from "node:crypto";
import type { Cassette, Direction } from "./cassette.js";
import type { JsonRpcFrame } from "./jsonrpc.js";

export interface RedactRule {
  id: string;
  /** Must be a global regex — matching goes through String.replace, which resets lastIndex. */
  pattern: RegExp;
  /** Capture group holding the secret; omit to redact the whole match. */
  group?: number;
}

/**
 * Order matters. `bearer` runs first so an `Authorization` value collapses to a
 * single placeholder instead of a placeholder inside a placeholder, and
 * `anthropic` runs before `openai` because `sk-ant-…` also satisfies the
 * generic `sk-…` shape.
 */
export const REDACT_RULES: readonly RedactRule[] = Object.freeze([
  { id: "bearer", pattern: /\bBearer\s+([A-Za-z0-9._~+/=-]{8,})/g, group: 1 },
  // Segment lengths are capped. `-` is both a class member and a word boundary,
  // so `eyJ-eyJ-…` offers one candidate start per 4 characters; an unbounded
  // first segment makes each of them rescan the rest of the line, which is
  // quadratic — 6s on 128KB, stalling the proxy's synchronous data handler.
  // Real JWT segments are far below these caps.
  { id: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{4,1024}\.[A-Za-z0-9_-]{4,8192}\.[A-Za-z0-9_-]{0,1024}/g },
  { id: "github", pattern: /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{16,})/g },
  { id: "anthropic", pattern: /\bsk-ant-[A-Za-z0-9_-]{8,}/g },
  { id: "openai", pattern: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { id: "slack", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { id: "aws", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: "google", pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
]);

/** A JSON key whose string value is treated as a secret regardless of shape. */
export const SENSITIVE_KEY =
  /(token|secret|password|passwd|api[_-]?key|authorization|credential)/i;

/** Values shorter than this under a sensitive key are left alone (flags, "none", …). */
export const KEYCTX_MIN_LENGTH = 8;

export const KEYCTX_RULE = "keyctx";

/** Recognizes our own output, so redacting twice is a no-op. */
const PLACEHOLDER = /^\[REDACTED:[a-z]+:[0-9a-f]{8}\]$/;

function hash8(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 8);
}

function placeholder(rule: string, secret: string): string {
  return `[REDACTED:${rule}:${hash8(secret)}]`;
}

/** Apply one rule, optionally reporting every secret it swallowed. */
function applyRule(s: string, rule: RedactRule, onHit?: (secret: string) => void): string {
  return s.replace(rule.pattern, (...args: unknown[]) => {
    const match = args[0] as string;
    const groups = args.slice(1, -2) as (string | undefined)[];
    const wanted = rule.group ?? 0;
    const secret = wanted === 0 ? match : groups[wanted - 1];
    if (secret === undefined) return match;
    onHit?.(secret);
    const kept = wanted === 0 ? "" : match.slice(0, match.lastIndexOf(secret));
    return kept + placeholder(rule.id, secret);
  });
}

/** Replace every recognized secret in a raw string. */
export function redactString(s: string): string {
  let out = s;
  for (const rule of REDACT_RULES) out = applyRule(out, rule);
  return out;
}

/** Redact CLI arguments recorded in the cassette header (tokens passed as flags). */
export function redactCommand(command: string[]): string[] {
  return command.map(redactString);
}

function redactValue(value: unknown, keyIsSensitive: boolean): unknown {
  if (typeof value === "string") {
    if (keyIsSensitive && value.length >= KEYCTX_MIN_LENGTH && !PLACEHOLDER.test(value)) {
      return placeholder(KEYCTX_RULE, value);
    }
    return redactString(value);
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, keyIsSensitive));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactValue(v, SENSITIVE_KEY.test(key));
    }
    return out;
  }
  return value;
}

/**
 * Deep-copy a JSON-RPC frame with every string value redacted. Pure: the input
 * is never mutated.
 */
export function redactFrame(frame: unknown): unknown {
  return redactValue(frame, false);
}

// ---------------------------------------------------------------------------
// Scanning (audit mode) — reports what redaction *would* remove, without writing.
// ---------------------------------------------------------------------------

export interface SecretHit {
  rule: string;
  /** Dotted path inside the frame, e.g. `params.arguments.token`. */
  path: string;
  /** Secret with everything but a short prefix masked out. */
  excerpt: string;
}

export interface CassetteSecretHit extends SecretHit {
  dir: Direction | "header";
  method?: string;
}

/** Show enough to locate the value, never enough to use it. */
export function maskSecret(secret: string): string {
  const visible = secret.slice(0, 4);
  const hidden = Math.min(Math.max(secret.length - 4, 0), 16);
  return `${visible}${"*".repeat(hidden)} (${secret.length} chars)`;
}

/** Run the rules in order against a string, collecting hits instead of a result. */
function scanString(s: string): Array<{ rule: string; secret: string }> {
  const hits: Array<{ rule: string; secret: string }> = [];
  let current = s;
  for (const rule of REDACT_RULES) {
    current = applyRule(current, rule, (secret) => hits.push({ rule: rule.id, secret }));
  }
  return hits;
}

function scanValue(value: unknown, path: string, keyIsSensitive: boolean, out: SecretHit[]): void {
  if (typeof value === "string") {
    if (keyIsSensitive && value.length >= KEYCTX_MIN_LENGTH && !PLACEHOLDER.test(value)) {
      out.push({ rule: KEYCTX_RULE, path, excerpt: maskSecret(value) });
      return;
    }
    for (const hit of scanString(value)) {
      out.push({ rule: hit.rule, path, excerpt: maskSecret(hit.secret) });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanValue(v, `${path}[${i}]`, keyIsSensitive, out));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      scanValue(v, path ? `${path}.${key}` : key, SENSITIVE_KEY.test(key), out);
    }
  }
}

/** Report every secret a redaction pass would remove from this frame. */
export function scanFrame(frame: unknown): SecretHit[] {
  const out: SecretHit[] = [];
  scanValue(frame, "", false, out);
  return out;
}

// ---------------------------------------------------------------------------
// Cassette-level operations
// ---------------------------------------------------------------------------

/** Redact a whole cassette. Pure — returns a new cassette, input untouched. */
export function redactCassette(cassette: Cassette): Cassette {
  const command = cassette.header.command ? redactCommand(cassette.header.command) : undefined;
  return {
    header: {
      ...cassette.header,
      ...(command ? { command } : {}),
      redaction: { applied: true },
    },
    entries: cassette.entries.map((entry) =>
      entry.type === "frame"
        ? { ...entry, frame: redactFrame(entry.frame) as JsonRpcFrame }
        : { ...entry, data: redactString(entry.data) }
    ),
  };
}

/** Report every secret still present in a cassette (audit mode for CI). */
export function scanCassette(cassette: Cassette): CassetteSecretHit[] {
  const hits: CassetteSecretHit[] = [];

  (cassette.header.command ?? []).forEach((arg, i) => {
    for (const hit of scanString(arg)) {
      hits.push({
        rule: hit.rule,
        dir: "header",
        path: `command[${i}]`,
        excerpt: maskSecret(hit.secret),
      });
    }
  });

  // A response carries no method of its own; report the one it answers.
  const methodById = new Map<string, string>();
  for (const entry of cassette.entries) {
    if (entry.type !== "frame") continue;
    const { id, method } = entry.frame as { id?: unknown; method?: string };
    if (method !== undefined && id !== undefined) methodById.set(String(id), method);
  }

  for (const entry of cassette.entries) {
    if (entry.type === "frame") {
      const { id, method: own } = entry.frame as { id?: unknown; method?: string };
      const method = own ?? (id !== undefined ? methodById.get(String(id)) : undefined);
      for (const hit of scanFrame(entry.frame)) {
        hits.push({ ...hit, dir: entry.dir, ...(method ? { method } : {}) });
      }
    } else {
      for (const hit of scanString(entry.data)) {
        hits.push({ rule: hit.rule, dir: entry.dir, path: "raw", excerpt: maskSecret(hit.secret) });
      }
    }
  }

  return hits;
}
