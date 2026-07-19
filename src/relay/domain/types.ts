import { z } from "zod";

/**
 * Strict opaque relay wire and persistence schemas for CMS Sync Protocol v1
 * (ADR 0047 "Relay Wire, Limits, and Logs" and "Control Plane Wire
 * Contract"). Every schema here is closed (`.strict()`) and rejects unknown
 * fields. This module intentionally imports nothing from local semantic
 * memory domains (`src/domain`, `src/storage`, `src/service`): the relay is
 * an opaque, zero-knowledge boundary and must never gain the ability to
 * parse, import, or reference plaintext canonical events, sources, persons,
 * profiles, or scopes.
 */

export const RELAY_PROTOCOL_ID = "cms-sync-v1";
export const RELAY_PADDING_POLICY_ID = "cms-sync-padding-v1";
export const RELAY_API_VERSION = 1;

const AEAD_TAG_BYTES = 16;
const LENGTH_PREFIX_BYTES = 4;
const MIN_CIPHERTEXT_LENGTH = AEAD_TAG_BYTES + LENGTH_PREFIX_BYTES;
export const MAX_CIPHERTEXT_LENGTH = 16_777_216;
export const MAX_PAGE_SIZE = 128;
export const MAX_ACTIVE_DEVICES = 64;
export const MAX_PENDING_ENROLLMENT_REQUESTS = 32;
export const MAX_RETAINED_GAP_SLOTS = 1_024;
const MAX_SAFE_SEQUENCE = 9_007_199_254_740_991;

/** Base64url encoding of a 32-byte all-zero digest. */
export const RELAY_ZERO_DIGEST_BASE64URL = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** 128-bit random identifier encoded as 32 lowercase hexadecimal characters. No semantic name. */
export const RelayIdSchema = z.string().regex(/^[0-9a-f]{32}$/, "Expected a 32-character lowercase hex identifier");
export type RelayId = z.infer<typeof RelayIdSchema>;

function unpaddedBase64UrlLength(byteLength: number): number {
  const full = Math.floor(byteLength / 3) * 4;
  const remainder = byteLength % 3;
  return full + (remainder === 0 ? 0 : remainder + 1);
}

function decodeBase64UrlBytes(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function relayBase64UrlBytesSchema(byteLength: number, label: string): z.ZodType<string> {
  const expectedLength = unpaddedBase64UrlLength(byteLength);
  return z.string().length(expectedLength, `${label} must be ${expectedLength} base64url characters`).refine(
    (value) => decodeBase64UrlBytes(value)?.length === byteLength,
    `${label} must be unpadded base64url decoding to exactly ${byteLength} bytes`
  );
}

export function relayBase64UrlVariableSchema(maxByteLength: number, label: string): z.ZodType<string> {
  return z.string().min(1).refine((value) => {
    const decoded = decodeBase64UrlBytes(value);
    return decoded !== null && decoded.length >= 1 && decoded.length <= maxByteLength;
  }, `${label} must be unpadded base64url decoding to between 1 and ${maxByteLength} bytes`);
}

export const RelayCanonicalTimestampSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "Timestamp must be canonical UTC RFC 3339 with exactly three fractional digits")
  .refine((value) => Number.isFinite(Date.parse(value)), "Timestamp must be a valid calendar date");

export const RelaySequenceSchema = z.number().int().min(1).max(MAX_SAFE_SEQUENCE);
export const RelayEpochSchema = z.number().int().min(1).max(MAX_SAFE_SEQUENCE);
export const RelayControlVersionSchema = z.number().int().min(1).max(MAX_SAFE_SEQUENCE);

function isSortedUniqueStrings(values: readonly string[]): boolean {
  if (new Set(values).size !== values.length) return false;
  const sorted = [...values].sort();
  return sorted.every((value, index) => value === values[index]);
}

/** Stable content-free protocol failure codes (ADR 0047 "Upgrade, Downgrade, and Stable Errors"). */
export const RelayErrorCodeSchema = z.enum([
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
export type RelayErrorCode = z.infer<typeof RelayErrorCodeSchema>;

export class RelayError extends Error {
  readonly code: RelayErrorCode;

  constructor(code: RelayErrorCode) {
    super(code);
    this.name = "RelayError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Persisted record schemas (ADR 0047 "Relay Wire, Limits, and Logs" table)
// ---------------------------------------------------------------------------

/** Account namespace: `issuerHash`, `subjectHash`, `syncId`, `createdAt` only. No email, no bearer token. */
export const AccountNamespaceRecordSchema = z.object({
  issuerHash: relayBase64UrlBytesSchema(32, "issuerHash"),
  subjectHash: relayBase64UrlBytesSchema(32, "subjectHash"),
  syncId: RelayIdSchema,
  createdAt: RelayCanonicalTimestampSchema
}).strict();
export type AccountNamespaceRecord = z.infer<typeof AccountNamespaceRecordSchema>;

export const DeviceCredentialStatusSchema = z.enum(["active", "revoked"]);

export const DeviceCredentialRecordSchema = z.object({
  syncId: RelayIdSchema,
  deviceId: RelayIdSchema,
  signingPublicKey: relayBase64UrlBytesSchema(32, "signingPublicKey"),
  wrappingPublicKey: relayBase64UrlBytesSchema(32, "wrappingPublicKey"),
  status: DeviceCredentialStatusSchema,
  controlVersion: RelayControlVersionSchema,
  createdAt: RelayCanonicalTimestampSchema,
  revokedAt: RelayCanonicalTimestampSchema.nullable()
}).strict();
export type DeviceCredentialRecord = z.infer<typeof DeviceCredentialRecordSchema>;

export const EnrollmentRequestStatusSchema = z.enum(["requested", "committed", "expired", "rejected", "invalid"]);

export const EnrollmentRequestRecordSchema = z.object({
  syncId: RelayIdSchema,
  requestId: RelayIdSchema,
  candidateDeviceId: RelayIdSchema,
  candidateSigningPublicKey: relayBase64UrlBytesSchema(32, "candidateSigningPublicKey"),
  candidateWrappingPublicKey: relayBase64UrlBytesSchema(32, "candidateWrappingPublicKey"),
  candidateEphemeralPublicKey: relayBase64UrlBytesSchema(32, "candidateEphemeralPublicKey"),
  encryptedNameBlob: relayBase64UrlVariableSchema(1024, "encryptedNameBlob"),
  nonce: relayBase64UrlBytesSchema(24, "nonce"),
  expiresAt: RelayCanonicalTimestampSchema,
  status: EnrollmentRequestStatusSchema
}).strict();
export type EnrollmentRequestRecord = z.infer<typeof EnrollmentRequestRecordSchema>;

/** Linear membership/key-control commit, mirroring ADR 0047 "Control Plane Wire Contract" exactly. */
export const RelayDeviceMembershipEntrySchema = z.object({
  deviceId: RelayIdSchema,
  signingPublicKey: relayBase64UrlBytesSchema(32, "signingPublicKey"),
  wrappingPublicKey: relayBase64UrlBytesSchema(32, "wrappingPublicKey")
}).strict();

export const RelayMembershipCommitSchema = z.object({
  activeDevices: z.array(RelayDeviceMembershipEntrySchema),
  controlVersion: RelayControlVersionSchema,
  domain: z.literal("cms.sync.v1/control-commit"),
  epoch: RelayEpochSchema,
  keyPackageDigests: z.array(relayBase64UrlBytesSchema(32, "keyPackageDigest")),
  previousCommitHash: relayBase64UrlBytesSchema(32, "previousCommitHash"),
  previousControlVersion: z.number().int().min(0).max(MAX_SAFE_SEQUENCE),
  protocol: z.literal(RELAY_PROTOCOL_ID),
  recoveryCredentialId: RelayIdSchema,
  revokedDevices: z.array(RelayIdSchema),
  syncId: RelayIdSchema
}).strict().superRefine((commit, context) => {
  if (commit.controlVersion !== commit.previousControlVersion + 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "controlVersion must equal previousControlVersion + 1", path: ["controlVersion"] });
  }
  if (commit.previousControlVersion === 0 && commit.previousCommitHash !== RELAY_ZERO_DIGEST_BASE64URL) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "The first control commit must use the zero digest as previousCommitHash", path: ["previousCommitHash"] });
  }
  if (commit.activeDevices.length > MAX_ACTIVE_DEVICES) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `activeDevices must not exceed ${MAX_ACTIVE_DEVICES}`, path: ["activeDevices"] });
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
export type RelayMembershipCommit = z.infer<typeof RelayMembershipCommitSchema>;

/** Persisted control record: canonical commit bytes plus signature and receipt metadata only. */
export const ControlRecordSchema = z.object({
  syncId: RelayIdSchema,
  controlVersion: RelayControlVersionSchema,
  previousControlVersion: z.number().int().min(0).max(MAX_SAFE_SEQUENCE),
  commitDigest: relayBase64UrlBytesSchema(32, "commitDigest"),
  canonicalCommitBytes: relayBase64UrlVariableSchema(65_536, "canonicalCommitBytes"),
  signature: relayBase64UrlBytesSchema(64, "signature"),
  createdAt: RelayCanonicalTimestampSchema
}).strict();
export type ControlRecord = z.infer<typeof ControlRecordSchema>;

/** Exact relay-visible envelope header (ADR 0047 "Operation envelope"). */
export const RelayEnvelopeHeaderSchema = z.object({
  ciphertextLength: z.number().int().min(MIN_CIPHERTEXT_LENGTH).max(MAX_CIPHERTEXT_LENGTH),
  createdAt: RelayCanonicalTimestampSchema,
  deviceId: RelayIdSchema,
  epoch: RelayEpochSchema,
  objectId: RelayIdSchema,
  paddingPolicy: z.literal(RELAY_PADDING_POLICY_ID),
  previousEnvelopeHash: relayBase64UrlBytesSchema(32, "previousEnvelopeHash"),
  protocol: z.literal(RELAY_PROTOCOL_ID),
  sequence: RelaySequenceSchema,
  syncId: RelayIdSchema
}).strict();
export type RelayEnvelopeHeader = z.infer<typeof RelayEnvelopeHeaderSchema>;

/** Data envelope record: exact envelope fields plus server `receivedAt` only. */
export const DataEnvelopeRecordSchema = z.object({
  header: RelayEnvelopeHeaderSchema,
  nonce: relayBase64UrlBytesSchema(24, "nonce"),
  ciphertext: relayBase64UrlVariableSchema(MAX_CIPHERTEXT_LENGTH, "ciphertext"),
  ciphertextDigest: relayBase64UrlBytesSchema(32, "ciphertextDigest"),
  signature: relayBase64UrlBytesSchema(64, "signature"),
  receivedAt: RelayCanonicalTimestampSchema
}).strict().superRefine((envelope, context) => {
  const decoded = decodeBase64UrlBytes(envelope.ciphertext);
  if (decoded === null || decoded.length !== envelope.header.ciphertextLength) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "ciphertext byte length must match header.ciphertextLength", path: ["ciphertext"] });
  }
  if (envelope.header.sequence === 1 && envelope.header.previousEnvelopeHash !== RELAY_ZERO_DIGEST_BASE64URL) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Sequence 1 must use the zero digest as previousEnvelopeHash", path: ["header", "previousEnvelopeHash"] });
  }
});
export type DataEnvelopeRecord = z.infer<typeof DataEnvelopeRecordSchema>;

/** Client-submitted envelope input: identical to a persisted record minus `receivedAt`. */
export const DataEnvelopeInputSchema = z.object({
  header: RelayEnvelopeHeaderSchema,
  nonce: relayBase64UrlBytesSchema(24, "nonce"),
  ciphertext: relayBase64UrlVariableSchema(MAX_CIPHERTEXT_LENGTH, "ciphertext"),
  ciphertextDigest: relayBase64UrlBytesSchema(32, "ciphertextDigest"),
  signature: relayBase64UrlBytesSchema(64, "signature")
}).strict();
export type DataEnvelopeInput = z.infer<typeof DataEnvelopeInputSchema>;

/** Opaque recovery / passphrase package record: pseudonymous IDs, public KDF header, opaque ciphertext only. */
export const RecoveryPackageStatusSchema = z.enum(["active", "superseded"]);

export const RecoveryPackageRecordSchema = z.object({
  syncId: RelayIdSchema,
  packageId: RelayIdSchema,
  algorithm: z.literal("argon2id"),
  opsLimit: z.number().int().positive(),
  memLimit: z.number().int().positive(),
  salt: relayBase64UrlBytesSchema(16, "salt"),
  nonce: relayBase64UrlBytesSchema(24, "nonce"),
  ciphertextLength: z.number().int().min(MIN_CIPHERTEXT_LENGTH).max(MAX_CIPHERTEXT_LENGTH),
  ciphertext: relayBase64UrlVariableSchema(MAX_CIPHERTEXT_LENGTH, "ciphertext"),
  ciphertextDigest: relayBase64UrlBytesSchema(32, "ciphertextDigest"),
  signature: relayBase64UrlBytesSchema(64, "signature"),
  status: RecoveryPackageStatusSchema,
  createdAt: RelayCanonicalTimestampSchema
}).strict();
export type RecoveryPackageRecord = z.infer<typeof RecoveryPackageRecordSchema>;

/** Signed observed head: `syncId`, observing device, observed digests, signature, `createdAt` only. */
export const HeadObservationRecordSchema = z.object({
  syncId: RelayIdSchema,
  observingDeviceId: RelayIdSchema,
  observedControlHeadDigest: relayBase64UrlBytesSchema(32, "observedControlHeadDigest"),
  observedDataHeadDigest: relayBase64UrlBytesSchema(32, "observedDataHeadDigest").nullable(),
  signature: relayBase64UrlBytesSchema(64, "signature"),
  createdAt: RelayCanonicalTimestampSchema
}).strict();
export type HeadObservationRecord = z.infer<typeof HeadObservationRecordSchema>;

// ---------------------------------------------------------------------------
// Bounded pagination / limit schemas
// ---------------------------------------------------------------------------

export const PageLimitSchema = z.number().int().min(1).max(MAX_PAGE_SIZE);

export const RelayReceiptSchema = z.object({
  syncId: RelayIdSchema,
  accepted: z.boolean(),
  reason: RelayErrorCodeSchema.optional()
}).strict();
export type RelayReceipt = z.infer<typeof RelayReceiptSchema>;

// ---------------------------------------------------------------------------
// Versioned request/response envelope (extended by Plan 06-05 Task 3 with
// the HTTP route surface; the operation union lives here so storage/service
// and transport layers share one strict contract).
// ---------------------------------------------------------------------------

const RelayRequestBaseSchema = z.object({
  version: z.literal(RELAY_API_VERSION)
});

export const RelayRequestSchema = z.discriminatedUnion("operation", [
  RelayRequestBaseSchema.extend({
    operation: z.literal("membership.cas"),
    commit: RelayMembershipCommitSchema,
    /** Detached Ed25519 signature over the canonical bytes of `commit`. */
    signature: relayBase64UrlBytesSchema(64, "signature"),
    enrollmentRequestId: RelayIdSchema.optional(),
    recoveryAuthorization: z.object({
      packageId: RelayIdSchema,
      challengeNonce: relayBase64UrlBytesSchema(32, "challengeNonce"),
      signature: relayBase64UrlBytesSchema(64, "signature")
    }).strict().optional()
  }).strict(),
  RelayRequestBaseSchema.extend({
    operation: z.literal("envelope.append"),
    envelope: DataEnvelopeInputSchema
  }).strict(),
  RelayRequestBaseSchema.extend({
    operation: z.literal("envelope.list"),
    deviceId: RelayIdSchema,
    fromSequence: z.number().int().min(1).max(MAX_SAFE_SEQUENCE).optional(),
    limit: PageLimitSchema.optional()
  }).strict(),
  RelayRequestBaseSchema.extend({
    operation: z.literal("envelope.head"),
    deviceId: RelayIdSchema
  }).strict(),
  RelayRequestBaseSchema.extend({
    operation: z.literal("enrollment.submit"),
    request: EnrollmentRequestRecordSchema.omit({ status: true })
  }).strict(),
  RelayRequestBaseSchema.extend({
    operation: z.literal("enrollment.list")
  }).strict(),
  RelayRequestBaseSchema.extend({
    operation: z.literal("recovery.upload"),
    package: RecoveryPackageRecordSchema.omit({ status: true, createdAt: true })
  }).strict(),
  RelayRequestBaseSchema.extend({
    operation: z.literal("recovery.fetch")
  }).strict(),
  RelayRequestBaseSchema.extend({
    operation: z.literal("head.observe"),
    observation: HeadObservationRecordSchema.omit({ createdAt: true })
  }).strict()
]);
export type RelayRequest = z.infer<typeof RelayRequestSchema>;

const RelayResponseBaseSchema = z.object({
  version: z.literal(RELAY_API_VERSION)
});

export const RelayResponseSchema = z.discriminatedUnion("operation", [
  RelayResponseBaseSchema.extend({
    operation: z.literal("membership.cas"),
    status: z.enum(["committed", "conflict"]),
    record: ControlRecordSchema.optional(),
    currentRecord: ControlRecordSchema.nullable().optional()
  }).strict(),
  RelayResponseBaseSchema.extend({
    operation: z.literal("envelope.append"),
    status: z.enum(["accepted", "replayed"]),
    record: DataEnvelopeRecordSchema
  }).strict(),
  RelayResponseBaseSchema.extend({
    operation: z.literal("envelope.list"),
    records: z.array(DataEnvelopeRecordSchema).max(MAX_PAGE_SIZE),
    nextFromSequence: z.number().int().min(1).max(MAX_SAFE_SEQUENCE).nullable()
  }).strict(),
  RelayResponseBaseSchema.extend({
    operation: z.literal("envelope.head"),
    sequence: z.number().int().min(1).max(MAX_SAFE_SEQUENCE).nullable(),
    digest: relayBase64UrlBytesSchema(32, "digest").nullable()
  }).strict(),
  RelayResponseBaseSchema.extend({
    operation: z.literal("enrollment.submit"),
    record: EnrollmentRequestRecordSchema
  }).strict(),
  RelayResponseBaseSchema.extend({
    operation: z.literal("enrollment.list"),
    records: z.array(EnrollmentRequestRecordSchema).max(MAX_PENDING_ENROLLMENT_REQUESTS)
  }).strict(),
  RelayResponseBaseSchema.extend({
    operation: z.literal("recovery.upload"),
    record: RecoveryPackageRecordSchema
  }).strict(),
  RelayResponseBaseSchema.extend({
    operation: z.literal("recovery.fetch"),
    record: RecoveryPackageRecordSchema.nullable()
  }).strict(),
  RelayResponseBaseSchema.extend({
    operation: z.literal("head.observe"),
    record: HeadObservationRecordSchema
  }).strict(),
  RelayResponseBaseSchema.extend({
    operation: z.literal("error"),
    code: RelayErrorCodeSchema
  }).strict()
]);
export type RelayResponse = z.infer<typeof RelayResponseSchema>;
