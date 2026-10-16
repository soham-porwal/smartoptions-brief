"""Portable quotes job. Dependencies: yfinance, requests (+ tzdata on Windows).

Pages layout: data/core.json -> data/quotes.json. No SmartOptions imports.
Failures never replace a usable previous quote with a missing value.
"""
from __future__ import annotations

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
import json
import math
import multiprocessing as mp
import os
from pathlib import Path
import queue
import re
import sys
import threading
import time
from urllib.parse import quote
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
TAPE = ("SPY", "RSP", "^VIX", "^VIX3M", "DX-Y.NYB", "CL=F", "BZ=F", "HG=F", "^TNX")
FINNHUB_SPACING = 1.22  # <=50 starts per rolling minute; four bounded workers.
DEFAULT_SECRETS = Path(r"D:\soham\myeverything\Secrets")


def utc(value=None):
    return (value or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def finite(value, positive=False):
    try:
        n = float(value)
        return n if math.isfinite(n) and (not positive or n > 0) else None
    except (ValueError, TypeError):
        return None


def stamp(value):
    try:
        d = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return d.astimezone(timezone.utc) if d.tzinfo else None
    except (ValueError, TypeError):
        return None


def market_state(now, observed=None):
    """Weekday ET clock; prior-date observations close holidays/data absences.

    This is not an exchange holiday/early-close calendar. Label explicitly below.
    """
    local = now.astimezone(ET)
    m = local.hour * 60 + local.minute
    if local.weekday() >= 5 or (observed and observed.astimezone(ET).date() < local.date()):
        return "closed"
    return "pre" if 240 <= m < 570 else "regular" if 570 <= m < 960 else "post" if 960 <= m < 1200 else "closed"


def secret(name, directory=DEFAULT_SECRETS):
    """Read only named files or the named service section; never log values."""
    value = os.environ.get(name, "").strip()
    if value:
        return value
    path = directory / (name.lower() + ".txt")
    if path.is_file():
        return path.read_text(encoding="utf-8-sig").strip()
    # Existing secrets convention is Markdown sections, not arbitrary token scans.
    path = directory / "api-keys.md"
    if path.is_file() and name == "FINNHUB_API_KEY":
        text = path.read_text(encoding="utf-8-sig")
        match = re.search(r"(?im)^#{1,6}\s+[^\n]*finnhub[^\n]*\n(?P<body>.*?)(?=^#{1,6}\s|\Z)", text, re.S)
        if match:
            found = re.findall(r"(?im)^\s*(?:[-*]\s*)?(?:`?FINNHUB_API_KEY`?|api[_ ]?key|key)\s*[:=]\s*`?([A-Za-z0-9_-]{10,})`?\s*$", match["body"])
            if len(set(found)) == 1:
                return found[0]
    return ""


def universe(core):
    rows = core.get("rows")
    if not isinstance(rows, list) or not rows:
        raise ValueError("core.json rows must be a nonempty list")
    return {r["t"]: r for r in rows if isinstance(r, dict) and isinstance(r.get("t"), str)
            and re.fullmatch(r"[A-Z0-9.^=/-]{1,20}", r["t"])}


def priority_plan(rows, previous, shortlist=(), watchlist=(), now=None):
    """100 largest + watchlist/shortlist every cycle; remaining Finnhub hourly.

    At most 190 names per cycle (~231 s dispatch + HTTP deadline), leaving room
    for bounded Yahoo fallback. Larger watchlists rotate explicitly, never hidden.
    """
    now = now or datetime.now(timezone.utc)
    top = sorted(rows, key=lambda t: finite(rows[t].get("mcap")) or 0, reverse=True)[:100]
    first = list(dict.fromkeys([*watchlist, *shortlist, *top, "SPY", "RSP"]))
    first = [t for t in first if (t in rows or t in {"SPY", "RSP"}) and re.fullmatch(r"[A-Z][A-Z0-9.-]{0,14}", t)]
    remaining = []
    for t in rows:
        if t in first or not re.fullmatch(r"[A-Z][A-Z0-9.-]{0,14}", t):
            continue
        last = stamp(previous.get(t, {}).get("realtime_checked_at"))
        if not last or now - last >= timedelta(hours=1):
            remaining.append(t)
    # Oldest first; over several five-minute cycles the hourly remainder rotates.
    remaining.sort(key=lambda t: previous.get(t, {}).get("realtime_checked_at") or "")
    return (first + remaining)[:190], max(0, len(first) - 190)


def record(symbol, price, prior, observed, now, provider, delay, source_url, *, volume=None, volume_period=None, prior_date=None):
    if finite(price, True) is None or observed is None or observed > now + timedelta(seconds=60):
        raise ValueError("Invalid provider price/timestamp")
    prior = finite(prior, True)
    state = market_state(now, observed)
    age = max(0, (now - observed).total_seconds() / 60)
    # Provider entitlement is not freshness. Never call a 5-minute-old quote live.
    freshness = "closed" if state == "closed" else "stale" if age > max(30, delay + 15) else "live" if delay == 0 and age <= 1 else "delayed" if delay else "stale"
    price = float(price)
    change = price - prior if prior is not None else None
    pct = 100 * change / prior if prior is not None else None
    unit = "index points" if symbol.startswith("^") or symbol == "DX-Y.NYB" else "USD/barrel" if symbol in ("CL=F", "BZ=F") else "USD/lb" if symbol == "HG=F" else "USD/share"
    if symbol == "^TNX":
        unit = "% yield (Yahoo-scaled)"
    result = {"price": price, "chg_pct": pct, "change": change, "change_pct": pct,
              "volume": finite(volume), "volume_unit": "shares" if unit == "USD/share" else "provider contracts",
              "volume_period": volume_period, "volume_reason": None if volume is not None else "Provider did not return volume",
              "provider": provider, "delay_minutes": delay, "asof_utc": utc(observed), "ts": observed.astimezone(ET).isoformat(),
              "market_state": state, "freshness": freshness, "status": "stale" if freshness == "stale" else "ok",
              "source_url": source_url, "series": symbol, "unit": unit, "period": observed.astimezone(ET).isoformat(), "retrieved_at": utc(now),
              "prior_close": prior, "prior_close_date": prior_date,
              "change_status": "ok" if prior else "missing",
              "method": "100 * (last trade or unadjusted bar Close / provider previous daily Close - 1)"}
    if prior is None:
        result["reason"] = "Previous completed daily close not available; change not available"
    return result


def finnhub_one(symbol, key, now, get=None):
    import requests
    get = get or requests.get
    # Header authentication keeps the secret out of exception URLs.
    response = get("https://finnhub.io/api/v1/quote", params={"symbol": symbol.replace("-", ".")},
                   headers={"X-Finnhub-Token": key}, timeout=(4, 8), allow_redirects=False)
    if response.status_code != 200:
        return None, f"HTTP {response.status_code}"
    data = response.json()
    try:
        observed = datetime.fromtimestamp(float(data["t"]), timezone.utc)
        if float(data["t"]) <= 0:
            raise ValueError()
        q = record(symbol, finite(data.get("c"), True), data.get("pc"), observed, now,
                   "Finnhub US quote", 0, "https://finnhub.io/docs/api/quote")
        q["prior_close_date"] = None
        q["prior_close_note"] = "Finnhub pc; endpoint does not return previous-close session date"
        return q, None
    except (KeyError, ValueError, TypeError, OverflowError):
        return None, "No valid price/timestamp"


def finnhub_batch(symbols, key, now, get=None, spacing=FINNHUB_SPACING):
    found, errors, checked = {}, {}, []
    lock, stop = threading.Lock(), threading.Event()
    started = time.monotonic()
    next_start = started
    def job(t):
        nonlocal next_start
        with lock:
            if stop.is_set():
                return None, "Provider rate/authentication limit; remaining calls skipped", False
            time.sleep(max(0, next_start - time.monotonic()))
            next_start = time.monotonic() + spacing
        observed_now = now + timedelta(seconds=time.monotonic() - started)
        try:
            quote, error = finnhub_one(t, key, observed_now, get)
            if error in {"HTTP 429", "HTTP 401", "HTTP 403"}:
                stop.set()
            return quote, error, True
        except Exception:
            return None, "Request failed (details withheld to protect credentials)", True
    with ThreadPoolExecutor(max_workers=4) as pool:
        pending = {pool.submit(job, t): t for t in symbols}
        for future in as_completed(pending):
            t = pending[future]
            q, error, attempted = future.result()
            if attempted:
                checked.append(t)
            if q is not None:
                found[t] = q
            if error:
                errors[t] = error
    return found, errors, checked


def alpaca_batch(symbols, key, secret_key, now, get=None):
    """Explicit IEX snapshots: a single venue, never consolidated US volume."""
    import requests
    get = get or requests.get
    found, errors = {}, {}
    for start in range(0, len(symbols), 100):
        chunk = symbols[start:start + 100]
        try:
            r = get("https://data.alpaca.markets/v2/stocks/snapshots", params={"symbols": ",".join(t.replace("-", ".") for t in chunk), "feed": "iex"},
                    headers={"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret_key}, timeout=(4, 8), allow_redirects=False)
            if r.status_code != 200:
                raise ValueError(f"HTTP {r.status_code}")
            data = r.json()
            for t in chunk:
                item = data.get(t.replace("-", "."), {})
                trade, daily, prior = item.get("latestTrade") or {}, item.get("dailyBar") or {}, item.get("prevDailyBar") or {}
                observed = stamp(trade.get("t"))
                try:
                    q = record(t, finite(trade.get("p"), True), prior.get("c"), observed, now,
                               "Alpaca IEX (single exchange)", 0, "https://docs.alpaca.markets/us/reference/stocksnapshots-1",
                               volume=daily.get("v"), volume_period=daily.get("t"), prior_date=(prior.get("t") or "")[:10] or None)
                    q["volume_note"] = "IEX venue only; not total US market volume"
                    found[t] = q
                except (ValueError, TypeError):
                    errors[t] = "No valid IEX trade"
        except Exception:
            errors.update({t: "Alpaca request failed; falling back" for t in chunk})
    return found, errors


def _yahoo_worker(symbols, messages):
    import logging
    logging.getLogger("yfinance").setLevel(logging.CRITICAL)
    try:
        import yfinance as yf
        for start in range(0, len(symbols), 100):
            chunk = symbols[start:start + 100]
            for kind, period, interval in (("intraday", "2d", "5m"), ("daily", "5d", "1d")):
                frame = yf.download(chunk, period=period, interval=interval, group_by="ticker", threads=8,
                                    auto_adjust=False, prepost=(kind == "intraday"), progress=False, timeout=8)
                found = {}
                for t in chunk:
                    try:
                        data = frame[t] if getattr(frame.columns, "nlevels", 1) > 1 else frame
                        bars = []
                        for index, row in data.dropna(subset=["Close"]).iterrows():
                            if kind == "intraday" and index.tzinfo is None:
                                continue
                            label = index.isoformat() if kind == "intraday" else index.strftime("%Y-%m-%d")
                            bars.append([label, finite(row["Close"], True), finite(row.get("Volume"))])
                        if bars:
                            found[t] = bars
                    except (KeyError, TypeError, ValueError):
                        continue  # Missing symbols are counted and reported by the parent.
                messages.put((kind, found))
    except Exception:
        messages.put(("error", "Yahoo download failed"))
    finally:
        messages.put(("done", {}))


def yahoo_bars(symbols, budget=110):
    ctx = mp.get_context("spawn")
    messages = ctx.Queue()
    worker = ctx.Process(target=_yahoo_worker, args=(symbols, messages), daemon=True)
    result = {"intraday": {}, "daily": {}}
    deadline = time.monotonic() + budget
    worker.start()
    try:
        while time.monotonic() < deadline:
            try:
                kind, data = messages.get(timeout=0.2)
                if kind == "done":
                    break
                if kind in result:
                    result[kind].update(data)
            except queue.Empty:
                if not worker.is_alive():
                    break
    finally:
        worker.join(timeout=0.5)
        if worker.is_alive():
            worker.terminate()
            worker.join(timeout=2)
        messages.close()
    return result


def yahoo_quotes(symbols, now, fetcher=yahoo_bars):
    started = time.monotonic()
    data = fetcher(symbols)
    now = now + timedelta(seconds=time.monotonic() - started)
    found = {}
    for t in symbols:
        bars = [(stamp(b[0]), b[1], b[2] if len(b) > 2 else None) for b in data["intraday"].get(t, [])]
        bars = [b for b in bars if b[0] and b[0] <= now and finite(b[1], True) is not None]
        if not bars:
            continue
        observed, price, volume = max(bars, key=lambda b: b[0])
        date = observed.astimezone(ET).date().isoformat()
        prior = sorted(b for b in data["daily"].get(t, []) if b[0] < date and finite(b[1], True) is not None)
        prev_date, prev = prior[-1][:2] if prior else (None, None)
        found[t] = record(t, price, prev, observed, now, "Yahoo Finance via yfinance, ~15 min delayed", 15,
                          "https://finance.yahoo.com/quote/" + quote(t, safe=""),
                          volume=volume, volume_period="Last 5-minute bar: " + utc(observed), prior_date=prev_date)
    return found


def refresh(core, previous=None, *, shortlist=(), watchlist=(), now=None, keys=None, yahoo=yahoo_quotes, finnhub=finnhub_batch, alpaca=alpaca_batch):
    started = time.monotonic()
    now = now or datetime.now(timezone.utc)
    rows = universe(core)
    if not rows:
        raise ValueError("No valid tickers in core.json")
    symbols = sorted(set(rows) | set(TAPE))
    old = (previous or {}).get("quotes", {})
    keys = keys if keys is not None else {n: secret(n) for n in ("FINNHUB_API_KEY", "APCA_API_KEY_ID", "APCA_API_SECRET_KEY")}
    quotes, errors, checked = {}, {}, []
    plan, overflow = priority_plan(rows, old, shortlist, watchlist, now)
    if keys.get("FINNHUB_API_KEY"):
        quotes, errors, checked = finnhub(plan, keys["FINNHUB_API_KEY"], now)
    needed = [t for t in symbols if t not in quotes]
    # Keep recent Finnhub quotes for the hourly remainder; their original timestamp
    # remains visible, and they are never promoted to fresh by this job.
    for t in needed[:]:
        prev = old.get(t, {})
        seen = stamp(prev.get("asof_utc") or prev.get("ts"))
        last_check = stamp(prev.get("realtime_checked_at"))
        if t not in plan and keys.get("FINNHUB_API_KEY") and last_check and now - last_check < timedelta(hours=1) and seen and finite(prev.get("price"), True) is not None:
            quotes[t] = {**prev, "retained": True, "status": "stale", "freshness": "closed" if market_state(now, seen) == "closed" else "stale", "market_state": market_state(now, seen), "reason": "Hourly remainder; original provider timestamp retained"}
            needed.remove(t)
    if needed and keys.get("APCA_API_KEY_ID") and keys.get("APCA_API_SECRET_KEY"):
        eligible = [t for t in needed if re.fullmatch(r"[A-Z][A-Z0-9.-]{0,14}", t)]
        more, issues = alpaca(eligible, keys["APCA_API_KEY_ID"], keys["APCA_API_SECRET_KEY"], now)
        quotes.update(more)
        errors.update({t: errors.get(t, "") + "; " + v for t, v in issues.items()})
    needed = [t for t in symbols if t not in quotes]
    if needed:
        try:
            quotes.update(yahoo(needed, now + timedelta(seconds=time.monotonic() - started)))
        except Exception:
            errors["Yahoo"] = "Request failed; previous values retained where available"
    finished_at = now + timedelta(seconds=time.monotonic() - started)
    for t in symbols:
        if t not in quotes:
            prev = old.get(t, {})
            if finite(prev.get("price"), True) is not None:
                quotes[t] = {**prev, "status": "stale", "freshness": "stale", "retained": True,
                             "market_state": market_state(now, stamp(prev.get("asof_utc") or prev.get("ts"))),
                             "reason": "Refresh failed; previous value and original timestamp retained"}
            else:
                quotes[t] = {"price": None, "chg_pct": None, "change": None, "change_pct": None, "volume": None,
                             "provider": None, "delay_minutes": None, "asof_utc": None, "ts": None,
                             "status": "missing", "freshness": "missing", "market_state": "closed", "series": t,
                             "reason": "No provider returned a valid timestamped price"}
        if t in checked:
            quotes[t]["realtime_checked_at"] = utc(now)
        elif old.get(t, {}).get("realtime_checked_at"):
            quotes[t]["realtime_checked_at"] = old[t]["realtime_checked_at"]
        # A retained value can originate in the older app schema. Add explicit
        # provenance fields without guessing provider delay or observation time.
        current = quotes[t]
        observed = stamp(current.get("asof_utc") or current.get("ts"))
        current.setdefault("asof_utc", utc(observed) if observed else None)
        current.setdefault("delay_minutes", 15 if "yahoo" in str(current.get("provider", "")).lower() else None)
        current.setdefault("change", None)
        current.setdefault("change_pct", current.get("chg_pct"))
        current.setdefault("volume", None)
        if current.get("price") is not None and observed:
            state = market_state(finished_at, observed)
            age = max(0, (finished_at - observed).total_seconds() / 60)
            delay = current.get("delay_minutes")
            label = "closed" if state == "closed" else "stale" if current.get("retained") or delay is None else "live" if delay == 0 and age <= 1 else "delayed" if delay > 0 and age <= delay + 15 else "stale"
            current.update(market_state=state, freshness=label)
            if label == "stale":
                current["status"] = "stale"
        if t in errors:
            quotes[t]["provider_warning"] = errors[t]
    served = Counter(q.get("provider") or "missing" for q in quotes.values())
    fresh_count = sum(q.get("price") is not None and not q.get("retained") for q in quotes.values())
    success = sum(q.get("price") is not None for q in quotes.values())
    return {"generated_at": utc(finished_at), "session": market_state(finished_at, stamp(quotes.get("SPY", {}).get("ts"))),
            "source": "Per-quote provider chain: Finnhub, Alpaca IEX, delayed Yahoo",
            "quotes": quotes, "session_method": "ET weekday clock; prior-date prices close holidays/data absences; no early-close calendar",
            "refresh": {"status": "OK" if fresh_count == len(symbols) and not errors else "WARN" if fresh_count else "FAIL",
                        "requested": len(symbols), "available": success, "received": fresh_count,
                        "retained": sum(bool(q.get("retained")) for q in quotes.values()),
                        "elapsed_seconds": round(time.monotonic() - started, 3), "providers": dict(served),
                        "finnhub_checked": len(checked), "priority_overflow": overflow,
                        "plan": "Top 100 + shortlist + configured watchlist each cycle; rest hourly; maximum 190 Finnhub calls/cycle",
                        "warnings": ["Provider display/redistribution rights must be approved before client publication"]}}


def atomic_json(path, data):
    """Unique sibling temporary file + atomic replace; never truncate destination."""
    import tempfile
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    content = (json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")
    if path.is_file() and path.read_bytes() == content:
        return False
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=path.name + ".", suffix=".tmp", delete=False) as f:
        f.write(content)
        f.flush()
        os.fsync(f.fileno())
        temporary = f.name
    os.replace(temporary, path)
    return True


def optional_json(path):
    if not path.is_file():
        return {}
    return json.loads(path.read_text(encoding="utf-8-sig"))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--core", type=Path, default=Path("data/core.json"))
    parser.add_argument("--out", type=Path, default=Path("data/quotes.json"))
    parser.add_argument("--status", type=Path, default=Path("logs/quotes-status.json"))
    parser.add_argument("--watchlist", default=os.environ.get("QUOTE_WATCHLIST", ""))
    args = parser.parse_args(argv)
    try:
        core = optional_json(args.core)
        previous = optional_json(args.out)
        brief = optional_json(args.core.parent / "brief.json")
        config = optional_json(args.core.parent / "config.json")
        shortlist = [r["t"] for r in brief.get("shortlist", []) if r.get("t")]
        watchlist = [t.strip().upper() for t in args.watchlist.split(",") if t.strip()]
        watchlist += [t for t in config.get("quotes", {}).get("watchlist", []) if isinstance(t, str)]
        result = refresh(core, previous, shortlist=shortlist, watchlist=watchlist)
        status = {**result["refresh"], "at": utc()}
        if not status["received"]:
            # Even a retained-only snapshot does not replace the previous file.
            raise RuntimeError("No new prices returned; previous quotes.json preserved")
        atomic_json(args.status, status)
        atomic_json(args.out, result)
        print(json.dumps(status))
        return 0
    except Exception as exc:
        # Public fixed exception class only: request URLs or credentials never logged.
        status = {"status": "FAIL", "at": utc(), "reason": "Quote refresh failed; previous file preserved", "error_type": type(exc).__name__}
        try:
            atomic_json(args.status, status)
        except Exception:
            print("FAIL: unable to write status receipt", file=sys.stderr)
        print(json.dumps(status), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
