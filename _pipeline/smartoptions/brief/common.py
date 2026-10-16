from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path

from smartoptions.log import event

ROOT = Path(__file__).resolve().parents[2]
CARDS = ('growth', 'profitability', 'cash', 'resilience', 'valuation', 'expectations', 'counter')
STATUSES = {'strong', 'ok', 'weak', 'unavailable'}


def number(value):
    try:
        result = float(value)
        return result if math.isfinite(result) and not isinstance(value, bool) else None
    except (TypeError, ValueError):
        return None


def utcnow():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def parsed(value):
    try:
        result = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return result.replace(tzinfo=timezone.utc) if result.tzinfo is None else result.astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None


def metric(label, value, unit, period, asof, source='Yahoo Finance via yfinance', url='https://finance.yahoo.com/', note=''):
    if isinstance(value, (float, int)):
        value = number(value)
        value = round(value, 4) if value is not None else None
    return dict(label=label, value=value, unit=unit, period=str(period or 'Not available'),
                asof=asof, source=source, source_url=url,
                note=note or ('Provider did not supply this observation' if value is None else ''))


def card(status, line, metrics):
    return dict(status=status, line=line, metrics=metrics)


def unavailable(reason, asof, url='https://finance.yahoo.com/'):
    return card('unavailable', 'Not available: ' + reason,
                [metric('Coverage', None, '', 'Not available', asof, url=url, note=reason)])


def bullet(text, metrics, tone='neutral'):
    return dict(text=text, tone=tone, metrics=metrics)


def load_json(path, default=None, required=False):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except Exception as exc:
        event('brief.read', str(path), 'FAIL' if required else 'WARN', f'{type(exc).__name__}: {exc}')
        if required:
            raise
        return default


def write_json(path, obj):
    path = Path(path)
    payload = json.dumps(obj, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.json.tmp')
    try:
        tmp.write_text(payload, encoding='utf-8')
        tmp.replace(path)
    except Exception as exc:
        event('brief.write', str(path), 'FAIL', f'{type(exc).__name__}: {exc}')
        raise
    return len(payload.encode('utf-8'))


def classify(value, weak, strong, higher=True):
    if number(value) is None:
        return 'unavailable'
    if higher:
        return 'weak' if value < weak else 'strong' if value >= strong else 'ok'
    return 'weak' if value > weak else 'strong' if value <= strong else 'ok'


def worst(statuses):
    available = [s for s in statuses if s != 'unavailable']
    return min(available, key={'weak': 0, 'ok': 1, 'strong': 2}.get) if available else 'unavailable'
