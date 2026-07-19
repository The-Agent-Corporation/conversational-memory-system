import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  DeviceMembershipEntrySchema,
  EncryptedSyncEnvelopeHeaderSchema,
  EncryptedSyncEnvelopeSchema,
  MembershipCommitSchema,
  PlainSyncOperationSchema,
  SyncErrorCodeSchema,
  ZERO_DIGEST_BASE64URL,
  base64UrlBytesSchema
} from "../../src/sync/domain/types.js";
import {
  SYNTHETIC_DEVICE_ALPHA,
  SYNTHETIC_DEVICE_BETA,
  VECTOR_V1_HEADER,
  assertSyntheticRoot,
  base64Url,
  buildCanonicalAppendOperation,
  buildMembershipCommit,
  buildOperationSequence,
  buildTombstoneCreateOperation,
  toDeviceMembershipEntry
} from "./fixtures.js";

function validEnvelope() {
  const ciphertextBytes = new Uint8Array(4096);
  return {
    header: VECTOR_V1_HEADER,
    nonce: base64Url(new Uint8Array(24).fill(7)),
    ciphertext: base64Url(ciphertextBytes),
    ciphertextDigest: base64Url(new Uint8Array(32).fill(9)),
    signature: base64Url(new Uint8Array(64).fill(11))
  };
}

describe("EncryptedSyncEnvelopeSchema", () => {
  it("accepts a well-formed envelope", () => {
    expect(EncryptedSyncEnvelopeSchema.safeParse(validEnvelope()).success).toBe(true);
  });

  it("rejects an unknown top-level field", () => {
    const envelope = { ...validEnvelope(), extra: "nope" };
    expect(EncryptedSyncEnvelopeSchema.safeParse(envelope).success).toBe(false);
  });

  it("rejects an unknown header field", () => {
    const envelope = validEnvelope();
    const header = { ...envelope.header, personId: "should-not-be-here" };
    expect(EncryptedSyncEnvelopeSchema.safeParse({ ...envelope, header }).success).toBe(false);
  });

  it("rejects an unsupported protocol version", () => {
    const envelope = validEnvelope();
    const header = { ...envelope.header, protocol: "cms-sync-v2" };
    expect(EncryptedSyncEnvelopeSchema.safeParse({ ...envelope, header }).success).toBe(false);
  });

  it("rejects an unsupported padding policy", () => {
    const envelope = validEnvelope();
    const header = { ...envelope.header, paddingPolicy: "cms-sync-padding-v2" };
    expect(EncryptedSyncEnvelopeSchema.safeParse({ ...envelope, header }).success).toBe(false);
  });

  it("rejects a non-integer ciphertextLength", () => {
    const envelope = validEnvelope();
    const header = { ...envelope.header, ciphertextLength: 4096.5 };
    expect(EncryptedSyncEnvelopeSchema.safeParse({ ...envelope, header }).success).toBe(false);
  });

  it("rejects NaN and Infinity numeric fields", () => {
    const envelope = validEnvelope();
    for (const badValue of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const header = { ...envelope.header, epoch: badValue };
      expect(EncryptedSyncEnvelopeSchema.safeParse({ ...envelope, header }).success).toBe(false);
    }
  });

  it("rejects a ciphertextLength above the 16 MiB cap", () => {
    const envelope = validEnvelope();
    const header = { ...envelope.header, ciphertextLength: 16_777_217 };
    expect(EncryptedSyncEnvelopeSchema.safeParse({ ...envelope, header }).success).toBe(false);
  });

  it("rejects an empty deviceId", () => {
    const envelope = validEnvelope();
    const header = { ...envelope.header, deviceId: "" };
    expect(EncryptedSyncEnvelopeSchema.safeParse({ ...envelope, header }).success).toBe(false);
  });

  it("rejects a deviceId with uppercase hex characters", () => {
    const envelope = validEnvelope();
    const header = { ...envelope.header, deviceId: SYNTHETIC_DEVICE_ALPHA.deviceId.toUpperCase() };
    expect(EncryptedSyncEnvelopeSchema.safeParse({ ...envelope, header }).success).toBe(false);
  });

  it("rejects sequence 0 and sequence beyond the safe-integer bound", () => {
    const envelope = validEnvelope();
    for (const badSequence of [0, 9_007_199_254_740_992]) {
      const header = { ...envelope.header, sequence: badSequence };
      expect(EncryptedSyncEnvelopeSchema.safeParse({ ...envelope, header }).success).toBe(false);
    }
  });

  it("requires the zero digest as previousEnvelopeHash at sequence 1", () => {
    const envelope = validEnvelope();
    const header = { ...envelope.header, sequence: 1, previousEnvelopeHash: base64Url(new Uint8Array(32).fill(3)) };
    expect(EncryptedSyncEnvelopeSchema.safeParse({ ...envelope, header }).success).toBe(false);

    const okHeader = { ...envelope.header, sequence: 1, previousEnvelopeHash: ZERO_DIGEST_BASE64URL };
    expect(EncryptedSyncEnvelopeSchema.safeParse({ ...envelope, header: okHeader }).success).toBe(true);
  });

  it("rejects a nonce of the wrong byte length", () => {
    const envelope = validEnvelope();
    expect(EncryptedSyncEnvelopeSchema.safeParse({ ...envelope, nonce: base64Url(new Uint8Array(16)) }).success).toBe(false);
  });

  it("rejects base64 padding characters", () => {
    const envelope = validEnvelope();
    expect(EncryptedSyncEnvelopeSchema.safeParse({ ...envelope, nonce: `${base64Url(new Uint8Array(23))}=` }).success).toBe(false);
  });

  it("rejects a ciphertext whose decoded length disagrees with header.ciphertextLength", () => {
    const envelope = validEnvelope();
    expect(EncryptedSyncEnvelopeSchema.safeParse({ ...envelope, ciphertext: base64Url(new Uint8Array(100)) }).success).toBe(false);
  });
});

describe("EncryptedSyncEnvelopeHeaderSchema (relay-visible fields only)", () => {
  it("carries no semantic identifiers", () => {
    const shape = Object.keys(EncryptedSyncEnvelopeHeaderSchema.shape);
    for (const forbidden of ["personId", "sourceId", "scopeId", "operationType", "content", "role"]) {
      expect(shape).not.toContain(forbidden);
    }
  });
});

describe("PlainSyncOperationSchema", () => {
  it("accepts a canonical.append operation with person/source/scope inside ciphertext-only body", () => {
    const operation = buildCanonicalAppendOperation();
    const result = PlainSyncOperationSchema.safeParse(operation);
    expect(result.success).toBe(true);
    if (result.success && result.data.operationType === "canonical.append") {
      expect(result.data.body.personId).toBeTruthy();
      expect(result.data.body.sourceId).toBeTruthy();
      expect(result.data.body.scopeId).toBeTruthy();
    }
  });

  it("accepts a tombstone.create operation", () => {
    expect(PlainSyncOperationSchema.safeParse(buildTombstoneCreateOperation()).success).toBe(true);
  });

  it("rejects an unknown operationType", () => {
    const operation = { ...buildCanonicalAppendOperation(), operationType: "canonical.rewrite" };
    expect(PlainSyncOperationSchema.safeParse(operation).success).toBe(false);
  });

  it("rejects an unknown field inside body", () => {
    const operation = buildCanonicalAppendOperation();
    const withExtra = { ...operation, body: { ...(operation as { body: object }).body, unexpected: true } };
    expect(PlainSyncOperationSchema.safeParse(withExtra).success).toBe(false);
  });

  it("rejects unsorted or duplicate causalHeads", () => {
    const heads = ["b".repeat(32), "a".repeat(32)];
    const operation = buildCanonicalAppendOperation({ causalHeads: heads });
    expect(PlainSyncOperationSchema.safeParse(operation).success).toBe(false);

    const duplicated = buildCanonicalAppendOperation({ causalHeads: ["a".repeat(32), "a".repeat(32)] });
    expect(PlainSyncOperationSchema.safeParse(duplicated).success).toBe(false);
  });

  it("rejects an out-of-bound originSequence", () => {
    const operation = buildCanonicalAppendOperation({ originSequence: 0 });
    expect(PlainSyncOperationSchema.safeParse(operation).success).toBe(false);
  });

  it("generates a strictly increasing deterministic operation sequence", () => {
    const sequence = buildOperationSequence(5);
    expect(sequence.map((operation) => operation.originSequence)).toEqual([1, 2, 3, 4, 5]);
    const ids = sequence.map((operation) => operation.operationId);
    expect(new Set(ids).size).toBe(5);
  });
});

describe("MembershipCommitSchema", () => {
  it("accepts a well-formed first commit", () => {
    expect(MembershipCommitSchema.safeParse(buildMembershipCommit()).success).toBe(true);
  });

  it("rejects a non-contiguous controlVersion", () => {
    const commit = buildMembershipCommit({ controlVersion: 3 });
    expect(MembershipCommitSchema.safeParse(commit).success).toBe(false);
  });

  it("rejects unsorted activeDevices", () => {
    const entries = [SYNTHETIC_DEVICE_BETA, SYNTHETIC_DEVICE_ALPHA].map(toDeviceMembershipEntry);
    const sorted = [...entries].sort((left, right) => left.deviceId.localeCompare(right.deviceId));
    if (entries[0]?.deviceId === sorted[0]?.deviceId) {
      // Already sorted by construction; force a violation explicitly.
      entries.reverse();
    }
    const commit = buildMembershipCommit({ activeDevices: entries });
    expect(MembershipCommitSchema.safeParse(commit).success).toBe(false);
  });

  it("rejects a device that is both active and revoked", () => {
    const entry = toDeviceMembershipEntry(SYNTHETIC_DEVICE_ALPHA);
    const commit = buildMembershipCommit({ activeDevices: [entry], revokedDevices: [entry.deviceId] });
    expect(MembershipCommitSchema.safeParse(commit).success).toBe(false);
  });

  it("rejects an unknown field", () => {
    const commit = { ...buildMembershipCommit(), unexpected: true };
    expect(MembershipCommitSchema.safeParse(commit).success).toBe(false);
  });
});

describe("DeviceMembershipEntrySchema", () => {
  it("carries no device name field", () => {
    expect(Object.keys(DeviceMembershipEntrySchema.shape)).not.toContain("deviceName");
  });
});

describe("SyncErrorCodeSchema", () => {
  it("only allows the fourteen stable content-free codes", () => {
    const expected = [
      "SYNC_AUTH_REQUIRED", "SYNC_ACCOUNT_DENIED", "SYNC_DEVICE_DENIED", "SYNC_VERSION_UNSUPPORTED",
      "SYNC_SCHEMA_INVALID", "SYNC_LIMIT_EXCEEDED", "SYNC_CONTROL_CONFLICT", "SYNC_SEQUENCE_CONFLICT",
      "SYNC_GAP_LIMIT", "SYNC_INTEGRITY_FAILED", "SYNC_EXPIRED", "SYNC_ALREADY_USED", "SYNC_INCOMPLETE", "SYNC_INTERNAL"
    ];
    expect([...SyncErrorCodeSchema.options].sort()).toEqual([...expected].sort());
    expect(SyncErrorCodeSchema.safeParse("SYNC_NOT_A_REAL_CODE").success).toBe(false);
  });
});

describe("base64UrlBytesSchema", () => {
  it("rejects non-base64url characters", () => {
    const schema = base64UrlBytesSchema(4, "test");
    expect(schema.safeParse("!!!!!!").success).toBe(false);
  });

  it("rejects the correct alphabet at the wrong length", () => {
    const schema = base64UrlBytesSchema(4, "test");
    expect(schema.safeParse(base64Url(new Uint8Array(3))).success).toBe(false);
  });
});

describe("fixtures: synthetic isolation", () => {
  it("rejects a real host history root", () => {
    expect(() => assertSyntheticRoot(homedir())).toThrow();
    expect(() => assertSyntheticRoot(`${homedir()}/.codex/sessions`)).toThrow();
  });

  it("accepts an obviously synthetic root", () => {
    expect(() => assertSyntheticRoot("/tmp/cms-sync-fixture-root")).not.toThrow();
  });

  it("produces distinct synthetic devices with distinct key material", () => {
    expect(SYNTHETIC_DEVICE_ALPHA.deviceId).not.toBe(SYNTHETIC_DEVICE_BETA.deviceId);
    expect(base64Url(SYNTHETIC_DEVICE_ALPHA.signing.publicKey))
      .not.toBe(base64Url(SYNTHETIC_DEVICE_BETA.signing.publicKey));
  });
});

describe("dependency pins (defense in depth alongside the package.json/lockfile check)", () => {
  it("package.json pins exact audited versions with no ranges", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
    expect(packageJson.dependencies["libsodium-wrappers-sumo"]).toBe("0.8.4");
    expect(packageJson.dependencies.canonicalize).toBe("3.0.0");
    expect(packageJson.dependencies.jose).toBe("6.2.3");
  });

  it("package-lock.json resolves the same exact audited versions", async () => {
    const lockfile = JSON.parse(await readFile(new URL("../../package-lock.json", import.meta.url), "utf8"));
    expect(lockfile.packages["node_modules/libsodium-wrappers-sumo"].version).toBe("0.8.4");
    expect(lockfile.packages["node_modules/canonicalize"].version).toBe("3.0.0");
    expect(lockfile.packages["node_modules/jose"].version).toBe("6.2.3");
  });
});
