import { createHash } from "node:crypto";
import { z } from "zod";
import { HistoricalBootstrapCheckpointSchema } from "../bootstrap/types.js";
import { CanonicalEventSchema, MemorySourceSchema } from "../domain/canonical.js";
import {
  SourceGrantSchema,
  SourceLifecycleAuditEventSchema
} from "../domain/source-lifecycle.js";
import {
  AnchorSchema,
  BoxSchema,
  IsoDateTimeSchema,
  JsonObjectSchema,
  MemoryProposalSchema,
  MemoryTraceSchema,
  SummarySchema
} from "../domain/types.js";
import { ImportCheckpointSchema } from "../imports/types.js";

const IdSchema = z.string().min(1);
const IdListSchema = z.array(IdSchema);
const EffectCountsSchema = z.record(z.number().int().nonnegative());

export const MutationCommitReceiptSchema = z.object({
  operation: z.enum(["history_import", "proposal_decision", "source_revocation", "source_deletion"]),
  status: z.enum(["COMMITTED", "STATE_CHANGED"]),
  personId: IdSchema,
  targetId: IdSchema,
  effectCounts: EffectCountsSchema,
  committedAt: IsoDateTimeSchema
}).strict();

export type MutationCommitReceipt = z.infer<typeof MutationCommitReceiptSchema>;

const HistoryImportEffectsSchema = z.object({
  sourceIds: IdListSchema,
  eventIds: IdListSchema,
  checkpointIds: IdListSchema,
  auditEventIds: IdListSchema
}).strict();

const ProposalEffectsSchema = z.object({
  proposalIds: IdListSchema,
  boxIds: IdListSchema,
  traceIds: IdListSchema
}).strict();

export const SourceDeletionEffectsSchema = z.object({
  sourceIds: IdListSchema,
  canonicalEventIds: IdListSchema,
  turnIds: IdListSchema,
  anchorIds: IdListSchema,
  injectionIds: IdListSchema,
  quarantineIds: IdListSchema,
  bootstrapCheckpointIds: IdListSchema,
  supersededSummaryIds: IdListSchema,
  supersededBoxIds: IdListSchema,
  supersededProposalIds: IdListSchema,
  supersededTraceIds: IdListSchema,
  auditEventIds: IdListSchema
}).strict();

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

/** A deterministic, content-free binding used by preview and execute. */
export const mutationEffectsFingerprint = (value: unknown): string =>
  createHash("sha256").update(stableJson(value)).digest("hex");

const assertIdsEqual = (
  value: string[],
  expected: string[],
  context: z.RefinementCtx,
  path: Array<string | number>
): void => {
  if (new Set(value).size !== value.length || stableJson([...value].sort()) !== stableJson([...expected].sort())) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Exact effect IDs do not match supplied objects", path });
  }
};

export const CommitHistoryImportInputSchema = z.object({
  operation: z.literal("history_import"),
  personId: IdSchema,
  candidateId: IdSchema,
  normalizedParameters: JsonObjectSchema,
  expectedSource: MemorySourceSchema.nullable(),
  expectedSourceStateFingerprint: IdSchema,
  expectedCheckpoint: ImportCheckpointSchema.nullable(),
  expectedGrant: SourceGrantSchema,
  targetCanonicalEventIds: IdListSchema,
  nextSources: z.array(MemorySourceSchema),
  nextCanonicalEvents: z.array(CanonicalEventSchema),
  nextCheckpoint: ImportCheckpointSchema,
  auditEvents: z.array(SourceLifecycleAuditEventSchema),
  effects: HistoryImportEffectsSchema,
  effectsFingerprint: IdSchema,
  receipt: MutationCommitReceiptSchema
}).strict().superRefine((input, context) => {
  const owned = [input.expectedSource, input.expectedCheckpoint, input.expectedGrant, input.nextCheckpoint,
    ...input.nextSources, ...input.nextCanonicalEvents, ...input.auditEvents].filter(Boolean) as Array<{ personId: string }>;
  if (owned.some((item) => item.personId !== input.personId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "History import crosses a person boundary" });
  }
  if (input.expectedGrant.candidateId !== input.candidateId || input.expectedGrant.state !== "approved" ||
      input.nextCheckpoint.candidateId !== input.candidateId ||
      (input.expectedCheckpoint !== null && input.expectedCheckpoint.candidateId !== input.candidateId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "History import candidate/grant/checkpoint mismatch" });
  }
  if (input.expectedSourceStateFingerprint !== mutationEffectsFingerprint(input.expectedSource) ||
      input.effectsFingerprint !== mutationEffectsFingerprint(input.effects)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "History import fingerprint mismatch" });
  }
  assertIdsEqual(input.targetCanonicalEventIds, input.effects.eventIds, context, ["targetCanonicalEventIds"]);
  assertIdsEqual(input.nextSources.map((item) => item.id), input.effects.sourceIds, context, ["effects", "sourceIds"]);
  assertIdsEqual(input.nextCanonicalEvents.map((item) => item.id), input.effects.eventIds, context, ["effects", "eventIds"]);
  assertIdsEqual([input.nextCheckpoint.id], input.effects.checkpointIds, context, ["effects", "checkpointIds"]);
  assertIdsEqual(input.auditEvents.map((item) => item.id), input.effects.auditEventIds, context, ["effects", "auditEventIds"]);
  if (input.receipt.operation !== input.operation || input.receipt.personId !== input.personId || input.receipt.targetId !== input.candidateId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "History import receipt binding mismatch", path: ["receipt"] });
  }
});

export const CommitProposalDecisionInputSchema = z.object({
  operation: z.literal("proposal_decision"),
  personId: IdSchema,
  decision: z.enum(["approve", "reject"]),
  expectedProposal: MemoryProposalSchema,
  nextProposal: MemoryProposalSchema,
  nextBoxes: z.array(BoxSchema),
  nextTraces: z.array(MemoryTraceSchema),
  effects: ProposalEffectsSchema,
  effectsFingerprint: IdSchema,
  receipt: MutationCommitReceiptSchema
}).strict().superRefine((input, context) => {
  const owned = [input.expectedProposal, input.nextProposal, ...input.nextBoxes, ...input.nextTraces];
  if (owned.some((item) => item.personId !== input.personId)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Proposal decision crosses a person boundary" });
  if (input.expectedProposal.id !== input.nextProposal.id || input.expectedProposal.state !== "proposed" ||
      input.nextProposal.state !== (input.decision === "approve" ? "approved" : "rejected")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Proposal decision state mismatch" });
  }
  if (input.effectsFingerprint !== mutationEffectsFingerprint(input.effects)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Proposal effects fingerprint mismatch" });
  assertIdsEqual([input.nextProposal.id], input.effects.proposalIds, context, ["effects", "proposalIds"]);
  assertIdsEqual(input.nextBoxes.map((item) => item.id), input.effects.boxIds, context, ["effects", "boxIds"]);
  assertIdsEqual(input.nextTraces.map((item) => item.id), input.effects.traceIds, context, ["effects", "traceIds"]);
  if (input.receipt.operation !== input.operation || input.receipt.personId !== input.personId || input.receipt.targetId !== input.expectedProposal.id) context.addIssue({ code: z.ZodIssueCode.custom, message: "Proposal receipt binding mismatch", path: ["receipt"] });
});

export const CommitSourceRevocationInputSchema = z.object({
  operation: z.literal("source_revocation"),
  personId: IdSchema,
  expectedGrant: SourceGrantSchema,
  nextGrant: SourceGrantSchema,
  auditEvent: SourceLifecycleAuditEventSchema,
  effectsFingerprint: IdSchema,
  receipt: MutationCommitReceiptSchema
}).strict().superRefine((input, context) => {
  if ([input.expectedGrant, input.nextGrant, input.auditEvent].some((item) => item.personId !== input.personId)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Source revocation crosses a person boundary" });
  if (input.expectedGrant.id !== input.nextGrant.id || input.expectedGrant.state !== "approved" || input.nextGrant.state !== "revoked" || input.auditEvent.action !== "revoked" || input.auditEvent.grantId !== input.expectedGrant.id || input.auditEvent.candidateId !== input.expectedGrant.candidateId) context.addIssue({ code: z.ZodIssueCode.custom, message: "Source revocation state/effect mismatch" });
  if (input.effectsFingerprint !== mutationEffectsFingerprint({ grantId: input.nextGrant.id, auditEventId: input.auditEvent.id })) context.addIssue({ code: z.ZodIssueCode.custom, message: "Source revocation fingerprint mismatch" });
  if (input.receipt.operation !== input.operation || input.receipt.personId !== input.personId || input.receipt.targetId !== input.expectedGrant.candidateId) context.addIssue({ code: z.ZodIssueCode.custom, message: "Source revocation receipt binding mismatch", path: ["receipt"] });
});

export const CommitSourceDeletionInputSchema = z.object({
  operation: z.literal("source_deletion"),
  personId: IdSchema,
  expectedGrant: SourceGrantSchema,
  nextSummaries: z.array(SummarySchema),
  nextBoxes: z.array(BoxSchema),
  nextProposals: z.array(MemoryProposalSchema),
  nextTraces: z.array(MemoryTraceSchema),
  auditEvents: z.array(SourceLifecycleAuditEventSchema).length(2),
  effects: SourceDeletionEffectsSchema,
  effectsFingerprint: IdSchema,
  receipt: MutationCommitReceiptSchema
}).strict().superRefine((input, context) => {
  const owned = [input.expectedGrant, ...input.nextSummaries, ...input.nextBoxes, ...input.nextProposals, ...input.nextTraces, ...input.auditEvents];
  if (owned.some((item) => item.personId !== input.personId)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Source deletion crosses a person boundary" });
  if (input.expectedGrant.state !== "revoked" || input.auditEvents[0]?.action !== "deletion_requested" || input.auditEvents[1]?.action !== "deletion_completed" || input.auditEvents.some((event) => event.grantId !== input.expectedGrant.id || event.candidateId !== input.expectedGrant.candidateId)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Source deletion requires exact revoked state and audit pair" });
  if (input.effectsFingerprint !== mutationEffectsFingerprint(input.effects)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Source deletion fingerprint mismatch" });
  assertIdsEqual(input.nextSummaries.map((item) => item.id), input.effects.supersededSummaryIds, context, ["effects", "supersededSummaryIds"]);
  assertIdsEqual(input.nextBoxes.map((item) => item.id), input.effects.supersededBoxIds, context, ["effects", "supersededBoxIds"]);
  assertIdsEqual(input.nextProposals.map((item) => item.id), input.effects.supersededProposalIds, context, ["effects", "supersededProposalIds"]);
  assertIdsEqual(input.nextTraces.map((item) => item.id), input.effects.supersededTraceIds, context, ["effects", "supersededTraceIds"]);
  assertIdsEqual(input.auditEvents.map((item) => item.id), input.effects.auditEventIds, context, ["effects", "auditEventIds"]);
  if (input.receipt.operation !== input.operation || input.receipt.personId !== input.personId || input.receipt.targetId !== input.expectedGrant.candidateId) context.addIssue({ code: z.ZodIssueCode.custom, message: "Source deletion receipt binding mismatch", path: ["receipt"] });
});

export type CommitHistoryImportInput = z.infer<typeof CommitHistoryImportInputSchema>;
export type CommitProposalDecisionInput = z.infer<typeof CommitProposalDecisionInputSchema>;
export type CommitSourceRevocationInput = z.infer<typeof CommitSourceRevocationInputSchema>;
export type CommitSourceDeletionInput = z.infer<typeof CommitSourceDeletionInputSchema>;
export type SourceDeletionEffects = z.infer<typeof SourceDeletionEffectsSchema>;

export type McpMutationFaultBoundary =
  | "history_import_before_write" | "history_import_after_sources" | "history_import_after_events" | "history_import_after_checkpoint"
  | "proposal_decision_before_write" | "proposal_decision_after_boxes" | "proposal_decision_after_traces" | "proposal_decision_after_proposal"
  | "source_revocation_before_write" | "source_revocation_after_grant" | "source_revocation_after_audit"
  | "source_deletion_before_write" | "source_deletion_after_supersessions" | "source_deletion_after_injections" | "source_deletion_after_anchors" | "source_deletion_after_turns" | "source_deletion_after_events" | "source_deletion_after_sources" | "source_deletion_after_quarantine" | "source_deletion_after_checkpoint" | "source_deletion_after_audits";

export const sourceDeletionBootstrapCheckpointSchema = HistoricalBootstrapCheckpointSchema;
export const sourceDeletionAnchorSchema = AnchorSchema;
