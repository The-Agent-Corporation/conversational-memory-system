import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Box, MemoryProposal, Summary } from "../../src/domain/types.js";
import type { BoxProposalPlanner } from "../../src/boxes/box-proposal-planner.js";
import type { TraceProposalPlanner } from "../../src/traces/trace-proposal-planner.js";
import { sleepHermesMemory } from "../../src/integrations/hermes/sleep-command.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";

let tempDir: string | null = null;

const makeTempDir = async (): Promise<string> => {
  tempDir = await mkdtemp(join(tmpdir(), "cms-hermes-sleep-"));
  return tempDir;
};

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

const summary = (overrides: Partial<Summary> = {}): Summary => ({
  id: "summary_1",
  summaryText: "Smith PIP demand strategy and coverage timing.",
  sourceTurnRanges: [{ threadId: "profile:default", startSequence: 1, endSequence: 2 }],
  sourceSummaryIds: [],
  boxIds: [],
  embedding: null,
  createdAt: "2026-05-01T00:00:00.000Z",
  model: "test",
  promptVersion: "v1",
  confidence: 0.9,
  state: "compacted",
  detailLevel: "brief",
  tokenCount: 8,
  lastAccessedAt: null,
  version: 1,
  strength: 0.8,
  retrievalCount: 0,
  retrievedAt: null,
  halfLifeHours: 24,
  outcomeScore: null,
  ...overrides
});

const box = (overrides: Partial<Box> = {}): Box => ({
  id: "box_topic_old",
  title: "Old Topic",
  description: "Existing approved topic.",
  parentBoxId: null,
  childBoxIds: [],
  summaryIds: ["summary_old"],
  turnRanges: [{ threadId: "profile:default", startSequence: 20, endSequence: 22 }],
  state: "approved",
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: "2026-05-01T00:00:00.000Z",
  caseId: null,
  boxType: "topic",
  summary: "Old Topic",
  lastActivityAt: "2026-05-01T00:00:00.000Z",
  ...overrides
});

const boxProposal = (reviewedAt: string): MemoryProposal => ({
  id: "proposal_box_box_topic_openrouter",
  proposalType: "box",
  state: "proposed",
  title: "OpenRouter",
  rationale: "OpenRouter planner proposal.",
  confidence: 0.8,
  createdAt: reviewedAt,
  reviewedAt,
  decidedAt: null,
  decidedBy: null,
  decisionNote: null,
  sourceSummaryIds: ["summary_1"],
  sourceTurnRanges: [{ threadId: "profile:default", startSequence: 1, endSequence: 2 }],
  targetBoxIds: ["box_topic_openrouter"],
  targetTraceIds: [],
  payload: {
    boxId: "box_topic_openrouter",
    title: "OpenRouter",
    description: "OpenRouter planner box.",
    summary: "OpenRouter planned this box.",
    boxType: "topic",
    candidateParentBoxId: null,
    keywords: ["openrouter"],
    evidence: ["planner"],
    sourceSummaryIds: ["summary_1"],
    sourceTurnRanges: [{ threadId: "profile:default", startSequence: 1, endSequence: 2 }]
  }
});

const traceProposal = (reviewedAt: string): MemoryProposal => ({
  id: "proposal_trace_trace_openrouter",
  proposalType: "trace",
  state: "proposed",
  title: "OpenRouter Trace",
  rationale: "OpenRouter trace proposal.",
  confidence: 0.8,
  createdAt: reviewedAt,
  reviewedAt,
  decidedAt: null,
  decidedBy: null,
  decisionNote: null,
  sourceSummaryIds: ["summary_1", "summary_2"],
  sourceTurnRanges: [
    { threadId: "profile:default", startSequence: 1, endSequence: 2 },
    { threadId: "profile:default", startSequence: 10, endSequence: 12 }
  ],
  targetBoxIds: [],
  targetTraceIds: ["trace_openrouter"],
  payload: {
    traceId: "trace_openrouter",
    title: "OpenRouter Trace",
    description: "OpenRouter trace.",
    traceType: "case_issue",
    summaryIds: ["summary_1", "summary_2"],
    boxIds: [],
    turnRanges: [
      { threadId: "profile:default", startSequence: 1, endSequence: 2 },
      { threadId: "profile:default", startSequence: 10, endSequence: 12 }
    ],
    continuityReason: "OpenRouter continuity.",
    boundaryReason: "OpenRouter boundary.",
    keywords: ["openrouter"]
  }
});

describe("Hermes sleep command", () => {
  it("runs sleep review over the SQLite memory store", async () => {
    const dir = await makeTempDir();
    const databasePath = join(dir, "memory.sqlite");
    const store = new SqliteStore(databasePath);
    await store.saveSummary(summary({
      id: "summary_1",
      summaryText: "Smith PIP provider bill review and coverage timing."
    }));
    await store.saveSummary(summary({
      id: "summary_2",
      summaryText: "Smith PIP deadline and provider bill review.",
      sourceTurnRanges: [{ threadId: "profile:default", startSequence: 10, endSequence: 12 }],
      createdAt: "2026-05-01T01:00:00.000Z"
    }));
    await store.saveSummary(summary({
      id: "summary_old",
      summaryText: "Old Topic outdated item.",
      sourceTurnRanges: [{ threadId: "profile:default", startSequence: 20, endSequence: 22 }],
      state: "stale",
      strength: 0.1
    }));
    await store.saveBox(box());
    store.close();

    const result = await sleepHermesMemory({
      databasePath,
      input: JSON.stringify({
        reviewed_at: "2026-05-03T00:00:00.000Z",
        minimum_summaries_per_box: 2,
        minimum_trace_summaries: 2,
        stale_strength_threshold: 0.25
      })
    });

    expect(result.ok).toBe(true);
    expect(result.reviewedAt).toBe("2026-05-03T00:00:00.000Z");
    expect(result.updatedSummaryIds).toEqual(["summary_1", "summary_2", "summary_old"]);
    expect(result.updatedBoxIds).toEqual(["box_topic_old"]);
    expect(result.proposedBoxIds).toEqual(["box_topic_smith_pip"]);
    expect(result.proposalIds).toEqual(expect.arrayContaining([
      "proposal_box_box_topic_smith_pip",
      "proposal_trace_trace_smith_pip_provider_bill"
    ]));
    expect(result.proposedTraceIds).toEqual(["trace_smith_pip_provider_bill"]);
    expect(result.noopReason).toBeNull();

    const verifyStore = new SqliteStore(databasePath);
    const boxes = await verifyStore.listBoxes();
    expect(boxes).toEqual([
      expect.objectContaining({ id: "box_topic_old", state: "stale" }),
      expect.objectContaining({
        id: "box_topic_smith_pip",
        state: "proposed",
        summaryIds: ["summary_1", "summary_2"]
      })
    ]);
    verifyStore.close();
  });

  it("returns a no-op reason when sleep review makes no changes", async () => {
    const dir = await makeTempDir();
    const databasePath = join(dir, "memory.sqlite");
    const result = await sleepHermesMemory({
      databasePath,
      input: JSON.stringify({ reviewed_at: "2026-05-03T00:00:00.000Z" })
    });

    expect(result).toEqual({
      ok: true,
      reviewedAt: "2026-05-03T00:00:00.000Z",
      updatedSummaryIds: [],
      updatedBoxIds: [],
      proposedBoxIds: [],
      proposalIds: [],
      proposedTraceIds: [],
      noopReason: "No summaries or boxes needed sleep review changes."
    });
  });

  it("uses injected OpenRouter planners when proposal mode is openrouter", async () => {
    const dir = await makeTempDir();
    const databasePath = join(dir, "memory.sqlite");
    const store = new SqliteStore(databasePath);
    await store.saveSummary(summary({ id: "summary_1" }));
    await store.saveSummary(summary({
      id: "summary_2",
      sourceTurnRanges: [{ threadId: "profile:default", startSequence: 10, endSequence: 12 }]
    }));
    store.close();

    const boxPlanner: BoxProposalPlanner = {
      async proposeBoxes(request) {
        return { proposals: [boxProposal(request.reviewedAt)], skippedCandidates: [] };
      }
    };
    const tracePlanner: TraceProposalPlanner = {
      async proposeTraces(request) {
        return { proposals: [traceProposal(request.reviewedAt)], skippedCandidates: [] };
      }
    };

    const result = await sleepHermesMemory({
      databasePath,
      input: JSON.stringify({
        reviewed_at: "2026-05-03T00:00:00.000Z",
        proposal_mode: "openrouter"
      }),
      env: {
        OPENROUTER_API_KEY: "test-key",
        OPENROUTER_MODEL: "openai/gpt-4.1-mini"
      },
      proposalPlannerFactory: () => ({ boxPlanner, tracePlanner })
    });

    expect(result.proposalIds).toEqual([
      "proposal_box_box_topic_openrouter",
      "proposal_trace_trace_openrouter"
    ]);
    expect(result.proposedBoxIds).toEqual(["box_topic_openrouter"]);
    expect(result.proposedTraceIds).toEqual(["trace_openrouter"]);
  });

  it("falls back to deterministic planners in hybrid mode when OpenRouter is not configured", async () => {
    const dir = await makeTempDir();
    const databasePath = join(dir, "memory.sqlite");
    const store = new SqliteStore(databasePath);
    await store.saveSummary(summary({
      id: "summary_1",
      summaryText: "Smith PIP provider bill review and coverage timing."
    }));
    await store.saveSummary(summary({
      id: "summary_2",
      summaryText: "Smith PIP deadline and provider bill review.",
      sourceTurnRanges: [{ threadId: "profile:default", startSequence: 10, endSequence: 12 }]
    }));
    store.close();

    const result = await sleepHermesMemory({
      databasePath,
      input: JSON.stringify({
        reviewed_at: "2026-05-03T00:00:00.000Z",
        proposal_mode: "hybrid",
        minimum_summaries_per_box: 2,
        minimum_trace_summaries: 2
      }),
      env: {},
      proposalPlannerFactory: () => null
    });

    expect(result.proposalIds).toEqual(expect.arrayContaining([
      "proposal_box_box_topic_smith_pip",
      "proposal_trace_trace_smith_pip_provider_bill"
    ]));
  });

  it("requires OpenRouter configuration in openrouter proposal mode", async () => {
    const dir = await makeTempDir();
    const databasePath = join(dir, "memory.sqlite");

    await expect(sleepHermesMemory({
      databasePath,
      input: JSON.stringify({ proposal_mode: "openrouter" }),
      env: {},
      proposalPlannerFactory: () => null
    })).rejects.toThrow("OpenRouter proposal mode requires OPENROUTER_API_KEY and OPENROUTER_MODEL.");
  });
});
