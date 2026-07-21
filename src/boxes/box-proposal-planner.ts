import { createHash } from "node:crypto";
import type { Anchor, Box, MemoryProposal, Summary } from "../domain/types.js";
import {
  dedupeTurnRanges,
  hasExistingProposal,
  latestSummaryTimestamp,
  sharedTerms,
  significantTerms,
  slugify,
  titleCase
} from "../proposals/proposal-utils.js";

export interface BoxProposalPlanningRequest {
  reviewedAt: string;
  idNamespace?: string;
  summaries: Summary[];
  boxes: Box[];
  anchors: Anchor[];
  proposals: MemoryProposal[];
  minimumSummariesPerBox?: number;
  minimumConfidence?: number;
}

export interface BoxProposalPlanningResult {
  proposals: MemoryProposal[];
  skippedCandidates: { title: string; summaryIds: string[]; reason: string }[];
}

export interface BoxProposalPlanner {
  proposeBoxes(request: BoxProposalPlanningRequest): Promise<BoxProposalPlanningResult>;
}

interface CandidateGroup {
  title: string;
  titleTerms: string[];
  sharedSpecificTerms: string[];
  keywords: string[];
  summaries: Summary[];
}

export class DeterministicBoxProposalPlanner implements BoxProposalPlanner {
  async proposeBoxes(request: BoxProposalPlanningRequest): Promise<BoxProposalPlanningResult> {
    const minimumSummaries = request.minimumSummariesPerBox ?? 2;
    const minimumConfidence = request.minimumConfidence ?? 0.5;
    const skippedCandidates: BoxProposalPlanningResult["skippedCandidates"] = [];
    const groups = buildCandidateGroups(request.summaries);
    const proposals: MemoryProposal[] = [];

    for (const group of groups) {
      if (group.summaries.length < minimumSummaries) {
        skippedCandidates.push({
          title: group.title,
          summaryIds: group.summaries.map((summary) => summary.id),
          reason: "Insufficient source summaries"
        });
        continue;
      }

      if (group.sharedSpecificTerms.length < 2) {
        skippedCandidates.push({
          title: group.title,
          summaryIds: group.summaries.map((summary) => summary.id),
          reason: "Insufficient shared specific terms"
        });
        continue;
      }

      const confidence = Number(Math.min(
        0.9,
        0.45 + group.sharedSpecificTerms.length * 0.1 + group.summaries.length * 0.05
      ).toFixed(2));
      if (confidence < minimumConfidence) {
        skippedCandidates.push({
          title: group.title,
          summaryIds: group.summaries.map((summary) => summary.id),
          reason: "Confidence below threshold"
        });
        continue;
      }

      const boxId = scopedId(`box_topic_${slugify(group.title)}`, request.idNamespace);
      const proposalId = `proposal_box_${boxId}`;
      if (hasDuplicateBox(request.boxes, request.proposals, boxId, group.title, proposalId)) {
        skippedCandidates.push({
          title: group.title,
          summaryIds: group.summaries.map((summary) => summary.id),
          reason: "Duplicate box or proposal already exists"
        });
        continue;
      }

      const parent = findCandidateParent(group, request.boxes);
      proposals.push(buildBoxProposal(group, request.reviewedAt, confidence, parent, request.idNamespace));
      if (parent) {
        proposals.push(buildParentChildProposal(parent.id, boxId, group, request.reviewedAt, confidence));
      }
    }

    return { proposals, skippedCandidates };
  }
}

// Mutable accumulator for a candidate group. `keywords` is a Set so unioning a joining summary's
// terms is O(terms) instead of rebuilding the whole array; membership tests against it are O(1).
// The array-based CandidateGroup (below) rebuilt the keyword array and re-scanned it on every join,
// which is O(members * vocabulary) per group -- quadratic for the large groups a bulk bootstrap
// produces (tens of thousands of summaries sharing a title). This version is linear in total terms.
interface WorkingGroup {
  title: string;
  titleTerms: string[];
  sharedSpecificTerms: string[];
  keywords: Set<string>;
  summaries: Summary[];
}

function buildCandidateGroups(summaries: Summary[]): CandidateGroup[] {
  const groups = new Map<string, WorkingGroup>();

  for (const summary of summaries) {
    const terms = significantTerms(summary.summaryText);
    if (terms.length < 2) {
      continue;
    }

    const titleTerms = terms.slice(0, 2);
    const title = titleCase(titleTerms.join(" "));
    const key = slugify(title);
    const existing = groups.get(key);

    if (!existing) {
      groups.set(key, {
        title,
        titleTerms,
        sharedSpecificTerms: [...titleTerms],
        keywords: new Set(terms),
        summaries: [summary]
      });
      continue;
    }

    // Overlap between this summary's terms and the group's accumulated keywords, computed against
    // the keyword set BEFORE this summary is unioned in. Only its exact value is needed when it is
    // small (< 2), in which case it has 0-1 elements and is order-independent; otherwise just the
    // count matters. This preserves the original sharedTerms(existing.keywords, terms) semantics.
    let sharedCount = 0;
    for (const term of terms) if (existing.keywords.has(term)) sharedCount += 1;
    const sharedSmall = sharedCount < 2 ? terms.filter((term) => existing.keywords.has(term)) : null;

    // Running intersection of the group's shared-specific terms with this summary's terms.
    const termsSet = new Set(terms);
    existing.sharedSpecificTerms = existing.sharedSpecificTerms.filter((term) => termsSet.has(term));
    for (const term of terms) existing.keywords.add(term);
    existing.summaries.push(summary);
    if (sharedSmall) existing.sharedSpecificTerms = sharedSmall;
  }

  return [...groups.values()].map((group) => ({
    title: group.title,
    titleTerms: group.titleTerms,
    sharedSpecificTerms: group.sharedSpecificTerms,
    keywords: [...group.keywords],
    summaries: group.summaries
  }));
}

function buildBoxProposal(
  group: CandidateGroup,
  reviewedAt: string,
  confidence: number,
  parent: Box | null,
  idNamespace?: string
): MemoryProposal {
  const boxId = scopedId(`box_topic_${slugify(group.title)}`, idNamespace);
  const sourceSummaryIds = group.summaries.map((summary) => summary.id);
  const sourceTurnRanges = dedupeTurnRanges(group.summaries.flatMap((summary) => summary.sourceTurnRanges));
  const payload = {
    boxId,
    title: group.title,
    description: `Proposed topic box for ${group.title}.`,
    summary: group.summaries.map((summary) => summary.summaryText).join("\n\n"),
    boxType: "topic" as const,
    candidateParentBoxId: parent?.id ?? null,
    keywords: group.keywords,
    evidence: [
      `Shared keywords: ${group.sharedSpecificTerms.join(", ")}`,
      `${sourceSummaryIds.length} source summaries`
    ],
    sourceSummaryIds,
    sourceTurnRanges
  };

  return {
    id: `proposal_box_${boxId}`,
    proposalType: "box",
    state: "proposed",
    title: group.title,
    rationale: `${sourceSummaryIds.length} summaries share ${group.sharedSpecificTerms.join(", ")}.`,
    confidence,
    createdAt: reviewedAt,
    reviewedAt,
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    sourceSummaryIds,
    sourceTurnRanges,
    targetBoxIds: [boxId],
    targetTraceIds: [],
    payload
  };
}

function scopedId(baseId: string, namespace?: string): string {
  if (!namespace) return baseId;
  const suffix = createHash("sha256").update(namespace).digest("hex").slice(0, 12);
  return `${baseId}_${suffix}`;
}

function buildParentChildProposal(
  parentBoxId: string,
  childBoxId: string,
  group: CandidateGroup,
  reviewedAt: string,
  confidence: number
): MemoryProposal {
  const sourceSummaryIds = group.summaries.map((summary) => summary.id);
  const sourceTurnRanges = dedupeTurnRanges(group.summaries.flatMap((summary) => summary.sourceTurnRanges));
  const payload = {
    parentBoxId,
    childBoxId,
    relationshipLabel: "case subtopic",
    rationale: `${group.title} is narrower than the existing parent box.`,
    sourceSummaryIds
  };

  return {
    id: `proposal_parent_child_${parentBoxId}_${childBoxId}`,
    proposalType: "box_parent_child",
    state: "proposed",
    title: `${group.title} parent assignment`,
    rationale: payload.rationale,
    confidence: Math.max(0, Number((confidence - 0.05).toFixed(2))),
    createdAt: reviewedAt,
    reviewedAt,
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    sourceSummaryIds,
    sourceTurnRanges,
    targetBoxIds: [parentBoxId, childBoxId],
    targetTraceIds: [],
    payload
  };
}

function findCandidateParent(group: CandidateGroup, boxes: Box[]): Box | null {
  return boxes.find((box) => {
    if (box.state !== "approved" && box.state !== "active" && box.state !== "revived") {
      return false;
    }

    const parentTerms = significantTerms(`${box.title} ${box.summary}`);
    if (parentTerms.length === 0) {
      return false;
    }

    const shared = sharedTerms(parentTerms, group.titleTerms);
    return shared.length > 0 && group.titleTerms.length > shared.length;
  }) ?? null;
}

function hasDuplicateBox(
  boxes: Box[],
  proposals: MemoryProposal[],
  boxId: string,
  title: string,
  proposalId: string
): boolean {
  const normalizedTitle = title.trim().toLowerCase();
  return boxes.some((box) =>
    box.id === boxId ||
    (box.title.trim().toLowerCase() === normalizedTitle &&
      (box.state === "approved" || box.state === "active" || box.state === "revived" || box.state === "proposed"))
  ) || hasExistingProposal(proposals, proposalId);
}
