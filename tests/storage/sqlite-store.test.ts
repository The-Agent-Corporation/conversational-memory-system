import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Anchor, Box, InjectionPacket, MemoryProposal, MemoryTrace, Summary, Turn } from "../../src/domain/types.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";

const makeTurn = (overrides: Partial<Turn> = {}): Turn => ({
  id: "turn_1",
  threadId: "session_1",
  sequence: 1,
  role: "user",
  content: "Let's talk about Smith PIP.",
  createdAt: "2026-05-04T10:00:00.000Z",
  provenance: "direct_user_input",
  trustLevel: "high",
  metadata: { sourceMetadata: { channel: "telegram" } },
  contentHash: "hash_1",
  ...overrides
});

const makeSummary = (overrides: Partial<Summary> = {}): Summary => ({
  id: "summary_1",
  summaryText: "Discussed Smith PIP coverage strategy.",
  sourceTurnRanges: [{ threadId: "session_1", startSequence: 1, endSequence: 2 }],
  sourceSummaryIds: [],
  boxIds: ["box_1"],
  embedding: null,
  createdAt: "2026-05-04T10:05:00.000Z",
  model: "test-summarizer",
  promptVersion: "v1",
  confidence: 0.9,
  state: "active",
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
  id: "box_1",
  title: "Smith case",
  description: "Case-level memory box",
  parentBoxId: null,
  childBoxIds: [],
  summaryIds: ["summary_1"],
  turnRanges: [{ threadId: "session_1", startSequence: 1, endSequence: 2 }],
  state: "active",
  createdAt: "2026-05-04T10:00:00.000Z",
  updatedAt: "2026-05-04T10:00:00.000Z",
  caseId: "smith",
  boxType: "case",
  summary: "Smith case discussion",
  lastActivityAt: "2026-05-04T10:00:00.000Z",
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

const makeInjection = (overrides: Partial<InjectionPacket> = {}): InjectionPacket => ({
  id: "inject_1",
  hostSessionId: "session_1",
  currentTopicSummary: "User is discussing Smith PIP coverage.",
  selectedMemory: "Prior Smith PIP demand strategy exists.",
  sourceSummaryIds: ["summary_1"],
  sourceTurnRanges: [{ threadId: "session_1", startSequence: 1, endSequence: 2 }],
  boxIds: ["box_1"],
  relevanceReason: "Current topic matches Smith PIP summary.",
  confidence: 0.86,
  disclosureText: "This came from the Smith PIP discussion on May 4.",
  createdAt: "2026-05-04T10:06:00.000Z",
  ...overrides
});

const makeProposal = (overrides: Partial<MemoryProposal> = {}): MemoryProposal => ({
  id: "proposal_trace_smith_pip_bills",
  proposalType: "trace",
  state: "proposed",
  title: "Smith PIP Provider Bill Review",
  rationale: "Two summaries continue the same Smith PIP provider bill review issue.",
  confidence: 0.78,
  createdAt: "2026-05-07T12:00:00.000Z",
  reviewedAt: "2026-05-07T12:00:00.000Z",
  sourceSummaryIds: ["summary_1", "summary_3"],
  sourceTurnRanges: [{ threadId: "profile:default", startSequence: 1, endSequence: 3 }],
  targetBoxIds: ["box_topic_smith_pip"],
  targetTraceIds: ["trace_smith_pip_bills"],
  payload: {
    traceId: "trace_smith_pip_bills",
    title: "Smith PIP Provider Bill Review",
    description: "Non-contiguous summaries continue the Smith PIP provider bill review issue.",
    traceType: "case_issue",
    summaryIds: ["summary_1", "summary_3"],
    boxIds: ["box_topic_smith_pip"],
    turnRanges: [{ threadId: "profile:default", startSequence: 1, endSequence: 3 }],
    continuityReason: "Both summaries discuss Smith PIP provider bill review.",
    boundaryReason: "Smith BI summaries were excluded.",
    keywords: ["smith", "pip", "provider", "bill"]
  },
  ...overrides
});

const makeTrace = (overrides: Partial<MemoryTrace> = {}): MemoryTrace => ({
  id: "trace_smith_pip_bills",
  title: "Smith PIP Provider Bill Review",
  description: "Approved trace for Smith PIP bill review.",
  traceType: "case_issue",
  state: "proposed",
  summaryIds: ["summary_1", "summary_3"],
  boxIds: ["box_topic_smith_pip"],
  turnRanges: [{ threadId: "profile:default", startSequence: 1, endSequence: 3 }],
  createdAt: "2026-05-07T12:00:00.000Z",
  updatedAt: "2026-05-07T12:00:00.000Z",
  lastActivityAt: "2026-05-07T12:00:00.000Z",
  confidence: 0.78,
  rationale: "The summaries continue the same provider bill review issue.",
  ...overrides
});

describe("SqliteStore", () => {
  let tempDir: string;
  let databasePath: string;
  let store: SqliteStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "memory-sqlite-"));
    databasePath = join(tempDir, "memory.db");
    store = new SqliteStore(databasePath);
  });

  afterEach(async () => {
    store.close();
    await rm(tempDir, { force: true, recursive: true });
  });

  it("persists turns across store instances", async () => {
    await store.saveTurn(makeTurn());
    store.close();

    store = new SqliteStore(databasePath);

    await expect(store.listTurns("session_1")).resolves.toEqual([makeTurn()]);
  });

  it("upserts turns by id and lists them by sequence", async () => {
    await store.saveTurn(makeTurn({ id: "turn_2", sequence: 2, content: "second" }));
    await store.saveTurn(makeTurn({ id: "turn_1", sequence: 1, content: "first" }));
    await store.saveTurn(makeTurn({ id: "turn_2", sequence: 3, content: "replacement" }));

    const turns = await store.listTurns("session_1");

    expect(turns).toHaveLength(2);
    expect(turns.map((turn) => [turn.id, turn.sequence, turn.content])).toEqual([
      ["turn_1", 1, "first"],
      ["turn_2", 3, "replacement"]
    ]);
  });

  it("rejects invalid direct saves before writing", async () => {
    await expect(
      store.saveTurn({
        ...makeTurn(),
        metadata: { transform: () => "not JSON" }
      } as unknown as Turn)
    ).rejects.toThrow();

    await expect(store.listTurns("session_1")).resolves.toEqual([]);
  });

  it("persists summaries, boxes, anchors, and injections", async () => {
    await store.saveSummary(makeSummary());
    await store.saveBox(makeBox());
    await store.saveAnchor(makeAnchor());
    await store.saveInjection(makeInjection());

    await expect(store.listSummaries()).resolves.toEqual([makeSummary()]);
    await expect(store.listBoxes()).resolves.toEqual([makeBox()]);
    await expect(store.listAnchors()).resolves.toEqual([makeAnchor()]);
    await expect(store.listInjections("session_1")).resolves.toEqual([makeInjection()]);
  });

  it("persists proposals and traces", async () => {
    const proposal = makeProposal();
    const trace = makeTrace();

    await store.saveProposal(proposal);
    await store.saveTrace(trace);

    await expect(store.listProposals()).resolves.toEqual([proposal]);
    await expect(store.listProposals({ state: "proposed", proposalType: "trace" })).resolves.toEqual([proposal]);
    await expect(store.listProposals({ state: "approved" })).resolves.toEqual([]);
    await expect(store.listTraces()).resolves.toEqual([trace]);
    await expect(store.listTraces({ state: "proposed" })).resolves.toEqual([trace]);
  });
});
