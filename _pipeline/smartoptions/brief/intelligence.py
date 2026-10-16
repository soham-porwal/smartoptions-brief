"""Evidence-bearing crossovers. Historical attribution is never a forecast.

The forecast audit uses lagged factors and chronological walk-forward holdout;
today's revised series and current membership are not point-in-time evidence.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from smartoptions.log import event
from .common import ROOT, load_json, number, write_json

SCHEMA = 'smartoptions.intelligence.v1'
FACTORS = {
    'spy': ('SPY', '%', '% stock return per 1% SPY return', 'https://finance.yahoo.com/quote/SPY/history/'),
    'us10y_bps': ('10-year Treasury yield', 'bp', '% stock return per 1 bp yield change', 'https://home.treasury.gov/resource-center-data-chart-center/interest-rates'),
    'dxy': ('US dollar index', '%', '% stock return per 1% DXY return', 'https://finance.yahoo.com/quote/DX-Y.NYB/history/'),
    'wti': ('WTI oil', '%', '% stock return per 1% WTI return', 'https://finance.yahoo.com/quote/CL=F/history/'),
    'vix': ('VIX', 'index points', '% stock return per 1 VIX point change', 'https://www.cboe.com/tradable_products/vix/vix_historical_data/'),
}
MIN_TRAIN, FIT_WINDOW, HOLDOUT = 120, 252, 60


def series(pairs, scale=1, cutoff=None):
    out = {}
    for pair in pairs or []:
        if not isinstance(pair, (list, tuple)) or len(pair) < 2:
            continue
        day, value = str(pair[0])[:10], number(pair[1])
        if value is not None and (cutoff is None or day <= cutoff):
            out[day] = value * scale
    return out


def rounded(value, digits=6):
    value = number(value)
    return round(value, digits) if value is not None else None


def evidence(label, value, unit, day, url, formula=None, reason=None):
    result = dict(label=label, value=rounded(value), unit=unit, date=day, source_url=url)
    if formula:
        result['formula'] = formula
    if result['value'] is None:
        result['reason'] = reason or 'Observation unavailable'
    return result


def direction(value):
    return 'unknown' if value is None else 'supportive' if value > 0 else 'adverse' if value < 0 else 'mixed'


def item(id_, title, summary, kind, ev, counterargument, source_ids, value=None, **extra):
    return dict(id=id_, title=title, summary=summary, direction=direction(value), kind=kind,
                evidence=ev, counterargument=counterargument, source_ids=source_ids, **extra)


def fit(y, X):
    design = np.column_stack([np.ones(len(y)), X])
    if len(y) <= design.shape[1] or np.linalg.matrix_rank(design) < design.shape[1]:
        raise ValueError('Insufficient independent observations for OLS')
    beta = np.linalg.lstsq(design, y, rcond=None)[0]
    residual = y - design @ beta
    total = float(np.sum((y - y.mean()) ** 2))
    r2 = 1 - float(residual @ residual) / total if total else None
    return beta, r2


def forecast_audit(returns, factors, session_days, holdout_n=HOLDOUT, min_train=MIN_TRAIN):
    """No target-day factors; one extra session delay for publication uncertainty.

    For target day t, feature observation day is t-2 in the equity calendar.
    All training target dates precede t. Missing dates are skipped, never filled.
    """
    keys = list(factors)
    samples = []
    for i in range(2, len(session_days)):
        target, feature = session_days[i], session_days[i - 2]
        if target in returns and all(feature in factors[k] for k in keys):
            samples.append((feature, target, returns[target], [factors[k][feature] for k in keys]))
    common = dict(target='Next equity-session adjusted-close return (%) with one additional session factor delay',
                  benchmark='Trailing training-window mean return; same training dates as model',
                  feature_delay_sessions=2, point_in_time_vintages=False,
                  limitation='Revised historical macro observations and current membership; actual release timestamps, costs and independent future replication are not tested.')
    n_test = min(holdout_n, max(0, len(samples) - min_train))
    if not keys or n_test < 20:
        return dict(common, status='unavailable', reason='Need 120 prior training targets and 20 holdout targets',
                    holdout_n=n_test, model_rmse_pct=None, baseline_rmse_pct=None, skill_vs_baseline_pct=None)
    predictions, baselines, actuals, details = [], [], [], []
    start = len(samples) - n_test
    try:
        for index in range(start, len(samples)):
            training = samples[max(0, index - FIT_WINDOW):index]
            y = np.array([r[2] for r in training])
            X = np.array([r[3] for r in training])
            beta, _ = fit(y, X)
            test = samples[index]
            predicted = float(np.r_[1.0, test[3]] @ beta)
            baseline = float(y.mean())
            predictions.append(predicted); baselines.append(baseline); actuals.append(test[2])
            details.append(dict(feature_date=test[0], target_date=test[1], train_end=training[-1][1],
                                predicted_pct=rounded(predicted), baseline_pct=rounded(baseline), actual_pct=rounded(test[2])))
    except (ValueError, np.linalg.LinAlgError) as exc:
        event('intelligence.validation', 'fit', 'WARN', type(exc).__name__)
        return dict(common, status='unavailable', reason='Lagged design is rank deficient', holdout_n=0,
                    model_rmse_pct=None, baseline_rmse_pct=None, skill_vs_baseline_pct=None)
    actual = np.array(actuals)
    model_mse = float(np.mean((actual - predictions) ** 2))
    base_mse = float(np.mean((actual - baselines) ** 2))
    skill = (1 - model_mse / base_mse) * 100 if base_mse > 0 else None
    return dict(common, status='no_demonstrated_predictive_edge', holdout_n=n_test,
                holdout_start=samples[start][1], holdout_end=samples[-1][1],
                train_first_target=samples[0][1], min_train_n=min_train, max_train_n=FIT_WINDOW,
                model_rmse_pct=rounded(math.sqrt(model_mse)), baseline_rmse_pct=rounded(math.sqrt(base_mse)),
                skill_vs_baseline_pct=rounded(skill),
                direction_accuracy_pct=rounded(float(np.mean(np.sign(actual) == np.sign(predictions))) * 100),
                beat_baseline_in_this_sample=bool(skill is not None and skill > 0),
                recent_predictions=details[-3:])


def metric_from_card(company, card_key, label=None):
    metrics = (company.get('cards', {}).get(card_key) or {}).get('metrics') or []
    metric = next((m for m in metrics if label is None or m.get('label') == label), {})
    dates = re.findall(r'\d{4}-\d{2}-\d{2}', str(metric.get('period') or ''))
    return evidence(metric.get('label') or label or card_key, metric.get('value'), metric.get('unit') or '',
                    dates[-1] if dates else metric.get('asof'), metric.get('source_url') or 'https://finance.yahoo.com/',
                    reason=metric.get('note'))


def build(data_root, stage_root, now=None):
    data_root, stage_root = Path(data_root), Path(stage_root)
    now = now or datetime.now(timezone.utc)
    core = load_json(data_root / 'core.json', required=True)
    macro = load_json(stage_root / 'macro.json', required=True)
    equities = load_json(stage_root / 'equities.json', required=True)
    rows = core.get('rows') or []
    if not rows or not equities.get('returns'):
        raise ValueError('SUSPECT: missing company rows or return history')
    asof = core.get('asof_session')
    if not asof or equities.get('asof_session') != asof:
        raise ValueError('Core and equity sessions disagree')
    declared_unit = (equities.get('meta') or {}).get('returns_unit', '')
    if declared_unit and 'fraction' not in declared_unit.lower():
        raise ValueError('Equity input returns must be decimal fractions, not percent units')
    returns = {t: series(pairs, 100, asof) for t, pairs in equities['returns'].items()}
    daily = macro.get('daily_factors') or {}
    candidates = dict(spy=returns.get('SPY', {}), us10y_bps=series(daily.get('us10y_bps_chg'), cutoff=asof),
                      dxy=series(daily.get('dxy_ret'), cutoff=asof), wti=series(daily.get('wti_ret'), cutoff=asof),
                      vix=series(daily.get('vix_chg'), cutoff=asof))
    factors = {key: values for key, values in candidates.items() if len(values) >= MIN_TRAIN}
    common_days = sorted(set.intersection(*(set(v) for v in factors.values()))) if factors else []
    model_asof = common_days[-1] if common_days else None
    sources = {k: dict(label=v[0], url=v[3]) for k, v in FACTORS.items()}
    sources.update(yahoo=dict(label='Yahoo adjusted-close history', url='https://finance.yahoo.com/'),
                   statements=dict(label='Yahoo company statements', url='https://finance.yahoo.com/'))
    capital_path = data_root / 'money-flow.json'
    capital = load_json(capital_path, required=True) if capital_path.exists() else {}
    if capital:
        sources['capital_news'] = dict(label='Dated public headline metadata', url='https://finnhub.io/docs/api/market-news')
    changes = {k: sum(factors[k][d] for d in common_days[-20:]) if len(common_days) >= 20 else None for k in factors}
    companies, audits, skipped = {}, {}, []
    for row in rows:
        ticker = row['t']; yseries = returns.get(ticker, {})
        company_path = data_root / 'brief' / 'company' / f'{ticker}.json'
        company = load_json(company_path, {}) if company_path.exists() else {}
        fundamental_metrics = [m for key, c in company.get('cards', {}).items() if key != 'valuation' for m in c.get('metrics') or []]
        periods = sorted({str(m['period']) for m in fundamental_metrics if m.get('period') and m.get('value') is not None})
        stamps = sorted({str(m['asof']) for m in fundamental_metrics if m.get('asof')})
        url = f'https://finance.yahoo.com/quote/{ticker}/history/'
        rec = dict(ticker=ticker, headline='Relationship data unavailable', relationships=[], observed_return_pct=None,
                   explained_return_pct=None, residual_return_pct=None, return_asof=None, sensitivity={}, sample_n=None,
                   model_asof=None, model_r2=None, missing_reasons={},
                   fundamentals_basis=dict(asof=stamps[-1] if stamps else None, periods=periods,
                                           note='Statement reporting periods; retrieval date is not report period'),
                   valuation_basis=dict(asof=row.get('rat'), quote_asof=row.get('pxd'),
                                        note='P/E and sector comparison from snapshot; intraday quotes do not refit fundamentals'),
                   event_risk=dict(summary=(company.get('events') or {}).get('line') or 'Earnings timing unavailable',
                                   date=row.get('er'), source_url=f'https://finance.yahoo.com/quote/{ticker}/calendar/'))
        days = [d for d in common_days if d in yseries][-FIT_WINDOW:]
        keys = list(factors)
        if len(days) < MIN_TRAIN or not keys:
            rec['missing_reasons']['model'] = f'Need {MIN_TRAIN} common sessions; found {len(days)}'
            skipped.append(ticker)
        else:
            try:
                y = np.array([yseries[d] for d in days]); X = np.array([[factors[k][d] for k in keys] for d in days])
                beta, r2 = fit(y, X)
                day = days[-1]; observed = yseries[day]
                explained = float(np.r_[1, X[-1]] @ beta); residual = observed - explained
                rec.update(headline=f'{ticker}: {observed:+.2f}% observed, {explained:+.2f}% historical factor fit, {residual:+.2f}% unexplained',
                           observed_return_pct=rounded(observed), explained_return_pct=rounded(explained),
                           residual_return_pct=rounded(residual), return_asof=day, model_asof=day,
                           model_r2=rounded(r2), sample_n=len(days), intercept_pct=rounded(beta[0]),
                           sensitivity={k: dict(coefficient=rounded(b), unit=FACTORS[k][2]) for k, b in zip(keys, beta[1:])})
                company_days = [d for d in common_days if d <= day]
                company_changes = {k: sum(factors[k][d] for d in company_days[-20:]) if len(company_days) >= 20 else None for k in keys}
                macro_keys = sorted([k for k in keys if k != 'spy'],
                                    key=lambda k: -abs(float(beta[keys.index(k) + 1]) * (company_changes[k] or 0)))[:2]
                for key in macro_keys:
                    coef = float(beta[keys.index(key) + 1]); change = company_changes[key]
                    impact = None if change is None else coef * change
                    factor = FACTORS[key]
                    ev = [evidence(f'{factor[0]} change over 20 common sessions', change, factor[1], day, factor[3],
                                   'Sum of daily factor changes on 20 common factor/equity sessions'),
                          evidence('Historical sensitivity', coef, factor[2], day, factor[3], 'OLS with intercept, holding other included factors fixed'),
                          evidence('Associated contribution', impact, '% stock return', day, url, 'Historical coefficient × summed factor change; additive, not compounded')]
                    rec['relationships'].append(item(f'{ticker}-{key}', f'{factor[0]} × {ticker}',
                        f'{factor[0]} changed {change:+.2f} {factor[1]}; historical fit associates this with {impact:+.2f}% in {ticker} over 20 shared sessions.' if impact is not None else 'Insufficient common sessions for a 20-session comparison.',
                        'association', ev, 'Co-movement is not causation. Other factors, earnings and coefficient instability may reverse this interpretation.',
                        [key, 'yahoo'], impact, ticker=ticker, factor=key))
                rec['relationships'].append(item(f'{ticker}-residual', 'What the factor fit leaves unexplained',
                    f'{residual:+.2f}% of the {day} move remains outside this historical fit; check company disclosures.',
                    'association', [evidence('Observed adjusted-close return', observed, '%', day, url),
                                    evidence('Fitted return including intercept', explained, '%', day, url, 'intercept + sum(coefficient × same-session factor change)'),
                                    evidence('Unexplained return', residual, '%', day, url, 'observed − fitted')],
                    'The residual also includes model error and omitted risks; it does not establish company news or mispricing.', ['yahoo'], residual, ticker=ticker))
                if 'us10y_bps' in keys:
                    coef = float(beta[keys.index('us10y_bps') + 1]); impact = coef * 25
                    rec['relationships'].append(item(f'{ticker}-rates-scenario', 'If the 10-year yield rose 25 bp',
                        f'Holding other factors fixed, the historical linear sensitivity maps +25 bp to {impact:+.2f}% for {ticker}.',
                        'scenario', [evidence('Hypothetical yield shock', 25, 'bp', day, FACTORS['us10y_bps'][3], 'User-independent standardized what-if; not a forecast'),
                                     evidence('Conditional sensitivity impact', impact, '% stock return', day, url, '25 bp × historical yield coefficient; excludes intercept')],
                        'Factors rarely move alone; extrapolation, nonlinear effects and changing regimes can invalidate this scenario.', ['us10y_bps', 'yahoo'], impact, ticker=ticker))
            except (ValueError, np.linalg.LinAlgError) as exc:
                event('intelligence.fit', ticker, 'WARN', type(exc).__name__)
                rec['missing_reasons']['model'] = 'Insufficient independent factor observations'
                skipped.append(ticker)
        audit = forecast_audit(yseries, factors, sorted(returns.get('SPY', {})))
        audits[ticker] = audit
        rec['validation'] = {k: v for k, v in audit.items() if k not in ('recent_predictions', 'target', 'benchmark', 'limitation')}
        for key in ('observed_return_pct', 'explained_return_pct', 'residual_return_pct', 'sample_n', 'model_r2', 'model_asof'):
            if rec[key] is None:
                rec['missing_reasons'][key] = rec['missing_reasons'].get('model', 'Unavailable')
        if not stamps:
            rec['missing_reasons']['fundamentals_basis'] = 'No statement retrieval provenance is available'
        if not row.get('rat'):
            rec['missing_reasons']['valuation_basis'] = 'No valuation retrieval provenance is available'
        # Only the collector's exact ticker tags can join news to a company.
        # Never infer a ticker from a fuzzy company-name/headline match.
        news = sorted([n for n in capital.get('news') or [] if ticker in (n.get('tickers') or [])
                       and n.get('url') and n.get('published_at') and n.get('headline')],
                      key=lambda n: n['published_at'], reverse=True)
        if news:
            latest = news[0]
            rec['relationships'].append(item(f'{ticker}-news-context', 'Recent company news to investigate',
                str(latest['headline'])[:350] + '. This is dated context; a headline alone does not explain a fitted residual or establish a forecast.',
                'observed', [evidence(str(latest['headline'])[:350], None, 'headline metadata', latest['published_at'], latest['url'],
                                      reason='Text headline, not a numeric factor contribution or causal estimate')],
                'Check the full source, timing and company filing. Price reaction and factual significance are not verified by headline metadata.',
                ['capital_news'], ticker=ticker, category=latest.get('category'), context_only=True))
        companies[ticker] = rec
    drivers, opportunities = [], []
    for key in ('us10y_bps', 'dxy', 'wti', 'vix'):
        if key not in factors:
            continue
        change = changes[key]; label, unit, _, url = FACTORS[key]
        exposed = sorted((c for c in companies.values() if key in c['sensitivity']),
                         key=lambda c: -abs(c['sensitivity'][key]['coefficient'] * (change or 0)))[:3]
        names = ', '.join(c['ticker'] for c in exposed)
        drivers.append(item(f'market-{key}', f'{label}: {change:+.2f} {unit} over 20 shared sessions' if change is not None else f'{label}: insufficient history',
            f'Largest measured sensitivity crossovers in this snapshot: {names}.' if names else 'No company sensitivity is available.',
            'association', [evidence(f'{label} change', change, unit, model_asof, url, 'Sum across the last 20 common sessions')],
            'Historical sensitivity ranks describe exposure, not expected returns or recommendations.', [key], None,
            companies=[c['ticker'] for c in exposed], factor=key))
        if exposed:
            chosen = exposed[0]; ticker = chosen['ticker']
            rel = next((r for r in chosen['relationships'] if r.get('factor') == key), None)
            if rel:
                company = load_json(data_root / 'brief' / 'company' / f'{ticker}.json', {})
                valuation = metric_from_card(company, 'valuation', 'Trailing P/E / sector median')
                growth = metric_from_card(company, 'growth', 'Revenue growth YoY')
                cross_reason = (f'This exposure sits beside a trailing P/E of {valuation["value"]:.2f}× sector peers and revenue growth of {growth["value"]:+.1f}%; valuation and earnings trajectory can offset a macro interpretation.'
                                if valuation['value'] is not None and growth['value'] is not None
                                else 'Incomplete valuation or growth evidence limits the company comparison; inspect the filing before drawing a conclusion.')
                opportunities.append(dict(rel, id=f'research-{ticker}-{key}', title=f'Research {ticker}: {label.lower()} crossover',
                    summary=rel['summary'] + ' ' + cross_reason,
                    evidence=rel['evidence'] + [valuation, growth], source_ids=rel['source_ids'] + ['statements'],
                    research_question='Does the latest filing and guidance support this historical exposure, and do valuation and upcoming earnings offset it?',
                    counterargument=rel['counterargument'] + ' Cheap multiples can reflect deteriorating earnings; a high-growth firm can still be overpriced.'))
    eligible = [a for a in audits.values() if a['status'] != 'unavailable']
    starts = [a['holdout_start'] for a in eligible]; ends = [a['holdout_end'] for a in eligible]
    reasons = []
    if model_asof != asof:
        reasons.append(f'Common factor observations end {model_asof}; equity snapshot is {asof}')
    if skipped:
        reasons.append(f'{len(skipped)} companies lack a reliable sensitivity fit')
    if len(factors) != len(FACTORS):
        reasons.append('Unavailable factors: ' + ', '.join(set(FACTORS) - set(factors)))
    result = dict(schema=SCHEMA, generated_at=now.isoformat(timespec='seconds'), asof_session=asof,
        basis=dict(snapshot_date=asof, model_asof=model_asof,
                   quote_date=load_json(data_root / 'quotes.json', {}).get('generated_at') if (data_root / 'quotes.json').exists() else None,
                   capital_asof=capital.get('generated_at'),
                   fundamentals_note='Company statement reporting periods and retrieval timestamps are retained per company. Quotes do not update fits.'),
        status=dict(state='degraded' if reasons else 'ok', reasons=reasons),
        market=dict(headline='Macro changes cross into companies through measured historical sensitivities',
                    summary=f'{len(companies) - len(skipped)} company fits; factor observations through {model_asof}. Research leads below are associations, with counterarguments and separate what-if scenarios.', drivers=drivers),
        opportunities=opportunities, companies=companies,
        validation=dict(status='no_demonstrated_predictive_edge',
            target='Next equity-session adjusted-close return (%) with one additional session factor delay',
            benchmark='Trailing training-window mean return; same dates as fitted model',
            holdout=dict(method='Chronological expanding walk-forward; last up to 60 targets; refit only on earlier targets',
                         start=min(starts) if starts else None, end=max(ends) if ends else None,
                         min_train_n=MIN_TRAIN, max_train_n=FIT_WINDOW, feature_delay_sessions=2),
            summary=f'{len(eligible)} companies audited; {sum(a["beat_baseline_in_this_sample"] for a in eligible)} beat baseline MSE in this sample. This is not demonstrated predictive edge: no point-in-time macro vintages, membership history, execution costs or independent replication.',
            company_results={t: {k: v for k, v in a.items() if k not in ('target', 'benchmark', 'limitation')} for t, a in audits.items()}),
        methods=dict(association='OLS with intercept on up to 252 same-session adjusted-close stock returns (%) and factor changes; minimum 120 sessions. Same-day fit is descriptive.',
                     attribution='Fitted return includes intercept. Unexplained = observed minus fitted; residual is not proved company-specific news.',
                     scenario='Coefficient × hypothetical factor shock, holding other factors fixed; excludes intercept. No probability or return forecast.',
                     selection='Research leads choose greatest absolute 20-session historical factor contribution per macro factor, without optimizing a forecast or implying a trade.',
                     validation='For target t, factors observed at equity session t−2. Training targets strictly precede holdout target. Missing dates never forward-filled. Revised series limit point-in-time validity.'),
        sources=sources)
    shock_path = data_root / 'shocks.json'
    if shock_path.exists():
        attach_shocks(result, load_json(shock_path, required=True))
    validate(result, [r['t'] for r in rows])
    event('intelligence.verify', 'companies', 'WARN' if reasons else 'OK', f'{len(companies)}/{len(rows)} companies; fits={len(companies)-len(skipped)}; audited={len(eligible)}', len(companies))
    return result


def attach_shocks(obj, shocks):
    """Add HAC evidence without overwriting existing coefficients or changing units."""
    from smartoptions.shocks import validate as validate_shocks
    validate_shocks(shocks)
    obj['market']['drivers'] = [r for r in obj['market']['drivers'] if not r['id'].startswith('shock-')]
    obj['opportunities'] = [r for r in obj['opportunities'] if not r['id'].startswith('shock-')]
    for company in obj['companies'].values():
        company['relationships'] = [r for r in company['relationships'] if not r['id'].startswith('shock-')]
        company.pop('shock_exposures', None)
    if shocks.get('asof_session') != obj.get('asof_session'):
        obj['shocks'] = dict(status='unavailable', reason='Shock and intelligence snapshot sessions disagree')
        obj['status']['state'] = 'degraded'
        message = 'Shock crossovers unavailable: snapshot sessions disagree'
        if message not in obj['status']['reasons']:
            obj['status']['reasons'].append(message)
        return obj
    for key, source in shocks['sources'].items():
        obj['sources']['shock_' + key] = source
    obj['shocks'] = dict(schema=shocks['schema'], generated_at=shocks['generated_at'],
                         model_asof=shocks['windows']['factor_common_end'], status=shocks['status'],
                         coverage=shocks['coverage'], data_url='data/shocks.json',
                         reason='Market-controlled historical associations with HAC intervals. Quotes do not refresh coefficients.',
                         scenarios=[dict(id=s['id'], label=s['label'], kind='scenario') for s in shocks['scenarios']])
    obj['market']['drivers'] = [r for r in obj['market']['drivers'] if not r['id'].startswith('shock-')]
    obj['opportunities'] = [r for r in obj['opportunities'] if not r['id'].startswith('shock-')]
    candidates = []
    for f in shocks['factors']:
        if f['recent_change'] is None or f.get('freshness') == 'stale':
            continue
        available = [(s, s['factors'][f['id']]) for s in shocks['sectors'] if f['id'] in s['factors']]
        if not available:
            continue
        sector, e = max(available, key=lambda pair:abs(pair[1]['beta'] * f['recent_change']))
        impact = e['beta'] * f['recent_change']
        ev = [evidence('Observed 20-session factor change', f['recent_change'], f['unit'],f['recent_change_date'],f['source']['url']),
              evidence('Market-controlled historical sensitivity',e['beta'],e['unit'],e['window_end'],f['source']['url']),
              evidence('90% HAC interval lower',e['ci_low'],e['unit'],e['window_end'],f['source']['url']),
              evidence('90% HAC interval upper',e['ci_high'],e['unit'],e['window_end'],f['source']['url']),
              evidence('Fit sample',e['n'],'sessions',e['window_end'],f['source']['url'])]
        candidates.append((abs(impact),item(f'shock-sector-{f["id"]}',f'{sector["name"]}: {f["label"].lower()} association',
            f'{sector["name"]} has a {impact:+.2f}% conditional association for the net 20-observation factor change. Confidence is {e["confidence"]}; this is not an additive realized contribution or forecast.',
            'association',ev,'Current-cap sector proxies and unstable sensitivities can change this relationship; the interval is not a future-return range.',
            ['shock_'+f['id'],'shock_equities'],impact,factor=f['id'],confidence=e['confidence'])))
    obj['market']['drivers'].extend(r for _,r in sorted(candidates,key=lambda p:-p[0])[:3])
    for op in shocks['opportunities']:
        obj['opportunities'].append(dict(op,source_ids=['shock_'+s for s in op['source_ids']]))
    for ticker,company in obj['companies'].items():
        company['relationships'] = [r for r in company['relationships'] if not r['id'].startswith('shock-')]
        exposures = shocks['companies'].get(ticker, {}).get('exposures', [])
        # Compact fields here; full daily/weekly fits live in shocks.json.
        company['shock_exposures'] = [{k:e[k] for k in ('factor','beta','ci_low','ci_high','n','confidence','window_start','window_end','unit','estimated_move_pct','shrunk')} for e in exposures]
        if not exposures:
            continue
        e = exposures[0]; f = next(f for f in shocks['factors'] if f['id'] == e['factor'])
        company['relationships'].append(item(f'shock-{ticker}-standard',f'{f["label"]}: measured shock exposure',e['reason'],
            'association',[
                evidence('Sector-shrunken standard-move association',e['estimated_move_pct'],'% return',e['window_end'],f['source']['url']),
                evidence('Unshrunk market-controlled sensitivity',e['beta'],e['unit'],e['window_end'],f['source']['url']),
                evidence('Unshrunk 90% HAC lower',e['ci_low'],e['unit'],e['window_end'],f['source']['url']),
                evidence('Unshrunk 90% HAC upper',e['ci_high'],e['unit'],e['window_end'],f['source']['url']),
                evidence('Chronological holdout sign agreement',e['oos_sign_agreement'],'fraction',e['window_end'],f['source']['url'],
                         reason='Not available: insufficient chronological holdout windows')],
            'Sector shrinkage reduces noisy estimates; confidence still uses unshrunk evidence. This is an association, not a price target.',
            ['shock_'+e['factor'],'shock_equities'],e['estimated_move_pct'],ticker=ticker,confidence=e['confidence']))
    return obj


def validate(obj, expected_tickers=None):
    if obj.get('schema') != SCHEMA or not obj.get('generated_at') or not obj.get('asof_session'):
        raise ValueError('Invalid intelligence header')
    companies = obj.get('companies') or {}
    if not companies or (expected_tickers is not None and set(companies) != set(expected_tickers)):
        raise ValueError('Company round-trip coverage mismatch')
    for company in companies.values():
        observed, explained, residual = [company.get(k) for k in ('observed_return_pct', 'explained_return_pct', 'residual_return_pct')]
        if all(v is not None for v in (observed, explained, residual)) and abs(observed - explained - residual) > .00001:
            raise ValueError('Return attribution does not reconcile')
        for rel in company['relationships']:
            validate_item(rel, obj['sources'])
    for rel in obj['market']['drivers'] + obj['opportunities']:
        validate_item(rel, obj['sources'])
    if obj['validation']['status'] != 'no_demonstrated_predictive_edge':
        raise ValueError('Unvalidated predictive claim')
    json.dumps(obj, allow_nan=False)
    return True


def validate_item(rel, sources):
    if rel['kind'] not in ('observed', 'association', 'scenario') or rel['direction'] not in ('supportive', 'adverse', 'mixed', 'unknown'):
        raise ValueError('Invalid relationship classification')
    if not rel['counterargument'] or not rel['evidence'] or any(s not in sources for s in rel['source_ids']):
        raise ValueError('Relationship missing evidence/counterargument/source')
    for ev in rel['evidence']:
        if not ev.get('source_url') or not isinstance(ev.get('unit'), str) or not ev.get('date') and ev['value'] is not None:
            raise ValueError('Evidence missing source, date or unit')
        if ev['value'] is None and not ev.get('reason'):
            raise ValueError('Missing evidence needs a reason')
        if ev['value'] is not None and number(ev['value']) is None:
            raise ValueError('Evidence values must be finite numbers or null')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-root', type=Path, default=ROOT / 'app/data')
    parser.add_argument('--stage-root', type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        obj = build(args.data_root, args.stage_root)
        size = write_json(args.data_root / 'intelligence.json', obj)
        print(f'Intelligence: {len(obj["companies"])} companies, {size} bytes; {obj["validation"]["status"]}')
        return 0
    except Exception as exc:
        event('intelligence.build', 'snapshot', 'FAIL', f'{type(exc).__name__}: build failed; previous artifact retained')
        print(f'Intelligence failed: {type(exc).__name__}; previous artifact retained', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
