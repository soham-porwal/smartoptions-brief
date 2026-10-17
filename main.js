/* SmartOptions Brief: the minimal main page (Market brief, Companies, Macro).
   Prices come from the one quote engine in live.js (Yahoo stream, then the shared Worker, then the
   published quote file). Every price-dependent number and sentence is a "slot" that re-renders when an
   accepted quote changes; statements and macro releases keep their own reporting dates.
   Relationships are historical associations (core.json rel: OLS over <=252 sessions), never forecasts.
   The expanded workstation lives at backup.html and is not linked from navigation, only from the footer. */
'use strict';
(function (root) {
  const isNum = v => typeof v === 'number' && isFinite(v);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const pct = (v, d) => isNum(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d == null ? 2 : d) + '%' : 'n/a';
  const px = v => isNum(v) ? '$' + (v >= 1000 ? v.toLocaleString('en-US', {maximumFractionDigits: 2, minimumFractionDigits: 2}) : v.toFixed(2)) : 'n/a';
  const big = v => !isNum(v) ? 'n/a' : Math.abs(v) >= 1e12 ? (v / 1e12).toFixed(2) + 'T' : Math.abs(v) >= 1e9 ? (v / 1e9).toFixed(1) + 'bn' : Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(1) + 'm' : v.toLocaleString('en-US');
  const dir = v => isNum(v) ? (v >= 0 ? 'up' : 'dn') : '';
  const listJoin = xs => xs.length <= 1 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1];

  // Factor wording for relationship sentences. scale = factor move used in the sentence.
  const FACTORS = {
    us10y_bps: {name: '10-year Treasury yield', per: '+10 bp', scale: 10, macro: ['curve', 'us10y'], move: ['curve', 'us10y_bps_chg'], moveUnit: 'bp'},
    dxy: {name: 'US dollar index', per: '+1%', scale: 1, macro: ['cross_asset', 'dxy'], move: ['cross_asset', 'dxy_ret_20d'], moveUnit: '%', moveSpan: '20 sessions'},
    wti: {name: 'WTI crude oil', per: '+10%', scale: 10, macro: ['cross_asset', 'wti'], move: ['cross_asset', 'wti_ret_20d'], moveUnit: '%', moveSpan: '20 sessions'},
    vix: {name: 'VIX', per: '+1 point', scale: 1, macro: ['volatility', 'vix'], move: null}
  };

  /* ------------------------------------------------------------ pure analytics (exported for node tests) */
  function median(xs) { const a = xs.filter(isNum).sort((x, y) => x - y); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
  // Sector median sensitivity to one factor, members only, minimum 120 common sessions.
  function sectorSensitivity(rows, factor) {
    const by = {};
    (rows || []).forEach(r => { if (r.sp500_member === false || !r.rel || !(r.rel.n >= 120) || !r.rel.c || !isNum(r.rel.c[factor])) return; (by[r.sec] ||= []).push(r.rel.c[factor]); });
    return Object.entries(by).filter(([, xs]) => xs.length >= 5).map(([sector, xs]) => ({sector, n: xs.length, coef: median(xs)})).sort((a, b) => a.coef - b.coef);
  }
  function macroItem(core, path) { const g = core && core.macro && core.macro[path[0]]; return Array.isArray(g) ? g.find(x => x.id === path[1]) || null : null; }
  // One or two plain sentences linking a factor's latest move to the sectors that have historically moved most with it.
  function factorSentence(core, factor) {
    const f = FACTORS[factor], s = sectorSensitivity(core.rows, factor);
    if (!f || s.length < 2) return null;
    const lvl = macroItem(core, f.macro), mv = f.move ? macroItem(core, f.move) : null;
    const low = s.slice(0, 2), high = s.slice(-2).reverse();
    const fmt = x => x.sector + ' (' + pct(x.coef * f.scale, 2) + ')';
    let lead = f.name;
    if (lvl && isNum(lvl.v)) lead += ' ' + (factor === 'us10y_bps' ? lvl.v.toFixed(2) + '%' : lvl.v.toFixed(2)) + (lvl.period ? ' (' + lvl.period + ')' : '');
    if (mv && isNum(mv.v)) lead += ', ' + (f.moveUnit === 'bp' ? (mv.v > 0 ? '+' : mv.v < 0 ? '−' : '') + Math.abs(mv.v).toFixed(0) + ' bp on ' + (mv.period || 'the latest day') : pct(mv.v, 1) + ' over ' + f.moveSpan + (mv.period ? ' to ' + mv.period : ''));
    else if (lvl && isNum(lvl.prior)) lead += ' (prior ' + lvl.prior.toFixed(2) + ')';
    return {factor, lead, text: `${lead}. Over the past year, for each ${f.per} move the estimated median stock response was lowest in ${listJoin(low.map(fmt))} and highest in ${listJoin(high.map(fmt))}, other factors held fixed.`, low, high};
  }
  // Breadth and cap-weighted sector change from ONE reporting session. Quotes are grouped by the New York date of
  // their observation; the newest session holding at least 90% of members is used, so a few streamed names never
  // pass as a whole-index reading and yesterday's prints never mix with today's. Cap weights use the close market cap.
  function liveBreadth(rows, getQuote, minCover) {
    const etDay = ms => new Date(ms).toLocaleDateString('en-CA', {timeZone: 'America/New_York'});
    const members = (rows || []).filter(r => r.sp500_member !== false), by = {};
    members.forEach(r => {
      const q = getQuote(r.t); if (!q || q.current_usable === false) return;
      const c = isNum(q.chg_pct) ? q.chg_pct : q.change_pct, t = Date.parse(q.asof_utc || q.ts || '');
      if (!isNum(c) || !isFinite(t)) return;
      (by[etDay(t)] ||= []).push({r, c, t});
    });
    const days = Object.keys(by).sort().reverse(), need = Math.ceil((minCover == null ? 0.9 : minCover) * members.length);
    const day = days.find(d => by[d].length >= need) || null, newest = days[0] || null;
    const out = {session: day, members: members.length, newest_session: newest, newest_n: newest ? by[newest].length : 0, complete: !!day, up: 0, n: 0, up_pct: null, sectors: [], newest: null};
    if (!day) return out;
    const sec = {};
    by[day].forEach(({r, c, t}) => {
      out.n++; if (c > 0) out.up++; if (out.newest == null || t > out.newest) out.newest = t;
      if (isNum(r.mcap) && r.mcap > 0) { const x = sec[r.sec] ||= {w: 0, wc: 0, n: 0}; x.w += r.mcap; x.wc += r.mcap * c; x.n++; }
    });
    out.up_pct = 100 * out.up / out.n;
    out.sectors = Object.entries(sec).map(([sector, x]) => ({sector, chg: x.wc / x.w, n: x.n})).sort((a, b) => b.chg - a.chg);
    return out;
  }
  // Current valuation words and numbers from the same accepted price. Earnings and sector medians keep their dates.
  function valuationText(cur, closeRatio, secTrail, secFwd, asof) {
    const word = r => r > 1.05 ? 'above' : r < 0.95 ? 'below' : 'in line with';
    if (!cur || !isNum(cur.px) || !(cur.px > 0) || !isNum(cur.pe)) {
      return isNum(closeRatio) ? `Current price unavailable, so no current comparison. At the ${asof} close trailing P/E was ${closeRatio.toFixed(2)}× the sector median.` : 'Valuation comparison unavailable.';
    }
    const parts = [];
    if (isNum(secTrail) && secTrail > 0) { const r = cur.pe / secTrail; parts.push(`trailing P/E ${cur.pe.toFixed(1)} is ${r.toFixed(2)}× the sector median of ${secTrail.toFixed(1)}, ${word(r)} it`); }
    else parts.push(`trailing P/E ${cur.pe.toFixed(1)}`);
    if (isNum(cur.pef) && isNum(secFwd) && secFwd > 0) { const r = cur.pef / secFwd; parts.push(`forward P/E ${cur.pef.toFixed(1)} is ${r.toFixed(2)}× the sector forward median, ${word(r)} it`); }
    return `At ${px(cur.px)}, ${parts.join('; ')}. Earnings and sector medians are as of ${asof}.`;
  }
  // Strongest measured counterpoint, or an explicit statement that none is supported. Never an all-clear.
  function counterpoint(text, cur, er, nowMs) {
    if (text && !/no weak area/i.test(text) && !/^not available/i.test(text)) return text;
    const out = [];
    if (cur && isNum(cur.pef_sec_rel) && cur.pef_sec_rel >= 1.25 && isNum(cur.pef)) out.push(`Valuation: forward P/E ${cur.pef.toFixed(1)} is ${cur.pef_sec_rel.toFixed(2)}× the sector median at the current price.`);
    const d = Date.parse(er || ''); if (isFinite(d) && d >= nowMs - 864e5 && d - nowMs <= 21 * 864e5) out.push(`Earnings expected ${er} (provider date); results can reset the case.`);
    return out.length ? out.join(' ') : 'No counterargument is supported by the retained inputs; that is not an all-clear.';
  }
  // Price versus averages: averages keep their dated sessions; the price is the latest accepted quote.
  function vsAverages(price, a50, a200) {
    if (!isNum(price) || !(price > 0)) return null;
    return {v50: isNum(a50) && a50 > 0 ? 100 * (price / a50 - 1) : null, v200: isNum(a200) && a200 > 0 ? 100 * (price / a200 - 1) : null};
  }
  // Route from a hash. Old expanded-dashboard hashes land on simple content or say where the view lives.
  function route(hash) {
    const h = String(hash || '').replace(/^#/, '');
    let m;
    if (!h || h === '/' || h === '/brief') return {view: 'brief'};
    if (/^\/explore(\?|$)/.test(h)) return {view: 'explore', hash: '#' + h};
    if ((m = h.match(/^\/sector\/(.+)$/))) { try { return {view:'sector', sector:decodeURIComponent(m[1])}; } catch(e) { return {view:'brief', invalid:true}; } }
    if ((m = h.match(/^\/learn\/(.+)$/))) { try { return {view:'learn', label:decodeURIComponent(m[1])}; } catch(e) { return {view:'brief',invalid:true}; } }
    if ((m = h.match(/^\/company\/([A-Za-z0-9.\-]{1,10})$/))) return {view: 'company', t: m[1].toUpperCase().replace('.', '-')};
    if (h === '/companies') return {view: 'companies'};
    if (h === '/macro' || /(^|&)tab=macro\b/.test(h)) return {view: 'macro'};
    if ((m = h.match(/(?:^|[&?])t=([A-Za-z0-9.\-]{1,10})/))) return {view: 'company', t: m[1].toUpperCase().replace('.', '-')};
    if ((m = h.match(/^\/research\/company\/([A-Za-z0-9.\-]{1,10})/))) return {view: 'company', t: m[1].toUpperCase().replace('.', '-')};
    return {view: 'brief', legacy: '#' + h};
  }

  // Name the session the quotes belong to: 'today' only when the newest accepted observation is from today in New York.
  function sessionWord(ms, nowMs) {
    if (!isNum(ms)) return 'in the latest session';
    const day = x => new Date(x).toLocaleDateString('en-CA', {timeZone: 'America/New_York'});
    return day(ms) === day(nowMs) ? 'today' : 'on ' + new Date(ms).toLocaleDateString('en-US', {timeZone: 'America/New_York', month: 'short', day: 'numeric'});
  }
  /* ------------------------------------------------------------ drilldown insights (pure) */
  // Each insight: a quantifier, what it means, what challenges it, and one link into Explore with the matching state.
  const W = typeof module !== 'undefined' && module.exports ? require('./workspace.js') : root.SmartOptionsWorkspace;
  const corrWord = r => Math.abs(r) < 0.2 ? 'little' : Math.abs(r) < 0.5 ? 'moderate' : 'strong';
  const fmtU = (v, u) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2) + (u === '%' ? '%' : ' ' + u);
  const pp = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2) + ' pp';
  function concentrationInsight(vb) {
    const b = vb && vb.breadth_rsp_spy_20d, h = b && b.history || [];
    if (!b || !isNum(b.value) || h.length < 2) return null;
    const last = h[h.length - 1], prior = h.length > 20 ? h[h.length - 21] : null, v = b.value;
    const meaning = Math.abs(v) < 1 ? 'Near zero: the average S&P stock kept pace with the largest names.' : v < 0 ? 'The largest names did more of the lifting; participation was narrow.' : 'The average stock outpaced the largest names; participation was broad.';
    const challenge = prior && isNum(prior[1]) ? `Twenty sessions earlier (${prior[0]}) the gap was ${pp(prior[1])}; this measure swings quickly and says nothing about the next month.` : 'Single reading; no earlier comparison is retained.';
    return {id: 'concentration', q: `Equal-weight S&P 500 (RSP) ${v >= 0 ? 'beat' : 'trailed'} cap-weight (SPY) by ${Math.abs(v).toFixed(2)} pp over the 20 sessions to ${last[0]}.`, meaning, challenge,
      href: W.encodeHash({s: [{id: 'eq:RSP'}, {id: 'eq:SPY'}], r: '6m', m: 'index'}), action: 'Compare RSP and SPY'};
  }
  // Basket return over n sessions from relationships.json baskets.
  function basketMoves(baskets, n) {
    return Object.values(baskets || {}).map(b => { const h = b.h || []; if (h.length <= n) return null; const a = h[h.length - 1 - n], z = h[h.length - 1]; return {sector: b.label.replace(/ basket.*/, ''), id: b.id, from: a[0], to: z[0], ret: 100 * (z[1] / a[1] - 1), members: b.members}; })
      .filter(Boolean).sort((a, b) => b.ret - a.ret);
  }
  const findPair = (rel, y, x) => (rel && rel.pairs || []).find(p => p.y === y && p.x === x) || null;
  function leadershipInsight(rel, n) {
    const mv = basketMoves(rel && rel.baskets, n || 20); if (mv.length < 2) return null;
    const lead = mv[0], lag = mv[mv.length - 1], pl = findPair(rel, lead.id, 'eq:SPY');
    const challenge = pl ? `${lead.sector} moved with SPY at correlation ${pl.corr.toFixed(2)} over ${pl.n} sessions to ${pl.fit_end} (${pl.stability}); ` + (Math.abs(pl.corr) < 0.3 ? 'so its lead says little about the index itself.' : 'so part of its lead is the market itself.') : 'No market relationship is published for this basket.';
    return {id: 'leadership', q: `Over 20 sessions to ${lead.to}, the ${lead.sector} basket ${lead.ret >= 0 ? 'rose' : 'fell'} ${Math.abs(lead.ret).toFixed(1)}% and ${lag.sector} ${lag.ret >= 0 ? 'rose' : 'fell'} ${Math.abs(lag.ret).toFixed(1)}%.`,
      meaning: `A ${(lead.ret - lag.ret).toFixed(1)} pp spread between the strongest and weakest sector baskets (equal-weight members, not ETFs).`, challenge,
      href: W.encodeHash({s: [{id: lead.id}, {id: lag.id}, {id: 'eq:SPY'}], r: '3m', m: 'index'}), action: 'Compare leader, laggard and SPY'};
  }
  // Strongest published sector-macro association that is stable and keeps its sign after holding SPY fixed.
  function macroInsight(rel, core) {
    const ps = (rel && rel.pairs || []).filter(p => /^sec:/.test(p.y) && /^mac:/.test(p.x) && p.stability === 'stable' && isNum(p.beta_given_spy) && p.se_given_spy > 0 && Math.sign(p.beta_given_spy) === Math.sign(p.beta))
      .sort((a, b) => Math.abs(b.beta_given_spy / b.se_given_spy) - Math.abs(a.beta_given_spy / a.se_given_spy));   // strongest beyond the market itself
    const p = ps[0]; if (!p) return null;
    const mid = p.x.slice(4), meta = rel.macro && rel.macro[mid] || {}, sector = p.y_label.replace(/ basket.*/, '');
    const per = p.x_unit === '%' ? '+1%' : '+1 ' + p.x_unit.replace(/s$/, ''), yu = p.y_unit === '%' ? '%' : ' ' + p.y_unit;
    const lvl = W && macroLevel(core, mid);
    const ho = p.holdout ? ` In the latest ${p.holdout.test_n} sessions, the earlier fit explained ${(100 * p.holdout.oos_r2).toFixed(0)}% of daily variation (same-day fit, not a forecast).` : '';
    const ce = p.counterexample ? ` On ${p.counterexample.date} ${meta.label || mid} moved ${fmtU(p.counterexample.x, p.x_unit)} and the basket moved ${fmtU(p.counterexample.y, p.y_unit)}, against the usual direction.` : '';
    return {id: 'macro', pair: p.id, q: `${sector} basket and ${meta.label || mid}: correlation ${p.corr.toFixed(2)} over ${p.n} daily changes to ${p.fit_end}; about ${p.beta >= 0 ? '+' : '−'}${Math.abs(p.beta).toFixed(2)}${yu} per ${per}.`,
      meaning: `${corrWord(p.corr)[0].toUpperCase() + corrWord(p.corr).slice(1)} co-movement${p.corr < 0 ? ' in opposite directions' : ''}; holding SPY fixed the slope is ${p.beta_given_spy >= 0 ? '+' : '−'}${Math.abs(p.beta_given_spy).toFixed(2)}${yu}.` + (lvl ? ` Latest ${meta.label || mid}: ${lvl}.` : ''),
      challenge: (ho + ce).trim() || 'Association only.', href: W.encodeHash({s: [{id: p.y}, {id: p.x}], r: '1y', m: 'z', ind: {rc: true}}), action: `Explore ${sector} against ${meta.label || mid}`};
  }
  function macroLevel(core, mid) {
    for (const g of Object.values(core && core.macro || {})) for (const x of g || []) if (x.id === mid && isNum(x.v)) return `${+x.v.toFixed(2)} ${x.unit || ''} on ${x.period || x.date || 'its last observation'}`.replace(/ +/g, ' ');
    return null;
  }
  // Today's equal- versus cap-weight change, only when both quotes are usable and from the same New York session.
  function liveConcentration(rsp, spy) {
    const c = q => q && q.current_usable !== false && (isNum(q.chg_pct) ? q.chg_pct : q.change_pct);
    const ms = q => Date.parse(q && (q.asof_utc || q.ts) || '');
    if (!isNum(c(rsp)) || !isNum(c(spy)) || !isFinite(ms(rsp)) || !isFinite(ms(spy))) return null;
    const d1 = W.nyDate(ms(rsp)), d2 = W.nyDate(ms(spy));
    if (d1 !== d2) return null;
    return {session: d1, rsp: c(rsp), spy: c(spy), gap: c(rsp) - c(spy)};
  }

  // Published catalog entry for the panel's direction (y on x). Regression slopes do not invert by reciprocal, so a
  // catalog fit in the opposite direction is labelled as such and only its symmetric facts are shown.
  function catalogNote(rel, y, x) {
    const pairs = rel && rel.pairs || [], f = v => (+v.toFixed(3)).toString();
    const same = pairs.find(p => p.y === y.id && p.x === x.id), rev = !same && pairs.find(p => p.y === x.id && p.x === y.id);
    const ho = c => c.holdout && isNum(c.holdout.oos_r2) ? ` Chronological check: fitted on the first ${c.holdout.train_n} sessions, the same-day relationship explained ${(100 * c.holdout.oos_r2).toFixed(1)}% of the next ${c.holdout.test_n} sessions’ variation versus a no-relationship baseline (stability, not a forecast).` : ' Chronological check unavailable for this pair.';
    if (same) {
      return {direction: 'same', summary: `Published relationship, ${same.y_label} on ${same.x_label} (fit to ${same.fit_end}, ${same.stability})`,
        text: `Correlation ${same.corr.toFixed(2)}; slope ${f(same.beta)} ${same.units} over ${same.n} changes ${same.fit_start} to ${same.fit_end}.` +
          (isNum(same.beta_given_spy) ? ` Holding SPY fixed: ${f(same.beta_given_spy)} (standard error ${f(same.se_given_spy)}).` : '') + ho(same) +
          (same.counterexample ? ` Counterexample: on ${same.counterexample.date} ${same.x_label} moved ${f(same.counterexample.x)} ${same.x_unit} and ${same.y_label} moved ${f(same.counterexample.y)} ${same.y_unit}, against the usual direction.` : '')};
    }
    if (rev) {
      return {direction: 'reverse', summary: `Published relationship in the other direction: ${rev.y_label} on ${rev.x_label} (fit to ${rev.fit_end}, ${rev.stability})`,
        text: `The catalog fits ${rev.y_label} on ${rev.x_label}, the opposite of this panel. Correlation is symmetric: ${rev.corr.toFixed(2)} over ${rev.n} changes ${rev.fit_start} to ${rev.fit_end}. Its slope (${rev.units}) describes that direction only and is not the reciprocal of this panel's slope, so it is not restated here; the slope above is fitted in this panel's direction.`};
    }
    return null;
  }

  const API = {catalogNote, concentrationInsight, leadershipInsight, macroInsight, basketMoves, liveConcentration, corrWord, valuationText, counterpoint, sessionWord, sectorSensitivity, factorSentence, liveBreadth, vsAverages, route, median, FACTORS, pct, px};
  if (typeof module !== 'undefined' && module.exports) { module.exports = API; return; }
  root.SmartOptionsMain = API;
  const doc = root.document; if (!doc) return;

  /* ------------------------------------------------------------ page */
  const Live = root.SmartOptionsLive;
  const S = root.__soMainState = {core: null, brief: null, rel: null, rowMap: new Map(), slots: [], view: null, chart: null, company: {}, onQuote: null};
  const $ = s => doc.querySelector(s);
  const q = t => Live.get(t);
  const row = t => S.rowMap.get(t) || null;
  const learnHref=label=>'#/learn/'+encodeURIComponent(label);
  const learnLink=(label,text)=>`<a class="learn" href="${learnHref(label)}" aria-label="Explain ${esc(label)}">${esc(text||label)}</a>`;
  const liveSpan = (t, f) => `<a class="learn" href="${learnHref((f==='price'?'Price':'Daily return')+' · '+t)}" aria-label="Explain ${esc(t)} ${f}"><span data-live="${esc(t)}" data-live-f="${f}"></span></a>`;
  function slot(id, fn) { S.slots.push({id, fn}); return `<span class="slot" id="${id}">${fn()}</span>`; }
  function paintSlots() { S.slots.forEach(s => { const el = doc.getElementById(s.id); if (el) { const h = s.fn(); if (el.innerHTML !== h) {
    if(s.id==='heat' && el.querySelector('svg')) {const tmp=doc.createElement('div');tmp.innerHTML=h;el.querySelectorAll('[data-sector]').forEach(a=>{const newer=[...tmp.querySelectorAll('[data-sector]')].find(x=>x.dataset.sector===a.dataset.sector);if(newer){a.setAttribute('aria-label',newer.getAttribute('aria-label'));a.querySelector('rect').setAttribute('fill',newer.querySelector('rect').getAttribute('fill'));a.querySelectorAll('text,title').forEach((t,i)=>t.textContent=newer.querySelectorAll('text,title')[i].textContent);}});
      el.querySelectorAll('[data-sector-link]').forEach(a=>{const newer=[...tmp.querySelectorAll('[data-sector-link]')].find(x=>x.dataset.sectorLink===a.dataset.sectorLink);if(newer)a.querySelector('b').textContent=newer.querySelector('b').textContent;});
      const basis=el.querySelector('.map-basis'),fresh=tmp.querySelector('.map-basis');if(basis?.firstChild&&fresh?.firstChild)basis.firstChild.textContent=fresh.firstChild.textContent;
    }
    else el.innerHTML = h;
  } } }); }
  async function json(url) { const r = await fetch(url, {cache: 'no-store'}); if (!r.ok) throw new Error(url + ' HTTP ' + r.status); return r.json(); }
  const source = m => m && m.source_url ? `<a href="${esc(m.source_url)}" target="_blank" rel="noopener">${esc(m.source || 'source')}</a>` : esc(m && m.source || '');
  function metricValue(m) {
    if (!m || m.value == null) return 'n/a';
    const v = m.value, u = m.unit || '';
    if (!isNum(v)) return esc(v);
    if (u === '%' || /^% /.test(u)) return pct(v, 1).replace(/^\+/, v > 0 && /growth|change|vs|versus/i.test(m.label) ? '+' : '');
    if (u === 'pp') return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + ' pp';
    if (u === 'x') return v.toFixed(2) + '×';
    if (u === 'USD') return '$' + big(v);
    if (u === 'USD/share') return px(v);
    if (u === 'bps') return v.toFixed(0) + ' bp';
    return (Math.abs(v) >= 1e5 ? big(v) : +v.toFixed(2)) + (u && !/revisions/.test(u) ? ' ' + esc(u) : '');
  }
  function metricTable(ms, bare) {
    ms = (ms || []).filter(m => m && m.label);
    if (!ms.length) return '';
    const key=m=>m.label+(S.view==='company'?' · '+route(root.location.hash).t:'');
    ms.forEach(m=>{S.metricEvidence ||= new Map();S.metricEvidence.set(key(m),m);while(S.metricEvidence.size>256)S.metricEvidence.delete(S.metricEvidence.keys().next().value);});
    const table = `<table>${ms.map(m => `<tr><td>${learnLink(key(m),m.label)}</td><td class="n">${metricValue(m)}</td><td class="dim">${esc(m.period || m.asof || '')}</td><td class="dim">${source(m)}${m.note ? ' · ' + esc(m.note) : ''}</td></tr>`).join('')}</table>`;
    return bare ? table : `<details class="src"><summary>Inputs and sources</summary>${table}</details>`;
  }
  function setView(name) {
    doc.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.v === name));
  }
  // Bounded session back stack. Detaching actual DOM preserves controls, chart
  // instances and their internal zoom/crosshair state, including unsaved typing.
  const frames = new Map(); let frameId = null, frameSerial = 0;
  const persistentKeys = new Set(['core','brief','rel','relError','rowMap','company','metricEvidence']);
  function saveFrame() {
    if (!frameId || !$('#view').firstChild) return;
    const frame = {nodes:[...$('#view').childNodes], state:{}, y:root.scrollY, focus:doc.activeElement,
      watch:Object.fromEntries(['explore','company','research','index'].map(k=>[k,[...(Live._state.owners[k]||[])]]))};
    Object.keys(S).filter(k=>!persistentKeys.has(k)).forEach(k=>{frame.state[k]=S[k];});
    frames.delete(frameId);frames.set(frameId,frame);
    frame.nodes.forEach(n=>n.remove());
    while (frames.size>12) {
      const k=frames.keys().next().value, old=frames.get(k); frames.delete(k);
      ['chart','exChart','exRc'].forEach(c=>{try {old.state[c]?.remove();} catch(e) { console.warn('Discarded chart could not be released'); }});
    }
  }
  function backControl(main) {
    if (S.view==='brief') return;
    const el=doc.createElement('div');el.className='depth-nav';
    el.innerHTML='<button type="button" data-depth-back>← Back</button><a href="#/">Market brief</a><span class="dim"> / '+esc(S.view==='company' ? 'Company' : S.view==='sector' ? 'Sector' : S.view==='explore' ? 'Chart & drivers' : S.view)+'</span>';
    main.prepend(el);
    el.querySelector('button').onclick=()=>{if(root.history.state?.soParent)root.history.back();else root.location.hash='#/';};
  }
  function render() {
    const previous=frameId;
    saveFrame();
    frameId=root.history.state?.soFrame || 'depth-'+(++frameSerial);
    root.history.replaceState({...root.history.state,soFrame:frameId,soParent:root.history.state?.soParent || (previous!==frameId ? previous : null)},'');
    const cached=frames.get(frameId);
    if(cached) {
      frames.delete(frameId);
      Object.keys(S).filter(k=>!persistentKeys.has(k)).forEach(k=>{delete S[k];});Object.assign(S,cached.state);
      $('#view').replaceChildren(...cached.nodes);setView(S.view==='company'?'companies':S.view);
      Object.entries(cached.watch).forEach(([owner,names])=>Live.watch(owner,names));
      if(S.view==='explore')updateExploreQuotes();
      Live.paint(doc,null);paintSlots();
      requestAnimationFrame(()=>{root.dispatchEvent(new Event('resize'));cached.focus?.focus?.({preventScroll:true});root.scrollTo(0,cached.y);});
      return;
    }
    const r = route(root.location.hash);
    S.slots = []; S.onQuote = null; S.exToken = (S.exToken || 0) + 1; S.exChart=null;S.exRc=null;S.chart=null;S.exSeries=[];S.jointChart=null;S.jointBand=[];
    if (r.view !== 'explore') Live.watch('explore', []);
    S.view = r.view; setView(r.view === 'company' ? 'companies' : r.view);
    const main = $('#view');
    try {
      if (r.view === 'company') { main.innerHTML = '<p class="dim">Loading…</p>'; renderCompany(r.t, main); }
      else if (r.view === 'companies') renderCompanies(main);
      else if (r.view === 'macro') renderMacro(main);
      else if (r.view === 'explore') renderExplore(main, r.hash);
      else if (r.view === 'sector') renderSector(main,r.sector);
      else if (r.view === 'learn') renderLearn(main,r.label);
      else renderBrief(main, r.legacy);
    } catch (e) { main.innerHTML = `<p>This view could not be drawn from the published data. <a href="backup.html">Expanded dashboard (backup)</a></p>`; console.error(e); }
    Live.paint(doc, null);
    backControl(main);
    root.scrollTo(0, 0);
  }

  /* ------------------------------------------------------------ Market brief */
  function pulseSlot() {
    const b = Live.currentBrief(S.brief, Live.snapshot());
    const p = b.pulse || {}, notHead = x => (x.text || x.line) !== p.headline, sup = (p.supports || []).filter(notHead).slice(0, 3), ch = (p.challenges || []).filter(notHead).slice(0, 3);
    const item = x => `<li>${esc(x.text || x.line)}</li>`;
    return `<p class="lead">${esc(p.headline || 'Market summary unavailable.')}</p>
      <details class="more" data-more="pulse"><summary>${sup.length} support${sup.length === 1 ? '' : 's'}, ${ch.length} challenge${ch.length === 1 ? '' : 's'}${ch[0] ? ': ' + esc(ch[0].text || ch[0].line) : sup[0] ? ': ' + esc(sup[0].text || sup[0].line) : ''}</summary>
      <div class="two"><div><h4>Supports</h4><ul>${sup.map(item).join('') || '<li class="dim">None measured.</li>'}</ul></div>
      <div><h4>Challenges</h4><ul>${ch.map(item).join('') || '<li class="dim">None measured.</li>'}</ul></div></div></details>`;
  }
  function breadthSlot() {
    const lb = liveBreadth(S.core.rows, q), now = Date.now();
    const pending = lb.newest_session && lb.newest_session !== lb.session ? ` ${lb.newest_n} names already have ${lb.newest_session} prices, too few for an index-wide reading.` : '';
    if (!lb.complete) return `<span class="dim">No session has prices for at least 90% of the ${lb.members} members yet, so index-wide breadth is withheld.${esc(pending)}</span>`;
    const lead = lb.sectors[0], lag = lb.sectors[lb.sectors.length - 1];
    return `${lb.up} of ${lb.n} S&amp;P 500 names priced for the ${esc(lb.session)} session${lb.n === lb.members ? '' : ` (${lb.n} of ${lb.members} members)`} were up versus their previous close ${sessionWord(lb.newest, now)} (${lb.up_pct.toFixed(0)}%).` +
      (lead && lag && lead !== lag ? ` Cap-weighted, ${esc(lead.sector)} led (${pct(lead.chg)}) and ${esc(lag.sector)} trailed (${pct(lag.chg)}).` : '') + `<span class="dim">${esc(pending)}</span>`;
  }
  function heatSlot() {
    const H=root.SmartOptionsHeatmap, period=S.heatPeriod||'1D';
    if(!H)return '<p>Sector map unavailable: layout module missing.</p>';
    const map=H.sessionMap(S.core.rows,Live.snapshot().quotes,period,S.core.asof_session);
    const width=Math.max(320,Math.min(900,doc.documentElement.clientWidth-32)), height=width<600?250:250;
    const sectors=map.sectors.sort((a,b)=>b.mcap-a.mcap), rects=H.squarify(sectors.map(s=>s.mcap),0,0,width,height);
    return `<div class="market-map"><svg viewBox="0 0 ${width} ${height}" role="group" aria-label="Market-cap area sector heatmap">${sectors.map((s,i)=>{const r=rects[i];return `<a href="#/sector/${encodeURIComponent(s.sec)}" data-sector="${esc(s.sec)}" aria-label="${esc(s.sec)}, ${pct(s.pct)}, ${s.covered} of ${s.n} names"><rect x="${r.x+2}" y="${r.y+2}" width="${Math.max(0,r.w-4)}" height="${Math.max(0,r.h-4)}" rx="5" fill="${H.colorFor(s.pct,period)}"/><text x="${r.x+r.w/2}" y="${r.y+r.h/2-5}" font-size="${Math.min(17,Math.max(7,r.w/(s.sec.length*.57)))}">${esc(s.sec)}</text><text x="${r.x+r.w/2}" y="${r.y+r.h/2+14}" font-size="${Math.min(15,Math.max(9,r.w/6))}">${pct(s.pct)}</text><title>${esc(s.sec)} · ${H.fmtCap(s.mcap)} · covered ${s.covered}/${s.n}, ${(s.coverage*100).toFixed(1)}% of cap</title></a>`;}).join('')}</svg><details class="sector-access"><summary>${esc(period)} return to ${esc(map.session)} · ${map.covered}/${map.members} names · all sectors as a list, how to read the map</summary><div>${sectors.map(s=>`<a href="#/sector/${encodeURIComponent(s.sec)}" data-sector-link="${esc(s.sec)}">${esc(s.sec)} <b>${pct(s.pct)}</b></a>`).join('')}</div><p class="dim map-basis">Area = market value; color = covered cap-weighted return, grey = missing. Red loss / neutral zero / green gain; color saturates at ±${H.PERIODS[period].cap}%. Partial newer sessions are excluded. <a href="#/learn/Sector%20basket">Basket vs index</a></p></details></div>`;
  }
  function ideaSlot(t) {
    return () => { const r = row(t), cur = r && Live.currentRow(r); if (!cur) return ''; const lb = []; if (isNum(cur.pef)) lb.push('forward P/E ' + cur.pef.toFixed(1)); if (isNum(cur.pef_sec_rel)) lb.push(cur.pef_sec_rel.toFixed(2) + '× sector median'); return lb.length ? '<span class="dim">At this price: ' + lb.join(', ') + '.</span>' : ''; };
  }
  function upcoming(limit) {
    const today = new Date().toLocaleDateString('en-CA', {timeZone: 'America/New_York'});
    const big = new Set(S.core.rows.filter(r => r.sp500_member !== false && isNum(r.mcap)).sort((a, b) => b.mcap - a.mcap).slice(0, 60).map(r => r.t));
    return (S.brief.risks || []).filter(x => String(x.when_et || '').slice(0, 10) >= today)
      .filter(x => x.kind === 'macro' || (x.tickers || []).some(t => big.has(t)) || x.importance >= 3)
      .sort((a, b) => String(a.when_et).localeCompare(String(b.when_et)))
      .filter((x, i, xs) => x.kind === 'macro' ? xs.filter(y => y.kind === 'macro').indexOf(x) < Math.ceil(limit / 2) : xs.filter(y => y.kind !== 'macro').indexOf(x) < Math.floor(limit / 2));
  }
  function when(s) {
    const t = Date.parse(s); if (!isFinite(t)) return esc(s);
    const hasTime = /T\d/.test(s);
    return new Date(hasTime ? t : t + 12 * 3600e3).toLocaleString('en-US', Object.assign({timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric'}, hasTime ? {hour: 'numeric', minute: '2-digit'} : {})) + (hasTime ? ' ET' : '');
  }
  const FACTOR_SERIES = {us10y_bps: 'mac:us10y', wti: 'mac:wti', dxy: 'mac:dxy', vix: 'mac:vix'};
  const basketId = sector => S.rel && S.rel.baskets && S.rel.baskets[sector] ? 'sec:' + sector : null;
  // Highest and lowest sector baskets for a factor sentence, against the factor itself, standardized.
  function factorHref(r) {
    const ids = [r.high[0], r.low[0]].map(x => basketId(x.sector)).filter(Boolean);
    return W.encodeHash({s: ids.map(id => ({id})).concat([{id: FACTOR_SERIES[r.factor]}]), r: '1y', m: 'z'});
  }
  function companyHref(t, sector) { const ids = ['eq:' + t, 'eq:SPY', basketId(sector)].filter(Boolean); return W.encodeHash({s: ids.map(id => ({id})), r: '6m', m: 'index'}); }
  // The company's clearest macro link (largest |t| among rate, oil, dollar, VIX), charted against it.
  function factorLink(r) {
    const rel = r && r.rel; if (!rel || !rel.t) return '';
    const best = ['us10y_bps', 'wti', 'dxy', 'vix'].filter(f => isNum(rel.t[f]) && Math.abs(rel.t[f]) >= 2).sort((a, b) => Math.abs(rel.t[b]) - Math.abs(rel.t[a]))[0];
    if (!best) return '';
    return `<a class="go" href="${esc(W.encodeHash({s: [{id: 'eq:' + r.t}, {id: FACTOR_SERIES[best]}], r: '1y', m: 'z', ind: {rc: true}}))}">Chart ${esc(r.t)} against the ${esc(FACTORS[best].name)}</a>`;
  }
  const eventItem = e => `<li><span class="when">${when(e.when_et)}</span> <b>${esc(e.title)}</b> <span class="dim">${esc(e.why)}</span></li>`;
  function renderBrief(main, legacy) {
    const b = S.brief, pos = b.positioning || {}, short = (b.shortlist || []).slice(0, 3);
    Live.watch('index', ['SPY', 'RSP']); Live.watch('research', short.map(x => x.t)); Live.watch('company', []);
    const relNote = S.rel ? '' : `<p class="dim">Sector baskets and the relationship catalog are unavailable (${esc(S.relError || 'not loaded')}), so those drilldowns are withheld.</p>`;
    const rels = ['us10y_bps', 'wti', 'dxy'].map(f => factorSentence(S.core, f)).filter(Boolean);
    const events = upcoming(4);
    main.innerHTML = `
      ${legacy ? `<p class="note">That view is part of the expanded dashboard. <a href="backup.html${esc(legacy)}">Open it in the backup</a>.</p>` : ''}
      <section><h2>Market <span class="px">SPY ${liveSpan('SPY', 'price')} <span class="chg">${liveSpan('SPY', 'chg')}</span></span></h2>
        <small class="dim">${slot('market-session', () => q('SPY')?.market_hours === 2 ? 'After hours' : q('SPY')?.market_hours === 0 ? 'Pre-market' : '')}</small>
        ${slot('pulse', pulseSlot)}</section>
      <section><h2>Breadth and leadership</h2>
        <p>${slot('breadth', breadthSlot)}</p>
        <details class="more" data-more="positioning"><summary>At the ${esc(b.asof_session)} close: ${esc(pos.breadth && pos.breadth.line)}</summary><p class="dim">${esc(pos.concentration && pos.concentration.line)} ${esc(pos.rotation && pos.rotation.line)}</p><div class="insights">${insightCard(concentrationInsight(S.core.rel && S.core.rel.vol_breadth))}</div><p class="dim">${slot('live-conc', liveConcSlot)}</p>${relNote}</details>
        <div class="map-period" role="group" aria-label="Sector map period">${['1D','1W','1M'].map(p=>`<button data-map-period="${p}" aria-pressed="${(S.heatPeriod||'1D')===p}">${p}</button>`).join('')}</div>${slot('heat', heatSlot)}
        ${S.rel ? `<div class="insights">${insightCard(leadershipInsight(S.rel))}</div>` : ''}</section>
      <section><h2>Macro and sectors</h2>
        ${rels.slice(0,1).map(r => `<p>${esc(r.lead)}. <a class="go" href="${esc(factorHref(r))}">Related sectors & evidence →</a> <a href="#/macro">Macro detail</a></p>`).join('')}
        ${S.rel ? `<div class="insights">${insightCard(macroInsight(S.rel, S.core))}</div>` : ''}
</section>
      <div class="pair-row"><section><h2>Ahead</h2>
        <ul class="events compact">${events.slice(0, 2).map(e => `<li><span class="when">${when(e.when_et)}</span> <b>${esc(e.title)}</b></li>`).join('') || '<li class="dim">No scheduled releases in the published calendar.</li>'}</ul>
        ${events.length ? `<details class="more" data-more="events"><summary>Why these matter${events.length > 2 ? ` · ${events.length - 2} more: ${esc(events.slice(2).map(e => e.title).join(', '))}` : ''}</summary><ul class="events">${events.map(eventItem).join('')}</ul></details>` : ''}</section>
      <section><details class="ideas-more" data-more="ideas"><summary><b>Names to research:</b> ${slot('ideas-sum', () => short.map(x => { const cur = row(x.t) && Live.currentRow(row(x.t)); return esc(x.t) + (cur && isNum(cur.d1) ? ' ' + pct(cur.d1) : ''); }).join(' · '))} <span class="dim">· case, counterargument and comparison</span></summary>
        <p class="dim">Ranked by current fundamentals, trend and dated signals; a starting list for research, not a recommendation.</p>
        <div class="ideas">${short.map(x => `<article><h3><a href="#/company/${esc(x.t)}">${esc(x.t)}</a> <span class="dim">${esc(x.name)} · ${esc(x.sector)}</span>
          <span class="px">${liveSpan(x.t, 'price')} <span class="chg">${liveSpan(x.t, 'chg')}</span></span></h3>
          <p>${esc(x.why?.[0]?.text||'Inspect the dated company evidence.')}</p>
          <a class="go" href="${esc(companyHref(x.t, x.sector))}">Compare with SPY and ${esc(x.sector)}</a>
          <p>${slot('idea-' + x.t, ideaSlot(x.t))} <a href="#/company/${esc(x.t)}">Case & counterargument →</a></p></article>`).join('')}</div></details><p><a href="#/companies">Research all companies →</a></p></section></div>`;
  }

  function renderSector(main,sector) {
    const all=S.core.rows.filter(r=>r.sp500_member!==false && r.sec===sector);
    if(!all.length){main.innerHTML='<p>That sector is not in the current membership snapshot.</p>';return;}
    const H=root.SmartOptionsHeatmap, map=H.sessionMap(all,Live.snapshot().quotes,S.heatPeriod||'1D',S.core.asof_session), summary=map.sectors[0];
    const basket=basketId(sector);
    main.innerHTML=`<section><h2>${esc(sector)}</h2><p>${all.length} member companies · ${pct(summary.pct)} covered cap-weighted ${esc(map.period)} return to ${esc(map.session)}; ${summary.covered}/${summary.n} observations (${(summary.coverage*100).toFixed(1)}% of sector market value).</p><p>${learnLink('Sector basket','How weighting works')}</p>${basket?`<a class="go" href="${W.encodeHash({s:[{id:basket},{id:'eq:SPY'},{id:'mac:us10y'},{id:'mac:wti'}],m:'z',r:'1y'})}">Compare sector with SPY, rates & oil →</a>`:'<p>Sector history unavailable; individual company histories remain accessible.</p>'}</section><section><h2>Companies in ${esc(sector)}</h2><label for="sector-find">Filter companies</label><input type="search" id="sector-find" placeholder="Ticker or company"><label>Sort <select id="sector-sort"><option value="cap">Market value</option><option value="return">Return</option><option value="name">Name</option></select></label><table class="list"><tbody id="sector-rows"></tbody></table></section>`;
    const draw=()=>{
      const text=$('#sector-find').value.toLowerCase(), sort=$('#sector-sort').value;
      const hits=map.values.filter(r=>(r.t+' '+r.n).toLowerCase().includes(text)).sort((a,b)=>sort==='name'?a.n.localeCompare(b.n):sort==='return'?(b.value??-Infinity)-(a.value??-Infinity):b.mcap-a.mcap);
      Live.watch('company',hits.slice(0,24).map(r=>r.t));
      $('#sector-rows').innerHTML=hits.map(r=>`<tr><td><a href="#/company/${r.t}" data-sector-company="${r.t}"><b>${esc(r.t)}</b> ${esc(r.n)}</a></td><td class="n">${H.fmtCap(r.mcap)}</td><td class="n ${dir(r.value)}">${pct(r.value)}</td></tr>`).join('')||'<tr><td>No matching company in this sector.</td></tr>';
    };
    $('#sector-find').oninput=draw;$('#sector-sort').onchange=draw;draw();
  }

  const MEANINGS = [
    [/^Coverage$|Corporate.action basis/i,'This is an availability or accounting-basis check, not an investment score. A missing value means the required comparable observations were not supplied or verified. The evidence below gives the specific reason. Corporate actions can change the share, earnings or historical-price basis, so a plausible-looking comparison may be withheld until reconciled.'],
    [/earnings date/i,'The next expected company results date supplied by the provider. It is a schedule, not a guarantee or a financial estimate. Earnings can change expectations and option prices; verify the company calendar before making a time-sensitive decision.'],
    [/Brent|copper/i,'Brent is a global oil benchmark in US dollars per barrel; COMEX copper is an industrial metal future in US dollars per pound. These continuous front-month series are not roll-adjusted, so a contract change can affect returns. Stronger commodity prices can help producers and raise costs for users; they do not establish a single cause.'],
    [/Federal Reserve total|Reserve balances/i,'The Federal Reserve balance sheet records central-bank assets; reserve balances are banks’ deposits at the Fed. The source unit and dated observation are shown below. More reserves can ease funding conditions, but the balance sheet does not translate mechanically into stock gains; policy, demand and money-market operations also matter.'],
    [/Market value|market cap/i,'Market value (capitalization) is share price times shares outstanding, in US dollars; bn means billion and T means trillion. Larger companies occupy more map area. This is an equity valuation, not company revenue or cash in the bank. The map uses the dated snapshot weighting; live price movements do not imply a new share-count observation.'],
    [/^Price/, 'The price of one share in US dollars. A higher price raises market value and price-based valuation ratios when earnings and share count stay fixed. It does not itself mean the business improved.'],
    [/Daily return|% change|return/i,'Percentage gain or loss relative to the previous regular close: 100 × (price ÷ prior close − 1). After-hours moves have a separate basis. One percentage point is the difference between two percentage returns.'],
    [/Sector basket|index/i,'A sector groups companies with related businesses. The map weights by market value (price × shares); large companies occupy more area and influence its return more. Chart baskets equally average available member daily returns, rebased to 100. They are research baskets, not investable funds or official indices; membership changes and missing names matter.'],
    [/Correlation|co-movement/i,'Correlation describes how daily changes moved together, from −1 (opposite) through 0 (no linear link) to +1 (together). It has no units. A strong historical link can break and does not establish cause or a trading edge.'],
    [/Beta|Slope|sensitivity/i,'The slope is the fitted change in the selected asset, in percent, per one unit of a driver. Rate moves use basis points; oil uses percent. A joint slope holds the other driver fixed. Direction matters: swapping the asset and driver does not invert the slope.'],
    [/Scenario|confidence|variation|interval/i,'A what-if applies a dated joint regression to chosen economic changes. The average includes the intercept and both slopes, with covariance cross terms. A 95% confidence band describes uncertainty in that fitted average; a wider individual-day band includes residual market noise. Neither is a forecast or a promised range.'],
    [/P\/E|valuation|earnings yield/i,'Price/earnings divides share price by earnings per share. Trailing uses past earnings; forward uses analyst estimates. A larger multiple means paying more for each unit of earnings, which may reflect growth expectations or overvaluation. Sector comparisons help, but different accounting and earnings bases limit them.'],
    [/rate|yield|Treasury|basis point|spread|policy|SOFR/i,'A yield is an annual percentage rate; one basis point is 0.01 percentage point. A +10 bp move takes 4.00% to 4.10%. Higher rates can raise financing costs and lower present values; sector exposure and growth expectations can offset that association. A spread is the difference between two rates.'],
    [/Revenue|growth|EPS/i,'Revenue is sales before costs; EPS is earnings per share after costs. Year-over-year growth compares the same reporting quarter a year apart. Higher growth may support earnings, but margins, dilution and one-off items matter. Nonpositive prior earnings can make percentage growth misleading or unavailable.'],
    [/margin|profit|Return on/i,'Margin measures profit as a share of revenue; return on equity/assets measures profit relative to invested book capital. Higher values often indicate efficiency. Financial firms and REITs need different measures; debt, accounting changes and negative book equity can distort comparisons.'],
    [/cash|FCF/i,'Free cash flow is operating cash generated less capital expenditure. Conversion compares matched-period free cash flow with earnings. Strong conversion supports financing and distributions; negative cash flow can reflect either investment or operating strain. Currency and reporting periods must match.'],
    [/debt|liabilit|EBIT|coverage|resilience|Current assets/i,'These ratios compare debt or obligations with equity, cash earnings or liquid assets. Lower debt multiples and higher liquidity/interest coverage usually indicate more room to meet obligations. EBITDA excludes interest, tax, depreciation and amortization; it is not spendable cash. Sector and matched periods matter.'],
    [/revision|estimate|target/i,'Analyst estimates are opinions about future results. Revisions count upgrades and downgrades over a dated window, not changes implied by P/E ratios. Targets can change abruptly and are not guaranteed returns.'],
    [/WTI|oil|crude/i,'WTI is a benchmark for US crude oil, quoted in US dollars per barrel. The chart uses front-month futures, whose contract roll can affect measured moves. Higher oil can support producers while raising costs for consumers and transport companies.'],
    [/dollar|DXY/i,'DXY measures the US dollar against a currency basket in index points. A stronger dollar can change translated overseas revenue and commodity prices; company hedging and costs complicate the effect.'],
    [/VIX|volatility/i,'VIX measures option-implied variation in the S&P 500 over roughly 30 days, in annualized percentage points. Higher readings mean more expected variation, not a guaranteed price decline.'],
    [/inflation|CPI|PCE|PPI/i,'These price measures track consumer or producer costs. Year-over-year compares with the same month last year; month-over-month compares adjacent months. Higher inflation can pressure purchasing power and affect rate decisions, but the mix and expectations matter.'],
    [/labor|payroll|employment|claims|participation/i,'Labor measures track jobs, joblessness or new benefit claims. Jobs/payrolls use counts, unemployment uses a percent of the labor force. Stronger employment can support demand but influence inflation and policy. Reference month is not the publication date.'],
    [/GDP|growth|production/i,'GDP measures economic output. Real growth removes inflation; an annualized quarterly rate extrapolates one quarter. It does not mean that rate actually occurred over a full year. Revisions and publication lags limit timely interpretation.'],
    [/average|52.week|trend/i,'A moving average smooths past regular-session prices; the 52-week range spans retained low and high prices. Price above an average describes a trend, not a forecast. Corporate actions and missing history can make comparisons unavailable.'],
    [/R²|R2|fit/i,'R² is the share of sample variation explained by this fitted relationship, between 0 and 1 for an intercept fit. A high in-sample score does not prove future accuracy. The chronological check evaluates later historical observations against a simple baseline.']
  ];
  function renderLearn(main,label) {
    const ticker=(label.split(' · ')[1]||''), r=row(ticker), m=S.metricEvidence?.get(label);
    const definition=MEANINGS.find(([re])=>re.test(label));
    main.innerHTML=`<section class="lesson"><p class="eyebrow">Understand this number</p><h2>${esc(label)}</h2>${r?`<p><a href="#/company/${ticker}">${esc(ticker)} — ${esc(r.n)}</a> · <a href="#/sector/${encodeURIComponent(r.sec)}">${esc(r.sec)}</a></p>`:''}<p class="lead">${esc(definition?definition[1]:'This provider-specific observation is shown with its original unit and reporting period below. Higher or lower alone does not establish a better investment; compare the relevant company, sector and historical period.')}</p>${m?`<h3>Measured evidence</h3><p>${metricValue(m)} · ${esc(m.unit)} · reporting period ${esc(m.period)} · observed ${esc(m.asof||'unavailable')}</p><p>${esc(m.note)}</p><p>${source(m)}</p>`:r?`<p>${sessionNote(ticker)} ${liveSpan(ticker,'price')} ${liveSpan(ticker,'chg')}</p>`:'<p class="dim">Definition only on this direct link. Open the metric from a company or macro view to retain its measured value, source and date.</p>'}<p><a class="go" href="${r?companyHref(ticker,r.sec):'#/explore'}">Explore the measured relationship →</a></p></section>`;
  }

  /* ------------------------------------------------------------ Companies */
  function renderCompanies(main) {
    const all = S.core.rows.filter(r => r.sp500_member !== false).sort((a, b) => (b.mcap || 0) - (a.mcap || 0));
    main.innerHTML = `<section><h2>Companies</h2>
      <input id="find" type="search" placeholder="Ticker or company name" autocomplete="off" spellcheck="false" aria-label="Find a company">
      <table class="list"><tbody id="rows"></tbody></table></section>`;
    const draw = () => {
      const s = $('#find').value.trim().toUpperCase();
      const hits = (s ? all.filter(r => r.t.startsWith(s.replace('.', '-')) || String(r.n).toUpperCase().includes(s)) : all).slice(0, 40);
      Live.watch('company', hits.slice(0, 24).map(r => r.t));
      $('#rows').innerHTML = hits.map(r => `<tr><td><a href="#/company/${esc(r.t)}"><b>${esc(r.t)}</b></a></td><td>${esc(r.n)}<div class="dim">${esc(r.sec)}</div></td>
        <td class="n">${liveSpan(r.t, 'price')}</td><td class="n chg">${liveSpan(r.t, 'chg')}</td></tr>`).join('') || '<tr><td class="dim">No match.</td></tr>';
      Live.paint(doc, null);
    };
    $('#find').addEventListener('input', draw); draw();
  }

  /* ------------------------------------------------------------ Company */
  function techSlot(t, tech) {
    return () => {
      const ms = tech && tech.metrics || [], a50 = (ms.find(m => m.label === '50-session average') || {}).value, a200 = (ms.find(m => m.label === '200-session average') || {}).value;
      const cur = Live.currentRow(row(t)) || {}, va = vsAverages(cur.px, a50, a200);
      if (!va) return 'Current price unavailable; technical comparison withheld.';
      const parts = [];
      if (isNum(va.v50)) parts.push(`${pct(va.v50, 1)} versus its 50-session average (${px(a50)})`);
      if (isNum(va.v200)) parts.push(`${pct(va.v200, 1)} versus its 200-session average (${px(a200)})`);
      const r = row(t), lo = r && isNum(r.lo) ? Math.min(r.lo, cur.px) : null, hi = r && isNum(r.hi) ? Math.max(r.hi, cur.px) : null;
      const rng = isNum(lo) && isNum(hi) && hi > lo ? ` It sits at ${Math.round(100 * (cur.px - lo) / (hi - lo))}% of its 52-week range (${px(lo)} to ${px(hi)}).` : '';
      return `At ${px(cur.px)} the stock is ${listJoin(parts)}.${rng}`;
    };
  }
  function valSlot(t, card) {
    const m = l => ((card && card.metrics) || []).find(x => x.label === l) || {};
    return () => {
      const r = row(t), cur = r && Live.currentRow(r);
      let txt = valuationText(cur, m('Trailing P/E / sector median').value, m('Sector trailing P/E median').value, r && r.pef_sec_med, m('Sector trailing P/E median').period || (r && r.pxd) || 'the last');
      if (cur && isNum(cur.mcap) && isNum(cur.px)) txt += ` Market value $${big(cur.mcap)}.`;
      return esc(txt);
    };
  }
  // Closed-row summaries: the same canonical current-price numbers, in one short line; the full sentence is inside.
  function valShort(t, card) {
    const m = l => ((card && card.metrics) || []).find(x => x.label === l) || {};
    return () => {
      const r = row(t), cur = r && Live.currentRow(r), st = m('Sector trailing P/E median').value;
      if (!cur || !isNum(cur.px) || !isNum(cur.pe)) return 'Current price unavailable; valuation comparison withheld.';
      const parts = [`trailing P/E ${cur.pe.toFixed(1)}` + (isNum(st) && st > 0 ? ` (${(cur.pe / st).toFixed(2)}× sector)` : '')];
      if (isNum(cur.pef)) parts.push(`forward ${cur.pef.toFixed(1)}` + (isNum(r.pef_sec_med) && r.pef_sec_med > 0 ? ` (${(cur.pef / r.pef_sec_med).toFixed(2)}× sector)` : ''));
      return esc(`At ${px(cur.px)}: ${parts.join(', ')}`);
    };
  }
  function techShort(t, tech) {
    return () => {
      const ms = tech && tech.metrics || [], a50 = (ms.find(m => m.label === '50-session average') || {}).value, a200 = (ms.find(m => m.label === '200-session average') || {}).value;
      const cur = Live.currentRow(row(t)) || {}, va = vsAverages(cur.px, a50, a200);
      if (!va) return 'Current price unavailable; trend comparison withheld.';
      return [isNum(va.v50) ? `${pct(va.v50, 1)} vs 50-session average` : '', isNum(va.v200) ? `${pct(va.v200, 1)} vs 200-session` : ''].filter(Boolean).join(', ');
    };
  }
  function relShort(r) {
    const rel = r && r.rel; if (!rel || !rel.c || !(rel.n >= 120)) return 'unavailable (fewer than 120 common sessions).';
    const clear = ['us10y_bps', 'wti', 'dxy', 'vix'].filter(f => isNum(rel.c[f]) && isNum(rel.t && rel.t[f]) && Math.abs(rel.t[f]) >= 2);
    return (isNum(rel.c.spy) ? `${rel.c.spy.toFixed(2)}% per 1% SPY move` : 'market link unavailable') + (clear.length ? `; clear link to ${listJoin(clear.map(f => FACTORS[f].name))}` : '; no clear rate, oil, dollar or VIX link');
  }
  function relSentence(r, card) {
    const rel = r && r.rel; if (!rel || !rel.c || !(rel.n >= 120)) return 'Macro relationships are unavailable for this name (fewer than 120 common sessions).';
    const out = [];
    if (isNum(rel.c.spy)) out.push(`tended to move ${rel.c.spy.toFixed(2)}% per 1% SPY move`);
    ['us10y_bps', 'wti', 'dxy', 'vix'].forEach(f => { const c = rel.c[f], tt = rel.t && rel.t[f]; if (isNum(c) && isNum(tt) && Math.abs(tt) >= 2) out.push(`${pct(c * FACTORS[f].scale, 2)} per ${FACTORS[f].per} in the ${FACTORS[f].name}`); });
    let s = `Over ${rel.n} sessions ${r.t} ${listJoin(out)}` + (out.length < 2 ? ' with no statistically clear rate, oil, dollar or VIX link' : '') + ` (R² ${isNum(rel.r2) ? rel.r2.toFixed(2) : 'n/a'}).`;
    const a = r.att;
    if (a && isNum(a.actual_20d) && isNum(a.explained_20d)) s += ` Over the 20 sessions to ${esc(a.date)} the stock moved ${pct(a.actual_20d, 1)}; the model's fitted factor moves sum to ${pct(a.explained_20d, 1)}, leaving ${pct(a.resid_20d, 1)} not explained by these factors.`;
    const lev = card && (card.metrics || []).find(m => m.label === 'Net debt / EBITDA');
    if (isNum(rel.c.us10y_bps) && Math.abs((rel.t || {}).us10y_bps || 0) >= 2 && lev && isNum(lev.value)) s += ` Net debt is ${lev.value.toFixed(2)}× EBITDA (${esc(lev.period)}), relevant to that rate sensitivity.`;
    return s;
  }
  const CARD_TITLES = {growth: 'Growth', profitability: 'Margins', cash: 'Cash flow', resilience: 'Balance sheet', valuation: 'Valuation', expectations: 'Estimate revisions'};
  async function renderCompany(t, main) {
    Live.watch('company', [t]); Live.watch('research', []); Live.watch('index', ['SPY']);
    const r = row(t);
    if (!r) { main.innerHTML = `<p>${esc(t)} is not in the published S&amp;P 500 data. <a href="#/companies">Find a company</a></p>`; return; }
    let c = null, bars = null;
    try { c = await json(`data/brief/company/${encodeURIComponent(t)}.json`); } catch (e) { c = null; }
    try { bars = (await json(`data/px/${encodeURIComponent(t)}.json`)).bars; } catch (e) { bars = null; }
    if (route(root.location.hash).t !== t) return;   // reader moved on
    const cards = c && c.cards || {}, ev = c && c.events || {};
    main.innerHTML = `
      <section class="co"><h2>${esc(r.n)} <span class="dim">${esc(t)} · ${esc(r.sec)}</span></h2>
        <div class="quote"><span class="big">${liveSpan(t, 'price')}</span> <span class="chg">${liveSpan(t, 'chg')}</span> ${slot('session', () => sessionNote(t))}</div>
        <p>${slot('ctx', () => esc(Live.currentContext(t, Live.snapshot())))}</p>
        ${c && c.summary && cards.growth && c.summary === cards.growth.line ? '' : `<p class="lead">${esc(c && c.summary || 'Company detail is unavailable in the published data.')}</p>`}</section>
      <section><h2>Fundamentals</h2><div class="cards">
        ${Object.keys(CARD_TITLES).map(k => cards[k] ? `<details class="card frow" data-card="${k}"><summary><b>${CARD_TITLES[k]}</b> <span class="st" data-status="${esc(cards[k].status || '')}">${esc(cards[k].status || '')}</span> ${k === 'valuation' ? slot('val-sum', valShort(t, cards.valuation)) : esc(cards[k].line)}</summary>${k === 'valuation' ? `<p>${slot('val', valSlot(t, cards.valuation))}</p>` : ''}${metricTable(cards[k].metrics, true)}</details>` : '').join('')}
      </div>
      <p class="counter"><b>Strongest counterargument:</b> ${slot('ctr', () => esc(counterpoint(cards.counter && cards.counter.line, Live.currentRow(r), r.er, Date.now())))}</p></section>
      <section class="co-more"><details class="more co-chart" data-more="chart"><summary><b>Price and trend:</b> ${slot('tech-sum', techShort(t, c && c.technical))}</summary><p>${slot('tech', techSlot(t, c && c.technical))}</p><div id="chart" class="chart"></div><p><a class="go" href="${esc(companyHref(t, r.sec))}">Compare ${esc(t)} with SPY and the ${esc(r.sec)} basket</a></p></details>
        <details class="more co-macro" data-more="macro"><summary><b>Macro relationship:</b> ${esc(relShort(r))}</summary><p>${esc(relSentence(r, cards.resilience))}</p><p class="dim">Historical association, not a forecast. ${factorLink(r)}</p></details>
        <details class="more co-events" data-more="events"><summary><b>Events:</b> ${esc(ev.line || 'No dated events in the published data.')}</summary>
        ${(ev.items || []).length ? `<ul class="events">${ev.items.map(e => `<li><span class="when">${when(e.when_et)}</span> ${esc(e.title)}</li>`).join('')}</ul>` : '<p class="dim">No further dated items.</p>'}</details>
      ${c && c.options && c.options.line ? `<details class="more co-options" data-more="options"><summary><b>Options:</b> ${esc(c.options.line)}</summary><p class="dim">No option prices are modelled here; check the live chain, spreads and the event dates above.</p></details>` : ''}</section>`;
    paintSlots(); Live.paint(doc, null);
    // The chart is created when its disclosure first opens, so it is sized to a visible container.
    const chartBox = main.querySelector('details.co-chart');
    if (chartBox) chartBox.addEventListener('toggle', () => { if (chartBox.open && !S.chart) drawChart(bars); });
    backControl(main);
  }
  function sessionNote(t) {
    const x = q(t); if (!x) return '';
    const label = Live.etLabel(x.asof_utc || x.ts, Date.now());
    const sess = x.market_hours === 2 ? 'after-hours trade, ' : x.market_hours === 0 ? 'pre-market trade, ' : '';
    const delay = x.delay_minutes > 0 ? ', delayed about ' + x.delay_minutes + ' min' : '';
    return `<span class="dim">${esc(sess + label + delay)}</span>`;
  }
  function drawChart(bars) {
    const el = $('#chart'); if (!el) return;
    if (!Array.isArray(bars) || !bars.length || !root.LightweightCharts) { el.innerHTML = '<p class="dim">Price history unavailable.</p>'; el.classList.remove('chart'); return; }
    const dark = root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)').matches;
    const chart = root.LightweightCharts.createChart(el, {height: 240, autoSize: true, layout: {background: {color: 'transparent'}, textColor: dark ? '#b8bcc4' : '#555'},
      grid: {vertLines: {visible: false}, horzLines: {color: dark ? '#2a2d33' : '#eee'}}, rightPriceScale: {borderVisible: false}, timeScale: {borderVisible: false}, handleScroll: false, handleScale: false});
    const line = chart.addLineSeries ? chart.addLineSeries({color: dark ? '#8ab4f8' : '#1a56b0', lineWidth: 2, priceLineVisible: false}) : chart.addSeries(root.LightweightCharts.LineSeries, {color: '#1a56b0', lineWidth: 2});
    line.setData(bars.filter(b => isNum(b[4])).map(b => ({time: b[0], value: b[4]})));
    chart.timeScale().fitContent(); S.chart = chart;
  }

  /* ------------------------------------------------------------ Macro */
  const GROUPS = {policy: 'Policy rate', inflation: 'Inflation', labor: 'Labor', growth: 'Growth', curve: 'Treasury curve', credit_funding: 'Credit and funding', cross_asset: 'Dollar and commodities', volatility: 'Volatility'};
  function macroValue(x) { if (!isNum(x.v)) return 'n/a'; const u = x.unit || ''; return (Math.abs(x.v) >= 1e5 ? big(x.v) : +x.v.toFixed(2)) + (u ? ' ' + esc(u) : ''); }
  function renderMacro(main) {
    Live.watch('research', []); Live.watch('company', []); Live.watch('index', ['SPY']);
    const bd = S.brief.macro && S.brief.macro.backdrop || {}, risk = S.brief.macro && S.brief.macro.risk || {};
    const rels = Object.keys(FACTORS).map(f => factorSentence(S.core, f)).filter(Boolean);
    const cal = (S.core.calendar || []).filter(x => x.status !== 'released').sort((a, b) => String(a.scheduled_et).localeCompare(String(b.scheduled_et))).slice(0, 12);
    S.metricEvidence ||= new Map();for(const group of Object.values(S.core.macro||{}))for(const x of group){S.metricEvidence.set(x.label,{label:x.label,value:x.v,unit:x.unit,period:x.period,asof:x.retrieved_at,source:x.provider,source_url:x.url,note:x.note||'Observation date '+x.date+'; reference period is not the release timestamp.'});}
    main.innerHTML = `
      <section><h2>Macro backdrop</h2><ul>${['growth', 'inflation', 'policy'].filter(k => bd[k] && bd[k].line).map(k => `<li><b>${GROUPS[k] || k}:</b> ${esc(bd[k].line)}</li>`).join('')}
        ${risk.line ? `<li><b>Credit:</b> ${esc(risk.line)}</li>` : ''}</ul></section>
      <section><h2>How sectors have moved with macro</h2>${rels.map(r => `<p>${esc(r.text)} <a class="go" href="${esc(factorHref(r))}">Chart it</a></p>`).join('')}
        ${S.rel ? `<div class="insights">${insightCard(macroInsight(S.rel, S.core))}</div>` : ''}
        <details class="src"><summary>Sector medians by factor</summary>${rels.map(r => { const s = sectorSensitivity(S.core.rows, r.factor); return `<h4>${esc(FACTORS[r.factor].name)} (per ${FACTORS[r.factor].per})</h4><table>${s.map(x => `<tr><td>${esc(x.sector)}</td><td class="n">${pct(x.coef * FACTORS[r.factor].scale, 2)}</td><td class="dim">${x.n} names</td></tr>`).join('')}</table>`; }).join('')}
        <p class="dim">${esc(S.core.rel && S.core.rel.window)}; per-stock OLS of daily returns on SPY, 10-year yield, DXY, WTI and VIX changes; sector value is the median coefficient. Associations, not causes or forecasts.</p></details></section>
      <section><h2>Upcoming releases</h2><ul class="events">${cal.map(x => `<li><span class="when">${when(x.scheduled_et)}</span> ${esc(x.title)}</li>`).join('') || '<li class="dim">No scheduled releases in the published calendar.</li>'}</ul></section>
      <section><h2>Latest readings</h2>${Object.keys(GROUPS).filter(g => (S.core.macro[g] || []).length).map(g => `<details class="src"${g === 'policy' || g === 'inflation' ? ' open' : ''}><summary>${GROUPS[g]}</summary><table>
        ${S.core.macro[g].filter(x => !/_ret_1d|_ret_5d|_mom$/.test(x.id)).map(x => `<tr><td>${learnLink(x.label)}</td><td class="n">${macroValue(x)}</td><td class="dim">prior ${isNum(x.prior) ? +x.prior.toFixed(2) : 'n/a'}</td><td class="dim">${esc(x.period)}</td><td class="dim">${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.provider)}</a>` : esc(x.provider)} · <a href="${W.encodeHash({s:[{id:'eq:SPY'},{id:'mac:'+x.id}],m:'z',r:'1y'})}">Compare history</a></td></tr>`).join('')}</table></details>`).join('')}</section>`;
  }

  /* ------------------------------------------------------------ Insight cards (brief, macro, company) */
  function insightCard(x) {
    if (!x) return '';
    if(S.view==='brief')return `<article class="ins" data-insight="${esc(x.id)}"><p class="q">${esc(x.q)}</p><a class="go" href="${esc(x.href)}">${esc(x.action)} →</a></article>`;
    return `<article class="ins" data-insight="${esc(x.id)}"><p class="q">${esc(x.q)}</p><p>${esc(x.meaning)}</p>
      <p class="dim"><b>Challenge:</b> ${esc(x.challenge)}</p><a class="go" href="${esc(x.href)}">${esc(x.action)} →</a></article>`;
  }
  function liveConcSlot() {
    const c = liveConcentration(q('RSP'), q('SPY'));
    if (!c) return '<span class="dim">Today’s equal- versus cap-weight comparison is withheld until RSP and SPY have usable prices from the same session.</span>';
    return `For the ${esc(c.session)} session at current prices, RSP is ${pct(c.rsp)} and SPY ${pct(c.spy)} versus their previous closes (${pp(c.gap)}).`;
  }

  /* ------------------------------------------------------------ Explore */
  const PALETTE = ['#1a56b0', '#d2691e', '#2e8b57', '#8e44ad', '#c0392b', '#5f6b76'];
  const PALETTE_DARK = ['#8ab4f8', '#f6a868', '#7bd389', '#c79bf2', '#f28b82', '#c4c9d0'];
  const DEFAULT_STATE = {s: [{id: 'eq:SPY'}, {id: 'eq:RSP'}, {id: 'sec:Information Technology'}], r: '1y', m: 'index', ind: {sma: false, rc: false}, lag: 0};
  const MACRO_KIND = {us10y: ['rate', 'diff_bp', 'bp'], us2y: ['rate', 'diff_bp', 'bp'], us3m: ['rate', 'diff_bp', 'bp'], dxy: ['price', 'ret', '%'], wti: ['price', 'ret', '%'], brent: ['price', 'ret', '%'], copper: ['price', 'ret', '%']};
  function macroMeta(x) {
    const k = MACRO_KIND[x.id] || (x.unit === '%' || /% /.test(x.unit || '') ? ['rate', 'diff_bp', 'bp'] : x.unit === 'bps' ? ['rate', 'diff', 'bp'] : ['level', 'diff', x.unit || 'units']);
    return {kind: k[0], chg: k[1], cunit: k[2]};
  }
  // Every addable series with its unit and source type; histories load on demand.
  function seriesIndex() {
    if (S.exIndex) return S.exIndex;
    const out = [];
    const etf = {SPY: 'SPDR S&P 500 ETF', RSP: 'Invesco S&P 500 Equal Weight ETF'};
    Object.entries(etf).forEach(([t, n]) => out.push({id: 'eq:' + t, label: t, sub: `${n} · ETF, USD, daily close · Yahoo`, kind: 'price', chg: 'ret', unit: 'USD', cunit: '%', group: 'ETFs', name: n, freq: 'daily'}));
    S.core.rows.filter(r => r.sp500_member !== false).sort((a, b) => (b.mcap || 0) - (a.mcap || 0)).forEach(r => out.push({id: 'eq:' + r.t, label: r.t, sub: `${r.n} · stock, USD, daily close · Yahoo`, kind: 'price', chg: 'ret', unit: 'USD', cunit: '%', group: 'Companies', name: r.n, freq: 'daily'}));
    Object.values(S.rel && S.rel.baskets || {}).forEach(b => out.push({id: b.id, label: b.label.replace(/ \(equal weight\)$/, ''), sub: `sector basket, equal weight of ${b.members} members, index = 100 · derived from Yahoo closes, not an ETF`, kind: 'basket', chg: 'ret', unit: 'index', cunit: '%', group: 'Sector baskets', freq: 'daily'}));
    Object.values(S.core.macro || {}).forEach(g => (g || []).forEach(x => {
      if (!Array.isArray(x.h) || x.h.length < 12 || /_ret_\d+d$|_bps_chg$/.test(x.id)) return;
      const m = macroMeta(x), f = W.frequency(x.h.map(p => [String(p[0]).slice(0, 10), p[1]]));
      const short = S.rel && S.rel.macro && S.rel.macro[x.id] && S.rel.macro[x.id].label;   // short catalog name; the full provider label stays visible
      out.push(Object.assign({id: 'mac:' + x.id, label: short || x.label, sub: `${short ? x.label + ', ' : ''}${x.unit || 'units'}, ${f} · ${x.provider || 'source'}`, unit: x.unit || '', group: 'Macro and markets', freq: f}, m));
    }));
    return (S.exIndex = out);
  }
  const metaOf = id => seriesIndex().find(x => x.id === id) || null;
  async function loadSeries(id) {
    S.exData ||= {};
    if (S.exData[id]) return S.exData[id];
    const m = metaOf(id); if (!m) throw new Error('not in the published data');
    let h = null;
    if (id.startsWith('eq:')) { const d = await json(`data/px/${encodeURIComponent(id.slice(3))}.json`); h = (d.bars || []).filter(b => isNum(b[4]) && b[4] > 0).map(b => [b[0], b[4]]); }
    else if (id.startsWith('sec:')) { const b = Object.values(S.rel.baskets).find(x => x.id === id); h = b ? b.h.map(p => [p[0], p[1]]) : null; }
    else { for (const g of Object.values(S.core.macro)) for (const x of g || []) if ('mac:' + x.id === id) h = x.h.filter(p => isNum(p[1])).map(p => [String(p[0]).slice(0, 10), p[1]]); }
    if (!h || !h.length) throw new Error('no published history');
    return (S.exData[id] = {h});
  }
  function readStore() {
    let raw = null; try { raw = root.localStorage.getItem(W.STORE_KEY); } catch (e) { return {store: {v: 1, current: null, presets: []}, error: 'Device storage is unavailable; presets will not be kept.'}; }
    const r = W.parseStore(raw);
    return r.ok ? {store: r.store} : {store: {v: 1, current: null, presets: []}, error: r.reason, raw};
  }
  function writeStore(store) { if (S.exStoreBlocked) return; try { root.localStorage.setItem(W.STORE_KEY, W.serializeStore(store)); } catch (e) { exNote('Could not save to device storage: ' + e.message); } }
  function renderExplore(main, hash) {
    const st = readStore();
    S.exStore = st.store; S.exStoreBlocked = st.raw != null;
    let state = hash ? W.decodeHash(hash) : null, note = st.error ? `${st.error} The saved text is untouched until you choose. ` : '';
    if (state && state.error) { note += `This link could not be used (${state.error}); showing your last workspace. `; state = null; }
    if (!state || !state.s.length) state = S.exStore.current || W.cleanState(DEFAULT_STATE);
    S.ex = {state: W.cleanState(state), cursorDate: null};
    S.exStore.current = S.ex.state; writeStore(S.exStore);   // a followed link becomes the last workspace (skipped while unreadable data is kept)
    Live.watch('research', []); Live.watch('company', []); Live.watch('index', ['SPY']);
    main.innerHTML = `<section class="ex"><h2>Explore</h2>
      <p class="dim">Compare up to six companies, ETFs, sector baskets and macro series. Display transforms never change the statistics, which use aligned daily changes. Relationships are historical associations, not forecasts.</p>
      <div id="ex-note-wrap"><p id="ex-note" class="note" role="status"${note ? '' : ' hidden'}>${esc(note)}</p>${S.exStoreBlocked ? '<p class="ex-ctl" id="ex-recover"><button type="button" data-ex="clear-store">Replace unreadable saved data</button> <button type="button" data-ex="keep-store">Keep it for now</button></p>' : ''}</div>
      <details class="chart-controls"><summary>Comparisons & chart controls</summary><div id="ex-series" class="ex-series" aria-label="Selected series"></div>
      <div class="ex-add"><label for="ex-find">Add a series <span class="dim">(up to ${W.MAX_SERIES})</span></label><input id="ex-find" type="search" autocomplete="off" spellcheck="false" placeholder="Ticker, company, sector basket or macro series" aria-controls="ex-hits"><ul id="ex-hits" class="ex-hits" role="listbox" hidden></ul></div>
      <div class="ex-ctl">
        <div role="group" aria-label="Range" class="ex-range">${Object.keys(W.RANGES).map(k => `<button type="button" data-range="${k}">${k === 'all' ? 'All' : k.toUpperCase()}</button>`).join('')}</div>
        <label>From <input type="date" id="ex-from"></label><label>To <input type="date" id="ex-to"></label>
        <label>View <select id="ex-mode">${Object.entries(W.MODES).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
      </div>
      <div class="ex-ctl">
        <label><input type="checkbox" id="ex-sma"> 50-session average (first series)</label>
        <label><input type="checkbox" id="ex-rc"> Rolling 60-session correlation (first two)</label>
        <label>Statistical lag <select id="ex-lag">${[0, 1, 2, 3, 4, 5].map(k => `<option value="${k}">${k ? k + ' session' + (k > 1 ? 's' : '') : 'none'}</option>`).join('')}</select></label>
        <button type="button" data-ex="reset">Reset view</button>
      </div>
      </details><p id="ex-desc" class="dim"></p>
      <div id="ex-chart" class="ex-chart" tabindex="0" role="img" aria-label="Comparison chart. Use the left and right arrow keys to step through dates."></div>
      <div id="ex-read" class="ex-read" aria-live="polite"></div>
      <div id="ex-joint"></div>
      <div id="ex-rc-chart" class="ex-rcc" hidden></div>
      <h3>Now</h3><p id="ex-now"></p>
      <details class="pair-depth"><summary>How these moved together · ${learnLink('Correlation')} · ${learnLink('Beta','slope')}</summary><div id="ex-rel"></div></details>
      <details class="preset-depth"><summary>Save or share this comparison</summary><div class="ex-ctl ex-presets"><label>Preset name <input id="ex-pname" type="text" maxlength="40" placeholder="My comparison"></label><button type="button" data-ex="save">Save preset</button>
        <label>Saved <select id="ex-presets"><option value="">Choose a preset</option></select></label><button type="button" data-ex="del-preset">Remove preset</button><button type="button" data-ex="link">Copy link</button></div></details>
    </section>`;
    bindExplore(main);
    // Quotes for charted companies/ETFs update data, numbers and sentences in place; controls and charts persist.
    S.onQuote = changed => {
      if (S.view !== 'explore') return;
      const mine = S.ex.state.s.filter(x => x.id.startsWith('eq:') && changed.has(x.id.slice(3)));
      if (!mine.length) return;
      const sig = mine.map(x => { const d = S.exData && S.exData[x.id]; return d ? JSON.stringify(effective(x.id, d.h).live) : ''; }).join('|');
      if (sig === S.exLiveSig) return;
      S.exLiveSig = sig; updateExploreQuotes();
    };
    drawExplore(true);
  }
  function exSet(mut, opts) {
    const s = JSON.parse(JSON.stringify(S.ex.state)); mut(s);
    try { S.ex.state = W.cleanState(s); } catch (e) { exNote(e.message); return; }
    S.exStore.current = S.ex.state; writeStore(S.exStore);
    const h = W.encodeHash(S.ex.state); if (root.location.hash !== h) root.history.replaceState(root.history.state, '', h);   // replaceState fires no hashchange
    drawExplore(!(opts && opts.keepView));
  }
  function exNote(t) { const el = $('#ex-note'); if (!el) return; el.hidden = !t; el.textContent = t || ''; }
  function bindExplore(main) {
    const find = $('#ex-find'), hits = $('#ex-hits');
    const showHits = () => {
      const s = find.value.trim().toLowerCase(); if (!s) { hits.hidden = true; hits.innerHTML = ''; return; }
      const have = new Set(S.ex.state.s.map(x => x.id)), score = x => x.label.toLowerCase() === s ? 0 : x.label.toLowerCase().startsWith(s) ? 1 : 2;
      const xs = seriesIndex().filter(x => !have.has(x.id) && (x.label.toLowerCase().includes(s) || (x.name || '').toLowerCase().includes(s) || x.group.toLowerCase().startsWith(s))).sort((a, b) => score(a) - score(b)).slice(0, 12);
      hits.innerHTML = xs.map(x => `<li role="option" tabindex="-1" data-add="${esc(x.id)}"><b>${esc(x.label)}</b> <span class="dim">${esc(x.sub)}</span></li>`).join('') || '<li class="dim">No match in the published data.</li>';
      hits.hidden = false;
    };
    find.addEventListener('input', showHits);
    find.addEventListener('keydown', e => { if (e.key === 'ArrowDown') { const f = hits.querySelector('[data-add]'); if (f) { e.preventDefault(); f.focus(); } } if (e.key === 'Enter') { const f = hits.querySelector('[data-add]'); if (f) { e.preventDefault(); addSeries(f.dataset.add); } } if (e.key === 'Escape') hits.hidden = true; });
    hits.addEventListener('keydown', e => {
      const el = e.target.closest('[data-add]'); if (!el) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addSeries(el.dataset.add); }
      if (e.key === 'ArrowDown' && el.nextElementSibling) { e.preventDefault(); el.nextElementSibling.focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); (el.previousElementSibling || find).focus(); }
      if (e.key === 'Escape') { hits.hidden = true; find.focus(); }
    });
    main.addEventListener('click', e => {
      const t = e.target.closest('button,[data-add]'); if (!t || !main.contains(t)) return;
      if (t.dataset.add) return addSeries(t.dataset.add);
      if (t.dataset.range) return exSet(s => { s.r = t.dataset.range; });
      if (t.dataset.rm) return exSet(s => { s.s = s.s.filter(x => x.id !== t.dataset.rm); });
      if (t.dataset.inv) return exSet(s => { const x = s.s.find(y => y.id === t.dataset.inv); x.inv = !x.inv; }, {keepView: true});
      const a = t.dataset.ex;
      if (a === 'reset') return exSet(s => { Object.assign(s, W.cleanState(DEFAULT_STATE), {s: s.s.map(x => ({id: x.id}))}); });
      if (a === 'save') {
        if (S.exStoreBlocked) return exNote('Preset not saved: choose to replace or keep the unreadable saved data first.');
        const name = ($('#ex-pname').value || '').trim() || 'Preset ' + (S.exStore.presets.length + 1);
        S.exStore.presets = S.exStore.presets.filter(p => p.name !== name).concat([{name, state: S.ex.state}]).slice(-20); writeStore(S.exStore); exNote(`Saved “${name}” on this device.`); return paintPresets();
      }
      if (a === 'del-preset') { const n = $('#ex-presets').value; if (!n) return; S.exStore.presets = S.exStore.presets.filter(p => p.name !== n); writeStore(S.exStore); exNote(`Removed preset “${n}”.`); return paintPresets(); }
      if (a === 'link') { const url = root.location.href.split('#')[0] + W.encodeHash(S.ex.state); (root.navigator.clipboard ? root.navigator.clipboard.writeText(url) : Promise.reject(new Error('no clipboard'))).then(() => exNote('Link copied.'), () => exNote('Link: ' + url)); return; }
      if (a === 'clear-store') { S.exStoreBlocked = false; S.exStore = {v: 1, current: S.ex.state, presets: []}; writeStore(S.exStore); const r = $('#ex-recover'); if (r) r.remove(); exNote('Unreadable saved data replaced with this workspace.'); return paintPresets(); }
      if (a === 'keep-store') { const r = $('#ex-recover'); if (r) r.remove(); exNote('Unreadable saved data kept; changes in this visit will not be saved.'); }
    });
    main.addEventListener('change', e => {
      const t = e.target;
      if (t.id === 'ex-mode') return exSet(s => { s.m = t.value; });
      if (t.id === 'ex-sma') return exSet(s => { s.ind.sma = t.checked; }, {keepView: true});
      if (t.id === 'ex-rc') return exSet(s => { s.ind.rc = t.checked; }, {keepView: true});
      if (t.id === 'ex-lag') return exSet(s => { s.lag = +t.value; }, {keepView: true});
      if (t.id === 'ex-from' || t.id === 'ex-to') { const f = $('#ex-from').value, to = $('#ex-to').value; if (f && to) exSet(s => { s.r = {from: f, to}; }); return; }
      if (t.dataset.shift) return exSet(s => { const x = s.s.find(y => y.id === t.dataset.shift); x.shift = +t.value; }, {keepView: true});
      if (t.id === 'ex-presets' && t.value) { const p = S.exStore.presets.find(x => x.name === t.value); if (p) { exSet(s => { Object.assign(s, JSON.parse(JSON.stringify(p.state))); }); exNote(`Loaded “${p.name}”.`); } }
    });
    main.addEventListener('input', e => { if (e.target.dataset && e.target.dataset.scn != null) scenarioInput(e); });
    const chartEl = $('#ex-chart');
    chartEl.addEventListener('keydown', e => {
      const dates = S.exDates || []; if (!dates.length) return;
      let i = S.ex.cursorDate ? dates.indexOf(S.ex.cursorDate) : dates.length - 1; if (i < 0) i = dates.length - 1;
      if (e.key === 'ArrowLeft') i = Math.max(0, i - 1); else if (e.key === 'ArrowRight') i = Math.min(dates.length - 1, i + 1); else if (e.key === 'Home') i = 0; else if (e.key === 'End') i = dates.length - 1; else return;
      e.preventDefault(); S.ex.cursorDate = dates[i]; readout(dates[i], true);   // an intentional cursor survives quote updates
    });
  }
  function addSeries(id) {
    if (S.ex.state.s.length >= W.MAX_SERIES) { exNote(`Up to ${W.MAX_SERIES} series; remove one first.`); return; }
    $('#ex-find').value = ''; $('#ex-hits').hidden = true;
    exSet(s => { s.s.push({id}); });
    $('#ex-find').focus();
  }
  function paintPresets() {
    const el = $('#ex-presets'); if (!el) return;
    el.innerHTML = '<option value="">Choose a preset</option>' + S.exStore.presets.map(p => `<option>${esc(p.name)}</option>`).join('');
  }
  // Effective histories: published closes plus, for companies and ETFs, the accepted regular-session quote.
  function effective(id, h) {
    if (!id.startsWith('eq:')) return {h, live: null};
    const r = W.liveExtend(h, q(id.slice(3)), Date.now());
    return {h: r.h, live: r};
  }
  // Model of the current view: effective histories (published closes + accepted regular-session quote), range,
  // validated display mode and transformed lines. Pure with respect to the DOM.
  function exModel(loaded, st) {
    const pal = isDark() ? PALETTE_DARK : PALETTE;
    const series = loaded.filter(l => !l.err).map(l => { const m = metaOf(l.x.id), e = effective(l.x.id, l.d.h); return Object.assign({}, m, l.x, {h: e.h, live: e.live, color: pal[st.s.indexOf(l.x) % pal.length]}); });
    const b = W.rangeBounds(st.r, series);
    const cut = series.map(s => Object.assign({}, s, {h: W.within(s.h, b)}));
    const valid = W.modeValid(st.m, cut);
    let mode = st.m, reject = '';
    if (!valid.ok) { reject = valid.reason; mode = W.modeValid('z', cut).ok ? 'z' : 'raw'; }
    const base = W.baseDate(cut, b);
    return {series, b, cut, mode, reject, base, pal, lines: cut.map(s => ({s, pts: W.transform(s, mode, base)}))};
  }
  async function drawExplore(fit) {
    const token = (S.exToken = (S.exToken || 0) + 1), st = S.ex.state;
    Live.watch('explore', st.s.filter(x => x.id.startsWith('eq:')).map(x => x.id.slice(3)));
    const loaded = await Promise.all(st.s.map(x => loadSeries(x.id).then(d => ({x, d}), e => ({x, err: e.message}))));
    if (token !== S.exToken || S.view !== 'explore' || !$('#ex-chart')) return;   // superseded or navigated away
    S.exLoaded = loaded;
    const md = exModel(loaded, st), pal = md.pal;
    $('#ex-series').innerHTML = st.s.map((x, i) => { const m = metaOf(x.id) || {label: x.id, sub: ''}, err = (loaded.find(l => l.x.id === x.id) || {}).err;
      return `<div class="chip" style="--c:${pal[i % pal.length]}"><i aria-hidden="true"></i><span class="lbl"><b>${esc(m.label)}</b> <span class="dim">${esc(err ? 'Unavailable: ' + err : m.sub)}</span></span>
        <span class="acts"><button type="button" data-inv="${esc(x.id)}" aria-pressed="${x.inv}" title="Invert this series in the chart">Invert</button>
        <label class="dim">Shift <select data-shift="${esc(x.id)}" aria-label="Visual shift for ${esc(m.label)} in sessions">${[-20, -10, -5, -1, 0, 1, 5, 10, 20].map(k => `<option value="${k}"${k === x.shift ? ' selected' : ''}>${k > 0 ? '+' : ''}${k}</option>`).join('')}</select></label>
        <button type="button" data-rm="${esc(x.id)}" aria-label="Remove ${esc(m.label)}">Remove</button></span></div>`; }).join('') || '<p class="dim">No series selected. Add one below.</p>';
    doc.querySelectorAll('[data-range]').forEach(b => b.setAttribute('aria-pressed', String(st.r === b.dataset.range)));
    $('#ex-mode').value = st.m; $('#ex-sma').checked = st.ind.sma; $('#ex-rc').checked = st.ind.rc; $('#ex-lag').value = String(st.lag);
    paintPresets();
    S.ex.cursorDate = null;
    applyModel(md, {fit, full: true});
    $('#ex-rel').innerHTML = relPanel(md.series, md.b, st.lag);
    renderJoint();
  }
  // Text and inputs that follow the model; never touches a focused control.
  function applyText(md) {
    const from = $('#ex-from'), to = $('#ex-to');
    if (doc.activeElement !== from) from.value = md.b.from || '';
    if (doc.activeElement !== to) to.value = md.b.to || '';
    $('#ex-desc').textContent = (md.reject ? `${md.reject} Showing ${W.MODES[md.mode].toLowerCase()} instead. ` : '') + (md.cut.length ? W.describeTransform(md.mode, md.cut, md.base) : '');
    $('#ex-desc').dataset.mode = md.mode;
    $('#ex-now').innerHTML = nowSentence(md.series, md.b);
  }
  function applyModel(md, o) {
    S.exLines = md.lines; S.exBounds = md.b; S.exModel = md;
    applyText(md);
    if (o.full) drawExChart(md.lines, o.fit, S.ex.state, md.b);
  }
  // Quote-only update: same chart instances, same controls, same focus, zoom and cursor; data and sentences in place.
  function updateExploreQuotes() {
    if (!S.exLoaded || !S.exChart || !S.exSeries) return drawExplore(false);
    const st = S.ex.state, md = exModel(S.exLoaded, st);
    if (md.lines.length !== S.exSeries.length || md.lines.some((l, i) => l.s.id !== S.exSeries[i].s.id) || md.mode !== (S.exModel && S.exModel.mode)) return drawExplore(false);
    const keep = S.exChart.timeScale().getVisibleLogicalRange(), dates = new Set();
    md.lines.forEach((l, i) => {
      const e = S.exSeries[i];
      e.ls.setData(l.pts.map(p => ({time: p[0], value: p[1]})));
      e.ls.setMarkers(liveMarker(l));
      e.s = l.s; e.map = pointMap(l.pts);
      l.pts.forEach(p => dates.add(p[0]));
    });
    if (S.exSma && md.lines[0]) S.exSma.setData(W.sma(md.lines[0].pts, 50).map(p => ({time: p[0], value: p[1]})));
    S.exDates = [...dates].sort();
    if (keep) S.exChart.timeScale().setVisibleLogicalRange(keep);
    if (S.exRcLine && md.lines.length >= 2) S.exRcLine.setData(W.rollingCorr(md.lines[0].s, md.lines[1].s, md.b, 60).map(p => ({time: p[0], value: p[1]})));
    applyModel(md, {full: false});
    readout(S.ex.cursorDate || S.exHover || S.exDates[S.exDates.length - 1], false);
    updateRelPanel(md);
    updateJoint();
    S.exUpdates = (S.exUpdates || 0) + 1;
  }
  const isDark = () => doc.documentElement.dataset.theme ? doc.documentElement.dataset.theme === 'dark' : !!(root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)').matches);
  const pointMap = pts => new Map(pts.map(p => [p[0], {v: p[1], src: p[2] || p[0]}]));
  const liveMarker = l => l.s.live && (l.s.live.status === 'append' || l.s.live.status === 'update') && l.pts.length && !l.s.shift ? [{time: l.s.live.day, position: 'aboveBar', color: l.s.color, shape: 'circle', text: 'now'}] : [];
  function drawExChart(lines, fit, st, b) {
    const el = $('#ex-chart'), LC = root.LightweightCharts;
    if (!LC) { el.innerHTML = '<p class="dim">Chart library unavailable.</p>'; return; }
    const keep = !fit && S.exChart ? S.exChart.timeScale().getVisibleLogicalRange() : null;
    exTeardown();
    const dark = isDark();
    const opts = {height: 320, autoSize: true, layout: {background: {color: 'transparent'}, textColor: dark ? '#b8bcc4' : '#555'}, grid: {vertLines: {visible: false}, horzLines: {color: dark ? '#2a2d33' : '#eee'}},
      rightPriceScale: {borderVisible: false}, timeScale: {borderVisible: false}, crosshair: {mode: 0}};
    const chart = LC.createChart(el, opts); S.exChart = chart; S.exSeries = [];
    S.jointChart=null;S.jointDisplay=null;
    chart.timeScale().subscribeVisibleLogicalRangeChange(()=>requestAnimationFrame(drawJointBand));
    el.onpointerup=()=>requestAnimationFrame(drawJointBand);el.onwheel=()=>requestAnimationFrame(drawJointBand);
    const dates = new Set();
    lines.forEach(l => {
      const ls = chart.addLineSeries({color: l.s.color, lineWidth: 2, priceLineVisible: false, lastValueVisible: true});
      ls.setData(l.pts.map(p => ({time: p[0], value: p[1]})));
      l.pts.forEach(p => dates.add(p[0]));
      ls.setMarkers(liveMarker(l));
      S.exSeries.push({s: l.s, ls, map: pointMap(l.pts)});
    });
    S.exSma = null;
    if (st.ind.sma && lines[0] && lines[0].pts.length > 50) {
      S.exSma = chart.addLineSeries({color: lines[0].s.color, lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false});
      S.exSma.setData(W.sma(lines[0].pts, 50).map(p => ({time: p[0], value: p[1]})));
    }
    S.exDates = [...dates].sort();
    if (keep) chart.timeScale().setVisibleLogicalRange(keep); else chart.timeScale().fitContent();
    chart.subscribeCrosshairMove(p => { if(S.view!=='explore'||S.exChart!==chart||!S.ex)return;S.exHover = p && typeof p.time === 'string' ? p.time : null; if (S.ex.cursorDate || S.exHover) readout(S.ex.cursorDate || S.exHover, false); });
    // Data updates can emit a crosshair event at the old pixel. Only a deliberate
    // pointer move over the chart releases the user's keyboard date selection.
    el.onpointermove=e=>{if(S.view==='explore'&&S.ex&&e.isTrusted && (e.movementX || e.movementY))S.ex.cursorDate=null;};
    readout(S.exDates[S.exDates.length - 1], false);
    const rcEl = $('#ex-rc-chart');
    S.exRcLine = null;
    if (st.ind.rc && lines.length >= 2) {
      const rc = W.rollingCorr(lines[0].s, lines[1].s, b, 60);
      rcEl.hidden = false;
      if (!rc.length) rcEl.innerHTML = '<p class="dim">Rolling correlation needs at least 60 aligned daily changes from two daily series in this range.</p>';
      else {
        rcEl.innerHTML = `<p class="dim">Rolling 60-session correlation of daily changes, ${esc(lines[0].s.label)} with ${esc(lines[1].s.label)}: latest ${rc[rc.length - 1][1].toFixed(2)} on ${esc(rc[rc.length - 1][0])}.</p><div class="ex-rc-plot"></div>`;
        const c2 = LC.createChart(rcEl.querySelector('.ex-rc-plot'), Object.assign({}, opts, {height: 120}));
        const l2 = c2.addLineSeries({color: dark ? '#c4c9d0' : '#555', lineWidth: 2, priceLineVisible: false});
        l2.setData(rc.map(p => ({time: p[0], value: p[1]}))); l2.createPriceLine({price: 0, color: '#999', lineWidth: 1, lineStyle: 2});
        if (S.exDates.length) c2.timeScale().setVisibleRange({from: S.exDates[0], to: S.exDates[S.exDates.length - 1]}); else c2.timeScale().fitContent();   // same dates as the main chart
        S.exRc = c2; S.exRcLine = l2;
      }
    } else { rcEl.hidden = true; rcEl.innerHTML = ''; }
  }
  function exTeardown() {
    if (S.exChart) { try { S.exChart.remove(); } catch (e) {} S.exChart = null; }
    if (S.exRc) { try { S.exRc.remove(); } catch (e) {} S.exRc = null; }
    S.exSeries = []; S.exSma = null; S.exRcLine = null; S.exHover = null;
  }
  // Synchronized readout: each series' displayed value on one date, with the untransformed observation it came from.
  // For a visually shifted series the observation date differs from the display date and is shown.
  function readout(date, moveCrosshair) {
    const el = $('#ex-read'); if (!el || !date) return;
    const rows = (S.exSeries || []).map(({s, map}) => {
      const pt = map.get(date), v = pt && pt.v, src = pt && pt.src, raw = src ? (s.h.find(p => p[0] === src) || [])[1] : undefined;
      return `<span data-series="${esc(s.id)}" data-v="${isNum(v) ? v : ''}" data-src="${esc(src || '')}" data-raw="${isNum(raw) ? raw : ''}"><i style="background:${s.color}"></i>${esc(s.label)} <b>${isNum(v) ? (+v.toFixed(3)).toString() : '—'}</b>${isNum(raw) ? ` <span class="dim">(${esc(+raw.toFixed(4) + ' ' + (s.unit || ''))}${src !== date ? ', observed ' + esc(src) : ''})</span>` : ' <span class="dim">no observation</span>'}</span>`;
    });
    el.innerHTML = `<b data-date="${esc(date)}">${esc(date)}</b> ${rows.join('')}`;
    if (moveCrosshair && S.exChart && S.exSeries[0]) { const pt = S.exSeries[0].map.get(date); if (pt && isNum(pt.v) && S.exChart.setCrosshairPosition) S.exChart.setCrosshairPosition(pt.v, date, S.exSeries[0].ls); }
  }
  function nowSentence(series, b) {
    if (!series.length) return '<span class="dim">Add a series.</span>';
    const out = [], a = series[0];
    const priceLike = s => s.kind === 'price' || s.kind === 'basket';
    const bm = series.slice(1).find(priceLike);
    if (priceLike(a) && bm) {
      const r = W.relPerf(a, bm, b);
      if (r) out.push(`<span data-now="rel" data-gap="${r.gap}">From ${esc(r.from)} to ${esc(r.to)}, ${esc(a.label)} ${r.ry >= 0 ? 'rose' : 'fell'} ${Math.abs(r.ry).toFixed(2)}% and ${esc(bm.label)} ${r.rb >= 0 ? 'rose' : 'fell'} ${Math.abs(r.rb).toFixed(2)}%: ${esc(a.label)} is ${Math.abs(r.gap).toFixed(2)} pp ${r.gap >= 0 ? 'ahead' : 'behind'}.` +
        (r.y_ahead_of_common ? ` ${esc(a.label)} has a ${esc(r.y_ahead_of_common)} price that ${esc(bm.label)} lacks, so the comparison stops at ${esc(r.to)}.` : '') + '</span>');
    }
    series.forEach(s => {
      const lv = s.live; if (!lv) return;
      const t = s.id.slice(3), qq = q(t);
      if (lv.status === 'append' || lv.status === 'update') out.push(`<span data-now="live-${esc(t)}">${esc(t)} ${px(lv.point[1])} is a provisional ${esc(lv.day)} regular-session price (${esc(Live.etLabel(qq.asof_utc || qq.ts, Date.now()))}); the chart’s last ${esc(t)} point uses it.</span>`);
      else if (lv.status === 'extended') out.push(`<span data-now="ext-${esc(t)}">${esc(t)} traded at ${px(lv.price)} outside regular hours (${esc(Live.etLabel(qq.asof_utc || qq.ts, Date.now()))}); the daily line keeps regular closes.</span>`);
      else if (lv.note) out.push(`<span data-now="skip-${esc(t)}">${esc(t)}: ${esc(lv.note)}</span>`);
    });
    series.filter(s => s.id.startsWith('mac:')).forEach(s => { const l = s.h[s.h.length - 1]; if (l) out.push(`${esc(s.label)}: ${+l[1].toFixed(3)} ${esc(s.unit)} on ${esc(l[0])} (${esc(s.freq)}); macro readings keep their observation dates and do not tick with quotes.`); });
    return out.join(' ') || '<span class="dim">No current comparison for this selection.</span>';
  }
  const unitSp = u => u === '%' ? '%' : ' ' + u;
  const f3 = v => (+v.toFixed(3)).toString();
  function relStats(y, x, s) {
    return `${corrWord(s.r)[0].toUpperCase() + corrWord(s.r).slice(1)} co-movement${s.r < 0 ? ' in opposite directions' : ''}: correlation <b data-corr="${s.r}">${s.r.toFixed(2)}</b> over ${s.n} aligned daily changes (${esc(s.from)} to ${esc(s.to)}${s.lag ? `, ${esc(x.label)} lagged ${s.lag} session${s.lag > 1 ? 's' : ''}` : ''}). Slope ${f3(s.beta)}${unitSp(y.cunit)} per 1${unitSp(x.cunit)} move in ${esc(x.label)} (95% interval for the slope ${f3(s.ci95[0])} to ${f3(s.ci95[1])}).`;
  }
  function relSample(y, x, s) {
    return `First half ${isNum(s.first_half) ? s.first_half.toFixed(2) : 'n/a'}, second half ${isNum(s.second_half) ? s.second_half.toFixed(2) : 'n/a'}${s.halves_same_sign ? '' : '; the sign changed, so treat it as unstable'}. Sample: ${s.acc.common_dates} shared dates; ${s.acc.y_only} only in ${esc(y.label)}, ${s.acc.x_only} only in ${esc(x.label)}; ${s.acc.invalid} invalid changes; nothing forward-filled.${s.lag ? ' Lagged statistics are descriptive; macro histories are revised, not point-in-time, so no lead is claimed.' : ''}`;
  }
  function relPanel(series, b, lag) {
    if (series.length < 2) return '<p class="dim">Add a second series to measure how they moved together.</p>';
    const y = series[0];
    return series.slice(1).map((x, i) => {
      const s = W.pairStats(y, x, b, {lag});
      const cat = catalogNote(S.rel, y, x);
      let html = `<article class="rel" data-pair="${esc(y.id + '|' + x.id)}" data-ok="${s.ok}"><h4>${esc(y.label)} with ${esc(x.label)}</h4>`;
      if (!s.ok) html += `<p class="dim" data-rel-stats="${i}">${esc(s.reason)}</p>`;
      else {
        html += `<p data-rel-stats="${i}">${relStats(y, x, s)}</p><p class="dim" data-rel-sample="${i}">${relSample(y, x, s)}</p>
          <p class="scn"><label>If ${esc(x.label)} changes by <input type="number" step="any" inputmode="decimal" data-scn="${i}"> ${esc(x.cunit)} in a day</label></p>
          <p data-scn-out="${i}" class="dim" aria-live="polite">Enter a move to see what ${esc(y.label)} did on comparable past days.</p>`;
      }
      if (cat) html += `<details class="src" data-catalog="${cat.direction}"><summary>${esc(cat.summary)}</summary><p>${esc(cat.text)}</p><p class="dim">Built ${esc(S.rel.generated_at)}. ${esc(S.rel.method)}</p></details>`;
      return html + '</article>';
    }).join('');
  }
  // In-place statistics refresh after a quote; typed scenarios, focus and open details stay as they are.
  function updateRelPanel(md) {
    const y = md.series[0], box = $('#ex-rel'); if (!box || !y) return;
    const arts = box.querySelectorAll('article.rel');
    for (let i = 0; i < md.series.length - 1; i++) {
      const x = md.series[i + 1], s = W.pairStats(y, x, md.b, {lag: S.ex.state.lag}), art = arts[i];
      if (!art || art.dataset.ok !== String(s.ok)) {   // withheld <-> measured: rebuild, carrying typed values and focus
        const typed = [...box.querySelectorAll('[data-scn]')].map(e => [e.dataset.scn, e.value]), focus = doc.activeElement && doc.activeElement.dataset ? doc.activeElement.dataset.scn : null;
        box.innerHTML = relPanel(md.series, md.b, S.ex.state.lag);
        typed.forEach(([k, v]) => { const e = box.querySelector(`[data-scn="${k}"]`); if (e) { e.value = v; if (v) scenarioUpdate(k); } });
        if (focus != null) { const e = box.querySelector(`[data-scn="${focus}"]`); if (e) e.focus(); }
        return;
      }
      if (!s.ok) { art.querySelector('[data-rel-stats]').textContent = s.reason; continue; }
      art.querySelector('[data-rel-stats]').innerHTML = relStats(y, x, s);
      art.querySelector('[data-rel-sample]').innerHTML = relSample(y, x, s);
      const inp = art.querySelector('[data-scn]'); if (inp && inp.value !== '') scenarioUpdate(String(i));
    }
  }
  function scenarioInput(e) { scenarioUpdate(e.target.dataset.scn); }
  function scenarioUpdate(i) {
    const inp = doc.querySelector(`[data-scn="${i}"]`), out = doc.querySelector(`[data-scn-out="${i}"]`), lines = S.exLines || [];
    const y = lines[0] && lines[0].s, x = lines[+i + 1] && lines[+i + 1].s;
    if (!inp || !out || !y || !x) return;
    const v = parseFloat(inp.value);
    if (!isNum(v)) { out.textContent = 'Enter a number.'; return; }
    const st = W.pairStats(y, x, S.exBounds, {lag: S.ex.state.lag}), r = W.scenario(st, v);
    out.dataset.mean = r.ok ? r.mean : '';
    out.textContent = r.ok ? scenarioText(y, x, v, st, r) : r.reason;
  }
  function scenarioText(y, x, v, st, r) {
    const u = y.cunit, sg = n => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(2);
    return `On past days when ${x.label} changed by ${sg(v)}${unitSp(x.cunit)}, the fitted average ${y.label} change was ${sg(r.mean)}${unitSp(u)} (95% band for that average ${sg(r.mean_lo)} to ${sg(r.mean_hi)}${unitSp(u)}). The 95% model band for individual-day variation is ${sg(r.day_lo)} to ${sg(r.day_hi)}${unitSp(u)}. Same-day history, ${st.from} to ${st.to}, ${st.n} days; a descriptive conditional estimate, not a forecast.`;
  }

  function renderJoint() {
    const id=S.ex.state.s[0]?.id, m=S.rel?.joint?.find(m=>m.y===id), el=$('#ex-joint');
    if(!el)return;
    S.jointModel=m;S.jointValues ||= [0,0];
    if(!m?.available){el.innerHTML=`<details class="joint"><summary>Economic what-if</summary><p>${esc(m?.reason||'No joint model for this asset in the fixed 64-candidate research budget. Choose SPY, AAPL, MSFT, NVDA, AMZN, JPM, XOM or a supported sector basket.')} Historical overlays remain available through chart controls.</p></details>`;return;}
    el.innerHTML=`<section class="joint"><h3>Two economic moves, together ${learnLink('Scenario','What does this mean?')}</h3><p class="dim">Hypothetical one-day changes associated with ${esc(metaOf(id)?.label||id)}; ${m.n} common days, ${esc(m.fit_start)}–${esc(m.fit_end)}. Joint fit, holding the other driver fixed. It describes history, not a forecast.</p><div class="joint-inputs"><label>10-year Treasury move ${learnLink('Basis points','bp')}<input id="joint-rate" type="number" step="any" inputmode="decimal" value="${S.jointValues[0]}" data-joint="0"></label><label>WTI oil move (%)<input id="joint-oil" type="number" step="any" inputmode="decimal" value="${S.jointValues[1]}" data-joint="1"></label></div><div class="ex-ctl"><label><input type="checkbox" id="joint-on"${S.jointEnabled?' checked':''}> Show hypothetical marker & mean band</label><button type="button" data-joint-overlays>Add rate & oil history</button><button type="button" data-joint-reset>Clear what-if</button></div><p id="joint-out" role="status"></p><details><summary>Method, bounds & counterargument</summary><p>Asset daily percent change = ${f3(m.coefficients[0])} + ${f3(m.coefficients[1])} × rate move (bp) + ${f3(m.coefficients[2])} × oil move (%). Each driver is bounded to its central 90% sample: rate ${m.bounds[0].map(f3).join(' to ')} bp; oil ${m.bounds[1].map(f3).join(' to ')}%. Joint leverage must be ≤9/n. Condition number ${f3(m.condition)}; residual daily standard deviation ${f3(Math.sqrt(m.residual_variance))}%. ${esc(m.method)}.</p><p>Counterargument: these two variables leave other market and company events unexplained; revised macro histories, different close times and changing relationships can break the association. The chart uses the last observed chart price as an anchor, not a target date or fabricated price bar.</p><p>${learnLink('Confidence interval','Average uncertainty vs individual-day variation')} · ${learnLink('Beta','Joint slopes')} · Catalog built ${esc(S.rel.generated_at)}; total fixed search ≤${S.rel.candidate_search.max} candidates.</p></details></section>`;
    el.querySelectorAll('[data-joint]').forEach(inp=>inp.oninput=()=>{S.jointValues[+inp.dataset.joint]=inp.value===''?null:Number(inp.value);updateJoint();});
    $('#joint-on').onchange=e=>{S.jointEnabled=e.target.checked;updateJoint();};
    el.querySelector('[data-joint-reset]').onclick=()=>{S.jointEnabled=false;S.jointValues=[0,0];$('#joint-on').checked=false;$('#joint-rate').value='0';$('#joint-oil').value='0';updateJoint();};
    el.querySelector('[data-joint-overlays]').onclick=()=>exSet(s=>{for(const id of m.drivers)if(!s.s.some(x=>x.id===id)&&s.s.length<W.MAX_SERIES)s.s.push({id});s.m='z';});
    updateJoint();
  }
  function scenarioDisplay(raw) {
    const md=S.exModel,s=md.cut[0], mode=md.mode, values=s.h.map(p=>p[1]);
    const reciprocal=s.inv&&['index','pct','log'].includes(mode), v=reciprocal?1/raw:raw;
    const transformed=reciprocal?values.map(v=>1/v):values;
    const bp=s.h.find(p=>p[0]===md.base)||s.h[0], base=reciprocal?1/bp[1]:bp[1];
    let out=v;
    if(mode==='index')out=100*v/base;else if(mode==='pct')out=100*(v/base-1);else if(mode==='change')out=v-base;else if(mode==='log')out=Math.log(v);
    else if(mode==='z'){const mean=transformed.reduce((a,b)=>a+b,0)/transformed.length, sd=Math.sqrt(transformed.reduce((a,b)=>a+(b-mean)**2,0)/(transformed.length-1));out=(v-mean)/sd;}
    return s.inv&&!reciprocal?-out:out;
  }
  function updateJoint() {
    const out=$('#joint-out'), m=S.jointModel, md=S.exModel;
    if(!out||!m?.available||!md?.cut[0])return;
    const r=W.jointScenario(m,S.jointValues||[0,0]);S.jointResult=r;
    out.dataset.mean=r.ok?r.mean:'';
    out.textContent=r.ok?`For these combined moves, the fitted average ${metaOf(m.y)?.label||m.y} change is ${pct(r.mean)}; 95% confidence band for the average ${pct(r.mean_lo)} to ${pct(r.mean_hi)}. Individual-day variation is wider: ${pct(r.day_lo)} to ${pct(r.day_hi)} (95% model band). ${S.jointEnabled?'The marker and narrow band are hypothetical changes from the last observed chart price; observed history is untouched.':'Turn on the marker to compare the hypothetical change with the observed chart.'}`:r.reason;
    if(!S.jointEnabled||!r.ok||!S.exChart){if(S.jointChart){try{S.exChart.removeSeries(S.jointChart);}catch(e){}S.jointChart=null;}$('#ex-chart .scenario-band')?.remove();S.jointDisplay=null;return;}
    const s=md.cut[0], last=s.h[s.h.length-1];if(!last)return;
    if(s.shift){out.textContent+=' Turn off the visual shift on the asset to position the hypothetical marker.';return;}
    const values=[r.mean_lo,r.mean,r.mean_hi].map(ret=>scenarioDisplay(last[1]*(1+ret/100)));
    if(values.some(v=>!isNum(v))){out.textContent+=' This display transform cannot represent the scenario; use raw or standardized values.';return;}
    const lo=Math.min(...values), hi=Math.max(...values);
    S.jointDisplay={time:last[0],mean:values[1],lo,hi};
    const line=S.jointChart||S.exChart.addLineSeries({color:'#bc7b00',lineVisible:false,pointMarkersVisible:true,pointMarkersRadius:6,priceLineVisible:false,lastValueVisible:false,autoscaleInfoProvider:()=>({priceRange:{minValue:S.jointDisplay.lo,maxValue:S.jointDisplay.hi}})});
    line.setData([{time:last[0],value:values[1]}]);line.setMarkers([{time:last[0],position:'aboveBar',color:'#bc7b00',shape:'circle',text:'What-if '+pct(r.mean)}]);S.jointChart=line;
    let band=$('#ex-chart .scenario-band');if(!band){band=doc.createElement('div');band.className='scenario-band';band.setAttribute('aria-label','Hypothetical 95% mean confidence band');$('#ex-chart').append(band);}
    requestAnimationFrame(drawJointBand);
  }
  function drawJointBand(){const band=$('#ex-chart .scenario-band'), d=S.jointDisplay, line=S.jointChart;if(!band||!d||!line||!S.exChart)return;const x=S.exChart.timeScale().timeToCoordinate(d.time),top=line.priceToCoordinate(d.hi),bottom=line.priceToCoordinate(d.lo);band.hidden=x==null||top==null||bottom==null;if(!band.hidden)Object.assign(band.style,{left:(x-9)+'px',top:top+'px',height:Math.max(3,bottom-top)+'px'});}

  /* ------------------------------------------------------------ boot */
  let pending = null;
  let changedSince = new Set();
  function onQuotes(ev) { (ev && ev.changed || []).forEach(t => changedSince.add(t)); if (pending) return; pending = setTimeout(() => { pending = null; const ch = changedSince; changedSince = new Set(); paintSlots(); if (S.onQuote) S.onQuote(ch); }, 120); }
  async function boot() {
    try {
      const [core, brief] = await Promise.all([json('data/core.json'), json('data/brief.json')]);
      S.core = core; S.brief = brief; core.rows.forEach(r => S.rowMap.set(r.t, r));
      // Relationship catalog and sector baskets are optional: without them the drilldowns say so and the brief still draws.
      try { S.rel = await json('data/relationships.json'); if (!S.rel || S.rel.schema !== 'brief.relationships.v1') throw new Error('unexpected schema'); } catch (e) { S.rel = null; S.relError = e.message; console.warn('[brief] relationships unavailable', e.message); }
      Live.setRows(core.rows);
    } catch (e) {
      $('#view').innerHTML = `<p>The published market data could not be loaded (${esc(e.message)}). <a href="backup.html">Expanded dashboard (backup)</a></p>`; return;
    }
    Live.subscribe(onQuotes);
    doc.addEventListener('click',e=>{const b=e.target.closest('[data-map-period]');if(b){S.heatPeriod=b.dataset.mapPeriod;doc.querySelectorAll('[data-map-period]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));const heat=$('#heat');if(heat)heat.innerHTML=heatSlot();}});
    doc.addEventListener('keydown',e=>{if(e.key==='Escape'&&S.view!=='brief'&&!e.target.closest('.ex-hits')){e.preventDefault();if(root.history.state?.soParent)root.history.back();else root.location.hash='#/';}});
    root.addEventListener('hashchange', render);
    render();
    Live.start();
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot); else boot();
})(typeof window !== 'undefined' ? window : globalThis);
