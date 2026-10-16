from __future__ import annotations

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from .common import parsed


def source(id_,label,asof,now,note='',delayed=False,max_hours=24):
    stamp=parsed(asof)
    age=max(0,(now-stamp).total_seconds()/3600) if stamp else None
    status='missing' if age is None else 'stale' if age>max_hours*2 else 'delayed' if delayed or age>max_hours else 'fresh'
    return dict(id=id_,label=label,asof=asof,age_hours=round(age,2) if age is not None else None,status=status,note=note)


def health(core,quotes,records,now,release=None):
    gen=core.get('gen',{});sources=[]
    for key in ('equities','macro','relations','crosscheck'):
        sources.append(source(key,key.capitalize()+' build receipt',gen.get(key),now,
                              'Build time; individual observations retain their own reporting periods.'))
    quote_rows=quotes.get('quotes',{})
    qs=list(quote_rows.values())
    expected={r['t'] for r in core.get('rows',[])}
    absent=expected-set(quote_rows)
    stamps=[q.get('retrieved_at') for q in qs if parsed(q.get('retrieved_at'))]
    quote_provider=str(quotes.get('source') or quotes.get('provider') or 'Quote refresh')
    # Oldest covered quote, rather than a fresh envelope over stale individual rows.
    qstamp=min(stamps,key=lambda s:parsed(s)) if stamps else None
    sources.append(source('quotes',quote_provider,qstamp,now,'Provider delay applies; this is retrieval age, not a real-time guarantee.',delayed='delay' in quote_provider.lower(),max_hours=24))
    missing_quotes=sum(q.get('price') is None for q in qs)
    if missing_quotes or absent or not qs:
        sources[-1]['status']='missing' if not qs else 'stale'
        sources[-1]['note']+=f' {missing_quotes}/{len(qs)} quote rows unavailable.'
        if absent:sources[-1]['note']+=f' {len(absent)} of {len(expected)} company names absent from the quote feed.'
    for group,arr in core.get('macro',{}).items():
        stamps=[o.get('retrieved_at') for o in arr if parsed(o.get('retrieved_at'))]
        status_source=source('macro_'+group,group.replace('_',' ').capitalize()+' observations',min(stamps,key=parsed) if stamps else None,now,
                             'Release periods differ by cadence; per-metric dates are shown.')
        if any(o.get('status') in ('missing','error') for o in arr):status_source['status']='missing'
        elif any(o.get('status')=='stale' for o in arr):status_source['status']='stale'
        sources.append(status_source)
    tables=[v for rec in records.values() for v in rec.values()]
    available=[v for v in tables if v.get('data')]
    stamps=[v.get('retrieved_at') for v in available if parsed(v.get('retrieved_at'))]
    item=source('statements','Yahoo company statements and analyst estimates',min(stamps,key=parsed) if stamps else None,now,
                f'{len(available)}/{len(tables)} tables available; 24-hour cache; financial reporting lags apply.')
    if len(available)<len(tables):item['status']='delayed' if available else 'missing'
    sources.append(item)
    sam=core.get('meta',{}).get('sam_source',{})
    samdate=str(sam.get('asof') or '')[:10]
    stamp=parsed(samdate)
    # Sam's retained snapshot is explicitly dated in Pacific time.
    age_days=max(0,(now.astimezone(ZoneInfo('America/Los_Angeles')).date()-stamp.date()).days) if stamp else None
    screener=dict(label="Sam's screener scores",asof=samdate or None,age_days=age_days,status='stale' if stamp else 'missing',
                  note=f"Scores from Sam's screener, last updated {stamp.strftime('%b')} {stamp.day}. Our own signals use observations dated {core.get('asof_session')}." if stamp else "Not available: Sam's screener date is missing.")
    sources.append(source('sam','Sam screener snapshot',samdate or None,now,screener['note'],max_hours=24))
    if stamp:sources[-1]['status']='stale'
    if release:
        sources.append(source('release','Published build receipt',release.get('published_at') or release.get('generated_at') or release.get('built_at'),now,'Optional publication receipt; not quote freshness.'))
    rank={'fresh':0,'delayed':1,'stale':2,'missing':3}
    worst=max((s['status'] for s in sources),key=rank.get,default='missing')
    overall='stale' if worst=='missing' else worst
    return dict(overall=overall,line='Some inputs are dated or missing; inspect their source dates.' if overall=='stale' else 'Some providers publish delayed observations.' if overall=='delayed' else 'Source receipts are current; reporting periods still differ.',sources=sources,screener=screener)
