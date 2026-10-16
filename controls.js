/* Controls drawer: scenario shocks + screen thresholds. Persisted via SO2.save() (localStorage + URL hash). */
'use strict';
(function () {
const SHOCKS = [
  {f: 'us10y_bps', h: '10Y yield', u: 'bp', min: -100, max: 100, step: 5},
  {f: 'wti', h: 'Oil (WTI)', u: '%', min: -30, max: 30, step: 1},
  {f: 'dxy', h: 'Dollar (DXY)', u: '%', min: -5, max: 5, step: 0.5},
  {f: 'vix', h: 'VIX', u: 'pts', min: -10, max: 20, step: 1},
  {f: 'spy', h: 'S&P 500 (SPY)', u: '%', min: -10, max: 10, step: 0.5},
];
const QUICK = [
  ['Rates +25bp', {us10y_bps: 25}], ['Rates -25bp', {us10y_bps: -25}], ['Oil -10%', {wti: -10}], ['Oil +10%', {wti: 10}],
  ['Dollar +2%', {dxy: 2}], ['Risk-off', {spy: -3, vix: 5}],
];
const SCREEN = [
  {k: 'minT', h: 'Significant if |t| ≥', min: 1, max: 4, step: 0.5, keep: true},
  {k: 'maxPE', h: 'Max forward P/E', min: 5, max: 80, step: 1},
  {k: 'maxPEG', h: 'Max PEG', min: 0.25, max: 5, step: 0.25},
  {k: 'minIV', h: 'Min ATM IV %', min: 10, max: 120, step: 5},
  {k: 'earnN', h: 'Earnings within N days', min: 1, max: 60, step: 1},
  {k: 'minEarnAway', h: 'Earnings at least N days away', min: 1, max: 60, step: 1},
  {k: 'minOpp', h: "Min Historical Opp score", min: 0, max: 100, step: 5},
];
function apply(sortScen) {
  const A = window.SO2;
  A.save();
  if (sortScen && A.FACTORS.some(f => A.S().shock[f])) A.V.sort = {k: 'scen', dir: 1};
  A.renderTable();
  A.renderDetail();
  if (window.SO2_macro && A.V.tab === 'macro') window.SO2_macro();
}
window.SO2_controls = function (el) {
  const A = window.SO2; if (!A) return;
  const S = A.S();
  const shockRow = x => `<div class="ctl"><label for="sh-${x.f}">${x.h} <span class="dim">${x.u}</span></label>
    <input type="number" id="shn-${x.f}" data-f="${x.f}" step="${x.step}" value="${S.shock[x.f] || 0}">
    <input type="range" id="sh-${x.f}" data-f="${x.f}" min="${x.min}" max="${x.max}" step="${x.step}" value="${S.shock[x.f] || 0}"></div>`;
  const scrRow = x => {
    const v = S[x.k];
    return `<div class="ctl"><label>${x.h}</label>
      <input type="number" data-k="${x.k}" step="${x.step}" min="${x.min}" max="${x.max}" value="${v == null ? '' : v}" placeholder="off">
      <input type="range" data-k="${x.k}" min="${x.min}" max="${x.max}" step="${x.step}" value="${v == null ? x.min : v}"></div>`;
  };
  el.innerHTML = `<button class="x" data-close>Close</button>
    <h3>Scenario</h3>
    <p>Impact % per ticker = Σ coefficient × shock (252-session OLS). Historical association, not a forecast.</p>
    <div class="chips">${QUICK.map((q, i) => `<button data-q="${i}">${q[0]}</button>`).join('')}</div>
    ${SHOCKS.map(shockRow).join('')}
    <h3>Screen</h3><p>Empty = off. Rows missing a screened field are excluded while that screen is on.</p>
    ${SCREEN.map(scrRow).join('')}
    <div class="ctl"><label><input type="checkbox" id="hideMissing" ${S.hideMissing ? 'checked' : ''}> Hide rows missing P/E, PEG or regression</label></div>
    <h3>Regime tiers</h3><p>Historical regime thresholds: 30 / 50 / 70 / 85 (display only; his tier labels come from his code).</p>
    <p><button data-reset>Reset scenario + screen</button></p>`;
  el.oninput = e => {
    const t = e.target;
    if (t.dataset.f) {
      const v = t.value === '' ? 0 : +t.value;
      if (!isFinite(v)) return;
      S.shock[t.dataset.f] = v;
      el.querySelectorAll(`[data-f="${t.dataset.f}"]`).forEach(x => { if (x !== t) x.value = v; });
      apply(true);
    } else if (t.dataset.k) {
      const k = t.dataset.k, v = t.value === '' ? null : +t.value;
      if (v != null && !isFinite(v)) return;
      S[k] = v == null && k === 'minT' ? 2 : v;
      el.querySelectorAll(`[data-k="${k}"]`).forEach(x => { if (x !== t) x.value = v == null ? (x.type === 'range' ? x.min : '') : v; });
      apply(false);
    } else if (t.id === 'hideMissing') { S.hideMissing = t.checked; apply(false); }
  };
  el.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.close != null) { el.hidden = true; return; }
    if (b.dataset.reset != null) {   // scenario + screen only; layout/columns/theme reset lives in Settings
      const d = JSON.parse(JSON.stringify(A.DEFAULTS));
      for (const k of ['shock', 'minT', 'maxPE', 'maxPEG', 'minIV', 'earnN', 'minEarnAway', 'minOpp', 'hideMissing']) S[k] = d[k];
      window.SO2_controls(el); apply(false); return;
    }
    if (b.dataset.q != null) { const q = QUICK[+b.dataset.q][1]; for (const f in S.shock) S.shock[f] = q[f] || 0; window.SO2_controls(el); apply(true); }
  };
};
})();
