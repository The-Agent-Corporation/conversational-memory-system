import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Box, MemoryProposal } from "../../src/domain/types.js";
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
});

export { box, boxProposal, makeTempDir };
