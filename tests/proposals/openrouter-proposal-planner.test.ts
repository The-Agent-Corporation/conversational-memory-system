import { describe, expect, it } from "vitest";
import type { Box, Summary } from "../../src/domain/types.js";
import {
  OpenRouterProposalPlanner,
  OpenRouterProposalPlannerError,
  type FetchLike
} from "../../src/proposals/openrouter-proposal-planner.js";

const summary = (overrides: Partial<Summary> = {}): Summary => ({
  id: "summary_1",
  summaryText: "Smith PIP provider bill review and coverage timing.",
  sourceTurnRanges: [{ threadId: "profile:default", startSequence: 1, endSequence: 3 }],
  sourceSummaryIds: [],
  boxIds: ["box_case_smith"],
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
  title: "Smith Case",
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

const chatResponse = (content: unknown): string => JSON.stringify({
  choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }]
});

const fetchReturning = (body: string, status = 200): FetchLike => async () => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? "OK" : "Bad Request",
  async text() {
    return body;
  }
});

const makePlanner = (fetch: FetchLike): OpenRouterProposalPlanner => new OpenRouterProposalPlanner({
  apiKey: "test-key",
  model: "openai/gpt-4.1-mini",
  fetch
});

describe("OpenRouterProposalPlanner", () => {
  it("builds box and parent-child proposals from valid model JSON", async () => {
    const planner = makePlanner(fetchReturning(chatResponse({
      boxProposals: [{
        boxId: "box_topic_smith_pip_provider_bills",
        title: "Smith PIP Provider Bills",
        description: "Provider billing issue within Smith PIP.",
        summary: "The summaries concern Smith PIP provider bills and ledger review.",
        boxType: "topic",
        candidateParentBoxId: "box_case_smith",
        keywords: ["smith", "pip", "provider", "bill"],
        evidence: ["summary_1 discusses provider bill review", "summary_2 continues the issue"],
        sourceSummaryIds: ["summary_1", "summary_2"],
        confidence: 0.84,
        rationale: "The summaries share a specific provider bill issue."
      }],
      parentChildProposals: [{
        parentBoxId: "box_case_smith",
        childBoxId: "box_topic_smith_pip_provider_bills",
        relationshipLabel: "case issue",
        rationale: "The child is a specific issue under the Smith case.",
        sourceSummaryIds: ["summary_1", "summary_2"],
        confidence: 0.78
      }]
    })));

    const result = await planner.proposeBoxes({
      reviewedAt: "2026-05-07T12:00:00.000Z",
      summaries: [
        summary({ id: "summary_1" }),
        summary({
          id: "summary_2",
          summaryText: "Smith PIP provider bill ledger follow-up.",
          sourceTurnRanges: [{ threadId: "profile:default", startSequence: 20, endSequence: 22 }]
        })
      ],
      boxes: [box()],
      anchors: [],
      proposals: []
    });

    expect(result.proposals.map((proposal) => proposal.proposalType)).toEqual(["box", "box_parent_child"]);
    expect(result.proposals[0]).toMatchObject({
      id: "proposal_box_box_topic_smith_pip_provider_bills",
      title: "Smith PIP Provider Bills",
      targetBoxIds: ["box_topic_smith_pip_provider_bills"]
    });
    expect(result.proposals[1].payload).toMatchObject({
      parentBoxId: "box_case_smith",
      childBoxId: "box_topic_smith_pip_provider_bills"
    });
  });

  it("builds trace proposals from valid model JSON", async () => {
    const planner = makePlanner(fetchReturning(chatResponse({
      traceProposals: [{
        traceId: "trace_smith_pip_provider_bills",
        title: "Smith PIP Provider Bills",
        description: "Non-contiguous summaries continue the same provider bill issue.",
        traceType: "case_issue",
        summaryIds: ["summary_1", "summary_2"],
        boxIds: ["box_case_smith"],
        continuityReason: "Both summaries discuss the provider bill ledger.",
        boundaryReason: "BI coverage summaries were excluded.",
        keywords: ["smith", "pip", "provider", "bill"],
        confidence: 0.86,
        rationale: "The issue recurs across separated turns."
      }]
    })));

    const result = await planner.proposeTraces({
      reviewedAt: "2026-05-07T12:00:00.000Z",
      summaries: [
        summary({ id: "summary_1" }),
        summary({
          id: "summary_2",
          sourceTurnRanges: [{ threadId: "profile:default", startSequence: 20, endSequence: 22 }]
        })
      ],
      boxes: [box()],
      anchors: [],
      proposals: [],
      traces: []
    });

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({
      id: "proposal_trace_trace_smith_pip_provider_bills",
      targetTraceIds: ["trace_smith_pip_provider_bills"],
      targetBoxIds: ["box_case_smith"]
    });
  });

  it("fails when the model references an unknown summary id", async () => {
    const planner = makePlanner(fetchReturning(chatResponse({
      traceProposals: [{
        title: "Smith PIP Provider Bills",
        description: "Provider bill issue.",
        traceType: "case_issue",
        summaryIds: ["summary_1", "missing"],
        boxIds: ["box_case_smith"],
        continuityReason: "Both discuss provider bills.",
        boundaryReason: "Other issues excluded.",
        keywords: ["provider", "bill"],
        confidence: 0.8,
        rationale: "Recurring issue."
      }]
    })));

    await expect(planner.proposeTraces({
      reviewedAt: "2026-05-07T12:00:00.000Z",
      summaries: [summary({ id: "summary_1" })],
      boxes: [box()],
      anchors: [],
      proposals: [],
      traces: []
    })).rejects.toThrow("Model referenced unknown summary missing.");
  });

  it("throws a typed error for malformed planner JSON", async () => {
    const planner = makePlanner(fetchReturning(chatResponse("{not json")));

    await expect(planner.proposeBoxes({
      reviewedAt: "2026-05-07T12:00:00.000Z",
      summaries: [],
      boxes: [],
      anchors: [],
      proposals: []
    })).rejects.toBeInstanceOf(OpenRouterProposalPlannerError);
  });

  it("throws a typed error for non-OK responses", async () => {
    const planner = makePlanner(fetchReturning("rate limited", 429));

    await expect(planner.proposeBoxes({
      reviewedAt: "2026-05-07T12:00:00.000Z",
      summaries: [],
      boxes: [],
      anchors: [],
      proposals: []
    })).rejects.toMatchObject({
      name: "OpenRouterProposalPlannerError",
      status: 429,
      responseText: "rate limited"
    } satisfies Partial<OpenRouterProposalPlannerError>);
  });
});
