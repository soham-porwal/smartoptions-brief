/* SmartOptions V2 analyst app. Vanilla JS; data = same-origin JSON from data/. */
'use strict';
(function () {
const $ = (s, el) => (el || document).querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const isNum = v => typeof v === 'number' && isFinite(v);
const FACTORS = ['spy', 'us10y_bps', 'dxy', 'wti', 'vix'];
const FLABEL = {spy: 'SPY', us10y_bps: '10Y', dxy: 'DXY', wti: 'WTI', vix: 'VIX'};
const SHOCK_U = {spy: '%', us10y_bps: 'bp', dxy: '%', wti: '%', vix: 'pt'};
const DEFAULTS = {
  shock: {us10y_bps: 0, wti: 0, dxy: 0, vix: 0, spy: 0},
  minT: 2, maxPE: null, maxPEG: null, minIV: null, earnN: null, minEarnAway: null, minOpp: null, hideMissing: false,
  // R4 customization (Settings drawer, custom.js): null = built-in default
  cols: null, tapeIds: null, panels: {order: null, hidden: []}, density: 'compact', theme: 'dark', fmt: 'bp', defRange: '3M', defOverlay: '',
};
let D = null;              // core.json
let S = load();            // persisted settings
let V = {sel: {kind: 't', id: 'SPY'}, sort: {k: 'd1', dir: -1}, preset: 'all', q: '', range: '3M', overlay: '', cmpMode: 'dual', sector: null, tab: 'markets'};
const pxCache = {};
let chart = null, mainSeries = null, ovSeries = null;
let chartDraw = 0;

function load() {
  try { const s = JSON.parse(localStorage.getItem('so2-settings') || 'null'); if (s) return Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), s, {shock: Object.assign({}, DEFAULTS.shock, s.shock || {}), panels: Object.assign({order: null, hidden: []}, s.panels || {})}); } catch (e) {}
  return JSON.parse(JSON.stringify(DEFAULTS));
}
function save() { try { localStorage.setItem('so2-settings', JSON.stringify(S)); } catch (e) {} writeHash(); }

/* ---------- formatting ---------- */
function na(reason) { return `<span class="na" data-tip="${esc(reason || 'not available')}">—</span>`; }
// plain-language date label for Historical screener scores (shared with the Brief shell, brief.js screenerLabel)
function samLabel(mode) { return window.SmartOptionsBrief ? window.SmartOptionsBrief.screenerLabel(mode) : "Historical screener scores from Jul 25, 2026"; }
function num(v, dp, reason) { return isNum(v) ? v.toLocaleString('en-US', {minimumFractionDigits: dp, maximumFractionDigits: dp}) : na(reason); }
function pct(v, dp, reason, unit) {
  if (!isNum(v)) return na(reason);
  const cls = v > 0 ? 'up' : v < 0 ? 'dn' : '';
  return `<span class="${cls}">${v > 0 ? '+' : ''}${v.toFixed(dp == null ? 2 : dp)}${unit == null ? '%' : unit}</span>`;
}
function stReason(row, field, what) {
  const s = row.st && row.st[field];
  return `${what}: ${s ? 'status ' + s : 'not in source data'}`;
}
function spark(vals, w, h, col) {
  const v = (vals || []).filter(isNum);
  if (v.length < 2) return `<svg width="${w}" height="${h}"></svg>`;
  const mn = Math.min(...v), mx = Math.max(...v), rg = mx - mn || 1;
  const pts = v.map((y, i) => `${(i / (v.length - 1) * (w - 1)).toFixed(1)},${(h - 1 - (y - mn) / rg * (h - 2)).toFixed(1)}`).join(' ');
  const c = col || (v[v.length - 1] >= v[0] ? 'var(--up)' : 'var(--dn)');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline fill="none" stroke="${c}" stroke-width="1.2" points="${pts}"/></svg>`;
}
function etTime(iso) {
  try { return new Date(iso).toLocaleTimeString('en-US', {timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false}); } catch (e) { return ''; }
}

/* ---------- scenario (mirrored in smartoptions/export.py scenario_impact) ---------- */
function scenarioImpact(coef, shock) {
  let tot = 0;
  for (const f in shock) {
    const s = shock[f];
    if (!s) continue;
    const c = coef ? coef[f] : null;
    if (!isNum(c)) return null;
    tot += c * s;
  }
  return tot;
}
const scenOn = () => FACTORS.some(f => S.shock[f]);
function selfCheck() {
  const sc = D.scenario_check; if (!sc) return;
  for (const t in sc.expected) {
    const row = D.rows.find(r => r.t === t);
    const got = row && row.rel ? scenarioImpact(row.rel.c, sc.shock) : null;
    const exp = sc.expected[t];
    if (exp == null && got == null) continue;
    if (got == null || Math.abs(got - exp) > 1e-3) console.error('scenario self-check mismatch', t, got, exp);
  }
}

/* ---------- data ---------- */
async function fetchJSON(p) { const r = await fetch(p, {cache: 'no-store'}); if (!r.ok) throw new Error(p + ' ' + r.status); return r.json(); }
async function px(t) {
  if (pxCache[t]) return pxCache[t];
  try { pxCache[t] = await fetchJSON(`data/px/${encodeURIComponent(t)}.json`); } catch (e) { pxCache[t] = {t, bars: [], err: String(e)}; }
  return pxCache[t];
}
const rowOf = t => D.rows.find(r => r.t === t);
function obsOf(id) { for (const g in D.macro) { const o = D.macro[g].find(x => x.id === id); if (o) return o; } return null; }
function seriesData(id) {
  if (id === 'SPY') return D.spy_close;
  if (id === 'vrp') return (D.rel.vol_breadth.vrp || {}).history || [];
  if (id === 'regime') return D.rel.regime_hist || [];
  const o = obsOf(id); return o ? o.h : [];
}
function seriesLabel(id) { const s = D.series[id]; return s ? `${s.label}${s.unit ? ' (' + s.unit + ')' : ''}` : id; }

/* ---------- header + tape ---------- */
function renderHeader() {
  const g = D.gen || {};
  const ex = D.exported_at;
  const st = {};
  for (const k in D.macro) for (const o of D.macro[k]) st[o.status] = (st[o.status] || 0) + 1;
  const fr = `macro ${st.ok || 0} ok${st.stale ? ` · <span style="color:var(--warn)">${st.stale} stale</span>` : ''}${st.missing ? ` · ${st.missing} missing` : ''}${st.error ? ` · ${st.error} error` : ''}`;
  $('#hstat').innerHTML = `Session ${esc(D.asof_session)} · updated ${etTime(ex)} ET · delayed · ${fr} · <span class="dim">Historical scores are optional in Settings</span>`;
  $('#hstat').dataset.tip = `exported ${ex}\nmacro ${g.macro}\nequities ${g.equities}\nrelations ${g.relations}\ncrosscheck ${g.crosscheck}`;
}
function renderTape() {
  const ids = Array.isArray(S.tapeIds) ? S.tapeIds : null;
  const items = ids ? ids.map(id => D.tape.find(x => x.id === id)).filter(Boolean) : D.tape;
  $('#tape').innerHTML = items.map(x => {
    const stale = x.status && x.status !== 'ok';
    let val;
    if (x.id === 'regime') val = isNum(x.v) ? `${x.v} <span class="tier">${esc(({FAVORABLE:'Supportive',BULLISH:'Supportive',NEUTRAL:'Mixed',ADVERSE:'Adverse',BEARISH:'Adverse'})[x.tier] || x.tier || '')}</span>` : na('regime not computed');
    else val = isNum(x.v) ? num(x.v, x.unit === '$' || Math.abs(x.v) < 1000 ? 2 : 0) + (x.unit === '%' ? '%' : '') : na(`${x.label}: ${x.status || 'missing'}`);
    const pp = x.chgu === 'bp' && S.fmt === 'pct';   // Settings: rate changes in percentage points instead of bp (value / 100)
    const chg = x.id === 'regime' ? `<span class="dim">30/50/70/85</span>` : pp ? pct(isNum(x.chg) ? x.chg / 100 : null, 2, 'no prior value', ' pp') : pct(x.chg, x.chgu === '%' ? 2 : 1, 'no prior value', x.chgu === '%' ? '%' : ' ' + (x.chgu || ''));
    const extra = x.extra ? ` <span class="dim">${esc(x.extra.label)} ${num(x.extra.v, 3)}</span>` : '';
    const tip = `${x.label}: ${x.src || ''}\nas of ${x.date || 'n/a'} · status ${x.status || 'n/a'}`;
    const sel = V.sel.kind === 's' && V.sel.id === tapeSeries(x.id) ? ' sel' : '';
    return `<div class="ti${stale ? ' stale' : ''}${sel}" data-s="${esc(x.id)}" data-tip="${esc(tip)}">
      <div class="l"><span>${esc(x.label)}</span>${stale ? '<span class="stale-tag">stale</span>' : ''}</div>
      <div class="v">${val}</div><small class="tape-observed">Observed ${esc(x.date || 'date unavailable')} · ${esc(x.src || 'provider unavailable')}</small><div class="c">${chg}${extra}</div>${spark(x.spark, 94, 18)}</div>`;
  }).join('');
}
const tapeSeries = id => id;

/* ---------- screener table ---------- */
const COLS = [
  {k: 't', h: 'Ticker', l: 1},
  {k: 'd1', h: '1d', tip: '1-session % change, adjusted close'},
  {k: 'px', h: 'Price'},
  {k: 'spark', h: '3M', ns: 1},
  {k: 'pef', h: 'P/E f', ph: 1, tip: 'Forward P/E (Yahoo)'},
  {k: 'peg', h: 'PEG', ph: 1},
  {k: 'pct', h: '52w', ph: 1, tip: 'Position in 52-week range (unadjusted high/low)'},
  {k: 'ern', h: 'Earn', ph: 1, tip: 'Days until next earnings (Yahoo; may be an estimate)'},
  {k: 'iv', h: 'ATM IV', ph: 1, tip: 'At-the-money implied vol, nearest weekly expiry (Yahoo chain, delayed)'},
  {k: 'opp', h: 'Historical score', ph: 1, opt: 1, tip: "Opportunity: " + samLabel('tip')},
  {k: 'b10', h: 'β10Y', ph: 1, tip: '% stock move per +10bp 10Y yield (OLS, 252 sessions). Bright = |t| at or above your threshold'},
  {k: 'boil', h: 'βOil', ph: 1, tip: '% stock move per +1% WTI (OLS, 252 sessions)'},
  {k: 'scen', h: 'Scen', tip: 'Scenario impact %: sum(coef x your shock). Historical association, not a forecast'},
  // optional columns (off by default; Settings > Screener columns)
  {k: 'd5', h: '5d', opt: 1, tip: '5-session % change (Yahoo via yfinance)'},
  {k: 'm1', h: '1M', opt: 1, tip: '1-month % change (Yahoo via yfinance)'},
  {k: 'pe', h: 'P/E t', ph: 1, opt: 1, tip: 'Trailing P/E (Yahoo)'},
  {k: 'vr', h: 'Vol/20d', ph: 1, opt: 1, tip: 'Session volume / 20-day average volume'},
  {k: 'beta', h: 'Beta', ph: 1, opt: 1, tip: 'Provider beta (Yahoo), not our regression'},
  {k: 'up', h: 'Upside', ph: 1, opt: 1, tip: 'Yahoo analyst mean target vs price, %. Not consensus EPS'},
  {k: 'bdxy', h: 'βDXY', ph: 1, opt: 1, tip: '% stock move per +1% DXY (OLS, 252 sessions)'},
  {k: 'bvix', h: 'βVIX', ph: 1, opt: 1, tip: '% stock move per +1pt VIX (OLS, 252 sessions)'},
  {k: 'bspy', h: 'βSPY', ph: 1, opt: 1, tip: '% stock move per +1% SPY (OLS, 252 sessions)'},
  {k: 'r2', h: 'R²', ph: 1, opt: 1, tip: 'R² of the 5-factor OLS (252 sessions)'},
  {k: 'risk', h: 'Risk', ph: 1, opt: 1, tip: "Risk label: " + samLabel('tip')},
  {k: 'qual', h: 'Qual', ph: 1, opt: 1, tip: "Quality label: " + samLabel('tip')},
  {k: 'res20d', h: '20d α', ph: 1, tip: '20-session idiosyncratic return (%) = actual 20d return minus 5-factor OLS macro-explained move'},
  {k: 'pefrel', h: 'vs Sec', ph: 1, tip: 'Forward P/E relative to GICS sector median (1.00x = sector median)'},
  {k: 'epsg', h: 'P/E ratio gap %', ph: 1, opt: 1, tip: 'P/E ratio comparison = 100 * (trailing P/E / forward P/E - 1); not expected growth. Extreme values may reflect small bases or one-off charges.'},
  {k: 'res5d', h: '5d α', ph: 1, opt: 1, tip: '5-session idiosyncratic return (%) after stripping 5-factor OLS macro move'},
  {k: 'rv20', h: 'RV20', ph: 1, opt: 1, tip: '20-session annualized realized volatility (%) from Adj Close log returns'},
  {k: 'ivrv', h: 'IV/RV', ph: 1, opt: 1, tip: 'ATM IV (or sector median IV proxy) / 20d realized volatility'},
  {k: 'drift', h: 'Δ07-25', ph: 1, opt: 1, tip: 'Price drift % since the 2026-07-25 SmartOptions snapshot'},
];
const COLK = {};
COLS.forEach(c => { COLK[c.k] = c; });
const DEFAULT_COLS = COLS.filter(c => !c.opt).map(c => c.k);
function activeCols() {
  const ks = Array.isArray(S.cols) && S.cols.length ? S.cols.filter(k => COLK[k]) : DEFAULT_COLS.slice();
  if (!ks.includes('t')) ks.unshift('t');
  return ks.map(k => COLK[k]);
}
function val(r, k) {
  switch (k) {
    case 'opp': return r.sam ? r.sam.opp : null;
    case 'b10': return r.rel && isNum(r.rel.c.us10y_bps) ? r.rel.c.us10y_bps * 10 : null;
    case 'boil': return r.rel ? r.rel.c.wti : null;
    case 'scen': return r.rel && scenOn() ? scenarioImpact(r.rel.c, S.shock) : null;
    case 'bdxy': return r.rel ? r.rel.c.dxy : null;
    case 'bvix': return r.rel ? r.rel.c.vix : null;
    case 'bspy': return r.rel ? r.rel.c.spy : null;
    case 'r2': return r.rel ? r.rel.r2 : null;
    case 'risk': return r.sam ? r.sam.risk : null;
    case 'qual': return r.sam ? r.sam.q : null;
    case 'res20d': return r.res20d;
    case 'res5d': return r.res5d;
    case 'pefrel': return r.pef_sec_rel;
    case 'epsg': return r.eps_g_imp;
    case 'rv20': return r.rv20;
    case 'ivrv': return isNum(r.ivrv) ? r.ivrv : r.ivrv_eff;
    case 'drift': return r.sam_drift ? r.sam_drift.px_pct : null;
    case 't': return r.t;
    default:
      if (k.startsWith('c:')) return r.rel ? r.rel.c[k.slice(2)] : null;
      return r[k];
  }
}
const PRESETS = [
  {id: 'all', h: 'All'},
  {id: 'movers', h: 'Movers', f: r => r.sets.includes('A'), sort: {k: 'd1', dir: -1, abs: true}},
  {id: 'alpha20', h: '20d Alpha (+3%)', f: r => isNum(r.res20d) && r.res20d >= 3.0, sort: {k: 'res20d', dir: -1}},
  {id: 'garpmacro', h: 'Macro Tailwind + Cheap', f: r => isNum(r.pef_sec_rel) && r.pef_sec_rel <= 0.95 && ((scenOn() && r.rel && (scenarioImpact(r.rel.c, S.shock) || 0) >= 0) || (!scenOn() && isNum(r.res20d) && r.res20d >= 0)), sort: {k: 'pefrel', dir: 1}},
  {id: 'volcheap', h: 'Cheap Vol (Catalyst)', f: r => isNum(r.ivrv_eff) && r.ivrv_eff <= 1.05 && ((isNum(r.ern) && r.ern >= 0 && r.ern <= 21) || (isNum(r.res20d) && Math.abs(r.res20d) >= 3)), sort: {k: 'ivrv', dir: 1}},
  {id: 'volrich', h: 'Rich Premium (Sell Vol)', f: r => isNum(r.ivrv_eff) && r.ivrv_eff >= 1.25 && (!isNum(r.ern) || r.ern > 14), sort: {k: 'ivrv', dir: -1}},
  {id: 'sam', h: 'Historical scores', f: r => r.sam && isNum(r.sam.opp), sort: {k: 'opp', dir: -1}},
  {id: 'earn7', h: 'Earnings 7d', f: r => isNum(r.ern) && r.ern >= 0 && r.ern <= 7, sort: {k: 'ern', dir: 1}},
  {id: 'rate', h: 'Rate-sensitive', f: r => r.rel && Math.abs(r.rel.t.us10y_bps) >= S.minT, sort: {k: 'b10', dir: 1}},
  {id: 'iv', h: 'High IV', f: r => isNum(r.iv), sort: {k: 'iv', dir: -1}},
];
function screenPass(r) {
  if (isNum(S.maxPE) && !(isNum(r.pef) && r.pef <= S.maxPE)) return false;
  if (isNum(S.maxPEG) && !(isNum(r.peg) && r.peg <= S.maxPEG)) return false;
  if (isNum(S.minIV) && !(isNum(r.iv) && r.iv >= S.minIV)) return false;
  if (isNum(S.earnN) && !(isNum(r.ern) && r.ern >= 0 && r.ern <= S.earnN)) return false;
  if (isNum(S.minEarnAway) && !(isNum(r.ern) && r.ern >= S.minEarnAway)) return false;
  if (isNum(S.minOpp) && !(r.sam && isNum(r.sam.opp) && r.sam.opp >= S.minOpp)) return false;
  if (S.hideMissing && !(isNum(r.pef) && isNum(r.peg) && r.rel)) return false;
  return true;
}
function filtered() {
  const p = PRESETS.find(x => x.id === V.preset) || PRESETS[0];
  const q = V.q.trim().toLowerCase();
  let rows = D.rows.filter(r => (!p.f || p.f(r)) && screenPass(r) && (!V.sector || r.sec === V.sector) &&
    (!q || r.t.toLowerCase().startsWith(q) || (r.n || '').toLowerCase().includes(q) || (r.sec || '').toLowerCase().includes(q)));
  const {k, dir, abs} = V.sort;
  rows.sort((a, b) => {
    let x = val(a, k), y = val(b, k);
    if (abs) { x = isNum(x) ? Math.abs(x) : x; y = isNum(y) ? Math.abs(y) : y; }
    const xn = x == null, yn = y == null;
    if (xn || yn) return xn && yn ? 0 : xn ? 1 : -1;     // missing always last
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
  return rows;
}
function renderChips() {
  $('#chips').innerHTML = PRESETS.map(p => `<button data-p="${p.id}" class="${V.preset === p.id ? 'on' : ''}">${p.h}</button>`).join('') +
    (V.sector ? `<button data-clr-sector="1" class="on">${esc(V.sector)} ✕</button>` : '');
}
function renderHead() {
  $('#thead').innerHTML = '<tr>' + activeCols().map(c => {
    if (c.k === 'scen' && !scenOn()) return '';
    const s = V.sort.k === c.k ? ' sorted' : '';
    const arrow = V.sort.k === c.k ? (V.sort.dir > 0 ? ' ▴' : ' ▾') : '';
    return `<th class="${c.l ? 'l' : ''}${c.ph ? ' ph' : ''}${c.k === 'scen' ? ' scen' : ''}${s}" data-k="${c.ns ? '' : c.k}"${c.tip ? ` data-tip="${esc(c.tip)}"` : ''}>${c.h}${arrow}</th>`;
  }).join('') + '</tr>';
}
function cell(r, c) {
  switch (c.k) {
    case 't': {
      const a = r.sets.includes('A'), b = r.sets.includes('B');
      const badge = `<span class="badge${a ? ' a' : ''}" data-tip="${a ? 'A = top S&P 500 mover today' : ''}${a && b ? '\n' : ''}${b ? "B = in Historical 2026-07-25 universe" : ''}">${a && b ? 'A+B' : a ? 'A' : 'B'}</span>`;
      return `<td class="l"><span class="tk" data-tip="${esc((r.n || '') + '\n' + (r.sec || '') + (r.ind ? ' · ' + r.ind : ''))}">${esc(r.t)}</span>${badge}</td>`;
    }
    case 'd1': return `<td data-live="${esc(r.t)}" data-live-f="chg" class="${stl(r, 'chg')}" data-tip="${esc(provTip(r, 'chg'))}">${pct(r.d1, 2, stReason(r, 'chg', '1d change'))}</td>`;
    case 'px': return `<td data-tip="${esc(provTip(r, 'price'))}"><span data-live="${esc(r.t)}" data-live-f="price">${num(r.px, 2, stReason(r, 'price', 'price'))}</span><small style="display:block;font-size:10px" data-live="${esc(r.t)}" data-live-f="asof">${esc(r.pxd || 'date unavailable')}</small></td>`;
    case 'spark': return `<td>${spark(r.spark, 56, 16)}</td>`;
    case 'pef': return `<td data-live="${esc(r.t)}" data-live-f="pef" class="ph${stl(r, 'pe_forward')}" data-tip="${esc(fundTip(r, 'Forward P/E'))}">${num(r.pef, 1, stReason(r, 'pe_forward', 'forward P/E'))}</td>`;
    case 'peg': return `<td class="ph${stl(r, 'peg')}" data-tip="${esc(fundTip(r, 'PEG') + '\n' + (r.pegm || ''))}">${num(r.peg, 2, stReason(r, 'peg', 'PEG'))}</td>`;
    case 'pct': return `<td class="ph" data-tip="52w low ${r.lo} · high ${r.hi} · ${isNum(r.pct) ? r.pct.toFixed(0) + ' pctile' : ''}">${isNum(r.pct) ? `<span class="rng"><i style="left:${Math.max(0, Math.min(100, r.pct)) * .42}px"></i></span>` : na(stReason(r, 'range_52w', '52w range'))}</td>`;
    case 'ern': return `<td class="ph" data-tip="${esc((r.er || '') + ' ' + (r.ert || '') + '\n' + (r.ers || ''))}">${isNum(r.ern) ? r.ern + 'd' : na(stReason(r, 'earnings', 'earnings date'))}</td>`;
    case 'iv': return `<td class="ph" data-tip="${esc(r.ivs ? `${r.ivs}\nexpiry ${r.ivx}, strike ${r.ivk}${r.ivspan ? '\nexpiry spans earnings' : ''}` : '')}">${isNum(r.iv) ? r.iv.toFixed(1) : na('ATM IV only fetched for movers + nearest-earnings names (status: ' + ((r.st || {}).atm_iv || 'not fetched') + ')')}</td>`;
    case 'opp': return `<td class="ph sam" data-tip="${esc(r.sam ? `Historical snapshot 2026-07-25 · quality ${r.sam.q || '-'} · risk ${r.sam.risk || '-'}
flags ${r.sam.flags || '-'}${r.sam.risk === 'AVOID' ? '\nAVOID -> his composite is 0 by rule' : ''}` : '')}">${r.sam ? num(r.sam.opp, 1, 'no score in snapshot') : na("not in Historical 2026-07-25 snapshot")}</td>`;
    case 'b10': case 'boil': {
      const f = c.k === 'b10' ? 'us10y_bps' : 'wti';
      if (!r.rel) return `<td class="ph">${na('no regression (insufficient history)')}</td>`;
      const v = val(r, c.k), t = r.rel.t[f];
      return `<td class="ph ${Math.abs(t) >= S.minT ? 'sig' : 'nsig'}" data-tip="coef ${r.rel.c[f]} · t ${t} · R² ${r.rel.r2} · n ${r.rel.n}">${pct(v, 2)}</td>`;
    }
    case 'scen': if (!scenOn()) return ''; return `<td class="scen" data-tip="${esc(r.rel ? 'sum(coef x shock), 252-session OLS, n ' + r.rel.n + '\nhistorical association, not a forecast' : '')}">${r.rel ? pct(val(r, 'scen'), 2) : na('no regression')}</td>`;
    case 'd5': return `<td data-tip="${esc(provTip(r, 'chg'))}">${pct(r.d5, 1, stReason(r, 'chg_5d', '5d change'))}</td>`;
    case 'm1': return `<td data-tip="${esc(provTip(r, 'chg'))}">${pct(r.m1, 1, stReason(r, 'chg_1m', '1M change'))}</td>`;
    case 'pe': return `<td data-live="${esc(r.t)}" data-live-f="pe" class="ph${stl(r, 'pe_trailing')}" data-tip="${esc(fundTip(r, 'Trailing P/E'))}">${num(r.pe, 1, stReason(r, 'pe_trailing', 'trailing P/E'))}</td>`;
    case 'vr': return `<td class="ph" data-tip="volume / 20-day avg volume\nYahoo Finance via yfinance, session ${esc(r.pxd || '')}">${isNum(r.vr) ? r.vr.toFixed(2) + 'x' : na(stReason(r, 'vol_ratio_20d', 'volume ratio'))}</td>`;
    case 'beta': return `<td class="ph" data-tip="provider beta, Yahoo Finance via yfinance\nretrieved ${esc(r.rat || 'n/a')}">${num(r.beta, 2, stReason(r, 'beta_provider', 'beta'))}</td>`;
    case 'up': return `<td class="ph" data-tip="Yahoo analyst mean target ${esc(isNum(r.tgt) ? r.tgt : 'n/a')} vs price\nnot consensus EPS (no licensed source)">${pct(r.up, 0, stReason(r, 'analyst', 'analyst target'))}</td>`;
    case 'bdxy': case 'bvix': case 'bspy': {
      const f = {bdxy: 'dxy', bvix: 'vix', bspy: 'spy'}[c.k];
      if (!r.rel) return `<td class="ph">${na('no regression (insufficient history)')}</td>`;
      const t = r.rel.t[f];
      return `<td class="ph ${Math.abs(t) >= S.minT ? 'sig' : 'nsig'}" data-tip="coef ${r.rel.c[f]} · t ${t} · R² ${r.rel.r2} · n ${r.rel.n}">${pct(r.rel.c[f], 2)}</td>`;
    }
    case 'r2': return `<td class="ph" data-tip="${esc(r.rel ? '5-factor OLS, n ' + r.rel.n : '')}">${r.rel ? num(r.rel.r2, 2) : na('no regression (insufficient history)')}</td>`;
    case 'risk': return `<td class="ph sam" data-tip="${esc(samLabel('tip'))}">${r.sam && r.sam.risk ? esc(r.sam.risk) : na("not in Historical 2026-07-25 snapshot")}</td>`;
    case 'qual': return `<td class="ph sam" data-tip="${esc(samLabel('tip'))}">${r.sam && r.sam.q ? esc(r.sam.q) : na("not in Historical 2026-07-25 snapshot")}</td>`;
    case 'res20d': return `<td class="ph" data-tip="${esc(r.att ? `20d actual ${r.att.actual_20d}% = factors ${r.att.explained_20d}% + idiosyncratic ${r.res20d}%` : '20d idiosyncratic residual')}">${pct(r.res20d, 1, 'no 20d attribution')}</td>`;
    case 'res5d': return `<td class="ph" data-tip="${esc(r.att ? `5d actual ${r.att.actual_5d}% = factors ${r.att.explained_5d}% + idiosyncratic ${r.res5d}%` : '5d idiosyncratic residual')}">${pct(r.res5d, 1, 'no 5d attribution')}</td>`;
    case 'pefrel': return `<td class="ph" data-tip="${esc(`Fwd P/E ${r.pef || 'n/a'} vs ${r.sec || 'sector'} median ${r.pef_sec_med || 'n/a'}x`)}">${isNum(r.pef_sec_rel) ? `<span class="${r.pef_sec_rel <= 0.9 ? 'up' : r.pef_sec_rel >= 1.2 ? 'dn' : ''}">${r.pef_sec_rel.toFixed(2)}x</span>` : na('forward P/E missing')}</td>`;
    case 'epsg': return `<td title="${esc(r.eps_ratio_note || 'Ratio comparison, not expected growth')}" class="ph" data-tip="P/E ratio comparison = 100 * (trailing P/E / forward P/E - 1); not expected growth. Extreme values may reflect small bases or one-off charges.">${pct(r.eps_g_imp, 1, 'requires positive trailing and forward P/E')}</td>`;
    case 'rv20': return `<td class="ph" data-tip="20-session annualized realized volatility from Adj Close log returns">${isNum(r.rv20) ? r.rv20.toFixed(1) + '%' : na('insufficient bars')}</td>`;
    case 'ivrv': return `<td class="ph" data-tip="${esc(isNum(r.ivrv) ? `ATM IV ${r.iv}% / RV20 ${r.rv20}%` : `Sector median IV proxy ${r.iv_sec_med}% / RV20 ${r.rv20}%`)}">${isNum(r.ivrv) ? r.ivrv.toFixed(2) + 'x' : isNum(r.ivrv_eff) ? `<span class="dim" title="Sector IV proxy">${r.ivrv_eff.toFixed(2)}p</span>` : na('vol missing')}</td>`;
    case 'drift': return `<td class="ph sam" data-tip="${esc(r.sam_drift && isNum(r.sam_drift.px_pct) ? `Price change since 2026-07-25 snapshot ($${r.sam ? r.sam.px : ''} -> $${r.px})` : 'Not in snapshot')}">${pct(r.sam_drift ? r.sam_drift.px_pct : null, 1, 'not in Historical snapshot')}</td>`;
  }
  return '<td></td>';
}
function stl(r, f) { return r.st && r.st[f] === 'stale' ? ' stale' : ''; }
function fundTip(r, what) { return `${what}: Yahoo Finance via yfinance
retrieved ${r.rat || 'n/a'} · status ${(r.st && r.st[what === 'PEG' ? 'peg' : 'pe_forward']) || 'n/a'}`; }
function provTip(r, k) {
  return k === 'price' ? `price ${r.px} close ${r.pxd}\nYahoo Finance via yfinance (unadjusted)` : `adj close vs prior adj close, session ${r.pxd}\nYahoo Finance via yfinance`;
}
function renderTable() {
  renderHead(); renderChips();
  const rows = filtered();
  const selT = V.sel.kind === 't' ? V.sel.id : null;
  $('#tbody').innerHTML = rows.map(r => `<tr data-t="${esc(r.t)}"${r.t === selT ? ' class="sel"' : ''}>${activeCols().map(c => cell(r, c)).join('')}</tr>`).join('');
  const sc = scenOn() ? ' · scenario on: ' + FACTORS.filter(f => S.shock[f]).map(f => `${FLABEL[f]} ${S.shock[f] > 0 ? '+' : ''}${S.shock[f]}${SHOCK_U[f]}`).join(', ') + ' (historical association, not a forecast)' : '';
  const sk = V.sort.k.startsWith('c:') ? ` · sorted by ${FLABEL[V.sort.k.slice(2)]} coef` : '';
  if (window.SmartOptionsLive) {
    // budget: only the top rows of the current sort are polled; the rest keep their file quote and its own time
    if (document.body.classList.contains('bv-research')) window.SmartOptionsLive.watch('table', rows.slice(0, 12).map(r => r.t));
    window.SmartOptionsLive.paint(document.getElementById('tbody'));
  }
  $('#tmeta').innerHTML = `<span>${rows.length} of ${D.rows.length}${V.sector ? ' · ' + esc(V.sector) : ''}${sk}${sc}</span><span>Historical scores are optional in Settings</span>`;
}

/* ---------- chart ---------- */
function ensureChart() {
  if (chart) return;
  const el = $('#chart');
  chart = LightweightCharts.createChart(el, {
    autoSize: true,
    layout: {background: {type: 'solid', color: '#0b0e11'}, textColor: '#8a939b', fontSize: 11, fontFamily: getComputedStyle(document.body).fontFamily},
    grid: {vertLines: {color: '#151a1f'}, horzLines: {color: '#151a1f'}},
    rightPriceScale: {borderColor: '#232a31'}, leftPriceScale: {borderColor: '#232a31', visible: false},
    timeScale: {borderColor: '#232a31'}, crosshair: {mode: 0},
  });
  chart.subscribeCrosshairMove(p => {
    if (!p || !p.time || !mainSeries) { legend(); return; }
    const a = p.seriesData.get(mainSeries), b = ovSeries ? p.seriesData.get(ovSeries) : null;
    const av = a ? (a.value != null ? a.value : a.close) : null;
    legend(p.time, av, b ? b.value : null);
  });
  chart.subscribeClick(p => {
    if (!p || !p.time || !mainSeries) return;
    const a = p.seriesData.get(mainSeries), b = ovSeries ? p.seriesData.get(ovSeries) : null;
    window.dispatchEvent(new CustomEvent('so:chart-point', {detail: {selection: Object.assign({}, V.sel), time: p.time,
      value: a && (a.value != null ? a.value : a.close), overlay: V.overlay, overlay_value: b && b.value}}));
  });
}
let legendBase = '';
function legend(t, a, b) {
  if (t == null) { $('#clegend').innerHTML = legendBase; return; }
  const ts = typeof t === 'string' ? t : `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
  $('#clegend').innerHTML = `${ts} · ${num(a, 2)}${b != null ? ` · <span style="color:#6ea8fe">${esc(V.overlay ? FLABEL2(V.overlay) : '')} ${num(b, 2)}</span>` : ''}`;
}
const OVERLAYS = [['', 'none'], ['us10y', '10Y'], ['dxy', 'DXY'], ['wti', 'WTI'], ['vix', 'VIX'], ['SPY', 'SPY'], ['spread_10y_2y', '2s10s'], ['hy_oas', 'HY OAS']];
const FLABEL2 = id => (OVERLAYS.find(o => o[0] === id) || [id, id])[1];
const clean = arr => {
  const out = [], seen = new Set();
  for (const p of arr || []) { if (!p || !isNum(p[1]) || seen.has(p[0])) continue; seen.add(p[0]); out.push({time: p[0], value: p[1]}); }
  out.sort((a, b) => a.time < b.time ? -1 : 1); return out;
};
async function drawChart() {
  const draw = ++chartDraw;
  ensureChart();
  if (mainSeries) { chart.removeSeries(mainSeries); mainSeries = null; }
  if (ovSeries) { chart.removeSeries(ovSeries); ovSeries = null; }
  const sel = V.sel;
  let data = [], title = '', sub = '', chgHtml = '';
  if (sel.kind === 't') {
    const d = await px(sel.id);
    if (draw !== chartDraw) return;
    data = d.bars.filter(b => isNum(b[4])).map(b => ({time: b[0], value: b[4]}));
    const r = rowOf(sel.id);
    title = sel.id; sub = r ? `${r.n || ''} · ${r.sec || ''}` : (sel.id === 'SPY' ? 'SPDR S&P 500 ETF' : '');
    const last = r ? r.px : (data.length ? data[data.length - 1].value : null);
    chgHtml = `${num(last, 2)} ${pct(r ? r.d1 : (sel.id === 'SPY' ? (D.tape.find(x => x.id === 'SPY') || {}).chg : null), 2, 'n/a')}`;
    if (!data.length) sub += ' · no price bars';
  } else {
    data = clean(seriesData(sel.id));
    const o = obsOf(sel.id);
    title = (D.tape.find(x => x.id === sel.id) || {}).label || (o ? o.label : seriesLabel(sel.id));
    sub = o ? `${o.label} · ${o.provider} ${o.series} · ${o.unit}` : seriesLabel(sel.id);
    chgHtml = o ? `${num(o.v, 2)} <span class="dim">${esc(o.period || '')}</span>` : (data.length ? num(data[data.length - 1].value, 2) : na('no data'));
    // regime history (partial) can end before the session the tape score is for: say so instead of showing two numbers silently
    if (sel.id === 'regime' && data.length) { const tv = (D.tape.find(x => x.id === 'regime') || {}).v; chgHtml = `${num(data[data.length - 1].value, 0)} <span class="dim">history last ${esc(data[data.length - 1].time)}${isNum(tv) ? ` · tape score ${tv} (session ${esc(D.asof_session)})` : ''}</span>`; }
  }
  let od = [];
  if (V.overlay && V.overlay !== sel.id) {
    od = (rowOf(V.overlay) || V.overlay === 'SPY') ? clean((await px(V.overlay)).bars.map(b => [b[0], b[4]])) : clean(seriesData(V.overlay));
    if (draw !== chartDraw) return;
  }
  const months = {'1M': 1, '3M': 3, '6M': 6, '1Y': 12}[V.range];
  let cutTime = null;
  if (months && data.length) {
    const toD = new Date(data[data.length - 1].time + 'T00:00:00Z');
    toD.setUTCMonth(toD.getUTCMonth() - months);
    cutTime = toD.toISOString().slice(0, 10);
  }
  let plotMain = data, plotOv = od, modeNote = '';
  if (od.length && V.cmpMode === 'idx') {
    const ovMap = new Map(od.map(p => [p.time, p.value]));
    const shared = data.filter(p => (!cutTime || p.time >= cutTime) && ovMap.has(p.time) && p.value !== 0 && ovMap.get(p.time) !== 0);
    if (shared.length >= 2) {
      const b0 = shared[0].value, o0 = ovMap.get(shared[0].time);
      plotMain = shared.map(p => ({time: p.time, value: (p.value / b0 - 1) * 100}));
      plotOv = shared.map(p => ({time: p.time, value: (ovMap.get(p.time) / o0 - 1) * 100}));
      modeNote = `Indexed % change from ${shared[0].time} (0% baseline, shared right scale)`;
    }
  } else if (od.length && V.cmpMode === 'ratio') {
    const ovMap = new Map(od.map(p => [p.time, p.value]));
    const shared = data.filter(p => (!cutTime || p.time >= cutTime) && ovMap.has(p.time) && ovMap.get(p.time) !== 0);
    if (shared.length >= 2) {
      const r0 = shared[0].value / ovMap.get(shared[0].time);
      plotMain = shared.map(p => ({time: p.time, value: r0 ? ((p.value / ovMap.get(p.time)) / r0) * 100 : 100}));
      plotOv = [];
      modeNote = `Relative ratio (${sel.id} / ${FLABEL2(V.overlay)}) indexed to 100 on ${shared[0].time}`;
    }
  }
  const up = plotMain.length > 1 && plotMain[plotMain.length - 1].value >= plotMain[0].value;
  mainSeries = chart.addAreaSeries({lineColor: up ? '#00c805' : '#ff5000', topColor: up ? 'rgba(0,200,5,.18)' : 'rgba(255,80,0,.18)', bottomColor: 'rgba(0,0,0,0)', lineWidth: 2, priceLineVisible: false});
  mainSeries.setData(plotMain);
  if (V.overlay && V.overlay !== sel.id && plotOv.length) {
    const sameScale = V.cmpMode === 'idx';
    ovSeries = chart.addLineSeries({color: '#6ea8fe', lineWidth: 1.5, priceScaleId: sameScale ? 'right' : 'left', priceLineVisible: false, lastValueVisible: true});
    ovSeries.setData(plotOv);
    chart.applyOptions({leftPriceScale: {visible: !sameScale}});
  } else chart.applyOptions({leftPriceScale: {visible: false}});
  markers(plotMain);
  $('#ctitle').innerHTML = `<div class="big">${esc(title)} <span style="font-size:15px">${chgHtml}</span></div><div class="nm">${esc(sub)}</div>`;
  const cmpBtns = V.overlay && V.overlay !== sel.id ? ` · <span class="cmp-modes" style="display:inline-flex;gap:3px">${[['dual','Dual scale'],['idx','Indexed %'],['ratio','Ratio (A/B)']].map(([m,l])=>`<button type="button" data-cmpmode="${m}" class="${V.cmpMode===m?'on':''}" style="padding:1px 5px;font-size:10px;cursor:pointer">${l}</button>`).join('')}</span>` : '';
  legendBase = (V.overlay ? `<span style="color:#6ea8fe">— ${esc(FLABEL2(V.overlay))} (${esc(modeNote || 'on left scale')})</span> · co-movement is association, not causation` : '') + cmpBtns;
  legend();
  setRange();
  evStrip();
  window.dispatchEvent(new CustomEvent('so:chart-update', {detail: {selection: Object.assign({}, sel)}}));
}
function snapTime(data, d) { let best = null; for (const p of data) { if (p.time <= d) best = p.time; else break; } return best; }
function markers(data) {
  if (!data.length || !mainSeries) return;
  const first = data[0].time, last = data[data.length - 1].time, ms = [];
  for (const e of D.calendar || []) {
    const d = (e.scheduled_et || '').slice(0, 10);
    if (!d || d < first || d > last || !['FOMC', 'CPI', 'NFP', 'PCE', 'GDP', 'PPI'].includes(e.type)) continue;
    const t = snapTime(data, d); if (!t) continue;
    ms.push({time: t, position: 'aboveBar', color: '#8a939b', shape: 'arrowDown', text: e.type});
  }
  ms.sort((a, b) => a.time < b.time ? -1 : 1);
  mainSeries.setMarkers(ms);
}
function setRange() {
  if (!mainSeries || !chart) return;
  const months = {'1M': 1, '3M': 3, '6M': 6, '1Y': 12}[V.range];
  const d = mainSeries.data(), lastT = d.length ? d[d.length - 1].time : D.asof_session;
  if (!months || !d.length) chart.timeScale().fitContent();
  else {
    const to = new Date(lastT + 'T00:00:00Z'); const from = new Date(to); from.setUTCMonth(from.getUTCMonth() - months);
    const fs = from.toISOString().slice(0, 10);
    // monthly/quarterly series: too few points in a short window -> show all instead of an empty chart
    if (d.filter(p => p.time >= fs).length < 12) chart.timeScale().fitContent();
    else try { chart.timeScale().setVisibleRange({from: fs, to: lastT}); } catch (e) { chart.timeScale().fitContent(); }
  }
  $('#ranges').innerHTML = ['1M', '3M', '6M', '1Y', 'All'].map(r => `<button data-r="${r}" class="${V.range === r ? 'on' : ''}">${r}</button>`).join('');
}
function daysTo(iso) { return Math.round((new Date(iso) - new Date()) / 864e5 * 10) / 10; }
function evStrip() {
  const up = (D.calendar || []).filter(e => e.status !== 'released' && new Date(e.scheduled_et) > new Date()).slice(0, 6);
  const r = V.sel.kind === 't' ? rowOf(V.sel.id) : null;
  const items = up.map(e => `<span data-tip="${esc(e.title + '\n' + e.scheduled_et + '\n' + (e.source_url || ''))}">${esc(e.type)} ${esc(e.scheduled_et.slice(5, 10))} <span class="dim">${Math.max(0, daysTo(e.scheduled_et)).toFixed(0)}d</span></span>`);
  if (r && isNum(r.ern) && r.ern >= 0) items.unshift(`<span data-tip="${esc((r.ers || '') + '\nYahoo dates can be estimates')}">${esc(r.t)} earnings ${esc((r.er || '').slice(5))} <span class="dim">${r.ern}d</span></span>`);
  $('#evstrip').innerHTML = items.length ? 'Next: ' + items.join('') : '<span class="dim">no scheduled events in calendar</span>';
}

/* ---------- signals ---------- */
function renderSignals() {
  const m = (D.methods && D.methods.signals) || '';
  $('#signals').innerHTML = (D.signals || []).map((s, i) => `<div class="sr" data-sig="${i}" data-tip="${esc((s.factor ? `${FLABEL[s.factor] || s.factor}: move ${s.move}${s.moveu || ''} over 20 sessions (macro history)\ncoef ${s.coef} · t ${s.tstat} (OLS, ${D.rel.window}) → implied ${s.implied}%\n` : '') + (typeof m === 'string' ? m : JSON.stringify(m)) + '\nassociation, not causation')}"><span class="k">${esc(s.kind)}</span>${esc(s.text)}</div>`).join('') || '<div class="sr dim">no signals</div>';
}

/* ---------- detail pane ---------- */
async function renderDetail() {
  const el = $('#detail');
  const sel = V.sel;
  if (sel.kind !== 't' || !rowOf(sel.id)) { el.innerHTML = macroDetail(sel.id); return; }
  const r = rowOf(sel.id);
  const d = await px(r.t);
  if (V.sel.id !== r.t) return;
  el.innerHTML = tickerDetail(r, d);
}
function stat(k, v, tip) { return `<div${tip ? ` data-tip="${esc(tip)}"` : ''}><div class="k">${k}</div><div class="v">${v}</div></div>`; }
function tickerDetail(r, d) {
  const g = [
    stat('Price', num(r.px, 2, stReason(r, 'price', 'price')), provTip(r, 'price')),
    stat('1d / 5d', `${pct(r.d1, 2, stReason(r, 'chg', '1d change'))} ${pct(r.d5, 1, stReason(r, 'chg', '5d change'))}`, provTip(r, 'chg')),
    stat('1M', pct(r.m1, 1, stReason(r, 'chg', '1M change')), provTip(r, 'chg')),
    stat('P/E ttm', num(r.pe, 1, stReason(r, 'pe_trailing', 'trailing P/E')), fundTip(r, 'Trailing P/E')),
    stat('P/E fwd', num(r.pef, 1, stReason(r, 'pe_forward', 'forward P/E')), fundTip(r, 'Forward P/E')),
    stat('PEG', num(r.peg, 2, stReason(r, 'peg', 'PEG')), r.pegm || ''),
    stat('52w', isNum(r.lo) ? `${num(r.lo, 0)}–${num(r.hi, 0)}` : na('no range'), (isNum(r.pct) ? `${r.pct.toFixed(0)}th pctile of range\n` : '') + 'unadjusted 52-week high/low, Yahoo Finance via yfinance'),
    stat('Vol / 20d', isNum(r.vr) ? r.vr.toFixed(2) + 'x' : na(stReason(r, 'vol_ratio_20d', 'volume ratio')), `session volume / 20-day avg volume, session ${r.pxd || 'n/a'}\nYahoo Finance via yfinance`),
    stat('Beta (prov.)', num(r.beta, 2, stReason(r, 'beta_provider', 'beta')), `provider beta (not our regression)\nYahoo Finance via yfinance, retrieved ${r.rat || 'n/a'}`),
    stat('ATM IV', isNum(r.iv) ? r.iv.toFixed(1) + '%' : na('not fetched for this ticker'), r.ivs ? `${r.ivs}\nexpiry ${r.ivx} strike ${r.ivk}` : ''),
    stat('Analyst', r.rating ? `${esc(String(r.rating).replace(/_/g, ' '))} <span class="sub">n${r.nan || ''}</span>` : na(stReason(r, 'analyst', 'analyst')), `Yahoo analyst recommendation, ${r.nan || '?'} analysts\nretrieved ${r.rat || 'n/a'}`),
    stat('Target', isNum(r.tgt) ? `${num(r.tgt, 0)} ${pct(r.up, 0)}` : na('no target'), 'Yahoo analyst mean target; consensus EPS not shown (no licensed source)'),
  ].join('');
  return `<div class="dh"><div class="big">${esc(r.t)} ${pct(r.d1, 2)}</div><div class="sub">${esc(r.n || '')} · ${esc(r.sec || '')} · ${esc(r.ind || '')}</div></div>
    <div class="grid">${g}</div>
    ${sensBlock(r)}${attrBlock(r)}${samBlock(r, d)}${eventsBlock(r)}`;
}
function sensBlock(r) {
  if (!r.rel) return `<div class="blk"><div class="sech">Macro sensitivity</div><div class="evl">${na('no regression for this ticker')}</div></div>`;
  const rows = FACTORS.map(f => {
    const c = r.rel.c[f], t = r.rel.t[f];
    const se = isNum(c) && isNum(t) && t !== 0 ? Math.abs(c / t) : null;
    return {f, c, t, se};
  });
  const W = 300, rowH = 22, x0p = 40, x1p = 210, mid = (x0p + x1p) / 2;
  const mx = Math.max(S.minT + 1, ...rows.map(x => isNum(x.t) ? Math.abs(x.t) + 2 : 0));
  const sx = v => mid + v / mx * (x1p - x0p) / 2;
  const svg = rows.map((x, i) => {
    const y = 6 + i * rowH, sig = Math.abs(x.t) >= S.minT;
    if (!isNum(x.c) || !isNum(x.t)) return `<text x="4" y="${y + 11}" fill="#6b757f" font-size="11">${FLABEL[x.f]} \u2014</text>`;
    const a0 = sx(Math.min(0, x.t)), a1 = sx(Math.max(0, x.t));
    const col = sig ? (x.c >= 0 ? '#00c805' : '#ff5000') : '#3a434c';
    const lo = sx(x.t - 2), hi = sx(x.t + 2);
    return `<g data-tip="${esc(`${FLABEL[x.f]}: coef ${x.c} ${D.rel.units[x.f]}\nt ${x.t}${sig ? ' \u2265 ' : ' < '}${S.minT} (your threshold)\nbar = t-stat; whiskers = coef \u00b1 2 SE`)}">
      <text x="4" y="${y + 11}" fill="#a3acb5" font-size="11">${FLABEL[x.f]}</text>
      <rect x="${a0}" y="${y + 3}" width="${Math.max(1, a1 - a0)}" height="10" fill="${col}"/>
      <line x1="${lo}" x2="${hi}" y1="${y + 8}" y2="${y + 8}" stroke="#8a939b" stroke-width="1"/>
      <line x1="${lo}" x2="${lo}" y1="${y + 4}" y2="${y + 12}" stroke="#8a939b"/><line x1="${hi}" x2="${hi}" y1="${y + 4}" y2="${y + 12}" stroke="#8a939b"/>
      <text x="${W - 4}" y="${y + 11}" fill="${sig ? '#e8ebee' : '#6b757f'}" font-size="11" text-anchor="end">${x.c > 0 ? '+' : ''}${x.c.toFixed(3)} t${x.t > 0 ? '+' : ''}${x.t.toFixed(1)}</text></g>`;
  }).join('');
  const thr = [-S.minT, S.minT].map(v => `<line x1="${sx(v)}" x2="${sx(v)}" y1="0" y2="${6 + rows.length * rowH}" stroke="#2c343c" stroke-dasharray="2 3"/>`).join('');
  return `<div class="blk"><div class="sech" data-tip="${esc('OLS of daily % return on factor moves, ' + D.rel.window + '. R² ' + r.rel.r2 + ', n ' + r.rel.n + '. Association, not causation.')}">Macro sensitivity <span class="dim">t-stat bars · R² ${r.rel.r2}</span></div>
    <svg width="100%" viewBox="0 0 ${W} ${6 + rows.length * rowH}" preserveAspectRatio="xMinYMin meet"><line x1="${mid}" x2="${mid}" y1="0" y2="${6 + rows.length * rowH}" stroke="#232a31"/>${thr}${svg}</svg></div>`;
}
function attrBlock(r) {
  const a = r.att;
  if (!a) return '';
  const parts = FACTORS.map(f => ({k: FLABEL[f], v: a.by_factor[f]})).concat([{k: 'Stock', v: a.stock_specific}]);
  const W = 300, H = 120, top = 10, bot = H - 22;
  let cum = 0; const vals = [0];
  parts.forEach(p => { cum += isNum(p.v) ? p.v : 0; vals.push(cum); });
  const mn = Math.min(0, ...vals, a.actual), mx = Math.max(0, ...vals, a.actual), rg = mx - mn || 1;
  const sy = v => top + (mx - v) / rg * (bot - top);
  const n = parts.length + 1, bw = W / n;
  let run = 0;
  const bars = parts.map((p, i) => {
    const v = isNum(p.v) ? p.v : 0, y0 = sy(run), y1 = sy(run + v); run += v;
    return `<rect x="${i * bw + 4}" y="${Math.min(y0, y1)}" width="${bw - 8}" height="${Math.max(1, Math.abs(y1 - y0))}" fill="${v >= 0 ? '#00c805' : '#ff5000'}"/>
      <text x="${i * bw + bw / 2}" y="${H - 9}" fill="#a3acb5" font-size="10" text-anchor="middle">${p.k}</text>
      <text x="${i * bw + bw / 2}" y="${H}" fill="#6b757f" font-size="9" text-anchor="middle">${v > 0 ? '+' : ''}${v.toFixed(2)}</text>`;
  }).join('');
  const tx = (n - 1) * bw;
  const tot = `<rect x="${tx + 4}" y="${Math.min(sy(0), sy(a.actual))}" width="${bw - 8}" height="${Math.max(1, Math.abs(sy(a.actual) - sy(0)))}" fill="#8a939b"/>
    <text x="${tx + bw / 2}" y="${H - 9}" fill="#e8ebee" font-size="10" text-anchor="middle">Actual</text><text x="${tx + bw / 2}" y="${H}" fill="#a3acb5" font-size="9" text-anchor="middle">${a.actual > 0 ? '+' : ''}${a.actual.toFixed(2)}</text>`;
  const mh = (isNum(a.resid_5d) || isNum(a.resid_20d)) ? `<div class="sub" style="padding:4px 12px"><b>Multi-horizon residual α:</b> 1d ${pct(a.stock_specific, 2)} · 5d ${pct(a.resid_5d, 2)} (actual ${pct(a.actual_5d, 1)} vs macro ${pct(a.explained_5d, 1)}) · 20d ${pct(a.resid_20d, 2)} (actual ${pct(a.actual_20d, 1)} vs macro ${pct(a.explained_20d, 1)})</div>` : '';
  return `<div class="blk"><div class="sech" data-tip="${esc('coef x that session\'s factor move, summed = factor-explained; remainder = stock-specific. Session ' + a.date)}">Move attribution ${esc(a.date)} <span class="dim">% pts</span></div>
    <svg width="100%" viewBox="0 0 ${W} ${H + 2}"><line x1="0" x2="${W}" y1="${sy(0)}" y2="${sy(0)}" stroke="#232a31"/>${bars}${tot}</svg>${mh}</div>`;
}
function samBlock(r, d) {
  if (!r.sam) return `<div class="blk"><div class="sech">Historical score</div><div class="evl">${na("not in Historical 2026-07-25 snapshot")}</div></div>`;
  const s = r.sam, c = d && d.sam_components;
  let bar = '';
  if (c && c.reproduced) {
    const W = 300, segs = []; let x = 0;
    const cols = ['#4f8a5b', '#5a7fa8', '#9a8a4f', '#8a5a8a'];
    c.parts.forEach((p, i) => { const w = p.w * p.score / 100 / 100 * W; segs.push(`<rect x="${x}" y="0" width="${w}" height="12" fill="${cols[i]}" data-tip="${esc(`${p.k}: raw ${p.raw}${p.unit} → score ${p.score} x weight ${p.w}%\n${p.desc || ''}`)}"/>`); x += w; });
    segs.push(`<rect x="0" y="0" width="${W}" height="12" fill="none" stroke="#232a31"/>`);
    bar = `<svg width="100%" viewBox="0 0 ${W} 12" preserveAspectRatio="none" style="height:12px">${segs.join('')}</svg>
      <div class="sub" style="padding:3px 0">${c.parts.map((p, i) => `<span style="color:${cols[i]}">■</span> ${p.k} ${p.score.toFixed(0)}`).join(' · ')}<br>base ${c.base_score == null ? (c.parts.reduce((a, p) => a + p.w * p.score, 0) / 100).toFixed(2) : c.base_score.toFixed(2)} x Q ${c.qmult} x R ${c.rmult} = ${c.derived} (published ${c.published})</div>`;
  } else if (c) bar = `<div class="sub">components not shown: could not reproduce published score from EXPLAIN</div>`;
  return `<div class="blk"><div class="sech" data-tip="${esc("Historical own scores, read-only. SmartOptions snapshot " + (s.asof || '2026-07-25') + '. Component split uses his documented formula and is shown only when it reproduces his published number.')}">Historical score <span class="dim">Historical scores are optional in Settings</span></div>
    <div style="padding:0 12px">
    <div class="grid" style="grid-template-columns:repeat(4,1fr);border:0">${stat('Opp', num(s.opp, 1))}${stat('Quality', esc(s.q || '—'))}${stat('Trend', num(s.trend, 0))}${stat('Risk', esc(s.risk || '—'))}</div>
    ${bar}<div class="sub">flags: ${esc(s.flags || '—')} · snapshot price ${num(s.px, 2)}${r.sam_drift && isNum(r.sam_drift.px_pct) ? ` · <b>drift since 07-25: ${pct(r.sam_drift.px_pct, 1)} px${isNum(r.sam_drift.pef_chg) ? ', ' + (r.sam_drift.pef_chg > 0 ? '+' : '') + r.sam_drift.pef_chg.toFixed(1) + 'x fP/E' : ''}</b>` : ''}${r.sam_drift && (isNum(r.sam_drift.roe) || isNum(r.sam_drift.de)) ? `<br>retained quality inputs (07-25): ROE ${num(r.sam_drift.roe, 1)}% · D/E ${num(r.sam_drift.de, 2)} · Rev g ${num(r.sam_drift.rev_g, 1)}% · EPS g ${num(r.sam_drift.eps_g, 1)}%` : ''}</div></div></div>`;
}
function eventsBlock(r) {
  const ev = [];
  if (isNum(r.ern) && r.ern >= 0) ev.push({d: r.er, t: `Earnings ${r.ert || ''}`, n: r.ern, tip: (r.ers || '') + '\nYahoo dates can be estimates'});
  for (const e of D.calendar || []) if (e.status !== 'released' && new Date(e.scheduled_et) > new Date()) ev.push({d: e.scheduled_et.slice(0, 10), t: e.type, n: Math.max(0, Math.round(daysTo(e.scheduled_et))), tip: e.title + '\n' + e.scheduled_et + '\n' + (e.source_url || '')});
  ev.sort((a, b) => a.d < b.d ? -1 : 1);
  return `<div class="blk"><div class="sech">Next events</div>${ev.slice(0, 8).map(e => `<div class="evl" data-tip="${esc(e.tip)}"><span>${esc(e.d)} ${esc(e.t)}</span><span class="dim">${e.n}d</span></div>`).join('')}</div>`;
}
function macroDetail(id) {
  const o = obsOf(id), t = D.tape.find(x => x.id === id);
  if (!o && !t) return `<div class="dh"><div class="big">${esc(id)}</div></div>`;
  if (!o) return `<div class="dh"><div class="big">${esc(t.label)} ${num(t.v, 2)}</div><div class="sub">${esc(t.src || '')}</div></div>${id === 'regime' ? regimeBlock() : ''}`;
  // most exposed tickers to the matching factor
  const fmap = {us10y: 'us10y_bps', dxy: 'dxy', wti: 'wti', vix: 'vix'};
  const f = fmap[id];
  let exp = '';
  if (f) {
    const top = D.rows.filter(r => r.rel && Math.abs(r.rel.t[f]) >= S.minT).sort((a, b) => a.rel.c[f] - b.rel.c[f]);
    const pick = top.slice(0, 5).concat(top.slice(-5).reverse());
    exp = `<div class="blk"><div class="sech">Most exposed <span class="dim">|t| ≥ ${S.minT}, ${esc(D.rel.units[f])}</span></div>${pick.map(r => `<div class="evl sr" data-t="${esc(r.t)}"><span>${esc(r.t)} <span class="dim">${esc(r.sec || '')}</span></span><span>${pct(r.rel.c[f], 3, '', '')} <span class="dim">t${r.rel.t[f]}</span></span></div>`).join('')}</div>`;
  }
  return `<div class="dh"><div class="big">${esc(o.label)}</div><div class="sub">${esc(o.provider)} · ${esc(o.series)} · <a href="${esc(o.url)}" target="_blank" rel="noopener" style="color:var(--fg2)">source</a></div></div>
   <div class="grid">${stat('Value', num(o.v, 2) + ' ' + esc(o.unit || ''))}${stat('Prior', num(o.prior, 2, 'no prior'))}${stat('Period', esc(o.period || '—'))}${stat('Status', esc(o.status))}${stat('Retrieved', esc((o.retrieved_at || '').slice(0, 16)))}${stat('Transform', esc(o.transform || 'level'))}</div>
   ${o.note ? `<div class="evl sub">${esc(o.note)}</div>` : ''}${exp}`;
}
function regimeBlock() {
  const g = D.rel.regime;
  return `<div class="blk"><div class="sech" data-tip="${esc(g.method)}">Components <span class="dim">tiers 30/50/70/85</span></div>${Object.entries(g.components).map(([k, c]) => `<div class="evl"><span>${k} <span class="dim">w${c.weight}</span></span><span>${c.score == null ? na(c.note || 'not available') : c.score}</span></div>`).join('')}</div>`;
}

/* ---------- selection / hash ---------- */
function select(kind, id, noHash) {
  V.sel = {kind, id};
  document.querySelectorAll('#tbody tr.sel').forEach(x => x.classList.remove('sel'));
  if (kind === 't') { const tr = document.querySelector(`#tbody tr[data-t="${CSS.escape(id)}"]`); if (tr) tr.classList.add('sel'); }
  renderTape();
  drawChart(); renderDetail();
  if (window.SmartOptionsLive && kind === 't' && document.body.classList.contains('bv-research')) window.SmartOptionsLive.watch('research', [id]);   // an opened name refreshes first
  if (!noHash) writeHash();
}
function step(dir) {
  const rows = [...document.querySelectorAll('#tbody tr[data-t]')]; if (!rows.length) return;
  const i = rows.findIndex(tr => tr.classList.contains('sel'));
  const n = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + dir))];
  select('t', n.dataset.t); n.scrollIntoView({block: 'nearest'});
}
function writeHash() {
  if (window.SmartOptionsBrief && !window.SmartOptionsBrief.isResearch()) return;   // Brief routes own the hash outside Research
  const sh =FACTORS.filter(f => S.shock[f]).map(f => `${f}:${S.shock[f]}`).join(',');
  const h = `${V.sel.kind}=${encodeURIComponent(V.sel.id)}&r=${V.range}${V.overlay ? '&ov=' + V.overlay : ''}${sh ? '&sc=' + sh : ''}${V.tab !== 'markets' ? '&tab=' + V.tab : ''}`;
  history.replaceState(null, '', '#' + h);
}
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get('t')) V.sel = {kind: 't', id: p.get('t')};
  else if (p.get('s')) V.sel = {kind: 's', id: p.get('s')};
  if (p.get('r')) V.range = p.get('r');
  if (p.get('ov') != null) V.overlay = p.get('ov');
  if (p.get('tab')) V.tab = p.get('tab');
  if (p.get('sc')) { for (const kv of p.get('sc').split(',')) { const [f, v] = kv.split(':'); if (FACTORS.includes(f) && isFinite(+v)) S.shock[f] = +v; } }
}

/* ---------- events ---------- */
function wire() {
  $('#tbody').addEventListener('click', e => {
    const tr = e.target.closest('tr[data-t]'); if (!tr) return;
    select('t', tr.dataset.t);
    if (window.innerWidth <= 820) $('#center').scrollIntoView({behavior: 'smooth', block: 'start'});
  });
  document.addEventListener('keydown', e => {
    if (e.target.matches('input,select,textarea')) return;
    if (window.SmartOptionsBrief && !window.SmartOptionsBrief.isResearch()) return;
    if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); step(-1); }
    else if (e.key === '/') { e.preventDefault(); e.stopImmediatePropagation(); $('#q').focus(); }   // '/' = search; chat opens from ASK
    else if (e.key === 'Escape') document.querySelectorAll('aside.drawer').forEach(x => { x.hidden = true; });
  });
  $('#thead').addEventListener('click', e => {
    const th = e.target.closest('th[data-k]'); if (!th || !th.dataset.k) return;
    const k = th.dataset.k; V.sort = {k, dir: V.sort.k === k ? -V.sort.dir : (k === 't' ? 1 : -1)}; renderTable();
  });
  $('#chips').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.clrSector) { V.sector = null; renderTable(); return; }
    V.preset = b.dataset.p; const p = PRESETS.find(x => x.id === V.preset); if (p && p.sort) V.sort = Object.assign({}, p.sort); renderTable();
  });
  $('#q').addEventListener('input', e => { V.q = e.target.value; renderTable(); });
  $('#tape').addEventListener('click', e => { const t = e.target.closest('.ti'); if (!t) return; const id = t.dataset.s; if (id === 'SPY') select('t', 'SPY'); else select('s', id); showTab('markets'); });
  $('#ranges').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; V.range = b.dataset.r; setRange(); writeHash(); });
  const eqOvs = D.rows.slice(0, 40).map(r => [r.t, r.t]);
  $('#overlay').innerHTML = OVERLAYS.concat(eqOvs.filter(([k]) => !OVERLAYS.some(([x]) => x === k))).map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  $('#overlay').value = V.overlay;
  $('#overlay').addEventListener('change', e => { V.overlay = e.target.value; if (rowOf(V.overlay) && V.cmpMode === 'dual') V.cmpMode = 'idx'; drawChart(); writeHash(); });
  $('#clegend').addEventListener('click', e => { const b = e.target.closest('[data-cmpmode]'); if (!b) return; V.cmpMode = b.dataset.cmpmode; drawChart(); });
  $('#signals').addEventListener('click', e => {
    const s = e.target.closest('[data-sig]'); if (!s) return; const g = D.signals[+s.dataset.sig];
    if (g.t) { select('t', g.t); if (g.factor) { const ov = {us10y_bps: 'us10y', dxy: 'dxy', wti: 'wti', vix: 'vix'}[g.factor]; if (ov) { V.overlay = ov; $('#overlay').value = ov; drawChart(); writeHash(); } } }
    else if (g.sid) select('s', g.sid);
  });
  $('#detail').addEventListener('click', e => { const s = e.target.closest('[data-t]'); if (s) select('t', s.dataset.t); });
  $('#tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); });
  $('#btnAbout').addEventListener('click', () => toggleDrawer('about'));
  $('#btnControls').addEventListener('click', () => toggleDrawer('controls'));
  // tooltip
  const tip = $('#tip');
  document.addEventListener('mouseover', e => {
    const t = e.target.closest('[data-tip]');
    if (!t || !t.dataset.tip) { tip.hidden = true; return; }
    tip.textContent = t.dataset.tip; tip.hidden = false;
  });
  document.addEventListener('mousemove', e => { if (tip.hidden) return; const w = tip.offsetWidth, h = tip.offsetHeight; tip.style.left = Math.min(window.innerWidth - w - 6, e.clientX + 12) + 'px'; tip.style.top = Math.min(window.innerHeight - h - 6, e.clientY + 14) + 'px'; });
}
function showTab(t) {
  V.tab = t;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  $('#pg-markets').hidden = t !== 'markets'; $('#pg-macro').hidden = t !== 'macro';
  if (t === 'macro' && window.SO2_macro) window.SO2_macro();
  writeHash();
}
function toggleDrawer(id, force) {
  const el = $('#' + id);
  document.querySelectorAll('aside.drawer').forEach(x => { if (x !== el) x.hidden = true; });
  el.hidden = force == null ? !el.hidden : !force;
  if (!el.hidden && window['SO2_' + id]) window['SO2_' + id](el);
}

/* ---------- boot + refresh ---------- */
function renderAll() { renderHeader(); renderTape(); renderTable(); renderSignals(); drawChart(); renderDetail(); if (window.SO2_layout) window.SO2_layout(); }
async function refresh() {
  if (document.visibilityState !== 'visible') return;
  try { const nd = await fetchJSON('data/core.json'); if (nd.exported_at !== D.exported_at) { D = nd; for (const k in pxCache) delete pxCache[k]; renderAll(); } } catch (e) { console.warn('refresh failed', e); }
}
async function boot() {
  try { D = await fetchJSON('data/core.json'); } catch (e) { document.body.insertAdjacentHTML('beforeend', `<div style="padding:20px">Data failed to load: ${esc(e)}</div>`); console.error(e); return; }
  const hp0 = new URLSearchParams(location.hash.slice(1));
  if (!hp0.get('r') && S.defRange) V.range = S.defRange;
  if (hp0.get('ov') == null && S.defOverlay) V.overlay = S.defOverlay;
  readHash();
  if (V.sel.kind === 't' && V.sel.id !== 'SPY' && !rowOf(V.sel.id)) V.sel = {kind: 't', id: 'SPY'};
  selfCheck();
  const priorSO2 = window.SO2 || {};   // keep modules that attached before this file (Live, MoneyFlow)
  window.SO2 = {...priorSO2, Live: window.SmartOptionsLive, D: () => D, S: () => S, V, renderTable, renderAll, renderDetail, select, save, scenarioImpact, FACTORS, FLABEL, SHOCK_U, DEFAULTS, filtered, num, pct, na, esc, spark, isNum, seriesData, obsOf, showTab,
    COLS, DEFAULT_COLS, activeCols, PRESETS, OVERLAYS, renderTape, drawChart, setRange, writeHash, toggleDrawer, rowOf, setS: x => { S = x; }, chartObj: () => chart};
  wire();
  renderAll();
  if (window.SmartOptionsLive) { window.SmartOptionsLive.paint(document); window.SmartOptionsLive.subscribe(() => window.SmartOptionsLive.paint(document)); }
  const op = new URLSearchParams(location.hash.slice(1)).get('open');
  showTab(V.tab);
  if (op === 'controls' || op === 'about') toggleDrawer(op);
  setInterval(refresh, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', refresh);
  if (window.SO2_init) try { window.SO2_init(); } catch (e) { console.error("custom init failed", e); }
  window.SO2_ready = true;
}
boot();
})();
