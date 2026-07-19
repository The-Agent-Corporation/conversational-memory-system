import { createHash } from "node:crypto";
import {
  SourceGrantSchema,
  SourceLifecycleAuditEventSchema,
  type SourceGrant
} from "../domain/source-lifecycle.js";
import type { MemoryStore } from "../storage/memory-store.js";
import type { JsonObject } from "../domain/types.js";
import {
  CommitSourceDeletionInputSchema,
  CommitSourceRevocationInputSchema,
  mutationEffectsFingerprint,
  type CommitSourceDeletionInput,
  type CommitSourceRevocationInput,
  type MutationCommitReceipt
} from "../storage/mcp-mutation-contracts.js";
import { DEFAULT_LOCAL_SYNC_DEVICE_ID, emitLocalSyncOperation } from "../sync/materialization/sync-materializer.js";

export interface ApproveSourceInput {
  personId: string;
  candidateId: string;
  application: string;
  format: string;
  sourceLocator: string;
  profileId: string;
  scopeId?: string;
  actor?: string;
  approvedAt: string;
}

export interface SourceDeletionResult {
  candidateId: string;
  deletedCanonicalEventCount: number;
  deletedSourceCount: number;
  deletedAnchorCount: number;
  supersededSummaryCount: number;
  supersededBoxCount: number;
  supersededProposalCount: number;
  supersededTraceCount: number;
}

export class SourceLifecycleService {
  private readonly syncDeviceId: string;

  constructor(private readonly store: MemoryStore, options: { syncDeviceId?: string } = {}) {
    this.syncDeviceId = options.syncDeviceId ?? DEFAULT_LOCAL_SYNC_DEVICE_ID;
  }

  async approve(input: ApproveSourceInput): Promise<SourceGrant> {
    const id = this.grantId(input.personId, input.candidateId);
    const existing = await this.store.getSourceGrant(id);
    if (existing && existing.personId !== input.personId) {
      throw new Error("Cannot reassign a source grant to another person");
    }
    if (existing && input.scopeId !== undefined && existing.scopeId !== input.scopeId) {
      throw new Error("Cannot change an approved source scope through reapproval");
    }
    const grant = SourceGrantSchema.parse({
      id,
      personId: input.personId,
      candidateId: input.candidateId,
      application: input.application,
      format: input.format,
      sourceLocator: input.sourceLocator,
      profileId: input.profileId,
      scopeId: input.scopeId ?? existing?.scopeId ?? "personal",
      state: "approved",
      approvedAt: input.approvedAt,
      revokedAt: null,
      updatedAt: input.approvedAt
    });
    await this.store.saveSourceGrant(grant);
    await this.audit(grant, "approved", input.actor ?? "user", input.approvedAt, {
      application: input.application,
      format: input.format,
      scopeId: grant.scopeId
    });
    return grant;
  }

  async revoke(personId: string, candidateId: string, actor: string, revokedAt: string): Promise<SourceGrant> {
    const grant = await this.store.getSourceGrant(this.grantId(personId, candidateId));
    if (!grant || grant.personId !== personId) throw new Error("Approved source grant not found");
    if (grant.state === "revoked") return grant;
    const plan = await this.planRevocation({ personId, candidateId, actor, revokedAt });
    const receipt = await this.commitRevocation(plan);
    if (receipt.status !== "COMMITTED") throw new Error("Source state changed before revocation");
    return plan.nextGrant;
  }

  async planRevocation(input: { personId: string; candidateId: string; actor: string; revokedAt: string }): Promise<CommitSourceRevocationInput> {
    const grant = await this.store.getSourceGrant(this.grantId(input.personId, input.candidateId));
    if (!grant || grant.personId !== input.personId || grant.state !== "approved") throw new Error("Approved source grant not found");
    const nextGrant = SourceGrantSchema.parse({ ...grant, state: "revoked", revokedAt: input.revokedAt, updatedAt: input.revokedAt });
    const auditEvent = this.createAuditEvent(nextGrant, "revoked", input.actor, input.revokedAt, {});
    return CommitSourceRevocationInputSchema.parse({
      operation: "source_revocation",
      personId: input.personId,
      expectedGrant: grant,
      nextGrant,
      auditEvent,
      effectsFingerprint: mutationEffectsFingerprint({ grantId: nextGrant.id, auditEventId: auditEvent.id }),
      receipt: {
        operation: "source_revocation", status: "COMMITTED", personId: input.personId,
        targetId: input.candidateId, effectCounts: { grants: 1, audits: 1 }, committedAt: input.revokedAt
      }
    });
  }

  async commitRevocation(input: CommitSourceRevocationInput): Promise<MutationCommitReceipt> {
    const receipt = await this.store.commitSourceRevocation(input);
    if (receipt.status === "COMMITTED") {
      await emitLocalSyncOperation(this.store, {
        personId: input.personId,
        deviceId: this.syncDeviceId,
        operationKind: "source_revocation",
        targetId: input.expectedGrant.candidateId,
        effectFingerprint: input.effectsFingerprint,
        committedAt: input.receipt.committedAt
      });
    }
    return receipt;
  }

  async assertApproved(personId: string, candidateId: string): Promise<SourceGrant> {
    const grant = await this.store.getSourceGrant(this.grantId(personId, candidateId));
    if (!grant || grant.personId !== personId || grant.state !== "approved") {
      throw new Error(`Source ${candidateId} is not durably approved for person ${personId}`);
    }
    return grant;
  }

  async requestQuarantineReplay(input: {
    personId: string;
    candidateId: string;
    confirmedCandidateId: string;
    actor: string;
    requestedAt: string;
  }): Promise<number> {
    if (input.confirmedCandidateId !== input.candidateId) {
      throw new Error("Quarantine replay confirmation does not match the candidate ID");
    }
    const grant = await this.assertApproved(input.personId, input.candidateId);
    const records = (await this.store.listQuarantineRecords(input.personId, input.candidateId))
      .filter((record) => record.state === "pending" || record.state === "replay_requested");
    for (const record of records) {
      await this.store.saveQuarantineRecord({
        ...record,
        state: "replay_requested",
        replayRequestedAt: input.requestedAt,
        replayedAt: null
      });
    }
    await this.store.deleteImportCheckpointsForCandidate(input.personId, input.candidateId);
    await this.audit(grant, "quarantine_replay_requested", input.actor, input.requestedAt, {
      recordCount: records.length
    });
    return records.length;
  }

  async deleteRevokedSource(input: {
    personId: string;
    candidateId: string;
    confirmedCandidateId: string;
    actor: string;
    deletedAt: string;
  }): Promise<SourceDeletionResult> {
    if (input.confirmedCandidateId !== input.candidateId) {
      throw new Error("Source deletion confirmation does not match the candidate ID");
    }
    const plan = await this.planDeletion(input);
    const receipt = await this.commitDeletion(plan);
    if (receipt.status !== "COMMITTED") throw new Error("Source state changed before deletion");
    return this.deletionResult(plan);
  }

  async planDeletion(input: {
    personId: string; candidateId: string; actor: string; deletedAt: string;
  }): Promise<CommitSourceDeletionInput> {
    const grant = await this.store.getSourceGrant(this.grantId(input.personId, input.candidateId));
    if (!grant || grant.personId !== input.personId) throw new Error("Source grant not found");
    if (grant.state !== "revoked") throw new Error("Source must be revoked before deletion");
    const requested = this.createAuditEvent(grant, "deletion_requested", input.actor, input.deletedAt, {});
    const completed = this.createAuditEvent(grant, "deletion_completed", input.actor, input.deletedAt, { candidateId: input.candidateId });
    const auditEvents = [requested, completed];
    const effects = await this.store.inspectSourceDeletionEffects(input.personId, input.candidateId, auditEvents.map((item) => item.id));
    const [summaries, boxes, proposals, traces] = await Promise.all([
      this.store.listSummaries(), this.store.listBoxes(), this.store.listProposals(), this.store.listTraces()
    ]);
    const nextSummaries = summaries.filter((item) => effects.supersededSummaryIds.includes(item.id)).map((item) => ({ ...item, state: "superseded" as const }));
    const nextBoxes = boxes.filter((item) => effects.supersededBoxIds.includes(item.id)).map((item) => ({ ...item, state: "superseded" as const, updatedAt: input.deletedAt }));
    const nextProposals = proposals.filter((item) => effects.supersededProposalIds.includes(item.id)).map((item) => ({ ...item, state: "superseded" as const, decidedAt: input.deletedAt, decidedBy: input.actor, decisionNote: "Confirmed source deletion invalidated this proposal." }));
    const nextTraces = traces.filter((item) => effects.supersededTraceIds.includes(item.id)).map((item) => ({ ...item, state: "superseded" as const, updatedAt: input.deletedAt }));
    const result = this.deletionResultFromEffects(input.candidateId, effects);
    auditEvents[1] = this.createAuditEvent(grant, "deletion_completed", input.actor, input.deletedAt, { ...result });
    const finalEffects = { ...effects, auditEventIds: auditEvents.map((item) => item.id) };
    return CommitSourceDeletionInputSchema.parse({
      operation: "source_deletion", personId: input.personId, expectedGrant: grant,
      nextSummaries, nextBoxes, nextProposals, nextTraces, auditEvents,
      effects: finalEffects, effectsFingerprint: mutationEffectsFingerprint(finalEffects),
      receipt: {
        operation: "source_deletion", status: "COMMITTED", personId: input.personId,
        targetId: input.candidateId,
        effectCounts: {
          sources: finalEffects.sourceIds.length, events: finalEffects.canonicalEventIds.length,
          anchors: finalEffects.anchorIds.length, summaries: finalEffects.supersededSummaryIds.length,
          boxes: finalEffects.supersededBoxIds.length, proposals: finalEffects.supersededProposalIds.length,
          traces: finalEffects.supersededTraceIds.length, audits: auditEvents.length
        },
        committedAt: input.deletedAt
      }
    });
  }

  async commitDeletion(input: CommitSourceDeletionInput): Promise<MutationCommitReceipt> {
    const receipt = await this.store.commitSourceDeletion(input);
    if (receipt.status === "COMMITTED") {
      await emitLocalSyncOperation(this.store, {
        personId: input.personId,
        deviceId: this.syncDeviceId,
        operationKind: "source_deletion",
        targetId: input.expectedGrant.candidateId,
        effectFingerprint: input.effectsFingerprint,
        committedAt: input.receipt.committedAt
      });
    }
    return receipt;
  }

  /**
   * Permanently disposes a stale quarantined content offer left behind by a source
   * revocation/deletion tombstone. Retains the tombstone/audit trail and creates no active
   * content; converges idempotently with any concurrent restoration decision (materialization is
   * SyncMaterializer's responsibility — this emits the confirmed local decision).
   */
  async keepDeletion(input: {
    personId: string;
    candidateId: string;
    tombstoneTargetId: string;
    actor: string;
    decidedAt: string;
  }): Promise<void> {
    await emitLocalSyncOperation(this.store, {
      personId: input.personId,
      deviceId: this.syncDeviceId,
      operationKind: "quarantine_resolution",
      targetId: input.tombstoneTargetId,
      effectFingerprint: mutationEffectsFingerprint({
        kind: "keep_deletion",
        candidateId: input.candidateId,
        tombstoneTargetId: input.tombstoneTargetId,
        actor: input.actor,
        decidedAt: input.decidedAt
      }),
      committedAt: input.decidedAt
    });
  }

  /**
   * Creates the reviewed restoration path for exact bounded restored content without clearing the
   * tombstone or silently resuming source ingestion.
   */
  async restoreReviewed(input: {
    personId: string;
    candidateId: string;
    tombstoneTargetId: string;
    restoredCanonicalEventIds: string[];
    actor: string;
    decidedAt: string;
  }): Promise<void> {
    await emitLocalSyncOperation(this.store, {
      personId: input.personId,
      deviceId: this.syncDeviceId,
      operationKind: "quarantine_resolution",
      targetId: input.tombstoneTargetId,
      effectFingerprint: mutationEffectsFingerprint({
        kind: "restore_reviewed",
        candidateId: input.candidateId,
        tombstoneTargetId: input.tombstoneTargetId,
        restoredCanonicalEventIds: [...input.restoredCanonicalEventIds].sort(),
        actor: input.actor,
        decidedAt: input.decidedAt
      }),
      committedAt: input.decidedAt
    });
  }

  grantId(personId: string, candidateId: string): string {
    return `grant_${createHash("sha256").update(JSON.stringify([personId, candidateId])).digest("hex")}`;
  }

  private async audit(
    grant: SourceGrant,
    action: "approved" | "revoked" | "deletion_requested" | "deletion_completed" | "quarantine_replay_requested",
    actor: string,
    occurredAt: string,
    details: JsonObject
  ): Promise<void> {
    await this.store.saveSourceLifecycleAuditEvent(this.createAuditEvent(grant, action, actor, occurredAt, details));
  }

  private createAuditEvent(
    grant: SourceGrant,
    action: "approved" | "revoked" | "deletion_requested" | "deletion_completed" | "quarantine_replay_requested",
    actor: string,
    occurredAt: string,
    details: JsonObject
  ) {
    const id = `audit_${createHash("sha256").update(JSON.stringify([grant.id, action, occurredAt, actor])).digest("hex")}`;
    return SourceLifecycleAuditEventSchema.parse({
      id,
      personId: grant.personId,
      grantId: grant.id,
      candidateId: grant.candidateId,
      action,
      actor,
      occurredAt,
      details
    });
  }

  private deletionResult(input: CommitSourceDeletionInput): SourceDeletionResult {
    return this.deletionResultFromEffects(input.expectedGrant.candidateId, input.effects);
  }

  private deletionResultFromEffects(candidateId: string, effects: CommitSourceDeletionInput["effects"]): SourceDeletionResult {
    return {
      candidateId,
      deletedCanonicalEventCount: effects.canonicalEventIds.length,
      deletedSourceCount: effects.sourceIds.length,
      deletedAnchorCount: effects.anchorIds.length,
      supersededSummaryCount: effects.supersededSummaryIds.length,
      supersededBoxCount: effects.supersededBoxIds.length,
      supersededProposalCount: effects.supersededProposalIds.length,
      supersededTraceCount: effects.supersededTraceIds.length
    };
  }
}
