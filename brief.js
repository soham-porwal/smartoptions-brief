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
  const VIEWS = ['brief', 'company', 'macro', 'research', 'my-dash', 'flows'];
  const SCREENER_ASOF_FALLBACK = '2026-07-25';   // release.json notes: Historical scores remain the dated 2026-07-25 snapshot

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
    if (view === 'my-dash' || view === 'flows') return {view};
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
  // A partial selected-name feed must never replace newer observations with a stale sweep.
  function mergeQuotes(previous,incoming,nowMs) {
    const now=nowMs==null?Date.now():nowMs, out={...(previous||{}),...(incoming||{}),quotes:{...(previous&&previous.quotes||{})}};
    for(const [t,q] of Object.entries(incoming&&incoming.quotes||{})) {
      const n=q&&Date.parse(q.asof_utc||q.ts), p=out.quotes[t], old=p&&Date.parse(p.asof_utc||p.ts);
      if(q && q.status==='ok' && isNum(q.price) && q.price>0 && isFinite(n) && n<=now+60000 && (!isFinite(old)||n>=old)) out.quotes[t]=q;
      else if(!p && q && q.status!=='ok') out.quotes[t]=q;
    }
    return out;
  }

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
    const parts = {};
    new Intl.DateTimeFormat('en-US', {timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit'})
      .formatToParts(new Date(nowMs)).forEach(p => { parts[p.type] = p.value; });
    const today = Date.UTC(+parts.year, +parts.month - 1, +parts.day);
    return Math.max(0, Math.round((today - t) / 864e5));
  }

  // The shared plain-language label for Historical screener scores. Replaces "Historical columns: snapshot 2026-07-25".
  // mode 'short' -> "Screener scores from Jul 25 (82 days old)"; 'long' adds what they are.
  let screenerInfo = null;
  function screenerLabel(mode, info, nowMs) {
    const s = info || screenerInfo || {};
    const asof = s.asof || SCREENER_ASOF_FALLBACK;
    const days = daysBetween(asof, nowMs == null ? Date.now() : nowMs);
    const age = days == null ? '' : days === 0 ? ' (today)' : ' (' + days + (days === 1 ? ' day' : ' days') + ' old)';
    if (mode === 'long') {
      return "Historical screener scores (Opportunity, Quality, Risk) were last calculated on " + shortDate(asof, true) + age +
        '. Prices, fundamentals and macro data on this site update separately and carry their own dates.';
    }
    if (mode === 'tip') return "Historical screener score, calculated " + shortDate(asof, true) + age + '. Read-only.';
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

  // Only observation timestamps establish price age. Rewriting a cache is not a trade.
  function priceFreshness(quotes, nowMs) {
    nowMs = nowMs == null ? Date.now() : nowMs;
    const all = Object.values(quotes && quotes.quotes || {});
    const observed = all.filter(q => q && q.status === 'ok' && isNum(q.price) && q.price > 0 &&
      isFinite(Date.parse(q.asof_utc || q.ts)) && Date.parse(q.asof_utc || q.ts) <= nowMs + 60000);
    if (!observed.length) return {status: 'missing', words: 'Prices not available', note: 'No valid timestamped prices in the quote feed.'};
    const ages = observed.map(q => Math.max(0, (nowMs - Date.parse(q.asof_utc || q.ts)) / 36e5)).sort((a, b) => a - b);
    const mid = Math.floor(ages.length / 2), ageH = ages.length % 2 ? ages[mid] : (ages[mid - 1] + ages[mid]) / 2;
    const oldestH = ages[ages.length - 1], missing = all.length - observed.length;
    const providers = [...new Set(observed.map(q => q.provider || 'Provider not stated'))];
    const delayed = observed.some(q => q.delay_minutes > 0 || /delay/i.test(q.provider || ''));
    const realtime = observed.every(q => q.delay_minutes === 0 && /real.?time|iex/i.test(q.provider || ''));
    const clock = nyClock(nowMs), open = quotes.session === 'closed' ? false : clock.open;
    let status, words;
    if (open) {
      if (oldestH <= 1 / 60 && realtime && !missing) { status = 'fresh'; words = 'Prices live'; }
      else if (ageH <= 0.5) { status = delayed ? 'delayed' : 'fresh'; words = 'Prices ' + ageWords(ageH) + (delayed ? ', provider delay about 15 min' : ''); }
      else { status = 'stale'; words = 'Prices ' + ageWords(ageH); }
    } else {
      status = ageH <= 20 ? 'fresh' : ageH <= 72 ? 'delayed' : 'stale';
      words = 'Market closed, prices ' + ageWords(ageH);   // quotes may include after-hours prints, so never say "at close"
    }
    if (missing && status === 'fresh') status = 'delayed';
    const sources = quotes.health && quotes.health.sources || [];
    const notes = sources.filter(s => s.status !== 'ok').map(s => `${s.id}: ${s.note || s.status}`);
    const note = `Median observation ${ageWords(ageH)}; oldest ${ageWords(oldestH)}. ${observed.length}/${all.length} prices available. ` +
      providers.join('; ') + '. ' + notes.join('; ') + (quotes.health && quotes.health.estimated_sweep_minutes ?
        ` Full real-time-provider sweep estimate: ${quotes.health.estimated_sweep_minutes} minutes; delayed fallback has its own cadence.` : '');
    return {status, words, ageH, oldestH, note, asof: new Date(nowMs - ageH * 36e5).toISOString()};
  }

  const RANK = {fresh: 0, live: 0, closed: 0.5, delayed: 1, mixed: 1, stale: 2, missing: 3};
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
    }
    if (health && health.overall) {
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
  const impact = () => root.SmartOptionsImpact;
  const drivers = (items, goFor) => {
    if (!impact()) return '';
    const evidence = items.map(it => {
      const primary = (it.metrics || []).find(m => impact().catOf(m.label));
      const cat = primary && impact().catOf(primary.label);
      return {...it, status: it.status === 'elevated' ? 'adverse' : it.status,
        metrics: (it.metrics || []).filter(m => impact().catOf(m.label) === cat)};
    });
    return impact().drivenBy(impact().drivers(evidence), {max: 4, goFor: goFor || (cat => `.b-metrics [data-impact-cat="${cat}"]`)});
  };
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
  function metricRows(metrics, full) {
    const ms = (metrics || []).filter(Boolean);
    if (!full && ms.length > 3) return metricRows(ms.slice(0, 3), true) + `<details><summary>All ${ms.length} sourced inputs</summary>${metricRows(ms.slice(3), true)}</details>`;
    if (!ms.length) return '<p class="b-na">No measured inputs were attached to this line.</p>';
    return `<table class="b-metrics"><thead><tr><th>Measure</th><th>Value</th><th>Period</th><th>As of</th><th>Source</th></tr></thead><tbody>${ms.map(m => {
      const v = fmtValue(m);
      const src = safeURL(m.source_url) ? `<a href="${safeURL(m.source_url)}" target="_blank" rel="noopener">${esc(m.source || 'source')}</a>` : esc(m.source || 'Source not stated');
      return `<tr><td data-impact-cat="${impact() ? esc(impact().catOf(m.label) || '') : ''}">${impact() ? impact().term(m.label) : esc(m.label)}${m.note ? `<div class="b-mnote">${esc(m.note)}</div>` : ''}</td><td class="v">${v == null ? `<span class="b-na">Not available${m.note ? '' : ''}</span>` : esc(v)}</td><td>${esc(m.period || '')}</td><td>${esc(m.asof || '')}</td><td>${src}</td></tr>`;
    }).join('')}</tbody></table>`;
  }
  let flipSeq = 0;
  function flip(metrics) {
    const id = 'bf' + (++flipSeq);
    return {btn: `<button type="button" class="b-flip" aria-expanded="false" aria-controls="${id}" title="Numbers and sources"><span class="b-flip-on">Numbers</span><span class="b-flip-off">Hide</span></button>`,
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
  const ST = {brief: null, briefSrc: '', briefErr: '', quotes: null, route: {view: 'brief'}, painted: {}, period: '1D', detailOpen: false, nextBrief:null, coreRevision:null, quotesProxy:'', quoteErr:'', quoteErrSource:'', polling:false};

  async function getJSON(p) { const r = await fetch(p, {cache: 'no-store'}); if (!r.ok) throw new Error(p + ' returned ' + r.status); return r.json(); }
  async function loadBrief() {
    const want = new URLSearchParams(root.location.search).get('fixture');
    const tries = want ? ['test/fixtures/brief.' + want.replace(/[^a-z0-9_-]/gi, '') + '.fixture.json'] : ['data/brief.json', 'test/fixtures/brief.fixture.json'];
    for (const p of tries) {
      try { ST.brief = await getJSON(p); ST.briefSrc = p; ST.briefErr = ''; break; } catch (e) { ST.briefErr = String(e.message || e); }
    }
    if (ST.brief && ST.brief.health) setScreener(ST.brief.health.screener);
  }
  // Prices come from SO2.Live (app/live.js): Worker fast path for on-screen names, shared file fallback.
  const live = () => root.SmartOptionsLive || (root.SO2 && root.SO2.Live);
  async function loadQuotes() { if (live()) await live().loadFile(); }
  function acceptQuotes() {
    const L = live(); if (!L) return;
    ST.quotes = L.snapshot();
    const I=root.SmartOptionsIntelligence;if(I)I.onQuotes(ST.quotes);
    const company=doc&&doc.getElementById('bv-company');
    if(company&&company.__soCo&&company.__soCo.updateQuotes)company.__soCo.updateQuotes(ST.quotes);
  }
  function watchOnScreen() {
    const L = live(); if (!L) return;
    const r = ST.route || {};
    L.watch('company', r.view === 'company' && r.ticker ? [r.ticker] : []);
    L.watch('index', ['SPY', 'RSP']);
    L.watch('shortlist', r.view === 'brief' ? (ST.brief && ST.brief.shortlist || []).map(x => x.t) : []);
    L.watch('watchlist', r.view === 'brief' || r.view === 'company' ? [...watchSet()].slice(0, 12) : []);
    if (r.view !== 'research') { L.watch('research', []); L.watch('table', []); }   // Research owners stop polling when it closes
    else if (root.SO2 && root.SO2.V && root.SO2.filtered) {
      const sel = root.SO2.V.sel; L.watch('research', sel && sel.kind === 't' ? [sel.id] : []);
      try { L.watch('table', root.SO2.filtered().slice(0, 12).map(x => x.t)); } catch (e) { console.warn('[brief] research rows not watched', e); }
    }
  }
  function startLive() {
    const L = live();
    if (!L) { ST.quoteErr = 'Price engine did not load; prices show the session close.'; return; }
    L.subscribe(ev => { acceptQuotes(); if (ST.route.view === 'brief') liveBrief(ev.changed); renderPill(); });
    root.addEventListener('so:live-health', () => renderPill());
    watchOnScreen();
    L.start();
  }

  // ---- shell
  function buildShell() {
    const hdr = doc.createElement('header');
    hdr.className = 'bv-hdr'; hdr.id = 'bv-hdr';
    hdr.innerHTML = `<div class="bv-hdr-in">
      <a class="bv-mark" href="#/brief" aria-label="SmartOptions Brief, home">SmartOptions<span>Brief</span></a>
      <nav class="bv-nav" aria-label="Main">
        <a href="#/brief" data-nav="brief">Brief</a><a href="#/company" data-nav="company"><span class="nav-wide">Companies</span><span class="nav-small">Company</span></a><a href="#/flows" data-nav="flows"><span class="nav-wide">Capital &amp; news</span><span class="nav-small">Capital</span></a><a href="#/my-dash" data-nav="my-dash">My Dash</a><a href="#/macro" data-nav="macro" class="nav-secondary">Macro</a><a href="#/research/overview" data-nav="research" class="nav-secondary">Research</a><button type="button" class="bv-more" id="bv-more" aria-expanded="false" aria-controls="bv-more-menu">More</button>
      </nav>
      <div class="bv-hdr-r">
        <button type="button" class="bv-pill" id="bv-pill" aria-haspopup="dialog" aria-expanded="false"><span class="bv-dot"></span><span class="bv-pill-t">Checking data</span><span class="bv-pill-s" aria-hidden="true"></span></button>
        <button type="button" class="bv-theme" id="bv-theme" aria-label="Switch to dark theme" title="Theme"></button>
      </div></div>`;
    doc.body.prepend(hdr);
    const main = doc.createElement('main');
    main.className = 'bv'; main.id = 'bv-main';
    main.innerHTML = '<div id="bv-update-banner" class="bv-update-banner" role="status" hidden></div><div class="bv-view" id="bv-view" aria-live="polite"></div>';
    hdr.after(main);
    const pop = doc.createElement('div');
    pop.className = 'bv-pop'; pop.id = 'bv-pop'; pop.hidden = true;
    pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', 'Data freshness');
    doc.body.appendChild(pop);
    const menu = doc.createElement('nav'); menu.id = 'bv-more-menu'; menu.className = 'bv-more-menu'; menu.hidden = true; menu.setAttribute('aria-label','More pages');
    menu.innerHTML = '<a href="#/macro">Macro</a><a href="#/research/overview">Research</a>'; doc.body.appendChild(menu);
    const more = hdr.querySelector('#bv-more');
    more.addEventListener('click', () => {menu.hidden=!menu.hidden; more.setAttribute('aria-expanded',String(!menu.hidden));});
    doc.addEventListener('click', e => {if (!more.contains(e.target) && !menu.contains(e.target)) {menu.hidden=true;more.setAttribute('aria-expanded','false');}});
    doc.addEventListener('keydown',e => {if(e.key==='Escape' && !menu.hidden){menu.hidden=true;more.setAttribute('aria-expanded','false');more.focus();}});
    hdr.querySelector('#bv-pill').addEventListener('click', e => { e.stopPropagation(); togglePop(); });
    hdr.querySelector('#bv-theme').addEventListener('click', () => setTheme(theme() === 'dark' ? 'light' : 'dark', true));
    doc.addEventListener('click', e => { if (!pop.hidden && !pop.contains(e.target)) togglePop(false); });
    doc.addEventListener('keydown', e => { if (e.key === 'Escape' && !pop.hidden) { togglePop(false); hdr.querySelector('#bv-pill').focus(); } });
    main.addEventListener('click', onMainClick);
    // phone keyboard: when the visual viewport shrinks a lot, hide the bottom tab bar so the focused field keeps the space
    const vv = root.visualViewport;
    if (vv) {
      const kb = () => doc.body.classList.toggle('bv-kb-open', root.innerWidth <= 820 && (root.innerHeight - vv.height > 140 || (doc.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(doc.activeElement.tagName) && vv.height < 560)));
      vv.addEventListener('resize', kb); doc.addEventListener('focusin', kb); doc.addEventListener('focusout', () => setTimeout(kb, 50));
    }
    let seatQueued = false;
    new MutationObserver(() => { if (seatQueued) return; seatQueued = true; setTimeout(() => { seatQueued = false; seatAskButtons(main); }, 0); }).observe(main, {childList: true, subtree: true});
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

  // ---- health pill + data-health sheet
  // Refresh receipt (data/refresh-status.json, written by the scheduled refresh). Absent means "not published yet", shown in the sheet.
  async function loadReceipt() {
    try {
      const r = await fetch('data/refresh-status.json', {cache: 'no-store'});
      if (!r.ok) { ST.receipt = null; ST.receiptErr = r.status === 404 ? 'No refresh receipt has been published with this build yet.' : 'Refresh receipt returned HTTP ' + r.status + '.'; return; }
      const d = await r.json();
      if (!d || d.schema !== 'smartoptions.refresh.v1') throw new Error('unsupported receipt schema');
      ST.receipt = d; ST.receiptErr = '';
    } catch (e) { ST.receipt = null; ST.receiptErr = 'Refresh receipt could not be read: ' + (e.message || e) + '.'; }
  }
  const RECEIPT_WORD = {ok: 'fresh', degraded: 'delayed', failed: 'stale', running: 'delayed'};
  const PILL_WORD = {live: 'Live', fresh: 'Current', closed: 'Closed', delayed: 'Delayed', stale: 'Stale', missing: 'Not available'};
  // worst of: on-screen prices, every brief dataset, the refresh receipt
  function healthRows(nowMs) {
    const L = live(), h = (ST.brief && ST.brief.health) || {}, rows = [];
    const lh = L ? L.health(nowMs) : null;
    if (lh) {
      const f = lh.feed, w = lh.worker;
      rows.push({label: 'Prices on this screen (' + (lh.coverage ? lh.coverage.watched : 0) + ' names)', asof: f.words.replace(/^[^,]*, /, ''), status: f.word === 'live' ? 'live' : f.word,
        cadence: w.enabled ? 'Every 20 seconds in market hours' : 'Shared file, checked every minute',
        provider: (f.providers || []).join('; ') || 'Not available',
        note: (w.enabled ? 'Fast path: ' + w.reason + '.' : w.reason + '.') + (w.error ? ' ' + w.error : '') + (f.missing ? ' ' + f.missing + ' of ' + f.of + ' names have no price.' : '') +
          (Object.keys(w.errors || {}).length ? ' ' + Object.entries(w.errors).slice(0, 3).map(([t, e]) => t + ': ' + e).join('; ') + '.' : '')});
      const fh = lh.fileHealth;
      const cv = lh.coverage || {};
      if (fh || lh.file.error) rows.push({label: 'Other prices (shared file, ' + (cv.others || 0) + ' names)', asof: cv.others_asof ? 'Most ' + cv.others_label : '',
        status: lh.file.error ? 'stale' : cv.others_word || 'missing', cadence: 'Scheduled about every 8 minutes in market hours; GitHub can delay runs',
        provider: fh && fh.provider_mix ? Object.keys(fh.provider_mix).filter(k => k !== 'missing').join('; ') : 'Not available',
        note: lh.file.error || ['Each row keeps its own time; a name refreshes when it is on screen.', fh && fh.line, L.snapshot().generated_at ? 'File built ' + fmtAsof(L.snapshot().generated_at) + '.' : ''].filter(Boolean).join(' ')});
    } else rows.push({label: 'Prices', status: 'missing', note: ST.quoteErr || 'Price engine not available.'});
    const groups = {};
    (h.sources || []).filter(s => s.id !== 'quotes' && s.id !== 'sam').forEach(s => {
      const g = /^macro_/.test(s.id) ? 'macro_obs' : /receipt/i.test(s.label || '') ? 'build' : s.id;
      (groups[g] = groups[g] || []).push(s);
    });
    const NAME = {macro_obs: n => 'Macro releases (' + n + ' groups)', build: n => 'Site build (' + n + ' steps)'};
    const CAD = {macro_obs: 'Daily, on release days', build: 'Daily build'};
    Object.keys(groups).forEach(g => {
      const xs = groups[g];
      const worst = xs.reduce((a, s) => ((RANK[String(s.status).toLowerCase()] ?? 3) > (RANK[String(a.status).toLowerCase()] ?? 3) ? s : a), xs[0]);
      const oldest = xs.reduce((a, s) => (isNum(s.age_hours) && (!isNum(a.age_hours) || s.age_hours > a.age_hours) ? s : a), xs[0]);
      rows.push({label: NAME[g] ? NAME[g](xs.length) : (xs[0].label || g), asof: fmtAsof(oldest.asof), age: oldest.age_hours, status: String(worst.status || 'missing').toLowerCase(),
        cadence: CAD[g] || 'Daily', provider: xs[0].provider || xs[0].source || '', note: worst.note || ''});
    });
    const rc = ST.receipt;
    rows.push(rc ? {label: 'Scheduled refresh', asof: fmtAsof(rc.finished_at || rc.attempted_at), status: RECEIPT_WORD[rc.status] || 'missing', cadence: 'Daily, GitHub Actions',
      provider: 'Refresh receipt', note: 'Last run ' + rc.status + '.' + Object.entries(rc.stages || {}).filter(([, v]) => v && v.status && !/^ok$/i.test(v.status)).map(([k, v]) => ' ' + k + ': ' + v.status + (v.error || v.note ? ' (' + (v.error || v.note) + ')' : '') + '.').join('')}
      : {label: 'Scheduled refresh', status: 'missing', cadence: 'Daily', provider: 'Refresh receipt', note: ST.receiptErr || 'Not available.'});
    return rows;
  }
  // other prices (not polled) differ in freshness from the on-screen set
  function priceScope(lh) {
    const c = lh && lh.coverage, f = lh && lh.feed;
    return c && f && f.word !== 'missing' && c.others && c.others_asof && c.others_word !== f.word ? c : null;
  }
  function pillState(nowMs) {
    const rows = healthRows(nowMs);
    const word = rows.reduce((w, r) => ((RANK[r.status] ?? 3) > (RANK[w] ?? 3) ? r.status : w), 'fresh');
    const prices = rows[0];
    return {rows, word, prices};
  }
  function renderPill() {
    const el = doc.getElementById('bv-pill'); if (!el) return;
    const now = Date.now(), L = live();
    const lh = L ? L.health(now) : null, st = pillState(now), f = lh ? lh.feed : null, sc = priceScope(lh);
    // a live subset must not read as the whole universe: name the on-screen scope and date the rest
    const lead = f ? (sc ? f.words.replace(', as of', ' on screen, as of') + ' · others ' + sc.others_label : f.words) : 'Prices not available';
    const worst = st.word, others = st.rows.slice(1).filter(r => (RANK[r.status] ?? 3) >= 2);
    el.querySelector('.bv-pill-t').textContent = lead + (others.length ? ' · ' + others.length + (others.length === 1 ? ' dataset needs attention' : ' datasets need attention') : '');
    const when = f ? f.words.replace(/^[^,]*, as of /, '').replace(/ ET$/, '') : '';
    const restWhen = sc ? sc.others_label.replace(/^as of /, '').replace(/ ET$/, '').split(',')[0] : '';
    el.querySelector('.bv-pill-s').textContent = !f ? 'Prices n/a' : sc ? (PILL_WORD[f.word] || f.word) + ' here · rest ' + restWhen :
      (PILL_WORD[f.word] || f.word) + (f.word === 'missing' ? '' : ' ' + (when.includes(',') ? when.split(',')[0] : when));
    el.dataset.st = ['live', 'fresh', 'closed'].includes(worst) ? 'good' : worst === 'delayed' ? 'mixed' : 'bad';
    el.dataset.fresh = f ? f.word : 'missing';
    el.title = 'Data health: ' + lead + '. Show details.';
    el.setAttribute('aria-label', 'Data health: ' + lead + (others.length ? '; ' + others.length + ' datasets need attention' : '') + '. Show details.');
    if (!doc.getElementById('bv-pop').hidden) renderPop();
  }
  function renderPop() {
    const pop = doc.getElementById('bv-pop');
    const h = (ST.brief && ST.brief.health) || {};
    const st = pillState(Date.now());
    const scr = h.screener || {asof: SCREENER_ASOF_FALLBACK, status: 'stale'};
    pop.innerHTML = `<div class="bv-sheet-grab" aria-hidden="true"></div><div class="bv-pop-hd"><h2>Data health</h2><button type="button" class="bv-x" aria-label="Close">&times;</button></div>
      ${ST.briefSrc && ST.briefSrc.indexOf('test/') === 0 ? '<p class="bv-sample">This page is showing sample data for layout checks, not today\'s figures.</p>' : ''}
      ${!ST.brief ? `<p class="bv-sample">Brief data not available: ${esc(ST.briefErr || 'not built yet')}.</p>` : ''}
      <ul class="bv-hl">${st.rows.map(r => `<li class="bv-hr"><div class="bv-hr-top"><b>${esc(r.label)}</b><span class="bv-fresh" data-fresh="${esc(r.status)}">${esc(r.status === 'delayed' && /^Prices/.test(r.label) ? 'delayed 15m' : r.status)}</span></div>
        <div class="bv-hr-meta"><span>${esc(r.asof || 'Time not available')}</span>${r.cadence ? `<span>${esc(r.cadence)}</span>` : ''}${r.provider ? `<span>${esc(r.provider)}</span>` : ''}</div>
        ${r.note ? `<p class="bv-hr-note">${esc(r.note)}</p>` : ''}</li>`).join('')}</ul>
      <details class="bv-scr"><summary>Historical score reference</summary>${chip(scr.status || 'stale', 'sm')}<p>${esc(screenerLabel('long'))}${scr.note ? ' ' + esc(scr.note) : ''}</p></details>
      <p class="bv-pop-foot">Live means a real-time price no more than one minute old. Delayed means the provider states a delay. Closed means the regular session has ended; the last print is shown with its time. Market hours are New York time; exchange holidays are not modelled.</p>`;
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
    // phones: bottom sheet (CSS); wider screens: anchored under the pill, fixed so it never scrolls away
    if (root.innerWidth <= 640) { pop.classList.add('is-sheet'); pop.style.width = pop.style.top = pop.style.left = ''; return; }
    pop.classList.remove('is-sheet');
    const r = pill.getBoundingClientRect();
    const w = Math.min(560, root.innerWidth - 24);
    pop.style.width = w + 'px';
    pop.style.top = (r.bottom + 8) + 'px';
    pop.style.left = Math.max(12, Math.min(root.innerWidth - w - 12, r.right - w)) + 'px';
  }
  function togglePop(force) {
    const pop = doc.getElementById('bv-pop'), pill = doc.getElementById('bv-pill');
    const open = force == null ? pop.hidden : force;
    pop.hidden = !open; pill.setAttribute('aria-expanded', String(open)); doc.body.classList.toggle('bv-sheet-open', open && root.innerWidth <= 640);
    if (open) { renderPop(); const x = pop.querySelector('.bv-x'); if (x) x.focus(); }
  }

  // ---- router
  function applyRoute(fromLoad) {
    const r = parseRoute(root.location.hash);
    const mountedCompany=doc.getElementById('bv-company');
    if(mountedCompany&&mountedCompany.__soCo&&(r.view!=='company'||r.ticker!==ST.route.ticker))mountedCompany.__soCo.destroy();
    ST.route = r;
    const menu = doc.getElementById('bv-more-menu'), more = doc.getElementById('bv-more');
    if (menu) menu.hidden=true;
    if (more) {more.setAttribute('aria-expanded','false');more.classList.toggle('is-current',r.view==='macro'||r.view==='research');}
    const research = r.view === 'research';
    doc.body.classList.toggle('bv-on', !research);
    doc.body.classList.toggle('bv-research', research);
    if (doc.getElementById('bv-research-bridge')) doc.getElementById('bv-research-bridge').hidden = !research;
    doc.querySelectorAll('.bv-nav a').forEach(a => { if (a.dataset.nav === r.view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    if (research) {
      if (!doc.getElementById('bv-research-bridge')) { const bridge = doc.createElement('p'); bridge.id = 'bv-research-bridge'; bridge.className = 'b-reason'; bridge.innerHTML = '<a href="#/brief">Back to the two-minute Brief</a> · Research exposes full source tables, optional historical references and modeled strategies. Start with a company, then expand the evidence you need.<details><summary>Terms used here</summary>IV: volatility inferred from option prices. RV: measured historical volatility. Beta: fitted sensitivity to a market move. OLS: a least-squares statistical fit. Residual: the return left unexplained by that fit. Basis point: 0.01 percentage point. These describe inputs and associations, not validated forecasts.</details>'; doc.getElementById('hdr').after(bridge); }
      if (!r.legacy) { try { root.history.replaceState(null, '', legacyHash(r)); } catch (e) { /* file:// may refuse; Edge reads the tab below */ } }
      if (!fromLoad && r.tab) openEdgeTab(r.tab);
      doc.title = 'Research | SmartOptions Brief';
      watchOnScreen();
      return;
    }
    const view = doc.getElementById('bv-view');
    if (ST.receipt === undefined) loadReceipt().then(renderPill);
    if (r.view === 'brief') { renderBrief(view); doc.title = 'Brief | SmartOptions'; }
    else if (r.view === 'macro') { renderMacroPage(view); doc.title = 'Macro | SmartOptions Brief'; }
    else if (r.view === 'company') { if (r.ticker) renderCompany(view, r.ticker); else renderCompanies(view); doc.title = (r.ticker ? r.ticker + ' | ' : 'Companies | ') + 'SmartOptions Brief'; }
    else if (r.view === 'my-dash') { mountPage(view,'SmartOptionsMyDashboard','My Dash'); }
    else if (r.view === 'flows') { mountPage(view,'MoneyFlow','Capital & news'); }
    if (!fromLoad) root.scrollTo(0, 0);
    watchOnScreen();
  }
  function mountPage(view,name,label) {
    const module = root[name] || root.SO2 && root.SO2[name];
    doc.title=label+' | SmartOptions Brief';
    if (module && typeof module.mount==='function') {
      try { module.mount(view); } catch(e) {console.error('[brief] '+label+' failed',e);view.innerHTML=`<div class="bv-wrap"><section class="b-card"><h1 class="b-h1">${esc(label)}</h1><p role="alert">Not available: ${esc(e.message || e)}</p></section></div>`;}
    } else view.innerHTML=`<div class="bv-wrap"><section class="b-card"><h1 class="b-h1">${esc(label)}</h1><p role="status">Not available: this page module did not load.</p><a class="b-link-btn" href="#/brief">Return to Brief</a></section></div>`;
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
    const more = e.target.closest('[data-risk-more]');
    if (more) {
      const open = more.getAttribute('aria-expanded') !== 'true';
      more.closest('section').querySelectorAll('.b-risk-more').forEach(n => { n.hidden = !open; });
      more.setAttribute('aria-expanded', String(open));
      more.textContent = open ? 'Show fewer' : more.closest('section').querySelectorAll('.b-risk-more').length + ' more';
      return;
    }
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

  // Animate the figure's arrival, preserving the exact measured value at every frame.
  function countUp(scope) {
    if (reduced()) return;
    scope.querySelectorAll('[data-count]').forEach(el => {
      if (el.animate) el.animate([{opacity: 0.4, transform: 'translateY(4px)'}, {opacity: 1, transform: 'translateY(0)'}], {duration: 220, easing: 'ease-out'});
    });
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
      ${drivers([{status: a.status, metrics: a.metrics}])}<div class="b-tile-ft">${f.btn}</div>${f.box}</article>`;
  }
  function backdropRows(bd) {
    return `<ul class="b-dirs">${['growth', 'inflation', 'policy'].map(k => {
      const d = (bd && bd[k]) || {}; const dir = d.available === false ? null : ['up', 'down', 'flat'].includes(d.direction) ? d.direction : null;
      return `<li><span class="b-dir-k">${cap(k)}</span><span class="b-dir-a${dir ? ' d-' + dir : ''}" aria-hidden="true">${dir ? ARROW[dir] : '&#8211;'}</span><span class="b-dir-w">${dir ? DIRWORD[dir] : 'not available'}</span><span class="b-dir-l">${esc(d.line || '')}</span></li>`;
    }).join('')}</ul>`;
  }
  function macroStrip(m) {
    m = m || {};
    const bd = m.backdrop || {};
    const bdMetrics = [].concat(...['growth', 'inflation', 'policy'].map(k => (bd[k] && bd[k].metrics) ||
      ((m.detail || []).find(d => d.group === k) || {}).metrics || []), bd.metrics || []);
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
      <div class="b-sec-hd"><h2 id="h-pulse">Market pulse</h2>${chip(p.status || 'unavailable')}${impact() ? impact().keyButton() : ''}<button type="button" class="b-btn b-sm" data-flipall aria-pressed="false">Show numbers</button><span class="b-ask-slot"></span></div>
      ${p.headline ? `<p class="b-lead">${esc(p.headline)}</p>` : ''}<p class="b-reason">Price trend describes recent trading; macro backdrop tracks slower economic releases; risk tracks volatility, credit and upcoming events. Supportive prices can coexist with adverse macro inputs and elevated risk.</p>
      <div class="b-cols">
        <div><h3>What changed</h3>${bulletList(p.changed, 'no change measured since the previous session')}</div>
        <div><h3>Supports</h3>${bulletList(p.supports, 'no supporting reading measured')}</div>
        <div><h3>Challenges</h3>${bulletList(p.challenges, 'no challenging reading measured')}</div>
      </div>${drivers([...(p.supports || []), ...(p.challenges || [])])}</section>`;
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
    const shortlist = new Set((ST.brief && ST.brief.shortlist || []).map(n => n.t));
    const w = r => impact() ? impact().riskBand(r, watch, shortlist) : r.watchlist || (r.tickers || []).some(t => watch.has(t)) || r.importance === 3 ? 0 : 1;
    return (risks || []).filter(r => !today || !/^\d{4}-\d{2}-\d{2}/.test(r.when_et || '') || String(r.when_et).slice(0, 10) >= today).sort((a, b) => w(a) - w(b) || (Date.parse(a.when_et) || 0) - (Date.parse(b.when_et) || 0));
  }
  function risksSection(risks) {
    const watch = watchSet();
    const xs = sortRisks(risks, watch, Date.now());
    const shown = xs.slice(0, 6), usedReasons = new Set();
    const core = root.SO2 && root.SO2.D && root.SO2.D();
    const context = {totalCap: (core && core.rows || []).reduce((s, r) => s + (r.sp500_member === true && isNum(r.mcap) ? r.mcap : 0), 0)};
    const explain = r => impact() ? impact().riskExplanation(r, (core && core.rows || []).find(n => (r.tickers || []).includes(n.t)), usedReasons) : {text: r.why, metrics: r.metrics};
    const body = !shown.length ? '<p class="b-na">Not available: no scheduled releases or earnings in this brief.</p>' :
      `<ol class="b-risks">${xs.map((r, ix) => {
        const e = explain(r), w = whenWords(r.when_et), imp = [1, 2, 3].includes(r.importance) ? r.importance : 1, f = flip(e.metrics);
        const iw = imp === 3 ? 'High importance' : imp === 2 ? 'Medium importance' : 'Low importance';
        const mine = r.watchlist || (r.tickers || []).some(t => watch.has(t));
        return `<li class="b-risk${ix >= 6 ? ' b-risk-more' : ''}"${ix >= 6 ? ' hidden' : ''}><div class="b-risk-when"><b>${esc(w.d)}</b><span>${esc(w.h)}</span></div>
          <div class="b-risk-what"><div class="b-risk-t"><span class="b-kind k-${r.kind === 'earnings' ? 'e' : 'm'}">${r.kind === 'earnings' ? 'Earnings' : 'Macro'}</span>${esc(r.title)}${mine ? '<span class="b-mine">Watchlist</span>' : ''}</div>
          <div class="b-risk-why">${esc(e.text || '')}${(r.tickers || []).length ? ' ' + r.tickers.slice(0, 4).map(t => `<a class="b-tk" href="#/company/${esc(t)}">${esc(t)}</a>`).join(' ') : ''}</div>${f.box}</div>
          <div class="b-risk-r"><span class="b-imp" role="img" aria-label="${iw}" title="${iw}">${[1, 2, 3].map(i => `<i class="${i <= imp ? 'on' : ''}"></i>`).join('')}</span>${f.btn}</div></li>`;
      }).join('')}</ol>${xs.length > 6 ? `<button type="button" class="b-btn b-more" data-risk-more aria-expanded="false">${xs.length - 6} more</button>` : ''}`;
    return `<section class="b-sec b-card b-enter" aria-labelledby="h-risks"><div class="b-sec-hd"><h2 id="h-risks">Upcoming risks</h2><span class="b-count">${xs.length ? 'Next ' + shown.length + ' of ' + xs.length : ''}</span><span class="b-ask-slot"></span></div>${body}</section>`;
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
    const cFig = isNum(c.top10_share_pct) ? `<div class="b-key"><span class="b-key-v" data-count="${c.top10_share_pct}" data-fmt='{"unit":"%"}'>${esc(fmtValue({value: c.top10_share_pct, unit: '%'}))}</span><span class="b-key-l">Top 10 share of covered market cap</span>${meter(c.top10_share_pct, 100, '')}</div>` : '';
    const rl = (xs, cls) => (xs || []).slice(0, 3).map(s => `<span class="b-rot ${cls}">${esc(s.sector)} ${isNum(s.ret_20d_pct) ? (s.ret_20d_pct > 0 ? '+' : '') + s.ret_20d_pct.toFixed(1) + '%' : ''}</span>`).join('');
    const rFig = (ro.leaders || []).length || (ro.laggards || []).length ? `<div class="b-rots"><div><span class="b-rot-k">Leading, 20 days</span>${rl(ro.leaders, 'up')}</div><div><span class="b-rot-k">Lagging, 20 days</span>${rl(ro.laggards, 'dn')}</div></div>` : '';
    return `<section class="b-sec b-card b-enter" aria-labelledby="h-pos"><div class="b-sec-hd"><h2 id="h-pos">S&amp;P positioning</h2>
      <div class="b-seg" role="group" aria-label="Period">${['1D', '1W', '1M'].map(p => `<button type="button" data-period="${p}" aria-pressed="${p === ST.period}">${p}</button>`).join('')}</div><span class="b-ask-slot"></span></div>
      <div class="b-pos"><div class="b-hm" id="bv-heatmap"></div>
      <div class="b-verdicts">${verdict('Breadth', pos.breadth)}${verdict('Concentration', c, cFig)}${verdict('Rotation', ro, rFig)}</div></div>
      <details class="b-shock"><summary>Sector shock sensitivity · historical association</summary><div id="so-shock-grid"></div></details></section>`;
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
  // live cell: the Live engine fills and refreshes it; the server value is the first paint
  function liveCell(t, f, first, cls) { return `<span class="lv-${f}${cls ? ' ' + cls : ''}" data-live="${esc(t)}" data-live-f="${f}">${esc(first)}</span>`; }
  function coreRows() { const A = root.SO2; const d = A && A.D && A.D(); return d && d.rows || []; }
  function rowOf(t) { return coreRows().find(r => r.t === t) || null; }
  // one compact row per name: identity, live price strip, score gauge, first reason, caution, depth behind one flip
  function shortlistSection(list) {
    const xs = (list || []).slice(0, 8);
    const bases = [...new Set(xs.map(n => n.score_basis || ''))];
    const shared = bases.length === 1 && bases[0] ? bases[0] : '';
    const L = live();
    const body = !xs.length ? '<p class="b-na">Not available: no names passed the shortlist rules in this brief.</p>' :
      `<div class="b-names">${xs.map(n => {
        const st = n.status || {}, why = (n.why || []).filter(Boolean).slice(0, 3);
        const dims = DIMS.filter(([k]) => st[k]).map(([k, l]) => `<span class="b-dim t-${tone(st[k])}" title="${esc(l + ': ' + st[k])}"><i aria-hidden="true"></i>${esc(l)}<span class="b-vh"> ${esc(st[k])}</span></span>`).join('');
        const row = rowOf(n.t);
        const d = L ? L.derive(row, L.get(n.t)) : {};
        const counter = impact() ? impact().caution(n, row) : n.counter;
        const allM = [].concat(...why.map(b => b.metrics || []), (counter && counter.metrics) || []);
        const f = flip(allM);
        const more = why.slice(1).map(b => `<li>${esc(b.text)}</li>`).join('');
        const lead = why[0] ? esc(why[0].text) : '<span class="b-na">Not available: no reasons recorded.</span>';
        const box = f.box.replace('<div class="b-flipin">', `<div class="b-flipin">${more ? `<ul class="b-more-why">${more}</ul>` : ''}`);
        const fmt = L ? L : {fmtPx: v => String(v), fmtPct: v => String(v)};
        const px = row || d.price != null ? `<div class="b-px" aria-label="${esc(n.t)} price">
            ${liveCell(n.t, 'price', fmt.fmtPx(d.price))}${liveCell(n.t, 'chg', fmt.fmtPct(d.chg_pct), 'b-chg')}
            ${liveCell(n.t, 'fresh', 'closed', 'bv-fresh')}<span class="b-px-asof">${liveCell(n.t, 'asof', '')}</span></div>
          <dl class="b-facts">
            <div><dt>P/E now</dt><dd>${liveCell(n.t, 'pe', isNum(d.pe) ? d.pe.toFixed(1) : 'Not available')}</dd></div>
            <div><dt>52-week range</dt><dd><span class="b-rng" data-live="${esc(n.t)}" data-live-f="range"><span class="b-rng-t"><i style="left:${isNum(d.range_pct) ? d.range_pct.toFixed(1) : 50}%"></i></span><b>${isNum(d.range_pct) ? Math.round(d.range_pct) + '% of range' : 'Not available'}</b></span></dd></div>
            <div><dt>From high</dt><dd>${liveCell(n.t, 'hi', isNum(d.from_hi_pct) ? fmt.fmtPct(d.from_hi_pct, 1) : 'Not available')}</dd></div>
          </dl>` : '<p class="b-na">Price not available: this name is not in the covered universe file.</p>';
        return `<article class="b-name b-card b-enter" data-t="${esc(n.t)}"><div class="b-name-hd"><div class="b-name-id"><h3><a href="#/company/${esc(n.t)}">${esc(n.t)}</a></h3><div class="b-name-sub">${esc(n.name || n.t)}${n.sector ? ' · ' + esc(n.sector) : ''}</div></div>${gauge(n.score, n.score_basis)}</div>
          ${px}
          <p class="b-why"><span class="b-mark tn-good" aria-label="For">&#9650;</span><span>${lead}${why.length > 1 ? ` <span class="b-plus">+${why.length - 1} more</span>` : ''}</span></p>
          <p class="b-against"><span class="b-mark tn-bad" aria-label="Against">&#9660;</span><span>${counter && counter.text ? esc(counter.text) : '<span class="b-na">Not available: no counter-argument recorded.</span>'}</span></p>
          ${dims ? `<div class="b-dims">${dims}</div>` : ''}
          ${box}
          <div class="b-name-ft"><a class="b-btn b-open" href="#/company/${esc(n.t)}">Open ${esc(n.t)}</a>${f.btn.replace('<span class="b-flip-on">Numbers</span>', '<span class="b-flip-on">Details</span>')}</div></article>`;
      }).join('')}</div>`;
    const asof = ST.brief && ST.brief.asof_session ? shortDate(ST.brief.asof_session, false) : 'the last build';
    return `<section class="b-sec" aria-labelledby="h-short"><div class="b-sec-hd b-sec-hd-out"><h2 id="h-short">Research shortlist</h2><span class="b-count">${xs.length ? xs.length + ' names' : ''}</span><span class="b-ask-slot"></span></div>
      <p class="b-basis b-basis-all">${shared ? 'Score 0 to 100: ' + esc(shared) + ' ' : ''}Scores use the ${esc(asof)} close; price, P/E and range update with each new price.</p>${body}</section>`;
  }
  // core.json (company rows) arrives after the brief; redraw only the shortlist so open panels elsewhere stay open
  function refreshShortlist() {
    const h = doc.getElementById('h-short'), sec = h && h.closest('section');
    if (!sec || !ST.brief) return;
    const wrap = doc.createElement('div'); wrap.innerHTML = shortlistSection(ST.brief.shortlist);
    const next = wrap.firstElementChild; next.querySelectorAll('.b-enter').forEach(el => { el.style.animation = 'none'; });
    sec.replaceWith(next);
    if (live()) live().paint(next, null);
  }
  // ---- live "right now" strip: S&P 500 and equal weight, recomputed on every quote
  function spyAverages() {
    const ms = [].concat(...['changed', 'supports', 'challenges'].map(k => (ST.brief && ST.brief.pulse && ST.brief.pulse[k] || []).map(b => b.metrics || [])).flat());
    const find = re => (ms.find(m => re.test(m.label || '') && isNum(m.value)) || {}).value;
    return {sma50: find(/SPY 50-session average/i), sma200: find(/SPY 200-session average/i)};
  }
  function nowLines() {
    const L = live(); if (!L) return [];
    const spy = L.get('SPY'), rsp = L.get('RSP'), avg = spyAverages(), out = [];
    if (spy && isNum(spy.price) && isNum(avg.sma50) && isNum(avg.sma200)) {
      const a50 = 100 * (spy.price / avg.sma50 - 1), a200 = 100 * (spy.price / avg.sma200 - 1);
      const where = a50 >= 0 && a200 >= 0 ? 'above both' : a50 < 0 && a200 < 0 ? 'below both' : a50 < 0 ? 'below its 50-session but above its 200-session' : 'above its 50-session but below its 200-session';
      out.push({tone: a50 >= 0 && a200 >= 0 ? 'good' : a50 < 0 && a200 < 0 ? 'bad' : 'neutral',
        text: `S&P 500 (SPY) is ${where} average${/both/.test(where) ? 's' : ''}: ${L.fmtPct(a50, 1)} vs 50-session, ${L.fmtPct(a200, 1)} vs 200-session.`,
        why: 'Price above its averages means the trend is still up; below means buyers have stepped back.'});
    }
    const sc = spy && (isNum(spy.chg_pct) ? spy.chg_pct : spy.change_pct), rc = rsp && (isNum(rsp.chg_pct) ? rsp.chg_pct : rsp.change_pct);
    if (isNum(sc) && isNum(rc)) {
      const gap = rc - sc;
      out.push({tone: Math.abs(gap) < 0.1 ? 'neutral' : gap > 0 ? 'good' : 'bad',
        text: Math.abs(gap) < 0.1 ? `Equal weight and the S&P 500 are moving together today (${L.fmtPct(rc)} vs ${L.fmtPct(sc)}).` :
          `Equal weight is ${gap > 0 ? 'ahead of' : 'behind'} the S&P 500 by ${Math.abs(gap).toFixed(2)} points today.`,
        why: gap > 0 ? 'The average stock is doing better than the giants, so the move is broad.' : Math.abs(gap) < 0.1 ? 'The typical stock and the largest names are moving together.' : 'A few large names carry the index while the average stock trails.'});
    }
    return out;
  }
  function nowStrip() {
    const L = live();
    const tick = (t, label) => {
      const q = L && L.get(t);
      return `<div class="b-tick"><span class="b-tick-k">${esc(label)}</span>${liveCell(t, 'price', q ? L.fmtPx(q.price) : 'Not available', 'b-tick-v')}${liveCell(t, 'chg', q ? L.fmtPct(isNum(q.chg_pct) ? q.chg_pct : q.change_pct) : '', 'b-chg')}${liveCell(t, 'fresh', q ? q.freshness_label : 'missing', 'bv-fresh')}<span class="b-tick-asof">${liveCell(t, 'asof', q ? q.asof_label : '')}</span></div>`;
    };
    const lines = nowLines();
    return `<section class="b-sec b-now b-card b-enter" aria-labelledby="h-now"><div class="b-sec-hd"><h2 id="h-now">Right now</h2><span class="b-count">Recomputed on every price</span></div>
      <div class="b-ticks">${tick('SPY', 'S&P 500 (SPY)')}${tick('RSP', 'Equal weight (RSP)')}</div>
      <ul class="b-buls b-now-l" id="bv-now-lines">${lines.length ? lines.map(nowLine).join('') : '<li class="b-na">Not available: index prices have not arrived yet.</li>'}</ul></section>`;
  }
  function nowLine(b) {
    const mark = b.tone === 'good' ? '&#9650;' : b.tone === 'bad' ? '&#9660;' : '&#9679;';
    return `<li class="b-bul tn-${b.tone}"><div class="b-bul-row"><span class="b-mark" aria-hidden="true">${mark}</span><span class="b-txt">${esc(b.text)}<span class="b-reason">${esc(b.why)}</span></span></div></li>`;
  }
  // called by the Live subscription: numbers are already repainted by data-live; refresh the derived sentences
  function liveBrief(changed) {
    if (!changed || !changed.some(t => t === 'SPY' || t === 'RSP')) return;
    const ul = doc.getElementById('bv-now-lines'); if (!ul) return;
    const lines = nowLines();
    const html = lines.length ? lines.map(nowLine).join('') : '<li class="b-na">Not available: index prices have not arrived yet.</li>';
    if (ul.innerHTML !== html) { ul.innerHTML = html; if (!reduced() && ul.animate) ul.animate([{opacity: 0.55}, {opacity: 1}], {duration: 200, easing: 'ease-out'}); }
  }
  // ---- mounts owned by other lanes: shock grid (QUANT), money summary (MONEY)
  function mountOptional() {
    const shock = doc.getElementById('so-shock-grid');
    if (shock) {
      const S = root.SO2 && root.SO2.Shocks || root.SmartOptionsShocks;
      if (S && typeof S.renderGrid === 'function') { try { S.renderGrid(shock); } catch (e) { console.error('[brief] shock grid failed', e); shock.innerHTML = `<p class="b-na">Not available: the shock grid failed to draw (${esc(e.message || e)}).</p>`; } }
      else shock.innerHTML = '<p class="b-na">Not available: the sector shock grid is not part of this build yet.</p>';
    }
    const money = doc.getElementById('so-money-summary');
    if (money) {
      const M = root.SO2 && root.SO2.MoneyFlow || root.MoneyFlow;
      if (M && typeof M.renderSummary === 'function') { try { M.renderSummary(money); } catch (e) { console.error('[brief] money summary failed', e); money.innerHTML = `<p class="b-na">Not available: ${esc(e.message || e)}.</p>`; } }
      else moneyFallback(money);
    }
  }
  // until the money lane ships its summary: the three newest dated items from the tracker file, each with its one-line reason
  async function moneyFallback(el) {
    try {
      const d = await getJSON('data/money-flow.json');
      const xs = (d.news || []).filter(n => n && n.headline && isFinite(Date.parse(n.published_at))).sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at)).slice(0, 3);
      if (!el.isConnected) return;
      el.innerHTML = xs.length ? `<ul class="b-mf">${xs.map(n => `<li><div class="b-mf-top"><span class="b-mf-d">${esc(fmtAsof(n.published_at))}</span>${n.category ? `<span class="b-kind">${esc(n.category)}</span>` : ''}</div>
        <a href="${safeURL(n.url) || '#/flows'}"${safeURL(n.url) ? ' target="_blank" rel="noopener"' : ''}>${esc(n.headline)}</a><p class="b-reason">${esc(n.reason || '')}${n.source ? ' Source: ' + esc(n.source) + '.' : ''}</p></li>`).join('')}</ul>`
        : '<p class="b-na">Not available: the tracker file has no dated items.</p>';
    } catch (e) { if (el.isConnected) el.innerHTML = `<p class="b-na">Not available: the capital and news file could not be read (${esc(e.message || e)}).</p>`; }
  }
  // chat-popup.js appends its "Ask about this" button to each section; move it into the header slot so it never overlaps an edge
  function seatAskButtons(scope) {
    (scope || doc).querySelectorAll('.b-sec > .cp-context, .b-card > .cp-context').forEach(btn => {
      const slot = btn.parentElement.querySelector('.b-ask-slot');
      if (slot && !slot.contains(btn)) { btn.setAttribute('aria-label', btn.textContent); btn.title = btn.textContent; btn.textContent = 'Ask'; slot.appendChild(btn); }
    });
  }
  function renderBrief(view) {
    const b = ST.brief;
    if (!b) return missingPage(view);
    const html = `<div class="bv-wrap b-v3">${notice()}
      <div class="b-title b-enter"><h1 class="b-h1">Market brief</h1><p class="b-date">${esc(sessionWords(b))}</p></div>
      ${nowStrip()}
      ${pulseSection(b.pulse)}
      <section class="b-sec b-macro" aria-labelledby="h-macro"><h2 id="h-macro" class="b-vh">Macro assessment</h2>${macroStrip(b.macro)}
        <button type="button" class="b-detail-btn b-enter" data-detail aria-expanded="${ST.detailOpen}" aria-controls="bv-detail"><span class="bd-lbl">${ST.detailOpen ? 'Hide detailed macro observations' : 'Detailed macro observations'}</span><span class="bd-car" aria-hidden="true">&#9662;</span></button>
        <div class="b-flipbox${ST.detailOpen ? ' open' : ''}" id="bv-detail"><div><div class="b-card b-detail">${detailList(b.macro)}<p class="b-more"><a href="#/research/macro">Open the full macro grid</a></p></div></div></div>
      </section>
      <div class="b-pair">${risksSection(b.risks)}
        <section class="b-sec b-card b-enter b-money" aria-labelledby="h-money"><div class="b-sec-hd"><h2 id="h-money">Where money is moving</h2><span class="b-ask-slot"></span></div>
          <div id="so-money-summary"></div><p class="b-more"><a href="#/flows">Open the capital and news tracker</a></p></section></div>
      ${positioningSection(b.positioning)}
      ${shortlistSection(b.shortlist)}
      <details class="b-sec b-card b-rel b-enter" id="bv-rel"${ST.relOpen ? ' open' : ''}><summary><h2>Macro and company links</h2><span class="b-count">Measured historical associations, with counterarguments</span></summary><div class="in-host" id="bv-intelligence"></div></details>
      <footer class="b-foot">Research tool, not investment advice. Each input carries its observation date. Brief built ${esc(fmtAsof(typeof b.generated_at === 'string' ? b.generated_at : (b.generated_at && (b.generated_at.equities || b.generated_at.macro)) || ''))}.</footer>
      </div>`;
    paint(view, html, 'brief');
    const rel = doc.getElementById('bv-rel');
    const drawRel = () => { if (rel.open && root.SmartOptionsIntelligence && !rel.dataset.drawn) { rel.dataset.drawn = '1'; root.SmartOptionsIntelligence.renderMarket(doc.getElementById('bv-intelligence')); } };
    rel.addEventListener('toggle', () => { ST.relOpen = rel.open; drawRel(); });
    drawRel();
    mountHeatmap();
    mountOptional();
    if (!(root.SO2 && root.SO2.Shocks) && doc.readyState !== 'complete') root.addEventListener('load', mountOptional, {once: true});   // modules loaded after this file
    if (live()) live().paint(view, null);
    seatAskButtons(view);
  }
  function renderMacroPage(view) {
    const b = ST.brief;
    if (!b) return missingPage(view);
    paint(view, `<div class="bv-wrap">${notice()}<div class="b-title b-enter"><h1 class="b-h1">Macro</h1><p class="b-date">${esc(sessionWords(b))}</p></div>
      <section class="b-sec b-macro">${macroStrip(b.macro)}</section>
      <section class="b-sec b-card b-enter" aria-labelledby="h-obs"><div class="b-sec-hd"><h2 id="h-obs">Detailed observations</h2><span class="b-ask-slot"></span><button type="button" class="b-btn b-sm" data-flipall aria-pressed="false">Show numbers</button></div>${detailList(b.macro)}
      <p class="b-more"><a href="#/research/macro">Open the full macro grid and calendar</a></p></section>
      <section class="b-sec" aria-label="Conditional shock scenarios"><div id="so-shock-scenario"></div></section>
      ${risksSection(b.risks)}</div>`, 'macro');
    const shocks = root.SO2 && root.SO2.Shocks || root.SmartOptionsShocks;
    if (shocks && shocks.renderScenario) shocks.renderScenario(doc.getElementById('so-shock-scenario'));
  }
  function renderCompany(view, t) {
    const previous=doc.getElementById('bv-company');
    const open=previous&&previous.dataset.ticker===t?[...previous.querySelectorAll('.co-card[open]')].map(el=>el.id):[];
    if(previous&&previous.__soCo)previous.__soCo.destroy();
    view.innerHTML = `<div class="bv-wrap"><p class="b-crumb"><a href="#/company">Companies</a> / ${esc(t)}</p><div id="bv-company" class="bv-company"><p class="b-na">Loading ${esc(t)}.</p></div></div>`;
    const el = doc.getElementById('bv-company');
    let n = 0;
    const go = () => {
      if (ST.route.view !== 'company' || ST.route.ticker !== t) return;
      const C = root.SmartOptionsCompany;
      if (C && typeof C.mount === 'function') { try { const handle=C.mount(el, t);handle.ready.then(()=>{if(el.isConnected)open.forEach(id=>{const node=doc.getElementById(id);if(node)node.open=true;});}).catch(e=>console.error('[brief] company ready failed',e)); } catch (e) { console.error('[brief] company mount failed', e); el.innerHTML = `<p class="b-na">Not available: the company view failed to load (${esc(e.message || e)}).</p>`; } return; }
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
  async function checkRevision() {
    if (doc.visibilityState !== 'visible' || ST.briefSrc !== 'data/brief.json') return;
    try {
      const next = await getJSON('data/brief.json');
      const revision = x => JSON.stringify(x && [x.asof_session,x.generated_at]);
      const core = root.SO2 && root.SO2.D && root.SO2.D(), coreRevision = core && core.exported_at;
      const changed = revision(next)!==revision(ST.brief) || ST.coreRevision && coreRevision && coreRevision!==ST.coreRevision;
      if(!ST.coreRevision) ST.coreRevision=coreRevision;
      if(changed) {
        ST.nextBrief=next;
        const banner=doc.getElementById('bv-update-banner');
        banner.hidden=false;banner.innerHTML='<span>A newer data snapshot is available. Your current view retains its dates.</span><button type="button" class="b-btn" data-load-latest>Load latest</button>';
        banner.querySelector('button').onclick=()=>{
          ST.brief=ST.nextBrief;ST.nextBrief=null;ST.coreRevision=coreRevision;banner.hidden=true;
          if(root.SmartOptionsIntelligence) root.SmartOptionsIntelligence.load({refresh:true}).then(()=>applyRoute(true));
          else applyRoute(true);
          renderPill();if(root.CustomEvent) root.dispatchEvent(new root.CustomEvent('so:data-update',{detail:{brief:ST.brief,coreRevision}}));
        };
      }
    } catch(e) { console.warn('[brief] snapshot check failed; retaining current view',e); }
  }
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
      // the research desk has no health sheet; the receipt is read only where the pill and sheet are shown
      Promise.all([loadBrief(), r0.view === 'research' ? null : loadReceipt()]).then(() => { applyRoute(true); startLive(); renderPill(); });
      root.addEventListener('hashchange', () => applyRoute(false));
      setInterval(() => { if (doc.visibilityState === 'visible' && ST.route.view !== 'research') loadReceipt().then(renderPill); }, 5 * 60 * 1000);
      setInterval(checkRevision,5*60*1000);

      doc.addEventListener('visibilitychange',()=>{if(doc.visibilityState==='visible')checkRevision();});
      // once the Edge desk is ready: sync theme, refresh the company list
      let n = 0; const w = setInterval(() => { if (root.SO2_ready) { clearInterval(w); setTheme(theme(), false); if(root.SmartOptionsIntelligence) root.SO2.Intelligence=root.SmartOptionsIntelligence;ST.coreRevision=root.SO2.D().exported_at; if (ST.route.view === 'company' && !ST.route.ticker) applyRoute(true); if (ST.route.view === 'brief') refreshShortlist(); } else if (++n > 300) clearInterval(w); }, 100);
    };
    if (doc.body) go(); else doc.addEventListener('DOMContentLoaded', go);
  }

  return {parseRoute, legacyHash, routeHash, tone, ageWords, shortDate, screenerLabel, setScreener, pillText, priceFreshness, fmtValue, sortRisks, nyClock,mergeQuotes,
    isResearch, data: () => ST.brief, dataSource: () => ST.briefSrc, chip: w => chip(w), metricRows, esc, SCREENER_ASOF_FALLBACK, _start: start};
});
