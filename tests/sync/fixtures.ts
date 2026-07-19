import { createHash } from "node:crypto";
import { homedir } from "node:os";
import sodium from "libsodium-wrappers-sumo";
import {
  CONTROL_COMMIT_DOMAIN,
  ENVELOPE_AAD_DOMAIN,
  OPERATION_DOMAIN,
  SYNC_PADDING_POLICY_ID,
  SYNC_PROTOCOL_ID,
  ZERO_DIGEST_BASE64URL,
  type DeviceMembershipEntry,
  type EncryptedSyncEnvelopeHeader,
  type MembershipCommit,
  type PlainSyncOperation
} from "../../src/sync/domain/types.js";

await sodium.ready;

/**
 * Synthetic test-only fixtures for CMS Sync Protocol v1 (ADR 0047 / Plan
 * 06-02). Every identity, key, clock, and byte sequence here is fixed and
 * fake; none resolve to real host history, real accounts, or the OS secret
 * store. Production randomness/keys are never exposed through this module.
 */

// ---------------------------------------------------------------------------
// Real-history guard
// ---------------------------------------------------------------------------

const FORBIDDEN_ROOT_MARKERS = [
  homedir(),
  ".codex",
  ".claude",
  "Library/Application Support/Claude",
  "Library/Application Support/Code",
  ".openclaw"
];

/**
 * Throws if a path looks like it resolves into a real host history
 * directory. Every fixture that accepts or synthesizes a filesystem root
 * MUST route it through this guard before use.
 */
export function assertSyntheticRoot(candidatePath: string): void {
  for (const marker of FORBIDDEN_ROOT_MARKERS) {
    if (marker && candidatePath.includes(marker)) {
      throw new Error(`Refusing to use a path that resolves into real host history: ${candidatePath}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Deterministic clocks
// ---------------------------------------------------------------------------

export const FIXED_SYNC_NOW = "2030-01-02T03:04:05.000Z";

export class FakeSyncClock {
  private wallTimeMs: number;
  private monotonicTimeMs = 0;

  constructor(iso: string = FIXED_SYNC_NOW) {
    this.wallTimeMs = Date.parse(iso);
  }

  now = (): string => new Date(this.wallTimeMs).toISOString();

  /** Canonical protocol timestamp: exactly three fractional digits, UTC. */
  nowCanonical = (): string => this.now();

  monotonicNow = (): number => this.monotonicTimeMs;

  advanceBy(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new Error("FakeSyncClock can only advance by a non-negative finite duration");
    }
    this.wallTimeMs += milliseconds;
    this.monotonicTimeMs += milliseconds;
  }
}

// ---------------------------------------------------------------------------
// Synthetic identifiers
// ---------------------------------------------------------------------------

/** Deterministic 32-character lowercase hex identifier derived from a label. */
export function syntheticId(label: string): string {
  return createHash("sha256").update(`cms-sync-fixture/${label}`).digest("hex").slice(0, 32);
}

export const SYNTHETIC_PERSON_ID = syntheticId("person-alpha");
export const SYNTHETIC_SCOPE_ID = syntheticId("scope-alpha");
export const SYNTHETIC_SOURCE_ID = syntheticId("source-alpha");
export const SYNTHETIC_SYNC_ID = syntheticId("sync-alpha");
export const SYNTHETIC_RECOVERY_CREDENTIAL_ID = syntheticId("recovery-alpha");

// ---------------------------------------------------------------------------
// Synthetic devices and fixed test keys (never real key material)
// ---------------------------------------------------------------------------

export interface SyntheticDeviceKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export interface SyntheticDevice {
  deviceId: string;
  signing: SyntheticDeviceKeyPair;
  wrapping: SyntheticDeviceKeyPair;
}

/**
 * Deterministic Ed25519 keypair derived from a fixed label. Ed25519 keypair
 * derivation and signing are themselves deterministic given a seed/message,
 * so this reproduces byte-exact fixtures across runs without any production
 * randomness path. The production LibsodiumCryptoProvider never accepts a
 * seed; only this synthetic test helper does.
 */
export function deterministicSigningKeyPair(label: string): SyntheticDeviceKeyPair {
  const seed = sodium.crypto_generichash(32, `cms-sync-fixture/signing/${label}`, null);
  const pair = sodium.crypto_sign_seed_keypair(seed);
  return { publicKey: pair.publicKey, secretKey: pair.privateKey };
}

/** Deterministic X25519 keypair derived from a fixed label. Test-only. */
export function deterministicWrappingKeyPair(label: string): SyntheticDeviceKeyPair {
  const seed = sodium.crypto_generichash(32, `cms-sync-fixture/wrapping/${label}`, null);
  const pair = sodium.crypto_box_seed_keypair(seed);
  return { publicKey: pair.publicKey, secretKey: pair.privateKey };
}

export function createSyntheticDevice(label: string): SyntheticDevice {
  return {
    deviceId: syntheticId(`device-${label}`),
    signing: deterministicSigningKeyPair(`device-${label}`),
    wrapping: deterministicWrappingKeyPair(`device-${label}`)
  };
}

export const SYNTHETIC_DEVICE_ALPHA = createSyntheticDevice("alpha");
export const SYNTHETIC_DEVICE_BETA = createSyntheticDevice("beta");
export const SYNTHETIC_DEVICE_CANDIDATE = createSyntheticDevice("candidate");

/** Fixed 24-byte nonce for exact-byte AEAD vector tests. Never used by production sealing. */
export const FIXED_TEST_NONCE = sodium.crypto_generichash(24, "cms-sync-fixture/nonce/v1", null);

export function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function toDeviceMembershipEntry(device: SyntheticDevice): DeviceMembershipEntry {
  return {
    deviceId: device.deviceId,
    signingPublicKey: base64Url(device.signing.publicKey),
    wrappingPublicKey: base64Url(device.wrapping.publicKey)
  };
}

// ---------------------------------------------------------------------------
// ADR 0047 fixed canonical/protocol vectors
// ---------------------------------------------------------------------------

/** Vector V1-CANONICAL-HEADER input. Expected RFC 8785 byte length 356, SHA-256 `277ca414...e5c58`. */
export const VECTOR_V1_HEADER: EncryptedSyncEnvelopeHeader = {
  ciphertextLength: 4096,
  createdAt: "2030-01-02T03:04:05.000Z",
  deviceId: "22222222222222222222222222222222",
  epoch: 7,
  objectId: "33333333333333333333333333333333",
  paddingPolicy: SYNC_PADDING_POLICY_ID,
  previousEnvelopeHash: ZERO_DIGEST_BASE64URL,
  protocol: SYNC_PROTOCOL_ID,
  sequence: 42,
  syncId: "11111111111111111111111111111111"
};

export const VECTOR_V1_HEADER_EXPECTED_BYTE_LENGTH = 356;
export const VECTOR_V1_HEADER_EXPECTED_SHA256 = "277ca4142693ad8aa766b33d21a6173894e95c1068855b798c632598709e5c58";

export const VECTOR_V1_AAD_EXPECTED_BYTE_LENGTH = 403;
export const VECTOR_V1_AAD_EXPECTED_SHA256 = "2f2c9ca2be8fb26cfac07579480e71e98013041c9ba42c9bae8f047da5fb6cb5";

export function vectorV1AadInput(): { domain: string; header: EncryptedSyncEnvelopeHeader } {
  return { domain: ENVELOPE_AAD_DOMAIN, header: VECTOR_V1_HEADER };
}

/** Vector V1-PADDING: operation byte length -> expected padded ciphertext length. */
export const VECTOR_V1_PADDING_CASES = [
  { operationBytes: 1_000, expectedCiphertextBytes: 4_096 },
  { operationBytes: 4_077, expectedCiphertextBytes: 8_192 }
] as const;

/** Vector V1-PADDING: an operation this large is rejected before rounding, not merely at the cap. */
export const VECTOR_V1_PADDING_REJECTED_OPERATION_BYTES = 16_777_197;

/** Vector V1-SEQUENCE fixture tuple. */
export const VECTOR_V1_SEQUENCE = {
  deviceId: "22222222222222222222222222222222",
  sequence: 42,
  digestA: base64Url(sodium.crypto_generichash(32, "cms-sync-fixture/sequence/digest-a", null)),
  digestB: base64Url(sodium.crypto_generichash(32, "cms-sync-fixture/sequence/digest-b", null)),
  pendingSequence: 44,
  rejectedJumpSequence: 1_067
} as const;

// ---------------------------------------------------------------------------
// Operation-set generators
// ---------------------------------------------------------------------------

let fixtureOperationCounter = 0;
function nextFixtureOrdinal(): number {
  fixtureOperationCounter += 1;
  return fixtureOperationCounter;
}

export function buildCanonicalAppendOperation(overrides: Partial<PlainSyncOperation> = {}): PlainSyncOperation {
  const base: PlainSyncOperation = {
    causalHeads: [],
    domain: OPERATION_DOMAIN,
    operationId: syntheticId(`operation-${nextFixtureOrdinal()}`),
    operationType: "canonical.append",
    originDeviceId: SYNTHETIC_DEVICE_ALPHA.deviceId,
    originSequence: 1,
    protocol: SYNC_PROTOCOL_ID,
    body: {
      personId: SYNTHETIC_PERSON_ID,
      sourceId: SYNTHETIC_SOURCE_ID,
      scopeId: SYNTHETIC_SCOPE_ID,
      canonicalEventId: syntheticId(`event-${nextFixtureOrdinal()}`),
      canonicalEvent: {
        role: "user",
        content: "Synthetic fixture content only.",
        occurredAt: FIXED_SYNC_NOW
      }
    }
  };
  return { ...base, ...overrides } as PlainSyncOperation;
}

export function buildTombstoneCreateOperation(overrides: Partial<PlainSyncOperation> = {}): PlainSyncOperation {
  const base: PlainSyncOperation = {
    causalHeads: [],
    domain: OPERATION_DOMAIN,
    operationId: syntheticId(`tombstone-${nextFixtureOrdinal()}`),
    operationType: "tombstone.create",
    originDeviceId: SYNTHETIC_DEVICE_ALPHA.deviceId,
    originSequence: 2,
    protocol: SYNC_PROTOCOL_ID,
    body: {
      personId: SYNTHETIC_PERSON_ID,
      targetType: "canonical_event",
      targetId: syntheticId(`target-${nextFixtureOrdinal()}`),
      deletedAt: FIXED_SYNC_NOW,
      actorDeviceId: SYNTHETIC_DEVICE_ALPHA.deviceId
    }
  };
  return { ...base, ...overrides } as PlainSyncOperation;
}

/** Deterministic sequence of operations with strictly increasing originSequence. */
export function buildOperationSequence(count: number, deviceId: string = SYNTHETIC_DEVICE_ALPHA.deviceId): PlainSyncOperation[] {
  return Array.from({ length: count }, (_unused, index) =>
    buildCanonicalAppendOperation({ originDeviceId: deviceId, originSequence: index + 1 }));
}

export function buildMembershipCommit(overrides: Partial<MembershipCommit> = {}): MembershipCommit {
  const base: MembershipCommit = {
    activeDevices: [toDeviceMembershipEntry(SYNTHETIC_DEVICE_ALPHA)],
    controlVersion: 1,
    domain: CONTROL_COMMIT_DOMAIN,
    epoch: 1,
    keyPackageDigests: [base64Url(sodium.crypto_generichash(32, "cms-sync-fixture/key-package/1", null))],
    previousCommitHash: ZERO_DIGEST_BASE64URL,
    previousControlVersion: 0,
    protocol: SYNC_PROTOCOL_ID,
    recoveryCredentialId: SYNTHETIC_RECOVERY_CREDENTIAL_ID,
    revokedDevices: [],
    syncId: SYNTHETIC_SYNC_ID
  };
  return { ...base, ...overrides } as MembershipCommit;
}

// ---------------------------------------------------------------------------
// Partition / reorder / duplicate delivery schedules
// ---------------------------------------------------------------------------

/** Deterministically reorders items using a fixed-seed shuffle (no Math.random). */
export function reorderSchedule<T>(items: readonly T[], seed = 1): T[] {
  const indexed = items.map((item, index) => ({ item, key: (index * 2654435761 + seed) % 2147483647 }));
  return indexed.sort((left, right) => left.key - right.key).map((entry) => entry.item);
}

/** Inserts an exact duplicate immediately after every `interval`-th item. */
export function duplicateSchedule<T>(items: readonly T[], interval = 2): T[] {
  const result: T[] = [];
  items.forEach((item, index) => {
    result.push(item);
    if ((index + 1) % interval === 0) result.push(item);
  });
  return result;
}

/** Splits items round-robin into `partitionCount` disjoint delivery partitions. */
export function partitionSchedule<T>(items: readonly T[], partitionCount: number): T[][] {
  const partitions: T[][] = Array.from({ length: partitionCount }, () => []);
  items.forEach((item, index) => {
    partitions[index % partitionCount]?.push(item);
  });
  return partitions;
}
