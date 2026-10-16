# Personal dashboards and chat V2

My Dash is a device-local collection of named research views. A view stores a typed widget specification, never HTML, scripts, formulas, arbitrary endpoints, provider keys, account balances or holdings. The default works without inference. The existing Research desk, watchlist and company tools retain their action routes.

## Integration

Include `my-dashboard.css` and `my-dashboard.js` in `app/index.html`. The script can follow `custom.js`; it lazily loads its pure modules. Add `#/my-dash` to the Brief router and call `SmartOptionsMyDashboard.mount(view)` for that route. The mobile lane owns this integration and reserves the last 64px of its bottom navigation for the 48px chat FAB. The FAB uses `right:10px; bottom:calc(8px + env(safe-area-inset-bottom))`.

Public API: `mount(container)`, `refresh()`, `command(text, plannerConfig?)`, `applyAction(action)`, `catalog()`, `state()`. `command` returns `{handled, receipt}`. A receipt can claim success only after a storage write and exact readback. `so:quotes-update` accepts the complete quotes JSON in `event.detail`, updating only quote-dependent values and their provenance without replacing the command field. `so:data-update` explicitly refreshes all dated snapshots. Fundamentals and coefficients keep their own dates when quotes change.

## Saved format and allowed widgets

Storage key: `so-brief-dashboards-v1`. Export envelope:

```json
{"schema":"smartoptions.dashboards.v1","active":"dash-example","layouts":[{"schema":"smartoptions.dashboard.v1","id":"dash-example","name":"Tech","updated_at":"2026-10-16T00:00:00Z","widgets":[{"id":"w1","type":"metric","metric":"price","tickers":["AAPL"],"width":"half"}]}]}
```

Limits: 30 layouts, 24 widgets per layout, 48-character names, 72-character optional widget titles, four distinct known tickers per comparison, 100KB import. IDs use lowercase letters, digits and hyphens. Unknown keys, unknown metrics/tickers, duplicate IDs/names and executable markup are rejected. Corrupt stored data is surfaced and protected from overwrite. Import validates the entire file before merging; any existing name or ID conflict rejects the import without replacing a view. Export contains layouts only; diagnostics and credentials use separate keys and are excluded.

Widget types: `metric` (one ticker and metric), `company` (one ticker, including all seven assessment disclosures), `market` (no ticker), `relationships` (one ticker), `comparison` (two to four tickers and one metric). `width` is `half` or `full`.

Metric allowlist: `price`, `change_1d_pct`, `forward_pe`, `market_cap`, `revenue_growth_pct`, `operating_margin_pct`, `free_cash_flow`, `observed_return_pct`, `explained_return_pct`, `residual_return_pct`, `model_r2`. Each rendered number carries a source, observation date and calculation basis. Missing values remain unavailable. Historical explained returns, residuals and R² are labeled as historical fits, not validated forecasts.

## Chat actions

All proposals use `schema: smartoptions.dashboard-action.v1`. Allowed actions and their extra fields:

| Action | Fields |
| --- | --- |
| `create` | `name`, `widgets` |
| `add_widget` | `widget` |
| `move_widget` | `widget_id`, integer `position` (one-based) |
| `resize_widget` | `widget_id`, `width` |
| `rename` / `save_as` / `open` | `name` |
| `list` | none |

Examples: “Create dashboard named Tech with AAPL price and operating margin”, “Add NVDA relationships widget”, “Move widget 2 to position 1”, “Make widget 1 full width”, “Save dashboard as Morning view”, “Open dashboard Tech”. Existing “Open AMZN strategies” and watchlist requests bypass dashboard planning. Unsupported metrics are not silently substituted.

The deterministic parser runs first. If a dashboard request is unclear and a shared HTTPS relay is configured, the optional model receives the request (capped at 1200 characters), current typed layout, saved view names and known ticker/metric catalogs. The response must be a single JSON action and passes the same strict validator before any state mutation. A malformed response, unsupported metric, HTTP failure or cancellation produces a visible failure receipt. No model HTML/code reaches the DOM. Shared planning omits model selection and uses server policy. BYOK in the popup requires the user's key and explicit model selection, and labels provider pricing; it is never selected by a local dashboard command automatically.

Relationship questions additionally read `data/intelligence.json`. Answers include `observed`, `Historical association`, or `Conditional scenario` labels, evidence dates and counterarguments. Missing intelligence is visible. These answers do not undergo optional polishing, which preserves the classification and caveats.

## Mobile and failure behavior

The popup is a nonmodal panel on desktop. On phones and coarse-pointer tablets, it fills the visual viewport inside an 8px gutter. `visualViewport.resize/scroll` keeps close and compose controls above the keyboard, including landscape; provider settings/history/chips scroll in the middle. Inputs are at least 16px. The FAB hides while open, Escape/close restore page scrolling and preserve draft/history. Chat settings storage failures are visible.

Action diagnostics are a bounded 60-event array in `so-brief-dashboards-v1-diagnostics`, also forwarded to the existing `so-chat-diagnostics` session log when available. The My Dash “Action diagnostics” disclosure exposes these receipts. A blocked or corrupt storage state disables successful mutations rather than resetting saved data; storage logging failure falls back to console. Data-fetch failures surface a status disclosure and retain any last good observations. Browser storage is the durable local boundary; there is no hidden account synchronization.

## Verification and proof

Run the project JS suite: `node --test app/test/*.test.js chat/test/chat.test.js`.

Focused browser QA: `node app/test/dashboard-browser.js`. It uses the existing local Python Playwright driver package; override its location with `SO_PLAYWRIGHT_PATH` if needed. The QA server uses actual core/company data and an explicitly synthetic intelligence fixture. No inference is called. It tests 320×568, 390×844, 844×390 touch landscape, and 1280×800, plus a simulated keyboard visual viewport (260px high, 20px top offset). A real device keyboard still requires hosted smoke validation by the integration lane.

*** `logs/brief-v2-workspaces/browser-proof.json` records geometry, scrolling, 16px inputs, draft preservation, persistence, unknown-metric rejection, quote-update focus preservation, console errors and inference requests. PNGs beside it show each viewport and simulated keyboard. `logs/brief-v2-workspaces/javascript-tests.txt` records the full JS suite. Root integration owns cataloging/copying these proof artifacts into the global log index and the buildout changelog.

Observed lane results (2026-10-16): **239/239 JavaScript tests**, including 13 focused dashboard/relationship/geometry tests; **4/4 existing chat browser tests** (`tests/test_chat_brief.py` and `tests/test_chat_dock.py`); focused browser proof **OK** at all four dimensions, zero browser errors and zero inference requests. `legacy-chat-tests.txt` is beside the other proof files. The first browser-harness run exposed a missing UTF-8 declaration in its synthetic page, which was corrected; the product index already declares UTF-8. The existing exact-six-chip regression was preserved by placing dashboard creation in a separate tools row.
