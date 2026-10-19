/* SmartOptions V2 - Strategy engine (lane R7).
   window.SmartOptionsStrategies = {list(), get(id), recommend(ctx), payoff(strategyOrId, params), RULES, mount(el, ticker)}
   An expansive LIBRARY of stock/option structures, each with a plain-English explainer, the view it expresses
   (direction x vol x time), when it tends to fit, payoff shape, max gain/loss, breakevens, risks and
   tax/assignment notes. recommend(ctx) ranks them with explicit, visible scoring RULES (below).
   payoff() prices legs with Black-Scholes from the STORED price + ATM IV on a MODEL strike grid.
   No option chain is stored: every premium / probability is a MODEL ESTIMATE, never a market quote,
   and with no IV we refuse to price options instead of guessing. Education, not orders. */
(function (root) {
'use strict';
const isNum = x => typeof x === 'number' && isFinite(x);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const MODEL_LABEL = 'model estimate from price + IV (Black-Scholes, flat IV across strikes, no dividends), not a market quote';

/* ---------------- Black-Scholes ---------------- */
function erf(x) { // Abramowitz & Stegun 7.1.26, |error| < 1.5e-7
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
const N = x => 0.5 * (1 + erf(x / Math.SQRT2));
function bs(type, S, K, T, r, sig) {
  if (type === 'stock') return S;
  if (!(T > 0) || !(sig > 0)) return Math.max(0, type === 'call' ? S - K : K - S);
  if (S <= 0) return type === 'call' ? 0 : K * Math.exp(-r * T);
  const v = sig * Math.sqrt(T), d1 = (Math.log(S / K) + (r + sig * sig / 2) * T) / v, d2 = d1 - v;
  return type === 'call' ? S * N(d1) - K * Math.exp(-r * T) * N(d2) : K * Math.exp(-r * T) * N(-d2) - S * N(-d1);
}
// risk-neutral lognormal P(S_T > K)
function probAbove(S, K, T, r, sig) { if (!(K > 0)) return 1; if (!(T > 0) || !(sig > 0)) return S > K ? 1 : 0; return N((Math.log(S / K) + (r - sig * sig / 2) * T) / (sig * Math.sqrt(T))); }
// listed-style strike increments: an approximation of common US equity listings (real chains vary by name)
function strikeInc(S) { return S < 25 ? 0.5 : S < 100 ? 1 : S < 250 ? 2.5 : S < 1000 ? 5 : 10; }
const roundTo = (x, inc) => Math.round(x / inc) * inc;

/* ---------------- library ----------------
   Fields: id, name, family, level, dir (-1 bearish .. +1 bullish, null = not a directional trade),
   vol (+1 long vol, -1 short vol, 0 none), theta (+1 earns time decay, -1 pays it, 0), risk ('defined'|'undefined'|'stock'|'none'),
   offs (strike offsets in 1-sigma expected-move units, ascending), legs [{type, side (+1 long/-1 short), qty, k (index into offs), far}],
   fits (when it tends to fit), shape, maxGain, maxLoss, be (breakeven formulas), risks, tax, plain (one-liner). */
const L = (type, side, qty, k, far) => ({type, side, qty, k, far: !!far});
const LIB = [
  {id: 'long_stock', name: 'Long stock', family: 'Stock', level: 'beginner', dir: 1, vol: 0, theta: 0, risk: 'stock', offs: [], legs: [L('stock', 1, 1)],
    plain: 'Buy the shares; you make what the stock makes.', fits: 'bullish view, any vol; no expiry so time is on your side if the thesis is slow',
    shape: 'straight line up and to the right', maxGain: 'unlimited', maxLoss: 'price paid (stock to 0)', be: 'entry price', risks: 'full downside, gap risk', tax: 'long-term rate after 1 year held (US)'},
  {id: 'short_stock', name: 'Short stock', family: 'Stock', level: 'advanced', dir: -1, vol: 0, theta: 0, risk: 'undefined', offs: [], legs: [L('stock', -1, 1)],
    plain: 'Borrow and sell shares, hoping to buy back lower.', fits: 'bearish view with conviction; borrow available', shape: 'straight line down and to the right',
    maxGain: 'entry price (stock to 0)', maxLoss: 'unlimited', be: 'entry price', risks: 'unlimited loss, borrow fees, recalls, squeezes, dividends owed', tax: 'short-term gains; dividends paid in lieu'},
  {id: 'long_call', name: 'Long call', family: 'Single option', level: 'beginner', dir: 0.9, vol: 1, theta: -1, risk: 'defined', offs: [0.5], legs: [L('call', 1, 1, 0)],
    plain: 'Pay a premium for the right to buy higher; leveraged upside, loss capped at the premium.', fits: 'bullish with a catalyst; IV cheap vs realized',
    shape: 'flat loss below strike, rising line above', maxGain: 'unlimited', maxLoss: 'premium paid', be: 'strike + premium', risks: 'time decay; needs the move before expiry', tax: 'short-term unless held > 1y'},
  {id: 'long_put', name: 'Long put', family: 'Single option', level: 'beginner', dir: -0.9, vol: 1, theta: -1, risk: 'defined', offs: [-0.5], legs: [L('put', 1, 1, 0)],
    plain: 'Pay a premium for the right to sell lower; profits from a drop, loss capped.', fits: 'bearish with a catalyst; IV cheap vs realized',
    shape: 'rising line below strike, flat loss above', maxGain: 'strike - premium (stock to 0)', maxLoss: 'premium paid', be: 'strike - premium', risks: 'time decay', tax: 'can affect holding period of stock you own (straddle rules)'},
  {id: 'covered_call', name: 'Covered call', family: 'Income', level: 'beginner', dir: 0.4, vol: -1, theta: 1, risk: 'stock', offs: [0.5], legs: [L('stock', 1, 1), L('call', -1, 1, 0)],
    plain: 'Own the shares and sell a call above: collect premium, cap your upside at the strike.', fits: 'mildly bullish / flat; IV rich vs realized; happy to sell at the strike (e.g. near resistance)',
    shape: 'stock line that flattens above the strike', maxGain: 'strike - entry + premium', maxLoss: 'entry - premium (stock to 0)', be: 'entry - premium', risks: 'downside of the stock, upside capped, early assignment before ex-dividend', tax: 'in-the-money calls can be non-qualified covered calls (holding-period rules)'},
  {id: 'cash_secured_put', name: 'Cash-secured put', family: 'Income', level: 'beginner', dir: 0.5, vol: -1, theta: 1, risk: 'defined', offs: [-0.5], legs: [L('put', -1, 1, 0)],
    plain: 'Sell a put below the price with cash set aside: paid to wait, may buy the stock at the strike.', fits: 'neutral-to-bullish; IV rich; a price you would happily buy at (e.g. near support)',
    shape: 'flat gain above strike, falling line below', maxGain: 'premium', maxLoss: 'strike - premium (stock to 0)', be: 'strike - premium', risks: 'assignment in a selloff; cash tied up', tax: 'premium reduces cost basis if assigned'},
  {id: 'wheel', name: 'Cash-secured wheel', family: 'Income', level: 'intermediate', dir: 0.4, vol: -1, theta: 1, risk: 'defined', offs: [-0.5], legs: [L('put', -1, 1, 0)],
    plain: 'Cycle: sell puts until assigned, then sell covered calls until called away, repeat. First leg shown.', fits: 'neutral-to-bullish on a stock you want to own long-term; IV rich',
    shape: 'per cycle: short put, then covered call', maxGain: 'premium per cycle', maxLoss: 'strike - premiums (stock to 0)', be: 'strike - accumulated premium', risks: 'ends up holding a falling stock', tax: 'each leg is its own taxable event'},
  {id: 'protective_put', name: 'Protective put', family: 'Hedge', level: 'beginner', dir: 0.6, vol: 1, theta: -1, risk: 'stock', offs: [-0.5], legs: [L('stock', 1, 1), L('put', 1, 1, 0)],
    plain: 'Own the stock and buy a put: insurance with a floor under your loss.', fits: 'bullish long-term but worried near-term (earnings, macro risk-off); IV cheap',
    shape: 'stock line with a floor below the put strike', maxGain: 'unlimited (minus premium)', maxLoss: 'entry - strike + premium', be: 'entry + premium', risks: 'premium drag if nothing happens', tax: 'can suspend the stock holding period (US straddle rules)'},
  {id: 'married_put', name: 'Married put', family: 'Hedge', level: 'beginner', dir: 0.6, vol: 1, theta: -1, risk: 'stock', offs: [-0.5], legs: [L('stock', 1, 1), L('put', 1, 1, 0)],
    plain: 'Buy stock and a put on the same day; same payoff as a protective put, opened together.', fits: 'new bullish position where you want the max loss known from day one',
    shape: 'stock line with a floor', maxGain: 'unlimited (minus premium)', maxLoss: 'entry - strike + premium', be: 'entry + premium', risks: 'premium drag', tax: 'put premium added to stock basis when identified same day (US)'},
  {id: 'collar', name: 'Collar', family: 'Hedge', level: 'intermediate', dir: 0.3, vol: 0, theta: 0, risk: 'stock', offs: [-0.5, 0.5], legs: [L('stock', 1, 1), L('put', 1, 1, 0), L('call', -1, 1, 1)],
    plain: 'Own the stock, buy a put below and sell a call above: the call pays for the floor.', fits: 'protect gains on a big winner; risk-off regime; low-cost hedge',
    shape: 'flat floor below, flat cap above, stock line between', maxGain: 'call strike - entry + net credit', maxLoss: 'entry - put strike - net credit', be: 'entry - net credit', risks: 'upside capped', tax: 'tight collars can trigger constructive-sale rules'},
  {id: 'bull_call_spread', name: 'Bull call spread', family: 'Vertical', level: 'intermediate', dir: 0.8, vol: 0, theta: -0.3, risk: 'defined', offs: [0, 1], legs: [L('call', 1, 1, 0), L('call', -1, 1, 1)],
    plain: 'Buy a call, sell a higher call: cheaper bullish bet with a capped payoff.', fits: 'bullish to a target; IV middling or rich (selling the upper call offsets cost)',
    shape: 'loss floor, ramp, gain ceiling', maxGain: 'width - debit', maxLoss: 'debit', be: 'lower strike + debit', risks: 'needs move by expiry', tax: 'short-term'},
  {id: 'bear_put_spread', name: 'Bear put spread', family: 'Vertical', level: 'intermediate', dir: -0.8, vol: 0, theta: -0.3, risk: 'defined', offs: [-1, 0], legs: [L('put', -1, 1, 0), L('put', 1, 1, 1)],
    plain: 'Buy a put, sell a lower put: cheaper bearish bet with a capped payoff.', fits: 'bearish to a target; defined risk',
    shape: 'gain ceiling, ramp, loss floor', maxGain: 'width - debit', maxLoss: 'debit', be: 'upper strike - debit', risks: 'needs move by expiry', tax: 'short-term'},
  {id: 'bull_put_spread', name: 'Bull put spread (credit)', family: 'Vertical', level: 'intermediate', dir: 0.6, vol: -1, theta: 1, risk: 'defined', offs: [-1.5, -0.5], legs: [L('put', 1, 1, 0), L('put', -1, 1, 1)],
    plain: 'Sell a put and buy a lower put: collect premium if the stock stays above, risk capped.', fits: 'neutral-to-bullish; IV rich; support below the short strike',
    shape: 'loss floor below, ramp, flat gain above', maxGain: 'credit', maxLoss: 'width - credit', be: 'short strike - credit', risks: 'assignment near expiry; loss larger than gain', tax: 'short-term'},
  {id: 'bear_call_spread', name: 'Bear call spread (credit)', family: 'Vertical', level: 'intermediate', dir: -0.6, vol: -1, theta: 1, risk: 'defined', offs: [0.5, 1.5], legs: [L('call', -1, 1, 0), L('call', 1, 1, 1)],
    plain: 'Sell a call and buy a higher call: collect premium if the stock stays below, risk capped.', fits: 'neutral-to-bearish; IV rich; resistance above the short strike',
    shape: 'flat gain below, ramp, loss floor above', maxGain: 'credit', maxLoss: 'width - credit', be: 'short strike + credit', risks: 'squeeze through the short strike', tax: 'short-term'},
  {id: 'calendar', name: 'Calendar (time) spread', family: 'Time spread', level: 'advanced', dir: 0, vol: 1, theta: 1, risk: 'defined', offs: [0], legs: [L('call', -1, 1, 0), L('call', 1, 1, 0, true)],
    plain: 'Sell a near-dated option and buy a later one at the same strike: profits if the stock sits near the strike.', fits: 'neutral near term; near-dated IV rich vs later-dated (needs a term structure we do not store)',
    shape: 'tent peaked at the strike (valued with Black-Scholes at the near expiry)', maxGain: 'model-dependent (near the strike)', maxLoss: 'debit', be: 'model-dependent, both sides of the strike', risks: 'big move either way; IV crush in the back month', tax: 'short-term'},
  {id: 'diagonal', name: 'Diagonal spread', family: 'Time spread', level: 'advanced', dir: 0.4, vol: 1, theta: 1, risk: 'defined', offs: [0, 0.5], legs: [L('call', 1, 1, 0, true), L('call', -1, 1, 1)],
    plain: 'Buy a later-dated call and sell a nearer, higher call: a slow-bullish calendar.', fits: 'mildly bullish drift to the short strike; term structure favourable',
    shape: 'skewed tent peaked near the short strike', maxGain: 'model-dependent', maxLoss: 'debit', be: 'model-dependent', risks: 'fast move through the short strike; back-month IV drop', tax: 'short-term'},
  {id: 'pmcc', name: "Poor man's covered call", family: 'Time spread', level: 'advanced', dir: 0.6, vol: 0, theta: 1, risk: 'defined', offs: [-1.5, 0.5], legs: [L('call', 1, 1, 0, true), L('call', -1, 1, 1)],
    plain: 'A deep in-the-money long-dated call stands in for the shares; sell short-dated calls against it.', fits: 'mildly bullish, less capital than a covered call; IV rich in the front month',
    shape: 'like a covered call with a smaller, model-dependent floor', maxGain: 'model-dependent', maxLoss: 'debit', be: 'model-dependent', risks: 'sharp drop erodes the long call; early assignment of the short', tax: 'short-term'},
  {id: 'long_straddle', name: 'Long straddle', family: 'Volatility', level: 'intermediate', dir: 0, vol: 1, theta: -1, risk: 'defined', offs: [0, 0], legs: [L('call', 1, 1, 0), L('put', 1, 1, 1)],
    plain: 'Buy a call and a put at the same strike: pays if the stock moves a lot either way.', fits: 'big move expected, direction unknown; IV cheap vs realized; catalyst ahead',
    shape: 'V with the low point at the strike', maxGain: 'unlimited', maxLoss: 'total debit', be: 'strike +/- debit', risks: 'IV crush after the event; decay', tax: 'straddle rules'},
  {id: 'short_straddle', name: 'Short straddle', family: 'Volatility', level: 'advanced', dir: 0, vol: -1, theta: 1, risk: 'undefined', offs: [0, 0], legs: [L('call', -1, 1, 0), L('put', -1, 1, 1)],
    plain: 'Sell a call and a put at the same strike: collect a lot of premium if the stock goes nowhere.', fits: 'range-bound, IV rich, no catalyst',
    shape: 'inverted V peaked at the strike', maxGain: 'total credit', maxLoss: 'unlimited', be: 'strike +/- credit', risks: 'unlimited loss, gaps', tax: 'straddle rules'},
  {id: 'long_strangle', name: 'Long strangle', family: 'Volatility', level: 'intermediate', dir: 0, vol: 1, theta: -1, risk: 'defined', offs: [-1, 1], legs: [L('put', 1, 1, 0), L('call', 1, 1, 1)],
    plain: 'Buy an out-of-the-money put and call: a cheaper bet on a big move either way.', fits: 'catalyst ahead, IV not rich; move expected beyond the 1-sigma band',
    shape: 'wide-bottomed V', maxGain: 'unlimited', maxLoss: 'total debit', be: 'put strike - debit, call strike + debit', risks: 'needs a move larger than the band', tax: 'straddle rules'},
  {id: 'short_strangle', name: 'Short strangle', family: 'Volatility', level: 'advanced', dir: 0, vol: -1, theta: 1, risk: 'undefined', offs: [-1, 1], legs: [L('put', -1, 1, 0), L('call', -1, 1, 1)],
    plain: 'Sell an out-of-the-money put and call: paid while the stock stays inside the band.', fits: 'range-bound, IV rich, no earnings in the window',
    shape: 'flat-topped inverted V', maxGain: 'total credit', maxLoss: 'unlimited', be: 'put strike - credit, call strike + credit', risks: 'unlimited loss, gaps', tax: 'straddle rules'},
  {id: 'iron_condor', name: 'Iron condor', family: 'Volatility', level: 'intermediate', dir: 0, vol: -1, theta: 1, risk: 'defined', offs: [-1.5, -1, 1, 1.5], legs: [L('put', 1, 1, 0), L('put', -1, 1, 1), L('call', -1, 1, 2), L('call', 1, 1, 3)],
    plain: 'A short strangle with wings bought further out: range-bound income with a capped loss.', fits: 'range-bound, IV rich, no catalyst; defined risk wanted',
    shape: 'flat top between the short strikes, flat floors beyond the wings', maxGain: 'net credit', maxLoss: 'wing width - credit', be: 'short put - credit, short call + credit', risks: 'loss usually larger than gain; pin risk', tax: 'short-term'},
  {id: 'iron_butterfly', name: 'Iron butterfly', family: 'Volatility', level: 'intermediate', dir: 0, vol: -1, theta: 1, risk: 'defined', offs: [-1, 0, 0, 1], legs: [L('put', 1, 1, 0), L('put', -1, 1, 1), L('call', -1, 1, 2), L('call', 1, 1, 3)],
    plain: 'Sell an at-the-money straddle and buy wings: bigger credit than a condor, narrower profit zone.', fits: 'pinned stock, IV rich, no catalyst',
    shape: 'tent peaked at the middle strike', maxGain: 'net credit', maxLoss: 'wing width - credit', be: 'middle strike +/- credit', risks: 'small profit zone', tax: 'short-term'},
  {id: 'butterfly', name: 'Long call butterfly', family: 'Volatility', level: 'intermediate', dir: 0, vol: -0.5, theta: 1, risk: 'defined', offs: [-1, 0, 1], legs: [L('call', 1, 1, 0), L('call', -1, 2, 1), L('call', 1, 1, 2)],
    plain: 'Buy one low call, sell two middle, buy one high: a cheap bet the stock finishes near the middle.', fits: 'price target / pin expected; cheap debit',
    shape: 'tent peaked at the middle strike', maxGain: 'wing width - debit', maxLoss: 'debit', be: 'lower + debit, upper - debit', risks: 'rarely pays the max', tax: 'short-term'},
  {id: 'bwb', name: 'Broken-wing put butterfly', family: 'Volatility', level: 'advanced', dir: 0.3, vol: -1, theta: 1, risk: 'defined', offs: [-1.5, -0.5, 0], legs: [L('put', 1, 1, 0), L('put', -1, 2, 1), L('put', 1, 1, 2)],
    plain: 'A put butterfly with a wider lower wing: often opened for a credit, no risk above, more risk below.', fits: 'neutral-to-bullish, IV rich; wants no upside risk',
    shape: 'flat above, tent at the middle strike, lower floor below', maxGain: 'upper width + net credit', maxLoss: 'lower width - upper width - net credit', be: 'model strikes dependent', risks: 'sharp drop', tax: 'short-term'},
  {id: 'jade_lizard', name: 'Jade lizard', family: 'Volatility', level: 'advanced', dir: 0.3, vol: -1, theta: 1, risk: 'undefined', offs: [-1, 0.5, 1], legs: [L('put', -1, 1, 0), L('call', -1, 1, 1), L('call', 1, 1, 2)],
    plain: 'Short put plus a short call spread: if total credit >= call-spread width there is no upside risk.', fits: 'neutral-to-bullish, IV rich, no catalyst',
    shape: 'flat-ish top, falling line below the put', maxGain: 'net credit', maxLoss: 'put strike - credit (stock to 0)', be: 'put strike - credit', risks: 'downside like a short put', tax: 'short-term'},
  {id: 'call_ratio', name: 'Call ratio spread (1x2)', family: 'Ratio', level: 'advanced', dir: 0.3, vol: -1, theta: 1, risk: 'undefined', offs: [0, 1], legs: [L('call', 1, 1, 0), L('call', -2, 1, 1)],
    plain: 'Buy one call, sell two higher calls: profits from a modest rise, loses on a big rally.', fits: 'mildly bullish to a target, IV rich',
    shape: 'tent peaked at the short strike, falling line above', maxGain: 'width + net credit', maxLoss: 'unlimited above', be: 'upper strike + max gain', risks: 'unlimited upside loss', tax: 'short-term'},
  {id: 'put_ratio', name: 'Put ratio spread (1x2)', family: 'Ratio', level: 'advanced', dir: -0.3, vol: -1, theta: 1, risk: 'undefined', offs: [-1, 0], legs: [L('put', -2, 1, 0), L('put', 1, 1, 1)],
    plain: 'Buy one put, sell two lower puts: profits from a modest dip, loses on a crash.', fits: 'mildly bearish to a target, IV rich (put skew helps)',
    shape: 'tent peaked at the lower strike, falling line below', maxGain: 'width + net credit', maxLoss: 'lower strike - max gain (stock to 0)', be: 'lower strike - max gain', risks: 'crash risk', tax: 'short-term'},
  {id: 'call_backspread', name: 'Call backspread (1x2)', family: 'Ratio', level: 'advanced', dir: 0.6, vol: 1, theta: -1, risk: 'defined', offs: [0, 1], legs: [L('call', -1, 1, 0), L('call', 2, 1, 1)],
    plain: 'Sell one call, buy two higher calls: cheap or free bet on a big rally.', fits: 'explosive upside expected, IV cheap',
    shape: 'small flat result below, dip at the upper strike, rising line above', maxGain: 'unlimited', maxLoss: 'width - net credit (at the upper strike)', be: 'model strikes dependent', risks: 'worst case is a modest rally', tax: 'short-term'},
  {id: 'put_backspread', name: 'Put backspread (1x2)', family: 'Ratio', level: 'advanced', dir: -0.6, vol: 1, theta: -1, risk: 'defined', offs: [-1, 0], legs: [L('put', 2, 1, 0), L('put', -1, 1, 1)],
    plain: 'Sell one put, buy two lower puts: crash protection that costs little if nothing happens.', fits: 'crash / risk-off hedge, IV cheap',
    shape: 'rising line below, dip at the lower strike, small flat result above', maxGain: '2 x lower strike - upper strike + net credit (stock to 0)', maxLoss: 'width - net credit (at the lower strike)', be: 'model strikes dependent', risks: 'worst case is a modest dip', tax: 'short-term'},
  {id: 'synthetic_long', name: 'Synthetic long stock', family: 'Synthetic', level: 'advanced', dir: 1, vol: 0, theta: 0, risk: 'undefined', offs: [0, 0], legs: [L('call', 1, 1, 0), L('put', -1, 1, 1)],
    plain: 'Buy a call and sell a put at the same strike: behaves like owning the stock with less cash up front.', fits: 'bullish, margin available',
    shape: 'straight line like stock', maxGain: 'unlimited', maxLoss: 'strike + net debit (stock to 0)', be: 'strike + net debit', risks: 'margin calls, assignment', tax: 'short-term'},
  {id: 'synthetic_short', name: 'Synthetic short stock', family: 'Synthetic', level: 'advanced', dir: -1, vol: 0, theta: 0, risk: 'undefined', offs: [0, 0], legs: [L('put', 1, 1, 0), L('call', -1, 1, 1)],
    plain: 'Buy a put and sell a call at the same strike: behaves like a short sale without borrowing shares.', fits: 'bearish; hard-to-borrow stock',
    shape: 'straight line down', maxGain: 'strike - net debit (stock to 0)', maxLoss: 'unlimited', be: 'strike - net debit', risks: 'unlimited loss, assignment', tax: 'short-term'},
  {id: 'pairs_relative', name: 'Pairs / sector-relative idea', family: 'Relative value', level: 'advanced', dir: null, vol: 0, theta: 0, risk: 'undefined', offs: [], legs: [], noPayoff: 'needs a second leg (sector ETF or peer) whose price we do not combine here',
    plain: 'Long the leader and short its sector (or a lagging peer): bets on the spread, not the market.', fits: 'stock clearly leading or lagging its sector; market direction unclear',
    shape: 'depends on the spread between the two legs', maxGain: 'spread dependent', maxLoss: 'spread dependent (short leg is unlimited)', be: 'entry spread', risks: 'both legs can move against you; correlation breaks', tax: 'two separate positions'},
  {id: 'rate_tilt', name: 'Rate-sensitive tilt', family: 'Macro tilt', level: 'intermediate', dir: null, vol: 0, theta: 0, risk: 'stock', offs: [], legs: [], noPayoff: 'a portfolio tilt, not a single payoff',
    plain: 'Lean toward or away from rate-sensitive sectors (utilities, real estate, financials) as yields move.', fits: 'a clear 10-year yield trend and a rate-sensitive name',
    shape: 'portfolio weight change', maxGain: 'n/a', maxLoss: 'n/a', be: 'n/a', risks: 'rates can reverse; sector moves for other reasons', tax: 'rebalancing creates taxable events'},
  {id: 'cash_defensive', name: 'Cash / defensive (no trade)', family: 'Defensive', level: 'beginner', dir: null, vol: 0, theta: 0, risk: 'none', offs: [], legs: [],
    plain: 'Do nothing, hold cash or T-bills: sometimes the best trade is no trade.', fits: 'risk-off market, conflicting signals, event risk, or low conviction',
    shape: 'flat line (earns the T-bill rate)', maxGain: 'T-bill yield', maxLoss: 'opportunity cost', be: 'n/a', risks: 'missing a rally', tax: 'interest taxed as income'},
];
const BY = Object.fromEntries(LIB.map(s => [s.id, s]));
function list() { return LIB.map(s => Object.assign({}, s, {legs: s.legs.map(l => Object.assign({}, l))})); }
function get(id) { return BY[id] || null; }

/* ---------------- payoff ----------------
   params: {S (price), iv (ATM IV, percent e.g. 32.5), days (to the near expiry), r (decimal; default 0 if not given),
            farDays (back-month for time spreads; default max(2*days, days+30), PMCC default max(4*days, 180)),
            strikes (override, ascending in the strategy's offs order), premiums (override per leg, per share; label becomes user-entered)} */
function payoff(strat, params) {
  const s = typeof strat === 'string' ? BY[strat] : strat; params = params || {};
  if (!s) return {ok: false, reason: 'unknown strategy'};
  const S = params.S, days = isNum(params.days) && params.days > 0 ? params.days : 30, r = isNum(params.r) ? params.r : 0;
  const ivPct = params.iv, sig = isNum(ivPct) && ivPct > 0 ? ivPct / 100 : null, T = days / 365;
  const out = {ok: false, id: s.id, name: s.name, S, days, r, iv: ivPct, label: MODEL_LABEL, warnings: [], method: ''};
  if (!isNum(S) || S <= 0) return Object.assign(out, {reason: 'no stored price'});
  if (s.noPayoff) return Object.assign(out, {reason: s.noPayoff});
  if (!s.legs.length) return Object.assign(out, {ok: true, legs: [], strikes: [], net: 0, grid: [[0, 0], [2 * S, 0]], maxGain: 0, maxLoss: 0, breakevens: [], pop: null, expMove: null, probAbove: [], returnOnRisk: null, pnlAt: () => 0, method: 'no position'});
  const hasOpt = s.legs.some(l => l.type !== 'stock');
  const userPrem = Array.isArray(params.premiums) && params.premiums.length === s.legs.length && params.premiums.every(isNum);
  if (hasOpt && !sig && !userPrem) return Object.assign(out, {reason: 'IV missing for this ticker: option premiums and probabilities are not estimated (no chain stored, nothing fabricated)'});
  const farDays = isNum(params.farDays) ? params.farDays : s.id === 'pmcc' ? Math.max(4 * days, 180) : Math.max(2 * days, days + 30), Tf = farDays / 365;
  const sd = sig ? S * sig * Math.sqrt(T) : null, inc = strikeInc(S);
  let K;
  if (Array.isArray(params.strikes) && params.strikes.length === s.offs.length) K = params.strikes.slice();
  else {
    if (!sd && s.offs.length) return Object.assign(out, {reason: 'strike grid needs IV (expected move) or explicit strikes'});
    K = s.offs.map(o => roundTo(S + o * sd, inc));
    for (let i = 1; i < K.length; i++) if (s.offs[i] > s.offs[i - 1] && K[i] <= K[i - 1]) K[i] = K[i - 1] + inc; // keep distinct after rounding
    for (let i = 0; i < K.length; i++) if (K[i] <= 0) K[i] = inc;
    if (sd) out.method = `strikes = price + offset x 1-sigma expected move (${sd.toFixed(2)} = price x IV x sqrt(${days}/365)), rounded to $${inc} (listed-style increment, approximate)`;
  }
  const legs = s.legs.map((l, i) => {
    const k = l.type === 'stock' ? null : K[l.k], tt = l.far ? Tf : T;
    const prem = userPrem ? params.premiums[i] : l.type === 'stock' ? S : bs(l.type, S, k, tt, r, sig);
    return {type: l.type, side: l.side > 0 ? 1 : -1, qty: Math.abs(l.side) * l.qty, k, days: l.type === 'stock' ? null : l.far ? farDays : days, far: l.far, prem};
  });
  if (userPrem) out.label = 'user-entered premiums (not verified by the dashboard)';
  const net = legs.reduce((a, l) => a + (l.type === 'stock' ? 0 : -l.side * l.qty * l.prem), 0); // + = credit received, - = debit paid (per share)
  const timeSpread = legs.some(l => l.far);
  if (timeSpread && !sig) return Object.assign(out, {reason: 'time spreads need IV to value the back month at the near expiry'});
  const pnl = ST => legs.reduce((a, l) => {
    const val = l.type === 'stock' ? ST : l.far ? bs(l.type, ST, l.k, Tf - T, r, sig) : Math.max(0, l.type === 'call' ? ST - l.k : l.k - ST);
    return a + l.side * l.qty * (val - l.prem);
  }, 0);
  const strikes = legs.filter(l => l.k != null).map(l => l.k);
  const hiX = Math.max(3 * S, ...strikes.map(k => 2 * k));
  const pts = new Set([0, S, hiX, ...strikes]);
  const steps = timeSpread ? 1200 : 400;
  for (let i = 1; i < steps; i++) pts.add(hiX * i / steps);
  const xs = [...pts].sort((a, b) => a - b), grid = xs.map(x => [x, pnl(x)]);
  // unlimited if the payoff keeps sloping beyond the grid (linear tail)
  const slopeR = (pnl(hiX * 2) - pnl(hiX)) / hiX;
  let mg = -Infinity, ml = Infinity; for (const [, y] of grid) { mg = Math.max(mg, y); ml = Math.min(ml, y); }
  const maxGain = slopeR > 1e-6 ? Infinity : mg, maxLoss = slopeR < -1e-6 ? -Infinity : ml;
  const be = [];
  for (let i = 1; i < grid.length; i++) {
    const [x0, y0] = grid[i - 1], [x1, y1] = grid[i];
    if (Math.abs(y0) < 1e-9 && i > 1 && Math.abs(grid[i - 2][1]) > 1e-9) be.push(x0);
    else if (y0 * y1 < 0) be.push(x0 + (x1 - x0) * (-y0) / (y1 - y0));
  }
  const bes = be.filter((x, i) => i === 0 || Math.abs(x - be[i - 1]) > 1e-6);
  let pop = null;
  if (sig) { // risk-neutral probability the position finishes the near expiry in profit
    const edges = [0, ...bes, Infinity]; pop = 0;
    for (let i = 0; i < edges.length - 1; i++) {
      const a = edges[i], b = edges[i + 1], mid = b === Infinity ? Math.max(a * 1.5, S * 2) : a === 0 ? b / 2 : (a + b) / 2;
      if (pnl(mid) > 1e-9) pop += probAbove(S, a, T, r, sig) - (b === Infinity ? 0 : probAbove(S, b, T, r, sig));
    }
  }
  const em = sig ? {sd, lo: S * Math.exp(-sig * Math.sqrt(T)), hi: S * Math.exp(sig * Math.sqrt(T)), method: '1-sigma lognormal band S x exp(+/- IV x sqrt(T)), ~68% under the model'} : null;
  const pAbove = sig ? strikes.filter((k, i, a) => a.indexOf(k) === i).map(k => ({k, p: probAbove(S, k, T, r, sig)})) : [];
  const ror = isFinite(maxGain) && isFinite(maxLoss) && maxLoss < 0 ? maxGain / -maxLoss : null;
  return Object.assign(out, {ok: true, legs, strikes: K, net, grid, maxGain, maxLoss, breakevens: bes, pop, expMove: em, probAbove: pAbove, returnOnRisk: ror, timeSpread, farDays: timeSpread ? farDays : null,
    pnlAt: pnl, per: 'per share; x100 per contract',
    method: (out.method ? out.method + '; ' : '') + (userPrem ? 'premiums user-entered' : `premiums Black-Scholes(IV ${isNum(ivPct) ? ivPct.toFixed(1) : 'n/a'}%, r ${(100 * r).toFixed(2)}%, ${days}d${timeSpread ? `, back month ${farDays}d valued at the near expiry` : ''})`) + '; POP = risk-neutral lognormal probability of finishing in profit'});
}

/* ---------------- recommend ----------------
   ctx = {ticker, price, iv (%), realized_vol (%), vrp (IV - RV pts), trend ('up'|'down'|'flat'), regime (0-100 market score),
          vol_regime ('calm'|'normal'|'elevated'|'stress' or VIX term ratio > 1 => 'stress'), days_to_earnings, stance ('bullish'|'neutral'|'bearish'),
          horizon_days, risk_tolerance ('low'|'medium'|'high'), rel_sector (pts vs sector median), rate_trend ('rising'|'falling'), sector, r}
   Each RULE returns points (+ helps, - hurts) or null when it does not apply / its inputs are missing. Score = sum. */
const STANCE = {bullish: 1, neutral: 0, bearish: -1};
const RATE_SECTORS = ['Utilities', 'Real Estate', 'Financial Services', 'Financials'];
const ivRatio = c => isNum(c.iv) && isNum(c.realized_vol) && c.realized_vol > 0 ? c.iv / c.realized_vol : null;
const earnIn = c => isNum(c.days_to_earnings) && c.days_to_earnings >= 0 && c.days_to_earnings <= (isNum(c.horizon_days) ? c.horizon_days : 30);
const RULES = [
  {id: 'direction', label: 'Direction fit', desc: '3 - 3 x |strategy direction - your stance| (stance bullish +1 / neutral 0 / bearish -1; strategy direction in the library)',
    flip: 'changing your stance', fn: (s, c) => s.dir == null || !(c.stance in STANCE) ? null : 3 - 3 * Math.abs(s.dir - STANCE[c.stance])},
  {id: 'trend', label: 'Trend agreement', desc: '+1 if the measured trend (technicals regime) agrees with the strategy direction, -1 if it opposes, 0 if flat',
    flip: 'the trend regime changing', fn: (s, c) => s.dir == null || !c.trend || Math.abs(s.dir) < 0.25 ? null : c.trend === 'flat' ? 0 : (c.trend === 'up' ? 1 : -1) * Math.sign(s.dir)},
  {id: 'vol', label: 'IV vs realized', desc: 'premium richness x = clamp((IV / 20d realized - 1) / 0.25, -1, 1); points = -2 x strategy vol x x (short-vol scores when options are rich, long-vol when cheap). Our scale, not a published threshold',
    flip: 'IV / realized crossing 1.0', fn: (s, c) => { const q = ivRatio(c); if (!s.vol || q == null) return null; return -2 * s.vol * clamp((q - 1) / 0.25, -1, 1); }},
  {id: 'noiv', label: 'IV missing', desc: '-1 for option strategies when the ticker has no stored IV: premiums, strikes and probabilities cannot be estimated',
    flip: 'an IV becoming available', fn: (s, c) => s.legs.some(l => l.type !== 'stock') && !isNum(c.iv) ? -1 : null},
  {id: 'earnings', label: 'Earnings inside horizon', desc: 'earnings date within the horizon: short-vol -2 (gap through strikes), income on stock -1, long-vol +0.5 (the event is usually already priced into IV); uncapped-risk an extra -1',
    flip: 'choosing a horizon that ends before earnings', fn: (s, c) => !earnIn(c) ? null : (s.vol < 0 ? -2 : s.family === 'Income' ? -1 : s.vol > 0 ? 0.5 : 0) + (s.risk === 'undefined' ? -1 : 0) || null},
  {id: 'risk', label: 'Risk tolerance', desc: 'low: uncapped-risk -3, advanced -1; medium: uncapped-risk -1; high: 0',
    flip: 'changing risk tolerance', fn: (s, c) => { const t = c.risk_tolerance || 'medium'; if (t === 'high') return null; let p = 0; if (s.risk === 'undefined') p -= t === 'low' ? 3 : 1; if (t === 'low' && s.level === 'advanced') p -= 1; return p || null; }},
  {id: 'regime', label: 'Market regime', desc: 'dashboard regime score < 40 (risk-off): bullish strategies -1 x direction, defensive/hedges +1; > 60 (risk-on): bullish +0.5 x direction',
    flip: 'the regime score crossing 40 / 60', fn: (s, c) => { if (!isNum(c.regime)) return null; if (c.regime < 40) return s.family === 'Defensive' || s.family === 'Hedge' ? 1 : s.dir > 0 ? -s.dir : null; if (c.regime > 60 && s.dir > 0) return 0.5 * s.dir; return null; }},
  {id: 'stress', label: 'Vol stress', desc: 'vol regime "stress" (e.g. VIX above VIX3M): uncapped-risk short-vol -1.5, defensive +1',
    flip: 'term structure back in contango', fn: (s, c) => c.vol_regime !== 'stress' ? null : s.family === 'Defensive' ? 1 : s.vol < 0 && s.risk === 'undefined' ? -1.5 : null},
  {id: 'horizon', label: 'Horizon fit', desc: 'time spreads need >= 20 days (-1 if shorter); option strategies under 7 days -0.5 (gamma risk)',
    flip: 'a longer horizon', fn: (s, c) => { const h = c.horizon_days; if (!isNum(h)) return null; if (s.family === 'Time spread' && h < 20) return -1; if (s.legs.some(l => l.type !== 'stock') && h < 7) return -0.5; return null; }},
  {id: 'defensive', label: 'Defensive case', desc: 'cash/no trade: +1 neutral stance, +1 flat trend, +1 earnings in horizon with neutral stance, +1 low risk tolerance',
    flip: 'a clear stance or trend', fn: (s, c) => s.id !== 'cash_defensive' ? null : (c.stance === 'neutral' ? 1 : 0) + (c.trend === 'flat' ? 1 : 0) + (earnIn(c) && c.stance === 'neutral' ? 1 : 0) + (c.risk_tolerance === 'low' ? 1 : 0)},
  {id: 'relative', label: 'Sector-relative gap', desc: 'pairs idea: min(4, |stock 1M - sector median 1M| / 2) points when the gap is measured',
    flip: 'the gap to sector peers closing', fn: (s, c) => s.id !== 'pairs_relative' ? null : isNum(c.rel_sector) ? Math.min(4, Math.abs(c.rel_sector) / 2) : -2},
  {id: 'rates', label: 'Rate sensitivity', desc: 'rate tilt: +2.5 if the sector is rate-sensitive (utilities, real estate, financials) and a 10Y trend is given; else -2',
    flip: 'a different sector or no clear rate trend', fn: (s, c) => s.id !== 'rate_tilt' ? null : RATE_SECTORS.includes(c.sector) && c.rate_trend ? 2.5 : -2},
];
function recommend(ctx) {
  const c = Object.assign({stance: 'neutral', risk_tolerance: 'medium', horizon_days: 30}, ctx || {});
  if (!isNum(c.realized_vol) && isNum(c.iv) && isNum(c.vrp)) c.realized_vol = c.iv - c.vrp;
  const scored = LIB.map(s => {
    const parts = []; let score = 0;
    for (const R of RULES) { const p = R.fn(s, c); if (p == null || !isFinite(p) || p === 0 && R.id !== 'trend' && R.id !== 'defensive') continue; parts.push({rule: R.id, label: R.label, points: +p.toFixed(2), flip: R.flip}); score += p; }
    const pf = isNum(c.price) ? payoff(s, {S: c.price, iv: c.iv, days: c.horizon_days, r: c.r}) : null;
    const top = parts.slice().sort((a, b) => Math.abs(b.points) - Math.abs(a.points))[0];
    return {id: s.id, name: s.name, family: s.family, level: s.level, plain: s.plain, score: +score.toFixed(2), parts,
      flip: top ? `most sensitive to ${top.label.toLowerCase()} (${top.points > 0 ? '+' : ''}${top.points}); would drop/rise on ${top.flip}` : 'no rule applied',
      payoff: pf && pf.ok ? {net: pf.net, maxGain: pf.maxGain, maxLoss: pf.maxLoss, breakevens: pf.breakevens, pop: pf.pop, strikes: pf.strikes, label: pf.label} : {unavailable: pf ? pf.reason : 'no price'}};
  }).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const n = clamp(c.top || 8, 5, 8), ranked = scored.slice(0, n), rest = scored.slice(n);
  const whyNot = rest.map(x => { const neg = x.parts.filter(p => p.points < 0).sort((a, b) => a.points - b.points); return {id: x.id, name: x.name, score: x.score, why: neg.length ? neg.slice(0, 2).map(p => `${p.label} ${p.points}`).join('; ') : 'scored below the top ' + n + ' (no negative rule; others fit better)'}; });
  const inputs = {stance: c.stance, trend: c.trend || null, iv: isNum(c.iv) ? c.iv : null, realized_vol: isNum(c.realized_vol) ? c.realized_vol : null, iv_rv: ivRatio(c), regime: isNum(c.regime) ? c.regime : null,
    vol_regime: c.vol_regime || null, days_to_earnings: isNum(c.days_to_earnings) ? c.days_to_earnings : null, horizon_days: c.horizon_days, risk_tolerance: c.risk_tolerance};
  const missing = Object.entries({iv: inputs.iv, realized_vol: inputs.realized_vol, trend: inputs.trend, regime: inputs.regime, days_to_earnings: inputs.days_to_earnings}).filter(([, v]) => v == null).map(([k]) => k);
  return {ticker: c.ticker || null, inputs, missing, ranked, whyNot, rules: RULES.map(R => ({id: R.id, label: R.label, desc: R.desc})),
    method: 'score = sum of the RULES points (shown per strategy); ties broken by name. Education only, not a recommendation to trade.', label: MODEL_LABEL};
}

/* ---------------- render ---------------- */
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));
const money = x => x === Infinity ? 'unlimited' : x === -Infinity ? 'unlimited' : isNum(x) ? (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(2) : 'n/a';
const pct = x => isNum(x) ? (100 * x).toFixed(0) + '%' : 'n/a';
const COLORS = ['#58a6ff', '#f0883e', '#3fb950'];
const RISKW = {defined: 'capped', undefined: 'uncapped', stock: 'stock-like (to zero)', none: 'none'};
function payoffSvg(pfs, S) {
  const ok = pfs.filter(p => p && p.ok && p.grid && p.legs.length); if (!ok.length) return '';
  const W = 560, H = 200, pl = 44, pb = 18;
  const lo = ok[0].expMove ? Math.min(ok[0].expMove.lo * 0.8, ...ok.flatMap(p => p.strikes || []).map(k => k * 0.9)) : S * 0.7;
  const hi = ok[0].expMove ? Math.max(ok[0].expMove.hi * 1.2, ...ok.flatMap(p => p.strikes || []).map(k => k * 1.1)) : S * 1.3;
  const xs = Array.from({length: 161}, (_, i) => lo + (hi - lo) * i / 160);
  const ys = ok.map(p => xs.map(x => p.pnlAt(x)));
  let mn = Math.min(0, ...ys.flat()), mx = Math.max(0, ...ys.flat()); if (mx - mn < 1e-6) { mx += 1; mn -= 1; }
  const X = x => pl + (W - pl - 4) * (x - lo) / (hi - lo), Y = y => 6 + (H - pb - 10) * (1 - (y - mn) / (mx - mn));
  let g = '';
  const em = ok[0].expMove; if (em) g += `<rect x="${X(em.lo)}" y="6" width="${X(em.hi) - X(em.lo)}" height="${H - pb - 10}" class="st-em"><title>+/-1 sigma expected move ${em.lo.toFixed(2)} - ${em.hi.toFixed(2)} (model)</title></rect>`;
  g += `<line x1="${pl}" x2="${W - 4}" y1="${Y(0)}" y2="${Y(0)}" class="st-zero"/>`;
  for (let k = 0; k <= 4; k++) { const v = mn + (mx - mn) * k / 4; g += `<text x="${pl - 3}" y="${Y(v) + 3}" class="st-ax" text-anchor="end">${v.toFixed(Math.abs(mx - mn) > 20 ? 0 : 1)}</text>`; }
  for (let k = 0; k <= 4; k++) { const v = lo + (hi - lo) * k / 4; g += `<text x="${X(v)}" y="${H - 4}" class="st-ax" text-anchor="${k === 0 ? "start" : k === 4 ? "end" : "middle"}">${v.toFixed(v > 100 ? 0 : 1)}</text>`; }
  g += `<line x1="${X(S)}" x2="${X(S)}" y1="6" y2="${H - pb - 4}" class="st-spot"><title>current price ${S}</title></line>`;
  ok.forEach((p, j) => {
    g += `<path d="${xs.map((x, i) => (i ? 'L' : 'M') + X(x).toFixed(1) + ' ' + Y(ys[j][i]).toFixed(1)).join('')}" fill="none" stroke="${COLORS[j]}" stroke-width="1.8"/>`;
    for (const b of p.breakevens) if (b >= lo && b <= hi) g += `<circle cx="${X(b)}" cy="${Y(0)}" r="3" fill="${COLORS[j]}"><title>breakeven ${b.toFixed(2)}</title></circle>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" class="st-svg" role="img" aria-label="payoff at expiry">${g}</svg><div class="st-cap dim">P/L per share at the near expiry vs price at expiry · shaded = +/-1 sigma expected move · dots = breakevens · vertical = current price · ${esc(MODEL_LABEL)}</div>`;
}
function statsHtml(p) {
  if (!p) return '';
  if (!p.ok) return `<div class="st-na">Payoff unavailable: ${esc(p.reason)}</div>`;
  if (!p.legs.length) return '<div class="st-na">No position: flat line, earns the cash rate.</div>';
  const legs = p.legs.map(l => `${l.side > 0 ? 'Buy' : 'Sell'} ${l.qty} ${l.type === 'stock' ? 'share' : `${l.k} ${l.type} ${l.days}d`} @ ${money(l.prem)}`).join('<br>');
  return `<table class="st-kv"><tr><td>Legs (model strikes)</td><td>${legs}</td></tr>
    <tr><td>Net premium</td><td>${p.net >= 0 ? 'credit ' + money(p.net) : 'debit ' + money(-p.net)} /sh (x100 = ${money(Math.abs(p.net) * 100)} per contract)</td></tr>
    <tr><td>Max gain / max loss</td><td>${money(p.maxGain)} / ${money(p.maxLoss)}${p.timeSpread ? ' (model, at near expiry)' : ''}</td></tr>
    <tr><td>Breakeven(s)</td><td>${p.breakevens.length ? p.breakevens.map(b => b.toFixed(2)).join(', ') : 'none'}</td></tr>
    <tr><td>Prob. of profit</td><td>${pct(p.pop)} <span class="dim">(risk-neutral model)</span></td></tr>
    <tr><td>Return on risk</td><td>${p.returnOnRisk != null ? (100 * p.returnOnRisk).toFixed(0) + '%' : 'n/a (unlimited side)'}</td></tr>
    ${p.expMove ? `<tr><td>Expected move (1 sigma)</td><td>${p.expMove.lo.toFixed(2)} - ${p.expMove.hi.toFixed(2)} by ${p.days}d</td></tr>` : ''}
    ${p.probAbove.length ? `<tr><td>Prob. finish above</td><td>${p.probAbove.map(x => `${x.k}: ${pct(x.p)}`).join(' · ')}</td></tr>` : ''}
    </table><details class="st-method"><summary>How computed</summary><div class="dim">${esc(p.method)}</div></details>`;
}
function cardHtml(s, x, sel, context) {
  return `<div class="st-card${sel ? ' st-sel' : ''}" data-id="${s.id}">
    <div class="st-ch"><label title="add to compare (max 3)"><input type="checkbox" data-cmp="${s.id}"${sel ? ' checked' : ''}></label>
      <b>${esc(s.name)}</b> <span class="st-fam">${esc(s.family)} · ${esc(s.level)}</span>${x ? ` <span class="st-score" title="sum of rule points">score ${x.score}</span>` : ''}</div>
    <div class="st-plain">${esc(s.plain)}</div>
    ${x ? `<div class="st-parts">${x.parts.map(p => `<span class="st-pt ${p.points > 0 ? 'up' : p.points < 0 ? 'dn' : ''}" title="${esc((RULES.find(R => R.id === p.rule) || {}).desc || '')}">${esc(p.label)} ${p.points > 0 ? '+' : ''}${p.points}</span>`).join('')}</div>
      <details class="st-rank-why"><summary>Why this rank? Score ${x.score}</summary><div>${esc(context || 'Context unavailable')}</div><ul>${x.parts.map(p => `<li><b>${esc(p.label)}: ${p.points > 0 ? '+' : ''}${p.points}</b> — ${esc((RULES.find(r => r.id === p.rule) || {}).desc || 'Rule unavailable')}</li>`).join('')}</ul><div>Rank = sum of rule points; ties by strategy name. Educational fit, not expected return.</div></details>
      <div class="st-flip dim">What would change it: ${esc(x.flip)}</div>
      <div class="st-q">${x.payoff.unavailable ? `<span class="dim">payoff: ${esc(x.payoff.unavailable)}</span>` : x.payoff.strikes == null ? '' : `model: ${x.payoff.net >= 0 ? 'credit ' + money(x.payoff.net) : 'debit ' + money(-x.payoff.net)}/sh · max loss ${money(x.payoff.maxLoss)} · max gain ${money(x.payoff.maxGain)} · POP ${pct(x.payoff.pop)}${x.payoff.strikes.length ? ' · strikes ' + x.payoff.strikes.join('/') : ''}`}</div>` : ''}
    <details class="st-more"><summary>View, fit, payoff, risks</summary>
      <div><b>View:</b> direction ${s.dir == null ? 'n/a' : s.dir > 0.2 ? 'bullish' : s.dir < -0.2 ? 'bearish' : 'neutral'} · vol ${s.vol > 0 ? 'long' : s.vol < 0 ? 'short' : 'neutral'} · time decay ${s.theta > 0 ? 'helps' : s.theta < 0 ? 'hurts' : 'neutral'} · risk ${esc(RISKW[s.risk] || s.risk)}</div>
      <div><b>Tends to fit:</b> ${esc(s.fits)}</div><div><b>Shape:</b> ${esc(s.shape)} · <b>Max gain:</b> ${esc(s.maxGain)} · <b>Max loss:</b> ${esc(s.maxLoss)} · <b>Breakeven:</b> ${esc(s.be)}</div>
      <div><b>Risks:</b> ${esc(s.risks)} · <b>Tax/assignment:</b> ${esc(s.tax)} <span class="dim">(general US notes, not tax advice)</span></div></details></div>`;
}
const UI = {cmp: [], showRules: false, showLib: false, form: null};
function coreData() { try { return root.SO2 && root.SO2.D ? root.SO2.D() : null; } catch (e) { return null; } }
function termRatio(D) { const v = D && D.rel && D.rel.vol_breadth && D.rel.vol_breadth.term_ratio; return isNum(v) ? v : v && isNum(v.value) ? v.value : null; }
function findIn(groups, id) { for (const g of Object.values(groups || {})) if (Array.isArray(g)) { const x = g.find(o => o && o.id === id); if (x) return x; } return null; }
async function ctxFromData(t) {
  const D = coreData() || {}, r = (D.rows || []).find(x => x.t === t) || {}, ctx = {ticker: t, price: r.px, iv: r.iv, rv20_core: r.rv20, iv_sec_med: r.iv_sec_med, days_to_earnings: r.ern, sector: r.sec, prov: {}};
  const quote=root.SmartOptionsLive?.get(t);if(root.SmartOptionsLive)ctx.price=quote&&quote.current_usable!==false&&isNum(quote.price)?quote.price:null;
  ctx.prov.price = quote ? `${quote.asof_utc||quote.ts} ${quote.provider||'canonical quote'} (${root.SmartOptionsLive.classify?.(quote,Date.now()).label||quote.freshness||'observation'})` : `${r.pxd || 'n/a'} close/last (core.json)`; ctx.prov.iv = isNum(r.iv) ? `${r.ivs || 'option chain'}; expiry ${r.ivx || '?'} strike ${r.ivk || '?'}` : 'no IV stored for this ticker (20d RV proxy available)';
  const bill = findIn(D.macro, 'us3m'); if (bill && isNum(bill.v)) { ctx.r = bill.v / 100; ctx.prov.r = `3M T-bill ${bill.v}% (${bill.provider || 'US Treasury'}, ${bill.period || ''})`; } else { ctx.r = 0; ctx.prov.r = 'no T-bill rate stored: r = 0'; }
  const reg = D.rel && D.rel.regime; if (reg && isNum(reg.score)) { ctx.regime = reg.score; ctx.prov.regime = `${reg.score} ${reg.tier || ''} (dashboard regime)`; }
  const tr = termRatio(D); if (isNum(tr)) { ctx.vol_regime = tr > 1 ? 'stress' : 'normal'; ctx.prov.vol_regime = `VIX/VIX3M ${tr} (term ratio > 1 = stress)`; }
  if (isNum(r.ivx ? Date.parse(r.ivx) : NaN) && D.date) { const d = Math.round((Date.parse(r.ivx) - Date.parse(D.date)) / 864e5); if (d > 0) ctx.iv_days = d; }
  if (root.SmartOptionsTech) { try { const a = await root.SmartOptionsTech.get(t); const rv = (a.indicators || []).find(i => i.id === 'rv'); ctx.trend = a.regime ? (/^Uptrend/.test(a.regime) ? 'up' : /^Downtrend/.test(a.regime) ? 'down' : 'flat') : undefined;
    if (rv && isNum(rv.value)) { ctx.realized_vol = rv.value; ctx.prov.realized_vol = `20d close-to-close, technicals as of ${a.asof}`; } ctx.prov.trend = `technicals regime "${a.regime}" as of ${a.asof}`;
    const rs = (a.indicators || []).find(i => i.id === 'rs_sec'); if (rs && isNum(rs.value)) ctx.rel_sector = rs.value; } catch (e) { ctx.prov.trend = 'technicals unavailable: ' + (e && e.message || e); } }
  return ctx;
}
function render(el, base) {
  const f = UI.form = UI.form && UI.form.ticker === base.ticker ? UI.form : {ticker: base.ticker, stance: base.trend === 'up' ? 'bullish' : base.trend === 'down' ? 'bearish' : 'neutral', horizon_days: base.iv_days || 30, risk_tolerance: 'medium', use_rv_proxy: true};
  const fallbackVol = isNum(base.realized_vol) ? base.realized_vol : isNum(base.rv20_core) ? base.rv20_core : base.iv_sec_med;
  const usingProxy = !isNum(base.iv) && !!f.use_rv_proxy && isNum(fallbackVol);
  const effIv = isNum(base.iv) ? base.iv : (usingProxy ? fallbackVol : null);
  const ctx = Object.assign({}, base, {iv: effIv, stance: f.stance, horizon_days: f.horizon_days, risk_tolerance: f.risk_tolerance});
  const rec = recommend(ctx), P = id => payoff(id, {S: ctx.price, iv: ctx.iv, days: ctx.horizon_days, r: ctx.r});
  const localData = root.SmartOptionsImport && root.SmartOptionsImport.getData ? root.SmartOptionsImport.getData() : null;
  const bookPos = localData && localData.book ? localData.book[base.ticker] : null;
  const bookHtml = bookPos ? `<div class="st-book-banner" style="margin:6px 0;padding:6px 10px;border:1px solid #2b3640;border-radius:4px;background:#11171d"><b>My Book Position:</b> ${isNum(bookPos.qty) ? bookPos.qty + ' shares' : 'held'}${isNum(bookPos.cost) ? ` @ $${bookPos.cost.toFixed(2)} cost basis (${isNum(base.price) ? ((base.price / bookPos.cost - 1) * 100 >= 0 ? '+' : '') + ((base.price / bookPos.cost - 1) * 100).toFixed(1) + '% P&L' : ''})` : ''} · <b>Suggested contract sizing:</b> ${isNum(bookPos.qty) && bookPos.qty >= 100 ? Math.floor(bookPos.qty / 100) + ' contract(s) (100 sh/contract for covered call / collar / protective put)' : '<100 shares (fractional lot; standard option = 100 sh)'}</div>` : '';
  const rankContext = `${base.ticker} · stance ${rec.inputs.stance} · trend ${rec.inputs.trend || 'unavailable'} · ATM IV ${isNum(rec.inputs.iv) ? rec.inputs.iv.toFixed(2) + '%' : 'unavailable'} · realized vol ${isNum(rec.inputs.realized_vol) ? rec.inputs.realized_vol.toFixed(2) + '%' : 'unavailable'} · IV/RV ${isNum(rec.inputs.iv_rv) ? rec.inputs.iv_rv.toFixed(2) : 'unavailable'} · regime ${isNum(rec.inputs.regime) ? rec.inputs.regime : 'unavailable'} · volatility regime ${rec.inputs.vol_regime || 'unavailable'} · earnings in ${isNum(rec.inputs.days_to_earnings) ? rec.inputs.days_to_earnings + ' days' : 'unavailable'} · horizon ${rec.inputs.horizon_days} days · risk tolerance ${rec.inputs.risk_tolerance}. Sources / as-of: ${Object.entries(base.prov || {}).map(([k,v]) => k.replace(/_/g,' ') + ': ' + v).join(' · ')}.`;
  let cmp = UI.cmp.filter(id => BY[id]).slice(0, 3);
  if (!UI.cmpTouched && !cmp.length) cmp = rec.ranked.filter(x => !x.payoff.unavailable).slice(0, 2).map(x => x.id); // show the top payoffs by default
  const sel = (k, opts) => `<select data-f="${k}">${opts.map(o => `<option${f[k] === o ? ' selected' : ''}>${o}</option>`).join('')}</select>`;
  const pv = base.prov || {};
  const inputsHtml = Object.entries(rec.inputs).map(([k, v]) => `<span class="st-in" title="${esc(pv[k] || '')}">${esc(k)}: <b>${v == null ? 'missing' : isNum(v) ? (+v.toFixed(2)) : esc(v)}</b></span>`).join('');
  el.innerHTML = `<div class="st">
    <div class="st-head"><b>${esc(base.ticker)} strategy ideas</b> <span class="dim">price ${isNum(base.price) ? base.price : 'n/a'} · ${esc(pv.price || '')} · IV ${isNum(base.iv) ? base.iv + '%' : (usingProxy ? `Proxy: 20d RV ${effIv.toFixed(1)}%` : 'missing')} · r ${esc(pv.r || '')}</span></div>
    ${bookHtml}
    <div class="st-warn"><b>Not rated - contract pricing unavailable.</b> Every premium, strike and probability here is a ${esc(MODEL_LABEL)}. Education only: not a recommendation to trade.${isNum(base.iv) ? '' : (usingProxy ? ` <b>No IV is stored for this ticker</b> — modeling payoffs with <b>20d Realized Vol (${effIv.toFixed(1)}%)</b> proxy (uncheck below to disable).` : ' <b>No IV is stored for this ticker</b>, so option payoffs are not estimated.')}</div>
    <p class="dim">Editable scenario assumptions below. Defaults describe a comparison, not an investment opinion. Payoff amounts are per share; multiply by the contract multiplier (usually 100 for standard US equity options). Model probabilities are conditional on the pricing assumptions, not validated success rates.</p>
    <div class="st-form">Stance ${sel('stance', ['bullish', 'neutral', 'bearish'])} Horizon <input type="number" min="1" max="730" data-f="horizon_days" value="${esc(f.horizon_days)}"> days · Risk tolerance ${sel('risk_tolerance', ['low', 'medium', 'high'])}
      ${!isNum(base.iv) && isNum(fallbackVol) ? `<label title="Use 20-day realized volatility when delayed ATM IV was not fetched"><input type="checkbox" data-f="use_rv_proxy"${f.use_rv_proxy ? ' checked' : ''}> Proxy: 20d RV (${fallbackVol.toFixed(1)}%)</label>` : ''}
      <button class="st-btn" data-act="rules">${UI.showRules ? 'Hide' : 'Show'} scoring rules</button> <button class="st-btn" data-act="lib">${UI.showLib ? 'Hide' : 'Browse'} full library (${LIB.length})</button></div>
    <div class="st-ins">${inputsHtml}${rec.missing.length ? ` <span class="dim">missing inputs are skipped by their rules: ${esc(rec.missing.join(', '))}</span>` : ''}</div>
    ${UI.showRules ? `<ol class="st-rules">${RULES.map(R => `<li><b>${esc(R.label)}</b>: ${esc(R.desc)}</li>`).join('')}</ol><div class="dim">${esc(rec.method)}</div>` : ''}
    ${cmp.length ? `<div class="st-cmp"><b>Compare</b> ${cmp.map((id, j) => `<span style="color:${COLORS[j]}">${esc(BY[id].name)}</span>`).join(' · ')} <button class="st-btn" data-act="clear">clear</button>
      ${payoffSvg(cmp.map(P), ctx.price)}<div class="st-cmpg">${cmp.map(id => `<div><b>${esc(BY[id].name)}</b>${statsHtml(P(id))}</div>`).join('')}</div></div>` : '<div class="dim st-hint">Tick up to 3 strategies to draw and compare their payoffs.</div>'}
    <h4>Ranked for this context (top ${rec.ranked.length} of ${LIB.length})</h4>
    <div class="st-list">${rec.ranked.map(x => cardHtml(BY[x.id], x, cmp.includes(x.id), rankContext)).join('')}</div>
    <details class="st-why"><summary>Why not the others (${rec.whyNot.length})</summary><ul>${rec.whyNot.map(w => `<li><b>${esc(w.name)}</b> (score ${w.score}): ${esc(w.why)}</li>`).join('')}</ul></details>
    ${UI.showLib ? `<h4>Full library</h4><div class="st-list">${LIB.map(s => cardHtml(s, null, cmp.includes(s.id))).join('')}</div>` : ''}
  </div>`;
}
async function mount(el, ticker) {
  if (!el) return; const t = String(ticker || '').toUpperCase();
  el.innerHTML = '<div class="st dim">loading strategy ideas...</div>';
  const base = await ctxFromData(t);
  const L=root.SmartOptionsLive;if(el._stUnsub)el._stUnsub();L?.watch('strategy',[t]);el._stUnsub=L?.subscribe(ev=>{if(!el.isConnected){el._stUnsub?.();return;}if(ev.changed.includes(t)){const q=L.get(t);if(q){base.price=q.current_usable!==false&&isNum(q.price)?q.price:null;base.prov.price=`${q.asof_utc||q.ts} ${q.provider}`;el._stDraw();}}});
  const draw = () => render(el, base);
  if (!el._stBound) {
    el._stBound = true;
    el.addEventListener('change', e => {
      const x = e.target;
      if (x.dataset.f) { UI.form[x.dataset.f] = x.dataset.f === 'horizon_days' ? clamp(parseInt(x.value, 10) || 30, 1, 730) : x.dataset.f === 'use_rv_proxy' ? !!x.checked : x.value; el._stDraw(); }
      else if (x.dataset.cmp) { const id = x.dataset.cmp; if (!UI.cmpTouched) { UI.cmpTouched = true; UI.cmp = [...el.querySelectorAll('[data-cmp]:checked')].map(i => i.dataset.cmp).filter(i => i !== id); } UI.cmp = x.checked ? [...UI.cmp.filter(i => i !== id), id].slice(-3) : UI.cmp.filter(i => i !== id); el._stDraw(); }
    });
    el.addEventListener('click', e => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      if (b.dataset.act === 'rules') UI.showRules = !UI.showRules;
      if (b.dataset.act === 'lib') UI.showLib = !UI.showLib;
      if (b.dataset.act === 'clear') { UI.cmp = []; UI.cmpTouched = true; }
      el._stDraw();
    });
  }
  el._stDraw = draw; draw();
  return base;
}
async function recommendFor(ticker, opts) { // chat API: data-backed context + provenance
  const t = String(ticker || '').toUpperCase(), base = await ctxFromData(t);
  const rec = recommend(Object.assign({}, base, opts || {}));
  return Object.assign(rec, {provenance: base.prov, ranked: rec.ranked.map(x => Object.assign({}, x, {payoff: Object.assign({}, x.payoff)}))});
}

/* Flow step 4 hook: short ranked list for one name from the flow's own measured inputs (sync, no fetch). */
const STANCE_OF = {STRONG: 'bullish', WEAK: 'bearish', MIXED: 'neutral'};
function flowHint(o) {
  o = o || {}; const D = coreData() || {}, reg = D.rel && D.rel.regime, bill = findIn(D.macro, 'us3m');
  const rec = recommend({ticker: o.ticker, price: o.price, iv: o.iv, realized_vol: o.realized_vol, days_to_earnings: o.days_to_earnings, horizon_days: o.horizon_days || 30,
    stance: STANCE_OF[o.name_word] || o.stance || 'neutral', trend: o.trend, regime: reg && isNum(reg.score) ? reg.score : undefined,
    vol_regime: isNum(termRatio(D)) ? (termRatio(D) > 1 ? 'stress' : 'normal') : undefined, r: bill && isNum(bill.v) ? bill.v / 100 : 0, top: 5});
  return `<div class="st-flow"><b>Strategy engine (top ${rec.ranked.length} of ${LIB.length}, stance ${esc(rec.inputs.stance)} from the name verdict):</b> ${rec.ranked.map(x => `${esc(x.name)} <span class="dim">(${x.score})</span>`).join(' · ')}
    <span class="dim">· open the ticker's Strategies tab for payoffs and the scoring rules · ${rec.missing.length ? 'missing: ' + esc(rec.missing.join(', ')) + ' · ' : ''}model estimates, education only</span></div>`;
}

const API = {list, get, recommend, payoff, recommendFor, mount, flowHint, RULES, bs, probAbove, strikeInc, MODEL_LABEL};
if (typeof module !== 'undefined' && module.exports) module.exports = API;
root.SmartOptionsStrategies = API;

/* ---------------- browser integration (detail-pane tabs + chat API), additive only ----------------
   The detail pane (#detail, rendered by app.js) is re-rendered on every selection; a MutationObserver adds an
   Overview | Technicals | Strategies strip under its header and mounts our panels. Nothing in app.js changes. */
if (root.document && root.MutationObserver) {
  const TABS = [['overview', 'Overview'], ['technicals', 'Technicals'], ['strategies', 'Strategies']];
  const TKEY = 'so_r7_tab_v1';
  let cur = 'overview';
  try { cur = root.localStorage.getItem(TKEY) || cur; } catch (e) { /* storage blocked: default tab */ }
  const HP = new URLSearchParams((root.location && root.location.hash || '').slice(1)); // read before app.js rewrites the hash
  if (HP.get('dt')) cur = HP.get('dt'); // deep link: #...&dt=technicals (&dx=1 opens it expanded)
  let wideOnce = HP.get('dx') === '1';
  if (!['overview', 'technicals', 'strategies'].includes(cur)) cur = 'overview';
  const remember = () => { try { root.localStorage.setItem(TKEY, cur); } catch (e) { /* storage blocked */ } };
  const tickerOf = det => { const b = det.querySelector('.dh .big'); return b ? b.textContent.trim().split(/\s+/)[0] : null; };
  function apply(det) {
    const bar = det.querySelector(':scope > .r7-tabs'), box = det.querySelector(':scope > .r7-box'), t = det.dataset.r7t;
    if (!bar || !box) return;
    bar.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.r7tab === cur));
    for (const ch of det.children) if (ch !== bar && ch !== box && !ch.classList.contains('dh')) ch.hidden = cur !== 'overview';
    box.hidden = cur === 'overview'; if (cur === 'overview') box.classList.remove('r7-wide');
    if (cur === 'technicals' && root.SmartOptionsTech) root.SmartOptionsTech.mount(box, t).catch(e => { box.textContent = 'technicals failed: ' + (e && e.message || e); });
    else if (cur === 'strategies') mount(box, t).catch(e => { box.textContent = 'strategies failed: ' + (e && e.message || e); });
    else box.innerHTML = '';
  }
  function enhance() {
    const det = document.getElementById('detail'); if (!det) return;
    const dh = det.querySelector(':scope > .dh'); if (!dh || det.querySelector(':scope > .r7-tabs')) return;
    const t = tickerOf(det); if (!t) return;
    det.dataset.r7t = t;
    const bar = document.createElement('div'); bar.className = 'r7-tabs';
    bar.innerHTML = TABS.map(([k, l]) => `<button data-r7tab="${k}">${l}</button>`).join('') + '<button class="r7-exp" data-r7exp="1" title="open this tab in a large overlay (Esc closes)">Expand</button>';
    bar.addEventListener('click', e => {
      if (e.target.closest('[data-r7exp]')) { const w = !box.classList.contains('r7-wide'); if (w && cur === 'overview') { cur = 'technicals'; remember(); apply(det); } box.classList.toggle('r7-wide', w); e.target.textContent = w ? 'Close' : 'Expand'; return; }
      const b = e.target.closest('[data-r7tab]'); if (!b) return; cur = b.dataset.r7tab; remember(); apply(det); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && box.classList.contains('r7-wide')) { box.classList.remove('r7-wide'); const x = bar.querySelector('[data-r7exp]'); if (x) x.textContent = 'Expand'; } });
    const box = document.createElement('div'); box.className = 'r7-box';
    dh.after(bar); bar.after(box); apply(det);
    if (wideOnce && cur !== 'overview') { wideOnce = false; box.classList.add('r7-wide'); bar.querySelector('[data-r7exp]').textContent = 'Close'; }
  }
  const start = () => { const det = document.getElementById('detail'); if (!det) return; new MutationObserver(enhance).observe(det, {childList: true}); enhance(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  // chat / automation API: data-backed calls, every number carries its provenance string
  const reg = () => { const A = root.SmartOptionsAPI; if (!A) return false;
    A.get_technicals = t => root.SmartOptionsTech ? root.SmartOptionsTech.get(t) : Promise.resolve({error: 'technicals module not loaded'});
    A.recommend_strategy = (t, opts) => recommendFor(t, opts);
    A.strategy_library = () => list().map(s => ({id: s.id, name: s.name, family: s.family, level: s.level, plain: s.plain, fits: s.fits, maxGain: s.maxGain, maxLoss: s.maxLoss, be: s.be, risks: s.risks}));
    A.open_ticker_tab = (t, tab) => { if (!TABS.some(x => x[0] === tab)) throw new Error('tab must be one of ' + TABS.map(x => x[0]).join(', ')); cur = tab; if (A.select) A.select(t); const det = document.getElementById('detail'); if (det && det.dataset.r7t === String(t).toUpperCase()) apply(det); return {ticker: t, tab}; };
    return true; };
  if (!reg()) root.addEventListener('load', reg);
}
})(typeof window !== 'undefined' ? window : globalThis);
