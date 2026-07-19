import {
  CONTROL_COMMIT_DOMAIN,
  ENVELOPE_AAD_DOMAIN,
  ENVELOPE_SIGNATURE_DOMAIN,
  SYNC_PADDING_POLICY_ID,
  SYNC_PROTOCOL_ID,
  SyncProtocolError,
  ZERO_DIGEST_BASE64URL,
  type DeviceMembershipEntry
} from "../domain/types.js";
import type { CryptoProvider, CryptoKeyPair } from "../crypto/crypto-provider.js";
import { ARGON2ID_REVIEWED_FLOOR } from "../crypto/crypto-provider.js";
import type { DeviceSecretStore } from "../secrets/device-secret-store.js";
import type { SyncRelay } from "../transport/sync-relay.js";
import type { DataEnvelopeRecord, EnrollmentRequestRecord, RecoveryPackageRecord } from "../../relay/domain/types.js";

/**
 * Device enrollment, recovery, revocation, and recovery-credential rotation
 * state machines (ADR 0047; Plan 06-06). This module never accepts relay
 * account access alone as authority: every mutating operation requires
 * either an active device signature or the dual (account + current recovery
 * proof) gate before the underlying `SyncRelay.compareAndSwapMembership`
 * CAS is attempted.
 *
 * Historical key-package delivery (candidate/recipient key import) has no
 * dedicated relay wire operation in this protocol revision; this service
 * transports opaque per-recipient packages over the existing append-only
 * `envelope.append`/`envelope.list` data-plane channel, addressed by
 * X25519 box (device recipient) or sealed box (recovery-credential
 * recipient) rather than the operation-level epoch AEAD. This is a
 * documented Plan 06-06 transport decision, not a new relay wire field.
 */

const RECOVERY_AUTHORIZATION_DOMAIN = "cms.sync.v1/recovery-authorization";
const ENROLLMENT_TRANSCRIPT_DOMAIN = "cms.sync.v1/enrollment-transcript";

function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}
function fromB64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

export interface DeviceIdentity {
  deviceId: string;
  signing: CryptoKeyPair;
  wrapping: CryptoKeyPair;
}

export interface CurrentControlState {
  controlVersion: number;
  commitHash: string;
  epoch: number;
  activeDevices: DeviceMembershipEntry[];
  revokedDevices: string[];
  recoveryCredentialId: string;
}

export interface EpochKeyMaterial {
  epoch: number;
  key: Uint8Array;
}

export interface SyncControlServiceOptions {
  relay: SyncRelay;
  crypto: CryptoProvider;
  secrets: DeviceSecretStore;
  clock?: () => string;
  randomId?: () => string;
}

interface KeyringPayload {
  epochs: Array<{ epoch: number; key: string }>;
}

export class SyncControlService {
  private readonly relay: SyncRelay;
  private readonly crypto: CryptoProvider;
  private readonly secrets: DeviceSecretStore;
  private readonly clock: () => string;
  private readonly randomId: () => string;

  constructor(options: SyncControlServiceOptions) {
    this.relay = options.relay;
    this.crypto = options.crypto;
    this.secrets = options.secrets;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.randomId = options.randomId ?? (() => Buffer.from(this.crypto.randomBytes(16)).toString("hex"));
  }

  // -------------------------------------------------------------------
  // Device identity
  // -------------------------------------------------------------------

  /** Generates a fresh device identity and retains its secret keys via `DeviceSecretStore`. */
  async createDeviceIdentity(personId: string, syncId: string): Promise<DeviceIdentity> {
    const deviceId = this.randomId();
    const signing = this.crypto.generateSigningKeyPair();
    const wrapping = this.crypto.generateWrappingKeyPair();
    const binding = { personId, syncId, deviceId };
    await this.secrets.create({
      binding,
      kind: "device_signing_seed",
      secretId: deviceId,
      bytes: concatBytes(signing.publicKey, signing.secretKey)
    });
    await this.secrets.create({
      binding,
      kind: "device_wrapping_seed",
      secretId: deviceId,
      bytes: concatBytes(wrapping.publicKey, wrapping.secretKey)
    });
    return { deviceId, signing, wrapping };
  }

  /** Persists an epoch key for `deviceId` (own-copy retention; never transmitted from here). */
  async storeEpochKey(personId: string, syncId: string, deviceId: string, epoch: number, key: Uint8Array): Promise<void> {
    await this.secrets.create({
      binding: { personId, syncId, deviceId, epoch },
      kind: "epoch_key",
      secretId: `epoch:${epoch}`,
      bytes: key
    });
  }

  // -------------------------------------------------------------------
  // Normal remote enrollment: candidate side
  // -------------------------------------------------------------------

  async requestEnrollment(input: {
    personId: string;
    syncId: string;
    deviceName: string;
    activeDevices: DeviceMembershipEntry[];
    expiresInMs?: number;
  }): Promise<{
    record: EnrollmentRequestRecord;
    candidate: DeviceIdentity;
    ephemeral: CryptoKeyPair;
    requestNonce: Uint8Array;
  }> {
    if (input.activeDevices.length === 0) throw new SyncProtocolError("SYNC_DEVICE_DENIED");
    const candidate = await this.createDeviceIdentity(input.personId, input.syncId);
    const ephemeral = this.crypto.generateWrappingKeyPair();
    const requestNonce = this.crypto.randomBytes(32);
    const expiresAt = new Date(Date.parse(this.clock()) + (input.expiresInMs ?? 10 * 60 * 1000)).toISOString().replace(/(\.\d{3})\d*Z$/, "$1Z");

    const nameBytes = new TextEncoder().encode(input.deviceName);
    const sealedForEachActiveDevice = input.activeDevices.map((device) => ({
      deviceId: device.deviceId,
      sealed: toB64(this.crypto.sealedBox(fromB64(device.wrappingPublicKey), nameBytes))
    }));
    const encryptedNameBlob = toB64(new TextEncoder().encode(JSON.stringify(sealedForEachActiveDevice)));

    const record = await this.relay.submitEnrollmentRequest({
      syncId: input.syncId,
      requestId: this.randomId(),
      candidateDeviceId: candidate.deviceId,
      candidateSigningPublicKey: toB64(candidate.signing.publicKey),
      candidateWrappingPublicKey: toB64(candidate.wrapping.publicKey),
      candidateEphemeralPublicKey: toB64(ephemeral.publicKey),
      encryptedNameBlob,
      nonce: toB64(requestNonce.slice(0, 24)),
      expiresAt
    });

    return { record, candidate, ephemeral, requestNonce };
  }

  /** Decrypts the device-name blob addressed to `myDeviceId` from a fetched enrollment request. */
  decryptRequestedDeviceName(request: EnrollmentRequestRecord, myDeviceId: string, myWrapping: CryptoKeyPair): string {
    let parsed: Array<{ deviceId: string; sealed: string }>;
    try {
      parsed = JSON.parse(new TextDecoder().decode(fromB64(request.encryptedNameBlob)));
    } catch {
      throw new SyncProtocolError("SYNC_SCHEMA_INVALID");
    }
    const mine = parsed.find((entry) => entry.deviceId === myDeviceId);
    if (!mine) throw new SyncProtocolError("SYNC_DEVICE_DENIED");
    try {
      const opened = this.crypto.openSealedBox(myWrapping.publicKey, myWrapping.secretKey, fromB64(mine.sealed));
      return new TextDecoder().decode(opened);
    } catch {
      throw new SyncProtocolError("SYNC_INTEGRITY_FAILED");
    }
  }

  // -------------------------------------------------------------------
  // Transcript-bound verification code (independently derived by both ends)
  // -------------------------------------------------------------------

  /**
   * Derives the shared session-confirmation key via a non-interactive X25519
   * DH combiner: both endpoints call `crypto.box` with their own secret key
   * and the other party's public key, a fixed nonce, and fixed plaintext.
   * `crypto_box` derives its symmetric key from `scalarmult(secret, public)`,
   * which is identical in both directions, so both sides independently
   * produce byte-identical ciphertext without a further network round trip.
   */
  private deriveSessionConfirmationKey(mySecretKey: Uint8Array, theirPublicKey: Uint8Array): Uint8Array {
    const fixedNonce = this.crypto.hash(new TextEncoder().encode("cms.sync.v1/enrollment-code-nonce")).slice(0, 24);
    const combined = this.crypto.box(mySecretKey, theirPublicKey, fixedNonce, new Uint8Array(16));
    return this.crypto.hash(combined);
  }

  private computeCode(sessionConfirmationKey: Uint8Array, transcript: Record<string, unknown>): string {
    const preimage = concatBytes(
      sessionConfirmationKey,
      new TextEncoder().encode("\0"),
      this.crypto.canonicalBytes(transcript)
    );
    const digest = this.crypto.hash(preimage).slice(0, 8);
    const hex = Buffer.from(digest).toString("hex").toUpperCase();
    return hex.match(/.{1,4}/g)!.join("-");
  }

  private buildTranscript(input: {
    syncId: string;
    requestId: string;
    requestNonce: string;
    candidateDeviceId: string;
    candidateEphemeralKey: string;
    approverDeviceId: string;
    expiresAt: string;
  }): Record<string, unknown> {
    return {
      approverDeviceId: input.approverDeviceId,
      candidateDeviceId: input.candidateDeviceId,
      candidateEphemeralKey: input.candidateEphemeralKey,
      domain: ENROLLMENT_TRANSCRIPT_DOMAIN,
      expiresAt: input.expiresAt,
      protocol: SYNC_PROTOCOL_ID,
      requestId: input.requestId,
      requestNonce: input.requestNonce,
      syncId: input.syncId
    };
  }

  /** Approver-side transcript code, derived from the approver's long-term wrapping key and the candidate's ephemeral key. */
  computeApproverTranscriptCode(input: {
    request: EnrollmentRequestRecord;
    approverDeviceId: string;
    approverWrapping: CryptoKeyPair;
  }): string {
    const sessionKey = this.deriveSessionConfirmationKey(input.approverWrapping.secretKey, fromB64(input.request.candidateEphemeralPublicKey));
    const transcript = this.buildTranscript({
      syncId: input.request.syncId,
      requestId: input.request.requestId,
      requestNonce: input.request.nonce,
      candidateDeviceId: input.request.candidateDeviceId,
      candidateEphemeralKey: input.request.candidateEphemeralPublicKey,
      approverDeviceId: input.approverDeviceId,
      expiresAt: input.request.expiresAt
    });
    return this.computeCode(sessionKey, transcript);
  }

  /** Candidate-side transcript code, derived from the candidate's ephemeral secret key and the approver's long-term wrapping public key. */
  computeCandidateTranscriptCode(input: {
    request: EnrollmentRequestRecord;
    approverDeviceId: string;
    approverWrappingPublicKey: string;
    candidateEphemeralSecretKey: Uint8Array;
  }): string {
    const sessionKey = this.deriveSessionConfirmationKey(input.candidateEphemeralSecretKey, fromB64(input.approverWrappingPublicKey));
    const transcript = this.buildTranscript({
      syncId: input.request.syncId,
      requestId: input.request.requestId,
      requestNonce: input.request.nonce,
      candidateDeviceId: input.request.candidateDeviceId,
      candidateEphemeralKey: input.request.candidateEphemeralPublicKey,
      approverDeviceId: input.approverDeviceId,
      expiresAt: input.request.expiresAt
    });
    return this.computeCode(sessionKey, transcript);
  }

  // -------------------------------------------------------------------
  // Normal remote enrollment: approver side
  // -------------------------------------------------------------------

  async approveEnrollment(input: {
    request: EnrollmentRequestRecord;
    approver: DeviceIdentity;
    currentControl: CurrentControlState;
    confirmedCode: string;
    expectedCode: string;
    historicalEpochKeys: EpochKeyMaterial[];
    now?: string;
  }): Promise<{ controlRecord: import("../../relay/domain/types.js").ControlRecord; keyPackage: DataEnvelopeRecord }> {
    const nowIso = input.now ?? this.clock();
    if (Date.parse(input.request.expiresAt) <= Date.parse(nowIso)) throw new SyncProtocolError("SYNC_EXPIRED");
    if (!this.crypto.constantTimeEqual(
      new TextEncoder().encode(input.confirmedCode),
      new TextEncoder().encode(input.expectedCode)
    )) {
      throw new SyncProtocolError("SYNC_INTEGRITY_FAILED");
    }

    const newEntry: DeviceMembershipEntry = {
      deviceId: input.request.candidateDeviceId,
      signingPublicKey: input.request.candidateSigningPublicKey,
      wrappingPublicKey: input.request.candidateWrappingPublicKey
    };
    if (input.currentControl.activeDevices.some((device) => device.deviceId === newEntry.deviceId)) {
      throw new SyncProtocolError("SYNC_ALREADY_USED");
    }
    const activeDevices = sortByDeviceId([...input.currentControl.activeDevices, newEntry]);

    const commit = {
      activeDevices,
      controlVersion: input.currentControl.controlVersion + 1,
      domain: CONTROL_COMMIT_DOMAIN as typeof CONTROL_COMMIT_DOMAIN,
      epoch: input.currentControl.epoch,
      keyPackageDigests: [] as string[],
      previousCommitHash: input.currentControl.commitHash,
      previousControlVersion: input.currentControl.controlVersion,
      protocol: SYNC_PROTOCOL_ID as typeof SYNC_PROTOCOL_ID,
      recoveryCredentialId: input.currentControl.recoveryCredentialId,
      revokedDevices: [...input.currentControl.revokedDevices],
      syncId: input.request.syncId
    };
    const signature = toB64(this.crypto.sign(input.approver.signing.secretKey, this.crypto.canonicalBytes(commit)));

    const outcome = await this.relay.compareAndSwapMembership({
      commit,
      signature,
      enrollmentRequestId: input.request.requestId
    });
    if (outcome.status !== "committed") throw new SyncProtocolError("SYNC_CONTROL_CONFLICT");

    const payload: KeyringPayload = { epochs: input.historicalEpochKeys.map((entry) => ({ epoch: entry.epoch, key: toB64(entry.key) })) };
    const keyPackage = await this.publishBoxPackage({
      syncId: input.request.syncId,
      authorDeviceId: input.approver.deviceId,
      authorSigningSecretKey: input.approver.signing.secretKey,
      authorWrappingSecretKey: input.approver.wrapping.secretKey,
      recipientWrappingPublicKey: fromB64(newEntry.wrappingPublicKey),
      epoch: input.currentControl.epoch,
      payload
    });

    return { controlRecord: outcome.record, keyPackage };
  }

  /** Candidate side: after a successful CAS, scans the approver's envelope chain for the addressed key package and imports every epoch key. */
  async completeEnrollment(input: {
    personId: string;
    syncId: string;
    myDeviceId: string;
    myWrapping: CryptoKeyPair;
    approverDeviceId: string;
    approverWrappingPublicKey: string;
  }): Promise<EpochKeyMaterial[]> {
    const payload = await this.scanAndOpenBoxPackage({
      authorDeviceId: input.approverDeviceId,
      authorWrappingPublicKey: fromB64(input.approverWrappingPublicKey),
      myWrappingSecretKey: input.myWrapping.secretKey
    });
    if (!payload) throw new SyncProtocolError("SYNC_INCOMPLETE");
    const imported: EpochKeyMaterial[] = [];
    for (const entry of payload.epochs) {
      const key = fromB64(entry.key);
      await this.storeEpochKey(input.personId, input.syncId, input.myDeviceId, entry.epoch, key);
      imported.push({ epoch: entry.epoch, key });
    }
    return imported;
  }

  // -------------------------------------------------------------------
  // Recovery-key enrollment
  // -------------------------------------------------------------------

  async enrollViaRecovery(input: {
    personId: string;
    syncId: string;
    passphrase: string;
    activePackage: RecoveryPackageRecord | null;
    currentControl: CurrentControlState;
    publisherDeviceId: string;
  }): Promise<{
    controlRecord: import("../../relay/domain/types.js").ControlRecord;
    candidate: DeviceIdentity;
    importedEpochs: EpochKeyMaterial[];
  }> {
    if (!input.activePackage) throw new SyncProtocolError("SYNC_INCOMPLETE");

    let seed: Uint8Array;
    try {
      seed = this.crypto.unwrapWithPassphrase(input.passphrase, {
        algorithm: "argon2id",
        opsLimit: input.activePackage.opsLimit,
        memLimit: input.activePackage.memLimit,
        salt: fromB64(input.activePackage.salt),
        nonce: fromB64(input.activePackage.nonce),
        ciphertext: fromB64(input.activePackage.ciphertext)
      });
    } catch {
      throw new SyncProtocolError("SYNC_INTEGRITY_FAILED");
    }

    const wrappingSeed = this.crypto.deriveSubkey(seed, 1, "CMSRBOX1", 32);
    const recoveryWrapping = this.crypto.generateWrappingKeyPairFromSeed(wrappingSeed);
    this.crypto.zero(seed);
    this.crypto.zero(wrappingSeed);

    const candidate = await this.createDeviceIdentity(input.personId, input.syncId);
    const challengeNonce = this.crypto.randomBytes(32);
    const authorizationPreimage = this.crypto.canonicalBytes({
      candidateDeviceId: candidate.deviceId,
      challengeNonce: toB64(challengeNonce),
      domain: RECOVERY_AUTHORIZATION_DOMAIN,
      packageId: input.activePackage.packageId,
      syncId: input.syncId
    });
    const authorizationSignature = toB64(this.crypto.sign(candidate.signing.secretKey, authorizationPreimage));

    const newEntry: DeviceMembershipEntry = {
      deviceId: candidate.deviceId,
      signingPublicKey: toB64(candidate.signing.publicKey),
      wrappingPublicKey: toB64(candidate.wrapping.publicKey)
    };
    const activeDevices = sortByDeviceId([...input.currentControl.activeDevices, newEntry]);
    const commit = {
      activeDevices,
      controlVersion: input.currentControl.controlVersion + 1,
      domain: CONTROL_COMMIT_DOMAIN as typeof CONTROL_COMMIT_DOMAIN,
      epoch: input.currentControl.epoch,
      keyPackageDigests: [] as string[],
      previousCommitHash: input.currentControl.commitHash,
      previousControlVersion: input.currentControl.controlVersion,
      protocol: SYNC_PROTOCOL_ID as typeof SYNC_PROTOCOL_ID,
      recoveryCredentialId: input.currentControl.recoveryCredentialId,
      revokedDevices: [...input.currentControl.revokedDevices],
      syncId: input.syncId
    };
    const commitSignature = toB64(this.crypto.sign(candidate.signing.secretKey, this.crypto.canonicalBytes(commit)));

    const outcome = await this.relay.compareAndSwapMembership({
      commit,
      signature: commitSignature,
      recoveryAuthorization: {
        packageId: input.activePackage.packageId,
        challengeNonce: toB64(challengeNonce),
        signature: authorizationSignature
      }
    });
    if (outcome.status !== "committed") throw new SyncProtocolError("SYNC_CONTROL_CONFLICT");

    const payload = await this.scanAndOpenSealedPackage({
      authorDeviceId: input.publisherDeviceId,
      myWrapping: recoveryWrapping
    });
    const importedEpochs: EpochKeyMaterial[] = [];
    if (payload) {
      for (const entry of payload.epochs) {
        const key = fromB64(entry.key);
        await this.storeEpochKey(input.personId, input.syncId, candidate.deviceId, entry.epoch, key);
        importedEpochs.push({ epoch: entry.epoch, key });
      }
    }

    return { controlRecord: outcome.record, candidate, importedEpochs };
  }

  // -------------------------------------------------------------------
  // Device revocation and future-only epoch rotation
  // -------------------------------------------------------------------

  async revokeDevice(input: {
    personId: string;
    syncId: string;
    actingDevice: DeviceIdentity;
    currentControl: CurrentControlState;
    revokedDeviceId: string;
  }): Promise<{ controlRecord: import("../../relay/domain/types.js").ControlRecord; epoch: number; newEpochKey: Uint8Array }> {
    if (!input.currentControl.activeDevices.some((device) => device.deviceId === input.revokedDeviceId)) {
      throw new SyncProtocolError("SYNC_DEVICE_DENIED");
    }
    const remaining = input.currentControl.activeDevices.filter((device) => device.deviceId !== input.revokedDeviceId);
    if (remaining.length === 0) throw new SyncProtocolError("SYNC_DEVICE_DENIED");

    const newEpoch = input.currentControl.epoch + 1;
    const newEpochKey = this.crypto.randomBytes(32);
    const revokedDevices = sortStrings([...input.currentControl.revokedDevices, input.revokedDeviceId]);

    const commit = {
      activeDevices: sortByDeviceId(remaining),
      controlVersion: input.currentControl.controlVersion + 1,
      domain: CONTROL_COMMIT_DOMAIN as typeof CONTROL_COMMIT_DOMAIN,
      epoch: newEpoch,
      keyPackageDigests: [] as string[],
      previousCommitHash: input.currentControl.commitHash,
      previousControlVersion: input.currentControl.controlVersion,
      protocol: SYNC_PROTOCOL_ID as typeof SYNC_PROTOCOL_ID,
      recoveryCredentialId: input.currentControl.recoveryCredentialId,
      revokedDevices,
      syncId: input.syncId
    };
    const signature = toB64(this.crypto.sign(input.actingDevice.signing.secretKey, this.crypto.canonicalBytes(commit)));

    const outcome = await this.relay.compareAndSwapMembership({ commit, signature });
    if (outcome.status !== "committed") throw new SyncProtocolError("SYNC_CONTROL_CONFLICT");

    await this.storeEpochKey(input.personId, input.syncId, input.actingDevice.deviceId, newEpoch, newEpochKey);

    for (const recipient of remaining) {
      if (recipient.deviceId === input.actingDevice.deviceId) continue;
      await this.publishBoxPackage({
        syncId: input.syncId,
        authorDeviceId: input.actingDevice.deviceId,
        authorSigningSecretKey: input.actingDevice.signing.secretKey,
        authorWrappingSecretKey: input.actingDevice.wrapping.secretKey,
        recipientWrappingPublicKey: fromB64(recipient.wrappingPublicKey),
        epoch: newEpoch,
        payload: { epochs: [{ epoch: newEpoch, key: toB64(newEpochKey) }] } satisfies KeyringPayload
      });
    }

    return { controlRecord: outcome.record, epoch: newEpoch, newEpochKey };
  }

  /** Remaining-device side: imports the freshly rotated epoch key published by the revoking device. */
  async importRotatedEpochKey(input: {
    personId: string;
    syncId: string;
    myDeviceId: string;
    myWrapping: CryptoKeyPair;
    publisherDeviceId: string;
    publisherWrappingPublicKey: string;
  }): Promise<EpochKeyMaterial[]> {
    return this.completeEnrollment({
      personId: input.personId,
      syncId: input.syncId,
      myDeviceId: input.myDeviceId,
      myWrapping: input.myWrapping,
      approverDeviceId: input.publisherDeviceId,
      approverWrappingPublicKey: input.publisherWrappingPublicKey
    });
  }

  // -------------------------------------------------------------------
  // Recovery-credential rotation
  // -------------------------------------------------------------------

  async rotateRecoveryCredential(input: {
    syncId: string;
    actingDevice: DeviceIdentity;
    currentControl: CurrentControlState;
    passphrase: string;
    historicalEpochKeys: EpochKeyMaterial[];
  }): Promise<{
    controlRecord: import("../../relay/domain/types.js").ControlRecord;
    packageId: string;
    recoveryWrappingPublicKey: Uint8Array;
  }> {
    const seed = this.crypto.randomBytes(32);
    const wrappingSeed = this.crypto.deriveSubkey(seed, 1, "CMSRBOX1", 32);
    const recoveryWrapping = this.crypto.generateWrappingKeyPairFromSeed(wrappingSeed);

    const salt = this.crypto.randomBytes(16);
    const wrapped = this.crypto.wrapWithPassphrase(input.passphrase, seed, {
      opsLimit: ARGON2ID_REVIEWED_FLOOR.opsLimit,
      memLimit: ARGON2ID_REVIEWED_FLOOR.memLimit,
      salt
    });
    this.crypto.zero(seed);
    this.crypto.zero(wrappingSeed);

    const packageId = this.randomId();
    const ciphertextDigest = toB64(this.crypto.hash(wrapped.ciphertext));
    const signature = toB64(this.crypto.sign(
      input.actingDevice.signing.secretKey,
      this.crypto.canonicalBytes({
        domain: "cms.sync.v1/passphrase-package",
        packageId,
        ciphertextDigest
      })
    ));

    await this.relay.uploadRecoveryPackage({
      syncId: input.syncId,
      packageId,
      algorithm: "argon2id",
      opsLimit: wrapped.opsLimit,
      memLimit: wrapped.memLimit,
      salt: toB64(wrapped.salt),
      nonce: toB64(wrapped.nonce),
      ciphertextLength: wrapped.ciphertext.length,
      ciphertext: toB64(wrapped.ciphertext),
      ciphertextDigest,
      signature
    });

    const commit = {
      activeDevices: sortByDeviceId(input.currentControl.activeDevices),
      controlVersion: input.currentControl.controlVersion + 1,
      domain: CONTROL_COMMIT_DOMAIN as typeof CONTROL_COMMIT_DOMAIN,
      epoch: input.currentControl.epoch,
      keyPackageDigests: [] as string[],
      previousCommitHash: input.currentControl.commitHash,
      previousControlVersion: input.currentControl.controlVersion,
      protocol: SYNC_PROTOCOL_ID as typeof SYNC_PROTOCOL_ID,
      recoveryCredentialId: packageId,
      revokedDevices: [...input.currentControl.revokedDevices],
      syncId: input.syncId
    };
    const commitSignature = toB64(this.crypto.sign(input.actingDevice.signing.secretKey, this.crypto.canonicalBytes(commit)));

    const outcome = await this.relay.compareAndSwapMembership({ commit, signature: commitSignature });
    if (outcome.status !== "committed") throw new SyncProtocolError("SYNC_CONTROL_CONFLICT");

    await this.publishSealedPackage({
      syncId: input.syncId,
      authorDeviceId: input.actingDevice.deviceId,
      authorSigningSecretKey: input.actingDevice.signing.secretKey,
      recipientWrappingPublicKey: recoveryWrapping.publicKey,
      epoch: input.currentControl.epoch,
      payload: { epochs: input.historicalEpochKeys.map((entry) => ({ epoch: entry.epoch, key: toB64(entry.key) })) } satisfies KeyringPayload
    });

    return { controlRecord: outcome.record, packageId, recoveryWrappingPublicKey: recoveryWrapping.publicKey };
  }

  // -------------------------------------------------------------------
  // Opaque key-package transport over the append-only envelope channel
  // -------------------------------------------------------------------

  private async nextEnvelopeHeader(syncId: string, authorDeviceId: string, epoch: number, ciphertextLength: number) {
    const head = await this.relay.headEnvelope(authorDeviceId);
    return {
      ciphertextLength,
      createdAt: this.clock(),
      deviceId: authorDeviceId,
      epoch,
      objectId: this.randomId(),
      paddingPolicy: SYNC_PADDING_POLICY_ID as typeof SYNC_PADDING_POLICY_ID,
      previousEnvelopeHash: head.digest ?? ZERO_DIGEST_BASE64URL,
      protocol: SYNC_PROTOCOL_ID as typeof SYNC_PROTOCOL_ID,
      sequence: (head.sequence ?? 0) + 1,
      syncId
    };
  }

  private async appendOpaqueEnvelope(
    syncId: string,
    authorDeviceId: string,
    authorSigningSecretKey: Uint8Array,
    epoch: number,
    ciphertext: Uint8Array,
    nonce: Uint8Array
  ): Promise<DataEnvelopeRecord> {
    const header = await this.nextEnvelopeHeader(syncId, authorDeviceId, epoch, ciphertext.length);
    const ciphertextDigest = toB64(this.crypto.hash(ciphertext));
    const signaturePreimage = this.crypto.canonicalBytes({
      ciphertextDigest,
      domain: ENVELOPE_SIGNATURE_DOMAIN,
      header,
      nonce: toB64(nonce)
    });
    const signature = toB64(this.crypto.sign(authorSigningSecretKey, signaturePreimage));
    const result = await this.relay.appendEnvelope({
      header,
      nonce: toB64(nonce),
      ciphertext: toB64(ciphertext),
      ciphertextDigest,
      signature
    });
    return result.record;
  }

  private async publishBoxPackage(input: {
    syncId: string;
    authorDeviceId: string;
    authorSigningSecretKey: Uint8Array;
    authorWrappingSecretKey: Uint8Array;
    recipientWrappingPublicKey: Uint8Array;
    epoch: number;
    payload: KeyringPayload;
  }): Promise<DataEnvelopeRecord> {
    const nonce = this.crypto.randomBytes(24);
    const plaintext = new TextEncoder().encode(JSON.stringify(input.payload));
    const ciphertext = this.crypto.box(input.authorWrappingSecretKey, input.recipientWrappingPublicKey, nonce, plaintext);
    return this.appendOpaqueEnvelope(input.syncId, input.authorDeviceId, input.authorSigningSecretKey, input.epoch, ciphertext, nonce);
  }

  private async publishSealedPackage(input: {
    syncId: string;
    authorDeviceId: string;
    authorSigningSecretKey: Uint8Array;
    recipientWrappingPublicKey: Uint8Array;
    epoch: number;
    payload: KeyringPayload;
  }): Promise<DataEnvelopeRecord> {
    const plaintext = new TextEncoder().encode(JSON.stringify(input.payload));
    const ciphertext = this.crypto.sealedBox(input.recipientWrappingPublicKey, plaintext);
    const nonce = this.crypto.randomBytes(24);
    return this.appendOpaqueEnvelope(input.syncId, input.authorDeviceId, input.authorSigningSecretKey, input.epoch, ciphertext, nonce);
  }

  private async listAllEnvelopes(authorDeviceId: string): Promise<DataEnvelopeRecord[]> {
    const all: DataEnvelopeRecord[] = [];
    let fromSequence: number | undefined = 1;
    for (let guard = 0; guard < 64 && fromSequence !== undefined; guard += 1) {
      const page = await this.relay.listEnvelopes(authorDeviceId, fromSequence, 128);
      all.push(...page.records);
      fromSequence = page.nextFromSequence ?? undefined;
    }
    return all;
  }

  private async scanAndOpenBoxPackage(input: {
    authorDeviceId: string;
    authorWrappingPublicKey: Uint8Array;
    myWrappingSecretKey: Uint8Array;
  }): Promise<KeyringPayload | null> {
    const records = await this.listAllEnvelopes(input.authorDeviceId);
    for (const record of [...records].reverse()) {
      try {
        const plaintext = this.crypto.openBox(
          input.myWrappingSecretKey,
          input.authorWrappingPublicKey,
          fromB64(record.nonce),
          fromB64(record.ciphertext)
        );
        return JSON.parse(new TextDecoder().decode(plaintext)) as KeyringPayload;
      } catch {
        continue;
      }
    }
    return null;
  }

  private async scanAndOpenSealedPackage(input: { authorDeviceId: string; myWrapping: CryptoKeyPair }): Promise<KeyringPayload | null> {
    const records = await this.listAllEnvelopes(input.authorDeviceId);
    for (const record of [...records].reverse()) {
      try {
        const plaintext = this.crypto.openSealedBox(input.myWrapping.publicKey, input.myWrapping.secretKey, fromB64(record.ciphertext));
        return JSON.parse(new TextDecoder().decode(plaintext)) as KeyringPayload;
      } catch {
        continue;
      }
    }
    return null;
  }
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function sortByDeviceId(devices: DeviceMembershipEntry[]): DeviceMembershipEntry[] {
  return [...devices].sort((left, right) => (left.deviceId < right.deviceId ? -1 : left.deviceId > right.deviceId ? 1 : 0));
}

function sortStrings(values: string[]): string[] {
  return [...new Set(values)].sort();
}
