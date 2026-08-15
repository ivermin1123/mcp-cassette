/**
 * Property: the cassette codec is lossless framing over JSON.
 *
 * The example tests pin the shapes we expect to record. This one asks the
 * harder question — is there *any* JSON a real server could emit that the
 * JSONL framing mangles? The interesting adversaries are values that carry the
 * delimiter: a raw log line holding a newline, a tool argument holding one, a
 * string that is itself a serialized cassette.
 *
 * The property is about framing, not about JSON: values JSON itself does not
 * preserve (`-0`, a lone surrogate) are normalized through one JSON round trip
 * before the comparison, so a failure here means the cassette layer lost
 * something, never that JSON did.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCassette, writeCassette, CASSETTE_VERSION, type Cassette } from "../../src/cassette.js";

const direction = fc.constantFrom("c2s" as const, "s2c" as const);

const frameEntry = fc.record({
  type: fc.constant("frame" as const),
  t: fc.nat({ max: 10_000_000 }),
  dir: direction,
  frame: fc.record({
    jsonrpc: fc.constant("2.0" as const),
    id: fc.oneof(fc.integer(), fc.string()),
    method: fc.string(),
    params: fc.jsonValue(),
  }),
});

const rawEntry = fc.record({
  type: fc.constant("raw" as const),
  t: fc.nat({ max: 10_000_000 }),
  dir: direction,
  // Newlines, tabs and quotes are the whole point: a raw entry is whatever the
  // server wrote to stdout, and the JSONL framing has to survive it.
  data: fc.string({ unit: fc.constantFrom("a", "\n", "\r", "\t", '"', "\\", "{", "}", "ü", "🎞") }),
});

const cassette = fc
  .record({
    header: fc.record({
      type: fc.constant("header" as const),
      cassetteVersion: fc.constant(CASSETTE_VERSION),
      recorder: fc.string(),
      startedAt: fc.string(),
      transport: fc.constant("stdio" as const),
      command: fc.option(fc.array(fc.string(), { maxLength: 4 }), { nil: undefined }),
      redaction: fc.record({ applied: fc.boolean() }),
    }),
    entries: fc.array(fc.oneof(frameEntry, rawEntry), { maxLength: 12 }),
  })
  .map((value) => JSON.parse(JSON.stringify(value)) as Cassette);

describe("cassette codec", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cassette-prop-"));

  it("round-trips any JSON payload through the JSONL framing", () => {
    let n = 0;
    try {
      fc.assert(
        fc.property(cassette, (original) => {
          const file = path.join(tmpDir, `roundtrip-${n++}.cassette.jsonl`);
          writeCassette(file, original);
          expect(readCassette(file)).toEqual(original);
        })
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("writes exactly one line per entry, whatever the entries contain", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cassette-prop-lines-"));
    let n = 0;
    try {
      fc.assert(
        fc.property(cassette, (original) => {
          const file = path.join(dir, `lines-${n++}.cassette.jsonl`);
          writeCassette(file, original);
          const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l !== "");
          expect(lines).toHaveLength(original.entries.length + 1);
        })
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
