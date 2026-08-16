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
    super(`HTTP ${status} from server`);
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
const SENTINEL = /^=\?base64\?.*\?=$/;

/** Modern-era header values, per the spec's `=?base64?...?=` sentinel encoding. */
export function encodeHeaderValue(value: string): string {
  return HEADER_SAFE.test(value) && !SENTINEL.test(value)
    ? value
    : `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** Session teardown is a courtesy, not a result, so it gets a short leash. */
const CLOSE_TIMEOUT_MS = 2000;

/** Methods whose `Mcp-Name` header mirrors a body field, and which field it is. */
const NAMED_METHODS: Record<string, "name" | "uri"> = {
  "tools/call": "name",
  "resources/read": "uri",
  "prompts/get": "name",
};

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

  setProtocolVersion(): void {
    // stdio carries the negotiated version in the handshake, not per message.
  }

  setEra(): void {
    // stdio frames are identical in both eras; only the lifecycle differs.
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

  /**
   * The modern era mirrors body fields into headers so intermediaries can route
   * without parsing the body; a server rejects any mismatch with -32020, so
   * these are derived from the frame rather than passed in alongside it.
   */
  private metadataHeaders(frame: JsonRpcFrame): Record<string, string> {
    if (this.era !== "modern" || isResponse(frame)) return {};
    const headers: Record<string, string> = { "mcp-method": frame.method };
    const field = NAMED_METHODS[frame.method];
    const value = field ? (frame.params as Record<string, unknown> | undefined)?.[field] : undefined;
    if (typeof value === "string") headers["mcp-name"] = encodeHeaderValue(value);
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
