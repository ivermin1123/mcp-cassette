[![CI](https://github.com/ivermin1123/mcp-cassette/actions/workflows/ci.yml/badge.svg)](https://github.com/ivermin1123/mcp-cassette/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/mcp-cassette.svg)](https://www.npmjs.com/package/mcp-cassette)

# mcp-cassette

**Record a real MCP session once — replay it forever.**

VCR-style record/replay, contract snapshots, and safety checks for [Model Context Protocol](https://modelcontextprotocol.io) servers. Test your MCP integrations in CI: deterministic, offline, no live APIs, no tokens, no flakes.

```
┌────────┐   record    ┌──────────────┐   real    ┌────────────┐
│ client │ ──────────► │ mcp-cassette │ ────────► │ MCP server │
└────────┘             │    (proxy)   │           └────────────┘
                       └──────┬───────┘
                              ▼
                    session.cassette.jsonl
                              │
┌────────┐   replay           ▼
│   CI   │ ◄────────── deterministic mock — the real server never runs
└────────┘
```

## Why

- **CI without the world.** Your MCP server wraps GitHub/Postgres/Stripe. Your agent tests shouldn't need live credentials, rate limits, or network. Record once against the real thing, replay in every CI run.
- **No more silent breaking changes.** `snapshot --check` fails the PR that removes a tool, adds a required parameter, or changes a type — before your users' agents break at 3am.
- **Catch poisoned tools.** `check` lints tool descriptions for the known shapes of tool-poisoning attacks (instruction overrides, concealment directives, exfiltration URLs, invisible Unicode) and validates every schema (draft-07 and 2020-12).

Works at the transport level — any server, any SDK, any language, any spec revision.

## Quickstart

```bash
npm install -g mcp-cassette   # or: npx mcp-cassette ...
```

**1. Health-check any server**

```bash
mcp-cassette check --stdio "npx -y @modelcontextprotocol/server-everything stdio"
```

```
server: mcp-servers/everything@2.0.0  protocol: 2025-06-18
surface: 13 tools, 7 resources, 4 prompts
[OK] no findings
result: PASS (0 error(s), 0 warning(s))
```

**2. Record a session** — put the proxy between your client and the server:

```bash
# wherever your client config points at the server command, wrap it:
mcp-cassette record -o session.cassette.jsonl -- npx -y @modelcontextprotocol/server-github
```

**3. Replay it offline** — the cassette *is* the server now:

```bash
mcp-cassette check --stdio "mcp-cassette replay session.cassette.jsonl"
# → identical results, no network, no tokens, deterministic
```

**4. Lock the contract**

```bash
mcp-cassette snapshot --stdio "npx -y my-server"            # writes mcp-contract.snapshot.json
mcp-cassette snapshot --check --stdio "npx -y my-server"    # CI: fails on breaking changes
```

```
[BREAKING] add: parameter "precision" is now required
[BREAKING] slugify: tool removed
[MINOR]    add: parameter "mode" added
result: FAIL (2 breaking, 1 minor, 0 info)
```

## CI recipe (GitHub Actions)

```yaml
- name: MCP contract & safety checks
  run: |
    npx mcp-cassette check    --stdio "node dist/my-server.js"
    npx mcp-cassette snapshot --check --stdio "node dist/my-server.js"

- name: Agent integration tests (offline, via cassette)
  run: npx vitest run   # your tests point the MCP client at: mcp-cassette replay fixtures/session.cassette.jsonl
```

## Commands

| Command | What it does |
|---|---|
| `record -o <file> [--no-redact] -- <server cmd>` | Transparent stdio proxy; captures every JSON-RPC frame (both directions) into an open JSONL cassette. Bytes are forwarded verbatim — recording is invisible to both sides. Secrets are [redacted](#secrets-redaction) before they hit the file. |
| `replay <file>` | Serves the cassette as a stdio MCP server. Requests are matched by method + arguments (volatile `_meta` ignored); repeated identical calls replay in recorded order; unrecorded `ping` is synthesized; anything else gets a clear JSON-RPC error. |
| `check [--stdio "cmd" \| --url <url>] [--json]` | Lifecycle handshake, `tools/resources/prompts` listing, JSON Schema validation (ajv; draft-07 + 2020-12 by declared dialect), duplicate/name/description checks, and the safety lint below. Exit 1 on errors. |
| `snapshot [--check] [--update] [-f file]` | Canonical contract snapshot (tools + schemas + annotations). `--check` classifies drift: **breaking** (removed tool/param, new required param, type change, enum narrowed) / **minor** (additive) / **info** (descriptions). Exit 1 on breaking. |
| `redact <cassette> -o <out> \| --scan` | Redact an existing cassette, or audit one in place. `--scan` writes nothing and exits 1 if it finds anything. |

### Safety lint rules

Heuristics distilled from tool-poisoning research and the MCP security literature (SAFE-MCP, OWASP Agentic Top 10). They scan tool descriptions *and* schema-level descriptions:

| Rule | Catches |
|---|---|
| CAS-L001 | instruction-override phrasing ("ignore previous instructions…") |
| CAS-L002 | hidden-instruction markers (`<IMPORTANT>`, `<system>`, HTML comments) |
| CAS-L003 | concealment directives ("do not tell the user…") |
| CAS-L004 | exfiltration-shaped directives (send/post/upload … to a URL) |
| CAS-L005 | references to sensitive local material (`~/.ssh`, `.env`, credentials) |
| CAS-L006 | invisible/steganographic Unicode (zero-width chars, Unicode tags) |
| CAS-L007 | large opaque base64-like blobs |
| CAS-L008 | oversized descriptions (context-window bloat) |

Heuristics, not proofs — treat findings as review triggers, and pair with a dedicated security scanner for depth.

## Cassette format (open, v1)

Append-only JSONL. Line 1 is a header; each following line is one captured frame with direction and a millisecond offset:

```jsonl
{"type":"header","cassetteVersion":1,"recorder":"mcp-cassette@0.1.0","startedAt":"...","transport":"stdio","command":["npx","-y","..."],"redaction":{"applied":true}}
{"type":"frame","t":12,"dir":"c2s","frame":{"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}}
{"type":"frame","t":38,"dir":"s2c","frame":{"jsonrpc":"2.0","id":1,"result":{...}}}
```

Non-JSON-RPC lines (servers that log to stdout) are preserved as `{"type":"raw",...}` — a cassette is a faithful transcript even of misbehaving servers. The format is stable and documented so other tools can consume it.

## Secrets redaction

A cassette is only useful if you can commit it, and you can only commit it if it has no credentials in it. **`record` redacts by default.** Every string in every captured frame — plus the server command in the header, where tokens often arrive as CLI flags — is scanned on the way to disk. The bytes forwarded to your client and to the real server are untouched, so the live session behaves exactly as if the proxy weren't there.

Each hit becomes a placeholder:

```
[REDACTED:<rule>:<hash8>]        e.g. [REDACTED:github:3f9a1c07]
```

`hash8` is the first 8 hex characters of the SHA-256 of the secret. It is deterministic, and that's what keeps replay working: when your test sends the live token, `replay` redacts the incoming request the same way before matching, so it collapses to the same placeholder that was recorded and hits the same response. Two different secrets stay distinguishable; the same secret is recognizable across recordings.

| Rule | Catches |
|---|---|
| `bearer` | `Bearer <token>` (the word `Bearer` is kept) |
| `urlcreds` | the password in `scheme://user:password@host` — any scheme, so `postgres://`, `redis://`, `mongodb://`, `mysql://` and `amqp://` connection strings are covered. Scheme, username, host and path are kept |
| `jwt` | three-part `eyJ…` base64url tokens |
| `github` | `ghp_` `gho_` `ghu_` `ghs_` `ghr_` `github_pat_` |
| `openai` | `sk-…` |
| `anthropic` | `sk-ant-…` |
| `slack` | `xoxb-` `xoxa-` `xoxp-` `xoxr-` `xoxs-` |
| `aws` | `AKIA…` access key ids |
| `google` | `AIza…` API keys |
| `keyctx` | any JSON string value (≥ 8 chars) under a key matching `token`, `secret`, `password`, `passwd`, `api_key`/`apiKey`, `authorization`, `credential` — whatever its shape |

Lines the recorder cannot parse as a JSON-RPC frame — a batch array, a frame missing `"jsonrpc":"2.0"`, a server that logs to stdout — are stored as `raw` entries and redacted too. If such a line is itself JSON it gets the full key-context walk, with only the secret substrings replaced so the rest of the line keeps its exact bytes. If it is not JSON at all, only the shape rules apply: there are no keys, so there is no key context to use.

### What gets over-redacted, and why we err this way

The key list is matched as a substring and deliberately not anchored, so it still catches `accessToken` and `apiToken` alongside `access_token`. The cost is collateral: a field like `password_policy` or `secretariat` is redacted because its name contains a sensitive word, even though its value is harmless. That is the trade we want — anchoring the match would swap a visible false positive for a silent missed secret, and a redaction placeholder where you expected prose is obvious, while a leaked credential is not.

The one exception is OAuth/OIDC discovery metadata (RFC 8414), where `token_endpoint` and `authorization_endpoint` hold public URLs that servers legitimately return. Those keep their value when it is a plain absolute `http(s)` URL with no query string and no `user:password`. A discovery field holding anything else — a token, a URL with a query string, a URL with credentials in it — is still redacted.

### Working with existing cassettes

```bash
mcp-cassette redact session.cassette.jsonl -o session.redacted.jsonl   # clean a recording
mcp-cassette redact session.cassette.jsonl --scan                      # audit only — exit 1 if anything is found
```

`--scan` writes nothing and prints one line per hit (rule, direction, method, path, masked excerpt), so it drops straight into CI as a tripwire on committed fixtures:

```
[keyctx] c2s tools/call params.arguments.token: ghp_**************** (39 chars)
[github] s2c tools/call result.content[0].text: ghp_**************** (39 chars)
result: FOUND (2 secret(s) detected)
```

Redaction is idempotent — running it over an already-redacted cassette is a no-op — so re-recording and re-cleaning are both safe.

### Turning it off

```bash
mcp-cassette record --no-redact -o session.cassette.jsonl -- npx -y my-server
```

The header records which way it went (`"redaction":{"applied":false}`), and `replay` reads that flag to decide whether to redact incoming requests. Don't commit an unredacted cassette.

### The caveat

The hash is not a security boundary. It is an unsalted, truncated SHA-256 of the plaintext, sitting in a file you are about to commit — for a high-entropy API token that reveals nothing useful, but for a short or human-chosen value it is a verification oracle: anyone with a candidate guess can confirm it offline. Redaction removes the secret; it does not make a weak secret safe to have referenced. Rotate anything a cassette ever touched.

**This is pattern matching, and pattern matching cannot catch every secret.** A credential with no recognizable prefix, under a field name nobody would call a token — a session cookie in `params.state`, a signed URL, a customer record, a private key pasted into a prompt — goes through untouched. Redaction lowers the odds of an accident; it is not a guarantee, and it is not a substitute for reviewing a cassette before you commit it or for running a real secret scanner over your repo. Treat `--scan` as a tripwire, not a clearance.

## How this relates to other tools

- **[`@modelcontextprotocol/conformance`](https://github.com/modelcontextprotocol/conformance)** — the official spec-conformance suite. Use it to verify you implement the protocol correctly; use mcp-cassette to test *your* server's behavior and contract. Complementary — we intend to contribute scenarios upstream.
- **MCP Inspector / MCPJam** — interactive debugging. mcp-cassette is headless and CI-first.
- **Security scanners (mcp-scan/agent-scan, Cisco mcp-scanner)** — deep security analysis. Our lint is a fast CI tripwire, not a replacement.

## Roadmap

Streamable HTTP record/replay · configurable redaction rules · `vitest`/`jest` + `pytest` adapters · GitHub Action · smarter replay matching (custom matchers, volatile-field config) · server-initiated flows (tasks/MRTR) · contributed scenarios for the official conformance suite. Issues and PRs welcome.

## License

Apache-2.0
