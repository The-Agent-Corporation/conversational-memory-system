---
phase: 06-zero-knowledge-multi-device-sync
plan: "06"
subsystem: sync
tags: [enrollment, recovery, revocation, http-client, x25519, ed25519, argon2id, sync-relay]

requires:
  - phase: 06-03
    provides: "DeviceSecretStore contract and InMemoryDeviceSecretStore fake"
  - phase: 06-04
    provides: "atomic local sync storage seam (not directly imported by this plan)"
  - phase: 06-05
    provides: "OpaqueRelayService, RelayStore adapters, createRelayHttpServer, relay wire schemas"
provides:
  - "src/sync/transport/sync-relay.ts - SyncRelay client contract and in-process FakeSyncRelay"
  - "src/sync/transport/http-sync-relay.ts - production bounded HttpSyncRelay over the Plan 05 /v1/* HTTP boundary"
  - "src/sync/control/sync-control-service.ts - SyncControlService: device enrollment, recovery-key enrollment, revocation, recovery-credential rotation"
  - "CryptoProvider.generateSigningKeyPairFromSeed / generateWrappingKeyPairFromSeed (seeded recovery-credential derivation)"
affects: [06-07, 06-08]

tech-stack:
  added: []
  patterns:
    - "Non-interactive X25519 DH-combiner transcript code: both enrollment endpoints call CryptoProvider.box(mySecret, theirPublic, fixedNonce, fixedZeroPlaintext) and get byte-identical ciphertext (crypto_box's derived key is symmetric in both directions), letting each side independently derive the same 64-bit verification code without a further relay round trip"
    - "Opaque key-package transport over the existing envelope.append/list data-plane channel: X25519 box addressed to a device's long-term wrapping key (device-to-device) or sealed box addressed to a derived recovery wrapping key (recovery-to-holder), scanned-and-opened by the recipient rather than delivered through a dedicated wire field"
    - "SyncRelay as a thin typed façade directly over relay/domain/types.ts records, implemented once in-process (FakeSyncRelay, calling OpaqueRelayService.handle directly) and once over real HTTP (HttpSyncRelay), so both share identical relay authorization/CAS semantics"

key-files:
  created:
    - src/sync/transport/sync-relay.ts
    - src/sync/transport/http-sync-relay.ts
    - src/sync/control/sync-control-service.ts
    - tests/sync/control-fixtures.ts
    - tests/sync/enrollment.test.ts
    - tests/sync/recovery.test.ts
    - tests/sync/revocation.test.ts
    - tests/sync/http-sync-relay.test.ts
  modified:
    - src/sync/crypto/crypto-provider.ts
    - src/sync/crypto/libsodium-crypto-provider.ts

key-decisions:
  - "Transcript verification code derivation uses a non-interactive X25519 DH combiner (crypto_box in both directions with a fixed nonce/plaintext) rather than a literal ADR-worded keyed generichash, because CryptoProvider exposes no raw scalarmult/keyed-hash primitive and no wire field exists for the approver to publish an ephemeral key back to the candidate for a second round trip; documented in source as a Plan 06-06 simplification of the exact ADR construction while preserving the security property (independently, correctly derivable by both endpoints only if they hold the correct matching secret/public key pair)."
  - "Historical key-package delivery (the actual wrapped keyring bytes, as opposed to the keyPackageDigests already in MembershipCommit) has no dedicated relay wire operation in the Plan 06-05 schemas, and relay/domain/types.ts and src/sync/domain/types.ts are outside this plan's declared file scope. Delivery is transported over the existing envelope.append/envelope.list data-plane channel: the author appends an ordinary-shaped EncryptedSyncEnvelope whose ciphertext is actually an X25519 box (device recipient) or sealed box (recovery recipient), satisfying the relay's digest/signature checks (which never decrypt) without any relay-side schema change. Recipients scan the author's envelope history and try to open each one."
  - "CryptoProvider gained generateSigningKeyPairFromSeed/generateWrappingKeyPairFromSeed (Rule 2: ADR 0047 'Recovery derivation' requires deriving Ed25519/X25519 keypairs from a KDF-derived 32-byte seed via crypto_sign_seed_keypair/crypto_box_seed_keypair, and the Plan 06-02 interface only exposed unseeded generation). Both are explicitly scoped to recovery-credential derivation only, never used for ordinary device keys."
  - "SyncControlService is stateless with respect to local membership tracking: every mutating method (approveEnrollment, revokeDevice, rotateRecoveryCredential, enrollViaRecovery) takes an explicit CurrentControlState parameter rather than maintaining hidden internal state, matching the relay's own exact-state CAS design (a caller with a stale CurrentControlState is rejected by the CAS, never silently rebased)."
  - "Device identity secret material (Ed25519/X25519 keypairs) is retained in DeviceSecretStore as concatenated public+secret byte blobs under device_signing_seed/device_wrapping_seed, keyed by deviceId - the production LibsodiumCryptoProvider has no seeded-from-arbitrary-bytes device-key derivation path (by design, per Plan 06-02), so the generated keypair itself is what gets retained, not a re-derivable seed."

patterns-established:
  - "SyncRelay dual-implementation testing pattern: unit tests for control-service logic (enrollment/recovery/revocation) run against FakeSyncRelay (in-process OpaqueRelayService call, zero network), while HttpSyncRelay's own correctness is proven separately against a real ephemeral-loopback relay-http-server; both share the exact same relay authorization/CAS code path, so control-service tests exercise real relay security semantics without HTTP overhead."

requirements-completed: [REQ-032, REQ-033]

duration: ~110min
completed: 2026-07-19
---

# Phase 6 Plan 06: Device Enrollment, Recovery, Revocation, and Production HTTP Transport Summary

**`SyncControlService` implements transcript-bound device enrollment, dual-gate recovery-key enrollment, honest future-only device revocation, and recovery-credential rotation over a new `SyncRelay` client contract, backed by a production `HttpSyncRelay` proven against the real Plan 05 relay HTTP server through 8 loopback tests.**

## Performance

- **Duration:** ~110 min
- **Started:** 2026-07-19T17:xx (approx, continuing from 06-05 completion)
- **Completed:** 2026-07-19T18:38:00Z
- **Tasks:** 3
- **Files modified:** 10 (8 created, 2 modified)

## Accomplishments

- Defined `SyncRelay` (`src/sync/transport/sync-relay.ts`): a typed client-side façade directly over the Plan 06-05 relay wire records (`ControlRecord`, `DataEnvelopeRecord`, `EnrollmentRequestRecord`, `RecoveryPackageRecord`, `HeadObservationRecord`), plus `FakeSyncRelay`, an in-process implementation calling `OpaqueRelayService.handle` directly - unit tests for enrollment/recovery/revocation exercise the real relay authorization and CAS rules with zero network overhead.
- Implemented `SyncControlService` (`src/sync/control/sync-control-service.ts`) covering all four state machines:
  - **Normal remote enrollment:** candidate generates device+ephemeral keys, seals the device name to every currently active device's wrapping key, and both endpoints independently derive a matching 64-bit verification code via a non-interactive X25519 DH combiner over the enrollment transcript before the approver signs a CAS that adds the candidate and publishes the complete historical epoch keyring (X25519-box-addressed) over the existing envelope channel.
  - **Recovery-key enrollment:** requires both authenticated relay-account access (an authenticated `SyncRelay` session) and successful local Argon2id passphrase unwrap of the current recovery package (uniform `SYNC_INTEGRITY_FAILED` on any wrong-passphrase/missing-package case, matching the relay's own no-oracle failure model) before signing the dual-authorized CAS and importing the sealed-box-addressed historical keyring.
  - **Device revocation:** mints an independent random next epoch key, re-packages it only to remaining active devices, and commits a linear CAS that adds the target to `revokedDevices` without rewriting any historical control version or ciphertext; refuses to revoke the last active device or an already-inactive target.
  - **Recovery-credential rotation:** generates a fresh recovery seed/credential, uploads a new Argon2id passphrase package, republishes the sealed historical keyring, and replaces `recoveryCredentialId` via CAS - the old package/passphrase are immediately rejected for future recovery enrollment because the relay's active-package pointer has moved.
- Added `CryptoProvider.generateSigningKeyPairFromSeed`/`generateWrappingKeyPairFromSeed` to `src/sync/crypto/crypto-provider.ts` and `libsodium-crypto-provider.ts` (Rule 2 auto-fix: ADR 0047's recovery-derivation KDF chain requires seeded keypair generation that the Plan 06-02 interface did not expose).
- Implemented `HttpSyncRelay` (`src/sync/transport/http-sync-relay.ts`): production bounded client implementing every `SyncRelay` method against the exact Plan 05 `/v1/*` routes, with a single fresh-per-request `Authorization: Bearer` header, `AbortController`-bounded connect/total timeouts, pre-parse response-byte bounding, and stable content-free `SyncProtocolError` mapping for relay errors, HTTP status mismatches, malformed/oversized/wrong-version responses, and network/abort failures.
- 26 new control-service tests (enrollment 6, recovery 5, revocation 5, http-sync-relay 8, plus schema/fixture support) all pass; full `tests/sync/` + `tests/relay/` suite (184 tests) green; `tsc --noEmit` clean; full-repo `npx vitest run` is 600/602 green (2 pre-existing unrelated `tests/mcp/stdio-server.test.ts` failures, already tracked in `deferred-items.md` from Plan 06-03/06-05, caused by a missing `tsx` binary in this worktree's `node_modules`).

## Task Commits

1. **Task 06-06-01: Implement transcript-bound remote and recovery enrollment** - `81de7c9` (feat)
2. **Task 06-06-02: Implement honest device revocation and recovery rotation** - `01e5e08` (feat)
3. **Task 06-06-03: Implement production HttpSyncRelay and loopback control flows** - `06a88ee` (feat)

_Note: tasks were TDD-flagged; tests and implementation were authored together per task and verified green before commit, matching the pattern established by Plans 06-02 through 06-05 (each task's `<verify>` gate requires the paired test file(s) and implementation to land atomically)._

## Files Created/Modified

- `src/sync/transport/sync-relay.ts` - `SyncRelay` interface, `FakeSyncRelay`
- `src/sync/transport/http-sync-relay.ts` - `HttpSyncRelay`, `HttpSyncRelayOptions`, `HttpSyncRelayLogEntry`
- `src/sync/control/sync-control-service.ts` - `SyncControlService`, `DeviceIdentity`, `CurrentControlState`, `EpochKeyMaterial`
- `src/sync/crypto/crypto-provider.ts` - added `generateSigningKeyPairFromSeed`/`generateWrappingKeyPairFromSeed` to the `CryptoProvider` interface
- `src/sync/crypto/libsodium-crypto-provider.ts` - implemented the two seeded-keypair methods via `crypto_sign_seed_keypair`/`crypto_box_seed_keypair`
- `tests/sync/control-fixtures.ts` - shared test harness wiring `InMemoryRelayStore` + `OpaqueRelayService` + `FakeRelayAccountAuthenticator` behind `FakeSyncRelay`/`SyncControlService` instances
- `tests/sync/enrollment.test.ts` - 6 tests: matching-code success + complete-history reconstruction, mismatched code, expiry, request-ID single-use/replay, already-active-device rejection, MCP person/scope non-alteration
- `tests/sync/recovery.test.ts` - 5 tests: dual-gate recovery success + keyring import, wrong-passphrase uniform failure, missing-package failure, rotation supersedes the old package, rotation leaves historical control versions untouched
- `tests/sync/revocation.test.ts` - 5 tests: future-exclusion + independent-epoch proof, remaining-device import + revoked-device denial, inactive-target rejection, last-device refusal, stale/already-superseded CAS rejection
- `tests/sync/http-sync-relay.test.ts` - 8 tests: full enrollment/CAS/envelope/recovery loopback flow, never-enrolled-device denial, unauthenticated rejection, timeout abort, malformed/oversized/wrong-version response handling, bearer-token log redaction

## Decisions Made

See `key-decisions` in frontmatter. Most significant: two protocol-construction simplifications were required because this plan's declared file scope (`sync-relay.ts`, `http-sync-relay.ts`, `sync-control-service.ts`, and four test files) excludes `src/sync/domain/types.ts` and `src/relay/domain/types.ts`, which is where new wire fields would otherwise need to live:

1. The enrollment transcript verification code is derived via a non-interactive X25519 DH combiner (both endpoints call `CryptoProvider.box` with their own secret key and the other's public key, a fixed nonce, and fixed plaintext, producing byte-identical ciphertext by construction) rather than the ADR's literal keyed-generichash-over-both-ephemeral-keys construction, because there is no wire field for the approver to publish an ephemeral key back to the candidate for a second round trip, and `CryptoProvider` exposes no raw-scalarmult/keyed-hash primitive. The security property (only the correct key-pair holders can derive a matching code) is preserved; the exact byte construction differs from the ADR text.
2. Historical key-package delivery (the actual wrapped keyring bytes) reuses the existing `envelope.append`/`envelope.list` data-plane channel with an X25519-box or sealed-box ciphertext in place of an ordinary operation ciphertext, since `MembershipCommit.keyPackageDigests` only carries digests and no dedicated relay wire field for package bytes exists in the current schema.

Both are documented in source-code comments at their point of use and should be reconciled with a literal ADR-matching wire extension (a new `PlainSyncOperationSchema` variant or relay record type) in a follow-up plan if exact byte-for-byte ADR conformance is later required for independent security review.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - missing critical functionality] Added seeded Ed25519/X25519 keypair derivation to `CryptoProvider`**
- **Found during:** Task 1 (implementing recovery-credential derivation)
- **Issue:** ADR 0047 "Recovery derivation" requires deriving the recovery signing/wrapping keypairs from a KDF-derived 32-byte seed (`crypto_kdf_derive_from_key` contexts `CMSRSIG1`/`CMSRBOX1`), but the Plan 06-02 `CryptoProvider` interface exposed only unseeded `generateSigningKeyPair()`/`generateWrappingKeyPair()` (a deliberate Plan 06-02 design choice for ordinary device keys). Without a seeded path, recovery-key enrollment/rotation could not be implemented at all.
- **Fix:** Added `generateSigningKeyPairFromSeed`/`generateWrappingKeyPairFromSeed` to the interface and to `LibsodiumCryptoProvider`, explicitly documented as sanctioned only for recovery-credential derivation.
- **Files modified:** `src/sync/crypto/crypto-provider.ts`, `src/sync/crypto/libsodium-crypto-provider.ts`
- **Verification:** Exercised by `tests/sync/recovery.test.ts`'s dual-gate enrollment and rotation tests.
- **Committed in:** `81de7c9` (Task 1 commit)

### Scope Boundary Notes (not Rule 1-4 auto-fixes)

**1. Key-package transport reuses the envelope channel instead of a dedicated wire field**
- See key-decisions above. Not a fix to existing code - a documented design choice made necessary by the file-scope boundary (`relay/domain/types.ts` and `sync/domain/types.ts` are not in this plan's declared files).

## Known Stubs

None. Every implemented flow (enrollment, recovery, revocation, rotation, HTTP transport) is exercised end-to-end by its tests with no hardcoded/placeholder return paths.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: protocol-simplification | src/sync/control/sync-control-service.ts | Transcript verification-code construction and key-package transport diverge from the ADR 0047 literal wire text (see Decisions Made above). Both preserve the stated security properties but have not been independently reviewed against the exact ADR byte construction; flagged for reconciliation before any threat model beyond "Owner Risk Acceptance, personal single-user deployment" is claimed. |

## Issues Encountered

- Pre-existing, unrelated: `tests/mcp/stdio-server.test.ts` has 2 failing tests in this worktree (missing `tsx` binary in `node_modules`), already tracked in `.planning/phases/06-zero-knowledge-multi-device-sync/deferred-items.md` since Plan 06-03. Not touched by this plan.

## User Setup Required

None - no external service configuration required. `HttpSyncRelay` requires an HTTPS `baseUrl` in production (or explicit `allowInsecureLoopback: true` for a loopback test harness only), matching the same TLS-required posture as `createRelayHttpServer` from Plan 06-05.

## Next Phase Readiness

- `SyncControlService` and `HttpSyncRelay` are ready for Plan 06-07 (replication/materialization client) and Plan 06-08 (production daemon composition and end-to-end scenario) to build on.
- The key-package transport and transcript-code simplifications documented above are candidates for a literal ADR-conformance follow-up if this deployment's threat model ever moves beyond "Owner Risk Acceptance, personal single-user."
- No blockers identified for 06-07.

---
*Phase: 06-zero-knowledge-multi-device-sync*
*Completed: 2026-07-19*

## Self-Check: PASSED

All created files (`src/sync/transport/sync-relay.ts`, `src/sync/transport/http-sync-relay.ts`, `src/sync/control/sync-control-service.ts`, `tests/sync/control-fixtures.ts`, `tests/sync/enrollment.test.ts`, `tests/sync/recovery.test.ts`, `tests/sync/revocation.test.ts`, `tests/sync/http-sync-relay.test.ts`) and all three task commit hashes (`81de7c9`, `01e5e08`, `06a88ee`) were verified present.
