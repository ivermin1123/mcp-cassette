# HTTP record/replay and dual-era support — v0.3 design

Status: **accepted design, not implemented**. This document locks the design
for the two headline features of v0.3: (1) record/replay for the Streamable
HTTP transport, and (2) dual-era support — the classic lifecycle (protocol
revisions ≤ 2025-11-25) and the stateless lifecycle (revision 2026-07-28).
Every section states a decision and the alternatives that were considered and
rejected. Implementation follows the PR sequence in the last section.

Sources this design is grounded in (all read 2026-08-15):

- `docs/cassette-format-v2.md` — the v2 format sketch (era, `chunks[]`, state).
- `src/record.ts`, `src/replay.ts`, `src/client.ts`, `src/cassette.ts` — v1 behavior.
- [MCP 2025-11-25 — Transports (Streamable HTTP)](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP 2026-07-28 — Changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [MCP 2026-07-28 — Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)

## The two eras, in one table

The cassette header calls them `"legacy"` and `"modern"`, matching the v2
sketch. The differences that matter to a recorder/replayer:

| | `legacy` (≤ 2025-11-25) | `modern` (2026-07-28) |
|---|---|---|
| Handshake | `initialize` → `notifications/initialized` | none; every request carries `_meta` (`io.modelcontextprotocol/protocolVersion`, `…/clientCapabilities`, `…/clientInfo`) |
| Discovery | `initialize` result | `server/discover` RPC (servers MUST implement) |
| Sessions | server MAY mint `Mcp-Session-Id`; client MUST echo; DELETE ends it | removed entirely; GET/DELETE → 405 |
| Standalone server stream | HTTP GET opens SSE stream; server may send requests + notifications | removed; `subscriptions/listen` POST returns a long-lived SSE response stream (opted-in notifications only) |
| Server→client requests | allowed on SSE streams (sampling, elicitation, roots) | removed; MRTR — server returns `resultType: "input_required"` with `inputRequests`, client retries with `inputResponses` |
| SSE resumability | `Last-Event-ID` + SSE event ids | removed; broken stream ⇒ re-issue with a new request id |
| Required POST headers | `Accept`, `MCP-Protocol-Version` (after init) | `Accept`, `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` (for `tools/call`/`resources/read`/`prompts/get`), optional `Mcp-Param-*` |
| Header/body mismatch | n/a | HTTP 400 + JSON-RPC `-32020` `HeaderMismatch` |
| Version mismatch | negotiated in `initialize` | HTTP 400 + `-32022` `UnsupportedProtocolVersionError` listing `supported` |
| `ping` | exists | removed |
| Results | plain | required `resultType` (`"complete"` / `"input_required"`); missing ⇒ treat as `"complete"` |

## 1. Cassette format: what v2 adds for HTTP

The recording stays what v1 made it: an append-only JSONL transcript of
JSON-RPC frames, header first. HTTP adds exactly three things a stdio
transcript never needed: which transport/URL was recorded, HTTP status when it
is not derivable, and streamed (SSE) responses.

### 1.1 Header

```jsonc
{
  "type": "header",
  "cassetteVersion": 2,
  "recorder": "mcp-cassette@0.3.0",
  "startedAt": "2026-08-15T09:00:00Z",
  "transport": "http",                          // NEW value; "stdio" unchanged
  "url": "https://api.example.com/mcp",         // NEW; redacted like command args
  "era": "legacy",                              // per the v2 sketch; missing ⇒ "legacy"
  "sessioned": true,                            // NEW; legacy-era only: the recorded
                                                // server minted an Mcp-Session-Id
  "redaction": { "applied": true }
}
```

**Decision.** `cassetteVersion` bumps to 2 in the first v0.3 PR (the "one
version bump, once" rule from the v2 sketch — `era` is the first v2-only
field). The recorder always writes v2 from then on, for stdio recordings too.
Readers accept 1 and 2.

Rejected alternatives:

- *Keep writing v1 for stdio, v2 only for HTTP.* Two live writer formats,
  double the test matrix, and `era` is useful for stdio too (stdio servers
  will also move to the stateless lifecycle). One bump, one writer.
- *No version bump, ride everything on v1 as optional fields.* Violates the
  sketch's principle 5 and makes "what can this file contain?" unanswerable;
  an 0.1.x reader would silently mis-replay an HTTP cassette as stdio.

### 1.2 HTTP exchange representation

**Decision.** Frames stay the unit of record — no per-exchange envelope.
A simple JSON POST exchange is recorded exactly like stdio: one `c2s` frame
entry (the request or notification), one `s2c` frame entry (the response).
Correlation is by JSON-RPC id, as in v1. Entries gain one optional field:

```jsonc
{ "type": "frame", "t": 1204, "dir": "s2c", "frame": { /* JSON-RPC */ },
  "http": { "status": 400 } }   // only when the status is NOT the derivable default
```

Derivable defaults (not written): request → 200, notification → 202, SSE →
200. `http.status` is written only for deviations — the modern era makes some
JSON-RPC errors travel with meaningful HTTP statuses (`UnsupportedProtocolVersionError`
and `HeaderMismatch` on 400, unknown method on 404) and replay must reproduce
them faithfully.

HTTP request headers are **not** stored. Everything replay needs is already in
the body or the header line: `Mcp-Method`/`Mcp-Name` mirror body fields,
`MCP-Protocol-Version` mirrors `_meta`/the negotiated version, session ids are
minted fresh by replay (§3.3), and `Authorization` must never touch the file.

Rejected alternatives:

- *A new `exchange` entry type wrapping request+response+headers.* Breaks the
  flat frame stream that `replay`, `verify`, and `lint` all consume; every
  consumer would need two code paths. Frames + optional `http.status` carries
  the same information.
- *Store a redacted full header map per exchange.* All value it adds is
  secret-leak risk and diff noise; no consumer reads it. The one header fact
  replay needs beyond bodies — "did the server run sessions?" — is one boolean
  in the cassette header (`sessioned`).
- *Store the `Mcp-Session-Id` value (redacted).* The value is volatile per
  session and replay mints its own; storing even a placeholder invites
  fingerprinting on it. Presence (`sessioned`) is the only signal recorded.

### 1.3 SSE streams: `chunks[]`

An SSE response is recorded as the `chunks` entry the v2 sketch reserved,
firmed up as:

```jsonc
{
  "type": "chunks",
  "t": 1204,
  "dir": "s2c",
  "id": 7,                    // request id the stream answers; ABSENT for a
                              // legacy standalone GET stream
  "via": "post",              // "post" (default, may be omitted) | "get"
  "chunks": [
    { "t": 1204, "frame": { /* notifications/progress as it appeared */ } },
    { "t": 1290, "frame": { /* ... */ } },
    { "t": 1355, "frame": { /* final response; completes the request */ } }
  ]
}
```

- Each chunk stores the JSON-RPC frame **as it appeared on the wire** (after
  redaction) — transcript, not interpretation. `t` is the ms offset from
  session start, so replay can optionally honor recorded pacing.
- The legacy standalone GET stream is one `chunks` entry with no `id` and
  `via: "get"`. A modern `subscriptions/listen` stream is an ordinary
  `chunks` entry (it answers a real request id) — no special casing.
- Verify treats the final chunk of an id-bearing `chunks` entry as the
  response payload for diffing, and may compare chunk counts as a shape check
  (as sketched).
- SSE event ids, `retry` fields, and keep-alive comment lines are **not
  recorded**. Rejected because: the modern era deleted event ids and
  resumability outright; in the legacy era replaying someone else's event-id
  scheme would only matter for `Last-Event-ID` resumption, which is out of
  scope (§7 non-goals) — replay emits streams whole. Comment lines are
  defined by the SSE spec as data-free.

Backward-compatibility note: `chunks` is a new entry type, so an 0.1.x/0.2.x
reader refuses the file at the version gate with a clear error — which is the
correct failure, not a silent skip (those versions cannot replay HTTP at all).

## 2. Recording HTTP: a reverse proxy

### 2.1 Shape

```
mcp-cassette record -o out.cassette.jsonl --http https://api.example.com/mcp [--listen 127.0.0.1:6402]
```

The proxy exposes one local MCP endpoint; the client is pointed at
`http://127.0.0.1:6402/mcp`. Every request is forwarded to the upstream URL
essentially verbatim (body untouched; hop-by-hop headers stripped per RFC
9110; `Host` rewritten) and the response is relayed back streaming. Frames are
captured on the way through, redacted before writing — exactly the stdio
recorder's philosophy: record at the transport level, work with any SDK,
either era, because the proxy never interprets the session, it only observes
it.

Rejected alternatives:

- *An SDK-level recorder (wrap the official client/server SDK).* Ties
  recording to one SDK and one era; the transport-level proxy records any
  client against any server, including non-SDK ones — the property that made
  the stdio recorder universally applicable.
- *A forward (CONNECT/system) proxy that MITMs arbitrary traffic.* Requires
  installing a trust root and TLS interception; MCP clients universally accept
  a configurable server URL, so a reverse proxy achieves the same with none of
  the danger.

### 2.2 Bind address and port

**Decision.** Bind `127.0.0.1` only, default port `6402`, overridable with
`--listen host:port`. On "address in use" the recorder fails loudly and names
the owning process — it never silently increments to a free port (a
deterministic endpoint is part of the client's configuration). Non-localhost
binds require the user to type them explicitly (`--listen 0.0.0.0:…`), and the
recorder prints a warning when they do.

The proxy validates `Origin` on every request and answers 403 for a present,
non-local Origin — the DNS-rebinding protection the spec mandates for anything
listening on localhost.

Rejected: binding `0.0.0.0` by default (spec security warning, rebinding
risk); a random free port by default (breaks deterministic client config and
re-runnable test setups); a Unix domain socket (MCP clients expect an HTTP
URL).

### 2.3 Session and protocol-version headers

**Decision.** Forward both directions verbatim, live. `Mcp-Session-Id` minted
by the upstream flows back to the client untouched and is echoed by the client
through the proxy untouched — the proxy must not break live sessions.
`MCP-Protocol-Version` likewise. Into the *cassette*, per §1.2: session id
values are never written; the header records `sessioned: true` when the
upstream minted one; protocol version is already visible in the recorded
frames (`initialize` result in the legacy era, `_meta` in the modern era).

`Authorization` and all other unrecognized headers are forwarded verbatim and
never written to the cassette (allowlist model: nothing is stored unless this
design names it). This is stricter than redaction — a header that never
reaches the file cannot leak through a redaction gap.

### 2.4 TLS

**Decision.** Outbound TLS (proxy → `https://` upstream) is in scope and free:
Node's `fetch`/`undici` handles it; a private CA is supported via Node's
standard `NODE_EXTRA_CA_CERTS`. Inbound TLS (client → proxy over `https`) is
**out of scope for v0.3**: the proxy serves plain HTTP on localhost.

Rejected: terminating TLS locally with a generated cert — every client would
need to trust it (per-client trust-store surgery), for zero fidelity gain on a
loopback hop. Revisit only if a real client refuses `http://127.0.0.1`.

### 2.5 SSE capture

The proxy relays SSE responses byte-for-byte as they stream (with
`X-Accel-Buffering: no` preserved) while an incremental SSE parser splits
events on the side and appends a `chunks` entry per §1.3 when the stream ends.
A stream still open when the recording session ends is flushed as-is with the
chunks seen so far. Legacy-era GET streams are captured the same way into an
id-less `via: "get"` entry.

## 3. Replaying HTTP

### 3.1 Matching: reuse v1 wholesale

**Decision.** `fingerprint()`, `buildReplayIndex()`, `matchResponse()`, and
`diagnoseMiss()` are transport-independent — they operate on JSON-RPC request
frames — and are reused unchanged in shape. Two additive extensions:

- The index maps a fingerprint to a recorded *answer* that is now either a
  single response frame (v1) or a `chunks` sequence; the pool/fallback
  consumption logic is identical.
- No fingerprint change is needed for the modern era: per-request `_meta` is
  already stripped (`fingerprint()` deletes top-level `params._meta`, which is
  exactly where `io.modelcontextprotocol/*` keys live), and `tools/call`
  fingerprints on `name` + `arguments` only. This is a happy accident of v1's
  volatility rule; the design locks it in with tests rather than code.

A replayed HTTP server is therefore the existing engine behind an HTTP
front-end, exactly as the stdio replayer is the engine behind a stdio
front-end. `--on-miss error|warn|passthrough` carries over with identical
semantics; passthrough forwards through the era-aware MiniClient (§5) and
appends v2 entries (`origin: "live"`), including `chunks` entries when the
live answer streamed.

Rejected: fingerprinting on HTTP artifacts (path, headers, `Mcp-Name`) — they
duplicate body fields, and matching on bodies keeps stdio and HTTP cassettes
symmetrical (a future "replay a stdio cassette over HTTP" needs nothing new).

### 3.2 Serving shape

`mcp-cassette replay <cassette> --listen 127.0.0.1:6402` starts an HTTP server
when `header.transport === "http"` (same loud-failure port rules as §2.2, same
Origin check). Behavior by method, era-aware:

| Incoming | `legacy` cassette | `modern` cassette |
|---|---|---|
| POST request (matched, recorded JSON) | recorded status (default 200), `application/json`, recorded body re-keyed to incoming id | same |
| POST request (matched, recorded `chunks`) | 200, `text/event-stream`, chunks emitted in order, stream closes after final | same |
| POST notification | 202, empty | same |
| POST request (miss) | per `--on-miss`, JSON-RPC error body with near-miss diagnostics (status 200 — the transport worked; the *protocol* answer is the error) | same |
| GET | recorded `via:"get"` stream exists → 200 SSE, emit chunks, hold open; else 405 | 405 |
| DELETE | `sessioned` → 200 empty (session "terminated"); else 405 | 405 |

### 3.3 What must be faithful, what must not

Faithful (tests assert these):

- HTTP status per the table above, including recorded non-default statuses
  (`http.status`) — a client's 400-handling path (`UnsupportedProtocolVersionError`,
  `HeaderMismatch`) only gets exercised if replay reproduces the 400.
- `Content-Type` (`application/json` vs `text/event-stream`), 202-with-no-body
  for notifications, 405 for methods the era forbids.
- SSE framing: one `data:` line per chunk frame, blank-line delimited, final
  response chunk last, stream closed after it (the spec's "response SHOULD
  terminate the stream").
- Legacy sessions: if the cassette says `sessioned`, replay mints a fresh
  UUID, returns it on the `initialize` response, and accepts it thereafter.

Deliberately not faithful:

- The session id **value**, SSE event ids, `retry` fields, keep-alive
  comments, `Date`/`Server`/connection headers — all volatile, no client
  behavior worth testing depends on them.
- Chunk pacing: chunks are emitted back-to-back by default; `--timing
  recorded` replays the recorded `t` offsets for tests that need pacing.
- Strict header enforcement. Replay does **not** return 400 for a missing
  session id (legacy) or missing/mismatched `Mcp-Method`/`MCP-Protocol-Version`
  (modern). It warns on stderr instead. Rationale: replay is a deterministic
  test double — its job is answering, not conformance-testing the client;
  strictness there would couple test-suite health to header trivia. The
  conformance check against a real server is `verify`'s job. Rejected:
  `--strict-headers` flag — deferred until someone asks (scope discipline).
- Client disconnect mid-stream stops emission (modern-era cancellation
  semantics) but consumes the recorded answer either way — replay does not
  attempt "un-consume on cancel" (non-deterministic under races).

## 4. Era detection

Three distinct places need an era answer; they get three distinct mechanisms.

### 4.1 When recording (passive — the proxy decides from observed traffic)

The proxy cannot ask; it watches. **Rule:** era is decided by the first
*successful* lifecycle evidence, not by probes:

- an `initialize` request that receives a successful response ⇒ `legacy`;
- any other request receiving a successful response (in practice carrying
  `_meta["io.modelcontextprotocol/protocolVersion"]`, e.g. `server/discover`)
  ⇒ `modern`.

This is robust against dual-era clients that probe `server/discover`, get an
error from a legacy server, and fall back to `initialize`: the failed probe is
recorded as frames (transcript honesty) but does not decide the era.

Because the header line must carry `era` yet is the first line written, the
writer gains a **deferred-header mode**: entries buffer in memory until the
era is decided, then header + buffered entries flush and the file streams
append-only as before. If the session ends with no decision (no successful
exchange), `era` is omitted and readers apply the `legacy` default.

Rejected alternatives:

- *Rewrite the header in place at close.* Breaks append-only and `tail -f` of
  an in-progress recording; a crash mid-rewrite corrupts line 1.
- *Era in a trailer entry.* Readers would need to scan the whole file before
  knowing how to interpret it; violates header-first.
- *Decide from the first request regardless of outcome.* Misclassifies the
  probe-then-fallback traffic above.

### 4.2 When actively connecting (MiniClient: `check`, `snapshot`, `verify`, passthrough)

`--era legacy|modern|auto` on every command that dials a server; default
`auto`. Auto works per transport, following the spec's own compatibility
guidance:

- **HTTP: modern-first.** POST `server/discover` with full modern headers and
  `_meta`. A 2xx modern result ⇒ `modern` (and version selection from its
  `supported` list). A 400 whose body is a recognized modern JSON-RPC error
  (`-32020` HeaderMismatch, `-32021` MissingRequiredClientCapability,
  `-32022` UnsupportedProtocolVersion) ⇒ `modern` — correct and retry, do not
  fall back. Anything else (400/404/405 without a modern body, 200 with a
  legacy-style `-32601`, network-level SSE `endpoint` event, timeouts) ⇒ fall
  back to `initialize`; success ⇒ `legacy`. Both failing ⇒ report both
  failures verbatim.
- **stdio: legacy-first.** `initialize` first; only if it errors or times out,
  probe `server/discover`. Deployed stdio servers are overwhelmingly classic,
  and classic servers receiving an unknown pre-initialize request may log,
  error, or stall — probing them first buys hangs for no information. The
  asymmetry is deliberate and documented.

Rejected: sniffing capabilities from `tools/list` behavior (ambiguous);
requiring the user to always pass `--era` (hostile default; `auto` must work
for the 95% case).

### 4.3 When replaying (from the cassette, never guessed)

`era` comes from the header; missing ⇒ `legacy` (the v1 migration rule). The
replayer never sniffs frames to second-guess the header. `lint` gains a check
that flags era/frame inconsistency (e.g. `era: "modern"` with recorded
`initialize` traffic) so a hand-edited cassette fails loudly at lint time, not
confusingly at replay time.

## 5. MiniClient: split transport from lifecycle

`src/client.ts` currently interleaves three concerns: process/HTTP transport
mechanics, the classic handshake, and the request API. v0.3 splits it:

- **`src/transport.ts`** — `StdioTransport` and `HttpTransport` with one job:
  deliver a JSON-RPC frame, return the response frames (buffered SSE is
  acceptable here; MiniClient consumers need answers, not pacing).
  `HttpTransport` owns header assembly (`Accept`, `MCP-Protocol-Version`,
  session echo, and in modern mode `Mcp-Method`/`Mcp-Name` with the Base64
  sentinel encoding for non-header-safe values).
- **`src/client.ts`** — `MiniClient` keeps its public API (`connect`,
  `request`, `notify`, `listAll`, `close`) and gains an era strategy chosen by
  §4.2:
  - *legacy*: today's behavior — `initialize` handshake,
    `notifications/initialized`, session echo, negotiated version.
  - *modern*: no handshake; inject `_meta` (`protocolVersion`, `clientInfo`,
    `clientCapabilities`) into every request; `server/discover` supplies what
    `initialize` used to (serverInfo, capabilities, version) so `check` and
    `snapshot` render the same report for both eras; treat a missing
    `resultType` as `"complete"`; surface `resultType: "input_required"`
    (MRTR) as a structured error — `check`/`snapshot`/`verify` are
    non-interactive by design and cannot answer elicitation.

Rejected: a second `ModernClient` class (duplicates `listAll`, timeout, and
close logic; the API surface is identical, only the wire dialect differs);
teaching every consumer about eras (the strategy stays inside MiniClient —
`check.ts`, `snapshot.ts`, `verify.ts` pass `--era` through and otherwise do
not change).

## 6. Backward compatibility with v1 cassettes

The v2 sketch's principles are commitments; v0.3 implements them:

1. **v1 files read forever.** `readCassette` accepts versions 1 and 2. A v1
   file is interpreted as `transport: "stdio"`, `era: "legacy"`,
   entries unchanged. Every existing test fixture stays green byte-for-byte.
2. **Additive only.** No v1 field is renamed, removed, or re-typed. `origin:
   "live"` keeps riding as-is.
3. **Unknown is skippable** — with one deliberate boundary: unknown *entry
   types* are skipped with a warning by v2 readers (as implemented in
   `readCassette`), unknown *fields* ride along untouched because the reader
   never enumerates them, but a v2 *file* is refused by v1 readers at the
   version gate (already their behavior). That refusal is correct: an 0.1.x binary cannot replay HTTP or
   chunks, and a loud "recorded with a newer mcp-cassette" beats a silent
   wrong replay. Teams pinning 0.1.x simply keep their v1 cassettes.
4. **JSONL, append-only, header-first stays.** The deferred-header writer
   (§4.1) buffers before first flush but the resulting file is
   indistinguishable from one written eagerly.
5. **One version bump, once** — spent on `era` in PR 1; `chunks`, `http`,
   `url`, `sessioned`, `via` all ride the same bump.

## 7. Delivery plan: PR sequence for the implementing session

Ground rules for every PR: ≤ 400 changed lines (source + tests; split a PR
rather than blow the budget), conventional commit, no public-API break outside
the stated scope, CI green including the smoke job. Non-goals for all of
v0.3 (do not let scope creep in): inbound TLS, the 2024-11-05 HTTP+SSE
transport, `Last-Event-ID` resumability, interactive MRTR in MiniClient, the
tasks extension, scenario `state`/`seq` (separate v2 feature), recording
OAuth flows.

1. **`feat(cassette): format v2 — era, http fields, chunks`**
   `CASSETTE_VERSION = 2`; header `era`/`url`/`sessioned`/`transport:"http"`;
   `chunks` + `via` entry; `http.status` on entries; reader accepts {1,2};
   deferred-header writer mode.
   Tests: every existing v1 fixture still reads; era default `legacy`;
   unknown entry type skipped with warning; chunks round-trip via
   `writeCassette`; deferred writer produces header-first output; empty-session
   file omits era.
   Risk: old binaries refuse new files — release-note it; deferred buffer lost
   on hard crash before first flush (accepted: partial recordings were already
   unusable).
2. **`refactor(client): extract transport layer`** — pure refactor, zero
   behavior change; `transport.ts` with stdio/HTTP transports.
   Tests: existing check/snapshot/replay-passthrough suites unchanged and
   green; new unit tests per transport (timeout, 202, SSE response parse).
   Risk: subtle regression in process cleanup — keep the kill/timeout logic
   verbatim.
3. **`feat(client): modern era + auto-detection`** — `_meta` injection,
   `server/discover`, `Mcp-Method`/`Mcp-Name` + sentinel encoding, the §4.2
   probe matrix, `--era` flag on `check`/`snapshot`/`verify`.
   Tests (mock servers for both eras): full detection matrix — modern 2xx;
   400+`-32022` body; 400 empty body → fallback; 404 legacy; stdio
   legacy-first ordering; timeout fallback; version selection from
   `supported`; `resultType` missing ⇒ complete; `input_required` ⇒ structured
   error.
   Risk: misdetection against quirky servers — every probe outcome is logged
   on stderr so a wrong guess is diagnosable; hang risk bounded by probe
   timeout.
4. **`feat(record): HTTP reverse proxy (JSON exchanges)`** — `--http <url>`,
   `--listen`, verbatim forwarding with hop-by-hop stripping, Origin → 403,
   passive era detection, allowlist capture, redaction.
   Tests (e2e against stub upstreams, both eras): round-trip fidelity;
   `Authorization` and `Mcp-Session-Id` values never in the file (grep the
   raw file, not the parsed form); `sessioned` recorded; 202 forwarded;
   probe-then-fallback traffic classified `legacy`; port-in-use fails loudly.
   Risk: forwarding fidelity (streaming bodies, status passthrough) — assert
   byte equality client↔upstream in tests.
5. **`feat(record): SSE capture → chunks[]`** — incremental SSE parser,
   POST-SSE and legacy GET capture, keep-alive/comment/`retry` handling.
   Tests: multi-chunk with progress notifications before the response; events
   split across TCP reads; comment-only keep-alives ignored; GET stream
   captured id-less `via:"get"`; stream open at shutdown flushed.
   Risk: SSE parser edge cases — table-driven parser tests against the
   WHATWG examples.
6. **`feat(replay): HTTP server (JSON + lifecycle)`** — POST endpoint reusing
   the v1 engine; era table from §3.2; faithful statuses incl. `http.status`;
   session minting; `--on-miss error|warn`.
   Tests (MiniClient from PR 3 as the client, both eras): matched JSON;
   recorded-400 fidelity; 202; 405 matrix; fresh session minted ≠ recorded
   placeholder; miss diagnostics arrive over HTTP; lenient header warnings on
   stderr.
   Risk: status-fidelity drift — encode §3.2/§3.3 as a table-driven test.
7. **`feat(replay): SSE emission`** — chunks → SSE, close-after-final, GET /
   `subscriptions/listen` streams held open, `--timing recorded|none`,
   disconnect stops emission.
   Tests: streaming e2e (client consumes progress then result); stream closes
   after final chunk; listen stream stays open and delivers opted-in
   notifications; disconnect mid-stream stops writes and does not crash the
   session.
   Risk: dangling sockets keeping the process alive — every stream owns a
   close path, asserted with handle-leak checks in tests.
8. **`feat(replay): HTTP passthrough + docs`** — `--on-miss passthrough` over
   the era-aware MiniClient, appending v2 entries (`chunks` for streamed live
   answers); README + docs sweep; `lint` era/transport consistency checks;
   retire the "stateless support is coming" message in `client.ts`.
   Tests: miss forwards and appends re-keyed `live-N` pairs; redaction
   preserved on append; re-run of the appended cassette replays clean (the
   passthrough-idempotence property v1 already guarantees); lint flags a
   modern cassette containing `initialize`.
   Risk: append interleaving with concurrent serving — keep v1's synchronous
   append discipline.

Sequencing rationale: the format lands first because everything writes or
reads it; the client split (2–3) precedes record/replay because passthrough,
verify, and the replay tests all consume the era-aware MiniClient; record
(4–5) precedes replay (6–7) so replay tests run against genuinely recorded
fixtures rather than hand-built ones; SSE is split from JSON on both sides
because the parsers/emitters are the riskiest 400 lines and deserve their own
review.
