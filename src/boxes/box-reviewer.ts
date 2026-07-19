import type { Box, Summary } from "../domain/types.js";
import type { MemoryStore } from "../storage/memory-store.js";
import { mutationEffectsFingerprint } from "../storage/mcp-mutation-contracts.js";
import {
  DEFAULT_LOCAL_SYNC_DEVICE_ID,
  emitLocalSyncOperation
} from "../sync/materialization/sync-materializer.js";

export interface BoxReviewRequest {
  boxId: string;
  reviewedAt: string;
}

export interface BoxReviewResult {
  box: Box;
  updatedSummaries: Summary[];
}

export class BoxReviewer {
  private readonly syncDeviceId: string;

  constructor(private readonly store: MemoryStore, options: { syncDeviceId?: string } = {}) {
    this.syncDeviceId = options.syncDeviceId ?? DEFAULT_LOCAL_SYNC_DEVICE_ID;
  }

  async approveBox(request: BoxReviewRequest): Promise<BoxReviewResult> {
    const box = await this.loadProposedBox(request.boxId);
    const approvedBox: Box = {
      ...box,
      state: "approved",
      updatedAt: request.reviewedAt
    };
    const updatedSummaries = await this.attachSummaries(approvedBox);

    await this.store.saveBox(approvedBox);
    await this.emitReviewedBoxDecision(approvedBox, updatedSummaries, "approved", request.reviewedAt);
    return { box: approvedBox, updatedSummaries };
  }

  async rejectBox(request: BoxReviewRequest): Promise<BoxReviewResult> {
    const box = await this.loadProposedBox(request.boxId);
    const rejectedBox: Box = {
      ...box,
      state: "rejected",
      updatedAt: request.reviewedAt
    };

    await this.store.saveBox(rejectedBox);
    await this.emitReviewedBoxDecision(rejectedBox, [], "rejected", request.reviewedAt);
    return { box: rejectedBox, updatedSummaries: [] };
  }

  private async emitReviewedBoxDecision(
    box: Box,
    updatedSummaries: Summary[],
    decision: "approved" | "rejected",
    reviewedAt: string
  ): Promise<void> {
    if (!box.personId) return; // legacy unscoped boxes carry no person to bind a sync operation to
    await emitLocalSyncOperation(this.store, {
      personId: box.personId,
      deviceId: this.syncDeviceId,
      operationKind: "reviewed_box_decision",
      targetId: box.id,
      effectFingerprint: mutationEffectsFingerprint({
        boxId: box.id,
        decision,
        summaryIds: decision === "approved" ? [...updatedSummaries.map((item) => item.id)].sort() : []
      }),
      committedAt: reviewedAt
    });
  }

  private async loadProposedBox(boxId: string): Promise<Box> {
    const box = (await this.store.listBoxes()).find((candidate) => candidate.id === boxId);

    if (!box) {
      throw new Error(`Box ${boxId} was not found.`);
    }
    if (box.state !== "proposed") {
      throw new Error(`Box ${boxId} is not proposed.`);
    }

    return box;
  }

  private async attachSummaries(box: Box): Promise<Summary[]> {
    const summaries = await this.store.listSummaries();
    const updatedSummaries: Summary[] = [];

    for (const summary of summaries) {
      if (
        summary.personId !== box.personId ||
        !box.summaryIds.includes(summary.id) ||
        summary.boxIds.includes(box.id)
      ) {
        continue;
      }

      const updatedSummary: Summary = {
        ...summary,
        boxIds: [...summary.boxIds, box.id]
      };
      await this.store.saveSummary(updatedSummary);
      updatedSummaries.push(updatedSummary);
    }

    return updatedSummaries;
  }
}
