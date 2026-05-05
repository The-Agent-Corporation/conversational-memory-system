import { describe, expect, it } from "vitest";
import { DeterministicSummarizer } from "../../src/summarization/summarizer.js";
import type { Turn } from "../../src/domain/types.js";
import type { CompletedTopicSpan } from "../../src/topic/topic-monitor.js";

const completedSpan = (overrides: Partial<CompletedTopicSpan> = {}): CompletedTopicSpan => ({
  host: "roscoe-hermes",
  profileId: "default",
  hostSessionId: "session_1",
  topicLabel: "Smith PIP",
  currentTopicSummary: "Smith PIP (2 turns, seq 1-2)",
  sourceTurnRange: {
    threadId: "session_1",
    startSequence: 1,
    endSequence: 2
  },
  turnCount: 2,
  lastEventId: "event_2",
  updatedAt: "2026-05-04T10:00:10.000Z",
  completedAt: "2026-05-04T10:05:00.000Z",
  ...overrides
});

const makeTurn = (overrides: Partial<Turn> = {}): Turn => ({
  id: "turn_1",
  threadId: "session_1",
  sequence: 1,
  role: "user",
  content: "Let's talk about Smith PIP.",
  createdAt: "2026-05-04T10:00:00.000Z",
  provenance: "direct_user_input",
  trustLevel: "high",
  metadata: {},
  contentHash: "hash_1",
  ...overrides
});

describe("DeterministicSummarizer", () => {
  it("creates a source-linked summary draft from a completed topic span and source turns", async () => {
    const summarizer = new DeterministicSummarizer();

    const draft = await summarizer.summarize({
      span: completedSpan(),
      sourceTurns: [
        makeTurn({ id: "turn_1", sequence: 1, content: "Let's talk about Smith PIP." }),
        makeTurn({
          id: "turn_2",
          sequence: 2,
          role: "assistant",
          content: "The Smith PIP issue is about demand timing."
        })
      ]
    });

    expect(draft).toMatchObject({
      summaryText: "Smith PIP (2 turns, seq 1-2): Let's talk about Smith PIP. The Smith PIP issue is about demand timing.",
      model: "deterministic-summarizer",
      promptVersion: "deterministic-v1",
      confidence: 0.7,
      detailLevel: "brief",
      tokenCount: 8
    });
  });
});
