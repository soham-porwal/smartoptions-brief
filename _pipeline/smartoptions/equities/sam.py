"""Parse Sam's published screener snapshot (index.html): 19-column table + EXPLAIN JSON.

Read-only: values are stored as published, never recomputed. Missing markers become None.
"""
from __future__ import annotations

import html
import json
import re
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]
_PACKAGED_SNAPSHOT = _ROOT / "fixtures" / "sam-snapshot-2026-07-25.html"
DEFAULT_HTML = (_PACKAGED_SNAPSHOT if _PACKAGED_SNAPSHOT.exists() else
                Path(__file__).resolve().parents[3] / "sp500-screener-dashboard" / "index.html")
SNAPSHOT_LABEL = "SmartOptions snapshot"
MISSING = {"", "—", "???", "-", "n/a", "na", "nan", "none"}

# header order in the page -> output key
FIELDS = ["ticker", "company", "sector", "price", "opportunity_score", "quality", "eps_growth_pct",
          "rev_growth_pct", "roe_pct", "debt_equity", "forward_pe", "trendscore", "rsi_14",
          "stock_1m", "vs_sp500_1m", "below_52w_high", "risk", "earnings_in", "risk_flags"]
TEXT_FIELDS = {"ticker", "company", "sector", "quality", "risk", "risk_flags"}

_TAG = re.compile(r"<[^>]+>")
_NUM = re.compile(r"^[+-]?\d[\d,]*\.?\d*%?$|^[+-]?\.\d+%?$")


def _cell(raw: str) -> str:
    return html.unescape(_TAG.sub("", raw)).strip()


def _value(field: str, text: str):
    if text.strip().lower() in MISSING:
        return None
    if field in TEXT_FIELDS:
        return text
    s = text.replace(",", "")
    if _NUM.match(s):
        return float(s.rstrip("%"))
    return text  # unparsed string kept verbatim, never guessed


def parse_header(t: str) -> str | None:
    m = re.search(r"Last Updated:\s*([^<|&]+?)\s*(?:&nbsp;|\||<)", t)
    return m.group(1).strip() if m else None


def snapshot_asof(header: str | None) -> str | None:
    """'Jul 25, 2026 1:15 PM PT' -> '2026-07-25 13:15 PT' (None if unparseable)."""
    if not header:
        return None
    from datetime import datetime
    m = re.match(r"(.+?)\s+(PT|PST|PDT)$", header)
    try:
        d = datetime.strptime(m.group(1) if m else header, "%b %d, %Y %I:%M %p")
    except ValueError:
        return None
    return d.strftime("%Y-%m-%d %H:%M ") + (m.group(2) if m else "PT")


def parse_explain(t: str) -> dict:
    i = t.find("EXPLAIN=")
    if i < 0:
        raise ValueError("EXPLAIN= not found")
    j = t.find("{", i)
    obj, _ = json.JSONDecoder().raw_decode(t, j)
    return obj


def parse_rows(t: str) -> list[dict]:
    body = t[t.find("<tbody"):]
    body = body[: body.find("</tbody>")]
    rows = []
    for tr in re.finditer(r"<tr\b([^>]*)>(.*?)</tr>", body, re.S):
        cells = [_cell(c) for c in re.findall(r"<td\b[^>]*>(.*?)</td>", tr.group(2), re.S)]
        if len(cells) != len(FIELDS):
            raise ValueError(f"row has {len(cells)} cells, expected {len(FIELDS)}: {cells[:2]}")
        rows.append({f: _value(f, c) for f, c in zip(FIELDS, cells)})
    return rows


def load(path: Path | None = None) -> dict:
    """Return {rows, explain, asof, header, report}. report carries the round-trip checks."""
    t = Path(path or DEFAULT_HTML).read_text(encoding="utf-8")
    rows, explain = parse_rows(t), parse_explain(t)
    header = parse_header(t)
    m = re.search(r'id="row-count">(\d+)<', t)
    declared = int(m.group(1)) if m else None
    tick = [r["ticker"] for r in rows]
    report = {
        "rows": len(rows), "declared_row_count": declared, "explain_keys": len(explain),
        "dup_tickers": sorted({x for x in tick if tick.count(x) > 1}),
        "rows_without_explain": sorted(set(tick) - set(explain)),
        "explain_without_row": sorted(set(explain) - set(tick)),
    }
    report["ok"] = (len(rows) > 0 and declared in (None, len(rows)) and not report["dup_tickers"]
                    and not report["rows_without_explain"])
    return {"rows": rows, "explain": explain, "header": header, "asof": snapshot_asof(header),
            "report": report}
