import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  maskSecret,
  redactCassette,
  redactCommand,
  redactFrame,
  redactRawLine,
  redactString,
  scanCassette,
  scanFrame,
  scanRawLine,
} from "../src/redact.js";
import type { Cassette } from "../src/cassette.js";

/**
 * Fake credentials — shaped like the real thing, valid nowhere.
 *
 * None of these are structurally accurate, on purpose. A fixture with a real
 * token's shape trips GitHub push protection, which blocks the push over a
 * credential that never existed — that already happened once here, with a
 * convincing `xoxb-<digits>-<digits>-<alnum>` Slack fixture. Every rule keys on
 * a prefix and a length, so an obviously synthetic value exercises it
 * identically. Please don't "fix" these to look realistic.
 */
const SECRETS = {
  // {"alg":"none"} . {"note":"NOT-A-REAL-JWT"} . a signature that is not one
  jwt: "eyJhbGciOiJub25lIn0.eyJub3RlIjoiTk9ULUEtUkVBTC1KV1QifQ.NOT-A-REAL-SIGNATURE",
  github: "ghp_NOTAREALTOKENFORTESTSONLY0000000000",
  githubPat: "github_pat_NOT_A_REAL_PAT_FOR_TESTS_ONLY_0000000000",
  openai: "sk-NOT-A-REAL-OPENAI-KEY-000000",
  anthropic: "sk-ant-NOT-A-REAL-ANTHROPIC-KEY-0000",
  slack: "xoxb-NOT-A-REAL-SLACK-TOKEN-FIXTURE",
  aws: "AKIANOTAREALKEYXXX00",
  google: "AIzaNOT-A-REAL-GOOGLE-API-KEY-000000000",
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

  it("redacts only the password in a connection string, for any scheme", () => {
    const dsns: Array<[string, string]> = [
      ["postgres://app_user:s3cr3tP4ss@db.internal:5432/appdb", "postgres"],
      ["redis://default:r3d1sPassw0rd@cache:6379/0", "redis"],
      ["mongodb://admin:M0ng0Secret@mongo:27017/admin?authSource=admin", "mongodb"],
      ["mysql://root:mysqlpw123@127.0.0.1:3306/shop", "mysql"],
      ["amqp://guest:gu3stPass@rabbit:5672/vhost", "amqp"],
      ["https://user:httpPassw0rd@api.example.com/v1", "https"],
    ];
    for (const [dsn, scheme] of dsns) {
      const out = redactString(dsn);
      const [before, after] = dsn.split(/:[^:/@]+@/);
      expect(out).toMatch(/\[REDACTED:urlcreds:[0-9a-f]{8}\]/);
      expect(out.startsWith(`${before}:[REDACTED:urlcreds:`)).toBe(true); // scheme, user kept
      expect(out.endsWith(`@${after}`)).toBe(true); // host, port, path kept
      expect(out).toContain(`${scheme}://`);
    }
  });

  it("leaves a URL with no userinfo alone", () => {
    for (const url of [
      "postgres://app_user@db.internal:5432/appdb",
      "https://api.example.com/v1/tokens",
      "redis://cache:6379/0",
    ]) {
      expect(redactString(url)).toBe(url);
    }
  });

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
  it("uses the first 8 hex characters of the secret's sha256", () => {
    // Pinned: changing the digest or the truncation would silently break
    // matching between a cassette and any client that redacts differently.
    const expected = createHash("sha256").update(SECRETS.aws, "utf8").digest("hex").slice(0, 8);
    expect(redactString(SECRETS.aws)).toBe(`[REDACTED:aws:${expected}]`);
    expect(expected).toMatch(/^[0-9a-f]{8}$/);
  });

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

  it("redacts a connection string passed as a tool argument", () => {
    const out = redactFrame({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "query",
        arguments: { dsn: "postgres://app_user:s3cr3tP4ss@db.internal:5432/appdb", sql: "select 1" },
      },
    }) as Record<string, any>;
    expect(out.params.arguments.dsn).toContain("postgres://app_user:[REDACTED:urlcreds:");
    expect(out.params.arguments.dsn).toContain("@db.internal:5432/appdb");
    expect(out.params.arguments.dsn).not.toContain("s3cr3tP4ss");
    expect(out.params.arguments.sql).toBe("select 1");
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

  it("never mutates its input, including its prototype", () => {
    const input = JSON.parse(
      `{"params":{"arguments":{"__proto__":{"a":1},"token":${JSON.stringify(SECRETS.github)}}}}`
    );
    const snapshot = JSON.stringify(input);
    const inputProto = Object.getPrototypeOf(input.params.arguments);
    redactFrame(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(Object.getPrototypeOf(input.params.arguments)).toBe(inputProto);
  });

  it("keeps a __proto__ key as an own property and redacts through it", () => {
    // Assigning with out[key] would invoke the prototype setter: the field would
    // vanish from the cassette and replay would serve a payload the server never
    // sent, with attacker-supplied data on the result's prototype.
    const input = JSON.parse(
      `{"params":{"arguments":{"__proto__":{"token":${JSON.stringify(SECRETS.github)}},"keep":"x"}}}`
    );
    const out = redactFrame(input) as any;
    const args = out.params.arguments;

    expect(Object.prototype.hasOwnProperty.call(args, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(args)).toBe(Object.prototype);
    expect(args["__proto__"].token).toMatch(PLACEHOLDER);
    expect(args.keep).toBe("x");
    expect(JSON.parse(JSON.stringify(out)).params.arguments["__proto__"].token).toMatch(PLACEHOLDER);
    expect(({} as any).token).toBeUndefined(); // Object.prototype untouched
  });

  it("preserves non-string values", () => {
    const out = redactFrame({ n: 42, b: true, nil: null, arr: [1, 2] });
    expect(out).toEqual({ n: 42, b: true, nil: null, arr: [1, 2] });
  });
});

describe("key context vs. discovery metadata", () => {
  const meta = () =>
    redactFrame({
      token_endpoint: "https://auth.example.com/oauth/token",
      authorization_endpoint: "https://auth.example.com/oauth/authorize",
      revocation_endpoint: "https://auth.example.com/oauth/revoke",
      jwks_uri: "https://auth.example.com/.well-known/jwks.json",
    }) as Record<string, string>;

  it("keeps public OAuth endpoint URLs intact", () => {
    expect(meta()).toEqual({
      token_endpoint: "https://auth.example.com/oauth/token",
      authorization_endpoint: "https://auth.example.com/oauth/authorize",
      revocation_endpoint: "https://auth.example.com/oauth/revoke",
      jwks_uri: "https://auth.example.com/.well-known/jwks.json",
    });
  });

  // Only `token_endpoint` and `authorization_endpoint` contain a SENSITIVE_KEY
  // term at all; the rest of the discovery set is listed for completeness and is
  // never a redaction candidate in the first place.
  const notPlainUrls: Array<[string, string, string]> = [
    ["token_endpoint", SECRETS.jwt, "not a URL at all"],
    ["token_endpoint", "https://user:pa55word@evil.test/token", "userinfo component"],
    ["token_endpoint", "ftp://auth.example.com/token", "not http(s)"],
    ["authorization_endpoint", "https://evil.test/?secret=abcdefghij", "query string"],
  ];

  for (const [key, value, why] of notPlainUrls) {
    it(`still redacts ${key} when the value has a ${why}`, () => {
      const out = redactFrame({ [key]: value }) as Record<string, string>;
      expect(out[key]).toMatch(PLACEHOLDER);
    });
  }

  it("does not exempt a URL under an ordinary sensitive key", () => {
    const out = redactFrame({ token: "https://auth.example.com/oauth/token" }) as Record<
      string,
      string
    >;
    expect(out.token).toMatch(PLACEHOLDER);
  });
});

describe("raw lines", () => {
  // A JSON line with no "jsonrpc" tag — a batch, or a server's structured log —
  // is stored as a raw entry, so keyctx has to reach it too.
  const line = JSON.stringify({
    level: "debug",
    params: { arguments: { password: "correct-horse-battery" } },
  });

  it("redacts by key context and leaves every other byte alone", () => {
    const out = redactRawLine(line);
    expect(out).not.toContain("correct-horse-battery");
    expect(out).toContain("[REDACTED:keyctx:");
    expect(out).toBe(line.replace(/"correct-horse-battery"/, `"${out.match(/\[REDACTED[^\]]+\]/)![0]}"`));
  });

  it("reports the path of a key-context secret in a raw line", () => {
    const hits = scanRawLine(line);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ rule: "keyctx", path: "params.arguments.password" });
    expect(hits[0]!.excerpt).not.toContain("correct");
  });

  it("falls back to shape rules on a line that is not JSON", () => {
    const log = `warn: authenticating with ${SECRETS.github}`;
    expect(redactRawLine(log)).toMatch(/^warn: authenticating with \[REDACTED:github:[0-9a-f]{8}\]$/);
    // No object to walk, so a bare key=value pair has no key context to use.
    expect(redactRawLine("password=correct-horse-battery")).toBe("password=correct-horse-battery");
  });

  it("redacts a secret that needs JSON escaping in the raw text", () => {
    const escaped = JSON.stringify({ token: 'quote"and\\slash-secret' });
    const out = redactRawLine(escaped);
    expect(out).not.toContain("and\\\\slash");
    expect(out).toContain("[REDACTED:keyctx:");
  });
});

describe("redactCommand", () => {
  it("redacts tokens passed as CLI arguments", () => {
    const out = redactCommand(["npx", "-y", "server", `--token=${SECRETS.github}`]);
    expect(out.slice(0, 3)).toEqual(["npx", "-y", "server"]);
    expect(out[3]).toMatch(/^--token=\[REDACTED:github:[0-9a-f]{8}\]$/);
  });
});

describe("maskSecret", () => {
  it("keeps a literal prefix for shape rules, which is all it can reveal", () => {
    expect(maskSecret(SECRETS.aws, "aws")).toMatch(/^AKIA\*+ \(\d+ chars\)$/);
  });

  it("masks opaque secrets whole — a leak detector must not print a password", () => {
    expect(maskSecret("hunter22", "keyctx")).toBe("******** (8 chars)");
    expect(maskSecret("abcd1234efgh", "bearer")).toBe("************ (12 chars)");
    expect(maskSecret("s3cr3tP4ss", "urlcreds")).toBe("********** (10 chars)");
  });
});

describe("redactString scope", () => {
  it("applies shape rules only — key context needs an object to walk", () => {
    // Pins the boundary that made raw lines leak: this is why record.ts routes
    // unparsed lines through redactRawLine, not redactString.
    const json = '{"password":"correct-horse-battery"}';
    expect(redactString(json)).toBe(json);
    expect(redactRawLine(json)).toContain("[REDACTED:keyctx:");
  });

  it("keeps the text around a captured group", () => {
    expect(redactString("Bearer abcdefgh12345678, then more")).toMatch(
      /^Bearer \[REDACTED:bearer:[0-9a-f]{8}\], then more$/
    );
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

  it("labels a response hit with the method it answers", () => {
    const cassette = cassetteWith(SECRETS.github);
    cassette.entries.push({
      type: "frame",
      t: 2,
      dir: "s2c",
      frame: { jsonrpc: "2.0", id: 1, result: { content: [{ text: SECRETS.aws }] } },
    });
    const hit = scanCassette(cassette).find((h) => h.rule === "aws");
    expect(hit).toMatchObject({ dir: "s2c", method: "tools/call", path: "result.content[0].text" });
  });

  // Each direction numbers its own requests, so a client `tools/call` and a
  // server-initiated `sampling/createMessage` can both be id 1 without either
  // being wrong. An id-only map lets the later one relabel the other's response.
  it("does not confuse a client request id with a server-initiated one", () => {
    const cassette = cassetteWith(SECRETS.github);
    cassette.entries.push(
      // The server asks the client something, reusing id 1 in its own space.
      {
        type: "frame",
        t: 2,
        dir: "s2c",
        frame: { jsonrpc: "2.0", id: 1, method: "sampling/createMessage", params: {} },
      },
      // The client answers it — c2s response to an s2c request.
      {
        type: "frame",
        t: 3,
        dir: "c2s",
        frame: { jsonrpc: "2.0", id: 1, result: { model: SECRETS.aws } },
      },
      // The server answers the client's original tools/call — s2c response to c2s.
      {
        type: "frame",
        t: 4,
        dir: "s2c",
        frame: { jsonrpc: "2.0", id: 1, result: { content: [{ text: SECRETS.google }] } },
      }
    );

    const hits = scanCassette(cassette);
    expect(hits.find((h) => h.rule === "aws")).toMatchObject({
      dir: "c2s",
      method: "sampling/createMessage",
    });
    expect(hits.find((h) => h.rule === "google")).toMatchObject({
      dir: "s2c",
      method: "tools/call",
    });
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

describe("adversarial input", () => {
  // `-` is both a base64url character and a word boundary, so this offers a
  // candidate JWT start every four characters. With unbounded segments each one
  // rescanned the rest of the line: 6.1s on 128KB, inside the proxy's
  // synchronous data handler, stalling forwarding in both directions.
  it("stays linear on input engineered to backtrack", () => {
    const timeFor = (n: number) => {
      const started = performance.now();
      redactString("eyJ-".repeat(n));
      return performance.now() - started;
    };
    timeFor(1000); // warm up
    expect(timeFor(32_000)).toBeLessThan(1000); // 128KB — was ~6100ms
    expect(redactString(`x ${SECRETS.jwt} y`)).toContain("[REDACTED:jwt:"); // still catches real ones
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
