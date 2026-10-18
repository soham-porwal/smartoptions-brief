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
            for p in root.rglob('*') if p.is_file() and p.name not in ('money-flow.json','news-refresh-status.json','snapshot.zip')}


def refresh_news(data_root, work_root, cache_root, *, workspace=None, mirror_url=None, key=None, collector=None, now=None):
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
            manifest=read_bundle(fetch_bundle(mirror_url),remote)
            incoming=load_json(remote/'money-flow.json',required=True)
            validate(incoming,now)
            if previous.get('news_status',{}).get('retrieved_at') and stamp(incoming['news_status']['retrieved_at'])<stamp(previous['news_status']['retrieved_at']):
                raise ValueError('Canonical news would move collection backward')
            result={**previous,**{k:incoming.get(k,[]) if k!='news_status' else incoming[k] for k in NEWS_FIELDS}}
            receipt.update(source_url=mirror_url,source_sha256=manifest['files']['money-flow.json'])
        else:
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
        count=validate(result,now)
        # Non-news fields (including manager filings, warnings and assembly date)
        # remain byte-equivalent JSON values. Collection status belongs to news.
        if {k:v for k,v in result.items() if k not in NEWS_FIELDS}!={k:v for k,v in previous.items() if k not in NEWS_FIELDS}:
            raise ValueError('News refresh changed non-news capital data')
        write_json(candidate/'money-flow.json',result)
        sources=result['news_status']['sources']
        receipt.update(status='degraded' if any(s.get('status') not in ('ok','empty') for s in sources.values()) else 'ok' if count else 'suspect',
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
    args=parser.parse_args()
    try:
        receipt=refresh_news(**vars(args));print(json.dumps(receipt,sort_keys=True));return 0
    except Exception as exc:
        print('FAIL: news-only refresh retained previous dataset: '+type(exc).__name__,file=sys.stderr);return 1


if __name__=='__main__':raise SystemExit(main())
