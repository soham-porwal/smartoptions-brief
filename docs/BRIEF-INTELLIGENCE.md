# Brief relationships and coordinated refresh

## Shock associations (QUANT)

`python -m smartoptions.shocks --out app/data --stage-root out/YYYY-MM-DD`
creates `smartoptions.shocks.v1` and adds its evidence to existing intelligence.
The intelligence generator also joins a compatible `shocks.json` when available.
Existing `sensitivity` coefficients, units, attribution and forecast audits are
preserved. Additions: top-level `shocks` metadata; three dated sector drivers;
eligible research crossovers; compact company `shock_exposures` and one company
relationship. Sources are prefixed `shock_`; repeated joins are idempotent.
Session mismatch removes prior shock overlays and exposes an unavailable reason.

Regenerate shocks after new macro/equity inputs are staged. Live quote updates
do not refit these historical coefficients. The coordinated refresh workflow is
outside the QUANT fence: conductor must add the shock CLI after creating the
staged intelligence output, retaining its failure receipt on a degraded run.
See [SHOCK-METHODS.md](SHOCK-METHODS.md) for formulas, confidence, actual holdout
evidence, sources and limits. No result is relabeled a forecast.

`python -m smartoptions.brief.intelligence --data-root app/data --stage-root out/YYYY-MM-DD`
creates `smartoptions.intelligence.v1`. Source dates stay separate: the equity session,
last common factor session, quote retrieval, statement provider reporting-period labels,
and Capital & news retrieval are all retained. A current quote never refits coefficients
or relabels prior fundamentals. Missing numbers are null with explicit reasons.

The company headline reconciles observed adjusted-close return = fitted return +
unexplained return. The fitted value includes the OLS intercept, unlike the legacy
factor-only attribution. Fits use up to 252 common same-session observations, at least
120, with stock/SPY returns converted from decimal fractions into percent units. Yield
changes are basis points, DXY/WTI changes percent, and VIX changes index points. Company
relationships show how a 20-session factor change combines with the measured sensitivity,
with valuation/growth comparisons and counterarguments. Additive 20-session contributions
are sums of daily changes, not compounded realized returns. The standardized +25 bp rates
scenario holds the other factors fixed and excludes the intercept.

No fitted association is described as a forecast or cause. Unexplained returns include
model error and omitted factors; they do not prove news, mispricing or a trade. Exact
collector ticker tags may attach the newest dated headline as context only. Headline
metadata contributes no numeric causal attribution. Provider financial dates are labeled
as provider quarter/balance labels, because they can differ from the issuer's fiscal end.

The separate forecast audit uses the last up to 60 chronological targets. For target t,
features come from equity-calendar session t−2, allowing an additional session for
publication uncertainty. Training targets strictly precede t; each forecast refits on up
to 252 earlier targets and compares with the mean return from the same training dates.
RMSE is in percent-return units. Skill is `100 × (1 − model MSE / baseline MSE)`; positive
skill only means the model beat that baseline in this sample. Revised macro histories,
current membership, unverified release timestamps, no costs and no independent future
replication prevent a demonstrated predictive-edge claim even when sample skill is positive.

## Refresh and rollback

Development: `python -m smartoptions.refresh --data-root app/data`.
Installed Pages: `PYTHONPATH=_pipeline python -m smartoptions.refresh --data-root data
--work-root _pipeline/out/refresh --cache-root _pipeline/data/cache/brief`.

The coordinator stages macro/calendar, all retained equities, relational fits, export,
seven company assessments, optional Capital & news, intelligence and verification before
promoting the whole dataset. It refuses backward sessions, missing retained names, lost
prices, missing macro observations, incomplete price/company history coverage, and newly
unavailable previously available fundamental assessments. Failed collection or validation
retains the last good dataset and updates `data/refresh-status.json`; the workflow displays
that receipt, deploys the visible failure receipt and ends in failure. Stage details remain
private Actions artifacts and `logs/`. Previous local datasets remain in the private work
directory; the coordinator does not delete them. Optional Capital & news failures retain
their prior document and explicitly degrade the receipt.

`--source-snapshot <existing-stage-dir> --offline --cache-root <statement-cache>` exercises
all deterministic downstream stages without another universe crawl. Its receipt explicitly
says reused/offline, so this validation cannot be mistaken for fresh collection.

## One canonical collector, client mirrors

Only `soham-porwal/smartoptions-brief` runs the complete source collection. The client
edition downloads the canonical `data/snapshot.zip` using `--mirror-url
https://soham-porwal.github.io/smartoptions-brief/data/snapshot.zip`; it makes no provider
requests. The bundle contains allowlisted core/brief/intelligence/price/company/capital
JSON and a SHA-256 manifest. It excludes quotes, caches, credentials, logs and runtime
code. Download and expansion are bounded at 64 MiB, paths are allowlisted, duplicates are
rejected, hashes and sessions reconcile before any candidate writes, and the same full
coverage guard runs before atomic promotion. Independent quotes retain their own dates.

The full workflow shares the existing `quotes-refresh` concurrency group. This serializes
source refresh and quote deployment, so quotes pause during a daily build. Path-scoped
commits and fetch/rebase protect against unrelated repository changes. Client mirror runs
may arrive before the latest canonical build and correctly retain the available earlier
snapshot dates; schedule or dispatch the client after a successful canonical deployment.

## Orchestrator installation

Run `python scripts/install_refresh_pipeline.py --destination <existing-pages-checkout>`
after integrating all lanes. The installer only copies `.py` runtime files, `config/brief.yaml`,
the packaged read-only Sam snapshot, two About documentation files and
`requirements-refresh.txt` under `_pipeline/`, plus `brief-refresh.yml`. It creates private
work/cache ignore rules. It does not modify the existing publisher/quote workflow, commit,
push or delete. The orchestrator must add `_pipeline` and the new workflow to the publisher's
explicit allowlist and keep that installation current on subsequent source changes.
No `.env`, source caches, raw inputs or credential files belong in that payload.

The preview repository needs its free `FRED_API_KEY` and `FINNHUB_API_KEY` Actions secrets
when those sources are enabled. Client mirrors need neither key. Confirm Pages Actions
permissions and workflow authorization, dispatch the canonical refresh, inspect its actual
receipt/artifacts/deployment, then dispatch the client mirror. Do not report live automation
as verified from tests or an offline run. Quotes and the final publisher are owned by the
orchestrator, including any canonical quote mirroring.

## Verification pointers

Targeted suite: `python -m pytest -q tests/test_brief_intelligence.py
tests/test_brief_refresh.py tests/test_brief_company.py tests/test_brief_statements.py
tests/test_relate.py tests/test_export_roundtrip.py`.

Lane proof files (ignored): `logs/analysis-targeted-tests.txt`,
`logs/analysis-coordinated-refresh.txt`, `logs/analysis-intelligence-build.txt`, and
`logs/analysis-proof.json`. The source-snapshot proof uses the original cached real
509-company dataset read-only. Root owns integrated Python/JS/browser suites, published
workflow verification and cataloging the final proof in the ecosystem log index.
