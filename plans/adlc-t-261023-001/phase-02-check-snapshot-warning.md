---
phase: 2
title: check and snapshot warning with the --stdio quoting hint
status: pending
---

# Phase 02: check and snapshot warning with the `--stdio` quoting hint

**Delivers:** FR-001, FR-002, FR-004, FR-005, FR-006, FR-007, FR-011 ·
SC-001, SC-002, SC-003, SC-004, SC-005, SC-010 (check and snapshot half), SC-013 (check and snapshot tests fail pre-fix)

Depends on phase 01 for `warnIgnoredOperands` in `src/cli.ts`.

## Files

- Create: `tests/extra-args-check.test.ts`, `tests/extra-args-snapshot.test.ts`
- Modify: `src/cli.ts`. Touch only the signature and first statement of the `check` and `snapshot` actions.
- Do not touch: any existing test file, `action.yml`, `scripts/smoke.sh`, help text, and the `record`, `replay`, `verify` builders.

## Tests first

The harness is the same as tests/check-cli.test.ts:78-81: `spawnSync(process.execPath, [CLI, cmd, ...args], { encoding: "utf8" })`.
Copy the fixture setup from tests/check-cli.test.ts:22-77 into the new file without importing it. That setup provides `CLEAN_STDIO`,
`POISONED_STDIO` via `launcher(..., "TINY_POISONED")`, and `REFUSER_STDIO`. Copy `V2_STDIO` from tests/snapshot-cli.test.ts:30-34.
Helper: `warnLines(stderr, cmd) = stderr.split("\n").filter((l) => new RegExp(\`^${cmd}: .*ignored\`).test(l))`.
These commands already print probe lines to stderr, so the tests count warning lines and never diff the whole stderr.
Give each case a 30 s timeout.

### `tests/extra-args-check.test.ts`, describe `check extra positional argument`

1. `names the ignored argument and suggests quoting --stdio, with the same exit code` (SC-001): for each of
   `[CLEAN_STDIO, 0]`, `[POISONED_STDIO, 1]`, `[REFUSER_STDIO, 2]`, run `check --stdio <fx> extra1` and
   `check --stdio <fx>`. Both codes equal the expected value. `warnLines(with, "check")` has length exactly 1, matches
   `/^check: .*ignored.*extra1/` and contains `quote`. `warnLines(without, "check")` has length 0 (SC-010).
   The REFUSER case exits 2 through `process.exit`, which also proves FR-004 delivery.
2. `names every ignored argument in order on one line` (SC-002): `check --stdio REFUSER_STDIO a b`. Exactly one warning
   line. It names `a` before `b`: assert it matches `/ignored extra argument\(s\): a b\b/`.
3. `json and sarif stdout are byte-identical with an extra argument` (SC-003): for `--format json` and
   `--format sarif`, compare `check --stdio CLEAN_STDIO extra1 --format <f>` with the same command without `extra1`.
   `stdout` is strictly equal and the codes are equal. Also compare text format (`check --stdio CLEAN_STDIO extra1`, the FR-006 text case).
4. `with --url names the argument without the quoting hint` (SC-005): `check --url http://127.0.0.1:1/mcp extra1`
   against the same command without `extra1`. Both exit 2 (`check failed:` path). There is exactly one warning line, it matches
   `/^check: .*ignored.*extra1/`, and it does not contain `quote` or `--stdio`.
5. `the warning precedes an early usage error` (FR-004): `check --stdio REFUSER_STDIO x --fail-on bogus`. Exit 2.
   The stderr line at index 0 is the warning naming `x`. The next line starts with `check: --fail-on must be error or warn`.
6. `operands after -- are reported` (scenario): `check --stdio REFUSER_STDIO -- y`. There is exactly one warning line naming `y`, with exit 2.
7. `without --stdio or --url there is no quoting hint` (advice §4): `check npx @pkg`. Exit 2, the same as `check`
   alone. There is one warning line naming `npx @pkg`, and it does not contain `quote`.

### `tests/extra-args-snapshot.test.ts`, describe `snapshot extra positional argument`

A frozen clock makes written snapshot files byte-comparable. `captureContract` stamps `capturedAt: new Date()` into the file
(src/snapshot.ts:137). The test writes `<tmp>/freeze-date.cjs`:
```js
const RealDate = Date;
const FIXED = RealDate.parse("2026-01-01T00:00:00.000Z");
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); }
};
```
The test then spawns the CLI as `spawnSync(process.execPath, ["--require", FREEZE, CLI, "snapshot", ...args], ...)`.
Only `new Date()` with no arguments is pinned. `Date.now` and timers stay real, and the server child is not preloaded.
`src/` is not changed for this.

1. `names the ignored argument and suggests quoting --stdio, with the same exit code` (SC-004, `--check`
   mode): `snapshot --check -f tests/fixtures/tiny-server.snapshot.json --stdio V2_STDIO extra` against the same
   command without `extra`. The codes are equal and stdout is strictly equal. There is exactly one warning line, it matches
   `/^snapshot: .*ignored.*extra/` and contains `quote`. The run without `extra` has zero warning lines (SC-010).
2. `write mode: same stdout and a byte-identical file` (SC-004): run 1 is `snapshot --stdio V2_STDIO -f <tmp>/s.json --update`
   with no extra. Read its bytes as B1 and its stdout as O1. Run 2 is `snapshot --stdio V2_STDIO -f <tmp>/s.json --update extra`. Read B2 and O2.
   Both runs use the frozen clock. Both exit 0, `O1 === O2` (`wrote <file> (N tools)\n`) and `B1.equals(B2)`. Run 2 has exactly one
   warning line naming `extra` and containing `quote`.
3. `the warning reaches the pipe before an early exit` (FR-004): `snapshot --check -f <tmp>/absent.json --stdio V2_STDIO extra`
   exits 2, the same as without `extra`. The warning line is present and comes before the `snapshot --check: no snapshot at` line.

Run `adlc-run npm run build`, then the completion check. The cases that expect a warning fail, because there is no `ignored` line.

## Change

In `src/cli.ts`, using the phase-01 helper:

1. `check`: change the action to `async (opts: {...unchanged...}, cmd: Command) => {` and make
   `warnIgnoredOperands(cmd, opts.stdio);` its first statement, before `try`.
2. `snapshot`: change the action the same way and make `warnIgnoredOperands(cmd, opts.stdio);` its first statement, before `try`.

The hint appears only when `opts.stdio` is defined, which is the FR-002 rule. Nothing else in either action changes.

## Acceptance

- The new check and snapshot tests pass. The existing `tests/check-cli.test.ts` and `tests/snapshot-cli.test.ts` pass unchanged.
- `scripts/smoke.sh` quotes every `--stdio` value, so the change does not affect it (SC-010). This file is not modified.

## Completion check

`adlc-run npx vitest run --reporter=junit --outputFile=.adlc/reports/junit.xml`

Run it after `adlc-run npm run build`. Before this phase it fails on the check and snapshot extra-operand cases. After this phase it passes.
