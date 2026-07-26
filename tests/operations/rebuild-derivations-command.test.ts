import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBootstrapCommand } from "../../src/bootstrap/bootstrap-command.js";
import { historicalContractionJobId } from "../../src/bootstrap/historical-bootstrapper.js";
import { PROCESSOR_VERSION } from "../../src/daemon/contraction-runner.js";
import type { CanonicalEvent } from "../../src/domain/canonical.js";
import type { SummaryVectorRecord } from "../../src/storage/memory-store.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";
import { runRebuildDerivationsCommand } from "../../src/operations/rebuild-derivations-command.js";

/**
 * SC5 integration tests for `memory rebuild-derivations` (REQ-054). Drives a real `SqliteStore`
 * over a temp-dir database — matching the `backfill-embeddings-command.test.ts` precedent — because
 * SC5's resumability/idempotency/no-orphan guarantees only mean something against durable storage.
 *
 * Each test simulates "derivations built before this phase" by running a real bootstrap pass (which
 * already produces hygiene-aware output, since Plan 02 wired hygiene into `drainSlice` itself) and
 * then overwriting the persisted checkpoint's `processorVersion` with a legacy string — exactly the
 * staleness signal `rebuild-derivations` is specified to detect (11-RESEARCH Pitfall 5: supersession
 * is found by event-id intersection, not id equality, so a changed deterministic summary id under a
 * relabeled span still supersedes cleanly).
 */

const NOW = "2026-07-26T12:00:00.000Z";
const PERSON_ID = "person_rebuild";
const TOPIC_COUNT = 45; // 7 events/topic * 45 = 315 events, forcing >1 slice at the default maxEvents=250

const LEGACY_PROCESSOR_VERSION = "continuous-contraction/v0+pre-hygiene";

function baseEvent(input: {
  id: string;
  nativeSequence: number;
  content: string;
  minuteOffset: number;
  role?: CanonicalEvent["role"];
  eventKind?: CanonicalEvent["eventKind"];
}): CanonicalEvent {
  const role = input.role ?? "user";
  const occurredAt = new Date(Date.parse(NOW) + input.minuteOffset * 60_000).toISOString();
  return {
    id: input.id,
    personId: PERSON_ID,
    sourceId: `source_${PERSON_ID}`,
    sourceApplication: "synthetic",
    sourceProfileId: "default",
    nativeSessionId: "session-rebuild",
    nativeEventId: input.id,
    nativeSequence: input.nativeSequence,
    causalParentId: null,
    eventKind: input.eventKind,
    role,
    content: input.content,
    occurredAt,
    importedAt: NOW,
    provenance: role === "user" ? "direct_user_input" : "assistant_output",
    trustLevel: role === "user" ? "high" : "medium",
    contentHash: `hash-${input.id}`,
    parserVersion: "synthetic/v1",
    metadata: {}
  };
}

function conversationalEvent(id: string, nativeSequence: number, minuteOffset: number, topic: number): CanonicalEvent {
  return baseEvent({ id, nativeSequence, minuteOffset, content: `Switch to Topic${topic}.` });
}

function toolEvent(id: string, nativeSequence: number, minuteOffset: number, toolName: string): CanonicalEvent {
  return baseEvent({
    id,
    nativeSequence,
    minuteOffset,
    role: "assistant",
    eventKind: "tool_call",
    content: `[Tool call: ${toolName}] ${JSON.stringify({ arg: id })}`
  });
}

function syntheticEvent(id: string, nativeSequence: number, minuteOffset: number): CanonicalEvent {
  return baseEvent({ id, nativeSequence, minuteOffset, role: "assistant", content: `[SYSTEM: harness note ${id}]` });
}

/** Mixes conversational, isolated tool singles, a >=2 tool run, and synthetic content per topic. */
function buildCorpus(topicCount: number): CanonicalEvent[] {
  const events: CanonicalEvent[] = [];
  let sequence = 1;
  let minute = 0;
  for (let topic = 0; topic < topicCount; topic += 1) {
    events.push(conversationalEvent(`conv-${topic}-a`, sequence++, minute++, topic));
    events.push(toolEvent(`tool-single-${topic}`, sequence++, minute++, "Read"));
    events.push(syntheticEvent(`sys-${topic}`, sequence++, minute++));
    events.push(toolEvent(`tool-run-${topic}-0`, sequence++, minute++, "Bash"));
    events.push(toolEvent(`tool-run-${topic}-1`, sequence++, minute++, "Write"));
    events.push(toolEvent(`tool-run-${topic}-2`, sequence++, minute++, "Bash"));
    events.push(conversationalEvent(`conv-${topic}-b`, sequence++, minute++, topic));
  }
  return events;
}

function openStore(databasePath: string): SqliteStore {
  return new SqliteStore(databasePath, { clock: { now: () => NOW } });
}

/**
 * Seeds a person/source/canonical-event corpus, runs a real bootstrap pass to produce a fully
 * derived state, then rewrites the persisted checkpoint's `processorVersion` to a legacy string —
 * simulating derivations built before this phase's hygiene rules existed.
 */
async function buildPreHygieneCorpus(databasePath: string, events: CanonicalEvent[]): Promise<void> {
  const seedStore = openStore(databasePath);
  await seedStore.savePerson({ id: PERSON_ID, displayName: null, createdAt: NOW });
  await seedStore.saveSource({
    id: `source_${PERSON_ID}`,
    personId: PERSON_ID,
    application: "synthetic",
    profileId: "default",
    instanceId: "test",
    createdAt: NOW,
    lastImportedAt: NOW
  });
  for (const item of events) await seedStore.saveCanonicalEvent(item);
  seedStore.close();

  await runBootstrapCommand({ databasePath, personId: PERSON_ID });

  const checkpointStore = openStore(databasePath);
  const checkpointId = `contraction_checkpoint_${historicalContractionJobId(PERSON_ID)}`;
  const checkpoint = await checkpointStore.getContractionCheckpoint(checkpointId);
  if (!checkpoint) throw new Error("Expected an initial contraction checkpoint after bootstrap");
  await checkpointStore.saveContractionCheckpoint({ ...checkpoint, processorVersion: LEGACY_PROCESSOR_VERSION });
  checkpointStore.close();
}

async function activeSummaryProjection(store: SqliteStore) {
  const summaries = await store.listSummaries();
  return summaries
    .filter((summary) => summary.personId === PERSON_ID && summary.state !== "superseded")
    .map((summary) => ({
      id: summary.id,
      summaryText: summary.summaryText,
      sourceCanonicalEventIds: [...(summary.sourceCanonicalEventIds ?? [])].sort()
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

describe("rebuild-derivations-command", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makeTempDatabase(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "rebuild-derivations-"));
    tempDirs.push(dir);
    return join(dir, "memory.db");
  }

  it("completes full corpus: every active summary is hygiene-clean and the checkpoint records the current processor version", async () => {
    const databasePath = await makeTempDatabase();
    await buildPreHygieneCorpus(databasePath, buildCorpus(TOPIC_COUNT));

    const result = await runRebuildDerivationsCommand({ databasePath, personId: PERSON_ID });
    expect(result.ok).toBe(true);
    expect(result.rebuilt).toBe(true);
    expect(result.slices).toBeGreaterThan(1);

    const store = openStore(databasePath);
    const summaries = await store.listSummaries();
    const active = summaries.filter((summary) => summary.personId === PERSON_ID && summary.state !== "superseded");
    expect(active.length).toBeGreaterThan(0);
    for (const summary of active) {
      expect(summary.summaryText).not.toMatch(/\[Tool call:/);
      expect(summary.summaryText).not.toMatch(/\[SYSTEM:/);
    }

    const checkpoint = await store.getContractionCheckpoint(
      `contraction_checkpoint_${historicalContractionJobId(PERSON_ID)}`
    );
    expect(checkpoint?.processorVersion).toBe(PROCESSOR_VERSION);
    store.close();
  });

  it("resumes after interruption: interrupt+restart converges to the same result as an uninterrupted run", async () => {
    const events = buildCorpus(TOPIC_COUNT);

    const interruptedDbPath = await makeTempDatabase();
    await buildPreHygieneCorpus(interruptedDbPath, events);

    let batchCount = 0;
    await expect(
      runRebuildDerivationsCommand(
        { databasePath: interruptedDbPath, personId: PERSON_ID },
        {
          onBatchComplete: async () => {
            batchCount += 1;
            if (batchCount === 1) throw new Error("simulated kill mid-rebuild");
          }
        }
      )
    ).rejects.toThrow("simulated kill mid-rebuild");

    const resumeResult = await runRebuildDerivationsCommand({ databasePath: interruptedDbPath, personId: PERSON_ID });
    expect(resumeResult.ok).toBe(true);
    expect(resumeResult.rebuilt).toBe(true);

    const uninterruptedDbPath = await makeTempDatabase();
    await buildPreHygieneCorpus(uninterruptedDbPath, events);
    await runRebuildDerivationsCommand({ databasePath: uninterruptedDbPath, personId: PERSON_ID });

    const interruptedStore = openStore(interruptedDbPath);
    const uninterruptedStore = openStore(uninterruptedDbPath);
    const interruptedProjection = await activeSummaryProjection(interruptedStore);
    const uninterruptedProjection = await activeSummaryProjection(uninterruptedStore);
    interruptedStore.close();
    uninterruptedStore.close();

    expect(interruptedProjection.length).toBeGreaterThan(0);
    expect(interruptedProjection).toEqual(uninterruptedProjection);
  });

  it("idempotent rerun: a second complete run performs zero additional writes and bumps no generation", async () => {
    const databasePath = await makeTempDatabase();
    await buildPreHygieneCorpus(databasePath, buildCorpus(TOPIC_COUNT));

    const first = await runRebuildDerivationsCommand({ databasePath, personId: PERSON_ID });
    expect(first.rebuilt).toBe(true);

    const jobId = historicalContractionJobId(PERSON_ID);
    const beforeStore = openStore(databasePath);
    const jobBefore = await beforeStore.getContractionJob(jobId);
    beforeStore.close();

    const saveJobSpy = vi.spyOn(SqliteStore.prototype, "saveContractionJob");
    const commitSpy = vi.spyOn(SqliteStore.prototype, "commitContractionSlice");

    const second = await runRebuildDerivationsCommand({ databasePath, personId: PERSON_ID });

    saveJobSpy.mockRestore();
    commitSpy.mockRestore();

    expect(second.ok).toBe(true);
    expect(second.rebuilt).toBe(false);
    expect(second.processedEvents).toBe(0);
    expect(saveJobSpy).not.toHaveBeenCalled();
    expect(commitSpy).not.toHaveBeenCalled();

    const afterStore = openStore(databasePath);
    const jobAfter = await afterStore.getContractionJob(jobId);
    afterStore.close();
    expect(jobAfter?.generation).toBe(jobBefore?.generation);
  });

  it("no orphans: pre-hygiene summaries are superseded (not deleted), no duplicate windows, and superseded vectors are gone", async () => {
    const databasePath = await makeTempDatabase();
    await buildPreHygieneCorpus(databasePath, buildCorpus(TOPIC_COUNT));

    const seedStore = openStore(databasePath);
    const preSummaries = (await seedStore.listSummaries()).filter((summary) => summary.personId === PERSON_ID);
    expect(preSummaries.length).toBeGreaterThan(0);
    const vectorRecords: SummaryVectorRecord[] = preSummaries.map((summary) => ({
      summaryId: summary.id,
      provider: "test-provider",
      model: "test-model",
      dimensions: 4,
      vector: [0.1, 0.2, 0.3, 0.4],
      personId: summary.personId!,
      scopeIds: summary.scopeIds ?? [],
      createdAt: NOW
    }));
    await seedStore.saveSummaryVectors(vectorRecords);
    seedStore.close();

    const result = await runRebuildDerivationsCommand({ databasePath, personId: PERSON_ID });
    expect(result.supersededSummaries).toBeGreaterThan(0);

    const verifyStore = openStore(databasePath);
    const allSummaries = await verifyStore.listSummaries();
    const active = allSummaries.filter((summary) => summary.personId === PERSON_ID && summary.state !== "superseded");
    const superseded = allSummaries.filter((summary) => summary.personId === PERSON_ID && summary.state === "superseded");
    const supersededIds = new Set(superseded.map((summary) => summary.id));

    for (const pre of preSummaries) {
      expect(supersededIds.has(pre.id)).toBe(true);
    }

    const seenEventIds = new Set<string>();
    for (const summary of active) {
      for (const eventId of summary.sourceCanonicalEventIds ?? []) {
        expect(seenEventIds.has(eventId)).toBe(false);
        seenEventIds.add(eventId);
      }
    }

    for (const summary of active) {
      for (const dependencyId of summary.sourceSummaryIds ?? []) {
        expect(supersededIds.has(dependencyId)).toBe(false);
      }
    }

    for (const id of supersededIds) {
      const vector = await verifyStore.getSummaryVector(id, "test-provider", "test-model");
      expect(vector).toBeNull();
    }
    verifyStore.close();
  });

  it("progress: emits one progress line per slice batch with monotonically increasing processed counters", async () => {
    const databasePath = await makeTempDatabase();
    await buildPreHygieneCorpus(databasePath, buildCorpus(TOPIC_COUNT));

    const progressLines: Array<{ event: string; processedEvents: number }> = [];
    await runRebuildDerivationsCommand(
      { databasePath, personId: PERSON_ID },
      {
        progressSink: (line: string) => {
          const parsed = JSON.parse(line) as { event: string; processedEvents: number };
          if (parsed.event === "progress") progressLines.push(parsed);
        }
      }
    );

    expect(progressLines.length).toBeGreaterThan(1);
    let previous = 0;
    for (const line of progressLines) {
      expect(line.processedEvents).toBeGreaterThan(previous);
      previous = line.processedEvents;
    }
  });

  it("fails loud for an unknown person rather than reporting a successful no-op rebuild", async () => {
    const databasePath = await makeTempDatabase();
    const store = openStore(databasePath);
    store.close();

    await expect(runRebuildDerivationsCommand({ databasePath, personId: "person_unknown" })).rejects.toThrow();
  });
});
