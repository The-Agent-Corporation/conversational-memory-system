---
phase: 06-zero-knowledge-multi-device-sync
reviewed: 2026-07-19T00:00:00Z
depth: standard
files_reviewed: 37
files_reviewed_list:
  - docs/adr/0047-zero-knowledge-sync-threat-model-and-protocol.md
  - scripts/benchmark-sync-padding.mjs
  - scripts/verify-phase06-evidence.mjs
  - src/boxes/box-reviewer.ts
  - src/daemon/daemon-command.ts
  - src/daemon/daemon.ts
  - src/imports/codex-importer.ts
  - src/mcp/mutation-application.ts
  - src/mcp/server.ts
  - src/proposals/proposal-reviewer.ts
  - src/relay/auth/relay-account-authenticator.ts
  - src/relay/domain/types.ts
  - src/relay/http/relay-http-server.ts
  - src/relay/service/opaque-relay-service.ts
  - src/relay/storage/in-memory-relay-store.ts
  - src/relay/storage/relay-store.ts
  - src/relay/storage/sqlite-relay-store.ts
  - src/service/memory-service.ts
  - src/service/source-lifecycle-service.ts
  - src/storage/in-memory-store.ts
  - src/storage/memory-store.ts
  - src/storage/sqlite-store.ts
  - src/storage/sync-contracts.ts
  - src/sync/control/sync-control-service.ts
  - src/sync/crypto/crypto-provider.ts
  - src/sync/crypto/libsodium-crypto-provider.ts
  - src/sync/domain/types.ts
  - src/sync/materialization/sync-materializer.ts
  - src/sync/replication/replay-verifier.ts
  - src/sync/replication/sync-replication-service.ts
  - src/sync/replication/sync-status.ts
  - src/sync/secrets/device-secret-store.ts
  - src/sync/secrets/in-memory-device-secret-store.ts
  - src/sync/secrets/macos-keychain-helper.swift
  - src/sync/secrets/macos-keychain-secret-store.ts
  - src/sync/transport/http-sync-relay.ts
  - src/sync/transport/sync-relay.ts
findings:
  critical: 2
  warning: 8
  info: 3
  total: 13
status: issues_found
---

# Phase 6: Code Review Report

**Reviewed:** 2026-07-19
**Depth:** standard
**Files Reviewed:** 37
**Status:** issues_found

## Summary

Reviewed the Phase 06 zero-knowledge multi-device sync implementation: libsodium crypto boundary, envelope seal/open, opaque relay service + HTTP boundary + stores, control-plane enrollment/recovery/revocation state machines, replication push/pull + replay verifier + materializer, macOS Keychain helper/adapter, and the Phase 05 producers wired to emit sync outbox rows.

The crypto envelope primitives (`sealSyncEnvelope`/`openSyncEnvelope`), the relay zero-knowledge field allowlists, the account-provider pseudonymization boundary, and the staged-clone CAS stores are careful and largely sound. Two defects are load-bearing, however: (1) the **recovery-key enrollment path never proves possession of the recovery seed**, so relay-account access alone can enroll a new active device — the exact outcome the ADR names as a binding prohibition (D-04 / D-16, "Account Recovery Cannot Enroll or Decrypt"); and (2) the **per-device envelope hash chain is computed inconsistently between producer and verifier**, so any sequence ≥ 2 will fail chain verification on a receiving device.

Note on scope: the ADR carries an owner risk acceptance for the *absence of an independent cryptographic review*. The findings below are concrete implementation defects that deviate from the protocol the ADR itself specifies — they are in scope regardless of that acceptance.

## Critical Issues

### CR-01: Recovery enrollment does not prove recovery-seed possession — account access alone can enroll a device

**File:** `src/relay/service/opaque-relay-service.ts:140-164`, `src/sync/control/sync-control-service.ts:388-447`
**Issue:** ADR 0047 (D-04, REQ-032, "Recovery-key enrollment") requires that a recovery enrollment be authorized by BOTH an authenticated relay account AND a proof of possession of the current recovery seed. The recovery derivation table defines a recovery *signing* credential (context `CMSRSIG1`, subkey 1) precisely to sign that proof.

In the implementation the recovery authorization is signed by the **candidate device's own freshly-generated signing key**, not by any recovery-derived key:
- `enrollViaRecovery` derives only the wrapping seed (`deriveSubkey(seed, 1, "CMSRBOX1", 32)`); the `CMSRSIG1` recovery signing key is never derived or used anywhere in the codebase. The authorization is `this.crypto.sign(candidate.signing.secretKey, authorizationPreimage)`.
- The relay's recovery branch only checks `activePackage.packageId === request.recoveryAuthorization.packageId` and then `verifyDetached(candidate.signingPublicKey, authorizationPreimage, ...)` — i.e. it verifies the candidate signed with the candidate's own key.

`packageId` is obtainable by any account-authenticated caller via `recovery.fetch`. An attacker who has only compromised/recovered the relay account (no recovery seed) can therefore: fetch the active package to learn `packageId`, generate a candidate device, self-sign the authorization, and commit `membership.cas`. The relay accepts it and the device becomes `active`. Because future epoch rotations package the new epoch key to every active device's wrapping key, that malicious device would receive future epoch keys from legitimate devices' rotations — gaining future decryption, not merely relay access. This breaks the ADR's headline claim "Account Recovery Cannot Enroll or Decrypt."
**Fix:** Bind possession of the recovery seed into the authorization. Derive the recovery signing credential (`deriveSubkey(seed, 1, "CMSRSIG1", 32)` → `generateSigningKeyPairFromSeed`) and have the relay verify the authorization signature against the recovery credential public key that is committed as `recoveryCredentialId`/stored with the active package — not against the candidate's own key:
```ts
// client
const sigSeed = this.crypto.deriveSubkey(seed, 1, "CMSRSIG1", 32);
const recoverySigning = this.crypto.generateSigningKeyPairFromSeed(sigSeed);
const authorizationSignature = toB64(this.crypto.sign(recoverySigning.secretKey, authorizationPreimage));
// relay: verify against the stored recovery-credential public key, not candidate.signingPublicKey
```
The active recovery package (or control record) must persist the recovery signing public key so the relay can verify seed possession.

### CR-02: Envelope hash-chain is computed inconsistently between producer and verifier — sequence ≥ 2 fails verification

**File:** `src/sync/replication/sync-replication-service.ts:186,209` vs `src/sync/replication/replay-verifier.ts:54,92-96`
**Issue:** `ReplayVerifier` (and its doc contract) defines the chain digest as the previous envelope's `ciphertextDigest` (base64url of the 32-byte generic hash of the ciphertext); `pullAndApply` correctly feeds `expectedPreviousChainDigest = outcome.chainDigest = envelope.ciphertextDigest`.

But the producer sets `previousEnvelopeHash` from a different value. In `sealOne`, the stored `sealedEnvelopeDigest` is `sha256HexOfBase64(envelopeBytesBase64)` — a SHA-256 over the whole base64 envelope JSON — and the next sequence's header uses `previousEnvelopeHash = hexToBase64Url(predecessor.sealedEnvelopeDigest!)`. That is not the predecessor's `ciphertextDigest` (a BLAKE2b generic hash of the ciphertext bytes). The two digests are computed over different inputs with different algorithms, so for any sequence ≥ 2 the verifier's `envelope.header.previousEnvelopeHash !== expectedPrevious` check fails and the envelope is rejected `SYNC_INTEGRITY_FAILED`, blocking multi-device convergence for any device that has produced more than one operation. (The value still passes the 32-byte schema length check, so it fails only at runtime chain comparison, not at parse.)
**Fix:** Chain on the previous envelope's `ciphertextDigest`. Persist the sealed envelope's `ciphertextDigest` (already present on the sealed `EncryptedSyncEnvelope`) and use it as the successor's `previousEnvelopeHash`:
```ts
// use the sealed envelope's own ciphertextDigest (base64url) as the chain link,
// not sha256 of the JSON bytes:
previousEnvelopeHash = predecessor.sealedCiphertextDigestBase64Url;
```
Add a producer↔verifier round-trip test that seals sequence 1 and 2 and asserts `ReplayVerifier.verify` accepts sequence 2.

## Warnings

### WR-01: `takePlan` ternary returns the plan even on a kind mismatch

**File:** `src/mcp/mutation-application.ts:215-219`
**Issue:** `return plan?.kind === expectedKind ? plan : plan;` — both branches return `plan`, so the kind guard is dead. The method returns any stored plan regardless of the requested kind. Callers re-check `plan.kind` afterward, so this is not currently exploitable, but it defeats the method's stated contract and is a latent defect if a caller ever trusts the return.
**Fix:** `return plan?.kind === expectedKind ? plan : undefined;`

### WR-02: Client-side remote-apply gap loop is unbounded (ADR mandates a 1,024 cap)

**File:** `src/storage/in-memory-store.ts:947-957` (and the SQLite analog `src/storage/sqlite-store.ts:1210-1234`)
**Issue:** On a forward gap, `commitRemoteSyncApply` iterates `for (missing = frontier+1; missing < sequence; missing++)` with no bound and allocates one `PendingSyncGap` per slot. ADR 0047 ("Data Plane…", T-06-07) requires rejecting jumps beyond 1,024 with `SYNC_GAP_LIMIT` and NOT allocating proportional work. The relay enforces `MAX_RETAINED_GAP_SLOTS` on append, but a malicious/misbehaving relay is explicitly in the threat model; a single validly-signed high-sequence envelope would drive proportional client allocation.
**Fix:** Cap the jump: if `sequence > frontier + MAX_RETAINED_GAP_SLOTS`, return a `GAP_PENDING`/limit outcome without materializing per-slot gap rows.

### WR-03: Recovery authorization lacks freshness/expiry/control-version binding and single-use enforcement

**File:** `src/relay/service/opaque-relay-service.ts:152-164`, `src/sync/control/sync-control-service.ts:409-415`
**Issue:** ADR 0047 requires the recovery challenge to be a fresh relay-issued challenge bound to `controlVersion`, a nonce, and a 10-minute expiry, consumed by the successful CAS. The implemented `authorizationPreimage` binds only `{candidateDeviceId, challengeNonce, domain, packageId, syncId}`. The `challengeNonce` is client-chosen (not relay-issued), no expiry is checked, `controlVersion` is not bound, and the relay stores/consumes no challenge, so there is no replay window enforcement beyond the coincidental control-version CAS.
**Fix:** Issue and persist a relay-side single-use challenge (nonce + expiry + current controlVersion); include those fields in the signed preimage and reject expired/reused challenges with `SYNC_EXPIRED`/`SYNC_ALREADY_USED`.

### WR-04: Passphrase/recovery unwrap does not enforce the reviewed Argon2id floor

**File:** `src/sync/crypto/libsodium-crypto-provider.ts:176-196`, `src/sync/control/sync-control-service.ts:388-400`
**Issue:** `unwrapWithPassphrase`/`enrollViaRecovery` derive the KEK using `opsLimit`/`memLimit` taken directly from the stored package without checking them against `ARGON2ID_REVIEWED_FLOOR`. ADR 0047 ("Optional passphrase recovery package") states parameters MUST meet the reviewed floor. Params are AEAD-authenticated (so a relay cannot silently downgrade them without breaking decryption), but a package uploaded with below-floor parameters would still be accepted on unwrap, weakening offline-guessing resistance.
**Fix:** Before deriving on the open path, reject `opsLimit < ARGON2ID_REVIEWED_FLOOR.opsLimit || memLimit < ARGON2ID_REVIEWED_FLOOR.memLimit` with `SYNC_INTEGRITY_FAILED` (uniform failure).

### WR-05: Spawned Keychain helper read-ordering can deadlock for large secret outputs

**File:** `src/sync/secrets/macos-keychain-secret-store.ts:289-294`, `src/sync/secrets/macos-keychain-helper.swift:198-207`
**Issue:** For a `read`, the Swift helper writes the secret frame to fd 6 *inside* `handle(...)` and only afterwards `serve()` writes the result frame to fd 4. The Node runner reads the result frame first (`readFrame(controlOut)`), then the secret frame (`readFrame(secretOut)`). If a secret exceeds the OS pipe buffer (helper allows up to 16 MiB), the helper blocks writing fd 6 while Node blocks reading fd 4 — a deadlock. Current device secrets are small keys, so this is latent, but the framing permits large payloads.
**Fix:** Read/drain the secret-output frame concurrently with the control-result frame (e.g. start both reads before awaiting), or have the helper emit the control result before the secret payload.

### WR-06: Local sync-outbox emission is non-transactional with the domain effect and silently drops on CAS loss

**File:** `src/sync/materialization/sync-materializer.ts:447-480` (`emitLocalSyncOperation`), producers in `box-reviewer.ts`, `proposal-reviewer.ts`, `source-lifecycle-service.ts`, `mutation-application.ts`, `codex-importer.ts`
**Issue:** `emitLocalSyncOperation` reads the frontier on one connection and commits the outbox row on another; the domain effect has already been committed separately by the caller. If `commitLocalSyncOperation` returns `STATE_CHANGED` (frontier advanced) or `EQUIVOCATION`, the receipt is discarded (`Promise<void>`) and the committed local change never produces a sync outbox row — it will never replicate. The materializer doc acknowledges the cross-transaction boundary as a known limitation, but the silent drop is a durability gap for sync.
**Fix:** At minimum, surface a non-fatal signal on non-`COMMITTED` outbox results (retry queue or logged content-free counter) so a dropped emission is recoverable, and track it toward the eventual single-transaction seam noted in the plan.

### WR-07: Relay commit can reactivate a previously-revoked device

**File:** `src/relay/storage/in-memory-relay-store.ts:112-124`, `src/relay/storage/sqlite-relay-store.ts:260-283`
**Issue:** ADR 0047 relay acceptance condition 4 requires "no revoked credential is reactivated." `commitControl` unconditionally upserts every `commit.activeDevices` entry to `status:'active'` (the SQLite `ON CONFLICT ... DO UPDATE SET status='active'`), so a commit that lists a `deviceId` previously recorded in `revokedDevices`/`status:'revoked'` silently reactivates it. The schema only forbids a device being active and revoked *within the same commit*.
**Fix:** In `commitControl`, reject (conflict) any `activeDevices` entry whose stored credential is currently `revoked`, unless an explicit re-enrollment path is intended.

### WR-08: Relay HTTP rate-limit window map grows without bound

**File:** `src/relay/http/relay-http-server.ts:140-154`
**Issue:** `rateWindows` is keyed by bearer-token digest and entries are never pruned/evicted; each distinct token digest permanently retains a window record. Over time (token rotation, many accounts) this is an unbounded map. ADR 0047 requires bounded pre-allocation/limits. Not a correctness bug for a single-user deployment, but it violates the bounded-resource posture.
**Fix:** Evict windows whose `windowStartMs` is older than the window on access, or periodically sweep expired entries.

## Info

### IN-01: `objectId` is derived deterministically from the outbox row id

**File:** `src/sync/replication/sync-replication-service.ts:193`
**Issue:** `objectId` uses `sha256("cms-sync-object/"+row.id).slice(0,32)`. ADR describes `objectId` as a 128-bit random value carrying no semantic name; a deterministic per-row derivation is opaque but not random and could correlate re-seals. Consider drawing it from `crypto.randomBytes` and persisting it with the sealed row so replays keep byte-identical bytes.

### IN-02: Recovery package Ed25519 signature is never verified by the relay

**File:** `src/relay/service/opaque-relay-service.ts:269-281`
**Issue:** `handleRecoveryUpload` stores `request.package.signature` without verifying it against any key. This is acceptable for a zero-knowledge relay (the AEAD AAD authenticates the KDF params, and the client re-derives), but the ADR's "relay verifies … signature" language suggests an intended check. Document the deliberate non-verification or add a signature-shape assertion for defense in depth.

### IN-03: Fake account authenticator issues unsigned base64 tokens

**File:** `src/relay/auth/relay-account-authenticator.ts:149-206`
**Issue:** `FakeRelayAccountAuthenticator` mints and "verifies" tokens that are just base64url-encoded `{iss,sub}` with no signature. This is clearly test-only and gated behind `registeredSubjects`, but ensure production composition (`daemon-command.ts` uses `JoseRelayAccountAuthenticator`) can never select it; the `verify-phase06-evidence.mjs` production-transport guard covers the relay transport but not the authenticator selection.

---

_Reviewed: 2026-07-19_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
