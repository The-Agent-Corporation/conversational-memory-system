---
phase: 04-continuous-local-daemon
plan: "12"
subsystem: daemon
tags: [incremental-contraction, generation-rewind, proposal-cadence, provenance, idempotency]
requires:
  - phase: 04-continuous-local-daemon
    provides: stable per-person contraction jobs and atomic slice publication from Plan 04-08
  - phase: 04-continuous-local-daemon
    provides: durable generation, processed-boundary, and proposal-run metadata from Plans 04-11 and 04-15
provides:
  - Generation-compatible stable-job resume with bounded topic-span rewind
  - Durable per-job ten-minute quiet and sixty-minute forced proposal cadence
  - Production-shaped same-job restart, replay, and continuous-activity regression proofs
affects: [04-17, 04-18, 04-19, daemon-verification, proposal-review]
tech-stack:
  added: []
  patterns: [generation-compatible-resume, advancing-affected-window, per-job-durable-cadence, proposed-only-review]
key-files:
  created: []
  modified:
    - src/daemon/contraction-runner.ts
    - src/daemon/proposal-scheduler.ts
    - tests/daemon/contraction-runner.test.ts
key-decisions:
  - "A checkpoint is resumable only when its generation matches the stable job and the job's pending affected key is not before the processed boundary."
  - "Each committed slice advances the job's affected window through the processed tuple, while generation remains a work-range epoch and sliceCount remains an independent yield counter."
  - "Proposal forcing is evaluated per complete dirty job from lastProposalRunAt or the preserved createdAt baseline, never from updatedAt or another job."
patterns-established:
  - "A stale generation discards active-topic resume state, recomputes the intersecting topic boundary, and publishes replacement suffix derivations with the current job generation atomically."
  - "A successful review drain records lastProposalRunAt on the same stable job and clears only due proposed-only work."
requirements-completed: [REQ-019, REQ-020, REQ-022]
coverage:
  - id: D1
    description: A late event merged into the production stable job invalidates the old checkpoint and reprocesses only the affected suffix across restart and replay.
    requirement: REQ-019
    verification:
      - kind: integration
        ref: "tests/daemon/contraction-runner.test.ts#rewinds the production stable job when a late event invalidates its checkpoint generation"
        status: pass
    human_judgment: false
  - id: D2
    description: Continuous activity cannot postpone first-run or later proposal review beyond the durable hourly deadline, while quiet work is due at ten minutes.
    requirement: REQ-020
    verification:
      - kind: integration
        ref: "tests/daemon/contraction-runner.test.ts#uses the stable job's durable quiet and hourly proposal cadence under continuous activity"
        status: pass
    human_judgment: false
  - id: D3
    description: Bounded offline contraction preserves unaffected prefix identity, person and scope isolation, stable-key yielding, provenance, and proposed-only review state.
    requirement: REQ-022
    verification:
      - kind: integration
        ref: "npx vitest run tests/daemon"
        status: pass
      - kind: integration
        ref: "npm test"
        status: pass
    human_judgment: false
duration: 5min
completed: 2026-07-18
status: complete
---

# Phase 4 Plan 12: Stable-Job Rewind and Durable Proposal Cadence Summary

**Stable production jobs now rewind stale checkpoint generations from the intersecting topic span and enforce independent ten-minute quiet or hourly proposed-only review deadlines.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-07-18T16:10:00Z
- **Completed:** 2026-07-18T16:15:26Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- Made `ContractionRunner` reject stale-generation and earlier-than-processed resume state, discard its active topic, and recompute the bounded affected topic span without rebuilding the unaffected prefix.
- Advanced the durable affected window with each committed slice so the newly published same-generation checkpoint resumes cleanly across restart while generation and slice count retain separate meanings.
- Reworked `ProposalScheduler` to evaluate quiet and forced deadlines per stable dirty job from `lastActivityAt` and `lastProposalRunAt ?? createdAt`, then persist the successful run timestamp on that same job.
- Added synthetic production-job tests for complete-history late insertion, restart, repeated receipt replay, continuous activity across first and later hourly deadlines, exact quiet timing, incomplete-immediate gating, and proposed-only outputs.

## Task Commits

Git commits were intentionally not attempted. The shared execution environment exposes Git metadata read-only, `.planning/STATE.md` records that `.git/index.lock` cannot be created, and the parent explicitly required implementation without repeated commit attempts or claimed hashes.

1. **Task 1: Rewind a stable job when late history invalidates its checkpoint** - unavailable (read-only Git metadata)
2. **Task 2: Enforce quiet and hourly proposal cadence on the stable job** - unavailable (read-only Git metadata)

**Plan metadata:** unavailable (read-only Git metadata)

## Files Created/Modified

- `src/daemon/contraction-runner.ts` - Adds generation/boundary-compatible resume selection, stale-topic discard, current-generation publication, and durable affected-window progress.
- `src/daemon/proposal-scheduler.ts` - Computes quiet/forced eligibility per stable job and persists `lastProposalRunAt` independently from activity and ordinary updates.
- `tests/daemon/contraction-runner.test.ts` - Adds production-shaped stable-job late rewind/restart/replay and repeated continuous-activity cadence proofs.

## Decisions Made

- A generation match alone is insufficient for resume: the stable job's pending earliest key must also be at or after the checkpoint's processed boundary. This preserves a defensive fail-closed path if storage metadata is inconsistent.
- After an atomic slice, the job's affected window advances through the last committed canonical tuple. This prevents a successfully rewound generation from falsely invalidating its own new checkpoint on restart.
- Proposal due state is local to each complete dirty job. Clean jobs, `updatedAt`, and mutable activity cannot supply or reset another job's forced baseline.
- Only jobs that were due for the successful review drain have their proposal state cleared and their durable run time updated.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Resume loop] Advanced the durable affected window after a successful rewind**
- **Found during:** Task 1 GREEN verification
- **Issue:** Applying the required generation/boundary compatibility rule while leaving `earliestAffected` fixed at the original late event made the newly written same-generation checkpoint appear invalid again on every restart.
- **Fix:** Advanced `earliestAffected` through the last canonical tuple committed by each slice and extended `latestAffected` when necessary, without changing generation or coupling it to slice count.
- **Files modified:** `src/daemon/contraction-runner.ts`
- **Verification:** The same-job test now rewinds once, restarts from durable state, replays the same import receipt without a second generation change, and then returns complete with zero additional processing.
- **Commit:** unavailable because Git metadata is read-only

---

**Total deviations:** 1 auto-fixed (1 Rule 1 bug)
**Impact on plan:** The fix is required to make the plan's compatibility rule idempotent across restart and does not add a new schema or architectural surface.

## Issues Encountered

- The worktree was substantially dirty before execution with completed Phase 4 gap work and unrelated tracked changes. Only the three plan-owned implementation/test files and this summary were touched; nothing was cleaned, reverted, or staged.
- The TDD RED run failed exactly on the two intended gaps: the stable job returned no rewind key, and continuous activity prevented the one-hour proposal deadline. Both passed after the scoped runner changes.

## TDD Gate Compliance

- RED: the focused test selection produced 2 expected failures for same-job generation rewind and continuous-activity hourly forcing.
- GREEN: all 9 contraction-runner tests, all 83 daemon tests, and all 279 repository tests pass; TypeScript compilation is green.
- RED/GREEN commits are unavailable because Git metadata is read-only.

## Verification

- `npx vitest run tests/daemon/contraction-runner.test.ts -t "stable job|late event|rewind|checkpoint|ProposalScheduler|quiet|hour|continuous"` - 4 passed, 5 filtered.
- `npx vitest run tests/daemon/contraction-runner.test.ts` - 9 passed.
- `npx vitest run tests/daemon/daemon-store.test.ts tests/service/source-lifecycle-service.test.ts` - 24 passed.
- `npx vitest run tests/daemon` - 83 passed across 7 files.
- `npm test` - 279 passed across 47 files.
- `npm run typecheck` - passed with no diagnostics.
- `git diff --check` - passed.

## Privacy and Isolation Review

- The runner still loads canonical events for the exact requested person, verifies each event against a person-owned source and immutable scope, and fails closed on cross-person or disallowed-scope dependencies before derivation.
- Bounded rewind preserves source canonical IDs, source scopes, compatibility-turn provenance, deterministic canonical tuple order, and unchanged prefix object identity/state.
- Proposal review remains local and deterministic by default. Every newly generated proposal and box is asserted `proposed`; traces remain proposed-only, and no approval transition was added.
- Tests use only synthetic people, sources, event content, stable job IDs, injected clocks, and in-memory storage. No real history, native source, secret, client/case data, network, external model, or OS service was accessed.

## Known Stubs

None.

## Threat Flags

No unplanned threat surface was introduced. Stale checkpoint tampering, continuous-activity denial of service, proposed-only review state, and synthetic-data disclosure controls are all covered by the plan threat model and passing tests.

## Next Phase Readiness

- Plans 04-17 through 04-19 can wrap the generation-aware contraction and durable proposal paths with their planned lease-authority commits without revisiting cadence or rewind semantics.
- The parent orchestrator retains ownership of phase-level STATE/ROADMAP/requirements updates and later Git commits from a metadata-writable environment.

## Self-Check: PASSED

- All three declared implementation/test files exist, and `04-12-SUMMARY.md` exists with `status: complete`.
- The stable same-job test proves one generation transition, bounded affected-suffix processing, unchanged prefix derivations, restart, repeated import receipt replay, and unique derived IDs.
- The cadence test proves first and later hourly deadlines under continuous activity, exact ten-minute quiet eligibility, durable timestamp persistence, incomplete-immediate gating, and proposed-only outputs.
- Focused tests, the complete daemon suite, the full repository suite, typecheck, and diff hygiene all pass.
- Commit verification is intentionally unavailable and accurately documented without claiming a hash.

---
*Phase: 04-continuous-local-daemon*
*Completed: 2026-07-18*
