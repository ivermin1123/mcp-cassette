/**
 * `check` given an operand it does not declare. Commander 12 drops it without a
 * word, so an unquoted `--stdio npx @pkg` runs `npx` alone. The CLI names the
 * extras on one stderr line, with a hint to quote the --stdio command, and
 * changes nothing else: same exit code, same stdout, byte for byte.
 *
 * check already prints probe lines to stderr, so these tests count warning
 * lines rather than diffing the whole stderr.
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
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cassette-extra-check-"));

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A launcher on disk, as in check-cli.test.ts: --stdio takes one command string. */
function launcher(name: string, flag: string): string {
  const file = path.join(tmpDir, `${name}.mjs`);
  fs.writeFileSync(
    file,
    `process.env.${flag} = "1";\nawait import(${JSON.stringify(pathToFileURL(TINY).href)});\n`
  );
  return `"${process.execPath}" "${file}"`;
}

const POISONED_STDIO = launcher("poisoned-server", "TINY_POISONED");
const CLEAN_STDIO = `"${process.execPath}" "${TINY}"`;

/** A server that refuses every request, so check exits 2 within milliseconds. */
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

const warnLines = (stderr: string, cmd: string) =>
  stderr.split("\n").filter((l) => new RegExp(`^${cmd}: .*ignored`).test(l));

describe("check extra positional argument", () => {
  it(
    "names the ignored argument and suggests quoting --stdio, with the same exit code",
    () => {
      const cases: Array<[string, number]> = [
        [CLEAN_STDIO, 0],
        [POISONED_STDIO, 1],
        [REFUSER_STDIO, 2],
      ];
      for (const [fx, expected] of cases) {
        const withExtra = runCheckCli(["--stdio", fx, "extra1"]);
        const without = runCheckCli(["--stdio", fx]);
        expect(withExtra.code).toBe(expected);
        expect(without.code).toBe(expected);
        const warned = warnLines(withExtra.stderr, "check");
        expect(warned).toHaveLength(1);
        expect(warned[0]).toMatch(/^check: .*ignored.*extra1/);
        expect(warned[0]).toContain("quote");
        expect(warnLines(without.stderr, "check")).toHaveLength(0);
      }
    },
    30_000
  );

  it(
    "names every ignored argument in order on one line",
    () => {
      const { code, stderr } = runCheckCli(["--stdio", REFUSER_STDIO, "a", "b"]);
      expect(code).toBe(2);
      const warned = warnLines(stderr, "check");
      expect(warned).toHaveLength(1);
      expect(warned[0]).toMatch(/ignored extra argument\(s\): a b\b/);
    },
    30_000
  );

  it(
    "json and sarif stdout are byte-identical with an extra argument",
    () => {
      for (const extra of [["--format", "json"], ["--format", "sarif"], []]) {
        const withExtra = runCheckCli(["--stdio", CLEAN_STDIO, "extra1", ...extra]);
        const without = runCheckCli(["--stdio", CLEAN_STDIO, ...extra]);
        expect(withExtra.code).toBe(without.code);
        expect(withExtra.stdout).toBe(without.stdout);
      }
    },
    30_000
  );

  it(
    "with --url names the argument without the quoting hint",
    () => {
      const withExtra = runCheckCli(["--url", "http://127.0.0.1:1/mcp", "extra1"]);
      const without = runCheckCli(["--url", "http://127.0.0.1:1/mcp"]);
      expect(withExtra.code).toBe(2);
      expect(without.code).toBe(2);
      const warned = warnLines(withExtra.stderr, "check");
      expect(warned).toHaveLength(1);
      expect(warned[0]).toMatch(/^check: .*ignored.*extra1/);
      expect(warned[0]).not.toContain("quote");
      expect(warned[0]).not.toContain("--stdio");
    },
    30_000
  );

  it(
    "the warning precedes an early usage error",
    () => {
      const { code, stderr } = runCheckCli(["--stdio", REFUSER_STDIO, "x", "--fail-on", "bogus"]);
      expect(code).toBe(2);
      const errLines = stderr.split("\n");
      expect(errLines[0]).toMatch(/^check: .*ignored.*\bx\b/);
      expect(errLines[1]).toMatch(/^check: --fail-on must be error or warn/);
    },
    30_000
  );

  it(
    "operands after -- are reported",
    () => {
      const { code, stderr } = runCheckCli(["--stdio", REFUSER_STDIO, "--", "y"]);
      expect(code).toBe(2);
      const warned = warnLines(stderr, "check");
      expect(warned).toHaveLength(1);
      expect(warned[0]).toMatch(/ignored.*\by\b/);
    },
    30_000
  );

  it(
    "without --stdio or --url there is no quoting hint",
    () => {
      const withExtra = runCheckCli(["npx", "@pkg"]);
      const without = runCheckCli([]);
      expect(withExtra.code).toBe(2);
      expect(without.code).toBe(2);
      const warned = warnLines(withExtra.stderr, "check");
      expect(warned).toHaveLength(1);
      expect(warned[0]).toMatch(/ignored.*npx @pkg/);
      expect(warned[0]).not.toContain("quote");
    },
    30_000
  );
});
