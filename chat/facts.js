/* SmartOptions Brief chat: fact packs and template answers (lane CH). Pure functions over loaded data.
   answer(intent, entities, ctx) -> {intent, title, lines:[{text, refs:[ids]}], facts:[Fact], na, action, followups}
   Fact = {id, text, value, unit, period, asof, source, url, display, ticker}
   ctx = {brief, company:{T: json}, core:{T: row}, quotes:{T: quote}, universe:[[t,name,sector]], watch:[T], now:Date, page:{ticker}}
   The template answer is complete and correct on its own; a model may only rephrase it (see polish.js). */
'use strict';
(function (root, factory) {
  const M = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  root.SmartOptionsFacts = M;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const isNum = v => typeof v === 'number' && isFinite(v);
  const CARD_LABEL = {growth: 'Growth', profitability: 'Profitability', cash: 'Cash generation', resilience: 'Financial resilience',
    valuation: 'Valuation', expectations: 'Expectations', counter: 'Counterargument'};
  const CARDS = Object.keys(CARD_LABEL);
  const DIR_WORD = {up: 'rising', flat: 'flat', down: 'falling'};
  const CORE_SRC = 'SmartOptions core build (core.json)';

  /* ---------------------------------------------------------------- formatting */
  function trim(n, d) { return Number(n.toFixed(d)).toString(); }
  function money(v) {
    const a = Math.abs(v), s = v < 0 ? '-' : '';
    if (a >= 1e12) return s + '$' + trim(a / 1e12, 2) + ' trillion';
    if (a >= 1e9) return s + '$' + trim(a / 1e9, 1) + ' billion';
    if (a >= 1e6) return s + '$' + trim(a / 1e6, 1) + ' million';
    return s + '$' + a.toFixed(2);
  }
  function fmt(value, unit, label) {
    if (value == null || value === '') return 'not available';
    if (typeof value === 'string') return value;
    if (!isNum(value)) return 'not available';
    const u = String(unit || ''), signed = /change|return|growth|revision|vs|move/i.test(label || '');
    const sg = v => (signed && v > 0 ? '+' : '');
    if (/^%/.test(u)) { const d = Math.abs(value) < 1 ? 2 : 1; return sg(value) + value.toFixed(d) + '%'; }
    if (u === 'pp') return sg(value) + value.toFixed(1) + ' points';
    if (u === 'bps') return sg(value) + Math.round(value) + ' basis points';
    if (u === 'USD') return money(value);
    if (/^USD\//.test(u)) return '$' + value.toFixed(2);
    if (u === 'x') return value.toFixed(2) + ' times';
    if (u === 'analyst revisions') return String(Math.round(value));
    const d = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2;
    return trim(value, d) + (u ? ' ' + u : '');
  }

  /* ---------------------------------------------------------------- pack builder */
  function Pack() { this.facts = []; this.lines = []; this.byKey = {}; }
  // add a contract Metric (or a plain object with the same keys); returns the fact id
  Pack.prototype.add = function (m, extra) {
    if (!m) return null;
    const key = [m.label, m.value, m.period, extra && extra.ticker].join('|');
    if (this.byKey[key]) return this.byKey[key];
    const id = 'f' + (this.facts.length + 1);
    const f = Object.assign({id, text: m.label || '', value: m.value == null ? null : m.value, unit: m.unit || '', period: m.period || '',
      asof: m.asof || '', source: m.source || '', url: /^https?:\/\//.test(m.source_url || m.url || '') ? (m.source_url || m.url) : '',
      note: m.note || ''}, extra || {});
    f.display = fmt(f.value, f.unit, f.text);
    this.facts.push(f); this.byKey[key] = id;
    return id;
  };
  // Template sentences may name every supplied metric; retain all their sources.
  // The optional model prompt independently selects at most two facts.
  Pack.prototype.addAll = function (ms, n, extra) { return (ms || []).map(m => this.add(m, extra)).filter(Boolean); };
  Pack.prototype.line = function (text, refs) { if (text) this.lines.push({text: String(text).trim(), refs: (refs || []).filter(Boolean)}); return this; };
  Pack.prototype.out = function (o) { return Object.assign({lines: this.lines, facts: this.facts, na: null, action: null, followups: []}, o); };
  const NA = (intent, title, reason, followups) => ({intent, title, lines: [], facts: [], na: reason, action: null, followups: followups || []});

  /* ---------------------------------------------------------------- data helpers */
  function nameOf(t, ctx) {
    const c = ctx.company && ctx.company[t]; if (c && c.name) return c.name;
    const r = ctx.core && ctx.core[t]; if (r && r.n) return r.n;
    const u = (ctx.universe || []).find(x => x[0] === t); return u ? u[1] : t;
  }
  const who = (t, ctx) => { const n = nameOf(t, ctx); return n && n !== t ? n + ' (' + t + ')' : t; };
  function inUniverse(t, ctx) { return (ctx.universe || []).some(x => x[0] === t); }
  function company(t, ctx) { return ctx.company && ctx.company[t] || null; }
  function notCovered(intent, t, ctx) {
    if (!inUniverse(t, ctx)) return NA(intent, t, t + ' is not an S&P 500 symbol this site covers.');
    if (ctx.covered && !ctx.covered.has(t)) return NA(intent, who(t, ctx), who(t, ctx) + ' is in the S&P 500 but outside the ' + ctx.covered.size +
      ' companies this dashboard has numbers for, so there is nothing measured to show.');
    return NA(intent, who(t, ctx), 'The company file for ' + who(t, ctx) + ' could not be loaded.');
  }
  function etDate(iso) {
    if (!iso) return '';
    const dOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
    const d = new Date(dOnly ? iso + 'T12:00:00Z' : iso);
    if (isNaN(d)) return String(iso);
    try { return d.toLocaleDateString('en-US', {timeZone: dOnly ? 'UTC' : 'America/New_York', weekday: 'short', month: 'short', day: 'numeric'}); }
    catch (e) { return iso.slice(0, 10); }
  }
  const ymd = iso => String(iso || '').slice(0, 10);
  function daysUntil(dateStr, now) {
    const a = Date.parse(ymd(dateStr) + 'T00:00:00Z'), b = Date.parse(ymd((now || new Date()).toISOString()) + 'T00:00:00Z');
    return isFinite(a) && isFinite(b) ? Math.round((a - b) / 864e5) : null;
  }
  function quoteFact(P, t, ctx) {
    const q = ctx.quotes && ctx.quotes[t];
    if (q && q.status === 'ok' && isNum(q.price)) {
      const fresh = q.freshness === 'live' ? 'live' : q.freshness === 'closed' ? 'market closed' : (q.delay_minutes ? 'delayed ' + q.delay_minutes + ' min' : (q.freshness || 'delayed'));
      const p = P.add({label: t + ' last price', value: q.price, unit: 'USD/share', period: q.ts || q.asof_utc, asof: q.asof_utc || q.ts, source: q.provider, source_url: q.source_url}, {ticker: t});
      const c = isNum(q.chg_pct) ? P.add({label: t + ' change vs previous close', value: q.chg_pct, unit: '%', period: 'vs close of ' + (q.prior_close_date || 'previous session'), asof: q.asof_utc || q.ts, source: q.provider, source_url: q.source_url}, {ticker: t}) : null;
      return {p, c, fresh, ts: q.ts || q.asof_utc};
    }
    const r = ctx.core && ctx.core[t];
    if (r && isNum(r.px)) {
      const p = P.add({label: t + ' close', value: r.px, unit: 'USD/share', period: r.pxd || '', asof: r.pxd || '', source: CORE_SRC}, {ticker: t});
      const c = isNum(r.d1) ? P.add({label: t + ' one-day change', value: r.d1, unit: '%', period: 'session to ' + (r.pxd || ''), asof: r.pxd || '', source: CORE_SRC}, {ticker: t}) : null;
      return {p, c, fresh: 'last close', ts: r.pxd};
    }
    return null;
  }

  /* ---------------------------------------------------------------- glossary (hand-written, no numbers) */
  const GLOSSARY = {
    'p/e': 'Price to earnings: the share price divided by a year of earnings per share. Higher means investors pay more for each dollar of profit.',
    'forward p/e': 'The share price divided by analysts\' expected earnings for the next year, rather than the last year.',
    peg: 'P/E divided by the expected earnings growth rate. It asks whether a high P/E is backed by fast growth.',
    eps: 'Earnings per share: the company\'s profit divided by the number of shares.',
    'free cash flow': 'Cash from operations minus spending on equipment and buildings. It is the cash left to pay debt, dividends or buybacks.',
    'cash conversion': 'Free cash flow divided by net income. Near or above one means reported profit is turning into real cash.',
    'operating margin': 'Operating profit as a share of revenue. It shows how much of each sales dollar is left after running the business.',
    breadth: 'How many stocks are taking part in a move. Broad strength means most stocks rise, not just a few large ones.',
    concentration: 'How much of the index value sits in its largest companies. High concentration means a few names drive the index.',
    rotation: 'Money moving from one sector to another, so leadership changes even when the index is flat.',
    'equal weight': 'An equal-weight index gives every company the same size; the usual index weights by company value. Comparing them shows whether gains are broad.',
    'credit spread': 'The extra yield riskier company bonds pay over Treasury bonds. Widening spreads mean lenders see more risk.',
    vix: 'A measure of how much movement options traders expect in the S&P 500 over the next month. Higher readings mean more expected swings.',
    'implied volatility': 'The size of future price swings that option prices are assuming. Higher implied volatility makes options more expensive.',
    'realized volatility': 'How much a price actually moved over a recent period, measured from daily changes.',
    volatility: 'How much and how quickly a price moves up and down.',
    beta: 'How much a stock tends to move when the whole market moves. Above one means it usually moves more than the market.',
    'moving average': 'The average closing price over a set number of sessions. Price above its averages is read as an uptrend.',
    'support and resistance': 'Price levels where a stock has often stopped falling (support) or stopped rising (resistance).',
    'yield curve': 'Treasury yields across maturities. When short-term rates sit above long-term rates, the curve is inverted.',
    'basis point': 'One hundredth of a percentage point. A move from 4.00% to 4.25% is 25 basis points.',
    'debt to equity': 'Total debt divided by shareholders\' equity. Higher means the company relies more on borrowed money.',
    'interest coverage': 'Operating profit divided by interest expense. It shows how easily a company pays the interest on its debt.',
    'estimate revisions': 'How many analysts raised or cut their earnings forecasts recently. More raises than cuts is read as improving expectations.',
    'market cap': 'Share price times shares outstanding: what the market values the whole company at.',
    'covered call': 'Owning a stock and selling a call option on it. You collect a premium but give up gains above the strike price.',
    'put option': 'A contract giving the right to sell a stock at a set price before a date. Buyers use puts to protect against a fall.',
    'call option': 'A contract giving the right to buy a stock at a set price before a date.',
    options: 'Contracts that give the right to buy (call) or sell (put) a stock at a set price before a set date.',
    cpi: 'The consumer price index: the price of a typical basket of goods and services. Its yearly change is the usual inflation figure.',
    payrolls: 'The monthly count of jobs added or lost in the US, from the Labor Department\'s jobs report.',
    'fed funds rate': 'The overnight interest rate the Federal Reserve targets. It sets the base cost of borrowing in the economy.',
    heatmap: 'The S&P map on the Brief page. Each tile is a company sized by market value and colored by its price change.',
    score: 'The 0 to 100 research score on the shortlist. It adds up the seven company card ratings, the trend setup and dated signals.',
    dividend: 'Cash a company pays its shareholders, usually each quarter.',
    earnings: 'A company\'s profit for a period, reported each quarter along with revenue and guidance.'};

  /* ---------------------------------------------------------------- intents */
  const H = {};
  H.pulse = (e, ctx) => {
    const b = ctx.brief, p = b && b.pulse; if (!p) return NA('pulse', 'Market pulse', 'The market pulse is not in today\'s brief file.');
    const P = new Pack();
    P.line('Overall the market read is ' + p.status + '. ' + (p.headline || ''), []);
    (p.changed || []).slice(0, 2).forEach(x => P.line('Changed: ' + x.text, P.addAll(x.metrics, 2)));
    (p.supports || []).slice(0, 2).forEach(x => P.line('Supports: ' + x.text, P.addAll(x.metrics, 2)));
    (p.challenges || []).slice(0, 2).forEach(x => P.line('Challenges: ' + x.text, P.addAll(x.metrics, 2)));
    return P.out({intent: 'pulse', title: 'Market pulse: ' + p.status, followups: [['risks'], ['breadth'], ['macro']]});
  };
  H.macro = (e, ctx) => {
    const m = ctx.brief && ctx.brief.macro; if (!m || !m.backdrop) return NA('macro', 'Macro backdrop', 'The macro section is not in today\'s brief file.');
    const P = new Pack(), bd = m.backdrop, det = g => ((m.detail || []).find(d => d.group === g) || {}).metrics || [];
    P.line('The macro backdrop reads ' + bd.status + '. ' + (bd.line || ''), []);
    [['growth', 'Growth', ['growth', 'labor']], ['inflation', 'Inflation', ['inflation']], ['policy', 'Policy', ['policy']]].forEach(([k, lab, gs]) => {
      const d = bd[k]; if (!d) return;
      const ms = [].concat(...gs.map(det)).slice(0, 2);
      P.line(lab + ' is ' + (DIR_WORD[d.direction] || d.direction || 'unclear') + ': ' + (d.line || ''), P.addAll(ms, 2));
    });
    return P.out({intent: 'macro', title: 'Macro backdrop: ' + bd.status, followups: [['risk_conditions'], ['expand_macro'], ['risks']]});
  };
  H.risk_conditions = (e, ctx) => {
    const m = ctx.brief && ctx.brief.macro; if (!m || !m.risk) return NA('risk_conditions', 'Risk conditions', 'Risk conditions are not in today\'s brief file.');
    const P = new Pack(), det = g => ((m.detail || []).find(d => d.group === g) || {});
    P.line('Risk conditions are ' + m.risk.status + '. ' + (m.risk.line || ''), P.addAll(m.risk.metrics, 2));
    const v = det('volatility'); if (v.line) P.line('Volatility: ' + v.line, P.addAll(v.metrics, 2));
    const c = det('credit_funding'); if (c.line) P.line('Credit: ' + c.line, P.addAll(c.metrics, 2));
    return P.out({intent: 'risk_conditions', title: 'Risk conditions: ' + m.risk.status, followups: [['risks'], ['glossary', {term: 'credit spread'}], ['glossary', {term: 'vix'}]]});
  };
  H.risks = (e, ctx) => {
    const b = ctx.brief; if (!b || !Array.isArray(b.risks)) return NA('risks', 'Upcoming risks', 'Upcoming releases and earnings are not in today\'s brief file.');
    const watch = new Set(ctx.watch || []), today = ymd(b.asof_session || (ctx.now || new Date()).toISOString());
    const earnOnly = e && e.kind === 'earnings';
    let xs = b.risks.filter(r => ymd(r.when_et) >= today && (!earnOnly || r.kind === 'earnings'));
    const end = new Date(Date.parse(today + 'T00:00:00Z') + 7 * 864e5).toISOString().slice(0, 10);
    const week = xs.filter(r => ymd(r.when_et) <= end);
    if (week.length) xs = week;
    xs = xs.map(r => Object.assign({}, r, {w: (r.watchlist || (r.tickers || []).some(t => watch.has(t))) ? 1 : 0}))
      .sort((a, c) => c.w - a.w || (c.kind === 'macro') - (a.kind === 'macro') || (c.importance || 0) - (a.importance || 0) || ymd(a.when_et).localeCompare(ymd(c.when_et)));
    if (!xs.length) return NA('risks', 'Upcoming risks', 'No releases or earnings after ' + today + ' are recorded in this brief.');
    const P = new Pack();
    const nEarn = b.risks.filter(r => r.kind === 'earnings' && ymd(r.when_et) >= today && ymd(r.when_et) <= end).length;
    xs.slice(0, 5).forEach(r => P.line(etDate(r.when_et) + ': ' + r.title + (r.w ? ' (on your watchlist)' : '') + '. ' + (r.why || ''), P.addAll(r.metrics, 1)));
    if (nEarn > 5) P.line(nEarn + ' companies in the covered set report in the next seven days.', [P.add({label: 'Earnings dates in the next seven days', value: nEarn, unit: 'companies', period: today + ' to ' + end, asof: b.generated_at, source: 'Brief risk calendar (Yahoo earnings dates)'})]);
    return P.out({intent: 'risks', title: 'Upcoming risks', followups: [['risk_conditions'], ['watchlist_show']]});
  };
  H.breadth = (e, ctx) => {
    const p = ctx.brief && ctx.brief.positioning; if (!p) return NA('breadth', 'Breadth', 'Positioning is not in today\'s brief file.');
    const P = new Pack();
    if (p.breadth) P.line('Breadth is ' + p.breadth.status + '. ' + p.breadth.line, P.addAll(p.breadth.metrics, 2));
    const c = p.concentration;
    if (c) {
      P.line('Concentration: ' + c.line, P.addAll(c.metrics, 2));
      if (isNum(c.eq_vs_cap_20d_pp)) {
        const id = P.add({label: 'Equal-weight minus cap-weight return, 20 sessions', value: c.eq_vs_cap_20d_pp, unit: 'pp', period: '20 sessions to ' + (ctx.brief.asof_session || ''), asof: ctx.brief.asof_session, source: ((c.metrics || [])[0] || {}).source || 'Brief positioning'});
        P.line(c.eq_vs_cap_20d_pp >= 0 ? 'The average stock kept pace with the big names over 20 sessions.' : 'The big names did better than the average stock over 20 sessions.', [id]);
      }
    }
    return P.out({intent: 'breadth', title: 'Breadth and concentration', followups: [['sectors'], ['glossary', {term: 'breadth'}]]});
  };
  H.sectors = (e, ctx) => {
    const p = ctx.brief && ctx.brief.positioning; if (!p) return NA('sectors', 'Sectors', 'Positioning is not in today\'s brief file.');
    const P = new Pack(), src = ((p.rotation && p.rotation.metrics || [])[0] || {}).source || 'Brief positioning (cap-weighted)';
    const asof = ctx.brief.asof_session || '';
    const key = {['1D']: ['d1', 'one session'], ['1W']: ['d5', 'five sessions'], ['1M']: ['m1', 'one month']}[e.period || ''] || null;
    if (e.sector) {
      const s = (p.sectors || []).find(x => x.sector === e.sector);
      if (!s) return NA('sectors', e.sector, e.sector + ' is not in today\'s sector table.');
      const ids = [['d1', 'one session'], ['d5', 'five sessions'], ['m1', 'one month']].map(([k, w]) => isNum(s[k]) ? P.add({label: e.sector + ' change, ' + w, value: s[k], unit: '%', period: w + ' to ' + asof, asof, source: src}) : null);
      const rank = (p.sectors || []).filter(x => isNum(x.d5)).sort((a, b) => b.d5 - a.d5).findIndex(x => x.sector === e.sector) + 1;
      P.line(e.sector + ' moved ' + fmt(s.d1, '%', 'change') + ' in one session, ' + fmt(s.d5, '%', 'change') + ' over five and ' + fmt(s.m1, '%', 'change') + ' over a month.', ids);
      if (rank) P.line('That ranks ' + rank + ' of ' + (p.sectors || []).length + ' sectors over five sessions.', [ids[1],P.add({label:e.sector+' sector rank',value:rank,unit:'of '+p.sectors.length,period:'five sessions to '+asof,asof,source:src+'; descending five-session return rank'})]);
      return P.out({intent: 'sectors', title: e.sector, followups: [['show_sector', {sector: e.sector}], ['top_scores', {sector: e.sector}]]});
    }
    if (key) {
      const xs = (p.sectors || []).filter(x => isNum(x[key[0]])).sort((a, b) => b[key[0]] - a[key[0]]);
      if (!xs.length) return NA('sectors', 'Sectors', 'Sector changes for that period are not in the brief.');
      const f = x => P.add({label: x.sector + ' change, ' + key[1], value: x[key[0]], unit: '%', period: key[1] + ' to ' + asof, asof, source: src});
      const top = xs.slice(0, 3), bot = xs.slice(-2).reverse();
      P.line('Leading over ' + key[1] + ': ' + top.map(x => x.sector + ' ' + fmt(x[key[0]], '%', 'change')).join(', ') + '.', top.map(f));
      P.line('Lagging: ' + bot.map(x => x.sector + ' ' + fmt(x[key[0]], '%', 'change')).join(', ') + '.', bot.map(f));
      return P.out({intent: 'sectors', title: 'Sectors over ' + key[1], followups: [['breadth'], ['switch_period', {period: e.period}]]});
    }
    const ro = p.rotation;
    if (!ro) return NA('sectors', 'Sectors', 'Sector rotation is not in today\'s brief.');
    P.line('Rotation reads ' + ro.status + '. ' + ro.line, []);
    const f = x => P.add({label: x.sector + ' return, 20 sessions', value: x.ret_20d_pct, unit: '%', period: '20 sessions to ' + asof, asof, source: src});
    const L = (ro.leaders || []).filter(x => isNum(x.ret_20d_pct)).slice(0, 3), G = (ro.laggards || []).filter(x => isNum(x.ret_20d_pct)).slice(0, 2);
    if (L.length) P.line('Leaders over 20 sessions: ' + L.map(x => x.sector + ' ' + fmt(x.ret_20d_pct, '%', 'return')).join(', ') + '.', L.map(f));
    if (G.length) P.line('Laggards: ' + G.map(x => x.sector + ' ' + fmt(x.ret_20d_pct, '%', 'return')).join(', ') + '.', G.map(f));
    return P.out({intent: 'sectors', title: 'Sector leaders and laggards', followups: [['breadth'], ['switch_period', {period: '1W'}]]});
  };
  function scoreFact(P, n, ctx) {
    return P.add({label: n.t + ' research score', value: n.score, unit: 'of 100', period: ctx.brief.asof_session, asof: ctx.brief.generated_at, source: 'Brief shortlist score: ' + (n.score_basis || '')}, {ticker: n.t});
  }
  H.shortlist = (e, ctx) => {
    const s = ctx.brief && ctx.brief.shortlist; if (!s || !s.length) return NA('shortlist', 'Research shortlist', 'No names are on the shortlist in this brief.');
    const P = new Pack();
    const t = e.tickers && e.tickers[0];
    if (t) {
      const n = s.find(x => x.t === t);
      if (!n) return NA('shortlist', who(t, ctx), who(t, ctx) + ' is not on today\'s shortlist of ' + s.length + ' names.', [['ticker_summary', {tickers: [t]}], ['shortlist']]);
      P.line(who(t, ctx) + ' scores ' + n.score + ' of 100. ' + (n.score_basis || ''), [scoreFact(P, n, ctx)]);
      (n.why || []).slice(0, 3).forEach(w => P.line('Why: ' + w.text, P.addAll(w.metrics, 2, {ticker: t})));
      if (n.counter) P.line('Against: ' + n.counter.text, P.addAll(n.counter.metrics, 1, {ticker: t}));
      return P.out({intent: 'shortlist', title: 'Why ' + t + ' is on the shortlist', followups: [['open_ticker', {tickers: [t]}], ['ticker_card', {tickers: [t], card: 'counter'}]]});
    }
    s.slice(0, 5).forEach(n => {
      const w = (n.why || [])[0];
      P.line(who(n.t, ctx) + ', score ' + n.score + ': ' + (w ? w.text : 'no reason recorded'), [scoreFact(P, n, ctx)].concat(w ? P.addAll(w.metrics, 1, {ticker: n.t}) : []));
    });
    if (s.length > 5) P.line(s.length - 5 + ' more on the Brief page: ' + s.slice(5).map(n => n.t).join(', ') + '.', [P.add({label:'Additional shortlist names',value:s.length-5,unit:'companies',period:ctx.brief.asof_session,asof:ctx.brief.generated_at,source:'Brief shortlist count minus the five names displayed'})].concat(s.slice(5).map(n => scoreFact(P, n, ctx))));
    return P.out({intent: 'shortlist', title: 'Research shortlist', followups: [['shortlist', {tickers: [s[0].t]}], ['provenance', {term: 'score'}]]});
  };
  H.top_scores = (e, ctx) => {
    const s = (ctx.brief && ctx.brief.shortlist || []).slice().sort((a, b) => b.score - a.score);
    if (!s.length) return NA('top_scores', 'Top names by score', 'No names are scored in this brief.');
    const xs = e.sector ? s.filter(n => n.sector === e.sector) : s;
    if (!xs.length) return NA('top_scores', 'Top names by score', 'None of today\'s ' + s.length + ' scored names are in ' + e.sector + '.', [['valuation_peers', {sector: e.sector}], ['top_scores']]);
    const P = new Pack();
    P.line('Scores exist for the ' + s.length + ' shortlist names; the rest are not scored.', [P.add({label:'Scored shortlist names',value:s.length,unit:'companies',period:ctx.brief.asof_session,asof:ctx.brief.generated_at,source:'Brief shortlist count'})]);
    xs.slice(0, 5).forEach(n => P.line(who(n.t, ctx) + ': ' + n.score + ' of 100, ' + (n.sector || '') + '.', [scoreFact(P, n, ctx)]));
    return P.out({intent: 'top_scores', title: 'Top names by score' + (e.sector ? ' in ' + e.sector : ''), followups: [['shortlist'], ['provenance', {term: 'score'}]]});
  };
  H.valuation_peers = (e, ctx) => {
    const rows = Object.values(ctx.core || {}).filter(r => isNum(r.pef_sec_rel) && isNum(r.pef) && r.pef > 0 && (!e.sector || r.sec === e.sector));
    if (!rows.length) return NA('valuation_peers', 'Valuation versus peers', 'Forward P/E versus sector is not available' + (e.sector ? ' for ' + e.sector : '') + ' in this build.');
    const P = new Pack();
    rows.sort((a, b) => a.pef_sec_rel - b.pef_sec_rel);
    const fact = r => [P.add({label: r.t + ' forward P/E / sector median', value: r.pef_sec_rel, unit: 'x', period: r.pxd || '', asof: r.pxd || '', source: CORE_SRC + '; forward P/E divided by the sector median forward P/E'}, {ticker: r.t}),
      P.add({label: r.t + ' forward P/E', value: r.pef, unit: 'x', period: r.pxd || '', asof: r.pxd || '', source: CORE_SRC}, {ticker: r.t})];
    P.line('Cheapest against their own sector on forward P/E' + (e.sector ? ' in ' + e.sector : '') + ':', []);
    rows.slice(0, 4).forEach(r => P.line(who(r.t, ctx) + ': ' + fmt(r.pef_sec_rel, 'x') + ' the sector median, forward P/E ' + fmt(r.pef, 'x') + '.', fact(r)));
    P.line('Cheap can mean expected trouble; check each company\'s counterargument card.', []);
    return P.out({intent: 'valuation_peers', title: 'Valuation versus sector peers', followups: rows.slice(0, 2).map(r => ['ticker_card', {tickers: [r.t], card: 'counter'}])});
  };
  H.ticker_summary = (e, ctx) => {
    const t = e.tickers[0], c = company(t, ctx); if (!c) return notCovered('ticker_summary', t, ctx);
    const P = new Pack(), q = quoteFact(P, t, ctx);
    if (q) P.line(who(t, ctx) + ' last traded at ' + P.facts.find(f => f.id === q.p).display + (q.c ? ', ' + P.facts.find(f => f.id === q.c).display + ' on the day' : '') + ' (' + q.fresh + ').', [q.p, q.c]);
    const g = c.cards && c.cards.growth;
    P.line(c.summary || (g && g.line) || 'No summary line in the company file.', g ? P.addAll(g.metrics, 2, {ticker: t}) : []);
    const by = {strong: [], ok: [], weak: [], unavailable: []};
    CARDS.forEach(k => { const cd = c.cards && c.cards[k]; if (cd && by[cd.status]) by[cd.status].push(CARD_LABEL[k].toLowerCase()); });
    const parts = [['Strong', by.strong], ['OK', by.ok], ['Weak', by.weak]].filter(x => x[1].length).map(x => x[0] + ': ' + x[1].join(', '));
    if (parts.length) P.line(parts.join('. ') + '.', []);
    const cn = c.cards && c.cards.counter;
    if (cn && cn.line) P.line('Against: ' + cn.line, P.addAll(cn.metrics, 1, {ticker: t}));
    return P.out({intent: 'ticker_summary', title: who(t, ctx), followups: [['open_ticker', {tickers: [t]}], ['ticker_card', {tickers: [t], card: by.weak.length ? CARDS.find(k => c.cards[k] && c.cards[k].status === 'weak') : 'valuation'}], ['earnings_date', {tickers: [t]}]]});
  };
  H.ticker_card = (e, ctx) => {
    const t = e.tickers[0], c = company(t, ctx); if (!c) return notCovered('ticker_card', t, ctx);
    const k = e.card, cd = c.cards && c.cards[k];
    if (!cd) return NA('ticker_card', who(t, ctx), 'The ' + CARD_LABEL[k].toLowerCase() + ' card is missing from ' + t + '\'s company file.');
    const P = new Pack();
    if (cd.status === 'unavailable') { P.line(CARD_LABEL[k] + ' for ' + who(t, ctx) + ' is not available. ' + (cd.line || ''), P.addAll(cd.metrics, 2, {ticker: t})); }
    else {
      P.line(CARD_LABEL[k] + ' for ' + who(t, ctx) + ' rates ' + cd.status + '. ' + (cd.line || ''), P.addAll(cd.metrics, 1, {ticker: t}));
      const rest = (cd.metrics || []).slice(1, 4).filter(m => m.value != null);
      if (rest.length) P.line(rest.map(m => m.label + ' ' + fmt(m.value, m.unit, m.label)).join('; ') + '.', P.addAll(rest, 3, {ticker: t}));
      const per = (cd.metrics || [])[0];
      if (per && per.period) P.line('Period: ' + per.period + '. Source: ' + (per.source || 'not stated') + '.', [P.add(per, {ticker: t})]);
    }
    const next = CARDS.filter(x => x !== k && x !== 'counter').slice(0, 1);
    return P.out({intent: 'ticker_card', title: CARD_LABEL[k] + ': ' + t, followups: [['ticker_card', {tickers: [t], card: k === 'counter' ? 'valuation' : 'counter'}], ['open_ticker', {tickers: [t]}]].concat(next.length ? [] : [])});
  };
  H.compare = (e, ctx) => {
    const [a, b] = e.tickers, A = company(a, ctx), B = company(b, ctx);
    if (!A) return notCovered('compare', a, ctx);
    if (!B) return notCovered('compare', b, ctx);
    const P = new Pack();
    const m0 = (c, k) => ((c.cards[k] || {}).metrics || [])[0];
    const row = (k, lab) => {
      const ca = A.cards[k] || {}, cb = B.cards[k] || {}, ma = m0(A, k), mb = m0(B, k);
      const va = ma && ma.value != null ? fmt(ma.value, ma.unit, ma.label) : 'not available', vb = mb && mb.value != null ? fmt(mb.value, mb.unit, mb.label) : 'not available';
      P.line(lab + ': ' + a + ' ' + (ca.status || 'unavailable') + (ma ? ' (' + va + ')' : '') + ', ' + b + ' ' + (cb.status || 'unavailable') + (mb ? ' (' + vb + ')' : '') + '.',
        [ma && P.add(ma, {ticker: a, text: a + ' ' + (ma.label || '')}), mb && P.add(mb, {ticker: b, text: b + ' ' + (mb.label || '')})]);
    };
    row('growth', 'Growth'); row('profitability', 'Profitability'); row('valuation', 'Valuation'); row('resilience', 'Resilience');
    const strong = c => CARDS.filter(k => c.cards[k] && c.cards[k].status === 'strong').length;
    P.line(a + ' rates strong on ' + strong(A) + ' of 7 cards; ' + b + ' on ' + strong(B) + ' of 7.', [
      P.add({label: a + ' cards rated strong', value: strong(A), unit: 'of 7', period: A.asof, asof: A.asof, source: 'Company assessment file (brief.company.v1)'}, {ticker: a}),
      P.add({label: b + ' cards rated strong', value: strong(B), unit: 'of 7', period: B.asof, asof: B.asof, source: 'Company assessment file (brief.company.v1)'}, {ticker: b})]);
    return P.out({intent: 'compare', title: a + ' and ' + b, followups: [['ticker_card', {tickers: [a], card: 'counter'}], ['ticker_card', {tickers: [b], card: 'counter'}]]});
  };
  H.price = (e, ctx) => {
    const t = e.tickers[0]; if (!inUniverse(t, ctx)) return notCovered('price', t, ctx);
    const P = new Pack(), q = quoteFact(P, t, ctx);
    if (!q) return NA('price', who(t, ctx), 'No price for ' + who(t, ctx) + ' is in the quote file or the core build.');
    const pf = P.facts.find(f => f.id === q.p), cf = q.c && P.facts.find(f => f.id === q.c);
    P.line(who(t, ctx) + ': ' + pf.display + (cf ? ', ' + cf.display + ' versus the previous close' : '') + '.', [q.p, q.c]);
    P.line('Freshness: ' + q.fresh + (pf.period ? ', price time ' + pf.period : '') + '. Source: ' + pf.source + '.', [q.p]);
    return P.out({intent: 'price', title: t + ' price', followups: [['technical', {tickers: [t]}], ['open_ticker', {tickers: [t]}]]});
  };
  H.earnings_date = (e, ctx) => {
    const t = e.tickers[0], c = company(t, ctx), r = ctx.core && ctx.core[t];
    const it = c && c.events && (c.events.items || []).find(x => x.kind === 'earnings');
    const m = it && (it.metrics || [])[0];
    const P = new Pack();
    let date = m && m.value || it && it.when_et, id = null;
    if (m) id = P.add(m, {ticker: t});
    else if (r && r.er) { date = r.er; id = P.add({label: t + ' expected earnings date', value: r.er, unit: 'date', period: r.er, asof: r.pxd, source: CORE_SRC + ' (Yahoo earnings dates)'}, {ticker: t}); }
    if (!date) return c || r ? NA('earnings_date', who(t, ctx), 'No upcoming earnings date is recorded for ' + who(t, ctx) + '.') : notCovered('earnings_date', t, ctx);
    const dd = daysUntil(date, ctx.now);
    if(dd!=null&&dd>=0){const now=ctx.now||new Date();P.add({label:t+' days until expected earnings',value:dd,unit:'days',period:ymd(now.toISOString())+' to '+ymd(date),asof:now.toISOString(),source:'UTC calendar-day difference from expected earnings date'},{ticker:t});}
    P.line(who(t, ctx) + ' is expected to report on ' + etDate(ymd(date)) + ' (' + ymd(date) + ')' + (dd != null && dd >= 0 ? ', in ' + dd + ' days' : '') + '.', [id]);
    P.line((m && m.note ? m.note + '. ' : '') + 'Provider dates can move until the company confirms them.', [id]);
    return P.out({intent: 'earnings_date', title: t + ' earnings', followups: [['strategy', {tickers: [t]}], ['ticker_card', {tickers: [t], card: 'expectations'}]]});
  };
  H.strategy = (e, ctx) => {
    const t = e.tickers[0], c = company(t, ctx); if (!c) return notCovered('strategy', t, ctx);
    const P = new Pack(), r = ctx.core && ctx.core[t];
    P.line((c.options && c.options.line) || 'No options note in the company file.', []);
    if (r && isNum(r.iv)) P.line('Implied volatility is ' + fmt(r.iv, '%') + (isNum(r.rv20) ? ' against ' + fmt(r.rv20, '%') + ' realized over 20 sessions.' : '.'),
      [P.add({label: t + ' implied volatility', value: r.iv, unit: '%', period: r.pxd, asof: r.pxd, source: CORE_SRC}, {ticker: t}), isNum(r.rv20) ? P.add({label: t + ' realized volatility, 20 sessions', value: r.rv20, unit: '%', period: '20 sessions to ' + r.pxd, asof: r.pxd, source: CORE_SRC}, {ticker: t}) : null]);
    else P.line('Implied volatility for ' + t + ' is not available in this build' + (r && isNum(r.rv20) ? '; realized volatility over 20 sessions was ' + fmt(r.rv20, '%') + '.' : '.'),
      r && isNum(r.rv20) ? [P.add({label: t + ' realized volatility, 20 sessions', value: r.rv20, unit: '%', period: '20 sessions to ' + r.pxd, asof: r.pxd, source: CORE_SRC}, {ticker: t})] : []);
    const it = c.events && (c.events.items || []).find(x => x.kind === 'earnings'), m = it && (it.metrics || [])[0];
    if (m) { const dd = daysUntil(m.value, ctx.now); P.line('Earnings ' + (dd != null && dd >= 0 ? 'in ' + dd + ' days' : 'expected') + ' (' + ymd(m.value) + '); expiries after that date carry the earnings move.', [P.add(m, {ticker: t})]); }
    P.line('The Strategies tab lists candidate structures with payoffs; they are model estimates, not quotes.', []);
    return P.out({intent: 'strategy', title: 'Options considerations: ' + t, action: null, followups: [['open_ticker', {tickers: [t], tab: 'strategies'}], ['glossary', {term: 'implied volatility'}]]});
  };
  H.technical = (e, ctx) => {
    const t = e.tickers[0], c = company(t, ctx); if (!c) return notCovered('technical', t, ctx);
    const tc = c.technical; if (!tc) return NA('technical', t, 'No technical setup in ' + t + '\'s company file.');
    const P = new Pack();
    P.line('The technical setup for ' + who(t, ctx) + ' rates ' + tc.status + '. ' + (tc.line || ''), []);
    const ms = (tc.metrics || []).filter(m => m.value != null).slice(0, 4);
    if (ms.length) P.line(ms.map(m => m.label + ' ' + fmt(m.value, m.unit, m.label)).join('; ') + '.', P.addAll(ms, 4, {ticker: t}));
    return P.out({intent: 'technical', title: 'Technical setup: ' + t, followups: [['open_ticker', {tickers: [t]}], ['glossary', {term: 'moving average'}]]});
  };
  H.glossary = (e, ctx) => {
    const d = GLOSSARY[e.term];
    if (!d) return NA('glossary', e.term || 'Term', 'There is no plain-English entry for "' + (e.term || '') + '" yet.', [['help']]);
    const P = new Pack(); P.line(d, []);
    return P.out({intent: 'glossary', title: e.term.replace(/^./, c => c.toUpperCase())});
  };
  H.freshness = (e, ctx) => {
    const h = ctx.brief && ctx.brief.health; if (!h) return NA('freshness', 'Data freshness', 'The data-health block is not in today\'s brief file.');
    const P = new Pack();
    P.line('Overall freshness: ' + h.overall + '. ' + (h.line || ''), []);
    const src = h.sources || [];
    const fresh = src.filter(s => s.status === 'fresh'), old = src.filter(s => s.status !== 'fresh');
    if (fresh.length) P.line(fresh.length + ' of ' + src.length + ' inputs are fresh, including ' + fresh.slice(0, 3).map(s => s.label).join(', ') + '.', [P.add({label:'Fresh brief inputs',value:fresh.length,unit:'of '+src.length,period:ctx.brief.asof_session,asof:ctx.brief.generated_at,source:'Brief health source status count'})]);
    old.slice(0, 3).forEach(s => P.line(s.label + ' is ' + s.status + (s.asof ? ', as of ' + ymd(s.asof) : '') + '. ' + (s.note || ''),
      isNum(s.age_hours) ? [P.add({label: s.label + ' age', value: s.age_hours, unit: 'hours', period: 'at ' + ymd(ctx.brief.generated_at), asof: s.asof, source: 'Brief data-health block'})] : []));
    const q = ctx.quotesMeta;
    if (q && q.generated_at) P.line('Prices were refreshed at ' + q.generated_at.slice(11, 16) + ' UTC on ' + ymd(q.generated_at) + '; market ' + (q.session || 'state not stated') + '. Each price shows its own delay.',
      [P.add({label: 'Quote file refreshed', value: q.generated_at, unit: 'UTC time', period: ymd(q.generated_at), asof: q.generated_at, source: q.source || 'quotes.json'})]);
    if (h.screener) P.line(h.screener.label + ' are ' + h.screener.status + '. ' + (h.screener.note || ''), []);
    return P.out({intent: 'freshness', title: 'Data freshness: ' + h.overall, followups: [['provenance']]});
  };
  H.provenance = (e, ctx) => {
    const P = new Pack();
    const t = e.tickers && e.tickers[0];
    if (t && e.card) {
      const c = company(t, ctx); if (!c) return notCovered('provenance', t, ctx);
      const cd = c.cards[e.card] || {};
      (cd.metrics || []).slice(0, 3).forEach(m => P.line(m.label + ': ' + (m.source || 'source not stated') + ', ' + (m.period || 'period not stated') + '.', [P.add(m, {ticker: t})]));
      if (!P.lines.length) return NA('provenance', t, 'The ' + e.card + ' card for ' + t + ' has no metrics recorded.');
      return P.out({intent: 'provenance', title: 'Sources: ' + t + ' ' + CARD_LABEL[e.card].toLowerCase()});
    }
    if (e.term === 'score' || /score/.test(e.q || '')) {
      const n = (ctx.brief && ctx.brief.shortlist || [])[0];
      P.line('The research score is 0 to 100. ' + (n && n.score_basis ? n.score_basis : ''), []);
      P.line('It is built in code from the measured card ratings; no model writes it.', []);
      return P.out({intent: 'provenance', title: 'How the score is built', followups: [['shortlist'], ['top_scores']]});
    }
    P.line('Every number on the site carries its source and period; open a card\'s numbers to see them.', []);
    const src = (ctx.brief && ctx.brief.health && ctx.brief.health.sources || []).slice(0, 4);
    if (src.length) P.line('Main inputs: ' + src.map(s => s.label).join(', ') + '.', []);
    P.line('Prices come from Finnhub, Alpaca and Yahoo Finance; macro series from FRED.', []);
    return P.out({intent: 'provenance', title: 'Where the numbers come from', followups: [['freshness']]});
  };
  H.help = () => {
    const P = new Pack();
    P.line('Market: what changed, what could move markets this week, breadth, sectors, macro and risk conditions.', []);
    P.line('Companies: a summary, one card such as valuation or debt, a comparison, price, earnings date, technical setup and options notes.', []);
    P.line('Actions: open a company, add or remove watchlist names, highlight a sector, switch the map period, filter the table.', []);
    P.line('Terms: ask what a word like P/E or breadth means.', []);
    return P.out({intent: 'help', title: 'What I can answer', followups: [['pulse'], ['risks'], ['shortlist']]});
  };
  H.watchlist_show = (e, ctx) => {
    const w = ctx.watch || [];
    if (!w.length) return NA('watchlist_show', 'Your watchlist', 'Your watchlist is empty. Ask "add AAPL to my watchlist" to start one.');
    const P = new Pack();
    P.line('Your watchlist has ' + w.length + ' names: ' + w.slice(0, 12).join(', ') + (w.length > 12 ? ' and more' : '') + '.', []);
    const moves = w.map(t => ({t, q: ctx.quotes && ctx.quotes[t]})).filter(x => x.q && x.q.status === 'ok' && isNum(x.q.chg_pct)).sort((a, b) => Math.abs(b.q.chg_pct) - Math.abs(a.q.chg_pct)).slice(0, 3);
    if (moves.length) P.line('Biggest moves: ' + moves.map(x => x.t + ' ' + fmt(x.q.chg_pct, '%', 'change')).join(', ') + '.', moves.map(x => quoteFact(P, x.t, ctx)).map(q => q && q.c));
    const watch = new Set(w), soon = (ctx.brief && ctx.brief.risks || []).filter(r => r.kind === 'earnings' && (r.tickers || []).some(t => watch.has(t)) && daysUntil(r.when_et, ctx.now) >= 0).slice(0, 3);
    if (soon.length) P.line('Reporting soon: ' + soon.map(r => r.tickers[0] + ' ' + etDate(r.when_et)).join(', ') + '.', soon.map(r => P.add((r.metrics || [])[0], {ticker: r.tickers[0]})));
    return P.out({intent: 'watchlist_show', title: 'Your watchlist'});
  };

  /* ---------------------------------------------------------------- actions (executed by the popup) */
  const ACT = {
    open_ticker: (e, ctx) => {
      const t = e.tickers[0];
      if (!inUniverse(t, ctx)) return notCovered('open_ticker', t, ctx);
      if (ctx.covered && !ctx.covered.has(t)) return notCovered('open_ticker', t, ctx);
      return {title: 'Open ' + t, action: {kind: 'open_ticker', ticker: t, tab: e.tab || null}, text: 'Opening ' + who(t, ctx) + (e.tab === 'strategies' ? ' on the Strategies tab.' : '.')};
    },
    show_sector: e => ({title: e.sector, action: {kind: 'show_sector', sector: e.sector}, text: 'Highlighting ' + e.sector + ' on the S&P map.'}),
    watch_add: (e, ctx) => { const t = e.tickers[0]; if (!inUniverse(t, ctx)) return notCovered('watch_add', t, ctx); return {title: 'Watchlist', action: {kind: 'watch_add', ticker: t}, text: 'Adding ' + who(t, ctx) + ' to your watchlist.'}; },
    watch_remove: (e, ctx) => ({title: 'Watchlist', action: {kind: 'watch_remove', ticker: e.tickers[0]}, text: 'Removing ' + who(e.tickers[0], ctx) + ' from your watchlist.'}),
    sort_filter: e => ({title: 'Table', action: {kind: 'sort_filter', sector: e.sector || null, sort: e.sort || null}, text: (e.sector ? 'Filtering the research table to ' + e.sector : 'Opening the research table') + (e.sort ? ', sorted by ' + e.sort : '') + '.'}),
    switch_period: e => ({title: 'Map period', action: {kind: 'switch_period', period: e.period}, text: 'Switching the S&P map to ' + e.period + '.'}),
    expand_macro: () => ({title: 'Macro detail', action: {kind: 'expand_macro'}, text: 'Opening the detailed macro observations.'}),
  };

  /* ---------------------------------------------------------------- entry points */
  // tickers whose company files must be loaded before answer() runs
  function needs(intent, e) {
    if (['ticker_summary', 'ticker_card', 'compare', 'earnings_date', 'strategy', 'technical', 'provenance', 'open_ticker'].includes(intent)) return (e.tickers || []).slice(0, 2);
    return [];
  }
  function needsCore(intent) { return ['valuation_peers', 'price', 'earnings_date', 'strategy', 'watchlist_show', 'ticker_summary'].includes(intent); }
  function answer(intent, e, ctx) {
    e = Object.assign({tickers: []}, e || {});
    ctx = ctx || {};
    let r;
    try {
      if (ACT[intent]) {
        const a = ACT[intent](e, ctx);
        if (a.na) return a;
        r = {intent, title: a.title, lines: [{text: a.text, refs: []}], facts: [], na: null, action: a.action, followups: []};
      } else if (H[intent]) r = H[intent](e, ctx);
      else return NA('unknown', 'Not sure', 'I could not match that question to something on this site.', []);
    } catch (err) {
      return NA(intent, 'Not available', 'The answer could not be built from the loaded data (' + String(err && err.message || err) + ').');
    }
    r.intent = intent;
    r.followups = (r.followups || []).filter(Boolean).map(([id, ent]) => ({intent: id, entities: Object.assign({tickers: []}, ent || {})}));
    return r;
  }
  // plain text for the model prompt and for tests
  function asText(r) { return r.na ? 'Not available: ' + r.na : r.lines.map(l => l.text).join('\n'); }
  return {answer, needs, needsCore, asText, fmt, GLOSSARY, CARD_LABEL, Pack};
});
