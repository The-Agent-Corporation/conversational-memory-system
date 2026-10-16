import { createHash } from "node:crypto";

export interface ProfileAuthority {
  readonly profileName: string;
  readonly databasePath: string;
  readonly personId: string;
  readonly allowedScopeIds: readonly string[];
  readonly ingestScopeId: string;
  readonly sourceRoots: Readonly<Record<string, string>>;
  readonly scopeAliases: Readonly<Record<string, string>>;
  readonly allowInjection?: boolean;
  readonly fingerprint: string;
}

export interface ProfileAuthorityInput extends Omit<ProfileAuthority, "fingerprint" | "allowInjection"> {
  allowInjection?: boolean;
}

const sortedRecord = (value: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));

export const createProfileAuthority = (input: ProfileAuthorityInput): ProfileAuthority => {
  const allowedScopeIds = Object.freeze([...new Set(input.allowedScopeIds)].sort());
  const sourceRoots = Object.freeze(sortedRecord({ ...input.sourceRoots }));
  const scopeAliases = Object.freeze(sortedRecord({ ...input.scopeAliases }));
  const fingerprintPayload = JSON.stringify({
    version: 1,
    profileName: input.profileName,
    databasePath: input.databasePath,
    personId: input.personId,
    allowedScopeIds,
    ingestScopeId: input.ingestScopeId,
    sourceRoots,
    scopeAliases,
    allowInjection: input.allowInjection === true
  });

  return Object.freeze({
    profileName: input.profileName,
    databasePath: input.databasePath,
    personId: input.personId,
    allowedScopeIds,
    ingestScopeId: input.ingestScopeId,
    sourceRoots,
    scopeAliases,
    allowInjection: input.allowInjection === true,
    fingerprint: createHash("sha256").update(fingerprintPayload).digest("hex")
  });
};
