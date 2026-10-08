/**
 * End-to-end for the `check` gate: the built CLI, a real child process, and the
 * exit codes CI (and the GitHub Action's `lint-fail-on` input) depend on.
 *
 * Kept out of e2e.test.ts for the same reason snapshot-cli.test.ts is: the
 * gate's contract is an exit code, and an exit code deserves to fail on its own
 * line rather than inside an assertion about findings.
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(__dirname, "..");
const TINY = path.join(ROOT, "tests/fixtures/tiny-server.mjs");
const CLI = path.join(ROOT, "dist/cli.js");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cassette-check-"));

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * A launcher for the poisoned fixture on disk. `--stdio` takes a single command
 * string that the CLI tokenizes with quote handling but no backslash escapes,
 * so neither an inline `node -e "..."` program nor an `env VAR=1` prefix would
 * survive the round trip on every platform.
 */
const EVIL_LAUNCHER = path.join(tmpDir, "evil-server.mjs");
fs.writeFileSync(
  EVIL_LAUNCHER,
  `process.env.TINY_EVIL = "1";\nawait import(${JSON.stringify(pathToFileURL(TINY).href)});\n`
);
const EVIL_STDIO = `"${process.execPath}" "${EVIL_LAUNCHER}"`;
const CLEAN_STDIO = `"${process.execPath}" "${TINY}"`;

/**
 * A server that speaks JSON-RPC and refuses every request, so the handshake
 * fails in both eras within milliseconds. A command that simply does not exist
 * would prove the same thing by burning two 15-second handshake timeouts.
 */
const REFUSER = path.join(tmpDir, "refuser.mjs");
// String.raw, so the `\n` escapes below reach the generated file as escapes
// rather than as the literal newlines that would make it unparseable.
fs.writeFileSync(
  REFUSER,
  String.raw`let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    const error = { code: -32600, message: "refused" };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error }) + "\n");
  }
});
`
);
const REFUSER_STDIO = `"${process.execPath}" "${REFUSER}"`;

function runCheckCli(args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, "check", ...args], { encoding: "utf8" });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe("check --fail-on", () => {
  it("fails a server with error-level findings at the default gate", () => {
    const run = runCheckCli(["--stdio", EVIL_STDIO]);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("CAS-L001");
  }, 20_000);

  it("reports the same findings and exits 0 at never", () => {
    const gated = runCheckCli(["--stdio", EVIL_STDIO]);
    const ungated = runCheckCli(["--fail-on", "never", "--stdio", EVIL_STDIO]);

    // The point of the level: the report is identical, only the verdict moves.
    expect(ungated.code).toBe(0);
    const codes = (out: string) => out.match(/CAS-[A-Z]\d+/g) ?? [];
    expect(codes(ungated.stdout)).toEqual(codes(gated.stdout));
    expect(codes(ungated.stdout).length).toBeGreaterThan(0);
    expect(ungated.stdout).toContain("gate: never");
  }, 20_000);

  it("still exits 2 at never when the server cannot be inspected at all", () => {
    // `never` waives findings, not the handshake. A server that never answered
    // produced no report to waive, and a silent 0 here would turn the gate into
    // a check that passes hardest when it ran least.
    const run = runCheckCli(["--fail-on", "never", "--stdio", REFUSER_STDIO]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("server answered neither era");
  }, 20_000);

  it("keeps a clean server green at every level", () => {
    for (const level of ["error", "warn", "never"]) {
      expect(runCheckCli(["--fail-on", level, "--stdio", CLEAN_STDIO]).code, level).toBe(0);
    }
  }, 30_000);

  it("writes the findings into SARIF at never, so the report survives the waived gate", () => {
    const run = runCheckCli([
      "--fail-on",
      "never",
      "--format",
      "sarif",
      "--stdio",
      EVIL_STDIO,
    ]);
    expect(run.code).toBe(0);
    const doc = JSON.parse(run.stdout) as { runs: { results: { ruleId: string }[] }[] };
    expect(doc.runs[0]!.results.map((r) => r.ruleId)).toContain("CAS-L001");
  }, 20_000);

  it("rejects an unknown level instead of silently gating on error", () => {
    const run = runCheckCli(["--fail-on", "none", "--stdio", CLEAN_STDIO]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("--fail-on must be error, warn or never");
  }, 20_000);
});
