import { createRequire } from "node:module";
import {
  CanonicalEventSchema,
  MemorySourceSchema,
  PersonSchema,
  type CanonicalEvent,
  type MemorySource,
  type Person
} from "../domain/canonical.js";
import {
  AnchorSchema,
  BoxSchema,
  InjectionPacketSchema,
  MemoryProposalSchema,
  MemoryTraceSchema,
  SummarySchema,
  TurnSchema,
  type Anchor,
  type Box,
  type InjectionPacket,
  type MemoryProposal,
  type MemoryTrace,
  type Summary,
  type Turn
} from "../domain/types.js";
import type { MemoryStore, ProposalFilter, TraceFilter } from "./memory-store.js";
import { ImportCheckpointSchema, type ImportCheckpoint } from "../imports/types.js";
import {
  HistoricalBootstrapCheckpointSchema,
  type HistoricalBootstrapCheckpoint
} from "../bootstrap/types.js";
import {
  SourceGrantSchema,
  SourceLifecycleAuditEventSchema,
  QuarantineRecordSchema,
  type QuarantineRecord,
  type SourceGrant,
  type SourceLifecycleAuditEvent
} from "../domain/source-lifecycle.js";
import {
  CommitApprovedGrantReconciliationInputSchema,
  CommitContractionSliceInputSchema,
  CommitDaemonWorkOutcomeInputSchema,
  CommitDueSourceRefreshInputSchema,
  CommitImportBatchInputSchema,
  CommitProposalRunInputSchema,
  CommitSourceStateOutcomeInputSchema,
  CanonicalOrderKeySchema,
  ContractionCheckpointSchema,
  ContractionJobSchema,
  DEFAULT_DAEMON_DURATIONS,
  DaemonLeaseSchema,
  DaemonSourceStateSchema,
  ImportBatchReceiptSchema,
  type CommitApprovedGrantReconciliationInput,
  type CommitContractionSliceInput,
  type CommitDaemonWorkOutcomeInput,
  type CommitDueSourceRefreshInput,
  type CommitImportBatchInput,
  type CommitProposalRunInput,
  type CommitSourceStateOutcomeInput,
  type CanonicalOrderKey,
  type ContractionCheckpoint,
  type ContractionJob,
  type DaemonLease,
  type DaemonSourceState,
  type ImportBatchReceipt
} from "../daemon/types.js";
import { daemonSourceStateFromGrant, daemonSourceStateId } from "../daemon/source-state.js";
import { MAX_RETAINED_GAP_SLOTS } from "../relay/domain/types.js";
import {
  CommitHistoryImportInputSchema,
  CommitProposalDecisionInputSchema,
  CommitSourceDeletionInputSchema,
  CommitSourceRevocationInputSchema,
  proposalDecisionStateMatches,
  type CommitHistoryImportInput,
  type CommitProposalDecisionInput,
  type CommitSourceDeletionInput,
  type CommitSourceRevocationInput,
  type MutationCommitReceipt
} from "./mcp-mutation-contracts.js";
import {
  AcceptedSyncOperationSchema,
  CommitLocalSyncOperationInputSchema,
  CommitRemoteSyncApplyInputSchema,
  LocalSyncEffectRecordSchema,
  PendingSyncGapSchema,
  SealClaimedOutboxEnvelopeInputSchema,
  SyncConflictRecordSchema,
  SyncContractionRangeSchema,
  SyncOutboxOperationSchema,
  SyncQuarantineEntrySchema,
  SyncTombstoneSchema,
  type AcceptedSyncOperation,
  type CommitLocalSyncOperationInput,
  type CommitRemoteSyncApplyInput,
  type SealClaimedOutboxEnvelopeInput,
  type SealOutboxResult,
  type SyncCommitReceipt,
  type SyncContractionRange,
  type SyncOutboxOperation
} from "./sync-contracts.js";

interface PayloadRow {
  payload: string;
}

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
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: DatabaseSyncConstructor;
};

interface FaultInjector {
  reach(boundary: string): void;
}

export interface SqliteStoreOptions {
  faultInjector?: FaultInjector;
  clock?: { now(): string };
  readOnly?: boolean;
  busyTimeoutMs?: number;
}

export class SqliteStore implements MemoryStore {
  private readonly database: DatabaseSync;
  private readonly faultInjector?: FaultInjector;
  private readonly clock: { now(): string };

  constructor(location: string, options: SqliteStoreOptions = {}) {
    const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 30_000) {
      throw new Error("SQLite busy timeout must be an integer between 1 and 30000 milliseconds");
    }
    this.database = new DatabaseSync(location, {
      readOnly: options.readOnly ?? false,
      timeout: busyTimeoutMs
    });
    this.faultInjector = options.faultInjector;
    this.clock = options.clock ?? { now: () => new Date().toISOString() };
    if (!options.readOnly) {
      this.migrate();
      this.database.exec("pragma journal_mode = WAL");
    }
  }

  close(): void {
    this.database.close();
  }

  async acquireDaemonLease(input: {
    databaseId: string;
    ownerToken: string;
    pid: number;
    now: string;
  }): Promise<DaemonLease | null> {
    const now = new Date(input.now);
    if (Number.isNaN(now.getTime())) throw new Error("Invalid daemon lease timestamp");
    this.database.exec("begin immediate");
    try {
      const existing = await this.getDaemonLease(input.databaseId);
      if (existing && existing.ownerToken !== input.ownerToken && Date.parse(existing.expiresAt) > now.getTime()) {
        this.database.exec("rollback");
        return null;
      }
      const lease = DaemonLeaseSchema.parse({
        databaseId: input.databaseId,
        ownerToken: input.ownerToken,
        pid: input.pid,
        acquiredAt: input.now,
        heartbeatAt: input.now,
        expiresAt: new Date(now.getTime() + DEFAULT_DAEMON_DURATIONS.leaseExpiryMs).toISOString(),
        stopRequestedAt: null,
        lastSuccessfulScanAt: existing?.lastSuccessfulScanAt ?? null
      });
      this.database.prepare(
        `insert into daemon_lease (database_id, owner_token, heartbeat_at, expires_at, payload)
         values (?, ?, ?, ?, ?)
         on conflict(database_id) do update set
           owner_token = excluded.owner_token,
           heartbeat_at = excluded.heartbeat_at,
           expires_at = excluded.expires_at,
           payload = excluded.payload`
      ).run(lease.databaseId, lease.ownerToken, lease.heartbeatAt, lease.expiresAt, JSON.stringify(lease));
      this.database.exec("commit");
      return lease;
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
  }

  async getDaemonLease(databaseId: string): Promise<DaemonLease | null> {
    const row = this.database.prepare("select payload from daemon_lease where database_id = ?").get(databaseId) as PayloadRow | undefined;
    return row ? DaemonLeaseSchema.parse(JSON.parse(row.payload)) : null;
  }

  async heartbeatDaemonLease(databaseId: string, ownerToken: string, now: string): Promise<DaemonLease | null> {
    const lease = await this.getDaemonLease(databaseId);
    if (!lease || lease.ownerToken !== ownerToken) return null;
    const parsedNow = new Date(now);
    if (Number.isNaN(parsedNow.getTime())) throw new Error("Invalid daemon heartbeat timestamp");
    if (Date.parse(lease.expiresAt) <= parsedNow.getTime()) return null;
    const next = DaemonLeaseSchema.parse({
      ...lease,
      heartbeatAt: now,
      expiresAt: new Date(parsedNow.getTime() + DEFAULT_DAEMON_DURATIONS.leaseExpiryMs).toISOString()
    });
    this.database.prepare(
      `update daemon_lease set heartbeat_at = ?, expires_at = ?, payload = ?
       where database_id = ? and owner_token = ?`
    ).run(next.heartbeatAt, next.expiresAt, JSON.stringify(next), databaseId, ownerToken);
    return next;
  }

  async requestDaemonStop(databaseId: string, ownerToken: string, now: string): Promise<boolean> {
    const lease = await this.getDaemonLease(databaseId);
    if (!lease || lease.ownerToken !== ownerToken) return false;
    if (Date.parse(lease.expiresAt) <= Date.parse(now)) return false;
    const next = DaemonLeaseSchema.parse({ ...lease, stopRequestedAt: now });
    this.database.prepare(
      "update daemon_lease set payload = ? where database_id = ? and owner_token = ?"
    ).run(JSON.stringify(next), databaseId, ownerToken);
    return true;
  }

  async releaseDaemonLease(databaseId: string, ownerToken: string): Promise<boolean> {
    const lease = await this.getDaemonLease(databaseId);
    if (!lease || lease.ownerToken !== ownerToken) return false;
    this.database.prepare("delete from daemon_lease where database_id = ? and owner_token = ?").run(databaseId, ownerToken);
    return true;
  }

  async saveDaemonSourceState(state: DaemonSourceState): Promise<void> {
    const parsed = DaemonSourceStateSchema.parse(state);
    const grant = await this.getSourceGrant(parsed.grantId);
    if (!grant || grant.personId !== parsed.personId || grant.candidateId !== parsed.candidateId || grant.scopeId !== parsed.scopeId) {
      throw new Error("Daemon source state grant ownership mismatch");
    }
    const existing = await this.getDaemonSourceState(parsed.id);
    this.assertPersonOwnership(existing, parsed);
    this.database.prepare(
      `insert into daemon_source_state (id, person_id, state, next_due_at, payload)
       values (?, ?, ?, ?, ?)
       on conflict(id) do update set state = excluded.state, next_due_at = excluded.next_due_at, payload = excluded.payload`
    ).run(parsed.id, parsed.personId, parsed.state, parsed.nextDueAt, JSON.stringify(parsed));
  }

  async getDaemonSourceState(id: string): Promise<DaemonSourceState | null> {
    return this.getPayload("daemon_source_state", id, DaemonSourceStateSchema);
  }

  async listDaemonSourceStates(personId: string): Promise<DaemonSourceState[]> {
    const rows = this.database.prepare(
      "select payload from daemon_source_state where person_id = ? order by id asc"
    ).all(personId) as PayloadRow[];
    return rows.map((row) => DaemonSourceStateSchema.parse(JSON.parse(row.payload)));
  }

  async reconcileDaemonSourceStates(personId: string, now: string): Promise<DaemonSourceState[]> {
    DaemonSourceStateSchema.shape.updatedAt.parse(now);
    this.database.exec("begin immediate");
    try {
      const grants = this.database.prepare(
        "select payload from source_grants where person_id = ? and state = 'approved' order by id asc"
      ).all(personId) as PayloadRow[];
      const approved = grants.map((row) => SourceGrantSchema.parse(JSON.parse(row.payload)));
      const currentRows = this.database.prepare(
        "select payload from daemon_source_state where person_id = ? order by id asc"
      ).all(personId) as PayloadRow[];
      const current = currentRows.map((row) => DaemonSourceStateSchema.parse(JSON.parse(row.payload)));
      const reconciled = approved.map((grant) => {
        const existing = current.find((state) =>
          state.grantId === grant.id &&
          state.personId === grant.personId &&
          state.candidateId === grant.candidateId &&
          state.scopeId === grant.scopeId
        );
        return DaemonSourceStateSchema.parse(existing
          ? { ...existing, id: daemonSourceStateId(grant.personId, grant.candidateId) }
          : daemonSourceStateFromGrant(grant, now));
      });
      if (new Set(reconciled.map((state) => state.id)).size !== reconciled.length) {
        throw new Error("Multiple approved grants map to the same daemon source identity");
      }

      this.database.prepare("delete from daemon_source_state where person_id = ?").run(personId);
      const insert = this.database.prepare(
        `insert into daemon_source_state (id, person_id, state, next_due_at, payload)
         values (?, ?, ?, ?, ?)`
      );
      for (const state of reconciled) {
        insert.run(state.id, state.personId, state.state, state.nextDueAt, JSON.stringify(state));
      }
      this.database.exec("commit");
      return reconciled.sort((left, right) => left.id.localeCompare(right.id));
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
  }

  async getImportBatchReceipt(id: string): Promise<ImportBatchReceipt | null> {
    return this.getPayload("daemon_import_receipt", id, ImportBatchReceiptSchema);
  }

  async listImportBatchReceipts(personId: string): Promise<ImportBatchReceipt[]> {
    const rows = this.database.prepare(
      "select payload from daemon_import_receipt where person_id = ? order by committed_at asc, id asc"
    ).all(personId) as PayloadRow[];
    return rows.map((row) => ImportBatchReceiptSchema.parse(JSON.parse(row.payload)));
  }

  async saveContractionJob(job: ContractionJob): Promise<void> {
    const parsed = ContractionJobSchema.parse(job);
    const existing = await this.getContractionJob(parsed.id);
    this.assertPersonOwnership(existing, parsed);
    this.database.prepare(
      `insert into daemon_contraction_job
         (id, person_id, state, next_due_at, earliest_at, earliest_sequence, earliest_id, latest_at, latest_sequence, latest_id, payload)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(id) do update set
         state = excluded.state, next_due_at = excluded.next_due_at,
         earliest_at = excluded.earliest_at, earliest_sequence = excluded.earliest_sequence, earliest_id = excluded.earliest_id,
         latest_at = excluded.latest_at, latest_sequence = excluded.latest_sequence, latest_id = excluded.latest_id,
         payload = excluded.payload`
    ).run(
      parsed.id, parsed.personId, parsed.state, parsed.nextDueAt,
      parsed.earliestAffected.occurredAt, parsed.earliestAffected.nativeSequence, parsed.earliestAffected.id,
      parsed.latestAffected.occurredAt, parsed.latestAffected.nativeSequence, parsed.latestAffected.id,
      JSON.stringify(parsed)
    );
  }

  async getContractionJob(id: string): Promise<ContractionJob | null> {
    return this.getPayload("daemon_contraction_job", id, ContractionJobSchema);
  }

  async listContractionJobs(personId: string): Promise<ContractionJob[]> {
    const rows = this.database.prepare(
      "select payload from daemon_contraction_job where person_id = ? order by next_due_at asc, id asc"
    ).all(personId) as PayloadRow[];
    return rows.map((row) => ContractionJobSchema.parse(JSON.parse(row.payload)));
  }

  async saveContractionCheckpoint(checkpoint: ContractionCheckpoint): Promise<void> {
    const parsed = ContractionCheckpointSchema.parse(checkpoint);
    const job = await this.getContractionJob(parsed.jobId);
    if (!job || job.personId !== parsed.personId) throw new Error("Contraction checkpoint job ownership mismatch");
    const existing = await this.getContractionCheckpoint(parsed.id);
    this.assertPersonOwnership(existing, parsed);
    this.database.prepare(
      `insert into daemon_contraction_checkpoint (id, person_id, job_id, payload)
       values (?, ?, ?, ?)
       on conflict(id) do update set job_id = excluded.job_id, payload = excluded.payload`
    ).run(parsed.id, parsed.personId, parsed.jobId, JSON.stringify(parsed));
  }

  async getContractionCheckpoint(id: string): Promise<ContractionCheckpoint | null> {
    return this.getPayload("daemon_contraction_checkpoint", id, ContractionCheckpointSchema);
  }

  async commitHistoryImport(input: CommitHistoryImportInput): Promise<MutationCommitReceipt> {
    const parsed = CommitHistoryImportInputSchema.parse(input);
    this.database.exec("begin immediate");
    try {
      const sourceId = parsed.expectedSource?.id ?? parsed.nextSources[0]?.id;
      const currentSource = sourceId ? await this.getSource(sourceId) : null;
      const currentCheckpoint = await this.getImportCheckpoint(parsed.nextCheckpoint.id);
      const currentGrant = await this.getSourceGrant(parsed.expectedGrant.id);
      const occupied = parsed.targetCanonicalEventIds.some((id) =>
        this.database.prepare("select id from canonical_events where id = ?").get(id) !== undefined
      );
      if (!this.sameRecord(currentSource, parsed.expectedSource) || !this.sameRecord(currentCheckpoint, parsed.expectedCheckpoint) || !this.sameRecord(currentGrant, parsed.expectedGrant) || occupied) {
        this.database.exec("rollback");
        return this.stateChanged(parsed.receipt);
      }
      this.faultInjector?.reach("history_import_before_write");
      for (const item of parsed.nextSources) await this.saveSource(item);
      this.faultInjector?.reach("history_import_after_sources");
      for (const item of parsed.nextCanonicalEvents) await this.saveCanonicalEvent(item);
      this.faultInjector?.reach("history_import_after_events");
      await this.saveImportCheckpoint(parsed.nextCheckpoint);
      this.faultInjector?.reach("history_import_after_checkpoint");
      for (const item of parsed.auditEvents) await this.saveSourceLifecycleAuditEvent(item);
      this.database.exec("commit");
      return parsed.receipt;
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
  }

  async commitProposalDecision(input: CommitProposalDecisionInput): Promise<MutationCommitReceipt> {
    const parsed = CommitProposalDecisionInputSchema.parse(input);
    this.database.exec("begin immediate");
    try {
      const current = await this.getProposal(parsed.expectedProposal.id);
      const summaries = new Map((await this.listSummaries()).map((item) => [item.id, item]));
      const currentSummaries = parsed.expectedSummaries.flatMap((expected) => {
        const value = summaries.get(expected.id);
        return value ? [value] : [];
      });
      const currentBoxes = await Promise.all(parsed.expectedBoxes.map(async ({ id }) => ({
        id,
        value: await this.getBox(id)
      })));
      const currentTraces = await Promise.all(parsed.expectedTraces.map(async ({ id }) => ({
        id,
        value: await this.getTrace(id)
      })));
      if (!proposalDecisionStateMatches(parsed, {
        proposal: current,
        summaries: currentSummaries,
        boxes: currentBoxes,
        traces: currentTraces
      })) {
        this.database.exec("rollback");
        return this.stateChanged(parsed.receipt);
      }
      this.faultInjector?.reach("proposal_decision_before_write");
      for (const item of parsed.nextBoxes) await this.saveBox(item);
      this.faultInjector?.reach("proposal_decision_after_boxes");
      for (const item of parsed.nextTraces) await this.saveTrace(item);
      this.faultInjector?.reach("proposal_decision_after_traces");
      await this.saveProposal(parsed.nextProposal);
      this.faultInjector?.reach("proposal_decision_after_proposal");
      this.database.exec("commit");
      return parsed.receipt;
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
  }

  async commitSourceRevocation(input: CommitSourceRevocationInput): Promise<MutationCommitReceipt> {
    const parsed = CommitSourceRevocationInputSchema.parse(input);
    this.database.exec("begin immediate");
    try {
      const current = await this.getSourceGrant(parsed.expectedGrant.id);
      if (!this.sameRecord(current, parsed.expectedGrant)) {
        this.database.exec("rollback");
        return this.stateChanged(parsed.receipt);
      }
      this.faultInjector?.reach("source_revocation_before_write");
      await this.saveSourceGrant(parsed.nextGrant);
      this.faultInjector?.reach("source_revocation_after_grant");
      await this.saveSourceLifecycleAuditEvent(parsed.auditEvent);
      this.faultInjector?.reach("source_revocation_after_audit");
      this.database.exec("commit");
      return parsed.receipt;
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
  }

  async commitSourceDeletion(input: CommitSourceDeletionInput): Promise<MutationCommitReceipt> {
    const parsed = CommitSourceDeletionInputSchema.parse(input);
    this.database.exec("begin immediate");
    try {
      const grant = await this.getSourceGrant(parsed.expectedGrant.id);
      if (!this.sameRecord(grant, parsed.expectedGrant) || !await this.sourceDeletionEffectsMatch(parsed)) {
        this.database.exec("rollback");
        return this.stateChanged(parsed.receipt);
      }
      this.faultInjector?.reach("source_deletion_before_write");
      for (const item of parsed.nextSummaries) await this.saveSummary(item);
      for (const item of parsed.nextBoxes) await this.saveBox(item);
      for (const item of parsed.nextProposals) await this.saveProposal(item);
      for (const item of parsed.nextTraces) await this.saveTrace(item);
      this.faultInjector?.reach("source_deletion_after_supersessions");
      this.deleteIds("injections", parsed.effects.injectionIds);
      this.faultInjector?.reach("source_deletion_after_injections");
      this.deleteIds("anchors", parsed.effects.anchorIds);
      this.faultInjector?.reach("source_deletion_after_anchors");
      this.deleteIds("turns", parsed.effects.turnIds);
      this.faultInjector?.reach("source_deletion_after_turns");
      this.deleteIds("canonical_events", parsed.effects.canonicalEventIds);
      this.faultInjector?.reach("source_deletion_after_events");
      this.deleteIds("memory_sources", parsed.effects.sourceIds);
      this.faultInjector?.reach("source_deletion_after_sources");
      this.deleteIds("quarantine_records", parsed.effects.quarantineIds);
      this.faultInjector?.reach("source_deletion_after_quarantine");
      this.deleteIds("bootstrap_checkpoints", parsed.effects.bootstrapCheckpointIds);
      this.faultInjector?.reach("source_deletion_after_checkpoint");
      for (const item of parsed.auditEvents) await this.saveSourceLifecycleAuditEvent(item);
      this.faultInjector?.reach("source_deletion_after_audits");
      this.database.exec("commit");
      return parsed.receipt;
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
  }

  async inspectSourceDeletionEffects(personId: string, candidateId: string, auditEventIds: string[]) {
    return this.computeSourceDeletionEffects(personId, candidateId, auditEventIds);
  }

  async commitImportBatch(input: CommitImportBatchInput): Promise<ImportBatchReceipt> {
    const parsed = CommitImportBatchInputSchema.parse(input);
    this.validateImportOwnership(parsed);
    this.database.exec("begin immediate");
    try {
      await this.assertWriteAuthority(parsed.authority, parsed.personId, "approved-import");
      this.faultInjector?.reach("before_grant_check");
      const grant = this.getPayload("source_grants", parsed.expectedGrant.id, SourceGrantSchema);
      if (!grant || grant.state !== "approved") throw new Error("Source grant is not approved or was revoked");
      if (grant.personId !== parsed.expectedGrant.personId || grant.candidateId !== parsed.expectedGrant.candidateId || grant.updatedAt !== parsed.expectedGrant.updatedAt) {
        throw new Error("Source grant changed before import commit");
      }
      this.faultInjector?.reach("after_grant_check");
      this.validateImportReceipt(parsed);
      for (const source of parsed.sources) await this.saveSource(source);
      for (const event of parsed.canonicalEvents) await this.saveCanonicalEvent(event);
      for (const turn of parsed.turns) {
        this.assertStoredTurnOwnership(turn.id, parsed.personId);
        await this.saveTurn(turn);
      }
      for (const record of parsed.quarantineChanges) await this.saveQuarantineRecord(record);
      this.faultInjector?.reach("before_import_checkpoint");
      await this.saveImportCheckpoint(parsed.checkpoint);
      const existingReceipt = await this.getImportBatchReceipt(parsed.receipt.id);
      this.assertPersonOwnership(existingReceipt, parsed.receipt);
      this.database.prepare(
        `insert into daemon_import_receipt (id, person_id, committed_at, payload)
         values (?, ?, ?, ?)
         on conflict(id) do update set payload = excluded.payload`
      ).run(parsed.receipt.id, parsed.receipt.personId, parsed.receipt.committedAt, JSON.stringify(parsed.receipt));
      if (parsed.contractionJob) {
        const existingJob = await this.getContractionJob(parsed.contractionJob.id);
        const checkpoint = this.getContractionCheckpointForJob(parsed.personId, parsed.contractionJob.id);
        if (!existingReceipt || !this.sameRecord(existingReceipt, parsed.receipt)) {
          await this.saveContractionJob(existingJob
            ? this.mergeContractionJobs(existingJob, parsed.contractionJob, checkpoint)
            : parsed.contractionJob);
        }
      }
      this.faultInjector?.reach("after_import_checkpoint");
      this.faultInjector?.reach("before_import_commit");
      this.database.exec("commit");
      return parsed.receipt;
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
  }

  async commitContractionSlice(input: CommitContractionSliceInput): Promise<ContractionCheckpoint> {
    const parsed = CommitContractionSliceInputSchema.parse(input);
    this.validateContractionOwnership(parsed);
    this.database.exec("begin immediate");
    try {
      await this.assertWriteAuthority(parsed.authority, parsed.personId, "historical-bootstrap");
      const existingJob = await this.getContractionJob(parsed.jobId);
      if (!existingJob || existingJob.personId !== parsed.personId) throw new Error("Contraction job ownership mismatch");
      const existingCheckpoint = await this.getContractionCheckpoint(parsed.nextCheckpoint.id);
      if (!this.sameRecord(existingCheckpoint, parsed.expectedCheckpoint)) {
        if (this.sameRecord(existingCheckpoint, parsed.nextCheckpoint) && this.sameRecord(existingJob, parsed.nextJob)) {
          this.database.exec("rollback");
          return parsed.nextCheckpoint;
        }
        throw new Error("Contraction checkpoint changed");
      }
      for (const turn of parsed.turns) {
        this.assertStoredTurnOwnership(turn.id, parsed.personId);
        await this.saveTurn(turn);
      }
      for (const summary of parsed.summaries) {
        this.assertStoredDerivedOwnership("summaries", summary.id, parsed.personId, SummarySchema);
        await this.saveSummary(summary);
      }
      for (const anchor of parsed.anchors) {
        this.assertStoredDerivedOwnership("anchors", anchor.id, parsed.personId, AnchorSchema);
        await this.saveAnchor(anchor);
      }
      for (const box of parsed.boxes) {
        this.assertStoredDerivedOwnership("boxes", box.id, parsed.personId, BoxSchema);
        await this.saveBox(box);
      }
      for (const proposal of parsed.proposals) {
        const existing = await this.getProposal(proposal.id);
        if (existing && existing.personId !== parsed.personId) throw new Error("Derivation ownership mismatch");
        await this.saveProposal(proposal);
      }
      for (const trace of parsed.traces) {
        const existing = await this.getTrace(trace.id);
        if (existing && existing.personId !== parsed.personId) throw new Error("Derivation ownership mismatch");
        await this.saveTrace(trace);
      }
      await this.applySupersessions(parsed.supersessions);
      this.faultInjector?.reach("before_contraction_commit");
      await this.saveContractionJob(parsed.nextJob);
      await this.saveContractionCheckpoint(parsed.nextCheckpoint);
      this.faultInjector?.reach("after_contraction_checkpoint");
      this.database.exec("commit");
      return parsed.nextCheckpoint;
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
  }

  async commitApprovedGrantReconciliation(
    input: CommitApprovedGrantReconciliationInput
  ): Promise<DaemonSourceState[]> {
    const parsed = CommitApprovedGrantReconciliationInputSchema.parse(input);
    this.database.exec("begin immediate");
    try {
      await this.assertFreshDaemonAuthority(parsed.authority);
      const approved = (await this.listSourceGrants(parsed.personId))
        .filter((grant) => grant.state === "approved")
        .map((grant) => ({
          id: grant.id, personId: grant.personId, candidateId: grant.candidateId,
          updatedAt: grant.updatedAt, scopeId: grant.scopeId, state: "approved" as const
        }))
        .sort((left, right) => left.id.localeCompare(right.id));
      if (!this.sameRecord(approved, [...parsed.expectedGrants].sort((left, right) => left.id.localeCompare(right.id)))) {
        throw new Error("Approved source grants changed");
      }
      const current = await this.listDaemonSourceStates(parsed.personId);
      if (!this.sameRecord(current, [...parsed.expectedStates].sort((left, right) => left.id.localeCompare(right.id)))) {
        if (this.sameRecord(current, [...parsed.nextStates].sort((left, right) => left.id.localeCompare(right.id)))) {
          this.database.exec("rollback");
          return parsed.nextStates;
        }
        throw new Error("Daemon source registry changed");
      }
      this.validateNextSourceStates(parsed.personId, parsed.nextStates, approved);
      this.database.prepare("delete from daemon_source_state where person_id = ?").run(parsed.personId);
      for (const state of parsed.nextStates) await this.saveDaemonSourceState(state);
      this.database.exec("commit");
      return parsed.nextStates;
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
  }

  async commitDueSourceRefresh(input: CommitDueSourceRefreshInput): Promise<DaemonSourceState[]> {
    const parsed = CommitDueSourceRefreshInputSchema.parse(input);
    this.database.exec("begin immediate");
    try {
      await this.assertFreshDaemonAuthority(parsed.authority);
      const current = await this.listDaemonSourceStates(parsed.personId);
      if (!this.sameRecord(current, [...parsed.expectedStates].sort((left, right) => left.id.localeCompare(right.id)))) {
        if (this.sameRecord(current, [...parsed.nextStates].sort((left, right) => left.id.localeCompare(right.id)))) {
          this.database.exec("rollback");
          return parsed.nextStates;
        }
        throw new Error("Daemon source states changed");
      }
      this.validateNextSourceStates(parsed.personId, parsed.nextStates);
      for (const state of parsed.nextStates) await this.saveDaemonSourceState(state);
      this.database.exec("commit");
      return parsed.nextStates;
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
  }

  async commitSourceStateOutcome(input: CommitSourceStateOutcomeInput): Promise<DaemonSourceState> {
    const parsed = CommitSourceStateOutcomeInputSchema.parse(input);
    this.database.exec("begin immediate");
    try {
      await this.assertFreshDaemonAuthority(parsed.authority);
      const current = await this.getDaemonSourceState(parsed.nextState.id);
      if (!this.sameRecord(current, parsed.expectedState)) {
        if (this.sameRecord(current, parsed.nextState)) {
          this.database.exec("rollback");
          return parsed.nextState;
        }
        throw new Error("Daemon source state changed");
      }
      if (parsed.nextState.personId !== parsed.personId || parsed.nextState.candidateId !== parsed.candidateId) {
        throw new Error("Daemon source outcome ownership mismatch");
      }
      this.validateNextSourceStates(parsed.personId, [parsed.nextState]);
      await this.saveDaemonSourceState(parsed.nextState);
      this.database.exec("commit");
      return parsed.nextState;
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
  }

  async commitProposalRun(input: CommitProposalRunInput): Promise<ContractionCheckpoint | null> {
    const parsed = CommitProposalRunInputSchema.parse(input);
    this.validateProposalRun(parsed);
    this.database.exec("begin immediate");
    try {
      await this.assertWriteAuthority(parsed.authority, parsed.personId, "historical-bootstrap");
      const currentJob = await this.getContractionJob(parsed.jobId);
      const currentCheckpoint = parsed.nextCheckpoint
        ? await this.getContractionCheckpoint(parsed.nextCheckpoint.id)
        : null;
      if (!this.sameRecord(currentJob, parsed.expectedJob) || !this.sameRecord(currentCheckpoint, parsed.expectedCheckpoint)) {
        if (this.sameRecord(currentJob, parsed.nextJob) && this.sameRecord(currentCheckpoint, parsed.nextCheckpoint)) {
          this.database.exec("rollback");
          return parsed.nextCheckpoint;
        }
        throw new Error("Proposal run state changed");
      }
      for (const box of parsed.boxes) {
        this.assertStoredDerivedOwnership("boxes", box.id, parsed.personId, BoxSchema);
        await this.saveBox(box);
      }
      for (const proposal of parsed.proposals) {
        const existing = await this.getProposal(proposal.id);
        if (existing && existing.personId !== parsed.personId) throw new Error("Proposal ownership mismatch");
        await this.saveProposal(proposal);
      }
      for (const trace of parsed.traces) {
        const existing = await this.getTrace(trace.id);
        if (existing && existing.personId !== parsed.personId) throw new Error("Trace ownership mismatch");
        await this.saveTrace(trace);
      }
      await this.saveContractionJob(parsed.nextJob);
      if (parsed.nextCheckpoint) await this.saveContractionCheckpoint(parsed.nextCheckpoint);
      this.database.exec("commit");
      return parsed.nextCheckpoint;
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
  }

  async commitDaemonWorkOutcome(input: CommitDaemonWorkOutcomeInput): Promise<ContractionJob> {
    const parsed = CommitDaemonWorkOutcomeInputSchema.parse(input);
    this.database.exec("begin immediate");
    try {
      await this.assertFreshDaemonAuthority(parsed.authority);
      if (parsed.nextJob.personId !== parsed.personId || parsed.nextJob.id !== parsed.jobId) {
        throw new Error("Daemon work outcome ownership mismatch");
      }
      const current = await this.getContractionJob(parsed.jobId);
      if (!this.sameRecord(current, parsed.expectedJob)) {
        if (this.sameRecord(current, parsed.nextJob)) {
          this.database.exec("rollback");
          return parsed.nextJob;
        }
        throw new Error("Daemon work job changed");
      }
      await this.saveContractionJob(parsed.nextJob);
      this.database.exec("commit");
      return parsed.nextJob;
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
  }

  async savePerson(person: Person): Promise<void> {
    this.upsertPayload("people", PersonSchema.parse(person));
  }

  async getPerson(id: string): Promise<Person | null> {
    return this.getPayload("people", id, PersonSchema);
  }

  async listPeople(): Promise<Person[]> {
    const rows = this.database.prepare("select payload from people order by id asc").all() as PayloadRow[];
    return rows.map((row) => PersonSchema.parse(JSON.parse(row.payload)));
  }

  async saveSource(source: MemorySource): Promise<void> {
    const parsed = MemorySourceSchema.parse(source);
    const existing = await this.getSource(parsed.id);
    this.assertPersonOwnership(existing, parsed);
    this.database
      .prepare(
        `insert into memory_sources (id, person_id, payload)
         values (?, ?, ?)
         on conflict(id) do update set
           person_id = excluded.person_id,
           payload = excluded.payload`
      )
      .run(parsed.id, parsed.personId, JSON.stringify(parsed));
  }

  async getSource(id: string): Promise<MemorySource | null> {
    return this.getPayload("memory_sources", id, MemorySourceSchema);
  }

  async listSources(personId: string): Promise<MemorySource[]> {
    const rows = this.database
      .prepare("select payload from memory_sources where person_id = ? order by id asc")
      .all(personId) as PayloadRow[];

    return rows.map((row) => MemorySourceSchema.parse(JSON.parse(row.payload)));
  }

  async saveCanonicalEvent(event: CanonicalEvent): Promise<void> {
    const parsed = CanonicalEventSchema.parse(event);
    const existing = await this.getCanonicalEvent(parsed.id);
    this.assertPersonOwnership(existing, parsed);
    this.database
      .prepare(
        `insert into canonical_events
           (id, person_id, occurred_at, native_sequence, payload)
         values (?, ?, ?, ?, ?)
         on conflict(id) do update set
           person_id = excluded.person_id,
           occurred_at = excluded.occurred_at,
           native_sequence = excluded.native_sequence,
           payload = excluded.payload`
      )
      .run(
        parsed.id,
        parsed.personId,
        parsed.occurredAt,
        parsed.nativeSequence,
        JSON.stringify(parsed)
      );
  }

  async listCanonicalEvents(personId: string): Promise<CanonicalEvent[]> {
    const rows = this.database
      .prepare(
        `select payload from canonical_events
         where person_id = ?
         order by occurred_at asc, native_sequence asc, id asc`
      )
      .all(personId) as PayloadRow[];

    return rows.map((row) => CanonicalEventSchema.parse(JSON.parse(row.payload)));
  }

  async deleteCanonicalEvents(ids: string[]): Promise<void> {
    this.deleteIds("canonical_events", ids);
  }

  async deleteSources(ids: string[]): Promise<void> {
    this.deleteIds("memory_sources", ids);
  }

  async saveImportCheckpoint(checkpoint: ImportCheckpoint): Promise<void> {
    const parsed = ImportCheckpointSchema.parse(checkpoint);
    const existing = await this.getImportCheckpoint(parsed.id);
    this.assertPersonOwnership(existing, parsed);
    this.database
      .prepare(
        `insert into import_checkpoints (id, person_id, payload)
         values (?, ?, ?)
         on conflict(id) do update set
           person_id = excluded.person_id,
           payload = excluded.payload`
      )
      .run(parsed.id, parsed.personId, JSON.stringify(parsed));
  }

  async getImportCheckpoint(id: string): Promise<ImportCheckpoint | null> {
    return this.getPayload("import_checkpoints", id, ImportCheckpointSchema);
  }

  async listImportCheckpoints(personId: string): Promise<ImportCheckpoint[]> {
    const rows = this.database
      .prepare(
        `select payload from import_checkpoints
         where person_id = ?
         order by id asc`
      )
      .all(personId) as PayloadRow[];

    return rows.map((row) => ImportCheckpointSchema.parse(JSON.parse(row.payload)));
  }

  async deleteImportCheckpointsForCandidate(personId: string, candidateId: string): Promise<void> {
    const checkpoints = (await this.listImportCheckpoints(personId))
      .filter((checkpoint) => checkpoint.candidateId === candidateId);
    this.deleteIds("import_checkpoints", checkpoints.map((checkpoint) => checkpoint.id));
  }

  async saveSourceGrant(grant: SourceGrant): Promise<void> {
    const parsed = SourceGrantSchema.parse(grant);
    const existing = await this.getSourceGrant(parsed.id);
    this.assertPersonOwnership(existing, parsed);
    this.database.prepare(
      `insert into source_grants (id, person_id, state, payload)
       values (?, ?, ?, ?)
       on conflict(id) do update set person_id = excluded.person_id, state = excluded.state, payload = excluded.payload`
    ).run(parsed.id, parsed.personId, parsed.state, JSON.stringify(parsed));
  }

  async getSourceGrant(id: string): Promise<SourceGrant | null> {
    return this.getPayload("source_grants", id, SourceGrantSchema);
  }

  async listSourceGrants(personId: string): Promise<SourceGrant[]> {
    const rows = this.database.prepare(
      "select payload from source_grants where person_id = ? order by id asc"
    ).all(personId) as PayloadRow[];
    return rows.map((row) => SourceGrantSchema.parse(JSON.parse(row.payload)));
  }

  async saveSourceLifecycleAuditEvent(event: SourceLifecycleAuditEvent): Promise<void> {
    const parsed = SourceLifecycleAuditEventSchema.parse(event);
    const existing = this.database.prepare(
      "select payload from source_lifecycle_audit where id = ?"
    ).get(parsed.id) as PayloadRow | undefined;
    this.assertPersonOwnership(
      existing ? SourceLifecycleAuditEventSchema.parse(JSON.parse(existing.payload)) : null,
      parsed
    );
    this.database.prepare(
      `insert into source_lifecycle_audit (id, person_id, occurred_at, payload)
       values (?, ?, ?, ?)
       on conflict(id) do update set payload = excluded.payload`
    ).run(parsed.id, parsed.personId, parsed.occurredAt, JSON.stringify(parsed));
  }

  async listSourceLifecycleAuditEvents(personId: string): Promise<SourceLifecycleAuditEvent[]> {
    const rows = this.database.prepare(
      "select payload from source_lifecycle_audit where person_id = ? order by occurred_at asc, id asc"
    ).all(personId) as PayloadRow[];
    return rows.map((row) => SourceLifecycleAuditEventSchema.parse(JSON.parse(row.payload)));
  }

  async saveQuarantineRecord(record: QuarantineRecord): Promise<void> {
    const parsed = QuarantineRecordSchema.parse(record);
    const existing = await this.getQuarantineRecord(parsed.id);
    this.assertPersonOwnership(existing, parsed);
    this.database.prepare(
      `insert into quarantine_records (id, person_id, candidate_id, state, payload)
       values (?, ?, ?, ?, ?)
       on conflict(id) do update set state = excluded.state, payload = excluded.payload`
    ).run(parsed.id, parsed.personId, parsed.candidateId, parsed.state, JSON.stringify(parsed));
  }

  async getQuarantineRecord(id: string): Promise<QuarantineRecord | null> {
    return this.getPayload("quarantine_records", id, QuarantineRecordSchema);
  }

  async listQuarantineRecords(personId: string, candidateId?: string): Promise<QuarantineRecord[]> {
    const rows = candidateId === undefined
      ? this.database.prepare("select payload from quarantine_records where person_id = ? order by id asc").all(personId) as PayloadRow[]
      : this.database.prepare("select payload from quarantine_records where person_id = ? and candidate_id = ? order by id asc").all(personId, candidateId) as PayloadRow[];
    return rows.map((row) => QuarantineRecordSchema.parse(JSON.parse(row.payload)));
  }

  async deleteQuarantineRecords(personId: string, candidateId: string): Promise<void> {
    const records = await this.listQuarantineRecords(personId, candidateId);
    this.deleteIds("quarantine_records", records.map((record) => record.id));
  }

  async saveBootstrapCheckpoint(checkpoint: HistoricalBootstrapCheckpoint): Promise<void> {
    const parsed = HistoricalBootstrapCheckpointSchema.parse(checkpoint);
    const existing = await this.getBootstrapCheckpoint(parsed.id);
    this.assertPersonOwnership(existing, parsed);
    this.database
      .prepare(
        `insert into bootstrap_checkpoints (id, person_id, payload)
         values (?, ?, ?)
         on conflict(id) do update set
           person_id = excluded.person_id,
           payload = excluded.payload`
      )
      .run(parsed.id, parsed.personId, JSON.stringify(parsed));
  }

  async getBootstrapCheckpoint(id: string): Promise<HistoricalBootstrapCheckpoint | null> {
    return this.getPayload(
      "bootstrap_checkpoints",
      id,
      HistoricalBootstrapCheckpointSchema
    );
  }

  async deleteBootstrapCheckpoint(id: string): Promise<void> {
    this.deleteIds("bootstrap_checkpoints", [id]);
  }

  private async getCanonicalEvent(id: string): Promise<CanonicalEvent | null> {
    const row = this.database
      .prepare("select payload from canonical_events where id = ?")
      .get(id) as PayloadRow | undefined;

    return row ? CanonicalEventSchema.parse(JSON.parse(row.payload)) : null;
  }

  async saveTurn(turn: Turn): Promise<void> {
    const parsed = TurnSchema.parse(turn);
    this.database
      .prepare(
        `insert into turns (id, thread_id, sequence, payload)
         values (?, ?, ?, ?)
         on conflict(id) do update set
           thread_id = excluded.thread_id,
           sequence = excluded.sequence,
           payload = excluded.payload`
      )
      .run(parsed.id, parsed.threadId, parsed.sequence, JSON.stringify(parsed));
  }

  async listTurns(threadId: string): Promise<Turn[]> {
    const rows = this.database
      .prepare("select payload from turns where thread_id = ? order by sequence asc, id asc")
      .all(threadId) as PayloadRow[];

    return rows.map((row) => TurnSchema.parse(JSON.parse(row.payload)));
  }

  async deleteTurns(ids: string[]): Promise<void> {
    this.deleteIds("turns", ids);
  }

  async saveSummary(summary: Summary): Promise<void> {
    this.upsertPayload("summaries", SummarySchema.parse(summary));
  }

  async listSummaries(): Promise<Summary[]> {
    return this.listPayloads("summaries", SummarySchema);
  }

  async saveBox(box: Box): Promise<void> {
    this.upsertPayload("boxes", BoxSchema.parse(box));
  }

  async getBox(id: string): Promise<Box | null> {
    return this.getPayload("boxes", id, BoxSchema);
  }

  async listBoxes(): Promise<Box[]> {
    return this.listPayloads("boxes", BoxSchema);
  }

  async saveAnchor(anchor: Anchor): Promise<void> {
    this.upsertPayload("anchors", AnchorSchema.parse(anchor));
  }

  async listAnchors(): Promise<Anchor[]> {
    return this.listPayloads("anchors", AnchorSchema);
  }

  async deleteAnchors(ids: string[]): Promise<void> {
    this.deleteIds("anchors", ids);
  }

  async saveInjection(packet: InjectionPacket): Promise<void> {
    const parsed = InjectionPacketSchema.parse(packet);
    this.database
      .prepare(
        `insert into injections (id, host_session_id, payload)
         values (?, ?, ?)
         on conflict(id) do update set
           host_session_id = excluded.host_session_id,
           payload = excluded.payload`
      )
      .run(parsed.id, parsed.hostSessionId, JSON.stringify(parsed));
  }

  async listInjections(hostSessionId: string): Promise<InjectionPacket[]> {
    const rows = this.database
      .prepare("select payload from injections where host_session_id = ? order by id asc")
      .all(hostSessionId) as PayloadRow[];

    return rows.map((row) => InjectionPacketSchema.parse(JSON.parse(row.payload)));
  }

  async deleteInjectionsReferencingSummaryIds(summaryIds: string[]): Promise<void> {
    const targets = new Set(summaryIds);
    const rows = this.database.prepare("select payload from injections").all() as PayloadRow[];
    const ids = rows
      .map((row) => InjectionPacketSchema.parse(JSON.parse(row.payload)))
      .filter((packet) => packet.sourceSummaryIds.some((id) => targets.has(id)))
      .map((packet) => packet.id);
    this.deleteIds("injections", ids);
  }

  async saveProposal(proposal: MemoryProposal): Promise<void> {
    const parsed = MemoryProposalSchema.parse(proposal);
    this.database
      .prepare(
        `insert into proposals (id, state, proposal_type, payload)
         values (?, ?, ?, ?)
         on conflict(id) do update set
           state = excluded.state,
           proposal_type = excluded.proposal_type,
           payload = excluded.payload`
      )
      .run(parsed.id, parsed.state, parsed.proposalType, JSON.stringify(parsed));
  }

  async getProposal(id: string): Promise<MemoryProposal | null> {
    const row = this.database.prepare("select payload from proposals where id = ?").get(id) as PayloadRow | undefined;
    return row ? MemoryProposalSchema.parse(JSON.parse(row.payload)) : null;
  }

  async listProposals(filter: ProposalFilter = {}): Promise<MemoryProposal[]> {
    const clauses: string[] = [];
    const values: string[] = [];
    if (filter.state) {
      clauses.push("state = ?");
      values.push(filter.state);
    }
    if (filter.proposalType) {
      clauses.push("proposal_type = ?");
      values.push(filter.proposalType);
    }
    const where = clauses.length > 0 ? ` where ${clauses.join(" and ")}` : "";
    const rows = this.database
      .prepare(`select payload from proposals${where} order by id asc`)
      .all(...values) as PayloadRow[];

    return rows.map((row) => MemoryProposalSchema.parse(JSON.parse(row.payload)));
  }

  async saveTrace(trace: MemoryTrace): Promise<void> {
    const parsed = MemoryTraceSchema.parse(trace);
    this.database
      .prepare(
        `insert into traces (id, state, payload)
         values (?, ?, ?)
         on conflict(id) do update set
           state = excluded.state,
           payload = excluded.payload`
      )
      .run(parsed.id, parsed.state, JSON.stringify(parsed));
  }

  async getTrace(id: string): Promise<MemoryTrace | null> {
    const row = this.database.prepare("select payload from traces where id = ?").get(id) as PayloadRow | undefined;
    return row ? MemoryTraceSchema.parse(JSON.parse(row.payload)) : null;
  }

  async listTraces(filter: TraceFilter = {}): Promise<MemoryTrace[]> {
    const rows = filter.state
      ? this.database.prepare("select payload from traces where state = ? order by id asc").all(filter.state) as PayloadRow[]
      : this.database.prepare("select payload from traces order by id asc").all() as PayloadRow[];

    return rows.map((row) => MemoryTraceSchema.parse(JSON.parse(row.payload)));
  }

  async commitLocalSyncOperation(input: CommitLocalSyncOperationInput): Promise<SyncCommitReceipt> {
    const parsed = CommitLocalSyncOperationInputSchema.parse(input);
    this.database.exec("begin immediate");
    try {
      const existingOutboxRow = this.database.prepare(
        "select payload from sync_outbox where person_id = ? and device_id = ? and device_sequence = ?"
      ).get(parsed.personId, parsed.deviceId, parsed.deviceSequence) as PayloadRow | undefined;
      if (existingOutboxRow) {
        const existing = SyncOutboxOperationSchema.parse(JSON.parse(existingOutboxRow.payload));
        const identical = existing.id === parsed.outboxId &&
          existing.operationKind === parsed.operationKind &&
          existing.targetId === parsed.targetId &&
          existing.predecessorDigest === parsed.predecessorDigest &&
          existing.effectFingerprint === parsed.effectFingerprint;
        this.database.exec("rollback");
        return { ...parsed.receipt, status: identical ? "IDEMPOTENT" : "EQUIVOCATION" };
      }
      const frontier = this.frontierFor(parsed.personId, parsed.deviceId);
      if (frontier !== parsed.expectedFrontierSequence) {
        this.database.exec("rollback");
        return this.syncStateChanged(parsed.receipt);
      }
      this.faultInjector?.reach("local_sync_before_effect");
      const effect = LocalSyncEffectRecordSchema.parse({
        id: `${parsed.outboxId}_effect`,
        personId: parsed.personId,
        deviceId: parsed.deviceId,
        operationKind: parsed.operationKind,
        targetId: parsed.targetId,
        deviceSequence: parsed.deviceSequence,
        effectFingerprint: parsed.effectFingerprint,
        committedAt: parsed.committedAt
      });
      this.database.prepare(
        "insert into local_sync_effects (id, person_id, device_id, device_sequence, payload) values (?, ?, ?, ?, ?)"
      ).run(effect.id, effect.personId, effect.deviceId, effect.deviceSequence, JSON.stringify(effect));
      this.faultInjector?.reach("local_sync_after_effect");
      const outbox = SyncOutboxOperationSchema.parse({
        id: parsed.outboxId, personId: parsed.personId, deviceId: parsed.deviceId,
        operationKind: parsed.operationKind, targetId: parsed.targetId, deviceSequence: parsed.deviceSequence,
        predecessorDigest: parsed.predecessorDigest, effectFingerprint: parsed.effectFingerprint,
        status: "pending", rowVersion: 0, createdAt: parsed.committedAt,
        sealedProtocolVersion: null, sealedSequence: null, sealedPredecessorDigest: null,
        sealedEnvelopeBytesBase64: null, sealedEnvelopeDigest: null, sealedAt: null
      });
      this.database.prepare(
        "insert into sync_outbox (id, person_id, device_id, device_sequence, status, row_version, payload) values (?, ?, ?, ?, ?, ?, ?)"
      ).run(outbox.id, outbox.personId, outbox.deviceId, outbox.deviceSequence, outbox.status, outbox.rowVersion, JSON.stringify(outbox));
      this.faultInjector?.reach("local_sync_after_outbox");
      this.setFrontier(parsed.personId, parsed.deviceId, parsed.deviceSequence);
      this.database.exec("commit");
      return parsed.receipt;
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
  }

  async commitRemoteSyncApply(input: CommitRemoteSyncApplyInput): Promise<SyncCommitReceipt> {
    const parsed = CommitRemoteSyncApplyInputSchema.parse(input);
    this.database.exec("begin immediate");
    try {
      const frontier = this.frontierFor(parsed.personId, parsed.authorDeviceId);
      if (parsed.sequence <= frontier) {
        const row = this.database.prepare(
          "select payload from accepted_sync_operations where person_id = ? and author_device_id = ? and sequence = ?"
        ).get(parsed.personId, parsed.authorDeviceId, parsed.sequence) as PayloadRow | undefined;
        const existing = row ? AcceptedSyncOperationSchema.parse(JSON.parse(row.payload)) : null;
        const identical = existing !== null && existing.envelopeDigest === parsed.envelopeDigest && existing.effectFingerprint === parsed.effectFingerprint;
        this.database.exec("rollback");
        return { ...parsed.receipt, status: identical ? "IDEMPOTENT" : "EQUIVOCATION" };
      }
      if (parsed.sequence > frontier + MAX_RETAINED_GAP_SLOTS) {
        // ADR 0047 "Data Plane, Replay, and Equivocation": at most MAX_RETAINED_GAP_SLOTS future
        // sequence slots (or a maximum jump of that size) are retained per device. A single
        // validly-signed high-sequence envelope must not drive proportional allocation of one
        // PendingSyncGap per intervening slot, so classify as bounded and return before the loop.
        this.database.exec("commit");
        return { ...parsed.receipt, status: "GAP_PENDING" };
      }
      if (parsed.sequence > frontier + 1) {
        for (let missing = frontier + 1; missing < parsed.sequence; missing += 1) {
          const gap = PendingSyncGapSchema.parse({
            personId: parsed.personId, authorDeviceId: parsed.authorDeviceId, missingSequence: missing, detectedAt: parsed.appliedAt
          });
          this.database.prepare(
            "insert or ignore into pending_sync_gaps (person_id, author_device_id, missing_sequence, payload) values (?, ?, ?, ?)"
          ).run(gap.personId, gap.authorDeviceId, gap.missingSequence, JSON.stringify(gap));
        }
        this.database.exec("commit");
        return { ...parsed.receipt, status: "GAP_PENDING" };
      }
      this.faultInjector?.reach("remote_apply_before_write");
      const accepted = AcceptedSyncOperationSchema.parse({
        id: `${parsed.personId}_${parsed.authorDeviceId}_${parsed.sequence}`,
        personId: parsed.personId, authorDeviceId: parsed.authorDeviceId, sequence: parsed.sequence,
        predecessorDigest: parsed.predecessorDigest, envelopeDigest: parsed.envelopeDigest,
        effectFingerprint: parsed.effectFingerprint, outcomeKind: parsed.outcome.kind, acceptedAt: parsed.appliedAt
      });
      this.database.prepare(
        "insert into accepted_sync_operations (id, person_id, author_device_id, sequence, payload) values (?, ?, ?, ?, ?)"
      ).run(accepted.id, accepted.personId, accepted.authorDeviceId, accepted.sequence, JSON.stringify(accepted));
      this.faultInjector?.reach("remote_apply_after_operation");
      if (parsed.outcome.kind === "conflict") {
        const conflict = SyncConflictRecordSchema.parse({
          id: `${accepted.id}_conflict`, personId: parsed.personId, authorDeviceId: parsed.authorDeviceId,
          sequence: parsed.sequence, detailFingerprint: parsed.outcome.detailFingerprint, detectedAt: parsed.appliedAt
        });
        this.database.prepare("insert into sync_conflicts (id, person_id, payload) values (?, ?, ?)")
          .run(conflict.id, conflict.personId, JSON.stringify(conflict));
      } else if (parsed.outcome.kind === "tombstone") {
        const tombstone = SyncTombstoneSchema.parse({
          id: `${accepted.id}_tombstone`, personId: parsed.personId, targetId: parsed.outcome.targetId,
          authorDeviceId: parsed.authorDeviceId, sequence: parsed.sequence, tombstonedAt: parsed.appliedAt
        });
        this.database.prepare("insert into sync_tombstones (id, person_id, payload) values (?, ?, ?)")
          .run(tombstone.id, tombstone.personId, JSON.stringify(tombstone));
      } else if (parsed.outcome.kind === "quarantine") {
        const quarantine = SyncQuarantineEntrySchema.parse({
          id: `${accepted.id}_quarantine`, personId: parsed.personId, authorDeviceId: parsed.authorDeviceId,
          sequence: parsed.sequence, reasonFingerprint: parsed.outcome.reasonFingerprint, quarantinedAt: parsed.appliedAt
        });
        this.database.prepare("insert into sync_quarantine (id, person_id, payload) values (?, ?, ?)")
          .run(quarantine.id, quarantine.personId, JSON.stringify(quarantine));
      }
      this.faultInjector?.reach("remote_apply_after_outcome");
      const existingRangeRow = this.database.prepare(
        "select payload from sync_contraction_ranges where person_id = ?"
      ).get(parsed.personId) as PayloadRow | undefined;
      const existingRange = existingRangeRow ? SyncContractionRangeSchema.parse(JSON.parse(existingRangeRow.payload)) : null;
      const merged = SyncContractionRangeSchema.parse({
        personId: parsed.personId,
        rangeStart: existingRange ? Math.min(existingRange.rangeStart, parsed.affectedRangeStart) : parsed.affectedRangeStart,
        rangeEnd: existingRange ? Math.max(existingRange.rangeEnd, parsed.affectedRangeEnd) : parsed.affectedRangeEnd
      });
      this.database.prepare(
        "insert into sync_contraction_ranges (person_id, payload) values (?, ?) on conflict(person_id) do update set payload = excluded.payload"
      ).run(merged.personId, JSON.stringify(merged));
      this.faultInjector?.reach("remote_apply_after_range");
      this.setFrontier(parsed.personId, parsed.authorDeviceId, parsed.sequence);
      this.database.exec("commit");
      return parsed.receipt;
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
  }

  async sealClaimedOutboxEnvelope(input: SealClaimedOutboxEnvelopeInput): Promise<SealOutboxResult> {
    const parsed = SealClaimedOutboxEnvelopeInputSchema.parse(input);
    this.database.exec("begin immediate");
    try {
      const row = this.database.prepare(
        "select payload from sync_outbox where id = ? and person_id = ? and device_id = ?"
      ).get(parsed.outboxId, parsed.personId, parsed.deviceId) as PayloadRow | undefined;
      if (!row) {
        this.database.exec("rollback");
        return { status: "STATE_CHANGED", record: null };
      }
      const current = SyncOutboxOperationSchema.parse(JSON.parse(row.payload));
      if (current.status === "sealed") {
        const identical = current.sealedProtocolVersion === parsed.protocolVersion &&
          current.sealedSequence === parsed.sequence &&
          current.sealedPredecessorDigest === parsed.predecessorDigest &&
          current.sealedEnvelopeBytesBase64 === parsed.envelopeBytesBase64 &&
          current.sealedEnvelopeDigest === parsed.envelopeDigest;
        this.database.exec("rollback");
        return { status: identical ? "IDEMPOTENT" : "EQUIVOCATION", record: identical ? current : null };
      }
      if (current.rowVersion !== parsed.expectedRowVersion) {
        this.database.exec("rollback");
        return { status: "STATE_CHANGED", record: null };
      }
      this.faultInjector?.reach("seal_outbox_before_write");
      const sealed = SyncOutboxOperationSchema.parse({
        ...current,
        status: "sealed",
        rowVersion: current.rowVersion + 1,
        sealedProtocolVersion: parsed.protocolVersion,
        sealedSequence: parsed.sequence,
        sealedPredecessorDigest: parsed.predecessorDigest,
        sealedEnvelopeBytesBase64: parsed.envelopeBytesBase64,
        sealedEnvelopeDigest: parsed.envelopeDigest,
        sealedAt: this.clock.now()
      });
      this.database.prepare(
        "update sync_outbox set status = ?, row_version = ?, payload = ? where id = ?"
      ).run(sealed.status, sealed.rowVersion, JSON.stringify(sealed), sealed.id);
      this.faultInjector?.reach("seal_outbox_after_write");
      this.database.exec("commit");
      return { status: "SEALED", record: sealed };
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
  }

  async getSyncReplayFrontier(personId: string, deviceId: string): Promise<number> {
    return this.frontierFor(personId, deviceId);
  }

  async listSyncOutboxOperations(personId: string): Promise<SyncOutboxOperation[]> {
    const rows = this.database.prepare(
      "select payload from sync_outbox where person_id = ? order by device_sequence asc"
    ).all(personId) as PayloadRow[];
    return rows.map((row) => SyncOutboxOperationSchema.parse(JSON.parse(row.payload)));
  }

  async listAcceptedSyncOperations(personId: string): Promise<AcceptedSyncOperation[]> {
    const rows = this.database.prepare(
      "select payload from accepted_sync_operations where person_id = ? order by sequence asc"
    ).all(personId) as PayloadRow[];
    return rows.map((row) => AcceptedSyncOperationSchema.parse(JSON.parse(row.payload)));
  }

  private frontierFor(personId: string, deviceId: string): number {
    const row = this.database.prepare(
      "select frontier_sequence as frontierSequence from sync_frontiers where person_id = ? and device_id = ?"
    ).get(personId, deviceId) as { frontierSequence: number } | undefined;
    return row?.frontierSequence ?? 0;
  }

  private setFrontier(personId: string, deviceId: string, sequence: number): void {
    this.database.prepare(
      "insert into sync_frontiers (person_id, device_id, frontier_sequence) values (?, ?, ?) on conflict(person_id, device_id) do update set frontier_sequence = excluded.frontier_sequence"
    ).run(personId, deviceId, sequence);
  }

  private syncStateChanged(receipt: SyncCommitReceipt): SyncCommitReceipt {
    return { ...receipt, status: "STATE_CHANGED" };
  }

  private stateChanged(receipt: MutationCommitReceipt): MutationCommitReceipt {
    return { ...receipt, status: "STATE_CHANGED", effectCounts: {} };
  }

  private async sourceDeletionEffectsMatch(input: CommitSourceDeletionInput): Promise<boolean> {
    const computed = await this.computeSourceDeletionEffects(input.personId, input.expectedGrant.candidateId, input.auditEvents.map((item) => item.id));
    return this.sameRecord(this.sortedEffects(computed), this.sortedEffects(input.effects));
  }

  private async computeSourceDeletionEffects(personId: string, candidateId: string, auditEventIds: string[]) {
    const sourceIds = (await this.listSources(personId)).filter((item) => item.instanceId === candidateId).map((item) => item.id);
    const sourceIdSet = new Set(sourceIds);
    const eventIds = (await this.listCanonicalEvents(personId)).filter((item) => sourceIdSet.has(item.sourceId)).map((item) => item.id);
    const eventIdSet = new Set(eventIds);
    const summaryIds = (await this.listSummaries()).filter((item) => item.personId === personId && item.state !== "superseded" && (item.sourceCanonicalEventIds ?? []).some((id) => eventIdSet.has(id))).map((item) => item.id);
    const summaryIdSet = new Set(summaryIds);
    const allTurns = this.listAllPayloads("turns", TurnSchema);
    const allInjections = this.listAllPayloads("injections", InjectionPacketSchema);
    const allQuarantine = this.listAllPayloads("quarantine_records", QuarantineRecordSchema);
    const allBootstrap = this.listAllPayloads("bootstrap_checkpoints", HistoricalBootstrapCheckpointSchema);
    const computed = {
      sourceIds,
      canonicalEventIds: eventIds,
      turnIds: allTurns.filter((item) => eventIds.some((id) => item.id === `turn_${id}` || item.id === `personal_turn_${id}`)).map((item) => item.id),
      anchorIds: (await this.listAnchors()).filter((item) => item.personId === personId && item.canonicalEventId !== undefined && eventIdSet.has(item.canonicalEventId)).map((item) => item.id),
      injectionIds: allInjections.filter((item) => item.sourceSummaryIds.some((id) => summaryIdSet.has(id))).map((item) => item.id),
      quarantineIds: allQuarantine.filter((item) => item.personId === personId && item.candidateId === candidateId).map((item) => item.id),
      bootstrapCheckpointIds: allBootstrap.filter((item) => item.personId === personId).map((item) => item.id),
      supersededSummaryIds: summaryIds,
      supersededBoxIds: (await this.listBoxes()).filter((item) => item.personId === personId && item.state !== "superseded" && item.summaryIds.some((id) => summaryIdSet.has(id))).map((item) => item.id),
      supersededProposalIds: (await this.listProposals()).filter((item) => item.personId === personId && item.state !== "superseded" && item.sourceSummaryIds.some((id) => summaryIdSet.has(id))).map((item) => item.id),
      supersededTraceIds: (await this.listTraces()).filter((item) => item.personId === personId && item.state !== "superseded" && item.summaryIds.some((id) => summaryIdSet.has(id))).map((item) => item.id),
      auditEventIds
    };
    return this.sortedEffects(computed);
  }

  private listAllPayloads<T>(table: string, schema: { parse(value: unknown): T }): T[] {
    const rows = this.database.prepare(`select payload from ${table} order by id asc`).all() as PayloadRow[];
    return rows.map((row) => schema.parse(JSON.parse(row.payload)));
  }

  private sortedEffects<T extends Record<string, string[]>>(effects: T): T {
    return Object.fromEntries(Object.entries(effects).map(([key, ids]) => [key, [...ids].sort()])) as T;
  }

  private validateImportOwnership(input: CommitImportBatchInput): void {
    const { personId, expectedGrant, checkpoint, receipt, contractionJob } = input;
    if (expectedGrant.personId !== personId || checkpoint.personId !== personId || receipt.personId !== personId || (contractionJob !== null && contractionJob.personId !== personId)) {
      throw new Error("Import batch person ownership mismatch");
    }
    if (checkpoint.candidateId !== expectedGrant.candidateId || receipt.candidateId !== expectedGrant.candidateId || receipt.grantId !== expectedGrant.id) {
      throw new Error("Import batch grant or candidate ownership mismatch");
    }
    for (const source of input.sources) {
      if (source.personId !== personId || source.instanceId !== expectedGrant.candidateId || source.scopeId !== receipt.scopeId) {
        throw new Error("Import source ownership mismatch");
      }
    }
    for (const event of input.canonicalEvents) {
      if (event.personId !== personId || event.scopeId !== receipt.scopeId) throw new Error("Canonical event ownership mismatch");
    }
    for (const record of input.quarantineChanges) {
      if (record.personId !== personId || record.candidateId !== expectedGrant.candidateId) throw new Error("Quarantine ownership mismatch");
    }
    for (const turn of input.turns) {
      if (turn.metadata.personId !== personId || turn.threadId !== `person:${personId}`) throw new Error("Turn ownership mismatch");
    }
  }

  private async assertFreshDaemonAuthority(authority: { databaseId: string; ownerToken: string }): Promise<void> {
    const now = Date.parse(this.clock.now());
    if (Number.isNaN(now)) throw new Error("Invalid authoritative store clock");
    const lease = this.database.prepare(
      "select owner_token as ownerToken, expires_at as expiresAt from daemon_lease where database_id = ?"
    ).get(authority.databaseId) as { ownerToken: string; expiresAt: string } | undefined;
    if (!lease || lease.ownerToken !== authority.ownerToken || Date.parse(lease.expiresAt) <= now) {
      throw new Error("Daemon write authority is missing, stale, or expired");
    }
  }

  private async assertWriteAuthority(
    authority: CommitImportBatchInput["authority"],
    personId: string,
    foregroundOperation: "approved-import" | "historical-bootstrap"
  ): Promise<void> {
    if (authority.kind === "daemon") {
      await this.assertFreshDaemonAuthority(authority);
      return;
    }
    if (authority.personId !== personId || authority.operation !== foregroundOperation) {
      throw new Error("Foreground write authority is not valid for this operation");
    }
  }

  private validateNextSourceStates(
    personId: string,
    states: DaemonSourceState[],
    expectedGrants?: Array<{ id: string; personId: string; candidateId: string; scopeId: string }>
  ): void {
    if (new Set(states.map((state) => state.id)).size !== states.length) throw new Error("Duplicate daemon source state");
    for (const state of states) {
      if (state.personId !== personId) throw new Error("Daemon source state person ownership mismatch");
      const expected = expectedGrants?.find((candidate) => candidate.id === state.grantId);
      if (expected && (expected.personId !== personId || expected.candidateId !== state.candidateId || expected.scopeId !== state.scopeId)) {
        throw new Error("Daemon source state grant ownership mismatch");
      }
      if (!expectedGrants) {
        const row = this.database.prepare("select payload from source_grants where id = ?").get(state.grantId) as PayloadRow | undefined;
        const grant = row ? SourceGrantSchema.parse(JSON.parse(row.payload)) : null;
        if (!grant || grant.state !== "approved" || grant.personId !== personId || grant.candidateId !== state.candidateId || grant.scopeId !== state.scopeId) {
          throw new Error("Daemon source state grant ownership mismatch");
        }
      }
      else if (!expected) throw new Error("Daemon source state grant ownership mismatch");
    }
  }

  private validateProposalRun(input: CommitProposalRunInput): void {
    if (input.nextJob.id !== input.jobId || input.nextJob.personId !== input.personId ||
        (input.nextCheckpoint && (input.nextCheckpoint.jobId !== input.jobId || input.nextCheckpoint.personId !== input.personId))) {
      throw new Error("Proposal run person or job ownership mismatch");
    }
    const outputs = [...input.boxes, ...input.proposals, ...input.traces];
    if (outputs.some((item) => item.personId !== input.personId || item.state !== "proposed")) {
      throw new Error("Proposal run accepts only proposed person-owned review objects");
    }
  }

  private validateImportReceipt(input: CommitImportBatchInput): void {
    const { checkpoint, receipt } = input;
    if (receipt.checkpointIds.length !== 1 || receipt.checkpointIds[0] !== checkpoint.id) throw new Error("Import receipt checkpoint mismatch");
    if (receipt.canonicalEventIds.length !== receipt.canonicalOrderKeys.length || receipt.canonicalOrderKeys.some((key, index) => key.id !== receipt.canonicalEventIds[index])) {
      throw new Error("Import receipt canonical ordering mismatch");
    }
  }

  private validateContractionOwnership(input: CommitContractionSliceInput): void {
    if (
      input.nextCheckpoint.personId !== input.personId || input.nextCheckpoint.jobId !== input.jobId ||
      input.nextJob.personId !== input.personId || input.nextJob.id !== input.jobId ||
      (input.expectedCheckpoint !== null && (input.expectedCheckpoint.personId !== input.personId || input.expectedCheckpoint.jobId !== input.jobId))
    ) {
      throw new Error("Contraction slice person or job ownership mismatch");
    }
    const owned: Array<{ personId?: string }> = [
      ...input.summaries,
      ...input.anchors,
      ...input.boxes,
      ...input.proposals,
      ...input.traces
    ];
    if (owned.some((item) => item.personId !== input.personId)) throw new Error("Contraction derivation ownership mismatch");
    if (input.supersessions.some((item) => item.personId !== input.personId)) throw new Error("Supersession ownership mismatch");
    for (const turn of input.turns) {
      if (turn.metadata.personId !== input.personId || turn.threadId !== `person:${input.personId}`) throw new Error("Contraction turn ownership mismatch");
    }
  }

  private mergeContractionJobs(
    existing: ContractionJob,
    incoming: ContractionJob,
    checkpoint: ContractionCheckpoint | null
  ): ContractionJob {
    if (existing.personId !== incoming.personId) throw new Error("Contraction job ownership mismatch");
    const compare = (left: ContractionJob["earliestAffected"], right: ContractionJob["earliestAffected"]): number =>
      left.occurredAt.localeCompare(right.occurredAt) || left.nativeSequence - right.nativeSequence || left.id.localeCompare(right.id);
    const replaceCompletedWindow = existing.state === "complete" && !existing.immediateDirty;
    const rewindsProcessedWork = checkpoint?.generation === existing.generation && checkpoint.processedThroughOrderKey != null &&
      compare(incoming.earliestAffected, checkpoint.processedThroughOrderKey) < 0;
    return ContractionJobSchema.parse({
      ...incoming,
      generation: rewindsProcessedWork ? existing.generation + 1 : existing.generation,
      createdAt: existing.createdAt,
      lastProposalRunAt: existing.lastProposalRunAt,
      earliestAffected: !replaceCompletedWindow && compare(existing.earliestAffected, incoming.earliestAffected) <= 0
        ? existing.earliestAffected
        : incoming.earliestAffected,
      latestAffected: !replaceCompletedWindow && compare(existing.latestAffected, incoming.latestAffected) >= 0
        ? existing.latestAffected
        : incoming.latestAffected,
      immediateDirty: rewindsProcessedWork || existing.immediateDirty || incoming.immediateDirty,
      proposalDirty: rewindsProcessedWork || existing.proposalDirty || incoming.proposalDirty,
      state: "pending"
    });
  }

  private getContractionCheckpointForJob(personId: string, jobId: string): ContractionCheckpoint | null {
    const row = this.database.prepare(
      "select payload from daemon_contraction_checkpoint where person_id = ? and job_id = ? order by id asc limit 1"
    ).get(personId, jobId) as PayloadRow | undefined;
    return row ? ContractionCheckpointSchema.parse(JSON.parse(row.payload)) : null;
  }

  private async applySupersessions(supersessions: CommitContractionSliceInput["supersessions"]): Promise<void> {
    for (const supersession of supersessions) {
      if (supersession.kind === "anchor") {
        const anchor = this.getPayload("anchors", supersession.id, AnchorSchema);
        if (anchor && anchor.personId !== supersession.personId) throw new Error("Supersession ownership mismatch");
        this.database.prepare("delete from anchors where id = ?").run(supersession.id);
        continue;
      }
      if (supersession.kind === "summary") {
        const item = this.getPayload("summaries", supersession.id, SummarySchema);
        if (item && item.personId !== supersession.personId) throw new Error("Supersession ownership mismatch");
        if (item) await this.saveSummary({ ...item, state: "superseded" });
      } else if (supersession.kind === "box") {
        const item = this.getPayload("boxes", supersession.id, BoxSchema);
        if (item && item.personId !== supersession.personId) throw new Error("Supersession ownership mismatch");
        if (item) await this.saveBox({ ...item, state: "superseded" });
      } else if (supersession.kind === "proposal") {
        const item = await this.getProposal(supersession.id);
        if (item && item.personId !== supersession.personId) throw new Error("Supersession ownership mismatch");
        if (item) await this.saveProposal({ ...item, state: "superseded" });
      } else {
        const item = await this.getTrace(supersession.id);
        if (item && item.personId !== supersession.personId) throw new Error("Supersession ownership mismatch");
        if (item) await this.saveTrace({ ...item, state: "superseded" });
      }
    }
  }

  private sameRecord(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  private assertStoredTurnOwnership(id: string, personId: string): void {
    const row = this.database.prepare("select payload from turns where id = ?").get(id) as PayloadRow | undefined;
    if (!row) return;
    const turn = TurnSchema.parse(JSON.parse(row.payload));
    if (turn.metadata.personId !== personId || turn.threadId !== `person:${personId}`) throw new Error("Turn ownership mismatch");
  }

  private assertStoredDerivedOwnership<T extends { personId?: string }>(
    table: "summaries" | "boxes" | "anchors",
    id: string,
    personId: string,
    schema: { parse(value: unknown): T }
  ): void {
    const item = this.getPayload(table, id, schema);
    if (item && item.personId !== personId) throw new Error("Derivation ownership mismatch");
  }

  private migrate(): void {
    this.database.exec(`
      create table if not exists daemon_lease (
        database_id text primary key,
        owner_token text not null,
        heartbeat_at text not null,
        expires_at text not null,
        payload text not null
      );

      create index if not exists idx_daemon_lease_heartbeat
        on daemon_lease (heartbeat_at, expires_at);

      create table if not exists daemon_source_state (
        id text primary key,
        person_id text not null,
        state text not null,
        next_due_at text not null,
        payload text not null
      );

      create index if not exists idx_daemon_source_state_person_due
        on daemon_source_state (person_id, state, next_due_at, id);

      create table if not exists daemon_import_receipt (
        id text primary key,
        person_id text not null,
        committed_at text not null,
        payload text not null
      );

      create index if not exists idx_daemon_import_receipt_person_time
        on daemon_import_receipt (person_id, committed_at, id);

      create table if not exists daemon_contraction_job (
        id text primary key,
        person_id text not null,
        state text not null,
        next_due_at text not null,
        earliest_at text not null,
        earliest_sequence integer not null,
        earliest_id text not null,
        latest_at text not null,
        latest_sequence integer not null,
        latest_id text not null,
        payload text not null
      );

      create index if not exists idx_daemon_contraction_job_person_due
        on daemon_contraction_job (person_id, state, next_due_at, id);

      create index if not exists idx_daemon_contraction_job_person_range
        on daemon_contraction_job (person_id, earliest_at, earliest_sequence, earliest_id, latest_at, latest_sequence, latest_id);

      create table if not exists daemon_contraction_checkpoint (
        id text primary key,
        person_id text not null,
        job_id text not null,
        payload text not null
      );

      create index if not exists idx_daemon_contraction_checkpoint_person_job
        on daemon_contraction_checkpoint (person_id, job_id, id);

      create table if not exists people (
        id text primary key,
        payload text not null
      );

      create table if not exists memory_sources (
        id text primary key,
        person_id text not null,
        payload text not null
      );

      create index if not exists idx_memory_sources_person
        on memory_sources (person_id, id);

      create table if not exists canonical_events (
        id text primary key,
        person_id text not null,
        occurred_at text not null,
        native_sequence integer not null,
        payload text not null
      );

      create index if not exists idx_canonical_events_person_order
        on canonical_events (person_id, occurred_at, native_sequence, id);

      create table if not exists import_checkpoints (
        id text primary key,
        person_id text not null,
        payload text not null
      );

      create index if not exists idx_import_checkpoints_person
        on import_checkpoints (person_id, id);

      create table if not exists source_grants (
        id text primary key,
        person_id text not null,
        state text not null,
        payload text not null
      );

      create index if not exists idx_source_grants_person_state
        on source_grants (person_id, state, id);

      create table if not exists source_lifecycle_audit (
        id text primary key,
        person_id text not null,
        occurred_at text not null,
        payload text not null
      );

      create index if not exists idx_source_lifecycle_audit_person_time
        on source_lifecycle_audit (person_id, occurred_at, id);

      create table if not exists quarantine_records (
        id text primary key,
        person_id text not null,
        candidate_id text not null,
        state text not null,
        payload text not null
      );

      create index if not exists idx_quarantine_person_candidate_state
        on quarantine_records (person_id, candidate_id, state, id);

      create table if not exists bootstrap_checkpoints (
        id text primary key,
        person_id text not null,
        payload text not null
      );

      create index if not exists idx_bootstrap_checkpoints_person
        on bootstrap_checkpoints (person_id, id);

      create table if not exists turns (
        id text primary key,
        thread_id text not null,
        sequence integer not null,
        payload text not null
      );

      create index if not exists idx_turns_thread_sequence
        on turns (thread_id, sequence);

      create table if not exists summaries (
        id text primary key,
        payload text not null
      );

      create table if not exists boxes (
        id text primary key,
        payload text not null
      );

      create table if not exists anchors (
        id text primary key,
        payload text not null
      );

      create table if not exists injections (
        id text primary key,
        host_session_id text not null,
        payload text not null
      );

      create index if not exists idx_injections_host_session
        on injections (host_session_id);

      create table if not exists proposals (
        id text primary key,
        state text not null,
        proposal_type text not null,
        payload text not null
      );

      create index if not exists idx_proposals_state_type
        on proposals (state, proposal_type);

      create table if not exists traces (
        id text primary key,
        state text not null,
        payload text not null
      );

      create index if not exists idx_traces_state
        on traces (state);

      create table if not exists local_sync_effects (
        id text primary key,
        person_id text not null,
        device_id text not null,
        device_sequence integer not null,
        payload text not null
      );

      create table if not exists sync_outbox (
        id text primary key,
        person_id text not null,
        device_id text not null,
        device_sequence integer not null,
        status text not null,
        row_version integer not null,
        payload text not null,
        unique (person_id, device_id, device_sequence)
      );

      create index if not exists idx_sync_outbox_person
        on sync_outbox (person_id, device_sequence);

      create table if not exists sync_frontiers (
        person_id text not null,
        device_id text not null,
        frontier_sequence integer not null,
        primary key (person_id, device_id)
      );

      create table if not exists pending_sync_gaps (
        person_id text not null,
        author_device_id text not null,
        missing_sequence integer not null,
        payload text not null,
        primary key (person_id, author_device_id, missing_sequence)
      );

      create table if not exists accepted_sync_operations (
        id text primary key,
        person_id text not null,
        author_device_id text not null,
        sequence integer not null,
        payload text not null,
        unique (person_id, author_device_id, sequence)
      );

      create index if not exists idx_accepted_sync_operations_person
        on accepted_sync_operations (person_id, sequence);

      create table if not exists sync_conflicts (
        id text primary key,
        person_id text not null,
        payload text not null
      );

      create table if not exists sync_tombstones (
        id text primary key,
        person_id text not null,
        payload text not null
      );

      create table if not exists sync_quarantine (
        id text primary key,
        person_id text not null,
        payload text not null
      );

      create table if not exists sync_contraction_ranges (
        person_id text primary key,
        payload text not null
      );
    `);
    this.migrateDaemonContractionPayloads();
  }

  private migrateDaemonContractionPayloads(): void {
    this.database.exec("begin immediate");
    try {
      const jobRows = this.database.prepare(
        "select id, payload from daemon_contraction_job order by id asc"
      ).all() as Array<{ id: string; payload: string }>;
      const updateJob = this.database.prepare("update daemon_contraction_job set payload = ? where id = ?");
      for (const row of jobRows) {
        const raw = JSON.parse(row.payload) as Record<string, unknown>;
        const normalized = JSON.stringify(ContractionJobSchema.parse({
          ...raw,
          ...(!Object.prototype.hasOwnProperty.call(raw, "generation") ? { generation: 1 } : {}),
          ...(!Object.prototype.hasOwnProperty.call(raw, "lastProposalRunAt") ? { lastProposalRunAt: null } : {})
        }));
        if (normalized !== row.payload) updateJob.run(normalized, row.id);
      }

      const checkpointRows = this.database.prepare(
        "select id, person_id, payload from daemon_contraction_checkpoint order by id asc"
      ).all() as Array<{ id: string; person_id: string; payload: string }>;
      const updateCheckpoint = this.database.prepare(
        "update daemon_contraction_checkpoint set payload = ? where id = ?"
      );
      for (const row of checkpointRows) {
        const raw = JSON.parse(row.payload) as Record<string, unknown>;
        const processedThroughOrderKey = Object.prototype.hasOwnProperty.call(raw, "processedThroughOrderKey")
          ? raw.processedThroughOrderKey
          : this.reconstructProcessedThroughOrderKey(row.person_id, raw.nextOrderKey);
        const normalized = JSON.stringify(ContractionCheckpointSchema.parse({ ...raw, processedThroughOrderKey }));
        if (normalized !== row.payload) updateCheckpoint.run(normalized, row.id);
      }
      this.database.exec("commit");
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
  }

  private reconstructProcessedThroughOrderKey(personId: string, nextOrderKey: unknown): CanonicalOrderKey | null {
    const next = nextOrderKey === null || nextOrderKey === undefined
      ? null
      : CanonicalOrderKeySchema.parse(nextOrderKey);
    const row = next
      ? this.database.prepare(
          `select occurred_at as occurredAt, native_sequence as nativeSequence, id
           from canonical_events
           where person_id = ? and (
             occurred_at < ? or
             (occurred_at = ? and native_sequence < ?) or
             (occurred_at = ? and native_sequence = ? and id < ?)
           )
           order by occurred_at desc, native_sequence desc, id desc
           limit 1`
        ).get(
          personId,
          next.occurredAt,
          next.occurredAt,
          next.nativeSequence,
          next.occurredAt,
          next.nativeSequence,
          next.id
        )
      : this.database.prepare(
          `select occurred_at as occurredAt, native_sequence as nativeSequence, id
           from canonical_events where person_id = ?
           order by occurred_at desc, native_sequence desc, id desc limit 1`
        ).get(personId);
    if (!row) return null;
    const key = row as { occurredAt: string; nativeSequence: number; id: string };
    return { occurredAt: key.occurredAt, nativeSequence: key.nativeSequence, id: key.id };
  }

  private upsertPayload(
    tableName: "people" | "summaries" | "boxes" | "anchors",
    item: { id: string }
  ): void {
    this.database
      .prepare(
        `insert into ${tableName} (id, payload)
         values (?, ?)
         on conflict(id) do update set payload = excluded.payload`
      )
      .run(item.id, JSON.stringify(item));
  }

  private listPayloads<T>(
    tableName: "summaries" | "boxes" | "anchors",
    schema: { parse(value: unknown): T }
  ): T[] {
    const rows = this.database
      .prepare(`select payload from ${tableName} order by id asc`)
      .all() as PayloadRow[];

    return rows.map((row) => schema.parse(JSON.parse(row.payload)));
  }

  private getPayload<T>(
    tableName: "people" | "memory_sources" | "import_checkpoints" | "bootstrap_checkpoints" | "source_grants" | "quarantine_records" | "summaries" | "boxes" | "anchors" | "daemon_source_state" | "daemon_import_receipt" | "daemon_contraction_job" | "daemon_contraction_checkpoint",
    id: string,
    schema: { parse(value: unknown): T }
  ): T | null {
    const row = this.database
      .prepare(`select payload from ${tableName} where id = ?`)
      .get(id) as PayloadRow | undefined;

    return row ? schema.parse(JSON.parse(row.payload)) : null;
  }

  private assertPersonOwnership<T extends { id: string; personId: string }>(
    existing: T | null,
    replacement: T
  ): void {
    if (existing && existing.personId !== replacement.personId) {
      throw new Error(`Cannot reassign ${replacement.id} to a different person`);
    }
  }

  private deleteIds(
    tableName: "memory_sources" | "canonical_events" | "import_checkpoints" | "bootstrap_checkpoints" | "quarantine_records" | "turns" | "anchors" | "injections",
    ids: string[]
  ): void {
    const statement = this.database.prepare(`delete from ${tableName} where id = ?`);
    for (const id of ids) statement.run(id);
  }
}
