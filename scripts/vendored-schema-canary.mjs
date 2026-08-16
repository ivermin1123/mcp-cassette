#!/usr/bin/env node
/**
 * Has a vendored schema drifted from upstream?
 *
 * The schemas under schemas/ are byte-identical copies, kept locally so the
 * test suite never touches the network — an offline CI is the thing this
 * project sells, and a fetch in a test turns someone else's outage into our red
 * build.
 *
 * The cost of a copy is that it goes stale silently. This is the counterweight:
 * a weekly fetch that compares hashes and *says so*. It never fails the build.
 * A schema moving upstream is news to read, not a reason to break every branch
 * until someone runs an update — the same shape as the conformance canary.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const dir = path.join(root, "schemas");
const { schemas } = JSON.parse(fs.readFileSync(path.join(dir, "vendored.json"), "utf8"));

let drifted = 0;
let unreachable = 0;

for (const entry of schemas) {
  const local = fs.readFileSync(path.join(dir, entry.file));
  const localHash = createHash("sha256").update(local).digest("hex");

  if (localHash !== entry.sha256) {
    // The copy was edited. That breaks the comparison itself, so it is louder
    // than drift: nothing downstream can be trusted to mean what it says.
    console.log(`::error::${entry.file} does not match the sha256 recorded in vendored.json — the vendored copy was modified`);
    drifted++;
    continue;
  }

  let upstream;
  try {
    const response = await fetch(entry.source);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    upstream = Buffer.from(await response.arrayBuffer());
  } catch (err) {
    console.log(`::warning::could not fetch ${entry.source}: ${err?.message ?? err}`);
    unreachable++;
    continue;
  }

  const upstreamHash = createHash("sha256").update(upstream).digest("hex");
  if (upstreamHash === localHash) {
    console.log(`${entry.file}: up to date (${localHash.slice(0, 12)}…)`);
    continue;
  }

  drifted++;
  console.log(
    `::warning::${entry.file} has drifted from upstream — vendored ${localHash.slice(0, 12)}…, upstream ${upstreamHash.slice(0, 12)}…. ` +
      `Re-download from ${entry.source}, update schemas/vendored.json, and check whether our output still validates.`
  );
}

console.log(`\n${schemas.length} vendored schema(s), ${drifted} drifted, ${unreachable} unreachable`);
// Always green on purpose: see the header.
