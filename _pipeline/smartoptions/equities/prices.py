"""Daily prices via yfinance and the derived price statistics."""
from __future__ import annotations

import json
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd
import yfinance as yf

from ..log import event
from ..contract import utc_now, write_json

ET = ZoneInfo("America/New_York")
FIELDS = ["Open", "High", "Low", "Close", "Adj Close", "Volume"]


def download(symbols: list[str], raw_dir: Path, refresh: bool = False, chunk: int = 50) -> pd.DataFrame:
    """Return long-format frame (date, symbol, fields). auto_adjust=False: Close = unadjusted for
    dividends (price levels, 52w range), Adj Close = split+dividend adjusted (returns, % changes)."""
    cache = raw_dir / "prices.csv.gz"
    metadata = raw_dir / "prices-provenance.json"
    if cache.exists() and not refresh:
        df = pd.read_csv(cache, parse_dates=["Date"])
        try:
            meta = json.loads(metadata.read_text(encoding="utf-8")) if metadata.exists() else {}
            stamp = cache.stat()
            if meta.get("cache_mtime_ns") == stamp.st_mtime_ns and meta.get("cache_size") == stamp.st_size:
                df.attrs["retrieved_at"] = meta.get("retrieved_at")
        except (OSError, ValueError, TypeError) as exc:
            event("equities.prices", "cache-provenance", "WARN", f"{type(exc).__name__}; acquisition time unavailable")
        if not df.attrs.get("retrieved_at"):
            event("equities.prices", "cache-provenance", "WARN", "Legacy/mismatched cache has no acquisition timestamp; values marked stale until refresh")
        event("equities.prices", "cache", "OK", f"loaded {cache.name}: {df['Symbol'].nunique()} symbols", df["Symbol"].nunique())
        missing = sorted(set(symbols) - set(df["Symbol"]))
        if not missing:
            return df
        event("equities.prices", "cache-coverage", "WARN", f"{len(missing)} requested symbols absent; refreshing full batch")
    frames = []
    for i in range(0, len(symbols), chunk):
        if i:
            time.sleep(1)
        part = symbols[i:i + chunk]
        data = None
        for attempt in range(2):
            try:
                data = yf.download(part, period="15mo", interval="1d", auto_adjust=False, group_by="ticker",
                                   threads=4, progress=False, timeout=60)
                if data is not None and len(data):
                    break
            except Exception as e:  # noqa: BLE001
                event("equities.prices", f"chunk{i}", "WARN", f"attempt {attempt}: {e!r}")
        if data is None or not len(data):
            event("equities.prices", f"chunk{i}", "FAIL", f"no data for {len(part)} symbols")
            continue
        got = 0
        for s in part:
            try:
                d = data[s] if isinstance(data.columns, pd.MultiIndex) else data
                d = d.dropna(subset=["Close"]).copy()
                if d.empty:
                    continue
                d["Symbol"] = s
                frames.append(d.reset_index()[["Date", "Symbol"] + [c for c in FIELDS if c in d.columns]])
                got += 1
            except KeyError:
                continue
        event("equities.prices", f"chunk{i}", "OK" if got == len(part) else "WARN" if got else "FAIL", f"{got}/{len(part)} symbols have bars", got)
    if not frames:
        return pd.DataFrame(columns=["Date", "Symbol"] + FIELDS)
    missing = sorted(set(symbols) - {f["Symbol"].iloc[0] for f in frames})
    for s in missing:  # sequential retry: parallel chunks can lose symbols to sqlite 'database is locked'
        time.sleep(1)
        try:
            d = yf.download(s, period="15mo", interval="1d", auto_adjust=False, threads=False, progress=False, timeout=60)
            if isinstance(d.columns, pd.MultiIndex):
                d.columns = d.columns.get_level_values(0)
            d = d.dropna(subset=["Close"]).copy()
            if len(d):
                d["Symbol"] = s
                frames.append(d.reset_index()[["Date", "Symbol"] + [c for c in FIELDS if c in d.columns]])
                continue
        except Exception as e:  # noqa: BLE001
            event("equities.prices", s, "WARN", f"retry failed: {e!r}")
        event("equities.prices", s, "WARN", "no price bars from Yahoo (delisted/renamed/unavailable)")
    df = pd.concat(frames, ignore_index=True)
    df["Date"] = pd.to_datetime(df["Date"]).dt.tz_localize(None).dt.normalize()
    raw_dir.mkdir(parents=True, exist_ok=True)
    df.to_csv(cache, index=False, compression="gzip")
    df.attrs["retrieved_at"] = utc_now()
    stamp = cache.stat()
    write_json(metadata, {"retrieved_at": df.attrs["retrieved_at"], "cache_mtime_ns": stamp.st_mtime_ns,
                          "cache_size": stamp.st_size,
                          "method": "UTC completion of Yahoo batch acquisition; original per-response times unavailable"})
    return df


def drop_partial_bar(df: pd.DataFrame, now: datetime | None = None) -> tuple[pd.DataFrame, str | None]:
    """If the latest bar is today's (US/Eastern) and ET time < 16:15, it is partial: exclude it.
    Returns (frame, note)."""
    if df.empty:
        return df, "No daily bars returned; prices and trading session are unavailable"
    now = now or datetime.now(ET)
    now = now.astimezone(ET)
    last = df["Date"].max()
    if last.date() == now.date() and (now.hour, now.minute) < (16, 15):
        return df[df["Date"] < last], f"excluded partial bar {last.date()} (ET time {now:%H:%M} < 16:15)"
    return df, None


def stats(df: pd.DataFrame, asof: pd.Timestamp) -> dict[str, dict]:
    """Per-symbol price statistics as of the session `asof`."""
    out: dict[str, dict] = {}
    for sym, g in df.groupby("Symbol"):
        g = g.sort_values("Date")
        g = g[g["Date"] <= asof]
        if len(g) < 2:
            continue
        adj = g["Adj Close"].astype(float)
        last_date = g["Date"].iloc[-1]

        def chg(n: int):
            return float((adj.iloc[-1] / adj.iloc[-1 - n] - 1) * 100) if len(adj) > n else None

        vol = g["Volume"].astype(float)
        prior = vol.iloc[-21:-1]
        ratio = float(vol.iloc[-1] / prior.mean()) if len(prior) == 20 and prior.mean() > 0 else None
        w = g.tail(252)
        lo, hi, px = float(w["Low"].min()), float(w["High"].max()), float(g["Close"].iloc[-1])
        pct = float((px - lo) / (hi - lo) * 100) if hi > lo else None
        out[sym] = {
            "price": px, "price_date": last_date.strftime("%Y-%m-%d"),
            "chg_1d_pct": chg(1), "chg_5d_pct": chg(5), "chg_1m_pct": chg(21),
            "vol_ratio_20d": ratio, "volume": float(vol.iloc[-1]),
            "range_52w": {"low": lo, "high": hi, "pctile": pct, "sessions": int(len(w))},
        }
    return out


def returns(df: pd.DataFrame, symbols: list[str], asof: pd.Timestamp, n: int = 300) -> dict[str, list]:
    """Daily returns (decimal fractions, from Adj Close), last n sessions."""
    res = {}
    for sym in symbols:
        g = df[(df["Symbol"] == sym) & (df["Date"] <= asof)].sort_values("Date")
        if len(g) < 3:
            continue
        r = g.set_index("Date")["Adj Close"].astype(float).pct_change().dropna().tail(n)
        res[sym] = [[d.strftime("%Y-%m-%d"), round(float(v), 6)] for d, v in r.items() if v == v]
    return res
