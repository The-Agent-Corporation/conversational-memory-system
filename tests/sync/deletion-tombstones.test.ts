import { describe, expect, it } from "vitest";
import {
  SyncMaterializer,
  type CanonicalAppendMaterializerOperation,
  type MaterializationContext,
  type QuarantineResolutionMaterializerOperation,
  type TombstoneCreateMaterializerOperation
} from "../../src/sync/materialization/sync-materializer.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import { SourceLifecycleService } from "../../src/service/source-lifecycle-service.js";
import { syntheticId } from "./fixtures.js";

const PERSON_ID = syntheticId("tombstone-person");
const SCOPE_ID = syntheticId("tombstone-scope");
const SOURCE_ID = syntheticId("tombstone-source");

function context(overrides: Partial<MaterializationContext> = {}): MaterializationContext {
  return {
    personId: PERSON_ID,
    activeScopeIds: new Set([SCOPE_ID]),
    activeSourceIds: new Set([SOURCE_ID]),
    knownOperationIds: new Set(),
    ...overrides
  };
}

function canonicalOp(label: string, overrides: Partial<CanonicalAppendMaterializerOperation> = {}): CanonicalAppendMaterializerOperation {
  return {
    kind: "canonical_append",
    operationId: syntheticId(`op-${label}`),
    personId: PERSON_ID,
    deviceId: syntheticId("device-a"),
    sequence: 1,
    causalHeads: [],
    sourceId: SOURCE_ID,
    scopeId: SCOPE_ID,
    canonicalEventId: syntheticId(`event-${label}`),
    canonicalEvent: { role: "user", content: label },
    ...overrides
  };
}

function sourceTombstone(label: string, overrides: Partial<TombstoneCreateMaterializerOperation> = {}): TombstoneCreateMaterializerOperation {
  return {
    kind: "tombstone_create",
    operationId: syntheticId(`tombstone-${label}`),
    personId: PERSON_ID,
    deviceId: syntheticId("device-a"),
    sequence: 1,
    causalHeads: [],
    targetType: "source",
    targetId: SOURCE_ID,
    sourceId: SOURCE_ID,
    tombstoneKind: "deletion",
    ...overrides
  };
}

describe("SyncMaterializer deletion, tombstone, and quarantine lifecycle", () => {
  it("quarantines content covered by a same-batch source tombstone before it can be accepted", () => {
    const tombstone = sourceTombstone("main");
    const covered = canonicalOp("covered");
    const materializer = new SyncMaterializer();

    const result = materializer.materializeBatch([tombstone, covered], context());

    expect(result.canonical).toHaveLength(0);
    expect(result.tombstones.map((item) => item.targetId)).toEqual([SOURCE_ID]);
    expect(result.quarantine.map((item) => item.targetId)).toEqual([covered.canonicalEventId]);
  });

  it("quarantines content even when the tombstone is delivered after the covered content in the same batch", () => {
    const tombstone = sourceTombstone("late");
    const covered = canonicalOp("late-covered");
    const materializer = new SyncMaterializer();

    // Control-first (two-pass) processing means delivery order within the batch cannot matter.
    const result = materializer.materializeBatch([covered, tombstone], context());

    expect(result.canonical).toHaveLength(0);
    expect(result.quarantine.map((item) => item.targetId)).toEqual([covered.canonicalEventId]);
  });

  it("quarantines content covered by a tombstone already known from a prior batch", () => {
    const covered = canonicalOp("prior-covered");
    const materializer = new SyncMaterializer();
    const result = materializer.materializeBatch([covered], context({ priorTombstonedSourceIds: new Set([SOURCE_ID]) }));

    expect(result.canonical).toHaveLength(0);
    expect(result.quarantine.map((item) => item.targetId)).toEqual([covered.canonicalEventId]);
  });

  it("keep_deletion permanently disposes the quarantined offer, retains the tombstone, and creates no active content", () => {
    const tombstone = sourceTombstone("keep");
    const covered = canonicalOp("keep-covered");
    const keepDeletion: QuarantineResolutionMaterializerOperation = {
      kind: "quarantine_resolution",
      operationId: syntheticId("keep-resolution"),
      personId: PERSON_ID,
      deviceId: syntheticId("device-b"),
      sequence: 2,
      causalHeads: [tombstone.operationId],
      tombstoneOperationId: tombstone.operationId,
      resolution: "keep_deletion"
    };
    const materializer = new SyncMaterializer();

    const result = materializer.materializeBatch([tombstone, covered, keepDeletion], context());

    expect(result.canonical).toHaveLength(0);
    expect(result.restoredCanonicalEventIds).toHaveLength(0);
    expect(result.quarantine.some((item) => item.disposed)).toBe(true);
    expect(result.tombstones.map((item) => item.targetId)).toEqual([SOURCE_ID]);
  });

  it("restore_reviewed activates only the exact bounded restored content while the tombstone remains", () => {
    const tombstone = sourceTombstone("restore");
    const restore: QuarantineResolutionMaterializerOperation = {
      kind: "quarantine_resolution",
      operationId: syntheticId("restore-resolution"),
      personId: PERSON_ID,
      deviceId: syntheticId("device-b"),
      sequence: 2,
      causalHeads: [tombstone.operationId],
      tombstoneOperationId: tombstone.operationId,
      resolution: "restore_reviewed",
      restoredCanonicalEventIds: [syntheticId("restored-event")]
    };
    const materializer = new SyncMaterializer();

    const result = materializer.materializeBatch([tombstone, restore], context());

    expect(result.restoredCanonicalEventIds).toEqual([syntheticId("restored-event")]);
    expect(result.tombstones.map((item) => item.targetId)).toEqual([SOURCE_ID]);
  });

  it("rejects a quarantine resolution naming an unknown tombstone operation, leaving state unchanged", () => {
    const resolution: QuarantineResolutionMaterializerOperation = {
      kind: "quarantine_resolution",
      operationId: syntheticId("orphan-resolution"),
      personId: PERSON_ID,
      deviceId: syntheticId("device-b"),
      sequence: 1,
      causalHeads: [],
      tombstoneOperationId: syntheticId("nonexistent-tombstone"),
      resolution: "keep_deletion"
    };
    const materializer = new SyncMaterializer();
    const result = materializer.materializeBatch([resolution], context());

    expect(result.rejected).toContainEqual({
      operationId: resolution.operationId,
      reason: expect.stringContaining("unknown tombstone")
    });
  });
});

describe("SourceLifecycleService atomic revocation/deletion sync emission", () => {
  it("emits exactly one source_revocation sync outbox operation after a committed revocation", async () => {
    const store = new InMemoryStore();
    const service = new SourceLifecycleService(store);
    await service.approve({
      personId: PERSON_ID, candidateId: "candidate-1", application: "codex", format: "jsonl",
      sourceLocator: "/tmp/x", profileId: "profile-1", approvedAt: "2030-01-01T00:00:00.000Z"
    });

    await service.revoke(PERSON_ID, "candidate-1", "user", "2030-01-02T00:00:00.000Z");

    const outbox = await store.listSyncOutboxOperations(PERSON_ID);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.operationKind).toBe("source_revocation");
    expect(outbox[0]!.targetId).toBe("candidate-1");
  });

  it("emits exactly one source_deletion sync outbox operation after a committed deletion, chained after revocation", async () => {
    const store = new InMemoryStore();
    const service = new SourceLifecycleService(store);
    await service.approve({
      personId: PERSON_ID, candidateId: "candidate-2", application: "codex", format: "jsonl",
      sourceLocator: "/tmp/y", profileId: "profile-1", approvedAt: "2030-01-01T00:00:00.000Z"
    });
    await service.revoke(PERSON_ID, "candidate-2", "user", "2030-01-02T00:00:00.000Z");

    await service.deleteRevokedSource({
      personId: PERSON_ID, candidateId: "candidate-2", confirmedCandidateId: "candidate-2",
      actor: "user", deletedAt: "2030-01-03T00:00:00.000Z"
    });

    const outbox = await store.listSyncOutboxOperations(PERSON_ID);
    expect(outbox.map((item) => item.operationKind)).toEqual(["source_revocation", "source_deletion"]);
    expect(outbox.map((item) => item.deviceSequence)).toEqual([1, 2]);
    expect(outbox[1]!.predecessorDigest).toBe(outbox[0]!.effectFingerprint);
  });

  it("emits a quarantine_resolution operation for an explicit keep-deletion decision", async () => {
    const store = new InMemoryStore();
    const service = new SourceLifecycleService(store);
    await service.keepDeletion({
      personId: PERSON_ID, candidateId: "candidate-3", tombstoneTargetId: "candidate-3",
      actor: "user", decidedAt: "2030-01-04T00:00:00.000Z"
    });

    const outbox = await store.listSyncOutboxOperations(PERSON_ID);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.operationKind).toBe("quarantine_resolution");
  });
});
