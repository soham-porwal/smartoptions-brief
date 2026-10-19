/* Personal, device-local views backed by a typed specification and public deterministic data. */
'use strict';
(function(root,factory){const M=factory(root);if(typeof module!=='undefined'&&module.exports)module.exports=M;root.SmartOptionsMyDashboard=M;})(typeof window!=='undefined'?window:globalThis,function(root){
  const doc=root.document,esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num=v=>typeof v==='number'&&Number.isFinite(v);
  const ST={container:null,store:null,data:{core:null,brief:null,quotes:null,intelligence:null,companies:{},px:{},news:null},errors:[],receipt:null,busy:false,cfg:null,loading:null,newsMounts:[]};
  const HOME=()=>root.SmartOptionsMain?'#/room':'#/my-dash',onHome=()=>root.location?.hash===HOME()||root.location?.hash==='#/my-dash';
  let modules;
  function record(status,stage,detail){if(root.SmartOptionsBriefChat)root.SmartOptionsBriefChat.record(status,stage,detail);else root.console?.warn('[dashboard '+status+'] '+detail);}
  async function ensure(){
    if(!modules)modules=(async()=>{for(const [file,key]of [['universe','SmartOptionsUniverse'],['dashboard','SmartOptionsDashboardSpec'],['relationships','SmartOptionsRelationships']]){if(root[key])continue;if(!doc)throw new Error('Dashboard modules are unavailable.');await new Promise((resolve,reject)=>{const s=doc.createElement('script');s.src='chat/'+file+'.js?v=client-20261019-unified2';s.onload=resolve;s.onerror=()=>reject(new Error('Dashboard module failed to load: '+file));doc.head.appendChild(s);});}})().catch(e=>{modules=null;throw e;});
    await modules;
    if(!ST.store){let storage;try{storage=root.localStorage;}catch(e){record('FAIL','dashboard','Browser storage unavailable.');}ST.store=root.SmartOptionsDashboardSpec.createStore(storage,roomUniverse(),record);}
    return root.SmartOptionsDashboardSpec;
  }
  // Same identity contract as Markets/Compare: companies plus retained and pinned fund identities.
  function roomUniverse(){const cs=root.SmartOptionsUniverse.rows.map(r=>r[0]),I=root.SmartOptionsInstruments;return I?.roomUniverse?I.roomUniverse(cs):new Set(cs);}
  const isFund=t=>!!root.SmartOptionsInstruments?.get?.(t)&&root.SmartOptionsInstruments.get(t).type==='ETF';
  async function get(path){const r=await root.fetch('data/'+path,{cache:'no-cache'});if(!r.ok)throw new Error(path+' HTTP '+r.status);return r.json();}
  // Original source clocks never move backwards: an older read keeps the last good dated file.
  const clockOf=d=>Date.parse(d?.generated_at||d?.exported_at||d?.asof||d?.retrieved_at||d?.asof_session||'');
  const older=(x,prev)=>!!prev&&clockOf(x)<clockOf(prev);
  function pairVerdict(c,b,cur){
    const V=root.SmartOptionsMain?.coherentPair;if(V)return V(c,b,cur);
    if(c.asof_session!==b.asof_session)return 'mixed sessions';
    const src=Object.fromEntries((b.health?.sources||[]).map(x=>[x.id,x.asof]));
    for(const k of ['macro','equities','relations','crosscheck']){const x=c.gen?.[k],y=src[k];if(x==null&&y==null)continue;if(!(Date.parse(x)===Date.parse(y)))return 'mixed generations: '+k;}
    if(cur&&clockOf(c)<clockOf(cur.core))return 'not newer';
    return 'ok';
  }
  async function load(){
    if(ST.loading)return ST.loading;
    ST.loading=(async()=>{ST.errors=[];
      // Core and brief move together. Inside the main app the room uses the exact pair Today accepted; standalone it
      // accepts a fetched pair only when the same validator (or matching build receipts) proves it one generation.
      const Main=root.__soMainState;
      if(Main?.core&&Main?.brief){ST.data.core=Main.core;ST.data.brief=Main.brief;}
      else{try{const [c,b]=await Promise.all([get('core.json'),get('brief.json')]);if(!Array.isArray(c.rows)||!c.rows.length)throw new Error('core.json has no company rows');
        const v=pairVerdict(c,b,ST.data.core&&ST.data.brief?{core:ST.data.core,brief:ST.data.brief}:null);if(v!=='ok')throw new Error('core/brief pair not adopted: '+v);ST.data.core=c;ST.data.brief=b;}
        catch(e){ST.errors.push(e.message+(ST.data.core?' (last good pair retained)':''));record(ST.data.core?'WARN':'FAIL','dashboard-data',e.message);}}
      await Promise.all(['quotes','intelligence'].map(async k=>{try{const x=await get(k+'.json');if(k==='intelligence'&&x.schema!=='smartoptions.intelligence.v1')throw new Error('Unsupported intelligence schema');if(older(x,ST.data[k]))throw new Error(k+'.json read was older than the data shown');ST.data[k]=x;}catch(e){ST.errors.push(e.message+(ST.data[k]?' (last good data retained)':''));record(ST.data[k]?'WARN':'FAIL','dashboard-data',e.message);}}));
      if(!ST.cfg)try{ST.cfg=await get('config.json');}catch(e){ST.cfg={};record('WARN','dashboard-config','Optional planner configuration unavailable.');}
      const act=ST.store?.active(),ws=act?.widgets||[],ts=[...new Set(ws.flatMap(w=>w.tickers||[]))];
      if(ws.some(w=>w.settings?.indicators?.length)&&!root.SmartOptionsTech&&doc)await new Promise(res=>{const sc=doc.createElement('script');sc.src='technicals.js?v=client-20261019-unified2';sc.onload=res;sc.onerror=()=>{ST.errors.push('Indicator engine did not load');res();};doc.head.appendChild(sc);});
      await Promise.all([...new Set(ws.filter(w=>w.type==='history').flatMap(w=>[...w.tickers,...(w.settings?.benchmarks||[])]))].map(async t=>{try{const I=root.SmartOptionsInstruments,pub=!isFund(t)||I?.RETAINED?.[t];const x=pub?await get('px/'+encodeURIComponent(t)+'.json'):await I.history(t).then(d=>({bars:d.bars,prov:'Yahoo Finance chart via public relay, retrieved '+d.retrieved_at}));if(!Array.isArray(x.bars))throw new Error('px/'+t+'.json has no daily bars');const last=d=>String(d?.bars?.at?.(-1)?.[0]??d?.bars?.at?.(-1)?.t??d?.bars?.at?.(-1)?.date??'');if(ST.data.px[t]&&last(x)<last(ST.data.px[t]))throw new Error('px/'+t+'.json ends before the history shown');ST.data.px[t]=x;}catch(e){ST.errors.push(e.message+(ST.data.px[t]?' (last good data retained)':''));record('WARN','dashboard-data',e.message);}}));
      if(ws.some(w=>w.type==='news'))try{const N=root.SmartOptionsNews,x=N?.loadCollection?await N.loadCollection():await get('money-flow.json');if(x.schema!=='smartoptions.capital.v1'||!Array.isArray(x.news))throw new Error('Unsupported news collection');if(!(Date.parse(x.news_status?.retrieved_at)<Date.parse(ST.data.news?.news_status?.retrieved_at)))ST.data.news=x;}catch(e){ST.errors.push('News '+e.message+(ST.data.news?' (last good data retained)':''));record('WARN','dashboard-data',e.message);}await Promise.all(ts.map(async t=>{try{const x=await get('brief/company/'+encodeURIComponent(t)+'.json');if(older(x,ST.data.companies[t]))throw new Error(t+' company file older than the one shown');ST.data.companies[t]=x;}catch(e){ST.errors.push(e.message+(ST.data.companies[t]?' (last good data retained)':''));record('WARN','dashboard-data',e.message);}}));
    })().finally(()=>{ST.loading=null;});return ST.loading;
  }
  function metric(id,t,data){
    const raw=data.core?.rows?.find(r=>r.t===t),q=data.quotes?.quotes?.[t],c=root.SmartOptionsLive?.currentRow?root.SmartOptionsLive.currentRow(raw,q):raw,co=data.companies?.[t],intel=data.intelligence?.companies?.[t];
    const out={value:null,asof:'unknown',period:'unknown',source:'Unavailable',url:'',basis:'No measured input is available.'};
    if(['price','change_1d_pct'].includes(id)){
      const key=id==='price'?'price':'chg_pct';
      if(q&&q.current_usable!==false&&num(q[key])&&c?.px!=null)return {...out,value:q[key],asof:q.asof_utc||q.ts||'unknown',period:id==='price'?(q.freshness||'snapshot'):'versus previous close '+(q.prior_close_date||''),source:q.provider||'Quote snapshot',url:q.source_url||'',basis:id==='price'?'Provider quote; observation timestamp retained.':'(quote / previous session close − 1) × 100; provider change.'};
      return {...out,value:null,asof:c?.pxd||'unknown',period:'Last exported close',source:'Yahoo Finance via core.json',basis:id==='price'?'Unadjusted daily close; dated snapshot.':'Close-to-close percentage return in the exported snapshot.'};
    }
    if(['forward_pe','market_cap'].includes(id)&&(!q||c?.px==null))return {...out,basis:'Current price unavailable; dated fundamentals are retained.'};
    if(['forward_pe','market_cap'].includes(id))return {...out,value:num(c?.[id==='forward_pe'?'pef':'mcap'])?c[id==='forward_pe'?'pef':'mcap']:null,asof:c?.quote_asof||c?.rat||data.core?.exported_at||'unknown',period:data.core?.asof_session||'Export snapshot',source:'Yahoo Finance via core.json',basis:id==='forward_pe'?'Latest canonical price / fixed dated expected earnings per share.':'Snapshot shares implied by market cap / price, multiplied by latest canonical price.'};
    if(['revenue_growth_pct','operating_margin_pct','free_cash_flow'].includes(id)){
      const [card,label]={revenue_growth_pct:['growth','Revenue growth YoY'],operating_margin_pct:['profitability','Operating margin'],free_cash_flow:['cash','Free cash flow TTM']}[id],m=co?.cards?.[card]?.metrics?.find(m=>m.label===label);
      if(m)return {...out,value:num(m.value)?m.value:null,asof:m.asof||'unknown',period:m.period||'unknown',source:m.source||'Company fundamentals',url:m.source_url||'',basis:m.note||({revenue_growth_pct:'(Reported revenue / prior-year revenue − 1) × 100.',operating_margin_pct:'Operating income / revenue × 100.',free_cash_flow:'Operating cash flow minus capital expenditure, matched trailing four quarters.'}[id])};return out;
    }
    if(['observed_return_pct','explained_return_pct','residual_return_pct','model_r2'].includes(id))return {...out,value:num(intel?.[id])?intel[id]:null,asof:intel?.model_asof||'unknown',period:id==='model_r2'?'Historical fitted sample':(data.intelligence?.asof_session||'unknown'),source:'Intelligence historical model',basis:{observed_return_pct:'Observed sample-session return.',explained_return_pct:'Historical factor coefficients × recorded same-session factor moves; association, not forecast.',residual_return_pct:'Observed return minus historically explained return; unexplained is not an investment edge.',model_r2:'Fraction of in-sample return variation explained by historical factors; not forecast accuracy.'}[id]};
    return out;
  }

  /* ---------------------------------------------------------------- room modules (dated public data only) */
  const ROOM_LABELS={quote:'Prices and source clock',history:'Price history and relative trend',case:'Fundamental case and counterargument',events:'Upcoming events',news:'Latest matched news',sensitivity:'Historical macro sensitivity'};
  const FACTOR_LABEL={wti:'WTI oil',us10y_bps:'10-year Treasury yield',dxy:'US dollar index',vix:'VIX',spy:'S&P 500 (SPY)',hy_oas_bps:'High-yield credit spread'};
  const pct=v=>num(v)?(v>0?'+':v<0?'−':'')+Math.abs(v).toFixed(2)+'%':'n/a';
  const co=(t,data)=>data.core?.rows?.find(r=>r.t===t);
  const roomOf=()=>ST.store?.active();
  function bars(t,data){const b=data.px?.[t]?.bars;return Array.isArray(b)?b.filter(x=>Array.isArray(x)&&typeof x[0]==='string'&&num(x[4])&&x[4]>0):[];}
  function ret(b,n){return b.length>n?100*(b[b.length-1][4]/b[b.length-1-n][4]-1):null;}
  function spark(series){
    // Rebased closes (first common session = 100); static SVG, no chart library, no repaint on quote ticks.
    const all=series.flatMap(s=>s.pts);if(all.length<2)return '';const lo=Math.min(...all),hi=Math.max(...all),W=600,H=120,n=Math.max(...series.map(s=>s.pts.length));
    const y=v=>H-6-(H-12)*(v-lo)/((hi-lo)||1),x=i=>6+(W-12)*i/Math.max(1,n-1);
    return '<svg class="md-spark" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Rebased closing prices">'+series.map((s,k)=>'<polyline fill="none" stroke-width="2" class="md-line md-line-'+k+'" points="'+s.pts.map((v,i)=>x(i).toFixed(1)+','+y(v).toFixed(1)).join(' ')+'"/>').join('')+'</svg><p class="md-legend">'+series.map((s,k)=>'<span class="md-key md-line-'+k+'">'+esc(s.t)+' '+pct(s.pts[s.pts.length-1]-100)+'</span>').join(' ')+'</p>';
  }
  function compareHash(ts){try{const W=root.SmartOptionsWorkspace;if(W?.encodeHash)return W.encodeHash({s:ts.map(t=>({id:'eq:'+t})),r:'1y',m:'rel',ind:{},lag:0});}catch(e){record('WARN','room','Compare link unavailable: '+e.message);}return '#/explore';}
  function roomHTML(w,data){
    const ts=w.tickers||[],room=roomOf();
    if(w.type==='quote')return '<div class="md-table"><table><thead><tr><th>Asset</th><th>Price</th><th>Change</th><th>Observation</th></tr></thead><tbody>'+ts.map(t=>{const p=metric('price',t,data),c=metric('change_1d_pct',t,data),r=co(t,data),f=isFund(t);return '<tr><th><a href="'+(f?'#/markets?u=all&sel=':'#/company/')+esc(t)+'">'+esc(t)+'</a><span class="md-meta"> '+esc(r?.n||(f?root.SmartOptionsInstruments.get(t).name+' · ETF':''))+'</span></th><td data-quote-metric="price" data-ticker="'+esc(t)+'">'+esc(num(p.value)?format(p,'USD/share'):(num(r?.px)?'$'+r.px.toFixed(2)+' close':'Not available'))+'</td><td data-quote-metric="change_1d_pct" data-ticker="'+esc(t)+'">'+esc(format(c,'%'))+'</td><td>'+sourceHTML(num(p.value)?p:{source:'Yahoo Finance via core.json',asof:r?.pxd||'unknown',period:'Last exported close (reference, not a live quote)',basis:'Unadjusted daily close from the dated export.',url:''})+'</td></tr>';}).join('')+'</tbody></table></div><p class="md-meta">Live quotes, when available, carry their own observation time; otherwise the dated reference close is labeled as such. Quote time is not news time.</p>';
    if(w.type==='history')return historyHTML(w,data);
    if(w.type==='case')return ts.map(t=>{const c=data.companies?.[t];if(!c?.cards)return '<section class="md-case"><h3><a href="#/company/'+esc(t)+'">'+esc(t)+'</a></h3><p>Company fundamentals are unavailable for '+esc(t)+'; no case is inferred.</p></section>';
      const cards=Object.entries(c.cards).filter(([id])=>id!=='counter'),pro=cards.filter(([,x])=>x.status==='strong').slice(0,3),con=cards.filter(([,x])=>x.status==='weak'),against=c.cards.counter;
      const li=([id,x])=>'<li><b>'+esc(id[0].toUpperCase()+id.slice(1))+'</b> · '+esc(x.line)+'</li>';
      return '<section class="md-case"><h3><a href="#/company/'+esc(t)+'">'+esc(c.name||t)+' · '+esc(t)+'</a></h3><div class="md-two"><div><h4>Case</h4><ul>'+(pro.map(li).join('')||'<li>No assessment is rated strong in the dated fundamentals.</li>')+'</ul></div><div><h4>Counterargument</h4><ul>'+(against?.line?'<li>'+esc(against.line)+'</li>':'')+(con.map(li).join('')||(!against?.line?'<li>No weak assessment recorded; that is not an all-clear.</li>':''))+'</ul></div></div><p class="md-meta">Fundamentals dated '+esc(c.asof||'unknown')+'. Ratings are descriptive comparisons, not recommendations. <a href="#/company/'+esc(t)+'/fundamentals">All assessments and sources</a></p></section>';}).join('');
    if(w.type==='events'){
      const today=new Date().toISOString().slice(0,10),scen=room?.scenario,items=[];
      for(const t of ts)for(const e of data.companies?.[t]?.events?.items||[])items.push({...e,t});
      for(const r of data.brief?.risks||[]){if((r.tickers||[]).some(t=>ts.includes(t))&&!items.some(e=>e.title===r.title))items.push(r);else if(r.kind==='macro'&&scen&&root.SmartOptionsNews?.THEMES?.[scen]?.test(r.title))items.push(r);}
      const up=items.filter(e=>String(e.when_et||'').slice(0,10)>=today).sort((a,b)=>String(a.when_et).localeCompare(String(b.when_et))).slice(0,8);
      return up.length?'<ul class="md-events">'+up.map(e=>{const m=(e.metrics||[])[0];return '<li><b>'+esc(String(e.when_et).slice(0,10))+'</b> '+esc(e.title)+(e.timing?' · '+esc(e.timing.toUpperCase()):'')+(e.why?'<span class="md-meta"> '+esc(e.why)+'</span>':'')+(m?'<span class="md-meta"> Source: '+(/^https:\/\//.test(m.source_url||'')?'<a href="'+esc(m.source_url)+'" target="_blank" rel="noopener noreferrer">'+esc(m.source||'source')+'</a>':esc(m.source||''))+', retrieved '+esc(m.asof||'unknown')+(m.note?' · '+esc(m.note):'')+'</span>':'')+'</li>';}).join('')+'</ul><p class="md-meta">Provider dates can change; check before relying on timing.</p>':'<p>No upcoming dated events for '+esc(ts.join(', '))+' are recorded in the published calendar. That does not mean none exist.</p>';
    }
    if(w.type==='news')return ts.map(t=>'<div class="md-asset-slot" data-asset-slot="'+esc(t)+'"><p class="md-meta">Checking '+esc(t)+' headlines…</p></div>').join('')+'<h3 class="md-sub-h">Broader published collection (market and shortlist context)</h3><div class="md-news" data-news-widget="'+esc(w.id)+'"><p class="md-meta">'+(data.news?'Loading matched headlines…':'Published news collection is not loaded.')+'</p></div>';
    if(w.type==='sensitivity')return sensitivityHTML(w,data,room);
    return '';
  }
  // Date-aligned, rebased closes over the chosen window (Compare's relPerf convention: first common session = 100).
  // Benchmarks are drawn dashed and labeled; company and benchmark lines share one unit (index, start = 100).
  function aligned(list,window){
    const maps=list.map(x=>new Map(x.b.map(r=>[r[0],r[4]])));
    let dates=[...maps[0].keys()].filter(d=>maps.every(m=>m.has(d))).sort();dates=dates.slice(-(window+1));
    return {dates,series:list.map((x,i)=>{const b0=maps[i].get(dates[0]);return {t:x.t,bench:x.bench,pts:dates.map(d=>100*maps[i].get(d)/b0)};})};
  }
  function lineSVG(sets,{h=120,lo,hi,label,guides=[]}){
    const all=sets.flatMap(s=>s.pts.filter(num));if(all.length<2)return '';const L=lo??Math.min(...all),H=hi??Math.max(...all),W=600,n=Math.max(...sets.map(s=>s.pts.length));
    const y=v=>h-6-(h-12)*(v-L)/((H-L)||1),x=i=>6+(W-12)*i/Math.max(1,n-1);
    const path=pts=>{let d='',pen=false;pts.forEach((v,i)=>{if(!num(v)){pen=false;return;}d+=(pen?'L':'M')+x(i).toFixed(1)+','+y(v).toFixed(1)+' ';pen=true;});return d;};
    return '<svg class="md-spark" viewBox="0 0 '+W+' '+h+'" preserveAspectRatio="none" style="height:'+h+'px" role="img" aria-label="'+esc(label)+'">'+guides.map(g=>'<line class="md-guide" x1="6" x2="'+(W-6)+'" y1="'+y(g).toFixed(1)+'" y2="'+y(g).toFixed(1)+'"/>').join('')+sets.map((s,k)=>'<path fill="none" stroke-width="2" class="md-line md-line-'+(s.cls??k)+(s.bench?' md-bench':'')+'" d="'+path(s.pts)+'"/>').join('')+'</svg>';
  }
  function historyHTML(w,data){
    const st=w.settings||{},window=st.window||126,ts=w.tickers||[],bench=(st.benchmarks||[]).map(t=>({t,bench:true}));
    const list=[...ts.map(t=>({t})),...bench].map(x=>({...x,b:bars(x.t,data)})),got=list.filter(x=>x.b.length>1),missing=list.filter(x=>x.b.length<=1).map(x=>x.t);
    if(!got.some(x=>!x.bench))return '<p>Daily price history is not loaded for '+esc(ts.join(', '))+'. Nothing is estimated in its place.</p>';
    const A=aligned(got,window),first=A.dates[0],last=A.dates[A.dates.length-1],short=A.dates.length<window+1;
    let html='<p class="md-meta">Window '+esc(M().WINDOWS[window]||window+' sessions')+': '+esc(first)+' to '+esc(last)+' ('+(A.dates.length-1)+' common sessions'+(short?', fewer than requested because history is shorter':'')+'). Each line is closing price rebased to 100 on '+esc(first)+'; price only, not total return.</p>';
    html+=lineSVG(A.series.map((s,k)=>({...s,cls:s.bench?'b':k})),{label:'Rebased closing prices'})+'<p class="md-legend">'+A.series.map((s,k)=>'<span class="md-key md-line-'+(s.bench?'b':k)+'">'+esc(s.t)+(s.bench?' (benchmark)':'')+' '+pct(s.pts[s.pts.length-1]-100)+'</span>').join(' ')+'</p>';
    if(missing.length)html+='<p class="md-meta">No daily history for '+esc(missing.join(', '))+'; not drawn.</p>';
    html+='<div class="md-table"><table><thead><tr><th>Series</th><th>5 sessions</th><th>20</th><th>60</th><th>252</th><th>vs 50-day avg</th><th>vs 200-day avg</th></tr></thead><tbody>'+got.map(({t,b,bench})=>{const c=b[b.length-1][4],avg=n=>b.length>=n?b.slice(-n).reduce((s,r)=>s+r[4],0)/n:null,a50=avg(50),a200=avg(200);return '<tr><th>'+(bench?esc(t)+' <span class="md-meta">benchmark</span>':'<a href="#/company/'+esc(t)+'/drivers">'+esc(t)+'</a>')+'</th><td>'+pct(ret(b,5))+'</td><td>'+pct(ret(b,20))+'</td><td>'+pct(ret(b,60))+'</td><td>'+pct(ret(b,252))+'</td><td>'+pct(a50?100*(c/a50-1):null)+'</td><td>'+pct(a200?100*(c/a200-1):null)+'</td></tr>';}).join('')+'</tbody></table></div>';
    const ind=st.indicators||[];
    if(ind.length){
      const T=root.SmartOptionsTech,t=ts[0],b=bars(t,data);
      if(!T?.sma||!T?.rsi)html+='<p class="md-meta">Indicator engine is loading; indicators appear after the next refresh.</p>';
      else if(b.length>1){
        // Indicators run on the full stored history (warmup), then the requested window is shown. Completed sessions only.
        const closes=b.map(r=>r[4]),dates=b.map(r=>r[0]),from=Math.max(0,dates.indexOf(first)),view=a=>a.slice(from),sets=[{t,pts:view(closes),cls:0}];
        const facts=[];
        for(const [id,n] of [['sma50',50],['sma200',200]])if(ind.includes(id)){const s=T.sma(closes,n),firstAt=s.findIndex(v=>v!=null);sets.push({t:id,pts:view(s),cls:id==='sma50'?1:2});facts.push(id.toUpperCase()+' '+(num(s[s.length-1])?'$'+s[s.length-1].toFixed(2):'n/a (needs '+n+' sessions, have '+closes.length+')')+(firstAt>=0?' · first defined '+dates[firstAt]:''));}
        html+='<h3 class="md-sub-h">'+esc(t)+' price with moving averages (USD/share)</h3>'+lineSVG(sets,{label:t+' close and moving averages'})+'<p class="md-legend">'+sets.map(s=>'<span class="md-key md-line-'+s.cls+'">'+esc(s.t==='sma50'?'SMA50':s.t==='sma200'?'SMA200':t+' close')+'</span>').join(' ')+'</p>';
        if(ind.includes('rsi14')){const r=T.rsi(closes,14),v=r[r.length-1];html+='<h3 class="md-sub-h">'+esc(t)+' RSI14 (0–100)</h3>'+lineSVG([{t:'rsi',pts:view(r),cls:0}],{h:80,lo:0,hi:100,label:t+' 14-session RSI',guides:[30,70]});facts.push('RSI14 '+(num(v)?v.toFixed(1):'n/a')+' (guides at 30 and 70)');}
        html+='<p class="md-meta">'+esc(facts.join(' · '))+'. Computed by the site technicals engine from completed daily closes through '+esc(dates[dates.length-1])+' (Yahoo Finance, unadjusted); live quote ticks do not recompute these. SMA = simple mean of closes; RSI = Wilder 14-session.</p>';
      }
    }
    return html+'<p class="md-meta">'+(ts.length>1||bench.length?'<a href="'+esc(compareHash([...ts,...bench.map(b=>b.t)]))+'">Open this comparison in Compare</a> · ':'')+'<a href="#/company/'+esc(ts[0])+'/drivers">Full chart and drivers</a></p>';
  }
  function sensitivityHTML(w,data,room){
    const Sp=M(),st=w.settings,scen=room?.scenario,f=st?.factor||(scen?Sp.SCENARIOS[scen].factor:null),ts=w.tickers||[];
    const rows=ts.map(t=>{const c=data.intelligence?.companies?.[t];if(!c)return '<tr><th>'+esc(t)+'</th><td colspan="5">Historical sensitivity unavailable.</td></tr>';
      const ex=(c.shock_exposures||[]).filter(x=>!f||x.factor===f),sens=Object.entries(c.sensitivity||{}).filter(([k])=>!f||k===f);
      return (ex.length?ex:sens.map(([k,v])=>({factor:k,beta:v.coefficient,unit:v.unit}))).map(x=>{const shock=st&&x.factor===st.factor?st.shock:null,mv=num(shock)&&num(x.beta)?x.beta*shock:null;
        return '<tr><th><a href="#/company/'+esc(t)+'/drivers">'+esc(t)+'</a></th><td>'+esc(FACTOR_LABEL[x.factor]||x.factor)+'<span class="md-meta md-unit">'+esc(x.unit||'')+'</span></td><td>'+(num(x.beta)?x.beta.toFixed(3):'n/a')+'</td><td>'+(num(x.ci_low)&&num(x.ci_high)?esc(x.ci_low.toFixed(3)+' to '+x.ci_high.toFixed(3)):'n/a')+'</td>'+(st?'<td>'+(num(mv)?pct(mv)+(num(x.ci_low)&&num(x.ci_high)?' <span class="md-meta">('+pct(Math.min(x.ci_low*shock,x.ci_high*shock))+' to '+pct(Math.max(x.ci_low*shock,x.ci_high*shock))+')</span>':''):'n/a')+'</td>':'')+'<td>'+esc(x.confidence||'')+(x.n?' · n='+esc(x.n):'')+(x.window_start?' · '+esc(x.window_start+' to '+x.window_end):'')+'</td></tr>';}).join('')||'<tr><th>'+esc(t)+'</th><td colspan="5">No fitted '+esc(f?FACTOR_LABEL[f]:'factor')+' sensitivity.</td></tr>';}).join('');
    const S=st?Sp.SHOCKS[st.factor]:null;
    return (S?'<p class="md-lead">What-if: '+esc(S.label)+' '+(st.shock>0?'+':'')+esc(st.shock)+' '+esc(S.unit)+'</p>':'')+'<div class="md-table"><table><thead><tr><th>Company</th><th>Factor</th><th>Coefficient</th><th>Interval</th>'+(st?'<th>Associated move</th>':'')+'<th>Fit</th></tr></thead><tbody>'+rows+'</tbody></table></div><p class="md-meta">Daily-return regressions dated '+esc(data.intelligence?.shocks?.model_asof||data.intelligence?.asof_session||'unknown')+'. '+(st?'Associated move = historical coefficient × the what-if move (interval uses the coefficient interval), holding the other fitted factors fixed. ':'')+'Historical association, not causation or a forecast; coefficients can change and other drivers can dominate. '+(scen?'Scenario: '+esc(Sp.SCENARIOS[scen].label)+'. ':'')+'<a href="#/macro">Macro observations</a></p>';
  }
  async function assetNews(room,force){
    // Foreground only: called from paint/refresh of a visible room. Public tickers only.
    const N=root.SmartOptionsNews,w=room?.widgets.find(x=>x.type==='news');if(!N?.fetchAssetNews||!w||!ST.container?.isConnected||doc.hidden)return;
    if(force)w.tickers.forEach(t=>N._assetCache.delete(t));
    const ctrl=new AbortController();ST.assetAbort?.abort();ST.assetAbort=ctrl;
    const out=await Promise.all(w.tickers.map(t=>N.fetchAssetNews(ST.cfg||{},t,{signal:ctrl.signal}).catch(e=>e.name==='AbortError'?null:{symbol:t,status:'error',items:[],error:e.message})));
    if(ctrl.signal.aborted||!ST.container?.isConnected)return;
    ST.container.querySelectorAll('[data-asset-slot]').forEach(el=>{const d=out.find(o=>o&&o.symbol===el.dataset.assetSlot);if(d)el.innerHTML=N.renderAsset(d,co(d.symbol,ST.data)?.n||'');});
  }
  const M=()=>root.SmartOptionsDashboardSpec;
  function mountNews(){
    ST.newsMounts.forEach(m=>{try{m.destroy();}catch(e){record('WARN','room','News controller release failed');}});ST.newsMounts=[];
    const N=root.SmartOptionsNews,room=roomOf();if(!N||!ST.container)return;
    ST.container.querySelectorAll('[data-news-widget]').forEach(el=>{const w=room?.widgets.find(x=>x.id===el.dataset.newsWidget);if(!w||!ST.data.news)return;const names=Object.fromEntries((w.tickers||[]).map(t=>[t,co(t,ST.data)?.n||'']));
      // Existing foreground controller: renders dated items, ages them each minute, refreshes only while visible.
      ST.newsMounts.push(N.mount(el,{core:ST.data.core,initialData:ST.data.news,filter:N.matcher({tickers:w.tickers,names,scenario:room?.scenario})}));});
  }
  function format(m,unit){if(!num(m.value))return 'Not available';if(unit==='USD/share')return '$'+m.value.toFixed(2);if(unit==='USD')return '$'+m.value.toLocaleString('en-US',{notation:'compact',maximumFractionDigits:2});return m.value.toLocaleString('en-US',{maximumFractionDigits:unit==='fraction'?3:2})+(unit==='%'?'%':unit==='x'?'×':unit&&unit!=='fraction'?' '+unit:'');}
  function sourceHTML(m){return '<details class="md-source"><summary>Source and calculation</summary><p>'+esc(m.source)+' · Observed '+esc(m.asof)+' · '+esc(m.period)+'</p><p>'+esc(m.basis)+'</p>'+(/^https?:\/\//.test(m.url)?'<a href="'+esc(m.url)+'" target="_blank" rel="noopener">Open source</a>':'')+'</details>';}
  function widgetHTML(w,index,data){
    const M=root.SmartOptionsDashboardSpec,ts=w.tickers||[],label=w.title||(w.metric?M.METRICS[w.metric].label:{company:'Company snapshot',market:'Market overview',relationships:'Relationships',...ROOM_LABELS}[w.type]);let html='';
    if(M.ROOM_TYPES?.includes(w.type))html=roomHTML(w,data);
    if(w.type==='metric'){const m=metric(w.metric,ts[0],data);html='<a class="md-ticker" href="#/company/'+esc(ts[0])+'">'+esc(ts[0])+'</a><p class="md-value" data-quote-metric="'+esc(w.metric)+'" data-ticker="'+esc(ts[0])+'">'+esc(format(m,M.METRICS[w.metric].unit))+'</p>'+sourceHTML(m);}
    if(w.type==='comparison')html='<div class="md-table"><table><thead><tr><th>Company</th><th>'+esc(label)+'</th><th>Basis</th></tr></thead><tbody>'+ts.map(t=>{const m=metric(w.metric,t,data);return '<tr><th><a href="#/company/'+esc(t)+'">'+esc(t)+'</a></th><td data-quote-metric="'+esc(w.metric)+'" data-ticker="'+esc(t)+'">'+esc(format(m,M.METRICS[w.metric].unit))+'</td><td>'+sourceHTML(m)+'</td></tr>';}).join('')+'</tbody></table></div>';
    if(w.type==='market'){const p=data.intelligence?.market||data.brief?.pulse;html=p?'<p class="md-lead">'+esc(p.headline||'Market snapshot')+'</p><p>'+esc(p.summary||'')+'</p><p class="md-meta">Snapshot '+esc(data.intelligence?.generated_at||data.brief?.generated_at||data.core?.asof_session||'unknown')+'</p>':'<p>Market overview is unavailable.</p>';}
    if(w.type==='company'){const c=data.companies[ts[0]];html='<a class="md-ticker" href="#/company/'+esc(ts[0])+'">'+esc(c?.name||ts[0])+' · '+esc(ts[0])+'</a><p>'+esc(c?.summary||'Company fundamentals are unavailable.')+'</p><div class="md-assess">'+Object.entries(c?.cards||{}).map(([id,card])=>'<details><summary>'+esc(id[0].toUpperCase()+id.slice(1))+' · '+esc(card.status)+'</summary><p>'+esc(card.line)+'</p>'+(card.metrics||[]).map(m=>'<p>'+esc(m.label)+': '+esc(format(m,m.unit))+'</p>'+sourceHTML({source:m.source||'Company fundamentals',asof:m.asof||'unknown',period:m.period||'unknown',basis:m.note||'Reported metric in the dated company fundamentals file; no later quote relabeling.',url:m.source_url||''})).join('')+'</details>').join('')+'</div><p class="md-meta">Fundamental snapshot '+esc(c?.asof||'unknown')+'</p>';}
    if(w.type==='relationships'){const r=root.SmartOptionsRelationships.answer(ts[0],data.intelligence);html='<a class="md-ticker" href="#/company/'+esc(ts[0])+'">'+esc(ts[0])+'</a>'+(r.na?'<p>'+esc(r.na)+'</p>':r.lines.map(l=>'<p>'+esc(l.text)+'</p>').join(''))+(r.facts.length?'<details class="md-source"><summary>Relationship evidence</summary>'+r.facts.map(f=>'<p>'+esc(f.text)+': '+esc(f.display)+' · '+esc(f.asof)+(f.url?' · <a href="'+esc(f.url)+'" target="_blank" rel="noopener">Source</a>':'')+(f.note?' · '+esc(f.note):'')+'</p>').join('')+'</details>':'');}
    return '<article class="md-widget md-'+esc(w.width)+'" data-widget="'+esc(w.id)+'"><header><h2><span class="md-number">'+(index+1)+'</span> '+esc(label)+'</h2><span class="md-id">'+esc(w.id)+'</span></header>'+html+'<div class="md-reorder"><button type="button" data-move="'+esc(w.id)+'" data-position="'+index+'" '+(index===0?'disabled':'')+' aria-label="Move '+esc(label)+' earlier">↑ Earlier</button><button type="button" data-move="'+esc(w.id)+'" data-position="'+(index+2)+'" '+(index===ST.store.active().widgets.length-1?'disabled':'')+' aria-label="Move '+esc(label)+' later">↓ Later</button><button type="button" data-width="'+esc(w.id)+'" data-size="'+(w.width==='full'?'half':'full')+'">'+(w.width==='full'?'Half':'Full')+' width</button></div></article>';
  }
  function receipt(r){ST.receipt=r;const n=ST.container?.querySelector('.md-receipt');if(n){n.textContent=r.text;n.classList.toggle('md-error',r.status!=='OK');}return r;}
  function paint(){
    const el=ST.container;if(!el?.isConnected)return;const state=ST.store.read(),cur=ST.store.active(),M=root.SmartOptionsDashboardSpec,draft=el.querySelector('.md-command')?.value||'';
    el.innerHTML='<div class="md"><div class="md-heading"><div><p class="md-eyebrow">'+(root.SmartOptionsMain?'Saved on this device':'Your research, arranged your way')+'</p><h1>'+(root.SmartOptionsMain?'Saved rooms':'My Dash')+'</h1><p class="md-sub">Named views saved on this device. Export a copy to carry them to another browser.</p></div><div class="md-tools"><label>Saved view<select class="md-select" aria-label="Saved dashboard"><option value="">Choose a saved view</option>'+state.layouts.map(l=>'<option value="'+esc(l.name)+'" '+(cur?.id===l.id?'selected':'')+'>'+esc(l.name)+'</option>').join('')+'</select></label><button type="button" class="md-export" '+(!state.layouts.length?'disabled':'')+'>Export views</button><label class="md-import">Import views<input type="file" accept="application/json,.json" aria-label="Import dashboard JSON"></label></div></div><form class="md-form"><label for="md-command">Tell chat what to arrange</label><div class="md-compose"><textarea id="md-command" class="md-command" rows="2" maxlength="1200" placeholder="Create a war room for NVDA">'+esc(draft)+'</textarea><button type="submit" '+(ST.busy?'disabled':'')+'>'+(ST.busy?'Working…':'Apply')+'</button></div><p class="md-mode">'+(ST.cfg?.chat_proxy_url?'Uses supported data widgets. The shared assistant may translate unclear requests.':'Ready without a model. Try the examples below; shared language planning is not configured.')+'</p></form><p class="md-receipt '+(ST.receipt&&ST.receipt.status!=='OK'?'md-error':'')+'" role="status">'+esc(ST.receipt?.text||ST.store.blocked()||'Changes are confirmed after browser storage reads them back.')+'</p>'+(ST.errors.length?'<details class="md-health"><summary>Some data is unavailable or retained from the last successful load</summary><ul>'+ST.errors.map(e=>'<li>'+esc(e)+'</li>').join('')+'</ul></details>':'')+'<div class="md-examples">'+['Create a war room for NVDA','Create an oil shock war room for XOM and CVX','Add news to this room','Set thesis to data center demand','Create dashboard named Tech with AAPL price and operating margin','Save dashboard as Morning view'].map(s=>'<button type="button" data-example="'+esc(s)+'">'+esc(s)+'</button>').join('')+'</div><div class="md-view-title"><h2>'+esc(cur?.name||'Create your first view')+'</h2><button type="button" class="md-refresh">Refresh data</button></div>'+(cur?.kind==='room'?'<div class="md-thesis"><p><b>Monitoring thesis</b> '+esc(cur.thesis||'None recorded.')+'</p><p class="md-meta">Tracking '+cur.assets.map(t=>'<a href="#/company/'+esc(t)+'">'+esc(t)+'</a>').join(', ')+(cur.scenario?' · scenario: '+esc(M.SCENARIOS[cur.scenario].label):'')+' · saved '+esc(cur.updated_at.slice(0,16).replace('T',' '))+' UTC · data: core '+esc(ST.data.core?.asof_session||ST.data.core?.exported_at||'unknown')+', fundamentals and news keep their own dates.</p></div>':'')+(cur?.widgets.length?'<div class="md-grid">'+cur.widgets.map((w,i)=>widgetHTML(w,i,ST.data)).join('')+'</div>':'<div class="md-empty"><h3>Start with a question you revisit</h3><p>Track prices and fundamentals, compare companies, or keep historical relationships beside their counterarguments.</p><p>Choose a named example above, then add and move widgets through chat. Every widget shows its own date and calculation basis.</p></div>')+'<details class="md-catalog"><summary>Available widgets and metrics</summary><p>Widgets: metric, company summary (all seven assessments), market overview, relationships, comparison. Metric and comparison values come from dated data files.</p><ul>'+Object.entries(M.METRICS).map(([id,m])=>'<li>'+esc(m.label)+' <code>'+esc(id)+'</code></li>').join('')+'</ul><p>Unsupported requests stay unchanged. Shared account sync is not enabled. Import merges separate named views and refuses conflicts.</p></details><details class="md-diagnostics"><summary>Action diagnostics</summary><pre>'+esc(JSON.stringify(ST.store.events,null,2))+'</pre></details></div>';
    if(cur?.focus){const f=doc.createElement('details');f.className='room-focus';f.innerHTML='<summary>Saved investigation: '+esc(cur.focus.label)+'</summary><p>'+esc(cur.focus.source)+' · '+esc(cur.focus.at)+' · '+esc(cur.focus.kind)+'</p><button type="button" class="btn" data-room-focus>Resume investigation</button><p>Source context is not proof of price causality; factor assumptions stay explicitly hypothetical.</p>';el.querySelector('.md-view-title').after(f);f.querySelector('button').onclick=()=>root.SmartOptionsMain?.followFocus(cur.focus).catch(e=>{record('WARN','investigation','Saved focus could not be resumed');receipt({status:'WARN',text:e.message});});}
    // A room leads with its content; the composer and examples follow, so the workspace is above the fold.
    if(cur?.kind==='room'){const md=el.querySelector('.md'),form=md.querySelector('.md-form'),ex=md.querySelector('.md-examples');for(const n of [md.querySelector('.md-receipt'),md.querySelector('.md-health'),md.querySelector('.md-view-title'),md.querySelector('.room-focus'),md.querySelector('.md-thesis'),md.querySelector('.md-grid')])if(n)md.insertBefore(n,form);const d=doc.createElement('details');d.className='md-edit';d.innerHTML='<summary>Edit this room or create another</summary>';md.insertBefore(d,form);d.append(form,ex);if(draft||ST.editOpen)d.open=true;d.addEventListener('toggle',()=>{ST.editOpen=d.open;});}
    mountNews();assetNews(cur);root.SmartOptionsLive?.watch('dashboard',[...el.querySelectorAll('[data-ticker]')].map(n=>n.dataset.ticker));
    el.querySelector('.md-form').addEventListener('submit',async e=>{e.preventDefault();const ta=el.querySelector('.md-command'),q=ta.value;const r=await command(q);if(r.handled&&r.receipt?.status==='OK'&&el.querySelector('.md-command'))el.querySelector('.md-command').value='';});
    el.querySelector('.md-select').addEventListener('change',e=>{if(e.target.value)applyAction({schema:M.ACTION_SCHEMA,action:'open',name:e.target.value});});
    el.querySelector('.md-examples').addEventListener('click',e=>{const b=e.target.closest('[data-example]');if(b){el.querySelector('.md-command').value=b.dataset.example;el.querySelector('.md-command').focus();}});
    el.querySelectorAll('[data-move]').forEach(b=>b.addEventListener('click',()=>applyAction({schema:M.ACTION_SCHEMA,action:'move_widget',widget_id:b.dataset.move,position:+b.dataset.position})));
    el.querySelectorAll('[data-width]').forEach(b=>b.addEventListener('click',()=>applyAction({schema:M.ACTION_SCHEMA,action:'resize_widget',widget_id:b.dataset.width,width:b.dataset.size})));
    el.querySelector('.md-refresh').addEventListener('click',()=>refresh());
    el.querySelector('.md-export').addEventListener('click',()=>{try{const blob=new Blob([ST.store.exportFile()],{type:'application/json'}),url=URL.createObjectURL(blob),a=doc.createElement('a');a.href=url;a.download='smartoptions-dashboards.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);receipt({status:'OK',text:'Export prepared. Keep the JSON file to move your views to another device.'});}catch(e){record('FAIL','dashboard-export',e.message);receipt({status:'FAIL',text:'Export unavailable: '+e.message});}});
    el.querySelector('.md-import input').addEventListener('change',async e=>{const f=e.target.files[0];if(!f)return;try{if(f.size>100000)throw new Error('Choose a JSON file under 100 KB.');const r=ST.store.importFile(await f.text());receipt(r);await load();paint();}catch(err){record('WARN','dashboard-import',err.message);receipt({status:'FAIL',text:err.message});}finally{e.target.value='';}});
  }
  // Today adopted a newer public generation: a visible room re-reads it, keeping its saved settings and draft.
  if(root.addEventListener)root.addEventListener('so:generation',()=>{if(ST.container?.isConnected&&!doc?.hidden&&!root.SmartOptionsMain)refresh();});
  async function mount(container){ST.container=container;try{await ensure();paint();await load();paint();}catch(e){record('FAIL','dashboard-mount',e.message);if(container.isConnected)container.innerHTML='<p class="md-error" role="alert">'+esc(e.message)+'</p>';}}
  async function refresh(){try{await ensure();await load();receipt({status:ST.errors.length?'WARN':'OK',text:ST.errors.length?'Refresh is partial. Available data and last good observations remain labeled.':'Data refreshed. Each observation keeps its original date and basis.'});paint();}catch(e){record('FAIL','dashboard-refresh',e.message);receipt({status:'FAIL',text:e.message});}}
  async function applyAction(a){try{await ensure();const r=ST.store.execute(a);receipt(r);if(root.location&&!onHome())root.location.hash=HOME();await load();paint();return r;}catch(e){record('WARN','dashboard-action',e.message);const r={status:'FAIL',text:'No dashboard change confirmed: '+e.message};receipt(r);return r;}}
  async function command(q,cfg){
    let ownsBusy=false;
    try{const M=await ensure(),current=ST.store.active(),onDashboard=onHome(),ctx={layout:current,universe:roomUniverse(),names:ST.store.read().layouts.map(l=>l.name),onDashboard,tickers:root.SmartOptionsIntents?.route(q,{universe:root.SmartOptionsUniverse.rows}).entities.tickers||[]};
      const a=M.parse(q,ctx);if(!a)return {handled:false};if(ST.busy)return {handled:true,receipt:{status:'WARN',text:'The previous dashboard request is still running.'}};
      ST.busy=true;ownsBusy=true;paint();let proposed=a;
      if(a.unresolved&&a.question)return {handled:true,receipt:receipt({status:'ASK',text:a.reason})||ST.receipt};
      if(a.unresolved){if(!ST.cfg)try{ST.cfg=await get('config.json');}catch(e){ST.cfg={};record('WARN','dashboard-config','Optional planner configuration unavailable.');}const options=cfg||{url:ST.cfg?.chat_proxy_url};proposed=await M.plan(q,ctx,options);if(!proposed)throw new Error(a.reason);}
      if(cfg?.signal?.aborted)throw new DOMException('Cancelled','AbortError');const r=await applyAction(proposed);return {handled:true,receipt:r};
    }catch(e){record('WARN','dashboard-command',e.message);const r={status:'FAIL',text:'No dashboard change confirmed: '+(e.name==='AbortError'?'Request cancelled.':e.message)};receipt(r);return {handled:true,receipt:r};}finally{if(ownsBusy){ST.busy=false;paint();}}
  }
  if(doc){root.addEventListener('storage',e=>{if(e.key==='so-brief-dashboards-v1'){ST.store=null;if(ST.container?.isConnected)mount(ST.container);}});
    root.addEventListener('so:quotes-update',e=>{if(e.detail){ST.data.quotes=e.detail;if(ST.container?.isConnected)ST.container.querySelectorAll('[data-quote-metric]').forEach(n=>{const id=n.dataset.quoteMetric;if(!['price','change_1d_pct','forward_pe','market_cap'].includes(id))return;const m=metric(id,n.dataset.ticker,ST.data);n.textContent=format(m,root.SmartOptionsDashboardSpec.METRICS[id].unit);const sibling=n.nextElementSibling,source=sibling?.matches('.md-source')?sibling:sibling?.querySelector('.md-source');if(source){const open=source.open;source.outerHTML=sourceHTML(m);const replacement=sibling===source?n.nextElementSibling:sibling.querySelector('.md-source');if(replacement)replacement.open=open;}});}});
    root.addEventListener('so:data-update',()=>{if(ST.container?.isConnected)refresh();});}
  return {_room:{aligned,historyHTML,sensitivityHTML},mount,refresh,command,applyAction,metric,format,catalog:()=>root.SmartOptionsDashboardSpec?.METRICS||{},state:()=>ST.store?.read()||null};
});
