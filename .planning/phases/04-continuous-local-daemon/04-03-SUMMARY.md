---
phase: 04-continuous-local-daemon
plan: "03"
subsystem: testing
tags: [vitest, contraction, canonical-order, crash-replay, proposals]

requires:
  - phase: 03-source-lifecycle-control-plane
    provides: person and scope ownership, source revocation, and dependency invalidation contracts
provides:
  - Executable RED contracts for affected-range contraction and bounded late-event rewind
  - Executable RED contracts for stable-key slice checkpoints and atomic crash replay
  - Executable RED contracts for offline immediate derivation and quiet or hourly proposal scheduling
affects: [04-05, 04-08, contraction-runner, proposal-scheduler]

tech-stack:
  added: []
  patterns: [synthetic-only daemon fixtures, injected monotonic clock, behavior-first RED contracts]

key-files:
  created: [tests/daemon/contraction-runner.test.ts]
  modified: []

key-decisions:
  - "Contraction exposes observable rewind and processed stable-order keys so bounded work can be proven without inspecting private state."
  - "Proposal cadence is tested from durable activity and dirty state with an injected clock; all generated review objects must remain proposed."

patterns-established:
  - "Affected-range proof: snapshot prefix derivations, append or late-insert synthetic events, then require byte-stable prefix objects."
  - "Crash proof: inject faults on both sides of an atomic slice boundary and compare replay output to a clean run."

requirements-completed: [REQ-019, REQ-020, REQ-022]

coverage:
  - id: D1
    description: "Affected-range contraction, bounded rewind, and stable-key slice resume are specified with synthetic timelines."
    requirement: REQ-022
    verification:
      - kind: unit
        ref: "tests/daemon/contraction-runner.test.ts#ContractionRunner"
        status: fail
    human_judgment: true
    rationale: "Wave 0 intentionally establishes RED contracts; Wave 2 plan 04-08 supplies the production runner."
  - id: D2
    description: "Immediate deterministic derivation and quiet or hourly review-only proposal scheduling are specified."
    requirement: REQ-020
    verification:
      - kind: unit
        ref: "tests/daemon/contraction-runner.test.ts#ProposalScheduler"
        status: fail
    human_judgment: true
    rationale: "Wave 0 intentionally establishes RED contracts; Wave 2 plan 04-08 supplies the production scheduler."

duration: 14min
completed: 2026-07-17
status: complete
---

# Phase 4 Plan 03: Incremental Contraction Contract Summary

**Synthetic RED contracts now pin suffix-only contraction, topic-bounded late-event rewind, durable yielding, atomic replay, offline immediate derivation, and review-only proposal cadence.**

## Performance

- **Duration:** 14 min
- **Started:** 2026-07-17T19:17:00Z
- **Completed:** 2026-07-17T19:31:31Z
- **Tasks:** 2
- **Files modified:** 1

## Accomplishments

- Defined append and late-insert cases that preserve unaffected prefix summaries, anchors, boxes, traces, and proposals.
- Defined 250-event and injected two-second yielding with durable resume by canonical `(occurredAt,nativeSequence,id)` rather than an array count.
- Defined atomic crash replay, person/scope fail-closed behavior, offline immediate derivation, and ten-minute quiet or hourly proposal scheduling.

## Task Commits

Git commits are unavailable in this execution environment because `.git/index.lock` is read-only.

1. **Task 1: Specify sliced affected-range contraction** - `unavailable (read-only .git/index.lock)`
2. **Task 2: Specify immediate and quiet derivation tiers** - `unavailable (read-only .git/index.lock)`

## Files Created/Modified

- `tests/daemon/contraction-runner.test.ts` - Synthetic behavior contracts for `ContractionRunner` and `ProposalScheduler`.

## Decisions Made

- Kept all history synthetic and used only injected clocks and fault boundaries; no real personal history or operating-system integration is opened.
- Made the expected Wave 0 RED boundary explicit: the suite fails at module resolution until plan 04-08 creates `src/daemon/contraction-runner.ts` and `src/daemon/proposal-scheduler.ts`.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- The focused test command reports the planned RED state because the Wave 2 production modules do not exist yet. This is the intended ordering, not an implementation failure in this plan.
- Git metadata is read-only, so task and metadata commits could not be created; changes remain in the shared worktree for the orchestrator.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 04-08 can implement against the public behavior contract in `tests/daemon/contraction-runner.test.ts`.
- The suite must become green without weakening prefix preservation, stable-key resume, person/scope isolation, offline determinism, or proposal review state.

## Verification

- `npx vitest run tests/daemon/contraction-runner.test.ts` - expected RED: missing `src/daemon/contraction-runner.js` (Wave 2 plan 04-08).
- `git diff --check -- tests/daemon/contraction-runner.test.ts` - passed.

## Self-Check: PASSED

- Found `tests/daemon/contraction-runner.test.ts`.
- Found `.planning/phases/04-continuous-local-daemon/04-03-SUMMARY.md`.
- Confirmed the focused suite fails only at the planned missing-module RED boundary.

---
*Phase: 04-continuous-local-daemon*
*Completed: 2026-07-17*
