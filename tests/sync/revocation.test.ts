import { describe, expect, it } from "vitest";
import { LibsodiumCryptoProvider } from "../../src/sync/crypto/libsodium-crypto-provider.js";
import { SyncProtocolError } from "../../src/sync/domain/types.js";
import type { CurrentControlState, DeviceIdentity } from "../../src/sync/control/sync-control-service.js";
import { createControlTestHarness, fixedClock } from "./control-fixtures.js";

/**
 * Device revocation and future-only epoch rotation (ADR 0047 "Device
 * revocation and future-only rotation"; Plan 06-06 Task 2). Revocation
 * denies future upload/fetch/key-unwrap by the revoked credential and
 * rotates an independently random future epoch to remaining active devices
 * only, without rewriting historical ciphertext or claiming remote erasure.
 */

const genesisSigner = new LibsodiumCryptoProvider();
const PERSON_ID = "11111111111111111111111111111111".slice(0, 32);

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function sortDevices<T extends { deviceId: string }>(devices: T[]): T[] {
  return [...devices].sort((left, right) => (left.deviceId < right.deviceId ? -1 : left.deviceId > right.deviceId ? 1 : 0));
}

async function genesisCommitFor(harness: ReturnType<typeof createControlTestHarness>, syncId: string, device: DeviceIdentity) {
  const commit = {
    activeDevices: [{ deviceId: device.deviceId, signingPublicKey: b64(device.signing.publicKey), wrappingPublicKey: b64(device.wrapping.publicKey) }],
    controlVersion: 1,
    domain: "cms.sync.v1/control-commit" as const,
    epoch: 1,
    keyPackageDigests: [] as string[],
    previousCommitHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    previousControlVersion: 0,
    protocol: "cms-sync-v1" as const,
    recoveryCredentialId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    revokedDevices: [] as string[],
    syncId
  };
  const signature = b64(genesisSigner.sign(device.signing.secretKey, genesisSigner.canonicalBytes(commit)));
  const outcome = await harness.newRelaySession().compareAndSwapMembership({ commit, signature });
  if (outcome.status !== "committed") throw new Error("genesis commit failed");
  const currentControl: CurrentControlState = {
    controlVersion: outcome.record.controlVersion,
    commitHash: outcome.record.commitDigest,
    epoch: 1,
    activeDevices: commit.activeDevices,
    revokedDevices: [],
    recoveryCredentialId: commit.recoveryCredentialId
  };
  return currentControl;
}

async function addActiveDevice(
  harness: ReturnType<typeof createControlTestHarness>,
  syncId: string,
  signer: DeviceIdentity,
  currentControl: CurrentControlState,
  newDevice: DeviceIdentity
): Promise<CurrentControlState> {
  const activeDevices = sortDevices([
    ...currentControl.activeDevices,
    { deviceId: newDevice.deviceId, signingPublicKey: b64(newDevice.signing.publicKey), wrappingPublicKey: b64(newDevice.wrapping.publicKey) }
  ]);
  const commit = {
    activeDevices,
    controlVersion: currentControl.controlVersion + 1,
    domain: "cms.sync.v1/control-commit" as const,
    epoch: currentControl.epoch,
    keyPackageDigests: [] as string[],
    previousCommitHash: currentControl.commitHash,
    previousControlVersion: currentControl.controlVersion,
    protocol: "cms-sync-v1" as const,
    recoveryCredentialId: currentControl.recoveryCredentialId,
    revokedDevices: [...currentControl.revokedDevices],
    syncId
  };
  const signature = b64(genesisSigner.sign(signer.signing.secretKey, genesisSigner.canonicalBytes(commit)));
  const outcome = await harness.newRelaySession().compareAndSwapMembership({ commit, signature });
  if (outcome.status !== "committed") throw new Error("add-device commit failed");
  return {
    controlVersion: outcome.record.controlVersion,
    commitHash: outcome.record.commitDigest,
    epoch: currentControl.epoch,
    activeDevices,
    revokedDevices: currentControl.revokedDevices,
    recoveryCredentialId: currentControl.recoveryCredentialId
  };
}

async function seedTwoActiveDevices(harness: ReturnType<typeof createControlTestHarness>, clock: () => string) {
  const syncId = await harness.resolveSyncId();
  const service = harness.newControlService(clock);
  const alpha: DeviceIdentity = await service.createDeviceIdentity(PERSON_ID, syncId);
  const beta: DeviceIdentity = await service.createDeviceIdentity(PERSON_ID, syncId);

  const afterGenesis = await genesisCommitFor(harness, syncId, alpha);
  const currentControl = await addActiveDevice(harness, syncId, alpha, afterGenesis, beta);

  return { service, alpha, beta, currentControl, syncId };
}

describe("device revocation and future-only epoch rotation", () => {
  it("removes the target device, mints an independent next epoch, and packages it only to remaining active devices", async () => {
    const harness = createControlTestHarness();
    const clock = fixedClock();
    const { alpha, beta, currentControl, syncId } = await seedTwoActiveDevices(harness, clock);
    const alphaService = harness.newControlService(clock);

    const { controlRecord, epoch, newEpochKey } = await alphaService.revokeDevice({
      personId: PERSON_ID,
      syncId,
      actingDevice: alpha,
      currentControl,
      revokedDeviceId: beta.deviceId
    });

    expect(controlRecord.controlVersion).toBe(3);
    expect(epoch).toBe(2);

    const canonicalCommit = JSON.parse(Buffer.from(controlRecord.canonicalCommitBytes, "base64url").toString("utf8"));
    expect(canonicalCommit.activeDevices.map((d: { deviceId: string }) => d.deviceId)).toEqual([alpha.deviceId]);
    expect(canonicalCommit.revokedDevices).toEqual([beta.deviceId]);

    // The new epoch key is independent random material, never derived from the prior one.
    expect(newEpochKey).toHaveLength(32);
  });

  it("a currently-active remaining device (not the revoking device) can import the freshly rotated epoch key", async () => {
    const harness = createControlTestHarness();
    const clock = fixedClock();
    const syncId = await harness.resolveSyncId();
    const service = harness.newControlService(clock);
    const alpha: DeviceIdentity = await service.createDeviceIdentity(PERSON_ID, syncId);
    const beta: DeviceIdentity = await service.createDeviceIdentity(PERSON_ID, syncId);
    const gamma: DeviceIdentity = await service.createDeviceIdentity(PERSON_ID, syncId);

    const afterGenesis = await genesisCommitFor(harness, syncId, alpha);
    const afterBeta = await addActiveDevice(harness, syncId, alpha, afterGenesis, beta);
    const currentControl = await addActiveDevice(harness, syncId, alpha, afterBeta, gamma);

    const alphaService = harness.newControlService(clock);
    const betaService = harness.newControlService(clock);
    const { newEpochKey, epoch } = await alphaService.revokeDevice({
      personId: PERSON_ID,
      syncId,
      actingDevice: alpha,
      currentControl,
      revokedDeviceId: gamma.deviceId
    });

    const imported = await betaService.importRotatedEpochKey({
      personId: PERSON_ID,
      syncId,
      myDeviceId: beta.deviceId,
      myWrapping: beta.wrapping,
      publisherDeviceId: alpha.deviceId,
      publisherWrappingPublicKey: b64(alpha.wrapping.publicKey)
    });
    expect(imported.map((entry) => entry.epoch)).toEqual([epoch]);
    expect(Buffer.from(imported[0].key)).toEqual(Buffer.from(newEpochKey));

    // The revoked device is denied future participation: it is neither in
    // `activeDevices` nor addressed by the new package.
    await expect(alphaService.importRotatedEpochKey({
      personId: PERSON_ID,
      syncId,
      myDeviceId: gamma.deviceId,
      myWrapping: gamma.wrapping,
      publisherDeviceId: alpha.deviceId,
      publisherWrappingPublicKey: b64(alpha.wrapping.publicKey)
    })).rejects.toMatchObject({ code: "SYNC_INCOMPLETE" });
  });

  it("rejects revoking a device that is not currently active", async () => {
    const harness = createControlTestHarness();
    const clock = fixedClock();
    const { alpha, currentControl, syncId } = await seedTwoActiveDevices(harness, clock);
    const alphaService = harness.newControlService(clock);

    await expect(alphaService.revokeDevice({
      personId: PERSON_ID,
      syncId,
      actingDevice: alpha,
      currentControl,
      revokedDeviceId: "ffffffffffffffffffffffffffffffff"
    })).rejects.toMatchObject({ code: "SYNC_DEVICE_DENIED" });
  });

  it("refuses to revoke the last remaining active device", async () => {
    const harness = createControlTestHarness();
    const clock = fixedClock();
    const syncId = await harness.resolveSyncId();
    const service = harness.newControlService(clock);
    const solo: DeviceIdentity = await service.createDeviceIdentity(PERSON_ID, syncId);
    const commit = {
      activeDevices: [{ deviceId: solo.deviceId, signingPublicKey: b64(solo.signing.publicKey), wrappingPublicKey: b64(solo.wrapping.publicKey) }],
      controlVersion: 1,
      domain: "cms.sync.v1/control-commit" as const,
      epoch: 1,
      keyPackageDigests: [] as string[],
      previousCommitHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      previousControlVersion: 0,
      protocol: "cms-sync-v1" as const,
      recoveryCredentialId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      revokedDevices: [] as string[],
      syncId
    };
    const signature = b64(genesisSigner.sign(solo.signing.secretKey, genesisSigner.canonicalBytes(commit)));
    const outcome = await harness.newRelaySession().compareAndSwapMembership({ commit, signature });
    if (outcome.status !== "committed") throw new Error("genesis commit failed");

    await expect(service.revokeDevice({
      personId: PERSON_ID,
      syncId,
      actingDevice: solo,
      currentControl: {
        controlVersion: outcome.record.controlVersion,
        commitHash: outcome.record.commitDigest,
        epoch: 1,
        activeDevices: commit.activeDevices,
        revokedDevices: [],
        recoveryCredentialId: commit.recoveryCredentialId
      },
      revokedDeviceId: solo.deviceId
    })).rejects.toMatchObject({ code: "SYNC_DEVICE_DENIED" });
  });

  it("a stale (already-superseded) revocation attempt is rejected by the exact-state CAS, never silently forking", async () => {
    const harness = createControlTestHarness();
    const clock = fixedClock();
    const { alpha, beta, currentControl, syncId } = await seedTwoActiveDevices(harness, clock);
    const alphaService = harness.newControlService(clock);

    const first = await alphaService.revokeDevice({
      personId: PERSON_ID, syncId, actingDevice: alpha, currentControl, revokedDeviceId: beta.deviceId
    });
    expect(first.controlRecord.controlVersion).toBe(3);

    await expect(alphaService.revokeDevice({
      personId: PERSON_ID, syncId, actingDevice: alpha, currentControl, revokedDeviceId: beta.deviceId
    })).rejects.toBeInstanceOf(SyncProtocolError);
  });

  it("rejects a control commit that relists a previously-revoked deviceId as active (WR-07)", async () => {
    const harness = createControlTestHarness();
    const clock = fixedClock();
    const { alpha, beta, currentControl, syncId } = await seedTwoActiveDevices(harness, clock);
    const alphaService = harness.newControlService(clock);

    const revocation = await alphaService.revokeDevice({
      personId: PERSON_ID,
      syncId,
      actingDevice: alpha,
      currentControl,
      revokedDeviceId: beta.deviceId
    });

    // A later commit attempts to relist the revoked device as active again.
    const reactivateCommit = {
      activeDevices: sortDevices([
        { deviceId: alpha.deviceId, signingPublicKey: b64(alpha.signing.publicKey), wrappingPublicKey: b64(alpha.wrapping.publicKey) },
        { deviceId: beta.deviceId, signingPublicKey: b64(beta.signing.publicKey), wrappingPublicKey: b64(beta.wrapping.publicKey) }
      ]),
      controlVersion: revocation.controlRecord.controlVersion + 1,
      domain: "cms.sync.v1/control-commit" as const,
      epoch: revocation.epoch,
      keyPackageDigests: [] as string[],
      previousCommitHash: revocation.controlRecord.commitDigest,
      previousControlVersion: revocation.controlRecord.controlVersion,
      protocol: "cms-sync-v1" as const,
      recoveryCredentialId: currentControl.recoveryCredentialId,
      revokedDevices: [] as string[],
      syncId
    };
    const reactivateSignature = b64(genesisSigner.sign(alpha.signing.secretKey, genesisSigner.canonicalBytes(reactivateCommit)));

    const relaySession = harness.newRelaySession();
    const reactivateOutcome = await relaySession.compareAndSwapMembership({
      commit: reactivateCommit,
      signature: reactivateSignature
    });
    expect(reactivateOutcome.status).toBe("conflict");

    // A normal enrollment commit (not reactivating anyone revoked) still succeeds.
    const gamma: DeviceIdentity = await harness.newControlService(clock).createDeviceIdentity(PERSON_ID, syncId);
    const enrollCommit = {
      activeDevices: sortDevices([
        { deviceId: alpha.deviceId, signingPublicKey: b64(alpha.signing.publicKey), wrappingPublicKey: b64(alpha.wrapping.publicKey) },
        { deviceId: gamma.deviceId, signingPublicKey: b64(gamma.signing.publicKey), wrappingPublicKey: b64(gamma.wrapping.publicKey) }
      ]),
      controlVersion: revocation.controlRecord.controlVersion + 1,
      domain: "cms.sync.v1/control-commit" as const,
      epoch: revocation.epoch,
      keyPackageDigests: [] as string[],
      previousCommitHash: revocation.controlRecord.commitDigest,
      previousControlVersion: revocation.controlRecord.controlVersion,
      protocol: "cms-sync-v1" as const,
      recoveryCredentialId: currentControl.recoveryCredentialId,
      revokedDevices: [] as string[],
      syncId
    };
    const enrollSignature = b64(genesisSigner.sign(alpha.signing.secretKey, genesisSigner.canonicalBytes(enrollCommit)));
    const enrollOutcome = await harness.newRelaySession().compareAndSwapMembership({
      commit: enrollCommit,
      signature: enrollSignature
    });
    expect(enrollOutcome.status).toBe("committed");
  });
});
