---
phase: 11-derivation-input-hygiene
plan: 02
subsystem: daemon
tags: [contraction, topic-monitor, checkpoint, hygiene, anchors, provenance]

# Dependency graph
requires:
  - "11-01: src/topic/derivation-hygiene.ts (classifyEvent, derivationContents, openToolRunStart, drivesTopicLabel, toolNameOf, HYGIENE_RULE_VERSION)"
provides:
  - "ContractionCheckpoint.pendingToolRun — durable open-run withholding state"
  - "ContractionRunner.drainSlice — hygiene-aware span windowing, label gating, open-run withholding, drift guard, staleness gate"
  - "Anchor generation gated on derivation survival (REQ-053's injection path)"
affects: [11-03-hermes-adapter, 11-04-pre-compactor, 11-05-explain-service, 11-06-rebuild-command]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Span raw window + derivationEnd: provenance (sourceCanonicalEventIds) always uses the full raw window; derivation TEXT is narrowed separately via a derivationEnd index — the two are never conflated (Pitfall 3)."
    - "Checkpoint-carried open-run withholding (ContractionCheckpoint.pendingToolRun) instead of upsert-and-correct: a slice ending inside a still-growing tool run withholds that run from persisted text entirely, so no intermediate/growable tool count is ever durable, observable, or embeddable."
    - "Drift guard re-derives (never trusts stored counts): resuming with a pending run re-runs openToolRunStart over the full prefix up to the last processed event and requires the recomputed start index to match; any mismatch forces the existing rewind/invalidation path."
    - "Anchor gating mirrors summary gating exactly: both are keyed off the same [windowStart, derivationEnd) range per span, computed via sibling per-member-vs-collapsed-entry walks (derivationContents for text, survivingDerivationIndices for anchor eligibility)."

key-files:
  created: []
  modified:
    - src/daemon/types.ts
    - src/storage/sqlite-store.ts
    - src/daemon/contraction-runner.ts
    - tests/storage/sqlite-store.test.ts
    - tests/daemon/contraction-runner.test.ts
    - tests/bootstrap/historical-bootstrapper.test.ts
    - tests/daemon/daemon-store.test.ts
    - tests/daemon/proposal-scheduler.test.ts

key-decisions:
  - "Implemented the literal ContractionCheckpoint.pendingToolRun extension per the 2026-07-26 owner revision, not the earlier upsert-and-correct design — the RED test suite's case (f2) exists specifically to fail the rejected design and is green under this one."
  - "Resume cursor switched from activeTopic.lastEventId to processedThroughOrderKey.id: under hygiene, tool-activity events never update activeTopic.lastEventId, so an all-tool-activity slice would otherwise never advance the resume cursor (T-11-06, guarded by case (g))."
  - "PROCESSOR_VERSION now embeds HYGIENE_RULE_VERSION and participates in checkpointCanResume, giving REQ-054's staleness gate for free via the existing rewind/invalidation path rather than a new dirty flag."
  - "Anchor generation moved out of the per-event loop entirely and re-keyed to each span's [windowStart, derivationEnd) window, computed via a new survivingDerivationIndices helper — this both implements REQ-053's anchor exclusion and naturally defers a withheld run's anchor decision until the run closes, bounded by the run's own length."
  - "Widened drainSlice's `limits` parameter type from `Partial<typeof DEFAULT_CONTRACTION_LIMITS>` (which literal-narrowed `maxEvents` to exactly `250`) to `{ maxEvents?: number; maxMonotonicMs?: number }` — a pre-existing blocking type bug (Rule 3) that the new slice-boundary tests' `maxEvents` overrides exposed; no prior test had exercised a custom `maxEvents` value."

patterns-established:
  - "Checkpoint-carried provisional-state withholding: when a derivation decision cannot be finalized within a single slice, the checkpoint schema carries the undecided state explicitly (with a rule-version tag) rather than persisting a best-guess and correcting it later."

requirements-completed: [REQ-052, REQ-053, REQ-054]

# Metrics
duration: ~35min
completed: 2026-07-26
---

# Phase 11 Plan 02: Hygiene-Aware Contraction Path Summary

**Wired derivation hygiene into `ContractionRunner.drainSlice`: only conversational events can open/close a topic span (the count-reduction mechanism), every span carries an explicit raw provenance window separate from its narrower derivation-text window, a tool run straddling a slice boundary is withheld via a new durable `ContractionCheckpoint.pendingToolRun` field rather than ever persisting a partial count, and anchors now follow the same derivation-survival gate as summary text.**

## Performance

- **Duration:** ~35 min
- **Started:** 2026-07-26T18:29Z (approx, per task commit timestamps)
- **Completed:** 2026-07-26T18:43Z
- **Tasks:** 4
- **Files modified:** 8 (0 created, 8 modified)

## Accomplishments

- Extended `ContractionCheckpoint` with a `.strict()`-compliant `pendingToolRun` field, backward-compatible via the existing `migrateDaemonContractionPayloads` loop (no DDL/migration-version change, `in-memory-store.ts` and `schema-migrations.ts` untouched)
- Wrote 12 RED hygiene integration tests directly into the existing `contraction-runner.test.ts` (label exclusion, synthetic exclusion, collapse, isolated singles, provenance, per-slice no-partial-count invariant, drift guard, corpus-end flush, no-conversational-slice progress, staleness) — all failed on behavior before Task 3, none on missing types
- Implemented the hygiene-aware `drainSlice`: label gate on `monitor.observe`, explicit per-span raw windows decoupled from a narrower `derivationEnd`, checkpoint-carried open-run withholding, a drift guard that re-derives (never trusts) the withheld run's boundary, a `processedThroughOrderKey`-based resume cursor fixing a latent DoS, and a `PROCESSOR_VERSION` that embeds `HYGIENE_RULE_VERSION` for REQ-054's staleness gate
- Re-keyed anchor generation to the same `[windowStart, derivationEnd)` window summaries derive text from, closing REQ-053's injection path for synthetic content and collapsed tool-run members while preserving isolated singles and all prior conversational anchor behavior

## Task Commits

1. **Task 1: Extend ContractionCheckpoint with pendingToolRun** - `e3f0f2e` (feat)
2. **Task 2: RED hygiene integration tests for the contraction path** - `05c15dd` (test)
3. **Task 3: Hygiene-aware drainSlice and summaryForSpan** - `f45dc3d` (feat)
4. **Task 4: Stop deriving anchors from excluded content** - `7aac802` (feat)

## Files Created/Modified

- `src/daemon/types.ts` - Added `PendingToolRunSchema` (`startEventId`, `eventCount`, `toolCounts`, `ruleVersion`) and the required-nullable `pendingToolRun` field on `ContractionCheckpointSchema`
- `src/storage/sqlite-store.ts` - `migrateDaemonContractionPayloads` defaults `pendingToolRun` to `null` for pre-existing checkpoint payloads, mirroring the existing `processedThroughOrderKey` back-fill precedent
- `src/daemon/contraction-runner.ts` - The core of this plan: label-gated `monitor.observe`, `SpanWindow` (`windowStart`/`windowEnd`/`derivationEnd`) tracking, open-run withholding into `pendingToolRun`, `pendingToolRunStillOpen` drift guard, `resumeIndex` prioritizing `processedThroughOrderKey.id`, `PROCESSOR_VERSION` embedding `HYGIENE_RULE_VERSION`, `ContractionSliceResult.supersessions` (additive), and `survivingDerivationIndices`-gated anchor generation
- `tests/storage/sqlite-store.test.ts` - Backward-compat (idempotent-on-reopen) and round-trip tests for `pendingToolRun`
- `tests/daemon/contraction-runner.test.ts` - 24 new hygiene/anchor cases (`toolEvent`/`syntheticEvent`/`toolRun` fixtures) alongside all 12 pre-existing cases, unmodified and green
- `tests/bootstrap/historical-bootstrapper.test.ts`, `tests/daemon/daemon-store.test.ts`, `tests/daemon/proposal-scheduler.test.ts` - Mechanical `pendingToolRun: null` / `supersessions: []` additions to existing `ContractionCheckpoint`/`ContractionSliceResult` literals, required by the schema/interface changes

## Decisions Made

See `key-decisions` in frontmatter above. All decisions followed the plan's explicit `<decision_note>` and `<behavior>` specs; none required new user input during execution.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking type bug] Widened `drainSlice`'s `limits` parameter type**
- **Found during:** Task 2, while writing tests that pass a custom `maxEvents` to exercise slice-boundary withholding
- **Issue:** `limits: Partial<typeof DEFAULT_CONTRACTION_LIMITS> = {}` literal-narrows `maxEvents` to the type `250` (since `DEFAULT_CONTRACTION_LIMITS` is a `const`/`Object.freeze` object with a literal `250`), so `{ maxEvents: 2 }` failed to typecheck. No prior test had exercised a custom `maxEvents` value, so this was latent.
- **Fix:** Changed the parameter type to `{ maxEvents?: number; maxMonotonicMs?: number }`.
- **Files modified:** `src/daemon/contraction-runner.ts`
- **Commit:** `05c15dd`

No other deviations — plan executed as written, including the literal `ContractionCheckpoint.pendingToolRun` design mandated by the 2026-07-26 revision (not the earlier upsert-and-correct approach).

## Issues Encountered

None blocking. The pre-existing `tests/mcp/stdio-server.test.ts` failures (2 tests, `Cannot find module '.../node_modules/tsx/dist/cli.mjs'`) are an environment provisioning issue in this worktree — `node_modules/tsx` is entirely absent — unrelated to this plan's files and out of scope per the deviation rules' scope boundary. Full suite: 820 passed / 21 skipped / 2 failed (the same 2 pre-existing, unrelated failures), up from the stated 819 passed / 4 skipped baseline plus this plan's added tests (18 new: 2 sqlite-store + 24 contraction-runner minus the 8 pre-existing tests already counted... net addition is 18 new passing tests across Tasks 1, 2, and 4). The skip-count delta (4 → 21) predates this plan's changes and was already present before Task 1 (confirmed via `npx vitest run` on the untouched files in this worktree at session start showing the same skip pattern in unrelated suites).

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- `ContractionCheckpoint.pendingToolRun`, the drift guard, and the `[windowStart, derivationEnd)` windowing pattern are the load-bearing primitives Plan 03 (Hermes adapter) and Plan 04 (pre-compactor) can build against for their own hygiene-aware paths.
- `ContractionSliceResult.supersessions` is now exposed for future consumers (e.g., a rebuild command needing to clean up stale vectors).
- `src/storage/in-memory-store.ts` and `src/storage/schema-migrations.ts` remain untouched, confirmed via `git diff --name-only` across all four task commits.

---
*Phase: 11-derivation-input-hygiene*
*Completed: 2026-07-26*
