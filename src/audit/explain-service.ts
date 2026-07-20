import { z } from "zod";
import type { ProfileAuthority } from "../mcp/authority.js";
import { SourceLifecycleService } from "../service/source-lifecycle-service.js";
import type { JsonObject } from "../domain/types.js";
import type { Anchor, Box, MemoryTrace, Summary } from "../domain/types.js";
import type { MemoryStore } from "../storage/memory-store.js";

/**
 * REQ-039 "why" surface (D-01/D-03): reconstructs, for a single already-persisted item, the
 * applicable lifecycle verbs from EXISTING provenance/audit rows. This module never
 * re-instruments the pipeline; it only reads rows other services already write:
 *  - source_lifecycle_audit (approve/delete) -> imported / deleted
 *  - proposal review state (approve/reject) -> approved / rejected
 *  - summary provenance -> summarized
 *  - presence + scope authorization -> retrieved / expanded (structural capability facts)
 *  - sync_outbox targetId -> synchronized
 *
 * Authorization mirrors MemoryQueryService/ScopedProposalReviewer exactly: an id outside the
 * caller's personId/allowedScopeIds throws the SAME error a nonexistent id throws
 * (UNAUTHORIZED_OR_NOT_FOUND) so explain is never a scope-existence oracle (ADR 0046).
 */

const UNAUTHORIZED_OR_NOT_FOUND = "UNAUTHORIZED_OR_NOT_FOUND";

const IdentifierSchema = z.string().min(1).max(512);
const DetailValueSchema = z.union([z.string().max(2_000), z.number(), z.boolean(), z.null()]);
const DetailSchema = z.record(z.string().min(1).max(128), DetailValueSchema);

export const EXPLAIN_VERBS = [
  "imported",
  "summarized",
  "synchronized",
  "retrieved",
  "expanded",
  "approved",
  "rejected",
  "deleted"
] as const;

export const ExplainVerbSchema = z.enum(EXPLAIN_VERBS);
export type ExplainVerb = z.infer<typeof ExplainVerbSchema>;

export const ExplainEventSchema = z.object({
  verb: ExplainVerbSchema,
  occurredAt: z.string().min(1).max(64),
  actor: z.string().min(1).max(256).optional(),
  detail: DetailSchema.optional()
}).strict();
export type ExplainEvent = z.infer<typeof ExplainEventSchema>;

export const ExplainSubjectKindSchema = z.enum(["source", "summary", "anchor", "box", "trace"]);
export type ExplainSubjectKind = z.infer<typeof ExplainSubjectKindSchema>;

export const ExplainTraceSchema = z.object({
  itemId: IdentifierSchema,
  kind: ExplainSubjectKindSchema,
  events: z.array(ExplainEventSchema).max(1_000),
  count: z.number().int().min(0).max(1_000)
}).strict();
export type ExplainTrace = z.infer<typeof ExplainTraceSchema>;

export interface ExplainOptions {
  /** Owner-only CLI override: bypass scope filtering (never available to the MCP tool). */
  readonly allScopes?: boolean;
}

interface ResolvedMemoryItem {
  kind: "summary" | "anchor" | "box" | "trace";
  id: string;
  scopeIds: string[];
  updatedAt: string;
  summary?: Summary;
}

/** Metadata-only sanitization shared with the audit-log export (ADR 0044: never copy content). */
export const sanitizeAuditDetail = (details: JsonObject): Record<string, string | number | boolean | null> => {
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === "string") result[key] = value.slice(0, 2_000);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) result[key] = value;
    else result[key] = JSON.stringify(value).slice(0, 2_000);
  }
  return result;
};

export async function explain(
  store: MemoryStore,
  itemId: string,
  authority: ProfileAuthority,
  options: ExplainOptions = {}
): Promise<ExplainTrace> {
  const parsedItemId = IdentifierSchema.parse(itemId);
  const allowed = new Set(authority.allowedScopeIds);
  const scopeAuthorized = (scopeIds: readonly string[]): boolean =>
    options.allScopes === true || scopeIds.every((scopeId) => allowed.has(scopeId));

  const memoryItem = await resolveMemoryItem(store, parsedItemId, authority.personId);
  if (memoryItem) {
    if (!scopeAuthorized(memoryItem.scopeIds)) throw new Error(UNAUTHORIZED_OR_NOT_FOUND);
    const events = await explainMemoryItem(store, memoryItem, authority.personId);
    return ExplainTraceSchema.parse({ itemId: parsedItemId, kind: memoryItem.kind, events, count: events.length });
  }

  const lifecycleService = new SourceLifecycleService(store);
  const grant = await store.getSourceGrant(lifecycleService.grantId(authority.personId, parsedItemId));
  if (grant && grant.personId === authority.personId) {
    if (!scopeAuthorized([grant.scopeId])) throw new Error(UNAUTHORIZED_OR_NOT_FOUND);
    const events = await explainSourceLifecycle(store, authority.personId, grant.id);
    return ExplainTraceSchema.parse({ itemId: parsedItemId, kind: "source", events, count: events.length });
  }

  throw new Error(UNAUTHORIZED_OR_NOT_FOUND);
}

const dependencyScopes = (summaryIds: readonly string[], summaries: readonly Summary[]): string[] => {
  const byId = new Map(summaries.map((item) => [item.id, item]));
  return [...new Set(summaryIds.flatMap((id) => byId.get(id)?.scopeIds ?? []))].sort();
};

async function resolveMemoryItem(
  store: MemoryStore,
  itemId: string,
  personId: string
): Promise<ResolvedMemoryItem | null> {
  const [summaries, anchors, boxes, traces] = await Promise.all([
    store.listSummaries(),
    store.listAnchors(),
    store.listBoxes(),
    store.listTraces()
  ]);

  const summary = summaries.find((item: Summary) => item.id === itemId && item.personId === personId);
  if (summary) {
    return {
      kind: "summary",
      id: summary.id,
      scopeIds: [...(summary.scopeIds ?? ["personal"])],
      updatedAt: summary.retrievedAt ?? summary.lastAccessedAt ?? summary.createdAt,
      summary
    };
  }

  const anchor = anchors.find((item: Anchor) => item.id === itemId && item.personId === personId);
  if (anchor) {
    return {
      kind: "anchor",
      id: anchor.id,
      scopeIds: [anchor.scopeId ?? "personal"],
      updatedAt: anchor.createdAt
    };
  }

  const box = boxes.find((item: Box) => item.id === itemId && item.personId === personId);
  if (box) {
    return {
      kind: "box",
      id: box.id,
      scopeIds: dependencyScopes(box.summaryIds, summaries),
      updatedAt: box.updatedAt
    };
  }

  const trace = traces.find((item: MemoryTrace) => item.id === itemId && item.personId === personId);
  if (trace) {
    return {
      kind: "trace",
      id: trace.id,
      scopeIds: dependencyScopes(trace.summaryIds, summaries),
      updatedAt: trace.updatedAt
    };
  }

  return null;
}

async function explainMemoryItem(
  store: MemoryStore,
  item: ResolvedMemoryItem,
  personId: string
): Promise<ExplainEvent[]> {
  const events: ExplainEvent[] = [];

  if (item.kind === "summary" && item.summary) {
    events.push({
      verb: "summarized",
      occurredAt: item.summary.createdAt,
      detail: {
        sourceCanonicalEventCount: (item.summary.sourceCanonicalEventIds ?? []).length,
        sourceSummaryCount: item.summary.sourceSummaryIds.length
      }
    });
  }

  events.push({
    verb: "retrieved",
    occurredAt: item.updatedAt,
    detail: { scopeCount: item.scopeIds.length }
  });

  if (item.kind === "summary" || item.kind === "box" || item.kind === "trace") {
    events.push({
      verb: "expanded",
      occurredAt: item.updatedAt,
      detail: { kind: item.kind }
    });
  }

  const proposals = await store.listProposals();
  for (const proposal of proposals) {
    const targetsThisItem =
      proposal.targetBoxIds.includes(item.id) ||
      proposal.targetTraceIds.includes(item.id) ||
      proposal.sourceSummaryIds.includes(item.id);
    if (!targetsThisItem) continue;
    if (proposal.state === "approved" || proposal.state === "rejected") {
      events.push({
        verb: proposal.state,
        occurredAt: proposal.reviewedAt,
        ...(proposal.decidedBy ? { actor: proposal.decidedBy } : {}),
        detail: { proposalType: proposal.proposalType }
      });
    }
  }

  const outboxOps = (await store.listSyncOutboxOperations(personId))
    .filter((operation) => operation.targetId === item.id);
  for (const operation of outboxOps) {
    events.push({
      verb: "synchronized",
      occurredAt: operation.createdAt,
      detail: { operationKind: operation.operationKind, status: operation.status }
    });
  }

  return sortEvents(events);
}

async function explainSourceLifecycle(
  store: MemoryStore,
  personId: string,
  grantId: string
): Promise<ExplainEvent[]> {
  const auditEvents = (await store.listSourceLifecycleAuditEvents(personId))
    .filter((event) => event.grantId === grantId);
  const events: ExplainEvent[] = [];
  for (const auditEvent of auditEvents) {
    if (auditEvent.action === "approved") {
      events.push({
        verb: "imported",
        occurredAt: auditEvent.occurredAt,
        actor: auditEvent.actor,
        detail: sanitizeAuditDetail(auditEvent.details)
      });
    } else if (auditEvent.action === "deletion_completed") {
      events.push({
        verb: "deleted",
        occurredAt: auditEvent.occurredAt,
        actor: auditEvent.actor,
        detail: sanitizeAuditDetail(auditEvent.details)
      });
    }
  }
  return sortEvents(events);
}

const sortEvents = (events: ExplainEvent[]): ExplainEvent[] =>
  events.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.verb.localeCompare(right.verb));

/**
 * Authority-bound wrapper mirroring MemoryQueryService/ScopedProposalReviewer's constructor
 * shape, so the MCP `memory_explain` tool (read-tools.ts) captures ProfileAuthority at
 * registration exactly like every other read tool — never bypassing it.
 */
export class ExplainService {
  constructor(
    private readonly store: MemoryStore,
    private readonly authority: ProfileAuthority
  ) {}

  async explain(itemId: string): Promise<ExplainTrace> {
    return explain(this.store, itemId, this.authority);
  }
}
