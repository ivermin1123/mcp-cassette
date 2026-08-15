# Releasing mcp-cassette

Releases are cut by pushing a `v*` tag. The
[`release.yml`](.github/workflows/release.yml) workflow does the rest: it
verifies the tag matches `package.json`, runs the tests, publishes to npm with
provenance, and creates the GitHub Release with generated notes.

Nothing is published from a laptop. If you find yourself running `npm publish`
locally, something has gone wrong — fix the workflow instead.

## One-time setup

### `NPM_TOKEN` repository secret

The publish step authenticates with an npm **Automation** token. A Publish or
Classic token will fail if the npm account has 2FA enforced, because only
Automation tokens bypass the 2FA prompt in CI.

1. On [npmjs.com](https://www.npmjs.com/), go to your avatar → **Access Tokens**
   → **Generate New Token** → **Classic Token** → **Automation**.
2. Copy the token.
3. In the GitHub repo: **Settings → Secrets and variables → Actions → New
   repository secret**.
   - Name: `NPM_TOKEN`
   - Value: the token
4. Rotate it if it's ever exposed in a log; the workflow never echoes it.

### Requirements for provenance

`npm publish --provenance` needs all of the following, or the publish fails:

- The workflow grants `id-token: write` (already set in `release.yml`).
- The repository is **public**.
- The publish runs from a GitHub-hosted runner.
- The `repository` field in `package.json` points at the actual repo.

Provenance is what lets users verify on npm that the tarball was built from this
repo at this commit, so don't drop the flag to work around an error — fix the
cause.

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

   > `src/cli.ts` and `src/cassette.ts` carry the version string too (the
   > `.version()` call and the cassette `recorder` field). Update them in the
   > same commit so recorded cassettes report the right recorder.

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

- **`npm publish` rejected the token.** Confirm the secret is named exactly
  `NPM_TOKEN` and is an Automation token that hasn't expired.

- **Provenance error.** Re-read the requirements above — a private repo is the
  usual cause.
