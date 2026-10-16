/* R5: drag-and-drop import. Everything is parsed in this browser and stored in localStorage only;
   nothing is sent anywhere, exported, or published. classify() is pure (node-tested in app/test/import.test.js). */
(function (root) {
  'use strict';
  const KEY = 'so_import_v1';
  const TICKER = /^[A-Z][A-Z0-9]{0,5}([.\-][A-Z]{1,2})?$/;
  const BOOK_WORDS = /\b(qty|quantity|shares|share count|position|cost|basis|avg|average|market value|units|lots?)\b/i;
  const TICKER_HEAD = /^(symbol|ticker|tickers|symbols|sym|stock|security|instrument|code)$/i;
  const DATE_HEAD = /^(date|observation_date|period|time|timestamp|day|month)$/i;
  const NOT_TICKERS = new Set(['USD', 'CASH', 'TOTAL', 'N/A', 'NA', 'NONE', 'NULL', 'DATE', 'SYMBOL', 'TICKER', 'PENDING', 'ACCOUNT']);

  function num(raw) {
    if (raw == null) return null;
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    let s = String(raw).trim();
    if (!s || /^(n\/?a|--?|null|none|\.)$/i.test(s)) return null;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    s = s.replace(/[$€£,%\s]/g, '').replace(/^\+/, '');
    if (!/^-?\d*\.?\d+(e-?\d+)?$/i.test(s)) return null;
    const v = Number(s);
    return Number.isFinite(v) ? (neg ? -v : v) : null;
  }
  function isoDate(raw) {
    const s = String(raw == null ? '' : raw).trim();
    let m = s.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?(?:[T ].*)?$/);
    if (m) return `${m[1]}-${m[2]}-${m[3] || '01'}`;
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    return null;
  }
  function splitLine(line, d) {
    if (d !== ',') return line.split(d).map(x => x.trim());
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (c === ',' && !q) { out.push(cur.trim()); cur = ''; }
      else cur += c;
    }
    out.push(cur.trim());
    return out;
  }
  function pickDelimiter(lines) {
    let best = null, bestScore = 0;
    for (const d of ['\t', ',', ';', '|']) {
      const counts = lines.slice(0, 30).map(l => splitLine(l, d).length);
      const multi = counts.filter(c => c > 1);
      if (multi.length < Math.max(1, Math.ceil(lines.slice(0, 30).length * 0.5))) continue;
      const mode = multi.sort((a, b) => multi.filter(x => x === b).length - multi.filter(x => x === a).length)[0];
      const score = multi.filter(c => c === mode).length * mode;
      if (score > bestScore) { best = d; bestScore = score; }
    }
    return best;
  }
  function makeMatcher(known) {
    const set = new Set((known || []).map(t => String(t).toUpperCase()));
    return raw => {
      const t = String(raw == null ? '' : raw).trim().toUpperCase().replace(/\*+$/, '').replace(/^\$/, '');
      if (!TICKER.test(t) || NOT_TICKERS.has(t)) return {t, shaped: false, known: null};
      if (!set.size) return {t, shaped: true, known: null};
      for (const c of [t, t.replace('.', '-'), t.replace('-', '.')]) if (set.has(c)) return {t: c, shaped: true, known: true};
      return {t, shaped: true, known: false};
    };
  }
  // JSON -> {header, rows} table, or {tokens}
  function fromJSON(v) {
    if (Array.isArray(v)) {
      if (v.every(x => typeof x === 'string')) return {tokens: v};
      const objs = v.filter(x => x && typeof x === 'object' && !Array.isArray(x));
      if (objs.length) {
        const header = [...new Set(objs.flatMap(Object.keys))];
        return {header, rows: objs.map(o => header.map(h => o[h] == null ? '' : o[h]))};
      }
      if (v.every(x => Array.isArray(x))) return {header: null, rows: v};
      return null;
    }
    if (v && typeof v === 'object') {
      for (const k of ['observations', 'data', 'rows', 'positions', 'holdings', 'watchlist', 'symbols', 'tickers', 'items']) if (Array.isArray(v[k])) return fromJSON(v[k]);
      const vals = Object.values(v);
      if (vals.length && vals.every(x => typeof x === 'number' || typeof x === 'string')) return {header: ['key', 'value'], rows: Object.entries(v)};
      if (vals.length && vals.every(x => x && typeof x === 'object' && !Array.isArray(x))) {
        const header = ['key', ...new Set(vals.flatMap(Object.keys))];
        return {header, rows: Object.entries(v).map(([k, o]) => header.map((h, i) => i === 0 ? k : (o[h] == null ? '' : o[h])))};
      }
    }
    return null;
  }

  function classify(text, filename, known) {
    const match = makeMatcher(known);
    const res = {kind: 'unknown', rowsRead: 0, matched: [], unknown: [], columns: [], tickerColumn: null, dateColumn: null,
      numericColumns: [], book: null, metrics: null, series: null, summary: '', reason: '', filename: filename || 'pasted text'};
    const raw = String(text == null ? '' : text).replace(/^﻿/, '');
    if (!raw.trim()) { res.reason = 'The input was empty.'; res.summary = 'Nothing to read.'; return res; }
    let table = null, tokens = null;
    const trimmed = raw.trim();
    if (/^[\[{]/.test(trimmed)) {
      try { const j = fromJSON(JSON.parse(trimmed)); if (j) { tokens = j.tokens || null; table = j.rows ? j : null; } }
      catch (e) { res.reason = 'Looked like JSON but did not parse (' + e.name + ').'; }
    }
    if (!table && !tokens) {
      const lines = raw.split(/\r?\n/).filter(l => l.trim());
      const d = pickDelimiter(lines);
      if (d) {
        const grid = lines.map(l => splitLine(l, d));
        const width = Math.max(...grid.map(r => r.length));
        // Broker exports have preamble lines: header = first row (in the first 15) naming a ticker/date column; else row 0.
        let hi = grid.slice(0, 15).findIndex(r => r.some(c => TICKER_HEAD.test(c) || DATE_HEAD.test(c)));
        const firstLooksHeader = grid[0].every(c => num(c) == null && !isoDate(c)) && !grid[0].some(c => match(c).known);
        if (hi < 0) hi = firstLooksHeader ? 0 : -1;
        const header = hi >= 0 ? grid[hi] : null;
        const body = grid.slice(hi + 1).filter(r => r.length >= Math.min(2, width) && r.length >= (header ? Math.ceil(header.length * 0.6) : 1));
        table = {header, rows: body};
      } else {
        tokens = raw.split(/[\s,;|]+/).filter(Boolean);
      }
    }
    if (tokens) {
      res.rowsRead = tokens.length;
      const seen = new Set();
      for (const tok of tokens) {
        const m = match(tok);
        if (!m.shaped) { if (tokens.length <= 400) res.unknown.push(String(tok).slice(0, 20)); continue; }
        if (seen.has(m.t)) continue; seen.add(m.t);
        (m.known === false ? res.unknown : res.matched).push(m.t);
      }
      const shapedShare = res.matched.length / Math.max(1, tokens.length);
      if (res.matched.length && shapedShare >= 0.5) {
        res.kind = 'watchlist';
        res.reason = 'A plain list of symbols.';
      } else res.reason = res.matched.length ? `Only ${res.matched.length} of ${tokens.length} words look like known tickers, so this does not read as a ticker list.` : 'No known tickers in the text.';
      return finish(res);
    }
    if (!table || !table.rows.length) { res.reason = res.reason || 'No rows found.'; return finish(res); }
    const width = Math.max(...table.rows.map(r => r.length), table.header ? table.header.length : 0);
    const header = Array.from({length: width}, (_, i) => String((table.header && table.header[i]) || `col${i + 1}`).trim() || `col${i + 1}`);
    const rows = table.rows;
    res.rowsRead = rows.length; res.columns = header;
    const col = i => rows.map(r => r[i]);
    const blank = x => { const t = String(x == null ? '' : x).trim(); return !t || /^(n\/?a|--?|null|none|\.)$/i.test(t); };
    const share = (i, f) => { const v = col(i).filter(x => !blank(x)); return v.length ? v.filter(f).length / v.length : 0; };
    // ticker column: header name wins, else best known-match share (or ticker-shape share without a universe)
    let tc = -1, tcScore = 0;
    header.forEach((h, i) => {
      const s = share(i, x => { const m = match(x); return known && known.length ? m.known === true : m.shaped; }) + (TICKER_HEAD.test(h) ? 0.5 : 0);
      if (s > tcScore) { tc = i; tcScore = s; }
    });
    if (tcScore < 0.5) tc = -1;
    let dc = -1;
    header.forEach((h, i) => { if (dc < 0 && i !== tc && share(i, x => isoDate(x)) >= 0.8) dc = i; });
    const words = h => h.replace(/[_\-]+/g, ' ');
    const numeric = header.map((h, i) => i).filter(i => i !== tc && i !== dc && share(i, x => num(x) != null) >= 0.8);
    res.numericColumns = numeric.map(i => header[i]);
    if (tc >= 0) {
      res.tickerColumn = header[tc];
      const seen = new Set();
      for (const r of rows) {
        const m = match(r[tc]);
        if (!m.shaped || seen.has(m.t)) continue; seen.add(m.t);
        (m.known === false ? res.unknown : res.matched).push(m.t);
      }
      const bookCols = numeric.filter(i => BOOK_WORDS.test(words(header[i])));
      if (bookCols.length) {
        const qi = bookCols.find(i => /qty|quantity|shares|units|position/i.test(words(header[i])));
        const ci = bookCols.find(i => /cost|basis|avg|average/i.test(words(header[i])));
        res.kind = 'book';
        res.book = {};
        for (const r of rows) {
          const m = match(r[tc]);
          if (!m.shaped || m.known === false) continue;
          const prev = res.book[m.t] || {qty: null, cost: null};
          const q = qi != null ? num(r[qi]) : null;
          res.book[m.t] = {qty: q == null ? prev.qty : (prev.qty || 0) + q, cost: ci != null ? num(r[ci]) : prev.cost};
        }
        res.reason = `Ticker column "${header[tc]}" with position columns (${bookCols.map(i => header[i]).join(', ')}).`;
      } else if (numeric.length) {
        res.kind = 'metrics';
        res.metrics = {columns: numeric.map(i => header[i]), rows: {}};
        for (const r of rows) {
          const m = match(r[tc]);
          if (!m.shaped || m.known === false) continue;
          res.metrics.rows[m.t] = Object.fromEntries(numeric.map(i => [header[i], num(r[i])]));
        }
        res.reason = `Ticker column "${header[tc]}" plus ${numeric.length} numeric column(s).`;
      } else if (res.matched.length) {
        res.kind = 'watchlist';
        res.reason = `Ticker column "${header[tc]}" with no numeric columns.`;
      }
    } else if (dc >= 0 && numeric.length) {
      res.dateColumn = header[dc];
      res.kind = 'series';
      res.series = numeric.slice(0, 4).map(i => ({label: header[i], points: rows.map(r => [isoDate(r[dc]), num(r[i])]).filter(p => p[0] && p[1] != null).sort((a, b) => a[0].localeCompare(b[0]))}));
      res.reason = `Date column "${header[dc]}" with numeric column(s) ${res.numericColumns.slice(0, 4).join(', ')}.`;
    } else {
      res.reason = `Read ${rows.length} rows x ${width} columns but found no ticker column${dc >= 0 ? '' : ' and no date column'}.`;
    }
    return finish(res);
  }
  function finish(res) {
    const kinds = {watchlist: 'a ticker list', book: 'positions / holdings', metrics: 'a custom metric table', series: 'a dated time series', unknown: 'something I could not place'};
    let s = `I read ${res.rowsRead} row${res.rowsRead === 1 ? '' : 's'}.`;
    if (res.matched.length || res.unknown.length) s += ` ${res.matched.length} ticker${res.matched.length === 1 ? '' : 's'} matched` + (res.unknown.length ? `, ${res.unknown.length} unknown: ${res.unknown.slice(0, 8).join(', ')}${res.unknown.length > 8 ? '…' : ''}` : '') + '.';
    if (res.series) s += ` ${res.series.map(x => `${x.label}: ${x.points.length} points`).join('; ')}.`;
    res.summary = s + ` Looks like ${kinds[res.kind]}.`;
    return res;
  }

  /* ---- local store (localStorage only) ---- */
  function createStore(storage) {
    const empty = () => ({book: null, metrics: null, series: []});
    function get() {
      try {
        let raw = storage.getItem(KEY);
        if (raw == null) {
          const legacy = storage.getItem('so_local_imports_v1');
          if (legacy) {
            const old = JSON.parse(legacy);
            if (old && typeof old === 'object' && old.book) { storage.setItem(KEY, legacy); raw = legacy; }
          }
        }
        const v = JSON.parse(raw);
        return v && typeof v === 'object' ? Object.assign(empty(), v) : empty();
      } catch (e) {
        console.warn('[import] WARN local data could not be read; original retained');
        try { storage.setItem('so_import_diagnostic_v1', JSON.stringify({status:'WARN', at:new Date().toISOString(), reason:'Local holdings could not be read; original storage retained.'})); } catch (loggingError) { console.warn('[import] diagnostic storage unavailable'); }
        return {...empty(), storageWarning:'Local holdings could not be read; original data retained.'};
      }
    }
    function put(v) { storage.setItem(KEY, JSON.stringify(v)); }
    return {get, put, clear: () => storage.removeItem(KEY)};
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = {classify, num, isoDate, createStore};
  if (!root.document) return;

  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const store = createStore(localStorage);
  let sheet, current = null, undoStack = [], dragDepth = 0;
  const known = () => (root.SO2 && root.SO2.D().rows || []).map(r => r.t);
  const changed = () => root.dispatchEvent(new CustomEvent('so:import'));
  const ACTIONS = {
    watchlist: ['Add to watchlist', r => r.matched.length > 0],
    book: ['Save as My book', r => !!r.book && Object.keys(r.book).length > 0],
    metrics: ['Add as columns', r => !!r.metrics && Object.keys(r.metrics.rows).length > 0],
    series: ['Add as macro card', r => !!r.series && r.series.some(s => s.points.length > 1)],
  };

  function apply(kind) {
    const r = current; if (!r) return;
    const before = {data: store.get(), watch: root.SmartOptionsWatchlist ? root.SmartOptionsWatchlist.get() : null};
    const d = store.get();
    let msg = '';
    try {
      if (kind === 'watchlist') { root.SmartOptionsWatchlist.add(r.matched); msg = `Pinned ${r.matched.length} ticker(s).`; }
      if (kind === 'book') { d.book = r.book; store.put(d); msg = `Saved My book: ${Object.keys(r.book).length} position(s), this browser only.`; }
      if (kind === 'metrics') { d.metrics = r.metrics; store.put(d); msg = `Added ${r.metrics.columns.length} local column(s) to the Overview.`; }
      if (kind === 'series') { d.series = (d.series || []).concat(r.series.filter(s => s.points.length > 1).map(s => ({label: s.label + ' (' + r.filename + ')', points: s.points.slice(-120)}))).slice(-4); store.put(d); msg = 'Added macro card(s) to the Overview.'; }
    } catch (e) { msg = 'Could not save (browser storage full or blocked: ' + e.name + ').'; console.warn('[R5 import]', msg); }
    undoStack.push(before);
    changed(); close(); toast(msg, true);
  }
  function undo() {
    const b = undoStack.pop(); if (!b) return;
    store.put(b.data); if (b.watch && root.SmartOptionsWatchlist) root.SmartOptionsWatchlist.set(b.watch);
    changed(); toast('Undone.', false);
  }
  function clearMine() {
    undoStack.push({data: store.get(), watch: root.SmartOptionsWatchlist ? root.SmartOptionsWatchlist.get() : null});
    store.clear();
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
    const sample = r.kind === 'book' ? Object.entries(r.book).slice(0, 6).map(([t, b]) => [t, b.qty, b.cost])
      : r.kind === 'metrics' ? Object.entries(r.metrics.rows).slice(0, 6).map(([t, o]) => [t, ...r.metrics.columns.slice(0, 4).map(c => o[c])])
      : r.kind === 'series' ? r.series[0].points.slice(-6).map(p => [p[0], p[1]])
      : r.matched.slice(0, 12).map(t => [t]);
    const head = r.kind === 'book' ? ['Ticker', 'Qty', 'Cost'] : r.kind === 'metrics' ? ['Ticker', ...r.metrics.columns.slice(0, 4)] : r.kind === 'series' ? ['Date', r.series[0].label] : ['Ticker'];
    const btns = Object.entries(ACTIONS).filter(([, a]) => a[1](r)).sort(([a], [b]) => (b === r.kind) - (a === r.kind))
      .map(([k, a]) => `<button data-imp="apply" data-kind="${k}" class="${k === r.kind ? 'imp-primary' : ''}">${a[0]}</button>`).join('');
    $('#imp-body').innerHTML = `<div class="imp-file">${esc(r.filename)}</div><p class="imp-summary">${esc(r.summary)}</p><p class="imp-reason">${esc(r.reason)}</p>`
      + (sample.length ? `<table class="imp-prev"><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${sample.map(row => `<tr>${row.map(c => `<td>${esc(c == null ? '—' : c)}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '')
      + (r.kind === 'book' ? '<p class="imp-note">My book stays in this browser. It is never published, exported or sent.</p>' : '')
      + `<div class="imp-actions">${btns || '<span class="imp-reason">Nothing here I can place. Try a CSV with a Symbol or Date column, or paste tickers.</span>'}<button data-imp="back">Back</button></div>`;
  }
  async function readFiles(files) {
    const f = files && files[0]; if (!f) return;
    if (f.size > 5e6) { open(); $('#imp-body').innerHTML = `<p class="imp-summary">${esc(f.name)} is ${(f.size / 1e6).toFixed(1)} MB; the limit is 5 MB.</p>`; return; }
    const text = await f.text();
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
      else if (a === 'read') { const t = $('#imp-text').value; preview(classify(t, 'pasted text', known())); }
    });
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
      sheet.hidden = false; preview(classify(t, 'pasted text', known()));
    });
  }
  root.SmartOptionsImport = {classify: (text, filename) => classify(text, filename, known()), getData: () => store.get(), open: () => { mount.done || (mount(), mount.done = true); open(); }, undo, clear: clearMine};
  const go = () => { if (!mount.done) { mount(); mount.done = true; } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
})(typeof window !== 'undefined' ? window : globalThis);
