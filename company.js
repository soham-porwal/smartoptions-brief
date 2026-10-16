/* Company workspace (lane UI2). window.SmartOptionsCompany.mount(el, ticker, opts) -> {ready, updateQuotes, destroy}
   Compact header (price, change, "as of HH:MM ET", provider, freshness) with a one-line verdict and its reason,
   live key numbers that recompute on every quote (P/E, PEG, 52-week position, distance to the 50 and 200-day
   averages, support / resistance, analyst target, days to earnings), seven assessment cards that flip to their
   measured inputs (bottom sheet on phones), the chart, what moves the stock (measured macro relationships), and
   setup / events / options together. Sentences come from the JSON (Python templates); this file computes only
   price-dependent arithmetic and lays things out.
   Also window.SO2.Watchlist.render(el, opts): Historical watchlist table (price, P/E, PEG, 52-week range, next
   earnings, analyst sentiment), live-updating, two-line rows on phones. */
(function (root) {
'use strict';
const isNum = x => typeof x === 'number' && isFinite(x);
const CARDS = [
  ['growth', 'Growth', 'Revenue and earnings per share against the same period a year earlier.'],
  ['profitability', 'Profitability', 'Operating margin (return on equity for banks) and whether it is widening or narrowing.'],
  ['cash', 'Cash generation', 'Free cash flow and how much of reported profit turns into cash.'],
  ['resilience', 'Financial resilience', 'Debt, liquidity and ability to cover interest.'],
  ['valuation', 'Valuation', 'Price against earnings, compared with sector peers and its own history.'],
  ['expectations', 'Expectations', 'Whether analysts are raising or cutting earnings estimates.'],
  ['counter', 'Counterargument', 'The strongest measured evidence against owning it.'],
];
const TONE = {strong: 'good', ok: 'mixed', weak: 'bad', unavailable: 'none'};
const ICON = {
  good: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M4.8 8.3l2.1 2.1 4.3-4.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  mixed: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 1a7 7 0 0 1 0 14z" fill="currentColor"/></svg>',
  bad: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.6l6.8 12.2H1.2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M8 6.2v3.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="11.9" r="1" fill="currentColor"/></svg>',
  none: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.4 2.2"/></svg>',
};
const ASK = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 4.5h13v8.5h-7l-3.5 3v-3h-2.5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M7 8.8h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const FRESH_TONE = {live: 'good', delayed: 'mixed', 'delayed 15m': 'mixed', closed: 'none', snapshot: 'none', stale: 'bad', missing: 'none'};
const FACTOR_LABEL = {spy: 'S&P 500 (SPY)', us10y_bps: '10-year Treasury yield', dxy: 'US dollar index', wti: 'WTI oil', vix: 'VIX volatility', hy_oas: 'High-yield credit spread', gold: 'Gold', copper: 'Copper'};

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
  if (Math.abs(v) >= 1e6 && !/revision|count|dimension/i.test(u)) return big(v) + (u ? ' ' + u : '');
  if (Number.isInteger(v) || /revision|count|dimension/i.test(u)) return Math.round(v) + (u ? ' ' + u : '');
  return (Math.abs(v) >= 1e6 ? big(v) : String(+v.toFixed(2))) + (u ? ' ' + u : '');
}
/* headline(card): the first metric with a value, shown large on the card front */
function headline(card, key) {
  if (!card || card.status === 'unavailable' || key === 'counter') return null;
  if (key === 'expectations') { // revisions read as a pair: "1 up / 3 down"
    const ms = card.metrics || [], up = ms.find(x => /revisions up/i.test(x.label || '')), dn = ms.find(x => /revisions down/i.test(x.label || ''));
    if (up && dn && isNum(up.value) && isNum(dn.value)) return {label: 'EPS estimate revisions', value: `${Math.round(up.value)} up / ${Math.round(dn.value)} down`, period: up.period || ''};
  }
  const m = (card.metrics || []).find(x => fmtMetric(x) != null && x.unit !== 'date');
  if (!m) return null;
  const u = String(m.unit || ''), plain = isNum(m.value) && u && !/^(%|pp|x|USD|USD\/share)$/i.test(u);
  return {label: m.label, value: plain && Math.abs(m.value) < 1e6 ? String(Math.round(m.value * 100) / 100) : fmtMetric(m), period: m.period || ''};
}
function safeURL(u) { return /^https:\/\/[^\s"'<>]+$/i.test(String(u || '')) ? String(u) : null; }
const toneOf = s => TONE[s] || 'none';
/* tally(doc): counts by status across the six measured cards (counterargument excluded) */
function tally(doc) {
  const out = {strong: 0, ok: 0, weak: 0, unavailable: 0};
  for (const [k] of CARDS) { if (k === 'counter') continue; const s = doc && doc.cards && doc.cards[k] && doc.cards[k].status; out[TONE[s] ? s : 'unavailable']++; }
  return out;
}
const pct = (a, b) => isNum(a) && isNum(b) && b > 0 ? 100 * (a / b - 1) : null;
const sgnPct = (v, d) => !isNum(v) ? 'Not available' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d == null ? 1 : d) + '%';
const usd = v => isNum(v) ? '$' + v.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}) : 'Not available';
function etDay(ms) { try { return new Date(ms).toLocaleDateString('en-CA', {timeZone: 'America/New_York'}); } catch (e) { return new Date(ms).toISOString().slice(0, 10); } }
/* daysUntil('2026-11-02', nowMs) -> whole calendar days from today in New York (negative when past) */
function daysUntil(date, nowMs) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(date || ''))) return null;
  const today = etDay(nowMs == null ? Date.now() : nowMs);
  return Math.round((Date.parse(String(date).slice(0, 10) + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 864e5);
}
function smaLast(closes, n) { if (!closes || closes.length < n) return null; let s = 0; for (let i = closes.length - n; i < closes.length; i++) s += closes[i]; return s / n; }
/* levels(bars, srList): the snapshot inputs that live price is compared against */
function levels(bars, sr) {
  const closes = (bars || []).map(b => b[4]).filter(isNum);
  const sup = (sr || []).find(x => x.kind === 'support'), res = (sr || []).find(x => x.kind === 'resistance');
  return {sma50: smaLast(closes, 50), sma200: smaLast(closes, 200), lastBar: bars && bars.length ? bars[bars.length - 1][0] : null,
    support: sup ? sup.price : null, supportTouches: sup ? sup.touches : null, resistance: res ? res.price : null, resistanceTouches: res ? res.touches : null};
}
/* liveStats(row, price, lv, nowMs): every price-dependent number, recomputed from one price.
   Earnings, ratios and averages keep their snapshot inputs; only the price moves. */
function liveStats(row, price, lv, nowMs) {
  row = row || {}; lv = row.basis_warning ? {} : (lv || {});
  const base = isNum(row.px) && row.px > 0 ? row.px : null, k = base && isNum(price) && price > 0 ? price / base : null;
  const out = {price: isNum(price) ? price : null};
  out.pe = k && isNum(row.pe) && row.pe > 0 ? row.pe * k : null;
  out.pef = k && isNum(row.pef) && row.pef > 0 ? row.pef * k : null;
  out.peg = k && isNum(row.peg) && row.peg > 0 ? row.peg * k : null;
  out.pef_sec_med = isNum(row.pef_sec_med) ? row.pef_sec_med : null;
  out.pef_vs_sector = isNum(out.pef) && isNum(row.pef_sec_med) && row.pef_sec_med > 0 ? out.pef / row.pef_sec_med : null;
  out.range_pct = out.from_hi = out.from_lo = out.lo = out.hi = null; out.new_high = out.new_low = false;
  if (isNum(row.lo) && isNum(row.hi) && row.hi > row.lo && isNum(price)) {
    const lo = Math.min(row.lo, price), hi = Math.max(row.hi, price);
    out.range_pct = 100 * (price - lo) / (hi - lo); out.from_hi = pct(price, hi); out.from_lo = pct(price, lo);
    out.lo = lo; out.hi = hi; out.new_high = price > row.hi; out.new_low = price < row.lo;
  }
  out.sma50 = lv.sma50; out.sma200 = lv.sma200;
  out.vs50 = pct(price, lv.sma50); out.vs200 = pct(price, lv.sma200);
  out.support = lv.support; out.resistance = lv.resistance;
  out.to_support = pct(lv.support, price); out.to_resistance = pct(lv.resistance, price);
  out.tgt = isNum(row.tgt) && row.tgt > 0 ? row.tgt : null; out.tgt_up = pct(out.tgt, price);
  out.er = row.er || null; out.er_days = daysUntil(row.er, nowMs);
  out.since_close = pct(price, base);
  out.mcap = k && isNum(row.mcap) && row.mcap > 0 ? row.mcap * k : null;
  return out;
}
/* trendWord(s): above both averages = uptrend, below both = downtrend */
function trendWord(s) {
  if (!s || !isNum(s.vs50) || !isNum(s.vs200)) return null;
  return s.vs50 >= 0 && s.vs200 >= 0 ? 'uptrend' : s.vs50 < 0 && s.vs200 < 0 ? 'downtrend' : 'mixed trend';
}
function currentDocument(doc,s,asof) {
  if(!doc||!s)return doc;
  if(!isNum(s.price)||s.price<=0)return Object.assign({},doc,{cards:Object.assign({},doc.cards,{valuation:{status:'unavailable',line:'Current valuation unavailable: no usable current price.',metrics:[]}})});
  const old=doc.cards&&doc.cards.valuation,med=old&&(old.metrics||[]).find(m=>m.label==='Sector trailing P/E median');
  if(!med||!isNum(med.value)||med.value<=0||!isNum(s.pe))return doc;
  const ratio=s.pe/med.value,status=ratio<=0.8?'strong':ratio>=1.5?'weak':'ok';
  const metrics=(old.metrics||[]).map(m=>m.label==='Trailing P/E'?Object.assign({},m,{value:s.pe,asof,period:asof}):m.label==='Trailing P/E / sector median'?Object.assign({},m,{value:ratio,asof,period:'Latest price / dated sector earnings multiple'}):m);
  return Object.assign({},doc,{cards:Object.assign({},doc.cards,{valuation:Object.assign({},old,{status,line:`Trailing P/E is ${ratio.toFixed(2)} times the dated sector median on the latest price.`,metrics})})});
}
/* verdict(doc, stats): one observed line plus a one or two sentence reason. Deterministic; not advice. */
function verdict(doc, s) {
  doc=currentDocument(doc,s);
  const tl = doc ? tally(doc) : null, cards = (doc && doc.cards) || {};
  const measured = tl ? tl.strong + tl.ok + tl.weak : 0;
  let fund = null, tone = 'none';
  if (measured >= 3) {
    const score = (tl.strong - tl.weak) / measured;
    fund = score >= 0.5 && tl.weak <= 1 ? 'Strong fundamentals' : score <= -0.25 ? 'Weak fundamentals' : 'Mixed fundamentals';
    tone = fund[0] === 'S' ? 'good' : fund[0] === 'W' ? 'bad' : 'mixed';
  }
  const tw = trendWord(s);
  const val = cards.valuation && cards.valuation.status;
  const valWord = val === 'strong' ? 'cheaper than sector peers' : val === 'weak' ? 'priced above sector peers' : val === 'ok' ? 'valued near sector peers' : null;
  const parts = [fund || 'Fundamentals not measured', tw, valWord].filter(Boolean);
  const line = parts.join(', ') + '.';
  if (tw === 'downtrend' && tone === 'good') tone = 'mixed';
  if (tw === 'uptrend' && tone === 'bad') tone = 'mixed';
  // reason: the two strongest facts, then where price sits
  const lead = [];
  const lc1 = x => String(x || '').charAt(0).toLowerCase() + String(x || '').slice(1);
  const best = ['growth', 'profitability', 'cash'].map(k => [k, cards[k]]).filter(([, c]) => c && c.status === 'strong').map(([k, c]) => headline(c, k)).filter(Boolean).slice(0, 2);
  const worst = CARDS.filter(([k]) => k !== 'counter' && cards[k] && cards[k].status === 'weak').map(([, l]) => l.toLowerCase());
  if (tl) lead.push(`${tl.strong + tl.ok} of ${measured || 0} measured areas are strong or ok${best.length ? ', led by ' + best.map(h => lc1(h.label) + ' of ' + h.value).join(' and ') : ''}${worst.length ? '; weak: ' + worst.join(', ') : ''}.`);
  const where = [];
  if (s && isNum(s.from_hi)) where.push(s.new_high ? 'at a new 52-week high' : `${Math.abs(s.from_hi).toFixed(1)}% below its 52-week high`);
  if (tw) where.push(tw === 'uptrend' ? 'above its 50 and 200-day averages' : tw === 'downtrend' ? 'below its 50 and 200-day averages' : `${s.vs50 >= 0 ? 'above' : 'below'} its 50-day and ${s.vs200 >= 0 ? 'above' : 'below'} its 200-day average`);
  let sentence2 = where.length ? 'Price is ' + where.join(' and ') : '';
  if (s && isNum(s.er_days) && s.er_days >= 0 && s.er_days <= 30) sentence2 += (sentence2 ? '; ' : '') + `earnings are due in ${s.er_days} day${s.er_days === 1 ? '' : 's'}`;
  if (sentence2) lead.push(sentence2.charAt(0).toUpperCase() + sentence2.slice(1) + '.');
  return {line, tone, reason: lead.join(' '), fund, trend: tw};
}
/* watchRow(row, q, nowMs): the derived numbers for one watchlist line */
function watchRow(row, q, nowMs) {
  const price = q && isNum(q.price) && q.price > 0 ? q.price : row && isNum(row.px) ? row.px : null;
  const s = liveStats(row, price, null, nowMs);
  s.chg = q && isNum(q.chg_pct) ? q.chg_pct : q && isNum(q.change_pct) ? q.change_pct : !q && row && isNum(row.d1) ? row.d1 : null;
  s.rating = row && row.rating ? String(row.rating).replace(/_/g, ' ') : null; s.analysts = row && isNum(row.nan) ? row.nan : null;
  s.fromQuote = !!(q && isNum(q.price) && q.price > 0);
  return s;
}

/* ---------- browser ---------- */
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));
const impact = () => root.SmartOptionsImpact;
const live = () => (root.SO2 && root.SO2.Live) || root.SmartOptionsLive || null;
const reduced = () => !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
const phone = () => !!(root.matchMedia && root.matchMedia('(max-width: 640px)').matches);
const cap1 = s => { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); };
function chip(status) { const t = toneOf(status); return `<span class="b-chip sm t-${t}">${ICON[t]}${esc(cap1(status || 'unavailable'))}</span>`; }
function metricTable(metrics, full) {
  const ms = (metrics || []).filter(Boolean);
  if (!full && ms.length > 3) return metricTable(ms.slice(0,3), true) + `<details><summary>All ${ms.length} sourced inputs</summary>${metricTable(ms.slice(3), true)}</details>`;
  if (!ms.length) return '<p class="co-na">No measured inputs were attached to this line.</p>';
  return `<table class="co-mt"><thead><tr><th scope="col">Measure</th><th scope="col">Value</th><th scope="col">Period</th><th scope="col">Source</th></tr></thead><tbody>${ms.map(m => {
    const v = fmtMetric(m), u = safeURL(m.source_url);
    return `<tr><td>${impact() && impact().term ? impact().term(m.label) : esc(m.label)}${m.note ? `<span class="co-mnote">${esc(m.note)}</span>` : ''}</td>
      <td class="v">${v == null ? '<span class="co-na">Not available</span>' : esc(v)}</td>
      <td>${esc(m.period || '')}${m.asof && String(m.asof).slice(0, 10) !== m.period ? `<span class="co-mnote" title="${esc(m.asof)}">retrieved ${esc(String(m.asof).slice(0, 10))}</span>` : ''}</td>
      <td>${u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(m.source || 'Source')}</a>` : esc(m.source || 'Source not stated')}</td></tr>`;
  }).join('')}</tbody></table>`;
}
function askBtn(t, key, label) {
  return `<button type="button" class="cp-context co-ask" data-intent="ticker_card" data-entities="${esc(JSON.stringify({tickers: [t], card: key}))}" aria-label="Ask about ${esc(label)}" title="Ask about this">${ASK}</button>`;
}
/* cardHtml: compact front (status, quantifier, one sentence) and a back with the measured inputs */
function cardHtml(key, label, gloss, card, i, snapshotDate, t) {
  const c = card || {status: 'unavailable', line: 'Not available: this assessment is missing from the company file.', metrics: []};
  const st = TONE[c.status] ? c.status : 'unavailable', id = `co-${key}`, h = headline(c, key);
  return `<article class="co-card co-k-${key} t-${toneOf(st)}${st === 'unavailable' ? ' co-off' : ''}" id="${id}" aria-labelledby="${id}-h">
    <div class="co-front">
      <div class="co-ch"><h3 id="${id}-h">${esc(label)}</h3>${chip(st)}${t ? askBtn(t, key, label) : ''}</div>
      ${h ? `<p class="co-hl"><b>${esc(h.value)}</b><span>${esc(h.label)}</span></p>` : ''}
      <p class="co-line">${esc(c.line || 'Not available: no assessment sentence was provided.')}</p>
      ${key === 'valuation' ? `<p class="co-live" data-co-live="val">P/E on the live price appears here once a price loads.</p>` : ''}
      <div class="co-cf"><span class="co-per">${esc(h && h.period || '')}</span>
        <button type="button" class="co-flip" aria-expanded="false" aria-controls="${id}-b">Numbers</button></div>
    </div>
    <div class="co-back" id="${id}-b" role="region" aria-label="${esc(label)}: measured inputs" hidden>
      <div class="co-bh"><h4>${esc(label)}</h4><button type="button" class="co-flip co-close" aria-controls="${id}-b" aria-expanded="true">Close</button></div>
      <p class="co-definition">${esc(gloss)}</p>
      <div class="co-metric-wrap">${metricTable(c.metrics)}</div>
      ${key === 'valuation' ? `<p class="co-mnote">Ratios use the snapshot of ${esc(snapshotDate || 'an unstated date')}. The live P/E on the front rescales the snapshot P/E by live price over snapshot close; earnings are unchanged.</p>` : ''}
    </div></article>`;
}
function lineRow(id, title, obj, extra, deep) {
  const o = obj || {};
  const hasM = (o.metrics || []).length || deep;
  return `<section class="co-row" aria-labelledby="${id}-h">
    <div class="co-rowmain"><div class="co-rowh"><h2 id="${id}-h">${esc(title)}</h2>${o.status ? chip(o.status) : ''}</div>
      <p class="co-line">${esc(o.line || 'Not available')}</p>${extra || ''}
      ${hasM ? `<button type="button" class="co-flip co-flip-row" aria-expanded="false" aria-controls="${id}-m">Numbers</button>` : ''}</div>
    ${hasM ? `<div class="co-rowm" id="${id}-m" hidden>${deep || ''}<div class="co-metric-wrap">${(o.metrics || []).length ? metricTable(o.metrics) : ''}</div></div>` : ''}</section>`;
}
const jcache = {};
function getJSON(url) {
  if (jcache[url]) return jcache[url];
  const p = fetch(url, {cache: 'no-store'}).then(r => { if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; } return r.json(); });
  jcache[url] = p; p.catch(() => { delete jcache[url]; });
  return p;
}
function coreData() { try { const d = root.SO2 && root.SO2.D && root.SO2.D(); if (d && d.rows) return Promise.resolve(d); } catch (e) { /* SO2 not ready */ } return getJSON('data/core.json').catch(() => null); }
function coreRow(t) { return coreData().then(d => d && d.rows ? d.rows.find(r => r.t === t) || null : null); }
function fmtET(ts, nowMs) {
  const L = live(); if (L && L.etLabel) return L.etLabel(ts, nowMs == null ? Date.now() : nowMs);
  const d = new Date(ts); if (!ts || isNaN(d)) return 'time not available';
  try { return 'as of ' + d.toLocaleString('en-US', {timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}) + ' ET'; } catch (e) { return 'as of ' + d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; }
}
/* pickQuote: newest usable observation from SO2.Live, then quotes.json; never a future timestamp */
function pickQuote(t, quotes) {
  const ok = q => q && q.status !== 'missing' && isNum(q.price) && q.price > 0 && isFinite(Date.parse(q.asof_utc || q.ts)) && Date.parse(q.asof_utc || q.ts) <= Date.now() + 60000;
  const L = live(); let lq = null;
  try { lq = L && L.get ? L.get(t) : null; } catch (e) { console.error('[company] live quote read failed', e); }
  const fq = quotes && quotes.quotes ? quotes.quotes[t] : null;
  const a = ok(lq) ? lq : null, b = ok(fq) ? fq : null;
  if (a && b) return Date.parse(a.asof_utc || a.ts) >= Date.parse(b.asof_utc || b.ts) ? a : b;
  return a || b;
}
function freshOf(q, quotes) {
  if(q?.delivery_state==='older')return {word:'older',label:'Older quote',text:'Latest provider report '+(q.asof_utc||q.ts)+'; source checked '+(q.checked_at||q.retrieved_at)};
  if(q?.delivery_state==='blocked')return {word:'blocked',label:'Source wait',text:'Current source request unavailable; original observation retained'};
  if (!q) return {word: 'snapshot', label: 'Last close', text: 'No current quote; showing the snapshot close'};
  const L = live();
  if (L && L.classify) { const c = L.classify(q, Date.now()); return {word: c.word, label: c.label, text: (q.provider || 'Quote feed') + ', ' + fmtET(q.asof_utc || q.ts)}; }
  const FC = root.SmartOptionsChart, f = FC && FC.freshness ? FC.freshness(q, quotes) : {word: 'missing', text: 'Not available'};
  return {word: f.word, label: f.word, text: f.text};
}
function shortProvider(p) {
  p = String(p || ''); if (!p) return 'Provider not stated';
  if (/finnhub/i.test(p)) return 'Finnhub'; if (/alpaca/i.test(p)) return 'Alpaca IEX'; if (/yahoo/i.test(p)) return /delay/i.test(p) ? 'Yahoo, 15 min delayed' : 'Yahoo';
  return p.length > 32 ? p.slice(0, 32) + '…' : p;
}

/* stat tiles: label, value, sub line, and what the flip shows */
function statTiles(s, row) {
  row = row || {};
  const t = [];
  t.push({k: 'pe', label: 'P/E', value: isNum(s.pe) ? s.pe.toFixed(1) : 'Not available', sub: isNum(s.pef) ? `Forward ${s.pef.toFixed(1)}${isNum(s.pef_sec_med) ? ' · sector ' + s.pef_sec_med.toFixed(1) : ''}` : 'Forward not available',
    how: 'Snapshot trailing P/E times live price over snapshot close. Earnings per share stay at the last reported four quarters.',
    inputs: [['Snapshot trailing P/E', isNum(row.pe) ? row.pe.toFixed(2) : 'Not available', row.pxd], ['Snapshot close', usd(row.px), row.pxd], ['Current price', usd(s.price), ''], ['Forward P/E', isNum(s.pef) ? s.pef.toFixed(2) : 'Not available', ''], ['Sector median forward P/E', isNum(s.pef_sec_med) ? s.pef_sec_med.toFixed(2) : 'Not available', row.pxd]],
    src: 'Yahoo Finance via yfinance (ratios); quote feed (price)'});
  t.push({k: 'peg', label: 'PEG', value: isNum(s.peg) ? s.peg.toFixed(2) : 'Not available', sub: isNum(s.peg) ? (s.peg < 1 ? 'Below 1: growth outpaces P/E' : s.peg > 2 ? 'Above 2: P/E outpaces growth' : 'Between 1 and 2') : 'Provider ratio missing',
    how: 'Provider trailing PEG ratio rescaled to the live price. PEG is P/E divided by expected earnings growth.',
    inputs: [['Provider PEG at snapshot', isNum(row.peg) ? row.peg.toFixed(3) : 'Not available', row.pxd], ['Method', row.pegm || 'Not stated', '']], src: 'Yahoo trailingPegRatio'});
  t.push({k: 'range', label: 'From 52-week high', value: isNum(s.from_hi) ? (s.new_high ? 'New high' : sgnPct(s.from_hi)) : 'Not available', bar: isNum(s.range_pct) ? s.range_pct : null,
    sub: isNum(s.lo) ? `${usd(s.lo)} to ${usd(s.hi)}` : '', how: 'Position of the live price between the 52-week low and high. A live price beyond either end moves that end.',
    inputs: [['52-week low', usd(row.lo), row.pxd], ['52-week high', usd(row.hi), row.pxd], ['Position', isNum(s.range_pct) ? Math.round(s.range_pct) + '% of range' : 'Not available', '']], src: 'Yahoo Finance daily bars'});
  t.push({k: 'sma', label: 'vs 50 / 200-day', value: isNum(s.vs50) ? `${sgnPct(s.vs50)} / ${sgnPct(s.vs200)}` : 'Not available', tone: trendWord(s) === 'uptrend' ? 'good' : trendWord(s) === 'downtrend' ? 'bad' : 'mixed',
    sub: isNum(s.sma50) ? `${usd(s.sma50)} / ${isNum(s.sma200) ? usd(s.sma200) : 'n/a'}` : 'Price history not loaded', how: 'Distance of the live price from the simple averages of the last 50 and 200 daily closes.',
    inputs: [['50-day average', usd(s.sma50), ''], ['200-day average', usd(s.sma200), ''], ['Current price', usd(s.price), '']], src: 'Daily closes, Yahoo Finance via yfinance'});
  t.push({k: 'sr', label: 'Support / resistance', value: isNum(s.to_support) || isNum(s.to_resistance) ? `${isNum(s.to_support) ? sgnPct(s.to_support) : 'n/a'} / ${isNum(s.to_resistance) ? sgnPct(s.to_resistance) : 'n/a'}` : 'Not available',
    sub: isNum(s.support) || isNum(s.resistance) ? `${isNum(s.support) ? usd(s.support) : 'none'} / ${isNum(s.resistance) ? usd(s.resistance) : 'none'}` : 'No level with enough touches', how: 'Price levels touched by the most swing highs and lows in the last 120 sessions; distance from the live price.',
    inputs: [['Support', usd(s.support), ''], ['Resistance', usd(s.resistance), '']], src: 'Rule-based reading of daily bars (patterns.js)'});
  t.push({k: 'analyst', label: 'Analyst opinion', value: row.rating ? cap1(String(row.rating).replace(/_/g, ' ')) : 'Not available', sub: isNum(s.tgt) ? `Yahoo consensus · ${row.pxd || 'date unavailable'} · Target ${usd(s.tgt)} (${sgnPct(s.tgt_up)})${s.tgt_up < 0 && /buy/i.test(row.rating || '') ? ' · Rating/target conflict' : ''}${isNum(row.nan) ? ' · ' + row.nan + ' analysts' : ''}` : (row.target_reason || 'Target unavailable; opinion date/count may be missing'),
    how: 'Third-party analyst opinion, not dashboard advice. Date is the dataset observation date, not a verified rating publication date. A Buy rating with a target below the current quote conflicts; inspect both.', inputs: [['Rating', row.rating || 'Not available', row.pxd], ['Mean target', usd(row.tgt), row.pxd], ['Analysts', isNum(row.nan) ? String(row.nan) : 'Not available', row.pxd]], src: 'Yahoo Finance analyst consensus'});
  const big = v => !isNum(v) ? 'Not available' : v >= 1e12 ? '$' + (v / 1e12).toFixed(2) + 'T' : v >= 1e9 ? '$' + (v / 1e9).toFixed(1) + 'B' : '$' + (v / 1e6).toFixed(0) + 'M';
  t.push({k: 'mcap', label: 'Market value', value: big(s.mcap), sub: isNum(s.since_close) ? `${sgnPct(s.since_close, 2)} since the ${row.pxd || 'snapshot'} close` : '', tone: '',
    how: 'Snapshot market capitalisation rescaled by current price over snapshot close (share count unchanged).', inputs: [['Snapshot market cap', big(row.mcap), row.pxd], ['Snapshot close', usd(row.px), row.pxd], ['Current price', usd(s.price), '']], src: 'Yahoo Finance via yfinance'});
  t.push({k: 'er', label: 'Next earnings', value: s.er ? new Date(s.er + 'T12:00:00Z').toLocaleDateString('en-US', {month: 'short', day: 'numeric', timeZone: 'UTC'}) : 'Not available',
    sub: isNum(s.er_days) ? (s.er_days > 0 ? `In ${s.er_days} days` : s.er_days === 0 ? 'Today' : `${-s.er_days} days ago`) + (row.ert ? ' · ' + row.ert : '') : 'Date not announced', tone: isNum(s.er_days) && s.er_days >= 0 && s.er_days <= 14 ? 'mixed' : '',
    how: 'Next expected report date. Dates can be estimates until the company confirms.', inputs: [['Next earnings', row.er || 'Not available', ''], ['Last earnings', row.ler || 'Not available', '']], src: row.ers || 'Yahoo get_earnings_dates'});
  return t;
}
function tileHtml(x) {
  return `<button type="button" class="co-tile${x.tone ? ' t-' + x.tone : ''}" data-stat="${x.k}"><span class="co-tl">${esc(x.label)}</span><b class="co-tv">${esc(x.value)}</b>${x.bar != null ? `<span class="co-rbar" aria-hidden="true"><i style="left:${x.bar.toFixed(1)}%"></i></span>` : ''}<span class="co-ts">${esc(x.sub || '')}</span></button>`;
}
function tileDetail(x, asof) {
  return `<h4>${esc(x.label)}: ${esc(x.value)}</h4><p class="co-definition">${esc(x.how)}</p>
    <table class="co-mt co-mt-s"><tbody>${x.inputs.map(([a, b, d]) => `<tr><td>${esc(a)}</td><td class="v">${esc(b)}</td><td>${esc(d || '')}</td></tr>`).join('')}</tbody></table>
    <p class="co-mnote">Source: ${esc(x.src)}. Price ${esc(asof || '')}.</p>`;
}
/* sensLine(S): one sentence from impact.sensitivities: which links are reliable and whether the recent move helps */
function sensLine(S) {
  if (!S || !S.ok) return 'Not available: ' + ((S && S.reason) || 'no factor regression for this name') + '.';
  const on = S.items.filter(x => x.strength && x.strength !== 'none'), off = S.items.filter(x => !x.strength || x.strength === 'none');
  const parts = on.map(x => String(x.line || '').replace(/\.$/, '') + (x.impact === 'helps' ? ' (recent move helps)' : x.impact === 'hurts' ? ' (recent move hurts)' : ''));
  let out = parts.length ? parts.join('; ') + '.' : 'No reliable link to the tracked macro factors.';
  if (parts.length && off.length) out += ' No reliable link to ' + off.map(x => String(x.f && x.f.name || '').toLowerCase()).filter(Boolean).join(', ') + '.';
  if (S.weakFit) out += ` Overall fit is weak (R² ${isNum(S.r2) ? S.r2.toFixed(2) : 'n/a'}).`;
  return out + ' Associations over matched daily returns, not forecasts.';
}
/* relationships from intelligence.json: largest associated contributions first */
function relRows(intel, t) {
  const c = intel && intel.companies && intel.companies[t];
  if (!c || !Array.isArray(c.relationships)) return {rows: [], residual: null, headline: c && c.headline || null};
  const val = (r, re) => { const e = (r.evidence || []).find(x => re.test(x.label || '')); return e && isNum(e.value) ? e : null; };
  const rows = c.relationships.filter(r => r.factor && !/residual/.test(r.id || '')).map(r => {
    const chg = val(r, /change over/i), beta = val(r, /sensitivity/i), contrib = val(r, /contribution/i);
    return {id: r.id, factor: r.factor, label: FACTOR_LABEL[r.factor] || (intel.sources && intel.sources[r.factor] && intel.sources[r.factor].label) || r.factor,
      chg, beta, contrib, dir: r.direction, kind: r.kind || 'association', summary: r.summary || '', counter: r.counterargument || '', evidence: r.evidence || []};
  }).sort((a, b) => Math.abs(b.contrib ? b.contrib.value : 0) - Math.abs(a.contrib ? a.contrib.value : 0));
  const res = c.relationships.find(r => /residual/.test(r.id || ''));
  return {rows, residual: res || null, headline: c.headline || null};
}
function evUnit(e) { if (!e) return 'Not available'; const u = String(e.unit || ''); return /^%/.test(u) ? sgnPct(e.value, 2) : (e.value > 0 ? '+' : '') + e.value.toFixed(2) + ' ' + u; }
function relHtml(R, intel) {
  if (!R.rows.length) return '<p class="co-na">Not available: no measured macro relationship for this company in this build.</p>';
  return `<ul class="co-rels">${R.rows.slice(0, 5).map((r, i) => {
    const tone = r.dir === 'supportive' ? 'good' : r.dir === 'adverse' ? 'bad' : 'mixed';
    return `<li><button type="button" class="co-rel t-${tone}" data-rel="${i}"><span class="co-rel-f">${esc(r.label)}</span>
      <span class="co-rel-c">${r.chg ? esc(evUnit(r.chg)) : 'n/a'}<em>factor, 20 sessions</em></span>
      <span class="co-rel-a">${r.contrib ? esc(sgnPct(r.contrib.value, 2)) : 'n/a'}<em>associated</em></span>
      <span class="co-rel-d">${esc(r.dir === 'supportive' ? 'Helps' : r.dir === 'adverse' ? 'Hurts' : 'Neutral')}</span></button></li>`;
  }).join('')}</ul>
  <p class="co-mnote">${R.residual ? esc(R.residual.summary) + ' ' : ''}Associations from ${esc((intel && intel.methods && intel.methods.association) ? 'an OLS fit on up to 252 sessions' : 'a historical fit')}, factor data through ${esc(intel && intel.basis && intel.basis.model_asof || 'an unstated date')}. Co-movement, not causation.</p>`;
}
function relDetail(r) {
  return `<h4>${esc(r.label)} and this stock</h4><p>${esc(r.summary.replace(/Ã—/g, '×'))}</p>
    <table class="co-mt co-mt-s"><thead><tr><th>Measure</th><th>Value</th><th>Date</th><th>Source</th></tr></thead><tbody>${r.evidence.map(e => {
      const u = safeURL(e.source_url);
      return `<tr><td>${esc(e.label)}${e.formula ? `<span class="co-mnote">${esc(String(e.formula).replace(/Ã—/g, '×'))}</span>` : ''}</td><td class="v">${isNum(e.value) ? esc(+e.value.toFixed(4) + ' ' + (e.unit || '')) : 'Not available'}</td><td>${esc(e.date || '')}</td><td>${u ? `<a href="${esc(u)}" target="_blank" rel="noopener">Source</a>` : 'Not stated'}</td></tr>`;
    }).join('')}</tbody></table><p class="co-counter"><b>Against this reading.</b> ${esc(r.counter || 'Co-movement is not causation.')}</p>
    <p class="co-mnote">Kind: ${esc(r.kind)}. Not a forecast.</p>`;
}

function mount(el, ticker, opts) {
  opts = opts || {};
  const t = String(ticker || '').toUpperCase();
  if (el.__soCo && el.__soCo.destroy) el.__soCo.destroy();
  const st = {alive: true, chart: null, row: null, quotes: null, doc: null, lv: {}, q: null, unsub: null, tiles: [], rel: null, intel: null, lastFocus: null};
  el.classList.add('so-co');
  el.dataset.ticker = t;
  el.innerHTML = `<div class="co-head co-skel" aria-busy="true"><div class="sk w40"></div><div class="sk w70"></div></div>
    <div class="co-grid">${CARDS.map(() => '<div class="co-card co-skel"><div class="sk w40"></div><div class="sk w90"></div></div>').join('')}</div>`;
  const url = (opts.url || root.SO_COMPANY_URL || 'data/brief/company/{T}.json').replace('{T}', encodeURIComponent(t));
  const L0 = live(); if (L0 && L0.watch) { try { L0.watch('company', [t]); } catch (e) { console.error('[company] live watch failed', e); } }
  const ready = Promise.all([
    getJSON(url).then(d => ({ok: true, d}), e => ({ok: false, err: e})),
    coreRow(t),
    fetch('data/quotes.json', {cache: 'no-store'}).then(r => r.ok ? r.json() : null).catch(e => { console.warn('[company] quotes.json unavailable', e); return null; }),
    getJSON(`data/px/${encodeURIComponent(t)}.json`).catch(() => null),
    getJSON('data/intelligence.json').catch(e => { console.warn('[company] intelligence.json unavailable', e); return null; }),
  ]).then(([res, row, quotes, px, intel]) => {
    if (!st.alive) return;
    st.row = row; st.quotes = quotes; st.intel = intel;
    const d = res.ok ? res.d : null; st.doc = d;
    if (!d && !row) {
      el.innerHTML = `<section class="co-head" role="alert"><h1 class="co-h1">${esc(t)}</h1><p class="co-na">Not available: ${esc(t)} is not in this build's universe (no company file and no price row).</p></section>`;
      return;
    }
    // snapshot levels that the live price is measured against
    const FC = root.SmartOptionsChart, P = root.SmartOptionsPatterns;
    let bars = [];
    try { bars = px && FC && FC.clean ? FC.clean(px.bars).rows : (px && px.bars) || []; } catch (e) { console.error('[company] bar cleaning failed', e); }
    let sr = [];
    try { if (P && P.detect && FC && FC.srLevels && bars.length > 30) sr = FC.srLevels(P.detect(bars, {nextEarnings: row && row.er || null, lastEarnings: row && row.ler || null})); } catch (e) { console.error('[company] support/resistance scan failed', e); }
    st.lv = levels(bars, sr);
    const name = (d && d.name) || (row && row.n) || t, sector = (d && d.sector) || (row && row.sec) || '';
    st.rel = relRows(intel, t);
    el.innerHTML = `
      <header class="co-head co-in" style="--i:0">
        <div class="co-id"><h1 class="co-h1">${esc(name)} <span class="co-t">${esc(t)}</span></h1>
          <p class="co-sub">${esc(sector)}${row && row.ind ? ' · ' + esc(row.ind) : ''}</p></div>
        <div class="co-px" aria-live="polite"></div>
        <div class="co-verdict"></div>
      </header>
      <section class="co-stats co-in" style="--i:1" aria-label="Key numbers on the live price"></section>
      ${d ? `<section class="co-observations co-in" style="--i:2" aria-labelledby="co-fundamentals-h"><div class="co-section-head"><h2 id="co-fundamentals-h">Company assessment</h2><span class="co-asof">${(() => { const tl = tally(d); return ['strong', 'ok', 'weak'].filter(k => tl[k]).map(k => `<span class="t-${TONE[k]}">${tl[k]} ${k}</span>`).join(' ') + (tl.unavailable ? ` <span class="t-none">${tl.unavailable} not available</span>` : ''); })()} · snapshot ${esc(d.asof || 'date unavailable')}</span></div>
        <div class="co-grid">${CARDS.map(([k, l, g], i) => cardHtml(k, l, g, d.cards && d.cards[k], i + 1, d.asof, t)).join('')}</div></section>`
        : `<section class="co-row co-off" role="status"><h2>Assessment</h2><p class="co-na">Not available: no company file for ${esc(t)} in this build (${esc(res.err && res.err.message || 'missing')}). Price and chart below still use live data.</p></section>`}
      <section class="co-chartbox co-in" style="--i:3" aria-labelledby="co-ch-h"><div class="co-section-head"><h2 id="co-ch-h">Chart</h2><span class="co-asof">Tap a bar for that day</span></div><div class="co-chart"></div></section>
      <section class="co-moves co-in" style="--i:4" aria-labelledby="co-moves-h"><div class="co-section-head"><h2 id="co-moves-h">What moves this stock</h2><span class="co-asof">Measured associations, not forecasts</span></div>
        ${relHtml(st.rel, intel)}
        <div id="so-shock-company" class="co-mount"></div>
        ${(() => { const I = impact(); if (!I || !I.sensitivities) return ''; let S; try { S = I.sensitivities(row, root.SO2 && root.SO2.D && root.SO2.D() && root.SO2.D().macro); } catch (e) { console.error('[company] sensitivities failed', e); return lineRow('co-sens', 'Macro sensitivities', {line: 'Not available: the sensitivity calculation failed (' + (e.message || e) + ').'}); }
          return lineRow('co-sens', 'Macro sensitivities', {line: sensLine(S), metrics: I.sensMetrics ? I.sensMetrics(S) : []}, '', I.sensHtml ? I.sensHtml(S) : ''); })()}
        <details class="co-more"><summary>Full relationship detail</summary><div class="in-host" id="co-intelligence"></div></details>
      </section>
      <section class="co-money co-in" style="--i:5" aria-labelledby="co-money-h"><div class="co-section-head"><h2 id="co-money-h">Where money is moving</h2></div><div id="so-money-company" class="co-mount"></div></section>
      <div class="co-trio co-in" style="--i:6">
        ${d ? lineRow('co-tech', 'Technical setup', d.technical) : ''}
        ${d ? lineRow('co-ev', 'Event risk', {line: d.events && d.events.line, metrics: [].concat(...((d.events && d.events.items) || []).map(x => x.metrics || []))}) : ''}
        ${lineRow('co-opt', 'Options considerations', {line: d && d.options ? d.options.line : 'Not available: no options note for this name.'},
          `<a class="co-strat" href="#/research/markets?t=${encodeURIComponent(t)}" data-strat="${esc(t)}">Open strategies for ${esc(t)}</a>`)}
      </div>
      <div class="co-scrim" hidden></div>
      <div class="co-pop" role="dialog" aria-modal="true" aria-label="Details" hidden><div class="co-pop-in"></div><button type="button" class="co-pop-x" aria-label="Close details">Close</button></div>`;
    applyLive(false);
    // optional modules from other lanes
    const shockEl = el.querySelector('#so-shock-company'), S = root.SO2 && root.SO2.Shocks || root.SmartOptionsShocks;
    if (S && S.renderCompany) { try { S.renderCompany(shockEl, t); } catch (e) { console.error('[company] shock view failed', e); shockEl.innerHTML = `<p class="co-na" role="alert">Shock analysis failed to draw: ${esc(e.message || e)}</p>`; } }
    else shockEl.remove();
    const moneyEl = el.querySelector('#so-money-company'), M = root.SO2 && root.SO2.MoneyFlow || root.MoneyFlow;
    if (M && M.renderCompany) { try { M.renderCompany(moneyEl, t); } catch (e) { console.error('[company] money view failed', e); moneyEl.innerHTML = `<p class="co-na" role="alert">Money context failed to draw: ${esc(e.message || e)}</p>`; } }
    else moneyEl.innerHTML = `<p class="co-na">Not available for single companies in this build yet. Market-wide flows are on the <a href="#/flows">money page</a>.</p>`;
    const more = el.querySelector('.co-more');
    if (more) more.addEventListener('toggle', () => { if (more.open && !more.dataset.done && root.SmartOptionsIntelligence) { more.dataset.done = '1'; root.SmartOptionsIntelligence.renderCompany(el.querySelector('#co-intelligence'), t); } });
    if (impact() && impact().flushPending) impact().flushPending();
    const chartEl = el.querySelector('.co-chart');
    const evs = d && d.events && d.events.items ? d.events.items.filter(x => x.when_et).map(x => ({date: String(x.when_et).slice(0, 10), kind: x.kind || 'earnings', label: x.kind === 'earnings' ? 'Next earnings' : x.title, source: (x.metrics && x.metrics[0] && x.metrics[0].note) || ''})) : [];
    if (FC && FC.mount) FC.mount(chartEl, t, {events: evs}).then(h => { if (st.alive) { st.chart = h; if (h && h.updateQuotes) h.updateQuotes(snapshotQuotes()); } else if (h && h.destroy) h.destroy(); }).catch(e => { console.error('[company] chart failed', e); chartEl.innerHTML = `<p class="co-na" role="alert">Chart not available: ${esc(e && e.message || e)}</p>`; });
    else chartEl.innerHTML = '<p class="co-na">Chart not available: the chart module did not load.</p>';
    const L = live();
    if (L && L.subscribe) st.unsub = L.subscribe(ev => { if (!st.alive) return; if (!ev || !ev.changed || ev.changed.includes(t) || ev.source === 'file-first') applyLive(true); });
  });
  function snapshotQuotes() { const q = st.q; return q ? {quotes: {[t]: q}, session: st.quotes && st.quotes.session} : st.quotes; }
  /* applyLive: one price drives the header, the tiles, the verdict reason and the valuation line */
  function applyLive(flash) {
    if (!st.alive) return;
    const q = pickQuote(t, st.quotes), row = st.row || {};
    const prevPrice = st.q && st.q.price;
    st.q = q;
    const price = q?.current_usable===false ? null : q ? q.price : isNum(row.px) ? row.px : null;
    const chg = q && isNum(q.chg_pct) ? q.chg_pct : q && isNum(q.change_pct) ? q.change_pct : !q && isNum(row.d1) ? row.d1 : null;
    const fr = freshOf(q, st.quotes), ftone = FRESH_TONE[fr.word] || 'none';
    const px = el.querySelector('.co-px');
    if (px) {
      px.innerHTML = `<b class="co-price">${isNum(price) ? usd(price) : 'Not available'}</b>
        ${isNum(chg) ? `<span class="co-chg ${chg >= 0 ? 'up' : 'dn'}">${sgnPct(chg, 2)}</span>` : ''}
        <span class="co-src" title="${esc(fr.text)}">${q ? esc(shortProvider(q.provider)) : 'Price source unavailable'}</span>`;
      if (flash && isNum(prevPrice) && isNum(price) && prevPrice !== price && !reduced() && px.animate) px.querySelector('.co-price').animate([{backgroundColor: price > prevPrice ? 'var(--b-good-bg, #e3f1e8)' : 'var(--b-bad-bg, #f7e2df)'}, {backgroundColor: 'transparent'}], {duration: 600, easing: 'ease-out'});
    }
    let context=el.querySelector('.co-live-context');if(!context){context=root.document.createElement('p');context.className='co-live-context co-src';el.querySelector('.co-head')?.appendChild(context);}const engine=live();if(context&&engine?.currentContext)context.textContent=engine.currentContext(t,engine.snapshot(),st.intel?.companies?.[t]?.model_asof);
    const s = liveStats(row, price, st.lv, Date.now());
    const current=currentDocument(st.doc,s,q&&(q.asof_utc||q.ts));
    const card=el.querySelector('#co-valuation'); if(card&&current&&current.cards&&current.cards.valuation){const open=card.classList.contains('co-open');const wrap=root.document.createElement('div');const entry=CARDS.find(x=>x[0]==='valuation');wrap.innerHTML=cardHtml('valuation',entry[1],entry[2],current.cards.valuation,4,st.doc.asof_session,t);card.replaceWith(wrap.firstElementChild);if(open)setCard(el.querySelector('#co-valuation'),true);}
    const V = verdict(current, s), vEl = el.querySelector('.co-verdict');
    if (vEl) { vEl.className = 'co-verdict t-' + V.tone; vEl.innerHTML = `<p class="co-vl">${esc(V.line)}</p><p class="co-vr">${esc(V.reason)}</p>`; }
    st.tiles = statTiles(s, row);
    const box = el.querySelector('.co-stats');
    if (box) box.innerHTML = st.tiles.map(tileHtml).join('');
    const vl = el.querySelector('[data-co-live="val"]');
    if (vl) vl.textContent = isNum(s.pe) ? `P/E ${s.pe.toFixed(1)} on the ${q ? 'current' : 'closing'} price of ${usd(price)}${isNum(s.pef_vs_sector) ? '; forward P/E is ' + s.pef_vs_sector.toFixed(2) + ' times the sector median' : ''}.` : 'P/E on the current price: Not available (no positive trailing earnings).';
    if (st.chart && st.chart.updateQuotes && q) st.chart.updateQuotes(snapshotQuotes());
  }
  /* sheets: card backs on phones, tile and relationship details everywhere */
  function lock(on) { try { root.document.documentElement.classList.toggle('co-lock', !!on); } catch (e) { console.error('[company] scroll lock failed', e); } }
  function openPop(html, from) {
    const pop = el.querySelector('.co-pop'), scrim = el.querySelector('.co-scrim'); if (!pop) return;
    st.lastFocus = from || null;
    pop.querySelector('.co-pop-in').innerHTML = html; pop.hidden = false; scrim.hidden = false; lock(true);
    pop.querySelector('.co-pop-x').focus({preventScroll: true});
  }
  function closeAll() {
    const pop = el.querySelector('.co-pop'), scrim = el.querySelector('.co-scrim');
    if (pop) pop.hidden = true;
    el.querySelectorAll('.co-card.co-open').forEach(c => setCard(c, false));
    if (scrim) scrim.hidden = true; lock(false);
    if (st.lastFocus && st.lastFocus.isConnected) st.lastFocus.focus({preventScroll: true}); st.lastFocus = null;
  }
  function setCard(card, open) {
    const front = card.querySelector('.co-front'), back = card.querySelector('.co-back'), btn = front.querySelector('.co-flip');
    const sheet = phone();
    card.classList.toggle('co-open', open); back.classList.toggle('co-sheet', open && sheet);
    back.hidden = !open; front.hidden = open && !sheet; btn.setAttribute('aria-expanded', String(open));
    const scrim = el.querySelector('.co-scrim');
    if (sheet && scrim) { scrim.hidden = !open; lock(open); }
    if (open) { if (!reduced() && back.animate) back.animate(sheet ? [{transform: 'translateY(40px)', opacity: 0}, {transform: 'none', opacity: 1}] : [{transform: 'rotateY(-12deg)', opacity: 0}, {transform: 'none', opacity: 1}], {duration: 220, easing: 'ease-out'}); back.querySelector('.co-close').focus({preventScroll: true}); }
    else if (btn.isConnected) btn.focus({preventScroll: true});
  }
  const onClick = e => {
    const ask = e.target.closest('.co-ask'); if (ask) return; // chat-popup handles .cp-context
    const b = e.target.closest('.co-flip');
    if (b) {
      const card = b.closest('.co-card');
      if (card) { el.querySelectorAll('.co-card.co-open').forEach(c => { if (c !== card) setCard(c, false); }); setCard(card, !card.classList.contains('co-open')); return; }
      const box = el.querySelector('#' + b.getAttribute('aria-controls')); if (!box) return;
      const open = box.hidden; box.hidden = !open; b.setAttribute('aria-expanded', String(open)); b.textContent = open ? 'Hide numbers' : 'Numbers'; return;
    }
    const tile = e.target.closest('[data-stat]');
    if (tile) { const x = st.tiles.find(y => y.k === tile.dataset.stat); if (x) openPop(tileDetail(x, st.q ? fmtET(st.q.asof_utc || st.q.ts) + ', ' + shortProvider(st.q.provider) : 'snapshot close'), tile); return; }
    const rel = e.target.closest('[data-rel]');
    if (rel && st.rel) { const r = st.rel.rows[+rel.dataset.rel]; if (r) openPop(relDetail(r), rel); return; }
    if (e.target.closest('.co-pop-x') || e.target.closest('.co-scrim')) { closeAll(); return; }
    const s = e.target.closest('[data-strat]');
    if (s) { // land on the research desk, then open the ticker's Strategies sub-tab once it exists
      const tk = s.dataset.strat; let n = 0;
      const tryOpen = () => { const A = root.SmartOptionsAPI; if (A && A.open_ticker_tab) { try { A.open_ticker_tab(tk, 'strategies'); return; } catch (err) { /* desk not mounted yet */ } } if (++n < 40) setTimeout(tryOpen, 100); };
      setTimeout(tryOpen, 50);
    }
  };
  const onKey = e => { if (e.key === 'Escape' && (el.querySelector('.co-card.co-open') || !(el.querySelector('.co-pop') || {}).hidden)) { closeAll(); e.stopPropagation(); } };
  el.addEventListener('click', onClick);
  el.addEventListener('keydown', onKey);
  function updateQuotes(quotes) {
    if (!st.alive) return false;
    const q = quotes && quotes.quotes && quotes.quotes[t], previous = st.q;
    const asof = q && Date.parse(q.asof_utc || q.ts), last = previous && Date.parse(previous.asof_utc || previous.ts);
    if (!q || q.status === 'missing' || !isNum(q.price) || q.price <= 0 || !isFinite(asof) || asof > Date.now() + 60000 || isFinite(last) && asof < last) return false;
    st.quotes = quotes; applyLive(true);
    return true;
  }
  const api = {ready, updateQuotes, destroy() { st.alive = false; if (st.unsub) st.unsub(); lock(false); el.removeEventListener('click', onClick); el.removeEventListener('keydown', onKey); if (st.chart && st.chart.destroy) st.chart.destroy(); el.innerHTML = ''; el.classList.remove('so-co'); el.__soCo = null; }};
  el.__soCo = api;
  return api;
}

/* ---------- watchlist (Historical: price, P/E, PEG, 52-week range, next earnings, analyst sentiment) ---------- */
function watchTickers(opts) {
  if (opts && Array.isArray(opts.tickers)) return opts.tickers.map(x => String(x).toUpperCase());
  try { const W = root.SmartOptionsWatchlist; return (W && W.get ? W.get() : JSON.parse(root.localStorage.getItem('so_watchlist_v1') || '[]')).map(x => String(x).toUpperCase()); }
  catch (e) { console.error('[watchlist] stored list unreadable', e); return []; }
}
function watchLineHtml(row, s, q) {
  const t = row.t, er = s.er ? new Date(s.er + 'T12:00:00Z').toLocaleDateString('en-US', {month: 'short', day: 'numeric', timeZone: 'UTC'}) : null;
  const rate = s.rating ? cap1(s.rating) : null, rtone = /buy/i.test(s.rating || '') ? 'good' : /sell|under/i.test(s.rating || '') ? 'bad' : 'mixed';
  return `<tr data-t="${esc(t)}"><th scope="row"><a href="#/company/${encodeURIComponent(t)}"><b>${esc(t)}</b><span>${esc(row.n || '')}</span></a></th>
    <td class="wl-px"><b>${usd(s.price)}</b><span class="${isNum(s.chg) ? (s.chg >= 0 ? 'up' : 'dn') : ''}">${isNum(s.chg) ? sgnPct(s.chg, 2) : ''}</span></td>
    <td class="wl-n" data-l="P/E">${isNum(s.pe) ? s.pe.toFixed(1) : '<span class="co-na">n/a</span>'}</td>
    <td class="wl-n" data-l="PEG">${isNum(s.peg) ? s.peg.toFixed(2) : '<span class="co-na">n/a</span>'}</td>
    <td class="wl-r" data-l="52w">${isNum(s.range_pct) ? `<span class="co-rbar" title="${esc(usd(s.lo) + ' to ' + usd(s.hi))}"><i style="left:${s.range_pct.toFixed(1)}%"></i></span><span>${s.new_high ? 'New high' : sgnPct(s.from_hi) + '<i class="wl-x"> from high</i>'}</span>` : '<span class="co-na">n/a</span>'}</td>
    <td data-l="Earnings">${er ? `${esc(er)}<span>${isNum(s.er_days) && s.er_days >= 0 ? 'in ' + s.er_days + 'd' : ''}</span>` : '<span class="co-na">Not announced</span>'}</td>
    <td data-l="Analysts">${rate ? `<span class="wl-rate t-${rtone}">${esc(rate)}</span><span>${isNum(s.tgt_up) ? sgnPct(s.tgt_up) + '<i class="wl-x"> to target</i>' : ''}${isNum(s.analysts) ? '<i class="wl-x"> · ' + s.analysts + ' analysts</i>' : ''}</span>` : '<span class="co-na">n/a</span>'}</td></tr>`;
}
function renderWatchlist(el, opts) {
  opts = opts || {};
  if (el.__soWl && el.__soWl.destroy) el.__soWl.destroy();
  const st = {alive: true, unsub: null, quotes: null, rows: []};
  el.classList.add('so-wl');
  el.innerHTML = '<p class="co-na">Loading watchlist.</p>';
  const draw = () => {
    if (!st.alive) return;
    const tickers = watchTickers(opts);
    if (!tickers.length) { el.innerHTML = `<p class="co-na">${esc(opts.empty || 'Your watchlist is empty. Open a company and add it, or ask the chat to build one.')}</p>`; return; }
    const by = {}; st.rows.forEach(r => { by[r.t] = r; });
    const now = Date.now(); let newest = null;
    const lines = tickers.map(t => {
      const row = by[t]; if (!row) return `<tr data-t="${esc(t)}"><th scope="row"><b>${esc(t)}</b></th><td colspan="6" class="co-na">Not available: not in this build's universe.</td></tr>`;
      const q = pickQuote(t, st.quotes); if (q && (!newest || Date.parse(q.asof_utc || q.ts) > Date.parse(newest.asof_utc || newest.ts))) newest = q;
      return watchLineHtml(row, watchRow(row, q, now), q);
    });
    const fr = freshOf(newest, st.quotes);
    el.innerHTML = `      <table class="wl-t"><thead><tr><th scope="col">Company</th><th scope="col">Price</th><th scope="col">P/E</th><th scope="col">PEG</th><th scope="col">52-week range</th><th scope="col">Next earnings</th><th scope="col">Analysts</th></tr></thead><tbody>${lines.join('')}</tbody></table>`;
  };
  const ready = Promise.all([coreData(), fetch('data/quotes.json', {cache: 'no-store'}).then(r => r.ok ? r.json() : null).catch(e => { console.warn('[watchlist] quotes.json unavailable', e); return null; })])
    .then(([core, quotes]) => {
      if (!st.alive) return;
      st.rows = core && core.rows ? core.rows : []; st.quotes = quotes;
      if (!st.rows.length) { el.innerHTML = '<p class="co-na" role="alert">Not available: the company table did not load.</p>'; return; }
      const L = live();
      if (L && L.watch) { try { L.watch('watchlist', watchTickers(opts)); } catch (e) { console.error('[watchlist] live watch failed', e); } }
      if (L && L.subscribe) st.unsub = L.subscribe(() => draw());
      draw();
    });
  const onStore = e => { if (!e || e.key === 'so_watchlist_v1') draw(); };
  if (root.addEventListener) root.addEventListener('storage', onStore);
  const api = {ready, refresh: draw, updateQuotes(q) { st.quotes = q; draw(); }, destroy() { st.alive = false; if (st.unsub) st.unsub(); if (root.removeEventListener) root.removeEventListener('storage', onStore); el.innerHTML = ''; el.classList.remove('so-wl'); el.__soWl = null; }};
  el.__soWl = api;
  return api;
}
const Watchlist = {render: renderWatchlist, row: watchRow};

const API = {CARDS, TONE, fmtMetric, headline, tally, safeURL, mount, cardHtml, metricTable, liveStats, levels, currentDocument, verdict, trendWord, daysUntil, statTiles, relRows, sensLine, watchRow, Watchlist};
if (typeof module !== 'undefined' && module.exports) module.exports = API;
root.SmartOptionsCompany = API;
// app.js replaces window.SO2 when it loads; attach now and again once the page has loaded
const attach = () => { if (root.SO2 && !root.SO2.Watchlist) root.SO2.Watchlist = Watchlist; };
root.SmartOptionsWatchlistView = Watchlist;
attach();
if (root.addEventListener && root.document) { root.addEventListener('load', attach); root.document.addEventListener('so2:ready', attach); }
})(typeof window !== 'undefined' ? window : globalThis);
