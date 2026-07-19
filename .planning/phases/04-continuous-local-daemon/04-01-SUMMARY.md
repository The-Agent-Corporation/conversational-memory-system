---
phase: 04-continuous-local-daemon
plan: "01"
subsystem: testing
tags: [vitest, sqlite, daemon, crash-recovery, source-grants]
requires:
  - phase: 03-source-lifecycle-control-plane
    provides: Durable person-owned source grants, import checkpoints, canonical events, and retrieval-scope isolation
provides:
  - Deterministic fake clock, timer, watcher, power, notification, command, and fault-boundary seams
  - Temporary synthetic approved-history builders for Codex, Claude Code, OpenClaw, and Hermes
  - Executable RED contracts for durable lease CAS, atomic import/contraction commits, restart recovery, and person isolation
affects: [04-05-durable-daemon-storage, daemon-runtime, continuous-import, contraction]
tech-stack:
  added: []
  patterns: [synthetic-only daemon fixtures, explicit fake time, backend-equivalent storage contracts]
key-files:
  created:
    - tests/daemon/fixtures.ts
    - tests/daemon/daemon-store.test.ts
  modified: []
key-decisions:
  - "Wave 0 deliberately leaves storage-contract assertions RED until Plan 04-05 supplies the daemon schemas and MemoryStore methods."
  - "Fault boundaries are named and injected through store construction so crash tests never depend on process termination or wall-clock sleeps."
patterns-established:
  - "Daemon tests use temporary synthetic source roots only and never resolve real agent-history locations."
  - "The same observable contract runs against InMemoryStore and SqliteStore, with SQLite receiving an additional close/reopen proof."
requirements-completed: [REQ-019, REQ-021]
coverage:
  - id: D1
    description: Deterministic local daemon fakes and four temporary approved source builders
    requirement: REQ-019
    verification:
      - kind: unit
        ref: tests/daemon/daemon-store.test.ts#deterministic daemon fixtures
        status: pass
    human_judgment: false
  - id: D2
    description: RED contract for lease ownership and durable restart reconstruction
    requirement: REQ-021
    verification:
      - kind: integration
        ref: tests/daemon/daemon-store.test.ts#daemon durable-store contract
        status: fail
    human_judgment: true
    rationale: "Intentional Wave 0 RED contract; Plan 04-05 must implement the missing daemon store methods."
  - id: D3
    description: RED contract for grant-checked atomic import and contraction commits
    requirement: REQ-019
    verification:
      - kind: integration
        ref: tests/daemon/daemon-store.test.ts#daemon durable-store contract
        status: fail
    human_judgment: true
    rationale: "Intentional Wave 0 RED contract; Plan 04-05 must make these tests pass."
duration: 7min
completed: 2026-07-17
status: complete
---

# Phase 4 Plan 1: Durable Daemon Test Contract Summary

**Deterministic synthetic daemon fixtures and backend-equivalent RED contracts now pin lease, atomic stage, restart, and person-isolation semantics before storage implementation.**

## Performance

- **Duration:** 7 min
- **Started:** 2026-07-17T19:12:40Z
- **Completed:** 2026-07-17T19:19:40Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Added explicit fake time, timers, watchers, power, notification, command, and fault boundaries without wall-clock sleeps or live OS calls.
- Added synthetic approved source builders for Codex, Claude Code, OpenClaw, and Hermes under temporary roots with cleanup support.
- Established the executable storage contract for lease CAS/expiry, exact-grant validation, atomic imports and contraction, crash rollback, idempotency, close/reopen recovery, and person isolation.

## Task Commits

Git commits are unavailable because this execution environment cannot create `.git/index.lock`.

1. **Task 1: Build deterministic daemon fixtures** - `unavailable (read-only .git/index.lock)`
2. **Task 2: Specify atomic durable daemon storage** - `unavailable (read-only .git/index.lock)`

**Plan metadata:** `unavailable (read-only .git/index.lock)`

## Files Created/Modified

- `tests/daemon/fixtures.ts` - Deterministic runtime fakes, fault injection, synthetic four-source histories, grants, cleanup, and persisted-state normalization.
- `tests/daemon/daemon-store.test.ts` - Shared in-memory/SQLite durable-state contract and SQLite restart proof.

## Decisions Made

- Kept the Wave 0 storage suite intentionally RED only at missing Phase 4 store methods; fixture behavior itself passes.
- Used controlled named fault boundaries and synthetic temp stores instead of real process crashes, OS commands, notifications, or personal-history locations.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- The planned verification reports 2 passing fixture tests and 11 intentional RED storage-contract failures. Every failure is a missing Phase 4 MemoryStore method (`acquireDaemonLease`, `commitImportBatch`, `getDaemonLease`, and related APIs), not fixture nondeterminism or real OS/history access.
- Per-task and metadata commits could not be created because `.git/index.lock` is read-only in this environment.

## TDD Gate Compliance

- RED gate: PASS — `npx vitest run tests/daemon/daemon-store.test.ts` fails only on the deliberately absent daemon storage contracts.
- RED commit: unavailable because `.git/index.lock` is read-only.
- GREEN gate: deferred to Plan 04-05 by this Wave 0 test-contract plan.

## User Setup Required

None - no external services or real history access are required.

## Next Phase Readiness

- Plan 04-05 can implement the exact daemon schemas and MemoryStore methods exercised by this contract.
- The privacy boundary remains intact: all source fixtures are temporary and synthetic, native histories are never modified, and no external model is involved.

## Self-Check: PASSED

- FOUND: `tests/daemon/fixtures.ts`
- FOUND: `tests/daemon/daemon-store.test.ts`
- PASS: `git diff --check -- tests/daemon/fixtures.ts tests/daemon/daemon-store.test.ts`
- EXPECTED RED: 2 fixture tests pass; 11 storage-contract tests fail on missing Phase 4 APIs.
- Commits: unavailable due to read-only `.git/index.lock`, accurately recorded above.

---
*Phase: 04-continuous-local-daemon*
*Completed: 2026-07-17*
