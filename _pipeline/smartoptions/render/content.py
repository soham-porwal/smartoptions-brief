"""Static page copy. Playbook text is condensed from the client brief (docs/handoff.md, sections
"Three macro risk types and portfolio impact" and "Conditional options strategy playbook").
Education framing only: no "optimal", no orders, no thresholds the brief did not approve."""

PLAYBOOK = [
    {
        "id": "scheduled",
        "title": "1. Scheduled risk events",
        "what": "FOMC, CPI, PPI, PCE, payrolls, GDP and inventory releases at verified times.",
        "impact": "Gap and reversal risk. Implied volatility on expiries spanning the event can rise "
                  "beforehand and fall afterward. Long options can lose even with the right direction if the "
                  "move is too small; short options keep jump risk.",
        "consider": [
            "First identify which expiries span the event and any existing short-gamma exposure. "
            "Reducing or avoiding event exposure is a valid choice.",
            "Directional view: a debit vertical, only if the anticipated move and option prices support its "
            "limited payoff.",
            "Large move, uncertain direction: a long straddle or strangle, only if the expected realized move "
            "justifies the premium and decay. An ATM straddle price is a rough pricing reference, not a "
            "guaranteed range.",
            "Premium selling: high IV alone is not enough. A defined-risk credit spread or iron condor needs a "
            "view that the premium pays for jump risk, an acceptable worst-case loss, liquid legs and an event plan.",
            "After the release, reassess the new prices and the remaining events instead of assuming an IV crush.",
        ],
        "no_trade": "If uncertainty remains, defer the trade.",
    },
    {
        "id": "trend",
        "title": "2. Persistent macro trends",
        "what": "Inflation, growth, labor, policy and financial conditions tracked separately over declared "
                "windows: accelerating, slowing, mixed or insufficient data.",
        "impact": "Sustained delta and sector exposure, shifting IV regimes and correlation. A slowdown with "
                  "easing inflation is a different regime from a slowdown with rising inflation.",
        "consider": [
            "Improving growth, easing inflation and confirming company evidence: a bullish debit spread can "
            "express a bounded directional view.",
            "Deteriorating growth or tighter conditions: a bearish debit spread for a bearish thesis; an existing "
            "long holding can instead consider a protective put or a collar.",
            "Range-bound income structures need evidence of a range and acceptable short-gamma risk, not just a "
            "neutral macro label.",
            "Protective put keeps upside but costs premium; a collar trades upside for cheaper protection; a put "
            "spread is cheaper but its payout is capped. A covered call is not crash insurance.",
        ],
        "no_trade": "Directional spreads cap gains and can still lose their full defined risk; no position is a valid outcome.",
    },
    {
        "id": "shock",
        "title": "3. Sudden shocks and liquidity stress",
        "what": "Geopolitical escalation, banking stress, funding disruption or market dysfunction, confirmed "
                "by credit, funding, volatility and execution symptoms (not by a headline alone).",
        "impact": "Gaps, skew changes, correlation concentration, wide spreads, poor fills and margin pressure. "
                  "Short convexity is most vulnerable; existing hedges can help but new hedges get expensive.",
        "consider": [
            "Prioritize exposure and financing: reduce leverage or concentrated short-option risk, check "
            "assignment and settlement, keep liquidity before any new trade.",
            "Existing protective puts may offset equity losses; a new hedge needs a check of spreads and the "
            "now-higher premium.",
            "Do not mechanically sell a volatility spike, and do not assume a conflict headline must cause a "
            "persistent selloff.",
        ],
        "no_trade": "If quotes are stale or execution is impaired, no strategy candidate should be acted on.",
    },
]

CHECKS = [
    "Exercise style, settlement, multiplier, dividends and expiration timing.",
    "How the broker handles assigned short legs: a spread's quoted defined loss assumes the structure stays intact.",
    "Stops do not guarantee fills across gaps.",
    "Judge net exposure after the trade, not the trade's standalone payoff.",
    "Impact depends on positions actually held: long stock, covered calls and cash-secured puts keep material "
    "downside; long options lose to decay and IV decline; calendars and diagonals have expiry-specific exposure.",
]

PLAYBOOK_INTRO = ("General exposure guidance for education. It is not a recommendation, not an \"optimal\" strategy, "
                  "and not tailored to any portfolio: optimal depends on objectives, prices, horizon, positions, "
                  "costs and loss tolerance, none of which this page knows. Scenarios are design guidance, not "
                  "backtested results. Nothing here places orders.")

LIMITATIONS = [
    "Consensus forecasts and surprise values are not shown: no licensed consensus source is connected.",
    "SmartOptions scores (Opportunity, Quality, TrendScore, Risk, Flags, EXPLAIN) are copied read-only from Sam's "
    "published snapshot and are not recomputed; their formulas are not available to this build.",
    "Macro sensitivities are historical associations from daily-return regressions over the stated window. They are "
    "not causal, can change, and say nothing about a single day.",
    "Monthly and quarterly statistics show their observation period; they are not new today unless the calendar says "
    "they were released today.",
    "This is a once-a-day static page. It does not monitor markets continuously and cannot detect intraday shocks.",
    "Implied volatility, analyst and earnings fields come from free public endpoints and can be missing or late; "
    "each value carries its own status.",
    "No private holdings are used; the playbook cannot know the impact on any particular portfolio.",
]

EVENT_FACTOR = {  # which regression factor a scheduled event usually acts through (for drawer cross-links)
    "FOMC": "us10y_bps", "CPI": "us10y_bps", "PPI": "us10y_bps", "PCE": "us10y_bps",
    "NFP": "us10y_bps", "GDP": "spy", "EIA": "wti",
}
