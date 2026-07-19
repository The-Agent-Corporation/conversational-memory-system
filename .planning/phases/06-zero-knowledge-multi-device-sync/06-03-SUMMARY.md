---
phase: 06-zero-knowledge-multi-device-sync
plan: "03"
subsystem: sync
tags: [device-secrets, keychain, security, macos, swift, node-child-process]

requires:
  - phase: 06-zero-knowledge-multi-device-sync
    provides: "ADR 0047 protocol contract, key hierarchy, and threat model (Plan 06-01)"
provides:
  - "DeviceSecretStore: opaque byte-oriented device-secret retention contract"
  - "InMemoryDeviceSecretStore: deterministic synthetic-bytes fake for tests"
  - "MacosKeychainSecretStore + SpawnedKeychainHelperRunner: production macOS adapter"
  - "macos-keychain-helper.swift: Security-framework private-pipe helper"
affects: [06-04, 06-05, 06-06, 06-07, 06-08]

tech-stack:
  added: []
  patterns:
    - "Byte-oriented secret contract: opaque bindings + expected-version CAS, never arbitrary serialized records"
    - "Bounded length-prefixed private-pipe protocol on inherited fds 3-6 for secret-bearing subprocess IPC"
    - "Injected KeychainHelperRunner boundary: production spawn implementation vs. synthetic fake for deterministic tests"

key-files:
  created:
    - src/sync/secrets/device-secret-store.ts
    - src/sync/secrets/in-memory-device-secret-store.ts
    - src/sync/secrets/macos-keychain-secret-store.ts
    - src/sync/secrets/macos-keychain-helper.swift
    - tests/sync/device-secret-store.test.ts
    - .planning/phases/06-zero-knowledge-multi-device-sync/deferred-items.md
  modified: []

key-decisions:
  - "SecretBinding is {personId, syncId, deviceId?, epoch?}; exact equality checked on every operation, including delete, to deny cross-person/cross-device access with a controlled SECRET_BINDING_MISMATCH code."
  - "Rotation retains all historical versions in both the fake and the Keychain adapter (each version is its own non-synchronizable Keychain item); only a lightweight pointer item's version integer advances atomically on CAS success, matching ADR 0047's 'historical keys are not rewritten' rule."
  - "The macOS helper protocol never carries secret bytes in argv, stdout, or the JSON control channel; secret bytes flow only over dedicated inherited fds 5/6 as length-prefixed raw frames, and the control channel (fds 3/4) carries only opaque requestId/account/version/status fields."
  - "SpawnedKeychainHelperRunner is documented as the manual synthetic-account UAT path only; automated tests exercise MacosKeychainSecretStore exclusively through a synthetic in-process KeychainHelperRunner fake, so no test spawns a real process or touches a real Keychain."
  - "Both TypeScript and Swift files are asserted, via source-scan tests, to contain no plaintext-file/SQLite fallback API surface (writeFile, createWriteStream, node:sqlite, better-sqlite3, FileManager, write(toFile, contentsOfFile) and no secret/account-bearing stderr literals."

patterns-established:
  - "Secret-store contract pattern: opaque SecretBinding + SecretKind + secretId + expected-version, DeviceSecretError with a small closed DeviceSecretErrorCode union, defensive-copy return values — reusable for any future OS-backed secret adapter (e.g. a Linux/Windows counterpart)."
  - "Helper-runner injection pattern for secret-bearing native processes: KeychainHelperRequest/KeychainHelperResult carry only opaque/stable fields; secret bytes cross the boundary exclusively through side-channel writeSecret()/readSecret() callbacks, never embedded in the request/result objects that could be logged or JSON-stringified."

requirements-completed: [REQ-031, REQ-032, REQ-033]

duration: 55min
completed: 2026-07-19
---

# Phase 6 Plan 3: Device Secret Store and macOS Keychain Adapter Summary

**Host-neutral `DeviceSecretStore` contract with a deterministic in-memory fake and a production macOS Keychain adapter that exchanges secret bytes only over dedicated private pipes, never argv/stdout/JSON.**

## Performance

- **Duration:** 55 min
- **Started:** 2026-07-19T16:51:00Z
- **Completed:** 2026-07-19T17:45:49Z
- **Tasks:** 2 completed
- **Files modified:** 5 (4 created source/test files, plus 1 deferred-items note)

## Accomplishments

- Defined `DeviceSecretStore`: an opaque, byte-oriented create/read/current-version/rotate/delete contract keyed by `SecretKind` (device signing/wrapping seed, recovery seed, keyring-wrapping key, epoch key) and an exact `SecretBinding` (person/sync/device/epoch), with a small closed `DeviceSecretErrorCode` union and no arbitrary serialized-record parameter anywhere in the interface.
- Implemented `InMemoryDeviceSecretStore`: defensive copies on every read/write boundary, zeroization of retained buffers on delete, atomic expected-version-gated rotation that retains all historical versions, exact binding enforcement (cross-person/cross-device access denied with a controlled code), and an injectable fault boundary reusing the existing `FaultInjector` fixture pattern from `tests/mcp/fixtures.ts`.
- Implemented `MacosKeychainSecretStore` mapping the contract onto an injected `KeychainHelperRunner`, plus a production `SpawnedKeychainHelperRunner` that spawns the compiled Swift helper with a fixed, request-independent argv (`["serve"]`) and a bounded length-prefixed private-pipe protocol on inherited fds 3-6.
- Implemented `macos-keychain-helper.swift`: a Security-framework helper storing each secret version as its own non-synchronizable, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` generic-password item, with a separate lightweight pointer item whose integer `version` attribute advances only via `SecItemUpdate` after `expectedVersion`/`newVersion` validation — a rejected or failed rotate leaves the prior pointer and all existing version items untouched, and there is no plaintext file or SQLite write path anywhere in the helper.
- Added 20 contract/leakage tests in `tests/sync/device-secret-store.test.ts` covering both tasks: fake-store lifecycle/binding/rotation/deletion/fault behavior, leakage scans across errors, `JSON.stringify`, config-like objects, `process.env`, and an ordinary SQLite fixture snapshot (`tests/mcp/fixtures.ts`'s `createSyntheticMcpFixture`/`snapshotSemanticMemory`); and macOS-adapter contract parity, fixed-service-label mapping, control-channel non-leakage, rotate-failure version preservation, plus static source scans of both the TypeScript adapter and the Swift helper for fallback/leakage anti-patterns.

## Task Commits

Each task was committed atomically:

1. **Task 06-03-01: Define secret-store lifecycle and deterministic fake** - `2b18768` (feat)
2. **Task 06-03-02: Implement the macOS Keychain adapter without secret-bearing process surfaces** - `126150b` (feat)

**Plan metadata:** committed as part of this SUMMARY commit.

_Note: tasks were `tdd="true"` in the plan frontmatter, but action text described contract-first implementation rather than a strict standalone RED commit; tests and implementation were built together per task and verified passing before each commit (no failing-test-only commit was produced). This matches the plan's `<verify>` blocks, which run tests and implementation together._

## Files Created/Modified

- `src/sync/secrets/device-secret-store.ts` - `DeviceSecretStore` interface, `SecretKind`/`SecretBinding` types, `DeviceSecretError`/`DeviceSecretErrorCode`.
- `src/sync/secrets/in-memory-device-secret-store.ts` - `InMemoryDeviceSecretStore`, the synthetic test-only fake.
- `src/sync/secrets/macos-keychain-secret-store.ts` - `MacosKeychainSecretStore`, `KeychainHelperRunner`/`KeychainHelperRequest`/`KeychainHelperResult`, `SpawnedKeychainHelperRunner`, and the length-prefixed frame read/write helpers.
- `src/sync/secrets/macos-keychain-helper.swift` - Security-framework helper implementing the `serve` private-pipe protocol.
- `tests/sync/device-secret-store.test.ts` - 20 tests: fake-store contract/leakage (Task 1) and macOS-adapter contract/leakage/source-scan tests (Task 2).
- `.planning/phases/06-zero-knowledge-multi-device-sync/deferred-items.md` - out-of-scope pre-existing `tests/mcp/stdio-server.test.ts` failure noted, not fixed.

## Decisions Made

- **Historical-key retention policy:** rotation never deletes or overwrites a prior version's Keychain item or in-memory record; only the current-version pointer advances. This matches ADR 0047 ("Revocation ... does not rewrite historical ciphertext") without requiring this plan to implement the epoch/control-plane pruning policy, which is out of scope here.
- **Account label opacity:** the Keychain `account` attribute is `${kind}:${secretId}` where `secretId` is itself an opaque caller-issued identifier — no person, sync, or device name is ever placed in a Keychain attribute, argv, or the control channel.
- **Automated verification never touches a real Keychain:** per the plan's explicit constraint, all automated `MacosKeychainSecretStore` tests use an in-process `FakeKeychainHelperRunner`; `SpawnedKeychainHelperRunner` is verified only via `swiftc -typecheck` (compiles, never runs) and via TypeScript typecheck, consistent with `<verify>`'s exact command list.

## Deviations from Plan

None - plan executed as written. Both tasks' `<action>`, `<behavior>`, and `<acceptance_criteria>` were implemented directly; no bugs, missing critical functionality, or blocking issues were discovered that required a Rule 1-4 deviation.

## Issues Encountered

A full-suite `npx vitest run` (not part of this plan's `<verify>` commands, run only as a sanity check) surfaced 2 pre-existing failures in `tests/mcp/stdio-server.test.ts` caused by a missing `tsx` package in `node_modules` in this worktree. This file belongs to Phase 5 and is unrelated to any file this plan touches (`src/sync/secrets/**`, `tests/sync/**`); it was left unmodified and logged in `deferred-items.md` per the executor scope-boundary rule. The plan's own required verification commands (`npx vitest run tests/sync/device-secret-store.test.ts`, `npm run typecheck`, `npx vitest run tests/sync/device-secret-store.test.ts -t "macOS|leak|helper"`, `swiftc -typecheck src/sync/secrets/macos-keychain-helper.swift`) all pass cleanly.

## User Setup Required

None - no external service configuration required. A live-Keychain manual UAT remains a separate, later human-verification step (per the plan's `<verification>` note) and was intentionally not exercised here.

## Next Phase Readiness

`DeviceSecretStore`, its deterministic fake, and the macOS production adapter are ready for consumption by device enrollment, recovery, and epoch/key-rotation services in subsequent Phase 6 plans (crypto provider, sync control service, replication). No blockers identified. The A7 disposition in ADR 0047 ("Plan 06-03 owns evidence") is satisfied: the macOS secret-store boundary now exists with contract/leakage test evidence, pending only the separately-scoped live-Keychain manual UAT.

---
*Phase: 06-zero-knowledge-multi-device-sync*
*Completed: 2026-07-19*

## Self-Check: PASSED

All created files and referenced commit hashes (2b18768, 126150b) were verified present.
