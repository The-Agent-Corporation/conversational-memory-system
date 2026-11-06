import { describe, expect, it } from "vitest";
import type { Box, MemoryProposal, Summary } from "../../src/domain/types.js";
import type { BoxProposalPlanner } from "../../src/boxes/box-proposal-planner.js";
import type { TraceProposalPlanner } from "../../src/traces/trace-proposal-planner.js";
import { DECAY_BASELINE_STRENGTH, DECAY_ELIGIBLE_STATES, SleepReviewer } from "../../src/sleep/sleep-reviewer.js";
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

const makeBoxProposal = (overrides: Partial<MemoryProposal> = {}): MemoryProposal => ({
  id: "proposal_box_box_topic_injected",
  proposalType: "box",
  state: "proposed",
  title: "Injected",
  rationale: "Injected planner proposal.",
  confidence: 0.8,
  createdAt: "2026-05-05T06:00:00.000Z",
  reviewedAt: "2026-05-05T06:00:00.000Z",
  decidedAt: null,
  decidedBy: null,
  decisionNote: null,
  sourceSummaryIds: ["summary_1"],
  sourceTurnRanges: [{ threadId: "session_1", startSequence: 1, endSequence: 2 }],
  targetBoxIds: ["box_topic_injected"],
  targetTraceIds: [],
  payload: {
    boxId: "box_topic_injected",
    title: "Injected",
    description: "Injected planner box.",
    summary: "Injected summary.",
    boxType: "topic",
    candidateParentBoxId: null,
    keywords: ["injected"],
    evidence: ["injected planner"],
    sourceSummaryIds: ["summary_1"],
    sourceTurnRanges: [{ threadId: "session_1", startSequence: 1, endSequence: 2 }]
  },
  ...overrides
});

const makeTraceProposal = (overrides: Partial<MemoryProposal> = {}): MemoryProposal => ({
  id: "proposal_trace_trace_injected",
  proposalType: "trace",
  state: "proposed",
  title: "Injected Trace",
  rationale: "Injected trace proposal.",
  confidence: 0.8,
  createdAt: "2026-05-05T06:00:00.000Z",
  reviewedAt: "2026-05-05T06:00:00.000Z",
  decidedAt: null,
  decidedBy: null,
  decisionNote: null,
  sourceSummaryIds: ["summary_1", "summary_2"],
  sourceTurnRanges: [
    { threadId: "session_1", startSequence: 1, endSequence: 2 },
    { threadId: "session_1", startSequence: 10, endSequence: 12 }
  ],
  targetBoxIds: [],
  targetTraceIds: ["trace_injected"],
  payload: {
    traceId: "trace_injected",
    title: "Injected Trace",
    description: "Injected trace.",
    traceType: "case_issue",
    summaryIds: ["summary_1", "summary_2"],
    boxIds: [],
    turnRanges: [
      { threadId: "session_1", startSequence: 1, endSequence: 2 },
      { threadId: "session_1", startSequence: 10, endSequence: 12 }
    ],
    continuityReason: "Injected continuity.",
    boundaryReason: "Injected boundary.",
    keywords: ["injected"]
  },
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

  it("uses an injected box planner", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({ id: "summary_1" }));
    const planner: BoxProposalPlanner = {
      async proposeBoxes() {
        return {
          proposals: [makeBoxProposal()],
          skippedCandidates: []
        };
      }
    };

    const reviewer = new SleepReviewer(store, { boxPlanner: planner });
    const result = await reviewer.proposeBoxes({ reviewedAt: "2026-05-05T06:00:00.000Z" });

    expect(result.proposals.map((proposal) => proposal.id)).toEqual(["proposal_box_box_topic_injected"]);
    await expect(store.listProposals({ proposalType: "box", state: "proposed" })).resolves.toHaveLength(1);
  });

  it("uses an injected trace planner", async () => {
    const store = new InMemoryStore();
    const planner: TraceProposalPlanner = {
      async proposeTraces() {
        return {
          proposals: [makeTraceProposal()],
          skippedCandidates: []
        };
      }
    };

    const reviewer = new SleepReviewer(store, { tracePlanner: planner });
    const result = await reviewer.proposeTraces({ reviewedAt: "2026-05-05T06:00:00.000Z" });

    expect(result.proposals.map((proposal) => proposal.id)).toEqual(["proposal_trace_trace_injected"]);
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
        // GAP-12-D: was 0.2 and stale. Decay is now min(strength, 1 * 0.5^(48/24)) = 0.25, which is not below 0.25.
        strength: 0.25,
        state: "compacted"
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
        // GAP-12-D: was 0.57 (0.8 * 0.5^(12/24)). The bound is 1 * 0.5^(12/24), rounded to 0.71.
        strength: 0.71,
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

  it("is idempotent at a fixed clock and halves once per elapsed half-life", async () => {
    const expected = (hours: number, halfLifeHours: number, strength: number) => Number(
      Math.max(0, Math.min(1, Math.min(
        strength,
        DECAY_BASELINE_STRENGTH * Math.pow(0.5, hours / halfLifeHours)
      ))).toFixed(2)
    );
    const base = makeSummary({
      id: "summary_decay",
      strength: 1,
      halfLifeHours: 24,
      lastAccessedAt: "2026-05-01T00:00:00.000Z",
      createdAt: "2026-04-01T00:00:00.000Z"
    });
    const strengths: number[] = [];
    let reviewed = "2026-05-02T00:00:00.000Z";
    const store = new InMemoryStore();
    await store.saveSummary(base);
    for (const hours of [24, 48, 72]) {
      reviewed = new Date(Date.parse("2026-05-01T00:00:00.000Z") + hours * 60 * 60 * 1000).toISOString();
      await new SleepReviewer(store).decaySummaries({ reviewedAt: reviewed });
      strengths.push((await store.listSummaries())[0]!.strength);
    }
    expect(strengths).toEqual([
      expected(24, 24, 1),
      expected(48, 24, expected(24, 24, 1)),
      expected(72, 24, expected(48, 24, expected(24, 24, 1)))
    ]);

    const repeated = new InMemoryStore();
    await repeated.saveSummary(base);
    const atOneHalfLife = "2026-05-02T00:00:00.000Z";
    for (let call = 0; call < 10; call += 1) {
      await new SleepReviewer(repeated).decaySummaries({ reviewedAt: atOneHalfLife });
    }
    expect((await repeated.listSummaries())[0]?.strength).toBe(expected(24, 24, 1));
  });

  it("writes nothing on a second decay at the same clock", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({
      id: "summary_once",
      createdAt: "2026-05-01T00:00:00.000Z",
      strength: 0.9,
      halfLifeHours: 24
    }));
    const reviewer = new SleepReviewer(store);
    await reviewer.decaySummaries({ reviewedAt: "2026-05-03T00:00:00.000Z" });
    let saves = 0;
    const saveSummary = store.saveSummary.bind(store);
    store.saveSummary = async (summary) => {
      saves += 1;
      return saveSummary(summary);
    };
    const second = await reviewer.decaySummaries({ reviewedAt: "2026-05-03T00:00:00.000Z" });
    expect(second.updatedSummaries).toEqual([]);
    expect(saves).toBe(0);
  });

  it("does not raise a weak summary that was accessed recently", async () => {
    const store = new InMemoryStore();
    const summary = makeSummary({
      id: "summary_weak",
      strength: 0.1,
      halfLifeHours: 24,
      lastAccessedAt: "2026-05-02T23:59:00.000Z",
      createdAt: "2026-05-01T00:00:00.000Z"
    });
    await store.saveSummary(summary);
    const result = await new SleepReviewer(store).decaySummaries({
      reviewedAt: "2026-05-03T00:00:00.000Z",
      staleStrengthThreshold: 0.05
    });
    expect(result.updatedSummaries).toEqual([]);
    expect((await store.listSummaries())[0]?.strength).toBe(0.1);
  });

  it("loads only decay-eligible states, including when the ineligible set grows", async () => {
    const ineligible = ["superseded", "proposed", "approved", "rejected", "disputed"] as const;
    const run = async (extraIneligible: number) => {
      const store = new InMemoryStore();
      const calls: Array<{ personId?: string; states?: readonly string[] } | undefined> = [];
      let returned = 0;
      const listSummaries = store.listSummaries.bind(store);
      store.listSummaries = async (filter) => {
        calls.push(filter);
        const rows = await listSummaries(filter);
        returned = rows.length;
        return rows;
      };
      for (let index = 0; index < 10; index += 1) {
        await store.saveSummary(makeSummary({ id: `eligible_${index}`, state: "active", personId: "person_a" }));
      }
      for (let index = 0; index < extraIneligible; index += 1) {
        await store.saveSummary(makeSummary({
          id: `ineligible_${index}`,
          state: ineligible[index % ineligible.length]!,
          personId: "person_a"
        }));
      }
      await store.saveSummary(makeSummary({ id: "other_person", state: "active", personId: "person_b" }));
      await new SleepReviewer(store).decaySummaries({
        reviewedAt: "2026-05-03T00:00:00.000Z",
        personId: "person_a"
      });
      return { calls, returned };
    };
    const small = await run(10);
    const large = await run(1_000);
    expect(small.calls).toHaveLength(1);
    expect(large.calls).toHaveLength(1);
    expect(small.calls[0]).toEqual({ personId: "person_a", states: DECAY_ELIGIBLE_STATES });
    expect(large.calls[0]).toEqual(small.calls[0]);
    expect(small.returned).toBe(10);
    expect(large.returned).toBe(10);
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
