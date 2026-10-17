"""Relational layer: how macro factors and these stocks move together, and what that implies to watch.

Method (documented on the page, PLAN.md relations.json):
- Per ticker OLS with intercept: daily stock return (%) on SPY return (%), change in 10y yield (bp), DXY return (%),
  WTI return (%), change in VIX (points), over the last <=252 common sessions (min 120). Coefficients are
  "% stock move per 1 unit of factor, holding the others fixed". t-stats from classic OLS standard errors.
  These are measured associations, not causes.
- Move attribution for movers on each stock's last common factor/equity session: sum(coef x factor move) = factor-explained part; remainder =
  stock-specific. Shown as numbers so a reader can see whether a move was "the market/rates" or "the company".
- Trends: direction of each macro observation over its last 3 periods (rule in trend_label). No alarm thresholds
  are claimed; labels are descriptive.
"""
from __future__ import annotations

import json
import math
import sys
from datetime import date, datetime
from pathlib import Path
from statistics import median
from typing import Any

import numpy as np

from .contract import utc_now, write_json
from .log import event

FACTORS = [("spy", "SPY", "% per 1% SPY"), ("us10y_bps", "us10y_bps_chg", "% per 1 bp 10y"),
           ("dxy", "dxy_ret", "% per 1% DXY"), ("wti", "wti_ret", "% per 1% WTI"), ("vix", "vix_chg", "% per 1 VIX pt")]
WINDOW, MIN_N = 252, 120
WINDOW_60, MIN_N_60 = 60, 40


def _series(pairs: list | None) -> dict[str, float]:
    out = {}
    for p in pairs or []:
        if p and len(p) >= 2 and p[1] is not None and not (isinstance(p[1], float) and math.isnan(p[1])):
            out[str(p[0])[:10]] = float(p[1])
    return out


def _as_pct(s: dict[str, float]) -> dict[str, float]:
    """Equity returns (including SPY/RSP) are fractions by contract: 0.01 = 1%."""
    return {k: v * 100 for k, v in s.items()}


def ols(y: np.ndarray, X: np.ndarray) -> tuple[np.ndarray, np.ndarray, float]:
    X1 = np.column_stack([np.ones(len(y)), X])
    beta, *_ = np.linalg.lstsq(X1, y, rcond=None)
    resid = y - X1 @ beta
    dof = len(y) - X1.shape[1]
    s2 = float(resid @ resid) / dof
    cov = s2 * np.linalg.pinv(X1.T @ X1)
    se = np.sqrt(np.clip(np.diag(cov), 1e-30, None))
    ss_tot = float(((y - y.mean()) ** 2).sum())
    r2 = 1 - float(resid @ resid) / ss_tot if ss_tot > 0 else float("nan")
    return beta[1:], beta[1:] / se[1:], r2


def trend_label(hist: list) -> tuple[str, str]:
    pts = [h for h in hist or [] if h and h[1] is not None]
    if len(pts) < 4:
        return "insufficient data", f"{len(pts)} observations"
    last, prev3 = pts[-1][1], pts[-4][1]
    d = last - prev3
    scale = max(abs(last), abs(prev3), 1e-9)
    if abs(d) / scale < 0.02:
        lab = "flat"
    else:
        lab = "rising" if d > 0 else "falling"
    return lab, f"{prev3:.2f} -> {last:.2f} over 3 periods ({pts[-4][0]} to {pts[-1][0]})"


def _group_trend(obs_list: list[dict]) -> dict:
    labs = []
    ev = []
    for o in obs_list:
        lab, why = trend_label(o.get("history"))
        if lab != "insufficient data":
            labs.append(lab)
            ev.append(f"{o.get('label')}: {lab}")
    if not labs:
        return {"label": "insufficient data", "evidence": "no series with 4+ observations"}
    uniq = set(labs)
    label = labs[0] if len(uniq) == 1 else "mixed"
    return {"label": label, "evidence": "; ".join(ev[:4])}


def _find(macro: dict, *needles: str) -> dict | None:
    for grp in (macro.get("groups") or {}).values():
        for o in grp:
            key = f"{o.get('id','')} {o.get('series','')} {o.get('label','')}".lower()
            if all(n.lower() in key for n in needles) and o.get("value") is not None:
                return o
    return None


def _chg(o: dict | None, n: int) -> float | None:
    """Change over the last n history points (same units as the displayed transform)."""
    if not o:
        return None
    h = [x for x in o.get("history") or [] if x[1] is not None]
    if len(h) <= n:
        return None
    return h[-1][1] - h[-1 - n][1]


def _ev(o: dict | None, label: str | None = None) -> dict | None:
    if not o:
        return None
    return {"label": label or o.get("label"), "value": o.get("value"), "unit": o.get("unit"),
            "period": o.get("period") or o.get("date"), "source_url": o.get("source_url"), "status": o.get("status")}


def _next_events(cal: dict, types: set[str], k: int = 2) -> list[str]:
    now = datetime.now().astimezone()
    out = []
    for e in sorted(cal.get("events") or [], key=lambda e: e.get("scheduled_et") or ""):
        try:
            t = datetime.fromisoformat(e["scheduled_et"])
        except Exception:
            continue
        if e.get("type") in types and t >= now:
            out.append(f"{e.get('type')} {t.strftime('%b %d %H:%M')} ET")
        if len(out) >= k:
            break
    return out


def _exposed(tick_rel: dict, factor: str, sign: int, k: int = 5) -> list[dict]:
    rows = [(t, r["coef"][factor], r["t"][factor]) for t, r in tick_rel.items()
            if r.get("coef", {}).get(factor) is not None and abs(r["t"][factor]) >= 2]
    rows.sort(key=lambda x: x[1] * sign, reverse=True)
    return [{"ticker": t, "factor": factor, "coef": round(c, 5), "t": round(tt, 1)} for t, c, tt in rows[:k] if c * sign > 0]


def _lerp(x, x0, x1, y0, y1):
    return y0 + (x - x0) * (y1 - y0) / (x1 - x0)


def score_vix(v: float | None) -> int:
    """the reference piecewise VIX score, copied from sp500-screener origin/main market_regime.py:84-114 (CSP-calibrated)."""
    if v is None:
        return 50
    for lo, hi, a, b in ((12, 16, 30, 60), (16, 20, 60, 100), (20, 25, 100, 80), (25, 30, 80, 45)):
        if lo <= v < hi:
            return int(round(_lerp(v, lo, hi, a, b)))
    if v < 12:
        return 15
    if v <= 40:
        return int(round(_lerp(v, 30, 40, 45, 15)))
    return 10


def score_ad(pct_1d: list[float]) -> tuple[float | None, int]:
    adv, dec = sum(1 for v in pct_1d if v > 0), sum(1 for v in pct_1d if v < 0)
    if adv + dec == 0:
        return None, 50
    r = adv / (adv + dec)
    return round(r, 4), int(round(max(0.0, min(100.0, (r - 0.30) / 0.40 * 100))))


def score_newhl(dist: list[float]) -> tuple[int, int, int]:
    hi, lo = sum(1 for d in dist if d <= 3.0), sum(1 for d in dist if d >= 22.0)
    if hi + lo == 0:
        return hi, lo, 50
    return hi, lo, int(round(max(0.0, min(100.0, hi / (hi + lo) * 200 - 10))))


def tier(score: int) -> str:
    return "AVOID" if score < 30 else "DEFENSIVE" if score < 50 else "NORMAL" if score < 70 else "FAVORABLE" if score < 85 else "OPTIMAL"


def regime(macro: dict, eq: dict) -> dict:
    """the reference CSP regime (VIX .40, A/D .25, NewHi/Lo .15, UpVol .10, TRIN .10) reproduced with free data.
    UpVol and TRIN need per-stock up/down volume we do not pull, so the three available weights are
    renormalized (/0.80) and the gap is stated on the page."""
    vix_o = _find(macro, "vix")
    vix = vix_o.get("value") if vix_o and "vix3m" not in (vix_o.get("id") or "").lower() else None
    tk = eq.get("tickers") or {}
    pct = [v["chg_1d_pct"] for v in tk.values() if v.get("chg_1d_pct") is not None]
    dist = []
    for v in tk.values():
        r = v.get("range_52w") or {}
        if v.get("price") and r.get("high"):
            dist.append((r["high"] - v["price"]) / r["high"] * 100)
    sv, (adr, sad), (nh, nl, snh) = score_vix(vix), score_ad(pct), score_newhl(dist)
    score = int(round((0.40 * sv + 0.25 * sad + 0.15 * snh) / 0.80))
    # History of the VIX + A/D part only (daily, from stored returns), labeled as partial.
    hist = []
    vix_h = {h[0][:10]: h[1] for h in (vix_o or {}).get("history") or [] if h[1] is not None}
    rets = {t: _as_pct(_series(p)) for t, p in (eq.get("returns") or {}).items() if t not in ("SPY", "RSP")}
    for d in sorted(vix_h)[-60:]:
        day = [r[d] for r in rets.values() if d in r]
        if len(day) >= 100:
            hist.append([d, int(round((0.40 * score_vix(vix_h[d]) + 0.25 * score_ad(day)[1]) / 0.65))])
    return {"score": score, "tier": tier(score), "method": "Historical SmartOptions regime method (market_regime.py) - VIX, A/D, NewHi/Lo; "
            "UpVol + TRIN not available, weights renormalized /0.80. Universe = A+B tickers, not the original full pull.",
            "components": {"vix": {"value": vix, "score": sv, "weight": 0.40},
                           "ad": {"ratio": adr, "n": len(pct), "score": sad, "weight": 0.25},
                           "newhl": {"near_high": nh, "near_low": nl, "score": snh, "weight": 0.15},
                           "upvol": {"score": None, "weight": 0.10, "note": "not available"},
                           "trin": {"score": None, "weight": 0.10, "note": "not available"}},
            "history_partial": hist, "history_note": "VIX + A/D components only (weights renormalized /0.65)"}


def vol_breadth(macro: dict, eq: dict) -> dict:
    """Options-seller context (AGY share-inbox research job 2d034ec4991c6daca6fe, top relationships 1, 2, 9):
    - VRP = VIX minus SPY 21-session realized vol (annualized, %). Positive = implied rich vs realized.
    - Term ratio = VIX / VIX3M. Above 1.0 = backwardation (near-term stress priced above 3-month).
    - Breadth = RSP (equal-weight S&P) minus SPY (cap-weight) 20-session return, in % points.
    Descriptive only: no alarm threshold is claimed beyond the 1.0 term-structure definition."""
    def hist(o):
        return {h[0][:10]: h[1] for h in (o or {}).get("history") or [] if h[1] is not None}
    vix_o = next((o for o in [_find(macro, "vix")] if o and "3m" not in (o.get("id") or "").lower()), None)
    v, v3 = hist(vix_o), hist(_find(macro, "vix3m"))
    spy = _as_pct(_series((eq.get("returns") or {}).get("SPY")))
    rsp = _as_pct(_series((eq.get("returns") or {}).get("RSP")))
    days = sorted(spy)
    vrp, term, br = [], [], []
    for i in range(21, len(days)):
        d = days[i]
        w = [spy[x] for x in days[i - 21:i + 1]][1:]
        rv = float(np.std(w, ddof=1) * math.sqrt(252))
        if d in v:
            vrp.append([d, round(v[d] - rv, 2)])
        if d in v and d in v3 and v3[d]:
            term.append([d, round(v[d] / v3[d], 3)])
        if rsp and i >= 20 and all(x in rsp for x in days[i - 19:i + 1]):
            cum = lambda s: (np.prod([1 + s[x] / 100 for x in days[i - 19:i + 1]]) - 1) * 100
            br.append([d, round(float(cum(rsp) - cum(spy)), 2)])
    last = lambda h: h[-1][1] if h else None
    return {"method": vol_breadth.__doc__.strip(),
            "vrp": {"value": last(vrp), "unit": "vol pts", "history": vrp[-120:]},
            "term_ratio": {"value": last(term), "unit": "x", "history": term[-120:]},
            "breadth_rsp_spy_20d": {"value": last(br), "unit": "pp", "history": br[-120:],
                                    "status": "ok" if br else "missing"}}


def build(in_dir: Path) -> dict:
    macro = json.loads((in_dir / "macro.json").read_text(encoding="utf-8")) if (in_dir / "macro.json").exists() else {}
    eq = json.loads((in_dir / "equities.json").read_text(encoding="utf-8")) if (in_dir / "equities.json").exists() else {}
    cal = json.loads((in_dir / "calendar.json").read_text(encoding="utf-8")) if (in_dir / "calendar.json").exists() else {}
    df = macro.get("daily_factors") or {}
    rets = eq.get("returns") or {}
    fac = {"spy": _as_pct(_series(rets.get("SPY"))), "us10y_bps": _series(df.get("us10y_bps_chg")),
           "dxy": _series(df.get("dxy_ret")), "wti": _series(df.get("wti_ret")),
           "vix": _series(df.get("vix_chg"))}
    missing_f = [k for k, v in fac.items() if len(v) < MIN_N]
    use_f = [k for k, _, _ in FACTORS if k not in missing_f]
    if missing_f:
        event("relate", "factors", "WARN", f"factors with < {MIN_N} points dropped from regressions: {missing_f}")
    common = sorted(set.intersection(*(set(fac[k]) for k in use_f))) if use_f else []
    tick_rel: dict[str, dict] = {}
    skipped = 0
    for t, pairs in rets.items():
        if t in ("SPY", "RSP"):
            continue
        y_s = _as_pct(_series(pairs))
        days = [d for d in common if d in y_s][-WINDOW:]
        if len(days) < MIN_N or not use_f:
            skipped += 1
            continue
        y = np.array([y_s[d] for d in days])
        X = np.array([[fac[k][d] for k in use_f] for d in days])
        try:
            b, tt, r2 = ols(y, X)
        except Exception as e:
            skipped += 1
            event("relate", t, "WARN", f"ols failed: {e!r}")
            continue
        coef_252 = {k: round(float(v), 5) for k, v in zip(use_f, b)}
        t_252 = {k: round(float(v), 2) for k, v in zip(use_f, tt)}
        rec_t = {"n": len(days), "start_date": days[0], "end_date": days[-1],
                 "r2": round(r2, 3), "coef": coef_252, "t": t_252}
        days_60 = days[-WINDOW_60:]
        if len(days_60) >= MIN_N_60:
            try:
                y60 = np.array([y_s[d] for d in days_60])
                X60 = np.array([[fac[k][d] for k in use_f] for d in days_60])
                b60, tt60, r2_60 = ols(y60, X60)
                c60 = {k: round(float(v), 5) for k, v in zip(use_f, b60)}
                rec_t["coef_60d"] = c60
                rec_t["t_60d"] = {k: round(float(v), 2) for k, v in zip(use_f, tt60)}
                rec_t["r2_60d"] = round(r2_60, 3) if not math.isnan(r2_60) else None
                rec_t["beta_shift"] = {
                    k: round(c60[k] - coef_252[k], 5)
                    for k in ("spy", "us10y_bps", "dxy", "wti", "vix")
                    if k in c60 and k in coef_252
                }
            except Exception as e60:
                event("relate", f"{t}:60d", "WARN", f"60d ols failed: {e60!r}")
        tick_rel[t] = rec_t
    event("relate", "regressions", "OK", f"{len(tick_rel)} fitted, {skipped} skipped (<{MIN_N} common days)", len(tick_rel))

    tickers = eq.get("tickers") or {}
    sectors: dict[str, dict] = {}
    for t, r in tick_rel.items():
        sec = (tickers.get(t) or {}).get("sector") or "Unknown"
        sectors.setdefault(sec, []).append(r)
    sec_out = {s: {"n": len(rs), "median_coef": {k: round(median(r["coef"][k] for r in rs), 5) for k in use_f}}
               for s, rs in sectors.items()}

    # Full-universe 1d, 5d, and 20d factor attribution across shared sessions.
    last_day = common[-1] if common else None
    attribution = {}
    mv = eq.get("movers") or {}
    mv_set = set((mv.get("up") or []) + (mv.get("down") or []))
    for t, r in tick_rel.items():
        y_s = _as_pct(_series(rets.get(t)))
        shared_days = [d for d in common if d in y_s]
        day = shared_days[-1] if shared_days else None
        if not r or not day:
            continue
        by = {k: round(r["coef"][k] * fac[k][day], 2) for k in use_f}
        expl = round(sum(by.values()), 2)
        att_entry: dict[str, Any] = {
            "date": day,
            "actual": round(y_s[day], 2),
            "explained": expl,
            "by_factor": by,
            "stock_specific": round(y_s[day] - expl, 2),
            "status": "ok" if day == eq.get("asof_session") else "stale",
        }
        for win_n, sfx in ((5, "5d"), (20, "20d")):
            if len(shared_days) >= win_n:
                w_days = shared_days[-win_n:]
                act_w = round(sum(y_s[d] for d in w_days), 2)
                by_w = {k: round(sum(r["coef"][k] * fac[k][d] for d in w_days), 2) for k in use_f}
                expl_w = round(sum(by_w.values()), 2)
                att_entry[f"actual_{sfx}"] = act_w
                att_entry[f"explained_{sfx}"] = expl_w
                att_entry[f"resid_{sfx}"] = round(act_w - expl_w, 2)
                att_entry[f"by_factor_{sfx}"] = by_w
        attribution[t] = att_entry

    groups = macro.get("groups") or {}
    trends = {g: _group_trend(obs) for g, obs in groups.items()}

    # Insight cards: numbers first, one short line of "why", what to watch next, who is most exposed.
    ins = []
    ten = next((o for o in (_find(macro, "dgs10"), _find(macro, "10y"), _find(macro, "10 yr"), _find(macro, "10-year"))
                if o and "%" in (o.get("unit") or "") and "spread" not in (o.get("label") or "").lower()), None)
    if ten:
        f10 = fac["us10y_bps"]
        d20 = sum(f10[k] for k in sorted(f10)[-20:]) if len(f10) >= 20 else None
        ins.append({"id": "rates", "title": f"10Y {ten['value']:.2f}%" + (f" · {d20:+.0f} bp / 20d" if d20 is not None else ""),
                    "observation": "Long rates set the discount rate for every stock.",
                    "evidence": [x for x in [_ev(ten), _ev(_find(macro, "10y", "2y"), "10y-2y spread")] if x],
                    "why": "Stocks with large negative rate sensitivity have historically fallen when yields rise.",
                    "watch": [{"metric": "10Y yield", "next_event": e} for e in _next_events(cal, {"CPI", "FOMC", "PCE"})],
                    "exposed": _exposed(tick_rel, "us10y_bps", -1) + _exposed(tick_rel, "us10y_bps", +1, 3),
                    "playbook": "trend", "confidence": "medium"})
    vix = _find(macro, "vix")
    if vix:
        ivs = sorted(((t, (v.get("atm_iv") or {}).get("iv")) for t, v in tickers.items() if (v.get("atm_iv") or {}).get("iv")),
                     key=lambda x: -x[1])[:5]
        ins.append({"id": "vol", "title": f"VIX {vix['value']:.1f}" + (f" · {_chg(vix, 5):+.1f} / 5d" if _chg(vix, 5) is not None else ""),
                    "observation": "Market-wide 30-day implied volatility (not direction, not single-stock IV).",
                    "evidence": [x for x in [_ev(vix), _ev(_find(macro, "vix3m"), "VIX3M (3-month)")] if x],
                    "why": "Option premium is richer when implied vol is high; jump risk is too.",
                    "watch": [{"metric": "VIX vs VIX3M (term structure)", "next_event": e} for e in _next_events(cal, {"FOMC", "CPI", "NFP"})],
                    "exposed": [{"ticker": t, "factor": "atm_iv", "coef": iv, "t": None} for t, iv in ivs] + _exposed(tick_rel, "vix", -1, 3),
                    "playbook": "scheduled", "confidence": "medium"})
    dxy = _find(macro, "dxy") or _find(macro, "dollar")
    if dxy:
        ins.append({"id": "dollar", "title": f"Dollar (DXY) {dxy['value']:.1f}",
                    "observation": "A stronger dollar shrinks overseas revenue when converted back.",
                    "evidence": [_ev(dxy)], "why": "Most exposed names below moved opposite the dollar historically.",
                    "watch": [{"metric": "DXY 20-day change", "next_event": e} for e in _next_events(cal, {"FOMC"}, 1)],
                    "exposed": _exposed(tick_rel, "dxy", -1) + _exposed(tick_rel, "dxy", +1, 3), "playbook": "trend", "confidence": "low"})
    wti = _find(macro, "wti") or _find(macro, "crude")
    if wti:
        ins.append({"id": "oil", "title": f"WTI ${wti['value']:.2f}",
                    "observation": "Oil feeds inflation and input costs; producers gain, heavy users lose.",
                    "evidence": [x for x in [_ev(wti), _ev(_find(macro, "brent"))] if x], "why": "Sensitivities below are measured, not assumed by sector.",
                    "watch": [{"metric": "WTI, EIA inventories", "next_event": e} for e in _next_events(cal, {"EIA"}, 1)],
                    "exposed": _exposed(tick_rel, "wti", +1, 4) + _exposed(tick_rel, "wti", -1, 4), "playbook": "trend", "confidence": "low"})
    hy = _find(macro, "oas") or _find(macro, "high yield")
    if hy:
        u = hy.get("unit") or ""
        hv = f"{hy['value']:.0f} bp" if "bp" in u or hy["value"] > 30 else f"{hy['value']:.2f}%"
        ins.append({"id": "credit", "title": f"HY credit spread {hv}",
                    "observation": "Extra yield junk borrowers pay. Widening = funding stress building.",
                    "evidence": [_ev(hy)], "why": "Credit usually moves before equity stress is obvious.",
                    "watch": [{"metric": "HY OAS 5-day change", "next_event": "daily"}], "exposed": [], "playbook": "shock", "confidence": "low"})
    if attribution:
        mv_items = [(t, a) for t, a in attribution.items() if not mv_set or t in mv_set]
        top = sorted(mv_items or list(attribution.items()), key=lambda kv: -abs(kv[1]["actual"]))[:6]
        ins.append({"id": "movers", "title": "Moves on shared sessions: market or company?",
                    "observation": "Each move split into the part our factors explain and the stock-specific rest.",
                    "evidence": [{"label": t, "value": f"{a['actual']:+.1f}% = {a['explained']:+.1f} factors {a['stock_specific']:+.1f} own",
                                  "unit": "", "period": a["date"], "source_url": None, "status": a["status"]} for t, a in top],
                    "why": "Large stock-specific moves usually mean news; factor-driven moves follow the macro tape.",
                    "watch": [], "exposed": [{"ticker": t, "factor": "stock_specific", "coef": a["stock_specific"], "t": None} for t, a in top],
                    "playbook": "scheduled", "confidence": "medium"})
    soon = sorted(((t, v["earnings"]["days_until"]) for t, v in tickers.items()
                   if (v.get("earnings") or {}).get("days_until") is not None and 0 <= v["earnings"]["days_until"] <= 7), key=lambda x: x[1])
    if soon:
        ins.append({"id": "earnings", "title": f"{len(soon)} earnings in the next 7 days",
                    "observation": "Earnings inside an option's life = gap risk; event IV usually falls after the report.",
                    "evidence": [{"label": t, "value": f"in {d}d", "unit": "", "period": None, "source_url": None, "status": "ok"} for t, d in soon[:8]],
                    "why": "Overlap with CPI/FOMC the same week stacks two event risks.",
                    "watch": [{"metric": "macro events same week", "next_event": e} for e in _next_events(cal, {"CPI", "FOMC", "PCE", "NFP", "PPI"}, 3)],
                    "exposed": [{"ticker": t, "factor": "earnings_days", "coef": d, "t": None} for t, d in soon[:8]], "playbook": "scheduled", "confidence": "high"})
    for c in ins:
        c["evidence"] = [e for e in c["evidence"] if e]
    event("relate", "insights", "OK", f"{len(ins)} cards", len(ins))
    return {"generated_at": utc_now(), "window": f"{WINDOW} sessions to {last_day}" if last_day else "n/a",
            "factors": use_f, "factor_units": {k: u for k, _, u in FACTORS}, "factors_dropped": missing_f,
            "input_units": {"equity_returns": "fraction (0.01 = 1%)", "dxy_ret": "percent",
                            "wti_ret": "percent", "us10y_bps_chg": "basis points", "vix_chg": "index points"},
            "method": __doc__.strip(), "tickers": tick_rel, "sectors": sec_out, "trends": trends,
            "attribution": attribution, "insights": ins, "regime": regime(macro, eq),
            "vol_breadth": vol_breadth(macro, eq)}


def main(argv: list[str]) -> int:
    in_dir = Path(argv[argv.index("--in") + 1]) if "--in" in argv else Path("out") / date.today().isoformat()
    rel = build(in_dir)
    write_json(in_dir / "relations.json", rel)
    print(f"relations: {len(rel['tickers'])} tickers, {len(rel['insights'])} insights -> {in_dir / 'relations.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
