import { createHash } from "node:crypto";
import type { CanonicalEvent } from "../domain/canonical.js";
import type { Anchor, Summary, Turn } from "../domain/types.js";
import { DerivationInvalidator } from "../service/derivation-invalidator.js";
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
    limits: Partial<typeof DEFAULT_CONTRACTION_LIMITS> = {}
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

    const allEvents = await this.store.listCanonicalEvents(personId);
    await this.assertEventScopes(personId, allEvents);
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
      ? resumeIndex(allEvents, previous)
      : await this.affectedStartIndex(personId, allEvents, job.earliestAffected);
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
    for (const span of spans) summaries.push(await this.summaryForSpan(personId, span, allEvents, turns));

    const oldSummaries = (await this.store.listSummaries()).filter((summary) =>
      summary.personId === personId && summary.origin === "historical_bootstrap" && summary.state !== "superseded"
    );
    const affectedOldIds = oldSummaries
      .filter((summary) => summaryIntersectsAtOrAfter(summary, allEvents, startIndex))
      .map((summary) => summary.id);
    const supersessions = await new DerivationInvalidator(this.store).invalidateDependencies({
      personId,
      summaryIds: affectedOldIds,
      canonicalEventIds: processed.map((event) => event.id),
      preserveIds: [...summaries.map((summary) => summary.id), ...anchors.map((anchor) => anchor.id)],
      supersededAt: this.clock.now()
    });

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

  private async affectedStartIndex(personId: string, events: CanonicalEvent[], affected: CanonicalOrderKey): Promise<number> {
    const earliestIndex = Math.max(0, events.findIndex((event) => compareKeys(orderKey(event)!, affected) >= 0));
    const summaries = (await this.store.listSummaries()).filter((summary) =>
      summary.personId === personId && summary.origin === "historical_bootstrap" && summary.state !== "superseded"
    );
    let boundary = earliestIndex;
    for (const summary of summaries) {
      const indices = (summary.sourceCanonicalEventIds ?? [])
        .map((id) => events.findIndex((event) => event.id === id))
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
    events: CanonicalEvent[],
    newTurns: Turn[]
  ): Promise<Summary> {
    const sourceEvents = events.slice(span.sourceTurnRange.startSequence - 1, span.sourceTurnRange.endSequence);
    const first = sourceEvents[0];
    if (!first) throw new Error("Cannot contract an empty topic span");
    const storedTurns = await this.store.listTurns(span.hostSessionId);
    const byId = new Map([...storedTurns, ...newTurns].map((turn) => [turn.id, turn]));
    const sourceTurns = sourceEvents.map((event) => byId.get(`personal_turn_${event.id}`)).filter((turn): turn is Turn => !!turn);
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

function resumeIndex(events: CanonicalEvent[], checkpoint: ContractionCheckpoint): number {
  const lastId = checkpoint.activeTopic?.lastEventId;
  if (lastId) {
    const lastIndex = events.findIndex((event) => event.id === lastId);
    if (lastIndex >= 0) return lastIndex + 1;
  }
  if (!checkpoint.nextOrderKey) return events.length;
  const index = events.findIndex((event) => compareKeys(orderKey(event)!, checkpoint.nextOrderKey!) >= 0);
  return index < 0 ? events.length : index;
}

function summaryIntersectsAtOrAfter(summary: Summary, events: CanonicalEvent[], startIndex: number): boolean {
  return (summary.sourceCanonicalEventIds ?? []).some((id) => {
    const index = events.findIndex((event) => event.id === id);
    return index >= startIndex;
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
