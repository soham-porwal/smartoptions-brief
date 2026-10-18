"""Lane E orchestration: build out/<date>/equities.json per PLAN.md."""
from __future__ import annotations

import argparse
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd

from ..contract import utc_now, write_json
from ..log import event
from ..sources import sam_checkpoints
from . import fundamentals, options, prices, sam, universe

ET = ZoneInfo("America/New_York")
BENCH = ["SPY", "RSP"]
MOVER_N = 15
UNUSUAL_MIN_RATIO = 2.0
SAM_IV_TOP = 30
MOVERS_METHOD = (
    "Session = latest completed regular US session (SPY's last bar; a partial bar from today before 16:15 ET is "
    "excluded). Universe = current S&P 500 constituents (Wikipedia list). Up/down = top 15 gainers / top 15 losers by "
    "1-day % change of adjusted close vs prior session's adjusted close. Unusual volume = top 15 by session volume / "
    "mean volume of the prior 20 sessions, minimum ratio 2.0. Ties broken by market cap (larger first)."
)


def rank_movers(chg: dict[str, float], vol: dict[str, float], mcap=lambda s: 0.0, n: int = MOVER_N,
                min_ratio: float = UNUSUAL_MIN_RATIO) -> dict:
    """Pure ranking per PLAN.md. chg: ticker->1d %, vol: ticker->volume ratio. mcap(t) breaks exact ties."""
    def top(vals: dict[str, float], reverse: bool) -> list[str]:
        items = sorted(vals.items(), key=lambda kv: kv[1], reverse=reverse)
        out: list[str] = []
        i = 0
        while i < len(items) and len(out) < n:
            j = i
            while j < len(items) and items[j][1] == items[i][1]:
                j += 1
            grp = [t for t, _ in items[i:j]]
            if len(grp) > 1:
                grp.sort(key=lambda t: (-(mcap(t) or 0.0), t))
            out.extend(grp)
            i = j
        return out[:n]

    return {"up": top(chg, True), "down": top(chg, False),
            "unusual_volume": top({t: v for t, v in vol.items() if v >= min_ratio}, True)}


def _market_cap_fn():
    def f(sym: str) -> float:
        try:
            import yfinance as yf
            return float(yf.Ticker(sym).fast_info["market_cap"])
        except Exception:  # noqa: BLE001
            return 0.0
    return f


def build(out_dir: Path, refresh: bool = False, limit: int | None = None, extra: list[str] | None = None,
          now: datetime | None = None) -> dict:
    now = now or datetime.now(ET)
    today = now.date()
    raw_dir = out_dir / "raw"

    # --- 1. the reference outputs (set B), checkpoints when configured; unchanged snapshot fallback.
    snap = sam_checkpoints.load_or_snapshot(today=today)
    sam_source = snap.get("source", "published_snapshot")
    sam_label = "SmartOptions checkpoints" if sam_source == "checkpoints" else sam.SNAPSHOT_LABEL
    rep = snap["report"]
    event("equities.sam", sam_source, "OK" if rep["ok"] and snap.get("status") == "ok" else "WARN",
          f"rows={rep['rows']} explain={rep['explain_keys']} declared={rep['declared_row_count']} "
          f"no_explain={len(rep['rows_without_explain'])} explain_no_row={len(rep['explain_without_row'])}", rep["rows"])
    if rep["rows"] == 0:
        event("equities.sam", "index.html", "SUSPECT", "parsed zero rows", 0)
    sam_rows = {universe.yahoo_symbol(r["ticker"]): r for r in snap["rows"]}
    sam_explain = {universe.yahoo_symbol(k): v for k, v in snap["explain"].items()}
    b_syms = list(sam_rows)

    # --- 2. constituents (set A pool)
    cons = universe.fetch_constituents()
    pool = cons["symbols"]
    if limit:  # test/fixture mode: restrict the pools, never used for the real run
        pool = pool[:limit]
        b_syms = b_syms[:limit]
    extra = [universe.yahoo_symbol(s) for s in (extra or [])]
    all_syms = sorted(set(pool) | set(b_syms) | set(BENCH) | set(extra))

    # --- 3. prices
    df = prices.download(all_syms, raw_dir, refresh=refresh)
    df, partial_note = prices.drop_partial_bar(df, now)
    if partial_note:
        event("equities.prices", "partial-bar", "WARN", partial_note)
    spy = df[df["Symbol"] == "SPY"]
    if spy.empty:
        event("equities.prices", "SPY", "FAIL", "no SPY bars; falling back to max date of all bars")
    asof = (spy["Date"].max() if not spy.empty else df["Date"].max()) if not df.empty else None
    asof_s = asof.strftime("%Y-%m-%d") if asof is not None and not pd.isna(asof) else None
    st = prices.stats(df, asof) if asof_s else {}
    if asof_s is None:
        event("equities.prices", "session", "WARN", "No usable daily bars; asof_session=null and all prices missing")
    event("equities.prices", "stats", "OK" if st else "SUSPECT", f"{len(st)}/{len(all_syms)} symbols with stats, asof {asof_s}", len(st))

    nobars = sorted(s for s in all_syms if s not in st)
    for s in nobars:
        n = int((df["Symbol"] == s).sum())
        event("equities.prices", s, "WARN", f"no usable price history ({n} bar(s) from Yahoo through {asof_s}); shown as missing")

    # --- movers (set A)
    cur = {t: s for t, s in st.items() if t in set(pool) and s["price_date"] == asof_s}
    chg = {t: s["chg_1d_pct"] for t, s in cur.items() if s["chg_1d_pct"] is not None}
    vol = {t: s["vol_ratio_20d"] for t, s in cur.items() if s["vol_ratio_20d"] is not None}
    movers = rank_movers(chg, vol, mcap=_market_cap_fn())
    a_syms = sorted(set(movers["up"]) | set(movers["down"]) | set(movers["unusual_volume"]))
    # Movers are a view of the index, never the retention filter. Keep legacy
    # snapshot-only names too so widening membership does not remove existing rows.
    universe_syms = sorted(set(pool) | set(a_syms) | set(b_syms) | set(extra))

    # --- 4. fundamentals
    raw = fundamentals.fetch(universe_syms, raw_dir, refresh=refresh)

    # --- assemble tickers
    tickers: dict[str, dict] = {}
    for s in universe_syms:
        p = st.get(s)
        price = p["price"] if p else None
        fields, fstat, fprov = fundamentals.shape(s, raw.get(s, {"fatal": "no record", "info": {}, "errors": []}), price, now)
        srow = sam_rows.get(s)
        name = (srow or {}).get("company") or cons["names"].get(s) or raw.get(s, {}).get("info", {}).get("shortName")
        sector = cons["sectors"].get(s) or (srow or {}).get("sector") or fields.get("sector")
        sets = [x for x, on in (("A", s in a_syms), ("B", s in sam_rows)) if on]
        price_retrieved = df.attrs.get("retrieved_at")
        pstat = "missing" if not p else ("ok" if p["price_date"] == asof_s and price_retrieved else "stale")
        t = {
            "name": name, "sector": sector, "sets": sets, "sp500_member": s in pool,
            "sam_status": "available" if srow else "not in historical screener",
            "price": price, "price_date": p["price_date"] if p else None,
            "chg_1d_pct": p["chg_1d_pct"] if p else None, "chg_5d_pct": p["chg_5d_pct"] if p else None,
            "chg_1m_pct": p["chg_1m_pct"] if p else None, "vol_ratio_20d": p["vol_ratio_20d"] if p else None,
            "range_52w": p["range_52w"] if p else {"low": None, "high": None, "pctile": None},
            **{k: fields[k] for k in ("pe_trailing", "pe_forward", "peg", "earnings", "analyst", "beta_provider")},
            "industry": fields.get("industry"), "market_cap": fields.get("market_cap"),
            "atm_iv": None, "sam": None,
        }
        if srow:
            t["sam"] = {**srow, "snapshot_label": f"{sam_label} {snap['asof'][:10]}" if snap["asof"] else sam_label,
                        "snapshot_asof": snap["asof"], "explain": sam_explain.get(s),
                        "source": sam_source, "status": snap.get("status", "stale"), "reason": snap.get("reason")}
        pv = {"price": {"provider": "Yahoo Finance via yfinance", "field": "Close (auto_adjust=False; not dividend-adjusted)",
                        "date": t["price_date"], "retrieved_at": price_retrieved,
                        **({} if p else {"reason": "Yahoo returned fewer than 2 completed daily bars (delisted, merged, renamed or newly listed)"})},
              "chg": {"provider": "Yahoo Finance via yfinance", "field": "Adj Close (split+dividend adjusted)", "date": t["price_date"]},
              "range_52w": {"provider": "Yahoo Finance via yfinance", "field": "daily High/Low, last 252 sessions, unadjusted",
                            "sessions": (p or {}).get("range_52w", {}).get("sessions")},
              "sector": {"provider": "Wikipedia GICS sector" if cons["sectors"].get(s) else "SmartOptions snapshot / Yahoo"},
              **fprov}
        for key, series, unit, method in (
            ("price", "Close", "USD/share", "Unadjusted daily Close, completed regular session"),
            ("chg", "Adj Close", "percent", "Adjusted Close / earlier session adjusted Close minus 1, *100; horizons 1, 5, 21 sessions"),
            ("range_52w", "High, Low", "USD/share; percentile percent", "Unadjusted daily High/Low extremes over last 252 available sessions; shorter history disclosed by sessions"),
            ("vol_ratio_20d", "Volume", "multiple", "Session volume / mean volume of preceding 20 sessions"),
        ):
            entry = pv.setdefault(key, {"provider": "Yahoo Finance via yfinance"})
            entry.update(series=f"{s}:{series}", unit=unit, method=method,
                         source_url=f"https://finance.yahoo.com/quote/{s}/history/",
                         period=t["price_date"], date=t["price_date"], retrieved_at=price_retrieved)
            if not price_retrieved:
                entry["reason"] = entry.get("reason") or "Acquisition timestamp unavailable in legacy cache; use --refresh"
        sts = {"price": pstat, "chg": pstat, "range_52w": pstat if p else "missing", "vol_ratio_20d": pstat if p and t["vol_ratio_20d"] is not None else "missing",
               "sam": snap.get("status", "stale") if srow else "missing", "atm_iv": "missing", **fstat}
        pv["sam"] = {"provider": sam_label, "source": sam_source, "date": snap.get("asof"),
                     "retrieved_at": snap.get("retrieved_at"), "files": snap.get("provenance", {}),
                     "reason": snap.get("reason") if srow else "not in historical screener"}
        pv["atm_iv"] = {"provider": "Yahoo Finance via yfinance", "reason": "not fetched: ATM IV only for movers (A) and the 30 highest historical opportunity Scores"}
        t["provenance"], t["status"] = pv, sts
        tickers[s] = t

    # --- 5. ATM IV: movers + top 30 Sam opportunity scores
    top_sam = [s for s, r in sorted(sam_rows.items(), key=lambda kv: -(kv[1].get("opportunity_score") or -1))
               if s in tickers][:SAM_IV_TOP]
    iv_syms = sorted((set(a_syms) | set(top_sam)) & {s for s in tickers if tickers[s]["price"]})

    iv_cache_path = raw_dir / "atm_iv.json"
    iv_cache = json.loads(iv_cache_path.read_text(encoding="utf-8")) if iv_cache_path.exists() and not refresh else {}

    def iv_job(s):
        t = tickers[s]
        if (iv_cache.get(s, {}).get("result") or {}).get("retrieved_at"):  # only a dated result from earlier today is reusable
            return s, iv_cache[s]["result"], None
        r, reason = None, None
        for attempt in range(2):
            r, reason = options.atm_iv(s, t["price"], today, t["earnings"]["date"])
            if r:
                break
            time.sleep(1.5)
        return s, r, reason

    n_iv = 0
    with ThreadPoolExecutor(max_workers=3) as ex:
        for s, r, reason in ex.map(iv_job, iv_syms):
            t = tickers[s]
            t["status"]["atm_iv"] = "ok" if r else "missing"
            # A kept result carries its own chain retrieval time; an older cache without one stays unknown, never "now".
            at = (r.get("retrieved_at") if r else utc_now())
            t["provenance"]["atm_iv"] = {"provider": "Yahoo Finance via yfinance", "source": options.IV_SOURCE,
                                         "retrieved_at": at, **({} if r else {"reason": reason}),
                                         **({"retrieval_note": "inherited cache result; original retrieval time not recorded"} if r and not at else {})}
            iv_cache[s] = {"result": r, "reason": reason}
            if r:
                t["atm_iv"] = r
                n_iv += 1
            else:
                event("equities.options", s, "WARN", reason or "")
    raw_dir.mkdir(parents=True, exist_ok=True)
    iv_cache_path.write_text(json.dumps(iv_cache), encoding="utf-8")
    event("equities.options", "yahoo-chain", "OK" if n_iv else "SUSPECT", f"{n_iv}/{len(iv_syms)} ATM IV", n_iv)

    # --- benchmarks + returns
    benchmarks = {}
    for b in BENCH:
        p = st.get(b)
        benchmarks[b] = ({"price": p["price"], "price_date": p["price_date"], "chg_1d_pct": p["chg_1d_pct"],
                          "chg_5d_pct": p["chg_5d_pct"], "chg_1m_pct": p["chg_1m_pct"], "range_52w": p["range_52w"],
                          "status": "ok" if p["price_date"] == asof_s else "stale",
                          "provenance": "Yahoo Finance via yfinance"} if p else {"status": "missing", "reason": "no bars"})
    ret_syms = [s for s in universe_syms if s in st] + [b for b in BENCH if b in st]
    rets = prices.returns(df, ret_syms, asof, 300)

    movers_out = {"method": MOVERS_METHOD, **movers}
    nuniq = len(tickers)
    result = {
        "generated_at": utc_now(), "asof_session": asof_s,
        "universe_source": f"{cons['source']} ({cons['count']} constituents); {sam_label} {snap['asof']} ({rep['rows']} rows)",
        "benchmarks": benchmarks, "tickers": tickers, "movers": movers_out, "returns": rets,
        "meta": {
            "sets": {"A": "top S&P 500 movers (up/down/unusual volume)", "B": f"the reference {sam_source} universe"},
            "counts": {"tickers": nuniq, "A": sum("A" in t["sets"] for t in tickers.values()),
                       "B": sum("B" in t["sets"] for t in tickers.values()), "constituents": cons["count"],
                       "retained_constituents": len(set(pool) & set(tickers))},
            "constituents": cons,
            "coverage": {"prices_missing": [s for s in universe_syms if s not in st],
                         "fundamentals_failed": {s: rec["fatal"] for s, rec in raw.items() if rec.get("fatal")}},
            "returns_unit": "decimal fraction per session (0.01 = 1%), from Adj Close pct_change",
            "partial_bar_note": partial_note,
            "sam_roundtrip": rep, "constituents_source_url": cons["url"],
            "sam_source": {k: snap.get(k) for k in ("source", "status", "reason", "asof", "provenance",
                           "retrieved_at", "run_date_method", "explain_source", "regime", "regime_history")},
            "price_note": "price and 52w range use unadjusted Close/High/Low; % changes and returns use Adj Close",
        },
    }
    if set(pool) - set(tickers):
        raise ValueError("Constituent round-trip mismatch")
    write_json(out_dir / "equities.json", result)
    event("equities.build", "equities.json", "OK" if tickers else "SUSPECT", f"wrote {nuniq} tickers, asof {asof_s}", nuniq)
    return result


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m smartoptions.equities")
    ap.add_argument("--out", required=True, help="output dir, e.g. out/2026-10-15")
    ap.add_argument("--refresh", action="store_true", help="ignore raw cache")
    ap.add_argument("--limit", type=int, default=None, help="restrict pools (testing only)")
    ap.add_argument("--extra", nargs="*", default=None, help="extra tickers to include (testing only)")
    a = ap.parse_args(argv)
    try:
        r = build(Path(a.out), refresh=a.refresh, limit=a.limit, extra=a.extra)
    except Exception as e:  # noqa: BLE001
        event("equities.build", "equities.json", "FAIL", repr(e))
        raise
    print(f"equities.json: {len(r['tickers'])} tickers asof {r['asof_session']}", file=sys.stderr)
    return 0
