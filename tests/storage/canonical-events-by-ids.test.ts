import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";
import type { MemoryStore } from "../../src/storage/memory-store.js";
import type { CanonicalEvent } from "../../src/domain/canonical.js";

/**
 * `listCanonicalEventsByIds` exists so an import can diff staged events against their durable
 * counterparts without loading every canonical event the person owns — 292,407 rows on the live
 * corpus to answer a handful of lookups. Both stores implement the full `MemoryStore` interface, so
 * both are exercised here against identical expectations.
 */
const NOW = "2026-08-02T00:00:00.000Z";

const event = (id: string, personId: string, nativeSequence: number): CanonicalEvent => ({
  id,
  personId,
  sourceId: `source_${personId}`,
  sourceApplication: "synthetic",
  sourceProfileId: "default",
  nativeSessionId: "session_1",
  nativeEventId: id,
  nativeSequence,
  causalParentId: null,
  role: "user",
  content: `content ${id}`,
  occurredAt: `2026-08-02T00:00:${String(nativeSequence % 60).padStart(2, "0")}.000Z`,
  importedAt: NOW,
  provenance: "direct_user_input",
  trustLevel: "high",
  contentHash: `hash_${id}`,
  parserVersion: "synthetic/v1",
  metadata: {}
});

describe.each([
  ["InMemoryStore", async () => ({ store: new InMemoryStore() as MemoryStore, cleanup: async () => {} })],
  ["SqliteStore", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canonical-by-ids-"));
    const store = new SqliteStore(join(dir, "test.db")) as MemoryStore;
    return { store, cleanup: async () => { await rm(dir, { recursive: true, force: true }); } };
  }]
])("listCanonicalEventsByIds (%s)", (_name, make) => {
  let store: MemoryStore;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ store, cleanup } = await (make as () => Promise<{ store: MemoryStore; cleanup: () => Promise<void> }>)());
    await store.saveCanonicalEvent(event("event-a", "person-1", 1));
    await store.saveCanonicalEvent(event("event-b", "person-1", 2));
    await store.saveCanonicalEvent(event("event-c", "person-2", 3));
  });

  afterEach(async () => { await cleanup(); });

  it("returns an empty array with no query for an empty id list", async () => {
    await expect(store.listCanonicalEventsByIds("person-1", [])).resolves.toEqual([]);
  });

  it("resolves only the requested ids", async () => {
    const found = await store.listCanonicalEventsByIds("person-1", ["event-a"]);
    expect(found.map((item) => item.id)).toEqual(["event-a"]);
  });

  it("never crosses the person boundary", async () => {
    // `event-c` exists, but belongs to person-2. Returning it would let one person's history
    // influence another's import diff.
    const found = await store.listCanonicalEventsByIds("person-1", ["event-a", "event-c"]);
    expect(found.map((item) => item.id)).toEqual(["event-a"]);
  });

  it("ignores ids that do not exist and de-duplicates repeats", async () => {
    const found = await store.listCanonicalEventsByIds("person-1", ["event-a", "event-a", "missing"]);
    expect(found.map((item) => item.id)).toEqual(["event-a"]);
  });

  it("orders by occurredAt, then nativeSequence, then id", async () => {
    const found = await store.listCanonicalEventsByIds("person-1", ["event-b", "event-a"]);
    expect(found.map((item) => item.id)).toEqual(["event-a", "event-b"]);
  });

  it("resolves a batch larger than the sqlite chunk size", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 1200; index += 1) {
      const id = `bulk-${String(index).padStart(4, "0")}`;
      ids.push(id);
      await store.saveCanonicalEvent(event(id, "person-1", 100 + index));
    }
    const found = await store.listCanonicalEventsByIds("person-1", ids);
    expect(found).toHaveLength(1200);
  });
});
