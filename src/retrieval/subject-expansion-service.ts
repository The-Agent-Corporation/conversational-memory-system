import { createHash } from "node:crypto";
import type { CanonicalEvent } from "../domain/canonical.js";
import type { Box, MemoryTrace, Summary } from "../domain/types.js";
import type { ProfileAuthority } from "../mcp/authority.js";
import {
  TOKEN_ESTIMATOR_VERSION,
  type CanonicalOrderTuple,
  type ContinuationCursorCodec
} from "../mcp/continuation-cursor.js";
import type { MemoryStore } from "../storage/memory-store.js";

export interface SubjectExpansionRequest {
  subject: string;
  tokenBudget: number;
  cursor?: string;
}

export interface ExpandedCanonicalEvent {
  id: string;
  content: string;
  role: CanonicalEvent["role"];
  eventKind: NonNullable<CanonicalEvent["eventKind"]>;
  occurredAt: string;
  importedAt: string;
  source: { id: string; application: string; profileId: string };
  native: { sessionId: string; eventId: string; sequence: number };
  provenance: CanonicalEvent["provenance"];
  trustLevel: CanonicalEvent["trustLevel"];
  confidence: number;
  scopeIds: string[];
  estimatedTokens: number;
}

export interface SubjectExpansionResult {
  subject: {
    kind: "summary" | "box" | "trace";
    id: string;
    normalizedHash: string;
    confidence: number;
    scopeIds: string[];
  };
  events: ExpandedCanonicalEvent[];
  count: number;
  budget: {
    requested: number;
    used: number;
    unit: "estimated_tokens";
    estimatorVersion: typeof TOKEN_ESTIMATOR_VERSION;
  };
  continuation: string | null;
  disclosure: string;
}

interface ResolvedSubject {
  kind: "summary" | "box" | "trace";
  id: string;
  confidence: number;
  summaries: Summary[];
}

const UNAVAILABLE = "Subject is unavailable";
const DISCLOSURE = "Assistive memory only; verify verbatim events against their current native sources.";

export class SubjectExpansionService {
  constructor(
    private readonly store: MemoryStore,
    private readonly authority: ProfileAuthority,
    private readonly cursors: ContinuationCursorCodec
  ) {}

  async expand(request: SubjectExpansionRequest): Promise<SubjectExpansionResult> {
    const normalizedSubject = normalizeSubject(request.subject);
    if (!normalizedSubject) throw new Error(UNAVAILABLE);
    if (!Number.isInteger(request.tokenBudget) || request.tokenBudget <= 0) {
      throw new Error("Token budget must be a positive integer");
    }
    const subjectHash = hashSubject(normalizedSubject);
    const resolved = await this.resolveSubject(normalizedSubject);
    const allowed = new Set(this.authority.allowedScopeIds);
    const requestedIds = new Set(resolved.summaries.flatMap((summary) => summary.sourceCanonicalEventIds ?? []));
    const allEvents = (await this.store.listCanonicalEvents(this.authority.personId))
      .filter((event) => requestedIds.has(event.id))
      .sort(compareCanonicalEvents);

    if (
      requestedIds.size === 0 ||
      allEvents.length !== requestedIds.size ||
      allEvents.some((event) => event.personId !== this.authority.personId || !allowed.has(event.scopeId ?? "personal"))
    ) throw new Error(UNAVAILABLE);

    let start = 0;
    if (request.cursor) {
      const payload = this.cursors.verify(request.cursor, {
        authorityFingerprint: this.authority.fingerprint,
        subjectHash,
        tokenBudget: request.tokenBudget,
        estimatorVersion: TOKEN_ESTIMATOR_VERSION
      });
      start = allEvents.findIndex((event) => sameTuple(eventTuple(event), payload.next));
      if (start < 0) throw new Error("Invalid continuation cursor");
    }

    const events: ExpandedCanonicalEvent[] = [];
    let used = 0;
    for (const event of allEvents.slice(start)) {
      const rendered = toExpandedEvent(event);
      if (used + rendered.estimatedTokens > request.tokenBudget) break;
      events.push(rendered);
      used += rendered.estimatedTokens;
    }
    if (events.length === 0 && start < allEvents.length) {
      throw new Error("Token budget is too small for the next event");
    }

    const nextIndex = start + events.length;
    const continuation = nextIndex < allEvents.length
      ? this.cursors.create({
          authorityFingerprint: this.authority.fingerprint,
          subjectHash,
          next: eventTuple(allEvents[nextIndex]),
          tokenBudget: request.tokenBudget,
          estimatorVersion: TOKEN_ESTIMATOR_VERSION
        })
      : null;
    const scopeIds = [...new Set(resolved.summaries.flatMap((summary) => summary.scopeIds ?? ["personal"]))].sort();

    return {
      subject: { kind: resolved.kind, id: resolved.id, normalizedHash: subjectHash, confidence: resolved.confidence, scopeIds },
      events,
      count: events.length,
      budget: { requested: request.tokenBudget, used, unit: "estimated_tokens", estimatorVersion: TOKEN_ESTIMATOR_VERSION },
      continuation,
      disclosure: `${DISCLOSURE} Returned ${events.length} whole canonical event${events.length === 1 ? "" : "s"} using ${used}/${request.tokenBudget} estimated tokens.`
    };
  }

  private async resolveSubject(normalizedSubject: string): Promise<ResolvedSubject> {
    const [summaries, boxes, traces] = await Promise.all([
      this.store.listSummaries(),
      this.store.listBoxes(),
      this.store.listTraces()
    ]);
    const summariesById = new Map(summaries.map((summary) => [summary.id, summary]));
    const memo = new Map<string, Summary[] | null>();
    const resolveSummary = (id: string, visiting = new Set<string>()): Summary[] | null => {
      if (memo.has(id)) return memo.get(id) ?? null;
      if (visiting.has(id)) return null;
      const summary = summariesById.get(id);
      const allowed = new Set(this.authority.allowedScopeIds);
      if (
        !summary ||
        summary.personId !== this.authority.personId ||
        !(summary.scopeIds ?? ["personal"]).every((scopeId) => allowed.has(scopeId))
      ) {
        memo.set(id, null);
        return null;
      }
      const nextVisiting = new Set(visiting).add(id);
      const dependencies = summary.sourceSummaryIds.map((dependencyId) => resolveSummary(dependencyId, nextVisiting));
      if (dependencies.some((dependency) => dependency === null)) {
        memo.set(id, null);
        return null;
      }
      const resolved = dedupeSummaries([summary, ...dependencies.flatMap((dependency) => dependency ?? [])]);
      memo.set(id, resolved);
      return resolved;
    };
    const candidates: ResolvedSubject[] = [];
    for (const summary of summaries) {
      if (normalizeSubject(summary.summaryText) !== normalizedSubject) continue;
      const dependencies = resolveSummary(summary.id);
      if (dependencies) candidates.push({ kind: "summary", id: summary.id, confidence: summary.confidence, summaries: dependencies });
    }
    for (const box of boxes) {
      if (normalizeSubject(box.title) !== normalizedSubject) continue;
      const dependencies = resolveDerived(box, box.summaryIds, resolveSummary, this.authority.personId);
      if (dependencies) candidates.push({ kind: "box", id: box.id, confidence: 0.8, summaries: dependencies });
    }
    for (const trace of traces) {
      if (normalizeSubject(trace.title) !== normalizedSubject) continue;
      const dependencies = resolveDerived(trace, trace.summaryIds, resolveSummary, this.authority.personId);
      if (dependencies) candidates.push({ kind: "trace", id: trace.id, confidence: trace.confidence, summaries: dependencies });
    }
    if (candidates.length !== 1) throw new Error(UNAVAILABLE);
    return candidates[0];
  }
}

const resolveDerived = (
  item: Box | MemoryTrace,
  summaryIds: readonly string[],
  resolveSummary: (id: string) => Summary[] | null,
  personId: string
): Summary[] | null => {
  if (item.personId !== personId || summaryIds.length === 0) return null;
  const dependencies = summaryIds.map((id) => resolveSummary(id));
  return dependencies.some((dependency) => dependency === null)
    ? null
    : dedupeSummaries(dependencies.flatMap((dependency) => dependency ?? []));
};

const dedupeSummaries = (summaries: readonly Summary[]): Summary[] =>
  [...new Map(summaries.map((summary) => [summary.id, summary])).values()];

const normalizeSubject = (subject: string): string => subject.trim().toLowerCase().replace(/\s+/g, " ");
const hashSubject = (subject: string): string => createHash("sha256").update(subject).digest("hex");

const compareCanonicalEvents = (left: CanonicalEvent, right: CanonicalEvent): number =>
  left.occurredAt.localeCompare(right.occurredAt) ||
  left.nativeSequence - right.nativeSequence ||
  left.id.localeCompare(right.id);

const eventTuple = (event: CanonicalEvent): CanonicalOrderTuple => ({
  occurredAt: event.occurredAt,
  nativeSequence: event.nativeSequence,
  id: event.id
});

const sameTuple = (left: CanonicalOrderTuple, right: CanonicalOrderTuple): boolean =>
  left.occurredAt === right.occurredAt && left.nativeSequence === right.nativeSequence && left.id === right.id;

const toExpandedEvent = (event: CanonicalEvent): ExpandedCanonicalEvent => {
  const content = {
    id: event.id,
    content: event.content,
    role: event.role,
    eventKind: event.eventKind ?? "message",
    occurredAt: event.occurredAt,
    importedAt: event.importedAt,
    source: { id: event.sourceId, application: event.sourceApplication, profileId: event.sourceProfileId },
    native: { sessionId: event.nativeSessionId, eventId: event.nativeEventId, sequence: event.nativeSequence },
    provenance: event.provenance,
    trustLevel: event.trustLevel,
    confidence: event.trustLevel === "high" ? 1 : event.trustLevel === "medium" ? 0.7 : 0.4,
    scopeIds: [event.scopeId ?? "personal"]
  };
  return { ...content, estimatedTokens: estimateTokenCount(JSON.stringify(content)) };
};

const estimateTokenCount = (value: string): number =>
  Math.max(1, Math.ceil(value.split(/\s+/).filter(Boolean).length * 1.3));
