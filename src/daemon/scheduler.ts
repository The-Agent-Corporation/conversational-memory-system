import type { MemoryStore } from "../storage/memory-store.js";
import type { DaemonClock, PowerState } from "./runtime-adapters.js";
import { SourceStateMachine } from "./source-state.js";
import type {
  ContractionJob,
  DaemonErrorCategory,
  DaemonSourceState,
  DaemonWorkItem,
  DaemonWriteAuthority
} from "./types.js";

export type { DaemonWorkItem } from "./types.js";

export interface WorkCompletion {
  ok: boolean;
  category?: DaemonErrorCategory;
  complete?: boolean;
}

export interface DaemonSchedulerOptions {
  clock: Pick<DaemonClock, "now">;
  authority: DaemonWriteAuthority;
  sourceState?: SourceStateMachine;
  promptBurstLimit?: number;
  personIds?: readonly string[];
}

const RESCAN_MS: Record<PowerState, number> = {
  external: 60_000,
  unknown: 60_000,
  battery: 300_000
};

export class DaemonScheduler {
  private readonly prompt = new Map<string, DaemonWorkItem>();
  private readonly due: DaemonWorkItem[] = [];
  private readonly queued = new Set<string>();
  private readonly inFlight = new Set<string>();
  private readonly people = new Set<string>();
  private readonly sourceState: SourceStateMachine;
  private promptBurst = 0;

  constructor(private readonly store: MemoryStore, private readonly options: DaemonSchedulerOptions) {
    for (const personId of options.personIds ?? []) this.people.add(personId);
    this.sourceState = options.sourceState ?? new SourceStateMachine(store, {
      clock: options.clock,
      authority: options.authority
    });
  }

  registerPerson(personId: string): void {
    this.people.add(personId);
  }

  async reconstruct(): Promise<void> {
    this.prompt.clear();
    this.due.splice(0);
    this.queued.clear();
    this.inFlight.clear();
    this.promptBurst = 0;
    await this.refreshDueSources("unknown");
  }

  async reconcileApprovedSources(): Promise<void> {
    for (const personId of [...this.people].sort()) {
      const previous = await this.store.listDaemonSourceStates(personId);
      const states = await this.sourceState.reconcileApproved(personId);
      const activeCandidates = new Set(states.map((state) => state.candidateId));

      for (const [key, item] of this.prompt) {
        if (item.kind === "source_scan" && item.personId === personId && !activeCandidates.has(item.candidateId)) {
          this.prompt.delete(key);
          this.queued.delete(key);
        }
      }
      for (let index = this.due.length - 1; index >= 0; index -= 1) {
        const item = this.due[index];
        if (item.kind === "source_scan" && item.personId === personId) {
          this.due.splice(index, 1);
          this.queued.delete(this.key(item));
        }
      }
      const newlyDue: DaemonWorkItem[] = [];
      for (const state of states) {
        const existed = previous.some((candidate) =>
          candidate.grantId === state.grantId &&
          candidate.personId === state.personId &&
          candidate.candidateId === state.candidateId &&
          candidate.scopeId === state.scopeId
        );
        if (!existed) {
          newlyDue.push({
            kind: "source_scan",
            personId: state.personId,
            candidateId: state.candidateId,
            stage: "import",
            urgency: "due"
          });
        }
      }
      for (const item of newlyDue) this.enqueueDue(item);
    }
  }

  async enqueueWatchHint(personId: string, candidateId: string): Promise<void> {
    this.people.add(personId);
    const item: DaemonWorkItem = { kind: "source_scan", personId, candidateId, stage: "import", urgency: "prompt" };
    const key = this.key(item);
    if (this.inFlight.has(key) || this.prompt.has(key)) return;
    const dueIndex = this.due.findIndex((candidate) => this.key(candidate) === key);
    if (dueIndex >= 0) this.due.splice(dueIndex, 1);
    this.prompt.set(key, item);
    this.queued.add(key);
  }

  async refreshDueSources(power: PowerState): Promise<void> {
    await this.reconcileApprovedSources();
    const nowMs = Date.parse(this.options.clock.now());
    for (const personId of [...this.people].sort()) {
      const states = await this.store.listDaemonSourceStates(personId);
      const nextStates = states.map((state) => {
        const dueAt = this.dueAt(state, power);
        return state.state === "healthy" && state.nextDueAt !== new Date(dueAt).toISOString()
          ? { ...state, nextDueAt: new Date(dueAt).toISOString() }
          : state;
      });
      await this.store.commitDueSourceRefresh({
        authority: this.options.authority,
        personId,
        expectedStates: states,
        nextStates
      });
      for (const state of nextStates) {
        const dueAt = this.dueAt(state, power);
        if (dueAt <= nowMs) this.enqueueDue({
          kind: "source_scan",
          personId: state.personId,
          candidateId: state.candidateId,
          stage: "import",
          urgency: "due"
        });
      }
      const jobs = await this.store.listContractionJobs(personId);
      for (const job of jobs) {
        if ((job.state === "pending" || job.state === "failed") && Date.parse(job.nextDueAt) <= nowMs) {
          this.enqueueDue({ kind: "contraction", personId, jobId: job.id, stage: "contraction", urgency: "due" });
        }
      }
    }
  }

  async nextWork(): Promise<DaemonWorkItem | null> {
    const promptLimit = Math.max(1, this.options.promptBurstLimit ?? 1);
    let next: DaemonWorkItem | undefined;
    if (this.prompt.size > 0 && (this.promptBurst < promptLimit || this.due.length === 0)) {
      const entry = this.prompt.entries().next().value as [string, DaemonWorkItem] | undefined;
      if (entry) {
        this.prompt.delete(entry[0]);
        next = entry[1];
        this.promptBurst += 1;
      }
    } else if (this.due.length > 0) {
      next = this.due.shift();
      this.promptBurst = 0;
    }
    if (!next) return null;
    const key = this.key(next);
    this.queued.delete(key);
    this.inFlight.add(key);
    return next;
  }

  async completeWork(item: DaemonWorkItem, result: WorkCompletion): Promise<void> {
    if (item.kind === "source_scan") {
      if (result.ok) await this.sourceState.recordSuccess(item.personId, item.candidateId);
      else await this.sourceState.recordFailure(item.personId, item.candidateId, result.category ?? "unknown");
      this.inFlight.delete(this.key(item));
      return;
    }
    const job = await this.store.getContractionJob(item.jobId);
    if (!job || job.personId !== item.personId) throw new Error("Contraction work ownership mismatch");
    const now = this.options.clock.now();
    const next: ContractionJob = result.ok
      ? result.complete === false
        ? { ...job, state: "pending", nextDueAt: now, updatedAt: now }
        : { ...job, state: "complete", nextDueAt: now, updatedAt: now }
      : { ...job, state: "failed", attempts: job.attempts + 1, nextDueAt: now, updatedAt: now };
    await this.store.commitDaemonWorkOutcome({
      authority: this.options.authority,
      personId: item.personId,
      jobId: item.jobId,
      expectedJob: job,
      nextJob: next
    });
    this.inFlight.delete(this.key(item));
  }

  private enqueueDue(item: DaemonWorkItem): void {
    const key = this.key(item);
    if (this.queued.has(key) || this.inFlight.has(key)) return;
    this.due.push(item);
    this.queued.add(key);
  }

  private dueAt(state: DaemonSourceState, power: PowerState): number {
    if (state.state !== "healthy") return Date.parse(state.nextDueAt);
    // A reconciled grant has never run and is immediately due. Cadence begins only
    // after the first recorded attempt/success, not from the enrollment timestamp.
    if (state.lastSuccessAt === null && state.lastAttemptAt === null) return Date.parse(state.nextDueAt);
    const base = state.lastSuccessAt ?? state.lastAttemptAt ?? state.updatedAt;
    return Date.parse(base) + RESCAN_MS[power];
  }

  private key(item: DaemonWorkItem): string {
    return item.kind === "source_scan"
      ? `${item.personId}\u0000${item.candidateId}\u0000${item.stage}`
      : `${item.personId}\u0000${item.jobId}\u0000${item.stage}`;
  }
}
