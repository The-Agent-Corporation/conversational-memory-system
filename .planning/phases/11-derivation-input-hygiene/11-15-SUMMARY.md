---
phase: 11-derivation-input-hygiene
plan: 15
subsystem: retrieval
tags: [performance, dedup, benchmark, retrieval]

# Dependency graph
requires:
  - phase: 11-derivation-input-hygiene
    provides: "GAP-11-A close (retrievable-state filtering), Plan 11-10's SummaryFilter"
provides:
  - "dedupeRankedMemory hoists per-summary normalization and evaluates the box/thread guards before the substring search"
  - "a differential equivalence oracle (naiveDedupeReference) proving the selected set is unchanged"
  - "a deterministic in-process benchmark proving the fix clears the throughput floor Plan 11-13 needs"
affects: [11-13, 11-14]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Differential equivalence testing: a frozen, independently-transcribed oracle pinned in Task 1 and imported (never re-derived) by later tasks/benchmarks"
    - "Deterministic in-process benchmark: seeded LCG fixtures + median-of-repeated-samples timing, no database/filesystem, sized to reproduce a live measured baseline within one order of magnitude"

key-files:
  created:
    - tests/retrieval/memory-retriever-dedupe.test.ts
    - tests/retrieval/memory-retriever-dedupe-bench.test.ts
  modified:
    - src/retrieval/memory-retriever.ts

key-decisions:
  - "Exported RankedMemory and dedupeRankedMemory (export keyword only, no logic change) so the Task 1 oracle test can hold the real implementation to its pinned contract."
  - "sharesBox/sharesThread now take precomputed boxIds arrays / threadIds sets instead of RankedMemory objects, since Task 2 precomputes those once per summary outside the anchor loop."
  - "Benchmark fixture reuses Task 1's generateDedupeCases (not just its oracle) for case-type diversity, layered under a custom size-tiered summary-body distribution (0.5% ~800KB / 2% ~100KB / 7.5% ~10KB / 90% ~1KB) matching the GAP-11-B live corpus."

patterns-established:
  - "Behavior-preserving performance fix workflow: pin exact current semantics with an oracle BEFORE touching implementation, hold the oracle's diff empty across the fix and the benchmark, measure rather than assume sufficiency."

requirements-completed: [REQ-052, REQ-053, REQ-054]

# Metrics
duration: 25min
completed: 2026-07-27
---

# Phase 11 Plan 15: Close GAP-11-B (dedup hotspot) with a proven-equivalent, measured fix Summary

**Hoisted per-summary normalization out of the anchor loop and reordered the box/thread/substring conjunction cheap-first in `dedupeRankedMemory`, proven behavior-preserving by a 200+-case differential oracle and measured at ~1.3M pairs/sec (~30x the naive arm) against a fixture that reproduces the live corpus's summary-size distribution — clearing Plan 11-13's 1,000,000 pairs/sec sufficiency floor on the first measurement, so no GAP-11-C was needed.**

## Performance

- **Duration:** 25 min
- **Started:** 2026-07-27T10:31:00Z
- **Completed:** 2026-07-27T10:38:00Z
- **Tasks:** 3 completed
- **Files modified:** 3

## Accomplishments
- Task 1's `naiveDedupeReference` (a verbatim, independently-implemented transcription of the pre-fix algorithm) passed GREEN against unmodified HEAD, proving it's a faithful oracle before any implementation change.
- Task 2's hoist + reorder in `src/retrieval/memory-retriever.ts` kept the oracle's diff empty and the full `npx vitest run` suite green (108 files / 955 tests passed, 4 skipped) — the selected memory set is provably unchanged.
- Task 3's in-process benchmark measured the fix at ~1.3M pairs/sec, clearing the 1,000,000 pairs/sec floor Plan 11-13 needs. The sufficiency gate (assertion 4) passed on the first run; **the escape hatch did not fire and GAP-11-C was not raised.**

## Task Commits

Each task was committed atomically:

1. **Task 1: Pin current dedup semantics with a differential equivalence test** - `46ede44` (test)
2. **Task 2: Hoist per-summary normalization and put the cheap guards first** - `c28616d` (fix)
3. **Task 3: Deterministic in-process benchmark with a derived throughput threshold** - `049357b` (test)

**Plan metadata:** commit to follow (docs: complete plan)

## Files Created/Modified
- `src/retrieval/memory-retriever.ts` - `dedupeRankedMemory`/`RankedMemory` exported (comment-only, no logic change in Task 1); `dedupeRankedMemory` precomputes `PreparedSummary[]` (normalized text, boxIds, threadIds) once per summary before the anchor loop; `isAnchorCoveredBySummary` evaluates `sharesBox && sharesThread && includes(...)` in that cheap-first order; `sharesBox`/`sharesThread` retargeted to take the precomputed arrays/sets directly
- `tests/retrieval/memory-retriever-dedupe.test.ts` - `naiveDedupeReference` oracle (local copies of `sharesBox`/`sharesThread`/`normalizedMemoryText`, never touching the source module's helpers); `generateDedupeCases` fixture generator covering all 14 `DEDUPE_CASE_TYPES` plus 200+ LCG-generated cases; 8 `it` blocks including the ordering/referential-identity check and case (d) (box-mismatch survival)
- `tests/retrieval/memory-retriever-dedupe-bench.test.ts` - in-process benchmark importing `naiveDedupeReference`/`generateDedupeCases` by name; size-tiered fixture (432 summaries / 548 anchors / 236,736 pairs); median-of-N timing; 4 assertions (agreement, proxy-fidelity, hoist ratio floor, sufficiency floor)

## Decisions Made
- Exported `RankedMemory`/`dedupeRankedMemory` from the source module rather than duplicating the interface in the test file, keeping the oracle's type contract mechanically in sync with the real one.
- `sharesBox`/`sharesThread` signatures changed from `(RankedMemory, RankedMemory)` to `(string[], string[])` / `(Set<string>, Set<string>)` since Task 2 precomputes those shapes once per summary; semantics (empty-either-side box match; empty-left-thread-set iff right has any turn ranges) preserved exactly and verified by the untouched Task 1 oracle.
- Benchmark fixture combines a custom size-tiered summary-body generator (to hit the live corpus's 0.5%/2%/7.5%/90% body-size distribution) with a reused call into Task 1's `generateDedupeCases` (to also exercise its 14 pinned case-type edge behaviors at scale), rather than choosing one or the other.

## Deviations from Plan

None — plan executed exactly as written. All acceptance criteria met on the first pass for every task; the sufficiency gate (Task 3 assertion 4) passed without needing the documented escape hatch.

## Measured Benchmark Result (verbatim)

```json
{"anchorCount":548,"summaryCount":432,"pairs":236736,"naiveMs":5348.678708000001,"optimizedMs":177.30345800000214,"naiveSamplesMs":[5445.933416,5254.590875,5348.678708000001],"optimizedSamplesMs":[185.9434170000004,186.37779099999898,175.48791699999856,174.80683399999907,177.30345800000214],"ratio":30.166804236835226,"naivePairsPerSecond":44260.65069975408,"pairsPerSecond":1335202.3850544253}
```

- **naiveMs:** 5,348.68 (median of 3 timed passes)
- **optimizedMs:** 177.30 (median of 5 timed passes)
- **ratio (naiveMs / optimizedMs):** ~30.2x
- **naivePairsPerSecond:** ~44,261 (proxy-fidelity check: within the asserted [5,000, 500,000] band and close to the GAP-11-B live baseline of ~48,900 pairs/sec)
- **pairsPerSecond (optimized):** ~1,335,202 — clears the 1,000,000 pairs/sec floor Plan 11-13 needs
- **anchor/summary counts:** 548 anchors x 432 summaries = 236,736 pairs

Run-to-run variance observed across three local invocations: `pairsPerSecond` ranged ~1.22M-1.34M, `ratio` ~29.5x-30.2x — all runs cleared both the fidelity band and the sufficiency floor with margin.

## Escape Hatch: Did Not Fire

Assertions 1-4 all passed on the first measurement. No `it.skip`, no lowered threshold, no fixture retuning. **GAP-11-C was not raised** — hoist + reorder alone was sufficient; the structural boxId/threadId index option from GAP-11-B's "Fix direction" is not needed by this measurement.

## Verification

- `npx vitest run tests/retrieval/` - GREEN (6 files, 49 tests, including the untouched `memory-retriever.test.ts` and `memory-retriever-scale.test.ts`)
- Full `npx vitest run` - GREEN (108 test files passed, 1 skipped [pre-existing, unrelated]; 955 tests passed, 4 skipped)
- `npm run typecheck` - clean
- `git diff tests/retrieval/memory-retriever-dedupe.test.ts` empty in Task 2 and Task 3 (oracle never edited)
- `git diff --stat` for the whole plan touches only the three files in `files_modified` plus this SUMMARY

## Next Steps
- Plan 11-13 Task 1 (the frozen 12-query recall probe) is unblocked — it can now re-run against the corrected build within a practical time budget.
