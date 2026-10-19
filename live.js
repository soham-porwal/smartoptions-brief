/* SmartOptions Brief: live quote engine (window.SO2.Live). Lane UI1.
   One place owns prices in the browser. It polls the Worker /quotes fast path for the tickers on screen
   (batched, budgeted, paused when the tab is hidden or the market is closed), falls back to data/quotes.json,
   keeps the newest observation per symbol, and tells subscribers which symbols changed so every
   quote-dependent number recomputes at once. Freshness words follow docs/BRIEF-CONTRACT.md:
   live (real-time feed, observation at most 1 minute old), delayed 15m, closed, stale, missing.
   Pure helpers are exported for node tests; the DOM part runs only in a browser. */
'use strict';
(function (root, factory) {
  const L = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = L;
  // other modules treat window.SO2 as "the research desk has loaded", so never create it here; app.js attaches SO2.Live
  if (root.SO2) root.SO2.Live = L;
  root.SmartOptionsLive = L;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {

  const ALLOWED_ORIGINS = ['https://soham-porwal.github.io', 'https://samsej.github.io'];   // Worker allow-list (chat-proxy/worker.js)
  const MAX_BATCH = 12;
  const STREAM_MAX = 100;         // bounded stream subscription (see streamTargets)            // Worker accepts 1 to 12 symbols per request
  const OPEN_POLL_MS = 120000;     // Selected quotes refresh every two minutes, plus navigation and wake.
  const FILE_POLL_MS = 120000;
  const SYMBOL = /^[A-Z][A-Z0-9.-]{0,14}$/;
  const isNum = v => typeof v === 'number' && isFinite(v);

  /* ------------------------------------------------------------ pure helpers */
  // New York regular session, weekdays 9:30-16:00. Exchange holidays are not modelled; old timestamps stay visible.
  // Memoized: Intl formatting dominated quote-burst cost on phones (measured, perf-browser.cjs).
  const marketClockMemo = new Map();
  function marketClock(nowMs) { const k = Math.floor(nowMs / 60000); if (marketClockMemo.has(k)) return marketClockMemo.get(k); if (marketClockMemo.size > 4000) marketClockMemo.clear(); const v = marketClockRaw(nowMs); marketClockMemo.set(k, v); return v; }
  function marketClockRaw(nowMs) {
    const parts = {};
    try {
      new Intl.DateTimeFormat('en-US', {timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false})
        .formatToParts(new Date(nowMs)).forEach(p => { parts[p.type] = p.value; });
    } catch (e) { return {open: false, known: false}; }
    const mins = (+parts.hour % 24) * 60 + (+parts.minute);
    const weekday = !['Sat', 'Sun'].includes(parts.weekday);
    return {open: weekday && mins >= 570 && mins < 960, known: true, weekday, mins};
  }
  function obsMs(q) { const t = Date.parse(q && (q.asof_utc || q.ts) || ''); return isFinite(t) ? t : null; }
  // "as of 3:42 PM ET"; adds the date when the observation is not from today in New York
  // Memoized: Intl formatting dominated quote-burst cost on phones (measured, perf-browser.cjs).
  const etLabelMemo = new Map();
  function etLabel(iso, nowMs) { const k = iso + '|' + Math.floor(nowMs / 60000); if (etLabelMemo.has(k)) return etLabelMemo.get(k); if (etLabelMemo.size > 4000) etLabelMemo.clear(); const v = etLabelRaw(iso, nowMs); etLabelMemo.set(k, v); return v; }
  function etLabelRaw(iso, nowMs) {
    const t = Date.parse(iso || '');
    if (!isFinite(t)) return 'time not available';
    try {
      const day = x => new Date(x).toLocaleDateString('en-CA', {timeZone: 'America/New_York'});
      const hm = new Date(t).toLocaleTimeString('en-US', {timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit'});
      if (nowMs != null && day(t) !== day(nowMs)) return 'as of ' + new Date(t).toLocaleDateString('en-US', {timeZone: 'America/New_York', month: 'short', day: 'numeric'}) + ', ' + hm + ' ET';
      return 'as of ' + hm + ' ET';
    } catch (e) { return 'as of ' + new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; }
  }
  // Freshness of one quote. Never "live" for a delayed provider, never "live" for an old observation.
  function classify(q, nowMs, clock) {
    if (!q || !isNum(q.price) || q.price <= 0) return {word: 'missing', label: 'Not available', note: (q && (q.reason || q.error)) || 'No price observation'};
    const t = obsMs(q);
    if (t == null || t > nowMs + 60000) return {word: 'stale', label: 'stale', note: 'Observation time not available'};
    const ageMin = Math.max(0, (nowMs - t) / 60000);
    const delay = isNum(q.delay_minutes) ? q.delay_minutes : /delay/i.test(q.provider || '') ? 15 : null;
    clock = clock || marketClock(nowMs);
    if (!clock.open) {
      // the session is over: the last print is the closing reference until it is older than a long weekend
      return ageMin <= 80 * 60 ? {word: 'closed', label: 'closed', ageMin} : {word: 'stale', label: 'stale', ageMin};
    }
    if (delay === 0 && ageMin <= 1) return {word: 'live', label: 'live', ageMin};
    if (delay > 0 && ageMin <= delay + 5) return {word: 'delayed', label: 'delayed ' + delay + 'm', ageMin};
    return {word: 'stale', label: 'stale', ageMin};
  }
  // Yahoo PricingData protobuf (yfinance 1.7.0 schema). No browser credential.
  function decodeYahooMessage(envelope) {
    if(typeof envelope!=='string'||envelope.length>32768)throw new Error('Invalid stream envelope');
    const raw=JSON.parse(envelope),b64=raw.message;
    if(typeof b64!=='string'||b64.length>16384||!/^[-A-Za-z0-9+/=]+$/.test(b64))throw new Error('Invalid stream payload');
    const bytes=Uint8Array.from(atob(b64),c=>c.charCodeAt(0)),view=new DataView(bytes.buffer);let pos=0;const out={};
    const varint=()=>{let n=0n,shift=0n;for(let i=0;i<10;i++){if(pos>=bytes.length)throw new Error('Truncated varint');const b=bytes[pos++];n|=BigInt(b&127)<<shift;if(!(b&128))return n;shift+=7n;}throw new Error('Oversized varint');};
    const names={1:'id',2:'price',3:'time',4:'currency',5:'exchange',7:'market_hours',8:'change_percent',9:'day_volume',10:'day_high',11:'day_low',12:'change',16:'previous_close',22:'last_size'};
    while(pos<bytes.length){const key=Number(varint()),field=key>>>3,wire=key&7;if(!field)throw new Error('Invalid field');let v;
      if(wire===0){const n=varint();v=Number([3,9,22].includes(field)?(n>>1n)^(-(n&1n)):n);if(!Number.isSafeInteger(v))throw new Error('Unsafe integer');}
      else if(wire===5){if(pos+4>bytes.length)throw new Error('Truncated float');v=view.getFloat32(pos,true);pos+=4;}
      else if(wire===1){if(pos+8>bytes.length)throw new Error('Truncated double');v=view.getFloat64(pos,true);pos+=8;}
      else if(wire===2){const len=Number(varint());if(len<0||len>4096||pos+len>bytes.length)throw new Error('Invalid string length');v=new TextDecoder().decode(bytes.slice(pos,pos+len));pos+=len;}
      else throw new Error('Unsupported wire type');
      if(names[field])out[names[field]]=v;
    }
    return out;
  }
  // Memoized: Intl formatting dominated quote-burst cost on phones (measured, perf-browser.cjs).
  const quoteSessionMemo = new Map();
  function quoteSession(ms) { const k = ms; if (quoteSessionMemo.has(k)) return quoteSessionMemo.get(k); if (quoteSessionMemo.size > 4000) quoteSessionMemo.clear(); const v = quoteSessionRaw(ms); quoteSessionMemo.set(k, v); return v; }
  function quoteSessionRaw(ms) {
    const p = {};
    new Intl.DateTimeFormat('en-US', {timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(ms)).forEach(x => {p[x.type]=x.value;});
    return p.year+'-'+p.month+'-'+p.day;
  }
  function yahooQuote(event, previous, receivedMs, regularReference) {
    receivedMs=receivedMs==null?Date.now():receivedMs;
    if(!event||!SYMBOL.test(event.id||'')||!isNum(event.price)||event.price<=0||!Number.isSafeInteger(event.time)||event.time<=0||event.time>receivedMs)return null;
    if(previous&&obsMs(previous)>event.time)return null;
    const ts=new Date(event.time).toISOString(),received=new Date(receivedMs).toISOString();
    const price=Number(event.price.toFixed(6));
    const session=quoteSession(event.time),extended=event.market_hours===2||event.market_hours===3;
    const providerPrior=isNum(event.previous_close)&&event.previous_close>0?event.previous_close:isNum(event.change)&&price-event.change>0?price-event.change:isNum(event.change_percent)&&event.change_percent>-100?price/(1+event.change_percent/100):null;
    // Yahoo post-market change is relative to today's close. Keep that separately;
    // daily analytics must retain the previous regular-session close used by Finnhub.
    const reference=[previous,regularReference].find(q=>q&&obsMs(q)!=null&&quoteSession(obsMs(q))===session&&isNum(q.prior_close)&&q.prior_close>0&&(q.return_basis==='previous_regular_session_close'||(![2,3].includes(q.market_hours)&&q.source_transport!=='websocket')));
    const prior=extended?(reference?.prior_close||null):providerPrior;
    const chg=prior?100*(price/prior-1):!extended&&isNum(event.change_percent)?event.change_percent:null;
    return {price,chg_pct:chg,change_pct:chg,prior_close:prior,prior_close_date:extended?reference?.prior_close_date||null:null,
      return_basis:chg==null?null:'previous_regular_session_close',return_session:session,
      session_change_pct:isNum(event.change_percent)?event.change_percent:providerPrior?100*(price/providerPrior-1):null,
      session_reference_price:providerPrior,prior_close_note:extended?'Daily return retains a same-session regular quote reference; Yahoo extended-session change is stored separately.':'Yahoo regular-session change reference; previous-close session date is not supplied.',
      day_volume:Number.isSafeInteger(event.day_volume)&&event.day_volume>=0?event.day_volume:null,
      market_hours:Number.isSafeInteger(event.market_hours)?event.market_hours:null,asof_utc:ts,ts,checked_at:received,received_at:received,provider:'Yahoo Finance stream',source_url:'https://finance.yahoo.com/quote/'+encodeURIComponent(event.id),source_transport:'websocket',delay_minutes:0,status:'ok',exchange:event.exchange||null,currency:event.currency||'USD'};
  }
  // Newest observation wins per symbol; an older or equal observation never replaces a newer one.
  function merge(prev, incoming, source) {
    const out = Object.assign({}, prev || {}), changed = [];
    Object.entries(incoming || {}).forEach(([t, q]) => {
      if (!q || !isNum(q.price) || q.price <= 0) return;
      const cur = out[t], tn = obsMs(q), tc = obsMs(cur);
      if (tn == null || tn > now() + 60000) return;   // a future-dated observation never enters the engine (any source)
      if(cur && tc===tn && cur.price===q.price){const nc=Date.parse(q.checked_at||q.retrieved_at||''),pc=Date.parse(cur.checked_at||cur.retrieved_at||'');if(!isFinite(nc)||(isFinite(pc)&&nc<=pc))return;}
      if (cur && tc != null && tc > tn) return;
      out[t] = Object.assign({}, q, {_src: source});
      if (!cur || cur.price !== q.price || tc !== tn || (q.checked_at || q.retrieved_at) !== (cur.checked_at || cur.retrieved_at)) changed.push(t);
    });
    return {quotes: out, changed};
  }
  // Batches for the Worker: priority order kept, at most 12 per request; rotate through the rest across polls.
  function batches(list, size) {
    const xs = [...new Set((list || []).map(s => String(s || '').toUpperCase()).filter(s => SYMBOL.test(s)))];
    const out = [];
    for (let i = 0; i < xs.length; i += size || MAX_BATCH) out.push(xs.slice(i, i + (size || MAX_BATCH)));
    return out;
  }
  // Quote-dependent numbers for one company row (core.json) at the current price.
  function derive(row, q) {
    row = row || {};
    const price = q?.current_usable===false ? null : q && isNum(q.price) && q.price > 0 ? q.price : isNum(row.px) ? row.px : null;
    const out = {price, chg_pct: q && isNum(q.chg_pct) ? q.chg_pct : q && isNum(q.change_pct) ? q.change_pct : !q && isNum(row.d1) ? row.d1 : null};
    if (price == null) return out;
    const base = isNum(row.px) && row.px > 0 ? row.px : null;
    // P/E scales with price at fixed earnings: eps = close / P/E at the close
    out.pe = base && isNum(row.pe) && row.pe > 0 ? row.pe * price / base : null;
    out.pef = base && isNum(row.pef) && row.pef > 0 ? row.pef * price / base : null;
    if (isNum(row.lo) && isNum(row.hi) && row.hi > row.lo) {
      const lo = Math.min(row.lo, price), hi = Math.max(row.hi, price);
      out.range_pct = 100 * (price - lo) / (hi - lo);
      out.from_hi_pct = 100 * (price / hi - 1);
      out.from_lo_pct = 100 * (price / lo - 1);
      out.new_high = price > row.hi; out.new_low = price < row.lo;
    }
    out.tgt_up_pct = isNum(row.tgt) && row.tgt > 0 ? 100 * (row.tgt / price - 1) : null;
    out.since_close_pct = base ? 100 * (price / base - 1) : null;
    return out;
  }
  function currentRow(row, quote) {
    if (!row) return row;
    const q = quote === undefined ? get(row.t) : quote;
    if(q&&(predatesRow(row,q)||q.current_usable===false||['missing','stale','blocked'].includes(feedSummary({[row.t]:q},[row.t],Date.now(),ST.worker.errors).items[0].state)))return Object.assign({},row,{px:null,d1:null,pe:null,pef:null,peg:null,mcap:null,up:null,pef_sec_rel:null,quote_asof:q.asof_utc||q.ts});
    if (!q || !isNum(q.price) || q.price <= 0) return row;
    const d = derive(row, q), k = isNum(row.px) && row.px > 0 ? q.price / row.px : null;
    return Object.assign({}, row, {px:d.price, d1:d.chg_pct, pe:d.pe, pef:d.pef,
      peg:k && isNum(row.peg) && row.peg > 0 ? row.peg*k : null,
      mcap:k && isNum(row.mcap) ? row.mcap*k : null, up:d.tgt_up_pct,
      pef_sec_rel:isNum(d.pef) && row.pef_sec_med > 0 ? d.pef/row.pef_sec_med : null,
      quote_asof:q.asof_utc || q.ts, quote_checked_at:q.checked_at || q.retrieved_at});
  }
  function currentBrief(brief, quotes, nowMs) {
    if (!brief) return brief;
    const q = quotes && (quotes.quotes || quotes).SPY;
    const ms = brief.macro && brief.macro.price_trend && brief.macro.price_trend.metrics || [];
    const avg = label => (ms.find(m => m.label === label) || {}).value;
    const a50=avg('SPY 50-session average'), a200=avg('SPY 200-session average');
    const state=feedSummary({SPY:q},['SPY'],nowMs==null?Date.now():nowMs,ST.worker.errors).items[0].state;
    if(!q||!isNum(q.price)||q.price<=0||predatesRow({pxd:brief.asof_session},q)||['missing','stale','blocked'].includes(state)){
      const b=JSON.parse(JSON.stringify(brief));b.macro ||= {};b.pulse ||= {};
      const line='SPY price comparison is unavailable.';
      b.macro.price_trend={status:'unavailable',line,metrics:ms.filter(m=>!/SPY close|previous-session change/.test(m.label||''))};b.pulse.headline=line;b.pulse.status='unavailable';
      for(const k of ['supports','challenges','changed'])b.pulse[k]=(b.pulse[k]||[]).filter(x=>!(x.metrics||[]).some(m=>/SPY (close|latest price|50-session|200-session)/.test(m.label||'')));
      return b;
    }
    if(!isNum(a50)||!isNum(a200))return brief;
    const b=JSON.parse(JSON.stringify(brief)), v50=100*(q.price/a50-1), v200=100*(q.price/a200-1);
    const status=v50>=0&&v200>=0?'supportive':v50<0&&v200<0?'adverse':'mixed';
    const where=status==='supportive'?'above both averages':status==='adverse'?'below both averages':v50<0?'below its 50-session but above its 200-session average':'above its 50-session but below its 200-session average';
    const fr=classify(q,nowMs == null ? Date.now() : nowMs).label;
    const line=`SPY at $${fmtPx(q.price)} is ${where}: ${fmtPct(v50,2)} versus its 50-session average and ${fmtPct(v200,2)} versus its 200-session average.`;
    const metrics=ms.filter(m=>!/SPY close|previous-session change/.test(m.label||''));
    metrics.unshift({label:'SPY latest price',value:q.price,unit:'USD/share',period:q.asof_utc||q.ts,asof:q.asof_utc||q.ts,source:q.provider,source_url:q.source_url,note:'Provider trade time; averages retain their historical session dates.'});
    metrics.push({label:'SPY versus 50-session average',value:v50,unit:'%',asof:q.asof_utc||q.ts,period:q.asof_utc||q.ts,source:q.provider},{label:'SPY versus 200-session average',value:v200,unit:'%',asof:q.asof_utc||q.ts,period:q.asof_utc||q.ts,source:q.provider});
    b.macro.price_trend={status,line,metrics};
    const isPrice=x=>(x.metrics||[]).some(m=>/SPY (close|latest price|50-session|200-session)/.test(m.label||''));
    for(const key of ['supports','challenges','changed']) b.pulse[key]=(b.pulse[key]||[]).filter(x=>!isPrice(x));
    b.pulse[status==='supportive'?'supports':'challenges'].unshift({line,text:line,metrics,status});
    b.pulse.headline=line;b.pulse.status=status;b.quote_asof=q.asof_utc||q.ts;
    return b;
  }
  function currentContext(t, quotes, modelAsOf) {
    const qs=quotes&&(quotes.quotes||quotes)||{},q=qs[t],spy=qs.SPY;
    if(!q||!isNum(q.price)||predatesRow(coreRow(t),q)||q.current_usable===false||['stale','missing','blocked'].includes(feedSummary(qs,[t],Date.now(),ST.worker.errors).items[0].state))return 'Current price comparison is unavailable.';
    const change=isNum(q.chg_pct)?q.chg_pct:q.change_pct,market=spy&&(isNum(spy.chg_pct)?spy.chg_pct:spy.change_pct);
    const comparable=spy&&spy.current_usable!==false&&obsMs(spy)!=null&&obsMs(q)!=null&&quoteSession(obsMs(spy))===quoteSession(obsMs(q))&&!['stale','missing','blocked'].includes(feedSummary(qs,['SPY'],Date.now(),ST.worker.errors).items[0].state);
    let line=`${t} is $${fmtPx(q.price)}`;
    if(isNum(change)){line+=`, ${fmtPct(change)} versus its previous close`;if(t!=='SPY'&&isNum(market)&&comparable){const gap=change-market;line+=` and ${Math.abs(gap).toFixed(2)} percentage points ${gap>=0?'ahead of':'behind'} SPY`;}}
    return line+'.';
  }
  // Header truth: worst of the price feed and every dataset in refresh-status / brief health.
  // closed outranks live so one closed name never lets the summary say live
  const RANK = {live: 0, fresh: 0, ok: 0, closed: 0.5, delayed: 1, warn: 1, stale: 2, fail: 3, missing: 3};
  function worstOf(words) {
    const xs = (words || []).map(x => String(x).toLowerCase());
    return xs.length ? xs.reduce((w, x) => (RANK[x] ?? 3) > (RANK[w] ?? 3) ? x : w, xs[0]) : 'missing';
  }
  function feedSummary(quotes, tickers, nowMs, errors) {
    const clock=marketClock(nowMs),names=tickers&&tickers.length?tickers:Object.keys(quotes||{}),counts={};
    const items=names.map(t=>{const q=quotes&&quotes[t],c=classify(q,nowMs,clock),checked=q&&(q.checked_at||q.retrieved_at),cm=Date.parse(checked||'');
      const healthyStream=q&&q.source_transport==='websocket'&&c.ageMin!=null&&(c.word==='closed'||c.ageMin<=15)&&isFinite(cm)&&nowMs-cm<=180000&&nowMs-cm>=-60000;
      const error=healthyStream?null:errors&&errors[t];let state=error?'blocked':c.word;
      if(!error&&c.word==='stale'&&q&&q.delay_minutes===0&&c.ageMin<=15&&isFinite(cm)&&nowMs-cm<=180000&&nowMs-cm>=-60000)state='older';
      counts[state]=(counts[state]||0)+1;
      return {t,state,observation:q&&(q.asof_utc||q.ts)||null,checked_at:checked||null,age_minutes:c.ageMin??null,error:error||null};});
    const seen=items.filter(x=>x.observation), newest=seen.slice().sort((a,b)=>Date.parse(b.observation)-Date.parse(a.observation))[0];
    const word=counts.live===names.length?'live':counts.closed===names.length?'closed':!seen.length?'missing':Object.keys(counts).length===1?items[0].state:'mixed';
    const labels={live:'live',older:'older quote',stale:'stale',missing:'missing',blocked:'source wait',delayed:'delayed',closed:'closed'};
    const summary=Object.entries(counts).map(([k,n])=>n+' '+(labels[k]||k)+(k==='older'&&n!==1?'s':'')).join(' / ');
    return {word,summary,words:summary+(newest?', '+etLabel(newest.observation,nowMs):''),n:seen.length,of:names.length,counts,items,providers:[...new Set(names.map(t=>quotes&&quotes[t]&&quotes[t].provider).filter(Boolean))],missing:counts.missing||0,open:clock.open};
  }
  const fmtPx = v => isNum(v) ? (v >= 1000 ? v.toLocaleString('en-US', {maximumFractionDigits: 0}) : v.toFixed(2)) : 'Not available';
  const fmtPct = (v, d) => isNum(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d == null ? 2 : d) + '%' : 'Not available';

  /* ------------------------------------------------------------ engine state */
  const ST = {quotes: {}, file: null, subs: new Set(), owners: {}, cursor: 0, timers: [], started: false,
    worker: {url: '', enabled: false, reason: 'not configured', last: null, error: '', errors: {}},
    regularRefs:{},stream:{socket:null,subscribed:new Set(),pending:{},flush:null,retry:null,attempt:0,enabled:false,received:0,error:'',last:null}, fileState: {last: null, error: ''}, status: null, polling: false, vis: new Map(), seen: new WeakSet(), io: null, visTimer: null};
  const doc = root.document;
  const now = () => Date.now();

  // Every rendered price cell ([data-live]) is observed; the names actually in the viewport are polled, whatever
  // view drew them (Research rows after scroll/sort/filter, heatmap, dashboards). Removed cells drop out.
  const VISIBLE_MAX = 24;
  function visibleTickers() {
    const out = [];
    for (const [el, t] of ST.vis) { if (!el.isConnected) ST.vis.delete(el); else if (!out.includes(t)) out.push(t); }
    return out.slice(0, VISIBLE_MAX);
  }
  function observe(scope) {
    if (!root.IntersectionObserver || !scope || !scope.querySelectorAll) return;
    ST.io ||= new root.IntersectionObserver(entries => {
      entries.forEach(e => { if (e.isIntersecting) ST.vis.set(e.target, e.target.getAttribute('data-live')); else ST.vis.delete(e.target); });
      clearTimeout(ST.visTimer); ST.visTimer = setTimeout(() => { if (ST.started) schedule(true); paintHealth(); }, 250);
    });
    scope.querySelectorAll('[data-live]').forEach(el => { if (!ST.seen.has(el)) { ST.seen.add(el); ST.io.observe(el); } });
  }
  function onScreen() {
    const order = ['company', 'explore', 'index', 'research', 'visible', 'shortlist', 'watchlist', 'other'];
    ST.owners.visible = visibleTickers();
    const all = [];
    if(doc){for(const [owner,selector] of Object.entries({dashboard:'.md',strategy:'.st',edge:'#pg-edge'})){const el=doc.querySelector(selector);if(!el||!el.getClientRects().length)ST.owners[owner]=[];}}
    order.concat(Object.keys(ST.owners).filter(k => !order.includes(k))).forEach(k => (ST.owners[k] || []).forEach(t => all.push(t)));
    return [...new Set(all.map(t => String(t).toUpperCase()).filter(t => SYMBOL.test(t)))];
  }
  // rows come from the expanded desk (SO2.D) or from the minimal main page (setRows)
  const coreRows=()=>ST.rows||root.SO2?.D?.()?.rows||[];
  function setRows(rows){ST.rows=Array.isArray(rows)?rows:null;ST.rowIndex=null;if(ST.started)syncStream();}
  function streamTargets() {
    const rows=coreRows();
    // on-screen names first so any provider cap keeps what the reader is looking at
    // Observed, not a published entitlement: one subscription delivered events for at most ~100 names, so the
    // socket carries a bounded, prioritised set: SPY, then on-screen names, then members by market value.
    const ranked=rows.filter(r=>r.sp500_member!==false).slice().sort((x,y)=>(y.mcap||0)-(x.mcap||0)).map(r=>r.t);
    return [...new Set(['SPY'].concat(onScreen(),ranked))].filter(t=>SYMBOL.test(t)).slice(0,STREAM_MAX);
  }
  function stopStream() {
    const st=ST.stream;clearTimeout(st.retry);st.retry=null;
    if(st.socket){const ws=st.socket;st.socket=null;ws.onclose=null;ws.close();}st.subscribed.clear();
  }
  function syncStream() {
    const st=ST.stream;if(!st.enabled||!root.WebSocket)return;
    if(doc&&doc.visibilityState!=='visible'){stopStream();return;}
    const targets=streamTargets(),desired=new Set(targets.map(t=>t.replace(/\./g,'-')));
    if(!desired.size)return;
    if(st.socket?.readyState===1){const add=[...desired].filter(t=>!st.subscribed.has(t)),remove=[...st.subscribed].filter(t=>!desired.has(t));if(remove.length)st.socket.send(JSON.stringify({unsubscribe:remove}));if(add.length)st.socket.send(JSON.stringify({subscribe:add}));st.subscribed=desired;return;}
    if(st.socket||st.retry)return;
    const ws=new root.WebSocket('wss://streamer.finance.yahoo.com/?version=2');st.socket=ws;
    ws.onopen=()=>{if(st.socket!==ws)return;st.attempt=0;st.error='';syncStream();};
    ws.onmessage=ev=>{if(st.socket!==ws)return;try{
      const event=decodeYahooMessage(ev.data),canonical=streamTargets().find(t=>t.replace(/\./g,'-')===event.id);if(!canonical)return;
      const quote=yahooQuote(event,st.pending[canonical]||ST.quotes[canonical],now(),ST.regularRefs[canonical]);if(!quote)return;
      st.pending[canonical]=quote;st.received++;st.last=quote.received_at;
      if(!st.flush)st.flush=setTimeout(()=>{st.flush=null;const pending=st.pending;st.pending={};Object.keys(pending).forEach(t=>delete ST.worker.errors[t]);accept(pending,'stream');},250);
    }catch(e){st.error='Invalid stream event: '+e.message;}};
    ws.onerror=()=>{st.error='Quote stream connection failed';};
    ws.onclose=()=>{if(st.socket!==ws)return;st.socket=null;st.subscribed.clear();st.error='Quote stream disconnected';pollWorker(null,true);if(!doc||doc.visibilityState==='visible'){const delay=Math.min(60000,1000*2**Math.min(st.attempt++,6));st.retry=setTimeout(()=>{st.retry=null;syncStream();},delay);}};
  }
  function watch(owner, tickers) {
    ST.owners[owner] = [...new Set((tickers || []).map(t => String(t).toUpperCase()))];
    if (doc) paintHealth();   // the header's on-screen/other scope changes with the watched set
    if (ST.started) {syncStream();schedule(true);}
  }
  function subscribe(fn) { ST.subs.add(fn); return () => ST.subs.delete(fn); }
  function get(t) {
    const q = ST.quotes[String(t || '').toUpperCase()];
    if (!q) return null;
    const c = classify(q, now()),state=feedSummary({[t]:q},[t],now(),ST.worker.errors).items[0].state;
    return Object.assign({}, q, {delivery_state:state,current_usable:!predatesRow(coreRow(t),q)&&!['stale','missing','blocked'].includes(state)}, {t: String(t).toUpperCase(), freshness_word: c.word, freshness_label: c.label, asof_label: etLabel(q.asof_utc || q.ts, now())});
  }
  // quotes.json-shaped snapshot for older consumers (company view, intelligence, chat)
  function snapshot() {
    const f = ST.file || {};
    return Object.assign({}, f, {quotes: Object.assign({}, ST.quotes)});
  }
  function emit(changed, source) {
    const ev = {changed, source, quotes: snapshot(), at: now()};
    ST.subs.forEach(fn => { try { fn(ev); } catch (e) { console.error('[live] subscriber failed', e); } });
    if (doc) { paint(doc, changed); if (root.CustomEvent) root.dispatchEvent(new root.CustomEvent('so:quotes-update', {detail: ev.quotes})); }
  }
  function accept(incoming, source) {
    if(source!=='stream')Object.entries(incoming||{}).forEach(([t,q])=>{if(q&&isNum(q.prior_close)&&q.prior_close>0&&obsMs(q)!=null&&![2,3].includes(q.market_hours)&&(!ST.regularRefs[t]||obsMs(q)>=obsMs(ST.regularRefs[t])))ST.regularRefs[t]=q;});
    const r = merge(ST.quotes, incoming, source);
    ST.quotes = r.quotes;
    if (r.changed.length || source === 'file-first') emit(r.changed, source);
    return r.changed;
  }

  async function getJSON(url, fetchImpl) {
    const res = await (fetchImpl || root.fetch)(url, {cache: 'no-store'});
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }
  async function loadFile(fetchImpl) {
    try {
      const q = await getJSON('data/quotes.json', fetchImpl);
      if (!q || !q.quotes) throw new Error('quote file has no quotes');
      const first = !ST.file;
      ST.file = q; ST.fileState = {last: now(), error: ''};
      accept(q.quotes, first ? 'file-first' : 'file');
    } catch (e) {
      ST.fileState.error = 'Shared quote file unavailable: ' + (e.message || e) + '. Last observations kept with their times.';
      if (doc) paintHealth();
    }
  }
  async function pollWorker(fetchImpl, force) {
    const w = ST.worker;
    if (!w.enabled || ST.polling) return;
    if (doc && doc.visibilityState && doc.visibilityState !== 'visible') return;
    const clock = marketClock(now());
    if (!clock.open && !force) return;
    const groups = batches(onScreen());
    if (!groups.length) return;
    const group = groups[ST.cursor % groups.length]; ST.cursor++;
    ST.polling = true; w.pending=group; if(doc)paint(doc,null);
    try {
      const url = new URL(w.url); url.searchParams.set('symbols', group.join(','));
      const data = await getJSON(url.toString(), fetchImpl);
      if (!data || typeof data.quotes !== 'object') throw new Error('response had no quotes');
      w.errors = Object.assign({}, w.errors, data.errors || {});
      group.forEach(t => { if (data.quotes[t] && !data.errors?.[t]) delete w.errors[t]; });
      w.delivery=data.delivery||w.delivery;
      w.last = now(); w.error = '';
      accept(data.quotes, 'worker');
    } catch (e) {
      w.error = 'Fast price path unavailable: ' + (e.message || e) + '. Last observations retained separately.';group.forEach(t=>w.errors[t]=w.error);
    } finally { ST.polling = false;w.pending=[]; if (doc) paint(doc,null); }
  }
  function schedule(immediate) {
    if (immediate) pollWorker(null, !marketClock(now()).open && !ST.worker.last);
  }
  function configure(cfg, origin) {
    const url = cfg && typeof cfg.quotes_proxy_url === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(cfg.quotes_proxy_url) ? cfg.quotes_proxy_url : '';
    const allowed = (cfg && Array.isArray(cfg.quotes_proxy_origins) ? cfg.quotes_proxy_origins : ALLOWED_ORIGINS);
    ST.worker.url = url;
    ST.worker.enabled = !!url && allowed.includes(origin);
    ST.worker.reason = !url ? 'No fast path configured' : ST.worker.enabled ? 'Finnhub through the shared Worker' :
      'Fast path serves the published sites only; this copy (' + origin + ') reads the shared file';
    return ST.worker.enabled;
  }
  async function start(opts) {
    if (ST.started) return;
    ST.started = true;
    opts = opts || {};
    let cfg = null;
    try { cfg = await getJSON('data/config.json'); } catch (e) { ST.worker.reason = 'Configuration unavailable: ' + (e.message || e); }
    configure(cfg, root.location ? root.location.origin : '');
    ST.stream.enabled=!!root.WebSocket&&ALLOWED_ORIGINS.includes(root.location?.origin);
    ST.timers.push(setInterval(()=>{const st=ST.stream;if(st.socket?.readyState===1&&st.subscribed.size)st.socket.send(JSON.stringify({subscribe:[...st.subscribed]}));},15000));
    await loadFile();
    syncStream();
    pollWorker(null, true);   // one fast read on arrival, even after the close, so the latest print is shown
    ST.timers.push(setInterval(async () => {if(!doc||doc.visibilityState==='visible') await refresh();}, OPEN_POLL_MS));
    ST.timers.push(setInterval(() => paint(doc, null), 15000));   // freshness words age even when no price moves
    // stream follows visibility; wake handlers return the refresh so callers can await one complete pass
    if (doc) { doc.addEventListener('visibilitychange', () => syncStream()); doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'visible') refresh(); }); }
    if(root.addEventListener){root.addEventListener('pageshow',()=>{syncStream();});root.addEventListener('focus',()=>{syncStream();});root.addEventListener('pageshow',()=>refresh());root.addEventListener('focus',()=>refresh());}
  }

  /* ------------------------------------------------------------ DOM binding
     <span data-live="AAPL" data-live-f="price|chg|pe|pef|range|hi|asof|fresh|since"></span> updates itself. */
  function coreRow(t) { const rows=coreRows(); if(ST.rowIndex?.rows!==rows){ST.rowIndex={rows,map:new Map(rows.map(r=>[r.t,r]))};} return ST.rowIndex.map.get(t)||null; }
  function predatesRow(row,q){const ms=obsMs(q);return !!(row?.pxd&&ms!=null&&quoteSession(ms)<row.pxd);}
  const reduced = () => !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
  function fieldText(f, d, q, nowMs) {
    switch (f) {
      case 'price': return fmtPx(d.price);
      case 'chg': return fmtPct(d.chg_pct);
      case 'pe': return isNum(d.pe) ? d.pe.toFixed(1) : 'Not available';
      case 'pef': return isNum(d.pef) ? d.pef.toFixed(1) : 'Not available';
      case 'range': return isNum(d.range_pct) ? Math.round(d.range_pct) + '% of range' : 'Not available';
      case 'hi': return isNum(d.from_hi_pct) ? (d.new_high ? 'New high' : fmtPct(d.from_hi_pct, 1)) : 'Not available';
      case 'asof': return q ? etLabel(q.asof_utc || q.ts, nowMs) : 'session close';
      case 'fresh': {const state=feedSummary(ST.quotes,[q?.t||''],nowMs,ST.worker.errors).items[0]?.state;return state==='older'?'older quote':q?classify(q,nowMs).label:'missing';}
      case 'since': return isNum(d.since_close_pct) ? fmtPct(d.since_close_pct) : '';
      default: return '';
    }
  }
  // Presentation-only reference: the dated completed-session close in core. Never a current price; never fed to derive/currentRow.
  function referenceQuote(row, nowMs = Date.now()) {
    if (!row || !isNum(row.px) || row.px <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(String(row.pxd || ''))) return null;
    const at = Date.parse(row.pxd + 'T00:00:00Z');
    if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== row.pxd || at > nowMs) return null;
    return {price: row.px, date: row.pxd, ret: isNum(row.d1) ? row.d1 : null, basis: 'completed-session close'};
  }
  const refDate = d => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString('en-US', {timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric'}); };
  // Opt-in "note" slot: one clock line for a usable quote, or one dated reference (or one neutral status) during a gap.
  function quoteNote(row, q, state, unavailable, nowMs, pending) {
    if (!unavailable) { const w = {live: 'Live', closed: 'Close', delayed: 'Delayed', older: 'Older quote'}[state] || state; return {kind: 'current', text: w + ' · ' + etLabel(q && (q.asof_utc || q.ts), nowMs).replace(/^as of /, '')}; }
    if (pending) return {kind: 'pending', text: 'Updating quote…'};
    const ref = referenceQuote(row, nowMs);
    if (!ref) return {kind: 'missing', text: 'Quote unavailable'};
    // The core's historical return need not use the same adjustment/prior-close
    // basis as this quote. Keep that analysis in its dated evidence, not paired here.
    return {kind: 'reference', ref, text: 'Reference close $' + fmtPx(ref.price) + ' · ' + refDate(ref.date) + '\nCurrent quote unavailable'};
  }
  function paint(scope, changed) {
    if (!scope || !scope.querySelectorAll) return;
    observe(scope);
    const nowMs = now(), set = changed ? new Set(changed) : null, anim = !reduced();
    scope.querySelectorAll('[data-live]').forEach(el => {
      const t = el.getAttribute('data-live');
      const q = ST.quotes[t], d = derive(coreRow(t), q), f = el.getAttribute('data-live-f') || 'price';
      if(f==='watch')return;
      if(f==='fresh'||f==='asof'){el.hidden=true;return;}
      const state=feedSummary(ST.quotes,[t],nowMs,ST.worker.errors).items[0].state;
      const unavailable=predatesRow(coreRow(t),q)||!['live','older','closed','delayed'].includes(state);
      const quiet=el.hasAttribute('data-live-quiet'),note=f==='note'?quoteNote(coreRow(t),q,state,unavailable,nowMs,ST.worker.pending?.includes(t)):null;
      if(quiet||note){if(unavailable)el.dataset.state=note?note.kind:'unavailable';else delete el.dataset.state;}
      // A valid dated price may lack a comparable previous close (notably ETF relay histories).
      // Quiet price headers omit that absent change rather than printing a large placeholder beside the price.
      // The return remains missing in the model; the source note retains its own observation time.
      const text=note?note.text:f==='fresh'?(state==='older'?'older quote':state==='blocked'?'source wait':state):(['price','pe','pef','chg','range','hi','since'].includes(f)&&unavailable)?(quiet?'':ST.worker.pending?.includes(t)?'Updating…':'Unavailable'):quiet&&f==='chg'&&!isNum(d.chg_pct)?'':fieldText(f,d,q,nowMs);
      if(q)el.title='Last reported '+fmtPx(q.price)+' at '+(q.asof_utc||q.ts)+'; source checked '+(q.checked_at||q.retrieved_at||'unknown')+(unavailable?'; current value unavailable':'');
      if (f === 'fresh') { const c = classify(q, nowMs); el.dataset.fresh = c.word; el.title = q ? (q.provider || '') + ', trade ' + etLabel(q.asof_utc || q.ts, nowMs) + (q.checked_at||q.retrieved_at ? '; source checked ' + (q.checked_at||q.retrieved_at) : '') : 'No observation'; }
      if (f === 'range' && el.style) el.style.setProperty('--pos', isNum(d.range_pct) ? d.range_pct.toFixed(1) + '%' : '50%');
      if (f === 'chg' || f === 'since') el.dataset.dir = unavailable ? '' : isNum(f === 'chg' ? d.chg_pct : d.since_close_pct) ? ((f === 'chg' ? d.chg_pct : d.since_close_pct) >= 0 ? 'up' : 'dn') : '';
      if (f === 'range') { const bar = el.querySelector && el.querySelector('i'); if (bar) bar.style.left = isNum(d.range_pct) ? d.range_pct.toFixed(1) + '%' : '50%'; const lab = el.querySelector && el.querySelector('b'); if (lab) lab.textContent = text; return; }
      if (el.textContent === text) return;
      const old = el.textContent; el.textContent = text;
      if (anim && old && set && set.has(t) && el.animate && (f === 'price' || f === 'chg')) {
        const up = f === 'chg' ? d.chg_pct >= 0 : parseFloat(text.replace(/,/g, '')) >= parseFloat(old.replace(/,/g, ''));
        el.animate([{backgroundColor: up ? 'var(--b-good-bg)' : 'var(--b-bad-bg)'}, {backgroundColor: 'transparent'}], {duration: 220, easing: 'ease-out'});
      }
    });
    paintHealth();
  }
  // Prices not on screen are not polled: describe them by their median observation, never by the live subset.
  function coverage(quotes, watched, nowMs, active) {
    const set = new Set(watched || []);
    const rest = Object.entries(quotes || {}).filter(([t, q]) => !set.has(t) && (!active||active.has(t)) && q && isNum(q.price) && q.price > 0 && obsMs(q) != null)
      .map(([, q]) => q).sort((a, b) => obsMs(a) - obsMs(b));
    const mid = rest.length ? rest[Math.floor(rest.length / 2)] : null;
    const c = mid ? classify(mid, nowMs) : null;
    return {watched: set.size, others: rest.length, others_asof: mid ? (mid.asof_utc || mid.ts) : null, others_word: c ? c.word : 'missing',
      others_label: mid ? etLabel(mid.asof_utc || mid.ts, nowMs) : 'time not available', median_age_minutes:mid?Math.max(0,(nowMs-obsMs(mid))/60000):null, oldest_age_minutes:rest.length?Math.max(0,(nowMs-obsMs(rest[0]))/60000):null, inactive_preserved:active?Object.keys(quotes||{}).filter(t=>!active.has(t)).length:0};
  }
  async function refresh(fetchImpl) {
    await loadFile(fetchImpl);const groups=batches(onScreen());
    for(let i=0;i<Math.min(groups.length,4);i++){
      if(i)await new Promise(resolve=>setTimeout(resolve,1100));
      await pollWorker(fetchImpl,true);
    }
    if(doc)paint(doc,null);
  }
  function health(nowMs) {
    nowMs = nowMs == null ? now() : nowMs;
    const watched = onScreen();
    const feed = feedSummary(ST.quotes, watched.length ? watched : null, nowMs,ST.worker.errors);
    const rows=coreRows().length?coreRows():null,active=rows?new Set(rows.filter(r=>r.sp500_member!==false).map(r=>r.t).concat(['SPY','RSP'])):null;
    const cv=coverage(ST.quotes,watched,nowMs,active);
    const fh=Object.assign({},ST.file?.health,{median_age_minutes:cv.median_age_minutes,oldest_age_minutes:cv.oldest_age_minutes,line:`Active universe: ${cv.others} off-screen observations; median age ${cv.median_age_minutes==null?'unavailable':cv.median_age_minutes.toFixed(1)+' min'} now. ${cv.inactive_preserved} inactive/reference records excluded from these ages.`});
    return {feed, coverage: cv, worker: Object.assign({}, ST.worker), stream:{enabled:ST.stream.enabled,connected:ST.stream.socket?.readyState===1,received:ST.stream.received,last:ST.stream.last,error:ST.stream.error,subscriptions:ST.stream.subscribed.size}, file: Object.assign({}, ST.fileState),
      fileHealth: fh};
  }
  function paintHealth() { if (root.CustomEvent && root.dispatchEvent) root.dispatchEvent(new root.CustomEvent('so:live-health', {detail: health()})); }

  return {start, setRows, refresh, configure, watch, subscribe, get, snapshot, health, coverage, paint, accept, loadFile, pollWorker, onScreen,
    marketClock, classify, etLabel, merge, batches, decodeYahooMessage, yahooQuote, syncStream, stopStream, derive, currentRow, currentBrief, currentContext, predatesRow, referenceQuote, quoteNote, worstOf, feedSummary, fmtPx, fmtPct, ALLOWED_ORIGINS, MAX_BATCH, STREAM_MAX,
    _state: ST};
});
