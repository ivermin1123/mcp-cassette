# Reality check

Measured 2026-08-16 against the thresholds frozen in
[`00-kill-criteria.md`](00-kill-criteria.md) before any repository was fetched.
Read Law №1 there first: this is Apache-2.0 OSS with no buyer, and every number
below answers *"is this worth more of the owner's months"*, never *"can this be
sold"*.

---

## BÀN GIAO

> **Cập nhật sau khi chạy thí nghiệm quyết định (§8).** Bản đầu của báo cáo này
> kết luận **DỪNG**, dựa trên README và mã nguồn của đối thủ mà chưa cài, chưa
> chạy. Đã cài và chạy cả ba đối thủ. **Phán quyết đổi thành NARROW.** Phần dưới
> là kết luận sau thí nghiệm; §8 ghi lại đã chạy gì và cái gì lật.
>
> **Hiệu chỉnh sau phản biện coordinator (§9).** Coordinator chỉ ra §8 vẫn bỏ sót
> hai lệnh của đối thủ, vì tôi đọc `--help` qua `head -35` và bị cắt. Đã chạy lại
> `lock create`/`lock verify` và `audit`. Phán quyết tổng **không đổi**, nhưng
> cửa thoát cuối của `snapshot --check` đóng lại, và con số 4/6 giờ đến từ đúng
> cổng bảo mật của họ chứ không phải một lệnh không nêu tên.

| | |
|---|---|
| **Rơi vào ô nào** | **NARROW** (thu hẹp). Một tính năng chết, hai tính năng sống. Luật đã khoá, áp theo thứ tự: quy tắc 1 (STOP) không kích hoạt vì chỉ 1 trong 3 chết; quy tắc 3 (NARROW) kích hoạt. Chết: **`snapshot --check`**. Sống: **`replay`** và **`check` poisoning**. |
| **Tỉ lệ trường (b)** | **52.5% chặt / 56.3% lỏng** (83 / 89 trên 158 server). Ngưỡng là **<15% VÀ <12 repo**. Không chạm ngưỡng, thậm chí không gần. **Box A KHÔNG kích hoạt.** |
| **Tính năng rủi ro bị nuốt nhất** | **`snapshot --check`** — và nó đã bị nuốt thật, không phải "rủi ro". mcp-observatory chạy `test` rồi `diff --fail-on-schema-drift high` bắt đủ cả ba thay đổi tôi cố tình gài (xoá tool, thêm tham số bắt buộc, thêm tham số tuỳ chọn), phân đúng tầng high/high/info, thoát mã 1 khi có trôi và 0 khi không. Chạy được ngay sau khi cài. An toàn nhất là **`replay`** — vì lý do ngược với điều tôi viết ở bản đầu: `replay` của observatory **không phải replay**, nó chạy kiểm tra của chính nó offline rồi trả báo cáo văn bản; không client nào cắm vào được. |
| **Điều làm tôi đổi ý nhất** | Hai lần, ngược chiều nhau. Lần một: tôi vào cuộc với giả thuyết của chính bộ tiêu chí — *"chưa ai test MCP ở tầng giao thức"* — và sai hẳn, hơn một nửa đã làm. Lần hai, và mạnh hơn: **đọc mã nguồn đối thủ không thay được việc cài nó xuống và bấm chạy.** Tôi đã thấy `recording-transport.ts`, `replay-transport.ts`, `record`/`replay` trong `src/commands/` của observatory và kết luận `replay` bị nuốt. Cài xuống thì CLI **không có lệnh `record` lẫn `replay`** — chúng chỉ tồn tại dưới dạng MCP tool cho agent, và `replay` không phục vụ cassette như một server. Một phán quyết DỪNG suýt được ký dựa trên danh sách tên file. |
| **Một câu** | **ĐI TIẾP, nhưng hẹp lại** — bỏ `snapshot --check` (đã có người làm xong, chạy được, hơn 5 tháng tuổi), dồn thời gian vào `replay` và `check`, là hai chỗ chưa ai làm xong mà không kèm điều kiện. |

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

**Ranking the three features by swallow risk, after running them (§8):**
`snapshot --check` highest, and no longer a risk but a fact — observatory does
it today, correctly, out of the box. `check` next: constrained on both sides,
but neither competitor closes it (agent-scan needs a Snyk account, observatory
caught 4 of 6). `replay` safest, for the opposite of the reason this section
originally gave — observatory's `replay` is not a replay at all, and the one
tool that does replay properly ships broken.

The observatory row above lists capability as its source tree and README present
it. The gap between that and what the shipped CLI exposes is the subject of §8:
`record` and `replay` exist in `src/`, and in observatory's **MCP tool surface**
for agents, but **not as CLI commands**. `lock` likewise appears only as the
`lock_verify` MCP tool. Of that row, the commands a CI job can actually call are
`test`, `diff`, `verify`, `scan` and `watch`.

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

### Box C — "someone already occupies it" → **FIRES ON ONE OF THREE**

Conditions: same job for MCP (adjacent does not count) · free or already in hand
· installable today from a published release · **and** more established. The
frozen text adds the release valve that decides two of these three rows: *"If it
exists but is **partial**, newer, or smaller: contested, recorded as
supporting-against, not killing."*

Every row below was settled by installing the tool and running it (§8), not by
reading its README.

| Feature | Candidate occupier | Same job? | Free / in hand? | Runs today? | Verdict |
|---|---|---|---|---|---|
| `replay` | mcp-observatory | **No** — its `replay` runs *observatory's own checks* against the cassette and prints a report; nothing external can connect. Also not a CLI command, only an MCP tool for agents. | MIT | yes | condition 1 fails → **not an occupier** |
| `replay` | mcp-recorder | Yes — `replay` really does start a mock MCP server from a cassette | OSS | **No.** A clean `pip install` crashes on start (`Starlette.__init__() got an unexpected keyword argument 'on_startup'`); only ran after manually pinning `starlette<0.42`. HTTP-only, no stdio. Stalled since 2026-03-24. | **partial → contested, not killing** |
| `replay` | agent-vcr | claims record/replay/diff | OSS | npm 0.1.0, 4 weekly downloads, created and abandoned on 2026-02-09 | **contested, not killing** |
| `snapshot --check` | mcp-observatory | **Yes** — `test` then `diff --fail-on-schema-drift high` caught all three planted changes at the right severities and gated correctly | MIT | **yes**, straight after install | **OCCUPIED → KILLING** |
| `check` poisoning | snyk/agent-scan | Yes on paper | Apache-2.0 source, but **the analysis refuses to run without a `SNYK_TOKEN`**; the only offline mode (`inspect`) verifies nothing and flagged none of four poisoned tools | not without a Snyk account | condition 2 fails in substance → **contested, not killing** |
| `check` poisoning | mcp-observatory | Partly — caught 4 of 6 findings; missed the exfiltration description and the malformed JSON Schema | MIT | yes | **partial → contested, not killing** |

**One feature occupied: `snapshot --check`.**

### Box D — "the lazy-install barrier" → fires on nothing, but nearly took `snapshot --check`

- `replay`: a recording proxy plus a standalone replay server is not 50 lines. Does not fire.
- `snapshot --check`: this one is genuinely close. 56% of these servers already have an MCP client inside a test, and for them the naive version is **one line** — `expect(await client.listTools()).toMatchSnapshot()`. What survives Box D is not the snapshotting but the **classification**: stable rule IDs and breaking/dangerous/minor tiers that a CI policy can be written against. That is a frozen-listed valid reason ("a CI artifact and gate policy"), so the box does not fire — but the feature's real value is one layer up from where its name suggests, and mcp-observatory's `schema-diff.ts` already ships severity tiers of its own.
- `check` poisoning: a maintained rule catalogue is explicitly a reason that counts. Does not fire.

### Box E — "real demand" → **no signal, kills nothing**

2–3 public cases against a threshold of 8. Recorded and dropped. It contributed
nothing to the verdict, by construction.

### Verdict

| Feature | B | C | D | Verdict |
|---|---|---|---|---|
| `replay` | no | no | no | **ALIVE** |
| `snapshot --check` | no | **FIRES** | no | **DEAD** |
| `check` poisoning | no | no | no | **ALIVE** |

The frozen rules, applied mechanically and in order:

1. **STOP** — needs all three DEAD, or Box A plus ≥2 DEAD. One is dead and Box A
   did not fire. **Does not apply.**
2. **AUDIENCE-LIMITED** — needs all three ALIVE and Box A firing. **Does not apply.**
3. **NARROW** — ≥1 ALIVE and ≥1 DEAD, rule 1 having not fired. **Applies.**
4. CONTINUE would also be satisfied on its own terms (2 ALIVE, Box A quiet), but
   the rules are applied in order and rule 3 fires first. **NARROW governs.**

→ **NARROW.** Continue on `replay` and `check`. Stop spending time on
`snapshot --check` — including the schema-diff completeness work sitting open in
[`BACKLOG.md`](../../BACKLOG.md) — regardless of how finished it already is.
That is the frozen rule's own wording, and it is the part that costs something.

Said plainly: mcp-cassette does justify more months, on two of its three
features. Not because anybody has complained — nobody has, and that proves
nothing — but because over half of public MCP servers already test through the
protocol, and the two surviving features are things no free tool does today
without an asterisk.

---

## 5. Evidence classes used

**Killing evidence in this report:** exactly one kind — Box C occupancy of
`snapshot --check`, resting on mcp-observatory being installed, run against a
planted breaking change, and observed to gate correctly (§8).

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

**The verdict was fragile in a specific way, and that fragility has now been
resolved — against the first verdict.** The original STOP rested entirely on
Box C, which rested on one repository being what its source files said it was.
I had verified the source existed and was substantive; I had not installed it.
Installing it moved the verdict from STOP to NARROW, exactly as this paragraph
originally predicted it might, and for reasons the prediction got wrong: not
because observatory is scaffolding — it works well — but because **the shipped
CLI does not expose the features its source tree contains**, and because
snyk/agent-scan turns out to need a vendor account. §8 has the record.

**What is fragile now** is the poisoning comparison. The poisoned fixture in §8
was written by me from cassette's own documented rule list, so it is biased in
cassette's favour by construction; observatory catching 4 of 6 on *my* fixture
is weaker evidence than it looks. A fixture drawn from an independent corpus —
or from observatory's own rule list — could easily reverse the ratio. The two
misses are at least concrete and independently checkable (an exfiltration
instruction naming `~/.ssh/id_rsa` and a collector URL; an `inputSchema` with
`type: "nonsense-type"`), but one hand-built fixture is not a coverage study.

---

## 8. The bake-off — what was actually run

Everything in §4's Box C table comes from here. Two throwaway MCP servers were
built as fixtures: `server-v1` with three tools (`add`, `slugify`, `greet`), and
`server-v2` planting three contract changes — `slugify` removed, `add` gaining a
**required** `precision`, `greet` gaining an **optional** `mode`. A third,
`server-poisoned`, carries four attack shapes plus one malformed schema. Both
tools were installed from their published releases into a clean directory, the
way a user would get them.

### Contract drift — the one cassette loses

```
mcp-cassette snapshot --check
  [BREAKING]  slugify: tool removed (tool-removed)
  [BREAKING]  add: parameter "precision" is now required (input-property-became-required)
  [BREAKING]  add: parameter "precision" added (required) (input-property-added-required)
  [DANGEROUS] greet: parameter "mode" added (input-property-added-optional)
  → exit 1

mcp-observatory diff --fail-on-schema-drift high
  add     (tools, high): added required field 'precision', added property 'precision'
  slugify (tools, high): removed
  greet   (tools, info): added property 'mode'
  → exit 1     (and exit 0 on an unchanged control run)
```

Same detections, same severity ordering, working gate, out of the box. One trap
worth recording: `--fail-on-regression` — the obvious-looking flag — exits **0**
here, because a removed tool counts as schema drift, not as a regression. The
flag that works is `--fail-on-schema-drift`. Anyone benchmarking observatory with
the wrong flag would wrongly conclude its gate is broken. Mine nearly did.

Observatory's workflow is heavier (run `test` twice, keep both artifacts, then
`diff`) against cassette's one command versus one committed file. Box C asks
whether it does the same job, not whether it is as pleasant. It does.

### Replay — where the README and the shipped CLI disagree

The `mcp-observatory --help` command list contains **no `record` and no
`replay`**. Its `verify` needs a live server and rejects a run artifact with
`Invalid cassette file … Expected { version: 1, entries: [...] }` — a format no
CLI command produces. Pointing cassette at observatory's own MCP server
(`mcp-cassette check --stdio "npx @kryptosai/mcp-observatory serve"` → 13 tools,
clean) shows where they went: `record` and `replay` ship as **MCP tools for an
AI agent**, not as commands for a CI job or a test suite.

Driven through that MCP surface, both work — `record` captured 17 entries — but
`replay` returns *observatory's own health report*, replayed offline:

```
Replay of node (17 entries):
  [pass] tools: Advertised capability responded with the minimal expected shape (3 items).
  [pass] tools-invoke: 3 tool(s) found but none are safe to invoke …
```

That is not what `replay` means here. The decisive test: **rename the real
server file away**, then connect a plain official-SDK client to
`mcp-cassette replay session.cassette.jsonl`:

```
connected to: mcp-cassette replay
tools/list → 3 tools: add, slugify, greet
real server process launched: NO (only the replay binary)
```

The cassette *is* the server. Any client, any language, any test suite.
Observatory offers no equivalent — so on this feature it is not doing the same
job, and Box C's first condition fails.

`mcp-recorder` does do the same job — with the real server renamed away, an
official-SDK client connected to `mcp-recorder replay --port 5557` and got all
three tools. Two caveats keep it in the "partial" column: it replays over
**HTTP only** (most servers in the sample are stdio), and a clean
`pip install mcp-recorder` produces a tool that **crashes on start** against
current Starlette; it ran only after manually pinning `starlette<0.42`.

### Poisoning — and the account gate

On `server-poisoned`, cassette reported 5 errors and 1 warning with stable rule
IDs (`CAS-L001` instruction override, `CAS-L003` concealment, `CAS-L005`
sensitive material and exfiltration target, `CAS-L006` invisible Unicode,
`CAS-L012` command execution, `CAS-C005` invalid JSON Schema), exit 1.
Observatory found 4 — instruction override, stealth instruction, hidden Unicode,
command execution — verdict `quarantine`, exit 1. It did not flag the
`sync_notes` exfiltration description, and its schema-quality check rated the
malformed `type: "nonsense-type"` schema as *info*, not an error.

`snyk/agent-scan` never got that far. Both `scan --ci` and plain `scan` stop at:

```
To use Agent Scan, set the SNYK_TOKEN environment variable.
```

Its one offline mode, `inspect`, listed the four tools and verified nothing. A
2,913-star Apache-2.0 scanner that cannot lint a server without registering for
a vendor account is not "free and already in their hands" in the sense Law №1(b)
means, so it does not occupy this feature — though it plainly constrains how
much room is left in it.

**Fixture bias, stated up front:** `server-poisoned` was written from
mcp-cassette's own documented rule list. It is biased in cassette's favour and
should be read as "observatory misses these two specific shapes", never as a
coverage score.

---

## 9. Hiệu chỉnh sau phản biện coordinator

Coordinator chỉ ra hai lỗ. Cả hai đều đúng, và cả hai đều do **cùng một sai lầm
tôi đã tự ghi vào §8 rồi vẫn mắc lại**: kết luận về đối thủ dựa trên thứ mình
nhìn thấy, chứ không phải thứ mình chạy. Lần này cơ chế khác — không phải đọc
README, mà là **cắt output**.

Không mở đợt đo mới, không đổi tiêu chí đã khoá. Chỉ chạy hai phép thử.

### 9.0 Gói đã cài — xác minh trước, vì mọi thứ khác phụ thuộc vào nó

Coordinator cảnh báo gói npm tên trần `mcp-observatory` là placeholder. Đã kiểm:
gói tên trần là `1.0.0`, `bin: null`, mô tả *"MCP Observatory - Coming Soon"*.
Gói tôi đã cài và chạy suốt §8 là `@kryptosai/mcp-observatory@1.36.5`, đúng gói
coordinator xác nhận. **Không phải cài nhầm, nên không phải đo lại từ đầu.**

### 9.1 Lỗi gốc: `head -35`

Cả hai lỗ có chung một nguyên nhân. Tôi đọc danh sách lệnh bằng
`--help | head -35`, và nó cắt đúng sau `setup-ci`. Chín lệnh biến mất khỏi tầm
nhìn của tôi: **`lock`**, **`audit`**, `enforce`, `receipt`, `risk-graph`,
`attack-sim`, `skill-scan`, `cloud`, `smithery`.

Mọi câu trong §8 nói observatory "không có" một thứ gì đó đều được viết dựa trên
danh sách bị cắt đó. §8 tự cảnh báo về việc dùng sai flag rồi vẫn dùng sai lệnh.

### 9.2 LỖ 1 — `lock create` / `lock verify`: lợi thế công thái học KHÔNG TỒN TẠI

Chạy thật trên đúng server mồi cũ:

```
mcp-observatory lock create --config ./cfg.json     → .mcp-observatory/lock.json
mcp-observatory lock verify --config ./cfg.json     → exit 0   (không đổi gì)
# trỏ cfg sang v2 (hợp đồng đã đổi)
mcp-observatory lock verify --config ./cfg.json     → exit 1
    → tools/slugify: removed
    → tools/add: schema changed
    → tools/greet: schema changed
```

Đếm, không cảm nhận:

| | lệnh để đi từ zero tới "CI đỏ khi hợp đồng đổi" | file phải commit |
|---|---|---|
| `mcp-cassette` | **2** (`snapshot`, `snapshot --check`) | **1** (`mcp-contract.snapshot.json`) |
| `mcp-observatory` | **2** (`lock create`, `lock verify`) | **2** (`cfg.json` + `lock.json`) |

**Cùng số lệnh. Chênh đúng một file cấu hình** — và file đó là MCP config chuẩn,
thứ nhiều dự án đã có sẵn.

Kết luận §8 rằng họ cần "hai run artifact" là **sai**: đó là mô tả đường `diff`,
là đường duy nhất tôi tìm thấy vì `lock` đã bị `head -35` cắt mất. **Lợi thế công
thái học mà báo cáo nêu không tồn tại**, và câu hỏi mở #2 của §8 — "có đáng giữ
`snapshot --check` sống như một quyết định cố ý đè lên tiêu chí không" — mất căn
cứ. Cửa thoát duy nhất của `snapshot --check` đóng lại. Phán quyết **CHẾT** cho
tính năng này không đổi, nhưng bây giờ nó đứng vững hơn trước, không phải yếu đi.

Một khác biệt còn lại, ghi làm quan sát và **không** nâng thành cửa thoát mới:
`lock verify` báo `tools/add: schema changed`, còn `snapshot --check` báo
`[BREAKING] add: parameter "precision" is now required (input-property-became-required)`
— có tầng và có rule ID ổn định. Đó là khác biệt về độ mịn của đầu ra, không phải
về quy trình, và một mình nó không lật được ô Box C.

### 9.3 LỖ 2 — chạy lại bằng `audit`: vẫn 4/6, nhưng lần này có nêu tên lệnh

§8 viết "observatory bắt 4 trên 6" mà **không nói đã chạy lệnh nào** — tự vi phạm
tiêu chuẩn mà chính §8 đặt ra. Con số đó đến từ `test --security`. Cổng bảo mật
thật là `audit`.

Chạy lại trên đúng fixture độc cũ:

```
mcp-observatory audit --profile nsa-mcp --fail-on-high node server-poisoned.mjs   → exit 1
```

Lưu ý cách gọi: truyền lệnh server thành **argv rời**. Truyền dạng chuỗi trong
ngoặc kép (`"node …"`) làm audit không dựng nổi phiên stdio và trả về
`run/fatal-error` — đúng cái bẫy §8 đã ghi với `--fail-on-regression`, gặp lại
lần thứ hai trong cùng một buổi.

Đối chiếu trên 6 dạng đã gài:

| # | dạng gài | `audit` | rule của họ |
|---|---|---|---|
| 1 | ghi đè chỉ thị (`read_notes`) | ✔ | `attack-sim/tool-poisoning/hidden-instruction` |
| 2 | chỉ thị giấu người dùng (`read_notes`) | ✔ | `attack-sim/tool-poisoning/stealth-instruction` |
| 3 | rút dữ liệu ra URL ngoài (`sync_notes`) | ✘ | — không finding nào nhắc `sync_notes` |
| 4 | Unicode tàng hình (`summarize`) | ✔ | `unicode-obfuscation-description` |
| 5 | lệnh shell trong mô tả (`summarize`) | ✔ | `shell-injection` |
| 6 | `inputSchema` không hợp lệ | ✘ | chỉ `info` "missing description" |

**Vẫn 4/6, và sót đúng hai chỗ cũ.** Đã thử profile khác: chỉ tồn tại một profile
(`nsa-mcp`) — công cụ tự trả lời `Available profiles: nsa-mcp`.

Vậy điểm "`check` SỐNG" **không phải hạ**. Nhưng lý do phải sửa: §8 dựa vào
`test --security` và không nói ra; giờ nó dựa vào cổng bảo mật thật, có nêu tên
lệnh, và ra cùng con số.

### 9.4 Fixture độc vẫn là bằng chứng yếu nhất

Kết quả không đổi chiều, nên không có gì để cám dỗ. Nhưng ghi lại cho rõ: fixture
vẫn do tôi viết từ danh sách rule của mcp-cassette, vẫn thiên vị theo cấu tạo,
và việc nó sống sót qua một lần chạy lại bằng lệnh đúng **không** nâng nó lên
hạng bằng chứng mạnh. Câu hỏi mở #1 giữ nguyên.

### 9.5 Điều mục này đổi và không đổi

| | trước hiệu chỉnh | sau |
|---|---|---|
| Phán quyết tổng | NARROW | **NARROW** (không đổi) |
| `snapshot --check` | CHẾT, còn một cửa thoát công thái học | **CHẾT**, cửa thoát đã đóng |
| `check` poisoning | SỐNG, đếm 4/6 từ lệnh không nêu tên | **SỐNG**, đếm 4/6 từ `audit`, có nêu tên |
| `replay` | SỐNG | **SỐNG** (không có phép thử mới) |

Việc code đi theo: schema-diff dừng hẳn sau khi vá xong hai defect đã tái hiện
được. Chi tiết trong [BACKLOG.md](../../BACKLOG.md).

---

## Unresolved questions

1. Would an independently-authored poisoned corpus reverse the 6-versus-4 result? The §8 fixture was built from cassette's own rule list, so the poisoning comparison is the weakest evidence in this report.
2. ~~`snapshot --check` is dead by the frozen rule, but cassette's one-command-against-a-committed-file workflow is genuinely lighter than observatory's two-artifact diff. Is that worth keeping alive as a deliberate override?~~ **Answered and closed in §9.2:** the premise was wrong. `lock create` / `lock verify` is also one command against one committed file, so there is no ergonomic gap to override the criteria for.
3. Field (h) is structurally unmeasurable from public repositories. Is there a way to see whether internal enterprise MCP servers break their consumers — or should that question simply be dropped rather than answered with public-repo silence?
4. Observatory's `record`/`replay` exist as MCP tools today and are one release away from being CLI commands. If they surface, `replay` moves from ALIVE to occupied. How much warning would that give, and is there anything worth doing before it happens?
