import type { SyncErrorCode } from "../domain/types.js";

/**
 * Content-free replication status (ADR 0047 "Honest incomplete status";
 * D-06 "relay never claims remote erasure"). Every field is a controlled
 * count, opaque digest, or timestamp -- never plaintext, a semantic label,
 * a token, a passphrase, a recovery seed, a private key, or an epoch key.
 */

export type SyncStateLabel = "offline" | "pending" | "incomplete" | "conflict" | "synced";

export interface SyncStatusSnapshot {
  readonly state: SyncStateLabel;
  readonly personId: string;
  readonly deviceId: string;
  /** Local outbox rows not yet acknowledged by the relay for this device's own stream. */
  readonly pendingOutboxCount: number;
  /** Sequence gaps observed across every peer device stream, not yet resolved by a later pull. */
  readonly pendingGapCount: number;
  /** Explicit multi-value review-decision conflicts with no resolved winner. */
  readonly unresolvedConflictCount: number;
  /** Highest local device sequence acknowledged by the relay for this device's own stream. */
  readonly lastPushedSequence: number;
  /** Highest sequence observed across every peer device stream during the last successful pull. */
  readonly lastObservedRemoteSequence: number | null;
  readonly lastSyncedAt: string | null;
  readonly lastErrorCode?: SyncErrorCode;
}

export interface DeriveSyncStatusInput {
  readonly personId: string;
  readonly deviceId: string;
  readonly pendingOutboxCount: number;
  readonly pendingGapCount: number;
  readonly unresolvedConflictCount: number;
  readonly lastPushedSequence: number;
  readonly lastObservedRemoteSequence: number | null;
  readonly lastSyncedAt: string | null;
  /** True when the last transport attempt reached the relay (even if it failed content-free). */
  readonly networkReachable: boolean;
  readonly lastErrorCode?: SyncErrorCode;
}

/**
 * Derives one honest, mutually-exclusive replication state. Never promises
 * availability against a malicious/withholding relay (T-06-30 "accept") and
 * never claims permanent split-view detection -- only the bounded local
 * counts observed so far.
 */
export function deriveSyncStatus(input: DeriveSyncStatusInput): SyncStatusSnapshot {
  let state: SyncStateLabel;
  if (!input.networkReachable) {
    state = "offline";
  } else if (input.unresolvedConflictCount > 0) {
    state = "conflict";
  } else if (input.pendingGapCount > 0) {
    state = "incomplete";
  } else if (input.pendingOutboxCount > 0) {
    state = "pending";
  } else {
    state = "synced";
  }
  return {
    state,
    personId: input.personId,
    deviceId: input.deviceId,
    pendingOutboxCount: input.pendingOutboxCount,
    pendingGapCount: input.pendingGapCount,
    unresolvedConflictCount: input.unresolvedConflictCount,
    lastPushedSequence: input.lastPushedSequence,
    lastObservedRemoteSequence: input.lastObservedRemoteSequence,
    lastSyncedAt: input.lastSyncedAt,
    ...(input.lastErrorCode ? { lastErrorCode: input.lastErrorCode } : {})
  };
}
