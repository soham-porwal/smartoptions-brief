"""Bounded news-only producer/mirror; no fundamentals, quotes or SEC collection.

The shared hosted workflow lock serializes snapshot, quote and news publication.
Each promotion retains the entire previous directory and rehashes snapshot.zip.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone, timedelta
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys

from smartoptions.brief.common import load_json, write_json
from smartoptions.log import event
from smartoptions.moneyflow import Collector, collect_news, NEWS_LIMITS
from smartoptions.refresh import confined, fetch_bundle, read_bundle, write_bundle, promote
from smartoptions import situation as situation_mod

CANONICAL = 'https://soham-porwal.github.io/smartoptions-brief/data/snapshot.zip'
NEWS_FIELDS = ('news', 'news_status', 'news_warnings')


def stamp(value):
    parsed = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    if parsed.tzinfo is None:raise ValueError('News date lacks timezone')
    return parsed


def validate(data, now=None):
    now = now or datetime.now(timezone.utc)
    if data.get('schema') != 'smartoptions.capital.v1':raise ValueError('Invalid news document schema')
    state = data.get('news_status') or {}
    collected = stamp(state.get('retrieved_at'))
    if collected > now + timedelta(minutes=10):raise ValueError('Future news collection timestamp')
    if not isinstance(state.get('sources'), dict) or not state['sources']:raise ValueError('Missing news source receipt')
    rows = data.get('news')
    if not isinstance(rows, list) or len(rows)>33:raise ValueError('Invalid or unbounded news list')
    seen = set()
    for row in rows:
        if row.get('scope') not in ('market', 'company', 'official') or not row.get('headline') or not str(row.get('url','')).startswith('https://'):
            raise ValueError('Invalid news item')
        published=stamp(row.get('published_at'))
        if published>now+timedelta(minutes=10):raise ValueError('Future news item')
        # Mirror can read an old but valid canonical bundle; UI expires it against
        # its wall clock. Do not relabel upstream dates as the mirror attempt.
        if row.get('retrieved_at'):stamp(row['retrieved_at'])
        identity=(row['headline'],row['url'])
        if identity in seen:raise ValueError('Duplicate news item')
        seen.add(identity)
    return len(rows)


def hashes(root):
    return {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in root.rglob('*') if p.is_file() and p.name not in ('money-flow.json','news-refresh-status.json','snapshot.zip','situation.json')}


def newer_full_pair(local, remote, now):
    """A delayed client daily job is repaired by its existing news mirror cadence.

    Both source clocks must advance together. The full mirror still validates the
    whole bundle/coverage and preserves independent quote/news/situation clocks.
    """
    lc,lb=(load_json(local/n,required=True) for n in ('core.json','brief.json'))
    rc,rb=(load_json(remote/n,required=True) for n in ('core.json','brief.json'))
    clocks=[rc.get('exported_at'),rb.get('generated_at'),lc.get('exported_at'),lb.get('generated_at')]
    if not all(clocks):return False
    a,b,c,d=map(stamp,clocks)
    if a>now+timedelta(minutes=10) or b>now+timedelta(minutes=10):raise ValueError('Future canonical pair')
    if rc.get('asof_session')!=rb.get('asof_session'):raise ValueError('Canonical pair session mismatch')
    return a>c and b>d and str(rc.get('asof_session',''))>=str(lc.get('asof_session',''))


def refresh_news(data_root, work_root, cache_root, *, workspace=None, mirror_url=None, key=None, collector=None, now=None, market_fetch=None, situation_builder=None, catch_up_full=False):
    workspace=Path(workspace or Path.cwd()).resolve()
    data_root,work_root,cache_root=(confined(p,workspace) for p in (data_root,work_root,cache_root))
    if any(a.is_relative_to(b) for a,b in ((work_root,data_root),(data_root,work_root),(cache_root,data_root),(data_root,cache_root))):
        raise ValueError('News data, work and cache paths must be separate')
    now=now or datetime.now(timezone.utc)
    run=work_root/now.strftime('%Y%m%dT%H%M%S%fZ');run.mkdir(parents=True,exist_ok=False)
    receipt=dict(schema='smartoptions.news-refresh.v1',attempted_at=now.isoformat(),status='running',
                 mode='canonical_news_mirror' if mirror_url else 'news_only',provider_calls=0,publication_changed=False)
    try:
        previous=load_json(data_root/'money-flow.json',required=True)
        protected=hashes(data_root)
        candidate=run/'data';shutil.copytree(data_root,candidate,ignore=shutil.ignore_patterns('snapshot.zip'))
        if mirror_url:
            if mirror_url!=CANONICAL:raise ValueError('Unapproved canonical news mirror')
            remote=run/'canonical';remote.mkdir()
            raw_bundle=fetch_bundle(mirror_url)
            manifest=read_bundle(raw_bundle,remote)
            incoming=load_json(remote/'money-flow.json',required=True)
            validate(incoming,now)
            if catch_up_full and newer_full_pair(data_root,remote,now):
                from smartoptions.refresh import mirror
                full=mirror(data_root,run/'full-catchup',mirror_url,workspace=workspace,bundle_bytes=raw_bundle)
                receipt['full_catchup']={'status':'ok','asof_session':full['asof_session'],'canonical_generated_at':full['canonical_generated_at']}
                previous=load_json(data_root/'money-flow.json',required=True)
                protected=hashes(data_root)
                candidate=run/'data-after-full';shutil.copytree(data_root,candidate,ignore=shutil.ignore_patterns('snapshot.zip'))
            elif catch_up_full:
                receipt['full_catchup']={'status':'not_needed'}
            if previous.get('news_status',{}).get('retrieved_at') and stamp(incoming['news_status']['retrieved_at'])<stamp(previous['news_status']['retrieved_at']):
                raise ValueError('Canonical news would move collection backward')
            result={**previous,**{k:incoming.get(k,[]) if k!='news_status' else incoming[k] for k in NEWS_FIELDS}}
            receipt.update(source_url=mirror_url,source_sha256=manifest['files']['money-flow.json'])
            # Mirror adopts the canonical situation file only when valid and not older; never re-acquires it.
            situation_doc=None
            if (remote/'situation.json').is_file():
                try:
                    cand=load_json(remote/'situation.json',required=True);situation_mod.validate_situation(cand,now)
                    old=load_json(data_root/'situation.json') if (data_root/'situation.json').is_file() else None
                    situation_doc=cand if not old or stamp(cand['generated_at'])>=stamp(old['generated_at']) else old
                    receipt['situation']={'status':'mirrored' if situation_doc is cand else 'kept_newer_local','generated_at':situation_doc['generated_at']}
                except Exception as exc:
                    receipt['situation']={'status':'mirror_rejected','error_type':type(exc).__name__}
        else:
            injected=collector is not None
            collector=collector or Collector(cache_root)
            key=key if key is not None else os.environ.get('FINNHUB_API_KEY','')
            if not key:
                secret=Path(r'D:\soham\myeverything\Secrets\finnhub_api_key.txt')
                if secret.is_file():key=secret.read_text(encoding='utf-8-sig').strip()
            warnings=[]
            news,status=collect_news(collector,key,False,candidate,previous,warnings,now)
            result={**previous,'news':news,'news_status':status,'news_warnings':warnings}
            receipt.update(provider_calls=collector.calls,finnhub_calls=collector.finnhub_calls,
                           finnhub_start_spacing_seconds=31,finnhub_request_cap=12)
            # Situation acquisition is isolated: its failure keeps the previous situation file and never blocks news.
            situation_doc=None
            try:
                old=load_json(data_root/'situation.json') if (data_root/'situation.json').is_file() else None
                core=load_json(data_root/'core.json') if (data_root/'core.json').is_file() else {}
                build=situation_builder or situation_mod.build_situation
                # An injected test collector without a market transport never reaches the network.
                market=([],{'status':'not_attempted','calls':0,'at':now.isoformat(),'errors':{'all':'no market transport injected'}}) if injected and market_fetch is None else None
                # Canonical producer invokes the existing Worker route (no Origin; existing reservation). Tests inject none.
                synth=None if injected else (None if os.environ.get('SITUATION_SYNTHESIS','on')=='off' else situation_mod.worker_call)
                situation_doc=build(now=now,baseline_session=core.get('asof_session'),news=news,previous=old,market_fetch=market_fetch,market=market,synth_call=synth)
                mr=situation_doc['sources']['market_references']
                receipt['situation']={'status':mr['status'],'market_calls':mr['calls'],'observations':len(situation_doc['observations']),
                                      'reports':len(situation_doc['reports']),'synthesis':situation_doc['synthesis']['status'],'generated_at':situation_doc['generated_at']}
            except Exception as exc:
                receipt['situation']={'status':'failed','error_type':type(exc).__name__,'reason':str(exc)[:160]}
                event('refresh.situation','news_only','FAIL',type(exc).__name__)
        count=validate(result,now)
        # Non-news fields (including manager filings, warnings and assembly date)
        # remain byte-equivalent JSON values. Collection status belongs to news.
        if {k:v for k,v in result.items() if k not in NEWS_FIELDS}!={k:v for k,v in previous.items() if k not in NEWS_FIELDS}:
            raise ValueError('News refresh changed non-news capital data')
        write_json(candidate/'money-flow.json',result)
        if situation_doc is not None:
            situation_mod.validate_situation(situation_doc,now);write_json(candidate/'situation.json',situation_doc)
        sources=result['news_status']['sources']
        sit_bad=receipt.get('situation',{}).get('status') in ('failed','partial')
        receipt.update(status='degraded' if sit_bad or any(s.get('status') not in ('ok','empty') for s in sources.values()) else 'ok' if count else 'suspect',
                       news_count=count,source_collection_at=result['news_status']['retrieved_at'],sources=sources,
                       finished_at=datetime.now(timezone.utc).isoformat(),preserved_files=len(protected),publication_changed=True)
        receipt['money_flow_sha256']=hashlib.sha256((candidate/'money-flow.json').read_bytes()).hexdigest()
        write_json(candidate/'news-refresh-status.json',receipt)
        manifest=write_bundle(candidate)
        # Prove every bundled member can round-trip with its current hash before promotion.
        read_bundle((candidate/'snapshot.zip').read_bytes(),run/'verified')
        if hashes(candidate)!=protected or hashes(data_root)!=protected:
            raise ValueError('Non-news dataset changed during news promotion')
        if manifest['files']['money-flow.json']!=receipt['money_flow_sha256']:raise ValueError('News bundle hash mismatch')
        promote(candidate,data_root,run/'previous-data',workspace)
        write_json(run/'receipt.json',receipt);write_json(work_root/'news-refresh-status.json',receipt)
        event('refresh.news',receipt['mode'],'OK' if receipt['status']=='ok' else 'WARN',f"{count} dated items; source states in news receipt",count)
        return receipt
    except Exception as exc:
        receipt.update(status='failed',error_type=type(exc).__name__,publication_changed=False,
                       finished_at=datetime.now(timezone.utc).isoformat(),reason='News refresh failed; previous data retained. Inspect workflow artifact.')
        write_json(run/'receipt.json',receipt);write_json(work_root/'news-refresh-status.json',receipt)
        event('refresh.news',receipt['mode'],'FAIL',type(exc).__name__)
        raise


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-root',type=Path,required=True);parser.add_argument('--work-root',type=Path,required=True)
    parser.add_argument('--cache-root',type=Path,default=Path('_pipeline/data/cache/news'))
    parser.add_argument('--workspace',type=Path,default=Path.cwd());parser.add_argument('--mirror-url')
    parser.add_argument('--catch-up-full',action='store_true',help='Reuse a newer canonical full bundle on the existing client news cadence; no provider collection')
    args=parser.parse_args()
    try:
        receipt=refresh_news(**vars(args));print(json.dumps(receipt,sort_keys=True));return 0
    except Exception as exc:
        print('FAIL: news-only refresh retained previous dataset: '+type(exc).__name__,file=sys.stderr);return 1


if __name__=='__main__':raise SystemExit(main())
