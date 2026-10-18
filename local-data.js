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
    s = s.replace(/^\$/, '').replace(/%$/, '').replace(/^\+/, '');
    if (/\s/.test(s)) return null;
    if (s.includes(',')) { if (!/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return null; s=s.replace(/,/g,''); }
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
        return {header, rows: v.map(o => o && typeof o==='object' && !Array.isArray(o) ? header.map(h => o[h] == null ? '' : o[h]) : [])};
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
  function classify(text, filename, known, options) {
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
        const body = grid.slice(hi + 1);
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
      const bookCols = header.map((h,i)=>i).filter(i=>i!==tc && BOOK_WORDS.test(words(header[i])));
      if (bookCols.length) {
        const qi = bookCols.find(i => /^(qty|quantity|shares|share count|units|position)$/i.test(words(header[i])));
        const ci = bookCols.find(i => /avg|average|per share/i.test(words(header[i]))) ?? bookCols.find(i => /cost|basis/i.test(words(header[i])));
        const inferred = ci == null ? 'ignore' : (/avg|average|per share/i.test(words(header[ci])) && /total/i.test(words(header[ci]))) ? null : /avg|average|per share/i.test(words(header[ci])) ? 'perShare' : /total/i.test(words(header[ci])) ? 'total' : null;
        const mode = options?.costMode || inferred;
        res.kind='book'; res.book={}; res.costChoiceRequired=ci!=null && !inferred && !options?.costMode;
        res.quantityColumn=qi==null?null:header[qi]; res.costMode=mode; res.accounting=[];
        const lots={};
        rows.forEach((r,i)=>{
          const m=match(r[tc]), q=qi==null||/[$€£¥%]/.test(String(r[qi]))?null:num(r[qi]), c=ci==null||/%/.test(String(r[ci]))?null:num(r[ci]);
          const currency=r.some(v=>/[€£¥]|\b(EUR|GBP|JPY|CAD|AUD|CHF)\b/.test(String(v))) || header.some((h,j)=>/currency/i.test(h) && r[j] && !/^(USD|US\$|\$)$/i.test(String(r[j]).trim()));
          const status=!m.shaped?'invalid row':m.known===false?'unsupported name':currency?'unsupported currency':q==null?'missing quantity':q<0?'unsupported negative quantity':'accepted';
          res.accounting.push({row:i+1,t:m.t,status});
          if(!m.shaped || m.known===false) return;
          (lots[m.t] ||= []).push({q:status==='accepted'?q:null,c:currency||c==null||c<0?null:c});
        });
        Object.entries(lots).forEach(([t,ls])=>{
          const qty=ls.every(l=>l.q!=null)?ls.reduce((n,l)=>n+l.q,0):null;
          const total=qty>0 && mode && mode!=='ignore' && ls.every(l=>l.c!=null && l.q>0) ? ls.reduce((n,l)=>n+(mode==='total'?l.c:l.q*l.c),0):null;
          res.book[t]={qty,cost:total==null?null:total/qty};
        });
        res.duplicateLots=rows.length-Object.keys(lots).length-res.accounting.filter(x=>x.status==='invalid row'||x.status==='unsupported name').length;
        res.partial=res.accounting.some(x=>x.status!=='accepted');
        res.reason=qi==null?'No confirmed share quantity column. Save names only, or supply quantities.':res.costChoiceRequired?'Choose whether Cost Basis is per share, total cost, or ignored.':'Long USD equity quantities; costs use the stated units. Duplicate lots are consolidated.';
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
  // Reads never migrate. Compare raw bytes before writes; a stale tab must reload explicitly.
  function createStore(storage, key = KEY, defaults = () => ({book:null,metrics:null,series:[]})) {
    let baseline, memory=null, warning='', blocked=false, source=key;
    const clone=v=>JSON.parse(JSON.stringify(v));
    function diagnostic(code) {
      warning=code;
      try { storage.setItem('so_local_diagnostic_v1',JSON.stringify({status:'WARN',code,at:new Date().toISOString()})); }
      catch(e) { /* the persistent on-page warning is the available diagnostic */ }
    }
    function read() {
      try {
        baseline=storage.getItem(key); source=key;
        let raw=baseline;
        if(raw==null && key===KEY) {raw=storage.getItem('so_local_imports_v1');if(raw!=null)source='so_local_imports_v1';}
        if(raw==null) {blocked=false;return defaults();}
        const v=JSON.parse(raw);
        if(!v || typeof v!=='object' || Array.isArray(v) || (v.version!=null && v.version!==1) ||
          (key!==KEY && (v.version!==1 || !v.notes || typeof v.notes!=='object' || Array.isArray(v.notes) || !v.checkpoints || typeof v.checkpoints!=='object' || Array.isArray(v.checkpoints))) ||
          (key===KEY && v.book!=null && (typeof v.book!=='object'||Array.isArray(v.book)))) throw Error('schema');
        blocked=false;return Object.assign(defaults(),v);
      } catch(e) { blocked=true;warning='Unreadable or unavailable local storage. Original bytes retained; changes last in this tab only.';return defaults(); }
    }
    let data=read();
    function get() {return clone(memory||data);}
    function put(v) {
      if(blocked) {memory=clone(v);diagnostic('Storage is read-only; changes last in this tab only.');return {ok:false,code:'read-only'};}
      try {
        if(storage.getItem(key)!==baseline || (source!==key && storage.getItem(source)!==legacyRaw)) {memory=clone(v);diagnostic('Another tab changed local data. Your attempted changes remain unsaved in this tab. Discard and reload the latest before saving.');return {ok:false,code:'conflict'};}
        const raw=JSON.stringify(v); storage.setItem(key,raw);
        if(storage.getItem(key)!==raw) throw Error('readback');
        baseline=raw;source=key;data=clone(v);memory=null;warning='';return {ok:true};
      } catch(e) {memory=clone(v);diagnostic('Device save failed or storage is full. Changes last in this tab only.');return {ok:false,code:'write-failed'};}
    }
    let legacyRaw=null;
    try {if(source!==key)legacyRaw=storage.getItem(source);}catch(e){/* read warning already visible */}
    return {get,put,status:()=>({blocked,warning,source}),reload({discard=false}={}){if(!discard&&(memory||warning))return get();const lastGood=memory||data;memory=null;warning='';const latest=read();data=blocked?lastGood:latest;try{legacyRaw=source!==key?storage.getItem(source):null;}catch(e){diagnostic('Storage unavailable.');}return get();},
      // Existing expanded-edition explicit Clear control only; never called by a read/render.
      clear(){try{storage.removeItem(key);if(storage.getItem(key)!=null)throw Error('readback');baseline=null;data=defaults();memory=null;warning='';blocked=false;source=key;return {ok:true};}catch(e){diagnostic('Could not clear local data; original state retained.');return {ok:false};}}};
  }
  function confirmedBook(result) {
    return Object.fromEntries(Object.entries(result.book||{}).filter(([,b])=>Number.isFinite(b.qty)&&b.qty>=0).map(([t,b])=>[t,{...b,currency:'USD',costMeaning:b.cost==null?null:'perShare',provenance:'confirmed import'}]));
  }
  const shared=new WeakMap();
  function sharedStore(storage,key=KEY,defaults){let entries=shared.get(storage);if(!entries){entries=new Map();shared.set(storage,entries);}if(!entries.has(key))entries.set(key,createStore(storage,key,defaults));return entries.get(key);}
  const API={classify,num,isoDate,createStore,sharedStore,confirmedBook};
  if(typeof module!=='undefined'&&module.exports)module.exports=API;
  root.SmartOptionsLocalData=API;
})(typeof window!=='undefined'?window:globalThis);
