/* R6: Flow view, the client's top-down morning funnel (Market -> Volatility -> Names -> Plan).
   Every verdict comes from a documented rule over MEASURED inputs in data/core.json; thresholds are
   defaults the user can edit (Rules button, saved in localStorage). Missing inputs stay missing and
   are excluded from the vote with a reason. Playbook = education, association not causation, no orders. */
(function (root) {
  'use strict';
  const RKEY = 'so_flow_rules_v1', WKEY = 'so_watchlist_v1';
  const fin = v => typeof v === 'number' && Number.isFinite(v);

  /* ---------- rule defaults (all tunable; these are OUR chosen defaults, not market standards) ---------- */
  const DEFAULT_RULES = {
    regimeBull: 60, regimeBear: 40,          // Sam's regime score (0-100)
    breadthPP: 1.0,                          // RSP-SPY 20d, pp: > +x broad, < -x narrow
    rate20dBp: 15,                           // 10Y 20-session change, bp: rising fast = headwind
    hy20dBp: 25,                             // HY OAS 20-session change, bp: widening = risk-off
    leanVotes: 2,                            // sum of votes >= +x lean bullish, <= -x lean bearish
    minInputs: 4,                            // fewer measured inputs -> "insufficient data"
    vixLow: 15, vixElev: 20, vixStress: 30,  // VIX level bands
    valCheap: 0.85, valRich: 1.15,           // fwd P/E vs sector median ratio
    upsideMin: 10,                           // analyst mean-target upside % for a positive vote
    strongVotes: 2,                          // name: sum >= x STRONG, <= -x WEAK
    ivRich: 1.20, ivCheap: 1.10,             // ATM IV / 20d realized vol
    catalystDays: 14,                        // earnings inside this many days = catalyst
    dteDefault: 30,                          // horizon for expected move when no IV expiry is stored
    quarantineStaleSam: 1,                   // 1 = quarantine >30d snapshot from live directional vote
    alpha20dMin: 3.0,                        // 20d idiosyncratic residual % threshold for alpha vote
  };
  const RULE_LABELS = {
    regimeBull: 'Regime score >= (bull vote)', regimeBear: 'Regime score <= (bear vote)', breadthPP: 'Breadth RSP-SPY 20d, +/- pp',
    rate20dBp: '10Y 20d change, +/- bp', hy20dBp: 'HY OAS 20d change, +/- bp', leanVotes: 'Market lean needs |votes| >=',
    minInputs: 'Min measured inputs', vixLow: 'VIX low below', vixElev: 'VIX elevated at/above', vixStress: 'VIX stress at/above',
    valCheap: 'Fwd P/E vs sector: cheap below x', valRich: 'Fwd P/E vs sector: rich above x', upsideMin: 'Analyst upside >= % (positive vote)',
    strongVotes: 'Name STRONG/WEAK needs |votes| >=', ivRich: 'IV/RV rich at/above', ivCheap: 'IV/RV not rich at/below',
    catalystDays: 'Earnings catalyst within days', dteDefault: 'Default horizon, days',
    quarantineStaleSam: 'Quarantine stale (>30d) snapshot vote (1=yes, 0=no)', alpha20dMin: '20d factor residual alpha +/- %',
  };

  /* ---------- pure math ---------- */
  function sma(vals, n) { if (!Array.isArray(vals) || vals.length < n) return null; let s = 0; for (let i = vals.length - n; i < vals.length; i++) { if (!fin(vals[i])) return null; s += vals[i]; } return s / n; }
  function realizedVol(closes, n) {
    if (!Array.isArray(closes) || closes.length < n + 1) return null;
    const c = closes.slice(-(n + 1)); const r = [];
    for (let i = 1; i < c.length; i++) { if (!fin(c[i]) || !fin(c[i - 1]) || c[i - 1] <= 0 || c[i] <= 0) return null; r.push(Math.log(c[i] / c[i - 1])); }
    const m = r.reduce((a, b) => a + b, 0) / r.length; const v = r.reduce((a, b) => a + (b - m) * (b - m), 0) / (r.length - 1);
    return Math.sqrt(v) * Math.sqrt(252) * 100;
  }
  function pctRank(hist, v) { const xs = (hist || []).map(p => Array.isArray(p) ? p[1] : p).filter(fin); if (!xs.length || !fin(v)) return null; return Math.round(100 * xs.filter(x => x <= v).length / xs.length); }
  function chgN(hist, n) { const xs = (hist || []).filter(p => Array.isArray(p) && fin(p[1])); if (xs.length < n + 1) return null; return xs[xs.length - 1][1] - xs[xs.length - 1 - n][1]; }
  function pctChgN(hist, n) { const xs = (hist || []).filter(p => Array.isArray(p) && fin(p[1])); if (xs.length < n + 1 || xs[xs.length - 1 - n][1] === 0) return null; return 100 * (xs[xs.length - 1][1] / xs[xs.length - 1 - n][1] - 1); }
  // z of the latest n-session change vs the distribution of all n-session changes in the history
  function moveZ(hist, n, pct) {
    const xs = (hist || []).filter(p => Array.isArray(p) && fin(p[1])).map(p => p[1]); if (xs.length < n + 30) return null;
    const ch = []; for (let i = n; i < xs.length; i++) ch.push(pct ? (xs[i - n] ? 100 * (xs[i] / xs[i - n] - 1) : NaN) : xs[i] - xs[i - n]);
    const ok = ch.filter(fin); const last = ok[ok.length - 1]; const m = ok.reduce((a, b) => a + b, 0) / ok.length;
    const sd = Math.sqrt(ok.reduce((a, b) => a + (b - m) * (b - m), 0) / (ok.length - 1)); return sd > 0 ? (last - m) / sd : null;
  }
  const median = xs => { const s = xs.filter(fin).sort((a, b) => a - b); if (!s.length) return null; const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };

  /* ---------- data access ---------- */
  function obs(D, id) { for (const g in (D.macro || {})) { const o = (D.macro[g] || []).find(x => x.id === id); if (o) return o; } return null; }
  const src = o => o ? {provider: o.provider, series: o.series, url: o.url, period: o.period, status: o.status} : null;

  /* ---------- L1 MARKET ---------- */
  // Each input votes +1 (bullish), -1 (bearish), 0 (neutral) or is missing (excluded, reason shown).
  function marketInputs(D, R) {
    const out = [];
    const spy = (D.spy_close || []).map(p => p[1]);
    const px = spy.length ? spy[spy.length - 1] : null, s50 = sma(spy, 50), s200 = sma(spy, 200);
    const spySrc = {provider: 'Yahoo via yfinance', series: 'SPY Adj Close', period: (D.spy_close || []).length ? D.spy_close[D.spy_close.length - 1][0] : null};
    const add = (id, label, value, disp, vote, rule, source, why) => out.push({id, label, value, disp, vote, rule, source, why: why || null});
    add('spy50', 'SPY vs 50-day avg', fin(px) && fin(s50) ? 100 * (px / s50 - 1) : null, fin(px) && fin(s50) ? `${px.toFixed(2)} vs ${s50.toFixed(2)}` : null,
      fin(px) && fin(s50) ? (px > s50 ? 1 : -1) : null, 'above = +1, below = -1', spySrc, fin(s50) ? null : 'needs 50 sessions of SPY closes');
    add('spy200', 'SPY vs 200-day avg', fin(px) && fin(s200) ? 100 * (px / s200 - 1) : null, fin(px) && fin(s200) ? `${px.toFixed(2)} vs ${s200.toFixed(2)}` : null,
      fin(px) && fin(s200) ? (px > s200 ? 1 : -1) : null, 'above = +1, below = -1', spySrc, fin(s200) ? null : 'needs 200 sessions of SPY closes');
    const rg = (D.rel || {}).regime || {};
    add('regime', 'Regime score (V2 proxy)', fin(rg.score) ? rg.score : null, fin(rg.score) ? `${rg.score} ${rg.tier || ''}`.trim() : null,
      fin(rg.score) ? (rg.score >= R.regimeBull ? 1 : rg.score <= R.regimeBear ? -1 : 0) : null, `>= ${R.regimeBull} = +1, <= ${R.regimeBear} = -1`,
      {provider: 'SmartOptions regime (VIX, A/D, new hi/lo)', series: 'rel.regime', period: D.asof_session, note: rg.method}, fin(rg.score) ? null : 'regime score missing');
    const vb = (D.rel || {}).vol_breadth || {}, br = vb.breadth_rsp_spy_20d || {};
    add('breadth', 'Breadth: RSP - SPY 20d', fin(br.value) ? br.value : null, fin(br.value) ? `${br.value > 0 ? '+' : ''}${br.value.toFixed(2)} pp` : null,
      fin(br.value) ? (br.value > R.breadthPP ? 1 : br.value < -R.breadthPP ? -1 : 0) : null, `> +${R.breadthPP} pp = +1 (broad), < -${R.breadthPP} pp = -1 (narrow)`,
      {provider: 'Yahoo via yfinance', series: 'RSP, SPY 20-session return', period: D.asof_session}, fin(br.value) ? null : 'RSP/SPY breadth missing');
    const t10 = obs(D, 'us10y'), c10 = t10 ? chgN(t10.h, 20) : null, c10bp = fin(c10) ? c10 * 100 : null;
    add('rates', '10Y yield 20d change', c10bp, fin(c10bp) ? `${t10.v.toFixed(2)}% (${c10bp > 0 ? '+' : ''}${c10bp.toFixed(0)} bp)` : null,
      fin(c10bp) ? (c10bp > R.rate20dBp ? -1 : c10bp < -R.rate20dBp ? 1 : 0) : null, `> +${R.rate20dBp} bp = -1 (headwind), < -${R.rate20dBp} bp = +1`, src(t10), fin(c10bp) ? null : '10Y history too short or missing');
    const hy = obs(D, 'hy_oas'), chy = hy ? chgN(hy.h, 20) : null;
    add('credit', 'HY credit spread 20d change', chy, fin(chy) ? `${hy.v.toFixed(0)} bp (${chy > 0 ? '+' : ''}${chy.toFixed(0)})` : null,
      fin(chy) ? (chy > R.hy20dBp ? -1 : chy < -R.hy20dBp ? 1 : 0) : null, `widening > ${R.hy20dBp} bp = -1, tightening > ${R.hy20dBp} bp = +1`, src(hy), fin(chy) ? null : 'HY OAS history missing');
    const tr = vb.term_ratio || {};
    add('term', 'VIX / VIX3M term ratio', fin(tr.value) ? tr.value : null, fin(tr.value) ? tr.value.toFixed(3) : null,
      fin(tr.value) ? (tr.value > 1 ? -1 : 0) : null, '> 1.0 (backwardation) = -1, else 0', {provider: 'Cboe', series: 'VIX, VIX3M', period: (obs(D, 'vix') || {}).period}, fin(tr.value) ? null : 'term ratio missing');
    const s2 = obs(D, 'spread_10y_2y');
    add('curve', '10Y-2Y curve (context)', s2 && fin(s2.v) ? s2.v : null, s2 && fin(s2.v) ? `${s2.v.toFixed(0)} bp` : null, null, 'context only, no vote', src(s2), s2 ? 'context only (no vote)' : 'curve missing');
    const dx = obs(D, 'dxy'), dx20 = dx ? pctChgN(dx.h, 20) : null;
    add('dxy', 'Dollar DXY 20d (context)', dx20, fin(dx20) ? `${dx.v.toFixed(2)} (${dx20 > 0 ? '+' : ''}${dx20.toFixed(1)}%)` : null, null, 'context only, no vote', src(dx), 'context only (no vote)');
    const wt = obs(D, 'wti'), wt20 = wt ? pctChgN(wt.h, 20) : null;
    add('wti', 'WTI crude 20d (context)', wt20, fin(wt20) ? `$${wt.v.toFixed(2)} (${wt20 > 0 ? '+' : ''}${wt20.toFixed(1)}%)` : null, null, 'context only, no vote', src(wt), 'context only (no vote)');
    out.push({id: 'putcall', label: 'Put/call ratio', value: null, disp: null, vote: null, rule: 'n/a', source: null, why: 'unavailable: no put/call source in this build'});
    out.push({id: 'aaii', label: 'Survey sentiment (AAII etc.)', value: null, disp: null, vote: null, rule: 'n/a', source: null, why: 'unavailable: no licensed sentiment survey source'});
    return out;
  }
  function marketVerdict(inputs, R) {
    const voting = inputs.filter(i => fin(i.vote)); const sum = voting.reduce((a, i) => a + i.vote, 0);
    if (voting.length < R.minInputs) return {word: 'Insufficient data', cls: 'na', sum, n: voting.length};
    const word = sum >= R.leanVotes ? 'Lean bullish' : sum <= -R.leanVotes ? 'Lean bearish' : 'Neutral';
    return {word, cls: sum >= R.leanVotes ? 'up' : sum <= -R.leanVotes ? 'dn' : 'neu', sum, n: voting.length};
  }
  // "What could shake it": the macro factors moving most vs their own 1y distribution of 20-session moves.
  function shakers(D) {
    const defs = [['us10y', 'rates', '10Y yield', false, 'bp', 100], ['dxy', 'dollar', 'Dollar (DXY)', true, '%', 1], ['wti', 'oil', 'WTI crude', true, '%', 1],
      ['vix', 'vol', 'VIX', false, 'pt', 1], ['hy_oas', 'credit', 'HY credit spread', false, 'bp', 1]];
    const ins = ((D.rel || {}).insights || []);
    const out = defs.map(([id, iid, label, pct, u, mul]) => {
      const o = obs(D, id); if (!o) return {id, label, z: null, why: 'series missing'};
      const ch = pct ? pctChgN(o.h, 20) : chgN(o.h, 20); const z = moveZ(o.h, 20, pct);
      const card = ins.find(c => c.id === iid) || null;
      return {id, label, chg: fin(ch) ? ch * mul : null, unit: u, z, period: o.period, source: src(o), insight: card,
        exposed: card ? (card.exposed || []).slice(0, 3) : [], watch: card && card.watch ? card.watch[0] : null};
    });
    return out.filter(x => fin(x.z)).sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, 3);
  }
  function upcoming(D, names, nowMs, days, watchTickers) {
    const end = nowMs + days * 864e5, ev = [];
    const watched = new Set(watchTickers || names.map(r => r.t));
    for (const e of (D.calendar || [])) { const t = Date.parse(e.scheduled_et); if (fin(t) && t >= nowMs - 6 * 36e5 && t <= end) ev.push({kind: 'macro', type: e.type, title: e.title, t, src: e.source_url, status: e.status}); }
    for (const r of names) if (r.er && fin(r.ern) && r.ern >= 0 && r.ern <= days) ev.push({kind: 'earn', type: 'EARN', title: `${r.t} earnings${r.ert ? ' ' + r.ert : ''}`, t: Date.parse(r.er + 'T12:00:00'), tk: r.t, src: r.ers, watched: watched.has(r.t)});
    const priority = e => e.kind === 'macro' ? 0 : e.watched ? 1 : 2;
    return ev.sort((a, b) => priority(a) - priority(b) || a.t - b.t || a.title.localeCompare(b.title));
  }

  /* ---------- L2 VOLATILITY ---------- */
  function volInputs(D) {
    const v = obs(D, 'vix'), vb = (D.rel || {}).vol_breadth || {};
    return {vix: v && fin(v.v) ? v.v : null, vixPct: v ? pctRank(v.h, v.v) : null, vix5d: v ? chgN(v.h, 5) : null, period: v ? v.period : null,
      term: fin((vb.term_ratio || {}).value) ? vb.term_ratio.value : null, vrp: fin((vb.vrp || {}).value) ? vb.vrp.value : null,
      vix9d: (obs(D, 'vix9d') || {}).v, vix3m: (obs(D, 'vix3m') || {}).v, source: src(v), hist: v ? v.h : null};
  }
  function volVerdict(x, R) {
    if (!fin(x.vix)) return {word: 'Unknown', cls: 'na', why: 'VIX missing'};
    let lvl = x.vix >= R.vixStress ? 3 : x.vix >= R.vixElev ? 2 : x.vix >= R.vixLow ? 1 : 0;
    const bumped = fin(x.term) && x.term > 1 && lvl < 2; if (bumped) lvl = 2;   // backwardation: at least elevated
    const word = ['Low', 'Normal', 'Elevated', 'Stress'][lvl];
    const trend = fin(x.vix5d) ? (x.vix5d > 1 ? 'rising' : x.vix5d < -1 ? 'falling' : 'flat') : null;
    return {word, lvl, cls: ['up', 'neu', 'warn', 'dn'][lvl], bumped, trend,
      premium: fin(x.vrp) ? (x.vrp > 0 ? 'implied above realized (premium rich)' : 'implied below realized (premium thin)') : null};
  }

  /* ---------- L3 NAMES ---------- */
  function sectorPE(rows) { const by = {}; for (const r of rows) if (r.sec && fin(r.pef) && r.pef > 0) (by[r.sec] = by[r.sec] || []).push(r.pef); const m = {}; for (const s in by) m[s] = {med: median(by[s]), n: by[s].length}; return m; }
  function nameDrivers(r, secPE, R) {
    const d = [];
    const sp = secPE[r.sec];
    if (fin(r.pef) && r.pef > 0 && sp && fin(sp.med) && sp.n >= 5) {
      const ratio = r.pef / sp.med;
      d.push({k: 'val', label: 'Valuation', vote: ratio < R.valCheap ? 1 : ratio > R.valRich ? -1 : 0, chip: `fP/E ${r.pef.toFixed(1)} = ${ratio.toFixed(2)}x sector`,
        detail: `forward P/E ${r.pef.toFixed(1)} vs ${r.sec} median ${sp.med.toFixed(1)} (n=${sp.n}); < ${R.valCheap}x = +1, > ${R.valRich}x = -1`, src: 'Yahoo via yfinance (forwardPE)'});
    } else d.push({k: 'val', label: 'Valuation', vote: null, chip: 'fP/E n/a', detail: !(fin(r.pef) && r.pef > 0) ? 'forward P/E missing or negative' : 'sector median needs >= 5 names', src: 'Yahoo via yfinance'});
    if (r.rating && fin(r.up)) {
      const pos = (r.rating === 'buy' || r.rating === 'strong_buy') && r.up >= R.upsideMin, neg = r.rating === 'hold' || r.rating === 'sell' || r.rating === 'underperform' || r.up < 0;
      d.push({k: 'analyst', label: 'Analysts', vote: pos ? 1 : neg ? -1 : 0, chip: `${r.rating.replace('_', ' ')} ${r.up > 0 ? '+' : ''}${r.up.toFixed(0)}%`,
        detail: `consensus rating ${r.rating} (n=${fin(r.nan) ? r.nan : '?'}), mean target upside ${r.up.toFixed(1)}%; buy/strong_buy AND upside >= ${R.upsideMin}% = +1, hold/sell or upside < 0 = -1`, src: 'Yahoo via yfinance (recommendationKey, targetMeanPrice)'});
    } else d.push({k: 'analyst', label: 'Analysts', vote: null, chip: 'analyst n/a', detail: 'rating or target missing', src: 'Yahoo via yfinance'});
    const s50 = sma(r.spark, 50);
    if (fin(r.px) && fin(s50) && fin(r.m1)) {
      const up = r.px > s50 && r.m1 > 0, dn = r.px < s50 && r.m1 < 0;
      d.push({k: 'trend', label: 'Trend', vote: up ? 1 : dn ? -1 : 0, chip: `${r.px > s50 ? '>' : '<'}50d, 1m ${r.m1 > 0 ? '+' : ''}${r.m1.toFixed(1)}%`,
        detail: `price ${r.px.toFixed(2)} vs 50-session avg ${s50.toFixed(2)}, 1-month ${r.m1.toFixed(1)}%; above AND 1m up = +1, below AND 1m down = -1`, src: 'Yahoo via yfinance (Adj Close)'});
    } else d.push({k: 'trend', label: 'Trend', vote: null, chip: 'trend n/a', detail: 'price history too short', src: 'Yahoo via yfinance'});
    const s = r.sam;
    if (s && (s.q || fin(s.trend))) {
      const good = (s.q === 'GREAT' || s.q === 'GOOD') && fin(s.trend) && s.trend >= 60, bad = s.q === 'WEAK' || s.q === 'AVOID';
      const rawVote = good ? 1 : bad ? -1 : 0;
      const isQuarantined = Boolean(r.sam_drift || (s.asof && r.pxd && Math.abs(daysBetween(r.pxd, s.asof)) > 30)) && Boolean(R && R.quarantineStaleSam);
      const drf = r.sam_drift || {};
      const driftTag = fin(drf.px_pct) ? ` (${drf.px_pct > 0 ? '+' : ''}${drf.px_pct.toFixed(1)}% vs 07-25)` : '';
      const fpeTag = fin(drf.pef_chg) ? `, fP/E ${drf.pef_chg > 0 ? '+' : ''}${drf.pef_chg.toFixed(1)}x` : '';
      const qSub = [fin(drf.roe) ? `ROE ${drf.roe}%` : null, fin(drf.de) ? `D/E ${drf.de}` : null].filter(Boolean).join(', ');
      d.push({k: 'sam', label: 'Snapshot', vote: isQuarantined ? null : rawVote,
        chip: `snap ${s.q || '?'} T${fin(s.trend) ? s.trend.toFixed(0) : '?'}${driftTag}${isQuarantined ? ' [stale]' : ''}`,
        detail: `${s.label || 'SmartOptions snapshot'}: quality ${s.q || 'n/a'}${qSub ? ' (' + qSub + ')' : ''}, TrendScore ${fin(s.trend) ? s.trend : 'n/a'}, opp ${fin(s.opp) ? s.opp : 'n/a'}${driftTag}${fpeTag}; GREAT/GOOD AND trend >= 60 = +1, WEAK/AVOID = -1.${isQuarantined ? ' Quarantined from live vote (>30d old; toggle in Rules).' : ' Read-only, not recomputed; dated, may be stale.'}`, src: s.label || 'SmartOptions snapshot'});
    } else d.push({k: 'sam', label: 'Snapshot', vote: null, chip: 'snap n/a', detail: 'not in SmartOptions snapshot', src: 'SmartOptions snapshot'});
    if (fin(r.res20d)) {
      const aTh = (R && fin(R.alpha20dMin)) ? R.alpha20dMin : 3.0;
      const aVote = r.res20d >= aTh ? 1 : r.res20d <= -aTh ? -1 : 0;
      d.push({k: 'alpha20d', label: '20d Alpha (Resid)', vote: aVote, chip: `20d α ${r.res20d > 0 ? '+' : ''}${r.res20d.toFixed(1)}%`,
        detail: `20-session stock-specific residual ${r.res20d > 0 ? '+' : ''}${r.res20d.toFixed(2)}% after stripping 5-factor OLS macro move; >= +${aTh}% = +1, <= -${aTh}% = -1`, src: 'SmartOptions Edge 252d OLS attribution'});
    }
    return d;
  }
  function nameVerdict(drivers, R) {
    const v = drivers.filter(x => fin(x.vote)); const sum = v.reduce((a, x) => a + x.vote, 0);
    if (v.length < 2) return {word: 'N/A', cls: 'na', sum, n: v.length};
    return {word: sum >= R.strongVotes ? 'STRONG' : sum <= -R.strongVotes ? 'WEAK' : 'MIXED', cls: sum >= R.strongVotes ? 'up' : sum <= -R.strongVotes ? 'dn' : 'neu', sum, n: v.length};
  }

  /* ---------- L4 PLAN (Conditional Playbook, education) ---------- */
  function daysBetween(a, b) { const x = Date.parse(a), y = Date.parse(b); return fin(x) && fin(y) ? Math.round((x - y) / 864e5) : null; }
  function playbook(r, nv, mv, vv, R, asof) {
    const rv = realizedVol(r.spark, 20);
    const iv = fin(r.iv) ? r.iv : null;
    const dteIv = r.ivx ? daysBetween(r.ivx, asof) : null;
    const dte = fin(dteIv) && dteIv > 0 ? dteIv : R.dteDefault;
    const vol = fin(iv) ? iv : rv, volSrc = fin(iv) ? `ATM IV ${iv.toFixed(1)}% (${r.ivx || '?'}, ${r.ivs || 'Yahoo chain'})` : fin(rv) ? `20d realized ${rv.toFixed(1)}% (no IV stored)` : null;
    const em = fin(r.px) && fin(vol) ? r.px * vol / 100 * Math.sqrt(dte / 365) : null;
    const band = fin(em) ? [r.px - em, r.px + em] : null;
    const ivrv = fin(iv) && fin(rv) && rv > 0 ? iv / rv : null;
    const catalyst = fin(r.ern) && r.ern >= 0 && r.ern <= Math.max(R.catalystDays, fin(dteIv) ? dteIv : 0);
    const inputs = {name: nv.word, market: mv.word, vol: vv.word, iv, rv, ivrv, dte, em, earn_days: fin(r.ern) ? r.ern : null};
    const base = {inputs, band, em, dte, volSrc, label: 'association, not causation; education, not an order'};
    if (nv.word === 'N/A') return Object.assign(base, {setup: 'No setup', cls: 'na', short: 'too few measured drivers', why: 'name has too few measured drivers', invalid: null});
    if (catalyst && fin(ivrv) && ivrv <= R.ivCheap)
      return Object.assign(base, {setup: 'Long strangle candidate', cls: 'warn', short: `earnings ${r.ern === 0 ? 'today' : 'in ' + r.ern + 'd'} · IV/RV ${ivrv.toFixed(2)} not rich`, why: `earnings ${r.ern === 0 ? 'today' : 'in ' + r.ern + 'd'} inside the window and IV/RV ${ivrv.toFixed(2)} <= ${R.ivCheap}: a catalyst is ahead and implied vol is not rich vs realized; a strangle pays only if the move exceeds the band.`,
        invalid: `IV/RV rises above ${R.ivCheap} before entry, or the earnings date moves outside the window`});
    if (!catalyst && fin(ivrv) && ivrv >= R.ivRich && (nv.word === 'MIXED' || mv.word === 'Neutral') && vv.word !== 'Stress')
      return Object.assign(base, {setup: 'Iron condor candidate', cls: 'up', short: `IV/RV ${ivrv.toFixed(2)} rich · no earnings ≤ ${R.catalystDays}d · no clear direction`, why: `IV/RV ${ivrv.toFixed(2)} >= ${R.ivRich} (premium rich), no earnings inside ${R.catalystDays}d, and direction is not decided (${nv.word} name / ${mv.word} market): range-bound premium with defined risk.`,
        invalid: 'close outside the band, an earnings/news catalyst appears, or VIX term ratio goes above 1.0'});
    if (nv.word === 'STRONG' && mv.word !== 'Lean bearish' && !catalyst)
      return Object.assign(base, {setup: 'CSP / covered call (baseline)', cls: 'neu', short: `STRONG name · market ${mv.word.toLowerCase()} · no earnings ≤ ${R.catalystDays}d`, why: `STRONG name, market ${mv.word.toLowerCase()}, no earnings inside ${R.catalystDays}d: the baseline income setup (cash-secured put on a name you would own, or covered call if held).`,
        invalid: `name drops to MIXED/WEAK, market turns Lean bearish, or price closes below the lower band${band ? ' (' + band[0].toFixed(2) + ')' : ''}`});
    const miss = [];
    if (!fin(iv)) miss.push('no ATM IV stored for this name (IV/RV cannot be judged)');
    if (catalyst) miss.push(r.ern === 0 ? 'earnings today' : `earnings in ${r.ern}d`);
    if (fin(ivrv) && ivrv > R.ivCheap && ivrv < R.ivRich) miss.push(`IV/RV ${ivrv.toFixed(2)} between ${R.ivCheap} and ${R.ivRich}`);
    if (nv.word === 'WEAK') miss.push('WEAK name: no bullish-premium baseline');
    if (mv.word === 'Lean bearish') miss.push('market Lean bearish');
    const why = miss.join('; ') || 'conditions for strangle / condor / baseline not met';
    return Object.assign(base, {setup: 'No rule matched', cls: 'na', short: why, why, invalid: null});
  }

  function loadRules(storage) { try { return Object.assign({}, DEFAULT_RULES, JSON.parse(storage.getItem(RKEY) || '{}')); } catch (e) { return Object.assign({}, DEFAULT_RULES); } }
  // Restate existing measured verdicts; this adds no score, signal, or recommendation.
  function launcherAssessment(D, rules) {
    const r = rules || DEFAULT_RULES, mi = marketInputs(D, r), mv = marketVerdict(mi, r);
    const vi = volInputs(D), vv = volVerdict(vi, r);
    const covered = mv.n > 0 && mv.n >= Math.max(1, r.minInputs);
    const market = covered ? ({'Lean bullish': 'Measured market inputs lean bullish', 'Lean bearish': 'Measured market inputs lean bearish', Neutral: 'Measured market inputs are mixed / neutral'}[mv.word] || 'The market assessment is unavailable') : 'Insufficient coverage for a market assessment';
    const volatility = vv.word === 'Unknown' ? 'volatility data is unavailable' : `volatility is ${vv.word.toLowerCase()}${vv.trend ? ' and ' + vv.trend : ''}`;
    const sources = mi.filter(i => fin(i.vote) && i.source).map(i => i.source).concat(vi.source ? [vi.source] : []);
    const providers = [...new Set(sources.map(s => s.provider).filter(Boolean))];
    const periods = [...new Set(sources.map(s => s.period).filter(Boolean))].sort();
    return {text: `${market}; ${volatility}.`, covered, votes: mv.n, market: mv.word, volatility: vv.word,
      session: D.asof_session || 'unavailable', periods, providers};
  }
  function peerDivergence(D) {
    const groups = new Map();
    const industries = new Map();
    for (const r of D.rows || []) {
      if (!r.sec || !fin(r.d1) || !r.pxd || r.pxd !== D.asof_session) continue;
      if (!groups.has(r.sec)) groups.set(r.sec, []);
      groups.get(r.sec).push(r);
      if (r.ind) { if (!industries.has(r.ind)) industries.set(r.ind, []); industries.get(r.ind).push(r); }
    }
    const closePeers = [...industries.entries()].filter(([, rows]) => rows.length >= 3);
    const compared = closePeers.length ? closePeers : [...groups.entries()];
    const candidates = [];
    for (const [sector, rows] of compared) {
      if (rows.length < 3) continue;
      const sorted = rows.slice().sort((a, b) => a.d1 - b.d1 || a.t.localeCompare(b.t));
      const laggard = sorted[0], leader = sorted[sorted.length - 1];
      if (leader.d1 > 0 && leader.d1 > laggard.d1) candidates.push({sector, laggard: laggard.t, leader: leader.t, laggardChange: laggard.d1, leaderChange: leader.d1, gap: leader.d1 - laggard.d1, date: D.asof_session, count: rows.length});
    }
    return candidates.sort((a, b) => b.gap - a.gap || a.sector.localeCompare(b.sector))[0] || null;
  }
  const core = {DEFAULT_RULES, sma, realizedVol, pctRank, chgN, pctChgN, moveZ, median, marketInputs, marketVerdict, shakers, upcoming, volInputs, volVerdict, sectorPE, nameDrivers, nameVerdict, playbook, loadRules, launcherAssessment, peerDivergence};
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
  if (!root.document) return;

  /* ================= DOM ================= */
  const $ = (s, el) => (el || document).querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const f = (v, dp, pre) => fin(v) ? (pre && v > 0 ? '+' : '') + v.toLocaleString('en-US', {minimumFractionDigits: dp, maximumFractionDigits: dp}) : '<span class="fl-na">—</span>';
  const NA = why => `<span class="fl-na" title="${esc(why || 'not available')}">—</span>`;
  const voteCell = v => fin(v) ? `<span class="fl-vote ${v > 0 ? 'up' : v < 0 ? 'dn' : 'neu'}">${v > 0 ? '+1' : v < 0 ? '−1' : '0'}</span>` : '<span class="fl-vote na">n/a</span>';
  const initialHash = new URLSearchParams(location.hash.slice(1));
  const landing = (!initialHash.has('tab') && !initialHash.has('t') && !initialHash.has('s') && !initialHash.has('open')) || initialHash.has('fl');
  let A = null, R = null, step = Math.min(4, Math.max(1, +initialHash.get('fl') || 1)), scope = ['watch', 'movers', 'all'].includes(initialHash.get('fls')) ? initialHash.get('fls') : 'watch', sort = {k: 'sum', dir: -1}, open = {}, page = null, btn = null, M = null;

  function watchlist(D) {
    if (root.SmartOptionsWatchlist) return root.SmartOptionsWatchlist.get();
    try { const raw = localStorage.getItem(WKEY); if (raw) { const xs = JSON.parse(raw); if (Array.isArray(xs)) return xs.map(String); } } catch (e) { /* fall through to default */ }
    return D.rows.filter(r => r.sam && fin(r.sam.opp)).sort((a, b) => b.sam.opp - a.sam.opp).slice(0, 25).map(r => r.t);
  }
  function scopeRows(D) {
    if (scope === 'all') return D.rows;
    if (scope === 'movers') return D.rows.filter(r => (r.sets || []).includes('A'));
    const w = new Set(watchlist(D)); return D.rows.filter(r => w.has(r.t));
  }
  function compute() {
    const D = A.D(); R = loadRules(localStorage);
    const mi = marketInputs(D, R), mv = marketVerdict(mi, R);
    const vi = volInputs(D), vv = volVerdict(vi, R);
    const sp = sectorPE(D.rows);
    const rows = scopeRows(D).map(r => { const dr = nameDrivers(r, sp, R), nv = nameVerdict(dr, R); return {r, dr, nv, pb: playbook(r, nv, mv, vv, R, D.asof_session)}; });
    M = {D, mi, mv, vi, vv, rows, shake: shakers(D), ev: upcoming(D, D.rows, Date.now(), 7, watchlist(D))};
  }
  function srcLine(s) { if (!s) return ''; return `${esc(s.provider || '')}${s.series ? ' · ' + esc(s.series) : ''}${s.period ? ' · as of ' + esc(s.period) : ''}${s.url ? ` · <a href="${esc(s.url)}" target="_blank" rel="noopener">source</a>` : ''}`; }
  const TASKS = [['names', 'Check my companies', 'Watchlist companies and measured drivers'], ['fundamentals', 'Compare valuations', 'Watchlist sorted by forward P/E; valuation is one input, not a buy list'], ['movers', 'Screen moving companies', 'Sourced mover universe and company drivers'], ['events', 'Check event risk', 'Earnings-week screen and event checklist'], ['volatility', 'Inspect volatility', 'Volatility inputs, then conditional strategy alternatives'], ['question', 'Ask my own question', 'Open chat with an editable question; nothing is sent']];
  function taskRow(D, compact) {
    const s = launcherAssessment(D, loadRules(localStorage));
    const dates = s.periods.length ? s.periods.length === 1 ? s.periods[0] : `${s.periods[0]}–${s.periods[s.periods.length - 1]}` : 'unavailable';
    const peer = peerDivergence(D), watch = new Set(watchlist(D));
    const earnings = (D.rows || []).filter(r => watch.has(r.t) && fin(r.ern) && r.ern >= 0 && r.ern <= 7).length;
    let next = !s.covered ? ['inputs', 'Check the missing inputs before interpreting the market.'] : s.volatility === 'Stress' || s.volatility === 'Elevated' ? ['volatility', `Volatility is ${s.volatility.toLowerCase()}: examine what is priced in before exploring setups.`] : earnings ? ['events', `${earnings} watchlist ${earnings === 1 ? 'name reports' : 'names report'} within 7 days of the snapshot. Review the event risk.`] : ['names', 'Compare your companies against the measured market context.'];
    const divergence = s.covered && peer && s.volatility !== 'Stress' ? `<div class="so-task-suggestion"><b>Another angle:</b> ${esc(peer.sector)} · ${esc(peer.leader)} ${peer.leaderChange > 0 ? '+' : ''}${peer.leaderChange.toFixed(1)}% vs ${esc(peer.laggard)} ${peer.laggardChange > 0 ? '+' : ''}${peer.laggardChange.toFixed(1)}% on ${esc(peer.date)} (Yahoo). Compare peer participation; a gap alone does not predict a catch-up. <button data-task="peers">Compare these peers →</button></div>` : '';
    return `<section class="so-today${compact ? ' so-today-compact' : ''}" aria-label="Choose an investigation">${compact ? '' : '<p class="so-purpose">Start with a question about companies you follow. Find what changed, compare the evidence, and decide what needs more research. Pin your own names or import holdings below.</p>'}<div class="so-today-heading"><b>${compact ? 'Choose your next investigation' : 'Today'}</b><span>${esc(s.text)}</span></div><div class="so-today-meta" title="${esc(s.providers.join(' · ') || 'Sources unavailable')}">Session ${esc(s.session)} · input dates ${esc(dates)} · ${s.votes} measured votes · V2 heuristic; association, not a forecast. <button data-task="inputs">See inputs</button><button data-task="macro">Macro context</button></div><div class="so-task-suggestion"><b>First check:</b> ${esc(next[1])} <button data-task="${next[0]}">Open investigation →</button></div>${divergence}<div class="so-task-actions" aria-label="What do you want to investigate?">${TASKS.map(([id, label, title]) => `<button data-task="${id}" title="${esc(title)}">${label} <span aria-hidden="true">↗</span></button>`).join('')}</div><div class="so-task-status" role="status"></div></section>`;
  }
  function launchTask(id, origin) {
    const status = origin && origin.closest('.so-today') && origin.closest('.so-today').querySelector('.so-task-status');
    try {
      if (id === 'names' || id === 'movers') { scope = id === 'names' ? 'watch' : 'movers'; step = 3; showFlow(); }
      else if (id === 'inputs' || id === 'volatility') { step = id === 'inputs' ? 1 : 2; showFlow(); }
      else if (id === 'macro') A.showTab('macro');
      else if (id === 'fundamentals') { if (!root.SmartOptionsOverview) throw new Error('Overview is still loading. Try again.'); root.SmartOptionsOverview.compare(); }
      else if (id === 'events') { root.SmartOptionsAPI.apply_preset('earnings'); }
      else if (id === 'peers') {
        const peer = peerDivergence(A.D());
        if (!peer) throw new Error('Matching same-session peer returns are unavailable.');
        if (root.SmartOptionsExplore && root.SmartOptionsExplore.peers) root.SmartOptionsExplore.peers(peer.laggard);
        else { A.showTab('markets'); A.select('t', peer.laggard); }
      }
      else if (id === 'question') {
        const chat = root.SmartOptionsChat;
        if (!chat || !chat.open) throw new Error('Chat is still loading. Try again.');
        if (chat.draft) chat.draft('Help me investigate a market question using the stored dashboard data. My question is: ');
        else chat.open();
      } else throw new Error('This investigation is unavailable.');
      if (status) status.textContent = '';
      return {task: id, opened: true};
    } catch (error) {
      console.warn('[task launchers] action unavailable', id, error.message);
      if (status) status.textContent = error.message;
      return {task: id, opened: false, error: error.message};
    }
  }

  function rail() {
    const {mv, vv, vi, rows, mi} = M;
    const c = w => rows.filter(x => x.nv.word === w).length;
    const pbc = s => rows.filter(x => x.pb.setup.startsWith(s)).length;
    const g = id => mi.find(i => i.id === id) || {};
    const scopeName = scope === 'watch' ? 'watchlist' : scope === 'movers' ? 'movers' : 'all';
    const st = [
      [1, 'Market', mv.word, mv.cls, `votes ${mv.sum > 0 ? '+' : ''}${mv.sum} of ${mv.n} · regime ${fin(g('regime').value) ? g('regime').value : '—'} · 10Y ${fin(g('rates').value) ? (g('rates').value > 0 ? '+' : '') + g('rates').value.toFixed(0) + 'bp/20d' : '—'}`],
      [2, 'Volatility', vv.word + (vv.trend ? ', ' + vv.trend : ''), vv.cls, `VIX ${f(vi.vix, 1)} (p${fin(vi.vixPct) ? vi.vixPct : '—'}) · VRP ${f(vi.vrp, 1, 1)} · term ${f(vi.term, 2)}`],
      [3, 'Names', `${c('STRONG')} strong / ${c('MIXED')} mixed / ${c('WEAK')} weak`, 'neu', `${rows.length} in ${scopeName}${c('N/A') ? ' · ' + c('N/A') + ' n/a' : ''}`],
      [4, 'Plan', `${pbc('Iron')} condor · ${pbc('Long')} strangle · ${pbc('CSP')} cash-secured put`, 'neu', `${pbc('No')} no setup · education only`],
    ];
    const steps = st.map(([n, h, v, cls, sub]) => `<button class="fl-step${step === n ? ' on' : ''}" data-step="${n}"><span class="fl-n">${n}</span><span class="fl-sh">${h}</span><span class="fl-v ${cls}">${esc(v)}</span><span class="fl-sub">${sub}</span></button>`).join('<div class="fl-arrow">↓</div>');
    // Morning read: the same measured verdicts restated as one chain + what to watch. No new judgement is added here.
    const sh = M.shake[0], nx = M.ev.find(e => e.kind === 'macro' && e.status !== 'released' && e.t >= Date.now());
    const nxWhen = nx ? new Date(nx.t).toLocaleString('en-US', {weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York'}) + ' ET' : '';
    const earnSoon = M.ev.filter(e => e.kind === 'earn' && e.watched).length;
    const read = `<div class="fl-read"><div class="fl-sec">Morning read</div>
      <div>Market <b class="fl-v ${mv.cls}">${esc(mv.word)}</b> → vol <b class="fl-v ${vv.cls}">${esc(vv.word)}</b> → ${c('STRONG')} strong / ${c('WEAK')} weak → ${pbc('Iron')} condor, ${pbc('Long')} strangle, ${pbc('CSP')} cash-secured put candidates.</div>
      ${sh ? `<div><span class="dim">Moving most:</span> <a href="#" data-sid="${esc(sh.id)}">${esc(sh.label)}</a> ${f(sh.chg, sh.unit === '%' ? 1 : 0, 1)} ${sh.unit}/20d <span class="dim">(z ${f(sh.z, 1, 1)})</span></div>` : ''}
      <div><span class="dim">Next macro:</span> ${nx ? esc(nx.title) + ' <span class="dim">' + esc(nxWhen) + '</span>' : '<span class="dim">none scheduled in 7d</span>'}</div>
      <div><span class="dim">Watchlist earnings, 7d:</span> ${earnSoon}</div>
      <div class="fl-links"><a href="#" data-go="markets">Analyst screener →</a> <a href="#" data-go="macro">Macro grid →</a></div>
      <div class="dim fl-fine">Verdicts are rule outputs over measured inputs (Rules). Education, not advice; association, not causation.</div></div>`;
    return steps + read;
  }
  function inputsTable(list) {
    return `<table class="fl-t fl-in"><thead><tr><th>Input</th><th class="r">Value</th><th class="c">Vote</th><th>Rule · source · as of</th></tr></thead><tbody>${list.map(i =>
      `<tr><td class="nw">${esc(i.label)}</td><td class="r">${i.disp ? esc(i.disp) : NA(i.why)}</td><td class="c">${voteCell(i.vote)}</td><td class="dim">${esc(i.rule)}${!i.disp && i.why ? ' <span class="fl-miss">' + esc(i.why) + '</span>' : ''}<span class="fl-src">${srcLine(i.source)}</span></td></tr>`).join('')}</tbody></table>`;
  }
  function pL1() {
    const {mv, mi, shake, ev} = M;
    const eventHtml = e => { const d = new Date(e.t); const when = e.kind === 'earn' ? d.toLocaleDateString('en-US', {weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC'}) : d.toLocaleString('en-US', {weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York'}) + ' ET';
      return `<div class="fl-ev ${e.kind}${e.status === 'released' ? ' done' : ''}"${e.tk ? ` data-t="${esc(e.tk)}"` : ''} title="${esc(e.src || 'source unavailable')}"><b>${esc(e.type)}</b><span>${esc(e.title)}${e.watched ? ' · watchlist' : ''}</span><span class="dim">${esc(when)}${e.status === 'released' ? ' · released' : ''}</span></div>`; };
    const primary = ev.filter(e => e.kind === 'macro' || e.watched), other = ev.filter(e => e.kind === 'earn' && !e.watched);
    const evs = ev.length ? primary.map(eventHtml).join('') + (other.length ? `<details class="fl-more-events"><summary>+${other.length} more · other sourced S&P names</summary>${other.map(eventHtml).join('')}</details>` : '') : '<div class="dim">No scheduled macro events or sourced earnings in the next 7 days.</div>';
    const sh = shake.length ? `<table class="fl-t"><thead><tr><th>Factor moving most</th><th class="r">20d move</th><th class="r">z vs 1y</th><th>Most exposed (measured)</th><th>Next</th></tr></thead><tbody>${shake.map(s =>
      `<tr><td><a href="#" data-sid="${esc(s.id)}">${esc(s.label)}</a></td><td class="r">${f(s.chg, s.unit === '%' ? 1 : 0, 1)} ${s.unit}</td><td class="r ${Math.abs(s.z) >= 1.5 ? 'warn' : ''}">${f(s.z, 1, 1)}</td><td>${s.exposed.map(x => `<a href="#" data-t="${esc(x.ticker)}">${esc(x.ticker)}</a> <span class="dim">t ${f(x.t, 1)}</span>`).join(' · ') || '<span class="dim">none |t|>2</span>'}</td><td class="dim">${s.watch ? esc(s.watch.next_event || '') : ''}</td></tr>`).join('')}</tbody></table>
      <div class="fl-note">z = latest 20-session change vs all 20-session changes over the stored ~1y history. Exposure = per-ticker OLS t-stat (${esc((M.D.rel || {}).window || '')}). Association, not causation.</div>` : '<div class="dim">Factor histories missing; cannot rank movers.</div>';
    return `<div class="fl-h"><h2>1 · Market <span class="fl-v ${mv.cls}">${esc(mv.word)}</span></h2><span class="dim">votes ${mv.sum > 0 ? '+' : ''}${mv.sum} from ${mv.n} measured inputs · lean needs |votes| ≥ ${R.leanVotes}, min ${R.minInputs} inputs</span></div>
      <div class="fl-grid2"><div><div class="fl-sec">Trend + sentiment inputs <span class="dim">(why / show inputs)</span></div>${inputsTable(mi)}</div>
      <div><div class="fl-sec">Next 7 days</div><div class="fl-evs">${evs}</div><div class="fl-sec">What could shake it</div>${sh}</div></div>`;
  }
  function pL2() {
    const {vi, vv} = M;
    const rows = [
      ['VIX close', f(vi.vix, 2), `Low < ${R.vixLow} · Normal < ${R.vixElev} · Elevated < ${R.vixStress} · Stress ≥ ${R.vixStress}`, srcLine(vi.source)],
      ['VIX 1y percentile', fin(vi.vixPct) ? 'p' + vi.vixPct : NA('history missing'), 'share of stored closes ≤ today (~1y)', srcLine(vi.source)],
      ['VIX 5-session change', f(vi.vix5d, 2, 1), '> +1 rising, < −1 falling', srcLine(vi.source)],
      ['VIX9D / VIX / VIX3M', `${f(vi.vix9d, 2)} / ${f(vi.vix, 2)} / ${f(vi.vix3m, 2)}`, 'term structure', 'Cboe'],
      ['Term ratio VIX/VIX3M', f(vi.term, 3), '> 1.0 backwardation: verdict raised to at least Elevated', 'Cboe (computed)'],
      ['VRP (VIX − SPY 21d realized)', fin(vi.vrp) ? f(vi.vrp, 2, 1) + ' vol pts' : NA('missing'), '> 0: implied rich vs realized (premium sellers paid)', 'Cboe + Yahoo (computed)'],
    ];
    return `<div class="fl-h"><h2>2 · Volatility <span class="fl-v ${vv.cls}">${esc(vv.word)}</span></h2><span class="dim">${vv.trend ? 'VIX ' + vv.trend + ' over 5 sessions · ' : ''}${vv.premium ? esc(vv.premium) : ''}${vv.bumped ? ' · raised by backwardation' : ''}</span></div>
      <table class="fl-t fl-in"><thead><tr><th>Input</th><th class="r">Value</th><th>Rule / threshold (editable in Rules)</th><th>Source</th></tr></thead><tbody>${rows.map(x => `<tr><td>${x[0]}</td><td class="r">${x[1]}</td><td class="dim">${x[2]}</td><td class="dim">${x[3]}</td></tr>`).join('')}</tbody></table>
      <div class="fl-note">As of ${esc(vi.source && vi.source.period || M.D.asof_session || 'unavailable')}. Regime = market-wide 30-day implied vol (VIX), not direction and not single-stock IV. Per-name IV vs realized is used in step 4. Bands are our defaults, not an industry standard; change them in Rules.</div>`;
  }
  function sortRows(xs) {
    const k = sort.k, d = sort.dir, val = x => k === 'sum' ? (x.nv.word === 'N/A' ? -99 : x.nv.sum) : k === 't' ? x.r.t : k === 'd1' ? x.r.d1 : k === 'm1' ? x.r.m1 : k === 'ern' ? x.r.ern : k === 'iv' ? x.r.iv : null;
    return xs.slice().sort((a, b) => { const va = val(a), vb = val(b); if (va == null && vb == null) return 0; if (va == null) return 1; if (vb == null) return -1; return (va > vb ? 1 : va < vb ? -1 : 0) * d; });
  }
  function scopeBar() { return `<div class="fl-scope">${[['watch', 'Watchlist'], ['movers', 'Movers (A)'], ['all', 'All']].map(([k, l]) => `<button data-scope="${k}" class="${scope === k ? 'on' : ''}">${l}</button>`).join('')}</div>`; }
  function th(k, l, cls) { return `<th data-sort="${k}" class="${cls || ''}${sort.k === k ? ' srt' : ''}">${l}${sort.k === k ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`; }
  function pL3() {
    const xs = sortRows(M.rows);
    return `<div class="fl-h"><h2>3 · Names</h2>${scopeBar()}<span class="dim">4 drivers vote +1/0/−1 · STRONG ≥ +${R.strongVotes}, WEAK ≤ −${R.strongVotes} · click a name for detail · ▸ why</span></div>
      <div class="fl-scroll"><table class="fl-t fl-names"><thead><tr>${th('t', 'Name')}<th>Sector</th>${th('sum', 'Verdict')}<th>Why (drivers)</th>${th('d1', '1d', 'r')}${th('m1', '1m', 'r')}${th('ern', 'Earn', 'r')}<th></th></tr></thead><tbody>${xs.map(x => {
        const r = x.r; const o = open['n' + r.t];
        return `<tr><td><a href="#" data-t="${esc(r.t)}"><b>${esc(r.t)}</b></a> <span class="dim">${esc((r.n || '').slice(0, 22))}</span></td><td class="dim">${esc(r.sec || '')}</td><td><span class="fl-v ${x.nv.cls}">${x.nv.word}</span> <span class="dim">${x.nv.sum > 0 ? '+' : ''}${x.nv.sum}/${x.nv.n}</span></td>
        <td>${x.dr.map(d => `<span class="fl-chip ${fin(d.vote) ? (d.vote > 0 ? 'up' : d.vote < 0 ? 'dn' : 'neu') : 'na'}" title="${esc(d.detail)}">${esc(d.chip)}</span>`).join('')}</td>
        <td class="r ${fin(r.d1) ? (r.d1 >= 0 ? 'up' : 'dn') : ''}">${f(r.d1, 1, 1)}</td><td class="r ${fin(r.m1) ? (r.m1 >= 0 ? 'up' : 'dn') : ''}">${f(r.m1, 1, 1)}</td><td class="r">${fin(r.ern) ? (r.ern === 0 ? '<b class="warn">today</b>' : r.ern + 'd') : NA('earnings date missing')}</td>
        <td><button class="fl-why" data-open="n${esc(r.t)}">${o ? '▾' : '▸'} why</button></td></tr>${o ? `<tr class="fl-drw"><td colspan="8">${x.dr.map(d => `<div><b>${esc(d.label)}</b> ${voteCell(d.vote)} ${esc(d.detail)} <span class="dim">· ${esc(d.src)}${r.rat ? ' · retrieved ' + esc(r.rat) : ''}</span></div>`).join('')}</td></tr>` : ''}`; }).join('')}</tbody></table></div>`;
  }
  function pL4() {
    const xs = M.rows.filter(x => x.nv.word !== 'N/A').sort((a, b) => (a.pb.setup === 'No rule matched') - (b.pb.setup === 'No rule matched') || b.nv.sum - a.nv.sum);
    return `<div class="fl-h"><h2>4 · Plan <span class="dim">Conditional Playbook · education, not an order · association, not causation</span></h2>${scopeBar()}</div>
      <div class="fl-ctx dim">Market <b class="fl-v ${M.mv.cls}">${esc(M.mv.word)}</b> · Vol <b class="fl-v ${M.vv.cls}">${esc(M.vv.word)}</b> · IV/RV rich ≥ ${R.ivRich}, not rich ≤ ${R.ivCheap} · catalyst = earnings ≤ ${R.catalystDays}d · band = price ± price·σ·√(days/365), σ = ATM IV when stored, else 20d realized (labeled). Premiums not shown: no option chain stored (no quotes).</div>
      <div class="fl-scroll"><table class="fl-t fl-plan"><thead><tr><th>Ticker · price</th><th>Name verdict</th><th>Setup</th><th class="r">IV / RV20</th><th class="r">Band (±1σ, days)</th><th>Why</th><th></th></tr></thead><tbody>${xs.map(x => {
        const r = x.r, p = x.pb, i = p.inputs, o = open['p' + r.t];
        return `<tr><td><a href="#" data-t="${esc(r.t)}"><b>${esc(r.t)}</b></a> <span class="dim">${f(r.px, 2)}</span></td><td><span class="fl-v ${x.nv.cls}">${x.nv.word}</span></td><td><span class="fl-setup ${p.cls}">${esc(p.setup)}</span></td>
        <td class="r">${fin(i.iv) ? f(i.iv, 1) : NA('no ATM IV stored for this name')} / ${f(i.rv, 1)}${fin(i.ivrv) ? ' <span class="dim">(' + i.ivrv.toFixed(2) + ')</span>' : ''}</td>
        <td class="r">${p.band ? `${f(p.band[0], 2)} – ${f(p.band[1], 2)} <span class="dim">${p.dte}d${fin(i.iv) ? '' : ' RV'}</span>` : NA('price or vol missing')}</td>
        <td class="fl-whytxt" title="${esc(p.why)}">${esc(p.short || p.why)}</td><td><button class="fl-why" data-open="p${esc(r.t)}">${o ? '▾' : '▸'} inputs</button></td></tr>${o ? `<tr class="fl-drw"><td colspan="7">
          <div><b>Vol source</b> ${esc(p.volSrc || 'none')} · <b>expected move</b> ${fin(p.em) ? '±' + p.em.toFixed(2) : '—'} over ${p.dte}d · <b>earnings</b> ${fin(i.earn_days) ? i.earn_days + 'd (' + esc(r.er) + ', ' + esc(r.ers || '') + ')' : 'unknown'}</div>
          <div><b>Why</b> ${esc(p.why)}</div><div><b>Invalidates</b> ${esc(p.invalid || 'n/a')}</div>${root.SmartOptionsStrategies ? root.SmartOptionsStrategies.flowHint({ticker: r.t, price: r.px, iv: i.iv, realized_vol: i.rv, days_to_earnings: i.earn_days, horizon_days: p.dte, name_word: x.nv.word}) : ''}<div class="dim">${esc(r.t)} · price as of ${esc(r.pxd || M.D.asof_session)} · fundamentals retrieved ${esc(r.rat || 'unavailable')}. Drivers: ${x.dr.map(d => esc(d.label + ': ' + d.detail + ' · ' + d.src)).join('<br>')} · ${esc(p.label)}. Band is a model estimate from stored vol, not a quote.</div></td></tr>` : ''}`; }).join('')}</tbody></table></div>`;
  }
  function rulesPanel() {
    return `<div class="fl-rules" id="fl-rules" hidden><div class="fl-sec">Rules (thresholds are our defaults; saved in this browser)</div><div class="fl-rgrid">${Object.keys(DEFAULT_RULES).map(k =>
      `<label>${esc(RULE_LABELS[k] || k)}<input type="number" step="any" data-rule="${k}" value="${R[k]}"></label>`).join('')}</div><button data-rules="save">Save</button> <button data-rules="reset">Reset defaults</button></div>`;
  }
  function render() {
    if (!page || page.hidden) return;
    compute();
    const panel = [pL1, pL2, pL3, pL4][step - 1]();
    page.innerHTML = `<nav class="fl-rail">${rail()}<div class="fl-railft"><button data-rules="toggle">Rules</button> <span class="dim">as of ${esc(M.D.asof_session)}</span></div></nav>
      <section class="fl-main"><div class="fl-guide"><span class="fl-guide-k">OPTIONAL MARKET REVIEW · ${step} OF 4</span><h1>${['Is the broad market supportive?', 'How much movement is priced in?', 'Which companies agree with the outlook?', 'Which conditional setups fit?'][step - 1]}</h1><p>${['One sample workflow. Jump to any tab, choose a task template, or ask chat to arrange a view for your current question.', 'Compare implied and realized volatility. This measures movement, not whether prices will rise.', 'Review your watchlist, compare the drivers, and open Why to see the inputs behind each verdict.', 'Match the market, company and volatility context. Open Strategies for the wider library and payoff models.'][step - 1]}</p></div>${rulesPanel()}${panel}<div class="fl-progress">${step > 1 ? `<button data-next-step="${step - 1}">← ${['Market', 'Volatility', 'Companies'][step - 2]}</button>` : ''}${step < 4 ? `<button class="fl-next" data-next-step="${step + 1}">Next: ${['Volatility', 'Companies', 'Strategy'][step - 1]} →</button>` : '<button data-go="markets">Explore a company in Analyst →</button>'}</div></section>`;
    $('.fl-guide', page).insertAdjacentHTML('afterend', taskRow(M.D, true));
    fit();
  }
  // fill the viewport below header + tape (their heights vary with wrapping), desktop only
  function fit() { if (!page || page.hidden) return; page.style.height = window.innerWidth > 820 ? Math.max(480, window.innerHeight - page.getBoundingClientRect().top) + 'px' : ''; }
  function wire() {
    page.addEventListener('click', e => {
      const t = e.target;
      const task = t.closest('[data-task]'); if (task) { launchTask(task.dataset.task, task); return; }
      const s = t.closest('[data-step], [data-next-step]'); if (s) { step = +(s.dataset.step || s.dataset.nextStep); render(); return; }
      const sc = t.closest('[data-scope]'); if (sc) { scope = sc.dataset.scope; render(); return; }
      const so = t.closest('[data-sort]'); if (so) { const k = so.dataset.sort; sort = {k, dir: sort.k === k ? -sort.dir : (k === 't' ? 1 : -1)}; render(); return; }
      const op = t.closest('[data-open]'); if (op) { open[op.dataset.open] = !open[op.dataset.open]; render(); return; }
      const ru = t.closest('[data-rules]');
      if (ru) {
        const box = $('#fl-rules', page);
        if (ru.dataset.rules === 'toggle') { box.hidden = !box.hidden; return; }
        if (ru.dataset.rules === 'reset') { try { localStorage.removeItem(RKEY); } catch (er) { /* storage blocked: defaults apply this tab */ } render(); return; }
        if (ru.dataset.rules === 'save') { const o = {}; page.querySelectorAll('[data-rule]').forEach(i => { const v = parseFloat(i.value); if (fin(v)) o[i.dataset.rule] = v; }); try { localStorage.setItem(RKEY, JSON.stringify(o)); } catch (er) { console.warn('[R6 flow] rules not saved', er.name); } render(); return; }
      }
      const tk = t.closest('[data-t]'); if (tk) { e.preventDefault(); A.showTab('markets'); A.select('t', tk.dataset.t); return; }
      const go = t.closest('[data-go]'); if (go) { e.preventDefault(); A.showTab(go.dataset.go); return; }
      const sid = t.closest('[data-sid]'); if (sid) { e.preventDefault(); A.showTab('markets'); A.select('s', sid.dataset.sid); }
    });
  }
  function sync() { if (!page || !btn) return; const on = btn.classList.contains('on'); if (page.hidden === on) { page.hidden = !on; if (on) { const ov = $('#pg-overview'); if (ov) ov.hidden = true; render(); } } }
  function showFlow() { const wasOpen = btn.classList.contains('on'); A.showTab('flow'); ['#pg-markets', '#pg-macro', '#pg-overview'].forEach(s => { const el = $(s); if (el) el.hidden = true; }); sync(); if (wasOpen) render(); }
  function mount() {
    A = root.SO2; R = loadRules(localStorage);
    btn = document.createElement('button'); btn.dataset.tab = 'flow'; btn.id = 'fl-tab'; btn.textContent = 'Guide'; btn.title = 'Optional market-review template; use any view or task';
    $('#tabs').prepend(btn);
    page = document.createElement('main'); page.id = 'pg-flow'; page.className = 'fl-page'; page.hidden = true;
    $('#pg-markets').before(page);
    wire();
    window.addEventListener('resize', () => { clearTimeout(fit.t); fit.t = setTimeout(fit, 120); });
    new MutationObserver(sync).observe($('#tabs'), {attributes: true, subtree: true, attributeFilter: ['class'], childList: true});
    // Only open this sample guide when explicitly requested; Overview is the general workspace.
    if (initialHash.has('fl') || initialHash.get('tab') === 'flow') {
      showFlow();
      let n = 0; const t = setInterval(() => { const ov = $('#ov-tab'); if (ov) { if (ov.previousElementSibling !== btn) $('#tabs').prepend(btn); if (!btn.classList.contains('on') && !userMoved) showFlow(); clearInterval(t); } else if (++n > 100) clearInterval(t); }, 30);
    }
    $('#tabs').addEventListener('click', () => { userMoved = true; }, true);
    root.addEventListener('so:watchlist', () => render());
    // app.js swaps core.json on its 5-min refresh without telling us: re-render when the export changes.
    let lastExp = A.D().exported_at; setInterval(() => { const x = A.D().exported_at; if (x !== lastExp) { lastExp = x; render(); } }, 15000);
    // Expose Flow to the chat/API without editing custom.js: a "flow:morning" preset that opens step 1.
    const api = root.SmartOptionsAPI;
    if (api && !api.__flow) {
      const ap = api.apply_preset, ds = api.describe;
      api.apply_preset = id => { const s = String(id || ''); if (s === 'flow:morning' || s === 'Flow: morning check') { step = 1; showFlow(); return {flow: 'morning check', step: 1}; } return ap(id); };
      api.describe = () => { const d = ds(); try { d.presets.workflows.push({id: 'flow:morning', label: 'Market review template (optional)'}); } catch (e) { /* describe shape changed */ } return d; };
      api.show_flow = n => { step = Math.min(4, Math.max(1, +n || 1)); showFlow(); return {flow_step: step}; };
      api.__flow = true;
    }
    root.SO2_flow = {render, showFlow, compute: () => { compute(); return M; }, taskRow, launchTask, peerDivergence,
      companyVerdict: ticker => { const d=A.D(), r=d.rows.find(r=>r.t===ticker), rules=loadRules(localStorage); return r ? nameVerdict(nameDrivers(r,sectorPE(d.rows),rules),rules) : null; }};
    root.dispatchEvent(new CustomEvent('so:flow-ready'));
  }
  let userMoved = false, tries = 0;
  const timer = setInterval(() => { if (root.SO2_ready && root.SO2) { clearInterval(timer); try { mount(); } catch (e) { console.error('[R6 flow] mount failed', e); } } else if (++tries > 400) { clearInterval(timer); console.warn('[R6 flow] app data did not become ready'); } }, 20);
})(typeof window !== 'undefined' ? window : globalThis);
