---
phase: 04-continuous-local-daemon
plan: "19"
subsystem: daemon
tags: [daemon, lease-authority, scheduler, turnover, sqlite, exactly-once]
requires:
  - phase: 04-continuous-local-daemon
    provides: atomic authority-guarded daemon commits from Plan 04-16 and guarded source, contraction, and proposal stages from Plans 04-17 and 04-18
provides:
  - Lease-guarded reconciliation, due refresh, health, degradation latch, notification, and contraction-job outcomes
  - Immutable daemon authority propagation through every source, contraction, proposal, and scheduler boundary
  - Fail-closed old-owner shutdown with replacement-owner durable reconstruction and one-time replay
affects: [phase-04-verification, daemon-runtime, scheduler, source-health]
tech-stack:
  added: []
  patterns: [captured-authority-tuple, commit-before-ephemeral-state, fail-closed-lease-loss, durable-reconstruction]
key-files:
  created: []
  modified:
    - src/daemon/daemon.ts
    - src/daemon/scheduler.ts
    - src/daemon/source-state.ts
    - src/daemon/daemon-command.ts
    - tests/daemon/daemon-loop.test.ts
    - tests/daemon/scheduler.test.ts
key-decisions:
  - "Scheduler and source-state components require daemon authority at construction and use only Plan 04-16 atomic commit contracts for durable bookkeeping."
  - "Ephemeral in-flight state and notifications advance only after the guarded durable outcome succeeds; rejection leaves work reconstructable."
  - "DaemonLoop freezes one databaseId/ownerToken tuple per stage and treats any guarded publication rejection as terminal lease loss without releasing a replacement token."
patterns-established:
  - "Commit-before-ephemeral: source/job outcome publication succeeds atomically before in-flight removal or notification delivery."
  - "Turnover recovery: old-owner rejection closes timers/watchers; a fresh scheduler rebuilds runnable work exclusively from durable person-owned records."
requirements-completed: [REQ-017, REQ-018, REQ-019, REQ-021]
coverage:
  - id: D1
    description: "All scheduler reconciliation, cadence, source-health, degradation-latch, notification, and work-outcome mutations require fresh daemon authority."
    requirement: REQ-021
    verification:
      - kind: integration
        ref: "tests/daemon/scheduler.test.ts#rejects stale source completion without durable or ephemeral turnover mutation and replays under the replacement owner"
        status: pass
      - kind: unit
        ref: "tests/daemon/scheduler.test.ts#guards reconciliation next-due refresh contraction outcome and foreground authority"
        status: pass
    human_judgment: false
  - id: D2
    description: "Source, contraction, and proposal work carry one immutable authority tuple and shut down with zero old-owner mutation after turnover."
    requirement: REQ-019
    verification:
      - kind: e2e
        ref: "tests/daemon/daemon-loop.test.ts#carries one immutable authority tuple through work-class turnover and replacement replay"
        status: pass
    human_judgment: false
  - id: D3
    description: "Replacement owners reconstruct abandoned work and apply each source, contraction, or proposal class once without cross-person or provenance drift."
    requirement: REQ-018
    verification:
      - kind: integration
        ref: "npx vitest run tests/daemon"
        status: pass
      - kind: integration
        ref: "npm test"
        status: pass
    human_judgment: false
duration: 12min
completed: 2026-07-18
status: complete
---

# Phase 04 Plan 19: End-to-End Lease Turnover Summary

**Immutable daemon authority now governs every stage and scheduler outcome, so stale owners make zero bookkeeping or side-effect progress while replacement owners reconstruct and replay abandoned work once.**

## Performance

- **Duration:** 12 min
- **Started:** 2026-07-18T16:52:00Z
- **Completed:** 2026-07-18T17:04:14Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments

- Replaced unguarded source-state reconciliation, cadence refresh, success/failure/degradation transitions, notification latches, and contraction job completion with the atomic authority contracts introduced by Plan 04-16.
- Captured and propagated the exact frozen daemon database/token tuple into source, contraction, proposal, and scheduler boundaries; any guarded rejection now latches lease loss, clears timers/watchers, starts no follow-on work, and never releases another owner's lease.
- Added synthetic turnover coverage for reconciliation, due timing, source success/failure/degradation, notification suppression, contraction outcomes, all three end-to-end work classes, foreground rejection, and replacement-owner replay.
- Preserved 60/300-second safety cadence, bounded retry/degradation behavior, fair single-writer scheduling, review-only proposals, person/scope/provenance isolation, and read-only native source access.

## Task Commits

Git commits were intentionally not attempted. The shared main working tree exposes Git metadata read-only, and the parent explicitly required preserving all dirty work without retries or claimed hashes.

1. **Task 1: Guard scheduler outcome and runnable-state mutations** - unavailable (read-only Git metadata)
2. **Task 2: Prove end-to-end turnover for every work class** - unavailable (read-only Git metadata)

**Plan metadata:** unavailable (read-only Git metadata)

## Files Created/Modified

- `src/daemon/scheduler.ts` - Requires daemon authority and atomically commits reconciliation, cadence, health, notification-latch, and contraction-job outcomes before ephemeral completion.
- `src/daemon/source-state.ts` - Computes proposed source state without mutation and publishes reconciliation/success/failure/degradation through guarded compare-and-set contracts.
- `src/daemon/daemon.ts` - Freezes stage authority, passes it through every runner, latches rejected publications as lease loss, and closes runtime resources without releasing replacement authority.
- `src/daemon/daemon-command.ts` - Composes each production runner from the exact authority captured by the loop rather than relying on an implicit or optional writer context.
- `tests/daemon/scheduler.test.ts` - Covers stale source/job outcomes, health/degradation notification suppression, reconciliation/due refresh, foreground rejection, and owner-B replay.
- `tests/daemon/daemon-loop.test.ts` - Covers immutable authority propagation and zero-mutation turnover/reconstruction across source, contraction, and proposal work.

## Decisions Made

- Kept authority immutable and explicit at the daemon composition boundary. Foreground compatibility remains limited to the pre-existing named import/bootstrap branches and is rejected by scheduler/source-state contracts.
- Kept notifier delivery after durable source-outcome acceptance. A rejected owner cannot emit a degraded notification, and the durable latch remains the single episode authority.
- Treated guarded commit rejection as terminal for the current loop. Recovery belongs to a fresh owner reconstructing SQLite state, never to token reacquisition inside the stale process.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Updated production daemon command composition for per-stage captured authority**
- **Found during:** Task 2 typecheck
- **Issue:** `daemon-command.ts` constructed long-lived runners with a closure-level token, so the new loop contract could not prove that the tuple captured for each selected item was the tuple consumed by the runner.
- **Fix:** The command now creates source, contraction, and proposal runner calls from the exact authority argument supplied by `DaemonLoop`.
- **Files modified:** `src/daemon/daemon-command.ts`
- **Verification:** Global typecheck, 108 daemon tests, and Hermes smoke pass.
- **Commit:** unavailable because Git metadata is read-only

---

**Total deviations:** 1 auto-fixed (1 Rule 3 blocking composition fix)
**Impact on plan:** The change is required to complete the planned end-to-end authority link and adds no new product or external-service surface.

## Issues Encountered

- Existing fake-time loop stores initially used their real-time backend authority clock, making synthetic leases appear expired after scheduler commits became guarded. Tests were corrected to inject the same fake clock into in-memory and reopened SQLite stores, matching the Plan 04-16 authoritative-clock contract.
- The working tree was substantially dirty before execution with all prior Phase 4 plans and earlier project work. No unrelated file was cleaned, reverted, staged, or committed; the tree remains dirty by design.

## TDD Gate Compliance

- RED: the new stale source completion test resolved successfully under token A after owner B had taken over, proving the unguarded write.
- GREEN: the scheduler test rejected owner A, preserved byte-equivalent state and in-flight bookkeeping, and owner B reconstructed and completed the item.
- End-to-end expansion then covered source, contraction, and proposal turnover plus the complete scheduler mutation matrix.
- RED/GREEN commits are unavailable because Git metadata is read-only; no hash is claimed.

## Verification

- `npx vitest run tests/daemon/scheduler.test.ts -t "authority|turnover|complete|failure|nextDue|health|reconciliation"` - 6 focused tests passed.
- `npx vitest run tests/daemon/daemon-loop.test.ts tests/daemon/scheduler.test.ts tests/daemon/source-runner.test.ts tests/daemon/contraction-runner.test.ts tests/daemon/proposal-scheduler.test.ts` - 58 tests passed.
- `npx vitest run tests/daemon` - 108 tests passed across 8 files.
- `npm test` - 306 tests passed across 48 files.
- `npm run typecheck` - passed.
- `npm run hermes:smoke` - passed with `ok: true` against a temporary synthetic SQLite database.
- `git diff --check` - passed.

## Privacy and Isolation Review

- Every source state, job, checkpoint, canonical event, summary, box, proposal, and trace assertion remains filtered by exact `personId`; synthetic multi-person coverage continues to pass.
- Source locators remain read-only inputs to approved importers. No native source write, real history read, live watcher path, external model, network call, or live macOS action was added to deterministic tests.
- Scheduler health state and notification payloads remain content-free and controlled; raw errors, transcripts, paths, model output, secrets, API keys, and client/case documents are not persisted.
- Scope IDs and canonical provenance are unchanged through turnover. Proposals remain `proposed` and require the existing human approval workflow; no auto-approval path was introduced.

## Known Stubs

None.

## Threat Flags

No unplanned threat surface was introduced. Writer-authority propagation and scheduler outcome publication are the two explicit trust boundaries in the Plan 04-19 threat model, and both now have deterministic turnover coverage.

## Next Phase Readiness

- Plan 04-19 closes the remaining old-owner scheduler/bookkeeping gap for all daemon work classes.
- Phase-level verification can now re-evaluate REQ-017, REQ-018, REQ-019, and REQ-021 against the complete 108-test daemon suite and 306-test repository suite.
- The parent orchestrator retains ownership of STATE/ROADMAP/requirements updates and any later Git commit from a metadata-writable environment.

## Self-Check: PASSED

- All six implementation/test files and `04-19-SUMMARY.md` exist on disk.
- The summary declares `status: complete`, includes all Plan 04-19 requirements, and records exact automated verification results.
- Focused turnover tests, full daemon tests, the full repository suite, typecheck, Hermes smoke, and diff hygiene all pass.
- Commit verification is intentionally unavailable because Git metadata is read-only; no hash is claimed.

---

*Phase: 04-continuous-local-daemon*
*Completed: 2026-07-18*
