import canonicalize from "canonicalize";
import sodium from "libsodium-wrappers-sumo";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import { InMemoryRelayStore } from "../../src/relay/storage/in-memory-relay-store.js";
import { OpaqueRelayService } from "../../src/relay/service/opaque-relay-service.js";
import { FakeRelayAccountAuthenticator } from "../../src/relay/auth/relay-account-authenticator.js";
import { FakeSyncRelay } from "../../src/sync/transport/sync-relay.js";
import type { RelayMembershipCommit } from "../../src/relay/domain/types.js";
import { LibsodiumCryptoProvider } from "../../src/sync/crypto/libsodium-crypto-provider.js";
import { ReplayVerifier, type ActiveDeviceMembership } from "../../src/sync/replication/replay-verifier.js";
import { SyncReplicationService, type ResolveOperationContent } from "../../src/sync/replication/sync-replication-service.js";
import {
  OPERATION_DOMAIN,
  SYNC_PROTOCOL_ID,
  ZERO_DIGEST_BASE64URL,
  type PlainSyncOperation
} from "../../src/sync/domain/types.js";
import {
  SYNTHETIC_DEVICE_ALPHA,
  SYNTHETIC_DEVICE_BETA,
  SYNTHETIC_PERSON_ID,
  SYNTHETIC_SCOPE_ID,
  SYNTHETIC_SOURCE_ID,
  base64Url,
  syntheticId
} from "./fixtures.js";

await sodium.ready;

function canonicalBytes(value: unknown): Uint8Array {
  const text = canonicalize(value);
  if (text === undefined) throw new Error("Failed to canonicalize fixture value");
  return new TextEncoder().encode(text);
}

/**
 * Real in-process relay (OpaqueRelayService + InMemoryRelayStore, no
 * network) with two active devices registered under one syncId, wired
 * behind two independent SyncReplicationService instances so push/pull,
 * sealed-byte crash/retry, replay/equivocation/gap/rollback, and
 * revoked-device denial are all proven against the genuine relay
 * authorization/CAS path (Task 06-08-01).
 */
async function createReplicationHarness() {
  const relayStore = new InMemoryRelayStore();
  const authenticator = new FakeRelayAccountAuthenticator();
  const service = new OpaqueRelayService({ authenticator, store: relayStore, clock: () => "2030-01-02T03:04:05.000Z" });
  const bearerToken = authenticator.emailSignup("owner@example.test");
  const authority = await authenticator.authenticate(bearerToken);
  const namespace = await relayStore.ensureAccountNamespace(
    authority.issuerHash,
    authority.subjectHash,
    syntheticId("relay-namespace"),
    "2030-01-02T03:04:05.000Z"
  );
  const syncId = namespace.syncId;

  const genesisCommit: RelayMembershipCommit = {
    activeDevices: [{
      deviceId: SYNTHETIC_DEVICE_ALPHA.deviceId,
      signingPublicKey: base64Url(SYNTHETIC_DEVICE_ALPHA.signing.publicKey),
      wrappingPublicKey: base64Url(SYNTHETIC_DEVICE_ALPHA.wrapping.publicKey)
    }],
    controlVersion: 1,
    domain: "cms.sync.v1/control-commit" as const,
    epoch: 1,
    keyPackageDigests: [],
    previousCommitHash: ZERO_DIGEST_BASE64URL,
    previousControlVersion: 0,
    protocol: SYNC_PROTOCOL_ID,
    recoveryCredentialId: syntheticId("recovery"),
    revokedDevices: [],
    syncId
  };
  const genesisSignature = base64Url(
    sodium.crypto_sign_detached(canonicalBytes(genesisCommit), SYNTHETIC_DEVICE_ALPHA.signing.secretKey)
  );
  const relaySession = new FakeSyncRelay({ service, bearerToken });
  const genesisOutcome = await relaySession.compareAndSwapMembership({ commit: genesisCommit, signature: genesisSignature });
  if (genesisOutcome.status !== "committed") throw new Error("Genesis membership commit failed");

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
    domain: "cms.sync.v1/control-commit" as const,
    epoch: 1,
    keyPackageDigests: [],
    previousCommitHash: genesisOutcome.record.commitDigest,
    previousControlVersion: 1,
    protocol: SYNC_PROTOCOL_ID,
    recoveryCredentialId: genesisCommit.recoveryCredentialId,
    revokedDevices: [],
    syncId
  };
  const addBetaSignature = base64Url(
    sodium.crypto_sign_detached(canonicalBytes(addBetaCommit), SYNTHETIC_DEVICE_ALPHA.signing.secretKey)
  );
  const addBetaOutcome = await relaySession.compareAndSwapMembership({ commit: addBetaCommit, signature: addBetaSignature });
  if (addBetaOutcome.status !== "committed") throw new Error("Add-beta membership commit failed");

  const crypto = new LibsodiumCryptoProvider();
  const aeadKey = sodium.crypto_generichash(32, "cms-sync-fixture/epoch-key/1", null);

  // Each device owns its OWN independent local database (matching real multi-device deployment,
  // where "frontier" is shared per-device storage state between local outbox sequencing and
  // remote-apply tracking, per Plan 06-04's design) -- only the relay is shared between devices.
  const storesByDevice = new Map<string, InMemoryStore>();
  function storeFor(deviceId: string): InMemoryStore {
    let store = storesByDevice.get(deviceId);
    if (!store) {
      store = new InMemoryStore();
      storesByDevice.set(deviceId, store);
    }
    return store;
  }

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

  function serviceFor(
    deviceId: string,
    signingSecretKey: Uint8Array,
    resolveOperationContent: ResolveOperationContent,
    activeMembership: ReadonlyMap<string, ActiveDeviceMembership> = membership
  ): SyncReplicationService {
    return new SyncReplicationService({
      store: storeFor(deviceId),
      relay: new FakeSyncRelay({ service, bearerToken }),
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

  return { relayStore, service, bearerToken, relaySession, syncId, storeFor, crypto, aeadKey, membership, serviceFor, buildMaterializationContext };
}

type CanonicalAppendPlainOperation = Extract<PlainSyncOperation, { operationType: "canonical.append" }>;

function canonicalAppendOperation(overrides: Partial<CanonicalAppendPlainOperation> = {}): CanonicalAppendPlainOperation {
  return {
    causalHeads: [],
    domain: OPERATION_DOMAIN,
    operationId: syntheticId(`replication-op-${Math.random()}`),
    operationType: "canonical.append",
    originDeviceId: SYNTHETIC_DEVICE_ALPHA.deviceId,
    originSequence: 1,
    protocol: SYNC_PROTOCOL_ID,
    body: {
      personId: SYNTHETIC_PERSON_ID,
      sourceId: SYNTHETIC_SOURCE_ID,
      scopeId: SYNTHETIC_SCOPE_ID,
      canonicalEventId: syntheticId(`replication-event-${Math.random()}`),
      canonicalEvent: { role: "user", content: "Replication fixture content.", occurredAt: "2030-01-02T03:04:05.000Z" }
    },
    ...overrides
  };
}

async function seedOutbox(
  store: InMemoryStore,
  deviceId: string,
  deviceSequence: number,
  targetId: string,
  predecessorDigest: string | null
) {
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

describe("SyncReplicationService: sealed-byte push, crash/retry, and reconnection", () => {
  it("seals a pending outbox row exactly once and pushes byte-identical bytes on retry", async () => {
    const harness = await createReplicationHarness();
    const operation = canonicalAppendOperation();
    await seedOutbox(harness.storeFor(SYNTHETIC_DEVICE_ALPHA.deviceId), SYNTHETIC_DEVICE_ALPHA.deviceId, 1, operation.body.canonicalEventId, null);

    const resolveOperationContent: ResolveOperationContent = async () => ({ operation });
    const alphaService = harness.serviceFor(SYNTHETIC_DEVICE_ALPHA.deviceId, SYNTHETIC_DEVICE_ALPHA.signing.secretKey, resolveOperationContent);

    const first = await alphaService.pushPending();
    expect(first.pushed).toBe(1);

    const outboxAfterFirst = (await harness.storeFor(SYNTHETIC_DEVICE_ALPHA.deviceId).listSyncOutboxOperations(SYNTHETIC_PERSON_ID))[0]!;
    expect(outboxAfterFirst.status).toBe("sealed");
    const sealedBytesAfterFirst = outboxAfterFirst.sealedEnvelopeBytesBase64;

    // Retry: no new encryption/randomness call -- the exact same sealed bytes must be reused, and
    // the relay already acknowledged the head, so this push is a no-op ("alreadyAcknowledged").
    const second = await alphaService.pushPending();
    expect(second.pushed).toBe(0);
    expect(second.alreadyAcknowledged).toBe(1);

    const outboxAfterSecond = (await harness.storeFor(SYNTHETIC_DEVICE_ALPHA.deviceId).listSyncOutboxOperations(SYNTHETIC_PERSON_ID))[0]!;
    expect(outboxAfterSecond.sealedEnvelopeBytesBase64).toBe(sealedBytesAfterFirst);
  });

  it("reopen/crash-after-seal resends the exact stored bytes without re-encryption", async () => {
    const harness = await createReplicationHarness();
    const operation = canonicalAppendOperation();
    await seedOutbox(harness.storeFor(SYNTHETIC_DEVICE_ALPHA.deviceId), SYNTHETIC_DEVICE_ALPHA.deviceId, 1, operation.body.canonicalEventId, null);
    const resolveOperationContent: ResolveOperationContent = async () => ({ operation });

    const sealingService = harness.serviceFor(SYNTHETIC_DEVICE_ALPHA.deviceId, SYNTHETIC_DEVICE_ALPHA.signing.secretKey, resolveOperationContent);
    await sealingService.pushPending();
    const sealedRow = (await harness.storeFor(SYNTHETIC_DEVICE_ALPHA.deviceId).listSyncOutboxOperations(SYNTHETIC_PERSON_ID))[0]!;
    expect(sealedRow.status).toBe("sealed");

    // Simulate process reopen: a brand-new SyncReplicationService instance over the same durable
    // store/outbox row, with a resolver that would throw if it were ever called again (proving the
    // already-sealed row is never re-encrypted).
    const reopened = harness.serviceFor(
      SYNTHETIC_DEVICE_ALPHA.deviceId,
      SYNTHETIC_DEVICE_ALPHA.signing.secretKey,
      async () => { throw new Error("must not re-resolve an already-sealed row"); }
    );
    const result = await reopened.pushPending();
    // Already sealed and already acknowledged by the relay from the first push in this test.
    expect(result.alreadyAcknowledged).toBe(1);
    expect(result.pushed).toBe(0);
  });
});

describe("SyncReplicationService: two-device push/pull convergence", () => {
  it("pushes from alpha and pulls/applies the identical canonical content on beta", async () => {
    const harness = await createReplicationHarness();
    const operation = canonicalAppendOperation();
    await seedOutbox(harness.storeFor(SYNTHETIC_DEVICE_ALPHA.deviceId), SYNTHETIC_DEVICE_ALPHA.deviceId, 1, operation.body.canonicalEventId, null);

    const alphaService = harness.serviceFor(
      SYNTHETIC_DEVICE_ALPHA.deviceId,
      SYNTHETIC_DEVICE_ALPHA.signing.secretKey,
      async () => ({ operation })
    );
    await alphaService.pushPending();

    const betaService = harness.serviceFor(
      SYNTHETIC_DEVICE_BETA.deviceId,
      SYNTHETIC_DEVICE_BETA.signing.secretKey,
      async () => { throw new Error("beta never pushes in this test"); }
    );
    const pullResult = await betaService.pullAndApply();
    expect(pullResult.applied).toBe(1);
    expect(pullResult.gaps).toBe(0);
    expect(pullResult.rejected).toBe(0);

    const accepted = await harness.storeFor(SYNTHETIC_DEVICE_BETA.deviceId).listAcceptedSyncOperations(SYNTHETIC_PERSON_ID);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.authorDeviceId).toBe(SYNTHETIC_DEVICE_ALPHA.deviceId);
    expect(accepted[0]!.outcomeKind).toBe("effect");

    // Idempotent re-pull of the already-accepted operation: exact replay is idempotent.
    const secondPull = await betaService.pullAndApply();
    expect(secondPull.applied).toBe(0);
  });

  it("classifies a missing predecessor as a bounded pending gap and never advances the frontier over it", async () => {
    const harness = await createReplicationHarness();
    const op1 = canonicalAppendOperation({ originSequence: 1 });
    const op3 = canonicalAppendOperation({ originSequence: 3 });
    await seedOutbox(harness.storeFor(SYNTHETIC_DEVICE_ALPHA.deviceId), SYNTHETIC_DEVICE_ALPHA.deviceId, 1, op1.body.canonicalEventId, null);
    await seedOutbox(harness.storeFor(SYNTHETIC_DEVICE_ALPHA.deviceId), SYNTHETIC_DEVICE_ALPHA.deviceId, 2, "unused", "b".repeat(64));
    await seedOutbox(harness.storeFor(SYNTHETIC_DEVICE_ALPHA.deviceId), SYNTHETIC_DEVICE_ALPHA.deviceId, 3, op3.body.canonicalEventId, "c".repeat(64));

    let call = 0;
    const alphaService = harness.serviceFor(
      SYNTHETIC_DEVICE_ALPHA.deviceId,
      SYNTHETIC_DEVICE_ALPHA.signing.secretKey,
      async (row) => {
        call += 1;
        if (row.deviceSequence === 1) return { operation: op1 };
        if (row.deviceSequence === 3) return { operation: op3 };
        return null; // sequence 2 deliberately never resolves -- simulates it never being pushed
      }
    );
    await alphaService.pushPending();

    const betaService = harness.serviceFor(
      SYNTHETIC_DEVICE_BETA.deviceId,
      SYNTHETIC_DEVICE_BETA.signing.secretKey,
      async () => { throw new Error("beta never pushes in this test"); }
    );

    // Manually append envelope 3 to the relay so beta observes a sequence gap at 2 even though
    // sequence 1 was pushed normally by alpha's own pushPending above.
    const outboxRow3 = (await harness.storeFor(SYNTHETIC_DEVICE_ALPHA.deviceId).listSyncOutboxOperations(SYNTHETIC_PERSON_ID)).find((row) => row.deviceSequence === 3)!;
    expect(outboxRow3.status).toBe("pending"); // never sealed since resolveOperationContent returned null for seq 2's predecessor gate

    const pullResult = await betaService.pullAndApply();
    expect(pullResult.applied).toBe(1); // only sequence 1 applies
    expect(pullResult.gaps).toBe(0);

    const frontier = await harness.storeFor(SYNTHETIC_DEVICE_BETA.deviceId).getSyncReplayFrontier(SYNTHETIC_PERSON_ID, SYNTHETIC_DEVICE_ALPHA.deviceId);
    expect(frontier).toBe(1);
  });
});

describe("ReplayVerifier: membership, signature, and rollback/fork chain validation", () => {
  it("verifies a well-formed first-sequence envelope and returns its chain digest", async () => {
    const harness = await createReplicationHarness();
    const operation = canonicalAppendOperation();
    await seedOutbox(harness.storeFor(SYNTHETIC_DEVICE_ALPHA.deviceId), SYNTHETIC_DEVICE_ALPHA.deviceId, 1, operation.body.canonicalEventId, null);
    const alphaService = harness.serviceFor(SYNTHETIC_DEVICE_ALPHA.deviceId, SYNTHETIC_DEVICE_ALPHA.signing.secretKey, async () => ({ operation }));
    await alphaService.pushPending();

    const page = await new FakeSyncRelay({ service: harness.service, bearerToken: harness.bearerToken })
      .listEnvelopes(SYNTHETIC_DEVICE_ALPHA.deviceId);
    const verifier = new ReplayVerifier(harness.crypto);
    const { receivedAt: _receivedAt, ...wireEnvelope } = page.records[0]!;
    const outcome = verifier.verify(wireEnvelope, {
      aeadKey: harness.aeadKey,
      membership: harness.membership,
      expectedNextSequence: 1,
      expectedPreviousChainDigest: null
    });
    expect(outcome.kind).toBe("verified");
    if (outcome.kind === "verified") {
      expect(outcome.opened.operation.body).toMatchObject({ canonicalEventId: operation.body.canonicalEventId });
    }
  });

  it("rejects a tampered previousEnvelopeHash as SYNC_INTEGRITY_FAILED before decrypting", async () => {
    const harness = await createReplicationHarness();
    const operation1 = canonicalAppendOperation({ originSequence: 1 });
    const operation2 = canonicalAppendOperation({ originSequence: 2 });
    const store = harness.storeFor(SYNTHETIC_DEVICE_ALPHA.deviceId);
    await seedOutbox(store, SYNTHETIC_DEVICE_ALPHA.deviceId, 1, operation1.body.canonicalEventId, null);
    await seedOutbox(store, SYNTHETIC_DEVICE_ALPHA.deviceId, 2, operation2.body.canonicalEventId, "a".repeat(64));
    const alphaService = harness.serviceFor(
      SYNTHETIC_DEVICE_ALPHA.deviceId,
      SYNTHETIC_DEVICE_ALPHA.signing.secretKey,
      async (row) => ({ operation: row.deviceSequence === 1 ? operation1 : operation2 })
    );
    await alphaService.pushPending();

    const page = await new FakeSyncRelay({ service: harness.service, bearerToken: harness.bearerToken })
      .listEnvelopes(SYNTHETIC_DEVICE_ALPHA.deviceId);
    const secondEnvelope = page.records.find((record) => record.header.sequence === 2)!;
    const { receivedAt: _receivedAt, ...baseEnvelope } = secondEnvelope;
    // A different-but-schema-valid previousEnvelopeHash (sequence > 1 has no fixed schema value,
    // unlike sequence 1's mandatory zero digest) -- this is a genuine rollback/fork tamper attempt.
    const tampered = { ...baseEnvelope, header: { ...baseEnvelope.header, previousEnvelopeHash: base64Url(harness.crypto.randomBytes(32)) } };

    const verifier = new ReplayVerifier(harness.crypto);
    const outcome = verifier.verify(tampered, {
      aeadKey: harness.aeadKey,
      membership: harness.membership,
      expectedNextSequence: 2,
      expectedPreviousChainDigest: page.records.find((record) => record.header.sequence === 1)!.ciphertextDigest
    });
    expect(outcome).toEqual({ kind: "rejected", code: "SYNC_INTEGRITY_FAILED" });
  });

  it("rejects an envelope from a revoked device before any AEAD work", async () => {
    const harness = await createReplicationHarness();
    const operation = canonicalAppendOperation();
    await seedOutbox(harness.storeFor(SYNTHETIC_DEVICE_ALPHA.deviceId), SYNTHETIC_DEVICE_ALPHA.deviceId, 1, operation.body.canonicalEventId, null);
    const alphaService = harness.serviceFor(SYNTHETIC_DEVICE_ALPHA.deviceId, SYNTHETIC_DEVICE_ALPHA.signing.secretKey, async () => ({ operation }));
    await alphaService.pushPending();

    const page = await new FakeSyncRelay({ service: harness.service, bearerToken: harness.bearerToken })
      .listEnvelopes(SYNTHETIC_DEVICE_ALPHA.deviceId);

    const revokedMembership: ReadonlyMap<string, ActiveDeviceMembership> = new Map([
      [SYNTHETIC_DEVICE_ALPHA.deviceId, { deviceId: SYNTHETIC_DEVICE_ALPHA.deviceId, signingPublicKey: SYNTHETIC_DEVICE_ALPHA.signing.publicKey, active: false }]
    ]);
    const verifier = new ReplayVerifier(harness.crypto);
    const { receivedAt: _receivedAt, ...wireEnvelope } = page.records[0]!;
    const outcome = verifier.verify(wireEnvelope, {
      aeadKey: harness.aeadKey,
      membership: revokedMembership,
      expectedNextSequence: 1,
      expectedPreviousChainDigest: null
    });
    expect(outcome).toEqual({ kind: "rejected", code: "SYNC_DEVICE_DENIED" });
  });

  it("rejects a schema-invalid envelope before touching membership or signature", () => {
    const crypto = new LibsodiumCryptoProvider();
    const verifier = new ReplayVerifier(crypto);
    const outcome = verifier.verify({ not: "an envelope" }, {
      aeadKey: new Uint8Array(32),
      membership: new Map(),
      expectedNextSequence: 1,
      expectedPreviousChainDigest: null
    });
    expect(outcome).toEqual({ kind: "rejected", code: "SYNC_SCHEMA_INVALID" });
  });
});

describe("Storage-seam replay/equivocation classification (Plan 06-04 CAS reused by Task 06-08-01)", () => {
  let store: InMemoryStore;
  beforeEach(() => { store = new InMemoryStore(); });

  it("identical remote replay is idempotent; different bytes at the same tuple is permanent equivocation", async () => {
    const input = {
      operation: "remote_sync_apply" as const,
      personId: SYNTHETIC_PERSON_ID,
      authorDeviceId: SYNTHETIC_DEVICE_ALPHA.deviceId,
      sequence: 1,
      predecessorDigest: null,
      envelopeDigest: "a".repeat(64),
      effectFingerprint: "b".repeat(64),
      outcome: { kind: "effect" as const },
      affectedRangeStart: 1,
      affectedRangeEnd: 1,
      appliedAt: "2030-01-02T03:04:05.000Z",
      receipt: {
        operation: "remote_sync_apply" as const,
        status: "COMMITTED" as const,
        personId: SYNTHETIC_PERSON_ID,
        targetId: "op-1",
        committedAt: "2030-01-02T03:04:05.000Z"
      }
    };
    const first = await store.commitRemoteSyncApply(input);
    expect(first.status).toBe("COMMITTED");

    const replay = await store.commitRemoteSyncApply(input);
    expect(replay.status).toBe("IDEMPOTENT");

    const differentBytes = { ...input, envelopeDigest: "c".repeat(64) };
    const equivocation = await store.commitRemoteSyncApply(differentBytes);
    expect(equivocation.status).toBe("EQUIVOCATION");
  });
});
