/**
 * Minimal JSON-RPC 2.0 framing helpers for MCP's stdio transport
 * (newline-delimited JSON messages).
 */

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcFrame = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export function isRequest(f: JsonRpcFrame): f is JsonRpcRequest {
  return "method" in f && "id" in f && f.id !== undefined && f.id !== null;
}

export function isNotification(f: JsonRpcFrame): f is JsonRpcNotification {
  return "method" in f && !("id" in f && (f as JsonRpcRequest).id !== undefined);
}

export function isResponse(f: JsonRpcFrame): f is JsonRpcResponse {
  return !("method" in f) && "id" in f;
}

/** Parse one line into a frame; returns null if it is not valid JSON-RPC. */
export function parseFrame(line: string): JsonRpcFrame | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj === "object" && obj.jsonrpc === "2.0") {
      return obj as JsonRpcFrame;
    }
    return null;
  } catch {
    return null;
  }
}

export function serializeFrame(frame: JsonRpcFrame): string {
  return JSON.stringify(frame) + "\n";
}

/**
 * Buffers incoming stream chunks and emits complete lines.
 * Handles frames split across chunks and multiple frames per chunk.
 */
export class LineBuffer {
  private buffer = "";

  /** Feed a chunk; returns the complete lines it produced. */
  feed(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      lines.push(this.buffer.slice(0, idx));
      this.buffer = this.buffer.slice(idx + 1);
    }
    return lines;
  }

  /** Remaining partial content (no trailing newline seen yet). */
  flush(): string {
    const rest = this.buffer;
    this.buffer = "";
    return rest;
  }
}

/** Deterministic JSON stringify with recursively sorted object keys. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
