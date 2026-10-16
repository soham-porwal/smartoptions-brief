/* R8 practitioner pattern detectors (G. Mundada playbook, docs/GIRISH-PLAYBOOK.md) on stored daily bars.
   Pure detectors + a scan table (own "Patterns" tab). Indicators are reused from app/technicals.js (R7), never duplicated.
   Every detection: {id, pattern, state: forming|confirmed|failed|none, direction, evidence, entry, stop, target,
   entry_idea, stop_idea, target_idea, confirmations: {met, missing}, plain, rule, source}.
   These are PRACTITIONER CONVENTIONS, not evidence-backed; thresholds are our numeric reading of his words,
   shown and editable (localStorage 'so_pat_v1'). Education, not orders. */
(function (root) {
'use strict';
const T = (typeof module !== 'undefined' && module.exports) ? require('./technicals.js') : root.SmartOptionsTech;
const isNum = x => typeof x === 'number' && isFinite(x);
const LS_KEY = 'so_pat_v1';
const SOURCE = 'practitioner convention - G. Mundada (individual investor, not an advisor); not evidence-backed';
const TF_NOTE = 'his charts use 4-hour bars; these run on daily bars';

const DEFAULTS = {
  pivot_k: 5,          // swing pivot = highest high / lowest low within k bars either side
  touch_pct: 1.5,      // pivots within this % of a level count as touches of it
  min_touches: 2,      // a level needs at least this many touches
  ema_long: 110,       // his 180-period EMA on 4h bars ~ 180 x 4h / 6.5h per session ~ 110 daily sessions
  ema_short: 20,       // range re-cross EMA
  lookback: 120,       // sessions scanned for levels / patterns
  recent_n: 5,         // "today" window: an event inside the last N sessions counts as recent
  vol_mult: 1.5,       // breakout volume >= this x 20-session average
  rsi_low: 40,         // "RSI low" before an ascending-triangle entry
  range_min_pct: 4, range_max_pct: 25,  // horizontal range height as % of support
  mw_pct: 1.5,         // double top/bottom: peaks/troughs within this %
  mw_depth_pct: 3,     // ... and the middle swing at least this % away
  mw_min_sep: 5,       // ... and at least this many sessions apart
  dip_pct: 5,          // post-earnings dip: low within 10 sessions after earnings at least this % below the pre-earnings close
  settle_n: 5,         // sessions held above the long EMA before a dip-buy counts as settled
  squeeze_pctile: 20,  // Bollinger bandwidth at or below this percentile of its last 120 sessions = squeeze
  expand_mult: 1.5,    // expansion = bandwidth >= this x its squeeze low
  cross_n: 10,         // golden/death cross counted as recent inside this many sessions
  adx_side: 20, adx_trend: 25, adx_strong: 50,
};
const TH_HELP = {
  pivot_k: 'swing pivot half-width (sessions)', touch_pct: 'touch tolerance %', min_touches: 'min touches per level',
  ema_long: 'long EMA (his 180 on 4h ~ 110 daily)', ema_short: 'range EMA', lookback: 'lookback sessions', recent_n: '"recent" window (sessions)',
  vol_mult: 'breakout volume x 20d avg', rsi_low: 'RSI "low" for triangle entry', range_min_pct: 'range min height %', range_max_pct: 'range max height %',
  mw_pct: 'M/W peak match %', mw_depth_pct: 'M/W middle swing depth %', mw_min_sep: 'M/W min sessions apart', dip_pct: 'post-earnings dip %',
  settle_n: 'sessions above long EMA to settle', squeeze_pctile: 'squeeze bandwidth pctile', expand_mult: 'expansion x squeeze low',
  cross_n: '50/200 cross recent window', adx_side: 'ADX sideways <=', adx_trend: 'ADX trend >=', adx_strong: 'ADX very strong ~',
};
function loadTh() {
  try { const s = JSON.parse((root.localStorage && root.localStorage.getItem(LS_KEY)) || 'null'); return Object.assign({}, DEFAULTS, s && s.th || {}); }
  catch (e) { return Object.assign({}, DEFAULTS); }
}
function saveTh(th) { try { root.localStorage && root.localStorage.setItem(LS_KEY, JSON.stringify({th})); } catch (e) { /* storage blocked: thresholds live for this view only */ } }

/* ---------- helpers ---------- */
const r2 = v => isNum(v) ? Math.round(v * 100) / 100 : null;
const pctDiff = (a, b) => Math.abs(a / b - 1) * 100;
function levels(points, pct) { // cluster pivot prices; touches = pivots within pct% of the running cluster mean
  const pts = points.slice().sort((a, b) => a.p - b.p), out = [];
  for (const x of pts) {
    const c = out.find(o => pctDiff(x.p, o.m) <= pct);
    if (c) { c.pts.push(x); c.m = c.pts.reduce((s, q) => s + q.p, 0) / c.pts.length; } else out.push({pts: [x], m: x.p});
  }
  return out.map(o => ({level: o.m, touches: o.pts.length, idx: o.pts.map(q => q.i).sort((a, b) => a - b)}))
    .sort((a, b) => b.touches - a.touches || b.idx[b.idx.length - 1] - a.idx[a.idx.length - 1]);
}
function avg(a) { const v = a.filter(isNum); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; }
function mk(id, pattern, rule, extra) {
  return Object.assign({id, pattern, state: 'none', direction: 'neutral', evidence: {}, entry: null, stop: null, target: null,
    entry_idea: null, stop_idea: null, target_idea: null, confirmations: {met: [], missing: []}, plain: '', rule, source: SOURCE, timeframe: TF_NOTE}, extra || {});
}
function conf(d, ok, label) { (ok ? d.confirmations.met : d.confirmations.missing).push(label); return ok; }

/* ctx built once per ticker: indicators + pivots + levels */
function prep(bars, th) {
  const b = T.parseBars(bars), n = b.c.length;
  const x = {b, n, th, d: b.d, c: b.c, h: b.hasHL ? b.h : b.c, l: b.hasHL ? b.l : b.c, v: b.v, hasV: b.hasV, hasHL: b.hasHL};
  if (n < 30) return x;
  x.close = b.c[n - 1];
  x.emaL = T.ema(b.c, th.ema_long); x.emaS = T.ema(b.c, th.ema_short);
  x.rsi = T.rsi(b.c, 14); x.macd = T.macd(b.c); x.bb = T.bollinger(b.c, 20, 2);
  x.sma50 = T.sma(b.c, 50); x.sma200 = T.sma(b.c, 200);
  x.adx = b.hasHL ? T.adx(b.h, b.l, b.c, 14) : null;
  x.i0 = Math.max(0, n - th.lookback);
  const pv = T.pivots(x.h, x.l, th.pivot_k);
  x.pH = pv.hi.filter(p => p.i >= x.i0); x.pL = pv.lo.filter(p => p.i >= x.i0);
  x.lv = levels(x.pH.concat(x.pL), th.touch_pct).filter(L => L.touches >= th.min_touches);
  x.res = x.lv.filter(L => L.level > x.close * (1 + th.touch_pct / 100 / 3));
  x.sup = x.lv.filter(L => L.level < x.close * (1 - th.touch_pct / 100 / 3));
  x.vavg = i => avg(b.v.slice(Math.max(0, i - 20), i));
  return x;
}
const lastNum = a => { if (!a) return null; for (let i = a.length - 1; i >= 0; i--) if (isNum(a[i])) return a[i]; return null; };

/* ---------- detectors ---------- */
function dSR(x) {
  const d = mk('sr', 'Support / resistance (most-touched line)', 'Rule 1: choose the level touched by the MOST swing pivots (pivots within touch % of each other), not the absolute high/low; ' + x.th.min_touches + '+ touches; 3+ = confirmed.');
  const R = x.res[0] || null, S = x.sup[0] || null;
  if (!R && !S) { d.plain = 'No level with ' + x.th.min_touches + '+ swing touches in the last ' + x.th.lookback + ' sessions.'; return d; }
  d.evidence = {close: r2(x.close), resistance: R && {level: r2(R.level), touches: R.touches, dates: R.idx.map(i => x.d[i])}, support: S && {level: r2(S.level), touches: S.touches, dates: S.idx.map(i => x.d[i])}};
  const best = Math.max(R ? R.touches : 0, S ? S.touches : 0);
  d.state = best >= 3 ? 'confirmed' : 'forming';
  conf(d, best >= 3, '3+ touches on the strongest line');
  if (S) { d.entry = r2(S.level); d.stop = r2(S.level * (1 - x.th.touch_pct / 100)); d.entry_idea = 'limit buy near support ' + r2(S.level); d.stop_idea = 'below support by the touch tolerance'; }
  if (R) { d.target = r2(R.level); d.target_idea = 'resistance ' + r2(R.level) + ' (where his playbook sells / writes covered calls)'; }
  d.plain = `Most-touched lines: ${S ? 'support ' + r2(S.level) + ' (' + S.touches + ' touches)' : 'no support below'}; ${R ? 'resistance ' + r2(R.level) + ' (' + R.touches + ' touches)' : 'no resistance above'}; close ${r2(x.close)}.`;
  d.levels = [S && {price: S.level, kind: 'support'}, R && {price: R.level, kind: 'resistance'}].filter(Boolean);
  return d;
}

function dAscTri(x) {
  const th = x.th, d = mk('asc_tri', 'Ascending triangle', 'Rule 2: flat resistance (2+ pivot highs within touch %) + 3 rising pivot lows below it; entry after a bounce that closes ABOVE the long EMA (' + th.ema_long + '), RSI low beforehand and MACD cross as confirmation; stop at the trendline; take-profit at the pattern top. Breakout close above the top = confirmed; close below the last higher low = failed.');
  const win = Math.max(x.i0, x.n - 80), hi = x.pH.filter(p => p.i >= win), lo = x.pL.filter(p => p.i >= win);
  const tops = levels(hi, th.touch_pct).filter(L => L.touches >= 2);
  if (!tops.length || lo.length < 3) { d.plain = 'No flat top with rising lows in the last 80 sessions.'; return d; }
  const top = tops[0], L3 = lo.slice(-3);
  const rising = L3[0].p < L3[1].p && L3[1].p < L3[2].p && L3[2].p < top.level * (1 - th.touch_pct / 100);
  const overlaps = L3[2].i > top.idx[0];
  if (!rising || !overlaps) { d.plain = 'Flat top at ' + r2(top.level) + ' but lows are not rising under it.'; return d; }
  d.direction = 'bull';
  d.evidence = {top: r2(top.level), top_touches: top.touches, top_dates: top.idx.map(i => x.d[i]), higher_lows: L3.map(p => [x.d[p.i], r2(p.p)]), close: r2(x.close)};
  const eL = x.emaL[x.n - 1], aboveE = isNum(eL) && x.close > eL;
  const rsiLow = x.rsi.slice(-15).some(v => isNum(v) && v <= th.rsi_low);
  const mh = x.macd.hist, mcross = mh.slice(-6).some((v, j, a) => j > 0 && isNum(v) && isNum(a[j - 1]) && a[j - 1] <= 0 && v > 0);
  conf(d, aboveE, 'close above long EMA ' + th.ema_long + (isNum(eL) ? ' (' + r2(eL) + ')' : ' (not enough history)'));
  conf(d, rsiLow, 'RSI <= ' + th.rsi_low + ' in the last 15 sessions');
  conf(d, mcross, 'MACD crossed above signal in the last 5 sessions');
  d.entry = r2(Math.max(L3[2].p, isNum(eL) ? eL : 0)); d.stop = r2(L3[2].p); d.target = r2(top.level);
  d.entry_idea = 'after a bounce off the rising trendline that closes above the long EMA'; d.stop_idea = 'at the trendline (last higher low ' + r2(L3[2].p) + ')'; d.target_idea = 'pattern top ' + r2(top.level);
  if (x.close < L3[2].p) d.state = 'failed';
  else if (x.close > top.level * (1 + th.touch_pct / 100 / 3) && aboveE) d.state = 'confirmed';
  else d.state = 'forming';
  d.plain = `Flat top ${r2(top.level)} (${top.touches} touches) over higher lows ${L3.map(p => r2(p.p)).join(' < ')}; ${d.state === 'confirmed' ? 'closed above the top' : d.state === 'failed' ? 'broke below the last higher low' : 'still inside the triangle'}.`;
  d.levels = [{price: top.level, kind: 'resistance'}, {price: L3[2].p, kind: 'stop'}];
  return d;
}

function dRange(x) {
  const th = x.th, d = mk('range', 'Horizontal range (support + EMA re-cross)', 'Rule 3: price boxed between a support and a resistance (each ' + th.min_touches + '+ touches, height ' + th.range_min_pct + '-' + th.range_max_pct + '%); buy when price re-crosses above support AND the ' + th.ema_short + '-EMA with RSI rising and MACD histogram rising; sell at resistance; if the EMA cross came on below-average volume, wait for consolidation.');
  const S = x.sup[0], R = x.res[0];
  if (!S || !R) { d.plain = 'No two-sided range (needs a support below and a resistance above).'; return d; }
  const hpct = (R.level / S.level - 1) * 100;
  const win = x.c.slice(Math.max(x.i0, x.n - 40));
  const inside = win.every(v => v >= S.level * (1 - th.touch_pct / 100) && v <= R.level * (1 + th.touch_pct / 100));
  if (hpct < th.range_min_pct || hpct > th.range_max_pct || !inside) { d.plain = `Levels ${r2(S.level)} / ${r2(R.level)} do not box the last 40 closes (height ${r2(hpct)}%).`; return d; }
  d.evidence = {support: r2(S.level), resistance: r2(R.level), height_pct: r2(hpct), close: r2(x.close)};
  d.state = 'forming'; d.direction = 'neutral';
  const n = x.n, k = th.recent_n, e = x.emaS;
  const nearS = x.l.slice(n - k - 5).some(v => v <= S.level * (1 + th.touch_pct / 100));
  let crossI = -1; for (let i = n - k; i < n; i++) if (isNum(e[i]) && isNum(e[i - 1]) && x.c[i - 1] <= e[i - 1] && x.c[i] > e[i]) crossI = i;
  const rsiUp = isNum(x.rsi[n - 1]) && isNum(x.rsi[n - 4]) && x.rsi[n - 1] > x.rsi[n - 4];
  const mUp = isNum(x.macd.hist[n - 1]) && isNum(x.macd.hist[n - 2]) && x.macd.hist[n - 1] > x.macd.hist[n - 2];
  conf(d, nearS, 'price tested support in the last ' + (k + 5) + ' sessions');
  conf(d, crossI >= 0, 'close re-crossed above the ' + th.ema_short + '-EMA in the last ' + k + ' sessions');
  conf(d, rsiUp, 'RSI rising (vs 3 sessions ago)');
  conf(d, mUp, 'MACD histogram rising');
  if (crossI >= 0 && x.hasV) { const va = x.vavg(crossI); conf(d, isNum(va) && x.v[crossI] >= va, 'EMA cross on at-or-above-average volume (else wait for consolidation)'); }
  if (x.close < S.level * (1 - th.touch_pct / 100)) d.state = 'failed';
  else if (nearS && crossI >= 0 && rsiUp && mUp) { d.state = 'confirmed'; d.direction = 'bull'; }
  d.entry = r2(Math.max(S.level, isNum(e[n - 1]) ? e[n - 1] : S.level)); d.stop = r2(S.level * (1 - th.touch_pct / 100)); d.target = r2(R.level);
  d.entry_idea = 'on the re-cross of support and the ' + th.ema_short + '-EMA'; d.stop_idea = 'just below support'; d.target_idea = 'sell at resistance ' + r2(R.level);
  d.plain = `Range ${r2(S.level)}-${r2(R.level)} (${r2(hpct)}% tall); ${d.state === 'confirmed' ? 'support + EMA re-cross with RSI and MACD agreeing' : 'buy conditions ' + d.confirmations.met.length + '/' + (d.confirmations.met.length + d.confirmations.missing.length) + ' met'}.`;
  d.levels = [{price: S.level, kind: 'support'}, {price: R.level, kind: 'resistance'}];
  return d;
}

function dEarnDip(x, ctx) {
  const th = x.th, d = mk('earn_dip', 'Post-earnings dip-buy', 'Rule 4: after earnings, a dip of ' + th.dip_pct + '%+ into multi-month support; wait for settle + consolidation, ' + th.settle_n + '+ sessions closing above the long EMA; target the NEXT resistance (not the first one above); a double bottom at that support is extra confirmation.');
  const ed = ctx && ctx.lastEarnings;
  if (!ed) { d.unavailable = true; d.plain = 'Needs the most recent PAST earnings date; the data carries only the next date' + (ctx && ctx.nextEarnings ? ' (' + ctx.nextEarnings + ')' : '') + ': unavailable.'; return d; }
  const e = x.d.findIndex(v => v >= ed);
  if (e < 1 || e > x.n - 3) { d.plain = 'Last earnings ' + ed + ' is outside the stored bars.'; return d; }
  const pre = x.c[e - 1], seg = x.l.slice(e, Math.min(x.n, e + 10)), lowV = Math.min(...seg), lowI = e + seg.indexOf(lowV);
  const dip = (1 - lowV / pre) * 100;
  d.evidence = {earnings: ed, pre_close: r2(pre), dip_low: r2(lowV), dip_low_date: x.d[lowI], dip_pct: r2(dip)};
  if (dip < th.dip_pct) { d.plain = `Post-earnings low was ${r2(dip)}% under the pre-earnings close (needs ${th.dip_pct}%).`; return d; }
  d.direction = 'bull'; d.state = 'forming';
  const pre_pts = T.pivots(x.h, x.l, th.pivot_k).lo.filter(p => p.i < e);
  const sup = levels(pre_pts, th.touch_pct).filter(L => L.touches >= th.min_touches).find(L => pctDiff(lowV, L.level) <= th.touch_pct * 2);
  conf(d, !!sup, 'dip landed on multi-month support' + (sup ? ' ' + r2(sup.level) + ' (' + sup.touches + ' touches)' : ''));
  let held = 0; for (let i = x.n - 1; i > lowI && isNum(x.emaL[i]) && x.c[i] > x.emaL[i]; i--) held++;
  conf(d, held >= th.settle_n, `${held} sessions closing above the long EMA (needs ${th.settle_n})`);
  const later = T.pivots(x.h, x.l, th.pivot_k).lo.filter(p => p.i > lowI + th.mw_min_sep);
  conf(d, later.some(p => pctDiff(p.p, lowV) <= th.mw_pct), 'double bottom at that support');
  const above = levels(x.pH, th.touch_pct).filter(L => L.level > x.close).sort((a, b) => a.level - b.level);
  const tgt = above[1] || null;
  conf(d, !!tgt, 'a second (next) resistance exists above price');
  if (x.close < lowV) d.state = 'failed'; else if (sup && held >= th.settle_n) d.state = 'confirmed';
  d.entry = r2(x.close); d.stop = r2(lowV); d.target = tgt ? r2(tgt.level) : null;
  d.entry_idea = 'after the settle, while closes hold above the long EMA'; d.stop_idea = 'below the post-earnings low ' + r2(lowV); d.target_idea = tgt ? 'the NEXT resistance ' + r2(tgt.level) : 'no second resistance in range: target unavailable';
  d.plain = `Fell ${r2(dip)}% after ${ed} earnings to ${r2(lowV)}; ${held} sessions above the long EMA since.`;
  d.levels = [{price: lowV, kind: 'stop'}].concat(tgt ? [{price: tgt.level, kind: 'target'}] : []);
  return d;
}

function dRetest(x) {
  const th = x.th, d = mk('retest', 'Old resistance becomes new support', 'Rule 5: a level that was resistance (' + th.min_touches + '+ pivot-high touches) is broken by a close above it, then retested (a low within touch %) and holds, with price above the ' + th.ema_short + '-EMA. Broken but not yet retested = forming; close back below = failed.');
  const tol = th.touch_pct / 100;
  const cands = levels(x.pH, th.touch_pct).filter(L => L.touches >= th.min_touches);
  for (const L of cands) {
    const lastT = L.idx[L.idx.length - 1];
    let bi = -1; for (let i = lastT + 1; i < x.n; i++) if (x.c[i] > L.level * (1 + tol)) { bi = i; break; }
    if (bi < 0) continue;
    let ri = -1; for (let i = bi + 1; i < x.n; i++) if (x.l[i] <= L.level * (1 + tol)) ri = i;
    d.direction = 'bull';
    d.evidence = {old_resistance: r2(L.level), touches: L.touches, touch_dates: L.idx.map(i => x.d[i]), breakout_date: x.d[bi], retest_date: ri >= 0 ? x.d[ri] : null, close: r2(x.close)};
    const aboveE = isNum(x.emaS[x.n - 1]) && x.close > x.emaS[x.n - 1];
    conf(d, ri >= 0, 'retest of the old resistance');
    conf(d, x.close > L.level * (1 - tol), 'retest held (close above the level)');
    conf(d, aboveE, 'close above the ' + th.ema_short + '-EMA');
    d.state = x.close < L.level * (1 - tol) ? 'failed' : ri >= 0 && aboveE ? 'confirmed' : 'forming';
    d.entry = r2(L.level); d.stop = r2(L.level * (1 - tol)); d.entry_idea = 'on the held retest of ' + r2(L.level); d.stop_idea = 'just below the old resistance';
    const nxt = x.res.find(R => R.level > x.close); d.target = nxt ? r2(nxt.level) : null; d.target_idea = nxt ? 'next resistance ' + r2(nxt.level) : 'no resistance above: target unavailable';
    d.plain = `Broke old resistance ${r2(L.level)} on ${x.d[bi]}; ${ri >= 0 ? 'retested ' + x.d[ri] + (d.state === 'failed' ? ' and failed' : ' and held') : 'no retest yet'}.`;
    d.levels = [{price: L.level, kind: 'support'}];
    return d;
  }
  d.plain = 'No broken resistance level in the lookback.'; return d;
}

function dBreakout(x) {
  const th = x.th, tol = th.touch_pct / 100, d = mk('breakout', 'Volume-confirmed breakout', 'Rule 6: close above a repeatedly tested level (' + th.min_touches + '+ touches) within the last ' + th.recent_n + ' sessions on volume >= ' + th.vol_mult + 'x the 20-session average; measured move = channel height (level minus most-touched support) or the last swing height; stop just below the old resistance; Bollinger squeeze before it = extra confirmation. Low-volume break = forming (wait); close back under = failed.');
  const cands = levels(x.pH, th.touch_pct).filter(L => L.touches >= th.min_touches);
  for (const L of cands) {
    let bi = -1; for (let i = Math.max(L.idx[L.idx.length - 1] + 1, x.n - th.recent_n); i < x.n; i++) if (x.c[i] > L.level * (1 + tol) && x.c[i - 1] <= L.level * (1 + tol)) { bi = i; break; }
    if (bi < 0) continue;
    d.direction = 'bull';
    const va = x.vavg(bi), vr = x.hasV && isNum(va) && va > 0 ? x.v[bi] / va : null;
    const S = levels(x.pL, th.touch_pct).filter(s => s.touches >= th.min_touches && s.level < L.level).sort((a, b) => b.touches - a.touches)[0];
    const lastH = x.pH.filter(p => p.i < bi).slice(-1)[0], lastL = x.pL.filter(p => p.i < bi).slice(-1)[0];
    const height = S ? L.level - S.level : (lastH && lastL ? Math.abs(lastH.p - lastL.p) : null);
    const bw = x.bb.bw, bwWin = bw.slice(Math.max(0, bi - 120), bi).filter(isNum), bwMin = Math.min(...bw.slice(Math.max(0, bi - 20), bi).filter(isNum));
    const sq = bwWin.length >= 40 && isNum(bwMin) ? (100 * bwWin.filter(v => v <= bwMin).length / bwWin.length) <= th.squeeze_pctile : false;
    d.evidence = {level: r2(L.level), touches: L.touches, touch_dates: L.idx.map(i => x.d[i]), break_date: x.d[bi], break_close: r2(x.c[bi]), volume_ratio: r2(vr), height: r2(height), height_method: S ? 'channel height (level - support ' + r2(S.level) + ')' : 'last swing height', close: r2(x.close)};
    const volOk = isNum(vr) && vr >= th.vol_mult;
    conf(d, volOk, 'break volume >= ' + th.vol_mult + 'x 20d avg' + (isNum(vr) ? ' (' + r2(vr) + 'x)' : ' (volume unavailable)'));
    conf(d, sq, 'Bollinger squeeze in the 20 sessions before the break');
    const held = x.close > L.level * (1 - tol);
    conf(d, held, 'still above the old resistance');
    d.state = !held ? 'failed' : volOk ? 'confirmed' : 'forming';
    d.entry = r2(L.level); d.stop = r2(L.level * (1 - tol)); d.target = isNum(height) ? r2(L.level + height) : null;
    d.entry_idea = 'his playbook waits for the retest of ' + r2(L.level); d.stop_idea = 'just below the old resistance'; d.target_idea = isNum(height) ? 'measured move ' + r2(L.level) + ' + ' + r2(height) : 'height unavailable';
    d.plain = `Closed above ${r2(L.level)} (${L.touches} touches) on ${x.d[bi]} at ${isNum(vr) ? r2(vr) + 'x' : 'unknown'} volume; measured-move target ${isNum(d.target) ? d.target : 'n/a'}.`;
    d.levels = [{price: L.level, kind: 'resistance'}].concat(isNum(d.target) ? [{price: d.target, kind: 'target'}] : []);
    return d;
  }
  d.plain = 'No close above a multi-touch level in the last ' + th.recent_n + ' sessions.'; return d;
}

function dSqueeze(x) {
  const th = x.th, d = mk('bb_squeeze', 'Bollinger squeeze -> expansion', 'Rule 6 (confirmation): bandwidth (20, 2) at or below its ' + th.squeeze_pctile + 'th percentile of the last 120 sessions = squeeze (forming); bandwidth then >= ' + th.expand_mult + 'x its squeeze low within ' + (th.recent_n * 2) + ' sessions = expansion (confirmed); direction = close vs middle band.');
  const bw = x.bb.bw, n = x.n, hist = bw.slice(Math.max(0, n - 120)).filter(isNum);
  if (hist.length < 40) { d.plain = 'Fewer than 40 sessions of bandwidth.'; return d; }
  const sorted = hist.slice().sort((a, b) => a - b), cut = sorted[Math.floor(th.squeeze_pctile / 100 * (sorted.length - 1))];
  const w = bw.slice(n - th.recent_n * 2), lo = Math.min(...w.filter(isNum)), now = bw[n - 1];
  const inSq = isNum(now) && now <= cut, wasSq = isNum(lo) && lo <= cut, exp = wasSq && isNum(now) && now >= lo * th.expand_mult;
  d.evidence = {bandwidth: r2(now), squeeze_cut: r2(cut), recent_low: r2(lo), close: r2(x.close), mid: r2(x.bb.mid[n - 1])};
  conf(d, wasSq, 'squeeze in the last ' + (th.recent_n * 2) + ' sessions'); conf(d, exp, 'bandwidth expanded ' + th.expand_mult + 'x off the low');
  if (exp) { d.state = 'confirmed'; d.direction = x.close >= x.bb.mid[n - 1] ? 'bull' : 'bear'; }
  else if (inSq) d.state = 'forming';
  d.plain = exp ? `Bands expanded from a squeeze (bandwidth ${r2(lo)} -> ${r2(now)}), price ${d.direction === 'bull' ? 'above' : 'below'} the middle band.` : inSq ? `Bands squeezed (bandwidth ${r2(now)} <= ${r2(cut)}): a move is often watched for next.` : 'No squeeze.';
  return d;
}

function dMW(x, top) {
  const th = x.th, id = top ? 'mtop' : 'wbot', d = mk(id, top ? 'Double/triple top (M)' : 'Double/triple bottom (W)', 'Rule 7: the last 2-3 swing ' + (top ? 'highs' : 'lows') + ' within ' + th.mw_pct + '% of each other, ' + th.mw_min_sep + '+ sessions apart, with the middle swing ' + th.mw_depth_pct + '%+ away; neckline = the extreme between them; a close through the neckline = confirmed; expected move = pattern height from the neckline; a close beyond the peaks = failed.');
  const P = top ? x.pH : x.pL; if (P.length < 2) { d.plain = 'Fewer than 2 swing ' + (top ? 'highs' : 'lows') + '.'; return d; }
  const a = P[P.length - 2], b = P[P.length - 1];
  if (pctDiff(a.p, b.p) > th.mw_pct || b.i - a.i < th.mw_min_sep) { d.plain = `Last two swing ${top ? 'highs' : 'lows'} ${r2(a.p)} / ${r2(b.p)} do not match.`; return d; }
  const mid = top ? Math.min(...x.l.slice(a.i, b.i + 1)) : Math.max(...x.h.slice(a.i, b.i + 1));
  if (pctDiff(mid, a.p) < th.mw_depth_pct) { d.plain = 'Middle swing too shallow for an ' + (top ? 'M' : 'W') + '.'; return d; }
  const c3 = P.length >= 3 ? P[P.length - 3] : null, triple = !!(c3 && pctDiff(c3.p, a.p) <= th.mw_pct && a.i - c3.i >= th.mw_min_sep);
  const peak = top ? Math.max(a.p, b.p) : Math.min(a.p, b.p), height = Math.abs(peak - mid);
  d.direction = top ? 'bear' : 'bull';
  d.evidence = {swings: (triple ? [c3, a, b] : [a, b]).map(p => [x.d[p.i], r2(p.p)]), neckline: r2(mid), height: r2(height), triple, close: r2(x.close)};
  const broke = top ? x.close < mid : x.close > mid, inval = top ? x.close > peak * (1 + th.touch_pct / 100) : x.close < peak * (1 - th.touch_pct / 100);
  conf(d, broke, 'close through the neckline ' + r2(mid));
  if (triple) conf(d, true, 'third ' + (top ? 'top (his note: generally bearish)' : 'bottom'));
  d.state = inval ? 'failed' : broke ? 'confirmed' : 'forming';
  d.entry = r2(mid); d.stop = r2(peak); d.target = r2(top ? mid - height : mid + height);
  d.entry_idea = 'on a close through the neckline ' + r2(mid); d.stop_idea = 'beyond the ' + (top ? 'peaks' : 'troughs') + ' ' + r2(peak); d.target_idea = 'neckline ' + (top ? '-' : '+') + ' height ' + r2(height);
  d.plain = `${triple ? 'Triple' : 'Double'} ${top ? 'top' : 'bottom'} at ~${r2(peak)}, neckline ${r2(mid)}; ${d.state === 'confirmed' ? 'neckline broken, measured target ' + d.target : d.state === 'failed' ? 'price went beyond the ' + (top ? 'peaks' : 'troughs') : 'neckline not broken yet'}.`;
  d.levels = [{price: mid, kind: 'neckline'}, {price: d.target, kind: 'target'}];
  return d;
}

function dCross(x) {
  const th = x.th, d = mk('ma_cross', 'Golden / death cross 50/200 (LAGGING)', 'Rule 8: 50-day SMA crossing the 200-day SMA; LAGGING, confirm with other indicators. A cross inside the last ' + th.cross_n + ' sessions = confirmed; otherwise state none with the current order shown.', {lagging: true});
  const s = x.sma50, l = x.sma200, n = x.n;
  if (!isNum(s[n - 1]) || !isNum(l[n - 1])) { d.plain = 'Needs 200 sessions of history: unavailable.'; d.unavailable = true; return d; }
  let ci = -1; for (let i = n - 1; i > 0 && isNum(l[i - 1]); i--) if ((s[i] - l[i]) * (s[i - 1] - l[i - 1]) <= 0 && s[i] !== l[i]) { ci = i; break; }
  const above = s[n - 1] > l[n - 1]; d.direction = above ? 'bull' : 'bear';
  d.evidence = {sma50: r2(s[n - 1]), sma200: r2(l[n - 1]), last_cross: ci >= 0 ? x.d[ci] : null, sessions_since: ci >= 0 ? n - 1 - ci : null};
  conf(d, ci >= 0 && n - 1 - ci < th.cross_n, 'cross in the last ' + th.cross_n + ' sessions');
  d.state = ci >= 0 && n - 1 - ci < th.cross_n ? 'confirmed' : 'none';
  d.plain = `50-day ${above ? 'above' : 'below'} 200-day${ci >= 0 ? ' since ' + x.d[ci] + (d.state === 'confirmed' ? ' (' + (above ? 'golden' : 'death') + ' cross, recent)' : '') : ' for the whole stored window'}; lagging, needs other confirmation.`;
  return d;
}

function dADX(x) {
  const th = x.th, d = mk('adx', 'ADX trend regime', 'Rule 9: ADX(14) <= ' + th.adx_side + ' sideways; >= ' + th.adx_trend + ' trend starting; ~' + th.adx_strong + '+ very strong; +DI vs -DI gives direction; lagging (combine with OBV and SMA cross). >= ' + th.adx_trend + ' = confirmed, between = forming, <= ' + th.adx_side + ' = none (sideways).', {lagging: true});
  if (!x.adx) { d.plain = 'Needs daily high/low: unavailable.'; d.unavailable = true; return d; }
  const a = lastNum(x.adx.adx), p = lastNum(x.adx.pdi), m = lastNum(x.adx.ndi);
  if (!isNum(a)) { d.plain = 'Not enough history for ADX.'; return d; }
  d.regime = a >= th.adx_strong ? 'very strong trend' : a >= th.adx_trend ? 'trend' : a <= th.adx_side ? 'sideways' : 'transition';
  d.direction = isNum(p) && isNum(m) ? (p > m ? 'bull' : 'bear') : 'neutral';
  d.state = a >= th.adx_trend ? 'confirmed' : a > th.adx_side ? 'forming' : 'none';
  d.evidence = {adx: r2(a), plus_di: r2(p), minus_di: r2(m), regime: d.regime};
  conf(d, a >= th.adx_trend, 'ADX >= ' + th.adx_trend);
  d.plain = `ADX ${r2(a)}: ${d.regime}; +DI ${r2(p)} vs -DI ${r2(m)} -> ${d.direction === 'bull' ? 'up' : 'down'} side stronger.`;
  return d;
}

function dVWAP() {
  const d = mk('vwap', 'Intraday VWAP + 8/21 EMA + 200 MA', 'Rule 10: intraday alignment of VWAP, 8/21 EMA and 200 MA with above-average volume.', {unavailable: true});
  d.plain = 'needs intraday data: unavailable (we store daily bars only).';
  return d;
}

const DETECTORS = ['sr', 'asc_tri', 'range', 'earn_dip', 'retest', 'breakout', 'bb_squeeze', 'mtop', 'wbot', 'ma_cross', 'adx', 'vwap'];
const LABELS = {sr: 'S/R', asc_tri: 'Asc tri', range: 'Range', earn_dip: 'Earn dip', retest: 'Retest', breakout: 'Breakout', bb_squeeze: 'Squeeze', mtop: 'M top', wbot: 'W bottom', ma_cross: '50/200', adx: 'ADX', vwap: 'VWAP'};

/* detect(bars, ctx) -> {asof, n, detections:[...], note}. ctx: {th, lastEarnings, nextEarnings} */
function detect(bars, ctx) {
  ctx = ctx || {}; const th = Object.assign({}, DEFAULTS, ctx.th || {});
  const x = prep(bars, th);
  if (x.n < 60) return {asof: x.n ? x.d[x.n - 1] : null, n: x.n, detections: [], note: 'fewer than 60 daily bars: patterns unavailable'};
  const out = [dSR(x), dAscTri(x), dRange(x), dEarnDip(x, ctx), dRetest(x), dBreakout(x), dSqueeze(x), dMW(x, true), dMW(x, false), dCross(x), dADX(x), dVWAP()];
  for (const d of out) for (const k of ['entry', 'stop', 'target']) if (!isNum(d[k])) d[k] = null;
  return {asof: x.d[x.n - 1], n: x.n, detections: out, note: x.hasHL ? null : 'no high/low in data: closes used for pivots; ADX unavailable'};
}
function summary(res) { // compact per-ticker line used by the scan table, chat and confidence
  const s = {}; for (const d of res.detections) s[d.id] = d.state;
  const conf = res.detections.filter(d => d.state === 'confirmed' && !d.lagging && d.id !== 'sr');
  return {states: s, confirmed: conf.map(d => d.id), bull: conf.filter(d => d.direction === 'bull').length, bear: conf.filter(d => d.direction === 'bear').length};
}

/* ---------------- browser: data + scan + UI ---------------- */
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));
const pxCache = {}, resCache = {};
async function getPx(t) {
  if (pxCache[t]) return pxCache[t];
  try { const r = await fetch(`data/px/${encodeURIComponent(t)}.json`, {cache: 'no-store'}); if (!r.ok) throw new Error('HTTP ' + r.status); pxCache[t] = await r.json(); }
  catch (e) { pxCache[t] = {t, bars: [], err: String(e && e.message || e)}; }
  return pxCache[t];
}
const core = () => { try { return root.SO2 && root.SO2.D ? root.SO2.D() : null; } catch (e) { return null; } };
function rowOf(t) { const c = core(); return c && (c.rows || []).find(r => r.t === t) || null; }
async function scan(t) {
  t = String(t || '').toUpperCase(); if (resCache[t]) return resCache[t];
  const p = await getPx(t), r = rowOf(t);
  const res = detect(p.bars, {th: loadTh(), nextEarnings: r && r.er || null, lastEarnings: r && (r.ler || r.er_prev) || null});
  const src = p.prov && p.prov.price ? `${p.prov.price.provider}; ${p.prov.price.field}; retrieved ${p.prov.price.retrieved_at}` : 'data/px bars';
  resCache[t] = Object.assign({ticker: t, name: r ? r.n : null, sector: r ? r.sec : null, sets: r ? r.sets : [], source: src, method: 'app/patterns.js detectors on stored daily OHLCV; rules + thresholds in each detection', label: SOURCE, err: p.err || null}, res, summary(res));
  return resCache[t];
}
function universe() { const c = core(); const s = new Set((c && c.rows || []).map(r => r.t)); try { (root.SmartOptionsWatchlist && root.SmartOptionsWatchlist.list ? root.SmartOptionsWatchlist.list() : []).forEach(t => s.add(t)); } catch (e) { /* watchlist API shape differs: universe = dashboard rows */ } return [...s].sort(); }
let scanAllP = null;
function scanAll(onProgress) {
  if (scanAllP) return scanAllP;
  const list = universe(), out = []; let i = 0, done = 0;
  const work = async () => { while (i < list.length) { const t = list[i++]; try { out.push(await scan(t)); } catch (e) { out.push({ticker: t, err: String(e && e.message || e), detections: [], states: {}, confirmed: []}); } done++; if (onProgress) onProgress(done, list.length); } };
  scanAllP = Promise.all(Array.from({length: 8}, work)).then(() => out.sort((a, b) => a.ticker.localeCompare(b.ticker)));
  return scanAllP;
}
function resetCache() { for (const k in resCache) delete resCache[k]; scanAllP = null; }

const ST = {filter: 'all', sort: {k: 't', dir: 1}, q: '', open: null, rules: false};
const STCLS = {confirmed: 'pt-c', forming: 'pt-f', failed: 'pt-x', none: 'pt-n'};
function cell(d) {
  if (!d) return '<td class="pt-n">-</td>';
  if (d.unavailable) return `<td class="pt-na" title="${esc(d.plain)}">n/a</td>`;
  const arrow = d.direction === 'bull' ? '&#9650;' : d.direction === 'bear' ? '&#9660;' : '';
  return `<td class="${STCLS[d.state]}" title="${esc(d.plain)}">${d.state === 'none' ? '-' : esc(d.state) + ' ' + arrow}</td>`;
}
function confOf(t) { try { const C = root.SmartOptionsConfidence; return C ? C.scoreSync(t) : null; } catch (e) { return null; } }
function detailHtml(r) {
  const rows = r.detections.map(d => `<div class="pt-det ${STCLS[d.state]}"><div class="pt-dh"><b>${esc(d.pattern)}</b> <span class="pt-st">${d.unavailable ? 'unavailable' : esc(d.state)}${d.lagging ? ' &middot; LAGGING' : ''}</span></div>
    <div class="pt-plain">${esc(d.plain)}</div>
    ${d.state !== 'none' && !d.unavailable ? `<div class="pt-ix">${d.entry_idea ? 'Entry idea: ' + esc(d.entry_idea) : ''}${d.stop_idea ? ' &middot; Stop idea: ' + esc(d.stop_idea) : ''}${d.target_idea ? ' &middot; Target idea: ' + esc(d.target_idea) : ''}</div>
    <div class="pt-cf">${d.confirmations.met.map(c => '<span class="ok">&#10003; ' + esc(c) + '</span>').join('')}${d.confirmations.missing.map(c => '<span class="no">&#10007; ' + esc(c) + '</span>').join('')}</div>` : ''}
    <div class="pt-rule">${esc(d.rule)}</div></div>`).join('');
  return `<div class="pt-dhead"><b>${esc(r.ticker)}</b> ${esc(r.name || '')} <span class="dim">as of ${esc(r.asof || 'n/a')} &middot; ${r.n} daily bars &middot; ${esc(r.source)}</span>
    <button data-pa="analyst" data-t="${esc(r.ticker)}">Open in Analyst</button><button data-pa="close">Close</button></div>
    ${(() => { const c = confOf(r.ticker); return c && root.SmartOptionsConfidence ? '<div class="cf-box cf-inline">' + root.SmartOptionsConfidence.boxHtml(c, true) + '</div>' : ''; })()}
    ${r.note ? `<div class="pt-note">${esc(r.note)}</div>` : ''}<div class="pt-dets">${rows}</div>`;
}
function rulesHtml() {
  const th = loadTh();
  return `<div class="pt-rules"><div>Thresholds are our numeric reading of his words; change them here (saved in this browser only). <button data-pa="reset">Reset</button></div>
    <div class="pt-thg">${Object.keys(DEFAULTS).map(k => `<label>${esc(TH_HELP[k] || k)} <input type="number" step="any" data-th="${k}" value="${esc(th[k])}"></label>`).join('')}</div></div>`;
}
async function renderPage(page) {
  const body = page.querySelector('#pt-body'), meta = page.querySelector('#pt-meta');
  meta.textContent = 'scanning stored price history...';
  const all = await scanAll((d, n) => { meta.textContent = `scanning ${d}/${n}...`; });
  const CF = root.SmartOptionsConfidence;
  if (CF && !page._cfRun) { page._cfRun = true; meta.textContent = 'computing confidence...'; CF.rankList(all.map(r => r.ticker)).then(() => renderPage(page), () => { /* confidence failed: Conf column stays '-' with tooltip */ }); }
  let rows = all.filter(r => r.detections && r.detections.length);
  if (ST.q) rows = rows.filter(r => (r.ticker + ' ' + (r.name || '')).toLowerCase().includes(ST.q));
  if (ST.filter === 'confirmed') rows = rows.filter(r => r.confirmed.length);
  if (ST.filter === 'today') rows = rows.filter(r => r.detections.some(d => d.state === 'confirmed' && !d.lagging && d.id !== 'sr' && d.id !== 'adx' && JSON.stringify(d.evidence).includes(r.asof)));
  const k = ST.sort.k, dir = ST.sort.dir;
  const val = r => k === 't' ? r.ticker : k === 'n' ? r.confirmed.length : k === 'conf' ? ((confOf(r.ticker) || {}).score ?? -1) : ({confirmed: 3, forming: 2, failed: 1, none: 0}[r.states[k]] ?? -1);
  rows.sort((a, b) => { const va = val(a), vb = val(b); return (va < vb ? -1 : va > vb ? 1 : 0) * dir || a.ticker.localeCompare(b.ticker); });
  const failed = all.filter(r => !r.detections || !r.detections.length).length;
  meta.textContent = `${rows.length} of ${all.length} tickers${failed ? ' (' + failed + ' without enough stored bars)' : ''} · as of ${all[0] && all[0].asof || 'n/a'} · daily bars`;
  const hdr = `<tr><th data-ps="t">Ticker</th><th data-ps="conf" title="model confidence: agreement and data quality, NOT probability of profit">Conf</th><th data-ps="n" title="confirmed non-lagging patterns">#</th>${DETECTORS.map(id => `<th data-ps="${id}">${esc(LABELS[id])}</th>`).join('')}</tr>`;
  body.innerHTML = `<table class="pt-tbl"><thead>${hdr}</thead><tbody>${rows.map(r => { const c = confOf(r.ticker); return `<tr data-pt="${esc(r.ticker)}" tabindex="0"><td><b>${esc(r.ticker)}</b><small>${esc(r.sector || '')}</small></td><td title="${esc(c ? c.headline : 'confidence module not loaded')}">${c && c.score != null ? c.score : '-'}</td><td>${r.confirmed.length}</td>${DETECTORS.map(id => cell(r.detections.find(d => d.id === id))).join('')}</tr>`; }).join('')}</tbody></table>`;
  const det = page.querySelector('#pt-detail');
  if (ST.open) { const r = all.find(x => x.ticker === ST.open); det.hidden = !r; if (r) det.innerHTML = detailHtml(r); } else det.hidden = true;
  page.querySelector('#pt-rules').hidden = !ST.rules; if (ST.rules) page.querySelector('#pt-rules').innerHTML = rulesHtml();
}
function mountUI() {
  const A = root.SO2, tabs = document.getElementById('tabs'); if (!A || !tabs || document.getElementById('pt-tab')) return;
  const tab = document.createElement('button'); tab.id = 'pt-tab'; tab.dataset.tab = 'patterns'; tab.textContent = 'Patterns';
  const mac = tabs.querySelector('[data-tab="macro"]'); if (mac) mac.after(tab); else tabs.append(tab);
  const page = document.createElement('main'); page.id = 'pg-patterns'; page.className = 'page'; page.hidden = true;
  page.innerHTML = `<section class="pt-wrap"><div class="pt-top"><h1>Patterns <span class="dim" id="pt-meta"></span></h1>
    <div class="pt-tools"><input id="pt-q" type="search" placeholder="Filter ticker" aria-label="Filter ticker"><select id="pt-f" aria-label="Filter"><option value="all">All tickers</option><option value="confirmed">Any confirmed pattern</option><option value="today">Confirmed today (event dated on the last session)</option></select>
    <button data-pa="rank" title="Sort by model confidence">Rank by confidence</button><button data-pa="rules">Rules + thresholds</button></div></div>
    <div class="pt-label">Practitioner convention - G. Mundada (individual investor, not an advisor); not evidence-backed. ${TF_NOTE}. Education, not orders. States: confirmed / forming / failed / - (none); hover a cell for the evidence, click a row for entry/stop/target ideas.</div>
    <div id="pt-rules" hidden></div><div id="pt-detail" hidden></div><div class="pt-scroll" id="pt-body"></div></section>`;
  document.getElementById('pg-markets').before(page);
  const show = on => { if (on && A.V && A.V.tab !== 'patterns') A.showTab('patterns'); page.hidden = !on; tab.classList.toggle('on', on); document.body.classList.toggle('so-patterns', on); if (on) { ['pg-markets', 'pg-macro', 'pg-overview', 'pg-flow'].forEach(id => { const e = document.getElementById(id); if (e) e.hidden = true; }); document.querySelectorAll('#tabs button').forEach(b => { if (b !== tab) b.classList.remove('on'); }); renderPage(page); } };
  tabs.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; if (b === tab) { e.stopImmediatePropagation(); show(true); } else show(false); }, true);
  page.addEventListener('click', e => {
    const s = e.target.closest('[data-ps]'); if (s) { const k = s.dataset.ps; ST.sort = {k, dir: ST.sort.k === k ? -ST.sort.dir : (k === 't' ? 1 : -1)}; renderPage(page); return; }
    const a = e.target.closest('[data-pa]');
    if (a) { const act = a.dataset.pa;
      if (act === 'rules') ST.rules = !ST.rules; else if (act === 'close') ST.open = null; else if (act === 'rank') ST.sort = {k: 'conf', dir: -1};
      else if (act === 'reset') { saveTh(Object.assign({}, DEFAULTS)); resetCache(); }
      else if (act === 'analyst') { show(false); A.showTab('markets'); A.select('t', a.dataset.t); return; }
      renderPage(page); return; }
    const tr = e.target.closest('[data-pt]'); if (tr) { ST.open = tr.dataset.pt; renderPage(page); page.querySelector('#pt-detail').scrollIntoView({block: 'nearest'}); }
  });
  page.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('tr[data-pt]')) { ST.open = e.target.dataset.pt; renderPage(page); } });
  page.addEventListener('change', e => { const x = e.target; if (x.dataset.th) { const th = loadTh(), v = parseFloat(x.value); if (isFinite(v)) { th[x.dataset.th] = v; saveTh(th); resetCache(); renderPage(page); } } if (x.id === 'pt-f') { ST.filter = x.value; renderPage(page); } });
  page.querySelector('#pt-q').addEventListener('input', e => { ST.q = e.target.value.toLowerCase(); renderPage(page); });
  API.show = () => show(true);
  if (new URLSearchParams(location.hash.slice(1)).get('tab') === 'patterns') show(true);
  else if (A.V && A.V.tab === 'patterns') show(true);
}
function register() {
  const A = root.SmartOptionsAPI; if (!A) return false;
  A.patterns_scan = t => scan(t);
  A.patterns_scan_all = async (filter) => { const all = await scanAll(); const f = String(filter || '').toLowerCase();
    return all.filter(r => !f || r.confirmed.includes(f) || (r.states && r.states[f] === 'confirmed')).map(r => ({ticker: r.ticker, asof: r.asof, confirmed: r.confirmed,
      lines: r.detections.filter(d => d.state === 'confirmed').map(d => d.pattern + ': ' + d.plain), source: r.source, label: SOURCE})); };
  return true;
}

const API = {DEFAULTS, LS_KEY, SOURCE, DETECTORS, LABELS, detect, summary, levels, loadTh, saveTh, scan, scanAll, resetCache, getPx};
if (typeof module !== 'undefined' && module.exports) module.exports = API;
root.SmartOptionsPatterns = API;
if (typeof document !== 'undefined') {
  const boot = () => { let n = 0; const t = setInterval(() => { if (root.SO2 && document.getElementById('tabs')) { mountUI(); clearInterval(t); } else if (++n > 200) clearInterval(t); }, 50); if (!register()) root.addEventListener('load', register); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
}
})(typeof window !== 'undefined' ? window : globalThis);
