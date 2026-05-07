import { BoxProposalPayloadSchema, type Box, type MemoryProposal, type Summary, type TurnRange } from "../domain/types.js";
import { DeterministicBoxProposalPlanner } from "../boxes/box-proposal-planner.js";
import { DeterministicTraceProposalPlanner } from "../traces/trace-proposal-planner.js";
import type { MemoryStore } from "../storage/memory-store.js";

export interface SleepReviewRequest {
  reviewedAt: string;
  minimumSummariesPerBox?: number;
  staleStrengthThreshold?: number;
  minimumBoxConfidence?: number;
  minimumTraceSummaries?: number;
  minimumTraceConfidence?: number;
}

export interface SleepReviewResult {
  proposedBoxes: Box[];
  proposals: MemoryProposal[];
}

export interface SummaryDecayResult {
  updatedSummaries: Summary[];
}

export interface BoxStateRefreshResult {
  updatedBoxes: Box[];
}

export interface TraceProposalReviewResult {
  proposals: MemoryProposal[];
}

export class SleepReviewer {
  constructor(private readonly store: MemoryStore) {}

  async proposeBoxes(request: SleepReviewRequest): Promise<SleepReviewResult> {
    const [summaries, boxes, anchors, proposals] = await Promise.all([
      this.store.listSummaries(),
      this.store.listBoxes(),
      this.store.listAnchors(),
      this.store.listProposals({ state: "proposed" })
    ]);
    const planner = new DeterministicBoxProposalPlanner();
    const result = await planner.proposeBoxes({
      reviewedAt: request.reviewedAt,
      summaries,
      boxes,
      anchors,
      proposals,
      minimumSummariesPerBox: request.minimumSummariesPerBox,
      minimumConfidence: request.minimumBoxConfidence
    });
    const proposedBoxes: Box[] = [];

    for (const proposal of result.proposals) {
      await this.store.saveProposal(proposal);
      if (proposal.proposalType !== "box") {
        continue;
      }

      const box = buildProposedBoxFromProposal(proposal, request.reviewedAt, summaries);
      await this.store.saveBox(box);
      proposedBoxes.push(box);
    }

    return { proposedBoxes, proposals: result.proposals };
  }

  async proposeTraces(request: SleepReviewRequest): Promise<TraceProposalReviewResult> {
    const [summaries, boxes, anchors, proposals, traces] = await Promise.all([
      this.store.listSummaries(),
      this.store.listBoxes(),
      this.store.listAnchors(),
      this.store.listProposals({ state: "proposed" }),
      this.store.listTraces()
    ]);
    const planner = new DeterministicTraceProposalPlanner();
    const result = await planner.proposeTraces({
      reviewedAt: request.reviewedAt,
      summaries,
      boxes,
      anchors,
      proposals,
      traces,
      minimumTraceSummaries: request.minimumTraceSummaries,
      minimumConfidence: request.minimumTraceConfidence
    });

    for (const proposal of result.proposals) {
      await this.store.saveProposal(proposal);
    }

    return { proposals: result.proposals };
  }

  async decaySummaries(request: SleepReviewRequest): Promise<SummaryDecayResult> {
    const summaries = await this.store.listSummaries();
    const updatedSummaries: Summary[] = [];
    const staleStrengthThreshold = request.staleStrengthThreshold ?? 0.2;

    for (const summary of summaries) {
      const decayed = decaySummary(summary, request.reviewedAt, staleStrengthThreshold);

      if (!decayed) {
        continue;
      }

      await this.store.saveSummary(decayed);
      updatedSummaries.push(decayed);
    }

    return { updatedSummaries };
  }

  async refreshBoxStates(request: SleepReviewRequest): Promise<BoxStateRefreshResult> {
    const [boxes, summaries] = await Promise.all([
      this.store.listBoxes(),
      this.store.listSummaries()
    ]);
    const summariesById = new Map(summaries.map((summary) => [summary.id, summary]));
    const updatedBoxes: Box[] = [];

    for (const box of boxes) {
      const refreshed = refreshBoxState(box, summariesById, request.reviewedAt);

      if (!refreshed) {
        continue;
      }

      await this.store.saveBox(refreshed);
      updatedBoxes.push(refreshed);
    }

    return { updatedBoxes };
  }
}

function buildProposedBoxFromProposal(proposal: MemoryProposal, reviewedAt: string, summaries: Summary[]): Box {
  const payload = BoxProposalPayloadSchema.parse(proposal.payload);
  const summariesById = new Map(summaries.map((summary) => [summary.id, summary]));
  const sourceSummaries = payload.sourceSummaryIds
    .map((summaryId) => summariesById.get(summaryId))
    .filter((summary): summary is Summary => summary !== undefined);

  return {
    id: payload.boxId,
    title: payload.title,
    description: `Proposed topic box from ${payload.sourceSummaryIds.length} related summaries.`,
    parentBoxId: null,
    childBoxIds: [],
    summaryIds: payload.sourceSummaryIds,
    turnRanges: payload.sourceTurnRanges,
    state: "proposed",
    createdAt: reviewedAt,
    updatedAt: reviewedAt,
    caseId: null,
    boxType: payload.boxType,
    summary: payload.summary,
    lastActivityAt: latestTimestamp(sourceSummaries.map((summary) => summary.createdAt)) ?? reviewedAt
  };
}

function dedupeTurnRanges(ranges: TurnRange[]): TurnRange[] {
  const seen = new Set<string>();
  const deduped: TurnRange[] = [];

  for (const range of ranges) {
    const key = `${range.threadId}:${range.startSequence}:${range.endSequence}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(range);
    }
  }

  return deduped;
}

function latestTimestamp(timestamps: string[]): string | null {
  return timestamps.sort().at(-1) ?? null;
}

function decaySummary(
  summary: Summary,
  reviewedAt: string,
  staleStrengthThreshold: number
): Summary | null {
  if (!isDecayEligible(summary)) {
    return null;
  }

  const referenceAt = summary.lastAccessedAt ?? summary.retrievedAt ?? summary.createdAt;
  const ageHours = hoursBetween(referenceAt, reviewedAt);

  if (ageHours <= 0) {
    return null;
  }

  const decayedStrength = roundStrength(
    summary.strength * Math.pow(0.5, ageHours / summary.halfLifeHours)
  );
  const decayedState = decayedStrength < staleStrengthThreshold ? "stale" : summary.state;

  if (decayedStrength === summary.strength && decayedState === summary.state) {
    return null;
  }

  return {
    ...summary,
    strength: decayedStrength,
    state: decayedState
  };
}

function isDecayEligible(summary: Summary): boolean {
  return summary.state === "compacted" || summary.state === "active" || summary.state === "revived" || summary.state === "stale";
}

function hoursBetween(start: string, end: string): number {
  return (Date.parse(end) - Date.parse(start)) / (1000 * 60 * 60);
}

function roundStrength(value: number): number {
  return Number(Math.max(0, Math.min(1, value)).toFixed(2));
}

function refreshBoxState(
  box: Box,
  summariesById: Map<string, Summary>,
  reviewedAt: string
): Box | null {
  if (!isBoxRefreshEligible(box) || box.summaryIds.length === 0) {
    return null;
  }

  const linkedSummaries = box.summaryIds
    .map((summaryId) => summariesById.get(summaryId))
    .filter((summary): summary is Summary => summary !== undefined);

  if (linkedSummaries.length === 0) {
    return null;
  }

  if (box.state === "stale" && linkedSummaries.some((summary) => summary.state === "revived")) {
    return {
      ...box,
      state: "revived",
      updatedAt: reviewedAt,
      lastActivityAt: reviewedAt
    };
  }

  if (box.state !== "stale" && linkedSummaries.every((summary) => summary.state === "stale")) {
    return {
      ...box,
      state: "stale",
      updatedAt: reviewedAt
    };
  }

  return null;
}

function isBoxRefreshEligible(box: Box): boolean {
  return box.state === "approved" || box.state === "active" || box.state === "revived" || box.state === "stale";
}
