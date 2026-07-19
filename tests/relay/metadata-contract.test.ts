import { describe, expect, it } from "vitest";
import {
  AccountNamespaceRecordSchema,
  ControlRecordSchema,
  DataEnvelopeRecordSchema,
  DeviceCredentialRecordSchema,
  EnrollmentRequestRecordSchema,
  HeadObservationRecordSchema,
  RecoveryPackageRecordSchema,
  RelayEnvelopeHeaderSchema,
  RelayIdSchema,
  RelayMembershipCommitSchema,
  RELAY_ZERO_DIGEST_BASE64URL
} from "../../src/relay/domain/types.js";

function b64(byteLength: number, fill = 0x41): string {
  return Buffer.alloc(byteLength, fill).toString("base64url");
}

const ID_A = "22222222222222222222222222222222".slice(0, 32);
const ID_B = "33333333333333333333333333333333".slice(0, 32);
const ID_SYNC = "11111111111111111111111111111111".slice(0, 32);
const KEY32 = b64(32);
const DIGEST32 = b64(32, 0x42);
const SIG64 = b64(64, 0x43);
const NONCE24 = b64(24, 0x44);

function validHeader(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ciphertextLength: 4096,
    createdAt: "2030-01-02T03:04:05.000Z",
    deviceId: ID_A,
    epoch: 1,
    objectId: ID_B,
    paddingPolicy: "cms-sync-padding-v1",
    previousEnvelopeHash: RELAY_ZERO_DIGEST_BASE64URL,
    protocol: "cms-sync-v1",
    sequence: 1,
    syncId: ID_SYNC,
    ...overrides
  };
}

describe("Relay id/allowlist primitives", () => {
  it("RelayIdSchema accepts only 32 lowercase hex characters, no semantic strings", () => {
    expect(RelayIdSchema.safeParse(ID_A).success).toBe(true);
    expect(RelayIdSchema.safeParse("not-hex").success).toBe(false);
    expect(RelayIdSchema.safeParse("device-alice-laptop").success).toBe(false);
    expect(RelayIdSchema.safeParse("AABBCCDDEEAABBCCDDEEAABBCCDDEEAA").success).toBe(false);
  });
});

describe("AccountNamespaceRecordSchema (exact allowlist: issuerHash, subjectHash, syncId, createdAt)", () => {
  const valid = { issuerHash: KEY32, subjectHash: DIGEST32, syncId: ID_SYNC, createdAt: "2030-01-02T03:04:05.000Z" };

  it("accepts the exact allowed fields", () => {
    expect(AccountNamespaceRecordSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects email, name, and any other unknown field", () => {
    for (const forbidden of ["email", "name", "bearerToken", "password", "recoverySeed"]) {
      const result = AccountNamespaceRecordSchema.safeParse({ ...valid, [forbidden]: "leaked-value" });
      expect(result.success, `expected rejection for ${forbidden}`).toBe(false);
    }
  });
});

describe("DeviceCredentialRecordSchema (no device names, no plaintext identity)", () => {
  const valid = {
    syncId: ID_SYNC,
    deviceId: ID_A,
    signingPublicKey: KEY32,
    wrappingPublicKey: KEY32,
    status: "active" as const,
    controlVersion: 1,
    createdAt: "2030-01-02T03:04:05.000Z",
    revokedAt: null
  };

  it("accepts the exact allowed fields", () => {
    expect(DeviceCredentialRecordSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a device name field and an unknown status", () => {
    expect(DeviceCredentialRecordSchema.safeParse({ ...valid, deviceName: "Alice's MacBook" }).success).toBe(false);
    expect(DeviceCredentialRecordSchema.safeParse({ ...valid, status: "pending" }).success).toBe(false);
  });
});

describe("RelayEnvelopeHeaderSchema / DataEnvelopeRecordSchema", () => {
  it("accepts a well-formed header and rejects unknown/semantic fields", () => {
    expect(RelayEnvelopeHeaderSchema.safeParse(validHeader()).success).toBe(true);
    expect(RelayEnvelopeHeaderSchema.safeParse(validHeader({ operationType: "canonical.append" })).success).toBe(false);
    expect(RelayEnvelopeHeaderSchema.safeParse(validHeader({ personId: ID_A })).success).toBe(false);
    expect(RelayEnvelopeHeaderSchema.safeParse(validHeader({ deviceName: "laptop" })).success).toBe(false);
  });

  it("rejects a ciphertextLength above the 16 MiB protocol maximum", () => {
    expect(RelayEnvelopeHeaderSchema.safeParse(validHeader({ ciphertextLength: 16_777_217 })).success).toBe(false);
  });

  it("requires the zero digest as previousEnvelopeHash at sequence 1", () => {
    const badHeader = validHeader({ previousEnvelopeHash: DIGEST32 });
    const ciphertext = b64(4096, 0x45);
    const result = DataEnvelopeRecordSchema.safeParse({
      header: badHeader,
      nonce: NONCE24,
      ciphertext,
      ciphertextDigest: DIGEST32,
      signature: SIG64,
      receivedAt: "2030-01-02T03:04:05.000Z"
    });
    expect(result.success).toBe(false);
  });

  it("requires ciphertext byte length to match header.ciphertextLength", () => {
    const ciphertext = b64(100, 0x45); // wrong length vs header 4096
    const result = DataEnvelopeRecordSchema.safeParse({
      header: validHeader(),
      nonce: NONCE24,
      ciphertext,
      ciphertextDigest: DIGEST32,
      signature: SIG64,
      receivedAt: "2030-01-02T03:04:05.000Z"
    });
    expect(result.success).toBe(false);
  });

  it("rejects plaintext, credential, and archive-secret-shaped fields at the top level", () => {
    const ciphertext = b64(4096, 0x45);
    const base = {
      header: validHeader(),
      nonce: NONCE24,
      ciphertext,
      ciphertextDigest: DIGEST32,
      signature: SIG64,
      receivedAt: "2030-01-02T03:04:05.000Z"
    };
    for (const forbidden of ["plaintext", "epochKey", "recoverySeed", "passphrase", "semanticLabel"]) {
      expect(DataEnvelopeRecordSchema.safeParse({ ...base, [forbidden]: "leaked" }).success).toBe(false);
    }
  });
});

describe("RelayMembershipCommitSchema (linear control CAS binding)", () => {
  const validCommit = {
    activeDevices: [{ deviceId: ID_A, signingPublicKey: KEY32, wrappingPublicKey: KEY32 }],
    controlVersion: 1,
    domain: "cms.sync.v1/control-commit" as const,
    epoch: 1,
    keyPackageDigests: [DIGEST32],
    previousCommitHash: RELAY_ZERO_DIGEST_BASE64URL,
    previousControlVersion: 0,
    protocol: "cms-sync-v1" as const,
    recoveryCredentialId: ID_B,
    revokedDevices: [],
    syncId: ID_SYNC
  };

  it("accepts a well-formed first commit", () => {
    expect(RelayMembershipCommitSchema.safeParse(validCommit).success).toBe(true);
  });

  it("rejects controlVersion that does not equal previousControlVersion + 1", () => {
    expect(RelayMembershipCommitSchema.safeParse({ ...validCommit, controlVersion: 3 }).success).toBe(false);
  });

  it("rejects a device that is both active and revoked", () => {
    expect(RelayMembershipCommitSchema.safeParse({ ...validCommit, revokedDevices: [ID_A] }).success).toBe(false);
  });

  it("rejects unsorted or duplicate active devices", () => {
    const twoDevices = {
      ...validCommit,
      controlVersion: 1,
      activeDevices: [
        { deviceId: ID_B, signingPublicKey: KEY32, wrappingPublicKey: KEY32 },
        { deviceId: ID_A, signingPublicKey: KEY32, wrappingPublicKey: KEY32 }
      ]
    };
    expect(RelayMembershipCommitSchema.safeParse(twoDevices).success).toBe(false);
  });
});

describe("EnrollmentRequestRecordSchema / RecoveryPackageRecordSchema / HeadObservationRecordSchema", () => {
  it("EnrollmentRequestRecordSchema rejects a plaintext device name field", () => {
    const valid = {
      syncId: ID_SYNC,
      requestId: ID_A,
      candidateDeviceId: ID_B,
      candidateSigningPublicKey: KEY32,
      candidateWrappingPublicKey: KEY32,
      candidateEphemeralPublicKey: KEY32,
      encryptedNameBlob: KEY32,
      nonce: NONCE24,
      expiresAt: "2030-01-02T03:14:05.000Z",
      status: "requested" as const
    };
    expect(EnrollmentRequestRecordSchema.safeParse(valid).success).toBe(true);
    expect(EnrollmentRequestRecordSchema.safeParse({ ...valid, deviceName: "Alice's MacBook" }).success).toBe(false);
  });

  it("RecoveryPackageRecordSchema rejects a plaintext passphrase or recovery seed field", () => {
    const valid = {
      syncId: ID_SYNC,
      packageId: ID_A,
      algorithm: "argon2id" as const,
      opsLimit: 3,
      memLimit: 268_435_456,
      salt: b64(16, 0x46),
      nonce: NONCE24,
      ciphertextLength: 4096,
      ciphertext: b64(4096, 0x45),
      ciphertextDigest: DIGEST32,
      signature: SIG64,
      status: "active" as const,
      createdAt: "2030-01-02T03:04:05.000Z"
    };
    expect(RecoveryPackageRecordSchema.safeParse(valid).success).toBe(true);
    expect(RecoveryPackageRecordSchema.safeParse({ ...valid, passphrase: "leaked" }).success).toBe(false);
    expect(RecoveryPackageRecordSchema.safeParse({ ...valid, recoverySeed: "leaked" }).success).toBe(false);
  });

  it("HeadObservationRecordSchema accepts only the exact allowed fields", () => {
    const valid = {
      syncId: ID_SYNC,
      observingDeviceId: ID_A,
      observedControlHeadDigest: DIGEST32,
      observedDataHeadDigest: null,
      signature: SIG64,
      createdAt: "2030-01-02T03:04:05.000Z"
    };
    expect(HeadObservationRecordSchema.safeParse(valid).success).toBe(true);
    expect(HeadObservationRecordSchema.safeParse({ ...valid, deviceName: "laptop" }).success).toBe(false);
  });
});
