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

/**
 * The site's runnable commands pin the tool version, so a reader whose npx
 * cache holds an older build cannot be served it silently. A pin is a copy of
 * the version, and a copy rots: this fails the release that bumps the manifest
 * and leaves the page telling people to run what shipped before it.
 *
 * Scoped to HTML on purpose. The markdown under docs/ carries pins of its own
 * that are correct *because* they are old: they record what a past format or
 * design document was written against, and freezing them to the current
 * version would falsify history.
 */
describe("the site pins the version it ships", () => {
  const DOCS = path.join(ROOT, "docs");
  // All three components required, so an action-style ref (@v0.4) is not a pin.
  const PIN = /mcp-cassette@\d+\.\d+\.\d+/g;
  const pages = fs
    .readdirSync(DOCS, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".html"));
  const pins = pages.flatMap((page) =>
    (fs.readFileSync(path.join(DOCS, page), "utf8").match(PIN) ?? []).map((pin) => `${page}: ${pin}`)
  );

  it("names the current version wherever a page pins one", () => {
    const stale = pins.filter((pin) => !pin.endsWith(`mcp-cassette@${pkg.version}`));
    expect(stale, `a page pins a version other than ${pkg.version}`).toEqual([]);
  });

  it("is checking something, so a renamed page cannot make it vacuous", () => {
    expect(pins.length).toBeGreaterThan(0);
  });
});
