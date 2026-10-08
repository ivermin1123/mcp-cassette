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
const DOCS = path.join(ROOT, "docs");
const pages = fs
  .readdirSync(DOCS, { recursive: true, encoding: "utf8" })
  .filter((entry) => entry.endsWith(".html"));

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
  // All three components required, so an action-style ref (@v0.4) is not a pin.
  const PIN = /mcp-cassette@\d+\.\d+\.\d+/g;
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

/**
 * The action's `version` input default is the CLI a consumer runs when they
 * pass nothing, so it is a pin like the site's, and it rotted twice: it said
 * 0.1.2 through 0.2.0 and 0.3.0 through 0.4.0, which put `@v0.4` on the very
 * release 0.4.0 was cut to correct. Nothing failed, because the action works
 * with any version; it just ran the wrong one.
 */
describe("the action runs the version it ships", () => {
  const SYNC = path.join(ROOT, "scripts/sync-version-pins.mjs");
  const actionDefault = (yaml: string) => /^ {2}version:\n(?: {4,}.*\n)*? {4}default: (.*)$/m.exec(yaml)?.[1];

  it("defaults the `version` input to the manifest's version", () => {
    const yaml = fs.readFileSync(path.join(ROOT, "action.yml"), "utf8");
    expect(actionDefault(yaml), "action.yml's `version` default").toBe(pkg.version);
  });

  it("is repaired by the sync script, which rewrites every pin and only pins", () => {
    const root = fs.mkdtempSync(path.join(tmpDir, "sync-"));
    fs.mkdirSync(path.join(root, "docs/nested"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "10.20.30" }));
    fs.copyFileSync(path.join(ROOT, "action.yml"), path.join(root, "action.yml"));
    fs.writeFileSync(
      path.join(root, "docs/nested/page.html"),
      "<code>npx mcp-cassette@0.1.2 check</code> <code>uses: ivermin1123/mcp-cassette@v0.4</code>"
    );

    execFileSync("node", [SYNC, root], { encoding: "utf8" });

    const yaml = fs.readFileSync(path.join(root, "action.yml"), "utf8");
    expect(actionDefault(yaml)).toBe("10.20.30");
    const original = fs.readFileSync(path.join(ROOT, "action.yml"), "utf8");
    expect(yaml.split("\n").filter((line, i) => line !== original.split("\n")[i])).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, "docs/nested/page.html"), "utf8")).toBe(
      "<code>npx mcp-cassette@10.20.30 check</code> <code>uses: ivermin1123/mcp-cassette@v0.4</code>"
    );
  });
});

/**
 * An attribute value that is never closed does not break the page loudly. The
 * parser reads on to the next quote, which lands somewhere in the stylesheet,
 * and everything in between, the <style> tag included, becomes part of the
 * attribute. The page still parses, still serves, still contains every word a
 * content assertion looks for, and arrives with no styles at all. This walks
 * the document as a parser does and refuses a <style> tag found inside a
 * quoted value.
 */
describe("no page loses its stylesheet inside an attribute", () => {
  const swallowedStyleTags = (html: string) => {
    let inTag = false;
    let quote = "";
    let hits = 0;
    for (let i = 0; i < html.length; i++) {
      const c = html[i];
      if (quote) {
        if (c === quote) quote = "";
        else if (html.startsWith("<style", i)) hits++;
      } else if (inTag) {
        if (c === '"' || c === "'") quote = c;
        else if (c === ">") inTag = false;
      } else if (c === "<") inTag = true;
    }
    return hits;
  };

  it.each(pages)("closes every attribute before the <style> tag in %s", (page) => {
    const html = fs.readFileSync(path.join(DOCS, page), "utf8");
    expect(swallowedStyleTags(html), "an unclosed attribute swallowed the stylesheet").toBe(0);
  });
});
