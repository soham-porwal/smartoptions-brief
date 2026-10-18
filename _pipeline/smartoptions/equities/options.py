"""ATM implied volatility from Yahoo's delayed option chain (context only)."""
from __future__ import annotations

from datetime import date, datetime, timezone
import math

import yfinance as yf

from ..log import event

IV_SOURCE = "Yahoo option chain, delayed; not a validated vol surface"


def pick_expiry(expiries: list[str], today: date, min_days: int = 7) -> str | None:
    ok = [e for e in sorted(expiries) if (datetime.strptime(e, "%Y-%m-%d").date() - today).days >= min_days]
    return ok[0] if ok else None


def _num(v):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def _trade_time(v) -> str | None:
    """Last trade time of the contract only; it dates neither the IV nor the bid/ask."""
    try:
        if v is None or v != v:
            return None
        ts = v.to_pydatetime() if hasattr(v, "to_pydatetime") else v
        if not isinstance(ts, datetime):
            return None
        ts = ts.replace(tzinfo=timezone.utc) if ts.tzinfo is None else ts.astimezone(timezone.utc)
        return ts.strftime("%Y-%m-%dT%H:%M:%SZ")
    except Exception:  # noqa: BLE001 - an unreadable trade time stays unknown, never "now"
        return None


def leg_context(name: str, row) -> dict:
    """Delayed quote context for one ATM leg exactly as Yahoo returned it (missing fields stay None)."""
    def nonnegative(key):
        value = _num(row.get(key))
        return value if value is not None and value >= 0 else None
    oi = nonnegative("openInterest")
    return {"leg": name, "strike": nonnegative("strike"), "iv_pct": (nonnegative("impliedVolatility") or 0) * 100 or None,
            "bid": nonnegative("bid"), "ask": nonnegative("ask"), "open_interest": int(oi) if oi is not None and oi.is_integer() else None,
            "last_trade_utc": _trade_time(row.get("lastTradeDate"))}


def atm_iv(sym: str, price: float, today: date, earnings_date: str | None) -> tuple[dict | None, str | None]:
    """Return (atm_iv dict or None, reason if None)."""
    try:
        t = yf.Ticker(sym)
        expiries = list(t.options or [])
        if not expiries:
            return None, "Yahoo returned no option expiries (no listed options, or rate-limited; retry later)"
        exp = pick_expiry(expiries, today)
        if not exp:
            return None, "no option expiry >= 7 days out"
        ch = t.option_chain(exp)
        retrieved_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")  # this chain request, not a quote time
        ivs, legs, quote = [], [], []
        for name, df in (("call", ch.calls), ("put", ch.puts)):
            if df is None or df.empty:
                continue
            row = df.iloc[(df["strike"] - price).abs().argsort().iloc[0]]
            v = _num(row.get("impliedVolatility"))
            if v is not None and v > 0.01:  # Yahoo returns ~0 for stale/illiquid quotes
                ivs.append(float(v) * 100)
                legs.append((name, float(row["strike"])))
                quote.append(leg_context(name, row))
        if not ivs:
            return None, "ATM call/put implied vol absent or ~0 (illiquid) in Yahoo chain"
        return {"expiry": exp, "iv": sum(ivs) / len(ivs), "unit": "pct", "source": IV_SOURCE, "strike": legs[0][1],
                "legs": [n for n, _ in legs], "retrieved_at": retrieved_at, "quote": quote,
                "spans_earnings": (earnings_date <= exp) if earnings_date else None}, None
    except Exception as e:  # noqa: BLE001
        event("equities.options", sym, "WARN", repr(e))
        return None, f"option chain fetch failed: {e!r}"[:200]
