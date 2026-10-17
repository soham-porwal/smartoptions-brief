from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml

from smartoptions.log import event
from .common import ROOT, load_json, parsed, utcnow, write_json
from .company import company, sector_medians
from .health import health
from .changes import calendar_coverage, daily_changes
from .market import build_risks, macro_assessment, positioning, pulse
from .shortlist import shortlist
from .statements import fetch_all
from .validate import validate_brief, validate_company


def constituents(cache,offline):
    path=cache/'constituents.json'
    rec=load_json(path,{}) if path.exists() else {}
    stamp=parsed(rec.get('retrieved_at'))
    if stamp and (datetime.now(timezone.utc)-stamp).total_seconds()<86400:return rec
    if offline:
        event('brief.constituents','S&P','WARN','Offline build; membership cache absent or expired')
        return {} # Do not imply unverified current membership.
    from smartoptions.equities.universe import fetch_constituents
    rec=fetch_constituents()
    rec['retrieved_at']=utcnow()
    write_json(path,rec)
    return rec


def build(out,cache,config,offline=False,watchlist=(),tickers=None,now=None):
    now=now or datetime.now(timezone.utc)
    core=load_json(out/'core.json',required=True)
    from .release_safety import guard_core
    guard_core(core)
    rows=core.get('rows') or []
    if not rows:raise ValueError('SUSPECT: core.json contains no company rows')
    require_tickers=set(tickers or [r['t'] for r in rows])
    selected=[r for r in rows if r['t'] in require_tickers]
    if len(selected)!=len(require_tickers):raise ValueError('Requested ticker missing from core.json')
    records=fetch_all([r['t'] for r in selected],cache,config,offline)
    prices={r['t']:load_json(out/'px'/f"{r['t']}.json",{}) for r in rows}
    medians=sector_medians(rows);companies={}
    for r in selected:
        obj=company(r,records[r['t']],core['asof_session'],config['company'],medians,prices[r['t']])
        from .release_safety import guard_company
        guard_company(obj, r)
        try:
            validate_company(obj)
        except ValueError as exc:
            exc.context = dict(ticker=r['t'], bytes=len(__import__('json').dumps(obj, ensure_ascii=False, separators=(',', ':')).encode()))
            raise
        companies[r['t']]=obj
    signal_date=str(core.get('rel',{}).get('window') or '')[-10:]
    enriched=[dict(r,_signals=[s for s in core.get('signals',[]) if s.get('t')==r['t']],_signals_asof=signal_date) for r in selected]
    risks=build_risks(core,rows,now,watchlist)
    # Pin positioning to the same membership receipt as core, so independently
    # cached lists cannot disagree on the index denominator during an update.
    membership=core.get('meta',{}).get('constituents') or constituents(cache,offline)
    position=positioning(core,rows,prices,config['macro'],membership)
    macro=macro_assessment(core,position,config['macro'],risks)
    quotes=load_json(out/'quotes.json',{})
    receipt=load_json(out/'release.json',{}) if (out/'release.json').exists() else None
    brief=dict(schema='brief.v1',asof_session=core['asof_session'],generated_at=now.isoformat(timespec='seconds'),
               health=health(core,quotes,records,now,receipt),pulse=pulse(macro),macro=macro,risks=risks,
               positioning=position,shortlist=shortlist(enriched,companies,core['asof_session'],config['company']),
               daily_changes=daily_changes(core,rows,prices,membership),calendar_coverage=calendar_coverage(core,rows,now))
    validate_brief(brief)
    # Validate the entire batch before replacing any publication artifact.
    sizes={t:write_json(out/'brief'/'company'/f'{t}.json',obj) for t,obj in companies.items()}
    brief_size=write_json(out/'brief.json',brief)
    if len(companies)!=len(selected):raise ValueError('Company round-trip mismatch')
    event('brief.verify','publication','OK',f'{len(companies)}/{len(selected)} companies; brief={brief_size}B; max company={max(sizes.values())}B',len(companies))
    print(f"Published {len(companies)} companies; brief {brief_size} bytes; largest company {max(sizes.values())} bytes; shortlist {len(brief['shortlist'])}; source health {brief['health']['overall']}")
    return brief,companies


def main():
    parser=argparse.ArgumentParser(description='Build provenance-bearing Brief and company JSON')
    parser.add_argument('--out',type=Path,default=ROOT/'app/data')
    parser.add_argument('--cache',type=Path,default=ROOT/'data/cache/brief')
    parser.add_argument('--config',type=Path,default=ROOT/'config/brief.yaml')
    parser.add_argument('--offline',action='store_true',help='Use only unexpired cached statements')
    parser.add_argument('--tickers',nargs='+',help='Explicit partial build for diagnostics')
    parser.add_argument('--watchlist',nargs='*',default=[],help='Prioritize these earnings tickers')
    parser.add_argument('--now',help='Fixed ISO timestamp for reproducible verification')
    args=parser.parse_args()
    try:
        config=yaml.safe_load(args.config.read_text(encoding='utf-8'))
        if not 1<=config['workers']<=8:raise ValueError('workers must be 1..8')
        if args.now and not parsed(args.now):raise ValueError('--now must be ISO')
        build(args.out,args.cache,config,args.offline,args.watchlist,args.tickers,parsed(args.now) if args.now else None)
        if args.tickers:return 0   # partial diagnostic build: the catalog needs the full published histories
        # Documented build path regenerates the Explore relationship catalog from the same core/px (keep-last-good on failure).
        from .relationships import main as relationships_main
        return relationships_main(['--data-root',str(args.out)])
    except Exception as exc:
        event('brief.build','publication','FAIL',f'{type(exc).__name__}: {exc}')
        print(f'Brief build failed: {type(exc).__name__}: {exc}',file=sys.stderr)
        return 1


if __name__=='__main__':
    raise SystemExit(main())
