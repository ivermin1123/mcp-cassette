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
  // compile. Leaving this key out does not mean no transform: jest's default
  // hands the specs to babel-jest, which applies whatever babel config the
  // project has. An empty transform is what keeps that away from them.
  transform: {},
};
