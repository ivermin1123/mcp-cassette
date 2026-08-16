/**
 * The package version is declared once, in package.json. Anything that reports a
 * version, whether the CLI, the cassette header or the client handshake, has to derive
 * it from there, or a bump to the manifest alone leaves recordings stamped with
 * a recorder that never wrote them.
 *
 * These assertions fail against a hardcoded literal the moment the manifest
 * moves, which is the point.
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CassetteWriter, readCassette } from "../src/cassette.js";
import { RECORDER, VERSION } from "../src/version.js";

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "dist/cli.js");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  name: string;
  version: string;
};
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cassette-version-"));

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("version provenance", () => {
  it("exports the manifest's version", () => {
    expect(VERSION).toBe(pkg.version);
    expect(RECORDER).toBe(`${pkg.name}@${pkg.version}`);
  });

  it("reports the manifest's version from the built CLI", () => {
    const reported = execFileSync("node", [CLI, "--version"], { encoding: "utf8" }).trim();
    expect(reported).toBe(pkg.version);
  });

  it("stamps the manifest's version into the cassette header", async () => {
    const file = path.join(tmpDir, "stamp.cassette.jsonl");
    const writer = new CassetteWriter(file, ["some-server"]);
    await writer.close();

    const { header } = readCassette(file);
    expect(header.recorder).toBe(`${pkg.name}@${pkg.version}`);
    expect(header.recorder).toContain(pkg.version);
  });
});
