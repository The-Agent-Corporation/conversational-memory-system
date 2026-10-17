import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBootstrapCommand } from "../../src/bootstrap/bootstrap-command.js";
import { historicalContractionJobId } from "../../src/bootstrap/historical-bootstrapper.js";
import { PROCESSOR_VERSION } from "../../src/daemon/contraction-runner.js";
import type { CanonicalEvent } from "../../src/domain/canonical.js";
import { semanticConfigPath } from "../../src/openrouter/config.js";
import { SpendCapPausedError } from "../../src/openrouter/types.js";
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

function toOrderKey(event: CanonicalEvent) {
  return { occurredAt: event.occurredAt, nativeSequence: event.nativeSequence, id: event.id };
}

const EVENTS_PER_TOPIC = 7;

/**
 * Directly forges a "legacy" derived state: a completed, current-generation contraction job/checkpoint
 * tagged with a legacy `processorVersion`, plus one hand-written pre-hygiene summary per topic window
 * carrying raw `[Tool call:`/`[SYSTEM:` text under a summary id that can never collide with a
 * hygiene-aware rebuild's deterministically-computed id (which is a function of first-event-id +
 * topic label, not content — a same-boundary continuing span legitimately upserts in place rather
 * than superseding, per Pitfall 5, so a same-id fixture would not exercise supersession at all). This
 * is what makes the "no orphans" case's "every pre-hygiene summary is superseded" assertion meaningful:
 * real pre-hygiene derivations differed because pre-hygiene code let tool/synthetic events drive topic
 * labels too, which is exactly the boundary difference a fixture must reproduce to be representative.
 */
async function buildForgedLegacyCorpus(databasePath: string, events: CanonicalEvent[]): Promise<{ legacySummaryIds: string[] }> {
  const store = openStore(databasePath);
  await store.savePerson({ id: PERSON_ID, displayName: null, createdAt: NOW });
  await store.saveSource({
    id: `source_${PERSON_ID}`,
    personId: PERSON_ID,
    application: "synthetic",
    profileId: "default",
    instanceId: "test",
    createdAt: NOW,
    lastImportedAt: NOW
  });
  for (const item of events) await store.saveCanonicalEvent(item);

  const jobId = historicalContractionJobId(PERSON_ID);
  const checkpointId = `contraction_checkpoint_${jobId}`;
  const firstKey = toOrderKey(events[0]!);
  const lastKey = toOrderKey(events.at(-1)!);

  await store.saveContractionJob({
    id: jobId,
    personId: PERSON_ID,
    generation: 1,
    earliestAffected: firstKey,
    latestAffected: lastKey,
    state: "complete",
    attempts: 1,
    immediateDirty: false,
    proposalDirty: false,
    lastProposalRunAt: null,
    lastActivityAt: NOW,
    nextDueAt: NOW,
    createdAt: NOW,
    updatedAt: NOW
  });
  await store.saveContractionCheckpoint({
    id: checkpointId,
    personId: PERSON_ID,
    jobId,
    processorVersion: LEGACY_PROCESSOR_VERSION,
    generation: 1,
    processedThroughOrderKey: lastKey,
    nextOrderKey: null,
    nextEventId: null,
    activeTopic: null,
    sliceCount: 1,
    immediateStage: "complete",
    proposalStage: "complete",
    pendingToolRun: null,
    updatedAt: NOW
  });

  const legacySummaryIds: string[] = [];
  for (let topic = 0; topic * EVENTS_PER_TOPIC < events.length; topic += 1) {
    const windowEvents = events.slice(topic * EVENTS_PER_TOPIC, (topic + 1) * EVENTS_PER_TOPIC);
    if (windowEvents.length === 0) continue;
    const legacyId = `legacy_summary_${topic}`;
    legacySummaryIds.push(legacyId);
    await store.saveSummary({
      id: legacyId,
      personId: PERSON_ID,
      scopeIds: ["personal"],
      origin: "historical_bootstrap",
      summaryText: `[Tool call: Bash] ${JSON.stringify({ arg: "legacy" })} raw pre-hygiene dump for topic ${topic} [SYSTEM: harness note]`,
      sourceTurnRanges: [
        {
          threadId: `person:${PERSON_ID}`,
          startSequence: windowEvents[0]!.nativeSequence,
          endSequence: windowEvents.at(-1)!.nativeSequence
        }
      ],
      sourceCanonicalEventIds: windowEvents.map((event) => event.id),
      sourceSummaryIds: [],
      boxIds: [],
      embedding: null,
      createdAt: NOW,
      model: "legacy-summarizer",
      promptVersion: "v0",
      confidence: 0.5,
      state: "compacted",
      detailLevel: "brief",
      tokenCount: 20,
      lastAccessedAt: null,
      version: 1,
      strength: 0.5,
      retrievalCount: 0,
      retrievedAt: null,
      halfLifeHours: 168,
      outcomeScore: null
    });
  }
  store.close();
  return { legacySummaryIds };
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

  async function withLocalOpenRouter<T>(run: (baseUrl: string, models: string[]) => Promise<T>): Promise<T> {
    const models: string[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        models.push(JSON.parse(body).model);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            title: "Topic switch",
            summaryText: "The user switched topics.",
            confidence: 0.8,
            detailLevel: "brief",
            tokenCount: 5
          }) } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 }
        }));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    try {
      return await run(`http://127.0.0.1:${address.port}/v1`, models);
    } finally {
      server.close();
    }
  }

  it("semantic mode summarizes with the default Haiku model and records spend in the store ledger", async () => {
    const databasePath = await makeTempDatabase();
    await buildPreHygieneCorpus(databasePath, buildCorpus(2));

    await withLocalOpenRouter(async (baseUrl, models) => {
      await writeFile(semanticConfigPath(databasePath), JSON.stringify({ enabled: true, baseUrl }), "utf8");

      const result = await runRebuildDerivationsCommand({ databasePath, personId: PERSON_ID });
      expect(result.rebuilt).toBe(true);
      expect(models.length).toBeGreaterThan(0);
      expect(new Set(models)).toEqual(new Set(["anthropic/claude-haiku-5.5"]));

      const store = openStore(databasePath);
      const active = (await store.listSummaries({ personId: PERSON_ID }))
        .filter((summary) => summary.state !== "superseded");
      const spent = await store.modelSpendOnDay(new Date().toISOString().slice(0, 10));
      store.close();
      expect(active.length).toBeGreaterThan(0);
      for (const summary of active) expect(summary.model).toBe("openrouter:anthropic/claude-haiku-5.5");
      expect(spent).toBeCloseTo(models.length * 0.001, 6);
    });
  });

  it("semantic mode pauses at the daily spend cap before calling the model", async () => {
    const databasePath = await makeTempDatabase();
    await buildPreHygieneCorpus(databasePath, buildCorpus(2));

    await withLocalOpenRouter(async (baseUrl, models) => {
      await writeFile(
        semanticConfigPath(databasePath),
        JSON.stringify({ enabled: true, baseUrl, dailySpendCapUsd: 0 }),
        "utf8"
      );

      await expect(runRebuildDerivationsCommand({ databasePath, personId: PERSON_ID }))
        .rejects.toBeInstanceOf(SpendCapPausedError);
      expect(models).toEqual([]);
    });
  });

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
    const { legacySummaryIds } = await buildForgedLegacyCorpus(databasePath, buildCorpus(TOPIC_COUNT));
    expect(legacySummaryIds.length).toBeGreaterThan(0);

    const seedStore = openStore(databasePath);
    const vectorRecords: SummaryVectorRecord[] = legacySummaryIds.map((summaryId) => ({
      summaryId,
      provider: "test-provider",
      model: "test-model",
      dimensions: 4,
      vector: [0.1, 0.2, 0.3, 0.4],
      personId: PERSON_ID,
      scopeIds: ["personal"],
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

    // Every forged legacy summary must be marked superseded, not merely absent.
    for (const legacyId of legacySummaryIds) {
      expect(supersededIds.has(legacyId)).toBe(true);
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
