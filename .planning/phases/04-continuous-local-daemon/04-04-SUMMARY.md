---
phase: 04-continuous-local-daemon
plan: "04"
subsystem: testing
tags: [vitest, daemon, lifecycle, launchagent, macos, sqlite]

requires:
  - phase: 03-source-lifecycle-control-plane
    provides: durable grants, person ownership, scope boundaries, and read-only source rules
provides:
  - Synthetic integration contracts for lease-owned daemon reconstruction and graceful shutdown
  - Test contracts for run, start, stop, restart, status, and once lifecycle controls
  - Injected macOS LaunchAgent, power-state, and privacy-safe notification contracts
affects: [04-05, 04-07, 04-09, continuous-local-daemon]

tech-stack:
  added: []
  patterns: [expected-red-wave-zero-tests, injected-os-capabilities, temporary-sqlite-recovery]

key-files:
  created:
    - tests/daemon/daemon-loop.test.ts
    - tests/daemon/daemon-commands.test.ts
    - tests/daemon/macos-adapters.test.ts
  modified: []

key-decisions:
  - "Treat lease token plus fresh heartbeat as writer and process authority; PID alone remains supporting identity."
  - "Keep every macOS effect behind injected command and filesystem seams, with only explicit start enabling the LaunchAgent."
  - "Wave 0 verification is intentionally RED until the Wave 3 production composition lands."

patterns-established:
  - "Lifecycle tests exercise exported parsers and command services instead of process globals."
  - "OS adapter tests use temporary paths and FakeCommandRunner exclusively."

requirements-completed: [REQ-017, REQ-018, REQ-019, REQ-020, REQ-021, REQ-022]

coverage:
  - id: D1
    description: "Daemon reconstruction, lease exclusion, rescan recovery, source isolation, once, and graceful-stop contracts are executable."
    requirement: REQ-017
    verification:
      - kind: integration
        ref: "tests/daemon/daemon-loop.test.ts (expected RED until src/daemon/daemon.ts exists)"
        status: pass
    human_judgment: false
  - id: D2
    description: "All six lifecycle commands have validation, ordering, stale-PID, status, and content-free result contracts."
    requirement: REQ-021
    verification:
      - kind: unit
        ref: "tests/daemon/daemon-commands.test.ts (expected RED until src/daemon/daemon-command.ts exists)"
        status: pass
    human_judgment: false
  - id: D3
    description: "LaunchAgent, power, and notification behavior is specified without live OS mutation."
    requirement: REQ-018
    verification:
      - kind: unit
        ref: "tests/daemon/macos-adapters.test.ts (expected RED until macOS adapters exist)"
        status: pass
    human_judgment: false

duration: 9min
completed: 2026-07-17
status: complete
---

# Phase 4 Plan 04: Daemon Integration and macOS Contract Summary

**Synthetic Vitest contracts now pin the portable loop, lifecycle CLI, and injected macOS capability boundaries before their production implementation wave.**

## Performance

- **Duration:** 9 min
- **Started:** 2026-07-17T19:29:00Z
- **Completed:** 2026-07-17T19:38:26Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- Specified database-only daemon reconstruction, fresh/stale lease behavior, multi-person failure isolation, safety-rescan recovery, bounded once execution, and graceful release.
- Specified Zod-facing command parsing and orchestration for all six lifecycle controls, including explicit-only autostart and stale-PID protection.
- Specified deterministic LaunchAgent plist generation, injected launchctl/pmset/osascript calls, capability absence, conservative unknown power, and content-free notifications.

## Task Commits

Git commits are unavailable in this execution environment because `.git/index.lock` is not writable. No staging or repeated commit attempt was performed.

1. **Task 1: Specify portable loop reconstruction and shutdown** - uncommitted environment-limited change
2. **Task 2: Specify lifecycle command and macOS capability boundaries** - uncommitted environment-limited change

## Files Created/Modified

- `tests/daemon/daemon-loop.test.ts` - Portable daemon composition and recovery contracts.
- `tests/daemon/daemon-commands.test.ts` - Lifecycle parser, result, ordering, and stale-process contracts.
- `tests/daemon/macos-adapters.test.ts` - Deterministic injected macOS adapter contracts.

## Decisions Made

- `--person` is a status-only filter because the database daemon schedules every persisted person.
- The power adapter maps absent or malformed `pmset` output to `unknown`; the portable scheduler owns the conservative 60-second cadence.
- Notifications accept only controlled episode fields and remain best effort; persisted source state owns de-duplication.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- The focused suite is intentionally RED at module loading because `src/daemon/daemon.ts`, `src/daemon/daemon-command.ts`, and the macOS adapters are Wave 3 outputs. Vitest reported exactly those missing implementation modules and did not touch real history or OS services.
- Git metadata is read-only in this environment, so atomic task and metadata commits must be created later from a git-writable session.

## TDD Gate Compliance

- RED gate: satisfied by the focused suite failing only on the intentionally absent Wave 3 production modules.
- RED commits: unavailable because `.git/index.lock` is read-only in this environment.
- GREEN gate: intentionally deferred to Plan 04-09, which implements the modules specified by these Wave 0 contracts.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Wave 1 and Wave 2 can establish the durable store and component APIs against the shared daemon fixtures.
- Plan 04-09 has complete integration contracts to turn GREEN without broadening source or OS access.

## Self-Check: PASSED

- All three declared test artifacts exist.
- `git diff --check` passed for all created files.
- The focused Vitest command produced the expected RED state solely because the planned production modules do not yet exist.
- No raw personal history, live macOS command, LaunchAgent path, or notification side effect was used.

---
*Phase: 04-continuous-local-daemon*
*Completed: 2026-07-17*
