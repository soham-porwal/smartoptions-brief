"""Per-ticker fundamentals from Yahoo (via yfinance): valuation, analysts, earnings date."""
from __future__ import annotations

import json
import math
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutTimeout
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import yfinance as yf

from ..contract import staleness, utc_now
from ..log import event

ET = ZoneInfo("America/New_York")
PROVIDER = "Yahoo Finance via yfinance"
PEG_PROVIDER_METHOD = "provider: Yahoo trailingPegRatio"
PEG_COMPUTED_METHOD = "computed: forwardPE / next-FY consensus EPS growth (Yahoo)"
TIMEOUT_S = 45


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def earnings_from_dates(df, now: datetime) -> dict | None:
    """Next future earnings date (and most recent past earnings date when present) from get_earnings_dates()."""
    if df is None or len(df) == 0:
        return None
    future = sorted(ts for ts in df.index if ts.to_pydatetime() > now)
    if not future:
        return None
    past = sorted((ts for ts in df.index if ts.to_pydatetime() <= now), reverse=True)
    ts = future[0].tz_convert(ET)
    hm = (ts.hour, ts.minute)
    if hm == (0, 0):
        tm = None
    elif hm < (9, 30):
        tm = "BMO"
    elif hm >= (16, 0):
        tm = "AMC"
    else:
        tm = None  # intraday / placeholder time: do not guess
    return {"date": ts.strftime("%Y-%m-%d"), "time": tm, "source": "Yahoo get_earnings_dates"}


def last_earnings_from_dates(df, now: datetime) -> str | None:
    if df is None or len(df) == 0:
        return None
    past = sorted((ts for ts in df.index if ts.to_pydatetime() <= now), reverse=True)
    return past[0].tz_convert(ET).strftime("%Y-%m-%d") if past else None


def earnings_from_calendar(cal, now: datetime) -> dict | None:
    try:
        dates = (cal or {}).get("Earnings Date") or []
    except AttributeError:
        return None
    fut = sorted(d for d in dates if d >= now.date())
    return {"date": fut[0].isoformat(), "time": None, "source": "Yahoo calendar"} if fut else None


def _fetch_one(sym: str, now: datetime) -> dict:
    t = yf.Ticker(sym)
    info = t.info or {}
    rec: dict = {"info": {k: info.get(k) for k in (
        "trailingPE", "forwardPE", "trailingPegRatio", "recommendationKey", "recommendationMean",
        "numberOfAnalystOpinions", "targetMeanPrice", "sector", "industry", "marketCap", "beta", "shortName")},
        "errors": []}
    fpe, peg = _num(info.get("forwardPE")), _num(info.get("trailingPegRatio"))
    if peg is None and fpe is not None:
        try:
            g = t.get_growth_estimates()
            rec["growth_next_fy"] = _num(g.loc["+1y", "stockTrend"]) if g is not None and "+1y" in g.index else None
        except Exception as e:  # noqa: BLE001
            rec["errors"].append(f"growth_estimates: {e!r}")
    ed = None
    try:
        _edf = t.get_earnings_dates(limit=6)
        ed = earnings_from_dates(_edf, now)
        if ed and last_earnings_from_dates(_edf, now):
            ed['last_date'] = last_earnings_from_dates(_edf, now)
    except Exception as e:  # noqa: BLE001
        rec["errors"].append(f"earnings_dates: {e!r}")
    if ed is None:
        try:
            ed = earnings_from_calendar(t.calendar, now)
        except Exception as e:  # noqa: BLE001
            rec["errors"].append(f"calendar: {e!r}")
    rec["earnings"] = ed
    return rec


def fetch(symbols: list[str], raw_dir: Path, refresh: bool = False, workers: int = 8) -> dict[str, dict]:
    """Return {symbol: raw record}; cached in raw_dir/fundamentals.json. Failures keep a 'fatal' key."""
    cache = raw_dir / "fundamentals.json"
    have: dict = {}
    if cache.exists() and not refresh:
        have = json.loads(cache.read_text(encoding="utf-8"))
    # Legacy caches did not retain acquisition time. Re-fetch rather than stamp
    # an old provider snapshot with today's build time.
    todo = [s for s in symbols if s not in have or have[s].get("fatal")
            or not have[s].get("retrieved_at")]
    now = datetime.now(ET)

    def job(s):
        last = None
        for _attempt in range(2):  # one retry
            try:
                rec = _fetch_one(s, now)
                rec["retrieved_at"] = utc_now()
                return s, rec, None
            except Exception as e:  # noqa: BLE001
                last = repr(e)
        return s, None, last

    ok = fail = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {s: ex.submit(job, s) for s in todo}
        for s, f in futs.items():
            try:
                _, rec, err = f.result(timeout=TIMEOUT_S * 3)
            except FutTimeout:
                rec, err = None, "timeout"
            if rec is None:
                have[s] = {"fatal": err, "info": {}, "errors": [err], "earnings": None}
                event("equities.fundamentals", s, "FAIL", f"fetch failed after retry: {err}")
                fail += 1
            else:
                have[s] = rec
                ok += 1
                if rec["errors"]:
                    event("equities.fundamentals", s, "WARN", "; ".join(rec["errors"])[:400])
    event("equities.fundamentals", "yahoo", "OK" if ok else ("OK" if not todo else "FAIL"),
          f"{ok} fetched, {fail} failed, {len(symbols) - len(todo)} cached", ok if todo else len(symbols))
    raw_dir.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(have, default=str), encoding="utf-8")
    return {s: have[s] for s in symbols if s in have}


def shape(sym: str, rec: dict, price: float | None, today: datetime) -> tuple[dict, dict, dict]:
    """Return (fields, status, provenance) for one ticker from its raw record."""
    info = rec.get("info", {})
    fatal = rec.get("fatal")
    retrieved = rec.get("retrieved_at")
    fields, status, prov = {}, {}, {}

    def st(name, val, reason=None):
        status[name] = "error" if (val is None and fatal) else ("ok" if val is not None else "missing")
        prov[name] = {"provider": PROVIDER, "retrieved_at": retrieved,
                      **({"reason": fatal or reason} if val is None and (fatal or reason) else {})}

    fields["pe_trailing"] = _num(info.get("trailingPE"))
    st("pe_trailing", fields["pe_trailing"], "Yahoo returned no trailing P/E (e.g. negative earnings)")
    fields["pe_forward"] = _num(info.get("forwardPE"))
    st("pe_forward", fields["pe_forward"], "Yahoo returned no forward P/E")
    fpe, peg = fields["pe_forward"], _num(info.get("trailingPegRatio"))
    if peg is not None and peg <= 0:
        peg = None  # negative PEG (losses or shrinking EPS) has no valuation meaning; fall through to computed/missing
    if fpe is not None and fpe <= 0:
        fpe = None  # forward losses: computed PEG would be negative and meaningless
    if peg is not None:
        fields["peg"] = {"value": peg, "method": "provider", "method_text": PEG_PROVIDER_METHOD,
                         "inputs": {"trailingPegRatio": peg}}
        status["peg"] = "ok"
        prov["peg"] = {"provider": PROVIDER, "retrieved_at": retrieved}
    else:
        g = rec.get("growth_next_fy")
        if fpe is not None and g is not None and g > 0:
            fields["peg"] = {"value": fpe / (g * 100), "method": "computed", "method_text": PEG_COMPUTED_METHOD,
                             "inputs": {"forwardPE": fpe, "next_fy_eps_growth_pct": g * 100}}
            status["peg"] = "ok"
            prov["peg"] = {"provider": PROVIDER, "retrieved_at": retrieved}
        else:
            reason = ("no provider PEG and forward P/E missing" if fpe is None else
                      "no provider PEG; next-FY consensus EPS growth missing" if g is None else
                      "no provider PEG; next-FY consensus EPS growth <= 0, PEG undefined")
            fields["peg"] = {"value": None, "method": None, "method_text": None, "inputs": {}, "reason": reason}
            status["peg"] = "error" if fatal else "missing"
            prov["peg"] = {"provider": PROVIDER, "retrieved_at": retrieved, "reason": fatal or reason}
    tm = _num(info.get("targetMeanPrice"))
    rating = info.get("recommendationKey")
    fields["analyst"] = {"rating": None if rating in (None, "none") else rating,
                         "mean": _num(info.get("recommendationMean")), "n": _num(info.get("numberOfAnalystOpinions")),
                         "target_mean": tm, "upside_pct": (tm / price - 1) * 100 if tm and price else None}
    st("analyst", fields["analyst"]["rating"] or fields["analyst"]["mean"], "no analyst coverage returned by Yahoo")
    fields["sector"], fields["industry"] = info.get("sector"), info.get("industry")
    fields["market_cap"] = _num(info.get("marketCap"))
    st("market_cap", fields["market_cap"], "Yahoo returned no market cap")
    fields["beta_provider"] = _num(info.get("beta"))
    st("beta_provider", fields["beta_provider"], "Yahoo returned no beta")
    ed = rec.get("earnings")
    if ed:
        d = datetime.strptime(ed["date"], "%Y-%m-%d").date()
        fields["earnings"] = {"date": ed["date"], "time": ed["time"], "days_until": (d - today.date()).days,
                              "source": ed["source"],
                              **({"last_date": ed["last_date"]} if ed.get("last_date") else {})}
        status["earnings"] = "ok"
        prov["earnings"] = {"provider": PROVIDER, "retrieved_at": retrieved,
                            "note": "Yahoo dates can be estimates until the company confirms"}
    else:
        fields["earnings"] = {"date": None, "time": None, "days_until": None, "source": None}
        status["earnings"] = "error" if fatal else "missing"
        prov["earnings"] = {"provider": PROVIDER, "retrieved_at": retrieved,
                            "reason": fatal or "no upcoming earnings date from Yahoo"}
    definitions = {
        "pe_trailing": ("trailingPE", "multiple"),
        "pe_forward": ("forwardPE", "multiple"),
        "peg": ("trailingPegRatio or forwardPE / next-FY EPS growth percent", "ratio"),
        "analyst": ("recommendationKey, recommendationMean, numberOfAnalystOpinions, targetMeanPrice", "rating / analysts / USD per share / percent upside"),
        "market_cap": ("marketCap", "USD"),
        "beta_provider": ("beta", "dimensionless beta; provider window"),
        "earnings": ("get_earnings_dates or calendar", "calendar date / ET session / calendar days"),
    }
    for name, (series, unit) in definitions.items():
        entry = prov[name]
        entry.update(series=f"{sym}:{series}", unit=unit,
                     source_url=f"https://finance.yahoo.com/quote/{sym}/" + ("calendar/" if name == "earnings" else "analysis/"),
                     date=retrieved[:10] if retrieved else None,
                     period=retrieved or "provider snapshot; acquisition time unavailable",
                     method="Provider snapshot at acquisition time; not historical fundamentals at the price session")
        if status[name] == "ok":
            status[name] = staleness(retrieved[:10], 7, today=today.date()) if retrieved else "stale"
        if not retrieved:
            entry["reason"] = entry.get("reason") or "Acquisition timestamp unavailable; refresh source cache"
    return fields, status, prov
