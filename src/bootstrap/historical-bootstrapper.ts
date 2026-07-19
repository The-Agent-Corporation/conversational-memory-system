import { createHash } from "node:crypto";
import {
  ContractionRunner,
  type ContractionSliceResult
} from "../daemon/contraction-runner.js";
import { ProposalScheduler } from "../daemon/proposal-scheduler.js";
import {
  WriteAuthoritySchema,
  type CanonicalOrderKey,
  type ContractionJob,
  type WriteAuthority
} from "../daemon/types.js";
import type { CanonicalEvent } from "../domain/canonical.js";
import type { MemoryStore } from "../storage/memory-store.js";
import {
  DeterministicSummarizer,
  type Summarizer
} from "../summarization/summarizer.js";
import type {
  HistoricalBootstrapCheckpoint,
  HistoricalBootstrapResult
} from "./types.js";

const PROCESSOR_VERSION = "historical-bootstrap/v1";
const EMPTY_PREFIX_HASH = createHash("sha256").update("").digest("hex");

interface CompatibilityContractionRunner {
  drainSlice(personId: string, jobId: string): Promise<ContractionSliceResult>;
}

interface CompatibilityProposalScheduler {
  runDue(personId: string): Promise<{
    boxProposals: number;
    traceProposals: number;
    ran: boolean;
  }>;
}

interface RunnerFactoryInput {
  store: MemoryStore;
  authority: WriteAuthority;
  summarizer: Summarizer;
  clock: () => string;
}

interface ProposalFactoryInput {
  store: MemoryStore;
  authority: WriteAuthority;
  clock: () => string;
}

export interface HistoricalBootstrapperOptions {
  summarizer?: Summarizer;
  clock?: () => string;
  authority?: WriteAuthority;
  contractionRunnerFactory?: (
    input: RunnerFactoryInput
  ) => CompatibilityContractionRunner;
  proposalSchedulerFactory?: (
    input: ProposalFactoryInput
  ) => CompatibilityProposalScheduler;
}

/**
 * One-shot compatibility facade over the daemon's authoritative contraction
 * and proposal publication engines. It intentionally contains no derivation
 * loop of its own.
 */
export class HistoricalBootstrapper {
  private readonly summarizer: Summarizer;
  private readonly clock: () => string;

  constructor(
    private readonly store: MemoryStore,
    private readonly options: HistoricalBootstrapperOptions = {}
  ) {
    this.summarizer = options.summarizer ?? new DeterministicSummarizer();
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async bootstrap(personId: string): Promise<HistoricalBootstrapResult> {
    if (!(await this.store.getPerson(personId))) {
      throw new Error(`Cannot bootstrap unknown person ${personId}`);
    }

    // Validate the narrow compatibility authority before creating or updating
    // any durable job/checkpoint state. There is no absent-token foreground
    // inference: production explicitly selects this operation here.
    const authority = this.compatibilityAuthority(personId);
    const events = await this.store.listCanonicalEvents(personId);
    const legacyCheckpointId = historicalBootstrapCheckpointId(personId);
    const previousLegacy = await this.store.getBootstrapCheckpoint(legacyCheckpointId);

    if (events.length === 0) {
      const checkpoint = buildCompatibilityCheckpoint(personId, events, null, this.clock());
      return emptyResult(previousLegacy ?? checkpoint);
    }

    const job = await this.ensureContractionJob(personId, events);
    if (!job) {
      const checkpoint = previousLegacy ?? buildCompatibilityCheckpoint(
        personId,
        events,
        await this.store.getContractionCheckpoint(
          `contraction_checkpoint_${historicalContractionJobId(personId)}`
        ),
        this.clock()
      );
      return emptyResult(checkpoint);
    }

    const runner = this.options.contractionRunnerFactory?.({
      store: this.store,
      authority,
      summarizer: this.summarizer,
      clock: this.clock
    }) ?? new ContractionRunner(this.store, {
      authority,
      summarizer: this.summarizer,
      clock: { now: this.clock, monotonicNow: () => performance.now() }
    });

    let eventsProcessed = 0;
    let summariesUpdated = 0;
    let anchorsDetected = 0;
    let reset = false;
    let finalSlice: ContractionSliceResult | null = null;
    for (;;) {
      const slice = await runner.drainSlice(personId, job.id);
      finalSlice = slice;
      eventsProcessed += slice.processedEvents;
      summariesUpdated += slice.immediate.summaries;
      anchorsDetected += slice.immediate.anchors;
      reset ||= previousLegacy !== null && slice.rewindOrderKey !== null;
      if (slice.complete) break;
      if (slice.processedEvents === 0) {
        throw new Error("Compatibility contraction made no progress");
      }
    }

    const checkpoint = buildCompatibilityCheckpoint(
      personId,
      events,
      finalSlice.checkpoint,
      this.clock()
    );
    await this.store.saveBootstrapCheckpoint(checkpoint);

    const proposals = eventsProcessed > 0
      ? await this.drainProposals(personId, authority)
      : { boxProposalsCreated: 0, traceProposalsCreated: 0 };

    return {
      reset,
      eventsProcessed,
      summariesUpdated,
      anchorsDetected,
      boxProposalsCreated: proposals.boxProposalsCreated,
      traceProposalsCreated: proposals.traceProposalsCreated,
      checkpoint
    };
  }

  /**
   * Explicit one-shot compatibility drain. Zero thresholds intentionally skip
   * the daemon's quiet/hourly timing gate while retaining staged, guarded,
   * proposed-only publication through ProposalScheduler.
   */
  async drainProposals(
    personId: string,
    selectedAuthority?: WriteAuthority
  ): Promise<{
    boxProposalsCreated: number;
    traceProposalsCreated: number;
  }> {
    const authority = selectedAuthority ?? this.compatibilityAuthority(personId);
    const scheduler = this.options.proposalSchedulerFactory?.({
      store: this.store,
      authority,
      clock: this.clock
    }) ?? new ProposalScheduler(this.store, {
      authority,
      clock: { now: this.clock },
      quietMs: 0,
      forcedMs: 0
    });
    const result = await scheduler.runDue(personId);
    return {
      boxProposalsCreated: result.boxProposals,
      traceProposalsCreated: result.traceProposals
    };
  }

  private compatibilityAuthority(personId: string): WriteAuthority {
    const parsed = WriteAuthoritySchema.safeParse(
      this.options.authority ?? {
        kind: "foreground",
        personId,
        operation: "historical-bootstrap"
      }
    );
    if (!parsed.success || parsed.data.kind !== "foreground" ||
        parsed.data.personId !== personId ||
        parsed.data.operation !== "historical-bootstrap") {
      throw new Error("Historical bootstrap requires exact person historical-bootstrap authority");
    }
    return parsed.data;
  }

  private async ensureContractionJob(
    personId: string,
    events: CanonicalEvent[]
  ): Promise<ContractionJob | null> {
    const jobId = historicalContractionJobId(personId);
    const existing = await this.store.getContractionJob(jobId);
    const checkpoint = await this.store.getContractionCheckpoint(
      `contraction_checkpoint_${jobId}`
    );
    const turns = await this.store.listTurns(`person:${personId}`);
    const turnsByEvent = new Map(
      turns.map((turn) => [String(turn.metadata.canonicalEventId), turn])
    );
    const eventIds = new Set(events.map((event) => event.id));
    const removedTurnExists = turns.some(
      (turn) => !eventIds.has(String(turn.metadata.canonicalEventId))
    );
    const changed = events.filter((event, index) => {
      const turn = turnsByEvent.get(event.id);
      return !turn || turn.contentHash !== event.contentHash || turn.sequence !== index + 1;
    });

    if (!existing && changed.length === 0) return null;
    if (existing && !existing.immediateDirty && existing.state === "complete" &&
        changed.length === 0 && !removedTurnExists) {
      return null;
    }

    const affectedEvents = removedTurnExists ? events : changed;
    const earliestNew = orderKey(affectedEvents[0] ?? events[0]!);
    const latestNew = orderKey(affectedEvents.at(-1) ?? events.at(-1)!);
    const earliestAffected = existing && existing.immediateDirty
      ? minKey(existing.earliestAffected, earliestNew)
      : earliestNew;
    const latestAffected = existing
      ? maxKey(existing.latestAffected, latestNew)
      : latestNew;
    const rewindsProcessedWork = !!existing &&
      checkpoint?.generation === existing.generation &&
      checkpoint.processedThroughOrderKey !== null &&
      compareKeys(earliestAffected, checkpoint.processedThroughOrderKey) < 0;
    const now = this.clock();
    const next: ContractionJob = {
      id: jobId,
      personId,
      generation: existing
        ? existing.generation + (rewindsProcessedWork ? 1 : 0)
        : 1,
      earliestAffected,
      latestAffected,
      state: "pending",
      attempts: existing?.attempts ?? 0,
      immediateDirty: true,
      proposalDirty: true,
      lastProposalRunAt: existing?.lastProposalRunAt ?? null,
      lastActivityAt: now,
      nextDueAt: now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    await this.store.saveContractionJob(next);
    return next;
  }
}

function buildCompatibilityCheckpoint(
  personId: string,
  events: CanonicalEvent[],
  contraction: ContractionSliceResult["checkpoint"] | null,
  updatedAt: string
): HistoricalBootstrapCheckpoint {
  return {
    id: historicalBootstrapCheckpointId(personId),
    personId,
    processorVersion: PROCESSOR_VERSION,
    processedEventCount: events.length,
    lastCanonicalEventId: events.at(-1)?.id ?? null,
    rollingPrefixHash: hashPrefix(events),
    activeTopic: contraction?.activeTopic ?? null,
    updatedAt
  };
}

function emptyResult(checkpoint: HistoricalBootstrapCheckpoint): HistoricalBootstrapResult {
  return {
    reset: false,
    eventsProcessed: 0,
    summariesUpdated: 0,
    anchorsDetected: 0,
    boxProposalsCreated: 0,
    traceProposalsCreated: 0,
    checkpoint
  };
}

function hashPrefix(events: CanonicalEvent[]): string {
  return events.reduce(
    (hash, event) => createHash("sha256")
      .update(hash)
      .update("\0")
      .update(event.id)
      .digest("hex"),
    EMPTY_PREFIX_HASH
  );
}

function orderKey(event: CanonicalEvent): CanonicalOrderKey {
  return {
    occurredAt: event.occurredAt,
    nativeSequence: event.nativeSequence,
    id: event.id
  };
}

function compareKeys(left: CanonicalOrderKey, right: CanonicalOrderKey): number {
  return left.occurredAt.localeCompare(right.occurredAt) ||
    left.nativeSequence - right.nativeSequence ||
    left.id.localeCompare(right.id);
}

function minKey(left: CanonicalOrderKey, right: CanonicalOrderKey): CanonicalOrderKey {
  return compareKeys(left, right) <= 0 ? left : right;
}

function maxKey(left: CanonicalOrderKey, right: CanonicalOrderKey): CanonicalOrderKey {
  return compareKeys(left, right) >= 0 ? left : right;
}

export function historicalBootstrapCheckpointId(personId: string): string {
  return `bootstrap_${identityHash(personId)}`;
}

export function historicalContractionJobId(personId: string): string {
  return `contraction_${identityHash(JSON.stringify([personId]))}`;
}

function identityHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
