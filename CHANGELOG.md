# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the major
version is `0`, a minor bump may carry a breaking change; each one says so
below.

## [Unreleased]

### BREAKING

- `snapshot --check` now walks nested schemas. Previously the conservative
  fallback asked whether the *whole tool* had produced any finding, so a single
  `minor` at the root swallowed every breaking change underneath it. A tool
  that exists to catch silent contract drift was producing silent contract
  drift. The fallback is now per node. **This can turn a previously green build
  red without anyone changing their server**, in exactly the cases where it
  should have been red already. `--fail-on` remains the release valve.

### Fixed

- Reordering `required`, `enum`, or a union `type` is no longer reported as a
  breaking change. Order carries no meaning in JSON Schema; three of these were
  reported as breaking before, and one of them (`["string","null"]` becoming
  `["null","string"]`) carried a specific rule ID, which read as an authoritative
  finding about a change that binds nobody.
- `additionalProperties` absent, `{}` and `true` are recognised as three
  spellings of one thing.
- A reworded `description`, `title`, `$comment` or `examples` now reports as
  `input-annotation-changed` at `info` instead of landing in the
  conservative-breaking bucket. Editing prose was turning consumers' CI red.

### Added

- `input-schema-ref-unclassified` (breaking). Reference resolution is not
  implemented, so when a changed schema contains `$ref` the diff says that
  plainly rather than emitting a specific rule ID about a shape it never
  resolved.

### Note

Schema-diff work stops here. The remaining families are cancelled, not deferred:
`additionalProperties` tiers, array cardinality, `anyOf`/`oneOf`/`allOf`,
constraint direction, nullability, and `outputSchema`. The reasoning is
in [`docs/research/01-reality-check.md`](docs/research/01-reality-check.md).

## [0.3.0] - 2026-08-16

Testing and safety. A first-party `vitest` adapter so a suite can talk to a
cassette instead of a server, and a safety lint that doubled in size, cites the
standard behind every rule, and can hand its findings to GitHub code scanning.

This is a minor bump rather than a patch for one reason: two of the changes
below can turn a previously green build red without anyone changing their
server. Nobody should meet those by way of `^0.2.0` resolving on its own.

### BREAKING

- **Deep imports into the package are closed.** `mcp-cassette` now declares an
  `exports` map with exactly three entries: `.`, `./vitest`, and
  `./package.json`.

  *What you see:* `import ... from "mcp-cassette/dist/replay.js"` fails with
  `ERR_PACKAGE_PATH_NOT_EXPORTED`.

  *What to do:* import from `mcp-cassette`. The public API re-exports the
  engine, and the surface has only grown. If something you relied on is not
  reachable from the entry point, open an issue and it gets exported
  deliberately. The build layout was never a contract, and a tool whose job is
  catching silent contract drift should not ship its own file paths as one.

- **`check` can now fail a server you did not change.** Eight new lint rules
  land, three of them at `error` level (`CAS-L009`, `CAS-L010`, `CAS-L013`),
  and the lint reads more of the schema than before: `title`, `default`,
  `const`, the string members of `enum` and `examples`, and tool `annotations`,
  in addition to every `description`.

  *What you see:* `check` exits 1 on a tool that passed under 0.2.0.

  *What to do:* read the rule id in the output and look it up in the README
  table. The three new `error` rules are `shape`-class: they fire on a
  bidirectional override, a variation-selector data channel, or an instruction
  telling the model to assume a role, none of which belong in an honest
  description, so a hit is worth fixing rather than muting. The five new `warn`
  rules never fail the build on their own: the default gate is still
  error-level only, and `--fail-on warn` is opt-in. If a finding is a false
  positive, please report it. The rules ship with paired fixtures precisely so
  legitimate tools stay quiet.

### Added

- **`mcp-cassette/vitest`**: one `useCassette()` call wraps a `describe` block
  with a replay server, and a fingerprint miss **fails the test that caused
  it** instead of arriving as a JSON-RPC error the assertion never inspects.
  Misses surface as `CassetteMissError` or `CassetteMismatchError`, so "never
  recorded" and "recorded, but the arguments drifted" are told apart by type,
  and the mismatch carries the diff. `vitest` is an optional peer dependency
  and stays out of the dependency graph of anyone not using the adapter.
  This subpath is a **public surface from now on**, and will be treated as one.

  HTTP cassettes are served in-process. A stdio cassette hands back
  `tape.command` for your client to spawn, because a stdio replay owns
  `process.stdin`/`process.stdout` and would fight vitest for them. Misses on
  that path can only arrive as the JSON-RPC error the client sees.

- **Sixteen safety-lint rules, each citing its standard.** Every rule carries
  the [OWASP MCP Top 10](https://owasp.org/www-project-mcp-top-10/) risk and the
  [SAFE-MCP](https://github.com/fkautz/safe-mcp) technique it implements, as
  data rather than prose. New: Trojan Source bidi overrides, variation-selector
  data channels, cross-tool shadowing, declared command execution, role
  impersonation, credential solicitation, homoglyph obfuscation, and unpinned
  remote fetches.

  Each rule also declares whether text alone can separate an attack from a
  legitimate tool. `shape` rules can, so a legitimate tool produces nothing:
  ordinary Arabic, Chinese and emoji descriptions are silent by construction.
  `intent` rules cannot: a terminal server really does describe running
  commands, so those are always `warn` and say what was declared instead of
  accusing.

- **`check --format text|json|sarif`**: SARIF 2.1.0 output for GitHub code
  scanning. Rule ids are the ones the CLI prints, the OWASP and SAFE-MCP
  mapping travels as tags, and `partialFingerprints` are built so that
  rewording a description does not resurrect a triaged alert. Findings carry
  logical locations rather than invented line numbers, because `check` inspects
  a live server and there is no file to point at. `--json` remains, permanently,
  as an alias for `--format json`.

- **`check --fail-on error|warn`**: opt into failing on warnings, the same way
  `snapshot --fail-on` works. The default is unchanged.

- **Structured miss diagnostics.** `diagnoseMissReason()` returns a
  `MissReason` discriminated union and `formatMiss()` renders it, so a consumer
  can act on *why* a replay missed without parsing English. `diagnoseMiss()`
  keeps its signature and its exact wording. `ReplayServer.takeMisses()` drains
  the misses since the last call, which is what lets the vitest adapter blame
  the test that caused one.

- **A CI gate proving every lint pattern free of super-linear backtracking.**
  Lint input is text an attacker wrote, so a pattern with catastrophic
  backtracking would be a denial of service against the job inspecting the
  attacker. Every rule publishes its pattern and
  [recheck](https://github.com/makenowjust/recheck) analyses it; the gate also
  fails when a rule matches by regex without publishing one.

### Changed

- **The action's `version` input now defaults to `0.3.0`** (it still said
  `0.1.2`, so consumers of `ivermin1123/mcp-cassette@v0` who did not pass
  `version` were running a two-release-old CLI). Note that `@v0` floats: those
  consumers pick this up on their next run, including the lint changes under
  BREAKING above. Pin `version:` explicitly to control when that happens.
- `CAS-L004` is rewritten to scan from the URL with a bounded look-back instead
  of a verb alternation followed by `[^.]{0,60}https?://`, which `recheck` would
  not certify.
  Behaviour is unchanged; the rule is now linear by construction.
- The rule catalogue moved to `src/lint-rules.ts`; `src/lint.ts` keeps the
  machinery that applies it. A pure move: every public name is still importable
  from where it was.

### Compatibility

- **Cassettes are untouched.** No format change in this release; v1 and v2 files
  read exactly as they did under 0.2.0.
- **The CLI's three runtime dependencies are unchanged** (`ajv`, `ajv-formats`,
  `commander`). The vitest adapter adds an *optional peer*, not a dependency.
- Every existing import from `mcp-cassette` still resolves. Only paths *into*
  the build output are closed. See BREAKING.

## [0.2.0] - 2026-08-16

Record and replay a **Streamable HTTP** MCP session, in either lifecycle era.
Until now `mcp-cassette` spoke only stdio; this release makes the transport a
detail of the front-end and leaves the matching engine untouched underneath.

### Added

- **`record --http <url> [--listen <host:port>]`**: a reverse proxy that
  records an HTTP session. Requests are forwarded to the upstream verbatim and
  answers relayed back streaming, while frames are captured on the way through.
  It binds `127.0.0.1:6402` by default, refuses a taken port loudly instead of
  moving to a free one, and answers `403` to a non-local `Origin`.
- **SSE capture**: a streamed answer becomes a `chunks` entry holding every
  frame as it appeared on the wire. The parser follows WHATWG's event-stream
  algorithm and is incremental, so an event split across TCP reads is still one
  event. A stream still open when the session ends is flushed with what it
  showed.
- **`replay <cassette> --listen <host:port>`**: serves an HTTP cassette as a
  deterministic Streamable HTTP server. Recorded statuses are reproduced
  (including a non-default one like `400`), notifications get `202`, a legacy
  `sessioned` cassette mints a fresh session id per run and answers `DELETE`,
  and everything the recorded era forbids answers `405` with `Allow`.
- **SSE emission**: a recorded stream is replayed as SSE, one `data:` line per
  frame, closing after the final one; only that final frame is re-keyed to the
  incoming request id. A recorded legacy standalone `GET` stream is served and
  held open.
- **`--timing none|recorded`**: emit streamed frames back to back (default), or
  spaced by the offsets the recorder stamped.
- **`--on-miss passthrough` over HTTP**: a miss is forwarded to the real server
  and appended to the cassette as `origin:"live"`, including a `chunks` entry
  when the live answer streamed.
- **Dual-era support**: the classic `initialize` lifecycle and the stateless
  `2026-07-28` one. `check`, `snapshot`, and `verify` take `--era
  legacy|modern|auto`; `auto` probes modern-first over HTTP and legacy-first
  over stdio. When recording, the era is decided by the first *successful*
  exchange, so a dual-era client's failed probe is recorded honestly without
  deciding it.
- **`lint <cassette>`**: checks a cassette's header against its own frames
  (era and transport consistency) and exits 1 on any contradiction.
- **Cassette format v2**: adds `era`, `url`, `sessioned`, `transport:"http"`,
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

## [0.1.2] - 2026-08-15

Sponsor button, a TS6059 build fix, and post-publish verification of the
released tarball.

## [0.1.1] - 2026-08-15

Packaging fixes for the first release.

## [0.1.0] - 2026-08-15

First public release: stdio record/replay, contract snapshots, safety checks,
secrets redaction, and the `verify` command.

[0.3.0]: https://github.com/ivermin1123/mcp-cassette/releases/tag/v0.3.0
[0.2.0]: https://github.com/ivermin1123/mcp-cassette/releases/tag/v0.2.0
[0.1.2]: https://github.com/ivermin1123/mcp-cassette/releases/tag/v0.1.2
[0.1.1]: https://github.com/ivermin1123/mcp-cassette/releases/tag/v0.1.1
[0.1.0]: https://github.com/ivermin1123/mcp-cassette/releases/tag/v0.1.0
