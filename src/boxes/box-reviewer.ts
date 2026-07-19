import type { Box, Summary } from "../domain/types.js";
import type { MemoryStore } from "../storage/memory-store.js";

export interface BoxReviewRequest {
  boxId: string;
  reviewedAt: string;
}

export interface BoxReviewResult {
  box: Box;
  updatedSummaries: Summary[];
}

export class BoxReviewer {
  constructor(private readonly store: MemoryStore) {}

  async approveBox(request: BoxReviewRequest): Promise<BoxReviewResult> {
    const box = await this.loadProposedBox(request.boxId);
    const approvedBox: Box = {
      ...box,
      state: "approved",
      updatedAt: request.reviewedAt
    };
    const updatedSummaries = await this.attachSummaries(approvedBox);

    await this.store.saveBox(approvedBox);
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
    return { box: rejectedBox, updatedSummaries: [] };
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
