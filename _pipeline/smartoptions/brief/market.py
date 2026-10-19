"""Market assessments from retained observations, with explicit universe coverage."""
from __future__ import annotations

from datetime import date, datetime, timedelta
from statistics import mean
from zoneinfo import ZoneInfo

from .common import bullet, card, metric, number, parsed

GROUPS = ('inflation','labor','growth','policy','curve','cross_asset','credit_funding','volatility')


def obs_metric(obs):
    ok = obs.get('status') in ('ok', None)
    out = metric(obs.get('label','Not available'), obs.get('v') if ok else None,
                  obs.get('unit',''), obs.get('period'), obs.get('retrieved_at') or obs.get('date'),
                  obs.get('provider') or 'Retained macro observation', obs.get('url') or '',
                  obs.get('note') or ('' if ok else 'Observation is '+str(obs.get('status'))))
    out.update(observation_date=obs.get('date'), retrieved_at=obs.get('retrieved_at'), observation_status=obs.get('status'))
    return out


def observation(core, id_):
    return next((x for arr in core.get('macro',{}).values() for x in arr if x.get('id')==id_), {})


def value(core, id_):
    o = observation(core,id_)
    v = number(o.get('v')) if o.get('status') in ('ok',None) else None
    h = o.get('h') or []
    if h and (h[-1][0] != o.get('date') or number(h[-1][1]) is None or v is None or abs(h[-1][1]-v)>1e-6): return None
    return v


def history(core,id_):
    o = observation(core,id_)
    h = [(d,number(v)) for d,v in o.get('h',[]) if number(v) is not None]
    if value(core,id_) is None or not h or h[-1][0] != o.get('date') or abs(h[-1][1]-value(core,id_)) > 1e-6 or any(a[0] >= b[0] for a,b in zip(h,h[1:])):
        return []
    return h


def validity(obj, status, missing, rule, core, ids=()):
    obj.update(observed_status=status, coverage='partial' if missing else 'complete', missing=missing, rule=rule,
               inputs=[dict(id=k, observation_date=observation(core,k).get('date'), retrieved_at=observation(core,k).get('retrieved_at'), status=observation(core,k).get('status')) for k in ids])
    return obj


def annualized_3m(core,id_):
    h = history(core,id_)
    if len(h)<3:return None
    # Require actual consecutive calendar months, not merely three available rows.
    months = [date.fromisoformat(d).year*12+date.fromisoformat(d).month for d,_ in h[-3:]]
    if months[1]-months[0] != 1 or months[2]-months[1] != 1:return None
    product = 1
    for _,v in h[-3:]: product *= 1+v/100
    return (product**4-1)*100


def trend_delta(core,id_,n=3):
    h=history(core,id_)
    return h[-1][1]-h[-n-1][1] if len(h)>n else None


def build_risks(core, rows, now, watchlist=()):
    et=ZoneInfo('America/New_York'); start=now.astimezone(et); end=start+timedelta(days=7)
    why={'CPI':'Inflation can change rate expectations and equity valuations.',
         'PPI':'Producer prices can signal pressure on margins and inflation.',
         'PCE':'The inflation reading can change expectations for policy rates.',
         'NFP':'Hiring and wages can change growth and rate expectations.',
         'GDP':'Growth revisions can change earnings and policy expectations.',
         'FOMC':'The rate decision can change borrowing costs and valuations.',
         'EIA':'Inventory changes can move oil prices and energy shares.'}
    risks=[]
    for e in core.get('calendar',[]):
        when=parsed(e.get('scheduled_et'))
        # One horizon rule for macro and earnings: ET calendar dates today..today+7; a timed event earlier today has passed.
        if when is None or not start.date()<=when.astimezone(et).date()<=end.date() or when<now:continue
        if e.get('status')=='released':continue
        risks.append(dict(when_et=e['scheduled_et'],kind='macro',timing='timed' if 'T' in str(e['scheduled_et']) else 'date_only',title=e.get('title') or e.get('type','Release'),
                          why=why.get(e.get('type'),'The release can change growth, inflation or policy expectations.'),tickers=[],watchlist=False,
                          importance=1 if e.get('type')=='EIA' else 3,
                          metrics=[metric('Scheduled release',e['scheduled_et'],'ET timestamp',e['scheduled_et'],core.get('gen',{}).get('macro'),
                                          'Published release calendar',e.get('source_url') or '',e.get('note') or 'Scheduled; timing can change')]))
    for r in rows:
        er=r.get('er')
        if not er:continue
        try:d=date.fromisoformat(er)
        except ValueError:continue
        # Date-only earnings remain date-only; never fabricate midnight/BMO/AMC times.
        if not start.date()<=d<=end.date():continue
        ert=r.get('ert') if r.get('ert') in ('BMO','AMC') else None   # anything else is treated as date-only
        # Threshold choice (documented in BRIEF-METHODS): a same-day before-open report is dropped from 10:00 ET.
        if d==start.date() and ert=='BMO' and start.hour>=10:continue
        risks.append(dict(when_et=er,kind='earnings',timing={'BMO':'bmo','AMC':'amc'}.get(ert,'date_only'),title=r['t']+' earnings',why='Results and guidance can reset earnings expectations and option prices.',
                          tickers=[r['t']],watchlist=r['t'] in watchlist,importance=3 if r['t'] in watchlist else 2,
                          metrics=[metric('Expected earnings date',er,'ET date',er,r.get('rat'),r.get('ers') or 'Yahoo Finance',
                                          f"https://finance.yahoo.com/quote/{r['t']}/calendar/",'Provider estimate; '+(r.get('ert') or 'time not confirmed'))]))
    return sorted(risks,key=lambda x:(not x['watchlist'], -x['importance'],x['when_et'],x['title']))


def positioning(core,rows,prices,cfg,membership=None):
    session=core['asof_session']; stamp=core.get('gen',{}).get('equities')
    constituents=set((membership or {}).get('symbols',[]))
    selected=[r for r in rows if not constituents or r['t'].replace('.','-') in constituents]
    scope=f"Verified S&P coverage ({len(selected)}/{len(constituents)} constituents)" if constituents else 'Exported universe; S&P membership not verified'
    def met(label,v,unit,period='Latest completed session',note=''):
        return metric(label,v,unit,period+' to '+session,stamp,url='https://finance.yahoo.com/',note=scope+('; '+note if note else ''))
    sectors=[]
    for s in sorted({r.get('sec') or 'Not available' for r in selected}):
        group=[r for r in selected if (r.get('sec') or 'Not available')==s]
        capital=sum(number(r.get('mcap')) or 0 for r in group)
        returns={}
        for k in ('d1','d5','m1'):
            covered=[r for r in group if number(r.get(k)) is not None and (number(r.get('mcap')) or 0)>0]
            denom=sum(r['mcap'] for r in covered)
            returns[k]=round(sum(r[k]*r['mcap'] for r in covered)/denom,4) if denom else None
        sectors.append(dict(sector=s,n=len(group),mcap=capital or None,**returns))
    counts={50:[],200:[]}; return20={}; newhi=newlo=0; highlow_n=0
    for r in selected:
        bars=[b for b in prices.get(r['t'],{}).get('bars',[]) if b[0]<=session and number(b[4]) is not None]
        if not bars or bars[-1][0]!=session:continue
        closes=[b[4] for b in bars]
        for n in counts:
            if len(closes)>=n:counts[n].append(closes[-1]>mean(closes[-n:]))
        if len(closes)>=21 and closes[-21]>0:return20[r['t']]=(closes[-1]/closes[-21]-1)*100
        if len(bars)>=252:
            highlow_n+=1
            newhi+=int(bars[-1][2]>=max(b[2] for b in bars[-252:-1]))
            newlo+=int(bars[-1][3]<=min(b[3] for b in bars[-252:-1]))
    share={n:round(sum(v)/len(v)*100,2) if v else None for n,v in counts.items()}
    breadth_status='broadening' if all(v is not None and v>=cfg['breadth_strong'] for v in share.values()) else 'narrowing' if all(v is not None and v<cfg['breadth_weak'] for v in share.values()) else 'mixed'
    bm=[met('Above 50-session average',share[50],'%',period='50-session average',note=f'{sum(counts[50])} of {len(counts[50])} names with matched-session history; {len(selected)-len(counts[50])} unavailable'),
        met('Above 200-session average',share[200],'%',period='200-session average',note=f'{sum(counts[200])} of {len(counts[200])} names with matched-session history; {len(selected)-len(counts[200])} unavailable'),
        met('New 252-session highs',newhi if highlow_n else None,'names',note=f'{highlow_n} histories available'),
        met('New 252-session lows',newlo if highlow_n else None,'names',note=f'{highlow_n} histories available')]
    line=f"{share[50]:.2f}% ({sum(counts[50])} of {len(counts[50])} names) exceed their 50-session average." if share[50] is not None else 'Not available: matched price histories are missing'
    breadth=card(breadth_status,line,bm)
    # status keeps the historical level rule (validator vocabulary); the presenter uses level words until a dated change exists.
    from .changes import participation_level
    breadth.update(participation_level(share[50],share[200]))
    caps=[r for r in selected if (number(r.get('mcap')) or 0)>0]
    capsum=sum(r['mcap'] for r in caps);top=sorted(caps,key=lambda r:r['mcap'],reverse=True)[:10]
    share10=round(sum(r['mcap'] for r in top)/capsum*100,2) if capsum else None
    rel=core.get('rel',{}).get('vol_breadth',{}).get('breadth_rsp_spy_20d',{})
    gap=number(rel.get('value')) if rel.get('status')=='ok' else None
    hist=rel.get('history') or []
    gap_asof=hist[-1][0] if hist else None
    # Require all top-ten histories; incomplete contributions must not become zeros.
    contribution=sum(r['mcap']/capsum*return20[r['t']] for r in top) if capsum and len(top)==10 and all(r['t'] in return20 for r in top) else None
    concentration=dict(status='adverse' if share10 is not None and share10>cfg['concentration_pct'] and gap is not None and gap<-cfg['eq_gap_pp'] else 'mixed',
                       line=f"The largest ten names hold {share10:.2f}% of covered market value." if share10 is not None else 'Not available: market capitalizations are missing',
                       top10_share_pct=round(share10,2) if share10 is not None else None,eq_vs_cap_20d_pp=gap,
                       metrics=[met('Top-ten market-cap share',share10,'%',note=f'{len(caps)} of {len(selected)} names have market caps; current provider capitalization, not official float-adjusted index weights; issuer caps may repeat across share classes'),
                                met('Top-ten contribution to universe return',contribution,'pp','20 sessions',note='Approximation using current weights and unadjusted closes; not actual S&P index contribution'),
                                metric('RSP minus SPY',gap,'pp','20 sessions to '+str(gap_asof),gap_asof,'Yahoo Finance via retained relations','https://finance.yahoo.com/quote/RSP/history/','ETF price-return gap; different coverage from company subset')])
    ordered=sorted((s for s in sectors if s['m1'] is not None),key=lambda s:s['m1'],reverse=True)
    leaders=[dict(sector=s['sector'],ret_20d_pct=s['m1']) for s in ordered[:2]]
    laggards=[dict(sector=s['sector'],ret_20d_pct=s['m1']) for s in ordered[-2:]]
    # The existing m1 field is 21 sessions; compute genuine 20-session sector returns.
    sector20={}
    for s in sectors:
        covered=[r for r in selected if r.get('sec')==s['sector'] and r['t'] in return20 and (number(r.get('mcap')) or 0)>0]
        denom=sum(r['mcap'] for r in covered)
        if denom:sector20[s['sector']]=sum(r['mcap']*return20[r['t']] for r in covered)/denom
    rank=sorted(sector20,key=sector20.get,reverse=True)
    leaders=[dict(sector=s,ret_20d_pct=round(sector20[s],4)) for s in rank[:2]]
    laggards=[dict(sector=s,ret_20d_pct=round(sector20[s],4)) for s in rank[-2:]]
    rotation=dict(status='mixed',line=f"{rank[0]} leads; {rank[-1]} trails over 20 sessions." if rank else 'Not available: sector return histories are missing',leaders=leaders,laggards=laggards,
                  metrics=[met(s,sector20[s],'%','20 sessions','Current-cap-weighted unadjusted returns; descriptive rotation proxy') for s in rank])
    # Sector fields carry common provenance here because their compact contract has no Metric slots.
    rotation['metrics'].append(met('Sector snapshot coverage',len(selected),'names','1/5/21-session sector return windows','sectors[].mcap USD; d1/d5/m1 percent; current market-cap weights, available-return denominator'))
    return dict(breadth=breadth,concentration=concentration,rotation=rotation,sectors=sectors)


def macro_assessment(core,position,cfg,risks):
    session=core['asof_session'];spy=[(d,number(v)) for d,v in core.get('spy_close',[]) if d<=session and number(v) is not None]
    vals=[v for _,v in spy]
    trend_metrics=[]; state='mixed';line='Not available: 200 SPY closes are required'
    price_ok = len(vals)>=200 and spy[-1][0]==session and all(a[0]<b[0] for a,b in zip(spy,spy[1:])) and all(v>0 for v in vals)
    if price_ok:
        ma50,ma200=mean(vals[-50:]),mean(vals[-200:]); recent=vals[-63:];xbar=(len(recent)-1)/2
        slope=sum((i-xbar)*(v-mean(recent)) for i,v in enumerate(recent))/sum((i-xbar)**2 for i in range(len(recent)))/mean(recent)*100
        state='supportive' if vals[-1]>ma50>ma200 and slope>0 else 'adverse' if vals[-1]<ma50<ma200 and slope<0 else 'mixed'
        line='SPY is above both averages with a rising three-month trend.' if state=='supportive' else 'SPY is below both averages with a falling three-month trend.' if state=='adverse' else 'SPY price and its longer trend give mixed readings.'
        for label,v,unit,period in [('SPY close',vals[-1],'USD/share',spy[-1][0]),('SPY 50-session average',ma50,'USD/share','50 sessions'),('SPY 200-session average',ma200,'USD/share','200 sessions'),('SPY three-month regression slope',slope,'% per session','63 sessions'),('SPY previous-session change',(vals[-1]/vals[-2]-1)*100,'%','1 session')]:
            trend_metrics.append(metric(label,v,unit,period+' to '+spy[-1][0],spy[-1][0],url='https://finance.yahoo.com/quote/SPY/history/',note='Retained SPY close series; unadjusted'))
    else:trend_metrics=[metric('SPY history',None,'sessions','200 sessions',session,note='Not enough SPY history')]
    price=card(state,line,trend_metrics)
    validity(price,state if price_ok else None,[] if price_ok else ['200 ordered usable SPY closes ending at declared session required'],'close > MA50 > MA200 and positive 63-session slope: supportive; inverse: adverse; otherwise mixed',core)
    gdp,pay=value(core,'real_gdp_saar'),value(core,'payrolls')
    gdph=history(core,'real_gdp_saar');payh=history(core,'payrolls')
    gdp_change=gdph[-1][1]-gdph[-2][1] if len(gdph)>=2 and gdp is not None else None
    pay_recent=mean(v for _,v in payh[-3:]) if len(payh)>=6 and pay is not None else None
    pay_previous=mean(v for _,v in payh[-6:-3]) if len(payh)>=6 and pay is not None else None
    pay_change=pay_recent-pay_previous if pay_recent is not None else None
    growth_dir='up' if gdp_change is not None and pay_change is not None and gdp_change>cfg['gdp_acceleration_pp'] and pay_change>cfg['payroll_acceleration_thousands'] else 'down' if gdp_change is not None and pay_change is not None and gdp_change<-cfg['gdp_acceleration_pp'] and pay_change<-cfg['payroll_acceleration_thousands'] else 'flat'
    growth_line=f"GDP grew {gdp:.1f}% annualized; payrolls added {pay:.0f} thousand." if gdp is not None and pay is not None else 'Not available: GDP or payroll observations missing'
    annuals=[annualized_3m(core,k) for k in ['cpi_headline_mom','pce_headline_mom']]
    yoy=[value(core,k) for k in ['cpi_headline','pce_headline']]
    gaps=[a-b for a,b in zip(annuals,yoy) if a is not None and b is not None]
    inflation_dir='up' if len(gaps)==2 and min(gaps)>cfg['inflation_flat_pp'] else 'down' if len(gaps)==2 and max(gaps)<-cfg['inflation_flat_pp'] else 'flat'
    inflation_line='Three-month inflation is running above the twelve-month pace.' if inflation_dir=='up' else 'Three-month inflation is running below the twelve-month pace.' if inflation_dir=='down' else 'Inflation horizons differ or provide incomplete readings.'
    fed_delta=trend_delta(core,'effective_fed_funds',20)
    policy_dir='up' if fed_delta is not None and fed_delta>cfg['policy_change_pp'] else 'down' if fed_delta is not None and fed_delta<-cfg['policy_change_pp'] else 'flat'
    policy_line='Effective policy rates rose over 20 observations.' if policy_dir=='up' else 'Effective policy rates fell over 20 observations.' if policy_dir=='down' else 'Effective policy rates changed little or lack comparable observations.'
    bs='supportive' if growth_dir=='up' and inflation_dir=='down' and policy_dir!='up' else 'adverse' if growth_dir=='down' or (inflation_dir=='up' and policy_dir=='up') else 'mixed'
    backdrop=dict(status=bs,growth=dict(direction=growth_dir,line=growth_line,available=gdp_change is not None and pay_change is not None),inflation=dict(direction=inflation_dir,line=inflation_line,available=len(gaps)==2),policy=dict(direction=policy_dir,line=policy_line,available=fed_delta is not None),line='Growth, inflation and policy do not all point the same way.' if bs=='mixed' else 'Growth and policy conditions support the market.' if bs=='supportive' else 'Growth or tightening conditions challenge the market.')
    missing_backdrop=[k+' current source/history unavailable or stale' for k in ('growth','inflation','policy') if not backdrop[k]['available']]
    validity(backdrop,bs if not missing_backdrop else None,missing_backdrop,'Existing GDP/payroll acceleration, inflation horizons and 20-observation policy rules; all three required',core,('real_gdp_saar','payrolls','cpi_headline','pce_headline','cpi_headline_mom','pce_headline_mom','effective_fed_funds'))
    if missing_backdrop: backdrop['line']='Not available: growth, inflation or policy evidence is incomplete.'
    vix,hy=value(core,'vix'),value(core,'hy_oas');vixh=history(core,'vix');hych=trend_delta(core,'hy_oas',20)
    pct=sum(v<=vix for _,v in vixh)/len(vixh)*100 if vix is not None and vixh else None
    v3=value(core,'vix3m');term=vix/v3 if vix is not None and v3 is not None and v3>0 and observation(core,'vix').get('date')==observation(core,'vix3m').get('date') else None
    n_major=sum(r['kind']=='macro' and r['importance']==3 for r in risks)
    stressed=(vix is not None and vix>=cfg['vix_stressed']) or (hy is not None and hy>=cfg['hy_stressed_bps'])
    elevated=(vix is not None and vix>=cfg['vix_elevated']) or (hy is not None and hy>=cfg['hy_elevated_bps']) or (hych is not None and hych>=cfg['hy_change_elevated_bps']) or (term is not None and term>1)
    missing_risk=[k+' unavailable or stale' for k,v in [('VIX',vix),('HY OAS',hy),('matched term ratio',term),('HY 20-observation history',hych)] if v is None]
    risk_state='stressed' if stressed else 'elevated' if elevated else 'calm' if not missing_risk else 'incomplete'
    rm=[obs_metric(observation(core,k)) for k in ['vix','hy_oas']]
    rm += [metric('VIX percentile',pct,'percentile','Available daily history ('+str(len(vixh))+' observations)',observation(core,'vix').get('date'), 'Cboe via retained macro data',observation(core,'vix').get('url','')),
           metric('VIX / VIX3M',term,'x','Matched observation dates',observation(core,'vix').get('date'),'Cboe via retained macro data',observation(core,'vix').get('url',''), 'Term comparison requires same dates'),
           metric('HY OAS change',hych,'bps','20 observations',observation(core,'hy_oas').get('date'),'ICE via FRED','https://fred.stlouisfed.org/series/BAMLH0A0HYM2'),
           metric('Major macro releases',n_major,'events','Next seven days',session,'Retained release calendar','https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm')]
    if vix is not None and vix>=cfg['vix_stressed']:
        risk_line=f'VIX is {vix:.1f}, above the stress threshold.'
    elif hy is not None and hy>=cfg['hy_stressed_bps']:
        risk_line=f'High-yield spreads are {hy:.0f} basis points, above the stress threshold.'
        rm=[rm[1]]+rm[:1]+rm[2:]
    elif vix is not None and vix>=cfg['vix_elevated']:
        risk_line=f'VIX is {vix:.1f}, above the volatility threshold.'
    elif hy is not None and hy>=cfg['hy_elevated_bps']:
        risk_line=f'High-yield spreads are {hy:.0f} basis points.'
        rm=[rm[1]]+rm[:1]+rm[2:]
    elif hych is not None and hych>=cfg['hy_change_elevated_bps']:
        risk_line=f'High-yield spreads widened {hych:.0f} basis points over 20 observations.'
        rm=[rm[4],rm[1],rm[0],rm[2],rm[3],rm[5]]
    elif term is not None and term>1:
        risk_line=f'Near-term volatility exceeds three-month volatility by {(term-1)*100:.1f}%.'
        rm=[rm[3]]+rm[:3]+rm[4:]
    else:
        risk_line='Volatility and credit inputs are calm.' if risk_state=='calm' else 'Not available: some risk observations are missing'
    risk=card(risk_state,risk_line,rm)
    validity(risk,{'stressed':'high','elevated':'elevated','calm':'normal'}.get(risk_state),missing_risk,'VIX >=30 or HY >=600bp: high; VIX >=20, HY >=450bp, usable HY widening >=30bp or matched term ratio >1: elevated; complete below thresholds: normal',core,('vix','vix3m','hy_oas'))
    details=[]
    for group in GROUPS:
        observations=core.get('macro',{}).get(group,[])
        metrics=[obs_metric(o) for o in observations if not o.get('id','').endswith(('bps_chg','ret_1d','ret_5d'))][:6]
        trend=core.get('rel',{}).get('trends',{}).get(group,{}).get('label')
        text=backdrop['inflation']['line'] if group=='inflation' else growth_line if group=='growth' else policy_line if group=='policy' else f"{group.replace('_',' ').capitalize()} observations are {trend or 'not available'}."
        if group=='volatility':
            text=(f"VIX is {vix:.2f} points on {observation(core,'vix').get('date')}." if vix is not None else 'VIX is unavailable or stale.')
            if term is not None:
                text+=f' VIX / three-month volatility is {term:.2f} on matched dates.'
        if group=='credit_funding':
            text=(f"High-yield spreads are {hy:.0f} basis points on {observation(core,'hy_oas').get('date')}." if hy is not None else 'High-yield spreads are unavailable or stale.')
            if hych is not None:
                text+=f' Spreads {"widened" if hych>=0 else "narrowed"} {abs(hych):.0f} basis points over 20 observations.'
        if group=='inflation':
            for id_ in ('cpi_headline','pce_headline'):
                o=observation(core,id_)
                if o and not any(m['label']==o.get('label') for m in metrics):
                    metrics.append(obs_metric(o))
            metrics += [metric(label,a,'% annualized','Three months ending '+str(observation(core,id_).get('period')),observation(core,id_).get('retrieved_at'),observation(core,id_).get('provider','FRED'),observation(core,id_).get('url',''), 'Compounded three consecutive monthly changes, annualized') for label,a,id_ in zip(['CPI three-month pace','PCE three-month pace'],annuals,['cpi_headline_mom','pce_headline_mom'])]
        if group=='growth':
            metrics.append(obs_metric(observation(core,'payrolls')))
            for label,v,unit,period,id_ in [('GDP growth change',gdp_change,'pp','Latest quarter vs previous quarter','real_gdp_saar'),('Recent payroll average',pay_recent,'thousands per month','Latest three months','payrolls'),('Previous payroll average',pay_previous,'thousands per month','Previous three months','payrolls')]:
                o=observation(core,id_)
                metrics.append(metric(label,v,unit,period+' ending '+str(o.get('period')),o.get('retrieved_at'),o.get('provider') or 'FRED',o.get('url') or '', 'Growth direction uses GDP acceleration and three-month hiring changes'))
        if group=='policy':
            fed=observation(core,'effective_fed_funds'); fedh=history(core,'effective_fed_funds')
            metrics.append(metric('Effective policy rate change',fed_delta,'pp','20 observations',fed.get('retrieved_at'),fed.get('provider') or 'FRED',fed.get('url') or '', 'Latest rate minus the rate twenty observations earlier'))
            if len(fedh)>=21:
                for label,point in [('Policy comparison start',fedh[-21]),('Policy comparison end',fedh[-1])]:
                    metrics.append(metric(label,point[1],'%',point[0],fed.get('retrieved_at'),fed.get('provider') or 'FRED',fed.get('url') or ''))
            metrics.append(obs_metric(observation(core,'spread_10y_2y')))
            fomc=next((e for e in core.get('calendar',[]) if e.get('type')=='FOMC' and (e.get('scheduled_et') or '')[:10]>session),None)
            metrics.append(metric('Next FOMC',fomc.get('scheduled_et') if fomc else None,'ET timestamp','Next scheduled meeting',core.get('gen',{}).get('macro'),'Federal Reserve', 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm'))
        details.append(dict(group=group,line=text,metrics=metrics or [metric('Coverage',None,'','Not available',session,note='No observations for this group')]))
    for key in ('growth','inflation','policy'):
        backdrop[key]['metrics']=next(d['metrics'] for d in details if d['group']==key)
    # Scheduled releases are an event condition, never observed stress (kept separate from risk.status).
    n_events=sum(r['kind']=='macro' for r in risks)
    risk_events=dict(status='scheduled' if n_major else 'none_major',major=n_major,releases=n_events,horizon_days=7,
                     line=f'{n_major} major macro release{"s" if n_major!=1 else ""} in the next seven days.' if n_major else f'No major macro release listed in the next seven days; {n_events} other listed.',
                     metrics=[rm[-1]])
    return dict(price_trend=price,participation=position['breadth'],backdrop=backdrop,risk=risk,risk_events=risk_events,detail=details)


def session_label(asof):
    try:
        d=date.fromisoformat(str(asof)[:10])
        return f"{d:%b} {d.day}"
    except ValueError:
        return 'previous'


def pulse(macro):
    price=macro['price_trend'];supports=[];challenges=[]
    for obj in [price,macro['participation'],macro['risk']]:
        good=obj['status'] in ('supportive','broadening','calm');bad=obj['status'] in ('adverse','narrowing','stressed','elevated')
        if good:supports.append(bullet(obj['line'],obj['metrics'],'good'))
        elif bad:challenges.append(bullet(obj['line'],obj['metrics'],'bad'))
    for detail in macro['detail']:
        if detail['group']=='inflation' and macro['backdrop']['inflation']['direction']=='up':challenges.append(bullet(detail['line'],detail['metrics'][-2:],'bad'))
    change=next((m for m in price['metrics'] if m['label']=='SPY previous-session change'),None)
    # dated session close, so it is not read as a second current SPY price beside the live quote card
    changed=[bullet(f"SPY closed {change['value']:+.2f}% in the {session_label(change.get('asof'))} session.",[change])] if change and change['value'] is not None else [bullet('Not available: previous-session price change is missing',price['metrics'][:1])]
    return dict(status=price['status'],headline='Prices, participation and risks give a mixed market read.' if price['status']=='mixed' else price['line'],changed=changed,supports=supports[:3],challenges=challenges[:3])
