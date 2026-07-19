import type { MemoryStore } from "../storage/memory-store.js";
import type { SourceGrant } from "../domain/source-lifecycle.js";
import type { DaemonErrorCategory, DaemonSourceState, DaemonWriteAuthority } from "./types.js";
import { DaemonSourceStateSchema } from "./types.js";
import type { DaemonClock, NotificationAdapter } from "./runtime-adapters.js";

const BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const;
const DEGRADE_AFTER_MS = 15 * 60_000;

export function daemonSourceStateId(personId: string, candidateId: string): string {
  return `source_state_${personId}_${candidateId}`;
}

export function daemonSourceStateFromGrant(grant: SourceGrant, now: string): DaemonSourceState {
  return DaemonSourceStateSchema.parse({
    id: daemonSourceStateId(grant.personId, grant.candidateId),
    personId: grant.personId,
    grantId: grant.id,
    candidateId: grant.candidateId,
    scopeId: grant.scopeId,
    state: "healthy",
    nextDueAt: now,
    attemptCount: 0,
    consecutiveFailures: 0,
    lastAttemptAt: null,
    lastSuccessAt: null,
    firstFailureAt: null,
    lastFailureAt: null,
    errorCategory: null,
    degradedAt: null,
    notificationSentAt: null,
    updatedAt: now
  });
}

export interface SourceStateMachineOptions {
  clock: Pick<DaemonClock, "now">;
  authority: DaemonWriteAuthority;
  jitter?: (baseDelayMs: number, consecutiveFailures: number) => number;
  notifications?: NotificationAdapter;
}

export class SourceStateMachine {
  constructor(
    private readonly store: MemoryStore,
    private readonly options: SourceStateMachineOptions
  ) {}

  async reconcileApproved(personId: string): Promise<DaemonSourceState[]> {
    const [grants, expectedStates] = await Promise.all([
      this.store.listSourceGrants(personId),
      this.store.listDaemonSourceStates(personId)
    ]);
    const expectedGrants = grants
      .filter((grant) => grant.state === "approved")
      .map((grant) => ({
        id: grant.id,
        personId: grant.personId,
        candidateId: grant.candidateId,
        updatedAt: grant.updatedAt,
        scopeId: grant.scopeId,
        state: "approved" as const
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    const byGrant = new Map(expectedStates.map((state) => [state.grantId, state]));
    const now = this.options.clock.now();
    const nextStates = expectedGrants.map((grant) => {
      const current = byGrant.get(grant.id);
      return current && current.personId === grant.personId &&
        current.candidateId === grant.candidateId && current.scopeId === grant.scopeId
        ? current
        : daemonSourceStateFromGrant(grants.find((candidate) => candidate.id === grant.id)!, now);
    });
    return this.store.commitApprovedGrantReconciliation({
      authority: this.options.authority,
      personId,
      expectedGrants,
      expectedStates,
      nextStates
    });
  }

  async recordAttempt(personId: string, candidateId: string): Promise<DaemonSourceState> {
    const current = await this.requireState(personId, candidateId);
    const now = this.options.clock.now();
    const next = { ...current, attemptCount: current.attemptCount + 1, lastAttemptAt: now, updatedAt: now };
    return this.commitOutcome(current, next);
  }

  async recordFailure(
    personId: string,
    candidateId: string,
    category: DaemonErrorCategory,
    _cause?: unknown
  ): Promise<DaemonSourceState> {
    const current = await this.requireState(personId, candidateId);
    const now = this.options.clock.now();
    const failures = current.consecutiveFailures + 1;
    const firstFailureAt = current.firstFailureAt ?? now;
    const baseDelay = BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)];
    const jitter = this.options.jitter?.(baseDelay, failures) ?? 0;
    const delay = Math.max(0, Math.min(60_000, baseDelay + jitter));
    const degraded = failures >= 3 || Date.parse(now) - Date.parse(firstFailureAt) >= DEGRADE_AFTER_MS;
    const enteringDegraded = degraded && current.state !== "degraded";
    const next: DaemonSourceState = {
      ...current,
      state: degraded ? "degraded" : "retrying",
      attemptCount: current.attemptCount + 1,
      consecutiveFailures: failures,
      firstFailureAt,
      lastFailureAt: now,
      lastAttemptAt: now,
      nextDueAt: new Date(Date.parse(now) + delay).toISOString(),
      errorCategory: category,
      degradedAt: degraded ? current.degradedAt ?? now : null,
      notificationSentAt: enteringDegraded ? now : current.notificationSentAt,
      updatedAt: now
    };
    const committed = await this.commitOutcome(current, next);
    if (enteringDegraded && this.options.notifications) {
      try {
        await this.options.notifications.notify({
          title: "Memory source needs attention",
          body: "A configured memory source is temporarily degraded.",
          sourceId: candidateId
        });
      } catch {
        // Notifications are best-effort operational hints; durable scheduling must continue.
      }
    }
    return committed;
  }

  async recordSuccess(personId: string, candidateId: string): Promise<DaemonSourceState> {
    const current = await this.requireState(personId, candidateId);
    const now = this.options.clock.now();
    const next: DaemonSourceState = {
      ...current,
      state: "healthy",
      consecutiveFailures: 0,
      firstFailureAt: null,
      lastFailureAt: null,
      lastAttemptAt: now,
      lastSuccessAt: now,
      nextDueAt: new Date(Date.parse(now) + 60_000).toISOString(),
      errorCategory: null,
      degradedAt: null,
      notificationSentAt: null,
      updatedAt: now
    };
    return this.commitOutcome(current, next);
  }

  private commitOutcome(expectedState: DaemonSourceState, nextState: DaemonSourceState): Promise<DaemonSourceState> {
    return this.store.commitSourceStateOutcome({
      authority: this.options.authority,
      personId: nextState.personId,
      candidateId: nextState.candidateId,
      expectedState,
      nextState
    });
  }

  private async requireState(personId: string, candidateId: string): Promise<DaemonSourceState> {
    const state = (await this.store.listDaemonSourceStates(personId))
      .find((candidate) => candidate.candidateId === candidateId);
    if (!state) throw new Error("Daemon source state not found for person and candidate");
    return state;
  }
}
