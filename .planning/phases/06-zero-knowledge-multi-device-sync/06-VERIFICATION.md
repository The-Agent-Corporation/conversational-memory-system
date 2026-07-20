---
phase: 06-zero-knowledge-multi-device-sync
verified: 2026-07-20T13:31:00Z
status: passed
score: 6/6 requirement truths verified
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 4/6 requirement truths verified (REQ-032, REQ-031/034 blocked by confirmed code defects)
  gaps_closed:
    - "Account recovery cannot enroll a device or decrypt memory (REQ-032; ADR 0047 D-04, D-16) — CR-01"
    - "Offline convergence / envelope hash chain integrity for multi-operation histories (REQ-034; also unblocks REQ-035) — CR-02"
  gaps_remaining: []
  regressions: []
---

# Phase 6: Zero-Knowledge Multi-Device Sync Verification Report

**Phase Goal:** Synchronize memory without giving the relay decryption capability.
**Verified:** 2026-07-20T13:31:00Z
**Status:** passed
**Re-verification:** Yes — after gap closure (plans 06-09..06-13)

## Goal Achievement

This is a re-verification of Phase 6 after five gap-closure plans (06-09..06-13) were executed
to address the two BLOCKER findings (CR-01, CR-02) recorded in the prior `06-VERIFICATION.md`
(status `gaps_found`, score 4/6). Both blockers are re-examined directly against the live
source tree — not the SUMMARYs — below.

### CR-01 (REQ-032) — closed

**Claim:** account-only access (no recovery seed) could previously enroll a new active device
via the recovery path, because the relay verified the recovery authorization against the
candidate device's own freshly generated signing key rather than a key derived from the
recovery seed.

**Evidence the fix is real and complete:**

- `src/sync/control/sync-control-service.ts:406-430` (`enrollViaRecovery`) now derives a
  second seed-bound subkey via `this.crypto.deriveSubkey(seed, 1, "CMSRSIG1", 32)` (alongside
  the pre-existing `CMSRBOX1` wrapping subkey), turns it into a signing keypair via
  `generateSigningKeyPairFromSeed(signingSeed)`, and signs the recovery authorization preimage
  with that key (`this.crypto.sign(recoverySigning.secretKey, authorizationPreimage)`) — not
  with `candidate.signing.secretKey`. The derived seed material (`signingSeed`,
  `recoverySigning.secretKey`) is explicitly zeroed after use.
- `src/relay/domain/types.ts:280` — `RecoveryPackageRecordSchema` now has a required
  `recoverySigningPublicKey: relayBase64UrlBytesSchema(32, ...)` field.
- `src/relay/storage/in-memory-relay-store.ts` and `src/relay/storage/sqlite-relay-store.ts`
  both persist `RecoveryPackageRecord` as an opaque typed object / `record_json` blob
  respectively, so the new field round-trips through both stores without additional per-field
  wiring (confirmed by reading `putRecoveryPackage`/`getActiveRecoveryPackage` in both files —
  no field allowlist strips it).
- `src/relay/service/opaque-relay-service.ts:189` (`handleMembershipCas` recovery branch) now
  verifies `request.recoveryAuthorization.signature` against
  `activePackage.recoverySigningPublicKey` — the stored, seed-derived key — not
  `candidate.signingPublicKey`. `candidate.signingPublicKey` is still checked separately at
  line 192 for the device's own device-identity commit signature, which is the correct,
  orthogonal check.
- Adversarial regression test: `tests/sync/recovery.test.ts` — new suite "adversarial
  account-only enrollment (CR-01)" containing "rejects a self-signed membership.cas from a
  candidate that never possessed the recovery seed" — **PASSING**
  (`npx vitest run tests/sync/recovery.test.ts` → 12/12 tests pass, including this one).

**Verdict:** CR-01 is closed. Recovery-seed possession is now cryptographically bound into
enrollment; account access alone can no longer author a valid recovery authorization.

### CR-02 (REQ-031/REQ-034, and REQ-035 by extension) — closed

**Claim:** the producer computed `previousEnvelopeHash` as a SHA-256 digest of the entire
base64-encoded envelope JSON blob, while the verifier required the predecessor's BLAKE2b
`ciphertextDigest` — two different values by construction — causing every envelope at
device-sequence ≥ 2 to be rejected `SYNC_INTEGRITY_FAILED` on every peer, blocking convergence
beyond one operation per device.

**Evidence the fix is real and complete:**

- `src/sync/replication/sync-replication-service.ts:171-202` (`sealOne`) now sets
  `previousEnvelopeHash = predecessorEnvelope.ciphertextDigest` (line 193), sourced from the
  predecessor's own already-sealed `EncryptedSyncEnvelope.ciphertextDigest` (BLAKE2b
  generichash over ciphertext bytes), matching `ReplayVerifier.chainDigestOf` exactly per the
  inline comment at lines 186-192. The old `sha256HexOfBase64(envelopeBytesBase64)` helper
  still exists (line 96) but is now only used for `sealedEnvelopeDigest` — a local
  row-identity/bookkeeping digest, no longer fed into the wire chain header. No re-encryption,
  no schema change.
- `src/sync/replication/replay-verifier.ts` is unchanged (it was already internally correct;
  the defect was entirely on the producer side) — still compares
  `header.previousEnvelopeHash` against the predecessor's `ciphertextDigest`.
- New test: `tests/sync/replay-equivocation.test.ts` — "accepts a correctly-produced
  sequence-2 envelope (producer<->verifier round-trip)" — **PASSING**.
- New integration test: `tests/integration/multi-device-sync.test.ts` — "converges a
  >=2-operations-per-device history through the real network boundary (CR-02)" — **PASSING**.
- `npx vitest run tests/sync/replay-equivocation.test.ts tests/integration/multi-device-sync.test.ts`
  → 16/16 tests pass (10 + 6).

**Verdict:** CR-02 is closed. Producer and verifier now agree on the chain-digest source;
multi-operation histories converge across devices over the real HTTP loopback transport.

### Full Suite and Typecheck

- `npm test` → **77 test files, 672 tests, all passing** (matches the expected ~672 count).
- `npm run typecheck` → clean, no errors.
- `grep -n -E "TBD|FIXME|XXX"` across the six files touched by the CR-01/CR-02 fixes
  (`sync-control-service.ts`, `opaque-relay-service.ts`, `relay/domain/types.ts`,
  `sync-replication-service.ts`, `replay-verifier.ts`, both relay stores) → no matches.

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Content is encrypted client-side before transmission; relay possesses no decryption key (REQ-031) | VERIFIED | Unchanged from initial verification: `sealSyncEnvelope`/`openSyncEnvelope` device-side only; relay code never imports crypto-open functions. Also now unblocked end-to-end for multi-operation histories by the CR-02 fix (previously the *transport* of REQ-031 payloads failed for sequence ≥2; now confirmed accepted). |
| 2 | New devices join via authorized-device approval OR recovery-key possession, and account access alone is insufficient (REQ-032) | VERIFIED | CR-01 closed: recovery authorization is now signed with a `CMSRSIG1` seed-derived key and verified against the stored `recoverySigningPublicKey`, not the candidate's own key. Adversarial account-only rejection test passing. |
| 3 | Device revocation is enforceable and rotates future keys without destroying local history (REQ-033) | VERIFIED | Unchanged from initial verification — `tests/sync/revocation.test.ts` and relay `membership-cas` tests passing in full suite; no regression introduced by the gap-closure plans (07/08/09/10/11/12/13 all green). |
| 4 | Concurrent device changes converge after reconnection without a single online writer (REQ-034) | VERIFIED | CR-02 closed: chain-digest producer/verifier agreement confirmed by direct code reading and by a genuine sequence-2 acceptance test plus a real-network ≥2-ops-per-device convergence test, both passing. |
| 5 | Deletions/revocations propagate with auditable tombstones and cannot be reintroduced by stale peers (REQ-035) | VERIFIED | Previously flagged "at risk" only because it rides the same replication pipeline broken by CR-02; that pipeline is now fixed and the full `tests/sync/deletion-tombstones.test.ts` suite passes as part of the 672-test green run. No independent regression found. |
| 6 | Relay stores only metadata required for routing/authorization/replay-protection/convergence — no semantic content (REQ-036) | VERIFIED | Unchanged from initial verification; `RecoveryPackageRecordSchema`'s new `recoverySigningPublicKey` field is itself just a public key (opaque, non-semantic), consistent with the existing allowlist discipline. |

**Score:** 6/6 truths verified.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/relay/service/opaque-relay-service.ts` | Zero-knowledge relay orchestration; recovery enrollment gated on recovery-seed possession | VERIFIED | `handleMembershipCas` recovery branch (line 189) now verifies against `activePackage.recoverySigningPublicKey`. |
| `src/sync/control/sync-control-service.ts` | Client-side enrollment/recovery/revocation state machine deriving recovery credentials per ADR 0047 | VERIFIED | `enrollViaRecovery` (lines 406-430) derives both `CMSRBOX1` and `CMSRSIG1` subkeys and signs with the latter. |
| `src/relay/domain/types.ts` | `RecoveryPackageRecord` carries a persisted recovery signing public key | VERIFIED | `recoverySigningPublicKey` required field at line 280. |
| `src/sync/replication/sync-replication-service.ts` | Producer: seals outbox rows into hash-chained envelopes, chain source matching the verifier | VERIFIED | `sealOne` (line 193) sources `previousEnvelopeHash` from `predecessorEnvelope.ciphertextDigest`. |
| `src/sync/replication/replay-verifier.ts` | Verifier: rejects rollback/fork via hash chain before AEAD open | VERIFIED | Unchanged; now agrees with the producer. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `sync-control-service.ts` `enrollViaRecovery` recovery authorization | `opaque-relay-service.ts` `handleMembershipCas` recovery verification | `verifyDetached(activePackage.recoverySigningPublicKey, authorizationPreimage, signature)` | WIRED | Producer signs with the seed-derived `CMSRSIG1` key; relay verifies against the persisted `recoverySigningPublicKey` from the same record. Root cause of CR-01 eliminated. |
| `sync-replication-service.ts` `sealOne` (producer) | `replay-verifier.ts` `verify` (consumer) | `header.previousEnvelopeHash` field | WIRED | Both sides now agree the value is the predecessor's `ciphertextDigest` (BLAKE2b generichash over ciphertext bytes). Root cause of CR-02 eliminated. |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| REQ-031 | 06-02, 06-05, 06-08, 06-10 | End-to-end encryption; relay possesses no decryption keys | SATISFIED | Encryption boundary sound; replication pipeline now carries multi-op payloads correctly (CR-02 closed). |
| REQ-032 | 06-06, 06-08, 06-09 | Device enrollment via authorized-device approval or recovery key | SATISFIED | CR-01 closed: recovery-seed possession is cryptographically required; adversarial test passing. |
| REQ-033 | 06-05, 06-06, 06-08 | Device revocation + future key rotation without losing local history | SATISFIED | Code and dedicated tests present and passing; no regression from gap-closure plans. |
| REQ-034 | 06-04, 06-07, 06-08, 06-10 | Offline convergence for concurrent changes | SATISFIED | CR-02 closed: real ≥2-ops-per-device convergence test passing over the HTTP loopback transport. |
| REQ-035 | 06-04, 06-07, 06-08, 06-10 | Deletion propagation with auditable, non-reintroducible tombstones | SATISFIED | Rides the now-fixed replication pipeline; full tombstone test suite green. |
| REQ-036 | 06-05, 06-06, 06-08, 06-09 | Minimal relay metadata | SATISFIED | Field-allowlist review confirms no semantic/plaintext data crosses the relay boundary; new field is an opaque public key. |

### Anti-Patterns Found

None in the CR-01/CR-02 fix files (`sync-control-service.ts`, `opaque-relay-service.ts`,
`relay/domain/types.ts`, `sync-replication-service.ts`, `replay-verifier.ts`,
`in-memory-relay-store.ts`, `sqlite-relay-store.ts`) — no `TBD`/`FIXME`/`XXX` markers.
Plans 06-11..06-13 (WR-hardening items) were out of mandate for this re-verification pass,
which was scoped to confirming closure of the two BLOCKER findings; the full test suite
(672 tests) including their coverage passes green with no observed regressions.

### Behavioral Spot-Checks / Probe Execution

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| CR-01 adversarial rejection | `npx vitest run tests/sync/recovery.test.ts` | 12/12 passed, incl. "rejects a self-signed membership.cas from a candidate that never possessed the recovery seed" | PASS |
| CR-02 sequence-2 acceptance + convergence | `npx vitest run tests/sync/replay-equivocation.test.ts tests/integration/multi-device-sync.test.ts` | 16/16 passed, incl. "accepts a correctly-produced sequence-2 envelope" and "converges a >=2-operations-per-device history through the real network boundary (CR-02)" | PASS |
| Full suite | `npm test` | 77 files / 672 tests passed | PASS |
| Type safety | `npm run typecheck` | clean | PASS |

### Human Verification Required

None. Both prior findings and their fixes are deterministic code-level facts confirmable by
static reading and automated test execution.

### Gaps Summary

Both BLOCKER findings recorded in the prior `06-VERIFICATION.md` are now closed, confirmed by
independent reading of the live source (not the SUMMARYs):

1. **CR-01 (REQ-032) — closed.** `sync-control-service.ts` `enrollViaRecovery` now derives a
   `CMSRSIG1` recovery signing credential from the recovery seed and signs the recovery
   authorization with it; `opaque-relay-service.ts` `handleMembershipCas` now verifies that
   signature against the persisted `recoverySigningPublicKey` (a new required field on
   `RecoveryPackageRecord`, round-tripping through both relay stores) rather than the
   candidate's own key. An adversarial regression test proves account-only (no-seed)
   enrollment is rejected.

2. **CR-02 (REQ-031/REQ-034, and REQ-035 by extension) — closed.** `sync-replication-service.ts`
   `sealOne` now sources `previousEnvelopeHash` from the predecessor's own `ciphertextDigest`
   (matching `ReplayVerifier.chainDigestOf` exactly) instead of a SHA-256 digest of the whole
   base64 envelope JSON. A genuine sequence-2 envelope now verifies, and a real-network
   ≥2-operations-per-device convergence test passes.

The full suite (672 tests) and `tsc --noEmit` are both green. Per the task's standing
instruction, the absence of independent external cryptographic review is not flagged — ADR
0047 carries an explicit Owner Risk Acceptance appropriate for this personal single-user
deployment, and that acceptance's scope is unaffected by this re-verification.

Phase 6 goal — "Synchronize memory without giving the relay decryption capability" — is
achieved: encryption remains device-side only, the relay never gains decryption capability
(including via the recovery path, now that CR-01 is closed), and synchronization itself now
functions correctly for realistic multi-operation histories (CR-02 closed).

---

_Verified: 2026-07-20T13:31:00Z_
_Verifier: Claude (gsd-verifier)_
