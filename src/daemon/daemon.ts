import type { SourceGrant } from "../domain/source-lifecycle.js";
import type { MemoryStore } from "../storage/memory-store.js";
import type {
  DaemonClock,
  DaemonTimer,
  NotificationAdapter,
  PowerStateProvider,
  SignalAdapter,
  WatcherFactory
} from "./runtime-adapters.js";
import { DaemonScheduler } from "./scheduler.js";
import { WatchController } from "./watch-controller.js";
import {
  DEFAULT_DAEMON_DURATIONS,
  type DaemonErrorCategory,
  type DaemonWriteAuthority
} from "./types.js";

export interface DaemonLoopDependencies {
  store: MemoryStore;
  scheduler: DaemonScheduler;
  clock: DaemonClock;
  timers: DaemonTimer;
  watcherFactory: WatcherFactory;
  power: PowerStateProvider;
  notifier: NotificationAdapter;
  signals?: SignalAdapter;
  sourceRunner: {
    run(input: { personId: string; candidateId: string; authority: DaemonWriteAuthority }): Promise<unknown>;
  };
  contractionRunner: {
    drainSlice(personId: string, jobId: string, authority: DaemonWriteAuthority): Promise<{ complete?: boolean } | unknown>;
  };
  proposalScheduler: {
    runDue(personId: string, authority: DaemonWriteAuthority): Promise<unknown>;
  };
}

export interface DaemonLoopOptions {
  databaseId: string;
  ownerToken: string;
  pid: number;
  idlePollMs?: number;
  onceDerivationLimit?: number;
}

export interface DaemonRunResult {
  stopped: true;
  workItems?: number;
}

export interface DaemonOnceResult {
  scannedSources: number;
  contractionSlices: number;
  proposalRuns: number;
  remainingSources: number;
  remainingContractions: number;
  remainingProposals: number;
}

export class DaemonLoop {
  private leaseOwned = false;
  private leaseLost = false;
  private stopping = false;
  private initialized = false;
  private watchController: WatchController | null = null;
  private readonly people: string[] = [];
  private proposalCursor = 0;
  private signalListener: (() => void) | null = null;
  private heartbeatTimer: unknown | null = null;
  private heartbeatInFlight: Promise<void> | null = null;

  constructor(
    private readonly dependencies: DaemonLoopDependencies,
    private readonly options: DaemonLoopOptions
  ) {}

  async tick(): Promise<boolean> {
    return this.drainOne();
  }

  async drainOne(): Promise<boolean> {
    if (this.stopping || this.leaseLost) {
      await this.shutdown();
      return false;
    }
    await this.ensureStarted();
    if (await this.shouldStop()) {
      await this.shutdown();
      return false;
    }
    if (!await this.assertLeaseAuthority()) {
      await this.shutdown();
      return false;
    }
    const power = await this.safePowerState();
    if (!await this.reconcileSourcesAndWatches()) return false;
    if (!await this.guardSchedulerMutation(() => this.dependencies.scheduler.refreshDueSources(power))) return false;

    const item = await this.dependencies.scheduler.nextWork();
    let didWork = false;
    if (item?.kind === "source_scan") {
      if (!await this.assertLeaseAuthority()) return false;
      const authority = this.captureAuthority();
      didWork = true;
      const before = await this.sourceState(item.personId, item.candidateId);
      try {
        const outcome = await this.dependencies.sourceRunner.run({
          personId: item.personId,
          candidateId: item.candidateId,
          authority
        });
        const failed = isFailedOutcome(outcome);
        if (!await this.guardSchedulerMutation(() => this.dependencies.scheduler.completeWork(item, failed
          ? { ok: false, category: failed }
          : { ok: true }))) return false;
      } catch (error) {
        if (!await this.guardSchedulerMutation(() => this.dependencies.scheduler.completeWork(
          item,
          { ok: false, category: controlledCategory(error) }
        ))) return false;
      }
      await this.notifyIfNewEpisode(item.personId, item.candidateId, before?.notificationSentAt ?? null);
    } else if (item?.kind === "contraction") {
      if (!await this.assertLeaseAuthority()) return false;
      const authority = this.captureAuthority();
      didWork = true;
      try {
        const result = await this.dependencies.contractionRunner.drainSlice(item.personId, item.jobId, authority);
        const complete = !(result && typeof result === "object" && "complete" in result) || Boolean(result.complete);
        if (!await this.guardSchedulerMutation(() =>
          this.dependencies.scheduler.completeWork(item, { ok: true, complete }))) return false;
      } catch {
        if (!await this.guardSchedulerMutation(() =>
          this.dependencies.scheduler.completeWork(item, { ok: false, category: "storage_failure" }))) return false;
      }
    }

    // Proposal work is a separate review-only tier, but shares the same awaited writer turn.
    // Rotating the person on every drain gives it a finite service bound without coupling it to import.
    if (this.people.length > 0 && await this.assertLeaseAuthority()) {
      const personId = this.people[this.proposalCursor % this.people.length];
      let proposal: unknown;
      try {
        proposal = await this.dependencies.proposalScheduler.runDue(personId, this.captureAuthority());
      } catch {
        await this.loseAuthority();
        return false;
      }
      this.proposalCursor += 1;
      didWork = didWork || proposalRan(proposal);
    }
    return didWork;
  }

  async run(signal?: AbortSignal): Promise<DaemonRunResult> {
    await this.ensureStarted();
    let workItems = 0;
    const request = () => { this.stopping = true; };
    this.signalListener = request;
    this.dependencies.signals?.on("SIGINT", request);
    this.dependencies.signals?.on("SIGTERM", request);
    try {
      while (!this.stopping && !signal?.aborted) {
        if (await this.drainOne()) workItems += 1;
        else if (!this.stopping) await this.wait(this.options.idlePollMs ?? 250);
      }
      this.stopping = true;
      await this.shutdown();
      return { stopped: true, workItems };
    } finally {
      this.dependencies.signals?.off("SIGINT", request);
      this.dependencies.signals?.off("SIGTERM", request);
      this.signalListener = null;
      if (this.leaseOwned) await this.shutdown();
    }
  }

  async runOnce(): Promise<DaemonOnceResult> {
    await this.ensureStarted();
    let scannedSources = 0;
    let contractionSlices = 0;
    let proposalRuns = 0;
    try {
      if (!await this.reconcileSourcesAndWatches()) return await this.emptyOnceResult();
      for (const personId of this.people) {
        const states = await this.dependencies.store.listDaemonSourceStates(personId);
        // Once is an explicit bounded synchronization request. Snapshot each approved durable
        // source exactly once rather than waiting for a reconstructed future safety deadline.
        for (const state of states) {
          if (!await this.assertLeaseAuthority()) break;
          const authority = this.captureAuthority();
          try {
            const outcome = await this.dependencies.sourceRunner.run({ personId, candidateId: state.candidateId, authority });
            const failure = isFailedOutcome(outcome);
            if (!await this.guardSchedulerMutation(() => this.dependencies.scheduler.completeWork({
              kind: "source_scan",
              personId,
              candidateId: state.candidateId,
              stage: "import",
              urgency: "due"
            }, failure ? { ok: false, category: failure } : { ok: true }))) break;
            if (!failure) scannedSources += 1;
          } catch {
            // A failed source remains isolated; its durable retry state is serviced on the next continuous run.
            if (!await this.guardSchedulerMutation(() => this.dependencies.scheduler.completeWork({
              kind: "source_scan",
              personId,
              candidateId: state.candidateId,
              stage: "import",
              urgency: "due"
            }, { ok: false, category: "unknown" }))) break;
          }
        }
      }

      if (!await this.guardSchedulerMutation(async () =>
        this.dependencies.scheduler.refreshDueSources(await this.safePowerState()))) {
        return await this.emptyOnceResult();
      }
      const limit = Math.max(1, this.options.onceDerivationLimit ?? Math.max(4, this.people.length * 2));
      for (let index = 0; index < limit; index += 1) {
        const item = await this.dependencies.scheduler.nextWork();
        if (!item) break;
        if (item.kind === "contraction") {
          if (!await this.assertLeaseAuthority()) break;
          const authority = this.captureAuthority();
          try {
            const result = await this.dependencies.contractionRunner.drainSlice(item.personId, item.jobId, authority);
            const complete = !(result && typeof result === "object" && "complete" in result) || Boolean(result.complete);
            if (!await this.guardSchedulerMutation(() =>
              this.dependencies.scheduler.completeWork(item, { ok: true, complete }))) break;
            contractionSlices += 1;
          } catch {
            if (!await this.guardSchedulerMutation(() =>
              this.dependencies.scheduler.completeWork(item, { ok: false, category: "storage_failure" }))) break;
          }
        } else {
          // The due-source snapshot above already serviced source work for once mode.
          if (!await this.guardSchedulerMutation(() =>
            this.dependencies.scheduler.completeWork(item, { ok: true }))) break;
        }
      }
      for (const personId of this.people) {
        if (!await this.assertLeaseAuthority()) break;
        let result: unknown;
        try {
          result = await this.dependencies.proposalScheduler.runDue(personId, this.captureAuthority());
        } catch {
          await this.loseAuthority();
          break;
        }
        if (proposalRan(result)) proposalRuns += 1;
      }
      const remaining = await this.remainingCounts();
      return { scannedSources, contractionSlices, proposalRuns, ...remaining };
    } finally {
      await this.shutdown();
    }
  }

  async requestStop(): Promise<void> {
    this.stopping = true;
    if (this.leaseOwned) {
      await this.dependencies.store.requestDaemonStop(
        this.options.databaseId,
        this.options.ownerToken,
        this.dependencies.clock.now()
      );
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.leaseOwned) return;
    const lease = await this.dependencies.store.acquireDaemonLease({
      databaseId: this.options.databaseId,
      ownerToken: this.options.ownerToken,
      pid: this.options.pid,
      now: this.dependencies.clock.now()
    });
    if (!lease) throw new Error("Memory database already has a fresh daemon writer lease");
    this.leaseOwned = true;
    this.leaseLost = false;
    this.startHeartbeat();
    try {
      if (!this.initialized) await this.reconstruct();
    } catch (error) {
      this.latchLeaseLoss();
      await this.shutdown();
      throw error;
    }
  }

  private async reconstruct(): Promise<void> {
    this.people.splice(0);
    const people = await this.dependencies.store.listPeople();
    for (const person of people) {
      this.people.push(person.id);
      this.dependencies.scheduler.registerPerson(person.id);
    }
    this.watchController = new WatchController({
      timers: this.dependencies.timers,
      watcherFactory: this.dependencies.watcherFactory,
      enqueueWatchHint: (personId, candidateId) =>
        this.dependencies.scheduler.enqueueWatchHint(personId, candidateId)
    });
    await this.dependencies.scheduler.reconcileApprovedSources();
    this.watchController.sync(await this.approvedGrants());
    await this.dependencies.scheduler.reconstruct();
    this.initialized = true;
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== null || !this.leaseOwned || this.stopping || this.leaseLost) return;
    this.heartbeatTimer = this.dependencies.timers.setTimeout(async () => {
      this.heartbeatTimer = null;
      if (!this.leaseOwned || this.stopping || this.leaseLost) return;
      const renewal = this.renewHeartbeat();
      this.heartbeatInFlight = renewal;
      try {
        await renewal;
      } finally {
        if (this.heartbeatInFlight === renewal) this.heartbeatInFlight = null;
        this.startHeartbeat();
      }
    }, DEFAULT_DAEMON_DURATIONS.heartbeatMs);
  }

  private async renewHeartbeat(): Promise<void> {
    try {
      const lease = await this.dependencies.store.heartbeatDaemonLease(
        this.options.databaseId,
        this.options.ownerToken,
        this.dependencies.clock.now()
      );
      if (lease) return;
    } catch {
      // A renewal error is indistinguishable from lost writer authority. Fail closed;
      // the durable scheduler will reconstruct unfinished work under a fresh owner.
    }
    if (!this.leaseLost) {
      this.latchLeaseLoss();
    }
  }

  private async assertLeaseAuthority(): Promise<boolean> {
    if (this.heartbeatInFlight) await this.heartbeatInFlight;
    if (!this.leaseOwned || this.leaseLost || this.stopping) return false;
    const lease = await this.dependencies.store.getDaemonLease(this.options.databaseId);
    const fresh = lease !== null &&
      lease.ownerToken === this.options.ownerToken &&
      Date.parse(lease.expiresAt) > Date.parse(this.dependencies.clock.now());
    if (!fresh) this.latchLeaseLoss();
    return fresh;
  }

  private latchLeaseLoss(): void {
    this.leaseLost = true;
    this.leaseOwned = false;
    this.stopping = true;
  }

  private async shouldStop(): Promise<boolean> {
    if (this.stopping) return true;
    const lease = await this.dependencies.store.getDaemonLease(this.options.databaseId);
    if (!lease || lease.ownerToken !== this.options.ownerToken ||
      Date.parse(lease.expiresAt) <= Date.parse(this.dependencies.clock.now())) {
      this.latchLeaseLoss();
      return true;
    }
    return lease.stopRequestedAt !== null;
  }

  private async shutdown(): Promise<void> {
    this.stopping = true;
    if (this.heartbeatTimer !== null) this.dependencies.timers.clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.heartbeatInFlight) await this.heartbeatInFlight;
    this.watchController?.close();
    this.watchController = null;
    if (this.leaseOwned) {
      await this.dependencies.store.releaseDaemonLease(this.options.databaseId, this.options.ownerToken);
      this.leaseOwned = false;
    }
  }

  private async reconcileSourcesAndWatches(): Promise<boolean> {
    try {
      await this.dependencies.scheduler.reconcileApprovedSources();
      this.watchController?.sync(await this.approvedGrants());
      return true;
    } catch {
      await this.loseAuthority();
      return false;
    }
  }

  private captureAuthority(): DaemonWriteAuthority {
    return Object.freeze({
      kind: "daemon" as const,
      databaseId: this.options.databaseId,
      ownerToken: this.options.ownerToken
    });
  }

  private async guardSchedulerMutation(operation: () => Promise<unknown>): Promise<boolean> {
    try {
      await operation();
      return true;
    } catch {
      await this.loseAuthority();
      return false;
    }
  }

  private async loseAuthority(): Promise<void> {
    this.latchLeaseLoss();
    await this.shutdown();
  }

  private async emptyOnceResult(): Promise<DaemonOnceResult> {
    const remaining = await this.remainingCounts();
    return { scannedSources: 0, contractionSlices: 0, proposalRuns: 0, ...remaining };
  }

  private async approvedGrants(): Promise<SourceGrant[]> {
    const grants: SourceGrant[] = [];
    for (const personId of this.people) {
      grants.push(...(await this.dependencies.store.listSourceGrants(personId)).filter(approved));
    }
    return grants.sort((left, right) =>
      left.personId.localeCompare(right.personId) || left.candidateId.localeCompare(right.candidateId));
  }

  private async sourceState(personId: string, candidateId: string) {
    return (await this.dependencies.store.listDaemonSourceStates(personId))
      .find((state) => state.candidateId === candidateId) ?? null;
  }

  private async notifyIfNewEpisode(personId: string, candidateId: string, previous: string | null): Promise<void> {
    const state = await this.sourceState(personId, candidateId);
    if (!state?.notificationSentAt || state.notificationSentAt === previous || !state.degradedAt || !state.errorCategory) return;
    try {
      await this.dependencies.notifier.notify({
        title: "Memory source needs attention",
        body: `Configured source ${candidateId} is degraded (${state.errorCategory}, attempt ${state.consecutiveFailures}).`,
        sourceId: candidateId
      });
    } catch {
      // Best-effort operational hint; the persisted episode latch already prevents notification storms.
    }
  }

  private async safePowerState() {
    try { return await this.dependencies.power.getPowerState(); } catch { return "unknown" as const; }
  }

  private async remainingCounts(): Promise<Pick<DaemonOnceResult,
    "remainingSources" | "remainingContractions" | "remainingProposals">> {
    let remainingSources = 0;
    let remainingContractions = 0;
    let remainingProposals = 0;
    const now = Date.parse(this.dependencies.clock.now());
    for (const personId of this.people) {
      remainingSources += (await this.dependencies.store.listDaemonSourceStates(personId))
        .filter((state) => Date.parse(state.nextDueAt) <= now).length;
      const jobs = await this.dependencies.store.listContractionJobs(personId);
      remainingContractions += jobs.filter((job) => job.state === "pending" || job.state === "failed").length;
      remainingProposals += jobs.filter((job) => job.proposalDirty).length;
    }
    return { remainingSources, remainingContractions, remainingProposals };
  }

  private wait(delayMs: number): Promise<void> {
    return new Promise((resolve) => { this.dependencies.timers.setTimeout(resolve, delayMs); });
  }
}

function approved(grant: SourceGrant): boolean { return grant.state === "approved"; }

function isFailedOutcome(value: unknown): DaemonErrorCategory | null {
  if (!value || typeof value !== "object" || !("ok" in value) || value.ok !== false) return null;
  if ("category" in value && typeof value.category === "string") return value.category as DaemonErrorCategory;
  return "unknown";
}

function proposalRan(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if ("ran" in value) return value.ran === true;
  if ("proposals" in value && typeof value.proposals === "number") return value.proposals > 0;
  return false;
}

function controlledCategory(error: unknown): DaemonErrorCategory {
  if (error instanceof Error && "code" in error) {
    const code = String(error.code);
    if (code === "ENOENT") return "temporarily_absent";
    if (code === "EACCES" || code === "EPERM") return "permission_denied";
  }
  return "unknown";
}
