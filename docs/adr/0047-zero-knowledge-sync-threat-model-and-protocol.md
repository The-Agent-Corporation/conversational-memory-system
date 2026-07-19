# ADR 0047: Zero-Knowledge Sync Threat Model and Protocol

## Status

Proposed / Security Review Required

Production cryptography, enrollment, recovery, and relay acceptance MUST remain disabled until the independent review record at the end of this ADR approves the exact protocol digest with no blocking findings.

## Protocol Version

- Protocol: `cms-sync-v1`
- Wire major: `1`
- Padding policy: `cms-sync-padding-v1`
- Review package digest: recorded below after the end-of-package marker
- Upgrade rule: an implementation accepts only an explicitly enabled wire major and padding-policy identifier. Unknown, missing, older, or newer values fail closed; there is no implicit downgrade or best-effort parse.

Normative terms MUST, MUST NOT, SHOULD, and MAY have their RFC 2119 meanings. This ADR defines a protocol contract, not a production `CryptoProvider` implementation.

## Context and Security Claims

The archive is person-owned and local-first. A relay account, an authorized device, and possession of archive keys are three separate authorities:

1. **Account authentication** permits access to one pseudonymous relay namespace.
2. **Device authorization** permits a current device credential to participate in a specific control version and upload or fetch eligible opaque records.
3. **Key possession** permits a local endpoint to decrypt an epoch. Account recovery alone grants neither device authorization nor key possession.

The relay cannot decrypt synchronized memory, cannot interpret semantic operation types, and cannot grant archive enrollment by itself. These claims do not cover a compromised trusted endpoint, plaintext native histories, or traffic-analysis metadata identified under Residual Risk.

## Roles and Trust Anchors

| Role | Authority | Explicitly lacks |
|---|---|---|
| Local archive owner | Reviews enrollment, conflict, deletion, restoration, and recovery actions | No ability to erase a former offline device remotely |
| Active device | Current Ed25519 signing credential, X25519 wrapping credential, complete local historical keyring | Authority after a committed revocation |
| Candidate device | Locally generated public keys and ephemeral enrollment key | Membership, history, or decryption before approval |
| Recovery holder | Current high-entropy recovery seed plus authenticated relay-account access | Enrollment with either factor alone |
| Relay account provider | Auth0 Universal Login account lifecycle and signed OIDC tokens | Device approval, recovery seed, archive keys, plaintext |
| Opaque relay | Authenticated namespace routing, exact membership CAS, append-only ciphertext retention | Semantic schemas, person/source/scope labels, decryption or support bypass |
| Local MCP/agent client | Retrieval allowed by a named local profile and its person/scope authority | Device-wide archive access merely because ciphertext is synchronized locally |

Trust anchors are the reviewed libsodium primitives, OS cryptographic random generator, OS secret store, pinned protocol contract, configured Auth0 issuer/audience/JWKS, HTTPS deployment boundary, and explicit human comparison/approval steps. Retrieved memory remains assistive context rather than authority.

## Cryptographic Suite and Key Hierarchy

Protocol v1 fixes these uses; substitutes require a new reviewed protocol version.

| Purpose | Construction | Rule |
|---|---|---|
| Operation encryption | XChaCha20-Poly1305-IETF | Fresh random 192-bit nonce for every sealed object; exact AAD below |
| Device signatures | Ed25519 detached signatures | Sign the exact domain-separated JCS preimage below before relay acceptance |
| Device wrapping | X25519 through libsodium authenticated `crypto_box` | Approver-to-candidate historical keyring package |
| Recovery wrapping | X25519 sealed box plus authorizing Ed25519 signature | Complete historical keyring package to current recovery public credential |
| Enrollment session | X25519 role-separated key exchange | Both endpoints derive the code locally from the same bound transcript |
| Recovery derivation | libsodium KDF from a random 32-byte recovery seed | 32-byte Ed25519 seed with context `CMSRSIG1`, subkey 1; 32-byte X25519 seed with context `CMSRBOX1`, subkey 1 |
| Optional passphrase package | Argon2id then XChaCha20-Poly1305-IETF | Wraps only the recovery seed; parameters and salt are public and authenticated |
| Digests and transcript codes | libsodium generic hash | Fixed domain labels and lengths below; never used as encryption keys without the specified KDF |
| Canonical encoding | RFC 8785 JSON Canonicalization Scheme | UTF-8 I-JSON only; duplicate keys, lone surrogates, negative zero, NaN, and infinities are rejected before canonicalization |

Every data epoch key is an independent random 32-byte value. An epoch key MUST NOT be derived from a prior epoch, account secret, device key, or recovery seed. Each active device retains the historical keyring in the OS secret store. Revocation creates a fresh epoch key and new per-recipient packages only for remaining active devices and the current recovery credential. It does not rewrite historical ciphertext.

Private device keys, epoch keys, recovery seeds, and passphrases never enter ordinary SQLite rows, relay records, logs, command arguments, fixtures, or diagnostics. Synthetic fixed values are allowed only in deterministic tests.

## Canonical Bytes and Domain Labels

All JSON objects in this section are strict closed schemas. No unknown property is accepted. All byte strings use unpadded base64url. UUID-like identifiers are 128-bit random values encoded as 32 lowercase hexadecimal characters; they carry no semantic name.

Canonical bytes are `UTF8(RFC8785(value))`. Implementations MUST parse to an I-JSON value, validate the closed schema and ranges, canonicalize it, and compare with the received bytes where canonical bytes are transported. A signature or AEAD check does not authorize an otherwise invalid schema.

Fixed domain labels:

| Use | Label |
|---|---|
| Envelope AAD | `cms.sync.v1/envelope-aad` |
| Envelope signature | `cms.sync.v1/envelope-signature` |
| Operation payload | `cms.sync.v1/operation` |
| Control commit | `cms.sync.v1/control-commit` |
| Enrollment transcript | `cms.sync.v1/enrollment-transcript` |
| Enrollment verification code | `cms.sync.v1/enrollment-code` |
| Recovery authorization | `cms.sync.v1/recovery-authorization` |
| Recovery package | `cms.sync.v1/recovery-package` |
| Passphrase package | `cms.sync.v1/passphrase-package` |
| Signed observed head | `cms.sync.v1/observed-head` |

### Operation envelope

The exact relay-visible `header` schema is:

```json
{"ciphertextLength":4096,"createdAt":"2030-01-02T03:04:05.000Z","deviceId":"22222222222222222222222222222222","epoch":7,"objectId":"33333333333333333333333333333333","paddingPolicy":"cms-sync-padding-v1","previousEnvelopeHash":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","protocol":"cms-sync-v1","sequence":42,"syncId":"11111111111111111111111111111111"}
```

`sequence` is an integer from 1 through `9_007_199_254_740_991`. Sequence 1 uses the 32-byte zero digest as `previousEnvelopeHash`. `epoch` is a positive safe integer. `createdAt` is canonical UTC RFC 3339 with exactly three fractional digits. It is ordering metadata only, not authority.

AEAD associated-data bytes are exactly:

```text
UTF8(RFC8785({"domain":"cms.sync.v1/envelope-aad","header":<header>}))
```

The detached Ed25519 signature preimage is exactly:

```text
UTF8(RFC8785({"ciphertextDigest":<base64url-32-byte-generic-hash>,"domain":"cms.sync.v1/envelope-signature","header":<header>,"nonce":<base64url-24-byte-nonce>}))
```

Relay record fields are exactly `header`, `nonce`, `ciphertext`, `ciphertextDigest`, and `signature`. The relay verifies schema, bounds, membership, sequence tuple, digest, and signature without decrypting.

### Padded plaintext

The AEAD plaintext is binary:

```text
uint32be(operationByteLength) || UTF8(RFC8785(operation)) || randomPadding
```

The four-byte original length is encrypted and AEAD-authenticated. After successful decryption, a client MUST reject a length larger than the available plaintext, a non-canonical operation, a schema mismatch, or non-random-looking padding only when a deterministic test provider explicitly supplies padding evidence; production does not use padding bytes as an oracle. Allocation is bounded before decrypt by `ciphertextLength <= 16_777_216` and after decrypt by the same cap. The XChaCha tag is 16 bytes, so the plaintext length is `ciphertextLength - 16`.

### Decrypted operation

The strict operation object is:

```json
{"body":{},"causalHeads":[],"domain":"cms.sync.v1/operation","operationId":"44444444444444444444444444444444","operationType":"canonical.append","originDeviceId":"22222222222222222222222222222222","originSequence":42,"protocol":"cms-sync-v1"}
```

`body` is a tagged closed schema selected by `operationType`; it contains all semantic identifiers and content. `causalHeads` is a sorted unique list of signed observed-head digests or operation IDs as defined by that body. It is encrypted. Envelope identity and origin fields MUST agree after decrypt or the object is rejected permanently.

## Control Plane Wire Contract

Membership and key control are linear. A `MembershipCommit` has exact fields:

```json
{"activeDevices":[],"controlVersion":8,"domain":"cms.sync.v1/control-commit","epoch":7,"keyPackageDigests":[],"previousCommitHash":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","previousControlVersion":7,"protocol":"cms-sync-v1","recoveryCredentialId":"55555555555555555555555555555555","revokedDevices":[],"syncId":"11111111111111111111111111111111"}
```

The arrays are sorted by random ID, contain strict typed entries, and contain no device names. Each commit includes per-active-device packages for the complete keyring when enrolling, or the new epoch key when rotating. The authorizing signature is over `UTF8(RFC8785(commit))` prefixed structurally by the `cms.sync.v1/control-commit` domain already inside the object.

The relay accepts a commit only when all conditions hold atomically:

1. `previousControlVersion` equals the stored current version and `controlVersion` is exactly previous plus one.
2. `previousCommitHash` equals the stored commit digest.
3. The signer is active in the previous version, or the request contains a valid current single-use recovery authorization and authenticated account session.
4. Device/recovery transitions are valid, every required package is present, and no revoked credential is reactivated.
5. The `(syncId, controlVersion)` slot is empty.

A CAS loser fetches the committed head and requires a new explicit action; it never silently rebases a security decision. Ordinary data envelopes do not use this lock and remain offline multi-writer.

## State Machines

### Normal remote enrollment

States are `absent -> requested -> code_verified -> committed -> consumed`, with terminal `expired`, `rejected`, and `invalid` states.

1. The candidate locally generates independent Ed25519, long-term X25519, and ephemeral X25519 keypairs plus random `deviceId`, `requestId`, and nonce.
2. It uploads an account-authenticated request with public keys, a ten-minute `expiresAt`, and an encrypted device-name blob. The relay never sees the name.
3. One active approver fetches the request. Both devices derive role-separated X25519 session keys and the exact transcript:

```json
{"approverDeviceId":"22222222222222222222222222222222","approverEphemeralKey":"<base64url-32>","candidateDeviceId":"66666666666666666666666666666666","candidateEphemeralKey":"<base64url-32>","candidateSigningKey":"<base64url-32>","candidateWrappingKey":"<base64url-32>","domain":"cms.sync.v1/enrollment-transcript","expiresAt":"2030-01-02T03:14:05.000Z","protocol":"cms-sync-v1","requestId":"77777777777777777777777777777777","requestNonce":"<base64url-32>","syncId":"11111111111111111111111111111111"}
```

4. Each endpoint computes `genericHash(key=sessionConfirmationKey, message=UTF8("cms.sync.v1/enrollment-code") || 0x00 || RFC8785(transcript), outlen=8)`. The 64-bit result is displayed as four groups of four uppercase hexadecimal digits. It expires with the request and is never sent as authority to the relay.
5. The owner verifies both device names and codes, then the approver signs a commit containing the candidate and an authenticated X25519 package of the **complete historical keyring**.
6. A successful CAS atomically consumes the request. A request ID is single-use; replay, second approval, mismatch, expiry, or already-consumed state fails content-free. Failed code comparison cannot commit and is locally rate-limited.

### Recovery-key enrollment

States are `account_authenticated -> package_fetched -> recovery_proven -> commit_pending -> committed -> consumed`, with terminal failure.

Account access and the current recovery seed are both required. The candidate proves possession by signing a fresh relay challenge bound to `cms.sync.v1/recovery-authorization`, `syncId`, candidate public keys, current `controlVersion`, nonce, and expiry. The challenge expires after ten minutes and is consumed by the successful CAS. The current recovery keyring package yields the complete historical keyring; the new device is not active and receives no archive bytes until the control commit succeeds. Account Recovery Cannot Enroll or Decrypt without the current recovery seed, an active device, or a valid locally decrypted passphrase package.

### Optional passphrase recovery package

Opt-in states are `disabled -> deriving -> uploaded -> active -> superseded`; open states are `fetched -> deriving -> decrypted` or terminal uniform failure.

The client derives a 32-byte KEK with Argon2id. The strict public package stores `protocol`, domain, random package ID, salt, algorithm identifier, ops limit, memory limit, parallelism as supported by the selected provider, nonce, ciphertext length, ciphertext digest, and ciphertext. AEAD AAD is the canonical public header with domain `cms.sync.v1/passphrase-package`; plaintext is exactly the 32-byte recovery seed. Parameters MUST meet the reviewed floor, are authenticated, and may increase only through a new package. There is no fallback to a cheaper KDF and no server-side passphrase test or support bypass. A weak passphrase remains vulnerable to offline guessing.

### Recovery rotation

An active device creates a fresh random recovery seed and derived credentials, packages the complete historical keyring to the new recovery credential, and commits it through exact control CAS. The old credential and outstanding challenges become invalid. If passphrase recovery remains enabled, the user must enter a passphrase locally to create a replacement package. The relay may physically retain prior ciphertext under D-14, but it is no longer an accepted authorization path.

### Device revocation and future-only rotation

States are `active -> revocation_pending -> revoked`. A current active device signs one commit that removes the target credential, records it permanently in `revokedDevices`, increments the epoch, and packages a fresh independent epoch key only to remaining active devices and the current recovery credential.

After CAS, the relay rejects future upload and fetch authorization by the revoked credential. Clients reject its envelope when the sequence is created under a control version/epoch for which it was not active. Historical ciphertext and historical keys are not rewritten, and the product makes no remote-erasure claim for bytes already held by an offline or compromised endpoint.

## Data Plane, Replay, and Equivocation

Each active device owns one immutable sequence/hash chain. Local mutation and sealed-outbox insertion commit atomically; retry uploads the identical stored bytes and never re-encrypts.

- Exact same `(syncId, deviceId, sequence)` and exact bytes is an idempotent replay.
- Different bytes at the same tuple is permanent equivocation. Both digests are retained as evidence, neither advances the frontier, and the device is security-blocked pending review/revocation.
- A valid next item must have `sequence = contiguous + 1` and matching predecessor hash.
- At most 1,024 future sequence slots or a maximum jump of 1,024 are retained per device. Beyond either bound, reject with `SYNC_GAP_LIMIT` and do not allocate proportional work.
- Missing predecessors leave later items pending and do not advance materialization.
- A device persists its contiguous frontier, accepted tuple digests, and equivocation state transactionally across restart.
- Signature, membership-at-origin, version, digest, AAD, AEAD, inner/outer binding, and schema validation all precede semantic application.

The relay may reorder, duplicate, omit, roll back, or fork views. Clients report incomplete synchronization when a gap or unconfirmed head remains; they do not claim convergence merely because a request returned successfully.

## Deterministic Materialization and Conflict

Replicas materialize the same validated operation set in this order:

1. Apply membership and key-control history by linear control version.
2. Apply permanent tombstone barriers, sorted by target identity then operation ID.
3. Admit remaining authoritative operations sorted by canonical event time, native provenance order, origin device ID, origin sequence, then operation ID.
4. Union additive canonical events by deterministic canonical identity; byte-identical duplicates collapse and non-identical collisions become security conflicts.
5. Reduce reviewable decisions as a multi-value register keyed by reviewed object and causal frontier.
6. Recompute only affected summaries, topics, boxes, traces, and embeddings locally. Derived caches are never independent authority and do not emit a second sync operation.

Concurrent incompatible review decisions (including approve/reject) remain together in an explicit unresolved conflict. Timestamp, device priority, arrival order, and library winner APIs MUST NOT choose one silently. A reviewed resolution references every conflicting operation ID and creates a new authoritative resolution operation; the audit retains all originals.

## Tombstone, Quarantine, and Restoration

Approved deletion creates a remove-wins permanent encrypted tombstone containing target identifiers, deletion time, actor device, source/candidate provenance required for anti-reimport, and no deleted conversation content. Tombstones are retained indefinitely locally and as ciphertext at the relay.

If any peer offers content covered by a tombstone, the receiver stores the opaque offer in a bounded non-retrievable quarantine and does not create canonical, derived, injection, or MCP-visible state. Reconnection alone never restores it. The user must choose one explicit reviewed resolution:

1. **Keep deletion / dispose offer:** retain the tombstone and content-free audit, delete the local quarantined bytes, and record their digest as disposed.
2. **Reviewed restoration:** create a new restoration operation referencing the tombstone and quarantined offer digest, require the same local person/scope authorization and explicit confirmation as a new import, and materialize a new identity/provenance chain. The old tombstone remains permanent and is not mutated or erased.

Quarantine count, bytes, and age are bounded by configuration capped by protocol maximums (1,024 objects, 64 MiB, 30 days). Overflow fails closed and retains content-free evidence; it never activates data.

## Relay Wire, Limits, and Logs

The production relay is a self-hosted Node 24 HTTPS JSON service. TLS termination, externally visible base URL, deployment region, database path, account rate limits, object rate limits, and operational retention are explicit deployment configuration. TLS may terminate at a documented trusted reverse proxy; plaintext public ingress is forbidden. D-14 archive-object retention is indefinite and cannot be shortened by operational log retention.

Allowed persisted outer fields are restricted by record type:

| Record | Exact persisted fields |
|---|---|
| Account namespace | `issuerHash`, `subjectHash`, `syncId`, `createdAt` |
| Device credential | `syncId`, `deviceId`, `signingPublicKey`, `wrappingPublicKey`, `status`, `controlVersion`, `createdAt`, `revokedAt` |
| Enrollment request | `syncId`, `requestId`, `candidateDeviceId`, candidate public keys, ephemeral public key, encrypted name blob, nonce, `expiresAt`, `status` |
| Control record | `syncId`, `controlVersion`, `previousControlVersion`, `commitDigest`, canonical commit bytes, signature, `createdAt` |
| Data envelope | exact envelope fields defined above plus server `receivedAt` |
| Recovery/passphrase package | pseudonymous IDs, exact public KDF/header fields, opaque ciphertext, digest, signature/status timestamps |
| Head observation | `syncId`, observing random device ID, observed control/data head digests, signature, `createdAt` |

Unknown fields, semantic labels, email, device name plaintext, person ID/name, source/profile/workspace/scope labels, operation type, key material, bearer token, and decrypted content are rejected and never persisted.

Protocol maximums: 64 KiB JSON request header, 16 MiB ciphertext, 128 records per page, 8 MiB page response, 64 active devices, 32 pending enrollment requests, 1,024 retained gaps per device, 10-minute enrollment/recovery challenge lifetime, and deployment-configured rate limits no weaker than 60 authenticated requests/minute/account with stricter enrollment and recovery limits. Exceeding a limit fails before unbounded allocation or database work.

Operational logs contain only request ID, route template, method, content-free account/sync/device hashes, protocol major, HTTP status, stable error code, bounded byte counts, and duration. They never contain token, query secrets, request/response body, ciphertext, signature, keys, email, device name, or semantic metadata. Log retention is deployment-configured and distinct from append-only ciphertext retention.

## Account Provider Boundary

The selected production managed OIDC provider is **Auth0 Universal Login**. The deployment profile MUST configure one exact HTTPS issuer URL, one relay API audience, and the issuer's HTTPS JWKS endpoint. The relay verifies signature algorithm allowlist, exact issuer, exact audience, expiration, not-before, and subject, then derives the pseudonymous account key from normalized verified `(iss, sub)` rather than email.

Provider-owned capabilities consumed by `RelayAccountProvider` are **Email Signup**, **Email Login**, **Password Recovery**, and **Passkey Recovery** through Universal Login. The application stores no password verifier and implements no WebAuthn ceremony. Provider recovery restores relay service access only. Account Recovery Cannot Enroll or Decrypt: a valid account token must still be paired with a current active-device approval or current recovery proof, and decryption still requires the historical keyring.

Bearer tokens and Auth0 profile claims beyond verified issuer/subject are transient and never written to relay persistence or logs. A generic JWT verifier without this configured lifecycle profile does not satisfy D-16.

## Padding Policy

`scripts/benchmark-sync-padding.mjs` uses only deterministic synthetic canonical, review, tombstone, and derived-cache sizes. It compares ciphertext multiples after the four-byte authenticated original-length prefix and 16-byte AEAD tag, projecting each sample across 365 retained versions to make D-14 append-only growth visible. Retained storage and the bytes transferred by one complete archive sync are identical in this projection; repeated incremental downloads multiply the bandwidth cost without changing the policy comparison.

| Policy | Aggregate bytes/sample set | Cumulative overhead | 365-version retained projection |
|---|---:|---:|---:|
| 4,096-byte multiples | 229,376 vs 131,832 unpadded | 74.0% | 83,722,240 bytes |
| 16,384-byte multiples | 622,592 vs 131,832 unpadded | 372.3% | 227,246,080 bytes |

Per-object 4 KiB p50/p95 overhead is canonical 138.1%/1,104.7%, review 265.7%/1,475.4%, tombstone 1,384.1%/2,397.6%, and derived-cache 40.3%/468.9%. The high small-object cost is accepted provisionally because 16 KiB is materially worse under indefinite retention.

Protocol v1 therefore selects the smallest 4,096-byte ciphertext multiple that fits the authenticated length prefix, canonical operation, and AEAD tag, up to 16 MiB. The policy ID is in AAD and signatures. Missing, unknown, or lower-granularity policy IDs are downgrade failures. Padding reduces size precision but still leaks bucket, timing, frequency, direction, identifiers, and traffic volume.

## Split-View and Merkle Decision

RFC 9162-style Merkle transparency is **deferred for protocol v1**, subject to independent reviewer approval of that disposition. V1 requires each device to sign observed control head plus per-device contiguous data heads and exchange those observations inside encrypted operations. Crossed observations can prove inconsistent views, rollback, or some withholding after partitions heal.

This is not a transparency-log guarantee. A malicious relay that permanently partitions devices or withholds all cross-observations defeats availability and may prevent split-view detection indefinitely. Clients report incomplete or stale state and never claim the relay forced delivery. If the reviewer considers this residual integrity evidence insufficient, Merkle transparency becomes a blocking v1 finding rather than an unreviewed later enhancement.

## Upgrade, Downgrade, and Stable Errors

The relay and client maintain explicit enabled-version sets. An upgrade requires a new ADR/version, vectors, migration rules, and digest-bound review. A writer does not emit a new major until every required device/control rule is satisfied. Readers never interpret unknown versions as v1. Padding policy changes follow the same rule.

Externally visible failures use only these stable content-free codes: `SYNC_AUTH_REQUIRED`, `SYNC_ACCOUNT_DENIED`, `SYNC_DEVICE_DENIED`, `SYNC_VERSION_UNSUPPORTED`, `SYNC_SCHEMA_INVALID`, `SYNC_LIMIT_EXCEEDED`, `SYNC_CONTROL_CONFLICT`, `SYNC_SEQUENCE_CONFLICT`, `SYNC_GAP_LIMIT`, `SYNC_INTEGRITY_FAILED`, `SYNC_EXPIRED`, `SYNC_ALREADY_USED`, `SYNC_INCOMPLETE`, and `SYNC_INTERNAL`. Cryptographic failures collapse to `SYNC_INTEGRITY_FAILED`; recovery/passphrase failures do not reveal which check failed.

## Fixed Canonical and Protocol Vectors

These vectors freeze byte boundaries. Cryptographic primitive vectors and upstream conformance cases are added in Plan 06-02 only after approval and dependency installation.

### Vector V1-CANONICAL-HEADER

Input is the operation header shown above. Expected RFC 8785 UTF-8 text is exactly its one-line representation (keys in the displayed order, no whitespace). Expected byte length is `356`; SHA-256 is `277ca4142693ad8aa766b33d21a6173894e95c1068855b798c632598709e5c58`.

### Vector V1-AAD

Input is `{"domain":"cms.sync.v1/envelope-aad","header":<V1-CANONICAL-HEADER>}`. Expected RFC 8785 UTF-8 text has root keys in `domain`, `header` order and header keys in the displayed order. Expected byte length is `403`; SHA-256 is `2f2c9ca2be8fb26cfac07579480e71e98013041c9ba42c9bae8f047da5fb6cb5`. Mutation of any header field MUST produce different AAD and fail decryption.

### Vector V1-PADDING

For a 1,000-byte canonical operation, the unpadded ciphertext size is `4 + 1000 + 16 = 1020`; `cms-sync-padding-v1` produces exactly 4,096 ciphertext bytes. For a 4,077-byte operation, unpadded size is 4,097 and output is 8,192. A 16,777,197-byte operation is rejected because its rounded ciphertext would exceed 16,777,216.

### Vector V1-SEQUENCE

An accepted tuple `(deviceId=22…22, sequence=42, digest=A)` replayed with digest A is idempotent. The same tuple with digest B is permanent equivocation. Sequence 44 received while the contiguous frontier is 42 is pending; sequence 1,067 is rejected because its jump exceeds 1,024.

## Threat Model

### STRIDE register

| ID | Category | Threat | Mitigation | Residual |
|---|---|---|---|---|
| T-06-01 | Tampering | Ambiguous bytes or cross-protocol signature substitution | RFC 8785 I-JSON, closed schemas, exact domain labels, fixed vectors, digest-bound review | Implementation defects remain possible |
| T-06-02 | Elevation of privilege | Relay account recovery silently enrolls a device | Separate account, active-device/current-recovery authorization, and key-possession gates; single-use transcript binding | Compromised active endpoint can authorize |
| T-06-03 | Information disclosure | Relay stores semantic metadata or logs secrets | Exact field allowlists, import boundary, negative persistence/log tests, content-free errors | Allowed traffic metadata remains visible |
| T-06-04 | Spoofing | Forged device or control operation | Current membership plus Ed25519 verification and exact control CAS | Endpoint private-key compromise |
| T-06-05 | Tampering | Replay, gap, rollback, or tuple equivocation | Durable sequence/hash chains, bounds, signed observed heads, permanent evidence | Permanent partition may hide a fork |
| T-06-06 | Information disclosure | Weak optional recovery passphrase | Argon2id reviewed floor, no fallback/oracle/support bypass | Offline guessing follows passphrase entropy |
| T-06-07 | Denial of service | Oversized bodies, gaps, requests, or quarantine | Pre-allocation limits, bounded pages/windows/quarantine, rate limits | Relay can deny all service |
| T-06-08 | Repudiation | Silent review conflict or deletion reversal | Signed immutable operations, multi-value conflict, permanent tombstone, reviewed resolution | User can approve a harmful resolution |
| T-06-09 | Elevation of privilege | Revoked device receives future epochs | Fresh independent epoch and packages only to remaining credentials | Historical keys cannot be revoked |

### Residual Risk

- A trusted endpoint compromise exposes plaintext and keys available on that endpoint.
- Revocation prevents future participation but cannot erase an offline copy or revoke historical keys already held.
- A malicious relay can deny service, withhold, reorder, or permanently partition. Signed heads detect only inconsistencies that devices eventually cross-observe.
- The relay observes pseudonymous identifiers, device/sequence relationships, timestamps, direction, frequency, ciphertext buckets, and volume.
- Append-only indefinite relay retention increases long-term ciphertext exposure and storage cost; cryptographic break or endpoint-key compromise may affect retained history.
- Weak recovery-package passphrases permit offline guessing despite Argon2id.
- Human code comparison, device naming, recovery-key custody, and conflict/deletion decisions remain phishing and usability surfaces.
- Local native histories, unlocked databases, malicious approved MCP profiles, screen capture, and endpoint malware are outside relay zero knowledge; person/workspace/scope checks remain mandatory after decrypt.

## Assumptions A1–A7 Disposition

| Assumption | Protocol v1 disposition | Review requirement |
|---|---|---|
| A1 permanent relay partition | Resolved as an explicit availability and split-view-detection limitation; signed observed heads are required, Merkle is deferred | Reviewer must accept the qualified claim or block v1 |
| A2 linear control CAS | Adopted only for membership/key control; ordinary encrypted operations remain offline multi-writer | Reviewer must evaluate control-plane centralization and CAS transitions |
| A3 random epoch hierarchy | Adopted: independent random epoch keys and per-recipient packages, complete history on enrollment | Reviewer must approve hierarchy and package growth |
| A4 recovery derivation | Adopted with separate KDF contexts and two-factor account-plus-current-recovery authorization | Reviewer must approve domain separation and recovery transcript |
| A5 chain/tombstone application | Adopted with bounded durable gaps/equivocation and tombstone-first two-pass materialization | Reviewer must assess replay, rollback, quarantine, and restoration rules |
| A6 provider OIDC boundary | Resolved to configured Auth0 Universal Login with exact issuer/audience/JWKS and email/password/passkey lifecycle | Reviewer must verify account recovery never implies enrollment/decryption |
| A7 macOS secret store | Accepted as a later implementation boundary, not part of this wire protocol | Reviewer may flag packaging/entitlement requirements; Plan 06-03 owns evidence |

No assumption is silently treated as reviewed. Any blocking reviewer finding returns this ADR to Proposed and requires a new digest and re-review.

## Decision and Requirement Traceability

| Decision / requirement | Protocol location |
|---|---|
| D-01, D-02 | Normal remote enrollment request, human-visible device names, transcript-derived 64-bit code |
| D-03 | Complete historical keyring package and complete archive enrollment |
| D-04 | Recovery enrollment requires both account authentication and current recovery proof |
| D-05, D-06 | Revocation immediately denies future sync, rotates an independent future epoch, and never claims historical rewrite/remote erasure |
| D-07, D-08 | Optional Argon2id passphrase package and explicit recovery rotation state machines |
| D-09 | Immutable multi-writer operation set and deterministic canonical/provenance materialization |
| D-10 | Multi-value review conflict with explicit reviewed resolution and no timestamp winner |
| D-11, D-12 | Remove-wins permanent tombstone, non-retrievable quarantine, keep-deletion/dispose and reviewed-restoration paths |
| D-13, D-14 | Exact relay allowlists/logs and append-only indefinite encrypted-version retention |
| D-15 | Full archive synchronization while local person/profile/scope retrieval checks remain unchanged |
| D-16 | Auth0 account lifecycle separated from device authorization and key possession |
| REQ-031 | Device-side XChaCha encryption, OS secret boundary, opaque relay, no relay decrypt method |
| REQ-032 | Active-device or account-plus-recovery enrollment, matching single-use transcript, complete history |
| REQ-033 | Future denial and fresh epoch without historical rewrite |
| REQ-034 | Offline signed operation union, deterministic convergence, explicit review conflicts |
| REQ-035 | Permanent encrypted tombstones, quarantine, both reviewed resolutions, derived-cache recomputation |
| REQ-036 | Strict pseudonymous relay metadata, bounded HTTPS API, content-free logs/errors, append-only ciphertext |

## Protocol Decision

Protocol v1 is proposed as a linear membership/key control plane plus an offline multi-writer encrypted-operation data plane. The 4 KiB padding policy, Auth0 account boundary, signed-head split-view limitation, exact state machines, and residual risks are part of the composed review package. Nothing in this ADR enables production cryptography before independent approval.

<!-- END PROTOCOL REVIEW PACKAGE -->

## Security Review Record

Protocol Digest: `sha256:8081f72658cf032b9dd62e936ba23e226a1f2d312261c4a3afe9dc8448c50062`

| Field | Value |
|---|---|
| Reviewer | PENDING — must be a qualified independent security reviewer |
| Review Date | PENDING |
| Reviewed Protocol Version | `cms-sync-v1` |
| Account Provider Boundary | Auth0 Universal Login profile above; exact deployment issuer/audience/JWKS must be recorded by reviewer/deployer |
| Disposition | PENDING — Security Review Required |
| Blocking Findings | PENDING |
| Accepted Residual Risks | PENDING |

The digest is SHA-256 over every file byte from the first `#` through and including the `<!-- END PROTOCOL REVIEW PACKAGE -->` marker and its following LF. Review evidence is valid only for that exact digest. The reviewer must name themselves, date the review, confirm the configured account-provider profile, record all accepted residual risks and A1–A7 dispositions, and explicitly state an approved disposition with no blocking findings. The executor cannot supply that approval.
