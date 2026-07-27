import { useEffect, useState } from "react";
import type { SymbolMeta } from "../types";

export interface SymbolSuggestionState {
  query: string;
  results: SymbolMeta[];
  loading: boolean;
  error?: string;
}

export interface SymbolSuggestionController {
  update(query: string, enabled?: boolean): void;
  dispose(): void;
}

const emptySuggestionState = (): SymbolSuggestionState => ({
  query: "",
  results: [],
  loading: false,
});

export function createSymbolSuggestionController(
  search: (query: string) => Promise<SymbolMeta[]>,
  publish: (state: SymbolSuggestionState) => void,
  debounceMs = 300,
): SymbolSuggestionController {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;

  const update = (query: string, enabled = true) => {
    const value = query.trim();
    generation += 1;
    const requestGeneration = generation;
    if (timer != null) clearTimeout(timer);
    timer = undefined;

    if (!enabled || !value) {
      publish(emptySuggestionState());
      return;
    }

    publish({ query: value, results: [], loading: true });
    timer = setTimeout(() => {
      timer = undefined;
      void search(value)
        .then((results) => {
          if (generation === requestGeneration) {
            publish({ query: value, results, loading: false });
          }
        })
        .catch((error) => {
          if (generation === requestGeneration) {
            publish({
              query: value,
              results: [],
              loading: false,
              error: String(error || "Symbol search is unavailable."),
            });
          }
        });
    }, debounceMs);
  };

  return {
    update,
    dispose() {
      generation += 1;
      if (timer != null) clearTimeout(timer);
      timer = undefined;
    },
  };
}

export function useSymbolSuggestions(
  query: string,
  search: (query: string) => Promise<SymbolMeta[]>,
  enabled = true,
  debounceMs = 300,
): SymbolSuggestionState {
  const [state, setState] = useState<SymbolSuggestionState>(emptySuggestionState);

  useEffect(() => {
    const controller = createSymbolSuggestionController(search, setState, debounceMs);
    controller.update(query, enabled);
    return () => controller.dispose();
  }, [query, search, enabled, debounceMs]);

  return state;
}

export interface AutocompleteKeyAction {
  handled: boolean;
  activeIndex: number;
  selectIndex?: number;
  escape?: boolean;
}

export function autocompleteKeyAction(
  key: string,
  activeIndex: number,
  itemCount: number,
): AutocompleteKeyAction {
  if (key === "Escape") {
    return { handled: true, activeIndex, escape: true };
  }
  if (key === "ArrowDown") {
    return {
      handled: true,
      activeIndex: itemCount ? (activeIndex + 1 + itemCount) % itemCount : -1,
    };
  }
  if (key === "ArrowUp") {
    return {
      handled: true,
      activeIndex: itemCount
        ? activeIndex < 0 ? itemCount - 1 : (activeIndex - 1 + itemCount) % itemCount
        : -1,
    };
  }
  if (key === "Home" && itemCount) {
    return { handled: true, activeIndex: 0 };
  }
  if (key === "End" && itemCount) {
    return { handled: true, activeIndex: itemCount - 1 };
  }
  if (key === "Enter" && activeIndex >= 0 && activeIndex < itemCount) {
    return { handled: true, activeIndex, selectIndex: activeIndex };
  }
  return { handled: false, activeIndex };
}
