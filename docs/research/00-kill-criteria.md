# Kill criteria

## LAW №1 — THIS IS OPEN SOURCE, NOT SOMETHING TO SELL. Read before any analysis.

`mcp-cassette` is OSS (Apache-2.0). Nothing is sold, there is no paying customer,
and there is no revenue in any box below.

**The right measures:**

1. Does anyone **install and use** it — including the owner.
2. What the owner's **time** buys — something usable · something learned · credibility.
3. Does anyone **contribute alongside**.

**Banned as a frame:** "can it be sold" · "is the market big enough" · "customers" ·
"willingness to pay" · "urgent enough to open a wallet" · TAM/segment.

**Use instead:** *"is this LESS TIRING than the way they do it today?"* — that is
the whole adoption barrier for OSS, and it sits far below a purchase barrier.

**Three consequences for evidence, applied to every conclusion in the report:**

- **a. Absence of complaint = WEAK evidence, not counter-evidence.** In OSS people
  install first and complain later, or never. "0 complaints" may not be used on
  its own to kill a direction. The "real demand ≥ 8 cases" threshold (Box E)
  can only **support**; it can never **kill**.
- **b. The competitor to fear is the one that is FREE and ALREADY IN THEIR HANDS** —
  the official SDKs' in-memory/linked transport, MCP Inspector — not any
  commercial product. A commercial product doing the same job does **not** count
  as occupying (Box C).
- **c. The real competitor is UNWILLINGNESS TO ADD A DEPENDENCY.** The argument
  "I can write this myself in 20–50 lines" weighs **more** under the OSS frame,
  not less. Every feature has to answer: why would anyone take on another
  dependency instead of writing it themselves? (Box D)

**Score the three features SEPARATELY** — `replay` · `snapshot --check` · `check`
poisoning. Scoring them together lets one dead feature drag the other two down
with it.

> *English gloss:* this project is Apache-2.0 OSS with no buyer and no revenue.
> Judge it by whether anyone installs and uses it, what the owner's time buys,
> and whether anyone contributes — never by salability. The adoption test is
> "is this less tiring than what they do today?", not willingness to pay.

---

## Note on the freeze (added 2026-08-16, after the criteria were committed)

The section above and the `[OSS]` annotations on individual boxes were added
after `22ab114` and **before** any measurement result was read. **No threshold
was changed.** Numbers stay exactly as frozen: 15%, 12 repositories, 50%,
50 lines, 8 cases.

Lowering a threshold after re-framing, while wanting the project to survive, is
moving the goalposts. Annotating which boxes carry a commercial assumption is
not. This note exists so a later reader can tell the two apart.

---

Written **before** any measurement, and frozen. Every number, definition, and
decision rule below was fixed while the answers were still unknown. Nothing here
may be edited once data collection starts — not the thresholds, not the field
definitions, not the sampling rules. If reality turns out to have a shape these
boxes do not cover, that goes in a separate *unforeseen* section of the report
and is **not** blended into a box to dodge a threshold.

**Date frozen:** 2026-08-16, before the first repository was fetched.

---

## What is actually being measured

`mcp-cassette` is OSS under Apache-2.0. There is no buyer and no revenue. So
"is there a market" is the wrong question and would be answered wrong. The
questions that decide whether this project deserves more of the owner's months:

1. Does anyone **install and use** it?
2. What does the owner's **time** buy?
3. Does anyone **contribute** alongside?

Every threshold below is to be read as *"is this worth months of unpaid work"*,
never as *"can this be sold"*.

---

## The evidence rule (governs the whole report)

Two classes of evidence, and they are not interchangeable:

- **Killing evidence** — can move the project, or one feature, into a stop box
  on its own strength.
- **Supporting evidence** — can only strengthen a case to keep going. Its
  *absence* proves nothing.

Silence is weak evidence, never counter-evidence. In OSS people install first
and complain later, or never. "No one filed an issue" is not "no one needs it",
and the report must never let those two sentences stand in for each other.

Each finding in the report must be labelled with its class.

---

## Field (b): what counts as a protocol-layer test

This is the decisive field, and the line is drawn at what `mcp-cassette`
actually serves, not at what looks rigorous.

> **A protocol-layer test is a test that produces and consumes an MCP JSON-RPC
> message.**

The reason is mechanical: cassette works at the transport level — it records and
replays JSON-RPC. A test that never produces a JSON-RPC message gives cassette
**nothing to record**, no matter how good that test is.

Three buckets, counted and reported **separately**, so the result can be re-read
later under any of the three definitions:

| Bucket | What it is | Counts toward (b)? |
|---|---|---|
| **b1 — real transport** | The test builds an MCP `Client` and a transport (`InMemoryTransport` / linked pair, stdio child process, SSE, Streamable HTTP) and calls `listTools()` / `callTool()`; **or** writes raw JSON-RPC frames to the server's stdin/socket and reads the response. | **Yes** |
| **b2 — in-process request** | `server.request({method:'tools/list'}, ListToolsResultSchema)` or equivalent: a real request built, sent through the request-handling path, response validated against a schema. In-process, but still the protocol. | **Yes** |
| **b3 — direct callback** | Reaching into the registry (`server._registeredTools['add'].callback({a:1,b:2}, mockExtra)`) or importing the handler and calling it with plain arguments. Skips the JSON-RPC envelope, skips schema validation, skips error mapping. | **No** |

Also **not** counted: a test that merely mentions the string `tools/call` or
compares a list of tool names without a request being built. That definition
catches comments and constants and would inflate the number.

**The threshold applies to `b1 + b2` only.**

---

## Box A — "The market does not exist"

> **[OSS] This box carries a commercial assumption in its name.** Under Law №1
> there is no market to exist or not exist. Read it strictly as *"almost nobody
> is doing the thing this tool serves"* — and remember that under OSS a low
> number is weaker evidence than it looks, because the tool only has to be less
> tiring than what people do today, not worth paying for. **Threshold unchanged:
> 15% and 12 repositories.**

Triggers only when **both** conditions hold:

- `(b1+b2)` **< 15%** of the sample, **and**
- `(b1+b2)` **< 12 repositories** in absolute terms.

The absolute floor exists because this is OSS: it does not need a market, it
needs *users*. 12 repositories out of a sample of 80, against a true population
in the thousands, is still real users doing the real thing.

**Class: killing — project-wide.**

---

## Box B — "Swallowed by infrastructure"

> **[OSS] This is the box Law №1(b) points at.** The official SDKs' in-memory
> transport and MCP Inspector are free and already installed — that is what
> makes them dangerous, and no commercial tool can reach this box at all.
> **Threshold unchanged: 50%.**

Scored **per feature**, never as one verdict for the whole tool.

**B-replay** — among the repositories that *do* have protocol-layer tests
(`b1+b2`), if **≥ 50%** already use the in-memory / linked transport shipped in
an official MCP SDK, then `replay` is swallowed. It is free and it is already in
their hands. This threshold kills **`replay` only**. It does not touch
`snapshot --check` and it does not touch `check`.

**B-general** — if an official SDK (TypeScript or Python) or MCP Inspector ships
today, in a released version, any of: (i) in-memory/linked transport,
(ii) record/replay of sessions, (iii) contract diffing — then whichever cassette
feature it covers is swallowed.

A roadmap entry, an open issue, or an unmerged PR is **not** swallowed. It is
recorded as a 1–2 quarter risk and is supporting evidence only.

**Class: killing per feature when shipped and released; supporting when only
announced.**

---

## Box C — "Someone already occupies it"

> **[OSS] A commercial product doing the same job does not occupy anything.**
> Condition 2 below is the whole point of this box, not a qualifier on it: the
> only occupiers that count are free, or already sitting in the user's hands.

A tool occupies a feature when **all three** hold:

1. it does the same job for MCP (adjacent does not count),
2. it is free/OSS, or already bundled in something the user has,
3. it is installable today from a published release.

If such a tool exists **and** is more established (older, more downloads/stars/
dependents), that feature is occupied — **killing for that feature**.

If it exists but is partial, newer, or smaller: contested, recorded as
supporting-against, **not** killing.

For OSS the dangerous competitor is the thing that is **free** and the thing
**already in people's hands** — not a commercial product.

---

## Box D — "The lazy-install barrier"

> **[OSS] This box gets heavier under Law №1, not lighter.** The real competitor
> is unwillingness to add a dependency. "I can write that in 30 lines" defeats a
> free tool more easily than it defeats a paid one, because there is no
> purchasing process to make the alternative feel expensive. **Threshold
> unchanged: 50 lines.**

For each feature, estimate the lines a competent developer writes to replace it
themselves. If that is **≤ 50 lines** and no surviving reason explains why they
would take on a dependency instead, that feature has no place.

**Class: killing per feature.**

Reasons that count — each must be something that does **not** shrink to 50 lines:

- a rule catalogue that has to be maintained as attacks and the spec evolve;
- transport / language / SDK neutrality (driving a Python or Go server from a
  TypeScript test);
- a CI artifact and gate policy — classification tiers, stable rule IDs, a
  single updated-in-place PR comment;
- tracking spec revisions over time.

Reasons that do not count: convenience, a nicer CLI, saving twenty minutes once.

---

## Box E — "Real demand"

**≥ 8 public cases** of downstream *users* (not maintainers) reporting breakage
because a tool surface changed or disappeared without notice ⇒ real demand
exists.

Below 8, the report records **"no signal"** and stops there. It may not be read
as "no one needs this", and it may not move anything toward a stop box.

**Class: supporting only. Never killing.** This is the field most likely to be
misread, so it is fenced off by construction.

> **[OSS] Fenced twice, on purpose.** Law №1(a): silence is weak evidence, never
> counter-evidence. A report that reaches a stop verdict and cites this field as
> part of the reason has broken the criteria. **Threshold unchanged: 8 cases.**

---

## Scoring the three features

`replay` · `snapshot --check` · `check` (poisoning lint) are scored
**independently** against boxes B, C, and D.

- A feature is **DEAD** if it falls into at least one killing box.
- Otherwise it is **ALIVE**.

## The verdict rule

Applied mechanically, in order:

1. **STOP** — all three features DEAD; **or** Box A triggers *and* ≥ 2 features
   are DEAD.
2. **AUDIENCE-LIMITED** — all three features ALIVE but Box A triggers. The tool
   stands up; the audience does not exist yet. Keep going only at a cost the
   owner is willing to lose outright — not months.
3. **NARROW** — ≥ 1 feature ALIVE and ≥ 1 DEAD, and rule 1 did not fire.
   Continue on the surviving features only. The dead ones stop receiving the
   owner's time regardless of how finished they already are.
4. **CONTINUE** — ≥ 2 features ALIVE and Box A does not trigger.

---

## Sampling, locked before the sweep

**Unit of sample:** one MCP *server* package or repository.

**Frame** (all four, no cherry-picking after the fact):

- GitHub topic `mcp-server`
- npm keyword `mcp`
- the official `modelcontextprotocol/servers` repository
- `awesome-*` MCP lists

Selection is by **signal, not by star count**. Stars are used only to drop dead
repositories (field i), never to choose the sample.

**Inclusion:** the repository publishes something that exposes an MCP surface
(tools / resources / prompts) over the protocol, with source visible.

**Exclusion, decided now:**

- No commit since **2026-02-16** (six months) — dead.
- Meta-repositories: awesome lists, registries, docs sites, client-only projects.
- Scaffolding starters (`create-*` templates) whose only purpose is to be copied.

**Dedup:** at most **5 units per owner/organisation**, so a single prolific
publisher cannot set the result. Server packages inside a monorepo count
individually, under the same cap of 5.

**Size:** ≥ 80 units swept mechanically; **20 hand-checked**, stratified as
5 official / 5 popular / 5 mid / 5 tail, and holding at minimum 8 TypeScript-JS,
6 Python, 2 other-language units.

**Every cell in the table carries a `path:line` or a URL.** A cell without one
is recorded as unknown, not as a zero.

---

## Field detection rules

| Field | Counts when |
|---|---|
| a. has tests | a test file, test directory, or test script exists in the manifest |
| b. protocol layer | as defined above; recorded as b1 / b2 / b3 separately |
| c. how live APIs are avoided | SDK in-memory transport · nock/msw/polly/vcr-like · hand-written fixtures · not avoided (hits live) · no tests to avoid with |
| d. committed contract snapshot | any committed file capturing the tool surface (names + schemas) under any name — snapshot-test output, a tools JSON, a generated dump |
| e. CI runs tests | a workflow file that invokes the test command |
| f. changed/removed a tool without notice | a CHANGELOG entry, or git history showing a tool renamed/removed between two released versions, with no deprecation or notice — evidence must be a commit, tag, or URL |
| g. protocol revision declared | a `protocolVersion` string pinned or declared in code or docs |
| h. downstream pain | an issue/PR/discussion authored by a *user*, not a maintainer, reporting breakage from a surface change |
| i. stars + last commit | filter for dead repositories only; never used to select the sample |

---

## What is frozen and what is not

**Frozen:** every threshold, the definition of field (b), the membership rules
for boxes A–E, the verdict rule, the sampling frame, the inclusion/exclusion
criteria, the dedup cap, and the field detection rules.

**Not frozen, and kept separate:** anything discovered that these boxes do not
describe. It is written into its own section of `01-reality-check.md` and must
not be mixed into a box to move a result across a threshold.
