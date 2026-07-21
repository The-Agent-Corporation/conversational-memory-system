import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMemoryStatusCommand } from "../../src/bootstrap/status-command.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";
import {
  CommitLocalSyncOperationInputSchema,
  syncEffectFingerprint,
  type CommitLocalSyncOperationInput
} from "../../src/storage/sync-contracts.js";
import type { MemoryProposal, Summary } from "../../src/domain/types.js";
import type { SummaryVectorRecord } from "../../src/storage/memory-store.js";

const localInput = (overrides: Partial<CommitLocalSyncOperationInput> = {}): CommitLocalSyncOperationInput =>
  CommitLocalSyncOperationInputSchema.parse({
    operation: "local_sync_operation",
    personId: "person_1",
    deviceId: "device_a",
    operationKind: "canonical_append",
    targetId: "event_1",
    outboxId: "outbox_1",
    expectedFrontierSequence: 0,
    deviceSequence: 1,
    predecessorDigest: null,
    effectFingerprint: syncEffectFingerprint({ targetId: "event_1" }),
    committedAt: "2026-07-19T12:00:00.000Z",
    receipt: {
      operation: "local_sync_operation",
      status: "COMMITTED",
      personId: "person_1",
      targetId: "event_1",
      committedAt: "2026-07-19T12:00:00.000Z"
    },
    ...overrides
  });

const makeProposal = (overrides: Partial<MemoryProposal> = {}): MemoryProposal => ({
  id: "proposal_trace_smith_pip_bills",
  personId: "person_1",
  proposalType: "trace",
  state: "proposed",
  title: "Smith PIP Provider Bill Review",
  rationale: "Two summaries continue the same Smith PIP provider bill review issue.",
  confidence: 0.78,
  createdAt: "2026-05-07T12:00:00.000Z",
  reviewedAt: "2026-05-07T12:00:00.000Z",
  decidedAt: null,
  decidedBy: null,
  decisionNote: null,
  sourceSummaryIds: ["summary_1", "summary_3"],
  sourceTurnRanges: [{ threadId: "profile:default", startSequence: 1, endSequence: 3 }],
  targetBoxIds: ["box_topic_smith_pip"],
  targetTraceIds: ["trace_smith_pip_bills"],
  payload: {
    traceId: "trace_smith_pip_bills",
    title: "Smith PIP Provider Bill Review",
    description: "Non-contiguous summaries continue the Smith PIP provider bill review issue.",
    traceType: "case_issue",
    summaryIds: ["summary_1", "summary_3"],
    boxIds: ["box_topic_smith_pip"],
    turnRanges: [{ threadId: "profile:default", startSequence: 1, endSequence: 3 }],
    continuityReason: "Both summaries discuss Smith PIP provider bill review.",
    boundaryReason: "Smith BI summaries were excluded.",
    keywords: ["smith", "pip", "provider", "bill"]
  },
  ...overrides
});

describe("memory status health surface", () => {
  let tempDirectory: string | undefined;

  afterEach(async () => {
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
  });

  it("reports db size, schema version, sync lag, pending proposals, and deterministic latency", async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "memory-status-command-"));
    const databasePath = join(tempDirectory, "memory.db");
    const store = new SqliteStore(databasePath);
    await store.savePerson({ id: "person_1", displayName: null, createdAt: "2026-07-16T10:00:00.000Z" });
    await store.commitLocalSyncOperation(localInput());
    await store.saveProposal(makeProposal());
    store.close();

    let clockCalls = 0;
    const fakeClock = {
      now: () => {
        clockCalls += 1;
        return clockCalls === 1 ? 1_000 : 1_500;
      }
    };

    const status = await runMemoryStatusCommand({
      databasePath,
      personId: "person_1",
      clock: fakeClock
    });

    expect(status.dbFileSizeBytes).toBeGreaterThan(0);
    expect(status.schemaVersion).toBeGreaterThanOrEqual(1);
    expect(status.schemaMigrationAppliedAt === null || typeof status.schemaMigrationAppliedAt === "string").toBe(true);
    expect(status.syncLag.pendingOutboxOperationCount).toBe(1);
    expect(status.syncLag.oldestPendingOutboxCreatedAt).toBe("2026-07-19T12:00:00.000Z");
    expect(status.pendingProposalCount).toBe(1);
    expect(status.performance.queryLatencyMs).toBe(500);
    expect(typeof status.performance.indexStatsAvailable).toBe("boolean");
    expect(clockCalls).toBe(2);

    // Existing fields are retained (no removals).
    expect(status.ok).toBe(true);
    expect(status.personId).toBe("person_1");
    expect(status.daemon.state).toBe("stopped");
  });

  it("reports zero sync lag and pending proposals against an empty fixture", async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "memory-status-command-empty-"));
    const databasePath = join(tempDirectory, "memory.db");
    const store = new SqliteStore(databasePath);
    await store.savePerson({ id: "person_1", displayName: null, createdAt: "2026-07-16T10:00:00.000Z" });
    store.close();

    const status = await runMemoryStatusCommand({ databasePath, personId: "person_1" });

    expect(status.syncLag.pendingOutboxOperationCount).toBe(0);
    expect(status.syncLag.oldestPendingOutboxCreatedAt).toBeNull();
    expect(status.pendingProposalCount).toBe(0);
    expect(status.performance.queryLatencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe("memory status embeddingBackfill snapshot (REQ-042 SC4)", () => {
  let tempDirectory: string | undefined;

  afterEach(async () => {
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
  });

  const summaryRecord = (overrides: Partial<Summary> = {}): Summary => ({
    id: "summary_1",
    summaryText: "Fixture summary for status backfill snapshot tests.",
    sourceTurnRanges: [],
    sourceSummaryIds: [],
    boxIds: [],
    embedding: null,
    createdAt: "2026-07-21T12:00:00.000Z",
    model: "test-summarizer",
    promptVersion: "v1",
    confidence: 0.9,
    state: "compacted",
    detailLevel: "brief",
    tokenCount: 10,
    lastAccessedAt: null,
    version: 1,
    strength: 0.8,
    retrievalCount: 0,
    retrievedAt: null,
    halfLifeHours: 168,
    outcomeScore: null,
    ...overrides
  });

  const vectorRecord = (overrides: Partial<SummaryVectorRecord> = {}): SummaryVectorRecord => ({
    summaryId: "summary_1",
    provider: "deterministic",
    model: "keyword-hash-v1",
    dimensions: 4,
    vector: [0.5, -0.25, 0.75, 0.125],
    personId: "person_1",
    scopeIds: ["personal"],
    createdAt: "2026-07-21T12:00:00.000Z",
    ...overrides
  });

  it("reports full completeness gap for a disabled-default corpus with zero vectors", async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "memory-status-backfill-disabled-"));
    const databasePath = join(tempDirectory, "memory.db");
    const store = new SqliteStore(databasePath);
    await store.savePerson({ id: "person_1", displayName: null, createdAt: "2026-07-16T10:00:00.000Z" });
    const summaryIds = ["summary_a", "summary_b", "summary_c"];
    for (const summaryId of summaryIds) {
      await store.saveSummary(summaryRecord({ id: summaryId }));
    }
    store.close();

    const status = await runMemoryStatusCommand({ databasePath, personId: "person_1" });

    expect(status.embeddingBackfill).toEqual({
      provider: "deterministic",
      model: "keyword-hash-v1",
      totalSummaries: summaryIds.length,
      missingVectors: summaryIds.length,
      completedFraction: 0
    });
  });

  it("reports a partial completeness fraction when some summaries already have vectors", async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "memory-status-backfill-partial-"));
    const databasePath = join(tempDirectory, "memory.db");
    const store = new SqliteStore(databasePath);
    await store.savePerson({ id: "person_1", displayName: null, createdAt: "2026-07-16T10:00:00.000Z" });
    const summaryIds = ["summary_a", "summary_b", "summary_c", "summary_d"];
    const vectoredIds = new Set(["summary_a", "summary_c"]);
    for (const summaryId of summaryIds) {
      await store.saveSummary(summaryRecord({ id: summaryId }));
    }
    for (const summaryId of summaryIds) {
      if (vectoredIds.has(summaryId)) {
        await store.saveSummaryVector(vectorRecord({ summaryId }));
      }
    }
    store.close();

    const status = await runMemoryStatusCommand({ databasePath, personId: "person_1" });

    const totalSummaries = summaryIds.length;
    const missingVectors = totalSummaries - vectoredIds.size;
    expect(status.embeddingBackfill.provider).toBe("deterministic");
    expect(status.embeddingBackfill.model).toBe("keyword-hash-v1");
    expect(status.embeddingBackfill.totalSummaries).toBe(totalSummaries);
    expect(status.embeddingBackfill.missingVectors).toBe(missingVectors);
    expect(status.embeddingBackfill.completedFraction).toBe(
      (totalSummaries - missingVectors) / totalSummaries
    );
  });

  it("reports a completed fraction of 1 with zero missing vectors for an empty corpus", async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "memory-status-backfill-empty-"));
    const databasePath = join(tempDirectory, "memory.db");
    const store = new SqliteStore(databasePath);
    await store.savePerson({ id: "person_1", displayName: null, createdAt: "2026-07-16T10:00:00.000Z" });
    store.close();

    const status = await runMemoryStatusCommand({ databasePath, personId: "person_1" });

    expect(status.embeddingBackfill.totalSummaries).toBe(0);
    expect(status.embeddingBackfill.missingVectors).toBe(0);
    expect(status.embeddingBackfill.completedFraction).toBe(1);
  });
});
