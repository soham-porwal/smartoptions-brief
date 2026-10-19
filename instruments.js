/* Shared public instrument identity, discovery and history. No portfolios, notes, chat text or keys sent. */
'use strict';
(function(root,factory){const api=factory(root);if(typeof module!=='undefined'&&module.exports)module.exports=api;root.SmartOptionsInstruments=api;})(typeof window!=='undefined'?window:globalThis,function(root){
  const KEY='so-public-instruments-v1',PIN='so-public-instruments-pinned-v1',cache=new Map(),catalog=new Map(),pinned=new Map(),historyCache=new Map();let config;
  // Class shares use the provider form (BRK.B -> BRK-B) so one canonical symbol travels through every context.
  const symbol=v=>{const t=String(v||'').trim().replace(/^\$/,'').toUpperCase();return /^[A-Z]{1,5}\.[A-Z]$/.test(t)?t.replace('.','-'):t;};
  // Fund identities that ship with published daily files. Names are the funds' registered names, not metadata claims.
  // Common-fund identities: names/types/exchanges are the provider's own (Yahoo spark meta, retrieved 2026-10-19T05:06:42.510Z,
  // receipt fixtures/instrument-samples/spark-fund-identities.json). Not a security master; history still comes from
  // published files (SPY/RSP) or the shared relay. source/age travel with each identity.
  const SEEN='2026-10-19T05:06:42.510Z',idn=(symbol,name,exchange,src)=>({symbol,name,type:'ETF',currency:'USD',exchange,source:src,identity_source:'Yahoo spark meta',identity_retrieved:SEEN});
  const RETAINED=Object.freeze({SPY:idn('SPY','State Street SPDR S&P 500 ETF Trust','PCX','published'),RSP:idn('RSP','Invesco S&P 500 Equal Weight ETF','PCX','published')});
  const COMMON=Object.freeze({QQQ:idn('QQQ','Invesco QQQ Trust','NGM','common'),VTI:idn('VTI','Vanguard Morningstar Total Stock Market ETF','PCX','common'),TLT:idn('TLT','iShares 20+ Year Treasury Bond ETF','NGM','common')});
  // Name relevance: every meaningful query word must appear in the identity's provider name (ETF/fund/index/shares ignored).
  const STOPW=new Set(['ETF','FUND','INDEX','SHARES','THE','OF','TRUST','AND','&']);
  const words=t=>String(t||'').toUpperCase().replace(/[^A-Z0-9+& ]/g,' ').split(/\s+/).filter(w=>w&&!STOPW.has(w));
  function relevant(a,q){const s=symbol(q);if(a.symbol===s||(!/\s/.test(String(q).trim())&&a.symbol.startsWith(s)))return true;const qw=words(q);if(!qw.length)return false;const nw=new Set(words(a.name));return qw.every(w=>nw.has(w)||[...nw].some(n=>n.startsWith(w)&&w.length>=4));}
  function valid(a){return a&&/^[A-Z][A-Z0-9.-]{0,9}$/.test(a.symbol)&&['ETF','EQUITY'].includes(a.type)&&a.currency==='USD'&&typeof a.name==='string'&&a.name.length<=160;}
  function remember(items){for(const a of items)if(valid(a))catalog.set(a.symbol,{symbol:a.symbol,name:a.name,type:a.type,currency:'USD',exchange:String(a.exchange||'').slice(0,20)});if(catalog.size>300)for(const k of [...catalog.keys()].slice(0,catalog.size-300))catalog.delete(k);try{root.localStorage?.setItem(KEY,JSON.stringify([...catalog.values()]));}catch(e){diagnostic('WARN','Public instrument identities could not be retained.');}}
  function diagnostic(status,detail){try{root.localStorage?.setItem(KEY+'-health',JSON.stringify({status,detail,at:new Date().toISOString()}));}catch(e){root.console?.warn('[instruments] diagnostic storage unavailable');}}
  try{const saved=JSON.parse(root.localStorage?.getItem(KEY)||'[]');if(Array.isArray(saved))for(const a of saved.slice(0,300))if(valid(a))catalog.set(a.symbol,a);}catch(e){diagnostic('WARN','Public identity cache unreadable; saved rooms remain untouched.');}
  // Pinned identities back saved rooms. Append-only, never evicted by the discovery cache; unreadable bytes are kept.
  let pinBlocked=false;try{const raw=root.localStorage?.getItem(PIN);if(raw!=null){const xs=JSON.parse(raw);if(!Array.isArray(xs))throw Error('shape');for(const a of xs)if(valid(a))pinned.set(a.symbol,a);}}catch(e){pinBlocked=true;diagnostic('FAIL','Pinned room identities unreadable; original bytes kept, fund rooms read-only until recovered.');}
  function pin(a){
    if(!valid(a))throw Error('Only a validated US stock or ETF identity can be saved.');
    if(RETAINED[a.symbol]||pinned.has(a.symbol))return true;
    if(pinBlocked)throw Error('Saved fund identities could not be read on this device; nothing was overwritten.');
    if(pinned.size>=200)throw Error('Device limit of 200 saved fund identities reached.');
    const next=new Map(pinned);next.set(a.symbol,{symbol:a.symbol,name:a.name,type:a.type,currency:'USD',exchange:String(a.exchange||'').slice(0,20)});
    const raw=JSON.stringify([...next.values()]);root.localStorage.setItem(PIN,raw);if(root.localStorage.getItem(PIN)!==raw)throw Error('Browser did not retain the fund identity.');
    pinned.clear();next.forEach((v,k)=>pinned.set(k,v));return true;
  }
  const known=t=>RETAINED[t]||COMMON[t]||pinned.get(t)||catalog.get(t)||null;
  // Room universe: companies + retained funds + pinned identities (+ current catalog). funds = every ETF among them.
  function roomUniverse(companyTickers){const u=new Set(companyTickers||[]),funds=new Set();for(const a of [...Object.values(RETAINED),...Object.values(COMMON),...pinned.values(),...catalog.values()]){if(a.type==='ETF'&&!u.has(a.symbol))funds.add(a.symbol);if(a.type==='ETF'||!u.has(a.symbol))u.add(a.symbol);}u.funds=funds;u.identity=t=>known(t);return u;}
  async function cfg(){if(!config)config=root.fetch('data/config.json',{cache:'no-cache'}).then(r=>{if(!r.ok)throw Error('Configuration unavailable');return r.json();}).catch(e=>{config=null;throw e;});return config;}
  async function request(kind,value,{signal,fetchImpl,configuration}={}){
    const c=configuration||await cfg(),base=new URL(c.quotes_proxy_url||c.chat_proxy_url||'');if(base.protocol!=='https:'||base.username||base.password)throw Error('Instrument relay unavailable');
    const url=base.origin+'/instruments/'+kind+'?'+(kind==='search'?'q':'symbol')+'='+encodeURIComponent(value),r=await(fetchImpl||root.fetch)(url,{signal,credentials:'omit',cache:'no-store'});if(!r.ok)throw Error('Instrument relay HTTP '+r.status);
    const d=await r.json();if(d.schema!=='smartoptions.instrument.v1'||d.kind!==kind||d.query.toUpperCase()!==value.toUpperCase()||!['ok','empty','stale','error'].includes(d.status))throw Error('Unexpected instrument response');
    if(d.status==='error')throw Error(d.error||'Provider unavailable');
    if(kind==='search'){if(!Array.isArray(d.items)||d.items.some(a=>!valid(a)))throw Error('Invalid instrument identities');const keep=d.items.filter(a=>relevant(a,value));d.irrelevant=d.items.length-keep.length;d.items=keep;if(!keep.length&&d.status==='ok')d.status='empty';remember(keep);}
    else{if(!valid(d.asset)||d.asset.symbol!==value||!Array.isArray(d.bars)||!d.bars.length)throw Error('Invalid instrument history');remember([d.asset]);if(d.quote)root.SmartOptionsLive?.accept({[value]:d.quote},'instrument-chart');}
    diagnostic(d.status==='empty'?'SUSPECT':d.status==='stale'?'WARN':'OK',kind==='search'?(d.status==='empty'?'No supported US stocks or ETFs matched the provider result.':'Public discovery response accepted.'):'Public daily history accepted.');return d;
  }
  // Local matches: published companies (rows as {t,n,sec} or [t,n,sec]) + retained/pinned/catalog identities.
  function local(q,rows=[]){const s=symbol(q),raw=String(q||'').trim().replace(/^\$/,'').toUpperCase();if(!s)return [];const comp=rows.map(r=>Array.isArray(r)?{symbol:r[0],name:r[1],sector:r[2],type:'EQUITY',currency:'USD',source:'published'}:{symbol:r.t,name:r.n,sector:r.sec,type:'EQUITY',currency:'USD',source:'published',mcap:r.mcap}),all=[...Object.values(RETAINED),...Object.values(COMMON),...comp,...pinned.values(),...catalog.values()],seen=new Set();
    const rank=a=>a.symbol===s?0:a.symbol.startsWith(s)?1:a.name.toUpperCase().startsWith(raw)?2:3;
    return all.filter(a=>!seen.has(a.symbol)&&seen.add(a.symbol)&&(a.symbol.includes(s)||a.name.toUpperCase().includes(raw)||(raw.includes(' ')&&relevant(a,q)))).sort((a,b)=>rank(a)-rank(b)||(b.mcap||0)-(a.mcap||0)||a.symbol.localeCompare(b.symbol)).slice(0,12);}
  async function search(q,opts={}){const value=String(q||'').trim().replace(/^\$/,'');if(!value||value.length>64)return {items:[],status:'empty'};const key=value.toLowerCase(),old=cache.get(key);if(old&&Date.now()-old.at<600000)return old.data;try{const d=await request('search',value,opts);cache.set(key,{at:Date.now(),data:d});return d;}catch(e){if(e.name==='AbortError')throw e;diagnostic('FAIL','Public discovery failed: '+e.message);return {items:[],status:'error',error:e.message};}}
  async function history(t,opts={}){t=symbol(t);if(!/^[A-Z][A-Z0-9.-]{0,9}$/.test(t))throw Error('Unsupported symbol');const hit=historyCache.get(t);if(hit&&Date.now()-hit.at<600000)return hit.data;try{const d=await request('history',t,opts);historyCache.set(t,{at:Date.now(),data:d});return d;}catch(e){if(e.name==='AbortError')throw e;diagnostic('FAIL','Public history failed: '+e.message);if(hit)return {...hit.data,status:'stale',error:e.message};throw e;}}
  async function resolve(t,opts){t=symbol(t);const k=known(t);if(k)return k;const d=await search(t,opts);if(d.status==='error')throw Error('Could not verify '+t+': '+d.error);const a=d.items.find(a=>a.symbol===t);if(!a)throw Error(t+' is not a supported US-listed stock or ETF in this provider result.');return a;}
  function universe(rows=[]){const out=new Set(rows.map(r=>r[0]||r.t));for(const t of catalog.keys())out.add(t);out.isCompany=t=>rows.some(r=>(r[0]||r.t)===t);return out;}
  function bindSearch(input,hits,{rows=()=>[],render,onChoose,exclude=()=>new Set()}){
    let version=0,timer,controller,closed=false;
    const paint=(items,note)=>{const xs=items.filter(a=>!exclude().has(a.symbol));hits.innerHTML=render(xs,note);hits.hidden=closed;};
    const run=()=>{const v=++version;clearTimeout(timer);controller?.abort();closed=false;const q=input.value.trim();if(!q){hits.hidden=true;hits.innerHTML='';return;}const immediate=local(q,rows());paint(immediate,'Checking the wider stock and ETF catalog…');timer=setTimeout(async()=>{controller=new AbortController();const d=await search(q,{signal:controller.signal}).catch(e=>e.name==='AbortError'?null:{items:[],status:'error',error:e.message});if(!d||v!==version||closed)return;if(d.items)remember(d.items);const merged=local(q,rows());paint(merged,d.status==='error'?'Provider unavailable: '+d.error+(merged.length?' Local matches remain available.':' Try again shortly.'):d.status==='stale'?'Retained provider result · '+d.retrieved_at:!merged.length?(d.irrelevant?'The provider returned '+d.irrelevant+' unrelated securities for this name; none were used. Try the ticker.':'No supported US-listed stock or ETF matches. Other exchanges and security types are outside this catalog.'):'US-listed stocks and ETFs · Yahoo Finance');},280);};
    const close=()=>{closed=true;version++;clearTimeout(timer);controller?.abort();hits.hidden=true;};
    input.addEventListener('input',run);input.addEventListener('keydown',e=>{const first=hits.querySelector('[data-instrument]');if(e.key==='Escape'){close();return;}if(first&&!hits.hidden&&['Enter','ArrowDown'].includes(e.key)){e.preventDefault();if(e.key==='Enter')onChoose(first);else first.focus();}});
    hits.addEventListener('keydown',e=>{const options=[...hits.querySelectorAll('[data-instrument]')],i=options.indexOf(e.target.closest('[data-instrument]'));if(e.key==='Escape'){close();input.focus();}if(i>=0&&['Enter',' ','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();if(e.key==='Enter'||e.key===' ')onChoose(options[i]);else (options[i+(e.key==='ArrowDown'?1:-1)]||input).focus();}});
    hits.addEventListener('click',e=>{const a=e.target.closest('[data-instrument]');if(a){e.preventDefault();onChoose(a);}});return {close,run};
  }
  return {symbol,valid,local,search,history,resolve,universe,roomUniverse,pin,RETAINED,COMMON,relevant,get:t=>known(symbol(t)),all:()=>{const m=new Map();for(const a of [...Object.values(RETAINED),...Object.values(COMMON),...pinned.values(),...catalog.values()])m.set(a.symbol,a);return [...m.values()];},bindSearch,diagnostic,_reset:()=>{catalog.clear();pinned.clear();cache.clear();historyCache.clear();pinBlocked=false;}};
});
