"""Export out/<date>/*.json -> app/data/ for the interactive analyst app (lane R3).

Reads only stage outputs (macro, calendar, equities, relations, crosscheck, raw/prices.csv.gz);
never fetches network, never recomputes a stage's numbers. What it does compute is listed in
EXPORT_METHODS and written into core.json so the page can cite it:
  - 3M sparkline / 1Y chart bars are copied from raw/prices.csv.gz (bars after asof_session dropped).
  - the reference four Opportunity components are re-derived from his own EXPLAIN raw values with his
    documented formulas (docs/score-definitions.json) and shown ONLY when they reproduce his
    published composite to two decimals from retained inputs; otherwise only raw values are shown.
  - Signals: one-line rows built from relations.json coefficients/t-stats and macro history.
Usage: python -m smartoptions.export [--date YYYY-MM-DD] [--out app/data]
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
import sys
from pathlib import Path

from datetime import date as dt_date, timedelta
from statistics import median as stat_median
from smartoptions.contract import utc_now
from smartoptions.log import event

ROOT = Path(__file__).resolve().parents[1]
STAGE = "export"
FACTORS = ["spy", "us10y_bps", "dxy", "wti", "vix"]
SPARK_N = 63      # ~3 months of sessions
CHART_N = 260     # ~1 year of sessions

EXPORT_METHODS = {
    "spark_3m": "Last 63 sessions of Adj Close from raw/prices.csv.gz (Yahoo via yfinance).",
    "chart": "Last 260 sessions of unadjusted OHLC + volume from raw/prices.csv.gz; bars after the as-of session are dropped (partial day).",
    "scenario": "Scenario impact % = sum over factors of (regression coefficient x your shock). Coefficients from relations.json (OLS, 252 sessions). Historical association, not a forecast.",
    "sam_components": "Historical opportunity components from retained EXPLAIN inputs: round base score to 2 decimals, multiply by QualityMult and RiskMult; AVOID is hard-excluded (RiskMult 0). Component scores shown only when the result matches the published score to 2 decimals. Retained inputs can have less precision than the original run; published scores are always copied unchanged.",
    "signals": "Factor rows: 20-session change of the factor from macro history; tickers = largest |coef| with |t| >= 2. Mover rows: relations.json attribution (explained vs stock-specific).",
    "residuals_multi_horizon": "1d, 5d, and 20d idiosyncratic residuals (%) = cumulative stock return minus sum(252d OLS beta x factor move) over shared sessions.",
    "tactical_beta_60d": "60-session rolling OLS factor sensitivities alongside 252-session structural betas; beta_shift = 60d minus 252d coefficient.",
    "implied_eps_growth": "Implied forward EPS growth % = (pe_trailing / pe_forward - 1) * 100 when both trailing and forward P/E are positive.",
    "sector_rel_valuation": "pef_sec_rel = ticker forward P/E divided by GICS sector median forward P/E across the universe.",
    "rv20_ivrv": "rv20 = 20-session annualized realized volatility (%) from log Adj Close returns (sample std * sqrt(252) * 100). ivrv = ATM IV / rv20.",
    "last_earnings_ler": "Most recent prior earnings date (ler): Yahoo get_earnings_dates last_date when present, else prior-quarter cycle (-91d from upcoming Yahoo earnings date anchored to nearest high-volume session) or largest gap x volume session in the prior 90 days.",
    "sam_drift": "Drift since the retained 2026-07-25 historical snapshot: px_drift_pct = (px / sam.px - 1) * 100, pef_drift = pef - sam.fpe.",
}


def r(x, nd=4):
    """Round finite numbers; anything non-finite becomes None (never NaN in JSON)."""
    if x is None or isinstance(x, bool):
        return x
    if isinstance(x, (int, float)):
        if isinstance(x, float) and (math.isnan(x) or math.isinf(x)):
            return None
        return round(float(x), nd) if isinstance(x, float) else x
    return x


def public_copy(obj):
    """Keep legacy cache explanations generic without altering keys or measured values."""
    if isinstance(obj, dict):
        return {k: public_copy(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [public_copy(v) for v in obj]
    if isinstance(obj, str):
        return obj.replace("Sam's screener", "historical screener").replace("Sam's ", "historical ").replace("Sam ", "Historical ")
    return obj


def write_compact(path: Path, obj) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    s = json.dumps(public_copy(obj), separators=(",", ":"), allow_nan=False, ensure_ascii=False)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(s, encoding="utf-8")
    tmp.replace(path)
    return len(s.encode("utf-8"))


def load(src: Path, name: str, required=True):
    p = src / name
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        event(STAGE, name, "OK", f"read {p}", count=len(d) if hasattr(d, "__len__") else None)
        return d
    except Exception as e:  # degrade to missing, never crash silently
        event(STAGE, name, "FAIL" if required else "WARN", f"{type(e).__name__}: {e}")
        if required:
            raise
        return None


# ---------- Sam components (his documented formulas; display-only, validated) ----------
def _clamp(v, lo=0.0, hi=100.0):
    return max(lo, min(hi, v))


QMULT = {"GREAT": 1.15, "GOOD": 1.05, "OK": 1.00, "WEAK": 0.80}
RMULT = {"SAFE": 1.10, "WATCH": 1.00, "RISKY": 0.75, "AVOID": 0.0}


def _f(s):
    try:
        v = float(s)
        return None if math.isnan(v) else v
    except (TypeError, ValueError):
        return None


def sam_components(explain: dict | None):
    """Return {'parts':[...], 'reproduced':bool, 'derived':x, 'published':y} or None."""
    if not explain or "opp" not in explain:
        return None
    o = explain["opp"]
    ar, iv, dist, dl = (_f((o.get(k) or {}).get("val")) for k in ("annual_return", "iv", "distance", "delta"))
    parts = [
        {"k": "Annual return", "w": 35, "raw": ar, "unit": "%",
         "score": None if ar is None else _clamp((ar - 15) / 35 * 100)},
        {"k": "IV", "w": 25, "raw": iv, "unit": "%",
         "score": None if iv is None else (0.0 if iv < 30 or iv > 120 else (iv - 30) / 90 * 100)},
        {"k": "Dist. 52w high", "w": 20, "raw": dist, "unit": "%",
         "score": 0.0 if dist is None else _clamp((1 - dist / 25) * 100)},
        {"k": "Delta fit", "w": 20, "raw": dl, "unit": "",
         "score": 0.0 if dl is None else _clamp((1 - abs(abs(dl) - 0.20) / 0.15) * 100)},
    ]
    for p in parts:
        p["desc"] = (o.get({"Annual return": "annual_return", "IV": "iv", "Dist. 52w high": "distance",
                            "Delta fit": "delta"}[p["k"]]) or {}).get("desc")
    published = _f(explain.get("comp_score"))
    q = (explain.get("quality") or {}).get("tier")
    rk = (explain.get("risk") or {}).get("risk_tier")
    reproduced, derived, base = False, None, None
    if all(p["score"] is not None for p in parts):
        base = round(sum(p["w"] * p["score"] for p in parts) / 100, 2)
        derived = 0.0 if rk == "AVOID" else min(100.0, base * QMULT.get(q, 1.0) * RMULT.get(rk, 1.0))
        reproduced = published is not None and round(derived, 2) == round(published, 2)
    out = {"parts": [{k: r(v, 2) if isinstance(v, float) else v for k, v in p.items()} for p in parts],
           "quality_tier": q, "risk_tier": rk, "qmult": QMULT.get(q, 1.0), "rmult": RMULT.get(rk, 1.0),
           "base_score": base, "derived": r(derived, 2), "published": published, "reproduced": reproduced}
    if not reproduced:  # never show a component score we cannot tie back to his number
        for p in out["parts"]:
            p["score"] = None
    return out


# ---------- scenario (mirrored in app/app.js scenarioImpact) ----------
def scenario_impact(coef: dict, shock: dict):
    """sum(coef[f] * shock[f]) over factors with a shock; None if any needed coef is missing."""
    tot = 0.0
    for f, s in shock.items():
        if not s:
            continue
        c = coef.get(f)
        if c is None:
            return None
        tot += c * s
    return tot


# ---------- helpers ----------
def macro_index(macro):
    idx = {}
    for g, obs in (macro.get("groups") or {}).items():
        for o in obs:
            idx[o["id"]] = (g, o)
    return idx


def hist_change(o, n):
    h = o.get("history") or []
    if len(h) <= n:
        return None
    a, b = h[-1][1], h[-1 - n][1]
    return None if a is None or b is None else a - b


def compact_obs(g, o):
    hist = o.get("history") or []
    return {"id": o["id"], "g": g, "label": o.get("label"), "provider": o.get("provider"), "series": o.get("series"),
            "url": o.get("source_url"), "unit": o.get("unit"), "v": r(o.get("value")), "prior": r(o.get("prior")),
            "period": o.get("period"), "date": o.get("date"), "status": o.get("status"), "note": o.get("note"),
            "transform": o.get("transform"), "retrieved_at": o.get("retrieved_at"),
            "h": [[d, r(v)] for d, v in hist]}


def read_prices(src: Path, asof: str):
    import pandas as pd
    p = src / "raw" / "prices.csv.gz"
    df = pd.read_csv(p)
    n_all = len(df)
    df = df[df["Date"] <= asof]
    event(STAGE, "prices.csv.gz", "OK", f"rows {n_all}, kept {len(df)} with Date <= {asof}", count=len(df))
    out = {}
    for sym, g in df.groupby("Symbol"):
        g = g.sort_values("Date").tail(CHART_N)
        out[sym] = g
    return out


def compute_rv20(g) -> float | None:
    """20-session annualized realized volatility (%) from Adj Close log returns."""
    if g is None or len(g) < 21:
        return None
    closes = [float(v) for v in g["Adj Close"].tail(21).tolist() if v is not None and v == v and v > 0]
    if len(closes) < 21:
        return None
    lrets = [math.log(closes[i] / closes[i - 1]) for i in range(1, len(closes))]
    mean_r = sum(lrets) / len(lrets)
    var = sum((x - mean_r) ** 2 for x in lrets) / (len(lrets) - 1)
    return r(math.sqrt(var) * math.sqrt(252) * 100.0, 2)


def infer_last_earnings(er: dict, g, asof: str) -> tuple[str | None, str | None]:
    """Return (ler_date, ler_source) using explicit last_date, prior-quarter cycle (-91d), or volume-gap session."""
    if er.get("last_date"):
        return str(er["last_date"])[:10], "Yahoo get_earnings_dates"
    if g is None or len(g) < 15:
        return None, None
    try:
        asof_dt = dt_date.fromisoformat(str(asof)[:10])
    except Exception:
        return None, None
    dates = [str(d)[:10] for d in g["Date"].tolist()]
    closes = [float(c) if c == c else None for c in g["Close"].tolist()]
    vols = [float(v) if v == v and v is not None else 0.0 for v in g["Volume"].tolist()]
    vol_med = stat_median([v for v in vols[-60:] if v > 0]) if any(v > 0 for v in vols[-60:]) else 1.0

    er_date_s = er.get("date")
    if er_date_s:
        try:
            er_dt = dt_date.fromisoformat(str(er_date_s)[:10])
            days_ahead = (er_dt - asof_dt).days
            if 0 <= days_ahead <= 95:
                target_dt = er_dt - timedelta(days=91)
                best_d, best_score = None, -1.0
                for i in range(1, len(dates)):
                    try:
                        d_dt = dt_date.fromisoformat(dates[i])
                    except Exception:
                        continue
                    if abs((d_dt - target_dt).days) <= 7 and (asof_dt - d_dt).days <= 95:
                        c0, c1 = closes[i - 1], closes[i]
                        ret_abs = abs((c1 / c0 - 1.0) * 100.0) if (c0 and c1 and c0 > 0) else 0.0
                        vr = (vols[i] / vol_med) if vol_med > 0 else 1.0
                        sc = ret_abs * max(vr, 0.5)
                        if sc > best_score:
                            best_score = sc
                            best_d = dates[i]
                if best_d:
                    return best_d, "Prior-quarter cycle (-91d from upcoming Yahoo earnings)"
        except Exception:
            pass

    # Fallback: largest single-session gap*volume shock within last 75 calendar days
    best_d, best_score = None, -1.0
    for i in range(1, len(dates)):
        try:
            d_dt = dt_date.fromisoformat(dates[i])
        except Exception:
            continue
        age = (asof_dt - d_dt).days
        if 1 <= age <= 75:
            c0, c1 = closes[i - 1], closes[i]
            ret_abs = abs((c1 / c0 - 1.0) * 100.0) if (c0 and c1 and c0 > 0) else 0.0
            vr = (vols[i] / vol_med) if vol_med > 0 else 1.0
            sc = ret_abs * max(vr, 1.0)
            if ret_abs >= 1.8 and sc > best_score:
                best_score = sc
                best_d = dates[i]
    if best_d:
        return best_d, "Estimated prior earnings shock session (75d window)"
    return None, None


def read_docs():
    """METHODS.md + score definitions, shown verbatim in the app's About drawer."""
    out = {}
    for key, name in (("methods_md", "METHODS.md"), ("score_defs", "score-definitions.json")):
        p = ROOT / "docs" / name
        try:
            txt = p.read_text(encoding="utf-8")
            out[key] = json.loads(txt) if name.endswith(".json") else txt
        except Exception as e:
            event(STAGE, name, "WARN", f"About drawer source unreadable: {type(e).__name__}: {e}")
            out[key] = None
    return out


def build(date_s: str | None = None, out_dir: Path | None = None, input_dir: Path | None = None) -> dict:
    out_root = ROOT / "out"
    if input_dir is not None and not date_s:
        date_s = Path(input_dir).name
    if not date_s:
        lt = out_root / "latest.txt"
        if lt.exists():
            date_s = lt.read_text().strip()
        else:
            date_s = sorted(p.name for p in out_root.iterdir() if p.is_dir() and p.name[:2] == "20")[-1]
    src = Path(input_dir) if input_dir is not None else out_root / date_s
    out_dir = out_dir or ROOT / "app" / "data"
    macro = load(src, "macro.json")
    cal = load(src, "calendar.json", required=False) or {"events": []}
    eq = load(src, "equities.json")
    rel = load(src, "relations.json")
    xc = load(src, "crosscheck.json", required=False)
    asof = eq["asof_session"]
    px = read_prices(src, asof)
    midx = macro_index(macro)
    reltk = rel.get("tickers") or {}
    attr = rel.get("attribution") or {}

    # Pre-compute sector medians for forward P/E and ATM IV
    sec_pefs: dict[str, list[float]] = {}
    sec_ivs: dict[str, list[float]] = {}
    all_ivs: list[float] = []
    for _t, _x in eq["tickers"].items():
        _sec = _x.get("sector") or "Unknown"
        _pef = _f(_x.get("pe_forward"))
        if _pef is not None and _pef > 0:
            sec_pefs.setdefault(_sec, []).append(_pef)
        _iv = _f((_x.get("atm_iv") or {}).get("iv"))
        if _iv is not None and _iv > 0:
            sec_ivs.setdefault(_sec, []).append(_iv)
            all_ivs.append(_iv)
    sec_pef_med = {s: r(stat_median(vals), 2) for s, vals in sec_pefs.items() if vals}
    sec_iv_med = {s: r(stat_median(vals), 2) for s, vals in sec_ivs.items() if vals}
    univ_iv_med = r(stat_median(all_ivs), 2) if all_ivs else 22.0

    # ---- rows ----
    rows, pxfiles, sam_repro = [], 0, [0, 0]
    for t, x in eq["tickers"].items():
        sam = x.get("sam")
        g = px.get(t)
        spark = [] if g is None else [r(v, 2) for v in g["Adj Close"].tail(SPARK_N).tolist()]
        rv20 = compute_rv20(g)
        rr = reltk.get(t)
        att_t = attr.get(t) or {}
        comps = sam_components(sam.get("explain")) if sam else None
        if comps:
            sam_repro[0 if comps["reproduced"] else 1] += 1
        rng = x.get("range_52w") or {}
        er = x.get("earnings") or {}
        ler_date, ler_src = infer_last_earnings(er, g, asof)
        iv = x.get("atm_iv") or None
        iv_val = r(iv.get("iv"), 2) if iv else None
        sec_name = x.get("sector") or "Unknown"
        iv_sec = sec_iv_med.get(sec_name, univ_iv_med)
        pe_val = r(x.get("pe_trailing"), 2)
        pef_val = r(x.get("pe_forward"), 2)
        pef_med = sec_pef_med.get(sec_name)
        pef_sec_rel = r(pef_val / pef_med, 3) if (pef_val and pef_val > 0 and pef_med and pef_med > 0) else None
        eps_g_imp = r((pe_val / pef_val - 1.0) * 100.0, 2) if (pe_val and pe_val > 0 and pef_val and pef_val > 0) else None
        ivrv = r(iv_val / rv20, 2) if (iv_val and rv20 and rv20 > 0) else None
        ivrv_eff = ivrv if ivrv is not None else (r(iv_sec / rv20, 2) if (iv_sec and rv20 and rv20 > 0) else None)
        an = x.get("analyst") or {}
        peg = x.get("peg") or {}
        px_val = r(x.get("price"), 2)
        sam_drift = None
        if sam:
            sam_px = _f(sam.get("price"))
            sam_fpe = _f(sam.get("forward_pe"))
            q_exp = ((sam.get("explain") or {}).get("quality") or {})
            sam_drift = {
                "px_pct": r((px_val / sam_px - 1.0) * 100.0, 2) if (px_val and sam_px and sam_px > 0) else None,
                "pef_chg": r(pef_val - sam_fpe, 2) if (pef_val and sam_fpe and sam_fpe > 0) else None,
                "roe": r(_f((q_exp.get("roe") or {}).get("val")), 2),
                "de": r(_f((q_exp.get("debt_equity") or {}).get("val")), 2),
                "rev_g": r(_f((q_exp.get("rev_growth") or {}).get("val")), 2),
                "eps_g": r(_f((q_exp.get("eps_growth") or {}).get("val")), 2),
            }
        row = {
            "t": t, "n": x.get("name"), "sec": x.get("sector"), "ind": x.get("industry"), "sets": x.get("sets"),
            "sp500_member": x.get("sp500_member"),
            "sam_status": x.get("sam_status") or ("available" if sam else "not in historical screener"),
            "px": px_val, "pxd": x.get("price_date"), "d1": r(x.get("chg_1d_pct"), 3),
            "d5": r(x.get("chg_5d_pct"), 3), "m1": r(x.get("chg_1m_pct"), 3), "vr": r(x.get("vol_ratio_20d"), 2),
            "lo": r(rng.get("low"), 2), "hi": r(rng.get("high"), 2), "pct": r(rng.get("pctile"), 1),
            "pe": pe_val, "pef": pef_val, "pef_sec_med": pef_med, "pef_sec_rel": pef_sec_rel, "eps_g_imp": eps_g_imp,
            "peg": r(peg.get("value"), 3), "pegm": peg.get("method_text") or peg.get("method"),
            "er": er.get("date"), "ert": er.get("time"), "ern": er.get("days_until"), "ers": er.get("source"),
            "ler": ler_date, "lers": ler_src,
            "iv": iv_val, "ivx": iv.get("expiry") if iv else None,
            "ivk": iv.get("strike") if iv else None, "ivspan": iv.get("spans_earnings") if iv else None,
            "ivs": iv.get("source") if iv else None,
            # Delayed chain context (optional): chain retrieval time and per-leg values as returned; last trade dates only the trade.
            "ivat": iv.get("retrieved_at") if iv else None,
            "ivq": [{k: q.get(k) for k in ("leg", "strike", "iv_pct", "bid", "ask", "open_interest", "last_trade_utc")} for q in (iv.get("quote") or [])] if iv and iv.get("quote") else None,
            "rv20": rv20, "iv_sec_med": iv_sec, "ivrv": ivrv, "ivrv_eff": ivrv_eff,
            "res1d": r(att_t.get("stock_specific"), 2),
            "res5d": r(att_t.get("resid_5d"), 2),
            "res20d": r(att_t.get("resid_20d"), 2),
            "rating": an.get("rating"), "tgt": r(an.get("target_mean"), 2), "up": r(an.get("upside_pct"), 2),
            "nan": an.get("n"), "beta": r(x.get("beta_provider"), 3), "mcap": x.get("market_cap"),
            "st": x.get("status") or {}, "spark": spark,
            "rat": ((x.get("provenance") or {}).get("pe_forward") or {}).get("retrieved_at"),
            "sam": None if not sam else {
                "opp": sam.get("opportunity_score"), "q": sam.get("quality"), "trend": sam.get("trendscore"),
                "risk": sam.get("risk"), "flags": sam.get("risk_flags"), "earn_in": sam.get("earnings_in"),
                "rsi": sam.get("rsi_14"), "fpe": sam.get("forward_pe"), "px": sam.get("price"),
                "asof": sam.get("snapshot_asof"), "label": sam.get("snapshot_label")},
            "sam_drift": sam_drift,
            "rel": None if not rr else {
                "c": {k: r(v, 5) for k, v in rr["coef"].items()}, "t": rr["t"],
                "r2": rr.get("r2"), "n": rr.get("n"),
                "c60": {k: r(v, 5) for k, v in (rr.get("coef_60d") or {}).items()} if rr.get("coef_60d") else None,
                "t60": rr.get("t_60d"),
                "r2_60": rr.get("r2_60d"),
                "bshift": rr.get("beta_shift"),
            },
            "att": attr.get(t),
        }
        rows.append(row)
        if g is not None:
            bars = [[d, r(o, 2), r(h, 2), r(l, 2), r(c, 2), None if v != v else int(v)]
                    for d, o, h, l, c, v in zip(g["Date"], g["Open"], g["High"], g["Low"], g["Close"], g["Volume"])]
            detail = {"t": t, "bars": bars, "prov": x.get("provenance"), "sam_explain": sam.get("explain") if sam else None,
                      "sam_full": {k: v for k, v in sam.items() if k != "explain"} if sam else None,
                      "sam_components": comps, "peg_inputs": peg.get("inputs"), "earn_note": (x.get("provenance") or {}).get("earnings", {}).get("note")}
            write_compact(out_dir / "px" / f"{t}.json", detail)
            pxfiles += 1
        else:
            event(STAGE, f"prices:{t}", "WARN", "no price bars in raw/prices.csv.gz; chart will show missing")
            write_compact(out_dir / "px" / f"{t}.json", {
                "t": t, "bars": [], "prov": x.get("provenance"),
                "sam_explain": sam.get("explain") if sam else None,
                "sam_full": {k: v for k, v in sam.items() if k != "explain"} if sam else None,
                "sam_components": comps, "peg_inputs": peg.get("inputs"), "earn_note": None,
                "status": "missing", "reason": "Yahoo returned no completed daily bars"})
            pxfiles += 1
    event(STAGE, "sam_components", "OK" if sam_repro[1] == 0 else "WARN",
          f"reproduced {sam_repro[0]}, not reproduced {sam_repro[1]} (components hidden for those)", count=sam_repro[0])

    # benchmark bars (SPY, RSP) as px files too, for the chart
    for b in ("SPY", "RSP"):
        g = px.get(b)
        if g is not None:
            bars = [[d, r(o, 2), r(h, 2), r(l, 2), r(c, 2), None if v != v else int(v)]
                    for d, o, h, l, c, v in zip(g["Date"], g["Open"], g["High"], g["Low"], g["Close"], g["Volume"])]
            write_compact(out_dir / "px" / f"{b}.json", {"t": b, "bars": bars, "prov": {"price": {"provider": "Yahoo Finance via yfinance"}}})

    # ---- tape ----
    def mo(i):
        return midx.get(i, (None, None))[1]

    tape = []
    reg = rel.get("regime") or {}
    tape.append({"id": "regime", "label": "Regime", "v": reg.get("score"), "unit": "score", "tier": reg.get("tier"),
                 "chg": None, "spark": [v for _, v in (reg.get("history_partial") or [])][-30:],
                 "src": reg.get("method"), "status": "ok" if reg.get("score") is not None else "missing"})
    spy = eq["benchmarks"].get("SPY") or {}
    spyg = px.get("SPY")
    tape.append({"id": "SPY", "label": "SPY", "v": r(spy.get("price"), 2), "unit": "$", "chg": r(spy.get("chg_1d_pct"), 2),
                 "chgu": "%", "date": spy.get("price_date"), "status": spy.get("status"), "src": spy.get("provenance"),
                 "spark": [] if spyg is None else [r(v, 2) for v in spyg["Close"].tail(30).tolist()]})
    for oid, lab, cid, cu in [("us10y", "10Y", "us10y_bps_chg", "bp"), ("spread_10y_2y", "2s10s", None, "bp"),
                              ("dxy", "DXY", "dxy_ret_1d", "%"), ("wti", "WTI", "wti_ret_1d", "%"),
                              ("vix", "VIX", None, "pt"), ("hy_oas", "HY OAS", None, "bp")]:
        o = mo(oid)
        if not o:
            tape.append({"id": oid, "label": lab, "v": None, "status": "missing", "src": "not in macro.json"})
            continue
        chg = mo(cid)["value"] if cid and mo(cid) else hist_change(o, 1)
        item = {"id": oid, "label": lab, "v": r(o["value"]), "unit": o.get("unit"), "chg": r(chg, 3), "chgu": cu,
                "date": o.get("date"), "status": o.get("status"),
                "src": f"{o.get('provider')} {o.get('series')}", "spark": [r(v) for _, v in (o.get("history") or [])[-30:]]}
        if oid == "vix" and mo("vix3m") and o.get("value") and mo("vix3m").get("value"):
            item["extra"] = {"label": "VIX/VIX3M", "v": r(o["value"] / mo("vix3m")["value"], 3)}
        tape.append(item)
    vb = rel.get("vol_breadth") or {}
    vrp = vb.get("vrp") or {}
    vh = vrp.get("history") or []
    tape.append({"id": "vrp", "label": "VRP", "v": r(vrp.get("value"), 2), "unit": "vol pts",
                 "chg": r(vh[-1][1] - vh[-2][1], 2) if len(vh) > 1 else None, "chgu": "pt",
                 "date": vh[-1][0] if vh else None, "status": "ok" if vrp.get("value") is not None else "missing",
                 "src": "VIX minus SPY 21-session realized vol (relations.json vol_breadth)", "spark": [r(v, 2) for _, v in vh[-30:]]})

    # ---- chartable series (macro + SPY), for main chart + overlays ----
    series = {}
    for oid, (g, o) in midx.items():
        series[oid] = {"label": o.get("label"), "unit": o.get("unit"), "g": g}
    if spyg is not None:
        series["SPY"] = {"label": "SPY close", "unit": "$", "g": "equity"}
    series["vrp"] = {"label": "VRP (VIX - SPY RV21)", "unit": "vol pts", "g": "volatility"}
    series["regime"] = {"label": "Regime score (partial history)", "unit": "score", "g": "regime"}

    # ---- signals ----
    signals = []
    sig_t = 2.0
    fac_map = [("us10y_bps", "us10y", "10Y", "bp", 100.0, "%/bp"), ("dxy", "dxy", "DXY", "%", None, "%/1%"),
               ("wti", "wti", "WTI", "%", None, "%/1%"), ("vix", "vix", "VIX", "pt", 1.0, "%/pt")]
    for f, oid, lab, u, mult, cu in fac_map:
        o = mo(oid)
        if not o:
            continue
        if mult is None:
            c20 = mo(f"{oid}_ret_20d")
            ch = c20["value"] if c20 else None
        else:
            hc = hist_change(o, 20)
            ch = None if hc is None else hc * mult
        cands = [(t, v["coef"][f], v["t"][f]) for t, v in reltk.items()
                 if v["coef"].get(f) is not None and abs(v["t"].get(f) or 0) >= sig_t]
        if ch is None or not cands:
            continue
        # tickers that the 20d factor move pushed most (coef x move), both directions
        cands.sort(key=lambda z: z[1] * ch)
        for t, c, tt in [cands[0], cands[-1]]:
            signals.append({"kind": "factor", "factor": f, "t": t, "move": r(ch, 2), "moveu": u, "coef": r(c, 4), "tstat": tt,
                            "implied": r(c * ch, 2),
                            "text": f"{lab} {ch:+.1f}{u}/20d · {t} {c:+.3f}{cu} (t {tt:+.1f}) → {c * ch:+.1f}%"})
    for t, a in sorted(attr.items(), key=lambda kv: -abs(kv[1].get("stock_specific") or 0))[:6]:
        signals.append({"kind": "mover", "t": t, "actual": a.get("actual"), "explained": a.get("explained"),
                        "spec": a.get("stock_specific"),
                        "text": f"{t} {a['actual']:+.2f}% · factors {a['explained']:+.2f} · stock-specific {a['stock_specific']:+.2f}"})
    ivrows = sorted([x for x in rows if x["iv"] is not None and x["ern"] is not None and 0 <= x["ern"] <= 7],
                    key=lambda x: -x["iv"])[:4]
    for x in ivrows:
        signals.append({"kind": "earnings", "t": x["t"], "text": f"{x['t']} earnings in {x['ern']}d · ATM IV {x['iv']:.1f}%"})
    vo = mo("vix")
    v3 = mo("vix3m")
    if vo and v3 and vo.get("value") and v3.get("value"):
        signals.append({"kind": "macro", "sid": "vix",
                        "text": f"VIX/VIX3M {vo['value'] / v3['value']:.3f} · {'backwardation' if vo['value'] > v3['value'] else 'contango'}"})

    # ---- scenario self-check vector (JS recomputes on load; mismatch -> console.error) ----
    shock = {"us10y_bps": 25, "wti": -10, "dxy": 2, "vix": 5, "spy": -3}
    chk = {}
    for t in list(reltk)[:5]:
        chk[t] = r(scenario_impact(reltk[t]["coef"], shock), 6)

    core = {
        "schema": "smartoptions-app/1",
        "exported_at": utc_now(), "date": date_s, "asof_session": asof,
        "gen": {"macro": macro.get("generated_at"), "equities": eq.get("generated_at"),
                "relations": rel.get("generated_at"), "crosscheck": (xc or {}).get("generated_at")},
        "universe_source": eq.get("universe_source"), "meta": {
            **(eq.get("meta") or {}),
            "daily_returns_unit": (eq.get("meta") or {}).get("returns_unit"),
            "returns_unit": "percent (1.0 = 1%); rows.d1/d5/m1 use 1/5/21 adjusted-close sessions",
            "row_units": {"px": "USD/share", "mcap": "USD", "d1": "percent", "d5": "percent", "m1": "percent"}},
        "movers": eq.get("movers"),
        "rel": {"window": rel.get("window"), "factors": rel.get("factors"), "units": rel.get("factor_units"),
                "method": rel.get("method"), "sectors": rel.get("sectors"), "trends": rel.get("trends"),
                "regime": {k: v for k, v in reg.items() if k != "history_partial"},
                "regime_hist": reg.get("history_partial"),
                "vol_breadth": {k: v for k, v in vb.items()}, "insights": rel.get("insights")},
        "tape": tape, "series": series,
        "macro": {g: [compact_obs(g, o) for o in obs] for g, obs in macro["groups"].items()},
        "spy_close": [] if spyg is None else [[d, r(c, 2)] for d, c in zip(spyg["Date"], spyg["Close"])],
        "calendar": cal.get("events", []), "calendar_notes": cal.get("notes"),
        "crosscheck": xc, "signals": signals, "rows": rows,
        "methods": EXPORT_METHODS, "scenario_check": {"shock": shock, "expected": chk},
        "docs": read_docs(),
    }
    from smartoptions.brief.release_safety import guard_core
    guard_core(core)
    size = write_compact(out_dir / "core.json", core)
    n_in = len(eq["tickers"])
    sev = "OK" if len(rows) == n_in else "FAIL"
    event(STAGE, "core.json", sev, f"rows {len(rows)}/{n_in}, px files {pxfiles}, signals {len(signals)}, {size} bytes", count=len(rows))
    summary = {"date": date_s, "asof": asof, "rows": len(rows), "tickers_in": n_in, "px_files": pxfiles,
               "core_bytes": size, "signals": len(signals), "sam_reproduced": sam_repro[0], "sam_not_reproduced": sam_repro[1],
               "macro_obs": sum(len(v) for v in macro["groups"].values()), "events": len(cal.get("events", []))}
    return summary


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--date")
    ap.add_argument("--out")
    a = ap.parse_args(argv)
    s = build(a.date, Path(a.out) if a.out else None)
    print(json.dumps(s))
    return 0


if __name__ == "__main__":
    sys.exit(main())
