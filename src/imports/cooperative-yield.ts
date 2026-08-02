/**
 * Periodic surrender of the event loop during long import loops.
 *
 * The daemon proves it is alive by renewing a lease from a `setTimeout` heartbeat every 10 s, and
 * `assertFreshDaemonAuthority` rejects every write once that lease passes its 30 s TTL. A
 * `setTimeout` callback is a macrotask, so it only runs when the loop reaches the timer phase.
 *
 * Import loops await the staging `InMemoryStore`, whose methods are `async` but resolve
 * immediately. An `await` on an already-resolved promise schedules a *microtask*, and the loop
 * drains the entire microtask queue before advancing a phase — so a record loop that only awaits
 * the staging store never lets the timer phase run at all.
 *
 * Measured consequence on the live corpus: a `memory daemon once` fired exactly one heartbeat
 * 11.6 s in, then starved the timer for the remaining ~31 s. The lease expired at +41.6 s, every
 * subsequent commit was rejected, and the import aborted two-thirds of the way through claude-code
 * having already committed 21,118 events — reporting exit 0 and a success-shaped receipt.
 *
 * Yielding is time-based rather than every-N-records because record cost varies by three orders of
 * magnitude between a skipped line and a tool-call body; a fixed count either yields far too often
 * on cheap records or far too rarely on expensive ones.
 */

/** Well inside the 10 s heartbeat interval, and far below the 30 s lease TTL. */
export const DEFAULT_YIELD_INTERVAL_MS = 50;

export interface EventLoopYielderOptions {
  intervalMs?: number;
  /** Injected for tests; production reads the host clock. */
  now?: () => number;
  /** Injected for tests. Production surrenders to the timer phase, which is the phase that matters. */
  yieldNow?: () => Promise<void>;
}

export type EventLoopYielder = () => Promise<void>;

export function createEventLoopYielder(options: EventLoopYielderOptions = {}): EventLoopYielder {
  const intervalMs = options.intervalMs ?? DEFAULT_YIELD_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());
  // `setTimeout`, NOT `setImmediate`: the starved callback is a timer, and only a timer-phase turn
  // is guaranteed to run it.
  const yieldNow = options.yieldNow ?? (() => new Promise<void>((resolve) => { setTimeout(resolve, 0); }));
  let lastYieldedAt = now();

  return async function maybeYield(): Promise<void> {
    const current = now();
    if (current - lastYieldedAt < intervalMs) return;
    lastYieldedAt = current;
    await yieldNow();
    // Re-read after the turn: the yield itself can take non-trivial time under load, and measuring
    // the next interval from before it would yield again almost immediately.
    lastYieldedAt = now();
  };
}
