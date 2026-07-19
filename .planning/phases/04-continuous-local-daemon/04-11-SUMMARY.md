---
phase: 04-continuous-local-daemon
plan: "11"
subsystem: database
tags: [sqlite, zod, schema-migration, canonical-ordering, idempotency]
requires:
  - phase: 04-continuous-local-daemon
    provides: Stable per-person contraction jobs, checkpoints, and atomic import commits from Plan 04-05
  - phase: 04-continuous-local-daemon
    provides: Approved-grant enrollment and restart reconstruction from Plan 04-10
provides:
  - Work-range generation epochs and durable processed-through canonical boundaries
  - Independent nullable proposal-run timestamps with a stable created-at first-run baseline
  - Backend-equivalent append, clean-window replacement, late rewind, and replay semantics
  - Transactional byte-stable normalization of legacy SQLite contraction payloads
affects: [04-12-runner-and-proposal-consumption, 04-15-producer-hardening, 04-17-authority-guarded-contraction]
tech-stack:
  added: []
  patterns: [strict Zod preprocess compatibility, canonical tuple comparison, transactional JSON backfill, receipt-idempotent stable-job merge]
key-files:
  created: []
  modified:
    - src/daemon/types.ts
    - src/storage/memory-store.ts
    - src/storage/in-memory-store.ts
    - src/storage/sqlite-store.ts
    - tests/daemon/daemon-store.test.ts
key-decisions:
  - "A contraction generation is a work-range epoch: ordinary appends retain it, while one earlier-than-processed merge advances it once."
  - "Stable-job merges preserve createdAt and lastProposalRunAt; the first forced-proposal baseline is therefore lastProposalRunAt ?? createdAt."
  - "Legacy checkpoint backfill derives processedThroughOrderKey from the immediately preceding canonical tuple, or the latest tuple when complete."
patterns-established:
  - "Receipt replay skips a second stable-job merge, while checkpoint/job generation mismatch prevents a distinct replay receipt from advancing the same rewind twice."
  - "Legacy JSON normalization runs inside one short BEGIN IMMEDIATE transaction and writes only byte-different payloads."
requirements-completed: [REQ-019, REQ-021, REQ-022]
coverage:
  - id: D1
    description: Stable per-person jobs distinguish append resume from a late-event rewind and advance exactly one durable generation.
    requirement: REQ-022
    verification:
      - kind: integration
        ref: tests/daemon/daemon-store.test.ts#keeps append work in-generation and advances one generation for an idempotent late rewind
        status: pass
    human_judgment: false
  - id: D2
    description: Proposal cadence metadata remains independent from activity and survives backend restart.
    requirement: REQ-021
    verification:
      - kind: integration
        ref: tests/daemon/daemon-store.test.ts#makes the same late-range rewind decision in memory and after SQLite reopen
        status: pass
    human_judgment: false
  - id: D3
    description: Legacy SQLite job and checkpoint payloads normalize transactionally with reconstructed canonical progress and byte-stable repeat reopen.
    requirement: REQ-019
    verification:
      - kind: integration
        ref: tests/daemon/daemon-store.test.ts#backfills legacy SQLite contraction payloads transactionally and byte-stably
        status: pass
    human_judgment: false
duration: 6min
completed: 2026-07-18
status: complete
---

# Phase 4 Plan 11: Durable Rewind Generation and Proposal Cadence Summary

**Stable contraction jobs now persist one idempotent rewind epoch, an exact processed canonical boundary, and proposal timing that survives activity churn and SQLite restart.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-07-18T15:46:00Z
- **Completed:** 2026-07-18T15:52:08Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments

- Added staged strict-schema compatibility for `generation=1`, `lastProposalRunAt=null`, and `processedThroughOrderKey=null`, while retaining unknown-key and invalid-explicit-value rejection.
- Implemented identical stable-job merge semantics in both stores: clean completed windows are replaced, pending windows merge canonical bounds, appends retain generation, and earlier-than-processed work advances exactly once.
- Preserved stable `createdAt` and `lastProposalRunAt` across current activity, dirty flags, and incoming job reuse.
- Added transactional legacy SQLite payload normalization that reconstructs partial and completed processed boundaries and remains byte-identical on a second reopen.
- Proved person ownership, canonical tuple ordering, receipt replay, distinct-receipt replay, proposal timestamp persistence, and reopened-SQLite parity with synthetic data.

## Task Commits

Git metadata is read-only in this execution environment, so task and metadata commits could not be created. The parent explicitly instructed against repeated commit attempts. No hashes are claimed; all changes remain in the shared dirty checkout for later commit from a Git-writable environment.

1. **Task 1: Define durable rewind-generation and proposal-run metadata** - unavailable (read-only Git metadata)
2. **Task 2: Implement backend-equivalent stable-job merge and restart persistence** - unavailable (read-only Git metadata)

**Plan metadata:** unavailable (read-only Git metadata)

## Files Created/Modified

- `src/daemon/types.ts` - Added generation, independent proposal-run time, processed-through boundary, and missing-field normalization around strict schemas.
- `src/storage/memory-store.ts` - Documented the stable work-epoch/proposal baseline and processed-versus-next checkpoint contract.
- `src/storage/in-memory-store.ts` - Added checkpoint-aware clone-staged append/rewind merge and receipt replay handling.
- `src/storage/sqlite-store.ts` - Added equivalent transactional merge logic and transactional legacy JSON normalization/backfill.
- `tests/daemon/daemon-store.test.ts` - Added strict legacy parsing, append/rewind/replay, backend restart parity, proposal persistence, and partial/completed migration tests.

## Decisions Made

- A late merge advances generation only when its checkpoint is in the current job generation and its earliest canonical tuple precedes `processedThroughOrderKey`. A stale checkpoint already from a prior generation cannot advance the same rewind again.
- Replaying the same receipt does not touch stable-job scheduling metadata. A distinct deterministic replay receipt still merges safely but cannot re-advance an already-invalidated checkpoint.
- Completed clean jobs discard their ancient affected window when new work arrives; pending jobs continue to union their earliest/latest canonical bounds.
- Compatibility defaults live at the schema boundary only until Plan 04-15 migrates every producer and hardens the fields as required inputs.

## Deviations from Plan

None - the plan was executed as written.

## Issues Encountered

- The checkout was already substantially dirty before execution, including the Phase 4 source/test tree and unrelated tracked changes. Only the five plan-owned files and this summary were changed for Plan 04-11; no unrelated work was reverted or cleaned.
- `npm run typecheck` was run because TypeScript surfaces changed. It reports the expected staged-migration missing-field diagnostics in existing producers and fixtures (`codex-importer`, `contraction-runner`, and daemon runner/loop/scheduler tests). Plan 04-11 explicitly defers those producer updates and required-field hardening to Plan 04-15, so no out-of-scope constructors were edited.
- Git commits remain unavailable because this environment cannot write Git metadata. Implementation and verification are complete on disk.

## TDD Gate Compliance

- Focused schema/store behavior was added and verified against both backends.
- Final GREEN: 31/31 plan-targeted tests pass; broader daemon regression is 75/75.
- RED/GREEN commits are unavailable because Git metadata is read-only.

## Verification

- `npx vitest run tests/daemon/daemon-store.test.ts tests/storage/sqlite-store.test.ts` - 31 passed across 2 files.
- `npx vitest run tests/daemon` - 75 passed across 7 files.
- `git diff --check` - passed.
- `npm run typecheck` - expected staged-migration diagnostics only; producer migration is explicitly assigned to Plan 04-15.

## Privacy and Isolation Review

- Stable-job and checkpoint records contain only person/job IDs, canonical tuple keys, state flags, counters, and timestamps; no conversation content, tool results, source paths, raw errors, or secrets were added.
- Both merge implementations select checkpoints by exact `personId` and stable `jobId`, retain existing ownership validation, and never inspect another person's canonical timeline.
- Legacy processed-boundary reconstruction queries canonical events for the checkpoint row's exact person and uses the canonical `(occurredAt, nativeSequence, id)` order.
- Tests use synthetic people, grants, events, and temporary SQLite databases only. No native history, client/case material, network service, external model, or live OS service was accessed.
- Proposal state remains review-only; this plan persists cadence metadata but does not generate, approve, or inject proposals.

## Known Stubs

None.

## Next Phase Readiness

- Plan 04-12 can consume generation mismatch and `processedThroughOrderKey` to invalidate suffix resume, and can compute forced cadence from `lastProposalRunAt ?? createdAt`.
- Plan 04-15 must migrate every direct producer/fixture before removing the temporary missing-field defaults and restoring repository-wide typecheck compliance.
- The parent orchestrator retains ownership of phase-level STATE/ROADMAP/requirements completion and final commit handling.

## Self-Check: PASSED

- All five declared production/test files exist.
- `04-11-SUMMARY.md` exists with `status: complete`.
- Exact plan verification, broader daemon regression, and diff hygiene checks pass.
- Partial and completed legacy checkpoint reconstruction, byte-stable second reopen, and reopened SQLite/InMemory parity are directly covered.
- Commit verification is intentionally unavailable and accurately documented.

---
*Phase: 04-continuous-local-daemon*
*Completed: 2026-07-18*
