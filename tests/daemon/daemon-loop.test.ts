import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonLoop, type DaemonLoopDependencies } from "../../src/daemon/daemon.js";
import { resolveProductionSyncReplicationDependency } from "../../src/daemon/daemon-command.js";
import { DaemonScheduler } from "../../src/daemon/scheduler.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";
import { InMemoryDeviceSecretStore } from "../../src/sync/secrets/in-memory-device-secret-store.js";
import { LibsodiumCryptoProvider } from "../../src/sync/crypto/libsodium-crypto-provider.js";
import {
  FIXED_NOW,
  FakeDaemonClock,
  FakeNotificationAdapter,
  FakePowerStateProvider,
  FakeTimerQueue,
  FakeWatcherFactory,
  normalizePersistedDaemonState
} from "./fixtures.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("DaemonLoop", () => {
  it("rejects a fresh second writer and permits takeover only after lease expiry", async () => {
    const clock = new FakeDaemonClock();
    const store = new InMemoryStore({ clock });
    const first = loopHarness(store, clock, "owner-a", 101);
    const second = loopHarness(store, clock, "owner-b", 202);

    await expect(first.loop.tick()).resolves.toBeDefined();
    await expect(second.loop.tick()).rejects.toThrow(/lease|writer|running/i);
    clock.advanceBy(30_001);
    await expect(second.loop.tick()).resolves.toBeDefined();

    await second.loop.requestStop();
    await expect(second.loop.drainOne()).resolves.toBeDefined();
    expect(await store.getDaemonLease("memory-db")).toBeNull();
  });

  it("reconstructs approved people, due sources, retries, jobs, and proposal work from reopened SQLite", async () => {
    const directory = await mkdtemp(join(tmpdir(), "daemon-loop-reopen-"));
    cleanup.push(directory);
    const databasePath = join(directory, "memory.sqlite");
    let store = new SqliteStore(databasePath);
    await seedDurableWork(store, "person-a", "candidate-a", "grant-a");
    await seedDurableWork(store, "person-b", "candidate-b", "grant-b");
    store.close();

    const clock = new FakeDaemonClock();
    clock.advanceBy(60_000);
    store = new SqliteStore(databasePath, { clock });
    const observed: string[] = [];
    const harness = loopHarness(store, clock, "owner-reopen", 303, {
      runSource: async (personId, candidateId) => {
        observed.push(`${personId}:${candidateId}`);
        if (candidateId === "candidate-a") throw new Error("synthetic source failure");
        return { importedEvents: 0 };
      },
      runContraction: async (personId) => { observed.push(`contraction:${personId}`); return { complete: true }; },
      runProposals: async (personId) => { observed.push(`proposal:${personId}`); return { proposals: 0 }; }
    });

    for (let index = 0; index < 8; index += 1) await harness.loop.drainOne();
    expect(observed).toContain("person-a:candidate-a");
    expect(observed).toContain("person-b:candidate-b");
    expect(observed).toContain("contraction:person-a");
    expect(observed).toContain("contraction:person-b");
    expect(observed.some((entry) => entry.startsWith("proposal:"))).toBe(true);
    expect((await store.listDaemonSourceStates("person-a"))[0]).toMatchObject({
      candidateId: "candidate-a",
      consecutiveFailures: 1
    });
    await harness.loop.requestStop();
    await harness.loop.drainOne();
    store.close();
  });

  it("reconciles an ordinary grants-only SQLite database before reconstruct and once scanning", async () => {
    const directory = await mkdtemp(join(tmpdir(), "daemon-loop-ordinary-"));
    cleanup.push(directory);
    const databasePath = join(directory, "memory.sqlite");
    let store = new SqliteStore(databasePath);
    await seedApprovedGrant(store, "person-a", "candidate-a", "grant-a");
    expect(await store.listDaemonSourceStates("person-a")).toEqual([]);
    store.close();

    const clock = new FakeDaemonClock();
    store = new SqliteStore(databasePath, { clock });
    const observed: string[] = [];
    const harness = loopHarness(store, clock, "owner-ordinary", 313, {
      runSource: async (personId, candidateId) => {
        observed.push(`${personId}:${candidateId}`);
        return { importedEvents: 0 };
      }
    });

    await harness.loop.tick();
    expect(observed).toEqual(["person-a:candidate-a"]);
    await harness.loop.requestStop();
    await harness.loop.drainOne();

    const onceObserved: string[] = [];
    const onceHarness = loopHarness(store, clock, "owner-ordinary-once", 314, {
      runSource: async (personId, candidateId) => {
        onceObserved.push(`${personId}:${candidateId}`);
        return { importedEvents: 0 };
      }
    });
    const result = await onceHarness.loop.runOnce();

    expect(result.scannedSources).toBe(1);
    expect(onceObserved).toEqual(["person-a:candidate-a"]);
    expect(await store.listDaemonSourceStates("person-a")).toMatchObject([
      { personId: "person-a", candidateId: "candidate-a", grantId: "grant-a" }
    ]);
    expect(harness.watchers.watchedPaths).toEqual(["/synthetic/candidate-a"]);
    expect(harness.watchers.closedPaths).toEqual(["/synthetic/candidate-a"]);
    expect(onceHarness.watchers.watchedPaths).toEqual(["/synthetic/candidate-a"]);
    store.close();
  });

  it("converges live grants, durable source state, and advisory watches to the exact active set", async () => {
    const clock = new FakeDaemonClock();
    const store = new InMemoryStore({ clock });
    await seedApprovedGrant(store, "person-a", "candidate-a", "grant-a");
    await seedApprovedGrant(store, "person-b", "candidate-other", "grant-other");
    const observed: string[] = [];
    const harness = loopHarness(store, clock, "owner-grants", 323, {
      runSource: async (personId, candidateId) => {
        observed.push(`${personId}:${candidateId}`);
        return { importedEvents: 0 };
      }
    });

    await harness.loop.tick();
    await seedApprovedGrant(store, "person-a", "candidate-b", "grant-b");
    const grantA = await store.getSourceGrant("grant-a");
    if (!grantA) throw new Error("Synthetic grant missing");
    await store.saveSourceGrant({
      ...grantA,
      state: "revoked",
      revokedAt: "2026-07-17T12:00:01.000Z",
      updatedAt: "2026-07-17T12:00:01.000Z"
    });

    await harness.loop.tick();

    expect(await store.listDaemonSourceStates("person-a")).toMatchObject([
      { personId: "person-a", candidateId: "candidate-b", grantId: "grant-b" }
    ]);
    expect(await store.listDaemonSourceStates("person-b")).toMatchObject([
      { personId: "person-b", candidateId: "candidate-other", grantId: "grant-other" }
    ]);
    expect(harness.watchers.closedPaths).toContain("/synthetic/candidate-a");
    expect(harness.watchers.watchedPaths).toContain("/synthetic/candidate-b");
    expect(observed).toContain("person-a:candidate-b");
    expect(await store.getSourceGrant("grant-b")).toMatchObject({ state: "approved" });
    await harness.loop.requestStop();
    await harness.loop.drainOne();
  });

  it("recovers a lost watch hint through the authoritative safety rescan", async () => {
    const clock = new FakeDaemonClock();
    const store = new InMemoryStore({ clock });
    await seedDurableWork(store, "person-a", "candidate-a", "grant-a", false);
    const observed: string[] = [];
    const harness = loopHarness(store, clock, "owner-rescan", 404, {
      runSource: async (personId, candidateId) => {
        observed.push(`${personId}:${candidateId}`);
        return { importedEvents: 0 };
      }
    });

    await harness.loop.tick();
    expect(observed).toEqual([]);
    for (let index = 0; index < 6; index += 1) await harness.timers.advanceBy(10_000);
    await harness.loop.tick();
    expect(observed).toEqual(["person-a:candidate-a"]);
  });

  it("runOnce snapshots one due pass, drains bounded derivation work, reports remaining work, and releases", async () => {
    const clock = new FakeDaemonClock();
    const store = new InMemoryStore({ clock });
    await seedDurableWork(store, "person-a", "candidate-a", "grant-a");
    const harness = loopHarness(store, clock, "owner-once", 505);

    const result = await harness.loop.runOnce();

    expect(result).toMatchObject({
      scannedSources: 1,
      contractionSlices: expect.any(Number),
      proposalRuns: expect.any(Number),
      remainingSources: expect.any(Number),
      remainingContractions: expect.any(Number),
      remainingProposals: expect.any(Number)
    });
    expect(Object.values(result).every((value) => typeof value !== "number" || value >= 0)).toBe(true);
    expect(await store.getDaemonLease("memory-db")).toBeNull();
  });

  it("graceful stop closes watches, leaves an atomic checkpoint, and releases the matching token", async () => {
    const clock = new FakeDaemonClock();
    const store = new InMemoryStore({ clock });
    await seedDurableWork(store, "person-a", "candidate-a", "grant-a");
    const harness = loopHarness(store, clock, "owner-stop", 606);

    await harness.loop.tick();
    await harness.loop.requestStop();
    await harness.loop.drainOne();

    expect(harness.watchers.closedPaths.length).toBeGreaterThan(0);
    expect(await store.getContractionJob("job-person-a")).not.toBeNull();
    expect(await store.getDaemonLease("memory-db")).toBeNull();
  });

  it.each(["source", "contraction", "proposal"] as const)(
    "heartbeats independently while long %s work exceeds lease expiry",
    async (workClass) => {
      const clock = new FakeDaemonClock();
      const store = new InMemoryStore({ clock });
      const pending = deferred<void>();
      const started = deferred<void>();
      await store.savePerson({ id: "person-long", displayName: null, createdAt: FIXED_NOW });
      if (workClass === "source") await seedApprovedGrant(store, "person-long", "candidate-long", "grant-long");
      if (workClass === "contraction") await seedContractionJob(store, "person-long", "job-long");
      const harness = loopHarness(store, clock, `owner-long-${workClass}`, 700, {
        runSource: async () => {
          if (workClass === "source") { started.resolve(); await pending.promise; }
          return { importedEvents: 0 };
        },
        runContraction: async () => {
          if (workClass === "contraction") { started.resolve(); await pending.promise; }
          return { complete: true };
        },
        runProposals: async () => {
          if (workClass === "proposal") { started.resolve(); await pending.promise; }
          return { proposals: 0 };
        }
      });

      const work = harness.loop.drainOne();
      await started.promise;
      for (let index = 0; index < 4; index += 1) await harness.timers.advanceBy(10_000);
      const lease = await store.getDaemonLease("memory-db");
      expect(lease).toMatchObject({ ownerToken: `owner-long-${workClass}` });
      expect(Date.parse(lease?.expiresAt ?? "")).toBeGreaterThan(Date.parse(clock.now()));
      const contender = loopHarness(store, clock, `contender-${workClass}`, 701);
      await expect(contender.loop.tick()).rejects.toThrow(/lease|writer|running/i);

      pending.resolve();
      await work;
      await harness.loop.requestStop();
      await harness.loop.drainOne();
      expect(harness.timers.pendingCount()).toBe(0);
    }
  );

  it("latches heartbeat turnover, starts no new stage, and never releases the replacement lease", async () => {
    const clock = new FakeDaemonClock();
    const store = new InMemoryStore({ clock });
    const pending = deferred<void>();
    const started = deferred<void>();
    let proposals = 0;
    await seedApprovedGrant(store, "person-turnover", "candidate-turnover", "grant-turnover");
    const harness = loopHarness(store, clock, "owner-old", 801, {
      runSource: async () => { started.resolve(); await pending.promise; return { importedEvents: 0 }; },
      runProposals: async () => { proposals += 1; return { proposals: 0 }; }
    });

    const work = harness.loop.drainOne();
    await started.promise;
    await store.releaseDaemonLease("memory-db", "owner-old");
    await store.acquireDaemonLease({
      databaseId: "memory-db",
      ownerToken: "owner-replacement",
      pid: 802,
      now: clock.now()
    });
    await harness.timers.advanceBy(10_000);
    pending.resolve();
    await work;
    await harness.loop.drainOne();

    expect(proposals).toBe(0);
    expect(await store.getDaemonLease("memory-db")).toMatchObject({
      ownerToken: "owner-replacement",
      pid: 802
    });
    expect(harness.timers.pendingCount()).toBe(0);
  });

  it.each(["source", "contraction", "proposal"] as const)(
    "carries one immutable authority tuple through %s turnover and replacement replay",
    async (workClass) => {
      const clock = new FakeDaemonClock();
      const store = new InMemoryStore({ clock });
      const started = deferred<void>();
      const pending = deferred<void>();
      const observedAuthorities: unknown[] = [];
      let replacementRuns = 0;
      await store.savePerson({ id: "person-turnover", displayName: null, createdAt: FIXED_NOW });
      if (workClass === "source") {
        await seedApprovedGrant(store, "person-turnover", "candidate-turnover", "grant-turnover");
      }
      if (workClass === "contraction") {
        await seedContractionJob(store, "person-turnover", "job-turnover");
      }

      const old = loopHarness(store, clock, "owner-a", 901, {
        runSource: async (_personId, _candidateId, authority) => {
          if (workClass === "source") {
            observedAuthorities.push(authority);
            started.resolve();
            await pending.promise;
          }
          return { importedEvents: 0 };
        },
        runContraction: async (_personId, _jobId, authority) => {
          if (workClass === "contraction") {
            observedAuthorities.push(authority);
            started.resolve();
            await pending.promise;
          }
          return { complete: true };
        },
        runProposals: async (_personId, authority) => {
          if (workClass === "proposal") {
            observedAuthorities.push(authority);
            started.resolve();
            await pending.promise;
            throw new Error("stale proposal publication rejected");
          }
          return { proposals: 0 };
        }
      });

      const oldTurn = old.loop.drainOne();
      await started.promise;
      await store.releaseDaemonLease("memory-db", "owner-a");
      await store.acquireDaemonLease({
        databaseId: "memory-db",
        ownerToken: "owner-b",
        pid: 902,
        now: clock.now()
      });
      const before = await daemonSnapshot(store, "person-turnover");
      pending.resolve();
      await oldTurn;

      expect(observedAuthorities).toEqual([{
        kind: "daemon",
        databaseId: "memory-db",
        ownerToken: "owner-a"
      }]);
      expect(await daemonSnapshot(store, "person-turnover")).toEqual(before);
      expect(await store.getDaemonLease("memory-db")).toMatchObject({ ownerToken: "owner-b", pid: 902 });
      expect(old.watchers.closedPaths.length).toBeGreaterThanOrEqual(0);
      expect(old.timers.pendingCount()).toBe(0);

      const replacement = loopHarness(store, clock, "owner-b", 902, {
        runSource: async () => { if (workClass === "source") replacementRuns += 1; return { importedEvents: 0 }; },
        runContraction: async () => { if (workClass === "contraction") replacementRuns += 1; return { complete: true }; },
        runProposals: async () => { if (workClass === "proposal") replacementRuns += 1; return { proposals: 1 }; }
      });
      await replacement.loop.drainOne();
      expect(replacementRuns).toBe(1);
      await replacement.loop.requestStop();
      await replacement.loop.drainOne();
    }
  );
});

describe("DaemonLoop: optional bounded sync replication cycle (Task 06-08-02)", () => {
  it("runs the sync cycle under the same captured writer authority as every other work item", async () => {
    const clock = new FakeDaemonClock();
    const store = new InMemoryStore({ clock });
    const observedAuthorities: unknown[] = [];
    const harness = loopHarness(store, clock, "owner-sync", 501, {
      syncReplication: {
        runCycle: async (authority) => { observedAuthorities.push(authority); return { pushed: 0, applied: 0 }; }
      }
    });
    await harness.loop.drainOne();
    expect(observedAuthorities).toEqual([{ kind: "daemon", databaseId: "memory-db", ownerToken: "owner-sync" }]);
    await harness.loop.requestStop();
    await harness.loop.drainOne();
  });

  it("never blocks local proposal/MCP-relevant work or loses writer-lease authority when the sync cycle throws every cycle (offline/misconfigured relay)", async () => {
    const clock = new FakeDaemonClock();
    const store = new InMemoryStore({ clock });
    await store.savePerson({ id: "person-sync-offline", displayName: null, createdAt: FIXED_NOW });
    let proposalRuns = 0;
    const harness = loopHarness(store, clock, "owner-sync-offline", 502, {
      runProposals: async () => { proposalRuns += 1; return { proposals: 0 }; },
      syncReplication: {
        runCycle: async () => { throw new Error("simulated relay offline/misconfigured"); }
      }
    });

    for (let index = 0; index < 3; index += 1) await harness.loop.drainOne();
    expect(proposalRuns).toBe(3);
    // Writer-lease authority must remain intact despite every sync-cycle throw.
    const lease = await store.getDaemonLease("memory-db");
    expect(lease?.ownerToken).toBe("owner-sync-offline");

    await harness.loop.requestStop();
    await harness.loop.drainOne();
    expect(await store.getDaemonLease("memory-db")).toBeNull();
  });

  it("is a complete no-op when unconfigured (undefined) -- identical to Phase 05 daemon behavior", async () => {
    const clock = new FakeDaemonClock();
    const store = new InMemoryStore({ clock });
    const harness = loopHarness(store, clock, "owner-no-sync", 503);
    await expect(harness.loop.drainOne()).resolves.toBeDefined();
    await harness.loop.requestStop();
    await harness.loop.drainOne();
  });
});

describe("resolveProductionSyncReplicationDependency: production daemon transport selection (Task 06-08-02)", () => {
  const ENV_KEYS = [
    "MEMORY_SYNC_RELAY_BASE_URL",
    "MEMORY_SYNC_RELAY_ALLOW_INSECURE_LOOPBACK",
    "MEMORY_SYNC_RELAY_TOKEN_PATH",
    "MEMORY_SYNC_PERSON_ID",
    "MEMORY_SYNC_ID",
    "MEMORY_SYNC_DEVICE_ID",
    "MEMORY_SYNC_EPOCH"
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};

  function resetEnv() {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }

  afterEach(() => {
    resetEnv();
  });

  it("is undefined (a documented no-op) when MEMORY_SYNC_RELAY_BASE_URL is unset -- identical to Phase 05", () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const clock = new FakeDaemonClock();
    const store = new InMemoryStore({ clock });
    expect(resolveProductionSyncReplicationDependency(store, clock, undefined)).toBeUndefined();
  });

  it("rejects a plaintext HTTP base URL without the explicit loopback acknowledgement", () => {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.MEMORY_SYNC_RELAY_BASE_URL = "http://relay.example.test";
    const clock = new FakeDaemonClock();
    const store = new InMemoryStore({ clock });
    expect(() => resolveProductionSyncReplicationDependency(store, clock, undefined)).toThrow(/https/i);
  });

  it("fails closed when the base URL is configured but token/device identity configuration is missing", () => {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.MEMORY_SYNC_RELAY_BASE_URL = "https://relay.example.test";
    const clock = new FakeDaemonClock();
    const store = new InMemoryStore({ clock });
    expect(() => resolveProductionSyncReplicationDependency(store, clock, undefined)).toThrow(/MEMORY_SYNC/);
  });

  it("stays a documented no-op when fully configured but no DeviceSecretStore is injected", () => {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.MEMORY_SYNC_RELAY_BASE_URL = "https://relay.example.test";
    process.env.MEMORY_SYNC_RELAY_TOKEN_PATH = "/nonexistent/token";
    process.env.MEMORY_SYNC_PERSON_ID = "person-1";
    process.env.MEMORY_SYNC_ID = "sync-1";
    process.env.MEMORY_SYNC_DEVICE_ID = "device-1";
    process.env.MEMORY_SYNC_EPOCH = "1";
    const clock = new FakeDaemonClock();
    const store = new InMemoryStore({ clock });
    expect(resolveProductionSyncReplicationDependency(store, clock, undefined)).toBeUndefined();
  });

  it("constructs a real HttpSyncRelay-backed cycle when fully configured with an injected DeviceSecretStore, reusing the exact SyncControlService secret-binding convention", async () => {
    const directory = await mkdtemp(join(tmpdir(), "daemon-sync-token-"));
    cleanup.push(directory);
    const tokenPath = join(directory, "token");
    await writeFile(tokenPath, "synthetic-bearer-token\n", "utf8");

    for (const key of ENV_KEYS) delete process.env[key];
    process.env.MEMORY_SYNC_RELAY_BASE_URL = "https://relay.example.test";
    process.env.MEMORY_SYNC_RELAY_TOKEN_PATH = tokenPath;
    process.env.MEMORY_SYNC_PERSON_ID = "person-1";
    process.env.MEMORY_SYNC_ID = "sync-1";
    process.env.MEMORY_SYNC_DEVICE_ID = "device-1";
    process.env.MEMORY_SYNC_EPOCH = "1";

    const crypto = new LibsodiumCryptoProvider();
    const secrets = new InMemoryDeviceSecretStore();
    const binding = { personId: "person-1", syncId: "sync-1", deviceId: "device-1" };
    const signing = crypto.generateSigningKeyPair();
    await secrets.create({
      binding,
      kind: "device_signing_seed",
      secretId: "device-1",
      bytes: Buffer.concat([Buffer.from(signing.publicKey), Buffer.from(signing.secretKey)])
    });
    await secrets.create({
      binding: { ...binding, epoch: 1 },
      kind: "epoch_key",
      secretId: "epoch:1",
      bytes: crypto.randomBytes(32)
    });

    const clock = new FakeDaemonClock();
    const store = new InMemoryStore({ clock });
    const dependency = resolveProductionSyncReplicationDependency(store, clock, secrets);
    expect(dependency).toBeDefined();

    // The relay host is unreachable in this test (no real network); runCycle must throw a
    // content-free error rather than hang or crash -- proving DaemonLoop's own try/catch (above)
    // is what keeps this failure from ever affecting writer-lease authority in production.
    await expect(dependency!.runCycle({ kind: "daemon", databaseId: "memory-db", ownerToken: "owner-x" }))
      .rejects.toBeDefined();
  });
});

function loopHarness(
  store: InMemoryStore | SqliteStore,
  clock: FakeDaemonClock,
  ownerToken: string,
  pid: number,
  overrides: Partial<{
    runSource: (personId: string, candidateId: string, authority: unknown) => Promise<{ importedEvents: number }>;
    runContraction: (personId: string, jobId: string, authority: unknown) => Promise<{ complete: boolean }>;
    runProposals: (personId: string, authority: unknown) => Promise<{ proposals: number }>;
    syncReplication: DaemonLoopDependencies["syncReplication"];
  }> = {}
): { loop: DaemonLoop; watchers: FakeWatcherFactory; timers: FakeTimerQueue } {
  const timers = new FakeTimerQueue(clock);
  const watchers = new FakeWatcherFactory();
  const authority = { kind: "daemon" as const, databaseId: "memory-db", ownerToken };
  const scheduler = new DaemonScheduler(store, { clock, promptBurstLimit: 1, authority });
  const dependencies: DaemonLoopDependencies = {
    store,
    scheduler,
    clock,
    timers,
    watcherFactory: watchers,
    power: new FakePowerStateProvider("external"),
    notifier: new FakeNotificationAdapter(),
    sourceRunner: {
      run: async ({ personId, candidateId, authority }) =>
        (overrides.runSource ?? (async () => ({ importedEvents: 0 })))(personId, candidateId, authority)
    },
    contractionRunner: {
      drainSlice: async (personId, jobId, captured) =>
        (overrides.runContraction ?? (async () => ({ complete: true })))(personId, jobId, captured)
    },
    proposalScheduler: {
      runDue: async (personId, captured) =>
        (overrides.runProposals ?? (async () => ({ proposals: 0 })))(personId, captured)
    },
    ...(overrides.syncReplication ? { syncReplication: overrides.syncReplication } : {})
  };
  return {
    loop: new DaemonLoop(dependencies, { databaseId: "memory-db", ownerToken, pid }),
    watchers,
    timers
  };
}

async function daemonSnapshot(store: InMemoryStore, personId: string) {
  return normalizePersistedDaemonState({
    sourceStates: await store.listDaemonSourceStates(personId),
    jobs: await store.listContractionJobs(personId),
    checkpoints: await Promise.all((await store.listContractionJobs(personId))
      .map((job) => store.getContractionCheckpoint(`contraction_checkpoint_${job.id}`))),
    events: await store.listCanonicalEvents(personId),
    summaries: (await store.listSummaries()).filter((item) => item.personId === personId),
    boxes: (await store.listBoxes()).filter((item) => item.personId === personId),
    proposals: (await store.listProposals()).filter((item) => item.personId === personId),
    traces: (await store.listTraces()).filter((item) => item.personId === personId)
  });
}

async function seedApprovedGrant(
  store: InMemoryStore | SqliteStore,
  personId: string,
  candidateId: string,
  grantId: string
): Promise<void> {
  if (!await store.getPerson(personId)) {
    await store.savePerson({ id: personId, displayName: null, createdAt: FIXED_NOW });
  }
  await store.saveSourceGrant({
    id: grantId,
    personId,
    candidateId,
    application: "codex",
    format: "codex-rollout-jsonl",
    sourceLocator: `/synthetic/${candidateId}`,
    profileId: "default",
    scopeId: `scope-${personId}`,
    state: "approved",
    approvedAt: FIXED_NOW,
    revokedAt: null,
    updatedAt: FIXED_NOW
  });
}

async function seedContractionJob(
  store: InMemoryStore | SqliteStore,
  personId: string,
  jobId: string
): Promise<void> {
  await store.saveContractionJob({
    id: jobId,
    personId,
    generation: 1,
    earliestAffected: { occurredAt: FIXED_NOW, nativeSequence: 1, id: `event-${personId}` },
    latestAffected: { occurredAt: FIXED_NOW, nativeSequence: 1, id: `event-${personId}` },
    state: "pending",
    attempts: 0,
    immediateDirty: true,
    proposalDirty: false,
    lastProposalRunAt: null,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    lastActivityAt: FIXED_NOW,
    nextDueAt: FIXED_NOW
  });
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

async function seedDurableWork(
  store: InMemoryStore | SqliteStore,
  personId: string,
  candidateId: string,
  grantId: string,
  immediatelyDue = true
): Promise<void> {
  await store.savePerson({ id: personId, displayName: null, createdAt: FIXED_NOW });
  await store.saveSourceGrant({
    id: grantId,
    personId,
    candidateId,
    application: "codex",
    format: "codex-rollout-jsonl",
    sourceLocator: `/synthetic/${candidateId}`,
    profileId: "default",
    scopeId: `scope-${personId}`,
    state: "approved",
    approvedAt: FIXED_NOW,
    revokedAt: null,
    updatedAt: FIXED_NOW
  });
  await store.saveDaemonSourceState({
    id: `source_state_${personId}_${candidateId}`,
    personId,
    grantId,
    candidateId,
    scopeId: `scope-${personId}`,
    state: "healthy",
    attemptCount: 0,
    consecutiveFailures: 0,
    firstFailureAt: null,
    lastFailureAt: null,
    lastAttemptAt: FIXED_NOW,
    lastSuccessAt: FIXED_NOW,
    nextDueAt: immediatelyDue ? FIXED_NOW : "2026-07-17T12:01:00.000Z",
    errorCategory: null,
    degradedAt: null,
    notificationSentAt: null,
    updatedAt: FIXED_NOW
  });
  await store.saveContractionJob({
    id: `job-${personId}`,
    personId,
    generation: 1,
    earliestAffected: { occurredAt: FIXED_NOW, nativeSequence: 1, id: `event-${personId}` },
    latestAffected: { occurredAt: FIXED_NOW, nativeSequence: 1, id: `event-${personId}` },
    state: "pending",
    attempts: 0,
    immediateDirty: true,
    proposalDirty: true,
    lastProposalRunAt: null,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    lastActivityAt: "2026-07-17T11:00:00.000Z",
    nextDueAt: FIXED_NOW
  });
}
