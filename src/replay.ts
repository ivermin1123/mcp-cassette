/**
 * `mcp-cassette replay <cassette> [--on-miss error|warn|passthrough [-- <server command...>]]`
 *
 * Serves a recorded cassette as a stdio MCP server: incoming requests are
 * matched against recorded (request → response) pairs and answered with the
 * recorded response: deterministic, offline, no real server involved.
 *
 * Matching strategy (v1):
 *   - `initialize` and other parameterless lifecycle calls match by method.
 *   - `tools/call` matches by tool name + stable-stringified arguments.
 *   - everything else matches by method + stable-stringified params
 *     (volatile `_meta` is ignored).
 *   - fingerprint miss falls back to the next unconsumed response for the
 *     same method (recorded order), so re-ordered test runs still work.
 *
 * If the cassette was recorded with redaction on, incoming requests are redacted
 * before fingerprinting: a client sending a live token produces the same
 * deterministic placeholder that was recorded, so the match still lands.
 *
 * On a true miss (no fingerprint, no same-method fallback), the behavior is
 * the `--on-miss` mode's call:
 *   - error (default): JSON-RPC error to the client, session exits 1.
 *   - warn:            same JSON-RPC error, but the session still exits 0.
 *   - passthrough:     forward the request to a real server and append the new
 *                      interaction to the cassette tagged `origin:"live"`.
 * Every miss comes with near-miss diagnostics: the closest recorded
 * fingerprint and exactly which component diverged.
 */

import fs from "node:fs";
import {
  isNotification,
  isRequest,
  isResponse,
  JsonRpcFrame,
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
  LineBuffer,
  parseFrame,
  serializeFrame,
  stableStringify,
} from "./jsonrpc.js";
import { Cassette, ChunksEntry, Direction, FrameEntry, readCassette } from "./cassette.js";
import { diffValues, formatValue, type DiffEntry } from "./diff.js";
import { MiniClient } from "./client.js";
import { redactFrame } from "./redact.js";

const METHOD_ONLY = new Set(["initialize", "ping", "tools/list", "resources/list", "prompts/list", "resources/templates/list"]);

// Fingerprint components are joined with NUL: it can never appear in a method
// name or in JSON text, so no crafted tool name or argument can collide.
const SEP = "\u0000";

export function fingerprint(req: { method: string; params?: unknown }): string {
  if (METHOD_ONLY.has(req.method)) return req.method;
  const params = req.params as Record<string, unknown> | undefined;
  if (req.method === "tools/call" && params && typeof params === "object") {
    return `tools/call${SEP}${String(params.name)}${SEP}${stableStringify(params.arguments ?? {})}`;
  }
  const cleaned = { ...(params ?? {}) } as Record<string, unknown>;
  delete cleaned._meta;
  delete cleaned.cursor; // pagination cursors are server-generated and volatile
  return `${req.method}${SEP}${stableStringify(cleaned)}`;
}

export interface ReplayIndex {
  byFingerprint: Map<string, JsonRpcResponse[]>;
  byMethod: Map<string, JsonRpcResponse[]>;
  /** Every answered c2s request as recorded: the corpus near-miss diagnostics search. */
  recordedRequests: JsonRpcRequest[];
  /** How many responses each fingerprint had before any were consumed. */
  recordedCountByFingerprint: Map<string, number>;
  skippedServerFrames: number;
  /** Recorded fingerprints are redacted, so incoming requests must be too. */
  redactRequests: boolean;
}

export function buildReplayIndex(cassette: Cassette): ReplayIndex {
  const responsesById = new Map<string, JsonRpcResponse>();
  let skippedServerFrames = 0;

  for (const entry of cassette.entries) {
    if (entry.type !== "frame") continue;
    const frame = entry.frame;
    if (entry.dir === "s2c") {
      if (isResponse(frame)) responsesById.set(String(frame.id), frame);
      else skippedServerFrames++; // server-initiated requests/notifications: v1 skips
    }
  }

  const byFingerprint = new Map<string, JsonRpcResponse[]>();
  const byMethod = new Map<string, JsonRpcResponse[]>();
  const recordedRequests: JsonRpcRequest[] = [];

  for (const entry of cassette.entries) {
    if (entry.type !== "frame" || entry.dir !== "c2s") continue;
    const frame = entry.frame;
    if (!isRequest(frame)) continue;
    const response = responsesById.get(String(frame.id));
    if (!response) continue;
    recordedRequests.push(frame);
    const fp = fingerprint(frame);
    if (!byFingerprint.has(fp)) byFingerprint.set(fp, []);
    byFingerprint.get(fp)!.push(response);
    if (!byMethod.has(frame.method)) byMethod.set(frame.method, []);
    byMethod.get(frame.method)!.push(response);
  }

  const recordedCountByFingerprint = new Map<string, number>();
  for (const [fp, pool] of byFingerprint) recordedCountByFingerprint.set(fp, pool.length);

  return {
    byFingerprint,
    byMethod,
    recordedRequests,
    recordedCountByFingerprint,
    skippedServerFrames,
    redactRequests: cassette.header.redaction?.applied === true,
  };
}

export function matchResponse(index: ReplayIndex, req: JsonRpcRequest): JsonRpcResponse | null {
  const fp = fingerprint(index.redactRequests ? (redactFrame(req) as JsonRpcRequest) : req);
  const exact = index.byFingerprint.get(fp);
  if (exact && exact.length > 0) {
    const res = exact.shift()!;
    consumeFromMethodPool(index, req.method, res);
    return res;
  }
  const fallback = index.byMethod.get(req.method);
  if (fallback && fallback.length > 0) {
    const res = fallback.shift()!;
    consumeFromFingerprintPools(index, res);
    return res;
  }
  return null;
}

function consumeFromMethodPool(index: ReplayIndex, method: string, res: JsonRpcResponse): void {
  const pool = index.byMethod.get(method);
  if (!pool) return;
  const i = pool.indexOf(res);
  if (i !== -1) pool.splice(i, 1);
}

function consumeFromFingerprintPools(index: ReplayIndex, res: JsonRpcResponse): void {
  for (const pool of index.byFingerprint.values()) {
    const i = pool.indexOf(res);
    if (i !== -1) {
      pool.splice(i, 1);
      return;
    }
  }
}

/**
 * Why a request found no recorded answer, as data rather than as a sentence.
 *
 * A miss is the one thing a caller most often needs to *act* on, and the
 * difference between "you never recorded this tool" and "you recorded it but
 * the arguments drifted at /city" is the difference between two different
 * fixes. Collapsing that into prose forces every consumer to parse English
 * back into a decision, so the shape stays structured and the sentence becomes
 * a rendering of it (`formatMiss`) rather than the other way round.
 *
 * `exhausted` and `stream-exhausted` are the two "recorded, but already spent"
 * cases; the rest say nothing matched. Only `arguments-differ` and
 * `params-differ` mean a recording came close, which is why they alone carry
 * the diverging paths.
 */
export type MissReason =
  /** The cassette has no request/response pairs at all. */
  | { kind: "empty-cassette" }
  /** This fingerprint was recorded, but every recorded response is spent. */
  | { kind: "exhausted"; fingerprint: string; recordedCount: number }
  /** As above, for an answer that was recorded as a stream (HTTP only). */
  | { kind: "stream-exhausted"; fingerprint: string; recordedCount: number }
  | { kind: "unknown-method"; method: string; recordedMethods: string[] }
  | { kind: "unknown-tool"; tool: string; recordedTools: string[] }
  /** A `tools/call` for a recorded tool, diverging at these paths. */
  | { kind: "arguments-differ"; changes: DiffEntry[] }
  /** A recorded method, diverging at these paths. */
  | { kind: "params-differ"; changes: DiffEntry[] };

/** A miss as it happened: what was asked, and why nothing answered it. */
export interface MissEvent {
  method: string;
  request: JsonRpcRequest;
  reason: MissReason;
}

/**
 * Explain a miss in terms of the closest recording: which fingerprint came
 * nearest, and exactly which component diverged (method? tool name? which
 * arguments path?). This is what turns "no recorded response" into a fix.
 */
export function diagnoseMissReason(index: ReplayIndex, req: JsonRpcRequest): MissReason {
  const effective = index.redactRequests ? (redactFrame(req) as JsonRpcRequest) : req;
  const fp = fingerprint(effective);

  const recordedCount = index.recordedCountByFingerprint.get(fp);
  if (recordedCount !== undefined) return { kind: "exhausted", fingerprint: fp, recordedCount };
  if (index.recordedRequests.length === 0) return { kind: "empty-cassette" };

  const sameMethod = index.recordedRequests.filter((r) => r.method === effective.method);
  if (sameMethod.length === 0) {
    const recordedMethods = [...new Set(index.recordedRequests.map((r) => r.method))].sort();
    return { kind: "unknown-method", method: effective.method, recordedMethods };
  }

  if (effective.method === "tools/call") {
    const wanted = String((effective.params as Record<string, unknown> | undefined)?.name);
    const byName = sameMethod.filter(
      (r) => String((r.params as Record<string, unknown> | undefined)?.name) === wanted
    );
    if (byName.length === 0) {
      const recordedTools = [...new Set(sameMethod.map((r) => String((r.params as Record<string, unknown> | undefined)?.name)))].sort();
      return { kind: "unknown-tool", tool: wanted, recordedTools };
    }
    return {
      kind: "arguments-differ",
      changes: nearestChanges(
        byName.map((r) => (r.params as Record<string, unknown>).arguments ?? {}),
        (effective.params as Record<string, unknown>).arguments ?? {}
      ),
    };
  }

  return {
    kind: "params-differ",
    changes: nearestChanges(sameMethod.map((r) => r.params ?? {}), effective.params ?? {}),
  };
}

/** The one place a `MissReason` becomes the sentence humans read. */
export function formatMiss(reason: MissReason): string {
  switch (reason.kind) {
    case "empty-cassette":
      return "the cassette contains no request/response pairs at all";
    case "exhausted":
      return (
        `this exact fingerprint was recorded ${reason.recordedCount} time(s), but every recorded response ` +
        `was already consumed earlier in this session; the client is calling it more often than the recording did`
      );
    case "stream-exhausted":
      return (
        `this request's answer was recorded as a stream ${reason.recordedCount} time(s), but every one ` +
        `was already replayed earlier in this session`
      );
    case "unknown-method":
      return `no recorded request has method "${reason.method}". Recorded methods: ${reason.recordedMethods.join(", ")}`;
    case "unknown-tool":
      return `no recorded tools/call for tool "${reason.tool}". Recorded tools: ${reason.recordedTools.join(", ")}`;
    case "arguments-differ":
      return describeChanges(reason.changes, "arguments");
    case "params-differ":
      return describeChanges(reason.changes, "params");
  }
}

/** The prose form of the two near-miss reasons. */
function describeChanges(changes: DiffEntry[], what: string): string {
  if (changes.length === 0) return `${what} could not be compared to any recording`;
  const shown = changes
    .slice(0, 3)
    .map((c) => `${c.path || "/"} (recorded ${formatValue(c.recorded)}, got ${formatValue(c.live)})`)
    .join("; ");
  const more = changes.length > 3 ? ` and ${changes.length - 3} more path(s)` : "";
  return `method and tool match a recording, but ${what} differ at: ${shown}${more}`;
}

/** Pick the candidate with the fewest differing paths. Empty means nothing to compare against. */
function nearestChanges(candidates: unknown[], incoming: unknown): DiffEntry[] {
  let best: DiffEntry[] | null = null;
  for (const candidate of candidates) {
    const changes = diffValues(candidate, incoming);
    if (!best || changes.length < best.length) best = changes;
  }
  return best ?? [];
}

/** The sentence form, kept for every caller that just wants to print it. */
export function diagnoseMiss(index: ReplayIndex, req: JsonRpcRequest): string {
  return formatMiss(diagnoseMissReason(index, req));
}

/** The one miss answer, shared by both front-ends: a diagnosis a human can act on. */
export function missError(frame: JsonRpcRequest, diagnosis: string): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: frame.id,
    error: {
      code: -32601,
      message:
        `mcp-cassette replay: no recorded response for "${frame.method}" (fingerprint miss). ` +
        `Nearest recording: ${diagnosis}. Re-record the cassette or adjust the interaction.`,
    },
  };
}

type Resolution =
  | { kind: "silent" } // notifications and stray responses: nothing to send
  | { kind: "answer"; out: JsonRpcResponse } // recorded match or synthesized ping
  | { kind: "miss"; request: JsonRpcRequest };

/** The one matching path both handleFrame and the live session go through. */
function resolveFrame(index: ReplayIndex, frame: JsonRpcFrame): Resolution {
  if (isNotification(frame) || !isRequest(frame)) return { kind: "silent" };
  const recorded = matchResponse(index, frame);
  if (recorded) {
    // Re-key the recorded response to the incoming request id.
    return { kind: "answer", out: { ...recorded, id: frame.id } };
  }
  if (frame.method === "ping") {
    return { kind: "answer", out: { jsonrpc: "2.0", id: frame.id, result: {} } };
  }
  return { kind: "miss", request: frame };
}

/** Handle a single incoming frame; returns the frame to send back, if any. */
export function handleFrame(index: ReplayIndex, frame: JsonRpcFrame): JsonRpcFrame | null {
  const resolved = resolveFrame(index, frame);
  if (resolved.kind === "silent") return null;
  if (resolved.kind === "answer") return resolved.out;
  return missError(resolved.request, diagnoseMiss(index, resolved.request));
}

export type OnMissMode = "error" | "warn" | "passthrough";

/**
 * The spy-append machinery, shared by both front-ends: v1 invented it for stdio
 * and HTTP passthrough needs exactly the same thing, so it is lifted out rather
 * than reimplemented.
 *
 * Two disciplines travel with it. Appends go out synchronously, one line at a
 * time, to an already-written file, never through a writer that would truncate
 * it. And a live pair is re-keyed to a fresh `live-N` id, which keeps request
 * and response paired on re-read and cannot collide with an id the original
 * recording, an earlier passthrough session, or a future client used.
 */
export class LiveAppender {
  private seq = 0;
  private started = Date.now();

  constructor(
    private path: string,
    cassette: Cassette,
    /** A redacted cassette never gains raw secrets through the passthrough door. */
    private redact: boolean
  ) {
    // Seed past any ids an earlier passthrough session left behind.
    for (const entry of cassette.entries) {
      const ids = entry.type === "chunks" ? [entry.id] : entry.type === "frame" ? [(entry.frame as { id?: unknown }).id] : [];
      for (const id of ids) {
        const found = typeof id === "string" ? /^live-(\d+)$/.exec(id) : null;
        if (found) this.seq = Math.max(this.seq, Number(found[1]));
      }
    }
  }

  /** The id the next appended pair will carry. */
  nextId(): string {
    return `live-${++this.seq}`;
  }

  private write(entry: FrameEntry | ChunksEntry): void {
    fs.appendFileSync(this.path, JSON.stringify(entry) + "\n");
  }

  private clean(frame: JsonRpcFrame): JsonRpcFrame {
    return this.redact ? (redactFrame(frame) as JsonRpcFrame) : frame;
  }

  frame(dir: Direction, frame: JsonRpcFrame): void {
    this.write({ type: "frame", t: Date.now() - this.started, dir, frame: this.clean(frame), origin: "live" });
  }

  /** A live answer that streamed is a `chunks` entry, frames and all (§1.3). */
  chunks(id: JsonRpcId, frames: JsonRpcFrame[]): void {
    const t = Date.now() - this.started;
    this.write({
      type: "chunks",
      t,
      dir: "s2c",
      id,
      chunks: frames.map((frame) => ({ t, frame: this.clean(frame) })),
      origin: "live",
    });
  }
}

export interface ReplayOptions {
  onMiss?: OnMissMode;
  /** Real server command, required for passthrough. */
  serverCommand?: string[];
}

export async function runReplay(cassettePath: string, opts: ReplayOptions = {}): Promise<void> {
  const onMiss = opts.onMiss ?? "error";
  if (onMiss === "passthrough" && (!opts.serverCommand || opts.serverCommand.length === 0)) {
    throw new Error(
      "replay --on-miss passthrough needs the real server command: mcp-cassette replay <cassette> --on-miss passthrough -- <server command...>"
    );
  }

  const cassette = readCassette(cassettePath);
  const index = buildReplayIndex(cassette);
  let misses = 0;
  let appended = 0;
  let forwardFailures = 0;
  // Connecting is memoized including failure: a broken server command fails
  // every subsequent miss fast instead of spawning one orphan per miss.
  let livePromise: Promise<MiniClient> | null = null;
  const connectLive = (): Promise<MiniClient> =>
    (livePromise ??= MiniClient.connect({ kind: "stdio", command: opts.serverCommand! }).then((r) => r.client));

  const live = new LiveAppender(cassettePath, cassette, index.redactRequests);

  if (index.skippedServerFrames > 0) {
    process.stderr.write(
      `mcp-cassette replay: ${index.skippedServerFrames} server-initiated frame(s) in the cassette are not replayed in v1\n`
    );
  }

  const forwardMiss = async (frame: JsonRpcRequest): Promise<JsonRpcResponse> => {
    const client = await connectLive();
    const res = await client.request(frame.method, frame.params);
    const liveId = live.nextId();
    live.frame("c2s", { ...frame, id: liveId });
    live.frame("s2c", { ...res, id: liveId });
    appended++;
    return { ...res, id: frame.id };
  };

  const handleLine = async (line: string): Promise<void> => {
    const frame = parseFrame(line);
    if (!frame) return;
    const resolved = resolveFrame(index, frame);
    if (resolved.kind === "silent") return;
    if (resolved.kind === "answer") {
      process.stdout.write(serializeFrame(resolved.out));
      return;
    }

    const request = resolved.request;
    misses++;
    const diagnosis = diagnoseMiss(index, request);
    process.stderr.write(`mcp-cassette replay: fingerprint miss for "${request.method}": ${diagnosis}\n`);
    if (onMiss === "passthrough") {
      const out = await forwardMiss(request).catch((err: Error): JsonRpcResponse => {
        forwardFailures++;
        return {
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32603, message: `mcp-cassette replay: passthrough to live server failed: ${err.message}` },
        };
      });
      process.stdout.write(serializeFrame(out));
      return;
    }
    process.stdout.write(serializeFrame(missError(request, diagnosis)));
  };

  const buf = new LineBuffer();
  // Frames are handled strictly in arrival order even when passthrough awaits
  // the live server: a later match must not overtake an in-flight forward.
  // Each line carries its own error boundary: one bad frame must not poison
  // the chain and silently drop everything after it.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (line: string) => {
    queue = queue.then(() =>
      handleLine(line).catch((err: Error) => {
        process.stderr.write(`mcp-cassette replay: failed to handle a frame: ${err.message}\n`);
      })
    );
  };

  await new Promise<void>((resolve) => {
    process.stdin.on("data", (chunk: Buffer) => {
      for (const line of buf.feed(chunk.toString("utf8"))) enqueue(line);
    });
    process.stdin.on("end", () => {
      enqueue(buf.flush());
      void queue.then(resolve);
    });
  });

  // (cast: livePromise is only assigned inside connectLive, which TS's
  // control-flow narrowing can't see from here)
  const liveToClose = livePromise as Promise<MiniClient> | null;
  if (liveToClose) await liveToClose.then((c) => c.close()).catch(() => undefined);
  if (misses > 0) {
    const summary =
      onMiss === "passthrough"
        ? `${misses} miss(es), ${appended} interaction(s) appended to ${cassettePath} (origin:"live")` +
          (forwardFailures > 0 ? `, ${forwardFailures} forward(s) FAILED` : "")
        : `${misses} fingerprint miss(es) this session`;
    process.stderr.write(`mcp-cassette replay: ${summary}\n`);
  }
  // error mode is the strict one: a session that missed is a failed session.
  // warn answers the same way frame-by-frame but exits clean. passthrough is
  // clean only when every forward actually reached the live server.
  const failed = (onMiss === "error" && misses > 0) || (onMiss === "passthrough" && forwardFailures > 0);
  process.exitCode = failed ? 1 : 0;
}
