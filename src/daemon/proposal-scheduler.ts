import type { Anchor, Box, MemoryProposal, MemoryTrace, Summary } from "../domain/types.js";
import { SleepReviewer, type StagedSleepReviewResult } from "../sleep/sleep-reviewer.js";
import { InMemoryStore } from "../storage/in-memory-store.js";
import type { MemoryStore } from "../storage/memory-store.js";
import type { CommitProposalRunInput, ContractionJob, WriteAuthority } from "./types.js";

export const DEFAULT_PROPOSAL_INTERVALS = Object.freeze({ quietMs: 10 * 60_000, forcedMs: 60 * 60_000 });

export interface ProposalClock { now(): string }

interface ProposalReviewer {
  stageProposals(request: { personId: string; reviewedAt: string }): Promise<StagedSleepReviewResult>;
}

export interface ProposalSchedulerOptions {
  authority: WriteAuthority;
  clock?: ProposalClock;
  quietMs?: number;
  forcedMs?: number;
  beforeCommit?: (input: CommitProposalRunInput) => void | Promise<void>;
  reviewerFactory?: (store: MemoryStore) => ProposalReviewer;
}

export class ProposalScheduler {
  private readonly clock: ProposalClock;

  constructor(
    private readonly store: MemoryStore,
    private readonly options: ProposalSchedulerOptions
  ) {
    this.clock = options.clock ?? { now: () => new Date().toISOString() };
    this.quietMs = options.quietMs ?? DEFAULT_PROPOSAL_INTERVALS.quietMs;
    this.forcedMs = options.forcedMs ?? DEFAULT_PROPOSAL_INTERVALS.forcedMs;
  }

  private readonly quietMs: number;
  private readonly forcedMs: number;

  async isDue(personId: string): Promise<boolean> {
    return (await this.dueJobs(personId, this.clock.now())).length > 0;
  }

  async runDue(personId: string): Promise<{ boxProposals: number; traceProposals: number; ran: boolean }> {
    const reviewedAt = this.clock.now();
    const dueJobs = await this.dueJobs(personId, reviewedAt);
    if (dueJobs.length === 0) return { boxProposals: 0, traceProposals: 0, ran: false };
    const job = dueJobs[0]!;
    const staging = await this.createStagingStore(personId);
    const reviewer = this.options.reviewerFactory?.(staging)
      ?? new SleepReviewer(this.store, { writeStore: staging });
    const staged = await reviewer.stageProposals({ personId, reviewedAt });
    await this.validateStagedReview(personId, staged);
    const expectedCheckpoint = await this.store.getContractionCheckpoint(`contraction_checkpoint_${job.id}`);
    const nextJob: ContractionJob = {
      ...job,
      proposalDirty: false,
      lastProposalRunAt: reviewedAt,
      updatedAt: reviewedAt
    };
    const nextCheckpoint = expectedCheckpoint
      ? { ...expectedCheckpoint, proposalStage: "complete" as const, updatedAt: reviewedAt }
      : null;
    const input: CommitProposalRunInput = {
      authority: this.options.authority,
      personId,
      jobId: job.id,
      expectedJob: job,
      expectedCheckpoint,
      boxes: staged.boxes,
      proposals: staged.proposals,
      traces: staged.traces,
      nextJob,
      nextCheckpoint
    };
    await this.options.beforeCommit?.(input);
    await this.store.commitProposalRun(input);
    return {
      boxProposals: staged.boxProposalCount,
      traceProposals: staged.traceProposalCount,
      ran: true
    };
  }

  /**
   * An EMPTY staging store, sized by the review's output rather than by the corpus.
   *
   * This used to copy the whole derived corpus in so the reviewer could both read and write against
   * an isolated store. On the live corpus that was 145,765 summaries plus every box, anchor,
   * proposal and trace, each materialised once out of SQLite and again by `InMemoryStore`'s
   * `structuredClone` on write: measured at 1,089 MB of heap for ONE call, which is what exhausted
   * the daemon (two OOM crashes in 25 minutes, at a 4 GB heap limit).
   *
   * The isolation that staging exists for is about WRITES -- nothing may become visible until
   * `commitProposalRun` publishes it atomically. So the reviewer now reads durably and writes here,
   * and this store holds only what the review produced.
   *
   * The person row is still copied because the reviewer's write path asserts person ownership
   * against the store it writes to.
   */
  private async createStagingStore(personId: string): Promise<InMemoryStore> {
    const person = await this.store.getPerson(personId);
    if (!person) throw new Error(`Cannot stage proposals for unknown person ${personId}`);
    const staging = new InMemoryStore({ clock: this.clock });
    await staging.savePerson(person);
    return staging;
  }

  private async dueJobs(personId: string, nowAt: string) {
    const now = Date.parse(nowAt);
    return (await this.store.listContractionJobs(personId)).filter((job) => {
      if (!job.proposalDirty || job.immediateDirty || job.state !== "complete") return false;
      const quietDue = now - Date.parse(job.lastActivityAt) >= this.quietMs;
      const forceBaseline = job.lastProposalRunAt ?? job.createdAt;
      const forcedDue = now - Date.parse(forceBaseline) >= this.forcedMs;
      return quietDue || forcedDue;
    });
  }

  /**
   * Validates the staged output, resolving the summaries it REFERENCES rather than holding the
   * whole corpus.
   *
   * The reference check is unchanged in effect but stronger in one respect: it used to test
   * membership against an in-memory candidate set, and now resolves each referenced id durably and
   * re-asserts person ownership and non-superseded state at the same time. A proposal citing a
   * summary that does not exist, belongs to someone else, or has since been superseded fails here.
   *
   * The provenance assertion moved with it, and this is a deliberate narrowing: it used to run over
   * every candidate summary (145,765 rows on the live corpus, which is exactly the load being
   * removed) and now runs over the summaries the review actually cites. Those are the only ones
   * whose provenance can reach a published proposal.
   */
  private async validateStagedReview(personId: string, staged: StagedSleepReviewResult): Promise<void> {
    const outputs: Array<Box | MemoryProposal | MemoryTrace> = [...staged.boxes, ...staged.proposals, ...staged.traces];
    if (outputs.some((item) => item.state !== "proposed" || item.personId !== personId)) {
      throw new Error("Proposal scheduler accepts only proposed person-owned review objects");
    }
    const referencedSummaryIds = [
      ...staged.boxes.flatMap((item) => item.summaryIds),
      ...staged.proposals.flatMap((item) => item.sourceSummaryIds),
      ...staged.traces.flatMap((item) => item.summaryIds)
    ];
    if (outputs.length > 0 && referencedSummaryIds.length === 0) {
      throw new Error("Proposal scheduler rejects scope-mismatched or provenance-incomplete review objects");
    }
    const unique = [...new Set(referencedSummaryIds)];
    const resolved = await this.store.listSummariesByIds(unique);
    const usable = new Map(resolved
      .filter((summary) => summary.personId === personId && summary.state !== "superseded")
      .map((summary) => [summary.id, summary]));
    if (unique.some((id) => !usable.has(id))) {
      throw new Error("Proposal scheduler rejects scope-mismatched or provenance-incomplete review objects");
    }
    assertCompleteSummaryProvenance([...usable.values()]);
  }
}


function assertCompleteSummaryProvenance(summaries: Summary[]): void {
  if (summaries.some((summary) =>
    !summary.personId || !summary.scopeIds?.length || !summary.sourceCanonicalEventIds?.length || summary.sourceTurnRanges.length === 0
  )) {
    throw new Error("Proposal staging requires complete person, scope, and canonical provenance");
  }
}

