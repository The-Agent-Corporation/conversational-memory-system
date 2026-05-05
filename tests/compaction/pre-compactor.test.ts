import { describe, expect, it } from "vitest";
import type { CompletedTopicSpan } from "../../src/topic/topic-monitor.js";
import { PreCompactor } from "../../src/compaction/pre-compactor.js";
import type { Turn } from "../../src/domain/types.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import type { Summarizer } from "../../src/summarization/summarizer.js";

const makeTurn = (overrides: Partial<Turn> = {}): Turn => ({
  id: "turn_1",
  threadId: "session_1",
  sequence: 1,
  role: "user",
  content: "Let's talk about Smith PIP.",
  createdAt: "2026-05-04T10:00:00.000Z",
  provenance: "direct_user_input",
  trustLevel: "high",
  metadata: { sourceMetadata: { channel: "telegram" } },
  contentHash: "hash_1",
  ...overrides
});

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

describe("PreCompactor", () => {
  it("writes a source-linked summary for a completed topic span", async () => {
    const store = new InMemoryStore();
    await store.saveTurn(makeTurn({
      id: "turn_1",
      sequence: 1,
      content: "Let's talk about Smith PIP."
    }));
    await store.saveTurn(makeTurn({
      id: "turn_2",
      sequence: 2,
      role: "assistant",
      content: "The Smith PIP issue is about demand timing."
    }));
    await store.saveTurn(makeTurn({
      id: "turn_3",
      sequence: 3,
      content: "Switch to Jones BI coverage."
    }));

    const compactor = new PreCompactor(store);
    const result = await compactor.compactCompletedTopic(completedSpan());

    expect(result.sourceTurnCount).toBe(2);
    expect(result.summary).toMatchObject({
      id: "summary_session_1_1_2",
      sourceTurnRanges: [{ threadId: "session_1", startSequence: 1, endSequence: 2 }],
      sourceSummaryIds: [],
      boxIds: [],
      embedding: null,
      model: "deterministic-summarizer",
      promptVersion: "deterministic-v1",
      state: "compacted",
      detailLevel: "brief"
    });
    expect(result.summary.summaryText).toContain("Smith PIP (2 turns, seq 1-2)");
    expect(result.summary.summaryText).toContain("demand timing");

    await expect(store.listSummaries()).resolves.toEqual([result.summary]);
  });

  it("upserts the same completed span summary deterministically", async () => {
    const store = new InMemoryStore();
    const compactor = new PreCompactor(store);

    await compactor.compactCompletedTopic(completedSpan());
    await compactor.compactCompletedTopic(completedSpan({
      currentTopicSummary: "Smith PIP (2 turns, seq 1-2)",
      completedAt: "2026-05-04T10:06:00.000Z"
    }));

    const summaries = await store.listSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].id).toBe("summary_session_1_1_2");
    expect(summaries[0].createdAt).toBe("2026-05-04T10:06:00.000Z");
  });

  it("uses an injected summarizer to build the summary draft", async () => {
    const store = new InMemoryStore();
    await store.saveTurn(makeTurn({ id: "turn_1", sequence: 1 }));
    const summarizer: Summarizer = {
      async summarize({ span, sourceTurns }) {
        return {
          summaryText: `custom ${span.topicLabel} from ${sourceTurns.length} turns`,
          model: "custom-test-summarizer",
          promptVersion: "custom-v1",
          confidence: 0.95,
          detailLevel: "medium",
          tokenCount: 6
        };
      }
    };
    const compactor = new PreCompactor(store, summarizer);

    const result = await compactor.compactCompletedTopic(completedSpan({
      sourceTurnRange: { threadId: "session_1", startSequence: 1, endSequence: 1 },
      turnCount: 1
    }));

    expect(result.summary).toMatchObject({
      summaryText: "custom Smith PIP from 1 turns",
      model: "custom-test-summarizer",
      promptVersion: "custom-v1",
      confidence: 0.95,
      detailLevel: "medium",
      tokenCount: 6
    });
  });
});
