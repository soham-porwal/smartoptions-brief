"""the reference own screener outputs (samsej/sp500-screener data/checkpoints) as the set-B source.

If env SAM_CHECKPOINT_DIR points at his data/checkpoints and OptionsScreener.csv is there, rows come from his
latest run (with file/mtime/run-date provenance) instead of the frozen 2026-07-25 published page. Otherwise
the published snapshot parser (smartoptions.equities.sam) is used unchanged and the status says so.

Schemas are taken from his writers on origin/main (read-only clone, Data/Refs/sam-sp500-screener):
  OptionsScreener.csv  scorer.py OUTPUT_COLUMNS (CompositeScore = the "Opportunity Score" his page shows)
  Technicals.csv       technicals.py _COLUMNS (RSI14, RS_1M)
  CompanyQuality.csv   quality_scorer.py _COLUMNS (EPSGrowthPct, RevenueGrowthPct, ROEPct, DebtToEquity, ForwardPE, Beta)
  RiskTrend.csv        risk_trend.py _COLUMNS (only used when OptionsScreener predates the M16 composite columns)
  MarketRegime.json    market_regime.compute_market_regime() return dict
  MarketRegimeHistory.json  market_regime.append_regime_history() records
The join and the column->field mapping copy his scripts/export_static_dashboard.py main()/build_html().
Values are passed through as he wrote them; nothing is rescored. A column his file lacks degrades that field
to None and logs a WARN, never a guessed value.
"""
from __future__ import annotations

import csv
import importlib.util
import json
import math
import os
from datetime import date, datetime, timezone
from pathlib import Path

from ..contract import staleness, utc_now
from ..equities import sam as snapshot
from ..log import event

ENV_DIR = "SAM_CHECKPOINT_DIR"
STAGE = "sources.sam_checkpoints"

# our snapshot field (smartoptions.equities.sam.FIELDS) -> (checkpoint file, his column)
FIELD_MAP = {
    "ticker": ("OptionsScreener.csv", "Ticker"),
    "company": ("OptionsScreener.csv", "Company"),
    "sector": ("OptionsScreener.csv", "Sector"),
    "price": ("OptionsScreener.csv", "Price"),
    "opportunity_score": ("OptionsScreener.csv", "CompositeScore"),
    "quality": ("OptionsScreener.csv", "QualityTier"),
    "eps_growth_pct": ("CompanyQuality.csv", "EPSGrowthPct"),
    "rev_growth_pct": ("CompanyQuality.csv", "RevenueGrowthPct"),
    "roe_pct": ("CompanyQuality.csv", "ROEPct"),
    "debt_equity": ("CompanyQuality.csv", "DebtToEquity"),
    "forward_pe": ("CompanyQuality.csv", "ForwardPE"),
    "trendscore": ("OptionsScreener.csv", "TrendScore"),
    "rsi_14": ("Technicals.csv", "RSI14"),
    "stock_1m": ("OptionsScreener.csv", "1M %"),
    "vs_sp500_1m": ("Technicals.csv", "RS_1M"),
    "below_52w_high": ("OptionsScreener.csv", "Distance From 52W High %"),
    "risk": ("OptionsScreener.csv", "RiskTier"),
    "earnings_in": ("OptionsScreener.csv", "DaysToEarnings"),
    "risk_flags": ("OptionsScreener.csv", "RiskFlags"),
}
# Pre-M16 OptionsScreener.csv lacks these; his RiskTrend.csv carries the same columns.
RISKTREND_COLS = ("QualityTier", "TrendScore", "RiskTier", "RiskFlags", "DaysToEarnings")
EXTRA_COLS = ("Note", "CompositeNote", "QualityScore", "Score", "Annual Return %", "IV", "Delta",
              "Strike", "DTE", "Bid", "FetchedAt")
REGIME_KEYS = ("RegimeDate", "RegimeScore", "Tier")
REGIME_TIERS = ("AVOID", "DEFENSIVE", "NORMAL", "FAVORABLE", "OPTIMAL")
QUALITY_TIERS = ("GREAT", "GOOD", "OK", "WEAK", "AVOID")  # quality_scorer.quality_tier()
RISK_TIERS = ("SAFE", "WATCH", "RISKY", "AVOID")


def num(v):
    """CSV text -> float, or None for blank/NaN. Non-numeric text is returned verbatim (never guessed)."""
    if v is None:
        return None
    s = str(v).strip()
    if s.lower() in ("", "nan", "none", "null", "—", "-"):
        return None
    try:
        f = float(s)
    except ValueError:
        return s
    return None if math.isnan(f) or math.isinf(f) else f


def text(v):
    s = "" if v is None else str(v).strip()
    return None if s.lower() in ("", "nan", "none", "null") else s


def read_csv(path: Path) -> tuple[list[str], list[dict]]:
    with path.open(newline="", encoding="utf-8") as f:
        r = csv.DictReader(f)
        return list(r.fieldnames or []), list(r)


def file_prov(path: Path, rows: int | None = None) -> dict:
    st = path.stat()
    return {"file": path.name, "path": str(path), "rows": rows,
            "mtime_utc": datetime.fromtimestamp(st.st_mtime, timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")}


def run_date(screener_rows: list[dict], regime: dict | None, mtime_utc: str) -> tuple[str, str]:
    """(YYYY-MM-DD[ HH:MM], how). Latest FetchedAt in his screener, else RegimeDate, else file mtime."""
    stamps = sorted(s for s in (text(r.get("FetchedAt")) for r in screener_rows) if s)
    if stamps:
        return stamps[-1].replace("T", " ")[:16], "max OptionsScreener.FetchedAt"
    if regime and regime.get("RegimeDate"):
        return str(regime["RegimeDate"])[:10], "MarketRegime.RegimeDate"
    return mtime_utc[:16].replace("T", " "), "OptionsScreener.csv file mtime (UTC)"


def load_regime(d: Path, log_dir: Path | None = None) -> tuple[dict | None, list, dict]:
    """His MarketRegime.json verbatim + history, validated against his writer's keys and tier vocabulary."""
    prov: dict = {}
    reg, hist = None, []
    p = d / "MarketRegime.json"
    if p.exists():
        prov["MarketRegime.json"] = file_prov(p)
        try:
            obj = json.loads(p.read_text(encoding="utf-8"))
            miss = [k for k in REGIME_KEYS if k not in obj]
            if miss or obj.get("Tier") not in REGIME_TIERS:
                event(STAGE, "MarketRegime.json", "WARN", f"schema mismatch: missing {miss} tier={obj.get('Tier')!r}; regime treated as missing", log_dir=log_dir)
            else:
                reg = obj
        except Exception as e:  # noqa: BLE001
            event(STAGE, "MarketRegime.json", "FAIL", f"unreadable: {e!r}", log_dir=log_dir)
    h = d / "MarketRegimeHistory.json"
    if h.exists():
        prov["MarketRegimeHistory.json"] = file_prov(h)
        try:
            obj = json.loads(h.read_text(encoding="utf-8"))
            good = [x for x in obj if isinstance(x, dict) and x.get("Date") and x.get("Tier") in REGIME_TIERS]
            if len(good) != len(obj):
                event(STAGE, "MarketRegimeHistory.json", "WARN", f"{len(obj) - len(good)} of {len(obj)} records failed schema (Date, Tier) and were dropped", log_dir=log_dir)
            hist = good
            prov["MarketRegimeHistory.json"]["rows"] = len(good)
        except Exception as e:  # noqa: BLE001
            event(STAGE, "MarketRegimeHistory.json", "FAIL", f"unreadable: {e!r}", log_dir=log_dir)
    return reg, hist, prov


def his_explain_module(d: Path):
    """His scripts/export_static_dashboard.py next to the checkpoints (repo/data/checkpoints -> repo/scripts)."""
    p = d.resolve().parents[1] / "scripts" / "export_static_dashboard.py"
    if not p.exists():
        return None, f"{p} not found"
    try:
        spec = importlib.util.spec_from_file_location("sam_export_static_dashboard", p)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        if not (hasattr(mod, "_build_explain") and hasattr(mod, "_pct_rank_all")):
            return None, "his export script has no _build_explain/_pct_rank_all (older version)"
        return mod, str(p)
    except Exception as e:  # noqa: BLE001
        return None, f"could not import his export script: {e!r}"[:200]


def build_explain(mod, joined: list[dict]) -> dict:
    """Exactly his build_html() EXPLAIN construction: percentile ranks over the same fields, median forward P/E."""
    fields = [("CompositeScore", True), ("Annual Return %", True), ("IV", True), ("QualityScore", True),
              ("EPSGrowthPct", True), ("RevenueGrowthPct", True), ("ROEPct", True), ("DebtToEquity", False),
              ("TrendScore", True)]
    ranks = {f: mod._pct_rank_all(joined, f, hib) for f, hib in fields}
    fpe = sorted(f for f in (num(r.get("ForwardPE")) for r in joined) if isinstance(f, float) and f > 0)
    med = fpe[len(fpe) // 2] if fpe else None
    return {r.get("Ticker", ""): mod._build_explain(r, ranks, med) for r in joined}


def load_checkpoints(d: Path, today: date | None = None, max_age_days: int = 3, log_dir: Path | None = None) -> dict:
    """Same return shape as smartoptions.equities.sam.load() plus source/status/provenance/regime.
    Raises FileNotFoundError / ValueError when OptionsScreener.csv is unusable (caller falls back)."""
    sp = d / "OptionsScreener.csv"
    if not sp.exists():
        raise FileNotFoundError(f"{sp} not found")
    cols, srows = read_csv(sp)
    if "Ticker" not in cols:
        raise ValueError(f"OptionsScreener.csv has no Ticker column (columns: {cols[:8]})")
    prov = {"OptionsScreener.csv": file_prov(sp, len(srows))}
    side: dict[str, tuple[list[str], dict]] = {}
    for name in ("Technicals.csv", "CompanyQuality.csv", "RiskTrend.csv"):
        p = d / name
        if p.exists():
            c, rows = read_csv(p)
            side[name] = (c, {r.get("Ticker", ""): r for r in rows})
            prov[name] = file_prov(p, len(rows))
    # Pre-M16 screener: take the risk/quality columns from RiskTrend.csv (same writer column names).
    rt_cols, rt_map = side.get("RiskTrend.csv", ([], {}))
    fill_from_rt = [c for c in RISKTREND_COLS if c not in cols and c in rt_cols]
    # Join like his export main(): screener row + Technicals (RS_1M, RSI14) + CompanyQuality fundamentals.
    joined = []
    for r in srows:
        j = dict(r)
        t = r.get("Ticker", "")
        for c in fill_from_rt:
            j[c] = rt_map.get(t, {}).get(c, "")
        for name in ("Technicals.csv", "CompanyQuality.csv"):
            c, m = side.get(name, ([], {}))
            for _f, (fname, col) in FIELD_MAP.items():
                if fname == name and col in c:
                    j[col] = m.get(t, {}).get(col, "")
        if "Beta" in side.get("CompanyQuality.csv", ([], {}))[0]:
            j["Beta"] = side["CompanyQuality.csv"][1].get(t, {}).get("Beta", "")
        joined.append(j)
    # Schema check per mapped field: where does each column actually exist?
    have = {"OptionsScreener.csv": set(cols) | set(fill_from_rt)}
    for name, (c, _m) in side.items():
        have[name] = set(c)
    missing_fields = {f: f"{fname}:{col}" for f, (fname, col) in FIELD_MAP.items() if col not in have.get(fname, set())}
    if missing_fields:
        event(STAGE, "schema", "WARN", "schema mismatch, fields degraded to missing: " + ", ".join(f"{k}<-{v}" for k, v in missing_fields.items()), log_dir=log_dir)
    rows = []
    for j in joined:
        row = {}
        for f, (_fname, col) in FIELD_MAP.items():
            if f in missing_fields:
                row[f] = None
            elif f in snapshot.TEXT_FIELDS:
                row[f] = text(j.get(col))
            else:
                row[f] = num(j.get(col))
        for f, vocab in (("quality", QUALITY_TIERS), ("risk", RISK_TIERS)):
            if row[f] is not None and row[f] not in vocab:
                row[f] = None  # outside his vocabulary: not displayed as if it were his tier
        row["checkpoint_extra"] = {c: num(j.get(c)) if c not in ("Note", "CompositeNote", "FetchedAt") else text(j.get(c))
                                   for c in EXTRA_COLS if c in j}
        rows.append(row)
    rows = [r for r in rows if r["ticker"]]
    mod, why = his_explain_module(d)
    explain = build_explain(mod, joined) if mod else {}
    if not mod:
        event(STAGE, "explain", "WARN", f"EXPLAIN not rebuilt ({why}); explain stays missing per ticker", log_dir=log_dir)
    reg, hist, rprov = load_regime(d, log_dir)
    prov.update(rprov)
    rd, how = run_date(srows, reg, prov["OptionsScreener.csv"]["mtime_utc"])
    status = staleness(rd[:10], max_age_days, today)
    tick = [r["ticker"] for r in rows]
    report = {"rows": len(rows), "declared_row_count": len(srows), "explain_keys": len(explain),
              "dup_tickers": sorted({x for x in tick if tick.count(x) > 1}),
              "rows_without_explain": sorted(set(tick) - set(explain)) if explain else [],
              "explain_without_row": sorted(set(explain) - set(tick)),
              "missing_fields": missing_fields}
    report["ok"] = len(rows) > 0 and not report["dup_tickers"] and not missing_fields
    event(STAGE, "OptionsScreener.csv", "OK" if report["ok"] else "WARN",
          f"rows={len(rows)} run_date={rd} ({how}) status={status} explain={'his export script' if mod else 'missing'} "
          f"missing_fields={len(missing_fields)}", len(rows), log_dir=log_dir)
    return {"rows": rows, "explain": explain, "header": None, "asof": rd, "report": report,
            "source": "checkpoints", "status": status,
            "reason": None if status == "ok" else f"his last run is {rd} ({how}); older than {max_age_days} days",
            "run_date_method": how, "provenance": prov, "retrieved_at": utc_now(),
            "explain_source": why if mod else None, "regime": reg, "regime_history": hist}


def load_or_snapshot(today: date | None = None, max_age_days: int = 3, env: dict | None = None,
                     snapshot_path: Path | None = None, log_dir: Path | None = None) -> dict:
    """Drop-in for smartoptions.equities.sam.load(): his live checkpoints when available, else the published snapshot."""
    env = os.environ if env is None else env
    raw = (env.get(ENV_DIR) or "").strip()
    reason = None
    if not raw:
        reason = f"{ENV_DIR} not set"
    else:
        d = Path(raw)
        try:
            return load_checkpoints(d, today, max_age_days, log_dir)
        except Exception as e:  # noqa: BLE001 - any checkpoint problem falls back, logged
            reason = f"checkpoints at {d} unusable: {e!r}"[:300]
            event(STAGE, "OptionsScreener.csv", "FAIL" if d.exists() else "WARN", reason, log_dir=log_dir)
    snap = snapshot.load(snapshot_path)
    snap.update({"source": "published_snapshot", "status": "stale",
                 "reason": f"{reason}; using published snapshot {snap.get('asof')} unchanged",
                 "provenance": {"index.html": {"path": str(snapshot_path or snapshot.DEFAULT_HTML)}},
                 "retrieved_at": utc_now(), "regime": None, "regime_history": []})
    event(STAGE, "fallback", "WARN" if raw else "OK", snap["reason"], snap["report"]["rows"], log_dir=log_dir)
    return snap
