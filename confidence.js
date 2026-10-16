/* R8 model confidence + the WHY behind it. The reason text is the product: every number below is built from named
   inputs (value, rule, as-of) and explain(ticker) returns them all. Label, verbatim:
   "model confidence: agreement and data quality, NOT probability of profit".
   Score 0-100 = fixed documented weights over five components (constants, not tuned):
   agreement 0.30, statistical strength 0.15, data completeness/freshness 0.20, regime fit 0.20, event risk 0.15.
   Sam's own scores (SmartOptions snapshot 2026-07-25) are shown BESIDE this, never merged into it. */
(function (root) {
'use strict';
const isNum = x => typeof x === 'number' && isFinite(x);
const LABEL = 'model confidence: agreement and data quality, NOT probability of profit';
const WEIGHTS = {agreement: 0.30, stats: 0.15, data: 0.20, regime: 0.20, events: 0.15};
const NAMES = {agreement: 'Signal agreement', stats: 'Statistical strength', data: 'Data completeness + freshness', regime: 'Regime fit', events: 'Event risk'};
const r1 = v => isNum(v) ? Math.round(v * 10) / 10 : null;
const clamp = v => Math.max(0, Math.min(100, v));
const SAM_Q = {GREAT: 1, GOOD: 1, OK: 0, WEAK: -1, AVOID: -1};
// Sam's regime tiers (his vocabulary): how well each suits a long (bullish) or short (bearish) lean; neutral leans score the middle
const REGIME_FIT = {OPTIMAL: 100, FAVORABLE: 85, NORMAL: 60, DEFENSIVE: 30, AVOID: 10};

/* inputs: {ticker, row (core row), tech (SmartOptionsTech.analyze result or null), patterns (SmartOptionsPatterns scan result or null),
   flow ({word, sum, n} or null), regime ({score, tier} or null), cycle ({phase} or null), events ([{type, date}] next 30d), asof} */
function compute(inp) {
  const row = inp.row || {}, comp = {};
  // (a) agreement: each directional signal is one vote
  const votes = [];
  if (inp.tech && inp.tech.rows) for (const r of inp.tech.rows) if (r.signal === 'bullish' || r.signal === 'bearish') votes.push({name: 'Technical: ' + r.label, value: r.text, dir: r.signal === 'bullish' ? 1 : -1, rule: r.rule, asof: inp.tech.asof});
  if (inp.patterns && inp.patterns.detections) for (const d of inp.patterns.detections) if (d.state === 'confirmed' && !d.lagging && (d.direction === 'bull' || d.direction === 'bear')) votes.push({name: 'Pattern: ' + d.pattern, value: d.plain, dir: d.direction === 'bull' ? 1 : -1, rule: d.rule + ' (' + d.source + ')', asof: inp.patterns.asof});
  if (inp.flow && (inp.flow.word === 'STRONG' || inp.flow.word === 'WEAK')) votes.push({name: 'Flow name verdict', value: inp.flow.word + ' (vote sum ' + inp.flow.sum + ' of ' + inp.flow.n + ')', dir: inp.flow.word === 'STRONG' ? 1 : -1, rule: 'Flow step 3 documented rule (app/flow.js)', asof: inp.asof});
  if (isNum(row.up)) votes.push({name: 'Fundamental: analyst mean target upside', value: r1(row.up) + '%', dir: row.up > 0 ? 1 : row.up < 0 ? -1 : 0, rule: 'positive upside = bullish vote (Yahoo analyst mean target vs price; not a consensus forecast we verified)', asof: inp.asof});
  const samStaleQuarantine = Boolean(row.sam_drift || (row.sam && row.sam.asof && inp.asof && Math.abs(Date.parse(inp.asof) - Date.parse(row.sam.asof)) > 30 * 864e5)) && !inp.includeStaleSamVote;
  if (row.sam && SAM_Q[row.sam.q] != null && SAM_Q[row.sam.q] !== 0 && !samStaleQuarantine) votes.push({name: "Fundamental: Sam's quality tier", value: row.sam.q + ' (' + (row.sam.label || 'SmartOptions snapshot 2026-07-25') + ')', dir: SAM_Q[row.sam.q], rule: 'GREAT/GOOD = bullish vote, WEAK/AVOID = bearish; his tier, read-only', asof: row.sam.asof || null});
  if (isNum(row.res20d) && Math.abs(row.res20d) >= 3.0) votes.push({name: 'Macro-adjusted 20d idiosyncratic residual', value: (row.res20d > 0 ? '+' : '') + r1(row.res20d) + '%', dir: row.res20d > 0 ? 1 : -1, rule: '20d cumulative return minus 5-factor OLS explained move (>= +3% bullish, <= -3% bearish)', asof: inp.asof});
  const bull = votes.filter(v => v.dir > 0).length, bear = votes.filter(v => v.dir < 0).length, tot = bull + bear;
  const dir = bull > bear ? 'bullish' : bear > bull ? 'bearish' : 'neutral';
  const agreeRaw = tot ? Math.abs(bull - bear) / tot * 100 : 0, agree = tot >= 3 ? agreeRaw : agreeRaw * tot / 3;
  comp.agreement = {score: agree, reasons: votes.map(v => ({name: v.name, value: v.value + (v.dir > 0 ? ' -> bullish' : v.dir < 0 ? ' -> bearish' : ''), rule: v.rule, asof: v.asof})),
    rule: '|bullish - bearish| / all directional votes x 100; scaled down when fewer than 3 votes', summary: `${bull} bullish vs ${bear} bearish of ${tot} directional signals`};
  // (b) statistical strength of the macro sensitivities
  const rel = row.rel;
  if (rel && rel.t && isNum(rel.r2)) {
    const ts = Object.entries(rel.t).filter(([, v]) => isNum(v)), top = ts.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
    const n = isNum(rel.n) ? rel.n : 0, s = (50 * Math.min(Math.abs(top ? top[1] : 0) / 4, 1) + 50 * Math.min(rel.r2 / 0.5, 1)) * Math.min(1, n / 252);
    comp.stats = {score: s, reasons: [{name: 'Strongest factor |t|', value: top ? top[0] + ' t=' + top[1] : 'n/a', rule: '|t| 4+ = full half-credit', asof: inp.asof}, {name: 'R-squared', value: rel.r2, rule: 'R2 0.5+ = full half-credit', asof: inp.asof}, {name: 'Sessions in the regression', value: n, rule: 'scaled by n/252', asof: inp.asof}],
      rule: '50 x min(|t|max/4,1) + 50 x min(R2/0.5,1), x min(1, n/252); OLS on SPY, 10Y, DXY, WTI, VIX daily changes (association, not causation)', summary: `top |t| ${top ? Math.abs(top[1]) : 'n/a'}, R2 ${rel.r2}, n ${n}`};
  } else comp.stats = {score: 0, reasons: [{name: 'Macro sensitivity regression', value: 'missing', rule: 'no OLS result for this ticker', asof: null}], rule: 'missing regression = 0', summary: 'regression missing'};
  // (c) data completeness + freshness
  const st = row.st || {}, keys = Object.keys(st), bad = keys.filter(k => st[k] !== 'ok');
  const nb = inp.patterns && isNum(inp.patterns.n) ? inp.patterns.n : (inp.tech && isNum(inp.tech.n) ? inp.tech.n : 0);
  const dataS = keys.length ? (100 * (keys.length - bad.length) / keys.length) * (nb >= 200 ? 1 : nb >= 60 ? 0.8 : 0.5) : 0;
  comp.data = {score: dataS, reasons: bad.map(k => ({name: k, value: st[k], rule: 'any status other than ok subtracts', asof: inp.asof})).concat([{name: 'Daily bars stored', value: nb, rule: '>= 200 full, 60-199 x0.8, < 60 x0.5', asof: inp.asof}]),
    rule: 'share of fields with status ok x history factor', summary: keys.length ? `${keys.length - bad.length}/${keys.length} fields ok${bad.length ? ' (not ok: ' + bad.join(', ') + ')' : ''}, ${nb} bars` : 'no field statuses'};
  // (d) regime fit
  const reg = inp.regime, base = reg && REGIME_FIT[reg.tier];
  let regS = isNum(base) ? (dir === 'bearish' ? 110 - base : dir === 'neutral' ? 100 - Math.abs(base - 55) : base) : 0;
  const cyc = inp.cycle && inp.cycle.phase;
  if (cyc === 'contracting' && dir === 'bullish') regS -= 15; if (cyc === 'expanding' && dir === 'bearish') regS -= 15;
  comp.regime = {score: clamp(regS), reasons: [{name: "Market regime (Sam's tiers)", value: reg ? reg.tier + ' (' + reg.score + ')' : 'missing', rule: 'OPTIMAL 100, FAVORABLE 85, NORMAL 60, DEFENSIVE 30, AVOID 10 for a bullish lean; mirrored for bearish', asof: inp.asof},
    {name: 'Macro cycle read', value: cyc || 'missing', rule: '-15 when the lean fights the cycle (bullish in contracting, bearish in expanding)', asof: inp.asof}],
    rule: 'does the lean suit the current market regime and macro cycle', summary: `${dir} lean in a ${reg ? reg.tier : 'unknown'} regime, cycle ${cyc || 'unknown'}`};
  // (e) event risk inside a 30-day horizon
  let ev = 100; const er = [];
  if (isNum(row.ern) && row.ern >= 0) { const p = row.ern <= 7 ? 60 : row.ern <= 30 ? 30 : 0; ev -= p; er.push({name: 'Earnings', value: (row.er || '') + ' (in ' + row.ern + ' days)', rule: '<= 7 days -60, <= 30 days -30', asof: inp.asof}); }
  else er.push({name: 'Earnings', value: 'date missing', rule: 'unknown date -20', asof: inp.asof}), ev -= 20;
  for (const e of inp.events || []) { const p = e.days <= 7 ? 20 : 10; ev -= p; er.push({name: e.type, value: e.date + ' (in ' + e.days + ' days)', rule: 'FOMC/CPI/NFP inside 7 days -20, inside 30 days -10', asof: inp.asof}); }
  comp.events = {score: clamp(ev), reasons: er, rule: 'start 100, subtract for scheduled events inside the 30-day horizon', summary: er.map(x => x.name + ' ' + x.value).join('; ')};
  let score = 0; for (const k in WEIGHTS) score += WEIGHTS[k] * clamp(comp[k].score);
  score = Math.round(score);
  const sam = row.sam ? {opportunity: row.sam.opp, quality: row.sam.q, trend: row.sam.trend, risk: row.sam.risk, flags: row.sam.flags, drift_px: row.sam_drift ? row.sam_drift.px_pct : null, drift_pef: row.sam_drift ? row.sam_drift.pef_chg : null, label: row.sam.label || 'SmartOptions snapshot 2026-07-25'} : null;
  const comps = Object.keys(WEIGHTS).map(k => ({key: k, label: NAMES[k], weight: WEIGHTS[k], score: Math.round(clamp(comp[k].score)), summary: comp[k].summary, rule: comp[k].rule, reasons: comp[k].reasons}));
  const weakest = comps.slice().sort((a, b) => a.score - b.score)[0];
  const headline = `${score}/100, ${dir} lean: ${comp.agreement.summary}; ${comp.data.summary}; ${comp.regime.summary}; ${comp.events.summary || 'no scheduled events'}. Weakest part: ${weakest.label.toLowerCase()} (${weakest.score}).`;
  return {ticker: inp.ticker, score, direction: dir, headline, label: LABEL, components: comps, sam, asof: inp.asof,
    method: 'weighted blend, fixed weights ' + Object.entries(WEIGHTS).map(([k, w]) => NAMES[k] + ' ' + w).join(', ')};
}
function rank(results) { return results.filter(r => r && isNum(r.score)).slice().sort((a, b) => b.score - a.score || String(a.ticker).localeCompare(String(b.ticker))); }

/* ---------------- browser wiring (data from the other modules; nothing fetched that they do not already fetch) ---------------- */
const cache = {};
const core = () => { try { return root.SO2 && root.SO2.D ? root.SO2.D() : null; } catch (e) { return null; } };
function flowWord(t) { try { if(root.SO2_flow && root.SO2_flow.companyVerdict)return root.SO2_flow.companyVerdict(t); const M = root.SO2_flow && root.SO2_flow.compute && root.SO2_flow.compute(); const x = M && M.rows && M.rows.find(z => z.r.t === t); return x ? x.nv : null; } catch (e) { return null; } }
function events(D) {
  const now = Date.parse((D && D.asof_session || '') + 'T12:00:00Z') || Date.now(), out = [];
  for (const e of (D && D.calendar) || []) { if (!/FOMC|CPI|NFP/.test(e.type || '')) continue; const t = Date.parse(e.scheduled_et || ''); if (!isFinite(t)) continue; const days = Math.ceil((t - now) / 864e5); if (days >= 0 && days <= 30) out.push({type: e.type, date: String(e.scheduled_et).slice(0, 10), days}); }
  return out;
}
async function score(t) {
  t = String(t || '').toUpperCase(); const D = core(); if (!D) throw new Error('dashboard data not loaded');
  const row = (D.rows || []).find(r => r.t === t); if (!row) throw new Error(t + ' is not in the dashboard universe');
  const P = root.SmartOptionsPatterns, T = root.SmartOptionsTech, pat = P ? await P.scan(t) : null;
  let tech = null; try { if (T && P) { const px = await P.getPx(t); tech = T.analyze(px.bars, {th: T.loadThresholds()}); } } catch (e) { tech = null; }
  const cyc = root.SmartOptionsCycles ? root.SmartOptionsCycles.current().overall : null;
  cache[t] = compute({ticker: t, row, tech, patterns: pat, flow: flowWord(t), regime: D.rel && D.rel.regime, cycle: cyc, events: events(D), asof: D.asof_session});
  return cache[t];
}
const scoreSync = t => cache[String(t || '').toUpperCase()] || null;
async function rankList(list) { const out = []; for (const t of list) { try { out.push(await score(t)); } catch (e) { /* not in universe: skipped and reported below */ } } return rank(out); }
async function explain(t) { const r = await score(t); return {ticker: r.ticker, score: r.score, direction: r.direction, why: r.headline, label: r.label, method: r.method, components: r.components, sam_beside_not_merged: r.sam, asof: r.asof}; }

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));
function boxHtml(r, open) {
  const seg = r.components.map(c => `<span class="cf-seg" style="--w:${c.weight * 100}%;--f:${c.score}%" title="${esc(c.label)}: ${c.score}/100 x weight ${c.weight}"><i></i></span>`).join('');
  return `<div class="cf-top"><b class="cf-n">${r.score}</b><span class="cf-d cf-${r.direction}">${esc(r.direction)} lean</span><span class="cf-bar">${seg}</span><button data-cf="why">${open ? 'Hide why' : 'Why?'}</button></div>
    <div class="cf-lab">${esc(r.label)}</div>
    ${open ? `<div class="cf-why"><div class="cf-h">${esc(r.headline)}</div>${r.components.map(c => `<div class="cf-c"><b>${esc(c.label)}</b> ${c.score}/100 &middot; weight ${c.weight} <span class="cf-rule">${esc(c.rule)}</span><ul>${c.reasons.map(x => `<li>${esc(x.name)}: ${esc(x.value)}${x.asof ? ' <small>as of ' + esc(x.asof) + '</small>' : ''}<br><small>${esc(x.rule)}</small></li>`).join('')}</ul></div>`).join('')}
    ${r.sam ? `<div class="cf-sam">Sam's own scores, shown beside (not merged into live vote when >30d old): Opportunity ${esc(r.sam.opportunity)}, Quality ${esc(r.sam.quality)}, Trend ${esc(r.sam.trend)}, Risk ${esc(r.sam.risk)}, Flags ${esc(r.sam.flags)}${r.sam.drift_px != null ? ` &middot; <b>Drift since 07-25: ${r.sam.drift_px > 0 ? '+' : ''}${r.sam.drift_px}% px${r.sam.drift_pef != null ? ', ' + (r.sam.drift_pef > 0 ? '+' : '') + r.sam.drift_pef + 'x fP/E' : ''}</b>` : ''} &middot; ${esc(r.sam.label)}</div>` : '<div class="cf-sam">Not in Sam\'s snapshot universe.</div>'}</div>` : ''}`;
}
async function renderBox(el, t, open) { try { const r = await score(t); if (el.dataset.cft !== t) return; el.innerHTML = boxHtml(r, open); } catch (e) { el.innerHTML = `<div class="cf-lab">Confidence unavailable: ${esc(e.message || e)}</div>`; } }
function hookDetail() { // Analyst detail pane: one-click "why" under the ticker header (observer; no edit to app.js)
  const det = document.getElementById('detail'); if (!det) return;
  let open = false;
  const apply = () => {
    const m = /(?:^|[#&])t=([^&]+)/.exec(location.hash), t = (det.dataset.r7t || (m && decodeURIComponent(m[1])) || '').toUpperCase();
    const rowOk = t && core() && (core().rows || []).some(r => r.t === t);
    let box = det.querySelector(':scope > .cf-box');
    if (!rowOk) { if (box) box.remove(); return; }
    if (box && box.dataset.cft === t) return;
    if (!box) { box = document.createElement('div'); box.className = 'cf-box'; const h = det.firstElementChild; if (h) h.after(box); else det.prepend(box); }
    box.dataset.cft = t; box.innerHTML = '<div class="cf-lab">computing confidence...</div>'; renderBox(box, t, open);
  };
  det.addEventListener('click', e => { const b = e.target.closest('[data-cf="why"]'); if (!b) return; open = !open; const box = b.closest('.cf-box'); renderBox(box, box.dataset.cft, open); });
  new MutationObserver(() => setTimeout(apply, 0)).observe(det, {childList: true});
  apply();
}
function register() {
  const A = root.SmartOptionsAPI; if (!A) return false;
  A.confidence_explain = t => explain(t);
  A.confidence_rank = async (list, n) => { const D = core(); const l = Array.isArray(list) && list.length ? list : (D.rows || []).map(r => r.t); const r = await rankList(l);
    return {label: LABEL, method: r[0] ? r[0].method : null, top: r.slice(0, n || 5).map(x => ({ticker: x.ticker, score: x.score, direction: x.direction, why: x.headline})), ranked_of: l.length}; };
  return true;
}
const API = {LABEL, WEIGHTS, REGIME_FIT, compute, rank, score, scoreSync, rankList, explain, boxHtml};
if (typeof module !== 'undefined' && module.exports) module.exports = API;
root.SmartOptionsConfidence = API;
if (typeof document !== 'undefined') {
  const boot = () => { let n = 0; const t = setInterval(() => { if (root.SO2 && root.SO2.D && root.SO2.D()) { hookDetail(); clearInterval(t); } else if (++n > 200) clearInterval(t); }, 50); if (!register()) root.addEventListener('load', register); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
}
})(typeof window !== 'undefined' ? window : globalThis);
