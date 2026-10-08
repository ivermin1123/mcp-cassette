/**
 * The comment the composite action writes is the action's whole output on a
 * pull request, and it is rendered by a script no TypeScript import can reach.
 * So it is driven here the way `action.yml` drives it: a real child process,
 * a RUNNER_TEMP holding the artefacts the steps leave behind, and the step
 * environment as the only input.
 *
 * `lint-fail-on: never` is the case that makes this worth pinning. The verdict
 * it produces is a pass over a log full of findings, which is only legible if
 * the body says which gate it passed.
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(__dirname, "..");
const REPORT = path.join(ROOT, "scripts/contract-report.mjs");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cassette-report-"));

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const CHECK_LOG = ["[FAIL] CAS-L001 get_weather: instruction-override phrasing", "", "result: PASS"].join(
  "\n"
);

/** Renders one report, in its own RUNNER_TEMP, and returns the body. */
function renderReport(env: Record<string, string>): string {
  const runnerTemp = fs.mkdtempSync(path.join(tmpDir, "run-"));
  fs.writeFileSync(path.join(runnerTemp, "mcp-cassette-check.log"), CHECK_LOG);
  const result = spawnSync(process.execPath, [REPORT], {
    encoding: "utf8",
    // A bare env: inheriting GITHUB_* from a real Actions run would make the
    // script try to post a comment on whatever pull request is building this.
    env: { PATH: process.env.PATH ?? "", RUNNER_TEMP: runnerTemp, MODE: "check", ...env },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe("the action's pull-request comment", () => {
  it("names the lint gate, so a pass over findings can be accounted for", () => {
    const body = renderReport({ LINT_FAIL_ON: "never", CHECK_STATUS: "0" });

    expect(body).toContain("**Safety check** (gate: `never`)");
    expect(body).toContain("✅ passed");
    // The findings are still in the body. `never` waives the gate, not the report.
    expect(body).toContain("CAS-L001");
  });

  it("reports the default gate as the failure it is", () => {
    const body = renderReport({ LINT_FAIL_ON: "error", CHECK_STATUS: "1" });

    expect(body).toContain("**Safety check** (gate: `error`)");
    expect(body).toContain("❌ failed");
    expect(body).toContain("### mcp-cassette: ❌ FAIL");
  });

  it("falls back to the default gate when the step environment omits it", () => {
    // An older caller's `action.yml` passes no LINT_FAIL_ON. Rendering `error`
    // is the honest fallback: that is the gate such a caller actually ran.
    const body = renderReport({ CHECK_STATUS: "0" });
    expect(body).toContain("**Safety check** (gate: `error`)");
  });
});
