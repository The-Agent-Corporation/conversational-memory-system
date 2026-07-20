import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Box, MemoryProposal, MemoryTrace, Summary } from "../../src/domain/types.js";
import { createProfileAuthority, type ProfileAuthority } from "../../src/mcp/authority.js";
import { explain } from "../../src/audit/explain-service.js";
import { SourceLifecycleService } from "../../src/service/source-lifecycle-service.js";
import { emitLocalSyncOperation, DEFAULT_LOCAL_SYNC_DEVICE_ID } from "../../src/sync/materialization/sync-materializer.js";
import { mutationEffectsFingerprint } from "../../src/storage/mcp-mutation-contracts.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";

const NOW = "2026-07-20T12:00:00.000Z";
const PERSON_ID = "person-explain";

const authority = (allowedScopeIds: string[], databasePath: string): ProfileAuthority =>
  createProfileAuthority({
    profileName: "explain-fixture",
    databasePath,
    personId: PERSON_ID,
    allowedScopeIds,
    ingestScopeId: "scope-a",
    sourceRoots: {},
    scopeAliases: {}
  });

const summary = (input: { id: string; scopeIds: string[] }): Summary => ({
  id: input.id,
  personId: PERSON_ID,
  scopeIds: input.scopeIds,
  origin: "historical_bootstrap",
  summaryText: "Synthetic explain summary",
  sourceTurnRanges: [],
  sourceCanonicalEventIds: ["event-1"],
  sourceSummaryIds: [],
  boxIds: [],
  embedding: null,
  createdAt: NOW,
  model: "synthetic-local",
  promptVersion: "fixture-v1",
  confidence: 0.8,
  state: "active",
  detailLevel: "brief",
  tokenCount: 12,
  lastAccessedAt: null,
  version: 1,
  strength: 0.5,
  retrievalCount: 0,
  retrievedAt: null,
  halfLifeHours: 168,
  outcomeScore: null
});

const box = (input: { id: string; summaryIds: string[] }): Box => ({
  id: input.id,
  personId: PERSON_ID,
  title: "Synthetic explain box",
  description: "",
  parentBoxId: null,
  childBoxIds: [],
  summaryIds: input.summaryIds,
  turnRanges: [],
  state: "approved",
  createdAt: NOW,
  updatedAt: NOW,
  caseId: null,
  boxType: "project",
  summary: "",
  lastActivityAt: NOW
});

const trace = (input: { id: string; summaryIds: string[] }): MemoryTrace => ({
  id: input.id,
  personId: PERSON_ID,
  title: "Synthetic explain trace",
  description: "",
  traceType: "task_thread",
  state: "proposed",
  summaryIds: input.summaryIds,
  boxIds: [],
  turnRanges: [{ threadId: "synthetic-thread", startSequence: 1, endSequence: 2 }],
  createdAt: NOW,
  updatedAt: NOW,
  lastActivityAt: NOW,
  confidence: 0.7,
  rationale: "Synthetic explain fixture"
});

const proposal = (input: {
  id: string;
  state: "approved" | "rejected";
  targetBoxIds?: string[];
  targetTraceIds?: string[];
  sourceSummaryIds: string[];
}): MemoryProposal => ({
  id: input.id,
  personId: PERSON_ID,
  proposalType: "box",
  state: input.state,
  title: "Synthetic explain proposal",
  rationale: "Exercises approve/reject explain coverage.",
  confidence: 0.7,
  createdAt: NOW,
  reviewedAt: NOW,
  decidedAt: NOW,
  decidedBy: "reviewer-explain",
  decisionNote: null,
  sourceSummaryIds: input.sourceSummaryIds,
  sourceTurnRanges: [{ threadId: "synthetic-thread", startSequence: 1, endSequence: 2 }],
  targetBoxIds: input.targetBoxIds ?? [],
  targetTraceIds: input.targetTraceIds ?? [],
  payload: {
    boxId: "box-payload",
    title: "Synthetic",
    description: "",
    summary: "Synthetic",
    boxType: "project",
    candidateParentBoxId: null,
    keywords: ["synthetic"],
    evidence: ["synthetic"],
    sourceSummaryIds: input.sourceSummaryIds,
    sourceTurnRanges: [{ threadId: "synthetic-thread", startSequence: 1, endSequence: 2 }]
  }
});

describe("explain() REQ-039 lifecycle verb coverage", () => {
  let tempDir: string | undefined;
  let store: SqliteStore | undefined;

  afterEach(async () => {
    store?.close();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
    store = undefined;
  });

  const openStore = async (): Promise<{ store: SqliteStore; databasePath: string }> => {
    tempDir = await mkdtemp(join(tmpdir(), "memory-explain-"));
    const databasePath = join(tempDir, "memory.sqlite");
    store = new SqliteStore(databasePath);
    return { store, databasePath };
  };

  it("explains 'imported' from the source_lifecycle_audit 'approved' action", async () => {
    const { store: db, databasePath } = await openStore();
    await new SourceLifecycleService(db).approve({
      personId: PERSON_ID,
      candidateId: "candidate-imported",
      application: "synthetic-host",
      format: "jsonl",
      sourceLocator: "/synthetic/root",
      profileId: "synthetic-profile",
      scopeId: "scope-a",
      approvedAt: NOW
    });

    const trace = await explain(db, "candidate-imported", authority(["scope-a"], databasePath));

    expect(trace.kind).toBe("source");
    expect(trace.events.map((event) => event.verb)).toContain("imported");
  });

  it("explains 'summarized' from the persisted summary's own creation provenance", async () => {
    const { store: db, databasePath } = await openStore();
    await db.saveSummary(summary({ id: "summary-summarized", scopeIds: ["scope-a"] }));

    const trace = await explain(db, "summary-summarized", authority(["scope-a"], databasePath));

    expect(trace.kind).toBe("summary");
    expect(trace.events.map((event) => event.verb)).toContain("summarized");
  });

  it("explains 'retrieved' as a structural authorized-presence fact for a scoped memory item", async () => {
    const { store: db, databasePath } = await openStore();
    await db.saveSummary(summary({ id: "summary-retrieved", scopeIds: ["scope-a"] }));

    const trace = await explain(db, "summary-retrieved", authority(["scope-a"], databasePath));

    expect(trace.events.map((event) => event.verb)).toContain("retrieved");
  });

  it("explains 'expanded' for expandable kinds (summary/box/trace)", async () => {
    const { store: db, databasePath } = await openStore();
    await db.saveSummary(summary({ id: "summary-expanded", scopeIds: ["scope-a"] }));

    const trace = await explain(db, "summary-expanded", authority(["scope-a"], databasePath));

    expect(trace.events.map((event) => event.verb)).toContain("expanded");
  });

  it("explains 'synchronized' from a sync_outbox row whose targetId matches the item", async () => {
    const { store: db, databasePath } = await openStore();
    await db.saveSummary(summary({ id: "summary-synchronized", scopeIds: ["scope-a"] }));
    await emitLocalSyncOperation(db, {
      personId: PERSON_ID,
      deviceId: DEFAULT_LOCAL_SYNC_DEVICE_ID,
      operationKind: "canonical_append",
      targetId: "summary-synchronized",
      effectFingerprint: mutationEffectsFingerprint({ synthetic: "synchronized" }),
      committedAt: NOW
    });

    const trace = await explain(db, "summary-synchronized", authority(["scope-a"], databasePath));

    expect(trace.events.map((event) => event.verb)).toContain("synchronized");
  });

  it("explains 'approved' from a proposal review decision targeting the item", async () => {
    const { store: db, databasePath } = await openStore();
    await db.saveSummary(summary({ id: "summary-for-approval", scopeIds: ["scope-a"] }));
    await db.saveBox(box({ id: "box-approved", summaryIds: ["summary-for-approval"] }));
    await db.saveProposal(proposal({
      id: "proposal-approved",
      state: "approved",
      targetBoxIds: ["box-approved"],
      sourceSummaryIds: ["summary-for-approval"]
    }));

    const trace = await explain(db, "box-approved", authority(["scope-a"], databasePath));

    expect(trace.events.map((event) => event.verb)).toContain("approved");
  });

  it("explains 'rejected' from a proposal review decision targeting the item", async () => {
    const { store: db, databasePath } = await openStore();
    await db.saveSummary(summary({ id: "summary-for-rejection", scopeIds: ["scope-a"] }));
    await db.saveTrace(trace({ id: "trace-rejected", summaryIds: ["summary-for-rejection", "summary-for-rejection-b"] }));
    await db.saveSummary(summary({ id: "summary-for-rejection-b", scopeIds: ["scope-a"] }));
    await db.saveProposal(proposal({
      id: "proposal-rejected",
      state: "rejected",
      targetTraceIds: ["trace-rejected"],
      sourceSummaryIds: ["summary-for-rejection", "summary-for-rejection-b"]
    }));

    const trace2 = await explain(db, "trace-rejected", authority(["scope-a"], databasePath));

    expect(trace2.events.map((event) => event.verb)).toContain("rejected");
  });

  it("explains 'deleted' from the source_lifecycle_audit 'deletion_completed' action", async () => {
    const { store: db, databasePath } = await openStore();
    const service = new SourceLifecycleService(db);
    await service.approve({
      personId: PERSON_ID,
      candidateId: "candidate-deleted",
      application: "synthetic-host",
      format: "jsonl",
      sourceLocator: "/synthetic/root",
      profileId: "synthetic-profile",
      scopeId: "scope-a",
      approvedAt: NOW
    });
    await service.revoke(PERSON_ID, "candidate-deleted", "user", NOW);
    await db.saveSourceLifecycleAuditEvent({
      id: "audit-deletion-completed",
      personId: PERSON_ID,
      grantId: service.grantId(PERSON_ID, "candidate-deleted"),
      candidateId: "candidate-deleted",
      action: "deletion_completed",
      actor: "user",
      occurredAt: NOW,
      details: { deletedCanonicalEventCount: 3, deletedSourceCount: 1 }
    });

    const trace3 = await explain(db, "candidate-deleted", authority(["scope-a"], databasePath));

    expect(trace3.kind).toBe("source");
    expect(trace3.events.map((event) => event.verb)).toContain("deleted");
  });

  it("returns the SAME UNAUTHORIZED_OR_NOT_FOUND for a scope-denied item and a nonexistent item (no existence oracle)", async () => {
    const { store: db, databasePath } = await openStore();
    await db.saveSummary(summary({ id: "summary-restricted", scopeIds: ["scope-restricted"] }));

    let restrictedMessage: string | undefined;
    try {
      await explain(db, "summary-restricted", authority(["scope-a"], databasePath));
    } catch (error) {
      restrictedMessage = error instanceof Error ? error.message : String(error);
    }

    let missingMessage: string | undefined;
    try {
      await explain(db, "does-not-exist-at-all", authority(["scope-a"], databasePath));
    } catch (error) {
      missingMessage = error instanceof Error ? error.message : String(error);
    }

    expect(restrictedMessage).toBe("UNAUTHORIZED_OR_NOT_FOUND");
    expect(missingMessage).toBe("UNAUTHORIZED_OR_NOT_FOUND");
    expect(restrictedMessage).toBe(missingMessage);
  });
});
