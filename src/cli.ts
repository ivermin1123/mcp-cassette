#!/usr/bin/env node
/**
 * mcp-cassette: record a real MCP session once, replay it forever.
 *
 *   record    transparent stdio proxy that captures a session into a cassette
 *   replay    serve a cassette as a deterministic mock MCP server
 *   verify    re-fire recorded requests at a live server, diff the responses
 *   check     health + safety check of a live server (CI exit codes)
 *   snapshot  contract snapshot & breaking-change detection
 *   lint      check a cassette's header against its own frames
 *   redact    redact (or audit) secrets in an existing cassette
 */

import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { runRecord, type RecordMode } from "./record.js";
import { DEFAULT_LISTEN, runHttpRecord } from "./proxy.js";
import { runReplay, type OnMissMode } from "./replay.js";
import { runHttpReplay } from "./http-replay.js";
import { printVerifyReport, verifyAgainstServer, verifyFailed } from "./verify.js";
import { runCheck, printReport } from "./check.js";
import { fileAnchor, snapshotAnchor, toSarif, type SarifAnchor } from "./sarif.js";
import { readCassette, writeCassette } from "./cassette.js";
import { checkRedactConfig, readRedactConfig, redactCassette, scanCassette } from "./redact.js";
import { lintCassette, lintCassetteOutput, type CassetteFinding, type OutputFinding } from "./lint.js";
import { VERSION } from "./version.js";
import {
  captureContract,
  countChanges,
  diffContracts,
  printChanges,
  readSnapshot,
  shouldFail,
  writeSnapshot,
  type FailOn,
} from "./snapshot.js";
import type { EraOption, Target } from "./client.js";

/** Split a command string honoring single/double quotes: `npx -y "my server"` */
export function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function resolveTarget(opts: { stdio?: string; url?: string }): { target: Target; label: string } {
  if (opts.stdio && opts.url) {
    throw new Error("use either --stdio or --url, not both");
  }
  if (opts.stdio) {
    return { target: { kind: "stdio", command: tokenize(opts.stdio) }, label: opts.stdio };
  }
  if (opts.url) {
    return { target: { kind: "http", url: opts.url }, label: opts.url };
  }
  throw new Error("missing target: pass --stdio \"<command>\" or --url <http-url>");
}

const ERA_HELP = "server lifecycle: legacy (initialize handshake) | modern (2026-07-28 stateless) | auto";

/** The file `snapshot` writes unless told otherwise; the usual anchor for SARIF. */
const DEFAULT_SNAPSHOT_FILE = "mcp-contract.snapshot.json";

/**
 * Find a real file to hang SARIF findings on, in descending order of honesty.
 *
 * GitHub code scanning discards any result without a physical location, so a
 * SARIF document with no anchor uploads successfully and produces no alerts.
 * That silence is the failure this resolution exists to prevent, and every
 * branch below either returns a path that exists or returns nothing at all.
 *
 *   1. `--sarif-location`, when the operator names the file themselves.
 *   2. the contract snapshot for this run, where each tool has its own line.
 *   3. the server script named by `--stdio`, when a token of it is a real file.
 *   4. nothing, and the caller says so loudly.
 */
function resolveSarifAnchor(opts: { sarifLocation?: string; stdio?: string }): SarifAnchor | undefined {
  const anchorFor = (file: string): SarifAnchor | undefined => {
    const uri = repoRelative(file);
    if (!uri) return undefined;
    const text = fs.readFileSync(file, "utf8");
    // Only a contract snapshot has tools to map; anything else is anchored whole.
    return text.includes('"mcpCassetteContract"') ? snapshotAnchor(uri, text) : fileAnchor(uri);
  };

  if (opts.sarifLocation) {
    // Named explicitly and unusable is an error, not a silent downgrade: the
    // operator asked for an anchor and would otherwise get no alerts at all.
    if (!fs.existsSync(opts.sarifLocation)) {
      throw new Error(`--sarif-location: ${opts.sarifLocation} does not exist`);
    }
    const anchor = anchorFor(opts.sarifLocation);
    if (!anchor) {
      throw new Error(`--sarif-location: ${opts.sarifLocation} is outside the working directory`);
    }
    return anchor;
  }
  if (fs.existsSync(DEFAULT_SNAPSHOT_FILE)) {
    const anchor = anchorFor(DEFAULT_SNAPSHOT_FILE);
    if (anchor) return anchor;
  }
  if (opts.stdio) {
    for (const token of tokenize(opts.stdio)) {
      if (!fs.existsSync(token) || !fs.statSync(token).isFile()) continue;
      const anchor = anchorFor(token);
      if (anchor) return anchor;
    }
  }
  return undefined;
}

/**
 * A SARIF uri code scanning can resolve, or nothing.
 *
 * Uris are interpreted against the repository root, so an absolute path means
 * nothing to GitHub and a `../` path points outside the checkout at a file the
 * Security tab cannot open. Both are worse than having no location: they look
 * like an anchor and are not one. A server script living outside the working
 * directory therefore yields no anchor, and the caller warns instead.
 */
function repoRelative(file: string): string | undefined {
  const rel = path.relative(process.cwd(), path.resolve(file));
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join("/");
}

const NO_ANCHOR_WARNING =
  "mcp-cassette check: no file to anchor SARIF findings to, so this document carries\n" +
  "  no physicalLocation. GitHub code scanning REJECTS such results with \"expected a\n" +
  "  physical location\" and creates no alerts, though the upload itself reports success.\n" +
  "  Fix: commit a contract snapshot (mcp-cassette snapshot), or pass\n" +
  "  --sarif-location <file> naming a file in the repository.\n";

function resolveEra(value: string): EraOption {
  if (value === "auto" || value === "legacy" || value === "modern") return value;
  throw new Error(`--era must be legacy | modern | auto (got "${value}")`);
}

const program = new Command();

program
  .name("mcp-cassette")
  .description(
    "A recorded MCP session that is itself an MCP server, so any client in any language " +
      "connects to it exactly as it connects to the live one: no library to import, " +
      "no product code to change, no transport to wrap."
  )
  .version(VERSION);

program
  .command("record")
  .description("Sit between your client and a live server, and write every message to a cassette file")
  .requiredOption("-o, --out <file>", "cassette output path, e.g. session.cassette.jsonl")
  .option("--no-redact", "record secrets verbatim instead of redacting them")
  .option("--redact-config <file>", "JSON file of extra redaction rules: { patterns: [{ name, regex }], keys: [...], allow: [...] }. The same file must be given to replay, because redaction runs before matching")
  .option("--mode <mode>", "once: refuse to overwrite an existing cassette; all: always re-record", "once")
  .option("--http <url>", "record a Streamable HTTP server, e.g. http://127.0.0.1:3000/mcp")
  .option("--listen <host:port>", "address the HTTP recording proxy binds, e.g. 127.0.0.1:6402", DEFAULT_LISTEN)
  .argument("[command...]", "server command (prefix with -- ); omit when using --http")
  .addHelpText(
    "after",
    "\nExample:\n" +
      "  mcp-cassette record -o session.cassette.jsonl -- npx -y @modelcontextprotocol/server-everything stdio\n"
  )
  .action(
    async (
      command: string[],
      opts: { out: string; redact: boolean; mode: string; http?: string; listen: string; redactConfig?: string }
    ) => {
      try {
        if (opts.mode !== "once" && opts.mode !== "all") {
          throw new Error(`record: unknown --mode "${opts.mode}" (expected once or all)`);
        }
        const mode = opts.mode as RecordMode;
        if (opts.redactConfig && !opts.redact) {
          throw new Error("record: --no-redact removes every rule, so --redact-config would do nothing. Drop one of the two");
        }
        const redactConfig = opts.redactConfig ? readRedactConfig(opts.redactConfig) : undefined;
        if (opts.http && command.length > 0) throw new Error("record: use either --http or a server command, not both");
        if (opts.http) {
          const httpCode = await runHttpRecord({
            out: opts.out,
            url: opts.http,
            listen: opts.listen,
            redact: opts.redact,
            mode,
            redactConfig,
          });
          process.exit(httpCode);
        }
        if (command.length === 0) {
          throw new Error("record: missing target. Pass a server command after -- , or --http <url>");
        }
        const code = await runRecord({ out: opts.out, command, redact: opts.redact, mode, redactConfig });
        process.exit(code);
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(1);
      }
    }
  );

/** Repeatable-option accumulator for commander. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

interface ReplayCliOptions {
  onMiss: string;
  listen?: string;
  timing: string;
  redactConfig?: string;
  /** Repeatable `--volatile`; commander hands back the accumulated list. */
  volatile: string[];
}

program
  .command("replay")
  .description("Serve a cassette as a real MCP server, so a client talks to it instead of the live one")
  .argument("<cassette>", "path to a .cassette.jsonl file, e.g. session.cassette.jsonl")
  .option("--listen <host:port>", `serve an HTTP cassette over Streamable HTTP, e.g. ${DEFAULT_LISTEN}`)
  .option("--timing <mode>", "streamed answers: none (default, emit back to back) or recorded (honor recorded offsets)", "none")
  .option(
    "--on-miss <mode>",
    "on fingerprint miss: error (fail the session), warn (answer with an error, exit 0), or passthrough (forward to the real server after -- and append the interaction)",
    "error"
  )
  .option("--redact-config <file>", "the redaction config the cassette was recorded with; replay refuses a cassette whose recorded config hash does not match")
  .option(
    "--volatile <pointer>",
    "a request field that changes every run, as a JSON Pointer into the request params (/arguments/requestedAt), optionally scoped to one method (tools/call:/arguments/requestedAt). Dropped before matching, on the recorded side too. Repeatable, and added to whatever the cassette header declares",
    collect,
    [] as string[]
  )
  .argument("[command...]", "real server command for --on-miss passthrough (prefix with -- )")
  .addHelpText(
    "after",
    "\nExamples:\n" +
      "  # point any MCP client at this command instead of the real server\n" +
      "  mcp-cassette replay session.cassette.jsonl\n\n" +
      "  # serve the same cassette over Streamable HTTP\n" +
      "  mcp-cassette replay session.cassette.jsonl --listen 127.0.0.1:6402\n\n" +
      "  # ignore a field that changes every run, on this tool call only\n" +
      "  mcp-cassette replay session.cassette.jsonl --volatile tools/call:/arguments/requestedAt\n"
  )
  .action(async (cassette: string, command: string[], opts: ReplayCliOptions) => {
    try {
      if (opts.onMiss !== "error" && opts.onMiss !== "warn" && opts.onMiss !== "passthrough") {
        throw new Error(`replay: unknown --on-miss "${opts.onMiss}" (expected error, warn, or passthrough)`);
      }
      if (opts.timing !== "none" && opts.timing !== "recorded") {
        throw new Error(`replay: unknown --timing "${opts.timing}" (expected none or recorded)`);
      }
      if (opts.listen !== undefined) {
        await runHttpReplay(cassette, {
          listen: opts.listen,
          onMiss: opts.onMiss,
          timing: opts.timing,
          serverCommand: command,
          volatile: opts.volatile,
          ...(opts.redactConfig ? { redactConfig: opts.redactConfig } : {}),
        });
        return;
      }
      // Pacing only means something for a streamed answer, and only HTTP serves those.
      if (opts.timing !== "none") {
        throw new Error("replay --timing applies to streamed answers, which only --listen serves. Add --listen or drop --timing");
      }
      await runReplay(cassette, {
        onMiss: opts.onMiss as OnMissMode,
        serverCommand: command,
        volatile: opts.volatile,
        ...(opts.redactConfig ? { redactConfig: opts.redactConfig } : {}),
      });
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(1);
    }
  });

program
  .command("lint")
  .description(
    "Check a cassette's header against its own frames, and scan what the recorded server returned for injection"
  )
  .argument("<cassette>", "path to a .cassette.jsonl file")
  .option("--json", "machine-readable findings")
  .addHelpText(
    "after",
    "\nExit 1 on a header that contradicts its own frames, which is what this always gated on.\n" +
      "Findings about recorded output, and about the header's newer fields, are reported at warn\n" +
      "and never change the exit code: returned text is data, and a cassette that passed keeps passing.\n" +
      "No --format sarif: SARIF here would have to invent a server, a tool count and a gate it was\n" +
      "decided against, none of which a cassette has. Use --json.\n"
  )
  .action((cassette: string, opts: { json?: boolean }) => {
    try {
      const tape = readCassette(cassette);
      const header = lintCassette(tape);
      const output = lintCassetteOutput(tape);
      // The exit code is the one this command always had: the header
      // contradicting its own frames. Nothing added here can turn a passing
      // cassette red.
      const errors = header.filter((f) => f.severity === "error");

      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ cassette, ok: errors.length === 0, header, output }, null, 2) + "\n"
        );
      } else {
        printCassetteLint(cassette, header, output, errors.length);
      }
      process.exitCode = errors.length > 0 ? 1 : 0;
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(1);
    }
  });

/**
 * The report, written so that a cassette with nothing new to say prints exactly
 * what it printed before this command learned to read output: one line per
 * header finding, then the verdict. The added sections appear only when they
 * have something in them.
 */
function printCassetteLint(
  cassette: string,
  header: CassetteFinding[],
  output: OutputFinding[],
  errors: number
): void {
  const line = (s: string) => process.stdout.write(s + "\n");
  // An error keeps the line it has always had. Everything added since is
  // marked, so a reader can tell at a glance which findings decided the exit
  // code and which are reports.
  for (const f of header) {
    line(f.severity === "error" ? `${f.rule}: ${f.message}` : `[WARN] ${f.rule}: ${f.message}`);
  }
  for (const f of output) {
    line(`[WARN] ${f.rule} ${f.method} #${f.requestId ?? "?"} ${f.path}: ${f.message}`);
    if (f.excerpt) line(`       evidence: "${f.excerpt}"`);
  }
  line(
    errors === 0
      ? `${cassette}: header and frames agree`
      : `${cassette}: ${errors} inconsistency(ies)`
  );
  const warnings = header.length - errors + output.length;
  if (warnings > 0) line(`${cassette}: ${warnings} warning(s) (reported, not gated)`);
}

program
  .command("verify")
  .description("Re-fire the recorded requests at a live server and diff its responses against the cassette")
  .argument("<cassette>", "path to a .cassette.jsonl file")
  .option("--ignore <json-pointer>", "also ignore this JSON Pointer in every response payload (repeatable)", collect, [])
  .option(
    "--allow-changed-paths <json-pointer>",
    "let a CHANGED pair pass when every changed path is at or under one of these pointers (repeatable)",
    collect,
    []
  )
  .option("--allow-all-changes", "let every CHANGED pair pass: the explicit waive-everything switch")
  .option("--url <url>", "verify against a Streamable HTTP server instead of a spawned command")
  .option("--era <era>", ERA_HELP, "auto")
  .argument("[command...]", "server command (prefix with -- ); omit when using --url")
  .action(async (
    cassette: string,
    command: string[],
    opts: { ignore: string[]; allowChangedPaths: string[]; allowAllChanges?: boolean; url?: string; era: string }
  ) => {
    try {
      if (opts.url && command.length > 0) throw new Error("use either --url or a server command, not both");
      if (!opts.url && command.length === 0) {
        throw new Error("missing target: pass a server command after -- , or --url <http-url>");
      }
      const server: Target = opts.url ? { kind: "http", url: opts.url } : { kind: "stdio", command };
      const parsed = readCassette(cassette);
      // verify re-executes the recorded calls for real. A redacted cassette
      // re-fires placeholder credentials, so auth-bearing calls will drift.
      // This heads the report so it's read next to the drift it explains.
      if (parsed.header.redaction?.applied) {
        process.stdout.write(
          "⚠ cassette was recorded with redaction: recorded request params contain placeholders,\n" +
            "  so credential-bearing calls may drift against the live server. Consider --ignore for\n" +
            "  the affected paths, or keep a separate --no-redact recording just for verify.\n"
        );
      }
      const results = await verifyAgainstServer(parsed, server, {
        ignore: opts.ignore,
        allowChangedPaths: opts.allowChangedPaths,
        allowAllChanges: opts.allowAllChanges === true,
        era: resolveEra(opts.era),
      });
      printVerifyReport(results);
      // exitCode, not exit(): exit() can truncate a long report on a piped stdout.
      process.exitCode = verifyFailed(results) ? 1 : 0;
    } catch (err) {
      process.stderr.write(`verify failed: ${(err as Error).message}\n`);
      process.exitCode = 2;
    }
  });

program
  .command("check")
  .description("Start a server, validate its handshake and schemas, and lint its tool descriptions for poisoning")
  .option("--stdio <command>", "stdio server command, e.g. \"npx -y @modelcontextprotocol/server-everything\"")
  .option("--url <url>", "Streamable HTTP server URL (experimental), e.g. http://127.0.0.1:3000/mcp")
  .option("--era <era>", ERA_HELP, "auto")
  .option("--format <format>", "output format: text | json | sarif", "text")
  // Kept permanently, not deprecated: it predates --format, it is in every
  // README and workflow written so far, and an alias costs one line.
  .option("--json", "alias for --format json")
  .option("--fail-on <level>", "lowest finding level that fails the run: error | warn", "error")
  .option(
    "--lint-fail-on <level>",
    "the same, for the CAS-L safety lint alone: error | warn | never (default: --fail-on). " +
      "never reports every lint finding and gates on none; a broken server still fails"
  )
  .option(
    "--sarif-location <file>",
    "file in the repository to anchor SARIF findings to, e.g. mcp-contract.snapshot.json (default: the contract snapshot, if one exists)"
  )
  .addHelpText(
    "after",
    "\nExamples:\n" +
      "  # health and safety check against a live server\n" +
      "  mcp-cassette check --stdio \"npx -y @modelcontextprotocol/server-everything stdio\"\n\n" +
      "  # the same check against a cassette, offline\n" +
      "  mcp-cassette check --stdio \"mcp-cassette replay session.cassette.jsonl\"\n\n" +
      "  # SARIF for GitHub code scanning, anchored to a committed file\n" +
      "  mcp-cassette check --stdio \"node dist/my-server.js\" \\\n" +
      "    --format sarif --sarif-location mcp-contract.snapshot.json > mcp-cassette.sarif\n\n" +
      "Exit codes: 0 clean, 1 a finding at or above its gate, 2 the server could not be inspected.\n" +
      "--lint-fail-on never waives the CAS-L lint only: a duplicate tool name or an invalid\n" +
      "inputSchema (CAS-C) still fails, and so does a server that could not be inspected.\n"
  )
  .action(
    async (opts: {
      stdio?: string;
      url?: string;
      era: string;
      json?: boolean;
      format: string;
      failOn: string;
      lintFailOn?: string;
      sarifLocation?: string;
    }) => {
    try {
      if (opts.failOn !== "error" && opts.failOn !== "warn") {
        process.stderr.write(`check: --fail-on must be error or warn (got '${opts.failOn}')\n`);
        process.exit(2);
      }
      // Unset means "follow --fail-on", so the stricter gate keeps covering the
      // lint and nothing about `--fail-on warn` changed when this flag landed.
      const lintFailOn = opts.lintFailOn ?? opts.failOn;
      if (lintFailOn !== "error" && lintFailOn !== "warn" && lintFailOn !== "never") {
        process.stderr.write(
          `check: --lint-fail-on must be error, warn or never (got '${opts.lintFailOn}')\n`
        );
        process.exit(2);
      }
      const format = opts.json ? "json" : opts.format;
      if (format !== "text" && format !== "json" && format !== "sarif") {
        process.stderr.write(`check: --format must be text, json or sarif (got '${opts.format}')\n`);
        process.exit(2);
      }
      const { target, label } = resolveTarget(opts);
      const report = await runCheck(target, label, resolveEra(opts.era), opts.failOn, lintFailOn);
      if (format === "sarif") {
        const anchor = resolveSarifAnchor(opts);
        if (!anchor) process.stderr.write(NO_ANCHOR_WARNING);
        process.stdout.write(JSON.stringify(toSarif(report, anchor), null, 2) + "\n");
      } else if (format === "json") process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      else printReport(report);
      process.exit(report.ok ? 0 : 1);
    } catch (err) {
      process.stderr.write(`check failed: ${(err as Error).message}\n`);
      process.exit(2);
    }
  }
  );

program
  .command("snapshot")
  .description("Write the tool contract to a file, or with --check diff a live server against it and fail on breaking changes")
  .option("--stdio <command>", "stdio server command, e.g. \"node dist/my-server.js\"")
  .option("--url <url>", "Streamable HTTP server URL (experimental), e.g. http://127.0.0.1:3000/mcp")
  .option("-f, --file <file>", "snapshot file, e.g. mcp-contract.snapshot.json", "mcp-contract.snapshot.json")
  .option("--check", "compare against existing snapshot instead of writing")
  .option("--update", "rewrite the snapshot file even if it exists")
  .option(
    "--fail-on <tier>",
    "lowest tier that fails --check: breaking | dangerous",
    "breaking"
  )
  .option("--era <era>", ERA_HELP, "auto")
  .option("--json", "machine-readable diff output (--check only)")
  .addHelpText(
    "after",
    "\nExamples:\n" +
      "  # capture the contract once, then commit the file\n" +
      "  mcp-cassette snapshot --stdio \"node dist/my-server.js\"\n\n" +
      "  # in CI: fail the build when the contract broke\n" +
      "  mcp-cassette snapshot --check --stdio \"node dist/my-server.js\"\n\n" +
      "Exit codes: 0 no change at or above --fail-on, 1 a breaking change.\n" +
      "Every finding carries a stable rule id in parentheses; match on the id, not the wording.\n"
  )
  .action(
    async (opts: {
      stdio?: string;
      url?: string;
      era: string;
      file: string;
      check?: boolean;
      update?: boolean;
      failOn: string;
      json?: boolean;
    }) => {
      try {
        if (opts.failOn !== "breaking" && opts.failOn !== "dangerous") {
          throw new Error(`--fail-on must be "breaking" or "dangerous" (got "${opts.failOn}")`);
        }
        const failOn = opts.failOn as FailOn;
        const { target } = resolveTarget(opts);
        const live = await captureContract(target, resolveEra(opts.era));

        if (opts.check) {
          if (!fs.existsSync(opts.file)) {
            process.stderr.write(`snapshot --check: no snapshot at ${opts.file} (run snapshot first)\n`);
            process.exit(2);
          }
          const stored = readSnapshot(opts.file);
          const changes = diffContracts(stored, live);
          const failed = shouldFail(changes, failOn);
          if (opts.json) {
            const report = { ok: !failed, failOn, counts: countChanges(changes), changes };
            process.stdout.write(JSON.stringify(report, null, 2) + "\n");
          } else {
            printChanges(changes, failOn);
          }
          process.exit(failed ? 1 : 0);
        }

        if (fs.existsSync(opts.file) && !opts.update) {
          process.stderr.write(
            `snapshot: ${opts.file} already exists. Use --check to compare or --update to overwrite\n`
          );
          process.exit(2);
        }
        writeSnapshot(opts.file, live);
        process.stdout.write(`wrote ${opts.file} (${live.tools.length} tools)\n`);
        process.exit(0);
      } catch (err) {
        process.stderr.write(`snapshot failed: ${(err as Error).message}\n`);
        process.exit(2);
      }
    }
  );

interface RedactCliOptions {
  out?: string;
  scan?: boolean;
  redactConfig?: string;
  checkConfig?: boolean;
}

/**
 * Print what the analyser found, and decide the exit code.
 *
 * A check that could not run is not a check that passed: without the optional
 * `recheck` peer the command says so and fails, because the user asked for an
 * analysis and would otherwise read silence as a clean bill of health.
 */
async function reportConfigCheck(cfg: Parameters<typeof checkRedactConfig>[0]): Promise<number> {
  const results = await checkRedactConfig(cfg);
  if (results === null) {
    process.stderr.write(
      "redact --check-config: this needs the optional `recheck` peer, which is not installed. " +
        "Run `npm install --no-save recheck` and try again; until then these patterns are unanalysed, " +
        "and they run over whatever a server answers\n"
    );
    return 2;
  }
  if (results.length === 0) {
    process.stdout.write("redact --check-config: the config declares no patterns, so there is nothing to analyse\n");
    return 0;
  }
  const width = Math.max(...results.map((r) => r.name.length));
  const lines = results.map((r) => `${r.name.padEnd(width)}  ${r.status.padEnd(10)}  ${r.detail}\n`);
  const failures = results.filter((r) => r.status !== "safe");
  lines.push(
    failures.length === 0
      ? `result: ${results.length} pattern(s) proven free of super-linear blowup\n`
      : `result: ${failures.length} of ${results.length} pattern(s) NOT proven linear-time\n`
  );
  process.stdout.write(lines.join(""));
  return failures.length === 0 ? 0 : 1;
}

program
  .command("redact")
  .description("Redact secrets in an existing cassette, or --scan to audit one without writing")
  // Optional, because --check-config reads only the config and writes nothing.
  .argument("[cassette]", "path to a .cassette.jsonl file")
  .option("-o, --out <file>", "write the redacted cassette here")
  .option("--scan", "report detected secrets and exit 1 if any were found (no file is written)")
  .option("--redact-config <file>", "JSON file of extra redaction rules: { patterns: [{ name, regex }], keys: [...], allow: [...] }. The same file must be given to replay, because redaction runs before matching")
  .option(
    "--check-config",
    "analyse --redact-config's patterns for catastrophic backtracking and exit, writing no cassette. Needs the optional `recheck` peer"
  )
  .action(async (cassettePath: string | undefined, opts: RedactCliOptions) => {
    try {
      const cfg = opts.redactConfig ? readRedactConfig(opts.redactConfig) : undefined;

      if (opts.checkConfig && (cassettePath || opts.scan || opts.out)) {
        process.stderr.write(
          "redact: --check-config reads the config and writes nothing. Drop the cassette, --scan and -o, or drop --check-config\n"
        );
        process.exitCode = 2;
        return;
      }
      if (opts.checkConfig) {
        if (!cfg) {
          process.stderr.write("redact --check-config: pass --redact-config <file>, there is nothing else to check\n");
          process.exitCode = 2;
          return;
        }
        process.exitCode = await reportConfigCheck(cfg);
        return;
      }

      if (!cassettePath) {
        // Exit 1, as commander's own "missing required argument" did before the
        // argument became optional for --check-config. A usage error either way.
        process.stderr.write("redact: pass a cassette, or --check-config with --redact-config\n");
        process.exitCode = 1;
        return;
      }
      if (opts.scan && opts.out) {
        process.stderr.write("redact: --scan writes nothing. Drop -o, or drop --scan\n");
        process.exitCode = 2;
        return;
      }
      const cassette = readCassette(cassettePath);

      if (opts.scan) {
        const hits = scanCassette(cassette, cfg);
        // One write: process.exit() would truncate an unbounded report on a pipe.
        const lines = hits.map((hit) => {
          const where = hit.method ? `${hit.dir} ${hit.method}` : hit.dir;
          return `[${hit.rule}] ${where} ${hit.path}: ${hit.excerpt}\n`;
        });
        lines.push(
          hits.length === 0
            ? "result: CLEAN (0 secrets detected)\n"
            : `result: FOUND (${hits.length} secret(s) detected)\n`
        );
        process.stdout.write(lines.join(""));
        process.exitCode = hits.length === 0 ? 0 : 1;
        return;
      }

      if (!opts.out) {
        process.stderr.write("redact: pass -o <file> to write a redacted cassette, or --scan to audit\n");
        process.exitCode = 2;
        return;
      }

      const found = scanCassette(cassette, cfg).length;
      writeCassette(opts.out, redactCassette(cassette, cfg));
      process.stdout.write(`wrote ${opts.out} (${found} secret(s) redacted)\n`);
    } catch (err) {
      process.stderr.write(`redact failed: ${(err as Error).message}\n`);
      process.exitCode = 2;
    }
  });

program.parseAsync(process.argv);
