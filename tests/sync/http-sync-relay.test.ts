import { request as httpRequest } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeRelayAccountAuthenticator } from "../../src/relay/auth/relay-account-authenticator.js";
import { InMemoryRelayStore } from "../../src/relay/storage/in-memory-relay-store.js";
import { OpaqueRelayService } from "../../src/relay/service/opaque-relay-service.js";
import { createRelayHttpServer, type RelayHttpServer } from "../../src/relay/http/relay-http-server.js";
import { HttpSyncRelay } from "../../src/sync/transport/http-sync-relay.js";
import { SyncControlService, type CurrentControlState, type DeviceIdentity } from "../../src/sync/control/sync-control-service.js";
import { LibsodiumCryptoProvider } from "../../src/sync/crypto/libsodium-crypto-provider.js";
import { InMemoryDeviceSecretStore } from "../../src/sync/secrets/in-memory-device-secret-store.js";

/**
 * Real ephemeral loopback proof that `HttpSyncRelay` implements the
 * complete `SyncRelay` contract against the actual Plan 05 HTTP server
 * (ADR 0047 "Relay Wire, Limits, and Logs"; Plan 06-06 Task 3).
 */

const PERSON_ID = "11111111111111111111111111111111".slice(0, 32);
const signer = new LibsodiumCryptoProvider();

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Minimal raw request helper (no HttpSyncRelay envelope wrapping) so the rate-limit test can drive distinct bearer tokens directly against the boundary. */
function rawJsonRequest(port: number, path: string, token: string, body: unknown): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "content-length": Buffer.byteLength(payload)
        }
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

describe("HttpSyncRelay (real loopback)", () => {
  let authenticator: FakeRelayAccountAuthenticator;
  let store: InMemoryRelayStore;
  let service: OpaqueRelayService;
  let handle: RelayHttpServer;
  let baseUrl: string;
  let bearerToken: string;

  beforeEach(async () => {
    authenticator = new FakeRelayAccountAuthenticator();
    store = new InMemoryRelayStore();
    service = new OpaqueRelayService({ authenticator, store, clock: () => "2030-01-02T03:04:05.000Z" });
    handle = createRelayHttpServer({
      service,
      host: "127.0.0.1",
      port: 0,
      allowInsecureLoopback: true,
      requestTimeoutMs: 5_000
    });
    await handle.ready;
    baseUrl = `http://127.0.0.1:${handle.address().port}`;
    bearerToken = authenticator.emailSignup("http-sync-relay@example.test");
  });

  afterEach(async () => {
    await handle.close();
  });

  function newRelay(): HttpSyncRelay {
    return new HttpSyncRelay({ baseUrl, bearerToken: () => bearerToken, allowInsecureLoopback: true });
  }

  it("rejects a plaintext baseUrl without an explicit loopback acknowledgement", () => {
    expect(() => new HttpSyncRelay({ baseUrl: "http://example.test", bearerToken: () => "x" })).toThrow();
  });

  it("full enrollment/membership/envelope/recovery control flow via real HTTP round trips", async () => {
    const relay = newRelay();
    const controlService = new SyncControlService({
      relay,
      crypto: new LibsodiumCryptoProvider(),
      secrets: new InMemoryDeviceSecretStore(),
      clock: () => "2030-01-02T03:04:05.000Z"
    });

    const owner: DeviceIdentity = await controlService.createDeviceIdentity(PERSON_ID, "placeholder-not-used");
    // Discover the relay-assigned syncId the way a real client would: resolve the
    // account namespace directly (idempotent - the real HTTP CAS below resolves the
    // exact same namespace via the exact same authenticated bearer token).
    const authority = await authenticator.authenticate(bearerToken);
    const namespace = await store.ensureAccountNamespace(
      authority.issuerHash,
      authority.subjectHash,
      "00000000000000000000000000000000".slice(0, 32),
      "2030-01-02T03:04:05.000Z"
    );
    const provisionalCommit = {
      activeDevices: [{ deviceId: owner.deviceId, signingPublicKey: b64(owner.signing.publicKey), wrappingPublicKey: b64(owner.wrapping.publicKey) }],
      controlVersion: 1,
      domain: "cms.sync.v1/control-commit" as const,
      epoch: 1,
      keyPackageDigests: [] as string[],
      previousCommitHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      previousControlVersion: 0,
      protocol: "cms-sync-v1" as const,
      recoveryCredentialId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      revokedDevices: [] as string[],
      syncId: namespace.syncId
    };
    const genesisSignature = b64(signer.sign(owner.signing.secretKey, signer.canonicalBytes(provisionalCommit)));
    const genesisOutcome = await relay.compareAndSwapMembership({ commit: provisionalCommit, signature: genesisSignature });
    if (genesisOutcome.status !== "committed") throw new Error("genesis commit failed over HTTP");

    const currentControl: CurrentControlState = {
      controlVersion: genesisOutcome.record.controlVersion,
      commitHash: genesisOutcome.record.commitDigest,
      epoch: 1,
      activeDevices: provisionalCommit.activeDevices,
      revokedDevices: [],
      recoveryCredentialId: provisionalCommit.recoveryCredentialId
    };
    const syncId = provisionalCommit.syncId;

    // Envelope append/list/head round trip.
    const appendResult = await relay.appendEnvelope({
      header: {
        ciphertextLength: 20,
        createdAt: "2030-01-02T03:04:05.000Z",
        deviceId: owner.deviceId,
        epoch: 1,
        objectId: "33333333333333333333333333333333",
        paddingPolicy: "cms-sync-padding-v1",
        previousEnvelopeHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        protocol: "cms-sync-v1",
        sequence: 1,
        syncId
      },
      nonce: b64(new Uint8Array(24)),
      ciphertext: b64(new Uint8Array(20).fill(1)),
      ciphertextDigest: b64(signer.hash(new Uint8Array(20).fill(1))),
      signature: b64(signer.sign(owner.signing.secretKey, signer.canonicalBytes({
        ciphertextDigest: b64(signer.hash(new Uint8Array(20).fill(1))),
        domain: "cms.sync.v1/envelope-signature",
        header: {
          ciphertextLength: 20,
          createdAt: "2030-01-02T03:04:05.000Z",
          deviceId: owner.deviceId,
          epoch: 1,
          objectId: "33333333333333333333333333333333",
          paddingPolicy: "cms-sync-padding-v1",
          previousEnvelopeHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          protocol: "cms-sync-v1",
          sequence: 1,
          syncId
        },
        nonce: b64(new Uint8Array(24))
      })))
    });
    expect(appendResult.status).toBe("accepted");

    const head = await relay.headEnvelope(owner.deviceId);
    expect(head.sequence).toBe(1);

    const listed = await relay.listEnvelopes(owner.deviceId, 1, 10);
    expect(listed.records).toHaveLength(1);

    // Enrollment submit/list round trip.
    const candidateService = new SyncControlService({
      relay: newRelay(),
      crypto: new LibsodiumCryptoProvider(),
      secrets: new InMemoryDeviceSecretStore(),
      clock: () => "2030-01-02T03:04:05.000Z"
    });
    const { record: request, candidate, ephemeral } = await candidateService.requestEnrollment({
      personId: PERSON_ID,
      syncId,
      deviceName: "HTTP Candidate",
      activeDevices: currentControl.activeDevices
    });
    const pending = await relay.listEnrollmentRequests();
    expect(pending.map((entry) => entry.requestId)).toContain(request.requestId);

    const approverCode = controlService.computeApproverTranscriptCode({ request, approverDeviceId: owner.deviceId, approverWrapping: owner.wrapping });
    const candidateCode = candidateService.computeCandidateTranscriptCode({
      request,
      approverDeviceId: owner.deviceId,
      approverWrappingPublicKey: b64(owner.wrapping.publicKey),
      candidateEphemeralSecretKey: ephemeral.secretKey
    });
    expect(candidateCode).toBe(approverCode);

    const { controlRecord } = await controlService.approveEnrollment({
      request,
      approver: owner,
      currentControl,
      confirmedCode: candidateCode,
      expectedCode: approverCode,
      historicalEpochKeys: []
    });
    expect(controlRecord.controlVersion).toBe(2);

    // Revoked-device denial: the candidate has not been imported yet, so exercise
    // denial by attempting an envelope append signed by a never-enrolled device.
    const strangerService = new SyncControlService({
      relay: newRelay(),
      crypto: new LibsodiumCryptoProvider(),
      secrets: new InMemoryDeviceSecretStore(),
      clock: () => "2030-01-02T03:04:05.000Z"
    });
    const stranger = await strangerService.createDeviceIdentity(PERSON_ID, syncId);
    await expect(newRelay().appendEnvelope({
      header: {
        ciphertextLength: 20,
        createdAt: "2030-01-02T03:04:05.000Z",
        deviceId: stranger.deviceId,
        epoch: 1,
        objectId: "44444444444444444444444444444444",
        paddingPolicy: "cms-sync-padding-v1",
        previousEnvelopeHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        protocol: "cms-sync-v1",
        sequence: 1,
        syncId
      },
      nonce: b64(new Uint8Array(24)),
      ciphertext: b64(new Uint8Array(20).fill(2)),
      ciphertextDigest: b64(signer.hash(new Uint8Array(20).fill(2))),
      signature: b64(new Uint8Array(64))
    })).rejects.toMatchObject({ code: "SYNC_DEVICE_DENIED" });

    void candidate;
  });

  it("maps an unauthenticated request to SYNC_AUTH_REQUIRED without retaining the caller's bad token", async () => {
    const relay = new HttpSyncRelay({ baseUrl, bearerToken: () => "", allowInsecureLoopback: true });
    await expect(relay.listEnrollmentRequests()).rejects.toMatchObject({ code: "SYNC_AUTH_REQUIRED" });
  });

  it("aborts a request that exceeds the configured total timeout", async () => {
    const slowFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const relay = new HttpSyncRelay({
      baseUrl,
      bearerToken: () => bearerToken,
      allowInsecureLoopback: true,
      fetchImpl: slowFetch,
      totalTimeoutMs: 20,
      connectTimeoutMs: 20
    });
    await expect(relay.listEnrollmentRequests()).rejects.toMatchObject({ code: "SYNC_INCOMPLETE" });
  }, 2000);

  it("treats a malformed (non-JSON) response as a schema failure", async () => {
    const malformedFetch: typeof fetch = async () =>
      new Response("not json", { status: 200, headers: { "content-type": "application/json" } });
    const relay = new HttpSyncRelay({ baseUrl, bearerToken: () => bearerToken, allowInsecureLoopback: true, fetchImpl: malformedFetch });
    await expect(relay.listEnrollmentRequests()).rejects.toMatchObject({ code: "SYNC_SCHEMA_INVALID" });
  });

  it("rejects an oversized response before parsing", async () => {
    const oversizedFetch: typeof fetch = async () =>
      new Response("x".repeat(1024), { status: 200, headers: { "content-type": "application/json" } });
    const relay = new HttpSyncRelay({
      baseUrl,
      bearerToken: () => bearerToken,
      allowInsecureLoopback: true,
      fetchImpl: oversizedFetch,
      maxResponseBytes: 8
    });
    await expect(relay.listEnrollmentRequests()).rejects.toMatchObject({ code: "SYNC_LIMIT_EXCEEDED" });
  });

  it("maps an unexpected wire version to SYNC_VERSION_UNSUPPORTED", async () => {
    const wrongVersionFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ version: 2, operation: "enrollment.list", records: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    const relay = new HttpSyncRelay({ baseUrl, bearerToken: () => bearerToken, allowInsecureLoopback: true, fetchImpl: wrongVersionFetch });
    await expect(relay.listEnrollmentRequests()).rejects.toMatchObject({ code: "SYNC_VERSION_UNSUPPORTED" });
  });

  it("never leaks the bearer token into the log entry", async () => {
    const logs: Array<{ operation: string; status: number }> = [];
    const relay = new HttpSyncRelay({
      baseUrl,
      bearerToken: () => bearerToken,
      allowInsecureLoopback: true,
      logger: (entry) => logs.push(entry)
    });
    await relay.listEnrollmentRequests();
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain(bearerToken);
  });

  it("evicts stale rate-limit windows instead of retaining them for every rotated token digest (WR-08)", async () => {
    const { port } = handle.address();
    const nowSpy = vi.spyOn(Date, "now");
    let mockedNowMs = Date.now();
    nowSpy.mockImplementation(() => mockedNowMs);
    try {
      // A rotating set of distinct account tokens each opens its own rate-limit window.
      const staleTokens = Array.from({ length: 8 }, (_unused, index) => authenticator.emailSignup(`rotated-${index}@example.test`));
      for (const token of staleTokens) {
        const response = await rawJsonRequest(port, "/v1/enrollment/list", token, {});
        expect(response.status).toBe(200);
      }
      expect(handle.rateLimitWindowCount()).toBe(staleTokens.length);

      // Advance past the 60s rolling window: every prior window is now stale.
      mockedNowMs += 61_000;

      // A single fresh access (any token, including a brand-new one) must sweep every
      // expired window on access -- the map must not retain the stale entries forever.
      const freshToken = authenticator.emailSignup("fresh-after-window@example.test");
      const response = await rawJsonRequest(port, "/v1/enrollment/list", freshToken, {});
      expect(response.status).toBe(200);
      expect(handle.rateLimitWindowCount()).toBe(1);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
