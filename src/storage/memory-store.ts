import type {
  Anchor,
  Box,
  InjectionPacket,
  MemoryProposal,
  MemoryTrace,
  ProposalState,
  ProposalType,
  Summary,
  Turn
} from "../domain/types.js";
import type { CanonicalEvent, MemorySource, Person } from "../domain/canonical.js";
import type { ImportCheckpoint } from "../imports/types.js";
import type { HistoricalBootstrapCheckpoint } from "../bootstrap/types.js";
import type { QuarantineRecord, SourceGrant, SourceLifecycleAuditEvent } from "../domain/source-lifecycle.js";
import type {
  CommitApprovedGrantReconciliationInput,
  CommitContractionSliceInput,
  CommitDaemonWorkOutcomeInput,
  CommitDueSourceRefreshInput,
  CommitImportBatchInput,
  CommitProposalRunInput,
  CommitSourceStateOutcomeInput,
  ContractionCheckpoint,
  ContractionJob,
  DaemonLease,
  DaemonSourceState,
  ImportBatchReceipt
} from "../daemon/types.js";
import type {
  CommitHistoryImportInput,
  CommitProposalDecisionInput,
  CommitSourceDeletionInput,
  CommitSourceRevocationInput,
  MutationCommitReceipt,
  SourceDeletionEffects
} from "./mcp-mutation-contracts.js";
import type {
  AcceptedSyncOperation,
  CommitLocalSyncOperationInput,
  CommitRemoteSyncApplyInput,
  SealClaimedOutboxEnvelopeInput,
  SealOutboxResult,
  SyncCommitReceipt,
  SyncOutboxOperation
} from "./sync-contracts.js";

export interface ProposalFilter {
  state?: ProposalState;
  proposalType?: ProposalType;
}

export interface TraceFilter {
  state?: ProposalState;
}

/** A single persisted (summaryId, provider, model) vector row (D-01/D-04), denormalizing personId/scopeIds for boundary filtering (D-06). */
export interface SummaryVectorRecord {
  summaryId: string;
  provider: string;
  model: string;
  dimensions: number;
  vector: number[];
  personId: string;
  scopeIds: string[];
  createdAt: string;
}

/** Nearest-neighbor query input for findNearestSummaries (D-06/D-07): callers must supply the authorized person/scope boundary. */
export interface FindNearestSummariesQuery {
  vector: number[];
  provider: string;
  model: string;
  personId: string;
  allowedScopeIds: string[];
  topK: number;
  minimumScore?: number;
}

/** A single scored nearest-neighbor result. */
export interface SummaryVectorMatch {
  summaryId: string;
  score: number;
}

export interface MemoryStore {
  commitHistoryImport(input: CommitHistoryImportInput): Promise<MutationCommitReceipt>;
  commitProposalDecision(input: CommitProposalDecisionInput): Promise<MutationCommitReceipt>;
  commitSourceRevocation(input: CommitSourceRevocationInput): Promise<MutationCommitReceipt>;
  commitSourceDeletion(input: CommitSourceDeletionInput): Promise<MutationCommitReceipt>;
  inspectSourceDeletionEffects(personId: string, candidateId: string, auditEventIds: string[]): Promise<SourceDeletionEffects>;
  acquireDaemonLease(input: {
    databaseId: string;
    ownerToken: string;
    pid: number;
    now: string;
  }): Promise<DaemonLease | null>;
  getDaemonLease(databaseId: string): Promise<DaemonLease | null>;
  heartbeatDaemonLease(databaseId: string, ownerToken: string, now: string): Promise<DaemonLease | null>;
  requestDaemonStop(databaseId: string, ownerToken: string, now: string): Promise<boolean>;
  releaseDaemonLease(databaseId: string, ownerToken: string): Promise<boolean>;
  saveDaemonSourceState(state: DaemonSourceState): Promise<void>;
  getDaemonSourceState(id: string): Promise<DaemonSourceState | null>;
  listDaemonSourceStates(personId: string): Promise<DaemonSourceState[]>;
  reconcileDaemonSourceStates(personId: string, now: string): Promise<DaemonSourceState[]>;
  getImportBatchReceipt(id: string): Promise<ImportBatchReceipt | null>;
  listImportBatchReceipts(personId: string): Promise<ImportBatchReceipt[]>;
  /** Persists the stable per-person work-range epoch and its independent proposal-run baseline. */
  saveContractionJob(job: ContractionJob): Promise<void>;
  getContractionJob(id: string): Promise<ContractionJob | null>;
  listContractionJobs(personId: string): Promise<ContractionJob[]>;
  /** Persists the last processed canonical tuple separately from the next resume tuple. */
  saveContractionCheckpoint(checkpoint: ContractionCheckpoint): Promise<void>;
  getContractionCheckpoint(id: string): Promise<ContractionCheckpoint | null>;
  commitImportBatch(input: CommitImportBatchInput): Promise<ImportBatchReceipt>;
  commitContractionSlice(input: CommitContractionSliceInput): Promise<ContractionCheckpoint>;
  commitApprovedGrantReconciliation(input: CommitApprovedGrantReconciliationInput): Promise<DaemonSourceState[]>;
  commitDueSourceRefresh(input: CommitDueSourceRefreshInput): Promise<DaemonSourceState[]>;
  commitSourceStateOutcome(input: CommitSourceStateOutcomeInput): Promise<DaemonSourceState>;
  commitProposalRun(input: CommitProposalRunInput): Promise<ContractionCheckpoint | null>;
  commitDaemonWorkOutcome(input: CommitDaemonWorkOutcomeInput): Promise<ContractionJob>;
  savePerson(person: Person): Promise<void>;
  getPerson(id: string): Promise<Person | null>;
  listPeople(): Promise<Person[]>;
  saveSource(source: MemorySource): Promise<void>;
  getSource(id: string): Promise<MemorySource | null>;
  listSources(personId: string): Promise<MemorySource[]>;
  saveCanonicalEvent(event: CanonicalEvent): Promise<void>;
  listCanonicalEvents(personId: string): Promise<CanonicalEvent[]>;
  deleteCanonicalEvents(ids: string[]): Promise<void>;
  deleteSources(ids: string[]): Promise<void>;
  saveImportCheckpoint(checkpoint: ImportCheckpoint): Promise<void>;
  getImportCheckpoint(id: string): Promise<ImportCheckpoint | null>;
  listImportCheckpoints(personId: string): Promise<ImportCheckpoint[]>;
  deleteImportCheckpointsForCandidate(personId: string, candidateId: string): Promise<void>;
  saveSourceGrant(grant: SourceGrant): Promise<void>;
  getSourceGrant(id: string): Promise<SourceGrant | null>;
  listSourceGrants(personId: string): Promise<SourceGrant[]>;
  saveSourceLifecycleAuditEvent(event: SourceLifecycleAuditEvent): Promise<void>;
  listSourceLifecycleAuditEvents(personId: string): Promise<SourceLifecycleAuditEvent[]>;
  saveQuarantineRecord(record: QuarantineRecord): Promise<void>;
  getQuarantineRecord(id: string): Promise<QuarantineRecord | null>;
  listQuarantineRecords(personId: string, candidateId?: string): Promise<QuarantineRecord[]>;
  deleteQuarantineRecords(personId: string, candidateId: string): Promise<void>;
  saveBootstrapCheckpoint(checkpoint: HistoricalBootstrapCheckpoint): Promise<void>;
  getBootstrapCheckpoint(id: string): Promise<HistoricalBootstrapCheckpoint | null>;
  deleteBootstrapCheckpoint(id: string): Promise<void>;
  saveTurn(turn: Turn): Promise<void>;
  listTurns(threadId: string): Promise<Turn[]>;
  deleteTurns(ids: string[]): Promise<void>;
  saveSummary(summary: Summary): Promise<void>;
  listSummaries(): Promise<Summary[]>;
  saveBox(box: Box): Promise<void>;
  getBox(id: string): Promise<Box | null>;
  listBoxes(): Promise<Box[]>;
  saveAnchor(anchor: Anchor): Promise<void>;
  listAnchors(): Promise<Anchor[]>;
  deleteAnchors(ids: string[]): Promise<void>;
  saveInjection(packet: InjectionPacket): Promise<void>;
  listInjections(hostSessionId: string): Promise<InjectionPacket[]>;
  deleteInjectionsReferencingSummaryIds(summaryIds: string[]): Promise<void>;
  saveProposal(proposal: MemoryProposal): Promise<void>;
  getProposal(id: string): Promise<MemoryProposal | null>;
  listProposals(filter?: ProposalFilter): Promise<MemoryProposal[]>;
  saveTrace(trace: MemoryTrace): Promise<void>;
  getTrace(id: string): Promise<MemoryTrace | null>;
  listTraces(filter?: TraceFilter): Promise<MemoryTrace[]>;

  /** Atomically commits one authoritative local domain-effect proof plus one pending outbox row. */
  commitLocalSyncOperation(input: CommitLocalSyncOperationInput): Promise<SyncCommitReceipt>;
  /** Atomically applies one untrusted remote-origin operation; never creates a local outbox row. */
  commitRemoteSyncApply(input: CommitRemoteSyncApplyInput): Promise<SyncCommitReceipt>;
  /**
   * Exact-state CAS that binds expected person/device/outbox identity and row version before
   * sealing immutable envelope bytes. Only the current claim may assign sequence/protocol.
   */
  sealClaimedOutboxEnvelope(input: SealClaimedOutboxEnvelopeInput): Promise<SealOutboxResult>;
  getSyncReplayFrontier(personId: string, deviceId: string): Promise<number>;
  listSyncOutboxOperations(personId: string): Promise<SyncOutboxOperation[]>;
  /**
   * Indexed single-operation lookup by (person, device, deviceSequence). Producers that only
   * need one predecessor operation MUST use this instead of listing the whole outbox and
   * scanning it: the outbox grows by one row per ingested event, so a per-event full-list scan
   * is O(n^2) over a bootstrap import. Returns null when no such operation exists.
   */
  getSyncOutboxOperation(
    personId: string,
    deviceId: string,
    deviceSequence: number
  ): Promise<SyncOutboxOperation | null>;
  listAcceptedSyncOperations(personId: string): Promise<AcceptedSyncOperation[]>;

  /** Upserts one (summaryId, provider, model) vector row, keyed by summary_id+provider+model, denormalizing personId/scopeIds (D-01/D-04/D-06). */
  saveSummaryVector(record: SummaryVectorRecord): Promise<void>;
  getSummaryVector(summaryId: string, provider: string, model: string): Promise<SummaryVectorRecord | null>;
  /** Stable ascending-order list of summary ids missing a (provider, model) vector row — the Phase 10 backfill resume key (D-05). */
  listSummaryIdsMissingVector(provider: string, model: string): Promise<string[]>;
  /** Filter-before-score nearest-neighbor search bounded by personId + allowedScopeIds (D-06/D-07); results ordered score desc then summaryId asc. */
  findNearestSummaries(query: FindNearestSummariesQuery): Promise<SummaryVectorMatch[]>;
  /**
   * Tombstones vector rows for the given summary ids across all (provider, model) rows (D-09,
   * REQ-050 storage half). Intentionally uninvoked until Phase 14 wires it into
   * commitSourceDeletion.
   */
  deleteSummaryVectors(summaryIds: string[]): Promise<void>;
}
