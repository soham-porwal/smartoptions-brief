"""Deterministic historical shock associations. Run: python -m smartoptions.shocks --out app/data."""
from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import date, datetime, timezone
from pathlib import Path

import numpy as np

from smartoptions.shocks_sources import FACTOR_SPECS, load_events, load_factors, pairs
from smartoptions.log import event

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = 'smartoptions.shocks.v1'
Z90 = 1.6448536269514722
KEYS = list(FACTOR_SPECS)


def clean(value):
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean(v) for v in value]
    if isinstance(value, (float, np.floating)):
        return round(float(value), 7) if np.isfinite(value) else None
    if isinstance(value, np.integer):
        return int(value)
    return value


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def ols_hac(y, X, lags=None):
    """OLS, intercept, Bartlett Newey-West sandwich with n/(n-k) correction."""
    y, X = np.asarray(y, float), np.asarray(X, float)
    if X.ndim == 1:
        X = X[:, None]
    design = np.column_stack([np.ones(len(y)), X])
    n, k = design.shape
    if n <= k + 2 or not np.isfinite(design).all() or not np.isfinite(y).all() or np.linalg.matrix_rank(design) < k:
        raise ValueError('Not available: insufficient independent finite observations')
    beta = np.linalg.lstsq(design, y, rcond=None)[0]
    residual = y - design @ beta
    bread = np.linalg.inv(design.T @ design)
    scores = design * residual[:, None]
    meat = scores.T @ scores
    lags = min(n - 1, int(math.floor(4 * (n / 100) ** (2 / 9))) if lags is None else lags)
    for lag in range(1, lags + 1):
        gamma = scores[lag:].T @ scores[:-lag]
        meat += (1 - lag / (lags + 1)) * (gamma + gamma.T)
    covariance = bread @ meat @ bread * n / (n - k)
    se = np.sqrt(np.maximum(np.diag(covariance), 0))
    total = float(np.sum((y - y.mean()) ** 2))
    return dict(beta=beta, se=se, covariance=covariance, r2=1-float(residual @ residual)/total if total else None,
                n=n, hac_lags=lags, intercept=beta[0])


def confidence(n, lo, hi, stability, weekly=False):
    excludes = lo > 0 or hi < 0
    folds = stability.get('folds', 0)
    agree = stability.get('sign_agreement')
    corr = stability.get('predicted_realized_correlation')
    if excludes and n >= (104 if weekly else 504) and folds >= 2 and agree is not None and agree >= .8 and corr is not None and corr >= .2:
        return 'high'
    if excludes and n >= (40 if weekly else 180) and folds >= 1 and agree is not None and agree >= .6:
        return 'medium'
    return 'low'


def rolling_stability(y, X, days, weekly=False):
    """Contemporaneous holdout attribution, not next-day prediction. No future fit inputs."""
    train, test = (104, 26) if weekly else (504, 126)
    standard = len(y) >= train + test
    if not standard:
        train, test = (26, 13) if weekly else (120, 60)
    details = []; signs = [[] for _ in KEYS]; predicted = [[] for _ in KEYS]; actual = [[] for _ in KEYS]
    # Anchor full holdout blocks at the most recent observation, rather than
    # leaving an untested recent tail when the history length is not a multiple.
    folds = max(0, (len(y)-train)//test)
    first_test = len(y)-folds*test
    for start in range(first_test, len(y) - test + 1, test):
        training = slice(start-train, start); testing = slice(start, start+test)
        fit = ols_hac(y[training], X[training]); check = ols_hac(y[testing], X[testing])
        beta = fit['beta']; fit_y = beta[0] + X[testing] @ beta[1:]
        for j in range(len(KEYS)):
            contribution = X[testing, j] * beta[j+1]
            residual = y[testing] - fit_y + contribution
            predicted[j].extend(contribution.tolist()); actual[j].extend(residual.tolist())
            signs[j].append(bool(np.sign(beta[j+1]) == np.sign(check['beta'][j+1])))
        details.append(dict(train_start=days[start-train], train_end=days[start-1], test_start=days[start], test_end=days[start+test-1], train_n=train, test_n=test))
    result = {}
    for j, key in enumerate(KEYS):
        p, a = np.asarray(predicted[j]), np.asarray(actual[j])
        corr = float(np.corrcoef(p, a)[0, 1]) if len(p) > 2 and np.std(p) > 1e-12 and np.std(a) > 1e-12 else None
        result[key] = dict(folds=len(details), sign_agreement=float(np.mean(signs[j])) if signs[j] else None,
                           predicted_realized_correlation=corr, holdout_n=len(p),
                           direction_hit_rate_pct=float(np.mean(np.sign(p) == np.sign(a))) * 100 if len(p) else None,
                           method='Rolling fixed-window contemporaneous attribution; realized other-factor-adjusted return, using training coefficients',
                           training_n=train, test_n=test, standard_two_year_design=standard,
                           limitation='Known same-period shocks in holdout; not a forecast or causal effect', windows=details)
    return result


def fit_exposures(y, X, days, weekly=False):
    minimum = 26 if weekly else 120
    if len(y) < minimum:
        return {}, f'Not available: need {minimum} complete observations; found {len(y)}'
    raw = ols_hac(y, X[:, :len(KEYS)])
    neutral = ols_hac(y, X)
    stability = rolling_stability(y, X, days, weekly)
    result = {}
    for j, key in enumerate(KEYS):
        def coefficient(fit):
            b, se = float(fit['beta'][j+1]), float(fit['se'][j+1])
            return dict(beta=b, se=se, ci_low=b-Z90*se, ci_high=b+Z90*se, r2=fit['r2'])
        row = coefficient(neutral); stab = stability[key]
        row.update(raw=coefficient(raw), n=len(y), window_start=days[0], window_end=days[-1],
                   unit=f'% return per 1 {FACTOR_SPECS[key][1]} change', hac_lags=neutral['hac_lags'],
                   market_beta=float(neutral['beta'][-1]), intercept_pct=float(neutral['beta'][0]),
                   oos_sign_agreement=stab['sign_agreement'], stability=stab, kind='association',
                   confidence=confidence(len(y), row['ci_low'], row['ci_high'], stab, weekly))
        result[key] = row
    return result, None


def weekly_samples(yseries, factors, market):
    """Non-overlapping complete equity weeks only; no phantom zero for missing dates."""
    weeks = {}; market_days=sorted(market)
    previous=dict(zip(market_days[1:],market_days[:-1]))
    for d in market_days:
        iso = date.fromisoformat(d).isocalendar()
        weeks.setdefault((iso.year, iso.week), []).append(d)
    days, ys, xs = [], [], []
    for ds in weeks.values():
        # Exclude partial first/last weeks and weeks with absent inputs.
        if len(ds) < 4 or date.fromisoformat(ds[-1]).weekday() < 3:
            continue
        if not all(d in yseries and all(d in factors[k] for k in KEYS) for d in ds):
            continue
        if any(d in previous and any(previous[d] not in factors[k] for k in KEYS) for d in ds):
            continue
        days.append(ds[-1]); ys.append((np.prod([1+yseries[d]/100 for d in ds])-1)*100)
        row = []
        for k in KEYS:
            v = [factors[k][d] for d in ds]
            row.append((np.prod(1+np.array(v)/100)-1)*100 if FACTOR_SPECS[k][1] == '%' else sum(v))
        row.append((np.prod([1+market[d]/100 for d in ds])-1)*100); xs.append(row)
    return np.asarray(ys), np.asarray(xs), days


def model_series(yseries, factors, market):
    market_days = sorted(market)
    previous = dict(zip(market_days[1:],market_days[:-1]))
    common = set(yseries) & set(market) & set.intersection(*(set(v) for v in factors.values()))
    # A Treasury holiday must not turn a two-session yield change into a
    # one-session stock-return observation on the next trading day.
    days = [d for d in sorted(common) if d in previous and all(previous[d] in factors[k] for k in KEYS)][-756:]
    y = np.array([yseries[d] for d in days]); X = np.array([[factors[k][d] for k in KEYS]+[market[d]] for d in days])
    try:
        daily, error = fit_exposures(y, X, days)
    except (ValueError, np.linalg.LinAlgError) as exc:
        daily, error = {}, f'Not available: daily design cannot be estimated ({type(exc).__name__})'
        event('shocks.fit','daily','WARN',error,log_dir=ROOT/'logs/quant')
    wy, wx, wd = weekly_samples(yseries, factors, market)
    try:
        weekly, weekly_error = fit_exposures(wy, wx, wd, True)
    except (ValueError, np.linalg.LinAlgError) as exc:
        weekly, weekly_error = {}, f'Not available: weekly design cannot be estimated ({type(exc).__name__})'
        event('shocks.fit','weekly','WARN',weekly_error,log_dir=ROOT/'logs/quant')
    return dict(daily=daily, weekly=weekly, reason=error, weekly_reason=weekly_error)


def cap_weighted(rows, returns, min_coverage=.9):
    """Issuer-cap proxy baskets; known sibling classes share one issuer weight."""
    siblings = {'GOOG':'Alphabet','GOOGL':'Alphabet','FOX':'Fox','FOXA':'Fox','NWS':'News Corp','NWSA':'News Corp'}
    groups = {}
    for row in rows:
        if isinstance(row.get('mcap'), (float, int)) and row['mcap'] > 0:
            groups.setdefault(siblings.get(row['t'], row['t']), []).append(row)
    weights = {}
    for issuer, group in groups.items():
        # Provider marketCap describes the issuer, not a verified class-level
        # float cap. Use the largest snapshot once, allocated equally to classes.
        weight = max(r['mcap'] for r in group) / len(group)
        weights.update({r['t']:weight for r in group})
    sectors, coverage = {}, {}
    for sector in sorted({r['sec'] for r in rows}):
        members = [r for r in rows if r['sec'] == sector and isinstance(r.get('mcap'), (float, int)) and r['mcap'] > 0]
        cap = sum(weights[r['t']] for r in members)
        days = sorted(set().union(*(set(returns.get(r['t'], {})) for r in members)))
        values = {}; dropped = 0; ratios = []
        for d in days:
            present = [r for r in members if d in returns.get(r['t'], {})]
            present_cap = sum(weights[r['t']] for r in present)
            ratio = present_cap / cap if cap else 0
            if ratio >= min_coverage:
                values[d] = sum(weights[r['t']] * returns[r['t']][d] for r in present) / present_cap
                ratios.append(ratio)
            else:
                dropped += 1
        sectors[sector] = values
        coverage[sector] = dict(members=len(members), total_members=sum(r['sec'] == sector for r in rows),
                                cap_basis='Current issuer-cap proxy, known sibling classes share max issuer cap equally; not a historical or float-weighted sector index',
                                share_class_rule='GOOG/GOOGL, FOX/FOXA, NWS/NWSA: issuer max marketCap counted once, equal split across available classes',
                                minimum_cap_coverage=min(ratios) if ratios else None, dropped_days=dropped)
    return sectors, coverage


def event_study(sector_returns, market, calendar):
    """Pre-event market model (up to 120, min 60); additive abnormal day 0 and CAR 0..2."""
    days = sorted(market); index = {d:i for i,d in enumerate(days)}; output = {}
    for kind, group in calendar.items():
        records = {}
        for sector, values in sector_returns.items():
            samples = {0: [], 2: []}; used = []; skipped = []
            for release in group['dates']:
                day = release['date']; i = index.get(day)
                if i is None:
                    continue  # A non-session release is not moved to an invented event date.
                train = [d for d in days[max(0,i-120):i] if d in values]
                if len(train) < 60 or day not in values:
                    skipped.append(day); continue
                fit = ols_hac([values[d] for d in train], [[market[d]] for d in train])
                ab = [values[d]-fit['beta'][0]-fit['beta'][1]*market[d] for d in days[i:i+3] if d in values]
                samples[0].append(float(ab[0]))
                if len(ab) == 3:
                    samples[2].append(float(sum(ab)))
                used.append(dict(date=day, train_end=train[-1], train_n=len(train), source_url=release['source_url']))
            windows = {}
            for horizon, vals in samples.items():
                n = len(vals); mean = float(np.mean(vals)) if n else None
                se = float(np.std(vals, ddof=1)/math.sqrt(n)) if n > 1 else None
                windows[f'day_0' if horizon == 0 else 'days_0_2'] = dict(mean_abnormal_return_pct=mean,
                    mean_absolute_abnormal_return_pct=float(np.mean(np.abs(vals))) if n else None,
                    t_stat=mean/se if se and se > 0 else None, n=n,
                    ci_low=mean-Z90*se if se is not None else None, ci_high=mean+Z90*se if se is not None else None,
                    reason=f'{n} releases describe past moves; surprise direction and causation are unverified.' if n else 'Not available: insufficient pre-event history and verified release dates')
            records[sector] = dict(windows=windows, events=used, skipped_insufficient_history=skipped, kind='association')
        output[kind] = dict(calendar=group, sectors=records, kind='association',
                            reason='Abnormal means sector return minus its earlier market-model fit. Absolute moves measure reaction size, not surprise direction.',
                            limitation='Small overlapping event samples; conventional event-mean t-statistics, unadjusted for multiple testing or overlap')
    return output


def shrink(stock, sector):
    """Fixed, conservative sector pseudo-observations: w=n/(n+252)/(1+(SE/|b|)^2)."""
    signal = abs(stock['beta'])
    weight = stock['n']/(stock['n']+252) * signal**2/(signal**2+stock['se']**2) if signal or stock['se'] else 0
    b = weight*stock['beta']+(1-weight)*sector['beta']
    se = weight*stock['se']+(1-weight)*sector['se']
    return dict(beta=b, ci_low=b-Z90*se, ci_high=b+Z90*se, stock_weight=weight,
                interval_basis='Conservative weighted SE bound; conditional descriptive band, excludes shrinkage bias; OLS 90% CI retained separately')


def factor_words(key):
    label = FACTOR_SPECS[key][0]
    return label if label in ('WTI oil','US dollar','VIX') else label.lower()


def reason(label, exposure, move, sector):
    impact = exposure['beta'] * move
    unit = FACTOR_SPECS[label][1]
    amount = f'+{move:.2f}%' if unit == '%' else f'+{move:.2f} {unit}'
    return f'{sector} historically moved {impact:+.2f}% with a {amount} {factor_words(label)} change. Market returns and other shocks are held fixed; this is an association.'


def make_scenarios(sectors, factors):
    specs = [('rates-up-25', '10-year yield +25 bp', 'us10y_bps', 25), ('curve-up-25','2s10s slope +25 bp','slope_bps',25),
             ('oil-up-10','Oil +10%','wti',10), ('vix-up-5','VIX +5 points','vix',5),
             ('dollar-up-2','Dollar +2%','dxy',2), ('credit-up-25','High-yield spread +25 bp','hy_oas_bps',25)]
    output = []
    for id_, label, key, size in specs:
        moves = []
        for sector in sectors:
            e = sector['factors'].get(key)
            if not e:
                continue
            moves.append(dict(sector=sector['name'], estimated_move_pct=e['beta']*size, ci_low=e['ci_low']*size, ci_high=e['ci_high']*size,
                              confidence=e['confidence'], n=e['n'], window_start=e['window_start'], window_end=e['window_end'],
                              source_ids=[key,'equities'], kind='scenario',
                              reason=f'Holding other factors fixed, {label.lower()} maps to {e["beta"]*size:+.2f}%. This conditional estimate is not a forecast.'))
        output.append(dict(id=id_, label=label, factor=key, change=size, unit=FACTOR_SPECS[key][1], kind='scenario',
                           reason='Historical sensitivity times a hypothetical shock. Bands cover coefficient uncertainty, not future return uncertainty.', sectors=moves))
    return output


def opportunities(companies, rows, metadata, data_root):
    lookup = {f['id']:f for f in metadata}; rowmap = {r['t']:r for r in rows}; found = []
    for ticker, company in companies.items():
        path = data_root / 'brief/company' / f'{ticker}.json'
        if not path.exists():
            continue
        cards = read(path).get('cards', {})
        growth = next((m for m in cards.get('growth',{}).get('metrics',[]) if m.get('label') == 'Revenue growth YoY'), {})
        valuation = next((m for m in cards.get('valuation',{}).get('metrics',[]) if m.get('label') == 'Trailing P/E / sector median'), {})
        g, v = growth.get('value'), valuation.get('value')
        if not isinstance(g, (int,float)) or not isinstance(v,(int,float)) or not (g > 0 and 0 < v < 1):
            continue
        for e in company['exposures']:
            f = lookup[e['factor']]; change = f['recent_change']; b = e['shrunk']['beta']
            if change is None or b*change <= 0 or e['confidence'] == 'low' or f['freshness'] == 'stale':
                continue
            lo, hi = sorted([e['ci_low']*change,e['ci_high']*change])
            if lo <= 0:
                continue
            impact = b*change
            ev = [dict(label='Historical shrunken sensitivity',value=b,unit=e['unit'],date=e['window_end'],source_url=f['source']['url']),
                  dict(label='Observed 20-session factor change',value=change,unit=f['unit'],date=f['recent_change_date'],source_url=f['source']['url']),
                  dict(label='Conditional association for net factor change',value=impact,unit='% return',date=f['recent_change_date'],source_url=f'https://finance.yahoo.com/quote/{ticker}/history/',formula='Daily shrunken beta times net 20-observation factor change; scenario, not additive realized contribution or actual return')]
            for m in [growth,valuation] + cards.get('counter',{}).get('metrics',[])[:2]:
                if not isinstance(m.get('value'), (int,float)) or isinstance(m.get('value'), bool):
                    continue  # Text/calendar counterarguments are copy, never numeric evidence.
                ev.append(dict(label=m['label'],value=m['value'],unit=m['unit'],date=m.get('asof'),source_url=m.get('source_url'),period=m.get('period')))
            counter = cards.get('counter', {}).get('line')
            if not counter or counter.startswith('No weak'):
                counter = 'Historical exposures can reverse; cheaper valuations may reflect earnings risks.'
            found.append(dict(id=f'shock-{ticker}-{f["id"]}', ticker=ticker, title=f'{ticker}: {f["label"].lower()} crossover',
                              summary=f'{ticker}: {factor_words(f["id"])} exposure aligns with growth and cheaper sector valuation.',
                              reason=f'Historical exposure aligns with the recent {factor_words(f["id"])} move. Revenue grew {g:.1f}%; the trailing multiple is {v:.2f} times sector peers.',
                              counterargument=counter, kind='association', direction='supportive', evidence=ev,
                              source_ids=[f['id'],'equities','statements'], confidence=e['confidence'],
                              associated_contribution_pct=impact, sector=rowmap[ticker]['sec']))
    return sorted(found,key=lambda x: -x['associated_contribution_pct'])[:8]


def build(data_root, stage_root, calendar=None, now=None, offline=False, log_dir=None):
    data_root, stage_root = Path(data_root), Path(stage_root)
    now = now or datetime.now(timezone.utc); log_dir = Path(log_dir or ROOT/'logs/quant')
    core, macro, equities = [read(p) for p in [data_root/'core.json',stage_root/'macro.json',stage_root/'equities.json']]
    cutoff = core['asof_session']
    if equities.get('asof_session') != cutoff:
        raise ValueError('Core and equity sessions disagree')
    unit = equities.get('meta',{}).get('returns_unit','')
    if unit and 'fraction' not in unit.lower():
        raise ValueError('Equity returns must use decimal fractions')
    rows = [r for r in core['rows'] if r.get('sp500_member') is True]
    if not rows:
        raise ValueError('SUSPECT: no explicitly identified S&P constituents')
    returns = {t:{d:v*100 for d,v in pairs(p,cutoff).items()} for t,p in equities['returns'].items()}
    market = returns.get('SPY', {})
    factors, metadata = load_factors(macro, cutoff)
    # Guidance uses the consecutive equity/factor calendar required by fits.
    market_days = sorted(market)
    previous = dict(zip(market_days[1:], market_days[:-1]))
    common = set(market).intersection(*(set(factors[k]) for k in KEYS))
    fit_days = [d for d in sorted(common) if d in previous and all(previous[d] in factors[k] for k in KEYS)][-756:]
    for factor in metadata:
        values = [factors[factor['id']][d] for d in fit_days]
        if values:
            factor['observed_daily_range'] = dict(min=min(values), max=max(values), n=len(values),
                window_start=fit_days[0], window_end=fit_days[-1],
                basis='Aligned daily factor observations on the equity calendar; sector coverage may differ')
    warnings = []
    if calendar is None:
        calendar, warnings = load_events(stage_root, log_dir/'sources', cutoff, offline)
    if not market or any(not v for v in factors.values()):
        raise ValueError('Not available: SPY or required factor series is missing; previous artifact retained')
    baskets, coverage = cap_weighted(rows, returns)
    sectors = []; sector_models = {}
    for sector, values in baskets.items():
        model = model_series(values, factors, market); sector_models[sector] = model
        for key, e in model['daily'].items():
            f = next(f for f in metadata if f['id']==key)
            e.update(standard_move=f['standard_move'], estimated_move_pct=e['beta']*f['standard_move'],
                     move_ci_low=e['ci_low']*f['standard_move'], move_ci_high=e['ci_high']*f['standard_move'],
                     reason=reason(key,e,f['standard_move'],sector), source_ids=[key,'equities'], weekly=model['weekly'].get(key))
        sectors.append(dict(name=sector, factors=model['daily'], reason=model['reason'], weekly_reason=model['weekly_reason'], coverage=coverage[sector]))
    companies, skipped = {}, []
    for row in rows:
        ticker = row['t']; model = model_series(returns.get(ticker,{}),factors,market)
        exposures = []
        for key, e in model['daily'].items():
            sector = sector_models[row['sec']]['daily'].get(key)
            if not sector:
                continue
            shrunken = shrink(e, sector); move = next(f['standard_move'] for f in metadata if f['id']==key)
            shrunken.pop('interval_basis')  # Full definition is shared in methods.shrinkage.
            weekly = model['weekly'].get(key)
            compact = lambda v: {k:x for k,x in v.items() if k not in ('method','limitation','windows')}
            exposures.append(dict(e, factor=key, shrunk=shrunken, standard_move=move,
                                  stability=compact(e['stability']), estimated_move_pct=shrunken['beta']*move,
                                  weekly=dict(weekly,stability=compact(weekly['stability'])) if weekly else None, source_ids=[key,'equities'],
                                  reason=f'{ticker} has a {shrunken["beta"]*move:+.2f}% association with a standard {factor_words(key)} move. No future return is implied.'))
        exposures.sort(key=lambda e:-abs(e['estimated_move_pct']))
        if not exposures:
            skipped.append(ticker)
        companies[ticker] = dict(ticker=ticker, sector=row['sec'], exposures=exposures[:3], reason=model['reason'], weekly_reason=model['weekly_reason'],
                                 all_factor_count=len(exposures), selection='Three largest absolute sector-shrunken one-standard-move associations; no forecast optimization')
    unavailable_sectors = [s['name'] for s in sectors if not s['factors']]
    if len(skipped) == len(companies) or len(unavailable_sectors) == len(sectors):
        raise ValueError('SUSPECT: zero reliable constituent or sector fits; previous artifacts retained')
    if unavailable_sectors:
        warnings.append('Not available: sector fits for '+', '.join(unavailable_sectors))
    common_end = min(f['change_asof'] for f in metadata)
    lag = (now.date()-date.fromisoformat(common_end)).days
    if lag > 4:
        warnings.append(f'Factor history ends {common_end}; historical models are stale for current-macro interpretation')
    else:
        warnings.append(f'Daily historical observations through {common_end}; not live quote data')
    short = any(not e['stability']['standard_two_year_design'] for s in sectors for e in s['factors'].values())
    if short:
        warnings.append('Cached stock history cannot support a two-year fit plus six-month holdout; shorter 120/60-session checks are labeled')
    if skipped:
        warnings.append(f'{len(skipped)} constituents have insufficient independent history')
    sources = {f['id']:f['source'] for f in metadata}
    sources.update(equities=dict(label='Yahoo adjusted-close returns; current S&P membership and market-cap proxy weights',url='https://finance.yahoo.com/'),
                   statements=dict(label='Dated company statements and sector valuation snapshot',url='https://finance.yahoo.com/'))
    for key,value in calendar.items():
        sources[key] = dict(label=f'Official {key} release calendar',url=value['source_url'])
    result = dict(schema=SCHEMA, generated_at=now.isoformat(timespec='seconds'), asof_session=cutoff,
                  status=dict(state='degraded' if warnings else 'ok',reasons=warnings),
                  windows=dict(equity_start=min(market),equity_end=max(market),factor_common_end=common_end,
                               fit_max_sessions=756,minimum_daily_n=120,minimum_weekly_n=26,kind='association'),
                  factors=metadata,sectors=sectors,companies=companies,
                  event_study=event_study(baskets,market,calendar),scenarios=make_scenarios(sectors,metadata),
                  opportunities=opportunities(companies,rows,metadata,data_root) if lag <= 4 else [],sources=sources,
                  coverage=dict(expected_constituents=len(rows),companies=len(companies),fitted=len(companies)-len(skipped),skipped=skipped,sectors=len(sectors)),
                  methods=dict(regression='Multivariate OLS on six shocks, with and without SPY market-return control; HAC Bartlett standard errors and asymptotic 90% intervals',
                               confidence='High: CI excludes zero, >=504 daily/104 weekly observations, >=2 folds, sign agreement >=80%, holdout correlation >=0.2. Medium: excludes zero, >=180 daily/40 weekly, >=1 fold, sign agreement >=60%. Otherwise low.',
                               shrinkage='Stock weight = n/(n+252) times beta^2/(beta^2+HAC_SE^2); sector proxy target. Unshrunk OLS CI retained; shrunk bands conditional, not calibrated coverage.',
                               holdout='Preferred 504/126 daily or 104/26 weekly train/test, non-overlapping forward tests. Short history uses 120/60 daily or 26/13 weekly, explicitly flagged. Same-period shocks; not next-day predictions.',
                               limits='Association is not causation. Current constituents/caps create survivorship and look-ahead weighting. Revised macro series, asynchronous closes, no real-time vintages, unadjusted multiple comparisons, omitted variables and unstable coefficients prevent predictive claims.',
                               weekly='Compound percent returns and percent factors; sum bp/point changes across complete observed equity weeks only. No missing date is replaced by zero.',
                               reasons='Every reason is a deterministic template; no model-generated numerical claims. Scenario CI describes coefficient uncertainty, not a prediction interval.'))
    validate(result)
    return clean(result)


def validate(obj):
    if obj.get('schema') != SCHEMA or not obj.get('generated_at'):
        raise ValueError('Invalid shock header')
    if len(obj['factors']) != 6 or len({f['id'] for f in obj['factors']}) != 6:
        raise ValueError('Six independent factor definitions required')
    for factor in obj['factors']:
        if not factor.get('source',{}).get('url') or not factor.get('change_asof') or not isinstance(factor.get('standard_move'),(int,float)) or factor['standard_move'] <= 0:
            raise ValueError('Shock factor provenance or standard-move scale missing')
    if obj['coverage']['companies'] <= 0 or obj['coverage']['companies'] != obj['coverage']['expected_constituents'] or len(obj['companies']) != obj['coverage']['companies']:
        raise ValueError('Shock constituent round-trip mismatch')
    for sector in obj['sectors']:
        for key,e in sector['factors'].items():
            if e['n'] < 120 or not e['window_start'] <= e['window_end'] or e['ci_low'] > e['beta'] or e['ci_high'] < e['beta']:
                raise ValueError('Invalid shock interval/window')
            if not e['reason'] or e['confidence'] not in ('high','medium','low') or not all(s in obj['sources'] for s in e['source_ids']):
                raise ValueError('Shock evidence provenance missing')
    for op in obj['opportunities']:
        if op.get('kind') != 'association' or not op.get('reason') or not op.get('counterargument') or len(op['summary'].split()) > 14:
            raise ValueError('Invalid opportunity copy or classification')
        for ev in op['evidence']:
            if not isinstance(ev.get('value'),(int,float)) or isinstance(ev['value'],bool) or not np.isfinite(ev['value']) or not ev.get('date') or not ev.get('source_url'):
                raise ValueError('Opportunity evidence missing numeric value, date or source')
    json.dumps(clean(obj), allow_nan=False)
    return True


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out',type=Path,default=ROOT/'app/data')
    parser.add_argument('--stage-root',type=Path)
    parser.add_argument('--offline',action='store_true',help='Use previously verified calendar cache only')
    args = parser.parse_args(argv); logs = ROOT/'logs/quant'; logs.mkdir(parents=True,exist_ok=True)
    outputs_written = []
    try:
        stage = args.stage_root or ROOT/'out'/read(args.out/'core.json')['asof_session']
        obj = build(args.out,stage,offline=args.offline,log_dir=logs)
        payload = json.dumps(obj,separators=(',',':'),ensure_ascii=False,allow_nan=False)
        # Serialize and verify completely before replacing last good output.
        args.out.mkdir(parents=True,exist_ok=True)
        intelligence_path = args.out/'intelligence.json'
        intelligence_payload = None
        if intelligence_path.exists():
            from smartoptions.brief.intelligence import attach_shocks, validate as validate_intelligence
            intelligence = read(intelligence_path)
            attach_shocks(intelligence,obj)
            validate_intelligence(intelligence)
            intelligence_payload = json.dumps(intelligence,separators=(',',':'),ensure_ascii=False,allow_nan=False)
        # Both artifacts pass schema validation before either last-good file changes.
        pending = args.out/'shocks.json.pending'
        pending.write_text(payload,encoding='utf-8')
        if intelligence_payload is not None:
            pending_intelligence = args.out/'intelligence.json.pending'
            pending_intelligence.write_text(intelligence_payload,encoding='utf-8')
        pending.replace(args.out/'shocks.json'); outputs_written.append('shocks.json')
        if intelligence_payload is not None:
            pending_intelligence.replace(intelligence_path); outputs_written.append('intelligence.json')
        receipt = dict(status='WARN' if obj['status']['state']=='degraded' else 'OK',generated_at=obj['generated_at'],coverage=obj['coverage'],
                       bytes=len(payload.encode()),reasons=obj['status']['reasons'])
        (logs/'build-receipt.json').write_text(json.dumps(receipt,indent=2),encoding='utf-8')
        event('shocks.build','snapshot',receipt['status'],str(obj['coverage']),obj['coverage']['fitted'],log_dir=logs)
        print(json.dumps(receipt))
        return 0
    except Exception as exc:
        retention = 'Previous artifacts retained' if not outputs_written else 'Partial write; inspect outputs_written in failure receipt'
        event('shocks.build','snapshot','FAIL',f'{type(exc).__name__}: {exc}; {retention}',log_dir=logs)
        (logs/'failure-receipt.json').write_text(json.dumps(dict(status='FAIL',reason=str(exc),previous_artifact_retained=not outputs_written,outputs_written=outputs_written)),encoding='utf-8')
        print(f'Shocks failed: {type(exc).__name__}: {exc}; {retention}',file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
