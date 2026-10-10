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
 * same text. That is what lets replay keep matching: a live token sent by the
 * client redacts to exactly the placeholder that was recorded (see replay.ts).
 *
 * Pattern matching is a tripwire, not a proof: a credential with no recognizable
 * shape, under a key nobody would call "token", goes through untouched.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import type { Cassette, Direction } from "./cassette.js";
import type { JsonRpcFrame } from "./jsonrpc.js";

export interface RedactRule {
  id: string;
  /** Must be a global regex, because matching goes through String.replace, which resets lastIndex. */
  pattern: RegExp;
  /** Capture group holding the secret; omit to redact the whole match. */
  group?: number;
}

/**
 * Order matters. `bearer` runs first so an `Authorization` value collapses to a
 * single placeholder instead of a placeholder inside a placeholder, and
 * `anthropic` runs before `openai` because `sk-ant-...` also satisfies the
 * generic `sk-...` shape.
 */
export const REDACT_RULES: readonly RedactRule[] = Object.freeze([
  { id: "bearer", pattern: /\bBearer\s+([A-Za-z0-9._~+/=-]{8,})/g, group: 1 },
  // Any scheme, not just http(s): the common case is a connection string.
  // postgres://, redis://, mongodb://, mysql:// and amqp:// are all shapes an MCP server
  // wrapping a database carries in its env or its tool arguments. Only the
  // password is replaced; scheme, username, host and path are identifying rather
  // than secret, and keeping them keeps the cassette debuggable. Runs early so a
  // password that also looks like a token is redacted once, as a URL credential.
  // The scheme length is capped: unbounded, `[a-z0-9+.-]*` happily consumes a
  // long dash-separated run before failing on `://`, and a `\b` at every dash
  // makes that quadratic. Real schemes are under a dozen characters.
  { id: "urlcreds", pattern: /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@]+:([^\s/@]+)@/gi, group: 1 },
  // Segment lengths are capped. `-` is both a class member and a word boundary,
  // so `eyJ-eyJ-...` offers one candidate start per 4 characters; an unbounded
  // first segment makes each of them rescan the rest of the line, which is
  // quadratic: 6s on 128KB, stalling the proxy's synchronous data handler.
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

/**
 * Sensitive names that are only safe to match as a whole key segment.
 *
 * **Adding a new sensitive name? Pick the list by collision risk, not by taste.**
 *
 * Ask whether the name appears *inside* ordinary English words or common field
 * names that carry no secret:
 *
 * - **No**: `token`, `password`, `credential`. Put it in `SENSITIVE_KEY`. That
 *   alternation is unanchored on purpose, which is what lets it catch
 *   `accessToken`, `refresh_token` and `X-Api-Key` without enumerating every
 *   spelling. A false positive there is cheap; a missed credential is not.
 * - **Yes**: short names, three or four letters, that are substrings of real
 *   words. Put it here. `pin` is the founding case: unanchored it also matches
 *   `shipping`, `mapping`, `spinner` and `pinned`, and redacting a shipping
 *   address is a worse failure than the leak it prevents. Segment matching gives
 *   `pin`, `card_pin`, `pinCode` and `user.pin` and none of the others.
 *
 * The tiebreaker when a name could go either way: unanchored matching over-
 * redacts and segment matching under-redacts, so weigh how visible each failure
 * is. Over-redaction shows up as a placeholder where a test expected data,
 * annoying, immediate, obvious. Under-redaction shows up as a credential
 * committed to a repository, and nothing tells you.
 *
 * Whichever list you choose, add both a hit case and a near-miss case to
 * `tests/redact.test.ts`. The near-miss is the one that matters; it is what
 * stops the next person from "simplifying" this back into one regex.
 */
export const SEGMENTED_SENSITIVE_KEYS: ReadonlySet<string> = new Set(["pin"]);

/**
 * A user's own rules, as `--redact-config <file>` holds them.
 *
 * The built-in rules are a tripwire for shapes everyone shares; a credential
 * with a house format, or a field name only one server uses, is invisible to
 * them. This is how that gets covered without `--no-redact`, which is the only
 * alternative the tool used to offer and which protects nothing.
 *
 * The same file has to be given to `record` and to `replay`. Redaction happens
 * before fingerprinting on both sides, so a rule that ran at record time and
 * not at replay time would leave the two sides hashing different text and every
 * request would miss. That is what the recorded config hash exists to catch.
 */
export interface RedactConfig {
  /** Extra token shapes. `name` becomes the placeholder's rule label. */
  patterns?: { name: string; regex: string; flags?: string }[];
  /** Extra key names whose string values are secrets whatever their shape. */
  keys?: string[];
  /**
   * Values the rules must leave alone, compared exactly against what a rule
   * would replace: the token after `Bearer`, the password inside a URL, the
   * whole match for every other pattern, and the whole value under a sensitive
   * key. Not a substring test, so an allowed value embedded in a longer secret
   * is still redacted.
   */
  allow?: string[];
}

/**
 * A config as every entry point takes it: patterns compiled once, lookups
 * built once, and a hash of what produced them.
 */
export interface CompiledRedactConfig {
  /**
   * User patterns first, then the built-ins. A user who writes a rule for their
   * own token format knows that format better than a generic shape does, so
   * theirs gets to claim the match; the placeholder guard then keeps a built-in
   * from redacting the result a second time.
   */
  rules: readonly RedactRule[];
  /** Lowercased, matched against the whole key and against each of its segments. */
  keys: ReadonlySet<string>;
  allow: ReadonlySet<string>;
  /**
   * sha256 of the canonical config, or absent when nothing was configured.
   * Only this goes in a cassette header: a regex describes the secrets it
   * catches and an allowed value is a value, and neither belongs in a file
   * meant to be committed.
   */
  hash?: string;
}

/** The built-in rules and nothing else: what every entry point does without a config. */
export const BUILTIN_REDACTION: CompiledRedactConfig = Object.freeze({
  rules: REDACT_RULES,
  keys: new Set<string>(),
  allow: new Set<string>(),
});

/**
 * The alphabet a placeholder can spell (`PLACEHOLDER` below), so a custom name
 * can never produce one that does not parse, and the built-in names, so it can
 * never forge one that does. A cassette reader seeing `[REDACTED:bearer:...]`
 * is entitled to conclude the bearer rule put it there.
 */
const RULE_NAME = /^[a-z]+$/;
const RESERVED_RULE_NAMES: ReadonlySet<string> = new Set([...REDACT_RULES.map((rule) => rule.id), "keyctx"]);

/** The only flags a user pattern may add. `g` is always applied and never asked for. */
const ALLOWED_FLAGS = "iu";

/** Compile and validate a config, naming what is wrong rather than failing later. */
export function compileRedactConfig(config: unknown, source = "redaction config"): CompiledRedactConfig {
  const reject = (why: string): never => {
    throw new Error(`mcp-cassette: ${source}: ${why}`);
  };
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return reject("a redaction config must be a JSON object");
  }
  for (const key of Object.keys(config)) {
    if (key !== "patterns" && key !== "keys" && key !== "allow") {
      return reject(`unknown field "${key}" (expected "patterns", "keys" or "allow")`);
    }
  }
  const raw = config as RedactConfig;

  const stringList = (value: unknown, field: string): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      return reject(`"${field}" must be a list of strings`);
    }
    return value as string[];
  };
  const keys = stringList(raw.keys, "keys");
  for (const key of keys) if (key.trim() === "") reject('"keys" holds an empty name');
  const allow = stringList(raw.allow, "allow");

  if (raw.patterns !== undefined && !Array.isArray(raw.patterns)) return reject('"patterns" must be a list');
  const patterns = raw.patterns ?? [];
  const rules: RedactRule[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of patterns.entries()) {
    const at = `patterns[${i}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return reject(`${at} must be an object with "name" and "regex"`);
    }
    const { name, regex, flags = "" } = entry as { name?: unknown; regex?: unknown; flags?: unknown };
    if (typeof name !== "string" || typeof regex !== "string") {
      return reject(`${at} must have a string "name" and a string "regex"`);
    }
    if (!RULE_NAME.test(name)) {
      return reject(`${at} name "${name}" must be lowercase letters only, because it is written into the placeholder`);
    }
    if (RESERVED_RULE_NAMES.has(name)) {
      return reject(`${at} name "${name}" is a built-in rule; a custom rule may not produce a built-in placeholder`);
    }
    if (seen.has(name)) return reject(`${at} repeats the name "${name}"`);
    seen.add(name);
    if (typeof flags !== "string" || [...flags].some((f) => !ALLOWED_FLAGS.includes(f))) {
      return reject(`${at} flags "${String(flags)}" may only use "i" and "u"; "g" is always applied`);
    }
    if (new Set(flags).size !== flags.length) return reject(`${at} repeats a flag in "${flags}"`);
    let pattern: RegExp;
    try {
      // Always global: matching goes through String.replace, which needs it to
      // reach every occurrence, and a value that occurs twice must be redacted
      // twice.
      pattern = new RegExp(regex, `g${flags}`);
    } catch (err) {
      return reject(`${at} regex does not compile: ${(err as Error).message}`);
    }
    // A pattern that matches nothing matches everywhere, so it would wrap every
    // character of every value in its own placeholder and `redact` would stop
    // being idempotent. It is one typo away from a real pattern: `[A-Z0-9-]*`
    // with the prefix left off.
    if (new RegExp(regex, flags).test("")) {
      return reject(`${at} regex matches the empty string, so it would redact every position of every value`);
    }
    rules.push({ id: name, pattern });
  }

  const configured = rules.length > 0 || keys.length > 0 || allow.length > 0;
  return {
    // A user rule runs before the built-ins; see `CompiledRedactConfig.rules`.
    rules: rules.length > 0 ? Object.freeze([...rules, ...REDACT_RULES]) : REDACT_RULES,
    keys: new Set(keys.map((key) => key.toLowerCase())),
    allow: new Set(allow),
    ...(configured ? { hash: hashConfig(raw) } : {}),
  };
}

/**
 * The hash a cassette header carries, taken over what the config *does* rather
 * than how it was written.
 *
 * Two files that redact identically have to produce one hash, or tidying the
 * file turns every cassette recorded under it into "a different redaction
 * config". So each part is normalised to the form matching actually uses:
 * `keys` are lowercased, because that is how they are compared, and
 * deduplicated and sorted, because they are a set; `allow` is deduplicated and
 * sorted but never lowercased, because it is compared exactly; flags are sorted,
 * because `RegExp` does not care in which order they were written. Pattern
 * order is kept, because it decides which rule claims an overlapping match and
 * is therefore behaviour.
 *
 * The regex source is taken as written. Two spellings of one language (`\d`
 * and `[0-9]`) hash differently, which is the one place this is stricter than
 * behaviour; recognising them as equal would mean comparing automata.
 */
function hashConfig(config: RedactConfig): string {
  const set = (values: readonly string[] | undefined) => [...new Set(values ?? [])].sort();
  const canonical = JSON.stringify({
    patterns: (config.patterns ?? []).map((p) => [p.name, p.regex, [...(p.flags ?? "")].sort().join("")]),
    keys: set((config.keys ?? []).map((key) => key.toLowerCase())),
    allow: set(config.allow),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** One pattern's verdict from `redact --check-config`. */
export interface RedactConfigCheck {
  name: string;
  /** "safe" is the only verdict that proves linear time; everything else is reported as it came. */
  status: string;
  detail: string;
}

/**
 * Analyse a config's patterns for catastrophic backtracking.
 *
 * A redaction pattern runs over whatever a server answered, which on a hostile
 * server is attacker-controlled text. A pattern that backtracks catastrophically
 * turns recording into a denial of service against the recorder, and the shape
 * of that bug is not visible by reading the regex, which is why the repo already
 * proves its own patterns linear by analysis rather than by eye.
 *
 * `recheck` is an optional peer: a user who never writes a custom pattern should
 * not carry an analyser. When it is missing this returns null, and the caller
 * says so rather than reporting a pass nobody computed.
 */
export async function checkRedactConfig(
  cfg: CompiledRedactConfig,
  timeoutMs = 60_000
): Promise<RedactConfigCheck[] | null> {
  let check: (source: string, flags: string, options: { timeout: number }) => Promise<RecheckDiagnostics>;
  try {
    ({ check } = (await import("recheck")) as {
      check: (source: string, flags: string, options: { timeout: number }) => Promise<RecheckDiagnostics>;
    });
  } catch (err) {
    // Only a module that is not there means "not installed". A `recheck` that
    // is installed and throws on load is a broken install, and reporting it as
    // absent would send the reader to `npm install` for a package they have.
    if ((err as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw err;
    return null;
  }
  const builtinNames = new Set(REDACT_RULES.map((rule) => rule.id));
  const out: RedactConfigCheck[] = [];
  for (const rule of cfg.rules) {
    // The built-ins are proven linear by `scripts/recheck-rules.mjs` on every
    // CI run, so re-proving them here would only slow the command down.
    if (builtinNames.has(rule.id)) continue;
    const diagnostics = await check(rule.pattern.source, rule.pattern.flags, { timeout: timeoutMs });
    const complexity = diagnostics.complexity?.type ?? "unreported";
    if (diagnostics.status === "safe") {
      out.push({ name: rule.id, status: "safe", detail: `${complexity}, via ${diagnostics.checker ?? "recheck"}` });
    } else if (diagnostics.status === "vulnerable") {
      out.push({
        name: rule.id,
        status: "vulnerable",
        detail: `${complexity} blowup, attack string: ${JSON.stringify(diagnostics.attack?.pattern ?? "?")}`,
      });
    } else {
      out.push({
        name: rule.id,
        status: diagnostics.status,
        detail: "recheck could not decide, so this is not a proof",
      });
    }
  }
  return out;
}

/** The part of recheck's result this uses. Declared here so recheck stays out of the build's types. */
interface RecheckDiagnostics {
  status: string;
  checker?: string;
  complexity?: { type?: string };
  attack?: { pattern?: string };
}

/** Read and compile a config file, naming the file in anything that goes wrong. */
export function readRedactConfig(path: string): CompiledRedactConfig {
  let text: string;
  try {
    text = fs.readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`mcp-cassette: cannot read the redaction config ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(`mcp-cassette: ${path} is not valid JSON: ${(err as Error).message}`);
  }
  return compileRedactConfig(parsed, path);
}

/** `cardPin_code` → ["card", "pin", "code"]. Splits camelCase and separators. */
function keySegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_.-]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase());
}

/** Values shorter than this under a sensitive key are left alone (flags, "none", and the like). */
export const KEYCTX_MIN_LENGTH = 8;

/**
 * The same floor applied to a number, counted in digits. `{"pin": 123456789}`
 * is a credential; `{"password_attempts": 3}` and `{"token_budget": 4096}` are
 * not, and redacting them would wreck ordinary recordings to no benefit.
 */
export const KEYCTX_MIN_DIGITS = KEYCTX_MIN_LENGTH;

export const KEYCTX_RULE = "keyctx";

/** Recognizes our own output, so redacting twice is a no-op. */
const PLACEHOLDER = /^\[REDACTED:[a-z]+:[0-9a-f]{8}\]$/;

/** The same shape, anywhere inside a longer string. */
const PLACEHOLDER_ANYWHERE = /\[REDACTED:[a-z]+:[0-9a-f]{8}\]/;

/**
 * `SENSITIVE_KEY` is deliberately unanchored so it still catches camelCase keys
 * like `accessToken`; weakening it would trade a visible false positive for a
 * silent missed secret. The cost is that OAuth/OIDC discovery metadata (RFC 8414)
 * uses field names containing "token" and "authorization" for values that are
 * public endpoint URLs. Exempt those on the *value* side instead: the key must be
 * a known discovery field AND the value must be a plain absolute http(s) URL.
 * `token_endpoint: "https://evil/?secret=abc"` (query string) and
 * `token_endpoint: "eyJ..."` (not a URL) both still redact.
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
function isKeyctxSecret(key: string, value: string, cfg: CompiledRedactConfig): boolean {
  if (value.length < KEYCTX_MIN_LENGTH) return false;
  if (PLACEHOLDER.test(value)) return false;
  if (cfg.allow.has(value)) return false;
  if (DISCOVERY_METADATA_KEYS.has(key.toLowerCase()) && isPlainHttpUrl(value)) return false;
  return true;
}

/**
 * A PIN, an account number or a numeric API key is a credential whether or not
 * the server bothered to quote it, so key context has to reach numbers too.
 *
 * The secret is hashed from its decimal text, which means `123456789` and
 * `"123456789"` collapse to the *same* placeholder, so a server that answers with
 * a number and a client that sends the same value as a string still match on
 * replay.
 *
 * Only finite numbers qualify; `NaN`, `Infinity` and non-integers stringify to
 * something with too few digits or none at all, and none of them are secrets.
 */
function isKeyctxNumericSecret(value: number, cfg: CompiledRedactConfig): boolean {
  if (!Number.isFinite(value)) return false;
  if (cfg.allow.has(numericSecretText(value))) return false;
  return numericSecretText(value).replace(/\D/g, "").length >= KEYCTX_MIN_DIGITS;
}

/**
 * The digits as they were written. `String()` is not enough on its own: at 1e21
 * it switches to exponential form, and hashing `"1e+21"` would key the
 * placeholder on JavaScript's formatting rather than on the value. `toFixed(0)`
 * gives up at exactly the same threshold, so integers past it go through BigInt,
 * which always spells them out.
 */
function numericSecretText(value: number): string {
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) return BigInt(value).toString();
  return String(value);
}

function hash8(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 8);
}

function placeholder(rule: string, secret: string): string {
  return `[REDACTED:${rule}:${hash8(secret)}]`;
}

/**
 * Where this string already carries placeholders, as [start, end) offsets.
 *
 * Computed once per rule application over the text as it stands, which is what
 * makes "do not rewrite inside a placeholder" a property of the mechanism
 * rather than something every future rule has to remember.
 *
 * Exported for the cassette lint, which has the same need from the other side:
 * a placeholder is this tool's own text, not the server's, so it is not
 * scanned for injection. One grammar, read in both places.
 */
export function placeholderSpans(s: string): Array<[number, number]> {
  if (!s.includes("[REDACTED:")) return []; // the overwhelmingly common case
  const spans: Array<[number, number]> = [];
  const scan = new RegExp(PLACEHOLDER_ANYWHERE.source, "g");
  for (let m = scan.exec(s); m !== null; m = scan.exec(s)) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

/** Apply one rule, optionally reporting every secret it swallowed. */
function applyRule(
  s: string,
  rule: RedactRule,
  allow: ReadonlySet<string>,
  onHit?: (secret: string) => void
): string {
  const written = placeholderSpans(s);
  return s.replace(rule.pattern, (...args: unknown[]) => {
    const match = args[0] as string;
    // The last two arguments are the offset and the whole string; a pattern
    // with named groups adds one more, so the offset is found by type.
    const tail = args.slice(1);
    const offsetAt = tail.findIndex((a) => typeof a === "number");
    const offset = tail[offsetAt] as number;
    const groups = tail.slice(0, offsetAt) as (string | undefined)[];
    const wanted = rule.group ?? 0;
    const secret = wanted === 0 ? match : groups[wanted - 1];
    if (secret === undefined) return match;
    // A pattern that can match nothing matches at every position, so it would
    // wrap each character of every value in a placeholder. Refused at load
    // time; caught here too, because a lookbehind can match empty in context
    // without matching empty on its own.
    if (secret === "") return match;
    // Never rewrite inside our own output. A user pattern has no idea what a
    // placeholder looks like: an eight-hex rule reads the hash out of
    // `[REDACTED:bearer:f5fe7daa]` and a rule matching a lowercase word reads
    // the rule name, and either one turns a second `redact` pass into a
    // different file from the first. Checked by position rather than by
    // content, because the match may be a fragment of a placeholder that
    // contains no placeholder itself.
    if (written.some(([from, to]) => offset < to && offset + match.length > from)) return match;
    // Never redact our own output. A placeholder is ordinary text to a pattern
    // that reads a delimited field: `urlcreds` sees the password slot of
    // `postgres://user:[REDACTED:urlcreds:76880d60]@host/db` and happily
    // redacts it again under a *different* hash, because the hash is taken of
    // whatever was there. That breaks the promise the whole scheme rests on,
    // one secret and one placeholder, and with it replay matching, which
    // fingerprints requests through this same function. Guarding here rather
    // than in each pattern makes idempotence a property of the mechanism
    // instead of something every future rule has to remember.
    if (PLACEHOLDER_ANYWHERE.test(secret)) return match;
    // An allowed value is one the config says is not a secret, however much it
    // looks like one. Checked here rather than per rule, so one entry covers
    // every rule that would otherwise claim it.
    if (allow.has(secret)) return match;
    onHit?.(secret);
    if (wanted === 0) return placeholder(rule.id, secret);
    // Keep whatever the rule matched around its capture group (e.g. "Bearer ").
    const at = match.lastIndexOf(secret);
    return match.slice(0, at) + placeholder(rule.id, secret) + match.slice(at + secret.length);
  });
}

/** Replace every recognized secret in a raw string. */
export function redactString(s: string, cfg: CompiledRedactConfig = BUILTIN_REDACTION): string {
  let out = s;
  for (const rule of cfg.rules) out = applyRule(out, rule, cfg.allow);
  return out;
}

/** Redact CLI arguments recorded in the cassette header (tokens passed as flags). */
export function redactCommand(command: string[], cfg: CompiledRedactConfig = BUILTIN_REDACTION): string[] {
  return command.map((arg) => redactString(arg, cfg));
}

/** The key a value sits under, or null when that key is not sensitive. */
type SensitiveKey = string | null;

function sensitiveKeyOf(key: string, cfg: CompiledRedactConfig): SensitiveKey {
  if (SENSITIVE_KEY.test(key)) return key;
  if (keySegments(key).some((segment) => SEGMENTED_SENSITIVE_KEYS.has(segment))) return key;
  // A configured name matches the whole key or any one of its segments, so
  // `handle` covers `handle`, `session_handle` and `sessionHandle` without
  // reaching into `handler`.
  if (cfg.keys.size === 0) return null;
  if (cfg.keys.has(key.toLowerCase())) return key;
  return keySegments(key).some((segment) => cfg.keys.has(segment)) ? key : null;
}

/**
 * Define rather than assign: `out[key] = value` for the key `__proto__` invokes the
 * prototype setter instead of creating an own property, which would drop the
 * field from the cassette and move attacker-supplied data onto the result's
 * prototype.
 */
function define(out: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
}

function redactValue(value: unknown, sensitiveKey: SensitiveKey, cfg: CompiledRedactConfig): unknown {
  if (typeof value === "string") {
    if (sensitiveKey !== null && isKeyctxSecret(sensitiveKey, value, cfg)) {
      return placeholder(KEYCTX_RULE, value);
    }
    return redactString(value, cfg);
  }
  // A redacted number becomes a string, which changes the JSON type a strict
  // client sees on replay. That is the deliberate trade: a type mismatch fails
  // loudly and points at the placeholder in the error, whereas a numeric stand-in
  // would forge plausible data, defeat the `[REDACTED:...]` marker that makes
  // redaction idempotent and auditable, and leave the leak invisible.
  if (typeof value === "number") {
    if (sensitiveKey !== null && isKeyctxNumericSecret(value, cfg)) {
      return placeholder(KEYCTX_RULE, numericSecretText(value));
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, sensitiveKey, cfg));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      define(out, key, redactValue(v, sensitiveKeyOf(key, cfg), cfg));
    }
    return out;
  }
  return value;
}

/**
 * Deep-copy a JSON-RPC frame with every string value redacted. Pure: the input
 * is never mutated.
 */
export function redactFrame(frame: unknown, cfg: CompiledRedactConfig = BUILTIN_REDACTION): unknown {
  return redactValue(frame, null, cfg);
}

// ---------------------------------------------------------------------------
// Scanning (audit mode): reports what redaction *would* remove, without writing.
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
function scanString(s: string, cfg: CompiledRedactConfig): Array<{ rule: string; secret: string }> {
  const hits: Array<{ rule: string; secret: string }> = [];
  let current = s;
  for (const rule of cfg.rules) {
    current = applyRule(current, rule, cfg.allow, (secret) => hits.push({ rule: rule.id, secret }));
  }
  return hits;
}

function scanValue(
  value: unknown,
  path: string,
  sensitiveKey: SensitiveKey,
  out: SecretHit[],
  cfg: CompiledRedactConfig
): void {
  if (typeof value === "string") {
    if (sensitiveKey !== null && isKeyctxSecret(sensitiveKey, value, cfg)) {
      out.push({ rule: KEYCTX_RULE, path, excerpt: maskSecret(value, KEYCTX_RULE) });
      return;
    }
    for (const hit of scanString(value, cfg)) {
      out.push({ rule: hit.rule, path, excerpt: maskSecret(hit.secret, hit.rule) });
    }
    return;
  }
  if (typeof value === "number") {
    if (sensitiveKey !== null && isKeyctxNumericSecret(value, cfg)) {
      out.push({
        rule: KEYCTX_RULE,
        path,
        excerpt: maskSecret(numericSecretText(value), KEYCTX_RULE),
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanValue(v, `${path}[${i}]`, sensitiveKey, out, cfg));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      scanValue(v, path ? `${path}.${key}` : key, sensitiveKeyOf(key, cfg), out, cfg);
    }
  }
}

/** Report every secret a redaction pass would remove from this frame. */
export function scanFrame(frame: unknown, cfg: CompiledRedactConfig = BUILTIN_REDACTION): SecretHit[] {
  const out: SecretHit[] = [];
  scanValue(frame, "", null, out, cfg);
  return out;
}

// ---------------------------------------------------------------------------
// Raw lines: anything the recorder could not parse as a JSON-RPC frame.
// ---------------------------------------------------------------------------

/**
 * A raw line is not necessarily un-structured: `parseFrame` rejects JSON-RPC
 * batch arrays and any frame missing `"jsonrpc":"2.0"`, and those still carry
 * `params.arguments.password`. Scanning such a line as flat text would apply the
 * shape rules only, silently skipping `keyctx`, so a secret on disk under a header
 * that claims redaction was applied.
 *
 * So: parse it, walk it for key-context secrets, and replace just those
 * substrings in the original text. Everything around them keeps its exact bytes,
 * which is what makes a raw entry a faithful transcript. A line that is not JSON
 * at all gets the shape rules and nothing more, because object walking has nothing to
 * walk, and no key context exists to recover.
 *
 * A *numeric* secret is the one case that surgery cannot do safely. Its digits
 * are unquoted in the text, the placeholder is a string, and the same digits can
 * legitimately appear inside a neighbouring string or a longer number, so a
 * literal substring swap can just as easily produce invalid JSON as a redacted
 * line. Those lines are re-serialized from the parsed tree instead: exact bytes
 * are the weaker promise, and it is the one worth losing.
 */
function processRawLine(line: string, cfg: CompiledRedactConfig, onHit?: (hit: SecretHit) => void): string {
  const keyctx = collectKeyctxSecrets(line, cfg);
  let text = line;

  const numeric = keyctx.filter((hit) => hit.numeric);
  if (numeric.length > 0) {
    for (const { path, secret } of numeric) {
      onHit?.({ rule: KEYCTX_RULE, path, excerpt: maskSecret(secret, KEYCTX_RULE) });
    }
    // Only the numbers are replaced here, so every string secret is still
    // present verbatim for the byte-preserving pass below to find.
    text = JSON.stringify(redactNumericKeyctx(JSON.parse(line), null, cfg));
  }

  for (const { path, secret, numeric: isNumber } of keyctx) {
    if (isNumber) continue;
    onHit?.({ rule: KEYCTX_RULE, path, excerpt: maskSecret(secret, KEYCTX_RULE) });
    text = replaceLiteral(text, secret, placeholder(KEYCTX_RULE, secret));
  }

  let out = text;
  for (const rule of cfg.rules) {
    out = applyRule(out, rule, cfg.allow, (secret) =>
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

/** A key-context secret found in a raw line. `secret` is always its text form. */
interface RawKeyctxHit {
  path: string;
  secret: string;
  /** Written unquoted in the line, so it cannot be swapped out in place. */
  numeric: boolean;
}

/** Key-context secrets inside a line that happens to hold JSON. */
function collectKeyctxSecrets(line: string, cfg: CompiledRedactConfig): RawKeyctxHit[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return []; // not JSON: no keys, no key context
  }
  const found: RawKeyctxHit[] = [];
  const walk = (value: unknown, path: string, sensitiveKey: SensitiveKey): void => {
    if (typeof value === "string") {
      if (sensitiveKey !== null && isKeyctxSecret(sensitiveKey, value, cfg)) {
        found.push({ path, secret: value, numeric: false });
      }
      return;
    }
    if (typeof value === "number") {
      if (sensitiveKey !== null && isKeyctxNumericSecret(value, cfg)) {
        found.push({ path, secret: numericSecretText(value), numeric: true });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`, sensitiveKey));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        walk(v, path ? `${path}.${key}` : key, sensitiveKeyOf(key, cfg));
      }
    }
  };
  walk(parsed, "", null);
  return found;
}

/**
 * Replace key-context *numbers* and nothing else. Strings are left exactly as
 * parsed so the byte-preserving pass in `processRawLine` can still find them.
 */
function redactNumericKeyctx(value: unknown, sensitiveKey: SensitiveKey, cfg: CompiledRedactConfig): unknown {
  if (typeof value === "number") {
    return sensitiveKey !== null && isKeyctxNumericSecret(value, cfg)
      ? placeholder(KEYCTX_RULE, numericSecretText(value))
      : value;
  }
  if (Array.isArray(value)) return value.map((v) => redactNumericKeyctx(v, sensitiveKey, cfg));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      define(out, key, redactNumericKeyctx(v, sensitiveKeyOf(key, cfg), cfg));
    }
    return out;
  }
  return value;
}

/** Redact a captured line that is not a JSON-RPC frame. */
export function redactRawLine(line: string, cfg: CompiledRedactConfig = BUILTIN_REDACTION): string {
  return processRawLine(line, cfg);
}

/** Report every secret a redaction pass would remove from a raw line. */
export function scanRawLine(line: string, cfg: CompiledRedactConfig = BUILTIN_REDACTION): SecretHit[] {
  const hits: SecretHit[] = [];
  processRawLine(line, cfg, (hit) => hits.push(hit));
  return hits;
}

// ---------------------------------------------------------------------------
// Cassette-level operations
// ---------------------------------------------------------------------------

/** Redact a whole cassette. Pure: returns a new cassette, input untouched. */
export function redactCassette(cassette: Cassette, cfg: CompiledRedactConfig = BUILTIN_REDACTION): Cassette {
  // A second pass under other rules would rewrite the file and then stamp it
  // with whichever config this call happened to carry, including none. The
  // frames would correspond to no single config, the hash would say otherwise,
  // and replay, which trusts the hash, would accept the result and miss every
  // custom-redacted request. Refusing is the only honest answer: a cassette
  // that already names its rules can only be re-redacted under those rules.
  const recorded = cassette.header.redaction?.configHash;
  if (recorded !== undefined && recorded !== cfg.hash) {
    throw new Error(
      cfg.hash === undefined
        ? "mcp-cassette: this cassette was redacted under a --redact-config and none was given; " +
          "pass the same file the recording used, or re-record without one"
        : "mcp-cassette: this cassette was redacted under a different --redact-config than the one given; " +
          "pass the file the recording used"
    );
  }
  const command = cassette.header.command ? redactCommand(cassette.header.command, cfg) : undefined;
  return {
    header: {
      ...cassette.header,
      ...(command ? { command } : {}),
      ...(cassette.header.url ? { url: redactString(cassette.header.url, cfg) } : {}),
      // The hash travels with the file, because replay has to be able to tell
      // that it was handed the rules this cassette was written under.
      redaction: { applied: true, ...(cfg.hash ? { configHash: cfg.hash } : {}) },
    },
    entries: cassette.entries.map((entry) => {
      if (entry.type === "frame") return { ...entry, frame: redactFrame(entry.frame, cfg) as JsonRpcFrame };
      if (entry.type === "chunks") {
        return {
          ...entry,
          chunks: entry.chunks.map((chunk) => ({ ...chunk, frame: redactFrame(chunk.frame, cfg) as JsonRpcFrame })),
        };
      }
      return { ...entry, data: redactRawLine(entry.data, cfg) };
    }),
  };
}

/** Report every secret still present in a cassette (audit mode for CI). */
export function scanCassette(cassette: Cassette, cfg: CompiledRedactConfig = BUILTIN_REDACTION): CassetteSecretHit[] {
  const hits: CassetteSecretHit[] = [];

  (cassette.header.command ?? []).forEach((arg, i) => {
    for (const hit of scanString(arg, cfg)) {
      hits.push({
        rule: hit.rule,
        dir: "header",
        path: `command[${i}]`,
        excerpt: maskSecret(hit.secret, hit.rule),
      });
    }
  });
  for (const hit of scanString(cassette.header.url ?? "", cfg)) {
    hits.push({ rule: hit.rule, dir: "header", path: "url", excerpt: maskSecret(hit.secret, hit.rule) });
  }

  // A response carries no method of its own; report the one it answers.
  //
  // Keyed by direction as well as id, because the two directions number their
  // requests independently: a client `tools/call` with id 1 and a server-initiated
  // `sampling/createMessage` with id 1 are different requests that happen to
  // share a label. A single id→method map lets whichever came last claim both,
  // and the audit output then names the wrong method for a leaked secret.
  const methodByRequest = new Map<string, string>();
  for (const entry of cassette.entries) {
    if (entry.type !== "frame") continue;
    const { id, method } = entry.frame as { id?: unknown; method?: string };
    if (method !== undefined && id !== undefined) {
      methodByRequest.set(`${entry.dir}:${String(id)}`, method);
    }
  }

  for (const entry of cassette.entries) {
    if (entry.type === "frame") {
      const { id, method: own } = entry.frame as { id?: unknown; method?: string };
      // A response travels back the way its request came, so look it up in the
      // opposite direction: an s2c response answers a c2s request, and a c2s
      // response answers a server-initiated s2c one.
      const method =
        own ??
        (id !== undefined
          ? methodByRequest.get(`${entry.dir === "c2s" ? "s2c" : "c2s"}:${String(id)}`)
          : undefined);
      for (const hit of scanFrame(entry.frame, cfg)) {
        hits.push({ ...hit, dir: entry.dir, ...(method ? { method } : {}) });
      }
    } else if (entry.type === "chunks") {
      for (const chunk of entry.chunks) {
        for (const hit of scanFrame(chunk.frame, cfg)) hits.push({ ...hit, dir: entry.dir });
      }
    } else {
      for (const hit of scanRawLine(entry.data, cfg)) hits.push({ ...hit, dir: entry.dir });
    }
  }

  return hits;
}
