[![CI](https://github.com/ivermin1123/mcp-cassette/actions/workflows/ci.yml/badge.svg)](https://github.com/ivermin1123/mcp-cassette/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/mcp-cassette.svg)](https://www.npmjs.com/package/mcp-cassette)

![Terminal demo: check a live MCP server, record a session, replay it offline, then fail on breaking contract changes](.github/demo.gif)

# mcp-cassette

**The cassette is itself an MCP server, so any client in any language connects to it exactly as it connects to the live one: no library to import, no product code to change, no transport to wrap.**

Record one session against a real [Model Context Protocol](https://modelcontextprotocol.io) server, then run your agent tests against the recording: no credentials, no rate limits, no network. The same binary gates your tool contract against breaking changes and lints tool descriptions for poisoning.

```bash
npx mcp-cassette check --stdio "npx -y @modelcontextprotocol/server-everything stdio"
```

```
server: mcp-servers/everything@2.0.0  protocol: 2025-06-18
surface: 13 tools, 7 resources, 4 prompts

[OK] no findings

result: PASS (0 error(s), 0 warning(s))
```

```
┌────────┐   record    ┌──────────────┐   real    ┌────────────┐
│ client │ ──────────► │ mcp-cassette │ ────────► │ MCP server │
└────────┘             │    (proxy)   │           └────────────┘
                       └──────┬───────┘
                              ▼
                    session.cassette.jsonl
                              │
┌────────┐   replay           ▼
│   CI   │ ◄────────── deterministic mock: the real server never runs
└────────┘
```

## What it does, and the command that does it

Each block below is a command and the output it printed. Nothing here is a claim you cannot reproduce.

**Your tests run offline, against the recording.** `check` is an ordinary MCP client and cannot tell a cassette from a live server, which is the point: whatever your client is, it connects the same way.

```bash
mcp-cassette check --stdio "mcp-cassette replay session.cassette.jsonl"
```

```
server: tiny-server@1.0.0  protocol: 2025-06-18
surface: 3 tools

[OK] no findings

result: PASS (0 error(s), 0 warning(s))
```

**A breaking contract change fails the build.**

```bash
mcp-cassette snapshot --check --stdio "node dist/my-server.js"
```

```
[BREAKING] slugify: tool removed (tool-removed)
[BREAKING] add: parameter "precision" is now required (input-property-became-required)
[DANGEROUS] add: parameter "mode" added (input-property-added-optional)
result: FAIL (2 breaking, 1 dangerous, 0 minor, 0 info; gate: breaking)
```

**A poisoned tool description is a finding, not a surprise.** Prompt injection does not need a user to type it; it arrives in the tool description your agent was never going to show anyone. Sixteen rules, each citing the OWASP MCP Top 10 risk and SAFE-MCP technique it implements.

```bash
mcp-cassette check --stdio "node dist/my-server.js" --format sarif --sarif-location mcp-contract.snapshot.json > mcp-cassette.sarif
```

Findings land in GitHub's Security tab, anchored to the line of the tool they describe. What each command does not cover is written down too: see [Where this stops](#where-this-stops) and [What a cassette is not](#what-a-cassette-is-not).

## Quickstart

```bash
npm install -g mcp-cassette   # or: npx mcp-cassette ...
```

**1. Health-check any server.** The command at the top of this page, against any server you can start.

**2. Record a session.** Put the proxy between your client and the server:

```bash
# wherever your client config points at the server command, wrap it:
mcp-cassette record -o session.cassette.jsonl -- npx -y @modelcontextprotocol/server-github
```

**3. Replay it offline.** The cassette *is* the server now:

```bash
mcp-cassette check --stdio "mcp-cassette replay session.cassette.jsonl"
# → identical results, no network, no tokens, deterministic
```

**4. Lock the contract**

```bash
mcp-cassette snapshot --stdio "npx -y my-server"            # writes mcp-contract.snapshot.json
mcp-cassette snapshot --check --stdio "npx -y my-server"    # CI: fails on breaking changes
```

The failing output is at the top of this page. Every finding carries a stable rule ID in parentheses. Match on those, not on the wording: the prose can be reworded in a patch release, the IDs cannot.

## CI in three lines

```yaml
- uses: ivermin1123/mcp-cassette@v0.4
  with:
    server-command: node dist/my-server.js
```

That runs the safety check *and* the contract gate against the snapshot you committed, then leaves one comment on the pull request with the classified diff, updated in place on every push rather than appended.

<details>
<summary>Full workflow</summary>

```yaml
name: MCP contract

on: pull_request

permissions:
  contents: read
  pull-requests: write   # the results comment

jobs:
  contract:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: '22.x'
      - run: npm ci && npm run build      # your server must exist before it can be started

      - uses: ivermin1123/mcp-cassette@v0.4
        with:
          server-command: node dist/my-server.js
          snapshot-file: mcp-contract.snapshot.json
          mode: both            # check | snapshot | both
          fail-on: breaking     # or: dangerous
          comment: 'true'

      # Agent integration tests, offline, against a recorded cassette:
      # point your MCP client at `mcp-cassette replay fixtures/session.cassette.jsonl`
      - run: npx vitest run
```

| Input | Default | What it does |
|---|---|---|
| `server-command` | *(required)* | Command that starts your MCP server on stdio. |
| `snapshot-file` | `mcp-contract.snapshot.json` | The committed contract to diff against. Create it once with `mcp-cassette snapshot` and commit it. |
| `mode` | `both` | `check` (health + safety lint), `snapshot` (contract drift), or `both`. |
| `fail-on` | `breaking` | Lowest tier that fails the job. `dangerous` also gates enum widening, default-value drift and added optional parameters. |
| `comment` | `true` | Post and afterwards update one results comment. Ignored outside pull requests. |
| `version` | pinned | Version of `mcp-cassette` to run from npm. |
| `github-token` | `${{ github.token }}` | Needs `pull-requests: write` to comment. A fork's read-only token makes the action warn, not fail. |

A pull request from a fork gets a read-only `GITHUB_TOKEN`, so the comment is skipped there with a warning; the gate itself still runs and still blocks.

</details>

### Which tag to pin

`uses:` resolves a git tag, not a version range, so the tag you name decides how much change arrives without you asking. Three of them are published, and they promise different things:

| Pin | Follows | Use it when |
|---|---|---|
| `@v0.4` | patches within 0.4 only: `0.4.1`, `0.4.2`, and so on | **Recommended.** Bug fixes and new rules that were already `warn` reach you; a minor with a breaking change does not. |
| `@v0` | every `0.x` release, **breaking minors included** | You want each release as it lands and have decided that a gate turning red on an unchanged server is acceptable. |
| `@v0.4.0` | nothing; an immutable tag | You need the gate frozen: reproducing an old run, or holding a release while you work through findings. |

While the major version is `0`, a minor release may carry a breaking change, and [semver](https://semver.org/spec/v2.0.0.html#spec-item-4) permits it and this project uses it. That is the whole difference between `@v0` and a minor pin. Twice now a minor has done it: `0.3.0` added eight safety-lint rules, three at `error`, and `0.4.0` made `snapshot --check` walk nested schemas, which reports breaking changes that were previously hidden. Both reached `@v0` users who had changed nothing on their side. A minor pin holds them back until you move it.

The two floating tags are force-moved onto each release commit, and only after npm and the GitHub Release have both succeeded, so neither can point at a version that failed to ship. Because they move, a checkout's local copy goes stale silently, and `git ls-remote --tags origin` is the only honest answer to "where does `@v0.4` point right now".

**Do not use `@main`.** It is a development branch, not a release channel: its `action.yml` names the version *being prepared*, which may not be on npm yet, and a workflow pointed at it fails with `ETARGET` for reasons that have nothing to do with your server.

Prefer plain commands? They are the same gate:

```yaml
- run: |
    npx mcp-cassette check    --stdio "node dist/my-server.js"
    npx mcp-cassette snapshot --check --fail-on dangerous --stdio "node dist/my-server.js"
```

## Testing with vitest

`mcp-cassette/vitest` puts a replay server around a `describe` block, so a suite that talks to an MCP server keeps working with no server and no network.

```ts
import { describe, expect, it } from "vitest";
import { useCassette } from "mcp-cassette/vitest";

const call = (id: number, name: string, args: unknown) =>
  ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("recorded call", () => {
  const tape = useCassette("tests/cassettes/weather.http.jsonl");

  it("is answered from the cassette", async () => {
    const res = await post(tape.url, call(1, "echo", { m: "recorded" }));
    expect(await res.json()).toMatchObject({ result: { content: [{ text: "recorded" }] } });
  });
});
```

`useCassette` registers `beforeAll` / `afterEach` / `afterAll` itself, so call it at describe scope, not inside a test.

**A miss fails the test that caused it.** The replay engine answers a miss with a JSON-RPC error, which a test would happily swallow, so the adapter drains the misses after every test and throws:

```ts
it("fails with a mismatch when the arguments drifted", async () => {
  await post(tape.url, call(2, "echo", { m: "drifted" }));
  // No assertion here on purpose: afterEach is what fails this test.
});
```

```
CassetteMismatchError: mcp-cassette: no recorded answer for "tools/call", method and tool
match a recording, but arguments differ at: /m (recorded "recorded", got "drifted").
Re-record the cassette or adjust the interaction.
```

Two classes, because there are two fixes. `CassetteMissError` means nothing in the cassette answered; `CassetteMismatchError` means a recording matched the method and tool and diverged, and carries `.changes`, the actual diff, so an assertion can read it instead of the message. Both extend `ReplayError`. `useCassette(file, { onMiss: "warn" })` leaves the JSON-RPC error frame as the only signal.

**HTTP and stdio are not symmetric, and this does not pretend otherwise.** An HTTP cassette is served in-process, so its whole lifecycle is real. A stdio replay owns `process.stdin` and `process.stdout` and would fight vitest for them, so a stdio cassette hands back `tape.command`, the argv for your client to spawn:

```ts
const tape = useCassette("tests/cassettes/tools.jsonl"); // transport: stdio
// tape.command -> [node, <mcp-cassette cli>, "replay", <cassette>]
```

A process spawned by the client is a process the adapter does not own, so misses on that path arrive only as the JSON-RPC error the client receives: `onMiss` cannot fail the test for you, and there is nothing to drain. HTTP cassettes do not have this limitation.

`vitest` is an optional peer dependency, so it stays out of the dependency graph of anyone not using the adapter, and the CLI's three runtime dependencies are unchanged.

## Commands

| Command | What it does |
|---|---|
| `record -o <file> [--no-redact] [--mode once\|all] [--http <url> [--listen <host:port>]] -- <server cmd>` | Transparent stdio proxy; captures every JSON-RPC frame (both directions) into an open JSONL cassette. Bytes are forwarded verbatim, so recording is invisible to both sides. Secrets are [redacted](#secrets-redaction) before they hit the file. `--mode once` (default) refuses to overwrite an existing cassette; `--mode all` always re-records. With `--http <url>` it records a **Streamable HTTP** session instead: a reverse proxy on `127.0.0.1:6402` (override with `--listen`) forwards every request to the upstream verbatim and relays the answer back streaming, capturing frames on the way through. Streamed (SSE) answers are captured as `chunks` entries, whole. Header *values* are never written (the cassette records that the server minted a session, never which one), and the lifecycle era is decided by the first *successful* exchange, so a dual-era client's failed probe is recorded honestly without deciding it. |
| `replay <file> [--listen <host:port>] [--timing none\|recorded] [--on-miss error\|warn\|passthrough [-- <server cmd>]]` | Serves the cassette as a deterministic MCP server: on stdio by default, or over Streamable HTTP with `--listen` (HTTP cassettes only; a stdio cassette is refused loudly). Requests are matched by method + arguments (volatile `_meta` ignored), so one cassette serves either lifecycle era; repeated identical calls replay in recorded order; unrecorded `ping` is synthesized. A true miss comes with near-miss diagnostics (closest recorded fingerprint + exactly which component diverged) and follows `--on-miss`: **error** (default) answers with a JSON-RPC error and exits 1 at session end; **warn** answers the same but exits 0; **passthrough** forwards the miss to the real server after `--` and appends the new interaction to the cassette tagged `origin:"live"`, over HTTP too, where a streamed live answer is appended as a `chunks` entry and relayed to the client still streaming. Over HTTP the era comes from the cassette header and is never guessed: the recorded status is reproduced (including a non-default one like `400`), notifications get `202`, a legacy `sessioned` cassette mints a **fresh** session id per run and answers `DELETE`, and everything the era forbids answers `405` with `Allow`. A recorded streamed (SSE) answer is replayed as SSE, one `data:` line per frame, closing after the final one, and a recorded legacy standalone `GET` stream is served and held open; `--timing recorded` spaces the frames by their recorded offsets instead of emitting them back to back. Replay is a test double, not a conformance checker: a missing session id or a mismatched `Mcp-Method`/`MCP-Protocol-Version` is a warning on stderr, never a `400`. |
| `verify <file> [--ignore <ptr>]* [--allow-changed-paths <ptr>]* -- <server cmd>` | Re-fires the recorded requests (in order, lifecycle excluded) at a live server and diffs each response against the recording. Volatile fields (`_meta`, `ttlMs`, timestamp/UUID-shaped values) are ignored by default; add project-specific JSON Pointers with `--ignore`. Each pair is classified **MATCH** / **CHANGED** (with concrete paths) / **ERROR-SHAPE-CHANGED** (result↔error flip) / **MISSING** (no answer). Exit 1 on any non-match, unless every changed path falls under `--allow-changed-paths`; the explicit waive-everything switch is `--allow-all-changes` (an empty `--allow-changed-paths ""` is rejected, so an unset shell variable can't open that valve by accident). ⚠️ The recorded calls **execute for real** on the live server, so don't point `verify` at tools with side effects you can't repeat. Cassettes recorded with redaction (the default) re-fire placeholder credentials, so auth-bearing calls will report drift; the report says so in its header and suggests `--ignore` or a separate `--no-redact` recording. |
| `check [--stdio "cmd" \| --url <url>] [--json]` | Lifecycle handshake, `tools/resources/prompts` listing, JSON Schema validation (ajv; draft-07 + 2020-12 by declared dialect), duplicate/name/description checks, and the safety lint below. Exit 1 on errors. |
| `snapshot [--check] [--update] [--fail-on tier] [--json] [-f file]` | Canonical contract snapshot (tools + schemas + annotations). `--check` classifies drift into four tiers (below) and exits 1 at `--fail-on` (default `breaking`). `--json` emits the whole diff, rule IDs included, for tooling. |
| `lint <cassette>` | Checks a cassette's header against its own frames: an era that claims `modern` while recording an `initialize` handshake, sessions or a standalone `GET` stream the modern era removed, a `stdio` header carrying a URL or a streamed answer, an `http` header carrying a spawn command. Exits 1 on any inconsistency. A cassette is an open text format, so it gets hand-edited; this is where that shows up instead of at replay time. |
| `redact <cassette> -o <out> \| --scan` | Redact an existing cassette, or audit one in place. `--scan` writes nothing and exits 1 if it finds anything. |

### Contract drift tiers

`breaking` and `minor` are the obvious ends. The interesting tier is the middle one, borrowed from GraphQL-Inspector's trichotomy: changes that keep every existing call valid and still change what a caller observes.

| Tier | Rule IDs | Why here |
|---|---|---|
| **breaking** | `tool-removed`, `input-property-removed`, `input-property-became-required`, `input-property-added-required`, `input-property-type-changed`, `input-schema-type-changed`, `input-enum-value-removed`, `input-schema-replaced`, `input-schema-changed-unclassified` | A call that used to work now fails. |
| **dangerous** | `input-enum-value-added`, `input-property-default-changed`, `input-property-added-optional` | Everything still validates. An agent that switch-cases over the enum meets a value it has no branch for; a caller that relied on a default silently gets a different one; a newly-added optional parameter is a surface nothing was tested against. |
| **minor** | `tool-added`, `input-property-became-optional` | Strictly additive or strictly relaxing. |
| **info** | `tool-description-changed`, `tool-annotations-changed`, `input-annotation-changed` | Prose and hints. Worth reading, because a description is [attack surface](#safety-lint-rules), but never a gate. Rewording a parameter's `description` is a typo fix, not a contract change. |

`dangerous` is reported always and gated only with `--fail-on dangerous`, so upgrading does not turn anyone's CI red on its own.

Two rules exist to say "I do not know", and both count as breaking, because an unknown change to a contract is not evidence of safety:

| Rule | When |
|---|---|
| `input-schema-changed-unclassified` | the schema changed in a way no rule above recognises |
| `input-schema-ref-unclassified` | the schema changed and uses `$ref`. Reference resolution is not implemented, so the diff will not emit a precise rule ID about a shape it never inspected. |

They are separate ids on purpose: "we could not classify this" and "we could not follow this" are different problems, and a CI policy may reasonably treat them differently.

### Where this stops

**`snapshot --check` is finished, not in progress.** It gates one server against one committed file and classifies the diff into the tiers above. That is the whole intended scope. Bugs in what exists still get fixed; no further rule families are planned.

Stated as a boundary rather than left for you to find by hitting it:

| Covered | Not covered |
|---|---|
| Recursion into nested schemas, at any depth | `anyOf` / `oneOf` / `allOf` composition |
| Stable rule IDs, and the four tiers above | Constraint direction: `minimum`/`maximum`, `minLength`/`maxLength`, `pattern`, `format` |
| A CI gate with a configurable `--fail-on` | `outputSchema` |
| A conservative guard that reports rather than guesses when it meets an unresolved `$ref` | Resolving `$ref` / `$defs` to compare what they point at |

A change in the right-hand column is not missed silently. It surfaces as `input-schema-changed-unclassified` or `input-schema-ref-unclassified`, both of which count as breaking, so an unclassifiable change fails the gate instead of passing it.

The reason is worth stating plainly rather than leaving you to discover it: **[`@kryptosai/mcp-observatory`](https://github.com/KryptosAI/mcp-observatory) already covers this ground, and covers more of it.** It is MIT, five months older, and its `lock create` / `lock verify` pair is the same one-command-against-one-committed-file workflow, with `test` and `diff --fail-on-schema-drift` alongside. Installed clean and run against three deliberately planted changes, it caught all three at sensible severities and gated correctly. If contract drift is your main problem, look there first. You will get more of it, maintained by people who are treating it as the product rather than as one command among several.

What remains true here: the tier vocabulary and stable rule ids above are a gate policy you can write CI rules against, and they sit next to `record`/`replay` and the [safety lint](#safety-lint-rules) in one binary. That is the reason to use this one, and it is a narrower reason than "it is the best contract differ".

The measurements behind this decision, including where they contradict claims made earlier in this project's own planning, are in [`docs/research/01-reality-check.md`](docs/research/01-reality-check.md). One caveat from that document belongs here too: the comparison established that mcp-observatory does the same job, not that its output is better or worse. Nobody diffed the two tools' findings against each other.

### Safety lint rules

Heuristics distilled from tool-poisoning research and the MCP security literature (SAFE-MCP, OWASP Agentic Top 10). They scan tool descriptions *and* schema-level descriptions:

Each rule cites the [OWASP MCP Top 10](https://owasp.org/www-project-mcp-top-10/) risk and the [SAFE-MCP](https://github.com/fkautz/safe-mcp) technique it implements, and both travel with the finding in `--json`.

The **evidence** column is the one to read first. It says whether text alone can tell an attack from a legitimate tool:

- **shape**: it can. The finding *is* the attack, and a legitimate tool produces none. A rule here that fires on ordinary Arabic or Chinese prose is broken, not strict.
- **intent**: it cannot. The finding is *true* (this tool really does describe running a shell command) but only you know whether that is meant to be there. A terminal server is not lying. These are always `warn`, and they say what was declared instead of accusing.

| Rule | Catches | Evidence | Sev | OWASP | SAFE-MCP |
|---|---|---|---|---|---|
| CAS-L001 | instruction-override phrasing ("ignore previous instructions...") | shape | error | MCP06 | T1102 |
| CAS-L002 | hidden-instruction markers (`<IMPORTANT>`, `<system>`, HTML comments) | shape | error | MCP03 | T1001 |
| CAS-L003 | concealment directives ("do not tell the user...") | shape | error | MCP03 | T1001 |
| CAS-L004 | exfiltration-shaped directives (send/post/upload ... to a URL) | shape | error | MCP10 | T1910 |
| CAS-L005 | references to sensitive local material (`~/.ssh`, `.env`, credentials) | shape | error | MCP01 | T1001 |
| CAS-L006 | invisible/steganographic Unicode (zero-width chars, Unicode tags) | shape | error | MCP03 | T1402 |
| CAS-L007 | large opaque base64-like blobs | shape | warn | MCP03 | T1402 |
| CAS-L008 | oversized descriptions (context-window bloat) | shape | warn | MCP10 | n/a |
| CAS-L009 | bidi override or unbalanced embedding (Trojan Source) | shape | error | MCP03 | T1402 |
| CAS-L010 | variation selectors used as a data channel | shape | error | MCP03 | T1402 |
| CAS-L011 | declared priority over another tool | intent | warn | MCP02, MCP06 | T1301 |
| CAS-L012 | declared command execution | intent | warn | MCP05 | T1102 |
| CAS-L013 | role or authority impersonation aimed at the model | shape | error | MCP06 | T1102 |
| CAS-L014 | asks for a credential in its input | intent | warn | MCP01, MCP07 | T1001 |
| CAS-L015 | mixed-script word (homoglyph obfuscation) | shape | warn | MCP03 | T1405 |
| CAS-L016 | declared fetch from an unpinned remote source | intent | warn | MCP04 | T1201 |

They scan the tool's `description` and `title`, its `annotations`, and, because an attacker writes the whole schema rather than just its prose ([SAFE-T1501](https://github.com/fkautz/safe-mcp), full-schema poisoning), every `description`, `title`, `default`, `const`, `enum` and `examples` string at any depth of the input schema.

`check` fails on error-level findings only. `check --fail-on warn` opts into the stricter gate, the same way `snapshot --fail-on` works.

Heuristics, not proofs: treat findings as review triggers, and pair with a dedicated security scanner for depth.

Every pattern in the rule set is proven free of super-linear backtracking by [recheck](https://github.com/makenowjust/recheck) in CI, because lint input is text an attacker wrote.

### SARIF output

`check --format sarif` emits SARIF 2.1.0, so findings land in GitHub's Security tab instead of a log nobody opens. The rule ids are the same `CAS-Lxxx` you see in the terminal, and each rule carries its OWASP and SAFE-MCP ids as tags:

```json
{
  "ruleId": "CAS-L001",
  "level": "error",
  "message": { "text": "instruction-override phrasing (classic prompt-injection) (in description): ..." },
  "partialFingerprints": { "mcpCassetteFindingV1": "86f30c3c29712ff6" },
  "locations": [
    {
      "physicalLocation": {
        "artifactLocation": { "uri": "mcp-contract.snapshot.json" },
        "region": { "startLine": 58 }
      },
      "logicalLocations": [{ "fullyQualifiedName": "get_weather", "kind": "member" }]
    }
  ]
}
```

This is the wiring, copied from [the job that runs it in this repository](.github/workflows/foundation-canary.yml):

```yaml
permissions:
  contents: read
  security-events: write        # the only permission the upload needs

steps:
  - name: Scan the poisoned fixture
    continue-on-error: true     # let the upload happen even when the gate fails
    run: |
      node dist/cli.js check \
        --stdio "env TINY_EVIL=1 node tests/fixtures/tiny-server.mjs" \
        --format sarif \
        --sarif-location tests/fixtures/tiny-server-evil.snapshot.json > mcp-cassette.sarif

  - uses: github/codeql-action/upload-sarif@v3
    with:
      sarif_file: mcp-cassette.sarif
      category: mcp-cassette    # keeps these results in their own bucket
```

**Findings are anchored to a file, and that file has to be a real one.** `check` inspects a *live server*, so nothing it finds lives in a source file. GitHub code scanning nonetheless discards any result without a `physicalLocation`, so the anchor is the **contract snapshot**: your server's tool surface is recorded in that committed file, at a line, and it is where you go to read what your server advertises. `mcp-cassette` resolves one in this order, and never invents a path:

1. `--sarif-location <file>`, when you name it. A missing file, or one outside the working directory, is an error rather than a silent downgrade.
2. `mcp-contract.snapshot.json`, when it exists. Each tool gets its own line.
3. the server script from `--stdio`, when a token of it is a real file in the tree. Line 1, stated rather than guessed.
4. nothing, in which case the document is still emitted and still valid, and `check` warns on stderr that code scanning will drop every result.

`logicalLocations` is kept alongside, so consumers that read logical locations are unaffected.

`partialFingerprints` are built from the rule and the tool, never the excerpt, so rewording a description does not resurrect a triaged alert as a new one. One rule firing on two fields of the same tool therefore collapses to a single alert.

The output is validated against the official OASIS SARIF 2.1.0 schema in the test suite; that schema is vendored under `schemas/` (see `schemas/vendored.json` for source and version) so the suite stays offline, with a weekly canary warning if it drifts upstream.

> **Verified end to end against GitHub code scanning**, not just against the schema. [Run 31950265132](https://github.com/ivermin1123/mcp-cassette/actions/runs/31950265132) uploaded a document from the poisoned fixture; the analysis processed with no error and created six alerts, each one anchored to the line of the tool it describes (`get_weather` at line 58, `broken` at line 30). The API record for that analysis reads `results=6, error=""`.
>
> It has also been verified in the failing direction, which is why the anchor exists. The same job on an earlier PR, emitting `logicalLocations` only, uploaded successfully and then recorded `results=0` with `locationFromSarifResult: expected a physical location` once per finding, creating no alerts. An upload reporting success is not evidence that anything was kept.

That upload is not repeated on every pull request, and the reason is worth stating, because the snippet above is the right thing for *your* server and the wrong thing for this repository. The document above comes from a fixture that is poisoned on purpose, so uploading it per pull request would attach six alerts and a permanent red check to every branch this project ever opens; a check that is always red is one nobody reads by the second week, including the week it goes red for a real reason. Scanning a clean fixture instead would be worse, because an empty `results` array uploads perfectly happily, so the job would stay green through exactly the regression it exists to catch. The proof above was worth running once. What runs now is a split: [ci.yml](.github/workflows/ci.yml) asserts on every pull request that each finding is anchored to a real file at a real line, without uploading anything, and a weekly non-blocking job in [foundation-canary.yml](.github/workflows/foundation-canary.yml) does the real upload and asks the API what survived, parking its alerts on a `ci/sarif-canary` branch so they touch neither main nor any pull request.

## Cassette format (open, v2)

Append-only JSONL. Line 1 is a header; each following line is one captured frame with direction and a millisecond offset:

```jsonl
{"type":"header","cassetteVersion":2,"recorder":"mcp-cassette@0.3.0","startedAt":"...","transport":"stdio","command":["npx","-y","..."],"redaction":{"applied":true}}
{"type":"frame","t":12,"dir":"c2s","frame":{"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}}
{"type":"frame","t":38,"dir":"s2c","frame":{"jsonrpc":"2.0","id":1,"result":{...}}}
```

Non-JSON-RPC lines (servers that log to stdout) are preserved as `{"type":"raw",...}`, so a cassette is a faithful transcript even of misbehaving servers. Interactions appended later by `replay --on-miss passthrough` carry `"origin":"live"`. The format is stable and documented so other tools can consume it. v1 cassettes read forever; v2 adds optional fields for lifecycle eras, HTTP transport, and streamed (SSE) responses. See [docs/cassette-format-v2.md](docs/cassette-format-v2.md). Files from a newer format version are refused with a clear error rather than half-read.

## Secrets redaction

A cassette is only useful if you can commit it, and you can only commit it if it has no credentials in it. **`record` redacts by default.** Every string in every captured frame, plus the server command in the header where tokens often arrive as CLI flags, is scanned on the way to disk. The bytes forwarded to your client and to the real server are untouched, so the live session behaves exactly as if the proxy weren't there.

Each hit becomes a placeholder:

```
[REDACTED:<rule>:<hash8>]        e.g. [REDACTED:github:3f9a1c07]
```

`hash8` is the first 8 hex characters of the SHA-256 of the secret. It is deterministic, and that's what keeps replay working: when your test sends the live token, `replay` redacts the incoming request the same way before matching, so it collapses to the same placeholder that was recorded and hits the same response. Two different secrets stay distinguishable; the same secret is recognizable across recordings.

| Rule | Catches |
|---|---|
| `bearer` | `Bearer <token>` (the word `Bearer` is kept) |
| `urlcreds` | the password in `scheme://user:password@host`, any scheme, so `postgres://`, `redis://`, `mongodb://`, `mysql://` and `amqp://` connection strings are covered. Scheme, username, host and path are kept |
| `jwt` | three-part `eyJ...` base64url tokens |
| `github` | `ghp_` `gho_` `ghu_` `ghs_` `ghr_` `github_pat_` |
| `openai` | `sk-...` |
| `anthropic` | `sk-ant-...` |
| `slack` | `xoxb-` `xoxa-` `xoxp-` `xoxr-` `xoxs-` |
| `aws` | `AKIA...` access key ids |
| `google` | `AIza...` API keys |
| `keyctx` | any JSON string value (≥ 8 chars) under a key matching `token`, `secret`, `password`, `passwd`, `api_key`/`apiKey`, `authorization`, `credential`, whatever its shape |

Lines the recorder cannot parse as a JSON-RPC frame (a batch array, a frame missing `"jsonrpc":"2.0"`, a server that logs to stdout) are stored as `raw` entries and redacted too. If such a line is itself JSON it gets the full key-context walk, with only the secret substrings replaced so the rest of the line keeps its exact bytes. If it is not JSON at all, only the shape rules apply: there are no keys, so there is no key context to use.

### What gets over-redacted, and why we err this way

The key list is matched as a substring and deliberately not anchored, so it still catches `accessToken` and `apiToken` alongside `access_token`. The cost is collateral: a field like `password_policy` or `secretariat` is redacted because its name contains a sensitive word, even though its value is harmless. That is the trade we want: anchoring the match would swap a visible false positive for a silent missed secret, and a redaction placeholder where you expected prose is obvious, while a leaked credential is not.

The one exception is OAuth/OIDC discovery metadata (RFC 8414), where `token_endpoint` and `authorization_endpoint` hold public URLs that servers legitimately return. Those keep their value when it is a plain absolute `http(s)` URL with no query string and no `user:password`. A discovery field holding anything else (a token, a URL with a query string, a URL with credentials in it) is still redacted.

### Working with existing cassettes

```bash
mcp-cassette redact session.cassette.jsonl -o session.redacted.jsonl   # clean a recording
mcp-cassette redact session.cassette.jsonl --scan                      # audit only, exit 1 if anything is found
```

`--scan` writes nothing and prints one line per hit (rule, direction, method, path, masked excerpt), so it drops straight into CI as a tripwire on committed fixtures:

```
[keyctx] c2s tools/call params.arguments.token: ghp_**************** (39 chars)
[github] s2c tools/call result.content[0].text: ghp_**************** (39 chars)
result: FOUND (2 secret(s) detected)
```

Redaction is idempotent (running it over an already-redacted cassette is a no-op) so re-recording and re-cleaning are both safe.

### Turning it off

```bash
mcp-cassette record --no-redact -o session.cassette.jsonl -- npx -y my-server
```

The header records which way it went (`"redaction":{"applied":false}`), and `replay` reads that flag to decide whether to redact incoming requests. Don't commit an unredacted cassette.

### The caveat

The hash is not a security boundary. It is an unsalted, truncated SHA-256 of the plaintext, sitting in a file you are about to commit. For a high-entropy API token that reveals nothing useful, but for a short or human-chosen value it is a verification oracle: anyone with a candidate guess can confirm it offline. Redaction removes the secret; it does not make a weak secret safe to have referenced. Rotate anything a cassette ever touched.

**This is pattern matching, and pattern matching cannot catch every secret.** A credential with no recognizable prefix, under a field name nobody would call a token, goes through untouched: a session cookie in `params.state`, a signed URL, a customer record, a private key pasted into a prompt. Redaction lowers the odds of an accident; it is not a guarantee, and it is not a substitute for reviewing a cassette before you commit it or for running a real secret scanner over your repo. Treat `--scan` as a tripwire, not a clearance.

## How this relates to other tools

- **[`@modelcontextprotocol/conformance`](https://github.com/modelcontextprotocol/conformance)**: the official spec-conformance suite. Use it to verify you implement the protocol correctly; use mcp-cassette to test *your* server's behavior and contract. The two are complementary, and we intend to contribute scenarios upstream.
- **MCP Inspector / MCPJam**: interactive debugging. mcp-cassette is headless and CI-first.
- **Security scanners (mcp-scan/agent-scan, Cisco mcp-scanner)**: deep security analysis. Our lint is a fast CI tripwire, not a replacement.

## Roadmap

Configurable redaction rules, a `jest` adapter, a GitHub Action, smarter replay matching (custom matchers, volatile-field config), server-initiated flows (tasks/MRTR), scenario `state`/`seq`, `Last-Event-ID` resumability, and contributed scenarios for the official conformance suite. Issues and PRs welcome.

A `pytest` adapter was on this list and is cancelled. A second, unrelated `mcp-cassette` has been on PyPI since 2026-07-25 and already ships a pytest plugin, so a `pytest-mcp-cassette` published beside it would read as that tool's adapter no matter what its README said. The measurement and the decision are in [`docs/research/02-name-collision.md`](docs/research/02-name-collision.md).

Changes that need an argument before they need code, meaning anything that could turn a passing gate red, are worked out in [BACKLOG.md](BACKLOG.md) first.

## What a cassette is not

A cassette pins **one recorded session** so it can be replayed exactly. That makes it a good regression fixture and a good way to keep CI offline, and a poor instrument for anything else. In particular it cannot compare models or servers: a replay answers from the recording, so every "result" it produces is the one already written in the file. Two runs against the same cassette agree because they read the same bytes, not because anything was verified. To find out whether a live server still behaves the way it did, use `verify`; it re-fires the recorded requests at the real thing and diffs the answers. To find out whether its contract changed, use `snapshot --check`.

## License

Apache-2.0
