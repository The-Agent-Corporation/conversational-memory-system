import { describe, expect, it } from "vitest";
import { SourceLifecycleService } from "../../src/service/source-lifecycle-service.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import { MemoryService } from "../../src/service/memory-service.js";
import { historicalBootstrapCheckpointId } from "../../src/bootstrap/historical-bootstrapper.js";
import { QuarantineService } from "../../src/imports/quarantine-service.js";

const APPROVED_AT = "2026-07-17T12:00:00.000Z";
const REVOKED_AT = "2026-07-17T12:05:00.000Z";

describe("SourceLifecycleService", () => {
  it("persists exact person-owned approval and an inspectable audit event", async () => {
    const store = new InMemoryStore();
    const service = new SourceLifecycleService(store);

    const grant = await service.approve({
      personId: "person_1",
      candidateId: "candidate_1",
      application: "codex",
      format: "codex-rollout-jsonl",
      sourceLocator: "/approved/codex",
      profileId: "default",
      scopeId: "workspace_alpha",
      approvedAt: APPROVED_AT
    });

    await expect(service.assertApproved("person_1", "candidate_1")).resolves.toEqual(grant);
    await expect(store.listSourceGrants("person_1")).resolves.toEqual([grant]);
    await expect(store.listSourceLifecycleAuditEvents("person_1")).resolves.toEqual([
      expect.objectContaining({
        grantId: grant.id,
        candidateId: "candidate_1",
        action: "approved",
        details: expect.objectContaining({ scopeId: "workspace_alpha" })
      })
    ]);
    await expect(service.approve({
      personId: "person_1",
      candidateId: "candidate_1",
      application: "codex",
      format: "codex-rollout-jsonl",
      sourceLocator: "/approved/codex",
      profileId: "default",
      scopeId: "workspace_beta",
      approvedAt: REVOKED_AT
    })).rejects.toThrow(/Cannot change.*scope/);
  });

  it("revokes future access without changing another person's grant", async () => {
    const store = new InMemoryStore();
    const service = new SourceLifecycleService(store);
    for (const personId of ["person_1", "person_2"]) {
      await service.approve({
        personId,
        candidateId: "candidate_1",
        application: "codex",
        format: "codex-rollout-jsonl",
        sourceLocator: "/approved/codex",
        profileId: "default",
        approvedAt: APPROVED_AT
      });
    }

    const revoked = await service.revoke("person_1", "candidate_1", "user", REVOKED_AT);

    expect(revoked).toMatchObject({ state: "revoked", revokedAt: REVOKED_AT });
    await expect(service.assertApproved("person_1", "candidate_1")).rejects.toThrow(/not durably approved/);
    await expect(service.assertApproved("person_2", "candidate_1")).resolves.toMatchObject({ state: "approved" });
    await expect(store.listSourceLifecycleAuditEvents("person_1")).resolves.toEqual([
      expect.objectContaining({ action: "approved" }),
      expect.objectContaining({ action: "revoked" })
    ]);
  });

  it("requires exact confirmation and invalidates only memory derived from the revoked source", async () => {
    const store = new InMemoryStore();
    const lifecycle = new SourceLifecycleService(store);
    for (const candidateId of ["candidate_delete", "candidate_keep"]) {
      await lifecycle.approve({
        personId: "person_1",
        candidateId,
        application: "codex",
        format: "codex-rollout-jsonl",
        sourceLocator: `/native/${candidateId}`,
        profileId: "default",
        approvedAt: APPROVED_AT
      });
      await new MemoryService(store, {
        personId: "person_1",
        sourceInstanceId: candidateId,
        clock: () => APPROVED_AT
      }).ingestEvent({
        id: `message_${candidateId}`,
        nativeEventId: `message_${candidateId}`,
        host: "codex",
        profileId: "default",
        hostSessionId: `session_${candidateId}`,
        sequence: 1,
        type: "conversation_turn",
        role: "user",
        content: `Content from ${candidateId}`,
        createdAt: APPROVED_AT,
        metadata: {}
      });
    }
    const importedEvents = await store.listCanonicalEvents("person_1");
    const deletedEvent = importedEvents.find((event) => event.content.endsWith("candidate_delete"));
    const keptEvent = importedEvents.find((event) => event.content.endsWith("candidate_keep"));
    if (!deletedEvent || !keptEvent) throw new Error("Synthetic events were not imported");
    await store.saveSummary(makeSummary(deletedEvent.id));
    await store.saveBox(makeBox());
    await store.saveAnchor({
      id: "anchor_delete",
      personId: "person_1",
      canonicalEventId: deletedEvent.id,
      turnId: `turn_${deletedEvent.id}`,
      threadId: deletedEvent.nativeSessionId,
      boxId: "box_delete",
      anchorType: "key_fact",
      content: "Derived content",
      embedding: null,
      createdAt: APPROVED_AT,
      trustLevel: "high",
      source: "direct_user_input"
    });
    await store.saveInjection({
      id: "inject_delete",
      hostSessionId: "consumer_session",
      currentTopicSummary: "Deletion test",
      selectedMemory: "Derived content",
      sourceSummaryIds: ["summary_delete"],
      sourceTraceIds: [],
      sourceTurnRanges: [{ threadId: deletedEvent.nativeSessionId, startSequence: 1, endSequence: 1 }],
      boxIds: ["box_delete"],
      relevanceReason: "test",
      confidence: 1,
      disclosureText: "test",
      createdAt: APPROVED_AT
    });
    await store.saveBootstrapCheckpoint({
      id: historicalBootstrapCheckpointId("person_1"),
      personId: "person_1",
      processorVersion: "historical-bootstrap/v1",
      processedEventCount: 2,
      lastCanonicalEventId: keptEvent.id,
      rollingPrefixHash: "hash",
      activeTopic: null,
      updatedAt: APPROVED_AT
    });
    await new QuarantineService(store, () => APPROVED_AT).capture({
      personId: "person_1",
      candidateId: "candidate_delete",
      resourcePath: "sessions/deleted.jsonl",
      recordPosition: "3",
      parserVersion: "test/v1",
      reason: "malformed_json",
      rawRecord: `malformed password=hunter2 ${"x".repeat(10_000)}`
    });
    const [quarantined] = await store.listQuarantineRecords("person_1", "candidate_delete");
    expect(Buffer.byteLength(quarantined.sanitizedRecord)).toBeLessThanOrEqual(8_192);
    expect(quarantined.sanitizedRecord).not.toContain("hunter2");
    expect(quarantined.rawByteLength).toBeGreaterThan(8_192);

    await expect(lifecycle.deleteRevokedSource({
      personId: "person_1",
      candidateId: "candidate_delete",
      confirmedCandidateId: "wrong",
      actor: "user",
      deletedAt: REVOKED_AT
    })).rejects.toThrow(/confirmation/);
    await expect(lifecycle.deleteRevokedSource({
      personId: "person_1",
      candidateId: "candidate_delete",
      confirmedCandidateId: "candidate_delete",
      actor: "user",
      deletedAt: REVOKED_AT
    })).rejects.toThrow(/revoked/);

    await lifecycle.revoke("person_1", "candidate_delete", "user", REVOKED_AT);
    const result = await lifecycle.deleteRevokedSource({
      personId: "person_1",
      candidateId: "candidate_delete",
      confirmedCandidateId: "candidate_delete",
      actor: "user",
      deletedAt: REVOKED_AT
    });

    expect(result).toMatchObject({
      deletedCanonicalEventCount: 1,
      deletedSourceCount: 1,
      deletedAnchorCount: 1,
      supersededSummaryCount: 1,
      supersededBoxCount: 1
    });
    await expect(store.listCanonicalEvents("person_1")).resolves.toEqual([keptEvent]);
    await expect(store.listSources("person_1")).resolves.toHaveLength(1);
    await expect(store.listSummaries()).resolves.toEqual([
      expect.objectContaining({ id: "summary_delete", state: "superseded" })
    ]);
    await expect(store.listBoxes()).resolves.toEqual([
      expect.objectContaining({ id: "box_delete", state: "superseded" })
    ]);
    await expect(store.listAnchors()).resolves.toEqual([]);
    await expect(store.listInjections("consumer_session")).resolves.toEqual([]);
    await expect(store.listQuarantineRecords("person_1", "candidate_delete")).resolves.toEqual([]);
    await expect(store.getBootstrapCheckpoint(historicalBootstrapCheckpointId("person_1")))
      .resolves.toBeNull();
    await expect(store.listSourceLifecycleAuditEvents("person_1")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ candidateId: "candidate_delete", action: "deletion_requested" }),
        expect.objectContaining({ candidateId: "candidate_delete", action: "deletion_completed" })
      ])
    );
  });
});

function makeSummary(canonicalEventId: string) {
  return {
    id: "summary_delete",
    personId: "person_1",
    origin: "historical_bootstrap" as const,
    summaryText: "Derived content",
    sourceTurnRanges: [{ threadId: "person:person_1", startSequence: 1, endSequence: 1 }],
    sourceCanonicalEventIds: [canonicalEventId],
    sourceSummaryIds: [],
    boxIds: ["box_delete"],
    embedding: null,
    createdAt: APPROVED_AT,
    model: "test",
    promptVersion: "v1",
    confidence: 1,
    state: "compacted" as const,
    detailLevel: "brief" as const,
    tokenCount: 2,
    lastAccessedAt: null,
    version: 1,
    strength: 0.5,
    retrievalCount: 0,
    retrievedAt: null,
    halfLifeHours: 168,
    outcomeScore: null
  };
}

function makeBox() {
  return {
    id: "box_delete",
    personId: "person_1",
    title: "Derived box",
    description: "Derived content",
    parentBoxId: null,
    childBoxIds: [],
    summaryIds: ["summary_delete"],
    turnRanges: [{ threadId: "person:person_1", startSequence: 1, endSequence: 1 }],
    state: "approved" as const,
    createdAt: APPROVED_AT,
    updatedAt: APPROVED_AT,
    caseId: null,
    boxType: "topic" as const,
    summary: "Derived content",
    lastActivityAt: APPROVED_AT
  };
}
