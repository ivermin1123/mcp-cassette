/**
 * `mcp-cassette replay <cassette> [--on-miss error|warn|passthrough [-- <server command...>]]`
 *
 * Serves a recorded cassette as a stdio MCP server: incoming requests are
 * matched against recorded (request → response) pairs and answered with the
 * recorded response: deterministic, offline, no real server involved.
 *
 * Matching strategy (v1):
 *   - `initialize` and other parameterless lifecycle calls match by method.
 *   - `tools/call` matches by tool name + stable-stringified arguments, plus
 *     the MRTR retry fields (`inputResponses`, `requestState`) when present.
 *   - everything else matches by method + stable-stringified params
 *     (volatile `_meta` is ignored).
 *   - matching is exact: repeated identical calls consume their recordings in
 *     order, and anything else is a miss.
 *   - fields declared volatile (`--volatile`, or the cassette header's own
 *     list) are dropped from the request's params on both sides first, so a
 *     request that differs only in a timestamp or a generated id still lands.
 *
 * If the cassette was recorded with redaction on, incoming requests are redacted
 * before fingerprinting: a client sending a live token produces the same
 * deterministic placeholder that was recorded, so the match still lands.
 *
 * On a miss, the behavior is the `--on-miss` mode's call:
 *   - error (default): JSON-RPC error to the client, session exits 1.
 *   - warn:            borrow the next unconsumed recording of the same method
 *                      when one is left, naming what diverged on stderr; the
 *                      JSON-RPC error otherwise. The session exits 0. This is
 *                      the tolerance for arguments that change every run.
 *   - passthrough:     forward the request to a real server and append the new
 *                      interaction to the cassette tagged `origin:"live"`.
 * MRTR retries never borrow, and a retry's recorded answer is never lent: a
 * retry is answered exactly or not at all.
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
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  LineBuffer,
  parseFrame,
  serializeFrame,
  stableStringify,
} from "./jsonrpc.js";
import { Cassette, ChunksEntry, Direction, FrameEntry, readCassette } from "./cassette.js";
// `removePointer` is the one pointer removal in the codebase, reused rather than
// written twice: the array rule it already settled is the rule a fingerprint needs.
import { diffValues, formatValue, removePointer, splitPointer, type DiffEntry } from "./diff.js";
import { MiniClient } from "./client.js";
import { readRedactConfig, redactFrame, BUILTIN_REDACTION, type CompiledRedactConfig } from "./redact.js";

const METHOD_ONLY = new Set(["initialize", "ping", "tools/list", "resources/list", "prompts/list", "resources/templates/list"]);

/**
 * The 2026-07-28 long-lived subscription, and the three names it travels under.
 *
 * `subscriptions/listen` replaced the HTTP GET endpoint and
 * `resources/subscribe`: one request, answered first by a
 * `notifications/subscriptions/acknowledged` notification and only much later
 * (if at all) by a JSON-RPC response, when the server ends the subscription
 * gracefully. Every frame on the subscription carries the id of the listen
 * request that opened it under `io.modelcontextprotocol/subscriptionId`, which
 * is what replay re-keys so the client sees its own id rather than the
 * recording's.
 */
export const LISTEN_METHOD = "subscriptions/listen";
export const ACKNOWLEDGED_METHOD = "notifications/subscriptions/acknowledged";
export const SUBSCRIPTION_ID_KEY = "io.modelcontextprotocol/subscriptionId";

/**
 * Why passthrough answers an unrecorded listen with the miss error rather than
 * forwarding it. A live server answers a listen only when the subscription
 * ends, so the forward would hold the session until the relay times out and
 * then count a failure the client did not cause. A listen the recording holds
 * is still served; only the one passthrough could not learn is refused.
 */
export const LISTEN_NOT_FORWARDED =
  `passthrough does not forward "${LISTEN_METHOD}": a live server answers it only when the subscription ends, ` +
  "so the client gets the miss error instead";

/**
 * The `io.modelcontextprotocol/tasks` extension, and the one rule replay needs
 * from it.
 *
 * A server that will take a while answers with a task handle instead of the
 * result, and the client polls `tasks/get` until the status is terminal. Every
 * poll for one task carries the same params, so they share a fingerprint and
 * come out of one pool in recorded order: the client sees the recorded state
 * sequence whatever interval it polls at. What the pool cannot answer is a poll
 * after its last recording, and that is where the terminal states matter. A
 * task that finished stays finished, so its last answer is served again; a
 * recording that ended while the task was still running has no later state to
 * give, and says so.
 */
export const TASK_GET_METHOD = "tasks/get";
export const TASK_NOTIFICATION_METHOD = "notifications/tasks";
/** `completed`, `failed` and `cancelled`: once reached, the task's state does not change. */
export const TERMINAL_TASK_STATES = new Set(["completed", "failed", "cancelled"]);

/** The task a `tasks/get` asks about, when its params name one. */
function taskIdOf(req: { params?: unknown }): string | undefined {
  const id = (req.params as { taskId?: unknown } | undefined)?.taskId;
  return typeof id === "string" ? id : undefined;
}

/** The status a task answer carries, when it carries one replay can read. */
function taskStatusOf(res: JsonRpcResponse): string | undefined {
  const status = (res.result as { status?: unknown } | undefined)?.status;
  return typeof status === "string" ? status : undefined;
}

/**
 * Where a recording left one task, read off its `tasks/get` pool: the request
 * that asked, the last answer the pool holds, and how many polls it holds.
 *
 * Undefined when the request names no task or the last answer carries no status
 * replay can read. Neither says anything about whether the task finished, so
 * neither earns the terminal rule, and the pool stays an ordinary one.
 *
 * The HTTP front-end reads this too, off the last stream recorded for the same
 * fingerprint: a server that answered the poll by streaming (which is what an
 * SDK server does unless it was configured otherwise) left the same task in the
 * same place, and the rule is about the task rather than about the shape its
 * answer arrived in.
 */
export function readTaskPolls(
  request: JsonRpcRequest,
  last: JsonRpcResponse,
  recordedPolls: number
): RecordedTaskPolls | undefined {
  if (request.method !== TASK_GET_METHOD) return undefined;
  const taskId = taskIdOf(request);
  if (taskId === undefined) return undefined;
  const status = taskStatusOf(last);
  if (status === undefined) return undefined;
  return { taskId, last, status, terminal: TERMINAL_TASK_STATES.has(status), recordedPolls };
}

// Fingerprint components are joined with NUL: it can never appear in a method
// name or in JSON text, so no crafted tool name or argument can collide.
const SEP = "\u0000";

/**
 * An MRTR retry (2026-07-28) carries the client's answers in `inputResponses`
 * and echoes the server's opaque `requestState`, both beside `name` and
 * `arguments` in `params`. They are what the retry is about: two retries that
 * answered differently are different requests, however equal their arguments.
 */
const MRTR_FIELDS = ["inputResponses", "requestState"] as const;

/** The retry part of a request's params; undefined when the request is not a retry. */
function mrtrPart(params: unknown): Record<string, unknown> | undefined {
  if (!params || typeof params !== "object") return undefined;
  const part: Record<string, unknown> = {};
  for (const key of MRTR_FIELDS) {
    const value = (params as Record<string, unknown>)[key];
    if (value !== undefined) part[key] = value;
  }
  return Object.keys(part).length > 0 ? part : undefined;
}

function isMrtrRetry(req: { params?: unknown }): boolean {
  return mrtrPart(req.params) !== undefined;
}

/**
 * Declared volatility: the request fields a user says change every run.
 *
 * A declaration is a JSON Pointer into the request's `params`
 * (`/arguments/requestedAt`), optionally scoped to one method by naming that
 * method before a colon (`tools/call:/arguments/requestedAt`). A JSON Pointer
 * always starts with `/`, which is what tells the two forms apart with no
 * ambiguity: a declaration that does not start with one must name a method
 * first, and a `:` inside a pointer is an ordinary character.
 *
 * Both sides drop them before hashing, the recorded one as it is indexed and
 * the live one as it arrives, so a request differing only in a declared field
 * matches its recording. This is the precise version of the tolerance the
 * same-method fallback used to give silently, and dropping happens in exactly
 * one place (`fingerprint`) so the next pre-hash rewrite has one place to go.
 */
interface VolatileField {
  /** Only requests with this method drop this pointer; every method when absent. */
  method?: string;
  pointer: string;
}

/**
 * The fields replay reads to decide which rule applies, rather than to tell two
 * requests apart.
 *
 * Erasing one of these does not loosen a match, it changes which rule runs, and
 * every way that goes is a wrong answer delivered in silence: a `tools/call`
 * that lost its `name` is answered with another tool's recording, a retry that
 * lost its `inputResponses` falls into the pool of the call it retried while
 * the fallback still refuses to lend it one, and a `tasks/get` that lost its
 * `taskId` pools every task together and then re-serves one task's final state
 * to a poll about another. That is the silent wrong answer this whole feature
 * exists to replace, so a declaration naming one is refused instead of served.
 *
 * `inputResponses` is reserved on every method rather than on `tools/call`
 * alone, because `isMrtrRetry` reads it on every method: `tasks/update` carries
 * it too and travels under the same rule.
 */
const ENGINE_READ: readonly { method?: string; key: string; refusal: string }[] = [
  {
    key: "inputResponses",
    refusal:
      "replay matches on /inputResponses to tell a retry from the call it retried, on every method, " +
      "so dropping it would answer a retry with the recording of the call it retried",
  },
  {
    // `mrtrPart` reads both fields, so a request carrying only `requestState`
    // is still a retry to `isMrtrRetry`. Dropping it would leave that request
    // keyed on nothing a retry is keyed on, and it would land in the pool of
    // the call it retried.
    key: "requestState",
    refusal:
      "replay matches on /requestState to tell a retry from the call it retried, on every method, " +
      "so dropping it would answer a retry carrying no /inputResponses with the recording of the plain call",
  },
  {
    method: "tools/call",
    key: "name",
    refusal: "replay matches a tools/call on /name, so dropping it would answer a call with another tool's recording",
  },
  {
    method: "tasks/get",
    key: "taskId",
    refusal:
      "replay matches a tasks/get on /taskId, so dropping it would pool every task's polls together and " +
      "serve one task's final state for another",
  },
];

/**
 * Refuse a declaration that would erase a field replay matches a rule on.
 *
 * An unscoped declaration reaches the rule's method as surely as a scoped one,
 * so both are refused; only a declaration scoped to some other method is safe,
 * which is what keeps `prompts/get:/name` and `tasks/update:/taskId` available.
 */
function checkEngineRead(spec: string, field: VolatileField): void {
  const first = splitPointer(field.pointer)[0];
  if (first === undefined) return;
  for (const rule of ENGINE_READ) {
    if (rule.key !== first) continue;
    if (rule.method !== undefined && field.method !== undefined && field.method !== rule.method) continue;
    throw new Error(
      `mcp-cassette: cannot declare "${spec}" volatile: ${rule.refusal}` +
        (rule.method === undefined ? "" : ". Scope the declaration to a method that does not match on it")
    );
  }
}

function parseVolatileField(spec: string): VolatileField {
  // One message for both sources, because a declaration is the same thing
  // whether the invocation passed it or the cassette header carries it.
  const reject = (why: string): never => {
    throw new Error(
      `mcp-cassette: ${why}: "${spec}". A volatile declaration is a JSON Pointer into the request ` +
        `params (/arguments/requestedAt), optionally scoped to one method ` +
        `(tools/call:/arguments/requestedAt); it comes from replay --volatile or the cassette ` +
        `header's "volatile" list`
    );
  };
  const field = ((): VolatileField => {
    // RFC 6901 calls "" a pointer, the whole document, so the empty forms are
    // refused for what they would do rather than for being malformed: a
    // declaration that erased all of `params` would make every request it
    // applies to identical.
    if (spec === "") return reject("the declaration names no field");
    if (spec.startsWith("/")) {
      splitPointer(spec); // rejects a pointer this engine cannot walk, by name
      return { pointer: spec };
    }
    const colon = spec.indexOf(":");
    if (colon === -1) return reject("neither a JSON Pointer nor a method-scoped one");
    const method = spec.slice(0, colon);
    const pointer = spec.slice(colon + 1);
    if (method === "") return reject("the method scope is empty");
    if (pointer === "") return reject(`the declaration names no field, only the method "${method}"`);
    if (!pointer.startsWith("/")) return reject(`the pointer after "${method}:" does not start with "/"`);
    splitPointer(pointer);
    return { method, pointer };
  })();
  checkEngineRead(spec, field);
  return field;
}

/**
 * Parsed declarations, memoized on the very array they came in: every call of a
 * session is handed the index's own list, so the parse happens once per replay
 * rather than once per fingerprint.
 */
const parsedVolatile = new WeakMap<readonly string[], VolatileField[]>();

/**
 * Refuse a malformed declaration now rather than wherever it would next be
 * read. `buildReplayIndex` does this for every replay; the test adapters call
 * it while the suite is being collected, so a stdio cassette, whose
 * declarations only reach a replay inside the child the client spawns, fails
 * where the mistake is instead of inside that child's stderr.
 */
export function validateVolatile(specs: readonly string[]): void {
  volatileFields(specs);
}

/** Parse a declaration list, naming a malformed declaration rather than ignoring it. */
function volatileFields(specs: readonly string[]): VolatileField[] {
  let fields = parsedVolatile.get(specs);
  if (!fields) {
    fields = specs.map(parseVolatileField);
    parsedVolatile.set(specs, fields);
  }
  return fields;
}

/**
 * A request's params with every declaration that applies to its method dropped,
 * and the params themselves when nothing applies: a session that declares
 * nothing never leaves the path it was on.
 *
 * The removal is verify's `removePointer`, deliberately rather than a second
 * one: it blanks an array element instead of splicing it out, which is what a
 * fingerprint needs (both sides get the same constant) and is what keeps two
 * declared indices of one array from re-indexing each other.
 */
function dropVolatile(method: string, params: unknown, specs: readonly string[]): unknown {
  if (specs.length === 0) return params;
  const fields = volatileFields(specs).filter((f) => f.method === undefined || f.method === method);
  if (fields.length === 0) return params;
  const dropped = structuredClone(params);
  for (const field of fields) removePointer(dropped, field.pointer);
  return dropped;
}

/**
 * Refuse a cassette whose recording ran under different redaction rules than
 * this session was given.
 *
 * Redaction runs before fingerprinting on both sides, so the rules are part of
 * what a fingerprint means. A custom rule present at record time and absent at
 * replay time leaves every recorded request hashed over a placeholder and every
 * live one over the secret itself, which is not a miss anyone can diagnose: the
 * diff names a field whose recorded value is a placeholder and whose live value
 * is the value, and the fix is a flag rather than the recording. So it is
 * caught where it can still be named, and the message says which side is short
 * a config rather than only that the two differ.
 */
function assertRedactConfigMatches(cassette: Cassette, cfg: CompiledRedactConfig): void {
  const recorded = cassette.header.redaction?.configHash;
  if (recorded === cfg.hash) return;
  const refuse = (why: string): never => {
    throw new Error(
      `mcp-cassette: ${why}. Redaction runs before matching, so replay must use the rules the recording used`
    );
  };
  if (recorded === undefined) {
    refuse(
      "this replay was given a redaction config, but the cassette was recorded without one; " +
        "drop --redact-config, or re-record with it"
    );
  }
  if (cfg.hash === undefined) {
    refuse(
      "the cassette was recorded with a redaction config this replay was not given; " +
        "pass the same --redact-config the recording used"
    );
  }
  refuse("the cassette was recorded with a different redaction config than this replay was given");
}

/** The same request with its declared-volatile fields gone: what every comparison sees. */
function withoutVolatile(index: ReplayIndex, req: JsonRpcRequest): JsonRpcRequest {
  if (index.volatile.length === 0) return req;
  return { ...req, params: dropVolatile(req.method, req.params, index.volatile) };
}

/**
 * An incoming request in the shape the recording is keyed on: redacted if the
 * cassette was, then with its declared-volatile fields dropped.
 *
 * The order is the recorder's. A redacted cassette holds placeholders because
 * redaction ran at record time and the drop ran as the index was built, so a
 * live request has to travel the same two steps in the same order to land on
 * the same fingerprint. Both front-ends go through here rather than spelling
 * the pair out, which is what keeps them from drifting apart and gives the next
 * change to the request path one site instead of four.
 */
export function effectiveRequest(index: ReplayIndex, req: JsonRpcRequest): JsonRpcRequest {
  const redacted = index.redactRequests ? (redactFrame(req, index.redactConfig) as JsonRpcRequest) : req;
  return withoutVolatile(index, redacted);
}

export function fingerprint(
  req: { method: string; params?: unknown },
  /** Declared-volatile pointers, dropped before anything is hashed. */
  volatile: readonly string[] = []
): string {
  if (METHOD_ONLY.has(req.method)) return req.method;
  const params = dropVolatile(req.method, req.params, volatile) as Record<string, unknown> | undefined;
  if (req.method === "tools/call" && params && typeof params === "object") {
    const call = `tools/call${SEP}${String(params.name)}${SEP}${stableStringify(params.arguments ?? {})}`;
    // Appended only when present, so every non-retry fingerprint is unchanged.
    const retry = mrtrPart(params);
    return retry ? `${call}${SEP}${stableStringify(retry)}` : call;
  }
  const cleaned = { ...(params ?? {}) } as Record<string, unknown>;
  delete cleaned._meta;
  delete cleaned.cursor; // pagination cursors are server-generated and volatile
  return `${req.method}${SEP}${stableStringify(cleaned)}`;
}

/**
 * A recorded `subscriptions/listen` and the acknowledgment that answered it.
 *
 * The recording almost never holds a response for a listen request: the server
 * answers one only when it ends the subscription itself. So the acknowledgment
 * is what replay treats as the answer, which is also why an unanswered listen
 * must never be indexed as a miss.
 */
export interface RecordedListen {
  request: JsonRpcRequest;
  acknowledgment?: JsonRpcNotification;
}

/** Where the recording left one task, and how many polls it took to get there. */
export interface RecordedTaskPolls {
  taskId: string;
  /** The last answer the recording holds for this task. */
  last: JsonRpcResponse;
  /** Its status, and whether the extension calls that status terminal. */
  status: string;
  terminal: boolean;
  recordedPolls: number;
}

/**
 * The frames the recorded server sent on its own, each tied to the point in the
 * session where replay may send it.
 *
 * Both maps are keyed by the recorded answer itself, by object identity, so a
 * fingerprint recorded three times releases the frames of its first occurrence
 * when its first recording is consumed and not before. An anchor is a
 * `JsonRpcResponse` for a JSON answer, a `ChunksEntry` for a streamed one, and
 * the `JsonRpcRequest` itself for a listen answered by its acknowledgment.
 */
export interface ServerFrameSchedule {
  /** Nothing precedes these in the recording: due as soon as there is a channel to carry them. */
  initial: JsonRpcFrame[];
  /** Released right after the recorded answer they follow reaches the client. */
  after: Map<object, JsonRpcFrame[]>;
  /**
   * Released just *before* the recorded answer they preceded. These are the
   * frames the server sent while the request was still outstanding, which on
   * stdio is where `notifications/progress` for that request lives.
   */
  before: Map<object, JsonRpcFrame[]>;
}

export interface ReplayIndex {
  byFingerprint: Map<string, JsonRpcResponse[]>;
  byMethod: Map<string, JsonRpcResponse[]>;
  /** Every answered c2s request as recorded: the corpus near-miss diagnostics search. */
  recordedRequests: JsonRpcRequest[];
  /** Recorded c2s requests the recording holds no response for: a miss cause of its own. */
  unansweredRequests: JsonRpcRequest[];
  /** How many responses each fingerprint had before any were consumed. */
  recordedCountByFingerprint: Map<string, number>;
  /** Recorded `subscriptions/listen` requests, pooled by fingerprint and consumed in order. */
  listens: Map<string, RecordedListen[]>;
  /** The last recorded answer to each `tasks/get` fingerprint: what a poll past the pool reads. */
  taskPolls: Map<string, RecordedTaskPolls>;
  /** How many subscriptions each listen fingerprint had before any were opened. */
  recordedListenCountByFingerprint: Map<string, number>;
  /** Recorded subscription id -> the id the client's own listen request carries. */
  liveSubscriptions: Map<string, JsonRpcId>;
  /** Frames held back because they belong to a subscription this client never opened. */
  unopenedSubscriptionFrames: number;
  /** Server-initiated frames and where the recording puts them. */
  serverFrames: ServerFrameSchedule;
  /** Server-initiated *requests* (legacy sampling, elicitation, roots): replay still does not originate these. */
  serverInitiatedRequests: number;
  /** Recorded fingerprints are redacted, so incoming requests must be too. */
  redactRequests: boolean;
  /**
   * The declared-volatile pointers in force: the cassette header's own,
   * followed by the ones the invocation added. Empty is the whole of the old
   * behaviour, and the list is held as written so one parse covers the session.
   */
  volatile: readonly string[];
  /**
   * The redaction rules this session runs, which must be the ones the recording
   * ran under: redaction happens before fingerprinting, so a rule present on
   * one side only leaves the two hashing different text. `buildReplayIndex`
   * refuses a cassette whose recorded hash does not match.
   */
  redactConfig: CompiledRedactConfig;
}

/**
 * The `subscriptions/listen` id a frame belongs to, when it carries one: the
 * `_meta` tag on a notification, and for the server's graceful closure the
 * response id itself, which the spec defines as the same value.
 */
export function subscriptionOf(frame: JsonRpcFrame): JsonRpcId | undefined {
  if (isResponse(frame)) return frame.id;
  const meta = (frame.params as { _meta?: Record<string, unknown> } | undefined)?._meta;
  const id = meta?.[SUBSCRIPTION_ID_KEY];
  return typeof id === "string" || typeof id === "number" ? id : undefined;
}

/** One frame of the recorded session, in the order the wire put it there. */
interface TimelineEvent {
  at: number;
  entry: number;
  within: number;
  frame: JsonRpcFrame;
  /** Set when the frame came out of a `chunks` entry rather than standing alone. */
  stream?: ChunksEntry;
  /** A client request leaving the client: what makes a later server frame request-scoped. */
  sent?: JsonRpcRequest;
}

/** Every frame in the recording, both directions, in wire order. */
function sessionTimeline(cassette: Cassette): TimelineEvent[] {
  const timeline: TimelineEvent[] = [];
  for (const [i, entry] of cassette.entries.entries()) {
    if (entry.type === "frame" && entry.dir === "c2s") {
      if (isRequest(entry.frame)) timeline.push({ at: entry.t, entry: i, within: -1, frame: entry.frame, sent: entry.frame });
      continue;
    }
    if (entry.dir !== "s2c") continue;
    if (entry.type === "frame") {
      timeline.push({ at: entry.t, entry: i, within: -1, frame: entry.frame });
    } else if (entry.type === "chunks") {
      for (const [j, chunk] of entry.chunks.entries()) {
        timeline.push({ at: chunk.t, entry: i, within: j, frame: chunk.frame, stream: entry });
      }
    }
  }
  // Timestamps, not file order: an HTTP recording holds a whole stream in one
  // entry written when the stream closed, while its frames are stamped as they
  // arrived, so file order puts them all after requests they preceded. File
  // order breaks the ties a millisecond clock leaves behind, which means a
  // stream frame stamped the same millisecond as a request sorts after it and
  // is read as inside that request's window. Nothing better is available: at
  // one-millisecond resolution the recording genuinely does not say which came
  // first, and file order is the only other evidence there is.
  return timeline.sort((a, b) => a.at - b.at || a.entry - b.entry || a.within - b.within);
}

/** Pair each recorded listen with the acknowledgment that answered it. */
function collectListens(cassette: Cassette, timeline: TimelineEvent[]): RecordedListen[] {
  const listens: RecordedListen[] = [];
  for (const entry of cassette.entries) {
    if (entry.type !== "frame" || entry.dir !== "c2s") continue;
    if (isRequest(entry.frame) && entry.frame.method === LISTEN_METHOD) listens.push({ request: entry.frame });
  }
  for (const { frame, sent } of timeline) {
    if (sent || isResponse(frame) || frame.method !== ACKNOWLEDGED_METHOD) continue;
    const tagged = subscriptionOf(frame);
    // The acknowledgment names its subscription; a recording that left the tag
    // out still pairs, with the oldest listen still waiting for one.
    const listen =
      (tagged !== undefined ? listens.find((l) => String(l.request.id) === String(tagged)) : undefined) ??
      listens.find((l) => !l.acknowledgment);
    if (listen) listen.acknowledgment = frame as JsonRpcNotification;
  }
  return listens;
}

/**
 * Walk the recording once and hang every server-initiated frame off the answer
 * it sat next to.
 *
 * Two positions, because recordings hold two kinds of frame. One arrived while
 * no request was outstanding: nothing was pending, so it belongs right after
 * the answer that preceded it. The other arrived while a request *was*
 * outstanding, which on stdio is how `notifications/progress` and
 * `notifications/message` for that request appear, and it belongs right before
 * that request's answer. Anchoring the second kind to the previous answer would
 * send a request's own progress before the client has even sent the request.
 *
 * Three kinds of s2c frame are deliberately not scheduled here at all. A
 * response is an answer. The acknowledgment of a listen is that listen's
 * answer, and so becomes an anchor rather than a frame to release. And the
 * notifications inside an ordinary streamed answer already travel with the
 * stream that answers their request.
 */
function scheduleServerFrames(
  cassette: Cassette,
  timeline: TimelineEvent[],
  listens: RecordedListen[]
): { schedule: ServerFrameSchedule; serverInitiatedRequests: number } {
  const listenById = new Map(listens.map((l) => [String(l.request.id), l]));
  const acknowledgments = new Set(listens.map((l) => l.acknowledgment).filter(Boolean));
  const streamEnds = new Map<ChunksEntry, JsonRpcFrame>();
  // There is one GET endpoint, so one standalone stream is served and the rest
  // are reported; scheduling frames nothing will ever carry would only make
  // them look lost at session end.
  let standalone: ChunksEntry | undefined;
  const ignored = new Set<ChunksEntry>();
  for (const entry of cassette.entries) {
    if (entry.type !== "chunks" || entry.dir !== "s2c") continue;
    if (entry.id === undefined) {
      if (standalone) ignored.add(entry);
      standalone ??= entry;
      continue;
    }
    if (listenById.has(String(entry.id))) continue;
    const last = entry.chunks[entry.chunks.length - 1];
    if (last) streamEnds.set(entry, last.frame);
  }

  // Only a request the recording actually answers can hold a frame back: a
  // request the server never answered has no answer for anything to precede, so
  // counting it as outstanding would shift every later frame one answer along.
  const answerable = new Set<string>();
  for (const listen of listens) if (listen.acknowledgment) answerable.add(String(listen.request.id));
  for (const stream of streamEnds.keys()) if (stream.id !== undefined) answerable.add(String(stream.id));
  for (const entry of cassette.entries) {
    if (entry.type !== "frame" || entry.dir !== "s2c" || !isResponse(entry.frame)) continue;
    if (!listenById.has(String(entry.frame.id))) answerable.add(String(entry.frame.id));
  }

  const schedule: ServerFrameSchedule = { initial: [], after: new Map(), before: new Map() };
  let anchor: object | null = null;
  let serverInitiatedRequests = 0;
  /** Requests the client has sent that the recorded server has not answered yet. */
  const outstanding = new Set<string>();
  /** Frames recorded inside an outstanding window, waiting for the answer they precede. */
  let pending: JsonRpcFrame[] = [];

  const put = (map: Map<object, JsonRpcFrame[]>, key: object, frames: JsonRpcFrame[]) => {
    const waiting = map.get(key);
    if (waiting) waiting.push(...frames);
    else map.set(key, frames);
  };

  const push = (frame: JsonRpcFrame) => {
    if (outstanding.size > 0) {
      pending.push(frame);
      return;
    }
    if (anchor) put(schedule.after, anchor, [frame]);
    else schedule.initial.push(frame);
  };

  /** An answer lands: whatever was waiting on it goes out just ahead of it. */
  const answered = (key: object, id?: JsonRpcId) => {
    if (id !== undefined) outstanding.delete(String(id));
    if (pending.length > 0) {
      put(schedule.before, key, pending);
      pending = [];
    }
    anchor = key;
  };

  for (const event of timeline) {
    const { frame, stream, sent } = event;
    if (sent) {
      if (answerable.has(String(sent.id))) outstanding.add(String(sent.id));
      continue;
    }
    if (stream && ignored.has(stream)) continue;
    if (acknowledgments.has(frame as JsonRpcNotification)) {
      // The acknowledgment answers its listen, so the listen becomes the anchor
      // everything that follows on the subscription hangs from.
      const listen = listens.find((l) => l.acknowledgment === frame);
      if (listen) answered(listen.request, listen.request.id);
      continue;
    }
    if (stream && streamEnds.get(stream) === frame) {
      answered(stream, stream.id); // a streamed answer completes on its last frame
      continue;
    }
    if (stream && streamEnds.has(stream)) continue; // request-scoped, travels with its own stream
    if (isResponse(frame)) {
      // The response to a listen is the server's graceful closure: a frame to
      // replay at its recorded position, not an answer replay hands out.
      if (listenById.has(String(frame.id))) push(frame);
      else answered(frame, frame.id);
      continue;
    }
    if (isRequest(frame)) {
      serverInitiatedRequests++; // sampling, elicitation, roots: beyond replay
      continue;
    }
    push(frame);
  }
  // The recording ended with a request still outstanding. There is no answer
  // left for these to precede, so they take the position they would have had
  // without one.
  for (const frame of pending) {
    if (anchor) put(schedule.after, anchor, [frame]);
    else schedule.initial.push(frame);
  }

  return { schedule, serverInitiatedRequests };
}

export function buildReplayIndex(
  cassette: Cassette,
  /**
   * `volatile`: declarations from the CLI or an adapter, added to the cassette
   * header's own. `redactConfig`: the user's compiled redaction rules, which
   * must be the ones the cassette was recorded under.
   */
  options: { volatile?: readonly string[]; redactConfig?: CompiledRedactConfig } = {}
): ReplayIndex {
  const redactConfig = options.redactConfig ?? BUILTIN_REDACTION;
  assertRedactConfigMatches(cassette, redactConfig);
  // Hand-editing the header is how a declaration gets into a cassette today, so
  // its shape is checked before it is spread: a list that is not one, or one
  // holding something other than strings, is refused by name like a malformed
  // entry rather than reaching the parser as a TypeError.
  const declared: unknown = cassette.header.volatile ?? [];
  if (!Array.isArray(declared) || declared.some((entry) => typeof entry !== "string")) {
    throw new Error(
      `mcp-cassette: the cassette header's "volatile" must be a list of strings, got ${JSON.stringify(declared)}`
    );
  }
  // Header first, invocation after: the cassette carries its own declaration
  // and the run adds to it.
  const volatile: readonly string[] = Object.freeze([...(declared as string[]), ...(options.volatile ?? [])]);
  // Parsed (and cached) here so a malformed declaration is refused while the
  // index is being built, by name, rather than thrown in the middle of a match.
  volatileFields(volatile);

  const responsesById = new Map<string, JsonRpcResponse>();

  for (const entry of cassette.entries) {
    if (entry.type !== "frame" || entry.dir !== "s2c") continue;
    if (isResponse(entry.frame)) responsesById.set(String(entry.frame.id), entry.frame);
  }

  const timeline = sessionTimeline(cassette);
  const recorded = collectListens(cassette, timeline);
  const { schedule, serverInitiatedRequests } = scheduleServerFrames(cassette, timeline, recorded);

  const byFingerprint = new Map<string, JsonRpcResponse[]>();
  const byMethod = new Map<string, JsonRpcResponse[]>();
  const recordedRequests: JsonRpcRequest[] = [];
  const unansweredRequests: JsonRpcRequest[] = [];
  const listens = new Map<string, RecordedListen[]>();

  for (const entry of cassette.entries) {
    if (entry.type !== "frame" || entry.dir !== "c2s") continue;
    const frame = entry.frame;
    if (!isRequest(frame)) continue;
    if (frame.method === LISTEN_METHOD) {
      // A listen is answered by its acknowledgment stream, never out of the
      // response pool, even on the rare recording that holds its closure.
      const listen = recorded.find((l) => l.request === frame);
      if (listen) {
        const fp = fingerprint(frame, volatile);
        if (!listens.has(fp)) listens.set(fp, []);
        listens.get(fp)!.push(listen);
        // It is still a recorded request, so a listen that misses can be
        // diagnosed against the ones the file holds rather than reported as a
        // method nobody recorded.
        recordedRequests.push(frame);
        continue;
      }
    }
    const response = responsesById.get(String(frame.id));
    if (!response) {
      unansweredRequests.push(frame);
      continue;
    }
    recordedRequests.push(frame);
    const fp = fingerprint(frame, volatile);
    if (!byFingerprint.has(fp)) byFingerprint.set(fp, []);
    byFingerprint.get(fp)!.push(response);
    // A retry's answer is bound to the input that retry carried. Handed to any
    // other request, it would skip the very step the input answered.
    if (isMrtrRetry(frame)) continue;
    if (!byMethod.has(frame.method)) byMethod.set(frame.method, []);
    byMethod.get(frame.method)!.push(response);
  }

  const recordedCountByFingerprint = new Map<string, number>();
  for (const [fp, pool] of byFingerprint) recordedCountByFingerprint.set(fp, pool.length);

  // Where the recording left each task. Built from the whole pool rather than
  // consumed with it, so a poll past the end can still read the final state.
  const taskPolls = new Map<string, RecordedTaskPolls>();
  for (const request of recordedRequests) {
    // Guarded before fingerprinting rather than inside `readTaskPolls`: every
    // recorded request would otherwise pay for a stable stringify of its params
    // that only a poll can use.
    if (request.method !== TASK_GET_METHOD) continue;
    const fp = fingerprint(request, volatile);
    const pool = byFingerprint.get(fp) ?? [];
    const last = pool[pool.length - 1];
    if (!last) continue;
    const polls = readTaskPolls(request, last, pool.length);
    if (polls) taskPolls.set(fp, polls);
  }
  const recordedListenCountByFingerprint = new Map<string, number>();
  for (const [fp, pool] of listens) recordedListenCountByFingerprint.set(fp, pool.length);

  return {
    byFingerprint,
    byMethod,
    recordedRequests,
    unansweredRequests,
    recordedCountByFingerprint,
    listens,
    taskPolls,
    recordedListenCountByFingerprint,
    liveSubscriptions: new Map(),
    unopenedSubscriptionFrames: 0,
    serverFrames: schedule,
    serverInitiatedRequests,
    redactRequests: cassette.header.redaction?.applied === true,
    volatile,
    redactConfig,
  };
}

/**
 * The subscription id a replayed frame carries is the one the client's own
 * request will see: the recorded value belongs to a session that is over, and a
 * client correlates notifications by the id it chose.
 */
function rekeySubscription(index: ReplayIndex, frame: JsonRpcFrame): JsonRpcFrame {
  if (isResponse(frame)) {
    const live = index.liveSubscriptions.get(String(frame.id));
    return live === undefined ? frame : { ...frame, id: live, result: rekeyMeta(frame.result, live) };
  }
  const tagged = subscriptionOf(frame);
  if (tagged === undefined) return frame;
  const live = index.liveSubscriptions.get(String(tagged));
  return live === undefined ? frame : { ...frame, params: rekeyMeta(frame.params, live) };
}

function rekeyMeta(container: unknown, live: JsonRpcId): unknown {
  if (!container || typeof container !== "object") return container;
  const obj = container as Record<string, unknown>;
  const meta = obj._meta;
  if (!meta || typeof meta !== "object") return obj;
  return { ...obj, _meta: { ...(meta as Record<string, unknown>), [SUBSCRIPTION_ID_KEY]: live } };
}

/** The server frames the recording opens with, consumed. */
export function releaseInitial(index: ReplayIndex): JsonRpcFrame[] {
  return deliverable(index, index.serverFrames.initial.splice(0));
}

/** The server frames the recording puts right after this answer, consumed. */
export function releaseAfter(index: ReplayIndex, answer: object): JsonRpcFrame[] {
  return take(index, index.serverFrames.after, answer);
}

/** The server frames the recording puts just before this answer, consumed. */
export function releaseBefore(index: ReplayIndex, answer: object): JsonRpcFrame[] {
  return take(index, index.serverFrames.before, answer);
}

function take(index: ReplayIndex, map: Map<object, JsonRpcFrame[]>, answer: object): JsonRpcFrame[] {
  const waiting = map.get(answer);
  if (!waiting) return [];
  map.delete(answer);
  return deliverable(index, waiting);
}

/**
 * Drop the frames that belong to a subscription this client never opened, and
 * re-key the rest.
 *
 * The recording may hold several subscriptions; this client opened some subset
 * of them, or none. A frame tagged with one it did not open has no id it could
 * be re-keyed to, and 2026-07-28 tells clients they MUST correlate on that tag,
 * so sending it with the recording's own id hands the client a frame for a
 * subscription it has never heard of. It is counted and reported instead.
 */
function deliverable(index: ReplayIndex, frames: JsonRpcFrame[]): JsonRpcFrame[] {
  const out: JsonRpcFrame[] = [];
  for (const frame of frames) {
    const tagged = subscriptionOf(frame);
    if (tagged !== undefined && !index.liveSubscriptions.has(String(tagged))) {
      index.unopenedSubscriptionFrames++;
      continue;
    }
    out.push(rekeySubscription(index, frame));
  }
  return out;
}

/** Server frames still waiting: the client never sent the request each one belongs to. */
export function pendingServerFrames(index: ReplayIndex): number {
  let pending = index.serverFrames.initial.length;
  for (const waiting of index.serverFrames.after.values()) pending += waiting.length;
  for (const waiting of index.serverFrames.before.values()) pending += waiting.length;
  return pending;
}

/**
 * The recorded subscription this listen request opens, consumed, with its id
 * registered so every frame on it is re-keyed to the client's own.
 */
export function matchListen(index: ReplayIndex, req: JsonRpcRequest): RecordedListen | null {
  const fp = fingerprint(effectiveRequest(index, req));
  const pool = index.listens.get(fp);
  if (!pool || pool.length === 0) return null;
  const listen = pool.shift()!;
  index.liveSubscriptions.set(String(listen.request.id), req.id);
  return listen;
}

/**
 * The acknowledgment to send for a matched listen, carrying the client's own
 * subscription id. A recording that holds none says the server acknowledged
 * nothing, and replay says nothing in its place rather than inventing one.
 */
export function acknowledgmentFor(index: ReplayIndex, listen: RecordedListen): JsonRpcFrame | undefined {
  return listen.acknowledgment ? rekeySubscription(index, listen.acknowledgment) : undefined;
}

/** The recorded answer to exactly this request, consumed; null when there is none left. */
export function matchResponse(index: ReplayIndex, req: JsonRpcRequest): JsonRpcResponse | null {
  const fp = fingerprint(effectiveRequest(index, req));
  const exact = index.byFingerprint.get(fp);
  if (exact && exact.length > 0) {
    const res = exact.shift()!;
    consumeFromMethodPool(index, req.method, res);
    return res;
  }
  // A finished task is still finished. The client may poll once more, or come
  // back with a task id it persisted across a restart, and the recording's
  // answer is as true then as it was on the last recorded poll. It is served
  // without being consumed, because there is nothing left to consume.
  const task = index.taskPolls.get(fp);
  if (task?.terminal) return task.last;
  return null;
}

/**
 * `--on-miss warn`'s tolerance: the next unconsumed recording of the same
 * method, whatever its arguments, consumed. It answers a request with another
 * request's answer, which is why only warn reaches for it, and why the caller
 * says so out loud.
 */
export function matchFallback(index: ReplayIndex, req: JsonRpcRequest): JsonRpcResponse | null {
  // A retry that matched nothing exactly answered differently from the
  // recording; any recorded answer would claim the recorded input was given.
  if (isMrtrRetry(req)) return null;
  // The same refusal for the same reason: every `tasks/get` answer carries the
  // id and state of one task. Lending it to a poll about another task would
  // tell that client its own task reached a state it never reached.
  if (req.method === TASK_GET_METHOD) return null;
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
  /** As above, for a `subscriptions/listen` whose recorded subscriptions are all open already. */
  | { kind: "subscription-exhausted"; fingerprint: string; recordedCount: number }
  /** A `tasks/get` past the last recorded poll, on a task the recording never saw finish. */
  | { kind: "task-not-terminal"; taskId: string; status: string; recordedPolls: number }
  /** Recorded, but the recording holds no response for it: there is nothing to answer with. */
  | { kind: "recorded-unanswered"; method: string; exact: boolean }
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
  // Every comparison below runs on the declared fields' absence, on both sides.
  // A field the user said changes every run must never be the path a miss
  // blames: it is the one divergence the session already said to expect.
  const incoming = effectiveRequest(index, req);
  const fp = fingerprint(incoming);

  // Checked before the plain exhausted pool it is a special case of: "you polled
  // more than the recording did" is true of both, and only this one can say why
  // there is nothing more to serve.
  const task = index.taskPolls.get(fp);
  if (task && !task.terminal) {
    return { kind: "task-not-terminal", taskId: task.taskId, status: task.status, recordedPolls: task.recordedPolls };
  }
  const recordedCount = index.recordedCountByFingerprint.get(fp);
  if (recordedCount !== undefined) return { kind: "exhausted", fingerprint: fp, recordedCount };
  // A listen is answered out of its own pool, so a spent one is its own cause:
  // the fingerprint was recorded, and every subscription under it is open.
  const recordedListens = index.recordedListenCountByFingerprint.get(fp);
  if (recordedListens !== undefined) {
    return { kind: "subscription-exhausted", fingerprint: fp, recordedCount: recordedListens };
  }
  // "Recorded but never answered" is its own cause. Reporting it as an unknown
  // method would be a lie about the file, and would send the reader looking for
  // a request that is sitting right there in the recording.
  const unanswered = index.unansweredRequests.filter((r) => r.method === incoming.method);
  if (unanswered.some((r) => fingerprint(r, index.volatile) === fp)) {
    return { kind: "recorded-unanswered", method: incoming.method, exact: true };
  }
  if (index.recordedRequests.length === 0 && unanswered.length === 0) return { kind: "empty-cassette" };

  const sameMethod = index.recordedRequests
    .filter((r) => r.method === incoming.method)
    .map((r) => withoutVolatile(index, r));
  if (sameMethod.length === 0) {
    if (unanswered.length > 0) return { kind: "recorded-unanswered", method: incoming.method, exact: false };
    const all = [...index.recordedRequests, ...index.unansweredRequests];
    const recordedMethods = [...new Set(all.map((r) => r.method))].sort();
    return { kind: "unknown-method", method: incoming.method, recordedMethods };
  }

  if (incoming.method === "tools/call") {
    const wanted = String((incoming.params as Record<string, unknown> | undefined)?.name);
    const byName = sameMethod.filter(
      (r) => String((r.params as Record<string, unknown> | undefined)?.name) === wanted
    );
    if (byName.length === 0) {
      const recordedTools = [...new Set(sameMethod.map((r) => String((r.params as Record<string, unknown> | undefined)?.name)))].sort();
      return { kind: "unknown-tool", tool: wanted, recordedTools };
    }
    const argsOf = (r: JsonRpcRequest) => (r.params as Record<string, unknown>).arguments ?? {};
    const changes = nearestChanges(byName.map(argsOf), argsOf(incoming));
    if (changes.length > 0) return { kind: "arguments-differ", changes };
    // The arguments equal a recording's, so what diverged is the MRTR retry
    // part: the input the client answered with, or the state it echoed back.
    const sameArgs = byName.filter((r) => diffValues(argsOf(r), argsOf(incoming)).length === 0);
    // A retry is nearest to a recorded retry, never to the call it retried:
    // "inputResponses recorded (absent)" would point at the wrong recording.
    const retries = sameArgs.filter(isMrtrRetry);
    const candidates = isMrtrRetry(incoming) && retries.length > 0 ? retries : sameArgs;
    return {
      kind: "params-differ",
      changes: nearestChanges(candidates.map((r) => mrtrPart(r.params) ?? {}), mrtrPart(incoming.params) ?? {}),
    };
  }

  return {
    kind: "params-differ",
    changes: nearestChanges(sameMethod.map((r) => r.params ?? {}), incoming.params ?? {}),
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
    case "task-not-terminal":
      return (
        `the recording holds ${reason.recordedPolls} poll(s) for task "${reason.taskId}" and ends with ` +
        `status "${reason.status}", which is not terminal: the task was still running when recording stopped, ` +
        `so there is no later state to serve. Re-record until the task reaches completed, failed or cancelled`
      );
    case "subscription-exhausted":
      return (
        `this exact subscription was recorded ${reason.recordedCount} time(s), and every one is already open ` +
        `in this session; the client is opening it more often than the recording did`
      );
    case "recorded-unanswered":
      return (
        (reason.exact
          ? `this exact request was recorded, but the recording holds no response for it`
          : `"${reason.method}" was recorded, but no recording of it holds a response`) +
        `: the server never answered it before the session ended, so replay has nothing to hand back`
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

export type OnMissMode = "error" | "warn" | "passthrough";

type Resolution =
  | { kind: "silent" } // notifications and stray responses: nothing to send
  /** A recorded match or a synthesized ping; `recorded` is the answer the schedule hangs server frames from. */
  | { kind: "answer"; out: JsonRpcResponse; recorded?: JsonRpcResponse }
  | { kind: "borrowed"; request: JsonRpcRequest; out: JsonRpcResponse; recorded: JsonRpcResponse; reason: MissReason } // warn's same-method answer
  /** A `subscriptions/listen` the recording holds: answered by its acknowledgment, then held open. */
  | { kind: "subscription"; request: JsonRpcRequest; listen: RecordedListen; acknowledgment?: JsonRpcFrame }
  | { kind: "miss"; request: JsonRpcRequest };

/** The one matching path both handleFrame and the live session go through. */
function resolveFrame(index: ReplayIndex, frame: JsonRpcFrame, onMiss: OnMissMode): Resolution {
  if (isNotification(frame) || !isRequest(frame)) return { kind: "silent" };
  if (frame.method === LISTEN_METHOD) {
    const listen = matchListen(index, frame);
    if (listen) return { kind: "subscription", request: frame, listen, acknowledgment: acknowledgmentFor(index, listen) };
  }
  const recorded = matchResponse(index, frame);
  if (recorded) {
    // Re-key the recorded response to the incoming request id.
    return { kind: "answer", out: { ...recorded, id: frame.id }, recorded };
  }
  if (frame.method === "ping") {
    return { kind: "answer", out: { jsonrpc: "2.0", id: frame.id, result: {} } };
  }
  if (onMiss === "warn") {
    // Diagnosed before borrowing: the reason is about this request, not the loan.
    const reason = diagnoseMissReason(index, frame);
    const borrowed = matchFallback(index, frame);
    if (borrowed) {
      return { kind: "borrowed", request: frame, out: { ...borrowed, id: frame.id }, recorded: borrowed, reason };
    }
  }
  return { kind: "miss", request: frame };
}

/** The stderr line for a borrowed answer, shared by both front-ends. */
export function formatBorrowed(method: string, reason: MissReason): string {
  return `answered "${method}" with another recording of the same method (--on-miss warn): ${formatMiss(reason)}`;
}

/**
 * Everything one incoming frame sends back, in order: the answer, then the
 * frames the recording puts right after it.
 *
 * A cassette whose server never spoke on its own produces exactly one frame
 * here, which is what keeps `handleFrame` whole for every v1 recording.
 */
export function handleExchange(index: ReplayIndex, frame: JsonRpcFrame, onMiss: OnMissMode = "error"): JsonRpcFrame[] {
  const { before, answer, after } = exchange(index, frame, onMiss);
  return [...before, ...(answer ? [answer] : []), ...after];
}

/**
 * One incoming frame resolved into the three positions an exchange has: what
 * the recording put before the answer, the answer itself, and what it put
 * after. Keeping them apart is what lets `handleFrame` keep meaning "the frame
 * to send back" while `handleExchange` carries the rest.
 */
function exchange(
  index: ReplayIndex,
  frame: JsonRpcFrame,
  onMiss: OnMissMode
): { before: JsonRpcFrame[]; answer: JsonRpcFrame | null; after: JsonRpcFrame[] } {
  const resolved = resolveFrame(index, frame, onMiss);
  const none = { before: [], answer: null, after: [] };
  switch (resolved.kind) {
    case "silent":
      return none;
    case "subscription":
      // The acknowledgment is the answer: it is what the recorded server sent
      // back when the client asked to listen.
      return {
        before: releaseBefore(index, resolved.listen.request),
        answer: resolved.acknowledgment ?? null,
        after: releaseAfter(index, resolved.listen.request),
      };
    case "answer":
      if (!resolved.recorded) return { ...none, answer: resolved.out };
      return {
        before: releaseBefore(index, resolved.recorded),
        answer: resolved.out,
        after: releaseAfter(index, resolved.recorded),
      };
    case "borrowed":
      return {
        before: releaseBefore(index, resolved.recorded),
        answer: resolved.out,
        after: releaseAfter(index, resolved.recorded),
      };
    case "miss":
      return { ...none, answer: missError(resolved.request, diagnoseMiss(index, resolved.request)) };
  }
}

/**
 * Handle a single incoming frame; returns the frame to send back, if any.
 *
 * The answer, precisely, which for a `subscriptions/listen` is the recorded
 * acknowledgment. A recording whose server pushed change notifications has more
 * to send around that answer, and this function drops them: `handleExchange` is
 * the call that carries them, in order.
 */
export function handleFrame(index: ReplayIndex, frame: JsonRpcFrame, onMiss: OnMissMode = "error"): JsonRpcFrame | null {
  return exchange(index, frame, onMiss).answer;
}

/** The id a minted pair carries: `live-1`, `live-2`, and so on. */
export function liveId(n: number): string {
  return `live-${n}`;
}

/**
 * The highest minted id these entries already carry, 0 when they carry none.
 *
 * Two writers mint from this one sequence: the passthrough spy below, and
 * `record --mode append`. Seeding past what the file holds is what keeps them
 * from reusing each other's ids, or an id the original recording used.
 */
export function highestLiveId(entries: Cassette["entries"]): number {
  let highest = 0;
  for (const entry of entries) {
    const ids = entry.type === "chunks" ? [entry.id] : entry.type === "frame" ? [(entry.frame as { id?: unknown }).id] : [];
    for (const id of ids) {
      const found = typeof id === "string" ? /^live-(\d+)$/.exec(id) : null;
      if (found) highest = Math.max(highest, Number(found[1]));
    }
  }
  return highest;
}

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
    private redact: boolean,
    /** The rules it was redacted under, so an appended frame is redacted like the rest. */
    private cfg: CompiledRedactConfig = BUILTIN_REDACTION
  ) {
    // Seed past any ids an earlier appending session left behind.
    this.seq = highestLiveId(cassette.entries);
  }

  /** The id the next appended pair will carry. */
  nextId(): string {
    return liveId(++this.seq);
  }

  private write(entry: FrameEntry | ChunksEntry): void {
    fs.appendFileSync(this.path, JSON.stringify(entry) + "\n");
  }

  private clean(frame: JsonRpcFrame): JsonRpcFrame {
    return this.redact ? (redactFrame(frame, this.cfg) as JsonRpcFrame) : frame;
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

/**
 * What the session did with the recording's server-initiated side, shared by
 * both front-ends.
 *
 * The frames still waiting are the interesting number: each one is anchored to
 * a request the client never sent, so the recording held a change notification
 * this session had no position to put it in. That is reported rather than
 * emitted out of place, because a notification arriving at the wrong moment is
 * worse than one that does not arrive.
 */
export function reportServerFrames(
  index: ReplayIndex,
  pushed: number,
  subscriptions: number,
  warn: (message: string) => void,
  /** HTTP only: frames whose position came and went with no stream open to carry them. */
  undelivered = 0
): void {
  if (subscriptions > 0) warn(`${subscriptions} subscription(s) acknowledged and held open`);
  if (pushed > 0) warn(`${pushed} server-initiated frame(s) replayed at their recorded position`);
  const waiting = pendingServerFrames(index);
  if (waiting > 0) {
    warn(
      `${waiting} recorded server-initiated frame(s) were not replayed: the client never sent the request each one follows`
    );
  }
  if (undelivered > 0) {
    warn(`${undelivered} server-initiated frame(s) came due with no stream open to carry them`);
  }
  if (index.unopenedSubscriptionFrames > 0) {
    warn(
      `${index.unopenedSubscriptionFrames} server-initiated frame(s) were not replayed: ` +
        `they belong to a subscription this client never opened`
    );
  }
}

export interface ReplayOptions {
  onMiss?: OnMissMode;
  /** Real server command, required for passthrough. */
  serverCommand?: string[];
  /**
   * Request fields that change every run, as JSON Pointers into the request
   * `params`, each optionally scoped to one method. Added to whatever the
   * cassette header declares; see `fingerprint`.
   */
  volatile?: readonly string[];
  /** Path to a `--redact-config` file; must be the one the recording used. */
  redactConfig?: string;
}

export async function runReplay(cassettePath: string, opts: ReplayOptions = {}): Promise<void> {
  const onMiss = opts.onMiss ?? "error";
  if (onMiss === "passthrough" && (!opts.serverCommand || opts.serverCommand.length === 0)) {
    throw new Error(
      "replay --on-miss passthrough needs the real server command: mcp-cassette replay <cassette> --on-miss passthrough -- <server command...>"
    );
  }

  const cassette = readCassette(cassettePath);
  const index = buildReplayIndex(cassette, {
    volatile: opts.volatile,
    ...(opts.redactConfig ? { redactConfig: readRedactConfig(opts.redactConfig) } : {}),
  });
  let misses = 0;
  let borrowed = 0;
  let appended = 0;
  let forwardFailures = 0;
  let pushed = 0;
  let subscriptions = 0;
  /** Server-initiated frames go out on the same stdout the answers do, right behind them. */
  const emitServerFrames = (frames: JsonRpcFrame[]): number => {
    for (const frame of frames) process.stdout.write(serializeFrame(frame));
    return frames.length;
  };
  // Connecting is memoized including failure: a broken server command fails
  // every subsequent miss fast instead of spawning one orphan per miss.
  let livePromise: Promise<MiniClient> | null = null;
  const connectLive = (): Promise<MiniClient> =>
    (livePromise ??= MiniClient.connect({ kind: "stdio", command: opts.serverCommand! }).then((r) => r.client));

  const live = new LiveAppender(cassettePath, cassette, index.redactRequests, index.redactConfig);

  if (index.serverInitiatedRequests > 0) {
    process.stderr.write(
      `mcp-cassette replay: ${index.serverInitiatedRequests} server-initiated request(s) in the cassette are not replayed\n`
    );
  }
  // The recording opens with these: no client request precedes them, so there
  // is nothing to wait for.
  pushed += emitServerFrames(releaseInitial(index));

  const forwardMiss = async (frame: JsonRpcRequest): Promise<JsonRpcResponse> => {
    const client = await connectLive();
    // relay, not request: an input_required answer is the client's to act on.
    const res = await client.relay(frame.method, frame.params);
    const liveId = live.nextId();
    live.frame("c2s", { ...frame, id: liveId });
    live.frame("s2c", { ...res, id: liveId });
    appended++;
    return { ...res, id: frame.id };
  };

  const handleLine = async (line: string): Promise<void> => {
    const frame = parseFrame(line);
    if (!frame) return;
    const resolved = resolveFrame(index, frame, onMiss);
    if (resolved.kind === "silent") return;
    if (resolved.kind === "subscription") {
      // No JSON-RPC response: the acknowledgment answers the listen, and the
      // request stays open for the change notifications that follow it.
      subscriptions++;
      pushed += emitServerFrames(releaseBefore(index, resolved.listen.request));
      if (resolved.acknowledgment) process.stdout.write(serializeFrame(resolved.acknowledgment));
      pushed += emitServerFrames(releaseAfter(index, resolved.listen.request));
      return;
    }
    if (resolved.kind === "answer") {
      if (resolved.recorded) pushed += emitServerFrames(releaseBefore(index, resolved.recorded));
      process.stdout.write(serializeFrame(resolved.out));
      if (resolved.recorded) pushed += emitServerFrames(releaseAfter(index, resolved.recorded));
      return;
    }
    if (resolved.kind === "borrowed") {
      borrowed++;
      process.stderr.write(`mcp-cassette replay: ${formatBorrowed(resolved.request.method, resolved.reason)}\n`);
      pushed += emitServerFrames(releaseBefore(index, resolved.recorded));
      process.stdout.write(serializeFrame(resolved.out));
      pushed += emitServerFrames(releaseAfter(index, resolved.recorded));
      return;
    }

    const request = resolved.request;
    misses++;
    const diagnosis = diagnoseMiss(index, request);
    process.stderr.write(`mcp-cassette replay: fingerprint miss for "${request.method}": ${diagnosis}\n`);
    if (onMiss === "passthrough" && request.method !== LISTEN_METHOD) {
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
    if (onMiss === "passthrough") process.stderr.write(`mcp-cassette replay: ${LISTEN_NOT_FORWARDED}\n`);
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
  if (borrowed > 0) {
    process.stderr.write(`mcp-cassette replay: ${borrowed} answer(s) borrowed from another recording of the same method\n`);
  }
  reportServerFrames(index, pushed, subscriptions, (message) => process.stderr.write(`mcp-cassette replay: ${message}\n`));
  // error mode is the strict one: a session that missed is a failed session.
  // warn answers what it can, borrowing if it must, and exits clean. passthrough
  // is clean only when every forward actually reached the live server.
  const failed = (onMiss === "error" && misses > 0) || (onMiss === "passthrough" && forwardFailures > 0);
  process.exitCode = failed ? 1 : 0;
}
