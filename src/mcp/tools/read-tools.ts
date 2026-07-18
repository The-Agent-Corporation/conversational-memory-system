import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const IdentifierSchema = z.string().min(1).max(512);
const BoundedTextSchema = z.string().max(65_536);
const IsoDateTimeSchema = z.string().datetime();
const ScopeIdsSchema = z.array(IdentifierSchema).max(100);
const ProvenanceSchema = z.array(z.object({
  kind: z.string().min(1).max(64),
  id: IdentifierSchema
}).strict()).max(1_000);
const BudgetSchema = z.object({
  requested: z.number().int().min(1).max(8_000),
  used: z.number().int().min(0).max(8_000),
  unit: z.literal("estimated_tokens"),
  estimatorVersion: z.string().min(1).max(64)
}).strict();
const MemoryKindSchema = z.enum(["summary", "anchor", "box", "trace"]);
const MemoryStateSchema = z.enum([
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
const ProposalStateSchema = z.enum(["proposed", "approved", "rejected", "superseded"]);
const ProposalTypeSchema = z.enum(["box", "box_parent_child", "trace"]);

const MemoryReadItemSchema = z.object({
  kind: MemoryKindSchema,
  id: IdentifierSchema,
  subject: BoundedTextSchema,
  state: MemoryStateSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  confidence: z.number().min(0).max(1),
  scopeIds: ScopeIdsSchema,
  provenance: ProvenanceSchema,
  sourceReferences: z.array(IdentifierSchema).max(1_000),
  assistive: z.literal(true)
}).strict();

const RankedMemoryItemSchema = MemoryReadItemSchema.extend({
  text: BoundedTextSchema,
  score: z.number().finite().min(0),
  tokenCount: z.number().int().positive().max(8_000)
}).strict();

export const MemorySearchInputSchema = z.object({
  query: z.string().trim().min(1).max(8_000),
  limit: z.number().int().min(1).max(100).optional()
}).strict();

export const MemorySearchOutputSchema = z.object({
  candidates: z.array(RankedMemoryItemSchema).max(100),
  count: z.number().int().min(0).max(100),
  restrictedLabels: z.array(z.string().min(1).max(128)).max(32),
  disclosure: z.string().min(1).max(2_000)
}).strict();

export const MemoryRecallInputSchema = z.object({
  task: z.string().trim().min(1).max(8_000),
  tokenBudget: z.number().int().min(1).max(8_000)
}).strict();

export const MemoryRecallOutputSchema = z.object({
  task: z.string().min(1).max(8_000),
  items: z.array(RankedMemoryItemSchema).max(1_000),
  count: z.number().int().min(0).max(1_000),
  budget: BudgetSchema,
  continuation: z.null(),
  disclosure: z.string().min(1).max(2_000)
}).strict();

export const MemoryReviewInputSchema = z.object({
  kinds: z.array(MemoryKindSchema).max(4).optional(),
  states: z.array(MemoryStateSchema).max(9).optional(),
  limit: z.number().int().min(1).max(100),
  cursor: z.string().min(1).max(4_096).optional()
}).strict();

export const MemoryReviewOutputSchema = z.object({
  items: z.array(MemoryReadItemSchema).max(100),
  count: z.number().int().min(0).max(100),
  nextCursor: z.string().min(1).max(4_096).nullable(),
  disclosure: z.string().min(1).max(2_000)
}).strict();

export const MemoryExpandSubjectInputSchema = z.object({
  subject: z.string().trim().min(1).max(8_000),
  tokenBudget: z.number().int().min(1).max(8_000),
  cursor: z.string().min(1).max(4_096).optional()
}).strict();

export const MemoryExpandSubjectOutputSchema = z.object({
  subject: z.object({
    kind: z.enum(["summary", "box", "trace"]),
    id: IdentifierSchema,
    normalizedHash: z.string().regex(/^[a-f0-9]{64}$/),
    confidence: z.number().min(0).max(1),
    scopeIds: ScopeIdsSchema
  }).strict(),
  events: z.array(z.object({
    id: IdentifierSchema,
    content: BoundedTextSchema,
    role: z.enum(["user", "assistant", "system", "tool"]),
    eventKind: z.enum(["message", "tool_call"]),
    occurredAt: IsoDateTimeSchema,
    importedAt: IsoDateTimeSchema,
    source: z.object({
      id: IdentifierSchema,
      application: z.string().min(1).max(128),
      profileId: IdentifierSchema
    }).strict(),
    native: z.object({
      sessionId: IdentifierSchema,
      eventId: IdentifierSchema,
      sequence: z.number().int().nonnegative()
    }).strict(),
    provenance: z.enum(["direct_user_input", "assistant_output", "tool_output", "external_content", "system_event"]),
    trustLevel: z.enum(["low", "medium", "high"]),
    confidence: z.number().min(0).max(1),
    scopeIds: ScopeIdsSchema,
    estimatedTokens: z.number().int().positive().max(8_000)
  }).strict()).max(1_000),
  count: z.number().int().min(0).max(1_000),
  budget: BudgetSchema,
  continuation: z.string().min(1).max(4_096).nullable(),
  disclosure: z.string().min(1).max(2_000)
}).strict();

export const SourceStatusInputSchema = z.object({}).strict();

export const SourceStatusOutputSchema = z.object({
  personId: IdentifierSchema,
  sourceCount: z.number().int().nonnegative(),
  memoryCount: z.number().int().nonnegative(),
  synchronization: z.object({
    online: z.boolean(),
    state: z.enum(["running", "stopping", "stale", "stopped"])
  }).strict(),
  disclosure: z.string().min(1).max(2_000)
}).strict();

export const ProposalListInputSchema = z.object({
  state: ProposalStateSchema.optional(),
  proposalType: ProposalTypeSchema.optional(),
  limit: z.number().int().min(1).max(100).optional()
}).strict();

export const ProposalListOutputSchema = z.object({
  ok: z.literal(true),
  proposals: z.array(z.object({
    id: IdentifierSchema,
    proposalType: ProposalTypeSchema,
    state: ProposalStateSchema,
    title: BoundedTextSchema,
    rationale: BoundedTextSchema,
    confidence: z.number().min(0).max(1),
    createdAt: IsoDateTimeSchema,
    reviewedAt: IsoDateTimeSchema,
    sourceSummaryIds: z.array(IdentifierSchema).max(1_000),
    targetBoxIds: z.array(IdentifierSchema).max(1_000),
    targetTraceIds: z.array(IdentifierSchema).max(1_000)
  }).strict()).max(100),
  count: z.number().int().min(0).max(100),
  disclosure: z.string().min(1).max(2_000)
}).strict();

// Registration is implemented after the schema gate so tool routing remains a thin,
// separately verified protocol layer.
export const registerMemoryReadTools = (_server: McpServer): void => {};
