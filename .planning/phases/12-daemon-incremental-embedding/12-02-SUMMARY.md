---
phase: 12-daemon-incremental-embedding
plan: 02
subsystem: storage
tags: [gap-closure, schema-migration, covering-index, store-parity, tdd, req-043, req-045]

requires:
  - phase: 12
    plan: 01
    provides: "`composeModelIdentity`, and the `memory status` identity fix (edit 1 of this plan's Task 2)"
  - phase: 11
    provides: "`RETRIEVABLE_MEMORY_STATES` / `isRetrievableState` — the fail-closed retrievable allow-list"
  - phase: 08
    provides: "`summary_vectors`, `listSummaryIdsMissingVector`, and the both-stores backend matrix"
provides:
  - "schema v4 `idx_summaries_state_id` — the covering index that makes a state predicate cheaper than no predicate"
  - "`listSummaryIdsMissingVector` that means 'embeddable and unembedded', in BOTH stores"
  - "an optional `{ limit }` on the missing-set query, prefix-identical to the unbounded call"
  - "`listSummariesByIds` — the bounded by-id fetch Plan 12-04's repair pass needs"
  - "a `memory status` denominator that agrees with its own numerator"
affects: [12-03, 12-04, 12-05, 12-06, 12-07]

tech-stack:
  added: []
  patterns:
    - "A state predicate over a JSON payload column needs an expression index or it silently becomes a full-payload scan"
    - "A limited query must be a prefix of the unlimited one, not merely 'N of them' — assert it, in both stores"
    - "Numerator and denominator of a reported fraction must be filtered by the same rule"

key-files:
  created: []
  modified:
    - src/storage/schema-migrations.ts
    - src/storage/memory-store.ts
    - src/storage/sqlite-store.ts
    - src/storage/in-memory-store.ts
    - src/bootstrap/status-command.ts
    - tests/storage/summary-vectors.test.ts
    - tests/storage/schema-migrations.test.ts
    - tests/bootstrap/status-command.test.ts

key-decisions:
  - "The index is part of the fix, not an optimization: the predicate alone is 11x SLOWER than the query it replaces (4,000 ms vs 358 ms measured on a clone of the live corpus); with the index it is 29 ms, 12x faster than production today"
  - "`USE TEMP B-TREE FOR ORDER BY` remains in the plan after the index and is correct — the index orders by (state, id) and three states need a global sort; at 29 ms a second index is not worth it"
  - "InMemoryStore slices AFTER sorting, SQLite pushes `limit` into SQL after `order by` — both make a limited call a true prefix, which is the property callers depend on"
  - "`listSummariesByIds` deliberately has NO state filter: it is a fetch primitive and its callers own the policy; the docstring says so"
  - "The existing v3 migration test's 'simulate a v2 database' setup deleted only the v3 row; corrected to `version > 2` so it is not re-broken by every future migration (Rule 3)"

# Neither requirement is fully satisfied here: REQ-043's "daemon embeds incrementally" is 12-03/12-04,
# and REQ-045's detectability is only mechanically pinned once vectors exist on the live corpus (12-07).
# This plan advances both; it does not close either.
requirements-completed: []
requirements-advanced: [REQ-043, REQ-045]

metrics:
  duration: 20min
  tasks: 2
  files: 8
  completed: 2026-07-28
---

# Phase 12 Plan 02: Embeddable Missing Set + Truthful Status Summary

"Missing a vector" now means "should have one" in both stores, backed by a schema v4 covering index
that makes the newly-predicated query 12× faster than the unfiltered query it replaces — and `memory
status` now divides by the same set it counts.

## What was built

**Task 1 — the store layer (commit `5b7933b`).**

- **Schema v4**, appended to `MIGRATIONS`: `create index if not exists idx_summaries_state_id on
  summaries (json_extract(payload,'$.state'), id)`. v1–v3 are byte-unchanged; `git diff
  src/storage/schema-migrations.ts` is a pure append (reproduced below). It leads on state, unlike
  v3's `idx_summaries_person_state`, because `listSummaryIdsMissingVector` takes no `personId` and
  therefore cannot use a personId-leading index.
- **`listSummaryIdsMissingVector` gained a state predicate in both stores.** SQLite binds
  `RETRIEVABLE_MEMORY_STATES` into `json_extract(payload,'$.state') in (?,?,?)` with placeholders
  generated from the array's length, so adding a fourth retrievable state cannot silently drop it,
  and the values are bound rather than interpolated (T-12-07). InMemoryStore filters with
  `isRetrievableState` — the same call its `findNearestSummaries` already makes at :1222, so the two
  stores share one definition of retrievable rather than two kept in agreement by hand.
- **An optional `options?: { limit?: number }`.** SQLite pushes it down as a SQL `limit` after the
  `order by`; InMemoryStore slices after the sort. Both are therefore prefixes, not samples.
- **`listSummariesByIds(ids)`** on `MemoryStore` and both stores: ascending by id, absent ids
  silently omitted, `[]` in / `[]` out with no query issued, chunked at 500 ids per statement in
  SQLite (T-12-08) and parsed through `SummarySchema` like every other summary read. No state
  filter, by design.
- The `MemoryStore` docstring now states the contract in words — a returned id is one whose summary
  is retrievable *and* lacks a vector for the (provider, model), i.e. "what a backfill or repair
  pass should embed", not "every row without a vector" — so a future reader need not infer it from
  the SQL.

Both new behaviors run through the **existing** backend matrix at `tests/storage/summary-vectors.test.ts:66-93`
(no third harness), plus one deep-equal cross-store parity case over a 10-row, 9-state fixture in the
existing `cross-store exact parity` describe.

**Task 2 — the status denominator (commit `91ddc3d`).** `totalSummaries` became
`summaries.filter(isRetrievableState).length`, filtered from the array already in hand from the
`Promise.all` rather than issuing a second query. Payload field names (`provider`, `model`,
`totalSummaries`, `missingVectors`, `completedFraction`) are unchanged.

Edit 1 of this task — `activeModel = composeModelIdentity(embedder.model, embedder.revision)` —
landed in Plan 12-01 as commit `b0fd216` (Rule 1) and was **not** redone or reverted. What this plan
added on top is the REQ-045 mechanical assertion the plan calls for under F1: a case pinning the
real revision `ea104dacec62c0de699686887e3f920caeb4f3e3` and asserting the reported `model`
*contains* it. A revision-less key cannot distinguish a stale model from a current one, so
"the identity carries the revision" is the only mechanical test REQ-045's stale-model detectability
has.

Note on the fraction: `completedFraction` reaches 1.0 whenever `missingVectors` is 0 regardless of
the denominator, so this does not change how an already-complete corpus reports. What it fixes is
the mid-backfill fraction and the reported corpus size, both currently inflated by 89,059 rows that
will never be embedded.

## The pre-fix failures, verbatim

**Task 1 RED** — 14 failures across the two files. The four distinct shapes:

```
 × schema-migrations > applies version 4 (idx_summaries_state_id) when upgrading from version 3
   → expected 3 to be 4 // Object.is equality

 × InMemoryStore summary_vectors > excludes non-retrievable summaries from the missing set — the allow-list is the whole rule (GAP-12-B)
   → expected [ 'summary_active', …(6) ] to deeply equal [ 'summary_active', …(2) ]

  Array [
    "summary_active",
    "summary_compacted",
+   "summary_disputed",
+   "summary_proposed",
    "summary_revived",
+   "summary_stale",
+   "summary_superseded",
  ]

 × InMemoryStore summary_vectors > bounds the missing set with an optional limit, prefix-identical to the unbounded call (T-12-09b)
   → expected [ 'summary_00', 'summary_01', …(10) ] to have a length of 5 but got 12

 × SqliteStore summary_vectors > listSummariesByIds > returns [] for an empty id list
   TypeError: store.listSummariesByIds is not a function
```

And the cross-store parity case, which is the one that would have caught a predicate landing in one
store only:

```
 FAIL  tests/storage/summary-vectors.test.ts > cross-store exact parity (SC3, D-07) > returns a deep-equal missing set from both stores over an identical mixed-state corpus (T-12-05, GAP-12-B)
AssertionError: expected [ 'summary_02_superseded', …(8) ] to deeply equal [ 'summary_03_compacted', …(2) ]

- Expected
+ Received

  Array [
+   "summary_02_superseded",
    "summary_03_compacted",
+   "summary_04_stale",
    "summary_05_revived",
+   "summary_06_proposed",
+   "summary_07_approved",
+   "summary_08_rejected",
+   "summary_09_disputed",
    "summary_10_compacted",
  ]
```

**Task 2 RED — the denominator, both cases:**

```
 × memory status embeddingBackfill snapshot (REQ-042 SC4) > counts only retrievable summaries in the denominator, not the whole table (GAP-12-B)
   → expected 10 to be 3 // Object.is equality

 × memory status embeddingBackfill snapshot (REQ-042 SC4) > reports a fraction over the embeddable denominator when superseded rows outnumber them
   → expected 24 to be 4 // Object.is equality
```

3 retrievable + 7 superseded reported `totalSummaries: 10`; 4 retrievable + 20 superseded reported
24. That is the live corpus's 138,373-vs-49,314 in miniature.

The new pinned-revision assertion (F1) **passed on first run**, because 12-01's `b0fd216` had already
made `activeModel` the composed identity. It is recorded here as a regression pin for REQ-045, not as
a fix.

## Measurements

Measured on a `cp -c` clone of `~/.memory/aaron.db` (5.0 GB, 138,373 summaries: 49,314 `compacted` +
89,059 `superseded`) in the scratchpad, opened with raw `node:sqlite` — never through `SqliteStore`,
so no migration ran against anything but the clone. The live database was never opened in any mode.

| query | rows | wall clock |
|---|---:|---|
| today's unfiltered query | 138,373 | **358 ms** |
| state predicate, no index | 49,314 | **4,000 ms** |
| state predicate + `idx_summaries_state_id` | 49,314 | **29 ms** (23 ms on a second run) |
| state predicate + index + `limit 200` | 200 | **<1 ms** |

Index build on the full clone: **1,268 ms**. The result is **12× faster than the query running in
production today**, so this makes `memory status` and Plan 12-04's repair tick cheaper than they are
now, not merely no worse. These reproduce the orchestrator's independently-measured 329 / 4,090 /
45 ms within run-to-run noise.

### `explain query plan`, verbatim

**Before — today's unfiltered query** (id-only, never touches `payload`):

```
3|0|SCAN summaries USING COVERING INDEX sqlite_autoindex_summaries_1
6|0|CORRELATED SCALAR SUBQUERY 1
10|6|SEARCH sv USING COVERING INDEX sqlite_autoindex_summary_vectors_1 (summary_id=? AND provider=? AND model=?)
```

**Before — the state predicate with no index** (note `USING INDEX`, not `USING COVERING INDEX`: the
predicate forces a `payload` read for all 138,373 rows out of a 5.0 GB table — this is the 4,000 ms):

```
4|0|SCAN summaries USING INDEX sqlite_autoindex_summaries_1
28|0|CORRELATED SCALAR SUBQUERY 1
32|28|SEARCH sv USING COVERING INDEX sqlite_autoindex_summary_vectors_1 (summary_id=? AND provider=? AND model=?)
```

**After — the state predicate with `idx_summaries_state_id`:**

```
4|0|SEARCH summaries USING COVERING INDEX idx_summaries_state_id (<expr>=?)
26|0|CORRELATED SCALAR SUBQUERY 1
30|26|SEARCH sv USING COVERING INDEX sqlite_autoindex_summary_vectors_1 (summary_id=? AND provider=? AND model=?)
49|0|USE TEMP B-TREE FOR ORDER BY
```

`SCAN` became `SEARCH … USING COVERING INDEX idx_summaries_state_id`, which is the whole point.
**`USE TEMP B-TREE FOR ORDER BY` appearing is expected and accepted, not a half-failure**: the index
orders by (state, id), so a query spanning three states still needs one global sort to emit a single
ascending-id stream. At 29 ms it is not worth a second index. The same plan holds with `limit 200`.

The covering-index assertion is also pinned in CI: `tests/storage/schema-migrations.test.ts` runs
`explain query plan` on a migrated database and asserts the plan text matches
`/COVERING INDEX idx_summaries_state_id/`, so a future change that silently drops the index fails a
test rather than quietly costing 4 seconds a tick.

### `git diff src/storage/schema-migrations.ts` — pure append

```
@@ -59,6 +59,24 @@ export const MIGRATIONS: readonly SchemaMigration[] = [
           on summaries (json_extract(payload,'$.personId'), json_extract(payload,'$.state'), id);
       `);
     }
+  },
+  {
+    version: 4,
+    description: "REQ-043: covering index for the state-predicated missing-vector query",
...
   }
 ];
```

No `-` line touches v1–v3.

### Omitting `limit` is behavior-identical to today

Asserted in both stores, three ways: `listSummaryIdsMissingVector(p, m)` returns all 12 fixture ids;
`{ limit: 500 }` (larger than the result) returns the identical array; `{}` (present but empty
options object) returns the identical array. `src/operations/backfill-embeddings-command.ts:64`
passes no options and is therefore unaffected — its behavior changes only in the intended way (the
candidate set is now embeddable-only), which its own 12-01 tests already cover.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The v3 migration test's "simulate a v2 database" setup was version-specific**

- **Found during:** Task 1, immediately after appending v4
- **Issue:** `tests/storage/schema-migrations.test.ts`'s "applies version 3 … when upgrading from
  version 2" deleted only `where version = 3` from `schema_migrations`. With v4 appended,
  `max(version)` was still 4, so `runSchemaMigrations` reported `from: 4` and the test failed
  (`expected 4 to be 2`) — a false failure about the *setup*, not about migration 3.
- **Fix:** `delete from schema_migrations where version > 2` plus `drop index if exists
  idx_summaries_state_id`, with a comment explaining why. The same generalization applied to the new
  v4 test (`where version > 3`) so the next migration does not re-break both.
- **Files modified:** tests/storage/schema-migrations.test.ts
- **Commit:** `5b7933b`

### Deferred

None.

## Authentication gates

None — no network path, no credentials.

## Verification

- `npx vitest run`: **1074 passed | 4 skipped, 111 files passed | 1 skipped**. Baseline after 12-01
  was 1057 passed / 4 skipped; the +17 are this plan's new cases. The known MCP parallel-load flakes
  passed.
- `npm run typecheck`: clean.
- Both stores appear in the diff (`src/storage/sqlite-store.ts` and `src/storage/in-memory-store.ts`),
  and the parity case above fails if only one of them changes.
- `grep -rn --include='*.ts' "!= *'superseded'\|!== *\"superseded\"" src/storage/` returns only
  pre-existing supersession-bookkeeping hits (`commitSupersededSummaryPrune` eligibility, cascade
  computation) plus one new *docstring* mention explaining why the retrievability path does NOT use
  that form. No new `!= 'superseded'` logic.
- Staging: explicit paths only, both commits. `git status --short` checked before each. No
  `git add -A`, no `git add .`, no `git stash`, no `git clean`.

## Known Stubs

None.

## Threat Flags

None. The one schema change is an additive `create index if not exists` at a trust boundary already
owned by `schema-migrations.ts`; no new network endpoint, auth path, or file-access pattern.
`~/.memory/aaron.db` was never opened in any mode — the measurement ran against a `cp -c` clone in
the scratchpad, since read-only or not, `SqliteStore` runs migrations in its constructor whenever
`readOnly` is false and the `pre-phase12` backup (Plan 12-05 Task 2) does not exist yet. All four
`~/.memory/` backups untouched. No packages installed.

## Surprises

- **The clone reproduced the orchestrator's numbers almost exactly** (358 / 4,000 / 29 ms against
  329 / 4,090 / 45 ms), which is a useful signal that this measurement is stable rather than a
  cache-state artifact — the "after" number was 23 ms on a second run, so it is not warm-cache luck
  in the wrong direction either.
- **The unindexed predicate's plan differs from the indexed one by a single word** — `SCAN summaries
  USING INDEX` vs `SCAN summaries USING COVERING INDEX`. That one missing word is the entire 11×.
  It is exactly the kind of difference a reviewer eyeballing a plan would skim past, which is why
  the assertion is now in a test.
- **The state census on the clone is only two states**: 89,059 `superseded` and 49,314 `compacted` —
  no `active`, `revived`, or anything else. So on today's live corpus the retrievable allow-list and
  a hypothetical `!= 'superseded'` would return the same rows. They diverge only on a future state,
  which is precisely the fail-open case the allow-list exists to prevent, and precisely why the
  tests assert `stale`, `proposed`, and `disputed` exclusion rather than only `superseded`.

## Self-Check: PASSED

Files verified present and modified: `src/storage/schema-migrations.ts`, `src/storage/memory-store.ts`,
`src/storage/sqlite-store.ts`, `src/storage/in-memory-store.ts`, `src/bootstrap/status-command.ts`,
`tests/storage/summary-vectors.test.ts`, `tests/storage/schema-migrations.test.ts`,
`tests/bootstrap/status-command.test.ts`. Commits verified in `git log`: `5b7933b`, `91ddc3d`.
