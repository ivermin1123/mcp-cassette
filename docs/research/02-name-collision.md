# Name collision

Measured 2026-08-17, against the installed artifact rather than a project page.

A second project called `mcp-cassette` exists. It reached PyPI on 2026-07-25,
three weeks before the competitor sweep in
[`01-reality-check.md`](01-reality-check.md) went looking on 2026-08-16 and did
not find it. It does the same job with the same architecture, and it is close
enough that one planned piece of work stops here.

That sweep enumerated four other MCP record/replay tools and missed this one
because it read GitHub and npm and never read PyPI. The tool was public and
name-searchable on both PyPI and GitHub the whole time.

---

## HANDOVER

| | |
|---|---|
| **The fact** | `mcp-cassette` 0.3.5 on PyPI, by EeHeng Chen, Apache-2.0, Python >= 3.12, first published 2026-07-25. Same name, same job, same shape: a record proxy, a cassette file, a standalone replay server, a cassette lint, a CI gate. |
| **What stops** | The **pytest adapter**. Not because the name is taken. Because `pytest-mcp-cassette` on PyPI would sit next to an `mcp-cassette` that already ships a pytest plugin inside itself, and `pytest-<tool>` is a naming convention that asserts a relationship. |
| **What does not stop** | Everything else. The project is not renamed, the positioning sentence is not edited, and no published article is rewritten. |
| **What being second costs** | Nothing measurable. Both repositories carry 0 stars, 0 forks and 0 watchers. A difference only pays when somebody is choosing, and nobody is choosing. |
| **The door that closed** | PyPI. The `mcp-cassette` name there is spent, and so is the `pytest-mcp-cassette` slot beside it. Any future Python component of this project needs a different name. |
| **What this is not** | A threat assessment. They are a solo maintainer with no users, which is this project exactly. |

---

## 1. The fact, and how it was measured

**Method, stated first because the conclusion rests on it.** Everything in this
section comes from the distributed artifact or from an API, never from a
rendered project page:

```
pip download mcp-cassette --no-deps -d /tmp/x --python-version 3.12 --only-binary=:all:
unzip -q /tmp/x/mcp_cassette-*.whl -d /tmp/x/pkg
cat /tmp/x/pkg/mcp_cassette-*.dist-info/METADATA
cat /tmp/x/pkg/mcp_cassette-*.dist-info/entry_points.txt
```

Publication timestamps come from `https://pypi.org/pypi/mcp-cassette/json`,
field `upload_time_iso_8601`. Repository counters come from
`gh api repos/cheneeheng/mcp-cassette`. Source claims in §2 come from the `.py`
files inside the wheel, at the paths given.

**§3 is measured differently, and deliberately so.** Its first version reasoned
about behaviour from strings present or absent in the wheel. A grep cannot read
control flow, and §3.1 is what happened when the same questions were put to the
source itself: the repository cloned at `beaac64` (v0.3.5) and read. Line
numbers in §3 are from that tree. Nothing was executed.

**From `METADATA`:**

| Field | Value |
|---|---|
| `Name` | `mcp-cassette` |
| `Version` | `0.3.5` |
| `Author-email` | EeHeng Chen |
| `License-Expression` | `Apache-2.0` |
| `Requires-Python` | `>=3.12` |
| `Project-URL, Repository` | `https://github.com/cheneeheng/mcp-cassette` |
| `Classifier` | includes `Framework :: Pytest` |
| `Keywords` | `agent,mcp,mock,model-context-protocol,pytest,record-replay,testing,vcr` |

Their own summary line calls it record/replay testing for MCP agents, capturing
real sessions as cassettes and replaying them as deterministic mock servers:
`vcrpy for MCP`. That is this project's description with the nouns unchanged.

**When the name was taken.** Three releases exist on PyPI and no more:

| Version | Uploaded |
|---|---|
| 0.3.3 | 2026-07-25T14:23:33Z |
| 0.3.4 | 2026-07-28T18:48:49Z |
| 0.3.5 | 2026-08-01T20:37:35Z |

0.3.3 is the first PyPI release. `gh api repos/cheneeheng/mcp-cassette/releases`
lists ten tags from `v0.1.0` (2026-07-19) onward, so `v0.1.0` through `v0.3.2`
were published on GitHub and never pushed to the index. The name has been
occupied since **2026-07-25**.

**Who was first.** Their repository was created 2026-07-19. This one was created
2026-08-15, and its first commit (`21206e7`) is the same day. They are ahead by
four weeks, and they published to a package index three weeks before this
project's research sweep ran.

---

## 2. What they have that this project does not

All four verified by reading the source inside the wheel.

**1. Server-initiated request replay.** `mcp_cassette/replay/server_requests.py`
replays requests the server originated (sampling, elicitation) with
release-on-response gating: at load, every recorded server-to-client request gets
an emission trigger derived from its recorded position, and at runtime messages
recorded after the original response are held until the live agent answers,
because the real server only produced them after being answered. The agent's
answer is accepted whatever it contains and is never matched against the
recording.

This is precisely the hole `docs/llms.txt` records as this project's own:

> Replay answers requests from the client. Requests and notifications the server
> initiated are recorded but not replayed in v1, and replay prints how many it
> skipped to stderr.

Their v1 does replay them. Ours does not.

**2. A pytest plugin, inside the same distribution.** From `entry_points.txt`:

```
[console_scripts]
mcp-cassette = mcp_cassette.cli:main

[pytest11]
mcp_cassette = mcp_cassette.pytest_plugin
```

`[pytest11]` is the entry-point group pytest scans at startup, so installing
their tool installs the plugin. There is no separate adapter package to publish,
and no separate adapter package for a user to reason about. This single fact is
what kills the planned work; see §6.

**3. Replay controls this project has no equivalent for.** On `serve`
(`mcp_cassette/cli.py`, all inside the `serve` subparser):

- `--faults`, a fault overlay JSON sidecar.
- `--pace none|recorded`, with `--pace-scale` and `--pace-cap-ms`.
- `--ordering per_method|strict|none`, matching order discipline.
- `--new-episodes`, replay matches and fall through misses to the real server.
- `--rewrite-protocol-version`, rewrite the initialize `protocolVersion` to the
  client's requested value.

On `record`: `--checkpoint-interval`, backed by `mcp_cassette/record/checkpoint.py`,
so a long recording survives being interrupted.

**4. An extension mechanism for their lint.** `lint --pattern-pack`, backed by
`mcp_cassette/lint/packs.py`, lets a user add patterns; the bundled rules cannot
be replaced, only extended. This project's rule set is fixed at build time and
has no such seam. Recorded here because leaving it out would flatter this
project, and §3 counts lint rules in the other direction.

---

## 3. What this project has that they do not

**Re-measured 2026-08-17 by reading their source at `beaac64` (v0.3.5), cloned
from GitHub.** The first version of this section reasoned from strings absent in
the published wheel. That was the wrong instrument for the question it was asked
to answer, and §3.1 is the correction. Line numbers below are theirs unless the
path says `src/`, which is this project.

### 3.1 Two protocol eras — real, but much narrower than first written

**What this section said before.** Grepping the installed distribution returned
0 hits for each of `2026-07-28`, `server/discover`, `stateless`, `MRTR` and
`Mcp-Method`, with exactly one protocol-version string anywhere in their
codebase. From that it concluded "no evidence of era-aware handling in the
source".

**Reading the source refutes the framing.** Their replay does carry
lifecycle-aware handling, hard-coded to the classic era — precisely the shape no
string search could see, because whether a cassette replays is decided by control
flow, not by vocabulary. Three findings, and they do not all point the same way.

**Their matcher is era-agnostic.** `matching.py:63-106` looks a request up by a
canonical key built in `_canonical_key` (`matching.py:142-147`) from
`config.match_on`, which defaults to `["method", "params"]`
(`cassette.py:154`). There is no branch for `initialize` anywhere in the file,
and their own schema docstring says the format is "message-generic: every
JSON-RPC message is captured verbatim whatever its method" (`cassette.py:5-6`).
Any method, including one they have never heard of, keys and matches like any
other.

**Their replay servers are not.** Both transports intercept `initialize` before
the matcher is ever consulted — `replay/server.py:188-190` and
`transports/http/server.py:288-290` — and answer it from a pre-scanned
`_initialize_exchange`, found by walking the cassette for a request whose method
is the literal string `initialize` (`replay/server.py:399-403`,
`transports/http/server.py:521-526`). Their own comments call this out:
"initialize bypasses the matcher" (`transports/http/server.py:316`).

**Over HTTP the classic lifecycle is not merely present, it is mandatory.** The
session id is minted at construction from a sha256 of the cassette
(`transports/http/server.py:96-97`), but `_issued` starts `False`
(`:98`) and is set `True` in exactly one place: `_handle_initialize`
(`:330`). Every non-`initialize` request is gated behind `_session_ok`
(`:345-348`) and answered `404` when it fails (`:291-295`). The standalone
GET SSE stream sits behind the same gate (`:254-257`, and `_handle_get`'s first
statement). Session id and standalone GET are both classic-era mechanics; the
2026-07-28 era removed both.

**So a cassette recording `server/discover` in place of `initialize` splits by
transport:**

| transport | outcome | path |
|---|---|---|
| stdio | **replays** | `replay/server.py:186-192`: method is not `initialize`, so it falls straight through to the generic matcher and is answered from the recording. |
| HTTP | **404, always** | `transports/http/server.py:287-295`: not `initialize`, so `_session_ok` is consulted; `_issued` is still `False` because only `_handle_initialize` sets it; the client gets `404` and never reaches the matcher. |

With one caveat on the stdio row: the leading notifications and the
`initialize`-triggered server requests are emitted only from inside
`_handle_initialize` (`replay/server.py:291-292`), so a discover-only cassette
replays its request/response traffic and silently drops those.

**`protocolVersion` is echoed, never interpreted.** `apply_protocol_version`
(`replay/server.py:32-66`) reads the recorded value out of
`response["result"]["protocolVersion"]`, compares it to the client's requested
string for inequality only, and either overwrites it with the requested string
or warns. No ordering, no capability derivation, no branch on the value.

**The `--rewrite-protocol-version` argument, withdrawn.** The earlier version of
this section offered that flag as their alternative way of surviving protocol
drift, and it is not one. The function above writes the client's requested value
*inside the `initialize` result*, and it is called from exactly two sites —
`replay/server.py:280` and `transports/http/server.py:333` — both inside
`_handle_initialize`. The flag therefore presupposes that an initialize
happened. Negotiating a version within one lifecycle is not coordinating between
two lifecycles, and the 2026-07-28 era has no initialize to negotiate inside:
`server/discover` takes its place, `_meta` travels per request, and there is no
session.

**What survives.** The difference is real and it is a difference in *replay
scaffolding*, not in matching. This project reads the era from the cassette
header and gates behaviour on it — `src/http-replay.ts:180-187` decides
standalone GET and sessions from it, `src/client.ts:160-182` probes for it when
connecting to a live server. Theirs is single-era: agnostic for everything after
the handshake on stdio, and structurally classic-only on HTTP.

**What does not survive is the method and the width of the claim.** Absent
strings showed that no behaviour is *keyed on those names*; the document then
read that as absence of era handling generally, which was wrong in both
directions — they have more lifecycle logic than the grep implied, and less
reach than "cannot do it" would have implied. §5 still applies: neither project
has a user, so this difference is currently worth nothing.

### 3.2 Lint depth — the count was not like-for-like

Theirs bundles four rules (`lint/rules.py:23`): `R001` injection phrasing in
tool descriptions (`:74-103`), `R002` description and `inputSchema` drift
against a baseline cassette (`:105-159`), `R003` duplicate tool names within one
`tools/list` (`:166-187`), `R004` instruction-shaped `tools/call` **result
text** (`:190-213`). `R001` and `R004` share one four-entry pattern set
(`lint/patterns.py:11-37`): override-instructions, conceal-from-user,
model-addressed-imperative, hidden-emphasis.

This project ships 16 `CAS-L*` and 7 `CAS-C*` ids, and around them: OWASP MCP
Top 10 and SAFE-MCP technique ids per rule (`src/lint-rules.ts`); SARIF output
(`src/sarif.ts`) with a CI job asserting anchor placement; every pattern proven
free of super-linear backtracking by `scripts/recheck-rules.mjs` as its own CI
gate; and a test that refuses to let a rule ship without a fixture pair
(`tests/lint-rules.test.ts:133`). Grepping their source for `sarif`, `owasp`,
`safe-mcp` and `SAFE-T` returns nothing.

**"23 against 4" inflates the advantage, and this is the honest version.** The
two sets are not aimed at the same surface, so the counts are not comparable in
either direction.

| | scanned by theirs | scanned by this project |
|---|---|---|
| tool `description` | yes (`R001`) | yes |
| tool `title` | no | yes (`src/lint.ts:34`) |
| `inputSchema` free text | no — `R002` compares schemas for equality, it does not read them for injection | yes (`src/lint.ts:37`, full-schema poisoning) |
| `annotations` | no | yes (`src/lint.ts:40`) |
| `tools/call` **result text** | **yes (`R004`)** | **no** — `lintTool` builds its surface list from the tool only (`src/lint.ts:32-40`) |
| drift vs a baseline | yes, as a lint rule (`R002`) | yes, but as `snapshot` / `diff` / `check`, not as a lint rule |

Two of their four therefore cover ground this project's 23 do not: `R004` reads
a surface this lint never opens, and `R002` is shipped here under a different
command, so counting it against the lint total compares unlike things. What is
left as genuine depth is this project's reach across the whole tool surface —
title, schema text and annotations, not description alone — and the 16 pattern
families against their four. That is a real difference and a narrower one than a
raw 23-to-4 suggests.

### 3.3 Install path

`npx mcp-cassette <command>`, no install step, Node >= 20; plus a composite
GitHub Action (`action.yml`) that CI dogfoods on every run. Theirs needs pip and
Python >= 3.12. Unchanged by this re-measurement.

---

## 4. The argument that does not survive

The tempting framing is: *they serve Python, we serve the JS/TS ecosystem, so
these are different tools*. It does not hold, and this project's own positioning
sentence is what breaks it. From `README.md`, `docs/llms.txt`, the site, and
`--help`:

> The cassette is itself an MCP server, so any client in any language connects to
> it exactly as it connects to the live one: no library to import, no product
> code to change, no transport to wrap.

That sentence is equally true of their tool. Their `serve` is a standalone MCP
server over stdio or Streamable HTTP, so a TypeScript, Go or Rust client connects
to it exactly as it connects to a live server. The claim that makes this project
language-neutral makes theirs language-neutral by the same mechanism.

What is left is **install friction**: `npx` against `pip install` plus Python
>= 3.12. That is a distribution difference, not a capability difference, and it
should never be written up as one. The article at `docs/replay/` proves the point
against this project by driving one cassette from the official Python SDK; the
same demonstration would work against theirs from a Node client.

---

## 5. Impact, honestly

| | theirs | ours |
|---|---|---|
| Created | 2026-07-19 | 2026-08-15 |
| Last push | 2026-08-01 | 2026-08-16 |
| Stars | 0 | 0 |
| Forks | 0 | 0 |
| Watchers | 0 | 0 |

**Every difference in §2 and §3 is currently worth nothing.** A comparison pays
only when somebody has to choose between two tools, and nobody is choosing
between these two. Neither project has a user who is not its author.

**What the convergence does mean.** Two strangers, four weeks apart, with no
knowledge of each other, arrived at the same name and the same decomposition: a
recording proxy in the middle, a cassette file on disk, a standalone replay
server any client can connect to, a lint over the recording, and a CI gate.
That is evidence the design is the **obvious** answer to the problem. It is not
evidence that the problem has an audience. §6.5 of `01-reality-check.md` already
recorded four tools taking this shape; this is the fifth, and the first that is a
straight name collision.

The one durable consequence is a name, not a market: PyPI's `mcp-cassette` is
occupied, and so is the adapter slot beside it.

---

## 6. Decisions

**6.1 The pytest adapter is dead.**

The reason is not the collision by itself. It is that `pytest-mcp-cassette`
published to PyPI would sit directly beside `mcp-cassette`, a package that
already ships a pytest plugin at `[pytest11]`. `pytest-<tool>` is a naming
convention that asserts a relationship, and the relationship a reasonable reader
would infer is "the pytest adapter for that tool". That inference would be wrong,
and no README wording undoes a package name sitting next to another package name
in an index listing. It misleads regardless of intent, so it does not ship.

Nothing else about the pytest adapter was wrong. It was a reasonable plan on
2026-08-16 and it is not one on 2026-08-17, because a fact changed under it.

**6.2 The project is not renamed.**

The cost, listed rather than asserted:

- the npm package name `mcp-cassette`, and every `npx mcp-cassette` line in the
  README, the site, `docs/llms.txt` and the action;
- the domain `mcpcassette.dev` (`docs/CNAME`) and the published article URL
  `https://mcpcassette.dev/replay/`;
- every `uses: ivermin1123/mcp-cassette@v0` / `@v0.3` / `@v0.4` pin, and the
  floating tags the release job maintains for them;
- the repository URL already cited from `CHANGELOG.md`, `BACKLOG.md` and
  `01-reality-check.md`.

The benefit, today, is zero: a rename removes confusion between two projects that
have no users to confuse. Paying a real cost for a hypothetical one is the wrong
trade while both sides sit at zero.

**Revisit when either side has real users.** That is the condition, and it is
observable: a non-author star, a non-author issue, or download counts that are
not registry crawlers, on either repository. At that point confusion becomes a
cost somebody actually pays, and this decision should be re-argued rather than
inherited.

**6.3 PyPI is closed to this project.**

Any Python component built later carries a different name, chosen and checked
against the index at the moment it is proposed. Not inherited from this document.

**6.4 Nothing else changes.**

The positioning sentence stays exactly as written. It was never a uniqueness
claim, and it remains true of this tool. The `docs/replay/` article stays as
written; it never claimed nobody else could do this.

---

## Unresolved questions

1. ~~The dual-era conclusion in §3 rests on absent strings.~~ **Settled
   2026-08-17 by reading their source; §3.1 carries the corrected version.** What
   is still unrun is the live test: nothing was executed against their `serve`.
   The code path is traced, not observed. Given that §5 says the answer changes
   nothing today, running it would buy confirmation of a control-flow reading
   that is already unambiguous.
2. §2 lists four capabilities they have and this project does not, and the first
   of them (server-initiated replay) is already on the roadmap here. Does the
   existence of a working implementation elsewhere make building it more
   valuable or less?
3. The rename condition in §6.2 is written as "real users on either side". If
   *they* get users first and this project does not, the confusion is
   asymmetric and lands mostly on them. Does that change who should rename, and
   is that a question to raise with them rather than decide alone?

---

## Appendix: observations, not work items

Things noticed while reading their source on 2026-08-17 that fall outside the
four questions that reading was scoped to. Recorded because throwing away what
you saw is its own kind of dishonesty. **This list is not ordered by importance,
implies no gap, and proposes nothing.** The standing decision — build when
somebody asks — is not reopened here.

**Their on-disk format, and the distance to this one.** Theirs is a single JSON
document: a pydantic `Cassette` (`cassette.py:75-91`) holding `format_version`,
`recorded_at`, `transport`, `server_url`, `session_id`, `protocol_version`,
`server_info`, and a `messages` list, written whole with `indent=2` through a
tmp-file-and-`os.replace` swap (`cassette.py:140-148`). Each `Message`
(`cassette.py:44-72`) carries `seq`, `t_offset_ms`, `sender` (`client`/`server`),
`kind` (`request`/`response`/`notification`/`raw`), `method`, `msg_id`,
`payload`, `redacted`, `exchange`, `channel` (`post`/`get`).

This project's is JSONL: one object per line, discriminated by `type`
(`header`, `frame`, `chunks`, `state`), appended as the session runs
(`docs/cassette-format-v2.md`). The same JSON-RPC payloads survive on both
sides; the differences are container and index. Theirs rewrites the whole file
per save, which is what `record/checkpoint.py` exists to survive; this one
appends. Theirs lifts `method`, `msg_id` and a classified `kind` to the top of
each message as index fields; this one keeps the frame verbatim and derives.
Direction is `sender: client|server` there and `dir: c2s|s2c` here. Streamed
answers are a `channel` on a message there and a dedicated `chunks` entry with
`via: get|post` here. The header fields diverge where the lifecycle does: `era`
and `sessioned` here, `protocol_version` / `session_id` / `server_info` (all
lifted from the initialize result) there. This project's `state`/`seq` scenario
entries have no counterpart in their schema; their per-message `exchange`
grouping has none in this one.

**Test counts land in the same place.** 378 test functions across their
`tests/unit` (277), `tests/integration` (83) and `tests/system` (25), covering
stdio and HTTP on both the record and replay sides, with dedicated HTTP files at
every level. This project has 358. Neither number distinguishes the two
projects.

**No unfinished-work markers in their tree.** `TODO`, `FIXME` and `XXX` return
nothing across `src/` and `tests/`. The three `NotImplementedError` hits are
Windows signal-handling `except` clauses (`_signals.py:28-29`,
`record/proxy.py:171`) and one test raising it deliberately
(`tests/unit/test_signals.py:36`) — none is a stub.

**Where they write their limits down.** There is no limitations section. The
boundaries appear inline where the feature is explained: concurrent faults
unsupported (`docs/guide/how-to/HT-04-inject-faults.md:77`), concurrent use of
one cassette path "unsupported and undetected"
(`docs/guide/how-to/HT-03-use-as-a-library.md:121`), redaction as capture-time
only and not retroactive (`docs/guide/how-to/HT-07-redact-secrets.md:5`), plus a
symptom-to-cause table in `docs/guide/troubleshooting.md`. Their docs tree is
nine how-tos, five operations documents, a getting-started and that
troubleshooting page.

**Their session id is derived, not random.** `mcc-` plus the first eight hex
digits of a sha256 over the cassette's own JSON
(`transports/http/server.py:96-97`), so it is stable across runs of the same
cassette. This project mints a fresh UUID per replay session
(`src/http-replay.ts:298-302`).

**Strict ordering examines only the next exchange in line.** `matching.py:92-100`
returns `None` on the first unconsumed exchange whose key does not match, rather
than scanning past it — the loop body ends in an unconditional `return`. Their
comment says this is the intent: "next-in-line did not match -> unmatched".

**They keep a `CLAUDE.md` at the repository root**, and `README.md` §9 is titled
"Built with Claude Code".
