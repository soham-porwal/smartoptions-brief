/* R4: customization (Settings drawer, layout, saved workspaces), workflow presets + checklist strip,
   window.SmartOptionsAPI for the analyst chat (chat/chat.js), chat mount. All state in localStorage only. */
'use strict';
(function () {
const $ = (s, el) => (el || document).querySelector(s);
const A = () => window.SO2;
const clone = x => JSON.parse(JSON.stringify(x));
const LS_WS = 'so2-workspaces', LS_WF = 'so2-workflow', LS_CHK = 'so2-wf-checks';
const lsGet = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

/* ---------- panels ---------- */
// group: cols = Markets page columns (reorderable), center = under the chart, side = Macro tab side column, mgrp = Macro tab groups
const PANELS = [
  {id: 'tape', h: 'Market tape', g: 'top', el: '#tape'},
  {id: 'screener', h: 'Screener table', g: 'cols', el: '#left', w: 'minmax(560px,1.5fr)'},
  {id: 'chart', h: 'Chart pane', g: 'cols', el: '#center', w: 'minmax(380px,1.1fr)'},
  {id: 'detail', h: 'Ticker detail', g: 'cols', el: '#right', w: 'minmax(280px,320px)'},
  {id: 'calendar', h: 'Event strip (under chart)', g: 'center', el: '#evstrip'},
  {id: 'signals', h: 'Signals', g: 'center', el: '#center .sigs'},
  {id: 'macro_grid', h: 'Macro: indicator grid', g: 'mtab', el: '#pg-macro .mgrid-wrap'},
  {id: 'heatmap', h: 'Macro: sector x factor heatmap', g: 'side', el: '#mhm'},
  {id: 'macro_calendar', h: 'Macro: calendar', g: 'side', el: '#mcal'},
  ...[['inflation', 'Inflation'], ['labor', 'Labor'], ['growth', 'Growth'], ['policy', 'Policy'], ['curve', 'Curve'],
    ['cross_asset', 'Cross-asset'], ['credit_funding', 'Credit / funding'], ['volatility', 'Volatility']].map(([id, h]) => ({id, h: 'Macro group: ' + h, g: 'mgrp', el: `#mgrid .mgrp[data-g="${id}"]`})),
];
const PK = {}; PANELS.forEach(p => { PK[p.id] = p; });
const GROUPS = {top: 'Top', cols: 'Markets columns', center: 'Under chart', mtab: 'Macro tab', side: 'Macro side column', mgrp: 'Macro groups'};
function order(S) {
  const o = (S.panels && Array.isArray(S.panels.order)) ? S.panels.order.filter(id => PK[id]) : [];
  for (const p of PANELS) if (!o.includes(p.id)) o.push(p.id);
  return o;
}
const hiddenSet = S => new Set((S.panels && S.panels.hidden) || []);
const desktop = () => window.matchMedia('(min-width: 821px)').matches;

function layout() {
  const a = A(); if (!a) return;
  const S = a.S(), o = order(S), hid = hiddenSet(S);
  document.documentElement.classList.toggle('light', S.theme === 'light');
  document.documentElement.classList.toggle('comfy', S.density === 'comfortable');
  $('#tbl').classList.toggle('usercols', Array.isArray(S.cols) && S.cols.length > 0);   // phone: show chosen columns instead of the default trim
  for (const p of PANELS) document.querySelectorAll(p.el).forEach(el => {
    el.classList.toggle('pan-off', hid.has(p.id));
    el.style.order = (p.g === 'cols' && !desktop()) ? '' : String(10 + o.indexOf(p.id));
  });
  const cols = o.filter(id => PK[id].g === 'cols' && !hid.has(id));
  $('#pg-markets').style.gridTemplateColumns = !desktop() ? '' : cols.length <= 1 ? '1fr' : cols.map(id => PK[id].w).join(' ');
  const mg = $('#pg-macro');
  if (mg) mg.style.gridTemplateColumns = desktop() ? (hid.has('macro_grid') ? '1fr' : (hid.has('heatmap') && hid.has('macro_calendar')) ? '1fr' : '') : '';
  const ch = a.chartObj && a.chartObj();
  if (ch) {
    const cs = getComputedStyle(document.documentElement), v = n => cs.getPropertyValue(n).trim();
    ch.applyOptions({layout: {background: {type: 'solid', color: v('--bg')}, textColor: v('--fg2')},
      grid: {vertLines: {color: v('--grid')}, horzLines: {color: v('--grid')}},
      rightPriceScale: {borderColor: v('--line')}, leftPriceScale: {borderColor: v('--line')}, timeScale: {borderColor: v('--line')}});
  }
  wfRender();
}
window.SO2_layout = layout;
window.addEventListener('resize', () => { clearTimeout(layout.t); layout.t = setTimeout(layout, 150); });
const origMacro = window.SO2_macro;
window.SO2_macro = function () { if (origMacro) origMacro.apply(this, arguments); layout(); };

/* ---------- column presets ---------- */
const COLSETS = [
  {id: 'full', h: 'Full (default)', cols: null},
  {id: 'seller', h: 'Premium seller', cols: ['t', 'd1', 'px', 'iv', 'ern', 'pct', 'opp', 'risk', 'b10', 'scen']},
  {id: 'value', h: 'Valuation', cols: ['t', 'd1', 'px', 'pe', 'pef', 'peg', 'up', 'pct', 'opp', 'qual']},
  {id: 'macro', h: 'Macro sensitivity', cols: ['t', 'd1', 'bspy', 'b10', 'bdxy', 'boil', 'bvix', 'r2', 'scen']},
  {id: 'momentum', h: 'Momentum', cols: ['t', 'd1', 'd5', 'm1', 'vr', 'spark', 'pct', 'opp']},
];

/* ---------- state snapshot (workspaces, workflows, export) ---------- */
const VKEYS = ['sel', 'sort', 'preset', 'sector', 'q', 'range', 'overlay', 'tab'];
function snapshot() {
  const a = A(), V = a.V, out = {v: 1, S: clone(a.S()), V: {}};
  for (const k of VKEYS) out.V[k] = clone(V[k] == null ? null : V[k]);
  out.wf = lsGet(LS_WF, null);
  return out;
}
function mergeS(partial, base) {
  const d = clone(base || A().DEFAULTS), p = partial || {};
  const out = Object.assign(d, p);
  out.shock = Object.assign({}, A().DEFAULTS.shock, (base || {}).shock || {}, p.shock || {});
  out.panels = Object.assign({order: null, hidden: []}, (base || {}).panels || {}, p.panels || {});
  return out;
}
function applySnapshot(snap) {
  const a = A(); if (!snap || typeof snap !== 'object') throw new Error('workspace is not an object');
  a.setS(mergeS(snap.S || {}, null));
  const V = a.V;
  for (const k of VKEYS) if (snap.V && snap.V[k] !== undefined && snap.V[k] !== null) V[k] = clone(snap.V[k]);
  if (snap.V && snap.V.sector === null) V.sector = null;
  if (V.sel && V.sel.kind === 't' && V.sel.id !== 'SPY' && !a.rowOf(V.sel.id)) V.sel = {kind: 't', id: 'SPY'};
  lsSet(LS_WF, snap.wf || null);
  refreshUI();
}
function refreshUI() {
  const a = A(), V = a.V;
  a.save();
  $('#q').value = V.q || '';
  $('#overlay').value = V.overlay || '';
  a.renderTable();
  a.select(V.sel.kind, V.sel.id);
  a.showTab(V.tab || 'markets');
  layout();
  ['controls', 'settings'].forEach(id => { const el = $('#' + id); if (el && !el.hidden && window['SO2_' + id]) window['SO2_' + id](el); });
  hdrSelects();
}

/* ---------- saved workspaces ---------- */
const wsAll = () => lsGet(LS_WS, {});
function wsSave(name) {
  name = String(name || '').trim().slice(0, 40);
  if (!name) throw new Error('workspace name required');
  const all = wsAll(); all[name] = Object.assign(snapshot(), {saved_at: new Date().toISOString()}); lsSet(LS_WS, all); hdrSelects();
  return {saved: name, count: Object.keys(all).length};
}
function wsLoad(name) {
  const all = wsAll(); if (!all[name]) throw new Error('no saved workspace "' + name + '"; saved: ' + (Object.keys(all).join(', ') || 'none'));
  applySnapshot(all[name]); return {loaded: name};
}
function wsRemove(name) { const all = wsAll(); delete all[name]; lsSet(LS_WS, all); hdrSelects(); }

/* ---------- workflows (built-in) ----------
   AGY practitioner research failed on quota (2026-10-15), so these 4 were written by lane R4 from the data this
   dashboard already has. Every threshold is an UNSOURCED DEFAULT (no practitioner or evidence citation): it is a
   starting point shown in a tooltip and is adjustable in Controls. */
const UNSOURCED = 'unsourced default (lane R4; AGY practitioner research unavailable). Adjust in Controls.';
const nPass = () => A().filtered().length;
const regimeTxt = () => { const t = (A().D().tape || []).find(x => x.id === 'regime'); return t && A().isNum(t.v) ? `${t.v} ${t.tier || ''}` : 'n/a'; };
const tapeChg = id => { const t = (A().D().tape || []).find(x => x.id === id); return t && A().isNum(t.chg) ? `${t.chg > 0 ? '+' : ''}${t.chg}${t.chgu === '%' ? '%' : ' ' + (t.chgu || '')}` : 'n/a'; };
const nextEv = () => { const e = (A().D().calendar || []).find(x => x.status !== 'released' && new Date(x.scheduled_et) > new Date()); return e ? `${e.type} ${e.scheduled_et.slice(5, 10)}` : 'none'; };
const evWithin = n => (A().D().calendar || []).filter(x => { const d = (new Date(x.scheduled_et) - new Date()) / 864e5; return x.status !== 'released' && d >= 0 && d <= n; }).length;
const macroStale = () => { let s = 0, t = 0; const m = A().D().macro; for (const g in m) for (const o of m[g]) { t++; if (o.status !== 'ok') s++; } return `${s}/${t}`; };
const worstScen = () => { const r = A().filtered().find(x => x.rel); const v = r ? A().scenarioImpact(r.rel.c, A().S().shock) : null; return r && A().isNum(v) ? `${r.t} ${v.toFixed(2)}%` : 'n/a'; };
const ivCover = () => { const rs = A().filtered(); return `${rs.filter(r => A().isNum(r.iv)).length}/${rs.length}`; };
const rateSig = () => A().D().rows.filter(r => r.rel && Math.abs(r.rel.t.us10y_bps) >= A().S().minT).length;
const nSig = () => (A().D().signals || []).length;

const WORKFLOWS = [
  {id: 'morning', h: 'Morning macro check',
    state: {S: {}, V: {tab: 'markets', preset: 'movers', sort: {k: 'd1', dir: -1, abs: true}, sector: null, q: '', overlay: 'us10y', range: '3M', sel: {kind: 's', id: 'regime'}}, cols: null},
    steps: [
      {h: 'Regime', m: regimeTxt, panel: 'tape', tab: 'markets'},
      {h: '10Y / VIX', m: () => `${tapeChg('us10y')} · ${tapeChg('vix')}`, panel: 'tape', tab: 'markets'},
      {h: 'Macro not ok', m: macroStale, panel: 'macro_grid', tab: 'macro'},
      {h: 'Next event', m: nextEv, panel: 'macro_calendar', tab: 'macro'},
      {h: 'Signals', m: nSig, panel: 'signals', tab: 'markets'},
    ], th: []},
  {id: 'csp', h: 'CSP candidate hunt',
    state: {S: {minIV: 30, minEarnAway: 14, minOpp: 50}, V: {tab: 'markets', preset: 'all', sort: {k: 'iv', dir: -1}, sector: null, q: '', overlay: 'vix', range: '6M'}, cols: 'seller'},
    steps: [
      {h: 'Regime', m: regimeTxt, panel: 'tape', tab: 'markets'},
      {h: 'Pass screen', m: nPass, panel: 'screener', tab: 'markets'},
      {h: 'Sam risk / flags', m: () => 'detail', panel: 'detail', tab: 'markets'},
      {h: 'Macro sensitivity', m: () => '|t| bars', panel: 'detail', tab: 'markets'},
      {h: 'Chart vs VIX 6M', m: () => A().V.sel.id, panel: 'chart', tab: 'markets'},
    ],
    th: [['minIV', 'ATM IV ≥ 30%'], ['minEarnAway', 'earnings ≥ 14 days away'], ['minOpp', "Sam Opp ≥ 50"]]},
  {id: 'earnings', h: 'Earnings week risk',
    state: {S: {earnN: 7}, V: {tab: 'markets', preset: 'all', sort: {k: 'ern', dir: 1}, sector: null, q: '', overlay: '', range: '3M'}, cols: ['t', 'ern', 'd1', 'iv', 'px', 'pct', 'vr', 'opp', 'risk']},
    steps: [
      {h: 'Reporting ≤7d', m: nPass, panel: 'screener', tab: 'markets'},
      {h: 'IV fetched', m: ivCover, panel: 'screener', tab: 'markets'},
      {h: 'Macro events ≤7d', m: () => evWithin(7), panel: 'calendar', tab: 'markets'},
      {h: 'Events + attribution', m: () => A().V.sel.id, panel: 'detail', tab: 'markets'},
    ],
    th: [['earnN', 'earnings within 7 days']]},
  {id: 'rateshock', h: 'Rate-shock check',
    state: {S: {shock: {us10y_bps: 25}}, V: {tab: 'markets', preset: 'all', sort: {k: 'scen', dir: 1}, sector: null, q: '', overlay: 'us10y', range: '1Y'}, cols: 'macro'},
    steps: [
      {h: '10Y today', m: () => tapeChg('us10y'), panel: 'tape', tab: 'markets'},
      {h: 'Worst at +25bp', m: worstScen, panel: 'screener', tab: 'markets'},
      {h: 'Sector x factor', m: () => '10Y col', panel: 'heatmap', tab: 'macro'},
      {h: 'Rate-sig names', m: rateSig, panel: 'screener', tab: 'markets', act: {preset: 'rate'}},
      {h: 'Chart vs 10Y', m: () => A().V.sel.id, panel: 'chart', tab: 'markets'},
    ],
    th: [['shock', '10Y +25bp shock']]},
];
const WK = {}; WORKFLOWS.forEach(w => { WK[w.id] = w; });
function wfApply(id) {
  const w = WK[id]; if (!w) throw new Error('no workflow "' + id + '"; have: ' + WORKFLOWS.map(x => x.id).join(', '));
  const a = A(), cur = a.S();
  // keep the user's display/layout prefs; reset scenario + screen to defaults, then apply the workflow's
  const keep = {cols: cur.cols, tapeIds: cur.tapeIds, panels: cur.panels, density: cur.density, theme: cur.theme, fmt: cur.fmt, defRange: cur.defRange, defOverlay: cur.defOverlay, minT: cur.minT};
  const S = mergeS(Object.assign({}, keep, w.state.S, {shock: Object.assign({}, a.DEFAULTS.shock, w.state.S.shock || {})}), null);
  if (w.state.cols !== undefined) S.cols = typeof w.state.cols === 'string' ? (COLSETS.find(c => c.id === w.state.cols) || {}).cols || null : w.state.cols;
  const V = Object.assign({}, w.state.V);
  if (!V.sel) { a.setS(S); a.V.preset = V.preset; a.V.sort = V.sort; a.V.sector = null; a.V.q = ''; const f = a.filtered(); V.sel = {kind: 't', id: f.length ? f[0].t : 'SPY'}; }
  lsSet(LS_WF, id);
  applySnapshot({S, V, wf: id});
  return {workflow: id, rows: a.filtered().length};
}
function wfStep(i) {
  const id = lsGet(LS_WF, null), w = WK[id]; if (!w) return;
  const st = w.steps[i]; if (!st) return;
  const a = A();
  if (st.act && st.act.preset) { a.V.preset = st.act.preset; const p = a.PRESETS.find(x => x.id === st.act.preset); if (p && p.sort) a.V.sort = Object.assign({}, p.sort); a.renderTable(); }
  if (st.tab && a.V.tab !== st.tab) a.showTab(st.tab);
  const p = PK[st.panel], el = p && document.querySelector(p.el);
  if (el) {
    if (el.classList.contains('pan-off')) { const S = a.S(); S.panels.hidden = S.panels.hidden.filter(x => x !== p.id); a.save(); layout(); }
    el.classList.remove('hl'); void el.offsetWidth; el.classList.add('hl');
    el.scrollIntoView({block: 'nearest', behavior: 'smooth'});
    setTimeout(() => el.classList.remove('hl'), 1800);
  }
}
function wfChecks(id) { const all = lsGet(LS_CHK, {}), k = id + '@' + (A().D().asof_session || ''); return {all, k, v: all[k] || []}; }
function wfRender() {
  const el = $('#wfstrip'); if (!el || !A()) return;
  const id = lsGet(LS_WF, null), w = WK[id];
  if (!w) { el.hidden = true; el.innerHTML = ''; return; }
  const {v} = wfChecks(id);
  let m;
  const thTip = w.th.length ? w.th.map(([, t]) => `${t}: ${UNSOURCED}`).join('\n') : 'no thresholds';
  el.innerHTML = `<span class="wfn" data-tip="${A().esc('Workflow: ' + w.h + '\nthresholds:\n' + thTip + '\nchecks reset each session')}">${A().esc(w.h)}</span>` +
    w.steps.map((s, i) => { try { m = s.m(); } catch (e) { m = 'n/a'; } return `<span class="wfs${v[i] ? ' done' : ''}"><input type="checkbox" data-ck="${i}"${v[i] ? ' checked' : ''} aria-label="step ${i + 1} done"><button data-st="${i}" data-tip="${A().esc('step ' + (i + 1) + ': highlights ' + PK[s.panel].h)}"><b>${i + 1}</b> ${A().esc(s.h)} <span class="m">${A().esc(String(m))}</span></button></span>`; }).join('') +
    (w.th.length ? `<span class="wfth" data-tip="${A().esc(thTip)}">thresholds: unsourced defaults</span>` : '') +
    `<button class="wfx" data-wfx="1" title="Exit workflow">✕</button>`;
  el.hidden = false;
}
function wfWire() {
  const el = $('#wfstrip');
  el.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b && b.dataset.wfx) { lsSet(LS_WF, null); wfRender(); hdrSelects(); return; }
    if (b && b.dataset.st != null) wfStep(+b.dataset.st);
  });
  el.addEventListener('change', e => {
    const c = e.target.closest('[data-ck]'); if (!c) return;
    const id = lsGet(LS_WF, null), {all, k, v} = wfChecks(id);
    v[+c.dataset.ck] = c.checked; all[k] = v; lsSet(LS_CHK, all); wfRender();
  });
}

/* ---------- header selects ---------- */
function hdrSelects() {
  const wf = $('#wfSel'), ws = $('#wsSel'); if (!wf || !ws) return;
  const cur = lsGet(LS_WF, null);
  wf.innerHTML = `<option value="">Task template…</option>` + WORKFLOWS.map(w => `<option value="${w.id}"${w.id === cur ? ' selected' : ''}>${A().esc(w.h)}</option>`).join('');
  const names = Object.keys(wsAll());
  ws.innerHTML = `<option value="">Saved layout…</option>` + names.map(n => `<option value="${A().esc(n)}">${A().esc(n)}</option>`).join('') + `<option value="__save">+ Save current…</option>`;
}
function hdrWire() {
  $('#wfSel').addEventListener('change', e => { const v = e.target.value; if (v) wfApply(v); else { lsSet(LS_WF, null); wfRender(); } });
  $('#wsSel').addEventListener('change', e => {
    const v = e.target.value; e.target.value = '';
    if (v === '__save') { const n = prompt('Workspace name'); if (n) wsSave(n); hdrSelects(); return; }
    if (v) wsLoad(v);
  });
  $('#btnSettings').addEventListener('click', () => A().toggleDrawer('settings'));
}

/* ---------- Settings drawer ---------- */
const RANGES = ['1M', '3M', '6M', '1Y', 'All'];
window.SO2_settings = function (el) {
  const a = A(), S = a.S(), o = order(S), hid = hiddenSet(S), esc = a.esc;
  const opt = (v, cur, l) => `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${esc(l == null ? v : l)}</option>`;
  const panelRows = Object.keys(GROUPS).map(g => {
    const ps = o.filter(id => PK[id].g === g);
    return `<div class="sgh">${GROUPS[g]}</div>` + ps.map((id, i) => `<div class="srow"><label><input type="checkbox" data-pv="${id}"${hid.has(id) ? '' : ' checked'}> ${esc(PK[id].h)}</label>
      <span>${ps.length > 1 ? `<button data-pm="${id}" data-d="-1"${i ? '' : ' disabled'} title="move up">▲</button><button data-pm="${id}" data-d="1"${i < ps.length - 1 ? '' : ' disabled'} title="move down">▼</button>` : ''}</span></div>`).join('');
  }).join('');
  const act = a.activeCols().map(c => c.k), rest = a.COLS.filter(c => !act.includes(c.k)).map(c => c.k);
  const colRow = (k, on, i, n) => { const c = a.COLS.find(x => x.k === k); return `<div class="srow"><label><input type="checkbox" data-cv="${k}"${on ? ' checked' : ''}${k === 't' ? ' disabled' : ''}> ${esc(c.h)} <span class="dim">${esc(c.tip ? c.tip.slice(0, 48) : '')}</span></label>
    <span>${on && k !== 't' ? `<button data-cm="${k}" data-d="-1"${i > 1 ? '' : ' disabled'}>▲</button><button data-cm="${k}" data-d="1"${i < n - 1 ? '' : ' disabled'}>▼</button>` : ''}</span></div>`; };
  const tapeAll = (a.D().tape || []).map(x => x.id), tapeOn = Array.isArray(S.tapeIds) ? S.tapeIds.filter(id => tapeAll.includes(id)) : tapeAll.slice();
  const tapeRows = tapeOn.concat(tapeAll.filter(id => !tapeOn.includes(id))).map(id => {
    const t = a.D().tape.find(x => x.id === id), on = tapeOn.includes(id), i = tapeOn.indexOf(id);
    return `<div class="srow"><label><input type="checkbox" data-tv="${esc(id)}"${on ? ' checked' : ''}> ${esc(t.label)}</label><span>${on ? `<button data-tm="${esc(id)}" data-d="-1"${i ? '' : ' disabled'}>▲</button><button data-tm="${esc(id)}" data-d="1"${i < tapeOn.length - 1 ? '' : ' disabled'}>▼</button>` : ''}</span></div>`;
  }).join('');
  const ws = wsAll();
  el.innerHTML = `<button class="x" data-close>Close</button>
    <h3>Workspace</h3>
    <div class="srow"><input id="wsName" type="text" placeholder="name" maxlength="40" style="flex:1"><button data-wssave>Save current</button></div>
    ${Object.keys(ws).map(n => `<div class="srow"><span>${esc(n)} <span class="dim">${esc(ws[n].saved_at ? new Date(ws[n].saved_at).toLocaleString([], {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'}) : '')}</span></span><span><button data-wsload="${esc(n)}">Load</button><button data-wsdel="${esc(n)}" title="remove this saved workspace from this browser">✕</button></span></div>`).join('') || '<p>No saved workspaces in this browser yet.</p>'}
    <div class="srow"><button data-export>Export settings JSON</button><button data-import>Import JSON</button><button data-resetall>Reset everything</button></div>
    <textarea id="ioBox" rows="4" placeholder="Paste exported JSON here, then Import" spellcheck="false"></textarea>
    <h3>Display</h3>
    <div class="srow"><label>Theme</label><select data-set="theme">${opt('dark', S.theme, 'Dark')}${opt('light', S.theme, 'Light')}</select></div>
    <div class="srow"><label>Density</label><select data-set="density">${opt('compact', S.density, 'Compact')}${opt('comfortable', S.density, 'Comfortable')}</select></div>
    <div class="srow"><label>Rate changes (tape)</label><select data-set="fmt">${opt('bp', S.fmt, 'basis points (bp)')}${opt('pct', S.fmt, 'percentage points (pp)')}</select></div>
    <div class="srow"><label>Default chart range</label><select data-set="defRange">${RANGES.map(r => opt(r, S.defRange)).join('')}</select></div>
    <div class="srow"><label>Default overlay</label><select data-set="defOverlay">${a.OVERLAYS.map(([v, l]) => opt(v, S.defOverlay, l)).join('')}</select></div>
    <h3>Panels <span class="dim">show / hide / order</span></h3>${panelRows}
    <h3>Screener columns</h3>
    <div class="chips">${COLSETS.map(c => `<button data-colset="${c.id}">${esc(c.h)}</button>`).join('')}</div>
    ${act.map((k, i) => colRow(k, true, i, act.length)).join('')}${rest.map(k => colRow(k, false, 0, 0)).join('')}
    <p>Scen column appears only while a scenario shock is set (Controls).</p>
    <h3>Tape symbols</h3>${tapeRows}`;
};
function moveIn(arr, id, d) { const i = arr.indexOf(id), j = i + d; if (i < 0 || j < 0 || j >= arr.length) return arr; [arr[i], arr[j]] = [arr[j], arr[i]]; return arr; }
function settingsWire() {
  const el = $('#settings');
  const done = (rerenderData) => { A().save(); if (rerenderData) { A().renderTable(); A().renderTape(); } layout(); window.SO2_settings(el); };
  el.addEventListener('change', e => {
    const t = e.target, a = A(), S = a.S();
    if (t.dataset.set) {
      S[t.dataset.set] = t.value;
      if (t.dataset.set === 'defRange') { a.V.range = t.value; a.setRange(); }
      if (t.dataset.set === 'defOverlay') { a.V.overlay = t.value; $('#overlay').value = t.value; a.drawChart(); }
      done(t.dataset.set === 'fmt');
    } else if (t.dataset.pv) {
      const h = new Set(S.panels.hidden || []); t.checked ? h.delete(t.dataset.pv) : h.add(t.dataset.pv); S.panels.hidden = [...h]; done(false);
    } else if (t.dataset.cv) {
      const cur = a.activeCols().map(c => c.k);
      S.cols = t.checked ? cur.concat([t.dataset.cv]) : cur.filter(k => k !== t.dataset.cv); done(true);
    } else if (t.dataset.tv) {
      const all = a.D().tape.map(x => x.id), cur = Array.isArray(S.tapeIds) ? S.tapeIds.filter(x => all.includes(x)) : all.slice();
      S.tapeIds = t.checked ? cur.concat([t.dataset.tv]) : cur.filter(k => k !== t.dataset.tv); done(true);
    }
  });
  el.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const a = A(), S = a.S();
    if (b.dataset.close != null) { el.hidden = true; return; }
    if (b.dataset.pm) { const o = order(S); const g = PK[b.dataset.pm].g, ids = o.filter(id => PK[id].g === g); moveIn(ids, b.dataset.pm, +b.dataset.d); let i = 0; S.panels.order = o.map(id => PK[id].g === g ? ids[i++] : id); done(false); return; }
    if (b.dataset.cm) { S.cols = moveIn(a.activeCols().map(c => c.k), b.dataset.cm, +b.dataset.d); done(true); return; }
    if (b.dataset.tm) { const all = a.D().tape.map(x => x.id); S.tapeIds = moveIn(Array.isArray(S.tapeIds) ? S.tapeIds.filter(x => all.includes(x)) : all, b.dataset.tm, +b.dataset.d); done(true); return; }
    if (b.dataset.colset) { const c = COLSETS.find(x => x.id === b.dataset.colset); S.cols = c.cols ? c.cols.slice() : null; done(true); return; }
    if (b.dataset.wssave != null) { const n = $('#wsName').value; if (!n.trim()) { $('#wsName').focus(); return; } wsSave(n); window.SO2_settings(el); return; }
    if (b.dataset.wsload) { wsLoad(b.dataset.wsload); return; }
    if (b.dataset.wsdel) { wsRemove(b.dataset.wsdel); window.SO2_settings(el); return; }
    if (b.dataset.export != null) {
      const txt = JSON.stringify({smartoptions_settings: 1, exported_at: new Date().toISOString(), current: snapshot(), workspaces: wsAll()}, null, 1);
      $('#ioBox').value = txt;
      try { const u = URL.createObjectURL(new Blob([txt], {type: 'application/json'})); const l = document.createElement('a'); l.href = u; l.download = 'smartoptions-settings.json'; l.click(); setTimeout(() => URL.revokeObjectURL(u), 1000); } catch (err) {}
      return;
    }
    if (b.dataset.import != null) {
      let j; try { j = JSON.parse($('#ioBox').value); } catch (err) { $('#ioBox').value = 'Not valid JSON: ' + err.message; return; }
      if (!j || j.smartoptions_settings !== 1) { $('#ioBox').value = 'Not a SmartOptions settings export (missing smartoptions_settings: 1)'; return; }
      if (j.workspaces && typeof j.workspaces === 'object') lsSet(LS_WS, Object.assign(wsAll(), j.workspaces));
      if (j.current) applySnapshot(j.current);
      window.SO2_settings(el); return;
    }
    if (b.dataset.resetall != null) { lsSet(LS_WF, null); applySnapshot({S: {}, V: {sel: {kind: 't', id: 'SPY'}, sort: {k: 'd1', dir: -1}, preset: 'all', q: '', range: '3M', overlay: '', sector: null, tab: 'markets'}}); window.SO2_settings(el); }
  });
}

/* ---------- window.SmartOptionsAPI (contract: chat/chat.js UI_TOOLS + loadData) ---------- */
let quotesP = null;
const SHOCK_IN = {us10y_bps: 'us10y_bps', wti_pct: 'wti', dxy_pct: 'dxy', vix_pts: 'vix', spy_pct: 'spy', wti: 'wti', dxy: 'dxy', vix: 'vix', spy: 'spy'};
const FILTER_IN = {max_pe_fwd: 'maxPE', max_peg: 'maxPEG', min_iv: 'minIV', earnings_within_days: 'earnN', min_days_to_earnings: 'minEarnAway', min_sam_opp: 'minOpp', min_abs_t: 'minT'};
const OV_IN = {us10y_bps: 'us10y', us10y: 'us10y', '10y': 'us10y', dxy: 'dxy', wti: 'wti', oil: 'wti', vix: 'vix', spy: 'SPY', hy_oas: 'hy_oas', spread_10y_2y: 'spread_10y_2y', '2s10s': 'spread_10y_2y', none: ''};
function after() { const a = A(); a.save(); a.renderTable(); a.renderDetail(); layout(); const c = $('#controls'); if (c && !c.hidden) window.SO2_controls(c); const s = $('#settings'); if (s && !s.hidden) window.SO2_settings(s); }
function badIds(ids, known, what) { const bad = ids.filter(x => !known.includes(x)); if (bad.length) throw new Error(`unknown ${what}: ${bad.join(', ')}; valid: ${known.join(', ')}`); }
const API = {
  getData: () => {
    const core = A().D();
    if (!quotesP) quotesP = fetch('data/quotes.json', {cache: 'no-store'}).then(r => r.ok ? r.json() : null).catch(() => null);
    return quotesP.then(q => ({core, quotes: q}));
  },
  select: sym => {
    const a = A(), s = String(sym || '').trim(), u = s.toUpperCase();
    if (a.rowOf(u) || u === 'SPY') { a.showTab('markets'); a.select('t', u); return {selected: u}; }
    if (a.obsOf(s) || (a.D().tape || []).some(x => x.id === s)) { a.showTab('markets'); a.select('s', s); return {selected_series: s}; }
    throw new Error(`"${s}" is not a dashboard ticker or series id`);
  },
  set_filters: f => {
    const a = A(), S = a.S(), applied = {}, unsupported = [];
    f = f || {};
    if (f.reset || f.clear) { for (const k of Object.values(FILTER_IN)) S[k] = k === 'minT' ? 2 : null; a.V.sector = null; a.V.preset = 'all'; applied.reset = true; }
    for (const k in f) {
      if (k === 'reset' || k === 'clear') continue;
      const v = f[k];
      if (FILTER_IN[k]) {
        if (v != null && !a.isNum(+v)) throw new Error(`${k} must be a number`);
        S[FILTER_IN[k]] = v == null ? (k === 'min_abs_t' ? 2 : null) : +v; applied[k] = S[FILTER_IN[k]];
      } else if (k === 'sector') {
        if (!v) { a.V.sector = null; applied.sector = null; continue; }
        const secs = [...new Set(a.D().rows.map(r => r.sec).filter(Boolean))], q = String(v).toLowerCase();
        const m = secs.find(x => x.toLowerCase() === q) || secs.find(x => x.toLowerCase().includes(q));
        if (!m) throw new Error(`no sector matching "${v}"; sectors: ${secs.join(', ')}`);
        a.V.sector = m; applied.sector = m;
      } else if (k === 'sets' && Array.isArray(v) && v.length === 1 && v[0] === 'A') { a.V.preset = 'movers'; applied.sets = ['A']; }
      else unsupported.push(k);
    }
    after();
    return {applied, unsupported, rows_now: a.filtered().length, note: unsupported.length ? 'unsupported keys were NOT applied in the table; use the screen tool for them' : undefined};
  },
  set_scenario: sh => {
    const a = A(), S = a.S(), out = {};
    for (const f of a.FACTORS) S.shock[f] = 0;
    for (const k in (sh || {})) {
      const f = SHOCK_IN[k]; if (!f) throw new Error(`unknown shock "${k}"; valid: us10y_bps, wti_pct, dxy_pct, vix_pts, spy_pct`);
      const v = +sh[k]; if (!a.isNum(v)) throw new Error(`${k} must be a number`);
      S.shock[f] = v; out[f] = v;
    }
    if (a.FACTORS.some(f => S.shock[f])) a.V.sort = {k: 'scen', dir: 1};
    after();
    return {shocks: out, sorted_by: a.V.sort.k, note: 'impact = sum(coef x shock); historical association, not a forecast'};
  },
  show_panels: ids => { ids = [].concat(ids || []); badIds(ids, PANELS.map(p => p.id), 'panel'); const S = A().S(); S.panels.hidden = (S.panels.hidden || []).filter(x => !ids.includes(x)); after(); return {visible: ids}; },
  hide_panels: ids => { ids = [].concat(ids || []); badIds(ids, PANELS.map(p => p.id), 'panel'); const S = A().S(); S.panels.hidden = [...new Set((S.panels.hidden || []).concat(ids))]; after(); return {hidden: ids}; },
  set_columns: ids => {
    ids = [].concat(ids || []); const a = A(); badIds(ids, a.COLS.map(c => c.k), 'column');
    if (!ids.length) throw new Error('columns list is empty');
    a.S().cols = ids.includes('t') ? ids : ['t'].concat(ids); after(); return {columns: a.activeCols().map(c => c.k)};
  },
  apply_preset: id => {
    const a = A(), s = String(id || '');
    if (WK[s]) return wfApply(s);
    if (wsAll()[s]) return wsLoad(s);
    const p = a.PRESETS.find(x => x.id === s);
    if (p) { a.V.preset = s; if (p.sort) a.V.sort = Object.assign({}, p.sort); after(); return {table_preset: s, rows: a.filtered().length}; }
    const c = COLSETS.find(x => x.id === s || 'cols:' + x.id === s);
    if (c) { a.S().cols = c.cols ? c.cols.slice() : null; after(); return {column_preset: c.id}; }
    throw new Error(`no preset "${s}"; workflows: ${WORKFLOWS.map(w => w.id).join(', ')}; table: ${a.PRESETS.map(x => x.id).join(', ')}; columns: ${COLSETS.map(x => 'cols:' + x.id).join(', ')}; workspaces: ${Object.keys(wsAll()).join(', ') || 'none'}`);
  },
  set_chart: (sym, overlay, range) => {
    const a = A(), r = API.select(sym);
    if (overlay != null) {
      const raw = String(overlay), symbol = raw.toUpperCase();
      const o = OV_IN[raw.toLowerCase()] !== undefined ? OV_IN[raw.toLowerCase()] : (a.rowOf(symbol) ? symbol : (a.obsOf(raw) || a.OVERLAYS.some(x => x[0] === raw) ? raw : null));
      if (o == null) throw new Error(`unknown overlay "${overlay}"; valid: ${a.OVERLAYS.map(x => x[0] || 'none').join(', ')}`);
      if (![...$('#overlay').options].some(x => x.value === o)) $('#overlay').add(new Option(o, o));
      a.V.overlay = o; $('#overlay').value = o;
    }
    if (range) {
      const rg = RANGES.find(x => x.toLowerCase() === String(range).toLowerCase()) || ({'1y': '1Y', '12m': '1Y', max: 'All'}[String(range).toLowerCase()]);
      if (!rg) throw new Error(`unknown range "${range}"; valid: ${RANGES.join(', ')}`);
      a.V.range = rg;
    }
    a.drawChart(); a.writeHash();
    return Object.assign({}, r, {overlay: a.V.overlay || 'none', range: a.V.range});
  },
  save_workspace: n => wsSave(n),
  load_workspace: n => wsLoad(n),
  list_workspaces: () => Object.keys(wsAll()),
  describe: () => {
    const a = A(), hid = hiddenSet(a.S()), act = a.activeCols().map(c => c.k);
    return {
      navigation: {analyst: 'select(ticker) opens the Analyst chart and detail view; its internal tab id is markets', macro: 'select(series_id) opens a macro series chart and source detail in Analyst', ticker_tabs: ['overview', 'technicals', 'strategies']},
      watchlist: window.SmartOptionsWatchlist ? window.SmartOptionsWatchlist.get() : [],
      panels: PANELS.map(p => ({id: p.id, label: p.h, visible: !hid.has(p.id)})),
      columns: a.COLS.map(c => ({id: c.k, label: c.h, visible: act.includes(c.k), tip: c.tip || ''})),
      presets: {workflows: WORKFLOWS.map(w => ({id: w.id, label: w.h})), table: a.PRESETS.map(x => x.id), columns: COLSETS.map(x => 'cols:' + x.id), workspaces: Object.keys(wsAll())},
      filter_keys: Object.keys(FILTER_IN).concat(['sector', 'sets (["A"] only)', 'reset']),
      overlays: a.OVERLAYS.map(x => x[0] || 'none'), overlay_note: 'Any loaded ticker or macro series id is also supported; the overlay uses a separate left scale, not normalized performance', ranges: RANGES,
    };
  },
};
window.SmartOptionsAPI = API;

/* ---------- init (called by app.js boot once data + SO2 exist) ---------- */
window.SO2_init = function () {
  hdrSelects(); hdrWire(); wfWire(); settingsWire(); layout();
  if (window.SmartOptionsChat && typeof window.SmartOptionsChat.mount === 'function') {
    window.SmartOptionsChat.mount({dataBase: 'data/'});
    const t = document.getElementById('soc-toggle'), h = $('#hdr .hbtns');
    if (t && h) { t.classList.add('in-hdr'); h.appendChild(t); }
  }
};
})();
