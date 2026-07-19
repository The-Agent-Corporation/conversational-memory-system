import { randomBytes } from "node:crypto";
import canonicalize from "canonicalize";
import sodium from "libsodium-wrappers-sumo";
import {
  RELAY_ZERO_DIGEST_BASE64URL,
  type DataEnvelopeInput,
  type RelayMembershipCommit
} from "../../src/relay/domain/types.js";

await sodium.ready;

/**
 * Synthetic, deterministic test-only fixtures for the relay-side test
 * suites (Plan 06-05). Every key, ID, and byte sequence here is fixed and
 * fake; none resolve to any real account, device, or history.
 */

export function randomId(): string {
  return randomBytes(16).toString("hex");
}

function canonicalBytes(value: unknown): Uint8Array {
  const text = canonicalize(value);
  if (text === undefined) throw new Error("Failed to canonicalize fixture value");
  return new TextEncoder().encode(text);
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export interface FixtureDevice {
  deviceId: string;
  signingPublicKey: string;
  signingSecretKey: Uint8Array;
  wrappingPublicKey: string;
}

export function createFixtureDevice(): FixtureDevice {
  const signing = sodium.crypto_sign_keypair();
  const wrapping = sodium.crypto_box_keypair();
  return {
    deviceId: randomId(),
    signingPublicKey: toBase64Url(signing.publicKey),
    signingSecretKey: signing.privateKey,
    wrappingPublicKey: toBase64Url(wrapping.publicKey)
  };
}

export function signCommit(device: FixtureDevice, commit: RelayMembershipCommit): string {
  return toBase64Url(sodium.crypto_sign_detached(canonicalBytes(commit), device.signingSecretKey));
}

export function genesisCommit(syncId: string, device: FixtureDevice): RelayMembershipCommit {
  return {
    activeDevices: [{ deviceId: device.deviceId, signingPublicKey: device.signingPublicKey, wrappingPublicKey: device.wrappingPublicKey }],
    controlVersion: 1,
    domain: "cms.sync.v1/control-commit",
    epoch: 1,
    keyPackageDigests: [],
    previousCommitHash: RELAY_ZERO_DIGEST_BASE64URL,
    previousControlVersion: 0,
    protocol: "cms-sync-v1",
    recoveryCredentialId: randomId(),
    revokedDevices: [],
    syncId
  };
}

export function nextCommit(
  previous: { controlVersion: number; commitDigest: string },
  overrides: Partial<RelayMembershipCommit> & Pick<RelayMembershipCommit, "syncId" | "activeDevices">
): RelayMembershipCommit {
  return {
    controlVersion: previous.controlVersion + 1,
    domain: "cms.sync.v1/control-commit",
    epoch: 1,
    keyPackageDigests: [],
    previousCommitHash: previous.commitDigest,
    previousControlVersion: previous.controlVersion,
    protocol: "cms-sync-v1",
    recoveryCredentialId: randomId(),
    revokedDevices: [],
    ...overrides
  };
}

export function sortDevices<T extends { deviceId: string }>(devices: T[]): T[] {
  return [...devices].sort((a, b) => a.deviceId.localeCompare(b.deviceId));
}

export function makeEnvelope(
  device: FixtureDevice,
  syncId: string,
  sequence: number,
  previousEnvelopeHash: string,
  options: { epoch?: number; ciphertextByteLength?: number; createdAt?: string; objectId?: string } = {}
): DataEnvelopeInput {
  const ciphertextByteLength = options.ciphertextByteLength ?? 32;
  const ciphertext = randomBytes(ciphertextByteLength);
  const nonce = randomBytes(24);
  const header = {
    ciphertextLength: ciphertextByteLength,
    createdAt: options.createdAt ?? "2030-01-02T03:04:05.000Z",
    deviceId: device.deviceId,
    epoch: options.epoch ?? 1,
    objectId: options.objectId ?? randomId(),
    paddingPolicy: "cms-sync-padding-v1" as const,
    previousEnvelopeHash,
    protocol: "cms-sync-v1" as const,
    sequence,
    syncId
  };
  const ciphertextDigest = toBase64Url(sodium.crypto_generichash(32, ciphertext, null));
  const signaturePreimage = canonicalBytes({
    ciphertextDigest,
    domain: "cms.sync.v1/envelope-signature",
    header,
    nonce: toBase64Url(nonce)
  });
  const signature = toBase64Url(sodium.crypto_sign_detached(signaturePreimage, device.signingSecretKey));
  return {
    header,
    nonce: toBase64Url(nonce),
    ciphertext: toBase64Url(ciphertext),
    ciphertextDigest,
    signature
  };
}

export const FIXED_ZERO_DIGEST = RELAY_ZERO_DIGEST_BASE64URL;
