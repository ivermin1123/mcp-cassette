/**
 * The adapter, proved the only way that means anything: by running vitest.
 *
 * Every claim this adapter makes is a claim about what a *test run* does, so a
 * miss fails the test, the failure names the right cause, a drained miss does
 * not leak into the next test. None of that can be asserted from inside the
 * same process that would have to fail. So a fixture project under
 * tests/fixtures/vitest-adapter is run as its own vitest process and this file
 * reads its verdict.
 *
 * The fixture is excluded from the root config, or the parent run would collect
 * it and inherit its two deliberate failures.
 */

import { describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { useCassette } from "../src/vitest/index.js";

const root = fileURLToPath(new URL("fixtures/vitest-adapter", import.meta.url));

interface VitestJson {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  testResults: Array<{
    name: string;
    assertionResults: Array<{ fullName: string; status: string; failureMessages: string[] }>;
  }>;
}

/** Run the fixture project once and parse its report; a non-zero exit is expected. */
function runFixtureProject(): VitestJson {
  let stdout: string;
  try {
    stdout = execFileSync("npx", ["vitest", "run", "--root", root, "--reporter=json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // Two of the fixture's tests fail on purpose, so vitest exits 1 and
    // execFileSync throws. The report is still on stdout.
    stdout = (err as { stdout?: string }).stdout ?? "";
  }
  const start = stdout.indexOf("{");
  if (start === -1) throw new Error(`fixture project produced no JSON report:\n${stdout}`);
  return JSON.parse(stdout.slice(start)) as VitestJson;
}

describe("the adapter inside a real vitest run", () => {
  const report = runFixtureProject();
  const results = report.testResults.flatMap((f) => f.assertionResults);
  const byName = (needle: string) => results.find((r) => r.fullName.includes(needle));

  it("runs every fixture test, with exactly the two deliberate failures", () => {
    expect(report.numTotalTests).toBe(6);
    expect(report.numFailedTests).toBe(2);
    expect(report.numPassedTests).toBe(4);
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
    expect(byName("spends the recording")?.status).toBe("passed");
    const failed = results.filter((r) => r.status === "failed").map((r) => r.fullName);
    expect(failed.every((n) => n.includes("fails with a"))).toBe(true);
  });

  it("leaves the miss to the assertion in warn mode", () => {
    expect(byName("hands the miss back as a JSON-RPC error")?.status).toBe("passed");
  });
});

describe("stdio cassettes hand back a command instead of a server", () => {
  const tape = useCassette(fileURLToPath(new URL("fixtures/stdio-tape.jsonl", import.meta.url)));

  it("names node, the built CLI, and the cassette", () => {
    expect(tape.command[0]).toBe(process.execPath);
    expect(tape.command[1]).toMatch(/cli\.js$/);
    expect(tape.command.slice(2, 3)).toEqual(["replay"]);
    expect(tape.command[3]).toMatch(/stdio-tape\.jsonl$/);
  });

  it("refuses the HTTP-shaped accessors, by name", () => {
    expect(() => tape.url).toThrow(/stdio cassette/);
    expect(() => tape.server).toThrow(/no in-process server/);
  });

  it("actually replays over stdio when spawned", async () => {
    const child = spawn(tape.command[0]!, tape.command.slice(1), { stdio: ["pipe", "pipe", "ignore"] });
    const answer = new Promise<string>((resolve) => {
      let buf = "";
      child.stdout.on("data", (c: Buffer) => {
        buf += c.toString("utf8");
        const line = buf.split("\n").find((l) => l.trim().length > 0);
        if (line) resolve(line);
      });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) + "\n");
    const line = await answer;
    child.stdin.end();
    child.kill();
    expect(JSON.parse(line)).toMatchObject({ id: 1, result: { tools: [{ name: "echo" }] } });
  });
});

describe("the package surface", () => {
  it("exports exactly the three public paths, and nothing into the build output", () => {
    const manifest = JSON.parse(
      execFileSync("node", ["-p", "JSON.stringify(require('./package.json'))"], { encoding: "utf8" })
    ) as { exports: Record<string, unknown>; peerDependenciesMeta?: Record<string, { optional?: boolean }> };
    expect(Object.keys(manifest.exports).sort()).toEqual([".", "./package.json", "./vitest"]);
    // An escape hatch here would turn the build layout into a public API.
    expect(Object.keys(manifest.exports).some((k) => k.includes("*"))).toBe(false);
    expect(manifest.peerDependenciesMeta?.vitest?.optional).toBe(true);
  });
});
