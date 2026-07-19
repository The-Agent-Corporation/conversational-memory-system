import {
  EncryptedSyncEnvelopeSchema,
  SyncProtocolError,
  ZERO_DIGEST_BASE64URL,
  type SyncErrorCode
} from "../domain/types.js";
import { openSyncEnvelope, type OpenedSyncEnvelope } from "../crypto/libsodium-crypto-provider.js";
import type { CryptoProvider } from "../crypto/crypto-provider.js";

/**
 * Durable chain, replay, gap, rollback, and equivocation validation
 * (ADR 0047 "Durable sequence/hash chains"; T-06-28). `commitLocalSyncOperation`
 * / `commitRemoteSyncApply` (Plan 06-04) already own exact-tuple
 * idempotency/equivocation/gap classification purely from the numeric
 * `sequence` versus the durable per-device frontier. `ReplayVerifier`
 * supplies the layer those primitives do not: schema, active-membership,
 * and signature verification precede any AEAD/plaintext work (T-06-29), and
 * an independent per-device envelope hash chain detects rollback/fork
 * tampering that a bare sequence-number CAS cannot see on its own.
 *
 * Chain digest definition: envelope N+1's `header.previousEnvelopeHash`
 * MUST equal envelope N's own `ciphertextDigest` (already a 32-byte
 * base64url field present on every envelope). This reuses an existing wire
 * field rather than introducing a second envelope-hash concept, mirroring
 * the same reuse-over-extension precedent recorded by Plan 06-06's
 * predecessorDigest-chain decision.
 */

export interface ActiveDeviceMembership {
  readonly deviceId: string;
  readonly signingPublicKey: Uint8Array;
  readonly active: boolean;
}

export interface ReplayVerificationContext {
  /** Current AEAD key (epoch key) used to open this envelope. */
  readonly aeadKey: Uint8Array;
  /** Current active + revoked device membership, keyed by deviceId. */
  readonly membership: ReadonlyMap<string, ActiveDeviceMembership>;
  /** The author device's durable replay frontier + 1 (the next sequence this verifier expects). */
  readonly expectedNextSequence: number;
  /** The chain digest (previous envelope's ciphertextDigest) recorded for the frontier sequence, or null before sequence 1. */
  readonly expectedPreviousChainDigest: string | null;
}

export type ReplayVerificationOutcome =
  | { readonly kind: "verified"; readonly opened: OpenedSyncEnvelope; readonly chainDigest: string; readonly sequence: number }
  | { readonly kind: "rejected"; readonly code: SyncErrorCode };

export class ReplayVerifier {
  constructor(private readonly crypto: CryptoProvider) {}

  /** The chain digest a directly-following envelope's `previousEnvelopeHash` must equal. */
  static chainDigestOf(ciphertextDigest: string): string {
    return ciphertextDigest;
  }

  /**
   * Verifies one untrusted relay-delivered envelope. Bounds/schema, active
   * membership, and signature are checked before any AEAD or plaintext
   * parsing; the hash chain is checked only once the envelope has already
   * cryptographically authenticated as belonging to the claimed device.
   * Never throws; every failure path returns a stable content-free code.
   */
  verify(rawEnvelope: unknown, context: ReplayVerificationContext): ReplayVerificationOutcome {
    const structural = EncryptedSyncEnvelopeSchema.safeParse(rawEnvelope);
    if (!structural.success) {
      return { kind: "rejected", code: "SYNC_SCHEMA_INVALID" };
    }
    const envelope = structural.data;

    const device = context.membership.get(envelope.header.deviceId);
    if (!device || !device.active) {
      return { kind: "rejected", code: "SYNC_DEVICE_DENIED" };
    }

    let opened: OpenedSyncEnvelope;
    try {
      opened = openSyncEnvelope(this.crypto, {
        envelope,
        aeadKey: context.aeadKey,
        verifyingKey: device.signingPublicKey
      });
    } catch (error) {
      if (error instanceof SyncProtocolError) return { kind: "rejected", code: error.code };
      return { kind: "rejected", code: "SYNC_INTERNAL" };
    }

    // Chain/rollback verification only applies at the exact next expected sequence; a sequence
    // that is behind (replay) or ahead (gap) of the frontier is classified by the storage seam's
    // own CAS once this verified envelope reaches commitRemoteSyncApply.
    if (envelope.header.sequence === context.expectedNextSequence) {
      const expectedPrevious = context.expectedPreviousChainDigest ?? ZERO_DIGEST_BASE64URL;
      if (envelope.header.previousEnvelopeHash !== expectedPrevious) {
        return { kind: "rejected", code: "SYNC_INTEGRITY_FAILED" };
      }
    }

    return {
      kind: "verified",
      opened,
      chainDigest: envelope.ciphertextDigest,
      sequence: envelope.header.sequence
    };
  }
}
