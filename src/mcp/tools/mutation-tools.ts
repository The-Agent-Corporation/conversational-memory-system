import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { MutationCommitReceipt } from "../../storage/mcp-mutation-contracts.js";
import { createResponseEnvelope } from "../response-envelope.js";

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
  effectCounts: HistoryEffectCountsSchema.partial()
}).strict();

const ProposalPreviewInputSchema = z.object({
  proposalId: IdentifierSchema,
  decidedAt: IsoDateTimeSchema,
  reviewer: ActorSchema.optional(),
  note: NoteSchema.optional()
}).strict();

export const ProposalApprovePreviewInputSchema = ProposalPreviewInputSchema.extend({}).strict();
export const ProposalApproveExecuteInputSchema = ProposalPreviewInputSchema.extend({
  token: ConfirmationTokenSchema
}).strict();
export const ProposalRejectPreviewInputSchema = ProposalPreviewInputSchema.extend({}).strict();
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
  effectCounts: ProposalEffectCountsSchema.partial()
}).strict();

export const ProposalApprovePreviewOutputSchema = ProposalPreviewOutputSchema.extend({}).strict();
export const ProposalApproveExecuteOutputSchema = ProposalExecuteOutputSchema.extend({}).strict();
export const ProposalRejectPreviewOutputSchema = ProposalPreviewOutputSchema.extend({}).strict();
export const ProposalRejectExecuteOutputSchema = ProposalExecuteOutputSchema.extend({}).strict();

const SourceRevokePreviewInput = z.object({
  candidateId: IdentifierSchema,
  actor: ActorSchema,
  revokedAt: IsoDateTimeSchema
}).strict();

export const SourceRevokePreviewInputSchema = SourceRevokePreviewInput.extend({}).strict();
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
  effectCounts: RevocationEffectCountsSchema.partial()
}).strict();

const SourceDeletePreviewInput = z.object({
  candidateId: IdentifierSchema,
  actor: ActorSchema,
  deletedAt: IsoDateTimeSchema
}).strict();

export const SourceDeletePreviewInputSchema = SourceDeletePreviewInput.extend({}).strict();
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
  effectCounts: DeletionEffectCountsSchema.partial()
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

export const MEMORY_MUTATION_TOOL_ANNOTATIONS: Readonly<Record<typeof MEMORY_MUTATION_TOOL_NAMES[number], Readonly<ToolAnnotations>>> = Object.freeze({
  history_ingest_preview: mutationAnnotations(false),
  history_ingest_execute: mutationAnnotations(false),
  proposal_approve_preview: mutationAnnotations(false),
  proposal_approve_execute: mutationAnnotations(true),
  proposal_reject_preview: mutationAnnotations(false),
  proposal_reject_execute: mutationAnnotations(true),
  source_revoke_preview: mutationAnnotations(false),
  source_revoke_execute: mutationAnnotations(true),
  source_delete_preview: mutationAnnotations(false),
  source_delete_execute: mutationAnnotations(true)
});

type HistoryPreviewInput = z.infer<typeof HistoryIngestPreviewInputSchema>;
type HistoryExecuteInput = z.infer<typeof HistoryIngestExecuteInputSchema>;
type ProposalPreviewInput = z.infer<typeof ProposalApprovePreviewInputSchema>;
type ProposalExecuteInput = z.infer<typeof ProposalApproveExecuteInputSchema>;
type RevokePreviewInput = z.infer<typeof SourceRevokePreviewInputSchema>;
type RevokeExecuteInput = z.infer<typeof SourceRevokeExecuteInputSchema>;
type DeletePreviewInput = z.infer<typeof SourceDeletePreviewInputSchema>;
type DeleteExecuteInput = z.infer<typeof SourceDeleteExecuteInputSchema>;

interface ApplicationPreview {
  readonly token: string;
  readonly expiresAt: string;
  readonly effectsFingerprint: string;
  readonly effects: object;
}

/** The fixed application seam captured at startup; authority never enters a tool argument. */
export interface MemoryMutationToolApplication {
  previewHistoryIngest(input: HistoryPreviewInput): Promise<ApplicationPreview>;
  executeHistoryIngest(input: HistoryExecuteInput): Promise<MutationCommitReceipt>;
  previewProposalApproval(input: ProposalPreviewInput): Promise<ApplicationPreview>;
  executeProposalApproval(input: ProposalExecuteInput): Promise<MutationCommitReceipt>;
  previewProposalRejection(input: ProposalPreviewInput): Promise<ApplicationPreview>;
  executeProposalRejection(input: ProposalExecuteInput): Promise<MutationCommitReceipt>;
  previewSourceRevocation(input: RevokePreviewInput): Promise<ApplicationPreview>;
  executeSourceRevocation(input: RevokeExecuteInput): Promise<MutationCommitReceipt>;
  previewSourceDeletion(input: DeletePreviewInput): Promise<ApplicationPreview>;
  executeSourceDeletion(input: DeleteExecuteInput): Promise<MutationCommitReceipt>;
}

export const registerMemoryMutationTools = (
  server: McpServer,
  application: MemoryMutationToolApplication
): void => {
  server.registerTool("history_ingest_preview", {
    title: "Preview configured history ingestion",
    description: "Issue a single-use confirmation ticket for one configured source alias and exact import effects.",
    inputSchema: HistoryIngestPreviewInputSchema,
    outputSchema: HistoryIngestPreviewOutputSchema,
    annotations: MEMORY_MUTATION_TOOL_ANNOTATIONS.history_ingest_preview
  }, async (input) => safeMutation(async () => previewOutput(
    await application.previewHistoryIngest(input),
    { sources: "sourceIds", events: "eventIds", checkpoints: "checkpointIds", audits: "auditEventIds" }
  )));

  server.registerTool("history_ingest_execute", {
    title: "Execute configured history ingestion",
    description: "Consume an exact single-use confirmation and atomically import the previewed configured source batch.",
    inputSchema: HistoryIngestExecuteInputSchema,
    outputSchema: HistoryIngestExecuteOutputSchema,
    annotations: MEMORY_MUTATION_TOOL_ANNOTATIONS.history_ingest_execute
  }, async (input) => safeMutation(async () => receiptOutput(await application.executeHistoryIngest(input))));

  server.registerTool("proposal_approve_preview", {
    title: "Preview proposal approval",
    description: "Issue a single-use confirmation ticket for one scoped proposal approval and exact effects.",
    inputSchema: ProposalApprovePreviewInputSchema,
    outputSchema: ProposalApprovePreviewOutputSchema,
    annotations: MEMORY_MUTATION_TOOL_ANNOTATIONS.proposal_approve_preview
  }, async (input) => safeMutation(async () => previewOutput(
    await application.previewProposalApproval(input),
    { proposals: "proposalIds", boxes: "boxIds", traces: "traceIds" }
  )));

  server.registerTool("proposal_approve_execute", {
    title: "Execute proposal approval",
    description: "Consume an exact single-use confirmation and atomically apply the previewed proposal approval.",
    inputSchema: ProposalApproveExecuteInputSchema,
    outputSchema: ProposalApproveExecuteOutputSchema,
    annotations: MEMORY_MUTATION_TOOL_ANNOTATIONS.proposal_approve_execute
  }, async (input) => safeMutation(async () => receiptOutput(await application.executeProposalApproval(input))));

  server.registerTool("proposal_reject_preview", {
    title: "Preview proposal rejection",
    description: "Issue a single-use confirmation ticket for one scoped proposal rejection and exact effects.",
    inputSchema: ProposalRejectPreviewInputSchema,
    outputSchema: ProposalRejectPreviewOutputSchema,
    annotations: MEMORY_MUTATION_TOOL_ANNOTATIONS.proposal_reject_preview
  }, async (input) => safeMutation(async () => previewOutput(
    await application.previewProposalRejection(input),
    { proposals: "proposalIds", boxes: "boxIds", traces: "traceIds" }
  )));

  server.registerTool("proposal_reject_execute", {
    title: "Execute proposal rejection",
    description: "Consume an exact single-use confirmation and atomically apply the previewed proposal rejection.",
    inputSchema: ProposalRejectExecuteInputSchema,
    outputSchema: ProposalRejectExecuteOutputSchema,
    annotations: MEMORY_MUTATION_TOOL_ANNOTATIONS.proposal_reject_execute
  }, async (input) => safeMutation(async () => receiptOutput(await application.executeProposalRejection(input))));

  server.registerTool("source_revoke_preview", {
    title: "Preview source revocation",
    description: "Issue a single-use confirmation ticket to stop future reads from one exact approved source.",
    inputSchema: SourceRevokePreviewInputSchema,
    outputSchema: SourceRevokePreviewOutputSchema,
    annotations: MEMORY_MUTATION_TOOL_ANNOTATIONS.source_revoke_preview
  }, async (input) => safeMutation(async () => previewOutput(
    await application.previewSourceRevocation(input),
    { grants: "grantIds", audits: "auditEventIds" }
  )));

  server.registerTool("source_revoke_execute", {
    title: "Execute source revocation",
    description: "Consume an exact single-use confirmation and atomically revoke one source without deleting memory.",
    inputSchema: SourceRevokeExecuteInputSchema,
    outputSchema: SourceRevokeExecuteOutputSchema,
    annotations: MEMORY_MUTATION_TOOL_ANNOTATIONS.source_revoke_execute
  }, async (input) => safeMutation(async () => receiptOutput(await application.executeSourceRevocation(input))));

  server.registerTool("source_delete_preview", {
    title: "Preview attributable source deletion",
    description: "Issue a single-use confirmation ticket for exact memory effects attributable to one revoked source.",
    inputSchema: SourceDeletePreviewInputSchema,
    outputSchema: SourceDeletePreviewOutputSchema,
    annotations: MEMORY_MUTATION_TOOL_ANNOTATIONS.source_delete_preview
  }, async (input) => safeMutation(async () => previewOutput(
    await application.previewSourceDeletion(input),
    {
      sources: "sourceIds", events: "canonicalEventIds", anchors: "anchorIds",
      summaries: "supersededSummaryIds", boxes: "supersededBoxIds",
      proposals: "supersededProposalIds", traces: "supersededTraceIds", audits: "auditEventIds"
    }
  )));

  server.registerTool("source_delete_execute", {
    title: "Execute attributable source deletion",
    description: "Consume an exact single-use confirmation and atomically delete only memory attributable to one revoked source.",
    inputSchema: SourceDeleteExecuteInputSchema,
    outputSchema: SourceDeleteExecuteOutputSchema,
    annotations: MEMORY_MUTATION_TOOL_ANNOTATIONS.source_delete_execute
  }, async (input) => safeMutation(async () => receiptOutput(await application.executeSourceDeletion(input))));
};

const previewOutput = (
  preview: ApplicationPreview,
  countKeys: Readonly<Record<string, string>>
): Record<string, unknown> => ({
  token: preview.token,
  expiresAt: preview.expiresAt,
  effectsFingerprint: preview.effectsFingerprint,
  effectCounts: Object.fromEntries(Object.entries(countKeys).map(([outputKey, effectKey]) => [
    outputKey,
    effectCount(preview.effects, effectKey)
  ]))
});

const effectCount = (effects: object, key: string): number => {
  const value = (effects as Record<string, unknown>)[key];
  return Array.isArray(value) ? value.length : 0;
};

const receiptOutput = (receipt: MutationCommitReceipt): Record<string, unknown> => ({
  operation: receipt.operation,
  status: receipt.status,
  targetId: receipt.targetId,
  effectCounts: { ...receipt.effectCounts },
  committedAt: receipt.committedAt
});

const safeMutation = async (
  operation: () => Promise<Record<string, unknown>>
): Promise<CallToolResult> => {
  try {
    const envelope = createResponseEnvelope(await operation());
    return {
      structuredContent: envelope.structuredContent,
      content: envelope.content.map((item) => ({ ...item }))
    };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: `Memory mutation failed: ${sanitizedMutationErrorCode(error)}` }]
    };
  }
};

const sanitizedMutationErrorCode = (error: unknown): string => {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (typeof code === "string" && [
    "UNAUTHORIZED_OR_NOT_FOUND", "SOURCE_NOT_REVOKED", "STATE_CHANGED",
    "CONFIRMATION_EXPIRED", "CONFIRMATION_MISMATCH", "CONFIRMATION_REPLAYED"
  ].includes(code)) return code;
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("UNAUTHORIZED_OR_NOT_FOUND")) return "UNAUTHORIZED_OR_NOT_FOUND";
  return "INVALID_REQUEST";
};
