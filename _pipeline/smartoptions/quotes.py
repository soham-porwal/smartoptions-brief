"""Bounded, delayed Yahoo snapshot. No trading signals or real-time claims.

Method: unadjusted last 5-minute Close / prior completed daily Close - 1.
Daily bars validate the denominator's session; equities.json is reused only when
its price_date matches that session. No first-intraday-bar approximation.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
import logging
import math
import multiprocessing as mp
from pathlib import Path
import queue
import time
from urllib.parse import quote
from zoneinfo import ZoneInfo

from .contract import Observation, staleness, write_json, utc_now
from .log import event

ROOT = Path(__file__).resolve().parents[1]
ET = ZoneInfo("America/New_York")
TAPE = ("SPY", "RSP", "^VIX", "^VIX3M", "DX-Y.NYB", "CL=F", "BZ=F", "HG=F", "^TNX")
SOURCE = "Yahoo Finance via yfinance, ~15 min delayed"
METHOD = "100 * (last unadjusted 5m Close / previous completed session unadjusted daily Close - 1); no first-bar proxy"
TNX_LABEL = "CBOE 10Y yield index /10, delayed - intraday proxy; official daily = Treasury"


def number(value):
    try:
        result = float(value)
        return result if math.isfinite(result) and result > 0 else None
    except (TypeError, ValueError):
        return None


def session_state(now: datetime, has_bars_today: bool = True) -> str:
    """US equity clock, not a futures session/holiday calendar. Bar absence closes holidays."""
    if now.tzinfo is None:
        raise ValueError("timezone-aware datetime required")
    local = now.astimezone(ET)
    minute = local.hour * 60 + local.minute
    if local.weekday() >= 5 or not has_bars_today:
        return "closed"
    if 240 <= minute < 570:
        return "pre"
    if 570 <= minute < 960:
        return "regular"
    if 960 <= minute < 1200:
        return "post"
    return "closed"


def load_equities(root: Path = ROOT) -> tuple[dict, str | None]:
    try:
        latest = (root / "out/latest.txt").read_text(encoding="utf-8-sig").strip()
        # latest.txt is a date pointer, never executable text or an arbitrary path.
        datetime.strptime(latest, "%Y-%m-%d")
        path = root / "out" / latest / "equities.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data.get("tickers"), dict):
            raise ValueError("equities tickers must be a mapping")
        event("quotes", "equities", "OK" if data["tickers"] else "SUSPECT",
              f"loaded {path}; {len(data['tickers'])} tickers", len(data["tickers"]))
        return data, None
    except Exception as exc:
        reason = f"equity universe unavailable: {type(exc).__name__}: {exc}"
        event("quotes", "equities", "WARN", reason)
        return {"tickers": {}}, reason


def _download_worker(symbols, messages):
    """Isolated process: provider hangs cannot outlive the parent's 78-second budget."""
    provider_log = logging.getLogger("yfinance")
    provider_errors = []

    class CaptureErrors(logging.Handler):
        def emit(self, record):
            if record.levelno >= logging.WARNING:
                provider_errors.append(record.getMessage())

    capture = CaptureErrors()
    provider_log.addHandler(capture)
    try:
        import pandas as pd
        import yfinance as yf
        from yfinance import shared

        for start in range(0, len(symbols), 100):
            chunk = symbols[start:start + 100]
            for kind, period, interval in (("intraday", "2d", "5m"), ("daily", "5d", "1d")):
                pending = chunk[:]
                for attempt in range(2):
                    found = {}
                    error = ""
                    provider_errors.clear()
                    try:
                        frame = yf.download(pending, period=period, interval=interval,
                                            group_by="ticker", threads=True, auto_adjust=False,
                                            prepost=(kind == "intraday"), progress=False, timeout=8)
                        errors = dict(getattr(shared, "_ERRORS", {}))
                        # 1.7 stores download errors in a private per-call context, older
                        # releases use shared._ERRORS. Capture its public logger for both.
                        error = "; ".join([*(f"{s}: {v}" for s, v in errors.items()), *provider_errors])
                        if frame is not None and not frame.empty:
                            for symbol in pending:
                                try:
                                    data = frame[symbol] if isinstance(frame.columns, pd.MultiIndex) else frame
                                    close = data["Close"].dropna().sort_index()
                                    bars = []
                                    for stamp, value in close.items():
                                        value = number(value)
                                        if value is None:
                                            continue
                                        if kind == "intraday":
                                            # Yahoo intraday timestamps must be aware: never guess a zone.
                                            if stamp.tzinfo is None:
                                                continue
                                            label = stamp.to_pydatetime().astimezone(ET).isoformat()
                                        else:
                                            label = stamp.strftime("%Y-%m-%d")
                                        bars.append([label, value])
                                    if bars:
                                        found[symbol] = bars
                                except (KeyError, TypeError, ValueError) as exc:
                                    event("quotes.fetch", symbol, "WARN", f"{kind}: {exc}")
                    except Exception as exc:
                        error = f"{type(exc).__name__}: {exc}"
                    messages.put((kind, found))
                    missing = [s for s in pending if s not in found]
                    event("quotes.fetch", f"Yahoo/{kind}/chunk{start}",
                          "OK" if not missing else ("WARN" if found else "SUSPECT"),
                          f"attempt={attempt + 1}; {len(found)}/{len(pending)}; {error}", len(found))
                    if not missing:
                        break
                    if attempt == 0:
                        # yfinance often catches HTTP 429 internally; inspect its error map too.
                        time.sleep(2 if any(x in error.lower() for x in ("429", "rate", "too many")) else 0.5)
                    pending = missing
    except Exception as exc:
        event("quotes.fetch", "worker", "FAIL", f"{type(exc).__name__}: {exc}")
    finally:
        provider_log.removeHandler(capture)
        messages.put(("done", {}))


def fetch_bars(symbols, budget: float = 78) -> dict:
    context = mp.get_context("spawn")
    messages = context.Queue()
    worker = context.Process(target=_download_worker, args=(symbols, messages), daemon=True)
    result = {"intraday": {}, "daily": {}}
    deadline = time.monotonic() + budget
    completed = False
    worker.start()
    try:
        while time.monotonic() < deadline:
            try:
                kind, data = messages.get(timeout=min(0.25, max(0.01, deadline - time.monotonic())))
                if kind == "done":
                    completed = True
                    break
                result[kind].update(data)
            except queue.Empty:
                if not worker.is_alive():
                    break
        if completed:
            worker.join(timeout=2)
        elif worker.is_alive():
            event("quotes.fetch", "budget", "WARN", "78s deadline reached; retaining completed chunks")
            worker.terminate()
        worker.join(timeout=2)
    finally:
        if worker.is_alive():
            worker.terminate()
            worker.join(timeout=1)
        messages.close()
    return result


def make_quote(symbol: str, bars: list, daily: list, equity: dict, now: datetime) -> dict:
    base = {"price": None, "chg_pct": None, "ts": None, "status": "missing",
            "change": None, "change_pct": None, "volume": None, "delay_minutes": 15,
            "asof_utc": None, "market_state": "closed", "freshness": "missing",
            "source_url": "https://finance.yahoo.com/quote/" + quote(symbol, safe=""),
            "provider": SOURCE, "series": symbol, "retrieved_at": utc_now(),
            "unit": ("% yield (Yahoo-scaled)" if symbol == "^TNX" else
                     "index points" if symbol.startswith("^") or symbol == "DX-Y.NYB" else
                     "USD/barrel" if symbol in ("CL=F", "BZ=F") else
                     "USD/lb" if symbol == "HG=F" else "USD/share"),
            "method": METHOD, "prior_close": None, "prior_close_date": None,
            "label": TNX_LABEL if symbol == "^TNX" else symbol}
    valid = []
    for stamp, value in bars:
        try:
            ts = datetime.fromisoformat(stamp)
            if ts.tzinfo is not None and ts <= now and number(value) is not None:
                valid.append((ts.astimezone(ET), float(value)))
        except (ValueError, TypeError):
            continue
    if not valid:
        return {**base, "reason": "No valid timestamped 5-minute bars returned within refresh budget"}
    ts, price = max(valid, key=lambda pair: pair[0])
    # Compare against the daily session preceding the BAR's date, even on weekends.
    prior_bars = [(d, number(v)) for d, v in daily if d < ts.date().isoformat() and number(v) is not None]
    prior, prior_date, prior_source = None, None, None
    if prior_bars:
        prior_date, prior = max(prior_bars)
        prior_source = "Yahoo unadjusted daily Close"
        if equity.get("price_date") == prior_date and number(equity.get("price")) is not None:
            prior = number(equity["price"])
            prior_source = "equities.json unadjusted daily Close, date validated against daily bars"
    else:
        # A prior-weekday equity close is safe only when the new bar is from today.
        expected = ts.date() - timedelta(days=1)
        while expected.weekday() >= 5:
            expected -= timedelta(days=1)
        if ts.date() == now.astimezone(ET).date() and equity.get("price_date") == expected.isoformat():
            prior, prior_date = number(equity.get("price")), equity["price_date"]
            prior_source = "equities.json preceding weekday completed daily Close (daily download unavailable)"
    fresh = staleness(ts.date().isoformat(), 0, now.astimezone(ET).date())
    # The 30-minute grace is an explicit refresh freshness rule, not a market threshold.
    if now - ts > timedelta(minutes=30):
        fresh = "stale"
    obs = Observation(id=symbol, label=base["label"], provider=SOURCE, series=symbol,
                      source_url=base["source_url"], unit=base["unit"], value=price,
                      period=ts.isoformat(), date=ts.date().isoformat(), status=fresh)
    base.update(price=obs.value, ts=ts.isoformat(), status=obs.status, period=obs.period,
                prior_close=prior, prior_close_date=prior_date, prior_close_source=prior_source,
                chg_pct=100 * (price / prior - 1) if prior else None,
                change_status="ok" if prior else "missing")
    if prior is None:
        base["reason"] = "Previous completed official daily Close unavailable; change is missing"
    if fresh == "stale":
        base["freshness_reason"] = "Last bar is from a previous date or more than 30 minutes old"
    if symbol == "^TNX":
        base["note"] = "Yahoo already scales ^TNX to percent yield; no additional /10 applied. Delayed intraday proxy, not official Treasury daily rate."
    base.update(change=price - prior if prior else None, change_pct=base["chg_pct"],
                asof_utc=ts.astimezone(timezone.utc).isoformat(), market_state=session_state(now, ts.date() == now.astimezone(ET).date()),
                freshness="stale" if fresh == "stale" else "delayed")
    return base


def snapshot(now: datetime | None = None, root: Path = ROOT, fetcher=fetch_bars) -> dict:
    now = now or datetime.now(timezone.utc)
    equities, reason = load_equities(root)
    symbols = sorted(set(equities["tickers"]) | set(TAPE))
    try:
        data = fetcher(symbols)
    except Exception as exc:
        event("quotes.fetch", "Yahoo", "FAIL", f"{type(exc).__name__}: {exc}")
        data = {"intraday": {}, "daily": {}}
    quotes = {}
    for symbol in symbols:
        record = make_quote(symbol, data["intraday"].get(symbol, []), data["daily"].get(symbol, []),
                            equities["tickers"].get(symbol, {}), now)
        quotes[symbol] = record
        event("quotes", symbol, "OK" if record["status"] == "ok" and record.get("chg_pct") is not None else "WARN",
              f"{record['status']}; {record.get('reason', record.get('freshness_reason', 'bar received'))}",
              int(record["price"] is not None))
    count = sum(q["price"] is not None for q in quotes.values())
    event("quotes", "snapshot", "OK" if count == len(symbols) else "WARN" if count else "SUSPECT",
          f"{count}/{len(symbols)} prices", count)
    # SPY is the holiday/data-absence sentinel; futures bars alone cannot open a US equity holiday.
    spy_ts = quotes.get("SPY", {}).get("ts")
    today_bars = bool(spy_ts and datetime.fromisoformat(spy_ts).date() == now.astimezone(ET).date())
    result = {"generated_at": utc_now(), "session": session_state(now, today_bars),
              "source": SOURCE, "quotes": quotes,
              "method": METHOD, "session_method": "US/Eastern weekday clock; no SPY bars today => closed (holiday or unavailable); not a futures-session clock"}
    if reason:
        result["universe_warning"] = reason
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT / "app/data/quotes.json")
    parser.add_argument("--check-key", action="store_true")
    args = parser.parse_args()
    started = time.monotonic()
    try:
        from .quotes_providers import main as provider_main
        if args.check_key:
            return provider_main(["--check-key"])
        rc = provider_main(["--core", str(ROOT / "app/data/core.json"), "--out", str(args.out),
                            "--status", str(ROOT / "logs/quotes-status.json")])
        event("quotes", "provider-chain", "OK" if rc == 0 else "FAIL",
              f"rc={rc}; elapsed={time.monotonic()-started:.1f}s; status=logs/quotes-status.json")
        return rc
    except Exception as exc:
        event("quotes", "write", "FAIL", f"{type(exc).__name__}: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
