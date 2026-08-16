/**
 * MiniClient — a deliberately small MCP client used by `check`, `snapshot`,
 * and `verify`.
 *
 * Speaks both eras and knows nothing about how frames travel — that is the
 * Transport's job (see transport.ts):
 *
 *   legacy (≤ 2025-11-25): initialize → notifications/initialized → requests.
 *   modern (2026-07-28):   no handshake; every request carries `_meta`, and
 *                          `server/discover` says what `initialize` used to.
 *
 * Which one a server speaks is answered by `--era`, or probed (§4.2 of the
 * v0.3 design): modern-first on HTTP, where a 400's body distinguishes the
 * eras; legacy-first on stdio, where probing a classic server with an unknown
 * pre-initialize request buys hangs for no information.
 */

import { VERSION } from "./version.js";
import { Era } from "./cassette.js";
import { JsonRpcFrame, JsonRpcRequest, JsonRpcResponse } from "./jsonrpc.js";
import { HttpStatusError, HttpTransport, StdioTransport, Transport } from "./transport.js";

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
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const DEFAULT_TIMEOUT_MS = 15_000;

/** `auto` probes; an explicit era skips the probe and its failure modes. */
export type EraOption = Era | "auto";

/** Error codes the modern era defines. Seeing one identifies the server as modern. */
const MODERN_ERROR_CODES = new Set([-32020, -32021, -32022]);
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

/** What `server/discover` answers with — the modern stand-in for `initialize`'s result. */
interface DiscoverResult {
  supportedVersions?: string[];
  capabilities?: Record<string, unknown>;
  instructions?: string;
  resultType?: string;
  _meta?: Record<string, unknown>;
}

/**
 * The server answered, in modern dialect, that it will not serve this request.
 * Distinct from a transport failure because it settles the era: a client that
 * sees one corrects its request instead of falling back to `initialize`.
 */
export class ModernServerError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

/**
 * MRTR: the server wants input (sampling, elicitation, roots) before it can
 * answer. `check`, `snapshot`, and `verify` are non-interactive by design, so
 * this surfaces as a structured error rather than a half-answer.
 */
export class InputRequiredError extends Error {
  constructor(
    readonly method: string,
    readonly inputRequests: unknown
  ) {
    super(`"${method}" needs client input (MRTR) — mcp-cassette runs non-interactively`);
  }
}

/** Probe outcomes go to stderr so a wrong era guess is diagnosable after the fact. */
function logProbe(message: string): void {
  process.stderr.write(`mcp-cassette: ${message}\n`);
}

function modernErrorOf(err: unknown): { code: number; message: string; data?: unknown } | undefined {
  const frame = err instanceof HttpStatusError ? err.frame : undefined;
  const error = frame?.error;
  return error && MODERN_ERROR_CODES.has(error.code) ? error : undefined;
}

/** The transport a target speaks. */
function createTransport(target: Target): Transport {
  return target.kind === "stdio"
    ? new StdioTransport(target.command)
    : new HttpTransport(target.url, target.headers);
}

export class MiniClient {
  private nextId = 1;
  private currentEra: Era = "legacy";
  private protocolVersion = MODERN_PROTOCOL_VERSION;
  readonly timeoutMs: number;

  private constructor(private transport: Transport, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  /** The era this connection settled on. */
  get era(): Era {
    return this.currentEra;
  }

  /**
   * Every frame of the last answer, when it streamed. Only a recorder cares:
   * a passthrough writing down a streamed answer owes the cassette all of it,
   * not just the response it handed back (§1.3).
   */
  get lastStream(): JsonRpcFrame[] | undefined {
    return this.transport.lastStream;
  }

  static async connect(
    target: Target,
    timeoutMs?: number,
    era: EraOption = "auto"
  ): Promise<{ client: MiniClient; init: InitializeResult }> {
    const client = new MiniClient(createTransport(target), timeoutMs);
    try {
      const init = await client.open(target.kind, era);
      return { client, init };
    } catch (err) {
      // A failed handshake must not leave the spawned server process behind.
      await client.close();
      throw err;
    }
  }

  private open(kind: Target["kind"], era: EraOption): Promise<InitializeResult> {
    if (era !== "auto") return era === "modern" ? this.discover() : this.initialize();
    // HTTP answers with a status whose body settles the era, so ask modern
    // first. stdio has no status to read and classic servers may stall on an
    // unknown pre-initialize request, so ask legacy first. §4.2.
    const first: Era = kind === "http" ? "modern" : "legacy";
    return this.probe(first).catch(async (firstErr: Error) => {
      // A recognized modern error already identified the server; correcting the
      // request is the answer, not falling back to the other era.
      if (firstErr instanceof ModernServerError) throw firstErr;
      const second: Era = first === "modern" ? "legacy" : "modern";
      logProbe(`${first} probe failed (${firstErr.message}) — trying ${second}`);
      return this.probe(second).catch((secondErr: Error) => {
        throw new Error(
          `server answered neither era — ${first}: ${firstErr.message}; ${second}: ${secondErr.message}`
        );
      });
    });
  }

  private async probe(era: Era): Promise<InitializeResult> {
    const init = await (era === "modern" ? this.discover() : this.initialize());
    logProbe(`connected as ${era} (protocol ${init.protocolVersion ?? "unstated"})`);
    return init;
  }

  private async initialize(): Promise<InitializeResult> {
    this.currentEra = "legacy";
    this.transport.setEra("legacy");
    const res = await this.request("initialize", {
      protocolVersion: CLIENT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "mcp-cassette", version: VERSION },
    }).catch((err: Error) => {
      throw new Error(`initialize failed: ${err.message}`);
    });
    if (res.error) {
      throw new Error(`initialize returned error ${res.error.code}: ${res.error.message}`);
    }
    const init = (res.result ?? {}) as InitializeResult;
    if (init.protocolVersion) this.transport.setProtocolVersion(init.protocolVersion);
    await this.notify("notifications/initialized");
    return init;
  }

  /** The modern opener: no handshake, one `server/discover` for identity and versions. */
  private async discover(): Promise<InitializeResult> {
    this.currentEra = "modern";
    this.transport.setEra("modern");
    this.useVersion(MODERN_PROTOCOL_VERSION);
    let res: JsonRpcResponse;
    try {
      res = await this.request("server/discover");
    } catch (err) {
      const modern = modernErrorOf(err);
      if (!modern) throw err; // not a modern answer — the caller may fall back
      if (modern.code !== UNSUPPORTED_PROTOCOL_VERSION) {
        throw new ModernServerError(modern.code, `server/discover rejected: ${modern.message}`);
      }
      const supported = (modern.data as { supported?: string[] } | undefined)?.supported ?? [];
      if (supported.length === 0) {
        throw new ModernServerError(modern.code, `${modern.message} (server named no supported version)`);
      }
      logProbe(`server rejected ${this.protocolVersion}; retrying at ${supported[0]}`);
      this.useVersion(supported[0]!);
      res = await this.request("server/discover");
    }
    if (res.error) {
      throw new Error(`server/discover returned error ${res.error.code}: ${res.error.message}`);
    }
    const result = (res.result ?? {}) as DiscoverResult;
    const versions = result.supportedVersions ?? [];
    if (versions.length > 0 && !versions.includes(this.protocolVersion)) {
      this.useVersion(versions[0]!);
    }
    return {
      protocolVersion: this.protocolVersion,
      capabilities: result.capabilities,
      serverInfo: result._meta?.["io.modelcontextprotocol/serverInfo"] as ServerInfo | undefined,
      instructions: result.instructions,
    };
  }

  /** Keep the version in `_meta` and the version in the header in lockstep — a mismatch is -32020. */
  private useVersion(version: string): void {
    this.protocolVersion = version;
    this.transport.setProtocolVersion(version);
  }

  /** Modern requests carry their version, identity, and capabilities per call. */
  private withMeta(params?: unknown): unknown {
    return {
      ...((params as Record<string, unknown> | undefined) ?? {}),
      _meta: {
        "io.modelcontextprotocol/protocolVersion": this.protocolVersion,
        "io.modelcontextprotocol/clientInfo": { name: "mcp-cassette", version: VERSION },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    };
  }

  async request(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const modern = this.currentEra === "modern";
    const body = modern ? this.withMeta(params) : params;
    const frame: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: this.nextId++,
      method,
      ...(body !== undefined ? { params: body } : {}),
    };
    const res = await this.transport.request(frame, this.timeoutMs);
    // A result without `resultType` is "complete" (the earlier-protocol rule);
    // only an explicit input_required interrupts.
    const result = res.result as { resultType?: string; inputRequests?: unknown } | undefined;
    if (result?.resultType === "input_required") {
      throw new InputRequiredError(method, result.inputRequests);
    }
    return res;
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
