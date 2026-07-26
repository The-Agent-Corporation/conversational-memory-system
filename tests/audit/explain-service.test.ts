import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Box, MemoryProposal, MemoryTrace, Summary } from "../../src/domain/types.js";
import type { CanonicalEvent } from "../../src/domain/canonical.js";
import { createProfileAuthority, type ProfileAuthority } from "../../src/mcp/authority.js";
import { explain } from "../../src/audit/explain-service.js";
import { HYGIENE_RULE_VERSION } from "../../src/topic/derivation-hygiene.js";
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

const canonicalEvent = (input: {
  id: string;
  personId?: string;
  scopeId?: string;
  content: string;
  eventKind?: "message" | "tool_call";
  role?: CanonicalEvent["role"];
  nativeSequence?: number;
  occurredAt?: string;
}): CanonicalEvent => ({
  id: input.id,
  personId: input.personId ?? PERSON_ID,
  sourceId: "source-explain",
  sourceApplication: "synthetic-host",
  sourceProfileId: "synthetic-profile",
  scopeId: input.scopeId ?? "scope-a",
  nativeSessionId: "session-explain",
  nativeEventId: input.id,
  nativeSequence: input.nativeSequence ?? 1,
  causalParentId: null,
  eventKind: input.eventKind,
  role: input.role ?? "user",
  content: input.content,
  occurredAt: input.occurredAt ?? NOW,
  importedAt: NOW,
  provenance: "direct_user_input",
  trustLevel: "high",
  contentHash: `hash-${input.id}`,
  parserVersion: "synthetic/v1",
  metadata: {}
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

describe("explain() REQ-053 hygiene rationale (derivation input hygiene)", () => {
  let tempDir: string | undefined;
  let store: SqliteStore | undefined;

  afterEach(async () => {
    store?.close();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
    store = undefined;
  });

  const openStore = async (): Promise<{ store: SqliteStore; databasePath: string }> => {
    tempDir = await mkdtemp(join(tmpdir(), "memory-explain-hygiene-"));
    const databasePath = join(tempDir, "memory.sqlite");
    store = new SqliteStore(databasePath);
    return { store, databasePath };
  };

  const conversationalEvent = canonicalEvent({
    id: "event-conversational",
    content: "Plain conversational content that should never leak into an audit trace.",
    role: "user",
    nativeSequence: 1
  });
  const toolEventFixture = canonicalEvent({
    id: "event-tool",
    content: "[Tool call: Bash] {\"command\":\"ls\"}",
    eventKind: "tool_call",
    role: "assistant",
    nativeSequence: 2
  });
  const syntheticEventFixture = canonicalEvent({
    id: "event-synthetic",
    content: "[SYSTEM: harness preamble content that should never leak into an audit trace.]",
    role: "assistant",
    nativeSequence: 3
  });

  const seedHygieneEvents = async (db: SqliteStore): Promise<void> => {
    await db.saveCanonicalEvent(conversationalEvent);
    await db.saveCanonicalEvent(toolEventFixture);
    await db.saveCanonicalEvent(syntheticEventFixture);
  };

  it("hygiene: explaining a synthetic-injected event reports derivationClass, ruleId, and ruleVersion", async () => {
    const { store: db, databasePath } = await openStore();
    await seedHygieneEvents(db);

    const trace = await explain(db, "event-synthetic", authority(["scope-a"], databasePath));

    expect(trace.kind).toBe("event");
    const classified = trace.events.find((e) => e.verb === "classified");
    expect(classified).toBeDefined();
    expect(classified?.detail?.derivationClass).toBe("synthetic_injected");
    expect(classified?.detail?.ruleId).toBe("harness-system");
    expect(classified?.detail?.ruleVersion).toBe(HYGIENE_RULE_VERSION);
  });

  it("hygiene: explaining a tool_activity event reports derivationClass tool_activity with a null ruleId", async () => {
    const { store: db, databasePath } = await openStore();
    await seedHygieneEvents(db);

    const trace = await explain(db, "event-tool", authority(["scope-a"], databasePath));

    expect(trace.kind).toBe("event");
    const classified = trace.events.find((e) => e.verb === "classified");
    expect(classified?.detail?.derivationClass).toBe("tool_activity");
    expect(classified?.detail?.ruleId).toBe(null);
    expect(classified?.detail?.ruleVersion).toBe(HYGIENE_RULE_VERSION);
  });

  it("hygiene: explaining a conversational event reports derivationClass conversational with a null ruleId", async () => {
    const { store: db, databasePath } = await openStore();
    await seedHygieneEvents(db);

    const trace = await explain(db, "event-conversational", authority(["scope-a"], databasePath));

    expect(trace.kind).toBe("event");
    const classified = trace.events.find((e) => e.verb === "classified");
    expect(classified?.detail?.derivationClass).toBe("conversational");
    expect(classified?.detail?.ruleId).toBe(null);
    expect(classified?.detail?.ruleVersion).toBe(HYGIENE_RULE_VERSION);
  });

  it("hygiene: the classified detail never contains raw event content (ADR 0044)", async () => {
    const { store: db, databasePath } = await openStore();
    await seedHygieneEvents(db);

    const trace = await explain(db, "event-synthetic", authority(["scope-a"], databasePath));

    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain(syntheticEventFixture.content);
  });

  it("hygiene: a cross-person event, an out-of-scope event, and a nonexistent id all throw the SAME UNAUTHORIZED_OR_NOT_FOUND", async () => {
    const { store: db, databasePath } = await openStore();
    await seedHygieneEvents(db);
    await db.saveCanonicalEvent(canonicalEvent({
      id: "event-other-person",
      personId: "person-someone-else",
      content: "Belongs to another person entirely.",
      nativeSequence: 4
    }));
    await db.saveCanonicalEvent(canonicalEvent({
      id: "event-out-of-scope",
      scopeId: "scope-restricted",
      content: "Belongs to a scope the caller cannot see.",
      nativeSequence: 5
    }));

    const messageFor = async (itemId: string): Promise<string | undefined> => {
      try {
        await explain(db, itemId, authority(["scope-a"], databasePath));
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };

    const crossPersonMessage = await messageFor("event-other-person");
    const outOfScopeMessage = await messageFor("event-out-of-scope");
    const missingMessage = await messageFor("event-does-not-exist");

    expect(crossPersonMessage).toBe("UNAUTHORIZED_OR_NOT_FOUND");
    expect(outOfScopeMessage).toBe("UNAUTHORIZED_OR_NOT_FOUND");
    expect(missingMessage).toBe("UNAUTHORIZED_OR_NOT_FOUND");
  });

  it("hygiene: explaining a summary reports hygiene counts and rule ids for its source events", async () => {
    const { store: db, databasePath } = await openStore();
    await seedHygieneEvents(db);
    await db.saveSummary(summary({
      id: "summary-hygiene",
      scopeIds: ["scope-a"]
    }));
    await db.saveSummary({
      ...summary({ id: "summary-hygiene", scopeIds: ["scope-a"] }),
      sourceCanonicalEventIds: ["event-conversational", "event-tool", "event-synthetic"]
    });

    const trace = await explain(db, "summary-hygiene", authority(["scope-a"], databasePath));

    const summarized = trace.events.find((e) => e.verb === "summarized");
    expect(summarized).toBeDefined();
    expect(summarized?.detail?.sourceCanonicalEventCount).toBe(3);
    expect(summarized?.detail?.sourceSummaryCount).toBe(0);
    expect(summarized?.detail?.hygieneRuleVersion).toBe(HYGIENE_RULE_VERSION);
    expect(summarized?.detail?.conversationalEventCount).toBe(1);
    expect(summarized?.detail?.toolActivityEventCount).toBe(1);
    expect(summarized?.detail?.syntheticExcludedEventCount).toBe(1);
    expect(summarized?.detail?.excludedRuleIds).toBe("harness-system");
  });
});
