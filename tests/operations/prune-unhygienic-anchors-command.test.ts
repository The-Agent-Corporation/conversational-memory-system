import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanonicalEvent } from "../../src/domain/canonical.js";
import type { Anchor, Box, InjectionPacket, MemoryProposal, MemoryTrace, Summary, Turn } from "../../src/domain/types.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";
import {
  runPruneUnhygienicAnchorsCommand,
  type PruneUnhygienicAnchorsCommandResult
} from "../../src/operations/prune-unhygienic-anchors-command.js";

/**
 * `memory prune-unhygienic-anchors` (REQ-052/REQ-053/REQ-054, GAP-11-D closure, Plan 11-17). Mirrors
 * `prune-superseded-command.test.ts`'s shape: a real temp-file `SqliteStore`, full-snapshot dry-run
 * equality, a fail-closed backup gate, interrupted-vs-uninterrupted resumability, and idempotence via
 * a commit spy. Anchor fixtures are ported from `tests/storage/anchor-hygiene-prune.test.ts` (Plan
 * 11-16) rather than invented fresh, per the plan's read_first instruction.
 *
 * No test in this file opens a real database or backup path -- every path is a scratch file inside a
 * `mkdtemp` directory created and torn down by this suite.
 */

const NOW = "2026-07-27T10:00:00.000Z";

function openStore(databasePath: string): SqliteStore {
  return new SqliteStore(databasePath, { clock: { now: () => NOW } });
}

function makeCanonicalEvent(overrides: Partial<CanonicalEvent> = {}): CanonicalEvent {
  return {
    id: "event_1",
    personId: "person_prune",
    sourceId: "source_prune",
    sourceApplication: "synthetic",
    sourceProfileId: "default",
    nativeSessionId: "session_prune",
    nativeEventId: "native_1",
    nativeSequence: 1,
    causalParentId: null,
    role: "user",
    content: "Fixture canonical event content.",
    occurredAt: NOW,
    importedAt: NOW,
    provenance: "direct_user_input",
    trustLevel: "high",
    contentHash: "hash_event_1",
    parserVersion: "synthetic/v1",
    metadata: {},
    ...overrides
  };
}

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: "turn_1",
    threadId: "session_prune",
    sequence: 1,
    role: "user",
    content: "Fixture turn content.",
    createdAt: NOW,
    provenance: "direct_user_input",
    trustLevel: "high",
    metadata: {},
    contentHash: "hash_turn_1",
    ...overrides
  };
}

function makeAnchor(overrides: Partial<Anchor> = {}): Anchor {
  return {
    id: "anchor_1",
    personId: "person_prune",
    turnId: "turn_1",
    threadId: "session_prune",
    boxId: null,
    anchorType: "key_fact",
    content: "Fixture conversational anchor content, because it matters.",
    embedding: null,
    createdAt: NOW,
    trustLevel: "high",
    source: "direct_user_input",
    ...overrides
  };
}

function makeSummary(overrides: Partial<Summary> = {}): Summary {
  return {
    id: "summary_1",
    personId: "person_prune",
    scopeIds: ["personal"],
    summaryText: "Fixture summary text for prune-unhygienic-anchors-command control counts.",
    sourceTurnRanges: [{ threadId: "session_prune", startSequence: 1, endSequence: 2 }],
    sourceCanonicalEventIds: [],
    sourceSummaryIds: [],
    boxIds: [],
    embedding: null,
    createdAt: NOW,
    model: "test-summarizer",
    promptVersion: "v1",
    confidence: 0.9,
    state: "active",
    detailLevel: "brief",
    tokenCount: 12,
    lastAccessedAt: null,
    version: 1,
    strength: 0.8,
    retrievalCount: 0,
    retrievedAt: null,
    halfLifeHours: 168,
    outcomeScore: null,
    ...overrides
  };
}

function makeBox(overrides: Partial<Box> = {}): Box {
  return {
    id: "box_1",
    personId: "person_prune",
    title: "Fixture box",
    description: "Fixture box for prune-unhygienic-anchors-command control counts",
    parentBoxId: null,
    childBoxIds: [],
    summaryIds: [],
    turnRanges: [{ threadId: "session_prune", startSequence: 1, endSequence: 2 }],
    state: "active",
    createdAt: NOW,
    updatedAt: NOW,
    caseId: null,
    boxType: "general",
    summary: "Fixture box summary",
    lastActivityAt: NOW,
    ...overrides
  };
}

function makeTrace(overrides: Partial<MemoryTrace> = {}): MemoryTrace {
  return {
    id: "trace_1",
    personId: "person_prune",
    title: "Fixture trace",
    description: "Fixture trace for prune-unhygienic-anchors-command control counts",
    traceType: "case_issue",
    state: "approved",
    summaryIds: ["summary_a", "summary_b"],
    boxIds: [],
    turnRanges: [{ threadId: "session_prune", startSequence: 1, endSequence: 2 }],
    createdAt: NOW,
    updatedAt: NOW,
    lastActivityAt: NOW,
    confidence: 0.8,
    rationale: "Fixture rationale",
    ...overrides
  };
}

function makeProposal(overrides: Partial<MemoryProposal> = {}): MemoryProposal {
  return {
    id: "proposal_1",
    personId: "person_prune",
    proposalType: "box",
    state: "proposed",
    title: "Fixture proposal",
    rationale: "Fixture rationale for prune-unhygienic-anchors-command control counts",
    confidence: 0.7,
    createdAt: NOW,
    reviewedAt: NOW,
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    sourceSummaryIds: [],
    sourceTurnRanges: [{ threadId: "session_prune", startSequence: 1, endSequence: 2 }],
    targetBoxIds: [],
    targetTraceIds: [],
    payload: {
      boxId: "box_from_proposal",
      title: "Fixture proposal box",
      description: "",
      summary: "Fixture proposal box summary",
      boxType: "general",
      candidateParentBoxId: null,
      keywords: [],
      evidence: [],
      sourceSummaryIds: [],
      sourceTurnRanges: [{ threadId: "session_prune", startSequence: 1, endSequence: 2 }]
    },
    ...overrides
  };
}

function makeInjection(overrides: Partial<InjectionPacket> = {}): InjectionPacket {
  return {
    id: "injection_1",
    personId: "person_prune",
    allowedScopeIds: ["personal"],
    hostSessionId: "session_prune",
    currentTopicSummary: "Fixture topic",
    selectedMemory: "Fixture memory text",
    sourceSummaryIds: [],
    sourceTraceIds: [],
    sourceTurnRanges: [{ threadId: "session_prune", startSequence: 1, endSequence: 2 }],
    boxIds: [],
    relevanceReason: "Fixture relevance",
    confidence: 0.8,
    disclosureText: "Fixture disclosure",
    createdAt: NOW,
    ...overrides
  };
}

const PERSON_ID = "person_prune";
const OTHER_PERSON_ID = "person_other";
const THREAD_ID = "session_prune";

async function seedPerson(store: SqliteStore, personId = PERSON_ID): Promise<void> {
  await store.savePerson({ id: personId, displayName: null, createdAt: NOW });
}

/** Control rows every scenario seeds so before/after equality has something to prove (case a, e). */
async function seedControls(store: SqliteStore): Promise<void> {
  await store.saveCanonicalEvent(makeCanonicalEvent({ id: "control_event" }));
  await store.saveTurn(makeTurn({ id: "control_turn" }));
  await store.saveSummary(makeSummary({ id: "control_summary" }));
  await store.saveBox(makeBox({ id: "control_box" }));
  await store.saveTrace(makeTrace({ id: "control_trace" }));
  await store.saveProposal(
    makeProposal({
      id: "control_proposal",
      sourceSummaryIds: ["control_summary"],
      payload: {
        boxId: "box_from_control_proposal",
        title: "Fixture proposal box",
        description: "",
        summary: "Fixture proposal box summary",
        boxType: "general",
        candidateParentBoxId: null,
        keywords: [],
        evidence: [],
        sourceSummaryIds: ["control_summary"],
        sourceTurnRanges: [{ threadId: THREAD_ID, startSequence: 1, endSequence: 2 }]
      }
    })
  );
  await store.saveInjection(makeInjection({ id: "control_injection" }));
}

interface ControlCounts {
  events: number;
  turns: number;
  summaries: number;
  boxes: number;
  traces: number;
  proposals: number;
  injections: number;
}

async function readControlCounts(store: SqliteStore): Promise<ControlCounts> {
  return {
    events: (await store.listCanonicalEvents(PERSON_ID)).length,
    turns: (await store.listTurns(THREAD_ID)).length,
    summaries: (await store.listSummaries()).length,
    boxes: (await store.listBoxes()).length,
    traces: (await store.listTraces()).length,
    proposals: (await store.listProposals()).length,
    injections: (await store.listInjections(THREAD_ID)).length
  };
}

interface AnchorFixture {
  toolIds: string[];
  syntheticIds: string[];
  conversationalIds: string[];
}

/** Seeds a mix of tool_activity / synthetic_injected / conversational anchors for one person. */
async function seedAnchorCorpus(
  store: SqliteStore,
  personId: string,
  counts: { tool: number; synthetic: number; conversational: number }
): Promise<AnchorFixture> {
  const toolIds: string[] = [];
  for (let index = 0; index < counts.tool; index += 1) {
    const id = `${personId}_tool_${String(index).padStart(3, "0")}`;
    toolIds.push(id);
    await store.saveAnchor(
      makeAnchor({
        id,
        personId,
        content: `[Tool call: Write] {"file_path":"/tmp/file_${index}.ts","content":"..."}`
      })
    );
  }

  const syntheticIds: string[] = [];
  for (let index = 0; index < counts.synthetic; index += 1) {
    const id = `${personId}_synthetic_${String(index).padStart(3, "0")}`;
    syntheticIds.push(id);
    await store.saveAnchor(
      makeAnchor({ id, personId, content: `[SYSTEM: background reminder text ${index}]` })
    );
  }

  const conversationalIds: string[] = [];
  for (let index = 0; index < counts.conversational; index += 1) {
    const id = `${personId}_convo_${String(index).padStart(3, "0")}`;
    conversationalIds.push(id);
    await store.saveAnchor(
      makeAnchor({ id, personId, content: `We decided to ship fix number ${index} because it is safe.` })
    );
  }

  return { toolIds, syntheticIds, conversationalIds };
}

async function fullAnchorSnapshot(store: SqliteStore): Promise<{ anchorIds: string[]; control: ControlCounts }> {
  const anchors = await store.listAnchors();
  return {
    anchorIds: anchors.map((anchor) => anchor.id).sort(),
    control: await readControlCounts(store)
  };
}

describe("prune-unhygienic-anchors-command", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "prune-unhygienic-anchors-"));
    tempDirs.push(dir);
    return dir;
  }

  async function makeTempDatabase(): Promise<string> {
    const dir = await makeTempDir();
    return join(dir, "memory.db");
  }

  async function makeBackupFile(content = "sqlite-backup-bytes"): Promise<string> {
    const dir = await makeTempDir();
    const path = join(dir, "backup.db");
    await writeFile(path, content);
    return path;
  }

  it("(a) dry run is the default: reports classifier counts without changing any row", async () => {
    const databasePath = await makeTempDatabase();
    const seedStore = openStore(databasePath);
    await seedPerson(seedStore);
    await seedControls(seedStore);
    const fixture = await seedAnchorCorpus(seedStore, PERSON_ID, { tool: 8, synthetic: 4, conversational: 6 });
    const before = await fullAnchorSnapshot(seedStore);
    seedStore.close();

    const result = await runPruneUnhygienicAnchorsCommand({ databasePath, personId: PERSON_ID });

    expect(result.ok).toBe(true);
    expect(result.applied).toBe(false);
    expect(result.totalCount).toBe(fixture.toolIds.length + fixture.syntheticIds.length + fixture.conversationalIds.length);
    expect(result.countsByClass.tool_activity).toBe(fixture.toolIds.length);
    expect(result.countsByClass.synthetic_injected).toBe(fixture.syntheticIds.length);
    expect(result.countsByClass.conversational).toBe(fixture.conversationalIds.length);
    expect(result.unhygienicCount).toBe(fixture.toolIds.length + fixture.syntheticIds.length);
    expect(result.unhygienicPayloadBytes).toBeGreaterThan(0);
    expect(result.prunedCount).toBe(0);

    const verifyStore = openStore(databasePath);
    const after = await fullAnchorSnapshot(verifyStore);
    verifyStore.close();
    expect(after).toEqual(before);
  });

  it("(b) apply without --confirm-backup refuses and names the flag", async () => {
    const databasePath = await makeTempDatabase();
    const seedStore = openStore(databasePath);
    await seedPerson(seedStore);
    await seedAnchorCorpus(seedStore, PERSON_ID, { tool: 1, synthetic: 0, conversational: 0 });
    seedStore.close();

    await expect(runPruneUnhygienicAnchorsCommand({ databasePath, personId: PERSON_ID, apply: true })).rejects.toThrow(
      /--confirm-backup/
    );

    const verifyStore = openStore(databasePath);
    const remaining = await verifyStore.listAnchors();
    verifyStore.close();
    expect(remaining.length).toBe(1);
  });

  it("(c) apply with a nonexistent backup path refuses and deletes nothing", async () => {
    const databasePath = await makeTempDatabase();
    const seedStore = openStore(databasePath);
    await seedPerson(seedStore);
    await seedAnchorCorpus(seedStore, PERSON_ID, { tool: 1, synthetic: 0, conversational: 0 });
    seedStore.close();

    const dir = await makeTempDir();
    const nonexistentPath = join(dir, "does-not-exist.db");
    await expect(
      runPruneUnhygienicAnchorsCommand({
        databasePath,
        personId: PERSON_ID,
        apply: true,
        confirmBackupPath: nonexistentPath
      })
    ).rejects.toThrow();

    const verifyStore = openStore(databasePath);
    const remaining = await verifyStore.listAnchors();
    verifyStore.close();
    expect(remaining.length).toBe(1);
  });

  it("(d) apply with an empty (zero-byte) backup file refuses and deletes nothing", async () => {
    const databasePath = await makeTempDatabase();
    const seedStore = openStore(databasePath);
    await seedPerson(seedStore);
    await seedAnchorCorpus(seedStore, PERSON_ID, { tool: 1, synthetic: 0, conversational: 0 });
    seedStore.close();

    const dir = await makeTempDir();
    const emptyPath = join(dir, "empty-backup.db");
    await writeFile(emptyPath, "");
    await expect(
      runPruneUnhygienicAnchorsCommand({
        databasePath,
        personId: PERSON_ID,
        apply: true,
        confirmBackupPath: emptyPath
      })
    ).rejects.toThrow();

    const verifyStore = openStore(databasePath);
    const remaining = await verifyStore.listAnchors();
    verifyStore.close();
    expect(remaining.length).toBe(1);
  });

  it("(e) apply with a valid backup prunes exactly tool_activity + synthetic_injected anchors and leaves controls untouched", async () => {
    const databasePath = await makeTempDatabase();
    const seedStore = openStore(databasePath);
    await seedPerson(seedStore);
    await seedControls(seedStore);
    const fixture = await seedAnchorCorpus(seedStore, PERSON_ID, { tool: 8, synthetic: 4, conversational: 6 });
    const controlBefore = await readControlCounts(seedStore);
    seedStore.close();

    const backupPath = await makeBackupFile();
    const result = await runPruneUnhygienicAnchorsCommand({
      databasePath,
      personId: PERSON_ID,
      apply: true,
      confirmBackupPath: backupPath,
      batchSize: 5
    });

    expect(result.ok).toBe(true);
    expect(result.applied).toBe(true);
    expect(result.backupPath).toBe(backupPath);
    expect(result.backupBytes).toBeGreaterThan(0);
    expect(result.prunedCount).toBe(fixture.toolIds.length + fixture.syntheticIds.length);
    expect(result.prunedByClass.tool_activity).toBe(fixture.toolIds.length);
    expect(result.prunedByClass.synthetic_injected).toBe(fixture.syntheticIds.length);
    expect(result.freedPayloadBytes).toBeGreaterThan(0);

    const verifyStore = openStore(databasePath);
    const remainingIds = new Set((await verifyStore.listAnchors()).map((anchor) => anchor.id));
    for (const id of fixture.toolIds) expect(remainingIds.has(id)).toBe(false);
    for (const id of fixture.syntheticIds) expect(remainingIds.has(id)).toBe(false);
    for (const id of fixture.conversationalIds) expect(remainingIds.has(id)).toBe(true);

    const controlAfter = await readControlCounts(verifyStore);
    verifyStore.close();
    expect(controlAfter).toEqual(controlBefore);
  });

  it("(f) retained_conversational appears in skippedByReason, and a second person's anchors are never visited", async () => {
    const databasePath = await makeTempDatabase();
    const seedStore = openStore(databasePath);
    await seedPerson(seedStore, PERSON_ID);
    await seedPerson(seedStore, OTHER_PERSON_ID);
    const fixture = await seedAnchorCorpus(seedStore, PERSON_ID, { tool: 2, synthetic: 0, conversational: 5 });
    const otherFixture = await seedAnchorCorpus(seedStore, OTHER_PERSON_ID, { tool: 3, synthetic: 0, conversational: 0 });
    seedStore.close();

    const backupPath = await makeBackupFile();
    const commitSpy = vi.spyOn(SqliteStore.prototype, "commitUnhygienicAnchorPrune");
    const result = await runPruneUnhygienicAnchorsCommand({
      databasePath,
      personId: PERSON_ID,
      apply: true,
      confirmBackupPath: backupPath
    });
    commitSpy.mockRestore();

    expect(result.skippedByReason.retained_conversational).toBe(fixture.conversationalIds.length);

    const verifyStore = openStore(databasePath);
    const remainingIds = new Set((await verifyStore.listAnchors()).map((anchor) => anchor.id));
    verifyStore.close();

    for (const id of fixture.conversationalIds) expect(remainingIds.has(id)).toBe(true);
    // The other person's anchors survive untouched -- proving the person-scoped cursor never
    // visited them, not merely that they were reported as skipped.
    for (const id of otherFixture.toolIds) expect(remainingIds.has(id)).toBe(true);
    expect(result.skippedByReason.person_mismatch ?? 0).toBe(0);
  });

  it("(g) resumable: an interrupted run followed by a re-run converges to the same result as an uninterrupted run", async () => {
    const buildCorpus = async (databasePath: string) => {
      const store = openStore(databasePath);
      await seedPerson(store);
      const fixture = await seedAnchorCorpus(store, PERSON_ID, { tool: 10, synthetic: 8, conversational: 12 });
      store.close();
      return fixture;
    };

    const interruptedDbPath = await makeTempDatabase();
    await buildCorpus(interruptedDbPath);
    const backupPathA = await makeBackupFile();

    let batchCount = 0;
    await expect(
      runPruneUnhygienicAnchorsCommand(
        {
          databasePath: interruptedDbPath,
          personId: PERSON_ID,
          apply: true,
          confirmBackupPath: backupPathA,
          batchSize: 5
        },
        {
          onBatchComplete: async () => {
            batchCount += 1;
            if (batchCount === 2) throw new Error("simulated kill mid-prune");
          }
        }
      )
    ).rejects.toThrow("simulated kill mid-prune");

    const resumeResult = await runPruneUnhygienicAnchorsCommand({
      databasePath: interruptedDbPath,
      personId: PERSON_ID,
      apply: true,
      confirmBackupPath: backupPathA,
      batchSize: 5
    });
    expect(resumeResult.ok).toBe(true);

    const uninterruptedDbPath = await makeTempDatabase();
    await buildCorpus(uninterruptedDbPath);
    const backupPathB = await makeBackupFile();
    await runPruneUnhygienicAnchorsCommand({
      databasePath: uninterruptedDbPath,
      personId: PERSON_ID,
      apply: true,
      confirmBackupPath: backupPathB,
      batchSize: 5
    });

    const interruptedStore = openStore(interruptedDbPath);
    const uninterruptedStore = openStore(uninterruptedDbPath);
    const interruptedIds = (await interruptedStore.listAnchors()).map((anchor) => anchor.id).sort();
    const uninterruptedIds = (await uninterruptedStore.listAnchors()).map((anchor) => anchor.id).sort();
    interruptedStore.close();
    uninterruptedStore.close();

    expect(interruptedIds).toEqual(uninterruptedIds);
  });

  it("(h) idempotent: a second run over an all-unhygienic corpus makes zero commit calls", async () => {
    const databasePath = await makeTempDatabase();
    const seedStore = openStore(databasePath);
    await seedPerson(seedStore);
    const fixture = await seedAnchorCorpus(seedStore, PERSON_ID, { tool: 6, synthetic: 6, conversational: 0 });
    seedStore.close();

    const backupPath = await makeBackupFile();
    const first = await runPruneUnhygienicAnchorsCommand({
      databasePath,
      personId: PERSON_ID,
      apply: true,
      confirmBackupPath: backupPath
    });
    expect(first.prunedCount).toBe(fixture.toolIds.length + fixture.syntheticIds.length);

    const commitSpy = vi.spyOn(SqliteStore.prototype, "commitUnhygienicAnchorPrune");
    const second = await runPruneUnhygienicAnchorsCommand({
      databasePath,
      personId: PERSON_ID,
      apply: true,
      confirmBackupPath: backupPath
    });
    commitSpy.mockRestore();

    expect(second.prunedCount).toBe(0);
    expect(commitSpy).not.toHaveBeenCalled();
  });

  it("(i) fails loud for an unknown person rather than reporting a successful zero-candidate prune", async () => {
    const databasePath = await makeTempDatabase();
    const store = openStore(databasePath);
    store.close();

    await expect(runPruneUnhygienicAnchorsCommand({ databasePath, personId: "person_unknown" })).rejects.toThrow();

    const backupPath = await makeBackupFile();
    await expect(
      runPruneUnhygienicAnchorsCommand({
        databasePath,
        personId: "person_unknown",
        apply: true,
        confirmBackupPath: backupPath
      })
    ).rejects.toThrow();
  });

  it("(j) progress: emits one JSON progress line per batch with monotonically non-decreasing prunedCount", async () => {
    const databasePath = await makeTempDatabase();
    const seedStore = openStore(databasePath);
    await seedPerson(seedStore);
    await seedAnchorCorpus(seedStore, PERSON_ID, { tool: 12, synthetic: 6, conversational: 12 });
    seedStore.close();

    const backupPath = await makeBackupFile();
    const progressLines: Array<{ event: string; batches: number; prunedCount: number }> = [];
    const result: PruneUnhygienicAnchorsCommandResult = await runPruneUnhygienicAnchorsCommand(
      { databasePath, personId: PERSON_ID, apply: true, confirmBackupPath: backupPath, batchSize: 5 },
      {
        progressSink: (line: string) => {
          const parsed = JSON.parse(line) as { event: string; batches: number; prunedCount: number };
          if (parsed.event === "progress") progressLines.push(parsed);
        }
      }
    );

    expect(result.batches).toBeGreaterThanOrEqual(3);
    expect(progressLines.length).toBe(result.batches);
    let previous = 0;
    for (const line of progressLines) {
      expect(line.prunedCount).toBeGreaterThanOrEqual(previous);
      previous = line.prunedCount;
    }
  });
});
