# Releasing mcp-cassette

Releases are cut by pushing a `v*` tag. The
[`release.yml`](.github/workflows/release.yml) workflow does the rest: it
verifies the tag matches `package.json`, runs the tests, publishes to npm with
provenance, creates the GitHub Release with generated notes, and moves the
floating `v0` and `v0.<minor>` tags onto the new release.

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

## The floating tags

The repository ships a GitHub Action as well as an npm package, and the two are
distributed on completely different mechanisms. npm resolves `mcp-cassette@0.1.2`
from the registry. `uses: ivermin1123/mcp-cassette@v0.3` resolves a **git ref** —
a tag, not a range. Nothing about `@v0.3` means "the latest 0.3.x"; it means
"whatever commit the tag `v0.3` currently names".

So the last step of `release.yml` force-moves both floats onto the commit just
released:

```bash
git tag -f v0   "$GITHUB_SHA" && git push -f origin refs/tags/v0
git tag -f v0.3 "$GITHUB_SHA" && git push -f origin refs/tags/v0.3
```

Two floats, because one cannot express both promises. While the major version is
`0` a minor may break, so `@v0` cannot be the recommended pin — 0.3.0 moved it
onto eight new lint rules, three at `error`, and consumers who had changed
nothing saw a red gate. `@v0.<minor>` only ever gains patches, which is what
[the README recommends](README.md#which-tag-to-pin); `@v0` stays for people who
want every release and have said so.

Four properties of that step are deliberate:

- **It runs last.** npm and the GitHub Release both have to succeed first, so
  neither float can resolve to a version that failed to ship.
- **Both names are derived from the tag** (`v0.3.1` → `v0` and `v0.3`), so
  nothing needs editing at v1 or at any new minor. The step keeps working across
  both bumps.
- **Prereleases are skipped**, and the check happens *before* the names are
  derived. A `v0.2.0-rc.1` tag leaves both floats where they are — a release
  candidate must not become what a consumer's pin points at — and `%.*` on such
  a tag would yield `v0.2.0-rc`, which is nobody's float and should not reach a
  log line.
- **The floats move by force-push, which does not re-trigger this workflow.**
  Pushes made with `GITHUB_TOKEN` do not start new runs, so the step cannot
  recurse. A float pushed *by hand* does start a run, and that run fails at the
  version check — see [BACKLOG.md](BACKLOG.md).

Without this step the action is not broken in any way CI would catch: the floats
simply stay frozen at the release they were cut from, consumers pin to them
happily, and no one ever receives an update. That failure is silent, which is
why the mechanism is written down here rather than left to whoever cut the tag.

A floating tag is mutable by design, which is the trade GitHub's own actions
make. Anyone who wants immutability pins a full version (`@v0.1.2`) or a commit
SHA, and both keep working — moving a float never rewrites the tag it moved
from. The same mutability is why a local checkout lies about them: `git fetch`
will not clobber an existing local tag ref, so `git rev-parse v0` keeps
answering with the SHA from whenever you last force-fetched. Use
`git ls-remote --tags origin` when the answer has to be true.

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

8. **Confirm both floats moved**, so the action consumers pin actually updated:

   ```bash
   git ls-remote --tags origin | grep -E 'refs/tags/(v0|v0\.1|v0\.1\.2)$'
   # all three lines must show the same SHA
   ```

   Ask the remote, not the checkout: `git fetch` refuses to clobber an existing
   local tag ref, so `git rev-parse v0` will keep reporting the previous
   release's SHA until you `git fetch --tags --force`. The remote listing needs
   no local state to be right.

   They will disagree if the release run stopped before its last step. Fix it by
   moving the tags by hand — `git tag -f v0 v0.1.2 && git push -f origin
   refs/tags/v0`, and the same for `v0.1` — rather than by cutting another
   release. Expect each hand push to leave one failed Release run behind; that
   is the version gate doing its job, not a broken release.

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
  Either way check `v0` afterwards — it is the last step, so anything that
  stopped the run left it behind. See step 8 above.

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
