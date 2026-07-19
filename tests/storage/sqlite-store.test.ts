import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanonicalEvent, MemorySource, Person } from "../../src/domain/canonical.js";
import type { ImportCheckpoint } from "../../src/imports/types.js";
import type { HistoricalBootstrapCheckpoint } from "../../src/bootstrap/types.js";
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

const makePerson = (overrides: Partial<Person> = {}): Person => ({
  id: "person_1",
  displayName: "Test Person",
  createdAt: "2026-07-16T10:00:00.000Z",
  ...overrides
});

const makeSource = (overrides: Partial<MemorySource> = {}): MemorySource => ({
  id: "source_1",
  personId: "person_1",
  application: "codex",
  profileId: "default",
  instanceId: "default",
  createdAt: "2026-07-16T10:00:00.000Z",
  lastImportedAt: "2026-07-16T10:01:00.000Z",
  ...overrides
});

const makeCanonicalEvent = (
  overrides: Partial<CanonicalEvent> = {}
): CanonicalEvent => ({
  id: "event_1",
  personId: "person_1",
  sourceId: "source_1",
  sourceApplication: "codex",
  sourceProfileId: "default",
  nativeSessionId: "session_1",
  nativeEventId: "native_1",
  nativeSequence: 1,
  causalParentId: null,
  role: "user",
  content: "Build the universal memory system.",
  occurredAt: "2026-07-16T10:00:00.000Z",
  importedAt: "2026-07-16T10:01:00.000Z",
  provenance: "direct_user_input",
  trustLevel: "high",
  contentHash: "hash_1",
  parserVersion: "codex-jsonl/v1",
  metadata: {},
  ...overrides
});

const makeImportCheckpoint = (
  overrides: Partial<ImportCheckpoint> = {}
): ImportCheckpoint => ({
  id: "checkpoint_1",
  personId: "person_1",
  candidateId: "codex_candidate_1",
  resourcePath: "sessions/2026/07/16/rollout-session-1.jsonl",
  fileIdentity: "1:2",
  byteOffset: 120,
  recordIndex: 4,
  nativeSessionId: "session_1",
  parserVersion: "codex-rollout/v1",
  updatedAt: "2026-07-16T10:01:00.000Z",
  ...overrides
});

const makeBootstrapCheckpoint = (
  overrides: Partial<HistoricalBootstrapCheckpoint> = {}
): HistoricalBootstrapCheckpoint => ({
  id: "bootstrap_person_1",
  personId: "person_1",
  processorVersion: "historical-bootstrap/v1",
  processedEventCount: 2,
  lastCanonicalEventId: "event_2",
  rollingPrefixHash: "prefix_hash",
  activeTopic: {
    host: "unknown",
    profileId: "person_1",
    hostSessionId: "person:person_1",
    topicLabel: "Universal Memory",
    currentTopicSummary: "Universal Memory (2 turns, seq 1-2)",
    sourceTurnRange: {
      threadId: "person:person_1",
      startSequence: 1,
      endSequence: 2
    },
    turnCount: 2,
    lastEventId: "event_2",
    updatedAt: "2026-07-16T10:01:00.000Z"
  },
  updatedAt: "2026-07-16T10:01:00.000Z",
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
  sourceTraceIds: [],
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
  decidedAt: null,
  decidedBy: null,
  decisionNote: null,
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

  it("persists person-scoped sources and canonical events across store instances", async () => {
    await store.savePerson(makePerson());
    await store.saveSource(makeSource());
    await store.saveCanonicalEvent(makeCanonicalEvent());
    store.close();

    store = new SqliteStore(databasePath);

    await expect(store.getPerson("person_1")).resolves.toEqual(makePerson());
    await expect(store.listSources("person_1")).resolves.toEqual([makeSource()]);
    await expect(store.listCanonicalEvents("person_1")).resolves.toEqual([
      makeCanonicalEvent()
    ]);
  });

  it("persists import checkpoints and protects their person ownership", async () => {
    await store.saveImportCheckpoint(makeImportCheckpoint());
    store.close();

    store = new SqliteStore(databasePath);

    await expect(store.getImportCheckpoint("checkpoint_1")).resolves.toEqual(
      makeImportCheckpoint()
    );
    await expect(store.listImportCheckpoints("person_1")).resolves.toEqual([
      makeImportCheckpoint()
    ]);
    await expect(store.listImportCheckpoints("person_2")).resolves.toEqual([]);
    await expect(store.saveImportCheckpoint(makeImportCheckpoint({ personId: "person_2" })))
      .rejects.toThrow("different person");
  });

  it("persists historical bootstrap checkpoints and protects person ownership", async () => {
    await store.saveBootstrapCheckpoint(makeBootstrapCheckpoint());
    store.close();

    store = new SqliteStore(databasePath);
    await expect(store.getBootstrapCheckpoint("bootstrap_person_1")).resolves.toEqual(
      makeBootstrapCheckpoint()
    );
    await expect(
      store.saveBootstrapCheckpoint(makeBootstrapCheckpoint({ personId: "person_2" }))
    ).rejects.toThrow(/different person/i);
  });

  it("orders the personal timeline globally and keeps people isolated", async () => {
    await store.saveCanonicalEvent(makeCanonicalEvent({
      id: "event_later",
      nativeSequence: 1,
      occurredAt: "2026-07-16T10:05:00.000Z"
    }));
    await store.saveCanonicalEvent(makeCanonicalEvent({
      id: "event_same_time_later_sequence",
      nativeSequence: 9,
      occurredAt: "2026-07-16T10:00:00.000Z"
    }));
    await store.saveCanonicalEvent(makeCanonicalEvent({
      id: "event_same_time_earlier_sequence",
      nativeSequence: 2,
      occurredAt: "2026-07-16T10:00:00.000Z"
    }));
    await store.saveCanonicalEvent(makeCanonicalEvent({
      id: "event_other_person",
      personId: "person_2",
      sourceId: "source_2",
      occurredAt: "2026-07-16T09:00:00.000Z"
    }));

    const events = await store.listCanonicalEvents("person_1");
    expect(events.map((event) => event.id)).toEqual([
      "event_same_time_earlier_sequence",
      "event_same_time_later_sequence",
      "event_later"
    ]);
    await expect(store.listCanonicalEvents("person_2")).resolves.toEqual([
      expect.objectContaining({ id: "event_other_person", personId: "person_2" })
    ]);
  });

  it("rejects reassignment of source and event identities across people", async () => {
    await store.saveSource(makeSource());
    await store.saveCanonicalEvent(makeCanonicalEvent());

    await expect(store.saveSource(makeSource({ personId: "person_2" })))
      .rejects.toThrow("different person");
    await expect(store.saveCanonicalEvent(makeCanonicalEvent({ personId: "person_2" })))
      .rejects.toThrow("different person");
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
    await expect(store.getBox("box_1")).resolves.toEqual(makeBox());
    await expect(store.getBox("missing")).resolves.toBeNull();
    await expect(store.listAnchors()).resolves.toEqual([makeAnchor()]);
    await expect(store.listInjections("session_1")).resolves.toEqual([makeInjection()]);
  });

  it("persists proposals and traces", async () => {
    const proposal = makeProposal();
    const trace = makeTrace();

    await store.saveProposal(proposal);
    await store.saveTrace(trace);

    await expect(store.listProposals()).resolves.toEqual([proposal]);
    await expect(store.getProposal("proposal_trace_smith_pip_bills")).resolves.toEqual(proposal);
    await expect(store.getProposal("missing")).resolves.toBeNull();
    await expect(store.listProposals({ state: "proposed", proposalType: "trace" })).resolves.toEqual([proposal]);
    await expect(store.listProposals({ state: "approved" })).resolves.toEqual([]);
    await expect(store.listTraces()).resolves.toEqual([trace]);
    await expect(store.getTrace("trace_smith_pip_bills")).resolves.toEqual(trace);
    await expect(store.getTrace("missing")).resolves.toBeNull();
    await expect(store.listTraces({ state: "proposed" })).resolves.toEqual([trace]);
  });
});
