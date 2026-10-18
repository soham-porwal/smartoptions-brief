(function(root){
  'use strict';
  const News=root.SmartOptionsNews||(typeof require==='function'?require('./news.js'):null);
  let liveNews=null;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const url=v=>typeof v==='string'&&/^https:\/\//.test(v)?v:'#';
  const number=v=>typeof v==='number'&&Number.isFinite(v);
  const count=v=>number(v)?v.toLocaleString('en-US'):'Unavailable';
  function sectors(core){
    const groups={};
    for(const r of core?.rows||[]){
      if(r.sp500_member!==true||!number(r.d5))continue;
      const s=r.sec||'Unclassified';(groups[s]||=[]).push(r);
    }
    return Object.entries(groups).map(([name,rows])=>({name,n:rows.length,return_pct:rows.reduce((s,r)=>s+r.d5,0)/rows.length,
      positive:rows.filter(r=>r.d5>0).length,tickers:rows.sort((a,b)=>b.d5-a.d5).slice(0,3).map(r=>r.t)})).sort((a,b)=>b.return_pct-a.return_pct);
  }
  function render(data,core){
    const activity=sectors(core), news=data.news||[], managers=data.managers||[];
    // Daily capital warnings can predate an independent successful news update.
    // The news layer owns its current per-source failure/retention disclosure.
    const warnings=(data.warnings||[]).filter(w=>!data.news_status||!/^News\b/.test(w));
    const overview=activity.length?`${activity[0].name} led the five-session equal-weight sector returns (${activity[0].return_pct.toFixed(1)}%). This measures price leadership, rather than dollars entering a sector.`:'Sector comparison unavailable for this snapshot.';
    return `<section class="mf-page"><header><div class="mf-eyebrow">Context for research</div><h1>Capital &amp; news</h1><p>Major investments, spending and reported positionsâ€”alongside the market evidence they may help explain.</p></header>
      <div class="mf-basis">Snapshot ${esc(core?.asof_session||'unavailable')} Â· Context collected ${esc(data.generated_at?new Date(data.generated_at).toLocaleString():'unavailable')}</div>
      ${warnings.length?`<details class="mf-warning"><summary>Some context is unavailable or cached</summary><ul>${warnings.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></details>`:''}
      <section aria-labelledby="mf-news"><h2 id="mf-news">Investment and business news</h2><p class="mf-caption">The short explanation describes a possible mechanism. It does not establish an effect on a stock.</p>
      <div class="mf-live-news">${News?News.render(data,core):'<p>News renderer unavailable.</p>'}</div></section>
      <section aria-labelledby="mf-sector"><h2 id="mf-sector">Sector leadership</h2><p>${esc(overview)}</p><details><summary>Compare all sectors Â· ${esc(core?.asof_session||'unknown date')}</summary><div class="mf-table"><table><thead><tr><th>Sector</th><th>5 sessions</th><th>Advancing</th><th>Leaders</th></tr></thead><tbody>${activity.map(s=>`<tr><th>${esc(s.name)}</th><td>${s.return_pct>0?'+':''}${s.return_pct.toFixed(1)}%</td><td>${s.positive}/${s.n}</td><td>${s.tickers.map(t=>`<a href="#/company/${encodeURIComponent(t)}">${esc(t)}</a>`).join(' ')}</td></tr>`).join('')}</tbody></table></div><p class="mf-caption">Arithmetic mean of available constituent five-session returns, with current index membership. Company fundamentals and factor exposures are in each company workspace. Price leadership is not net capital flow.</p></details></section>
      <section aria-labelledby="mf-holdings"><h2 id="mf-holdings">Large investor disclosures</h2><p>These are quarter-end holdings, usually disclosed up to 45 days later. Share changes can reflect trades, transfers or corporate actions.</p>
      ${managers.map(m=>`<details class="mf-manager"><summary>${esc(m.name)} <span>${esc(m.current?.period||m.status)}</span></summary><p>${esc(m.reason||m.note||'')}</p>${m.current?`<p class="mf-caption">Positions ${esc(m.prior?.period)} â†’ ${esc(m.current.period)} Â· latest filed ${esc(m.current.filed)} Â· <a href="${esc(url(m.current.url))}" target="_blank" rel="noopener noreferrer">SEC information table</a></p>`:''}
      ${m.changes?.length?`<div class="mf-table"><table><thead><tr><th>Reported position</th><th>Change in shares</th><th>Context</th></tr></thead><tbody>${m.changes.slice(0,10).map(r=>`<tr><th>${r.ticker?`<a href="#/company/${encodeURIComponent(r.ticker)}">${esc(r.issuer)}</a>`:esc(r.issuer)}<small>${esc(r.title)}</small></th><td>${r.share_change>0?'+':''}${count(r.share_change)}<small>${esc(r.status)}</small></td><td>${r.share_change_pct===null?'No prior reported position':number(r.share_change_pct)?r.share_change_pct.toFixed(1)+'% vs prior shares':'Unavailable'}</td></tr>`).join('')}</tbody></table></div>`:'<p class="mf-empty">Comparable positions unavailable; no changes inferred.</p>'}</details>`).join('')}</section>
      <details class="mf-methods"><summary>Sources and interpretation</summary><p>${esc(data.methods?.interpretation||'Use observation and disclosure dates before drawing conclusions.')}</p><p><a href="${esc(url(data.methods?.holdings))}" target="_blank" rel="noopener noreferrer">SEC 13F guide</a> Â· <a href="${esc(url(data.methods?.news))}" target="_blank" rel="noopener noreferrer">Finnhub news documentation</a></p></details></section>`;
  }
  async function mount(el){
    liveNews?.destroy();
    el.innerHTML='<p class="mf-empty" role="status">Loading capital and news contextâ€¦</p>';
    try{
      const response=await fetch('data/money-flow.json',{cache:'no-store'});
      if(!response.ok)throw Error('Context unavailable');
      const data=await response.json();
      if(data.schema!=='smartoptions.capital.v1')throw Error('Context format unavailable');
      if(!el.isConnected)return;
      el.innerHTML=render(data,root.SO2?.D?.()||{});
      liveNews=News?.mount(el.querySelector('.mf-live-news'),{core:()=>root.SO2?.D?.()||{},initialData:data});
    }catch{
      if(el.isConnected)el.innerHTML='<section class="mf-page"><h1>Capital &amp; news</h1><p role="status">Sourced context is currently unavailable. Company and market calculations remain available.</p></section>';
      try{root.localStorage?.setItem('so_capital_last_error',JSON.stringify({at:new Date().toISOString(),status:'context_unavailable'}));}catch{}
    }
  }
  const api={mount,sectors,render};root.MoneyFlow=api;if(root.SO2)root.SO2.MoneyFlow=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window==='undefined'?globalThis:window);
