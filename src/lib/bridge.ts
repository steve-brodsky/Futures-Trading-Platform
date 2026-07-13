import { invoke } from "@tauri-apps/api/core";
import type { Account, AccountBalance, Bar, ClosePositionResult, HistoricalOrderPage, OrderDraft, OrderPreview, OrderUpdate, Position, Quote, SymbolMeta, Timeframe, TradingEnvironment, WorkspaceState } from "../types";
import { demoAccounts, demoBalance, demoBodBalance, demoOrders, demoPositions, futures, makeDemoBars, quoteFor } from "./demo";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function native<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args);
}

export const api = {
  isNative: isTauri,
  async authStatus(): Promise<{ configured: boolean; authenticated: boolean }> {
    return isTauri ? native("auth_status") : { configured: false, authenticated: false };
  },
  async saveCredentials(clientId: string, clientSecret: string): Promise<void> {
    if (!isTauri) return;
    await native("save_credentials", { clientId, clientSecret });
  },
  async beginLogin(): Promise<void> {
    if (!isTauri) return;
    await native("begin_login");
  },
  async logout(): Promise<void> {
    if (!isTauri) return;
    await native("logout");
  },
  async setEnvironment(environment: TradingEnvironment): Promise<void> {
    if (isTauri) await native("set_environment", { environment });
  },
  async accounts(): Promise<Account[]> {
    return isTauri ? native("get_accounts") : demoAccounts;
  },
  async symbolSearch(query: string): Promise<SymbolMeta[]> {
    if (isTauri) return native("search_symbols", { query });
    const q = query.toLowerCase();
    return futures.filter((item) => `${item.symbol} ${item.description}`.toLowerCase().includes(q));
  },
  async symbolDetails(symbol: string): Promise<SymbolMeta> {
    if (isTauri) return native("get_symbol_details", { symbol });
    const match = futures.find((item) => item.symbol === symbol);
    if (!match) throw new Error(`Symbol details unavailable for ${symbol}`);
    return match;
  },
  async futureContracts(root: string): Promise<SymbolMeta[]> {
    if (isTauri) return native("get_future_contracts", { root });
    return futures
      .filter((item) => item.root === root.toUpperCase() && !item.symbol.startsWith("@") && item.expiration)
      .sort((left, right) => (left.expiration ?? "").localeCompare(right.expiration ?? ""));
  },
  async bars(symbol: string, timeframe: Timeframe): Promise<Bar[]> {
    if (isTauri) return native("get_bars", { symbol, timeframe });
    const base = symbol.startsWith("MNQ") ? 23010 : symbol.startsWith("MCL") ? 67 : symbol.startsWith("MGC") ? 3450 : symbol.startsWith("MYM") ? 44920 : 6218;
    return makeDemoBars(360, base, symbol.startsWith("MCL") ? 0.04 : symbol.startsWith("MGC") ? 0.7 : 1);
  },
  async cachedBars(symbol: string, timeframe: Timeframe): Promise<Bar[]> {
    return isTauri ? native("load_cached_bars", { symbol, timeframe }) : this.bars(symbol, timeframe);
  },
  async olderBars(symbol: string, timeframe: Timeframe, before: number): Promise<Bar[]> {
    if (isTauri) return native("get_older_bars", { symbol, timeframe, before });
    return [];
  },
  async startBarStream(subscriptionId: string, symbol: string, timeframe: Timeframe): Promise<void> {
    if (isTauri) await native("start_bar_stream", { subscriptionId, symbol, timeframe });
  },
  async stopBarStream(subscriptionId: string): Promise<void> {
    if (isTauri) await native("stop_bar_stream", { subscriptionId });
  },
  async startQuoteStream(subscriptionId: string, symbols: string[]): Promise<void> {
    if (isTauri) await native("start_quote_stream", { subscriptionId, symbols });
  },
  async stopQuoteStream(subscriptionId: string): Promise<void> {
    if (isTauri) await native("stop_quote_stream", { subscriptionId });
  },
  async startBrokerageStream(accountId: string): Promise<void> {
    if (isTauri) await native("start_brokerage_stream", { accountId });
  },
  async stopBrokerageStream(): Promise<void> {
    if (isTauri) await native("stop_brokerage_stream");
  },
  async quotes(symbols: string[]): Promise<Quote[]> {
    if (isTauri) return native("get_quotes", { symbols });
    return symbols.map((symbol, index) => quoteFor(symbol, index * 0.25));
  },
  async positions(accountId: string): Promise<Position[]> {
    return isTauri ? native("get_positions", { accountId }) : demoPositions;
  },
  async orders(accountId: string): Promise<OrderUpdate[]> {
    return isTauri ? native("get_orders", { accountId }) : demoOrders;
  },
  async balances(accountId: string): Promise<AccountBalance[]> {
    return isTauri ? native("get_balances", { accountId }) : [demoBalance];
  },
  async bodBalances(accountId: string): Promise<AccountBalance[]> {
    return isTauri ? native("get_bod_balances", { accountId }) : [demoBodBalance];
  },
  async historicalOrders(accountId: string, since: string, nextToken?: string): Promise<HistoricalOrderPage> {
    return isTauri ? native("get_historical_orders", { accountId, since, nextToken }) : { orders: demoOrders.filter((order) => order.status !== "Working") };
  },
  async confirmOrder(order: OrderDraft): Promise<OrderPreview> {
    if (isTauri) return native("confirm_order", { order });
    return { valid: true, summary: `${order.side} ${order.quantity} ${order.symbol} ${order.type}`, estimatedCommission: "$1.24", initialMargin: "$2,460.00", errors: [] };
  },
  async placeOrder(order: OrderDraft): Promise<OrderUpdate> {
    if (isTauri) return native("place_order", { order });
    throw new Error("Order placement is disabled in browser demo mode.");
  },
  async replaceOrder(accountId: string, orderId: string, newPrice: number): Promise<OrderUpdate> {
    if (isTauri) return native("replace_order", { accountId, orderId, newPrice });
    throw new Error("Order replacement is disabled in browser demo mode.");
  },
  async closePosition(accountId: string, positionId: string): Promise<ClosePositionResult> {
    if (isTauri) return native("close_position", { accountId, positionId });
    throw new Error("Position closing is disabled in browser demo mode.");
  },
  async cancelOrder(orderId: string): Promise<void> {
    if (isTauri) await native("cancel_order", { orderId });
  },
  async loadWorkspace(): Promise<WorkspaceState | null> {
    if (isTauri) return native("load_workspace");
    const raw = localStorage.getItem("northstar-workspace");
    return raw ? JSON.parse(raw) : null;
  },
  async saveWorkspace(workspace: WorkspaceState): Promise<void> {
    if (isTauri) await native("save_workspace", { workspace });
    else localStorage.setItem("northstar-workspace", JSON.stringify(workspace));
  },
};
