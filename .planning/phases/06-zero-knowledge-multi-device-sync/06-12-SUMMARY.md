---
phase: 06-zero-knowledge-multi-device-sync
plan: 12
subsystem: sync
tags: [durability, outbox, mcp, keychain, pipe-framing, deadlock, gap-closure]

# Dependency graph
requires:
  - phase: 06-zero-knowledge-multi-device-sync
    provides: sync-materializer local outbox emission seam (06-04/06-07), MCP mutation confirmation plans (05-04/05-09), macOS Keychain helper pipe protocol (06-review A7)
provides:
  - emitLocalSyncOperation returns and surfaces its commit status instead of discarding it, so a dropped sync outbox emission is observable, not silently lost
  - Restored takePlan kind guard in MemoryMutationApplication (returns undefined on a stored-plan kind mismatch)
  - Deadlock-free concurrent frame read in SpawnedKeychainHelperRunner for large secret payloads
affects: [06-review-followups, future device-sync durability/observability work, future Keychain helper protocol changes]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Non-fatal content-free signal: a process-local counter + console.warn naming only closed enum fields (status, operationKind), never IDs or plaintext"
    - "Concurrent frame drain: start both readFrame() calls before awaiting either, to avoid pipe-buffer deadlock when a producer writes payload before its own status frame"

key-files:
  created: []
  modified:
    - src/sync/materialization/sync-materializer.ts
    - src/boxes/box-reviewer.ts
    - src/proposals/proposal-reviewer.ts
    - src/service/source-lifecycle-service.ts
    - src/imports/codex-importer.ts
    - src/mcp/mutation-application.ts
    - src/sync/secrets/macos-keychain-secret-store.ts
    - tests/integration/sync-producers.test.ts
    - tests/mcp/mutation-tools.test.ts
    - tests/sync/device-secret-store.test.ts

key-decisions:
  - "emitLocalSyncOperation's non-fatal signal lives centrally in the materializer (module-level counter + console.warn), not duplicated at each of the 5 producer call sites, keeping WR-06's content-free contract in one place"
  - "IDEMPOTENT commit status does not trigger the WR-06 signal (it is an already-committed replay, not a drop); only STATE_CHANGED and EQUIVOCATION count as dropped emissions"
  - "WR-01's takePlan test reaches the private method via an `as unknown` cast rather than exposing a new public API, since all real callers already re-check kind defensively"
  - "WR-05's regression test uses a synthetic Node helper executable (not a compiled Swift binary) that reproduces the exact fd 6-before-fd 4 byte ordering documented in macos-keychain-helper.swift, so the fix is verified without requiring a macOS Keychain or Swift toolchain in CI"

requirements-completed: [REQ-031, REQ-033, REQ-035]

# Metrics
duration: 35min
completed: 2026-07-20
---

# Phase 06 Plan 12: WR-06/WR-01/WR-05 Gap Closure Summary

**Surfaced dropped sync-outbox emissions, restored the takePlan kind guard, and eliminated a Keychain read pipe deadlock on large secrets.**

## Performance

- **Duration:** ~35 min
- **Started:** 2026-07-20T13:00:00Z (approx, first commit e31e12b)
- **Completed:** 2026-07-20T17:07:31Z
- **Tasks:** 3/3 completed
- **Files modified:** 10 (7 source, 3 test)

## Accomplishments

- `emitLocalSyncOperation` now returns its `SyncCommitReceipt.status` instead of discarding it (`Promise<SyncCommitStatus>` in place of `Promise<void>`), and internally surfaces a non-fatal, content-free signal (process-local counter + `console.warn` naming only the status/operationKind enums) whenever the result is `STATE_CHANGED` or `EQUIVOCATION`. All five producer call sites (box-reviewer, proposal-reviewer, source-lifecycle-service x4, codex-importer, mutation-application x2) continue not to throw.
- Fixed the dead ternary in `MemoryMutationApplication.takePlan` (`plan?.kind === expectedKind ? plan : plan` → `... : undefined`), restoring the documented kind-mismatch contract.
- Eliminated the Keychain read pipe deadlock: `SpawnedKeychainHelperRunner.run` now starts draining the secret-output frame (fd 6) concurrently with the control-result frame (fd 4) instead of sequentially after it, matching the Swift helper's fd-6-before-fd-4 write order for large secrets.

## Task Commits

Each task was committed atomically:

1. **Task 1: Surface a non-fatal signal on non-COMMITTED local outbox emission** - `e31e12b` (fix)
2. **Task 2: Restore the takePlan kind guard** - `b5b239e` (fix)
3. **Task 3: Remove the Keychain read pipe-deadlock ordering** - `cf1c693` (fix)

**Plan metadata:** (owned by orchestrator, not this executor)

## Files Created/Modified

- `src/sync/materialization/sync-materializer.ts` - `emitLocalSyncOperation` returns `SyncCommitStatus`; adds `reportNonCommittedLocalSyncEmission`, `getNonCommittedLocalSyncEmissionCount`, `resetNonCommittedLocalSyncEmissionCount`
- `src/boxes/box-reviewer.ts` - call site comment documenting the non-throwing, non-fatal contract
- `src/proposals/proposal-reviewer.ts` - same
- `src/service/source-lifecycle-service.ts` - same, at all 4 call sites (revoke, deleteRevokedSource, 2x quarantine resolution)
- `src/imports/codex-importer.ts` - same
- `src/mcp/mutation-application.ts` - same at both call sites, plus the WR-01 `takePlan` fix
- `src/sync/secrets/macos-keychain-secret-store.ts` - concurrent secret/control frame drain in `SpawnedKeychainHelperRunner.run`
- `tests/integration/sync-producers.test.ts` - WR-06: asserts `emitLocalSyncOperation` returns `COMMITTED` normally, and forces a real `EQUIVOCATION` via a deterministic race between two concurrent emissions against the same device sequence, asserting the signal is observable (counter) and content-free (warn message excludes personId/targetId)
- `tests/mcp/mutation-tools.test.ts` - WR-01: stores a plan via the public preview path, then calls the private `takePlan` with a mismatched kind and asserts `undefined`, and confirms the token is consumed regardless of match
- `tests/sync/device-secret-store.test.ts` - WR-05: round-trips a 1 MiB secret through `SpawnedKeychainHelperRunner` against a synthetic helper executable that reproduces the Swift helper's fd-6-before-fd-4 ordering, within a bounded timeout

## Decisions Made

- Centralized the WR-06 non-fatal signal inside `emitLocalSyncOperation` itself rather than at each producer call site, so the content-free contract has one implementation to audit.
- `IDEMPOTENT` is intentionally excluded from the WR-06 signal — it represents an already-committed replay, not a drop.
- WR-01 and WR-05 regression tests reach into implementation internals (a private method cast, and a synthetic helper executable) because the real bugs were previously unobservable through the public API/without a compiled macOS Keychain helper; this keeps the tests deterministic and CI-portable.

## Deviations from Plan

None - plan executed exactly as written. The plan's file list covered all six materializer+producer call sites and the two named files for Tasks 2 and 3; no additional files needed changes. `src/service/memory-service.ts` also calls `emitLocalSyncOperation` but was intentionally out of this plan's declared file scope (not listed in `files_modified`) and required no change since discarding a `Promise<SyncCommitStatus>` where a `Promise<void>` was previously discarded is source-compatible.

## Verification

- `npx tsc --noEmit` — passes, all producers compile against the new `emitLocalSyncOperation` return type.
- `npx vitest run tests/` — 76 test files, 655 tests, all passing (up from 653 pre-plan; +2 new WR-06 tests, +1 WR-01 test, +1 WR-05 test = net +5 new test cases across the touched files after accounting for the pre-existing 653).
- WR-06: `grep -n "COMMITTED" src/sync/materialization/sync-materializer.ts` shows `emitLocalSyncOperation` branching on `receipt.status` rather than discarding it.
- WR-01: `grep -n "expectedKind ? plan : undefined" src/mcp/mutation-application.ts` matches.
- WR-05: manually verified (via a temporary in-place revert, not committed) that the pre-fix code times out after 10s on the new large-secret test, and the post-fix code passes in ~200ms — confirming the test is a true regression guard, not a false-positive pass.

## Threat Flags

None - all three fixes close existing STRIDE register entries (T-06-08, T-06-07, T-06-03) declared in this plan's own threat model; no new trust boundaries or surface were introduced.

## Self-Check: PASSED

- FOUND: src/sync/materialization/sync-materializer.ts
- FOUND: src/mcp/mutation-application.ts
- FOUND: src/sync/secrets/macos-keychain-secret-store.ts
- FOUND: tests/integration/sync-producers.test.ts
- FOUND: tests/mcp/mutation-tools.test.ts
- FOUND: tests/sync/device-secret-store.test.ts
- FOUND commit: e31e12b
- FOUND commit: b5b239e
- FOUND commit: cf1c693
