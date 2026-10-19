/* Fresh context per turn. Static fundamentals are revalidated by the browser cache. */
'use strict';
(function(root,factory){const M=factory(root);if(typeof module!=='undefined'&&module.exports)module.exports=M;root.SmartOptionsBriefChat=M;})(typeof window!=='undefined'?window:globalThis,function(root){
  const events=[];
  function record(status,stage,detail){const e={at:new Date().toISOString(),status,stage,detail:String(detail).slice(0,180)};events.push(e);if(events.length>60)events.shift();if(root.document){try{root.sessionStorage.setItem('so-chat-diagnostics',JSON.stringify(events));}catch(err){root.document.dispatchEvent(new CustomEvent('so-chat-warning',{detail:'Chat diagnostics storage unavailable.'}));}}return e;}
  async function context(signal){
    async function get(path,optional){
      try{const r=await root.fetch('data/'+path,{cache:'no-cache',signal});if(!r.ok)throw new Error(path+' HTTP '+r.status);return await r.json();}
      catch(e){if(e.name==='AbortError')throw e;record(optional?'WARN':'FAIL','load',path+' unavailable');if(!optional)throw new Error('Dashboard data unavailable: '+path);return null;}
    }
    const [brief,raw,quotes]=await Promise.all([get('brief.json'),get('core.json'),get('quotes.json',true)]);
    if(!Array.isArray(raw.rows)||!raw.rows.length)throw new Error('The core file contains no company rows.');
    const L=root.SmartOptionsLive; const canonical=L&&L.snapshot?L.snapshot():quotes;
    const core=Object.fromEntries(raw.rows.map(r=>[r.t,L&&L.currentRow?L.currentRow(r):r]));
    if(L&&canonical?.quotes)canonical.quotes=Object.fromEntries(Object.entries(canonical.quotes).map(([t,q])=>[t,L.get?.(t)||q]));
    // Main's Today model is explicitly completed-session analysis. Quote-dependent
    // company rows remain canonical below; a tick must not rewrite its market signals.
    const currentBrief=root.SmartOptionsMain?brief:L&&L.currentBrief?L.currentBrief(brief,canonical):brief;
    const rows=(root.SmartOptionsUniverse?.rows||[]).filter(r=>core[r[0]]);
    for(const r of raw.rows)if(!rows.some(x=>x[0]===r.t))rows.push([r.t,r.n,r.sec]);
    const wl=root.SmartOptionsWatchlist;
    return {brief:currentBrief,publicCore:raw,core,quotes:canonical?.quotes||{},quotesMeta:canonical,universe:rows,covered:new Set(Object.keys(core)),watch:wl?wl.get():[],company:{},now:new Date(),page:{ticker:(root.location?.hash.match(/^#\/company\/([^/]+)/)||[])[1]},get};
  }
  function personalQuestion(question){
    return /\b(my|our)\b.{0,80}\b(positions?|holdings?|portfolio|book|notes?|research note|review|checkpoint|shares?|cost|basis|exposure|worth|quantit(?:y|ies))\b|\b(i|we)\s+(own|hold|have|bought|paid|purchased|am\s+long|are\s+long)\b|\b(i['’]m|i am|we['’]re|we are)\s+(holding|long|buying|selling)\b|\bwhat\s+did\s+(i|we)\s+pay\b|\b(private|personal)\s+(note|position|review)|\b(my|our)\s+(?:[0-9,.]+\s+)?[A-Z]{1,6}\b|\b[0-9][0-9,.]*\s*(shares?|units?|lots?)\b|\b(cost(?: basis)?|basis|paid|average cost|avg cost|purchase price)\s*(of|was|is|:|=|at)?\s*\$?[0-9]/i.test(question) || /\b[0-9][0-9,.]*\s+[A-Z]{1,6}\s+(at|@)\s*\$?[0-9]/.test(question);
  }
  // Current-news questions: same-origin published collection only; headline text is data, never instructions or a model prompt.
  const NEWS_RE=/\b(news|headlines?|latest|what(?:['’]s| has| is)?\s+(?:changed|happened|new|going on)|developments?|watch(?:ing)?\s+for|what to watch|this week|catalysts?|updates?)\b/i;
  const THEME_WORDS={oil:/\b(oil|crude|opec|energy)\b/i,rates:/\b(rates?|yields?|fed|treasur\w*)\b/i,dollar:/\b(dollar|currenc\w*)\b/i,volatility:/\b(volatility|vix)\b/i};
  function newsAnswer(question,tickers,ctx,collection,nowMs,asset){
    const N=root.SmartOptionsNews,now=nowMs||Date.now(),clock=v=>Number.isFinite(Date.parse(v))?new Date(v).toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}):'unavailable';
    const theme=Object.keys(THEME_WORDS).find(k=>THEME_WORDS[k].test(question))||'';
    const names=Object.fromEntries(tickers.map(t=>[t,ctx.core?.[t]?.n||'']));
    const label=tickers.length?tickers.join(', '):theme?theme+' themes':'the market';
    const out={intent:'news',title:'Latest news: '+label,lines:[],facts:[],na:null,followups:[],noPolish:true};
    // Issuer headlines first (on-demand relay); the broader published collection follows as separate context.
    let fid=0;
    for(const d of asset||[]){if(!d)continue;const name=ctx.core?.[d.symbol]?.n||'',items=(d.items||[]).map(n=>({...n,...N.assetRelevance(n,name)})).sort((a,b)=>(b.issuer-a.issuer)||Date.parse(b.published_at)-Date.parse(a.published_at)).slice(0,4);
      out.lines.push({text:d.symbol+' issuer headlines from '+(d.provider||'the issuer news relay')+(d.attempted_at?', checked '+clock(d.attempted_at):'')+(d.retrieved_at?', last successful provider read '+clock(d.retrieved_at):'')+(d.status==='stale'?' (retained, not refreshed)':'')+(d.status==='empty'?': none returned. That is not evidence that nothing happened.':d.status==='ok'||d.status==='stale'?':':': unavailable. '+(d.error||'')),refs:[]});
      for(const n of items){const id='a'+(++fid);out.facts.push({id,text:'Headline ('+n.label+')',display:String(n.headline).slice(0,240),value:null,unit:'',period:'Published '+clock(n.published_at),asof:'Provider read '+clock(d.retrieved_at),source:String(n.publisher||'Publisher'),url:n.url,ticker:d.symbol});
        out.lines.push({text:(n.issuer?'Reported':'Context')+' by '+n.publisher+', published '+clock(n.published_at)+' ('+n.label+'): “'+String(n.headline).slice(0,240)+'”',refs:[id]});}}
    if(!N||!collection||collection.schema!=='smartoptions.capital.v1'||!Array.isArray(collection.news)){out.na='The published news collection is unavailable right now, so no headline is reported. Prices and fundamentals remain on the page with their own dates.';return out;}
    const m=N.model(collection,now,tickers.length||theme?N.matcher({tickers,names,scenario:theme}):null),items=m.items.slice().sort((a,b)=>Date.parse(b.published_at)-Date.parse(a.published_at)).slice(0,5);
    const age=Number.isFinite(m.ageHours)?Math.max(0,Math.round(m.ageHours*60)):null;
    out.lines.push({text:(asset?.length?'Broader published collection (market and shortlist context): ':'')+'Collection attempted '+clock(m.collected)+(age!=null?' ('+(age<120?age+' minutes':Math.round(age/60)+' hours')+' ago)':'')+(m.stale?'; the collection is stale, so newer developments may be missing':'')+'. Company and market headlines expire after four days.',refs:[]});
    items.forEach((n,i)=>{const id='n'+(i+1);out.facts.push({id,text:'Headline',display:String(n.headline).slice(0,240),value:null,unit:'',period:'Published '+clock(n.published_at),asof:'Upstream retrieved '+clock(n.retrieved_at||m.collected),source:String(n.source||'Publisher'),url:/^https:\/\//.test(n.url||'')?n.url:'',ticker:(n.tickers||[])[0]||''});
      out.lines.push({text:'Reported by '+(n.source||'a publisher')+', published '+clock(n.published_at)+(n.ageHours>72?' (older than 72 hours)':'')+(n.retained?' (retained from an earlier collection)':'')+': “'+String(n.headline).slice(0,240)+'”',refs:[id]});});
    if(!items.length)out.lines.push({text:'No unexpired dated headline in the published collection matches '+label+'. That does not mean nothing happened; the collection covers a bounded set of sources.',refs:[]});
    else out.lines.push({text:'Interpretation, not reported fact: '+(items[0].reason||'a headline alone does not measure an effect on price')+' No headline is treated as the cause of a price move.',refs:[]});
    for(const t of tickers.slice(0,2)){const L=root.SmartOptionsLive,q=L?.get?.(t)||ctx.quotes?.[t],r=ctx.core?.[t];
      if(q&&typeof q.price==='number'&&q.current_usable!==false)out.lines.push({text:t+' quote observation: $'+q.price.toFixed(2)+' observed '+clock(q.asof_utc||q.ts)+' ('+(q.provider||'quote feed')+'). Quote time is separate from headline publication and collection times.',refs:[]});
      else if(r&&typeof r.px==='number')out.lines.push({text:t+' reference close: $'+r.px.toFixed(2)+' on '+(r.pxd||'the exported session')+'. No current quote observation is available; this is not a live price.',refs:[]});}
    if(/\b(watch|this week|upcoming|catalysts?|next)\b/i.test(question)){
      const today=new Date(now).toISOString().slice(0,10),horizon=new Date(now+8*864e5).toISOString().slice(0,10),ev=[];
      for(const t of tickers)for(const e of ctx.company?.[t]?.events?.items||[])ev.push(e);
      for(const e of ctx.brief?.risks||[])if((e.tickers||[]).some(t=>tickers.includes(t))&&!ev.some(x=>x.title===e.title))ev.push(e);else if(!tickers.length&&e.kind==='macro')ev.push(e);
      const up=ev.filter(e=>{const d=String(e.when_et||'').slice(0,10);return d>=today&&d<=horizon;}).sort((a,b)=>String(a.when_et).localeCompare(String(b.when_et))).slice(0,4);
      out.lines.push(...(up.length?up.map(e=>({text:'Scheduled '+String(e.when_et).slice(0,10)+': '+e.title+(e.timing?' ('+String(e.timing).toUpperCase()+')':'')+'. Provider dates can change.',refs:[]})):[{text:'No dated earnings or release for '+label+' is recorded in the next eight days of the published calendar.',refs:[]}]));
    }
    if(m.expired)out.lines.push({text:m.expired+' expired or invalid matching item'+(m.expired===1?' was':'s were')+' withheld.',refs:[]});
    return out;
  }
  async function loadRooms(){
    if(root.SmartOptionsMyDashboard||!root.document)return;
    await new Promise((resolve,reject)=>{const s=root.document.createElement('script');s.src='my-dashboard.js?v=client-20261018-adaptive-rooms2';s.onload=resolve;s.onerror=()=>reject(new Error('Saved rooms failed to load.'));root.document.head.appendChild(s);});
  }
  async function answer(question,direct,signal,plannerConfig){
    // Fence personal questions before context, remote planning and automatic rephrasing.
    if(!direct && personalQuestion(question)) {
      return {result:{intent:'private',title:'Private local review',lines:[{text:'Positions, research notes and review checkpoints stay in this browser. Open For you or Your positions to review them locally.',refs:[]}],facts:[],na:null,followups:[],noPolish:true},ctx:null,route:null};
    }
    if(!direct&&/\b(war\s?rooms?|rooms?|workspaces?|dashboards?|my dash|widgets?|layout|thesis)\b/i.test(question)){try{await loadRooms();}catch(e){record('FAIL','rooms',e.message);throw e;}}
    if(!direct&&root.SmartOptionsMyDashboard){
      const d=await root.SmartOptionsMyDashboard.command(question,plannerConfig);
      if(d.handled){const receipt=d.receipt;return {result:{intent:'dashboard',title:'My Dash',lines:[{text:receipt.text,refs:[]}],facts:[],na:null,action:{kind:'dashboard'},receipt,followups:[]},ctx:null,route:null};}
    }
    const ctx=await context(signal),I=root.SmartOptionsIntents,F=root.SmartOptionsFacts;
    const route=direct ? I.validate(direct,ctx) : I.route(question,ctx);
    if(!route)throw new Error('That question chip is invalid.');
    if(!direct && !route.entities.tickers.length && ctx.page.ticker && /\b(this company|this stock|this card)\b/i.test(question))route.entities.tickers=[ctx.page.ticker];
    await Promise.all(F.needs(route.intent,route.entities).map(async t=>{const c=await ctx.get('brief/company/'+encodeURIComponent(t)+'.json',true);if(c)ctx.company[t]=c;}));
    if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
    let result;
    const newsTickers=(route.entities.tickers||[]).slice(0,4);
    if(!direct&&NEWS_RE.test(question)&&(newsTickers.length||/\b(news|headlines?)\b/i.test(question))){
      if(newsTickers.length)await Promise.all(newsTickers.filter(t=>!ctx.company[t]).map(async t=>{const c=await ctx.get('brief/company/'+encodeURIComponent(t)+'.json',true);if(c)ctx.company[t]=c;}));
      const Nw=root.SmartOptionsNews;
      // Same validated, newest-wins collection as Today; this site's file alone if the shared loader is absent.
      const collection=Nw?.loadCollection?await Nw.loadCollection({signal}).catch(e=>{if(e.name==='AbortError')throw e;record('WARN','news',e.message);return null;}):await ctx.get('money-flow.json',true);
      if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
      // Foreground, on demand: one issuer-news read per named ticker (max two), public ticker only.
      let asset=[];
      if(newsTickers.length&&Nw?.fetchAssetNews){const cfg=await ctx.get('config.json',true);asset=await Promise.all(newsTickers.slice(0,2).map(t=>Nw.fetchAssetNews(cfg||{},t,{signal}).catch(e=>{if(e.name==='AbortError')throw e;return {symbol:t,status:'error',items:[],error:e.message};})));asset=asset.filter(d=>d.status!=='unconfigured');}
      if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
      result=newsAnswer(question,newsTickers,ctx,collection,undefined,asset);
      if(result.na)record('WARN','news',result.na);
      return {result,ctx,route};
    }
    if(!direct&&root.SmartOptionsRelationships?.matches(question)){
      const intelligence=await ctx.get('intelligence.json',true);
      result=root.SmartOptionsRelationships.answer(route.entities.tickers[0]||ctx.page.ticker||null,intelligence);
    }else result=F.answer(route.intent,route.entities,ctx);
    if(result.action){try{const receipt=await root.SmartOptionsActions.execute(result.action);result.lines=[{text:receipt.text,refs:[]}];result.receipt=receipt;}catch(e){record('FAIL','action',e.message);result.na='Action not completed: '+e.message;result.lines=[];} }
    if(result.intent==='unknown'){
      const ids=[...(route.suggestions||[]),'pulse','risks','shortlist'].filter((v,i,a)=>a.indexOf(v)===i).slice(0,3);
      result.followups=ids.map(id=>({intent:id,entities:{tickers:[]}}));
    }
    if(result.na)record('WARN','answer',result.intent+': '+result.na);
    return {result,ctx,route};
  }
  return {answer,context,record,events,personalQuestion,newsAnswer,NEWS_RE};
});
