# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the major
version is `0`, a minor bump may carry a breaking change; each one says so
below.

## [Unreleased]

### BREAKING

- **`jest` and `@jest/globals` are now optional peer dependencies, at `>=29`.**
  The jest adapter needs them, and declaring them is what keeps them out of the
  dependency graph of everyone else. An optional peer is still a peer, though,
  so npm checks it whenever the package is already present.

  *What you see:* a project that has jest 28 or older installed fails to install
  this release with `ERESOLVE ... Conflicting peer dependency`, naming
  `peerOptional jest@">=29"`. A project with jest 29 or newer, or with no jest
  at all, is unaffected: nothing new is installed and nothing new is warned
  about.

  *What to do:* upgrade jest to 29 or newer, which is the oldest version the
  adapter has been verified against. `--legacy-peer-deps` silences the check if
  the upgrade has to wait, at the cost of the check.

### Added

- **`sarif-file` input on the action.** Set it and the check's findings, `CAS-C`
  and `CAS-L` alike, are written as SARIF 2.1.0 to that path, ready for a
  `github/codeql-action/upload-sarif` step. Findings are anchored to the file
  named by `snapshot-file` when it exists, because code scanning discards a
  result that carries no physical location. A path under a directory that does
  not exist is created. The path is exposed as the `sarif-file` output, and that
  output stays empty, with the half-written file removed and a warning in the
  log, whenever no document was produced: the input was unset, the server could
  not be inspected, or the run ended before it wrote anything. So the upload
  step, guarded on that output as the README example shows, is never handed a
  file that is not a SARIF document.

  The action does not upload. That needs `security-events: write`, which an
  action should not assume on its caller's behalf; the README shows the step and
  the permission. Unset, the default, nothing is written and nothing changes.

  Setting it starts the server a second time: one `check` run emits one format,
  and the job log and the comment need the human-readable one.

- **A jest adapter, `mcp-cassette/jest`.** The same `useCassette` as
  `mcp-cassette/vitest`, with the same options, the same per-test drain and the
  same two error classes, so a jest suite gets what a vitest suite already had:
  a replay server around a `describe` block, no server and no network. Both
  adapters are now one implementation with a framework's hooks passed in, so
  there is one answer to where a miss surfaces rather than two that can drift.
  `CassetteMissError` and `CassetteMismatchError` are the same classes across
  both entry points, so one `instanceof` covers either.

  The package is ESM, so jest needs its native ESM mode: `transform: {}`,
  `testEnvironment: "node"` and `NODE_OPTIONS=--experimental-vm-modules`. That
  setup is in the README, and it is the one a fixture project runs on every
  test run rather than a snippet written from memory. Node 24.6.0 cannot run
  jest in ESM mode at all, for a reason that has nothing to do with this
  package; the README says what that looks like and which releases are
  unaffected.

### Fixed

- **The action posts its results comment when a gate fails.** It used to post
  one only when everything passed, which is the case where nobody needs it.
  Actions runs every `shell: bash` step as `bash --noprofile --norc -eo pipefail`,
  so `-e` was already on when the step began and the `set -uo pipefail` line
  could not clear it: `set` only turns options on. A failing `check` or
  `snapshot --check` therefore killed its own step before it could record the
  exit code, and the Report and Gate steps were skipped as dependents of a
  failed step. The gate still went red, by dying rather than by reporting, so
  the symptom was a missing comment rather than a wrong verdict.

  Both steps now record the exit code and hand it to the Gate step as they were
  always documented to, the comment is written on the way through, and the job
  still fails afterwards.

- The action's `::error::` messages use plain punctuation, and `src/check.ts`
  no longer describes an exit-code rule that two gates ago stopped being true.

## [0.6.0] - 2026-10-08

Replay now sends what the recorded server said on its own, where it said it:
change notifications, the `subscriptions/listen` stream of protocol revision
2026-07-28, and the legacy `list_changed` frames, in both eras and over both
transports. Until this release a cassette that held them replayed as if the
server had never spoken. The action gains a setting between gating on the
safety lint and switching it off: `lint-fail-on: never` keeps the lint and its
comment without failing the job, while a broken schema still fails it.

Both changes are BREAKING for some callers, listed below, so this is a minor.
Workflows using the action are not affected by either: its default behaviour
is unchanged.

### BREAKING

- **`CheckReport` gains two required fields, `failOn` and `lintFailOn`.** A
  report now carries the gates its `ok` was decided against, so a verdict can be
  read without knowing which flags produced it.

  *What you see:* TypeScript callers who build a `CheckReport` by hand, rather
  than taking the one `runCheck` returns, fail to compile with the two
  properties missing. Nothing changes at runtime, and nothing changes for a
  caller who only consumes a report.

  *What to do:* add `failOn: "error"` and `lintFailOn: "error"` to the literal,
  or whichever levels it is standing in for. Both field types are now exported
  from the entry point as `CheckFailOn` and `LintFailOn`, so they can be named
  directly instead of through `CheckReport["lintFailOn"]`.

  Optional fields would have been the compatible shape and the wrong one:
  `printReport` would then render a gate the report does not actually know.

- **Replay now originates the frames the recorded server sent on its own, at
  their recorded position.** Until now a server-initiated notification was
  counted and dropped (`N server-initiated frame(s) in the cassette are not
  replayed in v1`). It is now anchored to the last client request whose answer
  preceded it in the recording, and emitted immediately after replay answers
  that request; a frame recorded while a request was still outstanding belongs
  to that request and is emitted just before its answer, which is what keeps a
  stdio `notifications/progress` behind the call it reports on. A client
  therefore receives frames from a replay session that earlier releases never
  sent it, and the legacy standalone `GET` stream no longer delivers its whole
  content the moment it is opened: it is held open and fed at those anchors.

  *What you see:* a test that asserted on the exact frames a replay sends can
  now see extra notifications; a test that opened the `GET` stream without
  sending the request its frames follow now reads nothing from it. Replay says
  what it did on stderr, and the lines are new text to anyone grepping it. The
  startup line `N server-initiated frame(s) in the cassette are not replayed in
  v1` is now `N server-initiated request(s) in the cassette are not replayed`,
  and at session end you may see `N server-initiated frame(s) replayed at their
  recorded position`, `N recorded server-initiated frame(s) were not replayed:
  the client never sent the request each one follows`, and `N server-initiated
  frame(s) were not replayed: they belong to a subscription this client never
  opened`.

  *What to do:* for the `GET` stream, send the requests the recording sent, in
  the order it sent them, and the frames arrive where they were recorded. A
  client that does not want change notifications at all should not subscribe to
  them: in the 2026-07-28 era a frame tagged with a subscription this client
  never opened is held back and counted, never sent with the recording's own id.

- **`ReplayIndex.skippedServerFrames` is now `serverInitiatedRequests`.** The
  old field counted every server-initiated frame, because every one of them was
  skipped. Notifications are replayed now, so the only frames still skipped are
  server-to-client *requests* (legacy sampling, elicitation, roots), and the
  field counts those and says so in its name. Library callers reading the old
  field get `undefined`.

### Added

- **`lint-fail-on` input on the action, and `check --lint-fail-on`.** The
  safety lint can now report without gating. `error` is the default and is
  exactly today's behaviour; `warn` is the stricter setting, gating the warn
  tier as well; `never` runs the check, writes every finding to the job log and
  the pull-request comment, and does not fail the job over them. The comment
  names the gate it passed under.

  `never` reaches the `CAS-L` description lint and nothing else. A structural
  `CAS-C` error (a duplicate tool name, an `inputSchema` that is not valid JSON
  Schema) still fails the job, because that is the server being broken rather
  than the linter having an opinion about text an attacker wrote. So does a
  server that cannot be inspected at all, which still exits 2 at every level: a
  run that produced no report has nothing to waive. An unknown value is rejected
  by the action before the CLI runs, the way `mode`, `fail-on` and `version`
  already are.

  On the CLI the level is its own flag, `check --lint-fail-on <level>`, and it
  defaults to whatever `--fail-on` is set to. `check --fail-on warn` therefore
  still gates lint warnings exactly as it did before, and `--fail-on` itself is
  unchanged: it has no `never`.

  This is the half a consumer reaches for after a rule has already surprised
  them. The other half is release discipline, now written into
  [CONTRIBUTING.md](CONTRIBUTING.md): a rule that is new to a release ships at
  `warn`, and may graduate to `error` only in a later minor and no sooner than
  four weeks after the release that introduced it.

- **`subscriptions/listen` (2026-07-28) replays.** A recorded listen request is
  answered by its recorded `notifications/subscriptions/acknowledged` and held
  open (an SSE response stream over HTTP, the open request id on stdio), its
  recorded change notifications are emitted at their anchors, and a recorded
  graceful closure ends the subscription. `io.modelcontextprotocol/subscriptionId`
  is re-keyed to the id the client's own listen request carried, exactly as a
  recorded response is re-keyed to the incoming request id, so a client
  correlates on the id it chose. Proven against `@modelcontextprotocol/client`
  2.3.1 configured with `ClientOptions.listChanged`: it receives the change
  notification from the replay alone, in both eras, with no server running.

- **`handleExchange(index, frame, onMiss)`**, the complete single-frame API:
  everything one incoming frame sends back, in order, which for a recording
  whose server spoke on its own is more than the answer. `handleFrame` keeps
  meaning exactly what it did, the frame to send back, and drops the rest; the
  only change a caller sees is that a `subscriptions/listen` now gets the
  recorded acknowledgment where it used to get a JSON-RPC error. Also exported:
  `subscriptionOf`, and the three names the subscription travels under
  (`LISTEN_METHOD`, `ACKNOWLEDGED_METHOD`, `SUBSCRIPTION_ID_KEY`). The release
  and reporting helpers stay internal until a consumer needs them.

### Changed

- **`check` names its gates in the report.** The text report's result line now
  ends `, gate: error)`, and `, gate: error, lint: never)` when the two differ.
  `--format json` carries both as `failOn` and `lintFailOn`. Without them,
  `result: PASS` over five error-level findings reads as a bug rather than as
  the level that was asked for. The interface change this implies is under
  BREAKING above.

### Fixed

- **A request the recording holds with no response is diagnosed as that.** It
  used to be reported as `no recorded request has method "..."`, which is a
  claim about the file that the file contradicts: the request is right there,
  the server just never answered it before the session ended. The miss now says
  so, for the exact request and for a drifted call of a method only recorded
  unanswered.

- **A `subscriptions/listen` miss says what is actually wrong with it.** This is
  the message the whole item started from, and it survived the first fix in two
  places. A listen whose recorded subscriptions are all open already now reads
  `this exact subscription was recorded N time(s), and every one is already open
  in this session`, and one asking for a different notification filter is
  diffed like any other request (`params differ at: /notifications/...`). Both
  used to claim `no recorded request has method "subscriptions/listen"` about a
  file that holds exactly that request.

- **Position is read from the recorded timestamps, not from file order.** An
  HTTP recording writes a whole stream as one `chunks` entry when the stream
  closes while stamping each frame as it arrived, so file order puts every frame
  of a long-lived stream after requests it preceded.

- **The HTTP `N streamed answer(s) in the cassette` count no longer includes
  streams that answer nothing.** The legacy standalone `GET` stream and a
  subscription stream are held open rather than handed to a request, so counting
  them promised replies that never came.

## [0.5.0] - 2026-10-08

Protocol revision 2026-07-28 moved sampling, elicitation and roots into
Multi Round-Trip Requests: the server answers `input_required`, and the client
retries the same call carrying its answers in `inputResponses` and the
server's `requestState`. The tool was dual-era before this, but three of its
paths had never met a retry, and each one got it wrong.

Fixing the first of them uncovered an older answer that was wrong in the same
way: a request replay had never seen was quietly given another request's
recording. Matching is now exact unless you ask for the tolerance by name.

### BREAKING

- **`replay` matching is exact by default; borrowing moves behind
  `--on-miss warn`.** When a request's exact fingerprint was never recorded,
  replay used to answer it from the next unused recording of the same method,
  whatever its arguments, and say nothing. Measured on 0.4.0: with only
  `add {a:1, b:2}` recorded, `add {a:5, b:5}` got `"3"`, and the call that *was*
  recorded then missed as "exhausted". Under `error` (the default) and
  `passthrough` such a request is now a miss; under `passthrough` that means
  it is forwarded, where before a recording of any tool could answer it first.
  `warn` keeps the old tolerance for arguments that change every run, and names
  the diverging paths on stderr for every borrowed answer. The vitest adapter
  runs replay in `error` mode, so it matches exactly too.

  *What you see:* a replay that passed under 0.4.0 can now miss with a
  diagnosis such as `arguments differ at: /a (recorded 1, got 5); /b (recorded
  2, got 5)`, and a passthrough session can append calls it used to answer
  from the cassette.

  *What to do:* read the diagnosis. If the argument is one that legitimately
  changes every run (a timestamp, a generated id), run with `--on-miss warn` to
  keep borrowing, and you will see each loan on stderr. Library callers who want
  the old matching compose it: `matchResponse(index, req) ?? matchFallback(index, req)`.

- **`replay` no longer answers a differently-answered MRTR retry with the
  recorded outcome.** A `tools/call` fingerprint was `name` + `arguments` only,
  and a retry repeats both verbatim, so a recording made with `accept` served
  its outcome to a retry that sent `decline`, with exit 0. A retry is now
  matched on `inputResponses` and `requestState` as well, never takes the
  same-method fallback, and a retry's recorded answer is never handed to any
  other request. Every fingerprint without those fields is byte-identical to
  0.4.0, so nothing else matches differently.

  *What you see:* a replay that passed under 0.4.0 can now miss, with a
  diagnosis naming the path that diverged, for example
  `/inputResponses/confirm/action (recorded "accept", got "decline")`.

  *What to do:* the miss is the replay telling you the client answered
  differently from the recording. Re-record that flow, or record one cassette
  per answer you test.

### Fixed

- **`replay --listen` serves a call its own recorded stream.** The same-method
  borrowing ran before the stream pools were consulted, so a call whose answer
  was recorded as a stream got any unused JSON answer of the same method
  instead, from another tool if need be. Exact matches, JSON or streamed, now
  always come first, under every `--on-miss` mode.
- **`replay --on-miss passthrough` relays `input_required` to the client.** It
  used to treat the answer as a failed forward and send `-32603`, so an MRTR
  flow could not pass through at all. Both front-ends, stdio and HTTP, now
  relay it, and the retry that follows is forwarded and appended like any
  other miss.
- **`verify` completes an MRTR exchange instead of reporting it MISSING.** The
  recorded retry is re-fired with its recorded `inputResponses` and the live
  server's own `requestState`, or none when the live server minted none. A
  `requestState` value is opaque by contract and is never reported as drift;
  whether one was sent still is.

### Added

- `MiniClient.relay()`: send one request and get back whatever answered it,
  `input_required` included. `request()` keeps throwing `InputRequiredError`
  for callers with no input to give.
- `matchFallback()`, the same-method borrowing that `matchResponse()` no longer
  does, exported for callers who want it; and `ReplayServer.borrowed()`, the
  count of answers `--on-miss warn` borrowed over HTTP.

### Changed

- npm keywords gain `agent` and `vcr`, the two words the registry search was
  missing. Deferred in `docs/research/03-discovery-language.md` until a release
  was cut for a real reason; this is that release.

## [0.4.1] - 2026-10-08

The action ran the wrong CLI. Its `version` input defaulted to `0.3.0`, so a
workflow using `ivermin1123/mcp-cassette@v0.4` or `@v0` without a `version:`
ran 0.3.0, the release whose `snapshot --check` stayed silent on breaking
changes nested inside a schema and whose SARIF GitHub discarded. Those are the
two defects 0.4.0 was cut to correct, and the action shipped with neither fix.
This release changes that default and nothing else: the npm package is the
0.4.0 code under a new number.

### Fixed

- **The action's `version` input now defaults to `0.4.1`.** Workflows on
  `@v0.4` or `@v0` that pass no `version:` move from CLI 0.3.0 to 0.4.1 on
  their next run, and with it pick up the 0.4.0 changes below, including the
  nested-schema walk that can turn a green drift gate red against a server
  nobody touched. Read the findings before assuming a regression, and pin
  `version:` to choose when that happens. From the next release on,
  `npm version` rewrites the default and a test fails the build if it drifts.

## [0.4.0] - 2026-08-16

Two things this tool claimed to do, and did not. `snapshot --check` stayed
silent on breaking changes nested inside a schema, and every SARIF document
`check` produced was accepted by GitHub code scanning and then thrown away
without creating a single alert. Both are fixed here.

That is also why this is a release rather than a wait. A feature that is
frozen tells you nothing; a feature that answers wrongly tells you something
false, and 0.3.0 is on npm answering wrongly today.

### BREAKING

- **`snapshot --check` now walks nested schemas.** Previously the conservative
  fallback asked whether the *whole tool* had produced any finding, so a single
  `minor` at the root swallowed every breaking change underneath it. A tool
  that exists to catch silent contract drift was producing silent contract
  drift. The fallback is now per node.

  *What you see:* a build that was green under 0.3.0 can go red against a
  server nobody touched. The diff reports breaking changes that were always
  there and were being hidden by a `minor` finding above them in the same tool.

  *What to do:* read the findings before assuming a regression in your server.
  In every case this changes, the correct answer under 0.3.0 was already red;
  what moved is whether you were told. If you need to land the release first
  and deal with the contract after, `--fail-on` remains the release valve, and
  the rule ids in the output are the list of what to come back to.

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

- **The `$ref` guard was hiding the findings it sits next to.** The guard
  returned as soon as it saw a `$ref` anywhere in either schema, so a removed
  parameter went unreported when a reference happened to sit in a sibling
  property: the diff said `input-schema-ref-unclassified` alone where it should
  have said `input-property-removed` as well. The walk now runs to completion
  and the guard is appended rather than substituted. Same defect class as the
  per-tool fallback above, and it survived for the same reason: no probe had
  ever put a reference beside a concrete change.

- **GitHub code scanning kept none of the findings `check --format sarif`
  produced.** Every document uploaded successfully and was then discarded with
  `locationFromSarifResult: expected a physical location`, once per finding,
  creating no alerts. 0.3.0 shipped `logicalLocations` only, on the reasoning
  that `check` inspects a live server so there is no file to point at. The
  reasoning was half right: there is no *source* file, but there is a committed
  contract snapshot, and that is where a reader goes to see what a server
  advertises. Findings now carry a `physicalLocation` anchored to a real file at
  a real line, `logicalLocations` is kept alongside for consumers that read it,
  and the anchor is never invented: a path outside the working directory is an
  error rather than a silent downgrade. Verified against code scanning itself,
  not only against the schema.

### Added

- `input-schema-ref-unclassified` (breaking). Reference resolution is not
  implemented, so when a changed schema contains `$ref` the diff says that
  plainly rather than emitting a specific rule ID about a shape it never
  resolved.

- **`check --sarif-location <file>`**: name the file SARIF findings anchor to.
  Left unset, the anchor is resolved in a stated order (an existing
  `mcp-contract.snapshot.json`, then the server script from `--stdio` when a
  token of it is a real file), and when nothing resolves the document is still
  emitted and `check` warns on stderr that code scanning will drop every
  result. Silence was the old behaviour and it cost every alert.

### Changed

- The strings the program prints were rewritten to drop the punctuation that
  reads as machine-made: 68 strings across 22 files, including the npm
  description, every `--help` line, the error and warning text, the pull-request
  comment `action.yml` renders, and the message half of the lint and SARIF
  rules. Information is unchanged in every one; only the punctuation joining
  the clauses moved. The five tests that pinned those sentences were updated in
  the same change, because a test that pins a sentence is the contract for it.

- The README now states the scope boundary of `snapshot --check` directly:
  what it compares, and what it does not resolve.

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

[0.6.0]: https://github.com/ivermin1123/mcp-cassette/releases/tag/v0.6.0
[0.5.0]: https://github.com/ivermin1123/mcp-cassette/releases/tag/v0.5.0
[0.4.1]: https://github.com/ivermin1123/mcp-cassette/releases/tag/v0.4.1
[0.4.0]: https://github.com/ivermin1123/mcp-cassette/releases/tag/v0.4.0
[0.3.0]: https://github.com/ivermin1123/mcp-cassette/releases/tag/v0.3.0
[0.2.0]: https://github.com/ivermin1123/mcp-cassette/releases/tag/v0.2.0
[0.1.2]: https://github.com/ivermin1123/mcp-cassette/releases/tag/v0.1.2
[0.1.1]: https://github.com/ivermin1123/mcp-cassette/releases/tag/v0.1.1
[0.1.0]: https://github.com/ivermin1123/mcp-cassette/releases/tag/v0.1.0
