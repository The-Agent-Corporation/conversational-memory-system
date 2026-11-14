import type { MemoryStore } from "../../src/storage/memory-store.js";

/**
 * Explicit, exhaustive MemoryStore observation seam for cost-contract tests.
 *
 * Adding a MemoryStore method must service this file in the same commit without
 * re-wrapping it: the explicit object and keyed count initializer are compile-time
 * tripwires. This deliberately measures calls and materialized result rows only;
 * it does not measure timing or computation performed behind a store call.
 */
export interface CountingStoreCounts {
  calls: Record<keyof MemoryStore, number>;
  rows: Record<string, number>;
}

export interface CountingStoreHandle {
  store: MemoryStore;
  counts: CountingStoreCounts;
  reset(): void;
}

function zeroCounts(): Record<keyof MemoryStore, number> {
  return {
  commitHistoryImport: 0,
  commitProposalDecision: 0,
  commitSourceRevocation: 0,
  commitSourceDeletion: 0,
  inspectSourceDeletionEffects: 0,
  acquireDaemonLease: 0,
  getDaemonLease: 0,
  heartbeatDaemonLease: 0,
  requestDaemonStop: 0,
  releaseDaemonLease: 0,
  saveDaemonSourceState: 0,
  getDaemonSourceState: 0,
  listDaemonSourceStates: 0,
  reconcileDaemonSourceStates: 0,
  getImportBatchReceipt: 0,
  listImportBatchReceipts: 0,
  saveContractionJob: 0,
  getContractionJob: 0,
  listContractionJobs: 0,
  saveContractionCheckpoint: 0,
  getContractionCheckpoint: 0,
  commitImportBatch: 0,
  commitContractionSlice: 0,
  commitApprovedGrantReconciliation: 0,
  commitDueSourceRefresh: 0,
  commitSourceStateOutcome: 0,
  commitProposalRun: 0,
  commitDaemonWorkOutcome: 0,
  savePerson: 0,
  getPerson: 0,
  listPeople: 0,
  saveSource: 0,
  getSource: 0,
  listSources: 0,
  saveCanonicalEvent: 0,
  listCanonicalEvents: 0,
  listCanonicalEventsByIds: 0,
  listCanonicalEventKeys: 0,
  listCanonicalEventScopePairs: 0,
  deleteCanonicalEvents: 0,
  deleteSources: 0,
  saveImportCheckpoint: 0,
  getImportCheckpoint: 0,
  listImportCheckpoints: 0,
  deleteImportCheckpointsForCandidate: 0,
  saveSourceGrant: 0,
  getSourceGrant: 0,
  listSourceGrants: 0,
  saveSourceLifecycleAuditEvent: 0,
  listSourceLifecycleAuditEvents: 0,
  saveQuarantineRecord: 0,
  getQuarantineRecord: 0,
  listQuarantineRecords: 0,
  deleteQuarantineRecords: 0,
  saveBootstrapCheckpoint: 0,
  getBootstrapCheckpoint: 0,
  deleteBootstrapCheckpoint: 0,
  saveTurn: 0,
  listTurns: 0,
  deleteTurns: 0,
  saveSummary: 0,
  listSummaries: 0,
  commitSupersededSummaryPrune: 0,
  listSupersededSummaryIds: 0,
  summarizeSupersededSummaries: 0,
  saveBox: 0,
  getBox: 0,
  listBoxes: 0,
  saveAnchor: 0,
  listAnchors: 0,
  deleteAnchors: 0,
  commitUnhygienicAnchorPrune: 0,
  commitLegacyUnownedQuarantine: 0,
  listAnchorIds: 0,
  summarizeAnchorDerivationClasses: 0,
  saveInjection: 0,
  getInjection: 0,
  listInjections: 0,
  deleteInjectionsReferencingSummaryIds: 0,
  saveProposal: 0,
  recordMutationAudit: 0,
  listMutationAudits: 0,
  recordRejectedValueFingerprint: 0,
  hasRejectedValueFingerprint: 0,
  listRejectedValueFingerprints: 0,
  getProposal: 0,
  listProposals: 0,
  saveTrace: 0,
  getTrace: 0,
  listTraces: 0,
  commitLocalSyncOperation: 0,
  commitRemoteSyncApply: 0,
  sealClaimedOutboxEnvelope: 0,
  getSyncReplayFrontier: 0,
  listSyncOutboxOperations: 0,
  getSyncOutboxOperation: 0,
  listAcceptedSyncOperations: 0,
  saveSummaryVector: 0,
  saveSummaryVectors: 0,
  getSummaryVector: 0,
  listSummaryIdsMissingVector: 0,
  listSummariesByIds: 0,
  findNearestSummaries: 0,
  deleteSummaryVectors: 0,
  recordModelUsage: 0,
  modelSpendOnDay: 0,
  getModelOutputCache: 0,
  putModelOutputCache: 0,
  isCanonicalEventTombstoned: 0,
  commitEventDeletion: 0
  };
}

export function createCountingStore(delegate: MemoryStore): CountingStoreHandle {
  const counts: CountingStoreCounts = {
    calls: zeroCounts(),
    rows: zeroCounts()
  };

  async function record<K extends keyof MemoryStore, T>(
    name: K,
    operation: () => Promise<T>
  ): Promise<T> {
    counts.calls[name] += 1;
    const result = await operation();
    if (Array.isArray(result)) {
      counts.rows[name] += result.length;
    }
    return result;
  }

  const store: MemoryStore = {
    commitHistoryImport: (...args) => record("commitHistoryImport", () => delegate.commitHistoryImport(...args)),
    commitProposalDecision: (...args) => record("commitProposalDecision", () => delegate.commitProposalDecision(...args)),
    commitSourceRevocation: (...args) => record("commitSourceRevocation", () => delegate.commitSourceRevocation(...args)),
    commitSourceDeletion: (...args) => record("commitSourceDeletion", () => delegate.commitSourceDeletion(...args)),
    inspectSourceDeletionEffects: (...args) => record("inspectSourceDeletionEffects", () => delegate.inspectSourceDeletionEffects(...args)),
    acquireDaemonLease: (...args) => record("acquireDaemonLease", () => delegate.acquireDaemonLease(...args)),
    getDaemonLease: (...args) => record("getDaemonLease", () => delegate.getDaemonLease(...args)),
    heartbeatDaemonLease: (...args) => record("heartbeatDaemonLease", () => delegate.heartbeatDaemonLease(...args)),
    requestDaemonStop: (...args) => record("requestDaemonStop", () => delegate.requestDaemonStop(...args)),
    releaseDaemonLease: (...args) => record("releaseDaemonLease", () => delegate.releaseDaemonLease(...args)),
    saveDaemonSourceState: (...args) => record("saveDaemonSourceState", () => delegate.saveDaemonSourceState(...args)),
    getDaemonSourceState: (...args) => record("getDaemonSourceState", () => delegate.getDaemonSourceState(...args)),
    listDaemonSourceStates: (...args) => record("listDaemonSourceStates", () => delegate.listDaemonSourceStates(...args)),
    reconcileDaemonSourceStates: (...args) => record("reconcileDaemonSourceStates", () => delegate.reconcileDaemonSourceStates(...args)),
    getImportBatchReceipt: (...args) => record("getImportBatchReceipt", () => delegate.getImportBatchReceipt(...args)),
    listImportBatchReceipts: (...args) => record("listImportBatchReceipts", () => delegate.listImportBatchReceipts(...args)),
    saveContractionJob: (...args) => record("saveContractionJob", () => delegate.saveContractionJob(...args)),
    getContractionJob: (...args) => record("getContractionJob", () => delegate.getContractionJob(...args)),
    listContractionJobs: (...args) => record("listContractionJobs", () => delegate.listContractionJobs(...args)),
    saveContractionCheckpoint: (...args) => record("saveContractionCheckpoint", () => delegate.saveContractionCheckpoint(...args)),
    getContractionCheckpoint: (...args) => record("getContractionCheckpoint", () => delegate.getContractionCheckpoint(...args)),
    commitImportBatch: (...args) => record("commitImportBatch", () => delegate.commitImportBatch(...args)),
    commitContractionSlice: (...args) => record("commitContractionSlice", () => delegate.commitContractionSlice(...args)),
    commitApprovedGrantReconciliation: (...args) => record("commitApprovedGrantReconciliation", () => delegate.commitApprovedGrantReconciliation(...args)),
    commitDueSourceRefresh: (...args) => record("commitDueSourceRefresh", () => delegate.commitDueSourceRefresh(...args)),
    commitSourceStateOutcome: (...args) => record("commitSourceStateOutcome", () => delegate.commitSourceStateOutcome(...args)),
    commitProposalRun: (...args) => record("commitProposalRun", () => delegate.commitProposalRun(...args)),
    commitDaemonWorkOutcome: (...args) => record("commitDaemonWorkOutcome", () => delegate.commitDaemonWorkOutcome(...args)),
    savePerson: (...args) => record("savePerson", () => delegate.savePerson(...args)),
    getPerson: (...args) => record("getPerson", () => delegate.getPerson(...args)),
    listPeople: (...args) => record("listPeople", () => delegate.listPeople(...args)),
    saveSource: (...args) => record("saveSource", () => delegate.saveSource(...args)),
    getSource: (...args) => record("getSource", () => delegate.getSource(...args)),
    listSources: (...args) => record("listSources", () => delegate.listSources(...args)),
    saveCanonicalEvent: (...args) => record("saveCanonicalEvent", () => delegate.saveCanonicalEvent(...args)),
    listCanonicalEvents: (...args) => record("listCanonicalEvents", () => delegate.listCanonicalEvents(...args)),
    listCanonicalEventsByIds: (...args) => record("listCanonicalEventsByIds", () => delegate.listCanonicalEventsByIds(...args)),
    listCanonicalEventKeys: (...args) => record("listCanonicalEventKeys", () => delegate.listCanonicalEventKeys(...args)),
    listCanonicalEventScopePairs: (...args) => record("listCanonicalEventScopePairs", () => delegate.listCanonicalEventScopePairs(...args)),
    deleteCanonicalEvents: (...args) => record("deleteCanonicalEvents", () => delegate.deleteCanonicalEvents(...args)),
    deleteSources: (...args) => record("deleteSources", () => delegate.deleteSources(...args)),
    saveImportCheckpoint: (...args) => record("saveImportCheckpoint", () => delegate.saveImportCheckpoint(...args)),
    getImportCheckpoint: (...args) => record("getImportCheckpoint", () => delegate.getImportCheckpoint(...args)),
    listImportCheckpoints: (...args) => record("listImportCheckpoints", () => delegate.listImportCheckpoints(...args)),
    deleteImportCheckpointsForCandidate: (...args) => record("deleteImportCheckpointsForCandidate", () => delegate.deleteImportCheckpointsForCandidate(...args)),
    saveSourceGrant: (...args) => record("saveSourceGrant", () => delegate.saveSourceGrant(...args)),
    getSourceGrant: (...args) => record("getSourceGrant", () => delegate.getSourceGrant(...args)),
    listSourceGrants: (...args) => record("listSourceGrants", () => delegate.listSourceGrants(...args)),
    saveSourceLifecycleAuditEvent: (...args) => record("saveSourceLifecycleAuditEvent", () => delegate.saveSourceLifecycleAuditEvent(...args)),
    listSourceLifecycleAuditEvents: (...args) => record("listSourceLifecycleAuditEvents", () => delegate.listSourceLifecycleAuditEvents(...args)),
    saveQuarantineRecord: (...args) => record("saveQuarantineRecord", () => delegate.saveQuarantineRecord(...args)),
    getQuarantineRecord: (...args) => record("getQuarantineRecord", () => delegate.getQuarantineRecord(...args)),
    listQuarantineRecords: (...args) => record("listQuarantineRecords", () => delegate.listQuarantineRecords(...args)),
    deleteQuarantineRecords: (...args) => record("deleteQuarantineRecords", () => delegate.deleteQuarantineRecords(...args)),
    saveBootstrapCheckpoint: (...args) => record("saveBootstrapCheckpoint", () => delegate.saveBootstrapCheckpoint(...args)),
    getBootstrapCheckpoint: (...args) => record("getBootstrapCheckpoint", () => delegate.getBootstrapCheckpoint(...args)),
    deleteBootstrapCheckpoint: (...args) => record("deleteBootstrapCheckpoint", () => delegate.deleteBootstrapCheckpoint(...args)),
    saveTurn: (...args) => record("saveTurn", () => delegate.saveTurn(...args)),
    listTurns: (...args) => record("listTurns", () => delegate.listTurns(...args)),
    deleteTurns: (...args) => record("deleteTurns", () => delegate.deleteTurns(...args)),
    saveSummary: (...args) => record("saveSummary", () => delegate.saveSummary(...args)),
    listSummaries: (...args) => record("listSummaries", () => delegate.listSummaries(...args)),
    commitSupersededSummaryPrune: (...args) => record("commitSupersededSummaryPrune", () => delegate.commitSupersededSummaryPrune(...args)),
    listSupersededSummaryIds: (...args) => record("listSupersededSummaryIds", () => delegate.listSupersededSummaryIds(...args)),
    summarizeSupersededSummaries: (...args) => record("summarizeSupersededSummaries", () => delegate.summarizeSupersededSummaries(...args)),
    saveBox: (...args) => record("saveBox", () => delegate.saveBox(...args)),
    getBox: (...args) => record("getBox", () => delegate.getBox(...args)),
    listBoxes: (...args) => record("listBoxes", () => delegate.listBoxes(...args)),
    saveAnchor: (...args) => record("saveAnchor", () => delegate.saveAnchor(...args)),
    listAnchors: (...args) => record("listAnchors", () => delegate.listAnchors(...args)),
    deleteAnchors: (...args) => record("deleteAnchors", () => delegate.deleteAnchors(...args)),
    commitUnhygienicAnchorPrune: (...args) => record("commitUnhygienicAnchorPrune", () => delegate.commitUnhygienicAnchorPrune(...args)),
    commitLegacyUnownedQuarantine: (...args) => record("commitLegacyUnownedQuarantine", () => delegate.commitLegacyUnownedQuarantine(...args)),
    listAnchorIds: (...args) => record("listAnchorIds", () => delegate.listAnchorIds(...args)),
    summarizeAnchorDerivationClasses: (...args) => record("summarizeAnchorDerivationClasses", () => delegate.summarizeAnchorDerivationClasses(...args)),
    saveInjection: (...args) => record("saveInjection", () => delegate.saveInjection(...args)),
    getInjection: (...args) => record("getInjection", () => delegate.getInjection(...args)),
    listInjections: (...args) => record("listInjections", () => delegate.listInjections(...args)),
    deleteInjectionsReferencingSummaryIds: (...args) => record("deleteInjectionsReferencingSummaryIds", () => delegate.deleteInjectionsReferencingSummaryIds(...args)),
    saveProposal: (...args) => record("saveProposal", () => delegate.saveProposal(...args)),
    recordMutationAudit: (...args) => record("recordMutationAudit", () => delegate.recordMutationAudit(...args)),
    listMutationAudits: (...args) => record("listMutationAudits", () => delegate.listMutationAudits(...args)),
    recordRejectedValueFingerprint: (...args) => record("recordRejectedValueFingerprint", () => delegate.recordRejectedValueFingerprint(...args)),
    hasRejectedValueFingerprint: (...args) => record("hasRejectedValueFingerprint", () => delegate.hasRejectedValueFingerprint(...args)),
    listRejectedValueFingerprints: (...args) => record("listRejectedValueFingerprints", () => delegate.listRejectedValueFingerprints(...args)),
    getProposal: (...args) => record("getProposal", () => delegate.getProposal(...args)),
    listProposals: (...args) => record("listProposals", () => delegate.listProposals(...args)),
    saveTrace: (...args) => record("saveTrace", () => delegate.saveTrace(...args)),
    getTrace: (...args) => record("getTrace", () => delegate.getTrace(...args)),
    listTraces: (...args) => record("listTraces", () => delegate.listTraces(...args)),
    commitLocalSyncOperation: (...args) => record("commitLocalSyncOperation", () => delegate.commitLocalSyncOperation(...args)),
    commitRemoteSyncApply: (...args) => record("commitRemoteSyncApply", () => delegate.commitRemoteSyncApply(...args)),
    sealClaimedOutboxEnvelope: (...args) => record("sealClaimedOutboxEnvelope", () => delegate.sealClaimedOutboxEnvelope(...args)),
    getSyncReplayFrontier: (...args) => record("getSyncReplayFrontier", () => delegate.getSyncReplayFrontier(...args)),
    listSyncOutboxOperations: (...args) => record("listSyncOutboxOperations", () => delegate.listSyncOutboxOperations(...args)),
    getSyncOutboxOperation: (...args) => record("getSyncOutboxOperation", () => delegate.getSyncOutboxOperation(...args)),
    listAcceptedSyncOperations: (...args) => record("listAcceptedSyncOperations", () => delegate.listAcceptedSyncOperations(...args)),
    saveSummaryVector: (...args) => record("saveSummaryVector", () => delegate.saveSummaryVector(...args)),
    saveSummaryVectors: (...args) => record("saveSummaryVectors", () => delegate.saveSummaryVectors(...args)),
    getSummaryVector: (...args) => record("getSummaryVector", () => delegate.getSummaryVector(...args)),
    listSummaryIdsMissingVector: (...args) => record("listSummaryIdsMissingVector", () => delegate.listSummaryIdsMissingVector(...args)),
    listSummariesByIds: (...args) => record("listSummariesByIds", () => delegate.listSummariesByIds(...args)),
    findNearestSummaries: (...args) => record("findNearestSummaries", () => delegate.findNearestSummaries(...args)),
    deleteSummaryVectors: (...args) => record("deleteSummaryVectors", () => delegate.deleteSummaryVectors(...args)),
    recordModelUsage: (...args) => record("recordModelUsage", () => delegate.recordModelUsage(...args)),
    modelSpendOnDay: (...args) => record("modelSpendOnDay", () => delegate.modelSpendOnDay(...args)),
    getModelOutputCache: (...args) => record("getModelOutputCache", () => delegate.getModelOutputCache(...args)),
    putModelOutputCache: (...args) => record("putModelOutputCache", () => delegate.putModelOutputCache(...args)),
    isCanonicalEventTombstoned: (...args) => record("isCanonicalEventTombstoned", () => delegate.isCanonicalEventTombstoned(...args)),
    commitEventDeletion: (...args) => record("commitEventDeletion", () => delegate.commitEventDeletion(...args))
  };

  return {
    store,
    counts,
    reset() {
      for (const name of Object.keys(counts.calls) as Array<keyof MemoryStore>) {
        counts.calls[name] = 0;
        counts.rows[name] = 0;
      }
    }
  };
}
