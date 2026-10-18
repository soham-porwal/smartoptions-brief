"""24-hour per-symbol/per-statement cache; empty results are explicit failures."""
from __future__ import annotations

import threading
import time
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from smartoptions.log import event
from .common import load_json, number, parsed, utcnow, write_json

STATEMENTS = ('income_stmt', 'quarterly_income_stmt', 'cashflow', 'quarterly_cashflow',
              'balance_sheet', 'quarterly_balance_sheet', 'eps_revisions', 'earnings_estimate')
_lock = threading.Lock()
_next_request = 0.0


def recover_statement_observations(cache_dir, seed_path):
    """Restore missing CI cache entries from dated, already accepted observations.

    Existing observed values are never replaced. This is a last-good input recovery,
    not a new acquisition: source periods and retrieval clocks stay unchanged.
    """
    seed_path = Path(seed_path)
    if not seed_path.exists():
        return dict(status='not_present', restored=0)
    if seed_path.stat().st_size > 2 * 1024 * 1024:
        raise ValueError('Statement recovery input exceeds its bounded size')
    seed = load_json(seed_path, required=True)
    records = seed.get('records')
    if seed.get('schema') != 'smartoptions.statement-recovery.v1' or not isinstance(records, dict) or len(records) > 1200:
        raise ValueError('Invalid statement recovery input')
    # Validate every path and record before any write. Never accept arbitrary cache files.
    for name, rec in records.items():
        allowed = '|'.join(STATEMENTS)
        if (not re.fullmatch(r'[A-Z0-9.\^-]{1,16}\.(' + allowed + r')\.json', name)
                or not isinstance(rec, dict) or not isinstance(rec.get('data'), dict)
                or not rec['data'] or not all(isinstance(fields, dict) for fields in rec['data'].values())
                or not parsed(rec.get('retrieved_at'))):
            raise ValueError('Invalid dated statement recovery record')
    restored = 0
    for name, rec in records.items():
        path = Path(cache_dir) / name
        current = load_json(path, {}) if path.exists() else {}
        merged = {period: dict(fields) for period, fields in (current.get('data') or {}).items()}
        added = 0
        for period, fields in rec['data'].items():
            for field, value in fields.items():
                if value is not None and merged.setdefault(period, {}).get(field) is None:
                    merged[period][field] = value
                    added += 1
        if not added:
            continue
        dates = [x for x in [current.get('retrieved_at'), rec['retrieved_at']] if parsed(x)]
        original = min(dates, key=parsed)
        write_json(path, dict(current, data=merged, retrieved_at=original, status='retained',
                             retention_reason='Restored missing prior accepted statement fields; original periods and oldest acquisition date retained'))
        restored += 1
    event('brief.statements.recovery', 'dated analyst inputs', 'WARN' if restored else 'OK',
          'Original acquisition dates preserved; healthy cache not replaced', restored)
    return dict(status='retained' if restored else 'ok', restored=restored, original_dates_preserved=True)


def throttle(spacing):
    global _next_request
    with _lock:
        delay = max(0, _next_request - time.monotonic())
        if delay:
            time.sleep(delay)
        _next_request = time.monotonic() + spacing


def frame_record(frame):
    if frame is None or frame.empty:
        raise ValueError('Yahoo returned an empty statement')
    # Dated statements and analyst-period tables share this compact representation.
    return {str(col)[:10] if hasattr(col, 'date') else str(col):
            {str(idx): number(value) if number(value) is not None else
             (str(value) if isinstance(value, str) else None)
             for idx, value in frame[col].items()}
            for col in frame.columns}


def fetch_statement(ticker, name, cache_dir, config, provider, now=None, offline=False):
    now = now or datetime.now(timezone.utc)
    path = Path(cache_dir) / f'{ticker}.{name}.json'
    cached = load_json(path) if path.exists() else None
    stamp = parsed((cached or {}).get('checked_at') or (cached or {}).get('retrieved_at'))
    if stamp and 0 <= (now - stamp).total_seconds() < config['cache_ttl_hours'] * 3600:
        return cached
    if offline:
        reason = 'Cached statement expired' if cached else 'No cached statement; offline build'
        event('brief.statements', ticker + ':' + name, 'WARN', reason)
        if cached and cached.get('data') and parsed(cached.get('retrieved_at')):
            return dict(cached, status='retained', retention_reason=reason + '; original observation date retained')
        return dict(data={}, retrieved_at=None, error=reason, status='missing')
    error = None
    for attempt in range(2):
        try:
            throttle(config['request_spacing_seconds'])
            data = frame_record(getattr(provider, name))
            rec = dict(data=data, retrieved_at=utcnow(), error=None, status='ok')
            # A partial provider table must not erase valid previous fields. Use the
            # oldest actual retrieval stamp for a merged table; new attempt time is separate.
            if cached and cached.get('data') and parsed(cached.get('retrieved_at')):
                retained = 0
                for period, fields in cached['data'].items():
                    for field, value in fields.items():
                        if value is not None and data.setdefault(period, {}).get(field) is None:
                            data[period][field] = value
                            retained += 1
                if retained:
                    rec.update(retrieved_at=cached['retrieved_at'], checked_at=utcnow(), status='retained',
                               retained_fields=retained, retention_reason='Partial provider table; prior fields kept with original observation date')
            write_json(path, rec)
            return rec
        except Exception as exc:
            error = type(exc).__name__  # provider strings can contain credential-bearing URLs
            event('brief.statements', ticker + ':' + name, 'WARN', f'attempt {attempt + 1}: {error}')
            if attempt == 0:
                time.sleep(config['retry_backoff_seconds'])
                # yfinance may memoize an empty response; retry with a fresh ticker.
                try:
                    import yfinance as yf
                    provider = yf.Ticker(ticker.replace('.', '-'))
                except Exception as retry_exc:
                    event('brief.statements', ticker, 'WARN', f'retry init: {type(retry_exc).__name__}')
    rec = dict(data={}, retrieved_at=utcnow(), error=error, status='missing')
    if cached and cached.get('data') and parsed(cached.get('retrieved_at')):
        rec = dict(cached, checked_at=utcnow(), error=error, status='retained',
                   retention_reason='Provider unavailable after retry; original observations retained')
    write_json(path, rec)  # Negative cache also prevents hammering unsupported statements.
    event('brief.statements', ticker + ':' + name, 'WARN', 'unavailable after retry: ' + str(error))
    return rec


def fetch_all(tickers, cache_dir, config, offline=False):
    import yfinance as yf

    def one(ticker):
        provider = yf.Ticker(ticker.replace('.', '-'))
        records = {name: fetch_statement(ticker, name, cache_dir, config, provider, offline=offline)
                   for name in STATEMENTS}
        event('brief.statements', ticker, 'OK' if all(r['data'] for r in records.values()) else 'WARN',
              f"{sum(bool(r['data']) for r in records.values())}/{len(STATEMENTS)} tables available")
        return ticker, records

    result = {}
    with ThreadPoolExecutor(max_workers=config['workers']) as pool:
        futures = {t: pool.submit(one, t) for t in tickers}
        for ticker, future in futures.items():
            try:
                key, records = future.result()
                result[key] = records
            except Exception as exc:
                event('brief.statements', ticker, 'FAIL', f'{type(exc).__name__}: {exc}')
                result[ticker] = {name: dict(data={}, error='Statement fetch failed', retrieved_at=None)
                                  for name in STATEMENTS}
    return result
