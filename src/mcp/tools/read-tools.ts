import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createResponseEnvelope } from "../response-envelope.js";
import type { ScopedProposalReviewer } from "../../proposals/scoped-proposal-reviewer.js";
import type { MemoryQueryService } from "../../retrieval/memory-query-service.js";
import type { SubjectExpansionService } from "../../retrieval/subject-expansion-service.js";
import { ExplainVerbSchema, type ExplainTrace } from "../../audit/explain-service.js";

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
  sources: z.array(z.object({
    grantId: IdentifierSchema,
    candidateId: IdentifierSchema,
    application: z.string().min(1).max(128),
    format: z.string().min(1).max(128),
    rowHighWaterMark: z.string().min(1).nullable(),
    lastSuccessAt: IsoDateTimeSchema.nullable(),
    lastError: z.string().max(500).nullable()
  }).strict()).max(1_000),
  pipeline: z.object({
    pendingContractionJobs: z.number().int().nonnegative(),
    failedContractionJobs: z.number().int().nonnegative(),
    missingVectors: z.number().int().nonnegative(),
    pendingProposals: z.number().int().nonnegative(),
    traceDiscoveryEnabled: z.boolean(),
    semanticPausedBySpendCap: z.boolean()
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

export const MemoryExplainInputSchema = z.object({
  itemId: IdentifierSchema
}).strict();

const ExplainDetailValueSchema = z.union([z.string().max(2_000), z.number(), z.boolean(), z.null()]);
const ExplainDetailSchema = z.record(z.string().min(1).max(128), ExplainDetailValueSchema);

export const MemoryExplainOutputSchema = z.object({
  itemId: IdentifierSchema,
  kind: z.enum(["source", "summary", "anchor", "box", "trace", "event"]),
  events: z.array(z.object({
    verb: ExplainVerbSchema,
    occurredAt: z.string().min(1).max(64),
    actor: z.string().min(1).max(256).optional(),
    detail: ExplainDetailSchema.optional()
  }).strict()).max(1_000),
  count: z.number().int().min(0).max(1_000),
  disclosure: z.string().min(1).max(2_000)
}).strict();

export const MEMORY_READ_TOOL_NAMES = [
  "memory_search",
  "memory_recall",
  "memory_review",
  "memory_expand_subject",
  "source_status",
  "proposal_list",
  "memory_explain"
] as const;

export const MEMORY_READ_TOOL_ANNOTATIONS: Readonly<ToolAnnotations> = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
});

/** Authority-bound explain lookup — same shape ExplainService (src/audit/explain-service.ts) exposes. */
export interface MemoryExplainReader {
  explain(itemId: string): Promise<ExplainTrace>;
}

export interface MemoryReadToolApplication {
  readonly queries: MemoryQueryService;
  readonly expansion: SubjectExpansionService;
  readonly proposals: ScopedProposalReviewer;
  readonly explain: MemoryExplainReader;
  readonly now?: () => string;
}

const DISCLOSURE = "Assistive memory only; verify against current sources.";

export const registerMemoryReadTools = (
  server: McpServer,
  application: MemoryReadToolApplication
): void => {
  server.registerTool(
    "memory_search",
    {
      title: "Search scoped memory",
      description: "Return ranked inspectable candidates from the startup-authorized memory profile.",
      inputSchema: MemorySearchInputSchema,
      outputSchema: MemorySearchOutputSchema,
      annotations: MEMORY_READ_TOOL_ANNOTATIONS
    },
    async (input) => safeRead(() => application.queries.search(input))
  );

  server.registerTool(
    "memory_recall",
    {
      title: "Recall scoped context",
      description: "Return a compact assistive context packet for a task and explicit token budget.",
      inputSchema: MemoryRecallInputSchema,
      outputSchema: MemoryRecallOutputSchema,
      annotations: MEMORY_READ_TOOL_ANNOTATIONS
    },
    async (input) => safeRead(() => application.queries.recall(input))
  );

  server.registerTool(
    "memory_review",
    {
      title: "Review durable memory",
      description: "Page through authorized summaries, anchors, boxes, and traces in deterministic order.",
      inputSchema: MemoryReviewInputSchema,
      outputSchema: MemoryReviewOutputSchema,
      annotations: MEMORY_READ_TOOL_ANNOTATIONS
    },
    async (input) => safeRead(() => application.queries.review(input))
  );

  server.registerTool(
    "memory_expand_subject",
    {
      title: "Expand a remembered subject",
      description: "Return authorized whole canonical events for one subject under an explicit budget.",
      inputSchema: MemoryExpandSubjectInputSchema,
      outputSchema: MemoryExpandSubjectOutputSchema,
      annotations: MEMORY_READ_TOOL_ANNOTATIONS
    },
    async (input) => safeRead(() => application.expansion.expand(input))
  );

  server.registerTool(
    "source_status",
    {
      title: "Inspect memory synchronization status",
      description: "Return profile-scoped source and memory counts, including an explicit offline daemon state.",
      inputSchema: SourceStatusInputSchema,
      outputSchema: SourceStatusOutputSchema,
      annotations: MEMORY_READ_TOOL_ANNOTATIONS
    },
    async () => safeRead(() => application.queries.status(application.now?.()))
  );

  server.registerTool(
    "proposal_list",
    {
      title: "List review proposals",
      description: "Return a bounded dependency-authorized proposal page without proposal payloads.",
      inputSchema: ProposalListInputSchema,
      outputSchema: ProposalListOutputSchema,
      annotations: MEMORY_READ_TOOL_ANNOTATIONS
    },
    async (input) => safeRead(async () => ({
      ...await application.proposals.listProposals(input),
      disclosure: DISCLOSURE
    }))
  );

  server.registerTool(
    "memory_explain",
    {
      title: "Explain why an item exists",
      description: "Return the authorized lifecycle trace (imported/summarized/synchronized/retrieved/expanded/approved/rejected/deleted) for one item id.",
      inputSchema: MemoryExplainInputSchema,
      outputSchema: MemoryExplainOutputSchema,
      annotations: MEMORY_READ_TOOL_ANNOTATIONS
    },
    async (input) => safeRead(async () => ({
      ...await application.explain.explain(input.itemId),
      disclosure: DISCLOSURE
    }))
  );
};

const safeRead = async <T extends object>(
  operation: () => Promise<T>
): Promise<CallToolResult> => {
  try {
    const structuredContent: Record<string, unknown> = Object.assign({}, await operation());
    const envelope = createResponseEnvelope(structuredContent);
    return {
      structuredContent: envelope.structuredContent,
      content: envelope.content.map((item) => ({ ...item }))
    };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: `Memory read failed: ${sanitizedErrorCode(error)}` }]
    };
  }
};

const sanitizedErrorCode = (error: unknown): string => {
  const message = error instanceof Error ? error.message : "";
  if (message === "Subject is unavailable") return "UNAVAILABLE";
  if (message.includes("cursor")) return "INVALID_CONTINUATION";
  if (message.includes("too small")) return "BUDGET_TOO_SMALL";
  if (message === "UNAUTHORIZED_OR_NOT_FOUND") return "UNAUTHORIZED_OR_NOT_FOUND";
  return "INVALID_REQUEST";
};
