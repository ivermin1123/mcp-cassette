# Reality check

Measured 2026-08-16 against the thresholds frozen in
[`00-kill-criteria.md`](00-kill-criteria.md) before any repository was fetched.
Read Law №1 there first: this is Apache-2.0 OSS with no buyer, and every number
below answers *"is this worth more of the owner's months"*, never *"can this be
sold"*.

---

## BÀN GIAO

| | |
|---|---|
| **Rơi vào ô nào** | **DỪNG LẠI** — cả ba tính năng đều rơi vào Box C ("đã có người chiếm"). Theo luật phán quyết đã khoá: *all three features DEAD → STOP*. |
| **Tỉ lệ trường (b)** | **52.5% chặt / 56.3% lỏng** (83 / 89 trên 158 server). Ngưỡng là **<15% VÀ <12 repo**. Không chạm ngưỡng, thậm chí không gần. **Box A KHÔNG kích hoạt.** |
| **Tính năng rủi ro bị nuốt nhất** | **`replay`** — nhưng không phải bởi hạ tầng chính thức. In-memory transport của SDK chỉ chiếm 19.2% trong nhóm có test giao thức (ngưỡng 50% → Box B KHÔNG kích hoạt). Thứ nuốt nó là **mcp-observatory** (MIT, npm `@kryptosai/mcp-observatory`, 80 bản phát hành, hơn cassette 5 tháng tuổi) — có `record`/`replay`/`verify` và một lớp `RecordingTransport` ghi JSON-RPC vào thứ chính họ gọi là *cassette*. An toàn nhất là **`check` poisoning**, và "an toàn nhất" ở đây vẫn là bị chiếm — bởi `snyk/agent-scan` (Apache-2.0, ★2913). |
| **Điều làm tôi đổi ý nhất** | Tôi vào cuộc đo với giả thuyết của chính bộ tiêu chí: *"chưa ai test MCP ở tầng giao thức"*. Sai hẳn — hơn một nửa đã làm. Cái giết dự án là điều ngược lại hoàn toàn với thứ bộ tiêu chí được dựng để bắt: **chỗ này không trống, nó đông** — cassette là người thứ tư, và trẻ nhất 5 tháng. Ba người đi trước: `agent-vcr` (2026-02, ★7, chết sau đúng một ngày commit), `mcp-recorder` (2026-02, ★9, đứng im từ tháng 3), `mcp-observatory` (2026-03, ★176, còn sống, đẩy commit hôm qua). |
| **Một câu** | **DỪNG** — không phải vì không ai cần (56% chứng minh ngược lại), mà vì đúng ba việc này đã có người làm xong, miễn phí, và làm trước 5 tháng. |

---

## 1. What was measured

**Sample: 158 public MCP servers.** Frozen frame was four sources, selection by
signal not stars. 227 units drawn deterministically (md5 of the repo name as the
sort key, quotas per source), 221 fetched, 180 alive after the frozen cut-off
(no commit since 2026-02-16, not archived), 22 excluded as meta-repos, closed
source, or carrying no MCP surface. Owner cap of 5 never bound — the most
concentrated owner had 3.

Languages: TypeScript 72, Python 43, JavaScript 13, Go 9, Rust 9, Java 2, PHP 2,
other 8. Median stars 170. Comfortably past the frozen minimum of 80 units, and
past the required mix (≥8 TS-JS, ≥6 Python, ≥2 other).

**Method.** File trees pulled from the GitHub API, then test files, manifests,
workflows and snapshot candidates fetched raw and pattern-matched, then
hand-checked. Two measurement defects were found and repaired mid-sweep; both
are described in §6 because they moved the decisive number by a lot.

---

## 2. Field results

| Field | Result | Class |
|---|---|---|
| **a. has tests** | 138 / 158 (87.3%) | supporting |
| **b. protocol-layer tests** | **83 strict / 89 loose (52.5% / 56.3%)** | **killing input (Box A)** |
| b1 real transport | 88 of the 89 | — |
| b2 in-process request | 1 additional | — |
| b2b FastMCP in-process `call_tool` (*not counted*) | 2 additional | see §6 |
| b3 direct callback only (*not counted*) | 2 | — |
| no tests at all | 20 | — |
| **c. how live APIs are avoided** | SDK in-memory transport 16 · HTTP mock library 8 · hits live creds 5 · rest: no explicit avoidance | supporting |
| **d. committed tool-surface snapshot** | **2–3 / 158 (~1.5%)** | supporting |
| **e. CI runs the tests** | 81 / 158; 56 of the 83 protocol-layer ones | supporting |
| **f. tool renamed/removed** | ~8–12 genuine cases in changelogs; only 2 mention deprecation or notice | supporting |
| **g. protocol revision declared** | 16 / 158 | supporting |
| **h. downstream user pain** | **2–3 public cases** → below 8 | **no signal — kills nothing** |

### b — the decisive field

Frozen definition: a test that **produces and consumes an MCP JSON-RPC message**.
Counted b1 (real `Client` + transport, or raw JSON-RPC frames) and b2
(`server.request(...)`-style: a real request built and schema-validated).
Excluded b3 (reaching into the registry to call a callback) and mere string
mentions.

Representative evidence, all `path:line`:

- `modelcontextprotocol/python-sdk` — `tests/server/test_lowlevel_tool_annotations.py:38` → `tools_result = await client.list_tools()`
- `google-gemini/gemini-cli` — `integration-tests/mcp_server_cyclic_schema.test.ts:85` → builds an in-test MCP server speaking JSON-RPC and drives the real client
- `D4Vinci/Scrapling` — `tests/ai/test_ai_mcp.py:596` → `tools = {tool.name: tool for tool in (await client.list_tools()).tools}`
- `voska/hass-mcp` — `tests/test_protocol.py:21` → `from mcp.shared.memory import create_connected_server_and_client_session`
- `payloadcms/payload` — `test/plugin-mcp/int.spec.ts:118` → `await client.listTools()`
- `calllint/calllint` — `packages/calllint-mcp/test/server.test.ts:19` → `handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize" }, ...)` — the textbook b2 case
- `subnetmarco/pgmcp` — `server/streamable_transport_test.go:52` → posts `{"jsonrpc":"2.0","method":"tools/list","id":1}`

**Hand-check, 20 units, stratified as frozen (5 official / 5 popular / 5 mid /
5 tail).** 13 positives read in full: 11 true, 2 false — `nukeop/nuclear`
(`FakeStreamServer.ts:68`, an HTTP fake, no MCP) and
`rohitg00/kubectl-mcp-server` (`proxy.test.ts:26`, which *mocks* the SDK
transport rather than driving it). 7 negatives read: at least 1 false —
`payloadcms/payload` genuinely calls `client.listTools()` but sits under 2,199
test files and was missed. So the error runs both ways at a similar rate,
roughly 15%, and they largely cancel. Honest bracket for field (b): **45–60%**.

### d — almost nobody locks their tool surface

Filename matching returned noise (Drizzle migration snapshots, UI `.snap` files,
docs called "contract"), so this was re-measured by content: a committed file
carrying tool names next to `inputSchema`, twice or more. Eight files matched;
most are copies of the **MCP spec schema**, not a snapshot of the server's own
surface — `modelcontextprotocol/python-sdk` → `schema/2025-11-25.json`,
`ProAgentStore/platform` → `workers/mcp/src/mcp-schema-2025-11-25.json`. Only
`sampleXbro/agentsmesh` → `tests/contract/__golden__/lessons-frozen-api.json`
and `vikramgorla/mcp-swiss` → `docs/tools.schema.json` look like an actual
own-surface lock.

**So: ~56% test through the protocol, and ~1.5% lock the contract.** That gap is
the single most interesting number in this report, and §4 explains why it does
not save `snapshot --check`.

### f — the breakage is real, the notice is not

37 changelog lines matched rename/removal language near "tool"; reading them,
roughly 8–12 are genuine tool-surface changes and only 2 carry any deprecation
or notice. The sharpest:

- `ChiR24/Unreal_mcp` — `CHANGELOG.md:50` → "Static `unreal` gateway tool **replaces 23-tool public surface**" — twenty-three tools gone, no deprecation window in the entry
- `genomoncology/biomcp` — `CHANGELOG.md:712` → "Breaking MCP runtime change: renamed the MCP execution tool from `shell` to …"
- `aashari/mcp-server-atlassian-jira` — `CHANGELOG.md:32` → "feat!: replace domain-specific tools with generic HTTP method tools"
- `cyanheads/pubmed-mcp-server` — `CHANGELOG.md:143` → "DX renames on `pubmed_format_citations`"
- `jiezeng2004-design/PatchWarden` — `CHANGELOG.md:458` → "No Core/Direct tools deleted or renamed." — someone volunteering the promise, which is itself evidence the worry exists

### h — no signal, and that kills nothing

Systematic issue search across GitHub for downstream users breaking on a surface
change turned up 2–3 genuine cases:

- [`guillempuche/batuda#401`](https://github.com/guillempuche/batuda/issues/401) — "a stale client tool list can still call fourteen names the server removed"
- [`microsoft/azure-devops-mcp#1448`](https://github.com/microsoft/azure-devops-mcp/issues/1448) — "Local MCP tools rename breaks `allowed-tools` for skills and `tools` for agents"
- [`pallaprolus/mendeley-mcp`](https://github.com/pallaprolus/mendeley-mcp) — breaks on `mcp` 2.0.0 (an SDK break, not a tool-surface one — borderline)

Below the frozen 8. Per Law №1(a) and Box E this is recorded as **"no signal"**
and is **not** evidence against anything. It appears nowhere in the verdict.

---

## 3. Swallow scan

Read from source and released artefacts, not guessed.

**Official SDKs — in-memory transport yes, record/replay no, contract diff no.**

- TypeScript: `packages/core-internal/src/util/inMemory.ts`. The SDK also split into `@modelcontextprotocol/server` and `@modelcontextprotocol/client` v2.0.0 (published 2026-04-01; 2.97M and 1.64M weekly downloads), alongside `@modelcontextprotocol/sdk` v1.30.0 (35.1M weekly).
- Python: `src/mcp/shared/memory.py`, `src/mcp/client/_memory.py`.
- Neither tree contains anything matching record, replay, cassette, or contract diff.

**MCP Inspector V2** ([repo](https://github.com/modelcontextprotocol/inspector), ★10,669, `@modelcontextprotocol/inspector` 2.2.0, 176k weekly) rewrote into Web + CLI + TUI, with the CLI aimed at "automation, CI, and fast agent feedback loops". In the tree: `core/mcp/toolOutputValidation.ts` and an `OutputValidationModal` (validating tool *output* against `outputSchema`), and a `ReplayButton` that re-fires a single call in the UI. **No baseline diff, no session record/replay to a file, no tool-description lint.**

**Spec.** [SEP-1575 "Tool Semantic Versioning"](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1575) was **closed as dormant** on 2026-06-26 after a 90-day inactivity ping — MCP has no tool-surface versioning. The [2026-07-28 spec](https://blog.modelcontextprotocol.io/posts/2026-07-28/) does add a formal deprecation policy with a twelve-month window, but that governs the *protocol's own* methods and types, not each server's tools. The gap `snapshot --check` addresses is genuinely open at the spec level.

**Other tools doing this job — the part that decides everything.**

| Tool | What it does | Free? | Age vs cassette | Size |
|---|---|---|---|---|
| [`KryptosAI/mcp-observatory`](https://github.com/KryptosAI/mcp-observatory) | `record` · `replay` · `verify` · `lock` · `diff` · `scan` · SARIF · PR comments · GitHub Action | MIT | **5 months older** (2026-03-19) | ★176, 80 npm releases (v1.36.5), 5 contributors, 680 weekly dl, action at v1.28.0 |
| [`snyk/agent-scan`](https://github.com/snyk/agent-scan) (ex Invariant `mcp-scan`) | prompt injection in tool descriptions, tool poisoning, shadowing, toxic flows, `--ci` gate | Apache-2.0 | **16 months older** (2025-04-07) | ★2913, pushed daily |
| [`devhelmhq/mcp-recorder`](https://github.com/devhelmhq/mcp-recorder) | "lightweight **proxy** that records and replays MCP server interactions" | OSS | 6 months older (2026-02-16) | ★9, stalled since 2026-03-24 |
| [`Jarvis2021/agent-vcr`](https://github.com/Jarvis2021/agent-vcr) | record/replay/diff `.vcr` cassettes, TS+Python | OSS | 6 months older (2026-02-09) | ★7, created and abandoned the same day, npm 0.1.0, 4 weekly dl |
| [`MCPJam/inspector`](https://github.com/MCPJam/inspector) | inspect/debug/evaluate MCP servers | OSS | 15 months older | ★2139 |

mcp-observatory was verified in source, not taken from its README:
`src/transport/recording-transport.ts` is a `Transport` decorator recording every
JSON-RPC message into entries it calls `CassetteEntry`;
`src/transport/replay-transport.ts`, `src/lockfile.ts`, `src/schema-diff.ts`
(with severity tiers high/medium/info for removed tools, added required fields,
removed properties, type changes), `src/commands/{record-replay,lock,diff}.ts`,
and 83 test files.

**Ranking the three features by swallow risk:** `replay` highest — three prior
implementations, one alive and bundled into a bigger product. `snapshot --check`
next — same tool, plus the self-write argument in §4. `check` safest, and still
occupied, by a scanner with 2,913 stars and Snyk behind it.

---

## 4. Applying the frozen criteria

### Box A — "the market does not exist" → **DOES NOT FIRE**

Requires **both** `<15%` and `<12 repositories`. Measured **52.5%** and
**83 repositories**. Not close on either leg. Under Law №1 the honest reading is
that testing an MCP server through the protocol is already a mainstream habit,
not a frontier.

### Box B — "swallowed by infrastructure" → **DOES NOT FIRE** (with a defect noted)

**B-replay:** among the 83 protocol-layer testers, **16 use an official SDK's
in-memory / linked transport = 19.2%**. Threshold was ≥50%. Does not fire.

**Defect in the frozen criteria, reported rather than resolved in my favour:**
B-general says a *shipped* in-memory transport swallows whatever feature it
covers, and both SDKs do ship one — read strictly, that clause fires on `replay`
while B-replay's 19.2% says it does not. The two clauses of the same box
contradict. The specific rule (B-replay, written explicitly about this question)
should govern the general one, and in any case `replay` is already dead by
Box C, so the contradiction changes no outcome. It is recorded so a later reader
can fix the criteria rather than discover this again.

**B-general (ii) and (iii):** no official SDK and not the Inspector ships session
record/replay or contract diffing. Does not fire.

### Box C — "someone already occupies it" → **FIRES ON ALL THREE**

Conditions: same job for MCP · free or already in hand · installable today from a
published release · and more established.

| Feature | Occupier | Same job | Free | Installable | More established |
|---|---|---|---|---|---|
| `replay` | mcp-observatory (`record`/`replay`/`verify`, RecordingTransport) | ✓ | MIT | npm v1.36.5 | 5 mo older, 80 vs 5 releases, ★176 vs ★0, 5 vs 1 contributors |
| `snapshot --check` | mcp-observatory (`lock` + `diff` + `schema-drift` with severity tiers) | ✓ | MIT | npm v1.36.5, action v1.28.0 | as above |
| `check` poisoning | snyk/agent-scan; also observatory's `scan` | ✓ | Apache-2.0 | `uvx snyk-agent-scan@latest` | 16 mo older, ★2913 vs ★0 |

All three occupied. **Killing, per feature.**

### Box D — "the lazy-install barrier" → fires on nothing, but nearly took `snapshot --check`

- `replay`: a recording proxy plus a standalone replay server is not 50 lines. Does not fire.
- `snapshot --check`: this one is genuinely close. 56% of these servers already have an MCP client inside a test, and for them the naive version is **one line** — `expect(await client.listTools()).toMatchSnapshot()`. What survives Box D is not the snapshotting but the **classification**: stable rule IDs and breaking/dangerous/minor tiers that a CI policy can be written against. That is a frozen-listed valid reason ("a CI artifact and gate policy"), so the box does not fire — but the feature's real value is one layer up from where its name suggests, and mcp-observatory's `schema-diff.ts` already ships severity tiers of its own.
- `check` poisoning: a maintained rule catalogue is explicitly a reason that counts. Does not fire.

### Box E — "real demand" → **no signal, kills nothing**

2–3 public cases against a threshold of 8. Recorded and dropped. It contributed
nothing to the verdict, by construction.

### Verdict

Frozen rule 1: **STOP** if all three features are DEAD.

| Feature | B | C | D | Verdict |
|---|---|---|---|---|
| `replay` | no | **FIRES** | no | **DEAD** |
| `snapshot --check` | no | **FIRES** | no | **DEAD** |
| `check` poisoning | no | **FIRES** | no | **DEAD** |

→ **STOP.**

Said plainly, because the criteria demand the box be named even when it is this
one: as measured against thresholds fixed before the data, mcp-cassette does not
justify more months. Not because nobody tests MCP servers — over half do — and
not because nobody complains, which proves nothing. Because all three things it
does already exist, free, in tools that are older, more released, and more
contributed to.

---

## 5. Evidence classes used

**Killing evidence in this report:** exactly one kind — Box C occupancy, resting
on released artefacts and verified source files of mcp-observatory and
snyk/agent-scan.

**Supporting evidence, which moved nothing on its own:** field (b) at 52.5%
(which argues *for* continuing and defused Box A), the 1.5% snapshot rate, the
8–12 silent tool renames, the CI rate, the absence of downstream complaints.

**Never used:** silence. Box E returned "no signal" and appears in no verdict
line.

---

## 6. Outside the boxes (not blended into any threshold)

1. **Two measurement defects, both found by hand-checking, both reported because they moved the decisive number.** The first sweep read at most 18 test files per repository, chosen largely by size — a lottery in a repo with 985 or 2,199 test files, and biased against exactly the large repos most likely to test properly. Re-scanning by MCP relevance in the path, 60 files deep, moved field (b) from 40.5% to 56.3%. The opposite error then appeared: generic JSON-RPC matches from `aiohttp.ClientSession`, a fake **LSP** server and fake **ACP** servers. Requiring MCP-specific evidence in the same file brought it to 52.5%. Both repairs implement the frozen definition; neither changed a threshold.
2. **A bucket the criteria do not describe: FastMCP in-process `call_tool`.** Two servers test via `await mcp.call_tool(name, args)` — schema-validated, error-mapped, but no JSON-RPC message is ever produced. It fits neither b2 (no request built) nor b3 (nothing bypassed). Counted separately and excluded from the threshold, which the rationale supports: no message means nothing for a cassette to record.
3. **Box C has no quality bar.** It asks whether an occupier does the same job, not whether it does it well. mcp-observatory's capability was verified from source; its *output* was never run or compared against cassette's. The STOP verdict therefore rests on capability parity, not demonstrated quality parity. This is a defect in the criteria, stated rather than used as an escape.
4. **The occupier has a commercial funnel.** mcp-observatory's README offers an "MCP Release Gate Pilot" at $15,000. Under Law №1(b) this changes nothing — the core is MIT and free, which is precisely what makes it dangerous — but the owner should know the incentive shape behind the free tool.
5. **The pattern in the graveyard is the most actionable thing here.** Of four MCP record/replay tools, the two that were *only* recorders (`agent-vcr` ★7, `mcp-recorder` ★9) both stalled within weeks. The one still alive bundles recording with a security scan and a CI gate. Recording alone does not hold users; the gate does. mcp-cassette already has all three — it is simply five months late to a place someone else reached with the same combination.
6. **cassette's own adoption numbers are too young to mean anything.** Repository created 2026-08-15, 0 stars, 0 forks, 1 contributor, 411 npm downloads that are almost certainly CI and registry crawlers. Under Law №1(1) this is "too early to tell", not a failure, and it is not used as evidence anywhere above.
7. **One real architectural difference was found and not weighed**, because Box C does not ask for it: observatory's recorder is a `Transport` decorator you wire into your own code, while cassette's `record` is a standalone proxy and `replay` a standalone server binary any client can point at, in any language. Whether that difference is worth a competing project is a judgement the frozen criteria cannot make.

---

## 7. Self-critique — where this sample is wrong

**MCP is young, so "nobody does X" can mean "not yet" rather than "never".** This
cuts hardest at field (d): 1.5% locking their tool surface could be an absent
habit rather than an absent need, and the 8–12 silent renames in §2 suggest the
need exists ahead of the habit. **Conclusion that does not survive this bias:**
any reading of the 1.5% as "contract locking is unwanted". **Conclusion that
does survive:** the 52.5% protocol-layer rate, which is a measurement of what
people already do, not of what they have not got to yet.

**Public repositories are not enterprise internal servers.** The servers where a
silent tool rename hurts most — the internal ones wrapping a company's own
systems, consumed by a company's own agents — are invisible here by
construction. That biases field (h) toward zero and field (d) toward zero.
**Which is exactly why Box E was fenced as supporting-only before the data
arrived**, and it is the main reason the "no signal" result must not be read as
absence of need.

**The sample is skewed toward repositories that publish.** Servers appear in a
GitHub topic, an npm keyword or an awesome list because someone wanted them
found. Those are more likely to be maintained and tested than the median MCP
server on someone's laptop. Field (b) is therefore probably an **over**-estimate
of the whole population. **Does it matter?** No. The threshold is 15%; the
measurement would have to be wrong by a factor of three and a half in the
adverse direction to reach it.

**The false-positive rate is real and I quantified it rather than assumed it.**
About 15% in each direction, cancelling. Field (b)'s honest bracket is 45–60%.
**Every conclusion drawn from field (b) survives the whole bracket**, because the
distance to the threshold is enormous. This is the one number in the report I
would defend without qualification.

**The verdict, by contrast, is fragile in a specific way.** It rests entirely on
Box C, which rests on one repository — mcp-observatory — being what its source
files say it is. I verified the source exists and is substantive (real transport
decorators, a real schema differ with severity tiers, 83 test files, 5
contributors, 80 releases). I did **not** install it, run it against a real
server, or compare its output to cassette's. If it turns out to be impressive
scaffolding that does not work, Box C loses its strongest occupier for `replay`
and `snapshot --check` — though `check` would still be occupied by snyk/agent-scan
independently, and the verdict would move from STOP to NARROW rather than to
CONTINUE. **This is the single check most worth doing before acting on this
report.**

---

## Unresolved questions

1. Does mcp-observatory actually work? Running `npx @kryptosai/mcp-observatory record/replay/diff` against a real server, and comparing its findings to `mcp-cassette snapshot --check`, is the one experiment that could move this verdict.
2. Is the standalone-proxy architecture (any language, no code wiring) worth a project on its own, given observatory's decorator approach requires touching the server's own code? The frozen criteria have no box for "same job, different shape".
3. Field (h) is structurally unmeasurable from public repositories. Is there a way to see whether internal enterprise MCP servers break their consumers — or should that question simply be dropped rather than answered with public-repo silence?
4. `snapshot --check` survived Box D only on its classification layer, not on snapshotting. Is the rule-ID and severity-tier design genuinely better than observatory's `schema-diff.ts` tiers, or merely different?
