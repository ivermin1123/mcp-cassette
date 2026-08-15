#!/usr/bin/env node
/**
 * Renders the results of `action.yml` — the safety check and the classified
 * contract diff — into one Markdown report, and delivers it to the job log,
 * the step summary, and (on a pull request) a single comment.
 *
 * The comment carries a hidden marker. Every re-run finds the marker and edits
 * that comment in place, so a branch that is pushed twenty times ends up with
 * one comment showing the current state rather than twenty showing its history.
 *
 * Reads its inputs from the environment the action sets up:
 *   MODE, FAIL_ON, SNAPSHOT_FILE, COMMENT, EVENT_NAME, PR_NUMBER
 *   CHECK_STATUS, SNAPSHOT_STATUS   (empty when that step was skipped)
 *   RUNNER_TEMP                     (holds the check log and the --json diff)
 *   GH_TOKEN, GITHUB_REPOSITORY     (for the comment; gh reads GH_TOKEN itself)
 *
 * No dependencies: this runs on a bare runner before anything is installed.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const MARKER = "<!-- mcp-cassette-action -->";

/** Longest a comment body may get before the diff table is truncated. */
const MAX_BODY = 60_000;
/** Longest slice of the check log to inline. */
const MAX_CHECK_LOG = 8_000;

const env = process.env;
const tmp = env.RUNNER_TEMP ?? process.cwd();
const mode = env.MODE ?? "both";
const failOn = env.FAIL_ON ?? "breaking";

const TIER_LABEL = {
  breaking: "🚨 breaking",
  dangerous: "⚠️ dangerous",
  minor: "➕ minor",
  info: "ℹ️ info",
};

function readIfPresent(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** "" (step skipped) and undefined both mean "did not run". */
function statusOf(raw) {
  return raw === undefined || raw === "" ? null : Number(raw);
}

function fence(text, lang = "") {
  // A run of backticks inside the payload would close the fence early.
  const longest = (text.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 0);
  const rail = "`".repeat(Math.max(3, longest + 1));
  return `${rail}${lang}\n${text.trimEnd()}\n${rail}`;
}

function truncate(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… (truncated)`;
}

/** Markdown table cells cannot hold a raw pipe or newline. */
function cell(text) {
  return String(text).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function renderCheck(status) {
  if (status === null) return "";
  const log = readIfPresent(path.join(tmp, "mcp-cassette-check.log")) ?? "(no output captured)";
  const verdict = status === 0 ? "✅ passed" : "❌ failed";
  return [
    `**Safety check** — ${verdict}`,
    "",
    "<details><summary>check output</summary>",
    "",
    fence(truncate(log, MAX_CHECK_LOG)),
    "",
    "</details>",
  ].join("\n");
}

function renderDiff(status) {
  if (status === null) return "";
  const heading = `**Contract drift** — \`${env.SNAPSHOT_FILE ?? "mcp-contract.snapshot.json"}\` (gate: \`${failOn}\`)`;

  if (status >= 2) {
    const err = readIfPresent(path.join(tmp, "mcp-cassette-diff.err"));
    return [
      heading,
      "",
      "❌ the contract check could not run.",
      "",
      err ? fence(truncate(err, MAX_CHECK_LOG)) : "",
    ]
      .filter((part) => part !== "")
      .join("\n\n");
  }

  const raw = readIfPresent(path.join(tmp, "mcp-cassette-diff.json"));
  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    report = null;
  }
  // A missing file parses to `null`, not to a throw — guard on the value too.
  if (!report?.counts || !Array.isArray(report.changes)) {
    return [heading, "❌ could not parse the contract diff."].join("\n\n");
  }

  const { counts, changes } = report;
  const tally = `${counts.breaking} breaking · ${counts.dangerous} dangerous · ${counts.minor} minor · ${counts.info} info`;

  if (changes.length === 0) {
    return [heading, `✅ contract unchanged (${tally})`].join("\n\n");
  }

  const order = ["breaking", "dangerous", "minor", "info"];
  const sorted = [...changes].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const rows = sorted.map(
    (c) => `| ${TIER_LABEL[c.kind] ?? c.kind} | \`${cell(c.rule)}\` | \`${cell(c.subject)}\` | ${cell(c.message)} |`
  );

  return [
    heading,
    `${report.ok ? "✅ within the gate" : "❌ blocked by the gate"} — ${tally}`,
    ["| Tier | Rule | Tool | Change |", "| --- | --- | --- | --- |", ...rows].join("\n"),
  ].join("\n\n");
}

function render(checkStatus, snapshotStatus) {
  const failed = [checkStatus, snapshotStatus].some((s) => s !== null && s !== 0);
  const body = [
    MARKER,
    `### mcp-cassette — ${failed ? "❌ FAIL" : "✅ PASS"}`,
    renderCheck(checkStatus),
    renderDiff(snapshotStatus),
    `<sub>mode: \`${mode}\` · gate: \`${failOn}\` · rule IDs are stable — match on those, not on the wording.</sub>`,
  ]
    .filter((part) => part !== "")
    .join("\n\n");

  return truncate(body, MAX_BODY);
}

function gh(args, input) {
  return execFileSync("gh", args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
}

/**
 * Post the report, or edit the one this action left last time. A failure here
 * is reported and swallowed: a pull request from a fork gets a read-only token,
 * and losing the comment must not turn a passing contract gate red.
 */
function upsertComment(body) {
  const repo = env.GITHUB_REPOSITORY;
  const pr = env.PR_NUMBER;
  if (!repo || !pr) {
    console.log("mcp-cassette: no pull-request context — skipping the comment.");
    return;
  }

  try {
    const existing = JSON.parse(
      gh(["api", "--paginate", `repos/${repo}/issues/${pr}/comments`])
    ).find((comment) => typeof comment.body === "string" && comment.body.includes(MARKER));

    const payload = JSON.stringify({ body });
    if (existing) {
      gh(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${existing.id}`, "--input", "-"], payload);
      console.log(`mcp-cassette: updated comment ${existing.id}.`);
    } else {
      gh(["api", "-X", "POST", `repos/${repo}/issues/${pr}/comments`, "--input", "-"], payload);
      console.log("mcp-cassette: posted the results comment.");
    }
  } catch (err) {
    const detail = err.stderr?.toString().trim() || err.message;
    console.log(`::warning::mcp-cassette could not write the pull-request comment: ${detail}`);
  }
}

const checkStatus = statusOf(env.CHECK_STATUS);
const snapshotStatus = statusOf(env.SNAPSHOT_STATUS);
const body = render(checkStatus, snapshotStatus);

console.log(body);

if (env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(env.GITHUB_STEP_SUMMARY, body + "\n");
}

if (env.COMMENT === "true" && env.EVENT_NAME === "pull_request") {
  upsertComment(body);
}
