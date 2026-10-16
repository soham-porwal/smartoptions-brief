"""Section builders. Each takes the loaded inputs (any may be None) and returns an HTML string.
A None input renders as an explicit "unavailable" block with the reason, never a crash."""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta
from typing import Any

from . import content as C
from .fmt import (DASH, val, val_decimals, ET, chip, esc, et_text, is_num, link, na, num, parse_date, parse_dt, sig, signed,
                  sparkline, to_num, ts_html)

GROUPS = [("inflation", "Inflation"), ("labor", "Labor"), ("growth", "Growth"), ("policy", "Policy"),
          ("curve", "Rates & curve"), ("cross_asset", "Cross-asset"), ("credit_funding", "Credit & funding"),
          ("volatility", "Volatility")]
FACTORS = {  # key -> (short label, long name)
    "spy": ("SPY", "S&P 500 (SPY)"),
    "us10y_bps": ("10y", "10-year Treasury yield"),
    "dxy": ("DXY", "dollar index (DXY)"),
    "wti": ("WTI", "WTI crude"),
    "vix": ("VIX", "VIX"),
}
SHOCK = {"pct": (1.0, "+1%"), "decimal": (0.01, "+1%"), "bp": (10.0, "+10 bp"), "pt": (1.0, "+1 point")}
SAM_LABEL = "SmartOptions snapshot"
TOP_OPP_N = 25


def unavailable(name: str, reason: str | None) -> str:
    return (f'<div class="unavail" role="status"><strong>{esc(name)} unavailable.</strong> '
            f'{esc(reason or "input not provided")}</div>')


def _d(obj: Any, *keys: str) -> Any:
    for k in keys:
        if not isinstance(obj, dict):
            return None
        obj = obj.get(k)
    return obj


def ref_date(data: dict) -> date:
    """Calendar reference day = the day the page is generated (ET); the as-of session is a past close."""
    now = data.get("_now")
    if isinstance(now, datetime):
        return now.astimezone(ET).date()
    d = parse_date(_d(data.get("equities"), "asof_session"))
    return d or datetime.now(ET).date()


# ---------------------------------------------------------------- header + freshness
def freshness(data: dict, reasons: dict) -> dict:
    out = {"macro": {s: 0 for s in ("ok", "stale", "missing", "error")}, "equity": {}, "bad_macro": [], "inputs": {}}
    for name in ("macro", "calendar", "equities", "relations"):
        out["inputs"][name] = data.get(name) is not None
    m = data.get("macro")
    if m:
        for g, obs in (m.get("groups") or {}).items():
            for o in obs or []:
                s = o.get("status") if o.get("status") in out["macro"] else "missing"
                out["macro"][s] += 1
                if s != "ok":
                    out["bad_macro"].append((g, o))
    e = data.get("equities")
    if e:
        for t, tk in (e.get("tickers") or {}).items():
            for f, s in ((tk or {}).get("status") or {}).items():
                ss = s if s in ("ok", "stale", "missing", "error") else "missing"
                out["equity"].setdefault(f, {"ok": 0, "stale": 0, "missing": 0, "error": 0})[ss] += 1
    return out


def header(data: dict, reasons: dict, rendered_at: datetime) -> str:
    fr = freshness(data, reasons)
    eq = data.get("equities") or {}
    asof = eq.get("asof_session")
    m = fr["macro"]
    mac = " ".join(chip(s, f"{m[s]} {s}") for s in ("ok", "stale", "missing", "error") if m[s]) or chip("missing", "no macro data")
    eqt = {s: sum(v[s] for v in fr["equity"].values()) for s in ("ok", "stale", "missing", "error")}
    eqc = " ".join(chip(s, f"{eqt[s]} {s}") for s in eqt if eqt[s]) or chip("missing", "no equity data")
    n_in = sum(fr["inputs"].values())
    inp = chip("ok" if n_in == 4 else ("stale" if n_in else "error"), f"{n_in}/4 inputs")

    rows = []
    for name, ok in fr["inputs"].items():
        gen = _d(data.get(name), "generated_at")
        rows.append(f"<tr><td>{esc(name)}.json</td><td>{chip('ok' if ok else 'missing', 'loaded' if ok else 'unavailable')}</td>"
                    f"<td>{ts_html(parse_dt(gen), reason='no generated_at') if ok else esc(reasons.get(name, ''))}</td></tr>")
    bad = "".join(
        f"<tr><td>{esc(g)}</td><td>{esc(o.get('label') or o.get('id'))}</td><td>{chip(o.get('status'))}</td>"
        f"<td>{esc(o.get('note') or 'no note from macro stage')}</td></tr>" for g, o in fr["bad_macro"])
    eqrows = "".join(
        f"<tr><td>{esc(f)}</td>" + "".join(f"<td class='n'>{v[s]}</td>" for s in ("ok", "stale", "missing", "error")) + "</tr>"
        for f, v in sorted(fr["equity"].items()) if any(v[s] for s in ("stale", "missing", "error")))
    detail = (f'<details class="fresh"><summary>{inp} · macro {mac} · equity fields {eqc}</summary>'
              f'<div class="fresh-body"><h4>Inputs</h4><table class="mini"><tr><th>file</th><th>status</th><th>generated</th></tr>{"".join(rows)}</table>'
              + (f'<h4>Macro values not ok</h4><table class="mini"><tr><th>group</th><th>series</th><th>status</th><th>reason</th></tr>{bad}</table>' if bad else "<p>All macro values ok.</p>" if m["ok"] else "")
              + (f'<h4>Equity fields with gaps (count of tickers)</h4><table class="mini"><tr><th>field</th><th>ok</th><th>stale</th><th>missing</th><th>error</th></tr>{eqrows}</table>' if eqrows else "")
              + "</div></details>")
    asof_html = f'<b>{esc(asof)}</b>' if asof else na("equities.json unavailable: no as-of session")
    return f"""<header class="top">
 <div class="titlebar">
  <div><h1>SmartOptions Daily <span class="sep">·</span> Macro × Fundamentals</h1>
   <div class="meta">session <b>{asof_html}</b> · built {ts_html(rendered_at)}</div></div>
  <div class="tools"><a href="https://samsej.github.io/sp500-screener-dashboard/" target="_blank" rel="noopener noreferrer">Sam's screener</a>
   <button type="button" id="theme" class="btn" aria-label="Toggle light or dark theme">Theme</button></div>
 </div>
 <div class="hfoot">{detail}<span class="disc">Research only · not advice · associations, not causation</span></div>
</header>"""


# ---------------------------------------------------------------- calendar
def calendar(data: dict, reasons: dict) -> str:
    cal = data.get("calendar")
    if not cal:
        return unavailable("Event calendar", reasons.get("calendar"))
    ref = ref_date(data)
    up, recent, later, bad = [], [], [], []
    for ev in cal.get("events") or []:
        dt = parse_dt(ev.get("scheduled_et"))
        if dt is None:
            bad.append(ev)
            continue
        d = dt.astimezone(ET).date()
        if d < ref - timedelta(days=7):
            continue
        if d < ref or ev.get("status") == "released":
            recent.append((dt, ev))
        elif d <= ref + timedelta(days=7):
            up.append((dt, ev))
        else:
            later.append((dt, ev))

    def card(dt, ev, cls=""):
        st = ev.get("status") or "unknown"
        stc = "ok" if st == "released" else "stale" if st == "scheduled" else "missing"
        tags = " ".join(f'<span class="tag" title="risk type">{esc(t)}</span>' for t in ev.get("risk_tags") or [])
        nt = f' title="{esc(ev.get("note"))}"' if ev.get("note") else ""
        ni = '<span class="info" aria-hidden="true">i</span>' if ev.get("note") else ""
        return (f'<div class="ev {cls}"{nt}><div class="ev-h"><span class="ev-type">{esc(ev.get("type"))}{ni}</span>'
                f'{chip(stc, st)}</div><div class="ev-t">{esc(ev.get("title"))}</div>'
                f'<div class="ev-time">{ts_html(dt, countdown=True)}</div>'
                f'<div class="ev-f">{tags} {link(ev.get("source_url"), "source")}</div></div>')

    up.sort(key=lambda x: x[0]); recent.sort(key=lambda x: x[0], reverse=True); later.sort(key=lambda x: x[0])
    strip = "".join(card(*x) for x in up) or '<p class="muted">No releases in the next 7 days.</p>'
    rec = "".join(card(*x, cls="past") for x in recent)
    lat = "".join(f'<li>{ts_html(dt)} <b>{esc(ev.get("type"))}</b> {esc(ev.get("title"))} {link(ev.get("source_url"), "source")}</li>'
                  for dt, ev in later)
    notes = cal.get("notes")
    notes_html = ""
    if notes:
        items = notes if isinstance(notes, list) else [notes]
        notes_html = ('<details class="notes"><summary>calendar notes</summary><ul>'
                      + "".join(f"<li>{esc(n if isinstance(n, str) else str(n))}</li>" for n in items) + "</ul></details>")
    badhtml = f'<p class="muted">{len(bad)} event(s) skipped: no valid timezone-aware scheduled time.</p>' if bad else ""
    return (f'<div class="evgrid">{strip}</div>'
            + (f'<h3 class="sub">Last 7 days</h3><div class="evgrid">{rec}</div>' if rec else "")
            + (f'<details class="later"><summary>Days 8 to 30 · {len(later)} events</summary><ul>{lat}</ul></details>' if later else "")
            + badhtml + notes_html)


# ---------------------------------------------------------------- insights
def tchip(ticker: str, extra: str = "", tickers: dict | None = None) -> str:
    known = tickers is not None and ticker in tickers
    t = "" if known else ' title="not in this build\'s equity table"'
    return f'<button type="button" class="tk{"" if known else " tk-unk"}" data-t="{esc(ticker)}"{t}>{esc(ticker)}{extra}</button>'


def exposure_label(x: dict) -> str:
    f, c, tv = x.get("factor"), to_num(x.get("coef")), sig(x.get("t"), 2)
    if f in FACTORS:
        return f"{FACTORS[f][0]} t {tv}" if tv else FACTORS[f][0]
    if f == "atm_iv":
        return f"ATM IV {val(c)}%" if c is not None else "ATM IV"
    if f == "stock_specific":
        return f"own move {'+' if c and c > 0 else ''}{sig(c, 2)}%" if c is not None else "own move"
    if f == "earnings_days":
        return f"earnings in {int(c)}d" if c is not None else "earnings"
    return f"{f} {sig(c, 3) or ''}".strip()


def evidence_item(e: dict) -> str:
    v = e.get("value")
    if is_num(v):
        vh = f'{val(v)}{(" " + esc(e.get("unit"))) if e.get("unit") else ""}'
    elif isinstance(v, str) and v:
        vh = esc(v)
    else:
        vh = na("value missing in relations.json")
    st = e.get("status")
    sth = f" {chip(st)}" if st and st != "ok" else ""
    tip = f'{e.get("label") or ""}{" · period " + str(e.get("period")) if e.get("period") else ""}'
    src = f" {link(e.get('source_url'), 'src')}" if e.get("source_url") else ""
    return f'<li title="{esc(tip)}"><span class="lbl">{esc(e.get("label"))}</span> <b class="n">{vh}</b>{sth}{src}</li>'


def context_strip(rel: dict) -> str:
    """Sam's market regime + options-seller context computed by the relations stage (descriptive only)."""
    cards = []
    rg = rel.get("regime")
    if isinstance(rg, dict) and to_num(rg.get("score")) is not None:
        bits = []
        for k, cv in (rg.get("components") or {}).items():
            if isinstance(cv, dict):
                sc = cv.get("score")
                bits.append(f"{k}: {sig(sc, 3) if to_num(sc) is not None else 'n/a'} (w {sig(cv.get('weight'), 2) or '?'})")
        cards.append(f'<div class="mc" title="{esc(rg.get("method"))}"><div class="mc-h"><span class="mc-l">Market regime (Sam&#39;s method, partial inputs)</span></div>'
                     f'<div class="mc-v"><span class="big n">{val(rg.get("score"))}</span> <span class="unit">{esc(rg.get("tier"))}</span></div>'
                     f'<div class="mc-s">{sparkline(rg.get("history_partial"))}</div>'
                     f'<div class="note">{esc("; ".join(bits))}</div><div class="note">{esc(rg.get("history_note") or "")}</div></div>')
    vb = rel.get("vol_breadth")
    if isinstance(vb, dict):
        names = {"vrp": "Variance risk premium (VIX minus SPY 21d realized)", "term_ratio": "VIX / VIX3M term ratio",
                 "breadth_rsp_spy_20d": "Breadth: RSP minus SPY, 20 sessions"}
        for k, lbl in names.items():
            x = vb.get(k)
            if not isinstance(x, dict):
                continue
            v = to_num(x.get("value"))
            st = x.get("status") or ("ok" if v is not None else "missing")
            vh = f'<span class="big n">{val(v)}</span> <span class="unit">{esc(x.get("unit"))}</span>' if v is not None else na(f"{st}: not computed")
            cards.append(f'<div class="mc" title="{esc(vb.get("method"))}"><div class="mc-h"><span class="mc-l">{esc(lbl)}</span>{chip(st)}</div>'
                         f'<div class="mc-v">{vh}</div><div class="mc-s">{sparkline(x.get("history"))}</div></div>')
    if not cards:
        return ""
    return (f'<div class="ctx"><div class="mcgrid ctxgrid">{"".join(cards)}</div>'
            f'<p class="muted small">Descriptive context computed from the data on this page; hover a card for its method. No alarm thresholds are implied.</p></div>')


def insights(data: dict, reasons: dict) -> str:
    """Compact insight cards: numeric title, evidence chips, next event, exposed tickers. Prose lives in (i)."""
    from .hero import info, interactions
    rel = data.get("relations")
    if not rel:
        return unavailable("Insights", reasons.get("relations"))
    ins = rel.get("insights") or []
    tickers = _d(data.get("equities"), "tickers") or {}
    cards = []
    for c in ins:
        ev = "".join(evidence_item(e) for e in c.get("evidence") or [])
        nxt = []
        for x in c.get("watch") or []:
            ne = x.get("next_event")
            if ne and ne not in nxt:
                nxt.append(ne)
        ex = "".join(tchip(str(x.get("ticker")), f" <small>{esc(exposure_label(x))}</small>", tickers)
                     for x in (c.get("exposed") or [])[:6])
        more = max(0, len(c.get("exposed") or []) - 6)
        conf = c.get("confidence")
        confc = {"high": "ok", "medium": "stale", "low": "missing"}.get(conf, "missing")
        tip = " ".join(str(t) for t in (c.get("observation"), c.get("why")) if t)
        watch = "; ".join(str(x.get("metric")) for x in c.get("watch") or [] if x.get("metric"))
        if watch:
            tip += f" Watch: {watch}."
        pb = c.get("playbook")
        pbl = f'<a class="pbl" href="#pb-{esc(pb)}">playbook</a>' if pb else ""
        cards.append(f"""<article class="ins" id="ins-{esc(c.get("id"))}">
 <div class="ins-h"><h3>{esc(c.get("title"))}</h3>{info(tip)}{chip(confc, conf or "unstated", "confidence")}</div>
 {f'<ul class="evid">{ev}</ul>' if ev else ''}
 {f'<div class="nx">next <b>{esc(" · ".join(nxt[:2]))}</b></div>' if nxt else ''}
 {f'<div class="chips">{ex}{f"<small class=muted>+{more}</small>" if more else ""}</div>' if ex else ''}
 {f'<div class="ins-f">{pbl}</div>' if pbl else ''}
</article>""")
    grid = f'<div class="insgrid">{"".join(cards)}</div>' if cards else '<p class="muted">No insight cards this session.</p>'
    return interactions(data, reasons, tchip) + grid


# ---------------------------------------------------------------- macro
def _delta_unit(unit: str) -> str:
    u = (unit or "").strip()
    return "pp" if u.startswith("%") else u


def short_label(label: str) -> str:
    """Display-only shortening of long series labels; the full label stays in the row tooltip."""
    s = re.sub(r"\s*\([^)]*\)", "", label)
    for a, b in ((", not roll-adjusted", ""), (" front-month continuous", ""), ("COMEX ", ""), ("US Treasury ", "UST "),
                 (" daily change", " 1d chg"), ("excluding food and energy", "core")):
        s = s.replace(a, b)
    s = re.sub(r"(\d+)-session change", r"\1d chg", s)
    return re.sub(r"\s+", " ", s).strip() or label


def macro_card(o: dict) -> str:
    """One macro observation as a dense table row: label, value, change vs prior, sparkline, period, status, source."""
    from .hero import spark
    st = o.get("status")
    unit = o.get("unit") or ""
    reason = f"{st or 'missing'}: {o.get('note') or 'no value from macro stage'}"
    v = to_num(o.get("value"))
    vhtml = f'<b class="n">{val(v)}</b> <small class="unit">{esc(unit)}</small>' if v is not None else na(reason)
    p = to_num(o.get("prior"))
    if v is not None and p is not None:
        delta = signed(v - p, val_decimals(v, p), "", colour=False)
        dtip = f"vs prior {val(p)} {_delta_unit(unit)}"
    else:
        delta, dtip = na("no prior observation"), ""
    hover = (f"{o.get('label') or o.get('id')} | provider: {o.get('provider')} | series: {o.get('series')} | transform: {o.get('transform')} | "
             f"observation date: {o.get('date')} | retrieved: {o.get('retrieved_at')}"
             + (f" | note: {o['note']}" if o.get("note") else ""))
    stc = esc(st if st in ("ok", "stale", "missing", "error") else "missing")
    sth = "" if st == "ok" else chip(st, None, o.get("note"))
    return (f'<tr class="mc st-b-{stc}"><th scope="row" title="{esc(hover)}">{esc(short_label(str(o.get("label") or o.get("id"))))}{sth}</th>'
            f'<td class="mv">{vhtml}</td><td class="md" title="{esc(dtip)}">{delta}</td>'
            f'<td class="msp">{spark(o.get("history"), 84, 18, cls="spark mini")}</td>'
            f'<td class="mp">{esc(o.get("period")) if o.get("period") else na("no period")}</td>'
            f'<td class="ms">{link(o.get("source_url"), "src")}</td></tr>')


def macro(data: dict, reasons: dict) -> str:
    m = data.get("macro")
    if not m:
        return unavailable("Macro panels", reasons.get("macro"))
    trends = _d(data.get("relations"), "trends") or {}
    groups = m.get("groups") or {}
    order = [g for g, _ in GROUPS] + [g for g in groups if g not in dict(GROUPS)]
    names = dict(GROUPS)
    out = []
    for g in order:
        obs = groups.get(g)
        tr = trends.get(g)
        if not obs and not tr:
            continue
        lab = ""
        if isinstance(tr, dict):
            tl = tr.get("label") or "insufficient data"
            cls = {"accelerating": "tr-acc", "slowing": "tr-slow", "mixed": "tr-mix", "flat": "tr-ins"}.get(tl, "tr-ins")
            lab = f'<span class="trend {cls}" title="{esc(tr.get("evidence"))}">{esc(tl)}</span>'
        cards = ('<table class="mtab"><tbody>' + "".join(macro_card(o) for o in obs) + "</tbody></table>") if obs else \
            '<p class="muted">No observations in this group.</p>'
        n = max(1, len(obs or []))
        bad = sum(1 for o in obs or [] if o.get("status") != "ok")
        badh = f' <span class="chip st-stale">{bad} not ok</span>' if bad else ""
        out.append(f'<details class="mg" id="m-{esc(g)}" open><summary class="mg-h"><h3>{esc(names.get(g, g.replace("_", " ").title()))}</h3>'
                   f'{lab}<span class="muted small">{len(obs or [])}</span>{badh}</summary>'
                   f'{cards}</details>')
    if not out:
        return '<p class="muted">macro.json has no groups.</p>'
    return f'<div class="mgs">{"".join(out)}</div>'
