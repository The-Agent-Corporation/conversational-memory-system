import { afterEach, describe, expect, it } from "vitest";
import { createProfileAuthority } from "../../src/mcp/authority.js";
import { ContinuationCursorCodec } from "../../src/mcp/continuation-cursor.js";
import { SubjectExpansionService } from "../../src/retrieval/subject-expansion-service.js";
import {
  createSyntheticMcpFixture,
  snapshotSemanticMemory,
  type SyntheticMcpFixture
} from "./fixtures.js";

describe("MCP whole-subject expansion contract", () => {
  let fixture: SyntheticMcpFixture | undefined;

  afterEach(async () => fixture?.cleanup());

  it("provides canonical events in deterministic timeline order for synthetic people only", async () => {
    fixture = await createSyntheticMcpFixture();
    const alpha = await fixture.store.listCanonicalEvents("person-alpha");
    const other = await fixture.store.listCanonicalEvents("person-beta");

    expect(alpha.map((event) => event.id)).toEqual([
      "event-alpha-1",
      "event-alpha-2",
      "event-beta-1"
    ]);
    expect(other.map((event) => event.id)).toEqual(["event-other-1"]);
    expect(alpha.every((event) => event.personId === "person-alpha")).toBe(true);
  });

  it("leaves the synthetic semantic snapshot unchanged during fixture-only expansion inspection", async () => {
    fixture = await createSyntheticMcpFixture();
    const before = await snapshotSemanticMemory(fixture.store);
    await fixture.store.listCanonicalEvents("person-alpha");
    const after = await snapshotSemanticMemory(fixture.store);
    expect(after).toBe(before);
  });

  const createService = (currentFixture: SyntheticMcpFixture, profileName = "alpha-workspace") => {
    const profile = currentFixture.config.profiles[profileName];
    if (!profile) throw new Error("Missing synthetic profile");
    const authority = createProfileAuthority({ profileName, ...profile });
    const cursors = new ContinuationCursorCodec("synthetic-test-secret-with-adequate-length", {
      now: currentFixture.clock.now
    });
    return { authority, service: new SubjectExpansionService(currentFixture.store, authority, cursors) };
  };

  it("05-03 Task 1 resolves a subject rather than accepting caller-selected global result IDs", async () => {
    fixture = await createSyntheticMcpFixture();
    const { service } = createService(fixture);

    const page = await service.expand({ subject: "  SYNTHETIC   ALPHA SUMMARY ", tokenBudget: 500 });

    expect(page.subject).toMatchObject({ kind: "summary", id: "summary-alpha" });
    expect(page.events.map((event) => event.id)).toEqual(["event-alpha-1", "event-alpha-2"]);
    expect(page).not.toHaveProperty("requestedIds");
  });

  it("05-03 Task 1 returns only the authorized first page within the exact token budget", async () => {
    fixture = await createSyntheticMcpFixture();
    const { service } = createService(fixture);

    const full = await service.expand({ subject: "Synthetic alpha summary", tokenBudget: 500 });
    const oneEventBudget = full.events[0]?.estimatedTokens;
    expect(oneEventBudget).toBeGreaterThan(0);
    const page = await service.expand({
      subject: "Synthetic alpha summary",
      tokenBudget: oneEventBudget ?? 1
    });

    expect(page.events).toHaveLength(1);
    expect(page.budget).toEqual({
      requested: oneEventBudget,
      used: oneEventBudget,
      unit: "estimated_tokens",
      estimatorVersion: "words-v1"
    });
    expect(page.continuation).toEqual(expect.any(String));
    expect(page.disclosure).toContain("Assistive memory only");
    expect(page.events[0]).toMatchObject({
      id: "event-alpha-1",
      source: { id: "source-alpha", application: "synthetic-host" },
      native: { sessionId: "synthetic-alpha", eventId: "native-event-alpha-1", sequence: 1 },
      provenance: "direct_user_input",
      scopeIds: ["scope-alpha"]
    });
  });

  it("05-03 Task 1 rejects a subject whose derived dependencies cross outside allowed scopes", async () => {
    fixture = await createSyntheticMcpFixture();
    const { service } = createService(fixture);

    await expect(service.expand({ subject: "Synthetic mixed dependency box", tokenBudget: 500 }))
      .rejects.toThrow("Subject is unavailable");
    await expect(service.expand({ subject: "Synthetic other-person summary", tokenBudget: 500 }))
      .rejects.toThrow("Subject is unavailable");
  });
  it.todo("05-03 Task 2 authenticates continuation against profile, subject, order key, estimator, and expiry");
  it.todo("05-03 Task 2 resumes deterministic expansion with no gaps or duplicate canonical events");
  it.todo("05-03 Task 2 rejects changed subjects, profiles, budgets, and tampered continuation state");
  it.todo("05-03 Task 2 completes every page with byte-equivalent semantic tables before and after");
});
