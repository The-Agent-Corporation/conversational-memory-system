import { describe, expect, it } from "vitest";
import { ProposalScheduler } from "../../src/daemon/proposal-scheduler.js";
import { SleepReviewer } from "../../src/sleep/sleep-reviewer.js";
import type { ContractionCheckpoint, ContractionJob, WriteAuthority } from "../../src/daemon/types.js";
import type { Person } from "../../src/domain/canonical.js";
import type { MemoryProposal, ProposalState, Summary } from "../../src/domain/types.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import { FIXED_NOW, FakeDaemonClock } from "./fixtures.js";

const PERSON_ID = "person_proposal";
const OTHER_PERSON_ID = "person_other";
const SCOPE_ID = "scope_allowed";
const JOB_ID = "job_proposal";
const CHECKPOINT_ID = `contraction_checkpoint_${JOB_ID}`;

describe("ProposalScheduler", () => {
  it("stages proposed person and scope owned review output before one guarded publication", async () => {
    const clock = new FakeDaemonClock();
    const store = await seededStore(clock);
    const before = await publicationSnapshot(store);
    let inspected = false;
    const scheduler = new ProposalScheduler(store, {
      clock,
      authority: foregroundAuthority(),
      beforeCommit: async (input) => {
        inspected = true;
        expect(await publicationSnapshot(store)).toEqual(before);
        expect(input.boxes.length + input.proposals.length).toBeGreaterThan(0);
        expect([...input.boxes, ...input.proposals, ...input.traces].every((item) =>
          item.state === "proposed" && item.personId === PERSON_ID
        )).toBe(true);
        expect(input.proposals.every((proposal) =>
          proposal.sourceSummaryIds.length > 0 && proposal.sourceSummaryIds.every((id) => id.startsWith("summary_owned_"))
        )).toBe(true);
      }
    });

    const result = await scheduler.runDue(PERSON_ID);

    expect(inspected).toBe(true);
    expect(result).toMatchObject({ ran: true });
    expect((await store.listProposals()).every((proposal) => proposal.state === "proposed")).toBe(true);
    expect((await store.listBoxes()).every((box) => box.state === "proposed")).toBe(true);
    expect(await store.getContractionJob(JOB_ID)).toMatchObject({
      proposalDirty: false,
      lastProposalRunAt: clock.now(),
      updatedAt: clock.now()
    });
    expect(await store.getContractionCheckpoint(CHECKPOINT_ID)).toMatchObject({
      proposalStage: "complete",
      updatedAt: clock.now()
    });
  });

  it("rejects token turnover with zero proposal or cadence mutation then replays once under the replacement owner", async () => {
    const clock = new FakeDaemonClock();
    const store = await seededStore(clock);
    await store.acquireDaemonLease({ databaseId: "memory-db", ownerToken: "token-a", pid: 100, now: clock.now() });
    const before = await publicationSnapshot(store);
    const oldOwner = new ProposalScheduler(store, {
      clock,
      authority: daemonAuthority("token-a"),
      beforeCommit: async () => {
        await store.releaseDaemonLease("memory-db", "token-a");
        await store.acquireDaemonLease({ databaseId: "memory-db", ownerToken: "token-b", pid: 101, now: clock.now() });
      }
    });

    await expect(oldOwner.runDue(PERSON_ID)).rejects.toThrow(/lease|owner|authority|stale/i);
    expect(await publicationSnapshot(store)).toEqual(before);

    const replacement = new ProposalScheduler(store, { clock, authority: daemonAuthority("token-b") });
    await expect(replacement.runDue(PERSON_ID)).resolves.toMatchObject({ ran: true });
    const published = await publicationSnapshot(store);
    expect(published.proposals.length).toBeGreaterThan(0);
    expect(new Set(published.proposals.map((item) => item.id)).size).toBe(published.proposals.length);
    await expect(replacement.runDue(PERSON_ID)).resolves.toEqual({
      boxProposals: 0,
      traceProposals: 0,
      ran: false
    });
    expect(await publicationSnapshot(store)).toEqual(published);
  });

  it("rejects expired authority and person or provenance mismatches before publication", async () => {
    const clock = new FakeDaemonClock();
    const store = await seededStore(clock);
    await store.acquireDaemonLease({ databaseId: "memory-db", ownerToken: "expired", pid: 100, now: clock.now() });
    clock.advanceBy(31_000);
    const before = await publicationSnapshot(store);

    await expect(new ProposalScheduler(store, {
      clock,
      authority: daemonAuthority("expired")
    }).runDue(PERSON_ID)).rejects.toThrow(/expired|stale|authority/i);
    expect(await publicationSnapshot(store)).toEqual(before);

    const invalidClock = new FakeDaemonClock();
    const invalidStore = await seededStore(invalidClock, { incompleteProvenance: true });
    await expect(new ProposalScheduler(invalidStore, {
      clock: invalidClock,
      authority: foregroundAuthority()
    }).runDue(PERSON_ID)).rejects.toThrow(/provenance|scope/i);
    expect((await invalidStore.listProposals()).length).toBe(0);

    await expect(new ProposalScheduler(store, {
      clock,
      authority: { kind: "foreground", personId: OTHER_PERSON_ID, operation: "historical-bootstrap" }
    }).runDue(PERSON_ID)).rejects.toThrow(/person|authority/i);
    expect(await publicationSnapshot(store)).toEqual(before);

    const mismatchClock = new FakeDaemonClock();
    const mismatchStore = await seededStore(mismatchClock);
    const mismatchBefore = await publicationSnapshot(mismatchStore);
    await expect(new ProposalScheduler(mismatchStore, {
      clock: mismatchClock,
      authority: foregroundAuthority(),
      beforeCommit: (input) => {
        input.nextJob = { ...input.nextJob, id: "job_mismatched" };
      }
    }).runDue(PERSON_ID)).rejects.toThrow(/job|ownership|mismatch/i);
    expect(await publicationSnapshot(mismatchStore)).toEqual(mismatchBefore);
  });

  it.each([
    ["approved state", "approved" as ProposalState, PERSON_ID, "summary_owned_0"],
    ["rejected state", "rejected" as ProposalState, PERSON_ID, "summary_owned_0"],
    ["foreign person", "proposed" as ProposalState, OTHER_PERSON_ID, "summary_owned_0"],
    ["foreign scope provenance", "proposed" as ProposalState, PERSON_ID, "summary_foreign"]
  ])("rejects %s staged output before authoritative publication", async (_label, state, personId, summaryId) => {
    const clock = new FakeDaemonClock();
    const store = await seededStore(clock);
    const before = await publicationSnapshot(store);
    await expect(new ProposalScheduler(store, {
      clock,
      authority: foregroundAuthority(),
      reviewerFactory: () => ({
        stageProposals: async () => ({
          boxes: [],
          proposals: [proposal(state, personId, summaryId)],
          traces: [],
          boxProposalCount: 1,
          traceProposalCount: 0
        })
      })
    }).runDue(PERSON_ID)).rejects.toThrow(/proposed|person|scope|provenance/i);
    expect(await publicationSnapshot(store)).toEqual(before);
  });

  /**
   * The daemon's staging store used to be a COPY of the whole derived corpus, so the reviewer could
   * read and write against an isolated store. On the live corpus that was 145,765 summaries plus
   * every box, anchor, proposal and trace -- materialised once out of SQLite and again by
   * `InMemoryStore`'s `structuredClone` on write -- measured at 1,089 MB of heap for a single call.
   * That is what exhausted the daemon: two OOM crashes in 25 minutes at a 4 GB limit.
   *
   * Staging exists to isolate WRITES, not reads. This pins that the reviewer reads durably and the
   * staging store only ever holds what the review produced, so its size tracks the output rather
   * than the corpus.
   */
  it("stages into an empty store rather than copying the corpus into it", async () => {
    const clock = new FakeDaemonClock();
    const store = await seededStore(clock);

    let stagingSummaryCount: number | null = null;
    let stagingWasWrittenTo = false;
    const scheduler = new ProposalScheduler(store, {
      clock,
      authority: foregroundAuthority(),
      reviewerFactory: (staging) => {
        // Observed at the moment the reviewer is constructed: before this change the staging store
        // already held every summary in the corpus.
        void (async () => { stagingSummaryCount = (await staging.listSummaries()).length; })();
        return new SleepReviewer(store, { writeStore: staging });
      },
      beforeCommit: async () => {
        stagingWasWrittenTo = true;
      }
    });

    const result = await scheduler.runDue(PERSON_ID);

    expect(result).toMatchObject({ ran: true });
    expect(stagingWasWrittenTo).toBe(true);
    expect(stagingSummaryCount).toBe(0);
  });

  /**
   * Reads move to the durable store, so the write isolation has to be re-proven: nothing the
   * reviewer produces may be visible in the durable store until `commitProposalRun` publishes it.
   */
  it("keeps reviewer writes out of the durable store until publication", async () => {
    const clock = new FakeDaemonClock();
    const store = await seededStore(clock);
    const before = await publicationSnapshot(store);

    let atCommit: Awaited<ReturnType<typeof publicationSnapshot>> | null = null;
    const scheduler = new ProposalScheduler(store, {
      clock,
      authority: foregroundAuthority(),
      beforeCommit: async () => { atCommit = await publicationSnapshot(store); }
    });

    await scheduler.runDue(PERSON_ID);

    // The reviewer wrote proposals and boxes; none of them reached the durable store early.
    expect(atCommit).toEqual(before);
  });

  /**
   * The reference check used to test membership against the in-memory corpus copy. It now resolves
   * each referenced id durably, which also lets it re-assert ownership and live state -- a proposal
   * citing a summary that does not exist, belongs to someone else, or has been superseded is
   * rejected rather than published.
   */
  it("rejects staged output citing a summary that is not a live person-owned summary", async () => {
    const clock = new FakeDaemonClock();
    const store = await seededStore(clock);
    const superseded = (await store.listSummaries())[0]!;
    await store.saveSummary({ ...superseded, state: "superseded" });

    const scheduler = new ProposalScheduler(store, {
      clock,
      authority: foregroundAuthority(),
      reviewerFactory: (staging) => ({
        stageProposals: async () => ({
          boxes: [],
          proposals: [proposal("proposed", PERSON_ID, superseded.id)],
          traces: [],
          boxProposalCount: 1,
          traceProposalCount: 0
        })
      }) as never
    });

    await expect(scheduler.runDue(PERSON_ID)).rejects.toThrow(/scope-mismatched or provenance-incomplete/i);
  });
});

async function seededStore(
  clock: FakeDaemonClock,
  options: { incompleteProvenance?: boolean } = {}
): Promise<InMemoryStore> {
  const store = new InMemoryStore({ clock });
  const person: Person = { id: PERSON_ID, displayName: null, createdAt: FIXED_NOW };
  await store.savePerson(person);
  for (const summary of summaries(options.incompleteProvenance ?? false)) await store.saveSummary(summary);
  await store.saveContractionJob(job());
  await store.saveContractionCheckpoint(checkpoint());
  clock.advanceBy(10 * 60_000);
  return store;
}

function summaries(incompleteProvenance: boolean): Summary[] {
  return [0, 1].map((index) => ({
    id: `summary_owned_${index}`,
    personId: PERSON_ID,
    scopeIds: incompleteProvenance && index === 1 ? [] : [SCOPE_ID],
    origin: "historical_bootstrap",
    summaryText: `Alpha roadmap planning milestone ${index}`,
    sourceTurnRanges: [{ threadId: `person:${PERSON_ID}`, startSequence: index * 3 + 1, endSequence: index * 3 + 1 }],
    sourceCanonicalEventIds: incompleteProvenance && index === 1 ? [] : [`event_owned_${index}`],
    sourceSummaryIds: [],
    boxIds: [],
    embedding: null,
    createdAt: new Date(Date.parse(FIXED_NOW) + index * 60_000).toISOString(),
    model: "deterministic",
    promptVersion: "test/v1",
    confidence: 0.9,
    state: "compacted",
    detailLevel: "brief",
    tokenCount: 8,
    lastAccessedAt: null,
    version: 1,
    strength: 0.5,
    retrievalCount: 0,
    retrievedAt: null,
    halfLifeHours: 168,
    outcomeScore: null
  }));
}

function job(): ContractionJob {
  const key = { occurredAt: FIXED_NOW, nativeSequence: 1, id: "event_owned_0" };
  return {
    id: JOB_ID,
    personId: PERSON_ID,
    generation: 1,
    earliestAffected: key,
    latestAffected: key,
    state: "complete",
    attempts: 0,
    immediateDirty: false,
    proposalDirty: true,
    lastProposalRunAt: null,
    lastActivityAt: FIXED_NOW,
    nextDueAt: FIXED_NOW,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW
  };
}

function checkpoint(): ContractionCheckpoint {
  const key = { occurredAt: FIXED_NOW, nativeSequence: 1, id: "event_owned_0" };
  return {
    id: CHECKPOINT_ID,
    personId: PERSON_ID,
    jobId: JOB_ID,
    processorVersion: "contraction/v1",
    generation: 1,
    processedThroughOrderKey: key,
    nextOrderKey: null,
    nextEventId: null,
    activeTopic: null,
    sliceCount: 1,
    immediateStage: "complete",
    proposalStage: "pending",
    pendingToolRun: null,
    updatedAt: FIXED_NOW
  };
}

function proposal(state: ProposalState, personId: string, summaryId: string): MemoryProposal {
  const range = { threadId: `person:${PERSON_ID}`, startSequence: 1, endSequence: 1 };
  return {
    id: `proposal_${state}_${personId}_${summaryId}`,
    personId,
    proposalType: "box",
    state,
    title: "Alpha roadmap",
    rationale: "Synthetic review output",
    confidence: 0.8,
    createdAt: FIXED_NOW,
    reviewedAt: FIXED_NOW,
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    sourceSummaryIds: [summaryId],
    sourceTurnRanges: [range],
    targetBoxIds: ["box_alpha"],
    targetTraceIds: [],
    payload: {
      boxId: "box_alpha",
      title: "Alpha roadmap",
      description: "Synthetic staged box",
      summary: "Synthetic staged summary",
      boxType: "topic",
      candidateParentBoxId: null,
      keywords: ["alpha", "roadmap"],
      evidence: ["Synthetic evidence"],
      sourceSummaryIds: [summaryId],
      sourceTurnRanges: [range]
    }
  };
}

function daemonAuthority(ownerToken: string): WriteAuthority {
  return { kind: "daemon", databaseId: "memory-db", ownerToken };
}

function foregroundAuthority(): WriteAuthority {
  return { kind: "foreground", personId: PERSON_ID, operation: "historical-bootstrap" };
}

async function publicationSnapshot(store: InMemoryStore) {
  return {
    boxes: await store.listBoxes(),
    traces: await store.listTraces(),
    proposals: await store.listProposals(),
    job: await store.getContractionJob(JOB_ID),
    checkpoint: await store.getContractionCheckpoint(CHECKPOINT_ID)
  };
}
