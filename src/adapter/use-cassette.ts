/**
 * The part of the test adapters that has nothing to do with a test framework.
 *
 * `mcp-cassette/vitest` and `mcp-cassette/jest` differ in exactly one thing:
 * where `beforeAll`, `afterEach` and `afterAll` come from. Everything else is
 * the same answer to the same question: when the cassette is read, where a
 * miss surfaces, what the handle refuses. So it lives here once, and the two
 * entry points pass their framework's hooks in.
 *
 * The design that matters is where a miss surfaces. The engine answers a miss
 * with a JSON-RPC error, which a test would happily swallow, so the adapter
 * drains `takeMisses()` after every test and throws. Draining per test is the
 * point: a miss belongs to the test that caused it, not to the file.
 *
 * HTTP and stdio are not symmetric, and this does not pretend otherwise.
 * An HTTP cassette is served in-process, so its whole lifecycle is real. A
 * stdio replay owns `process.stdin` and `process.stdout` and would fight the
 * test runner for them, so the adapter hands back the argv for a client to
 * spawn instead, see `command` for what that costs.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCassette } from "../cassette.js";
import { startHttpReplay, type ReplayServer, type Timing } from "../http-replay.js";
import { missesToError } from "./errors.js";

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
 * The three lifecycle hooks an adapter borrows from its test framework.
 *
 * Deliberately the smallest shape that works, rather than a framework's own
 * type: it is what makes vitest's hooks and jest's hooks the same argument.
 */
export interface TestHooks {
  beforeAll(fn: () => Promise<void>): void;
  afterEach(fn: () => void): void;
  afterAll(fn: () => Promise<void>): void;
}

/**
 * `dist/adapter/use-cassette.js`, `dist/vitest/index.js` and
 * `dist/jest/index.js` all sit two levels under the package root, so one
 * expression finds the built CLI from either: from the repo during its own
 * tests, and from `node_modules` once installed.
 */
const cliPath = (): string => fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

/**
 * Put a cassette around the enclosing describe block, using the given hooks.
 *
 * Call it at describe scope, not inside a test: it registers `beforeAll`,
 * `afterEach` and `afterAll` for you.
 */
export function useCassetteWith(
  hooks: TestHooks,
  cassettePath: string,
  options: UseCassetteOptions = {}
): CassetteHandle {
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
    hooks.beforeAll(async () => {
      server = await startHttpReplay(file, {
        listen: options.listen ?? "127.0.0.1:0",
        ...(options.timing ? { timing: options.timing } : {}),
      });
    });

    // Always drain, throw only in "error" mode: a miss left in the log would
    // otherwise be reported against whichever test ran next.
    hooks.afterEach(() => {
      const misses = server?.takeMisses() ?? [];
      if (onMiss === "error" && misses.length > 0) throw missesToError(misses);
    });

    hooks.afterAll(async () => {
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
