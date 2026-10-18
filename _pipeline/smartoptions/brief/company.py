"""Company rules; ratios use matched reporting periods, never price-implied EPS growth."""
from __future__ import annotations

from datetime import date
from statistics import mean, median

from .common import CARDS, card, classify, metric, number, parsed, unavailable, worst


def table(records, name):
    return (records.get(name) or {}).get('data') or {}


def dates(table_):
    return sorted((d for d in table_ if len(d) == 10 and d[4] == '-'), reverse=True)


def field(table_, period, *names):
    row = table_.get(period, {})
    return next((number(row[n]) for n in names if number(row.get(n)) is not None), None)


def ratio(a, b, scale=1):
    return a / b * scale if a is not None and b is not None and b > 0 else None


def prior_year(table_, latest):
    if not latest:
        return None
    return next((d for d in dates(table_) if 330 <= (date.fromisoformat(latest) - date.fromisoformat(d)).days <= 400), None)


def growth(a, b):
    return (a / b - 1) * 100 if a is not None and b is not None and b > 0 else None


def window(table_, n=4, offset=0):
    ds = dates(table_)[offset:offset + n]
    return ds if len(ds) == n and all(60 <= (date.fromisoformat(a) - date.fromisoformat(b)).days <= 120 for a, b in zip(ds, ds[1:])) else []


def total(table_, ds, *names):
    vals = [field(table_, d, *names) for d in ds]
    return sum(vals) if ds and all(v is not None for v in vals) else None


def fmt(value, suffix=''):
    return f'{value:+.1f}{suffix}' if value is not None else 'not available'


def facts(row, records, session, cfg):
    q = {d:v for d,v in table(records, 'quarterly_income_stmt').items() if d<=session}
    cf = {d:v for d,v in table(records, 'quarterly_cashflow').items() if d<=session}
    # Yahoo may append a newer column containing only share counts. That is not
    # a reported balance sheet and must not erase dated debt/liquidity evidence.
    # Never copy old accounts into that newer reporting period.
    balance_accounts = ('Total Assets', 'Current Assets', 'Current Liabilities',
                        'Total Debt', 'Net Debt', 'Stockholders Equity', 'Common Stock Equity')
    bs = {d:v for d,v in table(records, 'quarterly_balance_sheet').items()
          if d<=session and any(number(v.get(key)) is not None for key in balance_accounts)}
    latest = next(iter(dates(q)), None)
    old = prior_year(q, latest)
    q4, cf4 = window(q), window(cf)
    latest_bs = next(iter(dates(bs)), None)
    old_bs = prior_year(bs, latest_bs)
    rev = field(q, latest, 'Total Revenue', 'Operating Revenue')
    op = field(q, latest, 'Operating Income')
    old_rev = field(q, old, 'Total Revenue', 'Operating Revenue')
    margin = ratio(op, rev, 100)
    old_margin = ratio(field(q, old, 'Operating Income'), old_rev, 100)
    ni = total(q, q4, 'Net Income Common Stockholders', 'Net Income')
    fcf_values = []
    for d in cf4:
        ocf = field(cf, d, 'Operating Cash Flow', 'Total Cash From Operating Activities')
        capex = field(cf, d, 'Capital Expenditure')
        fcf_values.append(ocf - abs(capex) if ocf is not None and capex is not None else None)
    fcf = sum(fcf_values) if cf4 and all(v is not None for v in fcf_values) else None
    aligned = q4 == cf4
    debt = field(bs, latest_bs, 'Total Debt')
    equity = field(bs, latest_bs, 'Stockholders Equity', 'Common Stock Equity')
    net_debt = field(bs, latest_bs, 'Net Debt')
    if net_debt is None:
        cash = field(bs, latest_bs, 'Cash And Cash Equivalents')
        net_debt = debt - cash if debt is not None and cash is not None else None
    average_equity = mean([equity, field(bs, old_bs, 'Stockholders Equity', 'Common Stock Equity')]) if equity is not None and field(bs, old_bs, 'Stockholders Equity', 'Common Stock Equity') is not None else None
    assets = field(bs, latest_bs, 'Total Assets')
    prev_assets = field(bs, old_bs, 'Total Assets')
    average_assets = mean([assets, prev_assets]) if assets is not None and prev_assets is not None else None
    ebit = total(q, q4, 'EBIT', 'Operating Income')
    interest = total(q, q4, 'Interest Expense', 'Interest Expense Non Operating')
    ebitda = total(q, q4, 'EBITDA')
    ttm_rev = total(q, q4, 'Total Revenue', 'Operating Revenue')
    prev_rev = total(q, window(q, offset=4), 'Total Revenue', 'Operating Revenue')
    earnings = table(records, 'eps_revisions')
    up = number(earnings.get('upLast30days', {}).get('0q'))
    down = number(earnings.get('downLast30days', {}).get('0q'))
    # A single 0q EPS period is used; do not sum overlapping fiscal horizons.
    return dict(rev_growth=growth(rev, old_rev),
                eps_growth=growth(field(q, latest, 'Diluted EPS', 'Basic EPS'), field(q, old, 'Diluted EPS', 'Basic EPS')),
                rev_ttm=ttm_rev, rev_ttm_growth=growth(ttm_rev, prev_rev),
                margin=margin, margin_delta=margin-old_margin if margin is not None and old_margin is not None else None,
                fcf=fcf, conversion=ratio(fcf, ni) if aligned else None,
                debt_equity=ratio(debt, equity), net_debt_ebitda=ratio(net_debt, ebitda) if latest_bs == latest else None,
                current_ratio=ratio(field(bs, latest_bs, 'Current Assets'), field(bs, latest_bs, 'Current Liabilities')),
                interest_coverage=ratio(ebit, abs(interest) if interest is not None else None),
                roe=ratio(ni, average_equity, 100) if latest_bs == latest else None,
                roa=ratio(ni, average_assets, 100) if latest_bs == latest else None,
                up=up, down=down, latest=latest, latest_bs=latest_bs,
                cash_date=cf4[0] if cf4 else None,
                stale=latest is not None and (date.fromisoformat(session)-date.fromisoformat(latest)).days > cfg['max_statement_age_days'])


def company(row, records, session, cfg, sector_pe, px=None):
    t = row['t']; url = f'https://finance.yahoo.com/quote/{t}/financials/'
    f = facts(row, records, session, cfg)
    financial = row.get('sec') == 'Financials'
    reit = row.get('sec') == 'Real Estate' or 'reit' in (row.get('ind') or '').lower()
    special = financial or reit
    latest = f['latest']
    currency = table(records, 'earnings_estimate').get('currency', {}).get('0q')
    money_unit = str(currency) if currency else 'reporting currency'
    def met(label, value, unit='%', period=None, statement='quarterly_income_stmt', note=''):
        stamp = (records.get(statement) or {}).get('retrieved_at')
        period_note = 'Yahoo provider reporting-period label; may differ from actual fiscal quarter-end date'
        detail = note or ('Statement reporting currency; no FX conversion' if unit == money_unit else '')
        retention = (records.get(statement) or {}).get('retention_reason', '')
        return metric(label, value, unit, period or ('Provider quarter label ' + latest if latest else None), stamp,
                      url=url if statement != 'eps_revisions' else f'https://finance.yahoo.com/quote/{t}/analysis/',
                      note='; '.join(x for x in (detail, period_note if statement.startswith('quarterly_') else '', retention) if x))
    def missing(reason):
        return unavailable(reason, session, url)
    def scored(key, weak, strong, higher=True):
        return classify(f[key], cfg[weak], cfg[strong], higher)
    cards = {}
    gm = [met('Revenue growth YoY', f['rev_growth']), met('Diluted EPS growth YoY', f['eps_growth'], note='Positive prior-year EPS required'),
          met('Revenue TTM', f['rev_ttm'], money_unit, 'Four provider quarters through label ' + str(latest)),
          met('Revenue TTM growth YoY', f['rev_ttm_growth'], note='Eight contiguous quarters required')]
    gs = worst([scored(k, 'growth_weak', 'growth_strong') for k in ['rev_growth', 'eps_growth']])
    cards['growth'] = card(gs, f"Revenue {fmt(f['rev_growth'], '%')}; EPS {fmt(f['eps_growth'], '%')} YoY, provider quarter label {latest}.", gm) if gs != 'unavailable' else missing('comparable year-ago revenue and EPS missing')
    if financial:
        ms = worst([scored('roe', 'roe_weak', 'roe_strong'), scored('roa', 'roa_weak', 'roa_strong')])
        cards['profitability'] = card(ms, f"Return on equity is {f['roe']:.1f}% over four quarters.",
                                     [met('Return on average equity', f['roe'], period='Four provider quarters through label '+str(latest)), met('Return on average assets', f['roa'], period='Four provider quarters through label '+str(latest))]) if f['roe'] is not None else missing('average equity or matched net income missing')
    elif reit:
        cards['profitability'] = missing('reliable funds from operations not supplied for REITs')
    else:
        direction = 'not comparable' if f['margin_delta'] is None else 'widening' if f['margin_delta'] > cfg['margin_direction_pp'] else 'narrowing' if f['margin_delta'] < -cfg['margin_direction_pp'] else 'steady'
        ms = scored('margin', 'margin_weak', 'margin_strong')
        if direction == 'narrowing' and ms == 'strong': ms = 'ok'
        cards['profitability'] = card(ms, f"Operating margin is {f['margin']:.1f}%, {direction} versus last year.", [met('Operating margin', f['margin']), met('Operating margin change YoY', f['margin_delta'], 'pp', note=f"Steady within {cfg['margin_direction_pp']} percentage points")]) if f['margin'] is not None else missing('operating income or revenue missing')
    if special:
        cards['cash'] = missing('industrial cash conversion is unsuitable for this sector')
        cards['resilience'] = missing('sector capital and liquidity measures are not supplied')
    else:
        cs = scored('conversion', 'cash_conversion_weak', 'cash_conversion_strong')
        if f['fcf'] is not None and f['fcf'] < 0: cs = 'weak'
        cards['cash'] = card(cs, f"Free cash flow is {f['fcf']/1e9:.1f}bn; conversion {f['conversion']:.2f} times earnings." if f['conversion'] is not None else f"Free cash flow is {f['fcf']/1e9:.1f}bn; earnings conversion is unavailable.",
                             [met('Free cash flow TTM', f['fcf'], money_unit, 'Four provider quarters through label '+str(f['cash_date']), 'quarterly_cashflow'), met('FCF / net income TTM', f['conversion'], 'x', 'Four provider quarters through label '+str(f['cash_date']), 'quarterly_cashflow', 'Requires matched four-quarter cash flow and income, and positive net income')]) if f['fcf'] is not None else missing('four comparable cash-flow quarters missing')
        rs = worst([scored(k, k+'_weak', k+'_strong', higher) for k, higher in [('debt_equity', False), ('net_debt_ebitda', False), ('current_ratio', True), ('interest_coverage', True)]])
        rm = [met(label, f[k], 'x', ('Provider balance-sheet label ' + str(f['latest_bs'])) if k in ('debt_equity','current_ratio') else 'TTM provider income/balance labels through '+str(latest), 'quarterly_balance_sheet' if k in ('debt_equity','current_ratio','net_debt_ebitda') else 'quarterly_income_stmt', note) for k, label, note in [
            ('debt_equity','Total debt / equity','Positive book equity required'), ('net_debt_ebitda','Net debt / EBITDA','Matched balance date and positive TTM EBITDA required'), ('current_ratio','Current assets / liabilities','Positive current liabilities required'), ('interest_coverage','EBIT / interest expense','Positive interest expense required')]]
        weakest = next((m for m in rm if m['value'] is not None and classify(m['value'], cfg[{'Total debt / equity':'debt_equity','Net debt / EBITDA':'net_debt_ebitda','Current assets / liabilities':'current_ratio','EBIT / interest expense':'interest_coverage'}[m['label']]+'_weak'], cfg[{'Total debt / equity':'debt_equity','Net debt / EBITDA':'net_debt_ebitda','Current assets / liabilities':'current_ratio','EBIT / interest expense':'interest_coverage'}[m['label']]+'_strong'], m['label'] not in ('Total debt / equity','Net debt / EBITDA')) == rs), None)
        if weakest:rm=[weakest]+[m for m in rm if m is not weakest]
        cards['resilience'] = card(rs, f"{weakest['label']} is {weakest['value']:.2f} times.", rm) if weakest else missing('debt, liquidity and coverage ratios missing')
    # Valuation is relative to the actual exported universe, not the full S&P.
    # A derived peer observation has its own acquisition range. In particular,
    # a company with missing ratios must not date its peers with its missing rat.
    peer = sector_pe.get(row.get('sec')) or {}
    med = peer.get('value'); med_asof = peer.get('asof')
    own_asof = row.get('rat') if parsed(row.get('rat')) else None
    pe = number(row.get('pe')) if own_asof else None
    relative = ratio(pe, med) if pe is not None and pe > 0 else None
    forward = peer.get('forward') or {}
    own_forward = number(row.get('pef')) if own_asof else None
    vf = ratio(own_forward, forward.get('value')) if own_forward is not None and own_forward > 0 else None
    def earliest(*stamps):
        return min(stamps, key=parsed) if all(parsed(s) for s in stamps) else None
    peer_note = (f"Equal-weight median of {peer.get('count', 0)} positive, dated exported-universe multiples; "
                 f"retrieval range {med_asof} to {peer.get('latest_asof')}; "
                 f"{peer.get('undated_count', 0)} undated positive multiples excluded")
    own_period = 'Provider snapshot retrieved '+own_asof if own_asof else 'Acquisition timestamp unavailable'
    vm = [metric('Trailing P/E / sector median', relative, 'x', own_period, earliest(own_asof, med_asof), url=f'https://finance.yahoo.com/quote/{t}/', note=peer_note),
          metric('Trailing P/E', pe if pe is not None and pe > 0 else None, 'x', own_period, own_asof, url=f'https://finance.yahoo.com/quote/{t}/', note='' if own_asof else 'Acquisition timestamp unavailable; refresh source cache'),
          metric('Sector trailing P/E median', med, 'x', 'Peer snapshots; oldest retrieval '+str(med_asof), med_asof, url='https://finance.yahoo.com/', note=peer_note),
          metric('Forward P/E / sector median', vf, 'x', own_period, earliest(own_asof, forward.get('asof')), url=f'https://finance.yahoo.com/quote/{t}/', note='Positive forward multiples with dated acquisition required; oldest input retrieval is retained'),
          met('Valuation vs own history', None, 'x', 'Not available', note='not enough dated EPS history')]
    vs = classify(relative, cfg['valuation_weak'], cfg['valuation_strong'], False)
    cards['valuation'] = missing('REIT earnings multiples require reliable FFO peers') if reit else card(vs, f"Trailing P/E is {relative:.2f} times the sector median.", vm) if relative is not None else card('unavailable','Not available: positive earnings and sector peers are required',vm)
    if f['up'] is not None and f['down'] is not None:
        es = 'strong' if f['up'] > f['down'] else 'weak' if f['down'] > f['up'] else 'ok'
        cards['expectations'] = card(es, f"Current-quarter EPS revisions: {f['up']:.0f} up, {f['down']:.0f} down in 30 days.",
            [met('EPS revisions up', f['up'], 'analyst revisions', 'Last 30 days; current fiscal quarter (Yahoo 0q)', 'eps_revisions'), met('EPS revisions down', f['down'], 'analyst revisions', 'Last 30 days; current fiscal quarter (Yahoo 0q)', 'eps_revisions')])
    else: cards['expectations'] = missing('Yahoo did not supply EPS revision counts')
    if f['stale']:
        for key in ('growth', 'profitability', 'cash', 'resilience'):
            cards[key] = missing('latest statements exceed the reporting-age limit')
    for period, keys in [(f['cash_date'], ('cash',)), (f['latest_bs'], ('resilience',))]:
        if period and (date.fromisoformat(session)-date.fromisoformat(period)).days>cfg['max_statement_age_days']:
            for key in keys:cards[key]=missing('latest statements exceed the reporting-age limit')
    counter = []
    def negative(key, value, threshold, higher, label, unit, metrics):
        if cards[key]['status']=='unavailable' or value is None:return
        bad=value<threshold if higher else value>threshold
        if bad:
            distance=(threshold-value if higher else value-threshold)/max(abs(threshold),1)
            evidence_label={'EPS growth YoY':'Diluted EPS growth YoY',
                            'Return on equity':'Return on average equity',
                            'Return on assets':'Return on average assets',
                            'Cash conversion':'FCF / net income TTM'}.get(label,label)
            metrics=sorted(metrics,key=lambda m:m['label']!=evidence_label)
            counter.append((1+distance,f'{label} is {value:.2f}{unit}.',metrics))
    for key,label in [('rev_growth','Revenue growth YoY'),('eps_growth','EPS growth YoY')]:
        negative('growth',f[key],cfg['growth_weak'],True,label,'%',cards['growth']['metrics'][:2])
    if financial:
        for key in ('roe','roa'):
            negative('profitability',f[key],cfg[key+'_weak'],True,'Return on '+('equity' if key=='roe' else 'assets'),'%',cards['profitability']['metrics'])
    elif not reit:
        negative('profitability',f['margin'],cfg['margin_weak'],True,'Operating margin','%',cards['profitability']['metrics'])
    if not special:
        negative('cash',f['conversion'],cfg['cash_conversion_weak'],True,'Cash conversion','x',cards['cash']['metrics'])
        if cards['cash']['status']!='unavailable' and f['fcf'] is not None and f['fcf']<0:
            severity=1+abs(f['fcf'])/max(abs(f['rev_ttm'] or 0),1)*100
            counter.append((severity,f"Free cash flow is {f['fcf']/1e9:.1f}bn {money_unit}.",cards['cash']['metrics']))
        for key,label in [('debt_equity','Debt / equity'),('net_debt_ebitda','Net debt / EBITDA'),('current_ratio','Current ratio'),('interest_coverage','Interest coverage')]:
            matching=[m for m in cards['resilience']['metrics'] if m['label']=={'debt_equity':'Total debt / equity','net_debt_ebitda':'Net debt / EBITDA','current_ratio':'Current assets / liabilities','interest_coverage':'EBIT / interest expense'}[key]]
            negative('resilience',f[key],cfg[key+'_weak'],key in ('current_ratio','interest_coverage'),label,'x',matching)
    negative('valuation',relative,cfg['valuation_weak'],False,'P/E / sector median','x',cards['valuation']['metrics'][:1])
    if cards['expectations']['status']=='weak':
        counter.append((1+(f['down']-f['up'])/max(f['down']+f['up'],1),f"EPS revisions: {f['down']:.0f} down versus {f['up']:.0f} up.",list(reversed(cards['expectations']['metrics']))))
    er = row.get('er') if own_asof else None
    days = (date.fromisoformat(er)-date.fromisoformat(session)).days if er else None
    event_metric = metric('Next earnings date', er, 'date', er, row.get('rat'), row.get('ers') or 'Yahoo earnings calendar', f'https://finance.yahoo.com/quote/{t}/calendar/', 'Provider estimate; timing unconfirmed' if not row.get('ert') else str(row['ert']))
    if days is not None and 0 <= days <= 7:
        counter.append((1.5, f'Earnings are due in {days} days.', [event_metric]))
    if counter:
        _, line, metrics = max(counter, key=lambda x:x[0])
        cards['counter'] = card('weak','Strongest case against: '+line,metrics[:2])
    elif all(cards[k]['status'] != 'unavailable' for k in CARDS[:-1]):
        cards['counter'] = card('ok','No weak area found in the measured data', [m for obj in cards.values() for m in obj['metrics'] if m['value'] is not None][:1])
    else:
        cards['counter'] = card('unavailable','No weak area found in the measured data', [metric('Assessment coverage',sum(cards[k]['status']!='unavailable' for k in CARDS[:-1]),'dimensions','Current export',session,'Brief deterministic rules','https://github.com/soham-porwal/smartoptions-brief/blob/main/docs/BRIEF-METHODS.md','Incomplete coverage; missing areas cannot be cleared')])
    technical = technical_card(row, px, session)
    events = dict(line=f'Earnings expected {er}; timing may change.' if er else 'Not available: next earnings date not supplied',items=[dict(when_et=er,kind='earnings',title=t+' earnings',metrics=[event_metric])] if er else [])
    return dict(schema='brief.company.v1',t=t,name=row.get('n') or t,sector=row.get('sec') or 'Not available',asof=session,
                summary=cards['growth']['line'],cards=cards,technical=technical,events=events,
                options=dict(line='Check spreads, liquidity and earnings before selecting an expiry.',strategy_hint=None))


def technical_card(row, px, session):
    bars = [b for b in (px or {}).get('bars',[]) if b[0] <= session and number(b[4]) is not None]
    closes = [b[4] for b in bars]
    url = f"https://finance.yahoo.com/quote/{row['t']}/history/"
    if len(closes) < 200:
        return unavailable('200 daily closes are required for trend assessment', session, url)
    sma50, sma200 = mean(closes[-50:]), mean(closes[-200:])
    state = 'strong' if closes[-1]>sma50>sma200 else 'weak' if closes[-1]<sma50<sma200 else 'ok'
    return card(state, 'Price is above both averages.' if closes[-1]>max(sma50,sma200) else 'Price is below both averages.' if closes[-1]<min(sma50,sma200) else 'Price is between its main averages.',
                [metric(label,v,'USD/share',period,bars[-1][0],url=url,note='Unadjusted daily close; no dividend adjustment') for label,v,period in [('Close',closes[-1],bars[-1][0]),('50-session average',sma50,'50 sessions to '+bars[-1][0]),('200-session average',sma200,'200 sessions to '+bars[-1][0])]])


def sector_medians(rows):
    """Positive peer multiples, conservatively dated by the oldest input.

    Undated inputs cannot become observed values merely because another member
    was fetched today. Their exclusion remains visible in each peer receipt.
    """
    def aggregate(members, field):
        positive = [r for r in members if number(r.get(field)) is not None and number(r[field]) > 0]
        dated = [r for r in positive if parsed(r.get('rat'))]
        stamps = [r['rat'] for r in dated]
        return dict(value=median(number(r[field]) for r in dated) if dated else None,
                    asof=min(stamps, key=parsed) if stamps else None,
                    latest_asof=max(stamps, key=parsed) if stamps else None,
                    count=len(dated), undated_count=len(positive)-len(dated))
    result = {}
    for sector in {r.get('sec') for r in rows}:
        members = [r for r in rows if r.get('sec') == sector]
        result[sector] = dict(aggregate(members, 'pe'), forward=aggregate(members, 'pef'))
    return result
