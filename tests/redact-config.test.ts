/**
 * Configurable redaction: a user's own rules, for secrets the built-ins cannot
 * see and values they should not have taken.
 *
 * The built-in rules match shapes everyone shares. A credential with a house
 * format, or a field name only one server uses, is invisible to them, and the
 * only answer the tool used to offer was `--no-redact`, which protects nothing.
 *
 * Two things make this harder than "add a regex". Redaction runs before
 * fingerprinting, so a rule that ran at record time and not at replay time
 * leaves the two sides hashing different text and every request misses; that is
 * what the recorded config hash is for, and most of this file is about it.
 * And a custom name is written into the placeholder, so a name that could spell
 * a built-in one would let a cassette claim a built-in rule put it there.
 */

import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  BUILTIN_REDACTION,
  checkRedactConfig,
  compileRedactConfig,
  readRedactConfig,
  redactCassette,
  redactFrame,
  redactString,
  scanCassette,
  type RedactConfig,
} from "../src/redact.js";
import { buildReplayIndex, handleFrame } from "../src/replay.js";
import { startHttpReplay } from "../src/http-replay.js";
import type { Cassette, CassetteEntry, CassetteHeader } from "../src/cassette.js";
import type { JsonRpcFrame, JsonRpcRequest, JsonRpcResponse } from "../src/jsonrpc.js";

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "dist/cli.js");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cassette-redact-config-"));
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

/**
 * A house-format credential, shaped like one and valid nowhere. The built-in
 * rules do not know this prefix, which is the whole point of the file.
 */
const HOUSE_SECRET = "ACME-NOT-A-REAL-HOUSE-TOKEN-00000";
const ACME: RedactConfig = { patterns: [{ name: "acme", regex: "ACME-[A-Z0-9-]{10,}" }] };

const compiled = (config: RedactConfig) => compileRedactConfig(config);

function configFile(name: string, config: unknown): string {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, JSON.stringify(config));
  return file;
}

const HEAD: CassetteHeader = {
  type: "header",
  cassetteVersion: 2,
  recorder: "mcp-cassette@test",
  startedAt: "2026-10-09T00:00:00Z",
  transport: "stdio",
  era: "modern",
};

const c2s = (t: number, frame: unknown): CassetteEntry => ({ type: "frame", t, dir: "c2s", frame }) as CassetteEntry;
const s2c = (t: number, frame: unknown): CassetteEntry => ({ type: "frame", t, dir: "s2c", frame }) as CassetteEntry;

const call = (id: number, args: Record<string, unknown>): JsonRpcRequest => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "echo", arguments: args },
});
const answer = (id: number, text: string): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  result: { content: [{ type: "text", text }] },
});

const textOf = (frame: JsonRpcFrame | null) =>
  (frame as { result?: { content?: { text?: string }[] } } | null)?.result?.content?.[0]?.text;
const errorOf = (frame: JsonRpcFrame | null) => (frame as { error?: { message?: string } } | null)?.error?.message;

/** A recording of one call, redacted under `cfg` exactly as the recorder would have written it. */
function recordedUnder(args: Record<string, unknown>, cfg = BUILTIN_REDACTION, header: Partial<CassetteHeader> = {}): Cassette {
  return {
    header: {
      ...HEAD,
      redaction: { applied: true, ...(cfg.hash ? { configHash: cfg.hash } : {}) },
      ...header,
    },
    entries: [c2s(0, redactFrame(call(1, args), cfg)), s2c(1, answer(1, "recorded"))] as Cassette["entries"],
  };
}

describe("a custom pattern", () => {
  it("redacts a secret the built-in rules cannot see", () => {
    expect(redactString(HOUSE_SECRET)).toBe(HOUSE_SECRET); // built-ins: untouched
    expect(redactString(HOUSE_SECRET, compiled(ACME))).toMatch(/^\[REDACTED:acme:[0-9a-f]{8}\]$/);
  });

  it("redacts every occurrence, not just the first", () => {
    // The rule is compiled global whatever the user wrote, because a value that
    // occurs twice has leaked twice.
    const line = `${HOUSE_SECRET} and again ${HOUSE_SECRET}`;
    const out = redactString(line, compiled(ACME));
    expect(out).not.toContain("ACME-NOT");
    expect(out.match(/\[REDACTED:acme:[0-9a-f]{8}\]/g)).toHaveLength(2);
    // The same secret always collapses to the same placeholder, which is what
    // keeps replay matching.
    const [first, second] = out.match(/\[REDACTED:acme:[0-9a-f]{8}\]/g)!;
    expect(first).toBe(second);
  });

  it("runs before the built-ins, so a house format wins over a generic shape", () => {
    // `sk-...` is openai's shape; the user says this one is theirs.
    const theirs = "sk-HOUSE-FORMAT-NOT-A-REAL-KEY-0000";
    const cfg = compiled({ patterns: [{ name: "house", regex: "sk-HOUSE-[A-Za-z0-9-]{10,}" }] });
    expect(redactString(theirs, cfg)).toMatch(/^\[REDACTED:house:[0-9a-f]{8}\]$/);
  });

  it("takes the i and u flags and refuses the rest", () => {
    const cfg = compiled({ patterns: [{ name: "acme", regex: "acme-[a-z0-9-]{10,}", flags: "i" }] });
    expect(redactString(HOUSE_SECRET, cfg)).toMatch(/^\[REDACTED:acme:[0-9a-f]{8}\]$/);
    expect(() => compiled({ patterns: [{ name: "acme", regex: "x", flags: "m" }] })).toThrow(/may only use "i" and "u"/);
    expect(() => compiled({ patterns: [{ name: "acme", regex: "x", flags: "g" }] })).toThrow(/"g" is always applied/);
    expect(() => compiled({ patterns: [{ name: "acme", regex: "x", flags: "ii" }] })).toThrow(/repeats a flag/);
  });
});

describe("the placeholder is not something a rule may rewrite", () => {
  // A user pattern has no idea what a placeholder looks like. Left alone, an
  // eight-hex rule reads the hash out of one and a word rule reads the rule
  // name, and the second `redact` pass then writes a different file from the
  // first, which replay no longer matches.
  const HEX = compiled({ patterns: [{ name: "hex", regex: "\\b[0-9a-f]{8}\\b" }] });
  const WORD = compiled({ patterns: [{ name: "lab", regex: "bearer" }] });
  const bearer = "Bearer NOT-A-REAL-BEARER-TOKEN-0000";

  it("leaves a hash inside a placeholder alone", () => {
    // `bearer` keeps what it matched around its capture group, so the hash is
    // the only eight-hex run in the result and the hex rule would eat it.
    const once = redactString(bearer, HEX);
    expect(once).toMatch(/^Bearer \[REDACTED:bearer:[0-9a-f]{8}\]$/);
    expect(redactString(once, HEX)).toBe(once);
  });

  it("leaves a rule name inside a placeholder alone", () => {
    const once = redactString(bearer, WORD);
    expect(redactString(once, WORD)).toBe(once);
    expect(once).not.toContain("REDACTED:[REDACTED");
  });

  it("makes a second redact pass over a whole cassette equal the first", () => {
    const raw: Cassette = {
      header: { ...HEAD, redaction: { applied: false } },
      entries: [c2s(0, call(1, { m: bearer })), s2c(1, answer(1, "recorded"))] as Cassette["entries"],
    };
    const once = redactCassette(raw, HEX);
    expect(redactCassette(once, HEX)).toEqual(once);
  });

  it("still redacts a hash-shaped value that is not inside one", () => {
    // The guard is about position, not about the shape of the text.
    const out = redactString("loose deadbeef here", HEX);
    expect(out).toMatch(/\[REDACTED:hex:[0-9a-f]{8}\]/);
  });

  it("ignores a context-only empty match instead of redacting every position", () => {
    // The compile check cannot see this one: the pattern matches empty only
    // after an `x`, so the mechanism has to refuse it.
    const cfg = compiled({ patterns: [{ name: "ctx", regex: "(?<=x)a*" }] });
    expect(redactString("hello", cfg)).toBe("hello");
    expect(redactString("xaa", cfg)).toMatch(/^x\[REDACTED:ctx:[0-9a-f]{8}\]$/);
  });
});

describe("a custom name", () => {
  it("cannot forge a built-in placeholder", () => {
    for (const name of ["bearer", "jwt", "keyctx", "openai"]) {
      expect(() => compiled({ patterns: [{ name, regex: "x" }] })).toThrow(/is a built-in rule/);
    }
  });

  it("must spell something a placeholder can hold", () => {
    // The placeholder grammar is [a-z]+, so anything else would produce a
    // placeholder the reader cannot parse back.
    for (const name of ["ACME", "acme-2", "acme_x", "", "acme "]) {
      expect(() => compiled({ patterns: [{ name, regex: "x" }] })).toThrow(/lowercase letters only/);
    }
  });

  it("cannot be repeated inside one config", () => {
    expect(() =>
      compiled({ patterns: [{ name: "acme", regex: "a" }, { name: "acme", regex: "b" }] })
    ).toThrow(/repeats the name "acme"/);
  });
});

describe("extra keys and allowed values", () => {
  it("treats a configured key name as sensitive whatever the value looks like", () => {
    const cfg = compiled({ keys: ["handle"] });
    const plain = redactFrame({ params: { handle: "ordinary-looking-value" } }, BUILTIN_REDACTION) as {
      params: { handle: string };
    };
    expect(plain.params.handle).toBe("ordinary-looking-value");
    const out = redactFrame({ params: { handle: "ordinary-looking-value" } }, cfg) as { params: { handle: string } };
    expect(out.params.handle).toMatch(/^\[REDACTED:keyctx:[0-9a-f]{8}\]$/);
  });

  it("matches the whole key or any one of its segments, and not a longer word", () => {
    const cfg = compiled({ keys: ["handle"] });
    const out = redactFrame(
      { params: { sessionHandle: "aaaaaaaaaaaa", session_handle: "bbbbbbbbbbbb", handler: "cccccccccccc" } },
      cfg
    ) as { params: Record<string, string> };
    expect(out.params.sessionHandle).toMatch(/^\[REDACTED:keyctx/);
    expect(out.params.session_handle).toMatch(/^\[REDACTED:keyctx/);
    // `handler` is not `handle`; over-redacting it would wreck ordinary data.
    expect(out.params.handler).toBe("cccccccccccc");
  });

  it("lets an allowed value survive a rule that would otherwise take it", () => {
    const publicKey = "sk-THIS-ONE-IS-PUBLIC-000000";
    expect(redactString(publicKey)).toMatch(/\[REDACTED:openai/); // the built-in takes it
    expect(redactString(publicKey, compiled({ allow: [publicKey] }))).toBe(publicKey);
  });

  it("lets an allowed value survive key context too, string and number alike", () => {
    const cfg = compiled({ allow: ["public-sample-value", "123456789"] });
    const out = redactFrame({ params: { token: "public-sample-value", pin: 123456789 } }, cfg) as {
      params: { token: string; pin: number };
    };
    expect(out.params.token).toBe("public-sample-value");
    expect(out.params.pin).toBe(123456789);
  });
});

describe("a malformed config", () => {
  it("names what is wrong rather than failing later", () => {
    expect(() => compiled([] as unknown as RedactConfig)).toThrow(/must be a JSON object/);
    expect(() => compiled({ nope: 1 } as unknown as RedactConfig)).toThrow(/unknown field "nope"/);
    expect(() => compiled({ keys: [1] } as unknown as RedactConfig)).toThrow(/"keys" must be a list of strings/);
    expect(() => compiled({ allow: "x" } as unknown as RedactConfig)).toThrow(/"allow" must be a list of strings/);
    expect(() => compiled({ patterns: [{ name: "acme" }] } as unknown as RedactConfig)).toThrow(/string "regex"/);
    expect(() => compiled({ patterns: [{ name: "acme", regex: "([" }] })).toThrow(/regex does not compile/);
    expect(() => compiled({ patterns: null } as unknown as RedactConfig)).toThrow(/"patterns" must be a list/);
  });

  it("refuses a pattern that can match nothing", () => {
    // It would match at every position and wrap each character of every value
    // in its own placeholder. One typo away from a real pattern.
    for (const regex of ["a*", "", "[A-Z0-9-]*", "(?:)"]) {
      expect(() => compiled({ patterns: [{ name: "x", regex }] })).toThrow(/matches the empty string/);
    }
  });

  it("names the file when it came from one", () => {
    const file = configFile("bad.json", { patterns: [{ name: "ACME", regex: "x" }] });
    expect(() => readRedactConfig(file)).toThrow(new RegExp(`${path.basename(file)}.*lowercase letters only`, "s"));
    const notJson = path.join(tmpDir, "not.json");
    fs.writeFileSync(notJson, "{ nope");
    expect(() => readRedactConfig(notJson)).toThrow(/is not valid JSON/);
    expect(() => readRedactConfig(path.join(tmpDir, "missing.json"))).toThrow(/cannot read the redaction config/);
  });
});

describe("the recorded config hash", () => {
  it("is absent when nothing was configured, so an empty config is no config", () => {
    expect(BUILTIN_REDACTION.hash).toBeUndefined();
    expect(compiled({}).hash).toBeUndefined();
    expect(compiled({ patterns: [], keys: [], allow: [] }).hash).toBeUndefined();
  });

  it("ignores the order of keys and allow, and follows the order of patterns", () => {
    expect(compiled({ keys: ["a", "b"], allow: ["x", "y"] }).hash).toBe(
      compiled({ keys: ["b", "a"], allow: ["y", "x"] }).hash
    );
    // Pattern order decides which rule claims an overlapping match, so it counts.
    const two = [
      { name: "one", regex: "AAA-[0-9]+" },
      { name: "two", regex: "AAA-[0-9]{4}" },
    ];
    expect(compiled({ patterns: two }).hash).not.toBe(compiled({ patterns: [two[1]!, two[0]!] }).hash);
  });

  it("holds neither the regexes nor the allowed values", () => {
    const hash = compiled({ patterns: [{ name: "acme", regex: "SECRET-SHAPE" }], allow: ["a-real-value"] }).hash!;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("SECRET");
    expect(hash).not.toContain("a-real-value");
  });

  it("travels into the cassette a redact pass writes", () => {
    const cfg = compiled(ACME);
    const out = redactCassette(recordedUnder({ note: HOUSE_SECRET }), cfg);
    expect(out.header.redaction).toEqual({ applied: true, configHash: cfg.hash });
  });

  it("is kept, not dropped, when a cassette that carries one is redacted again", () => {
    // The pass is a no-op on already-redacted frames, and the file still names
    // the rules it was written under.
    const cfg = compiled(ACME);
    const once = redactCassette(recordedUnder({ note: HOUSE_SECRET }), cfg);
    const twice = redactCassette(once, cfg);
    expect(twice.header.redaction).toEqual({ applied: true, configHash: cfg.hash });
    expect(twice.entries).toEqual(once.entries);
  });

  it("refuses to re-redact under other rules rather than stamping the file with them", () => {
    // Dropping the hash here is what let `redact in -o out` produce a file whose
    // frames correspond to no single config, which replay would then accept.
    const cfg = compiled(ACME);
    const recorded = redactCassette(recordedUnder({ note: HOUSE_SECRET }), cfg);
    expect(() => redactCassette(recorded)).toThrow(/redacted under a --redact-config and none was given/);
    const other = compiled({ patterns: [{ name: "other", regex: "OTHER-[A-Z0-9-]{10,}" }] });
    expect(() => redactCassette(recorded, other)).toThrow(/redacted under a different --redact-config/);
  });

  it("still lets an unconfigured cassette take a config", () => {
    // The ordinary first pass: a raw recording redacted under rules for the
    // first time.
    expect(() => redactCassette(recordedUnder({ note: HOUSE_SECRET }), compiled(ACME))).not.toThrow();
  });
});

describe("the hash stands for behaviour, not spelling", () => {
  // A user who tidies the file must not be told it is a different config, so
  // each part is hashed in the form matching actually uses.
  it("ignores key case, duplicates and flag order", () => {
    expect(compiled({ keys: ["Handle"] }).hash).toBe(compiled({ keys: ["handle"] }).hash);
    expect(compiled({ keys: ["a", "a", "b"] }).hash).toBe(compiled({ keys: ["b", "a"] }).hash);
    expect(compiled({ allow: ["x", "x", "y"] }).hash).toBe(compiled({ allow: ["y", "x"] }).hash);
    expect(compiled({ patterns: [{ name: "a", regex: "AAA-[0-9]{4}", flags: "iu" }] }).hash).toBe(
      compiled({ patterns: [{ name: "a", regex: "AAA-[0-9]{4}", flags: "ui" }] }).hash
    );
  });

  it("keeps allow case-sensitive, because that is how it is compared", () => {
    expect(compiled({ allow: ["Value"] }).hash).not.toBe(compiled({ allow: ["value"] }).hash);
  });

  it("still separates two configs that behave differently", () => {
    expect(compiled({ keys: ["a"] }).hash).not.toBe(compiled({ keys: ["b"] }).hash);
    expect(compiled({ keys: ["a"] }).hash).not.toBe(compiled({ allow: ["a"] }).hash);
  });
});

describe("replay refuses a cassette recorded under other rules", () => {
  const cfg = compiled(ACME);

  it("says so when the cassette has a config and the replay does not", () => {
    expect(() => buildReplayIndex(recordedUnder({ m: "hi" }, cfg))).toThrow(
      /recorded with a redaction config this replay was not given/
    );
  });

  it("says so when the replay has a config and the cassette does not", () => {
    expect(() => buildReplayIndex(recordedUnder({ m: "hi" }), { redactConfig: cfg })).toThrow(
      /given a redaction config, but the cassette was recorded without one/
    );
  });

  it("says so when the two configs differ", () => {
    const other = compiled({ patterns: [{ name: "other", regex: "OTHER-[A-Z0-9-]{10,}" }] });
    expect(() => buildReplayIndex(recordedUnder({ m: "hi" }, cfg), { redactConfig: other })).toThrow(
      /recorded with a different redaction config/
    );
  });

  it("accepts the matching pair, and the unconfigured pair", () => {
    expect(() => buildReplayIndex(recordedUnder({ m: "hi" }, cfg), { redactConfig: cfg })).not.toThrow();
    expect(() => buildReplayIndex(recordedUnder({ m: "hi" }))).not.toThrow();
  });
});

describe("a custom rule redacted at record time is matched at replay time", () => {
  const cfg = compiled(ACME);

  // `note` deliberately, not `token`: a built-in key-context key would redact
  // the value before any custom pattern was consulted, and the test would pass
  // without the rule it claims to exercise.
  it("matches a live request carrying the raw secret", () => {
    // The recording holds the placeholder; the client sends the real value. The
    // same rule has to run on the live side for the two to meet.
    const index = buildReplayIndex(recordedUnder({ m: "hi", note: HOUSE_SECRET }, cfg), { redactConfig: cfg });
    expect(textOf(handleFrame(index, call(9, { m: "hi", note: HOUSE_SECRET })))).toBe("recorded");
  });

  it("still misses a request carrying a different secret of the same shape", () => {
    // Two different secrets hash differently, so the placeholders differ. A
    // custom rule loosens nothing it was not asked to loosen.
    const index = buildReplayIndex(recordedUnder({ m: "hi", note: HOUSE_SECRET }, cfg), { redactConfig: cfg });
    expect(errorOf(handleFrame(index, call(9, { m: "hi", note: "ACME-A-DIFFERENT-TOKEN-00000" })))).toContain(
      "no recorded response"
    );
  });
});

describe("declared volatility and a custom rule on one request", () => {
  // The red-team question: both rewrite the request before it is hashed, and
  // both have to survive the other. Redaction runs first, then the declared
  // pointers are dropped, on the recorded side and on the live side alike.
  const cfg = compiled(ACME);
  const AT = "/arguments/requestedAt";
  const args = (stamp: string) => ({ m: "hi", note: HOUSE_SECRET, requestedAt: stamp });

  it("composes over stdio", () => {
    const index = buildReplayIndex(recordedUnder(args("2026-10-09T00:00:00Z"), cfg), {
      redactConfig: cfg,
      volatile: [AT],
    });
    // New stamp, raw secret: the stamp is dropped and the secret is redacted.
    expect(textOf(handleFrame(index, call(9, args("2031-01-01T00:00:00Z"))))).toBe("recorded");
    // The argument neither rule touches is still matched exactly.
    expect(
      errorOf(handleFrame(index, call(10, { ...args("2031-01-01T00:00:00Z"), m: "bye" })))
    ).toContain("no recorded response");
  });

  it("composes over HTTP", async () => {
    const file = path.join(tmpDir, "composed.http.jsonl");
    const cassette = recordedUnder(args("2026-10-09T00:00:00Z"), cfg, { transport: "http" });
    fs.writeFileSync(
      file,
      [cassette.header, ...cassette.entries].map((e) => JSON.stringify(e)).join("\n") + "\n"
    );
    const server = await startHttpReplay(file, {
      listen: "127.0.0.1:0",
      volatile: [AT],
      redactConfig: configFile("acme.json", ACME),
    });
    try {
      const res = await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(call(9, args("2031-01-01T00:00:00Z"))),
      });
      expect(textOf((await res.json()) as JsonRpcFrame)).toBe("recorded");
      expect(server.misses()).toBe(0);
    } finally {
      await server.close();
    }
  });
});

describe("--check-config", () => {
  it("proves a well-written pattern linear", async () => {
    const results = await checkRedactConfig(compiled(ACME));
    expect(results).not.toBeNull();
    expect(results).toEqual([expect.objectContaining({ name: "acme", status: "safe" })]);
  });

  it("flags one that can backtrack catastrophically", async () => {
    // The classic nested quantifier: linear input, exponential work.
    const results = await checkRedactConfig(compiled({ patterns: [{ name: "slow", regex: "(a+)+$" }] }));
    expect(results).not.toBeNull();
    expect(results![0]!.status).not.toBe("safe");
    expect(results![0]!.detail).toMatch(/blowup|could not decide/);
  });

  it("analyses the user's patterns only, since the built-ins are proven in CI", async () => {
    const results = await checkRedactConfig(compiled({ keys: ["handle"] }));
    expect(results).toEqual([]);
  });

  it("reports a vulnerable pattern through the CLI and exits 1", () => {
    const file = configFile("slow.json", { patterns: [{ name: "slow", regex: "(a+)+$" }] });
    let stdout = "";
    let code = 0;
    try {
      stdout = execFileSync(process.execPath, [CLI, "redact", "--redact-config", file, "--check-config"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const failure = err as { stdout?: string; status?: number };
      stdout = failure.stdout ?? "";
      code = failure.status ?? 0;
    }
    expect(code).toBe(1);
    expect(stdout).toContain("slow");
    expect(stdout).toMatch(/NOT proven linear-time/);
  }, 60_000);

  it("passes a safe config through the CLI and exits 0", () => {
    const file = configFile("safe.json", ACME);
    const stdout = execFileSync(process.execPath, [CLI, "redact", "--redact-config", file, "--check-config"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(stdout).toMatch(/proven free of super-linear blowup/);
  }, 60_000);
});

describe("the CLI end to end", () => {
  const cassettePath = () => path.join(tmpDir, "cli-source.jsonl");

  it("redacts a house secret and replays the recording it wrote", () => {
    const source = cassettePath();
    const raw: Cassette = {
      header: { ...HEAD, redaction: { applied: false } },
      entries: [c2s(0, call(1, { m: "hi", note: HOUSE_SECRET })), s2c(1, answer(1, "recorded"))] as Cassette["entries"],
    };
    fs.writeFileSync(source, [raw.header, ...raw.entries].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const config = configFile("cli-acme.json", ACME);
    const out = path.join(tmpDir, "cli-redacted.jsonl");

    execFileSync(process.execPath, [CLI, "redact", source, "-o", out, "--redact-config", config], { encoding: "utf8" });
    const written = fs.readFileSync(out, "utf8");
    expect(written).not.toContain(HOUSE_SECRET);
    expect(written).toMatch(/\[REDACTED:acme:[0-9a-f]{8}\]/);
    expect(JSON.parse(written.split("\n")[0]!).redaction.configHash).toMatch(/^[0-9a-f]{64}$/);

    // Replayed with the same config, a client sending the raw secret lands.
    const answered = execFileSync(
      process.execPath,
      [CLI, "replay", out, "--redact-config", config],
      { encoding: "utf8", input: JSON.stringify(call(9, { m: "hi", note: HOUSE_SECRET })) + "\n" }
    );
    expect(textOf(JSON.parse(answered.trim()) as JsonRpcFrame)).toBe("recorded");
  });

  it("refuses the same cassette without the config, naming the missing side", () => {
    const out = path.join(tmpDir, "cli-redacted.jsonl");
    let stderr = "";
    let code = 0;
    try {
      execFileSync(process.execPath, [CLI, "replay", out], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], input: "" });
    } catch (err) {
      const failure = err as { stderr?: string; status?: number };
      stderr = failure.stderr ?? "";
      code = failure.status ?? 0;
    }
    expect(code).toBe(1);
    expect(stderr).toContain("recorded with a redaction config this replay was not given");
  });

  it("refuses --redact-config beside --no-redact instead of silently ignoring one", () => {
    const config = configFile("cli-acme.json", ACME);
    let stderr = "";
    try {
      execFileSync(
        process.execPath,
        [CLI, "record", "-o", path.join(tmpDir, "never.jsonl"), "--no-redact", "--redact-config", config, "--", "true"],
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
      );
    } catch (err) {
      stderr = (err as { stderr?: string }).stderr ?? "";
    }
    expect(stderr).toMatch(/--no-redact removes every rule/);
  });
});

describe("scanning reports a custom rule by its own name", () => {
  it("names the rule the config gave it", () => {
    const cassette = recordedUnder({ m: "hi" });
    const withSecret: Cassette = {
      ...cassette,
      entries: [c2s(0, call(1, { m: HOUSE_SECRET })), s2c(1, answer(1, "recorded"))] as Cassette["entries"],
    };
    expect(scanCassette(withSecret)).toEqual([]); // built-ins see nothing
    const hits = scanCassette(withSecret, compiled(ACME));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ rule: "acme", dir: "c2s", method: "tools/call" });
    // The excerpt locates the value without handing it over.
    expect(hits[0]!.excerpt).not.toContain(HOUSE_SECRET);
  });
});
