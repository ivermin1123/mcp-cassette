/**
 * The fixture project's own config, so it can be run as a separate vitest
 * process by the test that drives it. It is deliberately not part of the
 * parent run — see the root vitest.config.ts exclude.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The parent suite reads this run's verdict, so a failing fixture must not
    // be retried into a different one.
    retry: 0,
  },
});
