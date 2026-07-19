---
phase: 04-continuous-local-daemon
plan: "09"
subsystem: daemon
tags: [daemon, sqlite-lease, launchagent, macos, lifecycle, status]
requires:
  - phase: 04-continuous-local-daemon
    provides: durable daemon storage, approved-source importing, fair scheduling, sliced contraction, and review-only proposal cadence
provides:
  - Lease-owned portable daemon composition reconstructed from all persisted people and approved grants
  - Explicit run, start, stop, restart, status, and once lifecycle controls
  - Injected macOS LaunchAgent, power-state, and privacy-safe notification adapters
  - Database-authoritative daemon health integrated into memory status
affects: [phase-05-mcp, daemon-packaging, operational-status]
tech-stack:
  added: []
  patterns: [database lease as liveness authority, injected OS effects, explicit-only service enablement, bounded single-writer service rotation]
key-files:
  created:
    - src/daemon/daemon.ts
    - src/daemon/daemon-command.ts
    - src/daemon/macos/launch-agent.ts
    - src/daemon/macos/power-source.ts
    - src/daemon/macos/notification.ts
  modified:
    - src/bootstrap/status-command.ts
    - src/daemon/scheduler.ts
    - src/storage/memory-store.ts
    - src/storage/in-memory-store.ts
    - src/storage/sqlite-store.ts
    - package.json
key-decisions:
  - "The database lease token plus fresh heartbeat is the sole writer authority; PID and LaunchAgent state are supporting operational identity only."
  - "Daemon startup explicitly enumerates persisted people before reconstructing scheduler, source, contraction, proposal, and watch indexes."
  - "Only the start lifecycle command creates and bootstraps the LaunchAgent; every OS effect is injected and capability-aware."
patterns-established:
  - "Timers and watchers enqueue or wake work while one awaited loop owns all store mutations."
  - "Status and notifications expose only controlled identities, categories, counts, and timestamps."
requirements-completed: [REQ-017, REQ-018, REQ-019, REQ-020, REQ-021, REQ-022]
coverage:
  - id: D1
    description: "One lease-owned loop reconstructs every persisted person, isolates source failures, fairly services import, sliced contraction, and due review-only proposals, and supports bounded once and graceful stop."
    requirement: REQ-017
    verification:
      - kind: integration
        ref: "tests/daemon/daemon-loop.test.ts"
        status: pass
      - kind: integration
        ref: "npx vitest run tests/daemon"
        status: pass
    human_judgment: false
  - id: D2
    description: "Six lifecycle commands expose database-backed content-free health while explicit start remains the only autostart enablement path."
    requirement: REQ-021
    verification:
      - kind: unit
        ref: "tests/daemon/daemon-commands.test.ts"
        status: pass
      - kind: integration
        ref: "tests/bootstrap/bootstrap-commands.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "Deterministic LaunchAgent, power, and notification adapters degrade safely when unavailable and never require live OS mutation in tests."
    requirement: REQ-020
    verification:
      - kind: unit
        ref: "tests/daemon/macos-adapters.test.ts"
        status: pass
      - kind: other
        ref: "npm run typecheck && npm run hermes:smoke && git diff --check"
        status: pass
    human_judgment: false
duration: 9min
completed: 2026-07-17
status: complete
---

# Phase 4 Plan 09: Continuous Local Daemon Integration Summary

**A database-lease-owned, offline daemon now composes approved-source scans, bounded contraction, review-only proposals, complete lifecycle controls, and injected macOS integration without touching real histories or live OS services in tests.**

## Performance

- **Duration:** 9 min
- **Started:** 2026-07-17T20:40:32Z
- **Completed:** 2026-07-17T20:49:04Z
- **Tasks:** 3
- **Files modified:** 11

## Accomplishments

- Added a single-writer portable daemon that obtains a 10-second-heartbeat/30-second-expiry database lease, reconstructs all persisted people and approved grants, retains periodic rescans as authority, isolates source failures, and drains contraction/proposal work through bounded awaited turns.
- Added `run`, `start`, `stop`, `restart`, `status`, and `once`, with token-checked graceful stop, stale-PID protection, content-free database health, and the `memory:daemon` package entrypoint.
- Added deterministic injected macOS LaunchAgent, power, and notification adapters; only explicit `start` writes or bootstraps a plist, and all tests use temporary paths and fake command runners.

## Task Commits

Git metadata is read-only in this execution environment, so task and metadata commits could not be created (`.git/index.lock` is unavailable). All implementation and summary files remain in the shared dirty worktree for the parent orchestrator/user to commit later.

## Files Created/Modified

- `src/daemon/daemon.ts` - Lease ownership, durable reconstruction, fair work draining, once mode, heartbeat, notification episode handling, and graceful shutdown.
- `src/daemon/daemon-command.ts` - Validated six-command lifecycle surface and production dependency composition.
- `src/daemon/macos/launch-agent.ts` - Deterministic plist generation plus explicit bootstrap/bootout capability adapter.
- `src/daemon/macos/power-source.ts` - Injected `pmset` parsing with safe unknown fallback.
- `src/daemon/macos/notification.ts` - Best-effort, content-free degraded-episode notifications.
- `src/bootstrap/status-command.ts` - Shared database-derived daemon status and memory-status integration.
- `src/daemon/scheduler.ts` - Explicit person registration and incomplete contraction-slice preservation.
- `src/storage/memory-store.ts`, `src/storage/in-memory-store.ts`, `src/storage/sqlite-store.ts` - Deterministic person enumeration needed for database-only daemon reconstruction.
- `package.json` - Added exactly one `memory:daemon` script while preserving existing command scripts.

## Decisions Made

- The portable command composition uses the stable database lease ID `memory-db`; the database path selects the database while the token distinguishes the current owner.
- Explicit `once` is a bounded synchronization request that snapshots each persisted approved source once, then drains a finite number of queued derivation slices and due proposals without waiting for timers.
- Incomplete contraction slices stay pending and are requeued; successful execution is not confused with completion of the durable job.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added durable person enumeration**
- **Found during:** Task 1
- **Issue:** The scheduler correctly required explicit person IDs, but `MemoryStore` exposed no way to reconstruct every person from a reopened database.
- **Fix:** Added deterministic `listPeople()` behavior to the store contract and both backends, then registered those people before scheduler reconstruction.
- **Files modified:** `src/storage/memory-store.ts`, `src/storage/in-memory-store.ts`, `src/storage/sqlite-store.ts`, `src/daemon/scheduler.ts`
- **Verification:** Reopened-SQLite multi-person daemon-loop test and full test suite pass.
- **Commit:** unavailable because `.git/index.lock` is read-only

**2. [Rule 1 - Bug] Preserved bounded contraction jobs across partial slices**
- **Found during:** Task 1
- **Issue:** A successfully committed but incomplete two-second/250-event slice could be mistaken for completion by the scheduler.
- **Fix:** Added an explicit completion signal so successful incomplete slices remain pending while failed slices retain isolated retry state.
- **Files modified:** `src/daemon/scheduler.ts`, `src/daemon/daemon.ts`
- **Verification:** Contraction, scheduler, daemon-loop, regression, and full suites pass.
- **Commit:** unavailable because `.git/index.lock` is read-only

---

**Total deviations:** 2 auto-fixed (1 missing critical, 1 bug).  
**Impact on plan:** Both changes are required to satisfy database-only reconstruction and bounded resumable contraction; neither expands product scope.

## Issues Encountered

- The environment cannot write `.git/index.lock`, so atomic task/metadata commits were not attempted after the known constraint was confirmed. No implementation verification was affected.

## User Setup Required

None. LaunchAgent enablement remains an explicit future `npm run memory:daemon -- start --db <absolute-path>` action and was not performed during implementation or testing.

## Verification

- `npx vitest run tests/daemon/daemon-loop.test.ts tests/daemon/daemon-commands.test.ts tests/daemon/macos-adapters.test.ts` - 26 passed.
- `npx vitest run tests/daemon` - 64 passed.
- Phase 4 regression boundary - 97 passed.
- Task 3 command/bootstrap boundary - 24 passed.
- `npm test` - 260 passed across 47 files.
- `npm run typecheck` - passed.
- `npm run hermes:smoke` - passed.
- `git diff --check` - passed.

## Privacy and Isolation Checks

- Tests used only synthetic temporary histories and temporary SQLite databases.
- No real LaunchAgent domain, `launchctl`, `pmset`, `osascript`, notification, or personal history was accessed.
- Native source paths remain read-only, person IDs are reconstructed explicitly, and source/degraded status remains person-filtered and content-free.
- Proposal generation remains review-only; no box, trace, or proposal is auto-approved.

## Known Stubs

None.

## Next Phase Readiness

Phase 4 production integration is complete and verified. The host-neutral daemon and status authority are ready for the Phase 5 MCP surface; packaging enablement remains explicit and reversible.

## Self-Check: PASSED

- All five created production files exist.
- All six modified integration/storage files exist.
- The `memory:daemon` script appears exactly once.
- All declared verification commands pass.
- Commit checks are intentionally unavailable because the environment cannot create `.git/index.lock`; this is recorded above and does not change the on-disk implementation result.

---
*Phase: 04-continuous-local-daemon*
*Completed: 2026-07-17*
