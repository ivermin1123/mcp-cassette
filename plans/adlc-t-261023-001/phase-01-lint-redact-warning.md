---
phase: 1
title: Helper plus the lint and redact warning
status: pending
---

# Phase 01: helper plus the lint and redact warning

**Delivers:** FR-003, FR-004, FR-005, FR-006, FR-007, FR-008, FR-009, FR-011 ·
SC-006, SC-007, SC-008, SC-009, SC-010 (lint and redact half), SC-011, SC-013 (lint and redact tests fail pre-fix)

## Files

- Create: `tests/extra-args-lint.test.ts`, `tests/extra-args-redact.test.ts`, `tests/extra-args-variadic.test.ts`
- Modify: `src/cli.ts`. Touch only the new helper and the first statement and signature of the `lint` and `redact` actions.
- Do not touch: any existing test file, `package.json`, `package-lock.json`, `action.yml`, and the `record`, `replay`, `verify` builders.

## Steps

0. If `node_modules` is missing, run `adlc-run npm ci`.

## Tests first

Every file uses the harness `spawnSync(process.execPath, [CLI, <cmd>, ...args], { encoding: "utf8" })` returning
`{ code: status ?? -1, stdout, stderr }`, where `CLI = <root>/dist/cli.js`. Temporary files go in an `fs.mkdtempSync` dir
that `afterAll` removes. `GOLDEN = tests/fixtures/tiny-server.golden.cassette.jsonl`.

### `tests/extra-args-lint.test.ts`, describe `lint <cassette>`

1. `warns on stderr about an ignored second cassette path and changes nothing else` (SC-006):
   `lint GOLDEN <tmp>/missing.cassette.jsonl` (the file does not exist). Assert `code === 0`,
   `stdout === \`${GOLDEN}: header and frames agree\n\``, and stderr split on `\n`, with the trailing
   empty element removed, is exactly one line that matches `/^lint: .*ignored.*missing\.cassette\.jsonl/`.
2. `--json stdout is byte-identical with an extra path` (SC-007): `lint GOLDEN b --json` against
   `lint GOLDEN --json`. Assert stdout is strictly equal, the codes are equal, and the extra-operand run's
   stderr is exactly one line matching `/^lint: .*ignored.*\bb\b/`.
3. `a missing first path still exits 1 with the same error, plus the warning` (SC-007):
   `lint <tmp>/nope.cassette.jsonl b` against `lint <tmp>/nope.cassette.jsonl`. Assert both exit 1, stdout is equal (empty),
   and the with-extra stderr equals `lint: ignored ... b` line + the without-extra stderr. That is, its first line matches
   `/^lint: .*ignored.*\bb\b/` and the rest equals the without-extra stderr byte for byte.
4. `names every extra path in order` (FR-003): `lint GOLDEN a b c`. Exactly one stderr line, matching
   `/^lint: .*ignored.*\ba b c\b/`, with exit 0.
5. `prints nothing new without an extra path` (SC-010): `lint GOLDEN`. stderr is `""`.

### `tests/extra-args-redact.test.ts`, describe `redact extra positional argument`

Source cassette: copy `GOLDEN` into tmp as `a.cassette.jsonl`. Config for `--check-config`: write
`{ "patterns": [] }` as `cfg.json`. Its exit path (0 "declares no patterns") does not need the optional `recheck`
peer. If `readRedactConfig` rejects an empty list, use one simple pattern instead, because the gate under test exits
before any analysis.

1. `names the ignored cassette path and writes the same output` (SC-008):
   `redact A <tmp>/b.cassette.jsonl -o out1` and `redact A -o out2`. Assert the codes are equal (0),
   `readFileSync(out1)` equals `readFileSync(out2)` byte for byte (`Buffer.equals`),
   `stdout1.replaceAll(out1, "OUT") === stdout2.replaceAll(out2, "OUT")`, the without-extra stderr is `""`, and
   the with-extra stderr is exactly one line matching `/^redact: .*ignored.*b\.cassette\.jsonl/`.
   `b.cassette.jsonl` does not exist, which proves it is never opened.
2. `--scan output and exit code are unchanged` (SC-009): `redact A b --scan` against `redact A --scan`.
   stdout is strictly equal, the codes are equal, and the extra-operand stderr is exactly one line matching `/^redact: .*ignored.*\bb\b/`.
3. `--check-config usage gate keeps exit 2 and its message, plus the warning naming b` (SC-009):
   `redact --check-config --redact-config cfg.json A b` against the same command without `b`. Both exit 2. The without-extra
   stderr is the existing `redact: --check-config reads the config and writes nothing...` line. The with-extra stderr
   is the warning line followed by that same text. The warning names `b` and does not name the first operand
   (`A` is consumed as `[cassette]`).
4. `prints nothing new without an extra path` (SC-010): `redact A -o out3` and `redact A --scan`. Neither stderr
   contains `ignored`.

### `tests/extra-args-variadic.test.ts`, describe `variadic commands are unchanged` (SC-011, FR-008)

Each case asserts that stderr has no line matching `/^(record|replay|verify): ignored/m`.
1. `replay GOLDEN -- node server.js --flag` with `input: ""`. Trailing words are absorbed by `[command...]`.
2. `verify GOLDEN -- <node> <refuser.mjs> extra`. The refuser script is written to tmp, the same as tests/check-cli.test.ts:60-77:
   it answers every request with a JSON-RPC error, so verify fails fast.
3. `record -o <tmp>/r.cassette.jsonl -- <node> -e "process.exit(0)" extra` with `input: ""`.
Give each case a 30 s timeout. These cases pass before and after the fix. They guard that the change stays away from variadic commands.

Run `adlc-run npm run build`, then the completion check. The lint and redact extra-operand cases fail because stderr has
no `ignored` line.

## Change

In `src/cli.ts`:

1. Next to `NO_ANCHOR_WARNING`, add:
   ```ts
   /**
    * Commander 12 drops operands a command does not declare without a word, so an
    * unquoted --stdio command runs its first word alone. Say so, on stderr only:
    * stdout and the exit code stay exactly what they would have been.
    */
   function warnIgnoredOperands(cmd: Command, stdio?: string): void {
     const ignored = cmd.args.slice(cmd.registeredArguments.length);
     if (ignored.length === 0) return;
     const list = ignored.join(" ");
     const hint =
       stdio === undefined ? "" : `; to pass them to the server, quote the whole command: --stdio "${stdio} ${list}"`;
     // writeSync: several callers reach process.exit, which can drop a queued pipe write.
     fs.writeSync(2, `${cmd.name()}: ignored extra argument(s): ${list}${hint}\n`);
   }
   ```
   If `tsc` rejects `registeredArguments`, use `cmd.processedArgs.length`.
2. `lint`: `.action((cassette: string, opts: { json?: boolean }, cmd: Command) => { warnIgnoredOperands(cmd); try { ...unchanged`.
3. `redact`: `.action(async (cassettePath: string | undefined, opts: RedactCliOptions, cmd: Command) => { warnIgnoredOperands(cmd); try { ...unchanged`.

Nothing else in either action changes. Do not call `allowExcessArguments`. Add no dependency.

## Acceptance

- The new lint and redact tests pass. The existing `tests/lint-cli.test.ts` golden test passes unchanged.
- `git diff src/cli.ts` shows only the helper and the two action lines.

## Completion check

`adlc-run npx vitest run --reporter=junit --outputFile=.adlc/reports/junit.xml`

Run it after `adlc-run npm run build`. Before this phase it fails on the lint and redact extra-operand cases. After this phase it passes.
