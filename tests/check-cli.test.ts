/**
 * End-to-end for the `check` gates: the built CLI, a real child process, and
 * the exit codes CI (and the GitHub Action's `lint-fail-on` input) depend on.
 *
 * Kept out of e2e.test.ts for the same reason snapshot-cli.test.ts is: the
 * gate's contract is an exit code, and an exit code deserves to fail on its own
 * line rather than inside an assertion about findings.
 *
 * The case worth the most care is the boundary of `--lint-fail-on never`. It
 * waives an opinion about text an attacker wrote; it must not waive the server
 * being broken, which is why the poisoned fixture is used in both of its
 * shapes: `TINY_POISONED` is lint findings on a structurally sound server, and
 * `TINY_EVIL` is the same plus a tool whose inputSchema is not valid JSON
 * Schema.
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
 * Launchers on disk. `--stdio` takes a single command string that the CLI
 * tokenizes with quote handling but no backslash escapes, so neither an inline
 * `node -e "..."` program nor an `env VAR=1` prefix would survive the round
 * trip on every platform.
 */
function launcher(name: string, flag: string): string {
  const file = path.join(tmpDir, `${name}.mjs`);
  fs.writeFileSync(
    file,
    `process.env.${flag} = "1";\nawait import(${JSON.stringify(pathToFileURL(TINY).href)});\n`
  );
  return `"${process.execPath}" "${file}"`;
}

/** Lint findings only: five CAS-L on a server that is otherwise sound. */
const POISONED_STDIO = launcher("poisoned-server", "TINY_POISONED");
/** The same, plus a tool whose inputSchema is not valid JSON Schema (CAS-C005). */
const EVIL_STDIO = launcher("evil-server", "TINY_EVIL");
const CLEAN_STDIO = `"${process.execPath}" "${TINY}"`;

/**
 * A server that speaks JSON-RPC and refuses every request, so the handshake
 * fails in both eras within milliseconds. A command that simply does not exist
 * would prove the same thing by burning two 15-second handshake timeouts.
 *
 * String.raw, so the `\n` escapes below reach the generated file as escapes
 * rather than as the literal newlines that would make it unparseable.
 */
const REFUSER = path.join(tmpDir, "refuser.mjs");
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

const codesIn = (out: string) => out.match(/CAS-[A-Z]\d+/g) ?? [];

describe("check --lint-fail-on", () => {
  it("fails a lint-poisoned server at the default gate", () => {
    const run = runCheckCli(["--stdio", POISONED_STDIO]);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("CAS-L001");
  }, 20_000);

  it("reports the same findings and exits 0 at never", () => {
    const gated = runCheckCli(["--stdio", POISONED_STDIO]);
    const waived = runCheckCli(["--lint-fail-on", "never", "--stdio", POISONED_STDIO]);

    // The point of the level: the report is identical, only the verdict moves.
    expect(waived.code).toBe(0);
    expect(codesIn(waived.stdout)).toEqual(codesIn(gated.stdout));
    expect(codesIn(waived.stdout).length).toBeGreaterThan(0);
    expect(waived.stdout).toContain("lint: never");
  }, 20_000);

  it("still fails on a structural error at never, because that is not a lint opinion", () => {
    // The whole boundary of the flag. `broken` declares an inputSchema that is
    // not valid JSON Schema, which is the server being broken rather than the
    // linter having a view about an attacker's prose. A `never` that waived it
    // would turn an input named for the lint into a mute switch for the health
    // check, which is the one thing this must not become.
    const run = runCheckCli(["--lint-fail-on", "never", "--stdio", EVIL_STDIO]);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("CAS-C005");
    // The lint findings next to it are still reported, and still waived.
    expect(run.stdout).toContain("CAS-L001");
  }, 20_000);

  it("still exits 2 at never when the server cannot be inspected at all", () => {
    // `never` waives findings, not the handshake. A server that never answered
    // produced no report to waive, and a silent 0 here would turn the gate into
    // a check that passes hardest when it ran least.
    const run = runCheckCli(["--lint-fail-on", "never", "--stdio", REFUSER_STDIO]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("server answered neither era");
  }, 20_000);

  it("keeps a clean server green at every level", () => {
    for (const level of ["error", "warn", "never"]) {
      expect(runCheckCli(["--lint-fail-on", level, "--stdio", CLEAN_STDIO]).code, level).toBe(0);
    }
  }, 30_000);

  it("writes the findings into SARIF at never, so the report survives the waived gate", () => {
    const run = runCheckCli([
      "--lint-fail-on",
      "never",
      "--format",
      "sarif",
      "--stdio",
      POISONED_STDIO,
    ]);
    expect(run.code).toBe(0);
    const doc = JSON.parse(run.stdout) as { runs: { results: { ruleId: string }[] }[] };
    expect(doc.runs[0]!.results.map((r) => r.ruleId)).toContain("CAS-L001");
  }, 20_000);

  it("follows --fail-on when it is not given, so the stricter gate still covers the lint", () => {
    // `--fail-on warn` gated lint warnings before `--lint-fail-on` existed, and
    // it has to keep doing so: a flag that silently loosened the strict setting
    // would be a regression wearing a feature's clothes.
    const report = JSON.parse(
      runCheckCli(["--fail-on", "warn", "--format", "json", "--stdio", CLEAN_STDIO]).stdout
    ) as { failOn: string; lintFailOn: string };
    expect(report.failOn).toBe("warn");
    expect(report.lintFailOn).toBe("warn");
  }, 20_000);

  it("rejects an unknown level on either flag instead of silently gating on error", () => {
    const lint = runCheckCli(["--lint-fail-on", "none", "--stdio", CLEAN_STDIO]);
    expect(lint.code).toBe(2);
    expect(lint.stderr).toContain("--lint-fail-on must be error, warn or never");

    // `never` is deliberately not a level of the structural gate.
    const structural = runCheckCli(["--fail-on", "never", "--stdio", CLEAN_STDIO]);
    expect(structural.code).toBe(2);
    expect(structural.stderr).toContain("--fail-on must be error or warn");
  }, 20_000);
});

