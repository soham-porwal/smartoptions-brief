/* R5: one-view watchlist. Historical scores are read-only snapshot values. */
(function (root) {
  'use strict';
  const KEY = 'so_watchlist_v1';
  const finite = v => typeof v === 'number' && Number.isFinite(v);
  const normalize = xs => [...new Set((Array.isArray(xs) ? xs : []).map(x => String(x).trim().toUpperCase()).filter(x => /^[A-Z0-9][A-Z0-9.^-]{0,14}$/.test(x)))];
  function createWatchlist(storage, defaults, changed) {
    let memory = null;
    function get() {
      if (memory) return memory.slice();
      try { const raw = storage.getItem(KEY); if (raw !== null) return normalize(JSON.parse(raw)); }
      catch (e) { if (changed) changed('Watchlist storage unavailable or invalid; changes remain in this tab.', e); }
      return normalize(defaults());
    }
    function set(xs) {
      memory = normalize(xs);
      let saved = true;
      try { storage.setItem(KEY, JSON.stringify(memory)); } catch (e) { saved = false; if (changed) changed('Watchlist could not be saved; changes remain in this tab.', e); }
      if (changed) changed(saved ? '' : null);
      return get();
    }
    function reset() { memory = null; try { storage.removeItem(KEY); } catch (e) { /* storage blocked */ } if (changed) changed(''); return get(); }
    return {get, set, reset, defaults: () => normalize(defaults()), add: xs => set(get().concat(Array.isArray(xs) ? xs : [xs])), remove: t => set(get().filter(x => x !== String(t).toUpperCase()))};
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = {createWatchlist, normalize};
  if (!root.document) return;
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
  const fmt = (v, n = 2) => finite(v) ? v.toLocaleString('en-US', {minimumFractionDigits:n, maximumFractionDigits:n}) : '—';
  const signed = (v, n = 2) => finite(v) ? (v > 0 ? '+' : '') + fmt(v, n) : '—';
  const cls = v => !finite(v) || v === 0 ? '' : v > 0 ? 'ov-positive' : 'ov-negative';
  const safeURL = u => /^https?:\/\//i.test(u || '') ? esc(u) : '#';
  let api, page, sort = {key:'opp', dir:-1}, query = '', lastData, status = '', ovScope = 'watch', prevBookBackup = null;
  const DEMO_BOOK = [
    {t: 'NVDA', qty: 200, cost: 118.50},
    {t: 'MSFT', qty: 150, cost: 412.00},
    {t: 'AAPL', qty: 300, cost: 214.00},
    {t: 'JPM',  qty: 200, cost: 205.25},
    {t: 'XOM',  qty: 250, cost: 112.40},
    {t: 'LLY',  qty: 100, cost: 875.00}
  ];
  function renderBookStress(d, local, byTicker) {
    const book = local && local.book ? local.book : null;
    const keys = book ? Object.keys(book).filter(t => byTicker.has(t)) : [];
    if (!keys.length) return '';
    let totVal = 0, totCost = 0, hasCost = false;
    const pos = keys.map(t => {
      const r = byTicker.get(t), b = book[t] || {};
      const qty = finite(b.qty) && b.qty > 0 ? b.qty : 100;
      const val = finite(r.px) ? qty * r.px : 0;
      const cost = finite(b.cost) && b.cost > 0 ? qty * b.cost : null;
      totVal += val;
      if (cost != null) { totCost += cost; hasCost = true; }
      return {t, r, qty, costPerShare: b.cost, val, cost, pnl: cost != null ? val - cost : null, pnlPct: cost != null && cost > 0 ? (val / cost - 1) * 100 : null};
    }).sort((a, b) => b.val - a.val);
    if (totVal <= 0) return '';
    const wBetas = {spy: 0, us10y_bps: 0, dxy: 0, wti: 0, vix: 0};
    let scenDollar = 0;
    const activeShock = api.S && api.S().shock ? api.S().shock : {};
    const anyShock = ['spy', 'us10y_bps', 'dxy', 'wti', 'vix'].some(f => activeShock[f]);
    const stressShock = anyShock ? activeShock : {us10y_bps: 25, vix: 5, spy: -2, dxy: 1, wti: 0};
    const shockLabel = anyShock ? 'Active Controls shock' : 'Default macro stress (+25bp 10Y, +5 VIX, -2% SPY, +1% DXY)';
    for (const p of pos) {
      const w = p.val / totVal;
      const c = p.r.rel && p.r.rel.c ? p.r.rel.c : {};
      for (const f of ['spy', 'us10y_bps', 'dxy', 'wti', 'vix']) {
        if (finite(c[f])) wBetas[f] += w * c[f];
      }
      if (p.r.rel && api.scenarioImpact) {
        const impPct = api.scenarioImpact(c, stressShock);
        if (finite(impPct)) scenDollar += p.val * (impPct / 100);
      }
    }
    const scenPct = (scenDollar / totVal) * 100;
    const totPnl = hasCost ? totVal - totCost : null;
    const totPnlPct = hasCost && totCost > 0 ? (totVal / totCost - 1) * 100 : null;
    const alerts = pos.filter(p => (finite(p.r.ern) && p.r.ern >= 0 && p.r.ern <= 14) || (finite(p.r.res20d) && p.r.res20d <= -3) || (finite(p.r.ivrv_eff) && p.r.ivrv_eff >= 1.2)).slice(0, 4);
    return `<section class="ov-book-panel" aria-label="My Book Portfolio Edge and Macro Stress" style="margin:8px 0 12px;padding:10px 14px;border:1px solid #26323d;border-radius:6px;background:#0e1318">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:6px">
        <div><b>My Book · Portfolio Edge &amp; Macro Stress</b> <span class="ov-dim">(${pos.length} positions · weighted by market value)</span></div>
        <div style="display:flex;gap:12px;font-size:12px">
          <span>Market Value: <b>$${fmt(totVal, 0)}</b></span>
          ${totPnl != null ? `<span>Unrealized P&amp;L: <b class="${cls(totPnl)}">${totPnl >= 0 ? '+' : ''}$${fmt(totPnl, 0)} (${signed(totPnlPct, 1)}%)</b></span>` : ''}
          <span>Top Weight: <b>${esc(pos[0].t)} ${((pos[0].val / totVal) * 100).toFixed(1)}%</b></span>
        </div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:14px;font-size:12px;padding:6px 0;border-top:1px solid #1b242c;border-bottom:1px solid #1b242c">
        <span title="Portfolio value-weighted SPY beta (% per +1% SPY)"><b>β SPY:</b> ${signed(wBetas.spy, 2)}%</span>
        <span title="Portfolio value-weighted 10Y rate impact (% per +10bp 10Y)"><b>β 10Y (+10bp):</b> ${signed(wBetas.us10y_bps * 10, 2)}%</span>
        <span title="Portfolio value-weighted DXY sensitivity (% per +1% DXY)"><b>β DXY:</b> ${signed(wBetas.dxy, 2)}%</span>
        <span title="Portfolio value-weighted WTI sensitivity (% per +1% WTI)"><b>β WTI:</b> ${signed(wBetas.wti, 2)}%</span>
        <span title="Portfolio value-weighted VIX sensitivity (% per +1pt VIX)"><b>β VIX:</b> ${signed(wBetas.vix, 2)}%</span>
        <span title="${esc(shockLabel)}"><b>${esc(shockLabel)}:</b> <b class="${cls(scenPct)}">${scenDollar >= 0 ? '+' : ''}$${fmt(scenDollar, 0)} (${signed(scenPct, 2)}%)</b></span>
      </div>
      ${alerts.length ? `<div style="margin-top:6px;font-size:12px;display:flex;flex-wrap:wrap;gap:8px;align-items:center"><b>Book Action / Hedge Alerts:</b> ${alerts.map(p => {
        const reasons = [];
        if (finite(p.r.ern) && p.r.ern >= 0 && p.r.ern <= 14) reasons.push(`earn ${p.r.ern}d`);
        if (finite(p.r.res20d) && p.r.res20d <= -3) reasons.push(`20d α ${signed(p.r.res20d, 1)}%`);
        if (finite(p.r.ivrv_eff) && p.r.ivrv_eff >= 1.2) reasons.push(`IV/RV ${fmt(p.r.ivrv_eff, 2)}x`);
        const contracts = Math.max(1, Math.floor(p.qty / 100));
        return `<span style="padding:2px 6px;background:#162029;border-radius:4px">${esc(p.t)} (${p.qty} sh · ${reasons.join(', ')}) <button type="button" data-book-hedge="${esc(p.t)}" style="margin-left:4px;cursor:pointer">Hedge / Collar (${contracts}c) →</button></span>`;
      }).join('')}</div>` : ''}
    </section>`;
  }
  const initialHash = new URLSearchParams(location.hash.slice(1));
  // Start with the general workspace; explicit ticker/view links retain their chosen destination.
  const defaultLanding = !initialHash.has('tab') && !initialHash.has('t') && !initialHash.has('s') && !initialHash.has('fl') && !initialHash.has('open');
  function notice(message, error) {
    if (message != null) status = message;
    if (error) console.warn('[R5 watchlist]', message, error.name);
    if (page) render();
    root.dispatchEvent(new CustomEvent('so:watchlist'));
  }
  function tooltip(r, field, unit) {
    const states = r.st || {};
    return esc(`Yahoo Finance · ${r.t} · ${field}${field === 'pe_forward' ? ' (forwardPE)' : ''} · ${unit || 'ratio'} · price session ${r.pxd || 'unavailable'} · fundamentals retrieved ${r.rat || 'unavailable'} · status ${states[field] || 'missing'}${field === 'peg' ? ' · ' + (r.pegm || 'method unavailable') : ''} · source https://finance.yahoo.com/quote/${encodeURIComponent(r.t)}/key-statistics/`);
  }
  function cell(r, field, value, unit) {
    const peg = field === 'peg';
    const title = tooltip(r,field,unit) + (peg ? esc(` · raw PEG ${finite(value) ? value : 'unavailable'} · negative/low growth distorts PEG · display cap 10 (display only, raw value retained)`) : '');
    return `<span title="${title}">${peg && finite(value) && value > 10 ? '&gt;10' : fmt(value)}</span>`;
  }
  function range(r) {
    if (![r.lo,r.hi,r.px].every(finite) || r.hi <= r.lo) return '<span title="52-week range unavailable from provider">—</span>';
    const p = Math.max(0, Math.min(100, (r.px-r.lo)/(r.hi-r.lo)*100));
    return `<div class="ov-range" title="${tooltip(r,'range_52w','USD; marker = (price − low)/(high − low), clamped to range')}"><span>${fmt(r.lo)}</span><i><b style="left:${p.toFixed(2)}%"></b></i><span>${fmt(r.hi)}</span></div>`;
  }
  function earnings(r) {
    if (!r.er || !/^\d{4}-\d{2}-\d{2}$/.test(r.er)) return '<span title="Next earnings date unavailable from provider">—</span>';
    const date = new Date(r.er + 'T00:00:00Z');
    if (!Number.isFinite(+date)) return '—';
    const now = new Date(), today = Date.UTC(now.getFullYear(),now.getMonth(),now.getDate());
    const days = Math.round((date-today)/86400000);
    const text = days > 0 ? `${days}d` : days === 0 ? 'Today' : `${Math.abs(days)}d ago`;
    return `<span class="ov-earn" title="${tooltip(r,'earnings','calendar days from viewer date')} · ${esc(r.ers || 'provider unavailable')}"><time>${esc(r.er.slice(5))}</time><b>${text}</b><small${r.ert?'':' class="ov-dim"'}>${esc(r.ert || '—')}</small></span>`;
  }
  function analyst(r) {
    if (!r.rating && !finite(r.up)) return '<span title="Analyst rating and target unavailable from provider">—</span>';
    return `<details class="ov-analyst-why"><summary class="ov-analyst" title="${tooltip(r,'analyst','target USD; upside %')} · target ${fmt(r.tgt)} · ${fmt(r.nan,0)} analysts"><b>${esc((r.rating || 'unrated').replace(/_/g,' '))}</b><span class="${cls(r.up)}">${signed(r.up,1)}${finite(r.up)?'%':''}</span></summary><div class="ov-analyst-inputs">${esc(r.t)} · Yahoo Finance provider rating: ${esc(r.rating || 'unavailable')} (shown verbatim; no dashboard rating threshold). Target ${fmt(r.tgt)} USD · price ${fmt(r.px)} USD · ${fmt(r.nan,0)} analysts. Upside = (target / price − 1) × 100 = ${signed(r.up,1)}%. Price as of ${esc(r.pxd || 'unavailable')} · fundamentals retrieved ${esc(r.rat || 'unavailable')}. <a href="https://finance.yahoo.com/quote/${encodeURIComponent(r.t)}/analysis/" target="_blank" rel="noopener">Source</a></div></details>`;
  }
  function spark(history) {
    const v = (history || []).map(p => Array.isArray(p) ? p[1] : p).filter(finite);
    if (v.length < 2) return '<span class="ov-no-history">History unavailable</span>';
    const min = Math.min(...v), delta = Math.max(...v)-min || 1;
    return `<svg class="ov-spark" viewBox="0 0 160 26" preserveAspectRatio="none" aria-label="History, oldest to latest"><polyline points="${v.map((n,i)=>`${(i/(v.length-1)*160).toFixed(1)},${(24-(n-min)/delta*22).toFixed(1)}`).join(' ')}"/></svg>`;
  }
  function macro() {
    const d = api.D(), observations = Object.values(d.macro || {}).flat();
    const find = id => observations.find(o=>o.id===id);
    const event = (d.calendar || []).filter(e=>e.type==='FOMC' && +new Date(e.scheduled_et)>=Date.now()).sort((a,b)=>a.scheduled_et.localeCompare(b.scheduled_et))[0];
    const configs = [['cpi_headline','CPI · YoY','%'],['us10y','US Treasury · 10Y','%'],['unemployment','Labor · unemployment','%'],['effective_fed_funds','Federal funds · effective','%'],['vix','Volatility · VIX','pts']];
    let html = configs.map(([id,label,unit])=>{
      const o = find(id) || {status:'missing'};
      const change = id==='us10y' ? (find('us10y_bps_chg') || {}).v : finite(o.v)&&finite(o.prior) ? o.v-o.prior : null;
      const changeUnit = id==='us10y' ? 'bp' : unit==='%' ? 'pp' : 'pts';
      const payroll = find('payrolls');
      const secondary = id==='unemployment' ? `Payrolls ${payroll ? signed(payroll.v,0)+'k · '+esc(payroll.period || 'period n/a') : 'unavailable'} · consensus unavailable` : id==='effective_fed_funds' ? (()=>{const lo=find('fed_target_lower'),hi=find('fed_target_upper');return lo&&hi&&finite(lo.v)&&finite(hi.v)?`Target ${fmt(lo.v)}–${fmt(hi.v)} · `:'';})()+(event ? `Next FOMC ${esc(event.scheduled_et.slice(0,10))} · ${Math.ceil((+new Date(event.scheduled_et)-Date.now())/86400000)}d` : 'Next FOMC unavailable') : 'Δ from previous observation';
      const title = `${o.provider || 'provider unavailable'} · ${o.series || id} · retrieved ${o.retrieved_at || 'unavailable'} · ${o.note || ''}`;
      return `<article class="ov-macro-item"><div class="ov-macro-label">${esc(label)} <span class="ov-status ${o.status==='ok'?'':'ov-warning'}">${esc(o.status)}</span></div><button class="ov-macro-drill" data-macro-series="${id}" aria-label="Explore ${esc(label)} history and market relationships"><span class="ov-macro-number"><strong>${fmt(o.v,id==='vix'?2:2)}<small>${unit}</small></strong><span>${finite(change)?(change>0?'↑':change<0?'↓':'→')+' '+fmt(Math.abs(change),changeUnit==='bp'?0:2)+' '+changeUnit:'Δ unavailable'}</span></span>${spark(o.h)}</button><div class="ov-period">${esc(o.period || o.date || 'period unavailable')} <a href="${safeURL(o.url)}" target="_blank" rel="noopener noreferrer" title="${esc(title)}">${esc(o.series || 'Source')} ↗</a></div><div class="ov-secondary" title="${esc(id==='unemployment' && payroll ? `${payroll.provider} · ${payroll.series} · ${payroll.unit} · retrieved ${payroll.retrieved_at}` : secondary)}">${secondary}${id==='effective_fed_funds'&&event?` <a href="${safeURL(event.source_url)}" target="_blank" rel="noopener noreferrer" title="FOMC official calendar">↗</a>`:''}</div></article>`;
    }).join('');
    const local = root.SmartOptionsImport && root.SmartOptionsImport.getData();
    if (local && local.series) for (const s of local.series) {
      const h=s.points || [], end=h[h.length-1];
      html += `<article class="ov-macro-item ov-local"><div class="ov-macro-label">${esc(s.label)} <span class="ov-status">Local · unverified</span></div><div class="ov-macro-number"><strong>${fmt(end&&end[1])}</strong></div>${spark(h)}<div class="ov-period">${esc(end&&end[0] || 'period unavailable')}</div><div class="ov-secondary">Imported by you · units as supplied</div></article>`;
    }
    return html;
  }
  function render() {
    if (!page) return;
    const d=api.D(), list=root.SmartOptionsWatchlist.get(), byTicker=new Map(d.rows.map(r=>[r.t,r]));
    const today = $('#ov-today');
    if (today) today.innerHTML = root.SO2_flow ? root.SO2_flow.taskRow(d, false) : '<p>Market assessment loading. You can explore the watchlist below.</p>';
    const local=root.SmartOptionsImport && root.SmartOptionsImport.getData();
    const bookBox = $('#ov-book-stress');
    if (bookBox) bookBox.innerHTML = renderBookStress(d, local, byTicker);
    const metrics=local&&local.metrics, extras=metrics ? metrics.columns.slice(0,4) : [];
    const bookTickers = local && local.book ? Object.keys(local.book) : [];
    let baseList = ovScope === 'all' ? d.rows : ovScope === 'movers' ? d.rows.filter(r => (r.sets || []).includes('A')) : ovScope === 'book' ? bookTickers.map(t => byTicker.get(t)).filter(Boolean) : list.map(t=>byTicker.get(t)).filter(Boolean);
    let rows=baseList.filter(r=>(r.t+' '+r.n+' '+(r.sec||'')).toLowerCase().includes(query));
    page.querySelectorAll('[data-ov-scope]').forEach(b => b.classList.toggle('on', b.dataset.ovScope === ovScope));
    const value=r=>sort.key==='opp' ? r.sam&&r.sam.opp : sort.key.startsWith('local:') ? metrics&&metrics.rows[r.t]&&metrics.rows[r.t][sort.key.slice(6)] : r[sort.key];
    rows.sort((a,b)=>{const av=value(a),bv=value(b);if(av==null)return bv==null?a.t.localeCompare(b.t):1;if(bv==null)return -1;return (typeof av==='string'?av.localeCompare(bv):av-bv)*sort.dir||a.t.localeCompare(b.t);});
    const columns=[['t','Company'],['px','Price'],['d1','Day %'],['res20d','20d α %'],['pe','P/E · TTM'],['pef','P/E · Fwd'],['pef_sec_rel','vs Sec'],['peg','PEG'],['pct','52-week low → high'],['er','Next earnings'],['up','Analyst · target upside'],...extras.map(c=>['local:'+c,c+' · local'])];
    $('#ov-thead').innerHTML='<tr><th class="ov-pin-head" title="Unpin from watchlist">★</th>'+columns.map(([k,l])=>`<th aria-sort="${sort.key===k?(sort.dir===1?'ascending':'descending'):'none'}"><button data-sort="${esc(k)}">${esc(l)} ${sort.key===k?(sort.dir===1?'↑':'↓'):''}</button></th>`).join('')+'</tr>';
    $('#ov-tbody').innerHTML=rows.map(r=>{
      const book=local&&local.book&&local.book[r.t];
      const name=`<a href="#t=${encodeURIComponent(r.t)}" data-open="${esc(r.t)}" title="Open ${esc(r.n)} in Analyst"><b>${esc(r.t)}</b><small>${esc(r.n)}</small></a>${book?`<span class="ov-mine" title="My book: ${esc(book.qty == null?'quantity unavailable':book.qty)} shares; cost ${esc(book.cost == null?'unavailable':book.cost)}. Local only.">Mine</span>`:''}`;
      return `<tr data-overview-t="${esc(r.t)}" tabindex="0"><td class="ov-pin"><button data-unpin="${esc(r.t)}" aria-label="Unpin ${esc(r.t)}">★</button></td><td class="ov-company">${name}</td><td data-label="Price" title="${tooltip(r,'price','USD')}">${fmt(r.px)}</td><td data-label="Day" class="${cls(r.d1)}" title="${tooltip(r,'chg','% vs prior session')}">${signed(r.d1)}${finite(r.d1)?'%':''}</td><td data-label="20d α" class="${cls(r.res20d)}" title="20-session idiosyncratic return after stripping 5-factor OLS macro move">${signed(r.res20d,1)}${finite(r.res20d)?'%':''}</td><td data-label="TTM">${cell(r,'pe_trailing',r.pe)}</td><td data-label="Fwd">${cell(r,'pe_forward',r.pef)}</td><td data-label="vs Sec" title="Forward P/E vs ${esc(r.sec || 'sector')} median (${fmt(r.pef_sec_med,1)}x)">${finite(r.pef_sec_rel)?fmt(r.pef_sec_rel,2)+'x':'—'}</td><td data-label="PEG">${cell(r,'peg',r.peg)}</td><td data-label="52W">${range(r)}</td><td data-label="Earnings">${earnings(r)}</td><td data-label="Analyst">${analyst(r)}</td>${extras.map(c=>`<td data-label="${esc(c)}" title="Private local import · unverified · units supplied by user">${fmt(metrics.rows[r.t]&&metrics.rows[r.t][c])}</td>`).join('')}</tr>`;
    }).join('');
    $('#ov-empty').hidden=rows.length>0;
    const totalInScope = ovScope === 'all' ? d.rows.length : ovScope === 'movers' ? d.rows.filter(r=>(r.sets||[]).includes('A')).length : ovScope === 'book' ? bookTickers.length : list.length;
    $('#ov-count').textContent=`${rows.length} / ${totalInScope} symbols · session ${d.asof_session || 'unavailable'}`;
    $('#ov-warning').textContent=status || '';
    $('#ov-macro').innerHTML=macro();
    $('#ov-datalist').innerHTML=d.rows.map(r=>`<option value="${esc(r.t)}">${esc(r.n)}</option>`).join('');
    lastData=d.exported_at;
    if(!page.hidden) probe();
  }
  function show(on) {
    document.body.classList.toggle('so-overview',on);
    page.hidden=!on;
    if(on){api.showTab('overview'); render();}
    $('#ov-tab').classList.toggle('on',on);
    if(on) requestAnimationFrame(()=>{page.style.setProperty('--ov-height',`${Math.max(300,innerHeight-page.getBoundingClientRect().top)}px`);requestAnimationFrame(probe);});
  }
  // Layout probe for headless QA (read via --dump-dom): does the page fit the viewport, and how many rows are fully visible.
  function probe() {
    const sc=page.querySelector('.ov-table-scroll'), bottom=sc.getBoundingClientRect().bottom;
    page.dataset.fit=document.documentElement.scrollHeight<=innerHeight+1?'yes':'no';
    page.dataset.visibleRows=[...page.querySelectorAll('#ov-tbody tr')].filter(tr=>tr.getBoundingClientRect().bottom<=bottom+1).length;
  }
  function openTicker(t) { show(false); api.showTab('markets'); api.select('t',t); }
  function mount() {
    api=root.SO2;
    root.SmartOptionsWatchlist=createWatchlist(localStorage,()=>[],notice);
    const tab=document.createElement('button');tab.id='ov-tab';tab.textContent='Overview';tab.dataset.tab='overview';{const fl=$('#fl-tab');if(fl)fl.after(tab);else $('#tabs').prepend(tab);}
    const analyst=$('#tabs [data-tab="markets"]');if(analyst) analyst.textContent='Analyst';
    page=document.createElement('main');page.id='pg-overview';page.hidden=true;
    page.innerHTML=`<section class="ov-watch"><div class="ov-toolbar"><div><h1>Watchlist <span id="ov-count"></span></h1><p>Price & fundamentals · Pin the companies you want to follow. Select a ticker to explore; pin your own names.</p></div><div class="ov-tools"><button id="ov-edge-desk" type="button" style="background:rgba(229,173,76,.18);border-color:#e5ad4c;color:#ffd885;font-weight:700" title="Open the lean Options income + Edge & Alpha Finder + Macro Stress Desk">Options and risk tools</button><div class="ov-scope-bar" role="group" aria-label="Universe scope" style="display:inline-flex;gap:4px"><button type="button" data-ov-scope="watch" class="on">Watchlist</button><button type="button" data-ov-scope="book">My Book</button><button type="button" data-ov-scope="movers">Movers</button><button type="button" data-ov-scope="all">Covered S&amp;P universe</button></div><input id="ov-search" type="search" aria-label="Filter watchlist" placeholder="Filter ticker / sector"><form id="ov-add"><input id="ov-symbol" aria-label="Ticker to pin" list="ov-datalist" placeholder="Pin ticker" maxlength="15"><datalist id="ov-datalist"></datalist><button type="submit" title="Pin ticker to watchlist">+</button></form><button id="ov-demo-book" type="button" title="Load or undo a 6-stock sample portfolio with share counts and cost basis">Load Demo Book</button><button id="ov-add-data">Add data</button></div></div><div id="ov-book-stress"></div><div id="ov-warning" role="status"></div><div class="ov-table-scroll"><table id="ov-table"><thead id="ov-thead"></thead><tbody id="ov-tbody"></tbody></table><div id="ov-empty" hidden>No matching watchlist symbols. Pin a ticker or add a file.</div></div></section><section class="ov-macro-section"><div class="ov-section-label">Macro context <span>Observation periods shown · source details on hover · changes are not trading signals</span></div><div id="ov-macro"></div></section><footer class="ov-foot">Snapshot data, not live quotes · missing = unavailable · educational analysis <span id="ov-local-status">Your imports stay in this browser</span> · <a href="legacy/index.html" target="_blank" rel="noopener">Original screener</a></footer>`;
    $('#pg-markets').before(page);
    page.insertAdjacentHTML('afterbegin', '<div id="ov-today"></div>');
    // Keep body class / page in step with whichever tab is on (Flow and app.js switch tabs without telling us).
    new MutationObserver(()=>{const on=tab.classList.contains('on');document.body.classList.toggle('so-overview',on);if(!on)page.hidden=true;}).observe(tab,{attributes:true,attributeFilter:['class']});
    $('#tabs').addEventListener('click',e=>{const b=e.target.closest('[data-tab]');if(!b)return;if(b.dataset.tab==='overview'){e.stopImmediatePropagation();show(true);}else show(false);},true);
    page.addEventListener('click',e=>{
      if(e.target.closest('#ov-edge-desk') && root.SmartOptionsEdgeDesk){show(false);root.SmartOptionsEdgeDesk.show('pocket');return;}
      const scBtn=e.target.closest('[data-ov-scope]');if(scBtn){ovScope=scBtn.dataset.ovScope;render();return;}
      const hBtn=e.target.closest('[data-book-hedge]');if(hBtn){const tk=hBtn.dataset.bookHedge;show(false);api.showTab('markets');if(root.SmartOptionsAPI && root.SmartOptionsAPI.open_ticker_tab)root.SmartOptionsAPI.open_ticker_tab(tk,'strategies');else api.select('t',tk);return;}
      const macro=e.target.closest('[data-macro-series]');if(macro){const id=macro.dataset.macroSeries;if(root.SmartOptionsExplore && root.SmartOptionsExplore.factor)root.SmartOptionsExplore.factor(id);else{show(false);api.showTab('markets');api.select('s',id);}return;}
      const task=e.target.closest('[data-task]');if(task && root.SO2_flow){root.SO2_flow.launchTask(task.dataset.task, task);return;}
      if(e.target.closest('.ov-analyst-why')) return;
      const unpin=e.target.closest('[data-unpin]');if(unpin){root.SmartOptionsWatchlist.remove(unpin.dataset.unpin);return;}
      const th=e.target.closest('[data-sort]');if(th){const key=th.dataset.sort;sort={key,dir:sort.key===key?-sort.dir:key==='t'||key==='er'?1:-1};render();return;}
      const row=e.target.closest('[data-overview-t]');if(row){e.preventDefault();openTicker(row.dataset.overviewT);}
    });
    page.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.matches('tr[data-overview-t]'))openTicker(e.target.dataset.overviewT);});
    $('#ov-search').addEventListener('input',e=>{query=e.target.value.toLowerCase();render();});
    $('#ov-add').addEventListener('submit',e=>{e.preventDefault();const t=$('#ov-symbol').value.trim().toUpperCase();if(!api.D().rows.some(r=>r.t===t)){notice('Ticker is not in this dashboard’s sourced universe.');return;}root.SmartOptionsWatchlist.add(t);$('#ov-symbol').value='';});
    $('#ov-add-data').addEventListener('click',()=>root.SmartOptionsImport ? root.SmartOptionsImport.open() : notice('Import is still loading.'));
    const demoBtn = $('#ov-demo-book');
    if (demoBtn) demoBtn.addEventListener('click', () => {
      try {
        const raw = localStorage.getItem('so_import_v1');
        const cur = raw ? JSON.parse(raw) : {book: {}, metrics: null, series: []};
        if (prevBookBackup !== null) {
          cur.book = prevBookBackup;
          prevBookBackup = null;
          localStorage.setItem('so_import_v1', JSON.stringify(cur));
          demoBtn.textContent = 'Load Demo Book';
          if (ovScope === 'book' && !Object.keys(cur.book || {}).length) ovScope = 'watch';
          notice('Restored previous My Book state.');
        } else {
          prevBookBackup = cur.book || {};
          cur.book = {};
          for (const item of DEMO_BOOK) cur.book[item.t] = {qty: item.qty, cost: item.cost};
          localStorage.setItem('so_import_v1', JSON.stringify(cur));
          root.SmartOptionsWatchlist.add(DEMO_BOOK.map(x => x.t));
          demoBtn.textContent = 'Undo Demo Book';
          notice('Loaded 6-position sample book (NVDA, MSFT, AAPL, JPM, XOM, LLY) with portfolio factor betas & stress test.');
        }
        root.dispatchEvent(new CustomEvent('so:import'));
        render();
      } catch (err) { notice('Could not load demo book: ' + err.message); }
    });
    root.addEventListener('so:import',render);
    root.addEventListener('so:flow-ready',render);
    root.addEventListener('resize',()=>{if(!page.hidden)page.style.setProperty('--ov-height',`${innerHeight-page.getBoundingClientRect().top}px`);});
    root.SmartOptionsOverview={render,show:()=>show(true),openTicker,compare:()=>{query='';sort={key:'pef',dir:1};$('#ov-search').value='';show(true);$('#ov-warning').textContent='Comparing your watchlist by forward P/E, low to high. Missing values appear last; open a company for context.';const heading=$('#ov-thead button[data-sort="pef"]');if(heading)heading.focus();}};
    render(); show(defaultLanding || initialHash.get('tab')==='overview');
    setInterval(()=>{if(lastData!==api.D().exported_at)render();},5000);
    root.dispatchEvent(new CustomEvent('so:overview-ready'));
  }
  let tries=0;
  const timer=setInterval(()=>{if(root.SO2_ready){clearInterval(timer);mount();}else if(++tries>300){clearInterval(timer);console.warn('[R5 overview] App data did not become ready.');}},20);
})(typeof window !== 'undefined' ? window : globalThis);
