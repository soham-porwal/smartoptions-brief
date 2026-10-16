/* SmartOptions Brief: app shell, hash router, data-health pill and the landing brief.
   Lane BU1. Pure helpers are exported for node tests; the DOM part runs only in a browser.
   Every sentence on the page comes from data/brief.json (built by Python templates); this file only lays it out. */
'use strict';
(function (root, factory) {
  const B = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = B;
  root.SmartOptionsBrief = B;
  if (root.document) B._start();
})(typeof window !== 'undefined' ? window : globalThis, function (root) {

  /* ================================================================ pure helpers */
  const VIEWS = ['brief', 'company', 'macro', 'research'];
  const SCREENER_ASOF_FALLBACK = '2026-07-25';   // release.json notes: Sam scores remain the dated 2026-07-25 snapshot

  // '#/brief', '#/company/AAPL', '#/macro', '#/research/flow?t=AAPL', legacy '#tab=overview&t=AAPL'
  function parseRoute(hash) {
    const h = String(hash || '').replace(/^#/, '');
    if (!h || h === '/') return {view: 'brief'};
    if (h[0] !== '/') {
      // legacy Edge hash: key=value pairs; it always meant the research desk
      const p = new URLSearchParams(h);
      return {view: 'research', tab: p.get('tab') || (p.has('t') || p.has('s') ? 'markets' : ''), legacy: true, params: h};
    }
    const q = h.indexOf('?');
    const path = (q < 0 ? h : h.slice(0, q)).split('/').filter(Boolean);
    const params = q < 0 ? '' : h.slice(q + 1);
    const view = (path[0] || 'brief').toLowerCase();
    if (view === 'company' || view === 'companies') {
      const t = (path[1] || '').toUpperCase();
      return /^[A-Z0-9][A-Z0-9.^-]{0,14}$/.test(t) ? {view: 'company', ticker: t} : {view: 'company', ticker: ''};
    }
    if (view === 'research') return {view: 'research', tab: (path[1] || '').toLowerCase().replace(/[^a-z0-9_-]/g, ''), legacy: false, params};
    if (view === 'macro') return {view: 'macro'};
    return {view: 'brief'};
  }
  // the Edge modules read '#tab=x&...' at startup; translate a research route to that form
  function legacyHash(route) {
    const p = new URLSearchParams(route.params || '');
    if (route.tab) p.set('tab', route.tab); else p.delete('tab');
    const s = p.toString();
    return s ? '#' + s : '#tab=overview';
  }
  function routeHash(route) {
    if (route.view === 'company') return '#/company' + (route.ticker ? '/' + route.ticker : '');
    if (route.view === 'research') return '#/research' + (route.tab ? '/' + route.tab : '');
    return '#/' + (VIEWS.includes(route.view) ? route.view : 'brief');
  }

  const TONE = {
    supportive: 'good', broadening: 'good', calm: 'good', strong: 'good', fresh: 'good', good: 'good', live: 'good', up: 'good',
    mixed: 'mixed', elevated: 'mixed', ok: 'mixed', delayed: 'mixed', neutral: 'mixed', flat: 'mixed',
    adverse: 'bad', narrowing: 'bad', stressed: 'bad', weak: 'bad', stale: 'bad', bad: 'bad', down: 'bad',
    unavailable: 'none', missing: 'none'};
  function tone(word) { return TONE[String(word || '').toLowerCase()] || 'none'; }
  function cap(s) { s = String(s == null ? '' : s); return s ? s[0].toUpperCase() + s.slice(1) : s; }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  // 0.05 h -> "3 min old"; 30 h -> "1 day old"
  function ageWords(hours) {
    if (!isNum(hours) || hours < 0) return 'age not known';
    const m = Math.round(hours * 60);
    if (m < 1) return 'under a minute old';
    if (m < 60) return m + ' min old';
    const h = Math.round(hours);
    if (hours < 36) return h + (h === 1 ? ' hour old' : ' hours old');
    const d = Math.round(hours / 24);
    return d + (d === 1 ? ' day old' : ' days old');
  }
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function shortDate(iso, withYear) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    if (!m) return '';
    return MONTHS[+m[2] - 1] + ' ' + (+m[3]) + (withYear ? ', ' + m[1] : '');
  }
  function daysBetween(isoA, nowMs) {
    const t = Date.parse(String(isoA).slice(0, 10) + 'T00:00:00Z');
    if (!isFinite(t)) return null;
    const n = new Date(nowMs); const today = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
    return Math.max(0, Math.round((today - t) / 864e5));
  }

  // The shared plain-language label for Sam's screener scores. Replaces "Sam columns: snapshot 2026-07-25".
  // mode 'short' -> "Screener scores from Jul 25 (82 days old)"; 'long' adds what they are.
  let screenerInfo = null;
  function screenerLabel(mode, info, nowMs) {
    const s = info || screenerInfo || {};
    const asof = s.asof || SCREENER_ASOF_FALLBACK;
    const days = daysBetween(asof, nowMs == null ? Date.now() : nowMs);
    const age = days == null ? '' : days === 0 ? ' (today)' : ' (' + days + (days === 1 ? ' day' : ' days') + ' old)';
    if (mode === 'long') {
      return "Sam's screener scores (Opportunity, Quality, Risk) were last calculated on " + shortDate(asof, true) + age +
        '. Prices, fundamentals and macro data on this site update separately and carry their own dates.';
    }
    if (mode === 'tip') return "Sam's screener score, calculated " + shortDate(asof, true) + age + '. Read-only.';
    return 'Screener scores from ' + shortDate(asof, false) + age;
  }
  function setScreener(info) { screenerInfo = info && info.asof ? info : screenerInfo; }

  // market hours in New York (weekday 9:30-16:00); holidays are not modelled
  function nyClock(nowMs) {
    const parts = {};
    try {
      new Intl.DateTimeFormat('en-US', {timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false})
        .formatToParts(new Date(nowMs)).forEach(p => { parts[p.type] = p.value; });
    } catch (e) { return {open: false, known: false}; }
    const mins = (+parts.hour % 24) * 60 + (+parts.minute);
    const wk = !['Sat', 'Sun'].includes(parts.weekday);
    return {open: wk && mins >= 570 && mins < 960, known: true};
  }

  // price freshness from quotes.json: {generated_at, source}
  function priceFreshness(quotes, nowMs) {
    if (!quotes || !quotes.generated_at) return {status: 'missing', words: 'Prices not available', note: 'quotes.json did not load'};
    const ageH = (nowMs - Date.parse(quotes.generated_at)) / 36e5;
    if (!isFinite(ageH)) return {status: 'missing', words: 'Prices not available', note: 'quote timestamp unreadable'};
    const src = String(quotes.source || '');
    const delayed = /delay/i.test(src);
    const clock = nyClock(nowMs);
    let status, words;
    if (clock.open) {
      if (ageH <= 1 / 60 && !delayed) { status = 'fresh'; words = 'Prices live'; }
      else if (ageH <= 0.5) { status = delayed ? 'delayed' : 'fresh'; words = 'Prices ' + ageWords(ageH) + (delayed ? ', provider delay about 15 min' : ''); }
      else { status = 'stale'; words = 'Prices ' + ageWords(ageH); }
    } else {
      status = ageH <= 20 ? 'fresh' : ageH <= 72 ? 'delayed' : 'stale';
      words = 'Market closed, prices ' + ageWords(ageH);   // quotes may include after-hours prints, so never say "at close"
    }
    return {status, words, ageH, note: src};
  }

  const RANK = {fresh: 0, live: 0, delayed: 1, stale: 2, missing: 3};
  function pickSource(sources, re) { return (sources || []).find(s => re.test(String(s.id || '') + ' ' + String(s.label || ''))); }
  // pill text: "Prices 3 min old, macro current"
  function pillText(health, quotes, nowMs) {
    const pf = priceFreshness(quotes, nowMs);
    const parts = [pf.words];
    let worst = RANK[pf.status] != null ? pf.status : 'missing';
    const macro = pickSource(health && health.sources, /macro/i);
    if (macro) {
      const st = String(macro.status || 'missing').toLowerCase();
      parts.push(st === 'fresh' ? 'macro current' : st === 'missing' ? 'macro not available' : 'macro ' + ageWords(macro.age_hours));
      if ((RANK[st] == null ? 3 : RANK[st]) > RANK[worst]) worst = st;
    } else if (health && health.overall) {
      const o = String(health.overall).toLowerCase();
      if ((RANK[o] == null ? 3 : RANK[o]) > RANK[worst]) worst = o;
    }
    return {text: parts.join(', '), short: pf.words.split(',')[0], status: worst, prices: pf};
  }

  // display a Metric value with its unit; null -> "Not available"
  function fmtValue(m) {
    if (!m || m.value == null || (typeof m.value === 'number' && !isFinite(m.value))) return null;
    if (typeof m.value !== 'number') return String(m.value);
    const v = m.value, u = String(m.unit || '');
    const a = Math.abs(v);
    const dp = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : 3;
    const n = x => x.toLocaleString('en-US', {minimumFractionDigits: dp, maximumFractionDigits: dp});
    if (/^usd(\/share)?$/i.test(u)) return '$' + v.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
    if (u === '%' || /^pct$/i.test(u)) return (v > 0 && m.signed ? '+' : '') + n(v) + '%';
    if (/^(pp|bp|bps)$/i.test(u)) return (v > 0 ? '+' : '') + n(v) + ' ' + u;
    return n(v) + (u ? ' ' + u : '');
  }

  /* ================================================================ browser part */
  const doc = root.document;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const safeURL = u => /^https?:\/\//i.test(u || '') ? esc(u) : '';
  const reduced = () => !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const ICON = {
    good: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M4.8 8.3l2.1 2.1 4.3-4.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    mixed: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 1a7 7 0 0 1 0 14z" fill="currentColor"/></svg>',
    bad: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.6l6.8 12.2H1.2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M8 6.2v3.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="11.9" r="1" fill="currentColor"/></svg>',
    none: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.4 2.2"/></svg>'};
  const ARROW = {up: '&#8599;', down: '&#8600;', flat: '&#8594;'};
  const DIRWORD = {up: 'rising', down: 'falling', flat: 'steady'};
  const GLOSS = {
    'Price trend': 'Where the S&P 500 sits against its own recent averages.',
    'Participation': 'Whether most stocks are rising with the index or only the largest few.',
    'Macro backdrop': 'Direction of growth, inflation and interest-rate policy.',
    'Risk conditions': 'Volatility, credit stress and scheduled events that can move prices.',
    'Breadth': 'Share of index members moving with the index.',
    'Concentration': 'How much of the index weight sits in the ten largest companies.',
    'Rotation': 'Which sectors are gaining or losing relative to the others.'};

  function chip(word, extra) {
    const t = tone(word);
    return `<span class="b-chip t-${t}${extra ? ' ' + extra : ''}">${ICON[t]}${esc(cap(word || 'Not available'))}</span>`;
  }
  function gloss(label) { return GLOSS[label] ? `<span class="b-gloss" tabindex="0" data-gloss="${esc(GLOSS[label])}">${esc(label)}</span>` : esc(label); }

  // ---- metrics flip
  function metricRows(metrics) {
    const ms = (metrics || []).filter(Boolean);
    if (!ms.length) return '<p class="b-na">No measured inputs were attached to this line.</p>';
    return `<table class="b-metrics"><thead><tr><th>Measure</th><th>Value</th><th>Period</th><th>As of</th><th>Source</th></tr></thead><tbody>${ms.map(m => {
      const v = fmtValue(m);
      const src = safeURL(m.source_url) ? `<a href="${safeURL(m.source_url)}" target="_blank" rel="noopener">${esc(m.source || 'source')}</a>` : esc(m.source || 'Source not stated');
      return `<tr><td>${esc(m.label)}${m.note ? `<div class="b-mnote">${esc(m.note)}</div>` : ''}</td><td class="v">${v == null ? `<span class="b-na">Not available${m.note ? '' : ''}</span>` : esc(v)}</td><td>${esc(m.period || '')}</td><td>${esc(m.asof || '')}</td><td>${src}</td></tr>`;
    }).join('')}</tbody></table>`;
  }
  let flipSeq = 0;
  function flip(metrics) {
    const id = 'bf' + (++flipSeq);
    return {btn: `<button type="button" class="b-flip" aria-expanded="false" aria-controls="${id}"><span class="b-flip-on">Numbers</span><span class="b-flip-off">Hide</span></button>`,
      box: `<div class="b-flipbox" id="${id}"><div><div class="b-flipin">${metricRows(metrics)}</div></div></div>`};
  }
  function bullet(b) {
    if (!b) return '';
    const f = flip(b.metrics);
    const t = b.tone === 'good' ? 'good' : b.tone === 'bad' ? 'bad' : 'neutral';
    const mark = t === 'good' ? '&#9650;' : t === 'bad' ? '&#9660;' : '&#9679;';
    const words = t === 'good' ? 'Positive' : t === 'bad' ? 'Negative' : 'Neutral';
    return `<li class="b-bul tn-${t}"><div class="b-bul-row"><span class="b-mark" title="${words}" aria-label="${words}">${mark}</span><span class="b-txt">${esc(b.text)}</span>${f.btn}</div>${f.box}</li>`;
  }
  function bulletList(items, emptyWhy) {
    const xs = (items || []).filter(Boolean);
    if (!xs.length) return `<p class="b-na">Not available: ${esc(emptyWhy)}</p>`;
    return `<ul class="b-buls">${xs.map(bullet).join('')}</ul>`;
  }
  // the key figure of an assessment: first numeric metric, shown with a count-up and, for bounded % values, a bar
  function keyFigure(metrics) {
    const m = (metrics || []).find(x => x && isNum(x.value));
    if (!m) return '<div class="b-key b-na">No figure</div>';
    const plain = /^(usd(\/share)?|%|pct|pp|bp|bps)$/i.test(m.unit || '') || !m.unit;
    const v = plain ? fmtValue(m) : fmtValue({value: m.value, unit: ''});
    const bounded = (m.unit === '%' || /pctile|share/i.test(m.label || '')) && m.value >= 0 && m.value <= 100;
    return `<div class="b-key"><span class="b-key-v" data-count="${m.value}" data-fmt="${esc(JSON.stringify({unit: plain ? m.unit || '' : ''}))}">${esc(v)}</span>${plain ? '' : `<span class="b-key-u"> ${esc(m.unit)}</span>`}<span class="b-key-l">${esc(m.label)}${m.period ? ', ' + esc(m.period) : ''}</span>${bounded ? meter(m.value, 100, '') : ''}</div>`;
  }
  function meter(v, max, t) {
    const w = Math.max(0, Math.min(1, v / max));
    return `<div class="b-meter" aria-hidden="true"><div class="b-meter-track"><div class="b-meter-fill b-anim${t ? ' t-' + t : ''}" style="transform:scaleX(${w.toFixed(3)})"></div></div></div>`;
  }
  function gauge(score, basis) {
    if (!isNum(score)) return `<div class="b-gauge t-none" title="${esc(basis || 'No score')}"><span class="b-gauge-num b-na">n/a</span></div>`;
    const s = Math.max(0, Math.min(100, score)), t = s >= 67 ? 'good' : s >= 40 ? 'mixed' : 'bad';
    const L = 100.5;   // half circumference of r=32
    return `<div class="b-gauge t-${t}" tabindex="0" aria-label="Score ${Math.round(s)} of 100. ${esc(basis || '')}" data-basis="${esc(basis || '')}">
      <svg viewBox="0 0 76 46" aria-hidden="true"><path class="g-track" d="M6 40a32 32 0 0 1 64 0" fill="none" stroke-width="7" stroke-linecap="round"/>
      <path class="g-val" d="M6 40a32 32 0 0 1 64 0" fill="none" stroke-width="7" stroke-linecap="round" stroke-dasharray="${L}" stroke-dashoffset="${(L * (1 - s / 100)).toFixed(1)}"/></svg>
      <span class="b-gauge-num" data-count="${s}" data-fmt='{"dp":0}'>${Math.round(s)}</span></div>`;
  }

  // ---- state
  const ST = {brief: null, briefSrc: '', briefErr: '', quotes: null, route: {view: 'brief'}, painted: {}, period: '1D', detailOpen: false};

  async function getJSON(p) { const r = await fetch(p, {cache: 'no-store'}); if (!r.ok) throw new Error(p + ' returned ' + r.status); return r.json(); }
  async function loadBrief() {
    const want = new URLSearchParams(root.location.search).get('fixture');
    const tries = want ? ['test/fixtures/brief.' + want.replace(/[^a-z0-9_-]/gi, '') + '.fixture.json'] : ['data/brief.json', 'test/fixtures/brief.fixture.json'];
    for (const p of tries) {
      try { ST.brief = await getJSON(p); ST.briefSrc = p; ST.briefErr = ''; break; } catch (e) { ST.briefErr = String(e.message || e); }
    }
    if (ST.brief && ST.brief.health) setScreener(ST.brief.health.screener);
  }
  async function loadQuotes() { try { ST.quotes = await getJSON('data/quotes.json'); } catch (e) { ST.quotes = null; } }

  // ---- shell
  function buildShell() {
    const hdr = doc.createElement('header');
    hdr.className = 'bv-hdr'; hdr.id = 'bv-hdr';
    hdr.innerHTML = `<div class="bv-hdr-in">
      <a class="bv-mark" href="#/brief" aria-label="SmartOptions Brief, home">SmartOptions<span>Brief</span></a>
      <nav class="bv-nav" aria-label="Main">
        <a href="#/brief" data-nav="brief">Brief</a><a href="#/company" data-nav="company">Companies</a><a href="#/macro" data-nav="macro">Macro</a><a href="#/research/overview" data-nav="research">Research</a>
      </nav>
      <div class="bv-hdr-r">
        <button type="button" class="bv-pill" id="bv-pill" aria-haspopup="dialog" aria-expanded="false"><span class="bv-dot"></span><span class="bv-pill-t">Checking data</span><span class="bv-pill-s" aria-hidden="true"></span></button>
        <button type="button" class="bv-theme" id="bv-theme" aria-label="Switch to dark theme" title="Theme"></button>
      </div></div>`;
    doc.body.prepend(hdr);
    const main = doc.createElement('main');
    main.className = 'bv'; main.id = 'bv-main';
    main.innerHTML = '<div class="bv-view" id="bv-view" aria-live="polite"></div>';
    hdr.after(main);
    const pop = doc.createElement('div');
    pop.className = 'bv-pop'; pop.id = 'bv-pop'; pop.hidden = true;
    pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', 'Data freshness');
    doc.body.appendChild(pop);
    hdr.querySelector('#bv-pill').addEventListener('click', e => { e.stopPropagation(); togglePop(); });
    hdr.querySelector('#bv-theme').addEventListener('click', () => setTheme(theme() === 'dark' ? 'light' : 'dark', true));
    doc.addEventListener('click', e => { if (!pop.hidden && !pop.contains(e.target)) togglePop(false); });
    doc.addEventListener('keydown', e => { if (e.key === 'Escape' && !pop.hidden) { togglePop(false); hdr.querySelector('#bv-pill').focus(); } });
    main.addEventListener('click', onMainClick);
    root.addEventListener('resize', () => { if (!pop.hidden) placePop(); });
  }
  function theme() { try { return root.localStorage.getItem('so-brief-theme') === 'dark' ? 'dark' : 'light'; } catch (e) { return 'light'; } }
  function setTheme(t, user) {
    if (user) { try { root.localStorage.setItem('so-brief-theme', t); } catch (e) { /* storage blocked: theme lasts this tab */ } }
    doc.documentElement.dataset.bt = t;
    const b = doc.getElementById('bv-theme');
    if (b) {
      b.setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
      b.innerHTML = t === 'dark'
        ? '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="4" fill="currentColor"/><g stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M10 1.5v2M10 16.5v2M1.5 10h2M16.5 10h2M4 4l1.4 1.4M14.6 14.6L16 16M4 16l1.4-1.4M14.6 5.4L16 4"/></g></svg>'
        : '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M15.5 12.6A6.5 6.5 0 0 1 7.4 4.5a6.5 6.5 0 1 0 8.1 8.1z" fill="currentColor"/></svg>';
    }
    // keep the research desk in the same theme
    const A = root.SO2;
    if (A && A.S && A.save) { const S = A.S(); const want = t === 'dark' ? 'dark' : 'light'; if (S.theme !== want) { S.theme = want; doc.documentElement.classList.toggle('light', want === 'light'); try { A.save(); } catch (e) { console.warn('[brief] theme sync', e); } } }
  }

  // ---- health pill + popover
  function renderPill() {
    const h = ST.brief && ST.brief.health;
    const p = pillText(h, ST.quotes, Date.now());
    const el = doc.getElementById('bv-pill'); if (!el) return;
    el.querySelector('.bv-pill-t').textContent = p.text;
    el.querySelector('.bv-pill-s').textContent = p.short;
    el.dataset.st = tone(p.status);
    el.setAttribute('aria-label', 'Data freshness: ' + p.text + '. Show details.');
    if (!doc.getElementById('bv-pop').hidden) renderPop();
  }
  function renderPop() {
    const pop = doc.getElementById('bv-pop');
    const h = (ST.brief && ST.brief.health) || {};
    const now = Date.now();
    const pf = priceFreshness(ST.quotes, now);
    const rows = [];
    rows.push({label: 'Prices (quotes.json)', asof: ST.quotes ? ST.quotes.generated_at : '', age: pf.ageH, status: pf.status,
      note: (ST.quotes ? ST.quotes.source + '. Checked every minute while this page is open.' : 'Quotes file did not load.')});
    // group per-category macro series and build receipts so the table stays short; worst status and oldest age win
    const groups = {};
    (h.sources || []).filter(s => !(ST.quotes && s.id === 'quotes') && s.id !== 'sam').forEach(s => {   // Sam's scores get their own line below
      const g = /^macro_/.test(s.id) ? 'macro_obs' : /receipt/i.test(s.label || '') ? 'build' : s.id;
      (groups[g] = groups[g] || []).push(s);
    });
    const NAME = {macro_obs: n => 'Macro observations (' + n + ' groups)', build: n => 'Site build (' + n + ' steps)'};
    Object.keys(groups).forEach(g => {
      const xs = groups[g];
      if (xs.length === 1 && !NAME[g]) { const s = xs[0]; rows.push({label: s.label || s.id, asof: s.asof, age: s.age_hours, status: s.status, note: s.note}); return; }
      const worst = xs.reduce((a, s) => ((RANK[String(s.status).toLowerCase()] ?? 3) > (RANK[String(a.status).toLowerCase()] ?? 3) ? s : a), xs[0]);
      const oldest = xs.reduce((a, s) => (isNum(s.age_hours) && (!isNum(a.age_hours) || s.age_hours > a.age_hours) ? s : a), xs[0]);
      rows.push({label: NAME[g] ? NAME[g](xs.length) : (xs[0].label || g), asof: oldest.asof, age: oldest.age_hours, status: worst.status, note: worst.note || xs[0].note});
    });
    const scr = h.screener || {asof: SCREENER_ASOF_FALLBACK, status: 'stale'};
    pop.innerHTML = `<div class="bv-pop-hd"><h2>Data freshness</h2><button type="button" class="bv-x" aria-label="Close">&times;</button></div>
      ${ST.briefSrc && ST.briefSrc.indexOf('test/') === 0 ? '<p class="bv-sample">This page is showing sample data for layout checks, not today\'s figures.</p>' : ''}
      ${!ST.brief ? `<p class="bv-sample">Brief data not available: ${esc(ST.briefErr || 'not built yet')}.</p>` : ''}
      <div class="bv-pop-tw"><table class="b-metrics bv-ht"><thead><tr><th>Source</th><th>As of</th><th>Age</th><th>Status</th><th>Note</th></tr></thead><tbody>
      ${rows.map(r => `<tr><td>${esc(r.label)}</td><td>${esc(fmtAsof(r.asof))}</td><td>${esc(isNum(r.age) ? ageWords(r.age) : '')}</td><td>${chip(r.status || 'missing', 'sm')}</td><td>${esc(r.note || '')}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="bv-scr">${chip(scr.status || 'stale', 'sm')}<p>${esc(screenerLabel('long'))}${scr.note ? ' ' + esc(scr.note) : ''}</p></div>
      ${h.line ? `<p class="bv-pop-line">${esc(h.line)}</p>` : ''}
      <p class="bv-pop-foot">Session ${esc(ST.brief ? ST.brief.asof_session : 'not known')}. Market hours are New York time; exchange holidays are not modelled.</p>`;
    pop.querySelector('.bv-x').addEventListener('click', () => togglePop(false));
    placePop();
  }
  function fmtAsof(s) {
    if (!s) return '';
    const t = Date.parse(s);
    if (!isFinite(t) || !/T/.test(s)) return s;
    try { return new Date(t).toLocaleString('en-US', {timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}) + ' ET'; } catch (e) { return s; }
  }
  function placePop() {
    const pop = doc.getElementById('bv-pop'), pill = doc.getElementById('bv-pill');
    const r = pill.getBoundingClientRect();
    const w = Math.min(720, root.innerWidth - 24);
    pop.style.width = w + 'px';
    pop.style.top = (r.bottom + 10 + root.scrollY) + 'px';
    pop.style.left = Math.max(12, Math.min(root.innerWidth - w - 12, r.right - w)) + 'px';
  }
  function togglePop(force) {
    const pop = doc.getElementById('bv-pop'), pill = doc.getElementById('bv-pill');
    const open = force == null ? pop.hidden : force;
    pop.hidden = !open; pill.setAttribute('aria-expanded', String(open));
    if (open) { renderPop(); const x = pop.querySelector('.bv-x'); if (x) x.focus(); }
  }

  // ---- router
  function applyRoute(fromLoad) {
    const r = parseRoute(root.location.hash);
    ST.route = r;
    const research = r.view === 'research';
    doc.body.classList.toggle('bv-on', !research);
    doc.body.classList.toggle('bv-research', research);
    doc.querySelectorAll('.bv-nav a').forEach(a => { if (a.dataset.nav === r.view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    if (research) {
      if (!r.legacy) { try { root.history.replaceState(null, '', legacyHash(r)); } catch (e) { /* file:// may refuse; Edge reads the tab below */ } }
      if (!fromLoad && r.tab) openEdgeTab(r.tab);
      doc.title = 'Research | SmartOptions Brief';
      return;
    }
    const view = doc.getElementById('bv-view');
    if (r.view === 'brief') { renderBrief(view); doc.title = 'Brief | SmartOptions'; }
    else if (r.view === 'macro') { renderMacroPage(view); doc.title = 'Macro | SmartOptions Brief'; }
    else if (r.view === 'company') { if (r.ticker) renderCompany(view, r.ticker); else renderCompanies(view); doc.title = (r.ticker ? r.ticker + ' | ' : 'Companies | ') + 'SmartOptions Brief'; }
    if (!fromLoad) root.scrollTo(0, 0);
  }
  function openEdgeTab(tab) {
    let n = 0;
    const go = () => {
      const A = root.SO2;
      if (!root.SO2_ready || !A) { if (++n < 100) setTimeout(go, 60); return; }
      const b = doc.querySelector('#tabs [data-tab="' + tab.replace(/"/g, '') + '"]');
      if (b) b.click(); else if (A.showTab) A.showTab(tab);
    };
    go();
  }
  function isResearch() { return ST.route.view === 'research'; }

  // ---- interactions inside the Brief view
  function onMainClick(e) {
    const f = e.target.closest('.b-flip');
    if (f) {
      const box = doc.getElementById(f.getAttribute('aria-controls'));
      const open = f.getAttribute('aria-expanded') !== 'true';
      f.setAttribute('aria-expanded', String(open)); if (box) box.classList.toggle('open', open);
      return;
    }
    const all = e.target.closest('[data-flipall]');
    if (all) {
      const sec = all.closest('section'); const open = all.getAttribute('aria-pressed') !== 'true';
      all.setAttribute('aria-pressed', String(open)); all.textContent = open ? 'Hide numbers' : 'Show numbers';
      sec.querySelectorAll('.b-flip').forEach(b => { b.setAttribute('aria-expanded', String(open)); const box = doc.getElementById(b.getAttribute('aria-controls')); if (box) box.classList.toggle('open', open); });
      return;
    }
    const det = e.target.closest('[data-detail]');
    if (det) {
      ST.detailOpen = det.getAttribute('aria-expanded') !== 'true';
      det.setAttribute('aria-expanded', String(ST.detailOpen));
      det.querySelector('.bd-lbl').textContent = ST.detailOpen ? 'Hide detailed macro observations' : 'Detailed macro observations';
      const box = doc.getElementById('bv-detail'); if (box) box.classList.toggle('open', ST.detailOpen);
      return;
    }
    const per = e.target.closest('[data-period]');
    if (per) { ST.period = per.dataset.period; mountHeatmap(); per.parentNode.querySelectorAll('[data-period]').forEach(b => b.setAttribute('aria-pressed', String(b === per))); }
  }

  // count-up of numbers on first paint
  function countUp(scope) {
    if (reduced()) return;
    const els = [...scope.querySelectorAll('[data-count]')];
    const t0 = performance.now(), D = 650;
    const items = els.map(el => {
      const end = +el.dataset.count; let fmt = {}; try { fmt = JSON.parse(el.dataset.fmt || '{}'); } catch (e) { fmt = {}; }
      return {el, end, fmt, final: el.textContent};
    }).filter(x => isNum(x.end));
    const step = now => {
      const p = Math.min(1, (now - t0) / D), k = 1 - Math.pow(1 - p, 3);
      items.forEach(x => {
        if (p >= 1) { x.el.textContent = x.final; return; }
        const v = x.end * k;
        x.el.textContent = x.fmt.dp === 0 ? String(Math.round(v)) : (fmtValue({value: v, unit: x.fmt.unit}) || x.final);
      });
      if (p < 1) root.requestAnimationFrame(step);
    };
    root.requestAnimationFrame(step);
  }
  function stagger(scope) { [...scope.querySelectorAll('.b-enter')].forEach((el, i) => el.style.setProperty('--i', Math.min(i, 12))); }
  function paint(view, html, key) {
    view.innerHTML = html;
    stagger(view);
    if (!ST.painted[key]) { ST.painted[key] = true; countUp(view); }
    else view.querySelectorAll('.b-enter').forEach(el => { el.style.animation = 'none'; });
  }

  // ---- landing
  function sessionWords(b) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b.asof_session || '');
    if (!m) return 'Session date not available';
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return 'Session of ' + d.toLocaleDateString('en-US', {timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'});
  }
  function notice() {
    if (!ST.brief) return '';
    if (ST.briefSrc.indexOf('test/') === 0) return '<div class="b-notice b-enter">Sample data for layout checks. These are not today\'s market figures.</div>';
    return '';
  }
  function missingPage(view) {
    view.innerHTML = `<div class="bv-wrap"><section class="b-card b-enter"><h1 class="b-h1">Brief</h1><p>Not available: the brief data file has not been built yet (${esc(ST.briefErr || 'no file')}).</p><p><a class="b-link-btn" href="#/research/overview">Open the research desk</a></p></section></div>`;
  }
  function assessTile(label, a, extra) {
    a = a || {};
    const f = flip(a.metrics);
    return `<article class="b-tile b-card b-enter"><div class="b-tile-hd"><h3>${gloss(label)}</h3>${chip(a.status || 'unavailable')}</div>
      ${extra || keyFigure(a.metrics)}<p class="b-line">${esc(a.line || 'Not available: no assessment in this brief.')}</p>
      <div class="b-tile-ft">${f.btn}</div>${f.box}</article>`;
  }
  function backdropRows(bd) {
    return `<ul class="b-dirs">${['growth', 'inflation', 'policy'].map(k => {
      const d = (bd && bd[k]) || {}; const dir = ['up', 'down', 'flat'].includes(d.direction) ? d.direction : null;
      return `<li><span class="b-dir-k">${cap(k)}</span><span class="b-dir-a${dir ? ' d-' + dir : ''}" aria-hidden="true">${dir ? ARROW[dir] : '&#8211;'}</span><span class="b-dir-w">${dir ? DIRWORD[dir] : 'not available'}</span><span class="b-dir-l">${esc(d.line || '')}</span></li>`;
    }).join('')}</ul>`;
  }
  function macroStrip(m) {
    m = m || {};
    const bd = m.backdrop || {};
    const bdMetrics = [].concat(...['growth', 'inflation', 'policy'].map(k => (bd[k] && bd[k].metrics) || []), bd.metrics || []);
    return `<div class="b-strip">${assessTile('Price trend', m.price_trend)}${assessTile('Participation', m.participation)}
      ${assessTile('Macro backdrop', {status: bd.status, line: bd.line, metrics: bdMetrics}, backdropRows(bd))}${assessTile('Risk conditions', m.risk)}</div>`;
  }
  const GROUP = {inflation: 'Inflation', labor: 'Labor market', growth: 'Growth', policy: 'Policy and rates', curve: 'Yield curve', cross_asset: 'Cross-asset', credit_funding: 'Credit and funding', volatility: 'Volatility'};
  function detailList(m) {
    const xs = (m && m.detail) || [];
    if (!xs.length) return '<p class="b-na">Not available: no detailed observations in this brief.</p>';
    return `<div class="b-detail-g">${xs.map(d => { const f = flip(d.metrics); return `<div class="b-obs"><h4>${esc(GROUP[d.group] || cap(d.group))}</h4><div class="b-bul-row"><span class="b-txt">${esc(d.line)}</span>${f.btn}</div>${f.box}</div>`; }).join('')}</div>`;
  }
  function pulseSection(p) {
    p = p || {};
    return `<section class="b-sec b-pulse b-card b-enter" aria-labelledby="h-pulse">
      <div class="b-sec-hd"><h2 id="h-pulse">Market pulse</h2>${chip(p.status || 'unavailable')}<button type="button" class="b-btn b-sm" data-flipall aria-pressed="false">Show numbers</button></div>
      ${p.headline ? `<p class="b-lead">${esc(p.headline)}</p>` : ''}
      <div class="b-cols">
        <div><h3>What changed</h3>${bulletList(p.changed, 'no change measured since the previous session')}</div>
        <div><h3>Supports</h3>${bulletList(p.supports, 'no supporting reading measured')}</div>
        <div><h3>Challenges</h3>${bulletList(p.challenges, 'no challenging reading measured')}</div>
      </div></section>`;
  }
  function watchSet() { try { return new Set(root.SmartOptionsWatchlist ? root.SmartOptionsWatchlist.get() : JSON.parse(root.localStorage.getItem('so_watchlist_v1') || '[]')); } catch (e) { return new Set(); } }
  function whenWords(iso) {
    const t = Date.parse(iso || '');
    if (!isFinite(t)) return {d: 'Date not set', h: ''};
    // a bare date is a calendar day, not midnight UTC: format it in UTC so it does not slip to the day before in New York
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(iso));
    const o = {timeZone: dateOnly ? 'UTC' : 'America/New_York'};
    try {
      const d = new Date(t).toLocaleDateString('en-US', Object.assign({weekday: 'short', month: 'short', day: 'numeric'}, o));
      const hasTime = /T\d{2}:\d{2}/.test(iso) && !/T00:00(:00)?/.test(iso);
      return {d, h: hasTime ? new Date(t).toLocaleTimeString('en-US', Object.assign({hour: 'numeric', minute: '2-digit'}, o)) + ' ET' : 'time not announced'};
    } catch (e) { return {d: String(iso).slice(0, 10), h: ''}; }
  }
  function etDay(nowMs) { try { return new Intl.DateTimeFormat('en-CA', {timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date(nowMs)); } catch (e) { return new Date(nowMs).toISOString().slice(0, 10); } }
  // drops items dated before today (New York); nowMs null keeps everything
  function sortRisks(risks, watch, nowMs) {
    const today = nowMs == null ? '' : etDay(nowMs);
    // watchlist names and the highest-importance releases first, then by time
    const w = r => r.watchlist || (r.tickers || []).some(t => watch.has(t)) || r.importance === 3 ? 0 : 1;
    return (risks || []).filter(r => !today || !/^\d{4}-\d{2}-\d{2}/.test(r.when_et || '') || String(r.when_et).slice(0, 10) >= today).sort((a, b) => w(a) - w(b) || (Date.parse(a.when_et) || 0) - (Date.parse(b.when_et) || 0));
  }
  function risksSection(risks) {
    const watch = watchSet();
    const xs = sortRisks(risks, watch, Date.now());
    const shown = xs.slice(0, 6);
    const body = !shown.length ? '<p class="b-na">Not available: no scheduled releases or earnings in this brief.</p>' :
      `<ol class="b-risks">${shown.map(r => {
        const w = whenWords(r.when_et), imp = [1, 2, 3].includes(r.importance) ? r.importance : 1, f = flip(r.metrics);
        const iw = imp === 3 ? 'High importance' : imp === 2 ? 'Medium importance' : 'Low importance';
        const mine = r.watchlist || (r.tickers || []).some(t => watch.has(t));
        return `<li class="b-risk"><div class="b-risk-when"><b>${esc(w.d)}</b><span>${esc(w.h)}</span></div>
          <div class="b-risk-what"><div class="b-risk-t"><span class="b-kind k-${r.kind === 'earnings' ? 'e' : 'm'}">${r.kind === 'earnings' ? 'Earnings' : 'Macro'}</span>${esc(r.title)}${mine ? '<span class="b-mine">Watchlist</span>' : ''}</div>
          <div class="b-risk-why">${esc(r.why || '')}${(r.tickers || []).length ? ' ' + r.tickers.slice(0, 4).map(t => `<a class="b-tk" href="#/company/${esc(t)}">${esc(t)}</a>`).join(' ') : ''}</div>${f.box}</div>
          <div class="b-risk-r"><span class="b-imp" role="img" aria-label="${iw}" title="${iw}">${[1, 2, 3].map(i => `<i class="${i <= imp ? 'on' : ''}"></i>`).join('')}</span>${f.btn}</div></li>`;
      }).join('')}</ol>${xs.length > 6 ? `<p class="b-more">${xs.length - 6} more on the <a href="#/research/macro">macro calendar</a>.</p>` : ''}`;
    return `<section class="b-sec b-card b-enter" aria-labelledby="h-risks"><div class="b-sec-hd"><h2 id="h-risks">Upcoming risks</h2><span class="b-count">${xs.length ? 'Next ' + shown.length + ' of ' + xs.length : ''}</span></div>${body}</section>`;
  }
  function verdict(label, a, figure) {
    a = a || {}; const f = flip(a.metrics);
    return `<div class="b-verdict"><div class="b-verdict-hd"><h3>${gloss(label)}</h3>${chip(a.status || 'unavailable', 'sm')}</div>${figure || ''}
      <div class="b-bul-row"><span class="b-txt">${esc(a.line || 'Not available: no reading in this brief.')}</span>${f.btn}</div>${f.box}</div>`;
  }
  function sectorBars(sectors, period) {
    const k = period === '1W' ? 'd5' : period === '1M' ? 'm1' : 'd1';
    const xs = (sectors || []).filter(s => isNum(s[k])).sort((a, b) => b[k] - a[k]);
    if (!xs.length) return '<p class="b-na">Not available: sector returns are not in this brief.</p>';
    const mx = Math.max(...xs.map(s => Math.abs(s[k]))) || 1;
    return `<ul class="b-sbars" aria-label="Sector returns, ${period}">${xs.map(s => {
      const v = s[k], w = Math.abs(v) / mx * 50;
      return `<li><span class="b-sb-n">${esc(s.sector)}</span><span class="b-sb-t"><i class="${v >= 0 ? 'up' : 'dn'}" style="${v >= 0 ? 'left:50%' : 'right:50%'};width:${w.toFixed(1)}%"></i></span><span class="b-sb-v ${v >= 0 ? 'up' : 'dn'}">${v > 0 ? '+' : ''}${v.toFixed(2)}%</span></li>`;
    }).join('')}</ul>`;
  }
  function positioningSection(pos) {
    pos = pos || {};
    const c = pos.concentration || {}, ro = pos.rotation || {};
    const cFig = isNum(c.top10_share_pct) ? `<div class="b-key"><span class="b-key-v" data-count="${c.top10_share_pct}" data-fmt='{"unit":"%"}'>${esc(fmtValue({value: c.top10_share_pct, unit: '%'}))}</span><span class="b-key-l">Top 10 share of index weight</span>${meter(c.top10_share_pct, 100, '')}</div>` : '';
    const rl = (xs, cls) => (xs || []).slice(0, 3).map(s => `<span class="b-rot ${cls}">${esc(s.sector)} ${isNum(s.ret_20d_pct) ? (s.ret_20d_pct > 0 ? '+' : '') + s.ret_20d_pct.toFixed(1) + '%' : ''}</span>`).join('');
    const rFig = (ro.leaders || []).length || (ro.laggards || []).length ? `<div class="b-rots"><div><span class="b-rot-k">Leading, 20 days</span>${rl(ro.leaders, 'up')}</div><div><span class="b-rot-k">Lagging, 20 days</span>${rl(ro.laggards, 'dn')}</div></div>` : '';
    return `<section class="b-sec b-card b-enter" aria-labelledby="h-pos"><div class="b-sec-hd"><h2 id="h-pos">S&amp;P positioning</h2>
      <div class="b-seg" role="group" aria-label="Period">${['1D', '1W', '1M'].map(p => `<button type="button" data-period="${p}" aria-pressed="${p === ST.period}">${p}</button>`).join('')}</div></div>
      <div class="b-pos"><div class="b-hm" id="bv-heatmap"></div>
      <div class="b-verdicts">${verdict('Breadth', pos.breadth)}${verdict('Concentration', c, cFig)}${verdict('Rotation', ro, rFig)}</div></div></section>`;
  }
  function mountHeatmap() {
    const el = doc.getElementById('bv-heatmap'); if (!el) return;
    const H = root.SmartOptionsHeatmap;
    if (!H && doc.readyState !== 'complete') root.addEventListener('load', mountHeatmap, {once: true});   // heatmap.js loads after this file
    if (H && typeof H.mount === 'function') {
      try { H.mount(el, {period: ST.period, brief: ST.brief}); return; } catch (e) { console.error('[brief] heatmap mount failed', e); }
    }
    el.innerHTML = `<div class="b-hm-fb"><h3>Sector returns, ${ST.period}</h3>${sectorBars(ST.brief && ST.brief.positioning && ST.brief.positioning.sectors, ST.period)}</div>`;
  }
  const DIMS = [['growth', 'Growth'], ['profitability', 'Profitability'], ['cash', 'Cash'], ['resilience', 'Resilience'], ['valuation', 'Valuation'], ['expectations', 'Expectations']];
  // compact card: first reason and the counter line up front; all reasons with their numbers behind one flip
  function shortlistSection(list) {
    const xs = (list || []).slice(0, 8);
    const bases = [...new Set(xs.map(n => n.score_basis || ''))];
    const shared = bases.length === 1 && bases[0] ? bases[0] : '';
    const body = !xs.length ? '<p class="b-na">Not available: no names passed the shortlist rules in this brief.</p>' :
      `<div class="b-names">${xs.map(n => {
        const st = n.status || {}, why = (n.why || []).filter(Boolean).slice(0, 3);
        const dims = DIMS.filter(([k]) => st[k]).map(([k, l]) => `<span class="b-dim t-${tone(st[k])}" title="${esc(l + ': ' + st[k])}"><i aria-hidden="true"></i>${esc(l)}<span class="b-vh"> ${esc(st[k])}</span></span>`).join('');
        const allM = [].concat(...why.map(b => b.metrics || []), (n.counter && n.counter.metrics) || []);
        const f = flip(allM);
        const more = why.slice(1).map(b => `<li>${esc(b.text)}</li>`).join('');
        const lead = why[0] ? esc(why[0].text) : '<span class="b-na">Not available: no reasons recorded.</span>';
        const box = f.box.replace('<div class="b-flipin">', `<div class="b-flipin">${more ? `<ul class="b-more-why">${more}</ul>` : ''}`);
        return `<article class="b-name b-card b-enter"><div class="b-name-hd"><div><h3><a href="#/company/${esc(n.t)}">${esc(n.name || n.t)}</a></h3><div class="b-name-sub">${esc(n.t)}${n.sector ? ' · ' + esc(n.sector) : ''}</div></div>${gauge(n.score, n.score_basis)}</div>
          ${!shared && n.score_basis ? `<p class="b-basis">Score basis: ${esc(n.score_basis)}</p>` : ''}
          <p class="b-why"><span class="b-mark tn-good" aria-label="For">&#9650;</span>${lead}${why.length > 1 ? ` <span class="b-plus">+${why.length - 1} more</span>` : ''}</p>
          <p class="b-against"><span class="b-counter-k">Against</span>${n.counter && n.counter.text ? esc(n.counter.text) : '<span class="b-na">Not available: no counter-argument recorded.</span>'}</p>
          ${dims ? `<div class="b-dims">${dims}</div>` : ''}
          ${box}
          <div class="b-name-ft"><a class="b-btn b-open" href="#/company/${esc(n.t)}">Open ${esc(n.t)}</a>${f.btn.replace('<span class="b-flip-on">Numbers</span>', '<span class="b-flip-on">Details</span>')}</div></article>`;
      }).join('')}</div>`;
    return `<section class="b-sec" aria-labelledby="h-short"><div class="b-sec-hd b-sec-hd-out"><h2 id="h-short">Research shortlist</h2><span class="b-count">${xs.length ? xs.length + ' names' : ''}</span></div>
      ${shared ? `<p class="b-basis b-basis-all">Score basis: ${esc(shared)}</p>` : ''}${body}</section>`;
  }
  function renderBrief(view) {
    const b = ST.brief;
    if (!b) return missingPage(view);
    const html = `<div class="bv-wrap">${notice()}
      <div class="b-title b-enter"><h1 class="b-h1">Market brief</h1><p class="b-date">${esc(sessionWords(b))}</p></div>
      ${pulseSection(b.pulse)}
      <section class="b-sec b-macro" aria-labelledby="h-macro"><h2 id="h-macro" class="b-vh">Macro assessment</h2>${macroStrip(b.macro)}
        <button type="button" class="b-detail-btn b-enter" data-detail aria-expanded="${ST.detailOpen}" aria-controls="bv-detail"><span class="bd-lbl">${ST.detailOpen ? 'Hide detailed macro observations' : 'Detailed macro observations'}</span><span class="bd-car" aria-hidden="true">&#9662;</span></button>
        <div class="b-flipbox${ST.detailOpen ? ' open' : ''}" id="bv-detail"><div><div class="b-card b-detail">${detailList(b.macro)}<p class="b-more"><a href="#/research/macro">Open the full macro grid</a></p></div></div></div>
      </section>
      ${risksSection(b.risks)}
      ${positioningSection(b.positioning)}
      ${shortlistSection(b.shortlist)}
      <footer class="b-foot">Research tool, not investment advice. ${esc(screenerLabel('short'))}. Brief built ${esc(fmtAsof(typeof b.generated_at === 'string' ? b.generated_at : (b.generated_at && (b.generated_at.equities || b.generated_at.macro)) || ''))}.</footer>
      </div>`;
    paint(view, html, 'brief');
    mountHeatmap();
  }
  function renderMacroPage(view) {
    const b = ST.brief;
    if (!b) return missingPage(view);
    paint(view, `<div class="bv-wrap">${notice()}<div class="b-title b-enter"><h1 class="b-h1">Macro</h1><p class="b-date">${esc(sessionWords(b))}</p></div>
      <section class="b-sec b-macro">${macroStrip(b.macro)}</section>
      <section class="b-sec b-card b-enter" aria-labelledby="h-obs"><div class="b-sec-hd"><h2 id="h-obs">Detailed observations</h2><button type="button" class="b-btn b-sm" data-flipall aria-pressed="false">Show numbers</button></div>${detailList(b.macro)}
      <p class="b-more"><a href="#/research/macro">Open the full macro grid and calendar</a></p></section>
      ${risksSection(b.risks)}</div>`, 'macro');
  }
  function renderCompany(view, t) {
    view.innerHTML = `<div class="bv-wrap"><p class="b-crumb"><a href="#/company">Companies</a> / ${esc(t)}</p><div id="bv-company" class="bv-company"><p class="b-na">Loading ${esc(t)}.</p></div></div>`;
    const el = doc.getElementById('bv-company');
    let n = 0;
    const go = () => {
      if (ST.route.view !== 'company' || ST.route.ticker !== t) return;
      const C = root.SmartOptionsCompany;
      if (C && typeof C.mount === 'function') { try { C.mount(el, t); } catch (e) { console.error('[brief] company mount failed', e); el.innerHTML = `<p class="b-na">Not available: the company view failed to load (${esc(e.message || e)}).</p>`; } return; }
      if (++n < 40) { setTimeout(go, 75); return; }
      el.innerHTML = `<section class="b-card"><h1 class="b-h1">${esc(t)}</h1><p class="b-na">Not available: the company workspace is not part of this build yet.</p><p><a class="b-link-btn" href="#t=${esc(t)}">Open ${esc(t)} in the research desk</a></p></section>`;
    };
    go();
  }
  function renderCompanies(view) {
    const A = root.SO2, rows = A && A.D && A.D() ? A.D().rows : [];
    const watch = [...watchSet()];
    const list = (ST.brief && ST.brief.shortlist) || [];
    const byT = {}; rows.forEach(r => { byT[r.t] = r; });
    const card = (t, sub) => { const r = byT[t]; return `<a class="b-co" href="#/company/${esc(t)}"><b>${esc(t)}</b><span>${esc(r ? r.n : sub || '')}</span></a>`; };
    view.innerHTML = `<div class="bv-wrap"><div class="b-title b-enter"><h1 class="b-h1">Companies</h1></div>
      <section class="b-sec b-card b-enter"><label class="b-find"><span>Find a company</span><input type="search" id="bv-find" placeholder="Ticker or name" autocomplete="off" spellcheck="false"></label><div id="bv-found" class="b-cos"></div></section>
      ${list.length ? `<section class="b-sec b-card b-enter"><h2>Research shortlist</h2><div class="b-cos">${list.map(n => card(n.t, n.name)).join('')}</div></section>` : ''}
      <section class="b-sec b-card b-enter"><h2>Your watchlist</h2>${watch.length ? `<div class="b-cos">${watch.map(t => card(t)).join('')}</div>` : '<p class="b-na">Your watchlist is empty. Add names from the research desk.</p>'}</section></div>`;
    stagger(view);
    const inp = doc.getElementById('bv-find'), out = doc.getElementById('bv-found');
    inp.addEventListener('input', () => {
      const q = inp.value.trim().toLowerCase();
      if (!q) { out.innerHTML = ''; return; }
      const rs = (root.SO2 && root.SO2.D && root.SO2.D() ? root.SO2.D().rows : []).filter(r => r.t.toLowerCase().startsWith(q) || String(r.n || '').toLowerCase().includes(q)).slice(0, 12);
      out.innerHTML = rs.length ? rs.map(r => card(r.t)).join('') : `<p class="b-na">${rows.length ? 'No match in the ' + rows.length + ' covered companies.' : 'Company list is still loading.'}</p>`;
    });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { const a = out.querySelector('a'); if (a) root.location.hash = a.getAttribute('href'); } });
  }

  // ---- start
  async function start() {
    const r0 = parseRoute(root.location.hash);
    ST.route = r0;
    // research routes must look like legacy hashes before the Edge modules read them at startup
    if (r0.view === 'research' && !r0.legacy) { try { root.history.replaceState(null, '', legacyHash(r0)); } catch (e) { /* ignore */ } }
    const go = () => {
      buildShell();
      setTheme(theme(), false);
      doc.body.classList.toggle('bv-on', r0.view !== 'research');
      doc.body.classList.toggle('bv-research', r0.view === 'research');
      Promise.all([loadBrief(), loadQuotes()]).then(() => { applyRoute(true); renderPill(); });
      root.addEventListener('hashchange', () => applyRoute(false));
      setInterval(() => { if (doc.visibilityState === 'visible') loadQuotes().then(renderPill); }, 60 * 1000);
      // once the Edge desk is ready: sync theme, refresh the company list
      let n = 0; const w = setInterval(() => { if (root.SO2_ready) { clearInterval(w); setTheme(theme(), false); if (ST.route.view === 'company' && !ST.route.ticker) applyRoute(true); } else if (++n > 300) clearInterval(w); }, 100);
    };
    if (doc.body) go(); else doc.addEventListener('DOMContentLoaded', go);
  }

  return {parseRoute, legacyHash, routeHash, tone, ageWords, shortDate, screenerLabel, setScreener, pillText, priceFreshness, fmtValue, sortRisks, nyClock,
    isResearch, data: () => ST.brief, dataSource: () => ST.briefSrc, chip: w => chip(w), metricRows, esc, SCREENER_ASOF_FALLBACK, _start: start};
});
