/**
 * Transports — how a JSON-RPC frame reaches a server and how its answer comes
 * back. One job only: deliver a frame, return the response frame.
 *
 * Everything above this file (the lifecycle handshake, the request API,
 * pagination) lives in MiniClient and is transport-blind; everything below it
 * (process pipes, HTTP headers, SSE framing) lives here and is
 * lifecycle-blind. That split is what lets `check`, `snapshot`, and `verify`
 * speak to a stdio server and an HTTP one through the same code path.
 */

import { spawn, ChildProcess } from "node:child_process";
import {
  isResponse,
  JsonRpcFrame,
  JsonRpcRequest,
  JsonRpcResponse,
  LineBuffer,
  parseFrame,
  serializeFrame,
} from "./jsonrpc.js";

export interface Transport {
  /** Send a request and resolve with its response, or reject on timeout. */
  request(frame: JsonRpcRequest, timeoutMs: number): Promise<JsonRpcResponse>;
  /** Send a notification. No response is expected; HTTP servers answer 202. */
  notify(frame: JsonRpcFrame, timeoutMs: number): Promise<void>;
  /** The negotiated protocol version, once the handshake has one. stdio ignores it. */
  setProtocolVersion(version: string): void;
  close(): Promise<void>;
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

  constructor(command: string[]) {
    const [cmd, ...args] = command;
    if (!cmd) throw new Error("stdio target: empty command");
    this.child = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"] });
    this.child.on("error", (err) => {
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
 * Streamable HTTP. Owns header assembly — `Accept`, `MCP-Protocol-Version`,
 * and the session id the server minted — and accepts either a JSON body or an
 * SSE stream as the answer. SSE is buffered whole here: MiniClient's consumers
 * need answers, not pacing (recorded pacing is a cassette concern).
 */
export class HttpTransport implements Transport {
  private sessionId?: string;
  private protocolVersion?: string;

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

  private async send(frame: JsonRpcFrame, timeoutMs: number): Promise<JsonRpcResponse | null> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...this.extraHeaders,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
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
      if (!res.ok) throw new Error(`HTTP ${res.status} from server`);
      const ct = res.headers.get("content-type") ?? "";
      const text = await res.text();
      if (ct.includes("application/json")) {
        return JSON.parse(text) as JsonRpcResponse;
      }
      if (ct.includes("text/event-stream")) {
        for (const line of text.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const parsed = parseFrame(line.slice(5));
          if (parsed && isResponse(parsed) && "id" in frame && String(parsed.id) === String((frame as JsonRpcRequest).id)) {
            return parsed;
          }
        }
        throw new Error("no matching response found in SSE stream");
      }
      throw new Error(`unexpected content-type: ${ct}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    await fetch(this.url, {
      method: "DELETE",
      headers: { "mcp-session-id": this.sessionId },
    }).catch(() => undefined);
  }
}
