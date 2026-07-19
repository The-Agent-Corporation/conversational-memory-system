import { BoxProposalPayloadSchema, type Box, type MemoryProposal, type MemoryTrace, type Summary, type TurnRange } from "../domain/types.js";
import { DeterministicBoxProposalPlanner, type BoxProposalPlanner } from "../boxes/box-proposal-planner.js";
import { DeterministicTraceProposalPlanner, type TraceProposalPlanner } from "../traces/trace-proposal-planner.js";
import type { MemoryStore } from "../storage/memory-store.js";

export interface SleepReviewRequest {
  reviewedAt: string;
  personId?: string;
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

export interface StagedSleepReviewResult {
  boxes: Box[];
  proposals: MemoryProposal[];
  traces: MemoryTrace[];
  boxProposalCount: number;
  traceProposalCount: number;
}

export interface SleepReviewerOptions {
  boxPlanner?: BoxProposalPlanner;
  tracePlanner?: TraceProposalPlanner;
}

export class SleepReviewer {
  private readonly boxPlanner: BoxProposalPlanner;
  private readonly tracePlanner: TraceProposalPlanner;

  constructor(
    private readonly store: MemoryStore,
    options: SleepReviewerOptions = {}
  ) {
    this.boxPlanner = options.boxPlanner ?? new DeterministicBoxProposalPlanner();
    this.tracePlanner = options.tracePlanner ?? new DeterministicTraceProposalPlanner();
  }

  /**
   * Computes one complete review pass against this reviewer's store. Callers that
   * need an atomic publication boundary must supply an isolated staging store.
   */
  async stageProposals(request: SleepReviewRequest): Promise<StagedSleepReviewResult> {
    const boxReview = await this.proposeBoxes(request);
    const traceReview = await this.proposeTraces(request);
    return {
      boxes: boxReview.proposedBoxes,
      proposals: [...boxReview.proposals, ...traceReview.proposals],
      traces: [],
      boxProposalCount: boxReview.proposals.length,
      traceProposalCount: traceReview.proposals.length
    };
  }

  async proposeBoxes(request: SleepReviewRequest): Promise<SleepReviewResult> {
    const [summaries, boxes, anchors, proposals] = await Promise.all([
      this.store.listSummaries(),
      this.store.listBoxes(),
      this.store.listAnchors(),
      this.store.listProposals({ state: "proposed" })
    ]);
    const scopedSummaries = summaries.filter((summary) =>
      summary.state !== "superseded" && summary.personId === request.personId
    );
    const scopedBoxes = boxes.filter((box) => box.personId === request.personId);
    const scopedAnchors = anchors.filter((anchor) => anchor.personId === request.personId);
    const scopedProposals = proposals.filter((proposal) =>
      proposal.personId === request.personId
    );
    const result = await this.boxPlanner.proposeBoxes({
      reviewedAt: request.reviewedAt,
      idNamespace: request.personId,
      summaries: scopedSummaries,
      boxes: scopedBoxes,
      anchors: scopedAnchors,
      proposals: scopedProposals,
      minimumSummariesPerBox: request.minimumSummariesPerBox,
      minimumConfidence: request.minimumBoxConfidence
    });
    const proposedBoxes: Box[] = [];

    const scopedResultProposals = result.proposals.map((proposal) => ({
      ...proposal,
      ...(request.personId ? { personId: request.personId } : {})
    }));
    for (const proposal of scopedResultProposals) {
      await this.store.saveProposal(proposal);
      if (proposal.proposalType !== "box") {
        continue;
      }

      const box = buildProposedBoxFromProposal(
        proposal,
        request.reviewedAt,
        scopedSummaries
      );
      await this.store.saveBox(box);
      proposedBoxes.push(box);
    }

    return { proposedBoxes, proposals: scopedResultProposals };
  }

  async proposeTraces(request: SleepReviewRequest): Promise<TraceProposalReviewResult> {
    const [summaries, boxes, anchors, proposals, traces] = await Promise.all([
      this.store.listSummaries(),
      this.store.listBoxes(),
      this.store.listAnchors(),
      this.store.listProposals({ state: "proposed" }),
      this.store.listTraces()
    ]);
    const result = await this.tracePlanner.proposeTraces({
      reviewedAt: request.reviewedAt,
      idNamespace: request.personId,
      summaries: summaries.filter((summary) =>
        summary.state !== "superseded" && summary.personId === request.personId
      ),
      boxes: boxes.filter((box) => box.personId === request.personId),
      anchors: anchors.filter((anchor) => anchor.personId === request.personId),
      proposals: proposals.filter((proposal) => proposal.personId === request.personId),
      traces: traces.filter((trace) => trace.personId === request.personId),
      minimumTraceSummaries: request.minimumTraceSummaries,
      minimumConfidence: request.minimumTraceConfidence
    });

    const scopedProposals = result.proposals.map((proposal) => ({
      ...proposal,
      ...(request.personId ? { personId: request.personId } : {})
    }));
    for (const proposal of scopedProposals) {
      await this.store.saveProposal(proposal);
    }

    return { proposals: scopedProposals };
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
    ...(proposal.personId ? { personId: proposal.personId } : {}),
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
