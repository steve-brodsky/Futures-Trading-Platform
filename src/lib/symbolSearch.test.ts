import { afterEach, describe, expect, it, vi } from "vitest";
import type { SymbolMeta } from "../types";
import {
  autocompleteKeyAction,
  createSymbolSuggestionController,
  type SymbolSuggestionState,
} from "./symbolSearch";

const symbol = (value: string): SymbolMeta => ({
  provider: "schwab",
  symbol: value,
  description: value,
  exchange: "NASDAQ",
  assetType: "EQUITY",
  minMove: 0.01,
  pointValue: 1,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("symbol suggestion controller", () => {
  it("trims queries and waits for the debounce before searching", async () => {
    vi.useFakeTimers();
    const search = vi.fn(async () => [symbol("AAPL")]);
    const states: SymbolSuggestionState[] = [];
    const controller = createSymbolSuggestionController(search, (state) => states.push(state));

    controller.update("  Apple  ");
    expect(states.at(-1)).toMatchObject({ query: "Apple", loading: true, results: [] });
    await vi.advanceTimersByTimeAsync(299);
    expect(search).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(search).toHaveBeenCalledWith("Apple");
    expect(states.at(-1)).toMatchObject({ query: "Apple", loading: false, results: [symbol("AAPL")] });
  });

  it("ignores stale responses after a newer query", async () => {
    vi.useFakeTimers();
    let resolveApple!: (items: SymbolMeta[]) => void;
    const apple = new Promise<SymbolMeta[]>((resolve) => { resolveApple = resolve; });
    const search = vi.fn((query: string) => query === "Apple" ? apple : Promise.resolve([symbol("MSFT")]));
    const states: SymbolSuggestionState[] = [];
    const controller = createSymbolSuggestionController(search, (state) => states.push(state), 10);

    controller.update("Apple");
    await vi.advanceTimersByTimeAsync(10);
    controller.update("Microsoft");
    await vi.advanceTimersByTimeAsync(10);
    resolveApple([symbol("AAPL")]);
    await Promise.resolve();

    expect(states.at(-1)?.results.map((item) => item.symbol)).toEqual(["MSFT"]);
    expect(states.some((state) => state.query === "Apple" && state.results[0]?.symbol === "AAPL")).toBe(false);
  });

  it("clears immediately for empty or disabled queries and publishes failures", async () => {
    vi.useFakeTimers();
    const states: SymbolSuggestionState[] = [];
    const controller = createSymbolSuggestionController(
      async () => { throw new Error("Both providers are offline"); },
      (state) => states.push(state),
      10,
    );

    controller.update("MES");
    await vi.advanceTimersByTimeAsync(10);
    expect(states.at(-1)).toMatchObject({ loading: false, results: [], error: "Error: Both providers are offline" });

    controller.update("   ");
    expect(states.at(-1)).toEqual({ query: "", loading: false, results: [] });
    controller.update("AAPL", false);
    expect(states.at(-1)).toEqual({ query: "", loading: false, results: [] });
  });
});

describe("autocomplete keyboard actions", () => {
  it("wraps arrow navigation and supports home and end", () => {
    expect(autocompleteKeyAction("ArrowDown", -1, 3).activeIndex).toBe(0);
    expect(autocompleteKeyAction("ArrowDown", 2, 3).activeIndex).toBe(0);
    expect(autocompleteKeyAction("ArrowUp", -1, 3).activeIndex).toBe(2);
    expect(autocompleteKeyAction("Home", 2, 3).activeIndex).toBe(0);
    expect(autocompleteKeyAction("End", 0, 3).activeIndex).toBe(2);
  });

  it("selects only a valid active option and exposes escape", () => {
    expect(autocompleteKeyAction("Enter", 1, 3).selectIndex).toBe(1);
    expect(autocompleteKeyAction("Enter", -1, 3).handled).toBe(false);
    expect(autocompleteKeyAction("Escape", 1, 3)).toMatchObject({ handled: true, escape: true });
  });
});
