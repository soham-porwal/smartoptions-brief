"""Assemble the single self-contained page."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from . import content as C
from .assets import CSS, JS
from .fmt import esc, link, na
from .hero import also_watching, regime_hero, seller_gauges
from .sections import FACTORS, SAM_LABEL, TOP_OPP_N, _d, calendar, header, insights, macro, unavailable
from .table import drawers, sam_asof, table


def playbook() -> str:
    cards = []
    for p in C.PLAYBOOK:
        cons = "".join(f"<li>{esc(x)}</li>" for x in p["consider"])
        cards.append(f"""<article class="pb" id="pb-{p['id']}"><h3>{esc(p['title'])}</h3>
<h4>What it is</h4><p>{esc(p['what'])}</p><h4>Typical options impact</h4><p>{esc(p['impact'])}</p>
<h4>Structures people consider (conditions first)</h4><ul>{cons}</ul><p class="nt"><b>No-trade choice:</b> {esc(p['no_trade'])}</p></article>""")
    checks = "".join(f"<li>{esc(x)}</li>" for x in C.CHECKS)
    cards.append(f'<article class="pb"><h3>Checks for every candidate</h3><ul>{checks}</ul></article>')
    return f'<p class="muted small">{esc(C.PLAYBOOK_INTRO)}</p><div class="pbgrid">{"".join(cards)}</div>'


def _sources(data: dict) -> list[tuple[str, str, str]]:
    seen: dict[str, tuple[str, str, str]] = {}
    for obs in (_d(data.get("macro"), "groups") or {}).values():
        for o in obs or []:
            u = o.get("source_url")
            if u and u not in seen:
                seen[u] = (str(o.get("provider") or ""), f"{o.get('label') or o.get('id')} ({o.get('series')})", u)
    for ev in _d(data.get("calendar"), "events") or []:
        u = ev.get("source_url")
        if u and u not in seen:
            seen[u] = ("official calendar", f"{ev.get('type')} release schedule", u)
    for c in _d(data.get("relations"), "insights") or []:
        for e in c.get("evidence") or []:
            u = e.get("source_url")
            if u and u not in seen:
                seen[u] = ("insight evidence", str(e.get("label") or ""), u)
    return list(seen.values())


def methodology(data: dict, reasons: dict) -> str:
    eq = data.get("equities") or {}
    rel = data.get("relations") or {}
    src = "".join(f"<li>{esc(p)} · {esc(lbl)} · {link(u, 'link')}</li>" for p, lbl, u in _sources(data))
    providers = set()
    for tk in (eq.get("tickers") or {}).values():
        for pv in ((tk or {}).get("provenance") or {}).values():
            if isinstance(pv, dict) and pv.get("provider"):
                providers.add(str(pv["provider"]))
    eqsrc = (f"<li>Equities universe: {esc(eq.get('universe_source'))}</li>" if eq.get("universe_source") else "") + \
            "".join(f"<li>Equity field provider: {esc(p)}</li>" for p in sorted(providers))
    movers = _d(eq, "movers", "method")
    mv = esc(movers) if movers else na("equities.json unavailable or has no movers.method")
    factors = ", ".join(FACTORS.get(f, (f, f))[1] for f in rel.get("factors") or []) or None
    rmeth = rel.get("method")
    reg = (f'<p class="pre">{esc(rmeth)}</p>' if rmeth else "")
    for k, lbl in (("vol_breadth", "Options-seller context"), ("regime", "Market regime")):
        mt = _d(rel, k, "method")
        if mt:
            reg += f'<h4>{lbl}</h4><p class="pre">{esc(mt)}</p>'
    if rel.get("factors_dropped"):
        reg += f'<p>Factors dropped this run: {esc(", ".join(map(str, rel["factors_dropped"])))}</p>'
    reg = reg + (
        f"<p>Window: {esc(rel.get('window'))}. Factors: {esc(factors)}. Cells are coloured only when |t| &gt; 2. "
        f"The plain-English reading multiplies the coefficient by a +10 bp / +1% / +1 point move; it describes the "
        f"past association, holding the other factors fixed, and is not a forecast.</p>" if rel else
        f"<p>{na()} relations.json unavailable: {esc(reasons.get('relations'))}</p>")
    trend = ""
    if rel.get("trends"):
        trend = "<p>Trend labels (accelerating / slowing / mixed / insufficient data) come from the relations stage with the evidence string shown next to each label.</p>"
    lim = "".join(f"<li>{esc(x)}</li>" for x in C.LIMITATIONS)
    gen = {n: _d(data.get(n), "generated_at") for n in ("macro", "calendar", "equities", "relations")}
    return f"""<div class="meth">
<article class="pb"><h3>Data sources</h3><ul class="srcs">{src or '<li>No source URLs available (inputs missing).</li>'}{eqsrc}</ul></article>
<article class="pb"><h3>Freshness and status</h3><ul>
<li>Every value carries a status: <span class="chip st-ok">ok</span> <span class="chip st-stale">stale</span> <span class="chip st-missing">missing</span> <span class="chip st-error">error</span>.</li>
<li>Stale means older than its release cadence allows; the rule is applied in code by each data stage and the reason is shown on hover.</li>
<li>Missing stays missing: shown as an em dash with the reason on hover, never as zero.</li>
<li>Monthly and quarterly values show their observation period.</li>
<li>Stage timestamps: {", ".join(f"{esc(k)} {esc(v) if v else 'unavailable'}" for k, v in gen.items())}.</li></ul></article>
<article class="pb"><h3>Movers (set A) and universe (set B)</h3><p>{mv}</p>
<p>Set B is Sam's published screener universe. {SAM_LABEL} columns are read-only, as of {esc(sam_asof(eq))}.
"Sam's top {TOP_OPP_N} Opportunity" filter = the {TOP_OPP_N} highest published Opportunity scores in this table.
"High rate sensitivity" filter = |t| &gt; 2 on the 10-year yield factor.</p>
<p>Ticker detail "linked" events: a macro release whose usual channel ({esc(', '.join(f'{k}: {FACTORS.get(v, (v,))[0]}' for k, v in C.EVENT_FACTOR.items()))}) matches a factor the stock shows |t| &gt; 2 on. This mapping is a reading aid, not a measured event response.</p></article>
<article class="pb"><h3>Macro sensitivity regression</h3>{reg}{trend}</article>
<article class="pb"><h3>Known limitations</h3><ul>{lim}</ul></article>
</div>"""


def block(id_: str, title: str, body: str, note: str = "") -> str:
    n = f'<span class="muted">{note}</span>' if note else ""
    return f'<section class="blk" id="{id_}"><div class="blk-h"><h2>{esc(title)}</h2>{n}</div>{body}</section>'


def build_page(data: dict[str, Any], reasons: dict[str, str], rendered_at: datetime | None = None) -> str:
    rendered_at = rendered_at or datetime.now(timezone.utc).replace(microsecond=0)
    data = dict(data)
    data["_now"] = rendered_at
    rel = data.get("relations") or {}
    win = rel.get("window")
    parts = [
        header(data, reasons, rendered_at),
        regime_hero(rel, reasons.get("relations")) + seller_gauges(rel),
        block("cal", "Next 7 days", calendar(data, reasons), "ET + your local time"),
        block("ins", "Macro × stocks", insights(data, reasons) + (also_watching(data) if data.get("macro") else ""),
              f"click a cell to filter the table{' · ' + esc(win) if win else ''} · association, not causation"),
        block("macro", "Macro", macro(data, reasons), "latest print · hover for source"),
        block("table", "Movers + universe", table(data, reasons), "A = today's movers · B = Sam's universe"),
        '<details class="pbw" id="playbook"><summary><h2>Conditional playbook</h2><span class="muted">education, not advice</span></summary>'
        + playbook() + "</details>",
        '<details class="pbw" id="method"><summary><h2>Methodology, sources, limits</h2></summary>'
        + methodology(data, reasons) + "</details>",
    ]
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>SmartOptions Daily · Macro × Fundamentals{' · ' + esc(_d(data.get('equities'), 'asof_session')) if _d(data.get('equities'), 'asof_session') else ''}</title>
<style>{CSS}</style></head>
<body><div class="wrap">
{"".join(parts)}
<footer>Research only. Not financial advice. Built from public data; every value links to its source. Relationships are measured associations over a stated window, not causation.</footer>
</div>
<div id="dimmer"></div>
<aside id="drawer" role="dialog" aria-modal="true" aria-label="Ticker detail"><button type="button" class="btn xclose" id="drclose">Close</button><div id="drbody"></div></aside>
{drawers(data, reasons)}
<script>{JS}</script>
</body></html>
"""
