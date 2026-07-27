---
phase: 11-derivation-input-hygiene
plan: 10
subsystem: storage
tags: [sqlite, retrieval, performance, schema-migration, gap-closure]

# Dependency graph
requires:
  - phase: 11-derivation-input-hygiene
    provides: "isRetrievableState / RETRIEVAL_CANDIDATE_STATES, the single source of truth for which MemoryState values a store-level query should load (Plan 11-08)"
  - phase: 11-derivation-input-hygiene
    provides: "11-RETRIEVAL-SWEEP.md, the classified inventory of every candidate-selection call site (Plan 11-09)"
provides:
  - "SummaryFilter { personId?, scopeIds?, states? } — optional filter on MemoryStore.listSummaries, implemented identically in SqliteStore and InMemoryStore"
  - "Schema migration 3: idx_summaries_person_state, an expression index over (json_extract personId, json_extract state, id)"
  - "prepareInjection loads only person-owned candidate-state summaries via one filtered query, not the full corpus"
  - "A row-count and wall-clock acceptance test (tests/retrieval/memory-retriever-scale.test.ts) at 20,000 seeded summaries"
affects: ["11-11", "11-12", "11-13 (W4 before/after recall probes, now feasible in seconds instead of >10 minutes)", "11-14", "any future retrieval or store-level query change"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Optional store-level filter pushed down as a parameterized WHERE clause (json_extract + placeholders only, never concatenated filter values), mirroring the existing ProposalFilter/TraceFilter idiom already in memory-store.ts"
    - "scopeIds subset semantics applied in JS after SQL fetch, not in SQL, because SQLite cannot cheaply express 'every element of this JSON array is a member of that list' without a per-row correlated subquery"

key-files:
  created:
    - tests/storage/summary-filter.test.ts
    - tests/retrieval/memory-retriever-scale.test.ts
  modified:
    - src/storage/memory-store.ts
    - src/storage/sqlite-store.ts
    - src/storage/in-memory-store.ts
    - src/storage/schema-migrations.ts
    - src/retrieval/memory-retriever.ts
    - tests/storage/schema-migrations.test.ts

key-decisions:
  - "SummaryFilter is optional and additive — listSummaries() with no argument keeps returning every row unchanged, so the twenty derivation-internal callers identified in the Plan 11-09 sweep are unaffected"
  - "scopeIds subset semantics live in JS, not SQL — the personId/state filter is index-backed (EXPLAIN QUERY PLAN asserts idx_summaries_person_state), the scopeIds pass is a small in-memory filter over the already-narrowed row set"
  - "prepareInjection makes exactly one listSummaries call per request; RETRIEVAL_CANDIDATE_STATES (retrievable + revivable) covers both partitions applyRetrievalBoundary needs, so no second query for stale summaries"
  - "applyRetrievalBoundary is left untouched as the authority — the store filter is documented at the call site as an optimization only, never the sole enforcement point (T-11-30)"

patterns-established:
  - "Store-level candidate filters use the same optional-filter-object shape as ProposalFilter/TraceFilter (memory-store.ts), keeping the interface's filter conventions consistent"

requirements-completed: [REQ-053]

# Metrics
duration: ~5min
completed: 2026-07-26
---

# Phase 11 Plan 10: Filtered `listSummaries` Query Surface (GAP-11-A closure, continued) Summary

**`prepareInjection` now loads only person-owned, candidate-state summaries through a single index-backed `listSummaries({personId, scopeIds, states})` call instead of parsing every summary row in the database — closing the O(all-rows)-per-query hotspot that made eight probe queries take over ten minutes on the 135k-row live corpus.**

## Performance

- **Duration:** ~5 min (three atomic task commits between 21:53:04 and 21:55:29 local time)
- **Tasks:** 3
- **Files modified:** 8 (2 created, 6 modified)

## Accomplishments

- Added `SummaryFilter { personId?, scopeIds?, states? }` to `memory-store.ts` and widened `listSummaries(filter?)` in the interface — the no-argument call is byte-identical to today's contract, verified by a dedicated parity test case and the full unmodified regression suite.
- `SqliteStore.listSummaries` builds a parameterized query over `json_extract(payload,'$.personId')` and `json_extract(payload,'$.state') in (...)` (placeholders only, no filter value ever reaches SQL text) and applies `scopeIds` subset semantics in JS after parsing, with a comment explaining why that pass can't cheaply move into SQL.
- `InMemoryStore.listSummaries` implements the identical predicate over `this.summaries`, confirmed byte-identical to `SqliteStore` by a cross-store parity test over four representative filter shapes.
- Migration 3 (`idx_summaries_person_state`) appended to the append-only `MIGRATIONS` list; versions 1 and 2 are untouched (`git diff` on `schema-migrations.ts` shows only additions). An `EXPLAIN QUERY PLAN` test confirms the index is used for the `{personId, states}` shape.
- `prepareInjection` now issues exactly one `listSummaries` call, filtered by `{personId, scopeIds, states: RETRIEVAL_CANDIDATE_STATES}` when a person is present, or `{states: RETRIEVAL_CANDIDATE_STATES}` on the legacy-unscoped path (so the state filter still applies with no person filter — T-11-33). `applyRetrievalBoundary` is unchanged and remains the authority.
- The scale acceptance test seeds 20,000 summaries (19,700 superseded noise + 100 another-person + 180 active/20 stale for the test person) in a real `SqliteStore`, wraps it in a counting `Proxy`, and asserts the retriever loads <= 400 summaries per call and 8 sequential `prepareInjection` calls complete in well under the 20-second ceiling (observed ~2.1s for all 8 calls, effectively 200 rows loaded per call, not 20,000).

## Task Commits

1. **Task 1: RED store-filter parity tests and the scale acceptance test** - `37c0cce` (test)
2. **Task 2: Filtered listSummaries in the interface and both stores, plus migration 3** - `55dea43` (feat)
3. **Task 3: Retriever consumes the filtered query** - `48aac3f` (feat)

## Files Created/Modified

- `tests/storage/summary-filter.test.ts` (new) - Table-driven parity tests over `SqliteStore`/`InMemoryStore`: no-argument full-table contract (a), personId-only (b), states-only (c), all three combined with scopeIds subset semantics (d), `scopeIds: undefined` defaults to `["personal"]` (e), byte-identical cross-store results (f), and an `EXPLAIN QUERY PLAN` assertion for `idx_summaries_person_state`.
- `tests/retrieval/memory-retriever-scale.test.ts` (new) - Seeds 20,000 deterministic summaries in a temp-dir `SqliteStore`, wraps the store in a counting `Proxy` around `listSummaries`, and asserts the row-count bound, wall-clock ceiling, and packet exclusion of superseded ids.
- `src/storage/memory-store.ts` - Exports `SummaryFilter`; widens `listSummaries(filter?: SummaryFilter): Promise<Summary[]>`.
- `src/storage/sqlite-store.ts` - `listSummaries` gains the filtered branch: parameterized `json_extract` WHERE clause for `personId`/`states`, JS-side `scopeIds` subset filter, `order by id asc` preserved in both branches.
- `src/storage/in-memory-store.ts` - `listSummaries` gains the identical predicate over `this.summaries`, `structuredClone` and ascending-id order preserved.
- `src/storage/schema-migrations.ts` - Appends migration 3 (`idx_summaries_person_state`, index-only DDL, no data rewrite).
- `src/retrieval/memory-retriever.ts` - `prepareInjection` builds a `summaryFilter` object and makes one filtered `listSummaries` call; imports `RETRIEVAL_CANDIDATE_STATES`.
- `tests/storage/schema-migrations.test.ts` - New case asserting migration 3 applies (and `idx_summaries_person_state` exists) when upgrading from version 2; fixed the pre-existing idempotency test (see Deviations).

## Decisions Made

- `SummaryFilter` mirrors the existing `ProposalFilter`/`TraceFilter` optional-filter-object convention already in `memory-store.ts`, rather than introducing a new filter idiom.
- `scopeIds` subset semantics are applied in JS after the SQL fetch, matching `applyRetrievalBoundary`'s own semantics exactly (`(summary.scopeIds ?? ["personal"]).every(...)`), since SQLite has no cheap way to express that predicate against a JSON array column without a per-row correlated subquery that would undermine the index-backed personId/state filter.
- The legacy-unscoped path still passes `states: RETRIEVAL_CANDIDATE_STATES` with no `personId`, so it gets the state filter but not the person filter — preserving `applyRetrievalBoundary`'s existing legacy-unscoped behavior (T-11-33) rather than silently widening it.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed a pre-existing test that never created base tables before calling `runSchemaMigrations` directly**
- **Found during:** Task 2
- **Issue:** `tests/storage/schema-migrations.test.ts`'s "is idempotent when run again against an already-migrated database" test called `runSchemaMigrations(raw)` on a bare `DatabaseSync` that never went through `SqliteStore.migrate()`'s base DDL block, so the `summaries` table never existed. This worked before migration 3 existed because migration 2 (`summary_vectors`) creates its own table independent of any base table. Migration 3's `create index ... on summaries (...)` legitimately requires the `summaries` table to already exist — which it always does in production, since `SqliteStore.migrate()` always runs the base block before `runSchemaMigrations`. The test's bypass of that precondition was the bug, not the migration.
- **Fix:** The test now opens the database once through `new SqliteStore(databasePath)` (creating base tables + running migrations, matching real usage) before reopening it raw to exercise idempotency, with a comment explaining why.
- **Files modified:** `tests/storage/schema-migrations.test.ts`
- **Verification:** `npx vitest run tests/storage/` — 111/111 passing (was 110/111 before the fix); full suite green.
- **Committed in:** `55dea43` (part of Task 2's commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 — pre-existing test bug exposed by the new migration).
**Impact on plan:** Necessary to keep the full suite green while adding migration 3 exactly as specified (index-only DDL, no data rewrite, versions 1-2 unchanged). No scope creep — no new migration behavior was added beyond what the plan specified; only the test's unrealistic bypass of `SqliteStore.migrate()`'s base-table precondition was corrected.

## Issues Encountered

None beyond the test fix documented above.

## User Setup Required

None — no external service configuration required. Note for the user: migration 3 is index-only DDL and will run automatically the next time the live 4.6 GB database is opened by `SqliteStore`; no manual step is needed.

## Next Phase Readiness

- W4's before/after recall probes (Plan 11-13) are now feasible: `prepareInjection` loads candidates (bounded by person + state), not the full corpus, so eight probe queries that previously took over ten minutes on the 135k-row corpus now complete in low single-digit seconds at 20,000 seeded rows in this plan's test.
- `SummaryFilter` and `idx_summaries_person_state` are available for any future store-level query needing the same person/state narrowing.
- `npx vitest run` (104 files, 901 tests, 4 skipped) and `npm run typecheck` are both green.
- No blockers for Plans 11-14.

## Self-Check: PASSED

All 9 claimed files found on disk; all 4 claimed commit hashes (`37c0cce`, `55dea43`, `48aac3f`, `ce77cf5`) found in git log.

---
*Phase: 11-derivation-input-hygiene*
*Completed: 2026-07-26*
