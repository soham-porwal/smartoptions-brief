"""ATM implied volatility from Yahoo's delayed option chain (context only)."""
from __future__ import annotations

from datetime import date, datetime

import yfinance as yf

from ..log import event

IV_SOURCE = "Yahoo option chain, delayed; not a validated vol surface"


def pick_expiry(expiries: list[str], today: date, min_days: int = 7) -> str | None:
    ok = [e for e in sorted(expiries) if (datetime.strptime(e, "%Y-%m-%d").date() - today).days >= min_days]
    return ok[0] if ok else None


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
        ivs, legs = [], []
        for name, df in (("call", ch.calls), ("put", ch.puts)):
            if df is None or df.empty:
                continue
            row = df.iloc[(df["strike"] - price).abs().argsort().iloc[0]]
            v = row.get("impliedVolatility")
            if v is not None and v == v and v > 0.01:  # Yahoo returns ~0 for stale/illiquid quotes
                ivs.append(float(v) * 100)
                legs.append((name, float(row["strike"])))
        if not ivs:
            return None, "ATM call/put implied vol absent or ~0 (illiquid) in Yahoo chain"
        return {"expiry": exp, "iv": sum(ivs) / len(ivs), "unit": "pct", "source": IV_SOURCE, "strike": legs[0][1],
                "legs": [n for n, _ in legs],
                "spans_earnings": (earnings_date <= exp) if earnings_date else None}, None
    except Exception as e:  # noqa: BLE001
        event("equities.options", sym, "WARN", repr(e))
        return None, f"option chain fetch failed: {e!r}"[:200]
