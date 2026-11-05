/**
 * Phase 0 characterization: a rejected value comes back when the next candidate
 * has a different id. Duplicate detection treats rejection as absence unless the
 * id matches exactly.
 */
import { expect, it } from "vitest";
import { DeterministicBoxProposalPlanner } from "../../src/boxes/box-proposal-planner.js";
import type { Box, MemoryProposal, Summary } from "../../src/domain/types.js";

const turnRange = { threadId: "profile:default", startSequence: 1, endSequence: 3 };

const summary = (overrides: Partial<Summary> = {}): Summary => ({
  id: "summary_1",
  summaryText: "Smith PIP coverage provider bill review.",
  sourceTurnRanges: [turnRange],
  sourceSummaryIds: [],
  boxIds: [],
  embedding: null,
  createdAt: "2026-05-01T00:00:00.000Z",
  model: "test",
  promptVersion: "v1",
  confidence: 0.9,
  state: "compacted",
  detailLevel: "brief",
  tokenCount: 8,
  lastAccessedAt: null,
  version: 1,
  strength: 0.8,
  retrievalCount: 0,
  retrievedAt: null,
  halfLifeHours: 24,
  outcomeScore: null,
  ...overrides
});

const rejectedBox = (overrides: Partial<Box> = {}): Box => ({
  id: "box_rejected_previous_identity",
  title: "Smith PIP",
  description: "Rejected Smith PIP box.",
  parentBoxId: null,
  childBoxIds: [],
  summaryIds: ["summary_1", "summary_2"],
  turnRanges: [turnRange],
  state: "rejected",
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: "2026-05-02T00:00:00.000Z",
  caseId: null,
  boxType: "topic",
  summary: "Smith PIP coverage provider bill review.",
  lastActivityAt: "2026-05-02T00:00:00.000Z",
  ...overrides
});

const rejectedProposal = (overrides: Partial<MemoryProposal> = {}): MemoryProposal => ({
  id: "proposal_rejected_previous_identity",
  proposalType: "box",
  state: "rejected",
  title: "Smith PIP",
  rationale: "Rejected Smith PIP proposal.",
  confidence: 0.75,
  createdAt: "2026-05-07T12:00:00.000Z",
  reviewedAt: "2026-05-07T12:00:00.000Z",
  decidedAt: "2026-05-07T12:05:00.000Z",
  decidedBy: "reviewer",
  decisionNote: "Do not keep this box.",
  sourceSummaryIds: ["summary_1", "summary_2"],
  sourceTurnRanges: [turnRange],
  targetBoxIds: ["box_topic_smith_pip_retired"],
  targetTraceIds: [],
  payload: {
    boxId: "box_topic_smith_pip_retired",
    title: "Smith PIP",
    description: "Rejected Smith PIP topic box.",
    summary: "Smith PIP coverage provider bill review.",
    boxType: "topic",
    candidateParentBoxId: null,
    keywords: ["smith", "pip"],
    evidence: ["Shared keywords: smith, pip"],
    sourceSummaryIds: ["summary_1", "summary_2"],
    sourceTurnRanges: [turnRange]
  },
  ...overrides
});

const summaries = (): Summary[] => [
  summary({ id: "summary_1", summaryText: "Smith PIP coverage provider bill review." }),
  summary({
    id: "summary_2",
    summaryText: "Smith PIP provider bill deadline and coverage timing.",
    sourceTurnRanges: [{ threadId: "profile:default", startSequence: 20, endSequence: 22 }]
  })
];

it("FINDING rejected box value re-enters under a new box id", async () => {
  const planner = new DeterministicBoxProposalPlanner();
  const result = await planner.proposeBoxes({
    reviewedAt: "2026-05-07T12:00:00.000Z",
    summaries: summaries(),
    boxes: [rejectedBox()],
    anchors: [],
    proposals: [],
    minimumSummariesPerBox: 2,
    minimumConfidence: 0.5
  });

  expect(
    result.proposals.filter((proposal) => proposal.proposalType === "box").map((proposal) => proposal.id),
    "FINDING rejected value re-enters with a new box id"
  ).toEqual([]);
});

it("FINDING rejected proposal value re-enters under a new proposal id", async () => {
  const planner = new DeterministicBoxProposalPlanner();
  const result = await planner.proposeBoxes({
    reviewedAt: "2026-05-07T12:00:00.000Z",
    summaries: summaries(),
    boxes: [],
    anchors: [],
    proposals: [rejectedProposal()],
    minimumSummariesPerBox: 2,
    minimumConfidence: 0.5
  });

  expect(
    result.proposals.filter((proposal) => proposal.proposalType === "box").map((proposal) => proposal.id),
    "FINDING rejected value re-enters with a new proposal id"
  ).toEqual([]);
});
