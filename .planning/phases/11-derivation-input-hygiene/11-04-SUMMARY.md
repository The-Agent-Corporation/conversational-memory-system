---
phase: 11-derivation-input-hygiene
plan: 04
subsystem: audit
tags: [explain, hygiene, derivation-classification, audit-surface]

# Dependency graph
requires:
  - "11-01: src/topic/derivation-hygiene.ts (classifyEvent, HYGIENE_RULE_VERSION)"
  - "11-02: hygiene-aware contraction path (the source of the survives/excludes decision this plan makes recoverable)"
provides:
  - "explain(store, canonicalEventId, authority) — new 'event' subject reporting { derivationClass, ruleId, ruleVersion, eventKind, role }"
  - "explain() summarized detail extended with hygieneRuleVersion / conversationalEventCount / toolActivityEventCount / syntheticExcludedEventCount / excludedRuleIds / missingSourceEventCount"
affects: [11-05, 11-06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "On-demand recomputation, not persistence: explain-service imports classifyEvent/HYGIENE_RULE_VERSION directly from the one shared module rather than storing a derivationClass column (11-CONTEXT decision 4)."
    - "Canonical-event subject resolution runs strictly last in explain(), after the memory-item and source-grant lookups miss, so the full listCanonicalEvents person-scoped scan never sits ahead of the cheaper indexed lookups on hot paths."

key-files:
  created: []
  modified:
    - src/audit/explain-service.ts
    - src/mcp/tools/read-tools.ts
    - tests/audit/explain-service.test.ts

key-decisions:
  - "CanonicalEvent type lives in src/domain/canonical.ts, not src/domain/types.ts as the plan's interface excerpt implied — imported from the correct module (canonical.ts) rather than re-exporting or duplicating the type."
  - "missingSourceEventCount added as an additive field alongside the plan's five specified hygiene fields, per the plan's own instruction to count deleted source events rather than throw."

requirements-completed: [REQ-053]

# Metrics
duration: ~25min
completed: 2026-07-26
---

# Phase 11 Plan 04: Explain Surface Hygiene Rationale Summary

**`memory explain <canonicalEventId>` gains a new `event` subject reporting `{ derivationClass, ruleId, ruleVersion, eventKind, role }` recomputed live through the single shared `classifyEvent` classifier, and the existing `summarized` verb gains five hygiene counts/rule-ids for a summary's source events — with zero schema changes and the scope-oracle/no-content-copy invariants preserved.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-07-26 (session)
- **Completed:** 2026-07-26
- **Tasks:** 2
- **Files modified:** 3 (0 created, 3 modified)

## Accomplishments

- Wrote 5 RED hygiene tests directly into the existing `tests/audit/explain-service.test.ts` (synthetic/tool/conversational event classification, no-content-leak assertion, cross-person/out-of-scope/missing-id message-equality, summary hygiene-count aggregation) — all failed before Task 2, confirming the gap
- Extended `ExplainSubjectKindSchema` with `"event"` and `EXPLAIN_VERBS` with `"classified"` (both additive)
- Added canonical-event subject resolution to `explain()`: runs last, after memory-item and source-grant lookups miss, calling `store.listCanonicalEvents(personId)` exactly once and reusing the shared `scopeAuthorized` guard so an out-of-scope or cross-person event id throws the identical `UNAUTHORIZED_OR_NOT_FOUND` a missing id throws
- Extended the `summarized` detail with `hygieneRuleVersion`, `conversationalEventCount`, `toolActivityEventCount`, `syntheticExcludedEventCount`, `excludedRuleIds` (comma-joined sorted distinct rule ids), and `missingSourceEventCount`, all computed by classifying the summary's `sourceCanonicalEventIds` through the same shared `classifyEvent`
- Widened the MCP explain tool's independently re-declared `kind` enum in `src/mcp/tools/read-tools.ts` so `memory_explain` does not reject the new `"event"` kind

## Task Commits

1. **Task 1: RED audit tests for hygiene rationale** - `5fe85f8` (test)
2. **Task 2: Extend explain with the canonical-event subject and hygiene detail** - `f74616a` (feat)

## Files Created/Modified

- `src/audit/explain-service.ts` - Imports `classifyEvent`/`HYGIENE_RULE_VERSION` from `../topic/derivation-hygiene.js`; adds `"event"` to `ExplainSubjectKindSchema`, `"classified"` to `EXPLAIN_VERBS`; adds `buildClassifiedEvent` (event subject) and `buildSummarizedEvent` (hygiene-aware summarized detail) helpers; `explain()` tries canonical-event resolution last, after memory-item and grant lookups miss
- `src/mcp/tools/read-tools.ts` - Widened the `MemoryExplainOutputSchema`'s locally re-declared `kind` enum to include `"event"`
- `tests/audit/explain-service.test.ts` - Added a `canonicalEvent` fixture builder and a new "REQ-053 hygiene rationale" describe block with 6 cases (5 assertions map to the plan's (a)-(f) list; the missing-id case (f) was already covered as part of case (d)'s three-way message-equality assertion)

## Decisions Made

See `key-decisions` in frontmatter above.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking type bug] `CanonicalEvent` imported from `../domain/canonical.js`, not `../domain/types.js`**
- **Found during:** Task 2, `npm run typecheck`
- **Issue:** The plan's interface excerpt implicitly suggested importing alongside `Anchor, Box, MemoryTrace, Summary` from `../domain/types.js`, but `CanonicalEvent` is actually defined and exported from `../domain/canonical.ts`. `tsc --noEmit` failed with `TS2305: Module has no exported member 'CanonicalEvent'` in both the source file and the test file.
- **Fix:** Split the import: kept the existing `types.js` import for `Anchor, Box, MemoryTrace, Summary` and added a separate `import type { CanonicalEvent } from "../domain/canonical.js"` in both `src/audit/explain-service.ts` and `tests/audit/explain-service.test.ts`.
- **Files modified:** `src/audit/explain-service.ts`, `tests/audit/explain-service.test.ts`
- **Commit:** `f74616a` (folded into the Task 2 commit since it was discovered and fixed inline before that commit)

No other deviations — plan executed as written.

## Issues Encountered

None blocking. As documented in the plan's `<critical_notes>`, `tests/mcp/stdio-server.test.ts` has 2 pre-existing failures in this worktree (`Cannot find module '.../node_modules/tsx/dist/cli.mjs'`) — a `node_modules`-absent worktree artifact unrelated to this plan's files. Targeted verification (`npx vitest run tests/audit/ tests/mcp/`) shows 94 passed / 2 failed (the same 2 pre-existing failures) and `npm run typecheck` is clean.

## User Setup Required

None.

## Next Phase Readiness

- REQ-053's audit-surface half is now closed: any canonical event's exclusion rationale (rule id + rule version) is recoverable through `memory explain`, and a summary reports the hygiene breakdown of its source events — all recomputed on demand from the single `src/topic/derivation-hygiene.ts` module, with no persisted classification field and no migration.
- Plan 05 (running in parallel, `src/operations/`, `src/daemon/contraction-runner.ts`, `src/cli/command-registry.ts`) was not touched by this plan.
- `src/storage/memory-store.ts`, `sqlite-store.ts`, and `in-memory-store.ts` remain untouched — no interface changes, confirmed via `git diff --name-only` across both task commits.

---
*Phase: 11-derivation-input-hygiene*
*Completed: 2026-07-26*

## Self-Check: PASSED

- `src/audit/explain-service.ts` FOUND
- `src/mcp/tools/read-tools.ts` FOUND
- `tests/audit/explain-service.test.ts` FOUND
- Commit `5fe85f8` FOUND in `git log`
- Commit `f74616a` FOUND in `git log`
