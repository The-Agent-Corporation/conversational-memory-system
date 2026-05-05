import { describe, expect, it } from "vitest";
import type { Box, Summary } from "../../src/domain/types.js";
import { SleepReviewer } from "../../src/sleep/sleep-reviewer.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";

const makeSummary = (overrides: Partial<Summary> = {}): Summary => ({
  id: "summary_1",
  summaryText: "Smith PIP demand strategy and coverage timing.",
  sourceTurnRanges: [{ threadId: "session_1", startSequence: 1, endSequence: 2 }],
  sourceSummaryIds: [],
  boxIds: [],
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

const makeBox = (overrides: Partial<Box> = {}): Box => ({
  id: "box_topic_smith_pip",
  title: "Smith PIP",
  description: "Existing topic box.",
  parentBoxId: null,
  childBoxIds: [],
  summaryIds: ["summary_1"],
  turnRanges: [{ threadId: "session_1", startSequence: 1, endSequence: 2 }],
  state: "approved",
  createdAt: "2026-05-04T10:00:00.000Z",
  updatedAt: "2026-05-04T10:00:00.000Z",
  caseId: null,
  boxType: "topic",
  summary: "Smith PIP",
  lastActivityAt: "2026-05-04T10:00:00.000Z",
  ...overrides
});

describe("SleepReviewer", () => {
  it("proposes topic boxes from repeated summary patterns", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({
      id: "summary_1",
      summaryText: "Smith PIP demand strategy and coverage timing.",
      sourceTurnRanges: [{ threadId: "session_1", startSequence: 1, endSequence: 2 }]
    }));
    await store.saveSummary(makeSummary({
      id: "summary_2",
      summaryText: "Smith PIP deadline and provider bill review.",
      sourceTurnRanges: [{ threadId: "session_1", startSequence: 10, endSequence: 12 }],
      createdAt: "2026-05-04T11:05:00.000Z"
    }));
    await store.saveSummary(makeSummary({
      id: "summary_3",
      summaryText: "Jones BI coverage limits.",
      sourceTurnRanges: [{ threadId: "session_2", startSequence: 1, endSequence: 2 }]
    }));

    const reviewer = new SleepReviewer(store);
    const result = await reviewer.proposeBoxes({
      reviewedAt: "2026-05-05T06:00:00.000Z"
    });

    expect(result.proposedBoxes).toHaveLength(1);
    expect(result.proposedBoxes[0]).toMatchObject({
      id: "box_topic_smith_pip",
      title: "Smith PIP",
      description: "Proposed topic box from 2 related summaries.",
      parentBoxId: null,
      childBoxIds: [],
      summaryIds: ["summary_1", "summary_2"],
      turnRanges: [
        { threadId: "session_1", startSequence: 1, endSequence: 2 },
        { threadId: "session_1", startSequence: 10, endSequence: 12 }
      ],
      state: "proposed",
      createdAt: "2026-05-05T06:00:00.000Z",
      updatedAt: "2026-05-05T06:00:00.000Z",
      caseId: null,
      boxType: "topic",
      lastActivityAt: "2026-05-04T11:05:00.000Z"
    });
    expect(result.proposedBoxes[0].summary).toContain("Smith PIP demand strategy");
    await expect(store.listBoxes()).resolves.toEqual(result.proposedBoxes);
  });

  it("does not propose a box when a matching title already exists", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({ id: "summary_1" }));
    await store.saveSummary(makeSummary({
      id: "summary_2",
      summaryText: "Smith PIP deadline and provider bill review."
    }));
    await store.saveBox(makeBox());

    const reviewer = new SleepReviewer(store);
    const result = await reviewer.proposeBoxes({
      reviewedAt: "2026-05-05T06:00:00.000Z"
    });

    expect(result.proposedBoxes).toEqual([]);
    await expect(store.listBoxes()).resolves.toEqual([makeBox()]);
  });
});
