---
phase: 04-continuous-local-daemon
plan: "20"
subsystem: daemon
tags: [macos, notification, osascript, smoke-test, privacy]
requires:
  - phase: 04-continuous-local-daemon
    provides: durable one-shot degraded-source notification latching and lease-guarded daemon composition through Plan 04-19
provides:
  - Truthful notification receipts separating command acceptance from visible presentation
  - Stable Script Editor application identity for explicit macOS authorization
  - Fixed content-free production-adapter notification smoke trigger
affects: [04-21-live-notification-uat, daemon-runtime, macos-operations]
tech-stack:
  added: []
  patterns: [acceptance-not-presentation, stable-authorizable-identity, injected-os-smoke]
key-files:
  created:
    - src/daemon/macos/notification-smoke-command.ts
    - tests/daemon/macos-notification-smoke.test.ts
  modified:
    - src/daemon/runtime-adapters.ts
    - src/daemon/macos/notification.ts
    - src/daemon/daemon-command.ts
    - tests/daemon/fixtures.ts
    - tests/daemon/macos-adapters.test.ts
    - package.json
key-decisions:
  - "An osascript exit code of zero proves command acceptance only; Notification Center presentation remains explicitly unverified."
  - "The production osascript path exposes Script Editor (com.apple.ScriptEditor2) as the stable identity the user must authorize."
  - "The live smoke command accepts no payload arguments and always uses one fixed synthetic degraded episode."
patterns-established:
  - "Notification receipt: capable and commandAccepted are independent from immutable presentation=unverified."
  - "Live OS smoke: production adapter plus fixed synthetic metadata, with every command effect injectable in tests."
requirements-completed: [REQ-017, REQ-020]
coverage:
  - id: D1
    description: "macOS notification attempts return the stable Script Editor identity and distinguish capability and command acceptance from unverified presentation."
    requirement: REQ-017
    verification:
      - kind: unit
        ref: "tests/daemon/macos-adapters.test.ts#MacOSNotificationAdapter"
        status: pass
      - kind: integration
        ref: "tests/daemon/scheduler.test.ts#degraded notification latch"
        status: pass
    human_judgment: false
  - id: D2
    description: "The argument-free local smoke command exercises the production adapter once with fixed synthetic content and prints only the truthful attempt receipt."
    requirement: REQ-020
    verification:
      - kind: unit
        ref: "tests/daemon/macos-notification-smoke.test.ts#macOS notification smoke command"
        status: pass
    human_judgment: false
duration: 4min
completed: 2026-07-18
status: complete
---

# Phase 04 Plan 20: Truthful macOS Notification Smoke Summary

**Stable Script Editor authorization identity, acceptance-only notification receipts, and an argument-free synthetic smoke trigger now replace the former false visible-delivery claim.**

## Performance

- **Duration:** 4 min
- **Started:** 2026-07-18T19:10:00Z
- **Completed:** 2026-07-18T19:13:59Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments

- Replaced the ambiguous `delivered` boolean with a shared `NotificationAttempt` containing capability, command acceptance, immutable `presentation: "unverified"`, and an explicit application identity.
- Exported and returned `Script Editor` / `com.apple.ScriptEditor2` on every macOS attempt, including rejected, thrown, and unavailable paths, without throwing into synchronization.
- Added `memory:daemon:notification-smoke`, which accepts no arbitrary payload, invokes the production adapter once with fixed synthetic metadata, and prints only its structured receipt.
- Preserved the existing durable one-notification-per-degraded-episode latch and best-effort post-commit notification behavior.

## Task Commits

Git commits were intentionally not attempted. The shared main working tree exposes Git metadata read-only, and the parent explicitly required preserving concurrent dirty work without retrying commits or claiming hashes.

1. **Task 1: Separate command acceptance from visible presentation** - unavailable (read-only Git metadata)
2. **Task 2: Add a fixed synthetic live-notification smoke command** - unavailable (read-only Git metadata)

**Plan metadata:** unavailable (read-only Git metadata)

## Files Created/Modified

- `src/daemon/runtime-adapters.ts` - Defines the shared application identity and notification-attempt receipt contract.
- `src/daemon/macos/notification.ts` - Returns the stable Script Editor identity, bounds controlled fields, and never claims visible presentation.
- `src/daemon/macos/notification-smoke-command.ts` - Provides the fixed synthetic, argument-free, production-adapter smoke entry point.
- `src/daemon/daemon-command.ts` - Returns the production adapter receipt through the existing notifier wrapper.
- `tests/daemon/fixtures.ts` - Makes injected notifier and command doubles conform to the shared receipt and thrown-command semantics.
- `tests/daemon/macos-adapters.test.ts` - Covers accepted, rejected, thrown, unavailable, stable-identity, bounded-input, and privacy behavior.
- `tests/daemon/macos-notification-smoke.test.ts` - Covers fixed-payload accepted/rejected/unavailable receipts without live OS effects.
- `package.json` - Adds the single `memory:daemon:notification-smoke` trigger consumed by Plan 04-21.

## Decisions Made

- Kept `presentation` permanently `unverified` because AppleScript offers no Notification Center presentation acknowledgement. A human observation in Plan 04-21 remains the only visible-banner proof.
- Used the identity diagnosed for the existing `/usr/bin/osascript` path instead of adding a second notification mechanism or changing system permissions silently.
- Kept the smoke surface argument-free and database-free. It cannot accept a transcript, source path, exception, tool result, credential, person ID, workspace ID, or arbitrary message.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Returned the shared receipt through production daemon composition**
- **Found during:** Task 1 typecheck
- **Issue:** The existing `daemon-command.ts` notifier wrapper awaited and discarded the adapter result, so it no longer conformed to `NotificationAdapter.notify(): Promise<NotificationAttempt>`.
- **Fix:** Returned the production adapter promise directly without changing notification timing or adding an OS effect.
- **Files modified:** `src/daemon/daemon-command.ts`
- **Verification:** Typecheck, 113 daemon tests, and 311 repository tests passed.
- **Commit:** unavailable because Git metadata is read-only

---

**Total deviations:** 1 auto-fixed (1 Rule 3 blocking contract fix)
**Impact on plan:** The change is the minimum production composition update required by the planned shared receipt contract; it adds no new behavior or trust boundary.

## Issues Encountered

- The repository was already substantially dirty with prior Phase 4 and earlier milestone work. No unrelated file was cleaned, reverted, staged, or committed.
- No live notification was sent and no macOS notification permission was changed. Visible presentation remains deliberately unproven until the explicitly authorized Plan 04-21 UAT.

## TDD Gate Compliance

- **Task 1 RED:** New adapter expectations failed because the implementation still returned `{ delivered: boolean }`; scheduler regression remained green.
- **Task 1 GREEN:** Accepted, rejected, thrown, unavailable, identity, bounded-field, and privacy cases passed with the new receipt.
- **Task 2 RED:** The new smoke test failed because the command module did not exist.
- **Task 2 GREEN:** Four fixed-payload smoke tests passed through the production adapter under injected command/capability/output seams.
- RED/GREEN commits are unavailable because Git metadata is read-only; no hash is claimed.

## Verification

- `npx vitest run tests/daemon/macos-adapters.test.ts tests/daemon/macos-notification-smoke.test.ts tests/daemon/scheduler.test.ts` - 31 tests passed across 3 files.
- `npx vitest run tests/daemon` - 113 tests passed across 9 files.
- `npm run typecheck` - passed.
- `npm run hermes:smoke` - passed with `ok: true` against a temporary synthetic SQLite database.
- `npm test` - 311 tests passed across 49 files.
- `git diff --check` - passed.

## Privacy and Isolation Review

- The adapter serializes only bounded source label, controlled error category, and bounded attempt count; it ignores transcript text, paths, exceptions, tool results, credentials, person IDs, workspace IDs, and arbitrary title/body content.
- The smoke trigger is fixed, synthetic, local-only, database-free, model-free, network-free, and accepts no content arguments.
- Native Codex, Claude Code, OpenClaw, and Hermes histories remain read-only and were not opened by these deterministic tests.
- Person/workspace ownership, source provenance, retrieval scopes, and proposal approval states are unchanged; the full daemon and repository suites confirm no regression.
- The existing persisted degraded-episode latch remains the one-shot authority, and notification failure remains best-effort after guarded state publication.

## Known Stubs

None.

## Threat Flags

No unplanned threat surface was introduced. The Script Editor identity, notification receipt, bounded OS payload, and injected deterministic-test boundary are the explicit trust surfaces registered in Plan 04-20.

## Next Phase Readiness

- Plan 04-21 can use `npm run memory:daemon:notification-smoke` as the single explicitly authorized live trigger after the user authorizes Script Editor notifications.
- Automated output must continue to be interpreted only as command acceptance; the human must separately report whether Notification Center presented the banner.
- The parent orchestrator retains ownership of STATE/ROADMAP/requirements updates and any later Git commit from a metadata-writable environment.

## Self-Check: PASSED

- Both created files, all modified contract/test files, the package script, and `04-20-SUMMARY.md` exist on disk.
- The summary declares `status: complete`, includes REQ-017 and REQ-020, and records the exact automated verification results.
- Focused tests, the full daemon suite, typecheck, Hermes smoke, the full repository suite, and diff hygiene all pass.
- Commit verification is intentionally unavailable because Git metadata is read-only; no hash is claimed.

---

*Phase: 04-continuous-local-daemon*
*Completed: 2026-07-18*
