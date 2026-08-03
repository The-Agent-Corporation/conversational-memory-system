import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";
import type { MemoryStore } from "../../src/storage/memory-store.js";
import type { CanonicalEvent } from "../../src/domain/canonical.js";

/**
 * `listCanonicalEventKeys` and `listCanonicalEventScopePairs` exist so a contraction slice can know
 * where every event sits, and that every event's scope is sound, WITHOUT reading 292,407 payloads
 * to process 250 events.
 *
 * The tests that matter here are the agreement ones. A slice indexes positions off the key spine
 * and then materializes payloads by id; if the two ever disagree on order, it pairs an index with
 * the wrong event and derives a summary from the wrong text. That is silent corruption, not a
 * failure, so it is asserted directly rather than left to the callers.
 *
 * Both implementations are exercised against the same expectations: `SqliteStore` answers from
 * indexes, `InMemoryStore` from arrays, and the daemon must not be able to tell them apart.
 */
const NOW = "2026-08-02T00:00:00.000Z";
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const event = (overrides: Partial<CanonicalEvent> & { id: string }): CanonicalEvent => ({
  personId: "person_1",
  sourceId: "source_1",
  sourceApplication: "synthetic",
  sourceProfileId: "default",
  nativeSessionId: "session_1",
  nativeEventId: overrides.id,
  nativeSequence: 1,
  causalParentId: null,
  role: "user",
  content: `content ${overrides.id}`,
  occurredAt: NOW,
  importedAt: NOW,
  provenance: "direct_user_input",
  trustLevel: "high",
  contentHash: `hash_${overrides.id}`,
  parserVersion: "synthetic/v1",
  metadata: {},
  ...overrides
} as CanonicalEvent);

async function sqliteStore(): Promise<SqliteStore> {
  const directory = await mkdtemp(join(tmpdir(), "spine-"));
  cleanup.push(directory);
  return new SqliteStore(join(directory, "memory.db"), {});
}

const implementations: [string, () => Promise<MemoryStore>][] = [
  ["InMemoryStore", async () => new InMemoryStore()],
  ["SqliteStore", async () => sqliteStore()]
];

describe.each(implementations)("%s canonical event spine", (_name, create) => {
  it("returns keys in exactly the same order, and for the same events, as listCanonicalEvents", async () => {
    const store = await create();
    // Deliberately inserted out of order, and with ties on occurredAt and on nativeSequence, so the
    // full three-part ordering (occurredAt, nativeSequence, id) is exercised rather than just the
    // first component.
    const events = [
      event({ id: "e_c", occurredAt: "2026-08-02T00:00:02.000Z", nativeSequence: 1 }),
      event({ id: "e_a", occurredAt: "2026-08-02T00:00:01.000Z", nativeSequence: 2 }),
      event({ id: "e_b", occurredAt: "2026-08-02T00:00:01.000Z", nativeSequence: 1 }),
      event({ id: "e_e", occurredAt: "2026-08-02T00:00:03.000Z", nativeSequence: 1 }),
      event({ id: "e_d", occurredAt: "2026-08-02T00:00:03.000Z", nativeSequence: 1 })
    ];
    for (const item of events) await store.saveCanonicalEvent(item);

    const full = await store.listCanonicalEvents("person_1");
    const keys = await store.listCanonicalEventKeys("person_1");

    expect(keys).toEqual(full.map((item) => ({
      id: item.id,
      occurredAt: item.occurredAt,
      nativeSequence: item.nativeSequence
    })));
  });

  it("scopes the spine to one person", async () => {
    const store = await create();
    await store.saveCanonicalEvent(event({ id: "mine" }));
    await store.saveCanonicalEvent(event({ id: "theirs", personId: "person_2", sourceId: "source_2" }));

    const keys = await store.listCanonicalEventKeys("person_1");
    expect(keys.map((key) => key.id)).toEqual(["mine"]);
  });

  it("returns an empty spine for a person with no events", async () => {
    const store = await create();
    await expect(store.listCanonicalEventKeys("person_absent")).resolves.toEqual([]);
  });

  it("reports each distinct (sourceId, scopeId) pair exactly once", async () => {
    const store = await create();
    await store.saveCanonicalEvent(event({ id: "a", sourceId: "source_1", scopeId: "work" }));
    await store.saveCanonicalEvent(event({ id: "b", sourceId: "source_1", scopeId: "work" }));
    await store.saveCanonicalEvent(event({ id: "c", sourceId: "source_1", scopeId: "personal" }));
    await store.saveCanonicalEvent(event({ id: "d", sourceId: "source_2", scopeId: "work" }));

    const pairs = await store.listCanonicalEventScopePairs("person_1");
    expect([...pairs].sort((left, right) =>
      left.sourceId.localeCompare(right.sourceId) || left.scopeId.localeCompare(right.scopeId)
    )).toEqual([
      { sourceId: "source_1", scopeId: "personal" },
      { sourceId: "source_1", scopeId: "work" },
      { sourceId: "source_2", scopeId: "work" }
    ]);
  });

  it("defaults a missing scope to personal, matching the caller's own `scopeId ?? personal`", async () => {
    // If the store reported null here and the caller defaulted separately, an unscoped event and a
    // "personal" event would look like two different pairs and the scope assertion would reject a
    // corpus that is in fact sound.
    const store = await create();
    await store.saveCanonicalEvent(event({ id: "unscoped" }));
    await store.saveCanonicalEvent(event({ id: "explicit", scopeId: "personal" }));

    await expect(store.listCanonicalEventScopePairs("person_1"))
      .resolves.toEqual([{ sourceId: "source_1", scopeId: "personal" }]);
  });

  it("keeps one person's scope pairs out of another's", async () => {
    const store = await create();
    await store.saveCanonicalEvent(event({ id: "mine", sourceId: "source_1", scopeId: "personal" }));
    await store.saveCanonicalEvent(event({
      id: "theirs", personId: "person_2", sourceId: "source_secret", scopeId: "classified"
    }));

    const pairs = await store.listCanonicalEventScopePairs("person_1");
    expect(pairs).toEqual([{ sourceId: "source_1", scopeId: "personal" }]);
  });

  it("reflects deletions rather than serving a stale spine", async () => {
    const store = await create();
    await store.saveCanonicalEvent(event({ id: "keep", occurredAt: "2026-08-02T00:00:01.000Z" }));
    await store.saveCanonicalEvent(event({ id: "drop", occurredAt: "2026-08-02T00:00:02.000Z", scopeId: "work" }));

    await store.deleteCanonicalEvents(["drop"]);

    await expect(store.listCanonicalEventKeys("person_1"))
      .resolves.toEqual([{ id: "keep", occurredAt: "2026-08-02T00:00:01.000Z", nativeSequence: 1 }]);
    await expect(store.listCanonicalEventScopePairs("person_1"))
      .resolves.toEqual([{ sourceId: "source_1", scopeId: "personal" }]);
  });
});

describe("SqliteStore spine query plans", () => {
  /**
   * These assert on the PLAN, not on elapsed time, because that is what the optimization actually
   * is. Both queries return correct results either way -- they just read every payload in the
   * corpus first, which is exactly the 19.7 s and 15.2 s this work removed. A timing assertion
   * would be flaky on a loaded machine and would pass on a small fixture regardless.
   */
  it("answers the key spine from a covering index, without touching the table", async () => {
    const store = await sqliteStore();
    await store.saveCanonicalEvent(event({ id: "a" }));

    const plan = (store as unknown as { database: { prepare(sql: string): { all(...args: unknown[]): unknown[] } } })
      .database
      .prepare(`explain query plan
        select id, occurred_at as occurredAt, native_sequence as nativeSequence
        from canonical_events where person_id = ?
        order by occurred_at asc, native_sequence asc, id asc`)
      .all("person_1") as { detail: string }[];

    expect(plan.map((row) => row.detail).join(" ")).toMatch(/COVERING INDEX idx_canonical_events_person_order/);
  });

  /**
   * Regression guard for a 388x self-inflicted one. `listCanonicalEventsByIds` reads a bounded id
   * batch and must resolve it through the PRIMARY KEY. Migration 5 added a second
   * person_id-leading index, and SQLite immediately preferred it for
   * `where person_id = ? and id in (...)` -- scanning all 292,407 of the person's index entries to
   * find a few hundred ids, 10.086 s against 0.026 s on the live corpus.
   *
   * That silently broke two separate optimizations at once: the contraction window this work exists
   * for, and the import-diff path that stopped loading every canonical event. Neither would have
   * failed a test; both would just have been slow again.
   */
  it("resolves an id batch through the primary key, not a person_id-leading index", async () => {
    const store = await sqliteStore();
    await store.saveCanonicalEvent(event({ id: "a" }));
    await store.saveCanonicalEvent(event({ id: "b" }));

    const plan = (store as unknown as { database: { prepare(sql: string): { all(...args: unknown[]): unknown[] } } })
      .database
      .prepare("explain query plan select payload from canonical_events where +person_id = ? and id in (?, ?)")
      .all("person_1", "a", "b") as { detail: string }[];

    const detail = plan.map((row) => row.detail).join(" ");
    expect(detail).toMatch(/sqlite_autoindex_canonical_events_1|PRIMARY KEY/i);
    expect(detail).not.toMatch(/idx_canonical_events_person_scope/);
  });

  it("answers the scope pairs from migration 5's expression index", async () => {
    const store = await sqliteStore();
    await store.saveCanonicalEvent(event({ id: "a" }));

    const plan = (store as unknown as { database: { prepare(sql: string): { all(...args: unknown[]): unknown[] } } })
      .database
      .prepare(`explain query plan
        select json_extract(payload,'$.sourceId') as sourceId,
               coalesce(json_extract(payload,'$.scopeId'),'personal') as scopeId
        from canonical_events where person_id = ?
        group by sourceId, scopeId`)
      .all("person_1") as { detail: string }[];

    expect(plan.map((row) => row.detail).join(" ")).toMatch(/idx_canonical_events_person_scope/);
  });
});
