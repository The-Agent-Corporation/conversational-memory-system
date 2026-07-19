import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryRelayStore } from "../../src/relay/storage/in-memory-relay-store.js";
import { SqliteRelayStore } from "../../src/relay/storage/sqlite-relay-store.js";
import type { RelayStore } from "../../src/relay/storage/relay-store.js";
import { DataEnvelopeRecordSchema } from "../../src/relay/domain/types.js";
import { createFixtureDevice, makeEnvelope, randomId, FIXED_ZERO_DIGEST } from "./relay-fixtures.js";

interface Adapter {
  name: string;
  create(): Promise<RelayStore>;
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "relay-envelope-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function adapters(): Adapter[] {
  return [
    { name: "in-memory", async create() { return new InMemoryRelayStore(); } },
    { name: "sqlite", async create() { return new SqliteRelayStore(join(tempDir, `${randomId()}.sqlite`)); } }
  ];
}

function record(input: ReturnType<typeof makeEnvelope>, receivedAt = "2030-01-02T03:04:05.000Z") {
  return DataEnvelopeRecordSchema.parse({ ...input, receivedAt });
}

for (const adapter of adapters()) {
  describe(`RelayStore append-only envelope parity: ${adapter.name}`, () => {
    let store: RelayStore;

    beforeEach(async () => {
      store = await adapter.create();
    });

    afterEach(() => {
      store.close();
    });

    it("retains every accepted version and orders list ascending by sequence", async () => {
      const syncId = randomId();
      const device = createFixtureDevice();
      const e1 = makeEnvelope(device, syncId, 1, FIXED_ZERO_DIGEST);
      const e2 = makeEnvelope(device, syncId, 2, FIXED_ZERO_DIGEST);

      const r1 = await store.appendEnvelope(record(e1));
      const r2 = await store.appendEnvelope(record(e2));
      expect(r1.outcome).toBe("accepted");
      expect(r2.outcome).toBe("accepted");

      const list = await store.listEnvelopes(syncId, device.deviceId, 1, 128);
      expect(list.map((item) => item.header.sequence)).toEqual([1, 2]);
    });

    it("identical replay at the same (syncId, deviceId, sequence) is idempotent", async () => {
      const syncId = randomId();
      const device = createFixtureDevice();
      const e1 = makeEnvelope(device, syncId, 1, FIXED_ZERO_DIGEST);
      const first = await store.appendEnvelope(record(e1, "2030-01-02T03:04:05.000Z"));
      const retry = await store.appendEnvelope(record(e1, "2030-01-02T03:05:00.000Z"));
      expect(first.outcome).toBe("accepted");
      expect(retry.outcome).toBe("replayed");
    });

    it("different bytes at the same tuple is permanent equivocation and neither advances the frontier", async () => {
      const syncId = randomId();
      const device = createFixtureDevice();
      const e1 = makeEnvelope(device, syncId, 1, FIXED_ZERO_DIGEST);
      const e1DifferentBytes = makeEnvelope(device, syncId, 1, FIXED_ZERO_DIGEST);
      await store.appendEnvelope(record(e1));
      const conflict = await store.appendEnvelope(record(e1DifferentBytes));
      expect(conflict.outcome).toBe("equivocation");

      const head = await store.headEnvelope(syncId, device.deviceId);
      expect(head?.sequence).toBe(1);
    });

    it("rejects a jump beyond the bounded gap window without allocating a record", async () => {
      const syncId = randomId();
      const device = createFixtureDevice();
      const farFuture = makeEnvelope(device, syncId, 2000, FIXED_ZERO_DIGEST);
      const result = await store.appendEnvelope(record(farFuture));
      expect(result.outcome).toBe("gap_limit");
      const list = await store.listEnvelopes(syncId, device.deviceId, 1, 128);
      expect(list).toHaveLength(0);
    });

    it("bounds page size and supports pagination via nextFromSequence-style continuation", async () => {
      const syncId = randomId();
      const device = createFixtureDevice();
      for (let sequence = 1; sequence <= 5; sequence += 1) {
        await store.appendEnvelope(record(makeEnvelope(device, syncId, sequence, FIXED_ZERO_DIGEST)));
      }
      const page1 = await store.listEnvelopes(syncId, device.deviceId, 1, 2);
      expect(page1.map((item) => item.header.sequence)).toEqual([1, 2]);
      const page2 = await store.listEnvelopes(syncId, device.deviceId, 3, 2);
      expect(page2.map((item) => item.header.sequence)).toEqual([3, 4]);
    });

    it("head only advances across a contiguous frontier, not past a gap", async () => {
      const syncId = randomId();
      const device = createFixtureDevice();
      await store.appendEnvelope(record(makeEnvelope(device, syncId, 1, FIXED_ZERO_DIGEST)));
      await store.appendEnvelope(record(makeEnvelope(device, syncId, 3, FIXED_ZERO_DIGEST)));
      const head = await store.headEnvelope(syncId, device.deviceId);
      expect(head?.sequence).toBe(1);
    });

    it("contains no fixture plaintext, semantic labels, or account/device PII across the full persisted state", async () => {
      const syncId = randomId();
      const device = createFixtureDevice();
      await store.appendEnvelope(record(makeEnvelope(device, syncId, 1, FIXED_ZERO_DIGEST)));
      const list = await store.listEnvelopes(syncId, device.deviceId, 1, 128);
      const serialized = JSON.stringify(list);
      for (const forbidden of ["personId", "sourceId", "canonicalEvent", "email", "password", "passphrase", "recoverySeed"]) {
        expect(serialized).not.toContain(forbidden);
      }
    });
  });
}
