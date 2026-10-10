# Cassette format v2: design sketch

Status: **format implemented** as firmed up by
`docs/design/http-record-replay.md`. `src/cassette.ts` writes v2 (header
`era`/`url`/`sessioned`, `chunks[]`, `http.status`) and reads v1 forever. The
HTTP record/replay behavior that fills these fields lands over the v0.3 PR
sequence; `state`/`seq` below remains a sketch. This document is kept as the
rationale for the shape.

## Why plan v2 now

Three pressures are visible from the v1 shape:

1. **Streamed results.** The MCP roadmap points toward streamed/partial tool
   results. v1 stores exactly one response frame per request id; a streamed
   result is many chunks that only together form the response. This is the
   single biggest format risk, so v2 reserves its shape first.
2. **Lifecycle eras.** Servers currently speak the classic lifecycle
   (`initialize` → `notifications/initialized` → requests); the 2026-07-28
   revision sketches a stateless one. Replay and verify need to know which
   world a cassette was recorded in without sniffing frames.
3. **Scenario states.** VCR-style workflows want one cassette to answer the
   same request differently as a scenario progresses ("first call fails,
   retry succeeds" is today only expressible through recorded-order pools).

## Shape

v2 keeps everything that made v1 workable: an open, append-only JSONL file,
one JSON object per line, header first. A v2 file is a v1 file with a bumped
version and new, optional fields. No field of v1 is renamed or removed.

### Header

```jsonc
{
  "type": "header",
  "cassetteVersion": 2,
  "recorder": "mcp-cassette@0.2.0",
  "startedAt": "2026-08-15T09:00:00Z",
  "transport": "stdio",
  "command": ["npx", "-y", "some-server"],
  "redaction": { "applied": true, "configHash": "9f86d081..." },

  // NEW: which lifecycle the recorded session spoke.
  //   "legacy": classic initialize handshake (every v1 cassette is this)
  //   "modern": the stateless lifecycle, once the spec ships it
  "era": "legacy",

  // NEW: request fields that change every run, as JSON Pointers into the
  // request `params`. See "Declared volatility" below.
  "volatile": ["tools/call:/arguments/requestedAt"]
}
```

`era` tells replay whether to expect (and verify whether to perform) an
initialize handshake. Readers treat a missing `era` as `"legacy"`, which is
also the v1→v2 migration rule.

### Frame entries

Unchanged from v1:

```jsonc
{ "type": "frame", "t": 1204, "dir": "c2s", "frame": { /* JSON-RPC */ } }
{ "type": "raw",   "t": 1210, "dir": "s2c", "data": "non-JSON-RPC line" }
```

Two optional fields join them:

```jsonc
{
  "type": "frame",
  "t": 1204,
  "dir": "s2c",
  "frame": { /* JSON-RPC */ },

  // Already written by v1's `replay --on-miss passthrough` (spy mode):
  // marks interactions captured live after the original recording.
  "origin": "live",

  // NEW: scenario state (see below).
  "state": "after-first-failure",
  "seq": 3
}
```

### `chunks[]`: streamed results

When a response arrives as a stream, the single `frame` field cannot hold it
without inventing a merged payload that never existed on the wire. v2 reserves
a `chunks` entry type for this:

```jsonc
{
  "type": "chunks",
  "t": 1204,
  "dir": "s2c",
  "id": 7,                    // the request id the stream answers
  "chunks": [
    { "t": 1204, "frame": { /* partial/notification frame as sent */ } },
    { "t": 1290, "frame": { /* ... */ } },
    { "t": 1355, "frame": { /* final frame that completes the response */ } }
  ]
}
```

The HTTP recorder writes these today, and the HTTP replayer serves them: an SSE
answer becomes one `chunks` entry when its stream ends, with two fields the
sketch did not name. `id` is absent on the legacy standalone GET stream, which
answers no request; `via` is `"post"` by default and then omitted, `"get"` for
that GET stream. `docs/design/http-record-replay.md` §1.3 is the authority on
both.

On replay, an id-bearing entry is emitted as SSE and the stream closes after its
final frame; only that final frame is re-keyed to the incoming request id, so a
progress notification is replayed exactly as recorded. A `via:"get"` entry is
served on GET and held open, because it answered no request and so completes
none. A cassette may hold more than one `via:"get"` entry, because a session can
open the standalone stream more than once, but there is only one endpoint to
serve them from, so replay serves the first and says so on stderr rather than
choosing in silence.

`replay --on-miss passthrough` appends `chunks` entries too, carrying
`origin:"live"`, when the live answer arrived as a stream.

Design intent, firmed up in §1.3 of that document:

- Each chunk stores the frame **as it appeared on the wire** (after redaction),
  so the cassette stays a transcript rather than an interpretation. SSE event
  ids, `retry` fields, and keep-alive comment lines are parsed and dropped: the
  modern era deleted resumability, and comment lines are data-free by
  definition.
- Replay of a `chunks` entry emits every chunk in order (optionally honoring
  the recorded timing offsets), so streaming clients exercise their real code
  path.
- Verify treats the final chunk as the response payload for diffing and may
  compare chunk counts as a shape check.
- A v2 reader that predates streamed-results support may refuse `chunks`
  entries with a clear "recorded with a newer mcp-cassette" error. It can still
  parse the file, because unknown entry types are skippable by design.

### Server-initiated frames: the position rule

A recording also holds frames the server sent on its own: an unsolicited
`notifications/*/list_changed` or a `resources/subscribe` update in the legacy
era, and in the 2026-07-28 era the acknowledgment and change notifications of a
`subscriptions/listen` stream. None of them answers a request, so nothing in the
file says when replay should send one. The format does not add a field for it;
the order the file already carries is the answer:

> A server-initiated frame is anchored to the last client request whose answer
> preceded it in the recording, and replay emits it immediately after it answers
> that request. A frame recorded while a request was still outstanding belongs
> to that request instead, and is emitted immediately before its answer. A frame
> anchored to a request the client never sends is reported, not emitted.

The second sentence is what keeps a request's own `notifications/progress`
where it belongs. On stdio those frames sit between the request and its
response, so the first sentence alone would send a call's progress out before
the client had even sent the call. "Outstanding" means a request the recording
goes on to answer: one the server never answered has no answer for anything to
precede, so it holds nothing back and every later frame keeps the position it
would have had without it.

Four consequences are worth stating, because they are what the rule costs:

- The anchor is the recorded answer itself, not its fingerprint. A cassette that
  recorded the same call three times releases the frames of the third recording
  when the third call is answered.
- `subscriptions/listen` is anchored by its acknowledgment
  (`notifications/subscriptions/acknowledged`), which is what answers it. The
  recording usually holds no JSON-RPC response for the listen request, because
  the server sends one only when it ends the subscription gracefully; when it
  does, that response is itself a server-initiated frame at its own position,
  and emitting it ends the stream.
- `io.modelcontextprotocol/subscriptionId` is re-keyed to the id the client's
  own listen request carried, exactly as a recorded response is re-keyed to the
  incoming request id. The recorded value belongs to a session that is over.

- Position is read from `t` first and from file order only to break ties. An
  HTTP recording writes a whole stream as one `chunks` entry when the stream
  closes, while each chunk carries the `t` it arrived at, so file order alone
  would place every frame of a long-lived stream after requests it preceded.

Over HTTP a frame that names `io.modelcontextprotocol/subscriptionId` goes on
that subscription's stream or on none: handing it to another open stream would
tell that client its own subscription had fired. When no stream is open to carry
a frame that came due, replay counts it and says so at session end rather than
emitting it somewhere else.

Two kinds of s2c frame are deliberately outside the rule. The notifications
inside an ordinary id-bearing `chunks` entry are request-scoped
(`notifications/progress`, `notifications/message`) and travel with the stream
that answers their request, which is what 2026-07-28 says they do. And a
server-to-client *request* (legacy sampling, elicitation, roots) is not
replayed at all: replay counts them and says so, because originating a request
means consuming the client's answer to it, which is a different machine.

### Tasks: a sequence is the answer

The `io.modelcontextprotocol/tasks` extension is the one place where the answer
to a request is a sequence rather than a value. A server that will take a while
answers with a task handle (`resultType: "task"`), and the client polls
`tasks/get` until the status is terminal.

Nothing in the format changes for it, and nothing in it depends on how the
answers were recorded: a poll answered with JSON is a `frame` entry and one the
server streamed is a `chunks` entry, and the rule below reads the task's state
out of either. Every poll for one task carries the same params, so they share a
fingerprint and come out of one pool in recorded order, which is why the
interval a client polls at never matters: it sees the recorded state sequence
one state per poll, and reaches the recorded end on the poll the recording ended
on. Polling fewer times than the recording did is a client that stopped early,
not an error.

What needs a rule is the poll *after* the last recorded one, and the extension's
terminal states answer it:

> Once the recorded sequence for a task id ends in a terminal status
> (`completed`, `failed` or `cancelled`), that last answer is served again for
> every further poll, without being consumed, in the shape the recording holds
> it in: a streamed answer is re-served as that stream, a JSON one as JSON. If
> the recording ended on a non-terminal status, a further poll is a miss whose
> reason names the task id and the status the recording stopped on.

A finished task is still finished, so re-serving its answer is the faithful
thing and not a tolerance: it is also what answers a client that persisted the
task id and came back after its own restart, for as long as the replay holding
the recorded sequence is still running. A replay restarted alongside the client
has every recorded poll left, so the same id reads that sequence from its start.
A recording that stopped mid-task holds no later state, and inventing one would
tell the client a build finished that never did, so the miss says to re-record
for longer instead.

Under `--on-miss warn` a poll is one of the requests that never borrows. Warn's
tolerance is the next unused recording of the same method, and for `tasks/get`
that recording is an answer about a different task: handing it over would tell
the client its own task reached a state it never reached. So a poll past a
non-terminal recording misses under warn exactly as it does under error, and
says why.

Two neighbouring methods need no rule of their own. `tasks/update` carries the
client's `inputResponses`, which puts it under the same matching as an MRTR
retry: it is matched on the input it carried and never borrows another
recording's acknowledgment, because the rest of the task was built on the answer
that was actually given. And `notifications/tasks` is a server-initiated
notification on a `subscriptions/listen` stream, so it is replayed by the
position rule above like any other, tagged with the subscription id the client's
own listen request carried. Replay does not interpret the subscription filter;
it matches the listen request's params as recorded.

### `redaction.configHash`: which rules wrote this file

Redaction is configurable (`--redact-config <file>`), and a custom rule changes
what a recorded string says. It also changes what a fingerprint means, because
replay redacts an incoming request before matching it: a rule that ran at record
time and not at replay time leaves the recorded side hashed over a placeholder
and the live side over the secret itself, and every request misses for a reason
the near-miss diff cannot explain, since it names a field whose recorded value
is a placeholder and whose live value is the value.

So a recording made under a config carries a hash of that config:

```jsonc
{
  "type": "header",
  "redaction": { "applied": true, "configHash": "<sha256 of the canonical config>" }
}
```

The rules this carries, and what it costs:

- `mcp-cassette lint <cassette>` checks the shape, not the value: a
  `configHash` that is not 64 lowercase hex characters is not a digest `redact`
  ever wrote, so it can only ever mismatch, and saying so at lint time is
  cheaper than finding out at replay time. The finding is a `warn` and does not
  change `lint`'s exit code. Whether the hash is the *right* one is a question
  only the config itself can answer, which is why replay still asks it.
- Only the hash is stored. A regex describes the secrets it catches and an
  allowed value is a value, and neither belongs in a file meant to be committed.
  The hash does not contain them, but it is not a secret either: an unsalted
  sha256 of a small JSON document is a verification oracle, so anyone with a
  candidate config can confirm it offline. Put only values that are already
  public in `allow`.
- The canonical form is what the config *does*, not how it was written, because
  tidying the file must not turn every cassette recorded under it into a
  different config. `keys` are lowercased, which is how matching compares them,
  then deduplicated and sorted; `allow` is deduplicated and sorted but never
  lowercased, because it is compared exactly; a pattern's flags are sorted,
  because `RegExp` does not care in which order they were written; and
  `patterns` keep their order, because order decides which rule claims an
  overlapping match. So reformatting, reordering `keys` or `allow`, changing the
  case of a key or writing `iu` as `ui` all leave the hash alone, while
  reordering the patterns changes it. The regex source is taken as written: two
  spellings of one language (`\d` and `[0-9]`) hash differently, which is the
  one place this is stricter than behaviour.
- A config that declares nothing produces no hash, so an empty config file is
  the same as no config file.
- Replay refuses a mismatch and says which side is short one: a cassette
  recorded with a config and replayed without it, replayed with one it was not
  recorded with, or replayed with a different one.
- A `--no-redact` recording carries no hash, because it ran under no rules at
  all, and the CLI refuses the two flags together rather than letting one
  silently win.
- `redact` refuses to rewrite a cassette that already names a config under any
  other config, including none. The frames would otherwise correspond to no
  single config while the header claimed one, which is the exact file replay
  would accept and then miss on.
- An older mcp-cassette ignores the field and replays with the built-in rules,
  so a custom-redacted request misses there with a diff naming the placeholder
  against the live value.
- Absent on every cassette recorded on the built-in rules alone, which is every
  cassette written before the field existed.

### Declared volatility

Replay matches exactly, which is what makes a cassette a test double rather
than a guess. The cost is a request field that changes every run: a timestamp
the client stamps, an id it generates. Nothing about such a field identifies
the request, and matching on it turns every run into a miss.

`volatile` is how a cassette says which fields those are:

```jsonc
{
  "type": "header",
  "volatile": [
    "/arguments/requestedAt",
    "tools/call:/arguments/runId"
  ]
}
```

Each entry is a JSON Pointer into the request's `params`, optionally scoped to
one method by naming that method before a colon. A JSON Pointer always starts
with `/`, which is what tells the two forms apart with no ambiguity: an entry
that does not start with one must name a method first, and a `:` inside a
pointer is an ordinary character. `replay --volatile <pointer>` is the same
declaration passed per invocation, repeatable, and the two are added together:
the cassette carries what is true of the recording, the invocation adds what is
true of this run.

The rules worth stating, because they are what the field costs:

- The declaration is dropped from both sides before anything is hashed, the
  recorded request as the index is built and the live one as it arrives. A
  declaration that only moved the live side would match nothing.
- A pointer that resolves to an object property removes it; one that resolves
  to an array element blanks that element rather than splicing it out, so two
  declared indices of one array cannot re-index each other.
- A pointer that resolves to nothing is a no-op, which is what lets one
  declaration cover a field some calls carry and others do not.
- The miss diagnosis drops them too, so a miss never names a field the session
  already said would move: the paths it reports are the ones that really
  diverged.
- Nothing else bends. An MRTR retry still matches on the `inputResponses` it
  carried and still never borrows; a `tasks/get` still pools per task and still
  obeys the terminal rule; `subscriptions/listen` still matches its own params.
  A declaration decides what the fingerprint is computed over, not which rule
  computes it.
- Which is why a declaration naming a field replay matches a rule on is refused
  rather than honoured: `/name` and `/inputResponses` on a `tools/call`,
  `/taskId` on a `tasks/get`, and `/inputResponses` and `/requestState` on any
  method, since those are the fields telling a retry from the call it retried
  wherever they appear.
  Erasing one of them changes which rule runs, and the request is then answered
  with another tool's, another retry's or another task's recording with nothing
  on stderr. The same names stay declarable on a method that does not match on
  them (`prompts/get:/name`, `tasks/update:/taskId`), and so does a field of the
  same name further down a pointer (`tools/call:/arguments/name`).
- `mcp-cassette lint <cassette>` checks the list without replaying anything: it
  must be a list of strings, and each one goes through the parser above, so a
  declaration malformed by hand is named in a file you can open instead of
  failing inside whatever process a replay was spawned in. The finding is a
  `warn` and does not change `lint`'s exit code. A `null` is read as an absent
  field and reported as nothing, because that is what replay does with it; the
  lint reports what replay would refuse, and a finding on a cassette that
  replays cleanly is a finding nobody can act on.
- A reader that predates the field ignores it, because an unknown header field
  has always been ignorable. Such a reader matches on the declared fields
  again, so a request whose timestamp moved misses there.

### `state` / `seq`: scenario states

v1 answers repeated identical requests from an ordered pool, which encodes
"first call, then second call" implicitly. v2 makes progression explicit:

- `state` (string, optional): the named scenario state this interaction
  belongs to (`"initial"` when absent).
- `seq` (number, optional): total order of interactions within a state, for
  writers that append out of wire order (a passthrough spy writing while the
  original recording already occupies earlier lines).

A future `replay --scenario` can then start in `initial` and move between
states via an explicit trigger: a control request, or "state advances when its
pool is exhausted", to be decided. Without `--scenario`, replay ignores both
fields and behaves exactly like v1, because the fields are annotations rather
than a new matching engine.

## Backward compatibility principles

These are the commitments; everything above is negotiable detail.

1. **v1 files never break.** Every reader that understands v2 must read v1
   files forever. v1 has no `era`: readers assume `"legacy"`.
2. **Additive, never destructive.** v2 adds fields and entry types; it never
   renames, removes, or re-types a v1 field. A v1 cassette is byte-for-byte a
   valid v2 cassette except for the version number.
3. **Unknown is skippable.** Readers skip entry types they don't recognize
   (warning, not error), exactly like v1 readers already ignore anything that
   is not `frame`/`raw`. This is what lets `chunks[]` land later without a
   version bump.
4. **JSONL, append-only, header-first stays.** Spy-append, `git diff`-ability,
   and stream-parsing all depend on it.
5. **One version bump, once.** We bump `cassetteVersion` to 2 when the first
   v2-only field ships (likely `era`), not per-field. Until then, additive
   optional fields (like `origin`) ride on v1, as `origin:"live"` already does.
