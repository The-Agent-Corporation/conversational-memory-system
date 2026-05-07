import { describe, expect, it } from "vitest";
import type { Box, MemoryProposal, MemoryTrace } from "../../src/domain/types.js";
import { ProposalReviewer } from "../../src/proposals/proposal-reviewer.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";

const turnRange = { threadId: "profile:default", startSequence: 1, endSequence: 3 };

const box = (overrides: Partial<Box> = {}): Box => ({
  id: "box_case_smith",
  title: "Smith",
  description: "Smith case.",
  parentBoxId: null,
  childBoxIds: [],
  summaryIds: ["summary_case"],
  turnRanges: [turnRange],
  state: "approved",
  createdAt: "2026-05-07T12:00:00.000Z",
  updatedAt: "2026-05-07T12:00:00.000Z",
  caseId: "smith",
  boxType: "case",
  summary: "Smith case overview.",
  lastActivityAt: "2026-05-07T12:00:00.000Z",
  ...overrides
});

const boxProposal = (overrides: Partial<MemoryProposal> = {}): MemoryProposal => ({
  id: "proposal_box_box_topic_smith_pip",
  proposalType: "box",
  state: "proposed",
  title: "Smith PIP",
  rationale: "Two summaries share Smith PIP.",
  confidence: 0.75,
  createdAt: "2026-05-07T12:00:00.000Z",
  reviewedAt: "2026-05-07T12:00:00.000Z",
  decidedAt: null,
  decidedBy: null,
  decisionNote: null,
  sourceSummaryIds: ["summary_1", "summary_2"],
  sourceTurnRanges: [turnRange],
  targetBoxIds: ["box_topic_smith_pip"],
  targetTraceIds: [],
  payload: {
    boxId: "box_topic_smith_pip",
    title: "Smith PIP",
    description: "Proposed Smith PIP topic box.",
    summary: "Smith PIP provider bill review.",
    boxType: "topic",
    candidateParentBoxId: null,
    keywords: ["smith", "pip"],
    evidence: ["Shared keywords: smith, pip"],
    sourceSummaryIds: ["summary_1", "summary_2"],
    sourceTurnRanges: [turnRange]
  },
  ...overrides
});

const parentChildProposal = (overrides: Partial<MemoryProposal> = {}): MemoryProposal => ({
  id: "proposal_parent_child_box_case_smith_box_topic_smith_pip",
  proposalType: "box_parent_child",
  state: "proposed",
  title: "Smith PIP parent assignment",
  rationale: "Smith PIP is a subtopic of Smith.",
  confidence: 0.7,
  createdAt: "2026-05-07T12:00:00.000Z",
  reviewedAt: "2026-05-07T12:00:00.000Z",
  decidedAt: null,
  decidedBy: null,
  decisionNote: null,
  sourceSummaryIds: ["summary_1"],
  sourceTurnRanges: [turnRange],
  targetBoxIds: ["box_case_smith", "box_topic_smith_pip"],
  targetTraceIds: [],
  payload: {
    parentBoxId: "box_case_smith",
    childBoxId: "box_topic_smith_pip",
    relationshipLabel: "case subtopic",
    rationale: "Smith PIP is narrower than Smith.",
    sourceSummaryIds: ["summary_1"]
  },
  ...overrides
});

const traceProposal = (overrides: Partial<MemoryProposal> = {}): MemoryProposal => ({
  id: "proposal_trace_trace_smith_pip_provider_bill",
  proposalType: "trace",
  state: "proposed",
  title: "Smith PIP Provider Bill",
  rationale: "Summaries continue provider bill review.",
  confidence: 0.8,
  createdAt: "2026-05-07T12:00:00.000Z",
  reviewedAt: "2026-05-07T12:00:00.000Z",
  decidedAt: null,
  decidedBy: null,
  decisionNote: null,
  sourceSummaryIds: ["summary_1", "summary_3"],
  sourceTurnRanges: [turnRange],
  targetBoxIds: ["box_topic_smith_pip"],
  targetTraceIds: ["trace_smith_pip_provider_bill"],
  payload: {
    traceId: "trace_smith_pip_provider_bill",
    title: "Smith PIP Provider Bill",
    description: "Smith PIP provider bill review continuation.",
    traceType: "case_issue",
    summaryIds: ["summary_1", "summary_3"],
    boxIds: ["box_topic_smith_pip"],
    turnRanges: [turnRange],
    continuityReason: "Both summaries discuss provider bills.",
    boundaryReason: "BI summaries excluded.",
    keywords: ["smith", "pip", "provider", "bill"]
  },
  ...overrides
});

const trace = (overrides: Partial<MemoryTrace> = {}): MemoryTrace => ({
  id: "trace_existing",
  title: "Existing trace",
  description: "Existing trace.",
  traceType: "case_issue",
  state: "approved",
  summaryIds: ["summary_a", "summary_b"],
  boxIds: [],
  turnRanges: [turnRange],
  createdAt: "2026-05-07T12:00:00.000Z",
  updatedAt: "2026-05-07T12:00:00.000Z",
  lastActivityAt: "2026-05-07T12:00:00.000Z",
  confidence: 0.7,
  rationale: "Existing.",
  ...overrides
});

describe("ProposalReviewer", () => {
  it("lists proposed proposals by default", async () => {
    const store = new InMemoryStore();
    await store.saveProposal(boxProposal());
    await store.saveProposal(traceProposal({ id: "proposal_rejected", state: "rejected" }));
    const reviewer = new ProposalReviewer(store);

    const result = await reviewer.listProposals({});

    expect(result.count).toBe(1);
    expect(result.proposals[0]).toMatchObject({ id: "proposal_box_box_topic_smith_pip", state: "proposed" });
  });

  it("lists payloads only when requested", async () => {
    const store = new InMemoryStore();
    await store.saveProposal(boxProposal());
    const reviewer = new ProposalReviewer(store);

    expect((await reviewer.listProposals({})).proposals[0]).not.toHaveProperty("payload");
    expect((await reviewer.listProposals({ includePayload: true })).proposals[0]).toHaveProperty("payload");
  });

  it("approves a box proposal and creates an approved box", async () => {
    const store = new InMemoryStore();
    await store.saveProposal(boxProposal());
    const reviewer = new ProposalReviewer(store);

    const result = await reviewer.approveProposal({
      proposalId: "proposal_box_box_topic_smith_pip",
      decidedAt: "2026-05-07T14:00:00.000Z",
      reviewer: "aaron",
      note: "Looks right."
    });

    expect(result.createdBoxIds).toEqual(["box_topic_smith_pip"]);
    expect(await store.getBox("box_topic_smith_pip")).toEqual(expect.objectContaining({
      state: "approved",
      summaryIds: ["summary_1", "summary_2"]
    }));
    expect(await store.getProposal("proposal_box_box_topic_smith_pip")).toEqual(expect.objectContaining({
      state: "approved",
      decidedAt: "2026-05-07T14:00:00.000Z",
      decidedBy: "aaron",
      decisionNote: "Looks right."
    }));
  });

  it("approves a parent-child proposal and updates both boxes", async () => {
    const store = new InMemoryStore();
    await store.saveBox(box());
    await store.saveBox(box({ id: "box_topic_smith_pip", title: "Smith PIP", boxType: "topic", summary: "Smith PIP" }));
    await store.saveProposal(parentChildProposal());
    const reviewer = new ProposalReviewer(store);

    const result = await reviewer.approveProposal({
      proposalId: "proposal_parent_child_box_case_smith_box_topic_smith_pip",
      decidedAt: "2026-05-07T14:00:00.000Z"
    });

    expect(result.updatedBoxIds).toEqual(["box_case_smith", "box_topic_smith_pip"]);
    const parent = await store.getBox("box_case_smith");
    const child = await store.getBox("box_topic_smith_pip");
    expect(parent?.childBoxIds).toEqual(["box_topic_smith_pip"]);
    expect(child?.parentBoxId).toBe("box_case_smith");
  });

  it("fails parent-child approval when either box is missing", async () => {
    const store = new InMemoryStore();
    await store.saveProposal(parentChildProposal());
    const reviewer = new ProposalReviewer(store);

    await expect(reviewer.approveProposal({
      proposalId: "proposal_parent_child_box_case_smith_box_topic_smith_pip",
      decidedAt: "2026-05-07T14:00:00.000Z"
    })).rejects.toThrow("Parent box box_case_smith was not found");
    await expect(store.getProposal("proposal_parent_child_box_case_smith_box_topic_smith_pip")).resolves.toEqual(parentChildProposal());
  });

  it("approves a trace proposal and creates an approved trace", async () => {
    const store = new InMemoryStore();
    await store.saveProposal(traceProposal());
    const reviewer = new ProposalReviewer(store);

    const result = await reviewer.approveProposal({
      proposalId: "proposal_trace_trace_smith_pip_provider_bill",
      decidedAt: "2026-05-07T14:00:00.000Z"
    });

    expect(result.createdTraceIds).toEqual(["trace_smith_pip_provider_bill"]);
    expect(await store.getTrace("trace_smith_pip_provider_bill")).toEqual(expect.objectContaining({
      state: "approved",
      summaryIds: ["summary_1", "summary_3"]
    }));
  });

  it("rejects a proposal without mutating boxes or traces", async () => {
    const store = new InMemoryStore();
    await store.saveProposal(traceProposal());
    await store.saveTrace(trace());
    const reviewer = new ProposalReviewer(store);

    const result = await reviewer.rejectProposal({
      proposalId: "proposal_trace_trace_smith_pip_provider_bill",
      decidedAt: "2026-05-07T14:00:00.000Z",
      note: "Too broad."
    });

    expect(result).toEqual({
      ok: true,
      proposalId: "proposal_trace_trace_smith_pip_provider_bill",
      proposalType: "trace",
      rejectedAt: "2026-05-07T14:00:00.000Z",
      updatedProposalIds: ["proposal_trace_trace_smith_pip_provider_bill"]
    });
    expect(await store.getTrace("trace_existing")).toEqual(trace());
  });

  it("throws a clear error for missing proposals", async () => {
    const reviewer = new ProposalReviewer(new InMemoryStore());

    await expect(reviewer.approveProposal({
      proposalId: "missing",
      decidedAt: "2026-05-07T14:00:00.000Z"
    })).rejects.toThrow("Proposal missing was not found");
  });

  it("throws a clear error for already decided proposals", async () => {
    const store = new InMemoryStore();
    await store.saveProposal(boxProposal({ state: "approved" }));
    const reviewer = new ProposalReviewer(store);

    await expect(reviewer.rejectProposal({
      proposalId: "proposal_box_box_topic_smith_pip",
      decidedAt: "2026-05-07T14:00:00.000Z"
    })).rejects.toThrow("Proposal proposal_box_box_topic_smith_pip is already approved");
  });
});
