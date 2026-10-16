/* Historical shock associations; coefficients never change on an intraday quote tick. */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SmartOptionsShocks = api;
  function attach() { if (root.SO2) root.SO2.Shocks = api; }
  attach();
  if (root.document) root.document.addEventListener('so2:ready', attach);
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';
  const state = {data:null, error:'', pending:null};
  const finite = v => typeof v === 'number' && Number.isFinite(v);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const list = v => Array.isArray(v) ? v : [];
  const pct = v => !finite(v) ? 'Not available' : v !== 0 && Math.abs(v)<.005 ? (v>0 ? '+' : '−')+'<0.01%' : (v > 0 ? '+' : '') + v.toFixed(2) + '%';
  const val = (v,unit='') => finite(v) ? v.toLocaleString('en-US',{maximumFractionDigits:3}) + (unit ? ' '+unit : '') : 'Not available';
  const safeURL = v => /^https:\/\/[^\s<>"']+$/i.test(String(v || '')) ? v : null;
  const tone = v => !finite(v) ? 'none' : v > 0 ? 'up' : v < 0 ? 'down' : 'none';
  const confidence = v => ['high','medium','low'].includes(v) ? v : 'low';
  const signed = (v,unit) => (v>0 ? '+' : '')+val(v,unit);
  const magnitude = v => finite(v) && v>=0 ? pct(v).replace(/^\+/,'') : 'Not available';
  function validData(d) {
    return !!(d && d.schema === 'smartoptions.shocks.v1' && d.generated_at && d.windows &&
      Array.isArray(d.factors) && d.factors.length === 6 && new Set(d.factors.map(f=>f.id)).size===6 &&
      d.factors.every(f=>f && typeof f.id==='string' && typeof f.label==='string' && f.source && safeURL(f.source.url) && finite(f.standard_move) && f.standard_move>0) &&
      Array.isArray(d.sectors) && d.sectors.length && d.sectors.every(s=>s && typeof s.name==='string' && s.factors &&
        Object.values(s.factors).every(e=>e && finite(e.beta) && finite(e.ci_low) && finite(e.ci_high) && e.ci_low<=e.beta && e.beta<=e.ci_high && finite(e.n) && e.n>=120)) &&
      d.companies && typeof d.companies==='object' && !Array.isArray(d.companies) && Array.isArray(d.scenarios));
  }
  function unavailable(reason) { return `<p class="sq-na" role="status">Not available: ${esc(reason || 'shock history has not been built.')}</p>`; }
  function source(f) {
    const s=f && f.source || {}, url=safeURL(s.url);
    return url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(s.label || 'Source')}</a>` : 'Not available: source missing';
  }
  function meta(d) {
    const reasons = list(d.status && d.status.reasons);
    const age = Date.now()-Date.parse(d.windows.factor_common_end+'T23:59:59Z');
    const stale = Number.isFinite(age) && age>4*86400000;
    return `<p class="sq-basis">Historical factors through ${esc(d.windows.factor_common_end || 'date unavailable')}. ${stale ? '<strong>Stale history.</strong> ' : ''}Daily observations, not live quotes.</p>`+
      (state.error ? `<p class="sq-na" role="status">Showing the previous snapshot. ${esc(state.error)}</p>` : '')+
      (reasons.length ? `<details class="sq-limits"><summary>Data limits</summary><ul>${reasons.map(r=>`<li>${esc(r)}</li>`).join('')}</ul><p>Association is not causation. Current membership and market-cap weights can bias historical comparisons.</p></details>` : '');
  }
  function numbers(e,f,company) {
    if (!e) return unavailable('this sensitivity could not be estimated.');
    const s=e.stability || {};
    const cells = [
      ['Market-controlled beta',val(e.beta,e.unit)],
      ['90% HAC interval',val(e.ci_low)+' to '+val(e.ci_high)+' '+(e.unit||'')],
      ['Raw beta without market control',val(e.raw && e.raw.beta,e.unit)],
      ['Raw 90% HAC interval',val(e.raw && e.raw.ci_low)+' to '+val(e.raw && e.raw.ci_high)],
      ['Model R²',val(e.r2)],['Sample',val(e.n,'sessions')],
      ['Fit window',(e.window_start || 'Not available')+' to '+(e.window_end || 'Not available')],
      ['HAC lags',val(e.hac_lags)],
      ['Holdout sign agreement',finite(e.oos_sign_agreement) ? val(e.oos_sign_agreement*100,'%') : 'Not available: too few holdout windows'],
      ['Holdout contribution correlation',val(s.predicted_realized_correlation)],
      ['Holdout sample',val(s.holdout_n,'sessions')],
      ['Train / test window',val(s.training_n)+' / '+val(s.test_n)+' sessions'],
      ['Holdout design',s.standard_two_year_design ? 'Two years / six months' : 'Short history; shorter windows'],
      ['Confidence',confidence(e.confidence)],
      ['One standard factor move',val(e.standard_move,f && f.unit)],
      ['Source',source(f)],
      ['Stock returns', '<a href="https://finance.yahoo.com/" target="_blank" rel="noopener">Yahoo adjusted-close history</a>']
    ];
    if (company && e.shrunk) cells.unshift(['Sector-shrunken beta',val(e.shrunk.beta,e.unit)],
      ['Stock estimate weight',val(e.shrunk.stock_weight*100,'%')],
      ['Conditional shrunken band',val(e.shrunk.ci_low)+' to '+val(e.shrunk.ci_high)+'; excludes shrinkage bias']);
    let html = `<dl class="sq-numbers">${cells.map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${['Source','Stock returns'].includes(k) ? v : esc(v)}</dd></div>`).join('')}</dl>`;
    const w=e.weekly;
    html += `<details class="sq-weekly"><summary>Weekly evidence</summary>${w ? `<p>Complete weeks only. ${esc(w.window_start)} to ${esc(w.window_end)}.</p><dl class="sq-numbers"><div><dt>Weekly beta</dt><dd>${esc(val(w.beta,w.unit))}</dd></div><div><dt>Weekly 90% HAC interval</dt><dd>${esc(val(w.ci_low)+' to '+val(w.ci_high))}</dd></div><div><dt>Weekly raw beta</dt><dd>${esc(val(w.raw && w.raw.beta))}</dd></div><div><dt>Weekly R² / sample</dt><dd>${esc(val(w.r2)+' / '+val(w.n,'weeks'))}</dd></div><div><dt>Weekly holdout sign agreement</dt><dd>${esc(finite(w.oos_sign_agreement) ? val(w.oos_sign_agreement*100,'%') : 'Not available: too few complete weeks')}</dd></div></dl>` : unavailable('too few complete weeks for a weekly regression.')}</details>`;
    return html+'<p class="sq-basis">Holdout checks use known same-period shocks. These are associations, not forecasts. Intervals measure coefficient uncertainty.</p>';
  }
  function gridHTML(d,error) {
    if (!validData(d)) return `<section class="sq-card"><h2>Sector shock sensitivity</h2>${unavailable(error)}</section>`;
    return `<section class="sq-card"><header class="sq-heading"><h2>Sector shock sensitivity</h2><span class="sq-kind">Historical association</span></header>${meta(d)}<p class="sq-caption">Each cell estimates a sector move for one standard upward shock.</p><div class="sq-scroll" tabindex="0" role="region" aria-label="Sector sensitivity grid; scroll horizontally for all six shocks"><table class="sq-grid"><caption class="sq-sr">Market-controlled historical sector associations. Select a cell for evidence.</caption><thead><tr><th scope="col" class="sq-sticky">Sector</th>${d.factors.map(f=>`<th scope="col">${esc(f.label)}<small>+${esc(val(f.standard_move,f.unit))}</small></th>`).join('')}</tr></thead><tbody>${d.sectors.map((s,i)=>`<tr><th scope="row" class="sq-sticky">${esc(s.name)}</th>${d.factors.map(f=>{
      const e=s.factors[f.id];
      if (!e) return '<td><span class="sq-na">Not available</span></td>';
      const c=confidence(e.confidence), move=e.estimated_move_pct;
      return `<td><button type="button" class="sq-cell sq-${tone(move)} sq-${c}" data-sector="${i}" data-factor="${esc(f.id)}" aria-label="${esc(s.name+', '+f.label+', '+pct(move)+', '+c+' confidence; show evidence')}" aria-expanded="false"><b>${esc(pct(move))}</b><small>${c} confidence</small></button></td>`;
    }).join('')}</tr>`).join('')}</tbody></table></div><p class="sq-legend"><span class="sq-up">+ Positive association</span><span class="sq-down">− Negative association</span><span>Hatching: low confidence</span></p><div class="sq-detail" data-shock-detail tabindex="-1" aria-live="polite"><p class="sq-basis">Select a cell to read its reason and numbers.</p></div><details class="sq-limits"><summary>Confidence and method</summary><p>${esc(d.methods && d.methods.confidence)}</p><p>${esc(d.methods && d.methods.limits)}</p><p>Raw fits omit the market control. Market-controlled fits include SPY and the other five shocks.</p></details></section>`;
  }
  function companyHTML(d,ticker,error) {
    const t=String(ticker || '').toUpperCase(), c=d && d.companies && d.companies[t];
    if (!validData(d) || !c) return `<section class="sq-card"><h2>Company shock exposure</h2>${unavailable(error || 'no constituent history for '+t+'.')}</section>`;
    const exposures=list(c.exposures);
    return `<section class="sq-card"><header class="sq-heading"><h2>Company shock exposure</h2><span class="sq-kind">Historical association</span></header>${meta(d)}<p class="sq-caption">Largest measured sensitivities, softened toward ${esc(c.sector)}.</p><div class="sq-strip">${exposures.map(e=>{
      const f=d.factors.find(f=>f.id===e.factor);
      return `<details class="sq-exposure"><summary><span>${esc(f && f.label || e.factor)}</span><b class="sq-${tone(e.estimated_move_pct)}">${esc(pct(e.estimated_move_pct))}</b><small>Per +${esc(val(e.standard_move,f && f.unit))} · ${confidence(e.confidence)} confidence</small></summary><p>${esc(e.reason)}</p><p class="sq-basis">Shrinkage reduces noisy stock estimates. Its band excludes shrinkage bias; unshrunk intervals remain below.</p>${numbers(e,f,true)}</details>`;
    }).join('') || unavailable(c.reason || 'not enough independent return history.')}</div></section>`;
  }
  function customScenario(d,factorId,change) {
    const f=d.factors.find(f=>f.id===factorId);
    if (!f || !finite(change)) return null;
    const sectors=d.sectors.map(sector=>{
      const e=sector.factors[f.id];
      if (!e || ![e.beta,e.ci_low,e.ci_high].every(finite)) return null;
      const move=change===0 ? 0 : e.beta*change, a=change===0 ? 0 : e.ci_low*change, b=change===0 ? 0 : e.ci_high*change;
      if (![move,a,b].every(finite)) return null;
      return {sector:sector.name,estimated_move_pct:move,ci_low:Math.min(a,b),ci_high:Math.max(a,b),
        confidence:confidence(e.confidence),n:e.n,window_start:e.window_start,window_end:e.window_end,
        reason:`Holding the market and other shocks fixed, ${f.label} ${signed(change,f.unit)} maps to ${pct(move)}. This historical association is not a forecast.`};
    }).filter(Boolean);
    return {factor:f.id,change,unit:f.unit,label:f.label+' '+signed(change,f.unit),sectors,
      reason:change===0 ? 'A zero shock gives zero fitted contribution, not a certain sector return. Bands cover coefficient uncertainty, not future return uncertainty.' : 'Historical sensitivity times your hypothetical daily change. Bands cover coefficient uncertainty, not future return uncertainty.'};
  }
  function rangeHTML(f,change) {
    const r=f && f.observed_daily_range;
    if (!r || !finite(r.min) || !finite(r.max) || r.min>r.max) return '<p class="sq-range sq-basis">Observed daily range unavailable; extrapolation cannot be checked.</p>';
    const outside=change<r.min || change>r.max;
    return `<p class="sq-range${outside ? ' sq-extrapolation' : ' sq-basis'}"><strong>${outside ? 'Extrapolation' : 'Within observed daily range'}.</strong> Observed ${esc(val(r.min,f.unit))} to ${esc(val(r.max,f.unit))}${r.window_start && r.window_end ? ' ('+esc(r.window_start)+' to '+esc(r.window_end)+')' : ''}. ${outside ? 'This shock is outside the observed range; a linear association may not extend this far.' : 'Range membership does not establish a reliable forecast.'}</p>`;
  }
  function scenarioRows(d,id,custom) {
    const s=custom || d.scenarios.find(s=>s.id===id) || d.scenarios[0];
    if (!s) return unavailable('no conditional scenarios.');
    const f=d.factors.find(f=>f.id===s.factor);
    const rows=list(s.sectors).slice().sort((a,b)=>Math.abs(b.estimated_move_pct)-Math.abs(a.estimated_move_pct));
    const card=m=>`<details class="sq-scenario"><summary><span>${esc(m.sector)}</span><b class="sq-${tone(m.estimated_move_pct)}">${esc(pct(m.estimated_move_pct))}</b><small>${confidence(m.confidence)} confidence</small><span class="sq-reason">${esc(m.reason)}</span></summary><dl class="sq-numbers"><div><dt>Conditional 90% HAC coefficient band</dt><dd>${esc(pct(m.ci_low)+' to '+pct(m.ci_high))}</dd></div><div><dt>Sample</dt><dd>${esc(val(m.n,'sessions'))}</dd></div><div><dt>Fit window</dt><dd>${esc(m.window_start)} to ${esc(m.window_end)}</dd></div><div><dt>Shock source</dt><dd>${source(f)}</dd></div><div><dt>Return source</dt><dd><a href="https://finance.yahoo.com/" target="_blank" rel="noopener">Yahoo adjusted-close returns</a></dd></div></dl><p class="sq-basis">Other shocks and market returns are held fixed. Confidence describes historical coefficient evidence, not the chance of this move. This is not a future-return interval.</p></details>`;
    return `<p class="sq-caption">${esc(s.reason)}</p>${rangeHTML(f,s.change)}<p class="sq-basis">Largest absolute sector associations for ${esc(s.label)}.</p><div class="sq-scenarios">${rows.slice(0,3).map(card).join('')}</div>`+
      (rows.length>3 ? `<details class="sq-more"><summary>Other sector effects (${rows.length-3})</summary><div class="sq-scenarios">${rows.slice(3).map(card).join('')}</div></details>` : '');
  }
  const eventLabels={cpi:'CPI',payrolls:'Payrolls',fomc:'FOMC'};
  function eventRows(d,sectorName) {
    const events=d && d.event_study;
    if (!events || typeof events!=='object') return unavailable('release-day evidence has not been built.');
    return `<div class="sq-event-cards">${Object.entries(eventLabels).map(([id,label])=>{
      const study=events[id], sector=study && study.sectors && study.sectors[sectorName];
      if (!sector || !sector.windows) return `<article class="sq-event"><h4>${label}</h4>${unavailable('no '+label+' evidence for this sector.')}</article>`;
      const windows=[['day_0','Day 0'],['days_0_2','CAR 0..2']];
      const calendar=study.calendar || {}, url=safeURL(calendar.source_url);
      const dates=list(sector.events).filter(e=>e && typeof e.date==='string').slice().sort((a,b)=>a.date.localeCompare(b.date));
      const valid=w=>w && finite(w.n) && w.n>0 && finite(w.mean_abnormal_return_pct) && finite(w.mean_absolute_abnormal_return_pct) && w.mean_absolute_abnormal_return_pct>=0;
      return `<details class="sq-event"><summary><strong>${label} releases</strong><span class="sq-event-stats">${windows.map(([id,title])=>{
        const w=sector.windows[id];
        return `<span><b>${title}</b> ${valid(w) ? `<em class="sq-${tone(w.mean_abnormal_return_pct)}">${esc(pct(w.mean_abnormal_return_pct))}</em><small>Mean absolute ${esc(magnitude(w.mean_absolute_abnormal_return_pct))} · n=${esc(val(w.n))}</small>` : '<small>Not available: insufficient event evidence</small>'}</span>`;
      }).join('')}</span><span class="sq-reason">These returns differ from an earlier market-model fit. Small, confounded samples give limited confidence in repeating the average.</span><small class="sq-event-dates">${dates.length ? esc(dates[0].date)+' to '+esc(dates[dates.length-1].date) : 'Observation dates unavailable'} · Evidence +</small></summary><p class="sq-basis">Day 0 is the release session; CAR 0..2 adds abnormal returns over three trading sessions. Mean absolute measures reaction size, not surprise direction or event probability.</p><dl class="sq-numbers">${windows.map(([id,title])=>{
        const w=sector.windows[id];
        return `<div><dt>${title}: 90% mean interval</dt><dd>${valid(w) && finite(w.ci_low) && finite(w.ci_high) && w.ci_low<=w.ci_high ? esc(pct(w.ci_low)+' to '+pct(w.ci_high)) : 'Not available'}</dd></div><div><dt>${title}: conventional mean t-statistic</dt><dd>${esc(val(w && w.t_stat))}</dd></div>`;
      }).join('')}<div><dt>Calendar source / checked</dt><dd>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">Official release calendar</a>` : 'Not available'} · ${esc(calendar.verified_at || 'date unavailable')}</dd></div></dl><p class="sq-basis">${esc(study.limitation || 'Overlapping events and multiple comparisons are not adjusted.')}.</p><details class="sq-event-dates-list"><summary>Observed releases and prior fit dates</summary><ul>${dates.map(e=>{
        const url=safeURL(e.source_url);
        return `<li>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(e.date)}</a>` : esc(e.date)} · fit through ${esc(e.train_end || 'unavailable')} (${esc(val(e.train_n,'sessions'))})</li>`;
      }).join('')}</ul><p class="sq-basis">${esc(val(list(sector.skipped_insufficient_history).length))} release dates skipped for insufficient earlier history. CAR counts can be smaller when following sessions are unavailable.</p></details></details>`;
    }).join('')}</div>`;
  }
  function eventHTML(d) {
    const names=d.sectors.map(s=>s.name);
    return `<section class="sq-events" aria-label="Historical release reactions"><h3>Release-day evidence</h3><p class="sq-basis">Historical reactions to CPI, payrolls and FOMC releases; no verified surprise direction or prediction.</p><label class="sq-picker">Sector<select data-shock-event-sector aria-label="Sector for release-day evidence">${names.map(n=>`<option>${esc(n)}</option>`).join('')}</select></label><div data-shock-event-results>${eventRows(d,names[0])}</div></section>`;
  }
  function scenarioHTML(d,error) {
    if (!validData(d)) return `<section class="sq-card"><h2>Shock scenarios</h2>${unavailable(error)}</section>`;
    const initial=d.scenarios[0], f=d.factors.find(f=>initial && f.id===initial.factor) || d.factors[0];
    return `<section class="sq-card"><header class="sq-heading"><h2>Shock scenarios</h2><span class="sq-kind">Conditional scenario</span></header>${meta(d)}<div class="sq-scenario-controls"><label class="sq-picker">Preset<select data-shock-scenario aria-label="Choose a hypothetical shock">${d.scenarios.map(s=>`<option value="${esc(s.id)}">${esc(s.label)}</option>`).join('')}<option value="custom">Custom single factor</option></select></label><label class="sq-picker">Factor<select data-shock-factor aria-label="Factor for custom shock">${d.factors.map(factor=>`<option value="${esc(factor.id)}"${factor.id===f.id ? ' selected' : ''}>${esc(factor.label)} (${esc(factor.unit)})</option>`).join('')}</select></label><label class="sq-picker">Daily change <span data-shock-unit>(${esc(f.unit)})</span><input data-shock-change type="number" step="any" inputmode="decimal" value="${esc(initial ? initial.change : f.standard_move)}" aria-label="Signed hypothetical daily factor change" aria-describedby="sq-input-help"></label></div><p id="sq-input-help" class="sq-basis">Enter a signed daily change for one factor. Results update immediately using the stored daily fit; other shocks and the market stay fixed.</p><div data-scenario-results aria-live="polite">${scenarioRows(d)}</div>${eventHTML(d)}</section>`;
  }
  async function load(options) {
    if (state.pending) return state.pending;
    if (state.data && !(options && options.refresh)) return state.data;
    state.pending=(async()=>{
      try {
        const response=await root.fetch('data/shocks.json',{cache:'no-store'});
        if (!response.ok) throw new Error('Shock snapshot returned HTTP '+response.status+'.');
        const d=await response.json();
        if (!validData(d)) throw new Error('Shock snapshot has invalid evidence or schema.');
        state.data=d; state.error=''; return d;
      } catch (error) {
        state.error=error && error.message || 'Shock snapshot could not be loaded.';
        if (root.console && root.console.error) root.console.error('SmartOptions shock data:',state.error);
        return state.data;
      } finally { state.pending=null; }
    })();
    return state.pending;
  }
  function resolve(el) { return typeof el==='string' && root.document ? root.document.querySelector(el) : el; }
  async function mount(el,kind,ticker) {
    el=resolve(el); if (!el) return null;
    el.innerHTML='<p class="sq-basis" role="status">Loading historical shock evidence.</p>';
    const d=await load();
    el.innerHTML=kind==='grid' ? gridHTML(d,state.error) : kind==='company' ? companyHTML(d,ticker,state.error) : scenarioHTML(d,state.error);
    el.onclick=event=>{
      const back=event.target.closest && event.target.closest('button[data-shock-back]');
      if (back && el.contains(back)) {
        const selected=el.querySelector('button[data-sector][aria-expanded="true"]');
        if (selected) selected.focus();
        return;
      }
      const button=event.target.closest && event.target.closest('button[data-sector]');
      if (!button || !el.contains(button) || !d) return;
      const sector=d.sectors[Number(button.dataset.sector)], f=d.factors.find(f=>f.id===button.dataset.factor);
      const e=sector && f && sector.factors[f.id], panel=el.querySelector('[data-shock-detail]');
      if (!e || !panel) return;
      el.querySelectorAll('button[data-sector]').forEach(b=>b.setAttribute('aria-expanded',String(b===button)));
      panel.innerHTML=`<h3>${esc(sector.name)} · ${esc(f.label)}</h3><p>${esc(e.reason)}</p><button type="button" class="sq-back" data-shock-back>Back to grid</button><details open><summary>Numbers and sources</summary>${numbers(e,f,false)}</details>`;
      panel.focus({preventScroll:true});
      if (panel.scrollIntoView) panel.scrollIntoView({block:'start',behavior:root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'});
    };
    el.onchange=event=>{
      if (!d || !event.target.matches) return;
      if (event.target.matches('[data-shock-scenario]')) {
        const preset=d.scenarios.find(s=>s.id===event.target.value);
        if (preset) {
          const factor=el.querySelector('[data-shock-factor]'), input=el.querySelector('[data-shock-change]'), unit=el.querySelector('[data-shock-unit]');
          if (factor) factor.value=preset.factor;
          if (input) { input.value=preset.change; if (input.setAttribute) input.setAttribute('aria-invalid','false'); }
          if (unit) unit.textContent='('+preset.unit+')';
          el.querySelector('[data-scenario-results]').innerHTML=scenarioRows(d,preset.id);
        } else updateCustom();
      } else if (event.target.matches('[data-shock-factor]')) updateCustom();
      else if (event.target.matches('[data-shock-event-sector]')) el.querySelector('[data-shock-event-results]').innerHTML=eventRows(d,event.target.value);
    };
    function updateCustom() {
      const factor=el.querySelector('[data-shock-factor]'), input=el.querySelector('[data-shock-change]'), preset=el.querySelector('[data-shock-scenario]'), unit=el.querySelector('[data-shock-unit]'), results=el.querySelector('[data-scenario-results]');
      if (!factor || !input || !results) return;
      const f=d.factors.find(f=>f.id===factor.value);
      if (preset) preset.value='custom';
      if (unit) unit.textContent='('+(f ? f.unit : '')+')';
      const value=String(input.value).trim(), change=value==='' ? null : Number(value);
      const scenario=customScenario(d,factor.value,change);
      if (input.setAttribute) input.setAttribute('aria-invalid',String(!scenario || !scenario.sectors.length));
      results.innerHTML=scenario && scenario.sectors.length ? scenarioRows(d,null,scenario) : unavailable('enter a finite numeric shock; no estimate is substituted for missing input.');
    }
    el.oninput=event=>{ if (d && event.target.matches && event.target.matches('[data-shock-change]')) updateCustom(); };
    return d;
  }
  return {load,renderGrid:el=>mount(el,'grid'),renderCompany:(el,ticker)=>mount(el,'company',ticker),renderScenario:el=>mount(el,'scenario'),
    validData,gridHTML,companyHTML,scenarioHTML,scenarioRows,customScenario,eventHTML,eventRows};
});
