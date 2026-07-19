import { afterEach, describe, expect, it } from "vitest";
import { DisclosureLabeler } from "../../src/mcp/disclosure-labels.js";
import { loadMemoryMcpProfile } from "../../src/mcp/profile-loader.js";
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

  it("05-02 Task 1 rejects a missing profile name before opening a database", async () => {
    fixture = await createSyntheticMcpFixture();

    await expect(loadMemoryMcpProfile({ configPath: fixture.configPath })).rejects.toThrow(
      "An explicit profile name is required"
    );
    await expect(loadMemoryMcpProfile({ profileName: "alpha-workspace" })).rejects.toThrow(
      "An explicit absolute config path is required"
    );
  });

  it("05-02 Task 1 rejects an unknown profile without an implicit default", async () => {
    fixture = await createSyntheticMcpFixture();

    await expect(loadMemoryMcpProfile({
      configPath: fixture.configPath,
      profileName: "missing-profile"
    })).rejects.toThrow("Unknown memory MCP profile");

    fixture.config.profiles["alpha-workspace"].databasePath = "relative.sqlite";
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(fixture!.configPath, JSON.stringify(fixture!.config), "utf8")
    );
    await expect(loadMemoryMcpProfile({
      configPath: fixture.configPath,
      profileName: "alpha-workspace"
    })).rejects.toThrow("Invalid memory MCP configuration");
  });

  it("05-02 Task 1 freezes profile, person, database, and normalized scope authority", async () => {
    fixture = await createSyntheticMcpFixture();
    fixture.config.profiles["alpha-expanded"].allowedScopeIds = [
      "scope-beta",
      "scope-alpha",
      "scope-beta"
    ];
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(fixture!.configPath, JSON.stringify(fixture!.config), "utf8")
    );

    const authority = await loadMemoryMcpProfile({
      configPath: fixture.configPath,
      profileName: "alpha-expanded"
    });

    expect(authority.allowedScopeIds).toEqual(["scope-alpha", "scope-beta"]);
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Object.isFrozen(authority.allowedScopeIds)).toBe(true);
    expect(Object.isFrozen(authority.sourceRoots)).toBe(true);
    expect(Object.isFrozen(authority.scopeAliases)).toBe(true);
    expect(authority.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(authority)).not.toContain("Synthetic alpha memory");
    expect(() => (authority.allowedScopeIds as string[]).push("scope-shared")).toThrow();
  });

  it("05-02 Task 1 exposes no tool-call field that can replace person or allowed scopes", async () => {
    fixture = await createSyntheticMcpFixture();
    const authority = await loadMemoryMcpProfile({
      configPath: fixture.configPath,
      profileName: "alpha-workspace"
    });

    expect(Object.keys(authority).sort()).toEqual([
      "allowedScopeIds",
      "databasePath",
      "fingerprint",
      "ingestScopeId",
      "personId",
      "profileName",
      "scopeAliases",
      "sourceRoots"
    ]);
    expect(loadMemoryMcpProfile.length).toBe(1);
  });

  it("05-02 Task 1 maps restricted matches only through configured safe aliases", async () => {
    fixture = await createSyntheticMcpFixture();
    const authority = await loadMemoryMcpProfile({
      configPath: fixture.configPath,
      profileName: "alpha-workspace"
    });
    const labeler = new DisclosureLabeler(authority.scopeAliases);

    expect(labeler.labelRestrictedScopes(["scope-beta", "scope-secret-client-123"]))
      .toEqual(["context-two", "restricted-context"]);
    expect(JSON.stringify(labeler.labelRestrictedScopes([
      "scope-secret-client-123",
      "/Users/example/private-case",
      "session-99"
    ]))).not.toMatch(/secret|private|session|Users|scope-/i);
  });
});
