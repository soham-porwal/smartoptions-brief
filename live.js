/* SmartOptions Brief: live quote engine (window.SO2.Live). Lane UI1.
   One place owns prices in the browser. It polls the Worker /quotes fast path for the tickers on screen
   (batched, budgeted, paused when the tab is hidden or the market is closed), falls back to data/quotes.json,
   keeps the newest observation per symbol, and tells subscribers which symbols changed so every
   quote-dependent number recomputes at once. Freshness words follow docs/BRIEF-CONTRACT.md:
   live (real-time feed, observation at most 1 minute old), delayed 15m, closed, stale, missing.
   Pure helpers are exported for node tests; the DOM part runs only in a browser. */
'use strict';
(function (root, factory) {
  const L = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = L;
  // other modules treat window.SO2 as "the research desk has loaded", so never create it here; app.js attaches SO2.Live
  if (root.SO2) root.SO2.Live = L;
  root.SmartOptionsLive = L;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {

  const ALLOWED_ORIGINS = ['https://soham-porwal.github.io', 'https://samsej.github.io'];   // Worker allow-list (chat-proxy/worker.js)
  const MAX_BATCH = 12;            // Worker accepts 1 to 12 symbols per request
  const OPEN_POLL_MS = 20000;      // Worker caches 30 s; 20 s keeps observations under a minute without extra provider calls
  const FILE_POLL_MS = 60000;
  const SYMBOL = /^[A-Z][A-Z0-9.-]{0,14}$/;
  const isNum = v => typeof v === 'number' && isFinite(v);

  /* ------------------------------------------------------------ pure helpers */
  // New York regular session, weekdays 9:30-16:00. Exchange holidays are not modelled; old timestamps stay visible.
  function marketClock(nowMs) {
    const parts = {};
    try {
      new Intl.DateTimeFormat('en-US', {timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false})
        .formatToParts(new Date(nowMs)).forEach(p => { parts[p.type] = p.value; });
    } catch (e) { return {open: false, known: false}; }
    const mins = (+parts.hour % 24) * 60 + (+parts.minute);
    const weekday = !['Sat', 'Sun'].includes(parts.weekday);
    return {open: weekday && mins >= 570 && mins < 960, known: true, weekday, mins};
  }
  function obsMs(q) { const t = Date.parse(q && (q.asof_utc || q.ts) || ''); return isFinite(t) ? t : null; }
  // "as of 3:42 PM ET"; adds the date when the observation is not from today in New York
  function etLabel(iso, nowMs) {
    const t = Date.parse(iso || '');
    if (!isFinite(t)) return 'time not available';
    try {
      const day = x => new Date(x).toLocaleDateString('en-CA', {timeZone: 'America/New_York'});
      const hm = new Date(t).toLocaleTimeString('en-US', {timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit'});
      if (nowMs != null && day(t) !== day(nowMs)) return 'as of ' + new Date(t).toLocaleDateString('en-US', {timeZone: 'America/New_York', month: 'short', day: 'numeric'}) + ', ' + hm + ' ET';
      return 'as of ' + hm + ' ET';
    } catch (e) { return 'as of ' + new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; }
  }
  // Freshness of one quote. Never "live" for a delayed provider, never "live" for an old observation.
  function classify(q, nowMs, clock) {
    if (!q || !isNum(q.price) || q.price <= 0) return {word: 'missing', label: 'Not available', note: (q && (q.reason || q.error)) || 'No price observation'};
    const t = obsMs(q);
    if (t == null || t > nowMs + 60000) return {word: 'stale', label: 'stale', note: 'Observation time not available'};
    const ageMin = Math.max(0, (nowMs - t) / 60000);
    const delay = isNum(q.delay_minutes) ? q.delay_minutes : /delay/i.test(q.provider || '') ? 15 : null;
    clock = clock || marketClock(nowMs);
    if (!clock.open) {
      // the session is over: the last print is the closing reference until it is older than a long weekend
      return ageMin <= 80 * 60 ? {word: 'closed', label: 'closed', ageMin} : {word: 'stale', label: 'stale', ageMin};
    }
    if (delay === 0 && ageMin <= 1) return {word: 'live', label: 'live', ageMin};
    if (delay > 0 && ageMin <= delay + 5) return {word: 'delayed', label: 'delayed ' + delay + 'm', ageMin};
    return {word: 'stale', label: 'stale', ageMin};
  }
  // Newest observation wins per symbol; an older or equal observation never replaces a newer one.
  function merge(prev, incoming, source) {
    const out = Object.assign({}, prev || {}), changed = [];
    Object.entries(incoming || {}).forEach(([t, q]) => {
      if (!q || !isNum(q.price) || q.price <= 0) return;
      const cur = out[t], tn = obsMs(q), tc = obsMs(cur);
      if (tn == null) return;
      if (cur && tc != null && tc >= tn && cur.price === q.price) return;
      if (cur && tc != null && tc > tn) return;
      out[t] = Object.assign({}, q, {_src: source});
      if (!cur || cur.price !== q.price || tc !== tn) changed.push(t);
    });
    return {quotes: out, changed};
  }
  // Batches for the Worker: priority order kept, at most 12 per request; rotate through the rest across polls.
  function batches(list, size) {
    const xs = [...new Set((list || []).map(s => String(s || '').toUpperCase()).filter(s => SYMBOL.test(s)))];
    const out = [];
    for (let i = 0; i < xs.length; i += size || MAX_BATCH) out.push(xs.slice(i, i + (size || MAX_BATCH)));
    return out;
  }
  // Quote-dependent numbers for one company row (core.json) at the current price.
  function derive(row, q) {
    row = row || {};
    const price = q && isNum(q.price) && q.price > 0 ? q.price : isNum(row.px) ? row.px : null;
    const out = {price, chg_pct: q && isNum(q.chg_pct) ? q.chg_pct : q && isNum(q.change_pct) ? q.change_pct : isNum(row.d1) ? row.d1 : null};
    if (price == null) return out;
    const base = isNum(row.px) && row.px > 0 ? row.px : null;
    // P/E scales with price at fixed earnings: eps = close / P/E at the close
    out.pe = base && isNum(row.pe) && row.pe > 0 ? row.pe * price / base : null;
    out.pef = base && isNum(row.pef) && row.pef > 0 ? row.pef * price / base : null;
    if (isNum(row.lo) && isNum(row.hi) && row.hi > row.lo) {
      const lo = Math.min(row.lo, price), hi = Math.max(row.hi, price);
      out.range_pct = 100 * (price - lo) / (hi - lo);
      out.from_hi_pct = 100 * (price / hi - 1);
      out.from_lo_pct = 100 * (price / lo - 1);
      out.new_high = price > row.hi; out.new_low = price < row.lo;
    }
    out.tgt_up_pct = isNum(row.tgt) && row.tgt > 0 ? 100 * (row.tgt / price - 1) : null;
    out.since_close_pct = base ? 100 * (price / base - 1) : null;
    return out;
  }
  // Header truth: worst of the price feed and every dataset in refresh-status / brief health.
  // closed outranks live so one closed name never lets the summary say live
  const RANK = {live: 0, fresh: 0, ok: 0, closed: 0.5, delayed: 1, warn: 1, stale: 2, fail: 3, missing: 3};
  function worstOf(words) {
    const xs = (words || []).map(x => String(x).toLowerCase());
    return xs.length ? xs.reduce((w, x) => (RANK[x] ?? 3) > (RANK[w] ?? 3) ? x : w, xs[0]) : 'missing';
  }
  function feedSummary(quotes, tickers, nowMs) {
    const clock = marketClock(nowMs);
    const names = (tickers && tickers.length ? tickers : Object.keys(quotes || {}));
    const cls = names.map(t => ({t, c: classify(quotes && quotes[t], nowMs, clock), q: quotes && quotes[t]}));
    const seen = cls.filter(x => x.c.word !== 'missing');
    if (!seen.length) return {word: 'missing', words: 'Prices not available', n: 0, of: names.length};
    const word = worstOf(seen.map(x => x.c.word));
    const newest = seen.reduce((a, x) => (obsMs(x.q) > obsMs(a.q) ? x : a), seen[0]);
    const providers = [...new Set(seen.map(x => x.q.provider || 'provider not stated'))];
    const lead = word === 'live' ? 'Prices live' : word === 'delayed' ? 'Prices delayed 15 min' : word === 'closed' ? 'Market closed' : 'Prices stale';
    return {word, words: lead + ', ' + etLabel(newest.q.asof_utc || newest.q.ts, nowMs), n: seen.length, of: names.length, providers,
      missing: names.length - seen.length, open: clock.open};
  }
  const fmtPx = v => isNum(v) ? (v >= 1000 ? v.toLocaleString('en-US', {maximumFractionDigits: 0}) : v.toFixed(2)) : 'Not available';
  const fmtPct = (v, d) => isNum(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d == null ? 2 : d) + '%' : 'Not available';

  /* ------------------------------------------------------------ engine state */
  const ST = {quotes: {}, file: null, subs: new Set(), owners: {}, cursor: 0, timers: [], started: false,
    worker: {url: '', enabled: false, reason: 'not configured', last: null, error: '', errors: {}},
    fileState: {last: null, error: ''}, status: null, polling: false};
  const doc = root.document;
  const now = () => Date.now();

  function onScreen() {
    const order = ['company', 'index', 'shortlist', 'watchlist', 'other'];
    const all = [];
    order.concat(Object.keys(ST.owners).filter(k => !order.includes(k))).forEach(k => (ST.owners[k] || []).forEach(t => all.push(t)));
    return [...new Set(all.map(t => String(t).toUpperCase()).filter(t => SYMBOL.test(t)))];
  }
  function watch(owner, tickers) {
    ST.owners[owner] = [...new Set((tickers || []).map(t => String(t).toUpperCase()))];
    if (doc) paintHealth();   // the header's on-screen/other scope changes with the watched set
    if (ST.started) schedule(true);
  }
  function subscribe(fn) { ST.subs.add(fn); return () => ST.subs.delete(fn); }
  function get(t) {
    const q = ST.quotes[String(t || '').toUpperCase()];
    if (!q) return null;
    const c = classify(q, now());
    return Object.assign({}, q, {t: String(t).toUpperCase(), freshness_word: c.word, freshness_label: c.label, asof_label: etLabel(q.asof_utc || q.ts, now())});
  }
  // quotes.json-shaped snapshot for older consumers (company view, intelligence, chat)
  function snapshot() {
    const f = ST.file || {};
    return Object.assign({}, f, {quotes: Object.assign({}, ST.quotes)});
  }
  function emit(changed, source) {
    const ev = {changed, source, quotes: snapshot(), at: now()};
    ST.subs.forEach(fn => { try { fn(ev); } catch (e) { console.error('[live] subscriber failed', e); } });
    if (doc) { paint(doc, changed); if (root.CustomEvent) root.dispatchEvent(new root.CustomEvent('so:quotes-update', {detail: ev.quotes})); }
  }
  function accept(incoming, source) {
    const r = merge(ST.quotes, incoming, source);
    ST.quotes = r.quotes;
    if (r.changed.length || source === 'file-first') emit(r.changed, source);
    return r.changed;
  }

  async function getJSON(url, fetchImpl) {
    const res = await (fetchImpl || root.fetch)(url, {cache: 'no-store'});
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }
  async function loadFile(fetchImpl) {
    try {
      const q = await getJSON('data/quotes.json', fetchImpl);
      if (!q || !q.quotes) throw new Error('quote file has no quotes');
      const first = !ST.file;
      ST.file = q; ST.fileState = {last: now(), error: ''};
      accept(q.quotes, first ? 'file-first' : 'file');
    } catch (e) {
      ST.fileState.error = 'Shared quote file unavailable: ' + (e.message || e) + '. Last observations kept with their times.';
      if (doc) paintHealth();
    }
  }
  async function pollWorker(fetchImpl, force) {
    const w = ST.worker;
    if (!w.enabled || ST.polling) return;
    if (doc && doc.visibilityState && doc.visibilityState !== 'visible') return;
    const clock = marketClock(now());
    if (!clock.open && !force) return;
    const groups = batches(onScreen());
    if (!groups.length) return;
    const group = groups[ST.cursor % groups.length]; ST.cursor++;
    ST.polling = true;
    try {
      const url = new URL(w.url); url.searchParams.set('symbols', group.join(','));
      const data = await getJSON(url.toString(), fetchImpl);
      if (!data || typeof data.quotes !== 'object') throw new Error('response had no quotes');
      w.errors = Object.assign({}, w.errors, data.errors || {});
      group.forEach(t => { if (data.quotes[t]) delete w.errors[t]; });
      w.last = now(); w.error = '';
      accept(data.quotes, 'worker');
    } catch (e) {
      w.error = 'Fast price path unavailable: ' + (e.message || e) + '. Showing the shared file.';
    } finally { ST.polling = false; if (doc) paintHealth(); }
  }
  function schedule(immediate) {
    if (immediate) pollWorker(null, !marketClock(now()).open && !ST.worker.last);
  }
  function configure(cfg, origin) {
    const url = cfg && typeof cfg.quotes_proxy_url === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(cfg.quotes_proxy_url) ? cfg.quotes_proxy_url : '';
    const allowed = (cfg && Array.isArray(cfg.quotes_proxy_origins) ? cfg.quotes_proxy_origins : ALLOWED_ORIGINS);
    ST.worker.url = url;
    ST.worker.enabled = !!url && allowed.includes(origin);
    ST.worker.reason = !url ? 'No fast path configured' : ST.worker.enabled ? 'Finnhub through the shared Worker' :
      'Fast path serves the published sites only; this copy (' + origin + ') reads the shared file';
    return ST.worker.enabled;
  }
  async function start(opts) {
    if (ST.started) return;
    ST.started = true;
    opts = opts || {};
    let cfg = null;
    try { cfg = await getJSON('data/config.json'); } catch (e) { ST.worker.reason = 'Configuration unavailable: ' + (e.message || e); }
    configure(cfg, root.location ? root.location.origin : '');
    await loadFile();
    pollWorker(null, true);   // one fast read on arrival, even after the close, so the latest print is shown
    ST.timers.push(setInterval(() => pollWorker(), OPEN_POLL_MS));
    ST.timers.push(setInterval(() => { if (!doc || doc.visibilityState === 'visible') loadFile(); }, FILE_POLL_MS));
    ST.timers.push(setInterval(() => paint(doc, null), 30000));   // freshness words age even when no price moves
    if (doc) doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'visible') { loadFile(); pollWorker(); } });
  }

  /* ------------------------------------------------------------ DOM binding
     <span data-live="AAPL" data-live-f="price|chg|pe|pef|range|hi|asof|fresh|since"></span> updates itself. */
  function coreRow(t) { const A = root.SO2; const d = A && A.D && A.D(); return d && d.rows ? d.rows.find(r => r.t === t) : null; }
  const reduced = () => !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
  function fieldText(f, d, q, nowMs) {
    switch (f) {
      case 'price': return fmtPx(d.price);
      case 'chg': return fmtPct(d.chg_pct);
      case 'pe': return isNum(d.pe) ? d.pe.toFixed(1) : 'Not available';
      case 'pef': return isNum(d.pef) ? d.pef.toFixed(1) : 'Not available';
      case 'range': return isNum(d.range_pct) ? Math.round(d.range_pct) + '% of range' : 'Not available';
      case 'hi': return isNum(d.from_hi_pct) ? (d.new_high ? 'New high' : fmtPct(d.from_hi_pct, 1)) : 'Not available';
      case 'asof': return q ? etLabel(q.asof_utc || q.ts, nowMs) : 'session close';
      case 'fresh': return q ? classify(q, nowMs).label : 'missing';
      case 'since': return isNum(d.since_close_pct) ? fmtPct(d.since_close_pct) : '';
      default: return '';
    }
  }
  function paint(scope, changed) {
    if (!scope || !scope.querySelectorAll) return;
    const nowMs = now(), set = changed ? new Set(changed) : null, anim = !reduced();
    scope.querySelectorAll('[data-live]').forEach(el => {
      const t = el.getAttribute('data-live');
      const q = ST.quotes[t], d = derive(coreRow(t), q), f = el.getAttribute('data-live-f') || 'price';
      const text = fieldText(f, d, q, nowMs);
      if (f === 'fresh') { const c = classify(q, nowMs); el.dataset.fresh = c.word; el.title = q ? (q.provider || '') + ', ' + etLabel(q.asof_utc || q.ts, nowMs) : 'No observation'; }
      if (f === 'range' && el.style) el.style.setProperty('--pos', isNum(d.range_pct) ? d.range_pct.toFixed(1) + '%' : '50%');
      if (f === 'chg' || f === 'since') el.dataset.dir = isNum(f === 'chg' ? d.chg_pct : d.since_close_pct) ? ((f === 'chg' ? d.chg_pct : d.since_close_pct) >= 0 ? 'up' : 'dn') : '';
      if (f === 'range') { const bar = el.querySelector && el.querySelector('i'); if (bar) bar.style.left = isNum(d.range_pct) ? d.range_pct.toFixed(1) + '%' : '50%'; const lab = el.querySelector && el.querySelector('b'); if (lab) lab.textContent = text; return; }
      if (el.textContent === text) return;
      const old = el.textContent; el.textContent = text;
      if (anim && old && set && set.has(t) && el.animate && (f === 'price' || f === 'chg')) {
        const up = f === 'chg' ? d.chg_pct >= 0 : parseFloat(text.replace(/,/g, '')) >= parseFloat(old.replace(/,/g, ''));
        el.animate([{backgroundColor: up ? 'var(--b-good-bg)' : 'var(--b-bad-bg)'}, {backgroundColor: 'transparent'}], {duration: 220, easing: 'ease-out'});
      }
    });
    paintHealth();
  }
  // Prices not on screen are not polled: describe them by their median observation, never by the live subset.
  function coverage(quotes, watched, nowMs) {
    const set = new Set(watched || []);
    const rest = Object.entries(quotes || {}).filter(([t, q]) => !set.has(t) && q && isNum(q.price) && q.price > 0 && obsMs(q) != null)
      .map(([, q]) => q).sort((a, b) => obsMs(a) - obsMs(b));
    const mid = rest.length ? rest[Math.floor(rest.length / 2)] : null;
    const c = mid ? classify(mid, nowMs) : null;
    return {watched: set.size, others: rest.length, others_asof: mid ? (mid.asof_utc || mid.ts) : null, others_word: c ? c.word : 'missing',
      others_label: mid ? etLabel(mid.asof_utc || mid.ts, nowMs) : 'time not available'};
  }
  function health(nowMs) {
    nowMs = nowMs == null ? now() : nowMs;
    const watched = onScreen();
    const feed = feedSummary(ST.quotes, watched.length ? watched : null, nowMs);
    return {feed, coverage: coverage(ST.quotes, watched, nowMs), worker: Object.assign({}, ST.worker), file: Object.assign({}, ST.fileState),
      fileHealth: ST.file && ST.file.health || null};
  }
  function paintHealth() { if (root.CustomEvent && root.dispatchEvent) root.dispatchEvent(new root.CustomEvent('so:live-health', {detail: health()})); }

  return {start, configure, watch, subscribe, get, snapshot, health, coverage, paint, accept, loadFile, pollWorker, onScreen,
    marketClock, classify, etLabel, merge, batches, derive, worstOf, feedSummary, fmtPx, fmtPct, ALLOWED_ORIGINS, MAX_BATCH,
    _state: ST};
});
