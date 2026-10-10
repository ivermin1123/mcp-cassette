/**
 * `mcp-cassette lint` end to end: the built CLI, a real child process, and the
 * exit code CI depends on.
 *
 * The contract under test is narrow and worth its own file. `lint` fails on a
 * header that contradicts its own frames, and on nothing else. A recording
 * whose answers carry an injection is reported and stays green, because
 * returned text is data and gating on it would turn a passing pipeline red for
 * a server somebody else wrote.
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "dist/cli.js");
const GOLDEN = path.join(ROOT, "tests/fixtures/tiny-server.golden.cassette.jsonl");
const POISONED = path.join(ROOT, "tests/fixtures/poisoned-output.cassette.jsonl");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cassette-lint-"));

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runLint(args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, "lint", ...args], { encoding: "utf8" });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** The golden cassette with one header field appended, written to a temp file. */
function withHeaderField(name: string, patch: Record<string, unknown>): string {
  const lines = fs.readFileSync(GOLDEN, "utf8").split("\n");
  lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), ...patch });
  const file = path.join(tmpDir, `${name}.cassette.jsonl`);
  fs.writeFileSync(file, lines.join("\n"));
  return file;
}

describe("lint <cassette>", () => {
  it("prints what it always printed for a cassette with nothing to report", () => {
    const run = runLint([GOLDEN]);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe(`${GOLDEN}: header and frames agree\n`);
  });

  it("reports injection in recorded output and still exits 0", () => {
    const run = runLint([POISONED]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("[WARN] CAS-L001 tools/call #3 /result/content/0/text");
    expect(run.stdout).toContain("[WARN] CAS-L006 resources/read #4 /result/contents/0/text");
    expect(run.stdout).toContain("header and frames agree");
    expect(run.stdout).toContain("warning(s) (reported, not gated)");
  });

  it("reports a malformed header field at warn without changing the exit code", () => {
    const file = withHeaderField("bad-volatile", { volatile: ["not-a-pointer"] });
    const run = runLint([file]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("[WARN] volatile-declaration: header `volatile`[0]");
    expect(run.stdout).toContain("header and frames agree");
  });

  it("still exits 1 on a header that contradicts its own frames", () => {
    const file = withHeaderField("contradiction", { url: "http://127.0.0.1:3000/mcp" });
    const run = runLint([file]);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("transport-url: transport is \"stdio\"");
    expect(run.stdout).toContain("1 inconsistency(ies)");
  });

  it("emits machine-readable findings with --json", () => {
    const run = runLint([POISONED, "--json"]);
    expect(run.code).toBe(0);
    const report = JSON.parse(run.stdout);
    expect(report).toMatchObject({ cassette: POISONED, ok: true, header: [] });
    expect(report.output).toEqual([
      {
        rule: "CAS-L001",
        severity: "warn",
        requestId: 3,
        method: "tools/call",
        path: "/result/content/0/text",
        message: "instruction-override phrasing (classic prompt-injection) (in recorded output)",
        excerpt: expect.stringContaining("Ignore all previous instructions"),
      },
      {
        rule: "CAS-L006",
        severity: "warn",
        requestId: 4,
        method: "resources/read",
        path: "/result/contents/0/text",
        message: "invisible/steganographic Unicode (in recorded output)",
        excerpt: expect.any(String),
      },
    ]);
  });
});
