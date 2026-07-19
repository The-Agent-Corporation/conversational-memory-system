# Phase 06: Zero-Knowledge Multi-Device Sync - Research

**Researched:** 2026-07-19  
**Domain:** End-to-end encrypted, local-first, multi-device archive replication  
**Confidence:** MEDIUM — primitives, standards, repository seams, and package identities are verified; the composed application protocol still requires the locked independent approval gate before implementation.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

### Device enrollment
- **D-01:** A new device normally enrolls by sending a remote approval request through the relay. Direct QR pairing is not required as the primary enrollment path.
- **D-02:** Any one currently trusted device may approve enrollment after showing the proposed device name and a matching verification code.
- **D-03:** Enrollment grants the new trusted device the person's complete synchronized memory archive rather than a selected subset or future-only stream. MCP profiles and allowed scopes continue to restrict agent retrieval locally; they are not selective device-sync boundaries.
- **D-04:** When no trusted device is available, the recovery key plus access to the user's relay sync account is sufficient to enroll a replacement device.

### Recovery and device revocation
- **D-05:** Revocation blocks the device from future synchronization and triggers rotation of future synchronization keys. The product does not attempt or claim a remote erasure of memory already retained by an offline device.
- **D-06:** Revocation does not rewrite historical ciphertext. Existing history retains its prior encryption keys, while new synchronized changes use rotated keys.
- **D-07:** The user may opt into a relay-stored recovery package encrypted locally under a user-only passphrase. The relay never receives the passphrase and cannot perform support-assisted decryption.
- **D-08:** Any trusted device may explicitly rotate a compromised recovery key, invalidate the old recovery path, and replace the optional encrypted recovery package.

### Offline convergence and deletion
- **D-09:** Concurrent additive event streams are both preserved and merged deterministically using canonical time and provenance. Devices recompute only affected summaries, topics, and other derived memory after convergence.
- **D-10:** Incompatible mutations to the same reviewable object, such as concurrent approval and rejection, preserve both decisions and enter an explicit conflict state for user resolution. The system does not silently choose by timestamp or precedence.
- **D-11:** When a stale peer offers content covered by an approved deletion, that content is quarantined and cannot become active or retrievable memory. The user must explicitly decide whether to keep the deletion or create a reviewed restoration path.
- **D-12:** Deletion tombstones are retained indefinitely as compact encrypted audit records containing identifiers and timestamps but no deleted conversation content.

### Relay privacy and synchronization scope
- **D-13:** The relay may retain a pseudonymous sync identity, authorized device identifiers, encrypted-object identifiers, sequence and replay-protection data, timestamps, and ciphertext sizes. It must not receive memory content, decryption keys, person names, source labels, profile names, workspace labels, or other semantic memory metadata.
- **D-14:** The relay retains every encrypted object version indefinitely as an append-only synchronization archive rather than garbage-collecting superseded ciphertext after acknowledgement.
- **D-15:** All approved memory profiles and scopes are included in the person's encrypted synchronized archive. Scope authorization remains enforced by local retrieval and MCP profile boundaries on each trusted device.
- **D-16:** Relay authentication uses a conventional email-based account with password or passkey recovery. Relay account recovery restores service access only; it cannot decrypt memory without a trusted device, recovery key, or user-passphrase-protected recovery package.

### the agent's Discretion
- Exact transport, cryptographic protocol, key hierarchy, authenticated-encryption suite, password-based key derivation, device credential format, conflict-free data structure, clock representation, envelope format, and relay implementation are left to research and planning.
- Protocol selection must use established, reviewed cryptographic primitives and include an explicit threat model and protocol-approval gate; bespoke cryptography is not acceptable.
- Exact conflict UI, quarantine record schema, encrypted version addressing, replay window, verification-code format and expiry, passkey provider, and email-account implementation are flexible provided the decisions and requirements above remain testable.

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| REQ-031 | Synchronized content and derived memory are encrypted on devices; relay has no decryption keys. | Per-object XChaCha20-Poly1305 envelopes, opaque relay boundary, independent key-control plane, and negative relay-knowledge tests. [VERIFIED: .planning/REQUIREMENTS.md] [CITED: https://doc.libsodium.org/secret-key_cryptography/aead/chacha20-poly1305/xchacha20-poly1305_construction] |
| REQ-032 | Enrollment requires an authorized device or user-held recovery key. | Transcript-bound 64-bit verification display, active-device-signed enrollment commit, complete historical keyring wrap, and recovery-signing credential. [VERIFIED: .planning/REQUIREMENTS.md] [CITED: https://www.rfc-editor.org/rfc/rfc5763.html] |
| REQ-033 | Revocation blocks future sync and rotates future keys without losing local memory. | Linear membership CAS, independently random content-key epochs, no historical rewrite, and no remote-erasure claim. [VERIFIED: .planning/REQUIREMENTS.md] [CITED: https://www.rfc-editor.org/rfc/rfc9420.html] |
| REQ-034 | Concurrent offline changes converge without one online writer. | Immutable operation-set union, per-device causal chains, deterministic materialization, multi-value conflicts, and permutation/partition property tests. [VERIFIED: .planning/REQUIREMENTS.md] [CITED: https://arxiv.org/abs/1805.06358] |
| REQ-035 | Deletions and revocations propagate with auditable tombstones and prevent stale reintroduction. | Encrypted remove-wins tombstones, control-first application, quarantine-before-materialization, and reviewed restoration as a new operation. [VERIFIED: .planning/REQUIREMENTS.md] [VERIFIED: docs/adr/0044-source-revocation-and-attributable-deletion.md] |
| REQ-036 | Relay stores only routing, authorization, replay, and convergence metadata. | Explicit outer-envelope allowlist, opaque randomized identifiers, IdP `(iss, sub)` identity, semantic-field rejection tests, and traffic-analysis disclosure. [VERIFIED: .planning/REQUIREMENTS.md] [CITED: https://www.rfc-editor.org/rfc/rfc6973.html] |
</phase_requirements>

## Summary

Plan Phase 06 as two protocols with different consistency needs. The **control plane**—device enrollment, recovery credential changes, revocation, and content-key epoch rotation—must be linear and online because two accepted rotations from the same membership state would split the archive. Use relay compare-and-swap on a monotonically versioned, device-signed membership record; the relay sees only pseudonymous device credentials and encrypted key packages. The **data plane** remains local-first and multi-writer: every committed local mutation emits one immutable signed and encrypted operation, replicas union operations, and the materializer deterministically rebuilds state from the same operation set. [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md] [CITED: https://arxiv.org/abs/1805.06358]

Use `libsodium-wrappers-sumo` 0.8.4 for high-level XChaCha20-Poly1305 AEAD, X25519-based `crypto_box`/sealed-box key packages, Ed25519 signatures, domain-separated key derivation, secure random bytes, and Argon2id passphrase derivation. Use RFC 8785 canonical JSON through `canonicalize` 3.0.0 for signed/hashable bytes; do not reuse the repository's small `stableJson` helper as a wire canonicalizer. Use `jose` 6.2.3 only at the relay account-auth adapter to validate provider-issued JWTs and derive the pseudonymous account key from verified `iss` and `sub`, never from email. [VERIFIED: npm registry] [CITED: https://github.com/jedisct1/libsodium.js] [CITED: https://www.rfc-editor.org/rfc/rfc8785.html] [CITED: https://github.com/panva/jose]

Do not adopt MLS as the archive replication layer. MLS correctly rotates secrets around membership changes, but it intentionally gives new members only post-join message access and requires the application to select a canonical commit when two commits target the same epoch. Those semantics conflict with complete-history enrollment and offline multi-writer archive changes. Its epoch/control ideas are useful comparison material, not the implementation substrate. [CITED: https://www.rfc-editor.org/rfc/rfc9420.html]

**Primary recommendation:** Approve a versioned protocol ADR and threat model first; then implement a relay-serialized membership/key control plane plus an encrypted operation-set data plane, with all production cryptography confined to a reviewed `CryptoProvider` and every relay/storage boundary proven with synthetic deterministic tests. [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md]

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Device key generation and secret retention | Local client / OS secure storage | — | Private signing, wrapping, epoch, and recovery material must never enter relay or ordinary SQLite rows; macOS Keychain Services is the initial platform boundary. [CITED: https://developer.apple.com/documentation/security/keychain-services] |
| Enrollment approval and verification code | Local client | Relay | Devices independently derive/display the transcript code; relay only routes the request and commits the approved pseudonymous credential. [CITED: https://www.rfc-editor.org/rfc/rfc5763.html] |
| Membership, revocation, key-epoch serialization | Relay API / Backend | Local client | Relay performs CAS and blocks revoked credentials; clients generate keys, encrypt per-device packages, and sign control commits. [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md] |
| Archive operation creation and encryption | Local service | Local storage | The local committed transaction is authoritative; only post-commit immutable operations are encrypted and queued. [VERIFIED: src/storage/mcp-mutation-contracts.ts] |
| Offline convergence and conflict detection | Local sync service | Local storage | Replicas merge signed operation sets and materialize deterministic local state; relay never interprets semantic operations. [CITED: https://arxiv.org/abs/1805.06358] |
| Append-only ciphertext retention and routing | Relay storage | Relay API | Relay stores immutable opaque versions keyed only by allowed outer metadata and serves sequence/head queries. [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md] |
| Tombstone enforcement and stale-content quarantine | Local sync materializer | Local storage | Decrypted tombstones are applied before data operations; covered stale content never reaches retrievable tables. [VERIFIED: docs/adr/0044-source-revocation-and-attributable-deletion.md] |
| Derived-memory recomputation | Existing local daemon contraction queue | Local storage | Newly converged affected canonical ranges reuse the established bounded, idempotent contraction path. [VERIFIED: src/daemon/contraction-runner.ts] |
| Agent retrieval authorization | Existing MCP/retrieval layer | Local storage | Full archive trust does not widen a profile's person or allowed scopes. [VERIFIED: docs/adr/0046-person-and-retrieval-scope-boundaries.md] |
| Email/password/passkey account lifecycle | Auth0 Universal Login | Relay auth adapter | Auth0 owns email/password/passkey recovery; relay retains verified pseudonymous `(iss, sub)` only. Plan 06-05 binds exact issuer, audience, and JWKS configuration while keeping account access separate from device/key authority. [CITED: https://openid.net/specs/openid-connect-core-1_0.html] |

## Threat Model

### Protected assets and trust anchors

- Protect memory content, semantic metadata, derived objects, source/scope labels, private device credentials, epoch keys, recovery seed, and passphrase from the relay, network observer, and other accounts. [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md]
- Trust an enrolled, non-revoked endpoint while it is uncompromised; trust reviewed libsodium primitives, the OS cryptographic RNG, the OS secret store, and correct user comparison of the enrollment verification code. [CITED: https://doc.libsodium.org/generating_random_data] [CITED: https://developer.apple.com/documentation/security/keychain-services]
- Treat decrypted memory as untrusted application data until strict schemas, person ownership, source provenance, scope dependencies, and operation authorization are revalidated locally. [VERIFIED: AGENTS.md] [VERIFIED: docs/adr/0046-person-and-retrieval-scope-boundaries.md]

### Adversaries in scope

- A passive relay/database operator must learn only the explicitly allowed outer metadata and ciphertext sizes. [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md]
- An active relay or network attacker may tamper, replay, reorder, omit, duplicate, rollback, or fork delivery. Signatures, AEAD, per-device sequence/hash chains, persisted high-water marks, and control-version CAS detect integrity/replay violations; no protocol can force an uncooperative relay to deliver data. [CITED: https://www.rfc-editor.org/rfc/rfc9180.html]
- A stolen relay account credential must not decrypt content or authorize a new device without an active-device approval signature or current recovery credential. [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md]
- A revoked or offline stale device may retain all historical plaintext and historical epoch keys it already possessed, but must be unable to upload/fetch new objects or unwrap new epochs after revocation. [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md]
- A weak recovery-package passphrase is exposed to offline guessing because the relay can copy its salt, Argon2 parameters, nonce, and ciphertext; Argon2id raises cost but cannot create entropy the passphrase lacks. [CITED: https://www.rfc-editor.org/rfc/rfc9106.html]

### Explicit non-goals and residual risk

- No remote erasure of a compromised device, no retroactive protection of keys/plaintext already copied, and no recovery from simultaneous compromise of every trusted device and current recovery credential. [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md]
- No availability guarantee against a malicious relay; permanent withholding is indistinguishable from outage. Per-device signed head witnesses can expose a split view once devices exchange observations, but a relay that partitions them forever can prevent detection and convergence. [ASSUMED]
- End-to-end encryption does not hide timing, frequency, direction, identifiers, or ciphertext size. Fixed-block padding reduces size precision at storage/bandwidth cost but does not remove traffic analysis. [CITED: https://www.rfc-editor.org/rfc/rfc6973.html] [CITED: https://www.rfc-editor.org/rfc/rfc8467.html]
- Endpoint malware, screen capture, unlocked local database access, malicious approved agent profiles, and plaintext already present in native histories are outside relay zero-knowledge; existing local isolation and redaction remain mandatory. [VERIFIED: AGENTS.md]

## Standard Stack

### Core

| Library / Standard | Version | Purpose | Why Standard |
|--------------------|---------|---------|--------------|
| `libsodium-wrappers-sumo` | 0.8.4, published 2026-04-19 | XChaCha20-Poly1305, X25519 authenticated/sealed boxes, Ed25519, Argon2id, KDF, RNG, constant-time helpers | Official libsodium JavaScript binding; sumo is required because `crypto_pwhash_*` is not in the standard wrapper. Package is official and legitimacy gate returned OK. [VERIFIED: npm registry] [CITED: https://github.com/jedisct1/libsodium.js] |
| `canonicalize` | 3.0.0, published 2026-04-08 | RFC 8785 JCS bytes for signatures, hashes, and fixtures | RFC 8785 Appendix G names this implementation; package legitimacy gate returned OK and it has built-in types. [VERIFIED: npm registry] [CITED: https://www.rfc-editor.org/rfc/rfc8785.html] |
| `jose` | 6.2.3, published 2026-04-27 | Verify provider JWT signature, issuer, audience, expiry, and obtain stable `sub` | Maintained zero-dependency ESM implementation with remote/local JWKS verification; package legitimacy gate returned OK. [VERIFIED: npm registry] [CITED: https://github.com/panva/jose] |
| Zod | existing 3.25.76 | Strict schemas for outer relay records, decrypted operations, control commits, conflicts, and tombstones | Existing repository validation pattern; retain the pinned project version during Phase 06. [VERIFIED: package-lock.json] |
| SQLite `node:sqlite` | Node 24.7.0 runtime | Atomic local operation log, device registry snapshot, key metadata, replay frontiers, conflicts, quarantine, and sync checkpoints | Existing storage authority and transaction pattern; available in the current environment. Secret key bytes must not be stored here. [VERIFIED: src/storage/sqlite-store.ts] [VERIFIED: environment probe] |

### Supporting standards and platform APIs

| Standard / API | Purpose | When to Use |
|----------------|---------|-------------|
| RFC 8785 JCS | Canonical serialization | Before hashing/signing any protocol object; reject non-I-JSON values and negative zero per verified erratum. [CITED: https://www.rfc-editor.org/rfc/rfc8785.html] [CITED: https://www.rfc-editor.org/errata/rfc8785] |
| XChaCha20-Poly1305-IETF | Per-object payload and passphrase-package AEAD | Use fresh random 192-bit nonce for each encryption and bind the complete public header as associated data. [CITED: https://doc.libsodium.org/secret-key_cryptography/aead/chacha20-poly1305/xchacha20-poly1305_construction] |
| Ed25519 detached signatures | Device-origin authentication | Sign canonical outer header plus nonce/ciphertext digest; verify before attempting decryption. [CITED: https://doc.libsodium.org/public-key_cryptography/public-key_signatures] |
| X25519 `crypto_box_easy` / sealed boxes | Device and recovery key-package encryption | Authenticated box from approving active device to new device; signed sealed box to the recovery public key. [CITED: https://doc.libsodium.org/public-key_cryptography/authenticated_encryption] |
| Argon2id (`crypto_pwhash`) | Optional passphrase recovery-package KEK | Store algorithm, salt, opslimit, memlimit, version, and nonce beside ciphertext; benchmark an explicit floor and support parameter upgrades. [CITED: https://doc.libsodium.org/password_hashing/default_phf] [CITED: https://www.rfc-editor.org/rfc/rfc9106.html] |
| Apple Keychain Services / `SecItem` | Initial macOS device-secret adapter | Store small private seeds and epoch keyring wrapping key with non-synchronizable local access controls; do not pass secrets through CLI arguments. [CITED: https://developer.apple.com/documentation/security/storing-keys-in-the-keychain] |
| HTTPS + provider-issued OIDC/JWT | Relay account authentication | Authenticate service access; key relay rows by verified `(iss, sub)`, not email, and keep the provider behind an adapter. [CITED: https://openid.net/specs/openid-connect-core-1_0.html] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Operation-set data plane | MLS RFC 9420 | MLS has strong standardized group membership/key evolution, but new members lack pre-join history and concurrent epoch commits need application canonicalization; reject for archive replication. [CITED: https://www.rfc-editor.org/rfc/rfc9420.html] |
| Operation-set data plane | Whole database/file sync | Ciphertext pages leak churn/size patterns, concurrent SQLite files do not merge semantically, and deletion/conflict rules cannot be audited per operation; reject. [ASSUMED] |
| Domain-specific operation CRDT | Automerge document | Automerge preserves concurrent values but exposes an arbitrary deterministic visible winner and is optimized for mutable JSON documents; this product requires explicit conflict state and permanent deletion audit semantics. Use its research model, not its document type. [CITED: https://automerge.org/docs/reference/documents/conflicts/] |
| XChaCha20-Poly1305 | AES-256-GCM | AES-GCM is standard and hardware-fast but has a shorter nonce with catastrophic reuse risk; XChaCha permits random 192-bit nonces and is the libsodium recommendation when cross-library interoperability is unnecessary. [CITED: https://doc.libsodium.org/secret-key_cryptography/aead] |
| Device key packages with libsodium high-level APIs | Raw X25519 + handwritten HKDF/AEAD composition | A custom construction expands the audit surface and violates the no-bespoke-cryptography decision; reject. [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md] |
| Provider-managed email/passkey lifecycle | Homegrown password/passkey database | Authentication recovery, rate limiting, breach handling, and WebAuthn lifecycle are separate security products; keep them behind a standard identity-provider adapter. [CITED: https://owasp.org/www-project-application-security-verification-standard/] |

**Installation:**

```bash
npm install --save-exact libsodium-wrappers-sumo@0.8.4 canonicalize@3.0.0 jose@6.2.3
```

All three package names were confirmed by their official upstream documentation/repositories, checked on the npm registry, checked for postinstall scripts, and returned `OK` from the GSD package-legitimacy gate. [VERIFIED: npm registry]

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `libsodium-wrappers-sumo` | npm | Created 2016-09-11 | 328,756/week at check time | `github.com/jedisct1/libsodium.js` | OK; no postinstall | Approved. [VERIFIED: npm registry] |
| `canonicalize` | npm | Created 2018-05-04 | 2,301,224/week at check time | `github.com/erdtman/canonicalize` | OK; no postinstall | Approved. [VERIFIED: npm registry] |
| `jose` | npm | Created 2014-02-27 | 90,388,877/week at check time | `github.com/panva/jose` | OK; no postinstall | Approved. [VERIFIED: npm registry] |

**Packages removed due to SLOP verdict:** none. [VERIFIED: package-legitimacy gate]  
**Packages flagged as suspicious SUS:** none. [VERIFIED: package-legitimacy gate]

## Architecture Patterns

### System Architecture Diagram

```text
Local mutation / import / deletion commits
                 |
                 v
        Post-commit SyncOutbox
                 |
        canonical operation bytes
                 |
        sign -> encrypt -> opaque envelope
                 |
                 v
       HTTPS Relay API + Account Auth
       |                           |
       | control plane             | data plane
       | membership CAS            | append-only ciphertext
       | device credentials        | opaque IDs + seq + sizes
       | encrypted key packages    | no semantic indexes
       v                           v
      Other trusted device fetches control frontier first
                 |
       verify signature / chain / replay frontier
                 |
         decrypt + strict schema validation
                 |
       +---------+--------------------+
       |                              |
  tombstone/control op?          ordinary data op?
       |                              |
  update remove-wins set       reject/quarantine if covered
       |                              |
       +--------------+---------------+
                      v
        deterministic operation materializer
              |                 |
       additive union      explicit mutation conflict
              |                 |
       atomic local commit   reviewable conflict record
              |
       affected canonical range
              v
      existing daemon contraction queue
              v
  local profile-bound MCP retrieval (person + scopes)
```

The relay boundary ends at opaque envelope storage and device/account authorization. Plaintext operation types, person/source/scope/profile/workspace names, key material, and conflict/deletion semantics exist only after local decryption. [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md]

### Recommended Project Structure

```text
src/
├── sync/
│   ├── domain/                 # strict envelopes, operations, clocks, devices, epochs, conflicts
│   ├── crypto/                 # CryptoProvider + libsodium implementation + JCS signing bytes
│   ├── control/                # enrollment, recovery, revocation, membership CAS client
│   ├── replication/            # outbox, pull, chain/replay verification, deterministic merge
│   ├── materialization/        # apply operations, remove-wins tombstones, quarantine, conflicts
│   ├── transport/              # SyncRelay client interface and HTTPS adapter
│   └── secrets/                # DeviceSecretStore + injected fake + macOS Keychain adapter
├── relay/
│   ├── domain/                 # opaque allowlisted relay records only
│   ├── auth/                   # RelayAccountAuthenticator + jose/OIDC adapter
│   ├── service/                # membership CAS, append-only put/list/head
│   └── storage/                # relay store interface + SQLite/in-memory fixtures
├── storage/                    # MemoryStore sync extensions in both adapters
└── daemon/                     # enqueue affected ranges through existing contraction path
tests/
├── sync/                       # crypto vectors, control, convergence, tombstone, conflict, replay
├── relay/                      # metadata allowlist, auth, CAS, append-only retention, inability-to-decrypt
└── integration/                # multi-device partitions, recovery, revocation, restart, fault injection
```

Keep relay types in a separate module that cannot import canonical memory schemas. Enforce this with an import-boundary test or lint assertion so semantic fields cannot drift into relay persistence. [ASSUMED]

### Pattern 1: Separate linear control from convergent data

**What:** The relay serializes `MembershipCommit` by exact `previousControlVersion`; only an active device or current recovery credential may sign the next commit. Ordinary encrypted archive operations never use that lock and can be created offline on every active device. [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md]

**Why:** Key membership requires one agreed active set and one next epoch, whereas archive data must remain multi-writer and eventually converge. MLS likewise warns that concurrent commits for one epoch need application resolution. [CITED: https://www.rfc-editor.org/rfc/rfc9420.html]

**Planning consequence:** Enrollment, revocation, and recovery rotation are online control transactions with explicit stale-version retry. Memory capture/import/review remains offline and queues envelopes until reconnect. [VERIFIED: .planning/REQUIREMENTS.md]

### Pattern 2: Independently random content-key epochs

**What:** Generate a fresh random 256-bit content key on initial setup and every revocation/recovery-compromise rotation. Never derive a future epoch key from an archive root known to ordinary devices. Each trusted device receives encrypted packages for the epochs it is entitled to; a new approved device receives the complete historical keyring. [CITED: https://doc.libsodium.org/generating_random_data]

**Why:** If ordinary devices held a derivation root, a revoked device could derive future keys. Independent epochs make future exclusion possible while preserving historical ciphertext untouched. [ASSUMED]

**Recovery hierarchy:** A high-entropy recovery seed deterministically creates a recovery signing credential and recovery wrapping credential through domain-separated derivations. Active devices can encrypt the current historical keyring to the public recovery credential; the relay cannot open it. The optional passphrase package wraps only the recovery seed, so it need change only when recovery is rotated, not for every data epoch. This composition must be fixed in the protocol ADR and independently reviewed before code. [CITED: https://doc.libsodium.org/key_derivation] [ASSUMED]

### Pattern 3: Signed, encrypted immutable operation envelopes

**What:** A relay-visible envelope should contain only a protocol version, pseudonymous sync ID, random object ID, random device ID, per-device sequence, previous-envelope hash, nonce, ciphertext length/digest, ciphertext, and detached device signature. Put operation kind, person/source/scope identifiers, causal dependency frontier, canonical event data, conflict target, and tombstone details inside ciphertext. [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md]

**Rules:**

- Canonicalize the signable header using RFC 8785; include protocol/domain labels to prevent cross-protocol substitution. [CITED: https://www.rfc-editor.org/rfc/rfc8785.html]
- AEAD additional data binds the canonical public header excluding ciphertext/signature; the signature binds that same header plus nonce and ciphertext digest. [CITED: https://doc.libsodium.org/secret-key_cryptography/aead/chacha20-poly1305/xchacha20-poly1305_construction]
- `(syncId, deviceId, sequence)` is unique. Identical retransmission is idempotent; different bytes at the same tuple are equivocation and permanently fail closed. [ASSUMED]
- Persist last accepted sequence/hash per device. Reject lower counters, duplicate operation IDs, broken predecessor links, unknown/revoked author credentials, bad signatures, bad AEAD, unknown protocol versions, oversized records, and schemas with unexpected fields before materialization. [CITED: https://www.rfc-editor.org/rfc/rfc9180.html] [VERIFIED: AGENTS.md]
- A relay can withhold an object and create a detectable sequence gap but cannot be forced to fill it; clients retain pending later objects and do not advance the contiguous frontier across a gap. [ASSUMED]

### Pattern 4: Operation-set CRDT with domain-specific reducers

**What:** Merge is set union by cryptographic operation ID. Materialization order is a deterministic topological order over declared causal dependencies, with `(authorDeviceId, authorSequence, operationId)` only as a stable tie-breaker for independent operations. Canonical conversation ordering continues to use existing normalized time, native sequence, causal linkage, and deterministic event ID—not wall-clock arrival or sync sequence. [VERIFIED: docs/adr/0040-personal-canonical-timeline.md]

**Reducer semantics:**

- Canonical/source additions are grow-only immutable facts deduplicated by existing deterministic IDs. [VERIFIED: src/domain/canonical.ts]
- Reviewable-object mutations carry target ID, exact base version/state digest, and semantic decision. Causally ordered changes apply normally; concurrent incompatible decisions produce a durable `unresolved` multi-value conflict containing both operation IDs and no silently selected winner. [CITED: https://automerge.org/docs/reference/documents/conflicts/]
- Conflict resolution is a later explicit reviewed operation that names every conflicting operation it resolves; it never deletes the audit operations. [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md]
- Derived summaries/boxes/traces may be synchronized as cache/audit versions, but canonical events plus reviewed durable mutations are the convergence authority. After merge, enqueue only affected ranges for existing deterministic recomputation. [VERIFIED: src/daemon/contraction-runner.ts]

### Pattern 5: Remove-wins tombstone barrier and quarantine

**What:** An approved deletion emits a compact encrypted tombstone after the existing local deletion transaction commits. It contains target identifiers/hash commitments, deletion scope, deletion audit identity, approving device/actor, causal frontier, and timestamp—but never deleted content. [VERIFIED: docs/adr/0044-source-revocation-and-attributable-deletion.md]

**Application order:** Fetch and apply membership/control and tombstone operations before ordinary payloads for every sync batch; iterate until the control/tombstone frontier is stable. Before any incoming add reaches canonical/retrieval tables, query the permanent tombstone index. Covered payloads go to a separate non-retrievable encrypted quarantine record with the offering device/op ID and reason. [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md]

**Restoration:** Reconnection never clears a tombstone. A user-approved restoration creates a new reviewed operation that references the tombstone and either re-authorizes a bounded copy or intentionally creates new content; it does not erase the deletion audit. [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md]

### Pattern 6: Transactional outbox and origin-aware apply

**What:** Every local authoritative mutation transaction atomically records its domain effects and a sync-outbox row. Remote application atomically records the accepted encrypted operation, replay frontier, materialized domain effects, conflict/quarantine outcome, and affected contraction range. Mark remote origin so applying it cannot emit a semantically duplicate new local operation. [VERIFIED: src/storage/mcp-mutation-contracts.ts]

**Why:** Emitting before commit can sync an operation that never became locally authoritative; emitting after commit without an atomic outbox can lose changes on crash. Existing task-specific atomic store methods are the correct seam. [VERIFIED: src/storage/mcp-mutation-contracts.ts] [VERIFIED: src/storage/memory-store.ts]

### Anti-Patterns to Avoid

- **Encrypting the SQLite file and syncing pages/files:** this has no semantic multi-writer merge and cannot enforce conflict/tombstone rules. [ASSUMED]
- **One archive master key shared forever:** a revoked device can decrypt future writes; rotate independently random future epochs. [ASSUMED]
- **Deriving epoch keys from a root delivered to every device:** revocation becomes cosmetic because old devices can calculate new keys. [ASSUMED]
- **Last-writer-wins review decisions:** timestamps are neither reliable authority nor acceptable conflict resolution under D-10. [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md]
- **Using sync sequence as canonical conversation order:** sync order is delivery metadata; retain native/canonical provenance ordering. [VERIFIED: docs/adr/0040-personal-canonical-timeline.md]
- **Decrypt-then-verify or parse-before-authenticate:** verify outer authorization/signature and AEAD before parsing plaintext; reject errors with content-free codes. [CITED: https://doc.libsodium.org/public-key_cryptography/public-key_signatures]
- **Server-supplied verification code:** both devices must independently derive the code from the full enrollment transcript/shared secret; otherwise a malicious relay can choose it. [CITED: https://www.rfc-editor.org/rfc/rfc5763.html]
- **Putting a recovery key or passphrase in logs, argv, SQLite, fixtures, snapshots, or relay records:** store production device secrets only through `DeviceSecretStore`; test values must be synthetic and unmistakable. [VERIFIED: AGENTS.md]
- **Assuming append-only means deletion is impossible:** relay ciphertext remains, while local materialization enforces encrypted tombstones and removal from active/retrievable memory. [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md]

## Enrollment, Recovery, and Revocation Protocol Shape

### Normal remote enrollment

1. New device generates independent Ed25519 signing and X25519 wrapping keypairs locally, plus an ephemeral enrollment key; it uploads an expiring request containing random device ID, public keys, encrypted device name, and nonce. [CITED: https://doc.libsodium.org/public-key_cryptography/authenticated_encryption]
2. Relay routes the request to active devices. New and approving devices use their ephemeral X25519 keys through libsodium's role-separated key-exchange API, then independently derive a code from the resulting shared session material and the complete transcript covering sync ID, both device public keys, request nonce, expiry, and protocol version. Display at least 64 bits in grouped human-readable form; expiry and one-time consumption are enforced. The exact KDF label and transcript bytes belong in the approved protocol specification. [CITED: https://doc.libsodium.org/key_exchange] [CITED: https://www.rfc-editor.org/rfc/rfc5763.html]
3. User compares codes and device name. Approver creates a signed membership CAS commit, encrypts the complete historical epoch keyring to the new device's wrapping key, and uploads the opaque package. [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md]
4. Relay accepts only if request is pending/unexpired, signer is active, previous control version matches, and the request is unused. It adds the pseudonymous device credential but never sees the device name or keyring plaintext. [ASSUMED]
5. New device verifies commit/signature/transcript, unwraps keyring into `DeviceSecretStore`, downloads the complete archive, verifies all chains/envelopes, materializes tombstones first, then data, and recomputes affected derived memory. [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md]

### Recovery enrollment

1. Relay account authentication grants access to the encrypted recovery package and current recovery public credential only. [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md]
2. User enters the high-entropy recovery key, or decrypts the optional passphrase package locally to recover that key. The client proves possession by signing the exact enrollment/control transcript with the current recovery signing credential. [ASSUMED]
3. Client decrypts the current recovery keyring package, enrolls its new device credential through the control-plane CAS, then should rotate to a fresh future content-key epoch so any lost predecessor device is excluded from future writes. [ASSUMED]

### Revocation and rotation

1. An active trusted device submits a membership CAS removing the target device and creates a fresh random future content key. [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md]
2. New key packages are encrypted only to remaining active devices and current recovery public credential; relay immediately rejects future uploads/download authorization by the revoked credential after the CAS. [ASSUMED]
3. Historical ciphertext and prior epoch packages are not rewritten. Product UI and audit explicitly state that already copied plaintext/keys cannot be erased. [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md]
4. Recovery rotation replaces the recovery public credential, creates a new recovery-keyring package, deletes logical access to the old relay package, and—if passphrase recovery remains enabled—requires local passphrase entry to create a replacement passphrase package. A malicious relay may retain the former ciphertext, so rotation prevents future recovery authorization/epochs but cannot revoke historical material already decryptable with the old recovery seed. [ASSUMED]

## Relay Metadata Contract

### Allowed outer fields

| Category | Fields | Constraint |
|----------|--------|------------|
| Account routing | `issuerHash`, `subjectHash` or server-internal account ID, random `syncId` | Derive only after verified IdP token; never persist email/name claims. [CITED: https://openid.net/specs/openid-connect-core-1_0.html] |
| Device authorization | random `deviceId`, public signing/wrapping credentials, status, control version, created/revoked timestamps | Device name and profile/workspace labels remain encrypted. [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md] |
| Replay/convergence | per-device sequence, previous envelope digest, object ID, stored-at timestamp, byte length, opaque head/ack | No operation type, person/source/scope IDs, or canonical timestamps outside ciphertext. [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md] |
| Payload | nonce, ciphertext, ciphertext digest, detached signature | Relay validates shape, size, account/device authorization, uniqueness, and signature only. [ASSUMED] |
| Recovery | current recovery public authorization/wrapping credentials, opaque recovery packages, package version/timestamps | No passphrase, salt-derived key, recovery seed, keyring plaintext, or support bypass. Salt/Argon parameters may accompany the opaque passphrase package because clients need them. [CITED: https://doc.libsodium.org/password_hashing/default_phf] |

Relay schemas must be `.strict()` and persistence tests must assert the exact allowlist. Logs and metrics use stable content-free codes, byte counts, latency, and opaque IDs; never serialize request bodies or ciphertext-adjacent decrypted diagnostics. [VERIFIED: AGENTS.md]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| AEAD, signatures, key exchange, password KDF, RNG | Primitive implementations or raw curve arithmetic | `libsodium-wrappers-sumo` high-level APIs | Nonce, validation, side-channel, and parameter errors are security-critical. [CITED: https://doc.libsodium.org/quickstart] |
| Canonical signing bytes | Recursive key sorting helper | RFC 8785 `canonicalize` | Number, Unicode, negative-zero, and I-JSON edge cases make ad hoc canonicalization unsafe. [CITED: https://www.rfc-editor.org/rfc/rfc8785.html] |
| Email/password/passkey lifecycle | Local password table or WebAuthn ceremony | Provider-managed OIDC; relay verifies JWT with `jose` | Recovery, rate limiting, token validation, and passkey lifecycle are separate authentication concerns. [CITED: https://github.com/panva/jose] |
| Secret persistence | Private keys in SQLite, config, `.env`, or home-grown encrypted file | `DeviceSecretStore` with Apple Keychain Services initially | Keychain is intended for small secrets and cryptographic keys with OS access control. [CITED: https://developer.apple.com/documentation/security/storing-keys-in-the-keychain] |
| General-purpose mutable document merge | Timestamp winner or object overwrite | Immutable operation set plus explicit domain reducers | Same update set must deterministically converge while preserving incompatible decisions. [CITED: https://arxiv.org/abs/1805.06358] |
| Deletion propagation | Best-effort delete message or ciphertext GC | Permanent encrypted remove-wins tombstone plus quarantine | Offline stale peers and append-only relay retention require a durable negative fact. [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md] |
| Retry/replay handling | In-memory seen set | Durable per-device contiguous frontier, predecessor hash, operation IDs, and relay tuple uniqueness | Restart must not reopen accepted sequence numbers or silently skip gaps. [ASSUMED] |

**Key insight:** “Use reviewed primitives” is necessary but insufficient. The envelope fields, transcript binding, state machine, replay rules, membership serialization, and recovery semantics form an application protocol and therefore need their own written specification, test vectors, misuse analysis, and independent approval before production use. [CITED: https://www.rfc-editor.org/rfc/rfc9180.html]

## Common Pitfalls

### Pitfall 1: Treating relay authentication as decryption authority
**What goes wrong:** Email recovery silently becomes account takeover plus archive decryption.  
**How to avoid:** Keep account token verification, device authorization, and content-key possession as three separate gates; account access alone can fetch only ciphertext/recovery packages. [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md]

### Pitfall 2: Rotating a derived key while leaving the derivation root on revoked devices
**What goes wrong:** The revoked device computes every “new” epoch.  
**How to avoid:** Generate independent random epoch keys and wrap each only to the new active set. [ASSUMED]

### Pitfall 3: Concurrent control commits split membership
**What goes wrong:** Two devices revoke/enroll against one base and distribute different next keys.  
**How to avoid:** Exact previous-version CAS at the relay; loser refetches and explicitly rebases. Ordinary data ops remain lock-free/offline. [CITED: https://www.rfc-editor.org/rfc/rfc9420.html]

### Pitfall 4: Activation before tombstone synchronization
**What goes wrong:** A stale deleted event becomes searchable before its tombstone is applied.  
**How to avoid:** Pull control/tombstone class first, reach a stable frontier, and check the permanent tombstone index in the same transaction before inserting any data op. [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md]

### Pitfall 5: Silent deterministic conflict winner
**What goes wrong:** Replicas converge technically but the product hides a concurrent approval/rejection.  
**How to avoid:** Deterministic storage order is not semantic resolution; materialize an unresolved multi-value conflict and require a new reviewed resolution operation. [CITED: https://automerge.org/docs/reference/documents/conflicts/]

### Pitfall 6: Nonce reuse after crash or restore
**What goes wrong:** AEAD confidentiality can fail if the same key/nonce pair repeats.  
**How to avoid:** XChaCha20's 192-bit nonce permits fresh random nonces per object; never derive the nonce solely from a counter whose durable update can roll back. [CITED: https://doc.libsodium.org/secret-key_cryptography/aead/chacha20-poly1305/xchacha20-poly1305_construction]

### Pitfall 7: Incorrect signed bytes
**What goes wrong:** Different runtimes hash different JSON bytes, or attackers exploit equivalent encodings.  
**How to avoid:** Strict I-JSON schema, RFC 8785 library, fixed UTF-8, protocol/domain labels, conformance vectors, and explicit rejection of negative zero/non-finite numbers. [CITED: https://www.rfc-editor.org/rfc/rfc8785.html] [CITED: https://www.rfc-editor.org/errata/rfc8785]

### Pitfall 8: Key leakage through process/tooling surfaces
**What goes wrong:** Recovery seed or device key appears in argv, exception text, snapshots, test output, or SQLite.  
**How to avoid:** Byte-oriented secret APIs, Keychain adapter, redacted error codes, zeroization where supported, no debug serialization, and tests that scan relay/log/store artifacts for fixture secrets. [VERIFIED: AGENTS.md] [CITED: https://github.com/jedisct1/libsodium.js]

### Pitfall 9: Claiming metadata secrecy that encryption does not provide
**What goes wrong:** Users infer that timing, device relationships, archive size, and activity cadence are hidden.  
**How to avoid:** Publish the precise relay metadata table, use random IDs and optional block padding, and state residual traffic-analysis leakage. [CITED: https://www.rfc-editor.org/rfc/rfc6973.html]

### Pitfall 10: Synchronizing derived cache as independent truth
**What goes wrong:** Devices converge on stale summaries even though canonical events/tombstones differ.  
**How to avoid:** Canonical events and reviewed mutations are authoritative; derived objects retain dependencies and are invalidated/recomputed through the existing contraction queue. [VERIFIED: docs/adr/0044-source-revocation-and-attributable-deletion.md] [VERIFIED: src/daemon/contraction-runner.ts]

## Code Examples

These are integration-shape examples only. Production constants, exact transcript fields, error states, and key hierarchy must come from the approved protocol ADR and fixed test vectors. [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md]

### Canonical AEAD envelope boundary

```typescript
// Sources:
// https://github.com/jedisct1/libsodium.js
// https://doc.libsodium.org/secret-key_cryptography/aead/chacha20-poly1305/xchacha20-poly1305_construction
// https://www.rfc-editor.org/rfc/rfc8785.html
import sodium from "libsodium-wrappers-sumo";
import canonicalize from "canonicalize";

await sodium.ready;

const publicHeader = PublicEnvelopeHeaderSchema.parse(input.header);
const aad = sodium.from_string(canonicalize(publicHeader)!);
const plaintext = sodium.from_string(canonicalize(PlainOperationSchema.parse(input.operation))!);
const nonce = sodium.randombytes_buf(
  sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
);
const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
  plaintext,
  aad,
  null,
  nonce,
  epochKey
);

// The approved protocol defines the exact canonical signable structure.
const signable = sodium.from_string(canonicalize({
  domain: "cms-sync-envelope-v1",
  header: publicHeader,
  nonce: sodium.to_base64(nonce, sodium.base64_variants.URLSAFE_NO_PADDING),
  ciphertextDigest: sodium.to_hex(sodium.crypto_generichash(32, ciphertext))
})!);
const signature = sodium.crypto_sign_detached(signable, deviceSigningSecretKey);
```

The application must await `sodium.ready`; cryptographic functions are added dynamically after initialization. [CITED: https://github.com/jedisct1/libsodium.js]

### Passphrase-encrypted recovery-seed package

```typescript
// Sources:
// https://doc.libsodium.org/password_hashing/default_phf
// https://www.rfc-editor.org/rfc/rfc9106.html
const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
const key = sodium.crypto_pwhash(
  sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
  passphrase,
  salt,
  approvedOpsLimit,
  approvedMemLimit,
  sodium.crypto_pwhash_ALG_ARGON2ID13
);

try {
  const nonce = sodium.randombytes_buf(
    sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
  );
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    recoverySeed,
    recoveryPackageHeaderBytes,
    null,
    nonce,
    key
  );
  // Persist version, algorithm, salt, explicit limits, nonce, and ciphertext.
} finally {
  sodium.memzero(key);
}
```

Persist exact Argon2id parameters with the package, benchmark a product floor on supported devices, and never use a silent fallback to a cheaper KDF. [CITED: https://doc.libsodium.org/password_hashing/default_phf]

### Explicit conflict reducer

```typescript
// Domain rule: deterministic ordering does not select a semantic winner.
function reduceDecision(target: ReviewObject, incoming: DecisionOperation): ReviewObject {
  const prior = target.decisionOperations;
  const concurrent = prior.filter((op) => !causallyPrecedes(op, incoming));
  const incompatible = concurrent.filter((op) => op.decision !== incoming.decision);

  if (incompatible.length > 0) {
    return {
      ...target,
      state: "conflict",
      decisionOperations: sortedUnique([...prior, incoming], byOperationId),
      conflictOperationIds: sortedUnique(
        [...incompatible.map((op) => op.id), incoming.id]
      )
    };
  }
  return applyCausallyOrderedDecision(target, incoming);
}
```

This follows the multi-value-register principle of preserving concurrent values, while making the product conflict explicit instead of displaying Automerge's arbitrary deterministic winner. [CITED: https://automerge.org/docs/reference/documents/conflicts/]

### Relay API has no decrypt method

```typescript
export interface OpaqueSyncRelay {
  compareAndSwapMembership(input: OpaqueMembershipCommit): Promise<ControlReceipt>;
  appendEnvelope(input: RelayEnvelopeRecord): Promise<AppendReceipt>;
  listEnvelopes(input: RelayCursorQuery): Promise<RelayEnvelopePage>;
  getRecoveryPackages(syncId: string): Promise<OpaqueRecoveryPackage[]>;
}

// Relay domain must not import CryptoProvider, CanonicalEvent, Summary,
// SourceGrant, profile configuration, or any plaintext operation schema.
```

An architecture test should enforce the import boundary and exact relay schema field allowlist. [ASSUMED]

## State of the Art

| Old / tempting approach | Current recommended approach | Evidence / Impact |
|-------------------------|------------------------------|-------------------|
| One server-authoritative database | Local-first replicas that exchange operations and converge from the same update set | Preserves offline local authority and multi-device ownership. [CITED: https://martin.kleppmann.com/2019/10/23/local-first-at-onward.html] |
| Session/file replacement sync | Immutable operation log with causal metadata and domain reducers | Supports deterministic multi-writer merge and inspectable conflicts. [CITED: https://arxiv.org/abs/1805.06358] |
| AES-GCM with manually managed 96-bit counters | XChaCha20-Poly1305 with fresh random 192-bit nonces | Reduces state-loss nonce-reuse risk for independently generated archive objects. [CITED: https://doc.libsodium.org/secret-key_cryptography/aead/chacha20-poly1305/xchacha20-poly1305_construction] |
| Password directly encrypts archive | High-entropy recovery seed; optional Argon2id passphrase wrapper around that seed | Keeps archive encryption keys random while allowing an opt-in human recovery layer. [CITED: https://www.rfc-editor.org/rfc/rfc9106.html] |
| Email as database identity | Verified OIDC `(iss, sub)` pseudonymous identity | Email can change and is not guaranteed unique; `iss` + `sub` is the stable identifier. [CITED: https://openid.net/specs/openid-connect-core-1_0.html] |
| General JSON stringify/hash | RFC 8785 JCS and conformance vectors | Produces invariant hash/signature bytes and defines Unicode/number handling. [CITED: https://www.rfc-editor.org/rfc/rfc8785.html] |

**Deprecated/outdated for this phase:**

- Reusing `mutationEffectsFingerprint`'s local `stableJson` as a protocol canonicalizer is not acceptable; it was designed as a content-free local binding and does not claim RFC 8785 conformance. [VERIFIED: src/storage/mcp-mutation-contracts.ts]
- Using `crypto_secretstream` for independently fetched/random-access objects is a mismatch because its stateful stream framing is intended for ordered streams/files; per-object XChaCha AEAD is the correct archive-object boundary. [CITED: https://doc.libsodium.org/secret-key_cryptography/secretstream]
- `crypto_box` legacy padded APIs are not recommended; use `_easy`, sealed-box, and detached-signature high-level APIs only. [CITED: https://doc.libsodium.org/public-key_cryptography/authenticated_encryption]

## Project Constraints (from AGENTS.md)

- Preserve strict workspace/thread/person/scope isolation; full encrypted device replication never authorizes cross-scope retrieval. [VERIFIED: AGENTS.md]
- Persisted memory is assistive, not ground truth; preserve source IDs, trace IDs, timestamps, confidence, and provenance through synchronization. [VERIFIED: AGENTS.md]
- Preserve human approval for proposals, box changes, sleep conclusions, conflicts, restoration, and destructive mutations; synchronization cannot auto-approve. [VERIFIED: AGENTS.md]
- Never persist raw secrets, API keys, tokens, passwords, private keys, or client documents in memory artifacts; redact secrets as `[REDACTED]`. [VERIFIED: AGENTS.md]
- External LLMs and hosted services cannot be mandatory for deterministic/local tests; use adapter-gated fakes. [VERIFIED: AGENTS.md]
- Budget packing and injection/resume/compaction ordering/fallback behavior remain deterministic and tested. [VERIFIED: AGENTS.md]
- Preserve unrelated dirty work; the worktree was already materially dirty before research and only this research file may be added by this task. [VERIFIED: git status 2026-07-19]
- Treat `example/` as reference/vendor material and do not modify it. [VERIFIED: AGENTS.md]
- Read relevant ADRs, use Graphify when paths are unclear, keep diffs scoped, and add tests beside behavior. GSD Graphify integration was disabled; repository paths and canonical ADRs were inspected directly. [VERIFIED: AGENTS.md] [VERIFIED: gsd-tools graphify status]
- Before implementation finish: run `git diff --check`, the narrowest relevant Vitest tests or `npm test`, and `npm run typecheck` for TypeScript changes; report files, checks, ADR/Graphify use, isolation review, blockers, and dirty-state before/after. [VERIFIED: AGENTS.md]

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Node.js | TypeScript runtime and `node:sqlite` | ✓ | 24.7.0 | Set minimum runtime explicitly; repository types currently target Node 20 and need sync crypto/SQLite declarations updated. [VERIFIED: environment probe] |
| npm | Package installation | ✓ | 11.5.1 | Use task-local cache if the existing user npm cache remains root-owned. [VERIFIED: environment probe] |
| SQLite CLI | Diagnostics only | ✓ | 3.45.3 | `node:sqlite` is the application path. [VERIFIED: environment probe] |
| Vitest | Deterministic validation | ✓ installed | 2.1.9 lockfile | Existing test framework. [VERIFIED: package-lock.json] |
| TypeScript | Type checking | ✓ installed | 5.9.3 lockfile | Existing `npm run typecheck`. [VERIFIED: package-lock.json] |
| Swift / `swiftc` | Native macOS Keychain bridge | ✓ | Swift 6.3 | Keep behind `DeviceSecretStore`; tests use fake adapter. [VERIFIED: environment probe] |
| macOS `security` CLI | Manual diagnostics only | ✓ | system | Do not pass secrets in argv; production bridge should use Keychain Services API. [CITED: https://developer.apple.com/documentation/security/keychain-services] |
| Docker | Optional relay integration container | ✓ | 29.2.0 | In-process relay fixture is the default deterministic test path. [VERIFIED: environment probe] |
| Hosted relay / IdP | Production synchronization/account flow | ✗ not configured | — | Local in-process opaque relay and fake account authenticator for all automated tests; production provider is an open deployment decision. [VERIFIED: repository inspection] |
| Context7 / `ctx7` | Preferred docs lookup | ✗ unavailable | — | Official RFC, upstream, Apple, OWASP, and OpenID sources were used through web lookup. [VERIFIED: environment probe] |

**Missing dependencies with no fallback:** production identity provider and hosted relay target must be selected before live deployment, but they do not block protocol/domain/storage implementation or deterministic validation. [ASSUMED]

**Missing dependencies with fallback:** Context7 was unavailable; primary official sources were fetched directly. No live personal history, relay, IdP, or external model is needed for tests. [VERIFIED: environment probe] [VERIFIED: AGENTS.md]

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 2.1.9 with existing TypeScript/SQLite fixtures. [VERIFIED: package-lock.json] |
| Config file | `vitest.config.ts`. [VERIFIED: repository inspection] |
| Quick run command | `npx vitest run tests/sync tests/relay`. [ASSUMED] |
| Full suite command | `npm test && npm run typecheck`. [VERIFIED: AGENTS.md] |

### Determinism rules

- Production crypto obtains randomness only from libsodium/OS RNG; tests inject fixed synthetic keys/nonces through a test-only `CryptoProvider` or use deterministic seed APIs solely for published fixtures. No production configuration may enable deterministic randomness. [CITED: https://doc.libsodium.org/generating_random_data]
- Use fake wall/monotonic clocks, fake OIDC verifier, in-memory opaque relay, temporary SQLite databases, deterministic network partitions, reorder/duplicate/drop/tamper fault injection, and synthetic people/sources/scopes. Never inspect live histories or real credentials. [VERIFIED: AGENTS.md]
- Convergence tests generate one operation set, deliver every permutation/partition schedule, then assert byte-equivalent materialized semantic state, identical conflict/tombstone sets, and equivalent canonical order once all operations arrive. [CITED: https://arxiv.org/abs/1805.06358]
- Cryptographic conformance tests include RFC 8785 examples/errata, upstream libsodium round-trip/tamper behavior, fixed signing/box vectors, wrong-key failures, AAD mutation, nonce uniqueness instrumentation, and Argon2 package parameter decoding. [CITED: https://www.rfc-editor.org/rfc/rfc8785.html] [CITED: https://github.com/jedisct1/libsodium.js]
- Every relay integration test serializes its entire persistent state and asserts absence of fixture plaintext, person/source/scope/profile/workspace labels, device name, passphrase, recovery seed, and epoch keys. Also assert the exact outer-field allowlist. [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md]

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| REQ-031 | Relay/network/storage artifacts cannot decrypt or contain semantic plaintext; tamper and wrong-key fail closed | unit + integration | `npx vitest run tests/sync/crypto-envelope.test.ts tests/relay/zero-knowledge-boundary.test.ts` | ❌ Wave 0 |
| REQ-032 | Active-device enrollment requires matching transcript code, valid signature, expiry/single use; recovery requires relay account plus current recovery key; new device reconstructs full history | state-machine + integration | `npx vitest run tests/sync/enrollment.test.ts tests/sync/recovery.test.ts` | ❌ Wave 0 |
| REQ-033 | Revoked credential is denied; next epoch excludes it; remaining devices retain old history; concurrent control CAS cannot fork | integration + adversarial | `npx vitest run tests/sync/revocation.test.ts tests/relay/membership-cas.test.ts` | ❌ Wave 0 |
| REQ-034 | Partitions, reorder, duplication, restart, and concurrent additions converge; incompatible decisions remain explicit conflicts | property + integration | `npx vitest run tests/sync/convergence.test.ts tests/sync/conflicts.test.ts` | ❌ Wave 0 |
| REQ-035 | Tombstones apply before data, persist indefinitely, quarantine stale adds, prevent retrieval, and require reviewed restoration | integration | `npx vitest run tests/sync/deletion-tombstones.test.ts` | ❌ Wave 0 |
| REQ-036 | Relay persists only allowed metadata, rejects unknown fields, detects replay/equivocation, and keeps all ciphertext versions | contract + integration | `npx vitest run tests/relay/metadata-contract.test.ts tests/relay/append-only-store.test.ts` | ❌ Wave 0 |

### Required adversarial matrix

| Scenario | Required assertion |
|----------|--------------------|
| Replay identical envelope | Idempotent same receipt; no duplicate materialization. [ASSUMED] |
| Same `(device, seq)` with different bytes | Equivocation error; neither conflicting new version becomes active. [ASSUMED] |
| Missing predecessor / huge sequence jump | Gap is bounded and pending; no unbounded work or frontier advance. [CITED: https://www.rfc-editor.org/rfc/rfc9420.html] |
| Relay reorders tombstone after content | Client's two-pass/control-first apply still quarantines covered content before retrieval. [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md] |
| Relay omits tombstone forever | Client cannot promise convergence; records gap/stale head and never claims synced. [ASSUMED] |
| Revoked device uploads/fetches | Relay authorization denies; peers also reject its post-revocation sequence/epoch locally. [ASSUMED] |
| Revoked device reads old local copy | Succeeds by design; UI/audit never claims remote erasure. [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md] |
| Concurrent approve/reject | Both signed ops preserved; object state is `conflict`; no timestamp winner. [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md] |
| Wrong person/scope in decrypted operation | Fail closed before storage/materialization; no cross-profile retrieval widening. [VERIFIED: docs/adr/0046-person-and-retrieval-scope-boundaries.md] |
| Crash at every transaction boundary | Outbox/apply resumes exactly once and replay frontier matches committed effects. [VERIFIED: src/storage/mcp-mutation-contracts.ts] |
| Weak/incorrect passphrase | Uniform decryption failure with no oracle detail; relay cannot test through an API beyond offline ciphertext guessing. [CITED: https://doc.libsodium.org/password_hashing/default_phf] |

### Sampling Rate

- **Per task commit:** nearest new sync/relay Vitest file plus `npm run typecheck` when types change. [VERIFIED: AGENTS.md]
- **Per wave merge:** `npx vitest run tests/sync tests/relay tests/storage/sqlite-store.test.ts tests/daemon/contraction-runner.test.ts tests/mcp` and `npm run typecheck`. [ASSUMED]
- **Phase gate:** Full `npm test`, `npm run typecheck`, deterministic multi-device scenario suite, relay-artifact privacy scan, protocol vector suite, and independent protocol-approval checkpoint all green before `$gsd-verify-work`. [VERIFIED: AGENTS.md] [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md]

### Wave 0 Gaps

- [ ] `docs/adr/0047-zero-knowledge-sync-threat-model-and-protocol.md` — exact roles, state machines, canonical bytes, domains, keys, rotation, replay, recovery, tombstone, and failure semantics; independent human/security approval blocks production crypto implementation. [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md]
- [ ] `tests/sync/fixtures.ts` — synthetic devices, fixed keys/nonces, fake clocks, operation generators, partitions, and no-personal-history guard. [VERIFIED: AGENTS.md]
- [ ] `tests/sync/crypto-envelope.test.ts` — primitive/wire vectors and tamper matrix. [ASSUMED]
- [ ] `tests/sync/convergence.test.ts` — permutation, partition, duplicate, restart property scenarios. [ASSUMED]
- [ ] `tests/sync/enrollment.test.ts`, `recovery.test.ts`, `revocation.test.ts`, `conflicts.test.ts`, `deletion-tombstones.test.ts`. [ASSUMED]
- [ ] `tests/relay/metadata-contract.test.ts`, `zero-knowledge-boundary.test.ts`, `membership-cas.test.ts`, `append-only-store.test.ts`. [ASSUMED]
- [ ] `DeviceSecretStore` fake and macOS Keychain contract tests; production adapter must never expose secrets through argv/stdout. [CITED: https://developer.apple.com/documentation/security/keychain-services]
- [ ] Exact RFC 8785 conformance corpus and protocol-version downgrade/unknown-field rejection cases. [CITED: https://www.rfc-editor.org/rfc/rfc8785.html]

## Security Domain

Security enforcement is enabled because `.planning/config.json` does not set `security_enforcement: false`. Nyquist validation is enabled because `workflow.nyquist_validation` is absent rather than explicitly false. [VERIFIED: .planning/config.json]

### Applicable ASVS Categories

OWASP's current stable ASVS is 5.0.0; use version-qualified references in the eventual security plan because requirement numbering changes between releases. [CITED: https://owasp.org/www-project-application-security-verification-standard/]

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| Authentication | yes | Provider-issued account token verification plus independent active-device/recovery authorization; relay account alone never decrypts. [CITED: https://github.com/panva/jose] |
| Session / token management | yes | Verify issuer, audience, signature, expiry/not-before; do not log bearer tokens; keep relay auth adapter separate from archive keys. [CITED: https://github.com/panva/jose] |
| Access control | yes | Account/sync/device authorization on every relay operation; current membership CAS; local person/scope checks after decrypt. [VERIFIED: docs/adr/0046-person-and-retrieval-scope-boundaries.md] |
| Input validation / encoding | yes | Strict Zod schemas, size/count limits, RFC 8785 I-JSON, unknown-version/field rejection, authenticated parse boundary. [CITED: https://www.rfc-editor.org/rfc/rfc8785.html] |
| Stored cryptography | yes | Libsodium high-level AEAD/signatures/boxes/Argon2id; OS secret store; no hand-rolled primitive or plaintext key persistence. [CITED: https://doc.libsodium.org/] |
| Data protection / privacy | yes | Exact relay metadata allowlist, semantic fields encrypted, content-free logs, residual traffic-analysis disclosure. [CITED: https://www.rfc-editor.org/rfc/rfc6973.html] |
| Communication security | yes | HTTPS remains mandatory even over E2EE to protect bearer account tokens and transport metadata from passive network observers. [CITED: https://owasp.org/www-project-web-security-testing-guide/stable/4-Web_Application_Security_Testing/09-Testing_for_Weak_Cryptography/03-Testing_for_Sensitive_Information_Sent_via_Unencrypted_Channels.html] |
| Business logic | yes | Enrollment expiry/single use, membership CAS, recovery rotation, conflict state, tombstone barrier, append-only retention, and honest revocation semantics. [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md] |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Forged device/control operation | Spoofing / Tampering | Verified active credential, Ed25519 signature over canonical domain-separated bytes, exact control CAS. [CITED: https://doc.libsodium.org/public-key_cryptography/public-key_signatures] |
| Ciphertext/header substitution | Tampering | Bind complete public header as AEAD AAD and signature input; reject any mismatch. [CITED: https://doc.libsodium.org/secret-key_cryptography/aead/chacha20-poly1305/xchacha20-poly1305_construction] |
| Replay, rollback, duplicate, equivocation | Tampering / Repudiation | Durable per-device sequences, previous hashes, operation IDs, high-water marks, tuple uniqueness, signed observed heads. [CITED: https://www.rfc-editor.org/rfc/rfc9180.html] |
| Relay or account operator reads archive | Information disclosure | Device-side AEAD; key packages encrypted only to device/recovery public credentials; negative knowledge tests. [VERIFIED: .planning/REQUIREMENTS.md] |
| Metadata/size correlation | Information disclosure | Opaque random IDs, no semantic names, minimal logs, optional fixed-block padding, explicit residual-risk statement. [CITED: https://www.rfc-editor.org/rfc/rfc6973.html] |
| Huge gap/record/key-package fanout | Denial of service | Schema limits, maximum envelope size, bounded sequence gap/window, pagination, per-account/device rate limits, no expensive decrypt before cheap validation. [CITED: https://www.rfc-editor.org/rfc/rfc9420.html] |
| Weak recovery passphrase | Information disclosure | Argon2id with stored explicit parameters and benchmarked floor, strength UX, no support bypass; disclose offline guessing risk. [CITED: https://www.rfc-editor.org/rfc/rfc9106.html] |
| Stale deleted content reintroduction | Tampering / Elevation of privilege | Remove-wins tombstone index checked transactionally before materialization; quarantine and reviewed restoration only. [VERIFIED: .planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md] |
| Cross-scope retrieval after full archive enrollment | Information disclosure / Elevation of privilege | Existing fail-closed person plus complete allowed-scope dependency closure on every local MCP read/mutation. [VERIFIED: docs/adr/0046-person-and-retrieval-scope-boundaries.md] |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | A permanently partitioning malicious relay cannot be forced to reveal a split view; signed head witnessing detects it only after observations cross partitions. | Threat Model | Security claims could overstate malicious-relay integrity/availability; protocol review must qualify exact guarantees. |
| A2 | Relay CAS is acceptable for membership/key control even though ordinary archive writes must not rely on a single online writer. | Architecture Patterns | If all control must also be offline-convergent, the key schedule requires a substantially different reviewed protocol. |
| A3 | Independent random epoch keys plus per-recipient packages are the approved key hierarchy. | Architecture Patterns | Recovery/package growth and rotation behavior change if a formal reviewer selects a different standard construction. |
| A4 | Recovery seed can safely authorize enrollment and derive separate recovery credentials under an approved domain-separated construction. | Enrollment/Recovery | This is protocol composition, not a standalone primitive; wrong binding could compromise recovery or create key reuse. |
| A5 | Exact envelope sequence/hash-chain rules and two-pass tombstone application described here are sufficient after independent review. | Architecture Patterns | Gaps, rollback, or reintroduction may remain possible if the state machine is underspecified. |
| A6 | Provider-managed OIDC is the production account boundary and the relay need persist only verified pseudonymous identity. | Standard Stack | Deployment/provider constraints may require a different account adapter or additional allowed metadata. |
| A7 | A native Swift Keychain helper is acceptable for the initial macOS secret-store adapter. | Environment Availability | Packaging/signing/entitlements or future non-macOS devices may require a different secret-store implementation. |

All assumptions above require explicit resolution in the protocol ADR or planning checkpoints; none should silently become a locked cryptographic decision. [VERIFIED: research protocol]

## Resolved Questions

All five research questions are **RESOLVED** by the Phase 06 plan set. The locked decisions in `06-CONTEXT.md` remain unchanged; these dispositions fill only areas assigned to the agent's discretion.

1. **RESOLVED — composed-protocol approval:** Plan 06-01 writes ADR 0047, fixed vectors, assumptions A1–A7 dispositions, and a protocol digest, then blocks all production cryptography on a qualified independent reviewer recording `Disposition: Approved` and `Blocking Findings: None` for that exact digest.
2. **RESOLVED — production IdP, relay, and transport:** Auth0 Universal Login is the production D-16 account boundary for conventional email/password and passkey recovery. Plan 06-05 owns configured issuer/audience/JWKS verification plus `src/relay/service/opaque-relay-service.ts`, the three `src/relay/storage/*relay-store.ts` contracts/adapters, and the strict versioned `src/relay/http/relay-http-server.ts`; Plan 06-06 owns production `src/sync/transport/http-sync-relay.ts` with bounded timeouts and exact auth/status mapping; Plan 06-08 owns daemon selection and the real `tests/integration/multi-device-sync.test.ts` loopback end-to-end path. Base URL, deployment region, database path, retention/rate bounds, and TLS-termination acknowledgement remain explicit deployment configuration. Deterministic fakes do not satisfy the production transport path. Account recovery continues to grant service access only and cannot enroll or decrypt.
3. **RESOLVED — device-secret platforms:** Phase 06 acceptance is macOS-first. Plan 06-03 defines a host-neutral `DeviceSecretStore` and ships a non-synchronizable macOS Keychain implementation with no plaintext fallback. Additional OS adapters are outside this phase's platform acceptance boundary; the host-neutral interface prevents their absence from weakening macOS storage.
4. **RESOLVED — ciphertext padding:** Plan 06-01 benchmarks 4 KiB and 16 KiB buckets against synthetic canonical/review/tombstone distributions under D-14 retention, records the selected versioned policy in ADR 0047, authenticates original length, bounds allocation, rejects downgrade, and documents residual timing/frequency/direction/identifier/size leakage. The independent reviewer approves the resulting choice rather than this research note silently fixing it.
5. **RESOLVED — split-view transparency:** ADR 0047 must make an explicit reviewed v1 disposition. The minimum accepted design exchanges signed observed account heads inside encrypted operations and reports withholding/partition as incomplete; it never claims availability or permanent split-view detection. RFC 9162-style Merkle transparency is included only if the independent reviewer makes it a blocking requirement for the approved v1 threat claims.

## Sources

### Primary standards and official documentation (MEDIUM confidence via verified official web sources)

- https://www.rfc-editor.org/rfc/rfc9180.html — HPKE goals and explicit non-goals for replay, ordering, length hiding, and forward secrecy.
- https://www.rfc-editor.org/rfc/rfc9420.html — MLS epochs, membership rotation, new-member history boundary, concurrent commits, reordering limits, and metadata leakage.
- https://www.rfc-editor.org/rfc/rfc9106.html — Argon2id parameter-selection guidance.
- https://www.rfc-editor.org/rfc/rfc8785.html and https://www.rfc-editor.org/errata/rfc8785 — canonical JSON and verified errata.
- https://www.rfc-editor.org/rfc/rfc6973.html — identifiers, traffic analysis, correlation, and data minimization.
- https://www.rfc-editor.org/rfc/rfc8467.html — padding-policy tradeoffs; applied by analogy rather than as a CMS wire standard.
- https://www.rfc-editor.org/rfc/rfc5763.html — short authentication strings and approximately 64-bit secure fingerprint guidance.
- https://www.rfc-editor.org/rfc/rfc9162.html — append-only Merkle consistency proofs and split-view context.
- https://doc.libsodium.org/ — AEAD, authenticated public-key encryption, signatures, password hashing, KDF, random data, and secretstream boundaries.
- https://github.com/jedisct1/libsodium.js — official JavaScript wrappers, initialization, npm package names, sumo/pwhash distinction, and current release.
- https://openid.net/specs/openid-connect-core-1_0.html — stable `iss`/`sub` identity and non-unique email claim.
- https://github.com/panva/jose — current JWT/JWKS verification library documentation.
- https://developer.apple.com/documentation/security/keychain-services — macOS secret/key storage boundary.
- https://owasp.org/www-project-application-security-verification-standard/ — ASVS 5.0.0 security-verification basis.

### Primary research and maintained upstream documentation (MEDIUM confidence)

- https://arxiv.org/abs/1805.06358 — CRDT deterministic convergence from the same update set.
- https://martin.kleppmann.com/2019/10/23/local-first-at-onward.html — local-first offline/multi-device architecture.
- https://automerge.org/docs/reference/documents/conflicts/ — preservation and deterministic representation of concurrent conflicting values.

### Repository evidence (HIGH confidence for current codebase)

- `AGENTS.md` — privacy, isolation, testing, dirty-worktree, and reporting constraints.
- `.planning/phases/06-zero-knowledge-multi-device-sync/06-CONTEXT.md` — locked phase decisions.
- `.planning/REQUIREMENTS.md` — REQ-031 through REQ-036.
- `docs/adr/0040-personal-canonical-timeline.md`, `0044-source-revocation-and-attributable-deletion.md`, `0046-person-and-retrieval-scope-boundaries.md` — ordering, deletion, and scope authority.
- `src/domain/canonical.ts`, `src/storage/memory-store.ts`, `src/storage/mcp-mutation-contracts.ts`, `src/daemon/contraction-runner.ts` — current deterministic identity, transaction, storage, and recomputation seams.

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH for package identity/version/legitimacy and official primitive APIs; MEDIUM for the composed selection pending protocol approval.
- Architecture: MEDIUM — grounded in repository contracts, CRDT research, and standards, with key-control/data-plane separation still requiring design review.
- Pitfalls: MEDIUM — directly supported by RFC/upstream limitations and existing product constraints; malicious-relay split-view limits remain an explicit assumption.
- Validation: HIGH for repository framework/fixtures and required deterministic boundaries; MEDIUM for final protocol vectors until the ADR is approved.

**Research date:** 2026-07-19  
**Valid until:** 2026-08-18 for package versions and provider guidance; protocol decisions remain invalid for production until independent approval regardless of date.
