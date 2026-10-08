/**
 * The jest adapter, proved the only way that means anything: by running jest.
 *
 * Every claim this adapter makes is a claim about what a *test run* does, so a
 * miss fails the test, the failure names the right cause, a drained miss does
 * not leak into the next test. None of that can be asserted from inside the
 * same process that would have to fail. So a fixture project under
 * tests/fixtures/jest is run as its own jest process and this file reads its
 * verdict.
 *
 * The fixture imports the adapter as `mcp-cassette/jest`, the specifier a
 * consumer writes, so the run also proves the export map and the built output,
 * not just the source.
 *
 * The fixture is excluded from the root config, or the parent run would collect
 * its plain-.js specs and inherit its two deliberate failures.
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const jestCli = fileURLToPath(new URL("../node_modules/jest/bin/jest.js", import.meta.url));
const jestConfig = fileURLToPath(new URL("fixtures/jest/jest.config.mjs", import.meta.url));

interface JestJson {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  testResults: Array<{
    name: string;
    message: string;
    assertionResults: Array<{ fullName: string; status: string; failureMessages: string[] }>;
  }>;
}

/**
 * Run the fixture project once and parse its report; a non-zero exit is expected.
 *
 * jest is invoked through its own CLI entry rather than `npx`, so the run can
 * never reach the network, and under `--experimental-vm-modules`, which is the
 * flag a consumer needs for ESM and therefore part of what is being proved.
 */
function runFixtureProject(): JestJson {
  const argv = [jestCli, "--config", jestConfig, "--json"];
  let stdout: string;
  try {
    stdout = execFileSync(process.execPath, argv, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --experimental-vm-modules`.trim() },
    });
  } catch (err) {
    // Two of the fixture's tests fail on purpose, so jest exits 1 and
    // execFileSync throws. The report is still on stdout.
    stdout = (err as { stdout?: string }).stdout ?? "";
  }
  const start = stdout.indexOf("{");
  if (start === -1) throw new Error(`fixture project produced no JSON report:\n${stdout}`);
  return JSON.parse(stdout.slice(start)) as JestJson;
}

/**
 * Did the host Node, rather than the adapter, make this run impossible?
 *
 * jest's native ESM mode is built on `vm.SourceTextModule`, and Node 24.6.0
 * shipped a regression that throws "module is already linked" the second time
 * a shared dependency is handed to the linker. Any ESM graph where two modules
 * import the same third one hits it, so under that Node every jest ESM suite
 * fails to load, this package's or anyone else's, before a line of adapter
 * code runs. Measured against this repo: 24.5.0 fine, 24.6.0 broken, 24.7.0
 * fine, Node 20 and 22 never affected.
 *
 * The condition is deliberately narrow. Not one test may have run, and every
 * suite must have died of that one error, so a genuine adapter failure can
 * never take this exit. It also needs no version list and starts asserting
 * again by itself on a Node that works.
 */
function isHostLinkFailure(report: JestJson): boolean {
  return (
    report.numTotalTests === 0 &&
    report.testResults.length > 0 &&
    report.testResults.every((suite) => suite.message.includes("module is already linked"))
  );
}

const report = runFixtureProject();
const hostCanRunJestEsm = !isHostLinkFailure(report);
const runTitle = hostCanRunJestEsm
  ? "the adapter inside a real jest run"
  : "the adapter inside a real jest run (skipped: this Node cannot link a shared ESM dependency inside vm)";

describe.skipIf(!hostCanRunJestEsm)(runTitle, () => {
  const results = report.testResults.flatMap((f) => f.assertionResults);
  const byName = (needle: string) => results.find((r) => r.fullName.includes(needle));

  it("runs every fixture test, with exactly the two deliberate failures", () => {
    expect(report.numTotalTests).toBe(9);
    expect(report.numFailedTests).toBe(2);
    expect(report.numPassedTests).toBe(7);
  });

  it("answers a recorded call without a server", () => {
    expect(byName("is answered from the cassette")?.status).toBe("passed");
  });

  it("fails the test whose arguments drifted, and names it a mismatch", () => {
    const drifted = byName("fails with a mismatch");
    expect(drifted?.status).toBe("failed");
    const message = drifted?.failureMessages.join("\n") ?? "";
    expect(message).toContain("CassetteMismatchError");
    // The diagnosis travels with the failure, so the fix is in the output.
    expect(message).toContain("arguments differ at");
    expect(message).toContain("/m");
  });

  it("fails the test that asked for an unrecorded tool, and names it a miss", () => {
    const missing = byName("fails with a miss");
    expect(missing?.status).toBe("failed");
    const message = missing?.failureMessages.join("\n") ?? "";
    expect(message).toContain("CassetteMissError");
    expect(message).toContain('no recorded tools/call for tool "never-recorded"');
    // Not the other class: the two are distinguishable in the report itself.
    expect(message).not.toContain("CassetteMismatchError");
  });

  it("attributes each miss to the test that caused it", () => {
    // The drain is what makes this true: the test that merely spent the
    // recording passes, sitting between nothing and the two failures.
    expect(byName("misses fail the test that caused them spends the recording")?.status).toBe("passed");
    const failed = results.filter((r) => r.status === "failed").map((r) => r.fullName);
    expect(failed.every((n) => n.includes("fails with a"))).toBe(true);
  });

  it("leaves the miss to the assertion in warn mode", () => {
    expect(byName("hands the miss back as a JSON-RPC error")?.status).toBe("passed");
  });

  it("hands a stdio cassette back as a command, and replays it when spawned", () => {
    expect(byName("names node, the built CLI, and the cassette")?.status).toBe("passed");
    expect(byName("refuses the HTTP-shaped accessors")?.status).toBe("passed");
    expect(byName("actually replays over stdio when spawned")?.status).toBe("passed");
  });
});

describe("the built jest entry point", () => {
  // The fixture resolves `mcp-cassette/jest` for real, which is the stronger
  // proof, but it only runs where jest's ESM mode does. This holds everywhere.
  it("lands where the export map points, types included", () => {
    expect(existsSync(fileURLToPath(new URL("../dist/jest/index.js", import.meta.url)))).toBe(true);
    expect(existsSync(fileURLToPath(new URL("../dist/jest/index.d.ts", import.meta.url)))).toBe(true);
  });
});
