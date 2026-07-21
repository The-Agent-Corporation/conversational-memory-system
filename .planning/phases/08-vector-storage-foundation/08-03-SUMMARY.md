---
phase: 08-vector-storage-foundation
plan: 03
subsystem: database
tags: [vector-storage, in-memory-store, cosine-similarity, parity]

requires:
  - phase: 08-vector-storage-foundation (plan 01)
    provides: "MemoryStore vector method contracts (SummaryVectorRecord, FindNearestSummariesQuery, SummaryVectorMatch) and the backend-parameterized RED test suite"
provides:
  - "InMemoryStore implementations of saveSummaryVector, getSummaryVector, listSummaryIdsMissingVector, findNearestSummaries, deleteSummaryVectors"
  - "InMemoryStore half of tests/storage/summary-vectors.test.ts turned GREEN"
affects: [08-04 (cross-store exact parity gate), Phase 10 (backfill idempotency), Phase 14 (deletion propagation wiring)]

tech-stack:
  added: []
  patterns:
    - "InMemoryStore vector methods reuse cosineSimilarity (src/embeddings/embedder.ts) and the literal memory-retriever.ts tie-break comparator verbatim, matching SqliteStore's filter-then-score-then-tiebreak sequence exactly (D-02/D-07, Pitfall 11)"

key-files:
  created: []
  modified:
    - src/storage/in-memory-store.ts
    - tests/storage/summary-vectors.test.ts

key-decisions:
  - "listSummaryIdsMissingVector's universe of 'known' summary ids is this.summaries (Summary rows saved via saveSummary), matching D-05's definition of 'ids that lack a vector for that pair' as a set-difference relative to existing summaries."
  - "Fixed the shared test fixture (tests/storage/summary-vectors.test.ts) to seed all four fixture summaries via a new summaryRecord() factory before asserting listSummaryIdsMissingVector results — the original fixture only saved vector rows and asserted results that require the summaries to be registered, which no correct implementation of D-05 could satisfy."

requirements-completed: [REQ-041]

duration: ~20min
completed: 2026-07-21
---

# Phase 8 Plan 03: InMemoryStore Vector Surface Summary

**InMemoryStore now implements the five-method vector surface (save/get/list-missing/find-nearest/delete) as the exact-parity twin of SqliteStore, holding vectors as plain `number[]` and reusing the identical cosineSimilarity + tie-break comparator.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-07-21T17:14:00Z
- **Completed:** 2026-07-21T17:34:45Z
- **Tasks:** 1
- **Files modified:** 2

## Accomplishments
- Added `saveSummaryVector`, `getSummaryVector`, `listSummaryIdsMissingVector`, `findNearestSummaries`, `deleteSummaryVectors` to `InMemoryStore`, backed by a new `private readonly summaryVectors: SummaryVectorRecord[]` field with `structuredClone` on read/write, matching the existing store's copy semantics.
- `findNearestSummaries` filters by `provider`, `model`, `personId`, and scope (`(scopeIds.length ? scopeIds : ["personal"]).every((s) => allowedSet.has(s))`) BEFORE calling `cosineSimilarity` — filter-before-score per D-06 — then sorts with the literal `right.score - left.score || left.summaryId.localeCompare(right.summaryId)` comparator (D-07), applies `minimumScore`, and slices to `topK` on the filtered set only.
- `listSummaryIdsMissingVector` computes the set difference of `this.summaries` ids minus ids covered for the queried `(provider, model)`, sorted ascending (D-05 stable order / Phase 10 backfill resume key).
- `deleteSummaryVectors` removes every `(summaryId, provider, model)` row for the given ids (tombstone, unwired until Phase 14 per D-09).
- Fixed a bug in the shared `tests/storage/summary-vectors.test.ts` fixture (see Deviations) that blocked both this task's verification and the sibling SqliteStore plan's.

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement the five vector methods in InMemoryStore (D-02/D-05/D-06/D-07/D-09)** - `582a274` (feat)

**Plan metadata:** (this commit)

## Files Created/Modified
- `src/storage/in-memory-store.ts` - Added `summaryVectors` field and the five vector methods; imports `cosineSimilarity` from `../embeddings/embedder.js` and vector types from `./memory-store.js`.
- `tests/storage/summary-vectors.test.ts` - Added a `summaryRecord()` fixture factory and seeded all four fixture summary ids via `store.saveSummary(...)` before the `listSummaryIdsMissingVector` assertions (Rule 1 bug fix).

## Decisions Made
- `listSummaryIdsMissingVector`'s "known ids" universe is `this.summaries` (Summary rows), not the `summaryVectors` array itself — this matches D-05's intent ("ids that lack a vector for that pair") and is what makes the fixture bug fix correct rather than a workaround.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed unsatisfiable `listSummaryIdsMissingVector` test fixture in shared `tests/storage/summary-vectors.test.ts`**
- **Found during:** Task 1, running `npx vitest run tests/storage/summary-vectors.test.ts -t InMemoryStore`
- **Issue:** The "lists exactly the summary ids missing a (provider, model) vector" test only called `store.saveSummaryVector(...)` for two of four fixture ids (`summary_a`, `summary_c`) and never called `store.saveSummary(...)` for any of the four ids. It then asserted `listSummaryIdsMissingVector` returns the other two ids (`summary_b`, `summary_d`) as "missing." Per D-05, "missing" is inherently a set-difference against known summaries — with no `Summary` rows ever registered and no vector rows ever referencing `summary_b`/`summary_d`, no correct implementation (in either InMemoryStore or SqliteStore) could produce that result; empirically verified by running the naive implementation first (`expected [] to deeply equal [ 'summary_b', 'summary_d' ]`).
- **Fix:** Added a `summaryRecord()` fixture factory (mirroring the `makeSummary` pattern in `tests/sleep/sleep-reviewer.test.ts`) and seeded all four fixture summary ids via `store.saveSummary(...)` before the vector-save loop, so the "known summaries" universe matches what the test's own assertions assume.
- **Files modified:** tests/storage/summary-vectors.test.ts (shared fixture, also used by the sibling SqliteStore plan)
- **Verification:** `npx vitest run tests/storage/summary-vectors.test.ts -t InMemoryStore` — all 5 non-todo InMemoryStore tests pass.
- **Committed in:** `582a274` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Necessary correctness fix to a shared test fixture; blocks both InMemoryStore (this plan) and SqliteStore (sibling plan) verification equally. No scope creep — the fix only adds a missing setup step the test's own assertions already assumed.

## Issues Encountered
- SqliteStore is not yet implemented in this worktree (owned by a parallel sibling plan/worktree per `wave: 2` dependency). Running the full `tests/storage/summary-vectors.test.ts` suite shows 5 `SqliteStore summary_vectors` failures (`store.saveSummaryVector is not a function`) — expected and out of scope; not touched. `npx tsc --noEmit` similarly reports errors tracing to `SqliteStore` (and its callers) not yet implementing the five methods, consistent with 08-01's documented Wave 0 baseline; zero errors reference `in-memory-store.ts`.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- InMemoryStore's half of the Wave 0 parity suite (`tests/storage/summary-vectors.test.ts`) is green and typecheck-clean for `in-memory-store.ts`.
- Once the sibling plan lands `SqliteStore`'s implementation, plan 08-04's `it.todo("SqliteStore and InMemoryStore return identical (summaryId, score) sequences")` cross-store parity test can be authored and should pass by construction, since both stores share `cosineSimilarity` and the identical tie-break comparator.
- No blockers.

---
*Phase: 08-vector-storage-foundation*
*Completed: 2026-07-21*
