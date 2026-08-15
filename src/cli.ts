#!/usr/bin/env node
/**
 * mcp-cassette — record a real MCP session once, replay it forever.
 *
 *   record    transparent stdio proxy that captures a session into a cassette
 *   replay    serve a cassette as a deterministic mock MCP server
 *   check     health + safety check of a live server (CI exit codes)
 *   snapshot  contract snapshot & breaking-change detection
 */

import { Command } from "commander";
import fs from "node:fs";
import { runRecord } from "./record.js";
import { runReplay } from "./replay.js";
import { runCheck, printReport } from "./check.js";
import {
  captureContract,
  diffContracts,
  printChanges,
  readSnapshot,
  writeSnapshot,
} from "./snapshot.js";
import type { Target } from "./client.js";

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

const program = new Command();

program
  .name("mcp-cassette")
  .description("Record a real MCP session once — replay it forever. VCR + contract tests for MCP servers.")
  .version("0.1.0");

program
  .command("record")
  .description("Record a session: run as a transparent stdio proxy in front of a server command")
  .requiredOption("-o, --out <file>", "cassette output path (.cassette.jsonl)")
  .argument("<command...>", "server command (prefix with -- )")
  .action(async (command: string[], opts: { out: string }) => {
    try {
      const code = await runRecord({ out: opts.out, command });
      process.exit(code);
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(1);
    }
  });

program
  .command("replay")
  .description("Serve a recorded cassette as a deterministic stdio MCP server")
  .argument("<cassette>", "path to a .cassette.jsonl file")
  .action((cassette: string) => {
    try {
      runReplay(cassette);
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(1);
    }
  });

program
  .command("check")
  .description("Health + safety check: lifecycle, schemas (ajv 2020-12), description safety lint")
  .option("--stdio <command>", "stdio server command, e.g. \"npx -y @modelcontextprotocol/server-everything\"")
  .option("--url <url>", "Streamable HTTP server URL (experimental)")
  .option("--json", "machine-readable JSON output")
  .action(async (opts: { stdio?: string; url?: string; json?: boolean }) => {
    try {
      const { target, label } = resolveTarget(opts);
      const report = await runCheck(target, label);
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
  .action(async (opts: { stdio?: string; url?: string; file: string; check?: boolean; update?: boolean }) => {
    try {
      const { target } = resolveTarget(opts);
      const live = await captureContract(target);

      if (opts.check) {
        if (!fs.existsSync(opts.file)) {
          process.stderr.write(`snapshot --check: no snapshot at ${opts.file} (run snapshot first)\n`);
          process.exit(2);
        }
        const stored = readSnapshot(opts.file);
        const changes = diffContracts(stored, live);
        printChanges(changes);
        process.exit(changes.some((c) => c.kind === "breaking") ? 1 : 0);
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
  });

program.parseAsync(process.argv);
