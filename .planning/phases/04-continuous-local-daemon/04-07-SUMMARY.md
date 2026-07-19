---
phase: 04-continuous-local-daemon
plan: "07"
subsystem: infra
tags: [scheduler, watchers, backoff, source-health, privacy]
requires:
  - phase: 04-continuous-local-daemon
    provides: Wave 0 scheduling contract and durable daemon source/job state
provides:
  - Portable injected clock, timer, watcher, power, notification, command, and signal contracts
  - Two-second per-person/source watch coalescing with periodic rescans retained as authority
  - Starvation-bounded single-writer scheduling with 60/300-second power cadence
  - Content-free source-local retry and degradation episodes with one notification latch
affects: [04-09-daemon-loop, daemon-status, macos-adapters]
tech-stack:
  added: []
  patterns: [injected runtime effects, durable-authority ephemeral indexes, prompt-burst then due-round-robin, fail-closed person keys]
key-files:
  created:
    - src/daemon/runtime-adapters.ts
    - src/daemon/watch-controller.ts
    - src/daemon/source-state.ts
    - src/daemon/scheduler.ts
  modified:
    - src/daemon/types.ts
    - tests/daemon/scheduler.test.ts
key-decisions:
  - "DaemonScheduler requires explicit personIds for durable reconstruction; watch hints can register a person later without introducing a synthetic production identity."
  - "A healthy source's safety due time is derived from last success plus the current 60/300-second power cadence, while retrying/degraded sources retain their persisted backoff deadline."
  - "Notification adapters are best-effort and receive only generic copy plus the approved candidate identity; adapter failures never stop synchronization."
patterns-established:
  - "Watch callbacks only enqueue one coalesced person/candidate hint and never access storage."
  - "All source-state lookups are person-filtered before candidate matching, and contraction completion revalidates job ownership."
requirements-completed: [REQ-017, REQ-018, REQ-021]
coverage:
  - id: D1
    description: "Watch bursts coalesce at exactly two fake seconds while unsupported or lost watches leave durable periodic rescans authoritative."
    requirement: REQ-018
    verification:
      - kind: unit
        ref: "tests/daemon/scheduler.test.ts#WatchController"
        status: pass
    human_judgment: false
  - id: D2
    description: "One prompt item is followed by due round-robin service across sources and contraction, with 60-second external/unknown and 300-second battery cadence."
    requirement: REQ-018
    verification:
      - kind: unit
        ref: "tests/daemon/scheduler.test.ts#DaemonScheduler"
        status: pass
    human_judgment: false
  - id: D3
    description: "Retries cap at 60 seconds, reset after success, degrade at failure three or fifteen minutes, and persist one content-free notification latch per episode."
    requirement: REQ-021
    verification:
      - kind: unit
        ref: "tests/daemon/scheduler.test.ts#SourceStateMachine"
        status: pass
    human_judgment: false
duration: 6min
completed: 2026-07-17
status: complete
---

# Phase 4 Plan 07: Portable Scheduling and Source Health Summary

**Injected watch acceleration, power-aware durable rescans, starvation-bounded scheduling, and privacy-safe source recovery now form the portable daemon queue.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-07-17T19:59:00Z
- **Completed:** 2026-07-17T20:04:44Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments

- Added host-neutral runtime interfaces and a watch controller that coalesces a source burst once at 2,000 ms, closes all handles/timers on shutdown, and degrades cleanly to periodic rescans.
- Added a durable-state scheduler that reconstructs ephemeral queues, promotes watch hints, deduplicates by person/candidate/stage, alternates bounded prompt work with due round-robin work, and honors 60/300-second power cadence.
- Added source-local retry and degradation episodes with exact 5/10/20/40/60-second backoff, fifteen-minute/third-failure degradation, reset-on-success, content-free state, and one best-effort notification per episode.

## Task Commits

Git commits are unavailable because this execution environment cannot create `.git/index.lock`; staging and repeated commit attempts were intentionally skipped.

1. **Task 1: Implement injected runtime and watch coalescing** - `unavailable (read-only .git/index.lock)`
2. **Task 2: Implement fair durable scheduling and failure episodes** - `unavailable (read-only .git/index.lock)`

**Plan metadata:** `unavailable (read-only .git/index.lock)`

## Files Created/Modified

- `src/daemon/runtime-adapters.ts` - Portable clock, timer, watcher, power, notification, command, and signal interfaces.
- `src/daemon/watch-controller.ts` - Per-person/candidate leading-window burst coalescing and advisory capability tracking.
- `src/daemon/source-state.ts` - Durable bounded retry, degradation, success reset, and notification-latch state machine.
- `src/daemon/scheduler.ts` - Power-aware reconstruction, prompt promotion, due round-robin fairness, deduplication, and source-local completion.
- `src/daemon/types.ts` - Shared discriminated `DaemonWorkItem` type required by the Wave 0 contract.
- `tests/daemon/scheduler.test.ts` - Fail-closed grant seeding and corrected finite-service measurement.

## Decisions Made

- Reconstruction takes explicit person IDs rather than embedding the synthetic fixture identity or guessing ownership from shared storage.
- Healthy cadence follows current power state from the last successful scan; retry cadence always follows the durable bounded backoff deadline.
- Notification delivery is best-effort after the durable episode latch is written, so desktop notification failure cannot affect synchronization correctness.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added the shared scheduler work-item contract**
- **Found during:** Task 2 compile verification
- **Issue:** The Wave 0 test imports `DaemonWorkItem` from `src/daemon/types.ts`, but Plan 04-05 had not created that export.
- **Fix:** Added a discriminated source-scan/contraction union with impossible opposite identifiers represented as optional `never` fields for safe narrowing.
- **Files modified:** `src/daemon/types.ts`
- **Verification:** Strict targeted TypeScript compile passes.
- **Committed in:** unavailable due to read-only `.git/index.lock`

**2. [Rule 1 - Contract Bug] Seeded the exact durable grant before daemon source state**
- **Found during:** Task 2 GREEN run
- **Issue:** The Wave 0 helper attempted to save daemon source state without a grant, contradicting Plan 04-05's fail-closed grant ownership invariant.
- **Fix:** The synthetic helper now saves a matching approved grant before its content-free source state.
- **Files modified:** `tests/daemon/scheduler.test.ts`
- **Verification:** All nine scheduler tests pass without weakening store validation.
- **Committed in:** unavailable due to read-only `.git/index.lock`

**3. [Rule 1 - Contract Bug] Corrected the finite-service gap helper**
- **Found during:** Task 2 fairness verification
- **Issue:** A source served once within the bounded eight-item window was reported as an eight-item gap, incorrectly requiring a second scan even though fake time never advanced another cadence interval.
- **Fix:** Gap measurement now includes the initial and trailing observation windows and still fails when a source is never served.
- **Files modified:** `tests/daemon/scheduler.test.ts`
- **Verification:** Prompt priority, all three sources, and contraction appear within the asserted finite service bound.
- **Committed in:** unavailable due to read-only `.git/index.lock`

---

**Total deviations:** 3 auto-fixed (2 contract bugs, 1 blocking type contract).
**Impact on plan:** All changes are necessary to preserve the approved-grant boundary and accurately test the locked scheduling behavior; no product scope expanded.

## Issues Encountered

- Full-project `npm run typecheck` still reports only Phase 4 implementation modules assigned to Plans 04-08 and 04-09 as absent, plus their consequent contextual-any errors. A strict targeted compile of every 04-07 production/test file passes.
- The complete `tests/daemon` run has 30 passing tests in the implemented 04-05 through 04-07 surfaces and four expected module-resolution failures for 04-08/04-09 files not yet present.
- Git metadata remains read-only, so atomic task and summary commits could not be created.

## Privacy and Isolation Checks

- Durable health receives only controlled `DaemonErrorCategory`, approved person/grant/candidate/scope identities, counts, and timestamps; the accepted cause object is never inspected or persisted.
- Notification input contains generic copy and candidate identity only, with no category, exception text, source path, or conversation content.
- Source state is looked up inside a person-filtered result and contraction completion rejects cross-person job ownership.
- Portable modules contain no macOS paths, commands, live filesystem implementation, real histories, wall-clock sleeps, model calls, or network access.

## Known Stubs

None.

## User Setup Required

None - no external service, model, live watcher, notification, or personal-history access is required.

## Next Phase Readiness

- Plan 04-09 can supply the database's configured person IDs to `DaemonScheduler`, connect `WatchController` enqueue callbacks, and consume one work item at a time under the writer lease.
- Power and notification macOS adapters can implement the portable interfaces without entering the scheduler or storage modules.
- Full typecheck and the complete daemon suite should be rerun once the remaining Phase 4 files exist.

## Self-Check: PASSED

- FOUND: `src/daemon/runtime-adapters.ts`
- FOUND: `src/daemon/watch-controller.ts`
- FOUND: `src/daemon/source-state.ts`
- FOUND: `src/daemon/scheduler.ts`
- PASS: `npx vitest run tests/daemon/scheduler.test.ts` (9/9).
- PASS: strict targeted TypeScript compile of all 04-07 source/test files.
- PASS: `git diff --check`.
- PASS: privacy/platform-path/stub scans of all four portable modules.
- EXPECTED PHASE-IN-PROGRESS BLOCKER: remaining 04-08/04-09 modules are not yet present for full-project typecheck/full daemon collection.
- Commits: unavailable due to read-only `.git/index.lock`, accurately recorded above.

---
*Phase: 04-continuous-local-daemon*
*Completed: 2026-07-17*
