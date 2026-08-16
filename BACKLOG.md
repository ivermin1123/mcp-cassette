# Backlog

Decisions this project owes itself. Each item is here because it needs an
argument before it needs code, usually because it touches something a consumer
already depends on. Items that are merely "not built yet" belong in the
[README roadmap](README.md#roadmap) or in an issue; these are the ones where
picking the obvious implementation would be the mistake.

---

## The action has no intermediate lint setting

**Raised** 2026-08-16, out of the 0.3.0 release notes.

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
gradually.

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
