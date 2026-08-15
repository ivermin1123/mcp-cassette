/**
 * One seed for every property run, so a failure found on a runner reproduces on
 * a laptop from the log alone — `fast-check` prints the seed, but only a run
 * that used the same one replays the same cases.
 *
 * Override to widen the search:
 *
 *   FAST_CHECK_SEED=$RANDOM npm test
 *
 * The fixed default is a deliberate trade. A random seed explores more over
 * time; a fixed one makes CI a gate rather than a lottery, and keeps a red
 * build reproducible after the fact. Widening happens by adding cases and
 * arbitraries, not by hoping a runner rolls the interesting one.
 */

import fc from "fast-check";

export const FAST_CHECK_SEED = Number(process.env.FAST_CHECK_SEED ?? 20260815);

fc.configureGlobal({ seed: FAST_CHECK_SEED });
