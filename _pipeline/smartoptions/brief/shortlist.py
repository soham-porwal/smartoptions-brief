from datetime import date

from .common import CARDS, bullet, number, parsed

POINTS={'strong':100,'ok':60,'weak':20,'unavailable':0}


def shortlist(rows,companies,session,cfg):
    results=[]
    for row in rows:
        c=companies[row['t']];cards=c['cards']
        coverage=sum(cards[k]['status']!='unavailable' for k in CARDS[:-1])
        # Growth, earnings quality and valuation must all have measured coverage.
        if coverage<cfg['shortlist_min_dimensions'] or any(cards[k]['status']=='unavailable' for k in ('growth','profitability','valuation')):continue
        states={k:v['status'] for k,v in cards.items()}
        fundamental=sum(POINTS[s] for s in states.values())/len(CARDS)
        momentum=POINTS[c['technical']['status']]
        # Existing factor signals count only when statistically qualified, dated and favorable.
        signal_date=parsed(row.get('_signals_asof'))
        recent_signal=signal_date is not None and 0<=(date.fromisoformat(session)-signal_date.date()).days<=4
        qualified=[s for s in row.get('_signals',[]) if recent_signal and s.get('kind')=='factor' and abs(number(s.get('tstat')) or 0)>=2 and (number(s.get('implied')) or 0)>0]
        momentum=min(100,momentum+min(10,5*len(qualified)))
        days=(date.fromisoformat(row['er'])-date.fromisoformat(session)).days if row.get('er') else None
        penalty=cfg['event_penalty'] if days is not None and 0<=days<=7 else 0
        score=round(max(0,min(100,(1-cfg['momentum_weight'])*fundamental+cfg['momentum_weight']*momentum-penalty)))
        ordered=sorted(((POINTS[cards[k]['status']],i,k) for i,k in enumerate(CARDS[:-1]) if cards[k]['status'] in ('strong','ok')), key=lambda a:(-a[0],a[1]))
        why=[bullet(cards[k]['line'],cards[k]['metrics'][:2],'good' if points==100 else 'neutral') for points,_,k in ordered[:3]]
        if len(why)<2:continue
        results.append(dict(t=row['t'],name=c['name'],sector=c['sector'],score=score,
                            score_basis=f"Seven card ratings, trend setup and dated signals; near earnings subtract {cfg['event_penalty']} points.",
                            why=why,counter=bullet(cards['counter']['line'],cards['counter']['metrics'],'bad' if states['counter']=='weak' else 'neutral'),status=states))
    return sorted(results,key=lambda r:(-r['score'],r['t']))[:cfg['shortlist_count']]
