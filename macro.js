/* Macro tab: grouped small multiples, sector x factor heatmap, calendar timeline. */
'use strict';
(function () {
const GROUPS = [['inflation', 'Inflation'], ['labor', 'Labor'], ['growth', 'Growth'], ['policy', 'Policy'], ['curve', 'Curve'],
  ['cross_asset', 'Cross-asset'], ['credit_funding', 'Credit / funding'], ['volatility', 'Volatility']];
const HIDE = /_(bps_chg|ret_1d|ret_5d|ret_20d)$/;   // daily-change helper series; their info is shown as the tile change
function chartSvg(h, w, ht) {
  const A = window.SO2;
  const v = (h || []).map(p => p[1]).filter(A.isNum);
  if (v.length < 2) return `<svg width="100%" height="${ht}"></svg>`;
  const mn = Math.min(...v), mx = Math.max(...v), rg = mx - mn || 1;
  const pts = v.map((y, i) => `${(i / (v.length - 1) * w).toFixed(1)},${(ht - 2 - (y - mn) / rg * (ht - 6)).toFixed(1)}`).join(' ');
  return `<svg width="100%" height="${ht}" viewBox="0 0 ${w} ${ht}" preserveAspectRatio="none"><polyline fill="none" stroke="#8fa3b5" stroke-width="1.2" vector-effect="non-scaling-stroke" points="${pts}"/></svg>`;
}
function tile(o) {
  const A = window.SO2;
  const h = o.h || [];
  const first = h.length ? h[0][0] : '', last = h.length ? h[h.length - 1][0] : '';
  const chg = A.isNum(o.v) && A.isNum(o.prior) ? o.v - o.prior : null;
  const vs = A.isNum(o.v) ? A.num(o.v, Math.abs(o.v) >= 1000 ? 0 : 2) : A.na(`${o.label}: ${o.status}${o.note ? ' · ' + o.note : ''}`);
  const stale = o.status && o.status !== 'ok';
  const tip = `${o.label}\n${o.provider} · ${o.series}\nperiod ${o.period} · retrieved ${o.retrieved_at || ''}\nstatus ${o.status}${o.note ? '\n' + o.note : ''}\nchart ${first} to ${last}`;
  return `<div class="mc${stale ? ' stale' : ''}" role="button" tabindex="0" aria-label="Explore ${A.esc(o.label)} chart and sources" data-s="${A.esc(o.id)}" data-tip="${A.esc(tip)}">
    <div class="l">${A.esc(o.label)}</div>
    <div><span class="v">${vs}</span> <span class="dim">${A.esc(o.unit || '')}</span> ${A.pct(chg, 2, 'no prior', '')}</div>
    <div class="sub">${A.esc(o.period || '')}</div>${chartSvg(h, 200, 34)}</div>`;
}
function renderGrid() {
  const A = window.SO2, D = A.D();
  const tr = D.rel.trends || {};
  $('#mgrid').innerHTML = GROUPS.map(([g, h]) => {
    const obs = (D.macro[g] || []).filter(o => !HIDE.test(o.id));
    if (!obs.length) return '';
    const t = tr[g];
    return `<div class="mgrp" data-g="${g}"><div class="sech"${t ? ` data-tip="${A.esc(t.evidence)}"` : ''}>${h}${t ? ` <span class="dim">trend: ${A.esc(t.label)}</span>` : ''}</div>
      <div class="mrow">${obs.map(tile).join('')}</div></div>`;
  }).join('');
}
function renderHeatmap() {
  const A = window.SO2, D = A.D(), S = A.S();
  const secs = D.rel.sectors || {}, F = A.FACTORS;
  const scen = F.some(f => S.shock[f]);
  const names = Object.keys(secs).sort();
  const cellv = (s, f) => { const c = secs[s].median_coef[f]; return !A.isNum(c) ? null : scen ? (S.shock[f] ? c * S.shock[f] : null) : c; };
  const colMax = {};
  F.forEach(f => { colMax[f] = Math.max(1e-9, ...names.map(s => Math.abs(cellv(s, f) || 0))); });
  const gMax = Math.max(1e-9, ...F.map(f => colMax[f]));
  $('#hmnote').textContent = scen ? 'cell = median coef x your shock, % (association)' : 'median coef per sector; color scaled per column';
  const head = `<tr><th></th>${F.map(f => `<th data-tip="${A.esc(D.rel.units[f] || '')}">${A.FLABEL[f]}</th>`).join('')}${scen ? '<th>Sum</th>' : ''}</tr>`;
  const body = names.map(s => {
    let sum = 0;
    const tds = F.map(f => {
      const v = cellv(s, f);
      if (v == null) return `<td class="c" style="color:#3a434c">·</td>`;
      sum += v;
      const a = Math.min(1, Math.abs(v) / (scen ? gMax : colMax[f]));
      const bg = v >= 0 ? `rgba(0,200,5,${(a * .55).toFixed(2)})` : `rgba(255,80,0,${(a * .55).toFixed(2)})`;
      return `<td class="c" style="background:${bg}" data-sec="${A.esc(s)}" data-f="${f}" data-tip="${A.esc(`${s} · ${A.FLABEL[f]}\nmedian coef ${secs[s].median_coef[f]} ${D.rel.units[f]}\nn ${secs[s].n} tickers\nclick: filter table to sector, sort by this factor`)}">${v.toFixed(scen ? 2 : 3)}</td>`;
    }).join('');
    return `<tr><td class="l">${A.esc(s)} <span class="dim">${secs[s].n}</span></td>${tds}${scen ? `<td>${A.pct(sum, 2)}</td>` : ''}</tr>`;
  }).join('');
  $('#heatmap').innerHTML = `<table class="hm">${head}${body}</table>`;
}
function renderCal() {
  const A = window.SO2, D = A.D();
  const ev = (D.calendar || []).slice().sort((a, b) => a.scheduled_et < b.scheduled_et ? -1 : 1);
  const now = new Date();
  $('#cal').innerHTML = ev.map(e => {
    const d = new Date(e.scheduled_et), dd = (d - now) / 864e5;
    const et = d.toLocaleString('en-US', {timeZone: 'America/New_York', month: 'short', day: '2-digit'});
    const tm = d.toLocaleTimeString('en-US', {timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false});
    const local = d.toLocaleString([], {weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'});
    const when = e.status === 'released' || dd < 0 ? '<span class="dim">released</span>' : dd < 1 ? `${Math.max(0, Math.round(dd * 24))}h` : `${Math.round(dd)}d`;
    return `<div class="calr" data-tip="${A.esc(`${e.title}\nET ${e.scheduled_et}\nyour time ${local}\n${e.source_url || ''}${e.note ? '\n' + e.note : ''}`)}"><span>${et} ${tm}</span><span>${A.esc(e.type)}</span><span>${A.esc(e.title)}</span><span style="text-align:right">${when}</span></div>`;
  }).join('') + `<div class="sub" style="padding:4px 10px">times ET; hover for your local time and source</div>`;
}
const $ = s => document.querySelector(s);
let wired = false;
window.SO2_macro = function () {
  if (!window.SO2) return;
  renderGrid(); renderHeatmap(); renderCal();
  if (wired) return; wired = true;
  function drill(e) { const t = e.target.closest('[data-s]'); if (!t) return; if(window.SmartOptionsExplore)window.SmartOptionsExplore.factor(t.dataset.s);else{window.SO2.showTab('markets');window.SO2.select('s',t.dataset.s);} }
  $('#mgrid').addEventListener('click', drill);
  $('#mgrid').addEventListener('keydown', e => { if(e.key==='Enter'||e.key===' '){e.preventDefault();drill(e);} });
  $('#heatmap').addEventListener('click', e => {
    const c = e.target.closest('td[data-sec]'); if (!c) return;
    const A = window.SO2; A.V.sector = c.dataset.sec; A.V.preset = 'all';
    A.V.sort = {k: 'c:' + c.dataset.f, dir: 1};
    A.showTab('markets'); A.renderTable();
  });
};
})();
