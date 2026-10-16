/* SmartOptions V2 - Technicals (lane R7).
   Pure indicator functions over the daily OHLCV bars we already store (data/px/<T>.json: [date,o,h,l,c,v]),
   plus a render mounted by window.SmartOptionsTech.mount(el, ticker).
   Every value is computed here from stored bars; nothing is fetched from a third party. Signal words come
   from the documented RULES below (thresholds editable, persisted in localStorage 'so_tech_v1').
   Education only: a signal word describes what a rule says about the past bars, not a recommendation. */
(function (root) {
'use strict';
const isNum = x => typeof x === 'number' && isFinite(x);
const last = a => a[a.length - 1];
const LS_KEY = 'so_tech_v1';

const DEFAULTS = {
  rsi_ob: 70, rsi_os: 30, rsi_bull: 55, rsi_bear: 45,
  stoch_ob: 80, stoch_os: 20,
  adx_trend: 25,
  pos52_hi: 80, pos52_lo: 20,
  rs_band: 2,            // % outperformance vs SPY / sector median needed for a bullish/bearish word
  squeeze_pctile: 20,    // Bollinger bandwidth at or below this percentile of its last 120 sessions = squeeze
  dd_bear: -20, dd_near: -5,
  pivot_k: 5,            // swing pivot = highest high / lowest low within k bars either side
  // practitioner conventions (G. Mundada playbook, docs/GIRISH-PLAYBOOK.md); our numeric reading of his rules, editable
  g_touch_pct: 1.5,      // pivots within this % of each other count as touches of the same level
  g_vol_mult: 1.5,       // breakout volume must be >= this x the 20-day average
  g_brk_n: 20,           // breakout = close beyond the highest/lowest close of the prior N sessions
  g_mw_pct: 1.5,         // double top/bottom: the two peaks/troughs within this %
  g_adx_side: 20, g_adx_strong: 50,
};
const GSRC = 'practitioner convention - G. Mundada (individual investor, not an advisor); his charts use 4-hour bars, these run on daily bars';

/* ---------------- primitive series (arrays aligned to input; null until enough history) ---------------- */
function sma(x, n) {
  const out = new Array(x.length).fill(null); let s = 0, cnt = 0;
  for (let i = 0; i < x.length; i++) {
    s += x[i]; cnt++;
    if (cnt > n) { s -= x[i - n]; cnt = n; }
    if (cnt === n) out[i] = s / n;
  }
  return out;
}
function ema(x, n) { // seeded with the SMA of the first n values (standard)
  const out = new Array(x.length).fill(null), k = 2 / (n + 1);
  if (x.length < n) return out;
  let e = 0; for (let i = 0; i < n; i++) e += x[i]; e /= n; out[n - 1] = e;
  for (let i = n; i < x.length; i++) { e = x[i] * k + e * (1 - k); out[i] = e; }
  return out;
}
function emaSparse(x, n) { // EMA over a series with leading nulls
  const i0 = x.findIndex(v => v != null); const out = new Array(x.length).fill(null);
  if (i0 < 0) return out; const e = ema(x.slice(i0), n);
  for (let i = 0; i < e.length; i++) out[i0 + i] = e[i]; return out;
}
function wilder(x, n) { // Wilder smoothing (RMA) seeded with simple mean of first n
  const out = new Array(x.length).fill(null); if (x.length < n) return out;
  let s = 0; for (let i = 0; i < n; i++) s += x[i]; let r = s / n; out[n - 1] = r;
  for (let i = n; i < x.length; i++) { r = (r * (n - 1) + x[i]) / n; out[i] = r; }
  return out;
}
function rsi(c, n = 14) {
  const out = new Array(c.length).fill(null); if (c.length <= n) return out;
  const g = [], l = [];
  for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g.push(Math.max(d, 0)); l.push(Math.max(-d, 0)); }
  const ag = wilder(g, n), al = wilder(l, n);
  for (let i = 0; i < g.length; i++) if (ag[i] != null) out[i + 1] = al[i] === 0 ? (ag[i] === 0 ? 50 : 100) : 100 - 100 / (1 + ag[i] / al[i]);
  return out;
}
function macd(c, f = 12, s = 26, sig = 9) {
  const ef = ema(c, f), es = ema(c, s);
  const m = c.map((_, i) => ef[i] != null && es[i] != null ? ef[i] - es[i] : null);
  const sg = emaSparse(m, sig);
  return {macd: m, signal: sg, hist: m.map((v, i) => v != null && sg[i] != null ? v - sg[i] : null)};
}
function stdev(a) { const m = a.reduce((p, q) => p + q, 0) / a.length; return Math.sqrt(a.reduce((p, q) => p + (q - m) * (q - m), 0) / a.length); }
function bollinger(c, n = 20, k = 2) {
  const mid = sma(c, n), up = [], lo = [], pb = [], bw = [];
  for (let i = 0; i < c.length; i++) {
    if (mid[i] == null) { up.push(null); lo.push(null); pb.push(null); bw.push(null); continue; }
    const sd = stdev(c.slice(i - n + 1, i + 1)); // population SD (Bollinger's definition)
    up.push(mid[i] + k * sd); lo.push(mid[i] - k * sd);
    pb.push(sd === 0 ? 0.5 : (c[i] - (mid[i] - k * sd)) / (2 * k * sd));
    bw.push(mid[i] ? (2 * k * sd) / mid[i] : null);
  }
  return {mid, up, lo, pb, bw};
}
function trueRange(h, l, c) { return h.map((_, i) => i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))); }
function atr(h, l, c, n = 14) { return wilder(trueRange(h, l, c), n); }
function adx(h, l, c, n = 14) {
  const L = c.length, pdm = [0], ndm = [0];
  for (let i = 1; i < L; i++) {
    const up = h[i] - h[i - 1], dn = l[i - 1] - l[i];
    pdm.push(up > dn && up > 0 ? up : 0); ndm.push(dn > up && dn > 0 ? dn : 0);
  }
  const tr = trueRange(h, l, c), atr_ = wilder(tr.slice(1), n), sp = wilder(pdm.slice(1), n), sn = wilder(ndm.slice(1), n);
  const pdi = new Array(L).fill(null), ndi = new Array(L).fill(null), dx = [];
  for (let i = 0; i < L - 1; i++) {
    if (atr_[i] == null || atr_[i] === 0) { dx.push(null); continue; }
    const p = 100 * sp[i] / atr_[i], m = 100 * sn[i] / atr_[i];
    pdi[i + 1] = p; ndi[i + 1] = m; dx.push(p + m === 0 ? 0 : 100 * Math.abs(p - m) / (p + m));
  }
  const i0 = dx.findIndex(v => v != null), out = new Array(L).fill(null);
  if (i0 >= 0) { const w = wilder(dx.slice(i0), n); for (let i = 0; i < w.length; i++) out[i0 + 1 + i] = w[i]; }
  return {adx: out, pdi, ndi};
}
function stochastic(h, l, c, n = 14, d = 3) {
  const k = c.map((_, i) => {
    if (i < n - 1) return null;
    const hh = Math.max(...h.slice(i - n + 1, i + 1)), ll = Math.min(...l.slice(i - n + 1, i + 1));
    return hh === ll ? 50 : 100 * (c[i] - ll) / (hh - ll);
  });
  const i0 = k.findIndex(v => v != null), dd = new Array(c.length).fill(null);
  if (i0 >= 0) { const s = sma(k.slice(i0), d); for (let i = 0; i < s.length; i++) dd[i0 + i] = s[i]; }
  return {k, d: dd};
}
function obv(c, v) { const o = [0]; for (let i = 1; i < c.length; i++) o.push(o[i - 1] + (c[i] > c[i - 1] ? v[i] : c[i] < c[i - 1] ? -v[i] : 0)); return o; }
function slope(y) { // OLS slope per bar
  const n = y.length; if (n < 2) return null; let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += y[i]; sxy += i * y[i]; sxx += i * i; }
  const den = n * sxx - sx * sx; return den ? (n * sxy - sx * sy) / den : null;
}
function logret(c) { const r = []; for (let i = 1; i < c.length; i++) r.push(Math.log(c[i] / c[i - 1])); return r; }
function realizedVol(c, n) { // annualized close-to-close stdev of log returns (sample SD, x sqrt 252), in %
  const r = logret(c); if (r.length < n) return null; const w = r.slice(-n), m = w.reduce((a, b) => a + b, 0) / n;
  return 100 * Math.sqrt(w.reduce((a, b) => a + (b - m) * (b - m), 0) / (n - 1) * 252);
}
function rollingRV(c, n) { const out = []; for (let i = n + 1; i <= c.length; i++) out.push(realizedVol(c.slice(0, i), n)); return out; }
function pctileRank(arr, v) { const a = arr.filter(isNum); if (!a.length || !isNum(v)) return null; return 100 * a.filter(x => x <= v).length / a.length; }
function pivots(h, l, k) {
  const hi = [], lo = [];
  for (let i = k; i < h.length - k; i++) {
    let isH = true, isL = true;
    for (let j = i - k; j <= i + k; j++) { if (j === i) continue; if (h[j] >= h[i]) isH = false; if (l[j] <= l[i]) isL = false; }
    if (isH) hi.push({i, p: h[i]}); if (isL) lo.push({i, p: l[i]});
  }
  return {hi, lo};
}

function touchLevels(points, pct) { // cluster pivot prices; a level's touches = pivots within pct% of the cluster mean
  const pts = points.map(x => x.p).sort((a, b) => a - b), out = [];
  for (const v of pts) { const c = out.find(o => Math.abs(v / o.m - 1) * 100 <= pct); if (c) { c.v.push(v); c.m = c.v.reduce((a, b) => a + b, 0) / c.v.length; } else out.push({v: [v], m: v}); }
  return out.map(o => ({level: o.m, touches: o.v.length})).sort((a, b) => b.touches - a.touches || b.level - a.level);
}

/* ---------------- analysis: values + signal words + plain language ---------------- */
function loadThresholds() {
  try { const s = JSON.parse((root.localStorage && root.localStorage.getItem(LS_KEY)) || 'null'); return Object.assign({}, DEFAULTS, s && s.th || {}); }
  catch (e) { return Object.assign({}, DEFAULTS); }
}
function saveThresholds(th) { try { root.localStorage && root.localStorage.setItem(LS_KEY, JSON.stringify({th})); } catch (e) { /* storage blocked: thresholds live for this view only */ } }

function parseBars(bars) {
  const d = [], o = [], h = [], l = [], c = [], v = [];
  for (const b of bars || []) { if (!b || !isNum(b[4])) continue; d.push(b[0]); o.push(b[1]); h.push(b[2]); l.push(b[3]); c.push(b[4]); v.push(b[5]); }
  const hasHL = c.length > 0 && h.every(isNum) && l.every(isNum) && h.some((x, i) => x !== l[i]);
  const hasO = c.length > 0 && o.every(isNum);
  const hasV = c.length > 0 && v.every(isNum) && v.some(x => x > 0);
  return {d, o, h, l, c, v, hasHL, hasO, hasV};
}

/* analyze(bars, ctx) -> {asof, n, rows:[{id,group,label,value,text,signal,rule,plain,change,unavailable}], summary, series}
   ctx: {spy: [[date, close]...], sectorMedian1m: number|null, own1m: number|null, sector: str, th: thresholds} */
function analyze(bars, ctx) {
  ctx = ctx || {}; const th = Object.assign({}, DEFAULTS, ctx.th || {});
  const B = parseBars(bars), {c, h, l, o, v, d} = B, n = c.length, px = n ? c[n - 1] : null;
  const rows = [];
  const add = (r) => rows.push(Object.assign({signal: 'neutral', unavailable: null}, r));
  const na = (id, group, label, why) => add({id, group, label, value: null, text: 'n/a', signal: 'n/a', unavailable: why, rule: '', plain: why, change: ''});
  const f = (x, k = 2) => isNum(x) ? x.toFixed(k) : 'n/a';
  if (!n) return {asof: null, n: 0, rows, summary: summarize(rows), series: {}, notes: ['no stored price history for this ticker'], hasHL: false, hasV: false};
  const series = {d, c};
  const notes = [];
  if (!B.hasHL) notes.push('only closes are stored (no usable high/low): ATR, ADX/DMI, Stochastic, gap stats and swing pivots are unavailable');
  if (!B.hasV) notes.push('no volume stored: OBV / volume trend unavailable');
  if (n < 200) notes.push(`${n} sessions stored: indicators that need more history show n/a`);

  // Moving averages
  const ma = {};
  for (const p of [20, 50, 100, 200]) { ma['sma' + p] = sma(c, p); ma['ema' + p] = ema(c, p); }
  Object.assign(series, ma);
  for (const p of [20, 50, 100, 200]) {
    const s = last(ma['sma' + p]), e = last(ma['ema' + p]);
    if (s == null) { na('sma' + p, 'Trend', `SMA/EMA ${p}`, `needs ${p} sessions, have ${n}`); continue; }
    const dist = 100 * (px / s - 1);
    add({id: 'sma' + p, group: 'Trend', label: `SMA/EMA ${p}`, value: dist, text: `SMA ${f(s)} · EMA ${f(e)} · price ${dist >= 0 ? '+' : ''}${f(dist, 1)}% vs SMA`,
      signal: px > s ? 'bullish' : px < s ? 'bearish' : 'neutral', rule: `bullish if close > SMA${p}, bearish if below`,
      plain: `The ${p}-day average is the typical price of the last ${p} sessions. Price is ${f(Math.abs(dist), 1)}% ${dist >= 0 ? 'above' : 'below'} it.`,
      change: `Flips on a close ${dist >= 0 ? 'below' : 'above'} ${f(s)}.`});
  }
  const s50 = ma.sma50, s200 = ma.sma200;
  if (last(s200) != null) {
    let crossAgo = null; for (let i = n - 1; i > 0; i--) { if (s200[i - 1] == null) break; if ((s50[i] > s200[i]) !== (s50[i - 1] > s200[i - 1])) { crossAgo = n - 1 - i; break; } }
    const gold = last(s50) > last(s200);
    add({id: 'cross', group: 'Trend', label: '50/200 cross', value: crossAgo, text: `${gold ? 'golden (50 above 200)' : 'death (50 below 200)'}${crossAgo != null ? `, crossed ${crossAgo} sessions ago` : ', no cross in stored history'}`,
      signal: gold ? 'bullish' : 'bearish', rule: 'bullish if SMA50 > SMA200 (golden cross state), bearish if below',
      plain: 'Compares the medium-term average to the long-term one; a long-watched trend filter.', change: `Flips when SMA50 (${f(last(s50))}) crosses SMA200 (${f(last(s200))}).`});
  } else na('cross', 'Trend', '50/200 cross', `needs 200 sessions, have ${n}`);

  // RSI
  const R = rsi(c, 14); series.rsi = R; const r14 = last(R);
  if (r14 != null) add({id: 'rsi', group: 'Momentum', label: 'RSI(14)', value: r14, text: f(r14, 1),
    signal: r14 >= th.rsi_ob ? 'overbought' : r14 <= th.rsi_os ? 'oversold' : r14 > th.rsi_bull ? 'bullish' : r14 < th.rsi_bear ? 'bearish' : 'neutral',
    rule: `overbought >= ${th.rsi_ob}, oversold <= ${th.rsi_os}, bullish > ${th.rsi_bull}, bearish < ${th.rsi_bear}, else neutral (Wilder smoothing)`,
    plain: 'Speed of recent up-closes vs down-closes on a 0-100 scale. High = stretched up, low = stretched down.',
    change: r14 >= th.rsi_ob ? `Leaves overbought below ${th.rsi_ob}.` : r14 <= th.rsi_os ? `Leaves oversold above ${th.rsi_os}.` : `Overbought at ${th.rsi_ob}, oversold at ${th.rsi_os}.`});
  else na('rsi', 'Momentum', 'RSI(14)', 'needs 15 sessions');

  // MACD
  const M = macd(c); series.macd = M;
  if (last(M.signal) != null) {
    const m = last(M.macd), sg = last(M.signal), hs = last(M.hist), hp = M.hist[n - 2];
    add({id: 'macd', group: 'Momentum', label: 'MACD(12,26,9)', value: hs, text: `MACD ${f(m)} · signal ${f(sg)} · hist ${f(hs)}${hp != null ? (hs > hp ? ' rising' : ' falling') : ''}`,
      signal: m > sg ? 'bullish' : m < sg ? 'bearish' : 'neutral', rule: 'bullish if MACD line > signal line, bearish if below',
      plain: 'Gap between the 12- and 26-day EMAs vs its own 9-day average; shows momentum turning.',
      change: `Flips when the histogram (${f(hs)}) crosses zero.`});
  } else na('macd', 'Momentum', 'MACD(12,26,9)', 'needs 34 sessions');

  // Bollinger
  const BB = bollinger(c); series.bb = BB;
  if (last(BB.mid) != null) {
    const pb = last(BB.pb), bwHist = BB.bw.slice(-120).filter(isNum), bwP = pctileRank(bwHist, last(BB.bw)), sq = isNum(bwP) && bwP <= th.squeeze_pctile;
    add({id: 'bb', group: 'Volatility', label: 'Bollinger(20,2) %B', value: pb, text: `%B ${f(pb, 2)} · width ${f(100 * last(BB.bw), 1)}% (${f(bwP, 0)}th pctile of ${bwHist.length}d)${sq ? ' · SQUEEZE' : ''}`,
      signal: pb > 1 ? 'overbought' : pb < 0 ? 'oversold' : pb > 0.8 ? 'bullish' : pb < 0.2 ? 'bearish' : 'neutral',
      rule: `%B > 1 overbought, < 0 oversold, > 0.8 bullish, < 0.2 bearish; squeeze if band width <= ${th.squeeze_pctile}th percentile of its last 120 sessions`,
      plain: `Where price sits inside a 2-standard-deviation band around the 20-day average (0 = lower band, 1 = upper).${sq ? ' The band is unusually narrow: quiet periods often precede larger moves, direction unknown.' : ''}`,
      change: `Upper band ${f(last(BB.up))}, lower band ${f(last(BB.lo))}.`, squeeze: sq});
  } else na('bb', 'Volatility', 'Bollinger(20,2)', 'needs 20 sessions');

  // ATR / ADX / Stochastic need H/L
  if (B.hasHL) {
    const A = atr(h, l, c, 14); series.atr = A; const a = last(A);
    if (a != null) add({id: 'atr', group: 'Volatility', label: 'ATR(14) / ATR%', value: 100 * a / px, text: `${f(a)} (${f(100 * a / px, 2)}% of price)`, signal: 'info',
      rule: 'informational, no direction (Wilder ATR on high/low/prev close)', plain: `A typical day's full range is about $${f(a)}. Useful for stop distance and strike spacing.`,
      change: 'Rises when daily ranges widen.'});
    const D = adx(h, l, c, 14); series.adx = D; const ax = last(D.adx), p = last(D.pdi), m = last(D.ndi);
    if (ax != null) add({id: 'adx', group: 'Trend', label: 'ADX/DMI(14)', value: ax, text: `ADX ${f(ax, 1)} · +DI ${f(p, 1)} · -DI ${f(m, 1)}`,
      signal: ax >= th.adx_trend ? (p > m ? 'bullish' : 'bearish') : 'neutral', rule: `trending if ADX >= ${th.adx_trend}; then bullish if +DI > -DI else bearish; below ${th.adx_trend} neutral (no trend)`,
      plain: ax >= th.adx_trend ? `A real trend is present (${p > m ? 'up' : 'down'}).` : 'No strong trend: range-bound conditions, where premium-selling ideas tend to be discussed.',
      change: `Trend state changes when ADX crosses ${th.adx_trend} or the DI lines cross.`});
    else na('adx', 'Trend', 'ADX/DMI(14)', 'needs ~28 sessions');
    const ST = stochastic(h, l, c); series.stoch = ST; const k = last(ST.k), dd = last(ST.d);
    if (dd != null) add({id: 'stoch', group: 'Momentum', label: 'Stochastic(14,3)', value: k, text: `%K ${f(k, 1)} · %D ${f(dd, 1)}`,
      signal: k >= th.stoch_ob ? 'overbought' : k <= th.stoch_os ? 'oversold' : k > dd ? 'bullish' : k < dd ? 'bearish' : 'neutral',
      rule: `overbought >= ${th.stoch_ob}, oversold <= ${th.stoch_os}; else bullish if %K > %D, bearish if below`,
      plain: 'Where the close sits within the last 14 days\' high-low range (100 = at the top).', change: `%K crossing %D (${f(dd, 1)}) flips it.`});
  } else ['atr', 'adx', 'stoch'].forEach(id => na(id, id === 'adx' ? 'Trend' : id === 'atr' ? 'Volatility' : 'Momentum', {atr: 'ATR(14)', adx: 'ADX/DMI(14)', stoch: 'Stochastic(14,3)'}[id], 'needs high/low bars; only closes stored'));

  // OBV
  if (B.hasV && n > 21) {
    const O = obv(c, v); series.obv = O; const os = slope(O.slice(-20)), ps = slope(c.slice(-20));
    const avg20 = v.slice(-20).reduce((a, b) => a + b, 0) / 20, avg60 = v.slice(-60).reduce((a, b) => a + b, 0) / Math.min(60, n);
    const conf = os > 0 && ps > 0 ? 'bullish' : os < 0 && ps < 0 ? 'bearish' : 'neutral';
    add({id: 'obv', group: 'Volume', label: 'OBV / volume trend', value: os, text: `OBV 20d slope ${os > 0 ? 'up' : 'down'}, price 20d slope ${ps > 0 ? 'up' : 'down'} · vol 20d/60d ${f(avg20 / avg60, 2)}x`,
      signal: conf, rule: 'bullish if 20-day OBV slope and price slope are both up, bearish if both down, else neutral (divergence)',
      plain: conf === 'neutral' ? 'Volume flow disagrees with price direction (divergence): the move has less participation behind it.' : 'Volume flow confirms the recent price direction.',
      change: 'Changes when up-day vs down-day volume balance reverses.'});
  } else na('obv', 'Volume', 'OBV / volume trend', B.hasV ? 'needs 22 sessions' : 'no volume stored');

  // 52w position + drawdown (closes; the table's 52w uses unadjusted daily high/low, so values can differ slightly)
  const w = c.slice(-252), hi = Math.max(...w), lo = Math.min(...w), pos = hi === lo ? 50 : 100 * (px - lo) / (hi - lo);
  add({id: 'pos52', group: 'Trend', label: `52w position (${w.length}d closes)`, value: pos, text: `${f(pos, 0)}% of range ${f(lo)}-${f(hi)}`,
    signal: pos >= th.pos52_hi ? 'bullish' : pos <= th.pos52_lo ? 'bearish' : 'neutral', rule: `bullish if >= ${th.pos52_hi}% of the closing range, bearish if <= ${th.pos52_lo}%`,
    plain: `0% = at the lowest close of the window, 100% = at the highest.`, change: `Range high ${f(hi)}, low ${f(lo)}.`});
  let peak = -Infinity, maxdd = 0; for (const x of w) { peak = Math.max(peak, x); maxdd = Math.min(maxdd, 100 * (x / peak - 1)); }
  const dd = 100 * (px / hi - 1);
  add({id: 'dd', group: 'Risk', label: 'Drawdown', value: dd, text: `${f(dd, 1)}% from ${w.length}d closing high · worst in window ${f(maxdd, 1)}%`,
    signal: dd <= th.dd_bear ? 'bearish' : dd >= th.dd_near ? 'bullish' : 'neutral', rule: `bearish if <= ${th.dd_bear}% from the high (bear-market convention), bullish if within ${th.dd_near}%`,
    plain: 'How far below its recent peak the stock closed.', change: `New high above ${f(hi)} resets it to 0.`});

  // Realized vol
  const rv = {10: realizedVol(c, 10), 20: realizedVol(c, 20), 60: realizedVol(c, 60)};
  if (rv[20] != null) {
    const hist = rollingRV(c, 20), p = pctileRank(hist, rv[20]);
    add({id: 'rv', group: 'Volatility', label: 'Realized vol 10/20/60d', value: rv[20], text: `${f(rv[10], 1)}% / ${f(rv[20], 1)}% / ${f(rv[60], 1)}% · 20d at ${f(p, 0)}th pctile of ${hist.length}d`,
      signal: 'info', rule: 'informational: annualized stdev of daily log returns (sample SD x sqrt 252); percentile vs its own rolling history',
      plain: `The stock has actually been moving about ${f(rv[20] / Math.sqrt(252), 2)}% per day lately. Compare with implied vol (IV) to see if options are rich or cheap.`,
      change: 'Rises with bigger daily moves.', rv, pctile: p});
  } else na('rv', 'Volatility', 'Realized vol', 'needs 21 sessions');

  // Support / resistance from swing pivots
  if (B.hasHL && n > 2 * th.pivot_k + 1) {
    const P = pivots(h, l, th.pivot_k), res = P.hi.map(x => x.p).filter(x => x > px).sort((a, b) => a - b), sup = P.lo.map(x => x.p).filter(x => x < px).sort((a, b) => b - a);
    series.pivots = P;
    add({id: 'sr', group: 'Levels', label: 'Support / resistance', value: null, text: `support ${sup.length ? sup.slice(0, 2).map(x => f(x)).join(', ') : 'none below'} · resistance ${res.length ? res.slice(0, 2).map(x => f(x)).join(', ') : 'none above (at highs)'}`,
      signal: 'info', rule: `swing pivots: a high/low that is the extreme within ${th.pivot_k} bars on each side; nearest two below/above price`,
      plain: 'Prices where the stock recently turned. Useful as candidate strike / stop zones, not guarantees.', change: 'New pivots form as the chart develops.', levels: {sup: sup.slice(0, 3), res: res.slice(0, 3)}});
  } else na('sr', 'Levels', 'Support / resistance', B.hasHL ? 'too little history' : 'needs high/low bars');

  // Gaps
  if (B.hasO && n > 21) {
    const W = Math.min(60, n - 1); let cnt = 0, up = 0, sum = 0;
    for (let i = n - W; i < n; i++) { const g = 100 * (o[i] / c[i - 1] - 1); sum += Math.abs(g); if (Math.abs(g) >= 1) { cnt++; if (g > 0) up++; } }
    add({id: 'gap', group: 'Risk', label: `Gaps (${W}d)`, value: cnt, text: `${cnt} gaps >= 1% (${up} up / ${cnt - up} down) · avg |open gap| ${f(sum / W, 2)}%`,
      signal: 'info', rule: 'gap = open vs prior close; counted if |gap| >= 1%', plain: 'Overnight jumps. Frequent gaps make stop-losses and short options riskier because price can skip levels.', change: 'Earnings and macro releases usually add gaps.'});
  } else na('gap', 'Risk', 'Gaps', 'needs open prices');

  // Relative strength
  if (ctx.spy && ctx.spy.length) {
    const sm = new Map(ctx.spy.map(x => [x[0], x[1]]));
    const rs = p => { const i0 = n - 1 - p; if (i0 < 0) return null; const a = sm.get(d[i0]), b = sm.get(d[n - 1]); if (!isNum(a) || !isNum(b)) return null; return 100 * ((c[n - 1] / c[i0]) - (b / a)); };
    const r20 = rs(20), r60 = rs(60), r120 = rs(120);
    if (r60 != null) add({id: 'rs_spy', group: 'Relative', label: 'Rel. strength vs SPY', value: r60, text: `20d ${f(r20, 1)} · 60d ${f(r60, 1)} · 120d ${f(r120, 1)} pct pts`,
      signal: r60 > th.rs_band ? 'bullish' : r60 < -th.rs_band ? 'bearish' : 'neutral', rule: `60-session return minus SPY's (same dates); bullish > +${th.rs_band} pts, bearish < -${th.rs_band}`,
      plain: `Over 60 sessions the stock ${r60 >= 0 ? 'beat' : 'lagged'} the S&P 500 ETF by ${f(Math.abs(r60), 1)} percentage points.`, change: 'Flips if the stock lags/leads SPY going forward.'});
    else na('rs_spy', 'Relative', 'Rel. strength vs SPY', 'dates do not align with stored SPY closes');
  } else na('rs_spy', 'Relative', 'Rel. strength vs SPY', 'SPY closes not available');
  if (isNum(ctx.own1m) && isNum(ctx.sectorMedian1m)) {
    const x = ctx.own1m - ctx.sectorMedian1m;
    add({id: 'rs_sec', group: 'Relative', label: 'vs sector median (1M)', value: x, text: `${f(x, 1)} pct pts vs ${ctx.sector || 'sector'} median ${f(ctx.sectorMedian1m, 1)}% (n=${ctx.sectorN || '?'})`,
      signal: x > th.rs_band ? 'bullish' : x < -th.rs_band ? 'bearish' : 'neutral', rule: `1-month return minus the median 1-month return of dashboard tickers in the same GICS sector; bullish > +${th.rs_band}, bearish < -${th.rs_band}`,
      plain: 'Is it leading or lagging its own sector peers on the dashboard?', change: 'Flips when peers catch up or fall behind.'});
  } else na('rs_sec', 'Relative', 'vs sector median', 'sector peers or 1M return missing');

  // Practitioner detectors (G. Mundada playbook). All on daily bars; labelled as convention, not evidence.
  const G = 'Practitioner (G. Mundada)';
  const e50 = last(ma.ema50);
  if (B.hasHL && n > 60) {
    const P = pivots(h, l, th.pivot_k), lv = touchLevels(P.hi.concat(P.lo), th.g_touch_pct);
    const sup = lv.filter(x => x.level < px && x.touches >= 2).sort((a, b) => b.touches - a.touches || b.level - a.level)[0];
    const res = lv.filter(x => x.level > px && x.touches >= 2).sort((a, b) => b.touches - a.touches || a.level - b.level)[0];
    add({id: 'g_sr', group: G, label: 'Most-touched support / resistance', value: null, signal: 'info',
      text: `support ${sup ? `${f(sup.level)} (${sup.touches} touches)` : 'none with 2+ touches'} · resistance ${res ? `${f(res.level)} (${res.touches} touches)` : 'none with 2+ touches'}`,
      rule: `rule 1: the line touching the MOST swing points (pivots within ${th.g_touch_pct}% grouped), not the absolute high/low. ${GSRC}`,
      plain: 'Levels the stock has turned at repeatedly. His covered calls sit near resistance, cash-secured puts below support.', change: 'More touches strengthen a level; a decisive close through it breaks it.', levels: {sup, res}});
    // Breakout / breakdown on volume (rule 6)
    let brk = null;
    for (let i = n - 1; i >= Math.max(th.g_brk_n + 1, 21, n - 5); i--) {
      const prior = c.slice(i - th.g_brk_n, i), hiC = Math.max(...prior), loC = Math.min(...prior);
      const av = B.hasV ? v.slice(i - 20, i).reduce((a, b) => a + b, 0) / 20 : null, vm = av ? v[i] / av : null;
      if (c[i] > hiC || c[i] < loC) { brk = {ago: n - 1 - i, up: c[i] > hiC, lvl: c[i] > hiC ? hiC : loC, vm}; break; }
    }
    const bbRow = rows.find(r => r.id === 'bb'), sq = bbRow && bbRow.squeeze;
    const conf = !!(brk && isNum(brk.vm) && brk.vm >= th.g_vol_mult);
    const rng = c.slice(-th.g_brk_n - 1, -1);
    add({id: 'g_brk', group: G, label: `Breakout on volume (${th.g_brk_n}d)`, value: brk && isNum(brk.vm) ? brk.vm : null,
      text: brk ? `${brk.up ? 'breakout above' : 'breakdown below'} ${f(brk.lvl)} ${brk.ago ? brk.ago + ' sessions ago' : 'today'} · volume ${isNum(brk.vm) ? f(brk.vm, 2) + 'x 20d avg' : 'n/a'}${conf ? ' (confirmed)' : ' (volume did not confirm)'}${sq ? ' · Bollinger squeeze present' : ''}` : `no close beyond the prior ${th.g_brk_n}-session range in the last 5 sessions`,
      signal: conf ? (brk.up ? 'bullish' : 'bearish') : 'neutral',
      rule: `rule 6: close beyond the highest/lowest close of the prior ${th.g_brk_n} sessions within the last 5 sessions, confirmed only if that day's volume >= ${th.g_vol_mult}x its 20-day average; he waits for a retest before acting. ${GSRC}`,
      plain: brk ? (conf ? 'A range break with heavy volume behind it: his setup, after a retest of the broken level.' : 'Price broke the range but volume did not confirm it.') : 'No range break right now.',
      change: brk ? `Fails if price closes back ${brk.up ? 'below' : 'above'} ${f(brk.lvl)}.` : `A close above ${f(Math.max(...rng))} or below ${f(Math.min(...rng))} on heavy volume.`});
    // Old resistance becomes support (rule 5)
    let flip = null;
    for (const x of touchLevels(P.hi, th.g_touch_pct).filter(o => o.touches >= 2 && o.level < px)) {
      let crossed = -1;
      for (let i = Math.max(1, n - 60); i < n; i++) if (c[i - 1] <= x.level && c[i] > x.level) { crossed = i; break; }
      if (crossed < 0) continue;
      const priorHighs = P.hi.filter(o => o.i < crossed && Math.abs(o.p / x.level - 1) * 100 <= th.g_touch_pct).length;
      if (priorHighs < 2) continue; // it must have acted as resistance (2+ swing highs) BEFORE the break
      let retest = false; for (let i = crossed + 3; i < n; i++) if (Math.abs(l[i] / x.level - 1) * 100 <= th.g_touch_pct && c[i] > x.level) retest = true;
      if (retest) { flip = x; break; }
    }
    add({id: 'g_flip', group: G, label: 'Old resistance -> new support', value: flip ? flip.level : null,
      text: flip ? `broke above ${f(flip.level)} (${flip.touches} touches), retest held${e50 != null ? `, close ${px > e50 ? 'above' : 'below'} EMA50 ${f(e50)}` : ''}` : 'no broken-and-retested level in the last 60 sessions',
      signal: flip && e50 != null && px > e50 ? 'bullish' : 'neutral',
      rule: `rule 5: a level with 2+ swing highs before the break, crossed upward in the last 60 sessions, retested 3+ sessions later (low within ${th.g_touch_pct}%) with the close holding above it, and price above the long EMA (EMA50 here; he uses a 180-period EMA on 4-hour bars). ${GSRC}`,
      plain: flip ? 'A former ceiling is now acting as a floor: his entry pattern, stop just below the level.' : 'No resistance-turned-support setup right now.', change: flip ? `Fails on a close below ${f(flip.level)}.` : 'Forms after a break above resistance and a successful retest.'});
    // Double top (M) / double bottom (W) (rule 7)
    const hs = P.hi.filter(o => o.i >= n - 60).slice(-2), ls = P.lo.filter(o => o.i >= n - 60).slice(-2);
    let mw = null;
    if (hs.length === 2 && Math.abs(hs[1].p / hs[0].p - 1) * 100 <= th.g_mw_pct) { const top = Math.max(hs[0].p, hs[1].p), neck = Math.min(...l.slice(hs[0].i, hs[1].i + 1)); mw = {kind: 'M (double top)', top, neck, done: px < neck, sig: 'bearish', target: neck - (top - neck)}; }
    if (!mw && ls.length === 2 && Math.abs(ls[1].p / ls[0].p - 1) * 100 <= th.g_mw_pct) { const top = Math.min(ls[0].p, ls[1].p), neck = Math.max(...h.slice(ls[0].i, ls[1].i + 1)); mw = {kind: 'W (double bottom)', top, neck, done: px > neck, sig: 'bullish', target: neck + (neck - top)}; }
    add({id: 'g_mw', group: G, label: 'Double top / bottom (M / W)', value: mw ? mw.neck : null,
      text: mw ? `${mw.kind} at ${f(mw.top)}, neckline ${f(mw.neck)} · ${mw.done ? `confirmed (close beyond neckline), measured move to ${f(mw.target)}` : 'forming (neckline not broken)'}` : 'none in the last 60 sessions',
      signal: mw && mw.done ? mw.sig : 'neutral',
      rule: `rule 7: last two swing highs (M) or lows (W) within 60 sessions and within ${th.g_mw_pct}% of each other; confirmed on a close through the neckline; expected move = pattern height. ${GSRC}`,
      plain: mw ? 'Price tested the same level twice. The height of the M/W is his expected move once the neckline breaks.' : 'No twin peaks or troughs right now.', change: mw ? `Confirmation/cancel at the neckline ${f(mw.neck)}.` : 'Forms when a second swing stalls near the first.'});
  } else ['g_sr', 'g_brk', 'g_flip', 'g_mw'].forEach(id => na(id, G, {g_sr: 'Most-touched support / resistance', g_brk: 'Breakout on volume', g_flip: 'Old resistance -> new support', g_mw: 'Double top / bottom'}[id], B.hasHL ? 'needs 60+ sessions' : 'needs high/low bars'));
  const adxR = rows.find(r => r.id === 'adx');
  if (adxR && isNum(adxR.value)) { const ax = adxR.value;
    add({id: 'g_adx', group: G, label: 'ADX trend strength bands', value: ax, signal: 'info',
      text: `ADX ${f(ax, 1)}: ${ax >= th.g_adx_strong ? 'very strong trend' : ax >= th.adx_trend ? 'trend starting / present' : ax <= th.g_adx_side ? 'sideways' : 'in between (no call)'}`,
      rule: `rule 9: <= ${th.g_adx_side} sideways, >= ${th.adx_trend} trend starting, ~${th.g_adx_strong} very strong; lagging, combine with OBV and the SMA cross. ${GSRC}`,
      plain: 'How strong the trend is, regardless of direction; +DI/-DI (in the ADX row) give the direction.', change: `Crossing ${th.g_adx_side} / ${th.adx_trend} / ${th.g_adx_strong}.`}); }
  na('g_intraday', G, 'VWAP + 8/21 EMA + 200 MA (intraday)', 'his rule 10 is intraday-only; we store daily bars, so it is not computed (not faked)');

  // Trend regime tag
  const sa = last(ma.sma50), sb = last(ma.sma200), sa20 = ma.sma50[n - 21];
  let regime = 'Insufficient history', rsig = 'n/a';
  if (sa != null && sb != null) {
    const slp = sa20 != null ? sa - sa20 : 0;
    const adxRow = rows.find(r => r.id === 'adx'), weak = adxRow && isNum(adxRow.value) && adxRow.value < th.adx_trend;
    if (px > sa && sa > sb && slp > 0) { regime = weak ? 'Uptrend (weak momentum)' : 'Uptrend'; rsig = 'bullish'; }
    else if (px < sa && sa < sb && slp < 0) { regime = weak ? 'Downtrend (weak momentum)' : 'Downtrend'; rsig = 'bearish'; }
    else if (weak) { regime = 'Range-bound'; rsig = 'neutral'; }
    else { regime = 'Transition / mixed'; rsig = 'neutral'; }
  } else if (sa != null) { regime = px > sa ? 'Above SMA50 (short history)' : 'Below SMA50 (short history)'; rsig = 'neutral'; }
  add({id: 'regime', group: 'Trend', label: 'Trend regime', value: null, text: regime, signal: rsig,
    rule: `Uptrend = close > SMA50 > SMA200 and SMA50 rising over 20 sessions; Downtrend = mirror; Range-bound = neither and ADX < ${th.adx_trend}; else Transition. "(weak momentum)" if ADX < ${th.adx_trend}`,
    plain: 'One-word read of the moving-average stack, used by the strategy engine as the "trend" input.', change: 'Changes when price crosses SMA50 or the averages re-order.'});

  return {asof: d[n - 1], n, px, rows, summary: summarize(rows), series, notes, hasHL: B.hasHL, hasV: B.hasV, regime, trend: rsig === 'bullish' ? 'up' : rsig === 'bearish' ? 'down' : 'flat', rv, th};
}

function summarize(rows) {
  const s = {bullish: 0, bearish: 0, neutral: 0, overbought: 0, oversold: 0, info: 0, na: 0, counted: 0};
  for (const r of rows) { if (r.signal === 'n/a') s.na++; else if (s[r.signal] != null) s[r.signal]++; }
  s.counted = s.bullish + s.bearish + s.neutral + s.overbought + s.oversold;
  const net = s.bullish - s.bearish;
  s.label = !s.counted ? 'No signals' : net >= Math.max(3, s.counted * 0.4) ? 'Mostly bullish' : net <= -Math.max(3, s.counted * 0.4) ? 'Mostly bearish' : net > 0 ? 'Leaning bullish' : net < 0 ? 'Leaning bearish' : 'Mixed';
  s.rule = 'Counts the signal word of each directional row (info rows and n/a excluded). Mostly = net (bullish - bearish) >= max(3, 40% of counted rows); Leaning = net of 1+ in either direction; overbought/oversold counted separately as stretch warnings.';
  return s;
}

/* ---------------- render ---------------- */
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));
const SIGCLS = {bullish: 'tg-bull', bearish: 'tg-bear', overbought: 'tg-ob', oversold: 'tg-os', neutral: 'tg-neu', info: 'tg-info', 'n/a': 'tg-na'};
const pxCache = {};
async function getPx(t) {
  if (pxCache[t]) return pxCache[t];
  try { const r = await fetch(`data/px/${encodeURIComponent(t)}.json`, {cache: 'no-store'}); if (!r.ok) throw new Error('HTTP ' + r.status); pxCache[t] = await r.json(); }
  catch (e) { pxCache[t] = {t, bars: [], err: String(e && e.message || e)}; }
  return pxCache[t];
}
function coreData() { try { return root.SO2 && root.SO2.D ? root.SO2.D() : null; } catch (e) { return null; } }
function ctxFor(t, core) {
  const ctx = {th: loadThresholds()};
  if (!core) return ctx;
  ctx.spy = core.spy_close || null;
  const r = (core.rows || []).find(x => x.t === t);
  if (r) {
    const peers = core.rows.filter(x => x.sec === r.sec && isNum(x.m1)).map(x => x.m1).sort((a, b) => a - b);
    ctx.own1m = r.m1; ctx.sector = r.sec; ctx.sectorN = peers.length;
    ctx.sectorMedian1m = peers.length ? (peers.length % 2 ? peers[(peers.length - 1) / 2] : (peers[peers.length / 2 - 1] + peers[peers.length / 2]) / 2) : null;
  }
  return ctx;
}
async function get(t) { // used by the chat API
  t = String(t || '').toUpperCase(); const p = await getPx(t), core = coreData();
  const a = analyze(p.bars, ctxFor(t, core));
  return {ticker: t, asof: a.asof, sessions: a.n, source: (p.prov && p.prov.price) ? `${p.prov.price.provider}; ${p.prov.price.field}; retrieved ${p.prov.price.retrieved_at}` : 'data/px bars (Yahoo Finance via yfinance)',
    method: 'computed in-browser from stored daily OHLCV (app/technicals.js); signal words from documented rules', notes: a.notes, regime: a.regime,
    summary: a.summary, indicators: a.rows.map(r => ({id: r.id, label: r.label, value: isNum(r.value) ? +r.value.toFixed(4) : null, text: r.text, signal: r.signal, rule: r.rule, plain: r.plain, unavailable: r.unavailable}))};
}

function svgLine(vals, x0, w, y, color, dash) {
  let p = '', pen = false;
  vals.forEach((v, i) => { if (!isNum(v)) { pen = false; return; } p += (pen ? 'L' : 'M') + (x0 + i * w).toFixed(1) + ' ' + y(v).toFixed(1); pen = true; });
  return p ? `<path d="${p}" fill="none" stroke="${color}" stroke-width="1.2"${dash ? ' stroke-dasharray="3 2"' : ''}/>` : '';
}
function priceSvg(a, on, N) {
  const W = 640, H = 220, pad = 34, L = a.series.c.length, s = Math.max(0, L - N), sl = arr => arr ? arr.slice(s) : [];
  const c = sl(a.series.c); if (c.length < 2) return '<div class="tc-empty">not enough bars to draw</div>';
  const lines = [['sma20', '#e3b341'], ['sma50', '#58a6ff'], ['sma100', '#a371f7'], ['sma200', '#f778ba'], ['ema20', '#e3b341', 1], ['ema50', '#58a6ff', 1]];
  let vals = [...c];
  for (const [k] of lines) if (on[k]) vals = vals.concat(sl(a.series[k]).filter(isNum));
  if (on.bb && a.series.bb) vals = vals.concat(sl(a.series.bb.up).filter(isNum), sl(a.series.bb.lo).filter(isNum));
  const mn = Math.min(...vals), mx = Math.max(...vals), w = (W - pad) / (c.length - 1), y = v => 6 + (H - 20) * (1 - (v - mn) / ((mx - mn) || 1));
  let g = '';
  for (let k = 0; k <= 4; k++) { const v = mn + (mx - mn) * k / 4; g += `<line x1="0" x2="${W - pad}" y1="${y(v)}" y2="${y(v)}" class="tc-grid"/><text x="${W - pad + 3}" y="${y(v) + 3}" class="tc-ax">${v.toFixed(v > 100 ? 0 : 2)}</text>`; }
  if (on.bb && a.series.bb) g += svgLine(sl(a.series.bb.up), 0, w, y, '#8b949e', 1) + svgLine(sl(a.series.bb.lo), 0, w, y, '#8b949e', 1);
  if (on.sr) { const sr = a.rows.find(r => r.id === 'sr'); if (sr && sr.levels) { for (const v of sr.levels.sup.slice(0, 2)) if (v >= mn) g += `<line x1="0" x2="${W - pad}" y1="${y(v)}" y2="${y(v)}" stroke="#3fb950" stroke-dasharray="5 3"/>`; for (const v of sr.levels.res.slice(0, 2)) if (v <= mx) g += `<line x1="0" x2="${W - pad}" y1="${y(v)}" y2="${y(v)}" stroke="#f85149" stroke-dasharray="5 3"/>`; } }
  g += svgLine(c, 0, w, y, 'currentColor');
  for (const [k, col, dash] of lines) if (on[k]) g += svgLine(sl(a.series[k]), 0, w, y, col, dash);
  const d = a.series.d;
  g += `<text x="0" y="${H - 2}" class="tc-ax">${esc(d[s])}</text><text x="${W - pad}" y="${H - 2}" class="tc-ax" text-anchor="end">${esc(d[L - 1])}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" class="tc-svg" role="img" aria-label="price with overlays">${g}</svg>`;
}
function subSvg(arrs, N, lo, hi, levels, label) {
  const W = 640, H = 70, pad = 34, L = arrs[0][0].length, s = Math.max(0, L - N);
  const cut = arrs.map(([a, col]) => [a.slice(s), col]);
  let all = []; cut.forEach(([a]) => { all = all.concat(a.filter(isNum)); });
  if (!all.length) return '';
  const mn = lo != null ? lo : Math.min(...all, 0), mx = hi != null ? hi : Math.max(...all, 0), w = (W - pad) / (cut[0][0].length - 1 || 1), y = v => 4 + (H - 8) * (1 - (v - mn) / ((mx - mn) || 1));
  let g = (levels || []).map(v => `<line x1="0" x2="${W - pad}" y1="${y(v)}" y2="${y(v)}" class="tc-grid"/><text x="${W - pad + 3}" y="${y(v) + 3}" class="tc-ax">${v}</text>`).join('');
  cut.forEach(([a, col]) => { g += svgLine(a, 0, w, y, col); });
  return `<div class="tc-subl">${esc(label)}</div><svg viewBox="0 0 ${W} ${H}" class="tc-svg tc-sub">${g}</svg>`;
}

const UI = {on: {sma20: true, sma50: true, sma200: true, bb: false, sr: true, rsi: true, macd: true, stoch: false, obv: false}, N: 126, showRules: false};
function render(el, t, a, p) {
  const s = a.summary, th = a.th || DEFAULTS;
  const src = p.prov && p.prov.price ? `${p.prov.price.provider} · ${p.prov.price.field}` : 'Yahoo Finance via yfinance';
  const chk = (k, lab) => `<label class="tc-chk"><input type="checkbox" data-on="${k}"${UI.on[k] ? ' checked' : ''}> ${lab}</label>`;
  const groups = {};
  for (const r of a.rows) (groups[r.group] = groups[r.group] || []).push(r);
  const rowsHtml = Object.keys(groups).map(gname => `<tr class="tc-gh"><td colspan="4">${esc(gname)}</td></tr>` + groups[gname].map(r =>
    `<tr data-tip="${esc('Rule: ' + (r.rule || 'n/a') + (r.change ? '\nWhat would change it: ' + r.change : ''))}"><td class="tc-l">${esc(r.label)}</td><td class="tc-v">${esc(r.text)}</td>
     <td><span class="tc-tag ${SIGCLS[r.signal] || ''}" title="${esc(r.rule)}">${esc(r.signal)}</span></td><td class="tc-p">${esc(r.unavailable ? 'Unavailable: ' + r.unavailable : r.plain)}${r.change && !r.unavailable ? ` <span class="tc-ch">${esc(r.change)}</span>` : ''}</td></tr>`).join('')).join('');
  const thEdit = Object.keys(DEFAULTS).map(k => `<label>${esc(k)} <input type="number" step="any" data-th="${k}" value="${esc(th[k])}"></label>`).join('');
  const S = a.series;
  let subs = '';
  if (UI.on.rsi && S.rsi) subs += subSvg([[S.rsi, '#e3b341']], UI.N, 0, 100, [th.rsi_os, 50, th.rsi_ob], 'RSI(14)');
  if (UI.on.macd && S.macd) subs += subSvg([[S.macd.macd, '#58a6ff'], [S.macd.signal, '#f0883e'], [S.macd.hist, '#8b949e']], UI.N, null, null, [0], 'MACD 12/26/9 (blue) · signal (orange) · hist (grey)');
  if (UI.on.stoch && S.stoch) subs += subSvg([[S.stoch.k, '#58a6ff'], [S.stoch.d, '#f0883e']], UI.N, 0, 100, [th.stoch_os, th.stoch_ob], 'Stochastic %K / %D');
  if (UI.on.obv && S.obv) subs += subSvg([[S.obv, '#3fb950']], UI.N, null, null, [], 'On-balance volume');
  el.innerHTML = `<div class="tc">
    <div class="tc-head"><b>${esc(t)} technicals</b> <span class="dim">as of ${esc(a.asof || 'n/a')} close · ${a.n} sessions · ${esc(src)} · computed in-browser</span></div>
    ${a.notes.length ? `<div class="tc-note">${a.notes.map(esc).join('<br>')}</div>` : ''}
    <div class="tc-score"><div class="tc-big ${s.bullish > s.bearish ? 'tg-bull' : s.bearish > s.bullish ? 'tg-bear' : 'tg-neu'}">${esc(s.label)}</div>
      <div class="tc-counts"><span class="tg-bull">${s.bullish} bullish</span> · <span class="tg-neu">${s.neutral} neutral</span> · <span class="tg-bear">${s.bearish} bearish</span> · <span class="tg-ob">${s.overbought} overbought</span> · <span class="tg-os">${s.oversold} oversold</span> <span class="dim">(${s.info} info, ${s.na} n/a)</span></div>
      <div class="tc-reg">Trend regime: <b>${esc(a.regime || 'n/a')}</b></div>
      <button class="tc-btn" data-act="rules">${UI.showRules ? 'Hide' : 'Show'} rules + thresholds</button></div>
    ${UI.showRules ? `<div class="tc-rules"><div>${esc(s.rule)}</div><ol>${a.rows.filter(r => r.rule).map(r => `<li><b>${esc(r.label)}</b>: ${esc(r.rule)}</li>`).join('')}</ol>
      <div class="tc-th">${thEdit}</div><button class="tc-btn" data-act="reset">Reset thresholds</button> <span class="dim">saved in this browser only (${LS_KEY})</span></div>` : ''}
    <div class="tc-ctl">${chk('sma20', 'SMA20')}${chk('sma50', 'SMA50')}${chk('sma100', 'SMA100')}${chk('sma200', 'SMA200')}${chk('ema20', 'EMA20')}${chk('ema50', 'EMA50')}${chk('bb', 'Bollinger')}${chk('sr', 'S/R pivots')}
      | ${chk('rsi', 'RSI')}${chk('macd', 'MACD')}${chk('stoch', 'Stoch')}${chk('obv', 'OBV')}
      <select data-act="n">${[[63, '3M'], [126, '6M'], [252, '1Y']].map(([v, l]) => `<option value="${v}"${UI.N === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
    ${priceSvg(a, UI.on, UI.N)}${subs}
    <table class="tc-tbl"><thead><tr><th>Indicator</th><th>Value</th><th>Signal</th><th>What it says / what would change it</th></tr></thead><tbody>${rowsHtml}</tbody></table>
    <div class="tc-foot dim">Education, not advice. Signal words are mechanical outputs of the rules shown (hover a row); they describe past bars, not future prices.</div></div>`;
}
async function mount(el, ticker) {
  if (!el) return; const t = String(ticker || '').toUpperCase();
  el.innerHTML = '<div class="tc dim">loading technicals...</div>';
  const p = await getPx(t);
  const draw = () => { const a = analyze(p.bars, ctxFor(t, coreData())); render(el, t, a, p); return a; };
  if (!p.bars || !p.bars.length) { el.innerHTML = `<div class="tc"><div class="tc-note">No stored price history for ${esc(t)}${p.err ? ' (' + esc(p.err) + ')' : ''}. Technicals unavailable.</div></div>`; return null; }
  if (!el._tcBound) {
    el._tcBound = true;
    el.addEventListener('change', e => {
      const x = e.target;
      if (x.dataset.on) { UI.on[x.dataset.on] = x.checked; el._tcDraw(); }
      else if (x.dataset.act === 'n') { UI.N = +x.value; el._tcDraw(); }
      else if (x.dataset.th) { const th = loadThresholds(); const v = parseFloat(x.value); if (isFinite(v)) { th[x.dataset.th] = v; saveThresholds(th); } el._tcDraw(); }
    });
    el.addEventListener('click', e => {
      const b = e.target.closest('[data-act]'); if (!b || b.tagName === 'SELECT') return;
      if (b.dataset.act === 'rules') { UI.showRules = !UI.showRules; el._tcDraw(); }
      if (b.dataset.act === 'reset') { saveThresholds(Object.assign({}, DEFAULTS)); el._tcDraw(); }
    });
  }
  el._tcDraw = draw;
  return draw();
}

const API = {DEFAULTS, sma, ema, rsi, macd, bollinger, atr, adx, stochastic, obv, realizedVol, pivots, parseBars, analyze, summarize, mount, get, loadThresholds, saveThresholds};
if (typeof module !== 'undefined' && module.exports) module.exports = API;
root.SmartOptionsTech = API;
})(typeof window !== 'undefined' ? window : globalThis);
