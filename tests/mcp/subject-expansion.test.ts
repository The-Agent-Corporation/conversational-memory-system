import { afterEach, describe, expect, it } from "vitest";
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

  it.todo("05-03 Task 1 resolves a subject rather than accepting caller-selected global result IDs");
  it.todo("05-03 Task 1 returns only the authorized first page within the exact token budget");
  it.todo("05-03 Task 1 rejects a subject whose derived dependencies cross outside allowed scopes");
  it.todo("05-03 Task 2 authenticates continuation against profile, subject, order key, estimator, and expiry");
  it.todo("05-03 Task 2 resumes deterministic expansion with no gaps or duplicate canonical events");
  it.todo("05-03 Task 2 rejects changed subjects, profiles, budgets, and tampered continuation state");
  it.todo("05-03 Task 2 completes every page with byte-equivalent semantic tables before and after");
});
