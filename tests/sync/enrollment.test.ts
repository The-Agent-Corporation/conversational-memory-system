import { describe, expect, it } from "vitest";
import { SyncProtocolError } from "../../src/sync/domain/types.js";
import type { CurrentControlState, DeviceIdentity } from "../../src/sync/control/sync-control-service.js";
import { LibsodiumCryptoProvider } from "../../src/sync/crypto/libsodium-crypto-provider.js";
import { createControlTestHarness, fixedClock } from "./control-fixtures.js";

const genesisSigner = new LibsodiumCryptoProvider();
const PERSON_ID = "11111111111111111111111111111111".slice(0, 32);

/**
 * Normal remote enrollment: transcript-bound verification code, dual-active
 * -device/candidate independent derivation, complete historical-keyring
 * transfer, and replay/expiry/mismatch/scope-boundary failure modes
 * (ADR 0047 "Normal remote enrollment"; Plan 06-06 Task 1).
 */

async function seedGenesisDevice(harness: ReturnType<typeof createControlTestHarness>, clock: () => string) {
  const syncId = await harness.resolveSyncId();
  const service = harness.newControlService(clock);
  const owner: DeviceIdentity = await service.createDeviceIdentity(PERSON_ID, syncId);
  const genesisCommit = {
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
    syncId
  };
  const signature = b64(genesisSigner.sign(owner.signing.secretKey, genesisSigner.canonicalBytes(genesisCommit)));
  const relaySession = harness.newRelaySession();
  const outcome = await relaySession.compareAndSwapMembership({ commit: genesisCommit, signature });
  if (outcome.status !== "committed") throw new Error("genesis commit failed");

  await service.storeEpochKey(PERSON_ID, syncId, owner.deviceId, 1, new Uint8Array(32).fill(7));

  const currentControl: CurrentControlState = {
    controlVersion: outcome.record.controlVersion,
    commitHash: outcome.record.commitDigest,
    epoch: 1,
    activeDevices: genesisCommit.activeDevices,
    revokedDevices: [],
    recoveryCredentialId: genesisCommit.recoveryCredentialId
  };
  return { service, owner, currentControl, syncId };
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

describe("normal remote enrollment", () => {
  it("matching-code active-device enrollment succeeds once and reconstructs historical epoch packages", async () => {
    const harness = createControlTestHarness();
    const clock = fixedClock();
    const { service: approverService, owner, currentControl, syncId } = await seedGenesisDevice(harness, clock);

    const candidateService = harness.newControlService(clock);
    const { record: request, candidate, ephemeral } = await candidateService.requestEnrollment({
      personId: PERSON_ID,
      syncId,
      deviceName: "Candidate Laptop",
      activeDevices: currentControl.activeDevices
    });

    const decryptedName = approverService.decryptRequestedDeviceName(request, owner.deviceId, owner.wrapping);
    expect(decryptedName).toBe("Candidate Laptop");

    const approverCode = approverService.computeApproverTranscriptCode({
      request,
      approverDeviceId: owner.deviceId,
      approverWrapping: owner.wrapping
    });
    const candidateCode = candidateService.computeCandidateTranscriptCode({
      request,
      approverDeviceId: owner.deviceId,
      approverWrappingPublicKey: b64(owner.wrapping.publicKey),
      candidateEphemeralSecretKey: ephemeral.secretKey
    });
    expect(candidateCode).toBe(approverCode);

    const { controlRecord } = await approverService.approveEnrollment({
      request,
      approver: owner,
      currentControl,
      confirmedCode: candidateCode,
      expectedCode: approverCode,
      historicalEpochKeys: [{ epoch: 1, key: new Uint8Array(32).fill(7) }]
    });
    expect(controlRecord.controlVersion).toBe(2);

    const imported = await candidateService.completeEnrollment({
      personId: PERSON_ID,
      syncId,
      myDeviceId: candidate.deviceId,
      myWrapping: candidate.wrapping,
      approverDeviceId: owner.deviceId,
      approverWrappingPublicKey: b64(owner.wrapping.publicKey)
    });
    expect(imported).toHaveLength(1);
    expect(imported[0].epoch).toBe(1);
    expect(Buffer.from(imported[0].key)).toEqual(Buffer.from(new Uint8Array(32).fill(7)));
  });

  it("rejects a mismatched confirmation code without committing", async () => {
    const harness = createControlTestHarness();
    const clock = fixedClock();
    const { service: approverService, owner, currentControl, syncId } = await seedGenesisDevice(harness, clock);
    const candidateService = harness.newControlService(clock);
    const { record: request } = await candidateService.requestEnrollment({
      personId: PERSON_ID,
      syncId,
      deviceName: "Candidate",
      activeDevices: currentControl.activeDevices
    });
    const approverCode = approverService.computeApproverTranscriptCode({ request, approverDeviceId: owner.deviceId, approverWrapping: owner.wrapping });

    await expect(approverService.approveEnrollment({
      request,
      approver: owner,
      currentControl,
      confirmedCode: "0000-0000-0000-0000",
      expectedCode: approverCode,
      historicalEpochKeys: []
    })).rejects.toMatchObject({ code: "SYNC_INTEGRITY_FAILED" });
  });

  it("rejects an expired enrollment request", async () => {
    const harness = createControlTestHarness();
    const clock = fixedClock();
    const { service: approverService, owner, currentControl, syncId } = await seedGenesisDevice(harness, clock);
    const candidateService = harness.newControlService(clock);
    const { record: request } = await candidateService.requestEnrollment({
      personId: PERSON_ID,
      syncId,
      deviceName: "Candidate",
      activeDevices: currentControl.activeDevices,
      expiresInMs: 1
    });
    const code = approverService.computeApproverTranscriptCode({ request, approverDeviceId: owner.deviceId, approverWrapping: owner.wrapping });

    await expect(approverService.approveEnrollment({
      request,
      approver: owner,
      currentControl,
      confirmedCode: code,
      expectedCode: code,
      historicalEpochKeys: [],
      now: "2030-01-02T03:20:00.000Z"
    })).rejects.toMatchObject({ code: "SYNC_EXPIRED" });
  });

  it("a request ID is single-use: a second approval attempt is rejected as a control conflict", async () => {
    const harness = createControlTestHarness();
    const clock = fixedClock();
    const { service: approverService, owner, currentControl, syncId } = await seedGenesisDevice(harness, clock);
    const candidateService = harness.newControlService(clock);
    const { record: request } = await candidateService.requestEnrollment({
      personId: PERSON_ID,
      syncId,
      deviceName: "Candidate",
      activeDevices: currentControl.activeDevices
    });
    const code = approverService.computeApproverTranscriptCode({ request, approverDeviceId: owner.deviceId, approverWrapping: owner.wrapping });

    const first = await approverService.approveEnrollment({
      request, approver: owner, currentControl, confirmedCode: code, expectedCode: code, historicalEpochKeys: []
    });
    expect(first.controlRecord.controlVersion).toBe(2);

    // Replay using the same stale `currentControl` (as the approver would if it failed to
    // refresh) is rejected by the relay's exact-state CAS, never silently rebasing.
    await expect(approverService.approveEnrollment({
      request, approver: owner, currentControl, confirmedCode: code, expectedCode: code, historicalEpochKeys: []
    })).rejects.toBeInstanceOf(SyncProtocolError);
  });

  it("rejects enrolling a device ID that is already active", async () => {
    const harness = createControlTestHarness();
    const clock = fixedClock();
    const { service: approverService, owner, currentControl, syncId } = await seedGenesisDevice(harness, clock);

    await expect(approverService.approveEnrollment({
      request: {
        syncId,
        requestId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        candidateDeviceId: owner.deviceId,
        candidateSigningPublicKey: b64(owner.signing.publicKey),
        candidateWrappingPublicKey: b64(owner.wrapping.publicKey),
        candidateEphemeralPublicKey: b64(owner.wrapping.publicKey),
        encryptedNameBlob: b64(new Uint8Array([1])),
        nonce: b64(new Uint8Array(24)),
        expiresAt: "2030-01-02T03:14:05.000Z",
        status: "requested"
      },
      approver: owner,
      currentControl,
      confirmedCode: "X",
      expectedCode: "X",
      historicalEpochKeys: []
    })).rejects.toMatchObject({ code: "SYNC_ALREADY_USED" });
  });

  it("does not alter local person/scope authorization: enrollment only extends relay membership state", async () => {
    const harness = createControlTestHarness();
    const clock = fixedClock();
    const { service: approverService, owner, currentControl, syncId } = await seedGenesisDevice(harness, clock);
    const candidateService = harness.newControlService(clock);
    const { record: request, candidate } = await candidateService.requestEnrollment({
      personId: PERSON_ID,
      syncId,
      deviceName: "Candidate",
      activeDevices: currentControl.activeDevices
    });
    const code = approverService.computeApproverTranscriptCode({ request, approverDeviceId: owner.deviceId, approverWrapping: owner.wrapping });
    const { controlRecord } = await approverService.approveEnrollment({
      request, approver: owner, currentControl, confirmedCode: code, expectedCode: code, historicalEpochKeys: []
    });

    // The commit only ever carries deviceId/signing/wrapping public keys - never a
    // personId, sourceId, scope, or profile label - proving enrollment cannot touch
    // local MCP person/scope authorization (D-15), which lives entirely outside this
    // relay-visible commit's schema.
    const canonicalCommit = JSON.parse(Buffer.from(controlRecord.canonicalCommitBytes, "base64url").toString("utf8"));
    expect(Object.keys(canonicalCommit).sort()).toEqual([
      "activeDevices", "controlVersion", "domain", "epoch", "keyPackageDigests",
      "previousCommitHash", "previousControlVersion", "protocol", "recoveryCredentialId",
      "revokedDevices", "syncId"
    ]);
    expect(candidate.deviceId).not.toBe(PERSON_ID);
  });
});
