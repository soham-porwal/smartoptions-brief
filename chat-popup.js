/* SmartOptions Brief chat popup (lane BU1). A floating panel over any page; reuses the chat module
   (window.SmartOptionsChat.ask + the data tool API) instead of the old docked panel.
   Providers: shared assistant (data/config.json chat_proxy_url; no key in the browser), the reader's own
   Anthropic key (localStorage only), and quick answers built from brief.json with no model at all. */
'use strict';
(function (root, factory) {
  const P = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = P;
  root.SmartOptionsChatPopup = P;
  if (root.document) P._start();
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  const LS_KEY = 'smartoptions.chat.apiKey';          // same key slot the chat module reads
  const LS_PROV = 'so-brief-chat-provider';
  const LS_MODEL = 'smartoptions.chat.model';
  const SS_DRAFT = 'so-brief-chat-draft';             // unsent typing survives close/reopen and reloads in this tab
  // Main does not load the docked chat module, so the supported model list lives here too.
  const MODELS = [{id: 'claude-sonnet-5-5', label: 'Sonnet 5.5'}, {id: 'claude-opus-5-5', label: 'Opus 5.5'}, {id: 'claude-haiku-5-5', label: 'Haiku 5.5'}];
  const models = () => (C() && Array.isArray(C().MODELS) && C().MODELS.length ? C().MODELS : MODELS);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const isNum = v => typeof v === 'number' && isFinite(v);

  /* ---------------------------------------------------------------- quick answers (pure) */
  const PRESETS = [
    {id: 'changed', q: 'What changed today?'},
    {id: 'sectors', q: 'Which sectors lead?'},
    {id: 'risks', q: 'What are the biggest risks this week?'},
    {id: 'shortlist', q: 'Show me the shortlist reasons'}];
  function val(m) {
    if (!m || m.value == null) return 'not available';
    const B = root.SmartOptionsBrief;
    return B ? (B.fmtValue(m) || 'not available') : String(m.value) + (m.unit ? ' ' + m.unit : '');
  }
  // returns {lines: [{text, refs:[n]}], sources: [{n, label, value, asof, source, url}], empty: reason|null}
  function answerPreset(id, brief, watch) {
    const sources = [], lines = [];
    const cite = ms => (ms || []).filter(Boolean).slice(0, 3).map(m => {
      const n = sources.length + 1;
      sources.push({n, label: m.label || '', value: val(m), asof: m.asof || m.period || '', source: m.source || '', url: m.source_url || ''});
      return n;
    });
    const add = (text, ms) => { if (text) lines.push({text: String(text), refs: cite(ms)}); };
    if (!brief) return {lines, sources, empty: 'The brief data file is not available, so there is nothing to answer from.'};
    if (id === 'changed') {
      const p = brief.pulse || {};
      if (p.headline) add(p.headline, []);
      (p.changed || []).forEach(b => add(b.text, b.metrics));
      if (!(p.changed || []).length) return {lines, sources, empty: 'No change since the previous session is recorded in this brief.'};
    } else if (id === 'sectors') {
      const ro = (brief.positioning || {}).rotation || {};
      if (ro.line && !/^Not available/.test(ro.line)) add(ro.line, ro.metrics);
      (ro.leaders || []).slice(0, 3).forEach(s => add(s.sector + ' leads: ' + (isNum(s.ret_20d_pct) ? (s.ret_20d_pct > 0 ? '+' : '') + s.ret_20d_pct.toFixed(1) + '% over 20 days.' : 'return not available.'), []));
      (ro.laggards || []).slice(0, 2).forEach(s => add(s.sector + ' lags: ' + (isNum(s.ret_20d_pct) ? (s.ret_20d_pct > 0 ? '+' : '') + s.ret_20d_pct.toFixed(1) + '% over 20 days.' : 'return not available.'), []));
      if (!lines.length) {
        const xs = ((brief.positioning || {}).sectors || []).filter(s => isNum(s.d1)).sort((a, b) => b.d1 - a.d1);
        xs.slice(0, 3).forEach(s => add(s.sector + ': ' + (s.d1 > 0 ? '+' : '') + s.d1.toFixed(2) + '% today.', []));
      }
      if (!lines.length) return {lines, sources, empty: 'Sector returns are not in this brief.'};
    } else if (id === 'risks') {
      const B = root.SmartOptionsBrief;
      const xs = B ? B.sortRisks(brief.risks, watch || new Set(), Date.now()) : (brief.risks || []);
      xs.slice(0, 5).forEach(r => {
        const t = Date.parse(r.when_et || '');
        let when = '';
        try { when = isFinite(t) ? new Date(t).toLocaleDateString('en-US', {timeZone: /^\d{4}-\d{2}-\d{2}$/.test(r.when_et) ? 'UTC' : 'America/New_York', weekday: 'short', month: 'short', day: 'numeric'}) + ': ' : ''; } catch (e) { when = ''; }
        add(when + r.title + (r.why ? '. ' + r.why : ''), r.metrics);
      });
      if (!lines.length) return {lines, sources, empty: 'No scheduled releases or earnings are recorded in this brief.'};
    } else if (id === 'shortlist') {
      (brief.shortlist || []).slice(0, 8).forEach(n => {
        const why = (n.why || [])[0];
        add((n.name || n.t) + ' (' + n.t + ')' + (isNum(n.score) ? ', score ' + Math.round(n.score) : '') + ': ' + (why ? why.text : 'no reason recorded') +
          (n.counter && n.counter.text ? ' Against: ' + n.counter.text : ''), [].concat(why ? why.metrics || [] : [], n.counter ? n.counter.metrics || [] : []));
      });
      if (!lines.length) return {lines, sources, empty: 'No names are on the shortlist in this brief.'};
    } else return {lines, sources, empty: 'Unknown question.'};
    return {lines, sources, empty: null};
  }
  function answerHTML(a) {
    if (a.empty && !a.lines.length) return `<p class="cp-na">Not available: ${esc(a.empty)}</p>`;
    return `<ul class="cp-lines">${a.lines.map(l => `<li>${esc(l.text)}${l.refs.map(n => ` <sup class="cp-ref">[${n}]</sup>`).join('')}</li>`).join('')}</ul>` +
      (a.sources.length ? `<details class="cp-src"><summary>Sources (${a.sources.length})</summary><ol>${a.sources.map(s => `<li>${esc(s.label)}: ${esc(s.value)}${s.asof ? ', ' + esc(s.asof) : ''}. ${/^https?:\/\//.test(s.url) ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.source || 'source')}</a>` : esc(s.source)}</li>`).join('')}</ol></details>` : '') +
      '<p class="cp-foot">Built from today\'s brief file, no model involved.</p>';
  }

  /* ---------------------------------------------------------------- DOM */
  const doc = root.document;
  const ST = {cfg: null, provider: 'local', conv: null, busy: false, open: false, opener: null, controller:null};
  function store() { try { return root.localStorage; } catch (e) { return null; } }
  function getKey() { try { const s = store(); return (s && s.getItem(LS_KEY)) || ''; } catch(e) { reportStorage(); return ''; } }
  function reportStorage(){root.SmartOptionsBriefChat?.record('WARN','storage','Browser could not save chat settings.');const n=doc?.querySelector('.cp-provnote');if(n)n.textContent='Browser storage is unavailable. Chat settings were not saved.';}
  function saveSetting(key,value){try{const s=store();if(!s)throw new Error('Storage unavailable');if(value===null)s.removeItem(key);else s.setItem(key,value);return true;}catch(e){reportStorage();return false;}}
  function viewportGeometry(view,width,height){
    const v=view||{},w=width||root.innerWidth||1024,mobile=w<=560||(w<=1024&&!!root.matchMedia?.('(pointer:coarse)').matches),h=Math.max(120,Math.floor(v.height||height||root.innerHeight||700)),top=Math.max(0,Math.floor(v.offsetTop||0));
    return {mobile,top:top+8,height:Math.max(100,h-16),keyboard:h<(height||root.innerHeight||h)-100};
  }
  function syncViewport(){const p=doc.getElementById('cp-panel');if(!p)return;const g=viewportGeometry(root.visualViewport,root.innerWidth,root.innerHeight);p.style.setProperty('--cp-vtop',g.top+'px');p.style.setProperty('--cp-vheight',g.height+'px');p.classList.toggle('cp-keyboard',g.keyboard);}
  function saveDraft(v){try{if(v)root.sessionStorage?.setItem(SS_DRAFT,String(v).slice(0,2000));else root.sessionStorage?.removeItem(SS_DRAFT);}catch(e){root.SmartOptionsBriefChat?.record('WARN','storage','Draft not saved.');}}
  function scrollLog(){const log=doc.querySelector('#cp-panel .cp-body');if(log)log.scrollTop=log.scrollHeight;}
  function proxyUrl() {
    // The relay serves the published sites. Local development keeps deterministic
    // answers without making doomed cross-origin requests or spending shared quota.
    const origins = ['https://soham-porwal.github.io', 'https://samsej.github.io'];
    if (!origins.includes(root.location && root.location.origin)) return '';
    return ST.cfg && typeof ST.cfg.chat_proxy_url === 'string' && /^https:\/\//.test(ST.cfg.chat_proxy_url) ? ST.cfg.chat_proxy_url : '';
  }
  function C() { return root.SmartOptionsChat; }

  function build() {
    const placeholder = doc.querySelector('.cp-fab[data-placeholder]'), restoreFocus = placeholder === doc.activeElement;
    placeholder?.remove();
    const btn = doc.createElement('button');
    btn.type = 'button'; btn.className = 'cp-fab'; btn.id = 'cp-fab';
    btn.setAttribute('aria-label', 'Open chat'); btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-controls', 'cp-panel');
    btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.5.4-1.3.1-1.3-.6V16A2.5 2.5 0 0 1 4 13.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 8.5h8M8 11.5h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    const p = doc.createElement('section');
    p.className = 'cp'; p.id = 'cp-panel'; p.hidden = true;
    p.setAttribute('role', 'dialog'); p.setAttribute('aria-label', 'Chat about this data');
    p.innerHTML = `<div class="cp-hd"><h2>Ask about this data</h2><button type="button" class="cp-x" aria-label="Close chat">&times;</button></div>
      <div class="cp-body"><div class="cp-prov" role="radiogroup" aria-label="Answer with">
        <button type="button" role="radio" data-prov="shared">Shared assistant</button>
        <button type="button" role="radio" data-prov="key">Use my own key</button>
        <button type="button" role="radio" data-prov="local">Quick answers</button>
      </div>
      <div class="cp-provnote"></div>
      <form class="cp-key" hidden onsubmit="return false"><label>Anthropic API key<input type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-..."></label>
        <label>Model for your own key<select class="cp-model" aria-label="Your paid model"><option value="">Choose a model (your provider pricing)</option>${models().map(m=>`<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('')}</select></label>
        <div class="cp-row"><button type="button" class="cp-save">Save key</button><button type="button" class="cp-forget">Forget key</button></div>
        <p class="cp-small">Kept only in this browser and sent only to api.anthropic.com. Avoid on a shared computer.</p></form>
      <div class="cp-log" aria-live="polite"></div>
      <div class="cp-dash-tools"><button type="button" class="cp-dash-example">Create a war room</button><a class="cp-rooms" href="${root.SmartOptionsMain ? '#/room' : '#/my-dash'}">Saved rooms</a></div>
      <div class="cp-chips" aria-label="Quick questions">${['pulse','risks','shortlist','breadth','sectors','freshness'].map(id => `<button type="button" data-intent="${id}">${esc(root.SmartOptionsIntents.chipText(id))}</button>`).join('')}</div></div>
      <form class="cp-in"><textarea rows="1" aria-label="Your question" placeholder="Ask a question"></textarea><button type="submit" class="cp-send" aria-label="Send">Send</button></form>
      <button type="button" class="cp-cancel" hidden>Cancel</button><p class="cp-disc">Research tool, not advice. Answers cite the data on this site.</p>`;
    doc.body.append(btn, p);
    if (restoreFocus) btn.focus({preventScroll: true});
    root.visualViewport?.addEventListener('resize',syncViewport);root.visualViewport?.addEventListener('scroll',syncViewport);root.addEventListener('resize',syncViewport);syncViewport();
    p.querySelector('.cp-dash-example').addEventListener('click',()=>{const ta=p.querySelector('.cp-in textarea');ta.value='Create a war room for NVDA';saveDraft(ta.value);ta.focus();});
    btn.addEventListener('click', () => toggle());
    p.querySelector('.cp-x').addEventListener('click', () => toggle(false));
    p.querySelector('.cp-prov').addEventListener('click', e => { const b = e.target.closest('[data-prov]'); if (b && !b.disabled) setProvider(b.dataset.prov, true); });
    p.addEventListener('click', e => { const b=e.target.closest('[data-intent]');if(b)submit(b.textContent,{intent:b.dataset.intent,entities:JSON.parse(b.dataset.entities||'{}')}); });
    p.querySelector('.cp-cancel').addEventListener('click',()=>ST.controller?.abort());
    p.querySelector('.cp-save').addEventListener('click', () => { const i = p.querySelector('.cp-key input'); const v = i.value.trim(); const ok=v&&saveSetting(LS_KEY,v); i.value = ''; if(ok)renderProv(); });
    p.querySelector('.cp-forget').addEventListener('click', () => { if(saveSetting(LS_KEY,null))renderProv(); });
    const model=p.querySelector('.cp-model');try{model.value=store()?.getItem(LS_MODEL)||'';}catch(e){reportStorage();}model.addEventListener('change',()=>{if(saveSetting(LS_MODEL,model.value))renderProv();});
    p.querySelector('.cp-in').addEventListener('submit', e => { e.preventDefault(); submit(); });
    const ta = p.querySelector('.cp-in textarea');
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });
    ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(120, ta.scrollHeight) + 'px'; saveDraft(ta.value); });
    try { const d = root.sessionStorage?.getItem(SS_DRAFT); if (d) ta.value = d.slice(0, 2000); } catch (e) { root.SmartOptionsBriefChat?.record('WARN', 'storage', 'Draft could not be restored.'); }
    doc.addEventListener('keydown', e => {
      if (e.key === 'Escape' && ST.open) { toggle(false); return; }
      const typing = /INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || '') || (e.target && e.target.isContentEditable);
      const research = root.SmartOptionsBrief && root.SmartOptionsBrief.isResearch();   // '/' is search on the research desk
      if (e.key === '/' && !typing && !research &&!e.ctrlKey && !e.metaKey && !e.altKey && !ST.open) { e.preventDefault(); toggle(true); }
    });
  }
  function toggle(force) {
    const p = doc.getElementById('cp-panel'), b = doc.getElementById('cp-fab');
    const open = force == null ? p.hidden : force;
    ST.open = open; p.hidden = !open; b.setAttribute('aria-expanded', String(open)); b.classList.toggle('on', open);
    b.setAttribute('aria-label', open ? 'Close chat' : 'Open chat');
    doc.documentElement.classList.toggle('cp-open',open);
    if (open) { syncViewport();renderProv(); if (!p.querySelector('.cp-log').children.length) greet(); p.querySelector('.cp-in textarea').focus({preventScroll:true}); }
    else { ST.controller?.abort(); p.querySelector('.cp-in textarea').blur();b.focus({preventScroll:true}); }
  }
  function greet() {
    const log = doc.querySelector('#cp-panel .cp-log');
    log.innerHTML = '<p class="cp-hello">Pick a question below for an instant answer from today\'s brief, or type your own.</p>';
  }
  function setProvider(v, user) {
    if (v === 'shared' && !proxyUrl()) v = getKey() ? 'key' : 'local';
    ST.provider = v;
    if (user&&!saveSetting(LS_PROV,v))return;
    renderProv();
  }
  function renderProv() {
    const p = doc.getElementById('cp-panel'); if (!p) return;
    const sh = !!proxyUrl(), key = !!getKey();
    p.querySelectorAll('[data-prov]').forEach(b => {
      b.setAttribute('aria-checked', String(b.dataset.prov === ST.provider));
      if (b.dataset.prov === 'shared') { b.disabled = !sh; b.title = sh ? 'Answers through the site\'s shared relay; no key needed.' : 'Not set up on this site yet.'; }
    });
    const note = p.querySelector('.cp-provnote'), kf = p.querySelector('.cp-key'), inp = p.querySelector('.cp-in');
    kf.hidden = ST.provider !== 'key';
    kf.querySelector('input').placeholder = key ? 'Key saved. Paste to replace.' : 'sk-ant-...';
    kf.querySelector('.cp-forget').hidden = !key;
    if (ST.provider === 'shared') { note.textContent = 'Questions go to the shared assistant for this site. No key is stored in your browser.'; inp.hidden = false; }
    else if (ST.provider === 'key') { note.textContent = key ? 'Using your saved key.' : 'Paste your Anthropic API key to ask free-form questions.'; inp.hidden = !key; }
    else { note.textContent = 'Dashboard answer first. Typed questions and chips use dashboard data. No model is needed.'; }
    inp.hidden = false;
    if(ST.provider==='shared')note.textContent='Dashboard answer first. Optional rephrasing sends selected public facts to free providers. Google may review them.';
    if(ST.provider==='key')note.textContent=p.querySelector('.cp-model').value?'Dashboard answer first. Your selected model uses your saved key and provider pricing.':'Select a model to opt in to your provider pricing. Dashboard answers work without a model.';
  }
  function turn(q) {
    const log = doc.querySelector('#cp-panel .cp-log');
    const h = log.querySelector('.cp-hello'); if (h) h.remove();
    const t = doc.createElement('div'); t.className = 'cp-turn';
    t.innerHTML = `<div class="cp-q">${esc(q)}</div><div class="cp-a"><span class="cp-dim">Working</span></div>`;
    log.appendChild(t); scrollLog();
    return t.querySelector('.cp-a');
  }
  function watch() { try { return new Set(root.SmartOptionsWatchlist ? root.SmartOptionsWatchlist.get() : []); } catch (e) { return new Set(); } }
  function preset(id, q) {
    const a = turn(q);
    const B = root.SmartOptionsBrief;
    a.innerHTML = answerHTML(answerPreset(id, B ? B.data() : null, watch()));
    const log = doc.querySelector('#cp-panel .cp-log'); log.scrollTop = log.scrollHeight;
  }
  function packHTML(r) {
    const I=root.SmartOptionsIntents;
    return (r.na ? `<p class="cp-na">${esc(r.na)}</p>` : `<ul class="cp-lines">${r.lines.map(l=>`<li>${esc(l.text)} ${l.refs.map(id=>`<sup class="cp-ref">[${esc(id)}]</sup>`).join('')}</li>`).join('')}</ul>`) +
      (r.facts.length ? `<details class="cp-src"><summary>Sources (${r.facts.length})</summary><ol>${r.facts.map(f=>`<li id="cp-${esc(f.id)}">[${esc(f.id)}] ${esc(f.text)}: ${esc(f.display)}. ${esc(f.period)}. ${esc(f.asof)}. ${f.url ? `<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.source)}</a>`:esc(f.source)}</li>`).join('')}</ol></details>`:'') +
      `<p class="cp-foot">From the dashboard data.</p><div class="cp-follow">${r.followups.slice(0,3).map(f=>`<button type="button" data-intent="${esc(f.intent)}" data-entities="${esc(JSON.stringify(f.entities))}">${esc(I.chipText(f.intent,{T:f.entities.tickers?.[0]}))}</button>`).join('')}</div>`;
  }
  async function submit(question, direct) {
    const p=doc.getElementById('cp-panel'),ta=p.querySelector('.cp-in textarea');
    const q=typeof question==='string'?question:ta.value.trim(); if(!q||ST.busy)return;
    const typed=typeof question!=='string';if(typed){ta.value='';saveDraft('');} ta.style.height=''; const a=turn(q), controller=new AbortController();
    ST.controller=controller;ST.busy=true;p.classList.add('busy');p.querySelector('.cp-cancel').hidden=false;
    const timeout=setTimeout(()=>controller.abort(),20000);
    const cfg=()=>({url:ST.provider==='shared'?proxyUrl():'',apiKey:ST.provider==='key'&&p.querySelector('.cp-model').value?getKey():'',model:p.querySelector('.cp-model').value,universe:new Set(root.SmartOptionsUniverse.rows.map(r=>r[0]))});
    try {
      const {result:r}=await root.SmartOptionsBriefChat.answer(q,direct,controller.signal,{...cfg(),signal:controller.signal});
      a.innerHTML=packHTML(r);
      if(r.intent==='dashboard'){const l=doc.createElement('p');l.className='cp-foot';l.innerHTML=r.receipt?.status==='OK'?'<a href="'+(root.SmartOptionsMain?'#/room':'#/my-dash')+'">Open saved rooms</a> · Saved only in this browser.':'Nothing was changed.';a.appendChild(l);}
      if(r.facts.length&&!r.action&&!r.na&&!r.noPolish){
        const simple=doc.createElement('button');simple.type='button';simple.className='cp-simple';simple.textContent='Say it more simply';a.appendChild(simple);
        const polish=async(signal)=>{
          simple.disabled=true;
          try{const out=await root.SmartOptionsPolish.rewrite(r,cfg(),signal);
            if(signal.aborted)return;
            let text=a.querySelector('.cp-polish');if(!text){text=doc.createElement('p');text.className='cp-polish';a.appendChild(text);}
            text.textContent=out.ok?out.text:out.reason;
            if(!out.ok)root.SmartOptionsBriefChat.record('WARN','rewrite','Verifier retained template');
          }finally{simple.disabled=false;}
        };
        simple.addEventListener('click',async()=>{
          const c=new AbortController(),t=setTimeout(()=>c.abort(),12000);ST.controller=c;
          try{await polish(c.signal);}catch(e){const n=doc.createElement('p');n.className='cp-foot';n.textContent=e.name==='AbortError'?'Rephrasing cancelled. Dashboard answer retained.':e.message+' Dashboard answer retained.';a.appendChild(n);root.SmartOptionsBriefChat.record('WARN','rewrite',e.name==='AbortError'?'Cancelled':e.message);}finally{clearTimeout(t);if(ST.controller===c)ST.controller=null;}
        });
        if(cfg().url||cfg().apiKey)try{await polish(controller.signal);}catch(e){const n=doc.createElement('p');n.className='cp-foot';n.textContent=e.name==='AbortError'?'Rephrasing cancelled. Dashboard answer retained.':e.message+' Dashboard answer retained.';a.appendChild(n);root.SmartOptionsBriefChat.record('WARN','rewrite',e.name==='AbortError'?'Cancelled':e.message);}
      }
    }catch(e){a.innerHTML=`<p class="cp-na cp-err">${esc(e.name==='AbortError'?'Cancelled. No answer was applied.':e.message)}</p>`;if(typed&&e.name==='AbortError'&&!ta.value){ta.value=q;saveDraft(q);}root.SmartOptionsBriefChat.record('FAIL','question',e.name==='AbortError'?'Cancelled':e.message);}
    finally{clearTimeout(timeout);ST.controller=null;ST.busy=false;p.classList.remove('busy');p.querySelector('.cp-cancel').hidden=true;scrollLog();}
  }
  function installContextChips(){
    const sections={'h-pulse':'pulse','h-risks':'risks','h-pos':'breadth','h-short':'shortlist','h-obs':'macro'};
    function add(el,id,entities){if(!el||el.querySelector('.cp-context'))return;const b=doc.createElement('button');b.type='button';b.className='cp-context';b.textContent='Ask about this';b.dataset.intent=id;b.dataset.entities=JSON.stringify(entities||{});el.appendChild(b);}
    const scan=()=>{for(const [id,intent]of Object.entries(sections))add(doc.getElementById(id)?.closest('section'),intent);const t=(root.location.hash.match(/^#\/company\/([^/]+)/)||[])[1];if(t)doc.querySelectorAll('.co-card').forEach(el=>{const card=[...el.classList].find(c=>c.startsWith('co-k-'))?.slice(5);if(card)add(el,'ticker_card',{tickers:[t],card});});};
    doc.addEventListener('click',e=>{const b=e.target.closest('.cp-context');if(b){toggle(true);submit('Ask about this: '+root.SmartOptionsIntents.BY_ID[b.dataset.intent].label,{intent:b.dataset.intent,entities:JSON.parse(b.dataset.entities)});}});
    let pending=false;new MutationObserver(()=>{if(pending)return;pending=true;queueMicrotask(()=>{pending=false;scan();});}).observe(doc.body,{childList:true,subtree:true});scan();
  }
  async function loadModules(){
    for(const [file,key]of [['universe','SmartOptionsUniverse'],['intents','SmartOptionsIntents'],['facts','SmartOptionsFacts'],['verify','SmartOptionsVerify'],['polish','SmartOptionsPolish'],['actions','SmartOptionsActions'],['dashboard','SmartOptionsDashboardSpec'],['relationships','SmartOptionsRelationships'],['runtime','SmartOptionsBriefChat']]){
      if(root[key])continue;await new Promise((resolve,reject)=>{const s=doc.createElement('script');s.src='chat/'+file+'.js?v=client-20261019-cockpit6';s.onload=resolve;s.onerror=()=>reject(new Error('Chat module failed to load: '+file));doc.head.appendChild(s);});
    }
  }
  function _start() {
    // the docked chat panel is replaced by this popup: make the old mount a no-op before the Edge init calls it
    const ch = C();
    if (ch) { ch.mount = function () { return ch; }; }
    const go = () => {
      loadModules().then(() => { build(); installContextChips(); }).catch(e => { const n=doc.createElement('p'); n.className='cp-load-error'; n.setAttribute('role','alert'); n.textContent=e.message; doc.body.appendChild(n); });
      if (ch) { ch.open = () => toggle(true); ch.close = () => toggle(false); ch.draft = text => { toggle(true); const ta = doc.querySelector('#cp-panel .cp-in textarea');  ta.value = String(text || ''); ta.focus(); }; }
      fetch('data/config.json', {cache: 'no-store'}).then(r => r.ok ? r.json() : null).catch(e => { root.SmartOptionsBriefChat?.record('WARN','config','Optional rephrasing configuration unavailable'); return null; }).then(cfg => {
        ST.cfg = cfg || {};
        let saved = ''; try { saved = (store() && store().getItem(LS_PROV)) || ''; } catch (e) { saved = ''; }
        setProvider(saved || (proxyUrl() ? 'shared' : getKey() ? 'key' : 'local'), false);
      });
    };
    if (doc.body) go(); else doc.addEventListener('DOMContentLoaded', go);
  }
  return {PRESETS, MODELS, answerPreset, answerHTML, viewportGeometry, _start, open: () => toggle(true), close: () => toggle(false)};
});

