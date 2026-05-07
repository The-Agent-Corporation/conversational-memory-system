import { describe, expect, it } from "vitest";
import type { InjectionPacket, Summary, Turn } from "../../src/domain/types.js";
import { ConversationResumer } from "../../src/resume/conversation-resumer.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";

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

const makeSummary = (overrides: Partial<Summary> = {}): Summary => ({
  id: "summary_1",
  summaryText: "Smith PIP demand strategy and coverage timing.",
  sourceTurnRanges: [{ threadId: "session_1", startSequence: 1, endSequence: 2 }],
  sourceSummaryIds: [],
  boxIds: ["box_1"],
  embedding: null,
  createdAt: "2026-05-04T10:05:00.000Z",
  model: "test-summarizer",
  promptVersion: "v1",
  confidence: 0.9,
  state: "compacted",
  detailLevel: "brief",
  tokenCount: 72,
  lastAccessedAt: null,
  version: 1,
  strength: 0.8,
  retrievalCount: 0,
  retrievedAt: null,
  halfLifeHours: 168,
  outcomeScore: null,
  ...overrides
});

const makeInjection = (overrides: Partial<InjectionPacket> = {}): InjectionPacket => ({
  id: "inject_1",
  hostSessionId: "session_1",
  currentTopicSummary: "Smith PIP demand",
  selectedMemory: "Smith PIP demand strategy.",
  sourceSummaryIds: ["summary_1"],
  sourceTraceIds: [],
  sourceTurnRanges: [{ threadId: "session_1", startSequence: 1, endSequence: 2 }],
  boxIds: ["box_1"],
  relevanceReason: "Top summary match summary_1.",
  confidence: 0.9,
  disclosureText: "Retrieved 1 memory item.",
  createdAt: "2026-05-04T10:10:00.000Z",
  ...overrides
});

describe("ConversationResumer", () => {
  it("expands a summary into its verbatim source turns", async () => {
    const store = new InMemoryStore();
    await store.saveTurn(makeTurn({ id: "turn_1", sequence: 1 }));
    await store.saveTurn(makeTurn({
      id: "turn_2",
      sequence: 2,
      role: "assistant",
      content: "The Smith PIP issue is about demand timing."
    }));
    await store.saveTurn(makeTurn({
      id: "turn_3",
      sequence: 3,
      content: "Switch to Jones BI."
    }));
    await store.saveSummary(makeSummary());

    const resumer = new ConversationResumer(store);
    const result = await resumer.resumeSummary("summary_1");

    expect(result).toMatchObject({
      sourceSummaryIds: ["summary_1"],
      sourceTurnRanges: [{ threadId: "session_1", startSequence: 1, endSequence: 2 }],
      turnCount: 2,
      disclosureText: "Expanded 1 summary into 2 verbatim turns."
    });
    expect(result.turns.map((turn) => turn.id)).toEqual(["turn_1", "turn_2"]);
  });

  it("expands all source ranges from an injection packet without duplicate turns", async () => {
    const store = new InMemoryStore();
    await store.saveTurn(makeTurn({ id: "turn_1", sequence: 1 }));
    await store.saveTurn(makeTurn({ id: "turn_2", sequence: 2 }));
    await store.saveTurn(makeTurn({ id: "turn_3", sequence: 3 }));

    const resumer = new ConversationResumer(store);
    const result = await resumer.resumeInjection(makeInjection({
      sourceSummaryIds: ["summary_1", "summary_2"],
      sourceTurnRanges: [
        { threadId: "session_1", startSequence: 1, endSequence: 2 },
        { threadId: "session_1", startSequence: 2, endSequence: 3 }
      ]
    }));

    expect(result.sourceSummaryIds).toEqual(["summary_1", "summary_2"]);
    expect(result.turns.map((turn) => turn.id)).toEqual(["turn_1", "turn_2", "turn_3"]);
    expect(result.turnCount).toBe(3);
  });

  it("throws when a requested summary does not exist", async () => {
    const resumer = new ConversationResumer(new InMemoryStore());

    await expect(resumer.resumeSummary("missing")).rejects.toThrow("Summary missing was not found");
  });
});
