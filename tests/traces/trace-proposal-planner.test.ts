import { describe, expect, it } from "vitest";
import type { Box, Summary } from "../../src/domain/types.js";
import { DeterministicTraceProposalPlanner } from "../../src/traces/trace-proposal-planner.js";

const summary = (overrides: Partial<Summary> = {}): Summary => ({
  id: "summary_1",
  summaryText: "Smith PIP provider bill review and coverage timing.",
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
  id: "box_topic_smith_pip",
  title: "Smith PIP",
  description: "Existing topic box.",
  parentBoxId: null,
  childBoxIds: [],
  summaryIds: ["summary_1", "summary_3"],
  turnRanges: [{ threadId: "profile:default", startSequence: 1, endSequence: 3 }],
  state: "approved",
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: "2026-05-01T00:00:00.000Z",
  caseId: "smith",
  boxType: "topic",
  summary: "Smith PIP",
  lastActivityAt: "2026-05-01T00:00:00.000Z",
  ...overrides
});

describe("DeterministicTraceProposalPlanner", () => {
  it("links non-contiguous Smith PIP bill review summaries", async () => {
    const planner = new DeterministicTraceProposalPlanner();
    const result = await planner.proposeTraces({
      reviewedAt: "2026-05-07T12:00:00.000Z",
      summaries: [
        summary({
          id: "summary_1",
          summaryText: "Smith PIP provider bill review and coverage timing.",
          sourceTurnRanges: [{ threadId: "profile:default", startSequence: 1, endSequence: 3 }]
        }),
        summary({
          id: "summary_3",
          summaryText: "Smith PIP provider bill review follow-up after new records.",
          sourceTurnRanges: [{ threadId: "profile:default", startSequence: 4350, endSequence: 4380 }]
        })
      ],
      boxes: [box({ id: "box_topic_smith_pip", title: "Smith PIP", summaryIds: ["summary_1", "summary_3"] })],
      anchors: [],
      proposals: [],
      traces: [],
      minimumTraceSummaries: 2,
      minimumConfidence: 0.5
    });

    expect(result.proposals.map((proposal) => proposal.id)).toEqual(["proposal_trace_trace_smith_pip_provider_bill"]);
    expect(result.proposals[0].payload).toMatchObject({
      traceId: "trace_smith_pip_provider_bill",
      continuityReason: expect.stringContaining("provider")
    });
  });

  it("does not link summaries that only share the broad Smith case term", async () => {
    const planner = new DeterministicTraceProposalPlanner();
    const result = await planner.proposeTraces({
      reviewedAt: "2026-05-07T12:00:00.000Z",
      summaries: [
        summary({
          id: "summary_pip",
          summaryText: "Smith PIP provider bill review.",
          sourceTurnRanges: [{ threadId: "profile:default", startSequence: 1, endSequence: 3 }]
        }),
        summary({
          id: "summary_bi",
          summaryText: "Smith BI bodily injury coverage demand.",
          sourceTurnRanges: [{ threadId: "profile:default", startSequence: 4350, endSequence: 4380 }]
        })
      ],
      boxes: [],
      anchors: [],
      proposals: [],
      traces: [],
      minimumTraceSummaries: 2,
      minimumConfidence: 0.5
    });

    expect(result.proposals).toEqual([]);
    expect(result.skippedCandidates.some((candidate) => candidate.reason.includes("Only broad shared terms"))).toBe(true);
  });
});
