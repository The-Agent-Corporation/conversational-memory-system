import { z } from "zod";
import { mutationEffectsFingerprint } from "./mcp-mutation-contracts.js";

const IdSchema = z.string().min(1);
const NonNegativeInt = z.number().int().nonnegative();
const PositiveInt = z.number().int().positive();
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/, "Digest must be a lowercase hex SHA-256 value");
const Base64Schema = z.string().min(1).regex(/^[A-Za-z0-9+/]+={0,2}$/, "Must be base64");
const TimestampSchema = z.string().min(1);

/** Re-exported so callers bind effect fingerprints identically to mcp-mutation-contracts. */
export const syncEffectFingerprint = mutationEffectsFingerprint;

/**
 * Every task-specific atomic local producer this store seam supports. Each kind commits exactly
 * one authoritative domain-effect proof plus exactly one typed immutable sync-outbox operation.
 */
export const SyncOperationKindSchema = z.enum([
  "canonical_append",
  "host_event_ingest",
  "proposal_decision",
  "reviewed_box_decision",
  "source_revocation",
  "source_deletion",
  "quarantine_resolution"
]);
export type SyncOperationKind = z.infer<typeof SyncOperationKindSchema>;

export const SyncCommitStatusSchema = z.enum([
  "COMMITTED",
  "STATE_CHANGED",
  "IDEMPOTENT",
  "EQUIVOCATION",
  "GAP_PENDING"
]);
export type SyncCommitStatus = z.infer<typeof SyncCommitStatusSchema>;

export const SyncCommitReceiptSchema = z.object({
  operation: z.enum(["local_sync_operation", "remote_sync_apply"]),
  status: SyncCommitStatusSchema,
  personId: IdSchema,
  targetId: IdSchema,
  committedAt: TimestampSchema
}).strict();
export type SyncCommitReceipt = z.infer<typeof SyncCommitReceiptSchema>;

/** Immutable proof that an authoritative local producer committed its domain effect atomically. */
export const LocalSyncEffectRecordSchema = z.object({
  id: IdSchema,
  personId: IdSchema,
  deviceId: IdSchema,
  operationKind: SyncOperationKindSchema,
  targetId: IdSchema,
  deviceSequence: PositiveInt,
  effectFingerprint: DigestSchema,
  committedAt: TimestampSchema
}).strict();
export type LocalSyncEffectRecord = z.infer<typeof LocalSyncEffectRecordSchema>;

export const SyncOutboxStatusSchema = z.enum(["pending", "sealed"]);
export type SyncOutboxStatus = z.infer<typeof SyncOutboxStatusSchema>;

/** A durable, exactly-once-per-device-sequence outbox row; sealed bytes are immutable once set. */
export const SyncOutboxOperationSchema = z.object({
  id: IdSchema,
  personId: IdSchema,
  deviceId: IdSchema,
  operationKind: SyncOperationKindSchema,
  targetId: IdSchema,
  deviceSequence: PositiveInt,
  predecessorDigest: DigestSchema.nullable(),
  effectFingerprint: DigestSchema,
  status: SyncOutboxStatusSchema,
  rowVersion: NonNegativeInt,
  createdAt: TimestampSchema,
  sealedProtocolVersion: PositiveInt.nullable(),
  sealedSequence: PositiveInt.nullable(),
  sealedPredecessorDigest: DigestSchema.nullable(),
  sealedEnvelopeBytesBase64: Base64Schema.nullable(),
  sealedEnvelopeDigest: DigestSchema.nullable(),
  sealedAt: TimestampSchema.nullable()
}).strict().superRefine((row, context) => {
  const sealedFields = [
    row.sealedProtocolVersion, row.sealedSequence, row.sealedEnvelopeBytesBase64, row.sealedEnvelopeDigest, row.sealedAt
  ];
  const allSealed = sealedFields.every((field) => field !== null);
  const noneSealed = sealedFields.every((field) => field === null);
  if (row.status === "sealed" && !allSealed) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Sealed outbox row must carry every sealed field" });
  }
  if (row.status === "pending" && !noneSealed) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Pending outbox row must not carry sealed fields" });
  }
});
export type SyncOutboxOperation = z.infer<typeof SyncOutboxOperationSchema>;

/** Local device sequence that has been observed but not yet materialized because a predecessor is missing. */
export const PendingSyncGapSchema = z.object({
  personId: IdSchema,
  authorDeviceId: IdSchema,
  missingSequence: PositiveInt,
  detectedAt: TimestampSchema
}).strict();
export type PendingSyncGap = z.infer<typeof PendingSyncGapSchema>;

/** One contiguous-replay-frontier-accepted remote operation. */
export const AcceptedSyncOperationSchema = z.object({
  id: IdSchema,
  personId: IdSchema,
  authorDeviceId: IdSchema,
  sequence: PositiveInt,
  predecessorDigest: DigestSchema.nullable(),
  envelopeDigest: DigestSchema,
  effectFingerprint: DigestSchema,
  outcomeKind: z.enum(["effect", "conflict", "tombstone", "quarantine"]),
  acceptedAt: TimestampSchema
}).strict();
export type AcceptedSyncOperation = z.infer<typeof AcceptedSyncOperationSchema>;

export const SyncConflictRecordSchema = z.object({
  id: IdSchema,
  personId: IdSchema,
  authorDeviceId: IdSchema,
  sequence: PositiveInt,
  detailFingerprint: DigestSchema,
  detectedAt: TimestampSchema
}).strict();
export type SyncConflictRecord = z.infer<typeof SyncConflictRecordSchema>;

export const SyncTombstoneSchema = z.object({
  id: IdSchema,
  personId: IdSchema,
  targetId: IdSchema,
  authorDeviceId: IdSchema,
  sequence: PositiveInt,
  tombstonedAt: TimestampSchema
}).strict();
export type SyncTombstone = z.infer<typeof SyncTombstoneSchema>;

export const SyncQuarantineEntrySchema = z.object({
  id: IdSchema,
  personId: IdSchema,
  authorDeviceId: IdSchema,
  sequence: PositiveInt,
  reasonFingerprint: DigestSchema,
  quarantinedAt: TimestampSchema
}).strict();
export type SyncQuarantineEntry = z.infer<typeof SyncQuarantineEntrySchema>;

export const SyncContractionRangeSchema = z.object({
  personId: IdSchema,
  rangeStart: NonNegativeInt,
  rangeEnd: NonNegativeInt
}).strict().superRefine((range, context) => {
  if (range.rangeStart > range.rangeEnd) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Contraction range start must not exceed end" });
  }
});
export type SyncContractionRange = z.infer<typeof SyncContractionRangeSchema>;

/**
 * Atomically commits one authoritative local domain-effect proof plus exactly one immutable,
 * pending sync-outbox row bound to the same device sequence and predecessor digest.
 */
export const CommitLocalSyncOperationInputSchema = z.object({
  operation: z.literal("local_sync_operation"),
  personId: IdSchema,
  deviceId: IdSchema,
  operationKind: SyncOperationKindSchema,
  targetId: IdSchema,
  outboxId: IdSchema,
  expectedFrontierSequence: NonNegativeInt,
  deviceSequence: PositiveInt,
  predecessorDigest: DigestSchema.nullable(),
  effectFingerprint: DigestSchema,
  committedAt: TimestampSchema,
  receipt: SyncCommitReceiptSchema
}).strict().superRefine((input, context) => {
  if (input.deviceSequence !== input.expectedFrontierSequence + 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Device sequence must be exactly one past the expected frontier" });
  }
  if (input.deviceSequence === 1 && input.predecessorDigest !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "First device sequence must have a null predecessor digest" });
  }
  if (input.deviceSequence > 1 && input.predecessorDigest === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Non-initial device sequence requires a predecessor digest" });
  }
  if (input.receipt.operation !== input.operation || input.receipt.personId !== input.personId || input.receipt.targetId !== input.targetId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Local sync operation receipt binding mismatch", path: ["receipt"] });
  }
});
export type CommitLocalSyncOperationInput = z.infer<typeof CommitLocalSyncOperationInputSchema>;

const RemoteApplyOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("effect") }).strict(),
  z.object({ kind: z.literal("conflict"), detailFingerprint: DigestSchema }).strict(),
  z.object({ kind: z.literal("tombstone"), targetId: IdSchema }).strict(),
  z.object({ kind: z.literal("quarantine"), reasonFingerprint: DigestSchema }).strict()
]);
export type RemoteApplyOutcome = z.infer<typeof RemoteApplyOutcomeSchema>;

/**
 * Atomically applies one untrusted remote-origin operation: records the accepted operation,
 * advances the contiguous replay frontier, materializes exactly one outcome, merges the affected
 * contraction range, and never creates a local outbox row.
 */
export const CommitRemoteSyncApplyInputSchema = z.object({
  operation: z.literal("remote_sync_apply"),
  personId: IdSchema,
  authorDeviceId: IdSchema,
  sequence: PositiveInt,
  predecessorDigest: DigestSchema.nullable(),
  envelopeDigest: DigestSchema,
  effectFingerprint: DigestSchema,
  outcome: RemoteApplyOutcomeSchema,
  affectedRangeStart: NonNegativeInt,
  affectedRangeEnd: NonNegativeInt,
  appliedAt: TimestampSchema,
  receipt: SyncCommitReceiptSchema
}).strict().superRefine((input, context) => {
  if (input.sequence === 1 && input.predecessorDigest !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "First remote sequence must have a null predecessor digest" });
  }
  if (input.sequence > 1 && input.predecessorDigest === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Non-initial remote sequence requires a predecessor digest" });
  }
  if (input.affectedRangeStart > input.affectedRangeEnd) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Affected range start must not exceed end" });
  }
  if (input.receipt.operation !== input.operation || input.receipt.personId !== input.personId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Remote sync apply receipt binding mismatch", path: ["receipt"] });
  }
});
export type CommitRemoteSyncApplyInput = z.infer<typeof CommitRemoteSyncApplyInputSchema>;

/**
 * Exact-state CAS that binds expected person/device/outbox identity and current row version before
 * sealing immutable protocol version, sequence, predecessor digest, envelope bytes, and digest.
 * Identical resealing is idempotent; differing bytes are durable equivocation.
 */
export const SealClaimedOutboxEnvelopeInputSchema = z.object({
  personId: IdSchema,
  deviceId: IdSchema,
  outboxId: IdSchema,
  expectedRowVersion: NonNegativeInt,
  protocolVersion: PositiveInt,
  sequence: PositiveInt,
  predecessorDigest: DigestSchema.nullable(),
  envelopeBytesBase64: Base64Schema,
  envelopeDigest: DigestSchema
}).strict();
export type SealClaimedOutboxEnvelopeInput = z.infer<typeof SealClaimedOutboxEnvelopeInputSchema>;

export const SealOutboxResultSchema = z.object({
  status: z.enum(["SEALED", "IDEMPOTENT", "EQUIVOCATION", "STATE_CHANGED"]),
  record: SyncOutboxOperationSchema.nullable()
}).strict();
export type SealOutboxResult = z.infer<typeof SealOutboxResultSchema>;

export type SyncFaultBoundary =
  | "local_sync_before_effect" | "local_sync_after_effect" | "local_sync_after_outbox"
  | "remote_apply_before_write" | "remote_apply_after_operation" | "remote_apply_after_outcome" | "remote_apply_after_frontier" | "remote_apply_after_range"
  | "seal_outbox_before_write" | "seal_outbox_after_write";
