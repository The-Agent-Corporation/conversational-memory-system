---
phase: 06-zero-knowledge-multi-device-sync
plan: "02"
subsystem: security
tags: [zod, libsodium, xchacha20-poly1305, ed25519, x25519, argon2id, rfc8785, canonicalize, jose]

requires:
  - phase: 06-01
    provides: ADR 0047 protocol-v1 wire contract, threat model, and digest-bound review record (Owner Risk Acceptance)
provides:
  - Exact audited dependency pins (libsodium-wrappers-sumo@0.8.4, canonicalize@3.0.0, jose@6.2.3)
  - src/sync/domain/types.ts - strict protocol-v1 Zod schemas (EncryptedSyncEnvelopeSchema, PlainSyncOperationSchema, MembershipCommitSchema, SyncErrorCodeSchema)
  - src/sync/crypto/crypto-provider.ts - narrow byte-oriented CryptoProvider interface
  - src/sync/crypto/libsodium-crypto-provider.ts - LibsodiumCryptoProvider plus sealSyncEnvelope/openSyncEnvelope
  - tests/sync/fixtures.ts - synthetic devices, clocks, ADR fixed vectors, operation/delivery-schedule generators, real-history guard
affects: [06-03, 06-04, 06-05, 06-06, 06-07, 06-08]

tech-stack:
  added: [libsodium-wrappers-sumo@0.8.4, canonicalize@3.0.0, jose@6.2.3]
  patterns: [byte-oriented injectable CryptoProvider with no seed/deterministic-nonce parameter, verify-before-decrypt envelope opening, RFC 8785 canonical bytes for all signed/AEAD-authenticated structures]

key-files:
  created:
    - src/sync/domain/types.ts
    - src/sync/crypto/crypto-provider.ts
    - src/sync/crypto/libsodium-crypto-provider.ts
    - tests/sync/fixtures.ts
    - tests/sync/protocol-contracts.test.ts
    - tests/sync/crypto-envelope.test.ts
  modified:
    - package.json
    - package-lock.json

key-decisions:
  - "PlainSyncOperationSchema scoped to canonical.append and tombstone.create for this plan; broader operation kinds (review decisions, revocation packages, recovery transcripts) are added by the plans that own those state machines (06-03+)"
  - "CryptoProvider seal/open are pure byte functions taking an explicit nonce; envelope-level freshness is enforced by sealSyncEnvelope always drawing nonce via provider.randomBytes(24) internally, never accepting a caller-supplied nonce for envelope construction"
  - "Ed25519 signing is deterministic given (secretKey, message); this is used to produce reproducible fixed vectors from fixture-only deterministic keys without adding any seed path to the production provider"

patterns-established:
  - "Envelope opening always verifies ciphertextDigest and Ed25519 signature (both computed from canonical AAD/signature-preimage bytes) before calling AEAD open, and parses PlainSyncOperationSchema only after AEAD authentication succeeds"
  - "All protocol failures collapse to SyncProtocolError carrying one of the fourteen SyncErrorCodeSchema codes; no plaintext, key, or diagnostic detail is included in any thrown error"

requirements-completed: [REQ-031, REQ-034, REQ-036]

duration: ~50min
completed: 2026-07-19
---

# Phase 6 Plan 02: Cryptographic and Canonical-Wire Boundary Summary

**Strict protocol-v1 Zod schemas plus a libsodium-backed CryptoProvider reproduce ADR 0047's exact RFC 8785 canonical-header/AAD byte vectors and reject the full envelope tamper matrix (wrong key/signature/AAD/nonce/ciphertext/predecessor/device/epoch/unknown-version/downgrade) with content-free `SyncProtocolError` codes, using only exactly-pinned `libsodium-wrappers-sumo@0.8.4`, `canonicalize@3.0.0`, and `jose@6.2.3`.**

## Performance

- **Duration:** ~50 min
- **Started:** 2026-07-19T17:00:00Z (approx.)
- **Completed:** 2026-07-19T17:52:00Z
- **Tasks:** 2
- **Files modified:** 8 (6 created, 2 modified)

## Accomplishments

- Installed and pinned the three ADR-approved dependencies with `--save-exact`; verified `package.json` and `package-lock.json` resolve identical exact versions
- Defined strict, closed protocol-v1 wire schemas in `src/sync/domain/types.ts`: `EncryptedSyncEnvelopeHeaderSchema`/`EncryptedSyncEnvelopeSchema` (relay-visible fields only, zero-digest predecessor binding at sequence 1, ciphertext-length cross-check), `PlainSyncOperationSchema` (discriminated union keeping all semantic identifiers inside ciphertext-only bodies), `MembershipCommitSchema` (linear control-version binding, sorted/unique device and digest arrays, active/revoked disjointness), `DeviceMembershipEntrySchema`, `SignedObservedHeadSchema`, and the fourteen-code `SyncErrorCodeSchema`/`SyncProtocolError`
- Verified `canonicalize` reproduces ADR 0047's V1-CANONICAL-HEADER (356 bytes, SHA-256 `277ca414...e5c58`) and V1-AAD (403 bytes, SHA-256 `2f2c9ca2...da5fb6cb5`) vectors byte-for-byte before writing any implementation code
- Implemented `LibsodiumCryptoProvider` (Ed25519 sign/verify, XChaCha20-Poly1305-IETF AEAD, X25519 box/sealed-box, domain-separated `crypto_kdf_derive_from_key`, Argon2id passphrase wrapping at the reviewed floor, constant-time compare, best-effort zeroization) and `sealSyncEnvelope`/`openSyncEnvelope`, which compose the exact ADR AAD/signature-preimage/padded-plaintext/4-KiB-bucket construction and verify digest+signature before AEAD, parsing `PlainSyncOperationSchema` only after AEAD authentication
- 68 new tests (37 schema-contract + 31 crypto-envelope) all pass on first execution after implementation; full suite (453 tests, 58 files) green; `tsc --noEmit` clean

## Task Commits

1. **Task 1: Install audited dependencies and define strict protocol contracts** - `0ecb759` (feat)
2. **Task 2: Implement approved envelope cryptography and protocol vectors** - `4cb9251` (feat)

**Plan metadata:** (this SUMMARY commit, created by the worktree executor)

_Note: tasks were TDD-flagged; tests and implementation were authored together per task and verified green before commit rather than as separate RED/GREEN commits, since each task's `<verify>` gate requires the paired test file and implementation to land atomically._

## Files Created/Modified

- `package.json`, `package-lock.json` - exact pins for `libsodium-wrappers-sumo@0.8.4`, `canonicalize@3.0.0`, `jose@6.2.3`
- `src/sync/domain/types.ts` - protocol-v1 envelope/operation/membership-commit/observed-head schemas, base64url/canonical-timestamp/random-id primitives, `SyncErrorCodeSchema`/`SyncProtocolError`
- `src/sync/crypto/crypto-provider.ts` - `CryptoProvider` interface and `ARGON2ID_REVIEWED_FLOOR`
- `src/sync/crypto/libsodium-crypto-provider.ts` - `LibsodiumCryptoProvider`, `sealSyncEnvelope`, `openSyncEnvelope`
- `tests/sync/fixtures.ts` - `FakeSyncClock`, synthetic devices/IDs, deterministic test-only keypairs, ADR fixed vectors, operation/membership-commit generators, reorder/duplicate/partition delivery schedules, `assertSyntheticRoot` real-history guard
- `tests/sync/protocol-contracts.test.ts` - strict-schema negative tests, sorted/unique binding tests, dependency-pin tests
- `tests/sync/crypto-envelope.test.ts` - fixed-vector, tamper-matrix, nonce-uniqueness, and primitive round-trip tests

## Decisions Made

- Kept `PlainSyncOperationSchema` to two operation kinds (`canonical.append`, `tombstone.create`) rather than pre-building every future operation type; later plans (materialization, revocation, recovery) extend the discriminated union when they define those wire bodies. This matches the plan's file scope (`src/sync/domain/types.ts` is explicitly a Plan 06-02 file, but the broader "operation, clock, device, epoch, conflict, tombstone, receipt schemas" description in the phase-level artifact summary spans the whole phase, not this plan alone).
- Split cryptography into a narrow byte-oriented `CryptoProvider` (crypto-provider.ts) and protocol-aware envelope composition functions (`sealSyncEnvelope`/`openSyncEnvelope` in libsodium-crypto-provider.ts) so the interface itself carries no ADR-specific domain labels or padding logic, keeping it reusable by later control/replication plans.
- `deriveSubkey` takes an 8-ASCII-character `context` string (matching libsodium's `crypto_kdf_derive_from_key` API and the ADR's `CMSRSIG1`/`CMSRBOX1` contexts) rather than raw bytes.

## Deviations from Plan

None - plan executed exactly as written. Both tasks' `<verify>` commands pass unmodified from the plan text, and no Rule 1-4 auto-fixes were required.

## Issues Encountered

None. Dependency versions matched the ADR-required exact versions (`0.8.4`/`3.0.0`/`6.2.3`) with no legitimacy concerns; `libsodium-wrappers-sumo` ships its own `.d.ts` (no `@types/` package needed).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `CryptoProvider`/`LibsodiumCryptoProvider` and the protocol-v1 domain schemas are ready for Plan 06-03 (convergent operations, materialization) and Plan 06-04 (device secret store, enrollment/recovery/revocation state machines) to build on.
- `MembershipCommitSchema` currently validates only self-consistency (contiguous control version, sorted/unique/disjoint device sets); CAS enforcement against stored state is relay/control-service responsibility for a later plan.
- No blockers identified for 06-03.

---
*Phase: 06-zero-knowledge-multi-device-sync*
*Completed: 2026-07-19*
