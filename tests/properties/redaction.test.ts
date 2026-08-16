/**
 * Properties of secrets redaction.
 *
 * Redaction sits between a live session and a file that gets committed, so it
 * has two jobs that constrain each other. It must remove credentials, and it
 * must leave the recording usable: replay matches a request against a recorded
 * one by fingerprinting its *redacted* form, so a placeholder that varied by
 * position, or a pass that changed shape on a second run, would silently stop
 * cassettes from matching.
 *
 * Four invariants, none of which an example test can establish on its own:
 *
 *   idempotent   : redacting twice is redacting once
 *   shape-stable : the set of JSON pointers is untouched
 *   deterministic: one secret, one placeholder, wherever it appears
 *   minimal      : a string no rule recognizes is returned byte-for-byte
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { REDACT_RULES, redactFrame, redactString } from "../../src/redact.js";

/** Every JSON pointer in a value, in document order. */
function pointers(value: unknown, at = ""): string[] {
  if (Array.isArray(value)) {
    return [at, ...value.flatMap((item, i) => pointers(item, `${at}/${i}`))];
  }
  if (value && typeof value === "object") {
    return [
      at,
      ...Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
        pointers(item, `${at}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`)
      ),
    ];
  }
  return [at];
}

/** Does any redaction rule recognize something in this string? */
function anyRuleMatches(s: string): boolean {
  // Fresh regexes: the exported ones are global, and `test` advances lastIndex.
  return REDACT_RULES.some((rule) => new RegExp(rule.pattern.source, rule.pattern.flags).test(s));
}

/**
 * Keys that put a value under key context, mixed with ordinary ones. The
 * generated payloads have to exercise both paths through `redactValue`.
 */
const payloadKey = fc.constantFrom(
  "token",
  "api_key",
  "accessToken",
  "password",
  "authorization",
  "pin",
  "name",
  "city",
  "count",
  "shipping",
  "arguments"
);

/** Strings that sometimes look like credentials and sometimes do not. */
const payloadString = fc.oneof(
  fc.string({ maxLength: 24 }),
  fc.constantFrom(
    "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
    "sk-ant-0123456789abcdef",
    "Bearer abcdef0123456789",
    "postgres://user:hunter2hunter2@db.internal:5432/app",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
    "AKIAIOSFODNN7EXAMPLE",
    "correct-horse-battery-staple",
    "https://auth.example.com/token",
    "3"
  )
);

const payload = fc.letrec((tie) => ({
  node: fc.oneof(
    { depthSize: "small" },
    payloadString,
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.array(tie("node"), { maxLength: 4 }),
    fc.dictionary(payloadKey, tie("node"), { maxKeys: 5 })
  ),
})).node;

describe("redaction", () => {
  it("is idempotent", () => {
    fc.assert(
      fc.property(payload, (frame) => {
        const once = redactFrame(frame);
        expect(redactFrame(once)).toEqual(once);
      })
    );
  });

  it("leaves the set of JSON pointers exactly as it found it", () => {
    fc.assert(
      fc.property(payload, (frame) => {
        expect(pointers(redactFrame(frame))).toEqual(pointers(frame));
      })
    );
  });

  it("returns a string no rule recognizes byte-for-byte", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        fc.pre(!anyRuleMatches(s));
        expect(redactString(s)).toBe(s);
      })
    );
  });

  it("gives one secret the same placeholder wherever it appears", () => {
    // A GitHub PAT shape, valid nowhere. Surrounded by characters that cannot
    // extend the match, so the rule sees the same secret in every position.
    const secret = fc
      .stringMatching(/^[A-Za-z0-9]{16,32}$/)
      .map((tail) => `ghp_${tail}`);
    const filler = fc.string({ unit: fc.constantFrom(" ", ".", ",", ";", "\n", "(") });

    fc.assert(
      fc.property(secret, filler, filler, (token, before, after) => {
        const alone = redactString(token);
        expect(alone).toMatch(/^\[REDACTED:github:[0-9a-f]{8}\]$/);

        // Same placeholder in a sentence, and twice in the same sentence.
        expect(redactString(`${before}${token}${after}`)).toBe(`${before}${alone}${after}`);
        expect(redactString(`${token} ${token}`)).toBe(`${alone} ${alone}`);

        // And inside a structure, under any key.
        expect(redactFrame({ a: token, b: [token] })).toEqual({ a: alone, b: [alone] });
      })
    );
  });

  it("marks every value it changed, so a diff is never silent", () => {
    fc.assert(
      fc.property(payload, (frame) => {
        const redacted = redactFrame(frame);
        fc.pre(JSON.stringify(redacted) !== JSON.stringify(frame));
        expect(JSON.stringify(redacted)).toContain("[REDACTED:");
      })
    );
  });
});
