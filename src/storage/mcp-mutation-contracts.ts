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
  SummarySchema,
  type Box,
  type MemoryProposal,
  type MemoryTrace,
  type Summary
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

export const ExpectedBoxStateSchema = z.object({
  id: IdSchema,
  value: BoxSchema.nullable()
}).strict().superRefine((state, context) => {
  if (state.value !== null && state.value.id !== state.id) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Expected Box state ID mismatch", path: ["value", "id"] });
  }
});

export const ExpectedTraceStateSchema = z.object({
  id: IdSchema,
  value: MemoryTraceSchema.nullable()
}).strict().superRefine((state, context) => {
  if (state.value !== null && state.value.id !== state.id) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Expected Trace state ID mismatch", path: ["value", "id"] });
  }
});

export const ProposalDependencyClosureSchema = z.object({
  allowedScopeIds: IdListSchema,
  expectedSummaries: z.array(SummarySchema),
  expectedBoxes: z.array(ExpectedBoxStateSchema),
  expectedTraces: z.array(ExpectedTraceStateSchema)
}).strict();

export type ExpectedBoxState = z.infer<typeof ExpectedBoxStateSchema>;
export type ExpectedTraceState = z.infer<typeof ExpectedTraceStateSchema>;
export type ProposalDependencyClosure = z.infer<typeof ProposalDependencyClosureSchema>;

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

const sortedUnique = (ids: readonly string[]): string[] => [...new Set(ids)].sort();
const isSortedUnique = (ids: readonly string[]): boolean =>
  ids.length === new Set(ids).size && stableJson(ids) === stableJson([...ids].sort());

interface ProposalAuthorizationSnapshot extends ProposalDependencyClosure {
  personId: string;
  expectedProposal: MemoryProposal;
  nextBoxes: Box[];
  nextTraces: MemoryTrace[];
}

const proposalPayloadReferences = (proposal: MemoryProposal): {
  summaryIds: string[];
  boxIds: string[];
  traceIds: string[];
  requiredBoxIds: string[];
} => {
  if (proposal.proposalType === "box") {
    const payload = z.object({
      boxId: IdSchema,
      sourceSummaryIds: IdListSchema,
      candidateParentBoxId: IdSchema.nullable()
    }).passthrough().parse(proposal.payload);
    return {
      summaryIds: payload.sourceSummaryIds,
      boxIds: [payload.boxId, ...(payload.candidateParentBoxId ? [payload.candidateParentBoxId] : [])],
      traceIds: [],
      requiredBoxIds: payload.candidateParentBoxId ? [payload.candidateParentBoxId] : []
    };
  }
  if (proposal.proposalType === "box_parent_child") {
    const payload = z.object({
      parentBoxId: IdSchema,
      childBoxId: IdSchema,
      sourceSummaryIds: IdListSchema
    }).passthrough().parse(proposal.payload);
    return {
      summaryIds: payload.sourceSummaryIds,
      boxIds: [payload.parentBoxId, payload.childBoxId],
      traceIds: [],
      requiredBoxIds: [payload.parentBoxId, payload.childBoxId]
    };
  }
  const payload = z.object({
    traceId: IdSchema,
    summaryIds: IdListSchema,
    boxIds: IdListSchema
  }).passthrough().parse(proposal.payload);
  return {
    summaryIds: payload.summaryIds,
    boxIds: payload.boxIds,
    traceIds: [payload.traceId],
    requiredBoxIds: payload.boxIds
  };
};

/** Pure authorization and dependency-coverage validator shared by schema parsing and both stores. */
export const proposalDecisionAuthorizationIssues = (input: ProposalAuthorizationSnapshot): string[] => {
  const issues: string[] = [];
  if (!isSortedUnique(input.allowedScopeIds)) issues.push("Allowed scopes must be unique and sorted");
  const summaryIds = input.expectedSummaries.map((item) => item.id);
  const boxIds = input.expectedBoxes.map((item) => item.id);
  const traceIds = input.expectedTraces.map((item) => item.id);
  if (!isSortedUnique(summaryIds)) issues.push("Expected Summary IDs must be unique and sorted");
  if (!isSortedUnique(boxIds)) issues.push("Expected Box IDs must be unique and sorted");
  if (!isSortedUnique(traceIds)) issues.push("Expected Trace IDs must be unique and sorted");

  const allowedScopes = new Set(input.allowedScopeIds);
  const summaries = new Map(input.expectedSummaries.map((item) => [item.id, item]));
  const boxes = new Map(input.expectedBoxes.map((item) => [item.id, item.value]));
  const traces = new Map(input.expectedTraces.map((item) => [item.id, item.value]));
  for (const summary of input.expectedSummaries) {
    if (summary.personId !== input.personId || summary.state === "superseded" ||
        summary.scopeIds === undefined || summary.scopeIds.some((scopeId) => !allowedScopes.has(scopeId))) {
      issues.push(`Unauthorized Summary snapshot: ${summary.id}`);
    }
  }
  for (const state of input.expectedBoxes) {
    if (state.value !== null && state.value.personId !== input.personId) issues.push(`Unauthorized Box snapshot: ${state.id}`);
  }
  for (const state of input.expectedTraces) {
    if (state.value !== null && state.value.personId !== input.personId) issues.push(`Unauthorized Trace snapshot: ${state.id}`);
  }

  const payload = proposalPayloadReferences(input.expectedProposal);
  const neededSummaries = new Set([...input.expectedProposal.sourceSummaryIds, ...payload.summaryIds]);
  const neededBoxes = new Set([...input.expectedProposal.targetBoxIds, ...payload.boxIds]);
  const neededTraces = new Set([...input.expectedProposal.targetTraceIds, ...payload.traceIds]);
  const requiredBoxes = new Set(payload.requiredBoxIds);

  for (const box of input.nextBoxes) {
    neededBoxes.add(box.id);
    box.summaryIds.forEach((id) => neededSummaries.add(id));
    if (box.parentBoxId) {
      neededBoxes.add(box.parentBoxId);
      requiredBoxes.add(box.parentBoxId);
    }
    box.childBoxIds.forEach((id) => {
      neededBoxes.add(id);
      requiredBoxes.add(id);
    });
  }
  for (const trace of input.nextTraces) {
    neededTraces.add(trace.id);
    trace.summaryIds.forEach((id) => neededSummaries.add(id));
    trace.boxIds.forEach((id) => {
      neededBoxes.add(id);
      requiredBoxes.add(id);
    });
  }

  const visitedBoxes = new Set<string>();
  const visitBox = (id: string): void => {
    if (visitedBoxes.has(id)) {
      if (requiredBoxes.has(id) && (boxes.get(id) ?? null) === null) {
        issues.push(`Required Box is absent: ${id}`);
      }
      return;
    }
    visitedBoxes.add(id);
    if (!boxes.has(id)) return;
    const box = boxes.get(id) ?? null;
    if (box === null) {
      if (requiredBoxes.has(id)) issues.push(`Required Box is absent: ${id}`);
      return;
    }
    box.summaryIds.forEach((summaryId) => neededSummaries.add(summaryId));
    if (box.parentBoxId) {
      neededBoxes.add(box.parentBoxId);
      requiredBoxes.add(box.parentBoxId);
      visitBox(box.parentBoxId);
    }
    box.childBoxIds.forEach((childId) => {
      neededBoxes.add(childId);
      requiredBoxes.add(childId);
      visitBox(childId);
    });
  };
  for (const id of [...neededBoxes]) visitBox(id);

  for (const id of [...neededTraces]) {
    if (!traces.has(id)) continue;
    const trace = traces.get(id) ?? null;
    if (trace === null) continue;
    trace.summaryIds.forEach((summaryId) => neededSummaries.add(summaryId));
    trace.boxIds.forEach((boxId) => {
      neededBoxes.add(boxId);
      requiredBoxes.add(boxId);
      visitBox(boxId);
    });
  }

  const visitedSummaries = new Set<string>();
  const visitSummary = (id: string): void => {
    if (visitedSummaries.has(id)) return;
    visitedSummaries.add(id);
    const summary = summaries.get(id);
    if (!summary) return;
    summary.sourceSummaryIds.forEach((sourceId) => {
      neededSummaries.add(sourceId);
      visitSummary(sourceId);
    });
  };
  for (const id of [...neededSummaries]) visitSummary(id);

  if (stableJson(summaryIds) !== stableJson(sortedUnique([...neededSummaries]))) issues.push("Summary dependency closure is incomplete or contains extras");
  if (stableJson(boxIds) !== stableJson(sortedUnique([...neededBoxes]))) issues.push("Box dependency closure is incomplete or contains extras");
  if (stableJson(traceIds) !== stableJson(sortedUnique([...neededTraces]))) issues.push("Trace dependency closure is incomplete or contains extras");
  return issues;
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
  ...ProposalDependencyClosureSchema.shape,
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
  for (const issue of proposalDecisionAuthorizationIssues(input)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: issue });
  }
  if (input.effectsFingerprint !== mutationEffectsFingerprint(input.effects)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Proposal effects fingerprint mismatch" });
  assertIdsEqual([input.nextProposal.id], input.effects.proposalIds, context, ["effects", "proposalIds"]);
  assertIdsEqual(input.nextBoxes.map((item) => item.id), input.effects.boxIds, context, ["effects", "boxIds"]);
  assertIdsEqual(input.nextTraces.map((item) => item.id), input.effects.traceIds, context, ["effects", "traceIds"]);
  if (input.receipt.operation !== input.operation || input.receipt.personId !== input.personId || input.receipt.targetId !== input.expectedProposal.id) context.addIssue({ code: z.ZodIssueCode.custom, message: "Proposal receipt binding mismatch", path: ["receipt"] });
});

export const proposalDecisionStateMatches = (
  input: CommitProposalDecisionInput,
  current: {
    proposal: MemoryProposal | null;
    summaries: Summary[];
    boxes: ExpectedBoxState[];
    traces: ExpectedTraceState[];
  }
): boolean => {
  if (stableJson(current.proposal) !== stableJson(input.expectedProposal) ||
      stableJson(current.summaries) !== stableJson(input.expectedSummaries) ||
      stableJson(current.boxes) !== stableJson(input.expectedBoxes) ||
      stableJson(current.traces) !== stableJson(input.expectedTraces)) return false;
  if (current.proposal === null) return false;
  return proposalDecisionAuthorizationIssues({
    personId: input.personId,
    allowedScopeIds: input.allowedScopeIds,
    expectedProposal: current.proposal,
    expectedSummaries: current.summaries,
    expectedBoxes: current.boxes,
    expectedTraces: current.traces,
    nextBoxes: input.nextBoxes,
    nextTraces: input.nextTraces
  }).length === 0;
};

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

// Superseded-summary prune (Plan 11-11, GAP-11-A closure): the only sanctioned removal path for
// pure derivations (REQ-053/REQ-054). Unlike source_deletion, this operation carries no
// caller-computed `effects` payload — eligibility (not_found / not_superseded / person_mismatch /
// any of the four reference kinds) is recomputed authoritatively inside the store's transaction,
// never trusted from the caller. See `commitSupersededSummaryPrune` in memory-store.ts.
export const CommitSupersededSummaryPruneInputSchema = z.object({
  operation: z.literal("superseded_summary_prune"),
  personId: IdSchema,
  summaryIds: IdListSchema.min(1).max(1000),
  requestedAt: IsoDateTimeSchema
}).strict();

export const SupersededSummaryPruneSkipReasonSchema = z.enum([
  "not_found",
  "not_superseded",
  "person_mismatch",
  "referenced_by_box",
  "referenced_by_trace",
  "referenced_by_proposal",
  "referenced_by_summary"
]);

export const SupersededSummaryPruneReceiptSchema = z.object({
  operation: z.literal("superseded_summary_prune"),
  personId: IdSchema,
  prunedSummaryIds: IdListSchema,
  deletedVectorRows: z.number().int().nonnegative(),
  deletedInjectionIds: IdListSchema,
  freedPayloadBytes: z.number().int().nonnegative(),
  skipped: z.array(z.object({
    summaryId: IdSchema,
    reason: SupersededSummaryPruneSkipReasonSchema
  })),
  committedAt: IsoDateTimeSchema
}).strict();

// Unhygienic-anchor prune (Plan 11-16, GAP-11-D closure): the only sanctioned removal path for
// anchors the shipped hygiene classifier (`src/topic/derivation-hygiene.ts`) would never have
// created. Unlike source_deletion, this operation carries no caller-computed `effects` payload --
// eligibility (not_found / person_unattributed / person_mismatch / retained_conversational) is
// recomputed authoritatively inside the store's transaction from the anchor's own content plus its
// resolved canonical event's role/eventKind, never trusted from the caller. See
// `commitUnhygienicAnchorPrune` in memory-store.ts.
export const CommitUnhygienicAnchorPruneInputSchema = z.object({
  operation: z.literal("unhygienic_anchor_prune"),
  personId: IdSchema,
  anchorIds: IdListSchema.min(1).max(1000),
  requestedAt: IsoDateTimeSchema
}).strict();

export const UnhygienicAnchorPruneSkipReasonSchema = z.enum([
  "not_found",
  "person_mismatch",
  "person_unattributed",
  "retained_conversational"
]);

export const UnhygienicAnchorPruneReceiptSchema = z.object({
  operation: z.literal("unhygienic_anchor_prune"),
  personId: IdSchema,
  prunedAnchorIds: IdListSchema,
  prunedByClass: z.object({
    tool_activity: z.number().int().nonnegative(),
    synthetic_injected: z.number().int().nonnegative()
  }).strict(),
  freedPayloadBytes: z.number().int().nonnegative(),
  skipped: z.array(z.object({
    anchorId: IdSchema,
    reason: UnhygienicAnchorPruneSkipReasonSchema
  })),
  ruleVersion: z.string().min(1),
  committedAt: IsoDateTimeSchema
}).strict();

export type CommitHistoryImportInput = z.infer<typeof CommitHistoryImportInputSchema>;
export type CommitProposalDecisionInput = z.infer<typeof CommitProposalDecisionInputSchema>;
export type CommitSourceRevocationInput = z.infer<typeof CommitSourceRevocationInputSchema>;
export type CommitSourceDeletionInput = z.infer<typeof CommitSourceDeletionInputSchema>;
export type SourceDeletionEffects = z.infer<typeof SourceDeletionEffectsSchema>;
export type CommitSupersededSummaryPruneInput = z.infer<typeof CommitSupersededSummaryPruneInputSchema>;
export type SupersededSummaryPruneSkipReason = z.infer<typeof SupersededSummaryPruneSkipReasonSchema>;
export type SupersededSummaryPruneReceipt = z.infer<typeof SupersededSummaryPruneReceiptSchema>;
export type CommitUnhygienicAnchorPruneInput = z.infer<typeof CommitUnhygienicAnchorPruneInputSchema>;
export type UnhygienicAnchorPruneSkipReason = z.infer<typeof UnhygienicAnchorPruneSkipReasonSchema>;
export type UnhygienicAnchorPruneReceipt = z.infer<typeof UnhygienicAnchorPruneReceiptSchema>;

export type McpMutationFaultBoundary =
  | "history_import_before_write" | "history_import_after_sources" | "history_import_after_events" | "history_import_after_checkpoint"
  | "proposal_decision_before_write" | "proposal_decision_after_boxes" | "proposal_decision_after_traces" | "proposal_decision_after_proposal"
  | "source_revocation_before_write" | "source_revocation_after_grant" | "source_revocation_after_audit"
  | "source_deletion_before_write" | "source_deletion_after_supersessions" | "source_deletion_after_injections" | "source_deletion_after_anchors" | "source_deletion_after_turns" | "source_deletion_after_events" | "source_deletion_after_sources" | "source_deletion_after_quarantine" | "source_deletion_after_checkpoint" | "source_deletion_after_audits"
  | "superseded_prune_before_write" | "superseded_prune_after_vectors" | "superseded_prune_after_injections"
  | "anchor_hygiene_prune_before_write" | "anchor_hygiene_prune_after_delete";

export const sourceDeletionBootstrapCheckpointSchema = HistoricalBootstrapCheckpointSchema;
export const sourceDeletionAnchorSchema = AnchorSchema;
