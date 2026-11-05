/**
 * Temporary Hermes compatibility identity (ADR 0062).
 *
 * Hermes is an ordinary client. It may bind one configured person and one
 * configured scope. It never receives unscoped retrieval.
 */
export interface HermesMemoryIdentity {
  personId: string;
  scopeId: string;
  allowedScopeIds: readonly [string];
}

export interface HermesMemoryIdentityInput {
  personId?: string;
  allowedScopeIds?: readonly string[];
}

export function resolveHermesMemoryIdentity(
  input: HermesMemoryIdentityInput = {}
): HermesMemoryIdentity {
  const personId = input.personId?.trim() ?? "";
  const allowedScopeIds = [...new Set((input.allowedScopeIds ?? []).map((scopeId) => scopeId.trim()).filter(Boolean))];

  if (!personId || allowedScopeIds.length !== 1) {
    throw new Error(
      "An explicit personId and exactly one scope are required. HERMES_MEMORY_* environment flags are not accepted."
    );
  }

  return {
    personId,
    scopeId: allowedScopeIds[0],
    allowedScopeIds: [allowedScopeIds[0]]
  };
}
