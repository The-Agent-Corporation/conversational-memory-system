---
phase: 04-continuous-local-daemon
plan: "02"
subsystem: testing
tags: [vitest, daemon, importers, scheduler, privacy, tdd]

requires:
  - phase: 03-source-lifecycle-control-plane
    provides: durable grants, revocation, parser quarantine, and person/scope boundaries
provides:
  - RED contract for exact approved-source dispatch and incremental importer behavior
  - RED contract for watcher debounce, cadence, fairness, retry, degradation, and privacy-safe health
affects: [04-06-approved-source-runner, 04-07-daemon-scheduler]

tech-stack:
  added: []
  patterns: [synthetic-history-only tests, injected fake time, expected RED Wave 0 contracts]

key-files:
  created:
    - tests/daemon/source-runner.test.ts
    - tests/daemon/scheduler.test.ts
  modified: []

key-decisions:
  - "ImportBatchReceipt canonicalEventIds and canonicalOrderKeys contain only new or materially changed events; a no-op scan returns empty arrays."
  - "One prompt job may run before the scheduler must serve a due round-robin source or contraction item."
  - "Durable health and notifications accept controlled categories and identities only; thrown text and source content are excluded."

patterns-established:
  - "Wave 0 RED contracts import future production seams directly and may fail only because those modules do not yet exist."
  - "All daemon timing assertions use FakeDaemonClock and injected adapters; no wall-clock sleeps or live OS calls."

requirements-completed: [REQ-017, REQ-018, REQ-019]

coverage:
  - id: D1
    description: "Approved-source contract covers all four exact formats, reapproval prohibition, revocation boundaries, idempotency, partial records, rotation, high-water marks, exclusions, failure isolation, and native-store immutability."
    requirement: REQ-017
    verification:
      - kind: other
        ref: "TypeScript transpileModule syntax check for tests/daemon/source-runner.test.ts"
        status: pass
      - kind: unit
        ref: "npx vitest run tests/daemon/source-runner.test.ts (expected RED: approved-source-runner production module absent)"
        status: unknown
    human_judgment: true
    rationale: "This is an intentional Wave 0 RED contract; behavioral proof becomes automated after Plan 04-06 supplies production code."
  - id: D2
    description: "Scheduler contract covers two-second debounce, 60/300-second rescans, battery restoration, bounded prompt priority, fairness, retry cap/reset, degradation, notification latching, and content-free health."
    requirement: REQ-018
    verification:
      - kind: other
        ref: "TypeScript transpileModule syntax check for tests/daemon/scheduler.test.ts"
        status: pass
      - kind: unit
        ref: "npx vitest run tests/daemon/scheduler.test.ts (expected RED: scheduler production module absent)"
        status: unknown
    human_judgment: true
    rationale: "This is an intentional Wave 0 RED contract; behavioral proof becomes automated after Plan 04-07 supplies production code."

duration: 6min
completed: 2026-07-17
status: complete
---

# Phase 4 Plan 02: Approved Source and Scheduler Contracts Summary

**Seventeen synthetic, deterministic RED tests now define daemon-safe source execution and starvation-bounded scheduling without reading real histories or invoking live operating-system integrations.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-07-17T19:21:40Z
- **Completed:** 2026-07-17T19:27:30Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Added eight approved-source tests spanning exact four-format dispatch, no background approval, both revocation boundaries, append/no-op convergence, partial JSONL, rotation/truncation, Hermes high-water behavior, temporary absence, tool-result exclusion, and read-only source hashes.
- Added nine scheduler/source-state tests spanning exact debounce and power cadence, watcher-independent correctness, prompt/due fairness including contraction, deduplication, bounded retry, degradation episodes, notification latching, content-free persistence, and per-source failure isolation.
- Kept every fixture synthetic and temporary; the tests contain no real personal-history paths, content, OS mutation, or external-model dependency.

## Task Commits

Git commits are unavailable in this environment because `.git/index.lock` is read-only. No staging or commit was attempted.

1. **Task 1: Specify approved-source incremental execution** - `unavailable (read-only .git/index.lock)`
2. **Task 2: Specify scheduling, backoff, and privacy-safe health** - `unavailable (read-only .git/index.lock)`

## Files Created/Modified

- `tests/daemon/source-runner.test.ts` - Approved-grant dispatch, importer edge cases, revocation, idempotency, isolation, exclusions, and native-source immutability contract.
- `tests/daemon/scheduler.test.ts` - Watch, cadence, fairness, retry, health episode, notification, and failure-isolation contract under fake time.

## Decisions Made

- Reused the `ImportBatchReceipt` field names established by Plan 04-01 (`canonicalEventIds`, `canonicalOrderKeys`, and `checkpointIds`) while locking their semantics to new/materially changed events only.
- Set the starvation contract to one prompt item before forcing due round-robin service, which gives later implementation a finite, directly asserted bound.
- Required health serialization and notifications to omit both arbitrary thrown messages and unapproved source paths, not merely redact known secrets.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Both Vitest suites stop at module resolution because `src/daemon/approved-source-runner.ts` and `src/daemon/scheduler.ts` intentionally belong to later Wave 2 plans. Independent TypeScript transpilation confirms both test files are syntactically valid. This is the planned Wave 0 RED state.
- Atomic task commits could not be created because git metadata is read-only in the execution environment.

## TDD Gate Compliance

- **RED:** Confirmed. Both focused commands fail only at their missing future production-module imports.
- **GREEN:** Deferred by design to Plans 04-06 and 04-07; this test-contract plan does not implement production code.
- **Commits:** Unavailable because `.git/index.lock` cannot be written; no commit hashes are claimed.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 04-06 can implement `ApprovedSourceRunner` and the four batch importer seams against `source-runner.test.ts`.
- Plan 04-07 can implement injected watch/runtime adapters, `DaemonScheduler`, and `SourceStateMachine` against `scheduler.test.ts`.
- No privacy, approval, person/scope, or native-history-write exception is outstanding.

## Self-Check: PASSED

- FOUND: `tests/daemon/source-runner.test.ts`
- FOUND: `tests/daemon/scheduler.test.ts`
- FOUND: `.planning/phases/04-continuous-local-daemon/04-02-SUMMARY.md`
- PASS: both test files transpile without TypeScript syntax diagnostics.
- PASS: combined Vitest invocation is RED only because the two planned production modules are absent.
- PASS: `git diff --check` reports no whitespace errors for the two test files.

---
*Phase: 04-continuous-local-daemon*
*Completed: 2026-07-17*
