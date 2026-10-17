"""Dated comparable changes and calendar coverage for the brief (optional, backward-compatible blocks).

Every change names both observation dates, the comparison and the cohort. A missing prior, a
mismatched date or an unusable history yields status "unavailable" with a reason; nothing is
reported as "unchanged" by default, and no directional word exists without both values.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from statistics import mean
from zoneinfo import ZoneInfo

from smartoptions.log import event
from .common import number, parsed

ET = ZoneInfo('America/New_York')
FLAT = {'%': 0.005, 'pp': 0.005, 'names': 0, 'bp': 0.5}
YAHOO_SPY = 'https://finance.yahoo.com/quote/SPY/history/'


def _direction(change, unit):
    if change is None:
        return None
    eps = FLAT.get(unit, 0)
    return 'up' if change > eps else 'down' if change < -eps else 'flat'


def item(id_, label, unit, cur, prior, comparison, source, url, cohort=None, note=''):
    """cur/prior are (value, date) pairs or None."""
    ok = cur is not None and prior is not None and cur[0] is not None and prior[0] is not None
    change = round(cur[0] - prior[0], 4) if ok else None
    return dict(id=id_, label=label, unit=unit,
                current=dict(value=round(cur[0], 4), date=cur[1]) if cur and cur[0] is not None else None,
                prior=dict(value=round(prior[0], 4), date=prior[1]) if prior and prior[0] is not None else None,
                change=change, comparison=comparison, cohort=cohort, direction=_direction(change, unit),
                status='ok' if ok else 'unavailable', reason='' if ok else (note or 'Comparable prior observation unavailable'),
                note=note if ok else '', source=source, source_url=url)


def missing(id_, label, unit, comparison, reason, source, url):
    return dict(id=id_, label=label, unit=unit, current=None, prior=None, change=None, comparison=comparison,
                cohort=None, direction=None, status='unavailable', reason=reason, note='', source=source, source_url=url)


def spy_change(core):
    session = core['asof_session']
    spy = [(d, number(v)) for d, v in core.get('spy_close', []) if d <= session and number(v) is not None]
    label, cmp_ = 'SPY close versus previous session', 'previous session'
    if len(spy) < 2:
        return missing('spy_1d', label, '%', cmp_, 'Fewer than two retained SPY closes', 'Yahoo Finance', YAHOO_SPY)
    if spy[-1][0] != session:
        return missing('spy_1d', label, '%', cmp_, f'Latest SPY close {spy[-1][0]} is not the {session} session', 'Yahoo Finance', YAHOO_SPY)
    (d0, v0), (d1, v1) = spy[-2], spy[-1]
    out = item('spy_1d', label, 'USD/share', (v1, d1), (v0, d0), cmp_, 'Yahoo Finance', YAHOO_SPY,
               note='Retained unadjusted SPY closes')
    out['pct_change'] = round((v1 / v0 - 1) * 100, 4)
    out['direction'] = _direction(out['pct_change'], '%')
    return out


def participation_change(core, rows, prices, membership, n=50, back=5):
    """Share of one fixed cohort above its n-session average on the session and `back` sessions earlier.

    The cohort is the names with a bar on BOTH dates of a shared (SPY) date index and at least n closes
    up to each date; names failing either test are excluded from both shares and counted.
    """
    session = core['asof_session']
    label, cmp_ = f'Share above {n}-session average', f'{back} sessions'
    index = [d for d, v in core.get('spy_close', []) if d <= session and number(v) is not None]
    if len(index) <= back or index[-1] != session:
        return missing('breadth_50_5d', label, 'pp', cmp_, 'Shared session index unavailable for the comparison dates', 'Yahoo Finance', YAHOO_SPY)
    d_now, d_then = index[-1], index[-1 - back]
    symbols = set((membership or {}).get('symbols', []))
    selected = [r for r in rows if r.get('sp500_member') is not False and (not symbols or r['t'].replace('.', '-') in symbols)]
    above_now = above_then = 0; cohort = 0; excluded = []
    for r in selected:
        bars = [b for b in prices.get(r['t'], {}).get('bars', []) if number(b[4]) is not None and b[0] <= d_now]
        dates = [b[0] for b in bars]
        try:
            i_now, i_then = dates.index(d_now), dates.index(d_then)
        except ValueError:
            excluded.append(r['t']); continue
        if i_then + 1 < n:
            excluded.append(r['t']); continue
        closes = [b[4] for b in bars]
        cohort += 1
        above_now += closes[i_now] > mean(closes[i_now - n + 1:i_now + 1])
        above_then += closes[i_then] > mean(closes[i_then - n + 1:i_then + 1])
    if cohort < 0.9 * max(1, len(selected)):
        return missing('breadth_50_5d', label, 'pp', cmp_, f'Only {cohort} of {len(selected)} names have bars on both {d_then} and {d_now}',
                       'Yahoo Finance via retained histories', 'https://finance.yahoo.com/')
    now_share, then_share = 100 * above_now / cohort, 100 * above_then / cohort
    out = item('breadth_50_5d', label, 'pp', (now_share, d_now), (then_share, d_then), cmp_, 'Yahoo Finance via retained histories', 'https://finance.yahoo.com/',
               cohort=dict(n=cohort, excluded=len(excluded), universe=len(selected), basis='same names on both dates; shared SPY session index'),
               note='Unadjusted closes; a split inside the window can create a false crossing')
    out['counts'] = dict(current=above_now, prior=above_then)
    return out


def eq_cap_change(core, back=5):
    rel = core.get('rel', {}).get('vol_breadth', {}).get('breadth_rsp_spy_20d', {})
    label, cmp_ = 'Equal-weight minus cap-weight, 20-session return gap', f'versus {back} sessions earlier'
    url = 'https://finance.yahoo.com/quote/RSP/history/'
    hist = [(d, number(v)) for d, v in (rel.get('history') or []) if number(v) is not None]
    if rel.get('status') != 'ok' or len(hist) <= back:
        return missing('eq_cap_gap_5d', label, 'pp', cmp_, 'RSP/SPY gap history unavailable', 'Yahoo Finance via retained relations', url)
    if number(rel.get('value')) is None or abs(hist[-1][1] - number(rel['value'])) > 1e-6:
        return missing('eq_cap_gap_5d', label, 'pp', cmp_, 'Latest gap value and its history disagree', 'Yahoo Finance via retained relations', url)
    if hist[-1][0] != core['asof_session']:
        return missing('eq_cap_gap_5d', label, 'pp', cmp_, f'Latest gap is dated {hist[-1][0]}, not {core["asof_session"]}', 'Yahoo Finance via retained relations', url)
    return item('eq_cap_gap_5d', label, 'pp', hist[-1][::-1], hist[-1 - back][::-1], cmp_, 'Yahoo Finance via retained relations', url,
                note='ETF price gap (RSP minus SPY) over 20 sessions; positive means the average stock led')


def sector_moves(core, rows, prices, membership):
    """Cap-weighted one-session sector returns on matched dates (current market-cap weights, declared)."""
    session = core['asof_session']
    index = [d for d, v in core.get('spy_close', []) if d <= session and number(v) is not None]
    if len(index) < 2 or index[-1] != session:
        return dict(status='unavailable', reason='Shared session index unavailable', items=[])
    d0, d1 = index[-2], index[-1]
    symbols = set((membership or {}).get('symbols', []))
    agg = {}
    for r in rows:
        if r.get('sp500_member') is False or (symbols and r['t'].replace('.', '-') not in symbols):
            continue
        cap = number(r.get('mcap'))
        x = agg.setdefault(r.get('sec') or 'Not available', dict(w=0.0, wr=0.0, n=0, total=0))
        x['total'] += 1
        if not cap or cap <= 0:
            continue
        bars = {b[0]: number(b[4]) for b in prices.get(r['t'], {}).get('bars', [])}
        a, b = bars.get(d0), bars.get(d1)
        if not a or b is None or a <= 0:
            continue
        x['w'] += cap; x['wr'] += cap * (b / a - 1) * 100; x['n'] += 1
    out = [dict(sector=s, ret_pct=round(x['wr'] / x['w'], 4), covered=x['n'], n=x['total']) for s, x in agg.items() if x['w'] > 0]
    out.sort(key=lambda s: s['ret_pct'], reverse=True)
    if len(out) < 2:
        return dict(status='unavailable', reason='Fewer than two sectors with matched closes', items=[])
    return dict(status='ok', reason='', from_date=d0, to_date=d1, basis='Current market-cap weights; unadjusted closes on both dates',
                leader=out[0], laggard=out[-1], items=out)


MACRO_KEYS = ('us10y', 'hy_oas', 'vix', 'effective_fed_funds', 'cpi_headline', 'unemployment', 'payrolls', 'initial_claims', 'dxy', 'wti')


def macro_changes(core):
    """Latest observation versus the prior observation in the same retained history (current vintage)."""
    out = []
    for g in core.get('macro', {}).values():
        for o in g or []:
            if o.get('id') not in MACRO_KEYS:
                continue
            h = [(str(d)[:10], number(v)) for d, v in o.get('h') or [] if number(v) is not None]
            unit = o.get('unit') or ''
            base = dict(source=o.get('provider') or 'Retained macro observation', url=o.get('url') or 'https://fred.stlouisfed.org/')
            if len(h) < 2:
                out.append(missing(o['id'], o.get('label', o['id']), unit, 'prior observation', 'Fewer than two observations retained', base['source'], base['url'])); continue
            if o.get('date') and h[-1][0] != str(o['date'])[:10]:
                out.append(missing(o['id'], o.get('label', o['id']), unit, 'prior observation', f"History ends {h[-1][0]} but the observation is dated {o['date']}", base['source'], base['url'])); continue
            note = 'Prior is from the current data vintage and may include revisions'
            if o.get('status') not in ('ok', None):
                note += f"; latest retrieval status {o.get('status')}"
            x = item(o['id'], o.get('label', o['id']), unit, (h[-1][1], h[-1][0]), (h[-2][1], h[-2][0]), 'prior observation', base['source'], base['url'], note=note)
            x['period'] = o.get('period'); x['retrieved_at'] = o.get('retrieved_at'); x['obs_status'] = o.get('status') or 'ok'
            out.append(x)
    order = {k: i for i, k in enumerate(MACRO_KEYS)}
    return sorted(out, key=lambda x: order.get(x['id'], 99))


def daily_changes(core, rows, prices, membership):
    try:
        items = [spy_change(core), participation_change(core, rows, prices, membership), eq_cap_change(core)]
        sectors = sector_moves(core, rows, prices, membership)
        macro = macro_changes(core)
    except Exception as exc:   # optional block: never block the brief, never pass silently
        event('brief.daily_changes', 'publication', 'WARN', f'{type(exc).__name__}: {exc}')
        return dict(status='unavailable', reason=f'Change computation failed: {type(exc).__name__}', items=[], sectors=dict(status='unavailable', reason='not computed', items=[]), macro=[])
    ok = sum(i['status'] == 'ok' for i in items)
    status = 'ok' if ok == len(items) else 'partial' if ok else 'unavailable'
    skipped = [i['id'] + ': ' + i['reason'] for i in items + macro if i['status'] != 'ok']
    event('brief.daily_changes', 'publication', 'OK' if status == 'ok' else 'WARN' if ok else 'SUSPECT',
          f'{ok}/{len(items)} market changes; macro {sum(m["status"] == "ok" for m in macro)}/{len(macro)}; skipped: ' + ('; '.join(skipped)[:400] or 'none'), ok)
    return dict(status=status, reason='' if ok else 'No comparable market change could be measured', asof_session=core['asof_session'],
                items=items, sectors=sectors, macro=macro)


def participation_level(share50, share200):
    """Level wording only; directional language belongs to the dated change."""
    vals = [v for v in (share50, share200) if v is not None]
    if not vals:
        return dict(level='unavailable', level_line='Participation unavailable: matched histories missing')
    lo, hi = min(vals), max(vals)
    word = 'broad' if lo >= 60 else 'thin' if hi < 40 else 'mixed'
    return dict(level=word, level_line=f'Participation {word}: {share50:.0f}% above 50-session average' if share50 is not None else f'Participation {word}')


def risk_timing(risk, rows_by_t):
    if risk['kind'] == 'macro':
        return 'timed' if 'T' in str(risk['when_et']) else 'date_only'
    ert = str((rows_by_t.get((risk.get('tickers') or [''])[0]) or {}).get('ert') or '')
    return {'BMO': 'bmo', 'AMC': 'amc'}.get(ert, 'date_only')


def calendar_coverage(core, rows, now):
    """What the retained calendars actually cover. No provider supplies a range receipt, so the end is never inferred."""
    session = core['asof_session']
    cal = core.get('calendar') or []
    notes = [str(n) for n in core.get('calendar_notes') or []]
    gaps = [n for n in notes if any(w in n.lower() for w in ('unavailable', 'omitted', 'failed', 'error'))]
    listed = sorted(str(e.get('scheduled_et'))[:10] for e in cal if e.get('scheduled_et'))
    future = [d for d in listed if d >= session]
    macro_status = 'unavailable' if not cal else 'expired' if not future else 'partial'
    macro = dict(kind='macro', source='Published release calendars (FRED, BEA, EIA, Federal Reserve)', range_start=None, range_end=None,
                 latest_listed=listed[-1] if listed else None, retrieved_at=core.get('gen', {}).get('macro'), status=macro_status,
                 note=('No coverage endpoint is supplied; the latest listed release is not the end of coverage. ' + ' '.join(gaps)).strip())
    with_er = [r for r in rows if r.get('er')]
    stamps = sorted(r.get('rat') for r in rows if r.get('rat'))
    earn = dict(kind='earnings', source='Yahoo get_earnings_dates (next date per company)', range_start=None, range_end=None,
                latest_listed=max((r['er'] for r in with_er), default=None), retrieved_at=stamps[-1] if stamps else None,
                status='partial' if with_er else 'unavailable', companies=len(with_er), universe=len(rows),
                note='Only the next provider date per company; most dates carry no time of day, and a missing date does not mean no report.')
    statuses = [macro['status'], earn['status']]
    overall = 'unavailable' if all(s == 'unavailable' for s in statuses) else 'expired' if 'expired' in statuses else 'partial'
    if overall != 'partial':
        event('brief.calendar_coverage', 'publication', 'WARN', f'macro={macro_status} earnings={earn["status"]}', len(cal))
    return dict(status=overall, asof_session=session, checked_at=now.isoformat(timespec='seconds'), horizon_rule='ET calendar dates from today through today+N; timed events earlier today are dropped',
                sources=[macro, earn], gaps=gaps)


def event_window(start_et, days):
    """Inclusive ET date bounds for an N-day horizon."""
    d0 = start_et.date()
    return d0, d0 + timedelta(days=days)
