import { createRequire } from "node:module";
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

interface DatabaseSyncConstructor {
  new (location: string, options?: { readOnly?: boolean; timeout?: number }): DatabaseSync;
}

interface DatabaseSync {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): StatementSync;
}

interface StatementSync {
  all(...anonymousParameters: unknown[]): unknown[];
  get(...anonymousParameters: unknown[]): unknown;
  run(...anonymousParameters: unknown[]): void;
}

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: DatabaseSyncConstructor };

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

export interface SqliteRelayStoreOptions {
  busyTimeoutMs?: number;
}

/**
 * Separate-database SQLite `RelayStore` adapter. Uses its own SQLite file
 * distinct from the local memory store; no table or schema is shared with
 * `src/storage/sqlite-store.ts`. Every mutation runs inside `BEGIN
 * IMMEDIATE` and revalidates current state before writing (mirrors
 * `src/storage/sqlite-store.ts`'s CAS pattern).
 */
export class SqliteRelayStore implements RelayStore {
  private readonly database: DatabaseSync;

  constructor(location: string, options: SqliteRelayStoreOptions = {}) {
    const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    this.database = new DatabaseSync(location, { timeout: busyTimeoutMs });
    this.migrate();
    this.database.exec("pragma journal_mode = WAL");
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS account_namespaces (
        issuer_hash TEXT NOT NULL,
        subject_hash TEXT NOT NULL,
        sync_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (issuer_hash, subject_hash)
      );

      CREATE TABLE IF NOT EXISTS control_records (
        sync_id TEXT NOT NULL,
        control_version INTEGER NOT NULL,
        previous_control_version INTEGER NOT NULL,
        commit_digest TEXT NOT NULL,
        canonical_commit_bytes TEXT NOT NULL,
        signature TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (sync_id, control_version)
      );

      CREATE TABLE IF NOT EXISTS device_credentials (
        sync_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        signing_public_key TEXT NOT NULL,
        wrapping_public_key TEXT NOT NULL,
        status TEXT NOT NULL,
        control_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        PRIMARY KEY (sync_id, device_id)
      );

      CREATE TABLE IF NOT EXISTS envelopes (
        sync_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        record_json TEXT NOT NULL,
        PRIMARY KEY (sync_id, device_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS enrollment_requests (
        sync_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        record_json TEXT NOT NULL,
        PRIMARY KEY (sync_id, request_id)
      );

      CREATE TABLE IF NOT EXISTS recovery_packages (
        sync_id TEXT NOT NULL,
        package_id TEXT NOT NULL,
        status TEXT NOT NULL,
        record_json TEXT NOT NULL,
        PRIMARY KEY (sync_id, package_id)
      );

      CREATE TABLE IF NOT EXISTS head_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sync_id TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
    `);
  }

  async getAccountNamespace(issuerHash: string, subjectHash: string): Promise<AccountNamespaceRecord | null> {
    const row = this.database
      .prepare("SELECT issuer_hash, subject_hash, sync_id, created_at FROM account_namespaces WHERE issuer_hash = ? AND subject_hash = ?")
      .get(issuerHash, subjectHash) as
      | { issuer_hash: string; subject_hash: string; sync_id: string; created_at: string }
      | undefined;
    if (!row) return null;
    return { issuerHash: row.issuer_hash, subjectHash: row.subject_hash, syncId: row.sync_id, createdAt: row.created_at };
  }

  async ensureAccountNamespace(
    issuerHash: string,
    subjectHash: string,
    syncId: string,
    createdAt: string
  ): Promise<AccountNamespaceRecord> {
    const existing = await this.getAccountNamespace(issuerHash, subjectHash);
    if (existing) return existing;
    this.database
      .prepare("INSERT INTO account_namespaces (issuer_hash, subject_hash, sync_id, created_at) VALUES (?, ?, ?, ?)")
      .run(issuerHash, subjectHash, syncId, createdAt);
    return { issuerHash, subjectHash, syncId, createdAt };
  }

  private currentControlRow(syncId: string):
    | { control_version: number; previous_control_version: number; commit_digest: string; canonical_commit_bytes: string; signature: string; created_at: string }
    | undefined {
    return this.database
      .prepare("SELECT control_version, previous_control_version, commit_digest, canonical_commit_bytes, signature, created_at FROM control_records WHERE sync_id = ? ORDER BY control_version DESC LIMIT 1")
      .get(syncId) as
      | { control_version: number; previous_control_version: number; commit_digest: string; canonical_commit_bytes: string; signature: string; created_at: string }
      | undefined;
  }

  async getCurrentControlRecord(syncId: string): Promise<ControlRecord | null> {
    const row = this.currentControlRow(syncId);
    if (!row) return null;
    return {
      syncId,
      controlVersion: row.control_version,
      previousControlVersion: row.previous_control_version,
      commitDigest: row.commit_digest,
      canonicalCommitBytes: row.canonical_commit_bytes,
      signature: row.signature,
      createdAt: row.created_at
    };
  }

  async listDeviceCredentials(syncId: string): Promise<DeviceCredentialRecord[]> {
    const rows = this.database
      .prepare("SELECT device_id, signing_public_key, wrapping_public_key, status, control_version, created_at, revoked_at FROM device_credentials WHERE sync_id = ? ORDER BY device_id ASC")
      .all(syncId) as Array<{
        device_id: string; signing_public_key: string; wrapping_public_key: string; status: string;
        control_version: number; created_at: string; revoked_at: string | null;
      }>;
    return rows.map((row) => ({
      syncId,
      deviceId: row.device_id,
      signingPublicKey: row.signing_public_key,
      wrappingPublicKey: row.wrapping_public_key,
      status: row.status as "active" | "revoked",
      controlVersion: row.control_version,
      createdAt: row.created_at,
      revokedAt: row.revoked_at
    }));
  }

  async getDeviceCredential(syncId: string, deviceId: string): Promise<DeviceCredentialRecord | null> {
    const row = this.database
      .prepare("SELECT device_id, signing_public_key, wrapping_public_key, status, control_version, created_at, revoked_at FROM device_credentials WHERE sync_id = ? AND device_id = ?")
      .get(syncId, deviceId) as
      | { device_id: string; signing_public_key: string; wrapping_public_key: string; status: string; control_version: number; created_at: string; revoked_at: string | null }
      | undefined;
    if (!row) return null;
    return {
      syncId,
      deviceId: row.device_id,
      signingPublicKey: row.signing_public_key,
      wrappingPublicKey: row.wrapping_public_key,
      status: row.status as "active" | "revoked",
      controlVersion: row.control_version,
      createdAt: row.created_at,
      revokedAt: row.revoked_at
    };
  }

  async commitControl(input: CommitControlInput): Promise<CommitControlResult> {
    this.database.exec("begin immediate");
    try {
      const currentRow = this.currentControlRow(input.syncId);
      const expectedPreviousVersion = currentRow?.control_version ?? 0;
      const expectedPreviousHash = currentRow?.commit_digest ?? RELAY_ZERO_DIGEST_BASE64URL;
      if (
        input.commit.previousControlVersion !== expectedPreviousVersion ||
        input.commit.previousCommitHash !== expectedPreviousHash
      ) {
        this.database.exec("rollback");
        const currentRecord = currentRow
          ? {
              syncId: input.syncId,
              controlVersion: currentRow.control_version,
              previousControlVersion: currentRow.previous_control_version,
              commitDigest: currentRow.commit_digest,
              canonicalCommitBytes: currentRow.canonical_commit_bytes,
              signature: currentRow.signature,
              createdAt: currentRow.created_at
            }
          : null;
        return { status: "conflict", currentRecord };
      }

      this.database
        .prepare("INSERT INTO control_records (sync_id, control_version, previous_control_version, commit_digest, canonical_commit_bytes, signature, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(
          input.syncId,
          input.commit.controlVersion,
          input.commit.previousControlVersion,
          input.commitDigest,
          input.canonicalCommitBytes,
          input.signature,
          input.createdAt
        );

      for (const entry of input.commit.activeDevices) {
        const existing = this.database
          .prepare("SELECT created_at FROM device_credentials WHERE sync_id = ? AND device_id = ?")
          .get(input.syncId, entry.deviceId) as { created_at: string } | undefined;
        this.database
          .prepare(`
            INSERT INTO device_credentials (sync_id, device_id, signing_public_key, wrapping_public_key, status, control_version, created_at, revoked_at)
            VALUES (?, ?, ?, ?, 'active', ?, ?, NULL)
            ON CONFLICT(sync_id, device_id) DO UPDATE SET
              signing_public_key = excluded.signing_public_key,
              wrapping_public_key = excluded.wrapping_public_key,
              status = 'active',
              control_version = excluded.control_version,
              revoked_at = NULL
          `)
          .run(
            input.syncId,
            entry.deviceId,
            entry.signingPublicKey,
            entry.wrappingPublicKey,
            input.commit.controlVersion,
            existing?.created_at ?? input.createdAt
          );
      }

      for (const deviceId of input.commit.revokedDevices) {
        this.database
          .prepare("UPDATE device_credentials SET status = 'revoked', control_version = ?, revoked_at = ? WHERE sync_id = ? AND device_id = ?")
          .run(input.commit.controlVersion, input.createdAt, input.syncId, deviceId);
      }

      if (input.enrollmentRequestId) {
        const row = this.database
          .prepare("SELECT record_json FROM enrollment_requests WHERE sync_id = ? AND request_id = ?")
          .get(input.syncId, input.enrollmentRequestId) as { record_json: string } | undefined;
        if (row) {
          const record = JSON.parse(row.record_json) as EnrollmentRequestRecord;
          record.status = "committed";
          this.database
            .prepare("UPDATE enrollment_requests SET record_json = ? WHERE sync_id = ? AND request_id = ?")
            .run(JSON.stringify(record), input.syncId, input.enrollmentRequestId);
        }
      }

      if (input.supersedeRecoveryPackageId) {
        const row = this.database
          .prepare("SELECT record_json FROM recovery_packages WHERE sync_id = ? AND package_id = ?")
          .get(input.syncId, input.supersedeRecoveryPackageId) as { record_json: string } | undefined;
        if (row) {
          const record = JSON.parse(row.record_json) as RecoveryPackageRecord;
          record.status = "superseded";
          this.database
            .prepare("UPDATE recovery_packages SET status = 'superseded', record_json = ? WHERE sync_id = ? AND package_id = ?")
            .run(JSON.stringify(record), input.syncId, input.supersedeRecoveryPackageId);
        }
      }

      this.database.exec("commit");
      return {
        status: "committed",
        record: {
          syncId: input.syncId,
          controlVersion: input.commit.controlVersion,
          previousControlVersion: input.commit.previousControlVersion,
          commitDigest: input.commitDigest,
          canonicalCommitBytes: input.canonicalCommitBytes,
          signature: input.signature,
          createdAt: input.createdAt
        }
      };
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
  }

  async appendEnvelope(record: DataEnvelopeRecord): Promise<AppendEnvelopeResult> {
    this.database.exec("begin immediate");
    try {
      const existingRow = this.database
        .prepare("SELECT record_json FROM envelopes WHERE sync_id = ? AND device_id = ? AND sequence = ?")
        .get(record.header.syncId, record.header.deviceId, record.header.sequence) as { record_json: string } | undefined;
      if (existingRow) {
        this.database.exec("rollback");
        const existing = JSON.parse(existingRow.record_json) as DataEnvelopeRecord;
        return sameEnvelopeBytes(existing, record)
          ? { outcome: "replayed", record: existing }
          : { outcome: "equivocation", existing };
      }

      const maxRow = this.database
        .prepare("SELECT MAX(sequence) as max_sequence FROM envelopes WHERE sync_id = ? AND device_id = ?")
        .get(record.header.syncId, record.header.deviceId) as { max_sequence: number | null };
      const maxSequence = maxRow.max_sequence ?? 0;
      if (record.header.sequence > maxSequence + MAX_RETAINED_GAP_SLOTS) {
        this.database.exec("rollback");
        return { outcome: "gap_limit" };
      }

      this.database
        .prepare("INSERT INTO envelopes (sync_id, device_id, sequence, record_json) VALUES (?, ?, ?, ?)")
        .run(record.header.syncId, record.header.deviceId, record.header.sequence, JSON.stringify(record));
      this.database.exec("commit");
      return { outcome: "accepted", record };
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
  }

  async listEnvelopes(syncId: string, deviceId: string, fromSequence: number, limit: number): Promise<DataEnvelopeRecord[]> {
    const rows = this.database
      .prepare("SELECT record_json FROM envelopes WHERE sync_id = ? AND device_id = ? AND sequence >= ? ORDER BY sequence ASC LIMIT ?")
      .all(syncId, deviceId, fromSequence, limit) as Array<{ record_json: string }>;
    return rows.map((row) => JSON.parse(row.record_json) as DataEnvelopeRecord);
  }

  async headEnvelope(syncId: string, deviceId: string): Promise<{ sequence: number; digest: string } | null> {
    const rows = this.database
      .prepare("SELECT sequence, record_json FROM envelopes WHERE sync_id = ? AND device_id = ? ORDER BY sequence ASC")
      .all(syncId, deviceId) as Array<{ sequence: number; record_json: string }>;
    let sequence = 0;
    let digest = "";
    for (const row of rows) {
      if (row.sequence !== sequence + 1) break;
      sequence = row.sequence;
      digest = (JSON.parse(row.record_json) as DataEnvelopeRecord).ciphertextDigest;
    }
    if (sequence === 0) return null;
    return { sequence, digest };
  }

  async submitEnrollmentRequest(record: EnrollmentRequestRecord): Promise<EnrollmentRequestRecord> {
    this.database
      .prepare(`
        INSERT INTO enrollment_requests (sync_id, request_id, record_json) VALUES (?, ?, ?)
        ON CONFLICT(sync_id, request_id) DO UPDATE SET record_json = excluded.record_json
      `)
      .run(record.syncId, record.requestId, JSON.stringify(record));
    return record;
  }

  async listEnrollmentRequests(syncId: string): Promise<EnrollmentRequestRecord[]> {
    const rows = this.database
      .prepare("SELECT record_json FROM enrollment_requests WHERE sync_id = ? ORDER BY request_id ASC")
      .all(syncId) as Array<{ record_json: string }>;
    return rows.map((row) => JSON.parse(row.record_json) as EnrollmentRequestRecord);
  }

  async getEnrollmentRequest(syncId: string, requestId: string): Promise<EnrollmentRequestRecord | null> {
    const row = this.database
      .prepare("SELECT record_json FROM enrollment_requests WHERE sync_id = ? AND request_id = ?")
      .get(syncId, requestId) as { record_json: string } | undefined;
    return row ? (JSON.parse(row.record_json) as EnrollmentRequestRecord) : null;
  }

  async putRecoveryPackage(record: RecoveryPackageRecord): Promise<RecoveryPackageRecord> {
    this.database.exec("begin immediate");
    try {
      if (record.status === "active") {
        this.database
          .prepare("UPDATE recovery_packages SET status = 'superseded' WHERE sync_id = ? AND status = 'active'")
          .run(record.syncId);
      }
      this.database
        .prepare("INSERT INTO recovery_packages (sync_id, package_id, status, record_json) VALUES (?, ?, ?, ?)")
        .run(record.syncId, record.packageId, record.status, JSON.stringify(record));
      this.database.exec("commit");
      return record;
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
  }

  async getActiveRecoveryPackage(syncId: string): Promise<RecoveryPackageRecord | null> {
    const row = this.database
      .prepare("SELECT record_json FROM recovery_packages WHERE sync_id = ? AND status = 'active' LIMIT 1")
      .get(syncId) as { record_json: string } | undefined;
    return row ? (JSON.parse(row.record_json) as RecoveryPackageRecord) : null;
  }

  async appendHeadObservation(record: HeadObservationRecord): Promise<HeadObservationRecord> {
    this.database
      .prepare("INSERT INTO head_observations (sync_id, record_json) VALUES (?, ?)")
      .run(record.syncId, JSON.stringify(record));
    return record;
  }

  async listHeadObservations(syncId: string, limit: number): Promise<HeadObservationRecord[]> {
    const rows = this.database
      .prepare("SELECT record_json FROM head_observations WHERE sync_id = ? ORDER BY id DESC LIMIT ?")
      .all(syncId, limit) as Array<{ record_json: string }>;
    return rows.map((row) => JSON.parse(row.record_json) as HeadObservationRecord).reverse();
  }

  close(): void {
    this.database.close();
  }
}
