# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the major
version is `0`, a minor bump may carry a breaking change; each one says so
below.

## [0.2.0] — 2026-08-16

Record and replay a **Streamable HTTP** MCP session, in either lifecycle era.
Until now `mcp-cassette` spoke only stdio; this release makes the transport a
detail of the front-end and leaves the matching engine untouched underneath.

### Added

- **`record --http <url> [--listen <host:port>]`** — a reverse proxy that
  records an HTTP session. Requests are forwarded to the upstream verbatim and
  answers relayed back streaming, while frames are captured on the way through.
  It binds `127.0.0.1:6402` by default, refuses a taken port loudly instead of
  moving to a free one, and answers `403` to a non-local `Origin`.
- **SSE capture** — a streamed answer becomes a `chunks` entry holding every
  frame as it appeared on the wire. The parser follows WHATWG's event-stream
  algorithm and is incremental, so an event split across TCP reads is still one
  event. A stream still open when the session ends is flushed with what it
  showed.
- **`replay <cassette> --listen <host:port>`** — serves an HTTP cassette as a
  deterministic Streamable HTTP server. Recorded statuses are reproduced
  (including a non-default one like `400`), notifications get `202`, a legacy
  `sessioned` cassette mints a fresh session id per run and answers `DELETE`,
  and everything the recorded era forbids answers `405` with `Allow`.
- **SSE emission** — a recorded stream is replayed as SSE, one `data:` line per
  frame, closing after the final one; only that final frame is re-keyed to the
  incoming request id. A recorded legacy standalone `GET` stream is served and
  held open.
- **`--timing none|recorded`** — emit streamed frames back to back (default), or
  spaced by the offsets the recorder stamped.
- **`--on-miss passthrough` over HTTP** — a miss is forwarded to the real server
  and appended to the cassette as `origin:"live"`, including a `chunks` entry
  when the live answer streamed.
- **Dual-era support** — the classic `initialize` lifecycle and the stateless
  `2026-07-28` one. `check`, `snapshot`, and `verify` take `--era
  legacy|modern|auto`; `auto` probes modern-first over HTTP and legacy-first
  over stdio. When recording, the era is decided by the first *successful*
  exchange, so a dual-era client's failed probe is recorded honestly without
  deciding it.
- **`lint <cassette>`** — checks a cassette's header against its own frames
  (era and transport consistency) and exits 1 on any contradiction.
- **Cassette format v2** — adds `era`, `url`, `sessioned`, `transport:"http"`,
  `chunks[]` entries with `via`, and `http.status` on entries whose status was
  not derivable.

### Changed

- The recorder writes `cassetteVersion: 2` for every recording, stdio included.
- `src/client.ts` is split: transports live in `src/transport.ts`, and
  `MiniClient` keeps its public API while gaining an era strategy.

### Compatibility

- **v1 cassettes read forever.** A v1 file is interpreted as `transport:
  "stdio"`, `era: "legacy"`, entries unchanged.
- **v2 files are refused by 0.1.x** at the version gate, with a message saying
  the file was recorded by a newer `mcp-cassette`. That refusal is deliberate:
  0.1.x cannot replay HTTP or streamed answers, and a loud error beats a silent
  wrong replay. Teams pinned to 0.1.x keep their v1 cassettes.

## [0.1.2] — 2026-08-15

Sponsor button, a TS6059 build fix, and post-publish verification of the
released tarball.

## [0.1.1] — 2026-08-15

Packaging fixes for the first release.

## [0.1.0] — 2026-08-15

First public release: stdio record/replay, contract snapshots, safety checks,
secrets redaction, and the `verify` command.

[0.2.0]: https://github.com/ivermin1123/mcp-cassette/releases/tag/v0.2.0
[0.1.2]: https://github.com/ivermin1123/mcp-cassette/releases/tag/v0.1.2
[0.1.1]: https://github.com/ivermin1123/mcp-cassette/releases/tag/v0.1.1
[0.1.0]: https://github.com/ivermin1123/mcp-cassette/releases/tag/v0.1.0
