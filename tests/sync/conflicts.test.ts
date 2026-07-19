import { describe, expect, it } from "vitest";
import {
  SyncMaterializer,
  type MaterializationContext,
  type ReviewDecisionMaterializerOperation
} from "../../src/sync/materialization/sync-materializer.js";
import { reorderSchedule, syntheticId } from "./fixtures.js";

const PERSON_ID = syntheticId("conflict-person");

function context(overrides: Partial<MaterializationContext> = {}): MaterializationContext {
  return {
    personId: PERSON_ID,
    activeScopeIds: new Set(),
    activeSourceIds: new Set(),
    knownOperationIds: new Set(),
    ...overrides
  };
}

function reviewOp(
  label: string,
  overrides: Partial<ReviewDecisionMaterializerOperation> = {}
): ReviewDecisionMaterializerOperation {
  return {
    kind: "review_decision",
    operationId: syntheticId(`review-${label}`),
    personId: PERSON_ID,
    deviceId: syntheticId(`device-${label}`),
    sequence: 1,
    causalHeads: [],
    reviewTargetId: syntheticId("proposal-target"),
    reviewBaseVersion: "initial",
    decision: "approve",
    ...overrides
  };
}

describe("SyncMaterializer review-decision conflicts", () => {
  it("preserves both operations in an explicit unresolved conflict when concurrent decisions disagree", () => {
    const approve = reviewOp("approve", { deviceId: syntheticId("device-a"), decision: "approve" });
    const reject = reviewOp("reject", { deviceId: syntheticId("device-b"), decision: "reject" });
    const materializer = new SyncMaterializer();

    const forward = materializer.materializeBatch([approve, reject], context());
    const backward = materializer.materializeBatch([reject, approve], context());

    for (const result of [forward, backward]) {
      expect(result.reviewOutcomes).toHaveLength(1);
      const [outcome] = result.reviewOutcomes;
      expect(outcome!.status).toBe("unresolved");
      if (outcome!.status === "unresolved") {
        expect(outcome!.conflictingOperationIds).toEqual([approve.operationId, reject.operationId].sort());
      }
    }
    expect(forward.reviewOutcomes).toEqual(backward.reviewOutcomes);
  });

  it("resolves to the single decision when concurrent decisions agree, without a timestamp winner", () => {
    const first = reviewOp("agree-a", { deviceId: syntheticId("device-a"), decision: "approve" });
    const second = reviewOp("agree-b", { deviceId: syntheticId("device-b"), decision: "approve" });
    const materializer = new SyncMaterializer();

    const result = materializer.materializeBatch(reorderSchedule([first, second], 5), context());

    expect(result.reviewOutcomes).toHaveLength(1);
    expect(result.reviewOutcomes[0]!.status).toBe("resolved");
    if (result.reviewOutcomes[0]!.status === "resolved") {
      expect(result.reviewOutcomes[0]!.decision).toBe("approve");
    }
  });

  it("applies a causally later decision as an override, not a conflict", () => {
    const initial = reviewOp("initial", { deviceId: syntheticId("device-a"), decision: "reject" });
    const override = reviewOp("override", {
      deviceId: syntheticId("device-a"),
      sequence: 2,
      causalHeads: [initial.operationId],
      reviewBaseVersion: "initial",
      decision: "approve"
    });
    const materializer = new SyncMaterializer();

    const result = materializer.materializeBatch([initial, override], context());

    // A single causal chain at the same base is a valid override, not a two-value unresolved conflict.
    expect(result.reviewOutcomes).toHaveLength(1);
    expect(result.rejected.some((item) => item.operationId === initial.operationId)).toBe(false);
  });

  it("requires an explicit resolution naming every conflicting operation ID to resolve an unresolved conflict", () => {
    const approve = reviewOp("approve", { deviceId: syntheticId("device-a"), decision: "approve" });
    const reject = reviewOp("reject", { deviceId: syntheticId("device-b"), decision: "reject" });
    const materializer = new SyncMaterializer();

    const conflictOnly = materializer.materializeBatch([approve, reject], context());
    const conflictToken = conflictOnly.reviewOutcomes[0]!.versionToken;

    const resolution = reviewOp("resolution", {
      deviceId: syntheticId("device-c"),
      sequence: 3,
      causalHeads: [approve.operationId, reject.operationId],
      reviewBaseVersion: conflictToken,
      decision: "approve"
    });

    const resolved = materializer.materializeBatch([approve, reject, resolution], context());
    expect(resolved.reviewOutcomes).toHaveLength(1);
    expect(resolved.reviewOutcomes[0]!.status).toBe("resolved");
    if (resolved.reviewOutcomes[0]!.status === "resolved") {
      expect(resolved.reviewOutcomes[0]!.resolvingOperationId).toBe(resolution.operationId);
    }
  });

  it("rejects a decision made against a stale base version, leaving the frontier unchanged", () => {
    const initial = reviewOp("initial-a", { deviceId: syntheticId("device-a"), decision: "approve" });
    const stale = reviewOp("stale", {
      deviceId: syntheticId("device-b"),
      reviewBaseVersion: syntheticId("nonexistent-version"),
      decision: "reject"
    });
    const materializer = new SyncMaterializer();

    const result = materializer.materializeBatch([initial, stale], context());
    expect(result.reviewOutcomes).toHaveLength(1);
    expect(result.reviewOutcomes[0]!.status).toBe("resolved");
    if (result.reviewOutcomes[0]!.status === "resolved") {
      expect(result.reviewOutcomes[0]!.resolvingOperationId).toBe(initial.operationId);
    }
    expect(result.rejected.some((item) => item.operationId === stale.operationId)).toBe(true);
  });
});
