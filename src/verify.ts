/**
 * `mcp-cassette verify <cassette> -- <server command...>`
 *
 * Re-fires the recorded client→server REQUESTS (in recorded order) at a real,
 * live server and diffs each live RESPONSE against the recorded one. This is
 * the "is my cassette still true?" check: replay answers from the past,
 * verify asks whether the past still matches the present.
 *
 * Lifecycle is not part of the diff: MiniClient performs the initialize
 * handshake itself (so legacy classic-lifecycle cassettes verify cleanly),
 * and recorded `initialize` requests / notifications are skipped.
 *
 * Volatile fields are ignored by default (see normalizeForDiff); project-
 * specific fields can be excluded with repeatable `--ignore <json-pointer>`
 * flags, and intentional drift can be waived with `--allow-changed-paths`.
 */

import { Cassette } from "./cassette.js";
import { DiffEntry, diffValues, formatValue, splitPointer } from "./diff.js";
import { MiniClient, Target } from "./client.js";
import { isRequest, isResponse, JsonRpcRequest, JsonRpcResponse } from "./jsonrpc.js";

export type VerifyStatus = "MATCH" | "CHANGED" | "ERROR-SHAPE-CHANGED" | "MISSING";

export interface VerifyPair {
  request: JsonRpcRequest;
  response: JsonRpcResponse;
}

export interface VerifyResult {
  /** Human label: the method, plus the tool name for tools/call. */
  label: string;
  status: VerifyStatus;
  changes: DiffEntry[];
  /** True when every changed path fell under --allow-changed-paths. */
  allowed: boolean;
  /** Extra context for MISSING / ERROR-SHAPE-CHANGED. */
  detail?: string;
}

export interface VerifyOptions {
  /** JSON Pointers (relative to each response payload) to drop before diffing. */
  ignore?: string[];
  /** Changed paths under these pointers do not fail the run. */
  allowChangedPaths?: string[];
  /** Explicit waive-everything switch: every CHANGED pair passes. */
  allowAllChanges?: boolean;
  timeoutMs?: number;
}

// Timestamp-like strings: full ISO-8601 dates ("2026-08-15", optionally with a
// time part). Anchored so ordinary prose containing a date does not match.
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:?\d{2})?)?$/;

// UUID (any version), the other id shape servers mint per call.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Epoch-like numbers. Two windows, both spanning ~2001→2065:
 *   seconds:      1e9  .. 3e9   (2001-09 .. 2065-01)
 *   milliseconds: 1e12 .. 3e12  (2001-09 .. 2065-01)
 * Integers only — 1234.5 is data, not a clock. The windows are a heuristic:
 * a server returning a plain big count in this range gets masked too, which
 * trades a rare false "match" for never flagging every run over a timestamp.
 */
function isEpochLikeNumber(n: number): boolean {
  if (!Number.isInteger(n)) return false;
  return (n >= 1e9 && n <= 3e9) || (n >= 1e12 && n <= 3e12);
}

function isVolatileString(s: string): boolean {
  return ISO_TIMESTAMP_RE.test(s) || UUID_RE.test(s);
}

/** Keys whose values are volatile by contract, at any depth. */
const VOLATILE_KEYS = new Set(["_meta", "ttlMs"]);

const VOLATILE_SENTINEL = "[volatile]";

/**
 * Rewrite a payload so that volatile parts compare equal:
 * `_meta` / `ttlMs` are dropped wherever they appear, and values that look
 * like timestamps or UUIDs are replaced with one sentinel on both sides.
 */
export function normalizeForDiff(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForDiff);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE_KEYS.has(key)) continue;
      out[key] = normalizeForDiff(v);
    }
    return out;
  }
  if (typeof value === "string" && isVolatileString(value)) return VOLATILE_SENTINEL;
  if (typeof value === "number" && isEpochLikeNumber(value)) return VOLATILE_SENTINEL;
  return value;
}

const IGNORED_SENTINEL = "[ignored]";

/** Blank out the value at a JSON Pointer, if present. Missing paths are a no-op. */
export function removePointer(value: unknown, pointer: string): void {
  const segments = splitPointer(pointer);
  if (segments.length === 0) return; // "" points at the root; nothing to remove it from
  let parent: unknown = value;
  for (const seg of segments.slice(0, -1)) {
    if (Array.isArray(parent)) parent = /^\d+$/.test(seg) ? parent[Number(seg)] : undefined;
    else if (parent && typeof parent === "object") parent = (parent as Record<string, unknown>)[seg];
    else return;
  }
  const last = segments[segments.length - 1]!;
  if (Array.isArray(parent)) {
    // Replace, never splice: removal would re-index the tail and misalign the
    // two payloads when their lengths differ. A non-numeric segment under an
    // array is a typo'd pointer, not index 0 — leave the payload untouched.
    if (!/^\d+$/.test(last) || Number(last) >= parent.length) return;
    parent[Number(last)] = IGNORED_SENTINEL;
  } else if (parent && typeof parent === "object") {
    delete (parent as Record<string, unknown>)[last];
  }
}

function prepare(payload: unknown, ignore: string[]): unknown {
  const normalized = normalizeForDiff(payload);
  for (const pointer of ignore) removePointer(normalized, pointer);
  return normalized;
}

/** A changed path passes when it equals an allowed pointer or nests under one. */
export function isAllowedChange(path: string, allowed: string[]): boolean {
  // "" never matches: waiving everything is --allow-all-changes, on purpose.
  return allowed.some((a) => a !== "" && (path === a || path.startsWith(`${a}/`)));
}

export function classifyPair(
  recorded: JsonRpcResponse,
  live: JsonRpcResponse,
  opts: VerifyOptions = {}
): { status: Exclude<VerifyStatus, "MISSING">; changes: DiffEntry[]; detail?: string } {
  const recordedIsError = recorded.error !== undefined;
  const liveIsError = live.error !== undefined;
  if (recordedIsError !== liveIsError) {
    const detail = recordedIsError
      ? `recorded error ${recorded.error!.code}, live returned a result`
      : `recorded a result, live returned error ${live.error!.code}: ${live.error!.message}`;
    return { status: "ERROR-SHAPE-CHANGED", changes: [], detail };
  }
  const ignore = opts.ignore ?? [];
  const changes = recordedIsError
    ? diffValues(prepare(recorded.error, ignore), prepare(live.error, ignore))
    : diffValues(prepare(recorded.result, ignore), prepare(live.result, ignore));
  return changes.length === 0 ? { status: "MATCH", changes } : { status: "CHANGED", changes };
}

/** Lifecycle requests are the handshake's job, not the diff's. */
const LIFECYCLE_METHODS = new Set(["initialize"]);

/**
 * Ordered c2s requests that both have a recorded response and are worth
 * re-firing: notifications have no response by definition, lifecycle requests
 * are excluded, and unanswered requests can't be diffed against anything.
 */
export function collectVerifyPairs(cassette: Cassette): VerifyPair[] {
  const responsesById = new Map<string, JsonRpcResponse>();
  for (const entry of cassette.entries) {
    if (entry.type === "frame" && entry.dir === "s2c" && isResponse(entry.frame)) {
      responsesById.set(String(entry.frame.id), entry.frame);
    }
  }
  const pairs: VerifyPair[] = [];
  for (const entry of cassette.entries) {
    if (entry.type !== "frame" || entry.dir !== "c2s" || !isRequest(entry.frame)) continue;
    if (LIFECYCLE_METHODS.has(entry.frame.method)) continue;
    const response = responsesById.get(String(entry.frame.id));
    if (response) pairs.push({ request: entry.frame, response });
  }
  return pairs;
}

export function pairLabel(request: JsonRpcRequest): string {
  const params = request.params as Record<string, unknown> | undefined;
  if (request.method === "tools/call" && params && typeof params.name === "string") {
    return `tools/call ${params.name}`;
  }
  return request.method;
}

export async function verifyAgainstServer(
  cassette: Cassette,
  /** A stdio server command, or any target MiniClient can dial (an HTTP URL included). */
  server: string[] | Target,
  opts: VerifyOptions = {}
): Promise<VerifyResult[]> {
  // "" would waive every change — an unset shell variable must not silently
  // open that valve. The explicit switch for it is --allow-all-changes.
  if ((opts.allowChangedPaths ?? []).includes("")) {
    throw new Error(
      "empty --allow-changed-paths would waive every change — pass --allow-all-changes if that is what you mean"
    );
  }
  // A malformed pointer must fail here, before any recorded request is
  // re-executed against the live server (they can have real side effects).
  for (const pointer of [...(opts.ignore ?? []), ...(opts.allowChangedPaths ?? [])]) {
    splitPointer(pointer);
  }
  const pairs = collectVerifyPairs(cassette);
  const results: VerifyResult[] = [];
  const target: Target = Array.isArray(server) ? { kind: "stdio", command: server } : server;
  const { client } = await MiniClient.connect(target, opts.timeoutMs);
  try {
    for (const pair of pairs) {
      const label = pairLabel(pair.request);
      let live: JsonRpcResponse;
      try {
        live = await client.request(pair.request.method, pair.request.params);
      } catch (err) {
        results.push({
          label,
          status: "MISSING",
          changes: [],
          allowed: false,
          detail: (err as Error).message,
        });
        continue;
      }
      const { status, changes, detail } = classifyPair(pair.response, live, opts);
      const allowed =
        status === "CHANGED" &&
        (opts.allowAllChanges === true ||
          changes.every((c) => isAllowedChange(c.path, opts.allowChangedPaths ?? [])));
      results.push({ label, status, changes, allowed, detail });
    }
  } finally {
    await client.close();
  }
  return results;
}

export function verifyFailed(results: VerifyResult[]): boolean {
  return results.some((r) => r.status !== "MATCH" && !(r.status === "CHANGED" && r.allowed));
}

export function printVerifyReport(results: VerifyResult[], write = (s: string) => process.stdout.write(s)): void {
  // One write for the whole report: like `redact --scan`, an unbounded report
  // followed by process.exit() can be truncated on a piped stdout.
  const lines: string[] = [];
  for (const r of results) {
    if (r.status === "MATCH") {
      lines.push(`✓ MATCH    ${r.label}\n`);
    } else if (r.status === "CHANGED") {
      lines.push(`${r.allowed ? "○ CHANGED (allowed)" : "✗ CHANGED "} ${r.label}\n`);
      for (const c of r.changes.slice(0, 10)) {
        lines.push(`    ${c.path || "/"}: ${formatValue(c.recorded)} → ${formatValue(c.live)}\n`);
      }
      if (r.changes.length > 10) lines.push(`    … ${r.changes.length - 10} more path(s)\n`);
    } else {
      lines.push(`✗ ${r.status} ${r.label}${r.detail ? ` — ${r.detail}` : ""}\n`);
    }
  }
  const count = (s: VerifyStatus) => results.filter((r) => r.status === s).length;
  const waived = results.filter((r) => r.status === "CHANGED" && r.allowed).length;
  lines.push(
    `verify: ${count("MATCH")} match, ${count("CHANGED")} changed` +
      (waived > 0 ? ` (${waived} allowed)` : "") +
      `, ${count("ERROR-SHAPE-CHANGED")} error-shape-changed, ${count("MISSING")} missing\n`
  );
  write(lines.join(""));
}
