/* Private investor workflow. No fetch, chat context, analytics, or URL serialization. */
(function(root,factory){const a=factory(root);if(typeof module!=='undefined'&&module.exports)module.exports=a;root.SmartOptionsInvestor=a;})(typeof window!=='undefined'?window:globalThis,function(root){
  'use strict';
  const KEY='so_investor_v1', finite=v=>typeof v==='number'&&Number.isFinite(v);
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money=v=>finite(v)?v.toLocaleString('en-US',{style:'currency',currency:'USD'}):'Unavailable';
  const pct=v=>finite(v)?(v>0?'+':'')+v.toFixed(2)+'%':'Unavailable';
  const costDescription=b=>b?.costMeaning==='perShare'&&(!b.currency||b.currency==='USD')?money(b.cost)+' per share':String(b?.cost??'Unknown')+' (cost meaning or currency unconfirmed)';
  const dateCache=new Map();
  const day=ms=>{const k=Math.floor(ms/60000);if(!dateCache.has(k)){dateCache.set(k,new Date(ms).toLocaleDateString('en-CA',{timeZone:'America/New_York'}));if(dateCache.size>1500)dateCache.delete(dateCache.keys().next().value);}return dateCache.get(k);};
  const humanClock=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'});
  const humanET=iso=>Number.isFinite(Date.parse(iso||''))?humanClock.format(new Date(iso))+' ET':'time unavailable';
  const sessionClock=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',weekday:'short',hour:'numeric',minute:'numeric',hour12:false});
  function regularBasis(q){
    if(!q||q.market_hours!=null&&q.market_hours!==1)return false;
    if(q.market_state!=null&&!['regular','open','closed'].includes(q.market_state))return false;
    if(q.market_hours===1)return true;
    if(!['regular','open','closed'].includes(q.market_state))return false;
    const ms=Date.parse(q.asof_utc||q.ts||'');if(!finite(ms))return false;const p={};sessionClock.formatToParts(new Date(ms)).forEach(x=>p[x.type]=x.value);const m=(+p.hour%24)*60+(+p.minute);
    return !['Sat','Sun'].includes(p.weekday)&&m>=570&&m<=960;
  }
  const defaults=()=>({version:1,notes:{},checkpoints:{}});
  const active=b=>Object.keys(b||{}).filter(t=>b[t]?.qty!==0).sort();
  function quoteObservation(t,r,q,current,now=Date.now()) {
    const ts=q?.asof_utc||q?.ts||null,ms=Date.parse(ts||''),session=finite(ms)?day(ms):r?.pxd||null;
    const reason=!r?'Unsupported name':!finite(current?.px)||current.px<=0||q?.current_usable===false||(q&&(!finite(ms)||ms>now+60000))?'No usable current USD price':(q?.unit&&q.unit!=='USD/share')||(q?.currency&&q.currency!=='USD')?'Unsupported price currency':null;
    return {t,r,reason,price:reason?null:current.px,change:reason?null:current?.d1??null,session,ts,source:q?.provider||(r?'Published close':'Unavailable')};
  }
  function position(t,b,r,q,current,now=Date.now()) {
    const observed=quoteObservation(t,r,q,current,now),{session}=observed;
    let reason=!r?'Unsupported name':r.sp500_member===false?'Unsupported equity coverage for this entry':!finite(b?.qty)||b.qty<0?'Missing or unsupported quantity':b.currency&&b.currency!=='USD'?'Unsupported currency':observed.reason;
    const measured=reason?null:b.qty*current.px;
    if(!reason&&!finite(measured))reason='Entered quantity and price exceed supported arithmetic';
    const value=reason?null:measured;
    const confirmed=b?.costMeaning==='perShare'&&finite(b.cost)&&b.cost>=0;
    // A provider prior-close without its date is deliberately insufficient for session dollar arithmetic.
    const basis=finite(value)&&q && finite(q.prior_close)&&q.prior_close>0&&q.return_basis==='previous_regular_session_close'&&
      /^\d{4}-\d{2}-\d{2}$/.test(q.prior_close_date||'')&&q.prior_close_date<session&&q.return_session===session&&regularBasis(q);
    return {...observed,b,reason,value,price:finite(value)?current.px:null,qty:b?.qty,change:reason?null:observed.change,dollars:basis?b.qty*(current.px-q.prior_close):null,
      priorSession:basis?q.prior_close_date:null,pnl:finite(value)&&confirmed?b.qty*(current.px-b.cost):null,costConfirmed:confirmed};
  }
  function summarize(book,rows,get,current,now) {
    const map=new Map(rows.map(r=>[r.t,r])), items=active(book).map(t=>{const quote=get(t);return position(t,book[t],map.get(t),quote,current(map.get(t),quote),now);});
    const priced=items.filter(p=>finite(p.value)), sum=priced.reduce((s,p)=>s+p.value,0),total=finite(sum)?sum:null, complete=priced.length===items.length&&items.length>0&&finite(total);
    const comparable=complete && items.every(p=>finite(p.dollars)&&p.session===items[0].session&&p.priorSession===items[0].priorSession);
    return {items,priced,total,complete,comparable,dollars:comparable?items.reduce((s,p)=>s+p.dollars,0):null,
      label:complete?'Entered equity value':'Priced subtotal',weightLabel:complete?'share of entered equity value':'share of priced subtotal'};
  }
  function observation(t,scope,book,map,get,current,session,now) {
    const r=map.get(t),q=get(t),c=r?current(r):null;
    return {qty:scope==='positions'?book[t]?.qty??null:null,session:session||null,earnings:r?{date:r.er||null,timing:r.ert||null,source:r.ers||null}:null,
      covered:!quoteObservation(t,r,q,c,now).reason,quoteAt:q?.asof_utc||q?.ts||null};
  }
  function checkpoint(scope,names,book,rows,get,current,session,now=Date.now()) {
    const map=new Map(rows.map(r=>[r.t,r]));const fields=Object.fromEntries([...names].sort().map(t=>[t,observation(t,scope,book,map,get,current,session,now)]));
    return {version:1,basis:'session-earnings-coverage-v1',at:new Date(now).toISOString(),scope,fingerprint:JSON.stringify(Object.entries(fields).map(([t,v])=>[t,v.qty])),fields};
  }
  function changes(old,now) {
    if(!old)return {state:'first',items:[],text:'No review checkpoint yet.'};
    if(old.version!==1||old.basis!==now.basis||!old.fields)return {state:'unavailable',items:[],text:'Review comparison unavailable: checkpoint basis is unknown.'};
    const items=[];
    Object.entries(now.fields).forEach(([t,v])=>{
      const prev=old.fields[t],why=[];
      if(!prev)why.push('Added since review');else {
        if(prev.qty!==v.qty)why.push('Position changed');
        if(prev.session&&v.session&&v.session>prev.session)why.push('Newer completed session: '+v.session);
        if(!prev.session||!v.session)why.push('Session comparison unavailable');
        if(prev.earnings&&v.earnings && JSON.stringify(prev.earnings)!==JSON.stringify(v.earnings))why.push('Next earnings information changed');
        if(!prev.earnings||!v.earnings)why.push('Earnings comparison unavailable');
        if(typeof prev.covered!=='boolean'||typeof v.covered!=='boolean')why.push('Coverage comparison unavailable');
        else if(prev.covered!==v.covered)why.push('Price coverage changed');
      }
      if(why.length)items.push({t,why});
    });
    Object.keys(old.fields).filter(t=>!now.fields[t]).forEach(t=>items.push({t,why:['No longer in selected scope']}));
    return {state:items.length?'changed':'same',items,text:items.length?items.length+' names changed in tracked fields since '+humanET(old.at):
      'No changes in the tracked fields since '+humanET(old.at)+'.'};
  }
  function attribution(r) {
    const a=r?.att;
    if(!a||a.status!=='ok'||!/^\d{4}-\d{2}-\d{2}$/.test(a.date||'')||![a.actual,a.explained,a.stock_specific].every(finite)||
      Math.abs(a.actual-a.explained-a.stock_specific)>.035||!a.by_factor||!Object.values(a.by_factor).every(finite)||
      Math.abs(Object.values(a.by_factor).reduce((s,x)=>s+x,0)-a.explained)>.04)return null;
    return a;
  }
  function relationships(r) {
    const m=r?.rel;if(!m||m.n<120)return [];
    return Object.entries(m.c||{}).filter(([f,c])=>finite(c)&&finite(m.t?.[f])).map(([factor,c])=>({factor,c,t:m.t[factor],n:m.n,r2:m.r2,c60:m.c60?.[factor],t60:m.t60?.[factor],
      screened:Math.abs(m.t[factor])>=2,reversed:finite(m.c60?.[factor])&&c*m.c60[factor]<0}));
  }
  function queue({names,scope,book,rows,get,current,session,notes,prior,events,now=Date.now()}) {
    names=[...new Set(names)];
    const fetchQuote=get,quotes=new Map();get=t=>{if(!quotes.has(t))quotes.set(t,fetchQuote(t));return quotes.get(t);};
    const compute=current, canonical=new Map();current=r=>{if(!r)return null;if(!canonical.has(r.t))canonical.set(r.t,compute(r,get(r.t)));return canonical.get(r.t);};
    const map=new Map(rows.map(r=>[r.t,r])), summary=summarize(scope==='positions'?book:{},rows,get,current,now);
    const currentPoint=checkpoint(scope,names,book,rows,get,current,session,now), comparison=changes(prior,currentPoint);
    const dollars=scope==='positions'&&summary.comparable;
    const candidates=names.map(t=>{
      const r=map.get(t),p=scope==='positions'?summary.items.find(p=>p.t===t):quoteObservation(t,r,get(t),r?current(r):null,now),why=[];
      let priority=3;
      if(p?.reason){why.push(p.reason);priority=0;}
      const changed=comparison.items.find(x=>x.t===t);if(changed){why.push(...changed.why);if(changed.why.some(x=>/earnings/.test(x)))priority=Math.min(priority,1);}
      if(notes?.[t]?.reviewDate&&notes[t].reviewDate<=day(now)){why.push('Personal review date due: '+notes[t].reviewDate);priority=Math.min(priority,1);}
      const e=events.find(x=>x.kind==='earnings'&&x.t===t);
      if(e){why.push('Earnings '+e.date+' · '+(e.timing==='date_only'?'timing unknown':e.timing.toUpperCase()));priority=Math.min(priority,2);}
      const move=dollars?p?.dollars:p?.change;
      if(finite(move))why.push('Latest-session '+(dollars?'dollar contribution':'percentage move'));
      return {t,r,p,why,priority,rank:finite(move)?Math.abs(move):-1};
    });
    const items=candidates.filter(x=>x.why.length).sort((a,b)=>a.priority-b.priority||b.rank-a.rank||a.t.localeCompare(b.t));
    return {items,coveredNames:candidates.filter(x=>finite(x.p?.price)).length,summary,currentPoint,comparison,rankLabel:dollars?'absolute same-session dollar contribution':'absolute latest-session percentage move (dollars unavailable or incomparable)'};
  }
  let stores;
  function data() {
    if(stores)return stores;
    let storage;try{storage=root.localStorage;}catch(e){storage={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}};}
    const L=root.SmartOptionsLocalData;
    stores={book:L.sharedStore(storage),private:L.sharedStore(storage,KEY,defaults)};return stores;
  }
  function statusHtml() {const s=data();return [s.book.status().warning,s.private.status().warning].filter(Boolean).map(x=>`<p class="note" role="status">${esc(x)}</p>`).join('');}
  const notice='Positions, notes and review checkpoints stay in this browser and origin. Client and preview domains do not share them; there is no cloud or phone sync.';
  function modelHTML(r,core) {
    const rel=relationships(r);if(!rel.length)return '<p>Historical relationships unavailable: fewer than 120 common sessions or missing coefficients. Missing evidence is not no exposure.</p>';
    return `<p>Historical fit: ${esc(core.rel?.window||'window unavailable')}; ${r.rel.n} sessions; R² ${finite(r.rel.r2)?r.rel.r2.toFixed(3):'unavailable'}. Other measured factors held fixed.</p><div class="private-table"><table><thead><tr><th>Factor</th><th>Coefficient / units</th><th>t statistic</th><th>60-session coefficient / t</th><th>Screen</th></tr></thead><tbody>${rel.map(x=>`<tr><td>${esc(x.factor)}</td><td>${x.c} ${esc(core.rel?.units?.[x.factor]||'units unavailable')}</td><td>${x.t}</td><td>${finite(x.c60)?x.c60:'Unavailable'} / ${finite(x.t60)?x.t60:'Unavailable'}${x.reversed?' · opposite short/long signs':''}</td><td>${x.screened?'|t| ≥2':'Weaker evidence'}</td></tr>`).join('')}</tbody></table></div><p class="dim small">|t| ≥2 is an unadjusted screen, not a probability or guarantee. Associations can change.</p>`;
  }
  function rowHTML(x,a) {
    const {t,r,p}=x,att=attribution(r),v=a.summary,scope=a.scope;
    return `<article class="personal-row" data-personal-t="${esc(t)}"><h3><a href="#/company/${esc(t)}">${esc(t)} · ${esc(r?.n||'Unsupported name')}</a></h3>
      <p data-personal-change>${esc(changeText(p))}</p>
      <p data-personal-value>${esc(valueText(p,v,scope))}</p>
      <p data-personal-why>${x.why.map(esc).join(' · ')}</p><div class="personal-actions"><a href="#/company/${esc(t)}">Open company</a>${r?`<a href="#/company/${esc(t)}/drivers">Drivers</a><a href="${esc(a.compare(t,r.sec))}" data-personal-whatif>Explore a rate/oil move</a>`:''}</div>
      <details><summary>Dates, drivers and historical relationships</summary><p data-personal-observation>${esc(observationText(p,r))}</p>
      ${att?`<p data-personal-attribution>${esc(attributionText(att,p))}</p><p>${Object.entries(att.by_factor).map(([k,v])=>esc(k)+' '+pp(v)).join(' · ')}. Model: ${esc(a.core.rel?.window||'window unavailable')}. Fitted associations do not establish news causation, alpha or future returns.</p>`:'<p>Completed-session driver decomposition unavailable or identities do not reconcile.</p>'}
      ${modelHTML(r,a.core)}</details></article>`;
  }
  const pp=v=>(v>0?'+':'')+v.toFixed(2)+' percentage points';
  function attributionText(att,p){return (att.date!==p?.session?'Prior-session analysis':'Completed-session analysis')+' · '+att.date+': actual '+pct(att.actual)+', fitted factor contribution '+pp(att.explained)+', unexplained remainder '+pp(att.stock_specific)+'.';}
  function eventRelationships(e,names,a){
    const factor=/oil|energy|petroleum|gas|eia/i.test(e.title)?'wti':'us10y_bps';
    return names.slice(0,24).map(t=>{const r=a.core.rows.find(r=>r.t===t),m=relationships(r).find(x=>x.factor===factor);
      return `<li><a href="#/company/${esc(t)}/drivers">${esc(t)}</a>: ${m?`${m.c} ${esc(a.core.rel?.units?.[factor]||'units unavailable')}; t ${m.t}; n ${m.n}; R² ${finite(m.r2)?m.r2:'unavailable'}${m.reversed?'; opposite 60-session sign':''}${m.screened?'; unadjusted |t| ≥2 screen':'; weaker evidence'}`:'eligible historical relationship unavailable'}</li>`;
    }).join('')+(names.length>24?'<li>First 24 names shown; other names remain available through review pages.</li>':'');
  }
  function changeText(p){return pct(p?.change)+' · '+(p?.session||'session unavailable')+(finite(p?.dollars)?' · contribution '+money(p.dollars):' · Dollar change unavailable');}
  function valueText(p,v,scope){return scope==='positions'?(finite(p?.value)?money(p.value)+(v.total>0?' · '+(100*p.value/v.total).toFixed(1)+'% '+v.weightLabel:''):p?.reason||'Value unavailable'):'Saved company; ownership is not assumed.';}
  function observationText(p,r){return 'Price source: '+p?.source+' · observed '+(p?.ts?humanET(p.ts):r?.pxd||'unavailable')+'. Quotes and completed-session analysis are separate clocks.';}
  function mountToday(host,a) {
    const s=data();let quoteTask=null,rowObserver=null,page=0,expanded=false,scope=host.dataset.scope||(active(s.book.get().book).length?'positions':'saved');
    function draw() {
      if(!host.isConnected)return;
      host.dataset.scope=scope;
      const book=s.book.get().book||{},priv=s.private.get(),names=scope==='positions'?active(book):a.watch.get(),ev=a.events(),days=a.days();
      const res=queue({names,scope,book,rows:a.core.rows,get:a.live.get,current:(r,q)=>r?a.live.currentRow(r,q):null,session:a.brief.asof_session,notes:priv.notes,prior:priv.checkpoints?.[scope],events:ev.items});
      const summary=res.summary,sector={};
      names.forEach(t=>{const r=a.core.rows.find(r=>r.t===t),v=scope==='positions'?summary.items.find(p=>p.t===t)?.value:1;if(finite(v))sector[r?.sec||'Unknown']=(sector[r?.sec||'Unknown']||0)+v;});
      const start=page*24,shown=expanded?res.items.slice(start,start+24):res.items.slice(0,3);
      const relevant=ev.items.filter(e=>e.kind==='macro'||names.includes(e.t));
      const oldFocus=root.document.activeElement?.dataset?.personal;
      host.innerHTML=`<div class="personal-heading"><h2>For you</h2><a href="#/positions">Manage positions</a></div><p class="small">Saved names work without holdings. Positions and notes stay in this browser.</p>
        <div class="personal-actions" role="group" aria-label="Personal scope"><button data-personal="saved" aria-pressed="${scope==='saved'}">Saved companies</button><button data-personal="positions" aria-pressed="${scope==='positions'}">Positions</button></div>${statusHtml()}
        <p class="wl-note note" role="status"${a.watch.status?.().ok?' hidden':''}>${esc(a.watch.status?.().error||'')}</p>
        ${!names.length?`<p>No review checkpoint yet.</p><p>${scope==='positions'?'No entered positions. Following a company does not assert ownership.':'No saved companies yet. Follow names to see relevant prices, events and drivers.'}</p><div class="personal-actions"><button data-personal="search">Add companies</button><a href="#/companies?mode=saved">View Saved</a><a href="#/positions">Add positions (optional)</a></div>`:
        `<p class="personal-summary">${scope==='saved'?names.length+' names followed':summary.label+': '+money(summary.total)+' · '+summary.priced.length+'/'+summary.items.length+' entered positions priced'}. Latest completed data session: ${esc(a.brief.asof_session)}.</p>
        <p class="small">${relevant[0]?'Next listed event: '+esc(relevant[0].date)+' · '+esc(relevant[0].title)+' · '+esc(relevant[0].timing==='date_only'?'timing unknown':relevant[0].timing):'No relevant event listed; calendar coverage may be unavailable.'}</p>
        ${scope==='positions'?`<p class="dim small" data-personal-equity-method>Current value of entered shares only. ${finite(summary.dollars)?'Same-session dollar change '+money(summary.dollars):'Dollar change unavailable: matching sessions and dated regular closes are required.'}</p>`:''}
        <div class="review-clock"><p>${esc(res.comparison.text)}</p><ul data-review-changes>${res.comparison.items.map(x=>`<li>${esc(x.t)}: ${x.why.map(esc).join('; ')}</li>`).join('')}</ul><button data-personal="review">Mark reviewed</button><span role="status" id="review-status"></span></div>
<div class="personal-items">${shown.map(x=>rowHTML(x,{...a,scope,summary})).join('')||`<p>${res.coveredNames===0?'No covered price data.':'No relevant tracked changes or measured moves.'} Check calendar coverage below.</p>`}</div>
        ${res.items.length>3&&!expanded?'<button data-personal="all">Show all</button>':''}${expanded?`<div class="personal-actions"><button data-personal="prev" ${page===0?'disabled':''}>Previous</button><span>${start+1}–${Math.min(start+24,res.items.length)} of ${res.items.length}</span><button data-personal="next" ${start+24>=res.items.length?'disabled':''}>Next</button></div>`:''}
        <details class="small"><summary>Method · what is tracked?</summary><p>Entered equities are not complete net worth or a broker-reconciled account. Missing values prevent a value-based coverage percentage. Quantities are assumed held over the quoted interval; trades, dividends and fees are excluded. Tracked fields: completed session, next earnings information, price coverage and entered quantities. Latest-session movements remain separate.</p><p>Coverage gaps first; changed earnings or due personal review next; earnings in ${days} days; then ${esc(res.rankLabel)}. One item per name; ties use ticker order. No urgency score.</p></details>
        <p class="dim small">Review order refreshed ${esc(humanET(new Date().toISOString()))}. Quote values update in place. <button data-personal="refresh">Refresh review items</button></p>
        <details class="personal-exposure"><summary>${scope==='positions'?'Position and sector shares':'Followed sectors (counts)'}</summary><p data-personal-coverage>${scope==='positions'?summary.weightLabel+'; '+summary.priced.length+'/'+summary.items.length+' positions priced.':'Counts are not capital exposure.'}</p><ul>${Object.entries(sector).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).map(([k,v])=>`<li>${esc(k)}: <span data-sector-share="${esc(k)}">${scope==='positions'?(summary.total>0?(100*v/summary.total).toFixed(1)+'%':'Unavailable'):v+' names'}</span></li>`).join('')}</ul>${scope==='positions'?`<ul>${summary.priced.slice().sort((a,b)=>b.value-a.value).map(p=>`<li><a href="#/company/${esc(p.t)}">${esc(p.t)}</a>: <span data-position-share="${esc(p.t)}">${money(p.value)}${summary.total>0?' · '+(100*p.value/summary.total).toFixed(1)+'%':''}</span></li>`).join('')}</ul>`:''}</details>
        <details><summary>Relevant known events · next ${days} days</summary>${relevant.length?`<ul>${relevant.map(e=>`<li>${esc(e.date)} · ${esc(e.title)} · ${esc(e.timing==='date_only'?'timing unknown':e.timing)}${e.kind==='earnings'&&scope==='positions'?' · entered size '+money(summary.items.find(p=>p.t===e.t)?.value):''}${e.kind==='macro'?`<p>Possible channel: ${/oil|energy/i.test(e.title)?'energy costs and producer revenues':/employment|payroll|job/i.test(e.title)?'demand, wages and policy expectations':'discount rates, financing costs and demand'}. Sign and magnitude are unknown. Affected names to investigate: </p><ul>${eventRelationships(e,names,a)}</ul><p class="dim small">Measured associations: ${esc(a.core.rel?.window||'fit window unavailable')}. The unadjusted screen is not a probability. These conditional historical slopes do not estimate this event’s impact.</p>`:''}</li>`).join('')}</ul>`:'<p>No relevant events listed in this horizon. An empty calendar is not evidence that nothing is scheduled.</p>'}<p>${ev.notes.map(esc).join(' ')}</p><a href="#/macro">Release evidence and sources</a></details>`}
        <p class="dim small">${notice}</p>`;
      rowObserver?.disconnect();a.live.watch('investor',[]);
      const visible=new Set(),rows=[...host.querySelectorAll('[data-personal-t]')];
      if(root.IntersectionObserver){rowObserver=new root.IntersectionObserver(entries=>{if(!host.isConnected)return;entries.forEach(e=>{if(e.isIntersecting)visible.add(e.target.dataset.personalT);else visible.delete(e.target.dataset.personalT);});a.live.watch('investor',shown.map(x=>x.t).filter(t=>visible.has(t)));});rows.forEach(el=>rowObserver.observe(el));}
      else a.live.watch('investor',rows.filter(el=>{const r=el.getBoundingClientRect();return r.bottom>0&&r.top<root.innerHeight;}).map(el=>el.dataset.personalT));
      host.querySelectorAll('[data-personal-whatif]').forEach(el=>el.onclick=()=>{root.__soPersonalWhatif=true;});
      host.querySelectorAll('[data-personal]').forEach(el=>el.onclick=()=>{
        const action=el.dataset.personal;
        if(action==='search'){root.document.querySelector('#gsearch')?.focus();root.scrollTo(0,0);return;}
        if(action==='review') {const p=s.private.get();p.checkpoints ||= {};p.checkpoints[scope]=checkpoint(scope,names,book,a.core.rows,a.live.get,(r,q)=>r?a.live.currentRow(r,q):null,a.brief.asof_session);const saved=s.private.put(p);draw();const st=host.querySelector('#review-status');if(st)st.textContent=saved.ok?'Review checkpoint saved.':s.private.status().warning;return;}
        if(action==='refresh'){}else if(action==='all')expanded=true;else if(action==='prev')page--;else if(action==='next')page++;else{scope=action;page=0;expanded=false;}
        draw();host.querySelector(`[data-personal="${action}"]`)?.focus({preventScroll:true});
      });
      if(oldFocus)host.querySelector(`[data-personal="${oldFocus}"]`)?.focus({preventScroll:true});
    }
    draw();host._refresh=draw;
    return {refresh:draw,suspend(){rowObserver?.disconnect();rowObserver=null;if(quoteTask!=null){clearTimeout(quoteTask);quoteTask=null;}a.live.watch('investor',[]);},quotes(changed){
      if(quoteTask!=null)return;
      quoteTask=setTimeout(()=>{quoteTask=null;
      // Patch text in place; forms, links, controls and their focus survive ticks.
      if(!host.isConnected)return;
      const book=s.book.get().book||{},priv=s.private.get(),names=scope==='positions'?active(book):a.watch.get();
      const res=queue({names,scope,book,rows:a.core.rows,get:a.live.get,current:(r,q)=>r?a.live.currentRow(r,q):null,session:a.brief.asof_session,notes:priv.notes,prior:priv.checkpoints?.[scope],events:a.events().items});
      host.querySelectorAll('[data-personal-t]').forEach(el=>{const x=res.items.find(x=>x.t===el.dataset.personalT);if(!x)return;el.querySelector('[data-personal-change]').textContent=changeText(x.p);el.querySelector('[data-personal-value]').textContent=valueText(x.p,res.summary,scope);el.querySelector('[data-personal-why]').textContent=x.why.join(' · ');el.querySelector('[data-personal-observation]').textContent=observationText(x.p,x.r);const att=attribution(x.r),n=el.querySelector('[data-personal-attribution]');if(att&&n)n.textContent=attributionText(att,x.p);});
      const clock=host.querySelector('.review-clock>p');if(clock)clock.textContent=res.comparison.text;
      const differences=host.querySelector('[data-review-changes]');if(differences){const html=res.comparison.items.map(x=>`<li>${esc(x.t)}: ${x.why.map(esc).join('; ')}</li>`).join('');if(differences.innerHTML!==html)differences.innerHTML=html;}
      const sum=host.querySelector('.personal-summary');if(sum&&scope==='positions')sum.textContent=res.summary.label+': '+money(res.summary.total)+' · '+res.summary.priced.length+'/'+res.summary.items.length+' entered positions priced. Latest completed data session: '+a.brief.asof_session+'.';
      if(scope==='positions'){
        const v=res.summary,sectors={};v.priced.forEach(p=>{const k=p.r?.sec||'Unknown';sectors[k]=(sectors[k]||0)+p.value;});
        host.querySelectorAll('[data-sector-share]').forEach(n=>n.textContent=v.total>0&&finite(sectors[n.dataset.sectorShare])?(100*sectors[n.dataset.sectorShare]/v.total).toFixed(1)+'%':'Unavailable');
        host.querySelectorAll('[data-position-share]').forEach(n=>{const p=v.items.find(p=>p.t===n.dataset.positionShare);n.textContent=money(p?.value)+(finite(p?.value)&&v.total>0?' · '+(100*p.value/v.total).toFixed(1)+'%':'');});
        const coverage=host.querySelector('[data-personal-coverage]');if(coverage)coverage.textContent=v.weightLabel+'; '+v.priced.length+'/'+v.items.length+' positions priced.';
        const method=host.querySelector('[data-personal-equity-method]');if(method)method.textContent='Current value of entered shares only. '+(finite(v.dollars)?'Same-session dollar change '+money(v.dollars):'Dollar change unavailable: matching sessions and dated regular closes are required.');
      }
      },0);
    }};
  }
  function mountPositions(main,a,ticker='') {
    const s=data(),L=root.SmartOptionsLocalData;let preview=null,raw='',costMode='',expected=null;
    const map=new Map(a.core.rows.map(r=>[r.t,r]));
    main.innerHTML=`<section class="positions"><h1>Your positions</h1><p>Optional long USD common-equity quantities for covered companies. Fractional shares are supported. Costs are optional USD per share. Zero shares retains an inactive record.</p><p>${notice}</p><div id="position-warnings">${statusHtml()}</div>
      <form id="position-form"><label>Company ticker<input id="position-ticker" list="position-symbols" autocomplete="off" value="${esc(ticker)}" required></label><datalist id="position-symbols">${a.core.rows.filter(r=>r.sp500_member!==false).map(r=>`<option value="${esc(r.t)}">${esc(r.n)}</option>`).join('')}</datalist>
      <label>Shares<input id="position-qty" type="number" inputmode="decimal" step="any" min="0" required></label><label>Average cost (USD/share, optional)<input id="position-cost" type="number" inputmode="decimal" step="any" min="0"></label><button>Preview position</button></form>
      <details><summary>Import CSV, TSV, text or JSON</summary><label>File (up to 5 MB)<input type="file" id="position-file" accept=".csv,.tsv,.txt,.json"></label><label>Paste a table<textarea id="position-import" rows="4"></textarea></label><button id="position-parse">Preview import</button><label>Ambiguous cost meaning<select id="position-cost-mode"><option value="">Choose cost meaning</option><option value="perShare">Per-share cost</option><option value="total">Total cost</option><option value="ignore">Ignore cost</option></select></label></details>
      <div id="position-preview"></div><p id="position-status" role="status" aria-live="polite"></p><button id="position-reload">Discard unsaved changes and reload</button><div id="position-list"></div><p><a href="#/">Return to For you</a></p></section>`;
    const $=q=>main.querySelector(q),status=t=>{$('#position-status').textContent=t;$('#position-warnings').innerHTML=statusHtml();};
    function list(){const b=s.book.get().book||{},v=summarize(b,a.core.rows,a.live.get,(r,q)=>r?a.live.currentRow(r,q):null);$('#position-list').innerHTML=`<h2>Entered equities</h2><p>${v.label}: ${money(v.total)} · ${v.priced.length}/${v.items.length} active entries priced. These entries are not complete net worth.</p><div class="private-table"><table><thead><tr><th>Ticker</th><th>Shares / provenance</th><th>Cost (USD/share)</th><th>Value</th><th>Unrealized amount</th><th></th></tr></thead><tbody>${Object.entries(b).map(([t,raw])=>{const h=raw&&typeof raw==='object'?raw:{};const p=v.items.find(p=>p.t===t);return `<tr><td>${esc(t)}</td><td>${esc(h?.qty??'Unknown')} · ${esc(h?.provenance||'Legacy entry')}</td><td>${h?.costMeaning==='perShare'?money(h.cost):'Unconfirmed; P&L withheld'}</td><td>${h?.qty===0?'Inactive':money(p?.value)}${p?.reason?' · '+esc(p.reason):''}</td><td>${money(p?.pnl)}</td><td><button data-edit-position="${esc(t)}">Edit ${esc(t)}</button></td></tr>`;}).join('')}</tbody></table></div>`;
      main.querySelectorAll('[data-edit-position]').forEach(btn=>btn.onclick=()=>{const t=btn.dataset.editPosition,h=b[t]||{};$('#position-ticker').value=t;$('#position-qty').value=finite(h.qty)?h.qty:'';$('#position-cost').value=h.costMeaning==='perShare'&&finite(h.cost)?h.cost:'';$('#position-qty').focus();});}
    function show(result){preview=result;expected=s.book.get();const book=expected.book||{}, entries=L.confirmedBook(result),conflicts=Object.keys(entries).filter(t=>book[t]!=null);
      $('#position-preview').innerHTML=`<h2>Preview · ${result.rowsRead} input rows</h2><p>${esc(result.reason)} ${result.partial?'Partial selection; excluded rows remain unchanged.':''}</p>${result.costChoiceRequired?'<p class="note">Choose cost meaning before Apply. Costs are currently withheld.</p>':''}<ul>${(result.accounting||[]).map(x=>`<li>Row ${x.row} · ${esc(x.t)}: ${esc(x.status)}</li>`).join('')}</ul><p>${result.duplicateLots||0} duplicate lots consolidated.</p><ul>${Object.entries(result.book||{}).map(([t,b])=>`<li>${esc(t)}: shares ${esc(b.qty??'Unknown')} · cost/share ${money(b.cost)}</li>`).join('')}</ul>
        ${conflicts.length?`<p>Existing entries conflict. Unselected replacements stay unchanged:</p>${conflicts.map(t=>`<label><input type="checkbox" data-replace-position="${esc(t)}"> Replace ${esc(t)} · old shares ${esc(book[t].qty??'unknown')}, cost ${esc(costDescription(book[t]))} → new shares ${entries[t].qty}, cost ${money(entries[t].cost)}</label>`).join('')}`:''}
        <button id="position-apply" ${!Object.keys(entries).length||result.costChoiceRequired?'disabled':''}>Apply merge</button><button id="position-cancel">Cancel</button>${result.matched?.length?'<button id="position-names">Save names only</button>':''}`;
      $('#position-cancel').onclick=()=>{preview=null;$('#position-preview').replaceChildren();status('Cancelled; local data unchanged.');};
      $('#position-names')?.addEventListener('click',()=>{a.watch.add(result.matched);status(a.watch.status().ok?'Names saved; ownership not assumed.':'Names retained in this tab; device save unavailable.');});
      $('#position-apply').onclick=()=>{
        const before=s.book.get();if(JSON.stringify(before)!==JSON.stringify(expected)){status('Local data changed. Reload and preview again.');return;}
        const next={...before,book:{...(before.book||{})}};let count=0;
        Object.entries(entries).forEach(([t,b])=>{if(!map.has(t)||map.get(t).sp500_member===false)return;if(next.book[t]!=null&&!main.querySelector(`[data-replace-position="${t}"]`)?.checked)return;next.book[t]={...(next.book[t]||{}),...b};count++;});
        if(!count){status('No entries selected; existing positions unchanged.');return;}
        const saved=s.book.put(next);list();status(saved.ok?'Saved and verified on this device.':s.book.status().warning);if(saved.ok){$('#position-preview').replaceChildren();root.dispatchEvent(new Event('so:investor'));}
      };
    }
    $('#position-form').onsubmit=e=>{e.preventDefault();const t=$('#position-ticker').value.trim().toUpperCase().replace('.','-'),qty=L.num($('#position-qty').value),c=$('#position-cost').value.trim(),cost=c?L.num(c):null;
      if(!map.has(t)||map.get(t).sp500_member===false||qty==null||qty<0||(c&&(cost==null||cost<0))){status('Enter a covered common-equity ticker, nonnegative shares and optional nonnegative USD/share cost.');return;}
      show({rowsRead:1,book:{[t]:{qty,cost}},matched:[t],reason:'Manual quantity confirmed; optional cost is USD per share.',accounting:[{row:1,t,status:'accepted'}]});};
    const parse=()=>{raw=$('#position-import').value;show(L.classify(raw,'local import',a.core.rows.filter(r=>r.sp500_member!==false).map(r=>r.t),costMode?{costMode}:{}));};
    $('#position-parse').onclick=parse;$('#position-cost-mode').onchange=e=>{costMode=e.target.value;parse();};
    $('#position-file').onchange=async e=>{try{const f=e.target.files[0];if(!f)return;if(f.size>5e6){status('File exceeds 5 MB; nothing read or saved.');return;}$('#position-import').value=await f.text();parse();}catch(err){status('File could not be read; nothing saved.');}};
    $('#position-reload').onclick=()=>{s.book.reload({discard:true});s.private.reload({discard:true});preview=null;$('#position-preview').replaceChildren();list();status('Latest local data reloaded. Preview again before applying.');};
    list();if(ticker)main.querySelector(`[data-edit-position="${ticker}"]`)?.click();
  }
  function mountNote(host,t) {
    const s=data(),p=s.private.get(),note=p.notes?.[t]||{};
    host.innerHTML=`<details><summary>Your research note</summary><p>${notice} This is your plain text, separate from the published Case and Objection.</p>${statusHtml()}<label>Note (maximum 1,000 characters)<textarea maxlength="1000" rows="4" data-private-note>${esc(note.text||'')}</textarea></label><label>Optional review date<input type="date" data-private-date value="${esc(note.reviewDate||'')}"></label><button data-note-save>Save note</button><button data-note-reload>Discard unsaved note and reload</button><span data-note-status role="status" aria-live="polite">${esc(s.private.status().warning||(note.text?'Saved on this device.':'No saved note.'))}</span></details>`;
    const text=host.querySelector('textarea'),date=host.querySelector('input'),st=host.querySelector('[data-note-status]');
    const dirty=()=>{st.textContent='Unsaved changes.';};text.oninput=dirty;date.oninput=dirty;
    host.querySelector('[data-note-save]').onclick=()=>{const v=s.private.get();v.notes ||= {};v.notes[t]={text:text.value.slice(0,1000),reviewDate:date.value||null};const saved=s.private.put(v);st.textContent=saved.ok?'Saved and verified on this device.':s.private.status().warning;};
    host.querySelector('[data-note-reload]').onclick=()=>{s.private.reload({discard:true});mountNote(host,t);};
  }
  if(root.addEventListener)root.addEventListener('storage',e=>{if(!['so_import_v1','so_local_imports_v1',KEY].includes(e.key))return;root.document.querySelectorAll('#position-status,[data-note-status]').forEach(n=>n.textContent='Another tab changed local data. Reload latest before saving; unsaved typing is retained.');root.document.querySelectorAll('#for-you').forEach(n=>{const msg=root.document.createElement('p');msg.className='note';msg.setAttribute('role','status');msg.textContent='Another tab changed local data. Reload this page to compare the latest.';n.prepend(msg);});});
  return {KEY,defaults,active,regularBasis,humanET,quoteObservation,position,summarize,checkpoint,changes,attribution,relationships,queue,mountToday,mountPositions,mountNote};
});
