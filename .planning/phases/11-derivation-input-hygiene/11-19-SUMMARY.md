---
phase: 11-derivation-input-hygiene
plan: 19
subsystem: testing
tags: [retrieval, derivation-hygiene, recall-probe, measurement]

requires:
  - phase: 11-derivation-input-hygiene
    provides: "GAP-11-D anchor prune (11-18) and the shipped derivation-hygiene classifier (11-01)"
provides:
  - "SYNTHETIC_MARKERS export from derivation-hygiene.ts, driving SYNTHETIC_RULES so a probe/product marker list cannot drift"
  - "export on applyRetrievalBoundary, rankMemories, selectMemories, addParentBoxContext in memory-retriever.ts"
  - "recall probe with per-item (rank/kind/id/classification/markersFound) attribution and a fidelity-guard reconstruction of selected[]"
  - "11-MEASUREMENT-CORRECTION.md: which of the three historical probe runs are comparable to the corrected harness"
affects: ["11-20", "11-21", "11-22"]

tech-stack:
  added: []
  patterns: ["reconstruct-before-mutate: a probe that reads retrieval internals must compose them before the mutating call it's measuring, not after"]

key-files:
  created:
    - .planning/phases/11-derivation-input-hygiene/11-MEASUREMENT-CORRECTION.md
  modified:
    - src/topic/derivation-hygiene.ts
    - tests/topic/derivation-hygiene.test.ts
    - src/retrieval/memory-retriever.ts
    - tests/retrieval/memory-retriever.test.ts
    - .planning/phases/11-derivation-input-hygiene/11-recall-probe.ts

key-decisions:
  - "SYNTHETIC_MARKERS entries drive SYNTHETIC_RULES.test bodies (via a markerFor lookup) rather than living beside a separately re-typed string, so the two structures cannot diverge."
  - "The probe reconstructs selected[] strictly BEFORE calling prepareInjection per query, since prepareInjection performs writes (saveInjection, summary access bookkeeping, deferred-revival promotion) that would change rankings if reconstruction ran after."
  - "containsHarnessText keeps its field name but is now backed by all 13 rules instead of 3 — documented as non-comparable to prior runs rather than silently redefined."

requirements-completed: [REQ-052, REQ-053]

duration: ~35min
completed: 2026-07-27
---

# Phase 11 Plan 19: Recall Probe Measurement Correction Summary

**Corrected the Phase 11 recall probe to classify with the shipped 13-rule `classifyEvent` (not a hand-rolled 3-pattern subset) and to attribute every selected memory to a rank/kind/id/rule instead of reporting one packet-wide boolean, proven faithful by an equality assertion against `packet.selectedMemory`.**

## Performance

- **Duration:** ~35 min
- **Tasks:** 3/3 completed
- **Files modified:** 5 (2 product files + their tests, 1 probe file); 1 file created

## Accomplishments

- Exported `SYNTHETIC_MARKERS` from `src/topic/derivation-hygiene.ts` (11 literal-prefix markers, driving `SYNTHETIC_RULES.test` bodies directly so the two structures cannot drift) plus `TOOL_CALL_PREFIX`, and widened `src/retrieval/memory-retriever.ts`'s export surface (`applyRetrievalBoundary`, `rankMemories`, `selectMemories`, `addParentBoxContext`) with no other change to that file.
- Rewrote `11-recall-probe.ts` to classify every selected item via the shipped `classifyEvent` + `SYNTHETIC_MARKERS`, reconstruct the real `selected[]` before each `prepareInjection` call, and assert the reconstruction's joined text equals `packet.selectedMemory` — throwing (naming the query id) on mismatch rather than reporting an unattributable number.
- Wrote `11-MEASUREMENT-CORRECTION.md`, naming all three verified defects with `file:line` evidence, a comparability table for the `before` / `after-filter` / `after-anchor-prune` historical runs, and the SC3 / isolated-tool-call / 11-13-must_have scope tension — deferred to Plan 11-22 rather than resolved here.

## Task Commits

1. **Task 1: Export the marker list and the ranking internals the probe must reuse** - `7c80b38` (feat)
2. **Task 2: Rewrite the probe's detectors for per-item attribution** - `6d3838d` (feat)
3. **Task 3: Record what the correction invalidates** - `743bd5b` (docs)

## Files Created/Modified

- `src/topic/derivation-hygiene.ts` - Added `SYNTHETIC_MARKERS` export (11 entries) and a `markerFor` lookup that `SYNTHETIC_RULES` test bodies call instead of re-typing literals; exported `TOOL_CALL_PREFIX`. `HYGIENE_RULE_VERSION` byte-unchanged; no classification behavior changed.
- `tests/topic/derivation-hygiene.test.ts` - Added a describe block asserting every marker matches its own rule and that `SYNTHETIC_MARKERS` ids + the two named non-literal rule ids exactly equal the full `SYNTHETIC_RULES` id set.
- `src/retrieval/memory-retriever.ts` - Added `export` to four previously-module-private pure functions; `git diff` for this file contains only the four added `export` keywords, no other token changes.
- `tests/retrieval/memory-retriever.test.ts` - Added a test composing the four exported functions in `prepareInjection`'s order and asserting equality with the real packet's `selectedMemory` for the same fixture request.
- `.planning/phases/11-derivation-input-hygiene/11-recall-probe.ts` - Replaced the two hand-rolled boolean detectors with per-item attribution (`rank`, `kind`, `id`, `summaryIds`, `traceId`, `boxIds`, `tokenCount`, `score`, `preview`, `containsToolCallText`, `classification`, `markersFound`), a pre-`prepareInjection` reconstruction with a fidelity-guard throw, `probeVersion: 2` + `hygieneRuleVersion` in the artifact root, and a second per-item markdown table. `FROZEN_QUERIES`, the five frozen constants, and `11-RECALL-QUERIES.md` are byte-unchanged.
- `.planning/phases/11-derivation-input-hygiene/11-MEASUREMENT-CORRECTION.md` (created) - Defect evidence, comparability table, and the deferred SC3 scope tension.

## Decisions Made

- **Marker-driven rules, not a parallel table.** `SYNTHETIC_MARKERS` entries are looked up by `SYNTHETIC_RULES.test` bodies via a small `markerFor` helper, rather than declaring the marker array separately from the rule literals. This makes drift a compile/test-time impossibility rather than a code-review discipline: changing a marker without updating its rule (or vice versa) changes behavior immediately, which the existing per-rule classification tests catch.
- **Reconstruct before mutate.** `prepareInjection` writes on every call (injection persistence, summary access bookkeeping, deferred-revival promotion). The probe now reconstructs `selected[]` strictly before calling `prepareInjection` for the same query so the reconstruction ranks against the same pre-mutation state the real call saw — reconstructing after would silently rank against different (already-mutated) summary strength/access data on the second and subsequent queries.
- **Keep the field name, document the redefinition.** `containsHarnessText` still means "this packet has harness-injected text," but is now backed by 13 rules instead of 3. Rather than renaming the field (which would break diffability against `11-RECALL-PROBE.md`'s tables), `11-MEASUREMENT-CORRECTION.md` states explicitly that the old and new values under that name are not comparable.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Exported `TOOL_CALL_PREFIX` from `derivation-hygiene.ts`**
- **Found during:** Task 2 (rewriting the probe's detectors)
- **Issue:** Task 2's acceptance criteria required the probe to import `TOOL_CALL_PREFIX` "rather than re-typing `"[Tool call: "`", but the constant was module-private (`const TOOL_CALL_PREFIX`, no `export`) in `derivation-hygiene.ts`. Task 1's file list did not include this export, but Task 2's action explicitly authorized adding it ("exporting it from the product if it is not already exported"), and the plan's frontmatter `files_modified` already listed `src/topic/derivation-hygiene.ts`.
- **Fix:** Added `export` to the existing `const TOOL_CALL_PREFIX = "[Tool call: ";` declaration — a one-token change, no behavior change.
- **Files modified:** `src/topic/derivation-hygiene.ts`
- **Verification:** `npx vitest run tests/topic/derivation-hygiene.test.ts` and `npm run typecheck` both pass; committed alongside Task 2's probe rewrite.
- **Committed in:** `6d3838d` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking — plan-authorized export the task's own acceptance criteria required)
**Impact on plan:** No scope creep; this is the specific single export the plan's Task 2 action names as in-scope.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The probe can now attribute every selected memory to a rank, kind, id, and rule. Plan 11-21 (live re-baseline against `~/.memory/aaron.db`) and Plan 11-22 (GAP-11-E resolution using per-item attribution) can proceed with this harness; neither ran against the live database in this plan, per the plan's explicit scope boundary.
- `<task-notification>` remains unclassified by the product's `SYNTHETIC_RULES` — Plan 11-20 owns adding that rule; this plan's `markersFound`/`classification` fields will not flag it until 11-20 lands.
- `11-MEASUREMENT-CORRECTION.md` gives Plan 11-22 the exact reasoning gap to close (packet-wide `sourceSummaryIds` union vs. per-item attribution) and the SC3 / isolated-tool-call classification question to answer per offending item.

## Self-Check: PASSED

- FOUND: `.planning/phases/11-derivation-input-hygiene/11-MEASUREMENT-CORRECTION.md`
- FOUND: commit `7c80b38` (Task 1)
- FOUND: commit `6d3838d` (Task 2)
- FOUND: commit `743bd5b` (Task 3)
- `npx vitest run` — 110 passed | 1 skipped (1002 tests passed, 4 skipped) — green
- `npm run typecheck` — clean
- `npx tsx .planning/phases/11-derivation-input-hygiene/11-recall-probe.ts --help` — exit 0
- `git diff -- .planning/phases/11-derivation-input-hygiene/11-RECALL-QUERIES.md` — empty
- `git diff -- .planning/phases/11-derivation-input-hygiene/11-RECALL-PROBE.md` — empty

---
*Phase: 11-derivation-input-hygiene*
*Completed: 2026-07-27*
