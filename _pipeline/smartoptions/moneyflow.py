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
from datetime import timedelta
from email.utils import parsedate_to_datetime
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

# Word-bounded topic rules, checked in order. A category names a possible channel; it never asserts an effect.
NEWS_RULES = (
  ('Deals', r'\b(acquir\w*|acquisition|merger|takeover|buyout)\b', 'A deal may change competitive pressure and financing needs; check the companies and terms.'),
  ('Earnings & guidance', r'\b(earnings|quarterly (profit|revenue|results)|guidance|beats|misses)\b', 'Reported results can test whether market expectations match operating performance.'),
  ('Rates & central banks', r'\b(fed|fomc|central bank|rate (cut|hike)s?|treasury yields?|bond yields?|inflation|bank of england|boe|ecb|boj)\b', 'Policy and yields can change discount rates and financing costs; exposure differs by company.'),
  ('Energy & commodities', r'\b(oil|crude|brent|opec|natural gas|gasoline|petrol|diesel|copper|gold)\b', 'Commodity prices can change input costs and producer revenue; the direction depends on the company.'),
  ('Geopolitics & trade', r'\b(war|strikes?|missiles?|military|sanctions?|tariffs?|export controls?|tankers?|hormuz|houthis?|projectiles?|attacks?)\b', 'Conflict and trade policy can change supply, costs and risk appetite; a headline alone does not measure the effect.'),
  ('Capital spending', r'\b(capex|capital (expenditure|spending)|data cent(er|re)s?|new (factory|plant))\b', 'New capacity can support suppliers, but returns depend on utilization and financing costs.'),
  ('Company action', r'\b(announces?|reports?|results|launch(es)?|unveils?|recalls?|lawsuit|settles?|ceo|layoffs?|dividend (increase|cut|declared)|buyback|upgrades?|downgrades?|q[1-4])\b', 'A company announcement can change the facts to check; it does not by itself establish a price effect.'),
  ('Investment & funding', r'\b(funding|venture|ipo)\b|\braises\b.*\bround\b', 'Funding signals an investor priority; it does not establish public-company revenue or returns.'),
)
PROMOTIONAL = re.compile(r"\b(stocks? to buy|buy (now|and hold)|millionaire|forever|should you|better buy|prediction:|is it time to|invested in|featured highlights|takeaways for|gets my|i'?d|i'?m|i will|my (top|favorite|sell|buy)|pick for|the one\b.*\bstock|hold for the next|only half the story|here'?s why|what to expect)|\?\s*$", re.I)
NEWS_LIMITS = dict(market=12, market_per_topic=3,official=5, company_per_symbol=2, company_symbols=8, window_days=4, official_window_days=30, older_after_hours=72)
# Source identity alone is insufficient for arbitrary tagged company articles. Only
# these established general-market desks bypass the topic taxonomy on the market feed.
AUTHORITATIVE_MARKET = {'reuters', 'bloomberg', 'associated press', 'ap', 'cnbc', 'marketwatch', 'financial times', 'the wall street journal'}
# A trusted publisher also carries parenting, travel and lifestyle articles.
# Unknown subjects remain welcome when the headline establishes economic or
# business relevance; publisher identity alone never establishes relevance.
BUSINESS_CONTEXT = re.compile(r'\b(markets?|stocks?|equities|shares?|bonds?|credit|debt|banks?|banking|lending|liquidity|settlement|clearing|currenc\w*|dollar|econom\w*|recession|employment|jobs?|wages?|consumer spending|retail sales|manufactur\w*|supply chain|shipping|freight|trade|exports?|imports?|regulat\w*|antitrust|industr\w*|business\w*|companies|corporat\w*|revenues?|profits?|valuation\w*|productivity|semiconductors?|chips?|artificial intelligence)\b', re.I)

def classify_news(headline):
    text=headline.lower()
    for label,pattern,reason in NEWS_RULES:
        if re.search(pattern,text): return label,reason
    return 'Market news','Context for investigation. A headline alone does not establish a change in fundamentals.'

def news_key(headline):
    """Deduplicate syndicated copies: drop a trailing publisher suffix and punctuation."""
    text=re.sub(r'\s+[-|]\s+(reuters|bloomberg|cnbc|ap|yahoo finance)\s*$','',headline.strip(),flags=re.I)
    return re.sub('[^a-z0-9]+',' ',text.lower()).strip()

def issuer_terms(name,ticker):
    """Exact issuer identity; ambiguous first words require the issuer phrase."""
    stop={'the','inc','corp','corporation','co','company','holdings','group','plc','ltd','class','incorporated'}
    words=[w for w in re.findall(r'[A-Za-z][A-Za-z&-]+',name or '') if w.lower() not in stop]
    ambiguous={'united','general','national','american','international','first','air','new','global','western','eastern','public'}
    term=(' '.join(words[:2]) if words and words[0].lower() in ambiguous else words[0] if words else '').lower()
    return {ticker.upper()}|({term} if len(term)>=3 else set())

def mentions(headline,terms):
    for term in terms:
        if term.isupper() and len(term)<=2:
            if re.search(r'\$'+re.escape(term)+r'\b|\('+re.escape(term)+r'\)|\b(?:NYSE|NASDAQ):\s*'+re.escape(term)+r'\b',headline):return True
        elif re.search(r'\b'+re.escape(term)+r'\b',headline if term.isupper() else headline.lower()):return True
    return False

def parse_fed_rss(text):
    items=[]
    # The feed starts with a BOM that requests may decode as Latin-1 text; parse from the first tag.
    for node in ET.fromstring(text[text.find('<'):]).iter('item'):
        title,link=(node.findtext('title') or '').strip(),(node.findtext('link') or '').strip()
        if not title or not link.startswith('https://www.federalreserve.gov/'):continue
        try:published=parsedate_to_datetime(node.findtext('pubDate')).astimezone(timezone.utc).isoformat()
        except (TypeError,ValueError):continue
        items.append(dict(id='fed:'+link.rsplit('/',1)[-1],headline=title[:300],url=link,published_at=published,source='Federal Reserve',
          category='Rates & central banks',reason='Official monetary-policy release. Read the release itself; any market reaction is not measured here.',tickers=[],scope='official'))
    return items

class Collector:
    def __init__(self,cache,offline=False,get=None,*,sleep=None,clock=None):
        self.cache,self.offline,self.get=Path(cache),offline,get or requests.get
        self.calls=0
        self.sleep,self.clock=sleep or time.sleep,clock or time.monotonic
        self.last_finnhub=None;self.finnhub_calls=0;self.last_retrieved_at=None
    def fetch(self,url,*,headers=None,params=None,ttl=21600):
        identity=url+'?'+json.dumps(params or {},sort_keys=True)
        path=self.cache/(hashlib.sha256(identity.encode()).hexdigest()+'.json')
        old=load_json(path,{}) if path.exists() else {}
        self.last_retrieved_at=datetime.fromtimestamp(old.get('fetched_epoch',0),timezone.utc).isoformat()
        if old.get('text') and time.time()-old.get('fetched_epoch',0)<ttl: return old['text']
        if self.offline:
            if old.get('text'): return old['text']
            raise ValueError('No cached source for offline build')
        is_finnhub=url.startswith('https://finnhub.io/api/v1/')
        for attempt in range(2):
            if self.calls>=32 or (is_finnhub and self.finnhub_calls>=12):raise ValueError('Collector request budget exceeded')
            if is_finnhub:
                # Existing quote account reserves 58/60 starts/min. At most two
                # news starts in any rolling minute, including retries and full builds.
                if self.last_finnhub is not None:self.sleep(max(0,31-(self.clock()-self.last_finnhub)))
                self.last_finnhub=self.clock();self.finnhub_calls+=1
            else:self.sleep(.22)
            self.calls+=1
            try:
                response=self.get(url,headers={'User-Agent':'SmartOptions Research contact soham.porwal@gmail.com',**(headers or {})},params=params,timeout=(5,15),allow_redirects=False)
            except requests.RequestException:
                if attempt:raise ValueError('Source network failure') from None
                self.sleep(2);continue
            if response.status_code==200:break
            if response.status_code not in (429,500,502,503,504) or attempt:raise ValueError('Source HTTP '+str(response.status_code))
            try:delay=float(getattr(response,'headers',{}).get('Retry-After',2))
            except (ValueError,TypeError):delay=2
            self.sleep(min(60,max(2,delay)))
        # Providers often omit a charset; requests then guesses Latin-1 and mangles curly quotes. Prefer UTF-8.
        try: text=response.content.decode('utf-8-sig')
        except (AttributeError,UnicodeDecodeError): text=response.text
        if not text.strip(): raise ValueError('Empty source response')
        fetched=time.time();self.last_retrieved_at=datetime.fromtimestamp(fetched,timezone.utc).isoformat()
        write_json(path,dict(text=text,fetched_epoch=fetched))
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

def collect_news(collector,key,offline,out,old,warnings,now):
    """Bounded market, official and shortlist-company items. Each source reports its own status and count."""
    core,brief=load_json(out/'core.json',{}),load_json(out/'brief.json',{})
    names={r['t']:r.get('n') for r in core.get('rows',[]) if r.get('t')}
    oldest=now-timedelta(days=NEWS_LIMITS['window_days'])
    sources,skipped={},dict(invalid=0,outside_window=0,promotional=0,off_topic=0,unrelated=0,duplicate=0,over_cap=0)
    def item(raw,scope,ticker=None):
        title,url=raw.get('headline'),raw.get('url')
        if not isinstance(title,str) or not isinstance(url,str) or not url.startswith('https://'):skipped['invalid']+=1;return None
        try:published=datetime.fromtimestamp(int(raw['datetime']),timezone.utc)
        except (ValueError,KeyError,TypeError,OverflowError):skipped['invalid']+=1;return None
        if published<oldest or published>now+timedelta(minutes=10):skipped['outside_window']+=1;return None
        if PROMOTIONAL.search(title):skipped['promotional']+=1;return None
        if ticker and not mentions(title,issuer_terms(names[ticker],ticker)):skipped['unrelated']+=1;return None
        category,reason=classify_news(title)
        related=[t for t in str(raw.get('related','')).split(',') if t in names and mentions(title,issuer_terms(names[t],t))]
        trusted=(scope=='market' and str(raw.get('source','')).strip().lower() in AUTHORITATIVE_MARKET
                 and BUSINESS_CONTEXT.search(title))
        if category=='Market news' and not (ticker or related or trusted):skipped['off_topic']+=1;return None
        if category=='Market news' and (ticker or related):category='Company development'
        return dict(id=str(raw.get('id','')),headline=title[:300],url=url,published_at=published.isoformat(),retrieved_at=collector.last_retrieved_at,
                    source=str(raw.get('source') or 'Publisher'),category=category,reason=reason,tickers=sorted(set(related)|({ticker} if ticker else set())),scope=scope)
    def finnhub(path,params):
        if not key and not offline:raise ValueError('Finnhub news key unavailable')
        rows=json.loads(collector.fetch('https://finnhub.io/api/v1/'+path,headers={'X-Finnhub-Token':key},params=params,ttl=600))
        if not isinstance(rows,list):raise ValueError('News response is not a list')
        return rows
    def market():
        return [x for x in (item(r,'market') for r in finnhub('news',{'category':'general'})) if x]
    def official():
        parsed=parse_fed_rss(collector.fetch('https://www.federalreserve.gov/feeds/press_monetary.xml',ttl=600))
        kept=[{**x,'retrieved_at':collector.last_retrieved_at} for x in parsed if (now-timedelta(days=30)).isoformat()<=x['published_at']<=(now+timedelta(minutes=10)).isoformat()]
        skipped['outside_window']+=len(parsed)-len(kept)
        return kept
    company_health={}
    def company():
        rows=[]
        for t in [x.get('t') for x in brief.get('shortlist') or [] if x.get('t') in names][:NEWS_LIMITS['company_symbols']]:
            try:
                kept=[x for x in (item(r,'company',t) for r in finnhub('company-news',{'symbol':t,'from':oldest.date().isoformat(),'to':now.date().isoformat()})) if x]
                company_health[t]=dict(status='ok' if kept else 'empty',retrieved_at=collector.last_retrieved_at)
                skipped['over_cap']+=max(0,len(kept)-NEWS_LIMITS['company_per_symbol'])
                rows+=sorted(kept,key=lambda n:n['published_at'],reverse=True)[:NEWS_LIMITS['company_per_symbol']]
            except Exception as exc:
                reason=str(exc) if isinstance(exc,ValueError) else type(exc).__name__
                company_health[t]=dict(status='failed',reason=reason)
                warnings.append(f'News (company {t}): {reason}');event('capital','news.company.'+t,'WARN',reason)
        return rows
    gathered=[]
    for name,action in (('market',market),('official',official),('company',company)):
        try:
            rows=action();gathered+=rows
            failed=sum(v['status']=='failed' for v in company_health.values()) if name=='company' else 0
            status=('failed' if failed==len(company_health) else 'partial') if failed else ('ok' if rows else 'empty')
            sources[name]=dict(status=status,count=len(rows),retrieved_at=collector.last_retrieved_at)
            if name=='company':
                sources[name]['symbols']=company_health
                sources[name]['retrieved_at']=min((v['retrieved_at'] for v in company_health.values() if v.get('retrieved_at')),default=None)
            event('capital','news.'+name,'WARN' if failed else 'OK' if rows else 'SUSPECT','dated relevant items kept',count=len(rows))
        except Exception as exc:
            reason=str(exc) if isinstance(exc,ValueError) else type(exc).__name__
            sources[name]=dict(status='failed',count=0,reason=reason)
            event('capital','news.'+name,'WARN',reason);warnings.append(f'News ({name}): {reason}')
    # Retain each failed source independently. Never renew its original dates or
    # keep expired items merely because a different source succeeded.
    retained=False
    for n in old.get('news') or []:
        scope=n.get('scope','market');state=sources.get(scope,{})
        failed=state.get('status')=='failed' or (scope=='company' and any(company_health.get(t,{}).get('status')=='failed' for t in n.get('tickers',[])))
        if not failed:continue
        try:published=datetime.fromisoformat(n['published_at'].replace('Z','+00:00'))
        except (KeyError,TypeError,ValueError):skipped['invalid']+=1;continue
        days=NEWS_LIMITS['official_window_days'] if scope=='official' else NEWS_LIMITS['window_days']
        if not now-timedelta(days=days)<=published<=now+timedelta(minutes=10):skipped['outside_window']+=1;continue
        gathered.append({**n,'retained':True,'retrieved_at':n.get('retrieved_at') or old.get('news_status',{}).get('retrieved_at')});retained=True
    seen,used,news=set(),{},[]
    caps=dict(market=NEWS_LIMITS['market'],official=NEWS_LIMITS['official'],company=NEWS_LIMITS['company_per_symbol']*NEWS_LIMITS['company_symbols'])
    for n in sorted(gathered,key=lambda n:n['published_at'],reverse=True):
        k=news_key(n['headline'])
        if k in seen:skipped['duplicate']+=1;continue
        seen.add(k)
        topic=(n['scope'],n['category'])
        if used.get(n['scope'],0)>=caps[n['scope']] or (n['scope']=='market' and used.get(topic,0)>=NEWS_LIMITS['market_per_topic']):skipped['over_cap']+=1;continue
        used[n['scope']]=used.get(n['scope'],0)+1;used[topic]=used.get(topic,0)+1;news.append(n)
    if retained:warnings.append('News: unexpired prior items retained for unavailable sources with original dates')
    return news,dict(retrieved_at=now.isoformat(timespec='seconds'),sources=sources,skipped=skipped,limits=NEWS_LIMITS,retained=retained)

def build(out,cache,offline=False,key=None,now=None):
    now=now or datetime.now(timezone.utc)
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
    news,news_status=collect_news(collector,key,offline,out,old,warnings,now)
    # Only exact normalized issuer matches create company links. No fuzzy identity guesses.
    core=load_json(out/'core.json',{})
    normalize=lambda n:re.sub('[^A-Z0-9]','',str(n).upper())
    names={normalize(r.get('n')):r['t'] for r in core.get('rows',[]) if r.get('n')}
    for manager in managers:
        for row in manager['changes']:row['ticker']=names.get(normalize(row['issuer']))
    result=dict(schema='smartoptions.capital.v1',generated_at=datetime.now(timezone.utc).isoformat(),
      status='degraded' if warnings else 'ok',warnings=warnings,managers=managers,news=news,news_status=news_status,
      methods=dict(holdings=SEC_GUIDE,news='https://finnhub.io/docs/api/market-news',company_news='https://finnhub.io/docs/api/company-news',
        official='https://www.federalreserve.gov/feeds/feeds.htm',
        relevance='Issuer-matched company developments and established market desks can introduce new topics. Promotional articles are dropped and copies deduplicated. Market/company items expire after four days; official releases after 30 days. Publication and upstream retrieval dates remain separate; items over 72 hours are older context.',
        interpretation='Price, volume, funding announcements and quarter-end holdings measure different things. None alone measures real-time net capital flows. News reasons describe possible mechanisms, not measured effects.'))
    write_json(target,result)
    print(json.dumps(dict(status=result['status'],managers=len(managers),holdings=sum(len(m['changes']) for m in managers),news=len(news),requests=collector.calls)))
    return result

def main():
    p=argparse.ArgumentParser();p.add_argument('--out',type=Path,default=ROOT/'app/data');p.add_argument('--cache',type=Path,default=ROOT/'data/cache/capital');p.add_argument('--offline',action='store_true');a=p.parse_args()
    try:build(a.out,a.cache,a.offline);return 0
    except Exception as exc:event('capital','build','FAIL',type(exc).__name__);print('Capital build failed; previous document retained');return 1
if __name__=='__main__':raise SystemExit(main())
