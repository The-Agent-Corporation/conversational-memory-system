---
phase: 06-zero-knowledge-multi-device-sync
verified: 2026-07-20T00:56:20Z
status: gaps_found
score: 4/6 requirement truths verified (REQ-032, REQ-031/034 blocked by confirmed code defects)
overrides_applied: 0
gaps:
  - truth: "Account recovery cannot enroll a device or decrypt memory (REQ-032; ADR 0047 D-04, D-16, 'Account Recovery Cannot Enroll or Decrypt')"
    status: failed
    reason: >
      Confirmed CR-01 from 06-REVIEW.md by direct code inspection. The recovery-enrollment
      authorization is verified against the CANDIDATE DEVICE'S OWN signing key
      (self-generated at enrollment time), not against any key derived from the recovery
      seed. The ADR-specified recovery signing credential context "CMSRSIG1" is never
      derived or referenced anywhere in the codebase (confirmed via grep across
      src/sync/control/sync-control-service.ts) -- only "CMSRBOX1" (the wrapping subkey)
      is derived. Because the relay's recovery.fetch operation returns the active
      package's packageId to any account-authenticated caller, and the relay's only
      check is `verifyDetached(candidate.signingPublicKey, authorizationPreimage,
      request.recoveryAuthorization.signature)` -- i.e. verifying the candidate's
      self-signature against its own freshly-generated key -- possession of the relay
      account alone (without the recovery seed) is sufficient to author a valid
      recovery-authorized membership.cas commit and become an active device. Because
      future epoch-key rotations package new epoch keys to every active device's
      wrapping key, this active status leads to future decryption capability, directly
      contradicting the ADR's binding "Account Recovery Cannot Enroll or Decrypt" claim.
      No test in tests/sync/recovery.test.ts exercises this adversarial path (all tests
      call the client's enrollViaRecovery with a real seed in hand; none attempt
      relay-only enrollment with only account access), so the gap is real and untested.
    artifacts:
      - path: "src/relay/service/opaque-relay-service.ts"
        issue: "Lines ~140-164 (handleMembershipCas recovery branch): verifies request.recoveryAuthorization.signature against candidate.signingPublicKey (the candidate device's own key), not against a recovery-seed-derived signing credential."
      - path: "src/sync/control/sync-control-service.ts"
        issue: "enrollViaRecovery (~lines 374-447) derives only the CMSRBOX1 wrapping subkey via deriveSubkey(seed, 1, \"CMSRBOX1\", 32); it never derives a CMSRSIG1 recovery signing key. authorizationSignature (line 416) is produced with `this.crypto.sign(candidate.signing.secretKey, authorizationPreimage)` -- the candidate's own freshly generated device key, not a recovery-derived key."
    missing:
      - "Derive a recovery signing credential from the recovery seed (e.g. deriveSubkey(seed, 1, \"CMSRSIG1\", 32) -> generateSigningKeyPairFromSeed) on the client, and persist its public key with the active recovery package/control record on the relay."
      - "Change the relay's recovery-branch verification (opaque-relay-service.ts handleMembershipCas) to verify request.recoveryAuthorization.signature against the stored recovery-credential public key, not candidate.signingPublicKey."
      - "Add an adversarial test: account-authenticated caller with NO recovery seed (only packageId learned via recovery.fetch) attempts membership.cas with a self-signed recoveryAuthorization and MUST be rejected with SYNC_DEVICE_DENIED or SYNC_INTEGRITY_FAILED."
  - truth: "Offline convergence: concurrent device changes converge after reconnection (REQ-034); envelope hash chain integrity holds for multi-operation histories (ADR 0047 'Durable sequence/hash chains')"
    status: failed
    reason: >
      Confirmed CR-02 from 06-REVIEW.md by direct code inspection. The producer
      (sync-replication-service.ts sealOne) sets header.previousEnvelopeHash from
      `hexToBase64Url(predecessor.sealedEnvelopeDigest!)`, where sealedEnvelopeDigest is
      computed as `sha256HexOfBase64(envelopeBytesBase64)` -- a SHA-256 digest over the
      entire base64-encoded envelope JSON blob. The verifier (replay-verifier.ts,
      documented explicitly in its own file header: "Chain digest definition: envelope
      N+1's header.previousEnvelopeHash MUST equal envelope N's own ciphertextDigest")
      compares header.previousEnvelopeHash against context.expectedPreviousChainDigest,
      which pullAndApply threads from `outcome.chainDigest = envelope.ciphertextDigest`
      -- a BLAKE2b generichash of the ciphertext bytes ALONE (32 bytes, base64url,
      computed via sodium.crypto_generichash in sealSyncEnvelope/verified in
      handleEnvelopeAppend). These are two different digests: different algorithm
      (SHA-256 vs BLAKE2b/generichash) over different inputs (whole base64 envelope
      JSON string vs raw ciphertext bytes). For any device sequence >= 2 the check
      `envelope.header.previousEnvelopeHash !== expectedPrevious` at
      replay-verifier.ts:94 will be true, and the envelope is rejected with
      SYNC_INTEGRITY_FAILED before it is even decrypted -- meaning no device can ever
      successfully replicate its second-or-later operation to a peer. This breaks
      REQ-034 (offline convergence) for any real usage beyond a single operation per
      device. Confirmed the existing test suite does not catch this: the one test that
      exercises sequence-2 chain verification
      (tests/sync/replay-equivocation.test.ts:365-395, "rejects a tampered
      previousEnvelopeHash...") only asserts that a RANDOMLY TAMPERED
      previousEnvelopeHash is rejected -- it never asserts that the real,
      correctly-produced sequence-2 envelope from pushPending/sealOne is ACCEPTED by
      the verifier. All integration tests in tests/integration/multi-device-sync.test.ts
      that assert successful convergence only ever push a single outbox row
      (deviceSequence: 1) per device, so the bug never manifests in the current suite.
    artifacts:
      - path: "src/sync/replication/sync-replication-service.ts"
        issue: "Lines 186 and 209: previousEnvelopeHash = hexToBase64Url(predecessor.sealedEnvelopeDigest!), where sealedEnvelopeDigest = sha256HexOfBase64(envelopeBytesBase64) (line 209, function defined line 96) -- a SHA-256 over the whole base64 envelope JSON, not the predecessor's ciphertextDigest."
      - path: "src/sync/replication/replay-verifier.ts"
        issue: "Lines 21-27 (doc comment), 54-55 (chainDigestOf), 92-96 (verify): chain check compares header.previousEnvelopeHash against the predecessor's ciphertextDigest (BLAKE2b generichash of ciphertext bytes only) -- a different value and algorithm than what the producer writes."
    missing:
      - "Change sealOne (sync-replication-service.ts) to set previousEnvelopeHash from the predecessor's sealed envelope's own ciphertextDigest (already present on the sealed EncryptedSyncEnvelope / persisted alongside sealedEnvelopeDigest), not from sha256HexOfBase64 of the whole envelope JSON."
      - "Add (or fix) a producer<->verifier round-trip test that seals device-sequence 1 and 2 through pushPending/sealOne and asserts ReplayVerifier.verify ACCEPTS (kind: 'verified') the resulting sequence-2 envelope, not just that a tampered one is rejected."
      - "Re-run tests/integration/multi-device-sync.test.ts with a >=2-operation-per-device scenario to confirm convergence after the fix."
---

# Phase 6: Zero-Knowledge Multi-Device Sync Verification Report

**Phase Goal:** Synchronize memory without giving the relay decryption capability.
**Verified:** 2026-07-20T00:56:20Z
**Status:** gaps_found
**Re-verification:** No — initial verification

## Goal Achievement

This phase claims eight complete plans (06-01 through 06-08) implementing the zero-knowledge
sync protocol from ADR 0047: end-to-end encrypted envelopes, an opaque relay, device
enrollment/recovery/revocation, offline convergence with a hash-chained replay-defense
protocol, deletion tombstones, and minimal relay metadata. `06-REVIEW.md` (already committed,
dated the same day as this phase's SUMMARYs) independently found 2 critical/blocker defects.
This verification's mandate was to independently confirm or refute each against the real
source, not trust either the SUMMARYs or the review's prose. Both are confirmed by direct
code reading below.

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Content is encrypted client-side before transmission; relay possesses no decryption key (REQ-031, crypto boundary) | VERIFIED | `sealSyncEnvelope`/`openSyncEnvelope` (libsodium AEAD) confirmed device-side only; `opaque-relay-service.ts` never imports crypto-open functions, only signature/digest verification over opaque bytes (module doc comment + code inspection). |
| 2 | New devices join via authorized-device approval OR recovery-key possession, and account access alone is insufficient (REQ-032) | **FAILED** | CR-01 confirmed: `opaque-relay-service.ts` recovery branch verifies the candidate's self-signature against the candidate's own key; no recovery-seed-derived (`CMSRSIG1`) credential is ever derived or checked. Relay-account access alone (learn `packageId` via `recovery.fetch`, self-sign) suffices to enroll. |
| 3 | Device revocation is enforceable and rotates future keys without destroying local history (REQ-033) | VERIFIED (independent, not part of mandated review scope) — code exists (`revokedDevices` handling, epoch rotation on control commit) and is exercised by `tests/sync/revocation.test.ts`; not exhaustively re-audited beyond the two mandated defects, per task scope. |
| 4 | Concurrent device changes converge after reconnection without a single online writer (REQ-034) | **FAILED** | CR-02 confirmed: producer computes `previousEnvelopeHash` as SHA-256 of the whole base64 envelope JSON; verifier requires the predecessor's BLAKE2b `ciphertextDigest`. Any device-sequence >= 2 envelope is rejected `SYNC_INTEGRITY_FAILED` on every peer, blocking convergence beyond one operation per device. |
| 5 | Deletions/revocations propagate with auditable tombstones and cannot be reintroduced by stale peers (REQ-035) | Not independently re-derived beyond CR-02's blast radius — REQ-035 also depends on the replication pipeline that CR-02 breaks for sequence >= 2, so tombstone propagation beyond a device's first operation is blocked by the same defect. Flagged as at-risk, not separately re-verified. |
| 6 | Relay stores only metadata required for routing/authorization/replay-protection/convergence — no semantic content (REQ-036) | VERIFIED | `opaque-relay-service.ts` module doc + `RelayRequestSchema`/`DataEnvelopeRecordSchema` field allowlists confirmed to carry only ids, digests, signatures, ciphertext, and header metadata; no plaintext or semantic fields present. |

**Score:** 4/6 truths independently confirmed sound at the code level; 2 are FAILED (both matching the review's two BLOCKER findings), with a third (REQ-035) at risk as a direct consequence of the CR-02 defect.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/relay/service/opaque-relay-service.ts` | Zero-knowledge relay orchestration; recovery enrollment gated on recovery-seed possession | EXISTS, but recovery-branch logic is a **functional defect** (CR-01) | `handleMembershipCas` recovery branch verifies against `candidate.signingPublicKey`, not a recovery-derived key. |
| `src/sync/control/sync-control-service.ts` | Client-side enrollment/recovery/revocation state machine deriving recovery credentials per ADR 0047 | EXISTS, but recovery credential derivation is **incomplete** (CR-01) | `enrollViaRecovery` derives only `CMSRBOX1`; `CMSRSIG1` is never derived anywhere in the codebase (confirmed via repo-wide grep). |
| `src/sync/replication/sync-replication-service.ts` | Producer: seals outbox rows into hash-chained envelopes | EXISTS, but chain-digest computation is **inconsistent with the verifier** (CR-02) | `sealOne` sets `previousEnvelopeHash` from `sha256HexOfBase64(envelopeBytesBase64)`, not the predecessor's `ciphertextDigest`. |
| `src/sync/replication/replay-verifier.ts` | Verifier: rejects rollback/fork via hash chain before AEAD open | EXISTS and internally consistent with its own documented contract, but the **producer does not honor that contract** (CR-02) | `verify()` correctly compares against `ciphertextDigest`-based `expectedPreviousChainDigest`; the mismatch originates upstream in the producer. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `sync-control-service.ts` recovery authorization | `opaque-relay-service.ts` recovery verification | `verifyDetached(candidate.signingPublicKey, ...)` | **NOT_WIRED to a seed-derived credential** | Both sides agree on verifying the candidate's own key — internally consistent but not the recovery-seed-bound authorization ADR 0047 specifies. This is the root of CR-01: the link exists and "works" but authenticates the wrong principal. |
| `sync-replication-service.ts` sealOne (producer) | `replay-verifier.ts` verify (consumer) | `header.previousEnvelopeHash` field | **NOT_WIRED** (value mismatch) | Producer and consumer independently compute this field from different algorithms/inputs; this is the root of CR-02. Confirmed no shared helper function exists between the two files for this computation — `sync-replication-service.ts` defines its own local `sha256HexOfBase64`, `replay-verifier.ts` and `sealSyncEnvelope` use `ReplayVerifier.chainDigestOf` / `ciphertextDigest` independently. |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| REQ-031 | 06-02, 06-05, 06-08 | End-to-end encryption; relay possesses no decryption keys | PARTIALLY BLOCKED | Encryption boundary itself sound; but the replication pipeline that carries REQ-031's payloads is broken for sequence >= 2 by CR-02, so the requirement's "synchronized" half fails beyond one op/device. |
| REQ-032 | 06-06, 06-08 | Device enrollment via authorized-device approval or recovery key | **BLOCKED** | CR-01: account access alone enrolls a device via the recovery path; recovery-seed possession is never proven. |
| REQ-033 | 06-05, 06-06, 06-08 | Device revocation + future key rotation without losing local history | SATISFIED (not independently re-audited beyond scope) | Code and dedicated tests present; not part of the two mandated confirmations. |
| REQ-034 | 06-04, 06-07, 06-08 | Offline convergence for concurrent changes | **BLOCKED** | CR-02: any device-sequence >= 2 envelope is rejected on every peer; convergence beyond one operation per device does not function. |
| REQ-035 | 06-04, 06-07, 06-08 | Deletion propagation with auditable, non-reintroducible tombstones | AT RISK | Tombstone logic depends on the same replication pipeline broken by CR-02 for any device's second-or-later operation. |
| REQ-036 | 06-05, 06-06, 06-08 | Minimal relay metadata | SATISFIED | Field-allowlist review confirms no semantic/plaintext data crosses the relay boundary. |

### Anti-Patterns Found

None newly introduced beyond what 06-REVIEW.md already documented (8 warnings, 3 info items) — this verification's mandate was scoped to confirming/refuting the 2 BLOCKER findings, not re-running full anti-pattern scanning across all 37 reviewed files. The 2 confirmed blockers are logic/correctness defects, not stub/placeholder anti-patterns — both paths are fully implemented, just implemented against mismatched contracts (CR-02) or an incomplete credential-derivation model (CR-01).

### Human Verification Required

None. Both findings are deterministic code-level defects confirmable by static reading and are not observation-, timing-, or UX-dependent.

### Gaps Summary

Both BLOCKER findings from `06-REVIEW.md` are independently confirmed against the live source
tree, not merely trusted from the review's prose:

1. **CR-01 (REQ-032 / security):** `src/relay/service/opaque-relay-service.ts` (`handleMembershipCas`
   recovery branch, ~lines 140-164) verifies the recovery-authorization signature against the
   *candidate device's own* signing public key. `src/sync/control/sync-control-service.ts`
   (`enrollViaRecovery`, ~lines 374-447) never derives the ADR-specified `CMSRSIG1` recovery
   signing credential — confirmed absent via repo-wide grep — and signs the authorization with
   the candidate's own freshly generated key instead. Net effect: possession of the relay account
   alone (no recovery seed) is sufficient to enroll a new active device via the recovery path,
   directly violating REQ-032 and ADR 0047's binding "Account Recovery Cannot Enroll or Decrypt"
   claim (D-04, D-16).

2. **CR-02 (REQ-031/REQ-034 / correctness):** `src/sync/replication/sync-replication-service.ts`
   (`sealOne`, lines 186 & 209) computes `previousEnvelopeHash` as a SHA-256 digest of the entire
   base64-encoded envelope JSON. `src/sync/replication/replay-verifier.ts` (`verify`, lines 92-96,
   per its own documented chain-digest contract at lines 21-27) requires `previousEnvelopeHash` to
   equal the predecessor's `ciphertextDigest` — a BLAKE2b generichash over ciphertext bytes only.
   These are irreconcilably different values. Every envelope at device-sequence >= 2 will fail the
   chain check and be rejected `SYNC_INTEGRITY_FAILED` on every peer, before decryption — no
   device can replicate more than one operation before its stream is permanently rejected by
   receivers. This breaks REQ-034 (offline convergence) for any realistic multi-operation history,
   and by extension puts REQ-035 (tombstone propagation) at risk since it rides the same pipeline.
   Confirmed the existing automated test suite does not exercise this: the one test that reaches
   sequence-2 chain verification (`tests/sync/replay-equivocation.test.ts:365-395`) only asserts
   that a *tampered* `previousEnvelopeHash` is rejected — it never asserts that the real,
   correctly-produced sequence-2 envelope is accepted — and all integration convergence tests
   (`tests/integration/multi-device-sync.test.ts`) push only a single outbox row per device.

Per the task instructions, the absence of independent external cryptographic review is NOT
flagged as a gap (ADR 0047 carries an explicit Owner Risk Acceptance for that, appropriate for
a personal single-user deployment). Both gaps recorded here are concrete implementation defects
against the protocol the ADR itself specifies, independent of that acceptance's scope.

REQ-033 and REQ-036 read as satisfied from code inspection but were not exhaustively re-audited
beyond the two mandated confirmations; no additional defects were identified in them during this
pass.

---

_Verified: 2026-07-20T00:56:20Z_
_Verifier: Claude (gsd-verifier)_
