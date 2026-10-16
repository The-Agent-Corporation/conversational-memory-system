import type { MemoryStore } from "../storage/memory-store.js";
import type { OpenRouterLedger } from "./types.js";

export function ledgerFor(store: MemoryStore): OpenRouterLedger {
  return {
    spentOnDay: (day) => store.modelSpendOnDay(day),
    recordUsage: (entry) => store.recordModelUsage(entry),
    getCachedOutput: (cacheKey) => store.getModelOutputCache(cacheKey),
    putCachedOutput: (entry) => store.putModelOutputCache(entry)
  };
}
