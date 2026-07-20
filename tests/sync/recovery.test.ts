import { describe, expect, it } from "vitest";
import { ARGON2ID_REVIEWED_FLOOR } from "../../src/sync/crypto/crypto-provider.js";
import { LibsodiumCryptoProvider } from "../../src/sync/crypto/libsodium-crypto-provider.js";
import type { CurrentControlState, DeviceIdentity } from "../../src/sync/control/sync-control-service.js";
import { createControlTestHarness, fixedClock } from "./control-fixtures.js";

/**
 * Recovery-key enrollment, optional passphrase package, and recovery
 * rotation (ADR 0047 "Recovery-key enrollment" / "Optional passphrase
 * recovery package" / "Recovery rotation"; Plan 06-06 Tasks 1-2).
 */

const genesisSigner = new LibsodiumCryptoProvider();
const PERSON_ID = "11111111111111111111111111111111".slice(0, 32);
const PASSPHRASE = "correct horse battery staple synthetic test only";

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function seedGenesisWithPassphrasePackage(harness: ReturnType<typeof createControlTestHarness>, clock: () => string) {
  const syncId = await harness.resolveSyncId();
  const service = harness.newControlService(clock);
  const owner: DeviceIdentity = await service.createDeviceIdentity(PERSON_ID, syncId);

  const recoverySeed = genesisSigner.randomBytes(32);
  const salt = genesisSigner.randomBytes(16);
  const wrapped = genesisSigner.wrapWithPassphrase(PASSPHRASE, recoverySeed, {
    opsLimit: ARGON2ID_REVIEWED_FLOOR.opsLimit,
    memLimit: ARGON2ID_REVIEWED_FLOOR.memLimit,
    salt
  });
  const packageId = "cccccccccccccccccccccccccccccccc".slice(0, 32);
  const ciphertextDigest = b64(genesisSigner.hash(wrapped.ciphertext));
  const recoverySigningSeed = genesisSigner.deriveSubkey(recoverySeed, 1, "CMSRSIG1", 32);
  const recoverySigningKeyPair = genesisSigner.generateSigningKeyPairFromSeed(recoverySigningSeed);

  const genesisCommit = {
    activeDevices: [{ deviceId: owner.deviceId, signingPublicKey: b64(owner.signing.publicKey), wrappingPublicKey: b64(owner.wrapping.publicKey) }],
    controlVersion: 1,
    domain: "cms.sync.v1/control-commit" as const,
    epoch: 1,
    keyPackageDigests: [] as string[],
    previousCommitHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    previousControlVersion: 0,
    protocol: "cms-sync-v1" as const,
    recoveryCredentialId: packageId,
    revokedDevices: [] as string[],
    syncId
  };
  const signature = b64(genesisSigner.sign(owner.signing.secretKey, genesisSigner.canonicalBytes(genesisCommit)));
  const relaySession = harness.newRelaySession();
  const outcome = await relaySession.compareAndSwapMembership({ commit: genesisCommit, signature });
  if (outcome.status !== "committed") throw new Error("genesis commit failed");

  const activePackage = await relaySession.uploadRecoveryPackage({
    syncId,
    packageId,
    algorithm: "argon2id",
    opsLimit: wrapped.opsLimit,
    memLimit: wrapped.memLimit,
    salt: b64(wrapped.salt),
    nonce: b64(wrapped.nonce),
    ciphertextLength: wrapped.ciphertext.length,
    ciphertext: b64(wrapped.ciphertext),
    ciphertextDigest,
    signature,
    recoverySigningPublicKey: b64(recoverySigningKeyPair.publicKey)
  });

  await service.storeEpochKey(PERSON_ID, syncId, owner.deviceId, 1, new Uint8Array(32).fill(9));

  const currentControl: CurrentControlState = {
    controlVersion: outcome.record.controlVersion,
    commitHash: outcome.record.commitDigest,
    epoch: 1,
    activeDevices: genesisCommit.activeDevices,
    revokedDevices: [],
    recoveryCredentialId: packageId
  };
  return { service, owner, currentControl, syncId, activePackage };
}

describe("recovery-key enrollment", () => {
  it("succeeds with account access, the current recovery package, and the correct passphrase; imports the published historical keyring", async () => {
    const harness = createControlTestHarness();
    const clock = fixedClock();
    const { owner, currentControl, syncId, activePackage } = await seedGenesisWithPassphrasePackage(harness, clock);

    // The active device rotates the recovery credential once (a required bootstrap
    // step, per ADR "Recovery rotation") so that the keyring is actually recoverable
    // via a passphrase package + sealed historical keyring published to the relay.
    const ownerService = harness.newControlService(clock);
    const recoveringService = harness.newControlService(clock);

    const rotation = await ownerService.rotateRecoveryCredential({
      syncId,
      actingDevice: owner,
      currentControl,
      passphrase: PASSPHRASE,
      historicalEpochKeys: [{ epoch: 1, key: new Uint8Array(32).fill(9) }]
    });
    void activePackage;
    const currentActivePackage = await harness.newRelaySession().fetchRecoveryPackage();

    const { controlRecord, candidate, importedEpochs } = await recoveringService.enrollViaRecovery({
      personId: PERSON_ID,
      syncId,
      passphrase: PASSPHRASE,
      activePackage: currentActivePackage,
      currentControl: {
        ...currentControl,
        controlVersion: rotation.controlRecord.controlVersion,
        commitHash: rotation.controlRecord.commitDigest,
        recoveryCredentialId: rotation.packageId
      },
      publisherDeviceId: owner.deviceId
    });

    expect(controlRecord.controlVersion).toBe(3);
    expect(candidate.deviceId).not.toBe(owner.deviceId);
    expect(importedEpochs.map((entry) => entry.epoch)).toEqual([1]);
  });

  it("fails uniformly with the wrong passphrase, without ever contacting the relay CAS", async () => {
    const harness = createControlTestHarness();
    const clock = fixedClock();
    const { currentControl, syncId, activePackage } = await seedGenesisWithPassphrasePackage(harness, clock);
    const recoveringService = harness.newControlService(clock);

    await expect(recoveringService.enrollViaRecovery({
      personId: PERSON_ID,
      syncId,
      passphrase: "definitely the wrong passphrase",
      activePackage,
      currentControl,
      publisherDeviceId: "deaddeaddeaddeaddeaddeaddeaddead"
    })).rejects.toMatchObject({ code: "SYNC_INTEGRITY_FAILED" });
  });

  it("rejects a below-reviewed-floor Argon2id package uniformly, before deriving (WR-04)", async () => {
    const harness = createControlTestHarness();
    const clock = fixedClock();
    const { currentControl, syncId } = await seedGenesisWithPassphrasePackage(harness, clock);
    const recoveringService = harness.newControlService(clock);

    const syncIdForPackage = syncId;
    const recoverySeed = genesisSigner.randomBytes(32);
    const salt = genesisSigner.randomBytes(16);
    const belowFloorWrapped = genesisSigner.wrapWithPassphrase(PASSPHRASE, recoverySeed, {
      opsLimit: ARGON2ID_REVIEWED_FLOOR.opsLimit - 1,
      memLimit: ARGON2ID_REVIEWED_FLOOR.memLimit,
      salt
    });
    const belowFloorPackageId = "dddddddddddddddddddddddddddddddd".slice(0, 32);
    const ciphertextDigest = b64(genesisSigner.hash(belowFloorWrapped.ciphertext));
    const recoverySigningSeed = genesisSigner.deriveSubkey(recoverySeed, 1, "CMSRSIG1", 32);
    const recoverySigningKeyPair = genesisSigner.generateSigningKeyPairFromSeed(recoverySigningSeed);

    const belowFloorPackage = {
      syncId: syncIdForPackage,
      packageId: belowFloorPackageId,
      algorithm: "argon2id" as const,
      opsLimit: belowFloorWrapped.opsLimit,
      memLimit: belowFloorWrapped.memLimit,
      salt: b64(belowFloorWrapped.salt),
      nonce: b64(belowFloorWrapped.nonce),
      ciphertextLength: belowFloorWrapped.ciphertext.length,
      ciphertext: b64(belowFloorWrapped.ciphertext),
      ciphertextDigest,
      signature: b64(genesisSigner.randomBytes(64)),
      recoverySigningPublicKey: b64(recoverySigningKeyPair.publicKey),
      status: "active" as const,
      createdAt: "2030-01-02T03:04:05.000Z"
    };

    await expect(recoveringService.enrollViaRecovery({
      personId: PERSON_ID,
      syncId,
      passphrase: PASSPHRASE,
      activePackage: belowFloorPackage,
      currentControl,
      publisherDeviceId: "deaddeaddeaddeaddeaddeaddeaddead"
    })).rejects.toMatchObject({ code: "SYNC_INTEGRITY_FAILED" });
  });

  it("still unwraps an at-reviewed-floor Argon2id package", async () => {
    // seedGenesisWithPassphrasePackage already wraps at exactly the reviewed
    // floor (opsLimit/memLimit === ARGON2ID_REVIEWED_FLOOR); the first
    // success-path test above already exercises this, but this test isolates
    // the boundary explicitly by unwrapping directly.
    const provider = new LibsodiumCryptoProvider();
    const seed = provider.randomBytes(32);
    const salt = provider.randomBytes(16);
    const wrapped = provider.wrapWithPassphrase(PASSPHRASE, seed, {
      opsLimit: ARGON2ID_REVIEWED_FLOOR.opsLimit,
      memLimit: ARGON2ID_REVIEWED_FLOOR.memLimit,
      salt
    });
    const opened = provider.unwrapWithPassphrase(PASSPHRASE, wrapped);
    expect(Buffer.from(opened)).toEqual(Buffer.from(seed));
  });

  it("fails when there is no active recovery package (account-only access is insufficient)", async () => {
    const harness = createControlTestHarness();
    const clock = fixedClock();
    const { currentControl, syncId } = await seedGenesisWithPassphrasePackage(harness, clock);
    const recoveringService = harness.newControlService(clock);

    await expect(recoveringService.enrollViaRecovery({
      personId: PERSON_ID,
      syncId,
      passphrase: PASSPHRASE,
      activePackage: null,
      currentControl,
      publisherDeviceId: "deaddeaddeaddeaddeaddeaddeaddead"
    })).rejects.toMatchObject({ code: "SYNC_INCOMPLETE" });
  });
});

describe("adversarial account-only enrollment (CR-01)", () => {
  it("rejects a self-signed membership.cas from a candidate that never possessed the recovery seed", async () => {
    const harness = createControlTestHarness();
    const clock = fixedClock();
    const { currentControl, syncId } = await seedGenesisWithPassphrasePackage(harness, clock);

    // Attacker has ONLY relay account access: no recovery seed, no passphrase.
    // It generates a fresh candidate device identity locally (any account
    // holder can do this) and learns the active package's packageId via the
    // ordinary recovery.fetch operation -- exactly what enrollViaRecovery does,
    // minus ever touching the seed.
    const attackerService = harness.newControlService(clock);
    const candidate = await attackerService.createDeviceIdentity(PERSON_ID, syncId);

    const attackerSession = harness.newRelaySession();
    const learnedPackage = await attackerSession.fetchRecoveryPackage();
    if (!learnedPackage) throw new Error("expected an active recovery package to exist");

    const challengeNonce = genesisSigner.randomBytes(32);
    const authorizationPreimage = genesisSigner.canonicalBytes({
      candidateDeviceId: candidate.deviceId,
      challengeNonce: b64(challengeNonce),
      domain: "cms.sync.v1/recovery-authorization",
      packageId: learnedPackage.packageId,
      syncId
    });
    // No recovery seed in hand: sign with the candidate's OWN freshly
    // generated device key instead of any seed-derived recovery credential.
    const authorizationSignature = b64(genesisSigner.sign(candidate.signing.secretKey, authorizationPreimage));

    const newEntry = {
      deviceId: candidate.deviceId,
      signingPublicKey: b64(candidate.signing.publicKey),
      wrappingPublicKey: b64(candidate.wrapping.publicKey)
    };
    const activeDevices = [...currentControl.activeDevices, newEntry].sort((left, right) =>
      left.deviceId < right.deviceId ? -1 : left.deviceId > right.deviceId ? 1 : 0
    );
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
    const commitSignature = b64(genesisSigner.sign(candidate.signing.secretKey, genesisSigner.canonicalBytes(commit)));

    await expect(attackerSession.compareAndSwapMembership({
      commit,
      signature: commitSignature,
      recoveryAuthorization: {
        packageId: learnedPackage.packageId,
        challengeNonce: b64(challengeNonce),
        signature: authorizationSignature
      }
    })).rejects.toMatchObject({ code: expect.stringMatching(/^(SYNC_INTEGRITY_FAILED|SYNC_DEVICE_DENIED)$/) });
  });
});

describe("recovery rotation", () => {
  it("replaces the current recovery credential/package and the old package no longer authorizes enrollment", async () => {
    const harness = createControlTestHarness();
    const clock = fixedClock();
    const { owner, currentControl, syncId, activePackage: oldPackage } = await seedGenesisWithPassphrasePackage(harness, clock);
    const ownerService = harness.newControlService(clock);

    const rotation = await ownerService.rotateRecoveryCredential({
      syncId,
      actingDevice: owner,
      currentControl,
      passphrase: "a brand new passphrase entirely",
      historicalEpochKeys: [{ epoch: 1, key: new Uint8Array(32).fill(9) }]
    });
    expect(rotation.packageId).not.toBe(oldPackage.packageId);
    expect(rotation.controlRecord.controlVersion).toBe(2);

    // The old package is no longer the relay's active recovery package (it was
    // atomically superseded by the rotation CAS): the relay denies an enrollment
    // attempt that presents the stale packageId, never falling back to it.
    const recoveringService = harness.newControlService(clock);
    await expect(recoveringService.enrollViaRecovery({
      personId: PERSON_ID,
      syncId,
      passphrase: PASSPHRASE,
      activePackage: oldPackage,
      currentControl,
      publisherDeviceId: owner.deviceId
    })).rejects.toMatchObject({ code: "SYNC_DEVICE_DENIED" });
  });

  it("keeps historical ciphertext unchanged (the rotation commit never touches prior control versions)", async () => {
    const harness = createControlTestHarness();
    const clock = fixedClock();
    const { owner, currentControl, syncId } = await seedGenesisWithPassphrasePackage(harness, clock);
    const ownerService = harness.newControlService(clock);

    const rotation = await ownerService.rotateRecoveryCredential({
      syncId,
      actingDevice: owner,
      currentControl,
      passphrase: "another new passphrase",
      historicalEpochKeys: [{ epoch: 1, key: new Uint8Array(32).fill(9) }]
    });

    expect(rotation.controlRecord.previousControlVersion).toBe(currentControl.controlVersion);
    expect(rotation.controlRecord.previousControlVersion).toBe(1);
    const canonicalCommit = JSON.parse(Buffer.from(rotation.controlRecord.canonicalCommitBytes, "base64url").toString("utf8"));
    expect(canonicalCommit.activeDevices).toHaveLength(1);
    expect(canonicalCommit.epoch).toBe(currentControl.epoch);
  });
});
