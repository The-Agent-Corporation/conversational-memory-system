import { describe, expect, it } from "vitest";
import type { Box, Summary } from "../../src/domain/types.js";
import { BoxReviewer } from "../../src/boxes/box-reviewer.js";
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
  summary: "Smith PIP demand strategy.\n\nSmith PIP deadline review.",
  lastActivityAt: "2026-05-04T11:05:00.000Z",
  ...overrides
});

describe("BoxReviewer", () => {
  it("approves a proposed box and attaches its summaries", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({ id: "summary_1" }));
    await store.saveSummary(makeSummary({
      id: "summary_2",
      summaryText: "Smith PIP deadline and provider bill review.",
      sourceTurnRanges: [{ threadId: "session_1", startSequence: 10, endSequence: 12 }]
    }));
    await store.saveBox(makeBox());

    const reviewer = new BoxReviewer(store);
    const result = await reviewer.approveBox({
      boxId: "box_topic_smith_pip",
      reviewedAt: "2026-05-05T09:00:00.000Z"
    });

    expect(result.box).toMatchObject({
      id: "box_topic_smith_pip",
      state: "approved",
      updatedAt: "2026-05-05T09:00:00.000Z"
    });
    expect(result.updatedSummaries.map((summary) => summary.id)).toEqual(["summary_1", "summary_2"]);
    await expect(store.listSummaries()).resolves.toEqual([
      expect.objectContaining({ id: "summary_1", boxIds: ["box_topic_smith_pip"] }),
      expect.objectContaining({ id: "summary_2", boxIds: ["box_topic_smith_pip"] })
    ]);
  });

  it("rejects a proposed box without changing its summaries", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({ id: "summary_1" }));
    await store.saveBox(makeBox({ summaryIds: ["summary_1"] }));

    const reviewer = new BoxReviewer(store);
    const result = await reviewer.rejectBox({
      boxId: "box_topic_smith_pip",
      reviewedAt: "2026-05-05T09:00:00.000Z"
    });

    expect(result.box).toMatchObject({
      id: "box_topic_smith_pip",
      state: "rejected",
      updatedAt: "2026-05-05T09:00:00.000Z"
    });
    expect(result.updatedSummaries).toEqual([]);
    await expect(store.listSummaries()).resolves.toEqual([makeSummary({ id: "summary_1" })]);
  });

  it("throws when the box does not exist or is not proposed", async () => {
    const store = new InMemoryStore();
    await store.saveBox(makeBox({ state: "approved" }));
    const reviewer = new BoxReviewer(store);

    await expect(reviewer.approveBox({
      boxId: "missing",
      reviewedAt: "2026-05-05T09:00:00.000Z"
    })).rejects.toThrow("Box missing was not found");
    await expect(reviewer.approveBox({
      boxId: "box_topic_smith_pip",
      reviewedAt: "2026-05-05T09:00:00.000Z"
    })).rejects.toThrow("Box box_topic_smith_pip is not proposed");
  });
});
