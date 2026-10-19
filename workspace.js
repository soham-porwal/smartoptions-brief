/* SmartOptions Brief: Explore workspace math (pure, exported for node tests; window.SmartOptionsWorkspace in a browser).
   Display transforms (index, % change, change in units, standardized, raw, log, invert, visual shift) never feed the
   statistics. Statistics use aligned changes on dates both series observed: consecutive common dates, no forward fill.
   Associations describe history; they are not causes or forecasts. */
'use strict';
(function (root) {
  const isNum = v => typeof v === 'number' && isFinite(v);
  const MAX_SERIES = 6, MAX_SHIFT = 20, MAX_LAG = 5;
  const STORE_KEY = 'so_brief_explore_v1';
  const ID = /^(eq:[A-Z][A-Z0-9.\-]{0,9}|sec:[A-Za-z][A-Za-z &]{1,39}|mac:[a-z0-9_]{2,30})$/;
  const MODES = {
    index: 'Indexed to 100', pct: '% change', change: 'Change in units', z: 'Standardized (z-score)', raw: 'Raw values', log: 'Log scale (natural log)'
  };
  const RANGES = {'1m': 21, '3m': 63, '6m': 126, '1y': 252, all: Infinity};

  /* ---------------- dates and ranges */
  const sorted = h => (h || []).filter(p => p && /^\d{4}-\d{2}-\d{2}$/.test(p[0]) && isNum(p[1])).slice().sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  // Frequency from the median gap between observations (calendar days).
  function frequency(h) {
    const xs = sorted(h); if (xs.length < 3) return 'unknown';
    const gaps = []; for (let i = 1; i < xs.length; i++) gaps.push((Date.parse(xs[i][0]) - Date.parse(xs[i - 1][0])) / 864e5);
    gaps.sort((a, b) => a - b); const g = gaps[gaps.length >> 1];
    return g <= 4 ? 'daily' : g <= 10 ? 'weekly' : g <= 45 ? 'monthly' : 'quarterly';
  }
  // Range bounds from a preset (sessions counted on the longest daily series) or explicit from/to dates.
  function rangeBounds(range, all) {
    const days = [...new Set([].concat(...all.map(s => sorted(s.h).map(p => p[0]))))].sort();
    if (!days.length) return {from: null, to: null};
    if (range && typeof range === 'object') {
      const from = /^\d{4}-\d{2}-\d{2}$/.test(range.from || '') ? range.from : days[0], to = /^\d{4}-\d{2}-\d{2}$/.test(range.to || '') ? range.to : days[days.length - 1];
      return from <= to ? {from, to} : {from: to, to: from};
    }
    const daily = all.filter(s => frequency(s.h) === 'daily').map(s => sorted(s.h).map(p => p[0]));
    const cal = daily.length ? daily.sort((a, b) => b.length - a.length)[0] : days;
    const n = RANGES[range] || RANGES['1y'], to = days[days.length - 1];
    return {from: n === Infinity || n >= cal.length ? cal[0] : cal[cal.length - 1 - n], to};
  }
  const within = (h, b) => sorted(h).filter(p => (!b.from || p[0] >= b.from) && (!b.to || p[0] <= b.to));

  /* ---------------- display transforms (never used by statistics) */
  // Domain check: which modes are valid for this set of series. Returns {ok, reason}.
  function modeValid(mode, series) {
    if (!MODES[mode]) return {ok: false, reason: 'Unknown mode.'};
    const units = [...new Set(series.map(s => s.unit || ''))];
    for (const s of series) {
      const vals = sorted(s.h).map(p => p[1]);
      if (!vals.length) return {ok: false, reason: `${s.label} has no observations in range.`};
      const positive = vals.every(v => v > 0);
      if ((mode === 'index' || mode === 'pct') && s.kind === 'rate') return {ok: false, reason: `Rebasing ${s.label} (a yield, spread or rate) to 100 is not meaningful; use Change in units or Standardized.`};
      if ((mode === 'index' || mode === 'pct' || mode === 'log') && !positive) return {ok: false, reason: `${s.label} has zero or negative values, so ${MODES[mode].toLowerCase()} is undefined.`};
      if (mode === 'z' && vals.length > 1 && Math.max(...vals) === Math.min(...vals)) return {ok: false, reason: `${s.label} is constant in this range, so it cannot be standardized.`};
      if (s.inv && (mode === 'index' || mode === 'pct' || mode === 'log') && !positive) return {ok: false, reason: `Inverting ${s.label} needs positive values.`};
    }
    if ((mode === 'raw' || mode === 'change' || mode === 'log') && units.length > 1) return {ok: false, reason: `${MODES[mode]} needs one shared unit; these series use ${units.join(', ')}. Use Indexed, % change or Standardized.`};
    return {ok: true, reason: ''};
  }
  // Base date for rebasing: the first date on/after `from` where every series has an observation; if the series
  // never share a date (mixed frequencies), each series rebases at its own first in-range observation.
  function baseDate(series, b) {
    const sets = series.map(s => new Set(within(s.h, b).map(p => p[0])));
    if (!sets.length) return null;
    const first = [...sets[0]].sort().find(d => sets.every(x => x.has(d)));
    return first || null;
  }
  function shiftPoints(pts, k) {
    k = Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, k | 0)); if (!k) return pts;
    const dates = pts.map(p => p[0]), out = [];
    for (let j = 0; j < pts.length; j++) { const i = j + k; if (i >= 0 && i < pts.length) out.push([dates[i], pts[j][1], pts[j][2] || pts[j][0]]); }
    return out;
  }
  // Transform one series (already range-cut). Returns [[display date, value, source observation date]]; the source
  // date differs from the display date only for a visually shifted series.
  function transform(s, mode, base) {
    let pts = sorted(s.h);
    if (!pts.length) return [];
    const positiveInv = s.inv && (mode === 'index' || mode === 'pct' || mode === 'log');
    if (positiveInv) pts = pts.map(p => [p[0], 1 / p[1]]);
    const b0 = (base && pts.find(p => p[0] === base)) || pts.find(p => !base || p[0] >= base) || pts[0];
    let out;
    if (mode === 'index') out = pts.map(p => [p[0], 100 * p[1] / b0[1]]);
    else if (mode === 'pct') out = pts.map(p => [p[0], 100 * (p[1] / b0[1] - 1)]);
    else if (mode === 'change') out = pts.map(p => [p[0], p[1] - b0[1]]);
    else if (mode === 'log') out = pts.map(p => [p[0], Math.log(p[1])]);
    else if (mode === 'z') {
      const v = pts.map(p => p[1]), m = v.reduce((a, c) => a + c, 0) / v.length;
      const sd = Math.sqrt(v.reduce((a, c) => a + (c - m) * (c - m), 0) / (v.length - 1 || 1));
      out = pts.map(p => [p[0], sd > 0 ? (p[1] - m) / sd : 0]);
    } else out = pts.map(p => p.slice(0, 2));
    if (s.inv && !positiveInv) out = out.map(p => [p[0], -p[1]]);
    return shiftPoints(out.map(p => [p[0], p[1], p[0]]), s.shift || 0);
  }
  function describeTransform(mode, series, base) {
    const parts = [MODES[mode] + (mode === 'index' || mode === 'pct' || mode === 'change' ? (base ? ` from ${base}, the first date all series share` : ' from each series’ first observation in range (no shared date)') : mode === 'z' ? ': (value − range mean) ÷ range standard deviation' : '') + '.'];
    series.forEach(s => {
      if (s.inv) parts.push(`${s.label} inverted (${mode === 'index' || mode === 'pct' || mode === 'log' ? 'reciprocal, 1 ÷ value' : '−1 × value'}).`);
      if (s.shift) parts.push(`${s.label} shifted ${s.shift > 0 ? '+' : ''}${s.shift} sessions for visual comparison only; statistics use unshifted dates.`);
    });
    // Plain units so the chart can be read aloud without the methods page.
    if (mode === 'index') parts.push(`100 = each series' value on ${base || 'its first date in range'}; 107.48 means +7.48% since then, not $107.48.`);
    if (mode === 'pct') parts.push(`Price change in percent since ${base || 'each first date'}; the legend shows each series' change over the range. Price return only, dividends excluded.`);
    if (mode === 'raw' && series.length === 1 && /^eq:/.test(series[0].id || '')) parts.push('Price in USD per share, daily closes (unadjusted for dividends).');
    return parts.join(' ');
  }

  /* ---------------- statistics on aligned changes */
  function chg(v0, v1, kind) {
    if (kind === 'ret') return v0 > 0 && v1 > 0 ? 100 * (v1 / v0 - 1) : null;
    if (kind === 'diff_bp') return 100 * (v1 - v0);
    return v1 - v0;
  }
  // Changes over consecutive common dates within bounds. lag L pairs y's change on step i with x's change on step i-L.
  function alignChanges(y, x, b, lag) {
    const ym = new Map(within(y.h, b)), xm = new Map(within(x.h, b));
    const common = [...ym.keys()].filter(d => xm.has(d)).sort();
    const acc = {y_obs: ym.size, x_obs: xm.size, common_dates: common.length, y_only: ym.size - common.length, x_only: xm.size - common.length, invalid: 0, lag_dropped: 0};
    const steps = [];
    for (let i = 1; i < common.length; i++) {
      const d0 = common[i - 1], d1 = common[i], cy = chg(ym.get(d0), ym.get(d1), y.chg), cx = chg(xm.get(d0), xm.get(d1), x.chg);
      if (cy == null || cx == null || !isNum(cy) || !isNum(cx)) { acc.invalid++; continue; }
      steps.push({d: d1, y: cy, x: cx});
    }
    const L = Math.max(0, Math.min(MAX_LAG, lag | 0));
    const out = [];
    for (let i = L; i < steps.length; i++) out.push({d: steps[i].d, y: steps[i].y, x: steps[i - L].x, xd: steps[i - L].d});
    acc.lag_dropped = Math.min(L, steps.length); acc.changes = out.length;
    return {pts: out, acc, lag: L};
  }
  function ols(ys, xs) {
    const n = ys.length; if (n < 3) return null;
    const mx = xs.reduce((a, c) => a + c, 0) / n, my = ys.reduce((a, c) => a + c, 0) / n;
    let sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
    if (!(sxx > 0) || !(syy > 0)) return null;
    const beta = sxy / sxx, alpha = my - beta * mx;
    let ssr = 0; for (let i = 0; i < n; i++) { const e = ys[i] - alpha - beta * xs[i]; ssr += e * e; }
    const se = Math.sqrt(ssr / (n - 2) / sxx), r = sxy / Math.sqrt(sxx * syy);
    const tc = tq(n - 2);
    return {n, beta, alpha, se, t: se > 0 ? beta / se : null, r, r2: r * r, mx, sxx, s2: ssr / (n - 2), tcrit: tc, ci95: [beta - tc * se, beta + tc * se]};
  }
  // Pair statistics with sample accounting, half-split stability and fit bounds. Withheld (null + reason) when thin.
  function pairStats(y, x, b, opts) {
    opts = opts || {};
    const fy = frequency(y.h), fx = frequency(x.h);
    if (fy !== 'daily' || fx !== 'daily') return {ok: false, reason: `${fy !== 'daily' ? y.label : x.label} is a ${fy !== 'daily' ? fy : fx} series; pairing it with daily changes would repeat one observation many times, so no statistic is shown.`};
    const a = alignChanges(y, x, b, opts.lag);
    const min = opts.min || 30;
    if (a.pts.length < min) return {ok: false, reason: `Only ${a.pts.length} aligned changes in this range (minimum ${min}).`, acc: a.acc};
    const ys = a.pts.map(p => p.y), xs = a.pts.map(p => p.x), f = ols(ys, xs);
    if (!f) return {ok: false, reason: 'One series is constant in this range; no relationship can be measured.', acc: a.acc};
    const h = ys.length >> 1, f1 = ols(ys.slice(0, h), xs.slice(0, h)), f2 = ols(ys.slice(h), xs.slice(h));
    const q = xs.slice().sort((p, c) => p - c), pick = p => q[Math.min(q.length - 1, Math.max(0, Math.round(p * (q.length - 1))))];
    return Object.assign({ok: true, from: a.pts[0].d, to: a.pts[a.pts.length - 1].d, lag: a.lag, acc: a.acc,
      first_half: f1 && f1.r, second_half: f2 && f2.r, halves_same_sign: !!(f1 && f2 && (f1.r >= 0) === (f2.r >= 0)), x_p5: pick(0.05), x_p95: pick(0.95)}, f);
  }
  function rollingCorr(y, x, b, w) {
    const a = alignChanges(y, x, b, 0).pts, out = [];
    for (let i = w - 1; i < a.length; i++) { const s = a.slice(i - w + 1, i + 1), f = ols(s.map(p => p.y), s.map(p => p.x)); if (f) out.push([a[i].d, f.r]); }
    return out;
  }
  function sma(pts, n) {
    const out = []; let s = 0;
    for (let i = 0; i < pts.length; i++) { s += pts[i][1]; if (i >= n) s -= pts[i - n][1]; if (i >= n - 1) out.push([pts[i][0], s / n]); }
    return out;
  }
  // Two-sided 97.5% Student-t quantile (Cornish-Fisher expansion around the normal; within 0.01 of tables for df >= 10).
  function tq(df) {
    if (!(df > 0)) return null;
    const z = 1.959963984540054, z3 = z * z * z, z5 = z3 * z * z, z7 = z5 * z * z;
    return z + (z3 + z) / (4 * df) + (5 * z5 + 16 * z3 + 3 * z) / (96 * df * df) + (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df * df * df);
  }
  // Conditional scenario from a fitted same-day OLS y = alpha + beta x. For a chosen x change dx it returns:
  //   mean  = alpha + beta dx                         (fitted average y change on days with that x change)
  //   band  = mean +/- t * sqrt(s2 (1/n + (dx-mx)^2/Sxx))      (uncertainty of that average)
  //   range = mean +/- t * sqrt(s2 (1 + 1/n + (dx-mx)^2/Sxx))  (individual days, including day-to-day noise)
  // Withheld outside the central 90% of observed x changes. Descriptive of history, not a forecast.
  function scenario(st, dx, opts) {
    if (!st || !st.ok || !isNum(dx)) return {ok: false, reason: 'No fitted relationship.'};
    if (!isNum(st.x_p5) || !isNum(st.x_p95) || dx < st.x_p5 || dx > st.x_p95) return {ok: false, reason: `That move is outside the central 90% of observed daily moves (${isNum(st.x_p5) ? st.x_p5.toFixed(2) : '?'} to ${isNum(st.x_p95) ? st.x_p95.toFixed(2) : '?'}), so no estimate is given.`};
    if (!(st.n > 2) || !(st.sxx > 0) || !isNum(st.s2)) return {ok: false, reason: 'Fit lacks the residual information for an interval.'};
    const t = opts && isNum(opts.t) ? opts.t : tq(st.n - 2), mean = st.alpha + st.beta * dx, lev = 1 / st.n + Math.pow(dx - st.mx, 2) / st.sxx;
    const seMean = Math.sqrt(st.s2 * lev), sePred = Math.sqrt(st.s2 * (1 + lev));
    return {ok: true, mean, mean_lo: mean - t * seMean, mean_hi: mean + t * seMean, day_lo: mean - t * sePred, day_hi: mean + t * sePred, t, se_mean: seMean, se_pred: sePred};
  }

  // Apply a PRECOMPUTED joint fit. Covariance includes cross terms between the
  // correlated drivers; summing pairwise slopes is deliberately unsupported.
  function jointScenario(model, values) {
    if (!model || !model.available) return {ok:false, reason:model && model.reason || 'No dated joint fit for this asset. Historical overlays remain available.'};
    if (values.length !== model.drivers.length || values.some(v => !isNum(v))) return {ok:false, reason:'Enter both economic moves, in the units shown.'};
    if (values.some((v,i) => v < model.bounds[i][0] || v > model.bounds[i][1])) return {ok:false,reason:'Move outside the central 90% of observed driver changes; estimate withheld.'};
    const v=[1,...values], inv=model.inverse_xtx;
    const lev=v.reduce((s,a,i)=>s+a*v.reduce((t,b,j)=>t+inv[i][j]*b,0),0);
    // A combination individually in bounds may still be far outside the joint sample.
    if (!isNum(lev) || lev < 0 || lev > 9/model.n) return {ok:false, reason:'This combination is far from the joint historical sample; estimate withheld.'};
    const mean=v.reduce((s,a,i)=>s+a*model.coefficients[i],0), m=model.tcrit*Math.sqrt(model.residual_variance*lev), d=model.tcrit*Math.sqrt(model.residual_variance*(1+lev));
    return {ok:true,mean,mean_lo:mean-m,mean_hi:mean+m,day_lo:mean-d,day_hi:mean+d,leverage:lev};
  }

  /* ---------------- live quote onto a daily series */
  const nyDate = ms => new Date(ms).toLocaleDateString('en-CA', {timeZone: 'America/New_York'});
  function nyMinutes(ms) { const p = {}; new Intl.DateTimeFormat('en-US', {timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false}).formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; }); return (+p.hour % 24) * 60 + (+p.minute); }
  // Regular-session test: provider flag 1, or no flag and a trade time between 9:30 and 16:15 ET on a weekday.
  function isRegular(q, ms) {
    if (q.market_hours === 1) return true;
    if (q.market_hours != null) return false;
    const m = nyMinutes(ms), wd = new Date(ms).toLocaleDateString('en-US', {timeZone: 'America/New_York', weekday: 'short'});
    return !['Sat', 'Sun'].includes(wd) && m >= 570 && m <= 975;
  }
  // Fold an accepted quote into daily closes. Returns {status, h, point, note}. Only regular-session trades touch the
  // daily line; extended-session trades are reported separately; old, future or unusable quotes change nothing.
  function liveExtend(h, q, nowMs) {
    const pts = sorted(h), last = pts[pts.length - 1];
    if (!q || !isNum(q.price) || !(q.price > 0)) return {status: 'missing', h: pts};
    if (q.current_usable === false) return {status: 'unusable', h: pts, note: 'Quote is stale or blocked; the chart ends at the last close.'};
    const ms = Date.parse(q.asof_utc || q.ts || '');
    if (!isFinite(ms)) return {status: 'missing', h: pts};
    if (ms > nowMs + 60e3) return {status: 'future', h: pts, note: 'Quote timestamp is in the future; ignored.'};
    const day = nyDate(ms);
    if (!last || day < last[0]) return {status: 'old', h: pts, note: `Quote from ${day} is older than the last close (${last && last[0]}); ignored.`};
    if (!isRegular(q, ms)) return {status: 'extended', h: pts, day, price: q.price, note: `Extended-session trade ${q.price.toFixed(2)} on ${day}; the daily line keeps regular closes.`};
    const point = [day, q.price];
    if (day === last[0]) return {status: 'update', h: pts.slice(0, -1).concat([point]), point, day};
    return {status: 'append', h: pts.concat([point]), point, day};
  }
  // Relative performance of y versus a benchmark over the range, ending on the last date BOTH have (a provisional
  // live point counts only when the benchmark has a point for the same session).
  function relPerf(y, bm, b) {
    const ym = new Map(within(y.h, b)), bmm = new Map(within(bm.h, b));
    const common = [...ym.keys()].filter(d => bmm.has(d)).sort();
    if (common.length < 2) return null;
    const d0 = common[0], d1 = common[common.length - 1];
    const ry = 100 * (ym.get(d1) / ym.get(d0) - 1), rb = 100 * (bmm.get(d1) / bmm.get(d0) - 1);
    const ylast = sorted(y.h).filter(p => !b.to || p[0] <= b.to).pop();
    return {from: d0, to: d1, ry, rb, gap: ry - rb, y_ahead_of_common: ylast && ylast[0] > d1 ? ylast[0] : null};
  }

  /* ---------------- saved state and links */
  function cleanState(s) {
    if (!s || typeof s !== 'object' || !Array.isArray(s.s)) throw new Error('missing series list');
    const seen = new Set(), series = [];
    for (const x of s.s) {
      const id = x && typeof x === 'object' ? x.id : x;
      if (typeof id !== 'string' || !ID.test(id)) throw new Error('invalid series id');
      if (seen.has(id)) continue; seen.add(id);
      series.push({id, inv: !!(x && x.inv), shift: Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, (x && x.shift) | 0))});
    }
    if (series.length > MAX_SERIES) throw new Error('more than ' + MAX_SERIES + ' series');
    const r = typeof s.r === 'string' && RANGES[s.r] !== undefined ? s.r : s.r && typeof s.r === 'object' && /^\d{4}-\d{2}-\d{2}$/.test(s.r.from || '') && /^\d{4}-\d{2}-\d{2}$/.test(s.r.to || '') ? {from: s.r.from, to: s.r.to} : '1y';
    return {s: series, r, m: MODES[s.m] ? s.m : 'index', ind: {sma: !!(s.ind && s.ind.sma), rc: !!(s.ind && s.ind.rc)}, lag: Math.max(0, Math.min(MAX_LAG, s.lag | 0))};
  }
  // Parse device storage. Malformed data is reported, never silently replaced; the caller keeps the raw text.
  function parseStore(raw) {
    if (raw == null || raw === '') return {ok: true, store: {v: 1, current: null, presets: []}, empty: true};
    let o; try { o = JSON.parse(raw); } catch (e) { return {ok: false, reason: 'Saved workspace is not valid JSON.'}; }
    if (!o || o.v !== 1) return {ok: false, reason: 'Saved workspace has an unknown version.'};
    try {
      const presets = (Array.isArray(o.presets) ? o.presets : []).slice(0, 20).map(p => ({name: String(p.name || '').slice(0, 40) || 'Preset', state: cleanState(p.state)}));
      return {ok: true, store: {v: 1, current: o.current ? cleanState(o.current) : null, presets}};
    } catch (e) { return {ok: false, reason: 'Saved workspace failed validation: ' + e.message + '.'}; }
  }
  function serializeStore(store) { return JSON.stringify({v: 1, current: store.current ? cleanState(store.current) : null, presets: (store.presets || []).map(p => ({name: p.name, state: cleanState(p.state)}))}); }
  function encodeHash(st) {
    const s = cleanState(st), q = [];
    q.push('s=' + s.s.map(x => encodeURIComponent(x.id).replace(/%3A/g, ':') + (x.inv ? '~i' : '') + (x.shift ? '~s' + x.shift : '')).join(','));
    if (typeof s.r === 'string') q.push('r=' + s.r); else q.push('from=' + s.r.from, 'to=' + s.r.to);
    q.push('m=' + s.m);
    const ind = ['sma', 'rc'].filter(k => s.ind[k]); if (ind.length) q.push('ind=' + ind.join('.'));
    if (s.lag) q.push('lag=' + s.lag);
    return '#/explore?' + q.join('&');
  }
  // Never throws: malformed percent-encoding, unknown ids or limits come back as {error} for a visible, recoverable notice.
  function decodeHash(hash) {
    const m = String(hash || '').match(/^#?\/explore(?:\?(.*))?$/); if (!m) return null;
    try {
      const p = {}; (m[1] || '').split('&').forEach(kv => { const i = kv.indexOf('='); if (i > 0) p[kv.slice(0, i)] = kv.slice(i + 1); });
      const s = (p.s || '').split(',').filter(Boolean).map(tok => {
        const parts = tok.split('~'); let id;
        try { id = decodeURIComponent(parts[0]); } catch (e) { throw new Error('the link has malformed character encoding'); }
        const o = {id}; parts.slice(1).forEach(f => { if (f === 'i') o.inv = true; else if (f[0] === 's') o.shift = parseInt(f.slice(1), 10) || 0; }); return o;
      });
      return cleanState({s, r: p.from && p.to ? {from: p.from, to: p.to} : p.r || '1y', m: p.m, ind: {sma: /sma/.test(p.ind || ''), rc: /rc/.test(p.ind || '')}, lag: parseInt(p.lag || '0', 10)});
    } catch (e) { return {error: e.message}; }
  }

  const API = {MAX_SERIES, MAX_SHIFT, MAX_LAG, STORE_KEY, MODES, RANGES, ID, frequency, rangeBounds, within, modeValid, baseDate, transform, shiftPoints, describeTransform,
    chg, alignChanges, ols, tq, pairStats, rollingCorr, sma, scenario, jointScenario, nyDate, isRegular, liveExtend, relPerf, cleanState, parseStore, serializeStore, encodeHash, decodeHash};
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.SmartOptionsWorkspace = API;
})(typeof window !== 'undefined' ? window : globalThis);
