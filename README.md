# Northstar Trader

A private, cross-platform futures trading desktop client for TradeStation. The app uses Tauri 2, React, Rust, and TradingView Lightweight Charts.

## Development

Prerequisites: Node 20+, Rust 1.77+, Windows WebView2 or the macOS system webview.

```bash
npm install
npm run tauri dev
```

On this Windows workstation, Visual Studio Build Tools does not add its installed Windows SDK `um` paths to the developer environment. Use the included auto-detecting launcher instead:

```powershell
npm run desktop:windows
```

For UI-only development, run `npm run dev`. Browser mode uses clearly labeled demo market data and cannot place real orders.

## TradeStation setup

Configure the Auth0 API key with `http://localhost:8080` as an allowed callback. The app requests `openid profile offline_access MarketData ReadAccount Trade`. API credentials and refresh tokens are stored through the operating system credential service and never persisted in frontend storage.

Start in SIM. LIVE is deliberately guarded and quick-submit must be acknowledged again each session.
