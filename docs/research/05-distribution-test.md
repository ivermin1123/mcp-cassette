# Distribution test, 2026-10-11 to 2026-11-10

Written and committed **before** any launch post went out, in the spirit of
[`00-kill-criteria.md`](00-kill-criteria.md): the threshold, the signals and
the decision rule below are fixed now, while the answer is unknown. Nothing
here may be edited after the first post: not the threshold, not the signal
definitions, not the window. Anything the rules did not foresee goes in an
*unforeseen* section of the end report, never into the verdict.

## Why this test

The usage check of 2026-10-08 found the tool healthy and nobody using it: npm
downloads at the mirror and bot floor, no stars, no outside issue, pull
request or dependent repository, and no listing anywhere. Its recommendation
was to stop adding features and run one distribution test with a threshold
written down first. Since then 0.5.0 to 0.10.0 shipped, and the adoption
numbers below have not moved. The question this test answers is the first one
the kill criteria ask: does anyone install and use it, once people can find it?

## Window

From **2026-10-11** to the end of **2026-11-10**, Asia/Saigon. One listing was
already live when this was written: AlexMili/Awesome-MCP merged its entry at
06:16 on 2026-10-11 (23:16 UTC the day before), so the baseline includes its
first hours.

## Baseline, taken 2026-10-11 10:15

| Signal | Value | Source |
|---|---|---|
| GitHub stars, forks, watchers | 0, 0, 0 | `gh api repos/ivermin1123/mcp-cassette` |
| Issues or pull requests opened by anyone but the owner (bots excluded) | 0 | issues API, all states |
| Public repositories outside the owner's that depend on the package or use the Action | 0 | `gh search code "ivermin1123/mcp-cassette"` finds only `ivermin1123/hoangle.xyz` |
| npm downloads, 2026-09-11 to 2026-10-07 (no release in that span) | 73 | `api.npmjs.org/downloads/range` |
| npm downloads of `mcpdrift` (0 stars, abandoned 2026-08-25), 2026-09-11 to 2026-10-10 | 42 | the same API, as the floor reference |
| npm downloads, 2026-10-08 and 2026-10-09 (eight releases 2026-10-08 to 2026-10-10) | 553 and 57 | the same API; release days, CI and mirrors |
| GitHub traffic, 14 days | 8 views, 3 unique; 730 clones, 130 unique (CI checkouts); no referrers | traffic API |
| mcpcassette.dev in Google, 2026-09-11 to 2026-10-10 | 1 impression, 0 clicks | Search Console |
| Listings | AlexMili/Awesome-MCP (merged), GitHub Marketplace (live at v0.9.1); pending: scadastrangelove/awesome-ai-security-tools#158, punkpeye/awesome-mcp-devtools#372 | |

## The threshold

The test **hits** if, by the end of 2026-11-10, at least one of these is true:

1. An issue, pull request or discussion on `ivermin1123/mcp-cassette` is
   opened by an account that is neither the owner nor a bot.
2. The repository has **10 or more** stars.
3. At least **one** public repository not owned by the owner depends on the
   `mcp-cassette` npm package (a `package.json` dependency) or uses the Action
   (`uses: ivermin1123/mcp-cassette` in a workflow), found by GitHub code
   search or npm's dependents list.

Otherwise it **misses**.

Supporting signals are reported but decide nothing: npm downloads in weeks
without a release, measured against the 73-in-four-weeks floor above, GitHub
referrers, Search Console clicks, and any mention found by search. npm counts
cannot separate people from mirrors and CI, which is why none of them is in
the threshold.

## Decision rule

- **Hit:** follow what the first users ask for, not the backlog.
- **Miss:** maintenance mode. CI, the weekly canaries and Dependabot stay on;
  the scheduled graduation of the prompt and resource lint surfaces (no
  earlier than 2026-11-06) is the last planned change; no new features; the
  distribution stops. The tool stays published and stays correct.

## During the window

- Releases are for fixes and for that scheduled graduation only. A feature
  release would muddy the download numbers and is what the test is meant to
  stop.
- Each channel is posted only with the owner's go, under the owner's name.
  Candidates: a Show HN, a dev.to article, r/mcp, the MCP community Discord,
  and the GitHub Marketplace listing moved to the current release.
- Every post goes out with the same two claims, the ones no neighbouring tool
  has finished: the cassette is itself an MCP server, so any client in any
  language connects to it unchanged, and the same CLI lints what a server
  publishes to the model, and what a recorded server returned, for prompt
  injection, with SARIF output.

## End report

On 2026-11-11, rerun every command in the baseline table, write the numbers
next to the baseline, state hit or miss against the three conditions above
and nothing else, and add the *unforeseen* section if anything happened that
the rules do not cover.
