import { describe, expect, it } from "vitest";
import { DaemonScheduler } from "../../src/daemon/scheduler.js";
import { daemonSourceStateId, SourceStateMachine } from "../../src/daemon/source-state.js";
import { WatchController, WATCH_DEBOUNCE_MS } from "../../src/daemon/watch-controller.js";
import type { DaemonWorkItem } from "../../src/daemon/types.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import {
  FIXED_NOW,
  FakeDaemonClock,
  FakeNotificationAdapter,
  FakePowerStateProvider,
  FakeTimerQueue,
  FakeWatcherFactory,
  createSyntheticApprovedSources
} from "./fixtures.js";

describe("WatchController", () => {
  it("coalesces each person/candidate burst for exactly two seconds and only enqueues a hint", async () => {
    const sources = await createSyntheticApprovedSources();
    const clock = new FakeDaemonClock();
    const timers = new FakeTimerQueue(clock);
    const watchers = new FakeWatcherFactory();
    const hints: Array<[string, string]> = [];
    const controller = new WatchController({
      timers,
      watcherFactory: watchers,
      enqueueWatchHint: (personId, candidateId) => {
        hints.push([personId, candidateId]);
      }
    });
    controller.watch(sources.codex.grant);

    watchers.emit(sources.codex.rootPath);
    watchers.emit(sources.codex.rootPath);
    await timers.advanceBy(WATCH_DEBOUNCE_MS - 1);
    expect(hints).toEqual([]);
    watchers.emit(sources.codex.rootPath);
    await timers.advanceBy(1);
    expect(hints).toEqual([[sources.codex.grant.personId, sources.codex.grant.candidateId]]);
    expect(WATCH_DEBOUNCE_MS).toBe(2_000);

    controller.close();
    expect(watchers.closedPaths).toEqual([sources.codex.rootPath]);
    await sources.cleanup();
  });

  it("treats watcher capability loss as advisory and leaves safety scans authoritative", async () => {
    const store = new InMemoryStore();
    const clock = new FakeDaemonClock();
    await seedSourceState(store, "source-a", clock.now());
    const scheduler = await createScheduler(store, { clock, personIds: ["person_daemon"] });
    await scheduler.reconstruct();

    clock.advanceBy(60_000);
    await scheduler.refreshDueSources("unknown");
    expect(await scheduler.nextWork()).toMatchObject({ kind: "source_scan", candidateId: "source-a" });
  });
});

describe("DaemonScheduler", () => {
  it("rejects stale source completion without durable or ephemeral turnover mutation and replays under the replacement owner", async () => {
    const clock = new FakeDaemonClock();
    const store = new InMemoryStore({ clock });
    await seedSourceState(store, "source-turnover", new Date(Date.parse(clock.now()) - 60_000).toISOString());
    await store.acquireDaemonLease({
      databaseId: "memory-db",
      ownerToken: "token-a",
      pid: 101,
      now: clock.now()
    });
    const authorityA = { kind: "daemon" as const, databaseId: "memory-db", ownerToken: "token-a" };
    const schedulerA = new DaemonScheduler(store, {
      clock,
      authority: authorityA,
      personIds: ["person_daemon"]
    });
    await schedulerA.reconstruct();
    await schedulerA.refreshDueSources("external");
    const selected = await schedulerA.nextWork();
    expect(selected).toMatchObject({ kind: "source_scan", candidateId: "source-turnover" });

    await store.releaseDaemonLease("memory-db", "token-a");
    await store.acquireDaemonLease({
      databaseId: "memory-db",
      ownerToken: "token-b",
      pid: 102,
      now: clock.now()
    });
    const before = await store.listDaemonSourceStates("person_daemon");

    await expect(schedulerA.completeWork(selected!, { ok: true })).rejects.toThrow(/authority|lease|owner/i);
    expect(await store.listDaemonSourceStates("person_daemon")).toEqual(before);
    expect(await schedulerA.nextWork()).toBeNull();

    const schedulerB = new DaemonScheduler(store, {
      clock,
      authority: { kind: "daemon", databaseId: "memory-db", ownerToken: "token-b" },
      personIds: ["person_daemon"]
    });
    await schedulerB.reconstruct();
    const replay = await schedulerB.nextWork();
    expect(replay).toMatchObject({ kind: "source_scan", candidateId: "source-turnover" });
    await schedulerB.completeWork(replay!, { ok: true });
    expect(await store.listDaemonSourceStates("person_daemon")).toMatchObject([
      { candidateId: "source-turnover", state: "healthy", lastSuccessAt: clock.now() }
    ]);
  });

  it.each([
    ["failure", { ok: false as const, category: "permission_denied" as const }],
    ["entering-degraded", { ok: false as const, category: "storage_failure" as const }]
  ])("rejects stale %s health and notification-latch outcomes", async (_case, outcome) => {
    const clock = new FakeDaemonClock();
    const store = new InMemoryStore({ clock });
    const notifications = new FakeNotificationAdapter();
    await seedSourceState(store, "source-health", new Date(Date.parse(clock.now()) - 60_000).toISOString());
    if (_case === "entering-degraded") {
      const current = (await store.listDaemonSourceStates("person_daemon"))[0]!;
      await store.saveDaemonSourceState({
        ...current,
        state: "retrying",
        consecutiveFailures: 2,
        firstFailureAt: clock.now(),
        lastFailureAt: clock.now(),
        errorCategory: "storage_failure"
      });
    }
    await store.acquireDaemonLease({ databaseId: "memory-db", ownerToken: "health-a", pid: 201, now: clock.now() });
    const authorityA = { kind: "daemon" as const, databaseId: "memory-db", ownerToken: "health-a" };
    const machine = new SourceStateMachine(store, { clock, authority: authorityA, jitter: () => 0, notifications });
    const scheduler = new DaemonScheduler(store, {
      clock,
      authority: authorityA,
      sourceState: machine,
      personIds: ["person_daemon"]
    });
    await scheduler.reconstruct();
    const selected = await scheduler.nextWork();
    expect(selected).not.toBeNull();
    await store.releaseDaemonLease("memory-db", "health-a");
    await store.acquireDaemonLease({ databaseId: "memory-db", ownerToken: "health-b", pid: 202, now: clock.now() });
    const before = await store.listDaemonSourceStates("person_daemon");

    await expect(scheduler.completeWork(selected!, outcome)).rejects.toThrow(/authority|lease/i);
    expect(await store.listDaemonSourceStates("person_daemon")).toEqual(before);
    expect(notifications.calls).toEqual([]);
  });

  it("guards reconciliation, next-due refresh, contraction outcome, and foreground authority", async () => {
    const clock = new FakeDaemonClock();
    const store = new InMemoryStore({ clock });
    await seedGrant(store, "source-a", "approved");
    await store.acquireDaemonLease({ databaseId: "memory-db", ownerToken: "guard-a", pid: 301, now: clock.now() });
    const schedulerA = new DaemonScheduler(store, {
      clock,
      authority: { kind: "daemon", databaseId: "memory-db", ownerToken: "guard-a" },
      personIds: ["person_daemon"]
    });
    await schedulerA.reconstruct();
    await store.saveContractionJob(contractionJob("job-turnover"));
    await store.releaseDaemonLease("memory-db", "guard-a");
    await store.acquireDaemonLease({ databaseId: "memory-db", ownerToken: "guard-b", pid: 302, now: clock.now() });
    const sourceBefore = await store.listDaemonSourceStates("person_daemon");
    const jobBefore = await store.getContractionJob("job-turnover");

    await expect(schedulerA.reconcileApprovedSources()).rejects.toThrow(/authority|lease/i);
    await expect(schedulerA.refreshDueSources("battery")).rejects.toThrow(/authority|lease/i);
    await schedulerA.enqueueWatchHint("person_daemon", "source-a");
    const source = await schedulerA.nextWork();
    await expect(schedulerA.completeWork(source!, { ok: true })).rejects.toThrow(/authority|lease/i);
    const contraction: DaemonWorkItem = {
      kind: "contraction",
      personId: "person_daemon",
      jobId: "job-turnover",
      stage: "contraction",
      urgency: "due"
    };
    await expect(schedulerA.completeWork(contraction, { ok: true })).rejects.toThrow(/authority|lease/i);
    expect(await store.listDaemonSourceStates("person_daemon")).toEqual(sourceBefore);
    expect(await store.getContractionJob("job-turnover")).toEqual(jobBefore);

    const foreground = new SourceStateMachine(store, {
      clock,
      authority: { kind: "foreground", personId: "person_daemon", operation: "historical-bootstrap" } as never
    });
    await expect(foreground.recordSuccess("person_daemon", "source-a")).rejects.toThrow(/daemon|authority|kind/i);
  });

  it("enrolls grants-only state for explicitly registered people during reconstruction", async () => {
    const store = new InMemoryStore();
    const clock = new FakeDaemonClock();
    await seedGrant(store, "source-a", "approved");
    await seedGrant(store, "source-revoked", "revoked");
    await seedGrant(store, "source-other", "approved", "person_other");
    const scheduler = await createScheduler(store, { clock, personIds: ["person_daemon"] });

    await scheduler.reconstruct();

    await expect(store.listDaemonSourceStates("person_daemon")).resolves.toEqual([
      expect.objectContaining({
        id: daemonSourceStateId("person_daemon", "source-a"),
        grantId: "grant_source-a",
        candidateId: "source-a",
        state: "healthy"
      })
    ]);
    await expect(store.listDaemonSourceStates("person_other")).resolves.toEqual([]);
    expect(await scheduler.nextWork()).toMatchObject({
      kind: "source_scan",
      personId: "person_daemon",
      candidateId: "source-a",
      urgency: "due"
    });
    expect(JSON.stringify(await store.listDaemonSourceStates("person_daemon")))
      .not.toMatch(/sourceLocator|synthetic\/source-a|content|errorMessage/);
  });

  it("reconciles newly approved and revoked grants on the next safety rescan", async () => {
    const store = new InMemoryStore();
    const clock = new FakeDaemonClock();
    await seedGrant(store, "source-a", "approved");
    const scheduler = await createScheduler(store, { clock, personIds: ["person_daemon"] });
    await scheduler.reconstruct();
    const initial = await scheduler.nextWork();
    await scheduler.completeWork(initial!, { ok: true });

    await seedGrant(store, "source-a", "revoked");
    await seedGrant(store, "source-b", "approved");
    await scheduler.refreshDueSources("external");

    await expect(store.listDaemonSourceStates("person_daemon")).resolves.toEqual([
      expect.objectContaining({ candidateId: "source-b", grantId: "grant_source-b" })
    ]);
    expect(await scheduler.nextWork()).toMatchObject({ candidateId: "source-b", urgency: "due" });
    expect(await scheduler.nextWork()).toBeNull();
  });

  it("uses 60-second external/unknown and 300-second battery safety rescans without delaying watch work", async () => {
    const store = new InMemoryStore();
    const clock = new FakeDaemonClock();
    const power = new FakePowerStateProvider("external");
    await seedSourceState(store, "source-a", clock.now());
    const scheduler = await createScheduler(store, { clock, personIds: ["person_daemon"] });
    await scheduler.reconstruct();

    clock.advanceBy(59_999);
    await scheduler.refreshDueSources(await power.getPowerState());
    expect(await scheduler.nextWork()).toBeNull();
    clock.advanceBy(1);
    await scheduler.refreshDueSources("external");
    expect(await scheduler.nextWork()).toMatchObject({ candidateId: "source-a" });

    await scheduler.completeWork(work("source-a"), { ok: true });
    power.setPowerState("battery");
    clock.advanceBy(299_999);
    await scheduler.refreshDueSources(await power.getPowerState());
    expect(await scheduler.nextWork()).toBeNull();
    await scheduler.enqueueWatchHint("person_daemon", "source-a");
    expect(await scheduler.nextWork()).toMatchObject({ candidateId: "source-a", urgency: "prompt" });

    await scheduler.completeWork(work("source-a", "prompt"), { ok: true });
    power.setPowerState("external");
    clock.advanceBy(60_000);
    await scheduler.refreshDueSources(await power.getPowerState());
    expect(await scheduler.nextWork()).toMatchObject({ candidateId: "source-a" });
  });

  it("serves at most one prompt job before forcing round-robin due work, including contraction", async () => {
    const store = new InMemoryStore();
    const clock = new FakeDaemonClock();
    for (const id of ["source-a", "source-b", "source-c"]) await seedSourceState(store, id, clock.now());
    await store.saveContractionJob({
      id: "job-person-daemon",
      personId: "person_daemon",
      generation: 1,
      earliestAffected: { occurredAt: FIXED_NOW, nativeSequence: 1, id: "event-1" },
      latestAffected: { occurredAt: FIXED_NOW, nativeSequence: 1, id: "event-1" },
      state: "pending",
      attempts: 0,
      immediateDirty: true,
      proposalDirty: true,
      lastProposalRunAt: null,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      lastActivityAt: FIXED_NOW,
      nextDueAt: FIXED_NOW
    });
    const scheduler = await createScheduler(store, {
      clock,
      promptBurstLimit: 1,
      personIds: ["person_daemon"]
    });
    await scheduler.reconstruct();
    clock.advanceBy(60_000);
    await scheduler.refreshDueSources("external");

    const selected: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      await scheduler.enqueueWatchHint("person_daemon", "source-a");
      const next = await scheduler.nextWork();
      expect(next).not.toBeNull();
      selected.push(next!.kind === "contraction" ? "contraction" : next!.candidateId);
      await scheduler.completeWork(next!, { ok: true });
      await scheduler.refreshDueSources("external");
    }

    expect(selected.slice(0, 6)).toEqual(expect.arrayContaining(["source-a", "source-b", "source-c", "contraction"]));
    expect(maximumGap(selected, "source-b")).toBeLessThanOrEqual(6);
    expect(maximumGap(selected, "source-c")).toBeLessThanOrEqual(6);
  });

  it("deduplicates hot hints by person, candidate, and stage", async () => {
    const store = new InMemoryStore();
    const scheduler = await createScheduler(store, { clock: new FakeDaemonClock() });
    await scheduler.reconstruct();
    await scheduler.enqueueWatchHint("person_daemon", "source-a");
    await scheduler.enqueueWatchHint("person_daemon", "source-a");
    await scheduler.enqueueWatchHint("person_daemon", "source-a");
    expect(await scheduler.nextWork()).toMatchObject({ candidateId: "source-a", urgency: "prompt" });
    expect(await scheduler.nextWork()).toBeNull();
  });
});

describe("SourceStateMachine", () => {
  it("exposes the sole exact-grant enrollment seam", async () => {
    const store = new InMemoryStore();
    const clock = new FakeDaemonClock();
    await seedGrant(store, "source-a", "approved");
    const machine = await createSourceMachine(store, { clock });

    await expect(machine.reconcileApproved("person_daemon")).resolves.toEqual([
      expect.objectContaining({
        id: daemonSourceStateId("person_daemon", "source-a"),
        candidateId: "source-a",
        nextDueAt: FIXED_NOW
      })
    ]);
  });

  it("retries at 5, 10, 20, 40, and capped 60 seconds, then resets on success", async () => {
    const store = new InMemoryStore();
    const clock = new FakeDaemonClock();
    const machine = await createSourceMachine(store, { clock, jitter: () => 0 });
    await seedSourceState(store, "source-a", clock.now());
    const delays: number[] = [];

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const state = await machine.recordFailure("person_daemon", "source-a", "storage_failure");
      delays.push(Date.parse(state.nextDueAt) - Date.parse(clock.now()));
    }
    expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);

    const healthy = await machine.recordSuccess("person_daemon", "source-a");
    expect(healthy).toMatchObject({ state: "healthy", consecutiveFailures: 0 });
    const nextFailure = await machine.recordFailure("person_daemon", "source-a", "temporarily_absent");
    expect(Date.parse(nextFailure.nextDueAt) - Date.parse(clock.now())).toBe(5_000);
  });

  it("degrades at the third failure and notifies only once until a success", async () => {
    const store = new InMemoryStore();
    const clock = new FakeDaemonClock();
    const notifications = new FakeNotificationAdapter();
    const machine = await createSourceMachine(store, { clock, jitter: () => 0, notifications });
    await seedSourceState(store, "source-a", clock.now());

    await machine.recordFailure("person_daemon", "source-a", "permission_denied", new Error("SECRET transcript"));
    await machine.recordFailure("person_daemon", "source-a", "permission_denied", new Error("SECRET transcript"));
    const degraded = await machine.recordFailure(
      "person_daemon",
      "source-a",
      "permission_denied",
      new Error("SECRET transcript")
    );
    await machine.recordFailure("person_daemon", "source-a", "unknown", new Error("API_KEY=secret"));

    expect(degraded.state).toBe("degraded");
    expect(notifications.calls).toHaveLength(1);
    expect(JSON.stringify(notifications.calls)).not.toMatch(/SECRET|transcript|API_KEY|permission_denied/);

    await machine.recordSuccess("person_daemon", "source-a");
    await machine.recordFailure("person_daemon", "source-a", "unknown");
    await machine.recordFailure("person_daemon", "source-a", "unknown");
    await machine.recordFailure("person_daemon", "source-a", "unknown");
    expect(notifications.calls).toHaveLength(2);
  });

  it("also degrades after fifteen elapsed minutes and persists content-free health", async () => {
    const store = new InMemoryStore();
    const clock = new FakeDaemonClock();
    const machine = await createSourceMachine(store, { clock, jitter: () => 0 });
    await seedSourceState(store, "source-a", clock.now());
    await machine.recordFailure("person_daemon", "source-a", "unknown", new Error("client transcript text"));
    clock.advanceBy(15 * 60_000);
    const degraded = await machine.recordFailure(
      "person_daemon",
      "source-a",
      "unknown",
      new Error("password=hunter2 /Users/private/history.jsonl")
    );

    expect(degraded.state).toBe("degraded");
    const durable = JSON.stringify(await store.listDaemonSourceStates("person_daemon"));
    expect(durable).not.toMatch(/client transcript|hunter2|Users\/private|history\.jsonl/);
    expect(durable).toContain("unknown");
  });

  it("isolates one failed source while another source remains selectable", async () => {
    const store = new InMemoryStore();
    const clock = new FakeDaemonClock();
    await seedSourceState(store, "source-a", clock.now());
    await seedSourceState(store, "source-b", clock.now());
    const machine = await createSourceMachine(store, { clock, jitter: () => 0 });
    const scheduler = await createScheduler(store, {
      clock,
      sourceState: machine,
      personIds: ["person_daemon"]
    });
    await scheduler.reconstruct();
    clock.advanceBy(60_000);
    await scheduler.refreshDueSources("external");

    const first = await scheduler.nextWork();
    await scheduler.completeWork(first!, { ok: false, category: "storage_failure" });
    const second = await scheduler.nextWork();
    expect(second?.candidateId).not.toBe(first?.candidateId);
    await expect(scheduler.completeWork(second!, { ok: true })).resolves.toBeUndefined();
  });
});

function work(candidateId: string, urgency: "prompt" | "due" = "due"): DaemonWorkItem {
  return { kind: "source_scan", personId: "person_daemon", candidateId, stage: "import", urgency };
}

function contractionJob(id: string) {
  return {
    id,
    personId: "person_daemon",
    generation: 1,
    earliestAffected: { occurredAt: FIXED_NOW, nativeSequence: 1, id: "event-1" },
    latestAffected: { occurredAt: FIXED_NOW, nativeSequence: 1, id: "event-1" },
    state: "pending" as const,
    attempts: 0,
    immediateDirty: true,
    proposalDirty: false,
    lastProposalRunAt: null,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    lastActivityAt: FIXED_NOW,
    nextDueAt: FIXED_NOW
  };
}

async function seedSourceState(store: InMemoryStore, candidateId: string, lastSuccessAt: string): Promise<void> {
  await seedGrant(store, candidateId, "approved", "person_daemon", lastSuccessAt);
  await store.saveDaemonSourceState({
    id: `source_state_person_daemon_${candidateId}`,
    personId: "person_daemon",
    grantId: `grant_${candidateId}`,
    candidateId,
    scopeId: "scope_daemon",
    state: "healthy",
    attemptCount: 0,
    consecutiveFailures: 0,
    firstFailureAt: null,
    lastFailureAt: null,
    lastAttemptAt: lastSuccessAt,
    lastSuccessAt,
    nextDueAt: new Date(Date.parse(lastSuccessAt) + 60_000).toISOString(),
    errorCategory: null,
    degradedAt: null,
    notificationSentAt: null,
    updatedAt: lastSuccessAt
  });
}

async function seedGrant(
  store: InMemoryStore,
  candidateId: string,
  state: "approved" | "revoked",
  personId = "person_daemon",
  updatedAt = FIXED_NOW
): Promise<void> {
  await store.saveSourceGrant({
    id: `grant_${candidateId}`,
    personId,
    candidateId,
    application: "synthetic",
    format: "synthetic-jsonl",
    sourceLocator: `/synthetic/${candidateId}`,
    profileId: "default",
    scopeId: "scope_daemon",
    state,
    approvedAt: FIXED_NOW,
    revokedAt: state === "revoked" ? updatedAt : null,
    updatedAt
  });
}

function maximumGap(values: string[], needle: string): number {
  const positions = values.flatMap((value, index) => value === needle ? [index] : []);
  if (positions.length === 0) return values.length;
  const gaps = [positions[0] + 1, values.length - positions[positions.length - 1]];
  gaps.push(...positions.slice(1).map((value, index) => value - positions[index]));
  return Math.max(...gaps);
}

const TEST_AUTHORITY = { kind: "daemon" as const, databaseId: "scheduler-test-db", ownerToken: "scheduler-test-owner" };

async function ensureTestAuthority(store: InMemoryStore): Promise<void> {
  if (await store.getDaemonLease(TEST_AUTHORITY.databaseId)) return;
  const now = new Date().toISOString();
  const lease = await store.acquireDaemonLease({
    databaseId: TEST_AUTHORITY.databaseId,
    ownerToken: TEST_AUTHORITY.ownerToken,
    pid: 1,
    now
  });
  if (!lease) throw new Error("Failed to acquire synthetic scheduler test authority");
}

async function createScheduler(
  store: InMemoryStore,
  options: Omit<ConstructorParameters<typeof DaemonScheduler>[1], "authority">
): Promise<DaemonScheduler> {
  await ensureTestAuthority(store);
  return new DaemonScheduler(store, { ...options, authority: TEST_AUTHORITY });
}

async function createSourceMachine(
  store: InMemoryStore,
  options: Omit<ConstructorParameters<typeof SourceStateMachine>[1], "authority">
): Promise<SourceStateMachine> {
  await ensureTestAuthority(store);
  return new SourceStateMachine(store, { ...options, authority: TEST_AUTHORITY });
}
