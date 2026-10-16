"""Read existing macro caches; only event calendars may need public HTTP requests."""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin

import numpy as np
import requests
from lxml import html

from smartoptions.macro import parsers

FACTOR_SPECS = {
    'us10y_bps': ('10-year yield', 'bp', 'us10y_bps_chg', 'curve', 'us10y'),
    'slope_bps': ('2s10s slope', 'bp', None, 'curve', 'spread_10y_2y'),
    'wti': ('WTI oil', '%', 'wti_ret', 'cross_asset', 'wti'),
    'dxy': ('US dollar', '%', 'dxy_ret', 'cross_asset', 'dxy'),
    'vix': ('VIX', 'points', 'vix_chg', 'volatility', 'vix'),
    'hy_oas_bps': ('High-yield spread', 'bp', 'hy_oas_bps_chg', 'credit_funding', 'hy_oas'),
}
CALENDARS = {
    'cpi': 'https://www.bls.gov/bls/news-release/cpi.htm',
    'payrolls': 'https://www.bls.gov/bls/news-release/empsit.htm',
    'fomc': 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
}


def pairs(values, cutoff):
    return {str(d)[:10]: float(v) for d, v in values if str(d)[:10] <= cutoff and v is not None and np.isfinite(float(v))}


def load_factors(macro, cutoff):
    daily = macro.get('daily_factors', {})
    ten = pairs(daily.get('us10y_bps_chg', []), cutoff)
    two = pairs(daily.get('us2y_bps_chg', []), cutoff)
    series, metadata = {}, []
    for key, (label, unit, field, group, obs_id) in FACTOR_SPECS.items():
        values = {d: ten[d] - two[d] for d in ten.keys() & two.keys()} if key == 'slope_bps' else pairs(daily.get(field, []), cutoff)
        obs = next((o for o in macro.get('groups', {}).get(group, []) if o.get('id') == obs_id), {})
        source = dict(label=obs.get('provider', 'Not available'), url=obs.get('source_url'), series=obs.get('series'),
                      retrieved_at=obs.get('retrieved_at'))
        # Every recent change is dated; a fresh run never relabels a cached observation.
        dates = sorted(values)
        recent = dates[-20:]
        change = float(np.prod([1 + values[d] / 100 for d in recent]) - 1) * 100 if unit == '%' else sum(values[d] for d in recent)
        rolling = []
        for end in range(20, len(dates) + 1):
            window = dates[end-20:end]
            rolling.append(float(np.prod([1 + values[d] / 100 for d in window]) - 1) * 100 if unit == '%' else sum(values[d] for d in window))
        std = float(np.std(list(values.values()), ddof=1)) if len(values) > 1 else None
        z = (change - float(np.mean(rolling))) / float(np.std(rolling, ddof=1)) if len(rolling) > 1 and np.std(rolling, ddof=1) > 0 else None
        level_date = obs.get('date')
        level = obs.get('value') if level_date and level_date <= cutoff else None
        lag = (datetime.fromisoformat(cutoff) - datetime.fromisoformat(dates[-1])).days if dates else None
        series[key] = values
        metadata.append(dict(id=key, label=label, unit=unit, source=source,
                             n=len(dates), window_start=dates[0] if dates else None, window_end=dates[-1] if dates else None,
                             latest=dict(value=level, date=level_date, unit=obs.get('unit'),
                                         reason=None if level is not None else 'Not available: cached level has no valid date'),
                             recent_change=change if len(recent) == 20 else None,
                             recent_change_n=len(recent), recent_change_start=recent[0] if recent else None,
                             recent_change_date=recent[-1] if recent else None, z_score=z, standard_move=std,
                             change_asof=dates[-1] if dates else None,
                             freshness='missing' if not dates else 'stale' if lag > 4 else 'delayed',
                             reason=f'Historical daily factor through {dates[-1]}; not an intraday quote.' if dates else 'Not available: no cached daily observations',
                             z_score_basis='Latest 20-observation change versus overlapping historical 20-observation changes; descriptive, not a p-value'))
    return series, metadata


def parse_event_dates(raw, kind, cutoff):
    """Dates are release/decision dates embedded in official release URLs, not reference months."""
    doc = html.fromstring(raw)
    result = {}
    for a in doc.xpath('//a[@href]'):
        href = a.get('href')
        pattern = r'/pressreleases/monetary(\d{8})a\.htm' if kind == 'fomc' else rf'(?:cpi|empsit)_(\d{{8}})\.htm'
        match = re.search(pattern, href, re.I)
        anchor_text = ' '.join(a.itertext()).strip().lower()
        # Fed decision links are labeled HTML beside a Statement heading. Strategy
        # statements use b.htm; implementation notes use a1.htm; neither is a decision.
        if not match or (kind == 'fomc' and anchor_text not in ('html','statement')):
            continue
        day = datetime.strptime(match[1], '%Y%m%d' if kind == 'fomc' else '%m%d%Y').date().isoformat()
        if day <= cutoff:
            result[day] = dict(date=day, source_url=urljoin(CALENDARS[kind], href), basis='Official release URL date')
    return [result[d] for d in sorted(result)]


def current_release_date(raw, kind, url, cutoff):
    content = ' '.join(html.fromstring(raw).itertext())
    content = re.sub(r'\s+', ' ', content)
    match = re.search(r'(?:embargoed|release)[\s\S]{0,240}?(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(20\d{2})', content, re.I)
    if match:
        day = datetime.strptime(' '.join(match.groups()), '%B %d %Y').date().isoformat()
        if day <= cutoff:
            return dict(date=day, source_url=url, basis='Official current release embargo dateline')
    return None


def load_events(stage, cache_dir, cutoff, offline=False):
    cache_dir = Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    groups, warnings = {}, []
    for kind, url in CALENDARS.items():
        cache = cache_dir / f'{kind}-calendar.html'
        verified_cache = cache_dir / f'{kind}-verified-dates.json'
        network_verified = False
        errors = []
        raw = None
        if not offline:
            try:
                response = requests.get(url, timeout=25, headers={'User-Agent': 'SmartOptionsBrief/1.0 public calendar verification'})
                response.raise_for_status()
                candidate = response.text
                if not parse_event_dates(candidate, kind, cutoff):
                    raise ValueError('SUSPECT: calendar returned no release dates')
                cache.write_text(candidate, encoding='utf-8')
                raw = candidate
                network_verified = True
            except (requests.RequestException, ValueError, OSError) as exc:
                errors.append(f'Calendar fetch failed ({type(exc).__name__}); retained cache if available')
        if raw is None:
            candidates = [cache] + ([Path(stage) / 'raw/fomc.html'] if kind == 'fomc' else [])
            for path in candidates:
                if path.exists():
                    raw = path.read_text(encoding='utf-8'); break
        dates = parse_event_dates(raw, kind, cutoff) if raw else []
        if kind != 'fomc' and not dates and not offline:
            # Release dates, never FRED observation/reference-month dates.
            # The existing runtime credential remains in memory and is never logged.
            from smartoptions.macro.collect import fred_key
            key = fred_key()
            if key:
                try:
                    rid = 10 if kind == 'cpi' else 50
                    response = requests.get('https://api.stlouisfed.org/fred/release/dates', timeout=25,
                                            params=dict(release_id=rid, api_key=key, file_type='json',
                                                        realtime_start='2024-01-01', realtime_end=cutoff,
                                                        limit=1000, include_release_dates_with_no_data='false'))
                    response.raise_for_status()
                    releases = response.json().get('release_dates', [])
                    dates = [dict(date=r['date'], source_url=f'https://fred.stlouisfed.org/release/dates?rid={rid}',
                                  basis='FRED official release calendar; excludes release dates without data')
                             for r in releases if '2024-01-01' <= r['date'] <= cutoff]
                    if not dates:
                        raise ValueError('SUSPECT: empty FRED release calendar')
                    network_verified = True
                    (cache_dir / f'{kind}-fred-release-dates.json').write_text(json.dumps(dates), encoding='utf-8')
                    errors.append('BLS archive unavailable; verified FRED release dates used')
                except (requests.RequestException, ValueError, OSError) as exc:
                    errors.append(f'FRED release calendar unavailable ({type(exc).__name__}); no URL or credential logged')
        if not dates and kind != 'fomc':
            fallback = cache_dir / f'{kind}-fred-release-dates.json'
            if fallback.exists():
                dates = [r for r in json.loads(fallback.read_text(encoding='utf-8')) if r['date'] <= cutoff]
        if not dates and verified_cache.exists():
            saved = json.loads(verified_cache.read_text(encoding='utf-8'))
            dates = [r for r in saved['dates'] if r['date'] <= cutoff]
        if kind != 'fomc' and not offline and not any('FRED official' in d['basis'] for d in dates):
            current_url = f'https://www.bls.gov/news.release/{"cpi" if kind == "cpi" else "empsit"}.nr0.htm'
            try:
                response = requests.get(current_url, timeout=25)
                response.raise_for_status()
                current = current_release_date(response.text, kind, current_url, cutoff)
                if current is None:
                    raise ValueError('SUSPECT: current release has no embargo date')
                network_verified = True
                dates = sorted({d['date']: d for d in dates + [current]}.values(), key=lambda x: x['date'])
                (cache_dir / f'{kind}-current-release.json').write_text(json.dumps(current), encoding='utf-8')
            except (requests.RequestException, ValueError, OSError) as exc:
                errors.append(f'Current release date unavailable ({type(exc).__name__})')
        elif kind != 'fomc':
            current_cache = cache_dir / f'{kind}-current-release.json'
            if current_cache.exists():
                current = json.loads(current_cache.read_text(encoding='utf-8'))
                if current['date'] <= cutoff:
                    dates = sorted({d['date']: d for d in dates + [current]}.values(), key=lambda x: x['date'])
        if not dates:
            errors.append('Not available: no verified event dates; never substitute reference months')
        saved = json.loads(verified_cache.read_text(encoding='utf-8')) if verified_cache.exists() else {}
        verified_at = datetime.now(timezone.utc).isoformat(timespec='seconds') if network_verified else saved.get('verified_at')
        if not verified_at and raw:
            verified_at = datetime.fromtimestamp((cache if cache.exists() else Path(stage)/'raw/fomc.html').stat().st_mtime, timezone.utc).isoformat(timespec='seconds')
        if dates and not offline:
            verified_cache.write_text(json.dumps(dict(verified_at=verified_at,dates=dates),indent=2),encoding='utf-8')
        warnings.extend(f'{kind}: {e}' for e in errors)
        effective_url = dates[0]['source_url'] if dates and 'FRED official' in dates[0]['basis'] else url
        groups[kind] = dict(source_url=effective_url, requested_source_url=url, verified_at=verified_at, dates=dates, status='degraded' if errors else 'ok', reasons=errors,
                            surprise_direction=None, surprise_reason='Not available: no verified free point-in-time consensus proxy; absolute moves only')
    return groups, warnings
