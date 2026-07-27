---
phase: 11-derivation-input-hygiene
plan: 09
subsystem: retrieval
tags: [retrieval, memory-state, gap-closure, vector-search, mcp, subject-expansion]

# Dependency graph
requires:
  - phase: 11-derivation-input-hygiene
    provides: "src/retrieval/retrievable-state.ts and the isRetrievableState predicate, centralized in applyRetrievalBoundary (Plan 11-08)"
provides:
  - "isRetrievableState enforced in MemoryQueryService.loadAuthorizedMemory (MCP search/recall/review/status surface)"
  - "isRetrievableState enforced in SubjectExpansionService.resolveSummary (direct match and recursive sourceSummaryIds walk)"
  - "SqliteStore/InMemoryStore.findNearestSummaries drop candidates whose summary row is absent (orphan) or non-retrievable, in one per-call query, no per-row lookup"
  - "11-RETRIEVAL-SWEEP.md — the classified inventory of every candidate-selection site in src/"
affects: ["Phase 12/13/14 (vector trace discovery, semantic recall) — findNearestSummaries now fails closed on non-retrievable summaries", "any future retrieval or store-level query change"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Store-level fail-closed second line: findNearestSummaries loads a retrievable-id set once per call (not once per candidate row) rather than joining summary_vectors to summaries in SQL, to avoid an O(n) regression while still closing the gap between tombstoning (primary mechanism) and query-time enforcement (fail-closed backstop)"

key-files:
  created:
    - tests/retrieval/memory-query-service.test.ts
    - tests/retrieval/subject-expansion-service.test.ts
    - .planning/phases/11-derivation-input-hygiene/11-RETRIEVAL-SWEEP.md
  modified:
    - src/retrieval/memory-query-service.ts
    - src/retrieval/subject-expansion-service.ts
    - src/storage/sqlite-store.ts
    - src/storage/in-memory-store.ts
    - tests/storage/summary-vectors.test.ts

key-decisions:
  - "The single retrievable-state predicate module from Plan 11-08 (src/retrieval/retrievable-state.ts) is reused everywhere — no second predicate was introduced (grep -c isRetrievableState returns a non-zero count in all four modified source files, matching the module's one definition)"
  - "findNearestSummaries loads the retrievable summary-id set once per call, restricted to json_extract(payload,'$.personId') = ?, not once per candidate row — verified by the acceptance criterion that greps for a per-row summary lookup pattern and finds none"
  - "No summary_vectors schema change and no migration in this plan — tombstoning at supersession time (deleteSummaryVectors, Plan 11-05) remains the primary mechanism; the store-level filter is a fail-closed second line only"
  - "src/resume/conversation-resumer.ts was read and deliberately left unchanged: it expands a caller-supplied id into raw canonical Turn[] (no MemoryState field), content already reachable via direct canonical-event queries per D-4 regardless of derivation state — gating it would not reduce disclosure, only pointer usability. Its separate lack of any person/scope authorization is flagged as a residual risk, out of this plan's file scope"
  - "Proposal/review-facing candidate pools (sleep-reviewer.ts, proposal-scheduler.ts) keep their existing state !== \"superseded\" blacklist rather than being switched to the isRetrievableState allow-list — stale summaries must remain eligible proposal material, and changing that is a proposal/review-contract change explicitly out of this phase's scope fence"

requirements-completed: [REQ-053]

# Metrics
duration: ~25min
completed: 2026-07-27
---

# Phase 11 Plan 09: Retrieval Sweep (GAP-11-A closure, continued) Summary

**Closed the remaining three GAP-11-A siblings — MCP read/search, subject expansion, and vector nearest-neighbor search — all reusing Plan 11-08's single `isRetrievableState` predicate, and wrote down the full classification of every other candidate-selection site in `src/` as either newly-fixed, already-correct, or deliberately unchanged with a stated reason.**

## Performance

- **Duration:** ~25 min (three atomic task commits)
- **Tasks:** 3
- **Files modified:** 8 (3 created, 5 modified)

## Accomplishments

- Added `isRetrievableState(summary.state)` to `MemoryQueryService.loadAuthorizedMemory`'s `ownedSummaries` filter, before the scope filter, so `summaryIds` — and therefore the boxes/traces built from it — inherit the exclusion exactly as `applyRetrievalBoundary` does. `DEFAULT_REVIEW_STATES` and the proposal/review filters were left untouched (they govern the review flow, not retrieval).
- Added `!isRetrievableState(summary.state)` to `SubjectExpansionService.resolveSummary`'s existing fail-closed condition, gating both the direct subject match and every recursive `sourceSummaryIds` dependency in one place.
- `SqliteStore.findNearestSummaries` and `InMemoryStore.findNearestSummaries` now drop a candidate whose summary row is absent (orphan) or non-retrievable. `SqliteStore` loads the retrievable id set once per call via a single query over `summaries` restricted to the caller's `personId`, never a per-candidate-row lookup (verified by grep in the acceptance criteria). No `summary_vectors` schema change and no migration — tombstoning at supersession time remains the primary mechanism; this is the fail-closed second line, mirroring the plan's explicit instruction.
- Read `src/resume/conversation-resumer.ts` and `src/integrations/hermes/ingest-command.ts` and classified both: `ingest-command.ts`'s two `listSummaries` calls compute the already-compacted-turns boundary and must see every summary regardless of state (derivation-internal); `conversation-resumer.ts`'s `resumeSummary`/`resumeTrace`/`resumeBox` were decided NOT retrieval-serving in the state-sensitive sense (they expand to raw `Turn[]`, which has no state field), and left unchanged — with their separate, pre-existing lack of person/scope authorization flagged as a residual risk out of this plan's scope.
- Wrote `11-RETRIEVAL-SWEEP.md`: regenerated the `listSummaries`/`listAnchors`/`listBoxes`/`listTraces`/`findNearestSummaries` grep against the current tree (not copied from the plan), reconciled it against the plan's pre-execution interfaces-block inventory (three line-number shifts, three call sites not in the original inventory: `box-assigner.ts`, `proposal-scheduler.ts`, `sqlite-store.ts:518`), and classified all 38 rows.

## Task Commits

1. **Task 1: RED sweep tests for the MCP read, subject-expansion, and vector paths** - `4d0c09c` (test)
2. **Task 2: Apply the predicate to the MCP read, subject-expansion, and vector paths** - `4b4d813` (feat)
3. **Task 3: Write the retrieval sweep record** - `a092b12` (docs)

## Files Created/Modified

- `src/retrieval/memory-query-service.ts` - `loadAuthorizedMemory` gains `isRetrievableState(summary.state)` in the `ownedSummaries` filter.
- `src/retrieval/subject-expansion-service.ts` - `resolveSummary`'s fail-closed condition gains `!isRetrievableState(summary.state)`, gating both direct match and recursive dependency walk.
- `src/storage/sqlite-store.ts` - `findNearestSummaries` loads a retrievable-id set once per call (single query over `summaries` filtered by `personId`) and skips candidates whose summary is absent or non-retrievable. Imports `isRetrievableState` and the `MemoryState` type.
- `src/storage/in-memory-store.ts` - `findNearestSummaries` gains the identical filter, computed from `this.summaries` once per call.
- `tests/retrieval/memory-query-service.test.ts` (new) - Four cases: search excludes a superseded summary sharing query vocabulary; `status().memoryCount` excludes it; a box/trace whose `summaryIds` are all superseded is absent from `review`.
- `tests/retrieval/subject-expansion-service.test.ts` (new) - Two cases: a subject whose only matching summary is superseded resolves to no subject; an active summary whose `sourceSummaryIds` chain reaches a superseded dependency fails to expand (exercises the recursive walk, not just the top-level match).
- `tests/storage/summary-vectors.test.ts` - Two new cases (superseded-nearest, orphan-vector) plus fixture updates to the pre-existing SC4/cross-store-parity/WR-04 tests, which now need matching `saveSummary` rows since `findNearestSummaries` no longer treats a vector-only row as retrievable by default.
- `.planning/phases/11-derivation-input-hygiene/11-RETRIEVAL-SWEEP.md` (new) - The classification table and residual-risk record.

## Decisions Made

- Reused the one `isRetrievableState` predicate everywhere — verified no duplicate predicate was introduced by grepping all four modified source files.
- `findNearestSummaries`'s fail-closed filter loads the retrievable-id set once per call, not per candidate row, specifically to avoid reintroducing the O(n) hotspot class this milestone exists to fix (T-11-27 in the plan's threat register).
- `conversation-resumer.ts` was read and its three id-lookup methods were deliberately left unchanged: they disclose raw `Turn[]` (no `MemoryState` field), content already reachable through direct canonical-event queries regardless of derivation state per D-4 ("Excluded ≠ deleted"). Their separate lack of any person/scope check is a distinct, pre-existing gap, out of this plan's file scope, and is recorded under Residual risk in the sweep document rather than silently fixed or silently ignored.
- Proposal/review candidate pools (`sleep-reviewer.ts`, `proposal-scheduler.ts`) keep their `state !== "superseded"` blacklist rather than switching to the `isRetrievableState` allow-list, because `stale` summaries must remain eligible proposal material and changing that behavior would be a proposal/review-contract change forbidden by the phase's scope fence.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated pre-existing summary-vectors.test.ts fixtures that only seeded vector rows without matching summary rows**
- **Found during:** Task 2
- **Issue:** The Plan 11-08-era SC4 (`never returns another person's or out-of-scope summary...`), cross-store-parity (`SC3, D-07`), and WR-04 (`skips a dimension-drifted row`) tests called `saveSummaryVector` directly without a corresponding `saveSummary` call. Once `findNearestSummaries` started dropping orphaned vector rows (Task 1's RED test (b), now GREEN), these pre-existing tests broke — their fixtures were exactly the orphan case the new behavior is designed to reject.
- **Fix:** Added matching `saveSummary` calls with `state: "active"` and the correct `personId` for every `summaryId` used by these tests' vector fixtures (the SC4 test, the shared `seed()` helper in the cross-store-parity `describe` block, and the dimension-drift test).
- **Files modified:** `tests/storage/summary-vectors.test.ts`
- **Verification:** `npx vitest run tests/storage/summary-vectors.test.ts` — all 35 tests pass; full suite (`npx vitest run`) — 884 passed, 4 skipped.
- **Committed in:** `4b4d813` (part of Task 2's commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 — bug/expected-behavior-change collateral).
**Impact on plan:** Necessary to keep the full suite green while implementing the plan's own intended behavior change (orphaned vector rows must be dropped). No scope creep — no new fixtures or assertions were added beyond what the state-filtering change required.

## Issues Encountered

None beyond the fixture updates documented above.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- GAP-11-A is now closed across every agent-facing candidate-selection path: injection (`applyRetrievalBoundary`, Plan 11-08), MCP search/recall/review/status (`MemoryQueryService`, this plan), whole-subject expansion (`SubjectExpansionService`, this plan), and the vector nearest-neighbor path Phase 14 will retrieve through (`findNearestSummaries`, this plan, both stores).
- `11-RETRIEVAL-SWEEP.md` is a durable artifact for any future retrieval or store-level query addition: it shows the full set of `listSummaries`/`listAnchors`/`listBoxes`/`listTraces`/`findNearestSummaries` call sites and the reasoning to consult before adding a new one.
- Two residual risks were surfaced but deliberately left out of this plan's scope: `ConversationResumer`'s missing person/scope authorization (a distinct gap from GAP-11-A), and the proposal/review candidate pools' blacklist-vs-allow-list asymmetry (accepted, scope-fenced).
- `npx vitest run` (103 files, 884 tests, 4 skipped) and `npm run typecheck` are both green.
- No blockers for Plans 10-14.

---
*Phase: 11-derivation-input-hygiene*
*Completed: 2026-07-27*
