import type { MemoryState } from "../domain/types.js";

/**
 * Single source of truth for which `MemoryState` values may be returned by retrieval
 * (`applyRetrievalBoundary`) and therefore reach an injection packet.
 *
 * Owner-locked partition (D-GAP-1, ADR 0049 / GAP-11-A):
 *   retrievable = active, compacted, revived
 *   excluded    = superseded, stale, proposed, approved, rejected, disputed
 *
 * This is an allow-list, not a blacklist — a state not explicitly listed here is excluded by
 * default, so a future addition to `MemoryStateSchema` fails closed instead of silently
 * becoming retrievable.
 */
export const RETRIEVABLE_MEMORY_STATES: readonly MemoryState[] = ["active", "compacted", "revived"];

/**
 * The one state that is not retrievable now but can be promoted to `"revived"` (and therefore
 * become retrievable on a later query) by deferred revival in `prepareInjection`.
 */
export const REVIVABLE_MEMORY_STATE: MemoryState = "stale";

/**
 * States a store-level query must load for retrieval to work correctly: the retrievable set
 * plus the one revivable state (so deferred revival has candidates to score). Consumed by
 * Plan 11-10's store-level query surface.
 */
export const RETRIEVAL_CANDIDATE_STATES: readonly MemoryState[] = [
  ...RETRIEVABLE_MEMORY_STATES,
  REVIVABLE_MEMORY_STATE
];

const RETRIEVABLE_STATE_SET: ReadonlySet<MemoryState> = new Set(RETRIEVABLE_MEMORY_STATES);

export function isRetrievableState(state: MemoryState): boolean {
  return RETRIEVABLE_STATE_SET.has(state);
}
