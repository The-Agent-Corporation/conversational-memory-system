import { describe, expect, it } from "vitest";
import {
  SyncMaterializer,
  type CanonicalAppendMaterializerOperation,
  type MaterializationContext,
  type MaterializerOperation
} from "../../src/sync/materialization/sync-materializer.js";
import { reorderSchedule, duplicateSchedule, partitionSchedule, syntheticId } from "./fixtures.js";

const PERSON_ID = syntheticId("materializer-person");
const SCOPE_ID = syntheticId("materializer-scope");
const SOURCE_ID = syntheticId("materializer-source");
const OTHER_SCOPE_ID = syntheticId("materializer-scope-other");
const OTHER_SOURCE_ID = syntheticId("materializer-source-other");

function context(overrides: Partial<MaterializationContext> = {}): MaterializationContext {
  return {
    personId: PERSON_ID,
    activeScopeIds: new Set([SCOPE_ID]),
    activeSourceIds: new Set([SOURCE_ID]),
    knownOperationIds: new Set(),
    ...overrides
  };
}

function canonicalOp(
  label: string,
  overrides: Partial<CanonicalAppendMaterializerOperation> = {}
): CanonicalAppendMaterializerOperation {
  return {
    kind: "canonical_append",
    operationId: syntheticId(`op-${label}`),
    personId: PERSON_ID,
    deviceId: syntheticId("device-alpha"),
    sequence: 1,
    causalHeads: [],
    sourceId: SOURCE_ID,
    scopeId: SCOPE_ID,
    canonicalEventId: syntheticId(`event-${label}`),
    canonicalEvent: { role: "user", content: label },
    ...overrides
  };
}

function semanticSnapshot(result: ReturnType<SyncMaterializer["materializeBatch"]>) {
  return {
    canonicalEventIds: [...result.canonical.map((item) => item.canonicalEventId)].sort(),
    reviewOutcomes: [...result.reviewOutcomes].map((item) => ({ ...item })).sort((a, b) => a.reviewTargetId.localeCompare(b.reviewTargetId)),
    tombstoneTargetIds: [...result.tombstones.map((item) => item.targetId)].sort(),
    quarantineTargetIds: [...result.quarantine.map((item) => item.targetId)].sort()
  };
}

describe("SyncMaterializer convergence", () => {
  it("converges to the same canonical set across permutation, duplication, and partition schedules", () => {
    const ops: MaterializerOperation[] = Array.from({ length: 8 }, (_unused, index) =>
      canonicalOp(`c${index}`, { deviceId: syntheticId(`device-${index % 3}`), sequence: index + 1 }));

    const materializer = new SyncMaterializer();
    const baseline = semanticSnapshot(materializer.materializeBatch(ops, context()));

    const permuted = semanticSnapshot(materializer.materializeBatch(reorderSchedule(ops, 7), context()));
    expect(permuted).toEqual(baseline);

    const withDuplicates = semanticSnapshot(materializer.materializeBatch(duplicateSchedule(ops, 3), context()));
    expect(withDuplicates).toEqual(baseline);

    const partitions = partitionSchedule(ops, 3);
    const mergedFromPartitions = partitions.flatMap((partition) => partition);
    const partitioned = semanticSnapshot(materializer.materializeBatch(reorderSchedule(mergedFromPartitions, 3), context()));
    expect(partitioned).toEqual(baseline);

    // Restart: materializing the exact same batch again after a "restart" is idempotent.
    const restarted = semanticSnapshot(materializer.materializeBatch(ops, context()));
    expect(restarted).toEqual(baseline);
  });

  it("orders causally dependent operations deterministically regardless of delivery order", () => {
    const first = canonicalOp("first", { deviceId: syntheticId("device-a"), sequence: 1 });
    const second = canonicalOp("second", {
      deviceId: syntheticId("device-a"),
      sequence: 2,
      causalHeads: [first.operationId]
    });
    const materializer = new SyncMaterializer();

    const inOrder = materializer.materializeBatch([first, second], context());
    const reversed = materializer.materializeBatch([second, first], context());

    expect(inOrder.canonical.map((item) => item.canonicalEventId)).toEqual(reversed.canonical.map((item) => item.canonicalEventId));
    expect(inOrder.canonical[0]!.canonicalEventId).toBe(first.canonicalEventId);
    expect(inOrder.canonical[1]!.canonicalEventId).toBe(second.canonicalEventId);
  });

  it("late-arrival schedules still converge once the missing predecessor is present", () => {
    const a = canonicalOp("a", { deviceId: syntheticId("device-late"), sequence: 1 });
    const b = canonicalOp("b", { deviceId: syntheticId("device-late"), sequence: 2, causalHeads: [a.operationId] });
    const c = canonicalOp("c", { deviceId: syntheticId("device-late"), sequence: 3, causalHeads: [b.operationId] });
    const materializer = new SyncMaterializer();

    const lateBatch = materializer.materializeBatch([c, b, a], context());
    const onTimeBatch = materializer.materializeBatch([a, b, c], context());

    expect(semanticSnapshot(lateBatch)).toEqual(semanticSnapshot(onTimeBatch));
  });

  it("rejects an operation whose causal head is neither known nor present in the batch, leaving state unchanged", () => {
    const orphan = canonicalOp("orphan", { causalHeads: [syntheticId("missing-predecessor")] });
    const materializer = new SyncMaterializer();
    const result = materializer.materializeBatch([orphan], context());

    expect(result.canonical).toHaveLength(0);
    expect(result.rejected).toContainEqual({ operationId: orphan.operationId, reason: expect.stringContaining("Unknown causal dependency") });
  });

  it("accepts an operation whose causal head was already known from a prior batch", () => {
    const knownId = syntheticId("already-materialized");
    const op = canonicalOp("known-parent", { causalHeads: [knownId] });
    const materializer = new SyncMaterializer();
    const result = materializer.materializeBatch([op], context({ knownOperationIds: new Set([knownId]) }));

    expect(result.canonical.map((item) => item.canonicalEventId)).toEqual([op.canonicalEventId]);
    expect(result.rejected).toHaveLength(0);
  });

  it("leaves active state unchanged for cross-person, cross-scope, and cross-source claims", () => {
    const crossPerson = canonicalOp("cross-person", { personId: syntheticId("other-person") });
    const crossScope = canonicalOp("cross-scope", { scopeId: OTHER_SCOPE_ID });
    const crossSource = canonicalOp("cross-source", { sourceId: OTHER_SOURCE_ID });
    const materializer = new SyncMaterializer();

    const result = materializer.materializeBatch([crossPerson, crossScope, crossSource], context());

    expect(result.canonical).toHaveLength(0);
    expect(result.rejected.map((item) => item.operationId).sort()).toEqual(
      [crossPerson.operationId, crossScope.operationId, crossSource.operationId].sort()
    );
  });

  it("is idempotent on exact duplicate operation IDs within one batch", () => {
    const op = canonicalOp("dup");
    const materializer = new SyncMaterializer();
    const result = materializer.materializeBatch([op, { ...op }, { ...op }], context());

    expect(result.canonical).toHaveLength(1);
    expect(result.affectedRange).toEqual({ start: 1, end: 1 });
  });
});
