import { randomBytes } from "node:crypto";
import canonicalize from "canonicalize";
import sodium from "libsodium-wrappers-sumo";
import {
  DataEnvelopeRecordSchema,
  EnrollmentRequestRecordSchema,
  MAX_ACTIVE_DEVICES,
  MAX_PAGE_SIZE,
  MAX_PENDING_ENROLLMENT_REQUESTS,
  RecoveryPackageRecordSchema,
  RelayError,
  RelayRequestSchema,
  type DataEnvelopeRecord,
  type HeadObservationRecord,
  type RelayRequest,
  type RelayResponse
} from "../domain/types.js";
import type { RelayAccountAuthenticator } from "../auth/relay-account-authenticator.js";
import type { RelayStore } from "../storage/relay-store.js";

/**
 * Authenticated, zero-knowledge relay orchestration (ADR 0047). Every
 * method authenticates through `RelayAccountAuthenticator`, derives only
 * pseudonymous account authority, validates strict schemas, closes
 * account/sync/device ownership, and delegates to `RelayStore`. This module
 * imports no local semantic memory schema and exposes no decrypt method: it
 * verifies signatures/digests over opaque bytes only, never plaintext.
 */

const ENVELOPE_SIGNATURE_DOMAIN = "cms.sync.v1/envelope-signature";
const RECOVERY_AUTHORIZATION_DOMAIN = "cms.sync.v1/recovery-authorization";
/** Relay-issued recovery challenge lifetime (ADR 0047 "Recovery-key enrollment"). */
const RECOVERY_CHALLENGE_TTL_MS = 10 * 60 * 1000;

function canonicalBytes(value: unknown): Uint8Array {
  const text = canonicalize(value);
  if (text === undefined) throw new RelayError("SYNC_SCHEMA_INVALID");
  return new TextEncoder().encode(text);
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function verifyDetached(publicKeyBase64Url: string, messageBytes: Uint8Array, signatureBase64Url: string): boolean {
  try {
    return sodium.crypto_sign_verify_detached(
      fromBase64Url(signatureBase64Url),
      messageBytes,
      fromBase64Url(publicKeyBase64Url)
    );
  } catch {
    return false;
  }
}

export interface OpaqueRelayServiceOptions {
  authenticator: RelayAccountAuthenticator;
  store: RelayStore;
  clock?: () => string;
  randomId?: () => string;
}

export class OpaqueRelayService {
  private readonly authenticator: RelayAccountAuthenticator;
  private readonly store: RelayStore;
  private readonly clock: () => string;
  private readonly randomId: () => string;

  constructor(options: OpaqueRelayServiceOptions) {
    this.authenticator = options.authenticator;
    this.store = options.store;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.randomId = options.randomId ?? (() => randomBytes(16).toString("hex"));
  }

  async handle(bearerToken: string, requestInput: unknown): Promise<RelayResponse> {
    await sodium.ready;
    const parsed = RelayRequestSchema.safeParse(requestInput);
    if (!parsed.success) throw new RelayError("SYNC_SCHEMA_INVALID");
    const request = parsed.data;

    const authority = await this.authenticator.authenticate(bearerToken);
    const namespace = await this.store.ensureAccountNamespace(
      authority.issuerHash,
      authority.subjectHash,
      this.randomId(),
      this.clock()
    );
    const syncId = namespace.syncId;

    switch (request.operation) {
      case "membership.cas":
        return this.handleMembershipCas(syncId, request);
      case "envelope.append":
        return this.handleEnvelopeAppend(syncId, request);
      case "envelope.list":
        return this.handleEnvelopeList(syncId, request);
      case "envelope.head":
        return this.handleEnvelopeHead(syncId, request);
      case "enrollment.submit":
        return this.handleEnrollmentSubmit(syncId, request);
      case "enrollment.list":
        return this.handleEnrollmentList(syncId);
      case "recovery.upload":
        return this.handleRecoveryUpload(syncId, request);
      case "recovery.fetch":
        return this.handleRecoveryFetch(syncId);
      case "head.observe":
        return this.handleHeadObserve(syncId, request);
      default:
        throw new RelayError("SYNC_SCHEMA_INVALID");
    }
  }

  private async handleMembershipCas(
    syncId: string,
    request: Extract<RelayRequest, { operation: "membership.cas" }>
  ): Promise<RelayResponse> {
    const { commit } = request;
    if (commit.syncId !== syncId) throw new RelayError("SYNC_ACCOUNT_DENIED");

    const commitBytes = canonicalBytes(commit);
    const commitDigest = toBase64Url(sodium.crypto_generichash(32, commitBytes, null));

    const current = await this.store.getCurrentControlRecord(syncId);

    // Determine and verify the signing authority for this commit.
    if (!current) {
      if (commit.previousControlVersion !== 0) {
        return { version: 1, operation: "membership.cas", status: "conflict", currentRecord: null };
      }
      if (commit.activeDevices.length !== 1) throw new RelayError("SYNC_DEVICE_DENIED");
      const [genesisDevice] = commit.activeDevices;
      if (!verifyDetached(genesisDevice.signingPublicKey, commitBytes, request.signature)) {
        throw new RelayError("SYNC_INTEGRITY_FAILED");
      }
    } else if (request.recoveryAuthorization) {
      const previouslyActive = new Set((await this.store.listDeviceCredentials(syncId))
        .filter((device) => device.status === "active")
        .map((device) => device.deviceId));
      const newDevices = commit.activeDevices.filter((device) => !previouslyActive.has(device.deviceId));
      if (newDevices.length !== 1) throw new RelayError("SYNC_DEVICE_DENIED");
      const [candidate] = newDevices;

      // Relay-issued single-use challenge freshness/binding (ADR 0047
      // "Recovery-key enrollment"; WR-03). The client never chooses this
      // nonce: it must be one this relay minted via recovery.fetch, still
      // unconsumed, not expired, and bound to the CURRENT controlVersion.
      // Checked before the active-package lookup so a replayed (consumed)
      // challenge is always reported as SYNC_ALREADY_USED, never masked by
      // an unrelated active-package state change.
      const challenge = await this.store.getRecoveryChallenge(syncId, request.recoveryAuthorization.challengeNonce);
      if (!challenge || challenge.packageId !== request.recoveryAuthorization.packageId) {
        throw new RelayError("SYNC_DEVICE_DENIED");
      }
      if (challenge.consumedAt) {
        throw new RelayError("SYNC_ALREADY_USED");
      }
      if (Date.parse(challenge.expiresAt) <= Date.parse(this.clock())) {
        throw new RelayError("SYNC_EXPIRED");
      }
      if (challenge.controlVersion !== current.controlVersion) {
        throw new RelayError("SYNC_DEVICE_DENIED");
      }

      const activePackage = await this.store.getActiveRecoveryPackage(syncId);
      if (!activePackage || activePackage.packageId !== request.recoveryAuthorization.packageId) {
        throw new RelayError("SYNC_DEVICE_DENIED");
      }

      const authorizationPreimage = canonicalBytes({
        candidateDeviceId: candidate.deviceId,
        challengeNonce: challenge.challengeNonce,
        controlVersion: challenge.controlVersion,
        domain: RECOVERY_AUTHORIZATION_DOMAIN,
        expiresAt: challenge.expiresAt,
        packageId: challenge.packageId,
        syncId
      });
      // Bind possession of the recovery SEED, not the relay account: the
      // recovery-authorization signature must verify against the seed-derived
      // CMSRSIG1 public key persisted with the active package, never against
      // the candidate's own (freshly self-generated) device key (CR-01).
      if (!verifyDetached(activePackage.recoverySigningPublicKey, authorizationPreimage, request.recoveryAuthorization.signature)) {
        throw new RelayError("SYNC_INTEGRITY_FAILED");
      }
      if (!verifyDetached(candidate.signingPublicKey, commitBytes, request.signature)) {
        throw new RelayError("SYNC_INTEGRITY_FAILED");
      }
    } else {
      const activeDevices = (await this.store.listDeviceCredentials(syncId)).filter((device) => device.status === "active");
      const signer = activeDevices.find((device) => verifyDetached(device.signingPublicKey, commitBytes, request.signature));
      if (!signer) throw new RelayError("SYNC_DEVICE_DENIED");
    }

    const result = await this.store.commitControl({
      syncId,
      commit,
      canonicalCommitBytes: toBase64Url(commitBytes),
      commitDigest,
      signature: request.signature,
      createdAt: this.clock(),
      enrollmentRequestId: request.enrollmentRequestId,
      supersedeRecoveryPackageId: request.recoveryAuthorization?.packageId,
      consumeRecoveryChallengeNonce: request.recoveryAuthorization?.challengeNonce
    });

    if (result.status === "conflict") {
      return { version: 1, operation: "membership.cas", status: "conflict", currentRecord: result.currentRecord };
    }
    return { version: 1, operation: "membership.cas", status: "committed", record: result.record };
  }

  private async handleEnvelopeAppend(
    syncId: string,
    request: Extract<RelayRequest, { operation: "envelope.append" }>
  ): Promise<RelayResponse> {
    const { envelope } = request;
    if (envelope.header.syncId !== syncId) throw new RelayError("SYNC_ACCOUNT_DENIED");

    const device = await this.store.getDeviceCredential(syncId, envelope.header.deviceId);
    if (!device || device.status !== "active") throw new RelayError("SYNC_DEVICE_DENIED");

    const ciphertextBytes = fromBase64Url(envelope.ciphertext);
    const expectedDigest = toBase64Url(sodium.crypto_generichash(32, ciphertextBytes, null));
    if (expectedDigest !== envelope.ciphertextDigest) throw new RelayError("SYNC_INTEGRITY_FAILED");

    const signaturePreimage = canonicalBytes({
      ciphertextDigest: envelope.ciphertextDigest,
      domain: ENVELOPE_SIGNATURE_DOMAIN,
      header: envelope.header,
      nonce: envelope.nonce
    });
    if (!verifyDetached(device.signingPublicKey, signaturePreimage, envelope.signature)) {
      throw new RelayError("SYNC_INTEGRITY_FAILED");
    }

    const record: DataEnvelopeRecord = DataEnvelopeRecordSchema.parse({
      ...envelope,
      receivedAt: this.clock()
    });

    const result = await this.store.appendEnvelope(record);
    if (result.outcome === "gap_limit") throw new RelayError("SYNC_GAP_LIMIT");
    if (result.outcome === "equivocation") throw new RelayError("SYNC_INTEGRITY_FAILED");
    return { version: 1, operation: "envelope.append", status: result.outcome, record: result.record };
  }

  private async handleEnvelopeList(
    syncId: string,
    request: Extract<RelayRequest, { operation: "envelope.list" }>
  ): Promise<RelayResponse> {
    const device = await this.store.getDeviceCredential(syncId, request.deviceId);
    if (!device) throw new RelayError("SYNC_DEVICE_DENIED");
    const fromSequence = request.fromSequence ?? 1;
    const limit = request.limit ?? MAX_PAGE_SIZE;
    const records = await this.store.listEnvelopes(syncId, request.deviceId, fromSequence, limit);
    const nextFromSequence = records.length === limit ? records[records.length - 1].header.sequence + 1 : null;
    return { version: 1, operation: "envelope.list", records, nextFromSequence };
  }

  private async handleEnvelopeHead(
    syncId: string,
    request: Extract<RelayRequest, { operation: "envelope.head" }>
  ): Promise<RelayResponse> {
    const device = await this.store.getDeviceCredential(syncId, request.deviceId);
    if (!device) throw new RelayError("SYNC_DEVICE_DENIED");
    const head = await this.store.headEnvelope(syncId, request.deviceId);
    return { version: 1, operation: "envelope.head", sequence: head?.sequence ?? null, digest: head?.digest ?? null };
  }

  private async handleEnrollmentSubmit(
    syncId: string,
    request: Extract<RelayRequest, { operation: "enrollment.submit" }>
  ): Promise<RelayResponse> {
    if (request.request.syncId !== syncId) throw new RelayError("SYNC_ACCOUNT_DENIED");
    const activeDevices = await this.store.listDeviceCredentials(syncId);
    if (activeDevices.filter((device) => device.status === "active").length >= MAX_ACTIVE_DEVICES) {
      throw new RelayError("SYNC_LIMIT_EXCEEDED");
    }
    const pending = await this.store.listEnrollmentRequests(syncId);
    if (pending.filter((item) => item.status === "requested").length >= MAX_PENDING_ENROLLMENT_REQUESTS) {
      throw new RelayError("SYNC_LIMIT_EXCEEDED");
    }
    const record = EnrollmentRequestRecordSchema.parse({ ...request.request, status: "requested" });
    const saved = await this.store.submitEnrollmentRequest(record);
    return { version: 1, operation: "enrollment.submit", record: saved };
  }

  private async handleEnrollmentList(syncId: string): Promise<RelayResponse> {
    const records = (await this.store.listEnrollmentRequests(syncId)).filter((item) => item.status === "requested");
    return { version: 1, operation: "enrollment.list", records };
  }

  private async handleRecoveryUpload(
    syncId: string,
    request: Extract<RelayRequest, { operation: "recovery.upload" }>
  ): Promise<RelayResponse> {
    if (request.package.syncId !== syncId) throw new RelayError("SYNC_ACCOUNT_DENIED");
    const record = RecoveryPackageRecordSchema.parse({
      ...request.package,
      status: "active",
      createdAt: this.clock()
    });
    const saved = await this.store.putRecoveryPackage(record);
    return { version: 1, operation: "recovery.upload", record: saved };
  }

  private async handleRecoveryFetch(syncId: string): Promise<RelayResponse> {
    const record = await this.store.getActiveRecoveryPackage(syncId);
    if (!record) {
      return { version: 1, operation: "recovery.fetch", record: null, challenge: null };
    }
    // Mint a fresh single-use relay challenge bound to the CURRENT
    // controlVersion for this fetch (ADR 0047 "Recovery-key enrollment";
    // WR-03). The client never gets to choose this nonce/expiry.
    const current = await this.store.getCurrentControlRecord(syncId);
    const controlVersion = current?.controlVersion ?? 0;
    const challengeNonce = toBase64Url(randomBytes(32));
    const expiresAt = new Date(Date.parse(this.clock()) + RECOVERY_CHALLENGE_TTL_MS).toISOString();
    const challenge = await this.store.issueRecoveryChallenge({
      syncId,
      packageId: record.packageId,
      challengeNonce,
      controlVersion,
      expiresAt,
      createdAt: this.clock()
    });
    return { version: 1, operation: "recovery.fetch", record, challenge };
  }

  private async handleHeadObserve(
    syncId: string,
    request: Extract<RelayRequest, { operation: "head.observe" }>
  ): Promise<RelayResponse> {
    if (request.observation.syncId !== syncId) throw new RelayError("SYNC_ACCOUNT_DENIED");
    const device = await this.store.getDeviceCredential(syncId, request.observation.observingDeviceId);
    if (!device || device.status !== "active") throw new RelayError("SYNC_DEVICE_DENIED");
    const record: HeadObservationRecord = { ...request.observation, createdAt: this.clock() };
    const saved = await this.store.appendHeadObservation(record);
    return { version: 1, operation: "head.observe", record: saved };
  }
}
