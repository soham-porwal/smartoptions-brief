/* SmartOptions Brief: impact language (lane CV).
   Two visual channels that never share a color:
   - category: what a reading is about (muted identity hue, dot + left border, same hue everywhere)
   - impact: whether it helps or hurts the thing being read (green/red/amber/grey underline, always icon + word)
   Plus a glossary of plain "what it means" lines, the "Driven by" row and the company macro-sensitivity row.
   Pure parts are exported for node tests; the browser part binds tooltips, the Key popover and driver clicks. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SmartOptionsImpact = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  /* ---------------------------------------------------------------- categories */
  // hues avoid the green/red/amber reserved for impact; light values sit on white cards, dark on #1d2220
  const CATS = {
    growth:        {label: 'Growth',        scope: 'company', light: '#2f63a8', dark: '#7aa7e0', means: 'How fast sales and earnings per share are rising against a year earlier.'},
    profitability: {label: 'Profitability', scope: 'company', light: '#7150a6', dark: '#b39ae0', means: 'How much of each sales dollar is kept as operating profit.'},
    cash:          {label: 'Cash',          scope: 'company', light: '#1d7a86', dark: '#5cc0cc', means: 'Cash the business actually generates after paying for investment.'},
    resilience:    {label: 'Resilience',    scope: 'company', light: '#55657a', dark: '#a3b1c4', means: 'Debt load, short-term liquidity and the ability to pay interest.'},
    valuation:     {label: 'Valuation',     scope: 'company', light: '#9a4a78', dark: '#e092c0', means: 'What the price pays for earnings, against peers and its own past.'},
    expectations:  {label: 'Expectations',  scope: 'company', light: '#80612a', dark: '#d2b27a', means: 'Whether analysts are raising or cutting their earnings estimates.'},
    rates:         {label: 'Rates',         scope: 'macro',   light: '#3b55b5', dark: '#93a6ee', means: 'Treasury yields and the yield curve; the price of borrowing money.'},
    inflation:     {label: 'Inflation',     scope: 'macro',   light: '#a44f2c', dark: '#e59b7a', means: 'How fast consumer and producer prices are rising.'},
    labor:         {label: 'Labor',         scope: 'macro',   light: '#2f6f93', dark: '#79b4d6', means: 'Jobs, unemployment and wages.'},
    macro_growth:  {label: 'Growth',        scope: 'macro',   light: '#2f63a8', dark: '#7aa7e0', means: 'Output of the whole economy, measured by GDP.'},
    policy:        {label: 'Policy',        scope: 'macro',   light: '#5d3f8f', dark: '#a98fd8', means: 'Federal Reserve rate decisions and balance-sheet actions.'},
    credit:        {label: 'Credit',        scope: 'macro',   light: '#7a5640', dark: '#c9a38a', means: 'Extra yield lenders demand from riskier companies.'},
    volatility:    {label: 'Volatility',    scope: 'macro',   light: '#a03d74', dark: '#e889bd', means: 'How much prices are expected to swing; the market\'s fear gauge.'},
    breadth:       {label: 'Breadth',       scope: 'macro',   light: '#16757c', dark: '#5cc4c9', means: 'How many stocks and sectors are taking part in the move.'},
    events:        {label: 'Events',        scope: 'both',    light: '#6a5d8c', dark: '#b2a6d6', means: 'Scheduled earnings and data releases that can move prices.'},
    momentum:      {label: 'Momentum',      scope: 'both',    light: '#3d6670', dark: '#93bcc6', means: 'Direction of price against its own recent averages.'},
    cross_asset:   {label: 'Dollar and oil',scope: 'macro',   light: '#6b6150', dark: '#beb39f', means: 'The US dollar and crude oil, which shift costs and overseas earnings.'},
  };
  const CARD_CAT = {growth: 'growth', profitability: 'profitability', cash: 'cash', resilience: 'resilience', valuation: 'valuation', expectations: 'expectations'};
  const SECTORS = ['Communication Services', 'Consumer Discretionary', 'Consumer Staples', 'Energy', 'Financials', 'Health Care', 'Industrials', 'Information Technology', 'Materials', 'Real Estate', 'Utilities'];

  // metric label -> category. Order matters: first match wins. Unknown labels get no tag.
  const LOOKUP = [
    [/coverage$/i, null],                                   // "Coverage", "Assessment coverage", "Sector snapshot coverage": bookkeeping, not a driver
    [/earnings date|scheduled release|next fomc|macro releases/i, 'events'],
    [/eps revisions|estimate revision/i, 'expectations'],
    [/revenue|eps growth|sales growth/i, 'growth'],
    [/operating margin|return on average|gross margin/i, 'profitability'],
    [/free cash flow|fcf/i, 'cash'],
    [/debt|current assets|interest|ebit \//i, 'resilience'],
    [/p\/e|peg|valuation vs/i, 'valuation'],
    [/federal funds|federal reserve|reserve balances/i, 'policy'],
    [/treasury|spread$|financing rate|10-year|2-year|3-month/i, 'rates'],
    [/cpi|pce|ppi|inflation/i, 'inflation'],
    [/payroll|unemployment|claims|labor force|hourly earnings/i, 'labor'],
    [/gdp/i, 'macro_growth'],
    [/oas|high yield|credit/i, 'credit'],
    [/vix|volatility/i, 'volatility'],
    [/dxy|wti|brent|dollar|crude/i, 'cross_asset'],
    [/above \d+-session|new 252|rsp minus spy|top-ten|market-cap share|breadth/i, 'breadth'],
    [/spy|session average|regression slope|^close$|rsi|support|resistance/i, 'momentum'],
  ];
  function catOf(label) {
    const s = String(label || '').trim();
    if (!s) return null;
    if (SECTORS.includes(s)) return 'breadth';           // rotation rows are sector returns
    for (const [re, k] of LOOKUP) if (re.test(s)) return k;
    return null;
  }

  /* ---------------------------------------------------------------- impact */
  const IMPACT = {
    helps:   {word: 'helps',   icon: '&#9650;', cls: 'helps'},
    hurts:   {word: 'hurts',   icon: '&#9660;', cls: 'hurts'},
    mixed:   {word: 'mixed',   icon: '&#9670;', cls: 'mixed'},
    neutral: {word: 'neutral', icon: '&#8211;', cls: 'neutral'},
    none:    {word: 'no read', icon: '&#9675;', cls: 'none'},
  };
  // status / tone word -> impact on the thing being read
  const IMPACT_OF = {
    good: 'helps', supportive: 'helps', broadening: 'helps', calm: 'helps', strong: 'helps',
    bad: 'hurts', adverse: 'hurts', narrowing: 'hurts', stressed: 'hurts', weak: 'hurts',
    mixed: 'mixed', elevated: 'mixed',
    ok: 'neutral', neutral: 'neutral',
    unavailable: 'none', none: 'none'};
  function impactOf(word) { return IMPACT_OF[String(word || '').toLowerCase()] || 'none'; }
  function merge(a, b) {
    if (!a) return b; if (!b || a === b) return a;
    if (a === 'none') return b; if (b === 'none') return a;
    if (a === 'neutral') return b; if (b === 'neutral') return a;
    return 'mixed';
  }

  /* ---------------------------------------------------------------- glossary: <=20 words, what it is + which way is good */
  const GLOSSARY = [
    ['10-year Treasury yield', /treasury 10-year|10y yield|us10y/i, 'Ten-year government borrowing rate. Falling yields usually help stocks by making future profits worth more.'],
    ['2-year Treasury yield', /treasury 2-year/i, 'Two-year government rate; tracks where the Fed is expected to set rates. Falling is easier for stocks.'],
    ['3-month Treasury yield', /treasury 3-month/i, 'Short-term government rate, close to the Fed\'s policy rate. Lower means cheaper money.'],
    ['Yield curve', /minus 2-year|minus 3-month|yield curve|curve/i, 'Long rates minus short rates. A positive, steepening curve usually signals growth ahead; inverted warns of slowdown.'],
    ['Fed funds rate', /federal funds|fed funds/i, 'The Fed\'s overnight policy rate. Cuts usually support stocks; hikes tighten money.'],
    ['FOMC meeting', /fomc/i, 'The Fed\'s rate-setting meeting. Surprises in the decision or tone can move every asset.'],
    ['Fed balance sheet', /federal reserve total assets|reserve balances/i, 'Assets the Fed holds. Growing adds cash to markets; shrinking drains it.'],
    ['SOFR', /financing rate|sofr/i, 'Overnight rate banks pay to borrow against Treasuries. Spikes signal funding strain.'],
    ['CPI', /cpi all items|^cpi\b/i, 'Consumer price inflation. Cooler readings help stocks because they allow lower rates.'],
    ['Core CPI', /cpi excluding food/i, 'CPI without food and energy; the Fed\'s cleaner read on inflation. Cooler is better for stocks.'],
    ['PCE inflation', /pce/i, 'The Fed\'s preferred inflation gauge. Slower pace leaves room for rate cuts.'],
    ['PPI', /ppi/i, 'Prices producers receive. Rising PPI can squeeze margins or feed later consumer inflation.'],
    ['Nonfarm payrolls', /payroll/i, 'Jobs added each month. Steady gains support spending; very hot numbers can push rates up.'],
    ['Unemployment rate', /unemployment rate/i, 'Share of the labor force without work. A rising rate warns of slowing demand.'],
    ['Jobless claims', /claims/i, 'Weekly new unemployment filings. Rising claims are an early sign of layoffs.'],
    ['Labor participation', /labor force participation/i, 'Share of adults working or looking. Higher eases wage pressure.'],
    ['Wage growth', /hourly earnings/i, 'Pay growth. Moderate helps spending; too fast feeds inflation and higher rates.'],
    ['GDP growth', /gdp/i, 'Growth of the whole economy. Faster growth usually lifts company sales and profits.'],
    ['High-yield spread', /oas|high yield/i, 'Extra yield on risky corporate bonds. Widening means lenders are nervous, which usually hurts stocks.'],
    ['VIX', /^vix close|vix percentile|^vix$/i, 'Expected S&P 500 swings over 30 days. Low and steady is calm; spikes mean fear.'],
    ['VIX term structure', /vix\s*\/\s*vix3m|vix3m|vix9d/i, 'Near-term against longer-term expected volatility. Near above longer signals stress right now.'],
    ['Dollar index (DXY)', /dxy|dollar/i, 'The dollar against major currencies. A stronger dollar trims overseas earnings of US companies.'],
    ['Crude oil', /wti|brent|crude|oil/i, 'Oil price. Higher oil helps energy producers but raises costs and inflation for most others.'],
    ['Breadth', /above \d+-session|^breadth$/i, 'Share of stocks above their averages. Broad participation makes a rally sturdier.'],
    ['New highs and lows', /new 252/i, 'Stocks at one-year highs versus lows. More highs than lows is a healthy sign.'],
    ['Concentration', /top-ten|market-cap share|concentration/i, 'How much the largest ten names drive the index. High concentration makes the index fragile.'],
    ['Equal weight vs cap weight', /rsp minus spy/i, 'Average stock versus the big-cap index. Positive means gains are spreading beyond the giants.'],
    ['Sector rotation', /^rotation$/i, 'Money moving between sectors. Defensive leadership often signals caution; cyclical leadership signals confidence.'],
    ['Moving average', /session average/i, 'Average price over a window. Price above its averages means the trend is up.'],
    ['Trend slope', /regression slope/i, 'Steepness of the recent price trend. Positive and steady is supportive.'],
    ['Revenue growth', /revenue.*growth|revenue growth/i, 'Sales against a year earlier. Faster, steady growth is the base of rising earnings.'],
    ['Revenue', /^revenue ttm$/i, 'Total sales over the last twelve months.'],
    ['EPS growth', /eps growth/i, 'Earnings per share against a year earlier. Rising EPS is what usually lifts a share price.'],
    ['Operating margin', /operating margin$/i, 'Operating profit per dollar of sales. Higher and widening shows pricing power and cost control.'],
    ['Margin change', /operating margin change/i, 'Change in operating margin over a year. Widening is good; narrowing warns of pressure.'],
    ['Return on assets', /return on average assets/i, 'Profit per dollar of assets; the key bank profitability measure. Above about 1% is solid.'],
    ['Return on equity', /return on average equity/i, 'Profit per dollar of shareholder capital. Higher means capital is used well.'],
    ['Free cash flow', /free cash flow/i, 'Cash left after running and investing in the business. Positive and growing funds buybacks and dividends.'],
    ['Cash conversion', /fcf \/ net income|cash conversion/i, 'Free cash flow divided by net income. Near or above 1 means profits are real cash.'],
    ['Net debt / EBITDA', /net debt/i, 'Years of operating earnings needed to repay debt. Below 2 is comfortable; above 4 is heavy.'],
    ['Debt / equity', /debt \/ equity/i, 'Borrowing against shareholder capital. Lower means less financial risk.'],
    ['Current ratio', /current assets/i, 'Short-term assets against short-term bills. Above 1 means near-term bills are covered.'],
    ['Interest coverage', /interest/i, 'Operating profit divided by interest cost. Higher means debt is easy to service; below 3 is thin.'],
    ['P/E vs sector', /p\/e \/ sector/i, 'P/E divided by the sector median. Above 1 is pricier than peers; below 1 is cheaper.'],
    ['P/E ratio',/^trailing p\/e$|sector trailing p\/e/i, 'Price divided by the last year of earnings. Higher means investors pay more per dollar of profit.'],
    ['Forward P/E', /forward p\/e/i, 'Price divided by next year\'s expected earnings. Lower than peers can mean better value.'],
    ['Valuation vs own history', /valuation vs own history/i, 'Current valuation against the stock\'s own past range. Above 1 is pricier than usual.'],
    ['PEG ratio', /peg/i, 'P/E divided by growth rate. Around 1 is fair; well above 1 means paying up for growth.'],
    ['Estimate revisions', /revisions/i, 'Analysts raising or cutting forecasts. More raises than cuts usually supports the price.'],
    ['Earnings date', /earnings date/i, 'When results are due. Prices can gap sharply on the day.'],
    ['Beta', /^beta/i, 'How much the stock moves with the market. Above 1 amplifies market moves both ways.'],
    ['RSI', /\brsi\b/i, 'Momentum gauge from 0 to 100. Above 70 looks stretched; below 30 looks washed out.'],
    ['Support', /^support/i, 'Price level where buying has stopped past declines. A break below is a warning.'],
    ['Resistance', /^resistance/i, 'Price level where selling has capped past rallies. A clean break above is constructive.'],
    ['Implied volatility', /implied vol|\biv\b/i, 'Option market\'s expected move. High IV makes options expensive and signals uncertainty.'],
    ['Close', /^close$|spy close/i, 'Last traded price at the end of the session.'],
    ['Session change', /spy previous-session change/i, 'Price change since the previous session. A positive value describes a rise, not a forecast.'],
    ['Scheduled events', /major macro releases|scheduled release/i, 'Upcoming economic releases. Their effects depend on the result relative to expectations.'],
    ['Sector return', /^(Communication Services|Consumer Discretionary|Consumer Staples|Energy|Financials|Health Care|Industrials|Information Technology|Materials|Real Estate|Utilities)$/i,
      'Price return for this sector over the stated window. Compare the same window across sectors.'],
  ];
  function meansFor(label) {
    const s = String(label || '').trim(); if (!s) return null;
    for (const [term, re, line] of GLOSSARY) if (term.toLowerCase() === s.toLowerCase() || re.test(s)) return {term, line};
    return null;
  }

  /* ---------------------------------------------------------------- drivers: what is impacting what */
  // items: [{metrics:[Metric], tone|status}] -> [{cat, impact, labels}] in first-seen order; unknown labels are dropped
  function drivers(items) {
    const out = new Map();
    for (const it of items || []) {
      if (!it) continue;
      const imp = impactOf(it.tone || it.status);
      for (const m of it.metrics || []) {
        const c = m && catOf(m.label); if (!c) continue;
        const e = out.get(c) || {cat: c, impact: null, labels: []};
        e.impact = merge(e.impact, imp);
        if (!e.labels.includes(m.label)) e.labels.push(m.label);
        out.set(c, e);
      }
      if (it.cat && CATS[it.cat]) {
        const e = out.get(it.cat) || {cat: it.cat, impact: null, labels: []};
        e.impact = merge(e.impact, imp); out.set(it.cat, e);
      }
    }
    return [...out.values()].map(e => Object.assign(e, {impact: e.impact || 'none'}));
  }
  // company status map {growth:'strong',...} -> drivers, strongest reads first
  function statusDrivers(status) {
    const rank = {hurts: 0, helps: 1, mixed: 2, neutral: 3, none: 4};
    return Object.keys(CARD_CAT).filter(k => status && status[k]).map(k => ({cat: CARD_CAT[k], impact: impactOf(status[k]), labels: []}))
      .sort((a, b) => rank[a.impact] - rank[b.impact]);
  }

  /* ---------------------------------------------------------------- macro sensitivities (company page) */
  const FACTORS = [
    {k: 'us10y_bps', name: 'Rates', cat: 'rates', series: 'us10y', unit: 'bp', per: '1 bp rise in the 10-year yield', up: 'yields rise', dn: 'yields fall'},
    {k: 'dxy', name: 'Dollar', cat: 'cross_asset', series: 'dxy', unit: '%', per: '1% rise in the dollar index', up: 'the dollar rises', dn: 'the dollar falls'},
    {k: 'wti', name: 'Oil', cat: 'cross_asset', series: 'wti', unit: '%', per: '1% rise in WTI crude', up: 'oil rises', dn: 'oil falls'},
    {k: 'vix', name: 'Volatility', cat: 'volatility', series: 'vix', unit: 'pt', per: '1 point rise in the VIX', up: 'the VIX rises', dn: 'the VIX falls'},
  ];
  // recent 20-observation change of a factor from core.macro groups (bounded: last 21 points only)
  function factorMove(macro, id) {
    if (!macro || typeof macro !== 'object') return null;
    for (const xs of Object.values(macro)) {
      if (!Array.isArray(xs)) continue;
      const x = xs.find(o => o && o.id === id);
      if (!x || !Array.isArray(x.h) || x.h.length < 21) continue;
      const a = x.h[x.h.length - 21], b = x.h[x.h.length - 1];
      if (!a || !b || typeof a[1] !== 'number' || typeof b[1] !== 'number' || !isFinite(a[1]) || !isFinite(b[1]) || !a[1]) return null;
      const chg = id === 'us10y' ? (b[1] - a[1]) * 100 : id === 'vix' ? b[1] - a[1] : (b[1] / a[1] - 1) * 100;
      return {chg, from: a[0], to: b[0], unit: id === 'us10y' ? 'bp' : id === 'vix' ? 'pt' : '%', source: x.provider || 'core.json macro', label: x.label};
    }
    return null;
  }
  function sensitivities(row, macro, window) {
    const rel = row && row.rel;
    if (!rel || !rel.c || !rel.t) return {ok: false, reason: 'no factor regression for this name in this build', items: []};
    if (!(rel.n >= 120)) return {ok: false, reason: `only ${rel.n || 0} common sessions; at least 120 are needed for a stable read`, items: []};
    const items = FACTORS.map(f => {
      const c = rel.c[f.k], t = rel.t[f.k];
      if (typeof c !== 'number' || typeof t !== 'number' || !isFinite(c) || !isFinite(t)) return {f, strength: 'none', impact: 'none', line: 'Not available: no coefficient for this factor.'};
      const at = Math.abs(t);
      const strength = at >= 2 ? 'clear' : at >= 1 ? 'weak' : 'none';
      const mv = factorMove(macro, f.series);
      let impact = 'none', trend = null;
      if (mv && Math.abs(mv.chg) > 1e-9) trend = {dir: mv.chg > 0 ? 'up' : 'down', window: '20d', chg: mv.chg, unit: mv.unit, from: mv.from, to: mv.to, source: mv.source};
      if (strength !== 'none' && trend) impact = Math.sign(c) * Math.sign(trend.chg) > 0 ? 'helps' : 'hurts';
      const line = strength === 'none' ? `No reliable link to ${f.name.toLowerCase()} over the window.`
        : `${strength === 'clear' ? 'Tends to' : 'Leans to'} ${c > 0 ? 'rise' : 'fall'} when ${f.up}.`;
      return {f, coef: c, t, strength, impact, trend, line,
        metric: {label: `Move per ${f.per}`, value: Number(c.toFixed(4)), unit: '%', period: window || rel.window || `${rel.n} sessions`, source: 'OLS on daily returns, core.json rel', note: `t-stat ${t.toFixed(2)}; fit R2 ${typeof rel.r2 === 'number' ? rel.r2.toFixed(2) : 'n/a'}`}};
    });
    const weakFit = typeof rel.r2 === 'number' && rel.r2 < 0.05;
    return {ok: true, weakFit, r2: rel.r2, n: rel.n, items};
  }

  /* ---------------------------------------------------------------- contrast math (WCAG 2.x) */
  function lum(hex) {
    const h = String(hex).replace('#', ''); const v = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
    const ch = [0, 2, 4].map(i => parseInt(v.slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }
  function contrast(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

  /* ---------------------------------------------------------------- HTML builders (strings; safe to call in node) */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  // category tag: dot + label, left border in the category hue; data-means gives the hover line
  function tag(cat, opt) {
    const c = CATS[cat]; if (!c) return '';
    opt = opt || {};
    const imp = opt.impact ? IMPACT[opt.impact] || IMPACT.none : null;
    const means = c.means + (imp ? ` Here it ${imp.word === 'no read' ? 'gives no clear read' : imp.word}${opt.what ? ' ' + opt.what : ''}.` : '');
    const go = opt.go ? ` data-imp-go="${esc(opt.go)}"` : '';
    const el = opt.go ? 'button type="button"' : 'span tabindex="0"';
    const end = opt.go ? 'button' : 'span';
    return `<${el} class="imp-tag ic-${cat}${imp ? ' im-' + imp.cls : ''}" data-means="${esc(means)}"${go}><i class="imp-dot" aria-hidden="true"></i><span class="imp-cl">${esc(c.label)}</span>${imp ? `<span class="imp-mk" aria-label="${esc(imp.word)}"><b aria-hidden="true">${imp.icon}</b><span class="imp-w">${esc(imp.word)}</span></span>` : ''}</${end}>`;
  }
  // impact mark on any text: underline style carries the impact, icon + word always present
  function mark(impact, text, means) {
    const imp = IMPACT[impact] || IMPACT.none;
    return `<span class="imp-u im-${imp.cls}"${means ? ` tabindex="0" data-means="${esc(means)}"` : ''}>${text != null ? esc(text) + ' ' : ''}<b aria-hidden="true">${imp.icon}</b><span class="imp-w">${esc(imp.word)}</span></span>`;
  }
  // direction box: arrow + word + window ("up, 3m")
  function trend(dir, win, means) {
    const d = dir === 'up' || dir === 'rising' ? 'up' : dir === 'down' || dir === 'falling' ? 'down' : dir === 'flat' || dir === 'steady' ? 'flat' : null;
    if (!d) return `<span class="imp-tr tr-na">not available</span>`;
    const a = {up: '&#8599;', down: '&#8600;', flat: '&#8594;'}[d];
    return `<span class="imp-tr tr-${d}"${means ? ` tabindex="0" data-means="${esc(means)}"` : ''}><b aria-hidden="true">${a}</b>${d}${win ? ', ' + esc(win) : ''}</span>`;
  }
  // metric label with its glossary line attached, when one exists
  function term(label) {
    const g = meansFor(label);
    return g ? `<span class="imp-term" tabindex="0" data-means="${esc(g.line)}">${esc(label)}</span>` : esc(label);
  }
  // "Driven by" row; goFor(cat) may return a selector or href target for the click
  function drivenBy(list, opt) {
    opt = opt || {};
    const xs = (list || []).filter(d => d && CATS[d.cat]);
    if (!xs.length) return '';
    return `<div class="imp-by"><span class="imp-by-k">${esc(opt.label || 'Driven by')}</span><span class="imp-by-v">${xs.slice(0, opt.max || 6).map(d => tag(d.cat, {impact: d.impact, go: opt.goFor ? opt.goFor(d.cat) : null, what: opt.what})).join('')}</span></div>`;
  }
  function keyHtml() {
    const row = k => `<li>${tag(k)}<span>${esc(CATS[k].means)}</span></li>`;
    const comp = Object.keys(CATS).filter(k => CATS[k].scope === 'company');
    const mac = Object.keys(CATS).filter(k => CATS[k].scope !== 'company');
    return `<div class="imp-key-in"><h3>How to read the tags</h3>
      <p class="imp-key-p">The colored dot says what a reading is about. The mark after it says whether it helps or hurts the thing being judged, not whether the number went up.</p>
      <ul class="imp-key-marks">${['helps', 'hurts', 'mixed', 'neutral', 'none'].map(k => `<li>${mark(k)}<span>${{helps: 'Supports the verdict above it.', hurts: 'Works against it.', mixed: 'Pulls both ways.', neutral: 'Within a normal range.', none: 'Not enough data for a read.'}[k]}</span></li>`).join('')}
        <li>${trend('up', '20d')}<span>Direction of the measure itself and its window.</span></li></ul>
      <h4>Company</h4><ul class="imp-key-cats">${comp.map(row).join('')}</ul>
      <h4>Market</h4><ul class="imp-key-cats">${mac.map(row).join('')}</ul></div>`;
  }
  function keyButton() { return '<button type="button" class="imp-keybtn" data-imp-key aria-expanded="false">Key</button>'; }

  // company macro-sensitivity row body
  function sensHtml(res) {
    if (!res || !res.ok) return `<p class="imp-na">Not available: ${esc(res ? res.reason : 'no data')}.</p>`;
    const fmtChg = tr => `${tr.chg > 0 ? '+' : ''}${tr.unit === '%' ? tr.chg.toFixed(1) + '%' : Math.round(tr.chg) + ' ' + tr.unit}`;
    return `${res.weakFit ? `<p class="imp-note">The factors explain little of this stock's daily moves (fit R2 ${res.r2.toFixed(2)}), so treat these as faint.</p>` : ''}
      <ul class="imp-sens">${res.items.map(x => `<li class="imp-sens-i">
        <div class="imp-sens-h">${tag(x.f.cat)}<span class="imp-sens-n">${esc(x.f.name)}</span>${x.trend ? trend(x.trend.dir, x.trend.window, `${x.f.name} moved ${fmtChg(x.trend)} from ${x.trend.from} to ${x.trend.to} (${x.trend.source}).`) : ''}</div>
        <p class="imp-sens-l">${esc(x.line)}</p>
        <div class="imp-sens-f">${x.strength === 'none' ? mark('none', null, 'The link is too weak to call (|t| below 1).') : mark(x.impact, x.impact === 'none' ? null : 'Recent move', x.trend ? `Recent ${x.f.name.toLowerCase()} move ${x.impact === 'helps' ? 'has favored' : x.impact === 'hurts' ? 'has worked against' : 'gives no read for'} this name.` : 'No recent factor move to apply.')}<span class="imp-str s-${x.strength}">${x.strength === 'clear' ? 'Clear link' : x.strength === 'weak' ? 'Weak link' : 'No link'}</span></div>
      </li>`).join('')}</ul>`;
  }
  function sensMetrics(res) { return res && res.ok ? res.items.filter(x => x.metric).map(x => x.metric) : []; }

  /* ---------------------------------------------------------------- landing polish helpers (pure) */
  // risk ordering: macro releases, then watchlist/shortlist names, then the rest; time order inside each band
  function riskBand(r, watch, short) {
    if (r.kind !== 'earnings') return 0;
    if (r.watchlist || (r.tickers || []).some(t => watch.has(t) || short.has(t))) return 1;
    return 2;
  }
  const MACRO_WHY = [
    [/cpi|inflation|pce|ppi/i, 'A hot inflation print pushes yields up and weighs on stock valuations.'],
    [/payroll|jobs|employment|claims/i, 'Jobs data moves rate expectations; a large surprise either way moves stocks.'],
    [/fomc|fed|rate decision/i, 'Rate decision and guidance reset borrowing costs for every asset.'],
    [/gdp/i, 'Growth reading; a miss raises recession worries, a beat can lift yields.'],
    [/retail sales/i, 'Consumer spending gauge; drives views on growth and earnings.'],
  ];
  // one distinct reason per earnings row from the name's own data; used avoids repeating a template across rows
  function riskReason(r, row, ctx, used) {
    if (r.kind !== 'earnings') {
      for (const [re, line] of MACRO_WHY) if (re.test(r.title || '')) return line;
      return r.why || 'Scheduled release that can move rates and stocks.';
    }
    const t = (r.tickers || [])[0];
    const c = [];
    const pct = (v, dp) => (v > 0 ? '+' : '') + v.toFixed(dp == null ? 1 : dp) + '%';
    if (ctx && ctx.short && ctx.short.has(t)) c.push(['short', `On the research shortlist; the report tests that case.`]);
    if (row) {
      if (typeof row.mcap === 'number' && ctx && ctx.totalCap > 0 && row.mcap / ctx.totalCap >= 0.01) c.push(['weight', `${(row.mcap / ctx.totalCap * 100).toFixed(1)}% of covered index value, so it can move the index.`]);
      if (typeof row.pef_sec_rel === 'number' && row.pef_sec_rel >= 1.3) c.push(['rich', `Forward P/E is ${row.pef_sec_rel.toFixed(1)}x its sector median before results.`]);
      if (typeof row.pef_sec_rel === 'number' && row.pef_sec_rel > 0 && row.pef_sec_rel <= 0.75) c.push(['cheap', `Forward P/E is ${row.pef_sec_rel.toFixed(2)}x its sector median before results.`]);
      if (typeof row.m1 === 'number' && Math.abs(row.m1) >= 6) c.push(['run', `${row.m1 > 0 ? 'Up' : 'Down'} ${pct(Math.abs(row.m1)).replace('+', '')} over the past month going into the report.`]);
      if (typeof row.beta === 'number' && row.beta >= 1.4) c.push(['beta', `Beta ${row.beta.toFixed(2)}: tends to amplify market moves.`]);
      if (typeof row.ivrv_eff === 'number' && row.ivrv_eff >= 1.5 && typeof row.rv20 === 'number') c.push(['iv', `Modeled volatility is ${row.ivrv_eff.toFixed(1)}x recent realized swings; inspect the assumptions before results.`]);
      if (typeof row.rating === 'string' && typeof row.up === 'number' && Math.abs(row.up) >= 10) c.push(['target', `Analyst target ${pct(row.up, 0)} from the price; guidance tests that gap.`]);
      if (typeof row.d5 === 'number' && Math.abs(row.d5) >= 3) c.push(['week', `${row.d5 > 0 ? 'Up' : 'Down'} ${Math.abs(row.d5).toFixed(1)}% this week before reporting.`]);
      if (row.sec) c.push(['sector:' + row.sec, `First read on ${row.sec.toLowerCase()} demand this season.`]);
    }
    const pick = c.find(([k]) => !used || !used.has(k)) || c[0];
    if (pick) { if (used) used.add(pick[0]); return pick[1]; }
    return r.why || 'Results and guidance can reset expectations.';
  }
  function riskExplanation(r, row, used) {
    const candidates = [], base = r.metrics || [];
    const add = (id, text, label, value, unit, period) => candidates.push({id, text, metrics: base.concat([{
      label, value, unit, period, asof: row.pxd || '', source: 'Yahoo Finance via yfinance',
      source_url: `https://finance.yahoo.com/quote/${encodeURIComponent(row.t)}/`, note: 'Stored dashboard observation; no forecast.'
    }])});
    if (r.kind === 'earnings' && row) {
      if (typeof row.beta === 'number' && row.beta >= 1.4) add('beta', `Beta ${row.beta.toFixed(2)} indicates larger historical market swings.`, 'Beta', row.beta, 'x', 'Provider regression window');
      if (typeof row.pef_sec_rel === 'number' && row.pef_sec_rel > 0) add('valuation', `Forward P/E is ${row.pef_sec_rel.toFixed(2)}x its sector median before results.`, 'Forward P/E / sector median', row.pef_sec_rel, 'x', 'Forward twelve months');
      if (typeof row.d5 === 'number') add('week', `The stock moved ${row.d5 > 0 ? '+' : ''}${row.d5.toFixed(1)}% over five sessions before reporting.`, 'Five-session price change', row.d5, '%', `Five sessions to ${row.pxd || ''}`);
    }
    const picked = candidates.find(c => !used || !used.has(c.id)) || candidates[0];
    if (picked) { if (used) used.add(picked.id); return picked; }
    return {text: r.why || 'Results and guidance can change earnings expectations.', metrics: base};
  }
  // shortlist caution: the strongest relative caution in the measured inputs, or a short neutral line
  function caution(n, row, nowMs) {
    if (n && n.counter && n.counter.text && !/no weak area/i.test(n.counter.text)) return {text: n.counter.text, kind: 'counter', metrics: n.counter.metrics || []};
    const out = [];
    if (row) {
      if (row.er) {
        const d = Math.round((Date.parse(row.er + 'T12:00:00Z') - (nowMs || Date.now())) / 864e5);
        if (d >= 0 && d <= 21) out.push({w: 3 - d / 10, text: `Reports in ${d === 0 ? 'under a day' : d + (d === 1 ? ' day' : ' days')} (${row.er}); results can move it sharply.`, cat: 'events', metrics: [{label: 'Next earnings date', value: row.er, unit: 'date', period: 'upcoming', asof: row.pxd || '', source: row.ers || 'core.json'}]});
      }
      if (typeof row.pef_sec_rel === 'number' && row.pef_sec_rel >= 1.25) out.push({w: row.pef_sec_rel, text: `Forward P/E is ${row.pef_sec_rel.toFixed(1)}x its sector median.`, cat: 'valuation', metrics: [{label: 'Forward P/E / sector median', value: row.pef_sec_rel, unit: 'x', period: 'forward 12 months', asof: row.pxd || '', source: 'Yahoo Finance via yfinance'}]});
      if (typeof row.pct === 'number' && row.pct >= 90) out.push({w: 1 + (row.pct - 90) / 20, text: `Trades in the top ${Math.max(1, Math.round(100 - row.pct))}% of its 52-week range.`, cat: 'momentum', metrics: [{label: 'Position in 52-week range', value: row.pct, unit: '%', period: '52 weeks', asof: row.pxd || '', source: 'Yahoo Finance via yfinance'}]});
      if (typeof row.beta === 'number' && row.beta >= 1.5) out.push({w: row.beta - 0.2, text: `Beta ${row.beta.toFixed(2)}: swings harder than the market.`, cat: 'momentum', metrics: [{label: 'Beta', value: row.beta, unit: '', period: 'provider', asof: row.pxd || '', source: 'Yahoo Finance via yfinance'}]});
    }
    out.sort((a, b) => b.w - a.w);
    if (out.length) return Object.assign({kind: 'caution'}, out[0]);
    return {text: 'No specific counterargument is established by the available inputs.', kind: 'neutral', metrics: (n && n.counter && n.counter.metrics) || []};
  }

  const api = {CATS, CARD_CAT, LOOKUP, GLOSSARY, IMPACT, FACTORS, catOf, impactOf, merge, meansFor, drivers, statusDrivers, factorMove, sensitivities,
    lum, contrast, esc, tag, mark, trend, term, drivenBy, keyHtml, keyButton, sensHtml, sensMetrics, riskBand, riskReason, riskExplanation, caution};

  /* ================================================================ browser part */
  const doc = root.document;
  if (!doc) return api;
  const reduced = () => !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // category hues as CSS variables, written once from CATS so tests and page share one source
  (function injectVars() {
    if (doc.getElementById('imp-vars')) return;
    const st = doc.createElement('style'); st.id = 'imp-vars';
    const decl = th => Object.entries(CATS).map(([k, c]) => `--ic-${k}:${c[th]};`).join('');
    st.textContent = `:root{${decl('light')}}html[data-bt="dark"]{${decl('dark')}}` + Object.keys(CATS).map(k => `.ic-${k}{--ic:var(--ic-${k})}`).join('');
    (doc.head || doc.documentElement).appendChild(st);
  })();

  let tip = null, tipFor = null, keyPop = null;
  function ensureTip() {
    if (tip) return tip;
    tip = doc.createElement('div'); tip.className = 'imp-tip'; tip.setAttribute('role', 'tooltip'); tip.id = 'imp-tip'; tip.hidden = true;
    doc.body.appendChild(tip); return tip;
  }
  function showTip(el) {
    const t = ensureTip(); tipFor = el;
    t.textContent = el.getAttribute('data-means'); t.hidden = false;
    el.setAttribute('aria-describedby', 'imp-tip');
    const r = el.getBoundingClientRect(), vw = doc.documentElement.clientWidth;
    const w = Math.min(300, vw - 16); t.style.maxWidth = w + 'px';
    const tw = t.offsetWidth, th = t.offsetHeight;
    let x = Math.max(8, Math.min(vw - tw - 8, r.left + r.width / 2 - tw / 2));
    let y = r.top - th - 8; if (y < 8) y = r.bottom + 8;
    t.style.left = x + 'px'; t.style.top = y + 'px';
  }
  function hideTip() { if (tip) tip.hidden = true; if (tipFor) tipFor.removeAttribute('aria-describedby'); tipFor = null; }
  function toggleKey(btn) {
    if (keyPop && !keyPop.hidden && keyPop.__btn === btn) { closeKey(); return; }
    if (!keyPop) { keyPop = doc.createElement('div'); keyPop.className = 'imp-key'; keyPop.setAttribute('role', 'dialog'); keyPop.setAttribute('aria-label', 'Tag key'); doc.body.appendChild(keyPop); }
    keyPop.innerHTML = keyHtml() + '<button type="button" class="imp-key-x" data-imp-keyx>Close</button>';
    keyPop.__btn = btn; keyPop.hidden = false; btn.setAttribute('aria-expanded', 'true');
    const r = btn.getBoundingClientRect(), vw = doc.documentElement.clientWidth;
    const w = Math.min(380, vw - 16); keyPop.style.width = w + 'px';
    keyPop.style.left = Math.max(8, Math.min(vw - w - 8, r.right - w)) + 'px';
    keyPop.style.top = (r.bottom + 8 + root.scrollY) + 'px';
    const x = keyPop.querySelector('[data-imp-keyx]'); if (x) x.focus();
  }
  function closeKey() { if (!keyPop || keyPop.hidden) return; keyPop.hidden = true; if (keyPop.__btn) { keyPop.__btn.setAttribute('aria-expanded', 'false'); keyPop.__btn.focus(); } }
  // scroll to a driver's target and pulse it; "#/company/T|sel" navigates first and highlights after mount
  function go(spec) {
    hideTip();
    const [href, sel] = String(spec).includes('|') ? spec.split('|') : ['', spec];
    if (href) { try { root.sessionStorage.setItem('imp-pending', sel); } catch (e) { /* storage off */ } root.location.hash = href; return; }
    const el = sel && doc.querySelector(sel);
    if (!el) return;
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (p.classList.contains('b-flipbox')) {
        p.classList.add('open');
        const control = doc.querySelector(`[aria-controls="${p.id}"]`);
        if (control) control.setAttribute('aria-expanded', 'true');
      }
    }
    el.scrollIntoView({behavior: reduced() ? 'auto' : 'smooth', block: 'center'});
    el.classList.remove('imp-hl'); void el.offsetWidth; el.classList.add('imp-hl');
    setTimeout(() => el.classList.remove('imp-hl'), 1800);
  }
  function flushPending() {
    let sel = null; try { sel = root.sessionStorage.getItem('imp-pending'); root.sessionStorage.removeItem('imp-pending'); } catch (e) { return; }
    if (sel) setTimeout(() => go(sel), 350);
  }
  doc.addEventListener('mouseover', e => { const el = e.target.closest && e.target.closest('[data-means]'); if (el && el !== tipFor) showTip(el); else if (!el && tipFor) hideTip(); });
  doc.addEventListener('focusin', e => { const el = e.target.closest && e.target.closest('[data-means]'); if (el) showTip(el); });
  doc.addEventListener('focusout', e => { if (tipFor && e.target === tipFor) hideTip(); });
  doc.addEventListener('scroll', hideTip, {passive: true, capture: true});
  doc.addEventListener('keydown', e => { if (e.key === 'Escape') { hideTip(); closeKey(); } });
  doc.addEventListener('click', e => {
    const k = e.target.closest('[data-imp-key]'); if (k) { e.preventDefault(); toggleKey(k); return; }
    if (e.target.closest('[data-imp-keyx]')) { closeKey(); return; }
    const g = e.target.closest('[data-imp-go]'); if (g) { e.preventDefault(); go(g.getAttribute('data-imp-go')); return; }
    const m = e.target.closest('[data-means]');
    if (m && (e.pointerType === 'touch' || !root.matchMedia || root.matchMedia('(hover: none)').matches)) { tipFor === m && tip && !tip.hidden ? hideTip() : showTip(m); return; }
    if (keyPop && !keyPop.hidden && !e.target.closest('.imp-key')) closeKey();
  });
  return Object.assign(api, {go, flushPending, showTip, hideTip});
});
