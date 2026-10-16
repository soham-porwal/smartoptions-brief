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
        try { when = isFinite(t) ? new Date(t).toLocaleDateString('en-US', {timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric'}) + ': ' : ''; } catch (e) { when = ''; }
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
  const ST = {cfg: null, provider: 'local', conv: null, busy: false, open: false, opener: null};
  function store() { try { return root.localStorage; } catch (e) { return null; } }
  function getKey() { const s = store(); return (s && s.getItem(LS_KEY)) || ''; }
  function proxyUrl() { return ST.cfg && typeof ST.cfg.chat_proxy_url === 'string' && /^https:\/\//.test(ST.cfg.chat_proxy_url) ? ST.cfg.chat_proxy_url : ''; }
  function C() { return root.SmartOptionsChat; }

  function build() {
    const btn = doc.createElement('button');
    btn.type = 'button'; btn.className = 'cp-fab'; btn.id = 'cp-fab';
    btn.setAttribute('aria-label', 'Open chat'); btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-controls', 'cp-panel');
    btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.5.4-1.3.1-1.3-.6V16A2.5 2.5 0 0 1 4 13.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 8.5h8M8 11.5h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    const p = doc.createElement('section');
    p.className = 'cp'; p.id = 'cp-panel'; p.hidden = true;
    p.setAttribute('role', 'dialog'); p.setAttribute('aria-label', 'Chat about this data');
    p.innerHTML = `<div class="cp-hd"><h2>Ask about this data</h2><button type="button" class="cp-x" aria-label="Close chat">&times;</button></div>
      <div class="cp-prov" role="radiogroup" aria-label="Answer with">
        <button type="button" role="radio" data-prov="shared">Shared assistant</button>
        <button type="button" role="radio" data-prov="key">Use my own key</button>
        <button type="button" role="radio" data-prov="local">Quick answers</button>
      </div>
      <div class="cp-provnote"></div>
      <form class="cp-key" hidden onsubmit="return false"><label>Anthropic API key<input type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-..."></label>
        <div class="cp-row"><button type="button" class="cp-save">Save key</button><button type="button" class="cp-forget">Forget key</button></div>
        <p class="cp-small">Kept only in this browser and sent only to api.anthropic.com. Avoid on a shared computer.</p></form>
      <div class="cp-log" aria-live="polite"></div>
      <div class="cp-chips" aria-label="Quick questions">${PRESETS.map(x => `<button type="button" data-preset="${x.id}">${esc(x.q)}</button>`).join('')}</div>
      <form class="cp-in"><textarea rows="1" aria-label="Your question" placeholder="Ask about prices, macro or a company"></textarea><button type="submit" class="cp-send" aria-label="Send">Send</button></form>
      <p class="cp-disc">Research tool, not advice. Answers cite the data on this site.</p>`;
    doc.body.append(btn, p);
    btn.addEventListener('click', () => toggle());
    p.querySelector('.cp-x').addEventListener('click', () => toggle(false));
    p.querySelector('.cp-prov').addEventListener('click', e => { const b = e.target.closest('[data-prov]'); if (b && !b.disabled) setProvider(b.dataset.prov, true); });
    p.querySelector('.cp-chips').addEventListener('click', e => { const b = e.target.closest('[data-preset]'); if (b) preset(b.dataset.preset, b.textContent); });
    p.querySelector('.cp-save').addEventListener('click', () => { const i = p.querySelector('.cp-key input'); const v = i.value.trim(); const s = store(); if (v && s) s.setItem(LS_KEY, v); i.value = ''; renderProv(); });
    p.querySelector('.cp-forget').addEventListener('click', () => { const s = store(); if (s) s.removeItem(LS_KEY); renderProv(); });
    p.querySelector('.cp-in').addEventListener('submit', e => { e.preventDefault(); submit(); });
    const ta = p.querySelector('.cp-in textarea');
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });
    ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(120, ta.scrollHeight) + 'px'; });
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
    if (open) { renderProv(); if (!p.querySelector('.cp-log').children.length) greet(); p.querySelector('.cp-in textarea').focus(); }
    else b.focus();
  }
  function greet() {
    const log = doc.querySelector('#cp-panel .cp-log');
    log.innerHTML = '<p class="cp-hello">Pick a question below for an instant answer from today\'s brief, or type your own.</p>';
  }
  function setProvider(v, user) {
    if (v === 'shared' && !proxyUrl()) v = getKey() ? 'key' : 'local';
    ST.provider = v;
    if (user) { const s = store(); if (s) try { s.setItem(LS_PROV, v); } catch (e) { /* storage blocked */ } }
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
    else { note.textContent = sh ? 'Quick answers come straight from today\'s brief.' : 'The shared assistant is not set up on this site yet. Quick answers below come straight from today\'s brief; add your own key for free-form questions.'; inp.hidden = true; }
  }
  function turn(q) {
    const log = doc.querySelector('#cp-panel .cp-log');
    const h = log.querySelector('.cp-hello'); if (h) h.remove();
    const t = doc.createElement('div'); t.className = 'cp-turn';
    t.innerHTML = `<div class="cp-q">${esc(q)}</div><div class="cp-a"><span class="cp-dim">Working</span></div>`;
    log.appendChild(t); log.scrollTop = log.scrollHeight;
    return t.querySelector('.cp-a');
  }
  function watch() { try { return new Set(root.SmartOptionsWatchlist ? root.SmartOptionsWatchlist.get() : []); } catch (e) { return new Set(); } }
  function preset(id, q) {
    const a = turn(q);
    const B = root.SmartOptionsBrief;
    a.innerHTML = answerHTML(answerPreset(id, B ? B.data() : null, watch()));
    const log = doc.querySelector('#cp-panel .cp-log'); log.scrollTop = log.scrollHeight;
  }
  async function submit() {
    const p = doc.getElementById('cp-panel'), ta = p.querySelector('.cp-in textarea');
    const q = ta.value.trim(); if (!q || ST.busy) return;
    const ch = C();
    if (!ch || typeof ch.ask !== 'function') { turn(q).innerHTML = '<p class="cp-na">Not available: the chat module did not load.</p>'; return; }
    const shared = ST.provider === 'shared' && proxyUrl();
    const key = ST.provider === 'key' ? getKey() : '';
    if (!shared && !key) { turn(q).innerHTML = '<p class="cp-na">Choose the shared assistant or save your own key first. Quick questions work without either.</p>'; return; }
    ta.value = ''; ta.style.height = '';
    const a = turn(q);
    ST.busy = true; p.classList.add('busy');
    if (typeof ch.useProxy === 'function') ch.useProxy(shared ? {url: proxyUrl(), model: ST.cfg.chat_proxy_model} : null);
    try {
      const model = await dataModel();
      if (!ST.conv) ST.conv = ch.newConversation();
      const snap = ST.conv.messages.length;
      try {
        const lsModel = (store() && store().getItem('smartoptions.chat.model')) || (ch.MODELS[0] && ch.MODELS[0].id);
        const r = await ch.ask(q, ST.conv, model, {apiKey: key, model: lsModel}, {});
        const id = 'cp' + Date.now();
        a.innerHTML = ch.renderWarning(r.check) + ch.renderMarkdown(r.text || 'The assistant returned no answer.', id) + ch.renderSources(r.check.refs, ST.conv.registry, id);
      } catch (e) {
        ST.conv.messages.length = snap;
        let msg = String(e && e.message || e);
        if (shared && /Demo connection unavailable|demo relay/i.test(msg)) msg = 'The shared assistant could not be reached. Try again in a minute, or use your own key.';
        a.innerHTML = `<p class="cp-na">${esc(msg)}</p>`;
      }
    } catch (e) {
      a.innerHTML = `<p class="cp-na">Not available: site data could not be loaded (${esc(e && e.message || e)}).</p>`;
    } finally {
      ST.busy = false; p.classList.remove('busy');
      const log = p.querySelector('.cp-log'); log.scrollTop = log.scrollHeight;
    }
  }
  let modelP = null;
  function dataModel() { if (!modelP) modelP = C().loadData({dataBase: 'data/'}).catch(e => { modelP = null; throw e; }); return modelP; }

  function _start() {
    // the docked chat panel is replaced by this popup: make the old mount a no-op before the Edge init calls it
    const ch = C();
    if (ch) { ch.mount = function () { return ch; }; }
    const go = () => {
      build();
      if (ch) { ch.open = () => toggle(true); ch.close = () => toggle(false); ch.draft = text => { toggle(true); const ta = doc.querySelector('#cp-panel .cp-in textarea'); if (!getKey() && !proxyUrl()) setProvider('key', false); ta.value = String(text || ''); ta.focus(); }; }
      fetch('data/config.json', {cache: 'no-store'}).then(r => r.ok ? r.json() : null).catch(() => null).then(cfg => {
        ST.cfg = cfg || {};
        let saved = ''; try { saved = (store() && store().getItem(LS_PROV)) || ''; } catch (e) { saved = ''; }
        setProvider(saved || (proxyUrl() ? 'shared' : getKey() ? 'key' : 'local'), false);
      });
    };
    if (doc.body) go(); else doc.addEventListener('DOMContentLoaded', go);
  }
  return {PRESETS, answerPreset, answerHTML, _start, open: () => toggle(true), close: () => toggle(false)};
});
