import { createHash } from "node:crypto";

/** Missing summary scopes use the same default retrieval already uses. This is not an ownership guess. */
export const DEFAULT_SUMMARY_SCOPE = "personal";

export class RejectedValueError extends Error {
  constructor() {
    super("REJECTED_VALUE");
    this.name = "RejectedValueError";
  }
}

export function normalizeRejectedValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function rejectedValueHash(value: string): string {
  return createHash("sha256").update(normalizeRejectedValue(value)).digest("hex");
}

export async function assertRejectedValueAllowed(input: {
  personId: string | undefined;
  summaryIds: readonly string[];
  title: string;
  summaries: ReadonlyArray<{ id: string; personId?: string; scopeIds?: readonly string[] }>;
  hasFingerprint: (personId: string, scopeId: string, valueHash: string) => Promise<boolean>;
}): Promise<void> {
  if (!input.personId) return;
  const linked = input.summaries.filter((summary) => input.summaryIds.includes(summary.id));
  const scopes = scopeIdsForPerson(linked, input.personId);
  const valueHash = rejectedValueHash(input.title);
  for (const scopeId of scopes) {
    if (await input.hasFingerprint(input.personId, scopeId, valueHash)) {
      throw new RejectedValueError();
    }
  }
}

export function scopeIdsForPerson(
  summaries: ReadonlyArray<{ personId?: string; scopeIds?: readonly string[] }>,
  personId: string
): string[] {
  const scopes = new Set<string>();
  for (const summary of summaries) {
    if (summary.personId && summary.personId !== personId) continue;
    const ids = summary.scopeIds && summary.scopeIds.length > 0 ? summary.scopeIds : [DEFAULT_SUMMARY_SCOPE];
    for (const scopeId of ids) scopes.add(scopeId);
  }
  if (scopes.size === 0) scopes.add(DEFAULT_SUMMARY_SCOPE);
  return [...scopes].sort();
}
