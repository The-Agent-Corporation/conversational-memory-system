import { createHash } from "node:crypto";
import type { ProfileAuthority } from "../mcp/authority.js";
import { DisclosureLabeler } from "../mcp/disclosure-labels.js";
import { readDaemonStatusSnapshot } from "../bootstrap/status-command.js";
import type { Anchor, Box, MemoryTrace, Summary, TurnRange } from "../domain/types.js";
import type { MemoryStore } from "../storage/memory-store.js";
import { isRetrievableState } from "./retrievable-state.js";

export type MemoryReviewKind = "summary" | "anchor" | "box" | "trace";

export interface MemorySearchRequest {
  query: string;
  limit?: number;
}

export interface MemoryRecallRequest {
  task: string;
  tokenBudget: number;
}

export interface MemoryReviewRequest {
  kinds?: readonly MemoryReviewKind[];
  states?: readonly string[];
  limit: number;
  cursor?: string;
}

export interface MemoryReadItem {
  kind: MemoryReviewKind;
  id: string;
  subject: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  confidence: number;
  scopeIds: string[];
  provenance: Array<{ kind: string; id: string }>;
  sourceReferences: string[];
  assistive: true;
}

export interface MemoryReviewPage {
  items: MemoryReadItem[];
  count: number;
  nextCursor: string | null;
  disclosure: string;
}

interface AuthorizedMemory {
  summaries: Summary[];
  anchors: Anchor[];
  boxes: Box[];
  traces: MemoryTrace[];
  restrictedScopeIds: string[];
}

interface RankedCandidate extends MemoryReadItem {
  text: string;
  score: number;
  tokenCount: number;
}

const DISCLOSURE = "Assistive memory only; verify against current sources.";
const DEFAULT_REVIEW_STATES = new Set(["active", "revived", "approved", "proposed"]);
const ALL_KINDS: readonly MemoryReviewKind[] = ["anchor", "box", "summary", "trace"];

export class MemoryQueryService {
  readonly #labeler: DisclosureLabeler;

  constructor(
    private readonly store: MemoryStore,
    private readonly authority: ProfileAuthority
  ) {
    this.#labeler = new DisclosureLabeler(authority.scopeAliases);
  }

  async search(request: MemorySearchRequest): Promise<{
    candidates: RankedCandidate[];
    count: number;
    restrictedLabels: string[];
    disclosure: string;
  }> {
    const query = request.query.trim();
    if (!query) throw new Error("Search query is required");
    const limit = boundedLimit(request.limit ?? 20);
    const authorized = await this.loadAuthorizedMemory();
    const candidates = this.rank(query, authorized).slice(0, limit);
    return {
      candidates,
      count: candidates.length,
      restrictedLabels: this.#labeler.labelRestrictedScopes(authorized.restrictedScopeIds),
      disclosure: DISCLOSURE
    };
  }

  async recall(request: MemoryRecallRequest): Promise<{
    task: string;
    items: RankedCandidate[];
    count: number;
    budget: { requested: number; used: number; unit: "estimated_tokens"; estimatorVersion: "words-v1" };
    continuation: null;
    disclosure: string;
  }> {
    const task = request.task.trim();
    if (!task) throw new Error("Recall task is required");
    if (!Number.isInteger(request.tokenBudget) || request.tokenBudget <= 0) {
      throw new Error("Recall token budget must be a positive integer");
    }
    const authorized = await this.loadAuthorizedMemory();
    const items: RankedCandidate[] = [];
    let used = 0;
    for (const candidate of this.rank(task, authorized)) {
      if (used + candidate.tokenCount > request.tokenBudget) continue;
      items.push(candidate);
      used += candidate.tokenCount;
    }
    return {
      task,
      items,
      count: items.length,
      budget: {
        requested: request.tokenBudget,
        used,
        unit: "estimated_tokens",
        estimatorVersion: "words-v1"
      },
      continuation: null,
      disclosure: DISCLOSURE
    };
  }

  async review(request: MemoryReviewRequest): Promise<MemoryReviewPage> {
    const limit = boundedLimit(request.limit);
    const kinds = normalizeKinds(request.kinds);
    const states = normalizeStrings(request.states);
    const filterKey = JSON.stringify({ kinds, states });
    const after = request.cursor ? this.decodeCursor(request.cursor, filterKey) : null;
    const authorized = await this.loadAuthorizedMemory();
    const items = this.toReadItems(authorized)
      .filter((item) => kinds.includes(item.kind))
      .filter((item) => states.length > 0 ? states.includes(item.state) : DEFAULT_REVIEW_STATES.has(item.state))
      .sort(compareReviewItems);
    const start = after === null
      ? 0
      : items.findIndex((item) => cursorTuple(item) === after) + 1;
    if (after !== null && start === 0) throw new Error("Invalid review cursor");
    const pageItems = items.slice(start, start + limit);
    const hasMore = start + pageItems.length < items.length;
    return {
      items: pageItems,
      count: pageItems.length,
      nextCursor: hasMore && pageItems.length > 0
        ? this.encodeCursor(filterKey, cursorTuple(pageItems[pageItems.length - 1]))
        : null,
      disclosure: DISCLOSURE
    };
  }

  async status(now = new Date().toISOString()): Promise<{
    personId: string;
    sourceCount: number;
    memoryCount: number;
    synchronization: { online: boolean; state: "running" | "stopping" | "stale" | "stopped" };
    disclosure: string;
  }> {
    const [sources, authorized, daemon] = await Promise.all([
      this.store.listSources(this.authority.personId),
      this.loadAuthorizedMemory(),
      readDaemonStatusSnapshot(this.store, now, null, this.authority.personId)
    ]);
    const allowed = new Set(this.authority.allowedScopeIds);
    const sourceCount = sources.filter((source) => allowed.has(source.scopeId ?? "personal")).length;
    return {
      personId: this.authority.personId,
      sourceCount,
      memoryCount: this.toReadItems(authorized).length,
      synchronization: {
        online: daemon.state === "running" || daemon.state === "stopping",
        state: daemon.state
      },
      disclosure: DISCLOSURE
    };
  }

  private async loadAuthorizedMemory(): Promise<AuthorizedMemory> {
    const [allSummaries, allAnchors, allBoxes, allTraces] = await Promise.all([
      this.store.listSummaries(),
      this.store.listAnchors(),
      this.store.listBoxes(),
      this.store.listTraces()
    ]);
    const allowed = new Set(this.authority.allowedScopeIds);
    const ownedSummaries = allSummaries.filter((summary) => summary.personId === this.authority.personId);
    const summaries = ownedSummaries.filter((summary) =>
      isRetrievableState(summary.state) &&
      (summary.scopeIds ?? ["personal"]).every((scopeId) => allowed.has(scopeId))
    );
    const summaryIds = new Set(summaries.map((summary) => summary.id));
    const anchors = allAnchors.filter((anchor) =>
      anchor.personId === this.authority.personId && allowed.has(anchor.scopeId ?? "personal")
    );
    const boxes = allBoxes.filter((box) =>
      box.personId === this.authority.personId &&
      box.summaryIds.length > 0 &&
      box.summaryIds.every((summaryId) => summaryIds.has(summaryId))
    );
    const traces = allTraces.filter((trace) =>
      trace.personId === this.authority.personId &&
      trace.summaryIds.length > 0 &&
      trace.summaryIds.every((summaryId) => summaryIds.has(summaryId))
    );
    const restrictedScopeIds = ownedSummaries
      .flatMap((summary) => summary.scopeIds ?? ["personal"])
      .filter((scopeId) => !allowed.has(scopeId));
    return { summaries, anchors, boxes, traces, restrictedScopeIds };
  }

  private rank(query: string, authorized: AuthorizedMemory): RankedCandidate[] {
    const queryWords = significantWords(query);
    return this.toReadItems(authorized)
      .map((item) => {
        const text = item.subject;
        const score = scoreText(queryWords, text) * item.confidence;
        return { ...item, text, score, tokenCount: estimateTokenCount(text) };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
  }

  private toReadItems(memory: AuthorizedMemory): MemoryReadItem[] {
    const summariesById = new Map(memory.summaries.map((summary) => [summary.id, summary]));
    const dependencyScopes = (summaryIds: readonly string[]): string[] =>
      [...new Set(summaryIds.flatMap((id) => summariesById.get(id)?.scopeIds ?? []))].sort();
    return [
      ...memory.summaries.map((summary): MemoryReadItem => ({
        kind: "summary",
        id: summary.id,
        subject: summary.summaryText,
        state: summary.state,
        createdAt: summary.createdAt,
        updatedAt: summary.retrievedAt ?? summary.lastAccessedAt ?? summary.createdAt,
        confidence: summary.confidence,
        scopeIds: [...(summary.scopeIds ?? ["personal"])].sort(),
        provenance: [
          ...summary.sourceCanonicalEventIds?.map((id) => ({ kind: "canonical_event", id })) ?? [],
          ...summary.sourceSummaryIds.map((id) => ({ kind: "summary", id }))
        ],
        sourceReferences: turnRangeReferences(summary.sourceTurnRanges),
        assistive: true
      })),
      ...memory.anchors.map((anchor): MemoryReadItem => ({
        kind: "anchor",
        id: anchor.id,
        subject: anchor.content,
        state: "active",
        createdAt: anchor.createdAt,
        updatedAt: anchor.createdAt,
        confidence: anchor.trustLevel === "high" ? 1 : anchor.trustLevel === "medium" ? 0.7 : 0.4,
        scopeIds: [anchor.scopeId ?? "personal"],
        provenance: anchor.canonicalEventId ? [{ kind: "canonical_event", id: anchor.canonicalEventId }] : [],
        sourceReferences: [anchor.threadId, anchor.turnId],
        assistive: true
      })),
      ...memory.boxes.map((box): MemoryReadItem => ({
        kind: "box",
        id: box.id,
        subject: box.title,
        state: box.state,
        createdAt: box.createdAt,
        updatedAt: box.updatedAt,
        confidence: 0.8,
        scopeIds: dependencyScopes(box.summaryIds),
        provenance: box.summaryIds.map((id) => ({ kind: "summary", id })),
        sourceReferences: turnRangeReferences(box.turnRanges),
        assistive: true
      })),
      ...memory.traces.map((trace): MemoryReadItem => ({
        kind: "trace",
        id: trace.id,
        subject: trace.title,
        state: trace.state,
        createdAt: trace.createdAt,
        updatedAt: trace.updatedAt,
        confidence: trace.confidence,
        scopeIds: dependencyScopes(trace.summaryIds),
        provenance: trace.summaryIds.map((id) => ({ kind: "summary", id })),
        sourceReferences: turnRangeReferences(trace.turnRanges),
        assistive: true
      }))
    ];
  }

  private encodeCursor(filterKey: string, tuple: string): string {
    const payload = JSON.stringify({ authority: this.authority.fingerprint, filterKey, tuple });
    const signature = createHash("sha256").update(this.authority.fingerprint).update(payload).digest("hex");
    return Buffer.from(JSON.stringify({ payload, signature }), "utf8").toString("base64url");
  }

  private decodeCursor(cursor: string, filterKey: string): string {
    try {
      const envelope = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
        payload: string;
        signature: string;
      };
      const expected = createHash("sha256")
        .update(this.authority.fingerprint)
        .update(envelope.payload)
        .digest("hex");
      const payload = JSON.parse(envelope.payload) as {
        authority: string;
        filterKey: string;
        tuple: string;
      };
      if (
        envelope.signature !== expected ||
        payload.authority !== this.authority.fingerprint ||
        payload.filterKey !== filterKey ||
        typeof payload.tuple !== "string"
      ) throw new Error("mismatch");
      return payload.tuple;
    } catch {
      throw new Error("Invalid review cursor");
    }
  }
}

const boundedLimit = (value: number): number => {
  if (!Number.isInteger(value) || value <= 0) throw new Error("Limit must be a positive integer");
  return Math.min(value, 100);
};

const normalizeKinds = (kinds?: readonly MemoryReviewKind[]): MemoryReviewKind[] => {
  const normalized = [...new Set(kinds ?? ALL_KINDS)].sort();
  if (normalized.some((kind) => !ALL_KINDS.includes(kind))) throw new Error("Invalid review kind");
  return normalized;
};

const normalizeStrings = (values?: readonly string[]): string[] =>
  [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort();

const compareReviewItems = (left: MemoryReadItem, right: MemoryReadItem): number =>
  right.updatedAt.localeCompare(left.updatedAt) ||
  left.kind.localeCompare(right.kind) ||
  left.id.localeCompare(right.id);

const cursorTuple = (item: MemoryReadItem): string => JSON.stringify([item.updatedAt, item.kind, item.id]);

const significantWords = (value: string): Set<string> => new Set(
  value.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2)
);

const scoreText = (queryWords: Set<string>, text: string): number => {
  if (queryWords.size === 0) return 0;
  const memoryWords = significantWords(text);
  return [...queryWords].filter((word) => memoryWords.has(word)).length / queryWords.size;
};

const estimateTokenCount = (value: string): number =>
  Math.max(1, Math.ceil(value.split(/\s+/).filter(Boolean).length * 1.3));

const turnRangeReferences = (ranges: readonly TurnRange[]): string[] =>
  ranges.map((range) => `${range.threadId}:${range.startSequence}-${range.endSequence}`);
