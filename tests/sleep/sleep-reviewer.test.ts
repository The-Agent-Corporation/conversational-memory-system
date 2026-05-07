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
    expect(result.proposals.map((proposal) => proposal.id)).toEqual(["proposal_box_box_topic_smith_pip"]);
    await expect(store.listBoxes()).resolves.toEqual(result.proposedBoxes);
    await expect(store.listProposals({ proposalType: "box", state: "proposed" })).resolves.toHaveLength(1);
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

  it("stores trace proposals for non-contiguous continuing issues", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({
      id: "summary_1",
      summaryText: "Smith PIP provider bill review and coverage timing.",
      sourceTurnRanges: [{ threadId: "session_1", startSequence: 1, endSequence: 3 }]
    }));
    await store.saveSummary(makeSummary({
      id: "summary_3",
      summaryText: "Smith PIP provider bill review follow-up after new records.",
      sourceTurnRanges: [{ threadId: "session_1", startSequence: 4350, endSequence: 4380 }],
      createdAt: "2026-05-04T11:05:00.000Z"
    }));

    const reviewer = new SleepReviewer(store);
    const result = await reviewer.proposeTraces({
      reviewedAt: "2026-05-05T06:00:00.000Z"
    });

    expect(result.proposals.map((proposal) => proposal.id)).toEqual(["proposal_trace_trace_smith_pip_provider_bill"]);
    await expect(store.listProposals({ proposalType: "trace", state: "proposed" })).resolves.toHaveLength(1);
  });

  it("decays old untouched summaries and marks weak summaries stale", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({
      id: "summary_old",
      createdAt: "2026-05-01T00:00:00.000Z",
      strength: 0.8,
      halfLifeHours: 24
    }));

    const reviewer = new SleepReviewer(store);
    const result = await reviewer.decaySummaries({
      reviewedAt: "2026-05-03T00:00:00.000Z",
      staleStrengthThreshold: 0.25
    });

    expect(result.updatedSummaries).toEqual([
      expect.objectContaining({
        id: "summary_old",
        strength: 0.2,
        state: "stale"
      })
    ]);
    await expect(store.listSummaries()).resolves.toEqual(result.updatedSummaries);
  });

  it("uses last access time when decaying retrieved summaries", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({
      id: "summary_recent",
      createdAt: "2026-05-01T00:00:00.000Z",
      lastAccessedAt: "2026-05-02T12:00:00.000Z",
      retrievedAt: "2026-05-02T12:00:00.000Z",
      retrievalCount: 1,
      strength: 0.8,
      halfLifeHours: 24
    }));

    const reviewer = new SleepReviewer(store);
    const result = await reviewer.decaySummaries({
      reviewedAt: "2026-05-03T00:00:00.000Z",
      staleStrengthThreshold: 0.25
    });

    expect(result.updatedSummaries).toEqual([
      expect.objectContaining({
        id: "summary_recent",
        strength: 0.57,
        state: "compacted"
      })
    ]);
  });

  it("does not decay summaries when the review time is not after the decay reference", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({
      id: "summary_now",
      createdAt: "2026-05-03T00:00:00.000Z",
      strength: 0.8,
      halfLifeHours: 24
    }));

    const reviewer = new SleepReviewer(store);
    const result = await reviewer.decaySummaries({
      reviewedAt: "2026-05-03T00:00:00.000Z"
    });

    expect(result.updatedSummaries).toEqual([]);
    await expect(store.listSummaries()).resolves.toEqual([makeSummary({
      id: "summary_now",
      createdAt: "2026-05-03T00:00:00.000Z",
      strength: 0.8,
      halfLifeHours: 24
    })]);
  });

  it("marks boxes stale when every linked summary is stale", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({
      id: "summary_1",
      state: "stale"
    }));
    await store.saveSummary(makeSummary({
      id: "summary_2",
      state: "stale"
    }));
    await store.saveBox(makeBox({
      summaryIds: ["summary_1", "summary_2"],
      state: "approved"
    }));

    const reviewer = new SleepReviewer(store);
    const result = await reviewer.refreshBoxStates({
      reviewedAt: "2026-05-05T06:00:00.000Z"
    });

    expect(result.updatedBoxes).toEqual([
      expect.objectContaining({
        id: "box_topic_smith_pip",
        state: "stale",
        updatedAt: "2026-05-05T06:00:00.000Z"
      })
    ]);
    await expect(store.listBoxes()).resolves.toEqual(result.updatedBoxes);
  });

  it("revives stale boxes when any linked summary is revived", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({
      id: "summary_1",
      state: "stale"
    }));
    await store.saveSummary(makeSummary({
      id: "summary_2",
      state: "revived"
    }));
    await store.saveBox(makeBox({
      summaryIds: ["summary_1", "summary_2"],
      state: "stale"
    }));

    const reviewer = new SleepReviewer(store);
    const result = await reviewer.refreshBoxStates({
      reviewedAt: "2026-05-05T06:00:00.000Z"
    });

    expect(result.updatedBoxes).toEqual([
      expect.objectContaining({
        id: "box_topic_smith_pip",
        state: "revived",
        updatedAt: "2026-05-05T06:00:00.000Z",
        lastActivityAt: "2026-05-05T06:00:00.000Z"
      })
    ]);
  });

  it("does not refresh proposed or rejected box states", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({
      id: "summary_1",
      state: "stale"
    }));
    await store.saveBox(makeBox({
      id: "box_proposed",
      state: "proposed"
    }));
    await store.saveBox(makeBox({
      id: "box_rejected",
      state: "rejected"
    }));

    const reviewer = new SleepReviewer(store);
    const result = await reviewer.refreshBoxStates({
      reviewedAt: "2026-05-05T06:00:00.000Z"
    });

    expect(result.updatedBoxes).toEqual([]);
    await expect(store.listBoxes()).resolves.toEqual([
      makeBox({ id: "box_proposed", state: "proposed" }),
      makeBox({ id: "box_rejected", state: "rejected" })
    ]);
  });
});
