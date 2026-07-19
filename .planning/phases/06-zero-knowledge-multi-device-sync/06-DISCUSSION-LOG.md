# Phase 6: Zero-Knowledge Multi-Device Sync - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-19
**Phase:** 6-zero-knowledge-multi-device-sync
**Areas discussed:** Device enrollment, Recovery and device revocation, Offline convergence and deletion, Relay privacy and selective sync

---

## Device Enrollment

### Normal enrollment path

| Option | Description | Selected |
|--------|-------------|----------|
| Direct device pairing | Scan a QR code or compare a short code, then approve on both devices. | |
| Remote approval | The new device sends a request through the relay, and any trusted device can approve it. | ✓ |
| Recovery key | Enter the user-held recovery key even when another trusted device is available. | |

**User's choice:** Remote approval.
**Notes:** This is the normal enrollment path, not merely a fallback.

### Approval threshold

| Option | Description | Selected |
|--------|-------------|----------|
| One trusted device | Any one trusted device approves after checking the device name and matching verification code. | ✓ |
| Two trusted devices | Require two approvals when at least two devices are available. | |
| Every trusted device | Require unanimous approval from all current devices. | |

**User's choice:** Any one trusted device.
**Notes:** The approval surface must identify the proposed device and present a matching verification code.

### Initial synchronized content

| Option | Description | Selected |
|--------|-------------|----------|
| Selected profiles | Transfer only scopes selected during approval. | |
| Complete archive | Transfer the person's entire synchronized memory automatically. | ✓ |
| Future changes only | Transfer no historical memory during enrollment. | |

**User's choice:** Complete archive.
**Notes:** Later discussion confirmed that MCP profiles remain local retrieval boundaries rather than selective device-sync partitions.

### No-device recovery

| Option | Description | Selected |
|--------|-------------|----------|
| Recovery key plus account | Use the recovery key plus access to the sync account; no existing device is required. | ✓ |
| Exported package | Require a self-contained package containing both identity and key. | |
| Trusted device still required | Use the key only for local backups. | |

**User's choice:** Recovery key plus sync-account access.
**Notes:** A relay-stored passphrase-protected recovery package was discussed in the next area.

---

## Recovery and Device Revocation

### Revocation promise

| Option | Description | Selected |
|--------|-------------|----------|
| Attempt cache erasure | Block and rotate, then request cache erasure if the device reconnects. | |
| Block future sync only | Block future sync and rotate keys without a remote-erasure attempt. | ✓ |
| Guaranteed remote wipe | Delay continuation until the lost device is proven erased. | |

**User's choice:** Block future synchronization only.
**Notes:** The product must not claim that an offline retained copy was erased.

### Rotation coverage

| Option | Description | Selected |
|--------|-------------|----------|
| Future changes | Existing ciphertext retains old keys; only new changes use the rotated epoch. | ✓ |
| Complete archive | Automatically re-encrypt all historical versions. | |
| Optional full rotation | Rotate the future immediately and offer a manual historical rewrite. | |

**User's choice:** Future changes only.
**Notes:** This follows REQ-033 and avoids rewriting the historical archive.

### Total-loss recovery

| Option | Description | Selected |
|--------|-------------|----------|
| Unrecoverable | Loss of every device and key is final. | |
| Encrypted relay package | Optionally store a recovery package encrypted by a passphrase unknown to the relay. | ✓ |
| Support recovery | Let account verification restore decryption access. | |

**User's choice:** Optional passphrase-protected relay package.
**Notes:** The relay never receives the passphrase; account support cannot decrypt the archive.

### Compromised recovery key

| Option | Description | Selected |
|--------|-------------|----------|
| Trusted-device rotation | Any trusted device invalidates the old recovery path and issues a replacement. | ✓ |
| Permanent key | Create a new sync identity and migrate to replace the key. | |
| Two-device approval | Require two trusted devices to rotate it. | |

**User's choice:** Rotation by any trusted device.
**Notes:** Rotation also replaces the optional encrypted recovery package.

---

## Offline Convergence and Deletion

### Additive event convergence

| Option | Description | Selected |
|--------|-------------|----------|
| Deterministic merge | Preserve both streams, order by canonical time and provenance, and recompute affected derivations. | ✓ |
| Latest device wins | Replace overlapping records using the most recently synchronized device. | |
| Manual branches | Retain device branches until the user manually merges them. | |

**User's choice:** Deterministic preservation and merge.
**Notes:** This reuses canonical provenance instead of treating one online writer as authoritative.

### Incompatible decisions

| Option | Description | Selected |
|--------|-------------|----------|
| Explicit conflict | Preserve both decisions and require user resolution. | ✓ |
| Safety precedence | Use deletion or revocation over rejection, and rejection over approval. | |
| Latest timestamp | Choose the mutation with the latest trusted time. | |

**User's choice:** Explicit conflict state.
**Notes:** The system may merge additive state automatically but not incompatible reviewed decisions.

### Stale deleted content

| Option | Description | Selected |
|--------|-------------|----------|
| Tombstone always wins | Block it and require a separate new lineage for restoration. | |
| Latest action wins | Permit the stale upload to restore content if later. | |
| Quarantine and ask | Keep it non-retrievable and ask whether to retain deletion or restore. | ✓ |

**User's choice:** Quarantine and ask.
**Notes:** Quarantine is not restoration; stale content remains inactive until an explicit reviewed choice.

### Tombstone retention

| Option | Description | Selected |
|--------|-------------|----------|
| Indefinite | Retain compact encrypted identifier-and-time audit records indefinitely. | ✓ |
| Acknowledgement plus one year | Remove after every trusted device acknowledges and a safety period passes. | |
| Ninety days | Use a short fixed retention window. | |

**User's choice:** Indefinite compact encrypted tombstones.
**Notes:** Tombstones contain no deleted conversation content.

---

## Relay Privacy and Selective Sync

### Permitted relay metadata

| Option | Description | Selected |
|--------|-------------|----------|
| Practical minimum | Retain pseudonymous sync/device/object IDs, replay data, timestamps, and sizes, but no semantic labels or content. | ✓ |
| Unlinkable mailbox | Also hide stable device identities where possible. | |
| Padded traffic | Batch and pad traffic to reduce timing and size leakage. | |

**User's choice:** Practical minimum metadata.
**Notes:** Names, source labels, profile names, workspace labels, and memory indexes remain encrypted or local.

### Encrypted relay retention

| Option | Description | Selected |
|--------|-------------|----------|
| Current archive | Garbage-collect superseded encrypted versions after acknowledgement. | |
| Append-only archive | Retain every encrypted version indefinitely. | ✓ |
| Pending changes only | Require another device to supply old history. | |

**User's choice:** Indefinite encrypted append-only archive.
**Notes:** This is distinct from indefinite tombstone retention and carries storage-cost implications for planning.

### Synchronization scope

| Option | Description | Selected |
|--------|-------------|----------|
| Complete personal archive | Synchronize all approved scopes while keeping local MCP retrieval scoped. | ✓ |
| Profile opt-in | Select profiles for device synchronization independently. | |
| Derived memory only | Synchronize summaries globally but keep raw canonical events selective. | |

**User's choice:** Complete encrypted personal archive.
**Notes:** A trusted device receives all encrypted person memory; applications do not automatically receive retrieval authority.

### Relay account authentication

| Option | Description | Selected |
|--------|-------------|----------|
| Pseudonymous passkey account | Make email optional and notification-only. | |
| Conventional email account | Use an email-based account with password or passkey recovery. | ✓ |
| Opaque unmanaged identity | Provide no account-recovery channel. | |

**User's choice:** Conventional email account.
**Notes:** Relay authentication and memory decryption are separate authorities.

---

## the agent's Discretion

- Exact established synchronization protocol and cryptographic libraries, subject to research, threat modeling, and protocol approval.
- Key hierarchy and epoch representation, encrypted envelope format, authenticated clocks, conflict data structure, replay window, verification-code lifetime, and relay adapter boundaries.
- Exact conflict-resolution and stale-content quarantine interfaces, provided neither silently restores or approves memory.

## Deferred Ideas

None — discussion stayed within Phase 6.
