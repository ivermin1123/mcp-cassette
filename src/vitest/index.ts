/**
 * The vitest adapter: `mcp-cassette/vitest`.
 *
 * One call in a describe block puts a replay server around the tests and takes
 * it down after, so a suite that talks to an MCP server keeps working with no
 * server, no network, and no fixtures to hand-roll.
 *
 * The design that matters is where a miss surfaces. The engine answers a miss
 * with a JSON-RPC error, which a test would happily swallow, so the adapter
 * drains `takeMisses()` after every test and throws. Draining per test is the
 * point: a miss belongs to the test that caused it, not to the file.
 *
 * HTTP and stdio are not symmetric, and this does not pretend otherwise.
 * An HTTP cassette is served in-process, so its whole lifecycle is real. A
 * stdio replay owns `process.stdin` and `process.stdout` and would fight vitest
 * for them, so the adapter hands back the argv for a client to spawn instead,
 * see `command` for what that costs.
 */

import { afterAll, afterEach, beforeAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCassette } from "../cassette.js";
import { startHttpReplay, type ReplayServer, type Timing } from "../http-replay.js";
import { missesToError } from "./errors.js";

export { CassetteMismatchError, CassetteMissError, ReplayError, isMismatch } from "./errors.js";

export interface UseCassetteOptions {
  /**
   * "error" (default) fails the test that missed. "warn" leaves the JSON-RPC
   * error frame as the only signal, for suites asserting on it directly.
   */
  onMiss?: "error" | "warn";
  /** "host:port" to bind; defaults to an ephemeral port on 127.0.0.1. */
  listen?: string;
  timing?: Timing;
}

export interface CassetteHandle {
  /** Base URL of the replay server. HTTP cassettes only, and only once started. */
  readonly url: string;
  /**
   * argv for a client to spawn as its stdio server. stdio cassettes only.
   *
   * A process spawned by the client is a process the adapter does not own, so
   * misses on this path arrive only as the JSON-RPC error the client receives,
   * `onMiss` cannot fail the test for you, and `takeMisses()` has nothing to
   * drain. HTTP cassettes do not have this limitation.
   */
  readonly command: string[];
  /** The running server, for assertions the handle does not cover. HTTP only. */
  readonly server: ReplayServer;
}

/**
 * `dist/vitest/index.js` and `src/vitest/index.ts` both sit two levels under
 * the package root, so one expression finds the built CLI from either: from
 * the repo during its own tests, and from `node_modules` once installed.
 */
const cliPath = (): string => fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

/**
 * Put a cassette around the enclosing describe block.
 *
 * Call it at describe scope, not inside a test: it registers `beforeAll`,
 * `afterEach` and `afterAll` for you.
 */
export function useCassette(cassettePath: string, options: UseCassetteOptions = {}): CassetteHandle {
  const file = path.resolve(cassettePath);
  const onMiss = options.onMiss ?? "error";
  // Read the header now rather than in beforeAll: a missing or malformed
  // cassette should fail while the suite is being collected, naming the file,
  // instead of surfacing as a timeout inside the first test.
  const { transport } = readCassette(file).header;

  let server: ReplayServer | null = null;

  const running = (): ReplayServer => {
    if (!server) {
      throw new Error(
        `mcp-cassette: the replay server for ${file} is not running yet. Read .url inside a test or beforeEach, not at describe scope`
      );
    }
    return server;
  };

  if (transport === "http") {
    beforeAll(async () => {
      server = await startHttpReplay(file, {
        listen: options.listen ?? "127.0.0.1:0",
        ...(options.timing ? { timing: options.timing } : {}),
      });
    });

    // Always drain, throw only in "error" mode: a miss left in the log would
    // otherwise be reported against whichever test ran next.
    afterEach(() => {
      const misses = server?.takeMisses() ?? [];
      if (onMiss === "error" && misses.length > 0) throw missesToError(misses);
    });

    afterAll(async () => {
      await server?.close();
      server = null;
    });
  }

  return {
    get url(): string {
      if (transport !== "http") {
        throw new Error(`mcp-cassette: ${file} is a stdio cassette; spawn .command instead of connecting to .url`);
      }
      return running().url;
    },
    get command(): string[] {
      if (transport !== "stdio") {
        throw new Error(`mcp-cassette: ${file} is an http cassette; connect to .url instead of spawning .command`);
      }
      return [process.execPath, cliPath(), "replay", file];
    },
    get server(): ReplayServer {
      if (transport !== "http") {
        throw new Error(`mcp-cassette: ${file} is a stdio cassette; it has no in-process server`);
      }
      return running();
    },
  };
}
