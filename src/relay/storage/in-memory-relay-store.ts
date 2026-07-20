import { RELAY_ZERO_DIGEST_BASE64URL, MAX_RETAINED_GAP_SLOTS } from "../domain/types.js";
import type {
  AccountNamespaceRecord,
  ControlRecord,
  DataEnvelopeRecord,
  DeviceCredentialRecord,
  EnrollmentRequestRecord,
  HeadObservationRecord,
  RecoveryPackageRecord
} from "../domain/types.js";
import type {
  AppendEnvelopeResult,
  CommitControlInput,
  CommitControlResult,
  RelayStore
} from "./relay-store.js";

function deviceKey(syncId: string, deviceId: string): string {
  return `${syncId}\u0000${deviceId}`;
}

function accountKey(issuerHash: string, subjectHash: string): string {
  return `${issuerHash}\u0000${subjectHash}`;
}

function sameEnvelopeBytes(a: DataEnvelopeRecord, b: DataEnvelopeRecord): boolean {
  return (
    a.nonce === b.nonce &&
    a.ciphertext === b.ciphertext &&
    a.ciphertextDigest === b.ciphertextDigest &&
    a.signature === b.signature &&
    a.header.previousEnvelopeHash === b.header.previousEnvelopeHash &&
    a.header.ciphertextLength === b.header.ciphertextLength &&
    a.header.epoch === b.header.epoch &&
    a.header.objectId === b.header.objectId &&
    a.header.createdAt === b.header.createdAt
  );
}

/**
 * Staged-clone in-memory `RelayStore` (mirrors the atomic-staging pattern in
 * `src/storage/in-memory-store.ts`). Every collection participating in a
 * commit is cloned, mutated only on the staged clone, and published only
 * after every check succeeds.
 */
export class InMemoryRelayStore implements RelayStore {
  private accountNamespacesByAccountKey = new Map<string, AccountNamespaceRecord>();
  private accountNamespacesBySyncId = new Map<string, AccountNamespaceRecord>();
  private controlRecords = new Map<string, ControlRecord>();
  private deviceCredentials = new Map<string, Map<string, DeviceCredentialRecord>>();
  private envelopesByDevice = new Map<string, Map<number, DataEnvelopeRecord>>();
  private enrollmentRequests = new Map<string, Map<string, EnrollmentRequestRecord>>();
  private recoveryPackages = new Map<string, RecoveryPackageRecord[]>();
  private headObservations = new Map<string, HeadObservationRecord[]>();

  async getAccountNamespace(issuerHash: string, subjectHash: string): Promise<AccountNamespaceRecord | null> {
    return this.accountNamespacesByAccountKey.get(accountKey(issuerHash, subjectHash)) ?? null;
  }

  async ensureAccountNamespace(
    issuerHash: string,
    subjectHash: string,
    syncId: string,
    createdAt: string
  ): Promise<AccountNamespaceRecord> {
    const key = accountKey(issuerHash, subjectHash);
    const existing = this.accountNamespacesByAccountKey.get(key);
    if (existing) return existing;
    const record: AccountNamespaceRecord = { issuerHash, subjectHash, syncId, createdAt };
    this.accountNamespacesByAccountKey.set(key, record);
    this.accountNamespacesBySyncId.set(syncId, record);
    return record;
  }

  async getCurrentControlRecord(syncId: string): Promise<ControlRecord | null> {
    return this.controlRecords.get(syncId) ?? null;
  }

  async listDeviceCredentials(syncId: string): Promise<DeviceCredentialRecord[]> {
    const table = this.deviceCredentials.get(syncId);
    if (!table) return [];
    return [...table.values()].sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  }

  async getDeviceCredential(syncId: string, deviceId: string): Promise<DeviceCredentialRecord | null> {
    return this.deviceCredentials.get(syncId)?.get(deviceId) ?? null;
  }

  async commitControl(input: CommitControlInput): Promise<CommitControlResult> {
    const current = this.controlRecords.get(input.syncId) ?? null;
    const expectedPreviousVersion = current?.controlVersion ?? 0;
    const expectedPreviousHash = current?.commitDigest ?? RELAY_ZERO_DIGEST_BASE64URL;
    if (
      input.commit.previousControlVersion !== expectedPreviousVersion ||
      input.commit.previousCommitHash !== expectedPreviousHash
    ) {
      return { status: "conflict", currentRecord: current };
    }

    // Reject reactivation of a currently-revoked credential (ADR 0047 relay
    // acceptance condition 4): a commit cannot silently resurrect a device
    // whose stored credential status is 'revoked' by simply relisting it in
    // activeDevices.
    const existingCredentials = this.deviceCredentials.get(input.syncId);
    if (existingCredentials) {
      for (const entry of input.commit.activeDevices) {
        const existingDevice = existingCredentials.get(entry.deviceId);
        if (existingDevice && existingDevice.status === "revoked") {
          return { status: "conflict", currentRecord: current };
        }
      }
    }

    const record: ControlRecord = {
      syncId: input.syncId,
      controlVersion: input.commit.controlVersion,
      previousControlVersion: input.commit.previousControlVersion,
      commitDigest: input.commitDigest,
      canonicalCommitBytes: input.canonicalCommitBytes,
      signature: input.signature,
      createdAt: input.createdAt
    };

    // Stage device-credential table mutations before publishing.
    const staged = new Map(this.deviceCredentials.get(input.syncId) ?? new Map());
    for (const entry of input.commit.activeDevices) {
      const existingDevice = staged.get(entry.deviceId);
      staged.set(entry.deviceId, {
        syncId: input.syncId,
        deviceId: entry.deviceId,
        signingPublicKey: entry.signingPublicKey,
        wrappingPublicKey: entry.wrappingPublicKey,
        status: "active",
        controlVersion: input.commit.controlVersion,
        createdAt: existingDevice?.createdAt ?? input.createdAt,
        revokedAt: null
      });
    }
    for (const deviceId of input.commit.revokedDevices) {
      const existingDevice = staged.get(deviceId);
      if (existingDevice) {
        staged.set(deviceId, {
          ...existingDevice,
          status: "revoked",
          controlVersion: input.commit.controlVersion,
          revokedAt: input.createdAt
        });
      }
    }

    let stagedEnrollment: EnrollmentRequestRecord | undefined;
    if (input.enrollmentRequestId) {
      const table = this.enrollmentRequests.get(input.syncId);
      const existingRequest = table?.get(input.enrollmentRequestId);
      if (existingRequest) {
        stagedEnrollment = { ...existingRequest, status: "committed" };
      }
    }

    let stagedRecoveryPackages: RecoveryPackageRecord[] | undefined;
    if (input.supersedeRecoveryPackageId) {
      const existingPackages = this.recoveryPackages.get(input.syncId) ?? [];
      stagedRecoveryPackages = existingPackages.map((item) =>
        item.packageId === input.supersedeRecoveryPackageId ? { ...item, status: "superseded" as const } : item
      );
    }

    // Publish.
    this.controlRecords.set(input.syncId, record);
    this.deviceCredentials.set(input.syncId, staged);
    if (stagedEnrollment) {
      const table = this.enrollmentRequests.get(input.syncId) ?? new Map();
      table.set(stagedEnrollment.requestId, stagedEnrollment);
      this.enrollmentRequests.set(input.syncId, table);
    }
    if (stagedRecoveryPackages) {
      this.recoveryPackages.set(input.syncId, stagedRecoveryPackages);
    }

    return { status: "committed", record };
  }

  async appendEnvelope(record: DataEnvelopeRecord): Promise<AppendEnvelopeResult> {
    const key = deviceKey(record.header.syncId, record.header.deviceId);
    const table = this.envelopesByDevice.get(key) ?? new Map<number, DataEnvelopeRecord>();
    const existing = table.get(record.header.sequence);
    if (existing) {
      return sameEnvelopeBytes(existing, record)
        ? { outcome: "replayed", record: existing }
        : { outcome: "equivocation", existing };
    }
    const maxSequence = table.size === 0 ? 0 : Math.max(...table.keys());
    if (record.header.sequence > maxSequence + MAX_RETAINED_GAP_SLOTS) {
      return { outcome: "gap_limit" };
    }
    const staged = new Map(table);
    staged.set(record.header.sequence, record);
    this.envelopesByDevice.set(key, staged);
    return { outcome: "accepted", record };
  }

  async listEnvelopes(syncId: string, deviceId: string, fromSequence: number, limit: number): Promise<DataEnvelopeRecord[]> {
    const table = this.envelopesByDevice.get(deviceKey(syncId, deviceId));
    if (!table) return [];
    return [...table.values()]
      .filter((item) => item.header.sequence >= fromSequence)
      .sort((a, b) => a.header.sequence - b.header.sequence)
      .slice(0, limit);
  }

  async headEnvelope(syncId: string, deviceId: string): Promise<{ sequence: number; digest: string } | null> {
    const table = this.envelopesByDevice.get(deviceKey(syncId, deviceId));
    if (!table || table.size === 0) return null;
    let sequence = 0;
    let digest = "";
    while (true) {
      const next = table.get(sequence + 1);
      if (!next) break;
      sequence += 1;
      digest = next.ciphertextDigest;
    }
    if (sequence === 0) return null;
    return { sequence, digest };
  }

  async submitEnrollmentRequest(record: EnrollmentRequestRecord): Promise<EnrollmentRequestRecord> {
    const table = this.enrollmentRequests.get(record.syncId) ?? new Map();
    table.set(record.requestId, record);
    this.enrollmentRequests.set(record.syncId, table);
    return record;
  }

  async listEnrollmentRequests(syncId: string): Promise<EnrollmentRequestRecord[]> {
    const table = this.enrollmentRequests.get(syncId);
    if (!table) return [];
    return [...table.values()].sort((a, b) => a.requestId.localeCompare(b.requestId));
  }

  async getEnrollmentRequest(syncId: string, requestId: string): Promise<EnrollmentRequestRecord | null> {
    return this.enrollmentRequests.get(syncId)?.get(requestId) ?? null;
  }

  async putRecoveryPackage(record: RecoveryPackageRecord): Promise<RecoveryPackageRecord> {
    const existing = this.recoveryPackages.get(record.syncId) ?? [];
    const superseded = record.status === "active"
      ? existing.map((item) => (item.status === "active" ? { ...item, status: "superseded" as const } : item))
      : existing;
    this.recoveryPackages.set(record.syncId, [...superseded, record]);
    return record;
  }

  async getActiveRecoveryPackage(syncId: string): Promise<RecoveryPackageRecord | null> {
    const existing = this.recoveryPackages.get(syncId) ?? [];
    return existing.find((item) => item.status === "active") ?? null;
  }

  async appendHeadObservation(record: HeadObservationRecord): Promise<HeadObservationRecord> {
    const existing = this.headObservations.get(record.syncId) ?? [];
    this.headObservations.set(record.syncId, [...existing, record]);
    return record;
  }

  async listHeadObservations(syncId: string, limit: number): Promise<HeadObservationRecord[]> {
    const existing = this.headObservations.get(syncId) ?? [];
    return existing.slice(-limit);
  }

  close(): void {
    // No resource to release for the in-memory adapter.
  }
}
