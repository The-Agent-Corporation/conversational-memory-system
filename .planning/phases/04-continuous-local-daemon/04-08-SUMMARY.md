---
phase: 04-continuous-local-daemon
plan: "08"
subsystem: daemon
tags: [incremental-contraction, stable-checkpoint, proposal-scheduling, provenance]
requires:
  - phase: 04-continuous-local-daemon
    provides: Wave 0 contraction contracts and Wave 1 atomic daemon store boundaries
provides:
  - Bounded affected-range contraction with durable canonical-key resume
  - Atomic idempotent publication of immediate offline derivations
  - Fail-closed person and scope dependency invalidation
  - Ten-minute quiet and hourly review-only proposal scheduling
affects: [04-09-daemon-loop, historical-bootstrap, source-deletion, proposal-review]
tech-stack:
  added: []
  patterns: [stable canonical tuple cursor, atomic slice publication, explicit proposal tier]
key-files:
  created:
    - src/daemon/contraction-runner.ts
    - src/daemon/proposal-scheduler.ts
    - src/service/derivation-invalidator.ts
  modified:
    - src/bootstrap/historical-bootstrapper.ts
key-decisions:
  - "A slice resumes after its durable active-topic last event key so a late insert before the advertised next key is still processed."
  - "The first proposal drain uses ten minutes of quiet; later dirty work is bounded by sixty minutes from the last durable proposal run."
  - "Dependency invalidation returns supersessions to the caller so derivations and the checkpoint publish through one atomic store operation."
requirements-completed: [REQ-019, REQ-020, REQ-022]
coverage:
  - id: D1
    description: "Affected history contracts in 250-event or two-second atomic slices and resumes by stable canonical key."
    requirement: REQ-022
    verification:
      - kind: integration
        ref: "tests/daemon/contraction-runner.test.ts#ContractionRunner"
        status: pass
    human_judgment: false
  - id: D2
    description: "Immediate summaries and anchors publish offline while box and trace work remains review-only and cadence-gated."
    requirement: REQ-020
    verification:
      - kind: integration
        ref: "tests/daemon/contraction-runner.test.ts#ProposalScheduler"
        status: pass
    human_judgment: false
  - id: D3
    description: "Crash replay, person ownership, scope ownership, and derived dependency traversal fail closed without duplicate output."
    requirement: REQ-019
    verification:
      - kind: integration
        ref: "npx vitest run tests/daemon/contraction-runner.test.ts tests/bootstrap/historical-bootstrapper.test.ts tests/service/source-lifecycle-service.test.ts"
        status: pass
    human_judgment: false
duration: 7min
completed: 2026-07-17
status: complete
---

# Phase 4 Plan 8: Incremental Contraction and Proposal Tier Summary

**Canonical history now contracts offline in bounded, atomic, restart-safe affected-range slices while higher-order boxes and traces remain cadence-gated proposals.**

## Performance

- **Duration:** 7 min
- **Started:** 2026-07-17T20:05:00Z
- **Completed:** 2026-07-17T20:12:08Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Added suffix-only append processing and topic-boundary rewind for late canonical events, preserving unaffected prefix derivations.
- Added 250-event and injected two-second yield limits with atomic checkpoint/job/derivation publication and stable-key crash replay.
- Centralized fail-closed dependency invalidation and separated deterministic immediate contraction from ten-minute quiet or sixty-minute forced proposal work.
- Preserved HistoricalBootstrapper's one-shot behavior while exposing proposal generation as an explicit compatibility drain; continuous slices never invoke it.

## Task Commits

Git commits are unavailable because this execution environment cannot create `.git/index.lock`.

1. **Task 1: Centralize fail-closed derivation invalidation and sliced contraction** - `unavailable (read-only .git/index.lock)`
2. **Task 2: Separate immediate contraction from proposal scheduling** - `unavailable (read-only .git/index.lock)`

**Plan metadata:** `unavailable (read-only .git/index.lock)`

## Files Created/Modified

- `src/daemon/contraction-runner.ts` - Affected-range selection, topic reconstruction, offline summaries/anchors, bounded slices, and atomic durable checkpoint publication.
- `src/daemon/proposal-scheduler.ts` - Durable quiet/hourly due calculation and review-only box/trace proposal drain.
- `src/service/derivation-invalidator.ts` - Person-owned, dependency-closed supersession planning for summaries, anchors, boxes, proposals, and traces.
- `src/bootstrap/historical-bootstrapper.ts` - Explicit compatibility proposal drain separated from immediate one-shot contraction.

## Decisions Made

- Reused the Wave 1 domain-specific `commitContractionSlice` boundary rather than exposing generic storage transactions.
- Derived rewind boundaries from canonical IDs stored on historical summaries, avoiding dense turn sequences as durable provenance.
- Kept deterministic summarization as the default and made no network or model call mandatory.
- Validated every canonical event against its person-owned source and immutable source scope before writing derived memory.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Crash replay] Added the post-checkpoint fault seam at the runner boundary**
- **Found during:** Task 1 focused verification
- **Issue:** The injected `after_contraction_checkpoint` boundary was not reached because the fault injector belonged to the runner rather than the store fixture.
- **Fix:** Reached the boundary immediately after the atomic store call, accurately modeling a caller crash after committed state.
- **Files modified:** `src/daemon/contraction-runner.ts`
- **Verification:** The clean and crash-replayed derivation fingerprints are identical with unique IDs.
- **Committed in:** unavailable due to read-only `.git/index.lock`

**2. [Rule 1 - Approval safety] Restricted approval-state validation to newly generated review objects**
- **Found during:** Task 2 review
- **Issue:** A broad post-run check would reject legitimate pre-existing approved boxes even though the scheduler had not approved them.
- **Fix:** Validate only the box proposals, proposed boxes, and trace proposals returned by the current review run.
- **Files modified:** `src/daemon/proposal-scheduler.ts`
- **Verification:** Proposal-tier tests pass and every newly generated review object remains proposed.
- **Committed in:** unavailable due to read-only `.git/index.lock`

---

**Total deviations:** 2 auto-fixed (2 Rule 1 bugs).
**Impact on plan:** Both fixes enforce the planned crash and human-approval contracts without expanding scope.

## Issues Encountered

- `npm run typecheck` remains red only on Wave 3 files that do not exist yet (`daemon-command.ts`, `daemon.ts`, and macOS adapters) plus their resulting implicit-any test callbacks. Filtering the compiler output finds no diagnostic in a Plan 04-08 file.
- Git task and metadata commits could not be created because `.git/index.lock` is read-only in this environment; all changes remain in the shared worktree for the orchestrator.

## User Setup Required

None - no external service or model configuration is required.

## Next Phase Readiness

- Plan 04-09 can call `ContractionRunner.drainSlice` independently from source scans and call `ProposalScheduler.runDue` as a separate fair work item.
- No Plan 04-08 blocker remains. Repo-wide typecheck should be rerun after Wave 3 supplies its declared modules.

## Verification

- `npx vitest run tests/daemon/contraction-runner.test.ts tests/bootstrap/historical-bootstrapper.test.ts tests/service/source-lifecycle-service.test.ts` - passed, 15/15 tests.
- `git diff --check -- src/daemon/contraction-runner.ts src/daemon/proposal-scheduler.ts src/service/derivation-invalidator.ts src/bootstrap/historical-bootstrapper.ts` - passed.
- `npm run typecheck` - expected cross-wave failure only in missing Plan 04-09 modules/tests; no diagnostic references a Plan 04-08 file.

## Self-Check: PASSED

- Found all three declared new implementation files and the modified compatibility facade.
- Re-ran every Plan 04-08 automated contract and confirmed all 15 focused tests pass.
- Confirmed stable prefix identity, atomic replay, strict person/scope ownership, offline derivation, and proposed-only review state.
- Confirmed tests use synthetic histories and injected time only.

---
*Phase: 04-continuous-local-daemon*
*Completed: 2026-07-17*
