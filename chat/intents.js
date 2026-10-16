/* SmartOptions Brief chat: deterministic intent router (lane CH). No model, no network.
   route(text, ctx) -> {intent, entities:{tickers, sector, card, period, term, sort}, score, sure, suggestions:[intent ids]}
   ctx = {universe: [[t, name, sector], ...], covered: Set of tickers with data (optional)}.
   Works in the browser (window.SmartOptionsIntents) and in node (module.exports). */
'use strict';
(function (root, factory) {
  const M = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  root.SmartOptionsIntents = M;
})(typeof window !== 'undefined' ? window : globalThis, function () {

  /* ---------------------------------------------------------------- catalog */
  // need: 'ticker' (one company), 'two' (two companies), 'sector', 'term', 'period', 'card' or ''
  // chip: the tap-able example shown for suggestions; {T} is filled with a ticker in context
  const CATALOG = [
    {id: 'pulse', label: 'Market pulse', chip: 'What changed today?'},
    {id: 'macro', label: 'Macro backdrop', chip: 'How is the economy doing?'},
    {id: 'risk_conditions', label: 'Risk conditions', chip: 'How stressed is the market?'},
    {id: 'risks', label: 'Upcoming risks', chip: 'What could move markets this week?'},
    {id: 'breadth', label: 'Breadth and concentration', chip: 'Is the rally broad or narrow?'},
    {id: 'sectors', label: 'Sector leaders and laggards', chip: 'Which sectors lead?'},
    {id: 'shortlist', label: 'Research shortlist', chip: 'Which names to research, and why?'},
    {id: 'top_scores', label: 'Top names by score', chip: 'Top names by score'},
    {id: 'valuation_peers', label: 'Valuation versus peers', chip: 'Which names look cheap versus peers?'},
    {id: 'ticker_summary', label: 'One company', chip: 'Summarize {T}', need: 'ticker'},
    {id: 'ticker_card', label: 'One part of a company', chip: 'Is {T} expensive?', need: 'ticker'},
    {id: 'compare', label: 'Compare two companies', chip: 'Compare {T} and {U}', need: 'two'},
    {id: 'price', label: 'Latest price', chip: 'What is {T} trading at?', need: 'ticker'},
    {id: 'earnings_date', label: 'Next earnings date', chip: 'When does {T} report?', need: 'ticker'},
    {id: 'strategy', label: 'Options considerations', chip: 'Options ideas for {T}', need: 'ticker'},
    {id: 'technical', label: 'Technical setup', chip: 'Technical setup for {T}', need: 'ticker'},
    {id: 'glossary', label: 'Explain a term', chip: 'What does P/E mean?', need: 'term'},
    {id: 'freshness', label: 'Data freshness', chip: 'How fresh is this data?'},
    {id: 'provenance', label: 'Where a number comes from', chip: 'How is the score built?'},
    {id: 'help', label: 'What I can answer', chip: 'What can I ask?'},
    {id: 'open_ticker', label: 'Open a company', chip: 'Open {T}', need: 'ticker', action: true},
    {id: 'show_sector', label: 'Show a sector on the map', chip: 'Highlight Energy on the map', need: 'sector', action: true},
    {id: 'watch_add', label: 'Add to watchlist', chip: 'Add {T} to my watchlist', need: 'ticker', action: true},
    {id: 'watch_remove', label: 'Remove from watchlist', chip: 'Remove {T} from my watchlist', need: 'ticker', action: true},
    {id: 'watchlist_show', label: 'Your watchlist', chip: 'What is on my watchlist?'},
    {id: 'sort_filter', label: 'Sort or filter the table', chip: 'Only show Health Care', action: true},
    {id: 'switch_period', label: 'Switch the map period', chip: 'Show the map for 1W', need: 'period', action: true},
    {id: 'expand_macro', label: 'Detailed macro observations', chip: 'Show detailed macro observations', action: true},
  ];
  const BY_ID = {}; CATALOG.forEach(c => { BY_ID[c.id] = c; });
  const CARDS = ['growth', 'profitability', 'cash', 'resilience', 'valuation', 'expectations', 'counter'];
  const SECTORS = ['Communication Services', 'Consumer Discretionary', 'Consumer Staples', 'Energy', 'Financials', 'Health Care',
    'Industrials', 'Information Technology', 'Materials', 'Real Estate', 'Utilities'];

  /* ---------------------------------------------------------------- vocabulary */
  // [phrase regex source, value]; longest phrases first where it matters
  const SECTOR_WORDS = [
    ['information technology|info tech|technology|tech|semiconductors?|semis|software', 'Information Technology'],
    ['communication services|communications?|telecom|media', 'Communication Services'],
    ['consumer discretionary|discretionary|retailers?|retail', 'Consumer Discretionary'],
    ['consumer staples|staples', 'Consumer Staples'],
    ['energy|oil and gas|oil', 'Energy'],
    ['financials?|banks?|banking|insurers?', 'Financials'],
    ['health ?care|pharma|biotech|medical', 'Health Care'],
    ['industrials?', 'Industrials'],
    ['utilit(?:y|ies)', 'Utilities'],
    ['real estate|reits?', 'Real Estate'],
    ['materials|chemicals|mining|miners', 'Materials']];
  const CARD_WORDS = [
    ['counter', 'bear case|case against|downside|go wrong|goes wrong|against it|risks? (?:to|for|with)|counter ?argument|weak(?:ness|est)|worr(?:y|ies)|concerns?|why not|red flags?'],
    ['expectations', 'estimates?|revisions?|revised|analysts?|expectations?|consensus|forecasts?'],
    ['cash', 'free cash flow|cash flow|fcf|cash generation|cash conversion|cash'],
    ['resilience', 'debt|leverage|levered|balance sheet|liquidity|interest coverage|solvent|bankrupt\\w*|resilien\\w*'],
    ['profitability', 'operating margin|margins?|profitab\\w*|profits?'],
    ['valuation', 'valuation|valued|expensive|cheap\\w*|overvalued|undervalued|pricey|multiples?|pe|forward pe'],
    ['growth', 'growth|growing|grow|grows|revenue|sales|top line|eps']];
  const GLOSSARY_WORDS = [
    ['forward p/e', 'forward pe'], ['peg', 'peg(?: ratio)?'], ['p/e', 'pe(?: ratio)?|price to earnings'],
    ['eps', 'eps|earnings per share'], ['free cash flow', 'free cash flow|fcf'], ['cash conversion', 'cash conversion'],
    ['operating margin', 'operating margin|margin'], ['breadth', 'breadth|market breadth'], ['concentration', 'concentration'],
    ['rotation', '(?:sector )?rotation'], ['equal weight', 'equal weight\\w*|cap weight\\w*'],
    ['credit spread', 'credit spreads?|high yield spreads?|hy oas|oas|spreads?'], ['vix', 'vix|fear (?:index|gauge)'],
    ['implied volatility', 'implied volatility|iv'], ['realized volatility', 'realized volatility'], ['beta', 'beta'],
    ['moving average', 'moving averages?|sma|\\d+ (?:day|session) average'], ['support and resistance', 'support|resistance'],
    ['yield curve', 'yield curve|inverted curve|curve'], ['basis point', 'basis points?|bps'],
    ['debt to equity', 'debt to equity'], ['interest coverage', 'interest coverage'], ['estimate revisions', '(?:estimate )?revisions'],
    ['market cap', 'market cap\\w*'], ['covered call', 'covered calls?'], ['put option', 'put options?|puts?'],
    ['call option', 'call options?|calls?'], ['cpi', 'cpi|consumer price index'], ['payrolls', 'payrolls|nonfarm|jobs report'],
    ['fed funds rate', 'fed funds(?: rate)?|policy rate'], ['heatmap', 'heat ?map|treemap'], ['score', 'score'],
    ['options', 'options?'], ['dividend', 'dividends?'], ['volatility', 'volatility'], ['earnings', 'earnings']];
  const PERIOD_WORDS = [['1D', '1 ?d|1 day|one day|daily|today'], ['1W', '1 ?w|1 week|one week|5 ?d(?:ays?)?|weekly|week'], ['1M', '1 ?m|1 month|one month|30 days?|monthly|month']];
  const ALIASES = {
    google: 'GOOGL', alphabet: 'GOOGL', facebook: 'META', coke: 'KO', 'coca cola': 'KO', pepsi: 'PEP', 'jp morgan': 'JPM', jpmorgan: 'JPM',
    chase: 'JPM', exxon: 'XOM', 'exxon mobil': 'XOM', berkshire: 'BRK-B', bofa: 'BAC', 'bank of america': 'BAC', 'wells fargo': 'WFC',
    goldman: 'GS', 'goldman sachs': 'GS', 'morgan stanley': 'MS', 'home depot': 'HD', walmart: 'WMT', mcdonalds: 'MCD', disney: 'DIS',
    netflix: 'NFLX', boeing: 'BA', intel: 'INTC', 'at&t': 'T', att: 'T', verizon: 'VZ', unitedhealth: 'UNH', 'united health': 'UNH',
    'johnson and johnson': 'JNJ', 'johnson & johnson': 'JNJ', 'j&j': 'JNJ', 'procter and gamble': 'PG', 'p&g': 'PG', costco: 'COST',
    starbucks: 'SBUX', nike: 'NKE', visa: 'V', mastercard: 'MA', chevron: 'CVX', conoco: 'COP', broadcom: 'AVGO', salesforce: 'CRM',
    oracle: 'ORCL', adobe: 'ADBE', cisco: 'CSCO', qualcomm: 'QCOM', 'texas instruments': 'TXN', caterpillar: 'CAT', lowes: 'LOW',
    "lowe's": 'LOW', 'eli lilly': 'LLY', lilly: 'LLY', pfizer: 'PFE', merck: 'MRK', abbvie: 'ABBV', amd: 'AMD', 'advanced micro': 'AMD',
    'general motors': 'GM', ford: 'F', 'general electric': 'GE', 'ge aerospace': 'GE', 'micron': 'MU', 'palantir': 'PLTR', 'uber': 'UBER',
    'american express': 'AXP', amex: 'AXP', 'philip morris': 'PM', altria: 'MO', 'dollar general': 'DG', 'best buy': 'BBY', 'target corp': 'TGT',
    'servicenow': 'NOW', 'service now': 'NOW', 'ups': null};
  // uppercase words that are not meant as tickers even when they match one
  const UPPER_STOP = new Set('I A US PE EPS CEO CFO VS ETF FED CPI PPI GDP VIX FCF IV OK AI IPO USA PM AM ET EV YOY QOQ ATH SMA RSI MACD HY OAS IT ON SO ALL NOW KEY ARE HAS BE GO AN OR IS AS DO BIG TOP LOW CAN FOR AND THE YOU HOW WHY WHO OUT DAY MA HD AT TO UP NO IN OF ANY NEW ONE TWO GOOD FAST WELL COST DASH POOL PEG TECH UPS ICE AMP GEN MAX SEE BOX CAR AIR SNA KIM MAS BEN HAL DD ED ES EL FE GE GM MO MS MU O T V L J C D F K NEWS WHAT WHEN BUY SELL HOLD'.split(' '));
  // common lowercase words (and our own vocabulary) that must never be read as a ticker or company
  const COMMON = new Set(('a all an and any are as at be best big buy by can cat cost dash day do does down fast for from gen get go good has have hd how ' +
    'i ice in is it its key low make max me my new no not now of oil on one or out peg pool see sell so tech the to top two up ups us was ' +
    'well what when where which who why will with you your box car air amp hal ben kim mas sna hold play live target match ball first ' +
    'general public united american southern global universal equity waste fair best dollar expand insight quest edison arch ' +
    'lead lam open ready core realty progressive republic snap trade fox news tap bio host gap halliburton take home state extra iron ' +
    'super digital western northern jack henry principal applied analog advanced electronic monster booking carrier cardinal intuitive ' +
    'align delta union smith steel royal boston block interactive capital discover regions citizens fifth globe lincoln franklin west ' +
    'southwest charles warner match nasdaq dow cadence ross tractor church bro len day ever eat info pay hum ever lin ll').split(' '));

  /* ---------------------------------------------------------------- intent keywords: [regex, weight] */
  const R = s => new RegExp('\\b(?:' + s + ')\\b');
  const KW = {
    pulse: [[R('market|markets'), 1.5], [R('stocks?'), 0.5], [R('today|todays|right now'), 0.5], [R('changed?|changes|happening|going on|moved?'), 1.5],
      [R('pulse|briefing|brief|summary|overview|recap|rundown'), 2], [R('sp500|dow|nasdaq|spy'), 1.5],
      [R('holding \\w+ up|propping|supports?|supporting|tailwinds?|helping'), 2], [R('headwinds?|challeng\\w*|hurting|weighing|dragging'), 2],
      [R('everything (?:red|green|down|up)|why is (?:the market|everything)|sell ?off|selloff|rally'), 1.5]],
    macro: [[R('economy|economic backdrop|macro'), 2], [R('inflation|cpi|prices rising'), 2], [R('fed|federal reserve|rates?|interest rates?|policy|hikes?|cuts?'), 1.5],
      [R('jobs?|employment|unemployment|payrolls|labor'), 1.5], [R('gdp|growth picture|recession'), 1.5], [R('yields?|treasur(?:y|ies)|bonds?'), 1.5]],
    risk_conditions: [[R('vix|volatil\\w*'), 2], [R('credit|spreads?'), 2], [R('scared|fear\\w*|nervous|stress\\w*|panic|risk level|risk conditions|how risky|calm'), 1.5]],
    risks: [[R('risks?'), 1.5], [R('upcoming|coming up|next week|this week|ahead|soon|calend[ae]r|schedul\\w*|events?|tomorrow'), 2],
      [R('releases?|reports?|reporting|announcements?'), 1], [R('earnings'), 1], [R('who reports|which companies report'), 2]],
    breadth: [[R('breadth|broad|broadening|narrow\\w*|concentrat\\w*|participation'), 3],
      [R('mega ?caps?|few (?:big )?stocks|handful|top (?:10|ten)|equal weight\\w*|spreading out|most stocks|only the'), 2]],
    sectors: [[R('sectors?|industr(?:y|ies)|rotation'), 2.5], [R('lead\\w*|lag\\w*|best performing|worst performing|outperform\\w*|underperform\\w*'), 1]],
    shortlist: [[R('short ?list'), 4], [R('research'), 1.5], [R('ideas?|worth (?:looking|investigating|a look)|look into|investigat\\w*|picks?|candidates'), 2]],
    top_scores: [[R('scor\\w*'), 2], [R('top \\d+|top|best|highest|ranked|ranking|strongest'), 1.5], [R('rated|ratings?'), 1.5]],
    valuation_peers: [[R('cheap\\w*|undervalued|overvalued|expensive|bargains?|valuation|value stocks'), 2], [R('peers?|compared to|relative to'), 1]],
    ticker_summary: [[R('tell me about|what about|thoughts on|think (?:of|about)|looking|doing|outlook|overview|summar\\w*|worth|look at|opinion'), 1]],
    compare: [[R('vs|versus|compare\\w*|comparison|better|or|against|difference|which one'), 2]],
    price: [[R('price|trading at|quote|how much is|share price|cost now|selling for'), 2.5]],
    earnings_date: [[R('earnings|report\\w*|results|announce\\w*'), 2], [R('when|date|next|day'), 1]],
    strategy: [[R('options?|strateg\\w*|covered calls?|puts?|calls?|straddles?|collars?|hedg\\w*|trade|play|premium'), 2.5]],
    technical: [[R('technical\\w*|setup|trend\\w*|uptrend|downtrend|moving averages?|sma|support|resistance|momentum|breakout|overbought|oversold|rsi|200 day|50 day'), 2.5], [R('chart'), 1]],
    freshness: [[R('fresh\\w*|stale|up to date|outdated|live|delayed|real ?time|last updated|updated|how old|as of|accura\\w*|trust|reliable|snapshot|current'), 3]],
    provenance: [[R('sources?|come from|comes from|where does|where do you get|calculat\\w*|computed|built|derived|method\\w*|provenance|how do you get'), 3]],
    help: [[R('help|menu|what can (?:you|i)|how do i use|what do you do|what questions'), 4]],
    open_ticker: [[R('open|go to|take me|pull up|bring up|navigate|jump to'), 3], [R('page|chart|workspace'), 2], [R('show'), 1]],
    show_sector: [[R('show|highlight|open|go to|view|see'), 1.5], [R('on the map|map|heat ?map'), 1.5]],
    watch_add: [[R('add|pin|track|follow|watch|put|save'), 2], [R('watchlist|my list'), 1.5]],
    watch_remove: [[R('remove|unpin|untrack|unwatch|drop|delete|take \\w+ off|take off|stop (?:watching|tracking|following)|get rid of'), 3.5], [R('watchlist|my list'), 1.5]],
    watchlist_show: [[R('watchlist|my list|my stocks|my names|i follow|i am watching|im watching'), 2.5]],
    sort_filter: [[R('sort\\w*|filter\\w*|only show|show only|just show|rank by|order by|screen for|lowest first|highest first'), 3.5]],
    switch_period: [[R('switch|change|set|show|view'), 1], [R('map|heat ?map|view|period|timeframe|time frame'), 1.5]],
    expand_macro: [[R('expand|detail\\w*|observations|deeper|full macro|macro numbers|more on macro|more macro'), 2], [R('macro'), 1]],
  };
  const TICKER_INTENTS = new Set(['ticker_summary', 'ticker_card', 'price', 'earnings_date', 'strategy', 'technical', 'open_ticker', 'watch_add', 'watch_remove']);

  /* ---------------------------------------------------------------- text helpers */
  // optimal string alignment distance (Damerau with adjacent transposition), early exit above max
  function osa(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    const d = [];
    for (let i = 0; i <= a.length; i++) { d[i] = [i]; }
    for (let j = 0; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      let rowMin = Infinity;
      for (let j = 1; j <= b.length; j++) {
        const c = a[i - 1] === b[j - 1] ? 0 : 1;
        let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2][j - 2] + 1);
        d[i][j] = v; if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
    }
    return d[a.length][b.length];
  }
  function normalize(s) {
    return ' ' + String(s || '').toLowerCase()
      .replace(/[‘’ʼ`]/g, "'").replace(/[“”]/g, '"')
      .replace(/s\s*&\s*p(?:\s*500)?|sp\s?500|spx/g, ' sp500 ')
      .replace(/\bp\s*\/\s*e\b|\bp\.e\.?|\bp e\b/g, ' pe ')
      .replace(/\bwatch[\s-]+list\b/g, 'watchlist').replace(/\bshort[\s-]+list\b/g, 'shortlist')
      .replace(/\bhow's\b/g, 'how is').replace(/\bwhat's\b|\bwhats\b/g, 'what is').replace(/\bwhere's\b/g, 'where is')
      .replace(/\bi'm\b/g, 'i am').replace(/'s\b/g, '').replace(/n't\b/g, ' not')
      .replace(/\b(\w+)-(\w+)\b/g, '$1 $2')
      .replace(/[^a-z0-9$&/.\s]/g, ' ').replace(/(\D)\.(\s|$)/g, '$1 ').replace(/\s+/g, ' ') + ' ';
  }

  /* ---------------------------------------------------------------- vocab for typo correction */
  const VOCAB = new Set(('market markets stocks today happening changed change summary briefing overview recap pulse support supports ' +
    'headwinds tailwinds challenges economy inflation federal reserve rates interest policy jobs employment unemployment payrolls labor ' +
    'recession yields treasury bonds volatility credit spreads scared nervous stress panic risks upcoming calendar schedule events ' +
    'releases reports earnings breadth broad broadening narrow narrowing concentrated concentration participation megacaps handful ' +
    'sectors sector industries industry rotation leading lagging leaders laggards performing shortlist research ideas investigate ' +
    'candidates score scores scoring ranked ranking strongest highest rated ratings cheap cheapest undervalued overvalued expensive ' +
    'valuation peers compared relative summary outlook compare comparison versus better difference price trading quote report results ' +
    'announce options option strategy strategies covered calls puts straddle collar hedge premium technical setup trend uptrend ' +
    'downtrend average averages moving support resistance momentum breakout overbought oversold chart fresh stale updated outdated ' +
    'delayed realtime accurate accuracy trust reliable snapshot current source sources calculated computed method provenance help ' +
    'open navigate workspace show highlight watchlist remove unpin untrack delete track follow watch sort filter switch heatmap ' +
    'period timeframe weekly monthly daily week month expand detailed details observations macro growth growing revenue sales ' +
    'profitable profitability profit margin margins cash flow debt leverage balance sheet liquidity coverage resilience estimates ' +
    'revisions analysts expectations consensus forecast downside against weakness worried concerns explain define meaning mean ' +
    'technology energy financials financial banks healthcare health care pharma biotech staples discretionary retail industrials ' +
    'utilities utility estate reits materials chemicals communication communications telecom media dividend bear bull case wrong ' +
    'worry tracking watching following looking worth think doing tell about trading compare going coming week weeks month months ' +
    'stock company companies names please could would should right price prices numbers number value values today yesterday ' +
    'tomorrow higher lower bigger rally falling rising dropping where there their these those other things thing money doing').split(' '));

  /* ---------------------------------------------------------------- universe index (built once per universe) */
  let IDX = null, IDX_SRC = null;
  const GENERIC = new Set('inc corp corporation company co the holdings holding group plc ltd limited class a b c and of & international technologies technology systems'.split(' '));
  function cleanName(n) { return String(n || '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[.,]/g, ' ').replace(/-/g, ' ').replace(/\s+/g, ' ').trim(); }
  function index(universe) {
    if (IDX && IDX_SRC === universe) return IDX;
    const syms = new Map(), phrases = new Map(), firstCount = new Map(), sector = new Map();
    (universe || []).forEach(([t, n, s]) => { syms.set(t, n); sector.set(t, s); });
    const words = cleanName => cleanName.split(' ').filter(w => w && !GENERIC.has(w));
    (universe || []).forEach(([t, n]) => { const w = words(cleanName(n)); if (w[0]) firstCount.set(w[0], (firstCount.get(w[0]) || 0) + 1); });
    (universe || []).forEach(([t, n]) => {
      const w = words(cleanName(n));
      if (w.length >= 2) phrases.set(w.join(' '), t);
      if (w[0] && w[0].length >= 4 && firstCount.get(w[0]) === 1 && !COMMON.has(w[0]) && !VOCAB.has(w[0])) phrases.set(w[0], t);
    });
    for (const k in ALIASES) { if (ALIASES[k] && syms.has(ALIASES[k])) phrases.set(k, ALIASES[k]); else if (ALIASES[k] === null) phrases.delete(k); }
    // GOOGL is the class most people mean
    if (syms.has('GOOGL')) phrases.set('alphabet', 'GOOGL');
    const single = [...phrases.keys()].filter(p => !p.includes(' ') && p.length >= 5);
    const list = [...phrases.keys()].sort((a, b) => b.length - a.length);
    IDX = {syms, phrases, list, single, sector}; IDX_SRC = universe;
    return IDX;
  }
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /* ---------------------------------------------------------------- entities */
  function extract(raw, norm, I) {
    const tickers = [], spans = [];
    const push = (t, at) => { if (t && !tickers.some(x => x.t === t)) tickers.push({t, at}); };
    const str = String(raw || '');
    // $TICKER always counts
    str.replace(/\$([A-Za-z]{1,5}(?:[.-][A-Za-z])?)\b/g, (m, s, at) => { const t = s.toUpperCase().replace('.', '-'); if (I.syms.has(t)) push(t, at); return m; });
    // uppercase tokens, unless the whole message is shouted
    const alpha = str.match(/[A-Za-z]{2,}/g) || [];
    const upper = alpha.filter(w => w === w.toUpperCase());
    const shouting = alpha.length >= 3 && upper.length / alpha.length > 0.6;
    const bare = str.trim().replace(/^\$/, '').replace(/[?.!]+$/, '');
    if (/^[A-Za-z]{1,5}(?:[.-][A-Za-z])?$/.test(bare) && I.syms.has(bare.toUpperCase().replace('.', '-'))) push(bare.toUpperCase().replace('.', '-'), 0);
    if (!shouting) str.replace(/\b([A-Z]{1,5}(?:[.-][A-Z])?)\b/g, (m, s, at) => { const t = s.replace('.', '-'); if (I.syms.has(t) && !UPPER_STOP.has(t) && (t.length > 1 || str.trim() === s)) push(t, at); return m; });
    // company names and aliases (longest first), then lowercase tickers
    let rest = norm;
    for (const p of I.list) {
      const re = new RegExp('(^|\\s)' + esc(p) + '(?=\\s)');
      const m = rest.match(re);
      if (m) { push(I.phrases.get(p), m.index); spans.push(p); rest = rest.replace(re, ' '.repeat(p.length + m[1].length)); }
    }
    rest.split(' ').forEach(w => {
      if (w.length >= 3 && !COMMON.has(w) && !VOCAB.has(w)) {
        const t = w.toUpperCase();
        if (I.syms.has(t) && !UPPER_STOP.has(t)) push(t, norm.indexOf(' ' + w + ' '));
      }
    });
    tickers.sort((a, b) => a.at - b.at);
    return {tickers: tickers.map(x => x.t), rest};
  }
  function firstMatch(text, table) {
    for (const [a, b] of table) { const re = R(b); if (re.test(text)) return a; }
    return null;
  }
  function sectorOf(text) {
    for (const [words, s] of SECTOR_WORDS) if (R(words).test(text)) return s;
    return null;
  }

  /* ---------------------------------------------------------------- typo correction */
  function correct(norm, I) {
    return ' ' + norm.trim().split(' ').map(w => {
      if (w.length < 5 || /\d|\$|\//.test(w) || VOCAB.has(w) || COMMON.has(w) || I.phrases.has(w) || I.syms.has(w.toUpperCase())) return w;
      const max = w.length >= 9 ? 2 : 1;
      let best = null, bd = max + 1;
      for (const v of VOCAB) { const d = osa(w, v, max); if (d < bd) { bd = d; best = v; } }
      if (best) return best;
      for (const v of I.single) { const d = osa(w, v, max); if (d < bd) { bd = d; best = v; } }
      return best || w;
    }).join(' ') + ' ';
  }

  /* ---------------------------------------------------------------- route */
  function route(text, ctx) {
    ctx = ctx || {};
    const I = index(ctx.universe || []);
    const raw = String(text || '').trim();
    const ent = {tickers: [], sector: null, card: null, period: null, term: null, sort: null, tab:null};
    if (!raw) return {intent: 'help', entities: ent, score: 0, sure: true, suggestions: []};
    const norm = correct(normalize(raw), I);
    const ex = extract(raw, norm, I);
    ent.tickers = ex.tickers;
    const t = ex.rest;                      // company names blanked out so "bank of america" is not a sector
    ent.sector = sectorOf(t);
    ent.card = firstMatch(t, CARD_WORDS);
    ent.period = firstMatch(t, PERIOD_WORDS);
    ent.term = firstMatch(t, GLOSSARY_WORDS);
    ent.tab = R('strategies|strategy tab').test(t) ? 'strategies' : R('technicals|technical tab').test(t) ? 'technicals' : null;
    const sm = t.match(R('(?:sort|rank|order)(?: \\w+)? by (score|pe|price|change|market cap|size|valuation|rating)|(?:lowest|cheapest) pe|by (score|pe)'));
    if (sm) ent.sort = (sm[1] || sm[2] || 'pe').replace('market cap', 'mcap').replace('size', 'mcap').replace('valuation', 'pe');
    else if (R('sort|rank|order').test(t) && ent.term === 'score') ent.sort = 'score';

    const nT = ent.tickers.length;
    const S = {};
    for (const id in KW) { let s = 0; for (const [re, w] of KW[id]) if (re.test(t)) s += w; S[id] = s; }
    // entity-driven adjustments
    if (nT >= 1) {
      S.ticker_summary += 1.2;
      if(ent.tab && R('open|go to|take me|pull up|bring up|show').test(t))S.open_ticker+=6;
      if (ent.card) S.ticker_card = 2.6;
      if (R('report\\w*|earnings|results').test(t) && R('when|date|next|day|does|is').test(t) && ent.card !== 'growth') S.earnings_date += 1;
      for (const k of ['pulse', 'macro', 'risk_conditions', 'risks', 'breadth', 'sectors', 'top_scores', 'valuation_peers', 'freshness', 'switch_period', 'expand_macro', 'help', 'watchlist_show'])
        S[k] -= 2;
      if (R('shortlist').test(t)) S.shortlist += 1; else S.shortlist -= 2;
      if (ent.card === 'growth' && R('earnings growth|eps growth|revenue').test(t)) S.earnings_date -= 2;
    } else {
      for (const k of TICKER_INTENTS) S[k] = -9;
      S.ticker_card = -9;
    }
    if (nT >= 2) S.compare += 3; else S.compare = -9;
    if (nT >= 2 && S.compare > 0 && !R('watchlist|open|add|remove').test(t)) S.compare += 1;
    if (ent.sector) {
      if (R('doing|performing|perform|how is|how are|lead\\w*|lag\\w*').test(t)) S.sectors += 2;
      if (S.valuation_peers > 0) S.valuation_peers += 1;
      if (S.top_scores > 0) S.top_scores += 0.6;
    } else S.show_sector = -9;
    if (ent.sector && nT === 0 && S.sort_filter <= 0 && S.show_sector >= 1.5 && !R('doing|performing|perform|how is|how are|lead\\w*|lag\\w*').test(t)) S.show_sector += 1.5;
    if (!ent.period) S.switch_period = -9; else S.switch_period += 1.5;
    // glossary: define/explain/mean, or "what is (a) <term>" with little else in the message
    if (ent.term && nT === 0) {
      const strong = R('define|definition|explain|meaning|mean|stand for|what are').test(t);
      const short = t.match(new RegExp('what is (?:an? |the )?(.*)$'));
      if (strong) S.glossary = 4;
      else if (short && short[1].trim().split(' ').length <= 3) S.glossary = 3.4;
      else S.glossary = 0;
      if (ent.term === 'score' && S.provenance > 0) S.glossary = 0;
    } else S.glossary = -9;
    if (R('watch\\w*|follow\\w*|track\\w*|pin\\w*').test(t) && nT >= 1) S.watch_add += 1;
    if (S.watch_remove >= 3.5) S.watch_add = Math.min(S.watch_add, 1); else S.watch_remove = Math.min(S.watch_remove, 1);
    if (S.sort_filter > 0) { S.show_sector -= 2; S.open_ticker -= 1; }
    if (S.expand_macro >= 2 && R('macro').test(t)) S.macro -= 1;

    const ranked = Object.keys(S).filter(k => BY_ID[k]).sort((a, b) => S[b] - S[a] || CATALOG.indexOf(BY_ID[a]) - CATALOG.indexOf(BY_ID[b]));
    let intent = ranked[0], score = S[intent];
    const sure = score >= 1.5;
    if (!sure) {
      if (nT === 1) { intent = 'ticker_summary'; score = 1.2; }
      else if (nT >= 2) intent = 'compare';
      else intent = 'unknown';
    }
    if (intent === 'ticker_card' && !ent.card) intent = 'ticker_summary';
    const suggestions = ranked.filter(k => S[k] > 0 && k !== intent).slice(0, 3);
    return {intent, entities: ent, score: Math.round(score * 10) / 10, sure: intent !== 'unknown', suggestions, normalized: t.trim()};
  }

  // fill a catalog chip with tickers from context: chipText('price', {T:'AAPL'})
  function chipText(id, fill) {
    const c = BY_ID[id]; if (!c) return '';
    return c.chip.replace('{T}', (fill && fill.T) || 'AAPL').replace('{U}', (fill && fill.U) || 'MSFT');
  }
  // validate a model-proposed {intent, entities}; returns a clean object or null
  function validate(obj, ctx) {
    if (!obj || typeof obj !== 'object' || !BY_ID[obj.intent]) return null;
    const I = index((ctx && ctx.universe) || []);
    const e = obj.entities && typeof obj.entities === 'object' ? obj.entities : {};
    if(e.tab && !['overview','technicals','strategies'].includes(e.tab))return null;
    if(e.sort && !['pe','price','change','mcap','rating'].includes(e.sort))return null;
    const tickers = (Array.isArray(e.tickers) ? e.tickers : []).map(x => String(x).toUpperCase().replace('.', '-')).filter(x => I.syms.has(x)).slice(0, 2);
    const out = {intent: obj.intent, entities: {tickers, sector: SECTORS.includes(e.sector) ? e.sector : null, card: CARDS.includes(e.card) ? e.card : null,
      period: ['1D', '1W', '1M'].includes(e.period) ? e.period : null, term: GLOSSARY_WORDS.some(g => g[0] === e.term) ? e.term : null,
      sort: ['pe','price','change','mcap','rating'].includes(e.sort) ? e.sort : null,
      tab: ['overview','technicals','strategies'].includes(e.tab) ? e.tab : null}};
    const need = BY_ID[obj.intent].need;
    if (need === 'ticker' && !tickers.length) return null;
    if (need === 'two' && tickers.length < 2) return null;
    if (need === 'sector' && !out.entities.sector) return null;
    if (need === 'period' && !out.entities.period) return null;
    if (need === 'term' && !out.entities.term) return null;
    if (obj.intent === 'ticker_card' && !out.entities.card) return null;
    return out;
  }
  return {CATALOG, BY_ID, CARDS, SECTORS, GLOSSARY_TERMS: GLOSSARY_WORDS.map(g => g[0]), route, chipText, validate, normalize, osa, _index: index};
});
