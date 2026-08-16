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
import {
  buildReplayIndex,
  diagnoseMissReason,
  fingerprint,
  formatMiss,
  LiveAppender,
  matchResponse,
  missError,
  type MissEvent,
  type MissReason,
  type OnMissMode,
} from "./replay.js";
import { MiniClient, type Target } from "./client.js";
import { redactFrame } from "./redact.js";

/** "none" (default) emits chunks back to back; "recorded" honors the offsets the recorder stamped. */
export type Timing = "none" | "recorded";

export interface HttpReplayOptions {
  /** "host:port" to bind; defaults to 127.0.0.1:6402. */
  listen?: string;
  /** "error" (default), "warn", or "passthrough", which needs `serverCommand`. */
  onMiss?: OnMissMode;
  timing?: Timing;
  /** The real server to forward misses to, for `--on-miss passthrough`. */
  serverCommand?: string[];
}

export interface ReplayServer {
  url: string;
  /** Fingerprint misses so far: what decides the session's exit code. */
  misses(): number;
  /**
   * Take the misses recorded since the last call, and forget them. Unlike
   * `misses()` this is a drain, so a caller can attribute misses to one slice
   * of a session (a single test, typically) instead of to the whole run.
   */
  takeMisses(): MissEvent[];
  /** Interactions forwarded to the live server and appended, and how many forwards failed. */
  appended(): number;
  forwardFailures(): number;
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
  /** Standalone streams beyond the first. Only one endpoint exists to serve them from. */
  extraStandalone: number;
} {
  const requests = new Map<string, JsonRpcRequest>();
  for (const entry of cassette.entries) {
    if (entry.type === "frame" && entry.dir === "c2s" && isRequest(entry.frame)) {
      requests.set(String(entry.frame.id), entry.frame);
    }
  }
  const pools = new Map<string, ChunksEntry[]>();
  let standalone: ChunksEntry | undefined;
  let extraStandalone = 0;
  for (const entry of cassette.entries) {
    if (entry.type !== "chunks") continue;
    if (entry.id === undefined) {
      if (standalone) extraStandalone++;
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
  return { pools, recorded, standalone, extraStandalone };
}

/** §3.3: one `data:` line per frame, blank-line delimited. */
const sseLine = (frame: JsonRpcFrame) => `data: ${JSON.stringify(frame)}\n\n`;

/**
 * What version the recording spoke. The legacy era states it in the `initialize`
 * result and the modern era in each request's `_meta`, so only those two are
 * consulted: a `tools/call` result that happens to carry a `protocolVersion`
 * field of its own is the server's data, not the protocol's.
 */
function recordedProtocolVersion(cassette: Cassette): string | undefined {
  const answers = new Map<string, string>(); // request id -> method it asked
  for (const entry of cassette.entries) {
    if (entry.type !== "frame") continue;
    if (entry.dir === "c2s" && isRequest(entry.frame)) {
      answers.set(String(entry.frame.id), entry.frame.method);
      const meta = (entry.frame.params as { _meta?: Record<string, unknown> } | undefined)?._meta;
      const declared = meta?.["io.modelcontextprotocol/protocolVersion"];
      if (typeof declared === "string") return declared;
      continue;
    }
    const asked = answers.get(String((entry.frame as { id?: unknown }).id));
    if (asked !== "initialize" && asked !== "server/discover") continue;
    const stated = (entry.frame as { result?: { protocolVersion?: string } }).result?.protocolVersion;
    if (typeof stated === "string") return stated;
  }
  return undefined;
}

export async function startHttpReplay(cassettePath: string, opts: HttpReplayOptions = {}): Promise<ReplayServer> {
  const { host, port } = parseListen(opts.listen ?? DEFAULT_LISTEN);
  const cassette = readCassette(cassettePath);
  if (cassette.header.transport !== "http") {
    throw new Error(
      `replay --listen serves HTTP cassettes; ${cassettePath} was recorded over ${cassette.header.transport}. ` +
        `Replay it without --listen to serve it on stdio`
    );
  }
  const onMiss = opts.onMiss ?? "error";
  if (onMiss === "passthrough" && !opts.serverCommand?.length) {
    throw new Error(
      "replay --listen --on-miss passthrough needs the real server command: " +
        "mcp-cassette replay <cassette> --listen <host:port> --on-miss passthrough -- <server command...>"
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
  // Two separate things on purpose. `misses` is cumulative and decides the
  // session's exit code, so nothing may reset it. `missLog` is drainable: a
  // caller that wants to attribute misses to whatever it was doing at the time
  // (a single test, say) has to be able to take them and start clean.
  const missLog: MissEvent[] = [];
  let appended = 0;
  let forwardFailures = 0;
  // The spy machinery is v1's, unchanged: append synchronously to the file that
  // already exists, re-key each live pair to its own `live-N`.
  const spy = onMiss === "passthrough" ? new LiveAppender(cassettePath, cassette, index.redactRequests) : null;
  // Connecting is memoized including failure, so a broken command fails every
  // later miss fast instead of spawning one orphan process per miss.
  let livePromise: Promise<MiniClient> | null = null;
  /**
   * What follows `--`: a lone http(s) URL is a live HTTP endpoint, anything else
   * is a command to spawn. An HTTP cassette is usually recorded against an HTTP
   * server, and only an HTTP answer can stream, so a `chunks` append is
   * unreachable through a stdio target.
   */
  const liveTarget = (): Target => {
    const command = opts.serverCommand!;
    return command.length === 1 && /^https?:\/\//i.test(command[0]!)
      ? { kind: "http", url: command[0]! }
      : { kind: "stdio", command };
  };
  const connectLive = (): Promise<MiniClient> =>
    (livePromise ??= MiniClient.connect(liveTarget(), undefined, era).then((r) => r.client));

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
   * stops the emission; the answer stays consumed, because un-consuming on
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
      warn(`"${frame.method}" arrived with session id ${sent ?? "absent"}, expected the minted one; answering anyway`);
    }
    const declared = req.headers["mcp-method"];
    if (era === "modern" && typeof declared === "string" && declared !== frame.method) {
      warn(`Mcp-Method "${declared}" does not match the body's "${frame.method}"; answering anyway`);
    }
    const spoken = req.headers["mcp-protocol-version"];
    if (version && typeof spoken === "string" && spoken !== version) {
      warn(`MCP-Protocol-Version "${spoken}" is not the recorded "${version}"; answering anyway`);
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
    // A spent stream pool is a miss cause the stdio front-end cannot have, so
    // it is named here rather than inside the shared diagnosis.
    const reason: MissReason = streams.recorded.has(fp)
      ? { kind: "stream-exhausted", fingerprint: fp, recordedCount: streams.recorded.get(fp)! }
      : diagnoseMissReason(index, frame);
    missLog.push({ method: frame.method, request: frame, reason });
    const diagnosis = formatMiss(reason);
    warn(`fingerprint miss for "${frame.method}": ${diagnosis}`);
    if (spy) {
      void forwardMiss(res, frame);
      return;
    }
    // 200: the transport worked. The *protocol* answer is the error.
    send(res, 200, missError(frame, diagnosis));
  };

  /**
   * A miss becomes a live call, and the live call becomes cassette. The client
   * gets the answer in the shape the live server gave it (streamed answers stay
   * streamed) while the file gains the pair re-keyed to its own `live-N` id.
   */
  const forwardMiss = async (res: http.ServerResponse, frame: JsonRpcRequest): Promise<void> => {
    try {
      const client = await connectLive();
      const answer = await client.request(frame.method, frame.params);
      const streamed = client.lastStream;
      const liveId = spy!.nextId();
      spy!.frame("c2s", { ...frame, id: liveId });
      if (streamed && streamed.length > 0) {
        spy!.chunks(liveId, streamed.map((f) => (isResponse(f) ? { ...f, id: liveId } : f)));
      } else {
        spy!.frame("s2c", { ...answer, id: liveId });
      }
      appended++;
      if (streamed && streamed.length > 0) {
        await emit(res, streamed.map((f) => ({ t: 0, frame: f })), { terminate: true, rekey: frame.id });
        return;
      }
      send(res, 200, { ...answer, id: frame.id });
    } catch (err) {
      forwardFailures++;
      const message = `mcp-cassette replay: passthrough to live server failed: ${(err as Error).message}`;
      warn(message);
      send(res, 200, { jsonrpc: "2.0", id: frame.id, error: { code: -32603, message } });
    }
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
      // open: it never answered a request, so it never completes one either.
      if (req.method === "GET" && standalone) {
        void emit(res, standalone.chunks, { terminate: false });
        return;
      }
      // A sessioned legacy cassette can end its session; everything else the
      // era forbids, the modern GET and DELETE included, is a 405.
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
      // One GET endpoint, so one standalone stream. Serving the first is a
      // choice, not an accident, and a cassette with more should hear about it.
      if (standalone && streams.extraStandalone > 0) {
        warn(`${streams.extraStandalone + 1} standalone GET stream(s) recorded; only the first is served`);
      }
      resolve({
        url: bound,
        misses: () => misses,
        takeMisses: () => missLog.splice(0),
        appended: () => appended,
        forwardFailures: () => forwardFailures,
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
          const live = livePromise;
          if (live) await live.then((c) => c.close()).catch(() => undefined);
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
  const onMiss = opts.onMiss ?? "error";
  if (server.misses() > 0) {
    warn(
      onMiss === "passthrough"
        ? `${server.misses()} miss(es), ${server.appended()} interaction(s) appended to ${cassettePath} (origin:"live")` +
            (server.forwardFailures() > 0 ? `, ${server.forwardFailures()} forward(s) FAILED` : "")
        : `${server.misses()} fingerprint miss(es) this session`
    );
  }
  // error mode is the strict one: a session that missed is a failed session.
  // passthrough is clean only when every forward actually reached the server.
  process.exitCode =
    (onMiss === "error" && server.misses() > 0) || (onMiss === "passthrough" && server.forwardFailures() > 0) ? 1 : 0;
}
