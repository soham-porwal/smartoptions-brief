/* Markets: one interactive grid workspace (sector treemap, equal tiles, list), an in-place stock/ETF inspector,
   explicit-basis Related groups and a compare/room selection tray. Pure helpers are exported for node tests.
   Returns are completed-session values with their own dates; quotes patch prices but never reorder tiles.
   Area means equity market value only. ETF AUM is not market cap and is never used as tile area. */
'use strict';
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SmartOptionsMarkets = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  const isNum = v => typeof v === 'number' && isFinite(v);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const pct = (v, d = 2) => { if (!isNum(v)) return 'n/a'; const r = +v.toFixed(d); return (r > 0 ? '+' : r < 0 ? '−' : '') + Math.abs(r).toFixed(d) + '%'; };
  const money = v => isNum(v) ? '$' + (v >= 1000 ? v.toLocaleString('en-US', {maximumFractionDigits: 2, minimumFractionDigits: 2}) : v.toFixed(2)) : 'n/a';
  const cap = v => !isNum(v) ? 'n/a' : v >= 1e12 ? '$' + (v / 1e12).toFixed(2) + 'T' : v >= 1e9 ? '$' + (v / 1e9).toFixed(1) + 'B' : '$' + (v / 1e6).toFixed(0) + 'M';
  const PERIODS = {'1D': {key: 'd1', n: 1, label: '1 day', sessions: 'previous session'}, '1W': {key: 'd5', n: 5, label: '1 week', sessions: 'five sessions'}, '1M': {key: 'm1', n: 21, label: '1 month', sessions: 'twenty-one sessions'}};
  const UNIVERSES = {sp: 'S&P 500', all: 'Stocks and ETFs', saved: 'Saved', room: 'Room assets'};
  const SORTS = {area: 'Market value (map order)', ret: 'Period return', name: 'Name', symbol: 'Symbol', mcap: 'Market cap', pef: 'Forward P/E'};
  const DEFAULT = Object.freeze({u: 'sp', p: '1D', v: 'grid', g: 'sector', sort: 'area', dir: 'desc', type: 'all', sec: '', q: '', size: 'mcap', fx:'', shock:0, colour:'observed', ind:'', sel: '', rel: '', preset: ''});
  // Legacy analyst-screener presets (app.js PRESETS), same formulas on the same core fields. Scenario-dependent
  // "Macro Tailwind + Cheap" uses its no-scenario branch here (20-session residual >= 0); rate sensitivity uses |t| >= 2.
  const PRESETS = [
    {id: 'movers', h: 'Movers', f: x => (x.m.sets || []).includes('A'), sort: 'd1abs', dir: 'desc'},
    {id: 'alpha20', h: '20d Alpha (+3%)', f: x => isNum(x.m.res20d) && x.m.res20d >= 3, sort: 'res20d', dir: 'desc'},
    {id: 'garpmacro', h: 'Macro Tailwind + Cheap', f: x => isNum(x.m.pef_sec_rel) && x.m.pef_sec_rel <= 0.95 && isNum(x.m.res20d) && x.m.res20d >= 0, sort: 'pef_sec_rel', dir: 'asc'},
    {id: 'volcheap', h: 'Cheap Vol (Catalyst)', f: x => isNum(x.m.ivrv_eff) && x.m.ivrv_eff <= 1.05 && ((isNum(x.m.ern) && x.m.ern >= 0 && x.m.ern <= 21) || (isNum(x.m.res20d) && Math.abs(x.m.res20d) >= 3)), sort: 'ivrv_eff', dir: 'asc'},
    {id: 'volrich', h: 'Rich Premium (Sell Vol)', f: x => isNum(x.m.ivrv_eff) && x.m.ivrv_eff >= 1.25 && (!isNum(x.m.ern) || x.m.ern > 14), sort: 'ivrv_eff', dir: 'desc'},
    {id: 'sam', h: 'Historical scores', f: x => isNum(x.m.opp), sort: 'opp', dir: 'desc'},
    {id: 'earn7', h: 'Earnings 7d', f: x => isNum(x.m.ern) && x.m.ern >= 0 && x.m.ern <= 7, sort: 'ern', dir: 'asc'},
    {id: 'rate', h: 'Rate-sensitive', f: x => isNum(x.m.t10) && Math.abs(x.m.t10) >= 2, sort: 'b10', dir: 'asc'},
    {id: 'iv', h: 'High IV', f: x => isNum(x.m.iv), sort: 'iv', dir: 'desc'}];
  const METRICS = {d1abs: ['|1D move|', x => isNum(x.ret.d1) ? Math.abs(x.ret.d1) : null, v => v.toFixed(2) + '%'], res20d: ['Residual 20d', x => x.m.res20d, v => pct(v)], res5d: ['Residual 5d', x => x.m.res5d, v => pct(v)], ivrv_eff: ['IV/RV', x => x.m.ivrv_eff, v => v.toFixed(2)], pef_sec_rel: ['Fwd P/E vs sector', x => x.m.pef_sec_rel, v => v.toFixed(2) + '×'], iv: ['ATM IV', x => x.m.iv, v => v.toFixed(1)], ern: ['Days to earnings', x => x.m.ern, v => String(v)], opp: ['Historical score', x => x.m.opp, v => String(v)], b10: ['Rate beta (per 10bp)', x => x.m.b10, v => v.toFixed(3)], vr: ['Volume / 20d', x => x.m.vr, v => v.toFixed(2) + '×'], up: ['Analyst target upside', x => x.m.up, v => pct(v, 1)]};
  const COLS_KEY = 'so-markets-columns-v1', VIEWS_KEY = 'so-markets-views-v1', DEFAULT_COLS = ['ret', 'mcap', 'pef'];
  function readJSON(store, key, fallback) { try { const raw = store && store.getItem(key); if (raw == null) return {ok: true, v: fallback}; return {ok: true, v: JSON.parse(raw)}; } catch (e) { return {ok: false, v: fallback}; } }
  // Retained fund identities (published px files). Discovered ETFs come from the shared instrument catalog.
  const RETAINED_ETFS = Object.fromEntries(Object.entries((root.SmartOptionsInstruments && root.SmartOptionsInstruments.RETAINED) || {SPY: {name: 'SPDR S&P 500 ETF Trust'}, RSP: {name: 'Invesco S&P 500 Equal Weight ETF'}}).map(([k, v]) => [k, v.name]));

  /* ---------------------------------------------------------------- pure state + data */
  function parseState(query) {
    const p = new URLSearchParams(String(query || '').replace(/^.*?\?/, '')), s = {...DEFAULT};
    for (const k of Object.keys(DEFAULT)) if (p.has(k)) s[k] = String(p.get(k)).slice(0, 64);
    if (!UNIVERSES[s.u]) s.u = DEFAULT.u; if (!PERIODS[s.p]) s.p = DEFAULT.p; if (!['grid', 'list'].includes(s.v)) s.v = 'grid';
    if (!['sector', 'type', 'none'].includes(s.g)) s.g = 'sector'; if (!['asc', 'desc'].includes(s.dir)) s.dir = 'desc';
    if (!['all', 'EQUITY', 'ETF'].includes(s.type)) s.type = 'all'; if (s.preset && !PRESETS.some(x => x.id === s.preset)) s.preset = ''; if (!SORTS[s.sort] && !METRICS[s.sort] && !/^imp:[A-Za-z0-9 _.%()-]{1,40}$/.test(s.sort)) s.sort = 'area'; if (!['mcap', 'equal'].includes(s.size)) s.size = 'mcap';
    s.sel = /^[A-Z][A-Z0-9.\-]{0,9}$/.test(s.sel) ? s.sel : ''; s.rel = /^[A-Z][A-Z0-9.\-]{0,9}$/.test(s.rel) ? s.rel : '';
    s.shock=Number(s.shock);if(!isNum(s.shock))s.shock=0;if(!/^[a-z0-9_]{0,24}$/.test(s.fx))s.fx='';if(!['observed','scenario'].includes(s.colour))s.colour='observed';if(!['','50','200'].includes(s.ind))s.ind='';
    return s;
  }
  function encodeState(s) { const p = new URLSearchParams(); for (const k of Object.keys(DEFAULT)) {const v=s[k];if (v !== DEFAULT[k] && v !== '' && v != null) p.set(k, v);} const q = p.toString(); return '#/markets' + (q ? '?' + q : ''); }
  // ETF period returns from published daily closes: n sessions back, own end date. Null when history is short.
  function closeReturns(bars) {
    const b = (bars || []).filter(x => Array.isArray(x) && isNum(x[4]) && x[4] > 0).sort((a, c) => a[0] < c[0] ? -1 : 1);
    const out = {date: b.length ? b[b.length - 1][0] : null, px: b.length ? b[b.length - 1][4] : null};
    for (const [k, v] of Object.entries(PERIODS)) out[v.key] = b.length > v.n ? 100 * (b[b.length - 1][4] / b[b.length - 1 - v.n][4] - 1) : null;
    return out;
  }
  // items: one identity contract {id,symbol,name,type,sector,category,mcap,ret:{d1,d5,m1},date,source}
  function buildUniverse(core, opts = {}) {
    const rows = (core && core.rows) || [], session = core && core.asof_session, u = opts.universe || 'sp';
    const eq = rows.filter(r => u !== 'sp' || r.sp500_member !== false).map(r => ({id: 'eq:' + r.t, symbol: r.t, name: r.n, type: 'EQUITY', sector: r.sec || 'Unclassified', category: r.sec || 'Unclassified',
      mcap: isNum(r.mcap) && r.mcap > 0 ? r.mcap : null, pef: isNum(r.pef) ? r.pef : null, date: r.pxd || null,
      ret: {d1: r.pxd === session && isNum(r.d1) ? r.d1 : null, d5: r.pxd === session && isNum(r.d5) ? r.d5 : null, m1: r.pxd === session && isNum(r.m1) ? r.m1 : null},
      m: {sets: r.sets, res5d: r.res5d, res20d: r.res20d, ivrv_eff: r.ivrv_eff, pef_sec_rel: r.pef_sec_rel, iv: r.iv, ern: r.ern, opp: r.sam && r.sam.opp, t10: r.rel && r.rel.t && r.rel.t.us10y_bps, b10: r.rel && r.rel.c && r.rel.c.us10y_bps, vr: r.vr, up: r.up},
      member: r.sp500_member !== false, source: 'Published core rows (Yahoo Finance via yfinance), completed session ' + (r.pxd || 'unavailable')}));
    if (u === 'sp') return eq;
    const funds = Object.entries(opts.etfs || {}).map(([t, f]) => ({id: 'eq:' + t, symbol: t, name: f.name, type: 'ETF', sector: null, category: f.category || 'Unclassified', mcap: null, pef: null,
      m: {}, date: f.ret ? f.ret.date : null, ret: f.ret ? {d1: f.ret.d1, d5: f.ret.d5, m1: f.ret.m1} : {d1: null, d5: null, m1: null}, source: f.source || 'Published daily closes'}));
    let all = eq.concat(funds.filter(f => !eq.some(e => e.symbol === f.symbol)));
    if (u === 'saved') { const s = new Set(opts.saved || []); all = all.filter(x => s.has(x.symbol)); }
    if (u === 'room') { const s = new Set(opts.room || []); all = all.filter(x => s.has(x.symbol)); }
    return all;
  }
  function filterItems(items, s) {
    const q = String(s.q || '').trim().toUpperCase();
    const pr = s.preset && PRESETS.find(p => p.id === s.preset);
    return items.filter(x => (!pr || (x.m && pr.f(x))) && (s.type === 'all' || x.type === s.type) && (!s.sec || (x.type === 'ETF' ? x.category : x.sector) === s.sec)
      && (!q || x.symbol.includes(q) || String(x.name || '').toUpperCase().includes(q)));
  }
  // Explicit sort. Missing values sort last in either direction; ties use stable symbol order.
  function sortItems(items, s, M = METRICS) {
    const key = s.sort === 'area' ? 'mcap' : s.sort, sign = s.dir === 'asc' ? 1 : -1, pk = PERIODS[s.p].key;
    const val = x => M[key] ? (x.m ? M[key][1](x) : null) : /^imp:/.test(key) ? null : key === 'ret' ? x.ret[pk] : key === 'mcap' ? x.mcap : key === 'pef' ? x.pef : key === 'name' ? String(x.name || '') : x.symbol;
    return items.slice().sort((a, b) => {
      const va = val(a), vb = val(b), ma = va == null || va === '' || (typeof va === 'number' && !isFinite(va)), mb = vb == null || vb === '' || (typeof vb === 'number' && !isFinite(vb));
      if (ma !== mb) return ma ? 1 : -1;
      if (!ma && va !== vb) return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * sign;
      return a.symbol.localeCompare(b.symbol);
    });
  }
  function groupItems(items, by) {
    if (by === 'none') return [{key: 'All', items}];
    const m = new Map();
    for (const x of items) { const k = by === 'type' ? (x.type === 'ETF' ? 'ETFs' : 'Stocks') : x.type === 'ETF' ? 'Fund category: ' + (x.category || 'Unclassified') : (x.sector || 'Unclassified'); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
    return [...m.entries()].map(([key, xs]) => ({key, items: xs}));
  }
  // Area always encodes company market value. Ranked controls/list carry sort order;
  // stable descending-cap geometry keeps the map legible while assumptions change.
  function layoutMode(items,s) {
    if(s.v==='list')return {mode:'list',note:''};
    if(s.size==='equal')return {mode:'equal',note:'Equal tiles (explicitly chosen).'};
    const stocks=items.filter(x=>x.type==='EQUITY'&&isNum(x.mcap)&&x.mcap>0),funds=items.some(x=>x.type==='ETF');
    return stocks.length?{mode:'treemap',note:'Area = company market value.'+(funds?' Funds are listed separately; fund assets are not company market value.':'')}:{mode:'fund-list',note:'Fund comparison; company market-value sizing does not apply.'};
  }
  // Cap-weighted sector aggregates for one explicit end date; coverage is reported, never renormalized silently.
  function sectorAggregates(items, pk) {
    const by = new Map();
    for (const x of items) { if (x.type !== 'EQUITY' || !isNum(x.mcap)) continue; const k = x.sector; if (!by.has(k)) by.set(k, []); by.get(k).push(x); }
    return [...by.entries()].map(([sec, xs]) => { const capAll = xs.reduce((s, x) => s + x.mcap, 0), cov = xs.filter(x => isNum(x.ret[pk])), w = cov.reduce((s, x) => s + x.mcap, 0);
      return {sec, mcap: capAll, n: xs.length, covered: cov.length, coverage: capAll ? w / capAll : 0, pct: w ? cov.reduce((s, x) => s + x.mcap * x.ret[pk], 0) / w : null}; }).sort((a, b) => b.mcap - a.mcap);
  }
  // Related groups always carry a basis. No holdings inference, no visual-similarity correlation.
  function relatedFor(item, items, rel) {
    if (!item) return null;
    if (item.type === 'EQUITY') {
      const peers = items.filter(x => x.type === 'EQUITY' && x.sector === item.sector && x.symbol !== item.symbol).sort((a, b) => (b.mcap || 0) - (a.mcap || 0));
      return {basis: `Same provider sector classification as ${item.symbol}: ${item.sector}.`, kind: 'sector', items: peers};
    }
    const pairs = ((rel && rel.pairs) || []).filter(p => String(p.id || '').split('|').includes('eq:' + item.symbol));
    if (pairs.length) {
      const ids = pairs.map(p => String(p.id).split('|').find(x => x !== 'eq:' + item.symbol));
      return {basis: `Published statistical relationships with ${item.symbol} (OLS on daily changes, ${pairs[0].fit_start} to ${pairs[0].fit_end}, n=${pairs[0].n}); association, not holdings.`, kind: 'statistical', ids, pairs};
    }
    const sameCat = item.category && item.category !== 'Unclassified' ? items.filter(x => x.type === 'ETF' && x.category === item.category && x.symbol !== item.symbol) : [];
    return sameCat.length ? {basis: `Same verified fund category: ${item.category}.`, kind: 'category', items: sameCat}
      : {basis: `No verified category or published relationship for ${item.symbol}. Holdings are not in the sourced data, so related stocks are not inferred.`, kind: 'none', items: []};
  }
  function colorFor(v, period) {
    if (!isNum(v)) return 'var(--mk-na)';
    const capAt = {'1D': 3, '1W': 6, '1M': 12}[period] || 3, t = Math.max(-1, Math.min(1, v / capAt)), a = (0.18 + 0.72 * Math.abs(t)).toFixed(2);
    return t >= 0 ? `rgba(22,140,82,${a})` : `rgba(200,48,48,${a})`;
  }
  function squarify(values, x, y, w, h) {
    const H = root.SmartOptionsHeatmap; if (H && H.squarify) return H.squarify(values, x, y, w, h);
    // Fallback slice layout for node tests only.
    const tot = values.reduce((s, v) => s + v, 0) || 1; let off = 0; return values.map(v => { const ww = w * v / tot, r = {x: x + off, y, w: ww, h}; off += ww; return r; });
  }

  // Relevant comparison, never an asset against itself: stock -> SPY + its sector basket; SPY -> RSP; other fund -> SPY.
  function benchIds(x) { return x.symbol === 'SPY' ? ['eq:SPY', 'eq:RSP'] : x.type === 'EQUITY' && x.sector && x.sector !== 'Unclassified' ? ['eq:' + x.symbol, 'eq:SPY', 'sec:' + x.sector] : ['eq:' + x.symbol, 'eq:SPY']; }
  function benchLabel(x) { return x.symbol === 'SPY' ? 'Compare with equal weight (RSP)' : x.type === 'EQUITY' && x.sector && x.sector !== 'Unclassified' ? 'Compare with SPY and its sector' : 'Compare with SPY'; }
  // Hypothetical basket, never inferred holdings. Missing positive-weight fits withhold the total.
  function basketImpact(symbols, weights, impact) {
    if (!symbols.length || symbols.some(t => !isNum(weights[t]) || weights[t] < 0)) return {ok:false, reason:'Enter non-negative relative weights for every asset.'};
    const total = symbols.reduce((n,t)=>n+weights[t],0);
    if (!(total>0) || !isFinite(total)) return {ok:false,reason:'At least one weight must be positive.'};
    const rows=symbols.map(t=>{const weight=weights[t]/total,r=weight?impact(t):null,covered=!weight||!!(r?.ok&&isNum(r.response_pct));return {symbol:t,weight,covered,response:covered&&weight?r.response_pct:null,contribution:covered&&weight?weight*r.response_pct:0,fit:r};});
    const coverage=rows.filter(r=>r.covered).reduce((n,r)=>n+r.weight,0),coveredContribution=rows.filter(r=>r.covered).reduce((n,r)=>n+r.contribution,0);
    return {ok:true,complete:rows.every(r=>r.covered),coverage,coveredContribution,response:rows.every(r=>r.covered)?coveredContribution:null,rows};
  }
  function suggestedShocks(model,catalog) {
    if(!model||model.state==='unavailable'||model.state==='stale')return [];
    const map={'CL=F':'wti','DX-Y.NYB':'dxy','^VIX':'vix'};
    return (model.measures||[]).filter(m=>m.valid&&m.newer&&!m.expired&&!m.carried&&map[m.symbol]).map(m=>({factor:map[m.symbol],shock:map[m.symbol]==='vix'?m.change:m.pct,label:m.label,at:m.observed_at,basis:m.comparison?.date})).filter(x=>catalog[x.factor]&&isNum(x.shock)&&Math.abs(x.shock)<=catalog[x.factor].max&&Math.abs(x.shock)>0.001).slice(0,3);
  }
  /* ---------------------------------------------------------------- mount */
  function mount(el, services, context) {
    const doc = el.ownerDocument, Live = services.Live, core = () => services.core();
    let analysis=null,scenarioValid=false,scenarioError='',lastHistory=null;
    let s = parseState(context && context.query), etfs = {}, tray = [], destroyed = false, suspended = false, chart = null, unsub = null, histToken = 0, selectMode = false;
    const loadEtfs = async () => {
      const ids = {...RETAINED_ETFS}; const I = root.SmartOptionsInstruments;
      if (I) for (const a of I.all()) if (a.type === 'ETF') ids[a.symbol] = ids[a.symbol] || a.name;
      const out = {}, list = Object.entries(ids);
      // Bounded concurrency two; published files first, then the shared instrument history service.
      for (let i = 0; i < list.length; i += 2) await Promise.all(list.slice(i, i + 2).map(async ([t, name]) => {
        try { const p = await services.history(t); out[t] = {name, ret: closeReturns(p.bars), source: p.source || 'Published daily closes'}; }
        catch (e) { out[t] = {name, ret: null, source: 'History unavailable: ' + e.message}; }
      }));
      return out;
    };
    const store = (() => { try { return root.localStorage; } catch (e) { return null; } })();
    const BASKET_KEY='so-markets-basket-v1',savedBasket=readJSON(store,BASKET_KEY,null),bv=savedBasket.v;
    const basketValid=savedBasket.ok&&(bv==null||(bv.version===1&&Array.isArray(bv.symbols)&&bv.symbols.length<=6&&new Set(bv.symbols).size===bv.symbols.length&&bv.symbols.every(t=>/^[A-Z][A-Z0-9.\-]{0,9}$/.test(t))&&['equal','mcap','custom'].includes(bv.mode)&&bv.weights&&typeof bv.weights==='object'&&!Array.isArray(bv.weights)&&Object.values(bv.weights).every(v=>isNum(v)&&v>=0)));
    let basketMode=basketValid&&bv?bv.mode:'equal',basketWeights=basketValid&&bv?{...bv.weights}:{},basketOpen=false,basketError=basketValid?'':'Saved basket could not be read; its original bytes are kept unchanged.';
    if(basketValid&&bv)tray=bv.symbols.slice();
    function saveBasket(){if(!basketValid)return;basketError=writeJSON(BASKET_KEY,{version:1,symbols:tray.slice(),mode:basketMode,weights:basketWeights});}
    // Imported metric tables (Positions importer) become optional columns; they are the user's values, never verified data.
    function imported() { const L = root.SmartOptionsLocalData; if (!L || !store) return null; try { const d = L.sharedStore(store).get(); return d && d.metrics && Array.isArray(d.metrics.columns) && d.metrics.rows ? d.metrics : null; } catch (e) { return null; } }
    function allMetrics() { const im = imported(), out = {...METRICS}; if (im) im.columns.slice(0, 8).forEach(c => { out['imp:' + c] = ['Yours: ' + c, x => { const v = im.rows[x.symbol] && im.rows[x.symbol][c]; return isNum(v) ? v : null; }, v => String(+v.toFixed(4))]; }); return out; }
    function columns() { const c = readJSON(store, COLS_KEY, DEFAULT_COLS), M = allMetrics(); return Array.isArray(c.v) ? c.v.filter(k => ['ret', 'mcap', 'pef'].includes(k) || M[k]).slice(0, 10) : DEFAULT_COLS; }
    function savedViews() { const c = readJSON(store, VIEWS_KEY, []); return Array.isArray(c.v) ? c.v.filter(v => v && typeof v.name === 'string' && typeof v.hash === 'string').slice(0, 20) : []; }
    // Writes refuse to replace bytes that could not be read; only public view state is stored.
    function writeJSON(key, v) { const cur = readJSON(store, key, null); if (!cur.ok) return 'Saved data on this device could not be read; it was kept unchanged.'; try { const raw = JSON.stringify(v); store.setItem(key, raw); return store.getItem(key) === raw ? '' : 'Browser did not retain the change.'; } catch (e) { return 'Could not save on this device: ' + e.message; } }
    function assumption(){return scenarioValid&&s.fx?{factor:s.fx,shock:s.shock}:null;}
    async function readyAnalysis(){if(!analysis)analysis=await services.analysis();return analysis;}
    function adoptView(next){
      const unchanged=next.fx===s.fx&&next.shock===s.shock;s={...next,_open:s._open,_range:s._range};
      if(unchanged&&scenarioValid){draw();return;}
      scenarioValid=false;const expected={fx:s.fx,shock:s.shock,colour:s.colour};s.colour='observed';draw();
      if(!expected.fx)return;
      readyAnalysis().then(M=>{M.settings('sensitivity',{factor:expected.fx,shock:expected.shock});if(destroyed||s.fx!==expected.fx||s.shock!==expected.shock)return;scenarioValid=true;scenarioError='';s.colour=expected.colour;persist();draw();}).catch(e=>{if(s.fx===expected.fx&&s.shock===expected.shock){scenarioError=e.message;if(!destroyed)draw();}});
    }
    function suggestions(){return suggestedShocks(services.situation?.(),analysis?.SHOCKS||{});}
    function basketHtml(){
      if(!basketOpen||tray.length<2)return '';
      const universe=buildUniverse(core(),{universe:'all',etfs}),weights={};
      tray.forEach(t=>{weights[t]=basketMode==='custom'?(basketWeights[t]??1):basketMode==='mcap'?universe.find(x=>x.symbol===t)?.mcap:1;});
      const a=assumption(),r=a?basketImpact(tray,weights,t=>services.impact(t,a.factor,a.shock)):null,total=tray.reduce((n,t)=>n+(isNum(weights[t])?weights[t]:0),0);
      const ranked=r?.ok?r.rows.filter(x=>x.weight&&x.covered).sort((a,b)=>Math.abs(b.contribution)-Math.abs(a.contribution)):[],lead=ranked[0];
      return `<section class="mk-basket" aria-label="Hypothetical basket"><h3>Your stress basket</h3><p class="small">Hypothetical allocation · saved only on this device. It does not change your portfolio or send weights to chat.</p><label>Weight by <select data-basket-mode>${[['equal','Equal'],['mcap','Company market value'],['custom','Custom relative weights']].map(([k,v])=>`<option value="${k}"${basketMode===k?' selected':''}>${v}</option>`).join('')}</select></label><div class="tablewrap"><table><thead><tr><th>Asset</th><th>Relative weight</th><th>Allocation</th>${a?'<th>Stress contribution</th>':''}</tr></thead><tbody>${tray.map(t=>{const x=r?.rows?.find(x=>x.symbol===t);return `<tr><td><button class="text" data-mk-t="${esc(t)}">${esc(t)}</button></td><td>${basketMode==='custom'?`<input data-basket-weight="${esc(t)}" aria-label="${esc(t)} relative weight" type="number" min="0" step="any" value="${esc(String(weights[t]))}">`:isNum(weights[t])?(basketMode==='mcap'?cap(weights[t]):String(weights[t])):'No company market value'}</td><td>${isNum(weights[t])&&total>0?(100*weights[t]/total).toFixed(1)+'%':'—'}</td>${a?`<td>${x?.covered?(x.contribution>=0?'+':'−')+Math.abs(x.contribution).toFixed(3)+' pp':'No covered fit'}</td>`:''}</tr>`;}).join('')}</tbody></table></div>${r?.ok?`<p class="mk-basket-result" ${r.complete?`data-basket-response="${r.response}"`:''}>${r.complete?`<b>${pct(r.response)}</b> weighted one-day factor contribution`:`Total withheld: ${(100*r.coverage).toFixed(1)}% of basket weight has a covered fit. Covered component ${pct(r.coveredContribution)}; missing exposures are not treated as zero.`}</p>${lead?`<p>Review <button class="text" data-mk-t="${esc(lead.symbol)}">${esc(lead.symbol)}</button> first: its ${(100*lead.weight).toFixed(1)}% allocation contributes ${lead.contribution>=0?'+':'−'}${Math.abs(lead.contribution).toFixed(3)} percentage points in this stress. Check its fit, valuation and upcoming events before changing exposure.</p>`:''}`:a?`<p role="status">${esc(r.reason)}</p>`:'<p>Apply a what-if above to compare your weighted exposures.</p>'}<p class="small" data-basket-status>${esc(basketError)}</p></section>`;
    }
    let paintingBasket=false;
    function paintBasket(){const n=el.querySelector('.mk-basket-slot');if(n){paintingBasket=true;try{n.innerHTML=basketHtml();}finally{paintingBasket=false;}}}
    async function applyShock(){
      try{const M=await readyAnalysis(),factor=el.querySelector('[data-shock-factor]').value,shock=Number(el.querySelector('[data-shock-value]').value),a=M.settings('sensitivity',{factor,shock});scenarioValid=true;scenarioError='';set({fx:a.factor,shock:a.shock,colour:'scenario'});}
      catch(e){scenarioError=e.message;const n=el.querySelector('[data-shock-status]');if(n)n.textContent=scenarioError;}
    }
    function ideasHtml(){const ideas=suggestions(),factors=analysis?.SHOCKS||{};return `${ideas.length?`<div class="mk-suggestions"><span class="small">Explore a repeat of a measured move:</span>${ideas.map((x,i)=>`<button class="chip" data-shock-idea="${i}" title="Observed ${esc(x.at)} versus ${esc(x.basis)} daily close">${esc(x.label)} ${x.shock>0?'+':''}${x.shock.toFixed(2)} ${esc(factors[x.factor].unit)}</button>`).join('')}<details><summary>Observation times and basis</summary>${ideas.map(x=>`<p>${esc(x.label)}: ${esc(x.at)}, versus ${esc(x.basis)} daily close. Repeating this move is your assumption, not a prediction.</p>`).join('')}</details></div>`:''}`;}
    function shockControls(){
      if(!analysis&&!s.fx)return '';
      const factors=analysis?.SHOCKS||{},a=assumption(),f=factors[s.fx]||factors.us10y_bps;
      return `<section class="mk-shock" aria-label="Market what-if"><div class="mk-shock-inputs"><label>What changes?<select data-shock-factor>${Object.entries(factors).map(([id,x])=>`<option value="${id}"${(s.fx||'us10y_bps')===id?' selected':''}>${esc(x.label)} (${esc(x.unit)})</option>`).join('')}</select></label><label>Hypothetical move<input data-shock-value type="number" step="any" min="${-f?.max}" max="${f?.max}" value="${a?s.shock:f?.default??25}"></label><button type="button" class="btn" data-mk-act="apply-shock">Apply to map</button>${a?`<button type="button" class="btn" data-mk-act="observed">${s.colour==='scenario'?'Show observed returns':'Show modelled contribution'}</button>`:''}</div><div class="mk-suggestions-slot">${ideasHtml()}</div><p class="small" data-shock-status>${esc(scenarioError||a?scenarioError||`${f.label} ${s.shock>0?'+':''}${s.shock} ${f.unit}. ${s.colour==='scenario'?'Colour = conditional one-day factor contribution.':'Colour = observed returns.'} Tile area stays company market value.`:'Choose a move to see which covered companies are more sensitive.')}</p><details><summary>What the estimate means</summary><p>A historical fitted contribution, coefficient × your assumption, with other fitted factors held fixed. It is not a forecast of the entire return. Missing fits stay grey; they are not zero. Open a company for its estimate, observed value, fit period and evidence.</p></details></section>`;
    }
    function paintImpact(pane,x){
      const n=pane.querySelector('.mk-impact');if(!n)return;const a=assumption();n.hidden=!a;if(!a)return;
      const r=services.impact(x.symbol,a.factor,a.shock),f=analysis?.SHOCKS[a.factor];if(r.ok)n.dataset.modelledContribution=String(r.response_pct);else delete n.dataset.modelledContribution;
      n.innerHTML=r.ok?`<h3>What if ${esc(f?.label||a.factor)} moves ${esc(String(a.shock))} ${esc(f?.unit||'')}?</h3><p class="mk-impact-value"><b>${pct(r.response_pct)}</b> modelled factor contribution${isNum(r.baseline_price)?` · ${money(r.baseline_price*r.response_pct/100)} per share`:''}</p><p>Observed: ${pct(r.observed_return_pct)} on ${esc(r.session)}${isNum(r.baseline_price)?` · close ${money(r.baseline_price)}`:''}.</p><details><summary>Why? Model inputs and evidence</summary><p>${esc(String(r.coefficient))} × ${esc(String(r.shock))} = ${pct(r.response_pct)}. Units: ${esc(r.unit)}. Other fitted factors held fixed.</p><p>Window: ${esc(typeof r.window==='object'?JSON.stringify(r.window):r.window)} · n=${r.n} · R²=${esc(String(r.r2))} · t=${esc(String(r.t??'unavailable'))}${isNum(r.t)&&Math.abs(r.t)<2?' · weak sample evidence':''}.</p><p>Published per-instrument OLS on dated daily changes; price impact uses this displayed completed close. Other drivers and changing relationships can overwhelm this contribution.</p><a href="#/company/${esc(x.symbol)}/drivers">Open chart and driver evidence</a></details>`:`<p>${esc(x.symbol)} has no covered fit for this assumption. Observed prices remain unchanged; no numerical response is inferred.</p>`;
    }
    function items() { return buildUniverse(core(), {universe: s.u, etfs, saved: services.saved(), room: services.roomAssets()}); }
    function persist() { const h = encodeState(s); if (root.location.hash !== h) root.history.replaceState(root.history.state, '', h); }
    function set(patch, opts = {}) { Object.assign(s, patch); persist(); draw(opts); }
    function controls(all, shown, lay) {
      const sectors = [...new Set(all.map(x => x.type === 'ETF' ? x.category : x.sector).filter(Boolean))].sort();
      const chips = [s.type !== 'all' && ['type', s.type === 'ETF' ? 'ETFs only' : 'Stocks only'], s.sec && ['sec', s.sec], s.q && ['q', '“' + s.q + '”'], s.sort !== 'area' && ['sort', 'Sort: ' + (SORTS[s.sort] || (METRICS[s.sort] || [s.sort.replace(/^imp:/, 'Yours: ')])[0]) + (s.dir === 'asc' ? ' ↑' : ' ↓')], s.size === 'equal' && ['size', 'Equal tiles'], s.preset && ['preset', 'Preset: ' + PRESETS.find(p => p.id === s.preset).h], s.g !== 'sector' && ['g', 'Group: ' + s.g]].filter(Boolean);
      return `<div class="mk-bar" role="group" aria-label="Market grid controls">
        <label class="mk-f">Universe<select data-mk="u">${Object.entries(UNIVERSES).map(([k, v]) => `<option value="${k}"${s.u === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
        <div class="mk-seg" role="group" aria-label="Period">${Object.keys(PERIODS).map(p => `<button type="button" data-mk-p="${p}" aria-pressed="${s.p === p}">${p}</button>`).join('')}</div>
        <label class="mk-f mk-q">Search<input type="search" data-mk="q" value="${esc(s.q)}" maxlength="40" placeholder="Ticker or name" autocomplete="off"></label>
        <div class="mk-seg" role="group" aria-label="Display">${['grid', 'list'].map(v => `<button type="button" data-mk-v="${v}" aria-pressed="${s.v === v}">${v === 'grid' ? 'Grid' : 'List'}</button>`).join('')}</div>
        <button type="button" class="mk-filters-btn" data-mk-act="shock">What if?</button><button type="button" class="mk-filters-btn" data-mk-act="filters" aria-expanded="${!!s._open}">Filters</button>
        <button type="button" class="mk-select-btn" data-mk-act="select" aria-pressed="${selectMode}">${selectMode ? 'Done selecting' : 'Select assets'}</button></div>
        <div class="mk-more" ${s._open ? '' : 'hidden'}>
          <label class="mk-f">Screen preset<select data-mk="preset"><option value="">None</option>${PRESETS.map(p => `<option value="${p.id}"${s.preset === p.id ? ' selected' : ''}>${esc(p.h)}</option>`).join('')}</select></label>
          <label class="mk-f">Type<select data-mk="type"><option value="all"${s.type === 'all' ? ' selected' : ''}>All</option><option value="EQUITY"${s.type === 'EQUITY' ? ' selected' : ''}>Stocks</option><option value="ETF"${s.type === 'ETF' ? ' selected' : ''}>ETFs</option></select></label>
          <label class="mk-f">Sector / category<select data-mk="sec"><option value="">All</option>${sectors.map(x => `<option${s.sec === x ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
          <label class="mk-f">Group by<select data-mk="g">${[['sector', 'Sector / category'], ['type', 'Security type'], ['none', 'None']].map(([k, v]) => `<option value="${k}"${s.g === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
          <label class="mk-f">Tile size<select data-mk="size"><option value="mcap"${s.size === 'mcap' ? ' selected' : ''}>Market value (stocks only)</option><option value="equal"${s.size === 'equal' ? ' selected' : ''}>Equal</option></select></label>
          <label class="mk-f">Sort<select data-mk="sort">${Object.entries(SORTS).concat(Object.entries(METRICS).map(([k, v]) => [k, v[0]])).map(([k, v]) => `<option value="${k}"${s.sort === k ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
          <label class="mk-f">Direction<select data-mk="dir"><option value="desc"${s.dir === 'desc' ? ' selected' : ''}>High to low</option><option value="asc"${s.dir === 'asc' ? ' selected' : ''}>Low to high</option></select></label>
          <div class="mk-views"><label class="mk-f">Save this view as<input data-mk-viewname maxlength="40" placeholder="e.g. Cheap vol before earnings"></label><button type="button" data-mk-act="saveview">Save view</button>${savedViews().map(v => `<span class="chip"><button type="button" class="text" data-mk-view="${esc(v.name)}">${esc(v.name)}</button> <button type="button" class="text" data-mk-delview="${esc(v.name)}" aria-label="Remove saved view ${esc(v.name)}">×</button></span>`).join('')}</div>
          <p class="mk-colornote dim small">Color: ${s.colour==='scenario'?'Modelled one-day factor contribution':PERIODS[s.p].label+' price return'}, red negative / green positive, saturating at ±${s.colour==='scenario'?3:({'1D': 3, '1W': 6, '1M': 12})[s.p]}%; grey = ${s.colour==='scenario'?'no covered fit':'no value for this date'}.</p></div>
        ${chips.length ? `<p class="mk-chips">${chips.map(([k, t]) => `<button type="button" class="chip" data-mk-clear="${k}" aria-label="Remove filter ${esc(t)}">${esc(t)} ×</button>`).join('')}<button type="button" class="chip chip-clear" data-mk-clear="all">Clear all</button></p>` : ''}
        <p class="mk-count small"><b>${shown.length}</b> of ${all.length} ${esc(UNIVERSES[s.u])} · ${s.colour==='scenario'?'Modelled one-day factor contribution; baseline':' '+esc(PERIODS[s.p].label)+' return to'} <b>${esc(core().asof_session)}</b> ${s.colour==='scenario'?'':`(${esc(PERIODS[s.p].sessions)}, completed sessions)`} · ${shown.filter(x => s.colour==='scenario'?services.impact(x.symbol,s.fx,s.shock).ok:isNum(x.ret[PERIODS[s.p].key])).length} with ${s.colour==='scenario'?'a covered fit':'a value'}. ${esc(lay.note)}</p>${shockControls()}`;
    }
    function crumbs() {
      const parts = [`<button type="button" class="text" data-mk-crumb="root">${esc(UNIVERSES[s.u])}</button>`];
      if (s.sec) parts.push(`<span>${esc(s.sec)}</span> <a class="small" href="#/sector-detail/${encodeURIComponent(s.sec)}" data-sector-facts>Sector facts and contributions</a>`);
      if (s.rel) parts.push(`<span>Related to ${esc(s.rel)}</span>`);
      return parts.length > 1 ? `<nav class="mk-crumbs" aria-label="Grid location">${parts.join(' <span aria-hidden="true">›</span> ')}</nav>` : '';
    }
    const tileLabel = (x, pk) => `${x.symbol}, ${x.name || ''}, ${x.type === 'ETF' ? 'ETF' : 'stock'}, ${s.colour==='scenario'?'Modelled contribution':PERIODS[s.p].label} ${pct(x.ret[pk])}${x.date && x.date !== core().asof_session ? ' as of ' + x.date : ''}`;
    function equalTiles(groups, pk) {
      return groups.map(g => `<section class="mk-group"><h3>${esc(g.key)} <span class="dim small">${g.items.length}</span></h3><div class="mk-tiles">${g.items.slice(0, 600).map(x => `<button type="button" class="mk-tile${tray.includes(x.symbol) ? ' picked' : ''}${s.sel === x.symbol ? ' on' : ''}" data-mk-t="${esc(x.symbol)}" style="background:${colorFor(x.ret[pk], s.colour==='scenario'?'1D':s.p)}" aria-label="${esc(tileLabel(x, pk))}" aria-pressed="${tray.includes(x.symbol)}"><b>${esc(x.symbol)}</b><span>${pct(x.ret[pk])}</span>${x.type === 'ETF' ? '<i>ETF</i>' : ''}</button>`).join('')}</div></section>`).join('');
    }
    function treemap(shown, pk) {
      const W = Math.max(300, Math.min(el.clientWidth || 900, 1100) - (s.sel && (el.clientWidth || 0) > 900 ? 380 : 0)), H = W < 600 ? 360 : 520;
      if (!s.sec&&!s.rel&&s.g==='sector') {
        const ag = sectorAggregates(shown, pk);
        const rects = squarify(ag.map(a => a.mcap), 0, 0, W, H);
        return `<svg class="mk-map" viewBox="0 0 ${W} ${H}" role="group" aria-label="Sector map, area market value">${ag.map((a, i) => { const r = rects[i]; return `<a href="#" data-mk-sec="${esc(a.sec)}" aria-label="${esc(a.sec)}, ${pct(a.pct)}, ${a.covered} of ${a.n} names covered"><rect x="${r.x + 1.5}" y="${r.y + 1.5}" width="${Math.max(0, r.w - 3)}" height="${Math.max(0, r.h - 3)}" rx="4" fill="${colorFor(a.pct, s.colour==='scenario'?'1D':s.p)}"/><text x="${r.x + r.w / 2}" y="${r.y + r.h / 2 - 4}" font-size="${Math.min(16, Math.max(8, r.w / (a.sec.length * 0.6)))}">${esc(a.sec)}</text><text x="${r.x + r.w / 2}" y="${r.y + r.h / 2 + 14}" font-size="${Math.min(15, Math.max(9, r.w / 7))}">${pct(a.pct)}</text><title>${esc(a.sec)} · ${cap(a.mcap)} · covered ${a.covered}/${a.n} (${(100 * a.coverage).toFixed(1)}% of value)</title></a>`; }).join('')}</svg><p class="dim small">Select a sector to zoom into its companies. Sector values are cap-weighted over covered names; partial coverage is shown, not filled.</p>`;
      }
      const xs = sortItems(shown.filter(x=>x.type==='EQUITY'&&isNum(x.mcap)&&x.mcap>0),{...s,sort:'mcap',dir:'desc'},allMetrics()), rects = squarify(xs.map(x => x.mcap), 0, 0, W, H);
      return `<svg class="mk-map" viewBox="0 0 ${W} ${H}" role="group" aria-label="${esc(s.sec)} companies, area market value">${xs.map((x, i) => { const r = rects[i], big = r.w > 34 && r.h > 22; return `<a href="#" data-mk-t="${esc(x.symbol)}" aria-label="${esc(tileLabel(x, pk))}"><rect x="${r.x + 1}" y="${r.y + 1}" width="${Math.max(0, r.w - 2)}" height="${Math.max(0, r.h - 2)}" rx="3" fill="${colorFor(x.ret[pk], s.colour==='scenario'?'1D':s.p)}" class="${tray.includes(x.symbol) ? 'picked' : ''}${s.sel === x.symbol ? ' on' : ''}"/>${big ? `<text x="${r.x + r.w / 2}" y="${r.y + r.h / 2 - 2}" font-size="${Math.min(15, Math.max(8, r.w / 5))}">${esc(x.symbol)}</text><text x="${r.x + r.w / 2}" y="${r.y + r.h / 2 + 12}" font-size="${Math.min(12, Math.max(7, r.w / 7))}">${pct(x.ret[pk])}</text>` : ''}<title>${esc(x.symbol)} ${esc(x.name)} · ${cap(x.mcap)} · ${pct(x.ret[pk])}</title></a>`; }).join('')}</svg>`;
    }
    function fundList(xs,pk) {
      if(!xs.length)return '';
      return `<section class="mk-funds"><h3>Funds</h3><div class="tablewrap"><table class="mk-list"><thead><tr><th>Fund</th><th>${s.colour==='scenario'?'Modelled contribution':esc(PERIODS[s.p].label)+' return'}</th><th>Through</th></tr></thead><tbody>${xs.map(x=>`<tr><td><button class="text" type="button" data-mk-t="${esc(x.symbol)}"><b>${esc(x.symbol)}</b> ${esc(x.name)}</button></td><td>${pct(x.ret[pk])}</td><td>${esc(x.date||'No dated history')}</td></tr>`).join('')}</tbody></table></div></section>`;
    }
    function listView(shown, pk) {
      const th = (k, label) => `<th scope="col"><button type="button" class="text" data-mk-sort="${k}" aria-label="Sort by ${label}">${label}${s.sort === k || (k === 'mcap' && s.sort === 'area') ? (s.dir === 'asc' ? ' ↑' : ' ↓') : ''}</button></th>`;
      const METRICS = allMetrics(), cols = columns(), pre = s.preset && PRESETS.find(p => p.id === s.preset), extra = cols.filter(c => METRICS[c]).concat(pre && METRICS[pre.sort] && !cols.includes(pre.sort) ? [pre.sort] : []);
      const cell = (x, k) => { const v = x.m ? METRICS[k][1](x) : null; return `<td class="n">${isNum(v) ? esc(METRICS[k][2](v)) : '<span class="dim">n/a</span>'}</td>`; };
      return `<details class="mk-cols"><summary>Columns</summary><p class="small">${['ret', 'mcap', 'pef'].concat(Object.keys(METRICS)).map(k => `<label><input type="checkbox" data-mk-col="${k}" ${cols.includes(k) ? 'checked' : ''}> ${esc(k === 'ret' ? 'Period return' : k === 'mcap' ? 'Market cap' : k === 'pef' ? 'Fwd P/E' : METRICS[k][0])}</label>`).join(' ')}</p></details><div class="tablewrap"><table class="mk-list"><thead><tr><th scope="col"><span class="sr">Select</span></th>${th('symbol', 'Symbol')}${th('name', 'Name')}<th scope="col">Type</th><th scope="col">Sector / category</th>${cols.includes('ret') ? th('ret', s.colour==='scenario'?'Modelled contribution':PERIODS[s.p].label + ' return') : ''}${cols.includes('mcap') ? th('mcap', 'Market cap') : ''}${cols.includes('pef') ? th('pef', 'Fwd P/E') : ''}${extra.map(k => th(k, METRICS[k][0])).join('')}</tr></thead><tbody>${shown.slice(0, 600).map(x => `<tr class="${s.sel === x.symbol ? 'on' : ''}"><td><input type="checkbox" data-mk-pick="${esc(x.symbol)}" ${tray.includes(x.symbol) ? 'checked' : ''} aria-label="Select ${esc(x.symbol)} for compare"></td><td><button type="button" class="text" data-mk-t="${esc(x.symbol)}"><b>${esc(x.symbol)}</b></button></td><td>${esc(x.name)}</td><td>${x.type === 'ETF' ? 'ETF' : 'Stock'}</td><td>${esc(x.type === 'ETF' ? x.category : x.sector)}</td>${cols.includes('ret') ? `<td class="n ${isNum(x.ret[pk]) ? (x.ret[pk] >= 0 ? 'up' : 'dn') : ''}">${pct(x.ret[pk])}${x.date && x.date !== core().asof_session ? ` <span class="dim small">${esc(x.date)}</span>` : ''}</td>` : ''}${cols.includes('mcap') ? `<td class="n">${x.type === 'ETF' ? '<span class="dim small">not equity cap</span>' : cap(x.mcap)}</td>` : ''}${cols.includes('pef') ? `<td class="n">${isNum(x.pef) ? x.pef.toFixed(1) : '<span class="dim">n/a</span>'}</td>` : ''}${extra.map(k => cell(x, k)).join('')}</tr>`).join('')}</tbody></table></div>${shown.length > 600 ? `<p class="dim small">First 600 of ${shown.length}; narrow with filters.</p>` : ''}`;
    }
    function trayHtml() {
      return `<div class="mk-tray" ${tray.length ? '' : 'hidden'} role="region" aria-label="Selection"><span><b>${tray.length}</b>/6 selected: ${tray.map(t => `<button type="button" class="chip" data-mk-unpick="${esc(t)}" aria-label="Remove ${esc(t)}">${esc(t)} ×</button>`).join(' ')}</span><span class="mk-tray-act"><button type="button" data-mk-act="compare" ${tray.length ? '' : 'disabled'}>Compare</button><button type="button" data-mk-act="room" ${tray.length ? '' : 'disabled'}>Save as room</button><button type="button" data-mk-act="basket" ${tray.length<2?'disabled':''}>${basketOpen?'Hide basket':'Stress basket'}</button><button type="button" class="text" data-mk-act="untray">Clear</button></span><span class="mk-tray-note small" role="status"></span></div>`;
    }
    function draw(opts = {}) {
      if (destroyed) return;
      const keep = opts.keepFocus && doc.activeElement && el.contains(doc.activeElement) ? {mk: doc.activeElement.dataset.mk, t: doc.activeElement.dataset.mkT, sel: doc.activeElement.selectionStart} : null;
      const all = items(), pk = PERIODS[s.p].key;
      let base = all, relInfo = null;
      if (s.rel) { const it = all.find(x => x.symbol === s.rel) || buildUniverse(core(), {universe: 'all', etfs}).find(x => x.symbol === s.rel); relInfo = relatedFor(it, buildUniverse(core(), {universe: 'all', etfs}), services.rel());
        base = relInfo ? (relInfo.items || []) : []; }
      const shown = sortItems(filterItems(base, s), s.sort === 'area' ? {...s, sort: 'mcap'} : s, allMetrics()), lay = layoutMode(shown, s);
      const displayed=s.colour==='scenario'&&assumption()?sortItems(shown.map(x=>{const r=services.impact(x.symbol,s.fx,s.shock);return {...x,ret:{...x.ret,[pk]:r.ok?r.response_pct:null}};}),s,allMetrics()):shown;
      const equities=displayed.filter(x=>x.type==='EQUITY'&&isNum(x.mcap)&&x.mcap>0),funds=displayed.filter(x=>x.type==='ETF');
      const body = lay.mode==='list'?listView(displayed,pk):lay.mode==='treemap'?treemap(equities,pk)+fundList(funds,pk):lay.mode==='fund-list'?fundList(funds,pk):equalTiles(groupItems(displayed,s.g),pk);
      el.querySelector('.mk-main').innerHTML = `${controls(base, shown, lay)}${crumbs()}${relInfo ? `<p class="mk-basis"><span class="lbl">Related basis</span> ${esc(relInfo.basis)}${relInfo.kind === 'statistical' ? ` <a href="${esc(services.compareHash(['eq:' + s.rel].concat(relInfo.ids.slice(0, 5))))}">Chart these relationships</a>` : ''} <button type="button" class="text" data-mk-clear="rel">Close related</button></p>` : ''}${lay.mode==='treemap'&&s.sort!=='area'?`<div class="mk-ranking"><span class="small">${esc(s.sort==='ret'&&s.colour==='scenario'?'Modelled contribution':SORTS[s.sort]||(METRICS[s.sort]||[s.sort])[0])} ${s.dir==='desc'?'high to low':'low to high'} · map areas stay market value</span>${sortItems(displayed,s,allMetrics()).slice(0,8).map((x,i)=>`<button class="chip" data-mk-t="${esc(x.symbol)}">${i+1}. ${esc(x.symbol)} ${pct(x.ret[pk])}</button>`).join('')}<button class="text" data-mk-v="list">Full sorted list</button></div>`:''}${shown.length ? body : `<p class="mk-empty">No ${esc(UNIVERSES[s.u])} match these filters${s.u === 'saved' ? '; save a name from its inspector first' : s.u === 'room' ? '; save a room first' : ''}. <button type="button" class="text" data-mk-clear="all">Clear filters</button></p>`}${trayHtml()}<div class="mk-basket-slot">${basketHtml()}</div>`;
      if (keep && keep.mk) { const n = el.querySelector(`[data-mk="${keep.mk}"]`); if (n) { n.focus({preventScroll: true}); if (keep.sel != null && n.setSelectionRange) try { n.setSelectionRange(keep.sel, keep.sel); } catch (e) { /* select element */ } } }
      if (keep && keep.t) el.querySelector(`[data-mk-t="${keep.t}"]`)?.focus({preventScroll: true});
      inspector();
    }
    /* --------------------------- inspector */
    function factsHtml(x, r) {
      if (x.type === 'EQUITY' && r) {
        const f = [];
        if (isNum(r.pef)) f.push(`<li><span>Forward P/E</span><b>${r.pef.toFixed(1)}</b><span class="dim small">${isNum(r.pef_sec_med) ? 'sector median ' + r.pef_sec_med.toFixed(1) : 'sector median unavailable'} · provider estimate</span></li>`);
        f.push(`<li><span>Next earnings</span><b>${esc(r.er || 'unavailable')}</b><span class="dim small">${r.er ? esc(r.ert || 'timing unconfirmed') + ' · ' + esc(r.ers || '') : 'calendar coverage incomplete'}</span></li>`);
        return f.slice(0, 2).join('');
      }
      const ret = (etfs[x.symbol] || {}).ret;
      return `<li><span>1-month price return</span><b>${pct(ret && ret.m1)}</b><span class="dim small">${ret && ret.date ? 'to ' + esc(ret.date) + ', price only, not total return' : 'history unavailable'}</span></li><li><span>Fund data</span><b>Not sourced</b><span class="dim small">Holdings, AUM, fees and distributions are not in the published data; nothing is inferred.</span></li>`;
    }
    async function inspector() {
      const pane = el.querySelector('.mk-insp');
      if (!s.sel) { if (!pane.hidden) { pane.hidden = true; pane.innerHTML = ''; el.classList.remove('mk-has-insp'); releaseChart(); } return; }
      const all = buildUniverse(core(), {universe: 'all', etfs}), x = all.find(i => i.symbol === s.sel) || await services.identify(s.sel).catch(() => null);
      if (!x) { pane.hidden = false; pane.innerHTML = `<p role="alert">${esc(s.sel)} could not be verified as a supported US stock or ETF. <button type="button" class="text" data-mk-act="close">Close</button></p>`; return; }
      if (pane.dataset.t === x.symbol && !pane.hidden){paintImpact(pane,x);return;}
      const r = x.type === 'EQUITY' ? services.row(x.symbol) : null, token = ++histToken;
      pane.dataset.t = x.symbol; pane.hidden = false; el.classList.add('mk-has-insp');
      Live && Live.watch('markets', [x.symbol]);
      pane.innerHTML = `<div class="mk-insp-head"><h2 tabindex="-1"><span class="mk-sym">${esc(x.symbol)}</span> <span class="mk-name">${esc(x.name || '')}</span> <span class="tag">${x.type === 'ETF' ? 'ETF' : 'Stock'}</span></h2><button type="button" class="mk-x" data-mk-act="close" aria-label="Close inspector">Close</button></div>
        <p class="mk-quote quote-line"><span class="px"><span data-live="${esc(x.symbol)}" data-live-f="price" data-live-quiet></span> <span class="chg" data-live="${esc(x.symbol)}" data-live-f="chg" data-live-quiet></span></span> <span class="quote-note small" data-live="${esc(x.symbol)}" data-live-f="note"></span></p>
        <p class="dim small mk-completed">${x.type === 'ETF' ? esc(x.category === 'Unclassified' ? 'Fund category not verified' : x.category) : esc(x.sector)} · completed close ${esc(x.date || 'checking history')}${x.type === 'EQUITY' ? ' · market cap ' + cap(x.mcap) : ''}</p>
        <div class="mk-chart-wrap"><label class="mk-trend">Trend overlay<select data-mk-ind><option value="">Price only</option><option value="50"${s.ind==='50'?' selected':''}>50-session average</option><option value="200"${s.ind==='200'?' selected':''}>200-session average</option></select></label><div class="mk-chart-head"><span class="small"><b>Price (USD/share)</b>, daily closes</span><span class="mk-seg" role="group" aria-label="Chart range">${['3M', '6M', '1Y'].map(k => `<button type="button" data-mk-range="${k}" aria-pressed="${(s._range || '6M') === k}">${k}</button>`).join('')}</span></div><div class="mk-chart-legend" aria-label="Chart legend"></div><div class="mk-chart" role="img" aria-label="${esc(x.symbol)} daily closing price chart"></div><p class="mk-chart-note dim small">Loading history…</p></div>
        <ul class="mk-facts">${factsHtml(x, r)}</ul><section class="mk-impact" hidden></section>
        <div class="mk-insp-act"><button type="button" data-mk-act="follow">Follow this trend</button><button type="button" data-mk-act="related">Related</button><button type="button" data-mk-act="add">${tray.includes(x.symbol) ? 'In selection' : 'Add to selection'}</button><button type="button" data-mk-act="vs-spy">${esc(benchLabel(x))}</button><button type="button" data-mk-act="save1">Save to room</button>${x.type === 'EQUITY' && r ? `<a href="#/company/${esc(x.symbol)}">Full dossier</a>` : ''}<a href="#/workspace/strategies?t=${esc(x.symbol)}">Strategies</a><a href="#/workspace/technicals?t=${esc(x.symbol)}">Technicals</a></div>
        <details class="mk-src"><summary>Sources</summary><p class="small">${esc(x.source)}. Live quote (when shown) keeps its own provider time. ${x.type === 'ETF' ? 'Fund identity: ' + esc(x.name) + '; holdings are not sourced.' : 'Fundamentals carry their own report periods in the dossier.'}</p></details><p class="mk-insp-note small" role="status"></p>`;
      paintImpact(pane,x);Live && Live.paint(pane, null); services.paintFocus?.();
      pane.querySelector('h2').focus({preventScroll: !(root.matchMedia && root.matchMedia('(max-width: 899px)').matches)});
      try {
        const p = await services.history(x.symbol);
        if (token !== histToken || destroyed) return;
        if (x.type === 'ETF') {
          const ret = closeReturns(p.bars);
          etfs[x.symbol] = {...etfs[x.symbol], name: x.name, ret, source: p.source || p.basis || 'Published daily closes'};
          pane.querySelector('.mk-completed').textContent = (x.category === 'Unclassified' ? 'Fund category not verified' : x.category) + ' · completed close ' + (ret?.date || 'unavailable');
          pane.querySelector('.mk-facts').innerHTML = factsHtml(x, null);
        }
        lastHistory=p;drawChart(pane, p);
      } catch (e) { if (token === histToken) pane.querySelector('.mk-chart-note').textContent = 'History unavailable: ' + e.message + '. The quote and facts above keep their own dates.'; }
    }
    function releaseChart() { try { chart && chart.remove(); } catch (e) { root.console && console.warn('[markets] chart release failed'); } chart = null; }
    function drawChart(pane, p) {
      releaseChart();
      const box = pane.querySelector('.mk-chart'), LC = root.LightweightCharts, n = {'3M': 63, '6M': 126, '1Y': 252}[s._range || '6M'];
      const bars = (p.bars || []).filter(b => isNum(b[4]) && b[4] > 0).slice(-n);
      const note = pane.querySelector('.mk-chart-note');
      if (!bars.length) { note.textContent = 'No published daily history for this asset.'; return; }
      const first = bars[0], last = bars[bars.length - 1];
      note.textContent = `${first[0]} to ${last[0]} · ${money(first[4])} → ${money(last[4])} (${pct(100 * (last[4] / first[4] - 1))} price return, not total return) · ${p.basis || 'unadjusted provider closes'}`;
      if (!LC || !box) return;
      const dark = root.document.documentElement.dataset.theme === 'dark' || (!root.document.documentElement.dataset.theme && root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)').matches);
      chart = LC.createChart(box, {height: 220, layout: {background: {color: 'transparent'}, textColor: dark ? '#cfd6e0' : '#2b3340'}, grid: {vertLines: {visible: false}, horzLines: {color: dark ? '#2a3240' : '#e7eaf0'}}, rightPriceScale: {borderVisible: false}, timeScale: {borderVisible: false}, handleScroll: false, handleScale: false, autoSize: true});
      const line = chart.addLineSeries ? chart.addLineSeries({title:pane.dataset.t,color: dark ? '#7fb2ff' : '#1f5fbf', lineWidth: 2, priceFormat: {type: 'price', precision: 2, minMove: 0.01}}) : chart.addSeries(LC.LineSeries, {color: '#1f5fbf', lineWidth: 2});
      line.setData(bars.map(b => ({time: b[0], value: b[4]})));
      const legend=pane.querySelector('.mk-chart-legend');if(legend)legend.innerHTML=`<span><i style="background:${dark?'#7fb2ff':'#1f5fbf'}"></i>${esc(pane.dataset.t)} close (USD/share)</span>${s.ind?`<span><i style="background:#ba8a38"></i>${esc(s.ind)}-session average (USD/share)</span>`:''}`;
      if(s.ind){const values=services.sma(p.bars.filter(b=>isNum(b[4])&&b[4]>0).map(b=>[b[0],b[4]]),Number(s.ind)),since=bars[0][0],avg=chart.addLineSeries({title:'SMA'+s.ind,color:'#ba8a38',lineWidth:2,priceLineVisible:false,lastValueVisible:false});avg.setData(values.filter(v=>v[0]>=since).map(v=>({time:v[0],value:v[1]})));}
      chart.timeScale().fitContent();
    }
    /* --------------------------- events */
    function toggleTray(t) {
      const i = tray.indexOf(t); const note = el.querySelector('.mk-tray-note');
      if (i >= 0) tray.splice(i, 1); else if (tray.length >= 6) { if (note) note.textContent = 'Compare holds up to six series. Remove one first.'; return false; } else tray.push(t);
      saveBasket();return true;
    }
    function onClick(e) {
      const q = sel => e.target.closest(sel);
      let b;
      if((b=q('[data-shock-idea]'))){const x=suggestions()[Number(b.dataset.shockIdea)];if(x){const a=analysis.settings('sensitivity',{factor:x.factor,shock:x.shock});scenarioValid=true;scenarioError='';set({fx:a.factor,shock:a.shock,colour:'scenario'});}return;}
      if ((b = q('[data-mk-p]'))) return set({p: b.dataset.mkP}, {keepFocus: true}), focusSoon(`[data-mk-p="${b.dataset.mkP}"]`);
      if ((b = q('[data-mk-v]'))) return set({v: b.dataset.mkV}), focusSoon(`[data-mk-v="${b.dataset.mkV}"]`);
      if ((b = q('[data-mk-sort]'))) { const k = b.dataset.mkSort; set({sort: k, dir: s.sort === k && s.dir === 'desc' ? 'asc' : 'desc'}); return focusSoon(`[data-mk-sort="${k}"]`); }
      if ((b = q('[data-mk-clear]'))) { const k = b.dataset.mkClear; if (k === 'all') set({type: 'all', sec: '', q: '', sort: 'area', dir: 'desc', size: 'mcap', g: 'sector', rel: '', preset: ''}); else set({[k]: DEFAULT[k]}); return; }
      if ((b = q('[data-mk-crumb]'))) return set({sec: '', rel: ''});
      if ((b = q('[data-mk-sec]'))) { e.preventDefault(); return set({sec: b.dataset.mkSec}); }
      if ((b = q('[data-mk-view]'))) { const v = savedViews().find(x => x.name === b.dataset.mkView); if (v) { adoptView(parseState(v.hash.replace(/^#\/markets\??/, '')));persist(); } return; }
      if ((b = q('[data-mk-delview]'))) { writeJSON(VIEWS_KEY, savedViews().filter(x => x.name !== b.dataset.mkDelview)); return draw(); }
      if ((b = q('[data-mk-unpick]'))) { toggleTray(b.dataset.mkUnpick); return draw(); }
      if ((b = q('[data-mk-range]'))) { s._range = b.dataset.mkRange; el.querySelectorAll('[data-mk-range]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); services.history(s.sel).then(p => drawChart(el.querySelector('.mk-insp'), p)).catch(() => {}); return; }
      if ((b = q('[data-mk-t]'))) {
        e.preventDefault(); const t = b.dataset.mkT;
        if (selectMode) { toggleTray(t); draw(); return focusSoon(`[data-mk-t="${t}"]`); }
        s.sel = t; persist(); el.querySelector('.mk-insp').dataset.t = ''; s._origin = t; draw(); return;
      }
      if ((b = q('[data-mk-act]'))) {
        if (b.dataset.mkAct === 'follow') return services.followTrend(s.sel);
        const a = b.dataset.mkAct, note = el.querySelector('.mk-insp-note');
        if(a==='shock'){readyAnalysis().then(()=>{if(!destroyed)draw();}).catch(e=>{scenarioError=e.message;el.querySelector('.mk-count').textContent='What-if controls could not load: '+e.message;});return;}
        if(a==='basket'){basketOpen=!basketOpen;paintBasket();b.textContent=basketOpen?'Hide basket':'Stress basket';return;}
        if(a==='apply-shock'){applyShock();return;}
        if(a==='observed'){set({colour:s.colour==='scenario'?'observed':'scenario'});return;}
        if (a === 'filters') { s._open = !s._open; draw(); return focusSoon('[data-mk-act="filters"]'); }
        if (a === 'select') { selectMode = !selectMode; draw(); return focusSoon('[data-mk-act="select"]'); }
        if (a === 'close') return closeInspector();
        if (a === 'related') { set({rel: s.sel}); return; }
        if (a === 'add') { if (toggleTray(s.sel) !== false) { b.textContent = tray.includes(s.sel) ? 'In selection' : 'Add to selection'; el.querySelector('.mk-tray').outerHTML = trayHtml();paintBasket(); } return; }
        if (a === 'untray') { tray = [];saveBasket(); return draw(); }
        if (a === 'saveview') { const name = String(el.querySelector('[data-mk-viewname]').value || '').trim().slice(0, 40); if (!name) { el.querySelector('[data-mk-viewname]').focus(); return; } const pub = {...s}; delete pub._open; delete pub._range; delete pub.sel; const err = writeJSON(VIEWS_KEY, [{name, hash: encodeState(pub)}].concat(savedViews().filter(v => v.name !== name)).slice(0, 20)); draw(); const n = el.querySelector('.mk-count'); if (n && err) n.textContent = err; return focusSoon('[data-mk-act="saveview"]'); }
        if (a === 'vs-spy') { const x = buildUniverse(core(), {universe: 'all', etfs}).find(i => i.symbol === s.sel) || {symbol: s.sel, type: 'ETF'}; return services.navigate(services.compareHash(benchIds(x))); }
        if (a === 'compare') return services.navigate(services.compareHash(tray.map(t => 'eq:' + t)));
        if (a === 'room' || a === 'save1') {
          const ids = a === 'room' ? tray.slice() : [s.sel], res = services.saveRoom(ids, {range: s._range || '6M',assumption:assumption()}), out = a === 'room' ? el.querySelector('.mk-tray-note') : note;
          if (out) out.innerHTML = res.ok ? `Saved room “${esc(res.name)}”. <a href="#/room">Open saved rooms</a>` : esc(res.error);
          return;
        }
      }
    }
    function focusSoon(sel) { const n = el.querySelector(sel); n && n.focus({preventScroll: true}); }
    function closeInspector() { const back = s.sel; s.sel = ''; persist(); inspector(); services.paintFocus?.(); Live && Live.watch('markets', []); const t = el.querySelector(`[data-mk-t="${back}"]`); t && t.focus({preventScroll: true}); }
    function onChange(e) {
      if(paintingBasket)return;
      if(e.target.matches('[data-basket-mode]')){basketMode=e.target.value;if(basketMode==='custom')tray.forEach(t=>basketWeights[t]??=1);saveBasket();paintBasket();return;}
      if(e.target.matches('[data-basket-weight]')){const v=e.target.value.trim(),n=Number(v);if(!v||!isNum(n)||n<0){e.target.setCustomValidity('Enter a finite, non-negative relative weight.');e.target.reportValidity();const out=el.querySelector('[data-basket-status]');if(out)out.textContent='Weight not applied. Enter a finite non-negative value; the last valid allocation is still shown.';return;}e.target.setCustomValidity('');basketWeights[e.target.dataset.basketWeight]=n;saveBasket();paintBasket();return;}
      if(e.target.matches('[data-mk-ind]')){s.ind=e.target.value;persist();if(lastHistory)drawChart(el.querySelector('.mk-insp'),lastHistory);return;}
      if(e.target.matches('[data-shock-factor]')){const f=analysis?.SHOCKS[e.target.value];if(f){const n=el.querySelector('[data-shock-value]');n.value=f.default;n.min=-f.max;n.max=f.max;}return;}
      const col = e.target.dataset.mkCol; if (col) { const cur = columns(), next = e.target.checked ? [...new Set(cur.concat(col))] : cur.filter(c => c !== col); writeJSON(COLS_KEY, next); draw(); return focusSoon(`[data-mk-col="${col}"]`); }
      if (e.target.dataset.mk === 'preset') { const pr = PRESETS.find(p => p.id === e.target.value); return set(pr ? {preset: pr.id, sort: pr.sort, dir: pr.dir} : {preset: '', sort: 'area', dir: 'desc'}, {keepFocus: true}); }
      const k = e.target.dataset.mk; if (!k) { const pk = e.target.dataset.mkPick; if (pk) { if (toggleTray(pk) === false) e.target.checked = false; el.querySelector('.mk-tray').outerHTML = trayHtml();paintBasket(); } return; }
      if (k === 'u') return set({u: e.target.value, sec: '', rel: ''});
      if (k !== 'q') set({[k]: e.target.value}, {keepFocus: true});
    }
    let qTimer = null;
    function onInput(e) { if (e.target.dataset.mk !== 'q') return; clearTimeout(qTimer); const v = e.target.value; qTimer = setTimeout(() => set({q: v.slice(0, 40)}, {keepFocus: true}), 160); }
    function onKey(e) {
      if (e.key !== 'Escape' || destroyed || suspended || !el.isConnected) return;
      const sh = doc.getElementById('sheet'); if ((sh && !sh.hidden) || doc.documentElement.classList.contains('cp-open')) return;
      if (e.target.closest && e.target.closest('#gsearch,#gs-hits,#cp-panel')) return;
      if (s.sel) { e.stopPropagation(); e.preventDefault(); closeInspector(); return; }
      if (s.rel) { e.stopPropagation(); e.preventDefault(); set({rel: ''}); return; }
      if (s.sec) { e.stopPropagation(); e.preventDefault(); set({sec: ''}); focusSoon('[data-mk-crumb]') || focusSoon('[data-mk-sec]'); }
    }
    el.innerHTML = '<div class="mk"><div class="mk-main"></div><aside class="mk-insp" hidden aria-label="Instrument inspector"></aside></div>';
    el.addEventListener('click', onClick); el.addEventListener('change', onChange); el.addEventListener('input', onInput); doc.addEventListener('keydown', onKey, true);
    if(s.fx)adoptView({...s});else draw();
    if (s.u !== 'sp') loadEtfs().then(x => { etfs = x; if (!destroyed) draw(); });
    const ensureEtfs = () => { if (!Object.keys(etfs).length) loadEtfs().then(x => { etfs = x; if (!destroyed) draw(); }); };
    const origSet = set; set = (patch, o) => { origSet(patch, o); if (patch.u && patch.u !== 'sp') ensureEtfs(); };
    // Quotes patch the inspector price only; tiles show completed-session returns and are not reordered.
    unsub = Live && Live.subscribe ? Live.subscribe(() => { if (!suspended && !destroyed && s.sel) Live.paint(el.querySelector('.mk-insp'), null); }) : null;
    return {
      refreshSituation(){const n=el.querySelector('.mk-suggestions-slot');if(n)n.innerHTML=ideasHtml();},
      updateContext(ctx) { if (ctx && ctx.query != null) adoptView(parseState(ctx.query)); },
      suspend() { suspended = true; Live && Live.watch('markets', []); },
      resume() { suspended = false; if (s.sel) Live && Live.watch('markets', [s.sel]); draw(); },
      destroy() { destroyed = true; releaseChart(); clearTimeout(qTimer); unsub && unsub(); Live && Live.watch('markets', []); el.removeEventListener('click', onClick); el.removeEventListener('change', onChange); el.removeEventListener('input', onInput); doc.removeEventListener('keydown', onKey, true); },
      state: () => ({...s, tray: tray.slice()})
    };
  }
  return {PRESETS, METRICS, benchIds, benchLabel, PERIODS, UNIVERSES, SORTS, DEFAULT, RETAINED_ETFS, parseState, encodeState, closeReturns, buildUniverse, filterItems, sortItems, groupItems, layoutMode, sectorAggregates, relatedFor, colorFor, basketImpact, suggestedShocks, mount};
});
