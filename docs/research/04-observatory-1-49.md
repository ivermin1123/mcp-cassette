# mcp-observatory 1.49.0, read for the tool comparison

Measured 2026-10-08 against `@kryptosai/mcp-observatory@1.49.0` (published
2026-10-01), installed clean into a scratchpad outside this repository.
Re-verified 2026-10-10 on the same version with the commands below; nothing
changed.

This file exists so the mcp-observatory bullet in the README's
[How this relates to other tools](../../README.md#how-this-relates-to-other-tools)
has a source that is tracked. It records the facts that bullet rests on and
nothing else. It is a breadth reading of a neighbouring tool, not a comparison
of findings: [`01-reality-check.md`](01-reality-check.md) is where the two tools
were measured against each other, six minor versions earlier at 1.43.0.

---

## Method

```
npm install @kryptosai/mcp-observatory@1.49.0
```

Below, `$OBS` is `node_modules/@kryptosai/mcp-observatory` in that scratchpad,
and every command is run with `node $OBS/dist/src/cli.js`.

Command existence is read from the `Usage:` line a command's own `--help`
prints, not from the root `--help` list and not from the exit code. The root
list omits commands declared `{ hidden: true }`, which is the error
[`01-reality-check.md`](01-reality-check.md) §10 records and repairs. The exit
code is not a discriminator either: this CLI answers an unknown command with
exit 0 and the root help banner, checked here against
`definitely-not-a-command`. The per-command `Usage:` line is what separates a
real command from an unknown one, so that line is what the table records.

## The claims and what backs them

| Claim in the README | Command | What it answered |
|---|---|---|
| Reads the MCP configs of ten clients | `scan --help` | "Check all MCP servers in your agent configs (Claude, Cursor, Windsurf, VS Code, OpenCode, Codex, Gemini, Kiro, Antigravity, Amazon Q)." Ten named clients. |
| Audit profiles | `audit --help` | `--profile <profile>  Security profile to apply. (default: "nsa-mcp")` |
| Attack simulation | `attack-sim --help` | `Usage: mcp-observatory attack-sim [options] [command...]` |
| Cross-server toxic-flow analysis | `toxic-flow --help` | "Review possible cross-server capability combinations from saved run JSON" |
| Static source review | `source-audit --help` | `Usage: mcp-observatory source-audit [options] <path>` |
| Package-name checks | `package-check --help` | `Usage: mcp-observatory package-check [options] [command...]` |
| Signed trust receipts | `grep -n Ed25519 $OBS/dist/src/commands/receipt.js` | `:91` `--sign-key <path>` "Path to Ed25519 private key file (DER/PEM) to sign the receipt", `:142` a `keygen` that generates the pair |
| A wrapping proxy at runtime | `enforce --help`, `wrap --help` | `--start-proxy  Start mcp-seatbelt proxy after writing the policy`, and `Usage: mcp-observatory wrap [options]` |
| Scores, badges and tracks a fleet | `score --help`, `badge --help`, `history --help` | `Usage: mcp-observatory score [options] <command...>`, the same for `badge`, and `Usage: mcp-observatory history [options]` |

## What `record` and `replay` do there

```
$ grep -n 'hidden: true' $OBS/dist/src/commands/record-replay.js
19:        .command("record", { hidden: true })
56:        .command("replay", { hidden: true })
```

Both are real commands, omitted from the root `--help` list. `replay` builds a
transport over the recorded entries and runs observatory's own checks across
it, rather than serving the recording to a client:

```
$ grep -n 'runToolsCheck\|runPromptsCheck\|ReplayTransport' $OBS/dist/src/commands/record-replay.js
4:import { runPromptsCheck } from "../checks/prompts.js";
6:import { runToolsCheck } from "../checks/tools.js";
10:import { ReplayTransport } from "../transport/replay-transport.js";
70:        // Build a ReplayTransport and run checks against it
71:        const transport = new ReplayTransport(cassette.entries);
```

Nothing external connects to it, so a test suite cannot point its MCP client at
one. That is the same finding [`01-reality-check.md`](01-reality-check.md) §8
recorded at 1.43.0, re-read here at 1.49.0.

## The protocol era

The SDK observatory installs is `@modelcontextprotocol/sdk@1.32.1`:

```
$ grep -n "LATEST_PROTOCOL_VERSION = " node_modules/@modelcontextprotocol/sdk/dist/esm/types.js
2:export const LATEST_PROTOCOL_VERSION = '2025-11-25';

$ sed -n 3p node_modules/@modelcontextprotocol/sdk/README.md
> **This is v1.x of the MCP TypeScript SDK, the maintenance line.** It implements
the MCP spec up to 2025-11-25. Support for the [2026-07-28 spec](...) is not
planned for v1.x: it is in v2, the current stable release, which

$ grep -rl '2026-07-28' node_modules/@modelcontextprotocol/sdk/dist     # no matches
$ grep -rl '2026-07-28\|server/discover' $OBS/dist                      # no matches
```

The string `2026-07-28` does appear once in the install, in that SDK README
line, which is why the README sentence names the SDK version and what its
README says rather than claiming the string is absent everywhere.

## What this note does not establish

- **Whether a 2026-07-28 server actually breaks observatory.** The above is a
  source reading. No modern-only server was stood up and pointed at it.
- **Whose findings are better.** Nothing here was scored. The README says the
  same: none of it is a bake-off.
- **Anything about 1.43.0 to 1.49.0 drift output.** Granularity was measured at
  1.36.5 in August and not re-run.
