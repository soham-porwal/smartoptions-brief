"""Combined A+B ticker table and the per-ticker drawer templates."""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from . import content as C
from .fmt import (DASH, chip, esc, is_num, link, na, num, parse_date, parse_dt, sig, signed, to_num, ts_html)
from .hero import attr_bar, score_defs
from .sections import FACTORS, SAM_LABEL, SHOCK, TOP_OPP_N, _d, ref_date, tchip, unavailable

GROUP_LABELS = [("price", "Price"), ("fund", "Fundamentals"), ("sam", "SmartOptions snapshot"),
                ("sens", "Macro sensitivity"), ("opt", "Options")]
SAM_KEYS = {  # display field -> candidate keys in equities.tickers[t].sam (first present wins)
    "opp": ("opportunity_score", "opportunity", "opp_score", "comp_score"),
    "quality": ("quality", "quality_tier", "quality_score"),
    "trend": ("trendscore", "trend_score", "trend"),
    "risk": ("risk", "risk_tier"),
    "flags": ("risk_flags", "flags"),
}


def sam_get(sam: Any, field: str) -> Any:
    if not isinstance(sam, dict):
        return None
    for k in SAM_KEYS[field]:
        if k in sam and sam[k] not in (None, ""):
            v = sam[k]
            if isinstance(v, list):
                v = ", ".join(str(x.get("flag", x)) if isinstance(x, dict) else str(x) for x in v) or None
            return v
    return None


CORP_ACTION_RATIO = 0.5  # lane E flag: current price differs from Sam's snapshot price by more than 50%


def corp_check(tk: dict) -> str:
    """Chip when price now vs Sam's snapshot price differs > 50% (possible split / spin-off; not verified)."""
    sam = tk.get("sam") if isinstance(tk.get("sam"), dict) else {}
    now, then = to_num(tk.get("price")), to_num(sam.get("price"))
    if now is None or then is None or then <= 0 or abs(now / then - 1) <= CORP_ACTION_RATIO:
        return ""
    tip = f"price now {now:.2f} vs {then:.2f} in {sam.get('snapshot_label') or SAM_LABEL}: >50% apart. Check for a split or spin-off before comparing."
    return f'<span class="chip st-stale cact" title="{esc(tip)}">check: corporate action?</span>'


def sam_asof(eq: dict | None) -> str:
    for tk in (_d(eq, "tickers") or {}).values():
        s = (tk or {}).get("sam")
        if isinstance(s, dict):
            for k in ("asof", "snapshot_asof", "as_of"):
                if s.get(k):
                    return str(s[k])[:10]
    return str(_d(eq, "sam_asof") or "2026-07-25")[:10]


STATUS_ALIAS = {"chg_1d_pct": "chg", "chg_5d_pct": "chg", "chg_1m_pct": "chg"}  # equities stage keys one status for all % changes


def _st(tk: dict, field: str) -> str | None:
    st = tk.get("status") or {}
    return st.get(field, st.get(STATUS_ALIAS.get(field, field)))


def _reason(tk: dict, field: str, default: str = "not provided by equities stage") -> str:
    st = _st(tk, field)
    pv = tk.get("provenance") or {}
    prov = pv.get(field, pv.get(STATUS_ALIAS.get(field, field)))
    extra = ""
    if isinstance(prov, dict) and (prov.get("reason") or prov.get("note")):
        default = str(prov.get("reason") or prov.get("note"))
    elif isinstance(prov, str):
        extra = f" ({prov})"
    return f"{st or 'missing'}: {default}{extra}"


def iv_pct(atm: Any) -> float | None:
    """ATM IV in percent. The equities stage stores percent (options.py scales yfinance's fraction by 100);
    an explicit unit field, if ever added, wins."""
    if not isinstance(atm, dict):
        return None
    v = to_num(atm.get("iv"))
    if v is None:
        return None
    unit = str(atm.get("unit") or "").lower()
    if unit in ("fraction", "decimal"):
        return v * 100
    return v


def range_pos(tk: dict) -> float | None:
    r = tk.get("range_52w")
    if not isinstance(r, dict):
        return None
    lo, hi, px = to_num(r.get("low")), to_num(r.get("high")), to_num(tk.get("price"))
    if lo is not None and hi is not None and px is not None and hi > lo:
        return max(0.0, min(1.0, (px - lo) / (hi - lo)))
    p = to_num(r.get("pctile"))
    if p is not None:
        return p / 100 if p > 1 else p
    return None


def spans_earnings(tk: dict) -> bool | None:
    atm = tk.get("atm_iv")
    if isinstance(atm, dict) and isinstance(atm.get("spans_earnings"), bool):
        return atm["spans_earnings"]
    ed = parse_date(_d(tk, "earnings", "date"))
    ex = parse_date(atm.get("expiry")) if isinstance(atm, dict) else None
    if ed is None or ex is None:
        return None
    return ex >= ed


def coef_scale(f: str, units: Any) -> tuple[float, str] | None:
    """(multiplier turning a coefficient into '% stock move for the stated shock', shock text), or None if units unknown.
    Accepts relations.factor_units strings ('% per 1 bp 10y', '% per 1% SPY', '% per 1 VIX pt') or the
    sample form units={'ret': 'pct'|'decimal', factor: 'pct'|'decimal'|'bp'|'pt'}."""
    if not isinstance(units, dict):
        return None
    u = units.get(f)
    if isinstance(u, str) and u.startswith("% per 1"):
        rest = u[len("% per 1"):].strip()
        if rest.startswith("bp"):
            return 10.0, "+10 bp"
        if rest.startswith("%"):
            return 1.0, "+1%"
        if rest.endswith("pt") or "point" in rest:
            return 1.0, "+1 point"
        return None
    if units.get("ret") in ("pct", "decimal") and u in SHOCK:
        shock, txt = SHOCK[u]
        return shock * (100 if units["ret"] == "decimal" else 1), txt
    return None


def plain_reading(f: str, coef: Any, t: Any, units: dict | None) -> str:
    c, tv = to_num(coef), to_num(t)
    if c is None or tv is None:
        return "No estimate."
    if abs(tv) <= 2:
        return "Not distinguishable from zero at the |t| > 2 cut; no reading given."
    scale = coef_scale(f, units)
    if scale is None:
        return "Units not declared by the relations stage, so no plain-English size is given; raw coefficient shown."
    mult, shock_txt = scale
    eff = c * mult
    name = FACTORS.get(f, (f, f))[1]
    held = "holding the other factors fixed" if f == "spy" else "holding SPY and the other factors fixed"
    return (f"Historically, a {shock_txt} move in the {name} coincided with about {sig(eff, 2)}% in this stock on "
            f"the same day, {held}. Association, not causation.")


def _flags(t: str, tk: dict, movers: dict, rel_t: dict | None, top_opp: set) -> str:
    f = []
    if t in (movers.get("up") or []):
        f.append("up")
    if t in (movers.get("down") or []):
        f.append("down")
    if t in (movers.get("unusual_volume") or []):
        f.append("uvol")
    if t in top_opp:
        f.append("topopp")
    du = to_num(_d(tk, "earnings", "days_until"))
    if du is not None and 0 <= du <= 7:
        f.append("earn7")
    tv = to_num(_d(rel_t, "t", "us10y_bps"))
    if tv is not None and abs(tv) > 2:
        f.append("rate")
    return " ".join(f)


def _td(group: str, html_: str, sortv: Any = None, cls: str = "") -> str:
    sv = "" if sortv is None else f' data-v="{esc(sortv)}"'
    c = f"g-{group} {cls}".strip()
    return f'<td class="{c}"{sv}>{html_}</td>'


def table(data: dict, reasons: dict) -> str:
    eq = data.get("equities")
    if not eq:
        return unavailable("Ticker table (sets A and B)", reasons.get("equities"))
    tickers = eq.get("tickers") or {}
    if not tickers:
        return '<p class="muted">equities.json lists no tickers.</p>'
    rel = data.get("relations") or {}
    rel_t = rel.get("tickers") or {}
    factors = [f for f in (rel.get("factors") or list(FACTORS)) if isinstance(f, str)]
    movers = eq.get("movers") or {}
    asof = sam_asof(eq)
    opp = sorted(((to_num(sam_get(tk.get("sam"), "opp")), t) for t, tk in tickers.items()
                  if to_num(sam_get((tk or {}).get("sam"), "opp")) is not None), reverse=True)
    top_opp = {t for _, t in opp[:TOP_OPP_N]}
    rel_reason = reasons.get("relations") or "no regression for this ticker in relations.json"
    defs = score_defs()

    def sd(k: str) -> str:
        return f"{defs.get(k, k)} ({SAM_LABEL} {asof}, read-only)"
    attr = rel.get("attribution") if isinstance(rel.get("attribution"), dict) else {}

    head = ['<th class="g-id sticky" data-k="0" data-type="s">Ticker</th>', '<th class="g-id" data-type="s">Set</th>',
            '<th class="g-id sect" data-type="s">Sector</th>',
            '<th class="g-price" data-type="n">Price</th>', '<th class="g-price" data-type="n">1d %</th>',
            '<th class="g-price" data-type="n" title="share of the latest move not explained by the 5 macro factors (movers only); bar = factor part vs stock-specific part">Own move</th>',
            '<th class="g-price" data-type="n">5d %</th>', '<th class="g-price" data-type="n">1m %</th>',
            '<th class="g-price" data-type="n" title="volume / 20-day average volume">Vol / 20d</th>',
            '<th class="g-fund" data-type="n">P/E t</th>', '<th class="g-fund" data-type="n">P/E f</th>',
            '<th class="g-fund" data-type="n">PEG</th>',
            '<th class="g-fund" data-type="n" title="position of price inside the 52-week low-high range">52w range</th>',
            '<th class="g-fund" data-type="n" title="days until next earnings">Earnings</th>',
            '<th class="g-fund" data-type="n" title="consensus analyst rating; sorted by target upside">Analyst</th>',
            f'<th class="g-sam" data-type="n" title="{esc(sd("Opportunity Score"))}">Opp</th>',
            f'<th class="g-sam" data-type="s" title="{esc(sd("Quality score/tier"))}">Quality</th>',
            f'<th class="g-sam" data-type="n" title="{esc(sd("TrendScore"))}">Trend</th>',
            f'<th class="g-sam" data-type="s" title="{esc(sd("Risk level"))}">Risk</th>',
            f'<th class="g-sam" data-type="s" title="{esc(sd("Risk Flags"))}">Flags</th>']
    for f in factors:
        head.append(f'<th class="g-sens" data-type="n" title="coefficient on {esc(FACTORS.get(f, (f, f))[1])}; '
                    f'sorted by t-stat; coloured only when |t| &gt; 2">{esc(FACTORS.get(f, (f,))[0])} β (t)</th>')
    head.append('<th class="g-sens" data-type="n">R²</th>')
    head += ['<th class="g-opt" data-type="n">ATM IV</th>', '<th class="g-opt" data-type="s" title="does the IV expiry fall on or after the next earnings date">Spans earn.</th>']

    rows = []
    for i, (t, tk) in enumerate(tickers.items()):
        tk = tk or {}
        sets = [s for s in (tk.get("sets") or []) if s in ("A", "B")]
        badge = "+".join(sets) if sets else "?"
        r = rel_t.get(t)
        chg1 = to_num(tk.get("chg_1d_pct"))
        rank = (0 if "A" in sets else 1, -chg1 if chg1 is not None else 1e9, t)
        cells = [f'<th scope="row" class="g-id sticky tkcell" data-v="{esc(t)}"><button type="button" class="tklink" data-t="{esc(t)}">{esc(t)}</button>'
                 f'<span class="nm">{esc(tk.get("name") or "")}</span>{corp_check(tk)}</th>',
                 _td("id", f'<span class="set set-{badge.replace("+", "")}">{esc(badge)}</span>', badge),
                 _td("id", esc(tk.get("sector")) if tk.get("sector") else na("no sector"), tk.get("sector") or "", "sect")]
        cells.append(_td("price", num(tk.get("price"), 2, _reason(tk, "price")), to_num(tk.get("price"))))
        for k in ("chg_1d_pct", "chg_5d_pct", "chg_1m_pct"):
            cells.append(_td("price", signed(tk.get(k), 2, "%", _reason(tk, k)), to_num(tk.get(k))))
            if k == "chg_1d_pct":
                at = attr.get(t)
                ab = attr_bar(at)
                if ab:
                    ex, ss = to_num(at.get("explained")), to_num(at.get("stock_specific"))
                    share = abs(ss) / ((abs(ex) + abs(ss)) or 1.0) if ex is not None and ss is not None else None
                    cells.append(_td("price", ab, share))
                else:
                    cells.append(_td("price", na("move split computed for set A movers only"), None))
        vr = to_num(tk.get("vol_ratio_20d"))
        cells.append(_td("price", num(vr, 2, _reason(tk, "vol_ratio_20d"), "×"), vr, "hot" if t in (movers.get("unusual_volume") or []) else ""))
        cells.append(_td("fund", num(tk.get("pe_trailing"), 1, _reason(tk, "pe_trailing")), to_num(tk.get("pe_trailing"))))
        cells.append(_td("fund", num(tk.get("pe_forward"), 1, _reason(tk, "pe_forward")), to_num(tk.get("pe_forward"))))
        peg = tk.get("peg") if isinstance(tk.get("peg"), dict) else {}
        pv = to_num(peg.get("value"))
        pm = peg.get("method")
        pegh = num(pv, 2, _reason(tk, "peg")) + (f' <small class="muted" title="{esc(peg.get("inputs") or "")}">{esc(pm)}</small>' if pv is not None and pm else "")
        cells.append(_td("fund", pegh, pv))
        rp = range_pos(tk)
        rg = tk.get("range_52w") if isinstance(tk.get("range_52w"), dict) else {}
        if rp is not None:
            rh = (f'<span class="rbar" title="52w low {esc(sig(rg.get("low"), 4))} · high {esc(sig(rg.get("high"), 4))} · '
                  f'position {rp * 100:.0f}%"><i style="left:{rp * 100:.1f}%"></i></span>')
        else:
            rh = na(_reason(tk, "range_52w"))
        cells.append(_td("fund", rh, rp))
        e = tk.get("earnings") if isinstance(tk.get("earnings"), dict) else {}
        du = to_num(e.get("days_until"))
        if e.get("date"):
            eh = (f'<span class="n">{esc(e["date"])}</span> {esc(e.get("time") or "")}'
                  + (f' <span class="{"earn7" if 0 <= du <= 7 else "muted"}">{int(du)}d</span>' if du is not None else ""))
        else:
            eh = na(_reason(tk, "earnings", "no confirmed earnings date"))
        cells.append(_td("fund", eh, du))
        a = tk.get("analyst") if isinstance(tk.get("analyst"), dict) else None
        if a and (a.get("rating") or to_num(a.get("upside_pct")) is not None):
            ttl = f"mean {sig(a.get('mean'), 3) or DASH} · n {int(to_num(a.get('n'))) if to_num(a.get('n')) is not None else DASH} · target {sig(a.get('target_mean'), 5) or DASH}"
            ah = f'<span title="{esc(ttl)}">{esc(a.get("rating") or DASH)} {signed(a.get("upside_pct"), 1, "%", "no target", colour=False)}</span>'
            cells.append(_td("fund", ah, to_num(a.get("upside_pct"))))
        else:
            cells.append(_td("fund", na(_reason(tk, "analyst")), None))
        sam = tk.get("sam")
        sreason = f"not in Sam's universe (set B) — no {SAM_LABEL} value" if "B" not in sets else f"not present in {SAM_LABEL}"
        for fld, isnum in (("opp", True), ("quality", False), ("trend", True), ("risk", False), ("flags", False)):
            v = sam_get(sam, fld)
            if v is None:
                cells.append(_td("sam", na(sreason), None))
            elif isnum and to_num(v) is not None:
                cells.append(_td("sam", num(v, 1 if fld == "opp" else 0), to_num(v)))
            else:
                cells.append(_td("sam", f'<span class="small">{esc(v)}</span>', str(v)))
        for f in factors:
            c, tv = to_num(_d(r, "coef", f)), to_num(_d(r, "t", f))
            if c is None or tv is None:
                cells.append(_td("sens", na(rel_reason), None))
                continue
            heat = (" heat-pos" if c > 0 else " heat-neg") if abs(tv) > 2 else ""
            cells.append(_td("sens", f'<span class="n">{sig(c, 2)}</span> <small class="t">({sig(tv, 2)})</small>', tv, heat.strip()))
        r2 = to_num(_d(r, "r2"))
        cells.append(_td("sens", num(r2, 2, rel_reason), r2))
        ivp = iv_pct(tk.get("atm_iv"))
        cells.append(_td("opt", num(ivp, 1, _reason(tk, "atm_iv"), "%"), ivp))
        sp = spans_earnings(tk)
        cells.append(_td("opt", ("yes" if sp else "no") if sp is not None else na("needs both IV expiry and earnings date"),
                         "" if sp is None else ("1" if sp else "0")))
        search = f"{t} {tk.get('name') or ''} {tk.get('sector') or ''}".lower()
        cdat = "".join(f' data-c-{esc(f)}="{to_num(_d(r, "coef", f))}"' for f in factors if to_num(_d(r, "coef", f)) is not None)
        rows.append((rank, f'<tr data-t="{esc(t)}" data-q="{esc(search)}" data-sec="{esc(tk.get("sector") or "")}"{cdat} data-f="{_flags(t, tk, movers, r, top_opp)}">'
                     + "".join(cells) + "</tr>"))
    # default order: set A first, then by 1-day change descending, then ticker
    rows.sort(key=lambda x: x[0])
    body = "".join(h for _, h in rows)
    toggles = "".join(f'<label class="tg"><input type="checkbox" data-g="{g}" checked> {esc(lbl)}</label>' for g, lbl in GROUP_LABELS)
    quick = [("all", "All"), ("up", "Movers up"), ("down", "Movers down"), ("uvol", "Unusual volume"),
             ("topopp", f"Sam's top {TOP_OPP_N} Opportunity"), ("earn7", "Earnings ≤ 7d"), ("rate", "High rate sensitivity")]
    qb = "".join(f'<button type="button" class="qf{" on" if k == "all" else ""}" data-qf="{k}">{esc(l)}</button>' for k, l in quick)
    n_a = sum(1 for tk in tickers.values() if "A" in ((tk or {}).get("sets") or []))
    n_b = sum(1 for tk in tickers.values() if "B" in ((tk or {}).get("sets") or []))
    return f"""<div class="tctl">
 <input type="search" id="tq" placeholder="Filter ticker, name or sector" aria-label="Filter table">
 <div class="qfs" role="group" aria-label="Quick filters">{qb}</div>
 <div class="tgs" role="group" aria-label="Column groups">{toggles}</div>
 <div id="hmband" class="hmband" hidden>heatmap filter: <b></b> <button type="button" class="btn" id="hmclear">clear</button></div>
 <div class="muted small"><span id="tcount">{len(rows)}</span> / {len(rows)} rows · A {n_a} · B {n_b} ·
 {SAM_LABEL} {esc(asof)}, read-only · click a row</div>
</div>
<div class="twrap" id="twrap"><table id="tt" class="tt"><thead><tr>{"".join(head)}</tr></thead><tbody>{body}</tbody></table></div>"""


# ---------------------------------------------------------------- drawer templates
def _pv(prov: dict, field: str) -> Any:
    return prov.get(field, prov.get(STATUS_ALIAS.get(field, field)))


def _prov(p: Any) -> str:
    if isinstance(p, dict):
        bits = []
        for k, v in p.items():
            if v in (None, ""):
                continue
            if isinstance(v, str) and v.startswith(("http://", "https://")):
                bits.append(link(v, k))
            elif isinstance(v, (dict, list)):
                bits.append(f"{esc(k)}: {esc(str(v)[:200])}")
            else:
                bits.append(f"{esc(k)}: {esc(v)}")
        return " · ".join(bits) or na("no provenance recorded")
    if isinstance(p, str) and p:
        return link(p, "source") if p.startswith("http") else esc(p)
    return '<span class="muted">no provenance recorded</span>'


def _explain(v: Any, depth: int = 0) -> str:
    """Sam's EXPLAIN rendered verbatim: keys and strings as published, nested structure kept."""
    if depth > 6:
        return esc(str(v))
    if isinstance(v, dict):
        if set(v) <= {"val", "desc"} or set(v) <= {"flag", "desc"}:
            head = v.get("val", v.get("flag"))
            hv = esc(head) if head not in (None, "") else na("blank in Sam's snapshot")
            return f'<span class="xv">{hv}</span> <span class="xd">{esc(v.get("desc"))}</span>'
        return "<dl class='x'>" + "".join(f"<dt>{esc(k)}</dt><dd>{_explain(x, depth + 1)}</dd>" for k, x in v.items()) + "</dl>"
    if isinstance(v, list):
        return "<ul class='x'>" + "".join(f"<li>{_explain(x, depth + 1)}</li>" for x in v) + "</ul>"
    if v in (None, ""):
        return na("blank in Sam's snapshot")
    return esc(v)


def drawers(data: dict, reasons: dict) -> str:
    eq = data.get("equities")
    if not eq:
        return ""
    rel = data.get("relations") or {}
    units = rel.get("factor_units") or rel.get("units")
    factors = [f for f in (rel.get("factors") or list(FACTORS)) if isinstance(f, str)]
    window = rel.get("window") or "window not stated"
    win_n = None
    try:
        win_n = int(str(window).split()[0])
    except (ValueError, IndexError):
        pass
    sectors = rel.get("sectors") or {}
    ref = ref_date(data)
    events = []
    for ev in _d(data.get("calendar"), "events") or []:
        dt = parse_dt(ev.get("scheduled_et"))
        if dt is not None and ref <= dt.date() <= ref + timedelta(days=30):
            events.append((dt, ev))
    events.sort(key=lambda x: x[0])
    ins = rel.get("insights") or []
    asof = sam_asof(eq)
    out = []
    for t, tk in (eq.get("tickers") or {}).items():
        tk = tk or {}
        r = (rel.get("tickers") or {}).get(t)
        sets = "+".join(s for s in (tk.get("sets") or []) if s in ("A", "B")) or "?"
        prov = tk.get("provenance") or {}

        def row(label, html_, field):
            return (f"<tr><th>{esc(label)}</th><td>{html_}</td><td>{chip(_st(tk, field)) if _st(tk, field) else ''}</td>"
                    f"<td class='prov'>{_prov(_pv(prov, field))}</td></tr>")
        peg = tk.get("peg") if isinstance(tk.get("peg"), dict) else {}
        e = tk.get("earnings") if isinstance(tk.get("earnings"), dict) else {}
        a = tk.get("analyst") if isinstance(tk.get("analyst"), dict) else {}
        rg = tk.get("range_52w") if isinstance(tk.get("range_52w"), dict) else {}
        atm = tk.get("atm_iv") if isinstance(tk.get("atm_iv"), dict) else {}
        ivp = iv_pct(atm or None)
        sp = spans_earnings(tk)
        fields = "".join([
            row("Price", num(tk.get("price"), 2, _reason(tk, "price")), "price"),
            row("Change 1d / 5d / 1m", " / ".join(signed(tk.get(k), 2, "%", _reason(tk, k)) for k in ("chg_1d_pct", "chg_5d_pct", "chg_1m_pct")), "chg_1d_pct"),
            row("Volume vs 20d avg", num(tk.get("vol_ratio_20d"), 2, _reason(tk, "vol_ratio_20d"), "×"), "vol_ratio_20d"),
            row("52-week low / high", f'{num(rg.get("low"), 2, _reason(tk, "range_52w"))} / {num(rg.get("high"), 2, _reason(tk, "range_52w"))}', "range_52w"),
            row("P/E trailing / forward", f'{num(tk.get("pe_trailing"), 1, _reason(tk, "pe_trailing"))} / {num(tk.get("pe_forward"), 1, _reason(tk, "pe_forward"))}', "pe_trailing"),
            row("PEG", num(peg.get("value"), 2, _reason(tk, "peg")) + (f' <span class="muted">method: {esc(peg.get("method"))}; inputs: {esc(peg.get("inputs") if not isinstance(peg.get("inputs"), dict) else ", ".join(f"{k}={v}" for k, v in peg["inputs"].items()))}</span>' if peg.get("method") else ""), "peg"),
            row("Next earnings", (f'{esc(e.get("date"))} {esc(e.get("time") or "time not confirmed")}'
                                  + (f' · in {int(to_num(e.get("days_until")))} days' if to_num(e.get("days_until")) is not None else "")
                                  + (f' · source: {esc(e.get("source"))}' if e.get("source") else "")) if e.get("date") else na(_reason(tk, "earnings", "no confirmed earnings date")), "earnings"),
            row("Analysts", (f'{esc(a.get("rating") or DASH)} · mean {esc(sig(a.get("mean"), 3) or DASH)} · n {esc(int(to_num(a.get("n"))) if to_num(a.get("n")) is not None else DASH)} · '
                             f'target {num(a.get("target_mean"), 2, "no target")} ({signed(a.get("upside_pct"), 1, "%", "no target", colour=False)})') if a else na(_reason(tk, "analyst")), "analyst"),
            row("Beta (provider)", num(tk.get("beta_provider"), 2, _reason(tk, "beta_provider")), "beta_provider"),
            row("ATM implied vol", (num(ivp, 1, "", "%") + f' · expiry {esc(atm.get("expiry") or DASH)} · spans earnings: {"yes" if sp else "no" if sp is not None else "unknown (needs an earnings date)"}'
                                    + (f' · source: {esc(atm.get("source"))}' if atm.get("source") else "")) if ivp is not None else na(_reason(tk, "atm_iv")), "atm_iv"),
        ])
        # sensitivities
        if r:
            n = to_num(r.get("n"))
            short = f' <span class="warn">fewer sessions than the window (n={int(n)})</span>' if n is not None and win_n and n < win_n else ""
            sec = sectors.get(tk.get("sector") or "") or {}
            srows = []
            for f in factors:
                c, tv = to_num(_d(r, "coef", f)), to_num(_d(r, "t", f))
                med = to_num(_d(sec, "median_coef", f))
                heat = (" heat-pos" if (c or 0) > 0 else " heat-neg") if tv is not None and abs(tv) > 2 else ""
                srows.append(f"<tr><th>{esc(FACTORS.get(f, (f, f))[1])}</th><td class='n{heat}'>{esc(sig(c, 3) or DASH)}</td>"
                             f"<td class='n'>{esc(sig(tv, 2) or DASH)}</td><td class='n muted'>{esc(sig(med, 3) or DASH)}</td>"
                             f"<td class='rd'>{esc(plain_reading(f, c, tv, units))}</td></tr>")
            sens = (f'<p class="muted small">OLS over {esc(window)} · n {esc(int(n) if n is not None else DASH)} · R² {esc(sig(r.get("r2"), 2) or DASH)}{short}. '
                    f'Sector median from {esc(sec.get("n") if sec.get("n") is not None else DASH)} {esc(tk.get("sector") or "")} names.</p>'
                    f'<table class="mini sens"><tr><th>factor</th><th>coef</th><th>t</th><th>sector median</th><th>reading</th></tr>{"".join(srows)}</table>')
        else:
            sens = f'<p>{na()} {esc(reasons.get("relations") or "No regression for this ticker in relations.json (insufficient history or not computed).")}</p>'
        att = (rel.get("attribution") or {}).get(t)
        if isinstance(att, dict) and to_num(att.get("actual")) is not None:
            byf = att.get("by_factor") or {}
            parts = " · ".join(f"{FACTORS.get(k, (k,))[0]} {signed(v, 2, '%', colour=False)}" for k, v in byf.items())
            sens += (f'<h4>Move split for {esc(att.get("date"))}</h4>{attr_bar(att, wide=True)}<p class="small">Actual {signed(att.get("actual"), 2)} = '
                     f'factors {signed(att.get("explained"), 2, "%", colour=False)} ({parts}) + stock-specific '
                     f'{signed(att.get("stock_specific"), 2, "%", colour=False)}. Coefficient times that day&#39;s factor move: an accounting split, not a cause.</p>')
        # events
        sig_f = {f for f in factors if to_num(_d(r, "t", f)) is not None and abs(to_num(_d(r, "t", f))) > 2}
        evl = []
        if e.get("date"):
            evl.append(f"<li><b>Earnings</b> {esc(e.get('date'))} {esc(e.get('time') or '')}</li>")
        n_other = 0
        for dt, ev in events:
            fct = C.EVENT_FACTOR.get(ev.get("type"))
            if fct in sig_f:
                evl.append(f"<li>{ts_html(dt)} <b>{esc(ev.get('type'))}</b> {esc(ev.get('title'))} "
                           f"<span class='tag hot'>linked: |t| &gt; 2 on {esc(FACTORS.get(fct, (fct,))[0])}</span></li>")
            else:
                n_other += 1
        if n_other:
            evl.append(f'<li class="muted">{n_other} other dated macro release(s) in the next 30 days: see <a href="#cal" class="close-dr">Calendar</a>.</li>')
        mine = [c for c in ins if any(x.get("ticker") == t for x in c.get("exposed") or [])]
        insl = "".join(f'<li><a href="#ins-{esc(c.get("id"))}" class="close-dr">{esc(c.get("title"))}</a></li>' for c in mine)
        sam = tk.get("sam")
        if isinstance(sam, dict):
            simple = "".join(f"<tr><th>{esc(k)}</th><td>{esc(v) if v not in (None, '') else na('blank in snapshot')}</td></tr>"
                             for k, v in sam.items() if k != "explain" and not isinstance(v, (dict, list)))
            ex = sam.get("explain")
            samh = (f'<p class="muted small">{SAM_LABEL} as of {esc(asof)} · read-only, copied as published, not recomputed.</p>'
                    f'<table class="mini">{simple}</table>'
                    + (f'<h4>EXPLAIN (verbatim)</h4><div class="explain">{_explain(ex)}</div>' if ex else f'<p>{na()} No EXPLAIN entry for {esc(t)} in the snapshot.</p>'))
        else:
            samh = f'<p class="muted">Not in Sam\'s published universe (set B), so no {SAM_LABEL} values.</p>'
        out.append(f"""<template id="dr-{esc(t)}"><div class="dr-h"><h2>{esc(t)} <span class="set set-{sets.replace('+', '')}">{esc(sets)}</span></h2>
<div class="muted">{esc(tk.get("name") or "")} · {esc(tk.get("sector") or "sector unknown")}</div></div>
<h3>Market and fundamentals</h3><table class="mini fields"><tr><th>field</th><th>value</th><th>status</th><th>provenance</th></tr>{fields}</table>
<h3>Macro sensitivities</h3>{sens}
<h3>Upcoming events (30 days)</h3>{'<ul class="evl">' + "".join(evl) + '</ul>' if evl else '<p class="muted">No dated events in calendar.json for the next 30 days.</p>'}
{f'<h3>In today\'s insights</h3><ul>{insl}</ul>' if insl else ''}
<h3>{SAM_LABEL}</h3>{samh}</template>""")
    return "".join(out)
