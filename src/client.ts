/**
 * MiniClient — a deliberately small MCP client used by `check`, `snapshot`,
 * and `verify`.
 *
 * Speaks the widely-deployed MCP lifecycle (initialize → notifications/initialized
 * → requests) and knows nothing about how frames travel: that is the
 * Transport's job (see transport.ts). Servers that only implement the
 * 2026-07-28 stateless lifecycle are detected and reported with a clear message
 * (full stateless support is on the roadmap).
 */

import { VERSION } from "./version.js";
import { JsonRpcFrame, JsonRpcRequest, JsonRpcResponse } from "./jsonrpc.js";
import { HttpTransport, StdioTransport, Transport } from "./transport.js";

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

/** The transport a target speaks. */
function createTransport(target: Target): Transport {
  return target.kind === "stdio"
    ? new StdioTransport(target.command)
    : new HttpTransport(target.url, target.headers);
}

export class MiniClient {
  private nextId = 1;
  readonly timeoutMs: number;

  private constructor(private transport: Transport, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  static async connect(target: Target, timeoutMs?: number): Promise<{ client: MiniClient; init: InitializeResult }> {
    const client = new MiniClient(createTransport(target), timeoutMs);
    try {
      const init = await client.initialize();
      return { client, init };
    } catch (err) {
      // A failed handshake must not leave the spawned server process behind.
      await client.close();
      throw err;
    }
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
    if (init.protocolVersion) this.transport.setProtocolVersion(init.protocolVersion);
    await this.notify("notifications/initialized");
    return init;
  }

  async request(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const frame: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: this.nextId++,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    return this.transport.request(frame, this.timeoutMs);
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const frame: JsonRpcFrame = { jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) };
    await this.transport.notify(frame, this.timeoutMs);
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
    await this.transport.close();
  }
}
