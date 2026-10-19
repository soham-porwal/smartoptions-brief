"""Automatic developing-situation artifact (situation.v1) for the existing scheduled news job.

One bounded cross-asset read (Yahoo spark batch, chart fallback; at most six upstream reads including retries,
90-second total deadline) plus open-topic selection from the news collection the job already made.
Observation clocks are the provider's own. Comparison bases are the last completed provider daily bar, never
chartPreviousClose and never an assumed official settlement. Nothing here predicts direction or assigns cause.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

SCHEMA = 'situation.v1'
RULES_VERSION = 'situation-producer-1'
ET = ZoneInfo('America/New_York')
REFERENCES = (
    ('ES=F', 'S&P 500 E-mini futures', 'index_future', 'index points', ('FUTURE',)),
    ('NQ=F', 'Nasdaq-100 E-mini futures', 'index_future', 'index points', ('FUTURE',)),
    ('CL=F', 'WTI crude oil futures', 'commodity_future', 'USD/bbl', ('FUTURE',)),
    ('GC=F', 'Gold futures', 'commodity_future', 'USD/oz', ('FUTURE',)),
    ('DX-Y.NYB', 'US dollar index', 'currency_index', 'index points', ('INDEX', 'CURRENCY')),
    ('^VIX', 'VIX', 'volatility_index', 'index points', ('INDEX',)),
)
LIMITS = dict(max_reads=6, deadline_s=90, timeout_s=12, history=48, max_reports=8, unclassified_slots=2,
              fresh_report_h=36, material_report_h=24, max_bytes=1_500_000)
SPARK = 'https://query1.finance.yahoo.com/v7/finance/spark?symbols={symbols}&range=5d&interval=1d'
CHART = 'https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=5d&interval=1d'
ORIGINAL = {'reuters', 'ap', 'associated press', 'bloomberg', 'federal reserve', 'bls', 'bea', 'u.s. treasury', 'treasury',
            'eia', 'cnbc', 'wall street journal', 'wsj', 'financial times', 'sec', 'census bureau'}
OPINION_SOURCES = {'motley fool', '24/7 wall st.', 'investorplace', 'zacks', 'seeking alpha', 'gobankingrates'}
EVERGREEN = re.compile(r"\?\s*$|\bshould you\b|\bbest\b.{0,30}\b(stocks?|etfs?|funds?)\b|\bmillion(aire)?\b|\bretire|\bforget\b|"
                       r"\bmissed out\b|\bdon'?t miss\b|\bis it time\b|\bhow (to|these)\b|\btop \d+\b|\bwhat we want to see\b|"
                       r"\bfacts to know\b|\btrending stock\b|\bcomparing\b|\bindustry comparison\b|\bset to retire\b|\bwhy i\b|\bwe'?re watching\b", re.I)
OPINION_URL = re.compile(r'investingclub|/opinion/|/commentary/|/personal-finance/', re.I)
STOP = {'The', 'A', 'An', 'In', 'On', 'At', 'For', 'To', 'Of', 'And', 'As', 'After', 'Before', 'Why', 'How', 'What', 'New', 'More',
        'Says', 'Its', 'With', 'From', 'By', 'Over', 'Amid', 'Into', 'Than', 'This', 'That', 'Is', 'Are', 'Be', 'Will', 'Could', 'May',
        'First', 'Since', 'Reuters', 'January', 'February', 'March', 'April', 'June', 'July', 'August', 'September', 'October', 'November',
        'December', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'Minutes', 'Here', 'Bloomberg', 'Exclusive', 'EXCLUSIVE', 'Update', 'Board', 'Member', 'Analysts', 'Stock', 'Stocks'}
GENERIC_ENTITIES = {'US', 'U.S.', 'United States', 'Wall Street', 'Markets', 'Market'}
OPPOSED = ((r'\breopen|\bopen(s|ed|ing)?\b|\blift|\bease|\bdeal\b|\bceasefire|\btruce', r'\bclos(e|ed|es|ure|ing)|\bshut|\bblock|\bsanction|\battack|\bstrike'),
           (r'\brise|\brises|\bgain|\bjump|\bsurge|\bhigher', r'\bfall|\bfalls|\bdrop|\bslump|\bplunge|\blower'),
           (r'\bapprove|\bpass(es|ed)?\b|\bagree', r'\breject|\bblock|\bveto|\bfail'))


def iso(dt):
    return dt.astimezone(timezone.utc).isoformat()


def stamp(v):
    d = datetime.fromisoformat(str(v).replace('Z', '+00:00'))
    if d.tzinfo is None:
        raise ValueError('timestamp lacks timezone')
    return d


def et_date(ts):
    return datetime.fromtimestamp(ts, timezone.utc).astimezone(ET).date().isoformat()


def _finite(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and v not in (float('inf'), float('-inf'))


def decode_reference(block, ref, retrieved_at, now, source_url):
    """block: Yahoo spark/chart result {meta, timestamp, indicators}. Returns (observation|None, reason|None)."""
    symbol, label, kind, unit, types = ref
    meta = (block or {}).get('meta') or {}
    if meta.get('symbol') != symbol:
        return None, 'symbol mismatch'
    itype = str(meta.get('instrumentType') or '').upper()
    if itype not in types:
        return None, f'unexpected instrument type {itype or "missing"}'
    if meta.get('currency') not in (None, 'USD'):
        return None, 'non-USD reference'
    price, at = meta.get('regularMarketPrice'), meta.get('regularMarketTime')
    if not (_finite(price) and price > 0 and _finite(at) and at > 0):
        return None, 'no usable observation'
    if at > now.timestamp() + 600:
        return None, 'observation time in the future'
    ts = block.get('timestamp') or []
    closes = (((block.get('indicators') or {}).get('quote') or [{}])[0] or {}).get('close') or []
    obs_date, obs_hour = et_date(at), datetime.fromtimestamp(at, timezone.utc).astimezone(ET).hour
    bars = []
    for t, c in zip(ts, closes):
        if not (_finite(t) and _finite(c) and c > 0) or t == at or t > now.timestamp():
            continue
        d = et_date(t)
        # A bar dated the observation's own day is still forming unless the futures day already rolled (after 18:00 ET).
        if d > obs_date or (d == obs_date and not (kind != 'volatility_index' and kind != 'currency_index' and obs_hour >= 18)):
            continue
        bars.append((d, float(c)))
    bars = sorted(dict(bars).items())
    if not bars:
        return None, 'no completed daily bar for comparison'
    cdate, cval = bars[-1]
    return {'symbol': symbol, 'label': label, 'kind': kind, 'unit': unit, 'value': float(price),
            'observed_at': iso(datetime.fromtimestamp(at, timezone.utc)), 'retrieved_at': retrieved_at,
            'comparison': {'value': cval, 'date': cdate, 'basis': 'provider_last_completed_daily_bar',
                           'note': 'Last completed provider daily bar close; not an official settlement or chartPreviousClose.'},
            'session': {'exchange': meta.get('exchangeName'), 'timezone': meta.get('exchangeTimezoneName'),
                        'note': 'Venue/session not inferred from the timestamp.'},
            'source_url': source_url}, None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Redirects are refused: each counted read is exactly one request to the configured host."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, f'redirect refused ({code})', headers, fp)


_OPENER = urllib.request.build_opener(_NoRedirect)


def _get(url, timeout, opener=None, deadline_at=None, clock=time.monotonic):
    """One bounded read. timeout is the remaining total budget; the body is read in chunks and abandoned at the
    deadline, so a slow-drip response cannot exceed the acquisition wall clock."""
    if timeout <= 0:
        raise TimeoutError('acquisition deadline reached before request')
    req = urllib.request.Request(url, headers={'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; smartoptions-brief situation)'})
    deadline_at = deadline_at if deadline_at is not None else clock() + timeout
    with (opener or _OPENER).open(req, timeout=timeout) if hasattr(opener or _OPENER, 'open') else opener(req, timeout=timeout) as r:
        if r.status != 200:
            raise RuntimeError(f'HTTP {r.status}')
        chunks, n = [], 0
        while True:
            remaining = deadline_at - clock()
            if remaining <= 0:
                raise TimeoutError('acquisition deadline reached during body read')
            # HTTPResponse.read(n) may wait for n bytes while a peer drips indefinitely. read1 returns after one
            # underlying read, letting the total deadline be checked; the socket timeout shrinks with that budget.
            sock = getattr(getattr(getattr(r, 'fp', None), 'raw', None), '_sock', None)
            if sock is not None:
                sock.settimeout(min(timeout, remaining))
            c = (getattr(r, 'read1', None) or r.read)(65536)
            if not c:
                break
            n += len(c)
            if n > LIMITS['max_bytes']:
                raise RuntimeError('response too large')
            chunks.append(c)
        return json.loads(b''.join(chunks))


def collect_market(now=None, fetch=None, clock=time.monotonic):
    """Bounded acquisition. fetch(url)->json is injectable for tests. Returns (observations, receipt)."""
    now = now or datetime.now(timezone.utc)
    start, reads, got, errors = clock(), 0, {}, {}
    deadline_at = start + LIMITS['deadline_s']
    fetch = fetch or (lambda u: _get(u, min(LIMITS['timeout_s'], deadline_at - clock()), None, deadline_at, clock))
    symbols = [r[0] for r in REFERENCES]
    batch_url = SPARK.format(symbols=','.join(urllib.parse.quote(s, safe='') for s in symbols))
    try:
        reads += 1
        data = fetch(batch_url)
        retrieved = iso(datetime.now(timezone.utc))
        for res in ((data or {}).get('spark') or {}).get('result') or []:
            sym, resp = res.get('symbol'), (res.get('response') or [None])[0]
            ref = next((r for r in REFERENCES if r[0] == sym), None)
            if ref and resp:
                obs, why = decode_reference(resp, ref, retrieved, now, batch_url)
                if obs:
                    got[sym] = obs
                else:
                    errors[sym] = why
    except Exception as exc:  # noqa: BLE001 - recorded per source, never silent
        errors['batch'] = f'{type(exc).__name__}: {str(exc)[:120]}'
    for ref in REFERENCES:
        if ref[0] in got or reads >= LIMITS['max_reads'] or clock() >= deadline_at:
            continue
        url = CHART.format(symbol=urllib.parse.quote(ref[0], safe=''))
        try:
            reads += 1
            data = fetch(url)
            block = (((data or {}).get('chart') or {}).get('result') or [None])[0]
            obs, why = decode_reference(block, ref, iso(datetime.now(timezone.utc)), now, url)
            if obs:
                got[ref[0]] = obs
                errors.pop(ref[0], None)
            else:
                errors[ref[0]] = why
        except Exception as exc:  # noqa: BLE001
            errors[ref[0]] = f'{type(exc).__name__}: {str(exc)[:120]}'
    missing = [r[0] for r in REFERENCES if r[0] not in got]
    for s in missing:
        errors.setdefault(s, 'not attempted: read budget or deadline reached')
    status = 'ok' if not missing else 'partial' if got else 'failed'
    return [got[r[0]] for r in REFERENCES if r[0] in got], {'status': status, 'calls': reads, 'at': iso(now),
                                                            'elapsed_s': round(clock() - start, 3), 'errors': errors}


def merge_last_good(fresh, previous):
    """Keep the last good observation per reference when this run failed it; never advance its dates."""
    have = {o['symbol'] for o in fresh}
    carried = [{**o, 'carried': True} for o in (previous or {}).get('observations') or []
               if o.get('symbol') not in have and o.get('symbol') in {r[0] for r in REFERENCES}]
    order = {r[0]: i for i, r in enumerate(REFERENCES)}
    return sorted(fresh + carried, key=lambda o: order.get(o['symbol'], 99))


def entities(headline):
    h = re.sub(r'\s+-\s+[A-Z][\w .&]+$', '', str(headline or ''))
    found, cur = [], []
    for w in re.findall(r"[A-Za-z][\w.&'’-]*", h):
        if (w[0].isupper() and w not in STOP) or (cur and w in ('of', 'the', 'de')):
            cur.append(w)
        else:
            if cur:
                found.append(re.sub(r'(\s+(of|the|de))+$', '', ' '.join(cur)))
            cur = []
    if cur:
        found.append(' '.join(cur))
    out = []
    for e in found:
        e = re.sub(r"(’s|'s)$", '', e).strip()
        if e and e not in GENERIC_ENTITIES and len(e) > 1 and e not in out:
            out.append(e)
    return out[:5]


def _norm(h):
    return set(re.sub(r'[^a-z0-9 ]', ' ', re.sub(r'\s+-\s+[A-Z][\w .&]+$', '', h).lower()).split()) - {'the', 'a', 'to', 'of', 'in', 'on', 'and', 'for'}


def select_reports(news, now, previous=None):
    """Open-topic selection: fresh, non-evergreen, deduplicated originals; bounded share of unclassified items."""
    seen_ids = {r.get('id') for r in (previous or {}).get('reports') or []}
    pool, rejected = [], {'stale': 0, 'evergreen_or_opinion': 0, 'duplicate': 0, 'invalid': 0}
    for n in news or []:
        try:
            pub = stamp(n.get('published_at'))
        except Exception:  # noqa: BLE001
            rejected['invalid'] += 1
            continue
        url, head, src = str(n.get('url', '')), str(n.get('headline', '')).strip(), str(n.get('source', '')).strip()
        if not url.startswith('https://') or not head or pub > now + timedelta(minutes=10):
            rejected['invalid'] += 1
            continue
        age = (now - pub).total_seconds() / 3600
        if age > LIMITS['fresh_report_h'] and n.get('scope') != 'official':
            rejected['stale'] += 1
            continue
        if src.lower() in OPINION_SOURCES or EVERGREEN.search(head) or OPINION_URL.search(url):
            rejected['evergreen_or_opinion'] += 1
            continue
        toks = _norm(head)
        if any(len(toks & p['_t']) / max(1, len(toks | p['_t'])) >= 0.6 for p in pool):
            rejected['duplicate'] += 1
            continue
        tier = 'original' if src.lower() in ORIGINAL or n.get('scope') == 'official' else 'secondary'
        pool.append({'id': str(n.get('id') or hashlib.sha1((head + url).encode()).hexdigest()[:12]), 'headline': head, 'url': url,
                     'source': src or 'unknown', 'published_at': iso(pub), 'retrieved_at': n.get('retrieved_at'), 'scope': n.get('scope'),
                     'tickers': list(n.get('tickers') or [])[:6], 'tier': tier, 'headline_only': not n.get('summary'),
                     'excerpt': (str(n.get('summary'))[:400] if n.get('summary') else None), 'entities': entities(head),
                     'material': tier == 'original' and age <= LIMITS['material_report_h'], 'new': n.get('id') not in seen_ids,
                     'category_hint': n.get('category'), '_t': toks, '_age': age})
    # Group by shared named entities (open vocabulary). Label = most frequent entities in the group.
    parent = list(range(len(pool)))
    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for i, a in enumerate(pool):
        for j in range(i):
            if set(a['entities']) & set(pool[j]['entities']):
                parent[find(i)] = find(j)
    groups = {}
    for i, r in enumerate(pool):
        groups.setdefault(find(i), []).append(r)
    for rs in groups.values():
        counts = {}
        for r in rs:
            for e in r['entities']:
                counts[e] = counts.get(e, 0) + 1
        top = sorted(counts, key=lambda e: (-counts[e], len(e)))[:2]
        label = ' · '.join(top) if top else 'Unclassified: ' + ' '.join(rs[0]['headline'].split()[:6])
        for r in rs:
            r['topic'], r['classified'] = label, bool(top)
            r['match_reason'] = ('issuer ' + ','.join(r['tickers']) if r['tickers'] else 'shared named entity ' + label if top else 'fresh report with no matched entity (kept as unclassified)')
            r['conflicts'] = []
        for pos, neg in OPPOSED:
            ps = [r for r in rs if re.search(pos, r['headline'], re.I)]
            ns = [r for r in rs if re.search(neg, r['headline'], re.I) and r not in ps]
            if ps and ns:
                for a in ps:
                    a['conflicts'] += [b['id'] for b in ns]
                for b in ns:
                    b['conflicts'] += [a['id'] for a in ps]
    rank = lambda r: ((r['tier'] == 'original') * 2 + r['material'] + r['new'] * 0.5 - r['_age'] / 24)
    classified = sorted([r for r in pool if r['classified']], key=rank, reverse=True)
    unclassified = sorted([r for r in pool if not r['classified']], key=rank, reverse=True)
    keep_u = unclassified[:LIMITS['unclassified_slots']]
    chosen = (classified[:LIMITS['max_reports'] - len(keep_u)] + keep_u)
    chosen += [r for r in classified + unclassified if r not in chosen][:LIMITS['max_reports'] - len(chosen)]
    chosen.sort(key=lambda r: r['published_at'], reverse=True)
    for r in pool:
        r.pop('_t', None); r.pop('_age', None)
    return chosen, {'candidates': len(news or []), 'kept': len(chosen), 'rejected': rejected,
                    'note': 'Selection uses the existing collection only; retrieval success is not research completeness.'}


SYN_FIELDS = {'topics'}
TOPIC_FIELDS = {'topic', 'source_ids', 'excerpts', 'entities', 'relevance', 'claim_type', 'contradictions', 'next_check', 'interpretation'}
FORBIDDEN = re.compile(r'<|>|https?://|\bselect\b.+\bfrom\b|\bprobab|\b\d{1,3}\s?%\s?(chance|likely)|\b(buy|sell|short|go long)\b(?! side)', re.I)


SYNTH_URL = 'https://smartoptions-brief-chat.smartoptions-brief.workers.dev/situation/synthesize'
UP = re.compile(r'\b(rose|rise|rises|rising|up|higher|gain(ed|s)?|jump(ed|s)?|surge(d|s)?|rall(y|ied))\b', re.I)
DOWN = re.compile(r'\b(fell|fall|falls|falling|down|lower|drop(ped|s)?|slump(ed|s)?|plunge(d|s)?|declin(e|ed|es))\b', re.I)
OBS_WORDS = {'ES=F': r's&p|e-mini|es=f', 'NQ=F': r'nasdaq|nq=f', 'CL=F': r'\boil\b|crude|wti|cl=f', 'GC=F': r'\bgold\b|gc=f', 'DX-Y.NYB': r'dollar|dxy', '^VIX': r'\bvix\b|volatility'}


def numeric_problems(text, src_text, observations):
    """Numbers must be consistent with typed observations (value, unit and direction) when the sentence names an
    observed instrument; otherwise they must appear with the same unit in a cited source. Digits elsewhere do not count."""
    probs = []
    for sent in re.split(r'(?<=[.;!?])\s+', text):
        named = [o for o in observations if re.search(OBS_WORDS.get(o['symbol'], r'$^'), sent, re.I)]
        for m in re.finditer(r'([+\-\u2212]?\d+(?:\.\d+)?)\s?(%|percent|bp|basis points|points)?', sent):
            num, unit = m.group(1).replace('\u2212', '-'), (m.group(2) or '').lower()
            v = float(num)
            md = re.search(r'\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*$', sent[:m.start()])
            if md and not unit and re.fullmatch(r'\d{1,2}', num):
                mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].index(md.group(1)) + 1
                dates = [o['comparison']['date'] for o in observations] + [o['observed_at'][:10] for o in observations]
                if not any(d[5:7] == f'{mon:02d}' and int(d[8:10]) == int(num) for d in dates) and (md.group(1) + ' ' + num) not in src_text: probs.append('date ' + md.group(0).strip() + ' ' + num)
                continue
            if re.fullmatch(r'(19|20)\d\d', num) and not unit:
                if num not in src_text and not any(num in o['observed_at'] or num in o['comparison']['date'] for o in observations): probs.append('date ' + num)
                continue
            if named and unit in ('%', 'percent'):
                ok = False
                for o in named:
                    chg = 100 * (o['value'] / o['comparison']['value'] - 1)
                    sign_ok = not ((UP.search(sent) and chg < 0) or (DOWN.search(sent) and chg > 0) or (v < 0 < chg) or (chg < 0 < v and num.startswith('+')))
                    if abs(abs(v) - abs(chg)) <= 0.1 and sign_ok: ok = True
                if not ok: probs.append(f'{num}{unit} inconsistent with observed {named[0]["symbol"]}')
                continue
            if named and not unit and any(abs(v - x) < 1e-6 for o in named for x in (o['value'], o['comparison']['value'])):
                continue
            # Source-only numbers must appear as the same whole number with the same unit (1 does not match 120).
            unit_re = {'%': r'\s?(%|percent)', 'percent': r'\s?(%|percent)', 'bp': r'\s?(bp|basis points)', 'basis points': r'\s?(bp|basis points)', 'points': r'\s?points'}.get(unit, r'(?!\s?(%|percent|bp|basis points))')
            if not re.search(r'(?<![\d.+\-\u2212])' + re.escape(num) + r'(?![\d]|\.\d)' + unit_re, src_text.replace('\u2212', '-'), re.I):
                probs.append(f'{num}{unit} not in cited sources')
    return probs


def worker_call(payload, url=None, opener=None, timeout=25):
    """POST the bounded public request to the existing Worker's producer route. No Origin header is sent (the route
    refuses browser origins); the Worker applies its existing IP/global/daily reservation and provider chain."""
    body = json.dumps(payload).encode()
    req = urllib.request.Request(url or SYNTH_URL, data=body, method='POST', headers={'Content-Type': 'application/json', 'User-Agent': 'smartoptions-brief situation producer'})
    try:
        with (opener(req, timeout=timeout) if opener else _OPENER.open(req, timeout=timeout)) as r:
            data = json.loads(r.read(200_000))
    except urllib.error.HTTPError as exc:
        try:
            data = json.loads(exc.read(20_000))
        except Exception:  # noqa: BLE001
            data = {}
        if exc.code == 429 or data.get('status') == 'budget_rejected':
            return {'status': 'budget_rejected', 'reason': str(data.get('reason') or 'allowance reached')[:160]}
        raise RuntimeError(f'HTTP {exc.code}: {str(data.get("reason") or "")[:80]}')
    if data.get('status') == 'ok':
        return data['output']
    if data.get('status') == 'budget_rejected':
        return data
    raise RuntimeError(f'route status {data.get("status")}: {str(data.get("reason") or "")[:80]}')


STR_MAX = {'topic': 80, 'relevance': 240, 'next_check': 200, 'interpretation': 240}
CONDITIONAL = re.compile(r'^(If|Watch|Check|Conditional)\b')
# Completed-event, negation and certainty phrasing a model may not introduce beyond what the cited source says.
ASSERTIVE = re.compile(r"\b(?:has|have|had|was|were|is|are)\s+(?:now\s+|been\s+|officially\s+)*(?:re)?(?:opened|closed|confirmed|agreed|ended|resolved|collapsed|signed|approved|rejected|lifted|imposed|reopened|blocked|halted)\b"
                       r"|\b(?:no longer|not|never|denied|denies|will|certain(?:ly)?|definitely|guarantee[sd]?)\b", re.I)


def _strlist(v, max_items, max_len):
    return isinstance(v, list) and len(v) <= max_items and all(isinstance(x, str) and 0 < len(x) <= max_len for x in v)


def _validate_topic(t, ids, observations):
    if not isinstance(t, dict) or set(t) - TOPIC_FIELDS:
        return 'unknown fields'
    for k in ('topic', 'source_ids', 'excerpts', 'claim_type', 'interpretation', 'next_check'):
        if k not in t:
            return 'missing ' + k
    for k, m in STR_MAX.items():
        if k in t and not (isinstance(t[k], str) and len(t[k]) <= m):
            return 'bad type/length: ' + k
    if not _strlist(t['source_ids'], 8, 40) or not t['source_ids'] or any(x not in ids for x in t['source_ids']):
        return 'unknown or malformed source id'
    if 'contradictions' in t and (not _strlist(t['contradictions'], 8, 40) or any(x not in ids for x in t['contradictions'])):
        return 'unknown or malformed contradiction id'
    if not _strlist(t['excerpts'], 4, 300) or not t['excerpts']:
        return 'missing or malformed excerpts'
    if 'entities' in t and not _strlist(t['entities'], 6, 80):
        return 'malformed entities'
    if t['claim_type'] not in ('reported_fact', 'interpretation', 'conditional_watch'):
        return 'claim_type'
    src_text = ' '.join(ids[s]['headline'] + ' ' + (ids[s].get('excerpt') or '') for s in t['source_ids'])
    gen = {k: t.get(k) or '' for k in ('relevance', 'next_check', 'interpretation')}
    text = ' '.join([t['topic']] + list(gen.values()))
    if FORBIDDEN.search(text):
        return 'forbidden content (markup, URL, SQL, probability or action command)'
    if any(x not in src_text for x in t['excerpts']):
        return 'excerpt not found verbatim in cited sources'
    if any(e not in src_text for e in t.get('entities') or []):
        return 'entity not supported by cited sources'
    # Generated language is never fact copy: a reported_fact may only restate a verbatim excerpt; everything else is conditional.
    if t['claim_type'] == 'reported_fact' and t['interpretation'] not in t['excerpts']:
        return 'reported_fact interpretation is not a verbatim excerpt'
    if t['claim_type'] != 'reported_fact' and not CONDITIONAL.match(t['interpretation'].strip()):
        return 'interpretation is not conditional (If/Watch/Check)'
    for k, v in gen.items():
        for m in ASSERTIVE.finditer(v):
            if m.group(0).lower() not in src_text.lower():
                return f'{k} changes modality/negation/certainty vs source ("{m.group(0)}")'
    probs = numeric_problems(text, src_text, observations)
    if probs:
        return 'numeric mismatch: ' + '; '.join(probs)[:120]
    return None


def validate_synthesis(out, reports, observations):
    """Strict structured output check. Returns (valid_topics, rejections). Malformed output is rejected, never raised."""
    try:
        ids = {r['id']: r for r in reports}
        if not isinstance(out, dict) or set(out) - SYN_FIELDS or not isinstance(out.get('topics'), list):
            return [], ['schema: top-level object must contain only topics[]']
        valid, rej = [], []
        for t in out['topics'][:6]:
            why = _validate_topic(t, ids, observations)
            if why:
                rej.append(f"{str(t.get('topic', '?'))[:40] if isinstance(t, dict) else '?'}: {why}")
            else:
                valid.append(dict(t))
        return valid, rej
    except Exception as exc:  # noqa: BLE001 - malformed model output must not discard deterministic acquisition
        return [], [f'malformed model output rejected ({type(exc).__name__})']


def synthesis_fingerprint(material, observations):
    """Bound to every evidence input the model may cite: source text and dates plus typed values and clocks."""
    obs = [[o['symbol'], o.get('kind'), o.get('unit'), o['value'], o['observed_at'], o['comparison']['value'], o['comparison']['date'], o['comparison'].get('basis')] for o in observations if not o.get('carried')]
    src = [[r['id'], r['headline'], r.get('excerpt'), r['published_at']] for r in material]
    return hashlib.sha256(json.dumps([src, obs, RULES_VERSION], sort_keys=True).encode()).hexdigest()[:20]


def synthesize(reports, observations, call=None, cache=None):
    """Optional source-bound synthesis, one call per evidence fingerprint. call(payload)->dict uses the existing Worker
    reservation. Only a valid result is reused, and reused topics are re-validated against current evidence."""
    material = [r for r in reports if r['material']][:LIMITS['max_reports']]
    fp = synthesis_fingerprint(material, observations)
    if not material:
        return {'status': 'skipped', 'reason': 'no material reports', 'fingerprint': fp}
    if cache and cache.get('fingerprint') == fp and cache.get('status') == 'valid':
        topics, rej = validate_synthesis({'topics': cache.get('topics')}, material, observations)
        if topics:
            return {**cache, 'topics': topics, 'cached': True}
    if call is None:
        return {'status': 'unavailable', 'fingerprint': fp, 'reason': 'Synthesis disabled for this run (no producer route configured).'}
    payload = {'schema': 'situation.synthesis-request.v1', 'fingerprint': fp,
               'sources': [{'id': r['id'][:40], 'headline': r['headline'][:300], 'excerpt': (r.get('excerpt') or None) and r['excerpt'][:600], 'published_at': r['published_at'], 'source': r['source'][:60]} for r in material],
               'observations': [{k: o[k] for k in ('symbol', 'label', 'value', 'observed_at')} | {'comparison': {k: o['comparison'][k] for k in ('value', 'date', 'basis')}} for o in observations if not o.get('carried')]}
    try:
        out = call(payload)
        if isinstance(out, dict) and out.get('status') == 'budget_rejected':
            return {'status': 'budget_rejected', 'fingerprint': fp, 'reason': str(out.get('reason', 'reservation refused'))[:160]}
        topics, rej = validate_synthesis(out, material, observations)
    except Exception as exc:  # noqa: BLE001
        return {'status': 'failed', 'fingerprint': fp, 'reason': f'{type(exc).__name__}: {str(exc)[:120]}'}
    return {'status': 'valid' if topics else 'invalid', 'fingerprint': fp, 'topics': topics, 'rejected': rej[:12],
            'note': 'Model output validated against cited sources and typed observations; generated language is conditional only.'}


def build_situation(*, now, baseline_session, news, previous=None, market=None, market_fetch=None, synth_call=None):
    previous = previous or {}
    if market is None:
        fresh, mreceipt = collect_market(now, market_fetch)
    else:
        fresh, mreceipt = market
    observations = merge_last_good(fresh, previous)
    reports, rreceipt = select_reports(news, now, previous)
    syn = synthesize(reports, observations, synth_call, previous.get('synthesis'))
    hist = list(previous.get('history') or [])
    hist.append({'at': iso(now), 'values': {o['symbol']: [o['value'], o['observed_at']] for o in fresh}})
    doc = {'schema': SCHEMA, 'version': RULES_VERSION, 'generated_at': iso(now), 'baseline_session': baseline_session,
           'observations': observations, 'reports': reports, 'synthesis': syn, 'history': hist[-LIMITS['history']:],
           'market_health': {'status': mreceipt['status'], 'fresh': len(fresh), 'carried': sum(1 for o in observations if o.get('carried')),
                             'note': 'Carried observations keep their original clocks and never trigger a development.'},
           'sources': {'market_references': mreceipt, 'news_selection': {**rreceipt, 'status': 'ok' if rreceipt['kept'] else 'empty' if not news else 'suspect'},
                       'synthesis': {'status': syn['status'], 'reason': syn.get('reason')}},
           'limits': {k: LIMITS[k] for k in ('max_reads', 'deadline_s', 'max_reports')}}
    validate_situation(doc, now)
    return doc


def newer_situation(local, incoming, now=None):
    """Pick the situation document to keep: valid and not older wins; an invalid incoming file never replaces a valid
    local one. Returns None when neither is usable."""
    def ok(d):
        try:
            validate_situation(d, now)
            return True
        except Exception:  # noqa: BLE001 - invalid documents are simply not candidates
            return False
    a, b = (local if local and ok(local) else None), (incoming if incoming and ok(incoming) else None)
    if a and b:
        return b if stamp(b['generated_at']) >= stamp(a['generated_at']) else a
    return b or a


def validate_situation(doc, now=None):
    now = now or datetime.now(timezone.utc)
    if doc.get('schema') != SCHEMA:
        raise ValueError('Invalid situation schema')
    if stamp(doc['generated_at']) > now + timedelta(minutes=10):
        raise ValueError('Future situation timestamp')
    obs = doc.get('observations')
    if not isinstance(obs, list) or len(obs) > len(REFERENCES):
        raise ValueError('Invalid observation list')
    for o in obs:
        if stamp(o['observed_at']) > now + timedelta(minutes=10) or not (_finite(o['value']) and o['value'] > 0):
            raise ValueError('Invalid observation')
        c = o['comparison']
        oet = stamp(o['observed_at']).astimezone(ET); od = oet.date().isoformat()
        if c.get('basis') == 'chart_previous_close' or not (_finite(c['value']) and c['value'] > 0) or c['date'] > od or (c['date'] == od and not (o['kind'].endswith('_future') and oet.hour >= 18)):
            raise ValueError('Invalid comparison basis')
    reps = doc.get('reports')
    if not isinstance(reps, list) or len(reps) > LIMITS['max_reports'] or any(not str(r.get('url', '')).startswith('https://') for r in reps):
        raise ValueError('Invalid report list')
    if len(doc.get('history') or []) > LIMITS['history']:
        raise ValueError('Unbounded situation history')
    return len(obs), len(reps)
