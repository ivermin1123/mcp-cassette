---
phase: 3
title: CHANGELOG Unreleased entry and final gates
status: pending
---

# Phase 03: CHANGELOG `[Unreleased]` entry and final gates

**Delivers:** FR-009, FR-010 · SC-010 (smoke and golden unchanged), SC-012, SC-013 (build, tsc and suite green)

## Files

- Modify: `CHANGELOG.md`
- Must stay unchanged: `action.yml`, `package.json`, `package-lock.json`, `scripts/smoke.sh`

## Tests first

This is a docs-only change and no test can observe it. No test pins the CHANGELOG, because such a test would break at the next
release, when `[Unreleased]` is renamed. The criteria are checked on the diff (see Completion check).

## Change

In `CHANGELOG.md`, directly above `## [0.10.0] - 2026-10-10` (line 9), insert:

```markdown
## [Unreleased]

- `check`, `snapshot`, `lint` and `redact` print one stderr line naming any positional argument they ignore (commander 12 drops it silently), with a hint to quote the `--stdio` command; exit codes and stdout are unchanged, and a token starting with `-` (as in an unquoted `npx -y ...`) is still rejected by commander before this warning can run.

```

The section holds exactly one entry line: one list item on one physical line.

## Final gates (SC-013)

Run in order:
1. `adlc-run npm run build`
2. `adlc-run npx tsc --noEmit`
3. The completion check below.

All three exit 0.

## Completion check

`adlc-run npx vitest run --reporter=junit --outputFile=.adlc/reports/junit.xml`

No test observes this phase. The check only shows that nothing broke. QA proves the criteria from the diff against the base:
- `CHANGELOG.md` is touched. It gains `## [Unreleased]` above `## [0.10.0] - 2026-10-10`, and exactly one non-blank line sits between those two headings (FR-010, SC-012).
- `action.yml` is unchanged (FR-010, SC-012).
- `package.json` and `package-lock.json` are unchanged. commander stays `^12.1.0` / 12.1.0, and no dependency is added (FR-009, SC-012).
- `scripts/smoke.sh` is unchanged (SC-010).
