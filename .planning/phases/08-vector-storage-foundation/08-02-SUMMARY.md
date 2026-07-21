---
phase: 08-vector-storage-foundation
plan: 02
subsystem: database
tags: [sqlite, vector-storage, float32-blob, cosine-similarity, schema-migrations]

requires:
  - phase: 08-01
    provides: "MemoryStore vector method contracts, Float32 BLOB codec, backend-parameterized RED test suite"
provides:
  - "summary_vectors table as schema-migrations version 2 (additive, existing tables untouched)"
  - "SqliteStore implementations of saveSummaryVector/getSummaryVector/listSummaryIdsMissingVector/findNearestSummaries/deleteSummaryVectors"
affects: [08-04 (cross-store parity test + full-suite regression gate)]

tech-stack:
  added: []
  patterns:
    - "Typed-column SQLite table + composite primary key for multi-version vector rows, following the daemon_contraction_job precedent"
    - "Filter-before-score: SQL WHERE narrows candidates by provider/model/person before any JS-side cosineSimilarity call"

key-files:
  created: []
  modified:
    - src/storage/schema-migrations.ts
    - src/storage/sqlite-store.ts

key-decisions:
  - "listSummaryIdsMissingVector implemented exactly per plan spec: LEFT ANTI JOIN against the real summaries table with explicit ORDER BY id asc for stable resume order (D-05, Pitfall 2)."
  - "findNearestSummaries filters provider+model+person_id in SQL, then applies the scope .every() rule in JS before computing cosineSimilarity, so no unauthorized row is ever scored (D-06, Pitfall 1)."

patterns-established:
  - "Reuse cosineSimilarity from embedder.ts and the literal `right.score - left.score || left.summaryId.localeCompare(right.summaryId)` comparator verbatim rather than reimplementing (D-07)."

requirements-completed: [REQ-041]

duration: ~35min
completed: 2026-07-21
---

# Phase 8 Plan 02: Vector Storage Foundation — SqliteStore Summary

**SqliteStore now persists summary vectors as packed little-endian Float32 BLOBs in a version-2 `summary_vectors` table, with filter-before-score nearest-neighbor search and a stable-order missing-vector backfill query.**

## Performance

- **Duration:** ~35 min
- **Tasks:** 2 completed
- **Files modified:** 2

## Accomplishments
- `summary_vectors` ships as schema-migrations version 2: additive `create table if not exists`, composite `primary key (summary_id, provider, model)`, supporting index on `(provider, model, person_id, summary_id)`. Version 1 and the frozen `SqliteStore.migrate()` base block are byte-for-byte unchanged (SC5, D-01/D-04/D-08).
- All five `MemoryStore` vector methods implemented on `SqliteStore` with direct typed-column SQL (no `getPayload`/`upsertPayload`/`listPayloads`/`deleteIds` routing, per Pitfall 4).
- `findNearestSummaries` filters `provider`, `model`, and `person_id` in the SQL `WHERE` clause, then applies the scope `.every()` rule in JS, before any `cosineSimilarity` call — verified via a dedicated cross-scope fixture test that an out-scoring unauthorized row never leaks (D-06/Pitfall 1).
- `listSummaryIdsMissingVector` uses an explicit `NOT EXISTS` anti-join against `summaries` with `order by id asc`, matching D-05's stable-order backfill-resume-key requirement.
- `deleteSummaryVectors` tombstones every `(provider, model)` row for each given summary id.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add summary_vectors as schema-migrations version 2** - `58fd7aa` (feat)
2. **Task 2: Implement the five vector methods in SqliteStore** - `0db1dc9` (feat)

## Files Created/Modified
- `src/storage/schema-migrations.ts` - Appended version-2 migration entry: `summary_vectors` DDL + supporting index.
- `src/storage/sqlite-store.ts` - Added `SummaryVectorTableRow` local row type and implementations of the five vector methods; imported `cosineSimilarity` from `embeddings/embedder.ts` and `packFloat32Vector`/`unpackFloat32Vector` from `embeddings/vector-codec.ts`.

## Decisions Made
- Implemented `listSummaryIdsMissingVector` and the round-trip codec path exactly per the plan's literal SQL/BLOB spec rather than deviating to work around the two pre-existing test-fixture issues described below — deviating from the specified architecture (e.g. skipping the Float32 codec, or having `saveSummaryVector` silently write into `summaries`) would have been a Rule 4 architectural change and would have contradicted D-01/D-03/D-08. Verified correctness of both code paths empirically with a standalone sanity test (float32-safe vector + seeded `summaries` rows) before removing it — see Issues Encountered.

## Deviations from Plan

None — plan executed exactly as written. No auto-fixes were applied to `schema-migrations.ts` or `sqlite-store.ts`; both files match the plan's specified SQL/blob semantics precisely.

## Issues Encountered

Two pre-existing tests in `tests/storage/summary-vectors.test.ts` (authored in 08-01, outside this plan's `files_modified` and explicitly off-limits per the parallel-execution worktree instructions) fail against the SqliteStore backend for reasons unrelated to this plan's implementation:

1. **Round-trip byte-identical fidelity (SC1) test uses `vector: [0.5, -0.25, 0.75, 0.1]`.** `0.1` is not exactly representable in IEEE-754 Float32 (it round-trips to `0.10000000149011612` after `packFloat32Vector`/`unpackFloat32Vector`, per the codec's own precision contract established and unit-tested in 08-01 with the different, exactly-representable fixture `[0.5, -0.25, 1.75, 0, -3.125, 2.0]`). This is inherent to the Float32-BLOB architecture mandated by D-01/D-03/D-04, and only fails for the SqliteStore backend (InMemoryStore holds `number[]` directly per D-02, so it round-trips this exact fixture losslessly, which is an intentional backend asymmetry the fixture didn't account for).
2. **The missing-vector-list test (SC2, D-05) never calls `saveSummary`** for any of `summary_a`..`summary_d`, yet asserts `listSummaryIdsMissingVector` returns `["summary_b", "summary_d"]` (and all four for the untouched provider/model pair). Per the plan's literal spec (and the only sensible reading of D-05 as "the Phase 10 backfill resume key" over the real `summaries` corpus), the implementation queries `summaries LEFT ANTI JOIN summary_vectors`. With zero seeded `summaries` rows, this correctly and necessarily returns `[]` for every provider/model pair — there is no code path by which a `MemoryStore` implementation could produce `["summary_b","summary_d"]` from data the store was never given.

I verified both underlying implementations are correct by writing (and then deleting) a standalone sanity test that (a) round-trips a Float32-representable vector — passes byte-identical — and (b) seeds the four `summaries` rows before saving two vectors — `listSummaryIdsMissingVector` then returns exactly `["summary_b", "summary_d"]` as the suite expects. This confirms the two suite failures are pre-existing test-fixture defects from 08-01, not defects in this plan's `schema-migrations.ts`/`sqlite-store.ts` work. Per the parallel-execution constraint ("Only modify the files your plan declares... plus your SUMMARY.md"), I did not modify `tests/storage/summary-vectors.test.ts` to fix these. Flagging for whoever executes 08-04 (which already lists this test file in its `files_modified` and runs a full-suite regression gate) to seed `summaries` rows in the missing-list test and swap `0.1` for a Float32-exact value (e.g. `0.125`) in the shared `vectorRecord()` fixture.

All other SqliteStore describe-block tests pass: "returns null for a summary vector that was never saved", the scope-isolation cross-person/cross-scope `findNearestSummaries` test (SC4/D-06/Pitfall 1), and the tombstone test (SC4/D-09). `npx tsc --noEmit` reports zero errors attributable to `sqlite-store.ts` (all 212 remaining project-wide errors trace to `in-memory-store.ts` not yet implementing the interface — the sibling 08-03 plan's scope, matching the expected Wave 2 cascading-error pattern documented in 08-01-SUMMARY.md). `tests/storage/schema-migrations.test.ts` (4/4) and the existing `tests/storage/sqlite-store.test.ts` (10/10) both remain green — no regression to the frozen version-1 base block or any pre-existing SqliteStore behavior.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `summary_vectors` schema and SqliteStore's half of the vector surface are ready for 08-03 (InMemoryStore) and 08-04 (cross-store parity test + full-suite regression gate + finalized 08-VALIDATION.md).
- 08-04 should additionally patch the two pre-existing `tests/storage/summary-vectors.test.ts` fixture defects documented above (float32-inexact default vector, unseeded `summaries` in the missing-list test) before finalizing `nyquist_compliant`/`wave_0_complete`.

---
*Phase: 08-vector-storage-foundation*
*Completed: 2026-07-21*

## Self-Check

```
FOUND: src/storage/schema-migrations.ts
FOUND: src/storage/sqlite-store.ts
FOUND: .planning/phases/08-vector-storage-foundation/08-02-SUMMARY.md
FOUND: 58fd7aa (feat(08-02): add summary_vectors as schema-migrations version 2)
FOUND: 0db1dc9 (feat(08-02): implement SqliteStore vector surface (D-02/D-03/D-05/D-06/D-07/D-09))
FOUND: 077a7a1 (docs(08-02): add plan summary for SqliteStore vector surface)
```

## Self-Check: PASSED
