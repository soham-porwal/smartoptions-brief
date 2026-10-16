"""S&P 500 constituent list (set A pool). Wikipedia first, datasets CSV fallback."""
from __future__ import annotations

import io

import pandas as pd
import requests

from ..log import event

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/124.0 Safari/537.36"}
WIKI = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
CSV = "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv"


def yahoo_symbol(s: str) -> str:
    return str(s).strip().upper().replace(".", "-")


def _get(url: str) -> str:
    last = None
    for _ in range(2):  # timeout + one retry
        try:
            r = requests.get(url, headers=UA, timeout=30)
            r.raise_for_status()
            return r.text
        except Exception as e:  # noqa: BLE001 - logged by caller
            last = e
    raise last  # type: ignore[misc]


def fetch_constituents() -> dict:
    """Return {symbols, names, sectors, source, url, count}; symbols are Yahoo-style."""
    attempts = [("Wikipedia List of S&P 500 companies", WIKI, "wiki"),
                ("datasets/s-and-p-500-companies constituents.csv", CSV, "csv")]
    for source, url, kind in attempts:
        try:
            txt = _get(url)
            if kind == "wiki":
                df = pd.read_html(io.StringIO(txt))[0]
                sym, name, sec = df["Symbol"], df["Security"], df["GICS Sector"]
            else:
                df = pd.read_csv(io.StringIO(txt))
                sym, name, sec = df["Symbol"], df["Security"], df["GICS Sector"]
            symbols = [yahoo_symbol(s) for s in sym]
            n = len(symbols)
            if len(set(symbols)) != n or not 495 <= n <= 510:
                raise ValueError(f"Invalid membership: {n} rows, {len(set(symbols))} unique symbols")
            sev = "OK" if 495 <= n <= 510 else "WARN"
            event("equities.universe", source, sev, f"{n} constituents" + ("" if sev == "OK" else " (outside 495..510)"), n)
            return {"symbols": symbols, "names": dict(zip(symbols, name)), "sectors": dict(zip(symbols, sec)),
                    "source": source, "url": url, "count": n,
                    "symbol_map": {str(s): yahoo_symbol(s) for s in sym}}
        except Exception as e:  # noqa: BLE001
            event("equities.universe", source, "FAIL", repr(e))
    event("equities.universe", "all", "FAIL", "no constituent source reachable; set A pool empty")
    return {"symbols": [], "names": {}, "sectors": {}, "source": None, "url": None, "count": 0}
