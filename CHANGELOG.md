# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the major
version is `0`, a minor bump may carry a breaking change; each one says so
below.

## [Unreleased]

### BREAKING

- **`snapshot --check` escalates a reworded description that is now an attack.**
  A description change used to be `info` whatever the new text said. A tool
  approved with honest prose and later serving a description carrying an
  injection is the rug pull (SAFE-T1201, OWASP MCP03:2025), and the snapshot is
  the only place it can be caught: what makes the text an attack is that it is
  new relative to a file somebody read and approved, which a lint run against
  the live server cannot know. `snapshot --check` now runs the `CAS-L` rules
  over the stored description and over the live one. A reword whose new wording
  trips a rule the approved wording did not is reported as
  `tool-description-poisoned` at `dangerous` instead of `tool-description-changed`
  at `info`. Only the rules that name a SAFE-MCP technique count, so `CAS-L008`,
  the 1500-character limit, is advice rather than a signature and a description
  that merely grew stays `info`. Only the tool's top-level `description` is
  compared; the same text in a parameter description, a schema `title` or
  `default`, or an annotation is reported by the structural rules as before.

  *What you see:* a job running `snapshot --check --fail-on dangerous` goes red
  on a server whose description was reworded into something a safety-lint rule
  matches. At the default gate nothing changes: `dangerous` is reported and not
  gated, so `snapshot --check` alone still exits 0. A reword that trips no new
  rule is still one `info` line, and a description that was already poisoned
  when it was committed and is reworded but still poisoned stays `info` too,
  because the lint already reports it on every run and escalating it here would
  say the same thing twice. The escalation replaces the `info` line rather than
  joining it, so one changed description is still one finding, and a policy
  matching `tool-description-changed` will no longer see the poisoned case.

  *What to do:* read the finding before re-recording the snapshot. It names the
  rules the approved wording did not trip, so `CAS-L001, CAS-L003` on a tool you
  did not change is the rug pull itself, not a false positive to silence. When
  the new wording is yours and the match is a wording accident, run `snapshot
  --update` to approve it; the next run compares against what you approved.
  Every existing rule id is unchanged.

  `tool-description-poisoned` sits at `dangerous` in this release. It may
  graduate to `breaking` in a later minor, which would gate it by default.
- **`check` reports an invalid `x-mcp-header` declaration as `CAS-C008`, at
  `warn`.** The 2026-07-28 Streamable HTTP transport lets a server ask for a
  tool parameter to be mirrored into an `Mcp-Param-{name}` header, and requires
  a client to refuse a tool whose declaration breaks the constraints on that
  name. A server shipping one has a tool no conformant 2026-07-28 HTTP client
  will call, which is a contract defect of the same class as an `inputSchema`
  that is not valid JSON Schema, so it is reported the way those are. The check
  runs on every target, stdio included: the declaration is a property of the
  schema, not of the wire, and a stdio server reachable over HTTP ships the
  same schema.

  *What you see:* a job running `check --fail-on warn` (or `--lint-fail-on`
  left at that gate) goes red on a server with such a declaration, naming the
  tool and the rule that was broken. At the default gate nothing changes:
  `CAS-C008` is reported and not gated, so `check` alone still exits 0. The
  tool itself stays in the listing, in the lint and in a snapshot, so no other
  finding moves and `snapshot --check` reports no drift.

  *What to do:* fix the declaration on the server. A valid `x-mcp-header` value
  is a non-empty HTTP field-name token, unique among the schema's others when
  compared case-insensitively, on a `string`, `integer` or `boolean` property
  reachable from the schema root through `properties` keys alone. `CAS-C008`
  ships at `warn` and may graduate to `error` in a later minor, which would
  gate it by default.

- **`CassetteFinding` gains a required `severity` field.** `lint <cassette>`
  now reports findings it does not gate on, so a finding has to say which kind
  it is. `"error"` is a header that contradicts its own frames, which is what
  this command has always exited 1 on; `"warn"` is everything added since.

  *What you see:* a TypeScript caller who builds a `CassetteFinding` by hand
  fails to compile with `severity` missing. Nothing changes for a caller who
  only reads the findings `lintCassette` returns, and the exit code of every
  existing cassette is unchanged.

  *What to do:* take the findings from `lintCassette` rather than constructing
  them. If you were filtering its output to decide a gate, filter on
  `severity === "error"` to keep the behaviour you had.

### Added

- **The 2026-07-28 header mirror, client side: `Mcp-Method`, `Mcp-Name` and
  `Mcp-Param-{name}`.** `check`, `snapshot` and `verify` over `--url` already
  sent the first two; they now also send the custom headers a tool's
  `inputSchema` asks for with `x-mcp-header`, which is what lets a load
  balancer or gateway route a `tools/call` without parsing its body. The
  parameters are resolved from `tools/list` before any `tools/call`, so
  `verify` lists the tools once when the cassette calls one; a server that
  cannot list is called without the headers, which is what the spec tells a
  client holding no schema to do. Values travel as the spec encodes them:
  plain when they are plain ASCII with no leading or trailing whitespace, and
  as `=?base64?...?=` when they are not.

- **`lint <cassette>` scans what the recorded server returned.** A tool
  description is a promise made before the call; a tool result is data handed
  back after it, and it reaches the model with the same authority. A fetched
  issue whose body says "ignore all previous instructions", a document carrying
  zero-width characters, a page with a bidi override: none of it is visible to
  a lint that inspects a live server's listings, and all of it is in the
  cassette. Six rules run on the answers to `tools/call`, `tasks/get`,
  `tasks/result`, `resources/read` and `prompts/get`: CAS-L001, L003, L006,
  L009, L010 and L013. The two task methods are read because a task-augmented
  call answers with a handle and delivers the tool's real output later. Each
  finding names the frame it came from, by request id and method, and the JSON
  path of the string that matched. `lintCassetteOutput`, `OutputFinding` and
  `OUTPUT_RULE_IDS` are exported from the package entry beside `lintCassette`,
  so a library consumer can build the same report the CLI prints.

  The set is listed in the code and in the README rather than derived, and it
  was narrowed by measurement. The `intent` rules are excluded by their own
  premise, and six `shape` rules are excluded because they fire on data a real
  server returns every day: CAS-L002 on every HTML comment, CAS-L004 on
  ordinary API documentation, CAS-L005 on any directory listing, CAS-L007 on an
  inline `data:` URI, CAS-L008 on any long document, and CAS-L015 on a latency
  written in microseconds. CAS-L006 is kept but narrowed on this surface, to a
  run of two or more invisible code points or any Tags-block code point: a lone
  zero-width character is what a web editor leaves in about three percent of
  real GitHub issue bodies, a Windows-authored file opens with a byte-order
  mark, and every ZWJ emoji is a U+200D, while neither encoding the rule exists
  for can be spelled in one code point. The declaration-side rule is unchanged.
  The measurements and the open follow-ups are in BACKLOG. A base64 `blob`, and
  the `data` of an image or audio block, are carried but never decoded and
  never scanned, and text inside a `[REDACTED:...]` placeholder is not scanned
  either.

  Findings are reported at `warn` and never change the exit code: returned text
  is data a third party wrote, and a pipeline that was green yesterday does not
  go red because a server it depends on started quoting a GitHub issue. A
  cassette with clean output prints exactly what it printed before.

- **`lint <cassette>` checks the header fields newer than it.** `volatile` must
  be a list of strings, each a declaration replay's own parser accepts, and
  `redaction.configHash`, when present, must be the sha256 hex digest `redact`
  writes. Both are read by something that refuses rather than degrades, so a
  hand-edited cassette used to fail at the far end of a replay instead of in a
  file somebody can open. Each finding names the header field, and both are
  reported at `warn`.

- **`lint --json`** emits the findings machine-readably. There is no
  `--format sarif` here: SARIF would have to invent a server, a tool count and
  a gate the run was decided against, and a cassette has none of those.

### Changed

- **Replay warns about a mismatched `Mcp-Name` or `Mcp-Param-*` too.** The rule
  is the one replay already documented and does not change: a header the body
  contradicts earns a warning on stderr and a correct answer, never a `400`. A
  real server answers that with `-32020`; checking a client against one is
  `verify`'s job, not a test double's. Replay holds no `inputSchema`, so it
  judges a mismatch and not an absence: a `Mcp-Param-*` whose value sits
  nowhere in the call's arguments is named, a missing one is not.

- **The README, the site and `llms.txt` describe what the tool does now.** The
  lead, the "what it does" section, the roadmap and the tool comparison were
  written against a smaller tool: the roadmap still listed the GitHub Action as
  unbuilt, the site named five commands and only the vitest adapter, and
  neither page mentioned replayed server frames, the tasks extension, declared
  volatility, configurable redaction, the 2026-07-28 header mirror, the rug-pull
  escalation in `snapshot --check`, or `lint <cassette>`. `Last-Event-ID`
  resumability leaves the roadmap: revision 2026-07-28 removed the standalone
  `GET` stream it resumed. The demo recording is rebuilt from the repository's
  own fixture servers, so it renders offline and shows both lint surfaces.
  No behaviour changed.

## [0.8.0] - 2026-10-10

Replay can be told which request fields change on every run: `--volatile`
or a `volatile` list in the cassette header drops a declared field before
matching, the precise replacement for the borrowing `--on-miss warn` does, and
a declaration that would change which matching rule applies is refused by
name. Redaction becomes configurable: `--redact-config` adds your own
patterns, sensitive keys and allowed values to `record`, `redact` and
`replay`, the cassette records a hash of that config, and replay refuses a
cassette recorded under a config it was not given.

The BREAKING items below are for library callers who build a `ReplayIndex`
by hand, and for replay sessions on a cassette recorded with a redaction
config. Workflows using the action are not affected: it runs `check` and
`snapshot`, which neither change touches.

### BREAKING

- **`ReplayIndex` gains a required `redactConfig` field.** The index carries the
  compiled redaction rules the session runs, so both front-ends redact an
  incoming request the same way the recording was redacted.

  *What you see:* a TypeScript caller who builds a `ReplayIndex` by hand, rather
  than taking the one `buildReplayIndex` returns, fails to compile with
  `redactConfig` missing. Nothing changes at runtime for a caller who only
  consumes one, and an index built without a config carries the built-in rules,
  which is exactly the old behaviour.

  *What to do:* take the index from `buildReplayIndex`, which is the only
  supported way to build one. It accepts a compiled config as a second
  argument: `buildReplayIndex(cassette, { redactConfig: readRedactConfig(path) })`.
  `readRedactConfig`, `compileRedactConfig`, `checkRedactConfig`,
  `BUILTIN_REDACTION` and the config types are exported from the package entry
  for exactly this.

- **`replay` refuses a cassette recorded under a redaction config it was not
  given.** Redaction runs before fingerprinting, so the rules are part of what a
  fingerprint means; a cassette recorded with custom rules and replayed without
  them used to start and then miss every request, with a near-miss diff naming a
  field whose recorded value was a placeholder and whose live value was the
  secret.

  *What you see:* `buildReplayIndex`, `runReplay` and `startHttpReplay` throw
  before serving anything, naming which side is short a config. Only a cassette
  carrying `redaction.configHash` can reach this, and nothing written before
  this release carries one, so no existing cassette changes behaviour.

  *What to do:* pass the same `--redact-config` the recording used, or re-record
  without one.

- **`ReplayIndex` gains a required `volatile` field.** The index carries the
  declared-volatile pointers in force for the session, the cassette header's own
  followed by the invocation's, so every fingerprint in both front-ends is
  computed over the same declaration.

  *What you see:* a TypeScript caller who builds a `ReplayIndex` by hand, rather
  than taking the one `buildReplayIndex` returns, fails to compile with
  `volatile` missing. Nothing changes at runtime for a caller who only consumes
  one, and an index built from a cassette that declares nothing carries an empty
  list, which is exactly the old behaviour.

  *What to do:* take the index from `buildReplayIndex`, which is the only
  supported way to build one. It accepts the declarations as a second argument:
  `buildReplayIndex(cassette, { volatile: ["/arguments/requestedAt"] })`.

### Added

- **Configurable redaction: `--redact-config <file>` on `record`, `redact` and
  `replay`.** The built-in rules match the shapes everyone shares, so a
  credential in a house format, or a field name only one server uses, went
  through untouched and the only answer was `--no-redact`, which protects
  nothing. A config file adds three things:

  ```json
  {
    "patterns": [{ "name": "acme", "regex": "ACME-[A-Z0-9-]{10,}" }],
    "keys": ["handle"],
    "allow": ["sk-THIS-ONE-IS-PUBLIC-000000"]
  }
  ```

  `patterns` adds token shapes. The name becomes the rule label inside the
  placeholder, so it is lowercase letters only and may not be one of the
  built-in names: a reader seeing `[REDACTED:bearer:...]` is entitled to
  conclude the bearer rule put it there. User patterns run before the built-ins,
  so a house format wins over a generic shape that would only partly match it,
  and each is compiled global whatever was written, because a value that occurs
  twice has leaked twice. Only the `i` and `u` flags are accepted. `keys` adds
  names whose string values are secrets whatever their shape, matched against
  the whole key or any one of its segments, so `handle` covers `session_handle`
  and `sessionHandle` but not `handler`. `allow` exempts specific values the
  built-in rules over-redact, which is the narrow alternative to turning
  redaction off; each is compared exactly against what a rule would replace,
  which is the token after `Bearer` and the password inside a URL rather than
  the whole match. A pattern that can match the empty string is refused at load
  time, and no pattern may rewrite text inside a placeholder, so `redact` stays
  idempotent whatever a config adds.

  The same file has to go to `record` and to `replay`, because redaction runs
  before fingerprinting on both sides. A recording made under a config carries a
  hash of it in `redaction.configHash`, and replay refuses a cassette whose hash
  does not match the config it was given, saying which side is short one, and
  `redact` refuses to rewrite such a cassette under any other config rather than
  dropping the hash. Only the hash is stored, because a regex describes the
  secrets it catches and an allowed value is a value; it is not itself a secret,
  being an unsalted sha256 of a small document that anyone with a candidate
  config can confirm offline, so `allow` is for values that are already public.
  The hash is taken over what the config does rather than how it was written:
  `keys` lowercased, deduplicated and sorted, `allow` deduplicated and sorted,
  flags sorted, pattern order kept. A config that declares nothing produces no
  hash, so an empty config is the same as none, and an older mcp-cassette
  ignores the field and replays with the built-in rules.

  `redact` gained `--check-config` and the cassette argument became optional for
  it, so `redact` with no arguments reports a usage error of its own and still
  exits 1.

  `redact --redact-config <file> --check-config` analyses the patterns for
  catastrophic backtracking, because they run over every string a server answers
  with, which on a hostile server is attacker-controlled text, and reading a
  regex does not tell you whether it backtracks. It uses `recheck`, now an
  optional peer dependency rather than a runtime one: without it the command
  exits 2 and says the patterns are unanalysed, rather than reporting a pass
  nobody computed. `scripts/recheck-rules.mjs` now holds the built-in redaction
  rules to the same standard it already held the safety lint's.

  Both test adapters take the same file, `useCassette(file, { redactConfig })`
  in `mcp-cassette/vitest` and `mcp-cassette/jest` alike, and a stdio cassette
  carries it on the `command` the adapter hands back.

  *What you see:* nothing, unless you pass a config. Without one, `record`,
  `redact`, `replay` and the scanner run the built-in rules exactly as before,
  byte for byte.

- **Declared volatility: `replay --volatile <json-pointer>`, and a `volatile`
  cassette header.** A request field that changes every run (a timestamp the
  client stamps, an id it generates) can be named, and replay drops it before
  matching instead of missing on it. This is the precise version of the
  tolerance `--on-miss warn` gives approximately, and unlike warn it never
  answers a request with another request's recording: everything that was not
  declared is still matched exactly.

  A declaration is a JSON Pointer into the request's `params`
  (`/arguments/requestedAt`), optionally scoped to one method by naming that
  method before a colon (`tools/call:/arguments/requestedAt`). A JSON Pointer
  always starts with `/`, which is what tells the two forms apart, so a `:`
  inside a pointer stays an ordinary character. The flag is repeatable, and the
  same list may live in the cassette header as `volatile`, so a cassette carries
  what is true of the recording while the invocation adds what is true of this
  run; the two are added together. A malformed declaration is refused by name
  while the index is built, rather than ignored, and so is one that names a
  field replay itself matches a rule on: `/name` or `/inputResponses` on a
  `tools/call`, `/taskId` on a `tasks/get`, `/inputResponses` on any method at
  all. Dropping one of those would not loosen a match, it would change which
  rule runs, and the request would then be answered with another tool's,
  another retry's or another task's recording in silence. The same names stay
  declarable on a method that does not match on them, so `prompts/get:/name`
  and `tasks/update:/taskId` are accepted. `/requestState` is reserved for the
  same reason as `/inputResponses`: a request carrying it and no
  `inputResponses` is still a retry to the matcher, and dropping it would land
  that retry in the pool of the call it retried.

  The pointer is dropped from both sides, the recorded request as the index is
  built and the live one as it arrives, over stdio and over HTTP alike,
  including the redacted-request path and the pools that hold streamed answers.
  The miss diagnosis drops them too, so a miss never blames a field the session
  already said would move: the paths it names are the ones that really diverged.
  Nothing else bends. An MRTR retry still matches on the `inputResponses` it
  carried and still never borrows, a `tasks/get` still pools per task and still
  obeys the terminal rule, and `subscriptions/listen` still matches its own
  params. A declaration decides what the fingerprint is computed over, not which
  rule computes it.

  Both test adapters take the same list, `useCassette(file, { volatile: [...] })`
  in `mcp-cassette/vitest` and `mcp-cassette/jest` alike, because the option
  lives in the one implementation they share. A stdio cassette carries the
  declarations on the `command` the adapter hands back, since the process the
  client spawns is the one that has to honor them.

  *What you see:* nothing, unless you declare something. A cassette with no
  `volatile` header replayed with no `--volatile` flag matches exactly as it did
  before. An older mcp-cassette handed a cassette that carries the new header
  field reads it without complaint, because an unknown header field has always
  been ignorable; it just matches on the declared fields again, so a request
  whose timestamp moved misses there.

## [0.7.0] - 2026-10-09

Replay now serves the tasks extension: a task's polls come back in recorded
order, a finished task keeps answering with its final state, and a recording
that stopped mid-task says which task and where, over stdio and over HTTP
whichever shape the server answered in. The safety lint reads every
model-facing text a server publishes, prompts, resources and resource
templates included, at `warn` for this release. The action can write its
findings as SARIF for code scanning, and posts its results comment when a gate
fails, which it did not before. A jest adapter joins the vitest one.

Several changes are BREAKING for some callers, listed below, so this is a
minor. Workflows using the action at its defaults are not affected: the new
lint findings are `warn`, and the default `lint-fail-on: error` does not gate
on them, while `lint-fail-on: warn` does.

### BREAKING

- **`ReplayIndex` gains a required `taskPolls` field, and `MissReason` gains a
  `task-not-terminal` variant.** The index now carries where the recording left
  each task, which is what lets a poll past the recorded sequence be answered or
  refused on the extension's own terms rather than as a spent pool.

  *What you see:* a TypeScript caller who builds a `ReplayIndex` by hand, rather
  than taking the one `buildReplayIndex` returns, fails to compile with
  `taskPolls` missing. A caller who switches exhaustively over `MissReason`
  fails to compile on the new variant. Nothing changes at runtime for a caller
  who only consumes either.

  *What to do:* take the index from `buildReplayIndex`, which is the only
  supported way to build one, and add a `task-not-terminal` arm to the switch.
  `formatMiss` renders every variant, so a caller that only needs the sentence
  can call it instead of matching the shape.

- **`--on-miss warn` no longer borrows an answer for a `tasks/get`.** Warn's
  tolerance is the next unused recording of the same method, and for a poll that
  recording is an answer carrying another task's id and state. Handing it over
  told the client its own task had reached a state it never reached, which is
  the same lie `tasks/update` already refused.

  *What you see:* under `--on-miss warn`, a poll that found no recording of its
  own used to receive another task's state and now receives the JSON-RPC miss
  error, with the reason on stderr. Only a session recording more than one task
  could borrow in the first place, since a single task's polls all share one
  fingerprint. The exit code is unchanged: warn still exits 0.

  *What to do:* re-record the session so it holds the polls the client makes. If
  the recording stopped while the task was still running, the miss names the
  task id and the status it stopped on, which is what to run longer.

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

- **The safety lint now reads prompts, resources and resource templates, and
  its new findings fail the stricter gates.** Every `CAS-L` finding on one of
  these surfaces is reported at `warn`, whatever level its rule carries, so the
  default gate (`check --fail-on error`, and the action with no `lint-fail-on`)
  is unchanged: a server that passed yesterday passes today.

  *What you see:* new `warn` lines naming a prompt, a resource URI or a URI
  template instead of a tool, on servers that advertise those capabilities.

  *What to do:* nothing, unless you run one of the two stricter gates, which do
  fail on them. `check --fail-on warn` gates every finding, and the action's
  `lint-fail-on: warn` gates the `CAS-L` set alone. Both go red on a prompt or
  resource that trips a rule. Fix the text, or move that job to the default
  gate while you work through the findings. `lint-fail-on: never` reports them
  all and gates on none, as before.

  These findings graduate to their rule's own level no earlier than the next
  minor, which is the discipline CONTRIBUTING states for a rule pointed at a
  surface it did not scan before. Which of them graduate is an open decision
  with measurements behind it, in [BACKLOG.md](BACKLOG.md); a resource name is
  not a sentence, and the rules that read it as one fire on ordinary listings.
  That graduation gets its own bullet when it lands.

- **`LintFinding.toolName` is now `LintFinding.subject`, and the type carries a
  `kind`.** A finding may be about a prompt or a resource, and a field called
  `toolName` holding a prompt's name is a lie the compiler used to help tell.
  `kind` says which of `tool`, `prompt`, `resource` and `resource-template` the
  subject names. Only callers of the programmatic `lintTool` are affected; the
  CLI and its JSON have always called this field `subject`.

### Added

- **The `io.modelcontextprotocol/tasks` extension replays.** A `tools/call`
  answered with a task handle (`resultType: "task"`) hands that handle back, and
  the `tasks/get` polls for one task id share a fingerprint, so they come out of
  one pool in the order the recording holds them. The interval a client polls at
  therefore never matters, and polling fewer times than the recording did is a
  client that stopped early rather than a failed session.

  Past the last recorded poll, the extension's terminal states decide.
  `completed`, `failed` and `cancelled` do not change, so the final recorded
  answer is served again for every further poll, without being consumed: that is
  what the extension says is true of a finished task, and it is what answers a
  client which persisted its task id and came back after its own restart, for as
  long as the replay holding the recorded sequence outlived it. A recording
  that stopped while the task was still `working` has no later state to give, so
  a further poll is a miss naming the task id and the status it stopped on,
  rather than an endless `working` a completion check would spin on.

  Both halves hold whichever shape the recorded server answered a poll in. Over
  HTTP an answer arrives as a stream unless the server was configured to send
  JSON, which is not the default, so most recorded polls are `chunks` entries
  rather than plain frames; replay reads the task's state out of either, and
  re-serves a terminal answer in the shape the recording holds it in, a stream
  as that stream.

  `tasks/update` needed no rule of its own: it carries `inputResponses`, the
  same field an MRTR retry carries, so it is already matched on the input it
  carried and never borrows another recording's acknowledgment, under
  `--on-miss warn` too. Neither did `notifications/tasks`, which is a
  server-initiated notification on a `subscriptions/listen` stream and is
  replayed by the position rule 0.6.0 introduced, re-keyed to the subscription
  id the client's own listen request carried.

  *What you see:* a session that used to exit 1 on the poll after a completed
  task now exits 0 and gets the recorded answer. A test that asserted on that
  miss needs updating.

- **The safety lint covers every model-facing text a server publishes, not just
  tool descriptions.** `check` runs the same `CAS-L` rules over prompt
  descriptions and prompt argument descriptions, over resource names, titles
  and descriptions, and over resource templates, which it now lists. A resource
  name is read because it is display text: the specification has it stand in
  for `title` when none is given, and `resources/read` is keyed by `uri`, so
  the name is never what a client calls with. A prompt name is not read,
  because it is what `prompts/get` is called with.

  Findings name their subject the way its protocol does: a prompt by name, a
  resource by URI, a template by its URI template. In SARIF the subject kind
  joins the fingerprint, so a prompt and a tool that share a name stay two
  alerts; a tool finding's fingerprint is unchanged, down to the hex. A server
  that advertises `resources` and then fails `resources/templates/list` in any
  way, method-not-found included, is not reported: having no templates is not a
  fault.

  `lintPrompt` and `lintResource` are exported beside `lintTool`, with the
  `SubjectKind`, `Prompt`, `PromptArgument` and `Resource` types, so a caller
  of the programmatic API can lint the new surfaces and name the type
  `CheckFinding.kind` carries.

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

### Changed

- **`verify` skips the calls whose task handle died with the recording.** A
  recorded `tasks/get`, `tasks/update` or `tasks/cancel` names the task id the
  recorded server minted. Re-firing it at a live server asks about a task that
  server has never heard of, so the answer was an error about an unknown handle
  reported as drift. Those pairs are left out now, the way `initialize` already
  was, and the `tools/call` that created the task is still re-fired. Inside a
  task handle (`resultType: "task"`), `taskId`, `pollIntervalMs` and
  `lastUpdatedAt` are treated as volatile the way `_meta` and `ttlMs` are
  everywhere, so a freshly minted handle is not reported as a change either.
  The exemption follows the handle rather than the key name: a `tools/call`
  whose ordinary result carries a `taskId` of its own is returning data, and a
  value that moved there is still reported as drift.

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

[0.8.0]: https://github.com/ivermin1123/mcp-cassette/releases/tag/v0.8.0
[0.7.0]: https://github.com/ivermin1123/mcp-cassette/releases/tag/v0.7.0
[0.6.0]: https://github.com/ivermin1123/mcp-cassette/releases/tag/v0.6.0
[0.5.0]: https://github.com/ivermin1123/mcp-cassette/releases/tag/v0.5.0
[0.4.1]: https://github.com/ivermin1123/mcp-cassette/releases/tag/v0.4.1
[0.4.0]: https://github.com/ivermin1123/mcp-cassette/releases/tag/v0.4.0
[0.3.0]: https://github.com/ivermin1123/mcp-cassette/releases/tag/v0.3.0
[0.2.0]: https://github.com/ivermin1123/mcp-cassette/releases/tag/v0.2.0
[0.1.2]: https://github.com/ivermin1123/mcp-cassette/releases/tag/v0.1.2
[0.1.1]: https://github.com/ivermin1123/mcp-cassette/releases/tag/v0.1.1
[0.1.0]: https://github.com/ivermin1123/mcp-cassette/releases/tag/v0.1.0
