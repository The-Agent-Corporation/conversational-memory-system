import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Anchor, Box, CanonicalEvent, InjectionPacket, MemoryTrace, Summary, Turn } from "../../src/domain/types.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";
import {
  runPruneSupersededCommand,
  type PruneSupersededCommandResult
} from "../../src/operations/prune-superseded-command.js";

/**
 * `memory prune-superseded` (REQ-052/REQ-053/REQ-054, GAP-11-A closure, Plan 11-12). Drives a real
 * `SqliteStore` over a temp-dir database, matching the `rebuild-derivations-command.test.ts`
 * precedent — this is a corpus-wide destructive operation, so its safety properties (dry-run
 * default, fail-closed backup gate, resumability, idempotency, reference-refusal reporting, stale
 * exclusion) only mean something against durable storage.
 */

const NOW = "2026-07-27T10:00:00.000Z";

function openStore(databasePath: string): SqliteStore {
  return new SqliteStore(databasePath, { clock: { now: () => NOW } });
}

function makeSummary(overrides: Partial<Summary> = {}): Summary {
  return {
    id: "summary_1",
    personId: "person_prune",
    scopeIds: ["personal"],
    summaryText: "Fixture summary text for prune-superseded-command tests.",
    sourceTurnRanges: [{ threadId: "session_prune", startSequence: 1, endSequence: 2 }],
    sourceCanonicalEventIds: [],
    sourceSummaryIds: [],
    boxIds: [],
    embedding: null,
    createdAt: NOW,
    model: "test-summarizer",
    promptVersion: "v1",
    confidence: 0.9,
    state: "superseded",
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
    description: "Fixture box for prune-superseded-command tests",
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
    description: "Fixture trace for prune-superseded-command tests",
    traceType: "case_issue",
    state: "approved",
    summaryIds: [],
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
    content: "Fixture anchor content.",
    embedding: null,
    createdAt: NOW,
    trustLevel: "high",
    source: "direct_user_input",
    ...overrides
  };
}

const PERSON_ID = "person_prune";
const THREAD_ID = "session_prune";

async function seedPerson(store: SqliteStore, personId = PERSON_ID): Promise<void> {
  await store.savePerson({ id: personId, displayName: null, createdAt: NOW });
}

/** Five canonical events / turns / anchors used as untouched-control counts in every scenario. */
async function seedControlData(store: SqliteStore): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await store.saveCanonicalEvent(makeCanonicalEvent({ id: `event_${index}`, nativeSequence: index + 1, nativeEventId: `native_${index}` }));
    await store.saveTurn(makeTurn({ id: `turn_${index}`, sequence: index + 1 }));
  }
  for (let index = 0; index < 3; index += 1) {
    await store.saveAnchor(makeAnchor({ id: `anchor_${index}`, turnId: `turn_${index}` }));
  }
}

async function controlSnapshot(store: SqliteStore) {
  const [events, turns, anchors] = await Promise.all([
    store.listCanonicalEvents(PERSON_ID),
    store.listTurns(THREAD_ID),
    store.listAnchors()
  ]);
  return {
    eventIds: events.map((event) => event.id).sort(),
    turnIds: turns.map((turn) => turn.id).sort(),
    anchorIds: anchors.map((anchor) => anchor.id).sort()
  };
}

interface MixedFixture {
  supersededIds: string[];
  referencedByBoxIds: string[];
  referencedByTraceIds: string[];
  vectorSummaryIds: string[];
  activeIds: string[];
  staleIds: string[];
}

/**
 * Seeds ~300 superseded summaries (10 carrying vectors+injections, 5 referenced by a box, 5
 * referenced by an approved trace, the remaining 280 unreferenced), 50 active summaries, and 5
 * stale summaries — plus the control data above.
 */
async function seedMixedCorpus(store: SqliteStore, supersededCount = 300): Promise<MixedFixture> {
  await seedPerson(store);
  await seedControlData(store);

  const supersededIds: string[] = [];
  for (let index = 0; index < supersededCount; index += 1) {
    const id = `sup_${String(index).padStart(4, "0")}`;
    supersededIds.push(id);
    await store.saveSummary(makeSummary({ id, state: "superseded" }));
  }

  const vectorSummaryIds = supersededIds.slice(0, 10);
  for (const summaryId of vectorSummaryIds) {
    await store.saveSummaryVector({
      summaryId,
      provider: "deterministic",
      model: "hash-v1",
      dimensions: 2,
      vector: [0.1, 0.2],
      personId: PERSON_ID,
      scopeIds: ["personal"],
      createdAt: NOW
    });
  }
  for (const [index, summaryId] of vectorSummaryIds.slice(0, 5).entries()) {
    await store.saveInjection(makeInjection({ id: `injection_${index}`, sourceSummaryIds: [summaryId] }));
  }

  const referencedByBoxIds = supersededIds.slice(10, 15);
  await store.saveBox(makeBox({ id: "box_1", summaryIds: referencedByBoxIds }));

  const referencedByTraceIds = supersededIds.slice(15, 20);
  await store.saveTrace(makeTrace({ id: "trace_1", summaryIds: referencedByTraceIds }));

  const activeIds: string[] = [];
  for (let index = 0; index < 50; index += 1) {
    const id = `act_${String(index).padStart(3, "0")}`;
    activeIds.push(id);
    await store.saveSummary(makeSummary({ id, state: "active" }));
  }

  const staleIds: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    const id = `stale_${index}`;
    staleIds.push(id);
    await store.saveSummary(makeSummary({ id, state: "stale" }));
  }

  return { supersededIds, referencedByBoxIds, referencedByTraceIds, vectorSummaryIds, activeIds, staleIds };
}

async function fullSnapshot(store: SqliteStore, fixture: MixedFixture) {
  const summaries = await store.listSummaries();
  const vectorPresence: Record<string, boolean> = {};
  for (const summaryId of fixture.vectorSummaryIds) {
    vectorPresence[summaryId] = (await store.getSummaryVector(summaryId, "deterministic", "hash-v1")) !== null;
  }
  const injections = await store.listInjections(THREAD_ID);
  return {
    summaryIds: summaries.map((summary) => summary.id).sort(),
    vectorPresence,
    injectionIds: injections.map((injection) => injection.id).sort(),
    control: await controlSnapshot(store)
  };
}

describe("prune-superseded-command", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "prune-superseded-"));
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

  it("(a) dry run is the default: reports candidates without changing any row", async () => {
    const databasePath = await makeTempDatabase();
    const seedStore = openStore(databasePath);
    const fixture = await seedMixedCorpus(seedStore);
    const before = await fullSnapshot(seedStore, fixture);
    seedStore.close();

    const result = await runPruneSupersededCommand({ databasePath, personId: PERSON_ID });

    expect(result.ok).toBe(true);
    expect(result.applied).toBe(false);
    expect(result.candidateCount).toBe(fixture.supersededIds.length);
    expect(result.referencedSkipCount).toBe(fixture.referencedByBoxIds.length + fixture.referencedByTraceIds.length);
    expect(result.prunedCount).toBe(0);
    expect(result.estimatedBytes).toBeGreaterThan(0);

    const verifyStore = openStore(databasePath);
    const after = await fullSnapshot(verifyStore, fixture);
    verifyStore.close();
    expect(after).toEqual(before);
  });

  it("(b) apply without --confirm-backup refuses and deletes nothing", async () => {
    const databasePath = await makeTempDatabase();
    const seedStore = openStore(databasePath);
    await seedPerson(seedStore);
    await seedStore.saveSummary(makeSummary({ id: "sup_only", state: "superseded" }));
    seedStore.close();

    await expect(runPruneSupersededCommand({ databasePath, personId: PERSON_ID, apply: true })).rejects.toThrow(
      /--confirm-backup/
    );

    const verifyStore = openStore(databasePath);
    const remaining = await verifyStore.listSummaries();
    verifyStore.close();
    expect(remaining.map((summary) => summary.id)).toContain("sup_only");
  });

  it("(c) apply with a nonexistent or empty backup path refuses and deletes nothing", async () => {
    const databasePath = await makeTempDatabase();
    const seedStore = openStore(databasePath);
    await seedPerson(seedStore);
    await seedStore.saveSummary(makeSummary({ id: "sup_only", state: "superseded" }));
    seedStore.close();

    const dir = await makeTempDir();
    const nonexistentPath = join(dir, "does-not-exist.db");
    await expect(
      runPruneSupersededCommand({ databasePath, personId: PERSON_ID, apply: true, confirmBackupPath: nonexistentPath })
    ).rejects.toThrow();

    const emptyPath = join(dir, "empty-backup.db");
    await writeFile(emptyPath, "");
    await expect(
      runPruneSupersededCommand({ databasePath, personId: PERSON_ID, apply: true, confirmBackupPath: emptyPath })
    ).rejects.toThrow();

    const verifyStore = openStore(databasePath);
    const remaining = await verifyStore.listSummaries();
    verifyStore.close();
    expect(remaining.map((summary) => summary.id)).toContain("sup_only");
  });

  it("(d) apply prunes unreferenced superseded summaries, vectors, and injections; leaves active/stale/control counts unchanged", async () => {
    const databasePath = await makeTempDatabase();
    const seedStore = openStore(databasePath);
    const fixture = await seedMixedCorpus(seedStore);
    const controlBefore = await controlSnapshot(seedStore);
    seedStore.close();

    const backupPath = await makeBackupFile();

    const result = await runPruneSupersededCommand({
      databasePath,
      personId: PERSON_ID,
      apply: true,
      confirmBackupPath: backupPath
    });

    expect(result.ok).toBe(true);
    expect(result.applied).toBe(true);
    expect(result.backupPath).toBe(backupPath);
    expect(result.backupBytes).toBeGreaterThan(0);

    const referenced = new Set([...fixture.referencedByBoxIds, ...fixture.referencedByTraceIds]);
    const expectedPruned = fixture.supersededIds.filter((id) => !referenced.has(id));
    expect(result.prunedCount).toBe(expectedPruned.length);
    expect(result.deletedVectorRows).toBe(fixture.vectorSummaryIds.length);
    expect(result.deletedInjectionIds.length).toBe(5);
    expect(result.freedPayloadBytes).toBeGreaterThan(0);

    const verifyStore = openStore(databasePath);
    const remaining = await verifyStore.listSummaries();
    const remainingIds = new Set(remaining.map((summary) => summary.id));

    for (const id of expectedPruned) expect(remainingIds.has(id)).toBe(false);
    for (const id of referenced) expect(remainingIds.has(id)).toBe(true);
    for (const id of fixture.activeIds) expect(remainingIds.has(id)).toBe(true);
    for (const id of fixture.staleIds) expect(remainingIds.has(id)).toBe(true);

    for (const summaryId of fixture.vectorSummaryIds) {
      expect(await verifyStore.getSummaryVector(summaryId, "deterministic", "hash-v1")).toBeNull();
    }
    expect(await verifyStore.listInjections(THREAD_ID)).toEqual([]);

    const controlAfter = await controlSnapshot(verifyStore);
    verifyStore.close();
    expect(controlAfter).toEqual(controlBefore);
  });

  it("(e) referenced summaries survive and are reported in skippedByReason, not silently left", async () => {
    const databasePath = await makeTempDatabase();
    const seedStore = openStore(databasePath);
    const fixture = await seedMixedCorpus(seedStore);
    seedStore.close();

    const backupPath = await makeBackupFile();
    const result = await runPruneSupersededCommand({
      databasePath,
      personId: PERSON_ID,
      apply: true,
      confirmBackupPath: backupPath
    });

    expect(result.skippedByReason.referenced_by_box).toBe(fixture.referencedByBoxIds.length);
    expect(result.skippedByReason.referenced_by_trace).toBe(fixture.referencedByTraceIds.length);

    const verifyStore = openStore(databasePath);
    const remaining = await verifyStore.listSummaries();
    const remainingIds = new Set(remaining.map((summary) => summary.id));
    verifyStore.close();

    for (const id of [...fixture.referencedByBoxIds, ...fixture.referencedByTraceIds]) {
      expect(remainingIds.has(id)).toBe(true);
    }
  });

  it("(f) resumable: an interrupted run followed by a re-run converges to the same result as an uninterrupted run", async () => {
    const buildUnreferencedCorpus = async (databasePath: string) => {
      const store = openStore(databasePath);
      await seedPerson(store);
      const ids: string[] = [];
      for (let index = 0; index < 50; index += 1) {
        const id = `res_${String(index).padStart(3, "0")}`;
        ids.push(id);
        await store.saveSummary(makeSummary({ id, state: "superseded" }));
      }
      store.close();
      return ids;
    };

    const interruptedDbPath = await makeTempDatabase();
    await buildUnreferencedCorpus(interruptedDbPath);
    const backupPathA = await makeBackupFile();

    let batchCount = 0;
    await expect(
      runPruneSupersededCommand(
        { databasePath: interruptedDbPath, personId: PERSON_ID, apply: true, confirmBackupPath: backupPathA, batchSize: 10 },
        {
          onBatchComplete: async () => {
            batchCount += 1;
            if (batchCount === 2) throw new Error("simulated kill mid-prune");
          }
        }
      )
    ).rejects.toThrow("simulated kill mid-prune");

    const resumeResult = await runPruneSupersededCommand({
      databasePath: interruptedDbPath,
      personId: PERSON_ID,
      apply: true,
      confirmBackupPath: backupPathA,
      batchSize: 10
    });
    expect(resumeResult.ok).toBe(true);

    const uninterruptedDbPath = await makeTempDatabase();
    await buildUnreferencedCorpus(uninterruptedDbPath);
    const backupPathB = await makeBackupFile();
    await runPruneSupersededCommand({
      databasePath: uninterruptedDbPath,
      personId: PERSON_ID,
      apply: true,
      confirmBackupPath: backupPathB,
      batchSize: 10
    });

    const interruptedStore = openStore(interruptedDbPath);
    const uninterruptedStore = openStore(uninterruptedDbPath);
    const interruptedIds = (await interruptedStore.listSummaries()).map((summary) => summary.id).sort();
    const uninterruptedIds = (await uninterruptedStore.listSummaries()).map((summary) => summary.id).sort();
    interruptedStore.close();
    uninterruptedStore.close();

    expect(interruptedIds).toEqual([]);
    expect(interruptedIds).toEqual(uninterruptedIds);
  });

  it("(g) idempotent: a second completed run reports zero candidates and makes zero commit calls", async () => {
    const databasePath = await makeTempDatabase();
    const seedStore = openStore(databasePath);
    await seedPerson(seedStore);
    for (let index = 0; index < 20; index += 1) {
      await seedStore.saveSummary(makeSummary({ id: `idem_${index}`, state: "superseded" }));
    }
    seedStore.close();

    const backupPath = await makeBackupFile();
    const first = await runPruneSupersededCommand({
      databasePath,
      personId: PERSON_ID,
      apply: true,
      confirmBackupPath: backupPath
    });
    expect(first.prunedCount).toBe(20);

    const commitSpy = vi.spyOn(SqliteStore.prototype, "commitSupersededSummaryPrune");
    const second = await runPruneSupersededCommand({
      databasePath,
      personId: PERSON_ID,
      apply: true,
      confirmBackupPath: backupPath
    });
    commitSpy.mockRestore();

    expect(second.candidateCount === 0 || second.prunedCount === 0).toBe(true);
    expect(second.prunedCount).toBe(0);
    expect(commitSpy).not.toHaveBeenCalled();
  });

  it("(h) a stale summary is never a prune candidate, in dry-run or apply", async () => {
    const databasePath = await makeTempDatabase();
    const seedStore = openStore(databasePath);
    await seedPerson(seedStore);
    await seedStore.saveSummary(makeSummary({ id: "stale_1", state: "stale" }));
    await seedStore.saveSummary(makeSummary({ id: "sup_1", state: "superseded" }));
    seedStore.close();

    const dryRun = await runPruneSupersededCommand({ databasePath, personId: PERSON_ID });
    expect(dryRun.candidateCount).toBe(1);

    const midStore = openStore(databasePath);
    const midSummaries = await midStore.listSummaries();
    midStore.close();
    expect(midSummaries.map((summary) => summary.id)).toContain("stale_1");

    const backupPath = await makeBackupFile();
    await runPruneSupersededCommand({ databasePath, personId: PERSON_ID, apply: true, confirmBackupPath: backupPath });

    const afterStore = openStore(databasePath);
    const afterSummaries = await afterStore.listSummaries();
    afterStore.close();
    expect(afterSummaries.map((summary) => summary.id)).toEqual(["stale_1"]);
  });

  it("(i) fails loud for an unknown person rather than reporting a successful zero-candidate prune", async () => {
    const databasePath = await makeTempDatabase();
    const store = openStore(databasePath);
    store.close();

    await expect(runPruneSupersededCommand({ databasePath, personId: "person_unknown" })).rejects.toThrow();

    const backupPath = await makeBackupFile();
    await expect(
      runPruneSupersededCommand({
        databasePath,
        personId: "person_unknown",
        apply: true,
        confirmBackupPath: backupPath
      })
    ).rejects.toThrow();
  });

  it("(j) progress: emits one JSON progress line per batch with monotonically increasing counters", async () => {
    const databasePath = await makeTempDatabase();
    const seedStore = openStore(databasePath);
    await seedPerson(seedStore);
    for (let index = 0; index < 30; index += 1) {
      await seedStore.saveSummary(makeSummary({ id: `prog_${String(index).padStart(3, "0")}`, state: "superseded" }));
    }
    seedStore.close();

    const backupPath = await makeBackupFile();
    const progressLines: Array<{ event: string; batches: number; prunedCount: number }> = [];
    const result: PruneSupersededCommandResult = await runPruneSupersededCommand(
      { databasePath, personId: PERSON_ID, apply: true, confirmBackupPath: backupPath, batchSize: 10 },
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
      expect(line.prunedCount).toBeGreaterThan(previous);
      previous = line.prunedCount;
    }
  });
});
