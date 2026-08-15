# Releasing mcp-cassette

Releases are cut by pushing a `v*` tag. The
[`release.yml`](.github/workflows/release.yml) workflow does the rest: it
verifies the tag matches `package.json`, runs the tests, publishes to npm with
provenance, and creates the GitHub Release with generated notes.

Nothing is published from a laptop. If you find yourself running `npm publish`
locally, something has gone wrong — fix the workflow instead.

## How the publish authenticates

There is **no npm token**. Since v0.1.1 the workflow publishes through npm
[trusted publishing](https://docs.npmjs.com/trusted-publishers): GitHub Actions
mints a short-lived OIDC token for the run, npm checks it against the publisher
registered for this package, and issues publish rights for that run only.
Nothing long-lived exists to expire, leak, or rotate.

Three details in `release.yml` make it work, and each one breaks the publish if
it is undone:

- **`permissions: id-token: write`** on the job. Without it there is no OIDC
  token to exchange.
- **No `registry-url` in `actions/setup-node`.** The option looks harmless and
  is not: it makes setup-node write
  `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` into `~/.npmrc`
  unconditionally. With no token in the environment that expands to an empty
  string, npm reads it as "auth is already configured", skips the OIDC exchange
  entirely, and fails with `ENEEDAUTH` or `E404`
  ([npm/cli#8513](https://github.com/npm/cli/issues/8513), open at time of
  writing). Omitting the option writes no `.npmrc`, and npm's default registry
  is registry.npmjs.org anyway.
- **The `npm install -g npm@11.19.0` step.** Trusted publishing needs npm
  ≥ 11.5.1. The Node 22 runner bundles npm 10.9.x, which has no OIDC support at
  all. The version is pinned rather than `@latest` so a new npm major cannot
  land in the release path unannounced.

### One-time setup: the trusted publisher

Already done for `mcp-cassette`. To re-create it, or to set it up for another
package:

1. On [npmjs.com](https://www.npmjs.com/), open the package →
   **Settings** (`https://www.npmjs.com/package/<name>/access`).
2. Find **Trusted Publisher** → select **GitHub Actions**.
3. Fill in: organization or user `ivermin1123`, repository `mcp-cassette`
   (bare name), workflow filename `release.yml` (filename only, no path),
   environment blank, allowed actions **`npm publish`**.
4. Save and reload to confirm it is listed.

The package must already exist on npm — trusted publishing cannot create a
package from nothing, so the very first version of any new package still needs a
manual or token-based publish.

### Requirements for provenance

Provenance needs all of the following, or the publish fails:

- The workflow grants `id-token: write` (already set in `release.yml`).
- The repository is **public**.
- The publish runs from a GitHub-hosted runner.
- The `repository` field in `package.json` points at the actual repo.

Trusted publishing attaches provenance on its own, so `--provenance` is
technically redundant. It stays in the command on purpose: it turns a missing
OIDC context into a loud failure instead of a quietly unattested tarball. Don't
drop the flag to work around an error — fix the cause.

### Rollback: going back to a token

If an OIDC publish fails and a release has to go out *now*, the token path can
be restored without reverting the workflow. Add a token secret back and
reattach it to the publish step:

1. Create an npm **Automation** token (avatar → **Access Tokens** → **Generate
   New Token** → **Classic Token** → **Automation**; only Automation tokens
   bypass the 2FA prompt in CI) and store it as the `NPM_TOKEN` repository
   secret under **Settings → Secrets and variables → Actions**.
2. In `release.yml`, add back the env block on the publish step:

   ```yaml
   - name: Publish to npm with provenance
     run: npm publish --provenance --access public
     env:
       NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
   ```

Leave the rest alone. In particular **do not re-add `registry-url`** — with a
real token present npm reads `NODE_AUTH_TOKEN` from the environment on its own,
and re-adding the option only re-arms the empty-`.npmrc` trap for whoever
removes the token later.

This is a break-glass path, not a resting state: a long-lived token is the thing
trusted publishing exists to delete. Once the real cause is fixed, drop the env
block again and revoke the token.

## Cutting a release

1. **Make sure `main` is green.** Check the CI badge or the Actions tab. Both
   the `test` matrix and the `smoke` job must pass.

2. **Decide the version.** Pre-1.0, treat a breaking change to a command's
   behavior, output, exit codes, or the cassette format as a minor bump
   (`0.1.0 → 0.2.0`), and fixes as a patch bump (`0.1.0 → 0.1.1`).

3. **Bump the version on `main`.** `npm version` writes `package.json`, updates
   the lockfile, commits, and creates the tag:

   ```bash
   git checkout main
   git pull
   npm version patch      # or: minor / major
   ```

   This produces a `v0.1.1`-style tag matching `package.json`. If you edit the
   version by hand instead, tag it yourself with the exact same string — the
   workflow fails the release if the tag and `package.json` disagree.

   > `package.json` is the only place the version is written. The CLI's
   > `--version` and the cassette `recorder` field both read it at runtime
   > through `src/version.ts`, and `tests/version.test.ts` fails if any of them
   > drifts back to a literal.

4. **Verify the tarball before pushing.**

   ```bash
   npm pack --dry-run
   ```

   Only `dist/`, `README.md`, `LICENSE`, and `package.json` should be listed. If
   anything else appears, fix the `files` field in `package.json` and try again.

5. **Push the commit and the tag.**

   ```bash
   git push origin main
   git push origin v0.1.1     # or: git push origin --tags
   ```

6. **Watch the release run** in the Actions tab. On success you'll have a new
   version on [npm](https://www.npmjs.com/package/mcp-cassette) with a
   provenance badge, and a GitHub Release with generated notes.

7. **Sanity-check the published package:**

   ```bash
   npx mcp-cassette@latest --version
   npx mcp-cassette@latest check --stdio "npx -y @modelcontextprotocol/server-everything stdio"
   ```

## If a release fails

The workflow steps run in order — tag check, tests, publish, GitHub Release — so
where it stopped tells you what to do.

- **Failed before `npm publish`.** Nothing was published. Delete the tag, fix
  the problem, and start over:

  ```bash
  git push --delete origin v0.1.1
  git tag -d v0.1.1
  ```

- **Failed after `npm publish`.** The version is live and npm versions cannot be
  reused. Do not try to republish the same number. Create the GitHub Release by
  hand (`gh release create v0.1.1 --generate-notes`) if that was the step that
  failed, or ship a patch release if the published artifact is actually broken.

- **`npm publish` failed with `ENEEDAUTH`, `E404`, or an OIDC exchange error.**
  Authentication, not the package. Check in this order:

  1. **The trusted publisher fields on npm.** Repository must be the bare name
     (`mcp-cassette`, not `ivermin1123/mcp-cassette`), workflow must be the bare
     filename (`release.yml`, not `.github/workflows/release.yml`), environment
     blank, allowed actions including `npm publish`. A near-miss in any field
     produces exactly this error.
  2. **A stray `.npmrc`.** Did `registry-url` come back to the `setup-node`
     step, or did some other step write an `_authToken` line? An empty token
     value stops npm from ever trying OIDC. `cat ~/.npmrc` in a debug step —
     for a working OIDC run the file should not exist.
  3. **The npm version on the runner.** The `npm --version` line in the install
     step must print ≥ 11.5.1. If the pinned version ever disappears from the
     registry, the step fails silently early and the publish fails later with
     this error instead.

  E404 in particular reads like "no such package" but here means "npm did not
  recognize you, so it will not admit the package exists."

- **Provenance error.** Re-read the requirements above — a private repo is the
  usual cause.
