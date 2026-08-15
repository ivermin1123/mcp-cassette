/** Public programmatic API. The CLI is a thin wrapper over these. */

export * from "./jsonrpc.js";
export * from "./cassette.js";
export { runRecord, type RecordMode, type RecordOptions } from "./record.js";
export {
  buildReplayIndex,
  diagnoseMiss,
  fingerprint,
  handleFrame,
  matchResponse,
  runReplay,
  type OnMissMode,
  type ReplayIndex,
  type ReplayOptions,
} from "./replay.js";
export { diffValues, escapePointerSegment, formatValue, splitPointer, type DiffEntry } from "./diff.js";
export {
  classifyPair,
  collectVerifyPairs,
  isAllowedChange,
  normalizeForDiff,
  pairLabel,
  printVerifyReport,
  removePointer,
  verifyAgainstServer,
  verifyFailed,
  type VerifyOptions,
  type VerifyPair,
  type VerifyResult,
  type VerifyStatus,
} from "./verify.js";
export {
  maskSecret,
  redactCassette,
  redactCommand,
  redactFrame,
  redactRawLine,
  redactString,
  scanRawLine,
  scanCassette,
  scanFrame,
  REDACT_RULES,
  type CassetteSecretHit,
  type RedactRule,
  type SecretHit,
} from "./redact.js";
export {
  MiniClient,
  InputRequiredError,
  ModernServerError,
  type Target,
  type Tool,
  type InitializeResult,
} from "./client.js";
export { HttpStatusError } from "./transport.js";
export { runHttpRecord, startHttpRecord, type HttpRecordOptions, type RecordingProxy } from "./proxy.js";
export { lintTool, LINT_RULES, type LintFinding } from "./lint.js";
export { runCheck, printReport, type CheckReport, type CheckFinding } from "./check.js";
export {
  captureContract,
  countChanges,
  diffContracts,
  printChanges,
  readSnapshot,
  shouldFail,
  writeSnapshot,
  CHANGE_KINDS,
  CONTRACT_RULES,
  type ChangeCounts,
  type ChangeKind,
  type ContractChange,
  type ContractRule,
  type ContractSnapshot,
  type FailOn,
} from "./snapshot.js";
