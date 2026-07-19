import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const IdentifierSchema = z.string().trim().min(1).max(512);
const ConfirmationTokenSchema = z.string().min(32).max(512);
const IsoDateTimeSchema = z.string().datetime();
const ActorSchema = z.string().trim().min(1).max(256);
const NoteSchema = z.string().trim().max(2_000);
const CountSchema = z.number().int().nonnegative();
const FingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const SourceAliasSchema = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

const PreviewResultFields = {
  token: ConfirmationTokenSchema,
  expiresAt: IsoDateTimeSchema,
  effectsFingerprint: FingerprintSchema
} as const;

const ReceiptResultFields = {
  status: z.enum(["COMMITTED", "STATE_CHANGED"]),
  targetId: IdentifierSchema,
  committedAt: IsoDateTimeSchema
} as const;

const HistoryEffectCountsSchema = z.object({
  sources: CountSchema,
  events: CountSchema,
  checkpoints: CountSchema,
  audits: CountSchema
}).strict();

const ProposalEffectCountsSchema = z.object({
  proposals: CountSchema,
  boxes: CountSchema,
  traces: CountSchema
}).strict();

const RevocationEffectCountsSchema = z.object({
  grants: CountSchema,
  audits: CountSchema
}).strict();

const DeletionEffectCountsSchema = z.object({
  sources: CountSchema,
  events: CountSchema,
  anchors: CountSchema,
  summaries: CountSchema,
  boxes: CountSchema,
  proposals: CountSchema,
  traces: CountSchema,
  audits: CountSchema
}).strict();

export const HistoryIngestPreviewInputSchema = z.object({
  sourceAlias: SourceAliasSchema,
  source: z.enum(["codex", "claude-code", "openclaw", "hermes"]),
  requestedAt: IsoDateTimeSchema
}).strict();

export const HistoryIngestExecuteInputSchema = HistoryIngestPreviewInputSchema.extend({
  token: ConfirmationTokenSchema
}).strict();

export const HistoryIngestPreviewOutputSchema = z.object({
  ...PreviewResultFields,
  effectCounts: HistoryEffectCountsSchema
}).strict();

export const HistoryIngestExecuteOutputSchema = z.object({
  operation: z.literal("history_import"),
  ...ReceiptResultFields,
  effectCounts: HistoryEffectCountsSchema
}).strict();

const ProposalPreviewInputSchema = z.object({
  proposalId: IdentifierSchema,
  decidedAt: IsoDateTimeSchema,
  reviewer: ActorSchema.optional(),
  note: NoteSchema.optional()
}).strict();

export const ProposalApprovePreviewInputSchema = ProposalPreviewInputSchema;
export const ProposalApproveExecuteInputSchema = ProposalPreviewInputSchema.extend({
  token: ConfirmationTokenSchema
}).strict();
export const ProposalRejectPreviewInputSchema = ProposalPreviewInputSchema;
export const ProposalRejectExecuteInputSchema = ProposalPreviewInputSchema.extend({
  token: ConfirmationTokenSchema
}).strict();

const ProposalPreviewOutputSchema = z.object({
  ...PreviewResultFields,
  effectCounts: ProposalEffectCountsSchema
}).strict();

const ProposalExecuteOutputSchema = z.object({
  operation: z.literal("proposal_decision"),
  ...ReceiptResultFields,
  effectCounts: ProposalEffectCountsSchema
}).strict();

export const ProposalApprovePreviewOutputSchema = ProposalPreviewOutputSchema;
export const ProposalApproveExecuteOutputSchema = ProposalExecuteOutputSchema;
export const ProposalRejectPreviewOutputSchema = ProposalPreviewOutputSchema;
export const ProposalRejectExecuteOutputSchema = ProposalExecuteOutputSchema;

const SourceRevokePreviewInput = z.object({
  candidateId: IdentifierSchema,
  actor: ActorSchema,
  revokedAt: IsoDateTimeSchema
}).strict();

export const SourceRevokePreviewInputSchema = SourceRevokePreviewInput;
export const SourceRevokeExecuteInputSchema = SourceRevokePreviewInput.extend({
  token: ConfirmationTokenSchema
}).strict();

export const SourceRevokePreviewOutputSchema = z.object({
  ...PreviewResultFields,
  effectCounts: RevocationEffectCountsSchema
}).strict();

export const SourceRevokeExecuteOutputSchema = z.object({
  operation: z.literal("source_revocation"),
  ...ReceiptResultFields,
  effectCounts: RevocationEffectCountsSchema
}).strict();

const SourceDeletePreviewInput = z.object({
  candidateId: IdentifierSchema,
  actor: ActorSchema,
  deletedAt: IsoDateTimeSchema
}).strict();

export const SourceDeletePreviewInputSchema = SourceDeletePreviewInput;
export const SourceDeleteExecuteInputSchema = SourceDeletePreviewInput.extend({
  token: ConfirmationTokenSchema
}).strict();

export const SourceDeletePreviewOutputSchema = z.object({
  ...PreviewResultFields,
  effectCounts: DeletionEffectCountsSchema
}).strict();

export const SourceDeleteExecuteOutputSchema = z.object({
  operation: z.literal("source_deletion"),
  ...ReceiptResultFields,
  effectCounts: DeletionEffectCountsSchema
}).strict();

export const MEMORY_MUTATION_TOOL_NAMES = [
  "history_ingest_preview",
  "history_ingest_execute",
  "proposal_approve_preview",
  "proposal_approve_execute",
  "proposal_reject_preview",
  "proposal_reject_execute",
  "source_revoke_preview",
  "source_revoke_execute",
  "source_delete_preview",
  "source_delete_execute"
] as const;

export const mutationAnnotations = (destructiveHint: boolean): Readonly<ToolAnnotations> => Object.freeze({
  readOnlyHint: false,
  destructiveHint,
  idempotentHint: false,
  openWorldHint: false
});
