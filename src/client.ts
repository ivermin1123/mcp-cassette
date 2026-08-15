/**
 * MiniClient — a deliberately small MCP client used by `check` and `snapshot`.
 *
 * Speaks the widely-deployed MCP lifecycle (initialize → notifications/initialized
 * → requests) over stdio or Streamable HTTP. Servers that only implement the
 * 2026-07-28 stateless lifecycle are detected and reported with a clear message
 * (full stateless support is on the roadmap).
 */

import { spawn, ChildProcess } from "node:child_process";
import { VERSION } from "./version.js";
import {
  isResponse,
  JsonRpcFrame,
  JsonRpcRequest,
  JsonRpcResponse,
  LineBuffer,
  parseFrame,
  serializeFrame,
} from "./jsonrpc.js";

export interface ServerInfo {
  name?: string;
  version?: string;
}

export interface InitializeResult {
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
  serverInfo?: ServerInfo;
  instructions?: string;
}

export interface Tool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface StdioTarget {
  kind: "stdio";
  command: string[];
}

export interface HttpTarget {
  kind: "http";
  url: string;
  headers?: Record<string, string>;
}

export type Target = StdioTarget | HttpTarget;

const CLIENT_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT_MS = 15_000;

interface Pending {
  resolve: (res: JsonRpcResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class MiniClient {
  private child?: ChildProcess;
  private nextId = 1;
  private pending = new Map<string, Pending>();
  private buf = new LineBuffer();
  private sessionId?: string;
  private negotiatedVersion?: string;
  readonly timeoutMs: number;

  private constructor(private target: Target, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  static async connect(target: Target, timeoutMs?: number): Promise<{ client: MiniClient; init: InitializeResult }> {
    const client = new MiniClient(target, timeoutMs);
    if (target.kind === "stdio") client.spawnChild(target);
    const init = await client.initialize();
    return { client, init };
  }

  private spawnChild(target: StdioTarget): void {
    const [cmd, ...args] = target.command;
    if (!cmd) throw new Error("stdio target: empty command");
    this.child = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"] });
    this.child.on("error", (err) => {
      for (const p of this.pending.values()) p.reject(new Error(`server process error: ${err.message}`));
      this.pending.clear();
    });
    this.child.stdout!.on("data", (chunk: Buffer) => {
      for (const line of this.buf.feed(chunk.toString("utf8"))) {
        const frame = parseFrame(line);
        if (frame && isResponse(frame)) this.settle(frame);
        // v1: server-initiated requests/notifications are ignored by MiniClient
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

  private async initialize(): Promise<InitializeResult> {
    const res = await this.request("initialize", {
      protocolVersion: CLIENT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "mcp-cassette", version: VERSION },
    }).catch((err: Error) => {
      throw new Error(
        `initialize failed: ${err.message}. If this server only speaks the 2026-07-28 stateless lifecycle, ` +
          `stateless support is coming in mcp-cassette v0.2.`
      );
    });
    if (res.error) {
      throw new Error(`initialize returned error ${res.error.code}: ${res.error.message}`);
    }
    const init = (res.result ?? {}) as InitializeResult;
    this.negotiatedVersion = init.protocolVersion;
    await this.notify("notifications/initialized");
    return init;
  }

  async request(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const frame: JsonRpcRequest = { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };
    if (this.target.kind === "stdio") {
      return new Promise<JsonRpcResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(String(id));
          reject(new Error(`timeout after ${this.timeoutMs}ms waiting for "${method}"`));
        }, this.timeoutMs);
        this.pending.set(String(id), { resolve, reject, timer });
        this.child!.stdin!.write(serializeFrame(frame));
      });
    }
    return this.httpRequest(frame);
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const frame: JsonRpcFrame = { jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) };
    if (this.target.kind === "stdio") {
      this.child!.stdin!.write(serializeFrame(frame));
      return;
    }
    await this.httpSend(frame).catch(() => undefined); // notifications: 202, no body expected
  }

  /** Experimental Streamable HTTP support (classic lifecycle). */
  private async httpRequest(frame: JsonRpcRequest): Promise<JsonRpcResponse> {
    const response = await this.httpSend(frame);
    if (!response) throw new Error(`HTTP transport returned no body for "${frame.method}"`);
    return response;
  }

  private async httpSend(frame: JsonRpcFrame): Promise<JsonRpcResponse | null> {
    const target = this.target as HttpTarget;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(target.headers ?? {}),
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    if (this.negotiatedVersion) headers["mcp-protocol-version"] = this.negotiatedVersion;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(target.url, {
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

  /** Paginated list helper: tools/list, resources/list, prompts/list. */
  async listAll<T>(method: string, itemsKey: string): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const res = await this.request(method, cursor ? { cursor } : {});
      if (res.error) throw new Error(`${method} returned error ${res.error.code}: ${res.error.message}`);
      const result = (res.result ?? {}) as Record<string, unknown>;
      const pageItems = (result[itemsKey] ?? []) as T[];
      items.push(...pageItems);
      cursor = result.nextCursor as string | undefined;
      if (!cursor) break;
    }
    return items;
  }

  async close(): Promise<void> {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    if (this.child) {
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
    if (this.target.kind === "http" && this.sessionId) {
      await fetch((this.target as HttpTarget).url, {
        method: "DELETE",
        headers: { "mcp-session-id": this.sessionId },
      }).catch(() => undefined);
    }
  }
}
