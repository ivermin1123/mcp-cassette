# Backlog

Decisions this project owes itself. Each item is here because it needs an
argument before it needs code — usually because it touches something a consumer
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
safety check entirely — the opposite of what they want. 0.3.0 shipped three such
rules.

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

**Measured, not assumed.** The failure is safe — it lands on the first gate,
before `npm test`, `npm publish`, the GitHub Release, and the float move, all of
which were skipped ([run 31940214098](https://github.com/ivermin1123/mcp-cassette/actions/runs/31940214098)).
And it only happens for a *hand* push: across the last 20 Release runs there is
no run for ref `v0`, though `v0` has been force-moved on four releases, because
a push made with `GITHUB_TOKEN` does not re-trigger workflows. The workflow
moving its own floats is invisible to itself; a maintainer moving one is not.

So the cost today is one red run in the Actions history per manual float cut —
noise, not risk.

**Directions, none chosen:**

- **Narrow the pattern** to full versions (`v[0-9]+.[0-9]+.[0-9]+*`). Removes the
  noise, and also removes the version gate's protection from anything the
  narrowed pattern no longer matches — a typo'd tag would simply do nothing
  instead of failing loudly.
- **Accept the noise** and document it, treating the red run as proof the
  version gate works. Costs nothing but leaves a permanent "is the release
  broken?" question for anyone reading Actions.
- **Keep the trigger and exit early** on a tag that is not a full version, so
  the run goes green-and-skipped rather than red.

**Why this is a design checkpoint:** it is the release path. A change here is
only exercised by cutting a real release, so it cannot be dry-run — the same
constraint that let two defects ship in the v0.2.0 release job. Any edit needs
the extract-and-stub verification described in
[CONTRIBUTING](CONTRIBUTING.md#changing-releaseyml).

---

## Schema-diff completeness

**Raised** 2026-08-16. Design pass in progress — see the rule-family table
before implementation starts. Same risk class as the lint upgrade: it decides
what turns a consumer's CI red.
