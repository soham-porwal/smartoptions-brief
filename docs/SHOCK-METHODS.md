# Shock sensitivity methods

`smartoptions.shocks.v1` contains historical associations and conditional scenarios.
It does not forecast prices, establish causation or recommend trades. All reasons
are deterministic templates, with numerical provenance and observation dates.

## Reproduce and receipts

```powershell
& ..\smartoptions\v2\.venv\Scripts\python.exe -m smartoptions.shocks --out app/data
```

Default stage: `out/<core.asof_session>`. Override with `--stage-root <path>`.
`--offline` reuses verified calendars under `logs/quant/sources/`. No constituent
network crawl is performed. The CLI validates shocks and any existing intelligence
payload before replacing either. Replacements are individually atomic, not a
two-file transaction. A partial write is identified in the failure receipt.
Input/schema failures preserve both previous artifacts.

Proof: `logs/quant/build-receipt.json`, `summary.json`, `targeted-python.txt`,
`targeted-js.txt`, `browser-receipt.json`, `full-python.txt`, `full-js.txt`.
Failures go to durable JSONL and `failure-receipt.json`. A later successful receipt
supersedes an older failure receipt; inspect timestamps, not file existence.

## Data and units

Read-only inputs: exported core/company assessments, cached equities and macro
stages. Only explicitly marked S&P members enter this universe. Adjusted-close
stock/SPY returns enter as decimal fractions and are multiplied by 100 once.

| Factor | Regressor unit | Source |
|---|---|---|
| 10-year yield | Daily yield change, bp | US Treasury yield curve |
| 2s10s slope | Change in 10-year minus 2-year yield, bp | Matched Treasury tenors |
| WTI oil | Daily futures return, percent | Yahoo `CL=F`, existing cache |
| Dollar | Daily DXY return, percent | Yahoo `DX-Y.NYB`, existing cache |
| VIX | Daily close change, points | Cboe daily historical closes |
| High-yield spread | Daily HY OAS change, bp | FRED `BAMLH0A0HYM2`; percent level converted upstream |

WTI futures are not spot oil; DXY is not a broad trade-weighted dollar index.
Source series, URL, retrieval time, latest level/date/unit and change date remain
attached. Generation time never replaces observation time. Recent percent changes
compound 20 daily observations; bp/point changes sum. The z-score compares this
change with overlapping historical 20-observation changes, using sample standard
deviation. It is descriptive, not a significance test. A standard shock is one
sample standard deviation of the cached daily factor changes, not a forecast.

## Sector baskets and calendar alignment

Each GICS sector is a **current-membership, current-capitalization proxy basket**.
Daily weights use snapshot caps, requiring at least 90% of known-cap sector value
before renormalizing available members. Coverage reports missing-cap counts,
minimum represented capitalization and dropped days. These are not official
historical sector indexes; historical constituents/free-float weights are unavailable.

Daily fits use exact common dates, up to 756 observations, minimum 120. Missing
dates are never forward-filled or replaced by zero. A day following an absent
factor observation on the equity calendar is also omitted: a two-session yield
change must not be paired with a one-session stock return. HAC lags count retained
ordered observations; occasional remaining gaps and asynchronous closes limit
the equal-spacing approximation.

Weekly fits use non-overlapping complete equity weeks, minimum four sessions and
a Thursday/Friday ending. Weeks with missing returns/factors or cross-boundary
factor gaps are excluded. Percent changes compound; bp/point changes sum.
Minimum weekly sample is 26. No missing observation becomes an artificial zero.

## OLS and Newey-West intervals

```text
raw:                r[t] = a + sum(b_raw[k] * x[k,t]) + error[t]
market controlled:  r[t] = a + b_market * SPY[t] + sum(b[k] * x[k,t]) + error[t]
```

Both fits control all six shocks; raw omits SPY. Controlled coefficients hold
SPY and the other five shocks fixed. They are partial historical associations,
not isolated economic interventions. OLS includes an intercept and rejects
rank-deficient designs. R² describes the full model, not one factor's incremental fit.

Newey-West covariance is `inv(X'X) * S * inv(X'X) * n/(n-k)`. `S` combines score
outer products and lagged symmetric products with Bartlett weights
`1 - lag/(L+1)`, where `L=floor(4*(n/100)^(2/9))`. SEs are diagonal square roots.
Asymptotic 90% intervals are `beta ± 1.644853627 * HAC_SE`. Raw and controlled
coefficients retain separate SEs, intervals and R². NumPy implementation tests
include known betas, direct lag-zero sandwich equality and serial-error inflation.
The [statsmodels HAC reference](https://www.statsmodels.org/stable/generated/statsmodels.stats.sandwich_covariance.cov_hac.html)
documents the Bartlett convention and lag rule.

## Chronological holdouts

Preferred train/test: 504/126 daily observations or 104/26 weeks. The cached stock
history cannot supply that design, so explicitly labeled short-history checks use
120/60 daily or 26/13 weekly. Non-overlapping full test blocks are anchored at the
latest observation, with rolling training windows. Training always precedes testing.

Coefficient sign agreement compares training and subsequent test estimates.
Held-out contribution correlation compares the training beta times the **known
same-period shock** with realized return after subtracting the training intercept
and other training-coefficient contributions, including SPY. Descriptive direction
hit rate uses the same comparison. Dates, n, fold counts and preferred-design
availability are retained. These are contemporaneous holdout attribution checks,
not next-day predictions. Existing intelligence lagged forecast audits keep their
separate targets, benchmarks and units.

## Confidence and shrinkage

Thresholds are fixed; they are not optimized against this output.

| Label | Rule |
|---|---|
| High | Controlled CI excludes zero; n >=504 daily/104 weekly; >=2 folds; sign agreement >=80%; correlation >=0.2 |
| Medium | Controlled CI excludes zero; n >=180 daily/40 weekly; >=1 fold; sign agreement >=60% |
| Low | Everything else, including unavailable holdout evidence |

Labels are not return probabilities. Medium does not require a positive holdout
correlation; the actual correlation remains visible. Multiple testing is unadjusted.

Stock shrinkage uses `w=n/(n+252) * b²/(b²+HAC_SE²)` and
`b_shrunk=w*b_stock+(1-w)*b_sector`. The three largest absolute shrunken
standard-move associations are stored. Confidence uses **unshrunk** evidence;
shrinkage cannot manufacture significance. For a conditional descriptive band,
`SE_bound=w*SE_stock+(1-w)*SE_sector`; this bounds unknown stock/sector covariance
conditional on the chosen weight. It excludes shrinkage bias and weight-estimation
uncertainty, so the resulting `±1.64485*SE_bound` band is not a calibrated 90%
frequentist interval. Ordinary unshrunk HAC intervals remain available.

## CPI, payrolls and FOMC events

Use official BLS archive **release URL dates**, with the free
[FRED release calendar API](https://fred.stlouisfed.org/docs/api/fred/release_dates.html)
as fallback. This run used releases 10 (CPI) and 50 (Employment Situation), because
BLS archive HTTP requests were blocked. FRED excludes releases without data;
reference-month observation dates are never substituted. Credentials remain in
memory and never enter logs or artifacts. Offline runs reuse verified date receipts.

FOMC dates come from decision-statement URLs on the
[Fed calendar](https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm).
Minutes, implementation notes and strategy statements are excluded. Every included
event retains its official URL. Non-session dates are not shifted to invented
event dates. Missing calendars produce visibly degraded status.

For each sector/release, estimate `sector=a+b*SPY` on up to 120 strictly earlier
sessions, minimum 60. Abnormal return is observed minus this earlier model.
Report mean day-0 abnormal return, additive CAR for trading days 0..+2, mean
absolute abnormal/CAR magnitude, n, conventional mean t-statistic and asymptotic
90% mean interval. One observation or zero variation yields a null t-statistic.
Event t-statistics do not adjust for overlapping events or multiple comparisons.

No verified free point-in-time consensus surprise proxy was available. Surprise
direction is explicitly unavailable. Absolute reactions must not become "CPI
surprise" or "payroll beat" claims. Other releases/news can confound the samples.

## Scenarios and research crossovers

Scenarios multiply controlled sector beta by a hypothetical shock: ten-year +25 bp,
slope +25 bp, oil +10%, VIX +5 points, dollar +2%, HY OAS +25 bp. Other shocks and
SPY stay fixed. Bands scale coefficient uncertainty; they are not future-return
intervals and exclude residual risk, interactions and shock probabilities.

The scenario UI also accepts one signed custom daily factor change. It multiplies
the stored controlled coefficient and both HAC endpoints by that change, then sorts
the endpoints (negative changes reverse their order). A zero input is zero fitted
contribution, not a certain return. No input or quote tick refits the model. Optional
`factor.observed_daily_range` metadata contains `min`, `max`, `n`, `window_start`
and `window_end`; the UI labels shocks outside that range as extrapolation. Missing
range metadata is explicitly unavailable and is never approximated from volatility.

Research leads require positive revenue growth, a positive trailing P/E below the
sector median, positive association with the observed 20-session factor direction,
a controlled interval supporting that direction and at least medium confidence.
Suppress current-macro leads when factor history is over four calendar days old.
Each includes dated fundamental/factor evidence, a <=14-word template summary,
and the company card's strongest counterargument or an earnings-risk fallback.
Ranking uses associated contribution, never an expected return.

## Actual snapshot, 2026-10-16

Measured from the real existing cache; receipt: `logs/quant/summary.json`.

| Check | Observed result |
|---|---|
| Constituents | 503 records, 500 fitted; FDXF/HONA/VYLR unavailable |
| Sector daily models | 11 sectors; 279 observations; 2025-08-27 to 2026-10-14 |
| Complete weekly observations | 56 per sector |
| Daily holdout | Two 120-train/60-test folds; 120 held-out observations; ends 2026-10-14 |
| Sector-factor confidence | 13 medium, 53 low, zero high |
| Median sign agreement | 50% |
| Median holdout contribution correlation | 0.0532 |
| Events with sufficient prehistory | 11 CPI, 11 payroll, 7 FOMC per sector |
| Latest verified releases | CPI 2026-10-14; payroll 2026-10-02; FOMC 2026-09-16 |
| Artifact size | Approximately 2.72 MB |

Energy/oil example: controlled beta **0.24949% per 1% oil move**, 90% HAC interval
**0.19238–0.30660**, full-model R² **0.4261**, n **279**. A standard oil move maps
to **+0.8103%**, coefficient-only band **+0.6248% to +0.9957%**. Two daily folds
show 100% coefficient-sign agreement, contribution correlation **0.6216**, and
descriptive direction agreement **68.33%**. This association is useful for exposure
research; it does not establish a tradable forecast. The weak cross-grid median
and unavailable full two-year design are material limitations.

## UI and limits

`SO2.Shocks` exposes `load()`, `renderGrid(el)`, `renderCompany(el,ticker)` and
`renderScenario(el)`. Load `shocks.css` after `ui.css` and `shocks.js` before route
mounts. The grid contains its horizontal scroll and keeps the sector column fixed.
Controls are at least 44px; inputs use 16px. Theme inherits `--b-*`; dark activation
uses `html[data-bt=dark]`. Quotes never refit or relabel historical coefficients.

`window.SmartOptionsShocks` is available before the research desk; the module only
attaches `SO2.Shocks` when `SO2` exists, including on `so2:ready`. The scenario view
initially shows three largest absolute sector associations; other sectors and full
numeric evidence expand on demand. Release-day evidence selects one sector and
shows CPI/payroll/FOMC day-0 and CAR 0..2 signed means, mean absolute reactions and
each window's actual count. Mean intervals, conventional t-statistics, dated release
links, prior fit dates and calendar verification are expandable. Event confidence is
described as limited by small confounded samples; regression confidence labels are
not reused as event or future-return probabilities.

Desktop/mobile screenshots in `logs/quant/` use `grid`, `evidence`, `scenario`,
`company`, `company-open` and `grid-dark` prefixes, at 1440×900 and 390×844.
The isolated review harness verifies the module. Final integrated route spacing,
deployment and refresh scheduling remain conductor responsibilities.

Association is not causation. Current membership/caps introduce survivorship and
look-ahead weighting. Revised macro data, asynchronous closes, omitted variables,
unstable coefficients, unadjusted multiple testing, short samples and absent
point-in-time macro vintages prevent predictive claims.
