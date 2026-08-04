import { z } from "zod";

export const IsoDateTimeSchema = z.string().datetime();
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (isPlainObject(value)) {
    return Object.values(value).every(isJsonValue);
  }

  return false;
};

export const JsonValueSchema: z.ZodType<JsonValue> = z.custom<JsonValue>(isJsonValue, {
  message: "Expected JSON value"
});

export const JsonObjectSchema: z.ZodType<JsonObject> = z.custom<JsonObject>(
  (value) => isPlainObject(value) && Object.values(value).every(isJsonValue),
  { message: "Expected JSON object" }
);

export const RoleSchema = z.enum(["user", "assistant", "system", "tool"]);
export const ProvenanceSchema = z.enum([
  "direct_user_input",
  "assistant_output",
  "tool_output",
  "external_content",
  "system_event"
]);
export const TrustLevelSchema = z.enum(["low", "medium", "high"]);
export const MemoryStateSchema = z.enum([
  "active",
  "compacted",
  "stale",
  "revived",
  "proposed",
  "approved",
  "rejected",
  "superseded",
  "disputed"
]);

/**
 * Every memory state EXCEPT `superseded`. Derived from the schema rather than written out so a
 * newly added state is included by default -- the predicates this replaces were exclusions
 * (`state !== "superseded"`), and a hand-listed inclusion would silently start dropping rows.
 *
 * Shared so the contraction runner and the sleep reviewer cannot drift apart on what a live
 * derivation is.
 */
export const NON_SUPERSEDED_STATES = MemoryStateSchema.options.filter((state) => state !== "superseded");

export const TurnRangeSchema = z.object({
  threadId: z.string().min(1),
  startSequence: z.number().int().nonnegative(),
  endSequence: z.number().int().nonnegative()
}).refine((range) => range.endSequence >= range.startSequence, {
  message: "endSequence must be greater than or equal to startSequence"
});

export const EmbeddingSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  dimensions: z.number().int().positive(),
  vector: z.array(z.number().finite()),
  createdAt: IsoDateTimeSchema
}).refine((embedding) => embedding.vector.length === embedding.dimensions, {
  message: "vector length must match dimensions"
});

export const TurnSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  role: RoleSchema,
  content: z.string(),
  createdAt: IsoDateTimeSchema,
  provenance: ProvenanceSchema,
  trustLevel: TrustLevelSchema,
  metadata: JsonObjectSchema,
  contentHash: z.string().min(1)
});

export const SummarySchema = z.object({
  id: z.string().min(1),
  personId: z.string().min(1).optional(),
  scopeIds: z.array(z.string().min(1)).optional(),
  origin: z.enum(["host_session", "historical_bootstrap"]).optional(),
  summaryText: z.string().min(1),
  sourceTurnRanges: z.array(TurnRangeSchema),
  sourceCanonicalEventIds: z.array(z.string().min(1)).optional(),
  sourceSummaryIds: z.array(z.string().min(1)),
  boxIds: z.array(z.string().min(1)),
  embedding: EmbeddingSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  model: z.string().min(1),
  promptVersion: z.string().min(1),
  confidence: z.number().min(0).max(1),
  state: MemoryStateSchema,
  detailLevel: z.enum(["full", "medium", "brief", "stub"]),
  tokenCount: z.number().int().nonnegative(),
  lastAccessedAt: IsoDateTimeSchema.nullable(),
  version: z.number().int().positive(),
  strength: z.number().min(0).max(1),
  retrievalCount: z.number().int().nonnegative(),
  retrievedAt: IsoDateTimeSchema.nullable(),
  halfLifeHours: z.number().positive(),
  outcomeScore: z.number().min(-1).max(1).nullable()
});

export const BoxSchema = z.object({
  id: z.string().min(1),
  personId: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string(),
  parentBoxId: z.string().min(1).nullable(),
  childBoxIds: z.array(z.string().min(1)),
  summaryIds: z.array(z.string().min(1)),
  turnRanges: z.array(TurnRangeSchema),
  state: MemoryStateSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  caseId: z.string().min(1).nullable(),
  boxType: z.enum(["case", "topic", "general", "project", "person"]),
  summary: z.string(),
  lastActivityAt: IsoDateTimeSchema
});

export const AnchorSchema = z.object({
  id: z.string().min(1),
  personId: z.string().min(1).optional(),
  scopeId: z.string().min(1).optional(),
  canonicalEventId: z.string().min(1).optional(),
  turnId: z.string().min(1),
  threadId: z.string().min(1),
  boxId: z.string().min(1).nullable(),
  anchorType: z.enum(["decision", "deadline", "key_fact", "strategic_insight", "bookmark"]),
  content: z.string().min(1),
  embedding: EmbeddingSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  trustLevel: TrustLevelSchema,
  source: ProvenanceSchema
});

export const InjectionPacketSchema = z.object({
  id: z.string().min(1),
  personId: z.string().min(1).optional(),
  allowedScopeIds: z.array(z.string().min(1)).optional(),
  hostSessionId: z.string().min(1),
  currentTopicSummary: z.string().min(1),
  selectedMemory: z.string().min(1),
  sourceSummaryIds: z.array(z.string().min(1)),
  sourceTraceIds: z.array(z.string().min(1)),
  sourceTurnRanges: z.array(TurnRangeSchema),
  boxIds: z.array(z.string().min(1)),
  relevanceReason: z.string().min(1),
  confidence: z.number().min(0).max(1),
  disclosureText: z.string().min(1),
  createdAt: IsoDateTimeSchema
});

export const ProposalStateSchema = z.enum(["proposed", "approved", "rejected", "superseded"]);
export const ProposalTypeSchema = z.enum(["box", "box_parent_child", "trace"]);
export const TraceTypeSchema = z.enum([
  "case_issue",
  "task_thread",
  "strategy_thread",
  "fact_development",
  "follow_up"
]);

export const BoxProposalPayloadSchema = z.object({
  boxId: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  summary: z.string().min(1),
  boxType: z.enum(["case", "topic", "general", "project", "person"]),
  candidateParentBoxId: z.string().min(1).nullable(),
  keywords: z.array(z.string().min(1)),
  evidence: z.array(z.string().min(1)),
  sourceSummaryIds: z.array(z.string().min(1)).min(1),
  sourceTurnRanges: z.array(TurnRangeSchema).min(1)
});

export const ParentChildProposalPayloadSchema = z.object({
  parentBoxId: z.string().min(1),
  childBoxId: z.string().min(1),
  relationshipLabel: z.string().min(1),
  rationale: z.string().min(1),
  sourceSummaryIds: z.array(z.string().min(1)).min(1)
});

export const TraceProposalPayloadSchema = z.object({
  traceId: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  traceType: TraceTypeSchema,
  summaryIds: z.array(z.string().min(1)).min(2),
  boxIds: z.array(z.string().min(1)),
  turnRanges: z.array(TurnRangeSchema).min(1),
  continuityReason: z.string().min(1),
  boundaryReason: z.string().min(1),
  keywords: z.array(z.string().min(1)).min(1)
});

export const MemoryProposalSchema = z.object({
  id: z.string().min(1),
  personId: z.string().min(1).optional(),
  proposalType: ProposalTypeSchema,
  state: ProposalStateSchema,
  title: z.string().min(1),
  rationale: z.string().min(1),
  confidence: z.number().min(0).max(1),
  createdAt: IsoDateTimeSchema,
  reviewedAt: IsoDateTimeSchema,
  decidedAt: IsoDateTimeSchema.nullable().optional().default(null),
  decidedBy: z.string().min(1).nullable().optional().default(null),
  decisionNote: z.string().nullable().optional().default(null),
  sourceSummaryIds: z.array(z.string().min(1)).min(1),
  sourceTurnRanges: z.array(TurnRangeSchema).min(1),
  targetBoxIds: z.array(z.string().min(1)),
  targetTraceIds: z.array(z.string().min(1)),
  payload: JsonObjectSchema
}).superRefine((proposal, context) => {
  const result =
    proposal.proposalType === "box"
      ? BoxProposalPayloadSchema.safeParse(proposal.payload)
      : proposal.proposalType === "box_parent_child"
        ? ParentChildProposalPayloadSchema.safeParse(proposal.payload)
        : TraceProposalPayloadSchema.safeParse(proposal.payload);

  if (!result.success) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Invalid ${proposal.proposalType} proposal payload`
    });
  }
});

export const MemoryTraceSchema = z.object({
  id: z.string().min(1),
  personId: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string(),
  traceType: TraceTypeSchema,
  state: ProposalStateSchema,
  summaryIds: z.array(z.string().min(1)).min(2),
  boxIds: z.array(z.string().min(1)),
  turnRanges: z.array(TurnRangeSchema).min(1),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  lastActivityAt: IsoDateTimeSchema,
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1)
});

export type MemoryState = z.infer<typeof MemoryStateSchema>;
export type Turn = z.infer<typeof TurnSchema>;
export type Summary = z.infer<typeof SummarySchema>;
export type Box = z.infer<typeof BoxSchema>;
export type Anchor = z.infer<typeof AnchorSchema>;
export type InjectionPacket = z.infer<typeof InjectionPacketSchema>;
export type TurnRange = z.infer<typeof TurnRangeSchema>;
export type Embedding = z.infer<typeof EmbeddingSchema>;
export type MemoryProposal = z.infer<typeof MemoryProposalSchema>;
export type MemoryTrace = z.infer<typeof MemoryTraceSchema>;
export type BoxProposalPayload = z.infer<typeof BoxProposalPayloadSchema>;
export type ParentChildProposalPayload = z.infer<typeof ParentChildProposalPayloadSchema>;
export type TraceProposalPayload = z.infer<typeof TraceProposalPayloadSchema>;
export type ProposalType = z.infer<typeof ProposalTypeSchema>;
export type ProposalState = z.infer<typeof ProposalStateSchema>;
export type TraceType = z.infer<typeof TraceTypeSchema>;
