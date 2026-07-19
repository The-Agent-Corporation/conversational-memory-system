import {
  BoxProposalPayloadSchema,
  ParentChildProposalPayloadSchema,
  TraceProposalPayloadSchema,
  type Box,
  type JsonObject,
  type MemoryProposal,
  type MemoryTrace,
  type ProposalState,
  type ProposalType
} from "../domain/types.js";
import type { MemoryStore } from "../storage/memory-store.js";

export interface ProposalListRequest {
  state?: ProposalState;
  proposalType?: ProposalType;
  limit?: number;
  includePayload?: boolean;
}

export interface ProposalDecisionRequest {
  proposalId: string;
  decidedAt: string;
  reviewer?: string;
  note?: string;
}

export interface ProposalListItem {
  id: string;
  proposalType: ProposalType;
  state: ProposalState;
  title: string;
  rationale: string;
  confidence: number;
  createdAt: string;
  reviewedAt: string;
  sourceSummaryIds: string[];
  targetBoxIds: string[];
  targetTraceIds: string[];
  payload?: JsonObject;
}

export interface ProposalListResult {
  ok: true;
  proposals: ProposalListItem[];
  count: number;
}

export interface ProposalApprovalResult {
  ok: true;
  proposalId: string;
  proposalType: ProposalType;
  approvedAt: string;
  createdBoxIds: string[];
  updatedBoxIds: string[];
  createdTraceIds: string[];
  updatedProposalIds: string[];
}

export interface ProposalRejectionResult {
  ok: true;
  proposalId: string;
  proposalType: ProposalType;
  rejectedAt: string;
  updatedProposalIds: string[];
}

export class ProposalReviewer {
  constructor(private readonly store: MemoryStore) {}

  async listProposals(request: ProposalListRequest): Promise<ProposalListResult> {
    const proposals = await this.store.listProposals({
      state: request.state ?? "proposed",
      proposalType: request.proposalType
    });
    const limited = proposals.slice(0, request.limit ?? 20);

    return {
      ok: true,
      proposals: limited.map((proposal) => formatProposal(proposal, request.includePayload ?? false)),
      count: limited.length
    };
  }

  async approveProposal(request: ProposalDecisionRequest): Promise<ProposalApprovalResult> {
    const proposal = await this.loadProposed(request.proposalId);

    if (proposal.proposalType === "box") {
      return this.approveBoxProposal(proposal, request);
    }
    if (proposal.proposalType === "box_parent_child") {
      return this.approveParentChildProposal(proposal, request);
    }
    return this.approveTraceProposal(proposal, request);
  }

  async rejectProposal(request: ProposalDecisionRequest): Promise<ProposalRejectionResult> {
    const proposal = await this.loadProposed(request.proposalId);
    await this.store.saveProposal(markProposalDecided(proposal, "rejected", request));

    return {
      ok: true,
      proposalId: proposal.id,
      proposalType: proposal.proposalType,
      rejectedAt: request.decidedAt,
      updatedProposalIds: [proposal.id]
    };
  }

  private async approveBoxProposal(
    proposal: MemoryProposal,
    request: ProposalDecisionRequest
  ): Promise<ProposalApprovalResult> {
    const payload = BoxProposalPayloadSchema.parse(proposal.payload);
    const existing = await this.store.getBox(payload.boxId);
    const parentBoxId = payload.candidateParentBoxId && await this.store.getBox(payload.candidateParentBoxId)
      ? payload.candidateParentBoxId
      : null;
    const approvedBox: Box = {
      id: payload.boxId,
      ...(proposal.personId ? { personId: proposal.personId } : {}),
      title: payload.title,
      description: payload.description,
      parentBoxId,
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
    };

    await this.store.saveBox(approvedBox);
    await this.store.saveProposal(markProposalDecided(proposal, "approved", request));

    return {
      ok: true,
      proposalId: proposal.id,
      proposalType: proposal.proposalType,
      approvedAt: request.decidedAt,
      createdBoxIds: existing ? [] : [payload.boxId],
      updatedBoxIds: existing ? [payload.boxId] : [],
      createdTraceIds: [],
      updatedProposalIds: [proposal.id]
    };
  }

  private async approveParentChildProposal(
    proposal: MemoryProposal,
    request: ProposalDecisionRequest
  ): Promise<ProposalApprovalResult> {
    const payload = ParentChildProposalPayloadSchema.parse(proposal.payload);
    const parent = await this.store.getBox(payload.parentBoxId);
    if (!parent) {
      throw new Error(`Parent box ${payload.parentBoxId} was not found`);
    }
    const child = await this.store.getBox(payload.childBoxId);
    if (!child) {
      throw new Error(`Child box ${payload.childBoxId} was not found`);
    }
    if (parent.personId !== proposal.personId || child.personId !== proposal.personId) {
      throw new Error("Parent-child proposal crosses a person boundary");
    }

    await this.store.saveBox({
      ...parent,
      childBoxIds: parent.childBoxIds.includes(child.id)
        ? parent.childBoxIds
        : [...parent.childBoxIds, child.id],
      updatedAt: request.decidedAt
    });
    await this.store.saveBox({
      ...child,
      parentBoxId: parent.id,
      updatedAt: request.decidedAt
    });
    await this.store.saveProposal(markProposalDecided(proposal, "approved", request));

    return {
      ok: true,
      proposalId: proposal.id,
      proposalType: proposal.proposalType,
      approvedAt: request.decidedAt,
      createdBoxIds: [],
      updatedBoxIds: [parent.id, child.id],
      createdTraceIds: [],
      updatedProposalIds: [proposal.id]
    };
  }

  private async approveTraceProposal(
    proposal: MemoryProposal,
    request: ProposalDecisionRequest
  ): Promise<ProposalApprovalResult> {
    const payload = TraceProposalPayloadSchema.parse(proposal.payload);
    const existing = await this.store.getTrace(payload.traceId);
    const trace: MemoryTrace = {
      id: payload.traceId,
      ...(proposal.personId ? { personId: proposal.personId } : {}),
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
    };

    await this.store.saveTrace(trace);
    await this.store.saveProposal(markProposalDecided(proposal, "approved", request));

    return {
      ok: true,
      proposalId: proposal.id,
      proposalType: proposal.proposalType,
      approvedAt: request.decidedAt,
      createdBoxIds: [],
      updatedBoxIds: [],
      createdTraceIds: existing ? [] : [payload.traceId],
      updatedProposalIds: [proposal.id]
    };
  }

  private async loadProposed(proposalId: string): Promise<MemoryProposal> {
    const proposal = await this.store.getProposal(proposalId);
    if (!proposal) {
      throw new Error(`Proposal ${proposalId} was not found`);
    }
    if (proposal.state !== "proposed") {
      throw new Error(`Proposal ${proposalId} is already ${proposal.state}`);
    }
    return proposal;
  }
}

function formatProposal(proposal: MemoryProposal, includePayload: boolean): ProposalListItem {
  return {
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
  };
}

function markProposalDecided(
  proposal: MemoryProposal,
  state: "approved" | "rejected",
  request: ProposalDecisionRequest
): MemoryProposal {
  return {
    ...proposal,
    state,
    decidedAt: request.decidedAt,
    decidedBy: request.reviewer ?? null,
    decisionNote: request.note ?? null
  };
}
