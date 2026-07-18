import { afterEach, describe, expect, it } from "vitest";
import {
  createSyntheticMcpFixture,
  type SyntheticMcpFixture
} from "./fixtures.js";

describe("MCP profile loader contract", () => {
  let fixture: SyntheticMcpFixture | undefined;

  afterEach(async () => fixture?.cleanup());

  it("creates only explicit named profiles with immutable person and complete scope authority", async () => {
    fixture = await createSyntheticMcpFixture();
    const profile = fixture.config.profiles["alpha-workspace"];

    expect(fixture.config.version).toBe(1);
    expect(Object.keys(fixture.config.profiles)).toEqual([
      "alpha-workspace",
      "alpha-expanded",
      "other-person"
    ]);
    expect(profile).toMatchObject({
      databasePath: fixture.databasePath,
      personId: "person-alpha",
      allowedScopeIds: ["scope-alpha"],
      ingestScopeId: "scope-alpha"
    });
    expect(fixture.config.profiles).not.toHaveProperty("default");
  });

  it("uses disclosure-safe aliases unrelated to raw scope identifiers or fixture metadata", async () => {
    fixture = await createSyntheticMcpFixture();
    const aliases = fixture.config.profiles["alpha-workspace"].scopeAliases;

    expect(aliases).toEqual({
      "scope-alpha": "context-one",
      "scope-beta": "context-two",
      "scope-shared": "context-three"
    });
    for (const [scopeId, alias] of Object.entries(aliases)) {
      expect(alias).not.toContain(scopeId);
      expect(alias).not.toMatch(/person|source|session|synthetic/i);
    }
  });

  it.todo("05-02 Task 1 rejects a missing profile name before opening a database");
  it.todo("05-02 Task 1 rejects an unknown profile without an implicit default");
  it.todo("05-02 Task 1 freezes profile, person, database, and normalized scope authority");
  it.todo("05-02 Task 1 exposes no tool-call field that can replace person or allowed scopes");
  it.todo("05-02 Task 1 maps restricted matches only through configured safe aliases");
});
