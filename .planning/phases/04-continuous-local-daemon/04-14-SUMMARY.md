---
phase: 04-continuous-local-daemon
plan: "14"
subsystem: daemon
tags: [daemon, grants, watchers, sqlite-lease, heartbeat, signal-safety]
requires:
  - phase: 04-continuous-local-daemon
    provides: durable approved-source reconciliation, daemon lease storage, scheduler reconstruction, and lifecycle commands from Plans 04-09 and 04-10
provides:
  - Exact approved-grant enrollment and watcher synchronization before reconstruction and throughout daemon operation
  - Independent fail-closed lease heartbeat across long source, contraction, and proposal awaits
  - Fresh token, PID, and expiry validation immediately before SIGTERM
affects: [04-15, 04-16, 04-17, 04-18, 04-19, daemon-verification]
tech-stack:
  added: []
  patterns: [durable-grants-as-authority, advisory-exact-watch-set, independent-lease-heartbeat, fresh-token-pid-signal-boundary]
key-files:
  created: []
  modified:
    - src/daemon/daemon.ts
    - src/daemon/watch-controller.ts
    - src/daemon/scheduler.ts
    - src/daemon/daemon-command.ts
    - tests/daemon/daemon-loop.test.ts
    - tests/daemon/daemon-commands.test.ts
key-decisions:
  - "Lease renewal failure is terminal for the old loop: it latches shutdown and never reacquires or releases a replacement owner's token."
  - "Durable approved grants define both source enrollment and the exact advisory watcher set; watcher state never grants access."
  - "SIGTERM is permitted only after a newly opened database reports the same unexpired owner token and PID as the stop snapshot."
patterns-established:
  - "Stage-boundary authority: await any in-flight heartbeat and re-read the exact lease before beginning source, contraction, or proposal work."
  - "Watcher exact-set sync: preserve unchanged handles, add new approved locators, and close handles plus debounce timers for removed grants."
requirements-completed: [REQ-017, REQ-018, REQ-019, REQ-021]
coverage:
  - id: D1
    description: "Ordinary grants-only databases enroll approved sources before reconstruction and continuously converge durable state plus advisory watches to the active grant set."
    requirement: REQ-017
    verification:
      - kind: integration
        ref: "tests/daemon/daemon-loop.test.ts#reconciles an ordinary grants-only SQLite database before reconstruct and once scanning"
        status: pass
      - kind: integration
        ref: "tests/daemon/daemon-loop.test.ts#converges live grants durable source state and advisory watches to the exact active set"
        status: pass
    human_judgment: false
  - id: D2
    description: "An injected recurring heartbeat retains one fresh writer during long source, contraction, and proposal work and fails closed on turnover."
    requirement: REQ-019
    verification:
      - kind: unit
        ref: "tests/daemon/daemon-loop.test.ts#heartbeats independently while long work exceeds lease expiry"
        status: pass
      - kind: unit
        ref: "tests/daemon/daemon-loop.test.ts#latches heartbeat turnover starts no new stage and never releases the replacement lease"
        status: pass
    human_judgment: false
  - id: D3
    description: "Graceful stop reopens SQLite and signals only an unchanged fresh owner-token and PID tuple."
    requirement: REQ-021
    verification:
      - kind: integration
        ref: "tests/daemon/daemon-commands.test.ts#reopens authority immediately before signaling and rejects token PID and expiry turnover"
        status: pass
    human_judgment: false
duration: 9min
completed: 2026-07-18
status: complete
---

# Phase 04 Plan 14: Grant Enrollment and Writer Authority Summary

**Exact approved-grant reconciliation, independent lease heartbeats across long work, and fresh token/PID validation at the SIGTERM boundary**

## Performance

- **Duration:** 9 min
- **Started:** 2026-07-18T15:54:40Z
- **Completed:** 2026-07-18T16:03:03Z
- **Tasks:** 3
- **Files modified:** 6

## Accomplishments

- Daemon startup now registers persisted people, reconciles their exact approved grants before scheduler reconstruction, and synchronizes watchers from the same durable authority. Continuous turns and once mode repeat reconciliation so approval and revocation take effect without restart or manual daemon rows.
- A recurring injected timer renews the exact lease token independently of awaited source, contraction, and proposal work. Renewal loss or error latches shutdown, prevents a new stage, clears timers, and never releases another owner's lease.
- The production stop signal seam now reopens SQLite immediately before signaling and requires an unexpired lease whose owner token and PID both match the requested tuple.
- Synthetic fake-time and reopened-SQLite tests cover ordinary grants-only startup/once, live exact-set convergence, all three long-work classes, lease turnover, and token/PID/expiry signal races.

## Task Commits

Git commits were intentionally not attempted. This shared execution environment exposes Git metadata read-only, and the parent explicitly required implementation and verification on the main working tree without claiming hashes.

## Files Created/Modified

- `src/daemon/daemon.ts` - Adds pre-reconstruction/continuous grant-watch reconciliation, recurring serialized heartbeat lifecycle, lease-loss latching, and fresh stage-boundary assertions.
- `src/daemon/watch-controller.ts` - Adds exact approved-grant synchronization that preserves unchanged watchers and closes removed handles/debounce timers.
- `src/daemon/scheduler.ts` - Keeps newly reconciled, never-attempted sources immediately due instead of delaying their first scan by one cadence interval.
- `src/daemon/daemon-command.ts` - Adds the reopened-SQLite fresh token/PID/expiry check immediately before SIGTERM.
- `tests/daemon/daemon-loop.test.ts` - Proves grants-only startup/once, live grant/watch convergence, long-work heartbeat liveness, and turnover shutdown behavior.
- `tests/daemon/daemon-commands.test.ts` - Proves matching-owner signaling and safe no-op behavior for token, PID, and expiry races.

## Decisions Made

- A heartbeat miss is treated as lost authority, not an invitation to reacquire the same token. Recovery belongs to a new daemon owner reconstructing durable work.
- Watchers remain latency hints. Their exact set follows approved grants, but durable grant/state reconciliation and periodic scans remain correctness authority.
- The pre-stage lease check intentionally does not claim to prevent a stale post-await commit. Plans 04-16 through 04-19 own expected-token propagation into atomic stage and scheduler commits.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Preserved immediate first scan for newly reconciled grants**
- **Found during:** Task 1 focused integration testing
- **Issue:** Existing healthy-source cadence derived an unseen source's first due time from its enrollment timestamp, delaying startup scheduling by 60 seconds after reconciliation.
- **Fix:** `DaemonScheduler.dueAt` now respects `nextDueAt` until a source has an attempt or success timestamp; normal 60/300-second cadence remains unchanged afterward.
- **Files modified:** `src/daemon/scheduler.ts`
- **Verification:** Ordinary grants-only startup/once and the 82-test daemon suite pass.
- **Commit:** unavailable because Git metadata is read-only

---

**Total deviations:** 1 auto-fixed (1 Rule 1 bug)
**Impact on plan:** The scoped correction is required for the planned immediate enrollment behavior and introduces no new feature surface.

## Issues Encountered

- `npm run typecheck` still reports the previously documented Plan 04-11 staged-migration diagnostics in `src/daemon/contraction-runner.ts`, `src/imports/codex-importer.ts`, `tests/daemon/contraction-runner.test.ts`, the pre-existing `seedDurableWork` fixture in `tests/daemon/daemon-loop.test.ts`, and `tests/daemon/scheduler.test.ts`. These missing `generation`, `lastProposalRunAt`, and `processedThroughOrderKey` producer fields are assigned to Plan 04-15. No new 04-14 production diagnostic was introduced.
- The working tree was substantially dirty before execution with completed 04-10/04-11 and earlier phase work. All unrelated changes were preserved; the tree remains dirty afterward by design.

## Verification

- `npx vitest run tests/daemon/daemon-loop.test.ts tests/daemon/daemon-commands.test.ts` - 23 passed.
- `npx vitest run tests/daemon` - 82 passed across 7 files.
- `npx vitest run tests/daemon/scheduler.test.ts tests/daemon/daemon-store.test.ts` - 33 passed.
- `npm run hermes:smoke` - passed with `ok: true` using a temporary synthetic SQLite database.
- `npm run typecheck` - only the known 04-11-to-04-15 staged producer migration diagnostics listed above.
- `git diff --check` - passed.

## Privacy and Isolation Review

- Reconciliation enumerates persisted people and filters exact approved grants per person; revocation removes only that person's candidate state and watcher without mutating another person's state.
- Native source locators are supplied only to injected read-only watcher factories. No source file or native database write was added, and all tests use synthetic paths plus temporary SQLite databases.
- Lease and signal results remain content-free: only database ID, token comparison, PID, expiry, and controlled status are inspected; no transcript, raw process output, exception text, secret, or client/case material is persisted or returned.
- Proposal work remains review-only, and no approval, source-scope reclassification, external model, live OS signal, or live macOS service action occurs in tests.

## Known Stubs

None.

## Threat Flags

No unplanned threat surface was introduced. Database-to-stage writer authority, grant-to-watcher synchronization, and status-to-OS-signal validation are all explicitly covered by the plan threat model and synthetic tests.

## Next Phase Readiness

- Plans 04-16 through 04-19 can now carry the fresh owner token into each atomic import, contraction, proposal, and scheduler commit while relying on independent liveness renewal.
- Plan 04-15 still owns producer migration for the durable generation/proposal timestamp/checkpoint fields and repository-wide typecheck restoration.
- The parent orchestrator retains ownership of phase-level STATE/ROADMAP/requirements updates and any later Git commits from a metadata-writable environment.

## Self-Check: PASSED

- All six implementation/test files and `04-14-SUMMARY.md` exist on disk.
- The summary declares `status: complete` and records the exact verification outcomes.
- Focused plan tests, the full daemon suite, store/scheduler regressions, Hermes smoke, and diff hygiene were rechecked successfully.
- Commit verification is intentionally unavailable because Git metadata is read-only; no hash is claimed.

---

*Phase: 04-continuous-local-daemon*
*Completed: 2026-07-18*
