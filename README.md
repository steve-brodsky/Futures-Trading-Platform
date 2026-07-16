# Northstar Trader

Northstar Trader is a private futures charting and order-entry desktop client for TradeStation. It combines a React trading workspace with a Rust/Tauri native layer for OAuth, live market and brokerage data, order execution, secure credential storage, and local persistence.

> [!CAUTION]
> This project can submit real orders when it is connected to TradeStation LIVE. It is early-stage, private software—not financial advice or a finished commercial trading system. Develop and validate against SIM before using LIVE.

## What is implemented

### Charts and market data

- Candlestick, line, area, fixed-tick Renko, and Point & Figure charts powered by TradingView Lightweight Charts.
- Per-tab Renko and Point & Figure construction settings, including close or deterministic high/low input and configurable reversal thresholds.
- `1m`, `5m`, `15m`, `30m`, `1h`, `4h`, daily, weekly, and monthly timeframes.
- Shared streaming bars across matching charts, EMA alerts, and VWAP consumers, plus a deduplicated quote stream for charts, contracts, and the watchlist.
- SQLite-backed candle caching, initial history, and lazy backfill when the chart approaches its oldest loaded bar.
- Quota-aware TradeStation request scheduling with response-header reconciliation, historical-credit pacing, trading reserves, and reset-aware reconnects.
- New York regular-session shading, an exchange-aware chart timezone selector, current-price label, and candle countdown.
- EMA 20, EMA 200, SMA 50, and New York session VWAP overlays with visibility and color controls.
- EMA 200 cross alerts configured independently by chart and timeframe, including sound and duration choices.

### Workspace

- Up to six chart tabs with persisted symbols, timeframes, indicators, alert settings, and visible preferences.
- Native detached chart windows with drag-to-detach, cross-window tab movement, redocking, and restored window geometry.
- Horizontal lines and horizontal rays with color, width, lock, move, delete, and high/low magnet snapping.
- Persistent drawings by symbol.
- Right-side order/watchlist panel and a resizable brokerage panel for positions, orders, order history, balances, and notifications.
- CSV export for the active brokerage table.

### Trading workflow

- SIM and LIVE TradeStation environments with an explicit environment-switch confirmation.
- Market entries with required server-side take-profit and stop-loss brackets, DAY/GTC duration, tick validation, and estimated dollar risk.
- Automatic or manually selected concrete trade contract when charting a continuous futures symbol. Continuous symbols themselves are never sent as order symbols.
- Optional order-review step using TradeStation's confirmation endpoint, including commission and initial-margin estimates when supplied by the API.
- Long and short entry rules built from nested AND/OR comparisons between market price, SMA, and EMA values.
- Position and protective-order lines on the chart, including dollar and R-multiple labels.
- Drag-to-adjust bracket take-profit and stop-loss orders with optimistic UI rollback if TradeStation rejects the replacement.
- Position close workflow that cancels working exit orders, waits for cancellation confirmation, refreshes the live quantity, and then submits the flattening market order.
- Order cancellation, paginated order history, account balances, and live position/order updates with snapshot polling as a fallback.

### Trade journal

- Dedicated native Trade Journal window opened from the chart toolbar, with a Sunday–Friday P&L calendar and daily campaign ledger.
- Flat-to-flat reconstruction across partial fills, scale-ins, scale-outs, commissions, and position reversals.
- Durable SQLite outbox for entry intent, fills, closes, and observed stop-loss or take-profit moves.
- Exact initial-risk provenance for Northstar entries, with inferred or unknown labels for incomplete broker history.
- Owner-scoped Supabase synchronization, editable notes/tags, and immutable execution history.

### Browser demo

`npm run dev` starts a browser-safe UI demo with generated bars, quotes, positions, orders, and balances. Browser mode does not authenticate with TradeStation and cannot place, replace, cancel, or close real orders. Its workspace is saved in browser `localStorage`.

## Technology

| Layer | Technology |
| --- | --- |
| Desktop shell | Tauri 2 |
| Frontend | React 19, TypeScript, Vite |
| Charts | Lightweight Charts 5 |
| Native API layer | Rust, Tokio, Reqwest |
| Local persistence | SQLite via Rusqlite |
| Secret storage | OS credential vault via Keyring |
| Tests | Vitest and Rust test harness |

The current native development targets are macOS and Windows.

## Prerequisites

- Node.js 20 or newer and npm.
- Rust 1.77 or newer with Cargo.
- A TradeStation API application and futures-enabled TradeStation account for native connectivity.
- macOS: Xcode Command Line Tools and the system webview.
- Windows: WebView2 Runtime, Visual Studio Build Tools with Desktop development with C++, and a Windows 10/11 SDK.

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

On a Windows machine where the Visual Studio developer environment does not include the installed SDK paths, use the included auto-detecting launcher:

```powershell
npm run desktop:windows
```

### Build for macOS

Create an optimized macOS application bundle and installer disk image:

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

Build a single Windows executable without generating MSI or NSIS installer bundles:

```powershell
npm run tauri build -- --no-bundle
```

The executable is written to `src-tauri\target\release\northstar-trader.exe`. The target Windows machine must have the WebView2 Runtime installed.

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

## Supabase cloud configuration

1. Create a Supabase project and an email/password user for the private Northstar owner.
2. Apply every SQL file in [`supabase/migrations`](supabase/migrations) in filename order with the Supabase CLI or SQL editor.
3. In Northstar, open **Settings → Supabase connection** and enter the project URL, publishable key, existing user email/password, and first journal backfill date. The date is inclusive. To discard all existing local/cloud journal history and record only new orders, connect first and choose **Start fresh now**.
4. Open the journal from the book icon in the main chart toolbar and press **Sync** for execution history. App preferences save locally immediately and synchronize with Supabase about one second after an edit. Northstar also pulls at startup, on a throttled app-focus check, and every five minutes as a cross-computer safety check; only changed preference categories are uploaded.

The password is used only for the initial token exchange. Northstar stores the Supabase refresh token in its own operating-system vault record, keeps access tokens in memory, and never accepts a service-role key. Journal and preference tables use row-level security keyed to the authenticated Supabase user.

Supabase synchronizes open chart tabs and grouping, chart/indicator settings, EMA alert configuration, drawings, the watchlist, order-entry preferences and entry rules, and the journal fee rate. Monitor geometry, panel layout, SIM/LIVE selection, selected broker account, order-confirmation safety state, transient order drafts, and alert history remain local to each computer.

## Security and local data

- The TradeStation client ID, client secret, and OAuth refresh token are stored together in a TradeStation-only operating-system vault record. They are not placed in frontend storage, SQLite, or Supabase.
- The Supabase refresh token is stored in a separate Supabase-only vault record. The Supabase password is never retained, and no Supabase connection fields or tokens are included in synchronized preference payloads.
- The access token is kept in native process memory and refreshed shortly before expiration.
- Chart workspace state and cached bars are stored in `northstar.sqlite3` under the operating system's Tauri application-data directory. The local workspace continues to work while Supabase is offline.
- SIM and LIVE bar caches are separated by environment.
- TradeStation account IDs are masked before they are displayed by the app.
- Native HTTP calls and order validation live in Rust; the frontend invokes a constrained set of Tauri commands.

Order confirmation is enabled in a new workspace, but it can currently be disabled and that preference is persisted. Treat LIVE as real-money execution even when the UI looks familiar from SIM.

## Development commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the browser demo on `127.0.0.1:1420` |
| `npm run preview` | Preview the production frontend build |
| `npm run build` | Typecheck and build the frontend |
| `npm run typecheck` | Run TypeScript without emitting files |
| `npm run test:unit` | Run the frontend unit suite |
| `npm run tauri dev` | Start the native app in development |
| `npm run tauri build` | Build native desktop bundles (`.app` and DMG on macOS) |
| `npm run tauri build -- --no-bundle` | Build one native executable without installer bundles |
| `npm run desktop:windows` | Start Tauri with auto-detected Windows SDK paths |

Run all current automated checks:

```bash
npm run typecheck
npm run test:unit
cargo test --manifest-path src-tauri/Cargo.toml
```

## Project structure

```text
.
├── src/
│   ├── App.tsx                    # Workspace orchestration and trading UI
│   ├── components/
│   │   ├── TradingChart.tsx       # Chart lifecycle, drawings, and trade lines
│   │   └── EntryRulesBuilder.tsx  # Visual long/short entry-rule editor
│   ├── lib/                       # Indicators, alerts, contracts, workspace logic
│   └── types.ts                   # Shared frontend domain types
├── src-tauri/
│   ├── src/lib.rs                 # Tauri commands and stream supervision
│   ├── src/tradestation.rs        # TradeStation REST/stream client and validation
│   ├── src/storage.rs             # Credential vault and SQLite persistence
│   └── src/models.rs              # Native serialized domain types
└── scripts/dev-windows.ps1        # Windows toolchain environment helper
```

Market data and brokerage state follow this path:

```text
TradeStation API -> Rust/Tauri streams and snapshots -> Tauri events -> React workspace
                         |
                         +-> SQLite bar cache
```

The main window owns shared streams and persisted workspace state. Detached windows receive synchronized workspace updates and chart data rather than opening independent brokerage sessions.

## Current constraints

- The order ticket exposes market entries only, even though the native model and validation layer already understand limit, stop-market, and stop-limit orders.
- Both a valid take-profit and stop-loss are required for a new entry.
- Drawing UI currently exposes horizontal lines and horizontal rays only.
- The watchlist is persisted but does not yet have add, remove, reorder, or remote-symbol management controls.
- Chart tabs are capped at six.
- Browser demo data is illustrative and is not a broker simulator or execution test.
- Market-data availability, real-time status, account access, and streaming behavior depend on TradeStation permissions and entitlements.

## Suggested roadmap

### 1. Trading safety and correctness

- Enforce account-level guardrails in the Rust command layer: maximum contracts, maximum per-trade risk, daily loss limit, trading-hours lockout, cooldown after losses, and an emergency flatten/cancel control.
- Make every transition into LIVE force order review back on for the session, and add a stronger typed or press-and-hold LIVE acknowledgement.
- Persist a redacted, append-only audit trail for order intent, confirmation, submission, replacement, cancellation, broker response, and stream reconciliation.
- Correct the account header to use TradeStation's `TodaysProfitLoss` value; it currently labels realized P&L as “Today’s profit.”
- Add integration tests around stale quotes, environment changes, token refresh, reconnects, duplicate events, indeterminate orders, and close-position races.

### 2. Complete the core trading workspace

- Add editable watchlists with remote symbol metadata, multiple named lists, drag ordering, and contract-roll assistance.
- Expose limit, stop-market, and stop-limit entries in the ticket; the native order layer already supports them.
- Add quantity presets and risk-based sizing from stop distance, account equity, and a configurable risk percentage.
- Expand chart trading to create, modify, and cancel working entry orders, plus cancel-all and flatten-all actions with explicit safeguards.
- Turn indicators into editable instances with custom periods, colors, and alert conditions instead of a fixed preset list.
- Add trend lines, rays, rectangles, Fibonacci tools, annotations, and reusable drawing templates.
- Add named workspace layouts and a visible reset/import/export flow.

### 3. Reliability, usability, and maintainability

- Add a diagnostics panel for stream health, quote age, API latency, reconnect attempts, cache coverage, and last successful brokerage refresh.
- Add a command palette plus configurable keyboard shortcuts.
- Improve accessibility with focus trapping, complete keyboard operation, reduced-motion support, and automated accessibility checks.
- Add Playwright/Tauri end-to-end coverage using a deterministic mock TradeStation service.
- Break the large `App.tsx`, `TradingChart.tsx`, and native TradeStation client into feature-focused modules and state hooks.
- Add CI for frontend and Rust tests, dependency auditing, signed release artifacts, and an explicit database/workspace migration strategy.

### 4. Review and analytics

- Build an execution journal that joins orders, fills, screenshots, notes, tags, MAE/MFE, commissions, and R-multiples.
- Add daily and weekly performance views for expectancy, win rate, average R, drawdown, time-of-day, setup, and instrument.
- Add market replay against cached or imported bars for practicing the exact order and entry-rule workflow without broker execution.
- Add session levels and analytics such as prior-day high/low, overnight range, opening range, anchored VWAP, volume profile, and economic-event markers.

## Status

The current test baseline is 192 passing frontend unit tests and 68 passing Rust tests. There is no end-to-end suite or release pipeline in the repository yet.
