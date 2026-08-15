/** Public programmatic API. The CLI is a thin wrapper over these. */

export * from "./jsonrpc.js";
export * from "./cassette.js";
export { runRecord, type RecordOptions } from "./record.js";
export {
  buildReplayIndex,
  fingerprint,
  handleFrame,
  matchResponse,
  runReplay,
  type ReplayIndex,
} from "./replay.js";
export { MiniClient, type Target, type Tool, type InitializeResult } from "./client.js";
export { lintTool, LINT_RULES, type LintFinding } from "./lint.js";
export { runCheck, printReport, type CheckReport, type CheckFinding } from "./check.js";
export {
  captureContract,
  diffContracts,
  printChanges,
  readSnapshot,
  writeSnapshot,
  type ContractSnapshot,
  type ContractChange,
} from "./snapshot.js";
