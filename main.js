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
    if (/^\/explore(\?|$)/.test(h)) return {view: 'explore', hash: '#' + h};
    if ((m = h.match(/^\/sector\/(.+)$/))) { try { return {view:'sector', sector:decodeURIComponent(m[1])}; } catch(e) { return {view:'brief', invalid:true}; } }
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
    const bd = m.backdrop || {}, dirWord = k => bd[k] ? (bd[k].available === false ? 'incomplete' : {up: 'rising', down: 'falling', flat: 'steady'}[bd[k].direction] || bd[k].direction) : 'n/a';
    out.push({id: 'backdrop', title: 'Macro backdrop', word: cap1(bd.status || 'unavailable'), tone: bd.status === 'supportive' ? 'good' : bd.status === 'adverse' ? 'bad' : 'mixed',
      qty: `Growth ${dirWord('growth')} · inflation ${dirWord('inflation')} · policy rate ${dirWord('policy')}`, basis: 'Latest releases; each keeps its own period'});
    const rk = m.risk || {}, ev = m.risk_events;
    out.push({id: 'risk', title: 'Risk conditions', word: cap1(rk.status || 'unavailable'), tone: rk.status === 'calm' ? 'good' : rk.status === 'stressed' ? 'bad' : 'mixed',
      qty: rk.line || 'Risk inputs unavailable', change: ev ? 'Scheduled: ' + ev.line : 'Scheduled-event count unavailable',
      basis: 'Observed volatility and credit; scheduled releases are listed separately'});
    return out;
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
  // Research case: strongest positive, strongest MEASURED objection, coverage limit, next event. Earnings are an event, never the objection.
  function caseFor(c, short, r) {
    const cards = (c && c.cards) || {}, live = k => cards[k] && cards[k].status !== 'unavailable';
    const strong = CARD_ORDER.slice(0, 6).filter(k => cards[k] && cards[k].status === 'strong');
    const positive = short && short.why && short.why[0] ? {text: short.why[0].text, card: null} : strong.length ? {text: cards[strong[0]].line, card: strong[0]} : null;
    const counter = cards.counter, measured = counter && counter.status !== 'unavailable' && !/no weak area/i.test(counter.line) && !/^not available/i.test(counter.line);
    const weak = CARD_ORDER.slice(0, 6).find(k => cards[k] && cards[k].status === 'weak');
    const missing = CARD_ORDER.slice(0, 6).filter(k => !live(k)).map(k => CARD_NAME[k].toLowerCase());
    let objection;
    if (measured) objection = {text: counter.line, card: 'counter', measured: true};
    else if (weak) objection = {text: `${CARD_NAME[weak]}: ${cards[weak].line}`, card: weak, measured: true};
    else objection = {text: 'No contrary signal in the measured dimensions' + (missing.length ? `; ${listJoin(missing)} ${missing.length > 1 ? 'remain' : 'remains'} unmeasured.` : '; that is not an all-clear.'), card: null, measured: false};
    const ert = r && (r.ert === 'BMO' ? ' before the open' : r.ert === 'AMC' ? ' after the close' : ', time not confirmed');
    return {positive, objection, coverage: missing, event: r && r.er ? `Earnings expected ${shortDate(r.er)}${ert} (provider date)` : 'No upcoming earnings date supplied'};
  }
  // Events inside an N-day ET horizon from the retained calendars. Date-only items stay dates; coverage stays explicit.
  function eventsInHorizon(core, b, nowMs, days, opts) {
    opts = opts || {};
    const today = etDate(nowMs), end = addDays(today, days), items = [];
    ((core && core.calendar) || []).forEach(e => {
      if (e.status === 'released' || !e.scheduled_et) return;
      const t = Date.parse(e.scheduled_et), timed = /T\d/.test(e.scheduled_et), d = timed && isFinite(t) ? etDate(t) : String(e.scheduled_et).slice(0, 10);
      if (d < today || d > end || (timed && t < nowMs)) return;
      items.push({kind: 'macro', when: e.scheduled_et, date: d, timing: timed ? 'timed' : 'date_only', title: e.title || e.type, type: e.type, source_url: e.source_url, note: e.note || 'Scheduled; timing can change', relevant: true});
    });
    const watch = opts.watch || new Set(), big = opts.big || new Set();
    ((core && core.rows) || []).forEach(r => {
      if (!r.er || r.er < today || r.er > end) return;
      const ert = r.ert === 'BMO' || r.ert === 'AMC' ? r.ert : null;
      if (r.er === today && ert === 'BMO' && etHour(nowMs) >= 10) return;   // threshold choice shared with the build
      items.push({kind: 'earnings', when: r.er, date: r.er, timing: ert ? ert.toLowerCase() : 'date_only', title: r.t + ' earnings', t: r.t, source: r.ers, retrieved: r.rat,
        relevant: watch.has(r.t) || big.has(r.t) || opts.ticker === r.t, saved: watch.has(r.t)});
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
    return {today, end, days, items, relevant: items.filter(x => x.relevant), notes, complete: false};
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

  const API = {catalogNote, concentrationInsight, leadershipInsight, macroInsight, basketMoves, liveConcentration, corrWord, valuationText, counterpoint, sessionWord, sectorSensitivity, factorSentence, liveBreadth, vsAverages, route, median, FACTORS, pct, px, assessments, marketRead, supportChallenge, caseFor, eventsInHorizon, compareQuestion, rangePos, addDays, CARD_ORDER, CARD_Q};
  if (typeof module !== 'undefined' && module.exports) { module.exports = API; return; }
  root.SmartOptionsMain = API;
  const doc = root.document; if (!doc) return;

  /* ------------------------------------------------------------ page */
  const ASSET_V = 'client-20261018r14-investor';
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
  // Price histories are immutable within a data session: one request per ticker, shared by chart, drivers and Compare.
  const pxCache = new Map();
  function pxJson(tk) { const u = `data/px/${encodeURIComponent(tk)}.json`; if (!pxCache.has(u)) { const pr = json(u); pxCache.set(u, pr); pr.catch(() => pxCache.delete(u)); } return pxCache.get(u); }
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
  const frames = new Map(); const frameEpoch = Date.now().toString(36) + Math.random().toString(36).slice(2, 9); let frameId = null, frameSerial = 0;
  const persistentKeys = new Set(['core','brief','rel','relError','rowMap','company','metricEvidence']);
  function saveFrame() {
    if (!frameId || !$('#view').firstChild) return;
    const frame = {nodes:[...$('#view').childNodes], state:{}, y:root.scrollY, focus:doc.activeElement,
      watch:Object.fromEntries(['explore','company','research','index','investor'].map(k=>[k,[...(Live._state.owners[k]||[])]]))};
    Object.keys(S).filter(k=>!persistentKeys.has(k)).forEach(k=>{frame.state[k]=S[k];});
    frames.delete(frameId);frames.set(frameId,frame);
    frame.nodes.forEach(n=>n.remove());
    while (frames.size>12) {
      const k=frames.keys().next().value, old=frames.get(k); frames.delete(k);
      ['chart','exChart','exRc'].forEach(c=>{try {old.state[c]?.remove();} catch(e) { console.warn('Discarded chart could not be released'); }});try{old.state.fv?.destroy();}catch(e){console.warn('Discarded company chart could not be released');}
    }
  }
  function backControl(main) {
    if (S.view==='brief') return;
    const el=doc.createElement('div');el.className='depth-nav';
    el.innerHTML='<button type="button" data-depth-back>← Back</button><a href="#/">Today</a><span class="dim"> / '+esc(S.view==='company' ? 'Company' : S.view==='sector' ? 'Sector' : S.view==='explore' ? 'Compare' : S.view==='companies' ? 'Companies' : S.view==='macro' ? 'Macro' : S.view)+'</span>';
    main.prepend(el);
    el.querySelector('button').onclick=()=>{if(root.history.state?.soParent)root.history.back();else root.location.hash='#/';};
  }
  function render() {
    closeSheet();
    if(S.view==='brief')S.personal?.suspend();
    const previous=frameId;
    saveFrame();
    frameId=root.history.state?.soFrame || 'depth-'+frameEpoch+'-'+(++frameSerial);
    root.history.replaceState({...root.history.state,soFrame:frameId,soParent:root.history.state?.soParent || (previous!==frameId ? previous : null)},'');
    const cached=frames.get(frameId);
    if(cached) {
      frames.delete(frameId);
      Object.keys(S).filter(k=>!persistentKeys.has(k)).forEach(k=>{delete S[k];});Object.assign(S,cached.state);
      if(S.horizon)UI.horizon=S.horizon;   // the restored view's visible horizon is the selected one
      $('#view').replaceChildren(...cached.nodes);setView(S.view==='company'?'companies':S.view);
      S.fv?.updateTheme?.();
      const personalFocus=cached.focus?.closest?.('[data-personal-t]')?.dataset.personalT,personalHref=cached.focus?.getAttribute?.('href'),personalControl=cached.focus?.dataset?.personal;
      if(S.view==='brief')S.personal?.refresh();
      Object.entries(cached.watch).forEach(([owner,names])=>{if(owner!=='investor'||S.view!=='brief')Live.watch(owner,names);});
      if(S.view==='explore')updateExploreQuotes();
      Live.paint(doc,null);paintSlots();
      requestAnimationFrame(()=>{root.dispatchEvent(new Event('resize'));let focus=cached.focus;
        if(!focus?.isConnected&&personalFocus)focus=[...doc.querySelectorAll('[data-personal-t]')].find(n=>n.dataset.personalT===personalFocus)?.querySelectorAll('a');
        if(focus&&typeof focus.focus!=='function')focus=[...focus].find(n=>n.getAttribute('href')===personalHref);
        if(!focus?.isConnected&&personalControl)focus=[...doc.querySelectorAll('[data-personal]')].find(n=>n.dataset.personal===personalControl);
        if(!focus?.isConnected&&cached.focus?.id)focus=doc.getElementById(cached.focus.id);
        focus?.focus?.({preventScroll:true});root.scrollTo(0,cached.y);});
      return;
    }
    const r = route(root.location.hash);
    S.slots = []; S.onQuote = null; S.exToken = (S.exToken || 0) + 1; S.exChart=null;S.exRc=null;S.chart=null;S.exSeries=[];S.jointChart=null;S.jointBand=[];S.coTab=null;S.co=null;S.fv=null;S.drv=null;S.coDraw=null;S.horizon=UI.horizon;S.lastEvents={};
    if (r.view !== 'brief') Live.watch('investor', []);
    if (r.view !== 'explore') Live.watch('explore', []);
    S.view = r.view; setView(r.view === 'company' ? 'companies' : r.view);
    const main = $('#view');
    try {
      if (r.view === 'company') { main.innerHTML = '<p class="dim">Loading…</p>'; renderCompany(r.t, main); }
      else if (r.view === 'positions') root.SmartOptionsInvestor.mountPositions(main, investorArgs(), S.positionTicker || '');
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
  const UI = root.__soMainUI = {horizon: 7};
  const evAttr = ev => esc(JSON.stringify(ev));
  const evBtn = (ev, label, cls) => `<button type="button" class="ev${cls ? ' ' + cls : ''}" data-ev="${evAttr(ev)}">${label || 'Evidence'}</button>`;
  function bigNames() { return new Set(S.core.rows.filter(r => r.sp500_member !== false && isNum(r.mcap)).sort((a, b) => b.mcap - a.mcap).slice(0, 60).map(r => r.t)); }
  function horizonEvents(days, ticker) { return eventsInHorizon(S.core, S.brief, Date.now(), days, {watch: new Set(WL().get()), big: bigNames(), ticker}); }
  const timingWord = x => x.timing === 'bmo' ? 'before the open' : x.timing === 'amc' ? 'after the close' : x.timing === 'timed' ? '' : 'time not confirmed';
  function eventLine(x, i, scope) {
    const tw = timingWord(x);
    return `<li><span class="when">${when(x.when)}</span> <b>${x.t ? `<a href="#/company/${esc(x.t)}">${esc(x.title)}</a>` : esc(x.title)}</b>${tw ? ` <span class="dim">${esc(tw)}</span>` : ''}${x.saved ? ' <span class="tag">saved</span>' : ''} ${evBtn({kind: 'event', scope, i}, 'Source')}</li>`;
  }
  function aheadHtml() {
    const h = horizonEvents(S.horizon); S.lastEvents = S.lastEvents || {}; S.lastEvents.today = h.relevant;
    const top = h.relevant.slice(0, 2), rest = h.relevant.slice(2);
    return `<div class="horizon" role="group" aria-label="Event horizon">${[7, 30].map(d => `<button type="button" data-horizon="${d}" aria-pressed="${S.horizon === d}">${d} days</button>`).join('')}</div>
      <p class="dim small">${esc(shortDate(h.today))} to ${esc(shortDate(h.end))} ET · macro releases, saved names and the 60 largest companies</p>
      <ul class="events">${top.map((x, i) => eventLine(x, i, 'today')).join('') || '<li class="dim">No listed release or tracked earnings in this window. That is not a clear calendar; see coverage below.</li>'}</ul>
      ${rest.length ? `<details class="more" data-more="events"><summary>${rest.length} more in this window</summary><ul class="events">${rest.map((x, i) => eventLine(x, i + 2, 'today')).join('')}</ul></details>` : ''}
      <p class="cov dim small">${h.notes.map(esc).join(' ')}</p>`;
  }
  function tile(a) {
    return `<button type="button" class="tile" data-tone="${esc(a.tone)}" data-assess="${esc(a.id)}" data-ev="${evAttr({kind: 'assessment', id: a.id})}">
      <span class="t-title">${esc(a.title)}</span><span class="t-word">${esc(a.word)}</span><span class="t-qty">${esc(a.qty)}</span>${a.change ? `<span class="t-chg">${esc(a.change)}</span>` : ''}<span class="t-basis">${esc(a.basis)}</span></button>`;
  }
  function shortCard(x) {
    const r = row(x.t), er = r && r.er ? `Earnings ${shortDate(r.er)}` : '', st = x.status || {};
    const miss = CARD_ORDER.slice(0, 6).filter(k => st[k] === 'unavailable').map(k => CARD_NAME[k].toLowerCase()), weak = CARD_ORDER.slice(0, 6).find(k => st[k] === 'weak');
    const ct = (x.counter && x.counter.text) || '', measured = ct && !/no weak area/i.test(ct) && !/^not available/i.test(ct);
    const obj = measured ? ct : weak ? `${CARD_NAME[weak]} is rated weak in the measured data.` : 'No contrary signal in the measured dimensions' + (miss.length ? `; ${listJoin(miss)} unmeasured.` : '; not an all-clear.');
    return `<article data-short="${esc(x.t)}"><h3><a href="#/company/${esc(x.t)}">${esc(x.t)}</a> <span class="dim">${esc(x.name)} · ${esc(x.sector)}</span>
        <span class="px">${liveSpan(x.t, 'price')} <span class="chg">${liveSpan(x.t, 'chg')}</span></span></h3>
      <p class="why"><span class="lbl">Why look</span> ${esc((x.why && x.why[0] && x.why[0].text) || 'Inspect the dated company evidence.')}</p>
      <p class="obj"><span class="lbl">Objection</span> ${esc(obj)}</p>
      <p class="dim small">${er ? esc(er) + ' (event, not an objection) · ' : ''}${slot('idea-' + x.t, ideaSlot(x.t))} ${evBtn({kind: 'shortlist', t: x.t}, 'Evidence')}</p>
      <p class="links"><a href="#/company/${esc(x.t)}">Open dossier →</a> <a class="go" href="${esc(companyHref(x.t, x.sector))}">Compare with SPY and ${esc(x.sector)}</a></p></article>`;
  }
  function renderBrief(main, legacy) {
    const b = S.brief, pos = b.positioning || {}, all = b.shortlist || [], short = all.slice(0, 3);
    Live.watch('index', ['SPY', 'RSP']); Live.watch('research', short.map(x => x.t)); Live.watch('company', []);
    const relNote = S.rel ? '' : `<p class="dim">Sector baskets and the relationship catalog are unavailable (${esc(S.relError || 'not loaded')}), so those drilldowns are withheld.</p>`;
    const read = marketRead(b), sc = supportChallenge(b), as = assessments(b), f = factorSentence(S.core, 'us10y_bps');
    const scItem = (x, kind) => x ? `<p>${esc(x.text)} ${evBtn(x.ev)}</p>` : `<p class="dim">No ${kind} in the measured assessments or dated changes.</p>`;
    const conc = pos.concentration || {}, gap = changeItem(b, 'eq_cap_gap_5d');
    main.innerHTML = `
      ${legacy ? `<p class="note">That view is part of the expanded dashboard. <a href="backup.html${esc(legacy)}">Open it in the expanded edition</a>.</p>` : ''}
      <section id="for-you" class="for-you" aria-label="For you"></section>
      <div class="today">
        <section class="read" aria-labelledby="read-h"><p class="eyebrow">Market reading · completed session ${esc(shortDate(b.asof_session))}</p>
          <h1 id="read-h" class="headline">${esc(read.headline)}</h1>
          ${read.unavailable ? `<p class="note">${esc(read.unavailable)}</p>` : ''}
          <ul class="changed">${read.changed.map(x => `<li>${esc(x.text)} ${evBtn(x.ev)}</li>`).join('')}</ul>
          <div class="sc"><div class="sup"><h3>Supports</h3>${scItem(sc.supports[0], 'support')}</div><div class="chal"><h3>Challenges</h3>${scItem(sc.challenges[0], 'challenge')}</div></div>
          ${sc.supports.length + sc.challenges.length > 2 ? `<details class="more" data-more="pulse"><summary>All supports and challenges (${sc.supports.length + sc.challenges.length})</summary><div class="two"><ul>${sc.supports.map(x => `<li>${esc(x.text)} ${evBtn(x.ev)}</li>`).join('') || '<li class="dim">None measured.</li>'}</ul><ul>${sc.challenges.map(x => `<li>${esc(x.text)} ${evBtn(x.ev)}</li>`).join('') || '<li class="dim">None measured.</li>'}</ul></div></details>` : ''}
          <div class="assess">${as.map(tile).join('')}</div>
          <p class="quiet dim small">SPY now ${liveSpan('SPY', 'price')} <span class="chg">${liveSpan('SPY', 'chg')}</span> ${slot('market-session', () => q('SPY')?.market_hours === 2 ? 'after hours' : q('SPY')?.market_hours === 0 ? 'pre-market' : '')} · assessments use completed sessions</p>
        </section>
        <aside class="ahead" aria-labelledby="ahead-h"><h2 id="ahead-h">Ahead of you</h2><div id="ahead">${aheadHtml()}</div></aside>
      </div>
      <div class="today2">
        <section class="mapcol"><h2>Sectors</h2>
          <div class="map-period" role="group" aria-label="Sector map period">${['1D', '1W', '1M'].map(p => `<button data-map-period="${p}" aria-pressed="${(S.heatPeriod || '1D') === p}">${p}</button>`).join('')}</div>${slot('heat', heatSlot)}
          <p class="posline">${esc(conc.line || '')} ${gap && gap.status === 'ok' ? `Equal-weight ${gap.current.value >= 0 ? 'led' : 'trailed'} cap-weight by ${Math.abs(gap.current.value).toFixed(2)} pp over 20 sessions.` : ''} <a class="go" href="${esc(W.encodeHash({s: [{id: 'eq:RSP'}, {id: 'eq:SPY'}], r: '6m', m: 'index'}))}">Compare RSP and SPY →</a></p>
          <p class="dim small">${slot('breadth', breadthSlot)}</p></section>
        <section class="research"><h2>Research shortlist</h2>
          <p class="dim small">Ranked by current fundamentals, trend and dated signals; a starting list for research, not a recommendation.</p>
          <div class="ideas">${short.map(shortCard).join('') || '<p class="dim">No company met the shortlist coverage rule in this build.</p>'}</div>
          <p>${all.length > 3 ? `<a href="#/companies?mode=shortlist">View all ${all.length} eligible →</a> · ` : ''}<a href="#/companies">Research all companies →</a></p></section>
      </div>
      <section class="evidence-more"><h2>Evidence to investigate</h2>
        <div class="insights">${insightCard(concentrationInsight(S.core.rel && S.core.rel.vol_breadth))}${S.rel ? insightCard(leadershipInsight(S.rel)) + insightCard(macroInsight(S.rel, S.core)) : ''}</div>
        ${f ? `<p>${esc(f.lead)}. <a class="go" href="${esc(factorHref(f))}">Related sectors and evidence →</a> <a href="#/macro">Macro detail</a></p>` : ''}
        <p class="dim">${slot('live-conc', liveConcSlot)}</p>${relNote}</section>`;
    S.personal=root.SmartOptionsInvestor.mountToday($('#for-you'),investorArgs());
    S.onQuote=changed=>S.personal?.quotes(changed);
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
    const el = sheetEl();
    el.querySelector('#sheet-h').textContent = content.title;
    el.querySelector('.sheet-body').innerHTML = content.html + (content.ask && root.SmartOptionsIntents ? `<p><button type="button" class="cp-context" data-intent="${esc(content.ask.intent)}" data-entities="${evAttr(content.ask.entities || {})}">Ask about this</button></p>` : '');
    el.dataset.kind = ev.kind; el.hidden = false; doc.getElementById('sheet-bg').hidden = false; doc.documentElement.classList.add('sheet-open');
    sheetTrigger = trigger || doc.activeElement;
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
    const b = S.brief;
    if (ev.kind === 'assessment') {
      const m = b.macro || {}, a = assessments(b).find(x => x.id === ev.id), obj = ev.id === 'participation' ? (b.positioning && b.positioning.breadth) || m.participation : m[ev.id];
      let html = `<p class="lead"><b>${esc(a.word)}</b> · ${esc(a.qty)}</p><p class="dim">${esc(a.basis)}</p>`;
      if (ev.id === 'participation') html += `<h3>Dated five-session change</h3>${changeHtml(changeItem(b, 'breadth_50_5d'))}<p class="dim">The older model label “${esc(obj && obj.status)}” classifies levels against fixed thresholds (≥60% broad, &lt;40% thin on both 50- and 200-session shares); it does not compare dates.</p>`;
      if (ev.id === 'risk') html += `<h3>Scheduled events (separate from observed stress)</h3><p>${esc(m.risk_events ? m.risk_events.line : 'Scheduled-event condition unavailable.')}</p>`;
      if (ev.id === 'backdrop') html += ['growth', 'inflation', 'policy'].map(k => m.backdrop && m.backdrop[k] ? `<p><b>${GROUPS[k]}:</b> ${esc(m.backdrop[k].line)}</p>` : '').join('');
      html += `<h3>Inputs and sources</h3>${metricTable(ev.id === 'backdrop' ? ['growth', 'inflation', 'policy'].flatMap(k => (m.backdrop[k] && m.backdrop[k].metrics || []).slice(0, 4)) : obj && obj.metrics, true)}`;
      return {title: a.title, html: html + defText(a.title === 'Participation' ? 'participation average' : a.title === 'Risk conditions' ? 'VIX volatility' : a.title === 'Macro backdrop' ? 'inflation CPI' : 'average trend'), ask: {intent: {price_trend: 'pulse', participation: 'breadth', backdrop: 'pulse', risk: 'risks'}[ev.id], entities: {}}};
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
      return {title: `${x.t}: why it is on the shortlist`, html: `<ul>${x.why.map(w => `<li>${esc(w.text)}</li>`).join('')}</ul><p><b>Objection:</b> ${esc(x.counter.text)}</p>
        <p class="dim">Research score ${x.score} of 100. ${esc(x.score_basis)} The score orders the list; it is not a forecast.</p><p class="dim">Dimension status: ${CARD_ORDER.map(k => `${CARD_NAME[k]} ${esc(x.status[k])}`).join(' · ')}</p>
        ${metricTable(x.why.flatMap(w => w.metrics).concat(x.counter.metrics || []), true)}<p><a href="#/company/${esc(x.t)}">Open the ${esc(x.t)} dossier →</a></p>`, ask: {intent: 'shortlist', entities: {tickers: [x.t]}}};
    }
    if (ev.kind === 'card') {
      const c = S.company[ev.t], k = c && c.cards[ev.id];
      if (!k) return {title: CARD_NAME[ev.id] || 'Evidence', html: '<p>Company evidence is not loaded.</p>'};
      return {title: `${ev.t} · ${CARD_NAME[ev.id]}`, html: `<p class="dim">${esc(CARD_Q[ev.id])}</p><p class="lead"><span class="st" data-status="${esc(k.status)}">${esc(k.status)}</span> ${esc(k.line)}</p>${ev.id === 'valuation' ? `<p>${valSlot(ev.t, k)()}</p><p class="dim">Peer comparison uses the broad sector median, not a curated peer group; the company's own valuation history is not available in this build.</p>` : ''}${metricTable(k.metrics, true)}${defText(CARD_NAME[ev.id])}`,
        ask: {intent: 'ticker_card', entities: {tickers: [ev.t], card: ev.id}}};
    }
    if (ev.kind === 'event') {
      const x = ((S.lastEvents || {})[ev.scope] || [])[ev.i];
      if (!x) return {title: 'Event', html: '<p>This event is no longer in the selected window.</p>'};
      return {title: x.title, html: `<p class="lead">${when(x.when)} ${esc(timingWord(x))}</p><p>${x.kind === 'earnings' ? `Provider date: ${esc(x.source || 'Yahoo Finance')}, retrieved ${esc(x.retrieved || 'n/a')}. ${x.timing === 'date_only' ? 'No time of day is supplied, so this is a date, not a scheduled moment.' : ''} Results can reset expectations; this is an event constraint, not evidence against the company.` : `${esc(x.note)}. <a href="${esc(x.source_url || '#')}" target="_blank" rel="noopener">Release calendar</a>`}</p>`};
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
      go('#/sector/' + encodeURIComponent(sec)); await wait(() => S.view === 'sector' && $('#view h2') && $('#view h2').textContent.startsWith(sec), 'sector view');
      return {text: `Opened ${sec} (${S.heatPeriod || '1D'} period).`, sector: sec};
    }
    if (x.kind === 'switch_period') {
      if (!['1D', '1W', '1M'].includes(x.period)) throw new Error('Unsupported map period.');
      if (S.view !== 'brief') go('#/');
      await wait(() => $(`[data-map-period="${x.period}"]`), 'map controls');
      $(`[data-map-period="${x.period}"]`).click();
      await wait(() => S.heatPeriod === x.period && $(`[data-map-period="${x.period}"]`).getAttribute('aria-pressed') === 'true', 'map period');
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
      <details class="cols"><summary>Columns</summary><div class="ex-ctl">${Object.entries(COLS).map(([k, c]) => `<label><input type="checkbox" data-col="${k}"${S.co.cols.includes(k) ? ' checked' : ''}> ${esc(c[0])}</label>`).join('')}</div><p class="dim small">The Jul 25 score is the historical SmartOptions snapshot (2026-07-25), shown only when chosen; it is not current evidence.</p></details>
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
        <td class="n">${liveSpan(r.t, 'price')}</td><td class="n chg">${liveSpan(r.t, 'chg')}</td>${S.co.mode === 'shortlist' ? `<td class="small">${esc(sx && sx.why[0] ? sx.why[0].text : '')}<div class="dim">${esc(sx ? sx.counter.text : '')}</div></td>` : ''}
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
      const m = (x.metrics || []).find(y => y.value != null) || (x.metrics || [])[0];
      return `<details class="card frow" data-card="${k}"><summary><b>${esc(CARD_Q[k])}</b> <span class="st" data-status="${esc(x.status)}">${esc(x.status)}</span> <span class="qty">${k === 'valuation' ? slot('val-sum', valShort(t, x)) : esc(x.line)}</span>${m && m.period ? ` <span class="dim small">${esc(m.period)}</span>` : ''}</summary>
        ${k === 'valuation' ? `<p>${slot('val', valSlot(t, x))}</p><p class="dim small">Broad sector median, not a curated peer group; own valuation history is not available.</p>` : ''}${metricTable(x.metrics, true)}<p>${evBtn({kind: 'card', t, id: k}, 'Open evidence')}</p></details>`; }).join('');
  }
  function driversHtml(t, r, c) {
    return `<h3 class="question">Has ${esc(t)} outperformed the market and its sector?</h3><p id="drv-answer">${slot('drv', () => S.drv || 'Measuring against SPY and the sector basket…')}</p>
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
      <li><b>Event overlap:</b> ${er ? `earnings ${esc(shortDate(er))}${days != null && days >= 0 ? ` (in about ${days} days)` : ''}; an expiry after that date carries the report's gap risk and usually richer implied volatility.` : 'no provider earnings date; confirm the company calendar before choosing an expiry.'}</li>
      <li><b>Structure:</b> check the payoff and maximum loss of the actual position. A covered call retains substantial downside in the shares; premium does not remove that risk. <a href="https://www.optionseducation.org/strategies/all-strategies/covered-call-buy-write" target="_blank" rel="noopener">Covered-call risk</a></li>
      <li><b>Liquidity and assignment:</b> wide bid/ask spreads, low open interest and early assignment on short calls near dividends can change the outcome.</li>
      <li><b>No-trade alternative:</b> holding no position, or the shares alone, is a valid choice when the case or the timing is unclear.</li></ul>
      ${o.line ? `<p class="dim">${esc(o.line)}</p>` : ''}<p><a href="backup.html#/research/markets?t=${encodeURIComponent(t)}">Open ${esc(t)} in the expanded strategy tools →</a> <span class="dim small">(modelled payoffs, clearly labelled; not live prices)</span></p>`;
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
    const short = (S.brief.shortlist || []).find(x => x.t === t), cs = caseFor(c, short, r);
    S.coTab = S.coTab || route(root.location.hash).tab || 'overview';
    main.innerHTML = `
      <section class="co" data-t="${esc(t)}"><div class="co-head"><h1>${esc(r.n)} <span class="co-t">${esc(t)}</span></h1>${starBtn(t)}<a class="position-link" href="#/positions" data-position-t="${esc(t)}">Add/edit position</a></div>
        <p class="dim"><a href="#/sector/${encodeURIComponent(r.sec)}">${esc(r.sec)}</a>${r.ind ? ' · ' + esc(r.ind) : ''}${r.sp500_member === false ? ' · not in the current S&amp;P 500 list' : ''}</p>
        <div class="quote"><span class="big">${liveSpan(t, 'price')}</span> <span class="chg">${liveSpan(t, 'chg')}</span> ${slot('session', () => sessionNote(t))}</div>
        <p class="dim small">${slot('ctx', () => esc(Live.currentContext(t, Live.snapshot())))}</p>
        ${c ? '' : '<p class="note" role="status">Company evidence is unavailable in the published data; price and chart remain.</p>'}
        <div class="case"><p><span class="lbl">Case</span> ${esc(cs.positive ? cs.positive.text : 'No strong measured dimension in this build.')}</p>
          <p><span class="lbl obj">Objection</span> ${esc(cs.objection.text)} ${cs.objection.card ? evBtn({kind: 'card', t, id: cs.objection.card}) : ''}</p>
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
  function macroValue(x) { if (!isNum(x.v)) return 'n/a'; const u = x.unit || ''; return (Math.abs(x.v) >= 1e5 ? big(x.v) : +x.v.toFixed(2)) + (u ? ' ' + esc(u) : ''); }
  function renderMacro(main) {
    Live.watch('research', []); Live.watch('company', []); Live.watch('index', ['SPY']);
    const bd = S.brief.macro && S.brief.macro.backdrop || {}, risk = S.brief.macro && S.brief.macro.risk || {};
    const rels = Object.keys(FACTORS).map(f => factorSentence(S.core, f)).filter(Boolean);
    const cal = (S.core.calendar || []).filter(x => x.status !== 'released').sort((a, b) => String(a.scheduled_et).localeCompare(String(b.scheduled_et))).slice(0, 12);
    S.metricEvidence ||= new Map();for(const group of Object.values(S.core.macro||{}))for(const x of group){S.metricEvidence.set(x.label,{label:x.label,value:x.v,unit:x.unit,period:x.period,asof:x.retrieved_at,source:x.provider,source_url:x.url,note:x.note||'Observation date '+x.date+'; reference period is not the release timestamp.'});}
    const mc = (S.brief.daily_changes && S.brief.daily_changes.macro) || [], ev = S.brief.macro && S.brief.macro.risk_events;
    const h = horizonEvents(S.horizon); S.lastEvents = S.lastEvents || {}; S.lastEvents.macro = h.items.filter(x => x.kind === 'macro');
    const detail = Object.fromEntries(((S.brief.macro && S.brief.macro.detail) || []).map(d => [d.group, d.line]));
    const cv = x => x.unit === '%' || /%/.test(x.unit) ? +x.value.toFixed(2) + (x.unit === '%' ? '%' : ' ' + x.unit) : (Math.abs(x.value) >= 1e5 ? big(x.value) : +x.value.toFixed(2)) + ' ' + x.unit;
    main.innerHTML = `<h1>Macro</h1>
      <div class="macro-top">
        <section><h2>Persistent trends</h2><ul>${['growth', 'inflation', 'policy'].filter(k => bd[k] && bd[k].line).map(k => `<li><b>${GROUPS[k] || k}:</b> ${esc(bd[k].line)}</li>`).join('')}</ul><p>${evBtn({kind: 'assessment', id: 'backdrop'}, 'Backdrop evidence')}</p></section>
        <section><h2>Observed stress</h2><p><b>${esc(cap1(risk.status || 'unavailable'))}:</b> ${esc(risk.line || 'Risk inputs unavailable.')}</p><p class="dim small">Volatility and credit observations only. Scheduled releases do not count as stress.</p><p>${evBtn({kind: 'assessment', id: 'risk'}, 'Risk evidence')}</p></section>
        <section><h2>Scheduled events</h2><p class="dim small">${esc(ev ? ev.line : '')}</p><div class="horizon" role="group" aria-label="Event horizon">${[7, 30].map(d => `<button type="button" data-horizon="${d}" aria-pressed="${S.horizon === d}">${d} days</button>`).join('')}</div>
          <ul class="events">${S.lastEvents.macro.map((x, i) => eventLine(x, i, 'macro')).join('') || '<li class="dim">No listed release in this window; see coverage.</li>'}</ul><p class="dim small">${h.notes.slice(0, 1).concat(h.notes.slice(2)).map(esc).join(' ')}</p></section>
      </div>
      <section><h2>Latest observation versus the prior one</h2><p class="dim small">Each row compares two dated observations from the retained history (current data vintage, so earlier values may include revisions). A newer retrieval without a new observation is not a change.</p>
        <div class="tablewrap"><table class="mchg"><thead><tr><th>Series</th><th class="n">Latest</th><th class="n">Prior</th><th class="n">Change</th></tr></thead><tbody>${mc.map(x => x.status === 'ok' ? `<tr><td>${esc(x.label)}${x.obs_status && x.obs_status !== 'ok' ? ` <span class="tag">${esc(x.obs_status)}</span>` : ''}</td><td class="n">${esc(cv(x.current))} <span class="dim small">${esc(x.current.date)}</span></td><td class="n">${esc(cv(x.prior))} <span class="dim small">${esc(x.prior.date)}</span></td><td class="n ${x.direction === 'up' ? 'up' : x.direction === 'down' ? 'dn' : ''}">${x.change > 0 ? '+' : ''}${+x.change.toFixed(3)}</td></tr>` : `<tr><td>${esc(x.label)}</td><td colspan="3" class="dim">Unavailable: ${esc(x.reason)}</td></tr>`).join('') || '<tr><td colspan="4" class="dim">Dated comparisons are not in this data build.</td></tr>'}</tbody></table></div></section>
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
    if (id.startsWith('eq:')) { const d = await pxJson(id.slice(3)); h = (d.bars || []).filter(b => isNum(b[4]) && b[4] > 0).map(b => [b[0], b[4]]); }
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
    if(!m?.available){el.innerHTML=`<details class="joint"><summary>Economic what-if</summary><p>${esc(m?.reason||'No joint model for this asset in the fixed 64-candidate research budget. Choose SPY, AAPL, MSFT, NVDA, AMZN, JPM, XOM or a supported sector basket.')} Historical overlays remain available through chart controls.</p></details>`;if(root.__soPersonalWhatif){root.__soPersonalWhatif=false;el.querySelector('details').open=true;el.tabIndex=-1;el.scrollIntoView({block:'start'});el.focus({preventScroll:true});}return;}
    el.innerHTML=`<section class="joint"><h3>Two economic moves, together ${learnLink('Scenario','What does this mean?')}</h3><p class="dim">Hypothetical one-day changes associated with ${esc(metaOf(id)?.label||id)}; ${m.n} common days, ${esc(m.fit_start)}–${esc(m.fit_end)}. Joint fit, holding the other driver fixed. It describes history, not a forecast.</p><div class="joint-inputs"><label>10-year Treasury move ${learnLink('Basis points','bp')}<input id="joint-rate" type="number" step="any" inputmode="decimal" value="${S.jointValues[0]}" data-joint="0"></label><label>WTI oil move (%)<input id="joint-oil" type="number" step="any" inputmode="decimal" value="${S.jointValues[1]}" data-joint="1"></label></div><div class="ex-ctl"><label><input type="checkbox" id="joint-on"${S.jointEnabled?' checked':''}> Show hypothetical marker & mean band</label><button type="button" data-joint-overlays>Add rate & oil history</button><button type="button" data-joint-reset>Clear what-if</button></div><p id="joint-out" role="status"></p><details><summary>Method, bounds & counterargument</summary><p>Asset daily percent change = ${f3(m.coefficients[0])} + ${f3(m.coefficients[1])} × rate move (bp) + ${f3(m.coefficients[2])} × oil move (%). Each driver is bounded to its central 90% sample: rate ${m.bounds[0].map(f3).join(' to ')} bp; oil ${m.bounds[1].map(f3).join(' to ')}%. Joint leverage must be ≤9/n. Condition number ${f3(m.condition)}; residual daily standard deviation ${f3(Math.sqrt(m.residual_variance))}%. ${esc(m.method)}.</p><p>Counterargument: these two variables leave other market and company events unexplained; revised macro histories, different close times and changing relationships can break the association. The chart uses the last observed chart price as an anchor, not a target date or fabricated price bar.</p><p>${learnLink('Confidence interval','Average uncertainty vs individual-day variation')} · ${learnLink('Beta','Joint slopes')} · Catalog built ${esc(S.rel.generated_at)}; total fixed search ≤${S.rel.candidate_search.max} candidates.</p></details></section>`;
    el.querySelectorAll('[data-joint]').forEach(inp=>inp.oninput=()=>{S.jointValues[+inp.dataset.joint]=inp.value===''?null:Number(inp.value);updateJoint();});
    $('#joint-on').onchange=e=>{S.jointEnabled=e.target.checked;updateJoint();};
    el.querySelector('[data-joint-reset]').onclick=()=>{S.jointEnabled=false;S.jointValues=[0,0];$('#joint-on').checked=false;$('#joint-rate').value='0';$('#joint-oil').value='0';updateJoint();};
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
    const panel=S.view==='company'&&root.scrollY>0?doc.querySelector('.co-panel:not([hidden])'):null;
    const before=panel?.getBoundingClientRect().top,anchored=before!=null&&before<root.innerHeight;
    paintSlots();if(S.onQuote)S.onQuote(ch);
    if(anchored&&panel.isConnected){const delta=panel.getBoundingClientRect().top-before;if(Math.abs(delta)>.5)root.scrollBy(0,delta);}
  },120); }
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
    doc.addEventListener('keydown',e=>{if(e.key==='Escape'&&sheetOpen()){e.preventDefault();closeSheet();return;}if(e.key==='Escape'&&(doc.documentElement.classList.contains('cp-open')||e.target.closest('#cp-panel,#gs-hits,#gsearch')))return;if(e.key==='Escape'&&S.view!=='brief'&&!e.target.closest('.ex-hits')){e.preventDefault();if(root.history.state?.soParent)root.history.back();else root.location.hash='#/';}});
    WL();
    root.SmartOptionsAPI = Object.assign(root.SmartOptionsAPI || {}, {brief_action: mainAction});
    doc.addEventListener('click', e => {
      const pt=e.target.closest('[data-position-t]');if(pt)S.positionTicker=pt.dataset.positionT;
      const ev = e.target.closest('[data-ev]'); if (ev) { e.preventDefault(); try { openSheet(JSON.parse(ev.dataset.ev), ev); } catch (err) { console.error('[brief] evidence id', err); } return; }
      const st = e.target.closest('[data-star]'); if (st) { toggleStar(st.dataset.star); if (S.coDraw && S.co && S.co.mode === 'saved') S.coDraw(); return; }
      const hz = e.target.closest('[data-horizon]');
      if (hz) { UI.horizon = S.horizon = +hz.dataset.horizon;
        if (S.view === 'brief' && $('#ahead')) {$('#ahead').innerHTML = aheadHtml();S.personal?.refresh();}
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
    // Chat modules (~150 KB) wait until the first view has rendered and the main thread is idle (phone-first).
    const later = root.requestIdleCallback ? fn => root.requestIdleCallback(fn, {timeout: 4000}) : fn => setTimeout(fn, 1500);
    later(loadChat);
  }
  // Header company search across the whole retained universe.
  function initSearch() {
    const inp = $('#gsearch'), hits = $('#gs-hits'); if (!inp || !hits) return;
    const show = () => {
      const s = inp.value.trim().toUpperCase(); if (!s) { hits.hidden = true; hits.innerHTML = ''; return; }
      const xs = S.core.rows.filter(r => r.t.startsWith(s.replace('.', '-')) || String(r.n).toUpperCase().includes(s)).sort((a, b) => (a.t === s ? -1 : 0) - (b.t === s ? -1 : 0) || (b.mcap || 0) - (a.mcap || 0)).slice(0, 8);
      hits.innerHTML = xs.map(r => `<li role="option"><a href="#/company/${esc(r.t)}"><b>${esc(r.t)}</b> ${esc(r.n)} <span class="dim">${esc(r.sec)}${r.sp500_member === false ? ' · not in current S&amp;P list' : ''}</span></a></li>`).join('') || '<li class="dim">No company matches.</li>';
      hits.hidden = false;
    };
    inp.addEventListener('input', show);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { const a = hits.querySelector('a'); if (a) { e.preventDefault(); root.location.hash = a.getAttribute('href'); inp.value = ''; hits.hidden = true; inp.blur(); } } if (e.key === 'Escape') { hits.hidden = true; } if (e.key === 'ArrowDown') { const a = hits.querySelector('a'); if (a) { e.preventDefault(); a.focus(); } } });
    hits.addEventListener('click', e => { if (e.target.closest('a')) { inp.value = ''; hits.hidden = true; } });
    doc.addEventListener('click', e => { if (!e.target.closest('.gsearch')) hits.hidden = true; });
  }
  function initTheme() {
    const b = $('#theme'); let t = null; try { t = root.localStorage.getItem('so-brief-theme'); } catch (e) { t = null; }
    const apply = v => { if (v === 'dark' || v === 'light') doc.documentElement.dataset.theme = v; else delete doc.documentElement.dataset.theme; if (b) { b.setAttribute('aria-pressed', String(isDark())); b.textContent = isDark() ? 'Light' : 'Dark'; } S.fv?.updateTheme?.(); };
    apply(t);
    if (b) b.addEventListener('click', () => { const v = isDark() ? 'light' : 'dark'; try { root.localStorage.setItem('so-brief-theme', v); } catch (e) { console.warn('[brief] theme not saved'); } apply(v); if (S.view === 'brief' && $('#heat')) $('#heat').innerHTML = heatSlot(); });
  }
  // Popup chat: deterministic answers from the same published data; optional rephrasing never replaces them.
  function loadChat() {
    if (root.SmartOptionsChatPopup) return;
    Promise.all(['chat-popup.css'].map(loadAsset)).then(() => loadAsset('chat-popup.js')).catch(e => {
      console.warn('[brief] chat unavailable', e.message);
      const n = doc.createElement('p'); n.className = 'cp-load-error note'; n.setAttribute('role', 'status'); n.textContent = 'Chat could not load: ' + e.message + '. Every number remains on the page.'; doc.body.appendChild(n);
    });
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot); else boot();
})(typeof window !== 'undefined' ? window : globalThis);
