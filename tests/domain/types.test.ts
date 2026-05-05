import { describe, expect, it } from "vitest";
import {
  AnchorSchema,
  BoxSchema,
  InjectionPacketSchema,
  SummarySchema,
  TurnSchema
} from "../../src/domain/types.js";

describe("domain schemas", () => {
  it("parses a durable turn", () => {
    const parsed = TurnSchema.parse({
      id: "turn_1",
      threadId: "thread_1",
      sequence: 1,
      role: "user",
      content: "Let's discuss the Smith PIP claim.",
      createdAt: "2026-05-04T10:00:00.000Z",
      provenance: "direct_user_input",
      trustLevel: "high",
      metadata: {},
      contentHash: "hash_1"
    });

    expect(parsed.role).toBe("user");
    expect(parsed.provenance).toBe("direct_user_input");
  });

  it("parses a source-linked summary", () => {
    const parsed = SummarySchema.parse({
      id: "summary_1",
      summaryText: "Discussed Smith PIP coverage strategy.",
      sourceTurnRanges: [{ threadId: "thread_1", startSequence: 1, endSequence: 30 }],
      sourceSummaryIds: [],
      boxIds: ["box_1"],
      embedding: {
        provider: "test",
        model: "test-embedding",
        dimensions: 3,
        vector: [0.1, 0.2, 0.3],
        createdAt: "2026-05-04T10:05:00.000Z"
      },
      createdAt: "2026-05-04T10:05:00.000Z",
      model: "test-summarizer",
      promptVersion: "v1",
      confidence: 0.9,
      state: "active",
      detailLevel: "brief",
      tokenCount: 72,
      lastAccessedAt: null,
      version: 1,
      strength: 0.8,
      retrievalCount: 0,
      retrievedAt: null,
      halfLifeHours: 168,
      outcomeScore: null
    });

    expect(parsed.sourceTurnRanges[0].endSequence).toBe(30);
  });

  it("parses nested boxes, anchors, and injection packets", () => {
    expect(BoxSchema.parse({
      id: "box_1",
      title: "Smith case",
      description: "Case-level memory box",
      parentBoxId: null,
      childBoxIds: ["box_2"],
      summaryIds: ["summary_1"],
      turnRanges: [{ threadId: "thread_1", startSequence: 1, endSequence: 30 }],
      state: "active",
      createdAt: "2026-05-04T10:00:00.000Z",
      updatedAt: "2026-05-04T10:00:00.000Z",
      caseId: "smith",
      boxType: "case",
      summary: "Smith case discussion",
      lastActivityAt: "2026-05-04T10:00:00.000Z"
    }).boxType).toBe("case");

    expect(AnchorSchema.parse({
      id: "anchor_1",
      turnId: "turn_4",
      threadId: "thread_1",
      boxId: "box_1",
      anchorType: "deadline",
      content: "PIP demand deadline is June 1.",
      embedding: null,
      createdAt: "2026-05-04T10:02:00.000Z",
      trustLevel: "high",
      source: "direct_user_input"
    }).anchorType).toBe("deadline");

    expect(InjectionPacketSchema.parse({
      id: "inject_1",
      hostSessionId: "hermes_session_1",
      currentTopicSummary: "User is discussing Smith PIP coverage.",
      selectedMemory: "Prior Smith PIP demand strategy exists.",
      sourceSummaryIds: ["summary_1"],
      sourceTurnRanges: [{ threadId: "thread_1", startSequence: 1, endSequence: 30 }],
      boxIds: ["box_1"],
      relevanceReason: "Current topic matches Smith PIP summary.",
      confidence: 0.86,
      disclosureText: "This came from the Smith PIP discussion on May 4.",
      createdAt: "2026-05-04T10:06:00.000Z"
    }).confidence).toBe(0.86);
  });
});
