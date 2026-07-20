import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";
import { MAX_RETAINED_GAP_SLOTS } from "../../src/relay/domain/types.js";
import type { CommitRemoteSyncApplyInput, RemoteApplyOutcome } from "../../src/storage/sync-contracts.js";
import { SYNTHETIC_DEVICE_ALPHA, SYNTHETIC_PERSON_ID, syntheticId } from "./fixtures.js";

/**
 * Bound test for ADR 0047 "Data Plane, Replay, and Equivocation": a single
 * validly-signed high-sequence remote envelope must not drive proportional
 * client allocation. This file is intentionally separate from
 * tests/sync/replay-equivocation.test.ts (owned by plan 06-10 in the same
 * wave) so the two plans' test edits never collide (Plan 06-11, WR-02).
 */

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (location: string, options?: { readOnly?: boolean }) => {
    prepare(sql: string): { get(...args: unknown[]): unknown };
    close(): void;
  };
};

function hexDigest(label: string): string {
  return createHash("sha256").update(`cms-sync-fixture/gap-allocation/${label}`).digest("hex");
}

const FIXED_APPLIED_AT = "2030-01-02T03:04:05.000Z";

function buildRemoteApplyInput(sequence: number, overrides: Partial<CommitRemoteSyncApplyInput> = {}): CommitRemoteSyncApplyInput {
  const outcome: RemoteApplyOutcome = { kind: "effect" };
  return {
    operation: "remote_sync_apply",
    personId: SYNTHETIC_PERSON_ID,
    authorDeviceId: SYNTHETIC_DEVICE_ALPHA.deviceId,
    sequence,
    predecessorDigest: sequence === 1 ? null : hexDigest(`predecessor-${sequence}`),
    envelopeDigest: hexDigest(`envelope-${sequence}`),
    effectFingerprint: hexDigest(`effect-${sequence}`),
    outcome,
    affectedRangeStart: 0,
    affectedRangeEnd: 0,
    appliedAt: FIXED_APPLIED_AT,
    receipt: {
      operation: "remote_sync_apply",
      status: "COMMITTED",
      personId: SYNTHETIC_PERSON_ID,
      targetId: syntheticId(`target-${sequence}`),
      committedAt: FIXED_APPLIED_AT
    },
    ...overrides
  };
}

describe("client remote-apply forward-gap allocation bound (WR-02, MAX_RETAINED_GAP_SLOTS)", () => {
  describe("InMemoryStore", () => {
    let store: InMemoryStore;

    beforeEach(() => {
      store = new InMemoryStore();
    });

    it("allocates one PendingSyncGap per missing slot within the bound", async () => {
      const receipt = await store.commitRemoteSyncApply(buildRemoteApplyInput(3));
      expect(receipt.status).toBe("GAP_PENDING");
      const gaps = (store as unknown as { pendingSyncGaps: unknown[] }).pendingSyncGaps;
      expect(gaps).toHaveLength(2);
    });

    it("does not allocate proportional PendingSyncGap rows for a jump beyond MAX_RETAINED_GAP_SLOTS", async () => {
      const farSequence = MAX_RETAINED_GAP_SLOTS + 1_000_000;
      const receipt = await store.commitRemoteSyncApply(buildRemoteApplyInput(farSequence));
      expect(receipt.status).toBe("GAP_PENDING");
      const gaps = (store as unknown as { pendingSyncGaps: unknown[] }).pendingSyncGaps;
      expect(gaps.length).toBeLessThan(MAX_RETAINED_GAP_SLOTS);
      expect(gaps).toHaveLength(0);
    });
  });

  describe("SqliteStore", () => {
    let tempDir: string;
    let databasePath: string;
    let store: SqliteStore;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "memory-sqlite-gap-allocation-"));
      databasePath = join(tempDir, "memory.db");
      store = new SqliteStore(databasePath);
    });

    afterEach(async () => {
      store.close();
      await rm(tempDir, { force: true, recursive: true });
    });

    function countPendingSyncGapRows(): number {
      const reader = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const row = reader.prepare("select count(*) as count from pending_sync_gaps").get() as { count: number };
        return row.count;
      } finally {
        reader.close();
      }
    }

    it("allocates one PendingSyncGap row per missing slot within the bound", async () => {
      const receipt = await store.commitRemoteSyncApply(buildRemoteApplyInput(3));
      expect(receipt.status).toBe("GAP_PENDING");
      expect(countPendingSyncGapRows()).toBe(2);
    });

    it("does not allocate proportional PendingSyncGap rows for a jump beyond MAX_RETAINED_GAP_SLOTS", async () => {
      const farSequence = MAX_RETAINED_GAP_SLOTS + 1_000_000;
      const receipt = await store.commitRemoteSyncApply(buildRemoteApplyInput(farSequence));
      expect(receipt.status).toBe("GAP_PENDING");
      const rowCount = countPendingSyncGapRows();
      expect(rowCount).toBeLessThan(MAX_RETAINED_GAP_SLOTS);
      expect(rowCount).toBe(0);
    });
  });
});
