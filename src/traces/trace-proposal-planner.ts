import { createHash } from "node:crypto";
import type { Anchor, Box, MemoryProposal, MemoryTrace, Summary } from "../domain/types.js";
import {
  dedupeTurnRanges,
  hasExistingProposal,
  sharedTerms,
  significantTerms,
  slugify,
  titleCase
} from "../proposals/proposal-utils.js";

export interface TraceProposalPlanningRequest {
  reviewedAt: string;
  idNamespace?: string;
  summaries: Summary[];
  boxes: Box[];
  anchors: Anchor[];
  proposals: MemoryProposal[];
  traces: MemoryTrace[];
  minimumTraceSummaries?: number;
  minimumConfidence?: number;
}

export interface TraceProposalPlanningResult {
  proposals: MemoryProposal[];
  skippedCandidates: { title: string; summaryIds: string[]; reason: string }[];
}

export interface TraceProposalPlanner {
  proposeTraces(request: TraceProposalPlanningRequest): Promise<TraceProposalPlanningResult>;
}

interface TraceCandidate {
  title: string;
  traceId: string;
  summaries: Summary[];
  keywords: string[];
  continuityTerms: string[];
  boxIds: string[];
}

const BROAD_TRACE_TERMS = new Set(["smith", "jones", "case", "matter", "claim", "coverage"]);

export class DeterministicTraceProposalPlanner implements TraceProposalPlanner {
  async proposeTraces(request: TraceProposalPlanningRequest): Promise<TraceProposalPlanningResult> {
    const minimumTraceSummaries = request.minimumTraceSummaries ?? 2;
    const minimumConfidence = request.minimumConfidence ?? 0.5;
    const skippedCandidates: TraceProposalPlanningResult["skippedCandidates"] = [];
    const proposals: MemoryProposal[] = [];

    for (const candidate of buildTraceCandidates(
      request.summaries,
      request.boxes,
      request.idNamespace
    )) {
      if (candidate.continuityTerms.length < 2) {
        skippedCandidates.push({
          title: candidate.title,
          summaryIds: candidate.summaries.map((summary) => summary.id),
          reason: "Only broad shared terms"
        });
        continue;
      }

      if (candidate.summaries.length < minimumTraceSummaries) {
        skippedCandidates.push({
          title: candidate.title,
          summaryIds: candidate.summaries.map((summary) => summary.id),
          reason: "Insufficient source summaries"
        });
        continue;
      }

      if (!hasNonContiguousRanges(candidate.summaries)) {
        skippedCandidates.push({
          title: candidate.title,
          summaryIds: candidate.summaries.map((summary) => summary.id),
          reason: "No non-contiguous source ranges"
        });
        continue;
      }

      const confidence = Number(Math.min(
        0.9,
        0.45 + candidate.continuityTerms.length * 0.1 + candidate.summaries.length * 0.05
      ).toFixed(2));
      if (confidence < minimumConfidence) {
        skippedCandidates.push({
          title: candidate.title,
          summaryIds: candidate.summaries.map((summary) => summary.id),
          reason: "Confidence below threshold"
        });
        continue;
      }

      const proposalId = `proposal_trace_${candidate.traceId}`;
      if (hasExistingProposal(request.proposals, proposalId) ||
        request.traces.some((trace) => trace.id === candidate.traceId && trace.state !== "rejected")) {
        skippedCandidates.push({
          title: candidate.title,
          summaryIds: candidate.summaries.map((summary) => summary.id),
          reason: "Duplicate trace or proposal already exists"
        });
        continue;
      }

      proposals.push(buildTraceProposal(candidate, request.reviewedAt, confidence));
    }

    return { proposals, skippedCandidates };
  }
}

function buildTraceCandidates(
  summaries: Summary[],
  boxes: Box[],
  idNamespace?: string
): TraceCandidate[] {
  const candidates = new Map<string, TraceCandidate>();

  for (let leftIndex = 0; leftIndex < summaries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < summaries.length; rightIndex += 1) {
      const left = summaries[leftIndex];
      const right = summaries[rightIndex];
      const leftTerms = significantTerms(left.summaryText);
      const rightTerms = significantTerms(right.summaryText);
      const shared = sharedTerms(leftTerms, rightTerms);
      if (shared.length === 0) {
        continue;
      }

      const continuityTerms = shared.filter((term) => !BROAD_TRACE_TERMS.has(term));
      const titleTerms = shared
        .filter((term, index, terms) => terms.indexOf(term) === index)
        .slice(0, 4);
      const title = titleCase(titleTerms.join(" "));
      const traceId = scopedId(`trace_${slugify(title)}`, idNamespace);
      const existing = candidates.get(traceId);
      const pairSummaries = [left, right];
      const summariesForCandidate = existing
        ? mergeSummaries(existing.summaries, pairSummaries)
        : pairSummaries;

      candidates.set(traceId, {
        title,
        traceId,
        summaries: summariesForCandidate,
        keywords: [...new Set([...(existing?.keywords ?? []), ...shared])],
        continuityTerms: [...new Set([...(existing?.continuityTerms ?? []), ...continuityTerms])],
        boxIds: matchingBoxIds(summariesForCandidate, boxes)
      });
    }
  }

  return [...candidates.values()];
}

function scopedId(baseId: string, namespace?: string): string {
  if (!namespace) return baseId;
  const suffix = createHash("sha256").update(namespace).digest("hex").slice(0, 12);
  return `${baseId}_${suffix}`;
}

function buildTraceProposal(candidate: TraceCandidate, reviewedAt: string, confidence: number): MemoryProposal {
  const sourceSummaryIds = candidate.summaries.map((summary) => summary.id);
  const sourceTurnRanges = dedupeTurnRanges(candidate.summaries.flatMap((summary) => summary.sourceTurnRanges));
  const continuityReason = `Summaries share continuing terms: ${candidate.continuityTerms.join(", ")}.`;
  const payload = {
    traceId: candidate.traceId,
    title: candidate.title,
    description: `Non-contiguous summaries continue ${candidate.title}.`,
    traceType: "case_issue" as const,
    summaryIds: sourceSummaryIds,
    boxIds: candidate.boxIds,
    turnRanges: sourceTurnRanges,
    continuityReason,
    boundaryReason: "Related summaries without the same specific continuity terms were excluded.",
    keywords: candidate.keywords
  };

  return {
    id: `proposal_trace_${candidate.traceId}`,
    proposalType: "trace",
    state: "proposed",
    title: candidate.title,
    rationale: continuityReason,
    confidence,
    createdAt: reviewedAt,
    reviewedAt,
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    sourceSummaryIds,
    sourceTurnRanges,
    targetBoxIds: candidate.boxIds,
    targetTraceIds: [candidate.traceId],
    payload
  };
}

function mergeSummaries(existing: Summary[], additions: Summary[]): Summary[] {
  const byId = new Map(existing.map((summary) => [summary.id, summary]));
  for (const summary of additions) {
    byId.set(summary.id, summary);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function matchingBoxIds(summaries: Summary[], boxes: Box[]): string[] {
  const summaryIds = new Set(summaries.map((summary) => summary.id));
  return boxes
    .filter((box) => box.summaryIds.some((summaryId) => summaryIds.has(summaryId)))
    .map((box) => box.id)
    .sort();
}

function hasNonContiguousRanges(summaries: Summary[]): boolean {
  const ranges = summaries.flatMap((summary) => summary.sourceTurnRanges);
  for (let leftIndex = 0; leftIndex < ranges.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < ranges.length; rightIndex += 1) {
      const left = ranges[leftIndex];
      const right = ranges[rightIndex];
      if (left.threadId !== right.threadId) {
        return true;
      }
      if (right.startSequence > left.endSequence + 1 || left.startSequence > right.endSequence + 1) {
        return true;
      }
    }
  }

  return new Set(summaries.map((summary) => summary.createdAt)).size > 1;
}
