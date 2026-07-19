import { z } from "zod";
import { JsonObjectSchema } from "../../domain/types.js";

/**
 * Protocol-v1 wire schemas for CMS Sync (ADR 0047: cms-sync-v1).
 *
 * All schemas here are strict, closed, and reject unknown fields. Byte
 * strings use unpadded base64url. UUID-like identifiers are 128-bit random
 * values encoded as 32 lowercase hexadecimal characters. Canonical bytes are
 * produced elsewhere (RFC 8785 via the `canonicalize` package inside
 * `src/sync/crypto`); this module defines shape and range only.
 */

export const SYNC_PROTOCOL_ID = "cms-sync-v1";
export const SYNC_PADDING_POLICY_ID = "cms-sync-padding-v1";

export const ENVELOPE_AAD_DOMAIN = "cms.sync.v1/envelope-aad";
export const ENVELOPE_SIGNATURE_DOMAIN = "cms.sync.v1/envelope-signature";
export const OPERATION_DOMAIN = "cms.sync.v1/operation";
export const CONTROL_COMMIT_DOMAIN = "cms.sync.v1/control-commit";
export const OBSERVED_HEAD_DOMAIN = "cms.sync.v1/observed-head";

const AEAD_TAG_BYTES = 16;
const LENGTH_PREFIX_BYTES = 4;
const MIN_CIPHERTEXT_LENGTH = AEAD_TAG_BYTES + LENGTH_PREFIX_BYTES;
export const MAX_CIPHERTEXT_LENGTH = 16_777_216;
const MAX_SAFE_SEQUENCE = 9_007_199_254_740_991;

/** Base64url encoding of a 32-byte all-zero digest; sequence 1 predecessor and initial commit hash. */
export const ZERO_DIGEST_BASE64URL = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export const SyncProtocolSchema = z.literal(SYNC_PROTOCOL_ID);
export const SyncPaddingPolicySchema = z.literal(SYNC_PADDING_POLICY_ID);

/** 128-bit random identifier encoded as 32 lowercase hexadecimal characters. No semantic name. */
export const RandomIdSchema = z.string().regex(/^[0-9a-f]{32}$/, "Expected a 32-character lowercase hex identifier");

function unpaddedBase64UrlLength(byteLength: number): number {
  const full = Math.floor(byteLength / 3) * 4;
  const remainder = byteLength % 3;
  return full + (remainder === 0 ? 0 : remainder + 1);
}

function decodeBase64UrlBytes(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url");
    // Buffer.from(..., 'base64url') tolerates trailing garbage on some inputs; re-encode and compare.
    if (decoded.toString("base64url") !== value) return null;
    return decoded;
  } catch {
    return null;
  }
}

/** Unpadded base64url string that decodes to exactly `byteLength` bytes. */
export function base64UrlBytesSchema(byteLength: number, label: string): z.ZodType<string> {
  const expectedLength = unpaddedBase64UrlLength(byteLength);
  return z.string().length(expectedLength, `${label} must be ${expectedLength} base64url characters`).refine(
    (value) => decodeBase64UrlBytes(value)?.length === byteLength,
    `${label} must be unpadded base64url decoding to exactly ${byteLength} bytes`
  );
}

/** Unpadded base64url string that decodes to between 1 and `maxByteLength` bytes. */
export function base64UrlVariableSchema(maxByteLength: number, label: string): z.ZodType<string> {
  return z.string().min(1).refine((value) => {
    const decoded = decodeBase64UrlBytes(value);
    return decoded !== null && decoded.length >= 1 && decoded.length <= maxByteLength;
  }, `${label} must be unpadded base64url decoding to between 1 and ${maxByteLength} bytes`);
}

/** Canonical UTC RFC 3339 timestamp with exactly three fractional digits. Ordering metadata only, not authority. */
export const CanonicalTimestampSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "Timestamp must be canonical UTC RFC 3339 with exactly three fractional digits")
  .refine((value) => Number.isFinite(Date.parse(value)), "Timestamp must be a valid calendar date");

export const SyncSequenceSchema = z.number().int().min(1).max(MAX_SAFE_SEQUENCE);
export const SyncEpochSchema = z.number().int().min(1).max(MAX_SAFE_SEQUENCE);
export const SyncControlVersionSchema = z.number().int().min(1).max(MAX_SAFE_SEQUENCE);

function isSortedUniqueStrings(values: readonly string[]): boolean {
  if (new Set(values).size !== values.length) return false;
  const sorted = [...values].sort();
  return sorted.every((value, index) => value === values[index]);
}

/** Stable content-free protocol failure codes (ADR 0047 "Upgrade, Downgrade, and Stable Errors"). */
export const SyncErrorCodeSchema = z.enum([
  "SYNC_AUTH_REQUIRED",
  "SYNC_ACCOUNT_DENIED",
  "SYNC_DEVICE_DENIED",
  "SYNC_VERSION_UNSUPPORTED",
  "SYNC_SCHEMA_INVALID",
  "SYNC_LIMIT_EXCEEDED",
  "SYNC_CONTROL_CONFLICT",
  "SYNC_SEQUENCE_CONFLICT",
  "SYNC_GAP_LIMIT",
  "SYNC_INTEGRITY_FAILED",
  "SYNC_EXPIRED",
  "SYNC_ALREADY_USED",
  "SYNC_INCOMPLETE",
  "SYNC_INTERNAL"
]);
export type SyncErrorCode = z.infer<typeof SyncErrorCodeSchema>;

/** Controlled, content-free protocol failure. Never carries plaintext, keys, or diagnostic detail. */
export const SyncProtocolFailureSchema = z.object({
  code: SyncErrorCodeSchema
}).strict();
export type SyncProtocolFailure = z.infer<typeof SyncProtocolFailureSchema>;

export class SyncProtocolError extends Error {
  readonly code: SyncErrorCode;

  constructor(code: SyncErrorCode) {
    super(code);
    this.name = "SyncProtocolError";
    this.code = code;
  }
}

/** Exact relay-visible header fields (ADR 0047 "Operation envelope"). */
export const EncryptedSyncEnvelopeHeaderSchema = z.object({
  ciphertextLength: z.number().int().min(MIN_CIPHERTEXT_LENGTH).max(MAX_CIPHERTEXT_LENGTH),
  createdAt: CanonicalTimestampSchema,
  deviceId: RandomIdSchema,
  epoch: SyncEpochSchema,
  objectId: RandomIdSchema,
  paddingPolicy: SyncPaddingPolicySchema,
  previousEnvelopeHash: base64UrlBytesSchema(32, "previousEnvelopeHash"),
  protocol: SyncProtocolSchema,
  sequence: SyncSequenceSchema,
  syncId: RandomIdSchema
}).strict();
export type EncryptedSyncEnvelopeHeader = z.infer<typeof EncryptedSyncEnvelopeHeaderSchema>;

/** Exact relay record fields. The relay verifies schema, bounds, digest, and signature without decrypting. */
export const EncryptedSyncEnvelopeSchema = z.object({
  header: EncryptedSyncEnvelopeHeaderSchema,
  nonce: base64UrlBytesSchema(24, "nonce"),
  ciphertext: base64UrlVariableSchema(MAX_CIPHERTEXT_LENGTH, "ciphertext"),
  ciphertextDigest: base64UrlBytesSchema(32, "ciphertextDigest"),
  signature: base64UrlBytesSchema(64, "signature")
}).strict().superRefine((envelope, context) => {
  const decoded = decodeBase64UrlBytes(envelope.ciphertext);
  if (decoded === null || decoded.length !== envelope.header.ciphertextLength) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "ciphertext byte length must match header.ciphertextLength",
      path: ["ciphertext"]
    });
  }
  if (envelope.header.sequence === 1 && envelope.header.previousEnvelopeHash !== ZERO_DIGEST_BASE64URL) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Sequence 1 must use the 32-byte zero digest as previousEnvelopeHash",
      path: ["header", "previousEnvelopeHash"]
    });
  }
});
export type EncryptedSyncEnvelope = z.infer<typeof EncryptedSyncEnvelopeSchema>;

const CausalHeadsSchema = z.array(RandomIdSchema).superRefine((heads, context) => {
  if (!isSortedUniqueStrings(heads)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "causalHeads must be sorted and unique" });
  }
});

const CanonicalAppendOperationBodySchema = z.object({
  personId: RandomIdSchema,
  sourceId: RandomIdSchema,
  scopeId: RandomIdSchema.optional(),
  canonicalEventId: RandomIdSchema,
  canonicalEvent: JsonObjectSchema
}).strict();

const TombstoneCreateOperationBodySchema = z.object({
  personId: RandomIdSchema,
  targetType: z.enum(["canonical_event", "summary", "box", "trace"]),
  targetId: RandomIdSchema,
  deletedAt: CanonicalTimestampSchema,
  actorDeviceId: RandomIdSchema
}).strict();

const PlainSyncOperationBaseSchema = z.object({
  causalHeads: CausalHeadsSchema,
  domain: z.literal(OPERATION_DOMAIN),
  operationId: RandomIdSchema,
  originDeviceId: RandomIdSchema,
  originSequence: SyncSequenceSchema,
  protocol: SyncProtocolSchema
});

/**
 * Strict operation object selected by `operationType`; contains all semantic
 * identifiers and content. Ciphertext-only: never appears in a relay-visible
 * header.
 */
export const PlainSyncOperationSchema = z.discriminatedUnion("operationType", [
  PlainSyncOperationBaseSchema.extend({
    operationType: z.literal("canonical.append"),
    body: CanonicalAppendOperationBodySchema
  }).strict(),
  PlainSyncOperationBaseSchema.extend({
    operationType: z.literal("tombstone.create"),
    body: TombstoneCreateOperationBodySchema
  }).strict()
]);
export type PlainSyncOperation = z.infer<typeof PlainSyncOperationSchema>;

/** Per-device signing/wrapping public keys carried in a MembershipCommit. No device names. */
export const DeviceMembershipEntrySchema = z.object({
  deviceId: RandomIdSchema,
  signingPublicKey: base64UrlBytesSchema(32, "signingPublicKey"),
  wrappingPublicKey: base64UrlBytesSchema(32, "wrappingPublicKey")
}).strict();
export type DeviceMembershipEntry = z.infer<typeof DeviceMembershipEntrySchema>;

/** Linear membership/key-control commit (ADR 0047 "Control Plane Wire Contract"). */
export const MembershipCommitSchema = z.object({
  activeDevices: z.array(DeviceMembershipEntrySchema),
  controlVersion: SyncControlVersionSchema,
  domain: z.literal(CONTROL_COMMIT_DOMAIN),
  epoch: SyncEpochSchema,
  keyPackageDigests: z.array(base64UrlBytesSchema(32, "keyPackageDigest")),
  previousCommitHash: base64UrlBytesSchema(32, "previousCommitHash"),
  previousControlVersion: z.number().int().min(0).max(MAX_SAFE_SEQUENCE),
  protocol: SyncProtocolSchema,
  recoveryCredentialId: RandomIdSchema,
  revokedDevices: z.array(RandomIdSchema),
  syncId: RandomIdSchema
}).strict().superRefine((commit, context) => {
  if (commit.controlVersion !== commit.previousControlVersion + 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "controlVersion must equal previousControlVersion + 1",
      path: ["controlVersion"]
    });
  }
  if (commit.previousControlVersion === 0 && commit.previousCommitHash !== ZERO_DIGEST_BASE64URL) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "The first control commit must use the 32-byte zero digest as previousCommitHash",
      path: ["previousCommitHash"]
    });
  }
  const activeIds = commit.activeDevices.map((entry) => entry.deviceId);
  if (!isSortedUniqueStrings(activeIds)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "activeDevices must be sorted and unique by deviceId", path: ["activeDevices"] });
  }
  if (!isSortedUniqueStrings(commit.revokedDevices)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "revokedDevices must be sorted and unique", path: ["revokedDevices"] });
  }
  if (!isSortedUniqueStrings(commit.keyPackageDigests)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "keyPackageDigests must be sorted and unique", path: ["keyPackageDigests"] });
  }
  const revokedSet = new Set(commit.revokedDevices);
  if (activeIds.some((id) => revokedSet.has(id))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A device cannot be both active and revoked in the same commit" });
  }
});
export type MembershipCommit = z.infer<typeof MembershipCommitSchema>;

/** Signed observed control/data heads exchanged inside encrypted operations for split-view detection. */
export const SignedObservedHeadSchema = z.object({
  domain: z.literal(OBSERVED_HEAD_DOMAIN),
  syncId: RandomIdSchema,
  observingDeviceId: RandomIdSchema,
  observedControlHead: base64UrlBytesSchema(32, "observedControlHead"),
  observedDataHeads: z.array(z.object({
    deviceId: RandomIdSchema,
    digest: base64UrlBytesSchema(32, "observedDataHeadDigest")
  }).strict()).superRefine((heads, context) => {
    if (!isSortedUniqueStrings(heads.map((head) => head.deviceId))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "observedDataHeads must be sorted and unique by deviceId" });
    }
  }),
  signature: base64UrlBytesSchema(64, "signature"),
  createdAt: CanonicalTimestampSchema
}).strict();
export type SignedObservedHead = z.infer<typeof SignedObservedHeadSchema>;
