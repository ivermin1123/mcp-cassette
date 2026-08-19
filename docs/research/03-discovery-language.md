# Discovery language

Measured 2026-08-19, against the shipped surfaces rather than against intent.

The safety lint is the deepest thing in this project. It is also the thing least
likely to be found, because every surface described it in the vocabulary of its
own implementation and never once in the vocabulary of the problem it solves.
The phrase `prompt injection` appeared zero times in prose across the README,
the site, and `llms.txt`. `flaky` and `untrusted` appeared zero times anywhere.

This is a discovery defect, not a feature defect. Nothing here changes behavior.

---

## HANDOVER

| | |
|---|---|
| **The fact** | Record/replay covers the language of its problem well (`credential` 18, `offline` 8, `deterministic` 7, `rate limit` on all four surfaces). The safety lint did not: `prompt injection` 0 in prose, `flaky` 0, `untrusted` 0. |
| **The cause** | The homepage described the lint as "instruction overrides, concealment directives, exfiltration URLs, invisible Unicode". Every word is accurate. No one searches for any of them. |
| **What changed** | Four prose insertions across `README.md`, `docs/index.html`, `docs/replay/index.html`, `docs/llms.txt`. The technical sentences were kept and added to, never replaced. |
| **What did not change** | `package.json`, any behavior, any rule, any exit code, any `--help` string. No release was cut. |
| **Deferred** | Two `package.json` keywords, `agent` and `vcr`. Pending the next release cut, not abandoned. See section 5. |
| **What this does not do** | It does not create demand. It raises the odds of being found by someone already looking for this category. The project still has 0 external users. |

---

## 1. Method

The phrases were written down **before** any project file was opened. That
ordering is the whole method: a list drawn up while reading your own README is
a list of the words already there.

The list was drawn from how the problem gets described by the people who have
it, not from how this project implements it:

```
prompt injection · injection · poison · flaky · untrusted · deterministic
offline · credential · rate limit · agent · vcr
```

Then a script counted each phrase, case-insensitively, across every surface a
person or a machine reads:

| Surface | Read by |
|---|---|
| `README.md` | people, GitHub search, model training data |
| `docs/index.html` | people, web search |
| `docs/replay/index.html` | people, web search |
| `docs/llms.txt` | agents |
| `package.json` description + keywords | the npm registry search box |

HTML had `<style>` and `<script>` bodies dropped, tags stripped, and entities
unescaped before counting, so a phrase counts where a reader would read it and
never inside markup. A second pass dropped code blocks and `<pre>` bodies, which
is the pass that mattered: a phrase that appears only inside a sample output is
not prose, and a person skimming the page will not see it.

The script is a scratch instrument and is not committed. It is about sixty
lines and reproducing it is cheaper than maintaining it.

## 2. Coverage, before and after

Prose only, with code blocks and `<pre>` bodies removed. Measured 2026-08-19,
before and after the four insertions in section 4.

| phrase | README | index.html | replay/ | llms.txt | package.json | total |
|---|---|---|---|---|---|---|
| `prompt injection` | 0 → 1 | 0 → 1 | 0 | 0 → 1 | 0 | **0 → 3** |
| `injection` | 0 → 1 | 0 → 1 | 0 | 0 → 1 | 0 | **0 → 3** |
| `poison` | 6 | 3 | 0 | 2 → 3 | 0 | 11 → 12 |
| `flaky` | 0 | 0 | 0 → 1 | 0 | 0 | **0 → 1** |
| `untrusted` | 0 | 0 → 1 | 0 | 0 → 1 | 0 | **0 → 2** |
| `deterministic` | 2 | 1 | 0 | 0 | 0 | 3 |
| `offline` | 6 | 0 | 0 | 0 | 0 | 6 |
| `credential` | 9 | 6 | 2 | 1 | 0 | 18 |
| `rate limit` | 1 | 2 | 1 | 1 | 0 | 5 |
| `agent` | 4 → 5 | 3 → 4 | 0 | 1 → 2 | 0 | 8 → 11 |
| `vcr` | 0 | 0 | 0 | 0 | 1 | 1 |

No count went down. The record/replay rows were already healthy and were not
touched.

Read the two halves of that table against each other. The rows that were
already full are the rows where the project happened to describe its problem in
the same words its users would. The rows that were empty are the rows where it
described its solution instead. Nobody chose either; it just came out that way,
which is the argument for measuring rather than judging.

## 3. Why the empty cells were empty

**An agent builds a query from the problem. A person types the category.**
Neither of them types your implementation.

The homepage sentence for the lint read:

> `check` lints tool descriptions for the known shapes of tool-poisoning
> attacks (instruction overrides, concealment directives, exfiltration URLs,
> invisible Unicode)

Every term in it is correct, and it is a better sentence than most projects
write about their own security features. It also matches no query anybody
issues, because "concealment directives" is a name for the mechanism arrived at
while implementing it. The person with the problem types `prompt injection`.
The agent asked to harden an MCP client constructs something closer to
`untrusted tool description agent reads as instructions`.

So the rule applied here was: **add the words they type next to the sentence
you already wrote, and never in place of it.** Precision is not traded for
findability. If an edit made a sentence less accurate, the edit was dropped.

### The too-narrow-pattern trap

Every empty cell was rechecked with a wider pattern before being called absent,
and this caught two false results in one sitting:

| First pattern | Verdict | Wider pattern | Actual |
|---|---|---|---|
| `tool poisoning` | absent | `poison` | present on three surfaces (`poisoning`, `poisoned`, `tool-poisoning`) |
| `prompt injection` | 1 hit, in README | `prompt.injection` | the hit is `prompt-injection`, hyphenated, inside a SARIF sample |

The second correction made the finding worse than the report that prompted this
work. The single README occurrence was believed to be `prompt injection` inside
a JSON sample. It is `prompt-injection`, hyphenated, so the space-separated form
people actually type was at **zero across the entire project**, not one. It also
sits in generated output rather than prose, copied from a rule description in
`src/lint-rules.ts`, which is a second reason it was never going to be read.

A narrow pattern produces a confident false negative, and a false negative here
costs an edit to a sentence that did not need one.

## 4. What was changed

Four insertions. Each adds to a sentence and replaces none of it.

**`docs/llms.txt`**, the machine-readable surface, so it took priority:

> That lint is the prompt injection check: a tool description is untrusted
> input an agent reads as instructions, so `check` looks for the instruction
> overrides, concealment directives and exfiltration URLs a tool-poisoning
> attack needs to work.

**`docs/index.html`**, inside the existing "Catch poisoned tools" bullet,
directly after the mechanism list and before the "Heuristics, not proofs"
caveat, which still ends the bullet:

> That is prompt injection with the payload in the tool description rather than
> the user's message: untrusted text your agent reads as instructions and a
> user rarely sees at all.

**`README.md`**, in the safety pitch:

> Prompt injection does not need a user to type it; it arrives in the tool
> description your agent was never going to show anyone.

**`docs/replay/index.html`**, one word inserted into the existing sentence about
what a real server costs a test suite:

> credentials in CI, rate limits, **flaky** network failures you did not
> schedule, state that survives runs, and a counterparty free to change its
> answers without telling you

That last one is the smallest edit in this document and possibly the highest
value one. `flaky` is the word people use for the symptom, and the sentence
describing the symptom did not contain it.

### The sentences that could not be touched

Some positioning sentences live on more than one surface at once, including
inside `src/`, where they are `--help` output. Editing one of those is a code
change, and a code change means cutting a release, which was out of scope. Each
candidate sentence was grepped through `src/` first, both verbatim and with a
widened pattern:

| Sentence | Also lives in | Ruling |
|---|---|---|
| `check`: "validate handshake and schemas, lint tool descriptions for poisoning" (`docs/llms.txt`) | `src/cli.ts`, the `check` command description | **Not edited.** Near-verbatim twin of `--help`. New prose was added elsewhere in the file instead. |
| "...lints tool descriptions for poisoning" (README, `docs/index.html`, `docs/llms.txt` opening) | fragment shared with `src/cli.ts` | **Clause not rewritten** on any surface. Additions were made as new sentences after it. |
| "instruction-override phrasing (classic prompt-injection)" (README SARIF sample) | `src/lint-rules.ts`, a rule description | **Not edited.** It is generated output quoted into a code block. |

Verbatim grep alone cleared all of these, which would have been the wrong
answer. `src/cli.ts` carries the same sentence with one word different
("lint **its** tool descriptions"), and only the widened pattern found it. This
is the section 3 trap again, in the one place where falling for it would have
forced an unplanned release.

## 5. Deferred to the next release cut

`package.json` keywords are currently:

```
mcp, model-context-protocol, testing, mock, record, replay, cassette,
contract-testing, ci
```

Two are missing, and the registry search box is the one surface where a keyword
is the entire index:

- **`agent`.** It appears 11 times in prose after this change and 0 times in the
  keywords. The npm registry is where an agent-authoring developer looks for
  tooling, and this is the word they scope the search with.
- **`vcr`.** It is in the `description` but not the keywords. It is the prior
  art everyone in this category already knows by name, and the fastest way to
  explain the tool to somebody who has never heard of MCP recording.

**This is pending, not abandoned.** Changing keywords means publishing a new
version, and this project is deliberately frozen. Add both at the next release
cut, whenever one happens for a real reason.

## 6. Limits, stated plainly

**This only helps someone who is already looking.** It raises the probability
of being found by a person or an agent searching for this category. It does not
create demand for the category, and no amount of vocabulary work will.

**The project still has 0 external users.** That number is unchanged by this
document and was never going to be changed by it. The honest claim is narrow:
the deepest feature in the repository is no longer invisible to the search that
should lead to it.

**Coverage is not ranking.** Counting occurrences measures whether a phrase is
present. It does not measure whether the page ranks for it, whether the phrase
appears somewhere an index weights, or whether anyone runs that query at all.
No ranking was measured, and claiming any would be inventing a number.

**A rule count was carried in that does not match the source.** The brief for
this work described the lint as having 23 rules. What is in the repository is
**16** stable rule ids, in `src/lint-rules.ts` and in the README table, and the
two agree. Where 23 came from was not resolved here; the figure appears in this
project's own history only inside the body of
[#65](https://github.com/ivermin1123/mcp-cassette/pull/65), which was already
arguing that "23 against 4" did not compare like with like. Counting the regex
literals in the same file gives 22, which is close enough to be a plausible
origin and is not evidence. No depth claim is restated on that basis, and the
neighbor comparison was not re-measured in this document.
