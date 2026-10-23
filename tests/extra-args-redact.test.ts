/**
 * `redact` given more operands than the one cassette it declares. The extras
 * are named on one stderr line and never opened; the first path is processed
 * exactly as before, with the same exit code, stdout and written file.
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "dist/cli.js");
const GOLDEN = path.join(ROOT, "tests/fixtures/tiny-server.golden.cassette.jsonl");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cassette-extra-redact-"));
const A = path.join(tmpDir, "a.cassette.jsonl");
fs.copyFileSync(GOLDEN, A);
const CFG = path.join(tmpDir, "cfg.json");
fs.writeFileSync(CFG, JSON.stringify({ patterns: [] }));

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runRedact(args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, "redact", ...args], { encoding: "utf8" });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** stderr as lines, without the empty element after the final newline. */
function lines(text: string): string[] {
  const out = text.split("\n");
  if (out[out.length - 1] === "") out.pop();
  return out;
}

describe("redact extra positional argument", () => {
  it("names the ignored cassette path and writes the same output", () => {
    const b = path.join(tmpDir, "b.cassette.jsonl");
    const out1 = path.join(tmpDir, "out1.cassette.jsonl");
    const out2 = path.join(tmpDir, "out2.cassette.jsonl");
    const withExtra = runRedact([A, b, "-o", out1]);
    const without = runRedact([A, "-o", out2]);
    expect(withExtra.code).toBe(0);
    expect(without.code).toBe(0);
    expect(fs.readFileSync(out1).equals(fs.readFileSync(out2))).toBe(true);
    expect(withExtra.stdout.replaceAll(out1, "OUT")).toBe(without.stdout.replaceAll(out2, "OUT"));
    expect(without.stderr).toBe("");
    const errLines = lines(withExtra.stderr);
    expect(errLines).toHaveLength(1);
    expect(errLines[0]).toMatch(/^redact: .*ignored.*b\.cassette\.jsonl/);
    expect(fs.existsSync(b)).toBe(false);
  });

  it("--scan output and exit code are unchanged", () => {
    const withExtra = runRedact([A, "b", "--scan"]);
    const without = runRedact([A, "--scan"]);
    expect(withExtra.stdout).toBe(without.stdout);
    expect(withExtra.code).toBe(without.code);
    const errLines = lines(withExtra.stderr);
    expect(errLines).toHaveLength(1);
    expect(errLines[0]).toMatch(/^redact: .*ignored.*\bb\b/);
  });

  it("--check-config usage gate keeps exit 2 and its message, plus the warning naming b", () => {
    const withExtra = runRedact(["--check-config", "--redact-config", CFG, A, "b"]);
    const without = runRedact(["--check-config", "--redact-config", CFG, A]);
    expect(withExtra.code).toBe(2);
    expect(without.code).toBe(2);
    expect(without.stderr).toMatch(/^redact: --check-config reads the config and writes nothing/);
    const nl = withExtra.stderr.indexOf("\n");
    const warning = withExtra.stderr.slice(0, nl);
    expect(warning).toMatch(/^redact: .*ignored.*\bb\b/);
    expect(warning).not.toContain(A);
    expect(withExtra.stderr.slice(nl + 1)).toBe(without.stderr);
  });

  it("prints nothing new without an extra path", () => {
    const out3 = path.join(tmpDir, "out3.cassette.jsonl");
    expect(runRedact([A, "-o", out3]).stderr).not.toContain("ignored");
    expect(runRedact([A, "--scan"]).stderr).not.toContain("ignored");
  });
});
