# Research Questions

## Zero-Knowledge Multi-Device Convergence

**Added:** 2026-07-16

**Required before:** Roadmap Phase 5 planning

### Primary Question

What protocol and data model should synchronize an append-oriented personal conversation, derived accordion memory, approvals, aliases, and deletions across intermittently connected devices while the relay server remains unable to decrypt content?

### Questions to Resolve

1. What is the encrypted synchronization unit: canonical events, an operation log, database pages, immutable chunks, or a hybrid?
2. Which conflict-resolution model preserves deterministic chronology, causal relationships, approvals, and source aliases without silently choosing a single writer?
3. How are device identities created, authenticated, approved, and bound to a person's account without making the server a key custodian?
4. How does an existing device securely enroll a new device, and what recovery-key format balances usability with brute-force resistance?
5. What can recovery restore, and what becomes unrecoverable if all authorized devices and the recovery key are lost?
6. How are revoked devices prevented from reading future memory or uploading accepted changes after revocation?
7. Which key hierarchy permits device revocation and forward key rotation without re-encrypting the entire historical corpus at once?
8. How do deletion tombstones prevent stale or long-offline devices from resurrecting deleted source events or derived memory?
9. How are derived summaries, boxes, traces, embeddings, and proposal decisions invalidated or recomputed when underlying events are deleted or corrected?
10. What minimal metadata may the relay observe, and which metadata must be padded, bucketed, or encrypted to limit traffic and relationship analysis?
11. How are rollback, replay, truncation, equivocation, and corrupted-ciphertext attacks detected by clients?
12. How are encrypted backups exported, verified, restored, and rotated independently of the relay account?
13. Can embedding-backed retrieval remain local while synchronizing only encrypted derived artifacts, and how are incompatible embedding models reconciled across devices?
14. Which established, audited cryptographic constructions and synchronization libraries fit the protocol, and what must not be implemented in-house?

### Required Outputs

- Threat model covering relay compromise, account compromise, stolen devices, malicious or stale peers, metadata leakage, and recovery loss.
- Protocol comparison with explicit security and operational tradeoffs.
- Key hierarchy and device lifecycle specification.
- Convergence and deletion state machine.
- Minimal relay API and stored-metadata specification.
- Test vectors and failure-injection plan suitable for deterministic automated tests.

### Non-Negotiable Constraints

- The relay never receives plaintext memory or plaintext encryption keys.
- The local product remains usable offline and is authoritative for local operation.
- Human approval and source provenance survive synchronization.
- Deleted sensitive material must not silently reappear from a stale peer.
- No custom cryptographic primitive may be introduced.
