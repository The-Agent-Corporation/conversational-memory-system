import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";
import type { MemoryStore } from "../../src/storage/memory-store.js";
import type { Summary } from "../../src/domain/types.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (
    location: string,
    options?: { readOnly?: boolean; timeout?: number }
  ) => {
    close(): void;
    prepare(sql: string): { all(...anonymousParameters: unknown[]): unknown[] };
  };
};

const makeSummary = (overrides: Partial<Summary> = {}): Summary => ({
  id: "summary_1",
  personId: "person_1",
  scopeIds: ["personal"],
  summaryText: "Fixture summary for store-filter parity tests.",
  sourceTurnRanges: [],
  sourceSummaryIds: [],
  boxIds: [],
  embedding: null,
  createdAt: "2026-07-21T12:00:00.000Z",
  model: "test-summarizer",
  promptVersion: "v1",
  confidence: 0.9,
  state: "active",
  detailLevel: "brief",
  tokenCount: 10,
  lastAccessedAt: null,
  version: 1,
  strength: 0.8,
  retrievalCount: 0,
  retrievedAt: null,
  halfLifeHours: 168,
  outcomeScore: null,
  ...overrides
});

// Fixture set exercising person, state, and scopeIds-subset filter dimensions deterministically
// (no Math.random / Date.now in content).
function seedFixtures(): Summary[] {
  return [
    makeSummary({ id: "summary_1", personId: "person_1", scopeIds: ["personal"], state: "active" }),
    makeSummary({ id: "summary_2", personId: "person_1", scopeIds: ["personal", "work"], state: "compacted" }),
    makeSummary({ id: "summary_3", personId: "person_1", scopeIds: undefined, state: "stale" }),
    makeSummary({ id: "summary_4", personId: "person_2", scopeIds: ["personal"], state: "active" }),
    makeSummary({ id: "summary_5", personId: "person_1", scopeIds: ["work"], state: "superseded" })
  ];
}

const backends: Array<{
  name: string;
  create: () => Promise<{ store: MemoryStore; cleanup(): Promise<void>; databasePath?: string }>;
}> = [
  {
    name: "InMemoryStore",
    create: async () => {
      const store = new InMemoryStore({ clock: { now: () => "2026-07-21T12:00:00.000Z" } });
      return { store, cleanup: async () => {} };
    }
  },
  {
    name: "SqliteStore",
    create: async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "summary-filter-"));
      const databasePath = join(tempDir, "memory.db");
      const store = new SqliteStore(databasePath, { clock: { now: () => "2026-07-21T12:00:00.000Z" } });
      return {
        store,
        databasePath,
        cleanup: async () => {
          store.close();
          await rm(tempDir, { force: true, recursive: true });
        }
      };
    }
  }
];

function sortedProjection(summaries: Summary[]): string[] {
  return summaries.map((summary) => JSON.stringify(summary)).sort();
}

for (const backend of backends) {
  describe(`${backend.name} listSummaries filter`, () => {
    let store: MemoryStore;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      const created = await backend.create();
      store = created.store;
      cleanup = created.cleanup;
      for (const summary of seedFixtures()) {
        await store.saveSummary(summary);
      }
    });

    afterEach(async () => {
      await cleanup();
    });

    it("(a) returns every seeded row in ascending id order when called with no argument", async () => {
      const result = await store.listSummaries();
      expect(result.map((summary) => summary.id)).toEqual([
        "summary_1",
        "summary_2",
        "summary_3",
        "summary_4",
        "summary_5"
      ]);
    });

    it("(b) filters by personId only", async () => {
      const result = await store.listSummaries({ personId: "person_1" });
      expect(result.map((summary) => summary.id).sort()).toEqual(["summary_1", "summary_2", "summary_3", "summary_5"]);
    });

    it("(c) filters by states only", async () => {
      const result = await store.listSummaries({ states: ["active", "compacted"] });
      expect(result.map((summary) => summary.id).sort()).toEqual(["summary_1", "summary_2", "summary_4"]);
    });

    it("(d) applies personId, states, and scopeIds subset semantics together", async () => {
      const result = await store.listSummaries({
        personId: "person_1",
        states: ["active", "compacted", "stale"],
        scopeIds: ["personal"]
      });
      // summary_2 requires both "personal" and "work" to be allowed -> excluded when only "personal" is allowed.
      expect(result.map((summary) => summary.id).sort()).toEqual(["summary_1", "summary_3"]);
    });

    it("(e) treats undefined scopeIds as [\"personal\"]", async () => {
      const result = await store.listSummaries({
        personId: "person_1",
        states: ["stale"],
        scopeIds: ["personal"]
      });
      expect(result.map((summary) => summary.id)).toEqual(["summary_3"]);

      const excluded = await store.listSummaries({
        personId: "person_1",
        states: ["stale"],
        scopeIds: ["work"]
      });
      expect(excluded.map((summary) => summary.id)).toEqual([]);
    });
  });
}

describe("SqliteStore vs InMemoryStore listSummaries filter parity", () => {
  const filters: Array<{ name: string; filter: Parameters<MemoryStore["listSummaries"]>[0] }> = [
    { name: "no filter", filter: undefined },
    { name: "personId only", filter: { personId: "person_1" } },
    { name: "states only", filter: { states: ["active", "compacted"] } },
    {
      name: "personId + states + scopeIds",
      filter: { personId: "person_1", states: ["active", "compacted", "stale"], scopeIds: ["personal"] }
    }
  ];

  for (const { name, filter } of filters) {
    it(`(f) returns byte-identical results for filter: ${name}`, async () => {
      const inMemory = new InMemoryStore({ clock: { now: () => "2026-07-21T12:00:00.000Z" } });
      for (const summary of seedFixtures()) {
        await inMemory.saveSummary(summary);
      }

      const tempDir = await mkdtemp(join(tmpdir(), "summary-filter-parity-"));
      const databasePath = join(tempDir, "memory.db");
      const sqlite = new SqliteStore(databasePath, { clock: { now: () => "2026-07-21T12:00:00.000Z" } });
      for (const summary of seedFixtures()) {
        await sqlite.saveSummary(summary);
      }

      const inMemoryResult = await inMemory.listSummaries(filter);
      const sqliteResult = await sqlite.listSummaries(filter);

      expect(sortedProjection(sqliteResult)).toEqual(sortedProjection(inMemoryResult));

      sqlite.close();
      await rm(tempDir, { force: true, recursive: true });
    });
  }

  it("uses idx_summaries_person_state for a personId+states filtered query (EXPLAIN QUERY PLAN)", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "summary-filter-explain-"));
    const databasePath = join(tempDir, "memory.db");
    const sqlite = new SqliteStore(databasePath, { clock: { now: () => "2026-07-21T12:00:00.000Z" } });
    for (const summary of seedFixtures()) {
      await sqlite.saveSummary(summary);
    }
    sqlite.close();

    const raw = new DatabaseSync(databasePath, { readOnly: true });
    const plan = raw
      .prepare(
        `explain query plan select payload from summaries
         where json_extract(payload,'$.personId') = ?
           and json_extract(payload,'$.state') in (?, ?)
         order by id asc`
      )
      .all("person_1", "active", "compacted") as Array<{ detail: string }>;
    raw.close();
    await rm(tempDir, { force: true, recursive: true });

    const detail = plan.map((row) => row.detail).join(" | ");
    expect(detail).toContain("idx_summaries_person_state");
  });
});
