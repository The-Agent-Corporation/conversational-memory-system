export const GENERIC_RESTRICTED_LABEL = "restricted-context";

export class DisclosureLabeler {
  readonly #aliases: Readonly<Record<string, string>>;

  constructor(aliases: Readonly<Record<string, string>>) {
    this.#aliases = Object.freeze({ ...aliases });
  }

  labelRestrictedScopes(scopeIds: readonly string[]): string[] {
    return [...new Set(scopeIds.map((scopeId) =>
      this.#aliases[scopeId] ?? GENERIC_RESTRICTED_LABEL
    ))].sort();
  }
}
