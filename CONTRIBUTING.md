# Contributing to mcp-cassette

Thanks for taking the time to help. This is a small, focused tool. Issues, bug
reports, and PRs are all welcome.

## Before you start

**Open an issue before large features.** Anything that adds a command, changes
the cassette format, or introduces a dependency should be discussed first. It
saves you from writing code that doesn't fit the direction, and it gives the
change a place to be designed in the open. Small fixes (a bug, a typo, a missing
edge case) go straight to a PR.

## Language

**Everything committed to this repository is in English.** Code, comments, docs,
research reports, commit messages, issues, PR descriptions: all of it, with no
exception for a file that "only the owner will read". A repository is read by
strangers, and a document a stranger cannot read cannot be checked, which is the
whole point of publishing the research files.

This is a rule about the repository, not about conversation. Working in another
language while a change is being built is fine; what lands in a commit is
English.

The rule was written down after two research documents were drafted in
Vietnamese and had to be translated afterwards. Translating a **frozen** document
is the expensive part: `docs/research/00-kill-criteria.md` had to be re-expressed
in another language after its answers were already known, which is exactly the
moment when softening a threshold is tempting and invisible. If you ever have to
do this, translate only. Hold the numbers, the structure, and the self-criticism
where they are, and prove it with a diff a reviewer can check.

## Rule ids are a public contract

`docs/llms.txt` tells machine readers: "Every finding carries a stable rule id in
parentheses. Match on the id, not the wording." That sentence turned every
`CAS-L*` and `CAS-C*` id into a surface consumers build on, so the ids are
governed like a flag or a command name, not like prose.

- **Renaming or removing a released id is a breaking change.** It silently
  breaks whatever matches on it: a CI gate, a SARIF suppression, an agent
  reading `--json`. It needs a line under `### BREAKING` in
  [CHANGELOG.md](CHANGELOG.md).
- **A retired id is never reused for a different meaning.** Once `CAS-L007` has
  shipped meaning one thing, that number is spent. Reuse is worse than removal,
  because the consumer's match keeps succeeding and starts being wrong.
  Retire the number and take the next free one.

This is not a rule against changing rules. Two things you are free to do:

- **Adding a new id is not a breaking change.** Nobody was matching on it
  yesterday.
- **Rewording a rule's message is not a breaking change.** The message is prose
  and it is expected to get better. That is exactly why `llms.txt` tells readers
  to match on the id instead of the sentence.

`tests/lint-foundation.test.ts` freezes the released `CAS-L*` ids, so dropping
one turns the suite red. Adding one does not. The `CAS-C*` ids are under the
same law but have no such gate; they live in `src/check.ts` and `src/sarif.ts`.

## Dev setup

Requires Node.js >= 20.

```bash
git clone https://github.com/ivermin1123/mcp-cassette.git
cd mcp-cassette
npm install
```

## Tests

```bash
npm test
```

`pretest` runs the TypeScript build, so `npm test` also verifies compilation.
The end-to-end tests spawn real child processes against a fixture server in
`tests/fixtures/`, so they exercise the built CLI in `dist/`, not just the
modules.

Watch mode while working:

```bash
npm run test:watch
```

### Property tests

`tests/properties/` states laws instead of examples, checked with
[fast-check](https://fast-check.dev) over generated input: the cassette codec
round-trips any JSON, the replay fingerprint ignores key order and `_meta`,
redaction is idempotent and shape-preserving, `diff(s, s)` is empty, and the
line parsers never throw on hostile input. They found a real defect on their
first run, `urlcreds` re-redacting its own placeholder under a second hash,
which is the kind of thing example tests do not go looking for.

The seed is fixed (`tests/properties/fast-check-seed.ts`) so a red build
reproduces exactly. Widen the search locally before a risky change:

```bash
FAST_CHECK_SEED=$RANDOM npm test
```

If a random seed finds something, add the counterexample as a plain example
test next to the property: the property proves the law, the example documents
the bug.

## Smoke test

The smoke test dogfoods the CLI end-to-end against the official MCP reference
server: `check` a live server, `record` a session through the proxy, `check`
the replayed cassette, then `snapshot` and `snapshot --check` against that
replay:

```bash
npm run build && ./scripts/smoke.sh
```

It needs network access (`npx` downloads `@modelcontextprotocol/server-everything`).
CI runs the same script, so running it locally before pushing catches anything
the unit tests miss.

The reference server is pinned to a specific version inside the script, because
the MCP spec is still moving and an upstream release can break the run while our
code is unchanged. Override the pin with `SERVER_PKG` to test against another
version:

```bash
SERVER_PKG='@modelcontextprotocol/server-everything@latest' ./scripts/smoke.sh
```

CI does exactly that in a separate weekly `smoke-canary` job, which is
non-blocking; it warns about upstream drift without failing anyone's PR. If you
bump the pin, do it as its own commit so the reason stays visible in history.

## Changing `release.yml`

`release.yml` runs only on a tag push, so there is no way to try a change before
it matters, and the version it would break is the one you are shipping. The
v0.2.0 release job carried two defects for exactly this reason.

So prove the shell logic outside the workflow. Extract the step's script
*verbatim* from the file rather than retyping it, put a stub `git` ahead of the
real one on `PATH`, and run it against every ref shape you care about:

```bash
# the line range is whatever the step's `run:` block currently occupies;
# find it with: grep -n 'Move the floating' .github/workflows/release.yml
sed -n '104,121p' .github/workflows/release.yml | sed 's/^          //' > /tmp/step.sh
mkdir -p /tmp/fakebin && printf '#!/bin/sh\necho "GIT $*"\n' > /tmp/fakebin/git
chmod +x /tmp/fakebin/git

for ref in v0.3.0 v0.4.0 v1.0.0 v0.4.0-rc.1; do
  echo "--- $ref ---"
  PATH=/tmp/fakebin:$PATH GITHUB_REF_NAME="$ref" GITHUB_SHA=deadbeef sh /tmp/step.sh
done
```

Extracting rather than retyping is the point: a copy you typed out proves your
copy works. Include the resulting table in the PR description.

For changes that need the real registry rather than the real tag push, the
Release workflow has a `workflow_dispatch` that runs `verify-publish` alone
against a version already on npm. The publish job is gated to tag pushes, so a
dispatch cannot publish.

## Where decisions get written down

- **[BACKLOG.md](BACKLOG.md)**: work that needs an argument before it needs
  code, usually because it touches something consumers already depend on. If you
  are about to add an input, a rule, or a tier, check whether it is already
  being argued here.
- **[README roadmap](README.md#roadmap)**: things not built yet that need no
  argument.
- **[RELEASING.md](RELEASING.md)**: how a release actually happens, including
  the parts that are only discoverable by getting them wrong.
- **`docs/`**: the published site (mcpcassette.dev) and the format and design
  documents behind it.
- **`plans/`**: git-ignored on purpose. Session reports, handoffs and scratch
  notes live here and are not expected to survive a fresh clone. Anything that
  should outlive the machine it was written on does not belong in `plans/`;
  promote it to one of the files above.

## Claims about other tools

**Truncating another tool's output truncates your own conclusion.** This is a
project law because it has already cost a wrong answer twice in one day.

`docs/research/01-reality-check.md` first concluded that a competitor did not
offer a contract-lock workflow. It does, through `lock create` and `lock verify`,
and the reason the report said otherwise is that its author read the command list
through `--help | head -35`, which cut nine commands including that one. The same
report then measured the competitor's poisoning coverage using the wrong
subcommand, having never seen the right one. Both conclusions were wrong in the
direction that flattered this project.

So, before writing any sentence of the form "tool X cannot do Y":

- Read the whole of `--help`. No `head`, no `| head -N`, no truncated paste. If
  the output is long, that is the point.
- Prefer the tool's own listing to its README, and prefer running it to both.
- If the tool appears to fail, suspect the invocation before the tool. A flag
  that exits 0 when you expected 1 is more often the wrong flag than a broken
  gate; `--fail-on-regression` versus `--fail-on-schema-drift` cost an hour
  here.
- Name the exact command in the write-up. A comparison that does not say what
  was run cannot be checked, and will eventually be wrong without anyone
  noticing.

Same class: quoting a URL without opening it, citing a file without reading past
the first screen, and trusting a source tree's filenames over the installed
artifact's behaviour.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add --redact flag to record
fix: handle servers that log to stdout during handshake
docs: clarify replay matching rules
test: cover paginated tools/list
ci: run smoke test on pull requests
chore: bump ajv to 8.17
```

Keep commits small and focused, one logical change each. The release notes are
generated from commit history, so the subject line is what users will read.

## Pull requests

Before opening a PR:

- [ ] `npm test` passes (all tests, not just the ones you touched)
- [ ] `./scripts/smoke.sh` passes if you changed `record`, `replay`, `check`, or `snapshot`
- [ ] New behavior has a test
- [ ] No new runtime dependencies unless the issue agreed on one
- [ ] README updated if you changed user-facing behavior or added a flag

In the PR description, say what changed and why. If it fixes an issue, link it
with `Fixes #123`. If it changes the cassette format or a command's output,
call that out explicitly, because those are the changes most likely to break
someone.

CI runs the test matrix (Node 20 and 22) and the smoke test on every PR. Both
must be green before merge.

## Project layout

| Path | What's in it |
|---|---|
| `src/cli.ts` | Command definitions (commander) |
| `src/record.ts` | Transparent stdio proxy that writes cassettes |
| `src/replay.ts` | Serves a cassette as a mock MCP server |
| `src/check.ts` | Health + safety checks |
| `src/lint.ts` | The `CAS-L*` safety lint rules |
| `src/snapshot.ts` | Contract capture and breaking-change diff |
| `src/cassette.ts` | Cassette format v1 read/write |
| `src/client.ts` | `MiniClient`, the small MCP client used by `check`/`snapshot` |
| `tests/` | Unit tests plus an end-to-end suite against a fixture server |
| `scripts/smoke.sh` | End-to-end dogfood run against the reference server |
| `action.yml` | The composite GitHub Action wrapping `check` and `snapshot` |
| `BACKLOG.md` | Decisions owed before code, see above |

## Reporting security issues

Please don't open a public issue for a security problem. See
[SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the
Apache-2.0 license that covers this project.
