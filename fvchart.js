/* Finviz-style price chart (lane BU2), on the bundled Lightweight Charts v4.2.
   window.SmartOptionsChart.mount(el, ticker, opts) -> Promise<{setTimeframe, destroy}>
   Candles + volume, SMA 20/50/200, D/W/M, support/resistance from app/patterns.js, earnings markers,
   52-week high/low, last-price line from quotes.json, crosshair OHLC readout, pattern strip.
   Behind toggles: relative strength vs SPY, RSI(14), MACD(12,26,9), events row.
   Data: data/px/<T>.json bars [date, open, high, low, close, volume] (unadjusted daily, Yahoo via yfinance). */
(function (root) {
'use strict';
const isNum = x => typeof x === 'number' && isFinite(x);
const T = (typeof module !== 'undefined' && module.exports) ? require('./technicals.js') : root.SmartOptionsTech;
const COL = {up: '#1f9d55', down: '#e0484d', sma20: '#d29b1d', sma50: '#e0662a', sma200: '#7b52c7', sup: '#1f9d55', res: '#e0484d', last: '#2f5d9e', band: '#8a93a3', rs: '#2f5d9e', rsi: '#7b52c7', macd: '#2f5d9e', sig: '#e0662a'};
const LS = 'so_fv_v1';

/* ---------- pure data prep ---------- */
/* clean(bars): keep rows with a finite close; flag whether real OHLC exists */
function clean(bars) {
  const input = bars || [], seen = new Set();
  let invalidOHLC = 0;
  const rows = input.filter(b => {
    if (!b || !/^\d{4}-\d{2}-\d{2}$/.test(b[0]) || !isNum(b[4]) || b[4] <= 0 || seen.has(b[0])) return false;
    seen.add(b[0]);
    if ([b[1], b[2], b[3]].every(isNum) && (!(b[3] > 0) || b[2] < Math.max(b[1], b[3], b[4]) || b[3] > Math.min(b[1], b[2], b[4]))) {
      invalidOHLC++; return false;
    }
    return true;
  }).sort((a, b) => a[0].localeCompare(b[0]));
  const hasOHLC = rows.length > 0 && rows.every(b => isNum(b[1]) && isNum(b[2]) && isNum(b[3])) && rows.some(b => b[2] !== b[3]);
  const hasV = rows.some(b => isNum(b[5]) && b[5] > 0);
  return {rows, hasOHLC, hasV, invalidOHLC, excluded: input.length - rows.length};
}
const weekKey = d => { const t = new Date(d + 'T00:00:00Z'), wd = (t.getUTCDay() + 6) % 7; return new Date(t - wd * 864e5).toISOString().slice(0, 10); };
/* resample(rows, tf): 'D' unchanged; 'W' ISO weeks; 'M' calendar months. Bar time = first session of the period. */
function resample(rows, tf) {
  if (tf !== 'W' && tf !== 'M') return rows.slice();
  const out = []; let cur = null, key = null;
  for (const b of rows) {
    const k = tf === 'W' ? weekKey(b[0]) : b[0].slice(0, 7);
    if (k !== key) { if (cur) out.push(cur); key = k; cur = [b[0], b[1], b[2], b[3], b[4], isNum(b[5]) ? b[5] : 0]; }
    else { cur[2] = Math.max(cur[2], b[2]); cur[3] = Math.min(cur[3], b[3]); cur[4] = b[4]; cur[5] += isNum(b[5]) ? b[5] : 0; }
  }
  if (cur) out.push(cur);
  return out;
}
function sma(c, n) { const o = new Array(c.length).fill(null); let s = 0; for (let i = 0; i < c.length; i++) { s += c[i]; if (i >= n) s -= c[i - n]; if (i >= n - 1) o[i] = s / n; } return o; }
/* rsLine(rows, spy): price / SPY close, rebased to 100 at the first common date. spy = [[date, close]] */
function rsLine(rows, spy) {
  const m = new Map((spy || []).filter(x => x && isNum(x[1])).map(x => [x[0], x[1]]));
  let base = null; const out = [];
  for (const b of rows) { const s = m.get(b[0]); if (!isNum(s)) { out.push(null); continue; } const r = b[4] / s; if (base == null) base = r; out.push(100 * r / base); }
  return out;
}
function periodSpy(spy, tf) {
  return resample((spy || []).map(p => [p[0], p[1], p[1], p[1], p[1], 0]), tf).map(b => [b[0], b[4]]);
}
/* week52(rows): high / low over the last 252 sessions (daily rows) */
function week52(rows) {
  const w = rows.slice(-252); if (!w.length) return null;
  let hi = -Infinity, lo = Infinity, hd = null, ld = null;
  for (const b of w) { const h = isNum(b[2]) ? b[2] : b[4], l = isNum(b[3]) ? b[3] : b[4]; if (h > hi) { hi = h; hd = b[0]; } if (l < lo) { lo = l; ld = b[0]; } }
  return {hi, lo, hiDate: hd, loDate: ld, n: w.length};
}
/* srLevels(detectResult): support / resistance from the patterns.js 'sr' detector, labelled with touches */
function srLevels(res) {
  const d = res && (res.detections || []).find(x => x.id === 'sr');
  if (!d || d.state === 'none' || !d.evidence) return [];
  const out = [];
  if (d.evidence.support) out.push({kind: 'support', price: d.evidence.support.level, touches: d.evidence.support.touches, label: 'Support ' + d.evidence.support.level.toFixed(2) + ' (' + d.evidence.support.touches + ' touches)'});
  if (d.evidence.resistance) out.push({kind: 'resistance', price: d.evidence.resistance.level, touches: d.evidence.resistance.touches, label: 'Resistance ' + d.evidence.resistance.level.toFixed(2) + ' (' + d.evidence.resistance.touches + ' touches)'});
  return out;
}
/* patternChips(res): detections that are forming/confirmed/failed, minus the S/R line itself, one-line why */
function patternChips(res) {
  return ((res && res.detections) || []).filter(d => d.state && d.state !== 'none' && d.id !== 'sr')
    .map(d => ({id: d.id, name: d.pattern, state: d.state, direction: d.direction || 'neutral', why: firstSentence(d.plain), full: d.plain || ''}));
}
function firstSentence(s) { s = String(s || '').trim(); const m = s.match(/^(.{1,140}?[.;])(\s|$)/); return m ? m[1].replace(/;$/, '.') : s.slice(0, 140); }
/* events(row, rows): earnings markers inside or just past the bar range */
function events(row, rows, extra) {
  const ev = [], last = rows.length ? rows[rows.length - 1][0] : null, first = rows.length ? rows[0][0] : null;
  if (row && row.ler && first && row.ler >= first) ev.push({date: row.ler, kind: 'earnings', label: 'Earnings (prior quarter)', note: row.lers || '', past: true});
  if (row && row.er) ev.push({date: row.er, kind: 'earnings', label: 'Next earnings', note: row.ers || '', past: last ? row.er <= last : false});
  for (const x of extra || []) if (x && x.date && !ev.some(e => e.date === x.date)) ev.push({date: x.date, kind: x.kind || 'earnings', label: x.label || 'Earnings', note: x.source || '', past: last ? x.date <= last : false});
  return ev.sort((a, b) => a.date.localeCompare(b.date));
}
/* futureDays(last, until): weekday dates after `last` through `until` (whitespace so a future marker can show) */
function futureDays(last, until, max) {
  const out = []; if (!last || !until || until <= last) return out;
  let t = new Date(last + 'T00:00:00Z');
  while (out.length < (max || 70)) { t = new Date(+t + 864e5); const d = t.toISOString().slice(0, 10), wd = t.getUTCDay(); if (wd === 0 || wd === 6) continue; out.push(d); if (d >= until) break; }
  return out[out.length - 1] >= until ? out : [];
}
/* freshness(quote, quotesMeta): 'live' | 'delayed 15m' | 'closed' | 'stale' | 'missing' (contract vocabulary) */
function freshness(q, meta, now) {
  if (!q || !isNum(q.price) || q.price <= 0) return {word: 'missing', cls: 'missing', text: 'Not available'};
  if (q.status === 'stale' || q.status === 'missing') return {word: 'stale', cls: 'stale', text: 'Stale: last quote ' + String(q.ts || '').slice(0, 16).replace('T', ' ')};
  const session = q.market_state || meta && meta.session, src = String((q.provider || (meta && meta.source) || '')).toLowerCase();
  const timestamp = q.asof_utc || q.ts, age = timestamp ? ((now == null ? Date.now() : now) - Date.parse(timestamp)) / 1000 : Infinity;
  if (!isFinite(age) || age < -60) return {word: 'missing', cls: 'missing', text: 'Not available: valid observation time missing'};
  const at = new Date(timestamp).toLocaleString('en-US', {timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}) + ' ET';
  if (age > 72 * 3600) return {word: 'stale', cls: 'stale', text: 'Stale: last observation ' + at};
  if (session && session !== 'regular') return {word: 'closed', cls: 'closed', text: 'Outside regular trading; last observation ' + at};
  if (q.delay_minutes > 0 || /delay/.test(src)) return {word: q.delay_minutes == null || q.delay_minutes === 15 ? 'delayed 15m' : 'delayed', cls: 'delayed', text: `Provider delay ${q.delay_minutes || 15} minutes; observation ${at}`};
  const eligible = q.delay_minutes === 0 || q.delay_minutes == null && /real.?time|iex/.test(src);
  return age <= 60 && eligible ? {word: 'live', cls: 'fresh', text: 'Real-time observation ' + at + (/iex/.test(src) ? '; IEX exchange only' : '')} : {word: age > 1800 ? 'stale' : 'delayed', cls: 'delayed', text: 'Quote is ' + Math.round(age / 60) + ' min old; observation ' + at};
}

/* sectorBasket(coreRows, sector, self, n): the n largest companies by market value in the same sector, excluding self */
function sectorBasket(rows, sector, self, n) {
  return (rows || []).filter(r => r && r.sec === sector && r.t !== self && isNum(r.mcap)).sort((a, b) => b.mcap - a.mcap).slice(0, n || 10).map(r => r.t);
}
/* basketLine(list of [[date, close]]): equal-weight index of members rebased to 100 at the first date all share */
function basketLine(list) {
  const maps = (list || []).filter(x => x && x.length).map(x => new Map(x));
  if (!maps.length) return [];
  const dates = [...maps[0].keys()].filter(d => maps.every(m => isNum(m.get(d)))).sort();
  if (!dates.length) return [];
  const base = maps.map(m => m.get(dates[0]));
  return dates.map(d => [d, 100 * maps.reduce((s, m, i) => s + m.get(d) / base[i], 0) / maps.length]);
}
/* macroSeries(core, id): history [[date, value]] plus provenance from core.json macro groups */
function macroSeries(core, id) {
  const groups = core && core.macro ? Object.values(core.macro) : [];
  for (const g of groups) for (const x of g || []) if (x && x.id === id && Array.isArray(x.h) && x.h.length) {
    return {id, label: x.label || id, unit: x.unit || '', h: x.h.filter(p => p && isNum(p[1])).map(p => [String(p[0]).slice(0, 10), p[1]]).sort((a, b) => a[0].localeCompare(b[0])), provider: x.provider || '', url: x.url || '', date: x.date || null};
  }
  return null;
}
/* asOfValues(times, h): for each bar time, the latest observation on or before it (null before the first) */
function asOfValues(times, h) {
  const out = []; let j = -1;
  for (const t of times) { while (j + 1 < h.length && h[j + 1][0] <= t) j++; out.push(j >= 0 ? h[j][1] : null); }
  return out;
}
/* liveBar(lastBar, q, today, prev): fold a quote into the daily bars. Same date: extend the last bar.
   A later date: start a provisional bar (open = first observed price of the day unless the feed gives one). */
function liveBar(last, q, today, prev) {
  if (!last || !q || !isNum(q.price) || q.price <= 0 || !today) return null;
  if (today < last[0]) return null;
  if (today === last[0]) return {mode: 'update', bar: [last[0], last[1], Math.max(last[2], q.price), Math.min(last[3], q.price), q.price, last[5]]};
  const p = prev && prev[0] === today ? prev : null;
  const open = isNum(q.open) && q.open > 0 ? q.open : p ? p[1] : q.price;
  const hi = Math.max(isNum(q.high) ? q.high : -Infinity, p ? p[2] : -Infinity, q.price, open), lo = Math.min(isNum(q.low) && q.low > 0 ? q.low : Infinity, p ? p[3] : Infinity, q.price, open);
  return {mode: 'append', bar: [today, open, hi, lo, q.price, isNum(q.volume) && q.volume > 0 ? q.volume : null], provisional: true};
}
/* dayDetail(rows, i, extra): the numbers shown when a bar is tapped */
function dayDetail(rows, i, extra) {
  const b = rows[i]; if (!b) return null;
  const closes = rows.map(r => r[4]), prev = i > 0 ? rows[i - 1][4] : null;
  const avg = (n, k) => { if (k + 1 < n) return null; let s = 0; for (let j = k - n + 1; j <= k; j++) s += closes[j]; return s / n; };
  const vols = rows.slice(Math.max(0, i - 20), i).map(r => r[5]).filter(v => isNum(v) && v > 0);
  const vavg = vols.length >= 10 ? vols.reduce((a, c) => a + c, 0) / vols.length : null;
  const s50 = avg(50, i), s200 = avg(200, i);
  const out = {date: b[0], o: b[1], h: b[2], l: b[3], c: b[4], v: b[5], chg: isNum(prev) ? 100 * (b[4] / prev - 1) : null,
    range: isNum(b[2]) && isNum(b[3]) && b[4] > 0 ? 100 * (b[2] - b[3]) / b[4] : null,
    vol_x: vavg && isNum(b[5]) ? b[5] / vavg : null, vs50: s50 ? 100 * (b[4] / s50 - 1) : null, vs200: s200 ? 100 * (b[4] / s200 - 1) : null};
  if (extra && extra.rsi) out.rsi = extra.rsi[i];
  return out;
}

/* ---------- browser ---------- */
const esc =s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));
const reduced = () => !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
const jcache = {};
function getJSON(url, keep) {
  if (keep && jcache[url]) return jcache[url];
  const p = fetch(url, {cache: 'no-store'}).then(r => { if (!r.ok) throw new Error(url + ': HTTP ' + r.status); return r.json(); });
  if (keep) { jcache[url] = p; p.catch(() => { delete jcache[url]; }); }
  return p;
}
function coreRow(t) {
  try { const d = root.SO2 && root.SO2.D && root.SO2.D(); if (d && d.rows) return Promise.resolve({core: d, row: d.rows.find(r => r.t === t) || null}); } catch (e) { /* SO2 absent: fetch core */ }
  return getJSON('data/core.json', true).then(d => ({core: d, row: (d.rows || []).find(r => r.t === t) || null})).catch(() => ({core: null, row: null}));
}
function loadPrefs() { const d = {tf: 'D', sma20: true, sma50: true, sma200: true, sr: true, band: true, rs: false, rss: false, rsi: false, macd: false, ev: true, macro: ''}; try { return Object.assign(d, JSON.parse(root.localStorage.getItem(LS) || '{}')); } catch (e) { return d; } }
function savePrefs(p) { try { root.localStorage.setItem(LS, JSON.stringify(p)); } catch (e) { /* storage blocked: toggles last for this view */ } }
const f2 = v => isNum(v) ? v.toFixed(2) : 'n/a';
/* inSession(q): the observation was taken in the New York regular session (weekday 9:30 to 16:00) */
function inSession(q) {
  if (!q) return false;
  if (q.market_state && q.market_state !== 'regular') return false;
  const d = new Date(q.asof_utc || q.ts); if (isNaN(d)) return false;
  try {
    const p = {}; new Intl.DateTimeFormat('en-US', {timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false}).formatToParts(d).forEach(x => { p[x.type] = x.value; });
    const m = (+p.hour % 24) * 60 + (+p.minute);
    return !['Sat', 'Sun'].includes(p.weekday) && m >= 570 && m <= 960;
  } catch (e) { return false; }
}
/* etDate(ts, 'iso') -> New York calendar date; etDate(ts) -> "Oct 15, 7:55 PM ET" */
function etDate(ts, mode) {
  const d = new Date(ts); if (!ts || isNaN(d)) return mode === 'iso' ? null : 'time not available';
  try {
    if (mode === 'iso') return d.toLocaleDateString('en-CA', {timeZone: 'America/New_York'});
    return d.toLocaleString('en-US', {timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}) + ' ET';
  } catch (e) { return mode === 'iso' ? d.toISOString().slice(0, 10) : d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; }
}
const fVol = v => !isNum(v) ? 'n/a' : v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(0) + 'K' : String(v);
const TOGGLES = [['sma20', 'SMA 20', COL.sma20], ['sma50', 'SMA 50', COL.sma50], ['sma200', 'SMA 200', COL.sma200], ['sr', 'Support / resistance'], ['band', '52-week range'], ['ev', 'Events'], ['rs', 'Strength vs SPY'], ['rss', 'Strength vs sector'], ['rsi', 'RSI'], ['macd', 'MACD']];
const MACRO = [['', 'None'], ['us10y', '10-year yield'], ['us2y', '2-year yield'], ['dxy', 'Dollar index'], ['wti', 'WTI oil'], ['vix', 'VIX']];
const GLOSS = {rs: 'Price divided by SPY, rebased to 100. Rising means it is beating the index.', rss: 'Price divided by an equal-weight basket of the ten largest companies in the same sector, rebased to 100.', rsi: 'Relative Strength Index, 14 sessions. Above 70 is stretched, below 30 is washed out.', macd: 'Gap between 12 and 26 session averages, with a 9 session signal line.', sr: 'Price levels touched by the most swing highs and lows in the last 120 sessions.', band: 'Highest high and lowest low of the last 252 sessions.'};

async function mount(el, ticker, opts) {
  opts = opts || {}; const t = String(ticker || '').toUpperCase();
  const LW = root.LightweightCharts;
  el.classList.add('so-fv');
  el.innerHTML = `<div class="fv-skel" aria-busy="true"><span>Loading ${esc(t)} chart</span></div>`;
  if (!LW) { el.innerHTML = '<p class="fv-err" role="alert">Chart not available: the chart library did not load.</p>'; return {destroy() {}}; }
  let px, spy = null, cr, quotes = null;
  try {
    [px, cr, quotes] = await Promise.all([getJSON(`data/px/${encodeURIComponent(t)}.json`), coreRow(t), getJSON('data/quotes.json').catch(() => null)]);
  } catch (e) {
    el.innerHTML = `<p class="fv-err" role="alert">Chart not available for ${esc(t)}: no price history in this build (${esc(e && e.message || e)}).</p>`;
    return {destroy() { el.innerHTML = ''; }};
  }
  const prefs = Object.assign(loadPrefs(), opts.tf ? {tf: opts.tf} : {});
  const C = clean(px.bars);
  if (C.excluded) {
    console.warn('[brief chart] Invalid or duplicate source bars excluded', {ticker: t, count: C.excluded});
    try { root.localStorage.setItem('so-chart-quality', JSON.stringify({status: 'WARN', ticker: t, excluded: C.excluded, at: new Date().toISOString()})); }
    catch (e) { console.warn('[brief chart] Quality receipt storage unavailable'); }
  }
  if (C.rows.length < 2) { el.innerHTML = `<p class="fv-err" role="alert">Chart not available for ${esc(t)}: fewer than 2 price bars.</p>`; return {destroy() { el.innerHTML = ''; }}; }
  const row = cr.row; let q = quotes && quotes.quotes ? quotes.quotes[t] : null;
  const P = root.SmartOptionsPatterns;
  let pres = null;
  try { pres = P ? P.detect(C.rows, {nextEarnings: row && row.er || null, lastEarnings: row && row.ler || null}) : null; } catch (e) { pres = null; }
  const prov = px.prov && px.prov.price ? px.prov.price : null;
  const srcLine = `Daily bars: ${prov ? esc(prov.provider) + ', ' + esc(prov.field) : 'Yahoo Finance via yfinance'}, ${esc(C.rows[0][0])} to ${esc(C.rows[C.rows.length - 1][0])}.`;

  el.innerHTML = `
    <div class="fv-top">
      <div class="fv-tf" role="group" aria-label="Timeframe">${['D', 'W', 'M'].map(k => `<button type="button" data-tf="${k}" aria-pressed="${prefs.tf === k}" title="${{D: 'Daily', W: 'Weekly', M: 'Monthly'}[k]} bars">${k}</button>`).join('')}</div>
      <div class="fv-read" aria-live="off"></div>
    </div>
    ${C.excluded ? `<p class="fv-note" role="status">${C.excluded} invalid or duplicate source bars excluded. Indicators use the remaining observations.</p>` : ''}
    ${C.hasOHLC ? '' : '<p class="fv-note">Candles are not available for this name: the data has closing prices only, so this is a line chart.</p>'}
    <div class="fv-panes"><div class="fv-main"></div></div>
    <div class="fv-evrow" hidden></div>
    <div class="fv-day" aria-live="polite" hidden></div>
    <details class="fv-layers"${root.innerWidth >= 600 ? ' open' : ''}><summary>Chart layers and overlays</summary><div class="fv-toggles" role="group" aria-label="Chart layers">${TOGGLES.map(([k, l, c]) => `<label class="fv-tg"${GLOSS[k] ? ` title="${esc(GLOSS[k])}"` : ''}><input type="checkbox" data-k="${k}" ${prefs[k] ? 'checked' : ''}>${c ? `<i style="background:${c}"></i>` : ''}${esc(l)}</label>`).join('')}
      <label class="fv-mac">Macro overlay <select data-macro>${MACRO.filter(([id]) => !id || macroSeries(cr.core, id)).map(([id, l]) => `<option value="${id}"${prefs.macro === id ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label></div></details>
    <div class="fv-pats"></div>
    <p class="fv-src">${srcLine} Lines and patterns are rule-based readings, not forecasts. Chart drawing: <a href="https://www.tradingview.com/lightweight-charts/" target="_blank" rel="noopener">TradingView Lightweight Charts</a>.</p>`;
  const $ = s => el.querySelector(s);
  const mainEl = $('.fv-main'), panes = $('.fv-panes'), read = $('.fv-read');
  const H = opts.height || (root.innerWidth < 600 ? 300 : 420);
  const base = (h) => ({height: h, autoSize: false, width: Math.max(280, mainEl.clientWidth || el.clientWidth || 600),
    layout: {background: {type: 'solid', color: 'transparent'}, textColor: (getComputedStyle(el).getPropertyValue('--b-ink-3') || '').trim() || '#5d6673', fontSize: 12, fontFamily: getComputedStyle(el).fontFamily, attributionLogo: false},
    grid: {vertLines: {color: 'rgba(120,130,145,.10)'}, horzLines: {color: 'rgba(120,130,145,.12)'}},
    rightPriceScale: {borderVisible: false, minimumWidth: 64}, timeScale: {borderVisible: false, rightOffset: 4},
    crosshair: {mode: 0}, handleScroll: true, handleScale: true});
  let charts = [], main = null, priceSeries = null, mainLines = [], quoteLine = null, alive = true, liveState = null, dayIdx = null, curRows = [], basket = null, basketNote = '';
  const narrow = () => (mainEl.clientWidth || el.clientWidth || 600) < 560;
  const dailyRows = () => !liveState ? C.rows : liveState.mode === 'update' ? C.rows.slice(0, -1).concat([liveState.bar]) : C.rows.concat([liveState.bar]);
  function updateQuoteLine() {
    if (!alive || !priceSeries) return;
    if (quoteLine) { priceSeries.removePriceLine(quoteLine); quoteLine = null; }
    const fr = freshness(q,quotes);
    if(q && q.status === 'ok' && isNum(q.price) && q.price > 0 && fr.word !== 'missing') quoteLine = priceSeries.createPriceLine({price:q.price,color:COL.last,lineWidth:1,lineStyle:0,axisLabelVisible:true,title:narrow()?'':fr.word==='live'?'Last':'Last quote'});
    const note=el.querySelector('.fv-quote-note');
    if(note) note.textContent=q && q.status==='ok' ? `Last quote $${f2(q.price)}, ${etDate(q.asof_utc || q.ts)} (${fr.word})${liveState ? '; today’s bar is provisional, built from quotes' : ''}. Indicators use daily closes.` : 'Quote not available. Candles and indicators use daily closes.';
  }

  function build(anim) {
    charts.forEach(c => c.remove()); charts = []; mainLines = []; quoteLine=null;
    panes.querySelectorAll('.fv-sub').forEach(n => n.remove());
    const tf = prefs.tf, rows = resample(dailyRows(), tf), times = rows.map(b => b[0]), closes = rows.map(b => b[4]); curRows = rows;
    const ev = events(row, C.rows, opts.events);
    const nextEv = ev.find(e => !e.past);
    const future = tf === 'D' && prefs.ev && nextEv ? futureDays(times[times.length - 1], nextEv.date, 70) : [];
    const ws = future.map(d => ({time: d}));
    main = LW.createChart(mainEl, base(H)); charts.push(main);
    if (C.hasOHLC) {
      priceSeries = main.addCandlestickSeries({upColor: COL.up, downColor: COL.down, borderUpColor: COL.up, borderDownColor: COL.down, wickUpColor: COL.up, wickDownColor: COL.down, priceLineVisible: false, lastValueVisible: !(q && q.status === 'ok')});
      priceSeries.setData(rows.map(b => ({time: b[0], open: b[1], high: b[2], low: b[3], close: b[4]})).concat(ws));
    } else {
      priceSeries = main.addAreaSeries({lineColor: COL.last, topColor: 'rgba(47,93,158,.22)', bottomColor: 'rgba(47,93,158,0)', lineWidth: 2, priceLineVisible: false});
      priceSeries.setData(rows.map(b => ({time: b[0], value: b[4]})).concat(ws));
    }
    if (C.hasV) {
      const vol = main.addHistogramSeries({priceScaleId: 'vol', priceFormat: {type: 'volume'}, lastValueVisible: false, priceLineVisible: false});
      main.priceScale('vol').applyOptions({scaleMargins: {top: 0.82, bottom: 0}, visible: false});
      vol.setData(rows.map((b, i) => ({time: b[0], value: isNum(b[5]) ? b[5] : 0, color: (i && b[4] < rows[i - 1][4]) ? 'rgba(224,72,77,.35)' : 'rgba(31,157,85,.35)'})));
    }
    const smaNote = [];
    for (const [k, n] of [['sma20', 20], ['sma50', 50], ['sma200', 200]]) {
      if (!prefs[k]) continue;
      if (closes.length < n) { smaNote.push(`SMA ${n} needs ${n} ${{D: 'daily', W: 'weekly', M: 'monthly'}[tf]} bars; ${closes.length} available`); continue; }
      const s = main.addLineSeries({color: COL[k], lineWidth: k === 'sma200' ? 2 : 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false});
      s.setData(sma(closes, n).map((v, i) => v == null ? {time: times[i]} : {time: times[i], value: v}));
    }
    const nw = narrow(); // phones: short titles and no axis tags on the range band, so price labels do not pile up
    if (prefs.sr) for (const L of srLevels(pres)) mainLines.push(priceSeries.createPriceLine({price: L.price, color: L.kind === 'support' ? COL.sup : COL.res, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: nw ? (L.kind === 'support' ? 'S' : 'R') : L.kind === 'support' ? 'Support' : 'Resistance'}));
    const w52 = week52(dailyRows());
    if (prefs.band && w52) {
      mainLines.push(priceSeries.createPriceLine({price: w52.hi, color: COL.band, lineWidth: 1, lineStyle: 1, axisLabelVisible: !nw, title: nw ? '' : '52w high'}));
      mainLines.push(priceSeries.createPriceLine({price: w52.lo, color: COL.band, lineWidth: 1, lineStyle: 1, axisLabelVisible: !nw, title: nw ? '' : '52w low'}));
    }
    updateQuoteLine();
    if (prefs.ev) {
      const tset = new Set(times.concat(future)), mk = [];
      for (const e of ev) {
        let at = e.date; if (!tset.has(at)) at = times.concat(future).find(d => d >= e.date); if (!at) continue;
        mk.push({time: at, position: 'belowBar', color: e.past ? '#7a828e' : COL.last, shape: e.past ? 'circle' : 'arrowUp', text: 'E'});
      }
      try { priceSeries.setMarkers(mk.sort((a, b) => a.time.localeCompare(b.time))); } catch (e) { /* marker outside range: skip */ }
    }
    const subs = [];
    const addSub = (key, label, h, fill) => {
      const d = document.createElement('div'); d.className = 'fv-sub'; d.innerHTML = `<span class="fv-sublab">${esc(label)}</span>`; panes.appendChild(d);
      const c = LW.createChart(d, Object.assign(base(h), {timeScale: {visible: false, borderVisible: false, rightOffset: 4}})); charts.push(c); subs.push(c); fill(c);
    };
    const wsData = arr => arr.map((v, i) => isNum(v) ? {time: times[i], value: v} : {time: times[i]}).concat(ws);
    if (prefs.rs) addSub('rs', 'Strength vs SPY (rebased to 100)', 110, c => {
      const s = c.addLineSeries({color: COL.rs, lineWidth: 2, priceLineVisible: false}); s.setData(wsData(rsLine(rows, periodSpy(spy || [], tf))));
    });
    if (prefs.rss) addSub('rss', basket && basket.line.length ? `Strength vs ${basket.sector} basket (rebased to 100)` : 'Strength vs sector: ' + (basketNote || 'loading'), 110, c => {
      if (!basket || !basket.line.length) return;
      const s = c.addLineSeries({color: COL.sig, lineWidth: 2, priceLineVisible: false}); s.setData(wsData(rsLine(rows, periodSpy(basket.line, tf))));
    });
    const mac = prefs.macro ? macroSeries(cr.core, prefs.macro) : null;
    if (mac) addSub('macro', `${mac.label} (${mac.unit}), ${mac.provider}`, 110, c => {
      const s = c.addLineSeries({color: COL.band, lineWidth: 2, priceLineVisible: false, lastValueVisible: true}); s.setData(wsData(asOfValues(times, mac.h)));
    });
    if (prefs.rsi) addSub('rsi', 'RSI 14', 100, c => {
      const s = c.addLineSeries({color: COL.rsi, lineWidth: 1.5, priceLineVisible: false}); s.setData(wsData(T.rsi(closes, 14)));
      s.createPriceLine({price: 70, color: '#c0c5cd', lineStyle: 2, lineWidth: 1, axisLabelVisible: false, title: ''});
      s.createPriceLine({price: 30, color: '#c0c5cd', lineStyle: 2, lineWidth: 1, axisLabelVisible: false, title: ''});
    });
    if (prefs.macd) addSub('macd', 'MACD 12, 26, 9', 110, c => {
      const m = T.macd(closes);
      const h = c.addHistogramSeries({priceLineVisible: false, lastValueVisible: false});
      h.setData(m.hist.map((v, i) => isNum(v) ? {time: times[i], value: v, color: v >= 0 ? 'rgba(31,157,85,.5)' : 'rgba(224,72,77,.5)'} : {time: times[i]}).concat(ws));
      c.addLineSeries({color: COL.macd, lineWidth: 1.5, priceLineVisible: false}).setData(wsData(m.macd));
      c.addLineSeries({color: COL.sig, lineWidth: 1, priceLineVisible: false}).setData(wsData(m.signal));
    });
    const span = tf === 'D' ? Math.min(rows.length, 130) : rows.length;
    const range0 = {from: rows.length - span - 0.5, to: rows.length + future.length + (tf === 'D' ? 2 : 0.5)};
    const all = [main].concat(subs);
    all.forEach(c => c.timeScale().setVisibleLogicalRange(range0));
    // follow the main pane only after the initial range has settled (range events arrive asynchronously)
    const myCharts = charts;
    setTimeout(() => {
      if (charts !== myCharts) return;
      let syncing = false;
      all.forEach(src => src.timeScale().subscribeVisibleLogicalRangeChange(r => { if (syncing || !r) return; syncing = true; all.forEach(c => { if (c !== src) c.timeScale().setVisibleLogicalRange(r); }); syncing = false; }));
    }, 60);
    const idx = new Map(times.map((d, i) => [d, i]));
    const readout = i => {
      const b = rows[i]; if (!b) return;
      const prev = i > 0 ? rows[i - 1][4] : null, ch = isNum(prev) ? (b[4] / prev - 1) * 100 : null;
      read.innerHTML = `<b>${esc(t)}</b> <span>${esc(b[0])}${tf === 'D' ? '' : tf === 'W' ? ' week' : ' month'}</span>` +
        (C.hasOHLC ? `<span>O <b>${f2(b[1])}</b></span><span>H <b>${f2(b[2])}</b></span><span>L <b>${f2(b[3])}</b></span>` : '') +
        `<span>C <b>${f2(b[4])}</b></span>` + (isNum(ch) ? `<span class="${ch >= 0 ? 'up' : 'dn'}">${ch >= 0 ? '+' : '−'}${Math.abs(ch).toFixed(2)}%</span>` : '') +
        (C.hasV ? `<span>Vol <b>${fVol(b[5])}</b></span>` : '');
    };
    readout(rows.length - 1);
    const rsiAll = T && T.rsi ? T.rsi(closes, 14) : null;
    main.subscribeClick(p => {
      const key = p && p.time != null ? (typeof p.time === 'string' ? p.time : `${p.time.year}-${String(p.time.month).padStart(2, '0')}-${String(p.time.day).padStart(2, '0')}`) : null;
      let i = key != null ? idx.get(key) : null;
      if (i == null && p && isNum(p.logical)) i = Math.max(0, Math.min(rows.length - 1, Math.round(p.logical))); // tap between bars or on whitespace
      if (i == null || !rows[i]) return;
      dayIdx = rows[i][0]; showDay(rows, i, tf, ev, mac, rsiAll);
      try { if (main.setCrosshairPosition) main.setCrosshairPosition(rows[i][4], rows[i][0], priceSeries); } catch (e) { console.warn('[brief chart] crosshair pin unavailable', e); }
    });
    if (dayIdx && idx.has(dayIdx)) showDay(rows, idx.get(dayIdx), tf, ev, mac, rsiAll); else { dayIdx = null; const dEl = $('.fv-day'); if (dEl) dEl.hidden = true; }
    main.subscribeCrosshairMove(p => { const i = p && p.time != null ? idx.get(typeof p.time === 'string' ? p.time : `${p.time.year}-${String(p.time.month).padStart(2, '0')}-${String(p.time.day).padStart(2, '0')}`) : null; readout(i == null ? rows.length - 1 : i); });
    // events row + notes under the chart
    const evRow = $('.fv-evrow');
    evRow.hidden = !prefs.ev;
    evRow.innerHTML = '<span class="fv-evh">Events</span>' + (ev.length ? ev.map(e => `<span class="fv-ev${e.past ? ' past' : ''}" title="${esc(e.note)}"><i>E</i>${esc(e.label)} ${esc(e.date)}${/estimate|cycle|-91d/i.test(e.note) ? ' (estimated)' : ''}</span>`).join('') : '<span class="fv-ev">Earnings dates not available</span>') +
      '<span class="fv-ev na">Ex-dividend dates not available in this build</span>' + (smaNote.length ? `<span class="fv-ev na">${esc(smaNote.join('; '))}</span>` : '');
    if (anim && !reduced()) { panes.classList.remove('fv-draw'); void panes.offsetWidth; panes.classList.add('fv-draw'); }
  }
  function renderPatterns() {
    const box = $('.fv-pats');
    if (!pres) { box.innerHTML = '<p class="fv-na">Pattern scan not available for this name.</p>'; return; }
    if (pres.note && !pres.detections.length) { box.innerHTML = `<p class="fv-na">Patterns not available: ${esc(pres.note)}.</p>`; return; }
    const chips = patternChips(pres), lv = srLevels(pres);
    box.innerHTML = `<h4 class="fv-h">Patterns on daily bars, as of ${esc(pres.asof)}</h4>` +
      (lv.length ? `<p class="fv-lv">${lv.map(L => `<span class="${L.kind}">${esc(L.label)}</span>`).join('')}</p>` : '') +
      (chips.length ? `<ul class="fv-chips">${chips.map(c => `<li class="fv-chip ${c.state} ${c.direction}" title="${esc(c.full)}"><b>${esc(c.name)}</b> <em>${esc(c.state)}</em><span>${esc(c.why)}</span></li>`).join('')}</ul>` : '<p class="fv-na">No pattern is forming or confirmed right now.</p>');
  }
  /* tapped bar: that day's numbers, the macro backdrop that day, and any event on it */
  function showDay(rows, i, tf, ev, mac, rsiAll) {
    const box = $('.fv-day'); if (!box) return;
    const d = dayDetail(rows, i, {rsi: rsiAll}); if (!d) { box.hidden = true; return; }
    const sg = (v, n) => !isNum(v) ? 'n/a' : (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(n == null ? 2 : n) + '%';
    const unit = tf === 'D' ? '' : tf === 'W' ? 'Week of ' : 'Month of ';
    const evs = (ev || []).filter(e => tf === 'D' ? e.date === d.date : e.date >= d.date && (i + 1 >= rows.length || e.date < rows[i + 1][0]));
    const macro = [];
    for (const id of ['us10y', 'vix', 'dxy', 'wti']) {
      const m = macroSeries(cr.core, id); if (!m) continue;
      const k = m.h.findIndex(p => p[0] > d.date), j = (k === -1 ? m.h.length : k) - 1;
      if (j < 0) continue;
      const v = m.h[j][1], pv = j > 0 ? m.h[j - 1][1] : null, bp = /^%$/.test(m.unit) || /yield|Treasury/i.test(m.label);
      macro.push(`<span title="${esc(m.label + ', ' + m.provider + ', observation ' + m.h[j][0])}">${esc({us10y: '10Y', vix: 'VIX', dxy: 'Dollar', wti: 'Oil'}[id])} <b>${bp ? v.toFixed(2) + '%' : v.toFixed(2)}</b>${isNum(pv) ? ` <em class="${v >= pv ? 'up' : 'dn'}">${bp ? (v - pv >= 0 ? '+' : '−') + Math.abs(Math.round((v - pv) * 100)) + ' bp' : sg(100 * (v / pv - 1), 1)}</em>` : ''}${m.h[j][0] !== d.date ? ` <i>${esc(m.h[j][0].slice(5))}</i>` : ''}</span>`);
    }
    const prov = liveState && i === rows.length - 1 && tf === 'D';
    box.innerHTML = `<div class="fv-dh"><b>${esc(unit)}${esc(new Date(d.date + 'T12:00:00Z').toLocaleDateString('en-US', {weekday: tf === 'D' ? 'short' : undefined, month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'}))}</b>${prov ? '<span class="fv-prov">provisional, from quotes</span>' : ''}<button type="button" class="fv-dx" aria-label="Close day details">Close</button></div>
      <dl class="fv-dl"><div><dt>Close</dt><dd>${f2(d.c)} <em class="${isNum(d.chg) && d.chg >= 0 ? 'up' : 'dn'}">${sg(d.chg)}</em></dd></div>
        ${C.hasOHLC ? `<div><dt>Open, high, low</dt><dd>${f2(d.o)}, ${f2(d.h)}, ${f2(d.l)}</dd></div><div><dt>Range</dt><dd>${isNum(d.range) ? d.range.toFixed(1) + '% of close' : 'n/a'}</dd></div>` : ''}
        <div><dt>Volume</dt><dd>${fVol(d.v)}${isNum(d.vol_x) ? ` <em>${d.vol_x.toFixed(1)}x its 20-bar average</em>` : ''}</dd></div>
        <div><dt>vs 50 / 200-bar average</dt><dd>${sg(d.vs50, 1)} / ${sg(d.vs200, 1)}</dd></div>
        ${isNum(d.rsi) ? `<div><dt>RSI 14</dt><dd>${d.rsi.toFixed(0)}${d.rsi >= 70 ? ' <em>stretched</em>' : d.rsi <= 30 ? ' <em>washed out</em>' : ''}</dd></div>` : ''}</dl>
      ${macro.length ? `<p class="fv-dm"><span class="fv-dmh">Backdrop that day</span>${macro.join('')}</p>` : ''}
      ${evs.length ? `<p class="fv-dm"><span class="fv-dmh">Events</span>${evs.map(e => `<span>${esc(e.label)} ${esc(e.date)}</span>`).join('')}</p>` : ''}`;
    box.hidden = false;
  }
  async function loadBasket() {
    if (basket || !cr.core || !row) { if (!row) basketNote = 'company row missing'; return; }
    const names = sectorBasket(cr.core.rows, row.sec, t, 10);
    if (names.length < 3) { basketNote = 'fewer than 3 sector peers in this build'; return; }
    const got = await Promise.all(names.map(n => getJSON(`data/px/${encodeURIComponent(n)}.json`, true).then(j => clean(j.bars).rows.map(b => [b[0], b[4]])).catch(e => { console.warn('[brief chart] sector peer bars missing', n, e && e.message); return null; })));
    const ok = got.filter(Boolean);
    if (ok.length < 3) { basketNote = 'peer price history not available'; return; }
    basket = {sector: row.sec, names: names.filter((n, i) => got[i]), line: basketLine(ok)};
  }
  if (prefs.rss) await loadBasket();
  if (prefs.rs) spy = await getJSON('data/px/SPY.json', true).then(j => clean(j.bars).rows.map(b => [b[0], b[4]])).catch(() => null);
  const quoteNote=document.createElement('p');quoteNote.className='fv-quote-note fv-note';el.querySelector('.fv-top').after(quoteNote);
  build(true); renderPatterns();
  el.addEventListener('click', e => { if (e.target.closest('.fv-dx')) { dayIdx = null; $('.fv-day').hidden = true; return; } const b = e.target.closest('[data-tf]'); if (!b) return; prefs.tf = b.dataset.tf; savePrefs(prefs); el.querySelectorAll('[data-tf]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); build(true); });
  el.addEventListener('change', async e => {
    if (e.target.matches && e.target.matches('[data-macro]')) { prefs.macro = e.target.value; savePrefs(prefs); build(false); return; }
    const k = e.target.dataset && e.target.dataset.k; if (!k) return; prefs[k] = e.target.checked; savePrefs(prefs);
    if (k === 'rss' && prefs.rss && !basket) { build(false); await loadBasket(); }
    if (k === 'rs' && prefs.rs && !spy) spy = await getJSON('data/px/SPY.json', true).then(j => clean(j.bars).rows.map(b => [b[0], b[4]])).catch(() => null);
    build(false);
  });
  let lastW = mainEl.clientWidth;
  const ro = root.ResizeObserver ? new ResizeObserver(() => { const w = mainEl.clientWidth; if (Math.abs(w - lastW) < 2) return; lastW = w; charts.forEach(c => c.applyOptions({width: Math.max(280, w)})); }) : null;
  if (ro) ro.observe(mainEl);
  return {
    setTimeframe(tf) { if (!['D', 'W', 'M'].includes(tf)) return; prefs.tf = tf; build(true); },
    updateQuotes(next) {
      const n=next && next.quotes && next.quotes[t], stamp=n && Date.parse(n.asof_utc||n.ts), last=q && Date.parse(q.asof_utc||q.ts);
      if(!alive || !n || n.status!=='ok' || !isNum(n.price) || n.price<=0 || !isFinite(stamp) || stamp>Date.now()+60000 || isFinite(last)&&stamp<last)return false;
      quotes=next;q=n;
      // fold the quote into today's daily bar (provisional) so the last candle moves with the price
      // only regular-session prints touch the daily bar; after-hours quotes stay on the quote line
      const today=inSession(n)?etDate(n.asof_utc||n.ts,'iso'):null, nb=liveBar(C.rows[C.rows.length-1],n,today,liveState&&liveState.bar);
      if(nb&&(!liveState||liveState.bar[4]!==nb.bar[4]||liveState.bar[0]!==nb.bar[0])){liveState=nb;if(prefs.tf==='D'&&priceSeries&&C.hasOHLC){try{const b=nb.bar;priceSeries.update({time:b[0],open:b[1],high:b[2],low:b[3],close:b[4]});}catch(err){console.warn('[brief chart] live bar update needs a rebuild',err&&err.message);build(false);}}else if(prefs.tf!=='D')build(false);}
      updateQuoteLine();return true;
    },
    destroy() { alive=false;if (ro) ro.disconnect(); charts.forEach(c => c.remove()); charts = []; el.innerHTML = ''; el.classList.remove('so-fv'); },
  };
}

/* corrChanges(a, b): Pearson correlation of period-over-period changes on shared dates; {r, n} */
function corrChanges(a, b) {
  const mb = new Map(b), d = a.filter(p => mb.has(p[0]));
  const xs = [], ys = [];
  for (let i = 1; i < d.length; i++) { const x = d[i][1] - d[i - 1][1], y = mb.get(d[i][0]) - mb.get(d[i - 1][0]); if (isNum(x) && isNum(y)) { xs.push(x); ys.push(y); } }
  const n = xs.length; if (n < 20) return {r: null, n};
  const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return {r: sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null, n};
}
/* mountSeries(el, id, opts): detail chart for one macro series from core.json, with an overlay picker
   (another macro series or SPY) on a second scale, change table, and the co-movement of changes. For the macro page. */
async function mountSeries(el, id, opts) {
  opts = opts || {};
  const LW = root.LightweightCharts;
  el.classList.add('so-fv', 'fv-series');
  el.innerHTML = '<div class="fv-skel" aria-busy="true"><span>Loading series</span></div>';
  const {core} = await coreRow('');
  const m = macroSeries(core, id);
  if (!m) { el.innerHTML = `<p class="fv-err" role="alert">Not available: no history for ${esc(id)} in this build.</p>`; return {destroy() { el.innerHTML = ''; }}; }
  if (!LW) { el.innerHTML = '<p class="fv-err" role="alert">Chart not available: the chart library did not load.</p>'; return {destroy() {}}; }
  const ids = []; for (const g of Object.values(core.macro || {})) for (const x of g || []) if (x && x.id !== id && Array.isArray(x.h) && x.h.length > 20) ids.push([x.id, x.label]);
  let over = opts.overlay || '', ch = null, alive = true;
  const last = m.h[m.h.length - 1], at = k => { const t = Date.parse(last[0]) - k * 864e5; let j = m.h.length - 1; while (j > 0 && Date.parse(m.h[j][0]) > t) j--; return m.h[j]; };
  const chg = k => { const p = at(k); return p && p !== last ? last[1] - p[1] : null; };
  const fmt = v => !isNum(v) ? 'n/a' : (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2);
  el.innerHTML = `<div class="fv-sh"><div><b>${esc(m.label)}</b><span>${esc(m.unit)} · ${esc(m.provider)}${m.url ? ` · <a href="${esc(m.url)}" target="_blank" rel="noopener">source</a>` : ''}</span></div>
      <div class="fv-sv"><b>${esc(last[1].toFixed(2))}</b><span>observation ${esc(last[0])}</span></div></div>
    <dl class="fv-dl fv-schg">${[['1 month', 30], ['3 months', 91], ['1 year', 365]].map(([l, k]) => `<div><dt>Change, ${l}</dt><dd>${fmt(chg(k))}</dd></div>`).join('')}</dl>
    <label class="fv-mac">Compare with <select data-over><option value="">Nothing</option><option value="SPY"${over === 'SPY' ? ' selected' : ''}>S&amp;P 500 (SPY)</option>${ids.map(([k, l]) => `<option value="${esc(k)}"${over === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
    <div class="fv-read"></div><div class="fv-main"></div><p class="fv-corr fv-note" hidden></p>
    <p class="fv-src">${esc(m.h.length)} observations, ${esc(m.h[0][0])} to ${esc(last[0])}. Comparisons show co-movement, not cause.</p>`;
  const mainEl = el.querySelector('.fv-main'), read = el.querySelector('.fv-read'), corrEl = el.querySelector('.fv-corr');
  async function draw() {
    if (ch) ch.remove();
    ch = LW.createChart(mainEl, {height: opts.height || (root.innerWidth < 600 ? 260 : 340), width: Math.max(280, mainEl.clientWidth || 600),
      layout: {background: {type: 'solid', color: 'transparent'}, textColor: (getComputedStyle(el).getPropertyValue('--b-ink-3') || '').trim() || '#5d6673', fontSize: 12, attributionLogo: false},
      grid: {vertLines: {color: 'rgba(120,130,145,.10)'}, horzLines: {color: 'rgba(120,130,145,.12)'}}, rightPriceScale: {borderVisible: false}, leftPriceScale: {visible: !!over, borderVisible: false}, timeScale: {borderVisible: false}});
    const a = ch.addLineSeries({color: COL.last, lineWidth: 2, priceLineVisible: false}); a.setData(m.h.map(p => ({time: p[0], value: p[1]})));
    let o = null, oh = null, olabel = '';
    if (over === 'SPY') { const j = await getJSON('data/px/SPY.json', true).catch(e => { corrEl.hidden = false; corrEl.textContent = 'SPY history not available: ' + (e.message || e); return null; }); if (j) { oh = clean(j.bars).rows.map(b => [b[0], b[4]]).filter(p => p[0] >= m.h[0][0]); olabel = 'SPY'; } }
    else if (over) { const x = macroSeries(core, over); if (x) { oh = x.h.filter(p => p[0] >= m.h[0][0]); olabel = x.label; } }
    if (!alive) return;
    if (oh && oh.length) {
      o = ch.addLineSeries({color: COL.sig, lineWidth: 1.5, priceScaleId: 'left', priceLineVisible: false}); o.setData(oh.map(p => ({time: p[0], value: p[1]})));
      const c = corrChanges(m.h, oh);
      corrEl.hidden = false;
      corrEl.textContent = isNum(c.r) ? `Changes in ${m.label} and ${olabel} moved ${Math.abs(c.r) < 0.2 ? 'largely independently' : c.r > 0 ? 'together' : 'in opposite directions'} (correlation ${c.r.toFixed(2)} over ${c.n} shared periods). Association only.` : `Too few shared observations (${c.n}) to measure co-movement.`;
    } else if (!over) corrEl.hidden = true;
    ch.timeScale().fitContent();
    const ov = oh ? new Map(oh) : null;
    ch.subscribeCrosshairMove(p => {
      const k = p && p.time != null ? (typeof p.time === 'string' ? p.time : `${p.time.year}-${String(p.time.month).padStart(2, '0')}-${String(p.time.day).padStart(2, '0')}`) : last[0];
      const v = m.h.find(x => x[0] === k);
      read.innerHTML = `<span>${esc(k)}</span><span><i class="fv-sw" style="background:${COL.last}"></i>${esc(m.label)} <b>${v ? v[1].toFixed(2) : 'n/a'}</b></span>${ov ? `<span><i class="fv-sw" style="background:${COL.sig}"></i>${esc(olabel)} <b>${ov.has(k) ? ov.get(k).toFixed(2) : 'n/a'}</b></span>` : ''}`;
    });
    read.innerHTML = `<span>${esc(last[0])}</span><span><i class="fv-sw" style="background:${COL.last}"></i>${esc(m.label)} <b>${last[1].toFixed(2)}</b> (right scale)</span>${oh && oh.length ? `<span><i class="fv-sw" style="background:${COL.sig}"></i>${esc(olabel)} <b>${oh[oh.length - 1][1].toFixed(2)}</b> (left scale)</span>` : ''}`;
  }
  el.addEventListener('change', e => { if (e.target.matches('[data-over]')) { over = e.target.value; draw(); } });
  await draw();
  return {destroy() { alive = false; if (ch) ch.remove(); el.innerHTML = ''; el.classList.remove('so-fv', 'fv-series'); }};
}

const API = {clean, resample, sma, rsLine, periodSpy, week52, srLevels, patternChips, events, futureDays, freshness, mount, mountSeries,
  sectorBasket, basketLine, macroSeries, corrChanges, asOfValues, liveBar, dayDetail, etDate, inSession, MACRO};
if (typeof module !== 'undefined' && module.exports) module.exports = API;
root.SmartOptionsChart = API;
})(typeof window !== 'undefined' ? window : globalThis);
