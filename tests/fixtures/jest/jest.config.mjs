/**
 * The fixture project's own config, so it can be run as a separate jest process
 * by the test that drives it. It is deliberately not part of the parent vitest
 * run; see the root vitest.config.ts exclude.
 *
 * This is also the config the README hands a consumer, so it stays the minimum
 * that works rather than the minimum plus whatever was convenient here.
 */
export default {
  rootDir: ".",
  testEnvironment: "node",
  // The package is ESM and the specs are plain ESM, so there is nothing to
  // compile. An empty transform is what turns babel-jest off; left in place it
  // would rewrite the specs to CommonJS and the native ESM loader would never
  // see them.
  transform: {},
};
