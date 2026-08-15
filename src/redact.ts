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
  // Any scheme, not just http(s): the common case is a connection string —
  // postgres://, redis://, mongodb://, mysql://, amqp:// — which an MCP server
  // wrapping a database carries in its env or its tool arguments. Only the
  // password is replaced; scheme, username, host and path are identifying rather
  // than secret, and keeping them keeps the cassette debuggable. Runs early so a
  // password that also looks like a token is redacted once, as a URL credential.
  // The scheme length is capped: unbounded, `[a-z0-9+.-]*` happily consumes a
  // long dash-separated run before failing on `://`, and a `\b` at every dash
  // makes that quadratic. Real schemes are under a dozen characters.
  { id: "urlcreds", pattern: /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@]+:([^\s/@]+)@/gi, group: 1 },
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

/**
 * `SENSITIVE_KEY` is deliberately unanchored so it still catches camelCase keys
 * like `accessToken` — weakening it would trade a visible false positive for a
 * silent missed secret. The cost is that OAuth/OIDC discovery metadata (RFC 8414)
 * uses field names containing "token" and "authorization" for values that are
 * public endpoint URLs. Exempt those on the *value* side instead: the key must be
 * a known discovery field AND the value must be a plain absolute http(s) URL.
 * `token_endpoint: "https://evil/?secret=abc"` (query string) and
 * `token_endpoint: "eyJ…"` (not a URL) both still redact.
 */
const DISCOVERY_METADATA_KEYS = new Set([
  "token_endpoint",
  "authorization_endpoint",
  "revocation_endpoint",
  "registration_endpoint",
  "introspection_endpoint",
  "userinfo_endpoint",
  "jwks_uri",
  "token_endpoint_auth_methods_supported",
  "revocation_endpoint_auth_methods_supported",
  "introspection_endpoint_auth_methods_supported",
]);

/** An absolute http(s) URL carrying no query string and no user:password. */
function isPlainHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.search === "" && url.username === "" && url.password === "";
}

/** Does this string value, seen under this sensitive key, count as a secret? */
function isKeyctxSecret(key: string, value: string): boolean {
  if (value.length < KEYCTX_MIN_LENGTH) return false;
  if (PLACEHOLDER.test(value)) return false;
  if (DISCOVERY_METADATA_KEYS.has(key.toLowerCase()) && isPlainHttpUrl(value)) return false;
  return true;
}

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
    if (wanted === 0) return placeholder(rule.id, secret);
    // Keep whatever the rule matched around its capture group (e.g. "Bearer ").
    const at = match.lastIndexOf(secret);
    return match.slice(0, at) + placeholder(rule.id, secret) + match.slice(at + secret.length);
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

/** The key a value sits under, or null when that key is not sensitive. */
type SensitiveKey = string | null;

function sensitiveKeyOf(key: string): SensitiveKey {
  return SENSITIVE_KEY.test(key) ? key : null;
}

/**
 * Define rather than assign: `out[key] = …` for the key `__proto__` invokes the
 * prototype setter instead of creating an own property, which would drop the
 * field from the cassette and move attacker-supplied data onto the result's
 * prototype.
 */
function define(out: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
}

function redactValue(value: unknown, sensitiveKey: SensitiveKey): unknown {
  if (typeof value === "string") {
    if (sensitiveKey !== null && isKeyctxSecret(sensitiveKey, value)) {
      return placeholder(KEYCTX_RULE, value);
    }
    return redactString(value);
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, sensitiveKey));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      define(out, key, redactValue(v, sensitiveKeyOf(key)));
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
  return redactValue(frame, null);
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

/**
 * Rules whose match is an arbitrary secret rather than a known literal prefix.
 * Revealing the first characters of a `keyctx` value means printing the start of
 * someone's password into a CI log, so these are masked whole.
 */
const OPAQUE_RULES = new Set([KEYCTX_RULE, "bearer", "urlcreds"]);

/** Show enough to locate the value, never enough to use it. */
export function maskSecret(secret: string, rule?: string): string {
  const visible = rule !== undefined && OPAQUE_RULES.has(rule) ? "" : secret.slice(0, 4);
  const hidden = Math.min(secret.length - visible.length, 16);
  return `${visible}${"*".repeat(Math.max(hidden, 0))} (${secret.length} chars)`;
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

function scanValue(value: unknown, path: string, sensitiveKey: SensitiveKey, out: SecretHit[]): void {
  if (typeof value === "string") {
    if (sensitiveKey !== null && isKeyctxSecret(sensitiveKey, value)) {
      out.push({ rule: KEYCTX_RULE, path, excerpt: maskSecret(value, KEYCTX_RULE) });
      return;
    }
    for (const hit of scanString(value)) {
      out.push({ rule: hit.rule, path, excerpt: maskSecret(hit.secret, hit.rule) });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanValue(v, `${path}[${i}]`, sensitiveKey, out));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      scanValue(v, path ? `${path}.${key}` : key, sensitiveKeyOf(key), out);
    }
  }
}

/** Report every secret a redaction pass would remove from this frame. */
export function scanFrame(frame: unknown): SecretHit[] {
  const out: SecretHit[] = [];
  scanValue(frame, "", null, out);
  return out;
}

// ---------------------------------------------------------------------------
// Raw lines — anything the recorder could not parse as a JSON-RPC frame.
// ---------------------------------------------------------------------------

/**
 * A raw line is not necessarily un-structured: `parseFrame` rejects JSON-RPC
 * batch arrays and any frame missing `"jsonrpc":"2.0"`, and those still carry
 * `params.arguments.password`. Scanning such a line as flat text would apply the
 * shape rules only, silently skipping `keyctx` — a secret on disk under a header
 * that claims redaction was applied.
 *
 * So: parse it, walk it for key-context secrets, and replace just those
 * substrings in the original text. Everything around them keeps its exact bytes,
 * which is what makes a raw entry a faithful transcript. A line that is not JSON
 * at all gets the shape rules and nothing more — object walking has nothing to
 * walk, and no key context exists to recover.
 */
function processRawLine(line: string, onHit?: (hit: SecretHit) => void): string {
  let text = line;
  for (const { path, secret } of collectKeyctxSecrets(line)) {
    onHit?.({ rule: KEYCTX_RULE, path, excerpt: maskSecret(secret, KEYCTX_RULE) });
    text = replaceLiteral(text, secret, placeholder(KEYCTX_RULE, secret));
  }
  let out = text;
  for (const rule of REDACT_RULES) {
    out = applyRule(out, rule, (secret) =>
      onHit?.({ rule: rule.id, path: "raw", excerpt: maskSecret(secret, rule.id) })
    );
  }
  return out;
}

/** Replace a secret wherever it appears, plain or JSON-escaped. */
function replaceLiteral(text: string, secret: string, replacement: string): string {
  let out = text.split(secret).join(replacement);
  const escaped = JSON.stringify(secret).slice(1, -1);
  if (escaped !== secret) out = out.split(escaped).join(replacement);
  return out;
}

/** Key-context secrets inside a line that happens to hold JSON. */
function collectKeyctxSecrets(line: string): Array<{ path: string; secret: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return []; // not JSON — no keys, no key context
  }
  const found: Array<{ path: string; secret: string }> = [];
  const walk = (value: unknown, path: string, sensitiveKey: SensitiveKey): void => {
    if (typeof value === "string") {
      if (sensitiveKey !== null && isKeyctxSecret(sensitiveKey, value)) {
        found.push({ path, secret: value });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`, sensitiveKey));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        walk(v, path ? `${path}.${key}` : key, sensitiveKeyOf(key));
      }
    }
  };
  walk(parsed, "", null);
  return found;
}

/** Redact a captured line that is not a JSON-RPC frame. */
export function redactRawLine(line: string): string {
  return processRawLine(line);
}

/** Report every secret a redaction pass would remove from a raw line. */
export function scanRawLine(line: string): SecretHit[] {
  const hits: SecretHit[] = [];
  processRawLine(line, (hit) => hits.push(hit));
  return hits;
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
        : { ...entry, data: redactRawLine(entry.data) }
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
        excerpt: maskSecret(hit.secret, hit.rule),
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
      for (const hit of scanRawLine(entry.data)) hits.push({ ...hit, dir: entry.dir });
    }
  }

  return hits;
}
