---
phase: 06-zero-knowledge-multi-device-sync
plan: 13
subsystem: sync
tags: [relay, recovery, argon2id, revocation, opaque-relay, sqlite, libsodium]

# Dependency graph
requires:
  - phase: 06-zero-knowledge-multi-device-sync
    provides: "06-09 recoverySigningPublicKey / CMSRSIG1 recovery-authorization signing fix (CR-01)"
provides:
  - "Relay-issued single-use recovery challenge with 10-minute expiry + controlVersion binding (WR-03)"
  - "Argon2id reviewed-floor enforcement on the passphrase unwrap path (WR-04)"
  - "Revoked-device reactivation guard in commitControl, both relay store adapters (WR-07)"
affects: [06-verification, 06-review-followups]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Relay-issued (never client-chosen) single-use challenge minted on the read/fetch path and consumed atomically by the mutating CAS that authorizes against it"
    - "Order security checks so a replayed/consumed credential state is reported as SYNC_ALREADY_USED before any secondary state (e.g. package supersession) can mask it"

key-files:
  created: []
  modified:
    - src/relay/domain/types.ts
    - src/relay/storage/relay-store.ts
    - src/relay/storage/in-memory-relay-store.ts
    - src/relay/storage/sqlite-relay-store.ts
    - src/relay/service/opaque-relay-service.ts
    - src/sync/control/sync-control-service.ts
    - src/sync/transport/sync-relay.ts
    - src/sync/transport/http-sync-relay.ts
    - src/sync/crypto/libsodium-crypto-provider.ts
    - tests/sync/control-fixtures.ts
    - tests/sync/recovery.test.ts
    - tests/sync/revocation.test.ts
    - tests/relay/membership-cas.test.ts

key-decisions:
  - "Recovery challenge is minted and persisted server-side on recovery.fetch (not a new operation), returned alongside the active package as { record, challenge } to keep the wire surface minimal"
  - "Challenge validity (existence/consumed/expired/controlVersion) is checked BEFORE the active-package-match check in handleMembershipCas, so a replayed challenge always surfaces SYNC_ALREADY_USED rather than being masked by the pre-existing package-supersession-on-use behavior"
  - "Single-use consumption happens atomically inside commitControl (consumeRecoveryChallengeNonce), mirroring the existing supersedeRecoveryPackageId pattern -- consumed only by a successful CAS, never by a failed attempt"
  - "fetchRecoveryPackage's return type changed from RecoveryPackageRecord | null to { package, challenge } -- safe because no production caller outside tests exists yet for this transport method"

requirements-completed: [REQ-032, REQ-033, REQ-036]

# Metrics
duration: 55min
completed: 2026-07-20
---

# Phase 06 Plan 13: Recovery Challenge Freshness, Argon2id Floor, Revocation Reactivation Guard Summary

**Relay-issued single-use recovery challenges bound to controlVersion + 10-minute expiry, an Argon2id reviewed-floor precondition on passphrase unwrap, and a revoked-credential reactivation guard added to both relay store adapters, closing WR-03/WR-04/WR-07 from the 06-REVIEW.**

## Performance

- **Duration:** ~55 min
- **Tasks:** 3
- **Files modified:** 13 (across 3 task commits) + 1 metadata file

## Accomplishments
- Recovery enrollment now requires a fresh, relay-minted, single-use challenge; expired/reused/never-issued challenges are rejected with stable SYNC_EXPIRED / SYNC_ALREADY_USED / SYNC_DEVICE_DENIED codes before the CAS ever runs
- unwrapWithPassphrase rejects below-ARGON2ID_REVIEWED_FLOOR packages uniformly (SYNC_INTEGRITY_FAILED) before any key derivation
- commitControl (both InMemoryRelayStore and SqliteRelayStore) rejects a control commit that relists a currently-revoked deviceId as active, closing the silent-reactivation gap

## Task Commits

Each task was committed atomically:

1. **Task 3 (executed first, simplest): Reject reactivation of revoked credentials in commitControl** - `37ca22b` (feat)
2. **Task 2: Enforce the Argon2id reviewed floor on the unwrap path** - `aa6774c` (feat)
3. **Task 1: Relay-issued single-use recovery challenge with expiry + controlVersion binding** - `2521775` (feat)

**Plan metadata:** (this commit, following SUMMARY.md creation)

## Files Created/Modified
- `src/relay/storage/in-memory-relay-store.ts` - reactivation guard in commitControl; recoveryChallenges map + issue/get/consume
- `src/relay/storage/sqlite-relay-store.ts` - reactivation guard (same transaction); recovery_challenges table + issue/get/consume
- `src/relay/storage/relay-store.ts` - RelayStore interface: issueRecoveryChallenge, getRecoveryChallenge, IssueRecoveryChallengeInput, CommitControlInput.consumeRecoveryChallengeNonce
- `src/relay/domain/types.ts` - RecoveryChallengeRecordSchema; recovery.fetch response gains `challenge`
- `src/relay/service/opaque-relay-service.ts` - mints + persists challenge on recovery.fetch; validates freshness/single-use/controlVersion binding (ordered before the active-package check) in handleMembershipCas; passes consumeRecoveryChallengeNonce to commitControl
- `src/sync/control/sync-control-service.ts` - enrollViaRecovery takes activeChallenge, signs the relay-issued challenge fields instead of a self-generated nonce
- `src/sync/transport/sync-relay.ts` / `src/sync/transport/http-sync-relay.ts` - fetchRecoveryPackage returns `{ package, challenge }`
- `src/sync/crypto/libsodium-crypto-provider.ts` - ARGON2ID_REVIEWED_FLOOR precondition in unwrapWithPassphrase
- `tests/sync/control-fixtures.ts` - harness accepts an injectable relay clock for deterministic expiry testing
- `tests/sync/recovery.test.ts` - below-floor/at-floor Argon2id tests; expired/reused/fresh-path/never-issued challenge tests; CR-01 test upgraded to use a real relay-issued challenge
- `tests/sync/revocation.test.ts` - control-service-level reactivation-rejected regression test
- `tests/relay/membership-cas.test.ts` - store-level (both adapters) reactivation-rejected test

## Decisions Made
- Recovery challenge is a new field on the existing `recovery.fetch` response rather than a new relay operation, keeping the wire surface change minimal
- Challenge validity checks were deliberately ordered before the active-package check so replay of a consumed challenge is never masked by the pre-existing (06-06/06-09) behavior where a successful recovery-authorized commit also supersedes the recovery package used
- `fetchRecoveryPackage`'s return shape changed (package + challenge) since no production wiring outside tests currently calls it -- confirmed via `grep -rln fetchRecoveryPackage src` before making the change

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Touched files outside the plan's `files_modified` list to persist/transport/test the relay-issued challenge**
- **Found during:** Task 1 (relay-issued recovery challenge)
- **Issue:** The plan's `files_modified` list for Task 1 covered `opaque-relay-service.ts`, `sync-control-service.ts`, and `tests/sync/recovery.test.ts`, but a relay-issued, persisted, single-use challenge cannot be defined, stored, returned over the wire, or deterministically tested for expiry without also touching: the shared record schema (`src/relay/domain/types.ts`), the `RelayStore` interface (`src/relay/storage/relay-store.ts`), the client transport contract and its HTTP implementation (`src/sync/transport/sync-relay.ts`, `src/sync/transport/http-sync-relay.ts`), and the shared test harness's relay clock injection (`tests/sync/control-fixtures.ts`).
- **Fix:** Extended each of these files with the minimal surface needed (schema, store interface + both adapter implementations, transport return-shape, harness clock override) rather than working around the gap.
- **Files modified:** `src/relay/domain/types.ts`, `src/relay/storage/relay-store.ts`, `src/sync/transport/sync-relay.ts`, `src/sync/transport/http-sync-relay.ts`, `tests/sync/control-fixtures.ts`
- **Verification:** Full `npx tsc --noEmit` clean; full `npx vitest run` green except two pre-existing, unrelated, out-of-scope timeouts (see Deferred Issues below)
- **Committed in:** `2521775` (Task 1 commit)

**2. [Rule 2 - Missing critical] Added a store-level (both-adapters) reactivation-rejected test beyond the plan's `tests/sync/revocation.test.ts`-only instruction**
- **Found during:** Task 3 (revoked-device reactivation guard)
- **Issue:** The plan's acceptance criteria explicitly require the guard to be proven "in both adapters," but `tests/sync/revocation.test.ts` only exercises `InMemoryRelayStore` (via the shared control-test harness); it never constructs a `SqliteRelayStore`.
- **Fix:** Added a parametrized (in-memory + sqlite) reactivation-rejected test to the existing `tests/relay/membership-cas.test.ts` adapter-parity suite, alongside the control-service-level test already added to `tests/sync/revocation.test.ts`.
- **Files modified:** `tests/relay/membership-cas.test.ts`
- **Verification:** `npx vitest run tests/relay/membership-cas.test.ts` -- 13/13 passing, including the new test on both adapters
- **Committed in:** `37ca22b` (Task 3 commit)

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 missing-critical-coverage)
**Impact on plan:** Both deviations were necessary to make the required behavior actually persistable/testable per the plan's own acceptance criteria. No scope creep beyond what WR-03/WR-04/WR-07 require.

## Issues Encountered
- Initial design consumed the recovery challenge unconditionally on first lookup, which would have made replay-detection ambiguous with expiry; revised to consume only inside `commitControl` on a successful CAS (matching the ADR's "consumed by the successful CAS" language and the existing `supersedeRecoveryPackageId` pattern).
- The pre-existing (06-06/06-09) behavior where a successful recovery-authorized CAS also supersedes the recovery package used made naive test ordering surface `SYNC_DEVICE_DENIED` instead of `SYNC_ALREADY_USED` for a replayed challenge; resolved by reordering the relay-side checks (challenge validity before active-package match) rather than changing the pre-existing package-supersession behavior, which is out of this plan's scope.
- `OpaqueRelayService`'s internal clock (used for challenge `expiresAt`) is independent of the `SyncControlService`/test `fixedClock()` used elsewhere in `control-fixtures.ts`; added an optional `relayClock` override to the harness to make the expiry test deterministic without relying on real wall-clock time.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- WR-03, WR-04, WR-07 from `06-REVIEW.md` are closed; recovery enrollment, passphrase-package unwrap, and revocation reactivation now match the ADR 0047 acceptance conditions and threat register dispositions for T-06-02, T-06-06, and T-06-09.
- Full test suite green for every file this plan touched; `npx tsc --noEmit` clean.
- Two pre-existing, unrelated full-suite timeouts remain logged in `deferred-items.md` (`tests/mcp/stdio-server.test.ts`, `tests/sync/device-secret-store.test.ts`) -- both pass in isolation and are untouched by this plan; recommend follow-up outside this gap-closure wave.

## Self-Check: PASSED

All created/modified files and all three task commit hashes (37ca22b, aa6774c, 2521775) verified present.

---
*Phase: 06-zero-knowledge-multi-device-sync*
*Completed: 2026-07-20*
