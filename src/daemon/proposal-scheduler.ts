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
    const { staging, summaries } = await this.createStagingStore(personId);
    const reviewer = this.options.reviewerFactory?.(staging) ?? new SleepReviewer(staging);
    const staged = await reviewer.stageProposals({ personId, reviewedAt });
    validateStagedReview(personId, staged, summaries);
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

  private async createStagingStore(personId: string): Promise<{ staging: InMemoryStore; summaries: Summary[] }> {
    const person = await this.store.getPerson(personId);
    if (!person) throw new Error(`Cannot stage proposals for unknown person ${personId}`);
    const [allSummaries, allBoxes, allAnchors, allProposals, allTraces] = await Promise.all([
      this.store.listSummaries(),
      this.store.listBoxes(),
      this.store.listAnchors(),
      this.store.listProposals({ state: "proposed" }),
      this.store.listTraces()
    ]);
    const summaries = allSummaries.filter((item) => item.personId === personId && item.state !== "superseded");
    assertCompleteSummaryProvenance(summaries);
    const staging = new InMemoryStore({ clock: this.clock });
    await staging.savePerson(person);
    for (const summary of summaries) await staging.saveSummary(summary);
    for (const box of allBoxes.filter((item) => item.personId === personId)) await staging.saveBox(box);
    for (const anchor of allAnchors.filter((item) => item.personId === personId)) await staging.saveAnchor(anchor);
    for (const proposal of allProposals.filter((item) => item.personId === personId)) await staging.saveProposal(proposal);
    for (const trace of allTraces.filter((item) => item.personId === personId)) await staging.saveTrace(trace);
    return { staging, summaries };
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
}

function assertCompleteSummaryProvenance(summaries: Summary[]): void {
  if (summaries.some((summary) =>
    !summary.personId || !summary.scopeIds?.length || !summary.sourceCanonicalEventIds?.length || summary.sourceTurnRanges.length === 0
  )) {
    throw new Error("Proposal staging requires complete person, scope, and canonical provenance");
  }
}

function validateStagedReview(personId: string, staged: StagedSleepReviewResult, summaries: Summary[]): void {
  const summaryIds = new Set(summaries.map((summary) => summary.id));
  const outputs: Array<Box | MemoryProposal | MemoryTrace> = [...staged.boxes, ...staged.proposals, ...staged.traces];
  if (outputs.some((item) => item.state !== "proposed" || item.personId !== personId)) {
    throw new Error("Proposal scheduler accepts only proposed person-owned review objects");
  }
  const referencedSummaryIds = [
    ...staged.boxes.flatMap((item) => item.summaryIds),
    ...staged.proposals.flatMap((item) => item.sourceSummaryIds),
    ...staged.traces.flatMap((item) => item.summaryIds)
  ];
  if ((outputs.length > 0 && referencedSummaryIds.length === 0) || referencedSummaryIds.some((id) => !summaryIds.has(id))) {
    throw new Error("Proposal scheduler rejects scope-mismatched or provenance-incomplete review objects");
  }
}
