import { SyncProtocolError, type SyncErrorCode } from "../domain/types.js";
import type {
  ControlRecord,
  DataEnvelopeInput,
  DataEnvelopeRecord,
  EnrollmentRequestRecord,
  HeadObservationRecord,
  RecoveryChallengeRecord,
  RecoveryPackageRecord,
  RelayMembershipCommit
} from "../../relay/domain/types.js";
import { RelayError, type RelayErrorCode } from "../../relay/domain/types.js";
import type { OpaqueRelayService } from "../../relay/service/opaque-relay-service.js";

/**
 * Client-side opaque relay contract (ADR 0047; Plan 06-06). Every method
 * maps to exactly one relay operation from `RelayRequestSchema` and returns
 * only opaque relay records already defined by the relay's own zero-
 * knowledge wire schemas (`src/relay/domain/types.ts`). This module never
 * decrypts or interprets ciphertext; `SyncControlService` and the future
 * replication client own all local cryptography.
 */

export interface MembershipCasInput {
  commit: RelayMembershipCommit;
  /** Detached Ed25519 signature over the canonical bytes of `commit`. */
  signature: string;
  enrollmentRequestId?: string;
  recoveryAuthorization?: {
    packageId: string;
    challengeNonce: string;
    signature: string;
  };
}

export type MembershipCasOutcome =
  | { status: "committed"; record: ControlRecord }
  | { status: "conflict"; currentRecord: ControlRecord | null };

export interface SyncRelay {
  compareAndSwapMembership(input: MembershipCasInput): Promise<MembershipCasOutcome>;

  appendEnvelope(envelope: DataEnvelopeInput): Promise<{ status: "accepted" | "replayed"; record: DataEnvelopeRecord }>;

  listEnvelopes(
    deviceId: string,
    fromSequence?: number,
    limit?: number
  ): Promise<{ records: DataEnvelopeRecord[]; nextFromSequence: number | null }>;

  headEnvelope(deviceId: string): Promise<{ sequence: number | null; digest: string | null }>;

  submitEnrollmentRequest(request: Omit<EnrollmentRequestRecord, "status">): Promise<EnrollmentRequestRecord>;

  listEnrollmentRequests(): Promise<EnrollmentRequestRecord[]>;

  uploadRecoveryPackage(
    packageValue: Omit<RecoveryPackageRecord, "status" | "createdAt">
  ): Promise<RecoveryPackageRecord>;

  /** Fetches the active recovery package plus a freshly minted single-use relay challenge bound to it (ADR 0047 "Recovery-key enrollment"). */
  fetchRecoveryPackage(): Promise<{ package: RecoveryPackageRecord | null; challenge: RecoveryChallengeRecord | null }>;

  observeHead(observation: Omit<HeadObservationRecord, "createdAt">): Promise<HeadObservationRecord>;
}

/** Maps a `RelayErrorCode` (identical value set) onto the local `SyncErrorCode` union. */
function toSyncErrorCode(code: RelayErrorCode): SyncErrorCode {
  return code as unknown as SyncErrorCode;
}

/** Rethrows any `RelayError` as a `SyncProtocolError`; never leaks relay-internal detail beyond the stable code. */
function translateRelayError(error: unknown): never {
  if (error instanceof RelayError) {
    throw new SyncProtocolError(toSyncErrorCode(error.code));
  }
  throw new SyncProtocolError("SYNC_INTERNAL");
}

export interface FakeSyncRelayOptions {
  service: OpaqueRelayService;
  /** Bearer token identifying the authenticated relay-account session this instance acts as. */
  bearerToken: string;
}

/**
 * In-process `SyncRelay` implementation calling `OpaqueRelayService.handle`
 * directly (no network, no serialization boundary) for deterministic
 * `SyncControlService` unit tests. Exercises the exact same authorization,
 * CAS, and append-only rules as `HttpSyncRelay`/the real relay, since both
 * ultimately delegate to the same service.
 */
export class FakeSyncRelay implements SyncRelay {
  private readonly service: OpaqueRelayService;
  private readonly bearerToken: string;

  constructor(options: FakeSyncRelayOptions) {
    this.service = options.service;
    this.bearerToken = options.bearerToken;
  }

  async compareAndSwapMembership(input: MembershipCasInput): Promise<MembershipCasOutcome> {
    try {
      const response = await this.service.handle(this.bearerToken, {
        version: 1,
        operation: "membership.cas",
        commit: input.commit,
        signature: input.signature,
        enrollmentRequestId: input.enrollmentRequestId,
        recoveryAuthorization: input.recoveryAuthorization
      });
      if (response.operation !== "membership.cas") throw new SyncProtocolError("SYNC_INTERNAL");
      if (response.status === "committed") {
        if (!response.record) throw new SyncProtocolError("SYNC_INTERNAL");
        return { status: "committed", record: response.record };
      }
      return { status: "conflict", currentRecord: response.currentRecord ?? null };
    } catch (error) {
      return translateRelayError(error);
    }
  }

  async appendEnvelope(envelope: DataEnvelopeInput): Promise<{ status: "accepted" | "replayed"; record: DataEnvelopeRecord }> {
    try {
      const response = await this.service.handle(this.bearerToken, { version: 1, operation: "envelope.append", envelope });
      if (response.operation !== "envelope.append") throw new SyncProtocolError("SYNC_INTERNAL");
      return { status: response.status, record: response.record };
    } catch (error) {
      return translateRelayError(error);
    }
  }

  async listEnvelopes(
    deviceId: string,
    fromSequence?: number,
    limit?: number
  ): Promise<{ records: DataEnvelopeRecord[]; nextFromSequence: number | null }> {
    try {
      const response = await this.service.handle(this.bearerToken, {
        version: 1,
        operation: "envelope.list",
        deviceId,
        fromSequence,
        limit
      });
      if (response.operation !== "envelope.list") throw new SyncProtocolError("SYNC_INTERNAL");
      return { records: response.records, nextFromSequence: response.nextFromSequence };
    } catch (error) {
      return translateRelayError(error);
    }
  }

  async headEnvelope(deviceId: string): Promise<{ sequence: number | null; digest: string | null }> {
    try {
      const response = await this.service.handle(this.bearerToken, { version: 1, operation: "envelope.head", deviceId });
      if (response.operation !== "envelope.head") throw new SyncProtocolError("SYNC_INTERNAL");
      return { sequence: response.sequence, digest: response.digest };
    } catch (error) {
      return translateRelayError(error);
    }
  }

  async submitEnrollmentRequest(request: Omit<EnrollmentRequestRecord, "status">): Promise<EnrollmentRequestRecord> {
    try {
      const response = await this.service.handle(this.bearerToken, { version: 1, operation: "enrollment.submit", request });
      if (response.operation !== "enrollment.submit") throw new SyncProtocolError("SYNC_INTERNAL");
      return response.record;
    } catch (error) {
      return translateRelayError(error);
    }
  }

  async listEnrollmentRequests(): Promise<EnrollmentRequestRecord[]> {
    try {
      const response = await this.service.handle(this.bearerToken, { version: 1, operation: "enrollment.list" });
      if (response.operation !== "enrollment.list") throw new SyncProtocolError("SYNC_INTERNAL");
      return response.records;
    } catch (error) {
      return translateRelayError(error);
    }
  }

  async uploadRecoveryPackage(
    packageValue: Omit<RecoveryPackageRecord, "status" | "createdAt">
  ): Promise<RecoveryPackageRecord> {
    try {
      const response = await this.service.handle(this.bearerToken, {
        version: 1,
        operation: "recovery.upload",
        package: packageValue
      });
      if (response.operation !== "recovery.upload") throw new SyncProtocolError("SYNC_INTERNAL");
      return response.record;
    } catch (error) {
      return translateRelayError(error);
    }
  }

  async fetchRecoveryPackage(): Promise<{ package: RecoveryPackageRecord | null; challenge: RecoveryChallengeRecord | null }> {
    try {
      const response = await this.service.handle(this.bearerToken, { version: 1, operation: "recovery.fetch" });
      if (response.operation !== "recovery.fetch") throw new SyncProtocolError("SYNC_INTERNAL");
      return { package: response.record, challenge: response.challenge };
    } catch (error) {
      return translateRelayError(error);
    }
  }

  async observeHead(observation: Omit<HeadObservationRecord, "createdAt">): Promise<HeadObservationRecord> {
    try {
      const response = await this.service.handle(this.bearerToken, { version: 1, operation: "head.observe", observation });
      if (response.operation !== "head.observe") throw new SyncProtocolError("SYNC_INTERNAL");
      return response.record;
    } catch (error) {
      return translateRelayError(error);
    }
  }
}
