#!/usr/bin/env node
/**
 * Copy package.json's version into every place that pins it.
 *
 * The version is declared once, in package.json, but two things ship a copy:
 * the action's `version` input default, which is the CLI a consumer runs when
 * they pass nothing, and the site's runnable commands. A copy rots. The action
 * default stayed at 0.1.2 through 0.2.0, then at 0.3.0 through 0.4.0, so
 * `uses: ivermin1123/mcp-cassette@v0.4` ran the release whose own successor
 * called it wrong. tests/version.test.ts fails when a copy drifts; this is the
 * other half, so the bump that makes the test fail also makes it pass.
 *
 * `npm version` runs it through the `version` lifecycle script before it
 * commits. After bumping package.json by hand, run `npm run sync-version`.
 *
 * Usage: node scripts/sync-version-pins.mjs [root]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`sync-version-pins: refusing to pin a non-release version: ${version}`);
  process.exit(1);
}

const changed = [];

function rewrite(rel, transform) {
  const file = path.join(root, rel);
  const before = fs.readFileSync(file, "utf8");
  const after = transform(before);
  if (after !== before) {
    fs.writeFileSync(file, after);
    changed.push(rel);
  }
}

// The `default:` that belongs to the `version` input, and no other. The block
// ends at the next line indented two spaces (the next input), so a `default:`
// further down the file is never reached.
rewrite("action.yml", (text) => {
  const block = /^( {2}version:\n(?: {4,}.*\n)*? {4}default: ).*$/m;
  if (!block.test(text)) {
    console.error("sync-version-pins: action.yml has no `version` input with a default");
    process.exit(1);
  }
  // A function, not "$1" + version: "$1" followed by "0.5.0" reads as "$10".
  return text.replace(block, (_, head) => head + version);
});

// The same pin shape tests/version.test.ts checks: all three components, so an
// action-style ref (@v0.4) is never rewritten.
const docs = path.join(root, "docs");
for (const page of fs.readdirSync(docs, { recursive: true, encoding: "utf8" })) {
  if (!page.endsWith(".html")) continue;
  rewrite(path.join("docs", page), (text) => text.replace(/mcp-cassette@\d+\.\d+\.\d+/g, `mcp-cassette@${version}`));
}

console.log(
  changed.length ? `pinned ${version} in: ${changed.join(", ")}` : `every pin already names ${version}`
);
