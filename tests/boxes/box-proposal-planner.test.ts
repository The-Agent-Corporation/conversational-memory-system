import { describe, expect, it } from "vitest";
import type { Box, Summary } from "../../src/domain/types.js";
import { DeterministicBoxProposalPlanner } from "../../src/boxes/box-proposal-planner.js";

const summary = (overrides: Partial<Summary> = {}): Summary => ({
  id: "summary_1",
  summaryText: "Smith PIP coverage provider bill review.",
  sourceTurnRanges: [{ threadId: "profile:default", startSequence: 1, endSequence: 3 }],
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

const box = (overrides: Partial<Box> = {}): Box => ({
  id: "box_case_smith",
  title: "Smith",
  description: "Existing case box.",
  parentBoxId: null,
  childBoxIds: [],
  summaryIds: ["summary_case"],
  turnRanges: [{ threadId: "profile:default", startSequence: 1, endSequence: 3 }],
  state: "approved",
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: "2026-05-01T00:00:00.000Z",
  caseId: "smith",
  boxType: "case",
  summary: "Smith case overview.",
  lastActivityAt: "2026-05-01T00:00:00.000Z",
  ...overrides
});

describe("DeterministicBoxProposalPlanner", () => {
  it("proposes a Smith PIP box from repeated Smith PIP summaries", async () => {
    const planner = new DeterministicBoxProposalPlanner();
    const result = await planner.proposeBoxes({
      reviewedAt: "2026-05-07T12:00:00.000Z",
      summaries: [
        summary({ id: "summary_1", summaryText: "Smith PIP coverage provider bill review." }),
        summary({
          id: "summary_2",
          summaryText: "Smith PIP provider bill deadline and coverage timing.",
          sourceTurnRanges: [{ threadId: "profile:default", startSequence: 20, endSequence: 22 }]
        })
      ],
      boxes: [],
      anchors: [],
      proposals: [],
      minimumSummariesPerBox: 2,
      minimumConfidence: 0.5
    });

    expect(result.proposals.map((proposal) => proposal.id)).toEqual(["proposal_box_box_topic_smith_pip"]);
    expect(result.proposals[0]).toMatchObject({
      proposalType: "box",
      title: "Smith PIP",
      confidence: expect.any(Number),
      targetBoxIds: ["box_topic_smith_pip"]
    });
  });

  it("does not merge Smith PIP and Smith BI into one child box", async () => {
    const planner = new DeterministicBoxProposalPlanner();
    const result = await planner.proposeBoxes({
      reviewedAt: "2026-05-07T12:00:00.000Z",
      summaries: [
        summary({ id: "summary_pip", summaryText: "Smith PIP coverage provider bill review." }),
        summary({
          id: "summary_bi",
          summaryText: "Smith BI coverage bodily injury demand strategy.",
          sourceTurnRanges: [{ threadId: "profile:default", startSequence: 40, endSequence: 42 }]
        })
      ],
      boxes: [],
      anchors: [],
      proposals: [],
      minimumSummariesPerBox: 2,
      minimumConfidence: 0.5
    });

    expect(result.proposals).toEqual([]);
  });

  it("avoids duplicate proposed boxes", async () => {
    const planner = new DeterministicBoxProposalPlanner();
    const result = await planner.proposeBoxes({
      reviewedAt: "2026-05-07T12:00:00.000Z",
      summaries: [
        summary({ id: "summary_1", summaryText: "Smith PIP coverage provider bill review." }),
        summary({
          id: "summary_2",
          summaryText: "Smith PIP provider bill deadline.",
          sourceTurnRanges: [{ threadId: "profile:default", startSequence: 20, endSequence: 22 }]
        })
      ],
      boxes: [box({ id: "box_topic_smith_pip", title: "Smith PIP", state: "approved" })],
      anchors: [],
      proposals: [],
      minimumSummariesPerBox: 2,
      minimumConfidence: 0.5
    });

    expect(result.proposals).toEqual([]);
  });

  it("proposes Smith PIP as a child of an existing Smith case box", async () => {
    const planner = new DeterministicBoxProposalPlanner();
    const result = await planner.proposeBoxes({
      reviewedAt: "2026-05-07T12:00:00.000Z",
      summaries: [
        summary({ id: "summary_1", summaryText: "Smith PIP coverage provider bill review." }),
        summary({
          id: "summary_2",
          summaryText: "Smith PIP provider bill deadline.",
          sourceTurnRanges: [{ threadId: "profile:default", startSequence: 20, endSequence: 22 }]
        })
      ],
      boxes: [box({ id: "box_case_smith", title: "Smith", boxType: "case", summary: "Smith case overview." })],
      anchors: [],
      proposals: [],
      minimumSummariesPerBox: 2,
      minimumConfidence: 0.5
    });

    expect(result.proposals.map((proposal) => proposal.proposalType)).toEqual(["box", "box_parent_child"]);
    expect(result.proposals[1].payload).toMatchObject({
      parentBoxId: "box_case_smith",
      childBoxId: "box_topic_smith_pip"
    });
  });
});
