/* Company workspace (lane BU2). window.SmartOptionsCompany.mount(el, ticker, opts)
   Header (name, sector, price, change, freshness), seven assessment cards from data/brief/company/<T>.json
   (sentence on the front, measured inputs on the back), then the finviz-style chart, technical setup,
   event risk and options considerations. Sentences come from the JSON (Python templates); this file only lays them out. */
(function (root) {
'use strict';
const isNum = x => typeof x === 'number' && isFinite(x);
const CARDS = [
  ['growth', 'Growth', 'Revenue and earnings per share against the same period a year earlier.'],
  ['profitability', 'Profitability', 'Operating margin and whether it is widening or narrowing.'],
  ['cash', 'Cash generation', 'Free cash flow and how much of reported profit turns into cash.'],
  ['resilience', 'Financial resilience', 'Debt, liquidity and ability to cover interest.'],
  ['valuation', 'Valuation', 'Price against earnings, compared with sector peers and its own history.'],
  ['expectations', 'Expectations', 'Whether analysts are raising or cutting earnings estimates.'],
  ['counter', 'Counterargument', 'The strongest measured evidence against owning it.'],
];
const TONE = {strong: 'good', ok: 'mixed', weak: 'bad', unavailable: 'none'};
const LEVEL = {weak: 1, ok: 2, strong: 3};
const ICON = {
  good: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M4.8 8.3l2.1 2.1 4.3-4.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  mixed: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 1a7 7 0 0 1 0 14z" fill="currentColor"/></svg>',
  bad: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.6l6.8 12.2H1.2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M8 6.2v3.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="11.9" r="1" fill="currentColor"/></svg>',
  none: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.4 2.2"/></svg>',
};

/* ---------- pure formatting ---------- */
/* fmtMetric(m) -> display string or null when the value is missing */
function fmtMetric(m) {
  if (!m) return null; const v = m.value, u = String(m.unit || '').trim();
  if (v == null || v === '') return null;
  if (!isNum(v)) return String(v);
  const big = a => { const s = a < 0 ? '−' : '', x = Math.abs(a); return s + (x >= 1e12 ? (x / 1e12).toFixed(2) + 'T' : x >= 1e9 ? (x / 1e9).toFixed(1) + 'B' : x >= 1e6 ? (x / 1e6).toFixed(1) + 'M' : x.toLocaleString('en-US', {maximumFractionDigits: 2})); };
  const sg = x => (x > 0 ? '+' : x < 0 ? '−' : '');
  if (u === '%') return (Math.abs(v) >= 100 ? Math.round(v) : v.toFixed(1)).toString().replace('-', '−') + '%';
  if (u === 'pp') return sg(v) + Math.abs(v).toFixed(1) + ' pp';
  if (u === 'x') return v.toFixed(2) + 'x';
  if (u === 'USD') return (v < 0 ? '−$' : '$') + big(Math.abs(v));
  if (/^USD\/share$/i.test(u)) return '$' + v.toFixed(2);
  if (Number.isInteger(v) || /revision|count|dimension/i.test(u)) return Math.round(v) + (u ? ' ' + u : '');
  return (Math.abs(v) >= 1e6 ? big(v) : String(+v.toFixed(2))) + (u ? ' ' + u : '');
}
/* headline(card): the first metric with a value, shown large on the card front */
function headline(card, key) {
  if (!card || card.status === 'unavailable' || key === 'counter') return null;
  const m = (card.metrics || []).find(x => fmtMetric(x) != null && x.unit !== 'date');
  if (!m) return null;
  const u = String(m.unit || ''), plain = isNum(m.value) && u && !/^(%|pp|x|USD|USD\/share)$/i.test(u);
  return {label: m.label, value: plain ? String(Math.round(m.value * 100) / 100) : fmtMetric(m), period: m.period || ''};
}
function safeURL(u) { return /^https:\/\/[^\s"'<>]+$/i.test(String(u || '')) ? String(u) : null; }
const toneOf = s => TONE[s] || 'none';
/* summarize(doc): counts by status for the header strip */
function tally(doc) {
  const out = {strong: 0, ok: 0, weak: 0, unavailable: 0};
  for (const [k] of CARDS) { if (k === 'counter') continue; const s = doc && doc.cards && doc.cards[k] && doc.cards[k].status; out[TONE[s] ? s : 'unavailable']++; }
  return out;
}

/* ---------- browser ---------- */
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));
const reduced = () => !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
const cap1 = s => { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); };
function chip(status) { const t = toneOf(status); return `<span class="b-chip sm t-${t}">${ICON[t]}${esc(cap1(status || 'unavailable'))}</span>`; }
function pips(status) {
  const n = LEVEL[status]; if (!n) return '';
  return `<span class="co-pips t-${toneOf(status)}" role="img" aria-label="${n} of 3">${[1, 2, 3].map(i => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>`;
}
function metricTable(metrics) {
  const ms = (metrics || []).filter(Boolean);
  if (!ms.length) return '<p class="co-na">No measured inputs were attached to this line.</p>';
  return `<table class="co-mt"><thead><tr><th scope="col">Measure</th><th scope="col">Value</th><th scope="col">Period</th><th scope="col">Source</th></tr></thead><tbody>${ms.map(m => {
    const v = fmtMetric(m), u = safeURL(m.source_url);
    return `<tr><td>${esc(m.label)}${m.note ? `<span class="co-mnote">${esc(m.note)}</span>` : ''}</td>
      <td class="v">${v == null ? '<span class="co-na">Not available</span>' : esc(v)}</td>
      <td>${esc(m.period || '')}${m.asof && String(m.asof).slice(0, 10) !== m.period ? `<span class="co-mnote" title="${esc(m.asof)}">retrieved ${esc(String(m.asof).slice(0, 10))}</span>` : ''}</td>
      <td>${u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(m.source || 'Source')}</a>` : esc(m.source || 'Source not stated')}</td></tr>`;
  }).join('')}</tbody></table>`;
}
function cardHtml(key, label, gloss, card, i) {
  const c = card || {status: 'unavailable', line: 'Not available: this assessment is missing from the company file.', metrics: []};
  const st = TONE[c.status] ? c.status : 'unavailable', hl = headline(c, key), id = `co-${key}`;
  return `<article class="co-card co-k-${key} b-card t-${toneOf(st)}${st === 'unavailable' ? ' co-off' : ''}" style="--i:${i}" aria-labelledby="${id}-h">
    <div class="co-face co-front" id="${id}-f">
      <header class="co-ch"><h3 id="${id}-h" title="${esc(gloss)}">${esc(label)}</h3>${chip(st)}</header>
      ${hl ? `<p class="co-hl"><b>${esc(hl.value)}</b><span>${esc(hl.label)}${hl.period ? ', ' + esc(hl.period) : ''}</span></p>` : ''}
      <p class="co-line">${esc(c.line || 'Not available')}</p>
      <footer class="co-cf">${pips(st)}<button type="button" class="co-flip" aria-expanded="false" aria-controls="${id}-b">Numbers</button></footer>
    </div>
    <div class="co-face co-back" id="${id}-b" hidden>
      <header class="co-ch"><h3>${esc(label)}: inputs</h3><button type="button" class="co-flip" aria-expanded="true" aria-controls="${id}-b">Back</button></header>
      ${metricTable(c.metrics)}
    </div></article>`;
}
function lineRow(id, title, obj, extra) {
  const o = obj || {};
  const hasM = (o.metrics || []).length;
  return `<section class="co-row b-card" aria-labelledby="${id}-h">
    <div class="co-rowmain"><h2 id="${id}-h">${esc(title)}</h2>${o.status ? chip(o.status === 'ok' ? 'ok' : o.status) : ''}
      <p class="co-line">${esc(o.line || 'Not available')}</p>${extra || ''}
      ${hasM ? `<button type="button" class="co-flip co-flip-row" aria-expanded="false" aria-controls="${id}-m">Numbers</button>` : ''}</div>
    ${hasM ? `<div class="co-rowm" id="${id}-m" hidden>${metricTable(o.metrics)}</div>` : ''}</section>`;
}
const jcache = {};
function getJSON(url) {
  if (jcache[url]) return jcache[url];
  const p = fetch(url, {cache: 'no-store'}).then(r => { if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; } return r.json(); });
  jcache[url] = p; p.catch(() => { delete jcache[url]; });
  return p;
}
function coreRow(t) {
  try { const d = root.SO2 && root.SO2.D && root.SO2.D(); if (d && d.rows) return Promise.resolve(d.rows.find(r => r.t === t) || null); } catch (e) { /* SO2 absent */ }
  return getJSON('data/core.json').then(d => (d.rows || []).find(r => r.t === t) || null).catch(() => null);
}
function flip(btn, el) {
  const card = btn.closest('.co-card');
  if (card) {
    const front = card.querySelector('.co-front'), back = card.querySelector('.co-back'), toBack = !back.hidden ? false : true;
    const swap = () => {
      front.hidden = toBack; back.hidden = !toBack; card.classList.toggle('co-open', toBack);
      card.querySelectorAll('.co-flip').forEach(b => b.setAttribute('aria-expanded', String(toBack)));
      const f = (toBack ? back : front).querySelector('.co-flip'); if (f) f.focus({preventScroll: true});
    };
    if (reduced()) return swap();
    card.classList.add('co-turn-out');
    setTimeout(() => { swap(); card.classList.remove('co-turn-out'); card.classList.add('co-turn-in'); setTimeout(() => card.classList.remove('co-turn-in'), 200); }, 140);
    return;
  }
  const box = el.querySelector('#' + btn.getAttribute('aria-controls')); if (!box) return;
  const open = box.hidden; box.hidden = !open; btn.setAttribute('aria-expanded', String(open)); btn.textContent = open ? 'Hide numbers' : 'Numbers';
}

function mount(el, ticker, opts) {
  opts = opts || {};
  const t = String(ticker || '').toUpperCase();
  if (el.__soCo && el.__soCo.destroy) el.__soCo.destroy();
  const st = {alive: true, chart: null};
  el.classList.add('so-co');
  el.innerHTML = `<div class="co-head b-card co-skel" aria-busy="true"><div class="sk w40"></div><div class="sk w70"></div></div>
    <div class="co-grid">${CARDS.map(() => '<div class="co-card b-card co-skel"><div class="sk w40"></div><div class="sk w90"></div><div class="sk w70"></div></div>').join('')}</div>`;
  const url = (opts.url || root.SO_COMPANY_URL || 'data/brief/company/{T}.json').replace('{T}', encodeURIComponent(t));
  const ready = Promise.all([
    getJSON(url).then(d => ({ok: true, d}), e => ({ok: false, err: e})),
    coreRow(t),
    fetch('data/quotes.json', {cache: 'no-store'}).then(r => r.ok ? r.json() : null).catch(() => null),
  ]).then(([res, row, quotes]) => {
    if (!st.alive) return;
    const d = res.ok ? res.d : null, q = quotes && quotes.quotes ? quotes.quotes[t] : null;
    if (!d && !row) {
      el.innerHTML = `<section class="co-head b-card" role="alert"><h1 class="co-h1">${esc(t)}</h1><p class="co-na">Not available: ${esc(t)} is not in this build's universe (no company file and no price row).</p></section>`;
      return;
    }
    const FC = root.SmartOptionsChart;
    const fr = FC && FC.freshness ? FC.freshness(q, quotes) : {word: 'missing', cls: 'missing', text: 'Not available'};
    const qOk = q && isNum(q.price) && q.status === 'ok';
    const price = qOk ? q.price : row && isNum(row.px) ? row.px : null;
    const chg = qOk && isNum(q.chg_pct) ? q.chg_pct : row && isNum(row.d1) ? row.d1 : null;
    const priceSrc = qOk ? `${q.provider || (quotes && quotes.source) || 'quote feed'}, ${fmtET(q.ts)}` : row ? `Close ${row.pxd || ''}, Yahoo Finance via yfinance` : '';
    const frWord = qOk ? fr.word : row ? 'closed' : 'missing';
    const frCls = {live: 'good', 'delayed 15m': 'mixed', delayed: 'mixed', closed: 'none', stale: 'bad', missing: 'none'}[frWord] || 'none';
    const tl = d ? tally(d) : null;
    const name = (d && d.name) || (row && row.n) || t, sector = (d && d.sector) || (row && row.sec) || '';
    el.innerHTML = `
      <header class="co-head b-card co-in" style="--i:0">
        <div class="co-id"><h1 class="co-h1">${esc(name)} <span class="co-t">${esc(t)}</span></h1>
          <p class="co-sub">${esc(sector)}${row && row.ind ? ' · ' + esc(row.ind) : ''}</p></div>
        <div class="co-px"><b class="co-price" data-v="${isNum(price) ? price : ''}">${isNum(price) ? '$' + price.toFixed(2) : 'Not available'}</b>
          ${isNum(chg) ? `<span class="co-chg ${chg >= 0 ? 'up' : 'dn'}">${chg >= 0 ? '+' : '−'}${Math.abs(chg).toFixed(2)}% today</span>` : ''}
          <span class="b-chip sm t-${frCls}" title="${esc(qOk ? fr.text : 'No current quote; showing the last close')}">${ICON[frCls]}${esc(cap1(frWord))}</span>
          <span class="co-src">${esc(priceSrc)}</span></div>
        <p class="co-sum">${esc(d ? d.summary : 'Assessment not available for this name yet.')}</p>
        ${tl ? `<p class="co-tally" aria-label="Assessment counts">${['strong', 'ok', 'weak', 'unavailable'].filter(k => tl[k]).map(k => `<span class="t-${TONE[k]}">${tl[k]} ${k === 'ok' ? 'ok' : k}</span>`).join('')}<span class="co-asof">as of ${esc(d.asof || '')}</span></p>` : ''}
      </header>
      ${d ? `<div class="co-grid">${CARDS.map(([k, l, g], i) => cardHtml(k, l, g, d.cards && d.cards[k], i + 1)).join('')}</div>`
        : `<section class="co-row b-card co-off" role="status"><h2>Assessment</h2><p class="co-na">Not available: no company file for ${esc(t)} in this build (${esc(res.err && res.err.message || 'missing')}). Price and chart below still use live data.</p></section>`}
      <section class="co-chartbox b-card co-in" style="--i:8" aria-labelledby="co-ch-h"><h2 id="co-ch-h">Chart</h2><div class="co-chart"></div></section>
      ${d ? lineRow('co-tech', 'Technical setup', d.technical) : ''}
      ${d ? lineRow('co-ev', 'Event risk', {line: d.events && d.events.line, metrics: [].concat(...((d.events && d.events.items) || []).map(x => x.metrics || []))}) : ''}
      ${lineRow('co-opt', 'Options considerations', {line: d && d.options ? d.options.line : 'Not available: no options note for this name.'},
        `<a class="co-strat" href="#/research/markets?t=${encodeURIComponent(t)}" data-strat="${esc(t)}">Open strategies for ${esc(t)}</a>`)}`;
    el.querySelectorAll('.co-grid .co-card, .co-row').forEach((n, i) => { n.classList.add('co-in'); n.style.setProperty('--i', String(i + 1)); });
    if (!reduced()) countUp(el.querySelector('.co-price'));
    const chartEl = el.querySelector('.co-chart');
    const evs = d && d.events && d.events.items ? d.events.items.filter(x => x.when_et).map(x => ({date: String(x.when_et).slice(0, 10), kind: x.kind || 'earnings', label: x.kind === 'earnings' ? 'Next earnings' : x.title, source: (x.metrics && x.metrics[0] && x.metrics[0].note) || ''})) : [];
    if (FC && FC.mount) FC.mount(chartEl, t, {events: evs}).then(h => { if (st.alive) st.chart = h; else if (h && h.destroy) h.destroy(); }).catch(e => { chartEl.innerHTML = `<p class="co-na" role="alert">Chart not available: ${esc(e && e.message || e)}</p>`; });
    else chartEl.innerHTML = '<p class="co-na">Chart not available: the chart module did not load.</p>';
  });
  const onClick = e => {
    const b = e.target.closest('.co-flip'); if (b) { flip(b, el); return; }
    const s = e.target.closest('[data-strat]');
    if (s) { // land on the research desk, then open the ticker's Strategies sub-tab once it exists
      const tk = s.dataset.strat; let n = 0;
      const tryOpen = () => { const A = root.SmartOptionsAPI; if (A && A.open_ticker_tab) { try { A.open_ticker_tab(tk, 'strategies'); return; } catch (err) { /* desk not mounted yet */ } } if (++n < 40) setTimeout(tryOpen, 100); };
      setTimeout(tryOpen, 50);
    }
  };
  el.addEventListener('click', onClick);
  const api = {ready, destroy() { st.alive = false; el.removeEventListener('click', onClick); if (st.chart && st.chart.destroy) st.chart.destroy(); el.innerHTML = ''; el.classList.remove('so-co'); el.__soCo = null; }};
  el.__soCo = api;
  return api;
}
function fmtET(ts) {
  const d = new Date(ts); if (!ts || isNaN(d)) return 'time not stated';
  try { return d.toLocaleString('en-US', {timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}) + ' ET'; } catch (e) { return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; }
}
function countUp(node) {
  const v = node && parseFloat(node.dataset.v); if (!isNum(v)) return;
  const t0 = performance.now(), dur = 600;
  const step = now => { const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3); node.textContent = '$' + (v * e).toFixed(2); if (k < 1) requestAnimationFrame(step); else node.textContent = '$' + v.toFixed(2); };
  requestAnimationFrame(step);
}

const API = {CARDS, TONE, fmtMetric, headline, tally, safeURL, mount};
if (typeof module !== 'undefined' && module.exports) module.exports = API;
root.SmartOptionsCompany = API;
})(typeof window !== 'undefined' ? window : globalThis);
