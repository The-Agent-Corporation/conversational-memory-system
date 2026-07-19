import {
  BoxProposalPayloadSchema,
  ParentChildProposalPayloadSchema,
  TraceProposalPayloadSchema,
  type Box,
  type BoxProposalPayload,
  type MemoryProposal,
  type MemoryTrace,
  type ParentChildProposalPayload,
  type ProposalState,
  type ProposalType,
  type Summary,
  type TraceProposalPayload
} from "../domain/types.js";
import type { ProfileAuthority } from "../mcp/authority.js";
import {
  CommitProposalDecisionInputSchema,
  mutationEffectsFingerprint,
  type CommitProposalDecisionInput
} from "../storage/mcp-mutation-contracts.js";
import type { MemoryStore } from "../storage/memory-store.js";
import type { ProposalListItem } from "./proposal-reviewer.js";

export class ScopedProposalError extends Error {
  readonly code = "UNAUTHORIZED_OR_NOT_FOUND" as const;

  constructor() {
    super("UNAUTHORIZED_OR_NOT_FOUND");
    this.name = "ScopedProposalError";
  }
}

const formatScopedProposal = (proposal: MemoryProposal, includePayload: boolean): ProposalListItem => ({
  id: proposal.id,
  proposalType: proposal.proposalType,
  state: proposal.state,
  title: proposal.title,
  rationale: proposal.rationale,
  confidence: proposal.confidence,
  createdAt: proposal.createdAt,
  reviewedAt: proposal.reviewedAt,
  sourceSummaryIds: proposal.sourceSummaryIds,
  targetBoxIds: proposal.targetBoxIds,
  targetTraceIds: proposal.targetTraceIds,
  ...(includePayload ? { payload: proposal.payload } : {})
});

export interface ScopedProposalListRequest {
  state?: ProposalState;
  proposalType?: ProposalType;
  limit?: number;
  includePayload?: boolean;
}

export interface ProposalDecisionPlanRequest {
  proposalId: string;
  decision: "approve" | "reject";
  decidedAt: string;
  reviewer?: string;
  note?: string;
}

export class ScopedProposalReviewer {
  constructor(
    private readonly store: MemoryStore,
    private readonly authority: ProfileAuthority
  ) {}

  async listProposals(request: ScopedProposalListRequest = {}): Promise<{ ok: true; proposals: ProposalListItem[]; count: number }> {
    const candidates = await this.store.listProposals({
      state: request.state ?? "proposed",
      proposalType: request.proposalType
    });
    const authorized: MemoryProposal[] = [];
    for (const proposal of candidates) {
      if (await this.authorizedClosure(proposal)) authorized.push(proposal);
    }
    const limited = authorized.slice(0, request.limit ?? 20);
    return {
      ok: true,
      proposals: limited.map((proposal) => formatScopedProposal(proposal, request.includePayload ?? false)),
      count: limited.length
    };
  }

  async planDecision(request: ProposalDecisionPlanRequest): Promise<CommitProposalDecisionInput> {
    const proposal = await this.store.getProposal(request.proposalId);
    const closure = proposal && proposal.state === "proposed"
      ? await this.authorizedClosure(proposal)
      : null;
    if (!proposal || proposal.state !== "proposed" || !closure) {
      throw new ScopedProposalError();
    }

    const nextBoxes: Box[] = [];
    const nextTraces: MemoryTrace[] = [];
    if (request.decision === "approve") {
      if (proposal.proposalType === "box") {
        const payload: BoxProposalPayload = BoxProposalPayloadSchema.parse(proposal.payload);
        const existing = closure.boxes.get(payload.boxId) ?? null;
        const parent = payload.candidateParentBoxId ? closure.boxes.get(payload.candidateParentBoxId) ?? null : null;
        nextBoxes.push({
          id: payload.boxId,
          personId: this.authority.personId,
          title: payload.title,
          description: payload.description,
          parentBoxId: parent?.id ?? null,
          childBoxIds: existing?.childBoxIds ?? [],
          summaryIds: payload.sourceSummaryIds,
          turnRanges: payload.sourceTurnRanges,
          state: "approved",
          createdAt: existing?.createdAt ?? request.decidedAt,
          updatedAt: request.decidedAt,
          caseId: existing?.caseId ?? null,
          boxType: payload.boxType,
          summary: payload.summary,
          lastActivityAt: request.decidedAt
        });
      } else if (proposal.proposalType === "box_parent_child") {
        const payload: ParentChildProposalPayload = ParentChildProposalPayloadSchema.parse(proposal.payload);
        const parent = closure.boxes.get(payload.parentBoxId) ?? null;
        const child = closure.boxes.get(payload.childBoxId) ?? null;
        if (!parent || !child) throw new ScopedProposalError();
        nextBoxes.push(
          { ...parent, childBoxIds: parent.childBoxIds.includes(child.id) ? parent.childBoxIds : [...parent.childBoxIds, child.id], updatedAt: request.decidedAt },
          { ...child, parentBoxId: parent.id, updatedAt: request.decidedAt }
        );
      } else {
        const payload: TraceProposalPayload = TraceProposalPayloadSchema.parse(proposal.payload);
        const existing = closure.traces.get(payload.traceId) ?? null;
        nextTraces.push({
          id: payload.traceId,
          personId: this.authority.personId,
          title: payload.title,
          description: payload.description,
          traceType: payload.traceType,
          state: "approved",
          summaryIds: payload.summaryIds,
          boxIds: payload.boxIds,
          turnRanges: payload.turnRanges,
          createdAt: existing?.createdAt ?? request.decidedAt,
          updatedAt: request.decidedAt,
          lastActivityAt: request.decidedAt,
          confidence: proposal.confidence,
          rationale: proposal.rationale
        });
      }
    }

    const nextProposal: MemoryProposal = {
      ...proposal,
      state: request.decision === "approve" ? "approved" : "rejected",
      decidedAt: request.decidedAt,
      decidedBy: request.reviewer ?? null,
      decisionNote: request.note ?? null
    };
    const effects = {
      proposalIds: [proposal.id],
      boxIds: nextBoxes.map((item) => item.id),
      traceIds: nextTraces.map((item) => item.id)
    };
    return CommitProposalDecisionInputSchema.parse({
      operation: "proposal_decision",
      personId: this.authority.personId,
      decision: request.decision,
      allowedScopeIds: [...this.authority.allowedScopeIds].sort(),
      expectedSummaries: closure.expectedSummaries,
      expectedBoxes: closure.expectedBoxes,
      expectedTraces: closure.expectedTraces,
      expectedProposal: proposal,
      nextProposal,
      nextBoxes,
      nextTraces,
      effects,
      effectsFingerprint: mutationEffectsFingerprint(effects),
      receipt: {
        operation: "proposal_decision",
        status: "COMMITTED",
        personId: this.authority.personId,
        targetId: proposal.id,
        effectCounts: { proposals: 1, boxes: nextBoxes.length, traces: nextTraces.length },
        committedAt: request.decidedAt
      }
    });
  }

  private async authorizedClosure(proposal: MemoryProposal): Promise<{
    expectedSummaries: Summary[];
    expectedBoxes: Array<{ id: string; value: Box | null }>;
    expectedTraces: Array<{ id: string; value: MemoryTrace | null }>;
    boxes: Map<string, Box>;
    traces: Map<string, MemoryTrace>;
  } | null> {
    if (proposal.personId !== this.authority.personId) return null;

    const summaryIds = new Set(proposal.sourceSummaryIds);
    const boxIds = new Set(proposal.targetBoxIds);
    const traceIds = new Set(proposal.targetTraceIds);
    const requiredBoxIds = new Set<string>();
    if (proposal.proposalType === "box") {
      const payload = BoxProposalPayloadSchema.safeParse(proposal.payload);
      if (!payload.success) return null;
      payload.data.sourceSummaryIds.forEach((id) => summaryIds.add(id));
      boxIds.add(payload.data.boxId);
      if (payload.data.candidateParentBoxId) {
        boxIds.add(payload.data.candidateParentBoxId);
        requiredBoxIds.add(payload.data.candidateParentBoxId);
      }
    } else if (proposal.proposalType === "box_parent_child") {
      const payload = ParentChildProposalPayloadSchema.safeParse(proposal.payload);
      if (!payload.success) return null;
      payload.data.sourceSummaryIds.forEach((id) => summaryIds.add(id));
      boxIds.add(payload.data.parentBoxId);
      boxIds.add(payload.data.childBoxId);
      requiredBoxIds.add(payload.data.parentBoxId);
      requiredBoxIds.add(payload.data.childBoxId);
    } else {
      const payload = TraceProposalPayloadSchema.safeParse(proposal.payload);
      if (!payload.success) return null;
      payload.data.summaryIds.forEach((id) => summaryIds.add(id));
      payload.data.boxIds.forEach((id) => {
        boxIds.add(id);
        requiredBoxIds.add(id);
      });
      traceIds.add(payload.data.traceId);
    }

    const allSummaries = new Map((await this.store.listSummaries()).map((item) => [item.id, item]));
    const allBoxes = new Map((await this.store.listBoxes()).map((item) => [item.id, item]));
    const allTraces = new Map((await this.store.listTraces()).map((item) => [item.id, item]));
    const visitedBoxes = new Set<string>();
    const visitBox = (id: string): boolean => {
      if (visitedBoxes.has(id)) return !requiredBoxIds.has(id) || allBoxes.has(id);
      visitedBoxes.add(id);
      const box = allBoxes.get(id);
      if (!box) return !requiredBoxIds.has(id);
      if (box.personId !== this.authority.personId) return false;
      box.summaryIds.forEach((summaryId) => summaryIds.add(summaryId));
      if (box.parentBoxId) {
        boxIds.add(box.parentBoxId);
        requiredBoxIds.add(box.parentBoxId);
        if (!visitBox(box.parentBoxId)) return false;
      }
      for (const childId of box.childBoxIds) {
        boxIds.add(childId);
        requiredBoxIds.add(childId);
        if (!visitBox(childId)) return false;
      }
      return true;
    };
    for (const id of [...boxIds]) if (!visitBox(id)) return null;

    for (const id of [...traceIds]) {
      const trace = allTraces.get(id);
      if (!trace) continue;
      if (trace.personId !== this.authority.personId) return null;
      trace.summaryIds.forEach((summaryId) => summaryIds.add(summaryId));
      for (const boxId of trace.boxIds) {
        boxIds.add(boxId);
        requiredBoxIds.add(boxId);
        if (!visitBox(boxId)) return null;
      }
    }

    const allowedScopes = new Set(this.authority.allowedScopeIds);
    const visitedSummaries = new Set<string>();
    const visitSummary = (id: string): boolean => {
      if (visitedSummaries.has(id)) return true;
      const summary = allSummaries.get(id);
      if (!summary || summary.personId !== this.authority.personId || summary.state === "superseded" ||
          summary.scopeIds === undefined || summary.scopeIds.some((scopeId) => !allowedScopes.has(scopeId))) return false;
      visitedSummaries.add(id);
      for (const sourceId of summary.sourceSummaryIds) {
        summaryIds.add(sourceId);
        if (!visitSummary(sourceId)) return false;
      }
      return true;
    };
    for (const id of [...summaryIds]) if (!visitSummary(id)) return null;

    const sortedSummaryIds = [...summaryIds].sort();
    const sortedBoxIds = [...boxIds].sort();
    const sortedTraceIds = [...traceIds].sort();
    return {
      expectedSummaries: sortedSummaryIds.map((id) => allSummaries.get(id)!),
      expectedBoxes: sortedBoxIds.map((id) => ({ id, value: allBoxes.get(id) ?? null })),
      expectedTraces: sortedTraceIds.map((id) => ({ id, value: allTraces.get(id) ?? null })),
      boxes: allBoxes,
      traces: allTraces
    };
  }
}
