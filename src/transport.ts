/**
 * Transports: how a JSON-RPC frame reaches a server and how its answer comes
 * back. One job only: deliver a frame, return the response frame.
 *
 * Everything above this file (the lifecycle handshake, the request API,
 * pagination) lives in MiniClient and is transport-blind; everything below it
 * (process pipes, HTTP headers, SSE framing) lives here and is
 * lifecycle-blind. That split is what lets `check`, `snapshot`, and `verify`
 * speak to a stdio server and an HTTP one through the same code path.
 */

import { spawn, ChildProcess } from "node:child_process";
import { Era } from "./cassette.js";
import {
  isResponse,
  JsonRpcFrame,
  JsonRpcRequest,
  JsonRpcResponse,
  LineBuffer,
  parseFrame,
  serializeFrame,
} from "./jsonrpc.js";

/**
 * A non-2xx HTTP answer. The body is kept because era detection turns on it:
 * a 400 carrying a modern JSON-RPC error means "modern server, correct the
 * request", while a 400 carrying anything else means "fall back to legacy".
 */
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly frame?: JsonRpcResponse
  ) {
    // The status alone says a request was refused but never why. A modern
    // refusal carries its reason in the body (-32020 names the header it
    // disagreed with), and that sentence is the one a caller can act on, so it
    // travels in the message every reporter already prints.
    const rpc = frame?.error ? ` (${frame.error.code}: ${frame.error.message})` : "";
    super(`HTTP ${status} from server${rpc}`);
  }
}

export interface Transport {
  /** Send a request and resolve with its response, or reject on timeout. */
  request(frame: JsonRpcRequest, timeoutMs: number): Promise<JsonRpcResponse>;
  /** Send a notification. No response is expected; HTTP servers answer 202. */
  notify(frame: JsonRpcFrame, timeoutMs: number): Promise<void>;
  /** The negotiated protocol version, once the handshake has one. stdio ignores it. */
  setProtocolVersion(version: string): void;
  /** The era the wire speaks. Only HTTP changes shape between eras. */
  setEra(era: Era): void;
  /**
   * The tool parameters to mirror into `Mcp-Param-*`, as the latest
   * `tools/list` declared them. stdio ignores them, and so does a wire that
   * does not mirror at all.
   */
  setHeaderParams(byTool: HeaderParams): void;
  /**
   * Whether this wire mirrors tool parameters into headers at all: Streamable
   * HTTP in the modern era, and nothing else. It decides whether MiniClient
   * owes a `tools/list` before a `tools/call`, and whether a tool whose
   * declarations are invalid has to be withheld.
   */
  readonly mirrorsHeaderParams: boolean;
  /**
   * Every frame of the last answer, when it arrived as a stream; undefined
   * when it was plain JSON. MiniClient's own callers want the answer and
   * nothing else, but a passthrough recording has to write down what actually
   * crossed the wire, notifications included (§1.3).
   */
  readonly lastStream?: JsonRpcFrame[];
  close(): Promise<void>;
}

// A header value may hold visible ASCII, space, and tab, but not lead or trail
// with whitespace (RFC 9110 § field values). Anything else, and any value that
// would be mistaken for the sentinel, travels Base64.
const HEADER_SAFE = /^[\x21-\x7e](?:[\x20\x09\x21-\x7e]*[\x21-\x7e])?$/;
const SENTINEL = /^=\?base64\?(.*)\?=$/;

/** Modern-era header values, per the spec's `=?base64?...?=` sentinel encoding. */
export function encodeHeaderValue(value: string): string {
  // The empty string is already a valid (empty) field value, and the spec's
  // conformance table spells that case out rather than the sentinel form.
  if (value === "") return "";
  return HEADER_SAFE.test(value) && !SENTINEL.test(value)
    ? value
    : `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/**
 * The value a header carries, undoing the sentinel. The markers are
 * case-sensitive and must bracket the whole value, so anything else is the
 * literal value it looks like. A body that is not valid Base64 decodes to
 * whatever Node makes of it rather than being refused: the spec puts that
 * refusal on a server, and the only reader here is replay, which compares and
 * warns (§3.3). Replay staying quiet is not evidence of a conformant encoder.
 */
export function decodeHeaderValue(value: string): string {
  const encoded = SENTINEL.exec(value);
  return encoded ? Buffer.from(encoded[1]!, "base64").toString("utf8") : value;
}

/**
 * The string a mirrored value becomes in a header, or undefined when the spec
 * says to leave the header out: a null or absent argument, and anything whose
 * type a valid `x-mcp-header` declaration could not have been put on.
 */
export function headerValueOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return undefined;
}

/** Session teardown is a courtesy, not a result, so it gets a short leash. */
const CLOSE_TIMEOUT_MS = 2000;

/** Methods whose `Mcp-Name` header mirrors a body field, and which field it is. */
const NAMED_METHODS: Record<string, "name" | "uri"> = {
  "tools/call": "name",
  "resources/read": "uri",
  "prompts/get": "name",
};

/** The body field a method's `Mcp-Name` mirrors, or undefined when it has none. */
export function namedBodyField(method: string): "name" | "uri" | undefined {
  return NAMED_METHODS[method];
}

/**
 * One tool parameter a server asked to be mirrored into a header. `name` is
 * the `{name}` of `Mcp-Param-{name}`; `path` is the chain of `properties` keys
 * from the `inputSchema` root, which is the exact place the value is read from
 * in the call arguments.
 */
export interface HeaderParam {
  name: string;
  path: readonly string[];
}

/** The header parameters of every tool that declared any, keyed by tool name. */
export type HeaderParams = ReadonlyMap<string, readonly HeaderParam[]>;

/**
 * Keywords whose value is an instance rather than a subschema. A tool that
 * gives a parameter a `default` or an `enum` holding an object with an
 * `x-mcp-header` key has declared nothing; walking into them would refuse the
 * tool over its own data.
 */
const INSTANCE_KEYWORDS = new Set(["const", "default", "enum", "examples"]);

/** RFC 9110 § 5.1 `1*tchar`: what a field name, and so an `x-mcp-header` value, may spell. */
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** The types a value may have to survive the trip through a header. `number` is not one. */
const PRIMITIVE_TYPES = new Set(["string", "integer", "boolean"]);

/** A nullable primitive is still a primitive: a null value leaves the header out. */
function isPrimitiveType(type: unknown): boolean {
  if (typeof type === "string") return PRIMITIVE_TYPES.has(type);
  if (!Array.isArray(type)) return false;
  return (
    type.some((t) => typeof t === "string" && PRIMITIVE_TYPES.has(t)) &&
    type.every((t) => typeof t === "string" && (PRIMITIVE_TYPES.has(t) || t === "null"))
  );
}

/** Why one `x-mcp-header` declaration is not usable, or undefined when it is. */
function declarationError(
  schema: Record<string, unknown>,
  path: readonly string[] | null,
  taken: Map<string, string>
): string | undefined {
  const declared = schema["x-mcp-header"];
  if (typeof declared !== "string" || declared.length === 0) {
    return "x-mcp-header must be a non-empty string";
  }
  if (!HEADER_TOKEN.test(declared)) {
    return `x-mcp-header "${declared}" is not an HTTP field-name token`;
  }
  if (!path) {
    return `x-mcp-header "${declared}" is not on a property reachable from the schema root through "properties" alone`;
  }
  const prior = taken.get(declared.toLowerCase());
  if (prior !== undefined) {
    return `x-mcp-header "${declared}" repeats "${prior}"; header names are case-insensitive`;
  }
  if (!isPrimitiveType(schema.type)) {
    return `x-mcp-header "${declared}" is on /${path.join("/")}, which is not a string, integer or boolean`;
  }
  return undefined;
}

/**
 * The `x-mcp-header` declarations of one tool's `inputSchema`: the parameters
 * to mirror, or the reason the tool as a whole is unusable.
 *
 * A declaration only counts where it is *statically reachable*, meaning the
 * walk from the schema root to it went through `properties` keys and nothing
 * else. An annotation under `items`, a composition or conditional keyword, or
 * a `$ref` has no single property path to read a value from, so the spec makes
 * it invalidate the tool rather than letting it be ignored quietly. The whole
 * schema is walked for exactly that reason: a stray annotation has to be found
 * to be refused.
 */
export function resolveHeaderParams(
  inputSchema: unknown
): { params: HeaderParam[] } | { invalid: string } {
  const params: HeaderParam[] = [];
  const taken = new Map<string, string>();
  let invalid: string | undefined;

  const visit = (node: unknown, path: readonly string[] | null): void => {
    if (invalid !== undefined || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, null);
      return;
    }
    const schema = node as Record<string, unknown>;
    if ("x-mcp-header" in schema) {
      const reason = declarationError(schema, path, taken);
      if (reason !== undefined) {
        invalid = reason;
        return;
      }
      const name = schema["x-mcp-header"] as string;
      taken.set(name.toLowerCase(), name);
      params.push({ name, path: path! });
    }
    for (const [key, value] of Object.entries(schema)) {
      if (INSTANCE_KEYWORDS.has(key)) continue;
      // A `properties` map holds property names, never keywords, so its values
      // are the schemas to walk. Reachable ones extend the path; the rest are
      // walked only to find an annotation that has to be refused.
      if (key !== "properties" || value === null || typeof value !== "object" || Array.isArray(value)) {
        visit(value, null);
        continue;
      }
      for (const [property, child] of Object.entries(value as Record<string, unknown>)) {
        visit(child, path ? [...path, property] : null);
      }
    }
  };

  visit(inputSchema, []);
  return invalid !== undefined ? { invalid } : { params };
}

/** The value at one declaration's property path, reading through plain objects only. */
function valueAt(args: unknown, path: readonly string[]): unknown {
  let node = args;
  for (const key of path) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** The `Mcp-Param-*` headers one call's arguments produce. */
export function headerParamHeaders(
  params: readonly HeaderParam[],
  args: unknown
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const param of params) {
    const value = headerValueOf(valueAt(args, param.path));
    if (value !== undefined) headers[`mcp-param-${param.name}`] = encodeHeaderValue(value);
  }
  return headers;
}

interface Pending {
  resolve: (res: JsonRpcResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** A server spawned as a child process, speaking newline-delimited JSON-RPC. */
export class StdioTransport implements Transport {
  private child: ChildProcess;
  private pending = new Map<string, Pending>();
  private buf = new LineBuffer();
  /** Set once the process has failed: later requests fail now rather than wait out a timeout. */
  private dead?: Error;

  constructor(command: string[]) {
    const [cmd, ...args] = command;
    if (!cmd) throw new Error("stdio target: empty command");
    this.child = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"] });
    this.child.on("error", (err) => {
      this.dead = new Error(`server process error: ${err.message}`);
      for (const p of this.pending.values()) {
        // Clear the timer too, or it keeps the event loop alive for the full
        // timeout after the process has already failed.
        clearTimeout(p.timer);
        p.reject(new Error(`server process error: ${err.message}`));
      }
      this.pending.clear();
    });
    this.child.stdout!.on("data", (chunk: Buffer) => {
      for (const line of this.buf.feed(chunk.toString("utf8"))) {
        const frame = parseFrame(line);
        if (frame && isResponse(frame)) this.settle(frame);
        // server-initiated requests/notifications are ignored by MiniClient
      }
    });
  }

  private settle(res: JsonRpcResponse): void {
    const key = String(res.id);
    const p = this.pending.get(key);
    if (!p) return;
    this.pending.delete(key);
    clearTimeout(p.timer);
    p.resolve(res);
  }

  request(frame: JsonRpcRequest, timeoutMs: number): Promise<JsonRpcResponse> {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(frame.id));
        reject(new Error(`timeout after ${timeoutMs}ms waiting for "${frame.method}"`));
      }, timeoutMs);
      this.pending.set(String(frame.id), { resolve, reject, timer });
      this.child.stdin!.write(serializeFrame(frame));
    });
  }

  async notify(frame: JsonRpcFrame): Promise<void> {
    this.child.stdin!.write(serializeFrame(frame));
  }

  /** stdio mirrors nothing into an envelope it does not have. */
  readonly mirrorsHeaderParams = false;

  setProtocolVersion(): void {
    // stdio carries the negotiated version in the handshake, not per message.
  }

  setEra(): void {
    // stdio frames are identical in both eras; only the lifecycle differs.
  }

  setHeaderParams(): void {
    // There is no header to mirror a parameter into.
  }

  async close(): Promise<void> {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    this.child.stdin?.end();
    const child = this.child;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2000);
      child.on("close", () => {
        clearTimeout(t);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }
}

/**
 * Streamable HTTP. Owns header assembly (`Accept`, `MCP-Protocol-Version`,
 * and the session id the server minted) and accepts either a JSON body or an
 * SSE stream as the answer. SSE is buffered whole here: MiniClient's consumers
 * need answers, not pacing (recorded pacing is a cassette concern).
 */
export class HttpTransport implements Transport {
  /** Frames of the last streamed answer; undefined when the answer was plain JSON. */
  lastStream?: JsonRpcFrame[];
  private sessionId?: string;
  private protocolVersion?: string;
  private era: Era = "legacy";
  private headerParams: HeaderParams = new Map();

  constructor(
    private url: string,
    private extraHeaders: Record<string, string> = {}
  ) {}

  async request(frame: JsonRpcRequest, timeoutMs: number): Promise<JsonRpcResponse> {
    const response = await this.send(frame, timeoutMs);
    if (!response) throw new Error(`HTTP transport returned no body for "${frame.method}"`);
    return response;
  }

  async notify(frame: JsonRpcFrame, timeoutMs: number): Promise<void> {
    await this.send(frame, timeoutMs).catch(() => undefined); // 202, no body expected
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  setEra(era: Era): void {
    this.era = era;
  }

  setHeaderParams(byTool: HeaderParams): void {
    this.headerParams = byTool;
  }

  /** The legacy era has no `Mcp-Param-*`; mirroring there would be an invention. */
  get mirrorsHeaderParams(): boolean {
    return this.era === "modern";
  }

  /**
   * The modern era mirrors body fields into headers so intermediaries can route
   * without parsing the body; a server rejects any mismatch with -32020, so
   * these are derived from the frame rather than passed in alongside it.
   */
  private metadataHeaders(frame: JsonRpcFrame): Record<string, string> {
    if (this.era !== "modern" || isResponse(frame)) return {};
    const headers: Record<string, string> = { "mcp-method": frame.method };
    const params = frame.params as Record<string, unknown> | undefined;
    const field = NAMED_METHODS[frame.method];
    const value = field ? params?.[field] : undefined;
    if (typeof value === "string") headers["mcp-name"] = encodeHeaderValue(value);
    // Only a `tools/call` carries custom parameters, and only for a tool whose
    // `inputSchema` asked for them: a tool nobody listed is called plainly,
    // which is what the spec tells a client with no schema in hand to do.
    if (frame.method === "tools/call" && typeof params?.name === "string") {
      const declared = this.headerParams.get(params.name);
      if (declared) Object.assign(headers, headerParamHeaders(declared, params.arguments));
    }
    return headers;
  }

  private async send(frame: JsonRpcFrame, timeoutMs: number): Promise<JsonRpcResponse | null> {
    this.lastStream = undefined; // it describes the answer we are about to get, not the last one
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...this.metadataHeaders(frame),
      ...this.extraHeaders,
    };
    // Sessions exist in the legacy era only; the modern era removed them.
    if (this.sessionId && this.era === "legacy") headers["mcp-session-id"] = this.sessionId;
    if (this.protocolVersion) headers["mcp-protocol-version"] = this.protocolVersion;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(frame),
        signal: ctrl.signal,
      });
      const sid = res.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;
      if (res.status === 202) return null;
      const ct = res.headers.get("content-type") ?? "";
      const text = await res.text();
      if (!res.ok) {
        const parsed = parseFrame(text);
        throw new HttpStatusError(res.status, parsed && isResponse(parsed) ? parsed : undefined);
      }
      if (ct.includes("application/json")) {
        return JSON.parse(text) as JsonRpcResponse;
      }
      if (ct.includes("text/event-stream")) {
        // Keep every frame, not just the answer: a passthrough recording of a
        // streamed answer is a `chunks` entry, and that is all of them.
        const frames: JsonRpcFrame[] = [];
        let answer: JsonRpcResponse | undefined;
        for (const line of text.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const parsed = parseFrame(line.slice(5));
          if (!parsed) continue;
          frames.push(parsed);
          if (isResponse(parsed) && "id" in frame && String(parsed.id) === String((frame as JsonRpcRequest).id)) {
            answer ??= parsed;
          }
        }
        this.lastStream = frames;
        if (answer) return answer;
        throw new Error("no matching response found in SSE stream");
      }
      throw new Error(`unexpected content-type: ${ct}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    // Best-effort courtesy to the server, bounded: a hung DELETE must not hold
    // the process open after the work is done.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CLOSE_TIMEOUT_MS);
    try {
      await fetch(this.url, {
        method: "DELETE",
        headers: { "mcp-session-id": this.sessionId },
        signal: ctrl.signal,
      }).catch(() => undefined);
    } finally {
      clearTimeout(timer);
    }
  }
}
