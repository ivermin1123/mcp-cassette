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
`gh api repos/cheneeheng/mcp-cassette`. Source claims below come from the `.py`
files inside the wheel, at the paths given.

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

**1. Two protocol eras.** Grepping the entire installed distribution returns
**0 hits** for each of `2026-07-28`, `server/discover`, `stateless`, `MRTR` and
`Mcp-Method`. Exactly one protocol-version string exists anywhere in their
codebase:

```
mcp_cassette/transports/http/server.py:676:
    "params": {"protocolVersion": "2025-03-26", "capabilities": {}},
```

**This is strong evidence, not proof, and the difference matters.** Absence of a
string rules out era-aware behaviour keyed on those names. It does not rule out
some other way of surviving protocol drift, and their code contains a concrete
example of one: `serve --rewrite-protocol-version` echoes back whatever version
the client asked for, which handles version skew without naming any version.
Nothing was run against their server to test the newer lifecycle, so the honest
claim is "no evidence of era-aware handling in the source", not "cannot do it".

**2. Lint depth.** Theirs bundles four rules, named in their own `lint --help`:
`R001` injection phrasing, `R002` description drift against a baseline, `R003`
duplicate tool names, `R004` instruction-shaped results. Output is `text` or
`json`.

This project ships 16 `CAS-L*` and 7 `CAS-C*` ids, and around them:

- each rule carries OWASP MCP Top 10 risk ids and SAFE-MCP technique ids
  (`src/lint-rules.ts`);
- SARIF output (`src/sarif.ts`), with a CI job asserting findings are anchored
  where code scanning keeps them;
- every pattern proven free of super-linear backtracking by
  `scripts/recheck-rules.mjs`, run as its own CI gate;
- a test that refuses to let a rule ship without a fixture pair
  (`tests/lint-rules.test.ts:133`).

Grepping their distribution for `sarif`, `owasp`, `safe-mcp` and `SAFE-T`
returns nothing.

**3. Install path.** `npx mcp-cassette <command>`, no install step, Node >= 20;
plus a composite GitHub Action (`action.yml`) that CI dogfoods on every run.
Theirs needs pip and Python >= 3.12.

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

1. The dual-era conclusion in §3 rests on absent strings plus one alternative
   mechanism found in their source. Running their `serve` against a client that
   speaks the 2026-07-28 lifecycle would settle it. Is that worth doing, given
   that §5 says the answer changes nothing today?
2. §2 lists four capabilities they have and this project does not, and the first
   of them (server-initiated replay) is already on the roadmap here. Does the
   existence of a working implementation elsewhere make building it more
   valuable or less?
3. The rename condition in §6.2 is written as "real users on either side". If
   *they* get users first and this project does not, the confusion is
   asymmetric and lands mostly on them. Does that change who should rename, and
   is that a question to raise with them rather than decide alone?
