/**
 * The package version, read from package.json at runtime.
 *
 * Hardcoding it meant a cassette could be stamped with a recorder version that
 * did not match the package that wrote it, because a bump to the manifest alone was
 * enough to make every recording lie about its provenance.
 *
 * Loaded with `createRequire` rather than a JSON import: `rootDir` is `src`, so
 * a static `import ... from "../package.json"` puts a file outside the root into
 * the program and fails the build, and import attributes would still emit a
 * bare specifier the packed tarball has to resolve. `require` resolves relative
 * to this module and caches, and the layout holds in both places this runs from
 * because `src/version.ts` and `dist/version.js` are each one level below the
 * package.json they need, in the repo and in the tarball alike.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { name: string; version: string };

export const VERSION: string = pkg.version;
export const RECORDER = `${pkg.name}@${pkg.version}`;
