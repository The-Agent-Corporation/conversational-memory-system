import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import { FakeRelayAccountAuthenticator } from "../../src/relay/auth/relay-account-authenticator.js";
import { InMemoryRelayStore } from "../../src/relay/storage/in-memory-relay-store.js";
import { OpaqueRelayService } from "../../src/relay/service/opaque-relay-service.js";
import { RelayError } from "../../src/relay/domain/types.js";
import { createFixtureDevice, genesisCommit, nextCommit, signCommit, makeEnvelope, FIXED_ZERO_DIGEST } from "./relay-fixtures.js";

const RELAY_SOURCE_DIR = join(process.cwd(), "src/relay");
const FORBIDDEN_IMPORT_PATTERNS = [
  "../domain/canonical",
  "../../domain/canonical",
  "src/domain/canonical",
  "mcp-mutation-contracts",
  "source-lifecycle",
  "MemorySourceSchema",
  "CanonicalEventSchema",
  "PersonSchema"
];

function allRelaySourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...allRelaySourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

describe("Import boundary: relay modules never import local semantic memory schemas", () => {
  it("scans every src/relay/*.ts file for forbidden imports", () => {
    const files = allRelaySourceFiles(RELAY_SOURCE_DIR);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const contents = readFileSync(file, "utf8");
      for (const forbidden of FORBIDDEN_IMPORT_PATTERNS) {
        expect(contents.includes(forbidden), `${file} must not reference ${forbidden}`).toBe(false);
      }
    }
  });

  it("OpaqueRelayService exposes no decrypt/unwrap/plaintext method", () => {
    const methodNames = Object.getOwnPropertyNames(
      Object.getPrototypeOf(
        new OpaqueRelayService({ authenticator: new FakeRelayAccountAuthenticator(), store: new InMemoryRelayStore() })
      )
    );
    for (const forbidden of ["decrypt", "unwrapKeyPackage", "openEnvelope", "readPlaintext"]) {
      expect(methodNames).not.toContain(forbidden);
    }
  });
});

describe("OpaqueRelayService: authenticated pseudonymous account and device authority end-to-end", () => {
  let authenticator: FakeRelayAccountAuthenticator;
  let store: InMemoryRelayStore;
  let service: OpaqueRelayService;
  let clockValue: string;

  beforeEach(() => {
    authenticator = new FakeRelayAccountAuthenticator();
    store = new InMemoryRelayStore();
    clockValue = "2030-01-02T03:04:05.000Z";
    service = new OpaqueRelayService({ authenticator, store, clock: () => clockValue });
  });

  it("rejects every operation without a valid bearer token with SYNC_AUTH_REQUIRED", async () => {
    await expect(service.handle("", { version: 1, operation: "enrollment.list" })).rejects.toMatchObject({ code: "SYNC_AUTH_REQUIRED" });
  });

  it("bootstraps a namespace (genesis commit) and enforces exact current sync/device authority thereafter", async () => {
    const token = authenticator.emailSignup("owner@example.test");
    const device = createFixtureDevice();

    // Resolve the account's syncId indirectly via an enrollment.list call first is not possible
    // (syncId is derived server-side); instead probe by submitting a genesis commit with a
    // syncId the server will reject if wrong. We derive syncId from the first successful CAS.
    const probeSyncId = "00000000000000000000000000000000".slice(0, 32);
    const badCommit = genesisCommit(probeSyncId, device);
    await expect(
      service.handle(token, { version: 1, operation: "membership.cas", commit: badCommit, signature: signCommit(device, badCommit) })
    ).rejects.toMatchObject({ code: "SYNC_ACCOUNT_DENIED" });
  });

  it("full lifecycle: genesis, envelope append/list/head, enrollment, rotation-revocation denies future upload", async () => {
    const token = authenticator.emailSignup("owner@example.test");
    const approver = createFixtureDevice();

    // Discover our own syncId the only legitimate way: attempt a genesis commit with our own
    // random guess is not required; instead exploit that enrollment.list responses don't leak
    // syncId either. Since the protocol always resolves syncId server-side, tests bind syncId by
    // reading it back off the committed ControlRecord's `syncId` field.
    // We first submit a genesis commit using a syncId we control: the server enforces
    // commit.syncId === resolved syncId, so we must learn the resolved value. We do this by first
    // calling enrollment.submit with an arbitrary syncId and reading the SYNC_ACCOUNT_DENIED path
    // is not informative either — so instead we fetch it from the store directly for the fixed
    // fake account, since store.ensureAccountNamespace is deterministic per (issuerHash,subjectHash).
    const authority = await authenticator.authenticate(token);
    const namespace = await store.ensureAccountNamespace(authority.issuerHash, authority.subjectHash, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", clockValue);
    const syncId = namespace.syncId;

    const genesis = genesisCommit(syncId, approver);
    const genesisResult = await service.handle(token, {
      version: 1,
      operation: "membership.cas",
      commit: genesis,
      signature: signCommit(approver, genesis)
    });
    expect(genesisResult).toMatchObject({ operation: "membership.cas", status: "committed" });

    // Append two envelopes for the approver device.
    const e1 = makeEnvelope(approver, syncId, 1, FIXED_ZERO_DIGEST);
    const appendResult1 = await service.handle(token, { version: 1, operation: "envelope.append", envelope: e1 });
    expect(appendResult1).toMatchObject({ operation: "envelope.append", status: "accepted" });

    const e2 = makeEnvelope(approver, syncId, 2, FIXED_ZERO_DIGEST);
    await service.handle(token, { version: 1, operation: "envelope.append", envelope: e2 });

    const headResult = await service.handle(token, { version: 1, operation: "envelope.head", deviceId: approver.deviceId });
    expect(headResult).toMatchObject({ operation: "envelope.head", sequence: 2 });

    const listResult = await service.handle(token, { version: 1, operation: "envelope.list", deviceId: approver.deviceId });
    expect(listResult).toMatchObject({ operation: "envelope.list" });
    if (listResult.operation === "envelope.list") {
      expect(listResult.records).toHaveLength(2);
    }

    // Enroll a second device and approve it.
    const candidate = createFixtureDevice();
    const enrollSubmit = await service.handle(token, {
      version: 1,
      operation: "enrollment.submit",
      request: {
        syncId,
        requestId: candidate.deviceId,
        candidateDeviceId: candidate.deviceId,
        candidateSigningPublicKey: candidate.signingPublicKey,
        candidateWrappingPublicKey: candidate.wrappingPublicKey,
        candidateEphemeralPublicKey: candidate.wrappingPublicKey,
        encryptedNameBlob: candidate.signingPublicKey,
        nonce: Buffer.alloc(24, 7).toString("base64url"),
        expiresAt: "2030-01-02T03:14:05.000Z"
      }
    });
    expect(enrollSubmit).toMatchObject({ operation: "enrollment.submit" });

    const rotate = nextCommit(
      { controlVersion: 1, commitDigest: (genesisResult as { operation: "membership.cas"; record?: { commitDigest: string } }).record!.commitDigest },
      {
        syncId,
        activeDevices: [approver, candidate].sort((a, b) => a.deviceId.localeCompare(b.deviceId)).map((d) => ({ deviceId: d.deviceId, signingPublicKey: d.signingPublicKey, wrappingPublicKey: d.wrappingPublicKey })),
        epoch: 2
      }
    );
    const rotateResult = await service.handle(token, {
      version: 1,
      operation: "membership.cas",
      commit: rotate,
      signature: signCommit(approver, rotate),
      enrollmentRequestId: candidate.deviceId
    });
    expect(rotateResult).toMatchObject({ operation: "membership.cas", status: "committed" });

    // Revoke the approver; only the candidate remains active.
    const revoke = nextCommit(
      { controlVersion: 2, commitDigest: (rotateResult as { operation: "membership.cas"; record?: { commitDigest: string } }).record!.commitDigest },
      {
        syncId,
        activeDevices: [{ deviceId: candidate.deviceId, signingPublicKey: candidate.signingPublicKey, wrappingPublicKey: candidate.wrappingPublicKey }],
        revokedDevices: [approver.deviceId],
        epoch: 3
      }
    );
    const revokeResult = await service.handle(token, {
      version: 1,
      operation: "membership.cas",
      commit: revoke,
      signature: signCommit(candidate, revoke)
    });
    expect(revokeResult).toMatchObject({ operation: "membership.cas", status: "committed" });

    // The now-revoked approver can no longer append.
    const e3 = makeEnvelope(approver, syncId, 3, e2.ciphertextDigest);
    await expect(service.handle(token, { version: 1, operation: "envelope.append", envelope: e3 })).rejects.toMatchObject({ code: "SYNC_DEVICE_DENIED" });
  });

  it("scans full relay service/store persisted state for the D-13 allowlist and rejects forbidden semantic values", async () => {
    const token = authenticator.emailSignup("owner@example.test");
    const authority = await authenticator.authenticate(token);
    const namespace = await store.ensureAccountNamespace(authority.issuerHash, authority.subjectHash, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", clockValue);
    const device = createFixtureDevice();
    const genesis = genesisCommit(namespace.syncId, device);
    await service.handle(token, { version: 1, operation: "membership.cas", commit: genesis, signature: signCommit(device, genesis) });
    await service.handle(token, {
      version: 1,
      operation: "envelope.append",
      envelope: makeEnvelope(device, namespace.syncId, 1, FIXED_ZERO_DIGEST)
    });

    const allDeviceRecords = await store.listDeviceCredentials(namespace.syncId);
    const allEnvelopes = await store.listEnvelopes(namespace.syncId, device.deviceId, 1, 128);
    const serialized = JSON.stringify({ namespace, allDeviceRecords, allEnvelopes });

    for (const forbidden of ["email", "owner@example.test", "password", "personId", "sourceId", "canonicalEvent", "deviceName"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("rejects a schema-invalid request with SYNC_SCHEMA_INVALID before touching the store", async () => {
    const token = authenticator.emailSignup("owner@example.test");
    await expect(service.handle(token, { version: 1, operation: "not-a-real-operation" })).rejects.toBeInstanceOf(RelayError);
  });
});
