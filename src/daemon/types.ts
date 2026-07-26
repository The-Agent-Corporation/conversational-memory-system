import { z } from "zod";
import { RollingTopicCheckpointSchema } from "../bootstrap/types.js";
import { CanonicalEventSchema, MemorySourceSchema } from "../domain/canonical.js";
import {
  AnchorSchema,
  BoxSchema,
  IsoDateTimeSchema,
  MemoryProposalSchema,
  MemoryTraceSchema,
  SummarySchema,
  TurnSchema
} from "../domain/types.js";
import { QuarantineRecordSchema } from "../domain/source-lifecycle.js";
import { ImportCheckpointSchema } from "../imports/types.js";

export const DEFAULT_DAEMON_DURATIONS = Object.freeze({
  heartbeatMs: 10_000,
  leaseExpiryMs: 30_000
});

export const CanonicalOrderKeySchema = z.object({
  occurredAt: IsoDateTimeSchema,
  nativeSequence: z.number().int().nonnegative(),
  id: z.string().min(1)
}).strict();

export const DaemonLeaseSchema = z.object({
  databaseId: z.string().min(1),
  ownerToken: z.string().min(1),
  pid: z.number().int().positive(),
  acquiredAt: IsoDateTimeSchema,
  heartbeatAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
  stopRequestedAt: IsoDateTimeSchema.nullable(),
  lastSuccessfulScanAt: IsoDateTimeSchema.nullable()
}).strict();

export const DaemonErrorCategorySchema = z.enum([
  "temporarily_absent",
  "rotated",
  "permission_denied",
  "malformed_source",
  "grant_revoked",
  "unsupported_format",
  "storage_failure",
  "unknown"
]);

export const DaemonSourceStateSchema = z.object({
  id: z.string().min(1),
  personId: z.string().min(1),
  grantId: z.string().min(1),
  candidateId: z.string().min(1),
  scopeId: z.string().min(1),
  state: z.enum(["healthy", "retrying", "degraded"]),
  nextDueAt: IsoDateTimeSchema,
  attemptCount: z.number().int().nonnegative(),
  consecutiveFailures: z.number().int().nonnegative(),
  lastAttemptAt: IsoDateTimeSchema.nullable(),
  lastSuccessAt: IsoDateTimeSchema.nullable(),
  firstFailureAt: IsoDateTimeSchema.nullable(),
  lastFailureAt: IsoDateTimeSchema.nullable(),
  errorCategory: DaemonErrorCategorySchema.nullable(),
  degradedAt: IsoDateTimeSchema.nullable(),
  notificationSentAt: IsoDateTimeSchema.nullable(),
  updatedAt: IsoDateTimeSchema
}).strict();

export const ImportBatchReceiptSchema = z.object({
  id: z.string().min(1),
  personId: z.string().min(1),
  grantId: z.string().min(1),
  candidateId: z.string().min(1),
  scopeId: z.string().min(1),
  canonicalEventIds: z.array(z.string().min(1)),
  canonicalOrderKeys: z.array(CanonicalOrderKeySchema),
  checkpointIds: z.array(z.string().min(1)),
  committedAt: IsoDateTimeSchema
}).strict();

export const ContractionJobSchema = z.object({
  id: z.string().min(1),
  personId: z.string().min(1),
  generation: z.number().int().positive(),
  earliestAffected: CanonicalOrderKeySchema,
  latestAffected: CanonicalOrderKeySchema,
  state: z.enum(["pending", "running", "complete", "failed"]),
  attempts: z.number().int().nonnegative(),
  immediateDirty: z.boolean(),
  proposalDirty: z.boolean(),
  lastProposalRunAt: IsoDateTimeSchema.nullable(),
  lastActivityAt: IsoDateTimeSchema,
  nextDueAt: IsoDateTimeSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema
}).strict();

// `toolCounts` is stored already-ordered (count desc, then name asc, matching `collapseText`'s
// rendering) so the withheld run's activity line can be rebuilt on flush without re-sorting.
export const PendingToolRunSchema = z.object({
  startEventId: z.string().min(1),
  eventCount: z.number().int().positive(),
  toolCounts: z.array(z.object({ tool: z.string().min(1), count: z.number().int().positive() }).strict()).min(1),
  // Stored on the pending run itself (in addition to `processorVersion`) so a hygiene rule-version
  // bump can be detected against an in-flight withheld run specifically, not only at the checkpoint level.
  ruleVersion: z.string().min(1)
}).strict();

export const ContractionCheckpointSchema = z.object({
  id: z.string().min(1),
  personId: z.string().min(1),
  jobId: z.string().min(1),
  processorVersion: z.string().min(1),
  generation: z.number().int().positive(),
  processedThroughOrderKey: CanonicalOrderKeySchema.nullable(),
  nextOrderKey: CanonicalOrderKeySchema.nullable(),
  nextEventId: z.string().min(1).nullable(),
  activeTopic: RollingTopicCheckpointSchema.nullable(),
  sliceCount: z.number().int().nonnegative(),
  immediateStage: z.enum(["pending", "running", "complete"]),
  proposalStage: z.enum(["pending", "running", "complete"]),
  pendingToolRun: PendingToolRunSchema.nullable(),
  updatedAt: IsoDateTimeSchema
}).strict();

export const DerivationSupersessionSchema = z.object({
  personId: z.string().min(1),
  kind: z.enum(["summary", "box", "anchor", "proposal", "trace"]),
  id: z.string().min(1),
  supersededAt: IsoDateTimeSchema
}).strict();

export const ExpectedSourceGrantSchema = z.object({
  id: z.string().min(1),
  personId: z.string().min(1),
  candidateId: z.string().min(1),
  updatedAt: IsoDateTimeSchema
}).strict();

export const ExpectedApprovedSourceGrantSchema = ExpectedSourceGrantSchema.extend({
  scopeId: z.string().min(1),
  state: z.literal("approved")
}).strict();

export const DaemonWriteAuthoritySchema = z.object({
  kind: z.literal("daemon"),
  databaseId: z.string().min(1),
  ownerToken: z.string().min(1)
}).strict();

export const ForegroundWriteAuthoritySchema = z.object({
  kind: z.literal("foreground"),
  personId: z.string().min(1),
  operation: z.enum(["approved-import", "historical-bootstrap"])
}).strict();

export const WriteAuthoritySchema = z.discriminatedUnion("kind", [
  DaemonWriteAuthoritySchema,
  ForegroundWriteAuthoritySchema
]);

export const CommitImportBatchInputSchema = z.object({
  authority: WriteAuthoritySchema,
  personId: z.string().min(1),
  expectedGrant: ExpectedSourceGrantSchema,
  sources: z.array(MemorySourceSchema),
  canonicalEvents: z.array(CanonicalEventSchema),
  turns: z.array(TurnSchema),
  quarantineChanges: z.array(QuarantineRecordSchema),
  checkpoint: ImportCheckpointSchema,
  receipt: ImportBatchReceiptSchema,
  contractionJob: ContractionJobSchema.nullable()
}).strict();

export const CommitContractionSliceInputSchema = z.object({
  authority: WriteAuthoritySchema,
  personId: z.string().min(1),
  jobId: z.string().min(1),
  expectedCheckpoint: ContractionCheckpointSchema.nullable(),
  turns: z.array(TurnSchema),
  summaries: z.array(SummarySchema),
  anchors: z.array(AnchorSchema),
  boxes: z.array(BoxSchema),
  proposals: z.array(MemoryProposalSchema),
  traces: z.array(MemoryTraceSchema),
  supersessions: z.array(DerivationSupersessionSchema),
  nextCheckpoint: ContractionCheckpointSchema,
  nextJob: ContractionJobSchema
}).strict();

const ExpectedDaemonSourceStateSchema = DaemonSourceStateSchema.nullable();
const ExpectedContractionJobSchema = ContractionJobSchema.nullable();
const ExpectedContractionCheckpointSchema = ContractionCheckpointSchema.nullable();

export const CommitApprovedGrantReconciliationInputSchema = z.object({
  authority: DaemonWriteAuthoritySchema,
  personId: z.string().min(1),
  expectedGrants: z.array(ExpectedApprovedSourceGrantSchema),
  expectedStates: z.array(DaemonSourceStateSchema),
  nextStates: z.array(DaemonSourceStateSchema)
}).strict();

export const CommitDueSourceRefreshInputSchema = z.object({
  authority: DaemonWriteAuthoritySchema,
  personId: z.string().min(1),
  expectedStates: z.array(DaemonSourceStateSchema),
  nextStates: z.array(DaemonSourceStateSchema)
}).strict();

export const CommitSourceStateOutcomeInputSchema = z.object({
  authority: DaemonWriteAuthoritySchema,
  personId: z.string().min(1),
  candidateId: z.string().min(1),
  expectedState: ExpectedDaemonSourceStateSchema,
  nextState: DaemonSourceStateSchema
}).strict();

export const CommitProposalRunInputSchema = z.object({
  authority: WriteAuthoritySchema,
  personId: z.string().min(1),
  jobId: z.string().min(1),
  expectedJob: ExpectedContractionJobSchema,
  expectedCheckpoint: ExpectedContractionCheckpointSchema,
  boxes: z.array(BoxSchema),
  proposals: z.array(MemoryProposalSchema),
  traces: z.array(MemoryTraceSchema),
  nextJob: ContractionJobSchema,
  nextCheckpoint: ContractionCheckpointSchema.nullable()
}).strict().superRefine((input, context) => {
  const outputs = [...input.boxes, ...input.proposals, ...input.traces];
  if (outputs.some((item) => item.state !== "proposed")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Proposal publication accepts only proposed review objects" });
  }
  if (outputs.some((item) => item.personId !== input.personId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Proposal publication requires exact person ownership" });
  }
});

export const CommitDaemonWorkOutcomeInputSchema = z.object({
  authority: DaemonWriteAuthoritySchema,
  personId: z.string().min(1),
  jobId: z.string().min(1),
  expectedJob: ExpectedContractionJobSchema,
  nextJob: ContractionJobSchema
}).strict();

export type CanonicalOrderKey = z.infer<typeof CanonicalOrderKeySchema>;
export type DaemonLease = z.infer<typeof DaemonLeaseSchema>;
export type DaemonErrorCategory = z.infer<typeof DaemonErrorCategorySchema>;
export type DaemonSourceState = z.infer<typeof DaemonSourceStateSchema>;
export type ImportBatchReceipt = z.infer<typeof ImportBatchReceiptSchema>;
export type ContractionJob = z.infer<typeof ContractionJobSchema>;
export type ContractionCheckpoint = z.infer<typeof ContractionCheckpointSchema>;
export type PendingToolRun = z.infer<typeof PendingToolRunSchema>;
export type DerivationSupersession = z.infer<typeof DerivationSupersessionSchema>;
export type DaemonWriteAuthority = z.infer<typeof DaemonWriteAuthoritySchema>;
export type ForegroundWriteAuthority = z.infer<typeof ForegroundWriteAuthoritySchema>;
export type WriteAuthority = z.infer<typeof WriteAuthoritySchema>;
export type CommitImportBatchInput = z.infer<typeof CommitImportBatchInputSchema>;
export type CommitContractionSliceInput = z.infer<typeof CommitContractionSliceInputSchema>;
export type CommitApprovedGrantReconciliationInput = z.infer<typeof CommitApprovedGrantReconciliationInputSchema>;
export type CommitDueSourceRefreshInput = z.infer<typeof CommitDueSourceRefreshInputSchema>;
export type CommitSourceStateOutcomeInput = z.infer<typeof CommitSourceStateOutcomeInputSchema>;
export type CommitProposalRunInput = z.infer<typeof CommitProposalRunInputSchema>;
export type CommitDaemonWorkOutcomeInput = z.infer<typeof CommitDaemonWorkOutcomeInputSchema>;

export type DaemonWorkItem =
  | {
      kind: "source_scan";
      personId: string;
      candidateId: string;
      jobId?: never;
      stage: "import";
      urgency: "prompt" | "due";
    }
  | {
      kind: "contraction";
      personId: string;
      candidateId?: never;
      jobId: string;
      stage: "contraction";
      urgency: "due";
    };
