/**
 * The jest adapter: `mcp-cassette/jest`.
 *
 * The same call, the same options and the same errors as
 * `mcp-cassette/vitest`: one call in a describe block puts a replay server
 * around the tests and takes it down after, so a suite that talks to an MCP
 * server keeps working with no server, no network, and no fixtures to
 * hand-roll.
 *
 * Everything that is not jest lives in `../adapter/use-cassette.ts`, which also
 * holds the reasoning behind the per-test drain and the HTTP/stdio split. This
 * file is the jest half: the hooks, and nothing else.
 *
 * The hooks come from `@jest/globals` rather than the injected globals, because
 * this package is ESM and a consumer running jest under
 * `--experimental-vm-modules` has `injectGlobals` available but no ambient
 * types for it. Importing them is also what makes the adapter typecheck on its
 * own, without a test-framework global declaration leaking into the build.
 */

import { afterAll, afterEach, beforeAll } from "@jest/globals";
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
