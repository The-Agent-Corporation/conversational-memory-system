---
phase: 06-zero-knowledge-multi-device-sync
plan: 09
subsystem: security
tags: [ed25519, argon2id, zero-knowledge-relay, recovery, account-recovery, sync-protocol]

# Dependency graph
requires:
  - phase: 06-zero-knowledge-multi-device-sync
    provides: recovery-key enrollment (enrollViaRecovery), recovery rotation (rotateRecoveryCredential), relay membership.cas recovery branch (Plan 06-06)
provides:
  - CMSRSIG1 recovery signing credential derived from the recovery seed on the client
  - Relay verification of recovery-authorized membership.cas against the seed-derived key instead of the candidate's own key
  - Adversarial regression test proving account-only self-signed enrollment is rejected
affects: [06-VERIFICATION, future epoch-key delivery / decryption-side gap closures]

# Tech tracking
tech-stack:
  added: []
  patterns: ["Recovery-credential derivation uses a second HKDF-style subkey (CMSRSIG1) alongside the existing wrapping subkey (CMSRBOX1), both derived from the same 32-byte recovery seed via deriveSubkey"]

key-files:
  created: []
  modified:
    - src/relay/domain/types.ts
    - src/sync/control/sync-control-service.ts
    - src/relay/service/opaque-relay-service.ts
    - tests/sync/recovery.test.ts
    - tests/relay/metadata-contract.test.ts

key-decisions:
  - "recoverySigningPublicKey is a required (non-optional) field on RecoveryPackageRecordSchema, threading through recovery.upload automatically since the wire schema derives from .omit() over the persisted schema."
  - "In-memory and sqlite relay stores required no code changes: both persist RecoveryPackageRecord as an opaque typed object/JSON blob, so the new field round-trips for free."
  - "Derived seed material (signingSeed, recoverySigning.secretKey) is explicitly zeroed after use in both enrollViaRecovery and rotateRecoveryCredential, matching the existing CMSRBOX1 zeroing discipline."

patterns-established: []

requirements-completed: [REQ-032]

# Metrics
duration: 4min
completed: 2026-07-20
---

# Phase 06 Plan 09: Close CR-01 (account-only recovery enrollment) Summary

**Derived and enforced a CMSRSIG1 recovery signing credential so the relay now rejects any recovery-authorized `membership.cas` not signed by the seed-derived key, closing the account-only enrollment escalation.**

## Performance

- **Duration:** ~4 min (commit-to-commit)
- **Started:** 2026-07-20T12:57:22-04:00
- **Completed:** 2026-07-20T13:00:37-04:00
- **Tasks:** 3
- **Files modified:** 5 (2 src, 3 test/schema)

## Accomplishments
- Added a failing adversarial test that proves an account-authenticated attacker (no recovery seed, only `packageId` learned via `recovery.fetch`) could self-sign a `membership.cas` recovery authorization and get committed by the relay (RED, against unmodified `src/`).
- Derived the ADR 0047-specified `CMSRSIG1` recovery signing credential (`deriveSubkey(seed, 1, "CMSRSIG1", 32)` → `generateSigningKeyPairFromSeed`) on the client in both `enrollViaRecovery` and `rotateRecoveryCredential`, persisting its public key with the active recovery package.
- Flipped the relay's recovery-branch verification (`handleMembershipCas`) to check `recoveryAuthorization.signature` against `activePackage.recoverySigningPublicKey` instead of the candidate's own signing key — the commit signature is still (correctly) checked against the candidate's key.
- Confirmed the adversarial test now passes (rejected with `SYNC_INTEGRITY_FAILED`) and the legitimate seed-in-hand recovery path still succeeds and imports the historical keyring.

## Task Commits

Each task was committed atomically:

1. **Task 1: Failing-first adversarial account-only enrollment test (RED)** - `dec6773` (test)
2. **Task 2: Derive CMSRSIG1 credential and persist its public key with the recovery package** - `e5cc818` (feat)
3. **Task 3: Relay verifies the recovery authorization against the stored recovery signing key (GREEN)** - `a0fa342` (fix)

_TDD gate sequence: `test(06-09)` (RED) → `feat(06-09)` (credential plumbing, intermediate state where the legitimate enrollment test temporarily regresses to SYNC_INTEGRITY_FAILED because the relay side hadn't yet been switched) → `fix(06-09)` (GREEN, relay verification flip). All three commits are present in git log; full suite green as of the final commit._

## Files Created/Modified
- `src/relay/domain/types.ts` - `RecoveryPackageRecordSchema` gains a required `recoverySigningPublicKey` field (32-byte base64url, ADR 0047 CMSRSIG1)
- `src/sync/control/sync-control-service.ts` - `enrollViaRecovery` derives and signs with the CMSRSIG1 key instead of the candidate's own key; `rotateRecoveryCredential` derives and uploads the CMSRSIG1 public key with the fresh recovery package
- `src/relay/service/opaque-relay-service.ts` - `handleMembershipCas` recovery branch verifies the authorization signature against `activePackage.recoverySigningPublicKey`
- `tests/sync/recovery.test.ts` - adds the adversarial account-only enrollment test; updates the manual `uploadRecoveryPackage` test fixture to include `recoverySigningPublicKey`
- `tests/relay/metadata-contract.test.ts` - updates the `RecoveryPackageRecordSchema` "valid" fixture object to include the new required field (schema-compat fix, in scope for this plan's schema change)

## Decisions Made
- No relay-store code changes were needed for `in-memory-relay-store.ts` / `sqlite-relay-store.ts`: both already persist `RecoveryPackageRecord` as an opaque typed object (in-memory Map) or a `record_json` JSON blob (sqlite), so the new required field flows through automatically once the type/schema gained it. This matched the plan's `<files_modified>` list but required no edits to either storage file.
- Kept the exact stable error codes (`SYNC_INTEGRITY_FAILED` for a bad signature, `SYNC_DEVICE_DENIED` for a missing/mismatched package) unchanged per the plan's acceptance criteria.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Updated an unlisted test fixture for schema compatibility**
- **Found during:** Task 2 (schema field addition)
- **Issue:** `tests/relay/metadata-contract.test.ts` constructs a manual "valid" `RecoveryPackageRecord` fixture object used to assert `RecoveryPackageRecordSchema.safeParse(valid).success === true`. Adding the new required `recoverySigningPublicKey` field broke this fixture (it would now fail parsing, which is not what that test is asserting).
- **Fix:** Added `recoverySigningPublicKey: KEY32` (reusing the file's existing 32-byte base64url test constant) to the fixture object.
- **Files modified:** `tests/relay/metadata-contract.test.ts`
- **Verification:** `npx vitest run tests/relay/metadata-contract.test.ts` — all 17 tests pass.
- **Committed in:** `e5cc818` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking — schema-compat fixture update, not in the plan's `<files_modified>` list but required for `RecoveryPackageRecordSchema` to remain internally consistent)
**Impact on plan:** Minimal, mechanical fix required by the schema change itself. No scope creep — no other files outside the plan's stated intent were touched.

## Issues Encountered
None beyond the expected TDD-cycle intermediate state (Task 2 commit temporarily regresses the legitimate `enrollViaRecovery` integration test to `SYNC_INTEGRITY_FAILED` because the client now signs with the CMSRSIG1 key while the relay still checks the candidate's own key — this is the documented and intended RED-adjacent state between Task 2 and Task 3, resolved by Task 3's relay-side fix).

## Full Verification

- `npx tsc --noEmit` — clean, no type errors.
- `npx vitest run tests/sync tests/relay tests/integration` — 28 test files, 264 tests, all passing (no regressions introduced by the schema/behavior change).
- `npx vitest run tests/sync/recovery.test.ts` — 6/6 passing, including the new adversarial test.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- CR-01 (verification GAP-1) is closed: possession of the relay account alone can no longer enroll an active device. REQ-032 and ADR 0047 D-04/D-16 ("Account Recovery Cannot Enroll or Decrypt") are restored for the enrollment path.
- CR-02 (envelope hash-chain digest mismatch, REQ-034 offline convergence) remains open per `06-VERIFICATION.md` — tracked separately (out of scope for this plan; addressed by a different 06-1x gap-closure plan per the wave plan).
- No blockers for downstream phases from this plan's changes.

---
*Phase: 06-zero-knowledge-multi-device-sync*
*Completed: 2026-07-20*
