import { createHash } from "node:crypto";
import type { CanonicalEvent } from "../domain/canonical.js";
import type { Anchor, Summary, Turn } from "../domain/types.js";
import { DerivationInvalidator } from "../service/derivation-invalidator.js";
import type { DerivationSupersession } from "./types.js";
import type { MemoryStore } from "../storage/memory-store.js";
import { DeterministicSummarizer, type Summarizer } from "../summarization/summarizer.js";
import { TopicMonitor, type CompletedTopicSpan, type RollingTopicState } from "../topic/topic-monitor.js";
import {
  WriteAuthoritySchema,
  type CanonicalOrderKey,
  type ContractionCheckpoint,
  type ContractionJob,
  type WriteAuthority
} from "./types.js";

const PROCESSOR_VERSION = "continuous-contraction/v1";
export const DEFAULT_CONTRACTION_LIMITS = Object.freeze({ maxEvents: 250, maxMonotonicMs: 2_000 });

/**
 * Optional per-slice fast-path inputs for callers that drain many slices back-to-back over an
 * unchanging canonical timeline (the historical bootstrap). Omit both fields for the default
 * fresh-read behavior used by the daemon.
 */
export interface DrainSliceContext {
  /** Preloaded canonical events, reused across slices instead of reloading them every call. */
  preloadedEvents?: CanonicalEvent[];
  /** Skip the per-slice scope re-assertion when the caller has already asserted it once for this pass. */
  scopesAlreadyAsserted?: boolean;
  /**
   * `event id -> position in preloadedEvents`, built once by the caller. Turns the per-slice
   * summary-invalidation scan from O(summaries * events) findIndex walks into O(1) lookups; this
   * is what makes a large bootstrap (tens of thousands of accumulated summaries) tractable.
   */
  eventIndexById?: ReadonlyMap<string, number>;
}

export interface ContractionClock {
  now(): string;
  monotonicNow(): number;
}

export interface ContractionRunnerOptions {
  clock?: ContractionClock;
  summarizer?: Summarizer;
  afterEvent?: (event: CanonicalEvent) => void | Promise<void>;
  authority?: WriteAuthority;
  beforeCommit?: () => void | Promise<void>;
  faults?: { reach(boundary: string): void };
}

export interface ContractionSliceResult {
  processedEvents: number;
  processedEventIds: string[];
  rewindOrderKey: CanonicalOrderKey | null;
  yielded: boolean;
  complete: boolean;
  checkpoint: ContractionCheckpoint;
  immediate: { summaries: number; anchors: number };
}

export class ContractionRunner {
  private readonly clock: ContractionClock;
  private readonly summarizer: Summarizer;

  constructor(private readonly store: MemoryStore, private readonly options: ContractionRunnerOptions = {}) {
    this.clock = options.clock ?? {
      now: () => new Date().toISOString(),
      monotonicNow: () => performance.now()
    };
    this.summarizer = options.summarizer ?? new DeterministicSummarizer();
  }

  async drainSlice(
    personId: string,
    jobId: string,
    limits: Partial<typeof DEFAULT_CONTRACTION_LIMITS> = {},
    context: DrainSliceContext = {}
  ): Promise<ContractionSliceResult> {
    const parsedAuthority = WriteAuthoritySchema.safeParse(this.options.authority);
    if (!parsedAuthority.success) throw new Error("Contraction write authority is required");
    const authority = parsedAuthority.data;
    if (authority.kind === "foreground" &&
        (authority.personId !== personId || authority.operation !== "historical-bootstrap")) {
      throw new Error("Foreground contraction requires exact person historical-bootstrap authority");
    }
    if (!(await this.store.getPerson(personId))) throw new Error(`Unknown contraction person ${personId}`);
    const job = await this.store.getContractionJob(jobId);
    if (!job || job.personId !== personId) throw new Error("Contraction job person ownership mismatch");

    // Canonical events are immutable for the duration of a contraction pass, so a caller draining
    // many slices in a tight loop (the historical bootstrap: ~1 slice per `maxEvents` events) can
    // load them ONCE and inject them here. Reloading + re-scope-asserting all events on every slice
    // was O(slices * events) = O(n^2), which made a 292k-event bootstrap take hours. The daemon,
    // which drains at most a slice per scheduled tick, passes nothing and keeps the fresh-read path.
    const allEvents = context.preloadedEvents ?? await this.store.listCanonicalEvents(personId);
    if (!context.scopesAlreadyAsserted) await this.assertEventScopes(personId, allEvents);
    const eventIndexById = context.eventIndexById ?? buildEventIndex(allEvents);
    const checkpointId = `contraction_checkpoint_${jobId}`;
    const previous = await this.store.getContractionCheckpoint(checkpointId);
    if (previous && (previous.personId !== personId || previous.jobId !== jobId)) {
      throw new Error("Contraction checkpoint person ownership mismatch");
    }

    const checkpointCanResume = previous !== null &&
      previous.generation === job.generation &&
      (previous.processedThroughOrderKey === null ||
        compareKeys(job.earliestAffected, previous.processedThroughOrderKey) >= 0);

    if (checkpointCanResume && previous.immediateStage === "complete" && job.state === "complete") {
      return {
        processedEvents: 0,
        processedEventIds: [],
        rewindOrderKey: null,
        yielded: false,
        complete: true,
        checkpoint: previous,
        immediate: { summaries: 0, anchors: 0 }
      };
    }

    const startIndex = checkpointCanResume
      ? resumeIndex(allEvents, previous, eventIndexById)
      : await this.affectedStartIndex(personId, allEvents, job.earliestAffected, eventIndexById);
    const rewindOrderKey = checkpointCanResume ? null : orderKey(allEvents[startIndex] ?? null);
    const monitor = new TopicMonitor();
    if (checkpointCanResume && previous.activeTopic) monitor.restore(previous.activeTopic);

    const maxEvents = limits.maxEvents ?? DEFAULT_CONTRACTION_LIMITS.maxEvents;
    const maxMonotonicMs = limits.maxMonotonicMs ?? DEFAULT_CONTRACTION_LIMITS.maxMonotonicMs;
    if (!Number.isInteger(maxEvents) || maxEvents <= 0 || !Number.isFinite(maxMonotonicMs) || maxMonotonicMs <= 0) {
      throw new Error("Contraction limits must be positive");
    }

    const startedAt = this.clock.monotonicNow();
    const turns: Turn[] = [];
    const anchors: Anchor[] = [];
    const completedSpans: CompletedTopicSpan[] = [];
    const processed: CanonicalEvent[] = [];
    const threadId = `person:${personId}`;

    for (let index = startIndex; index < allEvents.length && processed.length < maxEvents; index += 1) {
      const event = allEvents[index];
      const turn = turnFromEvent(event, threadId, index + 1);
      turns.push(turn);
      anchors.push(...anchorsForTurn(turn));
      const observed = monitor.observe({
        id: event.id,
        host: "unknown",
        profileId: personId,
        hostSessionId: threadId,
        sequence: index + 1,
        type: "conversation_turn",
        role: event.role,
        content: event.content,
        createdAt: event.occurredAt,
        metadata: turn.metadata
      });
      if (observed.completed) completedSpans.push(observed.completed);
      processed.push(event);
      await this.options.afterEvent?.(event);
      if (this.clock.monotonicNow() - startedAt >= maxMonotonicMs) break;
    }

    const nextIndex = startIndex + processed.length;
    const complete = nextIndex >= allEvents.length;
    const activeTopic = monitor.current(threadId);
    const spans = [...completedSpans];
    if (activeTopic) spans.push({ ...activeTopic, completedAt: activeTopic.updatedAt });
    const summaries: Summary[] = [];
    for (const span of spans) summaries.push(await this.summaryForSpan(personId, span, allEvents));

    // Superseding prior derivations is only meaningful when this slice REPROCESSES an
    // already-derived range: a rewind, a generation change, or the first slice against an existing
    // derived store (all of which set checkpointCanResume=false). On the forward path
    // (checkpointCanResume=true) the slice window is entirely fresh events — nothing prior depends
    // on them, and a continuing topic's provisional summary is re-emitted under the SAME
    // deterministic id (an upsert, not a duplicate), so no supersession is required. Skipping the
    // dependency scan here is what makes a bulk bootstrap tractable: invalidateDependencies loads
    // and re-parses EVERY summary/anchor/box/proposal/trace in the store, so running it on all
    // ~n/maxEvents forward slices was O(slices * all-derived-artifacts). The rewind path keeps the
    // full (correct) invalidation.
    let supersessions: DerivationSupersession[] = [];
    if (!checkpointCanResume) {
      const oldSummaries = (await this.store.listSummaries()).filter((summary) =>
        summary.personId === personId && summary.origin === "historical_bootstrap" && summary.state !== "superseded"
      );
      const affectedOldIds = oldSummaries
        .filter((summary) => summaryIntersectsAtOrAfter(summary, eventIndexById, startIndex))
        .map((summary) => summary.id);
      supersessions = await new DerivationInvalidator(this.store).invalidateDependencies({
        personId,
        summaryIds: affectedOldIds,
        canonicalEventIds: processed.map((event) => event.id),
        preserveIds: [...summaries.map((summary) => summary.id), ...anchors.map((anchor) => anchor.id)],
        supersededAt: this.clock.now()
      });
    }

    const nextEvent = allEvents[nextIndex] ?? null;
    const processedThroughOrderKey = orderKey(processed.at(-1) ?? null);
    const now = this.clock.now();
    const nextCheckpoint: ContractionCheckpoint = {
      id: checkpointId,
      personId,
      jobId,
      processorVersion: PROCESSOR_VERSION,
      generation: job.generation,
      processedThroughOrderKey,
      nextOrderKey: orderKey(nextEvent),
      nextEventId: nextEvent?.id ?? null,
      activeTopic,
      sliceCount: (previous?.sliceCount ?? 0) + 1,
      immediateStage: complete ? "complete" : "pending",
      proposalStage: checkpointCanResume ? previous.proposalStage : "pending",
      updatedAt: now
    };
    const nextJob: ContractionJob = {
      ...job,
      earliestAffected: processedThroughOrderKey ?? job.earliestAffected,
      latestAffected: processedThroughOrderKey && compareKeys(processedThroughOrderKey, job.latestAffected) > 0
        ? processedThroughOrderKey
        : job.latestAffected,
      state: complete ? "complete" : "pending",
      attempts: job.attempts + 1,
      immediateDirty: !complete,
      proposalDirty: true,
      generation: job.generation,
      lastProposalRunAt: job.lastProposalRunAt,
      updatedAt: now,
      nextDueAt: now
    };

    this.options.faults?.reach("before_contraction_commit");
    await this.options.beforeCommit?.();
    await this.store.commitContractionSlice({
      authority,
      personId,
      jobId,
      expectedCheckpoint: previous,
      turns,
      summaries,
      anchors,
      boxes: [],
      proposals: [],
      traces: [],
      supersessions,
      nextCheckpoint,
      nextJob
    });
    this.options.faults?.reach("after_contraction_checkpoint");

    return {
      processedEvents: processed.length,
      processedEventIds: processed.map((event) => event.id),
      rewindOrderKey,
      yielded: !complete,
      complete,
      checkpoint: nextCheckpoint,
      immediate: { summaries: summaries.length, anchors: anchors.length }
    };
  }

  private async affectedStartIndex(
    personId: string,
    events: CanonicalEvent[],
    affected: CanonicalOrderKey,
    eventIndexById: ReadonlyMap<string, number>
  ): Promise<number> {
    const earliestIndex = Math.max(0, events.findIndex((event) => compareKeys(orderKey(event)!, affected) >= 0));
    const summaries = (await this.store.listSummaries()).filter((summary) =>
      summary.personId === personId && summary.origin === "historical_bootstrap" && summary.state !== "superseded"
    );
    let boundary = earliestIndex;
    for (const summary of summaries) {
      const indices = (summary.sourceCanonicalEventIds ?? [])
        .map((id) => eventIndexById.get(id) ?? -1)
        .filter((index) => index >= 0);
      if (indices.length === 0) continue;
      const first = Math.min(...indices);
      const last = Math.max(...indices);
      if (first <= earliestIndex && last >= earliestIndex) boundary = Math.min(boundary, first);
    }
    return boundary;
  }

  private async assertEventScopes(personId: string, events: CanonicalEvent[]): Promise<void> {
    const sources = new Map((await this.store.listSources(personId)).map((source) => [source.id, source]));
    for (const event of events) {
      const source = sources.get(event.sourceId);
      if (!source || source.personId !== personId) throw new Error("Canonical event source ownership dependency mismatch");
      if ((event.scopeId ?? "personal") !== (source.scopeId ?? "personal")) {
        throw new Error("Canonical event scope dependency mismatch");
      }
    }
  }

  private async summaryForSpan(
    personId: string,
    span: CompletedTopicSpan,
    events: CanonicalEvent[]
  ): Promise<Summary> {
    const sourceEvents = events.slice(span.sourceTurnRange.startSequence - 1, span.sourceTurnRange.endSequence);
    const first = sourceEvents[0];
    if (!first) throw new Error("Cannot contract an empty topic span");
    // Turns are a deterministic function of (event, threadId, sequence) — see turnFromEvent — so
    // reconstruct the span's turns directly. Loading every persisted turn for the person
    // (listTurns) was an O(all turns) scan per span, the last per-slice full-load that kept a bulk
    // bootstrap quadratic. sourceEvents[k] sits at global sequence startSequence + k by construction.
    const sourceTurns = sourceEvents.map((event, offset) =>
      turnFromEvent(event, span.hostSessionId, span.sourceTurnRange.startSequence + offset));
    const draft = await this.summarizer.summarize({ span, sourceTurns });
    return {
      id: summaryId(personId, first.id, span.topicLabel),
      personId,
      scopeIds: [...new Set(sourceEvents.map((event) => event.scopeId ?? "personal"))].sort(),
      origin: "historical_bootstrap",
      summaryText: draft.summaryText,
      sourceTurnRanges: [span.sourceTurnRange],
      sourceCanonicalEventIds: sourceEvents.map((event) => event.id),
      sourceSummaryIds: [],
      boxIds: [],
      embedding: null,
      createdAt: span.completedAt,
      model: draft.model,
      promptVersion: draft.promptVersion,
      confidence: draft.confidence,
      state: "compacted",
      detailLevel: draft.detailLevel,
      tokenCount: draft.tokenCount,
      lastAccessedAt: null,
      version: 1,
      strength: 0.5,
      retrievalCount: 0,
      retrievedAt: null,
      halfLifeHours: 168,
      outcomeScore: null
    };
  }
}

function buildEventIndex(events: CanonicalEvent[]): ReadonlyMap<string, number> {
  const index = new Map<string, number>();
  for (let position = 0; position < events.length; position += 1) index.set(events[position]!.id, position);
  return index;
}

function resumeIndex(
  events: CanonicalEvent[],
  checkpoint: ContractionCheckpoint,
  eventIndexById: ReadonlyMap<string, number>
): number {
  const lastId = checkpoint.activeTopic?.lastEventId;
  if (lastId) {
    const lastIndex = eventIndexById.get(lastId);
    if (lastIndex !== undefined) return lastIndex + 1;
  }
  if (!checkpoint.nextOrderKey) return events.length;
  const index = events.findIndex((event) => compareKeys(orderKey(event)!, checkpoint.nextOrderKey!) >= 0);
  return index < 0 ? events.length : index;
}

function summaryIntersectsAtOrAfter(
  summary: Summary,
  eventIndexById: ReadonlyMap<string, number>,
  startIndex: number
): boolean {
  return (summary.sourceCanonicalEventIds ?? []).some((id) => {
    const index = eventIndexById.get(id);
    return index !== undefined && index >= startIndex;
  });
}

function orderKey(event: CanonicalEvent | null): CanonicalOrderKey | null {
  return event ? { occurredAt: event.occurredAt, nativeSequence: event.nativeSequence, id: event.id } : null;
}

function compareKeys(left: CanonicalOrderKey, right: CanonicalOrderKey): number {
  return left.occurredAt.localeCompare(right.occurredAt) || left.nativeSequence - right.nativeSequence || left.id.localeCompare(right.id);
}

function turnFromEvent(event: CanonicalEvent, threadId: string, sequence: number): Turn {
  return {
    id: `personal_turn_${event.id}`,
    threadId,
    sequence,
    role: event.role,
    content: event.content,
    createdAt: event.occurredAt,
    provenance: event.provenance,
    trustLevel: event.trustLevel,
    contentHash: event.contentHash,
    metadata: {
      personId: event.personId,
      canonicalEventId: event.id,
      sourceId: event.sourceId,
      sourceApplication: event.sourceApplication,
      scopeId: event.scopeId ?? "personal",
      nativeSessionId: event.nativeSessionId,
      nativeEventId: event.nativeEventId
    }
  };
}

function anchorsForTurn(turn: Turn): Anchor[] {
  const normalized = turn.content.toLowerCase();
  const kinds: Anchor["anchorType"][] = [];
  if (/\b(deadline|due|expires?|statute|limitations?|calendar|hearing|trial|deposition)\b/.test(normalized)) kinds.push("deadline");
  if (/\b(decided|decision|we will|we should|strategy is|approved|rejected|agreed)\b/.test(normalized)) kinds.push("decision");
  if (/\b(key fact|fact is|confirmed|undisputed|liability|coverage limit|policy limit|pip|bodily injury)\b/.test(normalized)) kinds.push("key_fact");
  if (/\b(strategy|leverage|risk|lesson|insight|because|therefore)\b/.test(normalized)) kinds.push("strategic_insight");
  if (/\b(bookmark|remember this|save this|come back to this)\b/.test(normalized)) kinds.push("bookmark");
  return [...new Set(kinds)].map((anchorType) => ({
    id: `anchor_${turn.id}_${anchorType}`,
    personId: String(turn.metadata.personId),
    canonicalEventId: String(turn.metadata.canonicalEventId),
    scopeId: String(turn.metadata.scopeId),
    turnId: turn.id,
    threadId: turn.threadId,
    boxId: null,
    anchorType,
    content: turn.content,
    embedding: null,
    createdAt: turn.createdAt,
    trustLevel: turn.trustLevel,
    source: turn.provenance
  }));
}

function summaryId(personId: string, firstEventId: string, topicLabel: string): string {
  const hash = createHash("sha256").update(JSON.stringify([personId, firstEventId, topicLabel.toLowerCase()])).digest("hex");
  return `historical_summary_${hash}`;
}
