import { createHash } from "node:crypto";
import { createEventLoopYielder } from "../imports/cooperative-yield.js";
import { anchorsForTurn } from "../anchors/anchor-detector.js";
import type { CanonicalEvent } from "../domain/canonical.js";
import { NON_SUPERSEDED_STATES, type Anchor, type Summary, type Turn } from "../domain/types.js";
import type { Embedder } from "../embeddings/embedder.js";
import { DerivationInvalidator } from "../service/derivation-invalidator.js";
import type { DerivationSupersession, PendingToolRun } from "./types.js";
import type { MemoryStore, SummaryVectorRecord } from "../storage/memory-store.js";
import { DeterministicSummarizer, type Summarizer } from "../summarization/summarizer.js";
import {
  HYGIENE_RULE_VERSION,
  derivationContents,
  drivesTopicLabel,
  openToolRunStart,
  toolNameOf,
  type ClassifiableEvent
} from "../topic/derivation-hygiene.js";
import { TopicMonitor, type CompletedTopicSpan, type RollingTopicState } from "../topic/topic-monitor.js";
import {
  WriteAuthoritySchema,
  type CanonicalOrderKey,
  type ContractionCheckpoint,
  type ContractionJob,
  type WriteAuthority
} from "./types.js";

// PROCESSOR_VERSION embeds HYGIENE_RULE_VERSION so a hygiene rule-version bump automatically marks
// every existing checkpoint stale via the existing (non-resume/rewind) invalidation path — REQ-054.
// Exported (additive, no behavior change) so `rebuild-derivations-command.ts` can detect a stale
// checkpoint without duplicating the version string (REQ-054).
export const PROCESSOR_VERSION = `continuous-contraction/v1+${HYGIENE_RULE_VERSION}`;
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
  /**
   * REQ-043 / ADR 0052: when supplied, a post-commit stage embeds exactly the summaries this slice
   * committed and tombstones the vectors of the summaries it superseded. ABSENT MEANS OFF — every
   * caller that omits it (`rebuild-derivations-command.ts`, `historical-bootstrapper.ts`, every
   * pre-12-03 test) keeps its previous behavior with no edit, so a bulk rebuild never embeds.
   *
   * `resolveEmbedder()` costs 72-121 ms of ONNX session construction, so the instance passed here
   * must be resolved once per PROCESS by the caller, never once per slice (T-12-17).
   */
  summaryEmbedder?: Embedder;
}

/** Per-slice outcome of the post-commit embed stage. `attempted` counts committed summaries. */
export interface EmbedStageCounts {
  attempted: number;
  persisted: number;
  failed: number;
}

export interface ContractionSliceResult {
  processedEvents: number;
  processedEventIds: string[];
  rewindOrderKey: CanonicalOrderKey | null;
  yielded: boolean;
  complete: boolean;
  checkpoint: ContractionCheckpoint;
  immediate: { summaries: number; anchors: number };
  supersessions: DerivationSupersession[];
  embedded: EmbedStageCounts;
}

/**
 * The events a slice may read, addressed by GLOBAL position in the canonical spine.
 *
 * A slice knows where all ~292,000 events sit (the spine: id, occurredAt, nativeSequence) but reads
 * the content of only the few hundred it processes. Every index in `drainSlice` is therefore a
 * global one, while the backing array holds just `[offset, offset + events.length)`.
 *
 * Out-of-window access THROWS rather than returning undefined. That is the whole safety argument
 * for this class: an off-by-one against a plain array would silently hand the summarizer a
 * different event's text and persist the result as memory. A crash is recoverable; that is not.
 */
class SliceEventWindow {
  constructor(
    private readonly events: readonly CanonicalEvent[],
    private readonly offset: number,
    /** Length of the FULL spine, not of the window -- `complete` is decided against this. */
    readonly totalLength: number
  ) {}

  at(index: number): CanonicalEvent {
    const event = this.events[index - this.offset];
    if (!event) {
      throw new Error(`Contraction window does not cover event index ${index} (offset ${this.offset}, length ${this.events.length})`);
    }
    return event;
  }

  slice(from: number, to: number): CanonicalEvent[] {
    if (from < this.offset || to > this.offset + this.events.length || from > to) {
      throw new Error(`Contraction window does not cover [${from}, ${to}) (offset ${this.offset}, length ${this.events.length})`);
    }
    return this.events.slice(from - this.offset, to - this.offset);
  }
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
    limits: { maxEvents?: number; maxMonotonicMs?: number } = {},
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
    //
    // Each stage below is a single SYNCHRONOUS `node:sqlite` call that cannot itself be broken up,
    // so the yields sit BETWEEN them. That is the whole mechanism: the daemon renews its 30 s write
    // lease from a 10 s `setTimeout` heartbeat, and a slice that never reaches the timer phase lets
    // the lease lapse and then has its own commit rejected by `assertFreshDaemonAuthority`. Measured
    // on the live corpus: 66 s inside one slice with zero heartbeats, ending in
    // "Daemon write authority is missing, stale, or expired". Yielding here caps the longest
    // unbroken block at the largest single load rather than at their sum.
    const maybeYield = createEventLoopYielder();
    // The SPINE: every event's identity and position, no content. A daemon slice needs to know where
    // all ~292,000 events sit but reads the text of only the ~250 it processes, and conflating those
    // two needs is what made one slice cost ~22 s (19.7 s of it this single load) while the daemon's
    // 30 s write lease ticked down. Served from a covering index at 1.23 s; content comes later, for
    // a bounded window, via `listCanonicalEventsByIds`.
    const spine: readonly CanonicalOrderKey[] = context.preloadedEvents
      ? context.preloadedEvents.map((event) => orderKey(event)!)
      : await this.store.listCanonicalEventKeys(personId);
    await maybeYield();
    if (!context.scopesAlreadyAsserted) await this.assertEventScopes(personId, context.preloadedEvents);
    const eventIndexById = context.eventIndexById ?? buildSpineIndex(spine);
    await maybeYield();
    const checkpointId = `contraction_checkpoint_${jobId}`;
    const previous = await this.store.getContractionCheckpoint(checkpointId);
    if (previous && (previous.personId !== personId || previous.jobId !== jobId)) {
      throw new Error("Contraction checkpoint person ownership mismatch");
    }

    // Drift guard (11-CONTEXT decision 6 / T-11-09): a withheld open run recorded in the checkpoint
    // must still be exactly the trailing open run at that position. A late import landing inside the
    // withheld range (the same late-insert path the "resumes by stable canonical key" test pins) or a
    // hygiene rule-version bump invalidates the recorded run, so fail closed to the full
    // rewind/invalidation path instead of silently emitting a second activity line for the same run.
    const checkpointCanResume = previous !== null &&
      previous.generation === job.generation &&
      previous.processorVersion === PROCESSOR_VERSION &&
      (previous.processedThroughOrderKey === null ||
        compareKeys(job.earliestAffected, previous.processedThroughOrderKey) >= 0) &&
      (previous.pendingToolRun === null ||
        await this.pendingToolRunStillOpen(personId, previous.pendingToolRun, spine, eventIndexById, context));

    if (checkpointCanResume && previous.immediateStage === "complete" && job.state === "complete") {
      return {
        processedEvents: 0,
        processedEventIds: [],
        rewindOrderKey: null,
        yielded: false,
        complete: true,
        checkpoint: previous,
        immediate: { summaries: 0, anchors: 0 },
        supersessions: [],
        embedded: { attempted: 0, persisted: 0, failed: 0 }
      };
    }

    const startIndex = checkpointCanResume
      ? resumeIndex(spine, previous, eventIndexById)
      : await this.affectedStartIndex(personId, spine, job.earliestAffected, eventIndexById);
    await maybeYield();
    const rewindOrderKey = checkpointCanResume ? null : (spine[startIndex] ?? null);
    const monitor = new TopicMonitor();
    if (checkpointCanResume && previous.activeTopic) monitor.restore(previous.activeTopic);

    const maxEvents = limits.maxEvents ?? DEFAULT_CONTRACTION_LIMITS.maxEvents;
    const maxMonotonicMs = limits.maxMonotonicMs ?? DEFAULT_CONTRACTION_LIMITS.maxMonotonicMs;
    if (!Number.isInteger(maxEvents) || maxEvents <= 0 || !Number.isFinite(maxMonotonicMs) || maxMonotonicMs <= 0) {
      throw new Error("Contraction limits must be positive");
    }

    // The window this slice may read. It starts at the RESTORED active span rather than at
    // `startIndex`: a resumed span's summary is re-derived over its whole range, so its earlier
    // events are read again even though they were processed by a previous slice. A span that opens
    // during this slice can only start at or after `startIndex`, so it needs nothing earlier.
    //
    // The upper bound is the loop's own cap. The loop may stop earlier (`maxMonotonicMs`), which
    // just leaves part of the window unread.
    const restoredSpanStart = checkpointCanResume && previous.activeTopic
      ? previous.activeTopic.sourceTurnRange.startSequence - 1
      : startIndex;
    const windowLow = Math.max(0, Math.min(startIndex, restoredSpanStart));
    const windowHigh = Math.min(spine.length, startIndex + maxEvents);
    const events = await this.materializeWindow(personId, spine, windowLow, windowHigh, context);
    await maybeYield();

    const startedAt = this.clock.monotonicNow();
    const turns: Turn[] = [];
    const anchors: Anchor[] = [];
    const spanWindows: SpanWindow[] = [];
    const processed: CanonicalEvent[] = [];
    const threadId = `person:${personId}`;

    for (let index = startIndex; index < events.totalLength && processed.length < maxEvents; index += 1) {
      const event = events.at(index);
      const turn = turnFromEvent(event, threadId, index + 1);
      turns.push(turn);
      // Anchors are generated below, per span window, gated on whether an event's OWN text
      // survives into derivation (REQ-053) — not unconditionally per event as before.
      // Only conversational events reach TopicMonitor — this is the count-reduction mechanism
      // (REQ-052/REQ-053): tool-activity and synthetic events can neither open a span nor change a
      // topic label. They are still turned into Turn rows and still counted in `processed` above.
      if (drivesTopicLabel(event)) {
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
        // A completed span ends on a label-driving event (by definition not tool activity), so its
        // window's derivable text always equals its full raw window — it can never straddle an open run.
        if (observed.completed) {
          spanWindows.push({
            span: observed.completed,
            windowStart: observed.completed.sourceTurnRange.startSequence - 1,
            windowEnd: index,
            derivationEnd: index
          });
        }
      }
      processed.push(event);
      await maybeYield();
      await this.options.afterEvent?.(event);
      if (this.clock.monotonicNow() - startedAt >= maxMonotonicMs) break;
    }

    const nextIndex = startIndex + processed.length;
    const complete = nextIndex >= events.totalLength;
    const activeTopic = monitor.current(threadId);

    // Events preceding the first span ever created (corpus head with no active topic yet) belong to
    // no window and are legitimately left unsummarized.
    let pendingToolRun: PendingToolRun | null = null;
    if (activeTopic) {
      const windowStart = activeTopic.sourceTurnRange.startSequence - 1;
      const windowEnd = nextIndex;
      let derivationEnd = windowEnd;
      // Open-run withholding (11-CONTEXT decision 6): only the trailing active span of a
      // NON-complete slice can end inside an open run. A run at the end of the corpus (complete ===
      // true) cannot grow, so it is always flushed rather than withheld (Task 2 case f5).
      if (!complete) {
        const openStart = openToolRunStart(events.slice(windowStart, windowEnd));
        if (openStart !== null) {
          derivationEnd = windowStart + openStart;
          const withheldEvents = events.slice(derivationEnd, windowEnd);
          pendingToolRun = {
            startEventId: withheldEvents[0]!.id,
            eventCount: withheldEvents.length,
            toolCounts: tallyToolCounts(withheldEvents.map((event) => toolNameOf(event.content))),
            ruleVersion: HYGIENE_RULE_VERSION
          };
        }
      }
      spanWindows.push({
        span: { ...activeTopic, completedAt: activeTopic.updatedAt },
        windowStart,
        windowEnd,
        derivationEnd
      });
    }

    const summaries: Summary[] = [];
    for (const window of spanWindows) {
      summaries.push(await this.summaryForSpan(
        personId,
        window.span,
        events,
        window.windowStart,
        window.windowEnd,
        window.derivationEnd
      ));
      // Anchors follow derivation content exactly (REQ-053): an event produces anchors only when it
      // contributed its OWN text to the summary — i.e. only conversational events. Synthetic events
      // never produce anchors, and neither does ANY tool_activity event: after Plan 11-24 reversed
      // SC1, every tool run — including an isolated single call — collapses to `collapseText(...)`
      // and no member contributes its own text (GAP-11-G; this comment previously still described
      // the pre-reversal carve-out, which is how that defect survived review). Gating on
      // `[windowStart, derivationEnd)` — the exact same range summaryForSpan derives text from —
      // means a withheld open run's events are considered only once the run closes, on whichever
      // future slice recomputes this span's (bounded, run-length-sized) window.
      //
      // `anchorsForTurn` is the shared minter in src/anchors/anchor-detector.ts, which re-applies the
      // hygiene gate itself (with `eventKind`, which a CanonicalEvent has and a Turn does not). That
      // is deliberate belt-and-braces: this call site's own filter and the minter's gate are the two
      // halves that GAP-11-G found had drifted apart when they were separate implementations.
      for (const relativeIndex of survivingDerivationIndices(events.slice(window.windowStart, window.derivationEnd))) {
        const globalIndex = window.windowStart + relativeIndex;
        const event = events.at(globalIndex);
        anchors.push(...anchorsForTurn(
          turnFromEvent(event, threadId, globalIndex + 1),
          { eventKind: event.eventKind }
        ));
      }
    }

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
      // Same store-side filter as `affectedStartIndex`, and the same reason: this is the identical
      // predicate over the identical table, and it runs on the rewind/first-slice path -- the one a
      // daemon slice against an already-derived corpus always takes.
      const oldSummaries = (await this.store.listSummaries({ personId, states: NON_SUPERSEDED_STATES }))
        .filter((summary) => summary.origin === "historical_bootstrap");
      const affectedOldIds = oldSummaries
        .filter((summary) => summaryIntersectsAtOrAfter(summary, eventIndexById, startIndex))
        .map((summary) => summary.id);
      await maybeYield();
      supersessions = await new DerivationInvalidator(this.store).invalidateDependencies({
        personId,
        summaryIds: affectedOldIds,
        canonicalEventIds: processed.map((event) => event.id),
        preserveIds: [...summaries.map((summary) => summary.id), ...anchors.map((anchor) => anchor.id)],
        supersededAt: this.clock.now()
      });
    }

    const nextEvent = spine[nextIndex] ?? null;
    const processedThroughOrderKey = orderKey(processed.at(-1) ?? null);
    const now = this.clock.now();
    const nextCheckpoint: ContractionCheckpoint = {
      id: checkpointId,
      personId,
      jobId,
      processorVersion: PROCESSOR_VERSION,
      generation: job.generation,
      processedThroughOrderKey,
      nextOrderKey: nextEvent,
      nextEventId: nextEvent?.id ?? null,
      activeTopic,
      sliceCount: (previous?.sliceCount ?? 0) + 1,
      immediateStage: complete ? "complete" : "pending",
      proposalStage: checkpointCanResume ? previous.proposalStage : "pending",
      pendingToolRun,
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

    // Last chance before the commit: this is the write that `assertFreshDaemonAuthority` rejects if
    // everything above ran the lease past its TTL.
    await maybeYield();
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

    // POST-COMMIT, and deliberately so (ADR 0052). Running inside the transaction would couple
    // memory formation to embedder health; running above `drainSlice` would put it on the far side
    // of `daemon.ts:145-148`, which maps any contraction throw to `storage_failure`, and of
    // `daemon.ts:158-161`, which drops the writer lease. It is driven by the summary set the slice
    // just committed, so its cost is O(summaries) with no query — which is why it stays cheap on a
    // large corpus, and why it catches a re-emitted active span (an upsert under the same
    // deterministic id) that a missing-set-driven scheduler could never see.
    const embedded = await this.embedCommittedSummaries(summaries, supersessions);

    return {
      processedEvents: processed.length,
      processedEventIds: processed.map((event) => event.id),
      rewindOrderKey,
      yielded: !complete,
      complete,
      checkpoint: nextCheckpoint,
      immediate: { summaries: summaries.length, anchors: anchors.length },
      supersessions,
      embedded
    };
  }

  /**
   * Embeds the summaries this slice committed and tombstones the vectors of the ones it superseded.
   *
   * FAILURE ISOLATION IS THE LOAD-BEARING PROPERTY (ADR 0052 decision 2): this never throws. A
   * summary without a vector is a recoverable state — the repair pass heals it and `memory status`
   * reports it — whereas a throw here would be classified as a storage failure and could cost the
   * daemon its writer lease.
   *
   * Ordering is decided, not incidental: the write runs FIRST and the tombstone SECOND, so an id
   * that is both re-emitted and superseded within one slice ends tombstoned rather than leaving an
   * orphan vector behind. This is the delete half of the precedent at
   * `rebuild-derivations-command.ts:167-175`; without it, stale vector rows accumulate unboundedly
   * and are unreachable by the state-predicated missing-set query.
   */
  private async embedCommittedSummaries(
    summaries: Summary[],
    supersessions: DerivationSupersession[]
  ): Promise<EmbedStageCounts> {
    const embedder = this.options.summaryEmbedder;
    if (!embedder) return { attempted: 0, persisted: 0, failed: 0 };

    const attempted = summaries.length;
    let persisted = 0;
    let failed = 0;

    try {
      const records: SummaryVectorRecord[] = [];
      for (const summary of summaries) {
        if (!summary.personId) {
          // Skip and count. NEVER substitute a sentinel personId (T-10-05/T-12-12): a mis-tagged
          // vector row is cross-person retrieval.
          failed += 1;
          continue;
        }
        try {
          // Passage mode. NEVER `embedQuery` — bge is asymmetric and only queries carry the
          // instruction prefix (Phase 9, locked).
          const embedding = await embedder.embed(summary.summaryText);
          records.push({
            summaryId: summary.id,
            provider: embedding.provider,
            model: embedding.model,
            dimensions: embedding.dimensions,
            vector: embedding.vector,
            personId: summary.personId,
            scopeIds: summary.scopeIds ?? [],
            createdAt: embedding.createdAt
          });
        } catch {
          failed += 1;
        }
      }

      if (records.length > 0) {
        // One batched call for the whole slice, not a per-record loop.
        try {
          await this.store.saveSummaryVectors(records);
          persisted = records.length;
        } catch {
          failed += records.length;
        }
      }

      const supersededSummaryIds = supersessions
        .filter((supersession) => supersession.kind === "summary")
        .map((supersession) => supersession.id);
      if (supersededSummaryIds.length > 0) {
        try {
          await this.store.deleteSummaryVectors(supersededSummaryIds);
        } catch {
          // A missed tombstone is a stale row, not a correctness failure: `findNearestSummaries`
          // already drops vectors whose summary is non-retrievable.
        }
      }
    } catch {
      // Defence in depth — nothing above is expected to escape its own catch, but the whole stage
      // is still wrapped so that no unforeseen throw can reach the contraction's caller.
      failed = attempted - persisted;
    }

    if (failed > 0) {
      // Counts, provider, and model ONLY (V7/T-12-15). Never a summary id alongside its text, never
      // the text itself, never an error message that quotes the input — the same discipline as
      // `backfill-embeddings-command.ts:125-133`.
      process.stderr.write(`${JSON.stringify({
        event: "summary_embed_incomplete",
        attempted,
        persisted,
        failed,
        provider: embedder.provider,
        model: embedder.model
      })}\n`);
    }

    return { attempted, persisted, failed };
  }

  private async affectedStartIndex(
    personId: string,
    spine: readonly CanonicalOrderKey[],
    affected: CanonicalOrderKey,
    eventIndexById: ReadonlyMap<string, number>
  ): Promise<number> {
    const earliestIndex = Math.max(0, spine.findIndex((key) => compareKeys(key, affected) >= 0));
    // Pushed into the store rather than filtered in JS. The unfiltered `listSummaries()` loaded and
    // Zod-parsed every summary in the corpus -- measured at 13.6 s for 138,373 rows on the live
    // database -- to answer a question about a subset, inside a slice whose write authority expires
    // after 30 s. Measured cardinality there: `personId` and `origin` each excluded *nothing* (one
    // person, all bootstrap-origin), so only the state predicate does real work; it drops 89,059 of
    // 138,373 rows. `personId` is passed anyway because a second person makes it load-bearing.
    const summaries = (await this.store.listSummaries({ personId, states: NON_SUPERSEDED_STATES }))
      .filter((summary) => summary.origin === "historical_bootstrap");
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

  /**
   * Same invariant as before, obtained differently: every canonical event's source must belong to
   * this person, and the event's scope must equal that source's.
   *
   * It used to loop over every materialized event. That is a statement about the DISTINCT
   * (sourceId, scopeId) pairs, though -- the live corpus has 292,407 events and 18 pairs -- so the
   * store answers it from an index instead (15.18 s -> 0.024 s) and no payload is read. Same pairs,
   * same comparison, same error.
   *
   * `preloadedEvents` keeps the in-memory path for the bootstrapper, which already holds every
   * event and would otherwise issue a query for data it is sitting on.
   */
  private async assertEventScopes(personId: string, preloadedEvents?: readonly CanonicalEvent[]): Promise<void> {
    const sources = new Map((await this.store.listSources(personId)).map((source) => [source.id, source]));
    const pairs = preloadedEvents
      ? [...new Map(preloadedEvents.map((event) => {
          const scopeId = event.scopeId ?? "personal";
          return [`${event.sourceId} ${scopeId}`, { sourceId: event.sourceId, scopeId }] as const;
        })).values()]
      : await this.store.listCanonicalEventScopePairs(personId);

    for (const pair of pairs) {
      const source = sources.get(pair.sourceId);
      if (!source || source.personId !== personId) throw new Error("Canonical event source ownership dependency mismatch");
      if (pair.scopeId !== (source.scopeId ?? "personal")) {
        throw new Error("Canonical event scope dependency mismatch");
      }
    }
  }

  /**
   * Materializes `[low, high)` of the spine, and nothing else.
   *
   * `listCanonicalEventsByIds` returns rows in the store's canonical order, which is the spine's
   * order, so the result lines up with `[low, high)` positionally. That is asserted rather than
   * assumed: a mismatch would offset every index in the slice and derive summaries from the wrong
   * events, which no test downstream would catch.
   */
  private async materializeWindow(
    personId: string,
    spine: readonly CanonicalOrderKey[],
    low: number,
    high: number,
    context: DrainSliceContext
  ): Promise<SliceEventWindow> {
    if (context.preloadedEvents) {
      return new SliceEventWindow(context.preloadedEvents, 0, context.preloadedEvents.length);
    }
    if (high <= low) return new SliceEventWindow([], low, spine.length);

    const wanted = spine.slice(low, high);
    const events = await this.store.listCanonicalEventsByIds(personId, wanted.map((key) => key.id));
    if (events.length !== wanted.length) {
      throw new Error(`Contraction window expected ${wanted.length} events, resolved ${events.length}`);
    }
    for (let offset = 0; offset < wanted.length; offset += 1) {
      if (events[offset]!.id !== wanted[offset]!.id) {
        throw new Error("Contraction window order does not match the canonical spine");
      }
    }
    return new SliceEventWindow(events, low, spine.length);
  }

  /**
   * Drift guard for a withheld open tool run, over a BOUNDED region.
   *
   * The predicate is unchanged: the recorded run must still be exactly the trailing open run at its
   * recorded position. It was evaluated by scanning every event from index 0 to the run's boundary,
   * which on a resumed slice near the end of the corpus meant materializing essentially everything.
   *
   * Only the run and the event immediately before it can affect the answer, so the same
   * `openToolRunStart` is applied to `[runStart - 1, boundary]`:
   *   - if the predecessor is not tool activity, the run opens at relative index 1, i.e. runStart;
   *   - if it IS tool activity, the run extends earlier, `openToolRunStart` returns 0, and the
   *     comparison fails -- exactly as the full-prefix scan failed, and in the safe direction
   *     (fall back to the full rewind/invalidation path).
   * `openToolRunStart` itself is untouched; GAP-11-G came from re-implementing a hygiene walk in a
   * second place, and this deliberately does not do that.
   */
  private async pendingToolRunStillOpen(
    personId: string,
    pending: PendingToolRun,
    spine: readonly CanonicalOrderKey[],
    eventIndexById: ReadonlyMap<string, number>,
    context: DrainSliceContext
  ): Promise<boolean> {
    if (pending.ruleVersion !== HYGIENE_RULE_VERSION) return false;
    const runStart = eventIndexById.get(pending.startEventId);
    if (runStart === undefined) return false;
    const boundaryIndex = runStart + pending.eventCount - 1;
    if (boundaryIndex < 0 || boundaryIndex >= spine.length) return false;

    const low = Math.max(0, runStart - 1);
    const window = await this.materializeWindow(personId, spine, low, boundaryIndex + 1, context);
    return openToolRunStart(window.slice(low, boundaryIndex + 1)) === runStart - low;
  }

  private async summaryForSpan(
    personId: string,
    span: CompletedTopicSpan,
    events: SliceEventWindow,
    windowStart: number,
    windowEnd: number,
    derivationEnd: number
  ): Promise<Summary> {
    // The FULL raw window — including collapsed tool events, withheld open-run events, and excluded
    // synthetic events. Provenance is never narrowed by a content (derivation) decision (Pitfall 3):
    // DerivationInvalidator, affectedStartIndex, and summaryIntersectsAtOrAfter all key off this list.
    const sourceEvents = events.slice(windowStart, windowEnd);
    const first = sourceEvents[0];
    if (!first) throw new Error("Cannot contract an empty topic span");
    // Turns are a deterministic function of (event, threadId, sequence) — see turnFromEvent — so
    // reconstruct the span's turns directly. Loading every persisted turn for the person
    // (listTurns) was an O(all turns) scan per span, the last per-slice full-load that kept a bulk
    // bootstrap quadratic. sourceEvents[k] sits at global sequence windowStart + 1 + k by construction.
    const rawTurns = sourceEvents.map((event, offset) => turnFromEvent(event, span.hostSessionId, windowStart + 1 + offset));
    // `derivationEnd` narrows the TEXT the summarizer sees only (never provenance, above). It equals
    // `windowEnd` for every span except a trailing active span with a withheld open run, where it is
    // the run's start index — the intermediate "N tool calls so far" count must never be observable.
    const derivable = sourceEvents.slice(0, derivationEnd - windowStart);
    // Ephemeral hygiene view used ONLY for summarization input; never mutate rawTurns and never
    // persist these ephemeral turns to the store (Pitfall 2 — the positional invariant).
    const sourceTurns = derivationContents(derivable).map(({ index, content }) => ({ ...rawTurns[index]!, content }));
    const draft = await this.summarizer.summarize({ span, sourceTurns });
    return {
      // A topic-label change deliberately changes this id; DerivationInvalidator finds the OLD
      // summary by sourceCanonicalEventIds intersection, not by id equality (Pitfall 5).
      id: summaryId(personId, first.id, span.topicLabel),
      personId,
      scopeIds: [...new Set(sourceEvents.map((event) => event.scopeId ?? "personal"))].sort(),
      origin: "historical_bootstrap",
      summaryText: draft.summaryText,
      sourceTurnRanges: [{ threadId: span.sourceTurnRange.threadId, startSequence: windowStart + 1, endSequence: windowEnd }],
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

/** A span's raw event window, plus the exclusive index up to which its own text may be derived. */
interface SpanWindow {
  span: CompletedTopicSpan;
  windowStart: number;
  windowEnd: number;
  derivationEnd: number;
}

function buildSpineIndex(spine: readonly CanonicalOrderKey[]): ReadonlyMap<string, number> {
  const index = new Map<string, number>();
  for (let position = 0; position < spine.length; position += 1) index.set(spine[position]!.id, position);
  return index;
}

/**
 * Indices (relative to `events`) whose OWN text survives into derivation, and therefore the only
 * indices that may produce anchors (REQ-053). Post-Plan-11-24 that set is exactly the
 * `conversational` events: synthetic events are dropped, and EVERY tool_activity event — including
 * an isolated single one — collapses into a run entry that carries no individual member's own text.
 *
 * GAP-11-G: this used to re-implement `computeSegments`' run walk with
 * `if (currentRun.length === 1) survivors.add(...)`, the PRE-reversal SC1 carve-out. Plan 11-24
 * reversed that carve-out in `derivationContents` but not in this separate copy, so the rebuild path
 * kept minting anchors from raw isolated tool-call text — 1,330 of them measured on the Plan 11-25
 * rehearsal clone (11-REBUILD.md). The copy is now gone: this delegates to the same
 * `drivesTopicLabel` predicate every other call site uses, so no second copy of the rule remains to
 * drift out of agreement with `derivationContents`.
 */
function survivingDerivationIndices(events: readonly ClassifiableEvent[]): Set<number> {
  const survivors = new Set<number>();
  events.forEach((event, index) => {
    if (drivesTopicLabel(event)) survivors.add(index);
  });
  return survivors;
}

/** Count-desc/name-asc tally matching `collapseText`'s rendering, without re-implementing the string build. */
function tallyToolCounts(names: string[]): PendingToolRun["toolCounts"] {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tool, count]) => ({ tool, count }));
}

/**
 * Drift guard: re-derives whether `pending.startEventId` is STILL the first event of an open tool
 * run at its recorded position, rather than trusting the stored `eventCount`. Recomputing
 * `openToolRunStart` over the full prefix up to the last processed event is safe because run
 * segmentation is local — an earlier conversational event always flushes any prior run — so scanning
 * from the corpus start cannot misattribute the trailing run's true start index.
 */
function resumeIndex(
  spine: readonly CanonicalOrderKey[],
  checkpoint: ContractionCheckpoint,
  eventIndexById: ReadonlyMap<string, number>
): number {
  // Resume from the last PROCESSED event, not the last LABEL-DRIVING event: under hygiene,
  // `activeTopic.lastEventId` is the last event that drove a topic label, so a slice whose tail (or
  // entirety) is tool activity would otherwise resume before events it already processed — in the
  // pathological all-tool-activity slice, it would never advance at all (T-11-06). The late-insert
  // semantics of the existing 250-event test are preserved because `processedThroughOrderKey.id` is
  // exactly the last processed event either way.
  const processedId = checkpoint.processedThroughOrderKey?.id;
  if (processedId) {
    const processedIndex = eventIndexById.get(processedId);
    if (processedIndex !== undefined) return processedIndex + 1;
  }
  const lastId = checkpoint.activeTopic?.lastEventId;
  if (lastId) {
    const lastIndex = eventIndexById.get(lastId);
    if (lastIndex !== undefined) return lastIndex + 1;
  }
  if (!checkpoint.nextOrderKey) return spine.length;
  const index = spine.findIndex((key) => compareKeys(key, checkpoint.nextOrderKey!) >= 0);
  return index < 0 ? spine.length : index;
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

function summaryId(personId: string, firstEventId: string, topicLabel: string): string {
  const hash = createHash("sha256").update(JSON.stringify([personId, firstEventId, topicLabel.toLowerCase()])).digest("hex");
  return `historical_summary_${hash}`;
}
