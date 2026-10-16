/* SmartOptions Brief: the minimal main page (Market brief, Companies, Macro).
   Prices come from the one quote engine in live.js (Yahoo stream, then the shared Worker, then the
   published quote file). Every price-dependent number and sentence is a "slot" that re-renders when an
   accepted quote changes; statements and macro releases keep their own reporting dates.
   Relationships are historical associations (core.json rel: OLS over <=252 sessions), never forecasts.
   The expanded workstation lives at backup.html and is not linked from navigation, only from the footer. */
'use strict';
(function (root) {
  const isNum = v => typeof v === 'number' && isFinite(v);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const pct = (v, d) => isNum(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d == null ? 2 : d) + '%' : 'n/a';
  const px = v => isNum(v) ? '$' + (v >= 1000 ? v.toLocaleString('en-US', {maximumFractionDigits: 2, minimumFractionDigits: 2}) : v.toFixed(2)) : 'n/a';
  const big = v => !isNum(v) ? 'n/a' : Math.abs(v) >= 1e12 ? (v / 1e12).toFixed(2) + 'T' : Math.abs(v) >= 1e9 ? (v / 1e9).toFixed(1) + 'bn' : Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(1) + 'm' : v.toLocaleString('en-US');
  const dir = v => isNum(v) ? (v >= 0 ? 'up' : 'dn') : '';
  const listJoin = xs => xs.length <= 1 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1];

  // Factor wording for relationship sentences. scale = factor move used in the sentence.
  const FACTORS = {
    us10y_bps: {name: '10-year Treasury yield', per: '+10 bp', scale: 10, macro: ['curve', 'us10y'], move: ['curve', 'us10y_bps_chg'], moveUnit: 'bp'},
    dxy: {name: 'US dollar index', per: '+1%', scale: 1, macro: ['cross_asset', 'dxy'], move: ['cross_asset', 'dxy_ret_20d'], moveUnit: '%', moveSpan: '20 sessions'},
    wti: {name: 'WTI crude oil', per: '+10%', scale: 10, macro: ['cross_asset', 'wti'], move: ['cross_asset', 'wti_ret_20d'], moveUnit: '%', moveSpan: '20 sessions'},
    vix: {name: 'VIX', per: '+1 point', scale: 1, macro: ['volatility', 'vix'], move: null}
  };

  /* ------------------------------------------------------------ pure analytics (exported for node tests) */
  function median(xs) { const a = xs.filter(isNum).sort((x, y) => x - y); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
  // Sector median sensitivity to one factor, members only, minimum 120 common sessions.
  function sectorSensitivity(rows, factor) {
    const by = {};
    (rows || []).forEach(r => { if (r.sp500_member === false || !r.rel || !(r.rel.n >= 120) || !r.rel.c || !isNum(r.rel.c[factor])) return; (by[r.sec] ||= []).push(r.rel.c[factor]); });
    return Object.entries(by).filter(([, xs]) => xs.length >= 5).map(([sector, xs]) => ({sector, n: xs.length, coef: median(xs)})).sort((a, b) => a.coef - b.coef);
  }
  function macroItem(core, path) { const g = core && core.macro && core.macro[path[0]]; return Array.isArray(g) ? g.find(x => x.id === path[1]) || null : null; }
  // One or two plain sentences linking a factor's latest move to the sectors that have historically moved most with it.
  function factorSentence(core, factor) {
    const f = FACTORS[factor], s = sectorSensitivity(core.rows, factor);
    if (!f || s.length < 2) return null;
    const lvl = macroItem(core, f.macro), mv = f.move ? macroItem(core, f.move) : null;
    const low = s.slice(0, 2), high = s.slice(-2).reverse();
    const fmt = x => x.sector + ' (' + pct(x.coef * f.scale, 2) + ')';
    let lead = f.name;
    if (lvl && isNum(lvl.v)) lead += ' ' + (factor === 'us10y_bps' ? lvl.v.toFixed(2) + '%' : lvl.v.toFixed(2)) + (lvl.period ? ' (' + lvl.period + ')' : '');
    if (mv && isNum(mv.v)) lead += ', ' + (f.moveUnit === 'bp' ? (mv.v > 0 ? '+' : mv.v < 0 ? '−' : '') + Math.abs(mv.v).toFixed(0) + ' bp on the day' : pct(mv.v, 1) + ' over ' + f.moveSpan);
    else if (lvl && isNum(lvl.prior)) lead += ' (prior ' + lvl.prior.toFixed(2) + ')';
    return {factor, lead, text: `${lead}. Over the past year, per ${f.per} move the median stock fell most in ${listJoin(low.map(fmt))} and ${high.every(x => x.coef > 0) ? 'rose most' : 'held up best'} in ${listJoin(high.map(fmt))}, other factors held fixed.`, low, high};
  }
  // Live breadth and sector day change from accepted quotes. Cap weights use the close market cap.
  function liveBreadth(rows, getQuote) {
    let up = 0, n = 0, newest = null; const sec = {};
    (rows || []).forEach(r => {
      if (r.sp500_member === false) return;
      const q = getQuote(r.t); if (!q || q.current_usable === false) return;
      const c = isNum(q.chg_pct) ? q.chg_pct : q.change_pct; if (!isNum(c)) return;
      n++; if (c > 0) up++;
      const t = Date.parse(q.asof_utc || q.ts || ''); if (isFinite(t) && (newest == null || t > newest)) newest = t;
      if (isNum(r.mcap) && r.mcap > 0) { const s = sec[r.sec] ||= {w: 0, wc: 0, n: 0}; s.w += r.mcap; s.wc += r.mcap * c; s.n++; }
    });
    const sectors = Object.entries(sec).map(([sector, s]) => ({sector, chg: s.wc / s.w, n: s.n})).sort((a, b) => b.chg - a.chg);
    return {up, n, up_pct: n ? 100 * up / n : null, sectors, newest};
  }
  // Price versus averages: averages keep their dated sessions; the price is the latest accepted quote.
  function vsAverages(price, a50, a200) {
    if (!isNum(price) || !(price > 0)) return null;
    return {v50: isNum(a50) && a50 > 0 ? 100 * (price / a50 - 1) : null, v200: isNum(a200) && a200 > 0 ? 100 * (price / a200 - 1) : null};
  }
  // Route from a hash. Old expanded-dashboard hashes land on simple content or say where the view lives.
  function route(hash) {
    const h = String(hash || '').replace(/^#/, '');
    let m;
    if (!h || h === '/' || h === '/brief') return {view: 'brief'};
    if ((m = h.match(/^\/company\/([A-Za-z0-9.\-]{1,10})$/))) return {view: 'company', t: m[1].toUpperCase().replace('.', '-')};
    if (h === '/companies') return {view: 'companies'};
    if (h === '/macro' || /(^|&)tab=macro\b/.test(h)) return {view: 'macro'};
    if ((m = h.match(/(?:^|[&?])t=([A-Za-z0-9.\-]{1,10})/))) return {view: 'company', t: m[1].toUpperCase().replace('.', '-')};
    if ((m = h.match(/^\/research\/company\/([A-Za-z0-9.\-]{1,10})/))) return {view: 'company', t: m[1].toUpperCase().replace('.', '-')};
    return {view: 'brief', legacy: '#' + h};
  }

  // Name the session the quotes belong to: 'today' only when the newest accepted observation is from today in New York.
  function sessionWord(ms, nowMs) {
    if (!isNum(ms)) return 'in the latest session';
    const day = x => new Date(x).toLocaleDateString('en-CA', {timeZone: 'America/New_York'});
    return day(ms) === day(nowMs) ? 'today' : 'on ' + new Date(ms).toLocaleDateString('en-US', {timeZone: 'America/New_York', month: 'short', day: 'numeric'});
  }
  const API = {sessionWord, sectorSensitivity, factorSentence, liveBreadth, vsAverages, route, median, FACTORS, pct, px};
  if (typeof module !== 'undefined' && module.exports) { module.exports = API; return; }
  root.SmartOptionsMain = API;
  const doc = root.document; if (!doc) return;

  /* ------------------------------------------------------------ page */
  const Live = root.SmartOptionsLive;
  const S = {core: null, brief: null, rowMap: new Map(), slots: [], view: null, chart: null, company: {}};
  const $ = s => doc.querySelector(s);
  const q = t => Live.get(t);
  const row = t => S.rowMap.get(t) || null;
  const liveSpan = (t, f) => `<span data-live="${esc(t)}" data-live-f="${f}"></span>`;
  function slot(id, fn) { S.slots.push({id, fn}); return `<span class="slot" id="${id}">${fn()}</span>`; }
  function paintSlots() { S.slots.forEach(s => { const el = doc.getElementById(s.id); if (el) { const h = s.fn(); if (el.innerHTML !== h) el.innerHTML = h; } }); }
  async function json(url) { const r = await fetch(url, {cache: 'no-store'}); if (!r.ok) throw new Error(url + ' HTTP ' + r.status); return r.json(); }
  const source = m => m && m.source_url ? `<a href="${esc(m.source_url)}" target="_blank" rel="noopener">${esc(m.source || 'source')}</a>` : esc(m && m.source || '');
  function metricValue(m) {
    if (!m || m.value == null) return 'n/a';
    const v = m.value, u = m.unit || '';
    if (!isNum(v)) return esc(v);
    if (u === '%' || /^% /.test(u)) return pct(v, 1).replace(/^\+/, v > 0 && /growth|change|vs|versus/i.test(m.label) ? '+' : '');
    if (u === 'pp') return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + ' pp';
    if (u === 'x') return v.toFixed(2) + '×';
    if (u === 'USD') return '$' + big(v);
    if (u === 'USD/share') return px(v);
    if (u === 'bps') return v.toFixed(0) + ' bp';
    return (Math.abs(v) >= 1e5 ? big(v) : +v.toFixed(2)) + (u && !/revisions/.test(u) ? ' ' + esc(u) : '');
  }
  function metricTable(ms) {
    ms = (ms || []).filter(m => m && m.label);
    if (!ms.length) return '';
    return `<details class="src"><summary>Inputs and sources</summary><table>${ms.map(m => `<tr><td>${esc(m.label)}</td><td class="n">${metricValue(m)}</td><td class="dim">${esc(m.period || m.asof || '')}</td><td class="dim">${source(m)}${m.note ? ' · ' + esc(m.note) : ''}</td></tr>`).join('')}</table></details>`;
  }
  function setView(name) {
    doc.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.v === name));
  }
  function render() {
    const r = route(root.location.hash);
    S.slots = []; if (S.chart) { try { S.chart.remove(); } catch (e) {} S.chart = null; }
    S.view = r.view; setView(r.view === 'company' ? 'companies' : r.view);
    const main = $('#view');
    try {
      if (r.view === 'company') { main.innerHTML = '<p class="dim">Loading…</p>'; renderCompany(r.t, main); }
      else if (r.view === 'companies') renderCompanies(main);
      else if (r.view === 'macro') renderMacro(main);
      else renderBrief(main, r.legacy);
    } catch (e) { main.innerHTML = `<p>This view could not be drawn from the published data. <a href="backup.html">Expanded dashboard (backup)</a></p>`; console.error(e); }
    Live.paint(doc, null);
    root.scrollTo(0, 0);
  }

  /* ------------------------------------------------------------ Market brief */
  function pulseSlot() {
    const b = Live.currentBrief(S.brief, Live.snapshot());
    const p = b.pulse || {}, notHead = x => (x.text || x.line) !== p.headline, sup = (p.supports || []).filter(notHead).slice(0, 3), ch = (p.challenges || []).filter(notHead).slice(0, 3);
    const item = x => `<li>${esc(x.text || x.line)}</li>`;
    return `<p class="lead">${esc(p.headline || 'Market summary unavailable.')}</p>
      <div class="two"><div><h4>Supports</h4><ul>${sup.map(item).join('') || '<li class="dim">None measured.</li>'}</ul></div>
      <div><h4>Challenges</h4><ul>${ch.map(item).join('') || '<li class="dim">None measured.</li>'}</ul></div></div>`;
  }
  function breadthSlot() {
    const lb = liveBreadth(S.core.rows, q);
    if (!lb.n) return '<span class="dim">Today’s breadth is unavailable until prices arrive.</span>';
    const lead = lb.sectors[0], lag = lb.sectors[lb.sectors.length - 1];
    return `${lb.up} of ${lb.n} priced S&amp;P 500 names were up versus their previous close ${sessionWord(lb.newest, Date.now())} (${lb.up_pct.toFixed(0)}%).` +
      (lead && lag && lead !== lag ? ` Cap-weighted, ${esc(lead.sector)} leads (${pct(lead.chg)}) and ${esc(lag.sector)} trails (${pct(lag.chg)}).` : '');
  }
  function heatSlot() {
    const lb = liveBreadth(S.core.rows, q), live = lb.sectors, sw = sessionWord(lb.newest, Date.now()), closes = (S.brief.positioning && S.brief.positioning.sectors) || [];
    const m1 = Object.fromEntries(closes.map(s => [s.sector, s.m1]));
    const cell = s => { const a = Math.min(1, Math.abs(s.chg) / 2.5); return `<div class="hc" style="--a:${a.toFixed(2)}" data-dir="${dir(s.chg)}"><b>${esc(s.sector)}</b><span>${pct(s.chg)} ${sw}</span><span class="dim">${isNum(m1[s.sector]) ? pct(m1[s.sector], 1) + ' 1 mo' : ''}</span></div>`; };
    return live.length ? `<div class="heat">${live.map(cell).join('')}</div>` : '';
  }
  function ideaSlot(t) {
    return () => { const r = row(t), cur = r && Live.currentRow(r); if (!cur) return ''; const lb = []; if (isNum(cur.pef)) lb.push('forward P/E ' + cur.pef.toFixed(1)); if (isNum(cur.pef_sec_rel)) lb.push(cur.pef_sec_rel.toFixed(2) + '× sector median'); return lb.length ? '<span class="dim">At this price: ' + lb.join(', ') + '.</span>' : ''; };
  }
  function upcoming(limit) {
    const today = new Date().toLocaleDateString('en-CA', {timeZone: 'America/New_York'});
    const big = new Set(S.core.rows.filter(r => r.sp500_member !== false && isNum(r.mcap)).sort((a, b) => b.mcap - a.mcap).slice(0, 60).map(r => r.t));
    return (S.brief.risks || []).filter(x => String(x.when_et || '').slice(0, 10) >= today)
      .filter(x => x.kind === 'macro' || (x.tickers || []).some(t => big.has(t)) || x.importance >= 3)
      .sort((a, b) => String(a.when_et).localeCompare(String(b.when_et)))
      .filter((x, i, xs) => x.kind === 'macro' ? xs.filter(y => y.kind === 'macro').indexOf(x) < Math.ceil(limit / 2) : xs.filter(y => y.kind !== 'macro').indexOf(x) < Math.floor(limit / 2));
  }
  function when(s) {
    const t = Date.parse(s); if (!isFinite(t)) return esc(s);
    const hasTime = /T\d/.test(s);
    return new Date(hasTime ? t : t + 12 * 3600e3).toLocaleString('en-US', Object.assign({timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric'}, hasTime ? {hour: 'numeric', minute: '2-digit'} : {})) + (hasTime ? ' ET' : '');
  }
  function renderBrief(main, legacy) {
    const b = S.brief, pos = b.positioning || {}, short = (b.shortlist || []).slice(0, 6);
    Live.watch('index', ['SPY']); Live.watch('research', short.map(x => x.t)); Live.watch('company', []);
    const rels = ['us10y_bps', 'wti', 'dxy'].map(f => factorSentence(S.core, f)).filter(Boolean);
    const events = upcoming(8);
    main.innerHTML = `
      ${legacy ? `<p class="note">That view is part of the expanded dashboard. <a href="backup.html${esc(legacy)}">Open it in the backup</a>.</p>` : ''}
      <section><h2>Market <span class="px">SPY ${liveSpan('SPY', 'price')} <span class="chg">${liveSpan('SPY', 'chg')}</span></span></h2>
        ${slot('pulse', pulseSlot)}</section>
      <section><h2>Breadth and leadership</h2>
        <p>${slot('breadth', breadthSlot)}</p>
        <p class="dim">At the ${esc(b.asof_session)} close: ${esc(pos.breadth && pos.breadth.line)} ${esc(pos.concentration && pos.concentration.line)} ${esc(pos.rotation && pos.rotation.line)}</p>
        ${slot('heat', heatSlot)}</section>
      <section><h2>Macro and sectors</h2>
        ${rels.map(r => `<p>${esc(r.text)}</p>`).join('')}
        <p class="dim">Associations from daily returns over the past year; they describe how prices moved together, not why, and are not forecasts. <a href="#/macro">Macro detail</a></p></section>
      <section><h2>Ahead</h2>
        <ul class="events">${events.map(e => `<li><span class="when">${when(e.when_et)}</span> <b>${esc(e.title)}</b> <span class="dim">${esc(e.why)}</span></li>`).join('') || '<li class="dim">No scheduled releases in the published calendar.</li>'}</ul></section>
      <section><h2>Names to research</h2>
        <p class="dim">Ranked by current fundamentals, trend and dated signals; a starting list for research, not a recommendation.</p>
        <div class="ideas">${short.map(x => `<article><h3><a href="#/company/${esc(x.t)}">${esc(x.t)}</a> <span class="dim">${esc(x.name)} · ${esc(x.sector)}</span>
          <span class="px">${liveSpan(x.t, 'price')} <span class="chg">${liveSpan(x.t, 'chg')}</span></span></h3>
          <ul>${(x.why || []).slice(0, 2).map(w => `<li>${esc(w.text)}</li>`).join('')}</ul>
          <p class="counter"><b>Against:</b> ${esc(x.counter && x.counter.text || 'Not available')}</p>
          <p>${slot('idea-' + x.t, ideaSlot(x.t))}</p></article>`).join('')}</div></section>`;
  }

  /* ------------------------------------------------------------ Companies */
  function renderCompanies(main) {
    const all = S.core.rows.filter(r => r.sp500_member !== false).sort((a, b) => (b.mcap || 0) - (a.mcap || 0));
    main.innerHTML = `<section><h2>Companies</h2>
      <input id="find" type="search" placeholder="Ticker or company name" autocomplete="off" spellcheck="false" aria-label="Find a company">
      <table class="list"><tbody id="rows"></tbody></table></section>`;
    const draw = () => {
      const s = $('#find').value.trim().toUpperCase();
      const hits = (s ? all.filter(r => r.t.startsWith(s.replace('.', '-')) || String(r.n).toUpperCase().includes(s)) : all).slice(0, 40);
      Live.watch('company', hits.slice(0, 24).map(r => r.t));
      $('#rows').innerHTML = hits.map(r => `<tr><td><a href="#/company/${esc(r.t)}"><b>${esc(r.t)}</b></a></td><td>${esc(r.n)}<div class="dim">${esc(r.sec)}</div></td>
        <td class="n">${liveSpan(r.t, 'price')}</td><td class="n chg">${liveSpan(r.t, 'chg')}</td></tr>`).join('') || '<tr><td class="dim">No match.</td></tr>';
      Live.paint(doc, null);
    };
    $('#find').addEventListener('input', draw); draw();
  }

  /* ------------------------------------------------------------ Company */
  function techSlot(t, tech) {
    return () => {
      const ms = tech && tech.metrics || [], a50 = (ms.find(m => m.label === '50-session average') || {}).value, a200 = (ms.find(m => m.label === '200-session average') || {}).value;
      const cur = Live.currentRow(row(t)) || {}, va = vsAverages(cur.px, a50, a200);
      if (!va) return 'Current price unavailable; technical comparison withheld.';
      const parts = [];
      if (isNum(va.v50)) parts.push(`${pct(va.v50, 1)} versus its 50-session average (${px(a50)})`);
      if (isNum(va.v200)) parts.push(`${pct(va.v200, 1)} versus its 200-session average (${px(a200)})`);
      const r = row(t), lo = r && isNum(r.lo) ? Math.min(r.lo, cur.px) : null, hi = r && isNum(r.hi) ? Math.max(r.hi, cur.px) : null;
      const rng = isNum(lo) && isNum(hi) && hi > lo ? ` It sits at ${Math.round(100 * (cur.px - lo) / (hi - lo))}% of its 52-week range (${px(lo)} to ${px(hi)}).` : '';
      return `At ${px(cur.px)} the stock is ${listJoin(parts)}.${rng}`;
    };
  }
  function valSlot(t) {
    return () => {
      const r = row(t), cur = r && Live.currentRow(r); if (!cur || !isNum(cur.px)) return '';
      const p = [];
      if (isNum(cur.pe)) p.push(`trailing P/E ${cur.pe.toFixed(1)}`);
      if (isNum(cur.pef)) p.push(`forward P/E ${cur.pef.toFixed(1)}` + (isNum(cur.pef_sec_rel) ? ` (${cur.pef_sec_rel.toFixed(2)}× the sector median)` : ''));
      if (isNum(cur.mcap)) p.push(`market value $${big(cur.mcap)}`);
      return p.length ? `At the current price: ${p.join(', ')}. Earnings stay at their last reported basis.` : '';
    };
  }
  function relSentence(r, card) {
    const rel = r && r.rel; if (!rel || !rel.c || !(rel.n >= 120)) return 'Macro relationships are unavailable for this name (fewer than 120 common sessions).';
    const out = [];
    if (isNum(rel.c.spy)) out.push(`moved ${rel.c.spy.toFixed(2)}% per 1% SPY move`);
    ['us10y_bps', 'wti', 'dxy', 'vix'].forEach(f => { const c = rel.c[f], tt = rel.t && rel.t[f]; if (isNum(c) && isNum(tt) && Math.abs(tt) >= 2) out.push(`${pct(c * FACTORS[f].scale, 2)} per ${FACTORS[f].per} in the ${FACTORS[f].name}`); });
    let s = `Over ${rel.n} sessions ${r.t} ${listJoin(out)}` + (out.length < 2 ? ' with no statistically clear rate, oil, dollar or VIX link' : '') + ` (R² ${isNum(rel.r2) ? rel.r2.toFixed(2) : 'n/a'}).`;
    const a = r.att;
    if (a && isNum(a.actual_20d) && isNum(a.explained_20d)) s += ` Over the 20 sessions to ${esc(a.date)}, those factors account for ${pct(a.explained_20d, 1)} of its ${pct(a.actual_20d, 1)} move; the remaining ${pct(a.resid_20d, 1)} is company-specific.`;
    const lev = card && (card.metrics || []).find(m => m.label === 'Net debt / EBITDA');
    if (isNum(rel.c.us10y_bps) && Math.abs((rel.t || {}).us10y_bps || 0) >= 2 && lev && isNum(lev.value)) s += ` Net debt is ${lev.value.toFixed(2)}× EBITDA (${esc(lev.period)}), relevant to that rate sensitivity.`;
    return s;
  }
  const CARD_TITLES = {growth: 'Growth', profitability: 'Margins', cash: 'Cash flow', resilience: 'Balance sheet', valuation: 'Valuation', expectations: 'Estimate revisions'};
  async function renderCompany(t, main) {
    Live.watch('company', [t]); Live.watch('research', []); Live.watch('index', ['SPY']);
    const r = row(t);
    if (!r) { main.innerHTML = `<p>${esc(t)} is not in the published S&amp;P 500 data. <a href="#/companies">Find a company</a></p>`; return; }
    let c = null, bars = null;
    try { c = await json(`data/brief/company/${encodeURIComponent(t)}.json`); } catch (e) { c = null; }
    try { bars = (await json(`data/px/${encodeURIComponent(t)}.json`)).bars; } catch (e) { bars = null; }
    if (route(root.location.hash).t !== t) return;   // reader moved on
    const cards = c && c.cards || {}, ev = c && c.events || {};
    main.innerHTML = `
      <section class="co"><h2>${esc(r.n)} <span class="dim">${esc(t)} · ${esc(r.sec)}</span></h2>
        <div class="quote"><span class="big">${liveSpan(t, 'price')}</span> <span class="chg">${liveSpan(t, 'chg')}</span> ${slot('session', () => sessionNote(t))}</div>
        <p>${slot('ctx', () => esc(Live.currentContext(t, Live.snapshot())))}</p>
        <p class="lead">${esc(c && c.summary || 'Company detail is unavailable in the published data.')}</p></section>
      <section><h2>Fundamentals</h2><div class="cards">
        ${Object.keys(CARD_TITLES).map(k => cards[k] ? `<div class="card"><h4>${CARD_TITLES[k]}</h4><p>${esc(cards[k].line)}</p>${k === 'valuation' ? `<p>${slot('val', valSlot(t))}</p>` : ''}${metricTable(cards[k].metrics)}</div>` : '').join('')}
      </div>
      <p class="counter"><b>Strongest counterargument:</b> ${esc(cards.counter && cards.counter.line || 'Not available')}</p></section>
      <section><h2>Macro relationship</h2><p>${esc(relSentence(r, cards.resilience))}</p><p class="dim">Historical association, not a forecast.</p></section>
      <section><h2>Price and trend</h2><div id="chart" class="chart"></div><p>${slot('tech', techSlot(t, c && c.technical))}</p></section>
      <section><h2>Events</h2><p>${esc(ev.line || 'No dated events in the published data.')}</p>
        ${(ev.items || []).length ? `<ul class="events">${ev.items.map(e => `<li><span class="when">${when(e.when_et)}</span> ${esc(e.title)}</li>`).join('')}</ul>` : ''}</section>
      ${c && c.options && c.options.line ? `<section><h2>Options</h2><p>${esc(c.options.line)}</p><p class="dim">No option prices are modelled here; check the live chain, spreads and the event dates above.</p></section>` : ''}`;
    paintSlots(); Live.paint(doc, null);
    drawChart(bars);
  }
  function sessionNote(t) {
    const x = q(t); if (!x) return '';
    const label = Live.etLabel(x.asof_utc || x.ts, Date.now());
    const sess = x.market_hours === 2 ? 'after-hours trade, ' : x.market_hours === 0 ? 'pre-market trade, ' : '';
    const delay = x.delay_minutes > 0 ? ', delayed about ' + x.delay_minutes + ' min' : '';
    return `<span class="dim">${esc(sess + label + delay)}</span>`;
  }
  function drawChart(bars) {
    const el = $('#chart'); if (!el) return;
    if (!Array.isArray(bars) || !bars.length || !root.LightweightCharts) { el.innerHTML = '<p class="dim">Price history unavailable.</p>'; el.classList.remove('chart'); return; }
    const dark = root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)').matches;
    const chart = root.LightweightCharts.createChart(el, {height: 240, autoSize: true, layout: {background: {color: 'transparent'}, textColor: dark ? '#b8bcc4' : '#555'},
      grid: {vertLines: {visible: false}, horzLines: {color: dark ? '#2a2d33' : '#eee'}}, rightPriceScale: {borderVisible: false}, timeScale: {borderVisible: false}, handleScroll: false, handleScale: false});
    const line = chart.addLineSeries ? chart.addLineSeries({color: dark ? '#8ab4f8' : '#1a56b0', lineWidth: 2, priceLineVisible: false}) : chart.addSeries(root.LightweightCharts.LineSeries, {color: '#1a56b0', lineWidth: 2});
    line.setData(bars.filter(b => isNum(b[4])).map(b => ({time: b[0], value: b[4]})));
    chart.timeScale().fitContent(); S.chart = chart;
  }

  /* ------------------------------------------------------------ Macro */
  const GROUPS = {policy: 'Policy rate', inflation: 'Inflation', labor: 'Labor', growth: 'Growth', curve: 'Treasury curve', credit_funding: 'Credit and funding', cross_asset: 'Dollar and commodities', volatility: 'Volatility'};
  function macroValue(x) { if (!isNum(x.v)) return 'n/a'; const u = x.unit || ''; return (Math.abs(x.v) >= 1e5 ? big(x.v) : +x.v.toFixed(2)) + (u ? ' ' + esc(u) : ''); }
  function renderMacro(main) {
    Live.watch('research', []); Live.watch('company', []); Live.watch('index', ['SPY']);
    const bd = S.brief.macro && S.brief.macro.backdrop || {}, risk = S.brief.macro && S.brief.macro.risk || {};
    const rels = Object.keys(FACTORS).map(f => factorSentence(S.core, f)).filter(Boolean);
    const cal = (S.core.calendar || []).filter(x => x.status !== 'released').sort((a, b) => String(a.scheduled_et).localeCompare(String(b.scheduled_et))).slice(0, 12);
    main.innerHTML = `
      <section><h2>Macro backdrop</h2><ul>${['growth', 'inflation', 'policy'].filter(k => bd[k] && bd[k].line).map(k => `<li><b>${GROUPS[k] || k}:</b> ${esc(bd[k].line)}</li>`).join('')}
        ${risk.line ? `<li><b>Credit:</b> ${esc(risk.line)}</li>` : ''}</ul></section>
      <section><h2>How sectors have moved with macro</h2>${rels.map(r => `<p>${esc(r.text)}</p>`).join('')}
        <details class="src"><summary>Sector medians by factor</summary>${rels.map(r => { const s = sectorSensitivity(S.core.rows, r.factor); return `<h4>${esc(FACTORS[r.factor].name)} (per ${FACTORS[r.factor].per})</h4><table>${s.map(x => `<tr><td>${esc(x.sector)}</td><td class="n">${pct(x.coef * FACTORS[r.factor].scale, 2)}</td><td class="dim">${x.n} names</td></tr>`).join('')}</table>`; }).join('')}
        <p class="dim">${esc(S.core.rel && S.core.rel.window)}; per-stock OLS of daily returns on SPY, 10-year yield, DXY, WTI and VIX changes; sector value is the median coefficient. Associations, not causes or forecasts.</p></details></section>
      <section><h2>Upcoming releases</h2><ul class="events">${cal.map(x => `<li><span class="when">${when(x.scheduled_et)}</span> ${esc(x.title)}</li>`).join('') || '<li class="dim">No scheduled releases in the published calendar.</li>'}</ul></section>
      <section><h2>Latest readings</h2>${Object.keys(GROUPS).filter(g => (S.core.macro[g] || []).length).map(g => `<details class="src"${g === 'policy' || g === 'inflation' ? ' open' : ''}><summary>${GROUPS[g]}</summary><table>
        ${S.core.macro[g].filter(x => !/_ret_1d|_ret_5d|_mom$/.test(x.id)).map(x => `<tr><td>${esc(x.label)}</td><td class="n">${macroValue(x)}</td><td class="dim">prior ${isNum(x.prior) ? +x.prior.toFixed(2) : 'n/a'}</td><td class="dim">${esc(x.period)}</td><td class="dim">${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.provider)}</a>` : esc(x.provider)}</td></tr>`).join('')}</table></details>`).join('')}</section>`;
  }

  /* ------------------------------------------------------------ boot */
  let pending = null;
  function onQuotes() { if (pending) return; pending = setTimeout(() => { pending = null; paintSlots(); }, 120); }
  async function boot() {
    try {
      const [core, brief] = await Promise.all([json('data/core.json'), json('data/brief.json')]);
      S.core = core; S.brief = brief; core.rows.forEach(r => S.rowMap.set(r.t, r));
      Live.setRows(core.rows);
    } catch (e) {
      $('#view').innerHTML = `<p>The published market data could not be loaded (${esc(e.message)}). <a href="backup.html">Expanded dashboard (backup)</a></p>`; return;
    }
    Live.subscribe(onQuotes);
    root.addEventListener('hashchange', render);
    render();
    Live.start();
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot); else boot();
})(typeof window !== 'undefined' ? window : globalThis);
