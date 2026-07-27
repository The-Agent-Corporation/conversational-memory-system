---
phase: 11-derivation-input-hygiene
plan: 08
subsystem: retrieval
tags: [retrieval, memory-state, gap-closure, injection-boundary, adr]

# Dependency graph
requires:
  - phase: 11-derivation-input-hygiene
    provides: "the derivation-hygiene rebuild (Plan 07) that produced 87,727 superseded summaries on the live corpus, converting the dormant GAP-11-A defect into an active one"
provides:
  - "src/retrieval/retrievable-state.ts — the single source of truth for which MemoryState values are retrievable"
  - "isRetrievableState() enforced centrally inside applyRetrievalBoundary"
  - "deferred revival for stale summaries, so revival remains reachable without stale summaries themselves being retrievable"
  - "ADR 0049 recording the retrievable-state decision and its consequences"
affects: [11-09, 11-10, 11-11, 11-12, 11-13, "any future retrieval or store-level query change"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Allow-list state partition (isRetrievableState) enforced once inside a boundary function so all derived-object membership tests inherit it — no per-call-site filters"
    - "Deferred revival: promote-without-inject, effective on the next retrieval cycle rather than the triggering one"

key-files:
  created:
    - src/retrieval/retrievable-state.ts
    - tests/retrieval/retrievable-state.test.ts
    - docs/adr/0049-retrievable-memory-states.md
  modified:
    - src/retrieval/memory-retriever.ts
    - src/domain/types.ts
    - tests/retrieval/memory-retriever.test.ts

key-decisions:
  - "Retrievable states are active/compacted/revived; excluded are superseded/stale/proposed/approved/rejected/disputed (D-GAP-1, owner-locked)"
  - "State filtering lives inside applyRetrievalBoundary, not at any prepareInjection call site, so traces and boxes inherit exclusion through the existing summaryIds.every(...) membership test (D-GAP-2)"
  - "Revival is deferred: a stale summary scoring at or above the selected floor is promoted to revived via saveSummary but excluded from the packet that triggered the promotion, becoming retrievable only on the next query"

patterns-established:
  - "Central allow-list predicate module for cross-cutting authority filters (mirrors the personId/scopeId boundary already in applyRetrievalBoundary)"

requirements-completed: [REQ-053]

# Metrics
duration: 5min
completed: 2026-07-26
---

# Phase 11 Plan 08: Retrievable Memory States (GAP-11-A closure) Summary

**Closed GAP-11-A by adding a central `isRetrievableState` allow-list filter inside `applyRetrievalBoundary` and deferred revival for stale summaries, so a superseded summary's pre-hygiene text can no longer reach an injection packet.**

## Performance

- **Duration:** ~5 min (three atomic task commits between 21:28:14 and 21:30:55 local time)
- **Tasks:** 3
- **Files modified:** 6 (3 created, 3 modified)

## Accomplishments

- Added `src/retrieval/retrievable-state.ts` exporting `RETRIEVABLE_MEMORY_STATES` (`active`, `compacted`, `revived`), `REVIVABLE_MEMORY_STATE` (`stale`), `RETRIEVAL_CANDIDATE_STATES` (retrievable + revivable, for Plan 11-10's store-level query surface), and `isRetrievableState`.
- Rewired `applyRetrievalBoundary` (`src/retrieval/memory-retriever.ts`) to filter summaries on `isRetrievableState` inside the function — in both the scoped and legacy-unscoped branches — so `scopedTraces`/`scopedBoxes`'s existing `summaryIds.every(...)` membership tests inherit the exclusion without any new per-call-site filter.
- Implemented deferred revival in `prepareInjection`: after `selected` is computed for a packet, every `stale` summary in scope is scored with the same ranker; any scoring `> 0` and `>= Math.min(...selected scores)` is promoted to `revived` via `saveSummary` but never enters that packet — it becomes retrievable on the next `prepareInjection` call.
- Removed the now-unreachable `state: summary.state === "stale" ? "revived" : summary.state` promotion from `recordSelectedSummaryAccess` (a selected summary is retrievable by construction, so no promotion can occur there).
- Added ADR 0049 documenting the D-GAP-1/D-GAP-2 decision, the per-object-kind disposition (Summary, Box, MemoryTrace, Anchor), and the revival consequence with two rejected alternatives.

## Task Commits

1. **Task 1: RED regression tests reproducing GAP-11-A** - `3263603` (test)
2. **Task 2: Central state filter in applyRetrievalBoundary + deferred revival** - `9e2f20f` (feat)
3. **Task 3: ADR 0049 — retrievable memory states** - `bcd38b5` (docs)

_Note: Task 2's commit also fixed a blocking gap in `src/domain/types.ts` (see Deviations)._

## Files Created/Modified

- `src/retrieval/retrievable-state.ts` - Allow-list predicate module: `RETRIEVABLE_MEMORY_STATES`, `REVIVABLE_MEMORY_STATE`, `RETRIEVAL_CANDIDATE_STATES`, `isRetrievableState`.
- `src/retrieval/memory-retriever.ts` - `applyRetrievalBoundary` now returns `revivableSummaries` and filters `scopedSummaries`/legacy-unscoped summaries through `isRetrievableState`; `prepareInjection` gains `promoteRevivableSummaries`; `recordSelectedSummaryAccess` drops the stale-promotion ternary.
- `src/domain/types.ts` - Adds the missing `export type MemoryState = z.infer<typeof MemoryStateSchema>` (blocking fix — `retrievable-state.ts` needs the type; `MemoryStateSchema` existed but no corresponding type was exported).
- `tests/retrieval/retrievable-state.test.ts` - Exhaustive partition test over `MemoryStateSchema.options`.
- `tests/retrieval/memory-retriever.test.ts` - New `GAP-11-A` describe block (cases a–f); the stale/revived test pair rewritten for the deferred-revival contract.
- `docs/adr/0049-retrievable-memory-states.md` - The decision record.

## Decisions Made

- Retrievable = `active`, `compacted`, `revived`; excluded = `superseded`, `stale`, `proposed`, `approved`, `rejected`, `disputed` — an allow-list, not a blacklist, so a future `MemoryStateSchema` addition fails closed.
- State filtering is centralized inside `applyRetrievalBoundary`; the acceptance criteria explicitly forbade any per-call-site filter, verified by `grep -rn "isRetrievableState" src/` returning exactly the one enforcement site plus its own definition.
- Revival is deferred rather than immediate or dropped entirely — see ADR 0049's "Revival consequence" section for the two rejected alternatives (drop revival entirely; keep `stale` retrievable).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added the missing `MemoryState` type export**
- **Found during:** Task 2
- **Issue:** `src/domain/types.ts` defines `MemoryStateSchema` but never exported a corresponding `MemoryState` type (unlike `Summary`, `Box`, `Anchor`, etc., which all have `z.infer<typeof ...Schema>` type exports). `retrievable-state.ts` needs `MemoryState` to type its exports per the plan's interfaces section, which explicitly says to import it rather than restate the union.
- **Fix:** Added `export type MemoryState = z.infer<typeof MemoryStateSchema>;` alongside the other derived type exports.
- **Files modified:** `src/domain/types.ts`
- **Verification:** `npm run typecheck` clean; full test suite green.
- **Committed in:** `9e2f20f` (part of Task 2's commit)

---

**Total deviations:** 1 auto-fixed (Rule 3 — blocking).
**Impact on plan:** Necessary to satisfy the plan's own interface contract (import `MemoryState` from `../domain/types.js`, don't restate the union). No scope creep — `SqliteStore`/`InMemoryStore` were not touched since this is a pure type addition, not an interface change.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `isRetrievableState` and `RETRIEVAL_CANDIDATE_STATES` are ready for Plan 11-10's store-level query surface (loading only retrievable + revivable rows instead of every row from `listSummaries()`), which this plan's interfaces section flagged as the consumer.
- GAP-11-A is closed at the retrieval boundary; the live corpus's 87,727 superseded rows are still physically present in the database (out of scope for this ADR — pruning/archiving them is a separate future decision, noted explicitly in ADR 0049).
- `npx vitest run` (100 files, 874 tests, 4 skipped) and `npm run typecheck` are both green.
- No blockers for Plans 09-13.

---
*Phase: 11-derivation-input-hygiene*
*Completed: 2026-07-26*
