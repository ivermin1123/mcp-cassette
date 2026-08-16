/**
 * `mcp-cassette record -o out.cassette.jsonl --http https://api.example.com/mcp`
 *
 * The stdio recorder's philosophy, over HTTP: a reverse proxy that forwards
 * every request to the upstream essentially verbatim and relays the answer
 * back, capturing JSON-RPC frames on the way through. It never interprets the
 * session, only observes it, which is why it records any client against any
 * server in either era.
 *
 * What reaches the cassette is deliberately narrower than what crosses the
 * wire: frames (redacted), and nothing else. Header *values* are never
 * written: an `Authorization` that never reaches the file cannot leak through
 * a gap in redaction. The one header fact replay needs is a boolean:
 * `sessioned`, meaning the upstream minted an `Mcp-Session-Id`.
 */

import http from "node:http";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { CassetteWriter, type Era, type StreamChunk } from "./cassette.js";
import { isRequest, isResponse, parseFrame, type JsonRpcFrame, type JsonRpcId } from "./jsonrpc.js";
import { ensureWritable, type RecordMode } from "./record.js";
import { redactFrame, redactString } from "./redact.js";
import { SseParser } from "./sse.js";

export const DEFAULT_LISTEN = "127.0.0.1:6402";

/** Stripped per RFC 9110: these describe the hop, not the message. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

/**
 * Response direction only: fetch has already decoded the body, so forwarding
 * the upstream's `content-encoding` would claim gzip over plaintext and a
 * strict client would fail to decode it. The request direction keeps its
 * encoding headers; that body is forwarded byte for byte.
 */
const RESPONSE_STRIP = new Set([...HOP_BY_HOP, "content-encoding"]);

export interface HttpRecordOptions {
  out: string;
  /** Upstream MCP endpoint. */
  url: string;
  /** "host:port" to bind; defaults to 127.0.0.1:6402. */
  listen?: string;
  redact?: boolean;
  mode?: RecordMode;
}

export function parseListen(listen: string): { host: string; port: number } {
  const at = listen.lastIndexOf(":");
  const host = at === -1 ? "127.0.0.1" : listen.slice(0, at) || "127.0.0.1";
  const port = Number(at === -1 ? listen : listen.slice(at + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`record: --listen expects host:port (got "${listen}")`);
  }
  return { host, port };
}

/** Loopback only. A present, non-local Origin is the DNS-rebinding case the spec warns about. */
export function isLocalOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/** Best effort: who is already holding the port, so the failure names a culprit. */
function portHolder(port: number): string {
  try {
    const pid = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).trim().split("\n")[0];
    if (!pid) return "unknown process";
    const cmd = execFileSync("ps", ["-p", pid, "-o", "command="], { encoding: "utf8" }).trim();
    return `pid ${pid} (${cmd})`;
  } catch {
    return "unknown process";
  }
}

/**
 * The loud bind failure §2.2 mandates, because a deterministic endpoint is part of the
 * client's configuration, so a taken port names its holder and stops, it never
 * hops to a free one. Replay binds under the same rule (§3.2), hence the
 * caller-supplied command name.
 */
export function bindFailure(command: string, host: string, port: number, err: NodeJS.ErrnoException): Error {
  return err.code === "EADDRINUSE"
    ? new Error(`${command}: ${host}:${port} is already in use by ${portHolder(port)}. Stop it or pass --listen`)
    : new Error(`${command}: could not listen on ${host}:${port}: ${err.message}`);
}

/** Non-loopback binds are reachable beyond this machine; the operator typed it, but should hear it. */
export function warnIfExposed(command: string, host: string): void {
  if (host !== "127.0.0.1" && host !== "localhost") {
    process.stderr.write(`mcp-cassette ${command}: WARNING listening on ${host}: reachable beyond this machine\n`);
  }
}

/** A running proxy: the address the client should be pointed at, and a way to stop it. */
export interface RecordingProxy {
  url: string;
  close(): Promise<void>;
}

/** Start the proxy and return once it is listening. `runHttpRecord` is this plus a signal wait. */
// `async` so a synchronous refusal (mode once, bad --listen) reaches the caller
// as a rejection like every other failure here, not as a throw at call time.
export async function startHttpRecord(opts: HttpRecordOptions): Promise<RecordingProxy> {
  const { host, port } = parseListen(opts.listen ?? DEFAULT_LISTEN);
  ensureWritable(opts.out, opts.mode ?? "once");
  const redact = opts.redact !== false;
  const writer = new CassetteWriter(opts.out, undefined, { applied: redact }, {
    transport: "http",
    url: redact ? redactString(opts.url) : opts.url,
    deferHeader: true,
  });

  let eraDecided = false;
  /** Streams still open. The session may end before they do; then they are flushed as-is (§2.5). */
  const live = new Set<{ flush(): void; close(): void }>();
  const capture = (dir: "c2s" | "s2c", frame: JsonRpcFrame, status?: number) => {
    writer.frame(dir, redact ? (redactFrame(frame) as JsonRpcFrame) : frame, status ? { status } : undefined);
  };
  /**
   * §4.1: the first *successful* exchange decides, never a probe; success is
   * the whole test, not whether the method was a lifecycle one. A
   * dual-era client that tries `server/discover`, gets an error, and falls back
   * to `initialize` is recorded honestly and still classified legacy.
   */
  const decideEra = (method: string | undefined, answered: JsonRpcFrame) => {
    if (eraDecided || !isResponse(answered) || answered.error !== undefined) return;
    eraDecided = true;
    const era: Era = method === "initialize" ? "legacy" : "modern";
    writer.setEra(era);
    process.stderr.write(`mcp-cassette: recording as ${era} (decided by "${method}")\n`);
  };

  return new Promise<RecordingProxy>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const origin = req.headers.origin;
      if (origin && !isLocalOrigin(origin)) {
        res.writeHead(403).end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        void forward(req, res, Buffer.concat(chunks)).catch((err: Error) => {
          if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: err.message } }));
          process.stderr.write(`mcp-cassette: upstream request failed: ${err.message}\n`);
        });
      });
    });

    async function forward(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer): Promise<void> {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (!HOP_BY_HOP.has(name) && typeof value === "string") headers[name] = value;
      }
      const sent = body.length > 0 ? parseFrame(body.toString("utf8")) : null;
      if (sent) capture("c2s", sent);

      const upstream = await fetch(opts.url, {
        method: req.method,
        headers,
        ...(body.length > 0 ? { body } : {}),
      });

      const out: Record<string, string> = {};
      upstream.headers.forEach((value, name) => {
        if (!RESPONSE_STRIP.has(name)) out[name] = value;
      });
      // The session id flows back to the client untouched; only its existence
      // is recorded, and only while the header line can still take it.
      if (upstream.headers.get("mcp-session-id")) writer.markSessioned();

      const type = upstream.headers.get("content-type") ?? "";
      res.writeHead(upstream.status, out);
      // A POST stream answers the request that opened it; a GET stream is the
      // legacy standalone one and answers nothing (§1.3). Anything else, such
      // as a DELETE teardown, is relayed and never captured.
      const streamed = type.includes("text/event-stream") && upstream.body;
      if (streamed && (req.method === "POST" || req.method === "GET")) {
        const asked = sent && isRequest(sent) ? sent : null;
        await relayStream(upstream.body!, res, {
          id: asked?.id,
          method: asked?.method,
          via: req.method === "GET" ? "get" : "post",
        });
        return;
      }
      if (streamed || !upstream.body) {
        if (upstream.body) await new Promise((done) => Readable.fromWeb(upstream.body!).pipe(res).on("finish", done));
        else res.end();
        return;
      }
      const text = await upstream.text();
      res.end(text);

      const answered = parseFrame(text);
      if (!answered) return;
      // 200 for a request and 202 for a notification are derivable; anything
      // else is a deviation replay has to reproduce.
      const expected = sent && isRequest(sent) ? 200 : 202;
      capture("s2c", answered, upstream.status === expected ? undefined : upstream.status);
      decideEra(sent && isRequest(sent) ? sent.method : undefined, answered);
    }

    /**
     * §2.5: relay the stream byte for byte as it arrives, so the client sees the
     * upstream's own framing and pacing, `X-Accel-Buffering: no` included,
     * while an incremental parser splits events on the side. One `chunks` entry
     * lands when the stream ends, even if it carried no JSON-RPC at all: a
     * stream that happened is part of the transcript whether or not we
     * understood it.
     */
    async function relayStream(
      body: ReadableStream<Uint8Array>,
      res: http.ServerResponse,
      meta: { id?: JsonRpcId; method?: string; via: "post" | "get" }
    ): Promise<void> {
      const parser = new SseParser();
      const decoder = new TextDecoder();
      const seen: StreamChunk[] = [];
      const openedAt = writer.elapsed();
      const source = Readable.fromWeb(body);
      // SSE event ids, `retry`, and comment lines are parsed and dropped: §1.3
      // records frames and nothing else.
      const absorb = (events: { data: string }[]) => {
        for (const event of events) {
          const frame = parseFrame(event.data);
          if (frame) seen.push({ t: writer.elapsed(), frame: redact ? (redactFrame(frame) as JsonRpcFrame) : frame });
        }
      };
      let flushed = false;
      const entry = {
        /** The session is over: take what the stream showed, then let both ends go. */
        close() {
          entry.flush();
          if (!res.writableEnded) res.end();
          source.destroy();
        },
        flush() {
          if (flushed) return;
          flushed = true;
          live.delete(entry);
          absorb(parser.end());
          writer.chunks("s2c", seen, { t: openedAt, id: meta.id, via: meta.via });
          // §4.1 over SSE: a final response that arrives streamed is successful
          // evidence like any other. `decideEra` ignores everything that is not
          // a successful response, so offering it every frame is the same as
          // offering it the last one, and survives a trailing notification.
          if (meta.method) for (const chunk of seen) decideEra(meta.method, chunk.frame);
        },
      };
      live.add(entry);

      source.on("data", (buf: Buffer) => {
        if (!res.writableEnded) res.write(buf);
        absorb(parser.feed(decoder.decode(buf, { stream: true })));
      });
      // "close" covers the stream we destroy at shutdown as well as the one that
      // simply ended; either way this settles and the entry is written once.
      await new Promise<void>((settle) => {
        const done = () => settle();
        source.on("end", done).on("close", done).on("error", done);
      });
      entry.flush();
      if (!res.writableEnded) res.end();
    }

    server.on("error", (err: NodeJS.ErrnoException) => {
      const failure = bindFailure("record", host, port, err);
      // Discard rather than close: a startup that never happened must not leave
      // a header behind for the next `--mode once` run to trip over. Reject only
      // once the file has settled, so a caller that retries immediately sees the
      // final state and not a half-written one.
      void writer.discard().then(() => reject(failure));
    });

    server.listen(port, host, () => {
      warnIfExposed("record", host);
      const bound = `http://${host}:${(server.address() as { port: number }).port}/`;
      process.stderr.write(`mcp-cassette: recording ${bound} → ${opts.url}\n`);
      resolve({
        url: bound,
        close: () =>
          new Promise<void>((done) => {
            // A stream still open when the session ends is flushed with the
            // chunks it showed (§2.5), then closed at both ends; otherwise
            // `server.close` would wait forever for a connection that was
            // designed to last, and the upstream would hold one too.
            for (const stream of live) stream.close();
            server.close(() => void writer.close().then(done));
          }),
      });
    });
  });
}

/** The CLI entry: record until the operator stops us, then flush and exit. */
export async function runHttpRecord(opts: HttpRecordOptions): Promise<number> {
  const proxy = await startHttpRecord(opts);
  return new Promise<number>((resolve) => {
    const stop = () => void proxy.close().then(() => resolve(0));
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, stop);
  });
}
