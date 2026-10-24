# Website adapters

ProfilePilot provides 18 structured read operations across eight websites. The
extension CLI, Gateway CLI, and built-in Agent share the same catalog and page
read implementation. Requests execute inside the selected browser session;
there is no Node HTTP crawler, cookie export or second browser identity.

## Interfaces

- `ppilot browser sites [SITE]` lists operations and JSON schemas locally.
- `ppilot browser --session TASK site --params-file request.json` uses the
  extension's owned task tab.
- `ppilot browser --session TASK --cdp PORT site --params-file request.json`
  uses an already-connected Gateway session.
- Built-in Agent tools: `site_adapters({site?})` and
  `site_read({operation, params})`.

See [the distributed Agent reference](../skills/profilepilot/references/site-adapters.md)
for the complete operation list and examples. Site membership is not a promise
of future availability; check the actual result and live validation evidence.

## Data and control contract

Results carry `source`, `effective`, `items`, `pagination`, `completeness`, and
`status` (`ok`, `empty`, `partial`, `blocked`, `error`). Missing schemas, denied
requests and unfinished page loads cannot become empty successful results.
`pagination.next` is a complete next parameter object. Large numeric identifiers
are preserved as strings before JSON parsing loses precision.

Adapters only read data or open read UI. Native ownership and generation checks
run between steps. A takeover or unknown transport outcome stops execution;
the runner does not automatically resume, reacquire or switch Profiles. The
Agent's origin policy is checked before navigation, after redirects, and for
the Bilibili API origin. Previous DOM action references are invalidated.

Some results are deliberately partial: preview replies do not represent an
entire comment tree; loaded Xiaohongshu comments do not represent every page;
SMZDM prices are offer text and require SKU/coupon/checkout verification. BOSS
can fall back to visible cards/JD, with missing salary or gated text reported.
YouTube uses the page's own transcript loader when available, then reads its
existing segments and precise timestamps. It does not transcribe audio.

## Implementation

- `src/main/site-adapters/catalog.ts`: operation schemas, routes and host checks.
- `page.ts`: browser fetch, page state and DOM extraction.
- `boss-dom.ts`: explicit visible-page fallback.
- `prepare-page.ts`: bounded transcript loading using the page's own code or UI.
- `xiaohongshu-page.ts`: guarded native search routing and verified sort controls.
- `runner.ts`: navigation, readiness, control checks and timing.
- `gateway-cli.ts`: existing authenticated Gateway session integration.

The implementation was written independently. bb-browser/bb-sites informed the
design discussion, but their adapter source was not copied into this project.
No third-party adapter package is bundled.

## Verification and measurement

`node scripts/verify-site-adapters.mjs --session TASK` runs read-only live smoke
checks. `--details` uses the actual candidate IDs/URLs from the search artifacts.
`--params-file` accepts a UTF-8 JSON array of operations, including a Windows BOM.
The development runner flag is for development only; delivery verification must
also exercise the service's real `site` method and packaged CLI.

`node scripts/benchmark-site-adapters.mjs --session TASK --rounds 2` compares a
real model with generic DOM tools versus the same tools plus adapters. Both
conditions start from equally warmed result pages, read the list first, and
return five distinct titles and URLs. The order alternates. Model usage comes
from actual SDK responses, including separately recorded cache reads. Raw
results preserve unsuccessful trials and tool output sizes.

`node scripts/report-site-adapter-benchmark.mjs ARTIFACT_DIRECTORY` writes JSON,
CSV and standalone HTML. A pair only contributes to performance conclusions if
both conditions return the same five items and the generic DOM evidence supports
their title/link pairs. Other pairs require review; finish-call success alone
does not prove task success. These list tests do not establish detail-reading,
power consumption, all-website success rate, or macOS performance.

Windows uses the same TypeScript implementation as macOS; file input accepts BOM
and uses no Unix-only subprocesses. macOS requires a separate physical-machine
run before reporting measured platform results.

Unit/integration checks: `tests/site-adapters.test.js`,
`tests/site-adapter-integration.test.js`, and `scripts/verify-sdk-runtime.mjs`.
The real SDK verifier checks that both site tools survive schema conversion and
that nested operation parameters pass through MCP unchanged. With the currently
bundled SDK/Zod versions, a passthrough object is used for the MCP `params` schema;
strict per-operation validation still happens in the catalog before execution.

### Local acceptance, 2026-10-24

All 18 operations returned real, nonempty data through the updated native
service's `site` method on Windows and the selected signed-in Chrome Profile.
Both the installed CLI and built-in Agent expose the catalog. An additional
Xiaohongshu note verified positive comments; the first note correctly returned
an explicitly empty list. Raw attempts are retained in
`artifacts/site-adapters/coverage-final.json` and its referenced files.

The final check also encountered transient Bilibili/BOSS connection failures
and a YouTube transcript load failure. After inspecting the actual page,
separate subsequent reads succeeded. This is evidence of current functionality,
not a claim of uninterrupted availability or automatic recovery.

The benchmark used `deepseek-flash`, two alternating-order pairs per site:
32 actual model runs, 16 pairs, three generic runs reaching the turn limit.
Five pairs met the independent content check. Conditional on those five pairs:

| Site | Verified / attempted pairs | Elapsed time reduction | Tokens reduction, including cache reads |
| --- | --- | --- | --- |
| Bilibili | 1 / 2 | 41.1% | 79.3% |
| BOSS | 1 / 2 | 11.8% | 45.6% |
| 什么值得买 | 1 / 2 | 29.8% | 89.0% |
| Zhihu | 2 / 2 | 19.2% median | 61.7% median |

These figures exclude 11 incomparable or incomplete pairs and must not be
presented as an overall improvement rate. Reddit's API search ranking differed
from the webpage; Xiaohongshu and Sogou WeChat were not consistently faster.
YouTube's generic runs did not finish within the limit. None of these four sites
has a verified percentage improvement in this experiment. Cache-inclusive token
counts are context usage, not an equivalent reduction in billing or energy.
The full HTML/JSON/CSV report is in `artifacts/site-adapters/benchmark-v1/`.

Validation passed: full regression run (2,098 passed, three skipped), final
adapter checks (16 passed), real SDK tool/schema checks, plugin packaging,
and the isolated Gateway/Electron fixture including structured reads and user
handoff. The separate headless Chrome Gateway fixture exited during browser
startup on this Windows machine, before adapter assertions; it is not counted
as a passed compatibility test. Real Chrome extension reads were verified.
macOS and energy consumption remain unmeasured.

### Xiaohongshu comparison and update, 2026-10-24

The reviewed reference is [bb-sites xiaohongshu/search.js at
fce0d3a](https://github.com/epiral/bb-sites/blob/fce0d3a0a955137004eb5cd24aedb302d7596004/xiaohongshu/search.js).
`scripts/compare-xiaohongshu-adapters.mjs` accepts a separately reviewed local
`--upstream-file` and executes that function in the same owned Chrome tab through
the same ProfilePilot extension transport. It does not install bb-browser or
measure its CLI/extension overhead. Upstream code is retained only in ignored
local artifacts and is not shipped. The downloaded source SHA-256 is
`cfa46b9459f6261382b263a28af60ac4736d4b2bbcc75e29efe4bcc1c7072da8`.

Each trial resets and warms the page equally before timing; the reset is excluded.
Two keywords and alternating execution order cover reading an already-loaded
list versus changing the keyword. The original complete comparison is retained
in `artifacts/xhs-adapter-comparison/before-v2/summary.json`:

| Scenario | Previous ProfilePilot adapter | Reviewed bb-sites search function |
| --- | --- | --- |
| Read loaded list | 61 / 85 ms | 5,160 / 5,257 ms |
| Change keyword | 6,491 / 5,899 ms | 5,467 / 4,176 ms |

The upstream function always starts a search and captures its network response.
In these four trials it returned 20 candidates but left the page's feed store and
visible cards empty. Missing titles occurred in both implementations. A new
search can change personalized ranking, so differing titles do not establish
better accuracy. The observations support borrowing its page-native search
approach, not replacing every warmed read with an unconditional new request.

ProfilePilot now keeps fast reads of already-loaded results and uses the site's
router plus search input/context for a changed keyword. It observes completion
of the native loader before accepting candidates. Missing loader capabilities
fall back to regular navigation; failure or timeout does not return the old list.
Sort values `general`, `latest`, `likes`, `comments`, and `collects` select the
verified native filter control. Results include the actual `effective.filters`
and `effective.sortVerified`; `searchContext.sort` alone is insufficient evidence
because the site can retain a stale value there. No fetch/XHR interception is
added. The implementation uses cross-platform TypeScript and page code; only
Windows has been measured.

Candidates include rank and explicit `titleStatus`. Missing titles stay null;
Agent/Skill guidance discourages redundant whole-page reads to fill a title
absent from the source. Requested details remain a separate operation. This
guidance has not yet been rebenchmarked as an end-to-end model/token improvement.

The updated development runner completed changed-keyword reads in 1,252 / 1,069 ms
and loaded-list reads in 77 / 70 ms. Each returned 20 candidates with all 20 IDs
independently found in the rendered page. All five sort modes were verified
against the live page's active filters, with nonempty results. Raw evidence is
in `artifacts/xhs-adapter-comparison/improved-v2/` and `sort-development.json`.
These small samples measure adapter latency, not full Agent task time, power
consumption, long-term reliability, or bb-browser's complete runtime.

Final delivery verification used the rebuilt native service's `site` method,
not the development runner. Loaded reads took 63 / 59 ms; changed-keyword reads
took 1,612 / 1,541 ms. All four returned 20 candidates, with all 20 IDs found in
the rendered page. Mean changed-keyword latency was 74.6% lower than the two
original ProfilePilot trials; this is a small-sample observation, not a guaranteed
speedup. See `artifacts/xhs-adapter-comparison/final-service/summary.json`.

The installed CLI separately verified all five sorts, each with 20 matching DOM
IDs and the expected live filter value, in `sort-final-cli.json`. The build,
21 adapter/integration tests, real SDK/MCP verification and three plugin package
tests passed. The updated desktop application was launched independently using
the Windows Explorer bootstrap, with build ID starting `65c1a54812c81b18`;
its installed CLI matched the rebuilt bundle. No macOS timing or new full-model
comparison is included in this follow-up.
