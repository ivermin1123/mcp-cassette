/**
 * End-to-end for the `snapshot --check` gate: the built CLI, a real child
 * process, and the exit codes CI (and the GitHub Action) depend on.
 *
 * Kept out of e2e.test.ts on purpose: the gate's contract is exit codes and
 * JSON shape, and those deserve to fail on their own line.
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { captureContract, type ContractSnapshot } from "../src/snapshot.js";

const ROOT = path.resolve(__dirname, "..");
const TINY = path.join(ROOT, "tests/fixtures/tiny-server.mjs");
const CLI = path.join(ROOT, "dist/cli.js");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cassette-snapshot-"));

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * A launcher for the v2 fixture on disk. `--stdio` takes a single command
 * string that the CLI tokenizes with quote handling but no backslash escapes,
 * so an inline `node -e "..."` program would not survive the round trip.
 */
const V2_LAUNCHER = path.join(tmpDir, "v2-server.mjs");
fs.writeFileSync(
  V2_LAUNCHER,
  `process.env.TINY_V2 = "1";\nawait import(${JSON.stringify(pathToFileURL(TINY).href)});\n`
);
const V2_STDIO = `"${process.execPath}" "${V2_LAUNCHER}"`;
const V2_TARGET = { kind: "stdio" as const, command: [process.execPath, V2_LAUNCHER] };

function runSnapshot(args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, "snapshot", ...args], { encoding: "utf8" });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/**
 * A stored snapshot that differs from the live v2 server by exactly one
 * dangerous change: the optional `mode` parameter is absent, so the live
 * server has added it.
 */
async function storedWithoutMode(file: string): Promise<void> {
  const live = await captureContract(V2_TARGET);
  const stored: ContractSnapshot = {
    ...live,
    tools: live.tools.map((tool) => {
      if (tool.name !== "add") return tool;
      const schema = JSON.parse(JSON.stringify(tool.inputSchema)) as {
        properties: Record<string, unknown>;
      };
      delete schema.properties.mode;
      return { ...tool, inputSchema: schema };
    }),
  };
  fs.writeFileSync(file, JSON.stringify(stored, null, 2) + "\n");
}

describe("snapshot --check --fail-on", () => {
  it("passes a dangerous-only diff at the default threshold and fails at --fail-on dangerous", async () => {
    const file = path.join(tmpDir, "dangerous.snapshot.json");
    await storedWithoutMode(file);

    const lenient = runSnapshot(["--check", "-f", file, "--stdio", V2_STDIO]);
    expect(lenient.code).toBe(0);
    expect(lenient.stdout).toContain("[DANGEROUS] add:");
    expect(lenient.stdout).toContain("input-property-added-optional");
    expect(lenient.stdout).toContain("result: PASS");

    const strict = runSnapshot(["--check", "-f", file, "--stdio", V2_STDIO, "--fail-on", "dangerous"]);
    expect(strict.code).toBe(1);
    expect(strict.stdout).toContain("result: FAIL");
    expect(strict.stdout).toContain("gate: dangerous");
  }, 30_000);

  it("emits a machine-readable diff with --json", async () => {
    const file = path.join(tmpDir, "json.snapshot.json");
    await storedWithoutMode(file);

    const run = runSnapshot(["--check", "-f", file, "--stdio", V2_STDIO, "--json"]);
    expect(run.code).toBe(0);
    const report = JSON.parse(run.stdout);
    expect(report).toMatchObject({
      ok: true,
      failOn: "breaking",
      counts: { breaking: 0, dangerous: 1, minor: 0, info: 0 },
    });
    expect(report.changes).toEqual([
      {
        kind: "dangerous",
        rule: "input-property-added-optional",
        subject: "add",
        message: 'parameter "mode" added',
      },
    ]);
  }, 30_000);

  it("still exits 1 on a breaking diff at the default threshold", async () => {
    const file = path.join(tmpDir, "breaking.snapshot.json");
    const v1 = await captureContract({ kind: "stdio", command: [process.execPath, TINY] });
    fs.writeFileSync(file, JSON.stringify(v1, null, 2) + "\n");

    const run = runSnapshot(["--check", "-f", file, "--stdio", V2_STDIO]);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("[BREAKING] slugify: tool removed (tool-removed)");
  }, 30_000);

  it("rejects an unknown --fail-on tier instead of silently gating on breaking", async () => {
    const file = path.join(tmpDir, "unused.snapshot.json");
    const run = runSnapshot(["--check", "-f", file, "--stdio", V2_STDIO, "--fail-on", "cosmetic"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('--fail-on must be "breaking" or "dangerous"');
  }, 30_000);
});
