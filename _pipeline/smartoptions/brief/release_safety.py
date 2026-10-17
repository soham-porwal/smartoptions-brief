"""Conservative display guards; original observations remain available for audit."""
from copy import deepcopy

ACTION_URL = 'https://www.corteva.com/uk/news-and-resources/Corteva-Begins-New-Chapter.html'
ACTION_REASON = ('Corteva completed its seed-business spin-off on 2026-10-01. '
                 'Pre-separation prices, earnings, targets and fitted history are not '
                 'confirmed on the same basis. Comparisons are unavailable pending reconciliation; '
                 'the current provider quote is retained.')


def guard_core(core):
    """Idempotent; never infer a corporate-action adjustment from a large move."""
    for row in core.get('rows', []):
        pe, forward = row.get('pe'), row.get('pef')
        if isinstance(pe, (int, float)) and isinstance(forward, (int, float)) and pe > 0 and forward > 0:
            value = round(100 * (pe / forward - 1), 2)
            row['eps_g_imp'] = value
            row['eps_ratio_note'] = ('P/E ratio comparison: 100 × (trailing P/E / forward P/E − 1). '
                'Different earnings periods and estimates; not expected growth or estimate revisions. '
                + ('Extreme ratio; small earnings bases or one-off charges can dominate.' if abs(value) >= 75 else ''))
        else:
            row['eps_g_imp'] = None
            row['eps_ratio_note'] = 'Unavailable: both earnings bases must be positive; no growth inference.'
        drift = (row.get('sam_drift') or {}).get('px_pct')
        if isinstance(drift, (int, float)) and abs(drift) > 60:
            row['comparison_warning'] = 'Large historical price-basis difference; corporate-action reconciliation required.'
        if row.get('t') == 'CTVA':
            row.setdefault('basis_original', deepcopy({k: row.get(k) for k in
                ('sam_drift', 'tgt', 'pe', 'pef', 'eps_g_imp', 'pef_sec_rel', 'mcap', 'lo', 'hi')}))
            row['basis_warning'] = ACTION_REASON
            row['basis_source_url'] = ACTION_URL
            for key in ('sam_drift', 'tgt', 'up', 'pe', 'pef', 'eps_g_imp', 'pef_sec_rel', 'lo', 'hi'):
                row[key] = None
            row['target_reason'] = ACTION_REASON
            row['eps_ratio_note'] = ACTION_REASON
    return core


def guard_company(obj, row):
    if not row.get('basis_warning'):
        return obj
    original = deepcopy({'cards': obj.get('cards'), 'technical': obj.get('technical')})
    # Preserve all observations, while factoring repeated provider metadata out of the
    # audit copy. The normal guarded cards still obey the 12 KB delivery contract.
    shared = {key: [] for key in ('source', 'source_url', 'note', 'period', 'asof', 'unit')}
    for assessment in [*(original.get('cards') or {}).values(), original.get('technical')]:
        for metric in (assessment or {}).get('metrics', []):
            for key, values in shared.items():
                if key in metric:
                    value = metric.pop(key)
                    if value not in values:
                        values.append(value)
                    metric[key + '_ref'] = values.index(value)
    original['provenance'] = shared
    obj.setdefault('basis_original', original)
    missing = dict(label='Corporate-action basis', value=None, unit='', period='Spin-off 2026-10-01', asof='2026-10-01', source='Corteva corporate release', source_url=ACTION_URL, note='Basis unverified after spin-off.')
    for card in obj.get('cards', {}).values():
        card.update(status='unavailable', line='Unavailable: post-spin-off basis unreconciled; pre-separation financials and targets require review.', metrics=[deepcopy(missing)])
    obj['summary'] = row['basis_warning']
    if isinstance(obj.get('technical'), dict):
        obj['technical'].update(status='unavailable', line='Unavailable: pre-separation technical history needs corporate-action reconciliation.', metrics=[deepcopy(missing)])
    obj['basis_warning'] = row['basis_warning']
    obj['basis_source_url'] = row['basis_source_url']
    return obj
