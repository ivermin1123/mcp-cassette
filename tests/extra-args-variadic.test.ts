/**
 * `record`, `replay` and `verify` end in a variadic server command, which
 * absorbs every trailing operand. The ignored-operand warning given to the
 * fixed-arity commands must never appear here.
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "dist/cli.js");
const GOLDEN = path.join(ROOT, "tests/fixtures/tiny-server.golden.cassette.jsonl");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cassette-extra-variadic-"));

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Answers every request with a JSON-RPC error, so verify fails fast. */
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

function run(args: string[], input?: string): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    timeout: 25_000,
    ...(input !== undefined ? { input } : {}),
  });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

const WARNING = /^(record|replay|verify): ignored/m;

describe("variadic commands are unchanged", () => {
  it("replay absorbs trailing words into its server command", () => {
    const { stderr } = run(["replay", GOLDEN, "--", "node", "server.js", "--flag"], "");
    expect(stderr).not.toMatch(WARNING);
  }, 30_000);

  it("verify absorbs trailing words into its server command", () => {
    const { stderr } = run(["verify", GOLDEN, "--", process.execPath, REFUSER, "extra"]);
    expect(stderr).not.toMatch(WARNING);
  }, 30_000);

  it("record absorbs trailing words into its server command", () => {
    const out = path.join(tmpDir, "r.cassette.jsonl");
    const { stderr } = run(["record", "-o", out, "--", process.execPath, "-e", "process.exit(0)", "extra"], "");
    expect(stderr).not.toMatch(WARNING);
  }, 30_000);
});
