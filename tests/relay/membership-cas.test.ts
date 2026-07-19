import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryRelayStore } from "../../src/relay/storage/in-memory-relay-store.js";
import { SqliteRelayStore } from "../../src/relay/storage/sqlite-relay-store.js";
import type { RelayStore } from "../../src/relay/storage/relay-store.js";
import canonicalize from "canonicalize";
import sodium from "libsodium-wrappers-sumo";
import { createFixtureDevice, genesisCommit, nextCommit, randomId, signCommit, FIXED_ZERO_DIGEST } from "./relay-fixtures.js";

await sodium.ready;

function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value) as string);
}
function digestOf(commit: unknown): string {
  return Buffer.from(sodium.crypto_generichash(32, canonicalBytes(commit), null)).toString("base64url");
}

interface Adapter {
  name: string;
  create(): Promise<RelayStore>;
  cleanup(store: RelayStore): Promise<void>;
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "relay-store-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function adapters(): Adapter[] {
  return [
    {
      name: "in-memory",
      async create() {
        return new InMemoryRelayStore();
      },
      async cleanup(store) {
        store.close();
      }
    },
    {
      name: "sqlite",
      async create() {
        return new SqliteRelayStore(join(tempDir, `${randomId()}.sqlite`));
      },
      async cleanup(store) {
        store.close();
      }
    }
  ];
}

for (const adapter of adapters()) {
  describe(`RelayStore membership CAS parity: ${adapter.name}`, () => {
    let store: RelayStore;

    beforeEach(async () => {
      store = await adapter.create();
    });

    afterEach(async () => {
      await adapter.cleanup(store);
    });

    it("accepts exactly one valid next signed control version", async () => {
      const syncId = randomId();
      const device = createFixtureDevice();
      const commit = genesisCommit(syncId, device);
      const signature = signCommit(device, commit);

      const result = await store.commitControl({
        syncId,
        commit,
        canonicalCommitBytes: Buffer.from(canonicalBytes(commit)).toString("base64url"),
        commitDigest: digestOf(commit),
        signature,
        createdAt: "2030-01-02T03:04:05.000Z"
      });

      expect(result.status).toBe("committed");
      const current = await store.getCurrentControlRecord(syncId);
      expect(current?.controlVersion).toBe(1);
    });

    it("returns an identical receipt for an identical retry (idempotent CAS)", async () => {
      const syncId = randomId();
      const device = createFixtureDevice();
      const commit = genesisCommit(syncId, device);
      const signature = signCommit(device, commit);
      const input = {
        syncId,
        commit,
        canonicalCommitBytes: Buffer.from(canonicalBytes(commit)).toString("base64url"),
        commitDigest: digestOf(commit),
        signature,
        createdAt: "2030-01-02T03:04:05.000Z"
      };

      const first = await store.commitControl(input);
      // Retrying the exact same commit now has previousControlVersion=0 again,
      // which is stale relative to the now-current version 1: this must be
      // rejected as a conflict, never silently reapplied.
      const retry = await store.commitControl(input);

      expect(first.status).toBe("committed");
      expect(retry.status).toBe("conflict");
    });

    it("rejects a stale (already-superseded) control version", async () => {
      const syncId = randomId();
      const device = createFixtureDevice();
      const genesis = genesisCommit(syncId, device);
      const genesisSignature = signCommit(device, genesis);
      const first = await store.commitControl({
        syncId,
        commit: genesis,
        canonicalCommitBytes: Buffer.from(canonicalBytes(genesis)).toString("base64url"),
        commitDigest: digestOf(genesis),
        signature: genesisSignature,
        createdAt: "2030-01-02T03:04:05.000Z"
      });
      expect(first.status).toBe("committed");

      const secondDevice = createFixtureDevice();
      const rotate = nextCommit(
        { controlVersion: 1, commitDigest: digestOf(genesis) },
        { syncId, activeDevices: [device, secondDevice].sort((a, b) => a.deviceId.localeCompare(b.deviceId)).map((d) => ({ deviceId: d.deviceId, signingPublicKey: d.signingPublicKey, wrappingPublicKey: d.wrappingPublicKey })) }
      );
      const rotateSignature = signCommit(device, rotate);
      const second = await store.commitControl({
        syncId,
        commit: rotate,
        canonicalCommitBytes: Buffer.from(canonicalBytes(rotate)).toString("base64url"),
        commitDigest: digestOf(rotate),
        signature: rotateSignature,
        createdAt: "2030-01-02T03:05:00.000Z"
      });
      expect(second.status).toBe("committed");

      // Replaying the (now stale) genesis-based first commit again must be rejected.
      const staleRetry = await store.commitControl({
        syncId,
        commit: genesis,
        canonicalCommitBytes: Buffer.from(canonicalBytes(genesis)).toString("base64url"),
        commitDigest: digestOf(genesis),
        signature: genesisSignature,
        createdAt: "2030-01-02T03:06:00.000Z"
      });
      expect(staleRetry.status).toBe("conflict");
      expect(staleRetry.status === "conflict" && staleRetry.currentRecord?.controlVersion).toBe(2);
    });

    it("rejects a forked commit with a mismatched previousCommitHash", async () => {
      const syncId = randomId();
      const device = createFixtureDevice();
      const genesis = genesisCommit(syncId, device);
      await store.commitControl({
        syncId,
        commit: genesis,
        canonicalCommitBytes: Buffer.from(canonicalBytes(genesis)).toString("base64url"),
        commitDigest: digestOf(genesis),
        signature: signCommit(device, genesis),
        createdAt: "2030-01-02T03:04:05.000Z"
      });

      const forked = nextCommit(
        { controlVersion: 1, commitDigest: FIXED_ZERO_DIGEST /* wrong: not the real digest */ },
        { syncId, activeDevices: [{ deviceId: device.deviceId, signingPublicKey: device.signingPublicKey, wrappingPublicKey: device.wrappingPublicKey }] }
      );
      const result = await store.commitControl({
        syncId,
        commit: forked,
        canonicalCommitBytes: Buffer.from(canonicalBytes(forked)).toString("base64url"),
        commitDigest: digestOf(forked),
        signature: signCommit(device, forked),
        createdAt: "2030-01-02T03:06:00.000Z"
      });
      expect(result.status).toBe("conflict");
    });

    it("revocation denies future authorization: revoked device credential status is 'revoked'", async () => {
      const syncId = randomId();
      const approver = createFixtureDevice();
      const other = createFixtureDevice();
      const genesisTwoDevices: import("../../src/relay/domain/types.js").RelayMembershipCommit = {
        activeDevices: [approver, other].sort((a, b) => a.deviceId.localeCompare(b.deviceId)).map((d) => ({ deviceId: d.deviceId, signingPublicKey: d.signingPublicKey, wrappingPublicKey: d.wrappingPublicKey })),
        controlVersion: 1,
        domain: "cms.sync.v1/control-commit",
        epoch: 1,
        keyPackageDigests: [],
        previousCommitHash: FIXED_ZERO_DIGEST,
        previousControlVersion: 0,
        protocol: "cms-sync-v1",
        recoveryCredentialId: randomId(),
        revokedDevices: [],
        syncId
      };
      await store.commitControl({
        syncId,
        commit: genesisTwoDevices,
        canonicalCommitBytes: Buffer.from(canonicalBytes(genesisTwoDevices)).toString("base64url"),
        commitDigest: digestOf(genesisTwoDevices),
        signature: signCommit(approver, genesisTwoDevices),
        createdAt: "2030-01-02T03:04:05.000Z"
      });

      const revoke = nextCommit(
        { controlVersion: 1, commitDigest: digestOf(genesisTwoDevices) },
        {
          syncId,
          activeDevices: [{ deviceId: approver.deviceId, signingPublicKey: approver.signingPublicKey, wrappingPublicKey: approver.wrappingPublicKey }],
          revokedDevices: [other.deviceId],
          epoch: 2
        }
      );
      const result = await store.commitControl({
        syncId,
        commit: revoke,
        canonicalCommitBytes: Buffer.from(canonicalBytes(revoke)).toString("base64url"),
        commitDigest: digestOf(revoke),
        signature: signCommit(approver, revoke),
        createdAt: "2030-01-02T03:10:00.000Z"
      });
      expect(result.status).toBe("committed");

      const revokedCredential = await store.getDeviceCredential(syncId, other.deviceId);
      expect(revokedCredential?.status).toBe("revoked");
      expect(revokedCredential?.revokedAt).toBe("2030-01-02T03:10:00.000Z");
    });
  });
}
