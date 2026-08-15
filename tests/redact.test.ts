import { describe, expect, it } from "vitest";
import {
  redactCassette,
  redactCommand,
  redactFrame,
  redactString,
  scanCassette,
  scanFrame,
} from "../src/redact.js";
import type { Cassette } from "../src/cassette.js";

/** Fake credentials — shaped like the real thing, valid nowhere. */
const SECRETS = {
  jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NSIsIm5hbWUiOiJ0ZXN0In0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  github: "ghp_Fak3T0k3nN0tR34l0000000000000000000",
  githubPat: "github_pat_11ABCDEFG0abcdefghijkl_0123456789ABCDEFGHIJKLMNOP",
  openai: "sk-Fak30p3nAIk3y0000000000000000000000000000000000",
  anthropic: "sk-ant-api03-Fak3Anthr0p1cK3y00000000000000",
  slack: "xoxb-NOT-A-REAL-SLACK-TOKEN-FIXTURE",
  aws: "AKIAIOSFODNN7EXAMPLE",
  google: "AIzaSyFak3G00gl3AP1K3y00000000000000000",
};

const PLACEHOLDER = /^\[REDACTED:[a-z]+:[0-9a-f]{8}\]$/;

describe("redactString rules", () => {
  const cases: Array<[string, string]> = [
    ["jwt", SECRETS.jwt],
    ["github", SECRETS.github],
    ["github", SECRETS.githubPat],
    ["openai", SECRETS.openai],
    ["anthropic", SECRETS.anthropic],
    ["slack", SECRETS.slack],
    ["aws", SECRETS.aws],
    ["google", SECRETS.google],
  ];

  for (const [rule, secret] of cases) {
    it(`redacts a ${rule} token`, () => {
      const out = redactString(`value: ${secret} .`);
      expect(out).not.toContain(secret);
      expect(out).toMatch(new RegExp(`^value: \\[REDACTED:${rule}:[0-9a-f]{8}\\] \\.$`));
    });
  }

  it("keeps the word Bearer and redacts only the token", () => {
    const out = redactString(`Authorization: Bearer ${SECRETS.jwt}`);
    expect(out).toContain("Bearer [REDACTED:bearer:");
    expect(out).not.toContain(SECRETS.jwt);
  });

  it("prefers the anthropic rule over the generic openai shape", () => {
    expect(redactString(SECRETS.anthropic)).toMatch(/^\[REDACTED:anthropic:[0-9a-f]{8}\]$/);
  });

  const negatives: Array<[string, string]> = [
    ["ordinary prose", "the quick brown fox jumps over the lazy dog"],
    ["a bare prefix", "ghp_tooshort"],
    ["a short sk- value", "sk-abc123"],
    ["a base64-ish word that is not a JWT", "eyJhbGciOiJIUzI1NiJ9"],
    ["an AKIA-like string of the wrong length", "AKIASHORT"],
    ["a slugified title", "hello-world-this-is-a-slug"],
    ["a URL", "https://example.com/path?query=1"],
  ];

  for (const [what, text] of negatives) {
    it(`leaves ${what} alone`, () => {
      expect(redactString(text)).toBe(text);
    });
  }
});

describe("placeholder determinism", () => {
  it("maps the same secret to the same placeholder every time", () => {
    expect(redactString(SECRETS.github)).toBe(redactString(SECRETS.github));
    expect(redactString(`a ${SECRETS.github}`)).toContain(redactString(SECRETS.github));
  });

  it("maps different secrets to different placeholders", () => {
    const a = redactString(SECRETS.github);
    const b = redactString(SECRETS.github.replace(/0{3}$/, "111"));
    expect(a).not.toBe(b);
  });

  it("is idempotent — redacting an already-redacted value changes nothing", () => {
    const once = redactFrame({ params: { token: SECRETS.github, note: SECRETS.aws } });
    expect(redactFrame(once)).toEqual(once);
  });
});

describe("redactFrame", () => {
  it("redacts string values in nested objects and arrays", () => {
    const out = redactFrame({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "deploy",
        arguments: {
          headers: [{ value: `Bearer ${SECRETS.jwt}` }],
          nested: { deep: { key: SECRETS.aws } },
        },
      },
    }) as Record<string, any>;

    expect(out.method).toBe("tools/call");
    expect(out.params.name).toBe("deploy");
    expect(out.params.arguments.headers[0].value).toContain("Bearer [REDACTED:bearer:");
    expect(out.params.arguments.nested.deep.key).toMatch(/^\[REDACTED:aws:[0-9a-f]{8}\]$/);
  });

  it("redacts by key context regardless of the value's shape", () => {
    const out = redactFrame({
      password: "hunter2-not-a-known-shape",
      api_key: "plain-but-sensitive",
      Authorization: "Basic dXNlcjpwYXNzd29yZA==",
      credentials: { secret: "another-opaque-one" },
      description: "a perfectly innocent sentence",
    }) as Record<string, any>;

    expect(out.password).toMatch(PLACEHOLDER);
    expect(out.api_key).toMatch(PLACEHOLDER);
    expect(out.Authorization).toMatch(PLACEHOLDER);
    expect(out.credentials.secret).toMatch(PLACEHOLDER);
    expect(out.description).toBe("a perfectly innocent sentence");
  });

  it("leaves short values under a sensitive key alone", () => {
    const out = redactFrame({ token: "none", secret: "off" }) as Record<string, string>;
    expect(out.token).toBe("none");
    expect(out.secret).toBe("off");
  });

  it("never mutates its input", () => {
    const input = { params: { arguments: { token: SECRETS.github } } };
    const snapshot = JSON.stringify(input);
    redactFrame(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("preserves non-string values", () => {
    const out = redactFrame({ n: 42, b: true, nil: null, arr: [1, 2] });
    expect(out).toEqual({ n: 42, b: true, nil: null, arr: [1, 2] });
  });
});

describe("redactCommand", () => {
  it("redacts tokens passed as CLI arguments", () => {
    const out = redactCommand(["npx", "-y", "server", `--token=${SECRETS.github}`]);
    expect(out.slice(0, 3)).toEqual(["npx", "-y", "server"]);
    expect(out[3]).toMatch(/^--token=\[REDACTED:github:[0-9a-f]{8}\]$/);
  });
});

describe("scanning", () => {
  it("reports rule, path and a masked excerpt without leaking the secret", () => {
    const hits = scanFrame({ params: { arguments: { key: SECRETS.aws } } });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.rule).toBe("aws");
    expect(hits[0]!.path).toBe("params.arguments.key");
    expect(hits[0]!.excerpt).not.toContain(SECRETS.aws);
    expect(hits[0]!.excerpt.startsWith("AKIA")).toBe(true);
  });

  it("finds nothing in an already-redacted cassette", () => {
    const cassette = cassetteWith(SECRETS.github);
    expect(scanCassette(cassette).length).toBeGreaterThan(0);
    expect(scanCassette(redactCassette(cassette))).toEqual([]);
  });

  it("reports direction and method for frame hits, and header command hits", () => {
    const hits = scanCassette(cassetteWith(SECRETS.github));
    const header = hits.find((h) => h.dir === "header");
    expect(header?.path).toBe("command[1]");
    const frameHit = hits.find((h) => h.dir === "c2s");
    expect(frameHit?.method).toBe("tools/call");
  });
});

describe("redactCassette", () => {
  it("marks the header, redacts frames, raw lines and the command", () => {
    const out = redactCassette(cassetteWith(SECRETS.github));
    expect(out.header.redaction).toEqual({ applied: true });
    expect(JSON.stringify(out)).not.toContain(SECRETS.github);
    expect(out.header.command?.[0]).toBe("my-server");
    expect((out.entries[1] as { data: string }).data).toContain("[REDACTED:github:");
  });

  it("does not mutate the input cassette", () => {
    const input = cassetteWith(SECRETS.github);
    const snapshot = JSON.stringify(input);
    redactCassette(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

function cassetteWith(secret: string): Cassette {
  return {
    header: {
      type: "header",
      cassetteVersion: 1,
      recorder: "test",
      startedAt: "2026-01-01T00:00:00Z",
      transport: "stdio",
      command: ["my-server", `--token=${secret}`],
    },
    entries: [
      {
        type: "frame",
        t: 0,
        dir: "c2s",
        frame: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "deploy", arguments: { token: secret } },
        },
      },
      { type: "raw", t: 1, dir: "s2c", data: `warn: using ${secret}` },
    ],
  };
}
