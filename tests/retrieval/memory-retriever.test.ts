import { describe, expect, it } from "vitest";
import type { Anchor, Summary } from "../../src/domain/types.js";
import { MemoryRetriever } from "../../src/retrieval/memory-retriever.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";

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

const makeAnchor = (overrides: Partial<Anchor> = {}): Anchor => ({
  id: "anchor_1",
  turnId: "turn_1",
  threadId: "session_1",
  boxId: "box_1",
  anchorType: "deadline",
  content: "PIP demand deadline is June 1.",
  embedding: null,
  createdAt: "2026-05-04T10:02:00.000Z",
  trustLevel: "high",
  source: "direct_user_input",
  ...overrides
});

describe("MemoryRetriever", () => {
  it("returns and audits a ranked injection packet for matching memory", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary());
    await store.saveAnchor(makeAnchor());

    const retriever = new MemoryRetriever(store);
    const packet = await retriever.prepareInjection({
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      currentTopicSummary: "Smith PIP demand",
      requestedAt: "2026-05-04T10:10:00.000Z"
    });

    expect(packet).not.toBeNull();
    expect(packet).toMatchObject({
      hostSessionId: "session_1",
      currentTopicSummary: "Smith PIP demand",
      sourceSummaryIds: ["summary_1"],
      sourceTurnRanges: [{ threadId: "session_1", startSequence: 1, endSequence: 2 }],
      boxIds: ["box_1"],
      createdAt: "2026-05-04T10:10:00.000Z"
    });
    expect(packet?.selectedMemory).toContain("Smith PIP demand strategy");
    expect(packet?.selectedMemory).toContain("PIP demand deadline");
    expect(packet?.confidence).toBeGreaterThan(0.5);
    await expect(store.listInjections("session_1")).resolves.toEqual([packet]);
  });

  it("returns null when no memory matches the current topic", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({
      summaryText: "Jones BI coverage limits."
    }));

    const retriever = new MemoryRetriever(store);
    const packet = await retriever.prepareInjection({
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      currentTopicSummary: "Smith PIP demand",
      requestedAt: "2026-05-04T10:10:00.000Z"
    });

    expect(packet).toBeNull();
    await expect(store.listInjections("session_1")).resolves.toEqual([]);
  });

  it("keeps separate audit packets for repeated retrievals at different times", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary());

    const retriever = new MemoryRetriever(store);
    const first = await retriever.prepareInjection({
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      currentTopicSummary: "Smith PIP demand",
      requestedAt: "2026-05-04T10:10:00.000Z"
    });
    const second = await retriever.prepareInjection({
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      currentTopicSummary: "Smith PIP demand",
      requestedAt: "2026-05-04T10:11:00.000Z"
    });

    expect(first?.id).not.toBe(second?.id);
    await expect(store.listInjections("session_1")).resolves.toEqual([first, second]);
  });
});
