#!/usr/bin/env node
/**
 * Prove every safety-lint pattern runs in linear time.
 *
 * The lint reads text an attacker wrote. A pattern with catastrophic
 * backtracking would turn that into a denial of service against the very CI
 * job meant to be checking the attacker's tool, so "these regexes look fine"
 * is not a standard this file accepts. `recheck` decides it by analysis, not by
 * eyeballing.
 *
 * Two things are checked, and the second matters as much as the first:
 *
 *   1. every published pattern is provably linear;
 *   2. every rule either publishes a pattern or is named in EXEMPT below.
 *
 * Without (2) a new rule could hide a regex inside its `find` and never be
 * looked at. Adding a rule therefore forces a deliberate choice here.
 */

import { check } from "recheck";
import { LINT_RULES } from "../dist/lint.js";

/** Rules that legitimately match without a regex. Each needs a reason. */
const EXEMPT = new Map([["CAS-L008", "a length comparison, so there is no pattern to analyse"]]);

const rows = [];
let failures = 0;

for (const rule of LINT_RULES) {
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

  const { source, flags } = rule.pattern;
  // `safe` is recheck's verdict that no super-linear blowup exists. Its
  // `complexity.type` narrows that further (`constant`, `linear`) but is
  // reported as plain `safe` when the fuzz checker settles it, so the status is
  // what decides and the complexity is printed for information.
  const diagnostics = await check(source, flags, { timeout: 60_000 });
  const complexity = diagnostics.complexity?.type ?? "unreported";

  if (diagnostics.status === "safe") {
    rows.push([rule.id, "safe", `${complexity}, via ${diagnostics.checker}`]);
  } else {
    failures++;
    const detail =
      diagnostics.status === "vulnerable"
        ? `${complexity} blowup, attack string: ${JSON.stringify(diagnostics.attack?.pattern ?? "?")}`
        : `status "${diagnostics.status}": recheck could not decide, so this is not a proof`;
    rows.push([rule.id, "FAIL", detail]);
  }
}

// A rule listed as exempt that no longer exists is stale bookkeeping, and the
// next person would trust it.
for (const id of EXEMPT.keys()) {
  if (!LINT_RULES.some((r) => r.id === id)) {
    failures++;
    rows.push([id, "STALE", "listed in EXEMPT but no such rule exists"]);
  }
}

const width = Math.max(...rows.map(([id]) => id.length));
for (const [id, verdict, detail] of rows) {
  console.log(`${id.padEnd(width)}  ${verdict.padEnd(10)}  ${detail}`);
}

const analysed = rows.filter(([, v]) => v === "safe").length;
console.log(`\n${analysed} pattern(s) proven free of super-linear blowup, ${EXEMPT.size} exempt, ${failures} failure(s)`);

if (failures > 0) {
  console.error("\nrecheck-rules: a lint pattern is not proven linear-time");
  process.exit(1);
}
