import { describe, expect, it } from "vitest";
import type { Box, Summary } from "../../src/domain/types.js";
import { BoxAssigner } from "../../src/boxes/box-assigner.js";
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
  summaryIds: [],
  turnRanges: [],
  state: "approved",
  createdAt: "2026-05-04T09:00:00.000Z",
  updatedAt: "2026-05-04T09:00:00.000Z",
  caseId: null,
  boxType: "topic",
  summary: "Smith PIP case topic.",
  lastActivityAt: "2026-05-04T09:00:00.000Z",
  ...overrides
});

describe("BoxAssigner", () => {
  it("assigns a matching summary to an approved existing box and updates the box aggregate", async () => {
    const store = new InMemoryStore();
    await store.saveBox(makeBox());
    const assigner = new BoxAssigner(store);

    const assigned = await assigner.assignSummary(makeSummary());

    expect(assigned.boxIds).toEqual(["box_topic_smith_pip"]);
    const boxes = await store.listBoxes();
    expect(boxes[0]).toMatchObject({
      id: "box_topic_smith_pip",
      summaryIds: ["summary_1"],
      turnRanges: [{ threadId: "session_1", startSequence: 1, endSequence: 2 }],
      updatedAt: "2026-05-04T10:05:00.000Z",
      lastActivityAt: "2026-05-04T10:05:00.000Z"
    });
    expect(boxes[0].summary).toContain("Smith PIP case topic.");
    expect(boxes[0].summary).toContain("Smith PIP demand strategy");
  });

  it("does not assign summaries to proposed boxes", async () => {
    const store = new InMemoryStore();
    await store.saveBox(makeBox({ state: "proposed" }));
    const assigner = new BoxAssigner(store);

    const assigned = await assigner.assignSummary(makeSummary());

    expect(assigned.boxIds).toEqual([]);
    await expect(store.listBoxes()).resolves.toEqual([makeBox({ state: "proposed" })]);
  });
});
