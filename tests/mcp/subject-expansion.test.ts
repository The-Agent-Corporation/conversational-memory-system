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
  it("05-03 Task 2 authenticates continuation against profile, subject, order key, estimator, and expiry", async () => {
    fixture = await createSyntheticMcpFixture();
    const { service } = createService(fixture);
    const full = await service.expand({ subject: "Synthetic alpha summary", tokenBudget: 500 });
    const tokenBudget = full.events[0]?.estimatedTokens ?? 1;
    const first = await service.expand({ subject: "Synthetic alpha summary", tokenBudget });
    const cursor = first.continuation;
    expect(cursor).toEqual(expect.any(String));

    const serializedEnvelope = Buffer.from(cursor ?? "", "base64url").toString("utf8");
    expect(serializedEnvelope).toContain("authorityFingerprint");
    expect(serializedEnvelope).toContain("subjectHash");
    expect(serializedEnvelope).toContain("next");
    expect(serializedEnvelope).toContain("estimatorVersion");
    expect(serializedEnvelope).toContain("expiresAt");
    expect(serializedEnvelope).not.toContain("Synthetic alpha subject");
    expect(serializedEnvelope).not.toContain("scope-alpha");
    expect(serializedEnvelope).not.toContain(fixture.tempDir);

    fixture.clock.advance(5 * 60 * 1000 + 1);
    await expect(service.expand({ subject: "Synthetic alpha summary", tokenBudget, cursor: cursor ?? "" }))
      .rejects.toThrow("Invalid continuation cursor");
  });

  it("05-03 Task 2 resumes deterministic expansion with no gaps or duplicate canonical events", async () => {
    fixture = await createSyntheticMcpFixture();
    const { service } = createService(fixture);
    const full = await service.expand({ subject: "Synthetic alpha summary", tokenBudget: 500 });
    const tokenBudget = full.events[0]?.estimatedTokens ?? 1;
    const first = await service.expand({ subject: "Synthetic alpha summary", tokenBudget });
    const second = await service.expand({
      subject: "Synthetic alpha summary",
      tokenBudget,
      cursor: first.continuation ?? ""
    });

    expect([...first.events, ...second.events].map((event) => event.id)).toEqual([
      "event-alpha-1",
      "event-alpha-2"
    ]);
    expect(new Set([...first.events, ...second.events].map((event) => event.id)).size).toBe(2);
    expect(second.continuation).toBeNull();
  });

  it("05-03 Task 2 rejects changed subjects, profiles, budgets, and tampered continuation state", async () => {
    fixture = await createSyntheticMcpFixture();
    const { service } = createService(fixture);
    const { service: expandedProfileService } = createService(fixture, "alpha-expanded");
    const full = await service.expand({ subject: "Synthetic alpha summary", tokenBudget: 500 });
    const tokenBudget = full.events[0]?.estimatedTokens ?? 1;
    const first = await service.expand({ subject: "Synthetic alpha summary", tokenBudget });
    const cursor = first.continuation ?? "";
    const tampered = `${cursor[0] === "A" ? "B" : "A"}${cursor.slice(1)}`;

    await expect(service.expand({ subject: "Synthetic alpha box", tokenBudget, cursor }))
      .rejects.toThrow("Invalid continuation cursor");
    await expect(expandedProfileService.expand({ subject: "Synthetic alpha summary", tokenBudget, cursor }))
      .rejects.toThrow("Invalid continuation cursor");
    await expect(service.expand({ subject: "Synthetic alpha summary", tokenBudget: tokenBudget + 1, cursor }))
      .rejects.toThrow("Invalid continuation cursor");
    await expect(service.expand({ subject: "Synthetic alpha summary", tokenBudget, cursor: tampered }))
      .rejects.toThrow("Invalid continuation cursor");
  });

  it("05-03 Task 2 completes every page with byte-equivalent semantic tables before and after", async () => {
    fixture = await createSyntheticMcpFixture();
    const before = await snapshotSemanticMemory(fixture.store);
    const { service } = createService(fixture);
    const full = await service.expand({ subject: "Synthetic alpha summary", tokenBudget: 500 });
    const tokenBudget = full.events[0]?.estimatedTokens ?? 1;
    let cursor: string | null | undefined;
    const ids: string[] = [];
    do {
      const page = await service.expand({ subject: "Synthetic alpha summary", tokenBudget, ...(cursor ? { cursor } : {}) });
      ids.push(...page.events.map((event) => event.id));
      cursor = page.continuation;
    } while (cursor);

    expect(ids).toEqual(["event-alpha-1", "event-alpha-2"]);
    expect(await snapshotSemanticMemory(fixture.store)).toBe(before);
  });
});
