import { createHash } from "node:crypto";

export const MUTATION_AUDIT_ACTIONS = [
  "reinforce",
  "inject",
  "append_turn",
  "proposal_decision",
  "proposal_write",
  "source_revocation",
  "source_deletion",
  "event_deletion",
  "history_import"
] as const;

export interface MutationAuditRecord {
  id: string;
  personId: string;
  scopeId: string;
  action: (typeof MUTATION_AUDIT_ACTIONS)[number];
  targetId: string;
  occurredAt: string;
}

export interface RejectedValueFingerprint {
  personId: string;
  scopeId: string;
  valueHash: string;
  recordedAt: string;
}

export function mutationAuditId(input: Omit<MutationAuditRecord, "id">): string {
  return `audit_${createHash("sha256").update(JSON.stringify([
    input.personId,
    input.scopeId,
    input.action,
    input.targetId,
    input.occurredAt
  ])).digest("hex")}`;
}
