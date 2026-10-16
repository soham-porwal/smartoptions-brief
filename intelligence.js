/* Dated, deterministic relationship observations. This renderer never fits or forecasts. */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SmartOptionsIntelligence = api;
  // app.js creates SO2 later; attach without replacing the existing application namespace.
  function attach() { if (root.SO2) root.SO2.Intelligence = api; }
  attach();
  if (root.document) root.document.addEventListener('so2:ready', attach);
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';
  const SCHEMA = 'smartoptions.intelligence.v1';
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num = v => typeof v === 'number' && Number.isFinite(v);
  const list = v => Array.isArray(v) ? v.filter(x => x && typeof x === 'object') : [];
  const text = (v, fallback) => typeof v === 'string' && v.trim() ? v : fallback || '';
  const safeURL = v => /^https:\/\/[^\s"'<>]+$/i.test(String(v || '')) ? String(v) : null;
  const KINDS = {observed:'Observed', association:'Historical association', scenario:'Conditional scenario'};
  const DIRECTIONS = {supportive:'Supportive', adverse:'Adverse', mixed:'Mixed', unknown:'Direction unavailable'};
  const state = {data:null, error:'', pending:null, quotes:null,receipt:null,receiptError:''};
  function validData(d) { return !!(d && d.schema === SCHEMA && d.market && typeof d.market === 'object' && d.companies && typeof d.companies === 'object' && !Array.isArray(d.companies)); }
  function value(v, unit) {
    if (!num(v)) return 'Not available';
    const n = v.toLocaleString('en-US', {maximumFractionDigits:2});
    return n + (unit === '%' || unit === 'pct' ? '%' : unit ? ' ' + unit : '');
  }
  function basisHTML(d) {
    const b = d && d.basis || {};
    const stamp = v => typeof v==='string' && /T/.test(v) && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString().slice(0,16).replace('T',' ')+' UTC' : v;
    return `<p class="in-basis">Snapshot ${esc(b.snapshot_date || 'date unavailable')} · Model ${esc(b.model_asof || 'date unavailable')} · Quotes ${esc(stamp(b.quote_date) || 'date unavailable')}</p>`;
  }
  function statusHTML(d, error) {
    const s = d && d.status || {}, reasons = Array.isArray(s.reasons) ? s.reasons.filter(x => typeof x === 'string') : [];
    if (error) reasons.unshift(error);
    if(state.receipt && state.receipt.status!=='ok') reasons.unshift('Latest refresh '+state.receipt.status+' at '+(state.receipt.attempted_at||'time unavailable')+'. '+(state.receipt.previous_snapshot_preserved?'Previous snapshot preserved. ':'')+(Array.isArray(state.receipt.reasons)?state.receipt.reasons.join(' '):''));
    if(state.receiptError) reasons.push('Latest refresh receipt unavailable. '+state.receiptError);
    return s.state === 'degraded' || reasons.length ? `<p class="in-status" role="status">${esc(state.data && error ? 'Showing the last good relationship snapshot. ' : '')}${esc(reasons.join(' ') || 'Some relationship inputs are unavailable.')}</p>` : '';
  }
  function evidenceHTML(items) {
    const xs = list(items);
    if (!xs.length) return '<p class="in-na">Not available: no measured inputs were attached.</p>';
    return `<dl class="in-evidence">${xs.map(e => {
      const url = safeURL(e.source_url);
      return `<div><dt>${esc(e.label || 'Measure')}</dt><dd><b>${esc(value(e.value, text(e.unit)))}</b><span>${esc(e.date || 'Observation date unavailable')}</span>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">Source</a>` : '<span>Source unavailable</span>'}${e.reason ? `<span class="in-na">${esc(e.reason)}</span>` : ''}${e.formula ? `<span class="in-formula">Basis: ${esc(e.formula)}</span>` : ''}</dd></div>`;
    }).join('')}</dl>`;
  }
  function sourceHTML(ids, sources) {
    const xs = Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : [];
    const get = id => Array.isArray(sources) ? sources.find(s => s && s.id === id) : sources && sources[id];
    return xs.length ? `<p class="in-sources">Sources: ${xs.map(id => { const s = get(id) || {}, url = safeURL(s.url || s.source_url); return url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(s.label || id)}</a>` : esc(s.label || id); }).join(' · ')}</p>` : '';
  }
  function observationHTML(o, sources) {
    o = o || {};
    const kind = KINDS[o.kind] ? o.kind : 'unknown', dir = DIRECTIONS[o.direction] ? o.direction : 'unknown';
    const ticker = /^[A-Z0-9][A-Z0-9.^-]{0,14}$/.test(o.ticker || '') ? o.ticker : '';
    const counter = typeof o.counterargument === 'string' ? o.counterargument : o.counterargument && (o.counterargument.summary || o.counterargument.text);
    return `<details class="in-observation"><summary class="in-observation-summary"><span class="in-labels"><span class="in-kind">${KINDS[kind] || 'Basis unavailable'}</span><span class="in-direction in-${dir}">${DIRECTIONS[dir]}</span>${ticker ? `<a class="in-ticker" href="#/company/${esc(ticker)}">${esc(ticker)}</a>` : ''}</span><h3>${esc(o.title || 'Relationship observation')}</h3><p class="in-summary">${esc(o.summary || 'Not available: no relationship summary was provided.')}</p><span class="in-expand-label">Evidence and alternative view <span aria-hidden="true">+</span></span></summary><div class="in-observation-body"><p class="in-counter"><b>What could challenge it</b> ${esc(counter || 'Not available: no counterargument was provided.')}</p>${o.research_question ? `<p class="in-next"><b>Research next</b> ${esc(o.research_question)}</p>` : ''}${kind==='scenario'?'<p class="in-na">Snapshot scenario. Quote refreshes do not update its factor inputs.</p>':''}<h4 class="in-input-title">Measured inputs</h4>${evidenceHTML(o.evidence)}${sourceHTML(o.source_ids, sources)}</div></details>`;
  }
  function validationHTML(v) {
    v = v || {};
    const h = v.holdout || {};
    return `<details class="in-methods"><summary>Model checks and limits</summary><p>${esc(v.summary || 'Historical associations describe the fitted sample. Forecast validation is unavailable.')}</p><dl class="in-meta"><div><dt>Target</dt><dd>${esc(v.target || 'Not available')}</dd></div><div><dt>Benchmark</dt><dd>${esc(v.benchmark || 'Not available')}</dd></div><div><dt>Holdout</dt><dd>${esc([h.method,h.start,h.end].filter(Boolean).join(' · ') || 'Not available')}</dd></div></dl><p class="in-na">An association is a historical fit. A scenario is conditional. Neither establishes a forecast.</p></details>`;
  }
  function missingHTML(label, error) { return `<section class="in-panel b-card"><h2>${esc(label)}</h2><p class="in-na" role="status">Not available: ${esc(error || 'the relationship snapshot has not been built yet.')}</p><p class="in-na">Dated market observations and company fundamentals remain available below.</p></section>`; }
  function marketHTML(d, error) {
    if (!validData(d)) return missingHTML('Market relationships', error);
    const m = d.market, drivers = list(m.drivers), opportunities = list(d.opportunities);
    return `<section class="in-panel b-card" aria-labelledby="in-market-title"><div class="in-heading"><h2 id="in-market-title">Market relationships</h2><span class="in-kind">Dated observations</span></div><p class="in-headline">${esc(m.headline || 'Relationship summary unavailable')}</p><p class="in-summary">${esc(m.summary || '')}</p>${basisHTML(d)}${statusHTML(d,error)}<div class="in-grid">${drivers.length ? drivers.map(o => observationHTML(o,d.sources)).join('') : '<p class="in-na">Not available: no market drivers in this snapshot.</p>'}</div>${opportunities.length ? `<div class="in-heading in-subheading"><h2>Company connections</h2></div><div class="in-grid">${opportunities.map(o => observationHTML(o,d.sources)).join('')}</div>` : ''}${validationHTML(d.validation)}</section>`;
  }
  function companyHTML(d, ticker, error) {
    if (!validData(d)) return missingHTML('Company relationships',error);
    const c = d.companies[String(ticker).toUpperCase()];
    if (!c || typeof c !== 'object') return missingHTML('Company relationships', 'no relationship sample for ' + ticker + '.');
    const rs = list(c.relationships), s = c.sensitivity || {}, f = c.fundamentals_basis || {}, v = c.valuation_basis || {};
    return `<section class="in-panel b-card" aria-labelledby="in-company-title"><div class="in-heading"><h2 id="in-company-title">Company relationships</h2><span class="in-kind">Historical fit</span></div><p class="in-headline">${esc(c.headline || 'Relationship summary unavailable')}</p>${statusHTML(d,error)}<dl class="in-returns">${[['Observed return',c.observed_return_pct],['Model explained',c.explained_return_pct],['Unexplained',c.residual_return_pct]].map(([k,n]) => `<div><dt>${k}</dt><dd>${esc(value(n,'%'))}</dd></div>`).join('')}</dl><p class="in-basis">Return session ${esc(c.return_asof || 'unavailable')} · Fitted through ${esc(c.model_asof || 'unavailable')} · ${num(c.sample_n) ? esc(c.sample_n) : 'Unknown'} observations · R² ${num(c.model_r2) ? esc(value(c.model_r2,'')) : 'unavailable'}</p><p class="in-na">Attribution uses fitted coefficients; unexplained return is not a trading signal.</p><div class="in-grid">${rs.length ? rs.map(o => observationHTML(o,d.sources)).join('') : '<p class="in-na">Not available: no measured relationships for this company.</p>'}</div><details class="in-methods"><summary>Sensitivity and calculation basis</summary><dl class="in-meta">${Object.entries(s).map(([k,x]) => `<div><dt>${esc(k)}</dt><dd>${esc(value(x && x.coefficient,x && x.unit))}</dd></div>`).join('') || '<div><dt>Factors</dt><dd>Not available</dd></div>'}</dl><p class="in-basis">Fundamentals ${esc(f.asof || 'date unavailable')}${Array.isArray(f.periods) && f.periods.length ? ' · ' + esc(f.periods.join(' · ')) : ''}</p><p class="in-basis">Valuation ${esc(v.asof || 'date unavailable')} · Price basis ${esc(v.quote_asof || 'unavailable')}. ${esc(v.note || '')}</p><p class="in-na">Quotes update separately. Fitted coefficients and reporting periods retain these dates.</p>${c.validation ? `<p class="in-na">Chronological holdout: ${num(c.validation.holdout_n) ? esc(c.validation.holdout_n) + ' observations' : 'not available'}. Model RMSE ${esc(value(c.validation.model_rmse_pct,'%'))}; benchmark RMSE ${esc(value(c.validation.baseline_rmse_pct,'%'))}.</p>` : ''}</details>${c.event_risk ? `<p class="in-event"><b>Event risk</b> ${esc(c.event_risk.summary || 'Not available')}${c.event_risk.date ? ' · ' + esc(c.event_risk.date) : ''}${safeURL(c.event_risk.source_url) ? ` · <a href="${esc(c.event_risk.source_url)}" target="_blank" rel="noopener">Source</a>` : ''}</p>` : ''}</section>`;
  }
  async function load(options) {
    if (state.pending) return state.pending;
    if (state.data && !(options && options.refresh)) return state.data;
    state.pending = (async () => {
      try {
        const response = await root.fetch('data/intelligence.json', {cache:'no-store'});
        if (!response.ok) throw new Error('Relationship snapshot returned HTTP ' + response.status + '.');
        const d = await response.json();
        if (!validData(d)) throw new Error('Relationship snapshot has an unsupported or malformed schema.');
        state.data = d; state.error = ''; await loadReceipt(); return d;
      } catch (e) {
        state.error = e && e.message || 'Relationship snapshot could not be read.';
        if (root.console) root.console.warn('[intelligence] WARN', state.error);
        await loadReceipt();return state.data;
      } finally { state.pending = null; }
    })();
    return state.pending;
  }
  async function loadReceipt() {
    try {
      const response=await root.fetch('data/refresh-status.json',{cache:'no-store'});
      if(response.status===404){state.receipt=null;state.receiptError='Not published with this build yet.';return;}
      if(!response.ok)throw new Error('HTTP '+response.status+'.');
      const d=await response.json();if(!d||d.schema!=='smartoptions.refresh.v1'||!['ok','degraded','failed'].includes(d.status))throw new Error('Refresh receipt has an unsupported schema.');
      state.receipt=d;state.receiptError='';
    }catch(e){state.receiptError=e.message||'Receipt could not be read.';if(root.console)root.console.warn('[intelligence] WARN refresh receipt',state.receiptError);}
  }
  function render(container, html) { if (container) container.innerHTML = html; }
  function contextHTML(t){const L=root.SmartOptionsLive;return `<p class="in-basis" data-in-live="${esc(t)}">${esc(L?.currentContext?L.currentContext(t,state.quotes,state.data?.companies?.[t]?.model_asof||state.data?.basis?.model_asof):'Current observed comparison unavailable.')}</p>`;}
  function renderMarket(container) { render(container, '<p class="in-na" role="status">Loading market relationships.</p>'); return load().then(d => render(container,contextHTML('SPY')+marketHTML(d,state.error))); }
  function renderCompany(container,ticker) { render(container, '<p class="in-na" role="status">Loading company relationships.</p>'); return load().then(d => render(container,contextHTML(ticker)+companyHTML(d,ticker,state.error))); }
  return {SCHEMA,load,company:t => state.data && state.data.companies[String(t).toUpperCase()] || null,renderMarket,renderCompany,onQuotes:q => {state.quotes=q;if(root.document)root.document.querySelectorAll('[data-in-live]').forEach(el=>{const t=el.dataset.inLive;el.textContent=root.SmartOptionsLive?.currentContext(t,q,state.data?.companies?.[t]?.model_asof||state.data?.basis?.model_asof)||'Current comparison unavailable.';});},validData,value,safeURL,evidenceHTML,observationHTML,marketHTML,companyHTML,validationHTML,status:() => ({available:!!state.data,error:state.error})};
});
