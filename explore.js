/* Evidence-led chart exploration. Comparisons describe stored observations, never a forecast. */
(function (root) {
'use strict';
const finite = v => typeof v === 'number' && Number.isFinite(v);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pct = v => finite(v) ? (v > 0 ? '+' : '') + v.toFixed(2) + '%' : '—';
const fmt = v => finite(v) ? v.toFixed(3) : '—';
const FACTOR = {SPY:'spy', spy:'spy', us10y:'us10y_bps', us10y_bps:'us10y_bps', dxy:'dxy', wti:'wti', vix:'vix'};
const OVERLAY = {spy:'SPY', us10y_bps:'us10y', dxy:'dxy', wti:'wti', vix:'vix'};
let A, box, mode = 'auto', point = null;

function peerRows(data, symbol) {
  const anchor = data.rows.find(r => r.t === symbol);
  if (!anchor) return {anchor:null, rows:[], group:'', missing:0};
  const industry = data.rows.filter(r => r.t !== symbol && r.ind && r.ind === anchor.ind && r.pxd === anchor.pxd && finite(r.d1));
  const peers = industry.length >= 2 ? industry : data.rows.filter(r => r.t !== symbol && r.sec && r.sec === anchor.sec);
  const rows = peers.filter(r => r.pxd === anchor.pxd && finite(r.d1)).sort((a,b) => b.d1-a.d1);
  return {anchor, rows, group: industry.length >= 2 ? 'Industry: '+anchor.ind : 'Broad sector: '+anchor.sec,
    missing:peers.length-rows.length};
}
function factorRows(data, id, threshold) {
  const factor = FACTOR[id];
  if (!factor) return {factor:null, rows:[]};
  const rows = data.rows.filter(r => r.rel && finite(r.rel.c[factor]) && finite(r.rel.t[factor]) && Math.abs(r.rel.t[factor]) >= threshold)
    .sort((a,b) => b.rel.c[factor]-a.rel.c[factor]);
  const picked = rows.length > 10 ? rows.slice(0,5).concat(rows.slice(-5)) : rows;
  return {factor, rows:picked, matched:rows.length};
}
function peerHTML(symbol) {
  const p = peerRows(A.D(), symbol), a = p.anchor;
  if (!a) return '<p>Select a company to compare its measured peers.</p>';
  if (!finite(a.d1)) return '<p>Daily return unavailable for '+esc(symbol)+'. Choose another company.</p>';
  const peers = p.rows;
  const sample = peers.length > 8 ? peers.slice(0,4).concat(peers.slice(-4)) : peers;
  return '<p><b>'+esc(p.group)+'</b> · '+esc(a.pxd || 'session unavailable')+' · '+peers.length+' measured peers'+(p.missing?' · '+p.missing+' missing or different-date observations excluded':'')+'</p>'+
    '<p>'+esc(symbol)+' '+pct(a.d1)+' today. Compare participation across daily, weekly and monthly returns; a return gap is a research candidate, not evidence of a future catch-up.</p>'+
    '<table><thead><tr><th>Name</th><th>1d</th><th>5d</th><th>1m</th><th>1d gap vs '+esc(symbol)+'</th><th></th></tr></thead><tbody>'+
    sample.map(r => '<tr><td><button data-ex-ticker="'+esc(r.t)+'">'+esc(r.t)+'</button></td><td>'+pct(r.d1)+'</td><td>'+pct(r.d5)+'</td><td>'+pct(r.m1)+'</td><td>'+((r.d1-a.d1)>0?'+':'')+(r.d1-a.d1).toFixed(2)+' pp</td><td><button data-ex-compare="'+esc(r.t)+'">Overlay</button></td></tr>').join('')+
    '</tbody></table><p class="ex-source">Yahoo Finance via yfinance · stored end-of-session returns, delayed. '+
    '<a href="https://finance.yahoo.com/quote/'+encodeURIComponent(symbol)+'" target="_blank" rel="noopener noreferrer">'+esc(symbol)+' source ↗</a> · broad sector peers can have different businesses.</p>';
}
function factorHTML(id) {
  const f = factorRows(A.D(), id, A.S().minT || 2);
  if (!f.factor) return '<p>No company exposure model is stored for this series. You can compare its historical chart with any loaded ticker or macro series above.</p>';
  const d = A.D(), unit = (d.rel.units || {})[f.factor] || '';
  return '<p><b>Historical company sensitivities to '+esc(A.FLABEL[f.factor])+'</b> · '+esc(d.rel.window)+' · |t| ≥ '+esc(A.S().minT || 2)+' · '+f.matched+' matching names</p>'+
    '<p>Coefficient units: '+esc(unit)+'. Positive and negative associations over the stated window; they do not prove a market move caused a company move or predict a delayed response.</p>'+
    '<table><thead><tr><th>Company</th><th>Coefficient</th><th>t-stat</th><th>Stored 1d</th><th></th></tr></thead><tbody>'+
    f.rows.map(r => '<tr><td><button data-ex-ticker="'+esc(r.t)+'">'+esc(r.t)+'</button></td><td>'+fmt(r.rel.c[f.factor])+'</td><td>'+fmt(r.rel.t[f.factor])+'</td><td>'+pct(r.d1)+'</td><td><button data-ex-exposure="'+esc(r.t)+'" data-ex-factor="'+esc(OVERLAY[f.factor])+'">Chart + factor</button></td></tr>').join('')+
    '</tbody></table><p class="ex-source">Source: stored OLS relations · inputs: Yahoo prices / stored macro factors. Open a company for its full sensitivity, attribution and inputs.</p>';
}
function companyExposureHTML(symbol) {
  const r=A.rowOf(symbol), rel=r && r.rel, att=r && r.att, d=A.D();
  if(!rel)return '<p>No historical sensitivity model is stored for this company. Compare its observed returns with peers instead.</p>';
  const c60 = rel.c60 || {}, t60 = rel.t60 || {}, bsh = rel.bshift || {};
  const residSummary = att ? `<p><b>Multi-horizon factor attribution (${esc(att.date || d.asof_session)}):</b> 1d actual ${pct(att.actual)} (factors ${pct(att.explained)}, <b>idiosyncratic ${pct(att.stock_specific)}</b>)${finite(att.resid_5d) ? ` · 5d actual ${pct(att.actual_5d)} (factors ${pct(att.explained_5d)}, <b>5d α ${pct(att.resid_5d)}</b>)` : ''}${finite(att.resid_20d) ? ` · 20d actual ${pct(att.actual_20d)} (factors ${pct(att.explained_20d)}, <b>20d α ${pct(att.resid_20d)}</b>)` : ''}.</p>` : '';
  return '<p><b>'+esc(symbol)+' historical factor sensitivities (252d structural vs 60d tactical)</b> · '+esc(d.rel.window)+' · R² 252d '+fmt(rel.r2)+(finite(rel.r2_60)?' / 60d '+fmt(rel.r2_60):'')+' · '+esc(rel.n)+' obs</p>'+residSummary+'<p>Coefficients are historical associations. Compare 60d tactical beta vs 252d structural beta to spot regime shifts in factor sensitivity.</p><table><thead><tr><th>Factor</th><th>252d Coef</th><th>252d t</th><th>60d Coef</th><th>60d Δ Shift</th><th></th></tr></thead><tbody>'+A.FACTORS.map(f=>'<tr><td>'+esc(A.FLABEL[f])+'</td><td>'+fmt(rel.c[f])+'</td><td>'+fmt(rel.t[f])+'</td><td>'+fmt(c60[f])+'</td><td>'+(finite(bsh[f])?(bsh[f]>0?'+':'')+bsh[f].toFixed(3):'—')+'</td><td><button data-ex-compare="'+esc(OVERLAY[f])+'">Overlay factor</button></td></tr>').join('')+'</tbody></table><p class="ex-source">Stored 252d & 60d OLS · units: '+esc(Object.entries(d.rel.units || {}).map(([f,u])=>A.FLABEL[f]+': '+u).join('; '))+'</p>';
}
function render() {
  if (!box || !A) return;
  const sel = A.V.sel, isCompany = sel.kind === 't' && !!A.rowOf(sel.id);
  box.querySelector('.ex-heading').textContent = 'Dig deeper into '+sel.id+' · charts, overlays & related names';
  const selectedPoint = point && point.selection.kind === sel.kind && point.selection.id === sel.id ? point : null;
  const o = A.obsOf(sel.id), r = A.rowOf(sel.id);
  box.querySelector('.ex-point').textContent = selectedPoint ? 'Selected chart observation: '+(typeof selectedPoint.time === 'string' ? selectedPoint.time : JSON.stringify(selectedPoint.time))+' · '+fmt(selectedPoint.value)+(selectedPoint.overlay?' · '+selectedPoint.overlay+' '+fmt(selectedPoint.overlay_value):'') : 'Click a chart point for its date and value. '+(o ? o.provider+' · '+o.series+' · '+o.unit+' · period '+o.period : 'Stored session '+(r && r.pxd || A.D().asof_session));
  box.querySelector('[data-ex-mode="peers"]').disabled = !isCompany;
  const target = isCompany ? (mode==='exposures' ? companyExposureHTML(sel.id) : peerHTML(sel.id)) : factorHTML(sel.id);
  box.querySelector('.ex-results').innerHTML = target;
  box.querySelector('.ex-scale').textContent = A.V.overlay ? 'Overlay '+A.V.overlay+' uses the left scale; '+sel.id+' uses the right scale. Units differ; use return gaps below for performance comparison.' : 'Compare any loaded ticker or macro series. Separate scales preserve each series’ units.';
}
function open(kind, id, peersMode) {
  mode = peersMode ? 'peers' : 'auto'; point = null;
  A.showTab('markets'); A.select(kind, id);
  box.open = true; render(); box.scrollIntoView({block:'nearest'});
  return {selected:id, exploration:peersMode?'peers':'factor'};
}
function mount() {
  A = root.SO2;
  box = document.createElement('details'); box.id='ex-explore'; box.className='ex-explore';
  box.innerHTML='<summary class="ex-heading">Explore chart details, overlays & related names</summary><div class="ex-body"><div class="ex-point" role="status"></div>'+
    '<form class="ex-form"><label>Compare with <input list="ex-series" placeholder="Ticker or macro series" aria-label="Compare chart with ticker or macro series"></label><datalist id="ex-series"></datalist><button type="submit">Add overlay</button><button type="button" data-ex-clear>Clear</button></form>'+
    '<p class="ex-scale"></p><div class="ex-actions"><button data-ex-mode="peers">Peer participation</button><button data-ex-mode="exposures">Historical exposures</button><button data-ex-ask>Ask about this evidence</button></div><div class="ex-error" role="alert"></div><div class="ex-results"></div></div>';
  document.querySelector('#chart').after(box);
  const ids = A.D().rows.map(r=>r.t).concat(Object.values(A.D().macro).flat().map(o=>o.id));
  box.querySelector('datalist').innerHTML=[...new Set(ids)].sort().map(id=>'<option value="'+esc(id)+'">').join('');
  box.querySelector('form').addEventListener('submit', e=>{
    e.preventDefault(); const id=box.querySelector('input').value.trim();
    try { root.SmartOptionsAPI.set_chart(A.V.sel.id, id, A.V.range); box.querySelector('.ex-error').textContent=''; }
    catch (error) { box.querySelector('.ex-error').textContent=error.message; console.warn('[chart exploration] overlay rejected', error.message); }
  });
  box.addEventListener('click', e=>{
    const b=e.target.closest('button'); if(!b)return;
    if(b.hasAttribute('data-ex-clear')) { root.SmartOptionsAPI.set_chart(A.V.sel.id, 'none', A.V.range); return; }
    if(b.dataset.exMode) { mode=b.dataset.exMode;render();return; }
    if(b.dataset.exTicker) { open('t',b.dataset.exTicker,true);return; }
    if(b.dataset.exCompare) { root.SmartOptionsAPI.set_chart(A.V.sel.id,b.dataset.exCompare,A.V.range);return; }
    if(b.dataset.exExposure) { root.SmartOptionsAPI.set_chart(b.dataset.exExposure,b.dataset.exFactor,A.V.range);mode='peers';render();return; }
    if(b.hasAttribute('data-ex-ask') && root.SmartOptionsChat && root.SmartOptionsChat.draft) {
      root.SmartOptionsChat.draft('Investigate '+A.V.sel.id+(A.V.overlay?' compared with '+A.V.overlay:'')+'. Use stored tools, cite observations and dates, compare related-company participation, and distinguish historical association from a forecast. Show the relevant chart and columns. State missing evidence.');
    }
  });
  root.addEventListener('so:chart-update',render);
  root.addEventListener('so:chart-point',e=>{point=e.detail;box.open=true;render();});
  root.SmartOptionsExplore={peers:s=>open('t',s,true),factor:s=>open(s==='SPY'?'t':'s',s,false),peerRows,factorRows};
  root.SmartOptionsAPI.explore=(id,view)=>{
    if(view==='peers'){const symbol=String(id).toUpperCase();if(!A.rowOf(symbol))throw new Error('Ticker not in the dashboard');return root.SmartOptionsExplore.peers(symbol);}
    if(view==='factor'){if(!A.obsOf(id) && id!=='SPY')throw new Error('Series not in the dashboard');return root.SmartOptionsExplore.factor(id);}
    throw new Error('View must be peers or factor');
  };
  render();
}
if (typeof module==='object' && module.exports) module.exports={peerRows,factorRows};
else { let tries=0; const timer=setInterval(()=>{if(root.SO2_ready){clearInterval(timer);try{mount();}catch(e){console.error('[chart exploration] mount failed',e);}}else if(++tries>400){clearInterval(timer);console.error('[chart exploration] data unavailable');}},25); }
})(typeof window!=='undefined'?window:globalThis);
