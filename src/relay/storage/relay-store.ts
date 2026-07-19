import type {
  AccountNamespaceRecord,
  ControlRecord,
  DataEnvelopeRecord,
  DeviceCredentialRecord,
  EnrollmentRequestRecord,
  HeadObservationRecord,
  RecoveryPackageRecord,
  RelayMembershipCommit
} from "../domain/types.js";

/**
 * Narrow append-only relay persistence contract (ADR 0047 "Relay Wire,
 * Limits, and Logs" and "Control Plane Wire Contract"). Every method
 * operates only on opaque relay records defined in `../domain/types.js`.
 * Implementations MUST NOT import local semantic memory schemas
 * (`src/domain`, `src/storage`, `src/service`) and MUST retain every
 * accepted data envelope version indefinitely (D-14).
 */

export interface CommitControlInput {
  syncId: string;
  commit: RelayMembershipCommit;
  /** Canonical (RFC 8785) bytes of `commit`, base64url-encoded. */
  canonicalCommitBytes: string;
  /** 32-byte generic hash of `canonicalCommitBytes`, base64url-encoded. */
  commitDigest: string;
  /** Detached Ed25519 signature over `canonicalCommitBytes`, base64url-encoded. */
  signature: string;
  createdAt: string;
  /** When set, the referenced enrollment request is atomically marked `committed` iff the CAS succeeds. */
  enrollmentRequestId?: string;
  /** When set, the referenced recovery package is atomically marked `superseded` iff the CAS succeeds. */
  supersedeRecoveryPackageId?: string;
}

export type CommitControlResult =
  | { status: "committed"; record: ControlRecord }
  | { status: "conflict"; currentRecord: ControlRecord | null };

export type AppendEnvelopeResult =
  | { outcome: "accepted"; record: DataEnvelopeRecord }
  | { outcome: "replayed"; record: DataEnvelopeRecord }
  | { outcome: "equivocation"; existing: DataEnvelopeRecord }
  | { outcome: "gap_limit" };

export interface RelayStore {
  getAccountNamespace(issuerHash: string, subjectHash: string): Promise<AccountNamespaceRecord | null>;

  /** Idempotent: returns the existing namespace if one is already bound to (issuerHash, subjectHash). */
  ensureAccountNamespace(
    issuerHash: string,
    subjectHash: string,
    syncId: string,
    createdAt: string
  ): Promise<AccountNamespaceRecord>;

  getCurrentControlRecord(syncId: string): Promise<ControlRecord | null>;

  listDeviceCredentials(syncId: string): Promise<DeviceCredentialRecord[]>;

  getDeviceCredential(syncId: string, deviceId: string): Promise<DeviceCredentialRecord | null>;

  /**
   * Exact membership CAS (ADR 0047 "Control Plane Wire Contract"). Accepts
   * atomically only when `previousControlVersion`/`previousCommitHash`
   * match the stored current version/digest, then persists the control
   * record and updates device credential status (activated/revoked) from
   * `commit.activeDevices`/`commit.revokedDevices`.
   */
  commitControl(input: CommitControlInput): Promise<CommitControlResult>;

  /**
   * Immutable append (ADR 0047 "Data Plane, Replay, and Equivocation").
   * Identical bytes at an existing `(syncId, deviceId, sequence)` tuple is
   * an idempotent replay; different bytes is permanent equivocation and
   * neither advances the frontier. A jump beyond the bounded gap window is
   * rejected with `gap_limit` before allocation.
   */
  appendEnvelope(record: DataEnvelopeRecord): Promise<AppendEnvelopeResult>;

  listEnvelopes(syncId: string, deviceId: string, fromSequence: number, limit: number): Promise<DataEnvelopeRecord[]>;

  headEnvelope(syncId: string, deviceId: string): Promise<{ sequence: number; digest: string } | null>;

  submitEnrollmentRequest(record: EnrollmentRequestRecord): Promise<EnrollmentRequestRecord>;

  listEnrollmentRequests(syncId: string): Promise<EnrollmentRequestRecord[]>;

  getEnrollmentRequest(syncId: string, requestId: string): Promise<EnrollmentRequestRecord | null>;

  putRecoveryPackage(record: RecoveryPackageRecord): Promise<RecoveryPackageRecord>;

  getActiveRecoveryPackage(syncId: string): Promise<RecoveryPackageRecord | null>;

  appendHeadObservation(record: HeadObservationRecord): Promise<HeadObservationRecord>;

  listHeadObservations(syncId: string, limit: number): Promise<HeadObservationRecord[]>;

  close(): void;
}
