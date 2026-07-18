import {
  BoxProposalPayloadSchema,
  ParentChildProposalPayloadSchema,
  TraceProposalPayloadSchema,
  type Box,
  type MemoryProposal,
  type MemoryTrace,
  type ProposalState,
  type ProposalType,
  type Summary
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
      if (await this.isAuthorized(proposal)) authorized.push(proposal);
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
    if (!proposal || proposal.state !== "proposed" || !await this.isAuthorized(proposal)) {
      throw new ScopedProposalError();
    }

    const nextBoxes: Box[] = [];
    const nextTraces: MemoryTrace[] = [];
    if (request.decision === "approve") {
      if (proposal.proposalType === "box") {
        const payload = BoxProposalPayloadSchema.parse(proposal.payload);
        const existing = await this.store.getBox(payload.boxId);
        const parent = payload.candidateParentBoxId ? await this.store.getBox(payload.candidateParentBoxId) : null;
        if (parent && !await this.authorizeSummaryIds(parent.summaryIds)) throw new ScopedProposalError();
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
        const payload = ParentChildProposalPayloadSchema.parse(proposal.payload);
        const [parent, child] = await Promise.all([this.store.getBox(payload.parentBoxId), this.store.getBox(payload.childBoxId)]);
        if (!parent || !child || parent.personId !== this.authority.personId || child.personId !== this.authority.personId ||
            !await this.authorizeSummaryIds([...parent.summaryIds, ...child.summaryIds])) throw new ScopedProposalError();
        nextBoxes.push(
          { ...parent, childBoxIds: parent.childBoxIds.includes(child.id) ? parent.childBoxIds : [...parent.childBoxIds, child.id], updatedAt: request.decidedAt },
          { ...child, parentBoxId: parent.id, updatedAt: request.decidedAt }
        );
      } else {
        const payload = TraceProposalPayloadSchema.parse(proposal.payload);
        const existing = await this.store.getTrace(payload.traceId);
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

  private async isAuthorized(proposal: MemoryProposal): Promise<boolean> {
    if (proposal.personId !== this.authority.personId) return false;
    const dependencyIds = new Set(proposal.sourceSummaryIds);
    for (const boxId of proposal.targetBoxIds) {
      const box = await this.store.getBox(boxId);
      if (!box || box.personId !== this.authority.personId) return false;
      box.summaryIds.forEach((id) => dependencyIds.add(id));
    }
    for (const traceId of proposal.targetTraceIds) {
      const trace = await this.store.getTrace(traceId);
      if (!trace || trace.personId !== this.authority.personId) return false;
      trace.summaryIds.forEach((id) => dependencyIds.add(id));
    }
    return this.authorizeSummaryIds([...dependencyIds]);
  }

  private async authorizeSummaryIds(summaryIds: readonly string[]): Promise<boolean> {
    const summaries = new Map((await this.store.listSummaries()).map((summary) => [summary.id, summary]));
    const allowedScopes = new Set(this.authority.allowedScopeIds);
    const seen = new Set<string>();
    const visit = (id: string): boolean => {
      if (seen.has(id)) return true;
      const summary: Summary | undefined = summaries.get(id);
      if (!summary || summary.personId !== this.authority.personId || summary.state === "superseded" ||
          !(summary.scopeIds ?? []).every((scopeId) => allowedScopes.has(scopeId))) return false;
      seen.add(id);
      return summary.sourceSummaryIds.every(visit);
    };
    return summaryIds.every(visit);
  }
}
