/* R8 Macro-cycle panel. G. Mundada's hierarchy is macro first ("economic cycles dominate returns"): Fed policy,
   fiscal policy, interest rates, inflation, employment, GDP. This panel classifies each from series ALREADY in
   data/core.json (macro groups, each with its own provenance + history) with documented rules; thresholds are shown and
   editable (localStorage 'so_cyc_v1'). Practitioner framing; measured association, not forecast. Missing stays missing.
   His own cycle charts are images in his files that we could not extract: nothing here claims to reproduce them. */
(function (root) {
'use strict';
const isNum = x => typeof x === 'number' && isFinite(x);
const LS_KEY = 'so_cyc_v1';
const LABEL = 'practitioner framing; measured association, not forecast';
const DEFAULTS = {
  policy_bp: 25,       // fed target move vs 12m / 3m ago that counts as easing/tightening (bp)
  rate_bp: 25,         // 10Y move vs 3m ago that counts as rising/falling (bp)
  curve_bp: 10,        // 2s10s change vs 3m ago that counts as steepening/flattening (bp)
  infl_pp: 0.3,        // 3m annualized vs 12m (YoY) gap that counts as accelerating/decelerating (pp)
  sahm_warn: 0.3, sahm_trig: 0.5,  // unemployment 3m avg minus prior-12m low of 3m avgs (Sahm rule, Claudia Sahm 2019)
  gdp_slow_pp: 0.5,    // latest GDP SAAR below its prior-4-quarter mean by this = slowing
  oas_bp: 25,          // HY OAS change vs 3m ago that counts as widening/tightening (bp)
  vix_low: 15, vix_elev: 20, vix_stress: 30,  // same bands as the Flow view (app/flow.js)
};
const TH_HELP = {policy_bp: 'Fed move counted (bp)', rate_bp: '10Y move vs 3m (bp)', curve_bp: '2s10s move vs 3m (bp)', infl_pp: 'inflation 3m ann vs YoY (pp)',
  sahm_warn: 'Sahm gap warning', sahm_trig: 'Sahm gap trigger', gdp_slow_pp: 'GDP slowing vs 4q mean (pp)', oas_bp: 'HY OAS move vs 3m (bp)', vix_low: 'VIX calm <', vix_elev: 'VIX elevated >=', vix_stress: 'VIX stress >='};
function loadTh() { try { const s = JSON.parse((root.localStorage && root.localStorage.getItem(LS_KEY)) || 'null'); return Object.assign({}, DEFAULTS, s && s.th || {}); } catch (e) { return Object.assign({}, DEFAULTS); } }
function saveTh(th) { try { root.localStorage && root.localStorage.setItem(LS_KEY, JSON.stringify({th})); } catch (e) { /* storage blocked */ } }

const r2 = v => isNum(v) ? Math.round(v * 100) / 100 : null;
const mean = a => { const v = a.filter(isNum); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
function obsMap(core) { const m = {}; const g = core && core.macro || {}; for (const k in g) for (const o of g[k] || []) m[o.id] = o; return m; }
const hv = o => (o && Array.isArray(o.h) ? o.h : []).filter(p => p && isNum(p[1]));
function ago(o, n) { // value ~n sessions back, located by DATE (n sessions ~ n*365/252 calendar days) so daily-with-weekends histories are not misread
  const h = hv(o); if (!h.length) return null;
  const t = new Date(h[h.length - 1][0] + 'T00:00:00Z').getTime() - Math.round(n * 365 / 252) * 864e5;
  if (new Date(h[0][0] + 'T00:00:00Z').getTime() > t + 7 * 864e5) return null; // history does not reach back that far
  let best = null; for (const p of h) { if (new Date(p[0] + 'T00:00:00Z').getTime() <= t) best = p; else break; } return best || h[0];
}
function cite(o, extra) { return o ? Object.assign({id: o.id, label: o.label, value: r2(o.v), unit: o.unit, period: o.period, status: o.status, provider: o.provider, series: o.series, url: o.url}, extra || {}) : null; }
function missing(name, why) { return {pillar: name, phase: 'missing', direction: null, reason: why, inputs: [], rule: null}; }
const quad = (good, improving) => good ? (improving ? 'expanding' : 'peaking') : (improving ? 'troughing' : 'contracting');

function policy(m, th) {
  const o = m.fed_target_upper; if (!o || !isNum(o.v)) return missing('Fed policy', 'fed_target_upper not in data');
  const ff = m.effective_fed_funds, pc = m.pce_core;
  let src = o, y = ago(o, 252); const q = ago(o, 63);
  if (!y && ff && isNum(ff.v)) { src = ff; y = ago(ff, 252); } // target history stored < 12m: 12m change from the effective rate instead (labeled)
  if (!y) return missing('Fed policy', 'less than 12 months of policy-rate history stored');
  const d12 = (src.v - y[1]) * 100, d3 = q ? (o.v - q[1]) * 100 : null;
  let dir = d12 <= -th.policy_bp ? 'easing' : d12 >= th.policy_bp ? 'tightening' : 'on hold';
  if (isNum(d3) && d3 >= th.policy_bp) dir = 'tightening'; else if (isNum(d3) && d3 <= -th.policy_bp) dir = 'easing'; // a target move in the last 3m overrides the 12m read
  const recent = isNum(d3) ? (d3 <= -th.policy_bp ? 'cut in last 3m' : d3 >= th.policy_bp ? 'hiked in last 3m' : 'no move in last 3m') : '3m history missing';
  const real = ff && pc && isNum(ff.v) && isNum(pc.v) ? ff.v - pc.v : null;
  return {pillar: 'Fed policy', phase: dir, direction: dir === 'easing' ? 'falling' : dir === 'tightening' ? 'rising' : 'flat',
    reason: `Target upper ${r2(o.v)}%; ${src === o ? 'target' : 'effective fed funds'} ${r2(src.v)}% vs ${r2(y[1])}% on ${y[0]} (${d12 > 0 ? '+' : ''}${Math.round(d12)} bp in 12m${src === o ? '' : '; target history stored only from ' + hv(o)[0][0]}); ${recent}${isNum(real) ? `; real policy rate (effective funds minus core PCE YoY) ${r2(real)}%` : ''}.`,
    rule: `12m change in the target upper bound (effective fed funds if under 12m of target history is stored): <= -${th.policy_bp} bp easing, >= +${th.policy_bp} bp tightening, else on hold; a target move of that size in the last 3m overrides the 12m read`,
    inputs: [cite(o), cite(src, {vs: y[1], vs_date: y[0]}), pc && cite(pc)].filter((v, i, a) => v && a.findIndex(z => z && z.id === v.id) === i).filter(Boolean)};
}
function fiscal() { return missing('Fiscal policy', 'no fiscal series (deficit, outlays, Treasury issuance) in this build; not inferred'); }
function rates(m, th) {
  const t = m.us10y, s = m.spread_10y_2y, t2 = m.us2y;
  if (!t || !isNum(t.v)) return missing('Interest rates', 'us10y not in data');
  const q = ago(t, 63), y = ago(t, 252); if (!q) return missing('Interest rates', 'less than 3 months of 10Y history');
  const d3 = (t.v - q[1]) * 100, dir = d3 >= th.rate_bp ? 'rising' : d3 <= -th.rate_bp ? 'falling' : 'flat';
  let curve = null, cphase = 'missing';
  if (s && isNum(s.v)) {
    const sq = ago(s, 63), t2q = t2 && ago(t2, 63);
    if (sq) {
      const ds = s.v - sq[1], lvl = mean([d3, t2q && isNum(t2.v) ? (t2.v - t2q[1]) * 100 : null]);
      const steep = ds >= th.curve_bp, flat = ds <= -th.curve_bp, bull = isNum(lvl) && lvl < 0;
      cphase = s.v < 0 ? 'inverted' : steep ? (bull ? 'bull steepening' : 'bear steepening') : flat ? (bull ? 'bull flattening' : 'bear flattening') : 'stable';
      if (s.v < 0 && (steep || flat)) cphase = 'inverted, ' + (steep ? 'steepening' : 'flattening');
      curve = {spread_bp: r2(s.v), chg_3m_bp: r2(ds), phase: cphase};
    }
  }
  return {pillar: 'Interest rates', phase: dir, direction: dir,
    reason: `10Y ${r2(t.v)}% vs ${r2(q[1])}% 3m ago (${d3 > 0 ? '+' : ''}${Math.round(d3)} bp)${y ? ` and ${r2(y[1])}% 12m ago` : ''}; 2s10s ${curve ? curve.spread_bp + ' bp, ' + (curve.chg_3m_bp > 0 ? '+' : '') + curve.chg_3m_bp + ' bp in 3m: ' + cphase : 'missing'}.`,
    rule: `10Y vs ~63 sessions ago: >= +${th.rate_bp} bp rising, <= -${th.rate_bp} bp falling; curve: 2s10s change vs 3m >= ${th.curve_bp} bp steepening / <= -${th.curve_bp} flattening, bull if 2Y+10Y average moved down, bear if up; below 0 = inverted`,
    curve, inputs: [cite(t, {vs_3m: q[1], vs_3m_date: q[0]}), s && cite(s), t2 && cite(t2)].filter(Boolean)};
}
function ann3(momObs) { const h = hv(momObs).slice(-3); if (h.length < 3) return null; return (h.reduce((p, x) => p * (1 + x[1] / 100), 1) ** 4 - 1) * 100; }
function inflation(m, th) {
  const pairs = [['cpi_core', 'cpi_core_mom', 'Core CPI'], ['pce_core', 'pce_core_mom', 'Core PCE'], ['cpi_headline', 'cpi_headline_mom', 'CPI']];
  const rows = [];
  for (const [y, mo, nm] of pairs) { const Y = m[y], M = m[mo]; if (!Y || !isNum(Y.v) || !M) continue; const a = ann3(M); if (!isNum(a)) continue; rows.push({nm, yoy: Y.v, a3: a, gap: a - Y.v, Y, M}); }
  if (!rows.length) return missing('Inflation', 'no CPI/PCE YoY + MoM pairs with 3 months of history');
  const core = rows.filter(r => r.nm !== 'CPI'), use = core.length ? core : rows, g = mean(use.map(r => r.gap));
  const dir = g >= th.infl_pp ? 'accelerating' : g <= -th.infl_pp ? 'decelerating' : 'steady';
  return {pillar: 'Inflation', phase: dir, direction: dir === 'accelerating' ? 'rising' : dir === 'decelerating' ? 'falling' : 'flat',
    reason: rows.map(r => `${r.nm} 3m annualized ${r2(r.a3)}% vs ${r2(r.yoy)}% YoY (${r.Y.period})`).join('; ') + (use.some(r => r.gap >= th.infl_pp) && use.some(r => r.gap <= -th.infl_pp) ? '; core measures DISAGREE, so the average reads ' + dir : '') + '.',
    rule: `3-month annualized (compounded last 3 MoM) minus 12-month YoY, averaged over the core measures: >= +${th.infl_pp} pp accelerating, <= -${th.infl_pp} pp decelerating`,
    inputs: rows.flatMap(r => [cite(r.Y), cite(r.M, {ann_3m: r2(r.a3)})])};
}
function employment(m, th) {
  const u = m.unemployment, p = m.payrolls;
  if (!u || hv(u).length < 15) return missing('Employment', 'unemployment history under 15 months');
  const h = hv(u).map(x => x[1]), a3 = []; for (let i = 2; i < h.length; i++) a3.push((h[i] + h[i - 1] + h[i - 2]) / 3);
  const cur = a3[a3.length - 1], low = Math.min(...a3.slice(-13, -1)), sahm = cur - low;
  const ph = hv(p).map(x => x[1]), p3 = ph.length >= 3 ? mean(ph.slice(-3)) : null, p12 = ph.length >= 12 ? mean(ph.slice(-12)) : null;
  const good = sahm < th.sahm_warn && (!isNum(p3) || p3 > 0);
  const improving = isNum(p3) && isNum(p12) ? p3 >= p12 : sahm <= 0;
  let ph_ = quad(good, improving); if (sahm >= th.sahm_trig) ph_ = improving ? 'troughing' : 'contracting';
  return {pillar: 'Employment', phase: ph_, direction: improving ? 'improving' : 'softening',
    reason: `Unemployment ${r2(u.v)}% (${u.period}); Sahm gap ${r2(sahm)} pp (trigger ${th.sahm_trig}); payrolls ${isNum(p3) ? 'avg ' + Math.round(p3) + 'k/month over 3m vs ' + (isNum(p12) ? Math.round(p12) + 'k over 12m' : '12m missing') : 'missing'}.`,
    rule: `level good = Sahm gap < ${th.sahm_warn} and 3m avg payrolls > 0; improving = 3m avg payrolls >= 12m avg; quadrant: good+improving expanding, good+softening peaking, weak+softening contracting, weak+improving troughing; Sahm gap >= ${th.sahm_trig} forces contracting/troughing`,
    inputs: [cite(u, {sahm_gap: r2(sahm)}), p && cite(p, {avg3m: r2(p3), avg12m: r2(p12)})].filter(Boolean)};
}
function gdp(m, th) {
  const g = m.real_gdp_saar, h = hv(g);
  if (h.length < 5) return missing('GDP', 'fewer than 5 quarters of real GDP growth');
  const v = h[h.length - 1][1], prior = mean(h.slice(-5, -1).map(x => x[1])), prev = h[h.length - 2][1];
  const good = v >= 0, improving = v >= prior - th.gdp_slow_pp && !(prev < 0 && v < prev);
  const phase = good && prev < 0 ? 'troughing' : quad(good, improving);
  return {pillar: 'GDP', phase, direction: v > prior ? 'accelerating' : v < prior - th.gdp_slow_pp ? 'slowing' : 'steady',
    reason: `Real GDP ${r2(v)}% SAAR in ${g.period} vs ${r2(prior)}% average of the prior 4 quarters (previous ${r2(prev)}%).`,
    rule: `quadrant on latest real GDP SAAR: >= 0 = growing; improving unless it is ${th.gdp_slow_pp} pp below its prior-4-quarter mean; first positive quarter after a negative = troughing`,
    inputs: [cite(g, {prior4_mean: r2(prior)})]};
}
function credit(m, th) {
  const o = m.hy_oas; if (!o || !isNum(o.v)) return missing('Credit spread', 'hy_oas not in data');
  const q = ago(o, 63); if (!q) return missing('Credit spread', 'under 3 months of HY OAS history');
  const d = o.v - q[1], hist = hv(o).map(x => x[1]), pct = 100 * hist.filter(x => x <= o.v).length / hist.length;
  const dir = d >= th.oas_bp ? 'widening' : d <= -th.oas_bp ? 'tightening' : 'stable';
  return {pillar: 'Credit spread', phase: dir, direction: dir, reason: `HY OAS ${r2(o.v)} bp vs ${r2(q[1])} bp 3m ago; ${Math.round(pct)}th percentile of the stored ${hist.length} sessions.`,
    rule: `HY OAS change vs ~63 sessions ago: >= +${th.oas_bp} bp widening (stress building), <= -${th.oas_bp} tightening`, inputs: [cite(o, {vs_3m: q[1], pctile: Math.round(pct)})]};
}
function vol(m, th) {
  const o = m.vix; if (!o || !isNum(o.v)) return missing('Volatility (VIX)', 'vix not in data');
  const h = hv(o).map(x => x[1]), a20 = mean(h.slice(-20)), a63 = mean(h.slice(-63));
  const band = o.v >= th.vix_stress ? 'stress' : o.v >= th.vix_elev ? 'elevated' : o.v < th.vix_low ? 'calm' : 'normal';
  return {pillar: 'Volatility (VIX)', phase: band, direction: isNum(a20) && isNum(a63) ? (a20 > a63 * 1.05 ? 'rising' : a20 < a63 * 0.95 ? 'falling' : 'flat') : null,
    reason: `VIX ${r2(o.v)} (${o.period}); 20-session avg ${r2(a20)} vs 63-session avg ${r2(a63)}.`,
    rule: `bands: < ${th.vix_low} calm, < ${th.vix_elev} normal, >= ${th.vix_elev} elevated, >= ${th.vix_stress} stress (same as Flow); trend = 20d avg vs 63d avg +/-5%`, inputs: [cite(o)]};
}

/* state(core, th) -> {label, asof, pillars:[6 core + 2 context], overall:{phase, reason, inputs}, timeline} */
function state(core, th) {
  th = Object.assign({}, DEFAULTS, th || {});
  const m = obsMap(core);
  const six = [policy(m, th), fiscal(), rates(m, th), inflation(m, th), employment(m, th), gdp(m, th)];
  const ctx = [credit(m, th), vol(m, th)];
  const act = [six[4], six[5]].filter(p => p.phase !== 'missing');
  let phase = 'unavailable', why = 'employment and GDP both missing';
  if (act.length === 2 && act[0].phase === act[1].phase) { phase = act[0].phase; why = `employment and GDP both read ${phase}`; }
  else if (act.length === 2) { phase = 'mixed'; why = `employment reads ${act[0].phase}, GDP reads ${act[1].phase}`; }
  else if (act.length === 1) { phase = act[0].phase; why = `${act[0].pillar} only (${act[0].phase}); the other is missing`; }
  const tilt = [six[0].phase === 'easing' ? 'policy easing' : six[0].phase === 'tightening' ? 'policy tightening' : six[0].phase === 'on hold' ? 'policy on hold' : null,
    six[3].phase !== 'missing' ? 'inflation ' + six[3].phase : null, six[2].phase !== 'missing' ? '10Y ' + six[2].phase : null,
    ctx[0].phase !== 'missing' ? 'credit ' + ctx[0].phase : null, ctx[1].phase !== 'missing' ? 'VIX ' + ctx[1].phase : null].filter(Boolean);
  const rel = core && core.rel || {};
  return {label: LABEL, asof: core && (core.asof_session || core.date) || null, thresholds: th,
    overall: {phase, reason: `Cycle read: ${phase} (${why}); context: ${tilt.join(', ') || 'none'}. Overall rule: the activity pair (employment, GDP) sets the phase when they agree; otherwise "mixed".`},
    pillars: six, context: ctx, missing: six.concat(ctx).filter(p => p.phase === 'missing').map(p => p.pillar + ': ' + p.reason),
    timeline: {series: rel.regime_hist || [], what: "Historical regime score history (partial; " + ((rel.regime && rel.regime.history_note) || 'see methods') + ')', today: rel.regime ? {score: rel.regime.score, tier: rel.regime.tier} : null},
    note: "G. Mundada's own cycle charts are images in his shared files and could not be extracted; this panel does not reproduce them."};
}

/* ---------------- UI ---------------- */
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));
const PH = {expanding: 'cy-up', troughing: 'cy-up2', peaking: 'cy-warn', contracting: 'cy-dn', easing: 'cy-up', tightening: 'cy-dn', 'on hold': 'cy-neu', missing: 'cy-na', mixed: 'cy-warn'};
function strip(tl) {
  const s = tl.series.filter(p => isNum(p[1])); if (!s.length) return '<div class="cy-na">regime history missing</div>';
  const w = 100 / s.length;
  return `<svg class="cy-strip" viewBox="0 0 100 20" preserveAspectRatio="none" role="img" aria-label="regime score history">${s.map((p, i) => `<rect x="${(i * w).toFixed(2)}" y="${(20 - p[1] / 5).toFixed(2)}" width="${(w * 0.85).toFixed(2)}" height="${(p[1] / 5).toFixed(2)}" fill="hsl(${Math.round(p[1] * 1.2)},55%,45%)"><title>${esc(p[0])}: ${p[1]}</title></rect>`).join('')}</svg>
    <div class="cy-sl"><span>${esc(s[0][0])}</span><span>${esc(tl.what)}${tl.today ? ' &middot; today ' + tl.today.score + ' ' + esc(tl.today.tier) : ''}</span><span>${esc(s[s.length - 1][0])}</span></div>`;
}
let open = false, showRules = false;
function html(st) {
  const card = p => `<div class="cy-card ${PH[p.phase] || 'cy-neu'}" title="${esc(p.rule || p.reason)}"><div class="cy-p">${esc(p.pillar)}</div><div class="cy-ph">${esc(p.phase)}${p.direction && p.direction !== p.phase ? ' <small>' + esc(p.direction) + '</small>' : ''}</div>${open ? `<div class="cy-r">${esc(p.reason)}</div>${p.rule ? '<div class="cy-rule">Rule: ' + esc(p.rule) + '</div>' : ''}${p.inputs.length ? '<div class="cy-in">' + p.inputs.map(i => `<a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.label)}</a> ${esc(i.value)} ${esc(i.unit || '')} (${esc(i.period)}, ${esc(i.status)})`).join('<br>') + '</div>' : ''}` : ''}</div>`;
  return `<div class="cy-head"><b>Cycle dashboard</b> <span class="cy-lab">${esc(st.label)}</span>
    <span class="cy-i" title="${esc(st.note + ' Hierarchy per G. Mundada (individual investor, not an advisor): macro first - Fed policy, fiscal policy, interest rates, inflation, employment, GDP. Each classification is a documented rule over series already in this dashboard; hover a card for its rule.')}">i</span>
    <button data-cy="open">${open ? 'Hide inputs' : 'Show inputs + rules'}</button><button data-cy="th">Thresholds</button></div>
    <div class="cy-overall ${PH[st.overall.phase] || 'cy-neu'}">${esc(st.overall.reason)}</div>
    <div class="cy-grid">${st.pillars.map(card).join('')}${st.context.map(card).join('')}</div>
    ${showRules ? `<div class="cy-th">${Object.keys(DEFAULTS).map(k => `<label>${esc(TH_HELP[k] || k)} <input type="number" step="any" data-cyth="${k}" value="${esc(st.thresholds[k])}"></label>`).join('')} <button data-cy="reset">Reset</button></div>` : ''}
    <div class="cy-tl">${strip(st.timeline)}</div>`;
}
function current() { const c = root.SO2 && root.SO2.D ? root.SO2.D() : null; return state(c, loadTh()); }
function mount(el) { el.innerHTML = html(current()); }
function mountUI() {
  const wrap = document.querySelector('#pg-macro .mgrid-wrap'); if (!wrap || document.getElementById('cy-panel')) return;
  const el = document.createElement('div'); el.id = 'cy-panel'; el.className = 'cy-panel'; wrap.prepend(el); mount(el);
  el.addEventListener('click', e => { const b = e.target.closest('[data-cy]'); if (!b) return; const a = b.dataset.cy;
    if (a === 'open') open = !open; if (a === 'th') showRules = !showRules; if (a === 'reset') saveTh(Object.assign({}, DEFAULTS)); mount(el); });
  el.addEventListener('change', e => { const x = e.target; if (x.dataset.cyth) { const th = loadTh(), v = parseFloat(x.value); if (isFinite(v)) { th[x.dataset.cyth] = v; saveTh(th); } mount(el); } });
}
function register() {
  const A = root.SmartOptionsAPI; if (!A) return false;
  A.cycle_state = () => { const s = current(); return {label: s.label, asof: s.asof, overall: s.overall, pillars: s.pillars.concat(s.context).map(p => ({pillar: p.pillar, phase: p.phase, direction: p.direction, reason: p.reason, rule: p.rule, inputs: p.inputs})), missing: s.missing, note: s.note}; };
  return true;
}
const API = {DEFAULTS, LS_KEY, LABEL, state, loadTh, saveTh, mount, html, current: () => current()};
if (typeof module !== 'undefined' && module.exports) module.exports = API;
root.SmartOptionsCycles = API;
if (typeof document !== 'undefined') {
  const boot = () => { let n = 0; const t = setInterval(() => { if (root.SO2 && root.SO2.D && root.SO2.D() && document.querySelector('#pg-macro .mgrid-wrap')) { mountUI(); clearInterval(t); } else if (++n > 200) clearInterval(t); }, 50); if (!register()) root.addEventListener('load', register); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
}
})(typeof window !== 'undefined' ? window : globalThis);
