/**
 * What a miss looks like when it has to fail a test.
 *
 * The engine answers a miss with a JSON-RPC error, which is right for a server
 * and useless for a test runner: a test that quietly receives an error frame
 * passes. So the adapter turns misses into thrown errors, and the type it
 * throws is the answer to the question the reader will actually ask.
 *
 * "Did I never record this, or did I record it and the arguments drifted?" is
 * two different fixes, so it is two different classes. Nobody should have to
 * match a substring to find that out.
 */

import type { DiffEntry } from "../diff.js";
import { formatMiss, type MissEvent, type MissReason } from "../replay.js";

/** The two reasons that mean a recording came close enough to name paths. */
const NEAR_MISS: ReadonlySet<MissReason["kind"]> = new Set(["arguments-differ", "params-differ"]);

/** True when a recording matched the method (and tool) but its params diverged. */
export function isMismatch(reason: MissReason): boolean {
  return NEAR_MISS.has(reason.kind);
}

/** Everything the adapter throws, so one `catch` can still cover both. */
export class ReplayError extends Error {
  /** Every miss in the test that failed, in arrival order. */
  readonly misses: MissEvent[];
  /** The miss that decided the type: the first one. */
  readonly reason: MissReason;

  constructor(message: string, misses: MissEvent[]) {
    super(message);
    this.name = new.target.name;
    this.misses = misses;
    this.reason = misses[0]!.reason;
  }
}

/** Nothing in the cassette answered this request. Record it, or call it less. */
export class CassetteMissError extends ReplayError {}

/**
 * A recording matched the method and tool, and diverged at these paths.
 * `changes` is the diff, so an assertion can read it instead of the message.
 */
export class CassetteMismatchError extends ReplayError {
  readonly changes: DiffEntry[];

  constructor(message: string, misses: MissEvent[]) {
    super(message, misses);
    const reason = misses[0]!.reason;
    this.changes = "changes" in reason ? reason.changes : [];
  }
}

/**
 * Build the error for a test's misses.
 *
 * The first miss picks the class. A test that misses twice for different
 * reasons is already broken in the first way, and that is the one worth
 * naming; the rest travel on `.misses` rather than being averaged into a
 * vaguer type.
 */
export function missesToError(misses: MissEvent[]): ReplayError {
  const first = misses[0]!;
  const rest = misses.length > 1 ? `\n(and ${misses.length - 1} further miss(es) in this test)` : "";
  const message =
    `mcp-cassette: no recorded answer for "${first.method}", ${formatMiss(first.reason)}.` +
    ` Re-record the cassette or adjust the interaction.${rest}`;
  return isMismatch(first.reason)
    ? new CassetteMismatchError(message, misses)
    : new CassetteMissError(message, misses);
}
