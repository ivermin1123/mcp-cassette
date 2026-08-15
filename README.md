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
| `record -o <file> -- <server cmd>` | Transparent stdio proxy; captures every JSON-RPC frame (both directions) into an open JSONL cassette. Bytes are forwarded verbatim — recording is invisible to both sides. |
| `replay <file>` | Serves the cassette as a stdio MCP server. Requests are matched by method + arguments (volatile `_meta` ignored); repeated identical calls replay in recorded order; unrecorded `ping` is synthesized; anything else gets a clear JSON-RPC error. |
| `check [--stdio "cmd" \| --url <url>] [--json]` | Lifecycle handshake, `tools/resources/prompts` listing, JSON Schema validation (ajv; draft-07 + 2020-12 by declared dialect), duplicate/name/description checks, and the safety lint below. Exit 1 on errors. |
| `snapshot [--check] [--update] [-f file]` | Canonical contract snapshot (tools + schemas + annotations). `--check` classifies drift: **breaking** (removed tool/param, new required param, type change, enum narrowed) / **minor** (additive) / **info** (descriptions). Exit 1 on breaking. |

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
{"type":"header","cassetteVersion":1,"recorder":"mcp-cassette@0.1.0","startedAt":"...","transport":"stdio","command":["npx","-y","..."]}
{"type":"frame","t":12,"dir":"c2s","frame":{"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}}
{"type":"frame","t":38,"dir":"s2c","frame":{"jsonrpc":"2.0","id":1,"result":{...}}}
```

Non-JSON-RPC lines (servers that log to stdout) are preserved as `{"type":"raw",...}` — a cassette is a faithful transcript even of misbehaving servers. The format is stable and documented so other tools can consume it.

## How this relates to other tools

- **[`@modelcontextprotocol/conformance`](https://github.com/modelcontextprotocol/conformance)** — the official spec-conformance suite. Use it to verify you implement the protocol correctly; use mcp-cassette to test *your* server's behavior and contract. Complementary — we intend to contribute scenarios upstream.
- **MCP Inspector / MCPJam** — interactive debugging. mcp-cassette is headless and CI-first.
- **Security scanners (mcp-scan/agent-scan, Cisco mcp-scanner)** — deep security analysis. Our lint is a fast CI tripwire, not a replacement.

## Roadmap

Streamable HTTP record/replay · cassette secret-redaction · `vitest`/`jest` + `pytest` adapters · GitHub Action · smarter replay matching (custom matchers, volatile-field config) · server-initiated flows (tasks/MRTR) · contributed scenarios for the official conformance suite. Issues and PRs welcome.

## License

Apache-2.0
