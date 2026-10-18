# Data freshness and verification

DATA evidence: `logs/data/`. Overnight handoff: `Data/Logs/brief-overnight-20261016/lanes/DATA-proof.md`. Observation dates and reporting periods are distinct from file generation time. A quote cannot update a filing period or a fitted model.

| Dataset | Provider and cadence | Freshness rule | Failure behavior |
|---|---|---|---|
| Selected company quotes | Finnhub through Worker; 30-second cache | Live only when provider observation <=1 minute; original UTC remains visible | Per-symbol errors and retained dated quote; no invented zero |
| Whole-universe quotes | Finnhub primary, Yahoo delayed fallback; paced sweep | Audit <=20 minutes during regular hours; latest completed close outside hours | Retain old observations with stale/missing labels; receipt counts missing names |
| Core prices, ranges and returns | Yahoo unadjusted daily bars | Latest completed equity session | Keep last-good snapshot if coverage regresses |
| P/E, PEG, market cap, beta | Yahoo quoteSummary snapshot | Dated daily retrieval; vendor definitions remain separate | Null/unavailable with reason when absent |
| CPI, PPI, payrolls, unemployment | BLS/FRED, monthly | Compare reference month with latest independently fetched FRED month | Missing/stale observations remain labeled |
| PCE | BEA/FRED, monthly with longer publication lag | Latest released reference month; month start is not release date | Retain reporting period |
| GDP | BEA/FRED, quarterly with revisions | Latest released quarter; quarter start is not release date | Retain vintage/reference period |
| Claims, Fed balance sheet/reserves | FRED, weekly | Latest source date, with weekly lag allowance | Explicit source failure |
| Treasury yields, volatility, cross-asset | Treasury/Cboe/Yahoo, daily | Source-specific observation dates, not retrieval dates | Delayed Yahoo proxies remain distinct from official daily series |
| Company statements | Quarterly/annual filings; daily cache refresh | Latest filed SEC 10-Q/10-K period, not today's date | Missing data stays unavailable; SEC verification failures fail the audit |
| Brief, company workspaces, intelligence | Deterministic daily build | Snapshot and model periods checked independently | Atomic last-good preservation; failed/degraded refresh receipt |
| Manager disclosures | SEC 13F; full daily collector only | Latest 13F quarter after 45-day filing window; original filing dates shown | Original manager data is preserved by news-only updates |
| News | Finnhub market/shortlist and Federal Reserve; news-only half-hour workflow | Publication and upstream retrieval dates shown separately; market/company expiry 4 days, official 30 days | Per-source failure, partial retention and expiry; no sentiment or inferred price causality |
| Historical screener scores | Retained original snapshot | Original July 25 date and stale label | Never restamped as a current score |

The quote producer uses at least 1.22 seconds between Finnhub starts, with no burst: fewer than 50 starts per rolling minute. The Worker shares eight starts per rolling minute and 8,000 per UTC day across both sites. Client scheduled jobs mirror canonical data, preventing a second 510-name sweep on the same key. See `LIVE-DATA.md` for the browser JSON/error contract.

## Actual observations on October 16, 2026

Quote workflow run [38889384969](https://github.com/soham-porwal/smartoptions-brief/actions/runs/38889384969) succeeded. The published response had 509 Finnhub quotes, seven Yahoo quotes and two missing among 518 requested symbols. It made 511 paced Finnhub requests in 624.396 seconds. That proves authentication, pacing and hosted publication; it occurred before the US open. Per-quote timestamps show the October 15 close. Median age was 896.8 minutes, expected overnight; the oldest outliers remain separately stale. Local source now prefixes the health line with market-closed/session context.

The workflow is active. Cron requests every eight minutes in UTC hours 13-21 on weekdays, plus off-hours clock checks at minute 17. Serial concurrency and provider sweep duration mean an eight-minute cron does not guarantee eight-minute publication. In the observed API history there were no scheduled runs, only two manual dispatches and a failed push-triggered run. The prior successful manual dispatch was 07:22Z; the new proof dispatch was 10:46Z. This is an observed manual-run gap, not a measured scheduler cadence. **Market-hours schedule latency remains unproven; measure after 13:30Z (06:30 PT).**

Live curl evidence is in `logs/data/worker-quotes-preview.json`, `worker-quotes-client.json` and their header files. AAPL/NVDA/SPY came from Finnhub with October 15 20:00Z observations. Production CORS origins work. The local-test origin returned 403; the Worker entry-point change is assigned to the conductor because `worker.js` is outside DATA's fence.

The independent 30-number sample (`logs/data/accuracy-preview.json` and `.md`) matched 24 values within explicit tolerances: six prices, five P/E values, six 52-week endpoints, four macro observations and three sector returns. Six company revenue-growth/margin checks are **unverified**, because SEC companyfacts returned HTTP 403. The script exits 1. Fresh Yahoo ratio/range requests are same-provider checks and are labeled accordingly. Sector returns use fresh individual closes with fixed snapshot cap weights, never ETF substitutes.

Initial public audits are retained in `logs/data/freshness-preview*` and `freshness-client*`. They fail for absent public intelligence/money-flow/refresh-receipt files and unavailable SEC verification; individual hidden-age findings are in their JSON/Markdown reports. A successful labeling audit does not imply fresh data: inspect `stale_labeled` separately.

The 11:10Z full audit checked 6,268 preview fields (6,257 fresh, 11 failures) and 6,268 client fields (6,259 fresh, nine failures). Preview's additional hidden-age findings were EQR and WBD observations from September 4 and October 5. The quote publication safeguard now labels observations outside the advertised cadence even if the provider calls them current. The delayed `^TNX` proxy also needs a stale label under the advertised equity-close rule; its instrument-specific clock is not assumed. A follow-up clock-only workflow dispatch applies those labels without another Finnhub sweep. See the latest proof log for that run and post-delivery audit.

Follow-up quote run [38892220986](https://github.com/soham-porwal/smartoptions-brief/actions/runs/38892220986) succeeded. The published JSON now labels EQR, WBD and `^TNX` stale without changing their original observation dates. The 11:14Z post-delivery preview audit recorded 6,257 fresh, three stale-labeled and eight failures: three absent published datasets and five SEC reference checks blocked by 403. Evidence: `logs/data/freshness-preview-post-labels.json` and `.md`.

## Refresh receipt

`data/refresh-status.json` uses `smartoptions.refresh.v1`. `status` is `ok`, `degraded` or `failed`. `attempted_at`/`finished_at` date the attempt; `asof_session`, `model_asof` and `source_dates` date the observations. `stages` records success/failure/skipping per stage. `publication_changed=false` and `previous_snapshot_preserved=true` mean the old dataset remains available. `reasons` explains degradation. Source dates in a failed receipt describe the retained snapshot, explicitly labeled by `source_dates_basis`.

The initial committed receipt comes from a real local refresh into a private DATA candidate. It explicitly discloses that public app datasets were not promoted by DATA. First validation found an overly strict counterargument guard: AMP's revisions improved, removing a prior negative counterargument. The guard now checks underlying data dimensions. A subsequent real run hit the stricter source contract: a sector P/E median lacked `asof`. That generator fix is outside DATA's fence. Both failures preserved the previous dataset. Stage evidence is in `logs/data/local-refresh/` and `brief-rerun-debug.txt`.

Daily workflow run [38890801903](https://github.com/soham-porwal/smartoptions-brief/actions/runs/38890801903) reached the new runtime preflight and failed because `_pipeline/requirements-refresh.txt`, `_pipeline/smartoptions/refresh.py` and `_pipeline/config/brief.yaml` were absent. Workflow deployment alone is insufficient. The conductor must install the allowlisted runtime below, then rerun. No claim of successful daily hosted refresh is made.

The second local run also logged Yahoo DNS failures (`query2.finance.yahoo.com`) and 368 rows without retrieval metadata. The source contract refused a sector-median metric with absent `asof`; no incomplete candidate was promoted. This PC network observation does not prove the hosted runner will fail. Do not bypass the validation check to force a publication.

## Install another Pages edition

Run these from the source checkout with the existing venv Python. DATA did not touch the reference repositories.

```powershell
$runtime = 'D:/soham/myeverything/Code/smartoptions/v2/.venv/Scripts/python.exe'
# Preview: remove --dry-run only when the conductor installs the runtime.
& $runtime scripts/install_refresh_pipeline.py --destination D:/soham/myeverything/Code/smartoptions-brief-pages --repo-slug soham-porwal/smartoptions-brief --dry-run
# Client: verify the existing delivery checkout and branch before installation.
& $runtime scripts/install_refresh_pipeline.py --destination D:/soham/myeverything/Code/smartoptions/delivery-pages --repo-slug samsej/sp500-screener-dashboard --dry-run
& $runtime scripts/install_refresh_pipeline.py --destination D:/soham/myeverything/Code/smartoptions/delivery-pages --repo-slug samsej/sp500-screener-dashboard
```

The installer copies Python runtime sources, allowlisted config/fixture/docs, requirements, the portable quote script and all three workflows. It never stages, commits, pushes, or deletes. Dry-run validates without writes. Review and commit only `_pipeline/`, `scripts/gh_quotes_refresh.py`, `.github/workflows/brief-refresh.yml`, `.github/workflows/quotes.yml`, `.github/workflows/news-refresh.yml`. Record the prior commit first. The private runtime/cache/logs must stay out of the Pages artifact; workflows exclude `_pipeline` and internal directories.

Preview producer secrets by name: `FINNHUB_API_KEY` required for real-time sweep; `FRED_API_KEY` optional (public free fallbacks exist). `APCA_API_KEY_ID`/`APCA_API_SECRET_KEY` are optional IEX fallback credentials, not required. A client mirror requires none of these provider secrets. GitHub Actions needs contents write and Pages write/id-token permission; repository Pages must use Actions. No secret value belongs in source files or receipts.

Daily cron is `45 22 * * 1-5`, after the US cash close in both DST variants. The client downloads a hash-verified canonical snapshot bundle and preserves last-good data on failure. Quotes use the separate shared producer/mirror workflow. Manual daily refresh shares the quote concurrency lock; running it during market hours can delay the static sweep, while the Worker fast path remains independently budgeted.

```powershell
gh workflow run brief-refresh.yml -R soham-porwal/smartoptions-brief
gh run list -R soham-porwal/smartoptions-brief --workflow brief-refresh.yml --limit 3
# Only after canonical success and P0 gates, conductor may run the client mirror.
gh workflow run brief-refresh.yml -R samsej/sp500-screener-dashboard
```

Rollback uses a normal new revert commit of the installation/data change and the same Pages deployment path. Preserve the recorded previous commit and run artifacts; never reset/force-push or delete the old dataset. Disable only the newly installed refresh workflow if it repeatedly fails; the quote workflow and last-good public data remain independently available. The installer has no automatic rollback mutation.

## Repeatable checks

```powershell
& $runtime scripts/freshness_audit.py https://soham-porwal.github.io/smartoptions-brief/ --output logs/data/freshness-preview-latest
& $runtime scripts/freshness_audit.py https://samsej.github.io/sp500-screener-dashboard/ --output logs/data/freshness-client-latest
& $runtime scripts/accuracy_sample.py https://soham-porwal.github.io/smartoptions-brief/ --output logs/data/accuracy-preview-latest
```

All scripts return nonzero on blocked verification. Reports list field, source, observation/reference date, cadence or tolerance, and cause. Network failures and zero-result responses never pass silently. The audit uses standard NYSE holidays/typical early closes; exceptional closures require calendar maintenance. It does not infer a fresh observation from a new build timestamp.


## Price delivery correction — 2026-10-16

The visible path and authenticated static sweep share one Worker cache and limiter: 58 upstream starts per rolling minute (account response independently reported 60/min), at most 30 starts per rolling second, 30-second cache. Idle sweep capacity can be used by the visible path. The 40,000/day counter is our abuse guard, not a claimed Finnhub daily entitlement. The full 509-name file remains a paced snapshot; cron is best effort and interactive demand can lengthen a sweep.

The phone header reports per-name counts, for example 8 live / 2 older quotes. Live still requires a <=60-second observation. An older quote is a <=15-minute same-session report returned by a successful source check within75seconds; it is not relabeled live. Original trade and successful-check timestamps are distinct, and cache hits update neither. Denial/network errors remain source-wait/unavailable, with dated last observations retained. Deep-old observations are unavailable as current fields. Visible symbols refresh on navigation/viewport changes, foreground, pageshow/BFCache return, focus and the Data health refresh button.

Shared-file ages are recalculated against the current clock for the active universe; preserved inactive/reference records are counted separately. The fundamentals/macro snapshot receipt describes its own build, separately from current quote delivery. Price milestone proof: Data/Logs/brief-client-recovery-20261016/PRICE-NOW-PROOF.md. Full analytics acceptance remains pending.


## Recurring news-only completion (source runtime)

`news-refresh.yml` requests canonical collection at UTC minutes 23 and 53 every hour, including weekends. The client installation mirrors at minutes 03 and 33 so its usual run follows the canonical collection; manual dispatch remains immediate. GitHub schedules can be delayed; this is a cadence, not a delivery SLA. It shares `quotes-refresh` concurrency with the existing quote/full-snapshot workflows. All three use `queue: max` with cancellation disabled, so frequent quote triggers do not replace a pending news run. GitHub documents a limit of 100 queued runs; queue delay and source/deployment failures remain observable in Actions, rather than being a guaranteed delivery interval ([GitHub concurrency documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)). Only the canonical repository calls providers. The client downloads the canonical hash-verified snapshot bundle, copies just its news fields, and rebuilds its own consistent bundle without changing core/brief/company/history/model/manager/quote data. News does not recollect fundamentals or SEC 13F. No new account or paid service is used.

Each uncached Finnhub request start, including a retry, is at least 31 seconds after the last news start: at most two in a rolling minute, within the documented 58/60 quote-account reservation. One general-market call plus at most eight shortlist company calls; at most 12 total Finnhub starts including retries, 32 total source starts. HTTP 429/selected 5xx/network failures retry once, honoring numeric Retry-After up to 60 seconds and the same start spacing. Failure is recorded by source/symbol and unexpired last-good items retain original publication/retrieval dates. Local source cache TTL is ten minutes; cache reads never renew upstream retrieval time. Routine scheduled jobs have fresh runner caches and cannot suppress the next half-hour collection.

Exact issuer matches and established general-market desks may introduce developments outside the named topic taxonomy. Arbitrary related-symbol tags alone are insufficient for a company link. Promotional articles, old/future dates, duplicates and per-topic/per-issuer overflows remain filtered. Neutral labels do not infer sentiment, a fundamentals change, or an explanation of a price move.

The Today disclosure makes no startup news request. It checks the local mirrored public JSON every five minutes only while open, foreground and in the viewport. Visibility/focus/pageshow/scroll resume a due check. Hidden/collapsed/detached views abort work; serial tokens and collection-date ordering prevent old callbacks or CDN snapshots replacing newer data. Failed HTTP/format checks retain dated content and retry after 30 seconds, doubling up to ten minutes. Publication ages advance each visible minute; collection age over one hour is stale, items over 72 hours are older context, and expired items are withheld even if the published file never changes. The expanded Capital & news page uses the same news renderer/controller, preserving manager disclosures and other controls. No news request includes private state.

Installation and manual verification are the parent's publication step. Install via `scripts/install_refresh_pipeline.py` (or `publish_app.ps1 -IncludeRefreshPipeline -IncludeQuoteWorkflow`) in BOTH approved delivery checkouts. The publisher allowlists the new workflow; no worker publication is authorized. Then:

```powershell
gh workflow run news-refresh.yml -R soham-porwal/smartoptions-brief
gh run list -R soham-porwal/smartoptions-brief --workflow news-refresh.yml --limit 3
# After canonical Pages deployment completes:
gh workflow run news-refresh.yml -R samsej/sp500-screener-dashboard
gh run list -R samsej/sp500-screener-dashboard --workflow news-refresh.yml --limit 3
```

Inspect the run summary and `news-refresh-<run_id>` artifact, then served `data/news-refresh-status.json`, `data/money-flow.json` and `data/snapshot.zip` on both sites. `source_collection_at` must match the canonical upstream collection, not the later mirror attempt; client `provider_calls=0`. Check non-news hashes, independent quote timestamps, installed runtime/cache tokens and the next actual scheduled delivery. A failed run does not deploy a candidate; a degraded successful collection exposes per-source/symbol status and original retained dates. Workflow failures appear in Actions and its summary/artifacts; browser failures appear beside the open news layer and in the public-only `so_news_last_error` local diagnostic. No credentials enter public receipts. Full daily client mirrors also retain newer local news if a delayed canonical bundle is older, then rehash their mirror receipt and bundle. The news workflow refuses a non-fast-forward push instead of rebasing a stale bundle over an external deployment.
# Dated analyst-input recovery

The installed runtime includes a bounded recovery set of public Yahoo analyst tables acquired during the accepted October 18 live build. It restores only empty or missing analyst-cache entries; healthy cached tables are untouched. Acquisition timestamps and analyst periods remain original, and the normal cache TTL, bounded provider retry and retained-input disclosure still apply. A recovery is recorded separately in the full-refresh receipt and does not represent a new analyst observation. This closes the hosted cache gap without dropping previously available assessments or relabeling old data as fresh.

