/**
 * `mcp-cassette replay <cassette> --listen 127.0.0.1:6402`
 *
 * The v1 matching engine behind an HTTP front-end, exactly as the stdio
 * replayer is that engine behind a stdio front-end (§3.1). `fingerprint`,
 * `buildReplayIndex`, `matchResponse`, and `diagnoseMiss` operate on JSON-RPC
 * request frames, which makes them transport-independent; they are used here
 * unchanged. What this file adds is only the HTTP shape of an answer: status,
 * content type, the method matrix of §3.2, and the session id the era decides
 * whether to mint.
 *
 * Two rules from the design are worth restating where they are implemented.
 * The era comes from the cassette header and is never guessed from frames
 * (§4.3). And replay is a deterministic test double, not a conformance
 * checker (§3.3): a missing session id or a mismatched `Mcp-Method` earns a
 * warning on stderr and a correct answer, never a 400. Checking the client
 * against a real server is `verify`'s job.
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { cassetteEra, readCassette, type Cassette, type ChunksEntry, type Era, type StreamChunk } from "./cassette.js";
import {
  isRequest,
  isResponse,
  parseFrame,
  type JsonRpcFrame,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./jsonrpc.js";
import { bindFailure, isLocalOrigin, parseListen, warnIfExposed, DEFAULT_LISTEN } from "./proxy.js";
import { buildReplayIndex, diagnoseMiss, fingerprint, matchResponse, missError, type OnMissMode } from "./replay.js";
import { redactFrame } from "./redact.js";

/** "none" (default) emits chunks back to back; "recorded" honors the offsets the recorder stamped. */
export type Timing = "none" | "recorded";

export interface HttpReplayOptions {
  /** "host:port" to bind; defaults to 127.0.0.1:6402. */
  listen?: string;
  /** "error" (default) or "warn". Passthrough forwards over the live client and is not wired here yet. */
  onMiss?: OnMissMode;
  timing?: Timing;
}

export interface ReplayServer {
  url: string;
  /** Fingerprint misses so far — what decides the session's exit code. */
  misses(): number;
  close(): Promise<void>;
}

const warn = (message: string) => process.stderr.write(`mcp-cassette replay: ${message}\n`);

/**
 * Recorded statuses that were not derivable (§1.2), keyed by the very response
 * object the index hands back. The engine returns the frame it read from the
 * file, so object identity carries the status across without widening any
 * engine signature.
 */
function recordedStatuses(cassette: Cassette): Map<JsonRpcResponse, number> {
  const statuses = new Map<JsonRpcResponse, number>();
  for (const entry of cassette.entries) {
    if (entry.type === "frame" && entry.dir === "s2c" && entry.http) {
      statuses.set(entry.frame as JsonRpcResponse, entry.http.status);
    }
  }
  return statuses;
}

/**
 * Recorded streams, split the way they are served: answers to a request are
 * pooled by fingerprint and consumed exactly like the JSON ones, while the
 * legacy standalone GET stream answers nothing and belongs to the endpoint
 * rather than to any request (§1.3).
 */
function streamIndex(cassette: Cassette): {
  pools: Map<string, ChunksEntry[]>;
  recorded: Map<string, number>;
  standalone?: ChunksEntry;
} {
  const requests = new Map<string, JsonRpcRequest>();
  for (const entry of cassette.entries) {
    if (entry.type === "frame" && entry.dir === "c2s" && isRequest(entry.frame)) {
      requests.set(String(entry.frame.id), entry.frame);
    }
  }
  const pools = new Map<string, ChunksEntry[]>();
  let standalone: ChunksEntry | undefined;
  for (const entry of cassette.entries) {
    if (entry.type !== "chunks") continue;
    if (entry.id === undefined) {
      standalone ??= entry;
      continue;
    }
    const answered = requests.get(String(entry.id));
    if (!answered) continue;
    const fp = fingerprint(answered);
    if (!pools.has(fp)) pools.set(fp, []);
    pools.get(fp)!.push(entry);
  }
  const recorded = new Map<string, number>();
  for (const [fp, pool] of pools) recorded.set(fp, pool.length);
  return { pools, recorded, standalone };
}

/** §3.3: one `data:` line per frame, blank-line delimited. */
const sseLine = (frame: JsonRpcFrame) => `data: ${JSON.stringify(frame)}\n\n`;

/** What version the recording spoke: the legacy era states it in the initialize result, the modern era in `_meta`. */
function recordedProtocolVersion(cassette: Cassette): string | undefined {
  for (const entry of cassette.entries) {
    if (entry.type !== "frame") continue;
    const frame = entry.frame as {
      result?: { protocolVersion?: string };
      params?: { _meta?: Record<string, unknown> };
    };
    const stated = frame.result?.protocolVersion ?? frame.params?._meta?.["io.modelcontextprotocol/protocolVersion"];
    if (typeof stated === "string") return stated;
  }
  return undefined;
}

export async function startHttpReplay(cassettePath: string, opts: HttpReplayOptions = {}): Promise<ReplayServer> {
  const { host, port } = parseListen(opts.listen ?? DEFAULT_LISTEN);
  const cassette = readCassette(cassettePath);
  if (cassette.header.transport !== "http") {
    throw new Error(
      `replay --listen serves HTTP cassettes; ${cassettePath} was recorded over ${cassette.header.transport} — ` +
        `replay it without --listen to serve it on stdio`
    );
  }
  const era: Era = cassetteEra(cassette.header);
  const index = buildReplayIndex(cassette);
  const statuses = recordedStatuses(cassette);
  const streams = streamIndex(cassette);
  // The standalone stream is a legacy-era thing; the modern era removed GET entirely.
  const standalone = era === "legacy" ? streams.standalone : undefined;
  // Sessions exist in the legacy era only; the modern era removed them entirely.
  const sessioned = era === "legacy" && cassette.header.sessioned === true;
  const version = recordedProtocolVersion(cassette);
  const timing = opts.timing ?? "none";
  const streamCount = cassette.entries.filter((e) => e.type === "chunks").length;
  /** Streams currently being written. The session may end mid-emission; each one owns its close path. */
  const open = new Set<http.ServerResponse>();
  let sessionId: string | undefined;
  let misses = 0;

  /** RFC 9110: a 405 names what the resource does accept. */
  const allow = [standalone ? "GET" : "", "POST", sessioned ? "DELETE" : ""].filter(Boolean).join(", ");

  /**
   * Emit a recorded stream. `terminate` is the difference between the two kinds
   * of stream the design distinguishes: an answer to a request closes after its
   * final frame (the spec's "response SHOULD terminate the stream"), while the
   * standalone stream never ends on its own and is held open until the client
   * leaves or the session does.
   *
   * Chunks go out back to back unless `--timing recorded`, which spaces them by
   * the offsets the recorder stamped. Either way a client that walked away
   * stops the emission — the answer stays consumed, because un-consuming on
   * cancel is racy and §3.3 rejected it.
   */
  const emit = async (
    res: http.ServerResponse,
    chunks: StreamChunk[],
    options: { terminate: boolean; rekey?: JsonRpcId }
  ): Promise<void> => {
    open.add(res);
    // A stream paced by `--timing recorded` spends most of its life waiting. If
    // the client leaves during one of those waits, the wait itself is what keeps
    // the session from ending, so the departure cancels it rather than letting
    // it run down.
    const gone = new AbortController();
    res.on("close", () => {
      open.delete(res);
      gone.abort();
    });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    let previous = chunks[0]?.t ?? 0;
    for (const [i, chunk] of chunks.entries()) {
      if (timing === "recorded" && chunk.t > previous) {
        const waited = await sleep(chunk.t - previous, true, { signal: gone.signal }).catch(() => false);
        if (waited === false) return; // the client left while we were pacing
      }
      previous = chunk.t;
      if (res.writableEnded || res.destroyed) return; // the client left mid-write
      // Only the final response frame is re-keyed: everything before it is a
      // notification the client correlates by its own recorded fields.
      const last = i === chunks.length - 1;
      const frame = last && options.rekey !== undefined && isResponse(chunk.frame)
        ? { ...chunk.frame, id: options.rekey }
        : chunk.frame;
      res.write(sseLine(frame));
    }
    if (options.terminate && !res.writableEnded) res.end();
  };

  const send = (res: http.ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
    if (body === undefined) {
      res.writeHead(status, headers).end();
      return;
    }
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };

  /** §3.3: every one of these is a warning and a correct answer, never a 400. */
  const checkHeaders = (req: http.IncomingMessage, frame: JsonRpcRequest) => {
    const sent = req.headers["mcp-session-id"];
    if (sessioned && sessionId && sent !== sessionId) {
      warn(`"${frame.method}" arrived with session id ${sent ?? "absent"}, expected the minted one — answering anyway`);
    }
    const declared = req.headers["mcp-method"];
    if (era === "modern" && typeof declared === "string" && declared !== frame.method) {
      warn(`Mcp-Method "${declared}" does not match the body's "${frame.method}" — answering anyway`);
    }
    const spoken = req.headers["mcp-protocol-version"];
    if (version && typeof spoken === "string" && spoken !== version) {
      warn(`MCP-Protocol-Version "${spoken}" is not the recorded "${version}" — answering anyway`);
    }
  };

  /** §3.3: a fresh id per replay session. The recorded value was never written to the file, so there is nothing to reuse. */
  const mint = (frame: JsonRpcRequest): Record<string, string> => {
    if (!sessioned || frame.method !== "initialize") return {};
    sessionId ??= randomUUID();
    return { "mcp-session-id": sessionId };
  };

  const handlePost = (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => {
    const frame = parseFrame(body.toString("utf8"));
    if (!frame) {
      send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "replay: body is not a JSON-RPC frame" } });
      return;
    }
    if (!isRequest(frame)) {
      send(res, 202); // a notification is acknowledged, never answered
      return;
    }
    checkHeaders(req, frame);

    const recorded = matchResponse(index, frame);
    if (recorded) {
      // Recorded status, re-keyed to the id the client actually used.
      send(res, statuses.get(recorded) ?? 200, { ...recorded, id: frame.id }, mint(frame));
      return;
    }
    if (frame.method === "ping") {
      send(res, 200, { jsonrpc: "2.0", id: frame.id, result: {} }); // parity with the stdio front-end
      return;
    }
    const fp = fingerprint(index.redactRequests ? (redactFrame(frame) as JsonRpcRequest) : frame);
    const pool = streams.pools.get(fp);
    if (pool && pool.length > 0) {
      // Consumed exactly like a JSON answer, and before a byte goes out: the
      // client may disconnect mid-stream, and that must not hand the answer back.
      void emit(res, pool.shift()!.chunks, { terminate: true, rekey: frame.id });
      return;
    }
    misses++;
    const diagnosis = streams.recorded.has(fp)
      ? `this request's answer was recorded as a stream ${streams.recorded.get(fp)} time(s), but every one ` +
        `was already replayed earlier in this session`
      : diagnoseMiss(index, frame);
    warn(`fingerprint miss for "${frame.method}" — ${diagnosis}`);
    // 200: the transport worked. The *protocol* answer is the error.
    send(res, 200, missError(frame, diagnosis));
  };

  return new Promise<ReplayServer>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const origin = req.headers.origin;
      if (origin && !isLocalOrigin(origin)) {
        res.writeHead(403).end();
        return;
      }
      if (req.method === "POST") {
        const body: Buffer[] = [];
        req.on("data", (c: Buffer) => body.push(c));
        req.on("end", () => handlePost(req, res, Buffer.concat(body)));
        return;
      }
      // The legacy standalone stream: recorded once, opened by GET, and held
      // open — it never answered a request, so it never completes one either.
      if (req.method === "GET" && standalone) {
        void emit(res, standalone.chunks, { terminate: false });
        return;
      }
      // A sessioned legacy cassette can end its session; everything else the
      // era forbids — the modern GET and DELETE included — is a 405.
      if (req.method === "DELETE" && sessioned) {
        sessionId = undefined;
        send(res, 200);
        return;
      }
      res.writeHead(405, { allow }).end();
    });

    server.on("error", (err: NodeJS.ErrnoException) => reject(bindFailure("replay", host, port, err)));
    server.listen(port, host, () => {
      warnIfExposed("replay", host);
      const bound = `http://${host}:${(server.address() as { port: number }).port}/`;
      warn(`serving ${cassettePath} as a ${era} server at ${bound}`);
      if (streamCount > 0) warn(`${streamCount} streamed answer(s) in the cassette`);
      resolve({
        url: bound,
        misses: () => misses,
        close: async () => {
          // A held-open stream is exactly the dangling socket that would keep the
          // process alive, so the session ends them itself rather than waiting on
          // connections built never to end. Ended gracefully, and awaited, so a
          // client reading one sees the stream finish rather than break.
          await Promise.all(
            [...open].map(
              (stream) =>
                new Promise<void>((done) => {
                  if (stream.destroyed || stream.writableEnded) return done();
                  stream.on("close", () => done());
                  stream.end();
                })
            )
          );
          await new Promise<void>((done) => {
            server.close(() => done());
            // A connection whose client aborted mid-response is neither active
            // nor idle by Node's reckoning, and `close` alone waits seconds for
            // it. Nothing is in flight worth preserving at session end.
            server.closeAllConnections();
          });
        },
      });
    });
  });
}

/** The CLI entry: serve until the operator stops us, then report and set the exit code. */
export async function runHttpReplay(cassettePath: string, opts: HttpReplayOptions = {}): Promise<void> {
  const server = await startHttpReplay(cassettePath, opts);
  await new Promise<void>((resolve) => {
    const stop = () => void server.close().then(resolve);
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, stop);
  });
  if (server.misses() > 0) warn(`${server.misses()} fingerprint miss(es) this session`);
  // error mode is the strict one: a session that missed is a failed session.
  process.exitCode = (opts.onMiss ?? "error") === "error" && server.misses() > 0 ? 1 : 0;
}
