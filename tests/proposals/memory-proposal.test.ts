import { describe, expect, it } from "vitest";
import {
  BoxProposalPayloadSchema,
  MemoryProposalSchema,
  MemoryTraceSchema,
  ParentChildProposalPayloadSchema,
  TraceProposalPayloadSchema
} from "../../src/domain/types.js";

const turnRange = { threadId: "profile:default", startSequence: 1, endSequence: 3 };

describe("memory proposal schemas", () => {
  it("parses a box proposal with evidence and provenance", () => {
    const parsed = MemoryProposalSchema.parse({
      id: "proposal_box_smith_pip",
      proposalType: "box",
      state: "proposed",
      title: "Smith PIP Coverage",
      rationale: "Two compacted summaries discuss Smith PIP coverage and provider bills.",
      confidence: 0.82,
      createdAt: "2026-05-07T12:00:00.000Z",
      reviewedAt: "2026-05-07T12:00:00.000Z",
      sourceSummaryIds: ["summary_1", "summary_2"],
      sourceTurnRanges: [turnRange],
      targetBoxIds: ["box_topic_smith_pip"],
      targetTraceIds: [],
      payload: {
        boxId: "box_topic_smith_pip",
        title: "Smith PIP Coverage",
        description: "Proposed topic box for Smith PIP coverage.",
        summary: "Smith PIP coverage and provider bill review.",
        boxType: "topic",
        candidateParentBoxId: "box_case_smith",
        keywords: ["smith", "pip", "coverage", "provider", "bill"],
        evidence: ["Shared keywords: smith, pip, coverage", "2 source summaries"],
        sourceSummaryIds: ["summary_1", "summary_2"],
        sourceTurnRanges: [turnRange]
      }
    });

    expect(BoxProposalPayloadSchema.parse(parsed.payload).candidateParentBoxId).toBe("box_case_smith");
  });

  it("parses parent-child and trace payloads", () => {
    expect(ParentChildProposalPayloadSchema.parse({
      parentBoxId: "box_case_smith",
      childBoxId: "box_topic_smith_pip",
      relationshipLabel: "case subtopic",
      rationale: "Smith PIP is narrower than the Smith case box.",
      sourceSummaryIds: ["summary_1"]
    }).relationshipLabel).toBe("case subtopic");

    expect(TraceProposalPayloadSchema.parse({
      traceId: "trace_smith_pip_bills",
      title: "Smith PIP Provider Bill Review",
      description: "Non-contiguous summaries continue the Smith PIP provider bill review issue.",
      traceType: "case_issue",
      summaryIds: ["summary_1", "summary_3"],
      boxIds: ["box_topic_smith_pip"],
      turnRanges: [turnRange],
      continuityReason: "Both summaries discuss Smith PIP provider bill review.",
      boundaryReason: "Smith BI summaries were excluded because they concern bodily injury coverage.",
      keywords: ["smith", "pip", "provider", "bill"]
    }).traceType).toBe("case_issue");
  });

  it("parses a memory trace record", () => {
    const trace = MemoryTraceSchema.parse({
      id: "trace_smith_pip_bills",
      title: "Smith PIP Provider Bill Review",
      description: "Approved trace for Smith PIP bill review.",
      traceType: "case_issue",
      state: "proposed",
      summaryIds: ["summary_1", "summary_3"],
      boxIds: ["box_topic_smith_pip"],
      turnRanges: [turnRange],
      createdAt: "2026-05-07T12:00:00.000Z",
      updatedAt: "2026-05-07T12:00:00.000Z",
      lastActivityAt: "2026-05-07T12:00:00.000Z",
      confidence: 0.78,
      rationale: "The summaries continue the same provider bill review issue."
    });

    expect(trace.state).toBe("proposed");
  });

  it("rejects proposal payloads without source provenance", () => {
    expect(() => MemoryProposalSchema.parse({
      id: "proposal_bad",
      proposalType: "box",
      state: "proposed",
      title: "Bad",
      rationale: "Missing source summary ids.",
      confidence: 0.5,
      createdAt: "2026-05-07T12:00:00.000Z",
      reviewedAt: "2026-05-07T12:00:00.000Z",
      sourceSummaryIds: [],
      sourceTurnRanges: [],
      targetBoxIds: [],
      targetTraceIds: [],
      payload: {}
    })).toThrow();
  });
});
