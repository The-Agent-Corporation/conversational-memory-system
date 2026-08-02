import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import type { CanonicalEvent } from "../../src/domain/canonical.js";

/**
 * `InMemoryStore` caches an id -> position map per collection so `upsertById` and the ownership
 * checks stop scanning the whole array. Staging an import was previously O(n^2) in records staged.
 *
 * These tests exist for the cache's failure mode rather than its speed: an index that goes stale
 * without being noticed would resolve an id to another record's slot, or report a miss for a record
 * that exists and silently insert a duplicate. Both are corruption, not slowness.
 */
const NOW = "2026-08-02T00:00:00.000Z";

const event = (id: string, overrides: Partial<CanonicalEvent> = {}): CanonicalEvent => ({
  id,
  personId: "person_1",
  sourceId: "source_1",
  sourceApplication: "synthetic",
  sourceProfileId: "default",
  nativeSessionId: "session_1",
  nativeEventId: id,
  nativeSequence: 1,
  causalParentId: null,
  role: "user",
  content: `content ${id}`,
  occurredAt: NOW,
  importedAt: NOW,
  provenance: "direct_user_input",
  trustLevel: "high",
  contentHash: `hash_${id}`,
  parserVersion: "synthetic/v1",
  metadata: {},
  ...overrides
} as CanonicalEvent);

describe("InMemoryStore id index", () => {
  it("updates in place rather than duplicating when the same id is saved twice", async () => {
    const store = new InMemoryStore();
    await store.saveCanonicalEvent(event("event_1"));
    await store.saveCanonicalEvent(event("event_1", { content: "updated" }));

    const events = await store.listCanonicalEvents("person_1");
    expect(events).toHaveLength(1);
    expect(events[0].content).toBe("updated");
  });

  it("stays correct across deletes, which shift every position after the removed slot", async () => {
    const store = new InMemoryStore();
    for (const id of ["event_1", "event_2", "event_3"]) await store.saveCanonicalEvent(event(id));

    await store.deleteCanonicalEvents(["event_1"]);
    // Positions cached before the delete now point one slot too far.
    await store.saveCanonicalEvent(event("event_3", { content: "after delete" }));
    await store.saveCanonicalEvent(event("event_4"));

    const events = await store.listCanonicalEvents("person_1");
    expect(events.map((item) => item.id).sort()).toEqual(["event_2", "event_3", "event_4"]);
    expect(events.find((item) => item.id === "event_3")?.content).toBe("after delete");
  });

  it("re-inserting a deleted id does not resurrect a stale position", async () => {
    const store = new InMemoryStore();
    await store.saveCanonicalEvent(event("event_1"));
    await store.saveCanonicalEvent(event("event_2"));
    await store.deleteCanonicalEvents(["event_1", "event_2"]);
    await store.saveCanonicalEvent(event("event_2", { content: "reinserted" }));

    const events = await store.listCanonicalEvents("person_1");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: "event_2", content: "reinserted" });
  });

  it("still refuses to reassign a record to a different person", async () => {
    // The ownership check reads through the same index; a bad lookup would silently allow this.
    const store = new InMemoryStore();
    await store.saveCanonicalEvent(event("event_1"));
    await expect(store.saveCanonicalEvent(event("event_1", { personId: "person_2" })))
      .rejects.toThrow(/different person/i);
  });

  it("keeps each collection's index independent", async () => {
    const store = new InMemoryStore();
    await store.saveCanonicalEvent(event("shared_id"));
    await store.saveSource({
      id: "shared_id",
      personId: "person_1",
      application: "codex",
      profileId: "default",
      instanceId: "instance_1",
      scopeId: "personal",
      createdAt: NOW,
      lastImportedAt: NOW
    } as never);

    // An index keyed by array identity must not let one collection answer for another.
    await expect(store.listCanonicalEvents("person_1")).resolves.toHaveLength(1);
    await expect(store.listSources("person_1")).resolves.toHaveLength(1);
  });

  it("scales linearly, not quadratically, when staging many records", async () => {
    const measure = async (count: number): Promise<number> => {
      const store = new InMemoryStore();
      const started = process.hrtime.bigint();
      for (let index = 0; index < count; index += 1) await store.saveCanonicalEvent(event(`event_${index}`));
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    await measure(500); // warm up the JIT so the comparison is not measuring compilation
    const small = await measure(2_000);
    const large = await measure(8_000);

    // 4x the records under a linear upsert costs ~4x the time; under the previous linear scan it
    // cost ~16x. A generous ceiling of 10x fails the quadratic shape without being flaky on a
    // loaded machine.
    expect(large / Math.max(small, 0.001)).toBeLessThan(10);
  });
});
