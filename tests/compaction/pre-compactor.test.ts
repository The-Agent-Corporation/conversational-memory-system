import { describe, expect, it } from "vitest";
import type { CompletedTopicSpan } from "../../src/topic/topic-monitor.js";
import { PreCompactor } from "../../src/compaction/pre-compactor.js";
import type { Box, Turn } from "../../src/domain/types.js";
import type { Embedder } from "../../src/embeddings/embedder.js";
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

const makeBox = (overrides: Partial<Box> = {}): Box => ({
  id: "box_topic_smith_pip",
  title: "Smith PIP",
  description: "Existing approved topic box.",
  parentBoxId: null,
  childBoxIds: [],
  summaryIds: [],
  turnRanges: [],
  state: "approved",
  createdAt: "2026-05-04T09:00:00.000Z",
  updatedAt: "2026-05-04T09:00:00.000Z",
  caseId: null,
  boxType: "topic",
  summary: "Smith PIP",
  lastActivityAt: "2026-05-04T09:00:00.000Z",
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

  it("embeds the completed summary when an embedder is configured", async () => {
    const store = new InMemoryStore();
    await store.saveTurn(makeTurn({ id: "turn_1", sequence: 1 }));
    const summarizer: Summarizer = {
      async summarize() {
        return {
          summaryText: "Smith PIP demand strategy",
          model: "test-summarizer",
          promptVersion: "test-v1",
          confidence: 0.9,
          detailLevel: "brief",
          tokenCount: 4
        };
      }
    };
    const embedder: Embedder = {
      provider: "test",
      model: "tiny",
      dimensions: 2,
      async embed(text) {
        return {
          provider: "test",
          model: "tiny",
          dimensions: 2,
          vector: text.includes("Smith PIP") ? [1, 0] : [0, 1],
          createdAt: "2026-05-04T10:05:01.000Z"
        };
      }
    };
    const compactor = new PreCompactor(store, summarizer, embedder);

    const result = await compactor.compactCompletedTopic(completedSpan({
      sourceTurnRange: { threadId: "session_1", startSequence: 1, endSequence: 1 },
      turnCount: 1
    }));

    expect(result.summary.embedding).toEqual({
      provider: "test",
      model: "tiny",
      dimensions: 2,
      vector: [1, 0],
      createdAt: "2026-05-04T10:05:01.000Z"
    });
    await expect(store.listSummaries()).resolves.toEqual([result.summary]);
  });

  it("assigns compacted summaries to matching existing boxes", async () => {
    const store = new InMemoryStore();
    await store.saveBox(makeBox());
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

    const compactor = new PreCompactor(store);
    const result = await compactor.compactCompletedTopic(completedSpan());

    expect(result.summary.boxIds).toEqual(["box_topic_smith_pip"]);
    const boxes = await store.listBoxes();
    expect(boxes[0].summaryIds).toEqual(["summary_session_1_1_2"]);
    expect(boxes[0].turnRanges).toEqual([
      { threadId: "session_1", startSequence: 1, endSequence: 2 }
    ]);
  });

  it("collapses a run of >=2 consecutive tool turns into one activity line", async () => {
    const store = new InMemoryStore();
    const seen: { sourceTurns: Turn[] } = { sourceTurns: [] };
    const summarizer: Summarizer = {
      async summarize({ span, sourceTurns }) {
        seen.sourceTurns = sourceTurns;
        return {
          summaryText: sourceTurns.map((turn) => turn.content).join(" | "),
          model: "test-summarizer",
          promptVersion: "test-v1",
          confidence: 0.9,
          detailLevel: "brief",
          tokenCount: sourceTurns.length
        };
      }
    };

    await store.saveTurn(makeTurn({
      id: "turn_1",
      sequence: 1,
      content: "Let's talk about Smith PIP."
    }));
    await store.saveTurn(makeTurn({
      id: "turn_2",
      sequence: 2,
      role: "tool",
      content: "[Tool call: Bash] {\"command\":\"grep -R foo\"}"
    }));
    await store.saveTurn(makeTurn({
      id: "turn_3",
      sequence: 3,
      role: "tool",
      content: "[Tool call: Read] {\"path\":\"/etc/hosts\"}"
    }));
    await store.saveTurn(makeTurn({
      id: "turn_4",
      sequence: 4,
      role: "tool",
      content: "[Tool call: Grep] {\"pattern\":\"xyzzy\"}"
    }));
    await store.saveTurn(makeTurn({
      id: "turn_5",
      sequence: 5,
      role: "assistant",
      content: "Found the demand timing issue."
    }));

    const compactor = new PreCompactor(store, summarizer);
    const result = await compactor.compactCompletedTopic(completedSpan({
      sourceTurnRange: { threadId: "session_1", startSequence: 1, endSequence: 5 },
      turnCount: 5
    }));

    expect(result.summary.summaryText).toContain("[Activity] ran 3 tool calls:");
    expect(result.summary.summaryText).not.toContain("grep -R foo");
    expect(result.summary.summaryText).not.toContain("/etc/hosts");
    expect(result.summary.summaryText).not.toContain("xyzzy");
    // provenance is unchanged: still the span's full raw turn range, not the hygiene-collapsed count
    expect(result.summary.sourceTurnRanges).toEqual([
      { threadId: "session_1", startSequence: 1, endSequence: 5 }
    ]);
    expect(result.sourceTurnCount).toBe(5);
  });

  // GAP-11-E H-0 (Plan 11-24): ROADMAP SC1's isolated-tool-call carve-out was reversed by
  // 11-REMEDIATION-DECISION.md (2026-07-27) — an isolated tool turn now collapses like any run,
  // via the same shared `derivationContents` path this seam calls.
  it("collapses an isolated single tool turn like any run (GAP-11-E H-0 / SC1 reversal)", async () => {
    const store = new InMemoryStore();
    const summarizer: Summarizer = {
      async summarize({ sourceTurns }) {
        return {
          summaryText: sourceTurns.map((turn) => turn.content).join(" | "),
          model: "test-summarizer",
          promptVersion: "test-v1",
          confidence: 0.9,
          detailLevel: "brief",
          tokenCount: sourceTurns.length
        };
      }
    };

    await store.saveTurn(makeTurn({
      id: "turn_1",
      sequence: 1,
      content: "Let's talk about Smith PIP."
    }));
    await store.saveTurn(makeTurn({
      id: "turn_2",
      sequence: 2,
      role: "tool",
      content: "[Tool call: Bash] {\"command\":\"grep -R foo\"}"
    }));
    await store.saveTurn(makeTurn({
      id: "turn_3",
      sequence: 3,
      role: "assistant",
      content: "Found the demand timing issue."
    }));

    const compactor = new PreCompactor(store, summarizer);
    const result = await compactor.compactCompletedTopic(completedSpan({
      sourceTurnRange: { threadId: "session_1", startSequence: 1, endSequence: 3 },
      turnCount: 3
    }));

    expect(result.summary.summaryText).not.toContain("[Tool call: Bash]");
    expect(result.summary.summaryText).toMatch(/\[Activity\] ran 1 tool calls: 1 Bash/);
  });

  it("drops a <system-reminder> turn from the summarizer input entirely", async () => {
    const store = new InMemoryStore();
    const summarizer: Summarizer = {
      async summarize({ sourceTurns }) {
        return {
          summaryText: sourceTurns.map((turn) => turn.content).join(" | "),
          model: "test-summarizer",
          promptVersion: "test-v1",
          confidence: 0.9,
          detailLevel: "brief",
          tokenCount: sourceTurns.length
        };
      }
    };

    await store.saveTurn(makeTurn({
      id: "turn_1",
      sequence: 1,
      content: "Let's talk about Smith PIP."
    }));
    await store.saveTurn(makeTurn({
      id: "turn_2",
      sequence: 2,
      role: "user",
      content: "<system-reminder>ignore this</system-reminder>"
    }));
    await store.saveTurn(makeTurn({
      id: "turn_3",
      sequence: 3,
      role: "assistant",
      content: "Found the demand timing issue."
    }));

    const compactor = new PreCompactor(store, summarizer);
    const result = await compactor.compactCompletedTopic(completedSpan({
      sourceTurnRange: { threadId: "session_1", startSequence: 1, endSequence: 3 },
      turnCount: 3
    }));

    expect(result.summary.summaryText).not.toContain("ignore this");
    expect(result.summary.summaryText).not.toContain("system-reminder");
    expect(result.summary.sourceTurnRanges).toEqual([
      { threadId: "session_1", startSequence: 1, endSequence: 3 }
    ]);
    expect(result.sourceTurnCount).toBe(3);
  });
});
