---
phase: 06-zero-knowledge-multi-device-sync
plan: 10
subsystem: sync
tags: [replication, hash-chain, blake2b, ciphertextDigest, replay-verifier, gap-closure]

# Dependency graph
requires:
  - phase: 06-zero-knowledge-multi-device-sync
    provides: SyncReplicationService (sealOne/pushPending/pullAndApply), ReplayVerifier chain contract, per-device outbox sequencing (Plans 06-04/06-07/06-08)
provides:
  - "Producer/verifier agreement on the per-device envelope hash chain: sealOne now sources header.previousEnvelopeHash from the predecessor's own ciphertextDigest (BLAKE2b generichash over ciphertext bytes), matching ReplayVerifier.chainDigestOf exactly"
  - "Producer<->verifier round-trip acceptance test proving a genuine sequence-2 envelope verifies"
  - ">=2-operations-per-device convergence integration test over real HTTP loopback"
affects: [06-11, 06-12, 06-13, phase-06-final-verification]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Wire-chain values must be sourced from the exact field the consumer checks, not a locally-convenient alternate digest of the same data — CR-02 was two independently-computed digests (SHA-256 of base64 JSON vs BLAKE2b of ciphertext) that happened to satisfy the same schema shape while being semantically different values."

key-files:
  created: []
  modified:
    - src/sync/replication/sync-replication-service.ts
    - tests/sync/replay-equivocation.test.ts
    - tests/integration/multi-device-sync.test.ts

key-decisions:
  - "Fixed by reading the predecessor's already-persisted sealedEnvelopeBytesBase64, parsing it back to an EncryptedSyncEnvelope, and using its own ciphertextDigest as previousEnvelopeHash — no re-encryption, no new randomness, no schema change (the field's base64url(32) shape was already satisfied by either the old wrong value or the corrected one)."
  - "sealedEnvelopeDigest (SHA-256 of the whole base64 envelope JSON) is left unchanged as a local bookkeeping/row-identity digest; only the wire header chain source changed."

requirements-completed: [REQ-031, REQ-034, REQ-035]

# Metrics
duration: 25min
completed: 2026-07-20
---

# Phase 06 Plan 10: Envelope hash-chain producer/verifier fix (CR-02) Summary

**Fixed sealOne to chain `previousEnvelopeHash` on the predecessor's BLAKE2b `ciphertextDigest` (matching `ReplayVerifier.chainDigestOf`) instead of a SHA-256-of-base64-JSON digest, unblocking every device-sequence >= 2 envelope from `SYNC_INTEGRITY_FAILED` rejection.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-07-20T12:56:00Z (approx, prior to first test-file read)
- **Completed:** 2026-07-20T16:58:39Z
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments
- Root-caused and closed CR-02: producer (`sealOne`) and verifier (`ReplayVerifier.verify`) were computing the per-device envelope hash chain with two different algorithms over two different inputs, so no device could ever successfully replicate its second-or-later operation.
- Added a failing-first (RED) producer<->verifier round-trip test proving the defect against the unmodified tree, then made it pass (GREEN) with a one-line-semantics fix.
- Extended the real-HTTP-loopback integration suite with a `>=2-operations-per-device` convergence scenario, proving the fix holds over the genuine network transport, not just the in-process harness.
- Full `tests/sync` + `tests/integration` suite (22 files, 193 tests) passes after the fix.

## Task Commits

Each task was committed atomically:

1. **Task 1: Failing-first producer↔verifier round-trip acceptance test (RED)** - `4544649` (test)
2. **Task 2: Chain previousEnvelopeHash on the predecessor's ciphertextDigest (GREEN)** - `f2eb587` (fix)
3. **Task 3: Multi-operation-per-device convergence integration scenario** - `4f5c0a6` (test)

_TDD RED/GREEN gate sequence confirmed in git log: `test(06-10)` commit precedes `fix(06-10)` commit._

## Files Created/Modified
- `src/sync/replication/sync-replication-service.ts` - `sealOne` now parses the predecessor's persisted `sealedEnvelopeBytesBase64` back into an `EncryptedSyncEnvelope` and uses its own `ciphertextDigest` as `previousEnvelopeHash`, instead of `hexToBase64Url(predecessor.sealedEnvelopeDigest!)` (a SHA-256 of the whole base64 envelope JSON). Sequence-1 `ZERO_DIGEST_BASE64URL` behavior unchanged; `sealedEnvelopeDigest`/`sha256HexOfBase64` retained for local row bookkeeping only.
- `tests/sync/replay-equivocation.test.ts` - Added "accepts a correctly-produced sequence-2 envelope (producer<->verifier round-trip)": seals device-sequence 1 and 2 through the real `pushPending`/`sealOne` path and asserts `ReplayVerifier.verify` returns `kind: "verified"` for sequence 2 with `expectedPreviousChainDigest` set to sequence 1's `ciphertextDigest`.
- `tests/integration/multi-device-sync.test.ts` - Added "converges a >=2-operations-per-device history through the real network boundary (CR-02)": seeds alpha with two outbox rows (sequence 1 and 2), pushes both, and asserts beta's `pullAndApply` returns `applied: 2, gaps: 0, rejected: 0` with both accepted operations classified `outcomeKind: "effect"`.

## Decisions Made
- Sourced the corrected `previousEnvelopeHash` from the predecessor's already-persisted sealed envelope bytes (parse-and-read `ciphertextDigest`) rather than adding a new store column or re-deriving the digest independently — reuses existing durable state, zero re-encryption, zero new randomness, matching the plan's designated fix shape exactly.
- Left `sealedEnvelopeDigest`/`sha256HexOfBase64` in place unchanged, since they are used for local outbox row identity/crash-retry bookkeeping (`store.sealClaimedOutboxEnvelope`'s `envelopeDigest` parameter) and are out of this plan's declared scope; only the wire-header chain source moved off of them.

## Deviations from Plan

None - plan executed exactly as written. Task 1 produced the specified RED failure (`kind: 'rejected'` vs expected `'verified'`); Task 2's fix turned it GREEN without touching any other passing test; Task 3's new integration scenario passed on first run after Task 2's fix (no defect discovered specific to the HTTP-loopback path beyond the already-fixed in-process defect).

## Issues Encountered
- `npm install --no-audit --no-fund` transiently exited non-zero once with a suppressed-by-tail-piping empty output on the first attempt; a clean re-run (logged to file to avoid buffer truncation) succeeded normally (`changed 71 packages`). Not a deviation from the plan — pre-existing worktree dependency install, unrelated to the CR-02 fix.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- CR-02 closed: `header.previousEnvelopeHash` now equals the predecessor's `ciphertextDigest` on the wire; device-sequence >= 2 envelopes verify and converge, both in-process and over real HTTP loopback.
- REQ-031 (E2E encryption's "synchronized" half) and REQ-034 (offline convergence for concurrent changes) restored for multi-operation histories.
- REQ-035 (tombstone propagation) unblocked beyond a single operation per device, since it rides the same now-fixed replication pipeline — not independently re-derived in this plan (out of declared scope), but no longer structurally blocked by CR-02.
- Remaining phase-06 gap-closure plans (06-11 through 06-13, per `06-VERIFICATION.md`) are unaffected by and independent of this fix; CR-01 (recovery-credential authorization) remains open and is not addressed here.

---
*Phase: 06-zero-knowledge-multi-device-sync*
*Completed: 2026-07-20*

## Self-Check: PASSED

- FOUND: commit 4544649 (Task 1, RED)
- FOUND: commit f2eb587 (Task 2, GREEN)
- FOUND: commit 4f5c0a6 (Task 3, convergence test)
- FOUND: tests/sync/replay-equivocation.test.ts
- FOUND: tests/integration/multi-device-sync.test.ts
- FOUND: src/sync/replication/sync-replication-service.ts
