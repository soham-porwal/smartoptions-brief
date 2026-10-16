"""Formatting helpers for the renderer. Every helper is total: bad or missing input renders as an
em dash carrying a reason tooltip, never as 0, "None", "NaN" or "null" (PLAN.md hard rule 1)."""
from __future__ import annotations

import html
import math
from datetime import date, datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
DASH = "—"
MINUS = "−"


def esc(v: Any) -> str:
    return html.escape("" if v is None else str(v), quote=True)


def is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def to_num(v: Any) -> float | None:
    """Numbers and numeric strings ('42.2', '1,234', '12%') -> float; anything else -> None."""
    if is_num(v):
        return float(v)
    if isinstance(v, str):
        s = v.strip().replace(",", "").rstrip("%")
        try:
            f = float(s)
        except ValueError:
            return None
        return f if math.isfinite(f) else None
    return None


def na(reason: str | None = None) -> str:
    r = reason or "missing: no value in source data"
    return f'<span class="na" title="{esc(r)}">{DASH}</span>'


def _fixed(v: float, d: int) -> str:
    s = f"{abs(v):,.{d}f}"
    if float(s.replace(",", "")) == 0:
        return s  # avoid "-0.00"
    return (MINUS if v < 0 else "") + s


def num(v: Any, d: int = 2, reason: str | None = None, suffix: str = "") -> str:
    f = to_num(v)
    if f is None:
        return na(reason)
    return f'<span class="n">{_fixed(f, d)}{esc(suffix)}</span>'


def sig(v: Any, digits: int = 3) -> str | None:
    """Plain-text number with ~`digits` significant figures, no scientific notation."""
    f = to_num(v)
    if f is None:
        return None
    if f == 0:
        return "0"
    mag = math.floor(math.log10(abs(f)))
    d = max(0, min(6, digits - 1 - mag))
    return _fixed(f, d)


def val_decimals(*vals: Any) -> int:
    """Decimals for a headline value: by magnitude, trailing zeros trimmed, integers >= 10 shown whole."""
    best = 0
    for v in vals:
        f = to_num(v)
        if f is None:
            continue
        a = abs(f)
        if a >= 10 and abs(f - round(f)) < 1e-9:
            d = 0
        else:
            d = 0 if a >= 1000 else 1 if a >= 100 else 2 if a >= 10 else 3
            s = f"{a:.{d}f}".rstrip("0")
            d = max(len(s.split(".")[1]) if "." in s else 0, 2 if a < 10 else 1 if a < 100 else 0)
        best = max(best, d)
    return best


def val(v: Any) -> str | None:
    f = to_num(v)
    return None if f is None else _fixed(f, val_decimals(f))


def signed(v: Any, d: int = 2, suffix: str = "%", reason: str | None = None, colour: bool = True) -> str:
    f = to_num(v)
    if f is None:
        return na(reason)
    txt = _fixed(f, d)
    if f > 0 and float(f"{f:.{d}f}") != 0:
        txt = "+" + txt
    cls = "n"
    if colour:
        cls += " up" if f > 0 else (" dn" if f < 0 else "")
    return f'<span class="{cls}">{txt}{esc(suffix)}</span>'


def chip(status: str | None, text: str | None = None, title: str | None = None) -> str:
    s = status if status in ("ok", "stale", "missing", "error") else "missing"
    t = f' title="{esc(title)}"' if title else ""
    return f'<span class="chip st-{s}"{t}>{esc(text or s)}</span>'


def link(url: Any, text: str = "source") -> str:
    if isinstance(url, str) and url.startswith(("http://", "https://")):
        return f'<a href="{esc(url)}" target="_blank" rel="noopener noreferrer">{esc(text)}</a>'
    return na("no source URL recorded")


def parse_dt(s: Any) -> datetime | None:
    if not isinstance(s, str) or not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        return None  # naive timestamps are ambiguous; refuse to place them in time
    return dt


def parse_date(s: Any) -> date | None:
    if not isinstance(s, str) or len(s) < 10:
        return None
    try:
        return date.fromisoformat(s[:10])
    except ValueError:
        return None


def et_text(dt: datetime, with_day: bool = True) -> str:
    e = dt.astimezone(ET)
    fmt = "%a %b %d, %H:%M" if with_day else "%H:%M"
    return e.strftime(fmt) + " ET"


def iso_utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def ts_html(dt: datetime | None, countdown: bool = False, reason: str = "no valid timestamp") -> str:
    """ET text rendered server-side; viewer-local time + live countdown filled in by inline JS."""
    if dt is None:
        return na(reason)
    iso = iso_utc(dt)
    out = f'<time datetime="{iso}" class="et">{esc(et_text(dt))}</time>'
    out += f' <span class="lt" data-ts="{iso}"></span>'
    if countdown:
        out += f' <span class="cd" data-ts="{iso}"></span>'
    return out


def sparkline(history: Any, w: int = 132, h: int = 30) -> str:
    pts = []
    if isinstance(history, list):
        for p in history:
            if isinstance(p, (list, tuple)) and len(p) >= 2 and to_num(p[1]) is not None:
                pts.append((str(p[0]), to_num(p[1])))
    if len(pts) < 2:
        return f'<span class="spark-na" title="fewer than 2 history points">no history</span>'
    vals = [v for _, v in pts]
    lo, hi = min(vals), max(vals)
    span = (hi - lo) or 1.0
    pad = 2
    n = len(pts) - 1
    coords = [(pad + (w - 2 * pad) * i / n, pad + (h - 2 * pad) * (1 - (v - lo) / span)) for i, (_, v) in enumerate(pts)]
    poly = " ".join(f"{x:.1f},{y:.1f}" for x, y in coords)
    lx, ly = coords[-1]
    title = f"{pts[0][0]} to {pts[-1][0]}: {len(pts)} points, low {sig(lo, 4)}, high {sig(hi, 4)}"
    return (f'<svg class="spark" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-label="{esc(title)}">'
            f'<title>{esc(title)}</title><polyline fill="none" stroke="currentColor" stroke-width="1.3" '
            f'stroke-linejoin="round" points="{poly}"/><circle cx="{lx:.1f}" cy="{ly:.1f}" r="2" fill="currentColor"/></svg>')
