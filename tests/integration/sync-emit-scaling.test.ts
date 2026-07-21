import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import { emitLocalSyncOperation } from "../../src/sync/materialization/sync-materializer.js";
import type { SyncOutboxOperation } from "../../src/storage/sync-contracts.js";

const NOW = "2030-02-01T00:00:00.000Z";
const fingerprint = (seed: string): string => createHash("sha256").update(seed).digest("hex");

/**
 * Regression guard for the bootstrap-import O(n^2) defect: emitLocalSyncOperation runs once per
 * ingested event, and the sync outbox grows by one row per event. Reading the predecessor via a
 * full listSyncOutboxOperations()+scan therefore made a multi-thousand-session import quadratic
 * (openclaw: ~47 min for 41k events). The fix uses the indexed getSyncOutboxOperation() single-row
 * lookup. This test fails if any producer reintroduces a per-emit full-outbox listing.
 */
class CountingStore extends InMemoryStore {
  public listCalls = 0;
  public getCalls = 0;

  override async listSyncOutboxOperations(personId: string): Promise<SyncOutboxOperation[]> {
    this.listCalls += 1;
    return super.listSyncOutboxOperations(personId);
  }

  override async getSyncOutboxOperation(
    personId: string,
    deviceId: string,
    deviceSequence: number
  ): Promise<SyncOutboxOperation | null> {
    this.getCalls += 1;
    return super.getSyncOutboxOperation(personId, deviceId, deviceSequence);
  }
}

describe("emitLocalSyncOperation scaling and chaining", () => {
  it("never full-lists the outbox and chains each op onto the predecessor digest", async () => {
    const store = new CountingStore();
    const personId = "person-a";
    const deviceId = "device_local_primary";
    const count = 200;

    for (let sequence = 1; sequence <= count; sequence += 1) {
      const status = await emitLocalSyncOperation(store, {
        personId,
        deviceId,
        operationKind: "host_event_ingest",
        targetId: `evt-${sequence}`,
        effectFingerprint: fingerprint(`fp-${sequence}`),
        committedAt: NOW
      });
      expect(status).toBe("COMMITTED");
    }

    // The hot path must use the indexed single-row lookup, never the full-outbox list.
    expect(store.listCalls).toBe(0);
    // One predecessor lookup per emit after the first (frontier > 0).
    expect(store.getCalls).toBe(count - 1);

    // Digest chain preserved: op N's predecessorDigest is op N-1's effectFingerprint.
    const outbox = (await store.listSyncOutboxOperations(personId))
      .sort((left, right) => left.deviceSequence - right.deviceSequence);
    expect(outbox).toHaveLength(count);
    expect(outbox[0]!.predecessorDigest).toBeNull();
    for (let index = 1; index < outbox.length; index += 1) {
      expect(outbox[index]!.predecessorDigest).toBe(outbox[index - 1]!.effectFingerprint);
    }
  });
});
