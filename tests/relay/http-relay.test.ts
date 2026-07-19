import { request as httpRequest } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeRelayAccountAuthenticator } from "../../src/relay/auth/relay-account-authenticator.js";
import { InMemoryRelayStore } from "../../src/relay/storage/in-memory-relay-store.js";
import { OpaqueRelayService } from "../../src/relay/service/opaque-relay-service.js";
import { createRelayHttpServer, type RelayHttpLogEntry, type RelayHttpServer } from "../../src/relay/http/relay-http-server.js";
import { createFixtureDevice, genesisCommit, makeEnvelope, randomId, signCommit, FIXED_ZERO_DIGEST } from "./relay-fixtures.js";

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function rawRequest(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {}
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: options.method ?? "POST", headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
        });
      }
    );
    req.on("error", reject);
    if (options.timeoutMs) {
      req.setTimeout(options.timeoutMs, () => req.destroy(new Error("client timeout")));
    }
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

async function jsonRequest(port: number, path: string, token: string, body: unknown): Promise<{ status: number; json: any }> {
  const response = await rawRequest(port, path, {
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });
  return { status: response.status, json: response.body.length > 0 ? JSON.parse(response.body) : undefined };
}

describe("Relay HTTP/HTTPS server (real ephemeral loopback)", () => {
  let authenticator: FakeRelayAccountAuthenticator;
  let store: InMemoryRelayStore;
  let service: OpaqueRelayService;
  let handle: RelayHttpServer;
  let logs: RelayHttpLogEntry[];

  beforeEach(async () => {
    authenticator = new FakeRelayAccountAuthenticator();
    store = new InMemoryRelayStore();
    service = new OpaqueRelayService({ authenticator, store, clock: () => "2030-01-02T03:04:05.000Z" });
    logs = [];
    handle = createRelayHttpServer({
      service,
      host: "127.0.0.1",
      port: 0,
      allowInsecureLoopback: true,
      logger: (entry) => logs.push(entry),
      maxBodyBytes: 200_000,
      requestTimeoutMs: 5_000,
      maxConcurrentRequests: 2,
      rateLimitPerMinute: 100
    });
    await handle.ready;
  });

  afterEach(async () => {
    await handle.close();
  });

  it("requires tls or an explicit loopback acknowledgement to construct", () => {
    expect(() => createRelayHttpServer({ service, host: "127.0.0.1", port: 0 })).toThrow();
  });

  it("serves membership.cas, envelope.append/list/head, and enrollment.submit/list end-to-end", async () => {
    const { port } = handle.address();
    const token = authenticator.emailSignup("owner@example.test");
    const authority = await authenticator.authenticate(token);
    const namespace = await store.ensureAccountNamespace(authority.issuerHash, authority.subjectHash, randomId(), "2030-01-02T03:04:05.000Z");
    const syncId = namespace.syncId;
    const device = createFixtureDevice();
    const genesis = genesisCommit(syncId, device);

    const casResponse = await jsonRequest(port, "/v1/membership/cas", token, { commit: genesis, signature: signCommit(device, genesis) });
    expect(casResponse.status).toBe(200);
    expect(casResponse.json).toMatchObject({ operation: "membership.cas", status: "committed" });

    const envelope = makeEnvelope(device, syncId, 1, FIXED_ZERO_DIGEST);
    const appendResponse = await jsonRequest(port, "/v1/envelope/append", token, { envelope });
    expect(appendResponse.status).toBe(200);
    expect(appendResponse.json).toMatchObject({ operation: "envelope.append", status: "accepted" });

    const listResponse = await jsonRequest(port, "/v1/envelope/list", token, { deviceId: device.deviceId });
    expect(listResponse.status).toBe(200);
    expect(listResponse.json.records).toHaveLength(1);

    const headResponse = await jsonRequest(port, "/v1/envelope/head", token, { deviceId: device.deviceId });
    expect(headResponse.status).toBe(200);
    expect(headResponse.json).toMatchObject({ sequence: 1 });

    const candidate = createFixtureDevice();
    const enrollResponse = await jsonRequest(port, "/v1/enrollment/submit", token, {
      request: {
        syncId,
        requestId: candidate.deviceId,
        candidateDeviceId: candidate.deviceId,
        candidateSigningPublicKey: candidate.signingPublicKey,
        candidateWrappingPublicKey: candidate.wrappingPublicKey,
        candidateEphemeralPublicKey: candidate.wrappingPublicKey,
        encryptedNameBlob: candidate.signingPublicKey,
        nonce: Buffer.alloc(24, 9).toString("base64url"),
        expiresAt: "2030-01-02T03:14:05.000Z"
      }
    });
    expect(enrollResponse.status).toBe(200);

    const listEnrollResponse = await jsonRequest(port, "/v1/enrollment/list", token, {});
    expect(listEnrollResponse.status).toBe(200);
    expect(listEnrollResponse.json.records).toHaveLength(1);
  });

  it("returns SYNC_AUTH_REQUIRED (401) with no bearer header", async () => {
    const { port } = handle.address();
    const response = await rawRequest(port, "/v1/envelope/head", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: "x" })
    });
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toMatchObject({ code: "SYNC_AUTH_REQUIRED" });
  });

  it("rejects an unsupported media type with 415 before touching the service", async () => {
    const { port } = handle.address();
    const token = authenticator.emailSignup("owner@example.test");
    const response = await rawRequest(port, "/v1/envelope/head", {
      headers: { "content-type": "text/plain", authorization: `Bearer ${token}` },
      body: "not json"
    });
    expect(response.status).toBe(415);
  });

  it("rejects an unsupported method with 405", async () => {
    const { port } = handle.address();
    const response = await rawRequest(port, "/v1/envelope/head", { method: "GET" });
    expect(response.status).toBe(405);
  });

  it("rejects an unknown route with 404", async () => {
    const { port } = handle.address();
    const response = await rawRequest(port, "/v1/unknown/route", { headers: { "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(404);
  });

  it("rejects malformed JSON with 400 SYNC_SCHEMA_INVALID", async () => {
    const { port } = handle.address();
    const token = authenticator.emailSignup("owner@example.test");
    const response = await rawRequest(port, "/v1/envelope/head", {
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: "{not-valid-json"
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ code: "SYNC_SCHEMA_INVALID" });
  });

  it("rejects an oversized body with 413 before parsing or dispatching to the service", async () => {
    const { port } = handle.address();
    const token = authenticator.emailSignup("owner@example.test");
    const oversizedBody = JSON.stringify({ deviceId: "x".repeat(300_000) });
    const response = await rawRequest(port, "/v1/envelope/head", {
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: oversizedBody
    });
    expect(response.status).toBe(413);
  });

  it("enforces the deployment-configured rate limit with 429", async () => {
    const limitedHandle = createRelayHttpServer({
      service,
      host: "127.0.0.1",
      port: 0,
      allowInsecureLoopback: true,
      rateLimitPerMinute: 3
    });
    await limitedHandle.ready;
    try {
      const { port } = limitedHandle.address();
      const token = authenticator.emailSignup("owner@example.test");
      const results: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const response = await jsonRequest(port, "/v1/enrollment/list", token, {});
        results.push(response.status);
      }
      expect(results.filter((status) => status === 429).length).toBeGreaterThan(0);
    } finally {
      await limitedHandle.close();
    }
  });

  it("propagates the exact Authorization header to the authenticator without persisting or logging it", async () => {
    const { port } = handle.address();
    const token = authenticator.emailSignup("owner@example.test");
    await jsonRequest(port, "/v1/enrollment/list", token, {});
    const serializedLogs = JSON.stringify(logs);
    expect(serializedLogs).not.toContain(token);
    expect(serializedLogs).not.toContain("owner@example.test");
  });

  it("never echoes ciphertext, signature, or provider error detail into HTTP error responses", async () => {
    const { port } = handle.address();
    const token = authenticator.emailSignup("owner@example.test");
    const device = createFixtureDevice();
    const badEnvelope = makeEnvelope(device, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 1, FIXED_ZERO_DIGEST);
    const response = await jsonRequest(port, "/v1/envelope/append", token, { envelope: badEnvelope });
    expect(response.status).toBeGreaterThanOrEqual(400);
    const bodyText = JSON.stringify(response.json);
    expect(bodyText).not.toContain(badEnvelope.ciphertext);
    expect(bodyText).not.toContain(badEnvelope.signature);
    expect(Object.keys(response.json).sort()).toEqual(["code", "operation", "version"]);
  });

  it("rejects a request body that redundantly sets version/operation with SYNC_SCHEMA_INVALID", async () => {
    const { port } = handle.address();
    const token = authenticator.emailSignup("owner@example.test");
    const response = await jsonRequest(port, "/v1/enrollment/list", token, { version: 1, operation: "enrollment.list" });
    expect(response.status).toBe(400);
  });
});
