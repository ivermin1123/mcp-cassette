#!/usr/bin/env node
/**
 * Prove every pattern this tool runs over untrusted text takes linear time.
 *
 * Two sets qualify, for the same reason. The safety lint reads tool
 * descriptions an attacker wrote, and the redaction rules read every string a
 * server answers with, which on a hostile server is the same thing. A pattern
 * with catastrophic backtracking turns either one into a denial of service
 * against the job meant to be checking that server, so "these regexes look
 * fine" is not a standard this file accepts. `recheck` decides it by analysis,
 * not by eyeballing.
 *
 * Two things are checked, and the second matters as much as the first:
 *
 *   1. every published pattern is provably linear;
 *   2. every lint rule either publishes a pattern or is named in EXEMPT below.
 *
 * Without (2) a new rule could hide a regex inside its `find` and never be
 * looked at. Adding a rule therefore forces a deliberate choice here.
 *
 * A user's own `--redact-config` patterns are not here, because they are not in
 * this repository. `redact --check-config` runs this same analysis over them.
 */

import { check } from "recheck";
import { LINT_RULES } from "../dist/lint.js";
// The output-side CAS-L006 is a rule the lint runs and the catalogue does not
// hold, so iterating LINT_RULES alone would leave its pattern unanalysed.
import { INVISIBLE_RUN_RULE } from "../dist/lint-rules.js";
import { REDACT_RULES } from "../dist/redact.js";

/** Rules that legitimately match without a regex. Each needs a reason. */
const EXEMPT = new Map([["CAS-L008", "a length comparison, so there is no pattern to analyse"]]);

/**
 * Redaction rules recheck calls polynomial and this project accepts, each with
 * the reason and the measurement that settled it.
 *
 * Both are the quadratic the comments beside them in `src/redact.ts` describe
 * and cap: one candidate start every few characters, each rescanning what
 * follows. The caps are the fix, and they work by bounding the rescan to a
 * constant rather than by removing the second factor, so recheck still reports
 * the shape as polynomial while the cost is linear with a constant multiplier.
 * Measured on the capped patterns, over recheck's own attack strings:
 * `urlcreds` 0.5ms at 8KB, 3.0ms at 64KB, 25.1ms at 512KB; `jwt` 11.2ms at
 * 16KB, 90.1ms at 128KB, 691.1ms at 1MB. Eight times the input costs about
 * eight times the time in both, which is the claim the caps were added to make.
 *
 * This list is not a category exemption. A redaction rule not named here must
 * come back `safe`, and an entry whose rule no longer exists is reported stale
 * like any other.
 */
const REDACT_ACCEPTED = new Map([
  ["urlcreds", "capped scheme length bounds the rescan; measured linear, 25.1ms at 512KB"],
  ["jwt", "capped segment lengths bound the rescan; measured linear, 691.1ms at 1MB"],
]);

const rows = [];
let failures = 0;

/** One pattern through recheck, reported as a row. `accepted` forgives a known polynomial. */
async function analyse(id, pattern, accepted) {
  const { source, flags } = pattern;
  // `safe` is recheck's verdict that no super-linear blowup exists. Its
  // `complexity.type` narrows that further (`constant`, `linear`) but is
  // reported as plain `safe` when the fuzz checker settles it, so the status is
  // what decides and the complexity is printed for information.
  const diagnostics = await check(source, flags, { timeout: 60_000 });
  const complexity = diagnostics.complexity?.type ?? "unreported";

  if (diagnostics.status === "safe") {
    rows.push([id, "safe", `${complexity}, via ${diagnostics.checker}`]);
    return;
  }
  if (accepted && diagnostics.status === "vulnerable" && complexity === "polynomial") {
    rows.push([id, "accepted", `${complexity}: ${accepted}`]);
    return;
  }
  failures++;
  const detail =
    diagnostics.status === "vulnerable"
      ? `${complexity} blowup, attack string: ${JSON.stringify(diagnostics.attack?.pattern ?? "?")}`
      : `status "${diagnostics.status}": recheck could not decide, so this is not a proof`;
  rows.push([id, "FAIL", detail]);
}

for (const rule of [...LINT_RULES, INVISIBLE_RUN_RULE]) {
  if (!rule.pattern) {
    const reason = EXEMPT.get(rule.id);
    if (reason) {
      rows.push([rule.id, "exempt", reason]);
    } else {
      failures++;
      rows.push([rule.id, "UNDECLARED", "no `pattern` published and not listed in EXEMPT"]);
    }
    continue;
  }

  await analyse(rule.id, rule.pattern);
}

// The redaction rules run over every string a server answers with, so they are
// held to the same standard as the lint's.
for (const rule of REDACT_RULES) {
  await analyse(`redact:${rule.id}`, rule.pattern, REDACT_ACCEPTED.get(rule.id));
}

// A rule listed as exempt that no longer exists is stale bookkeeping, and the
// next person would trust it.
for (const id of EXEMPT.keys()) {
  if (!LINT_RULES.some((r) => r.id === id)) {
    failures++;
    rows.push([id, "STALE", "listed in EXEMPT but no such rule exists"]);
  }
}
for (const id of REDACT_ACCEPTED.keys()) {
  if (!REDACT_RULES.some((r) => r.id === id)) {
    failures++;
    rows.push([`redact:${id}`, "STALE", "listed in REDACT_ACCEPTED but no such rule exists"]);
  }
}

const width = Math.max(...rows.map(([id]) => id.length));
for (const [id, verdict, detail] of rows) {
  console.log(`${id.padEnd(width)}  ${verdict.padEnd(10)}  ${detail}`);
}

const analysed = rows.filter(([, v]) => v === "safe").length;
const accepted = rows.filter(([, v]) => v === "accepted").length;
console.log(
  `\n${analysed} pattern(s) proven free of super-linear blowup, ${EXEMPT.size} exempt, ` +
    `${accepted} accepted polynomial, ${failures} failure(s)`
);

if (failures > 0) {
  console.error("\nrecheck-rules: a pattern is not proven linear-time");
  process.exit(1);
}
