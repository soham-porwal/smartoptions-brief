# Methods: every computed number -> formula, window, source, code

All paths relative to repo root. Relationships are **associations over a stated window, not causation**.

## Factor regressions (per ticker)
| Item | Definition | Code |
|---|---|---|
| Model | OLS with intercept: stock daily return (%) on [SPY ret %, Δ10y (bp), DXY ret %, WTI ret %, ΔVIX (pts)] | `smartoptions/relate.py:50-60,259-276` |
| Window | last 252 common sessions; fit only if ≥120 common days | `relate.py:30,263-265` |
| Units | coef = % stock move per 1 unit of factor, others held fixed | `relate.py:28-29` |
| t-stat | coef / SE, classic (non-robust) OLS SE | `relate.py:55-60` |
| R² | 1 − SSres/SStot | `relate.py:59` |
| Dropped factor | factor with <120 points is dropped and WARN logged | `relate.py:252-255` |
| Unit guard | returns auto-normalised to percent if 95th pct of \|x\| < 0.25 (decimal detection, heuristic) | `relate.py:41-47` |
| Sector medians | median coef of fitted tickers by GICS sector | `relate.py:279-285` |
| "Exposed" lists | rank by coef sign, only \|t\| ≥ 2, top 3-5 | `relate.py:133-137` |
| Inputs | SPY/stock returns: Adj Close; factors: `macro.json` `daily_factors` | `equities/prices.py:116`, `macro/collect.py:14,171-172` |

Factor construction: Δ10y/Δ2y = Treasury yield change in bp (`macro/collect.py:48`); DXY/WTI = 1-day % return of Yahoo front-month (WTI not roll-adjusted); ΔVIX = Cboe close difference in pts; HY OAS Δ in bp (FRED BAMLH0A0HYM2). Joined by date, no forward fill (`macro/README.md`).

## Move attribution (movers)
| Item | Definition | Code |
|---|---|---|
| Explained | Σ coef_k × factor_k on the latest common day | `relate.py:296-297` |
| Stock-specific | actual % − explained | `relate.py:299` |
| Caveat | in-sample fit, same day; descriptive split only | |

## Sam's regime (reproduced with free data)
| Component | Weight | Formula | Code |
|---|---|---|---|
| VIX | 0.40 | piecewise-linear score from his `market_regime.py:84-114` | `relate.py:144-155` |
| Advance/decline | 0.25 | adv/(adv+dec) over A∪B tickers' 1d change; score = clamp((r−0.30)/0.40×100) | `relate.py:158-163` |
| New high/low | 0.15 | hi = price within 3% of 52w high, lo = ≥22% below; score = hi/(hi+lo)×200−10, clamped | `relate.py:166-170` |
| UpVol, TRIN | 0.10 + 0.10 | **not available** (needs up/down volume); remaining weights ÷0.80 | `relate.py:191` |
| Tier | | <30 AVOID, <50 DEFENSIVE, <70 NORMAL, <85 FAVORABLE, else OPTIMAL | `relate.py:173-174` |
| Limit | | universe = our A+B tickers, not his full pull; history shows VIX+A/D only (÷0.65) | `relate.py:192-207` |

## Volatility and breadth
| Number | Formula | Window | Code |
|---|---|---|---|
| VRP | VIX − SPY realized vol; RV = stdev(daily SPY ret %, ddof=1) × √252 | 21 sessions | `relate.py:224-229` |
| Term ratio | VIX / VIX3M; >1.0 = backwardation (only threshold claimed) | same-date | `relate.py:230-231` |
| Breadth | cumulative RSP return − cumulative SPY return, pp | 20 sessions | `relate.py:232-234` |
| ATM IV | nearest expiry ≥7 days, strike nearest price, mean(call IV, put IV)×100, legs with IV ≤1% dropped; `spans_earnings` = earnings date ≤ expiry | per ticker (~64 targeted) | `equities/options.py:13-42` |

## Trends
| Item | Rule | Code |
|---|---|---|
| Series trend | last vs 3 periods earlier; \|Δ\|/max(\|last\|,\|prev\|) <2% = flat, else rising/falling; <4 points = insufficient | `relate.py:63-74` |
| Group trend | all series agree → that label, else "mixed" | `relate.py:77-89` |
| Note | descriptive; no alarm thresholds | |

## Movers (set A) and price stats
| Item | Rule | Code |
|---|---|---|
| Session | latest completed regular session; partial bar before 16:15 ET excluded | `equities/prices.py:76-84` |
| 1d/5d/1m % | Adj Close[t]/Adj Close[t−n] − 1, n = 1, 5, 21 | `equities/prices.py:98-99,112` |
| Top movers | 15 gainers + 15 losers by 1d %; exact ties by market cap | `equities/pipeline.py:22-51` |
| Unusual volume | last volume / mean prior 20 sessions, ≥2.0, top 15 (not padded) | `equities/prices.py:102-103`, `pipeline.py:22,48` |
| 52w range | unadjusted High/Low, last 252 sessions; pctile = (px−low)/(high−low)×100 | `equities/prices.py:104-106` |
| Universe | S&P 500 from Wikipedia (sanity 495-510); set B = 343 tickers parsed from Sam's page | `equities/universe.py`, `equities/sam.py` |

## Fundamentals
| Item | Method | Code |
|---|---|---|
| P/E | Yahoo trailing / forward as published; negative → missing | `equities/fundamentals.py:130-150` |
| PEG (provider) | Yahoo `trailingPegRatio` | `fundamentals.py:18,146-153` |
| PEG (computed) | forward P/E ÷ (Yahoo next-FY EPS growth % from `+1y`); growth ≤0 or missing → null + reason | `fundamentals.py:19,155-166` |
| Analyst, beta, earnings date | Yahoo as published; earnings time only if BMO/AMC is certain, else null | `fundamentals.py:31-60` |
| Consensus / surprise | **unavailable** (no licensed source) | |

## Macro observations
| Item | Method | Code |
|---|---|---|
| YoY / MoM | by calendar month on the SA index (CPI SA YoY can differ from BLS headline NSA) | `macro/collect.py:92-143`, `macro/README.md` |
| Staleness | days since source date (daily/weekly) or period end (monthly/quarterly); daily >4, weekly >10, monthly >75, quarterly >150 = stale; exactly the limit = fresh | `macro/observations.py:5,12`, `contract.py:61-67` |
| History | 36 pts monthly/quarterly, 260 daily/weekly | `macro/observations.py` |
| Status | ok / stale / missing / error; ok requires a value | `contract.py:16,48-53` |
| GDP growth | provider SAAR, never labeled YoY | `macro/README.md` |

## Cross-checks (`smartoptions/crosscheck.py`)
| Check | Tolerance |
|---|---|
| Treasury 10Y vs FRED DGS10 | 0.011 pct pts (`:55-57`) |
| Cboe VIX vs FRED VIXCLS | 0.051 pts (`:58-59`) |
| CPI YoY page value vs recompute from raw FRED index, by date | 0.01 pct pts (`:77-85`) |
| Result | PASS / MISMATCH / SKIP, written to `crosscheck.json`; MISMATCH is logged WARN, never hidden |

## Insight cards (`relate.py:304-368`)
Rates, vol, dollar, oil, credit, movers, earnings. Each: observation values + source link, one conditional "why", next scheduled event (`_next_events`, `relate.py:118`), most-exposed tickers (above), playbook tag, confidence label (an editorial tag, not statistical).
