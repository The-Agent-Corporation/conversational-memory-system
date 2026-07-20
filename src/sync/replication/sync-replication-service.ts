import { createHash } from "node:crypto";
import type { MemoryStore } from "../../storage/memory-store.js";
import type { SyncOutboxOperation } from "../../storage/sync-contracts.js";
import type { SyncRelay } from "../transport/sync-relay.js";
import type { CryptoProvider } from "../crypto/crypto-provider.js";
import { sealSyncEnvelope, type SealSyncEnvelopeInput } from "../crypto/libsodium-crypto-provider.js";
import {
  SYNC_PADDING_POLICY_ID,
  SYNC_PROTOCOL_ID,
  SyncProtocolError,
  ZERO_DIGEST_BASE64URL,
  type EncryptedSyncEnvelope,
  type EncryptedSyncEnvelopeHeader,
  type PlainSyncOperation
} from "../domain/types.js";
import { ReplayVerifier, type ActiveDeviceMembership } from "./replay-verifier.js";
import {
  SyncMaterializer,
  type MaterializationContext,
  type MaterializerOperation
} from "../materialization/sync-materializer.js";
import { deriveSyncStatus, type SyncStatusSnapshot } from "./sync-status.js";

/**
 * Bounded offline-tolerant push/pull replication orchestration (ADR 0047;
 * Task 06-08-01). Owns exactly the wire-level operation kinds the strict
 * Plan 06-02 wire schema (`src/sync/domain/types.ts`) already defines:
 * `canonical.append` and `tombstone.create`. `src/sync/domain/types.ts` is
 * outside this plan's declared file scope (matching the identical boundary
 * documented by Plans 06-04/06-06/06-07), so the four remaining local
 * producer kinds (`host_event_ingest` is pushed as `canonical.append`;
 * `proposal_decision`, `reviewed_box_decision`, `quarantine_resolution` have
 * no wire representation yet) are surfaced through `skippedUnsupportedKinds`
 * rather than silently dropped -- extending the wire union to carry them is
 * a follow-up plan's responsibility.
 */

const SUPPORTED_PUSH_KINDS = new Set(["canonical_append", "host_event_ingest"]);

/** Schema-valid placeholder predecessor digest for a gap-classified remote apply (see collection loop). */
const UNKNOWN_GAP_PREDECESSOR_DIGEST = "0".repeat(64);

export interface ResolvedOperationContent {
  readonly operation: PlainSyncOperation;
}

export type ResolveOperationContent = (
  row: SyncOutboxOperation
) => Promise<ResolvedOperationContent | null>;

export type BuildMaterializationContext = (personId: string) => Promise<MaterializationContext>;

export interface SyncReplicationServiceOptions {
  readonly store: MemoryStore;
  readonly relay: SyncRelay;
  readonly crypto: CryptoProvider;
  readonly personId: string;
  readonly syncId: string;
  readonly deviceId: string;
  readonly signingSecretKey: Uint8Array;
  readonly aeadKey: Uint8Array;
  readonly epoch: number;
  /** Resolves current active + revoked device membership. May change between calls (rotation/revocation). */
  readonly membership: () => ReadonlyMap<string, ActiveDeviceMembership>;
  /** Builds actual wire operation content for one pending outbox row. Returns null to skip (unsupported kind). */
  readonly resolveOperationContent: ResolveOperationContent;
  /** Builds the person/scope/source authorization context each pulled batch is validated against. */
  readonly buildMaterializationContext: BuildMaterializationContext;
  readonly clock?: () => string;
  readonly pageSize?: number;
}

export interface PushResult {
  readonly pushed: number;
  readonly alreadyAcknowledged: number;
  readonly skippedUnsupportedKinds: number;
  readonly deferredGap: number;
}

export interface PullResult {
  readonly applied: number;
  readonly gaps: number;
  readonly rejected: number;
  readonly idempotent: number;
}

function hexOf(bytesLike: Buffer): string {
  return bytesLike.toString("hex");
}

/** Converts a wire ciphertextDigest (base64url, 32 bytes) into the hex digest shape `sync-contracts.ts` requires. */
function envelopeDigestHexFromCiphertextDigest(ciphertextDigestBase64Url: string): string {
  return hexOf(Buffer.from(ciphertextDigestBase64Url, "base64url"));
}

function sha256HexOfBase64(envelopeBytesBase64: string): string {
  return createHash("sha256").update(envelopeBytesBase64).digest("hex");
}

export class SyncReplicationService {
  private readonly replayVerifier: ReplayVerifier;
  private readonly materializer = new SyncMaterializer();
  private lastPullGapCount = 0;
  private lastPullConflictCount = 0;
  private lastSyncedAt: string | null = null;

  constructor(private readonly options: SyncReplicationServiceOptions) {
    this.replayVerifier = new ReplayVerifier(options.crypto);
  }

  /**
   * Claims bounded outbox pages for this device, seals any still-pending
   * rows exactly once, and uploads only the exact bytes returned by the
   * durable seal. Crash after sealing, timeout, lost response, or process
   * reopen resend byte-identical bytes without invoking encryption or
   * randomness again -- `sealOne` is a no-op for an already-sealed row.
   */
  async pushPending(): Promise<PushResult> {
    const { store, relay, personId, deviceId } = this.options;
    let pushed = 0;
    let alreadyAcknowledged = 0;
    let skippedUnsupportedKinds = 0;
    let deferredGap = 0;

    const head = await relay.headEnvelope(deviceId);
    const outbox = (await store.listSyncOutboxOperations(personId))
      .filter((row) => row.deviceId === deviceId)
      .sort((left, right) => left.deviceSequence - right.deviceSequence);

    for (const row of outbox) {
      if (!SUPPORTED_PUSH_KINDS.has(row.operationKind)) {
        skippedUnsupportedKinds += 1;
        continue;
      }

      let sealedBytesBase64: string;
      let sealedSequence: number;

      if (row.status === "sealed") {
        sealedBytesBase64 = row.sealedEnvelopeBytesBase64!;
        sealedSequence = row.sealedSequence!;
      } else {
        const sealed = await this.sealOne(row);
        if (!sealed) {
          deferredGap += 1;
          continue;
        }
        sealedBytesBase64 = sealed.envelopeBytesBase64;
        sealedSequence = sealed.sequence;
      }

      if (head.sequence !== null && sealedSequence <= head.sequence) {
        alreadyAcknowledged += 1;
        continue;
      }

      const envelope = JSON.parse(Buffer.from(sealedBytesBase64, "base64").toString("utf8")) as EncryptedSyncEnvelope;
      const result = await relay.appendEnvelope(envelope);
      if (result.record.ciphertextDigest !== envelope.ciphertextDigest || result.record.header.sequence !== envelope.header.sequence) {
        // An acknowledgement for our own claimed sequence that does not echo back the exact bytes
        // we sent is permanent equivocation, not a transient failure -- the exact stored bytes
        // never change once sealed.
        throw new SyncProtocolError("SYNC_INTEGRITY_FAILED");
      }
      pushed += 1;
    }

    return { pushed, alreadyAcknowledged, skippedUnsupportedKinds, deferredGap };
  }

  private async sealOne(row: SyncOutboxOperation): Promise<{
    envelopeBytesBase64: string;
    envelopeDigestHex: string;
    sequence: number;
  } | null> {
    const resolved = await this.options.resolveOperationContent(row);
    if (!resolved) return null;

    let previousEnvelopeHash = ZERO_DIGEST_BASE64URL;
    if (row.deviceSequence > 1) {
      const outbox = await this.options.store.listSyncOutboxOperations(this.options.personId);
      const predecessor = outbox.find(
        (candidate) => candidate.deviceId === row.deviceId && candidate.deviceSequence === row.deviceSequence - 1
      );
      if (!predecessor || predecessor.status !== "sealed") return null; // predecessor not sealed yet; bounded pending work
      // Chain on the predecessor's own ciphertextDigest (BLAKE2b generichash over ciphertext
      // bytes only), matching ReplayVerifier.chainDigestOf -- NOT sealedEnvelopeDigest, which is
      // a local-bookkeeping SHA-256 over the whole base64 envelope JSON and never equals the
      // value the verifier checks (CR-02).
      const predecessorEnvelope = JSON.parse(
        Buffer.from(predecessor.sealedEnvelopeBytesBase64!, "base64").toString("utf8")
      ) as EncryptedSyncEnvelope;
      previousEnvelopeHash = predecessorEnvelope.ciphertextDigest;
    }

    const header: Omit<EncryptedSyncEnvelopeHeader, "ciphertextLength"> = {
      createdAt: this.options.clock?.() ?? new Date().toISOString(),
      deviceId: row.deviceId,
      epoch: this.options.epoch,
      objectId: createHash("sha256").update(`cms-sync-object/${row.id}`).digest("hex").slice(0, 32),
      paddingPolicy: SYNC_PADDING_POLICY_ID,
      previousEnvelopeHash,
      protocol: SYNC_PROTOCOL_ID,
      sequence: row.deviceSequence,
      syncId: this.options.syncId
    };

    const sealInput: SealSyncEnvelopeInput = {
      header,
      operation: resolved.operation,
      aeadKey: this.options.aeadKey,
      signingSecretKey: this.options.signingSecretKey
    };
    const envelope = sealSyncEnvelope(this.options.crypto, sealInput);
    const envelopeBytesBase64 = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
    const envelopeDigestHex = sha256HexOfBase64(envelopeBytesBase64);

    const sealResult = await this.options.store.sealClaimedOutboxEnvelope({
      personId: row.personId,
      deviceId: row.deviceId,
      outboxId: row.id,
      expectedRowVersion: row.rowVersion,
      protocolVersion: 1,
      sequence: row.deviceSequence,
      predecessorDigest: row.predecessorDigest,
      envelopeBytesBase64,
      envelopeDigest: envelopeDigestHex
    });

    if (sealResult.status === "STATE_CHANGED") return null;
    if (sealResult.status === "EQUIVOCATION") {
      throw new SyncProtocolError("SYNC_INTEGRITY_FAILED");
    }
    const record = sealResult.record!;
    return {
      envelopeBytesBase64: record.sealedEnvelopeBytesBase64!,
      envelopeDigestHex: record.sealedEnvelopeDigest!,
      sequence: record.sealedSequence!
    };
  }

  /**
   * Pulls every peer device's contiguous frontier in bounded pages, verifies
   * each envelope's membership/signature/chain before decrypting, then
   * materializes every verified operation from every peer device as ONE
   * batch so `SyncMaterializer`'s control-first two-pass ordering (Plan
   * 06-07) stabilizes tombstones/quarantine across devices before ordinary
   * canonical/review content, regardless of per-device delivery order.
   * Individually committing each already-classified outcome afterward keeps
   * the durable per-device frontier/gap/equivocation CAS exactly as owned by
   * Plan 06-04's storage seam. Never advances a peer's frontier over a gap.
   */
  async pullAndApply(): Promise<PullResult> {
    const { store, relay, personId } = this.options;
    const membership = this.options.membership();

    interface CollectedOp {
      readonly authorDeviceId: string;
      readonly sequence: number;
      readonly envelopeDigestHex: string;
      readonly predecessorDigestHex: string | null;
      readonly materializerOp: MaterializerOperation;
    }
    const collected: CollectedOp[] = [];
    let rejected = 0;

    for (const [authorDeviceId] of membership) {
      const frontier = await store.getSyncReplayFrontier(personId, authorDeviceId);
      let runningExpectedNext = frontier + 1;
      let runningChainDigestBase64Url = await this.lastAcceptedChainDigest(authorDeviceId, frontier);
      let cursor: number | undefined = frontier + 1;
      for (;;) {
        const page = await relay.listEnvelopes(authorDeviceId, cursor, this.options.pageSize ?? 64);
        if (page.records.length === 0) break;

        for (const record of page.records) {
          // Relay-side DataEnvelopeRecord adds a server-authored `receivedAt` receipt field on top
          // of the strict wire envelope; strip it before structural/signature verification.
          const { receivedAt: _receivedAt, ...wireEnvelope } = record;
          const outcome = this.replayVerifier.verify(wireEnvelope, {
            aeadKey: this.options.aeadKey,
            membership,
            expectedNextSequence: runningExpectedNext,
            expectedPreviousChainDigest: runningChainDigestBase64Url
          });
          if (outcome.kind === "rejected") {
            rejected += 1;
            continue;
          }
          const materializerOp = toMaterializerOperation(outcome.opened.operation);
          if (!materializerOp) {
            rejected += 1;
            continue;
          }
          // A gap candidate (sequence ahead of the still-unknown running chain) has no real
          // predecessor digest to bind yet; the store's own GAP_PENDING path (Plan 06-04) never
          // inspects this field for a non-contiguous sequence, so a schema-valid placeholder is
          // safe -- only a contiguous, chain-verified accept ever carries the real value.
          const predecessorDigestHex = outcome.sequence === 1
            ? null
            : runningChainDigestBase64Url === null
              ? UNKNOWN_GAP_PREDECESSOR_DIGEST
              : envelopeDigestHexFromCiphertextDigest(runningChainDigestBase64Url);
          collected.push({
            authorDeviceId,
            sequence: outcome.sequence,
            envelopeDigestHex: envelopeDigestHexFromCiphertextDigest(record.ciphertextDigest),
            predecessorDigestHex,
            materializerOp
          });
          if (outcome.sequence === runningExpectedNext) {
            runningExpectedNext += 1;
            runningChainDigestBase64Url = outcome.chainDigest;
          }
        }

        cursor = page.nextFromSequence ?? undefined;
        if (cursor === undefined) break;
      }
    }

    const context = await this.options.buildMaterializationContext(personId);
    const batch = this.materializer.materializeBatch(collected.map((item) => item.materializerOp), context);

    let applied = 0;
    let gaps = 0;
    let idempotent = 0;
    const now = this.options.clock?.() ?? new Date().toISOString();
    for (const item of collected) {
      const receiptOutcome = classifyRemoteOutcome(item.materializerOp, batch);
      const canonicalOrder = batch.canonical.find((entry) => entry.operationId === item.materializerOp.operationId)?.order;
      const effectFingerprintHex = createHash("sha256")
        .update(JSON.stringify({ operationId: item.materializerOp.operationId, kind: item.materializerOp.kind }))
        .digest("hex");

      const receipt = await store.commitRemoteSyncApply({
        operation: "remote_sync_apply",
        personId,
        authorDeviceId: item.authorDeviceId,
        sequence: item.sequence,
        predecessorDigest: item.predecessorDigestHex,
        envelopeDigest: item.envelopeDigestHex,
        effectFingerprint: effectFingerprintHex,
        outcome: receiptOutcome,
        affectedRangeStart: canonicalOrder ?? 0,
        affectedRangeEnd: canonicalOrder ?? 0,
        appliedAt: now,
        receipt: {
          operation: "remote_sync_apply",
          status: "COMMITTED",
          personId,
          targetId: item.materializerOp.operationId,
          committedAt: now
        }
      });

      if (receipt.status === "GAP_PENDING") gaps += 1;
      else if (receipt.status === "IDEMPOTENT") idempotent += 1;
      else if (receipt.status === "EQUIVOCATION") rejected += 1;
      else applied += 1;
    }

    this.lastPullGapCount = gaps;
    this.lastPullConflictCount = batch.reviewOutcomes.filter((outcome) => outcome.status === "unresolved").length;
    this.lastSyncedAt = now;
    return { applied, gaps, rejected, idempotent };
  }

  private async lastAcceptedChainDigest(authorDeviceId: string, frontier: number): Promise<string | null> {
    if (frontier === 0) return null;
    const accepted = await this.options.store.listAcceptedSyncOperations(this.options.personId);
    const previous = accepted.find((op) => op.authorDeviceId === authorDeviceId && op.sequence === frontier);
    if (!previous) return null;
    return hexToBase64Url(previous.envelopeDigest);
  }

  /** Content-free replication status for this device (D-13 allowlist; never claims remote erasure). */
  async status(networkReachable = true): Promise<SyncStatusSnapshot> {
    const { store, relay, personId, deviceId } = this.options;
    const outbox = (await store.listSyncOutboxOperations(personId)).filter((row) => row.deviceId === deviceId);
    const head = await relay.headEnvelope(deviceId).catch(() => ({ sequence: null, digest: null }));
    const pendingOutboxCount = outbox.filter((row) => head.sequence === null || row.deviceSequence > head.sequence).length;
    return deriveSyncStatus({
      personId,
      deviceId,
      pendingOutboxCount,
      pendingGapCount: this.lastPullGapCount,
      unresolvedConflictCount: this.lastPullConflictCount,
      lastPushedSequence: head.sequence ?? 0,
      lastObservedRemoteSequence: head.sequence,
      lastSyncedAt: this.lastSyncedAt,
      networkReachable
    });
  }
}

function hexToBase64Url(hex: string): string {
  return Buffer.from(hex, "hex").toString("base64url");
}

function toMaterializerOperation(operation: PlainSyncOperation): MaterializerOperation | null {
  if (operation.operationType === "canonical.append") {
    return {
      kind: "canonical_append",
      operationId: operation.operationId,
      personId: operation.body.personId,
      deviceId: operation.originDeviceId,
      sequence: operation.originSequence,
      causalHeads: operation.causalHeads,
      sourceId: operation.body.sourceId,
      scopeId: operation.body.scopeId ?? operation.body.sourceId,
      canonicalEventId: operation.body.canonicalEventId,
      canonicalEvent: operation.body.canonicalEvent
    };
  }
  if (operation.operationType === "tombstone.create") {
    return {
      kind: "tombstone_create",
      operationId: operation.operationId,
      personId: operation.body.personId,
      deviceId: operation.originDeviceId,
      sequence: operation.originSequence,
      causalHeads: operation.causalHeads,
      targetType: operation.body.targetType,
      targetId: operation.body.targetId,
      tombstoneKind: "generic"
    };
  }
  return null;
}

function classifyRemoteOutcome(
  operation: MaterializerOperation,
  batch: ReturnType<SyncMaterializer["materializeBatch"]>
): { kind: "effect" } | { kind: "conflict"; detailFingerprint: string } | { kind: "tombstone"; targetId: string } | { kind: "quarantine"; reasonFingerprint: string } {
  const wasRejected = batch.rejected.some((item) => item.operationId === operation.operationId);
  if (wasRejected) {
    const reason = batch.rejected.find((item) => item.operationId === operation.operationId)!.reason;
    return { kind: "quarantine", reasonFingerprint: createHash("sha256").update(reason).digest("hex") };
  }
  if (operation.kind === "tombstone_create") {
    return { kind: "tombstone", targetId: operation.targetId };
  }
  if (batch.quarantine.some((entry) => entry.targetId === (operation as { canonicalEventId?: string }).canonicalEventId)) {
    return { kind: "quarantine", reasonFingerprint: createHash("sha256").update("covered_by_tombstone").digest("hex") };
  }
  return { kind: "effect" };
}
