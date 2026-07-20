import canonicalize from "canonicalize";
import sodium from "libsodium-wrappers-sumo";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import { InMemoryRelayStore } from "../../src/relay/storage/in-memory-relay-store.js";
import { OpaqueRelayService } from "../../src/relay/service/opaque-relay-service.js";
import { FakeRelayAccountAuthenticator } from "../../src/relay/auth/relay-account-authenticator.js";
import { createRelayHttpServer, type RelayHttpServer } from "../../src/relay/http/relay-http-server.js";
import { HttpSyncRelay } from "../../src/sync/transport/http-sync-relay.js";
import { LibsodiumCryptoProvider } from "../../src/sync/crypto/libsodium-crypto-provider.js";
import { SyncReplicationService, type ResolveOperationContent } from "../../src/sync/replication/sync-replication-service.js";
import { deriveSyncStatus } from "../../src/sync/replication/sync-status.js";
import type { ActiveDeviceMembership } from "../../src/sync/replication/replay-verifier.js";
import { SyncProtocolError, ZERO_DIGEST_BASE64URL, SYNC_PROTOCOL_ID, OPERATION_DOMAIN, type PlainSyncOperation } from "../../src/sync/domain/types.js";
import type { RelayMembershipCommit } from "../../src/relay/domain/types.js";
import {
  SYNTHETIC_DEVICE_ALPHA,
  SYNTHETIC_DEVICE_BETA,
  SYNTHETIC_PERSON_ID,
  SYNTHETIC_SCOPE_ID,
  SYNTHETIC_SOURCE_ID,
  base64Url,
  syntheticId
} from "../sync/fixtures.js";

await sodium.ready;

/**
 * Complete real-loopback multi-device proof (Task 06-08-01/06-08-02). Runs
 * the actual Plan 05 `createRelayHttpServer` and Plan 06 `HttpSyncRelay`
 * over a real ephemeral TCP loopback connection -- no in-process fake -- so
 * push/pull, sealed-byte crash/retry, cross-device convergence, and
 * server-side revoked-device denial are proven against the genuine network
 * transport boundary, not just the in-process relay service.
 *
 * Scope note: this plan's declared file scope excludes
 * `src/sync/domain/types.ts`, so the proof is bounded to the wire operation
 * kinds that schema already defines (`canonical.append`, `tombstone.create`)
 * -- matching the identical file-boundary precedent already documented by
 * Plans 06-04/06-06/06-07 for the local outbox/control layers this plan
 * builds on. `tests/sync/replay-equivocation.test.ts` covers the
 * gap/rollback/equivocation/revocation matrix at the storage-and-verifier
 * level in more exhaustive detail than is repeated here.
 */

function canonicalBytes(value: unknown): Uint8Array {
  const text = canonicalize(value);
  if (text === undefined) throw new Error("Failed to canonicalize fixture value");
  return new TextEncoder().encode(text);
}

type CanonicalAppendPlainOperation = Extract<PlainSyncOperation, { operationType: "canonical.append" }>;

function canonicalAppendOperation(overrides: Partial<CanonicalAppendPlainOperation> = {}): CanonicalAppendPlainOperation {
  return {
    causalHeads: [],
    domain: OPERATION_DOMAIN,
    operationId: syntheticId(`e2e-op-${Math.random()}`),
    operationType: "canonical.append",
    originDeviceId: SYNTHETIC_DEVICE_ALPHA.deviceId,
    originSequence: 1,
    protocol: SYNC_PROTOCOL_ID,
    body: {
      personId: SYNTHETIC_PERSON_ID,
      sourceId: SYNTHETIC_SOURCE_ID,
      scopeId: SYNTHETIC_SCOPE_ID,
      canonicalEventId: syntheticId(`e2e-event-${Math.random()}`),
      canonicalEvent: { role: "user", content: "Real-loopback fixture content.", occurredAt: "2030-01-02T03:04:05.000Z" }
    },
    ...overrides
  };
}

async function seedOutbox(store: InMemoryStore, deviceId: string, deviceSequence: number, targetId: string, predecessorDigest: string | null) {
  const outboxId = `outbox_${deviceId}_${deviceSequence}`;
  await store.commitLocalSyncOperation({
    operation: "local_sync_operation",
    personId: SYNTHETIC_PERSON_ID,
    deviceId,
    operationKind: "canonical_append",
    targetId,
    outboxId,
    expectedFrontierSequence: deviceSequence - 1,
    deviceSequence,
    predecessorDigest,
    effectFingerprint: "a".repeat(64),
    committedAt: "2030-01-02T03:04:05.000Z",
    receipt: {
      operation: "local_sync_operation",
      status: "COMMITTED",
      personId: SYNTHETIC_PERSON_ID,
      targetId,
      committedAt: "2030-01-02T03:04:05.000Z"
    }
  });
}

describe("Multi-device sync: real HTTP loopback end-to-end proof", () => {
  let relayStore: InMemoryRelayStore;
  let authenticator: FakeRelayAccountAuthenticator;
  let service: OpaqueRelayService;
  let handle: RelayHttpServer;
  let bearerToken: string;
  let syncId: string;
  let baseUrl: string;
  const crypto = new LibsodiumCryptoProvider();
  const aeadKey = sodium.crypto_generichash(32, "cms-sync-fixture/e2e-epoch-key/1", null);
  const membership: ReadonlyMap<string, ActiveDeviceMembership> = new Map([
    [SYNTHETIC_DEVICE_ALPHA.deviceId, { deviceId: SYNTHETIC_DEVICE_ALPHA.deviceId, signingPublicKey: SYNTHETIC_DEVICE_ALPHA.signing.publicKey, active: true }],
    [SYNTHETIC_DEVICE_BETA.deviceId, { deviceId: SYNTHETIC_DEVICE_BETA.deviceId, signingPublicKey: SYNTHETIC_DEVICE_BETA.signing.publicKey, active: true }]
  ]);
  const buildMaterializationContext = async () => ({
    personId: SYNTHETIC_PERSON_ID,
    activeScopeIds: new Set([SYNTHETIC_SCOPE_ID]),
    activeSourceIds: new Set([SYNTHETIC_SOURCE_ID]),
    knownOperationIds: new Set<string>()
  });

  let lastCommitDigest: string;
  let lastControlVersion: number;

  beforeEach(async () => {
    relayStore = new InMemoryRelayStore();
    authenticator = new FakeRelayAccountAuthenticator();
    service = new OpaqueRelayService({ authenticator, store: relayStore, clock: () => "2030-01-02T03:04:05.000Z" });
    handle = createRelayHttpServer({
      service,
      host: "127.0.0.1",
      port: 0,
      allowInsecureLoopback: true,
      maxBodyBytes: 500_000,
      requestTimeoutMs: 5_000,
      maxConcurrentRequests: 8,
      rateLimitPerMinute: 1_000
    });
    await handle.ready;
    const { port } = handle.address();
    baseUrl = `http://127.0.0.1:${port}`;

    bearerToken = authenticator.emailSignup("owner@example.test");
    const authority = await authenticator.authenticate(bearerToken);
    const namespace = await relayStore.ensureAccountNamespace(
      authority.issuerHash,
      authority.subjectHash,
      syntheticId("e2e-namespace"),
      "2030-01-02T03:04:05.000Z"
    );
    syncId = namespace.syncId;

    const httpRelayForSetup = new HttpSyncRelay({ baseUrl, bearerToken: () => bearerToken, allowInsecureLoopback: true });

    const genesisCommit: RelayMembershipCommit = {
      activeDevices: [{
        deviceId: SYNTHETIC_DEVICE_ALPHA.deviceId,
        signingPublicKey: base64Url(SYNTHETIC_DEVICE_ALPHA.signing.publicKey),
        wrappingPublicKey: base64Url(SYNTHETIC_DEVICE_ALPHA.wrapping.publicKey)
      }],
      controlVersion: 1,
      domain: "cms.sync.v1/control-commit",
      epoch: 1,
      keyPackageDigests: [],
      previousCommitHash: ZERO_DIGEST_BASE64URL,
      previousControlVersion: 0,
      protocol: SYNC_PROTOCOL_ID,
      recoveryCredentialId: syntheticId("e2e-recovery"),
      revokedDevices: [],
      syncId
    };
    const genesisSignature = base64Url(sodium.crypto_sign_detached(canonicalBytes(genesisCommit), SYNTHETIC_DEVICE_ALPHA.signing.secretKey));
    const genesisOutcome = await httpRelayForSetup.compareAndSwapMembership({ commit: genesisCommit, signature: genesisSignature });
    if (genesisOutcome.status !== "committed") throw new Error("Genesis membership commit failed over real HTTP loopback");

    const addBetaCommit: RelayMembershipCommit = {
      activeDevices: [
        genesisCommit.activeDevices[0]!,
        {
          deviceId: SYNTHETIC_DEVICE_BETA.deviceId,
          signingPublicKey: base64Url(SYNTHETIC_DEVICE_BETA.signing.publicKey),
          wrappingPublicKey: base64Url(SYNTHETIC_DEVICE_BETA.wrapping.publicKey)
        }
      ].sort((left, right) => left.deviceId.localeCompare(right.deviceId)),
      controlVersion: 2,
      domain: "cms.sync.v1/control-commit",
      epoch: 1,
      keyPackageDigests: [],
      previousCommitHash: genesisOutcome.record.commitDigest,
      previousControlVersion: 1,
      protocol: SYNC_PROTOCOL_ID,
      recoveryCredentialId: genesisCommit.recoveryCredentialId,
      revokedDevices: [],
      syncId
    };
    const addBetaSignature = base64Url(sodium.crypto_sign_detached(canonicalBytes(addBetaCommit), SYNTHETIC_DEVICE_ALPHA.signing.secretKey));
    const addBetaOutcome = await httpRelayForSetup.compareAndSwapMembership({ commit: addBetaCommit, signature: addBetaSignature });
    if (addBetaOutcome.status !== "committed") throw new Error("Add-beta membership commit failed over real HTTP loopback");

    lastCommitDigest = addBetaOutcome.record.commitDigest;
    lastControlVersion = 2;
  });

  afterEach(async () => {
    await handle.close();
  });

  function replicationServiceFor(
    deviceId: string,
    signingSecretKey: Uint8Array,
    store: InMemoryStore,
    resolveOperationContent: ResolveOperationContent,
    activeMembership: ReadonlyMap<string, ActiveDeviceMembership> = membership
  ): SyncReplicationService {
    return new SyncReplicationService({
      store,
      relay: new HttpSyncRelay({ baseUrl, bearerToken: () => bearerToken, allowInsecureLoopback: true }),
      crypto,
      personId: SYNTHETIC_PERSON_ID,
      syncId,
      deviceId,
      signingSecretKey,
      aeadKey,
      epoch: 1,
      membership: () => activeMembership,
      resolveOperationContent,
      buildMaterializationContext,
      clock: () => "2030-01-02T03:04:05.000Z"
    });
  }

  it("converges alpha's pushed content onto beta's independent local store through the real network boundary", async () => {
    const alphaStore = new InMemoryStore();
    const betaStore = new InMemoryStore();
    const operation = canonicalAppendOperation();
    await seedOutbox(alphaStore, SYNTHETIC_DEVICE_ALPHA.deviceId, 1, operation.body.canonicalEventId, null);

    const alphaService = replicationServiceFor(SYNTHETIC_DEVICE_ALPHA.deviceId, SYNTHETIC_DEVICE_ALPHA.signing.secretKey, alphaStore, async () => ({ operation }));
    const pushResult = await alphaService.pushPending();
    expect(pushResult.pushed).toBe(1);

    const betaService = replicationServiceFor(
      SYNTHETIC_DEVICE_BETA.deviceId,
      SYNTHETIC_DEVICE_BETA.signing.secretKey,
      betaStore,
      async () => { throw new Error("beta never pushes in this test"); }
    );
    const pullResult = await betaService.pullAndApply();
    expect(pullResult.applied).toBe(1);
    expect(pullResult.gaps).toBe(0);
    expect(pullResult.rejected).toBe(0);

    const accepted = await betaStore.listAcceptedSyncOperations(SYNTHETIC_PERSON_ID);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.outcomeKind).toBe("effect");

    // Content-free status on both devices: alpha is fully pushed/synced; beta has converged.
    const alphaStatus = await alphaService.status(true);
    expect(alphaStatus.state).toBe("synced");
    const betaStatus = await betaService.status(true);
    expect(betaStatus.state).toBe("synced");
  });

  it("converges a >=2-operations-per-device history through the real network boundary (CR-02)", async () => {
    const alphaStore = new InMemoryStore();
    const betaStore = new InMemoryStore();
    const operation1 = canonicalAppendOperation({ originSequence: 1 });
    const operation2 = canonicalAppendOperation({ originSequence: 2 });
    await seedOutbox(alphaStore, SYNTHETIC_DEVICE_ALPHA.deviceId, 1, operation1.body.canonicalEventId, null);
    await seedOutbox(alphaStore, SYNTHETIC_DEVICE_ALPHA.deviceId, 2, operation2.body.canonicalEventId, "a".repeat(64));

    const alphaService = replicationServiceFor(
      SYNTHETIC_DEVICE_ALPHA.deviceId,
      SYNTHETIC_DEVICE_ALPHA.signing.secretKey,
      alphaStore,
      async (row) => ({ operation: row.deviceSequence === 1 ? operation1 : operation2 })
    );
    const pushResult = await alphaService.pushPending();
    expect(pushResult.pushed).toBe(2);

    const betaService = replicationServiceFor(
      SYNTHETIC_DEVICE_BETA.deviceId,
      SYNTHETIC_DEVICE_BETA.signing.secretKey,
      betaStore,
      async () => { throw new Error("beta never pushes in this test"); }
    );
    const pullResult = await betaService.pullAndApply();
    expect(pullResult.applied).toBe(2);
    expect(pullResult.gaps).toBe(0);
    expect(pullResult.rejected).toBe(0);

    const accepted = await betaStore.listAcceptedSyncOperations(SYNTHETIC_PERSON_ID);
    expect(accepted).toHaveLength(2);
    expect(accepted.every((op) => op.outcomeKind === "effect")).toBe(true);
  });

  it("resends byte-identical sealed bytes after a simulated crash/reopen and converges exactly once", async () => {
    const alphaStore = new InMemoryStore();
    const betaStore = new InMemoryStore();
    const operation = canonicalAppendOperation();
    await seedOutbox(alphaStore, SYNTHETIC_DEVICE_ALPHA.deviceId, 1, operation.body.canonicalEventId, null);

    const firstAttempt = replicationServiceFor(SYNTHETIC_DEVICE_ALPHA.deviceId, SYNTHETIC_DEVICE_ALPHA.signing.secretKey, alphaStore, async () => ({ operation }));
    await firstAttempt.pushPending();
    const sealedAfterFirst = (await alphaStore.listSyncOutboxOperations(SYNTHETIC_PERSON_ID))[0]!.sealedEnvelopeBytesBase64;

    // Process "reopen": a fresh service instance over the same durable outbox row and a resolver
    // that throws if ever invoked again -- proving no re-encryption occurs on retry.
    const reopened = replicationServiceFor(
      SYNTHETIC_DEVICE_ALPHA.deviceId,
      SYNTHETIC_DEVICE_ALPHA.signing.secretKey,
      alphaStore,
      async () => { throw new Error("must not re-resolve an already-sealed row"); }
    );
    const retryResult = await reopened.pushPending();
    expect(retryResult.alreadyAcknowledged).toBe(1);
    const sealedAfterRetry = (await alphaStore.listSyncOutboxOperations(SYNTHETIC_PERSON_ID))[0]!.sealedEnvelopeBytesBase64;
    expect(sealedAfterRetry).toBe(sealedAfterFirst);

    const betaService = replicationServiceFor(SYNTHETIC_DEVICE_BETA.deviceId, SYNTHETIC_DEVICE_BETA.signing.secretKey, betaStore, async () => { throw new Error("no push"); });
    const pullResult = await betaService.pullAndApply();
    expect(pullResult.applied).toBe(1); // exactly once, not duplicated by the retry
  });

  it("server-side revocation denies a revoked device's future push over the real network boundary while history remains untouched", async () => {
    const alphaStore = new InMemoryStore();
    const firstOperation = canonicalAppendOperation({ originSequence: 1 });
    await seedOutbox(alphaStore, SYNTHETIC_DEVICE_ALPHA.deviceId, 1, firstOperation.body.canonicalEventId, null);
    const alphaService = replicationServiceFor(
      SYNTHETIC_DEVICE_ALPHA.deviceId,
      SYNTHETIC_DEVICE_ALPHA.signing.secretKey,
      alphaStore,
      async (row) => (row.deviceSequence === 1 ? { operation: firstOperation } : null)
    );
    const firstPush = await alphaService.pushPending();
    expect(firstPush.pushed).toBe(1);

    // Revoke alpha (signed by beta, the remaining active device) -- future-only revocation.
    const revokeCommit: RelayMembershipCommit = {
      activeDevices: [{
        deviceId: SYNTHETIC_DEVICE_BETA.deviceId,
        signingPublicKey: base64Url(SYNTHETIC_DEVICE_BETA.signing.publicKey),
        wrappingPublicKey: base64Url(SYNTHETIC_DEVICE_BETA.wrapping.publicKey)
      }],
      controlVersion: lastControlVersion + 1,
      domain: "cms.sync.v1/control-commit",
      epoch: 2,
      keyPackageDigests: [],
      previousCommitHash: lastCommitDigest,
      previousControlVersion: lastControlVersion,
      protocol: SYNC_PROTOCOL_ID,
      recoveryCredentialId: syntheticId("e2e-recovery"),
      revokedDevices: [SYNTHETIC_DEVICE_ALPHA.deviceId],
      syncId
    };
    const revokeSignature = base64Url(sodium.crypto_sign_detached(canonicalBytes(revokeCommit), SYNTHETIC_DEVICE_BETA.signing.secretKey));
    const httpRelay = new HttpSyncRelay({ baseUrl, bearerToken: () => bearerToken, allowInsecureLoopback: true });
    const revokeOutcome = await httpRelay.compareAndSwapMembership({ commit: revokeCommit, signature: revokeSignature });
    expect(revokeOutcome.status).toBe("committed");

    // A NEW outbox operation from the now-revoked alpha must be denied by the real relay.
    const secondOperation = canonicalAppendOperation({ originSequence: 2 });
    await seedOutbox(alphaStore, SYNTHETIC_DEVICE_ALPHA.deviceId, 2, secondOperation.body.canonicalEventId, "a".repeat(64));
    const revokedAlphaService = replicationServiceFor(
      SYNTHETIC_DEVICE_ALPHA.deviceId,
      SYNTHETIC_DEVICE_ALPHA.signing.secretKey,
      alphaStore,
      async (row) => (row.deviceSequence === 2 ? { operation: secondOperation } : null)
    );
    await expect(revokedAlphaService.pushPending()).rejects.toBeInstanceOf(SyncProtocolError);

    // Historical local access to alpha's own already-sealed first operation remains possible --
    // revocation is future-only and never erases local history.
    const historicalOutbox = await alphaStore.listSyncOutboxOperations(SYNTHETIC_PERSON_ID);
    expect(historicalOutbox.find((row) => row.deviceSequence === 1)?.status).toBe("sealed");
  });

  it("relay storage never retains plaintext content or semantic labels for a pushed envelope", async () => {
    const alphaStore = new InMemoryStore();
    const operation = canonicalAppendOperation({
      body: {
        personId: SYNTHETIC_PERSON_ID,
        sourceId: SYNTHETIC_SOURCE_ID,
        scopeId: SYNTHETIC_SCOPE_ID,
        canonicalEventId: syntheticId("e2e-scan-event"),
        canonicalEvent: { role: "user", content: "UNIQUE_PLAINTEXT_MARKER_7f3c9a", occurredAt: "2030-01-02T03:04:05.000Z" }
      }
    });
    await seedOutbox(alphaStore, SYNTHETIC_DEVICE_ALPHA.deviceId, 1, operation.body.canonicalEventId, null);
    const alphaService = replicationServiceFor(SYNTHETIC_DEVICE_ALPHA.deviceId, SYNTHETIC_DEVICE_ALPHA.signing.secretKey, alphaStore, async () => ({ operation }));
    await alphaService.pushPending();

    const rawEnvelopes = await relayStore.listEnvelopes(syncId, SYNTHETIC_DEVICE_ALPHA.deviceId, 1, 10);
    const serialized = JSON.stringify(rawEnvelopes);
    expect(serialized).not.toContain("UNIQUE_PLAINTEXT_MARKER_7f3c9a");
    expect(serialized).not.toContain(SYNTHETIC_PERSON_ID);
    expect(serialized).not.toContain(operation.body.canonicalEventId);
  });

  it("derives content-free offline status when the relay is unreachable", async () => {
    const alphaStore = new InMemoryStore();
    const operation = canonicalAppendOperation();
    await seedOutbox(alphaStore, SYNTHETIC_DEVICE_ALPHA.deviceId, 1, operation.body.canonicalEventId, null);
    const status = deriveSyncStatus({
      personId: SYNTHETIC_PERSON_ID,
      deviceId: SYNTHETIC_DEVICE_ALPHA.deviceId,
      pendingOutboxCount: 1,
      pendingGapCount: 0,
      unresolvedConflictCount: 0,
      lastPushedSequence: 0,
      lastObservedRemoteSequence: null,
      lastSyncedAt: null,
      networkReachable: false
    });
    expect(status.state).toBe("offline");
    expect(status).not.toHaveProperty("canonicalEvent");
  });
});
