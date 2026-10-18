(function(root){
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const HOUR=36e5,REFRESH=5*60e3;
  const clock=v=>Number.isFinite(Date.parse(v))?new Date(v).toLocaleString('en-US',{timeZone:'America/Los_Angeles',timeZoneName:'short'}):'unavailable';
  function model(data,now=Date.now()){
    const state=data.news_status||{},collected=Date.parse(state.retrieved_at),age=(now-collected)/HOUR;
    const valid=(data.news||[]).filter(n=>n&&n.headline&&/^https:\/\//.test(n.url||'')&&Number.isFinite(Date.parse(n.published_at)));
    const items=valid.filter(n=>{const age=(now-Date.parse(n.published_at))/HOUR;return age>=-1/6&&age<=24*(n.scope==='official'?30:4);}).map(n=>({...n,ageHours:(now-Date.parse(n.published_at))/HOUR}));
    return {items,expired:valid.length-items.length,ageHours:age,collected:state.retrieved_at,
      stale:!Number.isFinite(age)||age>1||age< -1/6,sources:state.sources||{}};
  }
  function render(data,core,now=Date.now()){
    const m=model(data,now),failed=Object.entries(m.sources).filter(([,s])=>['failed','partial'].includes(s.status)).map(([name])=>name),known=new Set((core?.rows||[]).map(r=>r.t));
    const newest=scope=>Math.max(-Infinity,...m.items.filter(n=>(n.scope||'market')===scope).map(n=>Date.parse(n.published_at)));
    const groups=[['official','Official releases'],['market','Market developments'],['company','Shortlisted companies']].sort((a,b)=>newest(b[0])-newest(a[0]));
    const sources=Object.entries(m.sources).map(([name,s])=>`<li>${esc(name)}: ${esc(s.status)} · upstream retrieved ${esc(clock(s.retrieved_at))}${s.status==='failed'||s.status==='partial'?' · unavailable items retain their original dates':''}${s.symbols?`<ul>${Object.entries(s.symbols).map(([t,v])=>`<li>${esc(t)}: ${esc(v.status)} · ${esc(clock(v.retrieved_at))}</li>`).join('')}</ul>`:''}</li>`).join('');
    return `<p class="small dim" data-news-clock>Collection attempted ${esc(clock(m.collected))} · ${Number.isFinite(m.ageHours)?Math.max(0,Math.floor(m.ageHours*60))+' minutes ago':'age unavailable'}${m.stale?' · <b>collection stale</b>':''}. Reading a published file does not renew upstream dates.</p>${failed.length?`<p class="small">Unavailable or partial this collection: ${esc(failed.join(', '))}. Retained items keep original dates.</p>`:''}${groups.map(([scope,label])=>{
      const rows=m.items.filter(n=>(n.scope||'market')===scope);return rows.length?`<h3>${label}</h3><ul class="news-items">${rows.map(n=>`<li><p class="small dim">Published ${esc(clock(n.published_at))} · ${esc(n.source)} · ${esc(n.category)}${n.ageHours>72?' · <b>older than 72 hours</b>':''}${n.retained?' · <b>retained from an earlier collection</b>':''}</p><p><a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">${esc(n.headline)}</a></p><p class="small">${esc(n.reason)}</p><p class="small dim">Upstream retrieved ${esc(clock(n.retrieved_at))}</p>${(n.tickers||[]).filter(t=>known.has(t)).map(t=>`<a href="#/company/${esc(t)}">${esc(t)} company evidence</a>`).join(' ')}</li>`).join('')}</ul>`:'';
    }).join('')||'<p>No unexpired dated headlines in this collection. That does not mean nothing happened.</p>'}${m.expired?`<p class="small dim">${m.expired} expired or invalid future items withheld.</p>`:''}<p class="small dim">Company and market headlines expire after four days; official releases after 30 days. Older context is marked after 72 hours. No sentiment or price causality is inferred.</p><details class="news-sources"><summary>News source checks and dates</summary><ul>${sources||'<li>Source checks unavailable.</li>'}</ul><p><a href="https://finnhub.io/docs/api/market-news" target="_blank" rel="noopener noreferrer">Finnhub news</a> · <a href="https://www.federalreserve.gov/feeds/feeds.htm" target="_blank" rel="noopener noreferrer">Federal Reserve</a></p></details>`;
  }
  function mount(el,{core,disclosure=null,initialData=null}={}){
    const doc=el.ownerDocument;let suspended=false,timer=null,abort=null,serial=0,last=initialData,lastVersion=Date.parse(initialData?.news_status?.retrieved_at)||-Infinity,lastRender='',due=initialData?Date.now()+REFRESH:0,failures=0,lastPaintData=null,lastPaintMinute=null,lastPaintCore=null;
    const active=()=>{const r=el.getBoundingClientRect();return !suspended&&el.isConnected&&!doc.hidden&&(!disclosure||disclosure.open)&&r.bottom>0&&r.top<root.innerHeight;};
    const log=status=>{try{root.localStorage?.setItem('so_news_last_error',JSON.stringify({at:new Date().toISOString(),status}));}catch{ /* Storage may be denied; visible status remains. */ }};
    const status=doc.createElement('p');status.className='small dim';status.setAttribute('role','status');
    const body=doc.createElement('div');el.replaceChildren(status,body);
    function stop(){clearTimeout(timer);timer=null;if(abort){abort.abort();abort=null;}serial++;}
    function paint(){if(!last)return;const now=Date.now(),minute=Math.floor(now/60000),currentCore=typeof core==='function'?core():core;
      // Scroll/focus wakeups must not repeatedly format every headline date.
      // A fresh payload or minute boundary still updates ages and expiry.
      if(lastPaintData===last&&lastPaintMinute===minute&&lastPaintCore===currentCore)return;
      const html=render(last,currentCore,now);lastPaintData=last;lastPaintMinute=minute;lastPaintCore=currentCore;if(html===lastRender)return;
      const focused=body.contains(doc.activeElement),href=focused?doc.activeElement.getAttribute('href'):null;
      const sourceFocus=focused&&doc.activeElement.matches('.news-sources>summary');
      const open=body.querySelector('.news-sources')?.open;body.innerHTML=html;if(open&&body.querySelector('.news-sources'))body.querySelector('.news-sources').open=true;lastRender=html;
      if(focused){const target=href?[...body.querySelectorAll('a')].find(a=>a.getAttribute('href')===href):sourceFocus?body.querySelector('.news-sources>summary'):null;
        if(target)target.focus({preventScroll:true});else{status.tabIndex=-1;status.focus({preventScroll:true});}}
    }
    async function tick(){
      clearTimeout(timer);timer=null;if(!active()){if(abort)stop();return;}
      paint();
      if(Date.now()>=due&&!abort){
        const token=++serial,controller=new AbortController();abort=controller;
        status.textContent=last?'Checking published news…':'Loading dated headlines…';
        const timeout=setTimeout(()=>controller.abort(),15000);
        try{
          const response=await root.fetch('data/money-flow.json',{cache:'no-store',signal:controller.signal});
          if(!response.ok)throw Error('HTTP '+response.status);
          const data=await response.json(),version=Date.parse(data.news_status?.retrieved_at);
          if(data.schema!=='smartoptions.capital.v1'||!Array.isArray(data.news)||!Number.isFinite(version)||version>Date.now()+600000)throw Error('Invalid news collection');
          if(token!==serial||!active())return;
          if(version<lastVersion)throw Error('Older published collection withheld');
          last=data;lastVersion=version;failures=0;due=Date.now()+REFRESH;paint();
          status.textContent='Published news checked '+clock(new Date().toISOString())+'. Visible headlines check again in five minutes.';
        }catch(e){if(token!==serial||!active())return;failures++;due=Date.now()+Math.min(10*60e3,30000*2**Math.min(5,failures-1));
          status.textContent='Published news check unavailable. '+(last?'Retained headlines keep their original dates. ':'No current collection could be read. ')+'Retrying with backoff while visible.';log('published_news_unavailable');paint();
        }finally{clearTimeout(timeout);if(token===serial)abort=null;}
      }
      if(active())timer=setTimeout(tick,Math.min(60000,Math.max(1000,due-Date.now())));
    }
    const wake=()=>{if(!active()){stop();return;}tick();};
    disclosure?.addEventListener('toggle',wake);doc.addEventListener('visibilitychange',wake);
    root.addEventListener('focus',wake);root.addEventListener('pageshow',wake);root.addEventListener('pagehide',stop);root.addEventListener('scroll',wake,{passive:true});
    const observer=typeof root.IntersectionObserver==='function'?new root.IntersectionObserver(wake):null;observer?.observe(el);
    if(initialData)paint();wake();
    return {suspend(){suspended=true;stop();},resume(){suspended=false;wake();},destroy(){suspended=true;stop();observer?.disconnect();disclosure?.removeEventListener('toggle',wake);doc.removeEventListener('visibilitychange',wake);root.removeEventListener('focus',wake);root.removeEventListener('pageshow',wake);root.removeEventListener('pagehide',stop);root.removeEventListener('scroll',wake);}};
  }
  const api={model,render,mount};root.SmartOptionsNews=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window==='undefined'?globalThis:window);
