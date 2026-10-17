"""Relationship catalog and sector baskets for the Explore workspace (schema brief.relationships.v1).

Discovery is offline and bounded: a fixed candidate list (<= MAX_CANDIDATES pairs) is fitted here once per build.
The browser only applies these dated, versioned numbers; it never refits them or invents new ones.

Method (docs/BRIEF-METHODS.md, "Relationship catalog"):
- Daily series only. Prices become % returns, rates/spreads/VIX become changes in their own units.
- Pairs are aligned on dates BOTH series observed; each change spans the same interval for both series
  (consecutive common dates). Nothing is forward-filled. Monthly/weekly macro series are excluded because
  pairing them with daily returns would create pseudo-samples.
- Contemporaneous OLS y = a + b x with classic standard errors; Pearson correlation; first/second half split;
  chronological 70/30 holdout of the SAME-DAY fit (stability, not prediction) against a zero-slope baseline.
- Sector baskets are equal-weight averages of member daily returns, labelled as baskets, never as ETFs.
  Member returns above MAX_ABS_RET are excluded as probable unadjusted splits and counted.
Associations, not causes or forecasts. No predictive language is emitted.
"""
from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import numpy as np

from smartoptions.log import event
from .common import ROOT, load_json, number, utcnow, write_json

SCHEMA = 'brief.relationships.v1'
MAX_CANDIDATES = 64
MIN_N = 120
FIT_WINDOW = 252
HOLDOUT_FRAC = 0.3
MAX_ABS_RET = 45.0      # % daily member move treated as a probable split in unadjusted prices
MIN_BASKET_COVER = 0.5  # share of members needed for a basket day

# id -> (label, unit of the level, change kind, change unit, source type)
MACRO = {
    'us10y': ('10-year Treasury yield', '%', 'diff_bp', 'bp', 'US Treasury daily par yield'),
    'us2y': ('2-year Treasury yield', '%', 'diff_bp', 'bp', 'US Treasury daily par yield'),
    'spread_10y_2y': ('10y minus 2y Treasury spread', 'bp', 'diff', 'bp', 'US Treasury, derived'),
    'dxy': ('US dollar index (DXY)', 'index points', 'ret', '%', 'ICE index via Yahoo, delayed'),
    'wti': ('WTI crude front month', 'USD/barrel', 'ret', '%', 'NYMEX futures via Yahoo, not roll-adjusted'),
    'copper': ('Copper front month', 'USD/lb', 'ret', '%', 'COMEX futures via Yahoo, not roll-adjusted'),
    'hy_oas': ('High-yield credit spread (ICE BofA OAS)', 'bp', 'diff', 'bp', 'ICE BofA via FRED'),
    'vix': ('VIX', 'index points', 'diff', 'points', 'Cboe index close'),
}
FACTORS_FOR_SECTORS = ('us10y', 'wti', 'dxy', 'vix')
JOINT_NAMES = ('SPY', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'JPM', 'XOM')
PAIR_BUDGET = 46  # 18 predeclared joint candidates + 46 pair candidates = 64
MARKET_FACTORS = ('us10y', 'dxy', 'wti', 'copper', 'hy_oas', 'vix', 'spread_10y_2y')


def macro_hist(core, mid):
    for group in (core.get('macro') or {}).values():
        for x in group or []:
            if x.get('id') == mid and x.get('h'):
                out = {}
                for p in x['h']:
                    v = number(p[1]) if isinstance(p, (list, tuple)) and len(p) > 1 else None
                    if v is not None:
                        out[str(p[0])[:10]] = v
                return out, x
    return None, None


def closes(path):
    obj = load_json(path, None)
    bars = (obj or {}).get('bars') or []
    out = {}
    for b in bars:
        if isinstance(b, (list, tuple)) and len(b) > 4:
            v = number(b[4])
            if v is not None and v > 0:
                out[str(b[0])[:10]] = v
    return out


def changes(a, b, kind_a, kind_b):
    """Aligned changes on consecutive COMMON dates. Returns (dates, ya, xb, accounting)."""
    common = sorted(set(a) & set(b))
    acc = {'a_obs': len(a), 'b_obs': len(b), 'common_dates': len(common),
           'a_only': len(set(a) - set(b)), 'b_only': len(set(b) - set(a)), 'invalid': 0}
    dates, ya, xb = [], [], []
    for d0, d1 in zip(common, common[1:]):
        ca, cb = chg(a[d0], a[d1], kind_a), chg(b[d0], b[d1], kind_b)
        if ca is None or cb is None:
            acc['invalid'] += 1
            continue
        dates.append(d1); ya.append(ca); xb.append(cb)
    acc['changes'] = len(dates)
    return dates, np.array(ya, float), np.array(xb, float), acc


def chg(v0, v1, kind):
    if kind == 'ret':
        return 100.0 * (v1 / v0 - 1.0) if v0 > 0 and v1 > 0 else None
    if kind == 'diff_bp':
        return 100.0 * (v1 - v0)
    return v1 - v0


def ols1(y, x):
    """Slope, intercept, standard error, t, r2 and correlation for y = a + b x."""
    n = len(y)
    if n < 3:
        return None
    mx, my = x.mean(), y.mean()
    sxx, syy, sxy = float(((x - mx) ** 2).sum()), float(((y - my) ** 2).sum()), float(((x - mx) * (y - my)).sum())
    if sxx <= 0 or syy <= 0:
        return None
    b = sxy / sxx
    a = my - b * mx
    resid = y - a - b * x
    s2 = float(resid @ resid) / (n - 2)
    se = math.sqrt(s2 / sxx)
    r = sxy / math.sqrt(sxx * syy)
    return {'beta': b, 'alpha': a, 'se': se, 't': b / se if se > 0 else None, 'r': r, 'r2': r * r, 'n': n}


def ols2(y, x, z):
    """Slope on x holding z (the market) fixed; returns (b_x, se_x) or None."""
    n = len(y)
    X = np.column_stack([np.ones(n), x, z])
    if n <= 4 or np.linalg.matrix_rank(X) < 3:
        return None
    coef, *_ = np.linalg.lstsq(X, y, rcond=None)
    resid = y - X @ coef
    s2 = float(resid @ resid) / (n - 3)
    cov = s2 * np.linalg.inv(X.T @ X)
    return float(coef[1]), math.sqrt(float(cov[1, 1]))


def joint_fit(y, predictors, dates, minimum=MIN_N):
    """Joint same-day OLS, classical conditional-mean and individual-day uncertainty.
    Standardized condition guard rejects nearly collinear factors, regardless of units.
    """
    n = len(y)
    if n < minimum:
        return {'available': False, 'reason': f'{n} common changes; minimum {minimum}'}
    a = np.asarray(predictors, float).T
    sd = a.std(axis=0)
    if np.any(sd <= 0):
        return {'available': False, 'reason': 'Constant economic driver'}
    condition = float(np.linalg.cond((a - a.mean(axis=0)) / sd))
    if not math.isfinite(condition) or condition > 30:
        return {'available': False, 'reason': 'Economic drivers are too collinear to separate reliably'}
    X = np.column_stack([np.ones(n), a])
    if np.linalg.matrix_rank(X) < X.shape[1]:
        return {'available': False, 'reason': 'Joint design is singular'}
    coef, *_ = np.linalg.lstsq(X, y, rcond=None)
    resid = np.asarray(y) - X @ coef
    df = n - X.shape[1]
    s2 = float(resid @ resid) / df
    inv = np.linalg.inv(X.T @ X)
    ss = float(((np.asarray(y) - np.mean(y)) ** 2).sum())
    z = 1.959963984540054
    tc = z + (z**3 + z)/(4*df) + (5*z**5+16*z**3+3*z)/(96*df**2) + (3*z**7+19*z**5+17*z**3-15*z)/(384*df**3)
    return dict(available=True, n=n, df=df, fit_start=dates[0], fit_end=dates[-1],
                coefficients=coef.tolist(), inverse_xtx=inv.tolist(), residual_variance=s2,
                tcrit=tc, condition=condition, r2=1-float(resid@resid)/ss if ss else None,
                bounds=[[float(np.percentile(v,5)),float(np.percentile(v,95))] for v in predictors],
                method='Joint same-day OLS with intercept; classical Student-t mean and individual-day bands; no causal interpretation')


def joint_catalog(series):
    targets = [k for k in series if k.startswith('sec:')] + ['eq:' + t for t in JOINT_NAMES]
    out = []
    for target in targets[:18]:
        entry = dict(y=target, drivers=['mac:us10y', 'mac:wti'], units=['bp', '%'], y_unit='%')
        ids = [target, *entry['drivers']]
        if any(k not in series for k in ids):
            out.append(dict(entry, available=False, reason='Required dated price or economic history unavailable'))
            continue
        src = [series[k] for k in ids]
        common = sorted(set.intersection(*(set(s[0]) for s in src)))
        vals, days = [], []
        for d0,d1 in zip(common,common[1:]):
            v = [chg(s[0][d0], s[0][d1], s[1]) for s in src]
            if all(x is not None and math.isfinite(x) for x in v) and abs(v[0]) <= MAX_ABS_RET:
                vals.append(v); days.append(d1)
        vals = np.asarray(vals[-FIT_WINDOW:], float)
        if len(vals):
            fit = joint_fit(vals[:,0], [vals[:,1], vals[:,2]], days[-FIT_WINDOW:])
        else:
            fit = dict(available=False, reason='No common daily changes')
        out.append(dict(entry, **fit))
    return out


def holdout(y, x, frac=HOLDOUT_FRAC):
    """Fit slope on the earliest (1-frac), score same-day R2 on the latest frac versus a zero-slope baseline
    that predicts the training mean. Positive oos_r2 = the historical association held out of sample."""
    n = len(y)
    k = int(round(n * (1 - frac)))
    if k < 60 or n - k < 20:
        return None
    fit = ols1(y[:k], x[:k])
    if not fit:
        return None
    yt, xt = y[k:], x[k:]
    sse = float(((yt - fit['alpha'] - fit['beta'] * xt) ** 2).sum())
    base = float(((yt - y[:k].mean()) ** 2).sum())
    return {'train_n': k, 'test_n': n - k, 'beta_train': fit['beta'], 'oos_r2': 1 - sse / base if base > 0 else None}


def describe(y, x, dates, acc, z=None):
    y, x = y[-FIT_WINDOW:], x[-FIT_WINDOW:]
    dates = dates[-FIT_WINDOW:]
    zz = z[-FIT_WINDOW:] if z is not None else None
    f = ols1(y, x)
    if not f:
        return None
    h = len(y) // 2
    f1, f2 = ols1(y[:h], x[:h]), ols1(y[h:], x[h:])
    ho = holdout(y, x)
    # honest counterexample: the largest factor move where y went the opposite way to the fitted sign
    sign = 1 if f['beta'] >= 0 else -1
    idx = [i for i in range(len(x)) if x[i] != 0 and y[i] != 0 and np.sign(y[i]) != sign * np.sign(x[i])]
    ce = max(idx, key=lambda i: abs(x[i])) if idx else None
    p5, p95 = (float(np.percentile(x, 5)), float(np.percentile(x, 95)))
    same_sign = f1 and f2 and (f1['r'] >= 0) == (f2['r'] >= 0)
    t = f['t'] or 0
    oos = ho and ho['oos_r2']
    if abs(t) < 2:
        stab = 'weak'
    elif abs(t) >= 3 and same_sign and oos is not None and oos > 0:
        stab = 'stable'
    else:
        stab = 'unstable'
    out = {'n': f['n'], 'fit_start': dates[0], 'fit_end': dates[-1], 'beta': f['beta'], 'se': f['se'],
           'ci95': [f['beta'] - 1.96 * f['se'], f['beta'] + 1.96 * f['se']], 't': f['t'], 'corr': f['r'], 'r2': f['r2'],
           'corr_first_half': f1 and f1['r'], 'corr_second_half': f2 and f2['r'], 'halves_same_sign': bool(same_sign),
           'holdout': ho, 'stability': stab, 'x_p5': p5, 'x_p95': p95, 'accounting': acc,
           'counterexample': None if ce is None else {'date': dates[ce], 'x': float(x[ce]), 'y': float(y[ce])}}
    if zz is not None:
        g = ols2(y, x, zz)
        if g:
            out['beta_given_spy'], out['se_given_spy'] = g
    return out


def baskets(px_dir, rows, calendar):
    """Equal-weight sector baskets from member daily returns over the SPY session calendar."""
    by = {}
    for r in rows:
        if r.get('sp500_member') is False or not r.get('sec'):
            continue
        by.setdefault(r['sec'], []).append(r['t'])
    out, issues = {}, []
    for sector, members in sorted(by.items()):
        series = {}
        for t in members:
            c = closes(px_dir / f'{t}.json')
            if c:
                series[t] = c
            else:
                issues.append(f'{sector}: {t} price history missing')
        if len(series) < 3:
            issues.append(f'{sector}: fewer than 3 members with history; basket withheld')
            continue
        level, pts, excluded, skipped, nmin = 100.0, [], 0, 0, None
        last = None
        for d in calendar:
            if last is None:
                if sum(1 for c in series.values() if d in c) >= MIN_BASKET_COVER * len(series):
                    last = d; pts.append([d, 100.0, sum(1 for c in series.values() if d in c)])
                continue
            rets = []
            for c in series.values():
                if d in c and last in c:
                    r = 100.0 * (c[d] / c[last] - 1.0)
                    if abs(r) > MAX_ABS_RET:
                        excluded += 1
                        continue
                    rets.append(r)
            if len(rets) < MIN_BASKET_COVER * len(series):
                skipped += 1
                continue
            level *= 1 + sum(rets) / len(rets) / 100.0
            pts.append([d, round(level, 4), len(rets)])
            nmin = len(rets) if nmin is None else min(nmin, len(rets))
            last = d
        out[sector] = {'id': 'sec:' + sector, 'label': sector + ' basket (equal weight)', 'kind': 'basket',
                       'members': len(series), 'min_members_per_day': nmin, 'excluded_member_returns': excluded,
                       'skipped_days': skipped, 'h': pts,
                       'note': f'Equal-weight average of {len(series)} S&P 500 member daily returns, rebased to 100. A basket, not an ETF or official index.'}
    return out, issues


def build(data_root: Path, now=None):
    core = load_json(data_root / 'core.json', None)
    if not core or not core.get('rows'):
        raise ValueError('core.json missing or has no rows')
    px_dir = data_root / 'px'
    spy, rsp = closes(px_dir / 'SPY.json'), closes(px_dir / 'RSP.json')
    if len(spy) < MIN_N:
        raise ValueError('SPY history too short for relationships')
    calendar = sorted(spy)
    bk, issues = baskets(px_dir, core['rows'], calendar)
    series = {'eq:SPY': (spy, 'ret', 'SPY (S&P 500 ETF)', '%'), 'eq:RSP': (rsp, 'ret', 'RSP (equal-weight S&P 500 ETF)', '%')}
    for s, b in bk.items():
        series[b['id']] = ({p[0]: p[1] for p in b['h']}, 'ret', b['label'], '%')
    macro_meta, skipped = {}, []
    for mid, (label, unit, kind, cunit, src) in MACRO.items():
        h, x = macro_hist(core, mid)
        if not h:
            skipped.append({'id': 'mac:' + mid, 'reason': 'history not in core.json'})
            continue
        series['mac:' + mid] = (h, kind, label, cunit)
        macro_meta[mid] = {'label': label, 'unit': unit, 'change_unit': cunit, 'source': src,
                           'provider': x.get('provider'), 'url': x.get('url'), 'last': max(h)}
    for group in (core.get('macro') or {}).values():
        for x in group or []:
            if x.get('id') in MACRO or not x.get('h'):
                continue
            skipped.append({'id': 'mac:' + x['id'], 'reason': 'not a daily level series (monthly/weekly or derived change); daily pairing would create pseudo-samples'})
    cands = [(s['id'], 'eq:SPY') for s in bk.values()]
    cands += [(s['id'], 'mac:' + f) for s in bk.values() for f in FACTORS_FOR_SECTORS]
    cands += [('eq:RSP', 'eq:SPY')] + [('eq:SPY', 'mac:' + f) for f in MARKET_FACTORS]
    # Keep representative sector coverage AND market pairs in the finite budget.
    cands = cands[:PAIR_BUDGET - 8] + cands[-8:]
    pairs, missing = [], []
    for y_id, x_id in cands:
        if y_id not in series or x_id not in series:
            missing.append({'y': y_id, 'x': x_id, 'reason': 'series unavailable'})
            continue
        (ya, ka, la, ua), (xb, kb, lb, ub) = series[y_id], series[x_id]
        dates, y, x, acc = changes(ya, xb, ka, kb)
        if len(y) < MIN_N:
            missing.append({'y': y_id, 'x': x_id, 'reason': f'{len(y)} aligned changes < {MIN_N}'})
            continue
        z = None
        if x_id.startswith('mac:') and y_id != 'eq:SPY':
            # SPY change over the SAME interval as each aligned pair (consecutive common dates may skip sessions)
            common = sorted(set(ya) & set(xb))
            span = {d1: d0 for d0, d1 in zip(common, common[1:])}
            zz = [chg(spy[span[d]], spy[d], 'ret') if span[d] in spy and d in spy else None for d in dates]
            z = np.array(zz, float) if all(v is not None for v in zz) else None
        d = describe(y, x, dates, acc, z)
        if not d:
            missing.append({'y': y_id, 'x': x_id, 'reason': 'degenerate (constant) series'})
            continue
        d.update({'id': f'{y_id}|{x_id}', 'y': y_id, 'x': x_id, 'y_label': la, 'x_label': lb,
                  'units': f'{ua} {la.split(" (")[0]} per 1 {ub} {lb.split(" (")[0]}', 'y_unit': ua, 'x_unit': ub})
        pairs.append(d)
    for p in pairs:
        for k, v in list(p.items()):
            if isinstance(v, float):
                p[k] = round(v, 6)
    for t in JOINT_NAMES:
        h = closes(px_dir / f'{t}.json')
        if h:
            series['eq:' + t] = (h, 'ret', t, '%')
    joint = joint_catalog(series)
    obj = {'schema': SCHEMA, 'version': 1, 'generated_at': now or utcnow(), 'joint': joint,
           'asof_session': calendar[-1], 'equity_last': calendar[-1], 'core_asof_session': core.get('asof_session'),
           'macro_last': {k: v['last'] for k, v in macro_meta.items()},
           'method': ('Contemporaneous OLS of aligned daily changes over the last <=252 common observations; '
                      'consecutive common dates only, no forward fill; 70/30 chronological holdout of the same-day fit '
                      'versus a zero-slope baseline measures stability, not prediction. Associations, not causes or forecasts.'),
           'limits': ['Close times differ by source (Treasury curve, Cboe close, Yahoo futures settlements, equity 4 PM close).',
                      'Macro histories are revised series, not point-in-time vintages; no lead/lag claim is made.',
                      'Sector baskets use current members (survivorship) and unadjusted prices; probable splits are excluded and counted.'],
           'candidate_search': {'max': MAX_CANDIDATES, 'fitted': len(pairs), 'joint_candidates': len(joint), 'pair_candidates': len(cands), 'unavailable': missing,
                                'note': 'Fixed candidate list chosen before fitting; nothing is ranked into the catalog by fit quality.'},
           'skipped_series': skipped, 'issues': issues, 'macro': macro_meta,
           'baskets': bk, 'pairs': pairs}
    return obj


def verify(obj):
    """Invariants. Returns (severity, problems)."""
    p = []
    if obj.get('schema') != SCHEMA:
        p.append('schema mismatch')
    pairs = obj.get('pairs') or []
    if not pairs:
        return 'SUSPECT', ['zero relationship pairs']
    if len(pairs) > MAX_CANDIDATES:
        p.append('candidate budget exceeded')
    if obj.get('candidate_search', {}).get('pair_candidates', len(pairs)) + len(obj.get('joint', [])) > MAX_CANDIDATES:
        p.append('combined candidate budget exceeded')
    for model in obj.get('joint', []):
        if model.get('available'):
            if model.get('n', 0) < MIN_N or len(model.get('coefficients', [])) != 3 or model.get('residual_variance', -1) < 0:
                p.append('invalid joint model')
            if model.get('fit_end', '') > obj.get('asof_session', ''):
                p.append('joint model ahead of snapshot')
            try:
                inv = np.asarray(model['inverse_xtx'], float)
                if inv.shape != (3,3) or not np.isfinite(inv).all() or not np.allclose(inv,inv.T) or np.linalg.eigvalsh(inv).min() <= 0:
                    p.append('invalid joint covariance design')
                if model.get('condition', math.inf) > 30 or not math.isfinite(model['residual_variance']) or not all(math.isfinite(v) for v in model['coefficients']):
                    p.append('nonfinite or collinear joint fit')
                if len(model['bounds']) != 2 or any(len(b)!=2 or not all(math.isfinite(v) for v in b) or b[0] >= b[1] for b in model['bounds']):
                    p.append('invalid joint input bounds')
            except (ValueError,KeyError,TypeError,np.linalg.LinAlgError):
                p.append('malformed joint fit')
    for r in pairs:
        if not (r.get('n') or 0) >= MIN_N:
            p.append(f"{r.get('id')}: n below minimum")
        if r.get('corr') is None or not -1.0000001 <= r['corr'] <= 1.0000001:
            p.append(f"{r.get('id')}: correlation outside [-1,1]")
        if r.get('stability') not in ('stable', 'unstable', 'weak'):
            p.append(f"{r.get('id')}: stability label")
        if not r.get('fit_start') or not r.get('fit_end') or r['fit_start'] >= r['fit_end']:
            p.append(f"{r.get('id')}: fit window")
        if r.get('accounting', {}).get('changes', 0) < r.get('n', 0):
            p.append(f"{r.get('id')}: sample accounting smaller than n")
    text = repr(obj).lower()
    for word in ('predict', 'forecast will', 'will rise', 'will fall', 'leads ', 'causes'):
        if word in text.replace('not prediction', '').replace('not causes or forecasts', ''):
            p.append(f'forbidden language: {word.strip()}')
    for s, b in (obj.get('baskets') or {}).items():
        if not b.get('h') or b['h'][0][1] != 100.0:
            p.append(f'{s}: basket not rebased to 100')
    if p:
        return 'FAIL', p
    if obj.get('candidate_search', {}).get('unavailable') or obj.get('issues'):
        return 'WARN', ['partial coverage: ' + str(len(obj['candidate_search']['unavailable'])) + ' pairs unavailable, '
                        + str(len(obj.get('issues') or [])) + ' basket issues']
    return 'OK', []


def validate(obj, core):
    """Publication gate: invariants plus coherence with the core snapshot it was built from. Raises on any defect."""
    if not isinstance(obj, dict):
        raise ValueError('Relationship catalog is missing or not an object')
    sev, problems = verify(obj)
    if sev not in ('OK', 'WARN'):
        raise ValueError(f'Relationship catalog {sev}: ' + '; '.join(problems[:3]))
    session = (core or {}).get('asof_session')
    if not session or obj.get('core_asof_session') != session or obj.get('asof_session') != session:
        raise ValueError('Relationship catalog and core sessions disagree')
    return sev


def stage(data_root, now=None):
    """Rebuild from final staged histories. Failure aborts promotion; inherited
    staged files are retained for diagnosis and never used as successful output."""
    data_root = Path(data_root)
    target = data_root / 'relationships.json'
    # A failure raises before promotion; never consume the inherited file as a fallback.
    obj = build(data_root, now=now)
    sev = validate(obj, load_json(data_root / 'core.json', required=True))
    write_json(target, obj)
    event('brief.relationships', 'refresh stage', sev, f"pairs={len(obj['pairs'])} baskets={len(obj['baskets'])} session={obj['asof_session']}")
    return dict(status='ok' if sev == 'OK' else 'degraded', pairs=len(obj['pairs']), baskets=len(obj['baskets']), severity=sev)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--data-root', type=Path, default=ROOT / 'app/data')
    ap.add_argument('--receipt', type=Path, default=None)
    a = ap.parse_args(argv)
    target = a.data_root / 'relationships.json'
    receipt = {'target': str(target), 'at': utcnow()}
    try:
        obj = build(a.data_root)
        sev, problems = verify(obj)
        if sev in ('OK', 'WARN'):
            validate(obj, load_json(a.data_root / 'core.json', required=True))
    except Exception as exc:  # fail-safe: previous artifact retained, failure durable
        sev, problems, obj = 'FAIL', [f'{type(exc).__name__}: {exc}'], None
    receipt.update(severity=sev, problems=problems[:20],
                   pairs=len(obj['pairs']) if obj else 0, baskets=len(obj['baskets']) if obj else 0)
    if sev in ('OK', 'WARN'):
        write_json(target, obj)
        receipt['written'] = True
    else:
        receipt['written'] = False
        receipt['note'] = 'previous relationships.json retained' if target.exists() else 'no previous artifact'
    event('brief.relationships', 'catalog', sev, f"pairs={receipt['pairs']} baskets={receipt['baskets']} written={receipt['written']} {'; '.join(problems[:3])}")
    if a.receipt:
        write_json(a.receipt, receipt)
    print(f"Relationships: {sev} pairs={receipt['pairs']} baskets={receipt['baskets']} written={receipt['written']}")
    return 0 if sev in ('OK', 'WARN') else 1


if __name__ == '__main__':
    raise SystemExit(main())
