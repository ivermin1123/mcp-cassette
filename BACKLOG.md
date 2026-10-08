# Backlog

Decisions this project owes itself. Each item is here because it needs an
argument before it needs code, usually because it touches something a consumer
already depends on. Items that are merely "not built yet" belong in the
[README roadmap](README.md#roadmap) or in an issue; these are the ones where
picking the obvious implementation would be the mistake.

---

## The action has no intermediate lint setting: DECIDED

**Raised** 2026-08-16, out of the 0.3.0 release notes. **Decided** 2026-10-08:
a `lint-fail-on: error|warn|never` input, spelled `never` rather than `none`,
carried by a new `check --lint-fail-on` level rather than by the existing
`--fail-on`, plus a release rule that new lint rules ship at `warn` and may not
graduate to `error` for one minor release and four weeks. Kept here for the
measurement and for the mechanisms not taken.

**The decision, and the three questions it had to answer.**

*Does it overlap `mode: snapshot`?* No, and the overlap was the reason to build
it. `mode: snapshot` removes the report along with the gate; `never` keeps the
check running, the findings in the log, and the pull-request comment, which
names the gate it passed under so a green verdict over a log full of findings is
accountable rather than confusing.

*What exactly may it waive?* The `CAS-L` description lint, and nothing else.
That is the only part of a check that is an opinion about text an attacker
wrote. A `CAS-C` finding is the other kind: a duplicate tool name or an
`inputSchema` that is not valid JSON Schema is the server being broken, so it
still fails at `never`. So does a server that could not be inspected at all,
which exits 2 at every level, because a run that produced no report has nothing
to waive. Without that boundary an input named for the lint would be a mute
switch for the health check, which is the one thing it must not become.

*Is this release discipline's job instead?* It is both, and the discipline is
the upstream half. The input alone would have left every rule-adding release an
ultimatum that consumers answer under deadline pressure. The rule written into
[CONTRIBUTING.md](CONTRIBUTING.md) is what stops the cliff from forming; the
input is what the consumer who already hit one reaches for.

**The mechanisms not taken.**

- *Swallowing exit 1 in the action's gate step, leaving the CLI alone.* It
  cannot tell a waived lint finding from a structural error or from any future
  non-lint exit 1, which is exactly the boundary above. It would also give the
  action a level the CLI cannot express, so `mcp-cassette check` run locally
  could no longer reproduce what CI did.
- *A third level on the existing `check --fail-on`.* Rejected once the boundary
  was clear: `--fail-on` spans every finding, so a `never` on it would waive
  `CAS-C` too. `--lint-fail-on` is its own flag, defaulting to `--fail-on` so
  that `--fail-on warn` keeps gating lint warnings exactly as it did before.

**The original entry, kept because the measurement is what argued for this:**

A consumer of the composite action meeting a new lint rule has exactly two
moves: swallow the whole rule set, or drop the lint from the gate with
`mode: snapshot`. There is nothing between them.

`fail-on` looks like the knob and is not. [`action.yml`](action.yml) passes it
only to `snapshot --check` (the drift tiers `breaking`/`dangerous`); the lint
step runs `$CLI check` bare, so its gate is fixed at error level. On the CLI the
equivalent only tightens: `check --fail-on warn` adds warnings, and there is no
looser setting.

So every release that adds an `error`-level rule is a hard adoption cliff for
anyone who cannot fix all findings that day, and their only escape drops the
safety check entirely, which is the opposite of what they want. 0.3.0 shipped
three such rules.

**Sketch, to be argued rather than assumed:** a `lint-fail-on` input taking
`error｜warn｜none`, passed through to `check`, so a rule set can be adopted
gradually. *(Shipped as `error｜warn｜never`: `none` reads as "no gate
configured", which is the opposite of what the value asks for.)*

**Why this is a design checkpoint:**

- It lands in consumers' CI policy. An input that can disable a safety gate is
  something people reach for under deadline pressure and then forget.
- `none` overlaps `mode: snapshot`, so two spellings would exist for nearly the
  same outcome. One of them should win.
- It interacts with how new rules are introduced. If a rule can always land at
  `warn` and graduate later, the input may be solving a problem that release
  discipline should solve instead.
- Whatever ships becomes a public input, and inputs are contracts.

**Related:** [rule table](README.md#safety-lint-rules), `action.yml` inputs,
the v0.3.0 release notes.

---

## The `v*` tag trigger is wider than the releases it is for

**Raised** 2026-08-16, observed while cutting `v0.3` by hand.

[`release.yml`](.github/workflows/release.yml) triggers on `push: tags: ['v*']`,
which matches the floating tags (`v0`, `v0.3`) as well as real release tags
(`v0.3.0`). Pushing a float by hand therefore starts a Release run that cannot
succeed: `Verify tag matches package.json version` compares `0.3` against
`0.3.0`, fails, and stops.

**Measured, not assumed.** The failure is safe: it lands on the first gate,
before `npm test`, `npm publish`, the GitHub Release, and the float move, all of
which were skipped ([run 31940214098](https://github.com/ivermin1123/mcp-cassette/actions/runs/31940214098)).
And it only happens for a *hand* push: across the last 20 Release runs there is
no run for ref `v0`, though `v0` has been force-moved on four releases, because
a push made with `GITHUB_TOKEN` does not re-trigger workflows. The workflow
moving its own floats is invisible to itself; a maintainer moving one is not.

So the cost today is one red run in the Actions history per manual float cut.
Noise, not risk.

**Directions, none chosen:**

- **Narrow the pattern** to full versions (`v[0-9]+.[0-9]+.[0-9]+*`). Removes the
  noise, and also removes the version gate's protection from anything the
  narrowed pattern no longer matches: a typo'd tag would simply do nothing
  instead of failing loudly.
- **Accept the noise** and document it, treating the red run as proof the
  version gate works. Costs nothing but leaves a permanent "is the release
  broken?" question for anyone reading Actions.
- **Keep the trigger and exit early** on a tag that is not a full version, so
  the run goes green-and-skipped rather than red.

**Why this is a design checkpoint:** it is the release path. A change here is
only exercised by cutting a real release, so it cannot be dry-run. That is the
same constraint that let two defects ship in the v0.2.0 release job. Any edit needs
the extract-and-stub verification described in
[CONTRIBUTING](CONTRIBUTING.md#changing-releaseyml).

---

## The same-method fallback answers a different request: DECIDED

**Raised** 2026-10-08, found while fixing MRTR retry matching. **Decided**
2026-10-08: the fallback moves behind `--on-miss warn`, out of the default, for
0.5.0. Kept here for the measurement and for the direction not taken.

**The decision.** Matching is exact under `error` (the default) and
`passthrough`. `warn` keeps the tolerance and stops hiding it: every borrowed
answer prints the paths that diverged, and the session summary counts them. A
suite that relied on the silent fallback finds out on its first 0.5.0 run and
has a one-flag way back. The deciding fact was the reality check of the same
day: no external user was found, so this is the cheapest moment the default
will ever have to become honest. Declared volatility stays on the roadmap as
the precise version of the same tolerance, for when someone asks for it.

When a request's exact fingerprint was never recorded, `matchResponse` served
the next unconsumed recording of the same *method* before it reported a miss.
For `tools/call` that meant another call's answer, whatever its arguments.

**Measured, against published 0.4.0.** A cassette holding one call,
`add {a:1, b:2}` answered `"3"`. Replayed with `add {a:5, b:5}` and then
`add {a:1, b:2}`:

- `add {a:5, b:5}` got `"3"`, with nothing on stderr;
- `add {a:1, b:2}`, the call that *was* recorded, then missed as "exhausted";
- the session exited 1, blaming the right call for the wrong one's answer.

Under `--on-miss warn` the same session exited 0. The fallback also swallowed
a miss before passthrough saw it: a recorded `tools/call` of any tool answered
a call to a tool the recording never saw, so `--on-miss passthrough` never
forwarded it. And when the borrowed answer was an MRTR `input_required`, it
handed the client a `requestState` the live server never minted; under
passthrough the retry that followed was forwarded with it, and a server that
checks its state rejects the call.

**Why it existed:** it tolerates arguments that change every run (timestamps,
generated ids) without the user configuring anything. That is a real need, and
removing the fallback outright would have turned those suites red with no way
back.

**Directions that were on the table:**

- **Keep it, make it loud:** a stderr line per fallback answer, naming the
  paths that differed. No exit-code change. Cheapest, but a test that passes on
  a wrong answer still passes. *(Taken for `warn` only.)*
- **Count it as a miss** in `--on-miss error`, keeping the answer. Turns
  today's silent wrong answers red, and with them every suite relying on the
  tolerance. *(Superseded: once it is a miss, answering with the error is the
  honest answer.)*
- **Replace it with declared volatility:** `--volatile <json-pointer>` (or a
  cassette-header list) that `fingerprint` drops, and no fallback at all. The
  honest version, and a new public input. *(Not taken yet; on the roadmap.)*

MRTR retries were already outside the fallback, in both directions, because a
retry's answer is bound to the input it carried, and they stay outside it under
`warn`.

**Related:** `src/replay.ts` (`matchResponse`, `matchFallback`), the `replay`
row in the README, CHANGELOG 0.5.0.

---

## `subscriptions/listen` cannot be replayed: DECIDED

**Raised** 2026-10-08, from the 2026-07-28 revision. **Decided** 2026-10-08:
the owner chose the faithful direction, *replay the notifications too*, at their
recorded position relative to the client's requests. Shipped in the Unreleased
section of [CHANGELOG.md](CHANGELOG.md); the position rule is in
[`docs/cassette-format-v2.md`](docs/cassette-format-v2.md) and narrated on
[the replay page](https://mcpcassette.dev/replay/).

2026-07-28 replaced unsolicited change notifications with `subscriptions/listen`:
one long-lived request, acknowledged by a `notifications/subscriptions/acknowledged`
notification, then followed by change notifications tagged with the
subscription id. The request is answered only when the *server* ends the
subscription gracefully, so a recording almost always holds the request with
no response.

**Measured:** replay skips unanswered requests when it builds its index, so the
listen request is a miss (`no recorded request has method
"subscriptions/listen"`, which is also wrong: it was recorded, just never
answered), and the session exits 1 under `--on-miss error`. Server frames that
are not responses are already skipped on stdio (`N server-initiated frame(s) ...
are not replayed`), so the acknowledgment never arrives either.

The official TypeScript client, `@modelcontextprotocol/client` 2.3.1, opens
this subscription on its own only when `ClientOptions.listChanged` is
configured and the server advertises `listChanged`; when it fails, the client
reports through `onerror` and carries on. So that client survives the miss, and the session still fails at exit.

**Directions considered:**

- **Acknowledge and hold:** answer a recorded listen request with its recorded
  acknowledgment and keep it open, replaying no change notifications. Small,
  and makes the miss go away honestly. *(Not taken: it fixes the exit code
  without making the client testable, which was the point.)*
- **Replay the notifications too**, at their recorded position relative to the
  client's requests. The faithful version, and the first time replay would
  originate frames on its own schedule. **Chosen.**

**What shipped:** a listen request is answered by its recorded acknowledgment
and held open; every server-initiated notification is anchored to the last
client request whose answer preceded it and emitted right after replay answers
that request, on stdio and on both HTTP stream kinds; the subscription id is
re-keyed to the client's own listen id; a frame whose anchor the client never
sends is reported rather than emitted out of place. The miss message for a
request the recording holds with no response now says that, instead of claiming
the method was never recorded. Server-to-client *requests* (legacy sampling,
elicitation, roots) are still not originated, and are counted and named.

**Proof:** `@modelcontextprotocol/client` 2.3.1 with `ClientOptions.listChanged`
configured received the change notification from the replay alone, in both
eras, with no server process running.

**Related:** `buildReplayIndex` in `src/replay.ts`, `http-replay.ts` stream
emission, the README roadmap's server-initiated flows.

---

## Four limits left by server-frame replay

**Raised** 2026-10-08, from the review of the change that made replay originate
server frames. None of these is a regression: each is either a case that change
did not cover or a pre-existing behaviour it made easy to reach. They are
recorded here rather than fixed because each needs an owner decision about
scope, not a patch.

### Replay does not honour `notifications/cancelled` on a subscription

A client that opens a `subscriptions/listen` and then cancels it, which on stdio
means sending `notifications/cancelled` naming the listen request id, keeps
receiving that subscription's recorded notifications until the cassette runs
out. Replay treats every client notification as `silent` (`resolveFrame` in
`src/replay.ts`) and has no cancellation state.

**Measured:** no test covers it, because no fixture cancels. The recorded
sessions this was built against never cancelled either, so a cassette that would
exercise the fix does not exist yet.

**Cost:** roughly five lines in `resolveFrame` to drop the live mapping, plus a
fixture that cancels. The reason to wait is that a recording whose client
cancelled would also hold whatever the server did next, and it is not yet clear
whether replay should stop at the cancellation or follow the recording past it.

### `--on-miss passthrough` on an unrecorded listen stalls the whole session

A `subscriptions/listen` the cassette does not hold is an ordinary miss, and
under `passthrough` a miss is forwarded through `MiniClient.relay`, which waits
for a JSON-RPC response. A real server answers a listen only when it ends the
subscription gracefully, so the forward does not return.

**Measured:** the stdio front-end serialises every frame behind the in-flight
forward (the `queue` chain in `runReplay`), so the stall is not confined to the
listen: the session answers nothing after it. An official SDK client configured
with `ClientOptions.listChanged` opens that listen on its own, without the
caller asking for it, which is what makes this easy to hit.

**Pre-existing:** the same holds for any request a server never answers, and did
before server frames were replayed. The fix is a timeout or a method list that
passthrough refuses to forward; both are a behaviour decision.

### `record` keeps only the last connection when a client probes on a throwaway one

The official SDK in `versionNegotiation: { mode: { pin } }` opens one connection
for the `server/discover` probe and a second for the session. Each connection
spawns its own `record` process against the same output path, and the second one
under `--mode all` truncates the first.

**Measured 2026-10-08:** recording a pinned modern session produced a cassette
whose first entry was `subscriptions/listen`; the probe exchange was gone, and
replaying it failed the client's negotiation with `the server did not offer
pinned protocol version 2026-07-28 via server/discover`. Splicing the probe pair
back in by hand made the replay work. Under the default `--mode once` the second
spawn instead refuses to start, which fails the session with a clearer message
but is no more usable.

**Related:** `ensureWritable` and `CassetteWriter` in `src/record.ts`. An append
mode, or a per-connection suffix, would fix it; both change what a cassette path
means.

### A frame recorded with two requests in flight is attributed to the wrong one

The position rule parks a frame recorded while any answerable request is
outstanding and releases it before whichever answer lands first
(`scheduleServerFrames` in `src/replay.ts`). With requests A and B both in
flight, a `notifications/progress` for B recorded in that window becomes B's
frame only if B is answered first; otherwise replay emits it when it answers A,
before the client has sent B.

**Measured:** sequential clients, which is what every fixture and every recorded
session here uses, are exact. The limit shows only with a client that pipelines,
and the recording does carry enough to resolve it: `params._meta.progressToken`
on a progress notification names the request it belongs to.

**Cost:** matching the token is a small follow-up, and it only covers progress.
`notifications/message` carries no such correlation under 2026-07-28, so the
general case stays ambiguous and the rule above stays the fallback.

---

## Schema-diff completeness: CANCELLED

**Raised** 2026-08-16. **Cancelled** 2026-08-16, the same day, after
[`docs/research/01-reality-check.md`](docs/research/01-reality-check.md) measured
the contract-gate feature as occupied: `@kryptosai/mcp-observatory` ships
`lock create` / `lock verify`, five months older and working on a clean install,
and the follow-up check found its workflow is the same one command against one
committed file, so the ergonomic argument for continuing does not survive
either.

**What shipped before the stop**, because both were defect repairs rather than
new surface: the recursive walk with a per-node fallback (a `minor` at the root
was swallowing nested breaking changes), the canonicalisation pre-pass that
stopped reporting reordering as breaking, and a `$ref` guard that refuses to
classify what it cannot resolve. See the Unreleased section of
[CHANGELOG.md](CHANGELOG.md).

**What is cancelled**, from the design's own pairing in
`plans/reports/design-260816-1705-schema-diff-completeness.md`:

- Pair 2: `additionalProperties` tiers, nested `required` families, array
  cardinality, nullability.
- Pair 3: `anyOf` / `oneOf` / `allOf`, constraint direction.
- Pair 4: `outputSchema` rules and the v2 snapshot format migration.

The design's four open questions go with them; none needs an answer now. The
feature that exists keeps working and keeps being maintained; this cancels
further investment, not the command.

### Where the fence is

Frozen does not mean nothing may be touched. It means one thing, and this is the
line:

> **Fixing so it is NO WORSE than 0.3.0 is inside the fence.
> Making it BETTER than 0.3.0 ever was is outside the fence, and not done.**

The rule was written after the first thing to hit it. The recursive walk shipped
with a `$ref` guard that returned early, so a removed parameter went unreported
whenever a reference sat anywhere in the schema. 0.3.0 reports that finding.
Shipping `main` as it stood would have been a **regression against a released
version**, and a freeze is a decision to stop investing, never a licence to ship
one. So it was fixed (#51).

Per-node `$ref` reporting is the other side of the line. The guard reports once
per tool, having scanned the whole schema; now that the walk is recursive it
could report at the node holding the `$ref`, with a JSON Pointer, which would be
a more useful message than 0.3.0 or anything before it ever gave. That is better
rather than not-worse, so it stays undone. It would also change how many findings
a diff produces, which is a real change for anyone counting them in CI. Recorded
so the next reader knows the current shape was chosen, not overlooked.

### Reference data kept out of the tree

`tests/fixtures/contracts/` on the closed #49/#50 holds a small contract corpus
captured from a **real FastMCP server** (`pydantic-nested-server.py` plus three
`.contract.json` snapshots taken across schema edits). Pydantic emits
`$defs`/`$ref` for any nested model, so this is the empirical answer to "do real
MCP servers actually emit references?", and it is the only contract data in
this project not written by hand. `main` proves the `$ref` guard with
hand-written schemas instead.

It was not merged because schema-diff is closed, not because it was judged
unnecessary. Branches get deleted and PR comments are not a durable home, so it
is anchored to tags, which survive branch cleanup:

| Tag | What it holds |
|---|---|
| `corpus/pydantic-2026-08-16` | #50 head: the corpus and the tests written against it |
| `corpus/pydantic-guard-2026-08-16` | #49 head: the corpus and the original guard implementation |

Fetch with `git fetch origin --tags`, then `git show corpus/pydantic-2026-08-16`.
Whoever reopens contract diffing should start from that data rather than
inventing fixtures again.
