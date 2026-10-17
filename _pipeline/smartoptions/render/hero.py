"""Top-of-page visuals: SmartOptions regime hero, options-seller gauges, the macro x sector interactions
heatmap, the 'also worth watching' strip and the per-ticker move-attribution bar.
Every number comes from relations.json / macro.json; anything absent renders as an em dash with a reason."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .fmt import MINUS, esc, na, sig, signed, to_num, val, val_decimals

# the reference tier cut-offs, from docs/score-definitions.json "Market regime card" (market_regime.py): AVOID <30,
# DEFENSIVE <50, NORMAL <70, FAVORABLE <85, OPTIMAL 85+.
TIERS = [(0, "AVOID"), (30, "DEFENSIVE"), (50, "NORMAL"), (70, "FAVORABLE"), (85, "OPTIMAL")]
COMP = [("vix", "VIX"), ("ad", "A/D"), ("newhl", "New H/L"), ("upvol", "Up vol"), ("trin", "TRIN")]
# heatmap column order: rates, dollar, oil, VIX, market
HEAT_COLS = [("us10y_bps", "Rates", "10y"), ("dxy", "Dollar", "DXY"), ("wti", "Oil", "WTI"), ("vix", "VIX", "VIX"),
             ("spy", "Market", "SPY")]
SCORE_DEFS = Path(__file__).resolve().parents[2] / "docs" / "score-definitions.json"


def score_defs() -> dict[str, str]:
    """the reference own column definitions (lane S, read from his code). Read-only; empty if the file is absent."""
    try:
        raw = json.loads(SCORE_DEFS.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {k: v["plain"] for k, v in raw.items() if isinstance(v, dict) and isinstance(v.get("plain"), str)}


def info(text: Any) -> str:
    """(i) marker: long text lives only in the tooltip."""
    if not text:
        return ""
    return f'<span class="info" tabindex="0" title="{esc(text)}" aria-label="{esc(text)}">i</span>'


def _pts(history: Any) -> list[tuple[str, float]]:
    out = []
    for p in history if isinstance(history, list) else []:
        if isinstance(p, (list, tuple)) and len(p) >= 2 and to_num(p[1]) is not None:
            out.append((str(p[0]), to_num(p[1])))
    return out


def spark(history: Any, w: int = 220, h: int = 44, lo: float | None = None, hi: float | None = None,
          ref: float | None = None, bands: list[float] | None = None, cls: str = "spark") -> str:
    """Sparkline with an optional fixed domain, a reference line (0 or 1.0) and horizontal band lines."""
    pts = _pts(history)
    if len(pts) < 2:
        return '<span class="spark-na" title="fewer than 2 history points">no history</span>'
    vals = [v for _, v in pts]
    lo = min(vals + ([ref] if ref is not None else [])) if lo is None else lo
    hi = max(vals + ([ref] if ref is not None else [])) if hi is None else hi
    span = (hi - lo) or 1.0
    pad, n = 2, len(pts) - 1

    def y(v: float) -> float:
        return pad + (h - 2 * pad) * (1 - (v - lo) / span)
    xy = [(pad + (w - 2 * pad) * i / n, y(v)) for i, (_, v) in enumerate(pts)]
    extra = ""
    for b in bands or []:
        extra += f'<line x1="0" x2="{w}" y1="{y(b):.1f}" y2="{y(b):.1f}" class="sp-band"/>'
    if ref is not None and lo <= ref <= hi:
        extra += f'<line x1="0" x2="{w}" y1="{y(ref):.1f}" y2="{y(ref):.1f}" class="sp-ref"/>'
    lx, ly = xy[-1]
    title = f"{pts[0][0]} to {pts[-1][0]}: {len(pts)} points, low {sig(min(vals), 4)}, high {sig(max(vals), 4)}"
    return (f'<svg class="{cls}" viewBox="0 0 {w} {h}" width="{w}" height="{h}" preserveAspectRatio="none" role="img" '
            f'aria-label="{esc(title)}"><title>{esc(title)}</title>{extra}<polyline fill="none" stroke="currentColor" '
            f'stroke-width="1.4" stroke-linejoin="round" vector-effect="non-scaling-stroke" points="'
            + " ".join(f"{a:.1f},{b:.1f}" for a, b in xy)
            + f'"/><circle cx="{lx:.1f}" cy="{ly:.1f}" r="2.4" fill="currentColor"/></svg>')


# ---------------------------------------------------------------- regime hero
def tier_of(score: float) -> str:
    t = TIERS[0][1]
    for cut, name in TIERS:
        if score >= cut:
            t = name
    return t


def regime_hero(rel: dict | None, reason: str | None = None) -> str:
    rg = (rel or {}).get("regime")
    if not isinstance(rg, dict) or to_num(rg.get("score")) is None:
        why = reason or "relations.json has no regime score"
        return (f'<section class="hero" id="regime"><div class="hero-l"><div class="eyebrow">SmartOptions regime</div>'
                f'<div class="hero-v">{na(why)}</div></div></section>')
    score = to_num(rg["score"])
    tier = str(rg.get("tier") or tier_of(score))
    comps = rg.get("components") or {}
    segs = []
    for k, lbl in COMP:
        c = comps.get(k) if isinstance(comps.get(k), dict) else {}
        w = to_num(c.get("weight")) or 0.1
        sc = to_num(c.get("score"))
        if sc is None:
            tip = f"{lbl}: not available ({c.get('note') or 'no data'}); weight {sig(w, 2)} renormalized away"
            segs.append(f'<div class="seg seg-na" style="flex:{w}" title="{esc(tip)}"><span class="seg-l">{esc(lbl)}</span>'
                        f'<span class="seg-v">n/a</span></div>')
            continue
        raw = ""
        if k == "vix" and to_num(c.get("value")) is not None:
            raw = f" · VIX {val(c['value'])}"
        elif k == "ad" and to_num(c.get("ratio")) is not None:
            raw = f" · advancers {to_num(c['ratio']) * 100:.0f}% of {c.get('n', '?')}"
        elif k == "newhl":
            raw = f" · near high {c.get('near_high', '?')} / near low {c.get('near_low', '?')}"
        tip = f"{lbl}: score {sig(sc, 3)} of 100, weight {sig(w, 2)}{raw}"
        segs.append(f'<div class="seg t-{tier_of(sc).lower()}" style="flex:{w}" title="{esc(tip)}">'
                    f'<i style="width:{max(0.0, min(100.0, sc)):.0f}%"></i><span class="seg-l">{esc(lbl)}</span>'
                    f'<span class="seg-v n">{sig(sc, 3)}</span></div>')
    scale = "".join(f'<span style="left:{c}%">{c}</span>' for c, _ in TIERS[1:])
    hist = rg.get("history_partial")
    hn = len(_pts(hist))
    tip = f"{rg.get('method') or ''} Tiers (reference rules): AVOID <30, DEFENSIVE <50, NORMAL <70, FAVORABLE <85, OPTIMAL 85+."
    return f"""<section class="hero" id="regime">
 <div class="hero-l"><div class="eyebrow">SmartOptions regime {info(tip)}</div>
  <div class="hero-v"><span class="hero-n n">{val(score)}</span><span class="tier t-{esc(tier.lower())}">{esc(tier)}</span></div>
  <div class="hero-scale"><i style="left:{max(0.0, min(100.0, score)):.1f}%"></i>{scale}</div></div>
 <div class="hero-m"><div class="eyebrow">Components · width = weight</div><div class="segbar">{"".join(segs)}</div></div>
 <div class="hero-r"><div class="eyebrow">{hn} sessions {info(rg.get("history_note") or "partial history")}</div>
  {spark(hist, 240, 56, 0, 100, None, [30, 50, 70, 85], "spark hero-sp")}</div>
</section>"""


# ---------------------------------------------------------------- options-seller gauges
GAUGES = [
    ("vrp", "VRP", "VIX − SPY 21d realized", 0.0, lambda v: "rich" if v > 0 else "inverted" if v < 0 else "thin"),
    ("term_ratio", "Term", "VIX / VIX3M", 1.0, lambda v: "backwardation" if v > 1 else "contango" if v < 1 else "flat"),
    ("breadth_rsp_spy_20d", "Breadth", "RSP − SPY, 20d", 0.0, lambda v: "broad" if v > 0 else "narrow" if v < 0 else "even"),
]
STATE_CLS = {"rich": "pos", "contango": "pos", "broad": "pos", "inverted": "neg", "backwardation": "neg", "narrow": "neg"}


def seller_gauges(rel: dict | None) -> str:
    vb = (rel or {}).get("vol_breadth")
    if not isinstance(vb, dict):
        return ""
    cards = []
    for key, name, sub, ref, state in GAUGES:
        x = vb.get(key) if isinstance(vb.get(key), dict) else {}
        v = to_num(x.get("value"))
        unit = x.get("unit") or ""
        pts = _pts(x.get("history"))
        if v is None:
            body = f'<div class="g-v">{na(f"{key}: not computed by relations stage")}</div>'
        else:
            vals = [p for _, p in pts] + [v, ref]
            lo, hi = min(vals), max(vals)
            span = (hi - lo) or 1.0
            pos = (v - lo) / span * 100
            rpos = (ref - lo) / span * 100
            st = state(v)
            body = (f'<div class="g-v"><span class="g-n n">{val(v)}</span><span class="g-u">{esc(unit)}</span>'
                    f'<span class="state s-{STATE_CLS.get(st, "flat")}">{esc(st)}</span></div>'
                    f'<div class="g-track" title="{esc(f"range of last {len(pts)} sessions: {sig(lo, 3)} to {sig(hi, 3)}; line = {ref:g}")}">'
                    f'<b style="left:{rpos:.1f}%"></b><i style="left:{pos:.1f}%"></i></div>')
        tip = f"{sub}. {vb.get('method') or ''}"
        cards.append(f'<div class="gauge"><div class="g-h"><span class="g-l">{esc(name)}</span><span class="g-s">{esc(sub)}</span>{info(tip)}</div>'
                     f'{body}{spark(x.get("history"), 200, 30, None, None, ref)}</div>')
    return f'<div class="gauges" aria-label="Options seller gauges">{"".join(cards)}</div>'


# ---------------------------------------------------------------- interactions heatmap
def _short(sector: str) -> str:
    return {"Information Technology": "Info Tech", "Consumer Discretionary": "Cons. Discr.", "Consumer Staples": "Cons. Staples",
            "Communication Services": "Comm. Services"}.get(sector, sector)


def heat_exposed(rel: dict) -> dict[str, list[dict]]:
    """Per-factor exposed tickers from the insight cards (measured sensitivity only), strongest |t| first."""
    out: dict[str, dict[str, dict]] = {}
    for c in rel.get("insights") or []:
        for x in c.get("exposed") or []:
            f, t, tv = x.get("factor"), x.get("ticker"), to_num(x.get("t"))
            if f in dict((k, 1) for k, _, _ in HEAT_COLS) and t and tv is not None:
                cur = out.setdefault(f, {}).get(t)
                if cur is None or abs(tv) > abs(to_num(cur.get("t")) or 0):
                    out[f][t] = x
    return {f: sorted(d.values(), key=lambda x: -abs(to_num(x.get("t")) or 0)) for f, d in out.items()}


def interactions(data: dict, reasons: dict, tchip) -> str:
    rel = data.get("relations") or {}
    sectors = rel.get("sectors") if isinstance(rel.get("sectors"), dict) else {}
    if not sectors:
        return ""
    units = rel.get("factor_units") or {}
    cols = [c for c in HEAT_COLS if any(to_num((s.get("median_coef") or {}).get(c[0])) is not None for s in sectors.values())]
    if not cols:
        return ""
    # colour scaled within each column (units differ by factor): |median| / max |median| in that column
    mx = {f: max((abs(to_num((s.get("median_coef") or {}).get(f)) or 0) for s in sectors.values()), default=0) or 1.0
          for f, _, _ in cols}
    order = sorted(sectors.items(), key=lambda kv: -(to_num(kv[1].get("n")) or 0))
    head = "".join(f'<th scope="col" title="{esc(units.get(f, ""))}">{esc(lbl)}<small>{esc(sh)}</small></th>' for f, lbl, sh in cols)
    rows = []
    for sec, s in order:
        mc = s.get("median_coef") or {}
        tds = []
        for f, lbl, sh in cols:
            c = to_num(mc.get(f))
            if c is None:
                tds.append(f'<td class="hm-na">{na("no median for this sector/factor")}</td>')
                continue
            a = min(1.0, abs(c) / mx[f])
            tip = f"{sec} · {lbl}: median β {sig(c, 3)} ({units.get(f, '')}) over {s.get('n')} names. Click: filter table to {sec}, sort by {sh} β."
            tds.append(f'<td><button type="button" class="hm {"hp" if c > 0 else "hn"}" style="--a:{0.08 + 0.72 * a:.2f}" '
                       f'data-sec="{esc(sec)}" data-f="{esc(f)}" data-lbl="{esc(sh)}" data-dir="{1 if c > 0 else -1}" title="{esc(tip)}">'
                       f'{(MINUS if c < 0 else "+")}{sig(abs(c), 2)}</button></td>')
        rows.append(f'<tr><th scope="row" title="{esc(sec)}">{esc(_short(sec))} <small>{esc(s.get("n"))}</small></th>{"".join(tds)}</tr>')
    tickers = (data.get("equities") or {}).get("tickers") or {}
    ex = heat_exposed(rel)
    chips = []
    for f, lbl, sh in cols:
        xs = ex.get(f) or []
        if not xs:
            continue
        cc = "".join(tchip(str(x["ticker"]), f' <small class="{"up" if (to_num(x.get("coef")) or 0) > 0 else "dn"}">t {sig(x.get("t"), 2)}</small>', tickers)
                     for x in xs[:5])
        chips.append(f'<div class="mx"><span class="mx-l">{esc(lbl)}</span>{cc}</div>')
    tip = ("Cell = median regression coefficient of the sector's stocks on that factor (daily returns, "
           f"{rel.get('window') or 'stated window'}). Colour is scaled within each column because units differ. "
           "Green = moves with the factor, red = against. Association, not causation. "
           "Chips = most exposed names from the insight cards (|t| > 2).")
    return f"""<div class="inter">
 <div class="hm-wrap"><table class="hmt"><thead><tr><th scope="col" class="hm-c">sector · n{info(tip)}</th>{head}</tr></thead>
 <tbody>{"".join(rows)}</tbody></table></div>
 <div class="mxs"><div class="eyebrow">Most exposed</div>{"".join(chips) or '<span class="muted small">no measured exposures in insight cards</span>'}</div>
</div>"""


# ---------------------------------------------------------------- also worth watching
def _obs(data: dict, oid: str) -> dict | None:
    for obs in ((data.get("macro") or {}).get("groups") or {}).values():
        for o in obs or []:
            if o.get("id") == oid:
                return o
    return None


ALSO = [  # (AGY relationship #, label, [macro ids]) - only relationships our own data can show
    (6, "Curve vs credit", ["spread_10y_2y", "hy_oas"]),
    (5, "Fed liquidity (partial: no TGA / RRP)", ["fed_balance_sheet", "reserve_balances"]),
]
ALSO_MISSING = "SKEW (#3), real 10y vs P/E (#4), Sahm rule (#7): not in our sources"


def also_watching(data: dict) -> str:
    cells = []
    for rank, lbl, ids in ALSO:
        parts = []
        for oid in ids:
            o = _obs(data, oid)
            if not o:
                parts.append(f'<span class="aw-i"><span class="aw-l">{esc(oid)}</span>{na("series not in macro.json")}</span>')
                continue
            v, p = to_num(o.get("value")), to_num(o.get("prior"))
            vh = f'<b class="n">{val(v)}</b> <small>{esc(o.get("unit") or "")}</small>' if v is not None else na(f"{o.get('status')}: {o.get('note') or 'no value'}")
            dh = signed(v - p, val_decimals(v, p), "", colour=False) if v is not None and p is not None else ""
            tip = f"{o.get('label')} · {o.get('provider')} {o.get('series')} · period {o.get('period')}"
            parts.append(f'<span class="aw-i" title="{esc(tip)}"><span class="aw-l">{esc(o.get("label") or oid)}</span>{vh} '
                         f'<small class="muted">{dh}</small>{spark(o.get("history"), 80, 18, cls="spark mini")}</span>')
        cells.append(f'<div class="aw"><div class="aw-h">#{rank} {esc(lbl)}</div>{"".join(parts)}</div>')
    tip = ("Ranked relationships from Soham's research job on shared links (AGY job 2d034ec4991c6daca6fe). "
           "#1, #2, #9 are the gauges above. Only relationships our own data covers are shown. " + ALSO_MISSING + ".")
    return (f'<div class="also"><div class="eyebrow">Also worth watching {info(tip)}</div><div class="aws">{"".join(cells)}</div></div>')


# ---------------------------------------------------------------- attribution bar
def attr_bar(att: Any, wide: bool = False) -> str:
    """Stacked bar: factor-explained part vs stock-specific part of the day's move (|share| of total |parts|)."""
    if not isinstance(att, dict) or to_num(att.get("actual")) is None:
        return ""
    ex, ss, act = to_num(att.get("explained")), to_num(att.get("stock_specific")), to_num(att.get("actual"))
    if ex is None or ss is None:
        return na("attribution incomplete in relations.json")
    tot = abs(ex) + abs(ss) or 1.0
    byf = att.get("by_factor") or {}
    fparts = " · ".join(f"{k} {sig(v, 2)}%" for k, v in byf.items() if to_num(v) is not None)
    tip = (f"{att.get('date')}: actual {sig(act, 3)}% = factors {sig(ex, 2)}% ({fparts}) + stock-specific {sig(ss, 3)}%. "
           "Coefficient × that day's factor move: accounting split, not a cause.")
    fx = abs(ex) / tot * 100
    return (f'<span class="ab{" ab-w" if wide else ""}" title="{esc(tip)}"><span class="ab-bar">'
            f'<i class="ab-f {"p" if ex >= 0 else "n"}" style="width:{fx:.0f}%"></i>'
            f'<i class="ab-s {"p" if ss >= 0 else "n"}" style="width:{100 - fx:.0f}%"></i></span>'
            f'<small class="n">{100 - fx:.0f}% own</small></span>')
