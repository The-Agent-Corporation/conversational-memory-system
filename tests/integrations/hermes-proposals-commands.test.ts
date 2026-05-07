import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Box, MemoryProposal } from "../../src/domain/types.js";
import { approveHermesProposal } from "../../src/integrations/hermes/proposals-approve-command.js";
import { listHermesProposals } from "../../src/integrations/hermes/proposals-list-command.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";

let tempDir: string | null = null;

const makeTempDir = async (): Promise<string> => {
  tempDir = await mkdtemp(join(tmpdir(), "cms-hermes-proposals-"));
  return tempDir;
};

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

const turnRange = { threadId: "profile:default", startSequence: 1, endSequence: 3 };

const box = (overrides: Partial<Box> = {}): Box => ({
  id: "box_case_smith",
  title: "Smith",
  description: "Smith case.",
  parentBoxId: null,
  childBoxIds: [],
  summaryIds: ["summary_case"],
  turnRanges: [turnRange],
  state: "approved",
  createdAt: "2026-05-07T12:00:00.000Z",
  updatedAt: "2026-05-07T12:00:00.000Z",
  caseId: "smith",
  boxType: "case",
  summary: "Smith case overview.",
  lastActivityAt: "2026-05-07T12:00:00.000Z",
  ...overrides
});

const boxProposal = (overrides: Partial<MemoryProposal> = {}): MemoryProposal => ({
  id: "proposal_box_box_topic_smith_pip",
  proposalType: "box",
  state: "proposed",
  title: "Smith PIP",
  rationale: "Two summaries share Smith PIP.",
  confidence: 0.75,
  createdAt: "2026-05-07T12:00:00.000Z",
  reviewedAt: "2026-05-07T12:00:00.000Z",
  decidedAt: null,
  decidedBy: null,
  decisionNote: null,
  sourceSummaryIds: ["summary_1", "summary_2"],
  sourceTurnRanges: [turnRange],
  targetBoxIds: ["box_topic_smith_pip"],
  targetTraceIds: [],
  payload: {
    boxId: "box_topic_smith_pip",
    title: "Smith PIP",
    description: "Proposed Smith PIP topic box.",
    summary: "Smith PIP provider bill review.",
    boxType: "topic",
    candidateParentBoxId: null,
    keywords: ["smith", "pip"],
    evidence: ["Shared keywords: smith, pip"],
    sourceSummaryIds: ["summary_1", "summary_2"],
    sourceTurnRanges: [turnRange]
  },
  ...overrides
});

const parentChildProposal = (overrides: Partial<MemoryProposal> = {}): MemoryProposal => ({
  id: "proposal_parent_child_box_case_smith_box_topic_smith_pip",
  proposalType: "box_parent_child",
  state: "proposed",
  title: "Smith PIP parent assignment",
  rationale: "Smith PIP is a subtopic of Smith.",
  confidence: 0.7,
  createdAt: "2026-05-07T12:00:00.000Z",
  reviewedAt: "2026-05-07T12:00:00.000Z",
  decidedAt: null,
  decidedBy: null,
  decisionNote: null,
  sourceSummaryIds: ["summary_1"],
  sourceTurnRanges: [turnRange],
  targetBoxIds: ["box_case_smith", "box_topic_smith_pip"],
  targetTraceIds: [],
  payload: {
    parentBoxId: "box_case_smith",
    childBoxId: "box_topic_smith_pip",
    relationshipLabel: "case subtopic",
    rationale: "Smith PIP is narrower than Smith.",
    sourceSummaryIds: ["summary_1"]
  },
  ...overrides
});

const traceProposal = (overrides: Partial<MemoryProposal> = {}): MemoryProposal => ({
  id: "proposal_trace_trace_smith_pip_provider_bill",
  proposalType: "trace",
  state: "proposed",
  title: "Smith PIP Provider Bill",
  rationale: "Summaries continue provider bill review.",
  confidence: 0.8,
  createdAt: "2026-05-07T12:00:00.000Z",
  reviewedAt: "2026-05-07T12:00:00.000Z",
  decidedAt: null,
  decidedBy: null,
  decisionNote: null,
  sourceSummaryIds: ["summary_1", "summary_3"],
  sourceTurnRanges: [turnRange],
  targetBoxIds: ["box_topic_smith_pip"],
  targetTraceIds: ["trace_smith_pip_provider_bill"],
  payload: {
    traceId: "trace_smith_pip_provider_bill",
    title: "Smith PIP Provider Bill",
    description: "Smith PIP provider bill review continuation.",
    traceType: "case_issue",
    summaryIds: ["summary_1", "summary_3"],
    boxIds: ["box_topic_smith_pip"],
    turnRanges: [turnRange],
    continuityReason: "Both summaries discuss provider bills.",
    boundaryReason: "BI summaries excluded.",
    keywords: ["smith", "pip", "provider", "bill"]
  },
  ...overrides
});

describe("Hermes proposal commands", () => {
  it("lists proposed proposals without payloads by default", async () => {
    const dir = await makeTempDir();
    const databasePath = join(dir, "memory.sqlite");
    const store = new SqliteStore(databasePath);
    await store.saveProposal(boxProposal());
    await store.saveProposal(boxProposal({ id: "proposal_rejected", state: "rejected" }));
    store.close();

    const result = await listHermesProposals({
      databasePath,
      input: JSON.stringify({ state: "proposed", limit: 10 })
    });

    expect(result).toEqual({
      ok: true,
      count: 1,
      proposals: [
        expect.objectContaining({
          id: "proposal_box_box_topic_smith_pip",
          proposalType: "box",
          state: "proposed"
        })
      ]
    });
    expect(result.proposals[0]).not.toHaveProperty("payload");

    const withPayload = await listHermesProposals({
      databasePath,
      input: JSON.stringify({ include_payload: true })
    });
    expect(withPayload.proposals[0]).toHaveProperty("payload");
  });

  it("approves box, parent-child, and trace proposals", async () => {
    const dir = await makeTempDir();
    const databasePath = join(dir, "memory.sqlite");
    const store = new SqliteStore(databasePath);
    await store.saveProposal(boxProposal());
    await store.saveBox(box());
    await store.saveBox(box({ id: "box_topic_smith_pip", title: "Smith PIP", boxType: "topic", summary: "Smith PIP" }));
    await store.saveProposal(parentChildProposal());
    await store.saveProposal(traceProposal());
    store.close();

    await expect(approveHermesProposal({
      databasePath,
      input: JSON.stringify({
        proposal_id: "proposal_box_box_topic_smith_pip",
        decided_at: "2026-05-07T14:00:00.000Z",
        reviewer: "aaron",
        note: "Looks right."
      })
    })).resolves.toMatchObject({
      ok: true,
      proposalId: "proposal_box_box_topic_smith_pip",
      proposalType: "box",
      approvedAt: "2026-05-07T14:00:00.000Z",
      updatedProposalIds: ["proposal_box_box_topic_smith_pip"]
    });

    await expect(approveHermesProposal({
      databasePath,
      input: JSON.stringify({
        proposal_id: "proposal_parent_child_box_case_smith_box_topic_smith_pip",
        decided_at: "2026-05-07T14:00:00.000Z"
      })
    })).resolves.toMatchObject({
      updatedBoxIds: ["box_case_smith", "box_topic_smith_pip"]
    });

    await expect(approveHermesProposal({
      databasePath,
      input: JSON.stringify({
        proposal_id: "proposal_trace_trace_smith_pip_provider_bill",
        decided_at: "2026-05-07T14:00:00.000Z"
      })
    })).resolves.toMatchObject({
      createdTraceIds: ["trace_smith_pip_provider_bill"]
    });
  });

  it("fails approving a missing proposal with a clear error", async () => {
    const dir = await makeTempDir();
    const databasePath = join(dir, "memory.sqlite");
    const store = new SqliteStore(databasePath);
    store.close();

    await expect(approveHermesProposal({
      databasePath,
      input: JSON.stringify({
        proposal_id: "missing",
        decided_at: "2026-05-07T14:00:00.000Z"
      })
    })).rejects.toThrow("Proposal missing was not found");
  });
});

export { box, boxProposal, parentChildProposal, traceProposal, makeTempDir };
