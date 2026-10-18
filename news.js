(function(root){
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const HOUR=36e5,REFRESH=5*60e3;
  const clock=v=>Number.isFinite(Date.parse(v))?new Date(v).toLocaleString('en-US',{timeZone:'America/Los_Angeles',timeZoneName:'short'}):'unavailable';
  // Scenario vocabularies are public macro themes only; matching never infers price causality.
  const THEMES={oil:/\b(oil|crude|brent|wti|opec\+?|petroleum|gasoline|refin\w*|hormuz|lng|natural gas)\b/i,rates:/\b(fed|fomc|treasur\w*|yields?|rates?|inflation|cpi|powell)\b/i,dollar:/\b(dollar|currenc\w*|fx|yen|euro|yuan|dxy)\b/i,volatility:/\b(volatility|vix|selloff|sell-off|turmoil|tariffs?|conflict|war)\b/i};
  // Pure: issuer/asset/theme matcher shared by chat answers and saved rooms. Headline text stays data.
  function matcher({tickers=[],names={},scenario=''}={}){
    const ts=tickers.map(t=>String(t).toUpperCase()),words=ts.flatMap(t=>{const n=String(names[t]||'').replace(/\b(inc|corp|corporation|co|company|holdings|group|plc|ltd|the|class [a-z])\b\.?/gi,'').trim().split(/\s+/)[0]||'';return n.length>=4?[n.replace(/[^A-Za-z0-9&-]/g,'')]:[];}).filter(w=>w.length>=4);
    const sym=ts.length?new RegExp('(?:^|[^A-Za-z0-9])\\$?('+ts.map(t=>t.replace(/[.^-]/g,'\\$&')).join('|')+')(?![A-Za-z0-9])'):null,nm=words.length?new RegExp('\\b('+words.join('|')+')\\b','i'):null,theme=THEMES[scenario]||null;
    return n=>{if(!n)return null;const tk=(n.tickers||[]).map(t=>String(t).toUpperCase()),hit=ts.find(t=>tk.includes(t));if(hit)return {kind:'issuer',ticker:hit};const h=String(n.headline||'');let m=sym&&h.match(sym);if(m)return {kind:'issuer',ticker:m[1]};if(nm&&(m=h.match(nm)))return {kind:'name',ticker:ts[words.findIndex(w=>w.toLowerCase()===m[1].toLowerCase())]||ts[0]};if(theme&&(theme.test(h)||theme.test(String(n.category||''))))return {kind:'theme',theme:scenario};return null;};
  }
  function model(data,now=Date.now(),filter=null){
    const state=data.news_status||{},collected=Date.parse(state.retrieved_at),age=(now-collected)/HOUR;
    const valid=(data.news||[]).filter(n=>n&&n.headline&&/^https:\/\//.test(n.url||'')&&Number.isFinite(Date.parse(n.published_at))&&(!filter||filter(n)));
    const items=valid.filter(n=>{const age=(now-Date.parse(n.published_at))/HOUR;return age>=-1/6&&age<=24*(n.scope==='official'?30:4);}).map(n=>({...n,ageHours:(now-Date.parse(n.published_at))/HOUR}));
    return {items,expired:valid.length-items.length,ageHours:age,collected:state.retrieved_at,
      stale:!Number.isFinite(age)||age>1||age< -1/6,sources:state.sources||{}};
  }
  function render(data,core,now=Date.now(),filter=null){
    const m=model(data,now,filter),failed=Object.entries(m.sources).filter(([,s])=>['failed','partial'].includes(s.status)).map(([name])=>name),known=new Set((core?.rows||[]).map(r=>r.t));
    const newest=scope=>Math.max(-Infinity,...m.items.filter(n=>(n.scope||'market')===scope).map(n=>Date.parse(n.published_at)));
    const groups=[['official','Official releases'],['market','Market developments'],['company',filter?'Matched company developments':'Shortlisted companies']].sort((a,b)=>newest(b[0])-newest(a[0]));
    const sources=Object.entries(m.sources).map(([name,s])=>`<li>${esc(name)}: ${esc(s.status)} · upstream retrieved ${esc(clock(s.retrieved_at))}${s.status==='failed'||s.status==='partial'?' · unavailable items retain their original dates':''}${s.symbols?`<ul>${Object.entries(s.symbols).map(([t,v])=>`<li>${esc(t)}: ${esc(v.status)} · ${esc(clock(v.retrieved_at))}</li>`).join('')}</ul>`:''}</li>`).join('');
    return `<p class="small dim" data-news-clock>Collection attempted ${esc(clock(m.collected))} · ${Number.isFinite(m.ageHours)?Math.max(0,Math.floor(m.ageHours*60))+' minutes ago':'age unavailable'}${m.stale?' · <b>collection stale</b>':''}. Reading a published file does not renew upstream dates.</p>${failed.length?`<p class="small">Unavailable or partial this collection: ${esc(failed.join(', '))}. Retained items keep original dates.</p>`:''}${groups.map(([scope,label])=>{
      const rows=m.items.filter(n=>(n.scope||'market')===scope);return rows.length?`<h3>${label}</h3><ul class="news-items">${rows.map(n=>`<li><p class="small dim">Published ${esc(clock(n.published_at))} · ${esc(n.source)} · ${esc(n.category)}${n.ageHours>72?' · <b>older than 72 hours</b>':''}${n.retained?' · <b>retained from an earlier collection</b>':''}</p><p><a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">${esc(n.headline)}</a></p><p class="small">${esc(n.reason)}</p><p class="small dim">Upstream retrieved ${esc(clock(n.retrieved_at))}</p>${(n.tickers||[]).filter(t=>known.has(t)).map(t=>`<a href="#/company/${esc(t)}">${esc(t)} company evidence</a>`).join(' ')}</li>`).join('')}</ul>`:'';
    }).join('')||'<p>No unexpired dated headlines in this collection. That does not mean nothing happened.</p>'}${m.expired?`<p class="small dim">${m.expired} expired or invalid future items withheld.</p>`:''}<p class="small dim">Company and market headlines expire after four days; official releases after 30 days. Older context is marked after 72 hours. No sentiment or price causality is inferred.</p><details class="news-sources"><summary>News source checks and dates</summary>${data.news_origin?.used==='canonical'?`<p class="small">This site's copy (${esc(clock(data.news_origin.local_at))}) trailed the canonical public collection; the newer collection is shown with its original dates.</p>`:data.news_origin?.canonical_error?`<p class="small dim">Canonical collection check unavailable (${esc(data.news_origin.canonical_error)}); this site's copy is shown.</p>`:''}<ul>${sources||'<li>Source checks unavailable.</li>'}</ul><p><a href="https://finnhub.io/docs/api/market-news" target="_blank" rel="noopener noreferrer">Finnhub news</a> · <a href="https://www.federalreserve.gov/feeds/feeds.htm" target="_blank" rel="noopener noreferrer">Federal Reserve</a></p></details>`;
  }
  // One validated collection for Today, rooms and chat. A mirror site also reads the exact public canonical file
  // (Access-Control-Allow-Origin * measured 2026-10-18) because its own copy can trail by a scheduled run.
  // Newer valid news wins; capital/flow fields always stay this site's own. No credentials, referrer or query.
  const CANONICAL_ORIGIN='https://soham-porwal.github.io',CANONICAL_URL=CANONICAL_ORIGIN+'/smartoptions-brief/data/money-flow.json',SHARE_MS=60e3;
  let shared=null;
  const abortError=()=>{try{return new DOMException('Cancelled','AbortError');}catch{const e=Error('Cancelled');e.name='AbortError';return e;}};
  function collectionVersion(d,now){const v=Date.parse(d?.news_status?.retrieved_at);return d&&d.schema==='smartoptions.capital.v1'&&Array.isArray(d.news)&&Number.isFinite(v)&&v<=now+600000?v:null;}
  function pickCollection(local,canonical,now,errors={}){
    const lv=collectionVersion(local,now),cv=collectionVersion(canonical,now);
    if(lv==null&&cv==null)throw Error('Invalid news collection'+(errors.local?' ('+errors.local+')':''));
    const origin={local_at:lv!=null?local.news_status.retrieved_at:null,canonical_at:cv!=null?canonical.news_status.retrieved_at:null,local_error:errors.local||(local&&lv==null?'invalid collection':null),canonical_error:errors.canonical||(canonical&&cv==null?'invalid collection':null)};
    if(cv!=null&&(lv==null||cv>lv))return {...(lv!=null?local:{schema:canonical.schema}),news:canonical.news,news_status:canonical.news_status,news_origin:{...origin,used:'canonical'}};
    return {...local,news_origin:{...origin,used:'local'}};
  }
  function note(status){try{root.localStorage?.setItem('so_news_last_error',JSON.stringify({at:new Date().toISOString(),status}));}catch{ /* Storage may be denied; source details still show the check. */ }}
  async function fetchCollections(f,now,origin){
    const ctrl=typeof AbortController==='function'?new AbortController():null,timer=setTimeout(()=>ctrl?.abort(),15000),errors={};
    const read=async(url,opts)=>{const r=await f(url,{cache:'no-store',signal:ctrl?.signal,...opts});if(!r.ok)throw Error('HTTP '+r.status);return r.json();};
    const mirror=origin!==CANONICAL_ORIGIN;
    try{
      const [local,canonical]=await Promise.all([read('data/money-flow.json',{}).catch(e=>{errors.local=e.message;return null;}),mirror?read(CANONICAL_URL,{mode:'cors',credentials:'omit',referrerPolicy:'no-referrer'}).catch(e=>{errors.canonical=e.message;return null;}):null]);
      const out=pickCollection(local,canonical,now,errors);
      if(mirror&&out.news_origin.canonical_error)note('canonical_news_unavailable: '+out.news_origin.canonical_error);
      return out;
    }finally{clearTimeout(timer);}
  }
  // Callers share one in-flight read for 60 s. A caller's abort rejects only that caller, never the shared request.
  function loadCollection({signal,fetchImpl,now=Date.now(),origin=root.location?.origin}={}){
    const f=fetchImpl||root.fetch;
    if(!shared||now-shared.at>SHARE_MS||now<shared.at||shared.failed||shared.f!==f){const entry={at:now,f};entry.promise=fetchCollections(f,now,origin).catch(e=>{entry.failed=true;throw e;});shared=entry;}
    const p=shared.promise;if(!signal)return p;
    return new Promise((resolve,reject)=>{if(signal.aborted)return reject(abortError());const off=()=>reject(abortError());signal.addEventListener('abort',off,{once:true});
      p.then(v=>{signal.removeEventListener('abort',off);resolve(v);},e=>{signal.removeEventListener('abort',off);reject(e);});});
  }
  function mount(el,{core,disclosure=null,initialData=null,filter=null}={}){
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
      const html=render(last,currentCore,now,filter);lastPaintData=last;lastPaintMinute=minute;lastPaintCore=currentCore;if(html===lastRender)return;
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
          const data=await loadCollection({signal:controller.signal}),version=Date.parse(data.news_status?.retrieved_at);
          if(token!==serial||!active())return;
          if(version<lastVersion)throw Error('Older published collection withheld');
          last=data;lastVersion=version;failures=0;due=Date.now()+REFRESH;paint();
          status.textContent='Published news checked '+clock(new Date().toISOString())+(data.news_origin?.used==='canonical'?' (newer canonical collection; this copy was behind)':'')+'. Visible headlines check again in five minutes.';
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
  // On-demand issuer headlines from the shared Worker (/asset-news). Foreground callers only; one in-page cache
  // per symbol for ten minutes so chat and rooms share a read. Only the public ticker is sent.
  const ASSET_TTL=10*60e3,assetCache=new Map();
  function assetNewsUrl(cfg){
    const own=cfg&&typeof cfg.asset_news_url==='string'?cfg.asset_news_url:'';
    try{const u=new URL(own||cfg?.chat_proxy_url||'');if(u.protocol!=='https:'||u.username||u.password)return '';return own?u.href:u.origin+'/asset-news';}catch{return '';}
  }
  async function fetchAssetNews(cfg,symbol,{signal,fetchImpl,now=Date.now()}={}){
    const url=assetNewsUrl(cfg),t=String(symbol||'').toUpperCase();
    if(!url)return {symbol:t,status:'unconfigured',items:[],error:'Issuer news relay is not configured on this site.'};
    if(!/^[A-Z][A-Z0-9.-]{0,9}$/.test(t))return {symbol:t,status:'error',items:[],error:'Unsupported symbol.'};
    const hit=assetCache.get(t);if(hit&&now-hit.at<ASSET_TTL)return hit.data;
    let data;
    try{const r=await (fetchImpl||root.fetch)(url+'?symbol='+encodeURIComponent(t),{signal,cache:'no-store',credentials:'omit'});
      if(!r.ok)throw Error('HTTP '+r.status);data=await r.json();
      if(data?.schema!=='smartoptions.asset-news.v1'||data.symbol!==t||!Array.isArray(data.items))throw Error('Unexpected response');
      data={...data,items:data.items.filter(n=>n&&typeof n.headline==='string'&&/^https:\/\//.test(n.url||'')&&Number.isFinite(Date.parse(n.published_at))&&Date.parse(n.published_at)<=now+600000).slice(0,10)};
    }catch(e){if(e.name==='AbortError')throw e;const last=hit?.data;return last?{...last,status:'stale',error:'Issuer news check failed ('+e.message+'); last result kept with its original retrieval time.'}:{symbol:t,status:'error',items:[],error:'Issuer news unavailable ('+e.message+').',attempted_at:new Date(now).toISOString()};}
    assetCache.set(t,{at:now,data});return data;
  }
  // Pure: relevance wording. Headline names the issuer -> issuer development; provider tag only -> context.
  function assetRelevance(n,name){
    const word=String(name||'').replace(/\b(inc|corp|corporation|co|company|holdings|group|plc|ltd|the)\b\.?/gi,'').trim().split(/\s+/)[0]||'';
    const named=n.relevance==='symbol_in_headline'||(word.length>=4&&new RegExp('\\b'+word.replace(/[^A-Za-z0-9&-]/g,'')+'\\b','i').test(n.headline));
    return {issuer:named,label:(named?'Issuer named in headline':'Provider-tagged context, issuer not named')+(n.kind==='opinion_or_research'?' · opinion or research':'')};
  }
  function renderAsset(data,name,now=Date.now()){
    const t=esc(data.symbol),items=(data.items||[]).map(n=>({...n,...assetRelevance(n,name)})).sort((a,b)=>(b.issuer-a.issuer)||Date.parse(b.published_at)-Date.parse(a.published_at));
    const state=data.status==='ok'?'':data.status==='empty'?'No recent provider headlines for '+t+'. That is not evidence that nothing happened.':data.status==='unconfigured'?esc(data.error):esc(data.error||'Issuer news unavailable.');
    return `<div class="news-asset" data-asset-news="${t}"><h3>${t} headlines · ${esc(data.provider||'Yahoo Finance search')}</h3><p class="small dim">Checked ${esc(clock(data.attempted_at))}${data.retrieved_at?' · last successful provider read '+esc(clock(data.retrieved_at)):''}${data.status==='stale'?' · <b>retained, not refreshed</b>':''}</p>${state?`<p class="small">${state}</p>`:''}${items.length?`<ul class="news-items">${items.slice(0,6).map(n=>{const age=(now-Date.parse(n.published_at))/HOUR;return `<li><p class="small dim">Published ${esc(clock(n.published_at))} · ${esc(n.publisher)} · ${esc(n.label)}${age>72?' · <b>older than 72 hours</b>':''}</p><p><a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">${esc(n.headline)}</a></p></li>`;}).join('')}</ul>`:''}</div>`;
  }
  const api={model,render,mount,loadCollection,pickCollection,CANONICAL_URL,_resetShared:()=>{shared=null;},matcher,THEMES,assetNewsUrl,fetchAssetNews,assetRelevance,renderAsset,_assetCache:assetCache};root.SmartOptionsNews=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window==='undefined'?globalThis:window);
