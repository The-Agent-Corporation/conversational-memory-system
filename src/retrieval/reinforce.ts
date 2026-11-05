import type { Summary } from "../domain/types.js";
import type { MemoryStore } from "../storage/memory-store.js";
import { mutationAuditId, type MutationAuditRecord } from "../storage/mutation-audit.js";

export const REINFORCE_STRENGTH_DELTA = 0.05;
export const REINFORCE_WINDOW_MS = 60 * 60 * 1000;

export type ReinforceStatus = "REINFORCED" | "RATE_LIMITED" | "BOUNDED" | "NOT_FOUND";

export interface ReinforceResult {
  status: ReinforceStatus;
  summaryId: string;
  strength: number | null;
}

export async function reinforceSummary(
  store: MemoryStore,
  input: {
    summaryId: string;
    personId: string;
    allowedScopeIds: readonly string[];
    now: string;
  }
): Promise<ReinforceResult> {
  const matches = await store.listSummariesByIds([input.summaryId]);
  const summary = matches.find((item) => item.id === input.summaryId) ?? null;
  if (!summary || !summaryAuthorized(summary, input.personId, input.allowedScopeIds)) {
    return { status: "NOT_FOUND", summaryId: input.summaryId, strength: null };
  }

  const audits = await store.listMutationAudits(input.personId);
  const last = audits
    .filter((record) => record.action === "reinforce" && record.targetId === summary.id)
    .map((record) => record.occurredAt)
    .sort()
    .at(-1);
  if (last && Date.parse(input.now) - Date.parse(last) < REINFORCE_WINDOW_MS) {
    return { status: "RATE_LIMITED", summaryId: summary.id, strength: summary.strength };
  }

  const nextStrength = boundedStrength(summary.strength);
  const nextState = summary.state === "stale" ? "revived" : summary.state;
  if (nextStrength === summary.strength && nextState === summary.state) {
    return { status: "BOUNDED", summaryId: summary.id, strength: summary.strength };
  }

  await store.saveSummary({
    ...summary,
    state: nextState,
    strength: nextStrength,
    retrievalCount: summary.retrievalCount + 1,
    lastAccessedAt: input.now,
    retrievedAt: input.now
  });
  const scopes = summary.scopeIds && summary.scopeIds.length > 0 ? summary.scopeIds : ["personal"];
  for (const scopeId of scopes) {
    await store.recordMutationAudit(auditRecord({
      personId: input.personId,
      scopeId,
      action: "reinforce",
      targetId: summary.id,
      occurredAt: input.now
    }));
  }
  return { status: "REINFORCED", summaryId: summary.id, strength: nextStrength };
}

export function boundedStrength(strength: number): number {
  return Math.min(1, Number((strength + REINFORCE_STRENGTH_DELTA).toFixed(2)));
}

const summaryAuthorized = (
  summary: Summary,
  personId: string,
  allowedScopeIds: readonly string[]
): boolean => {
  if (summary.personId !== personId) return false;
  const allowed = new Set(allowedScopeIds);
  return (summary.scopeIds ?? ["personal"]).every((scopeId) => allowed.has(scopeId));
};

const auditRecord = (input: Omit<MutationAuditRecord, "id">): MutationAuditRecord => ({
  id: mutationAuditId(input),
  ...input
});
