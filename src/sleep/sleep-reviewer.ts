import {
  BoxProposalPayloadSchema,
  NON_SUPERSEDED_STATES,
  type Anchor,
  type Box,
  type MemoryProposal,
  type MemoryTrace,
  type Summary,
  type TurnRange
} from "../domain/types.js";
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
  /**
   * Where the reviewer's own writes land. Defaults to the read store, which is the standalone
   * behaviour every existing caller relies on.
   *
   * The daemon needs a review to publish atomically, so it passes an isolated staging store here.
   * It used to get that isolation by COPYING the entire derived corpus into an `InMemoryStore` and
   * pointing the reviewer at the copy -- measured at 1,089 MB of heap for a single call on the live
   * corpus (145,765 summaries, each materialised once from SQLite and again by the staging store's
   * `structuredClone` on write), which is what exhausted the daemon's heap. Reading durably and
   * writing to an empty staging store gives the same publication boundary for the size of the
   * OUTPUT rather than the size of the corpus.
   */
  writeStore?: MemoryStore;
}

/**
 * The summaries one review pass may consider, loaded once.
 *
 * Both planners cluster GLOBALLY -- which summaries group together depends on the whole candidate
 * set -- so this cannot be narrowed to a recent window without changing which boxes and traces get
 * proposed. What it can do is stop being loaded twice (once per planner) and stop dragging in the
 * 89,059 superseded rows that were only ever filtered out in JS.
 */
interface ReviewCandidates {
  summaries: Summary[];
  boxes: Box[];
  anchors: Anchor[];
  proposals: MemoryProposal[];
  traces: MemoryTrace[];
}

export class SleepReviewer {
  private readonly boxPlanner: BoxProposalPlanner;
  private readonly tracePlanner: TraceProposalPlanner;
  private readonly writeStore: MemoryStore;

  constructor(
    private readonly store: MemoryStore,
    options: SleepReviewerOptions = {}
  ) {
    this.boxPlanner = options.boxPlanner ?? new DeterministicBoxProposalPlanner();
    this.tracePlanner = options.tracePlanner ?? new DeterministicTraceProposalPlanner();
    this.writeStore = options.writeStore ?? store;
  }

  /**
   * One scoped read of everything a review pass considers.
   *
   * `states` is pushed into the store rather than filtered afterwards: on the live corpus that is
   * 145,765 rows loaded and Zod-parsed to keep 56,706. `personId` is passed for the same reason it
   * is elsewhere -- it excludes nothing on a single-person corpus, but a second person makes it
   * load-bearing rather than requiring this to be revisited.
   */
  private async loadCandidates(personId: string | undefined): Promise<ReviewCandidates> {
    const [summaries, boxes, anchors, proposals, traces] = await Promise.all([
      this.store.listSummaries({ ...(personId ? { personId } : {}), states: NON_SUPERSEDED_STATES }),
      this.store.listBoxes(),
      this.store.listAnchors(),
      this.store.listProposals({ state: "proposed" }),
      this.store.listTraces()
    ]);
    return {
      // The state predicate is re-applied here, not trusted from the query: `listSummaries` without
      // a filter is still a legal call shape, and a future caller passing none must not silently
      // start feeding superseded summaries to the planners.
      summaries: summaries.filter((summary) =>
        summary.state !== "superseded" && (!personId || summary.personId === personId)),
      boxes: boxes.filter((box) => !personId || box.personId === personId),
      anchors: anchors.filter((anchor) => !personId || anchor.personId === personId),
      proposals: proposals.filter((proposal) => !personId || proposal.personId === personId),
      traces: traces.filter((trace) => !personId || trace.personId === personId)
    };
  }

  /**
   * Computes one complete review pass against this reviewer's store. Callers that
   * need an atomic publication boundary must supply an isolated staging store.
   */
  async stageProposals(request: SleepReviewRequest): Promise<StagedSleepReviewResult> {
    // ONE load for both passes. They previously issued the same five whole-table reads each, so a
    // single review materialised the corpus twice over.
    const candidates = await this.loadCandidates(request.personId);
    const boxReview = await this.proposeBoxes(request, candidates);
    const traceReview = await this.proposeTraces(request, candidates);
    return {
      boxes: boxReview.proposedBoxes,
      proposals: [...boxReview.proposals, ...traceReview.proposals],
      traces: [],
      boxProposalCount: boxReview.proposals.length,
      traceProposalCount: traceReview.proposals.length
    };
  }

  async proposeBoxes(request: SleepReviewRequest, preloaded?: ReviewCandidates): Promise<SleepReviewResult> {
    const { summaries: scopedSummaries, boxes: scopedBoxes, anchors: scopedAnchors, proposals: scopedProposals } =
      preloaded ?? await this.loadCandidates(request.personId);
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
    // Built ONCE for the whole loop. See buildProposedBoxFromProposal.
    const summariesById = new Map(scopedSummaries.map((summary) => [summary.id, summary]));
    for (const proposal of scopedResultProposals) {
      await this.writeStore.saveProposal(proposal);
      if (proposal.proposalType !== "box") {
        continue;
      }

      const box = buildProposedBoxFromProposal(proposal, request.reviewedAt, summariesById);
      await this.writeStore.saveBox(box);
      proposedBoxes.push(box);
    }

    return { proposedBoxes, proposals: scopedResultProposals };
  }

  async proposeTraces(request: SleepReviewRequest, preloaded?: ReviewCandidates): Promise<TraceProposalReviewResult> {
    const candidates = preloaded ?? await this.loadCandidates(request.personId);
    const result = await this.tracePlanner.proposeTraces({
      reviewedAt: request.reviewedAt,
      idNamespace: request.personId,
      summaries: candidates.summaries,
      boxes: candidates.boxes,
      anchors: candidates.anchors,
      proposals: candidates.proposals,
      traces: candidates.traces,
      minimumTraceSummaries: request.minimumTraceSummaries,
      minimumConfidence: request.minimumTraceConfidence
    });

    const scopedProposals = result.proposals.map((proposal) => ({
      ...proposal,
      ...(request.personId ? { personId: request.personId } : {})
    }));
    for (const proposal of scopedProposals) {
      await this.writeStore.saveProposal(proposal);
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

      await this.writeStore.saveSummary(decayed);
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

      await this.writeStore.saveBox(refreshed);
      updatedBoxes.push(refreshed);
    }

    return { updatedBoxes };
  }
}

/**
 * Takes the id index rather than the summary list, because it is called once per proposal.
 *
 * It used to build `new Map(summaries.map(...))` itself, which on the live corpus is a
 * 56,706-entry Map allocated for EVERY box proposal in the review -- O(proposals x summaries).
 * That was the single largest allocation left in a review pass once the staged corpus copy was
 * removed: 901 MB -> 2,358 MB inside one `proposeBoxes` call, and then out of heap.
 */
function buildProposedBoxFromProposal(
  proposal: MemoryProposal,
  reviewedAt: string,
  summariesById: ReadonlyMap<string, Summary>
): Box {
  const payload = BoxProposalPayloadSchema.parse(proposal.payload);
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
