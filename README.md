# Northstar Trader

A private, cross-platform futures trading desktop client for TradeStation. The app uses Tauri 2, React, Rust, and TradingView Lightweight Charts.

## Development

Prerequisites: Node 20+, Rust 1.77+, Windows WebView2 or the macOS system webview.

```bash
npm install
npm run tauri dev
npm run desktop:windows
```

On this Windows workstation, Visual Studio Build Tools does not add its installed Windows SDK `um` paths to the developer environment. Use the included auto-detecting launcher instead:

```powershell
npm run desktop:windows
```

For UI-only development, run `npm run dev`. Browser mode uses clearly labeled demo market data and cannot place real orders.

## Market data

- The native app uses TradeStation HTTP streams for the active chart and a batched watchlist quote stream.
- Initial history loads up to 10,000 bars for common intraday intervals, with API-safe caps for 1h and 4h charts.
- Scroll near the left edge to fetch and cache older candles in SQLite.
- Use the chart-footer timezone menu to display Exchange, Local, UTC, or a supported IANA timezone. Bar timestamps remain stored as UTC epochs and are formatted with daylight-saving rules at display time.

## TradeStation setup

Configure the Auth0 API key with `http://localhost:8080` as an allowed callback. The app requests `openid profile offline_access MarketData ReadAccount Trade`. API credentials and refresh tokens are stored through the operating system credential service and never persisted in frontend storage.

Start in SIM. LIVE is deliberately guarded and quick-submit must be acknowledged again each session.
