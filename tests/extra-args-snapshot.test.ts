/**
 * `snapshot` given an operand it does not declare. Commander 12 drops it
 * without a word; the CLI names it on one stderr line, with a hint to quote the
 * --stdio command, and changes nothing else: same exit code, same stdout, and
 * a byte-identical snapshot file.
 *
 * A written snapshot carries `capturedAt: new Date()`, so the CLI runs under a
 * preload that pins argument-less `new Date()` to a fixed instant. Date.now and
 * timers stay real, and the server child is not preloaded.
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
const STORED = path.join(ROOT, "tests/fixtures/tiny-server.snapshot.json");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cassette-extra-snapshot-"));

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const V2_LAUNCHER = path.join(tmpDir, "v2-server.mjs");
fs.writeFileSync(
  V2_LAUNCHER,
  `process.env.TINY_V2 = "1";\nawait import(${JSON.stringify(pathToFileURL(TINY).href)});\n`
);
const V2_STDIO = `"${process.execPath}" "${V2_LAUNCHER}"`;

const FREEZE = path.join(tmpDir, "freeze-date.cjs");
fs.writeFileSync(
  FREEZE,
  `const RealDate = Date;
const FIXED = RealDate.parse("2026-01-01T00:00:00.000Z");
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); }
};
`
);

function runSnapshot(args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--require", FREEZE, CLI, "snapshot", ...args], {
    encoding: "utf8",
  });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

const warnLines = (stderr: string, cmd: string) =>
  stderr.split("\n").filter((l) => new RegExp(`^${cmd}: .*ignored`).test(l));

describe("snapshot extra positional argument", () => {
  it(
    "names the ignored argument and suggests quoting --stdio, with the same exit code",
    () => {
      const base = ["--check", "-f", STORED, "--stdio", V2_STDIO];
      const withExtra = runSnapshot([...base, "extra"]);
      const without = runSnapshot(base);
      expect(withExtra.code).toBe(without.code);
      expect(withExtra.stdout).toBe(without.stdout);
      const warned = warnLines(withExtra.stderr, "snapshot");
      expect(warned).toHaveLength(1);
      expect(warned[0]).toMatch(/^snapshot: .*ignored.*extra/);
      expect(warned[0]).toContain("quote");
      expect(warnLines(without.stderr, "snapshot")).toHaveLength(0);
    },
    30_000
  );

  it(
    "write mode: same stdout and a byte-identical file",
    () => {
      const file = path.join(tmpDir, "s.json");
      const run1 = runSnapshot(["--stdio", V2_STDIO, "-f", file, "--update"]);
      const b1 = fs.readFileSync(file);
      const run2 = runSnapshot(["--stdio", V2_STDIO, "-f", file, "--update", "extra"]);
      const b2 = fs.readFileSync(file);
      expect(run1.code).toBe(0);
      expect(run2.code).toBe(0);
      expect(run2.stdout).toBe(run1.stdout);
      expect(b1.equals(b2)).toBe(true);
      const warned = warnLines(run2.stderr, "snapshot");
      expect(warned).toHaveLength(1);
      expect(warned[0]).toMatch(/ignored.*\bextra\b/);
      expect(warned[0]).toContain("quote");
    },
    30_000
  );

  it(
    "the warning reaches the pipe before an early exit",
    () => {
      const base = ["--check", "-f", path.join(tmpDir, "absent.json"), "--stdio", V2_STDIO];
      const withExtra = runSnapshot([...base, "extra"]);
      const without = runSnapshot(base);
      expect(withExtra.code).toBe(2);
      expect(without.code).toBe(2);
      const errLines = withExtra.stderr.split("\n");
      const warnAt = errLines.findIndex((l) => /^snapshot: .*ignored.*\bextra\b/.test(l));
      const missingAt = errLines.findIndex((l) => l.startsWith("snapshot --check: no snapshot at"));
      expect(warnAt).toBeGreaterThanOrEqual(0);
      expect(missingAt).toBeGreaterThan(warnAt);
    },
    30_000
  );
});
