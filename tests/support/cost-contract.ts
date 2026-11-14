import type { MemoryStore } from "../../src/storage/memory-store.js";
import type { CountingStoreCounts } from "./counting-store.js";

/**
 * Materialization-cost contracts for deterministic store tests.
 *
 * Equality at corpora 10x apart catches growing reads; a ceiling passes for an
 * O(n) implementation at n=5. These helpers measure calls and returned rows,
 * not resident-vector arithmetic or elapsed time.
 */
export function assertFlatCost(params: {
  small: CountingStoreCounts;
  large: CountingStoreCounts;
  methods: readonly string[];
  label?: string;
}): void {
  for (const method of params.methods) {
    if (!Object.hasOwn(params.small.calls, method) || !Object.hasOwn(params.large.calls, method)) {
      throw new Error(`Unknown MemoryStore method: ${method}`);
    }
    const storeMethod = method as keyof MemoryStore;
    const smallCalls = params.small.calls[storeMethod];
    const largeCalls = params.large.calls[storeMethod];
    const smallRows = params.small.rows[method];
    const largeRows = params.large.rows[method];
    const prefix = params.label ? `${params.label}: ` : "";

    if (smallCalls !== largeCalls || smallRows !== largeRows) {
      throw new Error(
        `${prefix}${String(method)} cost differs: calls small=${smallCalls}, large=${largeCalls}; ` +
        `rows small=${smallRows}, large=${largeRows}`
      );
    }
  }
}

/** Corollary D-13-1a proof shape: warm-up occurs once, independent of cycle count. */
export function assertOncePerProcess(params: {
  counts: CountingStoreCounts;
  method: keyof MemoryStore;
  cycles: number;
}): void {
  if (!Number.isInteger(params.cycles) || params.cycles < 1) {
    throw new Error("cycles must be a positive integer");
  }
  const calls = params.counts.calls[params.method];
  if (calls !== 1) {
    throw new Error(`${String(params.method)} was called ${calls} times across ${params.cycles} cycles; expected once`);
  }
}
