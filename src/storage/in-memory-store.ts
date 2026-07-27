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
import {
  CanonicalEventSchema,
  MemorySourceSchema,
  PersonSchema,
  type CanonicalEvent,
  type MemorySource,
  type Person
} from "../domain/canonical.js";
import type {
  FindNearestSummariesQuery,
  MemoryStore,
  ProposalFilter,
  SummaryFilter,
  SummaryVectorMatch,
  SummaryVectorRecord,
  TraceFilter
} from "./memory-store.js";
import { cosineSimilarity } from "../embeddings/embedder.js";
import { isRetrievableState } from "../retrieval/retrievable-state.js";
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
  CommitSupersededSummaryPruneInputSchema,
  SupersededSummaryPruneReceiptSchema,
  proposalDecisionStateMatches,
  type CommitHistoryImportInput,
  type CommitProposalDecisionInput,
  type CommitSourceDeletionInput,
  type CommitSourceRevocationInput,
  type CommitSupersededSummaryPruneInput,
  type MutationCommitReceipt,
  type SupersededSummaryPruneReceipt,
  type SupersededSummaryPruneSkipReason
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
  type LocalSyncEffectRecord,
  type PendingSyncGap,
  type SealClaimedOutboxEnvelopeInput,
  type SealOutboxResult,
  type SyncCommitReceipt,
  type SyncConflictRecord,
  type SyncContractionRange,
  type SyncOutboxOperation,
  type SyncQuarantineEntry,
  type SyncTombstone
} from "./sync-contracts.js";

interface FaultInjector {
  reach(boundary: string): void;
}

export interface InMemoryStoreOptions {
  faultInjector?: FaultInjector;
  clock?: { now(): string };
}

export class InMemoryStore implements MemoryStore {
  private readonly faultInjector?: FaultInjector;
  private readonly clock: { now(): string };
  private readonly daemonLeases: DaemonLease[] = [];
  private readonly daemonSourceStates: DaemonSourceState[] = [];
  private readonly importBatchReceipts: ImportBatchReceipt[] = [];
  private readonly contractionJobs: ContractionJob[] = [];
  private readonly contractionCheckpoints: ContractionCheckpoint[] = [];
  private readonly people: Person[] = [];
  private readonly sources: MemorySource[] = [];
  private readonly canonicalEvents: CanonicalEvent[] = [];
  private readonly importCheckpoints: ImportCheckpoint[] = [];
  private readonly sourceGrants: SourceGrant[] = [];
  private readonly sourceLifecycleAuditEvents: SourceLifecycleAuditEvent[] = [];
  private readonly quarantineRecords: QuarantineRecord[] = [];
  private readonly bootstrapCheckpoints: HistoricalBootstrapCheckpoint[] = [];
  private readonly turns: Turn[] = [];
  private readonly summaries: Summary[] = [];
  private readonly boxes: Box[] = [];
  private readonly anchors: Anchor[] = [];
  private readonly injections: InjectionPacket[] = [];
  private readonly proposals: MemoryProposal[] = [];
  private readonly traces: MemoryTrace[] = [];
  private readonly localSyncEffects: LocalSyncEffectRecord[] = [];
  private readonly syncOutbox: SyncOutboxOperation[] = [];
  private readonly syncFrontiers: Array<{ personId: string; deviceId: string; frontierSequence: number }> = [];
  private readonly pendingSyncGaps: PendingSyncGap[] = [];
  private readonly acceptedSyncOperations: AcceptedSyncOperation[] = [];
  private readonly syncConflicts: SyncConflictRecord[] = [];
  private readonly syncTombstones: SyncTombstone[] = [];
  private readonly syncQuarantine: SyncQuarantineEntry[] = [];
  private readonly syncContractionRanges: SyncContractionRange[] = [];
  private readonly summaryVectors: SummaryVectorRecord[] = [];

  constructor(options: InMemoryStoreOptions = {}) {
    this.faultInjector = options.faultInjector;
    this.clock = options.clock ?? { now: () => new Date().toISOString() };
  }

  async acquireDaemonLease(input: {
    databaseId: string;
    ownerToken: string;
    pid: number;
    now: string;
  }): Promise<DaemonLease | null> {
    const now = new Date(input.now);
    if (Number.isNaN(now.getTime())) throw new Error("Invalid daemon lease timestamp");
    const existing = this.daemonLeases.find((lease) => lease.databaseId === input.databaseId);
    if (existing && existing.ownerToken !== input.ownerToken && Date.parse(existing.expiresAt) > now.getTime()) {
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
    const index = this.daemonLeases.findIndex((candidate) => candidate.databaseId === lease.databaseId);
    if (index === -1) this.daemonLeases.push(structuredClone(lease));
    else this.daemonLeases[index] = structuredClone(lease);
    return structuredClone(lease);
  }

  async getDaemonLease(databaseId: string): Promise<DaemonLease | null> {
    return structuredClone(this.daemonLeases.find((lease) => lease.databaseId === databaseId) ?? null);
  }

  async heartbeatDaemonLease(databaseId: string, ownerToken: string, now: string): Promise<DaemonLease | null> {
    const lease = this.daemonLeases.find((candidate) => candidate.databaseId === databaseId);
    if (!lease || lease.ownerToken !== ownerToken) return null;
    const parsedNow = new Date(now);
    if (Number.isNaN(parsedNow.getTime())) throw new Error("Invalid daemon heartbeat timestamp");
    if (Date.parse(lease.expiresAt) <= parsedNow.getTime()) return null;
    const next = DaemonLeaseSchema.parse({
      ...lease,
      heartbeatAt: now,
      expiresAt: new Date(parsedNow.getTime() + DEFAULT_DAEMON_DURATIONS.leaseExpiryMs).toISOString()
    });
    Object.assign(lease, structuredClone(next));
    return structuredClone(next);
  }

  async requestDaemonStop(databaseId: string, ownerToken: string, now: string): Promise<boolean> {
    const lease = this.daemonLeases.find((candidate) => candidate.databaseId === databaseId);
    if (!lease || lease.ownerToken !== ownerToken) return false;
    if (Date.parse(lease.expiresAt) <= Date.parse(now)) return false;
    lease.stopRequestedAt = DaemonLeaseSchema.shape.stopRequestedAt.parse(now);
    return true;
  }

  async releaseDaemonLease(databaseId: string, ownerToken: string): Promise<boolean> {
    const index = this.daemonLeases.findIndex((lease) =>
      lease.databaseId === databaseId && lease.ownerToken === ownerToken
    );
    if (index === -1) return false;
    this.daemonLeases.splice(index, 1);
    return true;
  }

  async saveDaemonSourceState(state: DaemonSourceState): Promise<void> {
    const parsed = DaemonSourceStateSchema.parse(state);
    this.assertDaemonStateGrant(parsed);
    this.assertPersonOwnership(this.daemonSourceStates, parsed);
    this.upsertById(this.daemonSourceStates, structuredClone(parsed));
  }

  async getDaemonSourceState(id: string): Promise<DaemonSourceState | null> {
    return structuredClone(this.daemonSourceStates.find((state) => state.id === id) ?? null);
  }

  async listDaemonSourceStates(personId: string): Promise<DaemonSourceState[]> {
    return structuredClone(this.daemonSourceStates
      .filter((state) => state.personId === personId)
      .sort((left, right) => left.id.localeCompare(right.id)));
  }

  async reconcileDaemonSourceStates(personId: string, now: string): Promise<DaemonSourceState[]> {
    DaemonSourceStateSchema.shape.updatedAt.parse(now);
    const approved = this.sourceGrants
      .filter((grant) => grant.personId === personId && grant.state === "approved")
      .sort((left, right) => left.id.localeCompare(right.id));
    const current = this.daemonSourceStates.filter((state) => state.personId === personId);
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

    const staged = this.daemonSourceStates
      .filter((state) => state.personId !== personId)
      .map((state) => structuredClone(state));
    staged.push(...reconciled.map((state) => structuredClone(state)));
    this.daemonSourceStates.splice(0, this.daemonSourceStates.length, ...staged);
    return structuredClone(reconciled.sort((left, right) => left.id.localeCompare(right.id)));
  }

  async getImportBatchReceipt(id: string): Promise<ImportBatchReceipt | null> {
    return structuredClone(this.importBatchReceipts.find((receipt) => receipt.id === id) ?? null);
  }

  async listImportBatchReceipts(personId: string): Promise<ImportBatchReceipt[]> {
    return structuredClone(this.importBatchReceipts
      .filter((receipt) => receipt.personId === personId)
      .sort((left, right) => left.id.localeCompare(right.id)));
  }

  async saveContractionJob(job: ContractionJob): Promise<void> {
    const parsed = ContractionJobSchema.parse(job);
    this.assertPersonOwnership(this.contractionJobs, parsed);
    this.upsertById(this.contractionJobs, structuredClone(parsed));
  }

  async getContractionJob(id: string): Promise<ContractionJob | null> {
    return structuredClone(this.contractionJobs.find((job) => job.id === id) ?? null);
  }

  async listContractionJobs(personId: string): Promise<ContractionJob[]> {
    return structuredClone(this.contractionJobs
      .filter((job) => job.personId === personId)
      .sort((left, right) => left.nextDueAt.localeCompare(right.nextDueAt) || left.id.localeCompare(right.id)));
  }

  async saveContractionCheckpoint(checkpoint: ContractionCheckpoint): Promise<void> {
    const parsed = ContractionCheckpointSchema.parse(checkpoint);
    this.assertPersonOwnership(this.contractionCheckpoints, parsed);
    const job = this.contractionJobs.find((candidate) => candidate.id === parsed.jobId);
    if (!job || job.personId !== parsed.personId) throw new Error("Contraction checkpoint job ownership mismatch");
    this.upsertById(this.contractionCheckpoints, structuredClone(parsed));
  }

  async getContractionCheckpoint(id: string): Promise<ContractionCheckpoint | null> {
    return structuredClone(this.contractionCheckpoints.find((checkpoint) => checkpoint.id === id) ?? null);
  }

  async commitHistoryImport(input: CommitHistoryImportInput): Promise<MutationCommitReceipt> {
    const parsed = CommitHistoryImportInputSchema.parse(input);
    const sourceId = parsed.expectedSource?.id ?? parsed.nextSources[0]?.id;
    const currentSource = sourceId ? this.sources.find((item) => item.id === sourceId) ?? null : null;
    const currentCheckpoint = this.importCheckpoints.find((item) => item.id === parsed.nextCheckpoint.id) ?? null;
    const currentGrant = this.sourceGrants.find((item) => item.id === parsed.expectedGrant.id) ?? null;
    const occupiedTargetIds = this.canonicalEvents.filter((item) => parsed.targetCanonicalEventIds.includes(item.id));
    if (!this.sameRecord(currentSource, parsed.expectedSource) ||
        !this.sameRecord(currentCheckpoint, parsed.expectedCheckpoint) ||
        !this.sameRecord(currentGrant, parsed.expectedGrant) || occupiedTargetIds.length > 0) {
      return this.stateChanged(parsed.receipt);
    }
    const staged = {
      sources: structuredClone(this.sources), canonicalEvents: structuredClone(this.canonicalEvents),
      checkpoints: structuredClone(this.importCheckpoints), audits: structuredClone(this.sourceLifecycleAuditEvents)
    };
    this.faultInjector?.reach("history_import_before_write");
    for (const item of parsed.nextSources) this.stageOwnedUpsert(staged.sources, item);
    this.faultInjector?.reach("history_import_after_sources");
    for (const item of parsed.nextCanonicalEvents) this.stageOwnedUpsert(staged.canonicalEvents, item);
    this.faultInjector?.reach("history_import_after_events");
    this.stageOwnedUpsert(staged.checkpoints, parsed.nextCheckpoint);
    this.faultInjector?.reach("history_import_after_checkpoint");
    for (const item of parsed.auditEvents) this.stageOwnedUpsert(staged.audits, item);
    this.replace(this.sources, staged.sources);
    this.replace(this.canonicalEvents, staged.canonicalEvents);
    this.replace(this.importCheckpoints, staged.checkpoints);
    this.replace(this.sourceLifecycleAuditEvents, staged.audits);
    return structuredClone(parsed.receipt);
  }

  async commitProposalDecision(input: CommitProposalDecisionInput): Promise<MutationCommitReceipt> {
    const parsed = CommitProposalDecisionInputSchema.parse(input);
    const current = this.proposals.find((item) => item.id === parsed.expectedProposal.id) ?? null;
    const currentSummaries = parsed.expectedSummaries.flatMap((expected) => {
      const value = this.summaries.find((item) => item.id === expected.id);
      return value ? [structuredClone(value)] : [];
    });
    const currentBoxes = parsed.expectedBoxes.map(({ id }) => ({
      id,
      value: structuredClone(this.boxes.find((item) => item.id === id) ?? null)
    }));
    const currentTraces = parsed.expectedTraces.map(({ id }) => ({
      id,
      value: structuredClone(this.traces.find((item) => item.id === id) ?? null)
    }));
    if (!proposalDecisionStateMatches(parsed, {
      proposal: current,
      summaries: currentSummaries,
      boxes: currentBoxes,
      traces: currentTraces
    })) return this.stateChanged(parsed.receipt);
    const staged = { boxes: structuredClone(this.boxes), traces: structuredClone(this.traces), proposals: structuredClone(this.proposals) };
    this.faultInjector?.reach("proposal_decision_before_write");
    for (const item of parsed.nextBoxes) this.stageDerivedUpsert(staged.boxes, item, parsed.personId);
    this.faultInjector?.reach("proposal_decision_after_boxes");
    for (const item of parsed.nextTraces) this.stageDerivedUpsert(staged.traces, item, parsed.personId);
    this.faultInjector?.reach("proposal_decision_after_traces");
    this.stageDerivedUpsert(staged.proposals, parsed.nextProposal, parsed.personId);
    this.faultInjector?.reach("proposal_decision_after_proposal");
    this.replace(this.boxes, staged.boxes);
    this.replace(this.traces, staged.traces);
    this.replace(this.proposals, staged.proposals);
    return structuredClone(parsed.receipt);
  }

  async commitSourceRevocation(input: CommitSourceRevocationInput): Promise<MutationCommitReceipt> {
    const parsed = CommitSourceRevocationInputSchema.parse(input);
    const current = this.sourceGrants.find((item) => item.id === parsed.expectedGrant.id) ?? null;
    if (!this.sameRecord(current, parsed.expectedGrant)) return this.stateChanged(parsed.receipt);
    const grants = structuredClone(this.sourceGrants);
    const audits = structuredClone(this.sourceLifecycleAuditEvents);
    this.faultInjector?.reach("source_revocation_before_write");
    this.stageOwnedUpsert(grants, parsed.nextGrant);
    this.faultInjector?.reach("source_revocation_after_grant");
    this.stageOwnedUpsert(audits, parsed.auditEvent);
    this.faultInjector?.reach("source_revocation_after_audit");
    this.replace(this.sourceGrants, grants);
    this.replace(this.sourceLifecycleAuditEvents, audits);
    return structuredClone(parsed.receipt);
  }

  async commitSourceDeletion(input: CommitSourceDeletionInput): Promise<MutationCommitReceipt> {
    const parsed = CommitSourceDeletionInputSchema.parse(input);
    const grant = this.sourceGrants.find((item) => item.id === parsed.expectedGrant.id) ?? null;
    if (!this.sameRecord(grant, parsed.expectedGrant) || !this.sourceDeletionEffectsMatch(parsed)) {
      return this.stateChanged(parsed.receipt);
    }
    const staged = {
      sources: structuredClone(this.sources), canonicalEvents: structuredClone(this.canonicalEvents),
      turns: structuredClone(this.turns), anchors: structuredClone(this.anchors), injections: structuredClone(this.injections),
      quarantine: structuredClone(this.quarantineRecords), bootstrap: structuredClone(this.bootstrapCheckpoints),
      summaries: structuredClone(this.summaries), boxes: structuredClone(this.boxes), proposals: structuredClone(this.proposals),
      traces: structuredClone(this.traces), audits: structuredClone(this.sourceLifecycleAuditEvents)
    };
    this.faultInjector?.reach("source_deletion_before_write");
    for (const item of parsed.nextSummaries) this.stageDerivedUpsert(staged.summaries, item, parsed.personId);
    for (const item of parsed.nextBoxes) this.stageDerivedUpsert(staged.boxes, item, parsed.personId);
    for (const item of parsed.nextProposals) this.stageDerivedUpsert(staged.proposals, item, parsed.personId);
    for (const item of parsed.nextTraces) this.stageDerivedUpsert(staged.traces, item, parsed.personId);
    this.faultInjector?.reach("source_deletion_after_supersessions");
    this.removeByIds(staged.injections, parsed.effects.injectionIds);
    this.faultInjector?.reach("source_deletion_after_injections");
    this.removeByIds(staged.anchors, parsed.effects.anchorIds);
    this.faultInjector?.reach("source_deletion_after_anchors");
    this.removeByIds(staged.turns, parsed.effects.turnIds);
    this.faultInjector?.reach("source_deletion_after_turns");
    this.removeByIds(staged.canonicalEvents, parsed.effects.canonicalEventIds);
    this.faultInjector?.reach("source_deletion_after_events");
    this.removeByIds(staged.sources, parsed.effects.sourceIds);
    this.faultInjector?.reach("source_deletion_after_sources");
    this.removeByIds(staged.quarantine, parsed.effects.quarantineIds);
    this.faultInjector?.reach("source_deletion_after_quarantine");
    this.removeByIds(staged.bootstrap, parsed.effects.bootstrapCheckpointIds);
    this.faultInjector?.reach("source_deletion_after_checkpoint");
    for (const item of parsed.auditEvents) this.stageOwnedUpsert(staged.audits, item);
    this.faultInjector?.reach("source_deletion_after_audits");
    this.replace(this.sources, staged.sources); this.replace(this.canonicalEvents, staged.canonicalEvents);
    this.replace(this.turns, staged.turns); this.replace(this.anchors, staged.anchors); this.replace(this.injections, staged.injections);
    this.replace(this.quarantineRecords, staged.quarantine); this.replace(this.bootstrapCheckpoints, staged.bootstrap);
    this.replace(this.summaries, staged.summaries); this.replace(this.boxes, staged.boxes);
    this.replace(this.proposals, staged.proposals); this.replace(this.traces, staged.traces);
    this.replace(this.sourceLifecycleAuditEvents, staged.audits);
    return structuredClone(parsed.receipt);
  }

  async inspectSourceDeletionEffects(personId: string, candidateId: string, auditEventIds: string[]) {
    return structuredClone(this.computeSourceDeletionEffects(personId, candidateId, auditEventIds));
  }

  async commitImportBatch(input: CommitImportBatchInput): Promise<ImportBatchReceipt> {
    const parsed = CommitImportBatchInputSchema.parse(input);
    this.validateImportOwnership(parsed);
    this.assertWriteAuthority(parsed.authority, parsed.personId, "approved-import");
    this.faultInjector?.reach("before_grant_check");
    this.assertExactApprovedGrant(parsed);
    this.faultInjector?.reach("after_grant_check");
    this.validateImportReceipt(parsed);

    const staged = {
      sources: structuredClone(this.sources),
      canonicalEvents: structuredClone(this.canonicalEvents),
      turns: structuredClone(this.turns),
      quarantineRecords: structuredClone(this.quarantineRecords),
      importCheckpoints: structuredClone(this.importCheckpoints),
      receipts: structuredClone(this.importBatchReceipts),
      jobs: structuredClone(this.contractionJobs)
    };
    for (const source of parsed.sources) this.stageOwnedUpsert(staged.sources, source);
    for (const event of parsed.canonicalEvents) this.stageOwnedUpsert(staged.canonicalEvents, event);
    for (const turn of parsed.turns) this.stageTurnUpsert(staged.turns, turn, parsed.personId);
    for (const record of parsed.quarantineChanges) this.stageOwnedUpsert(staged.quarantineRecords, record);
    this.faultInjector?.reach("before_import_checkpoint");
    this.stageOwnedUpsert(staged.importCheckpoints, parsed.checkpoint);
    const existingReceipt = staged.receipts.find((receipt) => receipt.id === parsed.receipt.id);
    this.stageOwnedUpsert(staged.receipts, parsed.receipt);
    if (parsed.contractionJob) {
      const existingJob = staged.jobs.find((job) => job.id === parsed.contractionJob!.id);
      const checkpoint = this.contractionCheckpoints.find((candidate) =>
        candidate.jobId === parsed.contractionJob!.id && candidate.personId === parsed.personId
      ) ?? null;
      if (!existingReceipt || !this.sameRecord(existingReceipt, parsed.receipt)) {
        this.stageOwnedUpsert(staged.jobs, existingJob
          ? this.mergeContractionJobs(existingJob, parsed.contractionJob, checkpoint)
          : parsed.contractionJob);
      }
    }
    this.faultInjector?.reach("after_import_checkpoint");
    this.faultInjector?.reach("before_import_commit");
    this.replace(this.sources, staged.sources);
    this.replace(this.canonicalEvents, staged.canonicalEvents);
    this.replace(this.turns, staged.turns);
    this.replace(this.quarantineRecords, staged.quarantineRecords);
    this.replace(this.importCheckpoints, staged.importCheckpoints);
    this.replace(this.importBatchReceipts, staged.receipts);
    this.replace(this.contractionJobs, staged.jobs);
    return structuredClone(parsed.receipt);
  }

  async commitContractionSlice(input: CommitContractionSliceInput): Promise<ContractionCheckpoint> {
    const parsed = CommitContractionSliceInputSchema.parse(input);
    this.validateContractionOwnership(parsed);
    this.assertWriteAuthority(parsed.authority, parsed.personId, "historical-bootstrap");
    const existingJob = this.contractionJobs.find((job) => job.id === parsed.jobId);
    if (!existingJob || existingJob.personId !== parsed.personId) throw new Error("Contraction job ownership mismatch");
    const existingCheckpoint = this.contractionCheckpoints.find((checkpoint) => checkpoint.id === parsed.nextCheckpoint.id) ?? null;
    if (!this.sameRecord(existingCheckpoint, parsed.expectedCheckpoint)) {
      if (this.sameRecord(existingCheckpoint, parsed.nextCheckpoint) && this.sameRecord(existingJob, parsed.nextJob)) {
        return structuredClone(parsed.nextCheckpoint);
      }
      throw new Error("Contraction checkpoint changed");
    }
    const staged = {
      turns: structuredClone(this.turns),
      summaries: structuredClone(this.summaries),
      anchors: structuredClone(this.anchors),
      boxes: structuredClone(this.boxes),
      proposals: structuredClone(this.proposals),
      traces: structuredClone(this.traces),
      checkpoints: structuredClone(this.contractionCheckpoints),
      jobs: structuredClone(this.contractionJobs)
    };
    for (const turn of parsed.turns) this.stageTurnUpsert(staged.turns, turn, parsed.personId);
    for (const summary of parsed.summaries) this.stageDerivedUpsert(staged.summaries, summary, parsed.personId);
    for (const anchor of parsed.anchors) this.stageDerivedUpsert(staged.anchors, anchor, parsed.personId);
    for (const box of parsed.boxes) this.stageDerivedUpsert(staged.boxes, box, parsed.personId);
    for (const proposal of parsed.proposals) this.stageDerivedUpsert(staged.proposals, proposal, parsed.personId);
    for (const trace of parsed.traces) this.stageDerivedUpsert(staged.traces, trace, parsed.personId);
    this.applySupersessions(staged, parsed.supersessions);
    this.faultInjector?.reach("before_contraction_commit");
    this.stageOwnedUpsert(staged.checkpoints, parsed.nextCheckpoint);
    this.stageOwnedUpsert(staged.jobs, parsed.nextJob);
    this.faultInjector?.reach("after_contraction_checkpoint");
    this.replace(this.turns, staged.turns);
    this.replace(this.summaries, staged.summaries);
    this.replace(this.anchors, staged.anchors);
    this.replace(this.boxes, staged.boxes);
    this.replace(this.proposals, staged.proposals);
    this.replace(this.traces, staged.traces);
    this.replace(this.contractionCheckpoints, staged.checkpoints);
    this.replace(this.contractionJobs, staged.jobs);
    return structuredClone(parsed.nextCheckpoint);
  }

  async commitApprovedGrantReconciliation(
    input: CommitApprovedGrantReconciliationInput
  ): Promise<DaemonSourceState[]> {
    const parsed = CommitApprovedGrantReconciliationInputSchema.parse(input);
    this.assertFreshDaemonAuthority(parsed.authority);
    const approved = this.sourceGrants
      .filter((grant) => grant.personId === parsed.personId && grant.state === "approved")
      .map((grant) => ({
        id: grant.id, personId: grant.personId, candidateId: grant.candidateId,
        updatedAt: grant.updatedAt, scopeId: grant.scopeId, state: "approved" as const
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    if (!this.sameRecord(approved, [...parsed.expectedGrants].sort((left, right) => left.id.localeCompare(right.id)))) {
      throw new Error("Approved source grants changed");
    }
    const current = this.daemonSourceStates
      .filter((state) => state.personId === parsed.personId)
      .sort((left, right) => left.id.localeCompare(right.id));
    if (!this.sameRecord(current, [...parsed.expectedStates].sort((left, right) => left.id.localeCompare(right.id)))) {
      if (this.sameRecord(current, [...parsed.nextStates].sort((left, right) => left.id.localeCompare(right.id)))) {
        return structuredClone(parsed.nextStates);
      }
      throw new Error("Daemon source registry changed");
    }
    this.validateNextSourceStates(parsed.personId, parsed.nextStates, approved);
    const staged = this.daemonSourceStates.filter((state) => state.personId !== parsed.personId);
    staged.push(...structuredClone(parsed.nextStates));
    this.replace(this.daemonSourceStates, staged);
    return structuredClone(parsed.nextStates);
  }

  async commitDueSourceRefresh(input: CommitDueSourceRefreshInput): Promise<DaemonSourceState[]> {
    const parsed = CommitDueSourceRefreshInputSchema.parse(input);
    this.assertFreshDaemonAuthority(parsed.authority);
    const current = this.daemonSourceStates
      .filter((state) => state.personId === parsed.personId)
      .sort((left, right) => left.id.localeCompare(right.id));
    if (!this.sameRecord(current, [...parsed.expectedStates].sort((left, right) => left.id.localeCompare(right.id)))) {
      if (this.sameRecord(current, [...parsed.nextStates].sort((left, right) => left.id.localeCompare(right.id)))) {
        return structuredClone(parsed.nextStates);
      }
      throw new Error("Daemon source states changed");
    }
    this.validateNextSourceStates(parsed.personId, parsed.nextStates);
    const staged = structuredClone(this.daemonSourceStates);
    for (const state of parsed.nextStates) this.stageOwnedUpsert(staged, state);
    this.replace(this.daemonSourceStates, staged);
    return structuredClone(parsed.nextStates);
  }

  async commitSourceStateOutcome(input: CommitSourceStateOutcomeInput): Promise<DaemonSourceState> {
    const parsed = CommitSourceStateOutcomeInputSchema.parse(input);
    this.assertFreshDaemonAuthority(parsed.authority);
    const current = this.daemonSourceStates.find((state) => state.id === parsed.nextState.id) ?? null;
    if (!this.sameRecord(current, parsed.expectedState)) {
      if (this.sameRecord(current, parsed.nextState)) return structuredClone(parsed.nextState);
      throw new Error("Daemon source state changed");
    }
    if (parsed.nextState.personId !== parsed.personId || parsed.nextState.candidateId !== parsed.candidateId) {
      throw new Error("Daemon source outcome ownership mismatch");
    }
    this.validateNextSourceStates(parsed.personId, [parsed.nextState]);
    const staged = structuredClone(this.daemonSourceStates);
    this.stageOwnedUpsert(staged, parsed.nextState);
    this.replace(this.daemonSourceStates, staged);
    return structuredClone(parsed.nextState);
  }

  async commitProposalRun(input: CommitProposalRunInput): Promise<ContractionCheckpoint | null> {
    const parsed = CommitProposalRunInputSchema.parse(input);
    this.assertWriteAuthority(parsed.authority, parsed.personId, "historical-bootstrap");
    this.validateProposalRun(parsed);
    const currentJob = this.contractionJobs.find((job) => job.id === parsed.jobId) ?? null;
    const currentCheckpoint = parsed.nextCheckpoint
      ? this.contractionCheckpoints.find((checkpoint) => checkpoint.id === parsed.nextCheckpoint!.id) ?? null
      : null;
    if (!this.sameRecord(currentJob, parsed.expectedJob) || !this.sameRecord(currentCheckpoint, parsed.expectedCheckpoint)) {
      if (this.sameRecord(currentJob, parsed.nextJob) && this.sameRecord(currentCheckpoint, parsed.nextCheckpoint)) {
        return structuredClone(parsed.nextCheckpoint);
      }
      throw new Error("Proposal run state changed");
    }
    const boxes = structuredClone(this.boxes);
    const proposals = structuredClone(this.proposals);
    const traces = structuredClone(this.traces);
    const jobs = structuredClone(this.contractionJobs);
    const checkpoints = structuredClone(this.contractionCheckpoints);
    for (const box of parsed.boxes) this.stageDerivedUpsert(boxes, box, parsed.personId);
    for (const proposal of parsed.proposals) this.stageDerivedUpsert(proposals, proposal, parsed.personId);
    for (const trace of parsed.traces) this.stageDerivedUpsert(traces, trace, parsed.personId);
    this.stageOwnedUpsert(jobs, parsed.nextJob);
    if (parsed.nextCheckpoint) this.stageOwnedUpsert(checkpoints, parsed.nextCheckpoint);
    this.replace(this.boxes, boxes);
    this.replace(this.proposals, proposals);
    this.replace(this.traces, traces);
    this.replace(this.contractionJobs, jobs);
    this.replace(this.contractionCheckpoints, checkpoints);
    return structuredClone(parsed.nextCheckpoint);
  }

  async commitDaemonWorkOutcome(input: CommitDaemonWorkOutcomeInput): Promise<ContractionJob> {
    const parsed = CommitDaemonWorkOutcomeInputSchema.parse(input);
    this.assertFreshDaemonAuthority(parsed.authority);
    if (parsed.nextJob.personId !== parsed.personId || parsed.nextJob.id !== parsed.jobId) {
      throw new Error("Daemon work outcome ownership mismatch");
    }
    const current = this.contractionJobs.find((job) => job.id === parsed.jobId) ?? null;
    if (!this.sameRecord(current, parsed.expectedJob)) {
      if (this.sameRecord(current, parsed.nextJob)) return structuredClone(parsed.nextJob);
      throw new Error("Daemon work job changed");
    }
    const staged = structuredClone(this.contractionJobs);
    this.stageOwnedUpsert(staged, parsed.nextJob);
    this.replace(this.contractionJobs, staged);
    return structuredClone(parsed.nextJob);
  }

  async savePerson(person: Person): Promise<void> {
    this.upsertById(this.people, structuredClone(PersonSchema.parse(person)));
  }

  async getPerson(id: string): Promise<Person | null> {
    return structuredClone(this.people.find((person) => person.id === id) ?? null);
  }

  async listPeople(): Promise<Person[]> {
    return structuredClone([...this.people].sort((left, right) => left.id.localeCompare(right.id)));
  }

  async saveSource(source: MemorySource): Promise<void> {
    const parsed = MemorySourceSchema.parse(source);
    this.assertPersonOwnership(this.sources, parsed);
    this.upsertById(this.sources, structuredClone(parsed));
  }

  async getSource(id: string): Promise<MemorySource | null> {
    return structuredClone(this.sources.find((source) => source.id === id) ?? null);
  }

  async listSources(personId: string): Promise<MemorySource[]> {
    return structuredClone(this.sources
      .filter((source) => source.personId === personId)
      .sort((left, right) => left.id.localeCompare(right.id)));
  }

  async saveCanonicalEvent(event: CanonicalEvent): Promise<void> {
    const parsed = CanonicalEventSchema.parse(event);
    this.assertPersonOwnership(this.canonicalEvents, parsed);
    this.upsertById(this.canonicalEvents, structuredClone(parsed));
  }

  async listCanonicalEvents(personId: string): Promise<CanonicalEvent[]> {
    return structuredClone(this.canonicalEvents
      .filter((event) => event.personId === personId)
      .sort((left, right) =>
        left.occurredAt.localeCompare(right.occurredAt) ||
        left.nativeSequence - right.nativeSequence ||
        left.id.localeCompare(right.id)
      ));
  }

  async deleteCanonicalEvents(ids: string[]): Promise<void> {
    this.removeByIds(this.canonicalEvents, ids);
  }

  async deleteSources(ids: string[]): Promise<void> {
    this.removeByIds(this.sources, ids);
  }

  async saveImportCheckpoint(checkpoint: ImportCheckpoint): Promise<void> {
    const parsed = ImportCheckpointSchema.parse(checkpoint);
    this.assertPersonOwnership(this.importCheckpoints, parsed);
    this.upsertById(this.importCheckpoints, structuredClone(parsed));
  }

  async getImportCheckpoint(id: string): Promise<ImportCheckpoint | null> {
    return structuredClone(
      this.importCheckpoints.find((checkpoint) => checkpoint.id === id) ?? null
    );
  }

  async listImportCheckpoints(personId: string): Promise<ImportCheckpoint[]> {
    return structuredClone(this.importCheckpoints
      .filter((checkpoint) => checkpoint.personId === personId)
      .sort((left, right) => left.resourcePath.localeCompare(right.resourcePath)));
  }

  async deleteImportCheckpointsForCandidate(personId: string, candidateId: string): Promise<void> {
    const ids = this.importCheckpoints
      .filter((checkpoint) => checkpoint.personId === personId && checkpoint.candidateId === candidateId)
      .map((checkpoint) => checkpoint.id);
    this.removeByIds(this.importCheckpoints, ids);
  }

  async saveSourceGrant(grant: SourceGrant): Promise<void> {
    const parsed = SourceGrantSchema.parse(grant);
    this.assertPersonOwnership(this.sourceGrants, parsed);
    this.upsertById(this.sourceGrants, structuredClone(parsed));
  }

  async getSourceGrant(id: string): Promise<SourceGrant | null> {
    return structuredClone(this.sourceGrants.find((grant) => grant.id === id) ?? null);
  }

  async listSourceGrants(personId: string): Promise<SourceGrant[]> {
    return structuredClone(this.sourceGrants.filter((grant) => grant.personId === personId));
  }

  async saveSourceLifecycleAuditEvent(event: SourceLifecycleAuditEvent): Promise<void> {
    const parsed = SourceLifecycleAuditEventSchema.parse(event);
    this.assertPersonOwnership(this.sourceLifecycleAuditEvents, parsed);
    this.upsertById(this.sourceLifecycleAuditEvents, structuredClone(parsed));
  }

  async listSourceLifecycleAuditEvents(personId: string): Promise<SourceLifecycleAuditEvent[]> {
    return structuredClone(this.sourceLifecycleAuditEvents
      .filter((event) => event.personId === personId)
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id)));
  }

  async saveQuarantineRecord(record: QuarantineRecord): Promise<void> {
    const parsed = QuarantineRecordSchema.parse(record);
    this.assertPersonOwnership(this.quarantineRecords, parsed);
    this.upsertById(this.quarantineRecords, structuredClone(parsed));
  }

  async getQuarantineRecord(id: string): Promise<QuarantineRecord | null> {
    return structuredClone(this.quarantineRecords.find((record) => record.id === id) ?? null);
  }

  async listQuarantineRecords(personId: string, candidateId?: string): Promise<QuarantineRecord[]> {
    return structuredClone(this.quarantineRecords.filter((record) =>
      record.personId === personId && (candidateId === undefined || record.candidateId === candidateId)
    ));
  }

  async deleteQuarantineRecords(personId: string, candidateId: string): Promise<void> {
    const ids = this.quarantineRecords
      .filter((record) => record.personId === personId && record.candidateId === candidateId)
      .map((record) => record.id);
    this.removeByIds(this.quarantineRecords, ids);
  }

  async saveBootstrapCheckpoint(checkpoint: HistoricalBootstrapCheckpoint): Promise<void> {
    const parsed = HistoricalBootstrapCheckpointSchema.parse(checkpoint);
    this.assertPersonOwnership(this.bootstrapCheckpoints, parsed);
    this.upsertById(this.bootstrapCheckpoints, structuredClone(parsed));
  }

  async getBootstrapCheckpoint(id: string): Promise<HistoricalBootstrapCheckpoint | null> {
    return structuredClone(
      this.bootstrapCheckpoints.find((checkpoint) => checkpoint.id === id) ?? null
    );
  }

  async deleteBootstrapCheckpoint(id: string): Promise<void> {
    this.removeByIds(this.bootstrapCheckpoints, [id]);
  }

  async saveTurn(turn: Turn): Promise<void> {
    this.upsertById(this.turns, structuredClone(TurnSchema.parse(turn)));
  }

  async listTurns(threadId: string): Promise<Turn[]> {
    return this.turns
      .filter((turn) => turn.threadId === threadId)
      .sort((left, right) => left.sequence - right.sequence)
      .map((turn) => structuredClone(turn));
  }

  async deleteTurns(ids: string[]): Promise<void> {
    this.removeByIds(this.turns, ids);
  }

  async saveSummary(summary: Summary): Promise<void> {
    this.upsertById(this.summaries, structuredClone(SummarySchema.parse(summary)));
  }

  async listSummaries(filter?: SummaryFilter): Promise<Summary[]> {
    if (!filter) {
      return structuredClone(this.summaries);
    }

    const allowedScopeIds = filter.scopeIds ? new Set(filter.scopeIds) : null;
    const states = filter.states ? new Set(filter.states) : null;
    const filtered = this.summaries.filter((summary) => {
      if (filter.personId !== undefined && summary.personId !== filter.personId) return false;
      if (states && !states.has(summary.state)) return false;
      if (allowedScopeIds) {
        const inSubset = (summary.scopeIds ?? ["personal"]).every((scopeId) => allowedScopeIds.has(scopeId));
        if (!inSubset) return false;
      }
      return true;
    });
    return structuredClone(filtered);
  }

  /**
   * The only sanctioned removal path for pure derivations (Plan 11-11, GAP-11-A closure;
   * REQ-053/REQ-054). Mirrors SqliteStore.commitSupersededSummaryPrune exactly: same skip-reason
   * precedence (not_found, not_superseded, person_mismatch, then the four reference kinds), same
   * ascending receipt shape. In-memory arrays are mutated only after every eligibility decision
   * is made, so a fault-injected throw partway through leaves the store byte-for-byte unchanged --
   * the InMemoryStore analogue of SqliteStore's transaction rollback.
   */
  async commitSupersededSummaryPrune(input: CommitSupersededSummaryPruneInput): Promise<SupersededSummaryPruneReceipt> {
    const parsed = CommitSupersededSummaryPruneInputSchema.parse(input);
    const skipped: Array<{ summaryId: string; reason: SupersededSummaryPruneSkipReason }> = [];

    const boxReferenced = new Set(this.boxes.flatMap((box) => box.summaryIds));
    const traceReferenced = new Set(this.traces.flatMap((trace) => trace.summaryIds));
    const proposalReferenced = new Set(this.proposals.flatMap((proposal) => proposal.sourceSummaryIds));
    const summaryReferenced = new Set(this.summaries.flatMap((summary) => summary.sourceSummaryIds));

    const eligible: Summary[] = [];
    const uniqueIds = [...new Set(parsed.summaryIds)];
    for (const id of uniqueIds) {
      const summary = this.summaries.find((candidate) => candidate.id === id);
      if (!summary) {
        skipped.push({ summaryId: id, reason: "not_found" });
      } else if (summary.state !== "superseded") {
        skipped.push({ summaryId: id, reason: "not_superseded" });
      } else if (summary.personId !== parsed.personId) {
        skipped.push({ summaryId: id, reason: "person_mismatch" });
      } else if (boxReferenced.has(id)) {
        skipped.push({ summaryId: id, reason: "referenced_by_box" });
      } else if (traceReferenced.has(id)) {
        skipped.push({ summaryId: id, reason: "referenced_by_trace" });
      } else if (proposalReferenced.has(id)) {
        skipped.push({ summaryId: id, reason: "referenced_by_proposal" });
      } else if (summaryReferenced.has(id)) {
        skipped.push({ summaryId: id, reason: "referenced_by_summary" });
      } else {
        eligible.push(summary);
      }
    }

    let deletedVectorRows = 0;
    let freedPayloadBytes = 0;
    const deletedInjectionIds: string[] = [];
    const prunedSummaryIds: string[] = [];

    if (eligible.length > 0) {
      const eligibleIds = eligible.map((summary) => summary.id);
      const eligibleSet = new Set(eligibleIds);
      freedPayloadBytes = eligible.reduce((sum, summary) => sum + JSON.stringify(summary).length, 0);

      this.faultInjector?.reach("superseded_prune_before_write");
      const remainingVectors = this.summaryVectors.filter((record) => !eligibleSet.has(record.summaryId));
      deletedVectorRows = this.summaryVectors.length - remainingVectors.length;
      this.faultInjector?.reach("superseded_prune_after_vectors");

      const remainingInjections = this.injections.filter((packet) => {
        const referenced = packet.sourceSummaryIds.some((id) => eligibleSet.has(id));
        if (referenced) deletedInjectionIds.push(packet.id);
        return !referenced;
      });
      this.faultInjector?.reach("superseded_prune_after_injections");

      const remainingSummaries = this.summaries.filter((summary) => !eligibleSet.has(summary.id));
      prunedSummaryIds.push(...eligibleIds);

      this.replace(this.summaryVectors, remainingVectors);
      this.replace(this.injections, remainingInjections);
      this.replace(this.summaries, remainingSummaries);
    }

    return structuredClone(SupersededSummaryPruneReceiptSchema.parse({
      operation: "superseded_summary_prune",
      personId: parsed.personId,
      prunedSummaryIds,
      deletedVectorRows,
      deletedInjectionIds,
      freedPayloadBytes,
      skipped,
      committedAt: this.clock.now()
    }));
  }

  async listSupersededSummaryIds(personId: string, options: { limit: number; afterId?: string }): Promise<string[]> {
    const ids = this.summaries
      .filter((summary) => summary.personId === personId && summary.state === "superseded")
      .map((summary) => summary.id)
      .sort();
    const startIndex = options.afterId ? ids.findIndex((id) => id > options.afterId!) : 0;
    const from = startIndex === -1 ? ids.length : startIndex;
    return ids.slice(from, from + options.limit);
  }

  async summarizeSupersededSummaries(personId: string): Promise<{ count: number; payloadBytes: number }> {
    const matching = this.summaries.filter((summary) => summary.personId === personId && summary.state === "superseded");
    return {
      count: matching.length,
      payloadBytes: matching.reduce((sum, summary) => sum + JSON.stringify(summary).length, 0)
    };
  }

  async saveBox(box: Box): Promise<void> {
    this.upsertById(this.boxes, structuredClone(BoxSchema.parse(box)));
  }

  async getBox(id: string): Promise<Box | null> {
    return structuredClone(this.boxes.find((box) => box.id === id) ?? null);
  }

  async listBoxes(): Promise<Box[]> {
    return structuredClone(this.boxes);
  }

  async saveAnchor(anchor: Anchor): Promise<void> {
    this.upsertById(this.anchors, structuredClone(AnchorSchema.parse(anchor)));
  }

  async listAnchors(): Promise<Anchor[]> {
    return structuredClone(this.anchors);
  }

  async deleteAnchors(ids: string[]): Promise<void> {
    this.removeByIds(this.anchors, ids);
  }

  async saveInjection(packet: InjectionPacket): Promise<void> {
    this.upsertById(this.injections, structuredClone(InjectionPacketSchema.parse(packet)));
  }

  async listInjections(hostSessionId: string): Promise<InjectionPacket[]> {
    return this.injections
      .filter((packet) => packet.hostSessionId === hostSessionId)
      .map((packet) => structuredClone(packet));
  }

  async deleteInjectionsReferencingSummaryIds(summaryIds: string[]): Promise<void> {
    const targets = new Set(summaryIds);
    for (let index = this.injections.length - 1; index >= 0; index -= 1) {
      if (this.injections[index].sourceSummaryIds.some((id) => targets.has(id))) {
        this.injections.splice(index, 1);
      }
    }
  }

  async saveProposal(proposal: MemoryProposal): Promise<void> {
    this.upsertById(this.proposals, structuredClone(MemoryProposalSchema.parse(proposal)));
  }

  async getProposal(id: string): Promise<MemoryProposal | null> {
    return structuredClone(this.proposals.find((proposal) => proposal.id === id) ?? null);
  }

  async listProposals(filter: ProposalFilter = {}): Promise<MemoryProposal[]> {
    return structuredClone(this.proposals.filter((proposal) =>
      (filter.state === undefined || proposal.state === filter.state) &&
      (filter.proposalType === undefined || proposal.proposalType === filter.proposalType)
    ));
  }

  async saveTrace(trace: MemoryTrace): Promise<void> {
    this.upsertById(this.traces, structuredClone(MemoryTraceSchema.parse(trace)));
  }

  async getTrace(id: string): Promise<MemoryTrace | null> {
    return structuredClone(this.traces.find((trace) => trace.id === id) ?? null);
  }

  async listTraces(filter: TraceFilter = {}): Promise<MemoryTrace[]> {
    return structuredClone(this.traces.filter((trace) =>
      filter.state === undefined || trace.state === filter.state
    ));
  }

  async saveSummaryVector(record: SummaryVectorRecord): Promise<void> {
    if (record.dimensions !== record.vector.length) {
      throw new Error(
        `saveSummaryVector: dimensions (${record.dimensions}) !== vector.length (${record.vector.length}) for summary ${record.summaryId}`
      );
    }
    if (!record.vector.every((value) => Number.isFinite(Math.fround(value)))) {
      throw new Error(`saveSummaryVector: vector contains a non-finite value for summary ${record.summaryId}`);
    }
    const existingIndex = this.summaryVectors.findIndex(
      (candidate) =>
        candidate.summaryId === record.summaryId &&
        candidate.provider === record.provider &&
        candidate.model === record.model
    );
    const clone = structuredClone(record);
    if (existingIndex === -1) {
      this.summaryVectors.push(clone);
      return;
    }
    this.summaryVectors[existingIndex] = clone;
  }

  /**
   * Loop-equivalent batch write (Phase 10 backfill throughput). InMemoryStore has no transaction
   * semantics, so this simply delegates each record to `saveSummaryVector`, reusing its exact
   * validation/upsert behavior rather than duplicating it.
   */
  async saveSummaryVectors(records: SummaryVectorRecord[]): Promise<void> {
    for (const record of records) {
      await this.saveSummaryVector(record);
    }
  }

  async getSummaryVector(summaryId: string, provider: string, model: string): Promise<SummaryVectorRecord | null> {
    return structuredClone(
      this.summaryVectors.find(
        (candidate) => candidate.summaryId === summaryId && candidate.provider === provider && candidate.model === model
      ) ?? null
    );
  }

  async listSummaryIdsMissingVector(provider: string, model: string): Promise<string[]> {
    const covered = new Set(
      this.summaryVectors
        .filter((candidate) => candidate.provider === provider && candidate.model === model)
        .map((candidate) => candidate.summaryId)
    );
    return this.summaries
      .map((summary) => summary.id)
      .filter((summaryId) => !covered.has(summaryId))
      .sort();
  }

  async findNearestSummaries(query: FindNearestSummariesQuery): Promise<SummaryVectorMatch[]> {
    // GAP-11-A sweep (T-11-26, T-11-27): identical semantics to SqliteStore.findNearestSummaries
    // -- a vector row whose summary is absent or non-retrievable is dropped, computed once per
    // call from `this.summaries`, never once per candidate row.
    const retrievableSummaryIds = new Set(
      this.summaries
        .filter((summary) => summary.personId === query.personId && isRetrievableState(summary.state))
        .map((summary) => summary.id)
    );

    const allowedSet = new Set(query.allowedScopeIds);
    const candidates = this.summaryVectors.filter(
      (record) =>
        record.provider === query.provider &&
        record.model === query.model &&
        record.personId === query.personId &&
        record.dimensions === query.vector.length &&
        retrievableSummaryIds.has(record.summaryId) &&
        (record.scopeIds.length ? record.scopeIds : ["personal"]).every((scopeId) => allowedSet.has(scopeId))
    );
    const scored: SummaryVectorMatch[] = candidates.map((record) => ({
      summaryId: record.summaryId,
      score: cosineSimilarity(query.vector, record.vector)
    }));
    scored.sort(
      (left, right) =>
        right.score - left.score ||
        (left.summaryId < right.summaryId ? -1 : left.summaryId > right.summaryId ? 1 : 0)
    );
    const filtered =
      query.minimumScore === undefined ? scored : scored.filter((match) => match.score >= query.minimumScore!);
    return filtered.slice(0, query.topK);
  }

  async deleteSummaryVectors(summaryIds: string[]): Promise<void> {
    const targets = new Set(summaryIds);
    for (let index = this.summaryVectors.length - 1; index >= 0; index -= 1) {
      if (targets.has(this.summaryVectors[index].summaryId)) this.summaryVectors.splice(index, 1);
    }
  }

  async commitLocalSyncOperation(input: CommitLocalSyncOperationInput): Promise<SyncCommitReceipt> {
    const parsed = CommitLocalSyncOperationInputSchema.parse(input);
    const existingOutbox = this.syncOutbox.find((row) =>
      row.personId === parsed.personId && row.deviceId === parsed.deviceId && row.deviceSequence === parsed.deviceSequence
    );
    if (existingOutbox) {
      const identical = existingOutbox.id === parsed.outboxId &&
        existingOutbox.operationKind === parsed.operationKind &&
        existingOutbox.targetId === parsed.targetId &&
        existingOutbox.predecessorDigest === parsed.predecessorDigest &&
        existingOutbox.effectFingerprint === parsed.effectFingerprint;
      return structuredClone({ ...parsed.receipt, status: identical ? "IDEMPOTENT" : "EQUIVOCATION" });
    }
    const frontier = this.frontierFor(parsed.personId, parsed.deviceId);
    if (frontier !== parsed.expectedFrontierSequence) {
      return this.syncStateChanged(parsed.receipt);
    }
    const effects = structuredClone(this.localSyncEffects);
    const outbox = structuredClone(this.syncOutbox);
    this.faultInjector?.reach("local_sync_before_effect");
    effects.push(LocalSyncEffectRecordSchema.parse({
      id: `${parsed.outboxId}_effect`,
      personId: parsed.personId,
      deviceId: parsed.deviceId,
      operationKind: parsed.operationKind,
      targetId: parsed.targetId,
      deviceSequence: parsed.deviceSequence,
      effectFingerprint: parsed.effectFingerprint,
      committedAt: parsed.committedAt
    }));
    this.faultInjector?.reach("local_sync_after_effect");
    outbox.push(SyncOutboxOperationSchema.parse({
      id: parsed.outboxId,
      personId: parsed.personId,
      deviceId: parsed.deviceId,
      operationKind: parsed.operationKind,
      targetId: parsed.targetId,
      deviceSequence: parsed.deviceSequence,
      predecessorDigest: parsed.predecessorDigest,
      effectFingerprint: parsed.effectFingerprint,
      status: "pending",
      rowVersion: 0,
      createdAt: parsed.committedAt,
      sealedProtocolVersion: null,
      sealedSequence: null,
      sealedPredecessorDigest: null,
      sealedEnvelopeBytesBase64: null,
      sealedEnvelopeDigest: null,
      sealedAt: null
    }));
    this.faultInjector?.reach("local_sync_after_outbox");
    this.replace(this.localSyncEffects, effects);
    this.replace(this.syncOutbox, outbox);
    this.setFrontier(parsed.personId, parsed.deviceId, parsed.deviceSequence);
    return structuredClone(parsed.receipt);
  }

  async commitRemoteSyncApply(input: CommitRemoteSyncApplyInput): Promise<SyncCommitReceipt> {
    const parsed = CommitRemoteSyncApplyInputSchema.parse(input);
    const frontier = this.frontierFor(parsed.personId, parsed.authorDeviceId);
    if (parsed.sequence <= frontier) {
      const existing = this.acceptedSyncOperations.find((op) =>
        op.personId === parsed.personId && op.authorDeviceId === parsed.authorDeviceId && op.sequence === parsed.sequence
      );
      const identical = existing !== undefined && existing.envelopeDigest === parsed.envelopeDigest &&
        existing.effectFingerprint === parsed.effectFingerprint;
      return structuredClone({ ...parsed.receipt, status: identical ? "IDEMPOTENT" : "EQUIVOCATION" });
    }
    if (parsed.sequence > frontier + MAX_RETAINED_GAP_SLOTS) {
      // ADR 0047 "Data Plane, Replay, and Equivocation": at most MAX_RETAINED_GAP_SLOTS future
      // sequence slots (or a maximum jump of that size) are retained per device. A single
      // validly-signed high-sequence envelope must not drive proportional allocation of one
      // PendingSyncGap per intervening slot, so classify as bounded and return before the loop.
      return structuredClone({ ...parsed.receipt, status: "GAP_PENDING" });
    }
    if (parsed.sequence > frontier + 1) {
      const gaps = structuredClone(this.pendingSyncGaps);
      for (let missing = frontier + 1; missing < parsed.sequence; missing += 1) {
        if (!gaps.some((gap) => gap.personId === parsed.personId && gap.authorDeviceId === parsed.authorDeviceId && gap.missingSequence === missing)) {
          gaps.push(PendingSyncGapSchema.parse({
            personId: parsed.personId, authorDeviceId: parsed.authorDeviceId, missingSequence: missing, detectedAt: parsed.appliedAt
          }));
        }
      }
      this.replace(this.pendingSyncGaps, gaps);
      return structuredClone({ ...parsed.receipt, status: "GAP_PENDING" });
    }
    const staged = {
      accepted: structuredClone(this.acceptedSyncOperations),
      conflicts: structuredClone(this.syncConflicts),
      tombstones: structuredClone(this.syncTombstones),
      quarantine: structuredClone(this.syncQuarantine),
      ranges: structuredClone(this.syncContractionRanges)
    };
    this.faultInjector?.reach("remote_apply_before_write");
    staged.accepted.push(AcceptedSyncOperationSchema.parse({
      id: `${parsed.personId}_${parsed.authorDeviceId}_${parsed.sequence}`,
      personId: parsed.personId,
      authorDeviceId: parsed.authorDeviceId,
      sequence: parsed.sequence,
      predecessorDigest: parsed.predecessorDigest,
      envelopeDigest: parsed.envelopeDigest,
      effectFingerprint: parsed.effectFingerprint,
      outcomeKind: parsed.outcome.kind,
      acceptedAt: parsed.appliedAt
    }));
    this.faultInjector?.reach("remote_apply_after_operation");
    if (parsed.outcome.kind === "conflict") {
      staged.conflicts.push(SyncConflictRecordSchema.parse({
        id: `${parsed.personId}_${parsed.authorDeviceId}_${parsed.sequence}_conflict`,
        personId: parsed.personId, authorDeviceId: parsed.authorDeviceId, sequence: parsed.sequence,
        detailFingerprint: parsed.outcome.detailFingerprint, detectedAt: parsed.appliedAt
      }));
    } else if (parsed.outcome.kind === "tombstone") {
      staged.tombstones.push(SyncTombstoneSchema.parse({
        id: `${parsed.personId}_${parsed.authorDeviceId}_${parsed.sequence}_tombstone`,
        personId: parsed.personId, targetId: parsed.outcome.targetId, authorDeviceId: parsed.authorDeviceId,
        sequence: parsed.sequence, tombstonedAt: parsed.appliedAt
      }));
    } else if (parsed.outcome.kind === "quarantine") {
      staged.quarantine.push(SyncQuarantineEntrySchema.parse({
        id: `${parsed.personId}_${parsed.authorDeviceId}_${parsed.sequence}_quarantine`,
        personId: parsed.personId, authorDeviceId: parsed.authorDeviceId, sequence: parsed.sequence,
        reasonFingerprint: parsed.outcome.reasonFingerprint, quarantinedAt: parsed.appliedAt
      }));
    }
    this.faultInjector?.reach("remote_apply_after_outcome");
    const existingRange = staged.ranges.find((range) => range.personId === parsed.personId);
    const merged = SyncContractionRangeSchema.parse({
      personId: parsed.personId,
      rangeStart: existingRange ? Math.min(existingRange.rangeStart, parsed.affectedRangeStart) : parsed.affectedRangeStart,
      rangeEnd: existingRange ? Math.max(existingRange.rangeEnd, parsed.affectedRangeEnd) : parsed.affectedRangeEnd
    });
    if (existingRange) Object.assign(existingRange, merged);
    else staged.ranges.push(merged);
    this.faultInjector?.reach("remote_apply_after_range");
    this.replace(this.acceptedSyncOperations, staged.accepted);
    this.replace(this.syncConflicts, staged.conflicts);
    this.replace(this.syncTombstones, staged.tombstones);
    this.replace(this.syncQuarantine, staged.quarantine);
    this.replace(this.syncContractionRanges, staged.ranges);
    this.setFrontier(parsed.personId, parsed.authorDeviceId, parsed.sequence);
    return structuredClone(parsed.receipt);
  }

  async sealClaimedOutboxEnvelope(input: SealClaimedOutboxEnvelopeInput): Promise<SealOutboxResult> {
    const parsed = SealClaimedOutboxEnvelopeInputSchema.parse(input);
    const current = this.syncOutbox.find((row) =>
      row.id === parsed.outboxId && row.personId === parsed.personId && row.deviceId === parsed.deviceId
    );
    if (!current) return { status: "STATE_CHANGED", record: null };
    if (current.status === "sealed") {
      const identical = current.sealedProtocolVersion === parsed.protocolVersion &&
        current.sealedSequence === parsed.sequence &&
        current.sealedPredecessorDigest === parsed.predecessorDigest &&
        current.sealedEnvelopeBytesBase64 === parsed.envelopeBytesBase64 &&
        current.sealedEnvelopeDigest === parsed.envelopeDigest;
      return { status: identical ? "IDEMPOTENT" : "EQUIVOCATION", record: identical ? structuredClone(current) : null };
    }
    if (current.rowVersion !== parsed.expectedRowVersion) {
      return { status: "STATE_CHANGED", record: null };
    }
    const staged = structuredClone(this.syncOutbox);
    const target = staged.find((row) => row.id === parsed.outboxId)!;
    this.faultInjector?.reach("seal_outbox_before_write");
    target.status = "sealed";
    target.rowVersion = target.rowVersion + 1;
    target.sealedProtocolVersion = parsed.protocolVersion;
    target.sealedSequence = parsed.sequence;
    target.sealedPredecessorDigest = parsed.predecessorDigest;
    target.sealedEnvelopeBytesBase64 = parsed.envelopeBytesBase64;
    target.sealedEnvelopeDigest = parsed.envelopeDigest;
    target.sealedAt = this.clock.now();
    const sealed = SyncOutboxOperationSchema.parse(target);
    this.faultInjector?.reach("seal_outbox_after_write");
    this.replace(this.syncOutbox, staged);
    return { status: "SEALED", record: structuredClone(sealed) };
  }

  async getSyncReplayFrontier(personId: string, deviceId: string): Promise<number> {
    return this.frontierFor(personId, deviceId);
  }

  async listSyncOutboxOperations(personId: string): Promise<SyncOutboxOperation[]> {
    return structuredClone(this.syncOutbox
      .filter((row) => row.personId === personId)
      .sort((left, right) => left.deviceSequence - right.deviceSequence));
  }

  async getSyncOutboxOperation(
    personId: string,
    deviceId: string,
    deviceSequence: number
  ): Promise<SyncOutboxOperation | null> {
    const match = this.syncOutbox.find((row) =>
      row.personId === personId && row.deviceId === deviceId && row.deviceSequence === deviceSequence);
    return match ? structuredClone(match) : null;
  }

  async listAcceptedSyncOperations(personId: string): Promise<AcceptedSyncOperation[]> {
    return structuredClone(this.acceptedSyncOperations
      .filter((op) => op.personId === personId)
      .sort((left, right) => left.sequence - right.sequence));
  }

  private frontierFor(personId: string, deviceId: string): number {
    return this.syncFrontiers.find((entry) => entry.personId === personId && entry.deviceId === deviceId)?.frontierSequence ?? 0;
  }

  private setFrontier(personId: string, deviceId: string, sequence: number): void {
    const existing = this.syncFrontiers.find((entry) => entry.personId === personId && entry.deviceId === deviceId);
    if (existing) existing.frontierSequence = sequence;
    else this.syncFrontiers.push({ personId, deviceId, frontierSequence: sequence });
  }

  private syncStateChanged(receipt: SyncCommitReceipt): SyncCommitReceipt {
    return structuredClone({ ...receipt, status: "STATE_CHANGED" });
  }

  private stateChanged(receipt: MutationCommitReceipt): MutationCommitReceipt {
    return structuredClone({ ...receipt, status: "STATE_CHANGED", effectCounts: {} });
  }

  private sourceDeletionEffectsMatch(input: CommitSourceDeletionInput): boolean {
    const computed = this.computeSourceDeletionEffects(input.personId, input.expectedGrant.candidateId, input.auditEvents.map((item) => item.id));
    return this.sameRecord(this.sortedEffects(computed), this.sortedEffects(input.effects));
  }

  private computeSourceDeletionEffects(personId: string, candidateId: string, auditEventIds: string[]) {
    const sourceIds = this.sources.filter((item) => item.personId === personId && item.instanceId === candidateId).map((item) => item.id);
    const sourceIdSet = new Set(sourceIds);
    const eventIds = this.canonicalEvents.filter((item) => item.personId === personId && sourceIdSet.has(item.sourceId)).map((item) => item.id);
    const eventIdSet = new Set(eventIds);
    const summaryIds = this.summaries.filter((item) => item.personId === personId && item.state !== "superseded" && (item.sourceCanonicalEventIds ?? []).some((id) => eventIdSet.has(id))).map((item) => item.id);
    const summaryIdSet = new Set(summaryIds);
    const computed = {
      sourceIds,
      canonicalEventIds: eventIds,
      turnIds: this.turns.filter((item) => eventIds.some((id) => item.id === `turn_${id}` || item.id === `personal_turn_${id}`)).map((item) => item.id),
      anchorIds: this.anchors.filter((item) => item.personId === personId && item.canonicalEventId !== undefined && eventIdSet.has(item.canonicalEventId)).map((item) => item.id),
      injectionIds: this.injections.filter((item) => item.sourceSummaryIds.some((id) => summaryIdSet.has(id))).map((item) => item.id),
      quarantineIds: this.quarantineRecords.filter((item) => item.personId === personId && item.candidateId === candidateId).map((item) => item.id),
      bootstrapCheckpointIds: this.bootstrapCheckpoints.filter((item) => item.personId === personId).map((item) => item.id),
      supersededSummaryIds: summaryIds,
      supersededBoxIds: this.boxes.filter((item) => item.personId === personId && item.state !== "superseded" && item.summaryIds.some((id) => summaryIdSet.has(id))).map((item) => item.id),
      supersededProposalIds: this.proposals.filter((item) => item.personId === personId && item.state !== "superseded" && item.sourceSummaryIds.some((id) => summaryIdSet.has(id))).map((item) => item.id),
      supersededTraceIds: this.traces.filter((item) => item.personId === personId && item.state !== "superseded" && item.summaryIds.some((id) => summaryIdSet.has(id))).map((item) => item.id),
      auditEventIds
    };
    return this.sortedEffects(computed);
  }

  private sortedEffects<T extends Record<string, string[]>>(effects: T): T {
    return Object.fromEntries(Object.entries(effects).map(([key, ids]) => [key, [...ids].sort()])) as T;
  }

  private assertDaemonStateGrant(state: DaemonSourceState): void {
    const grant = this.sourceGrants.find((candidate) => candidate.id === state.grantId);
    if (!grant || grant.personId !== state.personId || grant.candidateId !== state.candidateId || grant.scopeId !== state.scopeId) {
      throw new Error("Daemon source state grant ownership mismatch");
    }
  }

  private assertFreshDaemonAuthority(authority: { databaseId: string; ownerToken: string }): void {
    const now = Date.parse(this.clock.now());
    if (Number.isNaN(now)) throw new Error("Invalid authoritative store clock");
    const lease = this.daemonLeases.find((candidate) => candidate.databaseId === authority.databaseId);
    if (!lease || lease.ownerToken !== authority.ownerToken || Date.parse(lease.expiresAt) <= now) {
      throw new Error("Daemon write authority is missing, stale, or expired");
    }
  }

  private assertWriteAuthority(
    authority: CommitImportBatchInput["authority"],
    personId: string,
    foregroundOperation: "approved-import" | "historical-bootstrap"
  ): void {
    if (authority.kind === "daemon") {
      this.assertFreshDaemonAuthority(authority);
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
      const grant = expectedGrants?.find((candidate) => candidate.id === state.grantId) ??
        this.sourceGrants.find((candidate) => candidate.id === state.grantId && candidate.state === "approved");
      if (!grant || grant.personId !== personId || grant.candidateId !== state.candidateId || grant.scopeId !== state.scopeId) {
        throw new Error("Daemon source state grant ownership mismatch");
      }
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

  private assertExactApprovedGrant(input: CommitImportBatchInput): void {
    const grant = this.sourceGrants.find((candidate) => candidate.id === input.expectedGrant.id);
    if (!grant || grant.state !== "approved") throw new Error("Source grant is not approved or was revoked");
    if (
      grant.personId !== input.expectedGrant.personId ||
      grant.candidateId !== input.expectedGrant.candidateId ||
      grant.updatedAt !== input.expectedGrant.updatedAt
    ) {
      throw new Error("Source grant changed before import commit");
    }
  }

  private validateImportOwnership(input: CommitImportBatchInput): void {
    const { personId, expectedGrant, checkpoint, receipt, contractionJob } = input;
    if (expectedGrant.personId !== personId || checkpoint.personId !== personId || receipt.personId !== personId || (contractionJob !== null && contractionJob.personId !== personId)) {
      throw new Error("Import batch person ownership mismatch");
    }
    if (
      checkpoint.candidateId !== expectedGrant.candidateId ||
      receipt.candidateId !== expectedGrant.candidateId ||
      receipt.grantId !== expectedGrant.id
    ) {
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
      const metadataPerson = turn.metadata.personId;
      if (metadataPerson !== personId || turn.threadId !== `person:${personId}`) throw new Error("Turn ownership mismatch");
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
      input.nextCheckpoint.personId !== input.personId ||
      input.nextCheckpoint.jobId !== input.jobId ||
      input.nextJob.personId !== input.personId ||
      input.nextJob.id !== input.jobId ||
      (input.expectedCheckpoint !== null &&
        (input.expectedCheckpoint.personId !== input.personId || input.expectedCheckpoint.jobId !== input.jobId))
    ) {
      throw new Error("Contraction slice person or job ownership mismatch");
    }
    const owned = [input.summaries, input.anchors, input.boxes, input.proposals, input.traces].flat();
    if (owned.some((item) => item.personId !== input.personId)) throw new Error("Contraction derivation ownership mismatch");
    if (input.supersessions.some((item) => item.personId !== input.personId)) throw new Error("Supersession ownership mismatch");
    for (const turn of input.turns) {
      if (turn.metadata.personId !== input.personId || turn.threadId !== `person:${input.personId}`) {
        throw new Error("Contraction turn ownership mismatch");
      }
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

  private applySupersessions(
    staged: {
      summaries: Summary[];
      anchors: Anchor[];
      boxes: Box[];
      proposals: MemoryProposal[];
      traces: MemoryTrace[];
    },
    supersessions: CommitContractionSliceInput["supersessions"]
  ): void {
    for (const supersession of supersessions) {
      if (supersession.kind === "anchor") {
        this.removeByIds(staged.anchors, [supersession.id]);
        continue;
      }
      const collection = supersession.kind === "summary"
        ? staged.summaries
        : supersession.kind === "box"
          ? staged.boxes
          : supersession.kind === "proposal"
            ? staged.proposals
            : staged.traces;
      const item = collection.find((candidate) => candidate.id === supersession.id);
      if (item && item.personId !== supersession.personId) throw new Error("Supersession ownership mismatch");
      if (item) (item as { state: "superseded" }).state = "superseded";
    }
  }

  private stageOwnedUpsert<T extends { id: string; personId: string }>(items: T[], item: T): void {
    this.assertPersonOwnership(items, item);
    this.upsertById(items, structuredClone(item));
  }

  private stageTurnUpsert(items: Turn[], item: Turn, personId: string): void {
    const existing = items.find((candidate) => candidate.id === item.id);
    if (existing && (existing.metadata.personId !== personId || existing.threadId !== `person:${personId}`)) {
      throw new Error("Turn ownership mismatch");
    }
    this.upsertById(items, structuredClone(item));
  }

  private stageDerivedUpsert<T extends { id: string; personId?: string }>(items: T[], item: T, personId: string): void {
    const existing = items.find((candidate) => candidate.id === item.id);
    if (existing && existing.personId !== personId) throw new Error("Derivation ownership mismatch");
    this.upsertById(items, structuredClone(item));
  }

  private replace<T>(target: T[], replacement: T[]): void {
    target.splice(0, target.length, ...structuredClone(replacement));
  }

  private sameRecord(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  private upsertById<T extends { id: string }>(items: T[], item: T): void {
    const existingIndex = items.findIndex((existing) => existing.id === item.id);

    if (existingIndex === -1) {
      items.push(item);
      return;
    }

    items[existingIndex] = item;
  }

  private removeByIds<T extends { id: string }>(items: T[], ids: string[]): void {
    const targets = new Set(ids);
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (targets.has(items[index].id)) items.splice(index, 1);
    }
  }

  private assertPersonOwnership<T extends { id: string; personId: string }>(
    items: T[],
    item: T
  ): void {
    const existing = items.find((candidate) => candidate.id === item.id);
    if (existing && existing.personId !== item.personId) {
      throw new Error(`Cannot reassign ${item.id} to a different person`);
    }
  }
}
