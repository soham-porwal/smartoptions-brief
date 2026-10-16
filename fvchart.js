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
  const rows = (bars || []).filter(b => b && typeof b[0] === 'string' && isNum(b[4]));
  const hasOHLC = rows.length > 0 && rows.every(b => isNum(b[1]) && isNum(b[2]) && isNum(b[3])) && rows.some(b => b[2] !== b[3]);
  const hasV = rows.some(b => isNum(b[5]) && b[5] > 0);
  return {rows, hasOHLC, hasV};
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
  if (!q || !isNum(q.price)) return {word: 'missing', cls: 'missing', text: 'Not available'};
  if (q.status === 'stale' || q.status === 'missing') return {word: 'stale', cls: 'stale', text: 'Stale: last quote ' + String(q.ts || '').slice(0, 16).replace('T', ' ')};
  const session = meta && meta.session, src = String((q.provider || (meta && meta.source) || '')).toLowerCase();
  if (session && session !== 'regular') return {word: 'closed', cls: 'closed', text: 'Market closed: last quote ' + String(q.ts || '').slice(0, 16).replace('T', ' ') + ' ET'};
  if (/delay/.test(src)) return {word: 'delayed 15m', cls: 'delayed', text: 'Delayed about 15 minutes'};
  const age = q.ts ? ((now || Date.now()) - Date.parse(q.ts)) / 1000 : Infinity;
  return age <= 60 ? {word: 'live', cls: 'fresh', text: 'Real-time quote'} : {word: 'delayed', cls: 'delayed', text: 'Quote is ' + Math.round(age / 60) + ' min old'};
}

/* ---------- browser ---------- */
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));
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
function loadPrefs() { const d = {tf: 'D', sma20: true, sma50: true, sma200: true, sr: true, band: true, rs: false, rsi: false, macd: false, ev: true}; try { return Object.assign(d, JSON.parse(root.localStorage.getItem(LS) || '{}')); } catch (e) { return d; } }
function savePrefs(p) { try { root.localStorage.setItem(LS, JSON.stringify(p)); } catch (e) { /* storage blocked: toggles last for this view */ } }
const f2 = v => isNum(v) ? v.toFixed(2) : 'n/a';
const fVol = v => !isNum(v) ? 'n/a' : v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(0) + 'K' : String(v);
const TOGGLES = [['sma20', 'SMA 20', COL.sma20], ['sma50', 'SMA 50', COL.sma50], ['sma200', 'SMA 200', COL.sma200], ['sr', 'Support / resistance'], ['band', '52-week range'], ['ev', 'Events'], ['rs', 'Strength vs SPY'], ['rsi', 'RSI'], ['macd', 'MACD']];
const GLOSS = {rs: 'Price divided by SPY, rebased to 100. Rising means it is beating the index.', rsi: 'Relative Strength Index, 14 sessions. Above 70 is stretched, below 30 is washed out.', macd: 'Gap between 12 and 26 session averages, with a 9 session signal line.', sr: 'Price levels touched by the most swing highs and lows in the last 120 sessions.', band: 'Highest high and lowest low of the last 252 sessions.'};

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
  if (C.rows.length < 2) { el.innerHTML = `<p class="fv-err" role="alert">Chart not available for ${esc(t)}: fewer than 2 price bars.</p>`; return {destroy() { el.innerHTML = ''; }}; }
  const row = cr.row, q = quotes && quotes.quotes ? quotes.quotes[t] : null;
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
    ${C.hasOHLC ? '' : '<p class="fv-note">Candles are not available for this name: the data has closing prices only, so this is a line chart.</p>'}
    <div class="fv-panes"><div class="fv-main"></div></div>
    <div class="fv-evrow" hidden></div>
    <details class="fv-layers"${root.innerWidth >= 600 ? ' open' : ''}><summary>Chart layers</summary><div class="fv-toggles" role="group" aria-label="Chart layers">${TOGGLES.map(([k, l, c]) => `<label class="fv-tg"${GLOSS[k] ? ` title="${esc(GLOSS[k])}"` : ''}><input type="checkbox" data-k="${k}" ${prefs[k] ? 'checked' : ''}>${c ? `<i style="background:${c}"></i>` : ''}${esc(l)}</label>`).join('')}</div></details>
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
  let charts = [], main = null, priceSeries = null, mainLines = [];

  function build(anim) {
    charts.forEach(c => c.remove()); charts = []; mainLines = [];
    panes.querySelectorAll('.fv-sub').forEach(n => n.remove());
    const tf = prefs.tf, rows = resample(C.rows, tf), times = rows.map(b => b[0]), closes = rows.map(b => b[4]);
    const ev = events(row, C.rows, opts.events);
    const nextEv = ev.find(e => !e.past);
    const future = tf === 'D' && prefs.ev && nextEv ? futureDays(times[times.length - 1], nextEv.date, 70) : [];
    const ws = future.map(d => ({time: d}));
    main = LW.createChart(mainEl, base(H)); charts.push(main);
    if (C.hasOHLC) {
      priceSeries = main.addCandlestickSeries({upColor: COL.up, downColor: COL.down, borderUpColor: COL.up, borderDownColor: COL.down, wickUpColor: COL.up, wickDownColor: COL.down, priceLineVisible: false, lastValueVisible: true});
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
    if (prefs.sr) for (const L of srLevels(pres)) mainLines.push(priceSeries.createPriceLine({price: L.price, color: L.kind === 'support' ? COL.sup : COL.res, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: L.kind === 'support' ? 'Support' : 'Resistance'}));
    const w52 = week52(C.rows);
    if (prefs.band && w52) {
      mainLines.push(priceSeries.createPriceLine({price: w52.hi, color: COL.band, lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: '52w high'}));
      mainLines.push(priceSeries.createPriceLine({price: w52.lo, color: COL.band, lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: '52w low'}));
    }
    const fr = freshness(q, quotes);
    if (q && isNum(q.price) && fr.word !== 'missing') mainLines.push(priceSeries.createPriceLine({price: q.price, color: COL.last, lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: fr.word === 'live' ? 'Last' : 'Last quote'}));
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
      const s = c.addLineSeries({color: COL.rs, lineWidth: 2, priceLineVisible: false}); s.setData(wsData(rsLine(rows, spy || [])));
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
  if (prefs.rs) spy = await getJSON('data/px/SPY.json', true).then(j => clean(j.bars).rows.map(b => [b[0], b[4]])).catch(() => null);
  build(true); renderPatterns();
  el.addEventListener('click', e => { const b = e.target.closest('[data-tf]'); if (!b) return; prefs.tf = b.dataset.tf; savePrefs(prefs); el.querySelectorAll('[data-tf]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); build(true); });
  el.addEventListener('change', async e => {
    const k = e.target.dataset && e.target.dataset.k; if (!k) return; prefs[k] = e.target.checked; savePrefs(prefs);
    if (k === 'rs' && prefs.rs && !spy) spy = await getJSON('data/px/SPY.json', true).then(j => clean(j.bars).rows.map(b => [b[0], b[4]])).catch(() => null);
    build(false);
  });
  let lastW = mainEl.clientWidth;
  const ro = root.ResizeObserver ? new ResizeObserver(() => { const w = mainEl.clientWidth; if (Math.abs(w - lastW) < 2) return; lastW = w; charts.forEach(c => c.applyOptions({width: Math.max(280, w)})); }) : null;
  if (ro) ro.observe(mainEl);
  return {
    setTimeframe(tf) { if (!['D', 'W', 'M'].includes(tf)) return; prefs.tf = tf; build(true); },
    destroy() { if (ro) ro.disconnect(); charts.forEach(c => c.remove()); charts = []; el.innerHTML = ''; el.classList.remove('so-fv'); },
  };
}

const API = {clean, resample, sma, rsLine, week52, srLevels, patternChips, events, futureDays, freshness, mount};
if (typeof module !== 'undefined' && module.exports) module.exports = API;
root.SmartOptionsChart = API;
})(typeof window !== 'undefined' ? window : globalThis);
