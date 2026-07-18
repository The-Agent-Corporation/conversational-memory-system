import type { ProfileAuthority } from "./authority.js";
import {
  ConfirmationError,
  ConfirmationService,
  type ConfirmationIntent
} from "./confirmation-service.js";
import { ScopedProposalReviewer, type ProposalDecisionPlanRequest } from "../proposals/scoped-proposal-reviewer.js";
import { SourceLifecycleService } from "../service/source-lifecycle-service.js";
import type {
  CommitHistoryImportInput,
  CommitProposalDecisionInput,
  CommitSourceDeletionInput,
  CommitSourceRevocationInput,
  MutationCommitReceipt
} from "../storage/mcp-mutation-contracts.js";
import type { MemoryStore } from "../storage/memory-store.js";

export type MutationApplicationErrorCode =
  | "UNAUTHORIZED_OR_NOT_FOUND"
  | "SOURCE_NOT_REVOKED"
  | "STATE_CHANGED";

export class MutationApplicationError extends Error {
  constructor(readonly code: MutationApplicationErrorCode) {
    super(code);
    this.name = "MutationApplicationError";
  }
}

export interface MutationApplicationOptions {
  store: MemoryStore;
  authority: ProfileAuthority;
  confirmations: ConfirmationService;
}

export interface MutationPreview<Effects> {
  token: string;
  expiresAt: string;
  targetIds: string[];
  effects: Effects;
  effectsFingerprint: string;
}

type StoredPlan =
  | { kind: "proposal_approve" | "proposal_reject"; input: CommitProposalDecisionInput }
  | { kind: "source_revoke"; input: CommitSourceRevocationInput }
  | { kind: "source_delete"; input: CommitSourceDeletionInput }
  | { kind: "history_ingest"; input: CommitHistoryImportInput };

interface ProposalMutationRequest extends Omit<ProposalDecisionPlanRequest, "decision"> {}
interface SourceRevocationRequest { candidateId: string; actor: string; revokedAt: string }
interface SourceDeletionRequest { candidateId: string; actor: string; deletedAt: string }

export class MemoryMutationApplication {
  private readonly proposals: ScopedProposalReviewer;
  private readonly lifecycle: SourceLifecycleService;
  private readonly plans = new Map<string, StoredPlan>();

  constructor(private readonly options: MutationApplicationOptions) {
    this.proposals = new ScopedProposalReviewer(options.store, options.authority);
    this.lifecycle = new SourceLifecycleService(options.store);
  }

  async previewProposalApproval(request: ProposalMutationRequest) {
    return this.previewProposal("approve", request);
  }

  async executeProposalApproval(request: ProposalMutationRequest & { token: string }) {
    return this.executeProposal("approve", request);
  }

  async previewProposalRejection(request: ProposalMutationRequest) {
    return this.previewProposal("reject", request);
  }

  async executeProposalRejection(request: ProposalMutationRequest & { token: string }) {
    return this.executeProposal("reject", request);
  }

  async previewSourceRevocation(request: SourceRevocationRequest) {
    let input: CommitSourceRevocationInput;
    try {
      input = await this.lifecycle.planRevocation({ personId: this.options.authority.personId, ...request });
      this.assertGrantScope(input.expectedGrant.personId, input.expectedGrant.scopeId);
    } catch (error) {
      if (error instanceof MutationApplicationError) throw error;
      throw new MutationApplicationError("UNAUTHORIZED_OR_NOT_FOUND");
    }
    const effects = { grantIds: [input.nextGrant.id], auditEventIds: [input.auditEvent.id] };
    return this.issue("source_revoke", input, [request.candidateId], this.sourceRevocationParameters(request), effects);
  }

  async executeSourceRevocation(request: SourceRevocationRequest & { token: string }): Promise<MutationCommitReceipt> {
    const plan = this.takePlan(request.token, "source_revoke");
    this.consume(request.token, "source_revoke", [request.candidateId], this.sourceRevocationParameters(request), plan?.input.effectsFingerprint ?? "");
    if (!plan || plan.kind !== "source_revoke") throw new ConfirmationError("CONFIRMATION_MISMATCH");
    return this.lifecycle.commitRevocation(plan.input);
  }

  async previewSourceDeletion(request: SourceDeletionRequest) {
    let input: CommitSourceDeletionInput;
    try {
      input = await this.lifecycle.planDeletion({ personId: this.options.authority.personId, ...request });
      this.assertGrantScope(input.expectedGrant.personId, input.expectedGrant.scopeId);
    } catch (error) {
      if (error instanceof MutationApplicationError) throw error;
      if (error instanceof Error && /must be revoked/.test(error.message)) {
        throw new MutationApplicationError("SOURCE_NOT_REVOKED");
      }
      throw new MutationApplicationError("UNAUTHORIZED_OR_NOT_FOUND");
    }
    return this.issue("source_delete", input, [request.candidateId], this.sourceDeletionParameters(request), input.effects);
  }

  async executeSourceDeletion(request: SourceDeletionRequest & { token: string }): Promise<MutationCommitReceipt> {
    const plan = this.takePlan(request.token, "source_delete");
    this.consume(request.token, "source_delete", [request.candidateId], this.sourceDeletionParameters(request), plan?.input.effectsFingerprint ?? "");
    if (!plan || plan.kind !== "source_delete") throw new ConfirmationError("CONFIRMATION_MISMATCH");
    return this.lifecycle.commitDeletion(plan.input);
  }

  private async previewProposal(decision: "approve" | "reject", request: ProposalMutationRequest) {
    const input = await this.proposals.planDecision({ ...request, decision });
    const kind = decision === "approve" ? "proposal_approve" : "proposal_reject";
    return this.issue(kind, input, [request.proposalId], this.proposalParameters(request), input.effects);
  }

  private async executeProposal(decision: "approve" | "reject", request: ProposalMutationRequest & { token: string }): Promise<MutationCommitReceipt> {
    const kind = decision === "approve" ? "proposal_approve" : "proposal_reject";
    const plan = this.takePlan(request.token, kind);
    this.consume(request.token, kind, [request.proposalId], this.proposalParameters(request), plan?.input.effectsFingerprint ?? "");
    if (!plan || (plan.kind !== "proposal_approve" && plan.kind !== "proposal_reject")) throw new ConfirmationError("CONFIRMATION_MISMATCH");
    return this.options.store.commitProposalDecision(plan.input);
  }

  private issue<Effects>(kind: StoredPlan["kind"], input: StoredPlan["input"], targetIds: string[], normalizedParameters: Record<string, unknown>, effects: Effects): MutationPreview<Effects> {
    const intent = this.intent(kind, targetIds, normalizedParameters, input.effectsFingerprint);
    const confirmation = this.options.confirmations.issue(intent);
    this.plans.set(confirmation.token, { kind, input } as StoredPlan);
    return { ...confirmation, targetIds: [...targetIds].sort(), effects, effectsFingerprint: input.effectsFingerprint };
  }

  private takePlan(token: string, expectedKind: StoredPlan["kind"]): StoredPlan | undefined {
    const plan = this.plans.get(token);
    this.plans.delete(token);
    return plan?.kind === expectedKind ? plan : plan;
  }

  private consume(token: string, kind: StoredPlan["kind"], targetIds: string[], normalizedParameters: Record<string, unknown>, effectsFingerprint: string): void {
    this.options.confirmations.consumeExact(token, this.intent(kind, targetIds, normalizedParameters, effectsFingerprint));
  }

  private intent(kind: StoredPlan["kind"], targetIds: string[], normalizedParameters: Record<string, unknown>, effectsFingerprint: string): ConfirmationIntent {
    return {
      profileFingerprint: this.options.authority.fingerprint,
      tool: `${kind}_execute`,
      targetIds,
      normalizedParameters,
      effectsFingerprint
    };
  }

  private assertGrantScope(personId: string, scopeId: string): void {
    if (personId !== this.options.authority.personId || !this.options.authority.allowedScopeIds.includes(scopeId)) {
      throw new MutationApplicationError("UNAUTHORIZED_OR_NOT_FOUND");
    }
  }

  private proposalParameters(request: ProposalMutationRequest): Record<string, unknown> {
    return { decidedAt: request.decidedAt, reviewer: request.reviewer ?? null, note: request.note ?? null };
  }

  private sourceRevocationParameters(request: SourceRevocationRequest): Record<string, unknown> {
    return { actor: request.actor, revokedAt: request.revokedAt };
  }

  private sourceDeletionParameters(request: SourceDeletionRequest): Record<string, unknown> {
    return { actor: request.actor, deletedAt: request.deletedAt };
  }
}
