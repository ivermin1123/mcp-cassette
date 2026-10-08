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

const CHECK_LOG = [
  "[FAIL] CAS-L001 get_weather: instruction-override phrasing",
  "",
  "result: PASS (1 error(s), 0 warning(s), gate: error, lint: never)",
].join("\n");

interface Rendered {
  /** What the script printed, which is what the job log shows. */
  stdout: string;
  /** What it left in RUNNER_TEMP for the rest of the job to read. */
  file: string | null;
}

/** Renders one report, in its own RUNNER_TEMP. */
function render(stepEnv: Record<string, string>): Rendered {
  const runnerTemp = fs.mkdtempSync(path.join(tmpDir, "run-"));
  fs.writeFileSync(path.join(runnerTemp, "mcp-cassette-check.log"), CHECK_LOG);
  const result = spawnSync(process.execPath, [REPORT], {
    encoding: "utf8",
    // A bare environment: inheriting GITHUB_* from a real Actions run would
    // make the script try to post a comment on whatever pull request is
    // building this.
    env: Object.assign(
      { PATH: process.env.PATH ?? "", RUNNER_TEMP: runnerTemp, MODE: "check" },
      stepEnv
    ),
  });
  expect(result.status, result.stderr).toBe(0);
  const reportFile = path.join(runnerTemp, "mcp-cassette-report.md");
  return {
    stdout: result.stdout,
    file: fs.existsSync(reportFile) ? fs.readFileSync(reportFile, "utf8") : null,
  };
}

const renderReport = (stepEnv: Record<string, string>): string => render(stepEnv).stdout;

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

/**
 * The step summary file Actions hands a step is unique to that step, so nothing
 * later in the job can read a report back out of it. RUNNER_TEMP spans the job,
 * and the copy left there is what lets a workflow prove the report was rendered
 * at all. That matters because the action used to skip rendering entirely when
 * a gate failed, and a job that is merely red looks identical either way.
 */
describe("the rendered report left for the rest of the job", () => {
  it("is written, and matches what the log showed", () => {
    const { stdout, file } = render({ CHECK_STATUS: "0" });
    expect(file).not.toBeNull();
    expect(file!.trimEnd()).toBe(stdout.trimEnd());
  });

  it("records a failing gate, which is the case it exists for", () => {
    const { file } = render({ CHECK_STATUS: "1" });
    expect(file).toContain("### mcp-cassette: ❌ FAIL");
    expect(file).toContain("CAS-L001");
  });

  it("is skipped rather than guessed at when there is no RUNNER_TEMP", () => {
    // The script also runs outside Actions. Writing into the process cwd there
    // would litter a consumer's checkout with a file they never asked for.
    const elsewhere = fs.mkdtempSync(path.join(tmpDir, "no-runner-temp-"));
    const result = spawnSync(process.execPath, [REPORT], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", MODE: "check", CHECK_STATUS: "0" },
      cwd: elsewhere,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });
});
