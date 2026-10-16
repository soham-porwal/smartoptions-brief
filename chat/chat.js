/* SmartOptions V2 - analyst chatbot (lane C).
 * Bring-your-own-key: the Anthropic API key lives only in this browser's localStorage.
 * Every number in an answer must come from a tool result that carries a citation.
 * Network: only https://api.anthropic.com and same-origin data files (see safeFetch).
 * Works in the browser (window.SmartOptionsChat) and in node (module.exports) for tests.
 */
(function (root, factory) {
  const mod = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.SmartOptionsChat = mod;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  const API_URL = 'https://api.anthropic.com/v1/messages';
  const API_ORIGIN = 'https://api.anthropic.com';
  const MODELS = [
    {id: 'claude-sonnet-5-5', label: 'Sonnet 5.5'},
    {id: 'claude-opus-5-5', label: 'Opus 5.5'},
    {id: 'claude-haiku-5-5', label: 'Haiku 5.5'},
  ];
  const MAX_TOOL_ROUNDS = 6;
  const LS_KEY = 'smartoptions.chat.apiKey';
  const LS_MODEL = 'smartoptions.chat.model';
  let demoService = null;
  const FACTORS = ['spy', 'us10y_bps', 'dxy', 'wti', 'vix'];
  // scenario shock name -> relations factor key (units must match rel.units)
  const SHOCK_TO_FACTOR = {spy_pct: 'spy', us10y_bps: 'us10y_bps', dxy_pct: 'dxy', wti_pct: 'wti', vix_pts: 'vix'};
  const NOT_AVAILABLE = 'not available in this build';

  // ---------------------------------------------------------------- network guard
  function validateDemoConfig(value, now) {
    if (!value || value.enabled !== true) return null;
    let u;
    try { u = new URL(value.url); } catch (e) { return null; }
    const privateDemo = u.hostname === 'sohampc.tail9ff07b.ts.net' && u.port === '18891';
    if (u.protocol !== 'https:' || !privateDemo || u.username || u.password || u.pathname !== '/v1/messages' || u.search || u.hash) return null;
    const expires = Date.parse(value.expires_at);
    if (!Number.isFinite(expires) || expires <= (now == null ? Date.now() : now)) return null;
    if (!MODELS.some(m => m.id === value.model)) return null;
    return {url: u.href, expires_at: value.expires_at, model: value.model};
  }
  function activeDemo() { return validateDemoConfig(demoService && Object.assign({enabled: true}, demoService)); }
  function isAllowedUrl(url, origin, demo) {
    let u;
    try { u = new URL(url, origin || 'http://same.origin.invalid/'); } catch (e) { return false; }
    if (u.origin === API_ORIGIN) return u.pathname === '/v1/messages';
    if (demo && validateDemoConfig(Object.assign({enabled: true}, demo)) && u.href === demo.url) return true;
    const own = origin ? new URL(origin).origin : 'http://same.origin.invalid';
    return u.origin === own;
  }
  function pageOrigin() {
    try { return root.location && root.location.href ? root.location.href : undefined; } catch (e) { return undefined; }
  }
  // the ONLY place this module touches the network
  function safeFetch(url, opts) {
    if (!isAllowedUrl(url, pageOrigin(), activeDemo())) return Promise.reject(new Error('blocked request (only the configured demo relay, Anthropic and same-origin data are allowed)'));
    return root.fetch(url, opts);
  }

  // ---------------------------------------------------------------- data adapter
  // ONE place that knows the dashboard data shape (app/data/core.json, schema smartoptions-app/1).
  // If the export shape changes, fix it here; tools only see the adapted model below.
  function adapt(core, quotes) {
    if (!core || !Array.isArray(core.rows)) throw new Error('dashboard data not recognised (expected core.json with rows[])');
    const rel = core.rel || {};
    const tickers = {};
    for (const r of core.rows) {
      tickers[String(r.t).toUpperCase()] = {
        symbol: r.t, name: r.n, sector: r.sec, industry: r.ind, sets: r.sets || [],
        price: r.px, price_date: r.pxd, chg_1d_pct: r.d1, chg_5d_pct: r.d5, chg_1m_pct: r.m1,
        vol_ratio_20d: r.vr, range_52w: {low: r.lo, high: r.hi, pctile: r.pct},
        pe_trailing: r.pe, pe_forward: r.pef, peg: {value: r.peg, method: r.pegm},
        earnings: {date: r.er, time: r.ert, days_until_at_build: r.ern, source: r.ers},
        analyst: {rating: r.rating, target_mean: r.tgt, upside_pct: r.up, n: r.nan},
        beta_provider: r.beta, market_cap: r.mcap,
        atm_iv: r.iv == null ? null : {iv_pct: r.iv, expiry: r.ivx, strike: r.ivk, spans_earnings: r.ivspan, source: r.ivs},
        sam: r.sam || null,
        relations: r.rel ? {coef: r.rel.c, t: r.rel.t, r2: r.rel.r2, n: r.rel.n} : null,
        attribution: r.att || null,
        status: r.st || {},
      };
    }
    const macro = {};
    for (const [g, list] of Object.entries(core.macro || {})) {
      for (const o of list || []) {
        macro[o.id] = {
          id: o.id, group: o.g || g, label: o.label, provider: o.provider, series: o.series, url: o.url,
          unit: o.unit, value: o.v, prior: o.prior, period: o.period, date: o.date, status: o.status,
          note: o.note, transform: o.transform, retrieved_at: o.retrieved_at, history: o.h || [],
        };
      }
    }
    const q = quotes && quotes.quotes ? quotes : null;
    return {
      schema: core.schema, date: core.date, asof_session: core.asof_session, exported_at: core.exported_at,
      generated: core.gen || {}, universe_source: core.universe_source, meta: core.meta || {},
      movers: core.movers || {}, tickers, macro,
      groups: Object.keys(core.macro || {}),
      calendar: core.calendar || [], calendar_notes: core.calendar_notes || [],
      factors: rel.factors || FACTORS, units: rel.units || {}, rel_window: rel.window, rel_method: rel.method,
      sectors: rel.sectors || {}, trends: rel.trends || {}, regime: rel.regime || null,
      regime_hist: rel.regime_hist || [], vol_breadth: rel.vol_breadth || null, insights: rel.insights || [],
      signals: core.signals || [], methods: core.methods || {}, crosscheck: core.crosscheck || null,
      quotes: q ? q.quotes : {}, quotes_meta: q ? {generated_at: q.generated_at, session: q.session, source: q.source, method: q.method} : null,
      benchmark: (core.tape || []).find(o=>o.id==='SPY') || null,
    };
  }

  async function loadData(opts) {
    opts = opts || {};
    const api = root.SmartOptionsAPI;
    if (api && typeof api.getData === 'function') {
      const d = await api.getData();
      if (d && d.core) return adapt(d.core, d.quotes);
      return adapt(d, null);
    }
    const base = opts.dataBase || 'data/';
    const r = await safeFetch(base + 'core.json', {cache: 'no-store'});
    if (!r.ok) throw new Error('could not load ' + base + 'core.json (' + r.status + ')');
    const core = await r.json();
    let quotes = null;
    try { const rq = await safeFetch(base + 'quotes.json', {cache: 'no-store'}); if (rq.ok) quotes = await rq.json(); } catch (e) { quotes = null; }
    return adapt(core, quotes);
  }

  // ---------------------------------------------------------------- citations
  function CiteRegistry() { this.list = []; this.byKey = {}; this.evidence = {}; }
  CiteRegistry.prototype.add = function (c) {
    const e = {label: c.label || '', source: c.source || '', series: c.series == null ? null : String(c.series),
      as_of: c.as_of == null ? null : String(c.as_of), url: safeLink(c.url)};
    const key = [e.label, e.source, e.series, e.as_of, e.url].join('|');
    if (this.byKey[key]) return this.byKey[key];
    e.id = this.list.length + 1;
    this.list.push(e); this.byKey[key] = e;
    return e;
  };
  CiteRegistry.prototype.get = function (id) { return this.list[id - 1] || null; };
  // Evidence comes from completed data tools, never from the model's answer,
  // citation ids/labels or dashboard action metadata. Keep it separate from the
  // citation object so it is not sent back to the provider as duplicated data.
  CiteRegistry.prototype.bind = function (id, value) {
    const cite = this.get(id); if (!cite) return;
    const evidence = this.evidence[id] || (this.evidence[id] = {numbers: new Set(), dates: new Set()});
    const skip = new Set(['cite', 'cite_id', 'cite_map', 'id', 'label', 'source', 'provider', 'url', 'source_url', 'series', 'symbol', 'name', 'method', 'description', 'field_status']);
    function collect(v) {
      if (typeof v === 'number' && Number.isFinite(v)) evidence.numbers.add(v);
      else if (typeof v === 'string') {
        for (const f of figuresIn(v)) {
          if (/^\d{4}-\d{2}(?:-\d{2})?(?:T|$)/.test(f)) { evidence.dates.add(f); evidence.dates.add(f.slice(0, 10)); }
          else { const n = figureValue(f); if (n) evidence.numbers.add(n.value); }
        }
      } else if (Array.isArray(v)) v.forEach(collect);
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (!skip.has(k)) collect(x);
    }
    collect(value);
    for (const d of (cite.as_of || '').match(ISO_FIG_RE) || []) { evidence.dates.add(d); evidence.dates.add(d.slice(0, 10)); }
  };

  function bindToolEvidence(name, out, registry) {
    if (!registry || !out || out.error || name === 'ui_capabilities') return;
    if (name === 'get_ticker') {
      const groups = {
        price_and_returns: ['price', 'price_date', 'chg_1d_pct', 'chg_5d_pct', 'chg_1m_pct', 'vol_ratio_20d', 'range_52w'],
        fundamentals_analyst_earnings_iv: ['pe_trailing', 'pe_forward', 'peg', 'earnings', 'analyst', 'beta_provider', 'market_cap', 'atm_iv'],
        sam_snapshot: ['sam_snapshot'], relations: ['relations', 'attribution_last_session'], delayed_quote: ['delayed_quote'],
      };
      for (const [group, fields] of Object.entries(groups)) if (out.cite_map && out.cite_map[group]) registry.bind(out.cite_map[group], fields.map(k => out[k]));
    } else if (name === 'get_macro') {
      // Do not let one macro series supply a different series' cited figure.
      for (const row of out.observations || []) registry.bind(row.cite_id, [row, {series_count: out.series_count, as_of_session: out.as_of_session}]);
      for (const c of out.cite || []) if (!(out.observations || []).some(o => o.cite_id === c.id)) registry.bind(c.id, out.trend);
    } else {
      for (const c of out.cite || []) registry.bind(c.id, out);
      if (out.cite_id) registry.bind(out.cite_id, out);
    }
  }
  function safeLink(u) { return typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null; }

  const yahooUrl = s => 'https://finance.yahoo.com/quote/' + encodeURIComponent(s);
  function citePrice(m, t, ctx) {
    return ctx.cite({label: t.symbol + ' price, % changes, volume ratio, 52w range', source: 'Yahoo Finance via yfinance (end of session, delayed)',
      series: t.symbol, as_of: t.price_date || m.asof_session, url: yahooUrl(t.symbol)});
  }
  function citeFund(m, t, ctx) {
    return ctx.cite({label: t.symbol + ' P/E, PEG, analyst, earnings date, beta, market cap, ATM IV', source: 'Yahoo Finance via yfinance',
      series: t.symbol, as_of: m.generated.equities || m.exported_at, url: yahooUrl(t.symbol)});
  }
  function citeSam(m, t, ctx) {
    return ctx.cite({label: (t.sam && t.sam.label) || 'SmartOptions snapshot 2026-07-25', source: "Sam's SmartOptions screener snapshot (read-only)",
      series: t.symbol, as_of: t.sam && t.sam.asof, url: null});
  }
  function citeRel(m, sym, ctx) {
    return ctx.cite({label: (sym ? sym + ' ' : '') + 'macro sensitivities (OLS)', source: 'SmartOptions V2 relations: OLS of daily returns on SPY, d10Y bp, DXY, WTI, dVIX',
      series: sym || 'relations', as_of: m.rel_window, url: null});
  }
  function citeObs(o, ctx) {
    return ctx.cite({label: o.label, source: o.provider, series: o.series, as_of: o.period, url: o.url});
  }

  // ---------------------------------------------------------------- helpers
  const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
  const round = (v, d) => v == null ? null : Math.round(v * Math.pow(10, d)) / Math.pow(10, d);
  function etToday(now) {
    const d = now || new Date();
    try {
      return new Intl.DateTimeFormat('en-CA', {timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'}).format(d);
    } catch (e) { return d.toISOString().slice(0, 10); }
  }
  function daysBetween(fromYmd, toYmd) {
    if (!fromYmd || !toYmd) return null;
    const a = Date.parse(fromYmd.slice(0, 10) + 'T00:00:00Z'), b = Date.parse(toYmd.slice(0, 10) + 'T00:00:00Z');
    if (isNaN(a) || isNaN(b)) return null;
    return Math.round((b - a) / 86400000);
  }
  function earningsDays(t, ctx) { return t.earnings && t.earnings.date ? daysBetween(etToday(ctx.now), t.earnings.date) : null; }
  function findTicker(m, symbol) { return symbol ? m.tickers[String(symbol).trim().toUpperCase()] || null : null; }
  function lc(s) { return String(s == null ? '' : s).toLowerCase(); }

  // ---------------------------------------------------------------- DATA tools
  function get_ticker(m, args, ctx) {
    const t = findTicker(m, args.symbol);
    if (!t && String(args.symbol).toUpperCase()==='SPY' && m.benchmark) {
      const b=m.benchmark, c=ctx.cite({label:'SPY stored market benchmark',source:b.src || 'Yahoo Finance via yfinance (delayed)',series:'SPY',as_of:m.asof_session,url:yahooUrl('SPY')});
      return {symbol:'SPY',benchmark:true,price:b.v,price_date:m.asof_session,chg_1d_pct:b.chg,pe_forward:null,
        note:'Stored benchmark price and return only. Future price forecasts and company fundamentals are not in this tool.',cite:[c],cite_id:c.id};
    }
    if (!t) return {error: 'not in the data: ' + args.symbol + ' has no company fundamentals row in this dashboard.'};
    const cp = citePrice(m, t, ctx), cf = citeFund(m, t, ctx);
    const out = {
      symbol: t.symbol, name: t.name, sector: t.sector, industry: t.industry,
      sets: t.sets, set_meaning: m.meta.sets || null,
      price: t.price, price_date: t.price_date, chg_1d_pct: t.chg_1d_pct, chg_5d_pct: t.chg_5d_pct, chg_1m_pct: t.chg_1m_pct,
      vol_ratio_20d: t.vol_ratio_20d, range_52w: Object.assign({window_weeks:52},t.range_52w),
      pe_trailing: t.pe_trailing, pe_forward: t.pe_forward, peg: t.peg,
      earnings: Object.assign({}, t.earnings, {days_until_today: earningsDays(t, ctx)}),
      analyst: t.analyst, beta_provider: t.beta_provider, market_cap: t.market_cap, atm_iv: t.atm_iv,
      field_status: t.status, price_note: m.meta.price_note || null,
      cite_map: {price_and_returns: cp.id, fundamentals_analyst_earnings_iv: cf.id},
    };
    const cites = [cp, cf];
    if (t.sam) { const cs = citeSam(m, t, ctx); out.sam_snapshot = t.sam; out.cite_map.sam_snapshot = cs.id; cites.push(cs); }
    else out.sam_snapshot = 'not in the data (ticker not in Sam\'s 2026-07-25 snapshot)';
    if (t.relations) {
      const cr = citeRel(m, t.symbol, ctx);
      out.relations = Object.assign({}, t.relations, {units: m.units, window: m.rel_window});
      out.attribution_last_session = t.attribution;
      out.cite_map.relations = cr.id; cites.push(cr);
    } else out.relations = 'not in the data';
    const q = m.quotes[t.symbol];
    if (q && q.status === 'ok') {
      const cq = ctx.cite({label: t.symbol + ' delayed quote', source: q.provider, series: q.series || t.symbol, as_of: q.ts, url: q.source_url});
      out.delayed_quote = {price: q.price, chg_pct: round(num(q.chg_pct), 3), ts: q.ts, prior_close: q.prior_close, prior_close_date: q.prior_close_date, method: q.method, change_status: q.change_status};
      out.cite_map.delayed_quote = cq.id; cites.push(cq);
    }
    out.cite = cites;
    return out;
  }

  const SORTS = {
    chg_1d: t => t.chg_1d_pct, chg_5d: t => t.chg_5d_pct, chg_1m: t => t.chg_1m_pct, vol_ratio: t => t.vol_ratio_20d,
    pe_fwd: t => t.pe_forward, pe: t => t.pe_trailing, peg: t => t.peg.value, iv: t => t.atm_iv && t.atm_iv.iv_pct,
    sam_opp: t => t.sam && t.sam.opp, sam_trend: t => t.sam && t.sam.trend, upside: t => t.analyst.upside_pct,
    mcap: t => t.market_cap, beta: t => t.beta_provider, range_pctile: t => t.range_52w.pctile,
  };

  function screen(m, args, ctx) {
    const f = args.filters || {};
    const notes = [];
    let rows = Object.values(m.tickers);
    const excluded = {};
    const need = (name, pred) => {
      const before = rows.length;
      rows = rows.filter(pred);
      if (before !== rows.length) excluded[name] = before - rows.length;
    };
    if (f.symbols && f.symbols.length) { const s = new Set(f.symbols.map(x => String(x).toUpperCase())); need('symbols', t => s.has(t.symbol.toUpperCase())); }
    if (f.sector) need('sector', t => lc(t.sector).includes(lc(f.sector)) || lc(t.industry).includes(lc(f.sector)));
    if (f.sets && f.sets.length) need('sets', t => f.sets.some(s => t.sets.includes(String(s).toUpperCase())));
    if (f.max_pe_fwd != null) need('max_pe_fwd (missing forward P/E also excluded)', t => num(t.pe_forward) != null && t.pe_forward <= f.max_pe_fwd);
    if (f.max_peg != null) need('max_peg (missing PEG also excluded)', t => num(t.peg.value) != null && t.peg.value <= f.max_peg);
    if (f.min_iv != null) need('min_iv (missing ATM IV also excluded)', t => t.atm_iv && num(t.atm_iv.iv_pct) != null && t.atm_iv.iv_pct >= f.min_iv);
    if (f.earnings_within_days != null) need('earnings_within_days (unknown date excluded)', t => { const d = earningsDays(t, ctx); return d != null && d >= 0 && d <= f.earnings_within_days; });
    if (f.min_days_to_earnings != null) need('min_days_to_earnings (unknown date excluded)', t => { const d = earningsDays(t, ctx); return d != null && d >= f.min_days_to_earnings; });
    if (f.min_sam_opp != null) need('min_sam_opp (not in Sam snapshot excluded)', t => t.sam && num(t.sam.opp) != null && t.sam.opp >= f.min_sam_opp);
    if (f.sam_risk && f.sam_risk.length) need('sam_risk', t => t.sam && f.sam_risk.map(lc).includes(lc(t.sam.risk)));
    if (f.sam_quality && f.sam_quality.length) need('sam_quality', t => t.sam && f.sam_quality.map(lc).includes(lc(t.sam.q)));
    if (f.min_upside != null) need('min_upside (missing target excluded)', t => num(t.analyst.upside_pct) != null && t.analyst.upside_pct >= f.min_upside);
    if (f.min_chg_1d != null) need('min_chg_1d', t => num(t.chg_1d_pct) != null && t.chg_1d_pct >= f.min_chg_1d);
    if (f.max_chg_1d != null) need('max_chg_1d', t => num(t.chg_1d_pct) != null && t.chg_1d_pct <= f.max_chg_1d);
    const fac = f.significant_factor;
    if (fac) {
      if (!FACTORS.includes(fac)) return {error: 'unknown factor ' + fac + '; use one of ' + FACTORS.join(', ')};
      const minT = f.min_abs_t != null ? f.min_abs_t : 2;
      notes.push('significant_factor ' + fac + ' with |t| >= ' + minT + (f.min_abs_t == null ? ' (default)' : ''));
      need('significant_factor', t => t.relations && num(t.relations.t[fac]) != null && Math.abs(t.relations.t[fac]) >= minT);
      if (f.factor_sign === 'negative') need('factor_sign', t => t.relations.coef[fac] < 0);
      if (f.factor_sign === 'positive') need('factor_sign', t => t.relations.coef[fac] > 0);
    }
    // sort
    let sortKey = args.sort || (fac ? 'abs_t' : 'chg_1d'), desc = true;
    if (typeof sortKey === 'string' && sortKey[0] === '-') { sortKey = sortKey.slice(1); desc = true; }
    else if (typeof sortKey === 'string' && sortKey[0] === '+') { sortKey = sortKey.slice(1); desc = false; }
    if (args.sort_dir === 'asc') desc = false; if (args.sort_dir === 'desc') desc = true;
    let keyFn = SORTS[sortKey];
    if (sortKey === 'abs_t' && fac) keyFn = t => t.relations ? Math.abs(t.relations.t[fac]) : null;
    else if (sortKey === 'days_to_earnings') keyFn = t => earningsDays(t, ctx);
    if (!keyFn) return {error: 'unknown sort ' + sortKey + '; use one of ' + Object.keys(SORTS).concat(['days_to_earnings', 'abs_t']).join(', ')};
    rows.sort((a, b) => {
      const x = num(keyFn(a)), y = num(keyFn(b));
      if (x == null && y == null) return a.symbol.localeCompare(b.symbol);
      if (x == null) return 1; if (y == null) return -1;
      return desc ? y - x : x - y;
    });
    const total = rows.length;
    const limit = Math.max(1, Math.min(50, args.limit || 15));
    const out = rows.slice(0, limit).map(t => {
      const r = {symbol: t.symbol, name: t.name, sector: t.sector, sets: t.sets.join('+'), price: t.price, chg_1d_pct: round(num(t.chg_1d_pct), 2),
        pe_fwd: t.pe_forward, peg: t.peg.value, atm_iv_pct: t.atm_iv ? t.atm_iv.iv_pct : null,
        earnings: t.earnings.date, days_to_earnings: earningsDays(t, ctx), upside_pct: t.analyst.upside_pct,
        sam_opp: t.sam ? t.sam.opp : null, sam_quality: t.sam ? t.sam.q : null, sam_risk: t.sam ? t.sam.risk : null, sam_flags: t.sam ? t.sam.flags : null};
      if (fac && t.relations) { r.coef = t.relations.coef[fac]; r.t = t.relations.t[fac]; }
      return r;
    });
    const cites = [ctx.cite({label: 'Screen over dashboard tickers: price, valuation, analyst, earnings, ATM IV', source: 'Yahoo Finance via yfinance',
      series: 'all tickers', as_of: m.asof_session, url: 'https://finance.yahoo.com/'})];
    if (f.min_sam_opp != null || f.sam_risk || f.sam_quality || sortKey.startsWith('sam')) cites.push(ctx.cite({label: 'SmartOptions snapshot 2026-07-25', source: "Sam's SmartOptions screener snapshot (read-only)", series: 'all tickers', as_of: '2026-07-25', url: null}));
    if (fac) cites.push(citeRel(m, null, ctx));
    return {matched: total, shown: out.length, sort: (desc ? '-' : '+') + sortKey, filters: f, excluded_by_filter: excluded, notes,
      days_reference: 'days_to_earnings counted from ' + etToday(ctx.now) + ' (ET)', factor_units: fac ? m.units[fac] : undefined,
      rows: out, cite: cites};
  }

  function obsOut(o, histN) {
    const h = o.history || [];
    const chg = num(o.value) != null && num(o.prior) != null ? round(o.value - o.prior, 4) : null;
    return {id: o.id, group: o.group, label: o.label, value: o.value, unit: o.unit, period: o.period, observation_date: o.date,
      prior: o.prior, change_vs_prior: chg, transform: o.transform, status: o.status, note: o.note,
      provider: o.provider, series: o.series, retrieved_at: o.retrieved_at, history_tail: histN ? h.slice(-histN) : undefined};
  }
  function get_macro(m, args, ctx) {
    const q = lc(args.series_or_group || 'summary').trim();
    const all = Object.values(m.macro);
    const histN = Math.max(0, Math.min(60, args.history_points == null ? 13 : args.history_points));
    let picked, groupInfo = null;
    if (q === 'summary' || q === 'all' || q === 'latest' || q === 'changes') {
      // compact rows (provider/series/url live in the cite entry) so the whole summary fits one tool result
      picked = all;
      const cites = picked.map(o => citeObs(o, ctx));
      const res = picked.map((o, i) => { const r = obsOut(o, 0);
        return {id: r.id, group: r.group, label: r.label, value: r.value, unit: r.unit, period: r.period, prior: r.prior,
          change_vs_prior: r.change_vs_prior, status: r.status, note: r.note || undefined, cite_id: cites[i].id}; });
      return {series_count: res.length, as_of_session: m.asof_session, note: 'change_vs_prior = value minus prior observation of the same transform; monthly/quarterly values are not new today unless observation period is the latest release', trends: m.trends, observations: res, cite: dedupe(cites)};
    }
    if (m.groups.map(lc).includes(q)) { picked = all.filter(o => lc(o.group) === q); groupInfo = m.trends[q] || null; }
    else picked = all.filter(o => lc(o.id) === q || lc(o.series) === q);
    if (!picked.length) picked = all.filter(o => lc(o.label).includes(q) || lc(o.id).includes(q));
    if (!picked.length) return {error: 'not in the data: no macro series or group matches "' + args.series_or_group + '". Groups: ' + m.groups.join(', ') + '. Series ids: ' + Object.keys(m.macro).join(', ')};
    picked = picked.slice(0, 20);
    const cites = picked.map(o => citeObs(o, ctx));
    const res = picked.map((o, i) => Object.assign(obsOut(o, histN), {cite_id: cites[i].id}));
    const out = {observations: res, cite: dedupe(cites)};
    if (groupInfo) { out.trend = groupInfo; out.trend_method = 'direction over last 3 periods (relations.json trend_label); descriptive, no thresholds'; out.cite.push(citeRel(m, null, ctx)); }
    return out;
  }
  function dedupe(cites) { const s = new Set(); return cites.filter(c => !s.has(c.id) && s.add(c.id)); }

  function get_relations(m, args, ctx) {
    const sym = String(args.symbol || '').trim();
    const sec = Object.keys(m.sectors).find(s => lc(s) === lc(sym));
    if (sec) {
      const c = citeRel(m, null, ctx);
      return {sector: sec, n: m.sectors[sec].n, median_coef: m.sectors[sec].median_coef, units: m.units, window: m.rel_window, cite_id: c.id, cite: [c]};
    }
    const t = findTicker(m, sym);
    if (!t) return {error: 'not in the data: ' + sym};
    if (!t.relations) return {symbol: t.symbol, relations: 'not in the data (no regression for this ticker)', cite: []};
    const c = citeRel(m, t.symbol, ctx);
    const sig = FACTORS.filter(f => num(t.relations.t[f]) != null && Math.abs(t.relations.t[f]) >= 2);
    const sm = m.sectors[t.sector];
    return {symbol: t.symbol, sector: t.sector, coef: t.relations.coef, t_stat: t.relations.t, r2: t.relations.r2, n: t.relations.n,
      units: m.units, window: m.rel_window, significant_at_abs_t_2: sig,
      sector_median_coef: sm ? sm.median_coef : null, attribution_last_session: t.attribution,
      method: 'OLS with intercept; association, not causation. Attribution = sum(coef x that session factor move); remainder stock-specific.',
      cite_id: c.id, cite: [c]};
  }

  function get_calendar(m, args, ctx) {
    const days = Math.max(1, Math.min(60, args.days == null ? 7 : args.days));
    const now = (ctx.now || new Date()).getTime();
    const ev = m.calendar.map(e => ({e, ts: Date.parse(e.scheduled_et)})).filter(x => !isNaN(x.ts))
      .filter(x => x.ts >= now - 7 * 86400000 && x.ts <= now + days * 86400000).sort((a, b) => a.ts - b.ts);
    const cites = [];
    const events = ev.map(({e, ts}) => {
      const c = ctx.cite({label: e.title + ' release calendar', source: (e.note && /FRED/.test(e.note)) ? 'FRED release calendar' : 'official release calendar', series: e.type, as_of: m.generated.macro || m.exported_at, url: e.source_url});
      cites.push(c);
      return {type: e.type, title: e.title, scheduled_et: e.scheduled_et, status: ts < now ? 'released/past' : e.status, days_from_now: round((ts - now) / 86400000, 1), note: e.note, cite_id: c.id};
    });
    const today = etToday(ctx.now);
    const earn = Object.values(m.tickers).map(t => ({t, d: earningsDays(t, ctx)})).filter(x => x.d != null && x.d >= 0 && x.d <= days)
      .sort((a, b) => a.d - b.d).slice(0, 40)
      .map(({t, d}) => ({symbol: t.symbol, date: t.earnings.date, time: t.earnings.time, days: d, atm_iv_pct: t.atm_iv ? t.atm_iv.iv_pct : null, sets: t.sets.join('+')}));
    if (earn.length) cites.push(ctx.cite({label: 'Earnings dates (dashboard tickers)', source: 'Yahoo Finance via yfinance (get_earnings_dates)', series: 'earnings', as_of: m.generated.equities || m.exported_at, url: 'https://finance.yahoo.com/calendar/earnings'}));
    return {window: 'last 7 days through next ' + days + ' days, from ' + today + ' (ET)', events, earnings: earn,
      consensus: 'unavailable (no licensed consensus source)', calendar_notes: m.calendar_notes, cite: dedupe(cites)};
  }

  function get_regime(m, args, ctx) {
    if (!m.regime) return {error: 'not in the data: regime'};
    const cites = [ctx.cite({label: 'Market regime score (Sam\'s market_regime.py method, recomputed)', source: 'SmartOptions V2 relations (VIX, A/D, new highs/lows)', series: 'regime', as_of: m.asof_session, url: null})];
    const vb = m.vol_breadth;
    let vol = null;
    if (vb) {
      cites.push(ctx.cite({label: 'Options-seller context: VRP, VIX/VIX3M, RSP-SPY breadth', source: 'SmartOptions V2 (Cboe VIX, Yahoo SPY/RSP)', series: 'vol_breadth', as_of: m.asof_session, url: null}));
      const pick = k => vb[k] ? {value: vb[k].value, unit: vb[k].unit, last_5: (vb[k].history || []).slice(-5)} : null;
      vol = {vrp: pick('vrp'), term_ratio_vix_vix3m: pick('term_ratio'), breadth_rsp_minus_spy_20d: pick('breadth_rsp_spy_20d'), method: vb.method,
        interpretation_reference:{term_ratio_parity:1,vrp_parity:0,note:'Term ratio = VIX / VIX3M; above parity is backwardation. VRP = implied minus realized volatility; zero is parity.'}};
    }
    cites.push(citeRel(m, null, ctx));
    return {score: m.regime.score, tier: m.regime.tier, components: m.regime.components, method: m.regime.method, history_note: m.regime.history_note,
      history_last_10: m.regime_hist.slice(-10), vol_breadth: vol, macro_trends: m.trends, cite: cites};
  }

  function get_insights(m, args, ctx) {
    const c = citeRel(m, null, ctx);
    const ins = m.insights.map(i => ({id: i.id, title: i.title, observation: i.observation, why: i.why, watch: i.watch, confidence: i.confidence,
      evidence: (i.evidence || []).map(e => { const ce = ctx.cite({label: e.label, source: 'dashboard insight evidence', series: e.label, as_of: e.period, url: e.source_url}); return Object.assign({}, e, {cite_id: ce.id}); }),
      exposed: (i.exposed || []).slice(0, 8)}));
    const sig = m.signals.slice(0, args.max_signals || 25).map(s => ({kind: s.kind, text: s.text, ticker: s.t || null}));
    return {insights: ins, signals: sig, signals_method: m.methods.signals || null, relations_cite_id: c.id,
      cite: dedupe([c].concat(...ins.map(i => i.evidence.map(e => ctx.registry.get(e.cite_id)))))};
  }

  function scenario(m, args, ctx) {
    const shocks = args.shocks || {};
    const used = {};
    for (const [k, v] of Object.entries(shocks)) {
      const f = SHOCK_TO_FACTOR[k] || (FACTORS.includes(k) ? k : null);
      if (!f) return {error: 'unknown shock ' + k + '; use ' + Object.keys(SHOCK_TO_FACTOR).join(', ')};
      if (num(v) == null) return {error: 'shock ' + k + ' must be a number'};
      used[f] = v;
    }
    if (!Object.keys(used).length) return {error: 'no shocks given'};
    const res = [], skipped = [];
    for (const t of Object.values(m.tickers)) {
      if (!t.relations) { skipped.push(t.symbol); continue; }
      let s = 0, ok = true; const parts = {}; let sig = 0;
      for (const [f, v] of Object.entries(used)) {
        const c = num(t.relations.coef[f]);
        if (c == null) { ok = false; break; }
        parts[f] = round(c * v, 3); s += c * v;
        if (Math.abs(num(t.relations.t[f]) || 0) >= 2) sig++;
      }
      if (!ok) { skipped.push(t.symbol); continue; }
      res.push({symbol: t.symbol, sector: t.sector, impact_pct: round(s, 3), by_factor: parts, factors_with_abs_t_ge_2: sig});
    }
    res.sort((a, b) => a.impact_pct - b.impact_pct);
    const n = Math.max(1, Math.min(30, args.top_n || 10));
    const sectors = Object.entries(m.sectors).map(([sec, v]) => {
      let s = 0; for (const [f, x] of Object.entries(used)) s += (num(v.median_coef[f]) || 0) * x;
      return {sector: sec, impact_pct_from_median_coefs: round(s, 3)};
    }).sort((a, b) => a.impact_pct_from_median_coefs - b.impact_pct_from_median_coefs);
    const cites = [citeRel(m, null, ctx), ctx.cite({label: 'Scenario shock as specified by the user: ' + JSON.stringify(shocks), source: 'user input', series: 'scenario', as_of: null, url: null})];
    let ui = null;
    if (args.apply_to_dashboard) ui = callUi(ctx, 'set_scenario', [shocks]);
    return {shocks_used: used, units: m.units, method: m.methods.scenario || 'impact % = sum(coef x shock)', tickers_scored: res.length,
      tickers_skipped_no_coef: skipped.length, most_hurt: res.slice(0, n), most_helped: res.slice(-n).reverse(),
      sector_view: sectors, caveat: 'historical association over ' + m.rel_window + ', not a forecast', ui_result: ui || undefined, cite: cites};
  }

  // ---------------------------------------------------------------- UI action tools
  function callUi(ctx, fn, argv) {
    const api = ctx.api;
    if (!api || typeof api[fn] !== 'function') return {ok: false, result: NOT_AVAILABLE};
    try {
      const r = api[fn].apply(api, argv);
      return Promise.resolve(r).then(v => ({ok: true, result: v === undefined ? 'done' : v}), e => ({ok: false, error: String(e && e.message || e)}));
    } catch (e) { return {ok: false, error: String(e && e.message || e)}; }
  }
  const UI_TOOLS = {
    select: a => ['select', [a.symbol]],
    set_filters: a => ['set_filters', [a.filters || {}]],
    set_scenario: a => ['set_scenario', [a.shocks || {}]],
    show_panels: a => ['show_panels', [a.panels || []]],
    hide_panels: a => ['hide_panels', [a.panels || []]],
    set_columns: a => ['set_columns', [a.columns || []]],
    apply_preset: a => ['apply_preset', [a.id]],
    save_workspace: a => ['save_workspace', [a.name]],
    load_workspace: a => ['load_workspace', [a.name]],
    list_workspaces: () => ['list_workspaces', []],
    set_chart: a => ['set_chart', [a.symbol, a.overlay || null, a.range || null]],
    open_ticker_tab: a => ['open_ticker_tab', [a.symbol, a.tab]],
    explore: a => ['explore', [a.symbol, a.view || 'peers']],
  };
  function ui_capabilities(m, args, ctx) {
    const api = ctx.api;
    if (!api) return {available: false, result: NOT_AVAILABLE};
    const fns = Object.keys(UI_TOOLS).concat(['get_technicals', 'recommend_strategy', 'strategy_library', 'confidence_explain']).filter(k => typeof api[k] === 'function');
    let desc = null;
    try { desc = typeof api.describe === 'function' ? api.describe() : null; } catch (e) { desc = {error: String(e)}; }
    return {available: true, functions: fns, describe: desc};
  }

  async function apiData(name, argv, m, ctx) {
    const out = await callUi(ctx, name, argv);
    if (!out.ok) return out;
    if (out.result && out.result.error) return {error: out.result.error};
    const result = out.result;
    const cite = ctx.cite({label: name + (argv[0] ? ' · ' + argv[0] : '') + ' · stored dashboard inputs; model outputs are educational estimates',
      source: 'SmartOptions dashboard ' + name, series: name,
      as_of: result && result.asof || m.asof_session, url: null});
    return {data: result, cite: [cite], method: name === 'recommend_strategy' ? 'Sum of documented strategy rule points; payoffs are model estimates, not market quotes.' : 'Dashboard API result; retain its method, inputs and provenance.'};
  }
  const DATA_TOOLS = {get_ticker, screen, get_macro, get_relations, get_calendar, get_regime, get_insights, scenario, ui_capabilities,
    get_technicals: (m,a,c) => apiData('get_technicals',[a.symbol],m,c),
    recommend_strategy: (m,a,c) => apiData('recommend_strategy',[a.symbol,a.options || {}],m,c),
    strategy_library: (m,a,c) => apiData('strategy_library',[],m,c),
    get_confidence: (m,a,c) => apiData('confidence_explain',[a.symbol],m,c)};

  async function runTool(name, input, model, ctx) {
    try {
      if (DATA_TOOLS[name]) {
        const out = await DATA_TOOLS[name](model, input || {}, ctx);
        bindToolEvidence(name, out, ctx.registry);
        return out;
      }
      if (UI_TOOLS[name]) {
        const [fn, argv] = UI_TOOLS[name](input || {});
        return await callUi(ctx, fn, argv);
      }
      return {error: 'unknown tool ' + name};
    } catch (e) {
      return {error: 'tool ' + name + ' failed: ' + String(e && e.message || e)};
    }
  }

  // ---------------------------------------------------------------- tool schemas (Anthropic format)
  const S = (props, req) => ({type: 'object', properties: props, required: req || []});
  const factorEnum = {type: 'string', enum: FACTORS};
  const shockSchema = S({us10y_bps: {type: 'number', description: '10Y yield change in basis points'}, wti_pct: {type: 'number', description: 'WTI % change'},
    dxy_pct: {type: 'number', description: 'DXY % change'}, vix_pts: {type: 'number', description: 'VIX change in points'}, spy_pct: {type: 'number', description: 'SPY % change'}});
  const TOOL_SCHEMAS = [
    {name: 'get_technicals', description: 'Stored technical indicators, trend regime, methods, inputs and as-of for a ticker. Missing stays missing.', input_schema: S({symbol:{type:'string'}},['symbol'])},
    {name: 'recommend_strategy', description: 'Rank conditional educational strategy fits for a ticker from documented scoring rules; returns inputs, provenance and model estimates, never market quotes or orders.', input_schema: S({symbol:{type:'string'}, options:S({stance:{type:'string',enum:['bullish','neutral','bearish']},horizon_days:{type:'integer',minimum:1,maximum:365},risk_tolerance:{type:'string',enum:['low','medium','high']},top:{type:'integer',minimum:5,maximum:8}})},['symbol'])},
    {name: 'strategy_library', description: 'Educational strategy library: view, fit, risks, payoff formulas and assignment caveats.', input_schema:S({})},
    {name: 'get_confidence', description: 'Explain a ticker evidence-support score, every component, weight, rule and dated input. This heuristic score measures signal agreement and data quality, NOT a calibrated probability of profit or forecast accuracy.', input_schema:S({symbol:{type:'string'}},['symbol'])},
    {name: 'open_ticker_tab', description: 'UI: show a ticker Overview, Technicals or Strategies tab. Use when asked to show strategies for a ticker.', input_schema:S({symbol:{type:'string'},tab:{type:'string',enum:['overview','technicals','strategies']}},['symbol','tab'])},
    {name: 'get_ticker', description: 'All dashboard fields for one ticker with provenance: price/returns, valuation, analyst, earnings date, ATM IV, Sam snapshot scores, macro sensitivities, last-session attribution, delayed quote. Use cite_map ids.',
      input_schema: S({symbol: {type: 'string'}}, ['symbol'])},
    {name: 'screen', description: 'Filter and sort dashboard tickers. Rows with a missing value are excluded by any filter on that value (counts reported). Earnings days are counted from today ET.',
      input_schema: S({filters: S({sector: {type: 'string', description: 'GICS sector or industry substring'}, max_pe_fwd: {type: 'number'}, max_peg: {type: 'number'},
        min_iv: {type: 'number', description: 'min ATM implied vol, percent'}, earnings_within_days: {type: 'integer'}, min_days_to_earnings: {type: 'integer', description: 'earnings at least N days away'},
        min_sam_opp: {type: 'number', description: "Sam's Opportunity score (2026-07-25 snapshot)"}, sam_risk: {type: 'array', items: {type: 'string'}}, sam_quality: {type: 'array', items: {type: 'string'}},
        sets: {type: 'array', items: {type: 'string', enum: ['A', 'B']}, description: 'A = top movers, B = Sam universe'},
        significant_factor: factorEnum, min_abs_t: {type: 'number', description: 'default 2'}, factor_sign: {type: 'string', enum: ['positive', 'negative']},
        min_upside: {type: 'number'}, min_chg_1d: {type: 'number'}, max_chg_1d: {type: 'number'}, symbols: {type: 'array', items: {type: 'string'}}}),
      sort: {type: 'string', description: 'field, prefix "-" desc (default) or "+" asc: ' + Object.keys(SORTS).join(', ') + ', days_to_earnings, abs_t'},
      limit: {type: 'integer', description: 'max 50, default 15'}})},
    {name: 'get_macro', description: 'Macro observations with period, source, as-of. Argument: a group (inflation, labor, growth, policy, curve, cross_asset, credit_funding, volatility), a series id (e.g. cpi_core, us10y, hy_oas, vix), a provider series code, or "summary" for every latest value + change vs prior + group trends.',
      input_schema: S({series_or_group: {type: 'string'}, history_points: {type: 'integer', description: 'history tail length, default 13, max 60'}}, ['series_or_group'])},
    {name: 'get_relations', description: 'Macro factor sensitivities for a ticker (OLS coefficients, t-stats, R2, n, sector medians, last-session move attribution), or pass a sector name for sector median coefficients.',
      input_schema: S({symbol: {type: 'string'}}, ['symbol'])},
    {name: 'get_calendar', description: 'Scheduled macro releases (FOMC, CPI, PPI, PCE, NFP, GDP...) from the last 7 days through the next N days, plus dashboard earnings dates in the window.',
      input_schema: S({days: {type: 'integer', description: 'default 7, max 60'}})},
    {name: 'get_regime', description: 'Market regime score/tier with components, recent history, options-seller context (VRP, VIX/VIX3M, breadth) and macro group trend labels.', input_schema: S({})},
    {name: 'get_insights', description: "The dashboard's relational insight cards (observation, why it matters, what to watch, most-exposed tickers) and signal lines.", input_schema: S({max_signals: {type: 'integer'}})},
    {name: 'scenario', description: 'What-if: impact % per ticker = sum(coefficient x shock) over the given factors; returns most hurt / most helped and a sector view. Historical association, not a forecast.',
      input_schema: S({shocks: shockSchema, top_n: {type: 'integer', description: 'default 10'}, apply_to_dashboard: {type: 'boolean', description: 'also push this scenario into the dashboard scenario panel'}}, ['shocks'])},
    {name: 'ui_capabilities', description: 'Which dashboard UI actions exist in this build, plus available panels/columns/presets.', input_schema: S({})},
    {name: 'select', description: 'UI: open a ticker in the main Analyst view. The visible Analyst view is also called markets internally; use select for requests to open Analyst on a company.', input_schema: S({symbol: {type: 'string'}}, ['symbol'])},
    {name: 'set_filters', description: 'UI: set the dashboard table filters (same keys as screen.filters).', input_schema: S({filters: {type: 'object'}}, ['filters'])},
    {name: 'set_scenario', description: 'UI: set the dashboard scenario panel shocks.', input_schema: S({shocks: shockSchema}, ['shocks'])},
    {name: 'show_panels', description: 'UI: show dashboard panels by id.', input_schema: S({panels: {type: 'array', items: {type: 'string'}}}, ['panels'])},
    {name: 'hide_panels', description: 'UI: hide dashboard panels by id.', input_schema: S({panels: {type: 'array', items: {type: 'string'}}}, ['panels'])},
    {name: 'set_columns', description: 'UI: set visible table columns by id, in order.', input_schema: S({columns: {type: 'array', items: {type: 'string'}}}, ['columns'])},
    {name: 'apply_preset', description: 'UI: apply a saved layout preset by id.', input_schema: S({id: {type: 'string'}}, ['id'])},
    {name: 'save_workspace', description: 'UI: save the current customized dashboard layout with the user-provided name.', input_schema: S({name: {type:'string'}}, ['name'])},
    {name: 'load_workspace', description: 'UI: load a named saved workspace; list available workspaces first.', input_schema: S({name: {type:'string'}}, ['name'])},
    {name: 'list_workspaces', description: 'UI: list available saved workspace names.', input_schema: S({})},
    {name: 'set_chart', description: 'UI: show a ticker chart with an optional macro overlay (factor or series id) and range (e.g. 3m, 1y).', input_schema: S({symbol: {type: 'string'}, overlay: {type: 'string'}, range: {type: 'string'}}, ['symbol'])},
    {name: 'explore', description: 'UI: open linked chart research. peers compares same-date industry/sector participation for a ticker; factor shows historical company exposures to a macro series. Return gaps are not forecasts.', input_schema:S({symbol:{type:'string'},view:{type:'string',enum:['peers','factor']}},['symbol'])},
  ];

  function systemPrompt(m) {
    const c = m.meta.counts || {};
    return [
      'You are the analyst assistant inside the SmartOptions V2 dashboard (daily macro + market fundamentals for options sellers).',
      'Data loaded: as-of session ' + m.asof_session + ', exported ' + m.exported_at + '. ' + (c.tickers || Object.keys(m.tickers).length) + ' tickers (set A = top S&P 500 movers, set B = Sam\'s universe). Macro groups: ' + m.groups.join(', ') + '. Relations factors: ' + m.factors.join(', ') + ' (' + Object.entries(m.units).map(([k, v]) => k + ': ' + v).join('; ') + '), window ' + m.rel_window + '.',
      'RULES (hard):',
      '1. Use tools for every fact. Never invent or estimate numbers, consensus, forecasts, formulas or thresholds. If a value is missing or not in the tools, write "not in the data".',
      '2. Every number you write (prices, %, scores, dates, counts, coefficients, t-stats, shocks) must be followed by its citation marker [n], using the cite ids returned by the tool (cite_map / cite_id / cite[].id). Put the marker in the same line or table row as the number. Never make up a marker.',
      '3. This is a research tool, not personalized advice. No recommendations to buy/sell, no "optimal", no orders. You may rank by stated criteria and describe conditional playbooks.',
      '4. Regression coefficients are associations over a stated window, not causes. Say so when you use them.',
      "5. Sam's scores (Opportunity, Quality, Trend, Risk, Flags) are a read-only snapshot from 2026-07-25 - label them as such.",
      '6. Monthly/quarterly macro values carry their observation period; never imply they are new today.',
      '7. Start with the plain-language assessment and the most decision-relevant evidence. Keep the initial answer compact; do not dump indicators. Separate observation, conditional interpretation, alternatives and what could invalidate the thesis. The source entries and Data & dashboard actions retain detailed tool data and calculations; give the full math when the user asks for it.',
      '8. UI action tools change what the user sees on the dashboard. Use them when asked to organize, set up, filter or show something; call ui_capabilities first to learn the available panels/columns/presets. If a UI action returns "' + NOT_AVAILABLE + '", say so plainly.',
      '9. Adapt the workspace to the current task. The Market → Volatility → Companies → Strategy guide is only one optional example, never a required sequence. Users can start with any company, event, comparison or strategy. Use filters, columns, panels and saved workspaces to suit their question. Save or restore a layout when asked.',
      '10. A source marker does not make an interpretation true. Preserve the ticker, field, unit and observation date from the tool. Do not present predictions or model estimates as facts or certainty. Use explicit conditional language for scenarios. Copy or round returned numbers; do not silently derive new figures.',
      '11. The main company view is labeled Analyst in the dashboard (markets internally). To open Analyst for AAPL, call select with symbol AAPL. open_ticker_tab chooses Overview, Technicals or Strategies within that view; Analyst itself is not a ticker tab.',
      '12. Answer only the question asked. If a future price, consensus or missing field is unavailable, say not in the data without padding the answer with unrelated figures. Never infer a future catch-up merely because peers moved earlier.',
      '13. For a broad decision or strategy question, distill the measured market backdrop, company fundamentals, conditional scenarios, strategy alternatives and invalidating evidence. Use get_confidence when discussing confidence and explain its component math. Its score is evidence support, NOT odds of success; predictive confidence and a demonstrated trading edge require out-of-sample validation not supplied here. Ask briefly for missing ticker, horizon or risk constraints when those change the comparison. For a direct factual question, just answer it.',
    ].join('\n');
  }

  // ---------------------------------------------------------------- citation post-check
  // A "figure" is a number that looks like data: has a decimal, %, $, a sign, a date, or >= 2 digits,
  // and is not part of a word (10Y, Q3, S&P 500, model names). A line (table row / bullet) or prose
  // sentence that contains a figure but no [n] marker is reported as uncited.
  const FIG_RE = /(^|[^A-Za-z0-9_.\[\/-])([-+−]?\$?\d{1,3}(?:,\d{3})+(?:\.\d+)?|[-+−]?\$?\d+(?:\.\d+)?)(%|bps?|x|pp|[KMBT]|\s+(?:thousand|million|billion|trillion))?(?![A-Za-z0-9\]])/g;
  const ISO_FIG_RE = /\b\d{4}-\d{2}(?:-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?)?/g;
  function figureValue(token) {
    const m = String(token).replace(/−/g, '-').match(/^([-+]?\$?[\d,]+(?:\.\d+)?)(.*)$/);
    if (!m) return null;
    const raw = m[1].replace(/[$,]/g, ''), suffix = m[2].trim();
    const scale = ({K: 1e3, M: 1e6, B: 1e9, T: 1e12, thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12})[suffix] || 1;
    const decimals = (raw.split('.')[1] || '').length;
    return {value: Number(raw) * scale, tolerance: 0.5 * Math.pow(10, -decimals) * scale};
  }
  function figuresIn(s) {
    const clean = s.replace(/\[\d+\]/g, ' ').replace(/S&P\s?500/gi, 'SP').replace(ISO_FIG_RE, 'DATE')
      .replace(/claude-[a-z]+-[\d-]+/gi, 'M').replace(/^\s*\d+[.)]\s+/, '');
    const out = [];
    const dates = s.match(ISO_FIG_RE) || [];
    out.push(...dates);
    let mm; FIG_RE.lastIndex = 0;
    while ((mm = FIG_RE.exec(clean))) {
      const tok = mm[2], unit = mm[3] || '';
      const digits = tok.replace(/[^\d]/g, '');
      const dataLike = /[.%$,]/.test(tok + unit) || /^[-+−]/.test(tok) || unit || digits.length >= 2;
      if (dataLike) out.push(tok + unit);
    }
    return out;
  }
  function splitClaims(text) {
    const parts = [];
    for (const line of String(text).split(/\n/)) {
      if (/^\s*\|?\s*:?-{3,}/.test(line)) continue; // table separator
      if (/^\s*\|/.test(line)) { parts.push(line); continue; }
      const sentences = line.split(/(?<=[.!?;])\s+(?=[A-Z(*])/);
      parts.push(...sentences);
    }
    return parts.filter(p => p.trim());
  }
  function citationCheck(text, registry) {
    const uncited = [], badRefs = [], unsupported = [];
    for (const claim of splitClaims(text)) {
      const figs = figuresIn(claim);
      if (figs.length && !/\[\d+\]/.test(claim)) uncited.push({text: claim.trim().slice(0, 160), figures: figs});
      const ids = [...claim.matchAll(/\[(\d+)\]/g)].map(m => +m[1]).filter(n => registry && registry.get(n));
      if (figs.length && ids.length) {
        const missing = figs.filter(f => !ids.some(id => {
          const e = registry.evidence && registry.evidence[id];
          if (!e) return false;
          if (/^\d{4}-\d{2}(?:-\d{2})?(?:T|$)/.test(f)) return e.dates.has(f) || (f.includes('T') && [...e.dates].some(d => d.includes('T') && Date.parse(d) === Date.parse(f)));
          const n = figureValue(f);
          return n && [...e.numbers].some(v => Math.abs(v - n.value) <= n.tolerance + Math.max(1, Math.abs(v)) * 1e-12);
        }));
        if (missing.length) unsupported.push({text: claim.trim().slice(0, 160), figures: missing, refs: ids});
      }
    }
    const refs = new Set();
    String(text).replace(/\[(\d+)\]/g, (x, n) => { refs.add(+n); return x; });
    for (const n of refs) if (!registry || !registry.get(n)) badRefs.push(n);
    return {ok: !uncited.length && !badRefs.length && !unsupported.length, uncited, unknown_refs: badRefs, unsupported_figures: unsupported, refs: [...refs].sort((a, b) => a - b)};
  }

  // ---------------------------------------------------------------- Anthropic client + tool loop
  function apiError(status, body) {
    const type = body && body.error && body.error.type;
    const msg = body && body.error && body.error.message;
    if (type === 'demo_proxy_error') return msg || 'The temporary demo relay is unavailable. Try your own key.';
    if (status === 401 || type === 'authentication_error') return 'API key rejected (401). Open Settings and paste a valid Anthropic API key.';
    if (status === 403 || type === 'permission_error') return 'This key is not allowed to use that model (403). Try another model or key.';
    if (status === 429 || type === 'rate_limit_error') return 'Rate limited by Anthropic (429). Wait a moment and ask again.';
    if (status === 529 || type === 'overloaded_error') return 'Anthropic API is overloaded right now (529). Try again shortly or switch model.';
    if (status === 400) return 'Request rejected (400): ' + (msg || 'invalid request');
    return 'Anthropic API error ' + status + (msg ? ': ' + msg : '');
  }

  async function callApi(cfg, body) {
    let r;
    const demo = !cfg.apiKey && activeDemo();
    const url = demo ? demo.url : API_URL;
    const headers = demo ? {'content-type': 'application/json'} : {
      'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true', 'content-type': 'application/json'};
    if (demo) body = Object.assign({}, body, {model: demo.model, max_tokens: Math.min(body.max_tokens || 4096, 4096)});
    try {
      r = await safeFetch(url, {method: 'POST', headers, body: JSON.stringify(body)});
    } catch (e) { throw new Error((demo ? 'Demo connection unavailable. Turn on Tailscale and allow local-network access for this site in your browser, then try again. Your key connects directly without Tailscale. ' : 'Network error reaching Anthropic. ') + (e && e.message || e)); }
    let data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    if (!r.ok || (data && data.type === 'error')) throw new Error(apiError(r.status, data));
    return data;
  }

  // Runs one question through the tool loop. conv = {messages: [], registry: CiteRegistry}.
  // hooks.onTool(name, input, result) is called for each tool execution (UI trace).
  async function ask(question, conv, model, cfg, hooks) {
    hooks = hooks || {};
    const ctx = {registry: conv.registry, cite: c => conv.registry.add(c), now: cfg.now ? cfg.now() : new Date(), api: root.SmartOptionsAPI || null};
    conv.messages.push({role: 'user', content: question});
    const base = {model: cfg.model || MODELS[0].id, max_tokens: cfg.max_tokens || 4096, output_config:{effort:'low'}, system: systemPrompt(model), tools: TOOL_SCHEMAS};
    let rounds = 0;
    const trace = [];
    for (;;) {
      const body = Object.assign({}, base, {messages: conv.messages});
      if (rounds >= MAX_TOOL_ROUNDS) body.tool_choice = {type: 'none'};
      const res = await callApi(cfg, body);
      if(res.stop_reason==='max_tokens')throw new Error('The response reached its length limit. Ask for a shorter brief or one part at a time. Dashboard actions already completed may still be visible.');
      conv.messages.push({role: 'assistant', content: res.content});
      const uses = (res.content || []).filter(b => b.type === 'tool_use');
      if (res.stop_reason !== 'tool_use' || !uses.length) {
        let text = (res.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
        if(!text)throw new Error('The provider returned no answer. Try a narrower question. Dashboard actions already completed may still be visible.');
        let check = citationCheck(text, conv.registry);
        if (!check.ok) {
          // One text-only repair pass: never repeats actions or silently accepts
          // a marker as proof. Persistent failures remain visibly unverified.
          conv.messages.push({role:'user', content:'The dashboard consistency check found unsupported or uncited figures: '+JSON.stringify({uncited:check.uncited,unknown_refs:check.unknown_refs,unsupported_figures:check.unsupported_figures})+'. Rewrite the answer using only the completed tool results. Cite each numeric claim with its matching source. Remove unrelated figures; if a value is unavailable, just say not in the data. Do not repeat dashboard actions or invent evidence. Return only the corrected answer.'});
          const fixed = await callApi(cfg, Object.assign({}, base, {messages:conv.messages,tool_choice:{type:'none'}}));
          if(fixed.stop_reason==='max_tokens')throw new Error('The corrected response reached its length limit. Ask for a shorter question. Dashboard actions already completed may still be visible.');
          conv.messages.push({role:'assistant',content:fixed.content});
          text = (fixed.content || []).filter(b=>b.type==='text').map(b=>b.text).join('\n').trim();
          if(!text)throw new Error('The provider returned no corrected answer. Try a narrower question.');
          check = citationCheck(text,conv.registry);
        }
        return {text, trace, check, rounds, usage: res.usage || null};
      }
      rounds++;
      const results = [];
      for (const u of uses) {
        const out = await runTool(u.name, u.input, model, ctx);
        trace.push({name: u.name, input: u.input, error: out && out.error ? out.error : null});
        if (hooks.onTool) hooks.onTool(u.name, u.input, out);
        let s = JSON.stringify(out);
        if (s.length > 40000) s = s.slice(0, 40000) + '... [truncated: narrow the request]';
        results.push({type: 'tool_result', tool_use_id: u.id, content: s, is_error: !!(out && out.error)});
      }
      conv.messages.push({role: 'user', content: results});
    }
  }

  function newConversation() { return {messages: [], registry: new CiteRegistry()}; }

  // ---------------------------------------------------------------- rendering (pure string -> HTML)
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch])); }
  function inline(s, turnId) {
    return esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[(\d+)\]/g, (x, n) => '<a class="soc-c" href="#soc-src-' + turnId + '-' + n + '" data-cite="' + n + '">[' + n + ']</a>');
  }
  function renderMarkdown(text, turnId) {
    const lines = String(text).split('\n');
    let html = '', i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (/^\s*\|/.test(l)) {
        const rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(lines[i]); i++; }
        const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
        const body = rows.filter(r => !/^\s*\|?\s*:?-{3,}/.test(r));
        html += '<div class="soc-tw"><table>' + body.map((r, k) => '<tr>' + cells(r).map(c => (k === 0 ? '<th>' : '<td>') + inline(c, turnId) + (k === 0 ? '</th>' : '</td>')).join('') + '</tr>').join('') + '</table></div>';
        continue;
      }
      if (/^\s*[-*]\s+/.test(l)) {
        let items = '';
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items += '<li>' + inline(lines[i].replace(/^\s*[-*]\s+/, ''), turnId) + '</li>'; i++; }
        html += '<ul>' + items + '</ul>';
        continue;
      }
      if (/^#{1,4}\s+/.test(l)) { html += '<div class="soc-h">' + inline(l.replace(/^#+\s+/, ''), turnId) + '</div>'; i++; continue; }
      if (l.trim()) html += '<p>' + inline(l, turnId) + '</p>';
      i++;
    }
    return html;
  }
  function renderSources(refs, registry, turnId) {
    if (!refs.length) return '';
    return '<ol class="soc-src">' + refs.map(n => {
      const c = registry.get(n);
      if (!c) return '<li id="soc-src-' + turnId + '-' + n + '" value="' + n + '" class="soc-bad">[' + n + '] unknown citation</li>';
      const meta = [c.source, c.series, c.as_of ? 'as of ' + c.as_of : null].filter(Boolean).map(esc).join(' &middot; ');
      return '<li id="soc-src-' + turnId + '-' + n + '" value="' + n + '"><span class="soc-sl">' + esc(c.label) + '</span> <span class="soc-sm">' + meta + '</span>' +
        (c.url ? ' <a href="' + esc(c.url) + '" target="_blank" rel="noopener noreferrer">source</a>' : '') + '</li>';
    }).join('') + '</ol>';
  }
  function renderWarning(check) {
    if (check.ok) return '';
    let h = '<div class="soc-warn"><div><b>Answer unverified.</b> Check the cited dashboard sources before relying on these claims.</div>';
    if (check.uncited.length) h += '<div><b>Uncited figure' + (check.uncited.length > 1 ? 's' : '') + ':</b> ' + check.uncited.map(u => esc(u.figures.join(', '))).join('; ') + ' - not backed by a cited tool result; verify on the dashboard before relying on ' + (check.uncited.length > 1 ? 'them' : 'it') + '.</div>';
    if (check.unknown_refs.length) h += '<div><b>Unknown citation marker:</b> ' + check.unknown_refs.map(n => '[' + n + ']').join(' ') + '</div>';
    if (check.unsupported_figures && check.unsupported_figures.length) h += '<div><b>Figures not found in the cited tool data:</b> ' + check.unsupported_figures.map(u => esc(u.figures.join(', ')) + ' ' + u.refs.map(n => '[' + n + ']').join(' ')).join('; ') + '. Inspect the source entries below; a valid marker alone does not verify a value.</div>';
    return h + '</div>';
  }

  // ---------------------------------------------------------------- DOM panel
  const SUGGESTED = ['Distill the market backdrop: what changed, what matters, and what is uncertain?', 'Build an evidence brief for AAPL: fundamentals, scenarios, strategy alternatives, confidence and what would change the thesis.', 'Arrange the dashboard to compare my watchlist and explain the strongest evidence.'];

  function store() { try { return root.localStorage; } catch (e) { return null; } }
  function getKey() { const s = store(); return s ? s.getItem(LS_KEY) || '' : ''; }

  function mount(opts) {
    opts = opts || {};
    const doc = root.document;
    if (!doc) throw new Error('mount() needs a browser document');
    if (doc.getElementById('soc-panel')) return root.SmartOptionsChat;
    const ls = store();
    let dataModel = null, dataErr = null, busy = false, conv = newConversation(), turnSeq = 0;
    const dataReady = loadData(opts).then(m => { dataModel = m; status(); }, e => { dataErr = e; status(); });
    const demoReady = safeFetch((opts.dataBase || 'data/') + 'chat-demo.json').then(r => r.ok ? r.json() : null).then(c => {
      demoService = validateDemoConfig(c);
      status();
    }).catch(() => { demoService = null; status(); });

    const wrap = doc.createElement('div');
    wrap.className = 'soc-host';
    wrap.innerHTML =
      '<button type="button" id="soc-toggle" class="soc-toggle" title="Analyst chat (/)">ASK</button>' +
      '<aside id="soc-panel" class="soc" aria-hidden="false" aria-label="SmartOptions analyst chat">' +
      '<div class="soc-hd"><span class="soc-tt">ASK YOUR DASHBOARD <span class="soc-tagline">· Explain the data or arrange your view</span></span><select class="soc-model" aria-label="Model">' +
      MODELS.map(x => '<option value="' + x.id + '">' + x.label + '</option>').join('') + '</select>' +
      '<button type="button" class="soc-set" title="Connect your Anthropic API key">KEY</button><button type="button" class="soc-new">NEW</button><button type="button" class="soc-expand" aria-label="Expand chat" aria-expanded="false">Expand ↗</button><button type="button" class="soc-x" aria-label="Collapse chat">Collapse ↙</button></div>' +
      '<form class="soc-settings" hidden onsubmit="return false"><label>Anthropic API key<input type="password" class="soc-key" autocomplete="off" spellcheck="false" placeholder="sk-ant-..."></label>' +
      '<div class="soc-row"><button type="button" class="soc-save">SAVE</button><button type="button" class="soc-forget">FORGET KEY</button></div>' +
      '<div class="soc-note">Stored only in this browser (localStorage) and sent only to api.anthropic.com. Do not use on a shared computer.</div></form>' +
      '<div class="soc-stat"></div><div class="soc-log" aria-live="polite"></div>' +
      '<div class="soc-examples" style="display:flex;gap:6px;overflow-x:auto;flex-shrink:0;padding:5px 8px;white-space:nowrap" aria-label="Example prompts">' + SUGGESTED.map(s => '<button type="button" style="font-size:11px">' + esc(s) + '</button>').join('') + '</div>' +
      '<div class="soc-key-hint soc-note" style="padding:4px 8px">Use your own Anthropic API key via KEY. It is stored only in your browser and sent only to Anthropic.</div>' +
      '<form class="soc-in"><textarea rows="1" aria-label="Ask about dashboard data or customize the view" placeholder="Why is the market leaning bullish? · Show only valuation columns…"></textarea><button type="submit">Send →</button></form>' +
      '<div class="soc-disc">Research tool, not advice. Figures cite dashboard data; associations are not causes.</div></aside>';
    const tape = doc.getElementById('tape');
    if (tape) tape.after(wrap); else doc.body.appendChild(wrap);
    const $ = s => wrap.querySelector(s);
    const panel = $('#soc-panel'), log = $('.soc-log'), ta = $('.soc-in textarea'), sel = $('.soc-model'), settings = $('.soc-settings'), keyIn = $('.soc-key');
    sel.value = (ls && ls.getItem(LS_MODEL)) || MODELS[0].id;
    if (!MODELS.some(x => x.id === sel.value)) sel.value = MODELS[0].id;

    function status() {
      const st = $('.soc-stat');
      const parts = [];
      parts.push(dataErr ? 'data: ' + dataErr.message : dataModel ? 'data: session ' + dataModel.asof_session + ', ' + Object.keys(dataModel.tickers).length + ' tickers' : 'data: loading');
      const demo = !getKey() && activeDemo();
      parts.push(getKey() ? 'your key: saved' : demo ? 'Demo ready via Tailscale · expires ' + new Date(demo.expires_at).toLocaleString() : 'key: not set');
      st.textContent = parts.join('  |  ');
      $('.soc-key-hint').hidden = !!getKey() || !!demo;
      sel.disabled = !!demo;
      if (demo) sel.value = demo.model;
      $('.soc-set').textContent = demo ? 'Your key' : 'KEY';
    }
    function suggestions() {
      if (log.children.length) return;
      const d = doc.createElement('div'); d.className = 'soc-sug';
      d.innerHTML = SUGGESTED.map(s => '<button type="button">' + esc(s) + '</button>').join('');
      d.addEventListener('click', e => { if (e.target.tagName === 'BUTTON') { ta.value = e.target.textContent; submit(); } });
      log.appendChild(d);
    }
    function resizeDashboard() { root.dispatchEvent(new root.Event('resize')); }
    function open() { panel.classList.add('open'); panel.setAttribute('aria-hidden', 'false'); $('.soc-expand').setAttribute('aria-expanded', 'true'); doc.documentElement.classList.add('soc-open'); suggestions(); status(); ta.focus(); resizeDashboard(); }
    function close() { panel.classList.remove('open'); panel.setAttribute('aria-hidden', 'false'); $('.soc-expand').setAttribute('aria-expanded', 'false'); doc.documentElement.classList.remove('soc-open'); resizeDashboard(); }
    $('#soc-toggle').addEventListener('click', () => panel.classList.contains('open') ? close() : open());
    $('.soc-examples').addEventListener('click', e => { const b=e.target.closest('button'); if(b) { ta.value=b.textContent; ta.focus(); } });
    $('.soc-x').addEventListener('click', close);
    $('.soc-expand').addEventListener('click', open);
    $('.soc-set').addEventListener('click', () => { open(); settings.hidden = !settings.hidden; keyIn.value = ''; keyIn.placeholder = getKey() ? 'key saved (hidden) - paste to replace' : 'sk-ant-...'; });
    $('.soc-save').addEventListener('click', () => { const v = keyIn.value.trim(); if (v && ls) ls.setItem(LS_KEY, v); keyIn.value = ''; settings.hidden = true; status(); });
    $('.soc-forget').addEventListener('click', () => { if (ls) ls.removeItem(LS_KEY); keyIn.value = ''; status(); });
    $('.soc-new').addEventListener('click', () => { if (busy) return; conv = newConversation(); log.innerHTML = ''; panel.classList.remove('has-turns'); suggestions(); resizeDashboard(); });
    sel.addEventListener('change', () => { if (ls) ls.setItem(LS_MODEL, sel.value); });
    $('.soc-in').addEventListener('submit', e => { e.preventDefault(); submit(); });
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });
    doc.addEventListener('keydown', e => {
      const tag = (e.target && e.target.tagName) || '';
      const typing = /INPUT|TEXTAREA|SELECT/.test(tag) || (e.target && e.target.isContentEditable);
      if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); open(); }
      else if (e.key === 'Escape' && panel.classList.contains('open')) { close(); }
    });
    log.addEventListener('click', e => {
      const a = e.target.closest && e.target.closest('a.soc-c');
      if (!a) return;
      e.preventDefault();
      const li = log.querySelector(a.getAttribute('href'));
      if (li) { li.scrollIntoView({block: 'nearest'}); li.classList.add('soc-hl'); setTimeout(() => li.classList.remove('soc-hl'), 1200); }
    });

    async function submit() {
      const q = ta.value.trim();
      if (!q || busy) return;
      panel.classList.add('has-turns');
      resizeDashboard();
      const sug = log.querySelector('.soc-sug'); if (sug) sug.remove();
      const turnId = ++turnSeq;
      const t = doc.createElement('div'); t.className = 'soc-turn';
      t.innerHTML = '<div class="soc-q">&gt; ' + esc(q) + '</div><details class="soc-actions"><summary>Data & dashboard actions</summary><div class="soc-trace"></div></details><div class="soc-a"><span class="soc-dim">working...</span></div>';
      log.appendChild(t); log.scrollTop = log.scrollHeight;
      ta.value = '';
      const ans = t.querySelector('.soc-a'), tr = t.querySelector('.soc-trace');
      await demoReady;
      if (!getKey() && !activeDemo()) { ans.innerHTML = '<div class="soc-warn">No chat connection set. Click KEY to connect your Anthropic API key. Today’s shared demo may have expired.</div>'; open(); settings.hidden = false; return; }
      await dataReady;
      if (!dataModel) { ans.innerHTML = '<div class="soc-warn">Dashboard data could not be loaded: ' + esc(dataErr && dataErr.message) + '</div>'; return; }
      busy = true;
      const snapshot = conv.messages.length;
      try {
        const r = await ask(q, conv, dataModel, {apiKey: getKey(), model: sel.value}, {
          onTool: (name, input, out) => {
            const d = doc.createElement('div');
            d.textContent = name + ' ' + JSON.stringify(input || {}).slice(0, 120) + (out && out.error ? '  -> ' + out.error.slice(0, 120) : '');
            const evidence=doc.createElement('details'), summary=doc.createElement('summary'), raw=doc.createElement('pre');
            evidence.className='soc-evidence';summary.textContent='Dig deeper · tool data, methods & inputs';raw.textContent=JSON.stringify(out,null,2);
            evidence.append(summary,raw);d.appendChild(evidence);
            tr.appendChild(d);
          }});
        ans.innerHTML = renderWarning(r.check) + renderMarkdown(r.text || '(empty answer)', turnId) + renderSources(r.check.refs, conv.registry, turnId);
      } catch (e) {
        conv.messages.length = snapshot; // drop the failed exchange so the conversation stays valid
        ans.innerHTML = '<div class="soc-warn">' + esc(e && e.message || e) + '</div>';
      } finally { busy = false; log.scrollTop = log.scrollHeight; }
    }
    status();
    root.SmartOptionsChat.open = open; root.SmartOptionsChat.close = close;
    root.SmartOptionsChat.draft = function (text) { open(); ta.value = String(text || ''); ta.focus(); };
    return root.SmartOptionsChat;
  }

  return {
    version: '1', API_URL, MODELS, MAX_TOOL_ROUNDS, TOOL_SCHEMAS, SUGGESTED,
    adapt, loadData, isAllowedUrl, validateDemoConfig, safeFetch, CiteRegistry, newConversation, runTool, systemPrompt,
    citationCheck, figuresIn, ask, renderMarkdown, renderSources, renderWarning, mount,
    tools: DATA_TOOLS, uiTools: Object.keys(UI_TOOLS),
  };
});
