---
phase: 06-zero-knowledge-multi-device-sync
plan: 11
subsystem: sync
tags: [zod, sqlite, node:sqlite, node:http, adr-0047, denial-of-service, bounded-resource]

# Dependency graph
requires:
  - phase: 06-zero-knowledge-multi-device-sync
    provides: commitRemoteSyncApply forward-gap path (in-memory + SQLite adapters), relay HTTP rate-limit map
provides:
  - Bounded client-side forward-gap allocation at MAX_RETAINED_GAP_SLOTS (1,024) in both storage adapters
  - Bounded relay HTTP rate-limit window map via on-access eviction of expired windows
affects: [06-zero-knowledge-multi-device-sync, relay-hardening, storage-adapters]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Reuse MAX_RETAINED_GAP_SLOTS from src/relay/domain/types.ts as the single source of truth for the gap-allocation bound, imported into both storage adapters (storage never re-derives the constant)."
    - "Sweep-on-access eviction for bounded in-memory rate-limit/window maps, avoiding a separate timer/interval."

key-files:
  created:
    - tests/sync/gap-allocation.test.ts
  modified:
    - src/storage/in-memory-store.ts
    - src/storage/sqlite-store.ts
    - src/relay/http/relay-http-server.ts
    - tests/sync/http-sync-relay.test.ts

key-decisions:
  - "Bounded forward-gap check classifies a jump beyond MAX_RETAINED_GAP_SLOTS as GAP_PENDING (the existing SyncCommitStatus enum has no separate limit variant) and returns before the per-slot allocation loop, rather than adding a new status value not requested by the plan."
  - "Added a diagnostic-only rateLimitWindowCount() accessor to RelayHttpServer so tests can observe map-size eviction without leaking token/bearer content; it triggers the same sweep used on the request path."
  - "Rate-limit eviction sweeps the entire map on every access (not just the current token's entry) so a rotating set of distinct token digests cannot accumulate stale windows between accesses."

patterns-established:
  - "Storage adapters may import shared bounds from src/relay/domain/types.ts (one-directional: relay/domain/types.ts imports nothing from storage, preserving the relay's zero-knowledge boundary)."

requirements-completed: [REQ-034, REQ-036]

# Metrics
duration: ~20min
completed: 2026-07-20
---

# Phase 06 Plan 11: Bounded-Resource Hardening (WR-02, WR-08) Summary

**Capped client remote-apply forward-gap allocation at MAX_RETAINED_GAP_SLOTS (1,024) in both storage adapters and added on-access eviction of stale relay HTTP rate-limit windows, closing 06-REVIEW.md warnings WR-02 and WR-08.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-07-20 (session start, worktree setup)
- **Completed:** 2026-07-20T17:03:46Z
- **Tasks:** 2/2 completed
- **Files modified:** 5 (2 created test files counted separately below; 3 source files modified)

## Accomplishments
- A single validly-signed high-sequence remote envelope can no longer drive proportional client allocation: both `InMemoryStore.commitRemoteSyncApply` and `SqliteStore.commitRemoteSyncApply` now reject/limit-classify (`GAP_PENDING`, zero rows allocated) any forward jump beyond `frontier + MAX_RETAINED_GAP_SLOTS`, before entering the per-slot `PendingSyncGap` allocation loop. Within the bound, behavior is unchanged and adapter parity is preserved.
- The relay HTTP rate-limit window map (`rateWindows`) now evicts every window whose `windowStartMs` has aged out of the 60s rolling window on every access, so a rotating set of bearer-token digests cannot permanently accumulate map entries.

## Task Commits

Each task was committed atomically:

1. **Task 1: Cap client remote-apply forward-gap allocation at MAX_RETAINED_GAP_SLOTS (both adapters)** - `c55b02f` (feat)
2. **Task 2: Evict stale relay HTTP rate-limit windows** - `39368a0` (feat)

**Plan metadata:** (this commit, docs: complete plan)

## Files Created/Modified
- `src/storage/in-memory-store.ts` - Imports `MAX_RETAINED_GAP_SLOTS`; `commitRemoteSyncApply` returns `GAP_PENDING` without allocating gap rows when `sequence > frontier + MAX_RETAINED_GAP_SLOTS`.
- `src/storage/sqlite-store.ts` - Identical bound applied to the SQLite adapter's forward-gap loop (commits the transaction and returns before the per-slot insert loop).
- `src/relay/http/relay-http-server.ts` - `withinRateLimit` now calls `evictExpiredRateWindows(nowMs)` on every access; added diagnostic `rateLimitWindowCount()` to the `RelayHttpServer` interface/return value.
- `tests/sync/gap-allocation.test.ts` (new) - Proves both adapters allocate proportional gap rows within the bound and zero rows for jumps beyond `MAX_RETAINED_GAP_SLOTS`.
- `tests/sync/http-sync-relay.test.ts` - New test drives 8 distinct rotated account tokens through the real HTTP boundary, asserts the window map grows to 8, advances the mocked clock past the 60s window, and asserts a single subsequent access sweeps the map back down to 1 (only the fresh window remains).

## Decisions Made
- Reused `MAX_RETAINED_GAP_SLOTS` from `src/relay/domain/types.ts` in both storage adapters rather than defining a duplicate local constant, keeping the ADR-mandated bound as a single source of truth. This import is one-directional (storage → relay/domain/types.ts, which itself imports nothing from storage/domain), so it does not violate the relay's zero-knowledge boundary invariant.
- Classified the bounded case as `GAP_PENDING` (existing `SyncCommitStatus` enum value) rather than introducing a new status, since the plan's `must_haves` only required "reject/limit-classified... without materializing proportional rows," not a new wire-visible status.
- Added `rateLimitWindowCount()` as a diagnostic-only method on `RelayHttpServer` to make the eviction bound observable in tests without exposing token digests or other content.

## Deviations from Plan

None - plan executed exactly as written. Both tasks matched their `<action>` and `<acceptance_criteria>` directly; no architectural changes, no missing test infrastructure, no blocking issues.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- WR-02 and WR-08 from `06-REVIEW.md` are closed; ADR 0047's bounded-resource posture is now enforced end-to-end from the client apply path through the relay HTTP boundary.
- `npx tsc --noEmit` passes; `tests/sync/gap-allocation.test.ts`, `tests/sync/http-sync-relay.test.ts`, `tests/sync/replay-equivocation.test.ts`, `tests/storage/sqlite-store.test.ts`, and the full `tests/sync` + `tests/relay` suites (219 tests) all pass.
- No blockers for the remaining Wave 1 gap-closure plans (06-10 replay/equivocation work in the same wave touches disjoint files and was not modified by this plan).

---
*Phase: 06-zero-knowledge-multi-device-sync*
*Completed: 2026-07-20*

## Self-Check: PASSED
