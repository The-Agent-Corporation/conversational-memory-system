import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";
import type { MemoryStore } from "../../src/storage/memory-store.js";
import {
  CommitLocalSyncOperationInputSchema,
  CommitRemoteSyncApplyInputSchema,
  SealClaimedOutboxEnvelopeInputSchema,
  syncEffectFingerprint,
  type CommitLocalSyncOperationInput,
  type CommitRemoteSyncApplyInput,
  type SealClaimedOutboxEnvelopeInput
} from "../../src/storage/sync-contracts.js";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

interface FaultInjector {
  failAt(boundary: string | null): void;
  reach(boundary: string): void;
}

const createFaultInjector = (): FaultInjector => {
  let failBoundary: string | null = null;
  return {
    failAt(boundary) {
      failBoundary = boundary;
    },
    reach(boundary) {
      if (boundary === failBoundary) {
        throw new Error(`Injected fault at ${boundary}`);
      }
    }
  };
};

const localInput = (overrides: Partial<CommitLocalSyncOperationInput> = {}): CommitLocalSyncOperationInput =>
  CommitLocalSyncOperationInputSchema.parse({
    operation: "local_sync_operation",
    personId: "person_1",
    deviceId: "device_a",
    operationKind: "canonical_append",
    targetId: "event_1",
    outboxId: "outbox_1",
    expectedFrontierSequence: 0,
    deviceSequence: 1,
    predecessorDigest: null,
    effectFingerprint: syncEffectFingerprint({ targetId: "event_1" }),
    committedAt: "2026-07-19T12:00:00.000Z",
    receipt: {
      operation: "local_sync_operation",
      status: "COMMITTED",
      personId: "person_1",
      targetId: "event_1",
      committedAt: "2026-07-19T12:00:00.000Z"
    },
    ...overrides
  });

const remoteInput = (overrides: Partial<CommitRemoteSyncApplyInput> = {}): CommitRemoteSyncApplyInput =>
  CommitRemoteSyncApplyInputSchema.parse({
    operation: "remote_sync_apply",
    personId: "person_1",
    authorDeviceId: "device_b",
    sequence: 1,
    predecessorDigest: null,
    envelopeDigest: digest("envelope-1"),
    effectFingerprint: syncEffectFingerprint({ targetId: "remote_event_1" }),
    outcome: { kind: "effect" },
    affectedRangeStart: 10,
    affectedRangeEnd: 20,
    appliedAt: "2026-07-19T12:00:00.000Z",
    receipt: {
      operation: "remote_sync_apply",
      status: "COMMITTED",
      personId: "person_1",
      targetId: "remote_event_1",
      committedAt: "2026-07-19T12:00:00.000Z"
    },
    ...overrides
  });

const sealInput = (overrides: Partial<SealClaimedOutboxEnvelopeInput> = {}): SealClaimedOutboxEnvelopeInput =>
  SealClaimedOutboxEnvelopeInputSchema.parse({
    personId: "person_1",
    deviceId: "device_a",
    outboxId: "outbox_1",
    expectedRowVersion: 0,
    protocolVersion: 1,
    sequence: 1,
    predecessorDigest: null,
    envelopeBytesBase64: Buffer.from("sealed-envelope-bytes").toString("base64"),
    envelopeDigest: digest("sealed-envelope-bytes"),
    ...overrides
  });

describe("sync-store contract and schema", () => {
  it("rejects unknown fields on local sync operation input", () => {
    expect(() => CommitLocalSyncOperationInputSchema.parse({ ...localInput(), extra: "nope" }))
      .toThrow();
  });

  it("rejects unknown fields on remote sync apply input", () => {
    expect(() => CommitRemoteSyncApplyInputSchema.parse({ ...remoteInput(), extra: "nope" }))
      .toThrow();
  });

  it("rejects a device sequence that is not exactly one past the expected frontier", () => {
    expect(() => localInput({ deviceSequence: 2 })).toThrow(/one past the expected frontier/);
  });

  it("rejects a first-sequence local operation carrying a predecessor digest", () => {
    expect(() => localInput({ predecessorDigest: digest("x") })).toThrow(/null predecessor digest/);
  });

  it("rejects a receipt binding mismatch on local sync operation", () => {
    expect(() => localInput({ receipt: { ...localInput().receipt, personId: "person_2" } }))
      .toThrow(/receipt binding mismatch/);
  });

  it("rejects a receipt binding mismatch on remote sync apply", () => {
    expect(() => remoteInput({ receipt: { ...remoteInput().receipt, operation: "local_sync_operation" as never } }))
      .toThrow();
  });

  it("rejects an affected range where start exceeds end", () => {
    expect(() => remoteInput({ affectedRangeStart: 5, affectedRangeEnd: 1 })).toThrow(/start must not exceed end/);
  });

  it("has no secret-key fields on any sync schema shape", () => {
    const forbidden = /private|secret|recovery|passphrase|epochkey/i;
    const sample = { ...localInput(), ...remoteInput(), ...sealInput() };
    for (const key of Object.keys(sample)) {
      expect(forbidden.test(key)).toBe(false);
    }
  });
});

const backends: Array<{ name: string; create: (faultInjector?: FaultInjector) => Promise<{ store: MemoryStore; cleanup(): Promise<void>; reopen?(): Promise<MemoryStore> }> }> = [
  {
    name: "InMemoryStore",
    create: async (faultInjector) => {
      const store = new InMemoryStore({ faultInjector, clock: { now: () => "2026-07-19T12:00:00.000Z" } });
      return { store, cleanup: async () => {} };
    }
  },
  {
    name: "SqliteStore",
    create: async (faultInjector) => {
      const tempDir = await mkdtemp(join(tmpdir(), "sync-store-"));
      const databasePath = join(tempDir, "memory.db");
      let store: SqliteStore = new SqliteStore(databasePath, { faultInjector, clock: { now: () => "2026-07-19T12:00:00.000Z" } });
      return {
        store,
        cleanup: async () => {
          store.close();
          await rm(tempDir, { force: true, recursive: true });
        },
        reopen: async () => {
          store.close();
          store = new SqliteStore(databasePath, { clock: { now: () => "2026-07-19T12:00:00.000Z" } });
          return store;
        }
      };
    }
  }
];

for (const backend of backends) {
  describe(`${backend.name} atomic sync commits`, () => {
    let store: MemoryStore;
    let cleanup: () => Promise<void>;
    let reopenBackend: (() => Promise<MemoryStore>) | undefined;

    beforeEach(async () => {
      const created = await backend.create();
      store = created.store;
      cleanup = created.cleanup;
      reopenBackend = created.reopen;
    });

    afterEach(async () => {
      await cleanup();
    });

    it("commits one local domain-effect proof plus exactly one pending outbox row", async () => {
      const receipt = await store.commitLocalSyncOperation(localInput());
      expect(receipt.status).toBe("COMMITTED");
      const outbox = await store.listSyncOutboxOperations("person_1");
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({ id: "outbox_1", status: "pending", deviceSequence: 1 });
      await expect(store.getSyncReplayFrontier("person_1", "device_a")).resolves.toBe(1);
    });

    it("returns STATE_CHANGED when the expected frontier drifted", async () => {
      const receipt = await store.commitLocalSyncOperation(localInput({
        outboxId: "outbox_2", targetId: "event_2", deviceSequence: 2, predecessorDigest: digest("assumed-seq-1"),
        expectedFrontierSequence: 1, receipt: { ...localInput().receipt, targetId: "event_2" }
      }));
      expect(receipt.status).toBe("STATE_CHANGED");
      const outbox = await store.listSyncOutboxOperations("person_1");
      expect(outbox).toHaveLength(0);
    });

    it("is idempotent on an identical local-operation replay and typed-equivocates on differing bytes at the same sequence", async () => {
      await store.commitLocalSyncOperation(localInput());
      const replay = await store.commitLocalSyncOperation(localInput());
      expect(replay.status).toBe("IDEMPOTENT");

      const differing = await store.commitLocalSyncOperation(localInput({
        effectFingerprint: syncEffectFingerprint({ targetId: "different" })
      }));
      expect(differing.status).toBe("EQUIVOCATION");
      const outbox = await store.listSyncOutboxOperations("person_1");
      expect(outbox).toHaveLength(1);
    });

    it("leaves no partial effect when a fault interrupts before the outbox write", async () => {
      const faultInjector = createFaultInjector();
      const created = await backend.create(faultInjector);
      const faultyStore = created.store;
      faultInjector.failAt("local_sync_after_effect");
      await expect(faultyStore.commitLocalSyncOperation(localInput())).rejects.toThrow();
      const outbox = await faultyStore.listSyncOutboxOperations("person_1");
      expect(outbox).toHaveLength(0);
      await expect(faultyStore.getSyncReplayFrontier("person_1", "device_a")).resolves.toBe(0);
      await created.cleanup();
    });

    it("applies a remote operation atomically, advances the frontier, and never creates an outbox row", async () => {
      const receipt = await store.commitRemoteSyncApply(remoteInput());
      expect(receipt.status).toBe("COMMITTED");
      const accepted = await store.listAcceptedSyncOperations("person_1");
      expect(accepted).toHaveLength(1);
      expect(accepted[0].outcomeKind).toBe("effect");
      await expect(store.getSyncReplayFrontier("person_1", "device_b")).resolves.toBe(1);
      const outbox = await store.listSyncOutboxOperations("person_1");
      expect(outbox).toHaveLength(0);
    });

    it("is idempotent on identical remote replay and typed-equivocates on a differing envelope at the same sequence", async () => {
      await store.commitRemoteSyncApply(remoteInput());
      const replay = await store.commitRemoteSyncApply(remoteInput());
      expect(replay.status).toBe("IDEMPOTENT");
      const differing = await store.commitRemoteSyncApply(remoteInput({ envelopeDigest: digest("other-envelope") }));
      expect(differing.status).toBe("EQUIVOCATION");
    });

    it("keeps a missing predecessor as a bounded pending gap without advancing the frontier", async () => {
      const receipt = await store.commitRemoteSyncApply(remoteInput({
        sequence: 3, predecessorDigest: digest("seq2")
      }));
      expect(receipt.status).toBe("GAP_PENDING");
      await expect(store.getSyncReplayFrontier("person_1", "device_b")).resolves.toBe(0);
      const accepted = await store.listAcceptedSyncOperations("person_1");
      expect(accepted).toHaveLength(0);
    });

    it("materializes exactly one outcome kind per remote apply (conflict)", async () => {
      const receipt = await store.commitRemoteSyncApply(remoteInput({
        outcome: { kind: "conflict", detailFingerprint: digest("conflict-detail") }
      }));
      expect(receipt.status).toBe("COMMITTED");
      const accepted = await store.listAcceptedSyncOperations("person_1");
      expect(accepted[0].outcomeKind).toBe("conflict");
    });

    it("seals a claimed outbox envelope exactly once, is idempotent on identical retry, and records equivocation on differing bytes", async () => {
      await store.commitLocalSyncOperation(localInput());
      const sealed = await store.sealClaimedOutboxEnvelope(sealInput());
      expect(sealed.status).toBe("SEALED");
      expect(sealed.record?.sealedEnvelopeDigest).toBe(sealInput().envelopeDigest);

      const identicalRetry = await store.sealClaimedOutboxEnvelope(sealInput());
      expect(identicalRetry.status).toBe("IDEMPOTENT");
      expect(identicalRetry.record?.sealedEnvelopeDigest).toBe(sealInput().envelopeDigest);

      const differingRetry = await store.sealClaimedOutboxEnvelope(sealInput({
        envelopeBytesBase64: Buffer.from("different-bytes").toString("base64"),
        envelopeDigest: digest("different-bytes")
      }));
      expect(differingRetry.status).toBe("EQUIVOCATION");

      const outbox = await store.listSyncOutboxOperations("person_1");
      expect(outbox[0].sealedEnvelopeDigest).toBe(sealInput().envelopeDigest);
    });

    it("rejects sealing when the expected row version has drifted", async () => {
      await store.commitLocalSyncOperation(localInput());
      const result = await store.sealClaimedOutboxEnvelope(sealInput({ expectedRowVersion: 5 }));
      expect(result.status).toBe("STATE_CHANGED");
      expect(result.record).toBeNull();
    });

    it("leaves the row unsealed when a fault interrupts before the seal write completes", async () => {
      const faultInjector = createFaultInjector();
      const created = await backend.create(faultInjector);
      const faultyStore = created.store;
      await faultyStore.commitLocalSyncOperation(localInput());
      faultInjector.failAt("seal_outbox_before_write");
      await expect(faultyStore.sealClaimedOutboxEnvelope(sealInput())).rejects.toThrow();
      const outbox = await faultyStore.listSyncOutboxOperations("person_1");
      expect(outbox[0].status).toBe("pending");
      expect(outbox[0].sealedEnvelopeDigest).toBeNull();
      await created.cleanup();
    });

    if (backend.name === "SqliteStore") {
      it("preserves the first sealed envelope byte-for-byte across close and reopen", async () => {
        await store.commitLocalSyncOperation(localInput());
        await store.sealClaimedOutboxEnvelope(sealInput());
        const reopened = await reopenBackend!();
        const outbox = await reopened.listSyncOutboxOperations("person_1");
        expect(outbox[0].sealedEnvelopeDigest).toBe(sealInput().envelopeDigest);
        expect(outbox[0].sealedEnvelopeBytesBase64).toBe(sealInput().envelopeBytesBase64);

        const equivocated = await reopened.sealClaimedOutboxEnvelope(sealInput({
          envelopeBytesBase64: Buffer.from("post-reopen-different").toString("base64"),
          envelopeDigest: digest("post-reopen-different")
        }));
        expect(equivocated.status).toBe("EQUIVOCATION");
      });

      it("survives restart with tombstones remaining permanent and frontiers durable", async () => {
        await store.commitRemoteSyncApply(remoteInput({
          outcome: { kind: "tombstone", targetId: "deleted_event_1" }
        }));
        const reopened = await reopenBackend!();
        await expect(reopened.getSyncReplayFrontier("person_1", "device_b")).resolves.toBe(1);
        const accepted = await reopened.listAcceptedSyncOperations("person_1");
        expect(accepted[0].outcomeKind).toBe("tombstone");
      });
    }
  });
}

describe("raw store secret-absence scan", () => {
  it("never persists synthetic secret material in sync tables", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sync-secret-scan-"));
    const databasePath = join(tempDir, "memory.db");
    const store = new SqliteStore(databasePath);
    await store.commitLocalSyncOperation(localInput());
    await store.sealClaimedOutboxEnvelope(sealInput());
    await store.commitRemoteSyncApply(remoteInput());
    store.close();

    const { readFile } = await import("node:fs/promises");
    const raw = (await readFile(databasePath)).toString("latin1");
    const secretMarkers = ["FIXTURE_PRIVATE_KEY", "FIXTURE_RECOVERY_SEED", "FIXTURE_PASSPHRASE", "FIXTURE_EPOCH_KEY"];
    for (const marker of secretMarkers) {
      expect(raw.includes(marker)).toBe(false);
    }
    await rm(tempDir, { force: true, recursive: true });
  });
});
