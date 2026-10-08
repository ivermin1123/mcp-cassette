/**
 * The vitest adapter: `mcp-cassette/vitest`.
 *
 * One call in a describe block puts a replay server around the tests and takes
 * it down after, so a suite that talks to an MCP server keeps working with no
 * server, no network, and no fixtures to hand-roll.
 *
 * Everything that is not vitest lives in `../adapter/use-cassette.ts`, which
 * also holds the reasoning behind the per-test drain and the HTTP/stdio split.
 * This file is the vitest half: the hooks, and nothing else.
 */

import { afterAll, afterEach, beforeAll } from "vitest";
import { useCassetteWith, type CassetteHandle, type UseCassetteOptions } from "../adapter/use-cassette.js";

export type { CassetteHandle, UseCassetteOptions } from "../adapter/use-cassette.js";
export { CassetteMismatchError, CassetteMissError, ReplayError, isMismatch } from "../adapter/errors.js";

/**
 * Put a cassette around the enclosing describe block.
 *
 * Call it at describe scope, not inside a test: it registers `beforeAll`,
 * `afterEach` and `afterAll` for you.
 */
export function useCassette(cassettePath: string, options: UseCassetteOptions = {}): CassetteHandle {
  return useCassetteWith({ beforeAll, afterEach, afterAll }, cassettePath, options);
}
