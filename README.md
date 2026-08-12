# Northstar Trader

Northstar Trader is a private, multi-provider desktop trading workspace. TradeStation supplies futures market data and order execution; Schwab supplies read-only equity, ETF, index, option, account, position, and order data. A React frontend talks to an embedded Rust/Tauri backend that owns OAuth, broker networking, streaming, validation, local persistence, and optional Supabase synchronization.

> [!CAUTION]
> This project can submit real orders when it is connected to TradeStation LIVE. It is early-stage, private software—not financial advice or a finished commercial trading system. Develop and validate against SIM before using LIVE.

## Provider boundaries

| Integration | Current responsibility | Can Northstar execute? |
| --- | --- | --- |
| TradeStation | Futures symbols, charts, quotes, contracts, accounts, balances, positions, orders, and history | Yes—futures market entries, protective-order replacement, cancellation, and position close |
| Schwab | Equity, ETF, index, and option market data plus account, balance, position, and order monitoring | No—every Schwab workflow is read-only; the option ticket is an analytical draft |
| Supabase | Optional owner-scoped journal, preference sync, Realtime notifications, and private entry-chart images | Not applicable |
| Trading Economics; NYSE/CME schedule references | Fetched U.S. economic calendar plus built-in exchange schedules and allowlisted source links | Not applicable |
| Roll Call / Truth Social | Optional catalyst correlation for rapid market moves | Not applicable |

TradeStation and Schwab authenticate, stream, and reconnect independently. Switching TradeStation between SIM and LIVE never changes the Schwab connection.

## What is implemented

### Charting and market data

- Candlestick, line, area, fixed-tick Renko, and Point & Figure charts powered by Lightweight Charts 5.
- Per-tab Renko brick size, price source, and one/two-brick reversal settings; Point & Figure box size, price source, and reversal-box settings.
- Built-in `1m`, `5m`, `15m`, `30m`, `1h`, `4h`, daily, weekly, and monthly intervals. Whole-minute custom intervals from 1–1,440 minutes can be session-only or saved and synchronized.
- Provider-aware symbol search with recent-symbol history. Futures route to TradeStation; equities, ETFs, and indexes route to Schwab.
- Shared bar streams for matching charts and background consumers, plus provider-deduplicated quote streams for charts, trade contracts, positions, options, and the watchlist.
- A single shared Schwab Streamer connection for equity, ETF, index, and option updates. Schwab history includes extended hours, and `1h`/`4h` bars are aggregated locally on New York calendar boundaries.
- SQLite-backed candle caches, immediate cached startup data, current history refresh, viewport-driven VWAP range loading, and lazy older-bar backfill.
- A quota-aware TradeStation scheduler with response-header reconciliation, historical-credit pacing, trading reserves, rate-limit state, and reset-aware reconnects.
- Exchange/local/UTC and named-market timezone choices, a current-price marker, candle countdown, scroll-to-latest control, and configurable overnight shading with uniform or separate Asia/London colors.
- Fixed EMA 20, EMA 200, SMA 50, and New York regular-session VWAP overlays with per-overlay visibility and color controls.
- Opt-in Failed Breakout entry markers on candlestick charts, with per-tab pivot strength, futures tick tolerance, reclaim window, and swing-pairing controls. It defaults to off with 2-bar pivots, 4 ticks, a 3-candle reclaim window, and consecutive pairing; historical and completed real-time candles are evaluated with the same rules.
- Schwab equity/ETF gamma-exposure overlays built from the current option chain and updated by the option stream. Views include Net GEX, Calls/Puts, or Open Interest; expirations can be aggregated or displayed separately and selected by preset or date.
- Optional Trading Today event markers on eligible intraday candle, line, and area charts, filtered by impact. Markers use the chart timezone and support hover/focus details and pinning.

### Workspace, watchlists, and drawings

- Up to twelve persisted chart tabs and six per-window layouts: single, two columns, two rows, three columns, three rows, and a four-chart grid.
- Resizable split panes with keyboard-accessible dividers, double-click reset, and temporary expansion of the focused chart. For charts showing the same provider and symbol, crosshair sync works across visible panes, different timeframes, and detached windows.
- Native chart windows with drag-to-detach, tab reordering and cross-window movement, redocking, close reconciliation, and mixed-DPI geometry/maximized-state restoration.
- A mixed-provider top-bar watchlist with remote symbol search, add/remove controls, pointer or keyboard reordering, and live prices/day change. Its symbols participate in the 100-instrument workspace quote union shared with charts, resolved contracts, and drawing alerts.
- Horizontal lines and horizontal rays with direct price entry, color, width, lock, move, delete, and high/low—or synthetic level—magnet snapping.
- One-time or recurring drawing-cross alerts for either direction, crosses above, or crosses below, with configurable sound/duration and a workspace-wide alert manager.
- Analysis-only Long/Short position drawings with draggable entry, target, stop, and time bounds; editable quantity; and live target, risk, tick, percentage, P&L, and risk/reward metrics.
- Drawings persist by symbol. Chart tabs also retain style, timeframe, indicators, GEX settings, timezone, magnet state, trade-contract choice, and alert configuration.
- Collapsible right order panel, fullscreen charts, and a resizable/maximizable brokerage drawer. The Combined view provides independent account selection, broker health, account totals, today/open P&L, and merged positions. TradeStation and Schwab views add their detailed balances, filtered orders/history, notifications, and CSV export.

### TradeStation futures workflow and safety

- Explicit SIM/LIVE switching. Every transition into LIVE turns order review back on; review can still be disabled afterward as a device-local preference.
- Market entries with required server-side take-profit and stop-loss brackets, DAY/GTC duration, tick and price-geometry validation, and estimated dollar risk.
- Contract quantity or risk-dollar sizing. Risk sizing supports a strict budget or an explicit minimum-one-contract policy, and updates as the projected entry or stop changes.
- Projected take-profit and stop-loss lines can be dragged before submission. Take profit can be set from an R-multiple, and stops can be placed beyond the latest confirmed two- or three-bar swing with a configurable tick offset.
- Automatic or manual selection of a concrete contract while charting a continuous future. Continuous symbols are never sent as order symbols.
- CME U.S. equity-index rollover status on charts and positions, once-daily sound/log warnings, next-contract actions, and a native per-order acknowledgment after the customary roll date.
- Optional TradeStation confirmation preview with commission, initial-margin, validation, and broker summary when returned by the API.
- Independent Long and Short master switches plus nested AND/OR rules for market price, configurable SMA/EMA comparisons, EMA cross lookback, timezone-aware trading windows, and post-candle-close entry windows.
- Saved entry rules can be synchronized and locked read-only behind a three-code, case-sensitive unlock challenge. Per-side alerts evaluate every open chart and publish sound, notifications, and persistent Long/Short tab badges.
- Opt-in Rust-enforced account policies for maximum order quantity, total open contracts, per-trade risk, aggregate open risk, realized daily loss, required protective stop, allowed session, consecutive-loss cooldown, and order rate. Configured rules fail closed for risk-increasing orders when required state is unavailable; all are disabled until explicitly enabled.
- A durable mutation ledger records place, replace, cancel, close, and kill-switch intent before broker submission. Unknown or incomplete outcomes block equivalent retries and appear in a reconciliation UI with safe automatic and explicit manual matching.
- An account kill switch cancels working orders and flattens open positions after an environment-specific typed confirmation.
- Live position, entry, take-profit, and stop-loss chart lines include configurable full-position dollar and R-multiple labels. R uses the journal's original risk baseline when it is known, remains stable after stop movement, and overlapping labels are automatically separated.
- Protective take-profit and stop-loss lines are draggable. Replacements use optimistic feedback, broker-outcome-aware error handling, and rollback when rejected.
- Closing a position cancels working close-side orders, confirms they are inactive, refreshes the live quantity, and then sends the flattening market order. Working orders can also be cancelled directly.
- Live positions/orders use streams with snapshot polling and reconnect fallbacks. Balances, beginning-of-day balances, and paginated history remain available in the provider-specific brokerage views; unresolved durable mutation outcomes are handled by the reconciliation UI in Settings.

### Schwab monitoring and Options workspace

- Read-only Schwab accounts, balances, positions, today/open P&L, and recursively flattened order history. Account-activity events trigger refreshes, with polling and reconnect fallbacks.
- Equity entry-price and held-option strike lines on underlying charts, including option expiration/side/quantity labels and live unrealized P&L.
- A dedicated Options workspace for Schwab equity, ETF, and index underlyings with standard expiration selection, adjustable strike depth, underlying quote, call/put bid-ask sizes, volume, open interest, delta, gamma, theta, and vega.
- REST snapshots refresh every five minutes and are upgraded by live option updates when stream capacity is available; the UI distinguishes live, delayed, stale, and REST-only states.
- Held contracts are highlighted and listed with current mark, open P&L, today P&L, expiration navigation, and automatic expansion to out-of-range held strikes.
- The Options workspace can detach into a native window and redock without creating a second Schwab session.
- A draft-only option strategy builder supports up to four buy/sell legs, ratios, quantity, market/limit, DAY/GTC, debit/credit, live natural-price refresh, strategy classification, and estimated value. It never submits an order.

### Alerts and market context

- EMA 200 price-cross alerts configured independently per chart and source timeframe, with chime, bell, pulse, or siren audio and selectable duration.
- Drawing, entry-rule, and contract-roll alerts share persistent settings, previewable audio, notification output, and deduplication appropriate to each alert type.
- Trading Today shows the current New York trading date—or Monday's calendar on Sunday—with U.S. events, actual/consensus/previous/forecast values, configurable display timezone, cached fallback, manual refresh, and allowlisted source links.
- The same dashboard shows the next four known NYSE/CME schedule changes, closures, early closes, and modified-hours warnings with a verified-through indicator.
- Opt-in, desktop-only Truth Social catalyst alerts watch the active main-window chart for a 30-second move at least three times recent one-minute volatility and four ticks. A trigger polls Roll Call's archive for a nearby original @realDonaldTrump post, deduplicates locally, and opens only validated `https://truthsocial.com` links.

### Trade journal and performance analytics

- A dedicated native Trade Journal window with provider/account/environment selection, cloud status, manual sync, a Sunday–Friday monthly P&L or R calendar, and daily campaign ledgers.
- Flat-to-flat futures campaign reconstruction across partial fills, scale-ins, scale-outs, commissions, and position reversals.
- Schwab long/short strangle reconstruction from authoritative order snapshots, including call/put execution legs, partial closes, linked one-leg rolls, and configurable estimated option fees.
- A durable SQLite outbox for entry intent, fills, closes, and observed stop-loss or take-profit movement, reconciled with broker history and Supabase.
- Exact initial-risk provenance for Northstar entries, with inferred or unknown labels for incomplete imported history. Active chart R labels use that same persisted baseline.
- One private entry-chart PNG per Northstar futures campaign, captured after the position and protective lines appear, retried in memory during the desktop session, and displayed in an expandable trade-detail view.
- Trade details include execution/risk timelines, original plan, fees, gross/net P&L, R, editable notes, up to twelve tags, and immutable execution history.
- A Stats page with month, rolling 30/90-day, year-to-date, all-time, and custom ranges; dollar/R equity curves; daily outcome bars; win rate; payoff ratio; profit factor; expectancy; drawdown; average win/loss/hold; streaks; largest outcomes; and breakdowns by symbol, direction, setup tag, and New York entry hour.

### Audit, persistence, and cloud sync

- A local audit viewer for API calls, saved-record changes, streams, and system events with live updates, health/degraded state, search, category/status/source/time filters, expandable redacted evidence, pagination, copy, and JSON export.
- Native audit history is kept in SQLite for seven days with a 10,000-event cap. The browser demo provides session-only diagnostic fixtures.
- The native workspace, bar caches, journal outbox, safety policies, broker mutation state, Trading Today cache, and screenshot metadata live in the app-data SQLite database. Credentials remain outside it in the OS vault.
- Optional Supabase sync is owner-scoped with row-level security. It covers journal data, notes/tags, private screenshot objects, and categorized non-secret preferences with conflict-aware revisions and Realtime notifications.
- The local workspace continues operating when cloud services are offline; preference changes are queued and only changed categories are uploaded.

### Browser demo

`npm run dev` starts a browser-safe UI demo with futures and AAPL/SPY fixtures, generated bars and quotes, TradeStation and Schwab accounts, positions, orders, balances, option chains/GEX, Trading Today, journal statistics, and session-only audit events. Browser mode does not authenticate with either provider and cannot place, replace, cancel, close, reconcile, or flatten real orders. Its workspace and Trading Today cache are saved in browser `localStorage`.

## Technology

| Layer | Technology |
| --- | --- |
| Desktop shell | Tauri 2 |
| Frontend | React 19, TypeScript, Vite |
| Charts | Lightweight Charts 5 |
| Native API layer | Rust, Tokio, Reqwest |
| Local persistence | SQLite via Rusqlite |
| Secret storage | OS credential vault via Keyring |
| Optional cloud | Supabase Auth, REST, Realtime, and Storage |
| Tests | Vitest and Rust test harness |

The current native development targets are macOS and Windows.

## Prerequisites

- Browser demo: Node.js 20.x or Node.js 22+, plus npm.
- Native development and builds: Rust 1.88 or newer with Cargo for the current locked dependency graph, in addition to Node.js and npm.
- Native TradeStation connectivity: a TradeStation API application and futures-enabled account.
- Native Schwab connectivity: a Schwab Trader API application with Market Data Production and Trader User Preference access.
- macOS native development: Xcode Command Line Tools and the system webview.
- Windows native development: WebView2 Runtime, Visual Studio Build Tools with Desktop development with C++, and a Windows 10/11 SDK.

## Quick start

Install dependencies:

```bash
npm install
```

Run the safe browser demo:

```bash
npm run dev
```

Run the native desktop app on macOS or on a normally configured Windows development shell:

```bash
npm run tauri dev
```

On a Windows machine where the Visual Studio developer environment does not include the installed SDK paths, use the included launcher. It detects x64 Build Tools and Windows Kits installed in their standard `C:\Program Files (x86)` locations:

```powershell
C
```

### Build for macOS

Create a release-mode macOS application bundle and installer disk image:

```bash
npm run tauri build
```

On an Apple Silicon Mac, the build produces these files:

- `src-tauri/target/release/bundle/macos/Northstar Trader.app`
- `src-tauri/target/release/bundle/dmg/Northstar Trader_<version>_aarch64.dmg`

To build only the native executable, without an `.app` bundle or DMG installer:

```bash
npm run tauri build -- --no-bundle
```

The executable is written to `src-tauri/target/release/northstar-trader`. Run it from Terminal with:

```bash
./src-tauri/target/release/northstar-trader
```

The produced binary targets the architecture of the build Mac. To distribute an app to other Macs, sign it with an Apple Developer ID certificate and notarize it.

### Build for Windows

Build the configured Windows installer bundles:

```powershell
npm run tauri build
```

On an x64 Windows build host, the bundle step produces an MSI and an NSIS setup executable under:

- `src-tauri\target\release\bundle\msi\Northstar Trader_<version>_x64_en-US.msi`
- `src-tauri\target\release\bundle\nsis\Northstar Trader_<version>_x64-setup.exe`

Build a single Windows executable without generating MSI or NSIS installer bundles:

```powershell
npm run tauri build -- --no-bundle
```

The executable is written to `src-tauri\target\release\northstar-trader.exe`. The target Windows machine must have the WebView2 Runtime installed. Distribution builds are unsigned unless a Windows signing identity is configured separately.

## TradeStation configuration

1. Add `http://localhost:8080` to the allowed callback URLs for the TradeStation API application.
2. Ensure the application can request these scopes:

   ```text
   openid profile offline_access MarketData ReadAccount Trade
   ```

3. Start the native app and select the connection status in the title bar.
4. Enter the TradeStation client ID and client secret, then choose **Save credentials**.
5. Choose **Connect to TradeStation** and complete authorization in the system browser.
6. Return to Northstar Trader and begin in SIM.

The local OAuth listener binds to `127.0.0.1:8080` and waits up to five minutes, so that port must be available while signing in.

## Schwab configuration

1. Register `https://127.0.0.1:8182/callback` exactly as the callback URL in the Schwab Developer Portal.
2. Start the native app and open **Settings → Schwab API**.
3. Enter the Schwab App Key and App Secret, then choose **Save**.
4. Choose **Connect** and complete authorization in the dedicated in-app window.
5. Select a Schwab account in the brokerage drawer. Its positions, balances, and orders are monitoring-only: Northstar never exposes Schwab close, cancel, or order-entry actions.
6. Select an equity, ETF, or index from the combined symbol picker. Open **Indicators** on equity and ETF charts to enable GEX and choose the included expirations.
7. Open the **Options** workspace for the read-only chain, held-contract monitoring, and analytical multi-leg draft. The draft cannot be submitted.

The selected Schwab account is also the account monitored by the trade journal. Filled two-leg call/put strangles are recorded locally from authoritative order snapshots and reconciled during Journal Sync. Configure the separate per-contract option fee under **Settings → Journal**.

Schwab and TradeStation connections are independent. Changing the TradeStation SIM/LIVE environment does not affect Schwab charts or streams.

GEX and the Options workspace use only the current Schwab option chain in memory. They do not collect option history or write option snapshots to SQLite. REST chain snapshots refresh every five minutes while a consumer remains open and are discarded after the last consumer closes.

## Supabase cloud configuration

1. Create a Supabase project and an email/password user for the private Northstar owner.
2. Apply every SQL file in [`supabase/migrations`](supabase/migrations) in filename order with the Supabase CLI or SQL editor.
3. In Northstar, open **Settings → Supabase connection** and enter the project URL, publishable key, existing user email/password, and first journal backfill date. The date is inclusive. To discard all existing local/cloud journal history and record only new orders, connect first and choose **Start fresh now**.
4. Open the journal from the book icon in the main chart toolbar and press **Sync** for execution history. App preferences save locally immediately and upload about one second after an edit. Supabase Realtime normally notifies another open computer within a few seconds. Northstar also pulls at startup, on a throttled app-focus check, every five minutes while Realtime is connected, and every 30 seconds while it is reconnecting; only changed preference categories are uploaded.

The password is used only for the initial token exchange. Northstar stores the Supabase refresh token in its own operating-system vault record and keeps access tokens in memory. Use only the project's publishable key; never provide a service-role or secret key. Journal and preference tables use row-level security keyed to the authenticated Supabase user.

Entry-chart PNGs use the private `trade-screenshots` Supabase Storage bucket created by migration `202607150006_trade_screenshots.sql`. Images are uploaded and downloaded with the authenticated journal user, are limited to 5 MB, and are never written to SQLite or the local filesystem. If cloud access is unavailable after an entry, the order continues normally and the image is retried only while that desktop session remains open.

Supabase synchronizes chart tabs, window/layout identities, custom timeframes, recent symbols, chart and indicator settings, GEX selections, Options workspace preferences, EMA and Truth Social alert settings, drawings, the watchlist, crosshair/session/economic-event display settings, order-ticket and rollover preferences, entry rules and their lock/alert state, and both journal fee rates. Window geometry, split ratios, panel layout, SIM/LIVE selection, selected broker accounts, order-confirmation state, transient order/option drafts, and alert history remain local to each computer.

## Security and local data

- The TradeStation client ID, client secret, and OAuth refresh token are stored together in a TradeStation-only operating-system vault record. TradeStation access tokens remain only in native process memory. None of these values are placed in frontend storage, SQLite, or Supabase.
- The Schwab App Key, App Secret, and refresh token use a separate operating-system vault record. Schwab access tokens also remain only in native process memory.
- The Supabase refresh token is stored in a separate Supabase-only vault record. The Supabase password is never retained, and no Supabase connection fields or tokens are included in synchronized preference payloads.
- Chart workspace state, cached bars, journal/outbox data, safety policies, durable broker mutations, Trading Today cache, and audit history are stored in `northstar.sqlite3` under the operating system's Tauri application-data directory. The local workspace continues to work while Supabase is offline.
- Entry-chart image bytes are cloud-only; SQLite caches only their private object path, dimensions, and capture time.
- TradeStation SIM and LIVE bar caches are separate. Schwab uses its own provider namespace and never mixes with either TradeStation environment.
- Native audit evidence is recursively redacted for credential/token/password-like fields and data URLs. Plain Schwab account/activity payloads are excluded from the audit boundary entirely.
- TradeStation account IDs are masked before they are displayed by the app.
- Plain Schwab account numbers remain in native memory only. Renderer account IDs use Schwab's encrypted hashes, and displayed IDs are masked.
- Real provider HTTP/WebSocket calls, credential handling, broker mutations, and final order/risk validation live in Rust. The frontend invokes a constrained set of Tauri commands, and the renderer CSP does not connect directly to broker APIs.

Order confirmation is enabled in a new workspace and is forced on whenever the app switches into LIVE. It can still be disabled afterward, and that device-local choice persists. Treat LIVE as real-money execution even when the UI looks familiar from SIM.

## Development commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the browser demo on `127.0.0.1:1420` |
| `npm run preview` | Preview the production frontend build |
| `npm run build` | Typecheck and build the frontend |
| `npm run typecheck` | Run TypeScript without emitting files |
| `npm run test:unit` | Run the frontend unit suite |
| `npm run tauri dev` | Start the native app in development |
| `npm run tauri build` | Build native desktop bundles (`.app`/DMG on macOS; MSI/NSIS on Windows) |
| `npm run tauri build -- --no-bundle` | Build one native executable without installer bundles |
| `npm run desktop:windows` | Discover standard-path x64 Build Tools/Windows Kits, then start Tauri |

Run all current automated checks:

```bash
npm run typecheck
npm run test:unit
cargo test --manifest-path src-tauri/Cargo.toml
```

## Project structure

```text
.
├── src/                              # React frontend
│   ├── App.tsx                       # Main workspace, streams, panels, and trading flows
│   ├── components/
│   │   ├── TradingChart.tsx          # Charts, indicators, drawings, events, and trade lines
│   │   ├── ChartPaneGrid.tsx         # Resizable multi-chart layouts
│   │   ├── OptionChainWorkspace.tsx  # Docked/detached Schwab options workspace
│   │   ├── EntryRulesBuilder.tsx     # Long/Short rule and alert editor
│   │   ├── TradingTodayModal.tsx     # Economic calendar and market schedules
│   │   ├── TradeJournalWindow.tsx    # Calendar, campaign ledger, and trade detail
│   │   ├── TradeJournalStats.tsx     # Performance analytics
│   │   └── AuditLogModal.tsx         # Searchable local audit viewer
│   ├── lib/                          # Domain logic, adapters, alerts, analytics, and tests
│   └── types.ts                      # Shared frontend domain types
├── src-tauri/
│   ├── src/lib.rs                    # Tauri commands, OAuth callbacks, shared tasks, and events
│   ├── src/tradestation.rs           # TradeStation token, REST/stream, parsing, and validation client
│   ├── src/schwab.rs                 # Schwab REST and token client
│   ├── src/schwab_oauth.rs           # Dedicated OAuth webview and callback interception
│   ├── src/schwab_streamer.rs        # Shared Schwab WebSocket streamer
│   ├── src/safety.rs                 # Risk policies, mutation ledger, reconciliation
│   ├── src/journal.rs                # Journal reconstruction and Supabase client
│   ├── src/audit.rs                  # Redacted SQLite audit service
│   ├── src/storage.rs                # Credential vault and core SQLite persistence
│   ├── src/trading_today.rs          # Economic calendar and schedule sources
│   └── src/truth_social.rs           # Roll Call feed and URL validation
├── supabase/
│   ├── migrations/                   # Ordered owner-RLS schema and storage migrations
│   └── tests/                        # pgTAP RLS checks
└── scripts/dev-windows.ps1           # Standard-path Windows toolchain helper
```

The desktop runtime is embedded; there is no separate local application server. Its main data path is:

```text
TradeStation REST/streams ─┐
Schwab REST/Streamer ──────┼─> Rust/Tauri auth, validation, tasks, and snapshots
Trading Economics/Roll Call┘                    │
                                                ├─ Tauri commands/events ─> React workspace
                                                ├─ SQLite app data and caches
                                                ├─ OS credential vault
                                                └─ Supabase Auth/REST/Realtime/Storage (optional)
```

The main React window orchestrates broker subscriptions, brokerage monitoring, option-stream budgeting, persistence, and detached-window coordination. Rust owns the broker clients, shared stream registries, and async tasks. Detached chart and option windows receive synchronized state/events instead of opening independent broker sessions.

## Current constraints

- The order ticket exposes market entries only, even though the native model and validation layer already understand limit, stop-market, and stop-limit orders.
- Both a valid take-profit and stop-loss are required for a new entry.
- Schwab equity and option execution is not implemented. The Options workspace ticket is explicitly draft-only.
- Drawing UI supports horizontal lines, horizontal rays, and analysis-only long/short position tools.
- Indicators are fixed EMA 20, EMA 200, SMA 50, NY-session VWAP, and Failed Breakout presets; arbitrary moving-average periods and multiple custom instances are not exposed.
- There is one editable watchlist rather than multiple named lists.
- Chart tabs are capped at twelve. The workspace quote union—charts, resolved futures contracts, watchlist symbols, and drawing-alert-only instruments—is capped at 100 instruments; Options and held-position subscriptions are managed separately.
- GEX and option chains are current-snapshot/live-stream tools; Northstar does not retain historical option-chain data.
- Trading Today's CME holiday schedule carries a verified-through date of December 31, 2026 and directs the user to the CME source after that range.
- Journal statistics do not yet calculate MAE/MFE, and there is no market-replay workflow.
- Browser demo data is illustrative and is not a broker simulator or execution test.
- Market-data availability, real-time status, account access, and streaming behavior depend on each provider's permissions and entitlements.

## Status

As of August 10, 2026, the verified baseline is 393 passing frontend tests across 44 files and 165 passing Rust tests. Two pgTAP scripts cover Supabase row-level-security behavior but are not wired into an automated command. There is no automated end-to-end suite, CI workflow, signing/notarization configuration, updater, or release pipeline in the repository yet.
