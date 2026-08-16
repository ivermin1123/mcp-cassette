#!/usr/bin/env node
/**
 * mcp-cassette — record a real MCP session once, replay it forever.
 *
 *   record    transparent stdio proxy that captures a session into a cassette
 *   replay    serve a cassette as a deterministic mock MCP server
 *   verify    re-fire recorded requests at a live server, diff the responses
 *   check     health + safety check of a live server (CI exit codes)
 *   snapshot  contract snapshot & breaking-change detection
 *   redact    redact (or audit) secrets in an existing cassette
 */

import { Command } from "commander";
import fs from "node:fs";
import { runRecord, type RecordMode } from "./record.js";
import { DEFAULT_LISTEN, runHttpRecord } from "./proxy.js";
import { runReplay, type OnMissMode } from "./replay.js";
import { runHttpReplay } from "./http-replay.js";
import { printVerifyReport, verifyAgainstServer, verifyFailed } from "./verify.js";
import { runCheck, printReport } from "./check.js";
import { readCassette, writeCassette } from "./cassette.js";
import { redactCassette, scanCassette } from "./redact.js";
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

function resolveEra(value: string): EraOption {
  if (value === "auto" || value === "legacy" || value === "modern") return value;
  throw new Error(`--era must be legacy | modern | auto (got "${value}")`);
}

const program = new Command();

program
  .name("mcp-cassette")
  .description("Record a real MCP session once — replay it forever. VCR + contract tests for MCP servers.")
  .version(VERSION);

program
  .command("record")
  .description("Record a session: a transparent proxy in front of a stdio command or an HTTP server")
  .requiredOption("-o, --out <file>", "cassette output path (.cassette.jsonl)")
  .option("--no-redact", "record secrets verbatim instead of redacting them")
  .option("--mode <mode>", "once: refuse to overwrite an existing cassette; all: always re-record", "once")
  .option("--http <url>", "record a Streamable HTTP server: reverse-proxy this upstream URL")
  .option("--listen <host:port>", "address the HTTP recording proxy binds", DEFAULT_LISTEN)
  .argument("[command...]", "server command (prefix with -- ); omit when using --http")
  .action(async (command: string[], opts: { out: string; redact: boolean; mode: string; http?: string; listen: string }) => {
    try {
      if (opts.mode !== "once" && opts.mode !== "all") {
        throw new Error(`record: unknown --mode "${opts.mode}" (expected once or all)`);
      }
      const mode = opts.mode as RecordMode;
      if (opts.http && command.length > 0) throw new Error("record: use either --http or a server command, not both");
      if (opts.http) {
        const httpCode = await runHttpRecord({ out: opts.out, url: opts.http, listen: opts.listen, redact: opts.redact, mode });
        process.exit(httpCode);
      }
      if (command.length === 0) {
        throw new Error("record: missing target — pass a server command after -- , or --http <url>");
      }
      const code = await runRecord({ out: opts.out, command, redact: opts.redact, mode });
      process.exit(code);
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(1);
    }
  });

program
  .command("replay")
  .description("Serve a recorded cassette as a deterministic MCP server — stdio, or Streamable HTTP with --listen")
  .argument("<cassette>", "path to a .cassette.jsonl file")
  .option("--listen <host:port>", `serve an HTTP cassette over Streamable HTTP (default ${DEFAULT_LISTEN})`)
  .option("--timing <mode>", "streamed answers: none (default, emit back to back) or recorded (honor recorded offsets)", "none")
  .option(
    "--on-miss <mode>",
    "on fingerprint miss: error (fail the session), warn (answer with an error, exit 0), or passthrough (forward to the real server after -- and append the interaction)",
    "error"
  )
  .argument("[command...]", "real server command for --on-miss passthrough (prefix with -- )")
  .action(async (cassette: string, command: string[], opts: { onMiss: string; listen?: string; timing: string }) => {
    try {
      if (opts.onMiss !== "error" && opts.onMiss !== "warn" && opts.onMiss !== "passthrough") {
        throw new Error(`replay: unknown --on-miss "${opts.onMiss}" (expected error, warn, or passthrough)`);
      }
      if (opts.timing !== "none" && opts.timing !== "recorded") {
        throw new Error(`replay: unknown --timing "${opts.timing}" (expected none or recorded)`);
      }
      if (opts.listen !== undefined) {
        if (opts.onMiss === "passthrough") {
          throw new Error("replay --listen does not support --on-miss passthrough yet (it lands with HTTP passthrough)");
        }
        await runHttpReplay(cassette, { listen: opts.listen, onMiss: opts.onMiss, timing: opts.timing });
        return;
      }
      // Pacing only means something for a streamed answer, and only HTTP serves those.
      if (opts.timing !== "none") {
        throw new Error("replay --timing applies to streamed answers, which only --listen serves — add --listen or drop --timing");
      }
      await runReplay(cassette, { onMiss: opts.onMiss as OnMissMode, serverCommand: command });
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(1);
    }
  });

/** Repeatable-option accumulator for commander. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
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
  .option("--allow-all-changes", "let every CHANGED pair pass — the explicit waive-everything switch")
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
          "⚠ cassette was recorded with redaction — recorded request params contain placeholders,\n" +
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
  .description("Health + safety check: lifecycle, schemas (ajv 2020-12), description safety lint")
  .option("--stdio <command>", "stdio server command, e.g. \"npx -y @modelcontextprotocol/server-everything\"")
  .option("--url <url>", "Streamable HTTP server URL (experimental)")
  .option("--era <era>", ERA_HELP, "auto")
  .option("--json", "machine-readable JSON output")
  .action(async (opts: { stdio?: string; url?: string; era: string; json?: boolean }) => {
    try {
      const { target, label } = resolveTarget(opts);
      const report = await runCheck(target, label, resolveEra(opts.era));
      if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      else printReport(report);
      process.exit(report.ok ? 0 : 1);
    } catch (err) {
      process.stderr.write(`check failed: ${(err as Error).message}\n`);
      process.exit(2);
    }
  });

program
  .command("snapshot")
  .description("Capture the tool contract; --check diffs live server vs snapshot and fails CI on breaking changes")
  .option("--stdio <command>", "stdio server command")
  .option("--url <url>", "Streamable HTTP server URL (experimental)")
  .option("-f, --file <file>", "snapshot file", "mcp-contract.snapshot.json")
  .option("--check", "compare against existing snapshot instead of writing")
  .option("--update", "rewrite the snapshot file even if it exists")
  .option(
    "--fail-on <tier>",
    "lowest tier that fails --check: breaking | dangerous",
    "breaking"
  )
  .option("--era <era>", ERA_HELP, "auto")
  .option("--json", "machine-readable diff output (--check only)")
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
            `snapshot: ${opts.file} already exists — use --check to compare or --update to overwrite\n`
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

program
  .command("redact")
  .description("Redact secrets in an existing cassette, or --scan to audit one without writing")
  .argument("<cassette>", "path to a .cassette.jsonl file")
  .option("-o, --out <file>", "write the redacted cassette here")
  .option("--scan", "report detected secrets and exit 1 if any were found (no file is written)")
  .action((cassettePath: string, opts: { out?: string; scan?: boolean }) => {
    try {
      if (opts.scan && opts.out) {
        process.stderr.write("redact: --scan writes nothing — drop -o, or drop --scan\n");
        process.exitCode = 2;
        return;
      }
      const cassette = readCassette(cassettePath);

      if (opts.scan) {
        const hits = scanCassette(cassette);
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

      const found = scanCassette(cassette).length;
      writeCassette(opts.out, redactCassette(cassette));
      process.stdout.write(`wrote ${opts.out} (${found} secret(s) redacted)\n`);
    } catch (err) {
      process.stderr.write(`redact failed: ${(err as Error).message}\n`);
      process.exitCode = 2;
    }
  });

program.parseAsync(process.argv);
