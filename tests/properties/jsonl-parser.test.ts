/**
 * Fuzzing the line/frame parsers.
 *
 * These sit on the hot path of the record proxy, where the input is whatever a
 * third-party server wrote to stdout: a half-flushed line, a BOM from a
 * Windows toolchain, a megabyte of base64, a log message that is nearly JSON.
 * An uncaught throw there does not surface as a bad parse — it kills the proxy
 * mid-session and takes the recording with it.
 *
 * So the contract under fuzz is narrow and absolute: never throw, and never
 * lose a byte. A malformed line is data to be preserved as a raw entry, not an
 * error to be raised.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LineBuffer, parseFrame, serializeFrame, stableStringify } from "../../src/jsonrpc.js";
import { readCassette } from "../../src/cassette.js";
import { redactRawLine, scanRawLine } from "../../src/redact.js";

/** Bytes chosen to break a parser: delimiters, a BOM, escapes, wide glyphs. */
const hostileChar = fc.constantFrom(
  "{",
  "}",
  "[",
  "]",
  '"',
  "\\",
  ":",
  ",",
  "\n",
  "\r",
  "\t",
  " ",
  "\u0000", // a NUL byte a server logged
  "\uFEFF",
  "\uD800", // lone surrogate
  "0",
  "e",
  "ü",
  "🎞"
);

const hostileLine = fc.string({ unit: hostileChar, maxLength: 120 });

/** A valid frame, then cut somewhere — the half-flushed-write case. */
const truncatedFrame = fc
  .tuple(
    fc.record({ jsonrpc: fc.constant("2.0" as const), id: fc.integer(), method: fc.string() }),
    fc.nat({ max: 60 })
  )
  .map(([frame, cut]) => JSON.stringify(frame).slice(0, cut));

const anyLine = fc.oneof(
  hostileLine,
  truncatedFrame,
  fc.string(),
  fc.constant("\uFEFF" + '{"jsonrpc":"2.0","id":1,"method":"ping"}'),
  // A single enormous line: the recorder must not treat size as structure.
  fc.constant("x".repeat(500_000)),
  fc.constant('{"jsonrpc":"2.0","id":1,"params":{"blob":"' + "A".repeat(200_000) + '"}}')
);

describe("parseFrame", () => {
  it("never throws, and returns either null or a jsonrpc 2.0 object", () => {
    fc.assert(
      fc.property(anyLine, (line) => {
        const frame = parseFrame(line);
        if (frame !== null) expect((frame as { jsonrpc: string }).jsonrpc).toBe("2.0");
      }),
      { numRuns: 50 }
    );
  });

  it("still parses a frame behind a byte-order mark", () => {
    // `JSON.parse` rejects a BOM, but `trim()` counts U+FEFF as whitespace, so
    // the leading mark a Windows toolchain emits is gone before the parse. A
    // server on that toolchain records as frames rather than as raw lines —
    // worth pinning, because it is a property of `trim`, not of this file.
    expect(parseFrame('\uFEFF{"jsonrpc":"2.0","id":1,"method":"ping"}')).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
    });
    // A mark in the middle is part of the payload and still breaks the parse,
    // which must come back as null rather than as a throw.
    expect(parseFrame('{"jsonrpc"\uFEFF:"2.0"}')).toBeNull();
  });

  it("round-trips any frame it accepts", () => {
    fc.assert(
      fc.property(
        fc.record({
          jsonrpc: fc.constant("2.0" as const),
          id: fc.oneof(fc.integer(), fc.string()),
          method: fc.string(),
          params: fc.jsonValue(),
        }),
        (frame) => {
          const parsed = parseFrame(serializeFrame(frame as never));
          expect(stableStringify(parsed)).toBe(stableStringify(JSON.parse(JSON.stringify(frame))));
        }
      )
    );
  });
});

describe("LineBuffer", () => {
  it("emits the same lines however the stream is chunked", () => {
    fc.assert(
      fc.property(
        fc.array(hostileLine.map((l) => l.replace(/\n/g, "")), { maxLength: 8 }),
        fc.array(fc.nat({ max: 40 }), { maxLength: 10 }),
        (lines, cuts) => {
          const stream = lines.map((l) => l + "\n").join("");

          const whole = new LineBuffer();
          const expected = whole.feed(stream);

          // Same bytes, arbitrary chunk boundaries.
          const chunked = new LineBuffer();
          const seen: string[] = [];
          let at = 0;
          for (const cut of [...cuts, stream.length]) {
            const next = Math.min(at + cut, stream.length);
            seen.push(...chunked.feed(stream.slice(at, next)));
            at = next;
          }
          seen.push(...chunked.feed(stream.slice(at)));

          expect(seen).toEqual(expected);
          expect(chunked.flush()).toBe("");
        }
      )
    );
  });

  it("holds a line with no trailing newline until flush, losing nothing", () => {
    fc.assert(
      fc.property(hostileLine.map((l) => l.replace(/[\r\n]/g, "")), (partial) => {
        const buffer = new LineBuffer();
        expect(buffer.feed(partial)).toEqual([]);
        expect(buffer.flush()).toBe(partial);
        expect(buffer.flush()).toBe("");
      })
    );
  });
});

describe("raw-line redaction under fuzz", () => {
  it("never throws on a line that is not a frame", () => {
    fc.assert(
      fc.property(anyLine, (line) => {
        expect(() => redactRawLine(line)).not.toThrow();
        expect(() => scanRawLine(line)).not.toThrow();
      }),
      { numRuns: 50 }
    );
  });
});

describe("readCassette", () => {
  it("fails with an Error rather than crashing on arbitrary file contents", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cassette-fuzz-"));
    let n = 0;
    try {
      fc.assert(
        fc.property(fc.array(anyLine, { maxLength: 5 }), (lines) => {
          const file = path.join(dir, `fuzz-${n++}.jsonl`);
          fs.writeFileSync(file, lines.join("\n"));
          try {
            readCassette(file);
          } catch (err) {
            expect(err).toBeInstanceOf(Error);
          }
        }),
        { numRuns: 50 }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
