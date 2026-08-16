/**
 * Properties of the replay fingerprint: the function that decides whether an
 * incoming request is "the same call" as a recorded one.
 *
 * Two failure modes matter, and they pull in opposite directions:
 *
 *   too strict  : a client that serializes its params in a different key order,
 *                 or attaches a progress token under `_meta`, stops matching a
 *                 cassette that would answer it perfectly. Replay breaks for
 *                 reasons that have nothing to do with the call.
 *   too loose   : two genuinely different calls collapse onto one fingerprint,
 *                 and replay confidently returns the wrong recorded answer.
 *
 * The examples cover the shapes we thought of. These properties cover the ones
 * we did not.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { fingerprint } from "../../src/replay.js";
import { stableStringify } from "../../src/jsonrpc.js";

/** Methods whose fingerprint is the method name alone; params are ignored. */
const METHOD_ONLY = [
  "initialize",
  "ping",
  "tools/list",
  "resources/list",
  "prompts/list",
  "resources/templates/list",
];

/** A method that fingerprints over its params, unlike the lifecycle calls. */
const paramMethod = fc
  .constantFrom("resources/read", "prompts/get", "completion/complete", "logging/setLevel")
  .filter((m) => !METHOD_ONLY.includes(m));

/** Keys the fingerprint deliberately drops before comparing. */
const IGNORED_KEYS = new Set(["_meta", "cursor"]);

const paramsObject = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 8 }).filter((k) => !IGNORED_KEYS.has(k)),
  fc.jsonValue(),
  { maxKeys: 5 }
);

/** Same entries, different insertion order. */
function reorder(obj: Record<string, unknown>, rotation: number): Record<string, unknown> {
  const keys = Object.keys(obj);
  if (keys.length === 0) return {};
  const at = rotation % keys.length;
  const rotated = [...keys.slice(at), ...keys.slice(0, at)];
  const out: Record<string, unknown> = {};
  for (const key of rotated) out[key] = obj[key];
  return out;
}

describe("fingerprint", () => {
  it("ignores key order", () => {
    fc.assert(
      fc.property(paramMethod, paramsObject, fc.nat({ max: 20 }), (method, params, rotation) => {
        expect(fingerprint({ method, params: reorder(params, rotation) })).toBe(
          fingerprint({ method, params })
        );
      })
    );
  });

  it("ignores _meta, whether it is present, absent or changed", () => {
    fc.assert(
      fc.property(paramMethod, paramsObject, fc.jsonValue(), (method, params, meta) => {
        const bare = fingerprint({ method, params });
        expect(fingerprint({ method, params: { ...params, _meta: meta } })).toBe(bare);
        expect(fingerprint({ method, params: { _meta: meta, ...params } })).toBe(bare);
      })
    );
  });

  it("ignores a server-generated pagination cursor", () => {
    fc.assert(
      fc.property(paramMethod, paramsObject, fc.string(), (method, params, cursor) => {
        expect(fingerprint({ method, params: { ...params, cursor } })).toBe(
          fingerprint({ method, params })
        );
      })
    );
  });

  it("separates two calls that differ in a real parameter value", () => {
    fc.assert(
      fc.property(
        paramMethod,
        paramsObject,
        fc.string({ minLength: 1, maxLength: 8 }).filter((k) => !IGNORED_KEYS.has(k)),
        fc.jsonValue(),
        fc.jsonValue(),
        (method, params, key, a, b) => {
          fc.pre(stableStringify(a) !== stableStringify(b));
          expect(fingerprint({ method, params: { ...params, [key]: a } })).not.toBe(
            fingerprint({ method, params: { ...params, [key]: b } })
          );
        }
      )
    );
  });

  it("separates tools/call by tool name and by arguments, and ignores the rest", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 12 }),
        fc.string({ minLength: 1, maxLength: 12 }),
        paramsObject,
        fc.jsonValue(),
        (toolA, toolB, args, meta) => {
          const call = (name: string, extra: Record<string, unknown> = {}) =>
            fingerprint({ method: "tools/call", params: { name, arguments: args, ...extra } });

          expect(call(toolA, { _meta: meta })).toBe(call(toolA));
          if (toolA !== toolB) expect(call(toolA)).not.toBe(call(toolB));
        }
      )
    );
  });

  it("collapses every lifecycle call to its method, whatever the params say", () => {
    fc.assert(
      fc.property(fc.constantFrom(...METHOD_ONLY), fc.jsonValue(), (method, params) => {
        expect(fingerprint({ method, params })).toBe(method);
      })
    );
  });
});
