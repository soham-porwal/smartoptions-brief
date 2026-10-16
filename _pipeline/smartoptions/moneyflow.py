"""Capital/news context. Holdings are delayed disclosures, never live fund flows."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import time
import xml.etree.ElementTree as ET
import requests
from smartoptions.log import event
from smartoptions.brief.common import load_json, write_json

ROOT = Path(__file__).resolve().parents[1]
MANAGERS = {'0001067983': 'Berkshire Hathaway', '0001350694': 'Bridgewater Associates'}
SEC_GUIDE = 'https://www.sec.gov/rules-regulations/staff-guidance/frequently-asked-questions-about-form-13f'

def parse_holdings(text):
    """Modern 13F values are rounded USD; only ordinary long share counts compare."""
    root = ET.fromstring(text)
    rows = {}
    def field(node, name):
        return next((e.text or '' for e in node.iter() if e.tag.split('}')[-1] == name), '').strip()
    for node in root.iter():
        if node.tag.split('}')[-1] != 'infoTable': continue
        cusip, issuer, title = field(node,'cusip'), field(node,'nameOfIssuer'), field(node,'titleOfClass')
        option, share_type = field(node,'putCall'), field(node,'sshPrnamtType')
        try: shares, value = int(field(node,'sshPrnamt')), int(field(node,'value'))
        except ValueError: raise ValueError('Invalid holding numeric input') from None
        if not cusip or not issuer or shares < 0 or value < 0: raise ValueError('Invalid holding input')
        key = '|'.join((cusip,title,option,share_type))
        old = rows.setdefault(key, dict(cusip=cusip,issuer=issuer,title=title,option=option or None,share_type=share_type,shares=0,value_usd=0))
        old['shares'] += shares; old['value_usd'] += value
    if not rows: raise ValueError('No 13F information-table rows')
    return rows

def compare_holdings(current, prior):
    result=[]
    for key in current.keys() | prior.keys():
        a,b=current.get(key),prior.get(key); row=a or b
        if row['option'] or row['share_type'] != 'SH': continue
        shares,previous=(a or {}).get('shares',0),(b or {}).get('shares',0)
        diff=shares-previous
        if not diff: continue
        result.append({**row,'shares':shares,'prior_shares':previous,'share_change':diff,
          'share_change_pct':100*diff/previous if previous else None,
          'status':'newly reported' if not previous else 'no longer reported' if not shares else 'increased' if diff>0 else 'reduced',
          'reason':'Quarter-end reported share count changed. Corporate actions, transfers and reclassification can also change counts; this does not identify a trade date or dollars invested.'})
    return sorted(result,key=lambda r:abs(r['share_change']),reverse=True)

def classify_news(headline):
    text=headline.lower()
    groups=[('Acquisition',r'acqui|merger|takeover|buyout','A deal may change competitive pressure and financing needs; check the companies and terms.'),
      ('Capital spending',r'capex|capital expend|data cent|factory|factories|plants?\b|infrastructure','New capacity can support suppliers, but returns depend on utilization and financing costs.'),
      ('Investment & funding',r'invest|funding|venture|raises?\b|financ|a16z|andreessen|bezos','Funding signals an investor priority; it does not establish public-company revenue or returns.'),
      ('Policy',r'fed\b|tariff|regulat|rate cut|rate hike','Policy can change discount rates and operating costs; exposure differs by company.'),
      ('Earnings',r'earnings|revenue|profit|guidance','Reported results can test whether market expectations match operating performance.')]
    for label,pattern,reason in groups:
        if re.search(pattern,text): return label,reason
    return 'Market news','Context for investigation. A headline alone does not establish a change in fundamentals.'

class Collector:
    def __init__(self,cache,offline=False,get=None):
        self.cache,self.offline,self.get=Path(cache),offline,get or requests.get
        self.calls=0
    def fetch(self,url,*,headers=None,params=None,ttl=21600):
        identity=url+'?'+json.dumps(params or {},sort_keys=True)
        path=self.cache/(hashlib.sha256(identity.encode()).hexdigest()+'.json')
        old=load_json(path,{}) if path.exists() else {}
        if old.get('text') and time.time()-old.get('fetched_epoch',0)<ttl: return old['text']
        if self.offline:
            if old.get('text'): return old['text']
            raise ValueError('No cached source for offline build')
        self.calls+=1
        if self.calls>20: raise ValueError('Collector request budget exceeded')
        time.sleep(.22) # <5 SEC starts/second, shared sequential collector.
        response=self.get(url,headers={'User-Agent':'SmartOptions Research contact soham.porwal@gmail.com',**(headers or {})},params=params,timeout=(5,15),allow_redirects=False)
        if response.status_code!=200: raise ValueError('Source HTTP '+str(response.status_code))
        text=response.text
        if not text.strip(): raise ValueError('Empty source response')
        write_json(path,dict(text=text,fetched_epoch=time.time()))
        return text
    def manager(self,cik,name):
        submission=json.loads(self.fetch(f'https://data.sec.gov/submissions/CIK{cik}.json'))
        recent=submission.get('filings',{}).get('recent',{})
        filings=[]
        for i,form in enumerate(recent.get('form',[])):
            if form!='13F-HR':continue
            period=recent['reportDate'][i]
            if not period or period<'2023-01-01':continue
            if any(f['period']==period for f in filings):continue
            filings.append(dict(period=period,filed=recent['filingDate'][i],accession=recent['accessionNumber'][i]))
            if len(filings)==2:break
        if len(filings)<2:raise ValueError('Two comparable recent original 13F filings unavailable')
        tables=[]
        for filing in filings:
            base=f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{filing['accession'].replace('-','')}/"
            index=json.loads(self.fetch(base+'index.json'))
            candidates=[r['name'] for r in index.get('directory',{}).get('item',[]) if re.fullmatch(r'[A-Za-z0-9_.-]+\.xml',r.get('name','')) and r['name']!='primary_doc.xml']
            if len(candidates)!=1:raise ValueError('Ambiguous 13F information table; manual review needed')
            filing['url']=base+candidates[0]
            tables.append(parse_holdings(self.fetch(filing['url'])))
        amendments=[recent['filingDate'][i] for i,f in enumerate(recent.get('form',[])) if f=='13F-HR/A' and recent['reportDate'][i] in [x['period'] for x in filings]]
        if amendments: raise ValueError('Amended comparable filing requires manual reconciliation; no unverified position changes published')
        return dict(name=name,cik=cik,status='ok',current=filings[0],prior=filings[1],changes=compare_holdings(*tables)[:30],
          note='Original 13F long-share positions. Normally filed up to 45 days after quarter end; cash, many private assets and shorts are not a complete part of this view.')

def build(out,cache,offline=False,key=None):
    out=Path(out); target=out/'money-flow.json'
    old=load_json(target,{}) if target.exists() else {}
    collector=Collector(cache,offline); managers=[]; warnings=[]
    for cik,name in MANAGERS.items():
        try: managers.append(collector.manager(cik,name))
        except Exception as exc:
            reason=str(exc) if isinstance(exc,ValueError) else type(exc).__name__
            event('capital',name,'WARN',reason)
            previous=next((m for m in old.get('managers',[]) if m.get('cik')==cik),None)
            managers.append({**(previous or dict(name=name,cik=cik,changes=[])), 'status':'cached' if previous else 'unavailable','reason':reason})
            warnings.append(name+': '+reason)
    key=key if key is not None else os.environ.get('FINNHUB_API_KEY','')
    if not key:
        path=Path(r'D:\soham\myeverything\Secrets\finnhub_api_key.txt')
        if path.exists():key=path.read_text(encoding='utf-8-sig').strip()
    news=[]
    try:
        if not key and not offline:raise ValueError('Finnhub news key unavailable')
        items=json.loads(collector.fetch('https://finnhub.io/api/v1/news',headers={'X-Finnhub-Token':key},params={'category':'general'},ttl=3600))
        if not isinstance(items,list):raise ValueError('News response is not a list')
        for item in items:
            title,url=item.get('headline'),item.get('url')
            if not isinstance(title,str) or not isinstance(url,str) or not url.startswith('https://'):continue
            try:published=datetime.fromtimestamp(int(item['datetime']),timezone.utc).isoformat()
            except (ValueError,KeyError,TypeError,OverflowError):continue
            category,reason=classify_news(title)
            related=[t for t in str(item.get('related','')).split(',') if re.fullmatch('[A-Z][A-Z0-9.-]{0,14}',t)]
            news.append(dict(id=str(item.get('id','')),headline=title[:300],url=url,published_at=published,source=str(item.get('source') or 'Publisher'),category=category,reason=reason,tickers=related))
        news=sorted(news,key=lambda n:(n['category']!='Market news',n['published_at']),reverse=True)[:20]
    except Exception as exc:
        reason=str(exc) if isinstance(exc,ValueError) else type(exc).__name__
        event('capital','news','WARN',reason);warnings.append('News: '+reason);news=old.get('news',[])
    # Only exact normalized issuer matches create company links. No fuzzy identity guesses.
    core=load_json(out/'core.json',{})
    normalize=lambda n:re.sub('[^A-Z0-9]','',str(n).upper())
    names={normalize(r.get('n')):r['t'] for r in core.get('rows',[]) if r.get('n')}
    for manager in managers:
        for row in manager['changes']:row['ticker']=names.get(normalize(row['issuer']))
    result=dict(schema='smartoptions.capital.v1',generated_at=datetime.now(timezone.utc).isoformat(),
      status='degraded' if warnings else 'ok',warnings=warnings,managers=managers,news=news,
      methods=dict(holdings=SEC_GUIDE,news='https://finnhub.io/docs/api/market-news',
        interpretation='Price, volume, funding announcements and quarter-end holdings measure different things. None alone measures real-time net capital flows. News reasons describe possible mechanisms, not measured effects.'))
    write_json(target,result)
    print(json.dumps(dict(status=result['status'],managers=len(managers),holdings=sum(len(m['changes']) for m in managers),news=len(news),requests=collector.calls)))
    return result

def main():
    p=argparse.ArgumentParser();p.add_argument('--out',type=Path,default=ROOT/'app/data');p.add_argument('--cache',type=Path,default=ROOT/'data/cache/capital');p.add_argument('--offline',action='store_true');a=p.parse_args()
    try:build(a.out,a.cache,a.offline);return 0
    except Exception as exc:event('capital','build','FAIL',type(exc).__name__);print('Capital build failed; previous document retained');return 1
if __name__=='__main__':raise SystemExit(main())
