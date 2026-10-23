/**
 * `lint` given more operands than the one cassette it declares. Commander 12
 * drops the extras without a word; the CLI names them on one stderr line and
 * changes nothing else: same exit code, same stdout, byte for byte.
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "dist/cli.js");
const GOLDEN = path.join(ROOT, "tests/fixtures/tiny-server.golden.cassette.jsonl");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cassette-extra-lint-"));

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runLint(args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, "lint", ...args], { encoding: "utf8" });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** stderr as lines, without the empty element after the final newline. */
function lines(text: string): string[] {
  const out = text.split("\n");
  if (out[out.length - 1] === "") out.pop();
  return out;
}

describe("lint <cassette>", () => {
  it("warns on stderr about an ignored second cassette path and changes nothing else", () => {
    const missing = path.join(tmpDir, "missing.cassette.jsonl");
    const { code, stdout, stderr } = runLint([GOLDEN, missing]);
    expect(code).toBe(0);
    expect(stdout).toBe(`${GOLDEN}: header and frames agree\n`);
    const errLines = lines(stderr);
    expect(errLines).toHaveLength(1);
    expect(errLines[0]).toMatch(/^lint: .*ignored.*missing\.cassette\.jsonl/);
  });

  it("--json stdout is byte-identical with an extra path", () => {
    const withExtra = runLint([GOLDEN, "b", "--json"]);
    const without = runLint([GOLDEN, "--json"]);
    expect(withExtra.stdout).toBe(without.stdout);
    expect(withExtra.code).toBe(without.code);
    const errLines = lines(withExtra.stderr);
    expect(errLines).toHaveLength(1);
    expect(errLines[0]).toMatch(/^lint: .*ignored.*\bb\b/);
  });

  it("a missing first path still exits 1 with the same error, plus the warning", () => {
    const nope = path.join(tmpDir, "nope.cassette.jsonl");
    const withExtra = runLint([nope, "b"]);
    const without = runLint([nope]);
    expect(withExtra.code).toBe(1);
    expect(without.code).toBe(1);
    expect(withExtra.stdout).toBe(without.stdout);
    const nl = withExtra.stderr.indexOf("\n");
    expect(withExtra.stderr.slice(0, nl)).toMatch(/^lint: .*ignored.*\bb\b/);
    expect(withExtra.stderr.slice(nl + 1)).toBe(without.stderr);
  });

  it("names every extra path in order", () => {
    const { code, stderr } = runLint([GOLDEN, "a", "b", "c"]);
    expect(code).toBe(0);
    const errLines = lines(stderr);
    expect(errLines).toHaveLength(1);
    expect(errLines[0]).toMatch(/^lint: .*ignored.*\ba b c\b/);
  });

  it("prints nothing new without an extra path", () => {
    expect(runLint([GOLDEN]).stderr).toBe("");
  });
});
