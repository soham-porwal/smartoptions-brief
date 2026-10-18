"""Coordinated Brief refresh with validation before an atomic dataset promotion.

Run from either the development repository or the static Pages checkout.
Credentials remain environment variables. No quote provider is called here.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import yaml
import requests

from smartoptions.brief.common import ROOT, load_json, write_json
from smartoptions.brief.intelligence import build as intelligence_build, validate as validate_intelligence
from smartoptions.shocks import build as shocks_build, validate as validate_shocks
from smartoptions.brief.relationships import stage as relationships_stage, validate as validate_relationships
from smartoptions.log import event

MAX_BUNDLE_BYTES = 64 * 1024 * 1024
REQUIRED_SNAPSHOT_FILES = {'core.json', 'brief.json', 'intelligence.json', 'shocks.json', 'money-flow.json', 'refresh-status.json', 'relationships.json'}
SESSION_FILES = ('core.json', 'brief.json', 'shocks.json', 'relationships.json')


def bundle_path_allowed(name):
    path = Path(name)
    if path.is_absolute() or '..' in path.parts or '\\' in name:
        return False
    return name in {'core.json', 'brief.json', 'intelligence.json', 'shocks.json', 'refresh-status.json', 'money-flow.json', 'relationships.json', 'news-refresh-status.json'} or (
        path.suffix == '.json' and (len(path.parts) == 2 and path.parts[0] == 'px' or
                                  len(path.parts) == 3 and path.parts[:2] == ('brief', 'company')))


def write_bundle(data_root):
    data_root = Path(data_root)
    files = {p.relative_to(data_root).as_posix(): p.read_bytes() for p in data_root.rglob('*.json')
             if bundle_path_allowed(p.relative_to(data_root).as_posix())}
    if not REQUIRED_SNAPSHOT_FILES <= files.keys():
        raise ValueError('Snapshot bundle is missing a coordinated dataset')
    intelligence = json.loads(files['intelligence.json'])
    if any(json.loads(files[name]).get('asof_session') != intelligence['asof_session'] for name in SESSION_FILES):
        raise ValueError('Snapshot bundle sessions disagree')
    manifest = dict(schema='smartoptions.snapshot-bundle.v1', asof_session=intelligence['asof_session'],
                    generated_at=intelligence['generated_at'],
                    files={name: hashlib.sha256(raw).hexdigest() for name, raw in files.items()},
                    note='Quotes excluded; each quote retains its own independent source timestamp.')
    target = data_root / 'snapshot.zip'; temporary = target.with_suffix('.zip.tmp')
    with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        archive.writestr('manifest.json', json.dumps(manifest, separators=(',', ':')))
        for name, raw in files.items():
            archive.writestr(name, raw)
    os.replace(temporary, target)
    return manifest


def read_bundle(raw, candidate):
    if len(raw) > MAX_BUNDLE_BYTES:
        raise ValueError('Snapshot bundle is oversized')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        infos = archive.infolist()
        names = [i.filename for i in infos]
        if len(names) != len(set(names)) or len(names) > 1600 or sum(i.file_size for i in infos) > MAX_BUNDLE_BYTES:
            raise ValueError('Snapshot bundle duplicate paths, too many files or expansion limit')
        manifest = json.loads(archive.read('manifest.json'))
        if manifest.get('schema') != 'smartoptions.snapshot-bundle.v1':
            raise ValueError('Unknown snapshot bundle schema')
        files = manifest.get('files') or {}
        if not REQUIRED_SNAPSHOT_FILES <= set(files) or set(names) != set(files) | {'manifest.json'}:
            raise ValueError('Snapshot bundle manifest coverage mismatch')
        contents = {}
        for name, digest in files.items():
            if not bundle_path_allowed(name):
                raise ValueError('Snapshot bundle path is not allowlisted JSON')
            body = archive.read(name)
            if hashlib.sha256(body).hexdigest() != digest:
                raise ValueError('Snapshot bundle checksum mismatch')
            json.loads(body)
            contents[name] = body
        if any(json.loads(contents[name]).get('asof_session') != manifest.get('asof_session')
               for name in SESSION_FILES + ('intelligence.json',)):
            raise ValueError('Snapshot bundle sessions disagree')
        for name, body in contents.items():
            path = candidate / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
        return manifest


def fetch_bundle(url):
    if url != 'https://soham-porwal.github.io/smartoptions-brief/data/snapshot.zip':
        raise ValueError('Mirror source must be the canonical public Brief snapshot')
    with requests.get(url, timeout=(8, 60), stream=True) as response:
        response.raise_for_status()
        chunks, total = [], 0
        for chunk in response.iter_content(65536):
            total += len(chunk)
            if total > MAX_BUNDLE_BYTES:
                raise ValueError('Snapshot download exceeded size limit')
            chunks.append(chunk)
        return b''.join(chunks)


def confined(path, workspace):
    path, workspace = Path(path).resolve(), Path(workspace).resolve()
    if not path.is_relative_to(workspace) or path == workspace:
        raise ValueError('Refresh write path must stay inside the selected workspace')
    if path.is_symlink():
        raise ValueError('Refresh refuses symlink write paths')
    return path


def run_stage(module, arguments, receipt, timeout, log_root):
    started = datetime.now(timezone.utc).isoformat(timespec='seconds')
    # Stage output can contain provider error detail. Keep it in a private CI
    # artifact, never in publication data or the public status receipt.
    log_path = log_root / (module.replace('.', '-') + '.txt')
    record = dict(status='running', started_at=started)
    receipt['stages'][module] = record
    try:
        with log_path.open('w', encoding='utf-8') as stream:
            result = subprocess.run([sys.executable, '-m', module, *map(str, arguments)],
                                    stdout=stream, stderr=subprocess.STDOUT, timeout=timeout, check=False)
        if result.returncode:
            raise RuntimeError('Stage returned nonzero')
        record['status'] = 'ok'
        event('refresh.stage', module, 'OK', 'Completed; details in private stage log')
    except Exception as exc:
        record.update(status='failed', error_type=type(exc).__name__)
        event('refresh.stage', module, 'FAIL', f'{type(exc).__name__}; last good publication retained')
        raise
    finally:
        record['finished_at'] = datetime.now(timezone.utc).isoformat(timespec='seconds')


def retain_macro_observations(stage_root, old_core):
    """Carry valid prior observations on an optional source outage, never the attempt date.
    The compact publication is the portable retention source (also present on CI).
    """
    path = stage_root / 'macro.json'
    macro = load_json(path, required=True)
    old = {o['id']: o for group in (old_core.get('macro') or {}).values() for o in group}
    retained = []
    for group in macro.get('groups', {}).values():
        for i, current in enumerate(group):
            previous = old.get(current.get('id'), {})
            if current.get('value') is not None or previous.get('v') is None or not previous.get('date') or not previous.get('retrieved_at'):
                continue
            restored = dict(previous, value=previous['v'], history=previous.get('h') or [],
                            source_url=previous.get('url'), status='stale',
                            note='Provider unavailable in this attempt; retained prior observation and retrieval dates')
            restored.pop('v', None); restored.pop('h', None); restored.pop('url', None)
            group[i] = restored
            retained.append(current['id'])
    # Required historical factor inputs can likewise retain actual changes derived
    # from their dated source levels; no forward fill or synthetic final bar.
    from smartoptions.shocks_sources import FACTOR_SPECS
    for _, (_, unit, field, _, obs_id) in FACTOR_SPECS.items():
        if not field or macro.get('daily_factors', {}).get(field):
            continue
        h = old.get(obs_id, {}).get('h') or []
        changes = []
        for (d0, v0), (d1, v1) in zip(h, h[1:]):
            if isinstance(v0, (int,float)) and isinstance(v1, (int,float)) and (unit != '%' or v0 > 0):
                changes.append([d1, 100*(v1/v0-1) if unit == '%' else (v1-v0)*(100 if obs_id in ('us10y','us2y') else 1)])
        macro.setdefault('daily_factors', {})[field] = changes
    write_json(path, macro)
    if retained:
        event('refresh.retention', 'macro', 'WARN', 'Retained dated observations: ' + ','.join(retained), len(retained))
    return dict(status='degraded' if retained else 'ok', retained=retained, observation_dates_preserved=True)


class CoverageValidationError(ValueError):
    """Only allowlisted validation categories reach the public refresh receipt."""

    def __init__(self, message, code='COVERAGE_VALIDATION_FAILED', context=None):
        super().__init__(message)
        self.code = code
        self.context = context or {}


def coverage_guard(old_data, new_data):
    try:
        return _coverage_guard(old_data, new_data)
    except ValueError as exc:
        # Do not publish arbitrary loader/provider exception strings. Known
        # invariants get safe stable identifiers; the financial guard stays intact.
        known = {
            'SUSPECT: zero company rows': 'COVERAGE_ZERO_COMPANIES',
            'Refresh lost retained research names': 'COVERAGE_RESEARCH_NAMES_LOST',
            'Refresh session moved backward': 'COVERAGE_SESSION_REGRESSION',
            'Refresh lost previously available prices': 'COVERAGE_PRICE_LOSS',
            'S&P membership fetch is missing or incomplete': 'COVERAGE_MEMBERSHIP_INCOMPLETE',
            'Refresh lost a previously available macro observation': 'COVERAGE_MACRO_LOSS',
            'SUSPECT: zero macro observations': 'COVERAGE_ZERO_MACRO',
            'Refresh price history round-trip is incomplete': 'COVERAGE_PRICE_HISTORY_MISSING',
            'Refresh shock and core sessions disagree': 'COVERAGE_SHOCK_SESSION_MISMATCH',
            'Refresh shock constituent round-trip is incomplete': 'COVERAGE_SHOCK_MEMBERS_MISMATCH',
            'Refresh intelligence does not contain the validated shock build': 'COVERAGE_SHOCK_OVERLAY_MISMATCH',
            'Refresh capital provenance is missing or invalid': 'COVERAGE_CAPITAL_INVALID',
            'Refresh relationship catalog is missing': 'COVERAGE_RELATIONSHIPS_MISSING',
            'Refresh relationship catalog session moved backward': 'COVERAGE_RELATIONSHIPS_REGRESSION',
        }
        text = str(exc)
        code = known.get(text, 'COVERAGE_VALIDATION_FAILED')
        context = {}
        prefix, suffix = 'Refresh lost ', ' previously available fundamental assessments'
        if text.startswith(prefix) and text.endswith(suffix):
            number = text[len(prefix):-len(suffix)]
            if number.isascii() and number.isdigit() and len(number) < 8:
                code = 'COVERAGE_FUNDAMENTAL_LOSS'
                context = {'assessment_count': int(number)}
        raise CoverageValidationError(text, code, context) from exc


def _coverage_guard(old_data, new_data):
    old_core = load_json(old_data / 'core.json', {})
    core = load_json(new_data / 'core.json', required=True)
    old_rows = {r['t']: r for r in old_core.get('rows') or []}
    rows = {r['t']: r for r in core.get('rows') or []}
    if not rows:
        raise ValueError('SUSPECT: zero company rows')
    if set(old_rows) - set(rows):
        raise ValueError('Refresh lost retained research names')
    if old_core.get('asof_session') and core.get('asof_session', '') < old_core['asof_session']:
        raise ValueError('Refresh session moved backward')
    if any(r.get('px') is not None and rows[t].get('px') is None for t, r in old_rows.items()):
        raise ValueError('Refresh lost previously available prices')
    if old_rows:
        previous_members = {t for t, r in old_rows.items() if r.get('sp500_member')}
        members = {t for t, r in rows.items() if r.get('sp500_member')}
        if previous_members and len(members) < 495:
            raise ValueError('S&P membership fetch is missing or incomplete')
    core_macro = [o for group in (core.get('macro') or {}).values() for o in group]
    old_macro = {o['id']: o for group in (old_core.get('macro') or {}).values() for o in group}
    if any(old_macro.get(o['id'], {}).get('v') is not None and o.get('v') is None for o in core_macro):
        raise ValueError('Refresh lost a previously available macro observation')
    if not core_macro:
        raise ValueError('SUSPECT: zero macro observations')
    losses = []
    for ticker in rows:
        if not (new_data / 'px' / f'{ticker}.json').is_file():
            raise ValueError('Refresh price history round-trip is incomplete')
        new = load_json(new_data / 'brief/company' / f'{ticker}.json', required=True)
        previous_path = old_data / 'brief/company' / f'{ticker}.json'
        previous = load_json(previous_path, {}) if previous_path.exists() else {}
        for key, card in (previous.get('cards') or {}).items():
            # Counterargument is a derived selection, not an independent data
            # feed. A previously weak dimension may improve without data loss;
            # all underlying fundamental dimensions remain guarded below.
            if key == 'counter':
                continue
            if card.get('status') != 'unavailable' and (new.get('cards', {}).get(key) or {}).get('status') == 'unavailable':
                if not (rows[ticker].get('basis_warning') and new.get('basis_original') and new.get('basis_source_url') == rows[ticker].get('basis_source_url')):
                    losses.append(f'{ticker}:{key}')
    if losses:
        raise ValueError(f'Refresh lost {len(losses)} previously available fundamental assessments')
    intelligence = load_json(new_data / 'intelligence.json', required=True)
    validate_intelligence(intelligence, list(rows))
    shocks = load_json(new_data / 'shocks.json', required=True)
    validate_shocks(shocks)
    if shocks.get('asof_session') != core.get('asof_session'):
        raise ValueError('Refresh shock and core sessions disagree')
    members = {t for t, row in rows.items() if row.get('sp500_member') is True}
    if set(shocks['companies']) != members:
        raise ValueError('Refresh shock constituent round-trip is incomplete')
    overlay = intelligence.get('shocks') or {}
    if (overlay.get('schema') != shocks['schema'] or overlay.get('generated_at') != shocks['generated_at']
            or overlay.get('model_asof') != shocks['windows']['factor_common_end']):
        raise ValueError('Refresh intelligence does not contain the validated shock build')
    capital = load_json(new_data / 'money-flow.json', required=True)
    if capital.get('schema') != 'smartoptions.capital.v1' or capital.get('status') not in ('ok', 'degraded'):
        raise ValueError('Refresh capital provenance is missing or invalid')
    # Explore relationship catalog: present, internally valid and built from this exact core session.
    if not (new_data / 'relationships.json').is_file():
        raise ValueError('Refresh relationship catalog is missing')
    relationships = load_json(new_data / 'relationships.json', required=True)
    validate_relationships(relationships, core)
    old_path = old_data / 'relationships.json'
    old_relationships = load_json(old_path, {}) if old_path.is_file() else {}
    if old_relationships.get('asof_session') and relationships['asof_session'] < old_relationships['asof_session']:
        raise ValueError('Refresh relationship catalog session moved backward')
    return dict(companies=len(rows), retained_previous=len(old_rows), macro_observations=len(core_macro),
                intelligence_companies=len(intelligence['companies']), shock_companies=len(shocks['companies']),
                relationship_pairs=len(relationships['pairs']), relationship_baskets=len(relationships['baskets']))


def source_dates(data_root):
    """Public receipt carries original source periods, separate from build time."""
    try:
        core = load_json(Path(data_root) / 'core.json', required=True)
    except (OSError, ValueError, TypeError):
        event('refresh.receipt', 'source dates', 'WARN', 'Source-date metadata unavailable; failure receipt retained')
        return dict(status='unavailable', reason='Source-date metadata could not be read')
    if not isinstance(core, dict):
        return dict(status='unavailable', reason='Source-date metadata is not an object')
    dates = [r['pxd'] for r in core.get('rows') or [] if isinstance(r, dict) and isinstance(r.get('pxd'), str)]
    groups = core.get('macro') or {}
    groups = groups if isinstance(groups, dict) else {}
    macro = {row['id']: dict(observation_date=row.get('date'), period=row.get('period'),
                            retrieved_at=row.get('retrieved_at'), status=row.get('status'),
                            source_url=row.get('url'))
             for group in groups.values() if isinstance(group, list) for row in group
             if isinstance(row, dict) and isinstance(row.get('id'), str)}
    return dict(snapshot_session=core.get('asof_session'),
                company_price_oldest=min(dates) if dates else None,
                company_price_latest=max(dates) if dates else None, macro=macro)


def promote(staged_data, data_root, backup, workspace):
    staged_data = confined(staged_data, workspace)
    data_root = confined(data_root, workspace)
    backup = confined(backup, workspace)
    if not staged_data.is_dir() or backup.exists():
        raise ValueError('Invalid staged dataset or existing backup destination')
    backup.parent.mkdir(parents=True, exist_ok=True)
    had_previous = data_root.exists()
    if had_previous:
        os.replace(data_root, backup)
    try:
        os.replace(staged_data, data_root)
    except Exception:
        if had_previous:
            os.replace(backup, data_root)
        raise
    # Keep the previous directory in the private work root. No user data deletion.


def refresh(data_root, work_root, cache_root, *, source_snapshot=None, offline=False,
            workspace=None, now=None, config_path=None):
    now = now or datetime.now(timezone.utc)
    workspace = Path(workspace or Path.cwd()).resolve()
    data_root = confined(data_root, workspace)
    work_root = confined(work_root, workspace)
    if work_root.is_relative_to(data_root) or data_root.is_relative_to(work_root):
        raise ValueError('Publication and private work directories must be separate')
    # The explicit offline source cache may be read-only outside this checkout.
    # Live cache writes must be workspace confined.
    cache_root = Path(cache_root).resolve()
    if not offline:
        cache_root = confined(cache_root, workspace)
    token = now.strftime('%Y%m%dT%H%M%S%fZ')
    run_root = work_root / token
    log_root = run_root / 'logs'; log_root.mkdir(parents=True, exist_ok=False)
    stage_root = run_root / now.date().isoformat(); stage_root.mkdir()
    candidate = run_root / 'data'
    receipt = dict(schema='smartoptions.refresh.v1', attempted_at=now.isoformat(timespec='seconds'),
                   status='running', mode='offline_snapshot' if offline else 'live', stages={},
                   previous_snapshot_preserved=True, publication_changed=False)
    status_path = data_root / 'refresh-status.json'
    receipt_path = work_root / 'refresh-status.json'
    try:
        if not data_root.is_dir():
            raise ValueError('Existing publication data directory is required')
        shutil.copytree(data_root, candidate, ignore=shutil.ignore_patterns('snapshot.zip'))
        old_core = load_json(data_root / 'core.json', required=True)
        if source_snapshot is not None:
            if not offline:
                raise ValueError('Source snapshot requires --offline; avoids relabeling old observations live')
            source_snapshot = Path(source_snapshot)
            for name in ('macro.json', 'calendar.json', 'equities.json'):
                source = source_snapshot / name
                load_json(source, required=True)
                shutil.copy2(source, stage_root / name)
            (stage_root / 'raw').mkdir()
            for name in ('prices.csv.gz', 'prices-provenance.json', 'fomc.html'):
                source = source_snapshot / 'raw' / name
                if source.exists():
                    shutil.copy2(source, stage_root / 'raw' / name)
            receipt['stages']['sources'] = dict(status='reused', source_dates_retained=True)
        elif offline:
            raise ValueError('--offline requires --source-snapshot')
        else:
            run_stage('smartoptions.macro', ['--out', stage_root], receipt, 900, log_root)
            # Explicit refresh fetches current prices/fundamentals rather than
            # stamping a prior daily cache with a new build date.
            run_stage('smartoptions.equities', ['--out', stage_root, '--refresh', '--extra',
                       *[r['t'] for r in old_core.get('rows') or []]], receipt, 1800, log_root)
        from smartoptions.relate import build as relate_build
        from smartoptions.export import build as export_build
        from smartoptions.brief.__main__ import build as brief_build
        def capital_stage():
            if importlib.util.find_spec('smartoptions.moneyflow') is None:
                event('refresh.capital', 'optional collector', 'WARN', 'Collector not installed; retained existing capital data if present')
                return dict(status='skipped', reason='Optional collector is not installed; retained prior capital document if present')
            args = ['--out', candidate, '--cache', cache_root.parent / 'capital']
            if offline:
                args.append('--offline')
            try:
                run_stage('smartoptions.moneyflow', args, receipt, 300, log_root)
                result = load_json(candidate / 'money-flow.json', required=True)
                return dict(status='ok' if result.get('status') == 'ok' else 'degraded')
            except Exception as exc:
                event('refresh.capital', 'optional collector', 'WARN', f'{type(exc).__name__}; retained copied prior capital data')
                return dict(status='degraded', reason='Optional capital collector failed; prior document retained if present')
        for name, action in (
            ('macro_retention', lambda: retain_macro_observations(stage_root, old_core)),
            ('relations', lambda: write_json(stage_root / 'relations.json', relate_build(stage_root))),
            ('export', lambda: export_build(stage_root.name, candidate, input_dir=stage_root)),
            ('brief', lambda: brief_build(candidate, cache_root,
                 yaml.safe_load(Path(config_path or ROOT / 'config/brief.yaml').read_text(encoding='utf-8')), offline=offline)),
            ('capital', capital_stage),
            ('shocks', lambda: write_json(candidate / 'shocks.json',
                 shocks_build(candidate, stage_root, now=now, offline=offline, log_dir=log_root / 'shocks',
                              previous_events=load_json(data_root / 'shocks.json', {}).get('event_study', {})))),
            ('intelligence', lambda: write_json(candidate / 'intelligence.json', intelligence_build(candidate, stage_root, now))),
            # Built from the same final candidate histories (core + px) that will be published.
            ('relationships', lambda: relationships_stage(candidate, now=now.isoformat(timespec='seconds'))),
            ('verify', lambda: coverage_guard(data_root, candidate)),
        ):
            receipt['stages'][name] = dict(status='running')
            try:
                result = action()
                receipt['stages'][name] = result if name in ('capital', 'relationships', 'macro_retention') else dict(status='ok')
                if name == 'verify':
                    receipt['coverage'] = result
                event('refresh.stage', name, 'WARN' if receipt['stages'][name]['status'] != 'ok' else 'OK', 'Completed staged snapshot')
            except Exception as exc:
                diagnostic = dict(stage=name, code=getattr(exc, 'code', 'STAGE_EXCEPTION'),
                                  error_type=type(exc).__name__, context=getattr(exc, 'context', {}))
                receipt['stages'][name].update(status='failed', diagnostic=diagnostic, error_type=type(exc).__name__)
                event('refresh.validation', name, 'FAIL', json.dumps(diagnostic, sort_keys=True))
                raise
        intelligence = load_json(candidate / 'intelligence.json', required=True)
        shocks = load_json(candidate / 'shocks.json', required=True)
        capital_degraded = receipt['stages']['capital']['status'] != 'ok'
        retained_macro = receipt['stages']['macro_retention']['retained']
        relations_degraded = receipt['stages']['relationships']['status'] != 'ok'
        receipt.update(status='degraded' if intelligence['status']['state'] == 'degraded' or shocks['status']['state'] == 'degraded' or offline or capital_degraded or retained_macro or relations_degraded else 'ok',
                       reasons=intelligence['status']['reasons'] + shocks['status']['reasons'] + (['Offline source observations reused; this is a pipeline validation, not a live refresh'] if offline else []) +
                               (['Capital & news collection is degraded or unavailable; inspect its separate provenance.'] if capital_degraded else []) +
                               ([f'{len(retained_macro)} macro observations retained with original dates after provider unavailability.'] if retained_macro else []) +
                               (['Relationship catalog has partial coverage; inspect candidate and basket accounting.'] if relations_degraded else []),
                       asof_session=intelligence['asof_session'], model_asof=intelligence['basis']['model_asof'],
                       shock_model_asof=shocks['windows']['factor_common_end'],
                       source_dates=source_dates(candidate),
                       publication_changed=True, finished_at=datetime.now(timezone.utc).isoformat(timespec='seconds'),
                       intelligence_sha256=hashlib.sha256((candidate / 'intelligence.json').read_bytes()).hexdigest(),
                       shocks_sha256=hashlib.sha256((candidate / 'shocks.json').read_bytes()).hexdigest(),
                       relationships_sha256=hashlib.sha256((candidate / 'relationships.json').read_bytes()).hexdigest())
        write_json(candidate / 'refresh-status.json', receipt)
        write_bundle(candidate)
        promote(candidate, data_root, run_root / 'previous-data', workspace)
        write_json(receipt_path, receipt)
        event('refresh.publish', 'dataset', 'WARN' if receipt['status'] == 'degraded' else 'OK',
              f'Validated {receipt["coverage"]["companies"]} companies; atomic promotion completed')
        return receipt
    except Exception as exc:
        # No provider exception string enters public status (may contain keys).
        receipt.update(status='failed', error_type=type(exc).__name__, diagnostic=next((v.get('diagnostic') for v in receipt['stages'].values() if v.get('diagnostic')), None),
                       reasons=['Refresh failed validation or collection; the previous data snapshot remains available. Inspect the private workflow logs.'],
                       publication_changed=False, finished_at=datetime.now(timezone.utc).isoformat(timespec='seconds'))
        receipt['source_dates'] = source_dates(data_root)
        receipt['source_dates_basis'] = 'Last good published snapshot; failed candidate was not promoted'
        event('refresh.publish', 'dataset', 'FAIL', f'{type(exc).__name__}; last good snapshot preserved')
        try:
            write_json(receipt_path, receipt)
            if data_root.is_dir():
                write_json(status_path, receipt)
        except Exception as logging_exc:
            print(f'Refresh receipt write failed: {type(logging_exc).__name__}', file=sys.stderr)
        raise


def mirror(data_root, work_root, url, workspace=None):
    """Client editions mirror the canonical snapshot without provider requests."""
    workspace = Path(workspace or Path.cwd()).resolve()
    data_root, work_root = confined(data_root, workspace), confined(work_root, workspace)
    if work_root.is_relative_to(data_root) or data_root.is_relative_to(work_root):
        raise ValueError('Publication and private work directories must be separate')
    now = datetime.now(timezone.utc)
    run_root = work_root / now.strftime('%Y%m%dT%H%M%S%fZ')
    run_root.mkdir(parents=True, exist_ok=False)
    candidate = run_root / 'data'
    receipt = dict(schema='smartoptions.refresh.v1', attempted_at=now.isoformat(timespec='seconds'),
                   mode='canonical_mirror', status='running', previous_snapshot_preserved=True, publication_changed=False,
                   stages={})
    try:
        shutil.copytree(data_root, candidate, ignore=shutil.ignore_patterns('snapshot.zip'))
        manifest = read_bundle(fetch_bundle(url), candidate)
        canonical = load_json(candidate / 'refresh-status.json', required=True)
        if canonical.get('status') not in ('ok', 'degraded'):
            raise ValueError('Canonical snapshot receipt does not indicate a successful build')
        # A delayed/CDN-cached daily bundle must not undo a newer news-only
        # collection already mirrored by this client. Manager data still comes
        # from the coordinated incoming daily snapshot.
        from smartoptions.news_refresh import NEWS_FIELDS, stamp
        incoming_capital = load_json(candidate / 'money-flow.json', required=True)
        previous_capital = load_json(data_root / 'money-flow.json', {})
        incoming_date = incoming_capital.get('news_status', {}).get('retrieved_at')
        previous_date = previous_capital.get('news_status', {}).get('retrieved_at')
        retained_news = bool(previous_date and (not incoming_date or stamp(incoming_date) < stamp(previous_date)))
        if retained_news:
            incoming_capital.update({k: previous_capital[k] for k in NEWS_FIELDS if k in previous_capital})
            write_json(candidate / 'money-flow.json', incoming_capital)
            news_receipt = load_json(data_root / 'news-refresh-status.json', {})
            if news_receipt.get('source_collection_at') != previous_date:
                news_receipt = dict(schema='smartoptions.news-refresh.v1', status='degraded',
                                    mode='daily_mirror_retained_news', provider_calls=0,
                                    source_collection_at=previous_date, sources=incoming_capital['news_status']['sources'])
            news_receipt['money_flow_sha256'] = hashlib.sha256((candidate / 'money-flow.json').read_bytes()).hexdigest()
            write_json(candidate / 'news-refresh-status.json', news_receipt)
        receipt.update(status=canonical['status'], reasons=canonical.get('reasons') or [],
                       asof_session=manifest['asof_session'], canonical_generated_at=manifest['generated_at'],
                       model_asof=canonical.get('model_asof'), source_url=url,
                       shock_model_asof=canonical.get('shock_model_asof'),
                       shocks_sha256=manifest['files']['shocks.json'],
                       intelligence_sha256=manifest['files']['intelligence.json'],
                       relationships_sha256=manifest['files']['relationships.json'],
                       source_dates=canonical.get('source_dates', source_dates(candidate)),
                       coverage=coverage_guard(data_root, candidate), publication_changed=True,
                       retained_newer_local_news=retained_news,
                       stages=dict(download=dict(status='ok'), manifest=dict(status='ok'), verify=dict(status='ok')))
        receipt['finished_at'] = datetime.now(timezone.utc).isoformat(timespec='seconds')
        write_json(candidate / 'refresh-status.json', receipt)
        # refresh-status itself changed to the mirror receipt (and news may have
        # been retained). Rehash those exact members rather than keep a stale or
        # absent bundle after the full daily mirror.
        write_bundle(candidate)
        promote(candidate, data_root, run_root / 'previous-data', workspace)
        write_json(work_root / 'refresh-status.json', receipt)
        event('refresh.mirror', 'canonical', 'OK', 'Verified hashes and coverage; no provider requests')
        return receipt
    except Exception as exc:
        receipt.update(status='failed', error_type=type(exc).__name__, publication_changed=False,
                       reasons=['Canonical mirror failed; previous dataset retained. Inspect workflow logs.'])
        event('refresh.mirror', 'canonical', 'FAIL', f'{type(exc).__name__}; previous dataset retained')
        try:
            write_json(work_root / 'refresh-status.json', receipt)
            if data_root.is_dir():
                write_json(data_root / 'refresh-status.json', receipt)
        except Exception as logging_exc:
            print(f'Mirror receipt failed: {type(logging_exc).__name__}', file=sys.stderr)
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-root', type=Path, default=ROOT / 'app/data')
    parser.add_argument('--work-root', type=Path, default=ROOT / 'out/refresh')
    parser.add_argument('--cache-root', type=Path, default=ROOT / 'data/cache/brief')
    parser.add_argument('--source-snapshot', type=Path)
    parser.add_argument('--offline', action='store_true')
    parser.add_argument('--mirror-url', help='Client editions download the canonical hashed bundle without provider calls')
    parser.add_argument('--workspace', type=Path, default=Path.cwd())
    args = parser.parse_args(argv)
    try:
        if args.mirror_url:
            result = mirror(args.data_root, args.work_root, args.mirror_url, args.workspace)
        else:
            result = refresh(args.data_root, args.work_root, args.cache_root, source_snapshot=args.source_snapshot,
                             offline=args.offline, workspace=args.workspace)
        print(json.dumps({k: result[k] for k in ('status', 'asof_session', 'model_asof', 'coverage')}))
        return 0
    except Exception as exc:
        event('refresh.main', 'publication', 'FAIL', f'{type(exc).__name__}; inspect private refresh logs')
        print(f'Refresh failed: {type(exc).__name__}; previous snapshot retained', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
