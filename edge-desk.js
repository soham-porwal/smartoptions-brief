/* Options and risk research — Lean, Interactive, Pure-Math & Live Cross-Linked Experience
 * Inspired by the simplicity of the Options income reference artifact, 100% wired to
 * Historical live SmartOptions V2 data (core.json, px/*.json, 252d/60d OLS, My Book, Strategies).
 */
(function (root) {
  'use strict';

  const KEY = 'so_edge_desk_v1';
  const ODDS = [20, 15, 12, 10, 8, 7, 6, 5, 4, 3];
  const FACTORS = ['spy', 'us10y_bps', 'dxy', 'wti', 'vix'];
  const FLABEL = {spy: 'SPY (%)', us10y_bps: '10Y (bp)', dxy: 'DXY (%)', wti: 'WTI (%)', vix: 'VIX (pt)'};
  const DEFAULT_BOOK_SYMBOLS = [
    {t: 'NVDA', shares: 100},
    {t: 'AVGO', shares: 100},
    {t: 'MU', shares: 100},
    {t: 'AAPL', shares: 100},
    {t: 'AMZN', shares: 100},
    {t: 'GOOGL', shares: 100},
    {t: 'QCOM', shares: 100},
    {t: 'MSFT', shares: 100},
    {t: 'DIS', shares: 100},
    {t: 'VRT', shares: 100}
  ];

  const finite = v => typeof v === 'number' && Number.isFinite(v);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const fmtMoney = n => !finite(n) ? '—' : (n < 0 ? '−$' : '$') + Math.round(Math.abs(n)).toLocaleString('en-US');
  const fmtMoney2 = n => !finite(n) ? '—' : (n < 0 ? '−$' : '$') + Math.abs(n).toFixed(2);
  const fmtPct = (n, dp = 1) => !finite(n) ? '—' : (n * 100).toFixed(dp) + '%';
  const fmtSignedPct = (v, dp = 1) => !finite(v) ? '—' : (v > 0 ? '+' : '') + v.toFixed(dp) + '%';
  const kfmt = k => !finite(k) ? '—' : (k % 1 ? k.toFixed(1) : String(k));

  /* ---------- Pure Deterministic Black-Scholes & Normal CDF / Inverse ---------- */
  function ncdf(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989422804014327 * Math.exp(-x * x / 2);
    const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return x > 0 ? 1 - p : p;
  }

  function ninv(p) {
    if (!(p > 0 && p < 1)) return 0;
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
    const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    let q, r;
    if (p < 0.02425) {
      q = Math.sqrt(-2 * Math.log(p));
      return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    if (p <= 0.97575) {
      q = p - 0.5;
      r = q * q;
      return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
    }
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }

  function bs(St, K, T, r, v) {
    if (T <= 0 || v <= 0 || St <= 0 || K <= 0) {
      return {c: Math.max(St - K, 0), p: Math.max(K - St, 0), delta: St > K ? 1 : 0, itm: St > K ? 1 : 0};
    }
    const sq = v * Math.sqrt(T);
    const d1 = (Math.log(St / K) + (r + v * v / 2) * T) / sq;
    const d2 = d1 - sq;
    const call = St * ncdf(d1) - K * Math.exp(-r * T) * ncdf(d2);
    const put = call - St + K * Math.exp(-r * T);
    return {c: Math.max(call, 0), p: Math.max(put, 0), delta: ncdf(d1), itm: ncdf(d2)};
  }

  function inc(p) {
    return p < 25 ? 0.5 : p < 100 ? 1 : p < 250 ? 2.5 : 5;
  }

  function roundUp(x, i) {
    return Math.ceil(x / i - 1e-9) * i;
  }

  function oneIn(c) {
    if (!finite(c) || c < 0.02) return 'under 1 in 50';
    return '1 in ' + Math.max(1, Math.round(1 / c));
  }

  function parseISO(s) {
    if (!s || !/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
    const [y, m, d] = s.slice(0, 10).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }

  function toISO(d) {
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }

  function shortDate(s) {
    const d = parseISO(s);
    if (!d) return s || '—';
    return d.toLocaleDateString('en-US', {timeZone: 'UTC', month: 'short', day: 'numeric'});
  }

  function fridaysFrom(asofStr) {
    const base = parseISO(asofStr) || new Date(Date.UTC(2026, 9, 15));
    const d = new Date(base.getTime());
    while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1);
    const out = [];
    for (let i = 0; i < 5; i++) {
      const calDays = Math.round((d - base) / 86400000);
      if (calDays >= 1) out.push(toISO(d));
      d.setUTCDate(d.getUTCDate() + 7);
    }
    return out.slice(0, 4);
  }

  function calDaysBetween(asofStr, expStr) {
    const a = parseISO(asofStr), b = parseISO(expStr);
    if (!a || !b) return 7;
    return Math.max(1, Math.round((b - a) / 86400000));
  }

  function tradingDaysBetween(asofStr, expStr) {
    const a = parseISO(asofStr), b = parseISO(expStr);
    if (!a || !b || b <= a) return 1;
    let c = 0;
    const cur = new Date(a.getTime() + 86400000);
    while (cur <= b) {
      const wd = cur.getUTCDay();
      if (wd > 0 && wd < 6) c++;
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return Math.max(1, c);
  }

  /* ---------- Pure Math: Alpha & Macro Ranker ---------- */
  function rankAlphaCandidates(rows, preset, shock, horizon, useTactical60) {
    const hKey = horizon === '1d' ? 'res1d' : horizon === '5d' ? 'res5d' : 'res20d';
    const list = (rows || []).map(r => {
      const coef = r.rel ? (useTactical60 && r.rel.c60 ? r.rel.c60 : r.rel.c) : null;
      let scen = 0;
      let hasShock = false;
      if (coef && shock) {
        for (const f of FACTORS) {
          const s = Number(shock[f] || 0);
          if (s) {
            hasShock = true;
            if (finite(coef[f])) scen += coef[f] * s;
          }
        }
      }
      const alpha = finite(r[hKey]) ? r[hKey] : 0;
      const pefRel = finite(r.pef_sec_rel) ? r.pef_sec_rel : null;
      const epsG = finite(r.eps_g_imp) ? r.eps_g_imp : null;
      const ivrv = finite(r.ivrv_eff) ? r.ivrv_eff : finite(r.ivrv) ? r.ivrv : null;
      const vol = finite(r.iv) ? r.iv : finite(r.rv20) ? r.rv20 : finite(r.iv_sec_med) ? r.iv_sec_med : 28;
      const volSrc = finite(r.iv) ? 'ATM IV' : finite(r.rv20) ? '20d RV proxy' : 'Sector IV proxy';
      return {r, t: r.t, n: r.n, sec: r.sec, px: r.px, alpha, scen: hasShock ? scen : 0, hasShock, pefRel, epsG, ivrv, vol, volSrc};
    });

    let filtered = list;
    if (preset === 'tailwind_cheap') {
      filtered = list.filter(x => x.pefRel !== null && x.pefRel <= 0.98 && (x.hasShock ? x.scen >= 0 : x.alpha >= 0));
      filtered.sort((a, b) => ((b.hasShock ? b.scen : b.alpha) - (a.hasShock ? a.scen : a.alpha)) || (a.pefRel - b.pefRel));
    } else if (preset === 'pos_alpha') {
      filtered = list.filter(x => x.alpha >= 2.0);
      filtered.sort((a, b) => b.alpha - a.alpha);
    } else if (preset === 'cheap_vol') {
      filtered = list.filter(x => x.ivrv !== null && x.ivrv <= 1.05 && x.alpha >= 0);
      filtered.sort((a, b) => a.ivrv - b.ivrv || b.alpha - a.alpha);
    } else if (preset === 'rich_vol') {
      filtered = list.filter(x => x.ivrv !== null && x.ivrv >= 1.20 && (!finite(x.r.ern) || x.r.ern > 14));
      filtered.sort((a, b) => b.ivrv - a.ivrv);
    } else if (preset === 'beta_shift') {
      filtered = list.filter(x => x.r.rel && x.r.rel.bshift && finite(x.r.rel.bshift.us10y_bps));
      filtered.sort((a, b) => Math.abs(b.r.rel.bshift.us10y_bps) - Math.abs(a.r.rel.bshift.us10y_bps));
    } else {
      filtered.sort((a, b) => (b.alpha + b.scen) - (a.alpha + a.scen));
    }
    return filtered;
  }

  /* ---------- Pure Math: Pocket Option Chain Generator ---------- */
  function buildPocketCandidates(holdings, byTicker, asofStr, expStr, mode, rRate = 0.04, slip = 0.05) {
    const dte = calDaysBetween(asofStr, expStr);
    const T = Math.max(dte, 0.3) / 365;
    const out = [];
    holdings.forEach((h, ci) => {
      const row = byTicker.get(h.t);
      const price = finite(h.price) && h.price > 0 ? h.price : (row && finite(row.px) ? row.px : 0);
      const rawIv = finite(h.iv) && h.iv > 0 ? h.iv : (row && finite(row.iv) ? row.iv : row && finite(row.rv20) ? row.rv20 : row && finite(row.iv_sec_med) ? row.iv_sec_med : 0);
      const ivSrc = finite(h.iv) && h.iv > 0 ? 'custom' : (row && finite(row.iv) ? 'Yahoo ATM IV' : row && finite(row.rv20) ? '20d Realized Vol proxy' : 'Sector median IV');
      if (!(price > 0 && rawIv > 0)) return;
      const v = rawIv / 100;
      const step = inc(price);
      const earnDate = h.earn || (row && row.er) || '';
      const ed = earnDate ? calDaysBetween(asofStr, earnDate) : null;
      const earnIn = ed !== null && earnDate >= asofStr && ed <= dte;
      if (mode === 'put') {
        for (let n = 0; n < 100; n++) {
          const k = +(Math.floor(price * 0.9999 / step) * step - n * step).toFixed(2);
          if (k < price * 0.78 || k <= 0) break;
          const o = bs(price, k, T, rRate, v);
          const px = o.p * (1 - slip);
          if (px < 0.05) break;
          out.push({t: h.t, ci, k, price, iv: rawIv, ivSrc, otm: (price - k) / price, px, ann: (px / k) * (365 / Math.max(dte, 0.3)), p: 1 - o.itm, earnIn, earnDate});
        }
      } else {
        for (let n = 0; n < 100; n++) {
          const k = +(roundUp(price * 1.0001, step) + n * step).toFixed(2);
          if (k > price * 1.22) break;
          const o = bs(price, k, T, rRate, v);
          const px = o.c * (1 - slip);
          if (px < 0.05) break;
          out.push({t: h.t, ci, k, price, iv: rawIv, ivSrc, otm: (k - price) / price, px, ann: (px / price) * (365 / Math.max(dte, 0.3)), p: o.itm, earnIn, earnDate});
        }
      }
    });
    return {dte, list: out};
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {ncdf, ninv, bs, inc, roundUp, oneIn, fridaysFrom, calDaysBetween, tradingDaysBetween, rankAlphaCandidates, buildPocketCandidates};
  }
  if (!root.document) return;

  const $ = (s, el) => (el || document).querySelector(s);
  let api = null, page = null, openT = null;

  function loadState(d) {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { saved = null; }
    const byTicker = new Map((d.rows || []).map(r => [r.t, r]));
    const defHold = [];
    const base = {
      pillar: 'pocket',       // 'pocket' | 'alpha' | 'stress' | 'diff'
      mode: 'call',           // 'call' | 'put' | 'both'
      side: 'call',
      fExp: 1,
      goal: 0.15,
      oddsN: 8,
      lead: 'goal',           // 'goal' | 'odds'
      fEx: true,
      sel: {},
      putN: {},
      hold: defHold,
      alphaPreset: 'tailwind_cheap',
      alphaHorizon: '20d',
      useTactical60: false
    };
    if (!saved || typeof saved !== 'object') return base;
    const merged = Object.assign({}, base, saved);
    if (!Array.isArray(merged.hold) || !merged.hold.length) merged.hold = defHold;
    // Refresh live prices/IVs from core.json when not manually overridden
    merged.hold.forEach(h => {
      const r = byTicker.get(h.t);
      if (r) {
        if (!h.customPx && finite(r.px)) h.price = r.px;
        if (!h.customIv) h.iv = finite(r.iv) ? r.iv : (finite(r.rv20) ? r.rv20 : (finite(r.iv_sec_med) ? r.iv_sec_med : 30));
        if (!h.earn && r.er) h.earn = r.er;
        if (!finite(h.basis) || h.basis <= 0) h.basis = +(h.price * 0.94).toFixed(2);
      }
    });
    return merged;
  }

  let ST = null;
  function saveState() {
    try { localStorage.setItem(KEY, JSON.stringify(ST)); } catch (e) {}
  }

  /* Sync Edge Desk holdings into SmartOptionsImport My Book so Overview / Strategies / Flow stay 100% connected */
  function syncToMyBook() {
    if (!root.SmartOptionsImport || !ST || !Array.isArray(ST.hold) || !ST.hold.length) return;
    try {
      const cur = root.SmartOptionsImport.getData() || {};
      const book = {...(cur.book || {})};
      ST.hold.forEach(h => {
        if (h.t && h.shares > 0) {
          book[h.t] = {qty: h.shares, cost: finite(h.basis) ? h.basis : h.price};
        }
      });
      localStorage.setItem('so_import_v1', JSON.stringify({
        book,
        metrics: cur.metrics || null,
        series: cur.series || [],
        updatedAt: new Date().toISOString()
      }));
      root.dispatchEvent(new CustomEvent('so:import'));
    } catch (e) {}
  }

  function pullFromMyBook(d) {
    if (!root.SmartOptionsImport || !ST) return;
    const local = root.SmartOptionsImport.getData();
    const book = local && local.book ? local.book : null;
    if (!book || !Object.keys(book).length) return;
    const byTicker = new Map((d.rows || []).map(r => [r.t, r]));
    const nextHold = [];
    for (const [sym, pos] of Object.entries(book)) {
      const r = byTicker.get(sym);
      if (!r) continue;
      const existing = ST.hold.find(h => h.t === sym);
      nextHold.push({
        t: sym,
        shares: finite(pos.qty) && pos.qty > 0 ? pos.qty : 100,
        basis: finite(pos.cost) && pos.cost > 0 ? pos.cost : r.px,
        price: existing && existing.customPx ? existing.price : (root.SmartOptionsLive && root.SmartOptionsLive.get(sym) || {}).price || r.px,
        iv: existing && existing.customIv ? existing.iv : (finite(r.iv) ? r.iv : (finite(r.rv20) ? r.rv20 : 30)),
        earn: (r && r.er) || ''
      });
    }
    if (nextHold.length) {
      ST.hold = nextHold;
      saveState();
    }
  }

  function em() {
    return ST.mode === 'both' ? (ST.side || 'call') : ST.mode;
  }

  function withSide(sd, fn) {
    const orig = ST.side;
    ST.side = sd;
    try { return fn(); } finally { ST.side = orig; }
  }

  function contractsFor(t) {
    const h = ST.hold.find(x => x.t === t);
    if (!h) return 0;
    if (em() === 'put') {
      ST.putN = ST.putN || {};
      return Math.max(1, ST.putN[t] || Math.max(1, Math.floor((+h.shares || 100) / 100)));
    }
    return Math.floor((+h.shares || 0) / 100);
  }

  function pv() {
    return ST.hold.reduce((acc, h) => acc + (+h.shares || 0) * (+h.price || 0), 0);
  }

  function selKey(t, exp) {
    return (em() === 'put' ? 'P|' : '') + t + '|' + exp;
  }

  function portfolioFor(d, exp, cap) {
    const byTicker = new Map((d.rows || []).map(r => [r.t, r]));
    const {dte, list} = buildPocketCandidates(ST.hold, byTicker, d.asof_session, exp, em());
    let credit = 0;
    const rows = [], miss = [];
    ST.hold.forEach((h, ci) => {
      if (!(h.price > 0 && h.iv > 0)) {
        miss.push([h.t, ci, 'missing price/vol']);
        return;
      }
      const n = contractsFor(h.t);
      if (!n) {
        miss.push([h.t, ci, 'under 100 shares (need 100+ for 1 contract)']);
        return;
      }
      const cands = list.filter(c => c.t === h.t && c.p <= (cap ?? 1 / 3) + 1e-9 && !(ST.fEx && c.earnIn) && c.px >= 0.05);
      const best = cands.sort((a, b) => b.ann - a.ann)[0];
      if (!best) {
        const e = list.some(c => c.t === h.t && c.earnIn) && ST.fEx;
        miss.push([h.t, ci, e ? 'skipped: earnings before this Friday' : 'skipped: no strike pays $0.05+ at these odds']);
        return;
      }
      credit += best.px * 100 * n;
      rows.push({...best, n, h});
    });
    rows.sort((a, b) => b.ann - a.ann);
    const PV = em() === 'put' ? (rows.reduce((a, r) => a + r.k * 100 * r.n, 0) || 1) : (pv() || 1);
    return {dte, list, rows, miss, credit, PV, wk: credit * 7 / Math.max(dte, 0.3), ann: (credit / PV) * (365 / Math.max(dte, 0.3))};
  }

  function viewRowsFor(d, exp, capOverride) {
    const cap = capOverride ?? (1 / (ST.oddsN || 8));
    const P = portfolioFor(d, exp, cap);
    const {list} = P;
    ST.sel = ST.sel || {};
    const rows = P.rows.map(r => {
      const k = ST.sel[selKey(r.t, exp)];
      if (k == null) return {...r, sugK: r.k};
      const c = list.find(x => x.t === r.t && x.k === k);
      return c ? {...c, n: r.n, h: r.h, picked: true, sugK: r.k} : {...r, sugK: r.k};
    });
    const miss = [];
    P.miss.forEach(m => {
      const k = ST.sel[selKey(m[0], exp)];
      const c = k != null && list.find(x => x.t === m[0] && x.k === k);
      const n = contractsFor(m[0]);
      if (c && n) rows.push({...c, n, h: ST.hold.find(x => x.t === m[0]), picked: true, sugK: null});
      else miss.push(m);
    });
    rows.sort((a, b) => b.ann - a.ann);
    const credit = rows.reduce((a, r) => a + r.px * 100 * r.n, 0);
    const PV = em() === 'put' ? (rows.reduce((a, r) => a + r.k * 100 * r.n, 0) || 1) : (pv() || 1);
    return {...P, rows, miss, credit, PV, wk: credit * 7 / Math.max(P.dte, 0.3), ann: (credit / PV) * (365 / Math.max(P.dte, 0.3))};
  }

  function viewBothFor(d, exp, capOverride) {
    const Vc = withSide('call', () => viewRowsFor(d, exp, capOverride));
    const Vp = withSide('put', () => viewRowsFor(d, exp, capOverride));
    const rows = [], miss = [];
    ST.hold.forEach((h, ci) => {
      const c = Vc.rows.find(r => r.t === h.t);
      const q = Vp.rows.find(r => r.t === h.t);
      if (c && q) {
        const credit = c.px * 100 * c.n + q.px * 100 * q.n;
        const base = (+h.shares) * (+h.price) + q.k * 100 * q.n;
        const pAny = Math.min(c.p + q.p, 0.99);
        const ann = (credit / base) * (365 / Math.max(Vc.dte, 0.3));
        rows.push({t: h.t, ci, c, q, credit, base, pAny, ann, ivSrc: c.ivSrc, h});
      } else {
        const m = Vc.miss.find(x => x[0] === h.t) || Vp.miss.find(x => x[0] === h.t);
        miss.push([h.t, ci, m ? m[2] : 'no qualifying strangle']);
      }
    });
    rows.sort((a, b) => b.ann - a.ann);
    const credit = rows.reduce((a, r) => a + r.credit, 0);
    const PV = rows.reduce((a, r) => a + r.base, 0) || 1;
    return {dte: Vc.dte, rows, miss, credit, PV, wk: credit * 7 / Math.max(Vc.dte, 0.3), ann: (credit / PV) * (365 / Math.max(Vc.dte, 0.3))};
  }

  function solveCapFor(d, exp) {
    const evalAt = cap => (ST.mode === 'both' ? viewBothFor(d, exp, cap) : viewRowsFor(d, exp, cap)).ann;
    if (ST.lead === 'odds') {
      const cap = 1 / (ST.oddsN || 8);
      return {cap, N: ST.oddsN || 8, ok: true, ann: evalAt(cap)};
    }
    for (const N of ODDS) {
      const a = evalAt(1 / N);
      if (a >= ST.goal - 1e-9) return {cap: 1 / N, N, ok: true, ann: a};
    }
    return {cap: 1 / 3, N: 3, ok: false, ann: evalAt(1 / 3)};
  }

  /* ---------- SVG Lognormal Density + Payoff Curve (Artifact style) ---------- */
  function chartsForTicker(d, t, exp, legs) {
    const h = ST.hold.find(x => x.t === t);
    if (!h) return '';
    const S0 = +h.price, v = (+h.iv) / 100;
    const dte = calDaysBetween(d.asof_session, exp);
    const tdl = tradingDaysBetween(d.asof_session, exp);
    const T = Math.max(dte, 0.3) / 365;
    const sd = v * Math.sqrt(T);
    if (!(S0 > 0 && v > 0 && legs && legs.length)) return '';
    const ks = legs.map(l => l.k);
    const lo = Math.min(S0 * Math.exp(-2.4 * sd), ...ks.map(k => k * 0.985));
    const hi = Math.max(S0 * Math.exp(2.4 * sd), ...ks.map(k => k * 1.015));
    const W = 420, L = 12, Rr = 12;
    const X = p => L + (p - lo) / (hi - lo) * (W - L - Rr);
    const fmtP = p => '$' + (p >= 1000 ? Math.round(p).toLocaleString() : p >= 100 ? Math.round(p) : p.toFixed(p < 10 ? 2 : 1));
    const N = 120, ps = [...Array(N + 1)].map((_, i) => lo + (hi - lo) * i / N);
    const call = legs.find(l => l.type === 'call'), put = legs.find(l => l.type === 'put');

    const pdf = p => Math.exp(-Math.pow(Math.log(p / S0) + sd * sd / 2, 2) / (2 * sd * sd)) / (p * sd);
    const dm = Math.max(...ps.map(pdf));
    const H1 = 128, B1 = 88, T1 = 24;
    const Y1 = p => B1 - pdf(p) / dm * (B1 - T1);
    const area = (a, b) => {
      const pts = ps.filter(p => p >= a && p <= b);
      if (pts.length < 2) return '';
      return `M${X(pts[0]).toFixed(1)} ${B1} ` + pts.map(p => `L${X(p).toFixed(1)} ${Y1(p).toFixed(1)}`).join(' ') + ` L${X(pts[pts.length - 1]).toFixed(1)} ${B1} Z`;
    };
    const a1 = S0 * Math.exp(-sd), b1 = S0 * Math.exp(sd);
    let g1 = `<path d="${area(lo, hi)}" style="fill:var(--ed-accent);opacity:.14"/>`;
    g1 += `<path d="${area(a1, b1)}" style="fill:var(--ed-accent);opacity:.24"/>`;
    if (call) g1 += `<path d="${area(call.k, hi)}" style="fill:var(--ed-bad);opacity:.45"/>`;
    if (put) g1 += `<path d="${area(lo, put.k)}" style="fill:var(--ed-bad);opacity:.45"/>`;
    g1 += `<path d="M${ps.map(p => `${X(p).toFixed(1)} ${Y1(p).toFixed(1)}`).join(' L')}" style="fill:none;stroke:var(--ed-accent);stroke-width:1.7"/>`;
    g1 += `<line x1="${L}" x2="${W - Rr}" y1="${B1}" y2="${B1}" style="stroke:var(--ed-line)"/>`;
    g1 += `<line x1="${X(S0)}" x2="${X(S0)}" y1="${T1 - 8}" y2="${B1}" style="stroke:var(--ed-fg);stroke-width:1.5"/><text x="${X(S0)}" y="${T1 - 11}" text-anchor="middle" class="ed-ct-b">Spot ${fmtP(S0)}</text>`;
    legs.forEach(l => {
      const xx = X(l.k), anc = xx > W - 65 ? 'end' : xx < 65 ? 'start' : 'middle';
      g1 += `<line x1="${xx}" x2="${xx}" y1="${T1}" y2="${B1}" style="stroke:var(--ed-bad);stroke-width:1.5;stroke-dasharray:4 3"/><text x="${xx}" y="${B1 + 13}" text-anchor="${anc}" class="ed-ct-r">${l.type === 'call' ? 'Call' : 'Put'} ${fmtP(l.k)}</text>`;
    });
    g1 += `<text x="${(X(a1) + X(b1)) / 2}" y="${B1 + 28}" text-anchor="middle" class="ed-ct-m">1σ Expected Move (68% prob): ${fmtP(a1)} – ${fmtP(b1)}</text>`;
    const pAs = legs.reduce((a, l) => a + (l.p || 0), 0);

    // Payoff curve
    const shares = call ? call.n * 100 : 0;
    const PL = p => legs.reduce((a, l) => a + (l.type === 'call' ? (l.px * 100 * l.n + (Math.min(p, l.k) - S0) * 100 * l.n) : (l.px * 100 * l.n - Math.max(l.k - p, 0) * 100 * l.n)), 0);
    const HL = p => (p - S0) * shares;
    const ys = ps.map(PL).concat(shares ? ps.map(HL) : []).concat([0]);
    let ymn = Math.min(...ys), ymx = Math.max(...ys);
    const pad = (ymx - ymn) * 0.1 || 1;
    ymn -= pad; ymx += pad * 1.8;
    const H2 = 165, T2 = 14, B2 = 142;
    const Y2 = y => T2 + (ymx - y) / (ymx - ymn) * (B2 - T2), z0 = Y2(0);
    const line = f => 'M' + ps.map(p => `${X(p).toFixed(1)} ${Y2(f(p)).toFixed(1)}`).join(' L');
    let g2 = `<line x1="${L}" x2="${W - Rr}" y1="${z0}" y2="${z0}" style="stroke:var(--ed-muted);stroke-width:1"/><text x="${L + 2}" y="${z0 - 4}" text-anchor="start" class="ed-ct-m">$0</text>`;
    if (shares) g2 += `<path d="${line(HL)}" style="fill:none;stroke:var(--ed-muted);stroke-width:1.3;stroke-dasharray:5 4"/>`;
    g2 += `<path d="${line(PL)}" style="fill:none;stroke:var(--ed-accent);stroke-width:2.3"/>`;
    const mxP = Math.max(...ps.map(PL));
    const at = ps[ps.map(PL).indexOf(mxP)];
    g2 += `<text x="${Math.min(Math.max(X(at), 70), W - 70)}" y="${Y2(mxP) - 6}" text-anchor="middle" class="ed-ct-g">Max Profit ${fmtMoney(mxP)}</text>`;

    return `<div class="ed-ch">
      <div class="ed-ch-h"><b>Where ${esc(t)} may close (Black-Scholes lognormal density)</b><span>Fri ${esc(shortDate(exp))} · ${tdl} trading days</span></div>
      <svg viewBox="0 0 ${W} ${H1}" role="img" aria-label="Likely range of ${esc(t)} at expiry">${g1}</svg>
      <p class="ed-ch-n">Red tail: <b>${oneIn(Math.min(pAs, 0.99))}</b> model probability of assignment (${(Math.min(pAs, 0.99) * 100).toFixed(1)}%).</p>
      <div class="ed-ch-h" style="margin-top:4px"><b>Expiration Payoff Curve</b><span>${legs.map(l => `${l.n}× $${kfmt(l.k)} ${l.type}`).join(' + ')}</span></div>
      <svg viewBox="0 0 ${W} ${H2}" role="img" aria-label="Payoff at expiry">${g2}</svg>
    </div>`;
  }

  /* ---------- Pillar 1: Options income & Option Income Finder ---------- */
  function renderPocketPillar(d) {
    const fr = fridaysFrom(d.asof_session);
    if (ST.fExp >= fr.length) ST.fExp = 1;
    const exp = fr[ST.fExp] || fr[0];
    const sol = solveCapFor(d, exp);
    if (ST.lead === 'odds') {
      ST.goal = Math.min(Math.max(Math.round(sol.ann * 200) / 200, 0.05), 0.35);
    } else {
      ST.oddsN = sol.N;
    }
    const cap = sol.cap;
    const V = ST.mode === 'both' ? viewBothFor(d, exp, cap) : viewRowsFor(d, exp, cap);
    const byTicker = new Map((d.rows || []).map(r => [r.t, r]));

    const friHtml = fr.map((f, i) => {
      const s = solveCapFor(d, f);
      const vf = ST.mode === 'both' ? viewBothFor(d, f, s.cap) : viewRowsFor(d, f, s.cap);
      const td = tradingDaysBetween(d.asof_session, f);
      return `<button class="ed-fri-b" data-fexp="${i}" aria-pressed="${i === ST.fExp}">
        <span class="ed-fri-d">${esc(shortDate(f))}</span>
        <span class="ed-fri-n">${td} trading day${td === 1 ? '' : 's'}</span>
        <span class="ed-fri-y ed-num">Est. ${fmtMoney(vf.credit)}</span>
        <span class="ed-fri-n">Est. ${ST.lead === 'odds' ? fmtPct(s.ann) + '/yr' : (s.ok ? oneIn(s.cap) : 'max ' + fmtPct(s.ann))}</span>
      </button>`;
    }).join('');

    const what = ST.mode === 'both' ? 'strangles' : (em() === 'put' ? 'puts' : 'calls');
    const goalNote = ST.lead === 'odds'
      ? `At <b>Est. ${oneIn(cap)}</b> odds or safer, ${what} for Fri ${esc(shortDate(exp))} earn <b>Est. ${fmtPct(sol.ann)}</b> annualized (${fmtMoney(V.credit)} total credit).`
      : sol.ok
        ? `To earn <b>${fmtPct(ST.goal, 0)}</b> a year on Fri ${esc(shortDate(exp))}, ${what} model closing odds of up to <b>Est. ${oneIn(cap)}</b>. This is a model constraint, not a safety guarantee.`
        : `Fri ${esc(shortDate(exp))} reaches at most <b>Est. ${fmtPct(sol.ann)}</b> annualized at 1 in 3 odds. Different inputs change the modeled outcome.`;

    let bodyHtml = '';
    if (openT && ST.hold.some(h => h.t === openT)) {
      const h = ST.hold.find(x => x.t === openT);
      const r = byTicker.get(openT);
      const {list} = buildPocketCandidates([h], byTicker, d.asof_session, exp, em());
      const cur = V.rows.find(x => x.t === openT);
      const selK = cur ? (cur.k || (cur.c && cur.c.k)) : (list[0] && list[0].k);
      const lad = list.slice(0, 8);
      const sel = list.find(c => c.k === selK) || lad[0];
      const nn = Math.max(1, contractsFor(openT));
      const legs = sel ? [{type: em(), k: sel.k, px: sel.px, n: nn, p: sel.p}] : [];
      bodyHtml = `<div class="ed-vc">
        <div class="ed-dt-top">
          <button class="ed-btn ghost" data-pocket-back="1">← Back to all stocks</button>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="ed-btn" data-open-analyst="${esc(openT)}">Open ${esc(openT)} Chart & Peers ↗</button>
            <button class="ed-btn solid" data-open-strat="${esc(openT)}">Open Full 28-Strategy Engine ↗</button>
          </div>
        </div>
        <h3 class="ed-vc-title">${esc(openT)} · ${fmtMoney2(h.price)} · Vol ${h.iv.toFixed(1)}% (${esc(sel ? sel.ivSrc : 'model')})</h3>
        <p class="ed-vc-dek">${r ? `Sector: ${esc(r.sec)} · 20d Idiosyncratic Alpha: ${fmtSignedPct(r.res20d)} · Fwd P/E: ${finite(r.pef) ? r.pef.toFixed(1) + 'x' : '—'} (${finite(r.pef_sec_rel) ? r.pef_sec_rel.toFixed(2) + 'x sector' : '—'})` : ''}</p>
        <div class="ed-lad">
          <div class="ed-lad-h"><span>Strike</span><span>OTM Distance</span><span>Est. credit / est. annualized</span><span>Est. closing odds</span></div>
          ${lad.map(c => `<button class="ed-lad-r${c.k === selK ? ' on' : ''}" data-pick-k="${c.k}">
            <span class="ed-num"><b>$${kfmt(c.k)}</b>${cur && c.k === cur.sugK ? '<em>model selection</em>' : ''}</span>
            <span class="ed-num">${em() === 'put' ? '−' : '+'}${fmtPct(c.otm)}</span>
            <span class="ed-num"><b>Est. ${fmtMoney(c.px * 100 * nn)}</b><small>Est. ${fmtPct(c.ann)}/yr (${fmtMoney2(c.px)}/sh)</small></span>
            <span><span class="ed-pill ${c.p < 0.10 ? 'good' : c.p < 0.20 ? 'warn' : 'bad'}">Est. ${oneIn(c.p)}</span></span>
          </button>`).join('')}
        </div>
        ${chartsForTicker(d, openT, exp, legs)}
      </div>`;
    } else {
      const mx = Math.max(ST.goal * 1.35, ...V.rows.map(r => r.ann), 0.01);
      const SC = 76;
      const gx = Math.min(ST.goal / mx, 1) * SC;
      const wd = a => Math.max(Math.min(a / mx, 1) * SC, 2);
      const hit = V.rows.filter(r => r.ann >= ST.goal - 1e-9).length;
      bodyHtml = `<div class="ed-vc">
        <div class="ed-vc-kick">${ST.mode === 'both' ? 'Short Strangles' : em() === 'put' ? 'Cash-Secured Puts' : 'Covered Calls'} · Fri ${esc(shortDate(exp))}</div>
        <h3 class="ed-vc-title">${hit} of ${V.rows.length} ${what} hit your ${fmtPct(ST.goal, 0)} goal</h3>
        <p class="ed-vc-dek">Model estimate at the selected strike on each holding at ${oneIn(cap)} odds or safer, ranked by annualized yield. Tap any stock to inspect its strike ladder, probability density, payoff curve, or launch Analyst / Strategies.</p>
        <div class="ed-vc-key">
          <span><i class="ed-sw ok"></i>Meets ${fmtPct(ST.goal, 0)} goal</span>
          <span><i class="ed-sw lo"></i>Below goal</span>
          <span><i class="ed-gl"></i>Your ${fmtPct(ST.goal, 0)} target</span>
        </div>
        <div class="ed-vc-list">
          ${V.rows.map((r, idx) => {
            const pVal = ST.mode === 'both' ? r.pAny : r.p;
            const prem = ST.mode === 'both' ? r.credit : r.px * 100 * r.n;
            const sub = ST.mode === 'both'
              ? `$${kfmt(r.c.k)} call + $${kfmt(r.q.k)} put · ${r.c.ivSrc}`
              : `$${kfmt(r.k)} ${em()} · ${em() === 'put' ? '−' : '+'}${fmtPct(r.otm)} OTM · ${r.n} contract${r.n > 1 ? 's' : ''} · ${r.ivSrc}`;
            const oc = pVal < 0.10 ? 'good' : pVal < 0.20 ? 'warn' : 'bad';
            return `<button class="ed-vc-r" data-pocket-open="${esc(r.t)}">
              <span class="ed-vc-n">${idx + 1}</span>
              <span class="ed-vc-m">
                <span class="ed-vc-t">
                  <span class="ed-vc-tk"><span class="ed-dot" style="background:var(--ed-c${r.ci % 11})"></span>${esc(r.t)}</span>
                  <span class="ed-vc-p ed-num">${fmtMoney(prem)}</span>
                </span>
                <span class="ed-vc-bar">
                  <span class="ed-vc-fill ${r.ann >= ST.goal - 1e-9 ? 'ok' : 'lo'}" style="width:${wd(r.ann).toFixed(1)}%"></span>
                  <span class="ed-vc-goal" style="left:${gx.toFixed(1)}%"></span>
                  <b class="ed-vc-v ed-num" style="left:calc(${wd(r.ann).toFixed(1)}% + 6px)">Est. ${fmtPct(r.ann)}</b>
                </span>
                <span class="ed-vc-s ed-num"><span>${esc(sub)}</span><span class="ed-pill ${oc}">Est. ${oneIn(pVal)}</span></span>
              </span>
              <span>›</span>
            </button>`;
          }).join('')}
          ${V.miss.map(m => `<div class="ed-vc-r dim"><span class="ed-vc-n">–</span><span class="ed-vc-m"><span class="ed-vc-t"><span class="ed-vc-tk">${esc(m[0])}</span></span><span class="ed-vc-s">${esc(m[2])}</span></span><span></span></div>`).join('')}
        </div>
      </div>`;
    }

    const holdHtml = ST.hold.map((h, idx) => {
      const r = byTicker.get(h.t);
      const ivLabel = r && finite(r.iv) ? `Yahoo ATM IV ${r.iv.toFixed(1)}%` : (r && finite(r.rv20) ? `20d RV proxy ${r.rv20.toFixed(1)}%` : `Vol ${h.iv.toFixed(1)}%`);
      return `<div class="ed-hl-item">
        <div class="ed-hl-row">
          <input data-hidx="${idx}" data-hk="t" value="${esc(h.t)}" aria-label="Symbol">
          <input data-hidx="${idx}" data-hk="shares" value="${h.shares}" type="number" step="100" aria-label="Shares of ${esc(h.t)}">
          <input data-hidx="${idx}" data-hk="basis" value="${finite(h.basis) ? h.basis : h.price}" type="number" step="0.01" aria-label="Cost basis of ${esc(h.t)}">
          <button class="ed-hl-x" data-hdel="${idx}" title="Remove ${esc(h.t)}">×</button>
        </div>
        <div class="ed-hl-meta">
          <span>Spot <b>${fmtMoney2(h.price)}</b></span>
          <span>${esc(ivLabel)}</span>
          ${r && finite(r.res20d) ? `<span>20d Alpha <b>${fmtSignedPct(r.res20d)}</b></span>` : ''}
          ${h.earn ? `<span>Next Earn <b>${esc(shortDate(h.earn))}</b></span>` : ''}
          <button class="ed-btn ghost" style="padding:1px 7px;font-size:11px" data-open-analyst="${esc(h.t)}">Chart ↗</button>
        </div>
      </div>`;
    }).join('');

    return `
      <div class="ed-card">
        <div class="ed-seg" id="edModeSeg" role="group" aria-label="Option Strategy">
          <button data-ed-mode="call" aria-pressed="${ST.mode === 'call'}">Covered Calls</button>
          <button data-ed-mode="put" aria-pressed="${ST.mode === 'put'}">Cash-Secured Puts</button>
          <button data-ed-mode="both" aria-pressed="${ST.mode === 'both'}">Short Strangles</button>
        </div>
        <p class="ed-mode-note">${ST.mode === 'both' ? 'Sell an OTM call and OTM put simultaneously. Captures double premium when stock stays inside the expected move band.' : ST.mode === 'put' ? 'Get paid to agree to buy shares below today’s spot price. Sized against cash collateral.' : 'Get paid to agree to sell shares you own above today’s spot price. Sized against your My Book share lots.'}</p>

        <div class="ed-step"><span class="ed-stepn">1</span><b>Pick the Friday Expiration</b><span class="ed-step-r">trading days · est. credit · odds</span></div>
        <div class="ed-fri">${friHtml}</div>

        <div class="ed-step"><span class="ed-stepn">2</span><b>Set Your Income Goal or Estimated closing risk</b><span class="ed-step-r">move either slider — the other solves automatically</span></div>
        <div class="ed-dual">
          <div class="ed-dl ${ST.lead === 'goal' ? 'lead' : ''}">
            <label for="edGoal">Annualized Income Goal</label>
            <span class="ed-lead-tag">${ST.lead === 'goal' ? 'you set' : 'solved'}</span>
            <b class="ed-num">${fmtPct(ST.goal, ST.goal * 1000 % 10 ? 1 : 0)} / yr</b>
          </div>
          <input type="range" id="edGoal" min="0.05" max="0.35" step="0.005" value="${ST.goal}">
          <div class="ed-capticks ed-num"><span>5%</span><span>10%</span><span>15%</span><span>20%</span><span>25%</span><span>30%</span><span>35%</span></div>

          <div class="ed-dl ${ST.lead === 'odds' ? 'lead' : ''}">
            <label for="edOdds">Max Odds of Assignment (Black-Scholes N(d₂))</label>
            <span class="ed-lead-tag">${ST.lead === 'odds' ? 'you set' : 'solved'}</span>
            <b class="ed-num">${oneIn(1 / ST.oddsN)}</b>
          </div>
          <input type="range" id="edOdds" min="0" max="9" step="1" value="${Math.max(0, ODDS.indexOf(ST.oddsN))}">
          <div class="ed-capticks ed-num"><span>1 in 20 (5%)</span><span>1 in 10 (10%)</span><span>1 in 8 (12.5%)</span><span>1 in 6 (17%)</span><span>1 in 3 (33%)</span></div>
        </div>

        <div class="ed-goal-res">${goalNote}</div>

        <div class="ed-capsum">
          <div class="ed-cs"><span>Est. Total Credit</span><b class="ed-num">${fmtMoney(V.credit)}</b></div>
          <div class="ed-cs"><span>Est. weekly yield</span><b class="ed-num">${fmtPct(V.wk / V.PV, 2)}</b></div>
          <div class="ed-cs"><span>Est. annualized yield</span><b class="ed-num">${fmtPct(V.ann, 1)}</b></div>
          <div class="ed-cs"><span>Book Value</span><b class="ed-num">${fmtMoney(V.PV)}</b></div>
          <p class="ed-cs-note">Estimates only, not executable quotes or trade recommendations. Black-Scholes lognormal European closing model (5% slippage haircut, r=4.0%); closing odds do not measure early assignment. Underlying observations may be delayed. Uses dated Yahoo ATM IV where fetched, with automatic fallback to 20-session annualized realized vol (rv20) across all covered stocks.</p>
        </div>

        <div class="ed-step"><span class="ed-stepn">3</span><b>${openT ? 'Inspect Strike Ladder & Payoff' : 'Pick a Stock to Inspect Strikes'}</b><span class="ed-step-r">Fri ${esc(shortDate(exp))} · ${tradingDaysBetween(d.asof_session, exp)} trading days</span></div>
        ${bodyHtml}
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
          <input type="checkbox" id="edExEarn" ${ST.fEx ? 'checked' : ''} style="width:17px;height:17px;accent-color:var(--ed-accent)">
          Automatically skip stocks with earnings before Friday expiration
        </label>
      </div>

      <div class="ed-card">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
          <div>
            <div class="ed-vc-kick">Your Stocks · Synced Live with My Book</div>
            <h3 style="margin:2px 0 0;font-family:var(--ed-f-display);font-size:20px">Symbols, Shares & Cost Basis (${ST.hold.length} holdings · ${fmtMoney(pv())})</h3>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="ed-btn ghost" id="edResetBook">Reset desk controls (preserves My Book)</button>
            <button class="ed-btn" id="edOpenOverviewBook">View in Overview Table ↗</button>
          </div>
        </div>
        <div class="ed-hold-list">
          <div class="ed-hl-head"><span>Symbol</span><span>Shares</span><span>Cost Basis ($)</span><span></span></div>
          ${holdHtml}
          <div class="ed-hl-row" style="border-top:2px solid var(--ed-line);padding-top:10px;margin-top:4px">
            <input id="edAddSym" placeholder="Add S&P Ticker (e.g. META)" list="edDatalist">
            <input id="edAddShares" type="number" step="100" value="100" placeholder="Shares">
            <input id="edAddBasis" type="number" step="0.01" placeholder="Basis $ (optional)">
            <button class="ed-btn solid" id="edAddBtn" style="height:36px;padding:0">+</button>
          </div>
          <datalist id="edDatalist">${(d.rows || []).map(r => `<option value="${esc(r.t)}">${esc(r.n)}</option>`).join('')}</datalist>
        </div>
      </div>`;
  }

  /* ---------- Pillar 2: Company comparisons (365 S&P Universe) ---------- */
  function renderAlphaPillar(d) {
    const shock = api.S ? api.S().shock : {spy: 0, us10y_bps: 0, dxy: 0, wti: 0, vix: 0};
    const ranked = rankAlphaCandidates(d.rows, ST.alphaPreset, shock, ST.alphaHorizon, ST.useTactical60);
    const top = ranked.slice(0, 15);
    const mx = Math.max(...top.map(x => Math.abs(x.alpha) + Math.abs(x.scen)), 5);

    const presets = [
      ['tailwind_cheap', 'Macro Tailwind + Cheap (<1.0x Sector P/E)'],
      ['pos_alpha', 'Top Idiosyncratic Alpha (+2%+ Residual)'],
      ['cheap_vol', 'Cheap Volatility (IV/RV ≤ 1.05x)'],
      ['rich_vol', 'Rich Option Estimated premium (IV/RV ≥ 1.20x)'],
      ['beta_shift', 'Largest 60d vs 252d Beta Regime Shift']
    ];

    return `
      <div class="ed-card">
        <div class="ed-step"><span class="ed-stepn">1</span><b>Select a Deterministic Edge Formula</b><span class="ed-step-r">covered S&P 500 stocks · 5-factor OLS</span></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${presets.map(([id, label]) => `<button class="ed-btn ${ST.alphaPreset === id ? 'solid' : 'ghost'}" data-alpha-preset="${id}">${esc(label)}</button>`).join('')}
        </div>

        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;padding-top:4px;border-top:1px solid var(--ed-line)">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:12.5px;color:var(--ed-muted)">Residual Horizon:</span>
            ${['1d', '5d', '20d'].map(h => `<button class="ed-btn ${ST.alphaHorizon === h ? 'solid' : 'ghost'}" data-alpha-h="${h}" style="padding:4px 9px">${h} Alpha</button>`).join('')}
          </div>
          <label style="display:flex;align-items:center;gap:7px;font-size:12.5px;cursor:pointer">
            <input type="checkbox" id="edUse60" ${ST.useTactical60 ? 'checked' : ''} style="accent-color:var(--ed-accent)">
            Use Tactical 60-Session Rolling Betas (vs. 252-Session Structural)
          </label>
        </div>

        <div class="ed-vc">
          <div class="ed-vc-kick">Pure Math Ranking · ${ranked.length} Matching Stocks out of ${d.rows.length}</div>
          <h3 class="ed-vc-title">Top ${top.length} Setups Ranked by ${ST.alphaHorizon} Idiosyncratic Alpha & Valuation</h3>
          <p class="ed-vc-dek">Idiosyncratic Residual = Actual Stock Return minus ∑(OLS Factor Beta × Factor Move). Click any row to add to your Pocket Book or open full technicals & relative ratio chart.</p>
          <div class="ed-vc-list">
            ${top.map((x, idx) => {
              const r = x.r;
              const wPct = Math.min(72, Math.max(4, (Math.abs(x.alpha) / mx) * 72));
              const b10_252 = r.rel && finite(r.rel.c.us10y_bps) ? (r.rel.c.us10y_bps * 10).toFixed(2) + '%' : '—';
              const b10_60 = r.rel && r.rel.c60 && finite(r.rel.c60.us10y_bps) ? (r.rel.c60.us10y_bps * 10).toFixed(2) + '%' : '—';
              const drift = r.sam_drift && finite(r.sam_drift.px_pct) ? `Drift since 07-25: ${fmtSignedPct(r.sam_drift.px_pct)}` : '';
              return `<div class="ed-vc-r" style="cursor:default">
                <span class="ed-vc-n">${idx + 1}</span>
                <span class="ed-vc-m">
                  <span class="ed-vc-t">
                    <span class="ed-vc-tk"><span class="ed-dot" style="background:var(--ed-c${idx % 11})"></span>${esc(r.t)}</span>
                    <span style="font-size:12px;color:var(--ed-muted)">${esc(r.n)} · ${esc(r.sec)}</span>
                    <span class="ed-vc-p ed-num">${fmtMoney2(r.px)}</span>
                  </span>
                  <span class="ed-vc-bar">
                    <span class="ed-vc-fill ${x.alpha >= 0 ? 'pos' : 'neg'}" style="width:${wPct.toFixed(1)}%"></span>
                    <b class="ed-vc-v ed-num" style="left:calc(${wPct.toFixed(1)}% + 6px)">${ST.alphaHorizon} Alpha: ${fmtSignedPct(x.alpha)} ${x.hasShock ? ` · Shock: ${fmtSignedPct(x.scen)}` : ''}</b>
                  </span>
                  <span class="ed-vc-s ed-num">
                    <span>Fwd P/E: <b>${finite(r.pef) ? r.pef.toFixed(1) + 'x' : '—'}</b> (${x.pefRel ? x.pefRel.toFixed(2) + 'x sec' : '—'}) · Imp EPSg: <b>${x.epsG !== null ? fmtSignedPct(x.epsG, 1) : '—'}</b> · IV/RV: <b>${x.ivrv ? x.ivrv.toFixed(2) + 'x' : '—'}</b> · β10Y (252d/60d): ${b10_252} / ${b10_60} ${drift ? ' · ' + drift : ''}</span>
                    <span style="display:flex;gap:5px">
                      <button class="ed-btn ghost" style="padding:2px 7px;font-size:11px" data-add-to-book="${esc(r.t)}">+ Book</button>
                      <button class="ed-btn" style="padding:2px 7px;font-size:11px" data-open-ratio="${esc(r.t)}">Ratio vs SPY ↗</button>
                      <button class="ed-btn solid" style="padding:2px 7px;font-size:11px" data-open-strat="${esc(r.t)}">Options ↗</button>
                    </span>
                  </span>
                </span>
                <span></span>
              </div>`;
            }).join('')}
          </div>
        </div>
      </div>`;
  }

  /* ---------- Pillar 3: Portfolio scenarios & Hedge Sizer ---------- */
  function renderStressPillar(d) {
    const sObj = api.S ? api.S() : {shock: {spy: 0, us10y_bps: 0, dxy: 0, wti: 0, vix: 0}};
    const shock = sObj.shock || {spy: 0, us10y_bps: 0, dxy: 0, wti: 0, vix: 0};
    const byTicker = new Map((d.rows || []).map(r => [r.t, r]));
    const totalVal = pv() || 1;

    let totPnl = 0, totShockDollar = 0;
    const wBeta = {spy: 0, us10y_bps: 0, dxy: 0, wti: 0, vix: 0};
    const posRows = ST.hold.map((h, ci) => {
      const r = byTicker.get(h.t);
      const val = (+h.shares || 0) * (+h.price || 0);
      const wt = val / totalVal;
      const pnl = (+h.shares || 0) * ((+h.price || 0) - (+h.basis || h.price || 0));
      totPnl += pnl;
      const coef = r && r.rel ? (ST.useTactical60 && r.rel.c60 ? r.rel.c60 : r.rel.c) : null;
      let scPct = 0;
      if (coef) {
        for (const f of FACTORS) {
          if (finite(coef[f])) {
            wBeta[f] += wt * coef[f];
            scPct += coef[f] * (shock[f] || 0);
          }
        }
      }
      const scDollar = val * (scPct / 100);
      totShockDollar += scDollar;
      return {h, r, ci, val, wt, pnl, scPct, scDollar, lots: Math.floor((+h.shares || 0) / 100)};
    }).sort((a, b) => a.scDollar - b.scDollar);

    const totShockPct = (totShockDollar / totalVal) * 100;

    return `
      <div class="ed-card">
        <div class="ed-step"><span class="ed-stepn">1</span><b>Dial a Macro Factor Shock (Synced Live with Analyst & Overview)</b><span class="ed-step-r">${ST.useTactical60 ? '60d Tactical OLS Betas' : '252d Structural OLS Betas'}</span></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="ed-btn ghost" data-shock-preset="rates">Rates Spike (10Y +25bp)</button>
          <button class="ed-btn ghost" data-shock-preset="riskoff">Risk-Off (SPY −3%, VIX +5pt)</button>
          <button class="ed-btn ghost" data-shock-preset="oil">Oil Shock (WTI +10%, 10Y +15bp)</button>
          <button class="ed-btn ghost" data-shock-preset="rally">Soft-Landing Rally (10Y −20bp, VIX −3pt)</button>
          <button class="ed-btn ghost" data-shock-preset="clear">Reset Shocks (0)</button>
        </div>

        <div class="ed-shock-grid">
          ${[
            ['us10y_bps', -50, 50, 5, 'bp'],
            ['vix', -10, 15, 1, 'pt'],
            ['spy', -10, 10, 1, '%'],
            ['wti', -20, 20, 2, '%'],
            ['dxy', -5, 5, 0.5, '%']
          ].map(([f, mn, mx, stp, u]) => `<div class="ed-shock-item">
            <label><span>${esc(FLABEL[f])}</span><b class="ed-num">${(shock[f] || 0) > 0 ? '+' : ''}${shock[f] || 0}${u}</b></label>
            <input type="range" data-shock-f="${f}" min="${mn}" max="${mx}" step="${stp}" value="${shock[f] || 0}">
          </div>`).join('')}
        </div>

        <div class="ed-capsum">
          <div class="ed-cs"><span>Portfolio Market Value</span><b class="ed-num">${fmtMoney(totalVal)}</b></div>
          <div class="ed-cs"><span>Unrealized P&L</span><b class="ed-num" style="color:${totPnl >= 0 ? 'var(--ed-good)' : 'var(--ed-bad)'}">${fmtMoney(totPnl)}</b></div>
          <div class="ed-cs"><span>Net Shock Impact ($)</span><b class="ed-num" style="color:${totShockDollar >= 0 ? 'var(--ed-good)' : 'var(--ed-bad)'}">${fmtMoney(totShockDollar)}</b></div>
          <div class="ed-cs"><span>Net Shock Impact (%)</span><b class="ed-num" style="color:${totShockPct >= 0 ? 'var(--ed-good)' : 'var(--ed-bad)'}">${fmtSignedPct(totShockPct, 2)}</b></div>
          <p class="ed-cs-note">Value-Weighted Portfolio Betas: β_SPY <b>${wBeta.spy.toFixed(2)}%</b> · β_10Y (+10bp) <b>${(wBeta.us10y_bps * 10).toFixed(2)}%</b> · β_VIX (+1pt) <b>${wBeta.vix.toFixed(2)}%</b> · β_WTI (+1%) <b>${wBeta.wti.toFixed(2)}%</b> · β_DXY (+1%) <b>${wBeta.dxy.toFixed(2)}%</b></p>
        </div>

        <div class="ed-vc">
          <div class="ed-vc-kick">Position-Level Shock Attribution & 1-Click Option Hedge Sizing</div>
          <h3 class="ed-vc-title">Holdings Ranked by Macro Shock Vulnerability</h3>
          <p class="ed-vc-dek">Shows each position’s exact dollar & percentage impact under your active factor shock, plus contract sizing (⌊shares / 100⌋) for collars or protective puts.</p>
          <div class="ed-vc-list">
            ${posRows.map((p, idx) => {
              const wPct = Math.min(70, Math.max(3, Math.abs(p.scPct) * 8));
              const earnWarn = p.r && finite(p.r.ern) && p.r.ern >= 0 && p.r.ern <= 14 ? ` · Earn in ${p.r.ern}d` : '';
              return `<div class="ed-vc-r" style="cursor:default">
                <span class="ed-vc-n">${idx + 1}</span>
                <span class="ed-vc-m">
                  <span class="ed-vc-t">
                    <span class="ed-vc-tk"><span class="ed-dot" style="background:var(--ed-c${p.ci % 11})"></span>${esc(p.h.t)}</span>
                    <span style="font-size:12px;color:var(--ed-muted)">${p.h.shares} sh (${(p.wt * 100).toFixed(1)}% of book)${earnWarn}</span>
                    <span class="ed-vc-p ed-num" style="color:${p.scDollar >= 0 ? 'var(--ed-good)' : 'var(--ed-bad)'}">${fmtMoney(p.scDollar)} (${fmtSignedPct(p.scPct, 2)})</span>
                  </span>
                  <span class="ed-vc-bar">
                    <span class="ed-vc-fill ${p.scDollar >= 0 ? 'pos' : 'neg'}" style="width:${wPct.toFixed(1)}%"></span>
                    <b class="ed-vc-v ed-num" style="left:calc(${wPct.toFixed(1)}% + 6px)">Position Value ${fmtMoney(p.val)} · Unrlz P&L ${fmtMoney(p.pnl)}</b>
                  </span>
                  <span class="ed-vc-s ed-num">
                    <span>Hedge Sizing: <b>${p.lots} contract${p.lots === 1 ? '' : 's'}</b> (${p.lots * 100} sh covered) · 20d Alpha: ${p.r ? fmtSignedPct(p.r.res20d) : '—'}</span>
                    <span style="display:flex;gap:6px">
                      <button class="ed-btn" style="padding:2px 8px;font-size:11px" data-pocket-open-from-stress="${esc(p.h.t)}">Size Collar / Call in Pocket</button>
                      <button class="ed-btn solid" style="padding:2px 8px;font-size:11px" data-open-strat="${esc(p.h.t)}">Open Strategy Payoff ↗</button>
                    </span>
                  </span>
                </span>
                <span></span>
              </div>`;
            }).join('')}
          </div>
        </div>
      </div>`;
  }

  /* ---------- Pillar 4: What's New (Edge vs V2 Audit & Live Formulas) ---------- */
  function renderDiffPillar(d) {
    const fitted = (d.rows || []).filter(r => r.rel).length;
    const withRv = (d.rows || []).filter(r => finite(r.rv20)).length;
    const withLer = (d.rows || []).filter(r => r.ler).length;
    return `
      <div class="ed-card">
        <div class="ed-vc-kick">Transparent Architecture & Formula Audit</div>
        <h3 style="margin:0;font-family:var(--ed-f-display);font-size:24px">Methods and limits</h3>
        <p class="ed-mode-note" style="margin:0">100% of core rankings, option pricing, volatility proxies, factor regressions, and portfolio stress tests run on deterministic Python & JavaScript math — formulas with source and model limits.</p>
        <div style="overflow-x:auto">
          <table class="ed-cmp-table">
            <thead>
              <tr>
                <th>System / Capability</th>
                <th>Original SmartOptions V2</th>
                <th>SmartOptions Edge (Overhauled)</th>
                <th>Deterministic Formula / Live Proof</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><b>1. Primary UX & Weekly Option Finder</b></td>
                <td>Dense 6-tab workstation; required navigating multiple drawers to size covered calls or puts.</td>
                <td><b>Edge Desk (<code>#pg-edge</code>)</b> with 1-click Friday chips, coupled Income Goal ↔ Est. closing odds sliders, visual goal bars, and inline strike ladder.</td>
                <td class="ed-num">Black-Scholes N(d₂) assignment odds, binary goal solver (<code>solveCapFor</code>), lognormal density + payoff SVG.</td>
              </tr>
              <tr>
                <td><b>2. Volatility Coverage Across Universe</b></td>
                <td>Delayed ATM IV fetched for only ~65 movers/earnings stocks; remaining ~300 stocks refused to price options.</td>
                <td>Full <b>${withRv} / ${d.rows.length} stock coverage</b> via 20-session annualized realized vol (<code>rv20</code>) and GICS sector median IV (<code>iv_sec_med</code>).</td>
                <td class="ed-num">RV₂₀ = std_20d(ln(C_t / C_{t-1})) × √252 × 100.</td>
              </tr>
              <tr>
                <td><b>3. Multi-Horizon Idiosyncratic Alpha</b></td>
                <td>Attribution computed only for 1-day movers (Set A, 40 stocks) and only on a 1-day window.</td>
                <td><b>1d, 5d, and 20d idiosyncratic residuals (<code>res1d</code>, <code>res5d</code>, <code>res20d</code>)</b> across all <b>${fitted} fitted S&P stocks</b>.</td>
                <td class="ed-num">ε_k = R_{i,k} − ∑(β_{i,f}^{252d} × ΔF_{f,k}). Isolates true stock alpha from macro wind.</td>
              </tr>
              <tr>
                <td><b>4. Tactical 60d vs. Structural 252d Betas</b></td>
                <td>Only 252-session OLS betas shown; masked recent sensitivity shifts.</td>
                <td>Both <b>60-session tactical OLS (<code>c60</code>, <code>t60</code>, <code>r2_60</code>)</b> and <b>252-session structural OLS</b> plus <code>bshift</code>.</td>
                <td class="ed-num">Δβ = β_{60d} − β_{252d} across SPY, 10Y, DXY, WTI, VIX.</td>
              </tr>
              <tr>
                <td><b>5. Stale Snapshot Quarantine & Drift</b></td>
                <td>Historical 2026-07-25 snapshot voted silently inside today’s live directional Flow & Confidence scores.</td>
                <td><b>Quarantined by default when &gt;30d old</b> (<code>includeStaleSamVote: false</code>), replaced with live 20d Alpha vote + explicit <b>Price & Fwd P/E Drift since 07-25</b>.</td>
                <td class="ed-num">Px Drift = (Px_today / Px_07-25 − 1) × 100; ΔPE_fwd = PE_fwd − FPE_07-25.</td>
              </tr>
              <tr>
                <td><b>6. Chart Comparison Modes</b></td>
                <td>Raw dual-axis overlay only (visually distorted two stocks at different dollar prices).</td>
                <td><b>Dual Scale</b>, <b>Indexed % (0% at start of window)</b>, and <b>Relative Ratio (Selection / Overlay indexed to 100)</b>.</td>
                <td class="ed-num">Indexed_t = (P_t / P_0 − 1) × 100; Ratio_t = (A_t / B_t) / (A_0 / B_0) × 100.</td>
              </tr>
              <tr>
                <td><b>7. Post-Earnings Dip-Buy Pattern (<code>earn_dip</code>)</b></td>
                <td>Permanently unavailable because <code>lastEarnings</code> was never exported to <code>core.json</code>.</td>
                <td>Active across <b>${withLer} / ${d.rows.length} stocks</b> with prior earnings date <code>ler</code> and provenance <code>lers</code>.</td>
                <td class="ed-num">Yahoo last_date or −91d quarterly cycle anchored to volume-gap session.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="ed-btn solid" data-switch-tab="overview">Inspect Classic V2 Overview ↗</button>
          <button class="ed-btn" data-switch-tab="markets">Inspect Classic V2 Analyst Workbench ↗</button>
          <button class="ed-btn" data-switch-tab="patterns">Inspect 11-Rule Pattern Scanner ↗</button>
          <button class="ed-btn" data-switch-tab="flow">Inspect 4-Step Daily Guide ↗</button>
        </div>
      </div>`;
  }

  function render() {
    if (!page || !api || !api.D()) return;
    const d = api.D();
    if (!ST) ST = loadState(d);

    let mainContent = '';
    if (ST.pillar === 'alpha') mainContent = renderAlphaPillar(d);
    else if (ST.pillar === 'stress') mainContent = renderStressPillar(d);
    else if (ST.pillar === 'diff') mainContent = renderDiffPillar(d);
    else mainContent = renderPocketPillar(d);

    page.innerHTML = `
      <div class="ed-top">
        <div class="ed-banner">
          <div class="ed-banner-hd">
            <div class="ed-title-wrap">
              <h1 class="ed-title">Options and risk research</h1>
              <span class="ed-kick">Calculated research · Covered universe + My Book</span>
            </div>
            <span class="ed-stamp">Session ${esc(d.asof_session)} · ${d.rows.length} covered symbols · Source dates and model limits apply</span>
          </div>
          <p class="ed-sub">Explore modeled option income, company comparisons and portfolio scenarios using the dated inputs in (<b>Overview</b>, <b>Analyst Chart</b>, <b>28-Strategy Engine</b>, <b>Patterns</b>, and <b>5-Factor OLS</b>). AI is reserved strictly for optional natural-language Q&A in the bottom-right Ask dock.</p>
        </div>

        <div class="ed-pillars" role="tablist" aria-label="Edge Desk Modes">
          <button class="ed-pillar-btn" data-pillar="pocket" aria-pressed="${ST.pillar === 'pocket'}">
            <b>1. Options income</b>
            <span>Weekly calls, puts & strangles on your book</span>
          </button>
          <button class="ed-pillar-btn" data-pillar="alpha" aria-pressed="${ST.pillar === 'alpha'}">
            <b>2. Company comparisons</b>
            <span>20d OLS residuals, valuation & vol arb (covered stocks)</span>
          </button>
          <button class="ed-pillar-btn" data-pillar="stress" aria-pressed="${ST.pillar === 'stress'}">
            <b>3. Portfolio scenarios</b>
            <span>Factor shocks, weighted betas & option hedge sizer</span>
          </button>
          <button class="ed-pillar-btn" data-pillar="diff" aria-pressed="${ST.pillar === 'diff'}">
            <b>4. Methods and limits</b>
            <span>All 7 deterministic upgrades & formulas side-by-side</span>
          </button>
        </div>
      </div>
      ${mainContent}
    `;
  }

  function show(on) {
    document.body.classList.toggle('so-edge', on);
    if (page) page.hidden = !on;
    const tab = $('#ed-tab');
    if (tab) tab.classList.toggle('on', on);
    if (on) {
      pullFromMyBook(api.D());
      document.body.classList.remove('so-overview', 'so-flow', 'so-patterns', 'so-cycles');
      ['#pg-overview', '#pg-flow', '#pg-markets', '#pg-macro', '#pg-patterns', '#pg-cycles'].forEach(sel => {
        const el = $(sel);
        if (el) el.hidden = true;
      });
      document.querySelectorAll('#tabs [data-tab]').forEach(b => {
        if (b.id !== 'ed-tab') b.classList.remove('on');
      });
      render();
    }
  }

  function mount() {
    api = root.SO2;
    const d = api.D();
    ST = loadState(d);

    const tab = document.createElement('button');
    tab.id = 'ed-tab';
    tab.textContent = '★ Edge Desk';
    tab.dataset.tab = 'edge';
    tab.title = 'Lean interactive Options income + Alpha Finder + Portfolio scenarios Desk';
    $('#tabs').appendChild(tab);

    if (root.SmartOptionsLive) root.SmartOptionsLive.subscribe(() => {
      for (const h of ST.hold) { const q = root.SmartOptionsLive.get(h.t); if (!h.customPx && q && finite(q.price)) h.price = q.price; }
      if (!page.hidden) render();
    });
    const brand = $('#hdr .brand');
    if (brand) brand.innerHTML = 'SmartOptions <span style="color:var(--ed-brass);font-weight:700">Brief</span>';

    page = document.createElement('main');
    page.id = 'pg-edge';
    page.hidden = true;
    $('#pg-markets').before(page);

    $('#tabs').addEventListener('click', e => {
      const b = e.target.closest('[data-tab]');
      if (!b) return;
      if (b.dataset.tab === 'edge') {
        e.stopImmediatePropagation();
        show(true);
      } else {
        show(false);
      }
    }, true);

    page.addEventListener('click', e => {
      const pBtn = e.target.closest('[data-pillar]');
      if (pBtn) {
        ST.pillar = pBtn.dataset.pillar;
        openT = null;
        saveState();
        render();
        return;
      }
      const mBtn = e.target.closest('[data-ed-mode]');
      if (mBtn) {
        ST.mode = mBtn.dataset.edMode;
        openT = null;
        saveState();
        render();
        return;
      }
      const fBtn = e.target.closest('[data-fexp]');
      if (fBtn) {
        ST.fExp = +fBtn.dataset.fexp;
        saveState();
        render();
        return;
      }
      const pOpen = e.target.closest('[data-pocket-open]');
      if (pOpen) {
        openT = pOpen.dataset.pocketOpen;
        render();
        return;
      }
      const pStressOpen = e.target.closest('[data-pocket-open-from-stress]');
      if (pStressOpen) {
        ST.pillar = 'pocket';
        openT = pStressOpen.dataset.pocketOpenFromStress;
        saveState();
        render();
        return;
      }
      if (e.target.closest('[data-pocket-back]')) {
        openT = null;
        render();
        return;
      }
      const pickK = e.target.closest('[data-pick-k]');
      if (pickK && openT) {
        const fr = fridaysFrom(api.D().asof_session);
        const exp = fr[ST.fExp] || fr[0];
        ST.sel = ST.sel || {};
        ST.sel[selKey(openT, exp)] = +pickK.dataset.pickK;
        saveState();
        render();
        return;
      }
      const delBtn = e.target.closest('[data-hdel]');
      if (delBtn) {
        const idx = +delBtn.dataset.hdel;
        ST.hold.splice(idx, 1);
        saveState();
        syncToMyBook();
        render();
        return;
      }
      if (e.target.closest('#edAddBtn')) {
        const symIn = $('#edAddSym');
        const shIn = $('#edAddShares');
        const basIn = $('#edAddBasis');
        const sym = (symIn ? symIn.value : '').trim().toUpperCase();
        const sh = Math.max(100, parseInt(shIn ? shIn.value : '100', 10) || 100);
        const row = api.D().rows.find(r => r.t === sym);
        if (!row) return;
        const existing = ST.hold.find(h => h.t === sym);
        const basis = basIn && parseFloat(basIn.value) > 0 ? parseFloat(basIn.value) : row.px;
        if (existing) {
          existing.shares = sh;
          existing.basis = basis;
        } else {
          ST.hold.push({
            t: sym,
            shares: sh,
            basis,
            price: row.px,
            iv: finite(row.iv) ? row.iv : (finite(row.rv20) ? row.rv20 : 30),
            earn: row.er || ''
          });
        }
        saveState();
        syncToMyBook();
        render();
        return;
      }
      if (e.target.closest('#edResetBook')) {
        const retainedHold = ST.hold;
        ST = {...loadState(api.D()), pillar: 'pocket', mode: 'call', hold: retainedHold};
        saveState();
        syncToMyBook();
        render();
        return;
      }
      if (e.target.closest('#edOpenOverviewBook')) {
        show(false);
        if (root.SmartOptionsOverview) root.SmartOptionsOverview.show();
        return;
      }
      const addBook = e.target.closest('[data-add-to-book]');
      if (addBook) {
        const sym = addBook.dataset.addToBook;
        const row = api.D().rows.find(r => r.t === sym);
        if (row && !ST.hold.some(h => h.t === sym)) {
          ST.hold.push({
            t: sym,
            shares: 100,
            basis: row.px,
            price: row.px,
            iv: finite(row.iv) ? row.iv : (finite(row.rv20) ? row.rv20 : 30),
            earn: row.er || ''
          });
          saveState();
          syncToMyBook();
        }
        ST.pillar = 'pocket';
        openT = sym;
        render();
        return;
      }
      const aPreset = e.target.closest('[data-alpha-preset]');
      if (aPreset) {
        ST.alphaPreset = aPreset.dataset.alphaPreset;
        saveState();
        render();
        return;
      }
      const aHor = e.target.closest('[data-alpha-h]');
      if (aHor) {
        ST.alphaHorizon = aHor.dataset.alphaH;
        saveState();
        render();
        return;
      }
      const sPreset = e.target.closest('[data-shock-preset]');
      if (sPreset && api.S) {
        const p = sPreset.dataset.shockPreset;
        const sh = api.S().shock;
        FACTORS.forEach(f => { sh[f] = 0; });
        if (p === 'rates') sh.us10y_bps = 25;
        else if (p === 'riskoff') { sh.spy = -3; sh.vix = 5; }
        else if (p === 'oil') { sh.wti = 10; sh.us10y_bps = 15; }
        else if (p === 'rally') { sh.us10y_bps = -20; sh.vix = -3; }
        api.save();
        api.renderTable();
        render();
        return;
      }
      const openAnalyst = e.target.closest('[data-open-analyst]');
      if (openAnalyst) {
        const sym = openAnalyst.dataset.openAnalyst;
        show(false);
        api.showTab('markets');
        api.select('t', sym);
        return;
      }
      const openRatio = e.target.closest('[data-open-ratio]');
      if (openRatio) {
        const sym = openRatio.dataset.openRatio;
        show(false);
        api.showTab('markets');
        api.V.overlay = 'SPY';
        api.V.chartMode = 'ratio';
        api.select('t', sym);
        return;
      }
      const openStrat = e.target.closest('[data-open-strat]');
      if (openStrat) {
        const sym = openStrat.dataset.openStrat;
        show(false);
        if (root.SmartOptionsAPI && typeof root.SmartOptionsAPI.open_ticker_tab === 'function') {
          root.SmartOptionsAPI.open_ticker_tab(sym, 'strategies');
        } else {
          api.showTab('markets');
          api.select('t', sym);
        }
        return;
      }
      const swTab = e.target.closest('[data-switch-tab]');
      if (swTab) {
        const target = swTab.dataset.switchTab;
        show(false);
        const btn = $(`#tabs [data-tab="${target}"]`);
        if (btn) btn.click();
        else api.showTab(target);
      }
    });

    page.addEventListener('input', e => {
      const t = e.target;
      if (t.id === 'edGoal') {
        ST.lead = 'goal';
        ST.goal = +t.value;
        saveState();
        render();
        return;
      }
      if (t.id === 'edOdds') {
        ST.lead = 'odds';
        ST.oddsN = ODDS[+t.value] || 8;
        saveState();
        render();
        return;
      }
      if (t.dataset.shockF && api.S) {
        api.S().shock[t.dataset.shockF] = +t.value;
        api.save();
        api.renderTable();
        render();
        return;
      }
      if (t.dataset.hidx !== undefined) {
        const idx = +t.dataset.hidx;
        const k = t.dataset.hk;
        const h = ST.hold[idx];
        if (!h) return;
        if (k === 't') {
          const sym = t.value.trim().toUpperCase();
          const row = api.D().rows.find(r => r.t === sym);
          if (row) {
            h.t = sym;
            h.price = row.px;
            h.basis = row.px;
            h.iv = finite(row.iv) ? row.iv : (finite(row.rv20) ? row.rv20 : 30);
            h.earn = row.er || '';
            saveState();
            syncToMyBook();
            render();
          }
        } else if (k === 'shares') {
          h.shares = Math.max(0, parseInt(t.value, 10) || 0);
          saveState();
          syncToMyBook();
        } else if (k === 'basis') {
          h.basis = parseFloat(t.value) || h.price;
          saveState();
          syncToMyBook();
        }
      }
    });

    page.addEventListener('change', e => {
      const t = e.target;
      if (t.id === 'edExEarn') {
        ST.fEx = !!t.checked;
        saveState();
        render();
      } else if (t.id === 'edUse60') {
        ST.useTactical60 = !!t.checked;
        saveState();
        render();
      } else if (t.dataset.hidx !== undefined) {
        render();
      }
    });

    root.addEventListener('so:import', () => {
      pullFromMyBook(api.D());
      if (!page.hidden) render();
    });

    root.SmartOptionsEdgeDesk = {
      show: (pillar) => {
        if (pillar) ST.pillar = pillar;
        show(true);
      },
      hide: () => show(false),
      render,
      getState: () => ST
    };

    const initialHash = new URLSearchParams(location.hash.slice(1));
    if (initialHash.get('tab') === 'edge' || initialHash.get('edge') === '1') {
      show(true);
    }
  }

  let tries = 0;
  const timer = setInterval(() => {
    if (root.SO2_ready && root.SO2 && root.SO2.D && root.SO2.D()) {
      clearInterval(timer);
      mount();
    } else if (++tries > 300) {
      clearInterval(timer);
    }
  }, 20);
})(typeof window !== 'undefined' ? window : globalThis);
