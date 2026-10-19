/* SmartOptions Brief: the minimal main page (Market brief, Companies, Macro).
   Prices come from the one quote engine in live.js (Yahoo stream, then the shared Worker, then the
   published quote file). Every price-dependent number and sentence is a "slot" that re-renders when an
   accepted quote changes; statements and macro releases keep their own reporting dates.
   Relationships are historical associations (core.json rel: OLS over <=252 sessions), never forecasts.
   One shell: Today, Markets, Macro and Workspace. Legacy tools mount natively inside Workspace through explicit
   lifecycle handles; backup.html remains a standalone recovery artifact and is not the integration path. */
'use strict';
(function (root) {
  const isNum = v => typeof v === 'number' && isFinite(v);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const pct = (v, d) => isNum(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d == null ? 2 : d) + '%' : 'n/a';
  const px = v => isNum(v) ? '$' + (v >= 1000 ? v.toLocaleString('en-US', {maximumFractionDigits: 2, minimumFractionDigits: 2}) : v.toFixed(2)) : 'n/a';
  const big = v => !isNum(v) ? 'n/a' : Math.abs(v) >= 1e12 ? (v / 1e12).toFixed(2) + 'T' : Math.abs(v) >= 1e9 ? (v / 1e9).toFixed(1) + 'bn' : Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(1) + 'm' : v.toLocaleString('en-US');
  // Presentation only: provider values, histories and model inputs remain in their original units.
  function unitValue(value, unit = '') {
    if (value == null) return 'n/a';
    if (!isNum(value)) return String(value);
    unit = typeof unit === 'string' ? unit : '';
    const scale = /^(millions?|billions?|trillions?) USD$/i.exec(unit);
    if (scale) {
      const dollars = value * (/^million/i.test(scale[1]) ? 1e6 : /^billion/i.test(scale[1]) ? 1e9 : 1e12);
      return '$' + (Math.abs(dollars) >= 1e12 ? (dollars / 1e12).toFixed(2) + 'T' : Math.abs(dollars) >= 1e9 ? (dollars / 1e9).toFixed(2) + 'bn' : big(dollars));
    }
    return (Math.abs(value) >= 1e5 ? big(value) : String(+value.toFixed(2))) + (unit === '%' ? '%' : unit ? ' ' + unit : '');
  }
  function macroGroupLine(core, group, fallback = '') {
    if (!['volatility', 'credit_funding'].includes(group)) return fallback;
    const ids = group === 'volatility' ? ['vix', 'vix9d', 'vix3m'] : ['hy_oas'];
    const obs = (core.macro?.[group] || []).filter(o => ids.includes(o.id) && isNum(o.v));
    return obs.length ? obs.map(o => `${o.label || o.id}: ${unitValue(o.v, o.unit)} (${o.date || o.period || 'date unavailable'}${o.status && o.status !== 'ok' ? ', ' + o.status : ''})`).join('; ') + '.' : 'Group observations are unavailable.';
  }
  function focusImpact(core, ticker, factor, shock) {
    const r = (core?.rows || []).find(r => r.t === ticker), fit = r?.rel, unit = core?.rel?.units?.[factor];
    if (!fit || !(fit.n >= 120) || !isNum(fit.c?.[factor]) || !isNum(shock) || !unit) return {ok: false, reason: 'No covered fitted response for this instrument and factor. Follow the source and observed prices qualitatively.'};
    return {ok: true, ticker, factor, shock, coefficient: fit.c[factor], response_pct: fit.c[factor] * shock, baseline_price:r.px, t: fit.t?.[factor], r2: fit.r2, n: fit.n, unit, window: core.rel.window, observed_return_pct: r.d1, session: r.pxd || core.asof_session};
  }
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
    const memo = new Map(), etDay = ms => { const k = Math.floor(ms / 60000); if (!memo.has(k)) memo.set(k, new Date(ms).toLocaleDateString('en-CA', {timeZone: 'America/New_York'})); return memo.get(k); };
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
    // An upcoming report is an event constraint shown separately; it is not evidence against the case.
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
    if (h === '/positions') return {view:'positions'};
    if (/^\/markets(\?|$)/.test(h)) return {view:'markets', query: h.replace(/^\/markets\??/, '')};
    if ((m = h.match(/^\/instrument\/([A-Za-z0-9.\-]{1,10})$/))) return {view:'markets', query: 'sel=' + m[1].toUpperCase().replace('.', '-')};
    if ((m = h.match(/^\/workspace(?:\/([a-z-]{2,20}))?(?:\?(.*))?$/))) return {view:'workspace', tool: m[1] || '', query: m[2] || ''};
    if (h === '/room' || h === '/my-dash') return {view:'room'};
    if (/^\/explore(\?|$)/.test(h)) return {view: 'explore', hash: '#' + h};
    if ((m = h.match(/^\/sector-detail\/(.+)$/))) { try { return {view:'sector', sector:decodeURIComponent(m[1])}; } catch(e) { return {view:'brief', invalid:true}; } }
    if ((m = h.match(/^\/sector\/(.+)$/))) { try { const sec=decodeURIComponent(m[1]); return {view:'markets', query:'sec='+encodeURIComponent(sec), sector:sec}; } catch(e) { return {view:'brief', invalid:true}; } }
    if ((m = h.match(/^\/learn\/(.+)$/))) { try { return {view:'learn', label:decodeURIComponent(m[1])}; } catch(e) { return {view:'brief',invalid:true}; } }
    if ((m = h.match(/^\/company\/([A-Za-z0-9.\-]{1,10})$/))) return {view: 'company', t: m[1].toUpperCase().replace('.', '-')};
    if ((m = h.match(/^\/company\/([A-Za-z0-9.\-]{1,10})\/(overview|fundamentals|drivers|events|options)$/))) return {view: 'company', t: m[1].toUpperCase().replace('.', '-'), tab: m[2]};
    if ((m = h.match(/^\/companies(?:\?mode=(shortlist|saved|all))?$/))) return m[1] ? {view: 'companies', mode: m[1]} : {view: 'companies'};
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

  /* ------------------------------------------------------------ redesign: pure decision helpers (exported for tests) */
  const etDate = ms => new Date(ms).toLocaleDateString('en-CA', {timeZone: 'America/New_York'});
  const etHour = ms => +new Date(ms).toLocaleString('en-US', {timeZone: 'America/New_York', hour: 'numeric', hour12: false}) % 24;
  function addDays(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  const shortDates=new Map(),shortDateFormat=new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'short',day:'numeric'});
  const shortDate = iso => {const key=String(iso||'');if(shortDates.has(key))return shortDates.get(key);const d=new Date(String(iso).slice(0,10)+'T12:00:00Z'),value=isFinite(d)?shortDateFormat.format(d):key;shortDates.set(key,value);if(shortDates.size>512)shortDates.delete(shortDates.keys().next().value);return value;};
  const cap1 = s => s ? s[0].toUpperCase() + s.slice(1) : s;
  const changeItem = (b, id) => ((b && b.daily_changes && b.daily_changes.items) || []).find(x => x.id === id) || null;
  const findMetric = (ms, re) => (ms || []).find(m => re.test(m.label)) || null;
  // Four stable assessments: word + headline quantity + basis. Level wording only, unless a dated change exists.
  function assessments(b) {
    const m = (b && b.macro) || {}, out = [];
    const pt = m.price_trend || {}, ms = pt.metrics || [];
    const close = findMetric(ms, /^SPY close$/), a50 = findMetric(ms, /50-session average/), a200 = findMetric(ms, /200-session average/);
    const rel = (a, c) => a && c && isNum(a.value) && isNum(c.value) && c.value > 0 ? 100 * (a.value / c.value - 1) : null;
    const v50 = rel(close, a50), v200 = rel(close, a200);
    out.push({id: 'price_trend', title: 'Price trend', word: cap1(pt.status || 'unavailable'), tone: pt.status === 'supportive' ? 'good' : pt.status === 'adverse' ? 'bad' : 'mixed',
      qty: isNum(v50) && isNum(v200) ? `SPY ${pct(v50, 1)} vs 50-day, ${pct(v200, 1)} vs 200-day average` : 'SPY averages unavailable',
      basis: close ? `Close ${shortDate(String(close.period).slice(-10))}; completed sessions, not the live quote` : 'Completed sessions'});
    const pa = m.participation || (b && b.positioning && b.positioning.breadth) || {}, s50 = findMetric(pa.metrics, /Above 50-session/), ch = changeItem(b, 'breadth_50_5d');
    const level = (b && b.positioning && b.positioning.breadth && b.positioning.breadth.level) || pa.level || 'mixed';
    out.push({id: 'participation', title: 'Participation', word: cap1(level), tone: level === 'broad' ? 'good' : level === 'thin' ? 'bad' : 'mixed',
      qty: s50 && isNum(s50.value) ? `${s50.value.toFixed(0)}% of names above their 50-day average` : 'Share above averages unavailable',
      change: ch && ch.status === 'ok' ? `${ch.change >= 0 ? '+' : '−'}${Math.abs(ch.change).toFixed(1)} pp since ${shortDate(ch.prior.date)} (same ${ch.cohort.n} names)` : 'Five-session change unavailable',
      basis: 'Level of participation; direction only from the dated change'});
    const bd = m.backdrop || {}, mw = macroWords(b), dirWord = k => bd[k] ? (bd[k].available === false ? 'incomplete' : mw[k]?.word || bd[k].direction) : 'n/a';
    out.push({id: 'backdrop', title: 'Macro backdrop', word: cap1(bd.status || 'unavailable'), tone: bd.status === 'supportive' ? 'good' : bd.status === 'adverse' ? 'bad' : 'mixed',
      qty: `Growth ${dirWord('growth')} · inflation ${dirWord('inflation')} · policy rate ${dirWord('policy')}`, basis: 'Latest releases; each keeps its own period'});
    const rk = m.risk || {}, ev = m.risk_events;
    out.push({id: 'risk', title: 'Risk conditions', word: cap1(rk.status || 'unavailable'), tone: rk.status === 'calm' ? 'good' : rk.status === 'stressed' ? 'bad' : 'mixed',
      qty: rk.line || 'Risk inputs unavailable', change: ev ? 'Scheduled: ' + ev.line : 'Scheduled-event count unavailable',
      basis: 'Observed volatility and credit; scheduled releases are listed separately'});
    return out;
  }
  // Python owns thresholds; old optional metadata fails closed rather than reviving stale triggers.
  function normalizedSignals(b) {
    const out=assessments(b),m=b.macro||{},normalized=(o,allowed)=>Object.hasOwn(o,'observed_status')&&allowed.includes(o.observed_status)?o.observed_status:null;
    const ch=changeItem(b,'breadth_50_5d'),comparable=ch?.status==='ok'&&isNum(ch.change)&&ch.prior?.date<ch.current?.date&&ch.current?.date===b.asof_session&&ch.cohort?.n>=.9*ch.cohort?.universe;
    const direction=comparable?(ch.change>.005?'broadening':ch.change<-.005?'narrowing':'mixed'):null;
    const status=[normalized(m.price_trend||{},['supportive','mixed','adverse']),direction,normalized(m.backdrop||{},['supportive','mixed','adverse']),normalized(m.risk||{},['normal','elevated','high'])];
    out.forEach((s,i)=>{const obj=i===0?m.price_trend:i===2?m.backdrop:i===3?m.risk:null;s.status=status[i];s.coverage=i===1?(comparable?'complete':'unavailable'):obj?.coverage||'unavailable';s.word=s.status?cap1(s.status)+(i===1?' over five sessions':''):i===0?'Not available':i===1?'Direction unavailable':'Incomplete';s.tone=['supportive','broadening','normal'].includes(s.status)?'good':['adverse','narrowing','high'].includes(s.status)?'bad':s.status?'mixed':'neutral';});
    out[1].basis='Five-session direction compares the same cohort; the participation level is separate.';
    if(comparable){out[1].change=`${pp(ch.change)} · ${ch.prior.date} → ${ch.current.date} · five sessions · same ${ch.cohort.n} names`;const daily=changeItem(b,'breadth_50_1d');if(daily?.status==='ok'&&isNum(daily.change)&&Math.abs(daily.change)>.005&&Math.abs(ch.change)>.005&&Math.sign(daily.change)!==Math.sign(ch.change))out[1].change+='; previous-session direction differs';}
    out[3].change=(m.risk?.missing||[]).join('; ')||'Scheduled events are assessed separately';
    return out;
  }
  function ptClock(iso) {
    const d=new Date(iso);return isFinite(d)?new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',dateStyle:'medium',timeStyle:'short'}).format(d)+' PT':'Update time unavailable';
  }
  function posture(signals,level) {
    const [p,pa,m,r]=signals;
    if(r.status==='high')return 'Defensive conditions';
    if(p.status==='adverse'&&pa.status==='narrowing')return 'Defensive price conditions';
    if(!p.status||!pa.status)return 'Market read incomplete';
    // Measured price and participation with incomplete macro/risk stays Mixed; the specific gap is a reason, not the headline.
    if(!m.status||!r.status||m.coverage!=='complete'||r.coverage!=='complete')return 'Mixed market conditions';
    if(p.status==='supportive'&&m.status==='supportive'&&pa.status==='broadening'&&r.status==='normal')return 'Supportive conditions';
    if(p.status==='supportive'&&(pa.status==='narrowing'||level==='thin'))return 'Uptrend with narrow participation';
    return 'Mixed market conditions';
  }
  function sessionComparison(b,core,id) {
    const spy=changeItem(b,'spy_1d'),x=id==='spy_1d'||id==='breadth_50_1d'?changeItem(b,id):(b.daily_changes?.macro||[]).find(x=>x.id===id);
    const reason='Previous-session comparison unavailable';
    const valid=x&&x.status==='ok'&&spy?.status==='ok'&&x.current?.date===b.asof_session&&x.current.date===spy.current?.date&&x.prior?.date===spy.prior?.date&&x.prior.date<x.current.date&&isNum(x.current.value)&&isNum(x.prior.value)&&isNum(x.change)&&Math.abs(x.current.value-x.prior.value-x.change)<.001;
    if(!valid)return {id,x,available:false,reason};
    if(id==='spy_1d'){
      const h=(core?.spy_close||[]).filter(p=>p[0]<=b.asof_session&&isNum(p[1]));
      if(core?.asof_session!==b.asof_session||h.length<2||h.at(-1)[0]!==x.current.date||h.at(-2)[0]!==x.prior.date||Math.abs(h.at(-1)[1]-x.current.value)>.00011||Math.abs(h.at(-2)[1]-x.prior.value)>.00011||h.some((p,i)=>i&&h[i-1][0]>=p[0]))return {id,x,available:false,reason:reason+' — SPY source/history mismatch'};
    }
    if(!['spy_1d','breadth_50_1d'].includes(id)){
      const o=Object.values(core?.macro||{}).flat().find(o=>o.id===id),h=o?.h||[],unit=id==='us10y'?'%':'index points';
      if(x.unit!==unit||x.obs_status!=='ok'||!o||o.status!=='ok'||o.unit!==unit||o.date!==x.current.date||!isNum(o.v)||Math.abs(o.v-x.current.value)>.00011||h.length<2||h.at(-1)[0]!==x.current.date||h.at(-2)[0]!==x.prior.date||Math.abs(h.at(-1)[1]-x.current.value)>.00011||Math.abs(h.at(-2)[1]-x.prior.value)>.00011||h.some((p,i)=>i&&h[i-1][0]>=p[0]))return {id,x,available:false,reason:reason+' — stale or mismatched source/history, units or dates'};
    }
    if(id==='breadth_50_1d'&&!(x.cohort?.n>=.9*x.cohort?.universe))return {id,x,available:false,reason:reason+' — cohort coverage below 90%'};
    if(id==='spy_1d'&&!(x.prior.value>0))return {id,x,available:false,reason};
    const delta=x.current.value-x.prior.value;
    return {id,x,available:true,change:id==='us10y'?100*delta:delta,pct:x.prior.value>0?100*(x.current.value/x.prior.value-1):null};
  }
  function todayModel(b,core) {
    const signals=normalizedSignals(b),comparisons=['spy_1d','vix','us10y','dxy','breadth_50_1d'].map(id=>sessionComparison(b,core,id));
    // Plain conclusions first; exact figures, dates and methods live in each reason's evidence.
    const reasons=[{text:priceSentence(b,signals[0]),ev:{kind:'assessment',id:'price_trend'}},{text:participationSentence(b,signals[1]),ev:{kind:'assessment',id:'participation'}}];
    const vix=comparisons.find(x=>x.id==='vix'),riskWord=riskSentence(b,signals[3]);
    if(riskWord)reasons.push({text:riskWord,ev:{kind:'assessment',id:'risk'}});
    else if(vix.available){const level=vix.x.current.value;reasons.push({text:`Expected near-term market volatility (VIX) ${vix.change>0?'rose':vix.change<0?'fell':'was unchanged'}${level>=20?' and is at or above 20':' but remains below 20'}; this says nothing about single-stock option premiums.`,ev:{kind:'today-change',id:'vix'}});}
    else if(signals[3].status)reasons.push({text:`Measured risk conditions read ${signals[3].word.toLowerCase()}.`,ev:{kind:'assessment',id:'risk'}});
    const macroWord=macroSentence(b,signals[2]);if(macroWord)reasons.push({text:macroWord,ev:{kind:'assessment',id:'backdrop'}});
    const rate=comparisons.find(x=>x.id==='us10y');
    if(rate.available&&!(macroWord&&Math.abs(rate.change)<5))reasons.push({text:Math.abs(rate.change)<5?'Treasury yields were little changed, so rates added no clear pressure or relief.':`${rate.change<0?'Lower':'Higher'} Treasury yields ${rate.change<0?'ease':'add to'} pressure on valuations and borrowing costs, all else equal.`,ev:{kind:'today-change',id:'us10y'}});
    const gaps=[signals[2].coverage!=='complete'&&'macro releases',signals[3].coverage!=='complete'&&'credit or volatility inputs'].filter(Boolean);
    if(gaps.length)reasons.push({text:`${cap1(listJoin(gaps))} ${gaps.length>1?'are':'is'} incomplete or stale; that part of the reading is limited, not filled in.`,ev:{kind:'today',id:'trust'}});
    reasons.forEach(reason=>{
      const ev=reason.ev,c=comparisons.find(c=>c.id===ev.id),period=c?.x?`${c.x.prior?.date} to ${c.x.current?.date}`:b.asof_session;
      const metric=(label,value,unit,note='')=>({label,value,unit,period,asof:b.asof_session,source:'Retained inputs; deterministic Today projection',source_url:c?.x?.source_url||'https://finance.yahoo.com/quote/SPY/history/',note});
      if(ev.id==='price_trend'){
        const ms=b.macro?.price_trend?.metrics||[],close=findMetric(ms,/^SPY close$/),a50=findMetric(ms,/50-session average/),a200=findMetric(ms,/200-session average/);
        reason.metrics=close&&a50&&a200?[...ms,metric('SPY distance to 50-session average',100*(close.value/a50.value-1),'%'),metric('SPY distance to 200-session average',100*(close.value/a200.value-1),'%')]:ms;
      }else if(ev.id==='participation'){
        const ch=changeItem(b,'breadth_50_5d');reason.metrics=ch?.status==='ok'?[{...metric('Five-session same-cohort participation change',ch.change,'pp'),period:ch.prior.date+' to '+ch.current.date},metric('Same cohort names',ch.cohort.n,'names')]:[];
      }else if(c?.available)reason.metrics=[metric(CHANGE_NAMES_FALLBACK(ev.id),ev.id==='vix'?c.pct:c.change,ev.id==='vix'?'%':ev.id==='us10y'?'bps':c.x.unit)];
      else reason.metrics=ev.id==='backdrop'?['growth','inflation','policy'].flatMap(k=>(b.macro?.backdrop?.[k]?.metrics||[]).filter(m=>isNum(m.value)).slice(0,3)):b.macro?.[ev.id]?.metrics||[];
    });
    return {signals,comparisons,reasons:reasons.slice(0,5),label:posture(signals,b.positioning?.breadth?.level),coverage:signals.some(s=>s.coverage!=='complete')?'Coverage incomplete':'Market inputs covered',updated:ptClock(b.generated_at),session:b.asof_session};
  }
  function priceSentence(b,sig) {
    const ms=b.macro?.price_trend?.metrics||[],close=findMetric(ms,/^SPY close$/),a50=findMetric(ms,/50-session average/),a200=findMetric(ms,/200-session average/);
    if(!sig.status||!close||!a50||!a200)return 'The S&P 500 price trend cannot be assessed from the retained closes.';
    const above50=close.value>a50.value,above200=close.value>a200.value;
    if(sig.status==='supportive')return 'The S&P 500 is in an uptrend, above its 50- and 200-day averages.';
    if(sig.status==='adverse')return 'The S&P 500 is in a downtrend, below its 50- and 200-day averages.';
    return above200&&!above50?'The S&P 500 slipped below its 50-day average but stays above its 200-day average.':!above200&&above50?'The S&P 500 is above its 50-day average but still below its 200-day average.':above50?'The S&P 500 is above both averages, but its longer trend is not rising.':'The S&P 500 is below both averages, but its longer trend has not turned down.';
  }
  // Name the measured trigger in words; thresholds and values stay in the risk evidence.
  function riskSentence(b,sig) {
    if(sig.status!=='elevated'&&sig.status!=='high')return null;
    const ms=b.macro?.risk?.metrics||[],v=re=>{const m=findMetric(ms,re);return m&&isNum(m.value)?m.value:null;};
    const why=[v(/^HY OAS change/)>=30&&'high-yield credit spreads widened notably over the past 20 trading days',v(/^ICE BofA US High Yield OAS/)>=450&&'high-yield credit spreads are wide',v(/^VIX close/)>=20&&'the VIX is at or above 20',v(/^VIX \/ VIX3M/)>1&&'near-term volatility is priced above three-month volatility'].filter(Boolean);
    return `Risk conditions are ${sig.status}${why.length?': '+listJoin(why):''}.`;
  }
  // Source-grounded macro words; each keeps its own horizon. A flat classifier over disagreeing horizons reads "mixed",
  // never "steady"; a 20-observation effective-rate move is not a new decision; slower positive growth is not contraction.
  function macroWords(b) {
    const bd=b?.macro?.backdrop||{},m=(k,re)=>{const x=findMetric(bd[k]?.metrics,re);return x&&isNum(x.value)?x:null;},out={};
    const g=bd.growth,i=bd.inflation,p=bd.policy;
    if(g&&g.available!==false){const gdp=m('growth',/^Real GDP growth \(quarterly SAAR\)/),pos=gdp?gdp.value>0:null;
      out.growth=g.direction==='down'?{word:pos===false?'contracting':'slowing',text:pos?'growth is slowing but still positive':pos===false?'output is contracting':'growth slowed'}:g.direction==='up'?{word:'picking up',text:'growth picked up'}:{word:'little changed',text:null};}
    if(i&&i.available!==false){const mixed=i.direction==='flat'&&/differ|incomplete/i.test(i.line||'');
      out.inflation=mixed?{word:'mixed across measures',text:'inflation measures disagree'}:i.direction==='up'?{word:'rising',text:'inflation is rising'}:i.direction==='down'?{word:'easing',text:'inflation is easing'}:{word:'steady',text:null};}
    if(p&&p.available!==false){const s=m('policy',/^Policy comparison start/),since=s&&/^\d{4}-\d{2}-\d{2}$/.test(s.period||'')?shortDate(s.period):null;
      out.policy=p.direction==='up'?{word:since?'higher than '+since:'higher',text:'the effective fed funds rate is higher'+(since?' than on '+since:'')}:p.direction==='down'?{word:since?'lower than '+since:'lower',text:'the effective fed funds rate is lower'+(since?' than on '+since:'')}:{word:'unchanged',text:null};}
    return out;
  }
  function macroSentence(b,sig) {
    if(sig.status!=='adverse'&&sig.status!=='supportive')return null;
    const w=macroWords(b),parts=['growth','inflation','policy'].map(k=>w[k]?.text).filter(Boolean);
    return `The macro backdrop is ${sig.status}${parts.length?': '+listJoin(parts):''}.`;
  }
  // First-view synthesis: measured supports beside measured challenges, then a conditional implication.
  // It never presumes holdings or gains, never rates a trade, and ranks nothing by colour alone.
  function currentMessage(model, situation, fallback) {
    if (!situation || situation.stale || situation.state === 'unavailable') return fallback;
    const fs=(situation.measures||[]).filter(m=>['ES=F','NQ=F'].includes(m.symbol)&&m.valid&&m.newer&&!m.expired&&!m.carried&&isNum(m.pct));
    if (new Set(fs.map(m=>m.symbol)).size !== 2 || !(situation.developments||[]).some(d=>d.rule==='index_futures')) return fallback;
    const direction=fs.every(m=>m.pct>0)?'firmer':fs.every(m=>m.pct<0)?'under pressure':'diverging';
    const trend=model.signals?.find(s=>s.id==='price_trend')?.status;
    return `Newer index futures are ${direction}; the completed-session cash trend remains ${trend||'unconfirmed'}. Check the cash open before treating this as a reversal.`;
  }
  function pricePhrase(b,sig) {
    const ms=b.macro?.price_trend?.metrics||[],c=findMetric(ms,/^SPY close$/),a50=findMetric(ms,/50-session average/),a200=findMetric(ms,/200-session average/);
    if(!sig.status||!c||!a50||!a200)return null;const u50=c.value>a50.value,u200=c.value>a200.value;
    return sig.status==='supportive'?['s','the S&P 500 uptrend']:sig.status==='adverse'?['c','the S&P 500 downtrend']:u200&&!u50?['c','a short-term S&P 500 trend break (long-term trend intact)']:!u200&&u50?['c','a long-term S&P 500 trend that has not recovered']:['c','an unclear S&P 500 trend'];
  }
  // First-view reason: one short accurate clause; the full sentence, horizons and figures stay in its evidence sheet.
  function shortReason(x,b,model) {
    const id=x.ev.id,[p,pa,m,r]=model.signals;
    if(id==='price_trend'){const pp=pricePhrase(b,p),ms=b.macro?.price_trend?.metrics||[],c=findMetric(ms,/^SPY close$/),a50=findMetric(ms,/50-session average/),a200=findMetric(ms,/200-session average/);
      if(!pp||!c||!a50||!a200)return x.text;return `S&P 500 ${c.value>a50.value?'above':'below'} its 50-day, ${c.value>a200.value?'above':'below'} its 200-day average`;}
    if(id==='participation'&&pa.status){const s50=findMetric((b.macro?.participation||b.positioning?.breadth||{}).metrics,/Above 50-session/),under=s50&&isNum(s50.value)?(s50.value<50?'; still under half':'; over half'):'';
      return (pa.status==='broadening'?'More stocks above their 50-day average than five sessions ago':pa.status==='narrowing'?'Fewer stocks above their 50-day average than five sessions ago':'Participation roughly unchanged over five sessions')+under;}
    if(id==='risk'&&(r.status==='elevated'||r.status==='high')){const hy=findMetric(b.macro?.risk?.metrics,/^HY OAS change/);return `Risk ${r.status}`+(hy&&isNum(hy.value)&&hy.value>=30?': credit spreads widened over 20 days':'');}
    if(id==='backdrop'&&m.status){const w=macroWords(b),bits=[w.growth&&w.growth.word!=='little changed'&&'growth '+w.growth.word.replace(' but still positive',''),w.inflation&&(w.inflation.word==='mixed across measures'?'inflation mixed':'inflation '+w.inflation.word),w.policy&&w.policy.word!=='unchanged'&&'policy rate '+w.policy.word.split(' than ')[0]].filter(Boolean);
      return `Macro ${m.status}`+(bits.length?': '+listJoin(bits):'');}
    return x.text;
  }
  function takeaway(model,b) {
    const [p,pa,m,r]=model.signals,sup=[],ch=[],pp=pricePhrase(b,p);
    if(pp)(pp[0]==='s'?sup:ch).push(pp[1]);
    if(pa.status==='broadening')sup.push('more companies joining the advance');else if(pa.status==='narrowing')ch.push('fewer companies participating');
    if(r.status==='normal'&&r.coverage==='complete')sup.push('calm credit and volatility');
    else if(r.status==='elevated'||r.status==='high'){const hy=findMetric(b.macro?.risk?.metrics,/^HY OAS change/);ch.push(hy&&isNum(hy.value)&&hy.value>=30?'widening credit spreads':'elevated risk measures');}
    if(m.status==='supportive')sup.push('a supportive macro backdrop');else if(m.status==='adverse')ch.push('an adverse macro backdrop');
    const label=model.label;
    const so=/^Defensive/.test(label)?'Downside first: review concentration and event dates before adding exposure.':label==='Supportive conditions'?'Conditions support adding exposure selectively; valuation and event dates still decide timing.':/incomplete/i.test(label)?'Too little comparable evidence for a market call; dated company evidence below still applies.':ch.length>sup.length?'Be selective: weigh downside and event dates before adding exposure, and watch whether the challenges ease.':'Be selective: the supports are real, but wait for the challenges to ease before adding broadly.';
    return {supports:sup,challenges:ch,so};
  }
  // Current SPY beside the completed-session read. The comparison basis is proven, not assumed: the quote's previous
  // regular close must equal the retained unadjusted SPY close for the read session (so no split, dividend or other
  // basis change sits between them), in USD, and the averages must be dated that session. Otherwise the current
  // price and its own change stay separate from the dated averages. Ticks never re-label macro, credit or breadth.
  function nowVsClose(b,q,nowMs,breadth) {
    const session=b?.asof_session,ms=b?.macro?.price_trend?.metrics||[],close=findMetric(ms,/^SPY close$/),a50=findMetric(ms,/50-session average/),a200=findMetric(ms,/200-session average/);
    const t=Date.parse(q?.asof_utc||q?.ts||''),qSession=isFinite(t)?new Date(t).toLocaleDateString('en-CA',{timeZone:'America/New_York'}):null,base={session};
    if(!session||!q||!isNum(q.price)||q.price<=0||!isFinite(t)||t>nowMs+60000)return {...base,state:'unavailable',reason:'no current SPY quote'};
    if(q.current_usable===false||['stale','missing','blocked'].includes(q.delivery_state))return {...base,state:'unavailable',reason:'the SPY quote is stale or unavailable'};
    if(qSession<session)return {...base,state:'unavailable',reason:'the latest SPY quote predates the '+shortDate(session)+' session'};
    if(qSession===session)return {...base,state:'closed',price:q.price,qTime:t};
    const prior=isNum(q.prior_close)&&q.prior_close>0?q.prior_close:null,own=isNum(q.chg_pct)?q.chg_pct:isNum(q.change_pct)?q.change_pct:null;
    // Proof needs the provider's own dated previous close in USD; absent fields or a loose price coincidence prove nothing.
    const proven=!!(prior&&close&&isNum(close.value)&&close.value>0&&q.prior_close_date===session&&q.currency==='USD'&&Math.abs(prior/close.value-1)<=.0005);
    const out={...base,state:'current',fresh:q.freshness_label||q.delivery_state||'freshness unknown',price:q.price,qTime:t,qSession,proven,own,chg:proven?100*(q.price/prior-1):null};
    if(proven&&a50&&a200&&isNum(a50.value)&&isNum(a200.value)&&String(a50.asof||'').slice(0,10)===session&&String(a200.asof||'').slice(0,10)===session)
      Object.assign(out,{v50:100*(q.price/a50.value-1),v200:100*(q.price/a200.value-1),closeAbove50:close.value>a50.value,closeAbove200:close.value>a200.value,nowAbove50:q.price>a50.value,nowAbove200:q.price>a200.value});
    if(breadth&&breadth.complete&&breadth.session>session&&breadth.session===qSession)out.breadth={up:breadth.up,n:breadth.n,pct:breadth.up_pct};
    return out;
  }
  function nowText(n,b) {
    const d=shortDate(n.session),et=ms=>new Date(ms).toLocaleTimeString('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'2-digit'})+' ET';
    if(n.state==='unavailable')return `Now: no current SPY price (${n.reason}). Signals are the ${d} close.`;
    if(n.state==='closed')return `Now: no session since ${d}. SPY $${n.price.toFixed(2)}`+(n.last&&isNum(n.last.pct)?`, ${pct(n.last.pct)} that day`:'')+'. Signals refresh automatically after each close.';
    let s=`Now: SPY $${n.price.toFixed(2)} · ${n.fresh} · ${et(n.qTime)}${n.marketOpen===false?' · market closed':''}`;
    if(n.proven&&isNum(n.chg))s+=`, ${pct(n.chg)} since the ${d} close.`;else s+=(isNum(n.own)?`, ${pct(n.own)} vs provider's previous close`:'')+'.';
    if(isNum(n.v50)){const f50=n.nowAbove50!==n.closeAbove50,f200=n.nowAbove200!==n.closeAbove200;
      s+=f50||f200?` Intraday SPY is ${f50?(n.nowAbove50?'back above':'below')+' its '+d+' 50-day':(n.nowAbove200?'back above':'below')+' its '+d+' 200-day'} average; not yet confirmed by a close.`:` Still ${n.nowAbove50?'above':'below'} its ${d} 50-day and ${n.nowAbove200?'above':'below'} its 200-day average.`;}
    else s+=` Not compared with the ${d} averages: close basis unconfirmed.`;
    if(n.breadth)s+=` ${n.breadth.up} of ${n.breadth.n} S&P 500 names up.`;
    return s;
  }
  function participationSentence(b,sig) {
    const s50=findMetric((b.macro?.participation||b.positioning?.breadth||{}).metrics,/Above 50-session/),share=s50&&isNum(s50.value)?s50.value:null;
    const level=share===null?'':share<50?'; still fewer than half are above it':'; more than half are above it';
    if(sig.status==='broadening')return 'More S&P 500 companies moved above their 50-day average over the past five sessions'+level+'.';
    if(sig.status==='narrowing')return 'Fewer S&P 500 companies are above their 50-day average than five sessions ago'+level+'.';
    if(sig.status==='mixed')return 'The share of companies above their 50-day average was roughly unchanged over five sessions'+level+'.';
    return 'Whether participation is broadening cannot be established from comparable data.';
  }
  function CHANGE_NAMES_FALLBACK(id){return {vix:'VIX previous-session percentage change',us10y:'10-year Treasury yield change in basis points'}[id]||id;}
  const MACRO_IMPORTANCE={FOMC:3,CPI:3,PPI:3,PCE:3,NFP:3,GDP:3,EIA:1};
  // Meaning is always written beside the cue; unknown evidence never receives a favorable color.
  function signalCue(tone) { return {good:'✓',mixed:'△',bad:'!',neutral:'—'}[tone]||'—'; }
  function cue(tone) { return `<span class="signal-icon" data-tone="${esc(tone||'neutral')}" aria-hidden="true">${signalCue(tone)}</span>`; }
  function postureTone(model) { return /^Defensive/.test(model.label)?'bad':model.label==='Supportive conditions'?'good':/incomplete/i.test(model.label)?'neutral':'mixed'; }
  function objectiveTone(x,model) {
    if(x.id==='protect')return /^High/.test(x.word)?'bad':/^Elevated/.test(x.word)?'mixed':/^Low/.test(x.word)?'good':'neutral';
    if(x.id==='income')return model.signals[3].status==='high'||model.signals[0].status==='adverse'?'bad':!model.signals[0].status||!model.signals[3].status?'neutral':'mixed';
    return /^Not rated/.test(x.word)?'neutral':'mixed';
  }
  // Delayed ATM chain context: values as Yahoo returned them with the chain's own retrieval time. A last trade dates only that
  // trade (never the IV or bid/ask); an undated cached sample stays withheld. No IV rank, premium quality or income rating.
  function delayedIv(r) {
    if (!r || r.st?.atm_iv !== 'ok' || !isNum(r.iv)) return {kind: 'missing', text: 'Delayed ATM IV unavailable for this company; realized volatility is not substituted.'};
    if (!r.ivat || !isFinite(Date.parse(r.ivat))) return {kind: 'undated', text: 'A delayed ATM sample is retained, but its own retrieval time is not recorded (older cache). The number is withheld; a build or analyst refresh time cannot date it. Not a contract quote or validated surface.'};
    const legs = (r.ivq || []).filter(q => q && (q.leg === 'call' || q.leg === 'put'));
    return {kind: 'dated', iv: r.iv, expiry: r.ivx, strike: r.ivk, retrieved: r.ivat, spans: r.ivspan === true, legs,
      text: `Delayed ATM IV ${r.iv.toFixed(1)}%${legs.length > 1 ? ' (call/put average)' : ''} · expiry ${r.ivx || 'not returned'} · strike ${isNum(r.ivk) ? r.ivk : 'not returned'} · chain retrieved ${r.ivat.slice(0, 16).replace('T', ' ')} UTC.`};
  }
  function researchBadges(s) {
    const business=s.category.split(' · ')[0],businessTone=business==='Quality research'?'good':s.concerns.some(c=>c.kind==='fundamental')?'bad':'neutral';
    const setupTone=s.setup==='unknown'||s.label==='Trend watch'?'neutral':'mixed';
    return `<span class="signal-badge" data-tone="${businessTone}">${cue(businessTone)}${esc(business)}</span><span class="signal-badge" data-tone="${setupTone}">${cue(setupTone)}${esc(s.label)}</span>${s.event?`<span class="signal-badge" data-tone="mixed">${cue('mixed')}Event watch</span>`:''}`;
  }
  function objectiveModel(model,b,events,core) {
    const risk=model.signals[3].status,price=model.signals[0].status,riskComplete=model.signals[3].coverage==='complete';
    // Only a listed MAJOR macro release or an entered equity's earnings can raise Protect; minor releases stay listed only.
    const trigger=events.items.find(e=>e.kind==='macro'&&e.major===true||e.kind==='earnings'&&e.entered);
    const calendarLimit=events.complete?'Listed calendar sources cover this window.':'Calendar coverage is incomplete for this window.';
    const protectWord=risk==='high'?'High market risk':risk==='elevated'||trigger?'Elevated market/event risk':risk==='normal'&&riskComplete&&events.complete?'Low market/event risk':'Not fully assessed';
    const eligible=(b.shortlist||[]).filter(x=>['growth','profitability','valuation'].every(k=>['ok','strong','weak'].includes(x.status?.[k])));
    const setups=eligible.map(x=>({t:x.t,...researchSetup(x,core?.rows?.find(r=>r.t===x.t),{session:b.asof_session,events})}));
    const lead=setups.find(x=>x.setup==='pullback')||setups.find(x=>x.concerns.length)||setups.find(x=>x.setup!=='unknown');
    const incomeWord=risk==='high'||risk==='elevated'||price==='adverse'?'Downside first':trigger?'Event-sensitive research':price==='supportive'&&risk==='normal'&&riskComplete?'Research covered calls selectively':'Selective covered-call research';
    const incomeSummary=risk==='high'||price==='adverse'?'Selling calls leaves share downside; wait for the market and holding thesis to stabilize.':trigger?`${trigger.title} falls inside this ${events.days}-calendar-day window; check whether an expiry crosses it.`:risk==='elevated'?'Elevated market risk: research calls only on shares you would keep through a decline, at a sale price you would accept.':price==='supportive'?'An uptrend supports researching calls on shares you would keep, only at an exit price you would accept.':'Mixed or unconfirmed trend: research calls only on shares you would keep through a decline, at an acceptable sale price.';
    return [
      {id:'protect',title:'Protect',word:protectWord,summary:(trigger?`${trigger.title} is listed in this ${events.days}-calendar-day window. `:risk==='elevated'||risk==='high'?model.signals[3].qty+' ':`No major release or entered-equity earnings is listed in this ${events.days}-calendar-day window. `)+(risk==='high'||price==='adverse'?'Review entered-equity concentration and downside before adding exposure.':'Check entered equities against events before choosing an expiry.'),limit:'Options positions are not covered. '+calendarLimit,target:'my-risk'},
      {id:'income',title:'Income',word:incomeWord,summary:incomeSummary,limit:'Premium quality not rated — delayed IV is context only. '+(events.complete?'':'Calendar coverage incomplete.'),target:'income'},
      {id:'growth',title:'Growth',word:risk==='high'||price==='adverse'?'Wait — review conditions first':eligible.length?'Selective research':'Not rated — company evidence incomplete',summary:lead?`${lead.t} — ${lead.concern.measured?lead.concern.text:lead.signal} ${lead.wait}`:'Business quality alone does not confirm entry timing; inspect dated trend and valuation before adding exposure.',limit:model.coverage==='Coverage incomplete'?'Wider market evidence is incomplete; this list does not establish favorable timing.':'Research eligibility does not establish favorable timing or allocation.',target:'opportunity'}];
  }
  function researchCategory(x,eventWatch,setup) {
    const s=x.status||{},required=['growth','profitability','valuation'].every(k=>['strong','ok','weak'].includes(s[k]));
    return (required&&['growth','profitability','cash','resilience'].filter(k=>s[k]==='strong').length>=2&&!['growth','profitability','cash','resilience'].some(k=>s[k]==='weak')?'Quality research':'Research watch')+(setup?' · '+setup.label:'')+(eventWatch?' · Event watch':'');
  }
  // One completed-session setup/concern model for cards, dossiers, evidence and public chat.
  // core.spark is explicitly the last <=63 adjusted closes. Never mix it with live/unadjusted prices,
  // fill gaps, infer quarterly SPY performance, or reuse the historical screener's technical labels.
  function researchSetup(short,r,opts) {
    opts=opts||{};const c=opts.company,cards=c?.cards||{},session=opts.session||r?.pxd;
    const concerns=[],metrics=[],add=(kind,text,ms,wait,card)=>concerns.push({kind,text,metrics:ms||[],wait,card:card||null,measured:true});
    const ct=short?.counter?.text||cards.counter?.line,cm=short?.counter?.metrics||cards.counter?.metrics||[];
    const measured=ct&&!/no weak area|no contrary|no counterargument|not available|unavailable/i.test(ct);
    const weak=CARD_ORDER.slice(0,6).find(k=>(short?.status?.[k]||cards[k]?.status)==='weak');
    if(measured)add('fundamental',ct,cm,'Wait for the weak business measure to improve in a new report.','counter');
    else if(weak)add('fundamental',`${CARD_NAME[weak]}: ${cards[weak]?.line||'rated weak in the dated business assessment.'}`,cards[weak]?.metrics||[],`Watch the next ${CARD_NAME[weak].toLowerCase()} report before treating the business case as repaired.`,weak);
    const validDate=/^\d{4}-\d{2}-\d{2}$/.test(session||'')&&r?.pxd===session;
    const samples=r?.spark,usable=validDate&&r?.st?.price==='ok'&&Array.isArray(samples)&&samples.length>=50&&samples.length<=63&&samples.every(v=>isNum(v)&&v>0);
    const metric=(label,value,unit,period,note)=>({label,value,unit,period,asof:session,source:'Yahoo Finance via yfinance · retained core.json',source_url:`https://finance.yahoo.com/quote/${encodeURIComponent(r?.t||short?.t||'')}/history/`,note});
    let setup='unknown',label='Timing unconfirmed',wait='Wait for comparable completed-session trend evidence.',gap=null;
    if(usable){
      const close=samples[samples.length-1],avg=samples.slice(-50).reduce((a,v)=>a+v,0)/50;gap=100*(close/avg-1);
      metrics.push(metric('Adjusted close',close,'USD/share',session,'Last retained adjusted close; not a live price.'),metric('50-session adjusted average',avg,'USD/share',`50 sessions to ${session}`,'Mean of last 50 core.spark values; adjusted prices, rounded to cents in the export. No 200-session or quarterly relative-performance inference.'));
      metrics.push(metric(`Adjusted close distance ${gap<0?'below':'above'} 50-session average`,Math.abs(gap),'%',`50 sessions to ${session}`,'Absolute value of 100 × (last adjusted close / mean of last 50 adjusted closes − 1); the label records below or above.'));
      if(gap<0){setup='pullback';label='Pullback — wait';wait='Watch for a completed close back above that average; a falling price alone is not a bargain.';add('technical',`Technical: adjusted close ${Math.abs(gap).toFixed(1)}% below its 50-session average.`,metrics,wait);}
      else if(gap>=8){setup='extended';label='Extended — watch';wait='Wait for the gap to narrow or for a new business report to justify the price.';add('technical',`Technical: adjusted close ${gap.toFixed(1)}% above its 50-session average; extension adds entry risk.`,metrics,wait);}
      else{setup='trend';label='Trend watch';wait='Watch whether completed closes hold above that average; timing remains unconfirmed.';}
    }
    if(validDate&&r?.st?.price==='ok'&&r?.st?.pe_forward==='ok'&&isNum(r.pef)&&r.pef>0&&isNum(r.pef_sec_rel)&&r.pef_sec_rel>=1.25){
      const ms=[metric('Forward P/E / sector median',r.pef_sec_rel,'x',session,'Dated forward P/E divided by broad-sector median; not own-history valuation or a curated peer group.'),metric('Forward P/E',r.pef,'x',session,'Uses analyst earnings estimates at the retained close; not a live valuation.')];
      add('valuation',`Valuation: forward P/E ${r.pef_sec_rel.toFixed(2)}× its sector median.`,ms,'Watch whether earnings estimates catch up or the valuation premium narrows.');
      if(setup==='trend'){label='Valuation watch';wait=concerns[concerns.length-1].wait;}
    }
    const event=(opts.events?.items||[]).find(e=>e.kind==='earnings'&&e.t===(r?.t||short?.t));
    const eventText=event?`${event.title} on ${event.date||String(event.when).slice(0,10)} falls inside the ${opts.events.days}-day window; an expiry across it carries gap risk.`:'';
    const concern=concerns[0]||{kind:'coverage',text:'No adverse business or price signal established by these limited inputs; timing is not cleared.',metrics:[],measured:false,card:null};
    const eventMetrics=event?[{label:event.title+` · ${opts.events.days}-day horizon`,value:event.date||event.when,unit:'date',period:`${opts.events.today||'selected start'} to ${opts.events.end||'selected end'}`,asof:event.retrieved||'',source:event.source||r?.ers||'Retained earnings calendar',note:'Provider next earnings date; event risk, not a fundamental objection. Calendar completeness is not implied.'}]:[];
    const signal=gap===null?'Comparable trend evidence unavailable.':`Technical: adjusted close ${Math.abs(gap).toFixed(1)}% ${gap<0?'below':'above'} its 50-session average.`;
    return {t:r?.t||short?.t,setup,label,gap,signal,session,concerns,concern,metrics,wait:concerns[0]?.wait||wait,event:eventText,eventMetrics,category:researchCategory(short||{status:Object.fromEntries(Object.entries(cards).map(([k,v])=>[k,v.status]))},!!event,{label})};
  }
  // Today's market reading from dated comparable changes. Never a directional word without both observations.
  function marketRead(b) {
    const spy = changeItem(b, 'spy_1d'), br = changeItem(b, 'breadth_50_5d'), gap = changeItem(b, 'eq_cap_gap_5d');
    const level = (b && b.positioning && b.positioning.breadth && b.positioning.breadth.level) || 'mixed';
    const parts = [];
    if (spy && spy.status === 'ok') parts.push(`SPY ${spy.pct_change >= 0 ? 'rose' : 'fell'} ${Math.abs(spy.pct_change).toFixed(2)}% on ${shortDate(spy.current.date)}`);
    if (br && br.status === 'ok') parts.push(`stocks above their 50-day average ${br.change >= 0 ? 'rose' : 'fell'} ${Math.abs(br.change).toFixed(1)} pp in five sessions`);
    else parts.push(`participation is ${level}; its five-session change is unavailable`);
    const headline = cap1(parts.join('; ')) + '.';
    const changed = [];
    if (gap && gap.status === 'ok') changed.push({text: `Equal-weight ${gap.current.value >= 0 ? 'led' : 'trailed'} cap-weight by ${Math.abs(gap.current.value).toFixed(2)} pp over 20 sessions, versus ${pp(gap.prior.value)} on ${shortDate(gap.prior.date)}.`, ev: {kind: 'change', id: gap.id}});
    const sec = b && b.daily_changes && b.daily_changes.sectors;
    if (sec && sec.status === 'ok') changed.push({text: `${sec.leader.sector} led (${pct(sec.leader.ret_pct)}) and ${sec.laggard.sector} trailed (${pct(sec.laggard.ret_pct)}) on ${shortDate(sec.to_date)}, cap-weighted.`, ev: {kind: 'change', id: 'sectors'}});
    return {headline, changed: changed.slice(0, 2), unavailable: !b || !b.daily_changes ? 'Comparable changes are not in this data build; showing the latest state only.' : b.daily_changes.status === 'unavailable' ? b.daily_changes.reason : ''};
  }
  // One visible support and challenge: measured assessment lines plus dated changes, each with its comparison.
  function supportChallenge(b) {
    const p = (b && b.pulse) || {}, sup = [], ch = [];
    (p.supports || []).forEach((x, i) => sup.push({text: x.text, ev: {kind: 'pulse', id: 'supports', i}}));
    (p.challenges || []).forEach((x, i) => ch.push({text: x.text, ev: {kind: 'pulse', id: 'challenges', i}}));
    const br = changeItem(b, 'breadth_50_5d'), gap = changeItem(b, 'eq_cap_gap_5d'), spy = changeItem(b, 'spy_1d');
    if (br && br.status === 'ok' && br.direction !== 'flat') (br.direction === 'up' ? sup : ch).push({text: `Stocks above their 50-day average: ${br.prior.value.toFixed(1)}% on ${shortDate(br.prior.date)} → ${br.current.value.toFixed(1)}% on ${shortDate(br.current.date)}.`, ev: {kind: 'change', id: br.id}});
    if (gap && gap.status === 'ok' && gap.direction !== 'flat') (gap.direction === 'up' ? sup : ch).push({text: `Equal- minus cap-weight 20-session gap moved from ${pp(gap.prior.value)} to ${pp(gap.current.value)} since ${shortDate(gap.prior.date)}.`, ev: {kind: 'change', id: gap.id}});
    if (spy && spy.status === 'ok' && spy.direction !== 'flat') (spy.direction === 'up' ? sup : ch).push({text: `SPY closed ${pct(spy.pct_change)} on ${shortDate(spy.current.date)} versus the prior session.`, ev: {kind: 'change', id: spy.id}});
    return {supports: sup, challenges: ch};
  }
  const CARD_ORDER = ['growth', 'profitability', 'cash', 'resilience', 'valuation', 'expectations', 'counter'];
  const CARD_Q = {growth: 'Is the business growing?', profitability: 'Is it profitable, and is that improving?', cash: 'Does profit turn into cash?', resilience: 'Can it carry its obligations?', valuation: 'What are you paying for it?', expectations: 'Are estimates being revised up or down?', counter: 'What is the strongest measured objection?'};
  const CARD_NAME = {growth: 'Growth', profitability: 'Profitability', cash: 'Cash generation', resilience: 'Financial resilience', valuation: 'Valuation', expectations: 'Estimate revisions', counter: 'Counterargument'};
  // Research case shares its objection with the setup model; business coverage stays separate.
  function caseFor(c, short, r, opts) {
    const cards = (c && c.cards) || {}, live = k => cards[k] && cards[k].status !== 'unavailable';
    const strong = CARD_ORDER.slice(0, 6).filter(k => cards[k] && cards[k].status === 'strong');
    const positive = short && short.why && short.why[0] ? {text: short.why[0].text, card: null} : strong.length ? {text: cards[strong[0]].line, card: strong[0]} : null;
    const missing = CARD_ORDER.slice(0, 6).filter(k => !live(k)).map(k => CARD_NAME[k].toLowerCase());
    const setup=researchSetup(short,r,{...opts,company:c});
    const objection=setup.concern;
    const ert = r && (r.ert === 'BMO' ? ' before the open' : r.ert === 'AMC' ? ' after the close' : ', time not confirmed');
    return {positive, objection, setup, coverage: missing, event: r && r.er ? `Earnings expected ${shortDate(r.er)}${ert} (provider date)` : 'No upcoming earnings date supplied'};
  }
  // Events inside an N-day ET horizon from the retained calendars. Date-only items stay dates; coverage stays explicit.
  function eventsInHorizon(core, b, nowMs, days, opts) {
    opts = opts || {};
    const today = etDate(nowMs), end = addDays(today, days), items = [];
    ((core && core.calendar) || []).forEach(e => {
      if (e.status === 'released' || !e.scheduled_et) return;
      const t = Date.parse(e.scheduled_et), timed = /T\d/.test(e.scheduled_et), d = timed && isFinite(t) ? etDate(t) : String(e.scheduled_et).slice(0, 10);
      if (d < today || d > end || (timed && t < nowMs)) return;
      const importance = MACRO_IMPORTANCE[e.type] || 1;   // same rule as the brief build; unknown types are not major
      items.push({kind: 'macro', when: e.scheduled_et, date: d, timing: timed ? 'timed' : 'date_only', title: e.title || e.type, type: e.type, source_url: e.source_url, note: e.note || 'Scheduled; timing can change', relevant: true, importance, major: importance === 3});
    });
    const watch = opts.watch || new Set(), big = opts.big || new Set(), entered=opts.entered||new Set();
    ((core && core.rows) || []).forEach(r => {
      if (!r.er || r.er < today || r.er > end) return;
      const ert = r.ert === 'BMO' || r.ert === 'AMC' ? r.ert : null;
      if (r.er === today && ert === 'BMO' && etHour(nowMs) >= 10) return;   // threshold choice shared with the build
      items.push({kind: 'earnings', when: r.er, date: r.er, timing: ert ? ert.toLowerCase() : 'date_only', title: r.t + ' earnings', t: r.t, source: r.ers, retrieved: r.rat,
        relevant: watch.has(r.t) || entered.has(r.t) || big.has(r.t) || opts.ticker === r.t, saved: watch.has(r.t),entered:entered.has(r.t)});
    });
    const rank = x => x.kind === 'macro' ? 0 : 1;
    items.sort((a, x) => a.date.localeCompare(x.date) || rank(a) - rank(x) || String(a.when).localeCompare(String(x.when)));
    const cov = b && b.calendar_coverage, macroSrc = cov && (cov.sources || []).find(s => s.kind === 'macro');
    const listedEnd = macroSrc && macroSrc.latest_listed, notes = [];
    if (!cov) notes.push('Calendar coverage is not recorded in this data build; an empty list does not mean nothing is scheduled.');
    else {
      if (cov.status === 'expired' || cov.status === 'unavailable') notes.push(`Release calendar coverage ${cov.status === 'expired' ? 'has expired' : 'is unavailable'}; upcoming releases cannot be listed.`);
      else notes.push(`Release-calendar completeness is unknown for this ${days}-day window: no provider supplies a coverage range, so releases can be missing on any date${listedEnd ? `. The latest listed release is ${shortDate(listedEnd)} (a list observation, not a boundary)` : ''}.`);
      notes.push('Earnings show each company’s next provider date only, mostly without a time of day.');
      (cov.gaps || []).forEach(g => notes.push(cap1(String(g).replace(/^([a-z]+): /i, (m, k) => k.toUpperCase() + ': '))));
    }
    // Complete only when every calendar source declares a coverage range spanning the whole window.
    const complete = !!cov && cov.status === 'ok' && (cov.sources || []).length > 0 && !(cov.gaps || []).length && cov.sources.every(s => s.range_start && s.range_end && s.range_start <= today && s.range_end >= end);
    if (complete) notes.splice(0, notes.length, `Listed calendar sources declare coverage for ${shortDate(today)} to ${shortDate(end)}.`, 'Earnings show each company’s next provider date only, mostly without a time of day.');
    return {today, end, days, items, relevant: items.filter(x => x.relevant), notes, complete};
  }
  // Compare: the originating question for the seeded series.
  function compareQuestion(ids, labels) {
    const L = id => labels[id] || id.replace(/^\w+:/, '');
    const eq = ids.filter(i => i.startsWith('eq:')), sec = ids.filter(i => i.startsWith('sec:')), mac = ids.filter(i => i.startsWith('mac:'));
    if (ids[0] === 'eq:RSP' && ids.includes('eq:SPY')) return {type: 'breadth', q: 'Is the average S&P stock keeping pace with the largest companies?'};
    if (eq[0] && eq[0] !== 'eq:SPY' && ids.includes('eq:SPY')) return {type: 'company', q: `Has ${L(eq[0])} outperformed the market${sec.length ? ' and its sector' : ''}?`};
    if (sec.length && mac.length) return {type: 'macro', q: `How has the ${L(sec[0])} basket moved with ${L(mac[0])}?`};
    if (eq.length && mac.length) return {type: 'macro', q: `How has ${L(eq[0])} moved with ${L(mac[0])}?`};
    if (sec.length >= 2) return {type: 'sectors', q: `How have ${L(sec[0])} and ${L(sec[1])} compared?`};
    if (ids.length >= 2) return {type: 'pair', q: `How has ${L(ids[0])} moved with ${L(ids[1])}?`};
    return {type: 'single', q: ids.length ? `What has ${L(ids[0])} done over this range?` : 'Choose series to compare.'};
  }
  // Fifty-two-week position from the accepted price and the retained range.
  function rangePos(cur, r) {
    if (!cur || !isNum(cur.px) || !r || !isNum(r.lo) || !isNum(r.hi)) return null;
    const lo = Math.min(r.lo, cur.px), hi = Math.max(r.hi, cur.px);
    return hi > lo ? {pos: 100 * (cur.px - lo) / (hi - lo), lo, hi} : null;
  }

  const API = {currentMessage,focusImpact,unitValue,macroGroupLine,macroWords,takeaway,nowVsClose,nowText,coherentPair,delayedIv,signalCue,postureTone,objectiveTone,researchSetup,researchCategory,normalizedSignals,ptClock,posture,sessionComparison,todayModel,objectiveModel,catalogNote, concentrationInsight, leadershipInsight, macroInsight, basketMoves, liveConcentration, corrWord, valuationText, counterpoint, sessionWord, sectorSensitivity, factorSentence, liveBreadth, vsAverages, route, median, FACTORS, pct, px, assessments, marketRead, supportChallenge, caseFor, eventsInHorizon, compareQuestion, rangePos, addDays, CARD_ORDER, CARD_Q};
  if (typeof module !== 'undefined' && module.exports) { module.exports = API; return; }
  root.SmartOptionsMain = API;
  const doc = root.document; if (!doc) return;

  /* ------------------------------------------------------------ page */
  const ASSET_V = 'client-20261019-cockpit6';
  const Live = root.SmartOptionsLive;
  const S = root.__soMainState = {core: null, brief: null, rel: null, rowMap: new Map(), slots: [], view: null, chart: null, company: {}, onQuote: null};
  const $ = s => doc.querySelector(s);
  const q = t => Live.get(t);
  const row = t => S.rowMap.get(t) || null;
  const learnHref=label=>'#/learn/'+encodeURIComponent(label);
  const learnLink=(label,text)=>`<a class="learn" href="${learnHref(label)}" aria-label="Explain ${esc(label)}">${esc(text||label)}</a>`;
  const liveSpan = (t, f, quiet) => `<a class="learn" href="${learnHref((f==='price'?'Price':'Daily return')+' · '+t)}" aria-label="Explain ${esc(t)} ${f}"><span data-live="${esc(t)}" data-live-f="${f}"${quiet?' data-live-quiet':''}></span></a>`;
  function slot(id, fn) { S.slots.push({id, fn}); return `<span class="slot" id="${id}">${fn()}</span>`; }
  function paintSlots() { S.slots.forEach(s => { const el = doc.getElementById(s.id); if (el) { const h = s.fn(); if (el.innerHTML !== h) {
    if(s.id==='heat' && el.querySelector('svg')) {const tmp=doc.createElement('div');tmp.innerHTML=h;el.querySelectorAll('[data-sector]').forEach(a=>{const newer=[...tmp.querySelectorAll('[data-sector]')].find(x=>x.dataset.sector===a.dataset.sector);if(newer){a.setAttribute('aria-label',newer.getAttribute('aria-label'));a.querySelector('rect').setAttribute('fill',newer.querySelector('rect').getAttribute('fill'));a.querySelectorAll('text,title').forEach((t,i)=>t.textContent=newer.querySelectorAll('text,title')[i].textContent);}});
      el.querySelectorAll('[data-sector-link]').forEach(a=>{const newer=[...tmp.querySelectorAll('[data-sector-link]')].find(x=>x.dataset.sectorLink===a.dataset.sectorLink);if(newer)a.querySelector('b').textContent=newer.querySelector('b').textContent;});
      const basis=el.querySelector('.map-basis'),fresh=tmp.querySelector('.map-basis');if(basis?.firstChild&&fresh?.firstChild)basis.firstChild.textContent=fresh.firstChild.textContent;
    }
    else el.innerHTML = h;
  } } }); }
  // Price histories are immutable within a data session: one request per ticker, shared by chart, drivers and Compare.
  const pxCache = new Map();
  function pxJson(tk) { const u = `data/px/${encodeURIComponent(tk)}.json`; if (!pxCache.has(u)) { const pr = json(u); pxCache.set(u, pr); pr.catch(() => {if(pxCache.get(u)===pr)pxCache.delete(u);}); } return pxCache.get(u); }
  async function json(url) { const r = await fetch(url, {cache: 'no-store'}); if (!r.ok) throw new Error(url + ' HTTP ' + r.status); return r.json(); }
  const source = m => m && m.source_url ? `<a href="${esc(m.source_url)}" target="_blank" rel="noopener">${esc(m.source || 'source')}</a>` : esc(m && m.source || '');
  function metricValue(m) {
    if (!m || m.value == null) return 'n/a';
    const v = m.value, u = m.unit || '';
    if (/^(millions?|billions?|trillions?) USD$/i.test(u)) return esc(unitValue(v, u)) + `<small class="dim"> (raw ${esc(v.toLocaleString('en-US'))} ${esc(u)})</small>`;
    if (!isNum(v)) return esc(v);
    if (u === '%' || /^% /.test(u)) return pct(v, 1).replace(/^\+/, v > 0 && /growth|change|vs|versus/i.test(m.label) ? '+' : '');
    if (u === 'pp') return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + ' pp';
    if (u === 'x') return v.toFixed(2) + '×';
    if (u === 'USD') return '$' + big(v);
    if (u === 'USD/share') return px(v);
    if (u === 'bps') return v.toFixed(0) + ' bp';
    return (Math.abs(v) >= 1e5 ? big(v) : +v.toFixed(2)) + (u && !/revisions/.test(u) ? ' ' + esc(u) : '');
  }
  function metricTable(ms, bare, context) {
    ms = (ms || []).filter(m => m && m.label);
    if (!ms.length) return '';
    const key=m=>m.label+(context?' · '+context:S.view==='company'?' · '+route(root.location.hash).t:'');
    ms.forEach(m=>{S.metricEvidence ||= new Map();S.metricEvidence.set(key(m),m);while(S.metricEvidence.size>256)S.metricEvidence.delete(S.metricEvidence.keys().next().value);});
    const table = `<table>${ms.map(m => {const o=Object.values(S.core?.macro||{}).flat().find(o=>o.label===m.label),observation=m.observation_date||o?.date,refresh=m.retrieved_at||o?.retrieved_at;return `<tr><td>${learnLink(key(m),m.label)}</td><td class="n">${metricValue(m)}</td><td class="dim">Observation/period: ${esc(observation||m.period||'unavailable')}<br>Last refreshed: ${esc(refresh||'not supplied separately')}${!refresh&&m.asof?`<br>Published as-of (clock unspecified): ${esc(m.asof)}`:''}</td><td class="dim">${source(m)}<br>Method: ${esc(m.note||'Retained provider measurement; formula not separately supplied')}</td></tr>`;}).join('')}</table>`;
    return bare ? table : `<details class="src"><summary>Inputs and sources</summary>${table}</details>`;
  }
  const NAV_OF = {company: 'markets', companies: 'markets', sector: 'markets', markets: 'markets', explore: 'workspace', room: 'workspace', positions: 'workspace', workspace: 'workspace', macro: 'macro', brief: 'brief'};
  function setView(name) {
    name = NAV_OF[name] || name;
    doc.querySelectorAll('#nav a').forEach(a => { a.classList.toggle('on', a.dataset.v === name); if (a.dataset.v === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  }
  // Bounded session back stack. Detaching actual DOM preserves controls, chart
  // instances and their internal zoom/crosshair state, including unsaved typing.
  const frames = new Map(); const frameEpoch = Date.now().toString(36) + Math.random().toString(36).slice(2, 9); let frameId = null, frameSerial = 0;
  const persistentKeys = new Set(['focus','focusDraft','sitCtl','sitModel','ensureChat','patResult','patScan','wsLast','wsTool','scanSort','core','brief','rel','relError','rowMap','company','metricEvidence','generation','genPending','genNote','refreshGeneration']);
  function saveFrame() {
    if (!frameId || !$('#view').firstChild) return;
    const frame = {gen:S.generation||0, nodes:[...$('#view').childNodes], state:{}, y:root.scrollY, focus:doc.activeElement,
      watch:Object.fromEntries(['explore','company','research','index','investor','dashboard'].map(k=>[k,[...(Live._state.owners[k]||[])]]))};
    Object.keys(S).filter(k=>!persistentKeys.has(k)).forEach(k=>{frame.state[k]=S[k];});
    frames.delete(frameId);frames.set(frameId,frame);
    try{S.mod?.suspend?.();}catch(e){console.warn('[brief] tool suspend failed',e.message);}
    frame.nodes.forEach(n=>n.remove());
    while (frames.size>12) {
      const k=frames.keys().next().value, old=frames.get(k); frames.delete(k);
      ['chart','exChart','exRc'].forEach(c=>{try {old.state[c]?.remove();} catch(e) { console.warn('Discarded chart could not be released'); }});try{old.state.news?.destroy();old.state.fv?.destroy();old.state.mod?.destroy?.();}catch(e){console.warn('Discarded company chart could not be released');}
    }
  }
  function backControl(main) {
    if (['brief','markets','workspace','macro'].includes(S.view)) return;
    const el=doc.createElement('div');el.className='depth-nav';
    el.innerHTML='<button type="button" data-depth-back>← Back</button><a href="#/">Today</a><span class="dim"> / '+esc(S.view==='company' ? 'Company' : S.view==='sector' ? 'Sector' : S.view==='explore' ? 'Compare' : S.view==='companies' ? 'Companies' : S.view==='macro' ? 'Macro' : S.view==='room' ? 'Saved rooms' : S.view==='positions' ? 'Positions' : S.view)+'</span>';
    main.prepend(el);
    el.querySelector('button').onclick=()=>{if(root.history.state?.soParent)root.history.back();else root.location.hash='#/';};
  }
  function render() {
    closeSheet();
    S.sitCtl?.stop?.();
    if(S.view==='brief'){S.personal?.suspend();S.news?.suspend();}
    const previous=frameId;
    saveFrame();
    frameId=root.history.state?.soFrame || 'depth-'+frameEpoch+'-'+(++frameSerial);
    root.history.replaceState({...root.history.state,soFrame:frameId,soParent:root.history.state?.soParent || (previous!==frameId ? previous : null)},'');
    if(S.genPending)adoptPending();
    let cached=frames.get(frameId);
    // A view saved under an older data generation is redrawn from the adopted one instead of restored.
    if(cached&&cached.gen!==(S.generation||0)){frames.delete(frameId);try{['chart','exChart','exRc'].forEach(c=>cached.state[c]?.remove());cached.state.news?.destroy();cached.state.fv?.destroy();cached.state.mod?.destroy?.();}catch(e){console.warn('Older-generation view could not be released');}cached=null;}
    if(cached) {
      frames.delete(frameId);
      Object.keys(S).filter(k=>!persistentKeys.has(k)).forEach(k=>{delete S[k];});Object.assign(S,cached.state);
      if(S.horizon)UI.horizon=S.horizon;   // the restored view's visible horizon is the selected one
      $('#view').replaceChildren(...cached.nodes);setView(S.view==='company'?'companies':S.view);
      S.fv?.updateTheme?.();try{S.mod?.resume?.();}catch(e){console.warn('[brief] tool resume failed',e.message);}
      const personalFocus=cached.focus?.closest?.('[data-personal-t]')?.dataset.personalT,personalHref=cached.focus?.getAttribute?.('href'),personalControl=cached.focus?.dataset?.personal;
      if(S.view==='brief'){S.personal?.refresh();S.news?.resume();}
      Object.entries(cached.watch).forEach(([owner,names])=>{if(owner!=='investor'||S.view!=='brief')Live.watch(owner,names);});
      if(S.view==='explore')updateExploreQuotes();
      Live.paint(doc,null);paintSlots();syncSituation();paintFocus();
      requestAnimationFrame(()=>{root.dispatchEvent(new Event('resize'));let focus=cached.focus;
        if(!focus?.isConnected&&personalFocus)focus=[...doc.querySelectorAll('[data-personal-t]')].find(n=>n.dataset.personalT===personalFocus)?.querySelectorAll('a');
        if(focus&&typeof focus.focus!=='function')focus=[...focus].find(n=>n.getAttribute('href')===personalHref);
        if(!focus?.isConnected&&personalControl)focus=[...doc.querySelectorAll('[data-personal]')].find(n=>n.dataset.personal===personalControl);
        if(!focus?.isConnected&&cached.focus?.id)focus=doc.getElementById(cached.focus.id);
        focus?.focus?.({preventScroll:true});root.scrollTo(0,cached.y);});
      return;
    }
    const r = route(root.location.hash);
    S.slots = []; S.onQuote = null; S.exToken = (S.exToken || 0) + 1; S.exChart=null;S.exRc=null;S.chart=null;S.exSeries=[];S.jointChart=null;S.jointBand=[];S.coTab=null;S.co=null;S.fv=null;S.drv=null;S.coDraw=null;S.news=null;S.mod=null;S.horizon=UI.horizon;S.lastEvents={};
    if (r.view !== 'brief') Live.watch('investor', []);
    if (r.view !== 'explore') Live.watch('explore', []);
    if (r.view !== 'room') Live.watch('dashboard', []);
    if (r.view !== 'markets') Live.watch('markets', []);
    if (r.view !== 'workspace') Live.watch('strategy', []);
    S.view = r.view; setView(r.view === 'company' ? 'companies' : r.view);
    const main = $('#view');
    try {
      if (r.view === 'company') { main.innerHTML = '<p class="dim">Loading…</p>'; renderCompany(r.t, main); }
      else if (r.view === 'positions') root.SmartOptionsInvestor.mountPositions(main, investorArgs(), S.positionTicker || '');
      else if (r.view === 'companies') renderCompanies(main);
      else if (r.view === 'macro') renderMacro(main);
      else if (r.view === 'explore') renderExplore(main, r.hash);
      else if (r.view === 'sector') renderSector(main,r.sector);
      else if (r.view === 'markets') renderMarkets(main,r.query,r.sector);
      else if (r.view === 'workspace') renderWorkspace(main,r.tool,r.query);
      else if (r.view === 'learn') renderLearn(main,r.label);
      else if (r.view === 'room') renderRoom(main);
      else renderBrief(main, r.legacy);
    } catch (e) { main.innerHTML = `<p role="alert">This view could not be drawn from the published data (${esc(e.message)}). <a href="#/">Return to Today</a> or reload.</p>`; console.error(e); }
    if (['explore','room','positions'].includes(r.view)) main.prepend(wsRail(r.view === 'explore' ? 'compare' : r.view === 'room' ? 'rooms' : 'positions', S.wsLast || ''));
    Live.paint(doc, null);
    backControl(main);
    root.scrollTo(0, 0);
    syncSituation();paintFocus();
  }

  /* ------------------------------------------------------------ unified shell: services, Markets, Workspace, situation */
  // Shared public history service: published px files first, then the public instrument relay. Deduped, two at a time.
  const histQueue = []; let histActive = 0;
  function histSlot(fn) { return new Promise((resolve, reject) => { histQueue.push({fn, resolve, reject}); pumpHist(); }); }
  function pumpHist() { while (histActive < 2 && histQueue.length) { const j = histQueue.shift(); histActive++; j.fn().then(j.resolve, j.reject).finally(() => { histActive--; pumpHist(); }); } }
  const histMemo = new Map();
  function historyFor(t) {
    t = String(t || '').toUpperCase();
    if (histMemo.has(t)) return histMemo.get(t);
    const known = row(t) || root.SmartOptionsInstruments?.RETAINED?.[t];
    const pr = histSlot(async () => {
      if (known) { const p = await pxJson(t); return {bars: p.bars, source: 'Published daily bars (' + (p.prov || 'Yahoo Finance via yfinance') + ')', basis: 'published daily closes'}; }
      const I = root.SmartOptionsInstruments; if (!I) throw new Error('instrument service unavailable');
      const d = await I.history(t); return {bars: d.bars, source: 'Yahoo Finance chart via the public instrument relay, retrieved ' + (d.retrieved_at || 'time unavailable') + (d.status === 'stale' ? ' (retained after a failed refresh)' : ''), basis: d.basis};
    });
    histMemo.set(t, pr); pr.catch(() => {if(histMemo.get(t)===pr)histMemo.delete(t);});
    while (histMemo.size > 80) histMemo.delete(histMemo.keys().next().value);
    return pr;
  }
  async function identify(t) {
    t = String(t || '').toUpperCase(); const r = row(t);
    if (r) return {symbol: t, name: r.n, type: 'EQUITY', sector: r.sec, category: r.sec, mcap: r.mcap, ret: {d1: r.d1, d5: r.d5, m1: r.m1}, date: r.pxd, source: 'Published core rows'};
    const I = root.SmartOptionsInstruments; if (!I) throw new Error('instrument service unavailable');
    const a = await I.resolve(t);
    if (a.source === 'published') return {symbol: t, name: a.name, type: 'ETF', category: 'Unclassified', mcap: null, ret: {}, date: null, source: 'Published daily closes'};
    return {symbol: a.symbol, name: a.name, type: a.type, sector: a.type === 'EQUITY' ? 'Unclassified' : null, category: 'Unclassified', mcap: null, ret: {}, date: null, source: 'Yahoo Finance search via the public instrument relay (' + (a.exchange || 'US') + ')'};
  }
  function instrumentHref(t) {
    const M=root.SmartOptionsMarkets,current=S.view==='markets'&&S.mod?.state?S.mod.state():null;
    if(current&&M){const clean={};Object.keys(M.DEFAULT).forEach(k=>clean[k]=current[k]);return M.encodeState({...clean,sel:t});}
    return '#/markets?sel='+encodeURIComponent(t);
  }
  const compareHash = ids => W.encodeHash({s: [...new Set(ids)].slice(0, 6).map(id => ({id})), r: '6m', m: ids.length > 1 ? 'pct' : 'raw'});
  function roomStore() {
    // Rebuilt per save so newly pinned fund identities are part of the validation universe.
    const p = Promise.all(['chat/universe.js', 'chat/dashboard.js'].map(loadAsset)).then(() => root.SmartOptionsDashboardSpec.createStore(root.localStorage, root.SmartOptionsInstruments.roomUniverse(root.SmartOptionsUniverse.rows.map(r => r[0])), (st, stage, detail) => console.warn('[rooms ' + st + '] ' + detail)));
    return p;
  }
  // Explicit save: typed create_room, no AI call. Room widgets are company-shaped, so funds are refused honestly.
  // Funds are pinned to the device identity store first (readback-verified), then the typed room is created.
  // Fund rooms get price, history and news widgets; company case/events/sensitivity apply only to companies.
  function saveRoom(ids, opts) {
    const I = root.SmartOptionsInstruments, ts = [...new Set(ids.map(t => I.symbol(t)))].filter(Boolean);
    if (!ts.length) return {ok: false, error: 'Select at least one asset.'};
    if (ts.length > 4) return {ok: false, error: 'A room holds up to four assets. Remove ' + (ts.length - 4) + '.'};
    const unknown = ts.filter(t => !row(t) && !I.get(t));
    if (unknown.length) return {ok: false, error: `${unknown.join(', ')} has no validated identity on this device yet; open it from search first.`};
    try { ts.filter(t => !row(t)).forEach(t => I.pin(I.get(t))); } catch (e) { return {ok: false, error: 'Room not saved: ' + e.message}; }
    const name = ts.join(' · ') + ' ' + new Date().toISOString().slice(5, 16).replace('T', ' ');
    const out = {ok: true, name, pending: roomStore().then(st => st.execute({schema: 'smartoptions.dashboard-action.v1', action: 'create_room', name, assets: ts, ...(opts?.focus ? {focus: opts.focus} : opts?.assumption ? {focus:{id:'model:'+opts.assumption.factor,kind:'observed',label:'Published factor sensitivities with an explicit what-if assumption',at:S.core.asof_session,source:'Published historical factor fit',assets:ts,assumption:opts.assumption}} : {})}))};
    out.pending.catch(e => { const n = doc.querySelector('.mk-tray-note,.mk-insp-note'); if (n) n.textContent = 'Room not saved: ' + e.message; });
    return out;
  }
  function roomAssets() { try { const d = JSON.parse(root.localStorage.getItem('so-brief-dashboards-v1') || 'null'); return [...new Set((d?.layouts || []).flatMap(l => l.assets || (l.widgets || []).flatMap(w => w.tickers || [])))]; } catch (e) { return []; } }
  function marketServices() { return {core: () => S.core, rel: () => S.rel, Live, row, history: historyFor, identify, saved: () => WL().get(), roomAssets, saveRoom, compareHash, paintFocus, sma:W.sma, situation:situationModelNow, impact:(t,f,v)=>focusImpact(S.core,t,f,v), analysis:async()=>{await Promise.all(['chat/universe.js','chat/dashboard.js'].map(loadAsset));return root.SmartOptionsDashboardSpec;}, followTrend: t => followEvidence({dataset: {followTrend: t}}).catch(focusError), navigate: h => { root.location.hash = h; }}; }
  function renderMarkets(main, query, sector) {
    main.innerHTML = '<div class="page-head"><h1 class="page-label">Markets</h1><p class="dim small">Grid research over the published universe. <a href="#/companies">Screener with shortlist and saved modes</a></p></div><div id="mk-root"></div>';
    // Markets code loads on first visit only; Today's startup path does not carry it.
    const el = $('#mk-root'), gen = S.exToken;
    loadAsset('markets.js').then(() => {
      if (!el.isConnected || S.exToken !== gen) return;
      const M = root.SmartOptionsMarkets;
      if (sector) root.history.replaceState(root.history.state, '', M.encodeState({...M.parseState(query), sec: sector}));
      S.mod = M.mount(el, marketServices(), {query: query || ''});
    }).catch(e => { if (el.isConnected) el.innerHTML = `<p role="alert">Markets could not load: ${esc(e.message)}. <button type="button" onclick="location.reload()">Reload</button></p>`; });
  }
  /* Workspace: one tool rail; every tool receives the selected asset and the same accepted core. */
  const TOOLS = [['compare', 'Compare', '#/explore'], ['strategies', 'Strategies and income'], ['technicals', 'Technicals'], ['flows', 'Flows'], ['risk', 'Risk scenarios'], ['rooms', 'Saved rooms', '#/room'], ['positions', 'Positions and imports', '#/positions'], ['methods', 'Methods and audit']];
  const TOOL_TABS = {strategies: [['builder', 'Strategy builder'], ['pocket', 'Options income'], ['income', 'Event and IV check']], technicals: [['indicators', 'Indicators'], ['patterns', 'Patterns'], ['scan', 'Pattern scanner'], ['confidence', 'Agreement score']], flows: [['guide', 'Daily review'], ['checklists', 'Checklists'], ['capital', 'Capital and news'], ['alpha', 'Company comparisons'], ['scanner', 'Residual scanner']], risk: [['stress', 'Portfolio scenarios'], ['shocks', 'Shock scenarios'], ['cycle', 'Macro cycle'], ['joint', 'Joint what-if']], methods: [['methods', 'Methods'], ['audit', 'Formula audit'], ['sources', 'Data and sources']]};
  const toolHref = (id, t) => { const x = TOOLS.find(x => x[0] === id); return x && x[2] ? x[2] : '#/workspace/' + id + (t ? '?t=' + encodeURIComponent(t) : ''); };
  function wsRail(active, t) {
    const el = doc.createElement('nav'); el.className = 'ws-rail'; el.setAttribute('aria-label', 'Workspace tools');
    el.innerHTML = `<label class="ws-pick"><span>Tool</span><select data-ws-tool>${TOOLS.map(([id, label]) => `<option value="${id}"${id === active ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></label><ul>${TOOLS.map(([id, label]) => `<li><a href="${esc(toolHref(id, t))}"${id === active ? ' aria-current="page"' : ''}>${esc(label)}</a></li>`).join('')}</ul>`;
    el.querySelector('[data-ws-tool]').onchange = e => { root.location.hash = toolHref(e.target.value, t); };
    return el;
  }
  // Legacy calculation modules read a narrow facade over the SAME accepted core; SO2_ready is never set, so no legacy boot runs.
  // Legacy shock/settings live in so2-settings. Only .shock is written back; other fields and unreadable bytes are kept.
  const SHOCK0 = {spy: 0, us10y_bps: 0, dxy: 0, wti: 0, vix: 0};
  const legacySettings = (() => { let blocked = false, obj = {shock: {...SHOCK0}}; try { const raw = root.localStorage.getItem('so2-settings'); if (raw != null) { const p = JSON.parse(raw); if (!p || typeof p !== 'object' || Array.isArray(p)) throw Error('shape'); obj = p; obj.shock = {...SHOCK0, ...(p.shock && typeof p.shock === 'object' ? p.shock : {})}; } } catch (e) { blocked = true; }
    return {get: () => obj, blocked: () => blocked, save() { if (blocked) return false; try { const raw = JSON.stringify(obj); root.localStorage.setItem('so2-settings', raw); return root.localStorage.getItem('so2-settings') === raw; } catch (e) { return false; } }}; })();
  // Legacy navigation verbs translate to main-owned routes; legacy hash writes never run.
  function legacyNav(target, sym) {
    const map = {markets: sym ? '#/markets?sel=' + encodeURIComponent(sym) : '#/markets', macro: '#/macro', flow: '#/workspace/flows?tab=guide', patterns: '#/workspace/technicals?tab=scan', overview: '#/positions', strategies: '#/workspace/strategies' + (sym ? '?t=' + encodeURIComponent(sym) : ''), cycles: '#/workspace/risk?tab=cycle', edge: '#/workspace/strategies?tab=pocket'};
    root.location.hash = map[target] || '#/workspace';
  }
  function legacyApi() { let pendingSym = null; const api = {__mainFacade: true, D: () => S.core, S: () => legacySettings.get(), save: () => legacySettings.save(), renderTable() {}, renderAll() {}, V: {}, FACTORS: Object.keys(FACTORS),
    select(kind, id) { if (kind === 't') legacyNav('markets', id); else legacyNav('markets'); }, showTab(t) { legacyNav(t, pendingSym); }}; return api; }
  function legacyFacade() { const cur = root.SO2; if (cur && !cur.__mainFacade) return; root.SO2 = legacyApi();
    // Narrow importer facade over the canonical shared book (same key/readback guards as Positions); legacy import.js is not booted.
    if (!root.SmartOptionsImport && root.SmartOptionsLocalData?.sharedStore) { const st = root.SmartOptionsLocalData.sharedStore(root.localStorage); root.SmartOptionsImport = {__mainFacade: true, getData: () => { st.reload(); return st.get(); }, putData: v => { const r = st.put(v); root.dispatchEvent(new Event('so:investor')); return r; }, status: () => st.status()}; }
    root.SmartOptionsAPI = Object.assign(root.SmartOptionsAPI || {}, {open_ticker_tab: (t, tab) => { root.location.hash = tab === 'strategies' ? '#/workspace/strategies?t=' + encodeURIComponent(t) : '#/company/' + encodeURIComponent(t); }, apply_preset: id => { root.location.hash = '#/markets?u=sp&v=list&preset=' + encodeURIComponent(String(id || 'all')); return {preset: id}; }}); }
  function wsAsset(query) { const p = new URLSearchParams(query || ''), t = String(p.get('t') || '').toUpperCase(); if (/^[A-Z][A-Z0-9.\-]{0,9}$/.test(t)) S.wsLast = t; return S.wsLast || (S.brief.shortlist || [])[0]?.t || 'AAPL'; }
  async function renderWorkspace(main, tool, query) {
    if (!tool) tool = S.wsTool || 'compare';
    const meta = TOOLS.find(x => x[0] === tool); if (!meta) { main.innerHTML = '<p>Unknown tool. Choose one from the list.</p>'; main.prepend(wsRail('', '')); return; }
    if (meta[2]) { root.history.replaceState(root.history.state, '', meta[2]); return render(); }
    S.wsTool = tool;
    const p = new URLSearchParams(query || ''), t = wsAsset(query), tabs = TOOL_TABS[tool] || [], tab = tabs.find(x => x[0] === p.get('tab'))?.[0] || tabs[0]?.[0], r = row(t);
    main.innerHTML = `<div class="ws"><div class="ws-body"><header class="ws-head"><h1 class="page-label">${esc(meta[1])}</h1>
      <form class="ws-asset" data-ws-asset><label>Asset <input name="t" value="${esc(t)}" maxlength="10" autocomplete="off" spellcheck="false" aria-describedby="ws-asset-note"></label><button type="submit">Use</button><span id="ws-asset-note" class="dim small">${r ? esc(r.n) + ' · ' + esc(r.sec) : root.SmartOptionsInstruments?.get(t) ? esc(root.SmartOptionsInstruments.get(t).name) + ' · ' + esc(root.SmartOptionsInstruments.get(t).type === 'ETF' ? 'ETF' : 'stock') : 'no validated identity yet; find it with Search'}</span></form>
      ${tabs.length ? `<div class="ws-tabs" role="tablist">${tabs.map(([id, label]) => `<a role="tab" href="#/workspace/${tool}?t=${encodeURIComponent(t)}&tab=${id}" aria-selected="${id === tab}">${esc(label)}</a>`).join('')}</div>` : ''}</header><div id="ws-panel" class="ws-panel"><p class="dim">Loading…</p></div></div></div>`;
    main.querySelector('.ws').prepend(wsRail(tool, t));
    main.querySelector('[data-ws-asset]').onsubmit = e => { e.preventDefault(); const v = String(new FormData(e.target).get('t') || '').trim().toUpperCase(); if (v) root.location.hash = '#/workspace/' + tool + '?t=' + encodeURIComponent(v) + (tab ? '&tab=' + tab : ''); };
    const el = $('#ws-panel'), gen = S.exToken;
    const live = () => el.isConnected && S.exToken === gen;
    const fail = e => { if (live()) el.innerHTML = `<p role="alert">This tool could not load: ${esc(e.message)}. <button type="button" data-ws-retry>Retry</button></p>`; const b = el.querySelector('[data-ws-retry]'); if (b) b.onclick = () => render(); };
    legacyFacade();
    try {
      if (tool === 'strategies' && tab === 'builder') {
        await Promise.all(['strategies.css', 'strategies.js'].map(loadAsset)); if (!live()) return;
        if (!r) { el.innerHTML = `<p>The strategy builder needs company inputs (IV, realized volatility, events). ${esc(t)} has none in the published data.</p>`; return; }
        await root.SmartOptionsStrategies.mount(el, t);
        S.mod = {suspend() { Live.watch('strategy', []); }, resume() { Live.watch('strategy', [t]); }, destroy() { Live.watch('strategy', []); el._stUnsub?.(); }};
      } else if (['pocket', 'stress', 'audit', 'alpha'].includes(tab)) {
        await Promise.all(['edge-desk.css', 'edge-desk.js'].map(loadAsset)); if (!live()) return;
        const pillar = {pocket: 'pocket', stress: 'stress', audit: 'diff', alpha: 'alpha'}[tab];
        S.mod = root.SmartOptionsEdgeMount.mountIn(el, {api: root.SO2, pillar});
      } else if (tool === 'strategies') {
        S.incomeTicker = r ? t : S.incomeTicker; el.innerHTML = `<section id="income">${incomeHtml()}</section>`; $('#income-company').onchange = e => { S.incomeTicker = e.target.value; $('#income-context').innerHTML = incomeContext(); };
      } else if (tool === 'technicals' && tab === 'indicators') {
        await Promise.all(['technicals.css', 'technicals.js'].map(loadAsset)); if (!live()) return; await root.SmartOptionsTech.mount(el, t);
      } else if (tool === 'technicals' && tab === 'scan') {
        el.innerHTML = patternScanHtml(); S.mod = {destroy: () => { S.patScan?.abort(); }, suspend: () => { S.patScan?.abort(); }, resume() {}};
      } else if (tool === 'technicals' && tab === 'patterns') {
        await Promise.all(['patterns.css', 'technicals.js', 'patterns.js'].map(loadAsset)); if (!live()) return;
        const res = await root.SmartOptionsPatterns.scan(t); if (!live()) return;
        el.innerHTML = `<h2>${esc(t)} pattern evidence</h2><p class="dim small">${esc(root.SmartOptionsPatterns.SOURCE || 'Daily bars')} · as of ${esc(res.asof || 'unavailable')} · rule detections on past bars, not forecasts.</p><table class="tc-tbl"><thead><tr><th>Pattern</th><th>State</th><th>What the rule saw</th></tr></thead><tbody>${(res.detections || []).map(d => `<tr><td>${esc(d.pattern)}</td><td>${esc(d.state)}</td><td>${esc(d.plain || '')}</td></tr>`).join('') || '<tr><td colspan="3">No detections.</td></tr>'}</tbody></table>`;
      } else if (tool === 'technicals') {
        await Promise.all(['technicals.js', 'patterns.js', 'confidence.js'].map(loadAsset)); if (!live()) return;
        const x = await root.SmartOptionsConfidence.score(t); if (!live()) return; let why = false;
        const draw = () => { el.innerHTML = `<h2>${esc(t)} agreement score</h2><p class="dim small">Agreement and data quality across technical, pattern, flow and event evidence; not a probability of profit.</p><div class="cf">${root.SmartOptionsConfidence.boxHtml(x, why)}</div>`; };
        draw(); el.onclick = e => { if (e.target.closest('[data-cf="why"]')) { why = !why; draw(); el.querySelector('[data-cf="why"]')?.focus(); } };
      } else if (tool === 'flows' && tab === 'guide') {
        await Promise.all(['flow.css', 'strategies.js', 'flow.js'].map(loadAsset)); if (!live()) return;
        S.mod = root.SmartOptionsFlowMount.mountIn(el, {api: root.SO2});
      } else if (tool === 'flows' && tab === 'checklists') {
        el.innerHTML = checklistHtml(); S.mod = null;
      } else if (tool === 'flows' && tab === 'capital') {
        await Promise.all(['money-flow.css', 'news.js', 'money-flow.js'].map(loadAsset)); if (!live()) return; await root.MoneyFlow.mount(el);
        S.mod = {suspend: () => root.MoneyFlow.suspend?.(), resume: () => root.MoneyFlow.resume?.(), destroy: () => root.MoneyFlow.destroy?.()};
      } else if (tool === 'flows') {
        el.innerHTML = scannerHtml();
      } else if (tool === 'risk' && tab === 'shocks') {
        await Promise.all(['shocks.css', 'shocks.js'].map(loadAsset)); if (!live()) return; await root.SmartOptionsShocks.mount(el, r ? 'company' : 'grid', r ? t : undefined);
      } else if (tool === 'risk' && tab === 'cycle') {
        await loadAsset('cycles.js'); if (!live()) return; const C = root.SmartOptionsCycles, redraw = () => { el.innerHTML = C.html(C.state(S.core, C.loadTh())); };
        redraw(); el.onclick = e => { const b = e.target.closest('[data-cy]'); if (!b) return; C.ui(b.dataset.cy); redraw(); el.querySelector(`[data-cy="${b.dataset.cy}"]`)?.focus(); };
        el.onchange = e => { const x = e.target; if (x.dataset.cyth) { const th = C.loadTh(), v = parseFloat(x.value); if (isFinite(v)) { th[x.dataset.cyth] = v; C.saveTh(th); } redraw(); } };
      } else if (tool === 'risk') {
        el.innerHTML = `<p>The joint what-if applies the published dated joint regression to chosen changes. It stays off until you choose <b>Test a scenario</b> below the Compare chart; Reset closes it and the observed series are never altered.</p><p><a class="go" href="${esc(W.encodeHash({s: [{id: 'eq:' + (r ? t : 'SPY')}], r: '1y', m: 'raw'}))}">Open ${esc(r ? t : 'SPY')} in Compare</a></p>`;
      } else if (tool === 'methods' && tab === 'sources') {
        const ev = evidence({kind: 'today', id: 'trust'}); el.innerHTML = `<h2>${esc(ev.title)}</h2>${ev.html}`;
      } else {
        const m = S.core.methods || {}; el.innerHTML = `<h2>Methods</h2>${Object.entries(m).map(([k, v]) => `<details><summary>${esc(k.replace(/_/g, ' '))}</summary><p>${esc(typeof v === 'string' ? v : JSON.stringify(v))}</p></details>`).join('')}<details><summary>Historical score definitions</summary><pre class="small">${esc(S.core.docs?.score_defs ? JSON.stringify(S.core.docs.score_defs, null, 1) : 'unavailable')}</pre></details>`;
      }
    } catch (e) { fail(e); }
  }
  // Four review checklists (legacy WORKFLOWS) with native step targets; ticks persist per New York date on this device.
  const CHECKLISTS = [
    {id: 'morning', h: 'Morning macro check', steps: [['Market posture and developing situation', '#/'], ['10-year yield and VIX change', '#/macro'], ['Stale or failed macro sources', '#/workspace/methods?tab=sources'], ['Next scheduled release', '#/macro'], ['Sector map 1D', '#/markets?p=1D']]},
    {id: 'csp', h: 'Cash-secured put review', steps: [['Company case and valuation', '#/markets?u=sp&v=list&preset=garpmacro'], ['Earnings date versus expiry', '#/markets?u=sp&v=list&preset=earn7'], ['IV versus realized volatility', '#/markets?u=sp&v=list&preset=volrich'], ['Payoff and assignment in the strategy builder', '#/workspace/strategies?tab=builder'], ['Income goal against assignment odds', '#/workspace/strategies?tab=pocket']]},
    {id: 'earnings', h: 'Earnings week', steps: [['Companies reporting within 7 days', '#/markets?u=sp&v=list&preset=earn7'], ['Implied move context', '#/workspace/strategies?tab=income'], ['Followed names with events', '#/'], ['Pattern state into the report', '#/workspace/technicals?tab=patterns']]},
    {id: 'rates', h: 'Rate-shock review', steps: [['Rate-sensitive companies', '#/markets?u=sp&v=list&preset=rate'], ['Portfolio scenario with a +25bp shock', '#/workspace/risk?tab=stress'], ['Shock scenario evidence', '#/workspace/risk?tab=shocks'], ['Macro cycle phase', '#/workspace/risk?tab=cycle']]}];
  const CHK_KEY = 'so-workflow-checks-v1';
  function readChecks() { try { const raw = root.localStorage.getItem(CHK_KEY); if (raw == null) return {ok: true, v: {}}; const v = JSON.parse(raw); if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('shape'); return {ok: true, v}; } catch (e) { return {ok: false, v: {}}; } }
  function checklistHtml() {
    const day = new Date().toLocaleDateString('en-CA', {timeZone: 'America/New_York'}), c = readChecks(), done = c.v[day] || {};
    return `<h2>Review checklists</h2><p class="dim small">Ticks are saved on this device for ${esc(day)} (New York date) and reset each day. Each step opens the native tool.${c.ok ? '' : ' <b>Saved checklist data could not be read; it was kept unchanged and ticks will not be saved.</b>'}</p>${CHECKLISTS.map(w => `<section class="chk" data-chk-wf="${w.id}"><h3>${esc(w.h)} <span class="dim small">${w.steps.filter((x, i) => done[w.id + ':' + i]).length}/${w.steps.length}</span></h3><ul>${w.steps.map(([label, href], i) => `<li><label><input type="checkbox" data-chk="${w.id}:${i}" ${done[w.id + ':' + i] ? 'checked' : ''} ${c.ok ? '' : 'disabled'}> ${esc(label)}</label> <a href="${esc(href)}">Open</a></li>`).join('')}</ul></section>`).join('')}`;
  }
  doc.addEventListener('change', e => { const k = e.target.dataset?.chk; if (!k) return; const c = readChecks(); if (!c.ok) return; const day = new Date().toLocaleDateString('en-CA', {timeZone: 'America/New_York'}), v = c.v; v[day] = {...(v[day] || {}), [k]: e.target.checked}; Object.keys(v).sort().slice(0, -14).forEach(d => delete v[d]); try { root.localStorage.setItem(CHK_KEY, JSON.stringify(v)); } catch (er) { e.target.checked = !e.target.checked; } const h = e.target.closest('.chk')?.querySelector('h3 span'); if (h) { const wf = CHECKLISTS.find(w => w.id === e.target.closest('.chk').dataset.chkWf); h.textContent = wf.steps.filter((x, i) => v[day][wf.id + ':' + i]).length + '/' + wf.steps.length; } });
  // Universe pattern scan: only on explicit request, two histories at a time, cancellable, results kept per generation.
  function patternScanHtml() {
    const r = S.patResult;
    return `<h2>Pattern scanner</h2><p class="dim small">Runs the published rule detectors over every covered company's daily bars (${S.core.rows.filter(x => x.sp500_member !== false).length} histories, two at a time). Starts only when you ask; leaving the tool cancels it. Rule detections on past bars, not forecasts.</p><p><button type="button" class="btn" data-pat="start" ${S.patScan ? 'disabled' : ''}>Scan covered companies</button> <button type="button" class="btn" data-pat="stop" ${S.patScan ? '' : 'disabled'}>Cancel</button> <span id="pat-prog" role="status">${r ? `${r.done}/${r.total} scanned${r.cancelled ? ' (cancelled)' : ''}${r.failed ? ` · ${r.failed} histories unavailable` : ''}` : ''}</span></p>${r && r.hits.length ? `<div class="tablewrap"><table class="mk-list"><thead><tr><th>Company</th><th>Confirmed patterns</th><th>As of</th></tr></thead><tbody>${r.hits.slice(0, 200).map(h => `<tr><td><a href="#/workspace/technicals?t=${esc(h.t)}&tab=patterns"><b>${esc(h.t)}</b></a></td><td>${esc(h.confirmed.join(', '))}</td><td>${esc(h.asof || '')}</td></tr>`).join('')}</tbody></table></div>` : r ? '<p>No confirmed patterns in the scanned histories.</p>' : ''}`;
  }
  async function runPatternScan() {
    await Promise.all(['technicals.js', 'patterns.js'].map(loadAsset));
    const P = root.SmartOptionsPatterns, ts = S.core.rows.filter(x => x.sp500_member !== false).map(x => x.t), job = {aborted: false, abort() { this.aborted = true; }}, res = {done: 0, total: ts.length, failed: 0, hits: [], gen: S.generation || 0};
    S.patScan = job; S.patResult = res; const paint = () => { const p = $('#ws-panel'); if (p && S.view === 'workspace') p.innerHTML = patternScanHtml(); };
    paint(); let i = 0;
    const worker = async () => { while (!job.aborted && i < ts.length) { const t = ts[i++]; try { const x = await P.scan(t); const c = (x.detections || []).filter(d => d.state === 'confirmed').map(d => d.pattern); if (c.length) res.hits.push({t, confirmed: c, asof: x.asof}); } catch (e) { res.failed++; } res.done++; if (res.done % 10 === 0) paint(); } };
    await Promise.all([worker(), worker()]);
    res.cancelled = job.aborted; res.hits.sort((a, b) => b.confirmed.length - a.confirmed.length || a.t.localeCompare(b.t)); if (S.patScan === job) S.patScan = null; paint();
  }
  doc.addEventListener('click', e => { const b = e.target.closest('[data-pat]'); if (!b) return; if (b.dataset.pat === 'start' && !S.patScan) runPatternScan().catch(er => { S.patScan = null; const p = $('#pat-prog'); if (p) p.textContent = 'Scan could not start: ' + er.message; }); if (b.dataset.pat === 'stop') { S.patScan?.abort(); } });
  // Edge scanner rows from the same accepted core: residual moves, IV/RV and 60d-vs-252d beta shifts. Measured columns only.
  function scannerHtml() {
    const rows = S.core.rows.filter(r => r.sp500_member !== false && r.pxd === S.core.asof_session), sort = S.scanSort || 'res20d';
    const xs = rows.filter(r => isNum(r[sort])).sort((a, b) => Math.abs(b[sort]) - Math.abs(a[sort])).slice(0, 40);
    const cols = [['res1d', 'Residual 1d'], ['res5d', 'Residual 5d'], ['res20d', 'Residual 20d'], ['ivrv_eff', 'IV/RV'], ['pef_sec_rel', 'Fwd P/E vs sector']];
    return `<h2>Edge scanner</h2><p class="dim small">Completed session ${esc(S.core.asof_session)} · residual = return not explained by the published factor fit (percent); largest absolute values first. Measured screens, not recommendations.</p><div class="mk-seg" role="group" aria-label="Scanner column">${cols.map(([k, l]) => `<button type="button" data-scan="${k}" aria-pressed="${k === sort}">${l}</button>`).join('')}</div><div class="tablewrap"><table class="mk-list"><thead><tr><th>Company</th>${cols.map(([, l]) => `<th class="n">${l}</th>`).join('')}</tr></thead><tbody>${xs.map(r => `<tr><td><a href="#/markets?sel=${esc(r.t)}"><b>${esc(r.t)}</b></a> <span class="dim small">${esc(r.sec)}</span></td>${cols.map(([k]) => `<td class="n">${isNum(r[k]) ? (k.startsWith('res') ? pct(r[k]) : r[k].toFixed(2)) : '<span class="dim">n/a</span>'}</td>`).join('')}</tr>`).join('')}</tbody></table></div><p class="dim small">${xs.length} of ${rows.length} matched-session names have ${esc(cols.find(c => c[0] === sort)[1])}.</p>`;
  }
  /* Automatic developing situation: loaded after the core reading draws; patches only its own slot. */
  function situationBaseline() { const c = sessionComparison(S.brief, S.core, 'spy_1d'); return {session: S.brief.asof_session, spy_1d: c.available ? c.pct : null, posture: todayModel(S.brief, S.core).label}; }
  function sitExposure(kind) {
    if (!kind) return null;
    if (kind === 'equity') return {text: 'broad US equities (SPY and the sector map)', basis: 'index futures map to the broad equity market'};
    const f = {wti: 'wti', dxy: 'dxy', vix: 'vix'}[kind]; if (!f) return null;
    const xs = sectorSensitivity(S.core.rows, f); if (!xs.length) return null;
    const hi = xs[xs.length - 1], lo = xs[0], w = S.core.rel?.window;
    return {text: `${hi.sector} (most positive) and ${lo.sector} (most negative) by fitted ${FACTORS[f]?.name || f} sensitivity`, basis: `median member coefficient, dated OLS window ${w ? JSON.stringify(w) : 'as published'}; association, not a forecast`};
  }
  function situationModelNow() {
    const SIT = root.SmartOptionsSituation; if (!SIT) return null;
    const snap = S.sitCtl?.get(), h = horizonEvents(1);
    return SIT.situationModel(situationBaseline(), snap, Date.now(), {exposure: sitExposure, entered: enteredNames(), events: (h.items || []).filter(e => e.kind === 'macro').map(e => ({title: e.title, when: e.when, importance: e.importance, major: e.major}))});
  }
  function situationHtml() {
    const SIT = root.SmartOptionsSituation, chk = S.sitCtl?.lastCheck();
    if (!SIT || !S.sitCtl) return '';
    if (!S.sitCtl.get()) return chk ? `<p class="current-check dim" data-sit-state="unavailable">Current developments could not be checked. <button type="button" class="text" data-sit-retry>Retry</button> ${evBtn({kind:'situation',id:'all'},'Source status','text')}</p>` : '<p class="current-check dim" data-sit-state="pending">Checking current developments…</p>';
    const m = situationModelNow(), checkFailed = chk?.ok === false; S.sitModel = m;
    const checkClock = new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(m.generated_at));
    const clocks = `<p class="dim small dev-clock">Checked ${esc(checkClock)} ET${m.stale ? ' · <b>over two hours old</b>' : ''}${m.degraded ? ' · <b>partial coverage</b>' : ''}${checkFailed ? ' · <b>Latest current-context check failed; retained evidence</b>' : ''} ${evBtn({kind: 'situation', id: m.top[0]?.id || 'all'}, 'Sources', 'text')}</p>`;
    if (m.state === 'unavailable') return `<p class="dev-none" data-sit-state="unavailable">${esc(m.reason)} ${evBtn({kind: 'situation', id: 'all'}, 'Evidence and sources', 'text')}</p>`;
    if (!m.top.length) {
      return `<div class="current-check" data-sit-state="${checkFailed && !m.stale ? 'degraded' : m.state}"><p>${m.degraded || checkFailed ? 'Current checks are partial.' : 'No new qualifying development in this check.'} ${evBtn({kind: 'situation', id: 'all'}, 'What was checked', 'text')}</p>${clocks}</div>`;
    }
    // At most two facts, one implication each; values, clocks, bases and next checks live in the evidence sheet.
    return `<div class="dev" data-sit-state="${checkFailed && !m.stale ? 'degraded' : m.state}" data-sit-fp="${esc(m.fingerprint)}"><h2 class="dev-h">Since the close</h2><ul class="dev-list">${m.top.map(d => `<li data-dev="${esc(d.id)}" data-dev-kind="${d.kind}">${evBtn({kind: 'situation', id: d.id}, `<b>${esc(d.brief || d.measured || d.reported)}</b>${d.kind === 'reported' ? ' <span class="small dim">reported</span>' : ''}${d.conflict ? ' <span class="tag warn">conflicting reports</span>' : ''}<span aria-hidden="true">›</span>`, 'text dev-row')}</li>`).join('')}</ul><p class="dev-meaning">${esc(m.top[0].interpretation)}</p>${clocks}</div>`;
  }
  // Compact assessment controls retain all four dimensions; full interpretations open in their evidence sheets.
  function trimReasons() { doc.querySelectorAll('.market-reasons > li').forEach(li => { li.hidden = false; }); }
  function paintSituation() { const el = $('#situation'); if (!el) return; const y = root.scrollY, f = doc.activeElement, fk = f && el.contains(f) ? f.dataset.ev : null; el.innerHTML = situationHtml(); const message=doc.querySelector('[data-current-message]');if(message){const model=todayModel(S.brief,S.core);message.textContent=currentMessage(model,S.sitModel,takeaway(model,S.brief).so);}trimReasons(); if (fk) el.querySelector(`[data-ev='${fk}']`)?.focus({preventScroll: true}); root.scrollTo(0, y); }
  function situationEvidence(ev) {
    const m = situationModelNow(), SIT = root.SmartOptionsSituation;
    if (!m || !m.measures) return {title: 'Developing situation', html: `<p>Current developments could not be checked; no situation file was available.</p><p>${esc(S.sitCtl?.lastCheck()?.errors?.join('; ') || 'No source receipt yet.')}</p>`};
    const d = m.developments.find(x => x.id === ev.id), imp = m.implications;
    const obsRows = m.measures.map(x => `<tr><td>${esc(x.label || x.symbol)}${x.valid ? `<br><button type="button" class="text" data-follow-reference="${esc(x.symbol)}">Follow this observation</button>` : ''}</td><td class="n">${x.valid ? esc(x.value) : 'n/a'}</td><td>${x.valid ? esc(SIT.clock(x.observed_at)) + (x.newer ? '' : ' <b>(not newer than the completed session)</b>') + (x.carried ? ' · retained from an earlier run' : '') : esc(x.reason)}</td><td>${x.valid ? esc(x.comparison.value) + ' · ' + esc(x.comparison.date) + ' · ' + esc(x.comparison.basis) : ''}</td><td class="n">${x.valid ? (x.kind === 'volatility_index' ? (x.change >= 0 ? '+' : '−') + Math.abs(x.change).toFixed(2) + ' pts' : pct(x.pct)) : ''}</td></tr>`).join('');
    const reps = (d && d.reports || m.reports.slice(0, 8)).map(r => `<li><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.headline)}</a> <span class="small dim">${esc(r.source)} · published ${esc(SIT.clock(r.published_at))} · ${r.headline_only ? 'headline only, article not read' : 'excerpt supplied'} · topic “${esc(r.topic || 'unclassified')}” · ${esc(r.match_reason || 'selected by recency and source')}</span> <button type="button" class="text" data-follow-report="${esc(r.id)}">Follow this report</button>${(r.conflicts || []).length ? ' <span class="tag warn">conflicts with ' + esc(r.conflicts.join(', ')) + '</span>' : ''}</li>`).join('');
    const srcs = Object.entries(m.sources || {}).map(([k, v]) => `<li>${esc(k)}: ${esc(v.status)}${v.calls != null ? ' · ' + esc(v.calls) + ' calls' : ''}${v.at ? ' · ' + esc(SIT.clock(v.at)) : ''}${v.error ? ' · ' + esc(v.error) : ''}</li>`).join('');
    return {title: d ? 'Developing: ' + (d.topic || d.inputs?.[0]?.label || d.id) : 'Developing situation · what was checked', html: `${d ? `<p class="lead">${esc(d.measured || d.reported)}</p><p>${esc(d.interpretation)}</p><p class="small">Rule <b>${esc(d.rule)}</b> (${esc(d.threshold)}) · fingerprint ${esc(d.fingerprint)} · rules ${esc(m.version)}. Thresholds decide what is shown; they are not forecasts.</p>${d.exposure ? `<p><b>Relevant exposure:</b> ${esc(d.exposure.text)} <span class="small dim">(${esc(d.exposure.basis)})</span></p>` : ''}` : ''}
      ${imp ? `<h3>Conditional implications</h3><ul><li><b>Protect:</b> ${esc(imp.protect)}</li><li><b>Income:</b> ${esc(imp.income)}</li><li><b>Growth:</b> ${esc(imp.growth)}</li><li><b>Watch:</b> ${esc(imp.watch)}</li></ul>` : ''}
      <h3>Observations and comparison bases</h3><div class="tablewrap"><table><thead><tr><th>Reference</th><th class="n">Value</th><th>Observed</th><th>Compared with</th><th class="n">Change</th></tr></thead><tbody>${obsRows || '<tr><td colspan="5">No observations in this file.</td></tr>'}</tbody></table></div><p class="small dim">Futures are compared with their last completed provider daily bar, not an official settlement. A Sunday read of a Friday VIX is still Friday's VIX. No equity breadth or heatmap value is updated from futures.</p>
      <h3>Reported context</h3><ul>${reps || '<li>No fresh original reports qualified in this collection. That is a coverage gap, not a quiet market.</li>'}</ul><p class="small dim">Reports are context. No price move is attributed to a headline.${m.synthesis ? ' Synthesis: ' + esc(m.synthesis.status) + (m.synthesis.reason ? ' (' + esc(m.synthesis.reason) + ')' : '') + '.' : ''}</p>
      <h3>Acquisition</h3><ul>${srcs || '<li>No source receipts.</li>'}</ul><p class="small dim">File generated ${esc(SIT.clock(m.generated_at))}; observation times above are the provider's own. Checking the file does not renew them.</p>`};
  }
  function startSituation() {
    const SIT = root.SmartOptionsSituation; if (!SIT || S.sitCtl) return;
    const canonical = 'https://soham-porwal.github.io/smartoptions-brief/data/situation.json', urls = ['data/situation.json'].concat(root.location.origin === 'https://soham-porwal.github.io' && root.location.pathname.startsWith('/smartoptions-brief/') ? [] : [canonical]);
    // Live recovery URL comes from the existing relay origin in config; only consulted when static files are stale.
    const go = liveUrl => { S.sitCtl = SIT.controller({urls, liveUrl, onChange: () => { if (S.view === 'brief') paintSituation(); else if(S.view==='markets') S.mod?.refreshSituation?.(); }}); syncSituation(); };
    S.sitCtl = {get: () => null, lastCheck: () => null, check() {}};
    fetch('data/config.json', {cache: 'no-cache', signal: AbortSignal.timeout(5000)}).then(r => r.ok ? r.json() : null).then(c => { let u = null; try { const b = new URL(c?.quotes_proxy_url || ''); if (b.protocol === 'https:' && !b.username && !b.password) u = b.origin + '/situation/live'; } catch (e) { u = null; } go(u); }, () => go(null));
  }
  function syncSituation() {
    if (S.view === 'brief'||S.view==='markets') { S.sitCtl?.start?.(); if (S.sitCtl?.get()&&S.view==='brief') paintSituation(); }
    else S.sitCtl?.stop?.();
  }

  // Optional investigation: one in-memory focus, explicitly persisted only through the existing typed room store.
  // Public evidence stays separate from hypothetical factor assumptions and from private position/room text.
  function focusError(e) {
    console.warn('[investigation] action failed', e.message);
    let n = doc.querySelector('[data-focus-status]');
    if (!n) { n = doc.createElement('p'); n.dataset.focusStatus = ''; n.setAttribute('role', 'status'); $('#view').prepend(n); }
    n.textContent = 'Investigation not changed: ' + e.message;
  }
  async function followFocus(value) {
    await roomStore();
    S.focus = root.SmartOptionsDashboardSpec.focusContext(value, root.SmartOptionsInstruments.roomUniverse(S.core.rows.map(r => r.t)));
    closeSheet(); paintFocus(true);
  }
  API.followFocus = followFocus;
  API.focus = () => S.focus || null;
  async function followEvidence(button) {
    const data = button.dataset, clean = s => String(s || '').replace(/[<>{}\x00-\x1f]/g, ' ').slice(0, 300);
    let value;
    if (data.followTrend) {
      const t = data.followTrend, r = row(t), a = root.SmartOptionsInstruments.get(t);
      if (!r && !a) throw Error('No validated instrument identity.');
      const history = r ? null : await historyFor(t), date = r?.pxd || history?.bars?.at(-1)?.[0];
      if (!date) throw Error('A dated history is required before following this instrument.');
      value = {id: 'trend:' + t + ':' + date, kind: 'observed', label: clean(`${t}: ${isNum(r?.d1) ? pct(r.d1) + ' completed-session price return' : 'price/history investigation; no company fit assumed'}`), at: date, source: history?.source || 'Published daily price history', assets: [t]};
    } else if (data.followReport) {
      const r = S.sitCtl?.get()?.reports.find(r => r.id === data.followReport);
      if (!r) throw Error('The report is no longer in the current source collection.');
      value = {id: 'report:' + r.id, kind: 'reported', label: clean(r.headline), at: r.published_at, source: r.source, source_url: r.url, assets: (r.tickers || []).filter(t => row(t) || root.SmartOptionsInstruments.get(t)).slice(0, 4)};
    } else {
      const r = S.sitCtl?.get()?.observations.find(r => r.symbol === data.followReference);
      if (!r) throw Error('The observation is no longer in the source collection.');
      value = {id: 'observation:' + r.symbol + ':' + r.observed_at, kind: 'observed', label: clean(`${r.label}: ${r.value} ${r.unit}, compared with ${r.comparison.value} on ${r.comparison.date}`), at: r.observed_at, source: 'Yahoo market reference', source_url: r.source_url, assets: []};
    }
    await followFocus(value);
  }
  function paintFocus(force = false) {
    const main = $('#view'), old = main.querySelector('[data-focus-bar]'), c = S.focus, host = main.querySelector('.mk-insp:not([hidden])') || main;
    if (!c) { old?.remove(); return; }
    if (old && old.dataset.focusBar === JSON.stringify(c) && !force) { if (old.parentElement !== host) host.prepend(old); return; }
    old?.remove();
    const M = root.SmartOptionsDashboardSpec, t = c.assets[0] || '', a = c.assumption, factors = M.SHOCKS, draft = S.focusDraft?.id === c.id ? S.focusDraft : null;
    const instruments = [...S.core.rows.map(r => [r.t, r.n]), ...root.SmartOptionsInstruments.all().filter(x => !row(x.symbol)).map(x => [x.symbol, x.name])];
    const n = doc.createElement('section'); n.className = 'investigation'; n.dataset.focusBar = JSON.stringify(c);
    n.innerHTML = `<div class="focus-chip"><b>Following ${c.kind === 'reported' ? 'a report' : 'an observation'}</b><span>${esc(c.label)}</span><button type="button" class="text" data-focus-clear>Clear focus</button></div><details class="focus-details"><summary>Evidence and conditional impact</summary><p>${esc(c.source)} · ${esc(c.at)}${c.source_url ? ` · <a href="${esc(c.source_url)}" target="_blank" rel="noopener">Original source</a>` : ''}.</p><p>${c.kind === 'reported' ? 'This is attributed reporting; market impact and causality are not established. A proposal is not a completed event.' : 'This is a dated observation, not a continuation forecast.'} Choose a covered asset to investigate; selection does not establish exposure to this source.</p><div class="focus-controls"><label>Asset<select data-focus-asset><option value="">Choose an asset</option>${instruments.map(([id, name]) => `<option value="${esc(id)}"${t === id ? ' selected' : ''}>${esc(id + ' · ' + name)}</option>`).join('')}</select></label><label>Factor<select data-focus-factor>${Object.entries(factors).map(([id, x]) => `<option value="${id}"${(a?.factor || 'us10y_bps') === id ? ' selected' : ''}>${esc(x.label + ' (' + x.unit + ')')}</option>`).join('')}</select></label><label>Hypothetical move<input data-focus-shock type="number" step="any" value="${a?.shock ?? 10}"></label><button type="button" class="btn" data-focus-test>Test this factor move</button></div><div data-focus-result></div><p class="actions"><a class="btn" href="${t?instrumentHref(t):'#/markets'}">Explore in Markets</a> <a class="btn" href="#/workspace/risk${t ? '?t=' + encodeURIComponent(t) : ''}">Risk workspace</a> <button type="button" class="btn" data-focus-save>Save focus as room</button></p><p data-focus-status role="status"></p></details>`;
    if (host !== main) host.querySelector('.mk-insp-head').after(n); else main.prepend(n);
    if (draft) { n.querySelector('[data-focus-factor]').value = draft.factor; n.querySelector('[data-focus-shock]').value = draft.shock; }
    const keepDraft = () => { S.focusDraft = {id: c.id, factor: n.querySelector('[data-focus-factor]').value, shock: n.querySelector('[data-focus-shock]').value}; };
    n.querySelector('[data-focus-factor]').onchange = keepDraft; n.querySelector('[data-focus-shock]').oninput = keepDraft;
    const output = () => {
      const out = n.querySelector('[data-focus-result]');
      if (!c.assumption) { out.textContent = 'No scenario applied. Observed returns, chart values and holdings remain their own data.'; return; }
      const x = focusImpact(S.core, c.assets[0], c.assumption.factor, c.assumption.shock);
      out.innerHTML = x.ok ? `<p data-focus-impact="${esc(x.response_pct)}"><b>Conditional factor contribution: ${pct(x.response_pct)}</b> = ${esc(x.coefficient)} × ${esc(x.shock)}. ${esc(x.unit)}; other fitted factors held fixed.</p><p class="small">${esc(x.ticker)} model: ${esc(x.window)} · n=${x.n} · R²=${esc(x.r2)} · t=${esc(x.t ?? 'unavailable')}. ${isNum(x.t) && Math.abs(x.t) < 2 ? 'Weak sample evidence for this factor. ' : ''}Observed session return: ${pct(x.observed_return_pct)} on ${esc(x.session)}. A one-day historical association, not a price target, forecast or confidence interval. Other drivers and changing relationships can invalidate this reading.</p>` : `<p>${esc(x.reason)}</p>`;
    };
    output();
    n.querySelector('[data-focus-clear]').onclick = () => { S.focus = null; n.remove(); (doc.querySelector('.mk-insp [data-mk-act="follow"]') || $('#gs-toggle'))?.focus({preventScroll: true}); };
    n.querySelector('[data-focus-asset]').onchange = e => {
      c.assets = e.target.value ? [e.target.value] : []; n.dataset.focusBar = JSON.stringify(c);
      const ts = c.assets[0]; n.querySelector('a[href^="#/markets"]').href = ts?instrumentHref(ts):'#/markets';
      n.querySelector('a[href^="#/workspace/risk"]').href = '#/workspace/risk' + (ts ? '?t=' + encodeURIComponent(ts) : ''); output();
    };
    n.querySelector('[data-focus-test]').onclick = () => { try { c.assumption = M.settings('sensitivity', {factor: n.querySelector('[data-focus-factor]').value, shock: +n.querySelector('[data-focus-shock]').value}); n.dataset.focusBar = JSON.stringify(c); output(); } catch (e) { focusError(e); } };
    n.querySelector('[data-focus-save]').onclick = async () => {
      try { const r = saveRoom(c.assets, {focus: c}); if (!r.ok) throw Error(r.error); const saved = await r.pending; if (saved.status !== 'OK') throw Error(saved.text); n.querySelector('[data-focus-status]').innerHTML = 'Focus saved with its source clocks. <a href="#/room">Open saved room</a>'; }
      catch (e) { focusError(e); }
    };
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
  function mapHealthSlot() {
    const H=root.SmartOptionsHeatmap,period=S.heatPeriod||'1D';if(!H)return '';
    const map=H.sessionMap(S.core.rows,Live.snapshot().quotes,period,S.core.asof_session),known=map.values.filter(r=>isNum(r.value));
    if(!known.length)return '';
    const up=known.filter(r=>r.value>0).length,sectors=map.sectors.filter(s=>isNum(s.pct)).sort((a,b)=>b.pct-a.pct),lead=sectors[0],lag=sectors[sectors.length-1];
    return `<button type="button" class="map-health ev" data-ev="${evAttr({kind:'map-health'})}" aria-label="${Math.round(100*up/known.length)}% of mapped names higher over ${esc(period)}; open coverage and method"><span class="map-health-number"><b>${Math.round(100*up/known.length)}<span>%</span></b><span>higher · ${esc(period)}</span></span><span class="map-health-date">${up} of ${known.length} mapped names<br><span class="dim">Through ${esc(map.session)}</span></span></button>${lead&&lag?`<p class="map-leaders small"><span>Leading <a href="#/sector/${encodeURIComponent(lead.sec)}"><b>${esc(lead.sec)} ${pct(lead.pct)}</b></a></span><span>Trailing <a href="#/sector/${encodeURIComponent(lag.sec)}"><b>${esc(lag.sec)} ${pct(lag.pct)}</b></a></span></p>`:''}`;
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
  const UI = root.__soMainUI = {horizon: 7};
  const evAttr = ev => esc(JSON.stringify(ev));
  const evBtn = (ev, label, cls) => `<button type="button" class="ev${cls ? ' ' + cls : ''}" data-ev="${evAttr(ev)}">${label || 'Evidence'}</button>`;
  function bigNames() { return new Set(S.core.rows.filter(r => r.sp500_member !== false && isNum(r.mcap)).sort((a, b) => b.mcap - a.mcap).slice(0, 60).map(r => r.t)); }
  function enteredNames() {return root.SmartOptionsInvestor.enteredNames();}
  // One calendar computation per horizon/minute/generation/saved-set; a horizon click redraws several consumers.
  const horizonMemo=new Map();
  function horizonEvents(days, ticker) {
    const watch=WL().get(),entered=enteredNames(),key=[days,ticker||'',Math.floor(Date.now()/60000),S.generation||0,S.brief?.generated_at,watch.join(','),entered.join(',')].join('|');
    if(horizonMemo.has(key))return horizonMemo.get(key);if(horizonMemo.size>24)horizonMemo.clear();
    const v=eventsInHorizon(S.core, S.brief, Date.now(), days, {watch: new Set(watch),entered:new Set(entered), big: bigNames(), ticker});horizonMemo.set(key,v);return v;
  }
  const timingWord = x => x.timing === 'bmo' ? 'before the open' : x.timing === 'amc' ? 'after the close' : x.timing === 'timed' ? '' : 'time not confirmed';
  function eventLine(x, i, scope) {
    const tw = timingWord(x);
    return `<li><span class="when">${when(x.when)}</span><span class="what"><b>${x.t ? `<a href="#/company/${esc(x.t)}/events">${esc(x.title)}</a>` : esc(x.title)}</b>${tw ? ` <span class="dim">${esc(tw)}</span>` : ''}${x.entered ? ' <span class="tag">entered equity</span>' : x.saved ? ' <span class="tag">followed company</span>' : ''}<span class="small channel">${x.kind==='earnings'?'Results and guidance can reset expectations.':/oil|EIA/i.test(x.title)?'Possible channel: producer revenues and input costs.':'Possible channel: demand, wages, policy and discount rates.'}</span></span> ${evBtn({kind: 'event', scope, i}, 'Source', 'text')}</li>`;
  }
  function aheadHtml() {
    const h = horizonEvents(S.horizon); S.lastEvents = S.lastEvents || {}; S.lastEvents.today = h.relevant;
    const top = h.relevant.slice(0, 4), rest = h.relevant.slice(4);
    return `<div class="horizon" role="group" aria-label="Event horizon">${[7, 30].map(d => `<button type="button" data-horizon="${d}" aria-pressed="${S.horizon === d}">${d} days</button>`).join('')}</div>
      <p class="dim small">${esc(shortDate(h.today))} to ${esc(shortDate(h.end))} ET · calendar days · macro releases, entered equities, followed names and the 60 largest companies</p>
      <ul class="events">${top.map((x, i) => eventLine(x, i, 'today')).join('') || '<li class="dim">No listed release or tracked earnings in this window. That is not a clear calendar; see coverage below.</li>'}</ul>
      ${rest.length ? `<details class="more" data-more="events"><summary>${rest.length} more in this window</summary><ul class="events">${rest.map((x, i) => eventLine(x, i + 4, 'today')).join('')}</ul></details>` : ''}
      <p class="cov dim small">${h.notes.map(esc).join(' ')}</p>`;
  }
  function tile(a) {
    return `<button type="button" class="tile" data-tone="${esc(a.tone)}" data-assess="${esc(a.id)}" data-ev="${evAttr({kind: 'assessment', id: a.id})}">
      <span class="t-title">${esc(a.title)}</span><span class="t-word">${cue(a.tone)}${esc(a.word)}</span><span class="t-qty">${esc(a.qty)}</span>${a.change ? `<span class="t-chg">${esc(a.change)}</span>` : ''}<span class="t-basis">${esc(a.basis)}</span></button>`;
  }
  function shortCard(x) {
    const setup=shortSetup(x),why=((x.why||[])[0]?.text||'Inspect dated company evidence.').replace(/, provider quarter label [\d-]+\.?/i,'.');
    return `<article data-short="${esc(x.t)}"><div class="short-id"><h3><a href="#/company/${esc(x.t)}">${esc(x.t)}</a> <span class="co-name">${esc(x.name)}</span></h3><p class="co-sector">${esc(x.sector)}</p>
        <p class="quote-line"><span class="px">${liveSpan(x.t, 'price', true)} <span class="chg">${liveSpan(x.t, 'chg', true)}</span></span><span class="quote-note" data-live="${esc(x.t)}" data-live-f="note"></span></p>
        <p class="tag research-tags" data-short-category="${esc(x.t)}">${researchBadges(setup)}</p></div>
      <p class="why"><span class="lbl">Case</span> ${esc(why)}</p>
      <p class="obj" data-tone="${setup.concerns.some(c=>c.kind==='fundamental')?'bad':setup.concern.measured?'mixed':'neutral'}" data-short-caution="${esc(x.t)}">${shortCaution(setup)}</p>
      <p class="links">${evBtn({kind: 'shortlist', t: x.t}, `Evidence<span class="sr"> for ${esc(x.t)}: case, caution and dated sources</span>`)} <a href="#/company/${esc(x.t)}" aria-label="Open ${esc(x.t)} dossier">Open dossier →</a></p></article>`;
  }
  function shortSetup(x){return researchSetup(x,row(x.t),{session:S.brief.asof_session,events:horizonEvents(S.horizon||7)});}
  function shortCaution(s){return `<span class="lbl">${s.concern.measured?'Caution':'Watch'}</span> ${esc(s.concern.measured?s.concern.text:s.signal)} ${esc(s.wait)}${s.event?` <span class="small">${esc(s.event)}</span>`:''}`;}
  function setupEvidence(s){return `<p class="lead">${esc(s.category)}</p><p><a href="#/company/${esc(s.t)}/drivers">${esc(s.t)} Chart &amp; drivers</a></p><p>Completed session ${esc(s.session||'unavailable')}; live quotes do not change this setup. Business ratings and entry timing answer different questions.</p>${s.concerns.length?s.concerns.map(c=>`<p>${c.kind==='fundamental'?'<b>Business evidence:</b> ':''}${esc(c.text)}</p><p>${esc(c.wait)}</p>${metricTable(c.metrics,true,s.t)}`).join(''):`<p>${esc(s.concern.text)} ${esc(s.wait)}</p>${metricTable(s.metrics,true,s.t)}`}<p>${esc(s.event||'No company earnings listed inside the selected horizon; calendar completeness is not implied.')}</p><details><summary>Setup method and limits</summary><p>Below the 50-session adjusted average: pullback watch. At least 8% above it: extension watch. Otherwise: trend watch. Forward P/E at least 1.25× its broad-sector median adds valuation watch. These are research thresholds, not forecasts, buy/sell rules or RSI/DMI/MACD signals. Missing or mismatched-session inputs leave timing unconfirmed. Adjusted closes can differ from the unadjusted company chart; the full quarterly relative comparison is measured only when that chart opens.</p></details>`;}
  const CHANGE_NAMES={spy_1d:'SPY',vix:'VIX',us10y:'10-year Treasury',dxy:'DXY',breadth_50_1d:'Breadth above 50-session average'};
  function comparisonText(c) {
    if(!c.available)return c.reason;
    const x=c.x,levels=c.id==='us10y'?`${x.prior.value.toFixed(2)}% → ${x.current.value.toFixed(2)}%`:c.id==='breadth_50_1d'?`${x.prior.value.toFixed(2)}% → ${x.current.value.toFixed(2)}%`:`${x.prior.value} → ${x.current.value}`;
    const delta=c.id==='spy_1d'?pct(c.pct):fmtU(c.change,c.id==='us10y'?'bp':c.id==='breadth_50_1d'?'pp':'points')+(c.id==='dxy'?` (${pct(c.pct,4)})`:'');
    return levels+' · '+delta;
  }
  function comparisonMeaning(c) {
    if(!c.available)return 'No direction is inferred without comparable observations.';
    const up=c.change>0,flat=Math.abs(c.change)<1e-8;
    return c.id==='spy_1d'?'Index movement describes the session; it is not an opportunity ranking.':c.id==='vix'?`Expected near-term market volatility ${flat?'was unchanged':up?'increased':'decreased'}; this is not single-name IV.`:c.id==='us10y'?(Math.abs(c.change)<5?'A move under 5bp is treated as little changed; no clear rate pressure or relief.':`${up?'Higher yields tighten':'Lower yields ease'} the discount-rate channel, all else equal.`):c.id==='dxy'?`${flat?'An unchanged dollar leaves':up?'A stronger dollar can weigh on':'A weaker dollar can ease'} overseas earnings translation; company exposure is not measured.`:'Same names at both endpoints; percentage-point change differs from the five-session direction.';
  }
  function objectivesHtml() {const model=todayModel(S.brief,S.core);return objectiveModel(model,S.brief,horizonEvents(S.horizon||7),S.core).map(x=>`<article data-objective="${x.id}" data-tone="${objectiveTone(x,model)}"><h3>${x.title}</h3><p class="objective-word">${cue(objectiveTone(x,model))}${esc(x.word)}</p><p>${esc(x.summary)}</p><p class="dim small objective-limit">${esc(x.limit)}</p><p class="objective-actions">${evBtn({kind:'objective',id:x.id},'','text')} <button class="text" data-jump="${x.target}">Investigate ${x.title.toLowerCase()} →</button></p></article>`).join('');}
  function incomeHtml() {
    const names=[...new Set([...enteredNames(),...WL().get(),...(S.brief.shortlist||[]).map(x=>x.t)])].filter(t=>row(t));
    return `<label for="income-company">Company for contract and event research</label><select id="income-company"><option value="">Choose a company</option>${names.map(t=>`<option value="${esc(t)}" ${S.incomeTicker===t?'selected':''}>${esc(t)}</option>`).join('')}</select><div id="income-context">${incomeContext()}</div><button data-personal="search" data-income-search>Find another company</button>`;
  }
  function incomeContext() {
    const t=S.incomeTicker,r=row(t);if(!r)return '<p>Choose an entered, followed or shortlisted company, or use company search.</p>';
    const d=delayedIv(r),cell=v=>v==null?'not returned':esc(v);
    const legs=d.kind==='dated'&&d.legs.length?`<div class="tablewrap"><table class="iv-context"><thead><tr><th>Leg</th><th class="n">Strike</th><th class="n">IV</th><th class="n">Bid / ask</th><th class="n">Open interest</th><th>Last trade (that contract only)</th></tr></thead><tbody>${d.legs.map(q=>`<tr><td data-label="Leg">${esc(q.leg)}</td><td class="n" data-label="Strike">${cell(q.strike)}</td><td class="n" data-label="IV">${isNum(q.iv_pct)?q.iv_pct.toFixed(1)+'%':'not returned'}</td><td class="n" data-label="Bid / ask">${cell(q.bid)} / ${cell(q.ask)}</td><td class="n" data-label="Open interest">${cell(q.open_interest)}</td><td data-label="Last trade (UTC)">${q.last_trade_utc?esc(q.last_trade_utc.slice(0,16).replace('T',' '))+' UTC':'not returned'}</td></tr>`).join('')}</tbody></table></div>`:'';
    return `<p><b>${esc(t)}</b> · ${r.er?`Expected earnings ${esc(r.er)} (${esc(r.ert||'timing unknown')}). An expiry across this date carries report gap risk.`:'Next earnings unavailable; calendar coverage is incomplete.'}</p><p class="dim small">${d.kind==='dated'?'Delayed chain context below':'Contract pricing unavailable'}; premiums and assignment odds are not rated.</p><details><summary>Delayed IV ${d.kind==='dated'?'context':'coverage'}</summary><p>${esc(d.text)}</p>${d.kind==='dated'?`${d.spans?'<p>This expiry spans the listed earnings date, so the IV includes report risk.</p>':''}${legs}<p class="small dim">Delayed sample, not an executable quote. Bid/ask and IV are as returned at the chain retrieval; the last trade time does not date them. IV is not compared with its own history, so premium richness and income suitability are not rated.</p>`:''}</details><p><a href="#/company/${esc(t)}/options">${esc(t)} Options</a> · <a href="#/company/${esc(t)}/events">${esc(t)} Events</a></p>`;
  }
  function moversHtml() {
    const rows=S.core.rows.filter(r=>r.sp500_member!==false&&r.pxd===S.brief.asof_session),returns=rows.filter(r=>isNum(r.d1)),volumes=rows.filter(r=>r.st?.vol_ratio_20d==='ok'&&isNum(r.vr)&&r.vr>=0).sort((a,b)=>b.vr-a.vr).slice(0,3);
    const groups=[['Gainers',returns.filter(r=>r.d1>0).sort((a,b)=>b.d1-a.d1).slice(0,3)],['Decliners',returns.filter(r=>r.d1<0).sort((a,b)=>a.d1-b.d1).slice(0,3)],['Volume / 20-session average',volumes]];
    return `<h3>Movers to investigate</h3><p class="dim small">${esc(S.brief.asof_session)} · session observations, not investment opportunities. True index contribution is unavailable. Unusual volatility is not established by price movement.</p><div class="mover-grid">${groups.map(([label,names],i)=>`<div><h4>${label}</h4>${names.map(r=>`<p><a href="#/company/${esc(r.t)}/drivers">${esc(r.t)} ${i===2?r.vr.toFixed(2)+'×':pct(r.d1)}</a> ${evBtn({kind:'today',id:i===2?'volume':'mover',t:r.t})}</p>`).join('')||'<p>Not available: no usable observations.</p>'}</div>`).join('')}</div><p class="small dim">Volume ratios available for ${rows.filter(r=>r.st?.vol_ratio_20d==='ok'&&isNum(r.vr)&&r.vr>=0).length}/${rows.length} matched-session names. Missing volume remains unassessed.</p>`;
  }
  function nowSlot() {
    const quote=q('SPY'),now=Date.now(),key=[quote?.asof_utc||quote?.ts,quote?.price,quote?.delivery_state,Math.floor(now/60000),S.brief?.generated_at].join('|');
    if(S.nowKey===key)return S.nowHtml;
    const pre=nowVsClose(S.brief,quote,now,null),n=pre.state==='current'?nowVsClose(S.brief,quote,now,(S.nowBreadth&&now-S.nowBreadth.at<15000&&S.nowBreadth.gen===S.generation?S.nowBreadth:(S.nowBreadth={at:now,gen:S.generation,v:liveBreadth(S.core.rows,q)})).v):pre;
    if(n.state==='closed'){const c=sessionComparison(S.brief,S.core,'spy_1d');if(c.available)n.last={pct:c.pct,prior:c.x.prior.date};}
    if(n.state==='current')n.marketOpen=Live.marketClock?Live.marketClock(now).open:undefined;
    const pending=!quote&&!Live._state?.file&&!Live._state?.fileState?.error;
    S.nowKey=key;S.nowHtml=pending?'<span data-now-state="pending">Now: checking the current SPY quote…</span>':`<span data-now-state="${n.state}">${esc(nowText(n,S.brief))}</span>`;return S.nowHtml;
  }
  function firstReasons(model) {
    const rs=model.reasons;if(rs.length<=4)return rs;
    return [...rs.slice(0,3),rs.find(r=>r.ev.id==='trust')||rs[3]];
  }
  function implicationsHtml(model) {
    const b=S.brief;return `${objectiveModel(model,b,horizonEvents(S.horizon||7),S.core).map(x=>`<button type="button" class="impl" data-jump="${x.target}" data-tone="${objectiveTone(x,model)}"><span class="impl-t">${x.title}</span><span class="impl-w">${cue(objectiveTone(x,model))}${esc(x.word)}</span></button>`).join('')}<button type="button" class="impl impl-more" data-jump="deep-dive"><span class="impl-t">Deep dive</span><span class="impl-w">Companies, macro, compare →</span></button>`;
  }
  function nextRisk() {
    const h=horizonEvents(S.horizon||7),x=h.items.find(e=>e.kind==='macro'&&e.major===true||e.kind==='earnings'&&e.entered)||h.relevant[0];
    return x?`<span class="lbl">Next</span> <b>${esc(x.title)}</b> <span class="dim">${when(x.when)}</span> <button type="button" class="text" data-jump="my-risk">Upcoming risks →</button>`:`<span class="lbl">Next</span> No listed release in ${h.days} days. ${h.complete?'':'Calendar coverage is incomplete. '}<button type="button" class="text" data-jump="my-risk">Upcoming risks →</button>`;
  }
  // Today: five bounded sections. Each summary owns one evidence target and one seeded deeper action.
  function prevRow(model) {
    const ids = ['spy_1d', 'vix', 'us10y'], label = {spy_1d: 'SPY', vix: 'VIX', us10y: '10Y'};
    return `<ul class="prev-row" aria-label="Previous session">${ids.map(id => { const c = model.comparisons.find(x => x.id === id); return `<li><button type="button" class="ev prev" data-tone="${!c.available?'neutral':id==='spy_1d'?(c.pct<0?'bad':'good'):id==='vix'?(c.change>0?'mixed':'good'):'neutral'}" data-ev="${evAttr({kind: 'today-change', id})}"><span class="lbl">${label[id]}</span> <b>${esc(c.available ? (id === 'spy_1d' ? pct(c.pct) : id === 'us10y' ? fmtU(c.change, 'bp') : fmtU(c.change, 'pt')) : 'n/a')}</b>${c.available ? ` <span class="small dim">${esc(id === 'us10y' ? c.x.current.value.toFixed(2) + '%' : String(c.x.current.value))}</span>` : ''}</button></li>`; }).join('')}<li><button type="button" class="text" data-ev="${evAttr({kind: 'today', id: 'positioning'})}">DXY, breadth</button></li></ul>`;
  }
  function riskLines() {
    const n = enteredNames().length, h = horizonEvents(S.horizon || 7), mine = h.relevant.filter(x => x.entered);
    const first = n ? `${n} entered equit${n === 1 ? 'y' : 'ies'} checked; open options are not covered.` : 'Add holdings to check your personal exposure.';
    const nearest = (mine.length ? mine : n ? h.relevant.filter(x=>x.kind==='macro') : h.relevant).slice(0, 1);
    const second = nearest.length ? `${mine.length ? 'Your next event' : 'Next tracked event'}: ${nearest[0].title} (${when(nearest[0].when)}).${h.complete ? '' : ' Partial calendar.'}` : `No tracked release in ${h.days} days; ${h.complete ? 'tracked calendar checked' : 'partial calendar'}.`;
    return `<p data-risk-priority hidden></p><p>${esc(first)}</p><p>${esc(second)} ${nearest.length ? evBtn({kind: 'event', scope: 'today', i: h.relevant.indexOf(nearest[0])}, 'Source', 'text') : evBtn({kind: 'today', id: 'trust'}, 'Coverage', 'text')}</p>`;
  }
  function shortRow(x) {
    const s = shortSetup(x), why = ((x.why || [])[0]?.text || 'Inspect dated company evidence.').replace(/, provider quarter label [\d-]+\.?/i, '.'), obj = s.concern.measured ? s.concern.text : s.signal;
    return `<li data-short="${esc(x.t)}"><p class="short-name"><a href="#/markets?sel=${esc(x.t)}">${esc(x.t)}</a> <span class="dim">${esc(x.name)}</span></p><p class="short-why">${esc(why)}</p><div class="short-actions"><details class="short-risk"><summary data-short-category="${esc(x.t)}">${esc(s.category)}</summary><p data-short-caution="${esc(x.t)}"><b>Against:</b> ${esc(obj)}</p></details>${evBtn({kind: 'shortlist', t: x.t}, `Evidence<span class="sr"> for ${esc(x.t)}</span>`, 'text')}</div></li>`;
  }
  // Income environment from measured inputs (posture, VIX, the name's event date and delayed IV/RV) - separate from
  // contract premium quality, which stays unrated without option chains. One next check; the limitation sits beside it.
  function incomeBrief(model, t) {
    const income = objectiveModel(model,S.brief,horizonEvents(S.horizon||7),S.core).find(x=>x.id==='income');
    return `<p class="decision-label" data-tone="${objectiveTone(income,model)}">${cue(objectiveTone(income,model))}<b>${esc(income.word)}</b></p><p>${esc(income.summary)}</p><p class="small dim">Contract premium quality is not rated; check live bid/ask and the expiry's event window.</p><p class="actions"><a class="btn" href="#/workspace/strategies?t=${esc(t || 'SPY')}&tab=pocket">Explore income</a> ${evBtn({kind: 'objective', id: 'income'}, 'Conditions & assumptions', 'text')}</p>`;
  }

  function rotationDesk() {
    const C=root.SmartOptionsCockpit,H=root.SmartOptionsHeatmap;
    return C.rotationHTML(C.rotation(S.core,Live.snapshot().quotes,S.heatPeriod||'1D',H),S.deskExposure||{})+(Object.keys(S.deskExposure||{}).length?'<p class="small dim">Exposure: priced entered equities only; missing values excluded. Open options are not included.</p>':'');
  }
  function deskEvents(filter='all') {
    const h=horizonEvents(S.horizon||7),items=h.items.map((x,i)=>({x,i})).filter(({x})=>filter==='all'||(filter==='earnings'?x.kind==='earnings':filter==='fed'?/fed|fomc|monetary/i.test(x.title):x.kind==='macro'));
    S.lastEvents.desk=h.items;
    const priority=x=>x.entered?0:x.saved?1:x.kind==='macro'&&x.major?2:x.kind==='macro'?3:4;
    const selected=[...items].sort((a,b)=>priority(a.x)-priority(b.x)||(row(b.x.t)?.mcap||0)-(row(a.x.t)?.mcap||0)||a.x.when.localeCompare(b.x.when)).slice(0,5).sort((a,b)=>a.x.when.localeCompare(b.x.when));
    return `<div class="desk-table-wrap"><table class="desk-table events-table"><thead><tr><th>When · ET</th><th>Event</th><th>Watch for</th></tr></thead><tbody>${selected.map(({x,i})=>`<tr><td>${esc(when(x.when))}</td><td>${x.t?`<a href="#/markets?sel=${esc(x.t)}"><b>${esc(x.t)}</b></a> `:''}${evBtn({kind:'event',scope:'desk',i},esc(x.title),'text')}</td><td>${esc(x.kind==='earnings'?'Company gap risk':/fed|fomc|monetary/i.test(x.title)?'Rates & volatility':'Growth / inflation expectations')}</td></tr>`).join('')||'<tr><td colspan="3">No matching event listed in this window.</td></tr>'}</tbody></table></div><p class="small dim">${selected.length} of ${items.length} listed · next ${S.horizon||7} days · holdings and macro first. Partial calendar. <a href="#/macro">Calendar & sources →</a></p>`;
  }
  function deskPlaybook() {
    const t=enteredNames()[0]||WL().get()[0]||'SPY';
    return `<table class="desk-table playbook-table"><thead><tr><th>Approach</th><th>When to investigate</th></tr></thead><tbody><tr><td><a href="#/workspace/strategies?t=${esc(t)}&tab=pocket">Cash-secured put</a></td><td>Only at a price you would own; reserve assignment cash.</td></tr><tr><td><a href="#/workspace/strategies?t=${esc(t)}&tab=pocket">Covered call</a></td><td>Against shares you own, at an exit price you accept.</td></tr><tr><td><a href="#/workspace/strategies?t=${esc(t)}">Defined-risk spread</a></td><td>Compare capped loss, liquidity and the event window.</td></tr><tr><td>Wait</td><td>When compensation or event risk does not justify the exposure.</td></tr></tbody></table>`;
  }
  function renderBrief(main, legacy) {
    const b=S.brief,short=(b.shortlist||[]).slice(0,6),model=todayModel(b,S.core),tk=takeaway(model,b),C=root.SmartOptionsCockpit;
    const decision=S.todayTab||'market',trend=C.trend(b),incomeName=enteredNames()[0]||WL().get()[0]||short[0]?.t;
    Live.watch('index',['SPY','RSP']);Live.watch('research',short.map(x=>x.t));Live.watch('company',[]);
    const sit=S.sitCtl?.get()?situationModelNow():null,wide=doc.documentElement.clientWidth>=1000;
    main.innerHTML=`${legacy?'<p class="note">That older link opened Today. All tools are in Workspace.</p>':''}
    <div class="today decision-desk" data-today-active="${esc(decision)}">
      <div class="desk-date"><h1>Today’s market brief</h1><p>Cash close ${esc(shortDate(model.session))} <span>•</span> Updated ${esc(model.updated)} ${evBtn({kind:'today',id:'trust'},'Data & sources','text')}</p></div>
      <nav class="today-decisions" aria-label="Your decisions">${[['market','Brief','Market & changes'],['my-risk','My risk',enteredNames().length?'Your holdings':'Personalize'],['income','Income','Conditions & ideas'],['opportunity','Growth','Research shortlist']].map(([id,label,status])=>`<button type="button" data-today-panel="${id}" aria-controls="${id}" aria-pressed="${decision===id}"><b>${label}</b><span>${status}</span></button>`).join('')}</nav>
      <section class="read" id="market" aria-labelledby="read-h"><div class="market-grid">
        <div class="market-main desk-panel regime-panel"><div class="desk-heading"><h2 id="read-h"><span class="desk-symbol" aria-hidden="true">◒</span> Market regime</h2>${evBtn({kind:'today',id:'posture'},'How it’s formed','text')}</div>
          <div class="regime-layout"><div class="regime-summary"><h3 class="headline" data-tone="${postureTone(model)}">${cue(postureTone(model))}<span class="headline-copy">${esc(model.label.replace(' market conditions','').replace(' conditions',''))}</span></h3>
          <p class="tk-so"><span data-current-message>${esc(currentMessage(model,sit,tk.so))}</span></p></div>
          <div class="regime-body"><ul class="market-reasons assessment-grid">${model.signals.map(s=>`<li><button type="button" class="ev reason" data-ev="${evAttr({kind:'assessment',id:s.id})}" aria-label="${esc(s.title+': '+s.word)}">${cue(s.tone)}<span class="reason-copy"><span class="signal-name">${esc(s.title)}</span><b>${esc(s.status?s.status.charAt(0).toUpperCase()+s.status.slice(1):s.word)}</b></span><span class="chev" aria-hidden="true">›</span></button></li>`).join('')}</ul>
          <details class="regime-watch" ${wide?'open':''}><summary>What would change this read</summary><div class="regime-triggers"><div class="trigger-positive"><b>What would improve the read</b><ul>${trend.positive.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div><div class="trigger-negative"><b>What would weaken it</b><ul>${trend.negative.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div><p class="small dim">Conditional watch points, not price targets. ${evBtn({kind:'assessment',id:'price_trend'},'Trend evidence','text')}</p></div></details></div></div>
          <div class="session-changes"><h3>Since previous session</h3>${prevRow(model)}</div>
        </div>
        <div class="desk-panel chart-panel" data-price-panel><div class="desk-heading"><h2><a href="#/markets?sel=SPY">SPY <span>S&P 500 ETF</span></a></h2><a class="desk-action" href="#/markets?sel=SPY">Analyze →</a></div>
          <div class="desk-price"><strong>${liveSpan('SPY','price',true)}</strong><span>${liveSpan('SPY','chg',true)}</span></div><p class="desk-quote-clock" data-live="SPY" data-live-f="note"></p>
          <div class="desk-chart-body"><div class="desk-chart-main"><div class="desk-segment" role="group" aria-label="SPY chart range">${['1M','3M','6M','1Y'].map(r=>`<button data-chart-range="${r}" aria-pressed="${r==='6M'}">${r}</button>`).join('')}</div><div data-desk-chart></div><div class="desk-chart-legend" data-chart-legend></div><p class="small dim" data-chart-basis>Loading daily price history…</p></div>
          <aside class="trend-levels"><h3>Trend levels</h3>${trend.levels.map(x=>`<div><span>${esc(x.name)}</span><b>$${x.value.toFixed(2)}</b></div>`).join('')}<p>${esc(trend.summary)}</p>${evBtn({kind:'assessment',id:'price_trend'},'Method & dates','text')}<a class="desk-action" href="#/explore">Test a market shock →</a></aside></div>
          <details class="chart-provenance"><summary>Chart source & interpretation</summary><p data-chart-source></p><p>Unadjusted daily candles and simple trailing averages, ending at the completed cash session. Live quotes above retain their own observation time; they do not fabricate a daily candle or intraday signal.</p></details>
        </div>
      </div><div id="situation" class="situation" aria-live="polite">${situationHtml()}</div></section>
      <div class="today-blocks" data-active="${esc(decision)}">
<div class="desk-column">        <section id="my-risk" class="desk-panel attention-panel"><div class="desk-heading"><h2><span class="desk-symbol risk-symbol" aria-hidden="true">!</span> Needs attention</h2><a class="desk-action" href="#/positions">My holdings →</a></div><div data-desk-attention>${C.attentionHTML(null)}</div><details class="attention-context"><summary>Risk context & upcoming events</summary>${riskLines()}<button type="button" class="text" data-open="ahead-more">All upcoming risks</button></details><details id="ahead-more" class="more"><summary>Full personal review</summary><div id="ahead">${aheadHtml()}</div><section id="for-you" class="for-you" aria-label="For you"></section></details></section>
        <section id="desk-events" class="desk-panel"><details class="desk-fold" ${wide?'open':''}><summary>Key events <span data-desk-horizon>Next ${S.horizon||7} days</span></summary><div class="desk-segment event-filters" role="group" aria-label="Filter key events">${[['all','All'],['earnings','Earnings'],['macro','Macro'],['fed','Fed']].map(([id,label])=>`<button data-desk-event="${id}" aria-pressed="${(S.deskEventFilter||'all')===id}">${label}</button>`).join('')}</div><div data-desk-events>${deskEvents(S.deskEventFilter||'all')}</div></details></section>
</div><div class="desk-column">        <section id="rotation" class="desk-panel"><details class="desk-fold" ${wide?'open':''}><summary>Sector rotation <span>S&P 500</span></summary><div class="desk-heading rotation-heading"><div class="desk-segment" role="group" aria-label="Sector rotation period">${['1D','1W','1M'].map(p=>`<button data-map-period="${p}" aria-pressed="${(S.heatPeriod||'1D')===p}">${p}</button>`).join('')}</div><a class="desk-action" href="#/markets?p=${esc(S.heatPeriod||'1D')}" data-open-grid>Full interactive map →</a></div>${slot('rotation-table',rotationDesk)}<div class="rotation-foot">${slot('map-health',mapHealthSlot)}${evBtn({kind:'today',id:'positioning'},'Coverage & method','text')}</div><details class="market-map-detail"><summary>View market-cap map</summary><div class="map-preview">${slot('heat',heatSlot)}<a href="#/markets" class="desk-action">Filter, compare and stress the full map →</a></div></details><p class="small dim">Cap-weighted covered names · ${esc(b.asof_session)} · 1M relative return is a percentage-point gap, not index attribution.</p></details></section>
        <section id="income" class="desk-panel"><div class="desk-heading"><h2><span class="desk-symbol" aria-hidden="true">↗</span> Income playbook</h2>${evBtn({kind:'objective',id:'income'},'Conditions','text')}</div>${incomeBrief(model,incomeName)}<details class="income-approaches" ${wide?'open':''}><summary>Choose an approach</summary>${deskPlaybook()}</details></section>
</div>        <section id="opportunity" class="research desk-panel"><div class="desk-heading"><h2>Research shortlist <span>Quality ≠ entry timing</span></h2><a class="desk-action" href="#/companies?mode=shortlist">All eligible ideas →</a></div><ul class="short-list">${short.map(shortRow).join('')||'<li>No company met the coverage rule.</li>'}</ul></section>
      </div><section id="deep-dive" class="deep-strip"><nav aria-label="Deep dive"><a href="#/markets">Market map & shocks</a><a href="#/macro">Macro & events</a><a href="#/explore">Compare</a><a href="#/room">Saved rooms</a><a href="#/workspace">All tools</a></nav><details><summary>Relationships and evidence to investigate</summary><div class="insights">${insightCard(concentrationInsight(S.core.rel?.vol_breadth))}${S.rel?insightCard(leadershipInsight(S.rel))+insightCard(macroInsight(S.rel,S.core)):''}</div><p class="dim">${slot('live-conc',liveConcSlot)}</p></details></section>
    </div>`;
    S.mod=C.mountChart(main.querySelector('[data-price-panel]'),{charts:root.LightweightCharts,history:historyFor,sma:W.sma,session:b.asof_session});
    S.personal=root.SmartOptionsInvestor.mountToday($('#for-you'),{...investorArgs(),compact:true,onReview(review){
      const target=main.querySelector('[data-risk-priority]');if(target){target.hidden=review.scope!=='positions'||!review.text;if(target.textContent!==review.text)target.textContent=review.text;}
      const attention=main.querySelector('[data-desk-attention]'),html=C.attentionHTML(review);if(attention&&attention.innerHTML!==html){const focused=attention.contains(doc.activeElement)?doc.activeElement.getAttribute('href'):null;attention.innerHTML=html;if(focused)[...attention.querySelectorAll('a')].find(a=>a.getAttribute('href')===focused)?.focus({preventScroll:true});}
      const priced=review.scope==='positions'?review.summary?.priced||[]:[],total=priced.reduce((s,p)=>s+p.value,0),exposure={};priced.forEach(p=>{const sec=p.r?.sec;if(sec&&total>0)exposure[sec]=(exposure[sec]||0)+100*p.value/total;});
      if(JSON.stringify(S.deskExposure)!==JSON.stringify(exposure)){S.deskExposure=exposure;const el=$('#rotation-table');if(el)el.innerHTML=rotationDesk();}
    }});
    S.onQuote=changed=>S.personal?.quotes(changed);
    main.querySelectorAll('[data-today-panel]').forEach(button=>button.onclick=()=>{selectTodayPanel(button.dataset.todayPanel);const panel=main.querySelector('#'+button.dataset.todayPanel),heading=panel.querySelector('h2');heading.tabIndex=-1;heading.focus({preventScroll:true});panel.scrollIntoView({block:'start'});});
    main.querySelectorAll('[data-desk-event]').forEach(button=>button.onclick=()=>{S.deskEventFilter=button.dataset.deskEvent;main.querySelectorAll('[data-desk-event]').forEach(x=>x.setAttribute('aria-pressed',String(x===button)));main.querySelector('[data-desk-events]').innerHTML=deskEvents(S.deskEventFilter);});
    S.news=null;trimReasons();
  }
  function selectTodayPanel(id) {
    if (!['market','my-risk','income','opportunity'].includes(id)) return;
    const panels=doc.querySelector('.today-blocks');if(!panels)return;
    S.todayTab=id;panels.dataset.active=id;doc.querySelector('.today').dataset.todayActive=id;
    doc.querySelectorAll('[data-today-panel]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.todayPanel===id)));root.dispatchEvent(new Event('resize'));
  }
  function investorArgs() {return {core:S.core,brief:S.brief,live:Live,watch:WL(),compare:companyHref,events:()=>horizonEvents(S.horizon||7),days:()=>S.horizon||7};}
  /* ------------------------------------------------------------ saved companies (shared store) */
  let wlStore = null;
  function WL() {
    if (wlStore) return wlStore;
    const Store = root.SmartOptionsWatchlistStore;
    let storage; try { storage = root.localStorage; } catch (e) { storage = {getItem() { throw e; }, setItem() { throw e; }}; }
    wlStore = Store ? Store.create(storage, msg => { UI.wlNote = msg; doc.querySelectorAll('.wl-note').forEach(n => { n.textContent = msg || ''; n.hidden = !msg; }); })
      : {get: () => [], add() {}, remove() {}, has: () => false, status: () => ({ok: false, error: 'Saved companies module did not load.'})};
    if (!root.SmartOptionsWatchlist) root.SmartOptionsWatchlist = wlStore;   // the chat module reads saved names here
    return wlStore;
  }
  function starBtn(t) { const on = WL().has(t); return `<button type="button" class="star" data-star="${esc(t)}" aria-pressed="${on}" aria-label="${on ? 'Remove ' + esc(t) + ' from' : 'Save ' + esc(t) + ' to'} saved companies">${on ? '★ Saved' : '☆ Save'}</button>`; }
  function toggleStar(t) {
    const W2 = WL(); if (W2.has(t)) W2.remove(t); else W2.add(t);
    doc.querySelectorAll(`[data-star="${t}"]`).forEach(b => { b.outerHTML = starBtn(t); });
    if(S.view==='brief')S.personal?.refresh();
    return W2.has(t);
  }

  /* ------------------------------------------------------------ evidence sheet: one at a time, focus returns */
  let sheetTrigger = null;
  function sheetEl() {
    let el = doc.getElementById('sheet'); if (el) return el;
    const bg = doc.createElement('div'); bg.id = 'sheet-bg'; bg.hidden = true; bg.addEventListener('click', closeSheet);
    el = doc.createElement('aside'); el.id = 'sheet'; el.hidden = true; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-labelledby', 'sheet-h');
    el.innerHTML = '<div class="sheet-hd"><h2 id="sheet-h"></h2><button type="button" class="sheet-x" aria-label="Close evidence">Close</button></div><div class="sheet-body"></div>';
    el.querySelector('.sheet-x').addEventListener('click', closeSheet);
    el.addEventListener('keydown', e => {
      if (e.key !== 'Tab') return;
      const f = [...el.querySelectorAll('a[href],button,select,input,summary,[tabindex="0"]')].filter(x => x.offsetParent !== null);
      if (!f.length) return;
      if (e.shiftKey && doc.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && doc.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    });
    doc.body.append(bg, el); return el;
  }
  const sheetOpen = () => { const el = doc.getElementById('sheet'); return !!(el && !el.hidden); };
  function closeSheet() {
    const el = doc.getElementById('sheet'); if (!el || el.hidden) return;
    el.hidden = true; doc.getElementById('sheet-bg').hidden = true; doc.documentElement.classList.remove('sheet-open');
    const t = sheetTrigger; sheetTrigger = null; if (t && t.isConnected) t.focus({preventScroll: true});
  }
  function openSheet(ev, trigger) {
    let content;
    try { content = evidence(ev); } catch (e) { console.error('[brief] evidence failed', e); content = {title: 'Evidence unavailable', html: `<p>This evidence could not be assembled from the published data (${esc(e.message)}).</p>`}; }
    const el = sheetEl(), origin = trigger || doc.activeElement, nested = sheetOpen() && el.contains(origin);
    el.querySelector('#sheet-h').textContent = content.title;
    el.querySelector('.sheet-body').innerHTML = content.html + (content.ask && root.SmartOptionsIntents ? `<p><button type="button" class="cp-context" data-intent="${esc(content.ask.intent)}" data-entities="${evAttr(content.ask.entities || {})}">Ask about this</button></p>` : '');
    el.dataset.kind = ev.kind; el.hidden = false; doc.getElementById('sheet-bg').hidden = false; doc.documentElement.classList.add('sheet-open');
    if (!nested) sheetTrigger = origin;
    el.querySelector('.sheet-x').focus({preventScroll: true});
  }
  const defText = label => { const d = MEANINGS.find(([re]) => re.test(label)); return d ? `<p class="def">${esc(d[1])}</p>` : ''; };
  function changeHtml(x) {
    if (!x) return '<p>This comparison is not in the current data build.</p>';
    if (x.status !== 'ok') return `<p><b>Change unavailable:</b> ${esc(x.reason)}</p><p class="dim">No direction is reported without two comparable observations.</p>`;
    const v = n => x.unit === 'USD/share' ? px(n) : (+n.toFixed(2)) + (x.unit === '%' || /%/.test(x.unit) ? '%' : ' ' + x.unit);
    return `<table><tr><td>Current</td><td class="n">${esc(v(x.current.value))}</td><td class="dim">${esc(x.current.date)}</td></tr><tr><td>Prior (${esc(x.comparison)})</td><td class="n">${esc(v(x.prior.value))}</td><td class="dim">${esc(x.prior.date)}</td></tr>
      <tr><td>Change</td><td class="n">${esc(x.unit === 'USD/share' ? pct(x.pct_change) : (x.change > 0 ? '+' : '') + (+x.change.toFixed(2)) + ' ' + (x.unit === 'pp' ? 'pp' : x.unit))}</td><td class="dim">${esc(x.direction)}</td></tr></table>
      ${x.cohort ? `<p class="dim">Cohort: ${x.cohort.n} names with bars on both dates (${x.cohort.excluded} excluded from both shares); ${esc(x.cohort.basis)}.</p>` : ''}
      ${x.counts ? `<p class="dim">${x.counts.prior} → ${x.counts.current} names above their average.</p>` : ''}
      <p class="dim">${esc(x.note || '')} Source: ${x.source_url ? `<a href="${esc(x.source_url)}" target="_blank" rel="noopener">${esc(x.source)}</a>` : esc(x.source)}.</p>`;
  }
  function evidence(ev) {
    if (ev.kind === 'situation') return situationEvidence(ev);
    const b = S.brief;
    const model=todayModel(b,S.core);
    if(ev.kind==='today-change'){
      const c=model.comparisons.find(c=>c.id===ev.id),macroId=['vix','us10y','dxy'].includes(ev.id)?ev.id:null;
      const href=macroId?W.encodeHash({s:[{id:'eq:SPY'},{id:'mac:'+macroId}],r:'6m',m:'z'}):ev.id==='spy_1d'?W.encodeHash({s:[{id:'eq:SPY'}],r:'6m',m:'index'}):W.encodeHash({s:[{id:'eq:RSP'},{id:'eq:SPY'}],r:'6m',m:'index'});
      return {title:CHANGE_NAMES[ev.id]+' · previous session',html:`<p class="lead">${esc(comparisonText(c))}</p><p>${esc(comparisonMeaning(c))}</p>${c.available?'':'<p>Retained observation below is not a valid previous-session comparison.</p>'}${changeHtml(c.x)}<p>Source observation: ${esc(c.x?.current?.date||'unavailable')} · last refreshed: ${esc(c.x?.retrieved_at||'not supplied')}. Yield percentage-point changes ×100 = basis points. DXY points and percent changes are separate.</p><p><a href="${esc(href)}">Open exact historical comparison</a>${macroId?' · <a href="#/macro">Macro observations and sources</a>':''}</p>`};
    }
    if(ev.kind==='today'){
      if(ev.id==='posture')return {title:'How the market read is formed',html:`<p class="lead">${esc(model.label)}</p>${(()=>{const tk=takeaway(model,S.brief);return (tk.supports.length?`<p><b>Supports:</b> ${esc(listJoin(tk.supports))}.</p>`:'')+(tk.challenges.length?`<p><b>Challenges:</b> ${esc(listJoin(tk.challenges))}.</p>`:'')+`<p><b>So what:</b> ${esc(tk.so)}</p>`;})()}<p>Completed session ${esc(model.session)}. A decision table, not a score or forecast.</p><p>High measured risk takes precedence, then adverse price with narrowing participation. A supportive reading requires all four complete signals. Missing price or comparable breadth means incomplete; missing macro/risk limits the broader reading.</p>${model.signals.map(s=>`<p><b>${esc(s.title)}: ${esc(s.word)}</b> · ${esc(s.qty)} ${evBtn({kind:'assessment',id:s.id})}</p>`).join('')}<a href="#/macro">Open detailed Macro evidence</a>`};
      if(ev.id==='trust')return {title:'Data coverage and clocks',html:`<p>Brief assembled ${esc(model.updated)} from retained inputs; this is not a provider observation time. Market assessment: ${esc(model.session)}.</p><h3>Prices</h3><p>Each canonical quote shows its own observation, provider, delay and session. Live prices do not update completed-session signals.</p><a href="${learnHref('Price · SPY')}">Inspect SPY quote and method</a><h3>Macro</h3>${(b.macro?.detail||[]).map(d=>`<h4>${esc(GROUPS[d.group]||d.group)}</h4>${metricTable(d.metrics,true)}`).join('')}<h3>Fundamentals</h3><p>Retained statements keep actual provider fiscal periods. Own-history valuation and revisions are not universally available. Assembly time does not make them current.</p><a href="#/companies?mode=shortlist">Exact company periods and evidence</a><h3>Events</h3>${(b.calendar_coverage?.sources||[]).map(s=>`<p>${esc(s.source)} · ${esc(s.status)} · retrieved ${esc(s.retrieved_at||'unavailable')}. ${esc(s.note)}</p>`).join('')||'<p>Coverage unavailable; no deeper coverage observation exists.</p>'}<p>${esc((b.calendar_coverage?.gaps||[]).join('; '))}</p><a href="#/macro">Release observations and sources</a>`};
      if(ev.id==='mover'||ev.id==='volume'){const r=row(ev.t),volume=ev.id==='volume';return {title:ev.t+(volume?' · volume ratio':' · session mover'),html:`<p>${esc(ev.t)} ${volume?r.vr.toFixed(2)+'×':pct(r?.d1)} at ${esc(b.asof_session)}. Source: retained Yahoo ${volume?'volume':'closes'}; refreshed ${esc(S.core.gen?.equities||'unavailable')}. Method: ${volume?'session volume / retained 20-session average volume':'close/prior close minus one, ×100'}. ${volume?'A ratio measures activity, not buying versus selling flow or a volatility forecast.':'Movement is not an investment thesis.'}</p><p><a href="#/company/${esc(ev.t)}/drivers">${esc(ev.t)} Chart & drivers</a> · <a href="#/company/${esc(ev.t)}/fundamentals">${esc(ev.t)} Fundamentals</a></p>`};}
      if(ev.id==='positioning')return {title:'S&P positioning evidence',html:`<p>Participation is directional only over the labeled five-session same cohort. Provider-cap share is not actual index attribution.</p>${changeHtml(changeItem(b,'breadth_50_5d'))}${changeHtml(changeItem(b,'eq_cap_gap_5d'))}${metricTable([...(b.positioning?.concentration?.metrics||[]),...(b.positioning?.rotation?.metrics||[])],true)}<a href="${esc(W.encodeHash({s:[{id:'eq:RSP'},{id:'eq:SPY'}],r:'6m',m:'index'}))}">Compare RSP and SPY</a>`};
    }
    if(ev.kind==='objective'){
      const x=objectiveModel(model,b,horizonEvents(S.horizon||7),S.core).find(x=>x.id===ev.id),h=horizonEvents(S.horizon||7);
      const names=ev.id==='growth'?(b.shortlist||[]).map(x=>x.t):[...new Set([...enteredNames(),...WL().get()])];
      return {title:x.title+' · investigation conditions',html:`<p class="lead">${esc(x.word)}</p><p>${esc(x.summary)}</p><p>${esc(x.limit)}</p><p>Equities entered: ${enteredNames().length}; companies followed: ${WL().get().length}. These are different scopes. Options positions are not covered.</p>${ev.id==='growth'?(b.shortlist||[]).map(n=>`<h3>${esc(n.t)}</h3>${setupEvidence(shortSetup(n))}`).join(''):`<p>${esc(h.notes.join(' '))}</p>${model.signals.filter(s=>['price_trend','risk'].includes(s.id)).map(s=>`<p>${esc(s.title)}: ${esc(s.word)} ${evBtn({kind:'assessment',id:s.id})}</p>`).join('')}`}${ev.id==='income'?'<p>No chain, liquidity, IV-history or priced contract basis supports Good/Selective/Poor premium ratings. VIX and delayed ATM IV do not establish premium quality. A covered call retains share downside and caps gains; shares must be available to cover it. Realized volatility is not implied volatility.</p>':''}<p>Choose an exact company to investigate:</p>${names.length?names.map(t=>`<p><a href="#/company/${esc(t)}/${ev.id==='growth'?'fundamentals':ev.id==='protect'?'events':'options'}">${esc(t)} ${ev.id==='growth'?'Fundamentals':ev.id==='protect'?'Events':'Options'}</a> · <a href="#/company/${esc(t)}/drivers">Chart & drivers</a> · <a href="#/company/${esc(t)}/events">Events</a></p>`).join(''):'<p>No company selected. Use <a href="#/companies">company search</a> to choose one; no ticker is assumed.</p>'}<a href="#/macro">Macro constraints and release evidence</a>`};
    }
    if (ev.kind === 'assessment') {
      const m = b.macro || {}, a = model.signals.find(x => x.id === ev.id), obj = ev.id === 'participation' ? (b.positioning && b.positioning.breadth) || m.participation : m[ev.id];
      let html = `<p class="lead"><b>${esc(a.word)}</b> · ${esc(a.qty)}</p><p class="dim">${esc(a.basis)}</p>`;
      if (ev.id === 'participation') html += `<h3>Dated five-session change</h3>${changeHtml(changeItem(b, 'breadth_50_5d'))}<p class="dim">The older model label “${esc(obj && obj.status)}” classifies levels against fixed thresholds (≥60% broad, &lt;40% thin on both 50- and 200-session shares); it does not compare dates.</p>`;
      if (ev.id === 'risk') html += `<h3>Scheduled events (separate from observed stress)</h3><p>${esc(m.risk_events ? m.risk_events.line : 'Scheduled-event condition unavailable.')}</p>`;
      if (ev.id === 'backdrop') html += ['growth', 'inflation', 'policy'].map(k => m.backdrop && m.backdrop[k] ? `<p><b>${GROUPS[k]}:</b> ${esc(m.backdrop[k].line)}</p>` : '').join('');
      html += `<h3>Inputs and sources</h3>${metricTable(ev.id === 'backdrop' ? ['growth', 'inflation', 'policy'].flatMap(k => (m.backdrop[k] && m.backdrop[k].metrics || []).slice(0, 4)) : obj && obj.metrics, true)}`;
      html+=`<p>Coverage: ${esc(a.coverage)}. ${esc((obj?.missing||[]).join('; '))}</p><p>Rule: ${esc(obj?.rule||'Same-cohort dated direction; levels do not establish change.')}</p><p><a href="${esc(ev.id==='participation'?W.encodeHash({s:[{id:'eq:RSP'},{id:'eq:SPY'}],r:'6m',m:'index'}):ev.id==='price_trend'?W.encodeHash({s:[{id:'eq:SPY'}],r:'1y',m:'index',ind:{sma:[50,200]}}):'#/macro')}">Open ${ev.id==='participation'?'RSP and SPY comparison':ev.id==='price_trend'?'SPY chart':'detailed Macro observations'}</a></p>`;
      return {title: a.title, html: html + defText(a.title === 'Participation' ? 'market breadth' : a.title === 'Risk conditions' ? 'VIX volatility' : a.title === 'Macro backdrop' ? 'inflation CPI' : 'average trend'), ask: {intent: {price_trend: 'pulse', participation: 'breadth', backdrop: 'pulse', risk: 'risks'}[ev.id], entities: {}}};
    }
    if (ev.kind === 'change') {
      const d = b.daily_changes || {};
      if (ev.id === 'sectors') {
        const s = d.sectors || {};
        return {title: 'Sector moves, latest session', html: s.status !== 'ok' ? `<p>Unavailable: ${esc(s.reason || 'not computed')}</p>` : `<p class="dim">${esc(s.from_date)} → ${esc(s.to_date)} · ${esc(s.basis)}</p><table>${s.items.map(x => `<tr><td><a href="#/sector/${encodeURIComponent(x.sector)}">${esc(x.sector)}</a></td><td class="n">${pct(x.ret_pct)}</td><td class="dim">${x.covered}/${x.n} names</td></tr>`).join('')}</table>`};
      }
      const x = (d.items || []).concat(d.macro || []).find(i => i.id === ev.id);
      return {title: x ? x.label : 'Change', html: changeHtml(x) + defText(x ? x.label : '')};
    }
    if (ev.kind === 'pulse') {
      const x = ((b.pulse || {})[ev.id] || [])[ev.i];
      return {title: ev.id === 'supports' ? 'Support' : 'Challenge', html: x ? `<p class="lead">${esc(x.text)}</p>${metricTable(x.metrics, true)}` : '<p>Not in the current brief.</p>', ask: {intent: 'pulse', entities: {}}};
    }
    if (ev.kind === 'shortlist') {
      const x = (b.shortlist || []).find(s => s.t === ev.t);
      if (!x) return {title: ev.t, html: '<p>Not on the current shortlist.</p>'};
      return {title: `${x.t}: case and caution`, html: `${setupEvidence(shortSetup(x))}<h3>Dated business case</h3><ul>${x.why.map(w => `<li>${esc(w.text)}</li>`).join('')}</ul><p><b>Fundamental assessment only:</b> ${esc(x.counter.text)}</p>
        <p class="dim">Research score ${x.score} of 100. ${esc(x.score_basis)} The score orders the list; it is not a forecast.</p><p class="dim">Dimension status: ${CARD_ORDER.map(k => `${CARD_NAME[k]} ${esc(x.status[k])}`).join(' · ')}</p>
        <p>At least two strong core business dimensions, measured growth/profitability/valuation and no weak core business dimension permit Quality research. This does not establish technical strength. A listed event adds Event watch.</p><p><a href="#/company/${esc(x.t)}/fundamentals">Open ${esc(x.t)} Fundamentals</a> · <a href="#/company/${esc(x.t)}/drivers">Chart & drivers</a> · <a href="${esc(companyHref(x.t,x.sector))}">Compare with SPY and sector</a> · <a href="#/company/${esc(x.t)}/events">Events</a> · <a href="#/company/${esc(x.t)}/options">Options</a></p>${metricTable(x.why.flatMap(w => w.metrics).concat(x.counter.metrics || []), true,x.t)}`, ask: {intent: 'shortlist', entities: {tickers: [x.t]}}};
    }
    if(ev.kind==='research'){
      const t=ev.t,x=(b.shortlist||[]).find(x=>x.t===t),s=researchSetup(x,row(t),{company:S.company[t],session:b.asof_session,events:horizonEvents(S.horizon||7)});
      return {title:t+' · measured case concerns',html:setupEvidence(s)+`<p><a href="#/company/${esc(t)}/drivers">${esc(t)} Chart & drivers</a> · <a href="#/company/${esc(t)}/fundamentals">Fundamentals</a> · <a href="#/company/${esc(t)}/events">Events</a></p>`};
    }
    if (ev.kind === 'card') {
      const c = S.company[ev.t], k = c && c.cards[ev.id];
      if (!k) return {title: CARD_NAME[ev.id] || 'Evidence', html: '<p>Company evidence is not loaded.</p>'};
      if(ev.id==='counter'){
        const s=researchSetup((b.shortlist||[]).find(x=>x.t===ev.t),row(ev.t),{company:c,session:b.asof_session,events:horizonEvents(S.horizon||7)});
        return {title:ev.t+' · measured countercase',html:setupEvidence(s)+`<h3>Fundamental assessment only</h3><p>${esc(k.line)}</p>${metricTable(k.metrics,true)}<a href="#/company/${esc(ev.t)}/drivers">Open Chart & drivers</a>`,ask:{intent:'ticker_card',entities:{tickers:[ev.t],card:'counter'}}};
      }
      return {title: `${ev.t} · ${CARD_NAME[ev.id]}`, html: `<p class="dim">${esc(CARD_Q[ev.id])}</p><p class="lead"><span class="st" data-status="${esc(k.status)}">${esc(k.status)}</span> ${esc(k.line)}</p>${ev.id === 'valuation' ? `<p>${valSlot(ev.t, k)()}</p><p class="dim">Peer comparison uses the broad sector median, not a curated peer group; the company's own valuation history is not available in this build.</p>` : ''}${metricTable(k.metrics, true)}${defText(CARD_NAME[ev.id])}`,
        ask: {intent: 'ticker_card', entities: {tickers: [ev.t], card: ev.id}}};
    }
    if(ev.kind==='map-health') {
      const period=S.heatPeriod||'1D',map=root.SmartOptionsHeatmap.sessionMap(S.core.rows,Live.snapshot().quotes,period,S.core.asof_session),known=map.values.filter(r=>isNum(r.value)),up=known.filter(r=>r.value>0).length;
      return {title:'S&P map coverage and method',html:`<p class="lead">${up} of ${known.length} mapped names rose over ${esc(period)}, through ${esc(map.session)}.</p><p>Count share = positive covered returns ÷ all covered returns. Zero returns stay in the denominator. This is an equal-name count; the index and sector returns are weighted differently.</p><p>The map covers ${map.covered}/${map.members} members with positive market-cap inputs. Missing values are excluded, never treated as zero. Periods use the published 1, 5 or 21-session return. Newer incomplete sessions are not mixed with this dated map.</p><p>Tile area = published market value. Sector return = sum of each covered member's market value × its period return, divided by covered sector market value. This basket is not the official sector index.</p><p>Source: retained Yahoo Finance prices and market values. Observation: ${esc(map.session)}; dataset generated: ${esc(S.core.generated_at||S.core.asof||'see Data and sources')}. A build time is not a quote time.</p><a href="#/markets?p=${esc(period)}">Open the covered names, filters and ranking</a>`};
    }
    if (ev.kind === 'event') {
      const x = ((S.lastEvents || {})[ev.scope] || [])[ev.i];
      if (!x) return {title: 'Event', html: '<p>This event is no longer in the selected window.</p>'};
      return {title: x.title, html: `<p class="lead">${when(x.when)} ${esc(timingWord(x))} · ET calendar</p><p>${x.kind === 'earnings' ? `Provider date: ${esc(x.source || 'Yahoo Finance')}, retrieved ${esc(x.retrieved || 'n/a')}. ${x.timing === 'date_only' ? 'No time of day is supplied, so this is a date, not a scheduled moment.' : ''} Results can reset expectations; this is an event constraint, not evidence against the company.` : `${esc(x.note)}. <a href="${esc(x.source_url || '#')}" target="_blank" rel="noopener">Release calendar</a>`}</p><p>${x.entered?'Entered equity':x.saved?'Followed company; ownership not assumed':'Public calendar context'}. Coverage incomplete. Selling premium across this event needs an explicit risk decision.</p><p><a href="${x.t?'#/company/'+esc(x.t)+'/events':'#/macro'}">${x.t?esc(x.t)+' Events':'Macro release detail and sources'}</a></p>`};
    }
    if (ev.kind === 'metric') {
      const m = S.metricEvidence && S.metricEvidence.get(ev.id);
      return {title: ev.id, html: (m ? metricTable([m], true) : '<p class="dim">Measured value not loaded.</p>') + defText(ev.id)};
    }
    throw new Error('unknown evidence kind ' + ev.kind);
  }
  /* ------------------------------------------------------------ chat: allowlisted main actions, success only after readback */
  const ACTION_TAB = {strategies: 'options', options: 'options', overview: 'overview', fundamentals: 'fundamentals', chart: 'drivers', drivers: 'drivers', events: 'events'};
  async function mainAction(x) {
    const wait = async (pred, what) => { for (let i = 0; i < 100; i++) { try { if (pred()) return; } catch (e) { /* not drawn yet */ } await new Promise(r => setTimeout(r, 50)); } throw new Error('The page did not confirm: ' + what + '.'); };
    const go = h => { if (root.location.hash !== h) root.location.hash = h; };
    if (x.kind === 'watch_add' || x.kind === 'watch_remove') {
      const t = String(x.ticker || '').toUpperCase(); if (!row(t)) throw new Error(t + ' is not in the published data.');
      const add = x.kind === 'watch_add', before = WL().has(t);
      if (before !== add) toggleStar(t);
      if (WL().has(t) !== add) throw new Error('Saved companies change was not confirmed.');
      return {text: before === add ? `${t} is ${add ? 'already' : 'not'} in your saved companies.` : `${add ? 'Saved' : 'Removed'} ${t}${add ? '.' : ' from saved companies.'}`, watch: WL().get()};
    }
    if (x.kind === 'open_ticker') {
      const t = String(x.ticker || '').toUpperCase(); if (!row(t)) throw new Error(t + ' is not in the published data.');
      const tab = x.tab ? ACTION_TAB[x.tab] : null; if (x.tab && !tab) throw new Error('That company section is not available here.');
      go('#/company/' + t);
      await wait(() => $('.co[data-t="' + t + '"]') && route(root.location.hash).t === t, t + ' dossier');
      if (tab) { selectTab(tab); await wait(() => $(`.co-tabs [data-tab="${tab}"]`).getAttribute('aria-selected') === 'true' && !$(`#panel-${tab}`).hidden, tab + ' tab'); }
      return {text: `Opened ${t}${tab ? ' on ' + TABS.find(y => y[0] === tab)[1] : ''}.`, ticker: $('.co').dataset.t, tab: S.coTab};
    }
    if (x.kind === 'show_sector') {
      const sec = S.core.rows.find(r => r.sec === x.sector) ? x.sector : null; if (!sec) throw new Error('That sector is not in the current data.');
      go('#/markets?sec=' + encodeURIComponent(sec) + (S.heatPeriod && S.heatPeriod !== '1D' ? '&p=' + S.heatPeriod : '')); await wait(() => S.view === 'markets' && $('.mk-crumbs') && $('.mk-crumbs').textContent.includes(sec), 'sector grid');
      return {text: `Opened ${sec} (${S.heatPeriod || '1D'} period).`, sector: sec};
    }
    if (x.kind === 'switch_period') {
      if (!['1D', '1W', '1M'].includes(x.period)) throw new Error('Unsupported map period.');
      if (S.view !== 'brief') go('#/');
      await wait(() => $(`[data-map-period="${x.period}"]`), 'map controls');
      selectTodayPanel('market');const mapDetail=$('.market-map-detail');if(mapDetail)mapDetail.open=true;
      $(`[data-map-period="${x.period}"]`).click();
      await wait(() => S.heatPeriod === x.period && $(`[data-map-period="${x.period}"]`).getAttribute('aria-pressed') === 'true', 'map period');
      mapDetail?.scrollIntoView({block:'start'});
      return {text: `Sector map now shows ${x.period}.`};
    }
    if (x.kind === 'expand_macro') { go('#/macro'); await wait(() => S.view === 'macro' && $('.macro-groups'), 'macro view'); return {text: 'Opened the macro observations.'}; }
    if (x.kind === 'sort_filter') {
      const sort = {pe: 'pe', price: 'mcap', change: 'd1', mcap: 'mcap', rating: 'up'}[x.sort || 'mcap'];
      if (x.sort && !sort) throw new Error('That sort is not available in the research table.');
      go('#/companies?mode=all'); await wait(() => S.view === 'companies' && $('#co-sort'), 'research table');
      S.co.mode = 'all'; S.co.sector = x.sector || ''; S.co.sort = sort; S.co.page = 0; renderCompanies($('#view'));
      await wait(() => $('#co-sort').value === sort && $('#co-sector').value === (x.sector || ''), 'table controls');
      if (x.sector && $('#co-sector').value !== x.sector) throw new Error('The sector filter was not applied.');
      return {text: 'Research table updated' + (x.sector ? ' to ' + x.sector : '') + (x.sort ? ', sorted by ' + x.sort : '') + '.'};
    }
    if (x.kind === 'open_compare') {
      if (!/^#\/explore\?/.test(x.hash || '')) throw new Error('That comparison link is not valid.');
      go(x.hash); await wait(() => S.view === 'explore' && $('#ex-chart canvas'), 'comparison chart');
      return {text: 'Opened the comparison.', series: S.ex.state.s.map(s => s.id)};
    }
    throw new Error('This action is not available on this page.');
  }

  function renderSector(main,sector) {
    const all=S.core.rows.filter(r=>r.sp500_member!==false && r.sec===sector);
    if(!all.length){main.innerHTML='<p>That sector is not in the current membership snapshot.</p>';return;}
    const H=root.SmartOptionsHeatmap, map=H.sessionMap(all,Live.snapshot().quotes,S.heatPeriod||'1D',S.core.asof_session), summary=map.sectors[0];
    const basket=basketId(sector);
    const cov=map.values.filter(r=>isNum(r.value)&&isNum(r.mcap)&&r.mcap>0), capW=cov.reduce((a,r)=>a+r.mcap,0), eqAvg=cov.length?cov.reduce((a,r)=>a+r.value,0)/cov.length:null, ups=cov.filter(r=>r.value>0).length;
    const contrib=cov.map(r=>({t:r.t,c:r.mcap*r.value/capW})).sort((a,b)=>b.c-a.c), cl=xs=>xs.map(x=>`<a href="#/company/${esc(x.t)}">${esc(x.t)}</a> ${pp(x.c)}`).join(', ');
    const sectorFacts=cov.length?`<p>${ups} of ${cov.length} covered names rose; equal-weight average ${pct(eqAvg)} versus cap-weighted ${pct(summary.pct)}${isNum(eqAvg)&&isNum(summary.pct)?` (${Math.abs(eqAvg-summary.pct)<0.05?'about the same':eqAvg>summary.pct?'smaller names did better':'larger names did better'})`:''}.</p><p class="dim small">Largest contributions to the cap-weighted return: ${cl(contrib.slice(0,3))}; largest drags: ${cl(contrib.slice(-3).reverse())}. Contribution = weight × return using current market values.</p>`:'';
    main.innerHTML=`<section><h2>${esc(sector)}</h2><p>${all.length} member companies · ${pct(summary.pct)} covered cap-weighted ${esc(map.period)} return to ${esc(map.session)}; ${summary.covered}/${summary.n} observations (${(summary.coverage*100).toFixed(1)}% of sector market value).</p>${sectorFacts}<p>${learnLink('Sector basket','How weighting works')}</p>${basket?`<a class="go" href="${W.encodeHash({s:[{id:basket},{id:'eq:SPY'},{id:'mac:us10y'},{id:'mac:wti'}],m:'z',r:'1y'})}">Compare sector with SPY, rates & oil →</a>`:'<p>Sector history unavailable; individual company histories remain accessible.</p>'}</section><section><h2>Companies in ${esc(sector)}</h2><label for="sector-find">Filter companies</label><input type="search" id="sector-find" placeholder="Ticker or company"><label>Sort <select id="sector-sort"><option value="cap">Market value</option><option value="return">Return</option><option value="name">Name</option></select></label><table class="list"><tbody id="sector-rows"></tbody></table></section>`;
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
    [/Adjusted close/i,'An adjusted close restates earlier closing prices for splits and dividends so that returns over time compare like with like. It can differ from the unadjusted price shown on a company chart; each dated evidence row states which basis it uses.'],
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
    [/market breadth/i,'Market breadth measures how many constituent stocks participate in a move. The share rising versus the prior close and the share above a moving average answer different questions. A broadening five-session trend can coexist with fewer than half of stocks above their average.'],
    [/labor|payroll|employment|claims|labor participation/i,'Labor measures track jobs, joblessness or new benefit claims. Jobs/payrolls use counts, unemployment uses a percent of the labor force. Stronger employment can support demand but influence inflation and policy. Reference month is not the publication date.'],
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
  /* ------------------------------------------------------------ Companies: research table over the full retained universe */
  const COLS = {
    pe: ['P/E', (r,current=Live.currentRow) => { const c = current(r); return c && isNum(c.pe) ? c.pe.toFixed(1) : '—'; }, (r,current=Live.currentRow) => (current(r) || {}).pe],
    peg: ['PEG', r => isNum(r.peg) ? r.peg.toFixed(2) : '—', r => r.peg],
    range: ['52-wk position', (r,current=Live.currentRow) => { const x = rangePos(current(r), r); return x ? Math.round(x.pos) + '%' : '—'; }, (r,current=Live.currentRow) => (rangePos(current(r), r) || {}).pos],
    er: ['Next earnings', r => r.er ? shortDate(r.er) + (r.ert ? ' ' + r.ert : '') : '—', r => r.er || '9999'],
    analyst: ['Provider opinion', r => r.rating ? esc(opinion(r.rating)) + (isNum(r.up) ? ' · ' + pct(r.up, 0) + ' to target' : '') : '—', r => r.up],
    pef: ['Fwd P/E', (r,current=Live.currentRow) => { const c = current(r); return c && isNum(c.pef) ? c.pef.toFixed(1) : '—'; }, (r,current=Live.currentRow) => (current(r) || {}).pef],
    m1: ['1M', r => pct(r.m1, 1), r => r.m1],
    mcap: ['Mkt value', r => '$' + big(r.mcap), r => r.mcap],
    legacy: ['Jul 25 score', r => r.sam && isNum(r.sam.opp) ? r.sam.opp.toFixed(0) : '—', r => r.sam && r.sam.opp]
  };
  const DEFAULT_COLS = ['pe', 'peg', 'range', 'er', 'analyst'];
  function companyRoute(hash) { const m = String(hash || '').match(/mode=(shortlist|saved|all)/); return m ? m[1] : null; }
  function renderCompanies(main) {
    const short = S.brief.shortlist || [], shortSet = new Map(short.map(x => [x.t, x]));
    S.co = S.co || {mode: companyRoute(root.location.hash) || 'all', page: 0, sort: 'mcap', text: '', sector: '', cols: DEFAULT_COLS.slice()};
    const st = WL().status(), members = S.core.rows.filter(r => r.sp500_member !== false).length, legacy = S.core.rows.length - members;
    const sectors = [...new Set(S.core.rows.map(r => r.sec).filter(Boolean))].sort();
    main.innerHTML = `<section class="companies"><h1>Companies</h1>
      <div class="modes" role="tablist" aria-label="Which companies">${[['shortlist', `Shortlist (${short.length})`], ['saved', 'Saved'], ['all', `All (${S.core.rows.length})`]].map(([k, l]) => `<button type="button" role="tab" data-mode="${k}" aria-selected="${S.co.mode === k}">${l}</button>`).join('')}</div>
      <p class="wl-note note" role="status"${UI.wlNote ? '' : ' hidden'}>${esc(UI.wlNote || '')}</p>
      ${!st.ok ? `<p class="note" role="status">${esc(st.error)}${st.state === 'malformed' ? ' <button type="button" data-wl-replace>Replace unreadable saved list</button>' : ''}</p>` : ''}
      <div class="co-ctl"><label class="grow">Find <input id="find" type="search" placeholder="Ticker or company name" autocomplete="off" spellcheck="false" aria-label="Find a company"></label>
        <label>Sector <select id="co-sector"><option value="">All sectors</option>${sectors.map(s => `<option>${esc(s)}</option>`).join('')}</select></label>
        <label>Sort <select id="co-sort"><option value="mcap">Market value</option><option value="name">Name</option><option value="d1">Day change</option><option value="pe">P/E</option><option value="peg">PEG</option><option value="er">Next earnings</option><option value="up">Analyst upside</option></select></label></div>
      <details class="cols"><summary>Columns</summary><div class="ex-ctl">${Object.entries(COLS).map(([k, c]) => `<label><input type="checkbox" data-col="${k}"${S.co.cols.includes(k) ? ' checked' : ''}> ${esc(c[0])}</label>`).join('')}</div><p class="dim small">The Jul 25 score is the historical screener snapshot (2026-07-25), shown only when chosen; it is not current evidence.</p></details>
      <p id="co-count" class="dim" aria-live="polite"></p>
      <div class="tablewrap"><table class="list research-table"><colgroup id="co-widths"></colgroup><thead id="co-head"></thead><tbody id="rows"></tbody></table></div>
      <div class="pager"><button type="button" data-page="-1">Previous</button><button type="button" data-page="1">Next</button></div>
      <p class="dim small">${members} S&amp;P 500 members and ${legacy} retained former or non-index names (labelled). Prices follow the live quote engine for names on screen; other fields keep their dates.</p></section>`;
    $('#find').value = S.co.text; $('#co-sort').value = S.co.sort; $('#co-sector').value = S.co.sector;
    const draw = () => {
      const s = S.co.text.trim().toUpperCase(), saved = new Set(WL().get());
      const currentRows=new Map(),current=r=>{if(!currentRows.has(r.t))currentRows.set(r.t,Live.currentRow(r));return currentRows.get(r.t);};
      let hits = S.co.mode === 'shortlist' ? short.map(x => row(x.t)).filter(Boolean) : S.co.mode === 'saved' ? [...saved].map(row).filter(Boolean) : S.core.rows.slice();
      if (s) hits = hits.filter(r => r.t.startsWith(s.replace('.', '-')) || String(r.n).toUpperCase().includes(s));
      if (S.co.sector) hits = hits.filter(r => r.sec === S.co.sector);
      const key = {mcap: r => -(r.mcap || 0), name: r => r.n, d1: r => -((current(r) || r).d1 ?? -1e9), pe: r => COLS.pe[2](r,current) ?? 1e9, peg: r => r.peg ?? 1e9, er: r => r.er || '9999', up: r => -(r.up ?? -1e9)}[S.co.sort];
      if (S.co.mode !== 'shortlist' || S.co.sort !== 'mcap') {const keys=new Map(hits.map(r=>[r.t,key(r)]));hits.sort((a, b) => { const x=keys.get(a.t),y=keys.get(b.t);return typeof x === 'string' ? x.localeCompare(y) : x-y; });}
      const per = 50, pages = Math.max(1, Math.ceil(hits.length / per)); S.co.page = Math.min(Math.max(0, S.co.page), pages - 1);
      const view = hits.slice(S.co.page * per, S.co.page * per + per);
      Live.watch('company', view.slice(0, 24).map(r => r.t));
      const widths={pe:64,peg:64,range:108,er:124,analyst:164,pef:96,m1:80,mcap:100,legacy:112};
      const columns=[200,88,76,...(S.co.mode==='shortlist'?[280]:[]),...S.co.cols.map(k=>widths[k]),88];
      $('#co-widths').innerHTML=columns.map(w=>`<col style="width:${w}px">`).join('');
      main.querySelector('.research-table').style.width=columns.reduce((s,w)=>s+w,0)+'px';
      $('#co-count').textContent = hits.length ? `Showing ${S.co.page * per + 1}–${S.co.page * per + view.length} of ${hits.length}` + (S.co.mode === 'all' && !s && !S.co.sector ? ' retained companies' : '') : '';
      $('#co-head').innerHTML = `<tr><th>Company</th><th class="n">Price</th><th class="n">Day</th>${S.co.mode === 'shortlist' ? '<th>Why look · objection</th>' : ''}${S.co.cols.map(k => `<th class="n">${esc(COLS[k][0])}</th>`).join('')}<th><span class="sr">Save</span></th></tr>`;
      $('#rows').innerHTML = view.map(r => { const sx = shortSet.get(r.t);
        return `<tr><td><a href="#/company/${esc(r.t)}"><b>${esc(r.t)}</b> ${esc(r.n)}</a><div class="dim small">${esc(r.sec)}${r.sp500_member === false ? ' · not in current S&amp;P list' : ''}</div></td>
        <td class="n">${liveSpan(r.t, 'price')}</td><td class="n chg">${liveSpan(r.t, 'chg')}</td>${S.co.mode === 'shortlist' ? `<td class="small">${esc(sx && sx.why[0] ? sx.why[0].text : '')}<div class="dim">${esc(sx ? shortSetup(sx).concern.text : '')}</div></td>` : ''}
        ${S.co.cols.map(k => `<td class="n" data-column="${k}">${COLS[k][1](r,current)}</td>`).join('')}<td>${starBtn(r.t)}</td></tr>`; }).join('')
        || `<tr><td class="dim" colspan="9">${S.co.mode === 'saved' ? (st.ok ? 'No saved companies yet. Use ☆ Save on any company.' : 'Saved companies could not be read; see the note above.') : 'No match.'}</td></tr>`;
      main.querySelector('[data-page="-1"]').disabled = S.co.page === 0; main.querySelector('[data-page="1"]').disabled = S.co.page >= pages - 1;
      Live.paint(doc, null);
    };
    S.coDraw = draw;
    $('#find').addEventListener('input', e => { S.co.text = e.target.value; S.co.page = 0; draw(); });
    main.addEventListener('change', e => {
      if (e.target.id === 'co-sort') { S.co.sort = e.target.value; draw(); }
      if (e.target.id === 'co-sector') { S.co.sector = e.target.value; S.co.page = 0; draw(); }
      if (e.target.dataset.col) { const k = e.target.dataset.col; S.co.cols = e.target.checked ? Object.keys(COLS).filter(c => c === k || S.co.cols.includes(c)) : S.co.cols.filter(c => c !== k); draw(); }
    });
    main.addEventListener('click', e => {
      const m = e.target.closest('[data-mode]'); if (m) { S.co.mode = m.dataset.mode; S.co.page = 0; main.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-selected', String(b === m))); root.history.replaceState(root.history.state, '', '#/companies?mode=' + S.co.mode); draw(); return; }
      const p = e.target.closest('[data-page]'); if (p) { S.co.page += +p.dataset.page; draw(); return; }
      if (e.target.closest('[data-wl-replace]')) { WL().replaceUnreadable(); renderCompanies(main); }
    });
    draw();
  }

  /* ------------------------------------------------------------ Company dossier */
  const TABS = [['overview', 'Overview'], ['fundamentals', 'Fundamentals'], ['drivers', 'Chart & drivers'], ['events', 'Events'], ['options', 'Options']];
  const loaded = {};
  function loadAsset(src) {
    if (loaded[src]) return loaded[src];
    return (loaded[src] = new Promise((resolve, reject) => {
      const css = /\.css$/.test(src), el = doc.createElement(css ? 'link' : 'script');
      if (css) { el.rel = 'stylesheet'; el.href = src + '?v=' + ASSET_V; } else el.src = src + '?v=' + ASSET_V;
      el.onload = resolve; el.onerror = () => { delete loaded[src]; reject(new Error(src + ' did not load')); };
      doc.head.appendChild(el);
    }));
  }
  async function mountChart(t) {
    const el = $('#fv'); if (!el) return;
    try {
      await Promise.all(['fvchart.css', 'technicals.js', 'patterns.js'].map(loadAsset)); await loadAsset('fvchart.js');
      if (route(root.location.hash).t !== t || !$('#fv')) return;
      const pxd = await pxJson(t).catch(() => null);
      S.fv = await root.SmartOptionsChart.mount(el, t, Object.assign({core: S.core, quotes: Live.snapshot()}, pxd ? {px: pxd} : {}));
      if (S.fv && S.fv.updateQuotes) S.fv.updateQuotes(Live.snapshot());   // same accepted quote as the page header
      if (route(root.location.hash).t !== t) { try { S.fv.destroy(); } catch (e) {} S.fv = null; }
    } catch (e) { el.innerHTML = `<p class="note" role="alert">Chart unavailable: ${esc(e.message)}. The price and evidence above are unaffected.</p>`; console.warn('[brief] chart', e); }
  }
  function opinion(s){return String(s||'Unavailable').replace(/_/g,' ').replace(/^./,c=>c.toUpperCase());}
  function keyMetrics(t, r) {
    return () => {
      const cur = Live.currentRow(r) || {}, rp = rangePos(cur, r), rows = [];
      rows.push(['P/E (trailing)', isNum(cur.pe) ? cur.pe.toFixed(1) : 'n/a', 'at the current accepted price']);
      rows.push(['P/E (forward)', isNum(cur.pef) ? cur.pef.toFixed(1) : 'n/a', 'analyst estimates']);
      rows.push(['PEG', isNum(r.peg) ? r.peg.toFixed(2) : 'n/a', r.pegm || 'provider ratio']);
      rows.push(['52-week range', rp ? `${px(rp.lo)} – ${px(rp.hi)} (${Math.round(rp.pos)}%)` : 'n/a', 'retained daily range and current price']);
      rows.push(['Next earnings', r.er ? `${shortDate(r.er)} ${r.ert ? '(' + r.ert + ')' : '(time not confirmed)'}` : 'not supplied', (r.ers || 'provider') + (r.rat ? ', retrieved ' + r.rat.slice(0, 10) : '')]);
      rows.push(['Analyst consensus', r.rating ? `${opinion(r.rating)}${isNum(r.tgt) ? ', target ' + px(r.tgt) : ''}${isNum(r.nan) ? ', ' + r.nan + ' analysts' : ''}` : 'not supplied', 'provider opinion; not estimate revisions']);
      rows.push(['Market value', isNum(cur.mcap) ? '$' + big(cur.mcap) : 'n/a', 'price × shares']);
      return `<table class="kv">${rows.map(([a, b2, c]) => `<tr><td>${esc(a)}</td><td class="n">${esc(b2)}</td><td class="dim small">${esc(c)}</td></tr>`).join('')}</table>`;
    };
  }
  function fundamentalsHtml(t, c) {
    const cards = (c && c.cards) || {};
    return CARD_ORDER.map(k => { const x = cards[k];
      if (!x) return `<details class="card frow" data-card="${k}"><summary><b>${esc(CARD_Q[k])}</b> <span class="st" data-status="unavailable">unavailable</span></summary><p class="dim">Not supplied in this build.</p></details>`;
      if(k==='counter'){
        const s=researchSetup((S.brief.shortlist||[]).find(x=>x.t===t),row(t),{company:c,session:S.brief.asof_session,events:horizonEvents(S.horizon||7)});
        return `<details class="card frow" data-card="counter"><summary><b>${esc(CARD_Q.counter)}</b> <span class="qty">${esc(s.concern.text)}</span></summary>${setupEvidence(s)}<p><b>Fundamental assessment only:</b> ${esc(x.line)}</p>${metricTable(x.metrics,true)}<p>${evBtn({kind:'card',t,id:'counter'},'Open evidence')}</p></details>`;
      }
      const m = (x.metrics || []).find(y => y.value != null) || (x.metrics || [])[0];
      return `<details class="card frow" data-card="${k}"><summary><b>${esc(CARD_Q[k])}</b> <span class="st" data-status="${esc(x.status)}">${esc(x.status)}</span> <span class="qty">${k === 'valuation' ? slot('val-sum', valShort(t, x)) : esc(x.line)}</span>${m && m.period ? ` <span class="dim small">${esc(m.period)}</span>` : ''}</summary>
        ${k === 'valuation' ? `<p>${slot('val', valSlot(t, x))}</p><p class="dim small">Broad sector median, not a curated peer group; own valuation history is not available.</p>` : ''}${metricTable(x.metrics, true)}<p>${evBtn({kind: 'card', t, id: k}, 'Open evidence')}</p></details>`; }).join('');
  }
  function driversHtml(t, r, c) {
    const s=researchSetup((S.brief.shortlist||[]).find(x=>x.t===t),r,{company:c,session:S.brief.asof_session,events:horizonEvents(S.horizon||7)});
    return `<p class="setup-summary">${esc(s.category)} · ${esc(s.concern.measured?s.concern.text:s.wait)} ${evBtn({kind:'research',t},'Setup evidence')}</p><h3 class="question">Has ${esc(t)} outperformed the market and its sector?</h3><p id="drv-answer">${slot('drv', () => S.drv || 'Measuring against SPY and the sector basket…')}</p>
      <p><a class="go" href="${esc(companyHref(t, r.sec))}">Compare ${esc(t)} with SPY and the ${esc(r.sec)} basket</a></p>
      <h3 class="question">Is it sensitive to rates, oil, the dollar or volatility?</h3><p>${esc(relSentence(r, c && c.cards && c.cards.resilience))}</p><p class="dim">Historical association over ${r.rel && r.rel.n || 'n/a'} sessions, not a forecast. ${factorLink(r)}</p>
      <h3>Price and trend</h3><p>${slot('tech', techSlot(t, c && c.technical))}</p>`;
  }
  async function relativeAnswer(t, r) {
    try {
      const [a, s] = await Promise.all([pxJson(t), pxJson('SPY')]);
      const n = 63, ca = (a.bars || []).filter(x => isNum(x[4])), cs = new Map((s.bars || []).filter(x => isNum(x[4])).map(x => [x[0], x[4]]));
      const common = ca.filter(x => cs.has(x[0])); if (common.length <= n) throw new Error('fewer than 64 shared sessions');
      const z = common[common.length - 1], o = common[common.length - 1 - n], ry = 100 * (z[4] / o[4] - 1), rs = 100 * (cs.get(z[0]) / cs.get(o[0]) - 1);
      const bk = S.rel && S.rel.baskets && S.rel.baskets[r.sec], bh = bk && new Map(bk.h);
      const rb = bh && bh.has(z[0]) && bh.has(o[0]) ? 100 * (bh.get(z[0]) / bh.get(o[0]) - 1) : null;
      S.drv = `From ${o[0]} to ${z[0]} (${n} sessions, completed closes): ${t} ${pct(ry, 1)}, SPY ${pct(rs, 1)}` + (isNum(rb) ? `, ${r.sec} equal-weight basket ${pct(rb, 1)}` : '') + `. ${t} is ${Math.abs(ry - rs).toFixed(1)} pp ${ry >= rs ? 'ahead of' : 'behind'} the market` + (isNum(rb) ? ` and ${Math.abs(ry - rb).toFixed(1)} pp ${ry >= rb ? 'ahead of' : 'behind'} its sector basket.` : '; the sector basket is unavailable on matching dates.') + ' Past relative performance does not predict the next period.';
    } catch (e) { S.drv = `Relative performance unavailable: ${e.message}.`; }
    paintSlots();
  }
  function eventsHtml(t, c) {
    const h = horizonEvents(S.horizon, t), mine = h.items.filter(x => x.t === t || x.kind === 'macro'); S.lastEvents = S.lastEvents || {}; S.lastEvents.company = mine;
    const ev = (c && c.events) || {};
    return `<div class="horizon" role="group" aria-label="Event horizon">${[7, 30].map(d => `<button type="button" data-horizon="${d}" aria-pressed="${S.horizon === d}">${d} days</button>`).join('')}</div>
      <p>${esc(ev.line || 'No dated company events in the published data.')}</p>
      <ul class="events">${mine.map((x, i) => eventLine(x, i, 'company')).join('') || '<li class="dim">No listed release or company report in this window.</li>'}</ul><p class="dim small">${h.notes.map(esc).join(' ')}</p>`;
  }
  function optionsHtml(t, r, c) {
    const er = r.er, days = er ? Math.round((Date.parse(er + 'T12:00:00Z') - Date.now()) / 864e5) : null, o = (c && c.options) || {};
    return `<p class="lead">Unpriced — check current contracts.</p><p class="dim">No option chain is supplied here, so no strike, premium or probability is shown.</p>
      <ul><li><b>Thesis and horizon:</b> decide what must happen, by when, using the case above; an expiry should outlast the thesis check.</li>
      <li><b>Event overlap:</b> ${er ? `earnings ${esc(shortDate(er))}${days != null && days >= 0 ? ` (in about ${days} days)` : ''}; an expiry after that date carries the report's gap risk; contract pricing must be checked.` : 'no provider earnings date; confirm the company calendar before choosing an expiry.'}</li>
      <li><b>Structure:</b> check the payoff and maximum loss of the actual position. A covered call retains substantial downside in the shares; premium does not remove that risk. <a href="https://www.optionseducation.org/strategies/all-strategies/covered-call-buy-write" target="_blank" rel="noopener">Covered-call risk</a></li>
      <li><b>Liquidity and assignment:</b> wide bid/ask spreads, low open interest and early assignment on short calls near dividends can change the outcome.</li>
      <li><b>No-trade alternative:</b> holding no position, or the shares alone, is a valid choice when the case or the timing is unclear.</li></ul>
      ${o.line ? `<p class="dim">${esc(o.line)}</p>` : ''}<p><a href="#/workspace/strategies?t=${encodeURIComponent(t)}">Open ${esc(t)} in the strategy builder →</a> <span class="dim small">(modelled payoffs, clearly labelled; not live prices)</span> · <a href="#/workspace/technicals?t=${encodeURIComponent(t)}">Technicals and patterns</a> · <a href="#/workspace/risk?t=${encodeURIComponent(t)}">Shock scenarios</a></p>`;
  }
  function selectTab(tab, focus) {
    const box = $('.co-tabs'); if (!box) return;
    S.coTab = tab;
    box.querySelectorAll('[role=tab]').forEach(b => { const on = b.dataset.tab === tab; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; if (on && focus) b.focus(); });
    doc.querySelectorAll('.co-panel').forEach(p => { p.hidden = p.dataset.panel !== tab; });
    if (tab === 'overview') root.dispatchEvent(new Event('resize'));
  }
  async function renderCompany(t, main) {
    Live.watch('company', [t]); Live.watch('research', []); Live.watch('index', ['SPY']);
    const r = row(t);
    if (!r) { main.innerHTML = `<p>${esc(t)} is not in the published data. <a href="#/companies">Find a company</a></p>`; return; }
    let c = S.company[t] || null;
    if (!c) { try { c = await json(`data/brief/company/${encodeURIComponent(t)}.json`); S.company[t] = c; } catch (e) { c = null; console.warn('[brief] company evidence unavailable', t, e.message); } }
    if (route(root.location.hash).t !== t) return;   // reader moved on
    const short = (S.brief.shortlist || []).find(x => x.t === t), cs = caseFor(c, short, r,{session:S.brief.asof_session,events:horizonEvents(S.horizon||7)});
    S.coTab = S.coTab || route(root.location.hash).tab || 'overview';
    main.innerHTML = `
      <section class="co" data-t="${esc(t)}"><div class="co-head"><h1>${esc(r.n)} <span class="co-t">${esc(t)}</span></h1>${starBtn(t)}<a class="position-link" href="#/positions" data-position-t="${esc(t)}">Add/edit position</a></div>
        <p class="dim"><a href="#/sector/${encodeURIComponent(r.sec)}">${esc(r.sec)}</a>${r.ind ? ' · ' + esc(r.ind) : ''}${r.sp500_member === false ? ' · not in the current S&amp;P 500 list' : ''}</p>
        <div class="quote"><span class="big">${liveSpan(t, 'price')}</span> <span class="chg">${liveSpan(t, 'chg')}</span> ${slot('session', () => sessionNote(t))}</div>
        <p class="dim small">${slot('ctx', () => esc(Live.currentContext(t, Live.snapshot())))}</p>
        ${c ? '' : '<p class="note" role="status">Company evidence is unavailable in the published data; price and chart remain.</p>'}
        <div class="case"><p class="tag research-tags">${researchBadges(cs.setup)}<span class="dim small">completed ${esc(cs.setup.session||'session unavailable')}</span></p><p><span class="lbl">Case</span> ${esc(cs.positive ? cs.positive.text : 'No strong measured dimension in this build.')}</p>
          <p><span class="lbl obj">Objection</span> ${esc(cs.objection.text)} ${evBtn({kind:'research',t},'Concern evidence')}</p><p class="small">${esc(cs.setup.wait)}</p>
          ${cs.coverage.length ? `<p class="dim small"><span class="lbl">Coverage</span> ${esc(listJoin(cs.coverage))} unavailable; incomplete coverage is not an all-clear.</p>` : ''}
          <p class="dim small"><span class="lbl">Next event</span> ${esc(cs.event)}</p></div></section>
      <section id="your-note" class="your-note"></section>
      <div class="co-tabs" role="tablist" aria-label="Company sections">${TABS.map(([k, l]) => `<button type="button" role="tab" id="tab-${k}" data-tab="${k}" aria-controls="panel-${k}" aria-selected="${S.coTab === k}" tabindex="${S.coTab === k ? 0 : -1}">${l}</button>`).join('')}</div>
      <section class="co-panel" role="tabpanel" id="panel-overview" data-panel="overview" aria-labelledby="tab-overview"><div class="ov-grid"><div class="ov-chart"><div id="fv" class="fv-host"></div></div>
        <div class="ov-side"><h3>Key figures</h3>${slot('kv', keyMetrics(t, r))}<p><a class="go" href="${esc(companyHref(t, r.sec))}">Compare ${esc(t)} with SPY and ${esc(r.sec)} →</a></p><p class="dim small">${slot('tech-sum', techShort(t, c && c.technical))}</p></div></div></section>
      <section class="co-panel" role="tabpanel" id="panel-fundamentals" data-panel="fundamentals" aria-labelledby="tab-fundamentals"><div class="cards">${fundamentalsHtml(t, c)}</div><p class="dim small">Quarterly and trailing-twelve-month periods are shown per row. Financial companies and REITs use suitable measures or state an exclusion.</p></section>
      <section class="co-panel" role="tabpanel" id="panel-drivers" data-panel="drivers" aria-labelledby="tab-drivers">${driversHtml(t, r, c)}</section>
      <section class="co-panel" role="tabpanel" id="panel-events" data-panel="events" aria-labelledby="tab-events"><div id="co-events">${eventsHtml(t, c)}</div></section>
      <section class="co-panel" role="tabpanel" id="panel-options" data-panel="options" aria-labelledby="tab-options">${optionsHtml(t, r, c)}</section>`;
    root.SmartOptionsInvestor.mountNote($('#your-note'),t);
    selectTab(S.coTab);
    const tl = main.querySelector('.co-tabs');
    tl.addEventListener('click', e => { const b = e.target.closest('[role=tab]'); if (b) selectTab(b.dataset.tab, true); });
    tl.addEventListener('keydown', e => { const i = TABS.findIndex(x => x[0] === S.coTab); let j = null; if (e.key === 'ArrowRight') j = (i + 1) % TABS.length; else if (e.key === 'ArrowLeft') j = (i + TABS.length - 1) % TABS.length; else if (e.key === 'Home') j = 0; else if (e.key === 'End') j = TABS.length - 1; if (j != null) { e.preventDefault(); selectTab(TABS[j][0], true); } });
    paintSlots(); Live.paint(doc, null);
    S.drv = null; relativeAnswer(t, r);
    S.onQuote = changed => { if (S.view === 'company' && S.fv && changed.has(t) && S.fv.updateQuotes) S.fv.updateQuotes(Live.snapshot()); };
    mountChart(t);
    backControl(main);
  }
  function sessionNote(t) {
    const x = q(t); if (!x) return '';
    const label = Live.etLabel(x.asof_utc || x.ts, Date.now());
    const sess = x.market_hours === 2 ? 'after-hours trade, ' : x.market_hours === 0 ? 'pre-market trade, ' : '';
    const delay = x.delay_minutes > 0 ? ', delayed about ' + x.delay_minutes + ' min' : '';
    return `<span class="dim">${esc(sess + label + delay)}</span>`;
  }
  /* ------------------------------------------------------------ Macro */
  const GROUPS = {policy: 'Policy rate', inflation: 'Inflation', labor: 'Labor', growth: 'Growth', curve: 'Treasury curve', credit_funding: 'Credit and funding', cross_asset: 'Dollar and commodities', volatility: 'Volatility'};
  function macroValue(x) { return esc(unitValue(x.v, x.unit)); }
  function renderMacro(main) {
    Live.watch('research', []); Live.watch('company', []); Live.watch('index', ['SPY']);
    const bd = S.brief.macro && S.brief.macro.backdrop || {}, risk = S.brief.macro && S.brief.macro.risk || {};
    const rels = Object.keys(FACTORS).map(f => factorSentence(S.core, f)).filter(Boolean);
    const cal = (S.core.calendar || []).filter(x => x.status !== 'released').sort((a, b) => String(a.scheduled_et).localeCompare(String(b.scheduled_et))).slice(0, 12);
    S.metricEvidence ||= new Map();for(const group of Object.values(S.core.macro||{}))for(const x of group){S.metricEvidence.set(x.label,{label:x.label,value:x.v,unit:x.unit,period:x.period,asof:x.retrieved_at,source:x.provider,source_url:x.url,note:x.note||'Observation date '+x.date+'; reference period is not the release timestamp.'});}
    const mc = (S.brief.daily_changes && S.brief.daily_changes.macro) || [], ev = S.brief.macro && S.brief.macro.risk_events;
    const h = horizonEvents(S.horizon); S.lastEvents = S.lastEvents || {}; S.lastEvents.macro = h.items.filter(x => x.kind === 'macro');
    const detail = Object.fromEntries(((S.brief.macro && S.brief.macro.detail) || []).map(d => [d.group, macroGroupLine(S.core, d.group, d.line)]));
    const cv = (x, unit) => unitValue(x?.value, x?.unit ?? unit);
    main.innerHTML = `<h1>Macro</h1>
      <div class="macro-top">
        <section><h2>Persistent trends</h2><ul>${['growth', 'inflation', 'policy'].filter(k => bd[k] && bd[k].line).map(k => `<li><b>${GROUPS[k] || k}:</b> ${esc(bd[k].line)}</li>`).join('')}</ul><p>${evBtn({kind: 'assessment', id: 'backdrop'}, 'Backdrop evidence')}</p></section>
        <section><h2>Observed stress</h2><p><b>${esc(normalizedSignals(S.brief).find(x=>x.id==='risk').word)}:</b> ${esc(risk.line || 'Risk inputs unavailable.')}</p><p class="dim small">Volatility and credit observations only. Scheduled releases do not count as stress.</p><p>${evBtn({kind: 'assessment', id: 'risk'}, 'Risk evidence')}</p></section>
        <section><h2>Scheduled events</h2><p class="dim small">${esc(ev ? ev.line : '')}</p><div class="horizon" role="group" aria-label="Event horizon">${[7, 30].map(d => `<button type="button" data-horizon="${d}" aria-pressed="${S.horizon === d}">${d} days</button>`).join('')}</div>
          <ul class="events">${S.lastEvents.macro.map((x, i) => eventLine(x, i, 'macro')).join('') || '<li class="dim">No listed release in this window; see coverage.</li>'}</ul><p class="dim small">${h.notes.slice(0, 1).concat(h.notes.slice(2)).map(esc).join(' ')}</p></section>
      </div>
      <section><h2>Latest observation versus the prior one</h2><p class="dim small">Each row compares two dated observations from the retained history (current data vintage, so earlier values may include revisions). A newer retrieval without a new observation is not a change.</p>
        <div class="tablewrap"><table class="mchg"><thead><tr><th>Series</th><th class="n">Latest</th><th class="n">Prior</th><th class="n">Change</th></tr></thead><tbody>${mc.map(x => x.status === 'ok' ? `<tr><td>${esc(x.label)}${x.obs_status && x.obs_status !== 'ok' ? ` <span class="tag">${esc(x.obs_status)}</span>` : ''}</td><td class="n">${esc(cv(x.current, x.unit))} <span class="dim small">${esc(x.current.date)}</span></td><td class="n">${esc(cv(x.prior, x.unit))} <span class="dim small">${esc(x.prior.date)}</span></td><td class="n ${x.direction === 'up' ? 'up' : x.direction === 'down' ? 'dn' : ''}">${x.change > 0 ? '+' : ''}${+x.change.toFixed(3)}</td></tr>` : `<tr><td>${esc(x.label)}</td><td colspan="3" class="dim">Unavailable: ${esc(x.reason)}</td></tr>`).join('') || '<tr><td colspan="4" class="dim">Dated comparisons are not in this data build.</td></tr>'}</tbody></table></div></section>
      <section><h2>How sectors have moved with macro</h2>${rels.map(r => `<p>${esc(r.text)} <a class="go" href="${esc(factorHref(r))}">Chart it</a></p>`).join('')}
        ${S.rel ? `<div class="insights">${insightCard(macroInsight(S.rel, S.core))}</div>` : ''}
        <details class="src"><summary>Sector medians by factor</summary>${rels.map(r => { const s = sectorSensitivity(S.core.rows, r.factor); return `<h4>${esc(FACTORS[r.factor].name)} (per ${FACTORS[r.factor].per})</h4><table>${s.map(x => `<tr><td>${esc(x.sector)}</td><td class="n">${pct(x.coef * FACTORS[r.factor].scale, 2)}</td><td class="dim">${x.n} names</td></tr>`).join('')}</table>`; }).join('')}
        <p class="dim">${esc(S.core.rel && S.core.rel.window)}; per-stock OLS of daily returns on SPY, 10-year yield, DXY, WTI and VIX changes; sector value is the median coefficient. Associations, not causes or forecasts.</p></details></section>
      <section class="macro-groups"><h2>Observations by group</h2>${Object.keys(GROUPS).filter(g => (S.core.macro[g] || []).length).map(g => `<details class="src"${g === 'policy' || g === 'inflation' ? ' open' : ''}><summary><b>${GROUPS[g]}</b>${detail[g] ? ' · ' + esc(detail[g]) : ''}</summary><div class="tablewrap"><table>
        ${S.core.macro[g].filter(x => !/_ret_1d|_ret_5d|_mom$/.test(x.id)).map(x => `<tr><td>${learnLink(x.label)}${x.status && x.status !== 'ok' ? ` <span class="tag">${esc(x.status)}</span>` : ''}</td><td class="n">${macroValue(x)}</td><td class="dim">prior ${isNum(x.prior) ? +x.prior.toFixed(2) : 'n/a'}</td><td class="dim">${esc(x.period)}</td><td class="dim">${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.provider)}</a>` : esc(x.provider)} · <a href="${W.encodeHash({s:[{id:'eq:SPY'},{id:'mac:'+x.id}],m:'z',r:'1y'})}">Compare history</a></td></tr>`).join('')}</table></div></details>`).join('')}</section>`;
  }

  /* ------------------------------------------------------------ Insight cards (brief, macro, company) */
  function insightCard(x) {
    if (!x) return '';
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
  const DEFAULT_STATE = {s: [{id: 'eq:SPY'}, {id: 'eq:RSP'}, {id: 'sec:Information Technology'}], r: '1y', m: 'pct', ind: {sma: false, rc: false}, lag: 0};
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
  function importedSeries() { try { const d = root.SmartOptionsLocalData?.sharedStore(root.localStorage).get(); return Array.isArray(d?.series) ? d.series.slice(0, 4) : []; } catch (e) { return []; } }
  function identitySeries() {
    const I = root.SmartOptionsInstruments, base = new Set(seriesIndex().map(x => x.id));
    const own = importedSeries().map((x, i) => ({id: 'mac:imp_' + i, label: 'Yours: ' + String(x.label).slice(0, 40), sub: `your imported series, ${x.points.length} dated points, stays on this device · not verified`, unit: '', group: 'Your imported series', freq: 'as imported', name: x.label}));
    return own.concat((I ? I.all() : []).filter(a => !base.has('eq:' + a.symbol)).map(a => ({id: 'eq:' + a.symbol, label: a.symbol, sub: `${a.name} · ${a.type === 'ETF' ? 'ETF' : 'stock'}, USD, daily close · Yahoo (validated identity)`, kind: 'price', chg: 'ret', unit: 'USD', cunit: '%', group: a.type === 'ETF' ? 'ETFs' : 'Companies', name: a.name, freq: 'daily'})));
  }
  const metaOf = id => seriesIndex().find(x => x.id === id) || identitySeries().find(x => x.id === id) || null;
  async function loadSeries(id) {
    S.exData ||= {};
    if (S.exData[id]) return S.exData[id];
    const m = metaOf(id); if (!m) throw new Error('not in the published data');
    let h = null;
    if (id.startsWith('eq:')) { const d = await historyFor(id.slice(3)); h = (d.bars || []).filter(b => isNum(b[4]) && b[4] > 0).map(b => [b[0], b[4]]); }
    else if (/^mac:imp_\d$/.test(id)) { const x = importedSeries()[+id.slice(8)]; h = x ? x.points.filter(p => isNum(p[1])).map(p => [String(p[0]).slice(0, 10), p[1]]) : null; }
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
    if (!/[?&]m=/.test(hash || '') && !(S.exStore.current && state === S.exStore.current)) state = {...state, m: state.s.length === 1 && state.s[0].id.startsWith('eq:') ? 'raw' : 'pct'};
    S.ex = {state: W.cleanState(state), cursorDate: null};
    S.exStore.current = S.ex.state; writeStore(S.exStore);   // a followed link becomes the last workspace (skipped while unreadable data is kept)
    Live.watch('research', []); Live.watch('company', []); Live.watch('index', ['SPY']);
    main.innerHTML = `<section class="ex"><p class="eyebrow">Compare</p><h1 id="ex-q" class="question"></h1>
      <div class="ex-answer"><p id="ex-concl" aria-live="polite"></p><p id="ex-limit" class="dim"></p></div>
      <p class="dim small">Up to six companies, ETFs, sector baskets and macro series. Display transforms never change the statistics, which use aligned daily changes. Relationships are historical associations, not forecasts.</p>
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
      const q = s.replace(/^\$/, ''), sym = root.SmartOptionsInstruments?.symbol(q).toLowerCase() || q;
      const xs = seriesIndex().concat(identitySeries()).filter(x => !have.has(x.id) && (x.label.toLowerCase().includes(sym) || (x.name || '').toLowerCase().includes(q) || x.group.toLowerCase().startsWith(q))).sort((a, b) => (a.label.toLowerCase() === sym ? 0 : a.label.toLowerCase().startsWith(sym) ? 1 : 2) - (b.label.toLowerCase() === sym ? 0 : b.label.toLowerCase().startsWith(sym) ? 1 : 2)).slice(0, 12);
      hits.innerHTML = xs.map(x => `<li role="option" tabindex="-1" data-add="${esc(x.id)}"><b>${esc(x.label)}</b> <span class="dim">${esc(x.sub)}</span></li>`).join('') + `<li class="dim small" role="presentation" id="ex-disc">${S.exDisc || ''}</li>`;
      hits.hidden = false;
    };
    // Wider stock/ETF discovery through the shared public relay; debounced and cancellable. Validated identities join the list.
    let discTimer = null, discCtl = null, discVer = 0;
    const discover = () => { clearTimeout(discTimer); discCtl?.abort(); const q = find.value.trim(), v = ++discVer; S.exDisc = ''; if (q.length < 2) return;
      discTimer = setTimeout(async () => { const I = root.SmartOptionsInstruments; if (!I) return; discCtl = new AbortController(); S.exDisc = 'Checking the wider stock and ETF catalog…'; showHits();
        const d = await I.search(q, {signal: discCtl.signal}).catch(e => e.name === 'AbortError' ? null : {status: 'error', error: e.message}); if (!d || v !== discVer || !find.isConnected) return;
        S.exDisc = d.status === 'error' ? 'Wider catalog unavailable (' + esc(d.error) + '); published series remain.' : 'US-listed stocks and ETFs · Yahoo'; showHits(); }, 300); };
    find.addEventListener('input', showHits); find.addEventListener('input', discover);
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
    exAnswer(md);
  }
  // Question first, then a plain conclusion and its limitation; the same statistics as the panels below.
  function exAnswer(md) {
    const ids = S.ex.state.s.map(x => x.id), labels = Object.fromEntries(ids.map(id => [id, (metaOf(id) || {}).label || id]));
    const qq = compareQuestion(ids, labels), qel = $('#ex-q'); if (!qel) return;
    qel.textContent = qq.q;
    const ser = md.series, a = ser[0], priceLike = s => s && (s.kind === 'price' || s.kind === 'basket'), bm = ser.slice(1).find(priceLike);
    let concl = '', limit = '';
    if (priceLike(a) && bm) { const r = W.relPerf(a, bm, md.b); if (r) concl = `${a.label} ${r.ry >= 0 ? 'rose' : 'fell'} ${Math.abs(r.ry).toFixed(1)}% and ${bm.label} ${r.rb >= 0 ? 'rose' : 'fell'} ${Math.abs(r.rb).toFixed(1)}% from ${r.from} to ${r.to}: ${a.label} is ${Math.abs(r.gap).toFixed(1)} pp ${r.gap >= 0 ? 'ahead' : 'behind'}.`; }
    if (ser.length >= 2) {
      const st = W.pairStats(ser[0], ser[1], md.b, {lag: S.ex.state.lag});
      if (st.ok) { concl += (concl ? ' ' : '') + `Daily changes in ${ser[0].label} and ${ser[1].label} showed ${corrWord(st.r)} co-movement (correlation ${st.r.toFixed(2)}, ${st.n} days).`;
        limit = (st.halves_same_sign ? `First and second halves kept the same sign (${isNum(st.first_half) ? st.first_half.toFixed(2) : 'n/a'}, ${isNum(st.second_half) ? st.second_half.toFixed(2) : 'n/a'}).` : 'The sign changed between the first and second half, so treat the relationship as unstable.') + ' A historical association, not a cause or a forecast.'; }
      else limit = `Relationship withheld: ${st.reason}`;
    } else limit = 'Add a second series to compare.';
    if (md.reject) limit = md.reject + ' ' + limit;
    $('#ex-concl').textContent = concl || 'No price comparison for this selection; see the measured relationship below.';
    $('#ex-limit').textContent = limit;
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
    if(m?.available&&!S.jointOpen&&!root.__soPersonalWhatif){el.innerHTML=`<p class="joint-entry"><button type="button" class="btn" data-joint-open>Test a scenario</button> <span class="dim small">Off until chosen: applies the dated joint fit for ${esc(metaOf(id)?.label||id)} to rate and oil moves you enter. Observed prices are never changed.</span></p>`;el.querySelector('[data-joint-open]').onclick=()=>{S.jointOpen=true;renderJoint();$('#joint-rate')?.focus();};return;}
    if(!m?.available){el.innerHTML=`<details class="joint"><summary>Economic what-if</summary><p>${esc(m?.reason||'No joint model for this asset in the fixed 64-candidate research budget. Choose SPY, AAPL, MSFT, NVDA, AMZN, JPM, XOM or a supported sector basket.')} Historical overlays remain available through chart controls.</p></details>`;if(root.__soPersonalWhatif){root.__soPersonalWhatif=false;el.querySelector('details').open=true;el.tabIndex=-1;el.scrollIntoView({block:'start'});el.focus({preventScroll:true});}return;}
    el.innerHTML=`<section class="joint"><h3>Two economic moves, together ${learnLink('Scenario','What does this mean?')}</h3><p class="dim">Hypothetical one-day changes associated with ${esc(metaOf(id)?.label||id)}; ${m.n} common days, ${esc(m.fit_start)}–${esc(m.fit_end)}. Joint fit, holding the other driver fixed. It describes history, not a forecast.</p><div class="joint-inputs"><label>10-year Treasury move ${learnLink('Basis points','bp')}<input id="joint-rate" type="number" step="any" inputmode="decimal" value="${S.jointValues[0]}" data-joint="0"></label><label>WTI oil move (%)<input id="joint-oil" type="number" step="any" inputmode="decimal" value="${S.jointValues[1]}" data-joint="1"></label></div><div class="ex-ctl"><label><input type="checkbox" id="joint-on"${S.jointEnabled?' checked':''}> Show hypothetical marker & mean band</label><button type="button" data-joint-overlays>Add rate & oil history</button><button type="button" data-joint-reset>Clear what-if</button></div><p id="joint-out" role="status"></p><details><summary>Method, bounds & counterargument</summary><p>Asset daily percent change = ${f3(m.coefficients[0])} + ${f3(m.coefficients[1])} × rate move (bp) + ${f3(m.coefficients[2])} × oil move (%). Each driver is bounded to its central 90% sample: rate ${m.bounds[0].map(f3).join(' to ')} bp; oil ${m.bounds[1].map(f3).join(' to ')}%. Joint leverage must be ≤9/n. Condition number ${f3(m.condition)}; residual daily standard deviation ${f3(Math.sqrt(m.residual_variance))}%. ${esc(m.method)}.</p><p>Counterargument: these two variables leave other market and company events unexplained; revised macro histories, different close times and changing relationships can break the association. The chart uses the last observed chart price as an anchor, not a target date or fabricated price bar.</p><p>${learnLink('Confidence interval','Average uncertainty vs individual-day variation')} · ${learnLink('Beta','Joint slopes')} · Catalog built ${esc(S.rel.generated_at)}; total fixed search ≤${S.rel.candidate_search.max} candidates.</p></details></section>`;
    el.querySelectorAll('[data-joint]').forEach(inp=>inp.oninput=()=>{S.jointValues[+inp.dataset.joint]=inp.value===''?null:Number(inp.value);updateJoint();});
    $('#joint-on').onchange=e=>{S.jointEnabled=e.target.checked;updateJoint();};
    el.querySelector('[data-joint-reset]').onclick=()=>{S.jointEnabled=false;S.jointValues=[0,0];S.jointOpen=false;updateJoint();renderJoint();$('[data-joint-open]')?.focus();};
    el.querySelector('[data-joint-overlays]').onclick=()=>exSet(s=>{for(const id of m.drivers)if(!s.s.some(x=>x.id===id)&&s.s.length<W.MAX_SERIES)s.s.push({id});s.m='z';});
    updateJoint();
    if(root.__soPersonalWhatif){root.__soPersonalWhatif=false;el.scrollIntoView({block:'start'});$('#joint-rate')?.focus({preventScroll:true});}
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
  function onQuotes(ev) { (ev && ev.changed || []).forEach(t => changedSince.add(t)); if (pending) return; pending = setTimeout(() => {
    pending = null;const ch=changedSince;changedSince=new Set();
    // A new market-relative sentence can wrap above the reader's research panel.
    // Retain that panel's viewport position while still displaying the new evidence.
    // Today: the current-price strip sits above the reader, so anchor whatever is at the top of the viewport.
    const topAnchor=()=>{const y=(parseFloat(root.getComputedStyle(doc.documentElement).getPropertyValue('--hdr-h'))||60)+8;return doc.elementFromPoint?.(root.innerWidth/2,y)?.closest('article,li,section>p,section>h2,section')||null;};
    const panel=root.scrollY>0?(S.view==='company'?doc.querySelector('.co-panel:not([hidden])'):S.view==='brief'?topAnchor():null):null;
    const before=panel?.getBoundingClientRect().top,anchored=before!=null&&before<root.innerHeight;
    paintSlots();if(S.onQuote)S.onQuote(ch);
    if(anchored&&panel.isConnected){const delta=panel.getBoundingClientRect().top-before;if(Math.abs(delta)>.5)root.scrollBy(0,delta);}
  },120); }
  // Foreground data generations: an open tab adopts a newer completed-session core+brief pair without a reload.
  // Only a coherent pair (same asof_session, export clocks within 30 minutes, strictly newer than shown) is adopted;
  // older, mixed, failed or superseded reads leave the shown pair in place. The quote engine keeps its quotes and
  // budgets (rows only), and private state, chat drafts and saved rooms are untouched.
  const GEN_POLL=10*60e3;   // coherentPair allows export clocks up to 30 minutes apart
  function genClock(core,brief){return Math.max(Date.parse(core?.exported_at)||0,Date.parse(brief?.generated_at)||0);}
  // Same inputs, proven by provenance the export already carries: core.gen.<component> must equal the brief's
  // health.sources[<component>].asof (timezone-normalised; both null allowed). A newer pair must not carry any older
  // component than the shown pair, and at least one component must be strictly newer. Future clocks are invalid.

  function receipts(core,brief,now) {
    const src=Object.fromEntries((brief?.health?.sources||[]).filter(x=>x&&x.id).map(x=>[x.id,x.asof])),out={};
    for(const k of ['macro','equities','relations','crosscheck']){const a=core?.gen?.[k],b=src[k];
      if(a==null&&b==null){out[k]=null;continue;}
      const ta=Date.parse(a),tb=Date.parse(b);
      if(!isFinite(ta)||!isFinite(tb))return {error:'invalid: '+k+' receipt missing or unreadable'};
      // A device clock can run hours behind; only receipts a day ahead of it are treated as invalid future clocks.
      if(ta>now+864e5||tb>now+864e5)return {error:'invalid: '+k+' receipt in the future'};
      if(ta!==tb)return {error:'mixed generations: '+k+' inputs differ'};
      out[k]=ta;}
    if(out.macro==null||out.equities==null)return {error:'invalid: macro and equities receipts required'};
    return {clocks:out};
  }
  function coherentPair(core,brief,cur,now=Date.now()) {
    if(!core||!brief||!Array.isArray(core.rows)||!core.rows.length||!/^\d{4}-\d{2}-\d{2}$/.test(brief.asof_session||''))return 'invalid';
    if(core.asof_session!==brief.asof_session)return 'mixed sessions';
    const r=receipts(core,brief,now);if(r.error)return r.error;
    if(cur){const c=receipts(cur.core,cur.brief,now).clocks||{};
      if(brief.asof_session<cur.brief.asof_session)return 'not newer';
      for(const k of ['macro','equities','relations','crosscheck'])if(c[k]!=null&&(r.clocks[k]==null||r.clocks[k]<c[k]))return 'not newer: older '+k;
      if(!['macro','equities','relations','crosscheck'].some(k=>r.clocks[k]!=null&&(c[k]==null||r.clocks[k]>c[k])))return 'not newer';}
    return 'ok';
  }
  async function revalidate(url){const r=await fetch(url,{cache:'no-cache'});if(!r.ok)throw new Error(url+' HTTP '+r.status);return r.json();}
  let genBusy=null,genSerial=0,genLast=Date.now();
  function refreshGeneration(force) {
    if(doc.hidden||genBusy||!S.brief||(!force&&Date.now()-genLast<GEN_POLL))return genBusy;
    genLast=Date.now();const serial=++genSerial;
    genBusy=(async()=>{try{
      const brief=await revalidate('data/brief.json');
      if(!(Date.parse(brief?.generated_at)>Date.parse(S.brief.generated_at))||brief.asof_session<S.brief.asof_session)return 'not newer';
      const core=await revalidate('data/core.json'),verdict=coherentPair(core,brief,{core:S.core,brief:S.brief});
      if(verdict!=='ok'){S.genNote=verdict;console.warn('[brief] newer data not adopted:',verdict);return verdict;}
      if(serial!==genSerial)return 'superseded';
      S.genPending={core,brief};
      if(S.view==='brief'&&!sheetOpen())adoptInPlace();else if(S.view==='room'){adoptPending();root.SmartOptionsMyDashboard?.refresh?.();}
      return 'adopted';
    }catch(e){S.genNote=e.message;console.warn('[brief] data refresh unavailable',e.message);return 'error';}finally{genBusy=null;}})();
    return genBusy;
  }
  function adoptPending() {
    const p=S.genPending;S.genPending=null;if(!p||coherentPair(p.core,p.brief,{core:S.core,brief:S.brief})!=='ok')return false;
    pxCache.clear();histMemo.clear();
    S.core=p.core;S.brief=p.brief;S.rowMap.clear();p.core.rows.forEach(r=>S.rowMap.set(r.t,r));S.company={};S.metricEvidence=new Map();S.nowKey=null;S.generation=(S.generation||0)+1;
    revalidate('data/relationships.json').then(x=>{if(x?.schema!=='brief.relationships.v1')throw new Error('unexpected schema');if(!(Date.parse(x.generated_at||x.asof||0)<Date.parse(S.rel?.generated_at||S.rel?.asof||0))){S.rel=x;S.relError=null;}}).catch(e=>{S.relError=e.message+(S.rel?' (last good relationships retained)':'');console.warn('[brief] relationships not refreshed',e.message);});
    Live.setRows(p.core.rows);root.dispatchEvent(new CustomEvent('so:generation',{detail:{asof_session:p.brief.asof_session,generated_at:p.brief.generated_at}}));
    return true;
  }
  function adoptInPlace() {
    const main=$('#view'),y=root.scrollY,open=[...main.querySelectorAll('details')].map(d=>d.open),af=doc.activeElement,key=n=>n&&(n.dataset?.ev||n.dataset?.jump||n.id||n.getAttribute?.('href')),fk=main.contains(af)?key(af):null;
    if(!adoptPending())return;
    S.personal?.suspend?.();S.news?.destroy?.();S.mod?.destroy?.();S.slots=[];S.onQuote=null;
    renderBrief(main);Live.paint(doc,null);paintFocus();
    const ds=[...main.querySelectorAll('details')];if(ds.length===open.length)ds.forEach((d,i)=>{if(open[i]&&!d.open)d.open=true;});
    if(fk)[...main.querySelectorAll('[data-ev],[data-jump],[id],a')].find(n=>key(n)===fk)?.focus({preventScroll:true});
    root.scrollTo(0,y);
  }
  async function boot() {
    try {
      let core,brief,verdict='invalid';
      for(let attempt=0;attempt<3&&verdict!=='ok';attempt++){
        if(attempt)await new Promise(r=>setTimeout(r,1500*attempt));
        [core,brief]=await Promise.all([attempt?revalidate('data/core.json'):json('data/core.json'),attempt?revalidate('data/brief.json'):json('data/brief.json')]);
        verdict=coherentPair(core,brief);if(verdict!=='ok')console.warn('[brief] published core/brief pair rejected:',verdict);}
      if(verdict!=='ok')throw new Error('the published market files are from different builds ('+verdict+'); reload in a minute');
      S.core = core; S.brief = brief; core.rows.forEach(r => S.rowMap.set(r.t, r));
      // Relationship catalog and sector baskets are optional: without them the drilldowns say so and the brief still draws.
      try { S.rel = await json('data/relationships.json'); if (!S.rel || S.rel.schema !== 'brief.relationships.v1') throw new Error('unexpected schema'); } catch (e) { S.rel = null; S.relError = e.message; console.warn('[brief] relationships unavailable', e.message); }
      Live.setRows(core.rows);
    } catch (e) {
      $('#view').innerHTML = `<p role="alert">The published market data could not be loaded (${esc(e.message)}). Reload in a minute; saved data on this device is untouched.</p>`; return;
    }
    Live.subscribe(onQuotes);
    doc.addEventListener('click',e=>{const b=e.target.closest('[data-map-period]');if(b){S.heatPeriod=b.dataset.mapPeriod;doc.querySelectorAll('[data-map-period]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));const heat=$('#heat');if(heat)heat.innerHTML=heatSlot();const rotation=$('#rotation-table');if(rotation)rotation.innerHTML=rotationDesk();const health=$('#map-health');if(health)health.innerHTML=mapHealthSlot();doc.querySelectorAll('[data-open-grid]').forEach(a=>a.href='#/markets?p='+encodeURIComponent(S.heatPeriod));}});
    doc.addEventListener('keydown',e=>{if(e.key==='Escape'&&sheetOpen()){e.preventDefault();closeSheet();return;}if(e.key==='Escape'&&(doc.documentElement.classList.contains('cp-open')||e.target.closest('#cp-panel,#gs-hits,#gsearch')))return;if(e.key==='Escape'&&S.view!=='brief'&&!e.target.closest('.ex-hits')){e.preventDefault();if(root.history.state?.soParent)root.history.back();else root.location.hash='#/';}});
    WL();
    root.SmartOptionsAPI = Object.assign(root.SmartOptionsAPI || {}, {brief_action: mainAction});
    doc.addEventListener('click', e => {
      const op=e.target.closest('[data-open]');if(op){const d=doc.getElementById(op.dataset.open);if(d){selectTodayPanel(d.closest('.today-blocks section')?.id);d.open=true;d.querySelector('summary')?.focus({preventScroll:true});d.scrollIntoView({block:'start'});}return;}
      if(e.target.closest('[data-sit-retry]')){S.sitCtl?.check();return;}
      const sc=e.target.closest('[data-scan]');if(sc){S.scanSort=sc.dataset.scan;const p=$('#ws-panel');if(p)p.innerHTML=scannerHtml();p?.querySelector(`[data-scan="${sc.dataset.scan}"]`)?.focus();return;}
      const jump=e.target.closest('[data-jump]');if(jump){selectTodayPanel(jump.dataset.jump);const section=doc.getElementById(jump.dataset.jump),heading=section?.querySelector('h1,h2,h3');if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});section.scrollIntoView({block:'start'});}return;}
      if(e.target.closest('[data-income-search]')){$('#gsearch').focus();root.scrollTo(0,0);return;}
      const pt=e.target.closest('[data-position-t]');if(pt)S.positionTicker=pt.dataset.positionT;
      const follow = e.target.closest('[data-follow-report],[data-follow-reference],[data-follow-trend]'); if (follow) { followEvidence(follow).catch(err => focusError(err)); return; }
      const ev = e.target.closest('[data-ev]'); if (ev) { e.preventDefault(); try { openSheet(JSON.parse(ev.dataset.ev), ev); } catch (err) { console.error('[brief] evidence id', err); } return; }
      const st = e.target.closest('[data-star]'); if (st) { toggleStar(st.dataset.star); if (S.coDraw && S.co && S.co.mode === 'saved') S.coDraw(); return; }
      const hz = e.target.closest('[data-horizon]');
      if (hz) { UI.horizon = S.horizon = +hz.dataset.horizon;
        if (S.view === 'brief' && $('#ahead')) {$('#ahead').innerHTML = aheadHtml();const desk=doc.querySelector('[data-desk-events]');if(desk)desk.innerHTML=deskEvents(S.deskEventFilter||'all');const dh=doc.querySelector('[data-desk-horizon]');if(dh)dh.textContent='Next '+S.horizon+' days';if($('#objectives'))$('#objectives').innerHTML=objectivesHtml();if($('#next-risk'))$('#next-risk').innerHTML=nextRisk();if($('.implications'))$('.implications').innerHTML=implicationsHtml(todayModel(S.brief,S.core));doc.querySelectorAll('[data-short-category]').forEach(el=>{const x=S.brief.shortlist.find(x=>x.t===el.dataset.shortCategory),s=shortSetup(x);el.textContent=s.category;const caution=doc.querySelector(`[data-short-caution="${x.t}"]`);if(caution)caution.innerHTML=`<span class="lbl">Against</span> ${esc(s.concern.measured?s.concern.text:s.signal)}`;});S.personal?.refresh();}
        else if (S.view === 'company' && $('#co-events')) { const t = route(root.location.hash).t; $('#co-events').innerHTML = eventsHtml(t, S.company[t]); }
        else if (S.view === 'macro') renderMacro($('#view'));
        const again = doc.querySelector(`[data-horizon="${S.horizon}"]`); if (again) again.focus({preventScroll: true}); }
    });
    root.addEventListener('so:investor',()=>{if(S.view==='brief')S.personal?.refresh();});
    root.addEventListener('storage',e=>{if(e.key==='so_watchlist_v1'&&S.view==='brief')S.personal?.refresh();});
    initSearch(); initTheme();
    root.addEventListener('hashchange', render);
    render();
    Live.start();
    startSituation();
    const wakeGen=()=>{if(!doc.hidden)refreshGeneration();};
    doc.addEventListener('visibilitychange',wakeGen);root.addEventListener('pageshow',wakeGen);root.addEventListener('focus',wakeGen);setInterval(wakeGen,60e3);
    S.refreshGeneration=refreshGeneration;
    // The lightweight chat launcher appears at idle; chat modules wait for deliberate intent.
    const later = root.requestIdleCallback ? fn => root.requestIdleCallback(fn, {timeout: 4000}) : fn => setTimeout(fn, 1500);
    later(loadChat);
  }
  // Header company search across the whole retained universe.
  function initSearch() {
    const inp = $('#gsearch'), hits = $('#gs-hits'); if (!inp || !hits) return;
    // One identity contract: published companies, retained/pinned funds, then validated provider discovery.
    const I = root.SmartOptionsInstruments;
    const hrefOf = x => row(x.symbol) ? '#/company/' + x.symbol : instrumentHref(x.symbol);
    const renderHits = (xs, note) => xs.map(x => `<li role="option"><a href="${esc(hrefOf(x))}" data-instrument="${esc(x.symbol)}"><b>${esc(x.symbol)}</b> ${esc(x.name)} <span class="dim">${x.type === 'ETF' ? 'ETF' : esc(row(x.symbol)?.sec || 'Stock')}${row(x.symbol)?.sp500_member === false ? ' · not in current S&amp;P list' : ''}</span></a></li>`).join('') + `<li class="dim small" role="presentation">${esc(note || '')}</li>`;
    const choose = a => { root.location.hash = a.getAttribute('href'); inp.value = ''; hits.hidden = true; S.closeSearch?.(false); inp.blur(); };
    S.searchCtl = I.bindSearch(inp, hits, {rows: () => S.core.rows, render: renderHits, onChoose: choose});
    doc.addEventListener('click', e => { if (!e.target.closest('.gsearch')) hits.hidden = true; });
    // Phone header: Search expands the same input/results row on request; desktop keeps it visible (CSS).
    const hdr = $('#hdr'), tog = $('#gs-toggle');
    const setOpen = (open, refocus) => { if (!hdr || !tog) return; hdr.classList.toggle('search-open', open); tog.setAttribute('aria-expanded', String(open)); tog.textContent = open ? 'Close' : 'Search'; if (open) inp.focus(); else { hits.hidden = true; if (refocus) tog.focus(); } };
    S.openSearch = () => setOpen(true); S.closeSearch = refocus => { if (hdr?.classList.contains('search-open')) setOpen(false, refocus); };
    if (tog) tog.addEventListener('click', () => setOpen(!hdr.classList.contains('search-open'), true));
    // Existing "find a company" actions focus #gsearch; on phone, open its row first (capture runs before their handlers).
    doc.addEventListener('click', e => { if (tog && e.target.closest('[data-personal="search"],[data-income-search]') && root.getComputedStyle(tog).display !== 'none') setOpen(true); }, true);
    inp.addEventListener('keydown', e => { if (e.key === 'Escape' && hdr?.classList.contains('search-open')) { e.preventDefault(); setOpen(false, true); } });
    root.addEventListener?.('hashchange', () => S.closeSearch(false));
    // Sticky/anchor offsets follow the real header height, including an expanded search row.
    const syncH = () => { if (hdr) doc.documentElement.style.setProperty('--hdr-h', Math.ceil(hdr.getBoundingClientRect().height) + 'px'); };
    syncH(); if (root.ResizeObserver && hdr) new root.ResizeObserver(syncH).observe(hdr); else root.addEventListener?.('resize', syncH);
  }
  function initTheme() {
    const b = $('#theme'); let t = null; try { t = root.localStorage.getItem('so-brief-theme'); } catch (e) { t = null; }
    const apply = v => { if (v === 'dark' || v === 'light') doc.documentElement.dataset.theme = v; else delete doc.documentElement.dataset.theme; if (b) { b.setAttribute('aria-pressed', String(isDark())); b.textContent = isDark() ? 'Light' : 'Dark'; } S.fv?.updateTheme?.(); };
    apply(t);
    if (b) b.addEventListener('click', () => { const v = isDark() ? 'light' : 'dark'; try { root.localStorage.setItem('so-brief-theme', v); } catch (e) { console.warn('[brief] theme not saved'); } apply(v); if (S.view === 'brief' && $('#heat')) $('#heat').innerHTML = heatSlot(); });
  }
  // Saved rooms reuse the device-local dashboard store and renderer, loaded only when this route opens.
  function renderRoom(main) {
    main.innerHTML = '<div class="room-mount"><p class="dim">Loading saved rooms…</p></div>';
    const el = main.querySelector('.room-mount');
    Promise.all(['my-dashboard.css', 'my-dashboard.js'].map(loadAsset)).then(() => { if (el.isConnected) return root.SmartOptionsMyDashboard.mount(el); }).catch(e => {
      console.warn('[brief] saved rooms unavailable', e.message);
      if (el.isConnected) el.innerHTML = '<p role="alert">Saved rooms could not load: ' + esc(e.message) + '. Saved layouts stay in this browser.</p>';
    });
  }
  // Popup chat: deterministic answers from the same published data; optional rephrasing never replaces them.
  // Chat code (~85 KB of modules) loads on deliberate intent only: a small launcher (same id/class as the real one)
  // appears at idle; hovering, focusing or touching it prewarms, clicking loads and opens. Cold Today never fetches it.
  function loadChat() {
    if (root.SmartOptionsChatPopup || doc.getElementById('cp-fab')) return;
    loadAsset('chat-popup.css').then(() => {
      if (root.SmartOptionsChatPopup || doc.getElementById('cp-fab')) return;
      const b = doc.createElement('button'); b.type = 'button'; b.className = 'cp-fab'; b.id = 'cp-fab'; b.dataset.placeholder = '1';
      b.setAttribute('aria-label', 'Open chat'); b.setAttribute('aria-expanded', 'false');
      b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.5.4-1.3.1-1.3-.6V16A2.5 2.5 0 0 1 4 13.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
      doc.body.appendChild(b);
      let ready = null;
      const realFab = () => [...doc.querySelectorAll('.cp-fab')].find(x => !x.dataset.placeholder);
      const load = () => ready ||= loadAsset('chat-popup.js').then(() => new Promise((resolve, reject) => {
        const t0 = Date.now(), tick = () => { if (realFab()) { b.remove(); resolve(); } else if (Date.now() - t0 > 20000 || doc.querySelector('.cp-load-error')) reject(new Error('chat did not start')); else setTimeout(tick, 50); }; tick();
      })).catch(e => { ready = null; b.removeAttribute('aria-busy'); console.warn('[brief] chat unavailable', e.message);
        const n = doc.createElement('p'); n.className = 'cp-load-error note'; n.setAttribute('role', 'status'); n.textContent = 'Chat could not load: ' + e.message + '. Every number remains on the page.'; doc.body.appendChild(n); throw e; });
      b.addEventListener('click', e => { e.preventDefault(); b.setAttribute('aria-busy', 'true'); load().then(() => { root.SmartOptionsChatPopup.open(); }, () => {}); });
      ['pointerenter', 'focus', 'touchstart'].forEach(ev => b.addEventListener(ev, () => { load().catch(() => {}); }, {once: true, passive: true}));
      // Chat-backed page actions (e.g. "Ask about this") also count as intent.
      S.ensureChat = () => load().then(() => root.SmartOptionsChatPopup);
    });
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot); else boot();
})(typeof window !== 'undefined' ? window : globalThis);
