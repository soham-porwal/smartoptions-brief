"""Runtime contract verifier. Refuse malformed, non-finite or oversize publications."""
import json
import math
from datetime import date

from .common import CARDS, STATUSES, parsed


class BriefValidationError(ValueError):
    """Safe, bounded diagnostics; never include arbitrary provider text or URLs."""
    def __init__(self, message):
        self.code = 'BRIEF_' + message.split(':')[0].split(' asof=')[0].upper().replace(' ', '_').replace('>=', 'GE')[:64]
        self.context = {}
        super().__init__('Brief contract: ' + message)


def require(condition,message):
    if not condition:raise BriefValidationError(message)


def metric(m):
    require(isinstance(m,dict),'Metric must be an object')
    require(all(k in m for k in ('label','value','unit','period','asof','source','source_url','note')),'Metric keys')
    require(all(isinstance(m[k],str) for k in ('label','unit','period','source','source_url','note')),'Metric strings')
    require(bool(m['label']) and bool(m['source']) and bool(m['period']),'Metric provenance')
    require(m['value'] is None or (m['asof'] and parsed(m['asof']) is not None and m['source_url'].startswith('https://')),'Observed values require dated source URL: '+m['label']+' asof='+str(m['asof'])+' url='+m['source_url'])
    require(m['value'] is not None or bool(m['note']),'Missing Metric requires reason')


def assessment(obj,statuses):
    require(obj.get('status') in statuses,'assessment status '+str(obj.get('status')))
    require(isinstance(obj.get('line'),str) and bool(obj['line']),'assessment line')
    require(len(obj['line'].split())<=14,'assessment exceeds 14 words: '+obj['line'])
    require(isinstance(obj.get('metrics'),list) and bool(obj['metrics']),'assessment metrics')
    for m in obj['metrics']:metric(m)


def bullet(b):
    require(b.get('tone') in ('good','neutral','bad'),'Bullet tone')
    require(isinstance(b.get('text'),str) and 0<len(b['text'].split())<=14,'Bullet word count: '+str(b.get('text')))
    require(bool(b.get('metrics')),'Bullet metrics')
    for m in b['metrics']:metric(m)


def validate_company(c):
    require(c.get('schema')=='brief.company.v1','company schema')
    require(all(k in c for k in ('t','name','sector','asof','summary','cards','technical','events','options')),'company keys')
    date.fromisoformat(c['asof'])
    require(set(c['cards'])==set(CARDS),'seven company cards')
    for v in c['cards'].values():assessment(v,STATUSES)
    assessment(c['technical'],STATUSES)
    require('line' in c['events'] and isinstance(c['events'].get('items'),list),'company events')
    require('line' in c['options'] and 'strategy_hint' in c['options'],'options keys')
    require(len(json.dumps(c,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode())<12000,'company size >= 12KB')


def validate_brief(b):
    require(b.get('schema')=='brief.v1','brief schema')
    require(all(k in b for k in ('asof_session','generated_at','health','pulse','macro','risks','positioning','shortlist')),'brief keys')
    date.fromisoformat(b['asof_session'])
    require(isinstance(b['generated_at'],str) and parsed(b['generated_at']) is not None,'generated_at ISO timestamp')
    health=b['health'];require(health.get('overall') in ('fresh','delayed','stale'),'health overall')
    require(bool(health.get('line')) and isinstance(health.get('sources'),list),'health line/sources')
    for s in health['sources']:
        require(all(k in s for k in ('id','label','asof','age_hours','status','note')),'health source keys')
        require(s['status'] in ('fresh','delayed','stale','missing'),'freshness vocabulary')
        require(s['age_hours'] is None or s['age_hours']>=0,'source age')
    require(all(k in health['screener'] for k in ('label','asof','age_days','status','note')),'screener keys')
    p=b['pulse'];require(p.get('status') in ('supportive','mixed','adverse'),'pulse status')
    for k in ('changed','supports','challenges'):
        require(len(p[k])<=3,'pulse count')
        for obj in p[k]:bullet(obj)
    m=b['macro']
    for k,vocab in [('price_trend',('supportive','mixed','adverse')),('participation',('broadening','mixed','narrowing')),('risk',('calm','elevated','stressed','incomplete'))]:assessment(m[k],vocab)
    for k in ('price_trend','backdrop','risk'):
        obj=m[k]
        if 'observed_status' in obj:
            require(obj.get('coverage') in ('complete','partial','unavailable') and isinstance(obj.get('missing'),list) and bool(obj.get('rule')) and isinstance(obj.get('inputs'),list),'normalized assessment metadata')
            require(obj['observed_status'] is not None or obj['coverage']!='complete','missing assessment cannot be complete')
    require(m['backdrop']['status'] in ('supportive','mixed','adverse'),'backdrop status')
    for k in ('growth','inflation','policy'):
        require(m['backdrop'][k]['direction'] in ('up','flat','down'),'direction vocabulary')
        require(len(m['backdrop'][k]['line'].split())<=14,'direction word count')
    require(len(m['detail'])==8,'macro group coverage')
    for d in m['detail']:
        require(d['group'] in ('inflation','labor','growth','policy','curve','cross_asset','credit_funding','volatility'),'macro group')
        for obj in d['metrics']:metric(obj)
    for r in b['risks']:
        require(all(k in r for k in ('when_et','kind','title','why','tickers','watchlist','importance','metrics')),'risk keys')
        require(parsed(r['when_et']) is not None,'risk date')
        if 'timing' in r:
            require(r['timing'] in ('timed','date_only','bmo','amc'),'risk timing vocabulary')
            # A date-only event is a calendar date, never an instant (no implied midnight).
            if r['timing']!='timed':date.fromisoformat(r['when_et'])
            else:require('T' in r['when_et'],'timed risk needs a time')
        require(r['kind'] in ('macro','earnings') and r['importance'] in (1,2,3),'risk vocab')
        require(len(r['why'].split())<=14,'risk why word count')
        for obj in r['metrics']:metric(obj)
    pos=b['positioning'];assessment(pos['breadth'],('broadening','mixed','narrowing'))
    for k in ('concentration','rotation'):assessment(pos[k],('supportive','mixed','adverse'))
    require(all(k in pos['concentration'] for k in ('top10_share_pct','eq_vs_cap_20d_pp')),'concentration keys')
    for s in pos['sectors']:require(all(k in s for k in ('sector','n','mcap','d1','d5','m1')),'sector keys')
    require(len(b['shortlist'])<=8,'shortlist maximum')
    for s in b['shortlist']:
        require(all(k in s for k in ('t','name','sector','score','score_basis','why','counter','status')),'shortlist keys')
        require(0<=s['score']<=100 and 2<=len(s['why'])<=3,'shortlist score/reasons')
        require(set(s['status'])==set(CARDS) and all(v in STATUSES for v in s['status'].values()),'shortlist statuses')
        for obj in s['why']+[s['counter']]:bullet(obj)
    if 'daily_changes' in b:daily_changes(b['daily_changes'],b['asof_session'])
    if 'calendar_coverage' in b:calendar_coverage(b['calendar_coverage'],b['asof_session'])
    if 'risk_events' in m:require(m['risk_events'].get('status') in ('scheduled','none_major') and isinstance(m['risk_events'].get('major'),int),'risk_events')
    if 'level' in pos['breadth']:require(pos['breadth']['level'] in ('broad','mixed','thin','unavailable'),'participation level vocabulary')
    require(len(json.dumps(b,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode())<150000,'brief size >= 150KB')


def change_item(x):
    require(all(k in x for k in ('id','label','unit','current','prior','change','comparison','direction','status','reason','source','source_url')),'change keys')
    require(x['status'] in ('ok','unavailable'),'change status')
    if x['status']=='unavailable':
        require(bool(x['reason']) and x['direction'] is None and x['change'] is None,'unavailable change needs reason and no direction')
        return
    cur,pri=x['current'],x['prior']
    require(isinstance(cur,dict) and isinstance(pri,dict),'ok change needs current and prior')
    for v in (cur['value'],pri['value'],x['change']):require(isinstance(v,(int,float)) and math.isfinite(v),'change values finite: '+x['id'])
    require(date.fromisoformat(pri['date'])<date.fromisoformat(cur['date']),'prior date precedes current: '+x['id'])
    require(abs(x['change']-(cur['value']-pri['value']))<1e-3,'change equals current minus prior: '+x['id'])
    require(x['direction'] in ('up','down','flat'),'direction requires both values')
    require(x['source_url'].startswith('https://'),'change source url')
    if x['unit']=='pp' and x['id'].startswith('breadth'):
        cohort=x.get('cohort') or {};n=cohort.get('n',0)
        require(n>0 and n>=.9*cohort.get('universe',n) and cohort.get('excluded',0)+n==cohort.get('universe',n),'breadth comparable cohort coverage')
        if 'counts' in x:
            for side in ('current','prior'):
                count=x['counts'].get(side)
                require(isinstance(count,int) and 0<=count<=n and abs(x[side]['value']-100*count/n)<.00011,'breadth counts reconcile to shares')


def daily_changes(d,session):
    require(d.get('status') in ('ok','partial','unavailable'),'daily_changes status')
    require(isinstance(d.get('items'),list),'daily_changes items')
    for x in d['items']+list(d.get('macro') or []):change_item(x)
    ok=sum(x['status']=='ok' for x in d['items'])
    require((d['status']=='ok')==(ok==len(d['items']) and ok>0),'daily_changes status matches items')
    require(d['status']!='unavailable' or bool(d.get('reason')),'unavailable daily_changes needs reason')
    for x in d['items']:
        if x['status']=='ok':require(x['current']['date']==session,'change current date is the brief session: '+x['id'])
    ids=[x['id'] for x in d['items']]
    require(len(ids)==len(set(ids)),'unique market change identities')
    spy=next((x for x in d['items'] if x['id']=='spy_1d' and x['status']=='ok'),None)
    daily=next((x for x in d['items'] if x['id']=='breadth_50_1d' and x['status']=='ok'),None)
    if daily:
        require(spy and daily['prior']['date']==spy['prior']['date'],'daily breadth shares SPY endpoints')
        require(daily['cohort']['n']>=.9*daily['cohort']['universe'],'daily breadth coverage >=90%')


def calendar_coverage(c,session):
    require(c.get('status') in ('ok','partial','unavailable','expired'),'calendar coverage status')
    for s in c.get('sources') or []:
        require(s.get('kind') in ('macro','earnings') and s.get('status') in ('ok','partial','unavailable','expired'),'coverage source vocab')
        if s.get('range_end'):require(s['status']=='expired' or s['range_end']>=session,'coverage ending before the session must be expired')
