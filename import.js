/* Expanded import UI; shared parsing and storage live in local-data.js. */
(function(root){
  'use strict';
  const API=typeof module!=='undefined'&&module.exports?require('./local-data.js'):root.SmartOptionsLocalData;
  const {classify,createStore}=API;
  if(typeof module!=='undefined'&&module.exports) module.exports=API;
  if (!root.document) return;
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  let storage;try{storage=root.localStorage;}catch(e){storage={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}};}
  const store = API.sharedStore(storage);
  let lastText = '', sheet, current = null, previewBasis=null, undoStack = [], dragDepth = 0;
  const known = () => (root.SO2 && root.SO2.D().rows || []).map(r => r.t);
  const changed = () => root.dispatchEvent(new CustomEvent('so:import'));
  const ACTIONS = {
    watchlist: ['Add to watchlist', r => r.matched.length > 0],
    book: ['Merge into My book', r => !r.costChoiceRequired && Object.keys(API.confirmedBook(r)).length > 0],
    metrics: ['Add as columns', r => !!r.metrics && Object.keys(r.metrics.rows).length > 0],
    series: ['Add as macro card', r => !!r.series && r.series.some(s => s.points.length > 1)],
  };
  function apply(kind) {
    const r = current; if (!r) return;
    if(kind!=='watchlist'&&JSON.stringify(store.get())!==JSON.stringify(previewBasis)){toast('Local data changed after preview. Reload and preview again before applying.',false);return;}
    const before = {data: store.get(), watch: root.SmartOptionsWatchlist ? root.SmartOptionsWatchlist.get() : null};
    const d = store.get();
    let msg = '';
    try {
      if (kind === 'watchlist') { root.SmartOptionsWatchlist.add(r.matched); msg = `Pinned ${r.matched.length} ticker(s).`; }
      if (kind === 'book') {
        const entries=API.confirmedBook(r), conflicts=Object.keys(entries).filter(t=>d.book?.[t]);
        if(conflicts.length&&!$('#imp-replace')?.checked)throw Error('Choose replacement explicitly for conflicting entries.');
        d.book={...(d.book||{})};for(const [t,b]of Object.entries(entries))d.book[t]={...(d.book[t]||{}),...b};const receipt=store.put(d);if(!receipt.ok)throw Error(store.status().warning);
        msg='Merged positions; saved and verified on this device.';
      }
      if (kind === 'metrics') { d.metrics = r.metrics; if(!store.put(d).ok)throw Error(store.status().warning); msg = `Added ${r.metrics.columns.length} local column(s) to the Overview.`; }
      if (kind === 'series') { d.series = (d.series || []).concat(r.series.filter(s => s.points.length > 1).map(s => ({label: s.label + ' (' + r.filename + ')', points: s.points.slice(-120)}))).slice(-4); if(!store.put(d).ok)throw Error(store.status().warning); msg = 'Added macro card(s) to the Overview.'; }
    } catch (e) { toast('Could not save. '+e.message, false);return; }
    undoStack.push(before);
    changed(); close(); toast(msg, true);
  }
  function undo() {
    const b = undoStack[undoStack.length-1]; if (!b) return;
    if(!store.put(b.data).ok){toast(store.status().warning,false);return;}undoStack.pop();
    if (b.watch && root.SmartOptionsWatchlist) root.SmartOptionsWatchlist.set(b.watch);
    changed(); toast('Undone.', false);
  }
  function clearMine() {
    undoStack.push({data: store.get(), watch: root.SmartOptionsWatchlist ? root.SmartOptionsWatchlist.get() : null});
    if(!store.clear().ok){undoStack.pop();toast(store.status().warning,false);return;}
    if (root.SmartOptionsWatchlist && root.SmartOptionsWatchlist.reset) root.SmartOptionsWatchlist.reset();
    changed(); toast('Cleared your imports and pins in this browser.', true);
  }
  function toast(msg, canUndo) {
    let t = $('#imp-toast');
    if (!t) { t = document.createElement('div'); t.id = 'imp-toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.innerHTML = `<span>${esc(msg)}</span>${canUndo && undoStack.length ? '<button data-imp="undo">Undo</button>' : ''}`;
    t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 9000);
  }
  function preview(r) {
    current = r;
    previewBasis=store.get();
    const sample = r.kind === 'book' ? Object.entries(r.book).slice(0, 6).map(([t, b]) => [t, b.qty, b.cost])
      : r.kind === 'metrics' ? Object.entries(r.metrics.rows).slice(0, 6).map(([t, o]) => [t, ...r.metrics.columns.slice(0, 4).map(c => o[c])])
      : r.kind === 'series' ? r.series[0].points.slice(-6).map(p => [p[0], p[1]])
      : r.matched.slice(0, 12).map(t => [t]);
    const head = r.kind === 'book' ? ['Ticker', 'Qty', 'Cost'] : r.kind === 'metrics' ? ['Ticker', ...r.metrics.columns.slice(0, 4)] : r.kind === 'series' ? ['Date', r.series[0].label] : ['Ticker'];
    const btns = Object.entries(ACTIONS).filter(([, a]) => a[1](r)).sort(([a], [b]) => (b === r.kind) - (a === r.kind))
      .map(([k, a]) => `<button data-imp="apply" data-kind="${k}" class="${k === r.kind ? 'imp-primary' : ''}">${a[0]}</button>`).join('');
    $('#imp-body').innerHTML = `<div class="imp-file">${esc(r.filename)}</div><p class="imp-summary">${esc(r.summary)}</p><p class="imp-reason">${esc(r.reason)}</p>`
      + (sample.length ? `<table class="imp-prev"><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${sample.map(row => `<tr>${row.map(c => `<td>${esc(c == null ? '—' : c)}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '')
      + (r.kind === 'book' ? `<p class="imp-note">Long USD equity quantities only. ${r.partial?'Partial selection: exclusions below.':''} ${r.duplicateLots||0} duplicate lots consolidated.</p><ul>${(r.accounting||[]).map(x=>`<li>Row ${x.row}: ${esc(x.t)} — ${esc(x.status)}</li>`).join('')}</ul>
        ${r.costChoiceRequired?'<label>Cost meaning<select id="imp-cost-mode"><option value="">Choose</option><option value="perShare">Per-share cost</option><option value="total">Total cost</option><option value="ignore">Ignore cost</option></select></label>':''}
        ${Object.keys(r.book||{}).some(t=>store.get().book?.[t])?`<label><input type="checkbox" id="imp-replace"> Replace conflicts: ${Object.keys(r.book||{}).filter(t=>store.get().book?.[t]).map(t=>esc(t)+' old '+esc(store.get().book[t].qty)+' shares / cost '+esc(store.get().book[t].cost)+' → new '+esc(r.book[t].qty)+' / '+esc(r.book[t].cost)).join('; ')}</label>`:''}
        <p class="imp-note">${esc(store.status().warning||'My book stays in this browser. No data is uploaded.')}</p>` : '')
      + `<div class="imp-actions">${btns || '<span class="imp-reason">Nothing here I can place. Try a CSV with a Symbol or Date column, or paste tickers.</span>'}<button data-imp="back">Back</button></div>`;
  }
  async function readFiles(files) {
    const f = files && files[0]; if (!f) return;
    if (f.size > 5e6) { open(); $('#imp-body').innerHTML = `<p class="imp-summary">${esc(f.name)} is ${(f.size / 1e6).toFixed(1)} MB; the limit is 5 MB.</p>`; return; }
    let text;try{text=await f.text();lastText=text;}catch(e){toast('File could not be read; nothing saved.',false);return;}
    open(); preview(classify(text, f.name, known()));
  }
  function form() {
    const d = store.get(), w = root.SmartOptionsWatchlist ? root.SmartOptionsWatchlist.get().length : 0;
    const mine = [d.book && `My book: ${Object.keys(d.book).length} positions`, d.metrics && `${d.metrics.columns.length} local columns`, d.series && d.series.length && `${d.series.length} local series`].filter(Boolean).join(' · ');
    $('#imp-body').innerHTML = `<label class="imp-drop" for="imp-file"><b>Drop a file anywhere</b><span>CSV, TSV, TXT or JSON. Broker exports, ticker lists, metric tables, FRED date/value files.</span><input id="imp-file" type="file" accept=".csv,.tsv,.txt,.json,text/*,application/json"></label>`
      + `<textarea id="imp-text" rows="5" placeholder="…or paste text: AAPL MSFT NVDA, a table, or JSON" spellcheck="false"></textarea>`
      + `<div class="imp-actions"><button data-imp="read" class="imp-primary">Read pasted text</button><button data-imp="clear" title="Remove imports and watchlist pins from this browser">Clear my data</button></div>`
      + `<p class="imp-note">Read in this browser only; nothing is uploaded. Watchlist: ${w} symbols${mine ? ' · ' + esc(mine) : ''}.</p>`;
    $('#imp-file').addEventListener('change', e => readFiles(e.target.files));
  }
  function open() { if (sheet.hidden) { sheet.hidden = false; form(); } }
  function close() { sheet.hidden = true; current = null; }
  function mount() {
    sheet = document.createElement('div'); sheet.id = 'imp-sheet'; sheet.hidden = true;
    sheet.innerHTML = '<div class="imp-card" role="dialog" aria-label="Add data"><div class="imp-hd"><b>Add data</b><span>stays in this browser</span><button data-imp="close" aria-label="Close">×</button></div><div id="imp-body"></div></div>';
    document.body.appendChild(sheet);
    const zone = document.createElement('div'); zone.id = 'imp-zone'; zone.hidden = true; zone.innerHTML = '<div>Drop to read. Nothing leaves this browser.</div>';
    document.body.appendChild(zone);
    document.addEventListener('click', e => {
      const b = e.target.closest('[data-imp]'); if (!b) return;
      const a = b.dataset.imp;
      if (a === 'close') close();
      else if (a === 'back') form();
      else if (a === 'apply') apply(b.dataset.kind);
      else if (a === 'undo') undo();
      else if (a === 'clear') clearMine();
      else if (a === 'read') { const t = lastText = $('#imp-text').value; preview(classify(t, 'pasted text', known())); }
    });
    sheet.addEventListener('change',e=>{if(e.target.id==='imp-cost-mode'&&e.target.value)preview(classify(lastText,'local import',known(),{costMode:e.target.value}));});
    sheet.addEventListener('click', e => { if (e.target === sheet) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !sheet.hidden) close(); });
    const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    document.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; zone.hidden = false; });
    document.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
    document.addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; zone.hidden = true; } });
    document.addEventListener('drop', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; zone.hidden = true; readFiles(e.dataTransfer.files); });
    // Pasting text with the Overview open (and no input focused) goes straight to the importer.
    document.addEventListener('paste', e => {
      if (e.target.closest && e.target.closest('input,textarea,[contenteditable]')) return;
      if (!document.body.classList.contains('so-overview')) return;
      const t = e.clipboardData && e.clipboardData.getData('text'); if (!t || !t.trim()) return;
      sheet.hidden = false; lastText=t;preview(classify(t, 'pasted text', known()));
    });
  }
  root.SmartOptionsImport = {classify: (text, filename) => classify(text, filename, known()), getData: () => {store.reload();return store.get();}, putData: v => store.put(v), status:()=>store.status(), open: () => { mount.done || (mount(), mount.done = true); open(); }, undo, clear: clearMine};
  const go = () => { if (!mount.done) { mount(); mount.done = true; } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
})(typeof window !== 'undefined' ? window : globalThis);
