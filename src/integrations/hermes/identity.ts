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

const PERSON_ENV = "HERMES_MEMORY_PERSON_ID";
const SCOPE_ENV = "HERMES_MEMORY_SCOPE_IDS";

export function resolveHermesMemoryIdentity(
  input: HermesMemoryIdentityInput = {}
): HermesMemoryIdentity {
  const personId = input.personId?.trim() || process.env[PERSON_ENV]?.trim() || "";
  const configuredScopes = input.allowedScopeIds
    ?? process.env[SCOPE_ENV]?.split(",").map((scopeId) => scopeId.trim()).filter(Boolean)
    ?? [];
  const allowedScopeIds = [...new Set(configuredScopes)];

  if (!personId || allowedScopeIds.length !== 1) {
    throw new Error(
      "Hermes memory identity is not configured. Set one personId and exactly one scope via HERMES_MEMORY_PERSON_ID and HERMES_MEMORY_SCOPE_IDS."
    );
  }

  return {
    personId,
    scopeId: allowedScopeIds[0],
    allowedScopeIds: [allowedScopeIds[0]]
  };
}
