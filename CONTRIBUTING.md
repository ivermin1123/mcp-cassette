# Contributing to mcp-cassette

Thanks for taking the time to help. This is a small, focused tool — issues, bug
reports, and PRs are all welcome.

## Before you start

**Open an issue before large features.** Anything that adds a command, changes
the cassette format, or introduces a dependency should be discussed first. It
saves you from writing code that doesn't fit the direction, and it gives the
change a place to be designed in the open. Small fixes — a bug, a typo, a
missing edge case — go straight to a PR.

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
first run — `urlcreds` re-redacting its own placeholder under a second hash —
which is the kind of thing example tests do not go looking for.

The seed is fixed (`tests/properties/fast-check-seed.ts`) so a red build
reproduces exactly. Widen the search locally before a risky change:

```bash
FAST_CHECK_SEED=$RANDOM npm test
```

If a random seed finds something, add the counterexample as a plain example
test next to the property — the property proves the law, the example documents
the bug.

## Smoke test

The smoke test dogfoods the CLI end-to-end against the official MCP reference
server — `check` a live server, `record` a session through the proxy, `check`
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
non-blocking — it warns about upstream drift without failing anyone's PR. If you
bump the pin, do it as its own commit so the reason stays visible in history.

## Changing `release.yml`

`release.yml` runs only on a tag push, so there is no way to try a change before
it matters — and the version it would break is the one you are shipping. The
v0.2.0 release job carried two defects for exactly this reason.

So prove the shell logic outside the workflow. Extract the step's script
*verbatim* from the file rather than retyping it, put a stub `git` ahead of the
real one on `PATH`, and run it against every ref shape you care about:

```bash
# the line range is whatever the step's `run:` block currently occupies —
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

- **[BACKLOG.md](BACKLOG.md)** — work that needs an argument before it needs
  code, usually because it touches something consumers already depend on. If you
  are about to add an input, a rule, or a tier, check whether it is already
  being argued here.
- **[README roadmap](README.md#roadmap)** — things not built yet that need no
  argument.
- **[RELEASING.md](RELEASING.md)** — how a release actually happens, including
  the parts that are only discoverable by getting them wrong.
- **`docs/`** — the published site (mcpcassette.dev) and the format and design
  documents behind it.
- **`plans/`** — git-ignored on purpose. Session reports, handoffs and scratch
  notes live here and are not expected to survive a fresh clone. Anything that
  should outlive the machine it was written on does not belong in `plans/`;
  promote it to one of the files above.

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

Keep commits small and focused — one logical change each. The release notes are
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
call that out explicitly — those are the changes most likely to break someone.

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
| `src/client.ts` | `MiniClient` — the small MCP client used by `check`/`snapshot` |
| `tests/` | Unit tests plus an end-to-end suite against a fixture server |
| `scripts/smoke.sh` | End-to-end dogfood run against the reference server |
| `action.yml` | The composite GitHub Action wrapping `check` and `snapshot` |
| `BACKLOG.md` | Decisions owed before code — see above |

## Reporting security issues

Please don't open a public issue for a security problem — see
[SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the
Apache-2.0 license that covers this project.
