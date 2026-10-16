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
import statistics
from urllib.parse import quote
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
TAPE = ("SPY", "RSP", "^VIX", "^VIX3M", "DX-Y.NYB", "CL=F", "BZ=F", "HG=F", "^TNX")
FINNHUB_SPACING = 1.8  # ~33 starts/minute; the Worker fast path holds 22/min of the same free 60/min key (55 total).
QUOTE_INTERVAL_SECONDS = 450
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
    # A provider outage must not turn yesterday's trade into a closed market.
    if local.weekday() < 5 and 570 <= m < 960:
        return "regular"
    if local.weekday() >= 5 or (observed and observed.astimezone(ET).date() < local.date()):
        return "closed"
    return "pre" if 240 <= m < 570 else "regular" if 570 <= m < 960 else "post" if 960 <= m < 1200 else "closed"


def last_weekday_close(now):
    """Conservative cash-session clock; holidays may remain visibly stale."""
    local = now.astimezone(ET)
    close = local.replace(hour=16, minute=0, second=0, microsecond=0)
    if local < close:
        close -= timedelta(days=1)
    while close.weekday() >= 5:
        close -= timedelta(days=1)
    return close.astimezone(timezone.utc)


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
    """One due quote per symbol, watchlist -> shortlist -> top 100 -> remainder."""
    now = now or datetime.now(timezone.utc)
    top = sorted(rows, key=lambda t: finite(rows[t].get("mcap")) or 0, reverse=True)[:100]
    first = list(dict.fromkeys([*watchlist, *shortlist, *top, "SPY", "RSP"]))
    first = [t for t in first if (t in rows or t in {"SPY", "RSP"}) and re.fullmatch(r"[A-Z][A-Z0-9.-]{0,14}", t)]
    remaining = [t for t in rows if t not in first and re.fullmatch(r"[A-Z][A-Z0-9.-]{0,14}", t)]
    remaining.sort(key=lambda t: previous.get(t, {}).get("asof_utc") or "")
    def due(t, index):
        last = stamp(previous.get(t, {}).get("retrieved_at"))
        # Include the dispatch offset: a 7.5m sweep must not make its tail
        # wait an extra full cycle merely because it was sampled last.
        return not last or (now - last).total_seconds() + index * FINNHUB_SPACING >= QUOTE_INTERVAL_SECONDS
    selected = []
    for t in first + remaining:
        if due(t, len(selected)):
            selected.append(t)
    return selected, 0


class TokenBucket:
    """Capacity one: no startup burst; at most 50 starts/minute with headroom."""
    def __init__(self, spacing=FINNHUB_SPACING):
        self.spacing, self.next_start = spacing, 0.0
        self.lock = threading.Lock()

    def take(self):
        with self.lock:
            time.sleep(max(0, self.next_start - time.monotonic()))
            self.next_start = time.monotonic() + self.spacing


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
    if response.status_code in (401, 403):
        return None, "key rejected by provider"
    if response.status_code != 200:
        return None, f"HTTP {response.status_code}"
    data = response.json()
    if "invalid api key" in str(data.get("error", "")).lower():
        return None, "key rejected by provider"
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
    bucket = TokenBucket(spacing)
    started = time.monotonic()
    stopped = False
    for t in dict.fromkeys(symbols):
        if stopped:
            errors[t] = "Provider rate/authentication limit; remaining calls skipped"
            continue
        bucket.take()
        observed_now = now + timedelta(seconds=time.monotonic() - started)
        try:
            value, error = finnhub_one(t, key, observed_now, get)
            if error in {"HTTP 429", "key rejected by provider"}:
                stopped = True
        except Exception:
            value, error = None, "Request failed (details withheld to protect credentials)"
        checked.append(t)
        if value is not None:
            found[t] = value
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
    local = now.astimezone(ET)
    session_date = local.date().isoformat()
    last_close = (previous or {}).get("refresh", {}).get("close_sweep_session")
    close_due = local.weekday() < 5 and local.hour >= 16 and last_close != session_date
    clock_only = bool(old) and market_state(now) != "regular" and not close_due
    if close_due:
        plan, _ = priority_plan(rows, {}, shortlist, watchlist, now)
    if clock_only:
        plan = []
    for t in symbols:
        prev = old.get(t, {})
        retrieved = stamp(prev.get("retrieved_at"))
        interval = QUOTE_INTERVAL_SECONDS if prev.get("delay_minutes") == 0 else 900
        if finite(prev.get("price"), True) is not None and (clock_only or (not close_due and retrieved and (now - retrieved).total_seconds() < interval and (not keys.get("FINNHUB_API_KEY") or t not in plan))):
            quotes[t] = {**prev, "cached": True}
    plan = [t for t in plan if t not in quotes]
    if keys.get("FINNHUB_API_KEY"):
        if plan:
            more, errors, checked = finnhub(plan, keys["FINNHUB_API_KEY"], now)
            quotes.update(more)
    needed = [t for t in symbols if t not in quotes]
    if clock_only:
        needed = []  # Hourly off-hours checks never refetch missing symbols either.
    if needed and keys.get("APCA_API_KEY_ID") and keys.get("APCA_API_SECRET_KEY"):
        eligible = [t for t in needed if re.fullmatch(r"[A-Z][A-Z0-9.-]{0,14}", t)]
        more, issues = alpaca(eligible, keys["APCA_API_KEY_ID"], keys["APCA_API_SECRET_KEY"], now)
        quotes.update(more)
        errors.update({t: errors.get(t, "") + "; " + v for t, v in issues.items()})
    needed = [] if clock_only else [t for t in symbols if t not in quotes]
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
                             "reason": "Outside regular hours; awaiting next scheduled sweep" if clock_only else "No provider returned a valid timestamped price"}
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
        current["asof_et_label"] = ("as of " + observed.astimezone(ET).strftime("%I:%M %p").lstrip("0") + " ET") if observed else "Not available: provider timestamp missing"
        if current.get("price") is not None and observed:
            state = market_state(finished_at, observed)
            age = max(0, (finished_at - observed).total_seconds() / 60)
            delay = current.get("delay_minutes")
            label = "stale" if current.get("retained") or delay is None or age > 96 * 60 else "closed" if state == "closed" else "live" if delay == 0 and age <= 1 else "delayed" if delay > 0 and age <= delay + 15 else "stale"
            if label == "closed" and observed < last_weekday_close(finished_at) - timedelta(minutes=20):
                label = "stale"
                current["reason"] = "Observation predates the latest weekday close; source date retained"
            current.update(market_state=state, freshness=label)
            if label == "stale":
                current["status"] = "stale"
        if t in errors:
            quotes[t]["provider_warning"] = errors[t]
    served = Counter(q.get("provider") or "missing" for q in quotes.values())
    fresh_count = sum(q.get("price") is not None and not q.get("retained") and not q.get("cached") for q in quotes.values())
    success = sum(q.get("price") is not None for q in quotes.values())
    rejected = "key rejected by provider" in errors.values()
    prior_source = (previous or {}).get("health", {}).get("sources", [{}])[0]
    fh_note = "key rejected by provider" if rejected else "key missing" if not keys.get("FINNHUB_API_KEY") else "configured; no request due" if not checked else "quotes received" if any("Finnhub" in str(q.get("provider")) for q in quotes.values()) else "provider unavailable"
    old_rejection = prior_source.get("note") == "key rejected by provider" or any(q.get("provider_warning") in ("HTTP 401", "HTTP 403", "key rejected by provider") for q in old.values())
    if not checked and keys.get("FINNHUB_API_KEY") and old_rejection:
        fh_note = "key rejected by provider"
    ages = [(finished_at - stamp(q.get("asof_utc"))).total_seconds() / 60 for q in quotes.values() if q.get("price") is not None and stamp(q.get("asof_utc"))]
    eligible_count = sum(bool(re.fullmatch(r"[A-Z][A-Z0-9.-]{0,14}", t)) for t in symbols)
    sweep_minutes = round(max(QUOTE_INTERVAL_SECONDS, max(0, eligible_count - 1) * FINNHUB_SPACING) / 60, 1)
    mix = f"real-time quotes from Finnhub, about {int(sweep_minutes)} minutes apart" if any("Finnhub" in str(q.get("provider")) for q in quotes.values()) else "Yahoo, about 15 minutes delayed" if any("Yahoo" in str(q.get("provider")) for q in quotes.values()) else "Quote provider not available"
    median_age, oldest_age = (round(max(0, statistics.median(ages)), 1), round(max(0, max(ages)), 1)) if ages else (None, None)
    health = {"line": mix + (f"; median age {median_age}m, oldest {oldest_age}m" if ages else ""),
              "median_age_minutes": median_age, "oldest_age_minutes": oldest_age, "provider_mix": dict(served),
              "estimated_sweep_minutes": sweep_minutes, "cadence_basis": "450s minimum interval or universe dispatch time at 1.8s/start; excludes slow responses",
              "sources": [{"id": "finnhub", "status": "rejected" if fh_note == "key rejected by provider" else "missing" if not keys.get("FINNHUB_API_KEY") else "configured", "note": fh_note}]}
    spy_observed = stamp(quotes.get("SPY", {}).get("asof_utc"))
    if market_state(finished_at, spy_observed) == "closed" and spy_observed:
        health["line"] = "Market closed; last observed session " + spy_observed.astimezone(ET).date().isoformat() + "; " + health["line"]
    if fh_note in ("key rejected by provider", "key missing"):
        health["line"] += "; Finnhub: " + fh_note
    return {"generated_at": utc(finished_at), "session": market_state(finished_at, stamp(quotes.get("SPY", {}).get("ts"))),
            "health": health,
            "source": "Per-quote provider chain: Finnhub, Alpaca IEX, delayed Yahoo",
            "quotes": quotes, "session_method": "ET weekday clock; prior-date prices close holidays/data absences; no early-close calendar",
            "refresh": {"status": "OK" if fresh_count == len(symbols) and not errors else "WARN" if success else "FAIL",
                        "requested": len(symbols), "available": success, "received": fresh_count,
                        "cached": sum(bool(q.get("cached")) for q in quotes.values()), "clock_only": clock_only,
                        "close_sweep_session": session_date if close_due and fresh_count else last_close,
                        "retained": sum(bool(q.get("retained")) for q in quotes.values()),
                        "elapsed_seconds": round(time.monotonic() - started, 3), "providers": dict(served),
                        "finnhub_checked": len(checked), "priority_overflow": overflow,
                        "plan": "Watchlist, shortlist, top 100, remainder; 450s real-time interval, 900s Yahoo; 33 starts/minute",
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


def mirror_quotes(url, previous, get=None):
    """One canonical producer prevents two sites exhausting one free feed key."""
    import hashlib
    import requests
    allowed = "https://soham-porwal.github.io/smartoptions-brief/data/quotes.json"
    if url != allowed:
        raise ValueError("Unapproved canonical quotes URL")
    response = (get or requests.get)(url, timeout=(5, 25), allow_redirects=False)
    if response.status_code != 200 or len(response.content) > 8 * 1024 * 1024:
        raise ValueError("Canonical quotes unavailable")
    data = response.json()
    quotes = data.get("quotes") if isinstance(data, dict) else None
    if not isinstance(quotes, dict) or not quotes:
        raise ValueError("Canonical quotes missing")
    old_valid = sum(finite(q.get("price"), True) is not None for q in previous.get("quotes", {}).values())
    new_valid = 0
    for symbol, quote in quotes.items():
        if not re.fullmatch(r"[A-Z0-9.^=/-]{1,20}", symbol) or not isinstance(quote, dict):
            raise ValueError("Invalid canonical quote")
        if quote.get("price") is not None:
            if finite(quote["price"], True) is None or not stamp(quote.get("asof_utc")):
                raise ValueError("Invalid canonical price/timestamp")
            new_valid += 1
    if new_valid < old_valid:
        raise ValueError("Canonical quote coverage regressed")
    if stamp(data.get("generated_at")) and stamp(previous.get("generated_at")) and stamp(data["generated_at"]) < stamp(previous["generated_at"]):
        raise ValueError("Canonical snapshot older than current client")
    data["mirror"] = {"url": url, "mirrored_at": utc(), "source_sha256": hashlib.sha256(response.content).hexdigest(), "provider_calls": 0}
    return data


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--core", type=Path, default=Path("data/core.json"))
    parser.add_argument("--out", type=Path, default=Path("data/quotes.json"))
    parser.add_argument("--status", type=Path, default=Path("logs/quotes-status.json"))
    parser.add_argument("--watchlist", default=os.environ.get("QUOTE_WATCHLIST", ""))
    parser.add_argument("--check-key", action="store_true", help="Check Finnhub authentication without revealing credentials")
    parser.add_argument("--mirror-url", help="Client site mirrors the approved canonical feed without provider calls")
    args = parser.parse_args(argv)
    try:
        if args.check_key:
            key = secret("FINNHUB_API_KEY")
            if not key:
                print("Finnhub: missing")
                return 2
            result, error = finnhub_one("SPY", key, datetime.now(timezone.utc))
            print("Finnhub: valid" if result else "Finnhub: invalid (key rejected by provider)" if error == "key rejected by provider" else "Finnhub: unverified (provider unavailable)")
            return 0 if result else 2 if error == "key rejected by provider" else 1
        previous = optional_json(args.out)
        if args.mirror_url:
            result = mirror_quotes(args.mirror_url, previous)
            status = {"status": "OK", "at": utc(), "mode": "canonical_mirror", "provider_calls": 0,
                      "received": len(result["quotes"]), "source_sha256": result["mirror"]["source_sha256"]}
            atomic_json(args.status, status)
            atomic_json(args.out, result)
            print(json.dumps(status))
            return 0
        core = optional_json(args.core)
        brief = optional_json(args.core.parent / "brief.json")
        config = optional_json(args.core.parent / "config.json")
        shortlist = [r["t"] for r in brief.get("shortlist", []) if r.get("t")]
        watchlist = [t.strip().upper() for t in args.watchlist.split(",") if t.strip()]
        watchlist += [t for t in config.get("quotes", {}).get("watchlist", []) if isinstance(t, str)]
        result = refresh(core, previous, shortlist=shortlist, watchlist=watchlist)
        status = {**result["refresh"], "at": utc()}
        if not status["received"] and not status.get("cached") and not status.get("clock_only"):
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
