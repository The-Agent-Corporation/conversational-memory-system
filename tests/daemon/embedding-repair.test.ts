import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContractionRunner } from "../../src/daemon/contraction-runner.js";
import { DaemonLoop, type DaemonLoopDependencies } from "../../src/daemon/daemon.js";
import { runDaemonCommand } from "../../src/daemon/daemon-command.js";
import { EmbeddingRepairRunner } from "../../src/daemon/embedding-repair.js";
import { DaemonScheduler } from "../../src/daemon/scheduler.js";
import type { ContractionJob, WriteAuthority } from "../../src/daemon/types.js";
import type { CanonicalEvent, MemorySource, Person } from "../../src/domain/canonical.js";
import type { Summary } from "../../src/domain/types.js";
import type { EmbedderHealth } from "../../src/embeddings/embedder-resolver.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import type { SummaryVectorRecord } from "../../src/storage/memory-store.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";
import { DifferingIdentityEmbedder } from "../embeddings/fixtures.js";
import {
  FIXED_NOW,
  FakeDaemonClock,
  FakeNotificationAdapter,
  FakePowerStateProvider,
  FakeTimerQueue,
  FakeWatcherFactory,
  FaultBoundaryInjector
} from "./fixtures.js";

/**
 * The daemon's repair wiring is only observable through the REAL `createDefaultDependencies` path,
 * so the resolver module is mocked (the Plan 12-03 precedent in `daemon-commands.test.ts`). Nothing
 * else in this file imports `embedder-resolver`, so the mock is inert for every other case here.
 */
const embedderMock = vi.hoisted(() => ({
  calls: [] as string[],
  health: {
    enabled: false,
    provider: "deterministic",
    model: "keyword-hash-v1",
    revision: "",
    healthy: true,
    reason: null
  } as EmbedderHealth
}));

vi.mock("../../src/embeddings/embedder-resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/embeddings/embedder-resolver.js")>();
  return {
    ...actual,
    probeEmbedderHealth: async () => {
      embedderMock.calls.push("probe");
      return embedderMock.health;
    },
    resolveEmbedder: async () => {
      embedderMock.calls.push("resolve");
      const { DifferingIdentityEmbedder: Fake } = await import("../embeddings/fixtures.js");
      return new Fake();
    }
  };
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const PERSON_ID = "person_repair";
const SCOPE_ID = "scope_repair";

/**
 * Every call the repair pass makes against the store, in order, with its arguments — this is how
 * "the budget went INTO the query" is asserted rather than assumed. A pass that fetched all
 * 49,314 ids and `.slice(0, 200)`-ed them in JS records `listSummaryIdsMissingVector` with no
 * `limit`, and the assertion fails.
 */
interface StoreCall {
  method: string;
  args: unknown[];
}

interface SpyHooks {
  /** Makes `listSummaryIdsMissingVector` reject, exercising the throwing-query path. */
  failQuery?: boolean;
  /** Makes `saveSummaryVectors` reject, exercising the throwing-write path. */
  failSave?: boolean;
}

/**
 * A passthrough Proxy over `InMemoryStore` that records the calls the repair pass makes. It never
 * reimplements store behavior — every method delegates to the real store bound to itself.
 */
function spyStore(store: InMemoryStore, calls: StoreCall[], hooks: SpyHooks = {}): InMemoryStore {
  const recorded = new Set([
    "listSummaryIdsMissingVector",
    "listSummariesByIds",
    "listSummaries",
    "saveSummaryVectors"
  ]);
  return new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof property === "string" && recorded.has(property) && typeof value === "function") {
        return async (...args: unknown[]) => {
          calls.push({ method: property, args });
          if (property === "listSummaryIdsMissingVector" && hooks.failQuery) {
            throw new Error("synthetic listSummaryIdsMissingVector failure");
          }
          if (property === "saveSummaryVectors" && hooks.failSave) {
            throw new Error("synthetic saveSummaryVectors failure");
          }
          return (value as (...rest: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as InMemoryStore;
}

const callsTo = (calls: StoreCall[], method: string): StoreCall[] =>
  calls.filter((call) => call.method === method);

describe("EmbeddingRepairRunner", () => {
  it("embeds at most the budget per invocation and converges to zero across successive invocations", async () => {
    const store = await seededStore();
    await seedMissingSummaries(store, 500);
    const embedder = new DifferingIdentityEmbedder();
    const calls: StoreCall[] = [];
    const runner = new EmbeddingRepairRunner({
      store: spyStore(store, calls),
      embedder,
      clock: new FakeDaemonClock(),
      budget: 200,
      // Rate limiting is exercised in its own case; here every invocation must be allowed to work.
      minimumIntervalMs: 0
    });

    const first = await runner.runDue();
    expect(first).toMatchObject({ skipped: false, examined: 200, persisted: 200, failed: 0 });
    expect(embedder.embedCalls).toBe(200);
    expect(await countVectors(store, embedder)).toBe(200);

    const second = await runner.runDue();
    expect(second).toMatchObject({ skipped: false, examined: 200, persisted: 200, failed: 0 });
    expect(await countVectors(store, embedder)).toBe(400);

    const third = await runner.runDue();
    expect(third).toMatchObject({ skipped: false, examined: 100, persisted: 100, failed: 0 });
    expect(await countVectors(store, embedder)).toBe(500);

    // Convergence, not merely the per-pass cap: the fourth pass finds nothing left. A two-key
    // identity mismatch (GAP-12-A) would show up here as an endless 200-per-pass re-embed.
    const fourth = await runner.runDue();
    expect(fourth).toMatchObject({ skipped: false, examined: 0, persisted: 0, failed: 0 });
    expect(embedder.embedCalls).toBe(500);
    expect(await store.listSummaryIdsMissingVector(embedder.provider, embedder.model)).toEqual([]);

    // The pass must never load the whole summary table (the `createStagingStore` anti-pattern).
    expect(callsTo(calls, "listSummaries")).toHaveLength(0);
  });

  it("pushes the budget into the query as `{ limit }` rather than slicing in JS", async () => {
    const store = await seededStore();
    await seedMissingSummaries(store, 500);
    const embedder = new DifferingIdentityEmbedder();
    const calls: StoreCall[] = [];
    const runner = new EmbeddingRepairRunner({
      store: spyStore(store, calls),
      embedder,
      clock: new FakeDaemonClock(),
      budget: 200,
      minimumIntervalMs: 0
    });

    await runner.runDue();

    const queries = callsTo(calls, "listSummaryIdsMissingVector");
    expect(queries).toHaveLength(1);
    expect(queries[0]!.args).toEqual([embedder.provider, embedder.model, { limit: 200 }]);

    // The by-id fetch is bounded by exactly what the query returned.
    const fetches = callsTo(calls, "listSummariesByIds");
    expect(fetches).toHaveLength(1);
    expect((fetches[0]!.args[0] as string[]).length).toBe(200);
  });

  it("heals a summary a crash left committed without its vector", async () => {
    const clock = new FakeDaemonClock();
    const store = await seededStore();
    await seedEvents(store, [
      event("repair-crash-1", 1, "Alpha roadmap milestones.", 0),
      event("repair-crash-2", 2, "Switch to Beta pricing negotiation.", 1)
    ]);
    const job = await enqueue(store, "job-repair-crash", "repair-crash-1", "repair-crash-2");
    const embedder = new DifferingIdentityEmbedder();
    const faults = new FaultBoundaryInjector();
    // The crash window itself: the slice commits, then the process dies before the embed stage.
    faults.arm("after_contraction_checkpoint");

    await expect(new ContractionRunner(store, {
      clock,
      authority: foregroundAuthority(),
      faults,
      summaryEmbedder: embedder
    }).drainSlice(PERSON_ID, job.id)).rejects.toThrow(/after_contraction_checkpoint/);

    const summaries = await store.listSummaries();
    expect(summaries.length).toBeGreaterThan(0);
    expect(embedder.embedCalls).toBe(0);
    for (const summary of summaries) {
      expect(await store.getSummaryVector(summary.id, embedder.provider, embedder.model)).toBeNull();
    }

    const result = await new EmbeddingRepairRunner({ store, embedder, clock }).runDue();

    expect(result).toMatchObject({ skipped: false, examined: summaries.length, persisted: summaries.length });
    for (const summary of summaries) {
      const vector = await store.getSummaryVector(summary.id, embedder.provider, embedder.model);
      expect(vector).not.toBeNull();
      expect(vector?.dimensions).toBe(embedder.dimensions);
      expect(vector?.personId).toBe(PERSON_ID);
    }
  });

  it("does no work at all when nothing is missing", async () => {
    const store = await seededStore();
    const embedder = new DifferingIdentityEmbedder();
    const calls: StoreCall[] = [];

    const result = await new EmbeddingRepairRunner({
      store: spyStore(store, calls),
      embedder,
      clock: new FakeDaemonClock()
    }).runDue();

    expect(result).toEqual({ skipped: false, examined: 0, persisted: 0, failed: 0, remainingInBatch: 0 });
    expect(embedder.embedCalls).toBe(0);
    expect(callsTo(calls, "saveSummaryVectors")).toHaveLength(0);
    expect(callsTo(calls, "listSummaries")).toHaveLength(0);
  });

  it("never throws when the embedder throws", async () => {
    const store = await seededStore();
    await seedMissingSummaries(store, 3);
    const embedder = new ThrowingEmbedder();
    const calls: StoreCall[] = [];

    const result = await new EmbeddingRepairRunner({
      store: spyStore(store, calls),
      embedder,
      clock: new FakeDaemonClock()
    }).runDue();

    expect(result).toMatchObject({ skipped: false, examined: 3, persisted: 0, failed: 3 });
    expect(callsTo(calls, "saveSummaryVectors")).toHaveLength(0);
  });

  it("never throws when the store write rejects", async () => {
    const store = await seededStore();
    await seedMissingSummaries(store, 3);
    const embedder = new DifferingIdentityEmbedder();
    const calls: StoreCall[] = [];

    const result = await new EmbeddingRepairRunner({
      store: spyStore(store, calls, { failSave: true }),
      embedder,
      clock: new FakeDaemonClock()
    }).runDue();

    expect(result).toMatchObject({ skipped: false, examined: 3, persisted: 0, failed: 3 });
    expect(await countVectors(store, embedder)).toBe(0);
  });

  it("never throws when the missing-set query rejects", async () => {
    const store = await seededStore();
    await seedMissingSummaries(store, 3);
    const embedder = new DifferingIdentityEmbedder();
    const calls: StoreCall[] = [];

    const result = await new EmbeddingRepairRunner({
      store: spyStore(store, calls, { failQuery: true }),
      embedder,
      clock: new FakeDaemonClock()
    }).runDue();

    expect(result).toMatchObject({ skipped: false, examined: 0, persisted: 0, failed: 0 });
    expect(embedder.embedCalls).toBe(0);
  });

  it("rate limits with the injected clock: work at most once inside the minimum interval", async () => {
    const clock = new FakeDaemonClock();
    const store = await seededStore();
    await seedMissingSummaries(store, 10);
    const embedder = new DifferingIdentityEmbedder();
    const calls: StoreCall[] = [];
    const runner = new EmbeddingRepairRunner({
      store: spyStore(store, calls),
      embedder,
      clock,
      budget: 4,
      minimumIntervalMs: 15 * 60 * 1000
    });

    const first = await runner.runDue();
    expect(first.skipped).toBe(false);
    expect(first.persisted).toBe(4);

    clock.advanceBy(14 * 60 * 1000);
    const second = await runner.runDue();
    expect(second).toEqual({ skipped: true, examined: 0, persisted: 0, failed: 0, remainingInBatch: 0 });
    // A skipped pass costs exactly one clock read and zero store calls.
    expect(callsTo(calls, "listSummaryIdsMissingVector")).toHaveLength(1);

    clock.advanceBy(1 * 60 * 1000);
    const third = await runner.runDue();
    expect(third.skipped).toBe(false);
    expect(third.persisted).toBe(4);
    expect(embedder.embedCalls).toBe(8);
  });

  it("never embeds a superseded summary", async () => {
    const store = await seededStore();
    await seedMissingSummaries(store, 2, { state: "superseded", prefix: "superseded" });
    await seedMissingSummaries(store, 1, { state: "active", prefix: "active" });
    const embedder = new DifferingIdentityEmbedder();
    const calls: StoreCall[] = [];

    const result = await new EmbeddingRepairRunner({
      store: spyStore(store, calls),
      embedder,
      clock: new FakeDaemonClock()
    }).runDue();

    expect(result).toMatchObject({ examined: 1, persisted: 1, failed: 0 });
    expect(embedder.embedCalls).toBe(1);
    const ids = callsTo(calls, "listSummariesByIds")[0]!.args[0] as string[];
    expect(ids).toEqual(["active_missing_0000"]);
    for (const id of ["superseded_missing_0000", "superseded_missing_0001"]) {
      expect(await store.getSummaryVector(id, embedder.provider, embedder.model)).toBeNull();
    }
  });

  it("skips and counts a summary with no personId, never substituting one (T-10-05)", async () => {
    const store = await seededStore();
    await seedMissingSummaries(store, 2);
    const embedder = new DifferingIdentityEmbedder();
    const calls: StoreCall[] = [];
    // The commit validator rejects a personId-less summary, so the case is expressed by stripping
    // the field on the way out of the bounded fetch — the same shape Plan 12-03 needed.
    const store_ = new Proxy(spyStore(store, calls), {
      get(target, property) {
        if (property === "listSummariesByIds") {
          return async (ids: readonly string[]) => {
            const summaries = await target.listSummariesByIds(ids);
            if (summaries[0]) delete (summaries[0] as { personId?: string }).personId;
            return summaries;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as InMemoryStore;

    const result = await new EmbeddingRepairRunner({
      store: store_,
      embedder,
      clock: new FakeDaemonClock()
    }).runDue();

    expect(result).toMatchObject({ examined: 2, persisted: 1, failed: 1 });
    const records = callsTo(calls, "saveSummaryVectors")[0]!.args[0] as SummaryVectorRecord[];
    expect(records).toHaveLength(1);
    expect(records[0]!.personId).toBe(PERSON_ID);
  });
});

// ---------------------------------------------------------------------------
// Plan 12-04 Task 2 — the daemon wiring (F2, F11)
// ---------------------------------------------------------------------------

describe("DaemonLoop embeddingRepair wiring", () => {
  it("invokes the repair pass on every drain, and its throw never fails the drain or drops the lease", async () => {
    const clock = new FakeDaemonClock();
    const store = new InMemoryStore({ clock });
    await store.savePerson({ id: "person_loop_drain", displayName: null, createdAt: FIXED_NOW });
    let proposalRuns = 0;
    const runDueCalls: string[] = [];
    const harness = loopHarness(store, clock, "owner-repair-drain", 601, {
      runProposals: async () => { proposalRuns += 1; return { proposals: 0 }; },
      embeddingRepair: {
        runDue: async () => {
          runDueCalls.push("drain");
          throw new Error("simulated repair-pass failure");
        }
      }
    });

    for (let index = 0; index < 3; index += 1) {
      await expect(harness.loop.drainOne()).resolves.toBeDefined();
    }

    expect(runDueCalls).toHaveLength(3);
    // Local work keeps flowing: the repair pass is a best-effort second line, never a dependency.
    expect(proposalRuns).toBe(3);
    expect((await store.getDaemonLease("memory-db"))?.ownerToken).toBe("owner-repair-drain");

    await harness.loop.requestStop();
    await harness.loop.drainOne();
    expect(await store.getDaemonLease("memory-db")).toBeNull();
  });

  it("invokes the repair pass in `runOnce` too, which has its own loop and never calls drainOne (F11)", async () => {
    const clock = new FakeDaemonClock();
    const store = new InMemoryStore({ clock });
    await store.savePerson({ id: "person_loop_once", displayName: null, createdAt: FIXED_NOW });
    const order: string[] = [];
    const harness = loopHarness(store, clock, "owner-repair-once", 602, {
      runProposals: async () => { order.push("proposals"); return { proposals: 0 }; },
      embeddingRepair: {
        runDue: async () => {
          order.push("repair");
          throw new Error("simulated repair-pass failure");
        }
      }
    });

    const result = await harness.loop.runOnce();

    expect(result).toMatchObject({ scannedSources: 0, contractionSlices: 0 });
    // Exactly once, and before the proposal tier — a throw there would have ended the run.
    expect(order).toEqual(["repair", "proposals"]);
  });

  it("does not contribute to didWork, so a repairing daemon still idles", async () => {
    const clock = new FakeDaemonClock();
    const store = new InMemoryStore({ clock });
    const harness = loopHarness(store, clock, "owner-repair-idle", 603, {
      embeddingRepair: {
        // Reports real work; the loop must still call this an idle drain, or an idle daemon
        // becomes a hot poll loop (the sync-cycle precedent, daemon.ts:169-170).
        runDue: async () => ({ skipped: false, examined: 200, persisted: 200, failed: 0, remainingInBatch: 0 })
      }
    });

    await expect(harness.loop.drainOne()).resolves.toBe(false);

    await harness.loop.requestStop();
    await harness.loop.drainOne();
  });
});

describe("daemon repair-pass wiring through the real dependency path (F2)", () => {
  const runOnceAgainstTempDatabase = async (name: string) => {
    embedderMock.calls.length = 0;
    const directory = await mkdtemp(join(tmpdir(), `daemon-repair-${name}-`));
    temporaryDirectories.push(directory);
    const missingSetQueries: unknown[][] = [];
    const spy = vi.spyOn(SqliteStore.prototype, "listSummaryIdsMissingVector")
      .mockImplementation(async function (this: SqliteStore, ...args: unknown[]) {
        missingSetQueries.push(args);
        return [];
      } as never);
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await runDaemonCommand({
        subcommand: "once",
        databasePath: join(directory, "memory.sqlite")
      });
      return { result, missingSetQueries };
    } finally {
      spy.mockRestore();
      write.mockRestore();
    }
  };

  it("no-ops with ZERO store queries when no embedder is resolved", async () => {
    embedderMock.health = {
      enabled: false, provider: "deterministic", model: "keyword-hash-v1", revision: "", healthy: true, reason: null
    };

    const { result, missingSetQueries } = await runOnceAgainstTempDatabase("disabled");

    expect(result).toMatchObject({ ok: true, subcommand: "once" });
    // The dependency is ALWAYS spread — presence cannot depend on a value that does not exist when
    // the loop is constructed (F2). "Off" is therefore a no-op `runDue`, proven by zero queries.
    expect(missingSetQueries).toEqual([]);
    expect(embedderMock.calls).toEqual(["probe"]);
  });

  it("runs the pass in `once` mode when an embedder resolves, with the budget in the query", async () => {
    embedderMock.health = {
      enabled: true, provider: "fake-differing", model: "fake-repo@r1", revision: "r1", healthy: true, reason: null
    };

    const { result, missingSetQueries } = await runOnceAgainstTempDatabase("healthy");

    expect(result).toMatchObject({ ok: true, subcommand: "once" });
    // F11 end-to-end: `memory daemon once` really does exercise the repair pass, so Plan 12-06's
    // clone check is not silently asserting nothing.
    expect(missingSetQueries).toEqual([["fake-differing", "fake-repo@r1", { limit: 200 }]]);
    // One resolve per process — the repair pass reuses the contraction stage's embedder (T-12-23).
    expect(embedderMock.calls).toEqual(["probe", "resolve"]);
  });
});

function loopHarness(
  store: InMemoryStore,
  clock: FakeDaemonClock,
  ownerToken: string,
  pid: number,
  overrides: Partial<{
    runProposals: (personId: string, authority: unknown) => Promise<{ proposals: number }>;
    embeddingRepair: DaemonLoopDependencies["embeddingRepair"];
  }> = {}
): { loop: DaemonLoop } {
  const authority = { kind: "daemon" as const, databaseId: "memory-db", ownerToken };
  const dependencies: DaemonLoopDependencies = {
    store,
    scheduler: new DaemonScheduler(store, { clock, promptBurstLimit: 1, authority }),
    clock,
    timers: new FakeTimerQueue(clock),
    watcherFactory: new FakeWatcherFactory(),
    power: new FakePowerStateProvider("external"),
    notifier: new FakeNotificationAdapter(),
    sourceRunner: { run: async () => ({ importedEvents: 0 }) },
    contractionRunner: { drainSlice: async () => ({ complete: true }) },
    proposalScheduler: {
      runDue: async (personId, captured) =>
        (overrides.runProposals ?? (async () => ({ proposals: 0 })))(personId, captured)
    },
    ...(overrides.embeddingRepair ? { embeddingRepair: overrides.embeddingRepair } : {})
  };
  return { loop: new DaemonLoop(dependencies, { databaseId: "memory-db", ownerToken, pid }) };
}

/** An embedder that rejects on every call, for the failure-isolation cases. */
class ThrowingEmbedder {
  readonly provider = "throwing";
  readonly model = "always-fails";
  readonly dimensions = 4;

  async embed(_text: string): Promise<never> {
    throw new Error("synthetic embedder failure");
  }
}

async function countVectors(store: InMemoryStore, embedder: { provider: string; model: string }): Promise<number> {
  const summaries = await store.listSummaries();
  let count = 0;
  for (const summary of summaries) {
    if (await store.getSummaryVector(summary.id, embedder.provider, embedder.model)) count += 1;
  }
  return count;
}

async function seededStore(): Promise<InMemoryStore> {
  const store = new InMemoryStore();
  const person: Person = { id: PERSON_ID, displayName: null, createdAt: FIXED_NOW };
  const source: MemorySource = {
    id: `source_${PERSON_ID}`,
    personId: PERSON_ID,
    application: "synthetic",
    profileId: "default",
    instanceId: "test",
    scopeId: SCOPE_ID,
    createdAt: FIXED_NOW,
    lastImportedAt: FIXED_NOW
  };
  await store.savePerson(person);
  await store.saveSource(source);
  return store;
}

async function seedMissingSummaries(
  store: InMemoryStore,
  count: number,
  options: { state?: Summary["state"]; prefix?: string } = {}
): Promise<void> {
  const state = options.state ?? "compacted";
  const prefix = options.prefix ?? "missing";
  for (let index = 0; index < count; index += 1) {
    await store.saveSummary({
      // Zero-padded so lexicographic ascending order matches numeric order — the pass relies on the
      // query's stable ascending id order for forward progress.
      id: `${prefix}_missing_${String(index).padStart(4, "0")}`,
      personId: PERSON_ID,
      scopeIds: [SCOPE_ID],
      origin: "host_session",
      summaryText: `Repair candidate summary ${prefix} ${index}.`,
      sourceTurnRanges: [{ threadId: `person:${PERSON_ID}`, startSequence: 1, endSequence: 1 }],
      sourceCanonicalEventIds: [],
      sourceSummaryIds: [],
      boxIds: [],
      embedding: null,
      createdAt: FIXED_NOW,
      model: "seed",
      promptVersion: "seed/v1",
      confidence: 0.5,
      state,
      detailLevel: "brief",
      tokenCount: 4,
      lastAccessedAt: null,
      version: 1,
      strength: 0.5,
      retrievalCount: 0,
      retrievedAt: null,
      halfLifeHours: 168,
      outcomeScore: null
    });
  }
}

async function seedEvents(store: InMemoryStore, events: CanonicalEvent[]): Promise<void> {
  for (const item of events) await store.saveCanonicalEvent(item);
}

function foregroundAuthority(): WriteAuthority {
  return { kind: "foreground", personId: PERSON_ID, operation: "historical-bootstrap" };
}

function event(
  id: string,
  nativeSequence: number,
  content: string,
  minuteOffset: number,
  role: CanonicalEvent["role"] = "user"
): CanonicalEvent {
  const occurredAt = new Date(Date.parse(FIXED_NOW) + minuteOffset * 60_000).toISOString();
  return {
    id,
    personId: PERSON_ID,
    sourceId: `source_${PERSON_ID}`,
    sourceApplication: "synthetic",
    sourceProfileId: "default",
    scopeId: SCOPE_ID,
    nativeSessionId: "session-synthetic",
    nativeEventId: id,
    nativeSequence,
    causalParentId: null,
    eventKind: "message",
    role,
    content,
    occurredAt,
    importedAt: FIXED_NOW,
    provenance: role === "user" ? "direct_user_input" : "assistant_output",
    trustLevel: role === "user" ? "high" : "medium",
    contentHash: `hash-${id}`,
    parserVersion: "synthetic/v1",
    metadata: {}
  };
}

async function enqueue(
  store: InMemoryStore,
  id: string,
  earliestId: string,
  latestId: string
): Promise<ContractionJob> {
  const events = await store.listCanonicalEvents(PERSON_ID);
  const byId = new Map(events.map((item) => [item.id, item]));
  const orderKey = (eventId: string) => {
    const item = byId.get(eventId);
    if (!item) throw new Error(`Missing synthetic event ${eventId}`);
    return { occurredAt: item.occurredAt, nativeSequence: item.nativeSequence, id: item.id };
  };
  const job: ContractionJob = {
    id,
    personId: PERSON_ID,
    generation: 1,
    earliestAffected: orderKey(earliestId),
    latestAffected: orderKey(latestId),
    state: "pending",
    attempts: 0,
    immediateDirty: true,
    proposalDirty: true,
    lastProposalRunAt: null,
    lastActivityAt: FIXED_NOW,
    nextDueAt: FIXED_NOW,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW
  };
  await store.saveContractionJob(job);
  return job;
}
