/* S&P 500 heatmap (lane BU2). Squarified treemap grouped by sector, tile area = market cap,
   color = % change over 1D / 1W / 1M. Plain SVG, no library.
   window.SmartOptionsHeatmap.mount(el, {period, onSelect}) -> {setPeriod, highlight, refresh, destroy}
   Data: data/core.json rows (t, n, sec, mcap, px, pxd, d1, d5, m1; changes are percent values) and
   data/quotes.json (1D price + change when the quote is ok and not older than the core session). */
(function (root) {
'use strict';
const isNum = x => typeof x === 'number' && isFinite(x);
const PERIODS = {
  '1D': {key: 'd1', cap: 3, label: '1 day'},
  '1W': {key: 'd5', cap: 6, label: '1 week (5 sessions)'},
  '1M': {key: 'm1', cap: 12, label: '1 month (21 sessions)'},
};
// Finviz map stops at -3..+3 steps of the period cap; the colorblind set swaps red/green for orange/blue.
const PALETTES = {
  finviz: ['#f63538', '#bf4045', '#8b444e', '#414554', '#35764e', '#2f9e4f', '#30cc5a'],
  cb: ['#e66100', '#b5582a', '#7e4e3f', '#414554', '#3b5d86', '#2f72b8', '#3d93e6'],
};
const NEUTRAL_NA = '#9aa1ad';

/* ---------- pure layout ---------- */
function worst(row, side) {
  let s = 0, mx = -Infinity, mn = Infinity;
  for (const a of row) { s += a; if (a > mx) mx = a; if (a < mn) mn = a; }
  const s2 = s * s, side2 = side * side;
  return Math.max(side2 * mx / s2, s2 / (side2 * mn));
}
/* squarify(values, x, y, w, h): values sorted descending, > 0. Returns rects in input order. */
function squarify(values, x, y, w, h) {
  const out = [], total = values.reduce((s, v) => s + v, 0);
  if (!values.length || !(total > 0) || !(w > 0) || !(h > 0)) return values.map(() => ({x, y, w: 0, h: 0}));
  const areas = values.map(v => v / total * w * h);
  let i = 0;
  while (i < areas.length) {
    const side = Math.min(w, h), row = [areas[i]];
    let j = i + 1;
    while (j < areas.length && worst(row.concat(areas[j]), side) <= worst(row, side)) { row.push(areas[j]); j++; }
    const s = row.reduce((a, b) => a + b, 0), last = j >= areas.length;
    if (w >= h) {
      const cw = last ? w : s / h; let yy = y;
      row.forEach((a, k) => { const hh = k === row.length - 1 ? y + h - yy : a / cw; out.push({x, y: yy, w: cw, h: hh}); yy += hh; });
      x += cw; w -= cw;
    } else {
      const rh = last ? h : s / w; let xx = x;
      row.forEach((a, k) => { const ww = k === row.length - 1 ? x + w - xx : a / rh; out.push({x: xx, y, w: ww, h: rh}); xx += ww; });
      y += rh; h -= rh;
    }
    i = j;
  }
  return out;
}
/* layout(items, w, h, opts): items [{t, sec, mcap}] -> {sectors:[{sec, x,y,w,h, mcap, n, hdr}], tiles:[{t, sec, x,y,w,h}]}
   Deterministic: sectors and names ordered by mcap desc, ties by name. */
function layout(items, w, h, opts) {
  opts = opts || {}; const hdrH = opts.hdr == null ? 18 : opts.hdr, gap = opts.gap == null ? 2 : opts.gap;
  const bySec = new Map();
  for (const it of items) { if (!(isNum(it.mcap) && it.mcap > 0)) continue; const k = it.sec || 'Other'; if (!bySec.has(k)) bySec.set(k, []); bySec.get(k).push(it); }
  const cmp = (a, b) => b.mcap - a.mcap || String(a.t).localeCompare(String(b.t));
  const secs = [...bySec.entries()].map(([sec, arr]) => ({sec, arr: arr.sort(cmp), mcap: arr.reduce((s, x) => s + x.mcap, 0)}))
    .sort((a, b) => b.mcap - a.mcap || a.sec.localeCompare(b.sec));
  const sr = squarify(secs.map(s => s.mcap), 0, 0, w, h);
  const sectors = [], tiles = [];
  secs.forEach((s, i) => {
    const r = sr[i], hdr = r.h > 60 && r.w > 70 ? hdrH : 0;
    const inner = {x: r.x + gap / 2, y: r.y + gap / 2 + hdr, w: Math.max(0, r.w - gap), h: Math.max(0, r.h - gap - hdr)};
    sectors.push({sec: s.sec, x: r.x, y: r.y, w: r.w, h: r.h, mcap: s.mcap, n: s.arr.length, hdr});
    const tr = squarify(s.arr.map(x => x.mcap), inner.x, inner.y, inner.w, inner.h);
    s.arr.forEach((it, k) => tiles.push({t: it.t, sec: s.sec, x: tr[k].x, y: tr[k].y, w: tr[k].w, h: tr[k].h}));
  });
  return {sectors, tiles};
}
function hexToRgb(hx) { const n = parseInt(hx.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
function rgbToHex(c) { return '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join(''); }
/* colorFor(pct, period, palette) -> hex. pct is a percent value (1.5 = +1.5%). null -> neutral grey. */
function colorFor(pct, period, palette) {
  if (!isNum(pct)) return NEUTRAL_NA;
  const stops = PALETTES[palette] || PALETTES.finviz, cap = (PERIODS[period] || PERIODS['1D']).cap;
  const t = (Math.max(-1, Math.min(1, pct / cap)) + 1) * 3, i = Math.min(5, Math.floor(t)), f = t - i;
  const a = hexToRgb(stops[i]), b = hexToRgb(stops[i + 1]);
  return rgbToHex(a.map((v, k) => v + (b[k] - v) * f));
}
/* changeOf(row, quote, period): {pct, px, src}. 1D prefers an ok quote dated on/after the core session. */
function changeOf(row, q, period) {
  const key = (PERIODS[period] || PERIODS['1D']).key;
  const L=root.SmartOptionsLive,state=L?.feedSummary?L.feedSummary({[row.t]:q},[row.t],Date.now()).items[0].state:null;
  if(q&&(q.current_usable===false||['missing','stale','blocked'].includes(state)))return {pct:null,px:null,src:'unavailable',ts:q.ts||q.asof_utc};
  const qOk = q && isNum(q.price) && q.price>0 && (!row.pxd || String(q.ts || q.asof_utc || '').slice(0,10)>=row.pxd);
  const px=qOk?q.price:null;
  if(period==='1D' && qOk) return {pct:isNum(q.chg_pct)?q.chg_pct:null,px,src:'quote',ts:q.ts||q.asof_utc};
  return {pct:isNum(row[key])?row[key]:null,px,src:'core',ts:row.pxd||null};
}
/* sectorStats(rows, quotes, period): cap-weighted % change per sector over names with a value. */
function sectorStats(rows, quotes, period) {
  const m = new Map();
  for (const r of rows) {
    if (!(isNum(r.mcap) && r.mcap > 0)) continue;
    const c = changeOf(r, quotes && quotes[r.t], period), k = r.sec || 'Other';
    if (!m.has(k)) m.set(k, {sec: k, n: 0, w: 0, s: 0, up: 0, down: 0, mcap: 0});
    const o = m.get(k); o.n++; o.mcap += r.mcap;
    if (isNum(c.pct)) { o.w += r.mcap; o.s += r.mcap * c.pct; if (c.pct > 0) o.up++; else if (c.pct < 0) o.down++; }
  }
  return [...m.values()].map(o => ({sec: o.sec, n: o.n, mcap: o.mcap, up: o.up, down: o.down, pct: o.w > 0 ? o.s / o.w : null}))
    .sort((a, b) => b.mcap - a.mcap);
}
/* Main brief contract: one explicit regular-close session per map. A newer
   partial quote universe never gets mixed with the older close. */
// One formatter and a per-timestamp cache: per-row Intl construction dominated map repaints on phones (measured).
const ET_FMT=typeof Intl!=='undefined'?new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'numeric',hour12:false}):null, ET_PARTS=new Map();
const ET_DAYS=new Map();
function etDay(stamp){stamp=String(stamp);let d=ET_DAYS.get(stamp);if(d===undefined){d=new Date(stamp).toLocaleDateString('en-CA',{timeZone:'America/New_York'});if(ET_DAYS.size>4000)ET_DAYS.clear();ET_DAYS.set(stamp,d);}return d;}
function sessionMap(rows, quotes, period, session) {
  const members=rows.filter(r=>r.sp500_member!==false && isNum(r.mcap) && r.mcap>0);
  const key=(PERIODS[period]||PERIODS['1D']).key;
  const values=members.map(r=>{
    const q=quotes?.[r.t], L=root.SmartOptionsLive;
    const day=q && L?.sessionDate ? L.sessionDate(q.asof_utc||q.ts) : q && etDay(q.asof_utc||q.ts);
    let regular=q?.market_hours===1;
    if(q && q.market_hours==null){const stamp=String(q.asof_utc||q.ts);let parts=ET_PARTS.get(stamp);if(!parts){parts={};ET_FMT.formatToParts(new Date(stamp)).forEach(x=>parts[x.type]=x.value);if(ET_PARTS.size>4000)ET_PARTS.clear();ET_PARTS.set(stamp,parts);}const minutes=(+parts.hour%24)*60+(+parts.minute);regular=minutes>=570&&minutes<=975;}
    const usable=period==='1D' && q && q.current_usable!==false && day===session && isNum(q.chg_pct) && regular;
    return {...r, value:usable?q.chg_pct:r.pxd===session && isNum(r[key])?r[key]:null};
  });
  const sectors=[...new Set(values.map(r=>r.sec))].map(sec=>{
    const a=values.filter(r=>r.sec===sec), covered=a.filter(r=>isNum(r.value));
    const cap=a.reduce((s,r)=>s+r.mcap,0), weight=covered.reduce((s,r)=>s+r.mcap,0);
    return {sec,mcap:cap,n:a.length,covered:covered.length,coverage:weight/cap,pct:weight?covered.reduce((s,r)=>s+r.mcap*r.value,0)/weight:null};
  });
  return {session,period,values,sectors,covered:values.filter(r=>isNum(r.value)).length,members:members.length};
}
const fmtPct = p => isNum(p) ? (p > 0 ? '+' : p < 0 ? '−' : '') + Math.abs(p).toFixed(2) + '%' : 'Not available';
const fmtCap = v => !isNum(v) ? 'Not available' : v >= 1e12 ? '$' + (v / 1e12).toFixed(2) + 'T' : v >= 1e9 ? '$' + (v / 1e9).toFixed(1) + 'B' : '$' + (v / 1e6).toFixed(0) + 'M';
const fmtPx = v => isNum(v) ? '$' + v.toFixed(2) : 'Not available';
function memberRows(core) {
  const rows = core.rows || [], symbols = core.meta && core.meta.constituents && core.meta.constituents.symbols;
  const membershipKnown = rows.some(r => typeof r.sp500_member === 'boolean');
  const members = Array.isArray(symbols) ? new Set(symbols) : null;
  return rows.filter(r => r && r.t && isNum(r.mcap) && r.mcap > 0 &&
    (membershipKnown ? r.sp500_member === true : members ? members.has(r.t) : true));
}

/* ---------- browser ---------- */
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));
const reduced = () => !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
async function getJSON(url) { const r = await fetch(url, {cache: 'no-store'}); if (!r.ok) throw new Error(url + ' HTTP ' + r.status); return r.json(); }
let coreP = null;
function getCore() {
  try { const d = root.SO2 && root.SO2.D && root.SO2.D(); if (d && d.rows) return Promise.resolve(d); } catch (e) { /* SO2 not ready: fetch our own copy */ }
  if (!coreP) coreP = getJSON('data/core.json').catch(e => { coreP = null; throw e; });
  return coreP;
}
async function getQuotes() { try { return await getJSON('data/quotes.json'); } catch (e) { return {quotes: {}, err: String(e && e.message || e)}; } }
const LS_CB = 'so_hm_cb';
const lsGet = k => { try { return root.localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { root.localStorage.setItem(k, v); } catch (e) { /* storage blocked: setting lasts for this view */ } };
const SVGNS = 'http://www.w3.org/2000/svg';

function mount(el, opts) {
  opts = opts || {};
  // remount on the same element (the landing re-calls mount on its own period buttons): re-color in place
  if (el.__soHm && el.__soHm.alive()) { const h = el.__soHm; h.setOptions(opts); if (opts.period) h.setPeriod(opts.period); return h; }
  if (!opts.onSelect) opts.onSelect = t => { root.location.hash = '#/company/' + encodeURIComponent(t); };
  // embedded in the landing (opts.brief given): the landing owns the period buttons
  const ownSeg = opts.controls != null ? !!opts.controls : !opts.brief;
  const st = {period: PERIODS[opts.period] ? opts.period : '1D', pal: lsGet(LS_CB) === '1' ? 'cb' : 'finviz', zoom: null, q: '', rows: [], quotes: {}, qmeta: {}, core: null, timer: null, alive: true};
  const t0 = (root.performance && performance.now()) || 0;
  el.classList.add('so-hm');
  el.innerHTML = `
    <div class="hm-bar">
      <div class="hm-seg" role="group" aria-label="Period"${ownSeg ? '' : ' hidden'}>${Object.keys(PERIODS).map(p => `<button type="button" data-p="${p}" aria-pressed="${p === st.period}">${p}</button>`).join('')}</div>
      <label class="hm-search"><span class="hm-vh">Find a ticker</span><input type="search" placeholder="Find ticker" autocomplete="off" spellcheck="false" maxlength="8"></label>
      <button type="button" class="hm-back" hidden>All sectors</button><h3 class="hm-ztitle" hidden></h3>
    </div>
    <div class="hm-sectors" aria-label="Sectors"></div>
    <p class="hm-swipe">Swipe sideways to see the whole map.</p>
    <div class="hm-scroll"><div class="hm-stage" role="img" aria-label="S&amp;P 500 heatmap"><div class="hm-skel">Loading prices</div></div></div>
    <div class="hm-legend"></div>
    <div class="hm-tip" role="tooltip" hidden></div>`;
  const $ = s => el.querySelector(s);
  const stage = $('.hm-stage'), tip = $('.hm-tip'), back = $('.hm-back'), input = $('input'), secList = $('.hm-sectors');
  const byT = new Map();
  let svg = null, tileEls = new Map();

  const sizeOf = () => {
    const w = Math.max(320, stage.clientWidth || el.clientWidth || 960);
    const h = Math.round(Math.max(380, Math.min(680, w * 0.58)));
    return {w, h};
  };
  function render(anim) {
    if (!st.rows.length) return;
    const {w, h} = sizeOf();
    const items = st.zoom ? st.rows.filter(r => r.sec === st.zoom) : st.rows;
    const L = layout(items, w, h, {hdr: st.zoom ? 0 : 18});
    svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`); svg.setAttribute('width', w); svg.setAttribute('height', h);
    svg.setAttribute('class', 'hm-svg' + (anim ? ' hm-in' : ''));
    const parts = [];
    for (const s of L.sectors) {
      parts.push(`<rect class="hm-secbg" x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}"/>`);
      if (s.hdr) parts.push(`<g class="hm-sechdr" data-sec="${esc(s.sec)}" tabindex="0" role="button" aria-label="Zoom into ${esc(s.sec)}"><rect x="${s.x + 1}" y="${s.y + 1}" width="${Math.max(0, s.w - 2)}" height="${s.hdr - 1}"/><text x="${s.x + 6}" y="${s.y + 13}">${esc(clip(s.sec.toUpperCase(), s.w - 12, 6.6))}</text></g>`);
    }
    tileEls = new Map();
    L.tiles.forEach((tl, i) => {
      const r = byT.get(tl.t), c = changeOf(r, st.quotes[tl.t], st.period), na = !isNum(c.pct);
      const fs = Math.max(9, Math.min(st.zoom ? 34 : 26, Math.min(tl.w / (tl.t.length * 0.66 + 0.6), tl.h * 0.36)));
      const pTxt = na ? 'Not available' : fmtPct(c.pct), pfs = Math.max(9, fs * 0.62);
      const showT = tl.w >= 26 && tl.h >= 15 && fs >= 9, showP = showT && tl.h >= fs * 2.3 + 4 && pTxt.length * pfs * 0.6 <= tl.w - 4;
      const cx = tl.x + tl.w / 2, cy = tl.y + tl.h / 2;
      const delay = anim && !reduced() ? Math.min(420, i * 1.2) : 0;
      parts.push(`<g class="hm-tile${na ? ' hm-na' : ''}" data-live="${esc(tl.t)}" data-live-f="watch" data-t="${esc(tl.t)}" style="--d:${delay}ms">` +
        `<rect x="${tl.x + 0.5}" y="${tl.y + 0.5}" width="${Math.max(0, tl.w - 1)}" height="${Math.max(0, tl.h - 1)}" style="fill:${colorFor(c.pct, st.period, st.pal)}"/>` +
        (showT ? `<text class="hm-t" x="${cx}" y="${showP ? cy - fs * 0.12 : cy + fs * 0.35}" style="font-size:${fs.toFixed(1)}px">${esc(tl.t)}</text>` : '') +
        (showP ? `<text class="hm-p" x="${cx}" y="${cy + fs * 0.95}" style="font-size:${pfs.toFixed(1)}px">${esc(pTxt)}</text>` : '') + '</g>');
    });
    svg.innerHTML = parts.join('');
    stage.replaceChildren(svg);
    svg.querySelectorAll('.hm-tile').forEach(g => tileEls.set(g.dataset.t, g));
    applyHighlight();
    renderSectors(); renderLegend();
    if(root.SmartOptionsLive?.paint)root.SmartOptionsLive.paint(svg);
  }
  // re-color in place (period change / live quotes): CSS transition on fill gives the cross-fade
  function recolor() {
    if (!svg) return render(false);
    for (const [t, g] of tileEls) {
      const c = changeOf(byT.get(t), st.quotes[t], st.period), rect = g.firstChild;
      rect.style.fill = colorFor(c.pct, st.period, st.pal);
      g.classList.toggle('hm-na', !isNum(c.pct));
      const p = g.querySelector('.hm-p'); if (p) { const tx = isNum(c.pct) ? fmtPct(c.pct) : 'Not available', r = g.firstChild, fs = parseFloat(p.style.fontSize) || 10; p.textContent = tx; p.style.display = tx.length * fs * 0.6 <= (+r.getAttribute('width')) - 3 ? '' : 'none'; }
    }
    renderSectors(); renderLegend();
  }
  function renderSectors() {
    const ss = sectorStats(st.rows, st.quotes, st.period);
    const mx = Math.max(0.01, ...ss.map(s => isNum(s.pct) ? Math.abs(s.pct) : 0));
    secList.innerHTML = ss.map(s => {
      const wpct = isNum(s.pct) ? Math.abs(s.pct) / mx * 50 : 0, pos = isNum(s.pct) && s.pct >= 0;
      return `<button type="button" class="hm-secrow${st.zoom === s.sec ? ' on' : ''}" data-sec="${esc(s.sec)}" aria-pressed="${st.zoom === s.sec}">
        <span class="hm-secname">${esc(s.sec)}</span>
        <span class="hm-minibar" aria-hidden="true"><i style="${pos ? 'left:50%' : 'right:50%'};width:${wpct.toFixed(1)}%;background:${colorFor(s.pct, st.period, st.pal)}"></i></span>
        <span class="hm-secpct">${esc(fmtPct(s.pct))}</span></button>`;
    }).join('');
  }
  function renderLegend() {
    const P = PERIODS[st.period], stops = PALETTES[st.pal];
    const n = st.rows.length, total = st.core && st.core.meta && st.core.meta.counts && st.core.meta.counts.constituents;
    const live = st.period === '1D' ? st.rows.filter(r => changeOf(r, st.quotes[r.t], st.period).src === 'quote').length : 0;
    const steps = [-3, -2, -1, 0, 1, 2, 3].map(k => (k * P.cap / 3));
    el.querySelector('.hm-legend').innerHTML = `
      <div class="hm-scale" aria-label="Color scale">${stops.map((c, i) => `<span style="background:${c}">${(steps[i] > 0 ? '+' : steps[i] < 0 ? '−' : '') + Math.abs(steps[i]) + '%'}</span>`).join('')}</div>
      <label class="hm-cb"><input type="checkbox" ${st.pal === 'cb' ? 'checked' : ''}> Colorblind-safe colors</label>
      <p class="hm-note">Tile size is market cap. Color is % change over ${esc(P.label)}${st.period === '1D' ? '' : ', from adjusted closes'}.
        ${total ? `${n} of ${total} S&amp;P 500 names have data in this build; ${Math.max(0, total - n)} are not shown.` : ''}
        Prices: ${esc(st.qmeta.source || 'Yahoo Finance via yfinance')}${st.period === '1D' ? `; ${live} names updated from the quote feed, the rest from the ${esc(st.core && st.core.asof_session || '')} close` : `; session ${esc(st.core && st.core.asof_session || '')}`}.</p>`;
  }
  function applyHighlight() {
    const q = st.q.trim().toUpperCase();
    if (svg) svg.classList.toggle('hm-searching', !!q);
    for (const [t, g] of tileEls) g.classList.toggle('hm-hit', !!q && t.startsWith(q));
  }
  function showTip(t, ev) {
    const r = byT.get(t); if (!r) return;
    root.SmartOptionsLive?.watch('heatmap-hover',[t]);
    const c = changeOf(r, st.quotes[t], st.period);
    const peers = st.rows.filter(x => x.sec === r.sec && x.t !== t).sort((a, b) => b.mcap - a.mcap).slice(0, 5);
    tip.innerHTML = `<div class="hm-tip-h"><b>${esc(t)}</b> <span>${esc(r.n || '')}</span></div>
      <div class="hm-tip-row"><span>Price</span><b>${esc(fmtPx(c.px))}</b><small>${esc(st.quotes[t] ? (st.quotes[t].ts||st.quotes[t].asof_utc||'') : r.pxd||'')} · ${esc(root.SmartOptionsLive?.classify(st.quotes[t],Date.now()).label||'last close')}</small></div>
      <div class="hm-tip-row"><span>Change, ${esc(st.period)}</span><b class="${isNum(c.pct) ? (c.pct >= 0 ? 'up' : 'dn') : ''}">${esc(fmtPct(c.pct))}</b></div>
      <div class="hm-tip-row"><span>Market cap</span><b>${esc(fmtCap(r.mcap))}</b></div>
      <div class="hm-tip-row"><span>Sector</span><b>${esc(r.sec || 'Not available')}</b></div>
      ${root.SmartOptionsImpact ? root.SmartOptionsImpact.tag('breadth', {what: 'sector participation'}) : ''}
      ${peers.length ? `<div class="hm-tip-peers">${peers.map(p => { const pc = changeOf(p, st.quotes[p.t], st.period); return `<span><i style="background:${colorFor(pc.pct, st.period, st.pal)}"></i>${esc(p.t)} ${esc(fmtPct(pc.pct))}</span>`; }).join('')}</div>` : ''}
      <div class="hm-tip-src">${c.src === 'quote' ? 'Quote ' + esc(fmtET(c.ts)) + ', ' + esc((st.quotes[t] && st.quotes[t].provider) || st.qmeta.source || '') : 'Close ' + esc(c.ts || '') + ', Yahoo Finance via yfinance'}</div>`;
    tip.hidden = false; moveTip(ev);
  }
  function moveTip(ev) {
    const b = el.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = ev.clientX - b.left + 14, y = ev.clientY - b.top + 14;
    if (x + tw > b.width) x = Math.max(4, ev.clientX - b.left - tw - 14);
    if (y + th > b.height) y = Math.max(4, ev.clientY - b.top - th - 14);
    tip.style.transform = `translate(${x}px,${y}px)`;
  }
  function setZoom(sec) {
    st.zoom = sec && st.zoom !== sec ? sec : null;
    back.hidden = !st.zoom;
    const zt = el.querySelector('.hm-ztitle'); zt.hidden = !st.zoom; zt.textContent = st.zoom || '';
    stage.setAttribute('aria-label', st.zoom ? `${st.zoom} heatmap` : 'S&P 500 heatmap');
    render(true);
  }
  function setPeriod(p) {
    if (!PERIODS[p]) return; st.period = p;
    el.querySelectorAll('.hm-seg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.p === p)));
    recolor(); armLive();
  }
  async function pollQuotes() {
    if (!st.alive || st.period !== '1D' || (typeof document !== 'undefined' && document.hidden)) return;
    const q = await getQuotes(); if (!st.alive) return;
    if (q.generated_at && q.generated_at !== st.qmeta.generated_at) { st.qmeta = q; if (takeNewer(q.quotes || {})) recolor(); }
  }
  // newest observation per name wins, so the shared file never overwrites a newer fast-path price
  function takeNewer(incoming) {
    let n = 0;
    for (const [t, q] of Object.entries(incoming || {})) {
      if (!q || !isNum(q.price)) continue;
      const cur = st.quotes[t], tn = Date.parse(q.asof_utc || q.ts || ''), tc = cur ? Date.parse(cur.asof_utc || cur.ts || '') : NaN;
      if (cur && isFinite(tc) && (!isFinite(tn) || tc >= tn) && cur.price === q.price) continue;
      if (cur && isFinite(tc) && isFinite(tn) && tc > tn) continue;
      // the Live engine labels freshness separately; a priced, timestamped observation is usable for colour
      st.quotes[t] = Object.assign({}, q, {status: 'ok', change_status: isNum(q.chg_pct) ? 'ok' : q.change_status, ts: q.ts || q.asof_utc});
      n++;
    }
    return n;
  }
  const L = root.SmartOptionsLive;
  if(L&&L.paint)L.paint(el);
  const unsub = L && L.subscribe ? L.subscribe(ev => {
    if (!st.alive || !st.rows.length || !ev.changed || !ev.changed.length) return;
    const xs = {}; ev.changed.forEach(t => { if (byT.has(t)) { const q = L.get(t); if (q) xs[t] = q; } });
    if (takeNewer(xs) && st.period === '1D') recolor();
  }) : null;
  function armLive() { clearInterval(st.timer); st.timer = st.period === '1D' ? setInterval(pollQuotes, 60000) : null; }

  el.addEventListener('click', e => {
    const pb = e.target.closest('.hm-seg button'); if (pb) return setPeriod(pb.dataset.p);
    if (e.target.closest('.hm-back')) return setZoom(null);
    const sh = e.target.closest('[data-sec]'); if (sh) return setZoom(sh.dataset.sec);
    const tg = e.target.closest('.hm-tile'); if (tg && opts.onSelect) opts.onSelect(tg.dataset.t);
  });
  el.addEventListener('keydown', e => {
    const sh = e.target.closest('g[data-sec]'); if (sh && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setZoom(sh.dataset.sec); }
    if (e.key === 'Escape' && st.zoom) setZoom(null);
  });
  el.addEventListener('change', e => { if (e.target.closest('.hm-cb')) { st.pal = e.target.checked ? 'cb' : 'finviz'; lsSet(LS_CB, st.pal === 'cb' ? '1' : '0'); recolor(); } });
  input.addEventListener('input', () => { st.q = input.value; applyHighlight(); });
  input.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return; const q = input.value.trim().toUpperCase(); if (!q) return;
    const hit = byT.has(q) ? q : st.rows.map(r => r.t).find(t => t.startsWith(q));
    if (hit && opts.onSelect) opts.onSelect(hit);
  });
  stage.addEventListener('mousemove', e => { const g = e.target.closest('.hm-tile'); if (!g) { tip.hidden = true; return; } if (tip.dataset.t !== g.dataset.t || tip.hidden) { tip.dataset.t = g.dataset.t; showTip(g.dataset.t, e); } else moveTip(e); });
  stage.addEventListener('mouseleave', () => { tip.hidden = true; });
  let rz = null, lastW = 0;
  const ro = root.ResizeObserver ? new ResizeObserver(() => { const w = stage.clientWidth; if (Math.abs(w - lastW) < 4) return; lastW = w; clearTimeout(rz); rz = setTimeout(() => render(false), 120); }) : null;

  const ready = Promise.all([getCore(), getQuotes()]).then(([core, q]) => {
    if (!st.alive) return;
    st.core = core; st.quotes = q.quotes || {}; st.qmeta = q;
    st.rows = memberRows(core);
    st.rows.forEach(r => byT.set(r.t, r));
    render(true); lastW = stage.clientWidth; if (ro) ro.observe(stage); armLive();
    const ms = Math.round(((root.performance && performance.now()) || 0) - t0);
    el.dataset.firstPaintMs = String(ms); root.__soHeatmapFirstPaintMs = ms; root.__soHeatmapPaintAt = Math.round(((root.performance && performance.now()) || 0)); root.__soHeatmapPaintAt = Math.round((root.performance && performance.now()) || 0);
  }).catch(e => {
    stage.innerHTML = `<div class="hm-err" role="alert">Heatmap not available: ${esc(e && e.message || e)}</div>`;
  });
  const api = {
    ready, setPeriod, refresh: pollQuotes, alive: () => st.alive,
    setOptions: o => { if (o.onSelect) opts.onSelect = o.onSelect; },
    highlight: t => { st.q = String(t || ''); input.value = st.q; applyHighlight(); },
    destroy: () => { st.alive = false; clearInterval(st.timer); if (unsub) unsub(); if (ro) ro.disconnect(); el.innerHTML = ''; el.classList.remove('so-hm'); el.__soHm = null; },
  };
  el.__soHm = api;
  return api;
}
/* fmtET(ts): provider timestamp shown in New York time, e.g. 'Oct 15, 4:00 PM ET' */
function fmtET(ts) {
  const d = new Date(ts); if (!ts || isNaN(d)) return String(ts || 'time not stated');
  try { return d.toLocaleString('en-US', {timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}) + ' ET'; } catch (e) { return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; }
}
function clip(s, px, cw) { const n = Math.floor(px / cw); return s.length <= n ? s : n > 3 ? s.slice(0, n - 1) + '…' : ''; }

const API = {sessionMap, fmtET, PERIODS, PALETTES, squarify, layout, colorFor, changeOf, sectorStats, fmtPct, fmtCap, memberRows, mount};
if (typeof module !== 'undefined' && module.exports) module.exports = API;
root.SmartOptionsHeatmap = API;
})(typeof window !== 'undefined' ? window : globalThis);
