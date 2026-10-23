---
title: Warn when a command drops an extra positional argument
status: pending
mode: hard
tdd: true
task: t-261023-001
---

# Plan: warn when a command drops an extra positional argument

Commander 12.1.0 silently drops operands that `check`, `snapshot`, `lint` and `redact` do not declare.
After this plan each of the four commands writes one advisory stderr line naming every operand it
ignored (with a quoting hint when `--stdio` was given). Exit codes, stdout bytes and written files stay
identical to the run without the extra operand. `record`, `replay` and `verify` end in a variadic
argument and are not touched.

## Design (decided)

- **One small helper, four call sites.** The spec's chosen direction is "at the start of each of the four
  actions". Add `warnIgnoredOperands(cmd: Command, stdio?: string)` to `src/cli.ts` and call it as the
  **first statement** of the `lint`, `redact`, `check` and `snapshot` actions, before any `try`, validation,
  `resolveTarget`, file read or `process.exit`. No program-level `preAction` hook: it would also run
  for `record`/`replay`/`verify`, and the spec's non-goal rules out a CLI-wide mechanism. The diff therefore
  touches no line inside the `record`, `replay` or `verify` builders.
- **Ignored operands** = `cmd.args.slice(cmd.registeredArguments.length)`. (`check`/`snapshot` declare
  0 operands, `lint`/`redact` declare 1.) If `npx tsc --noEmit` rejects `registeredArguments` on the 12.1.0
  typings, use `cmd.processedArgs.length` instead. Both counts are equal for these four commands.
  Commander passes the `Command` as the last action argument: `(opts, cmd)` for check and snapshot,
  `(cassette, opts, cmd)` for lint and redact.
- **Delivery:** `fs.writeSync(2, line)`. The write is synchronous, so `process.exit` cannot truncate it
  (FR-004). Nothing is written to stdout.
- **Line format, exactly one line, ending in `\n`:**
  - without `--stdio`: `<cmd>: ignored extra argument(s): <op1> <op2> ...`
  - with `--stdio`: the same text, then
    `; to pass them to the server, quote the whole command: --stdio "<stdio value> <op1> <op2> ..."`
  - `<cmd>` is `check`, `snapshot`, `lint` or `redact`. Operands appear verbatim, in the order given,
    joined by single spaces. The hint is the raw `--stdio` value plus the operands inside plain double
    quotes, with no inner escaping (help text uses the same form, src/cli.ts:450-455). It says nothing about
    dash-prefixed tokens, which commander rejects before the action runs.
- **No extra operands, no output:** the helper returns without writing anything (FR-007).

## Test approach

New tests go in new files only. Each file spawns the built `dist/cli.js` with `spawnSync(..., { encoding: "utf8" })`,
which is the harness pattern of tests/lint-cli.test.ts:27-30. The tests read `dist/`, so Cook runs
`adlc-run npm run build` before every test run. On a fresh worktree Cook first runs `adlc-run npm ci`.

| File | Phase | Covers |
|---|---|---|
| `tests/extra-args-lint.test.ts` | 1 | SC-006, SC-007, SC-010 (lint) |
| `tests/extra-args-redact.test.ts` | 1 | SC-008, SC-009, SC-010 (redact) |
| `tests/extra-args-variadic.test.ts` | 1 | SC-011 |
| `tests/extra-args-check.test.ts` | 2 | SC-001, SC-002, SC-003, SC-005, SC-010 (check) |
| `tests/extra-args-snapshot.test.ts` | 2 | SC-004, SC-010 (snapshot) |

The spec's Reproduction section names existing test files. The engine allows new tests only in new
files, so the same cases live in the new files above under the same `describe`/`it` names.

## Phases

| # | File | Delivers | Status |
|---|---|---|---|
| 1 | [phase-01-lint-redact-warning.md](phase-01-lint-redact-warning.md) | FR-003, FR-004, FR-005, FR-006, FR-007, FR-008, FR-009, FR-011 · SC-006..SC-011, SC-013 | pending |
| 2 | [phase-02-check-snapshot-warning.md](phase-02-check-snapshot-warning.md) | FR-001, FR-002, FR-004, FR-005, FR-006, FR-007, FR-011 · SC-001..SC-005, SC-010, SC-013 | pending |
| 3 | [phase-03-changelog.md](phase-03-changelog.md) | FR-009, FR-010 · SC-010, SC-012, SC-013 | pending |

## Out of reach (documented, not built)

- `check --stdio npx -y @pkg`: commander rejects `-y` as an unknown option before the action runs.
  Behaviour does not change and no warning is printed.
- `check --help extra` / `--version extra`: commander handles these before the action, so no warning.
- `check --stdio "x" -- y` reports `y` as ignored. This is an intended, visible change.

## Risks

- Stale `dist/` makes CLI tests misleading. Mitigation: build before each test run.
- stdout leak: the json, sarif and text parity tests compare stdout byte for byte.
- check and snapshot already write probe lines to stderr (src/client.ts). So tests for those two commands
  count lines that match the warning pattern and never diff the whole stderr. lint and redact spawn no server,
  so their tests assert the exact whole stderr.
