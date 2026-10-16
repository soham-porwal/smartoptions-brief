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
    const core=Object.fromEntries(raw.rows.map(r=>[r.t,r]));
    const rows=(root.SmartOptionsUniverse?.rows||[]).filter(r=>core[r[0]]);
    for(const r of raw.rows)if(!rows.some(x=>x[0]===r.t))rows.push([r.t,r.n,r.sec]);
    const wl=root.SmartOptionsWatchlist;
    return {brief,core,quotes:quotes?.quotes||{},quotesMeta:quotes,universe:rows,covered:new Set(Object.keys(core)),watch:wl?wl.get():[],company:{},now:new Date(),page:{ticker:(root.location?.hash.match(/^#\/company\/([^/]+)/)||[])[1]},get};
  }
  async function answer(question,direct,signal,plannerConfig){
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
  return {answer,context,record,events};
});
