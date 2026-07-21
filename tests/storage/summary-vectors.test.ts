import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";
import type {
  FindNearestSummariesQuery,
  MemoryStore,
  SummaryVectorRecord
} from "../../src/storage/memory-store.js";
import type { Summary } from "../../src/domain/types.js";

const PROVIDER_A = "deterministic";
const MODEL_A = "keyword-hash-v1";
const PROVIDER_B = "deterministic";
const MODEL_B = "keyword-hash-v2";

/**
 * `listSummaryIdsMissingVector` (D-05) is a set-difference against known summaries: it returns
 * summary ids that exist but lack a vector for the queried (provider, model) pair. Callers must
 * register the summary itself via `saveSummary` for it to be part of that universe — a vector
 * row alone does not make a summary "known" (Rule 1 fix: the original fixture only saved vector
 * rows and asserted results that require the summaries to exist).
 */
const summaryRecord = (overrides: Partial<Summary> = {}): Summary => ({
  id: "summary_1",
  summaryText: "Fixture summary for vector storage tests.",
  sourceTurnRanges: [],
  sourceSummaryIds: [],
  boxIds: [],
  embedding: null,
  createdAt: "2026-07-21T12:00:00.000Z",
  model: "test-summarizer",
  promptVersion: "v1",
  confidence: 0.9,
  state: "compacted",
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

const vectorRecord = (overrides: Partial<SummaryVectorRecord> = {}): SummaryVectorRecord => ({
  summaryId: "summary_1",
  provider: PROVIDER_A,
  model: MODEL_A,
  dimensions: 4,
  vector: [0.5, -0.25, 0.75, 0.1],
  personId: "person_1",
  scopeIds: ["personal"],
  createdAt: "2026-07-21T12:00:00.000Z",
  ...overrides
});

const backends: Array<{
  name: string;
  create: () => Promise<{ store: MemoryStore; cleanup(): Promise<void> }>;
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
      const tempDir = await mkdtemp(join(tmpdir(), "summary-vectors-"));
      const databasePath = join(tempDir, "memory.db");
      const store = new SqliteStore(databasePath, { clock: { now: () => "2026-07-21T12:00:00.000Z" } });
      return {
        store,
        cleanup: async () => {
          store.close();
          await rm(tempDir, { force: true, recursive: true });
        }
      };
    }
  }
];

for (const backend of backends) {
  describe(`${backend.name} summary_vectors`, () => {
    let store: MemoryStore;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      const created = await backend.create();
      store = created.store;
      cleanup = created.cleanup;
    });

    afterEach(async () => {
      await cleanup();
    });

    it("round-trips a saved vector with byte-identical fidelity (SC1)", async () => {
      const record = vectorRecord();
      await store.saveSummaryVector(record);

      const loaded = await store.getSummaryVector(record.summaryId, record.provider, record.model);

      expect(loaded).not.toBeNull();
      expect(loaded!.vector).toEqual(record.vector);
      expect(loaded!.provider).toBe(record.provider);
      expect(loaded!.model).toBe(record.model);
      expect(loaded!.dimensions).toBe(record.dimensions);
      expect(loaded!.personId).toBe(record.personId);
      expect(loaded!.scopeIds).toEqual(record.scopeIds);
    });

    it("returns null for a summary vector that was never saved", async () => {
      const loaded = await store.getSummaryVector("summary_missing", PROVIDER_A, MODEL_A);
      expect(loaded).toBeNull();
    });

    it("lists exactly the summary ids missing a (provider, model) vector, in stable ascending order (SC2, D-05)", async () => {
      const allSummaryIds = ["summary_a", "summary_b", "summary_c", "summary_d"];
      const savedUnderA = new Set(["summary_a", "summary_c"]);

      for (const summaryId of allSummaryIds) {
        await store.saveSummary(summaryRecord({ id: summaryId }));
      }

      for (const summaryId of allSummaryIds) {
        if (savedUnderA.has(summaryId)) {
          await store.saveSummaryVector(
            vectorRecord({ summaryId, provider: PROVIDER_A, model: MODEL_A })
          );
        }
      }

      const missingUnderA = await store.listSummaryIdsMissingVector(PROVIDER_A, MODEL_A);
      const missingUnderB = await store.listSummaryIdsMissingVector(PROVIDER_B, MODEL_B);

      expect(missingUnderA).toEqual(["summary_b", "summary_d"]);
      expect(missingUnderB).toEqual([...allSummaryIds].sort());

      // Two consecutive calls must return identical output — this list is the Phase 10
      // backfill resume key and must be stable across calls (Pitfall 2).
      const missingUnderARepeat = await store.listSummaryIdsMissingVector(PROVIDER_A, MODEL_A);
      expect(missingUnderARepeat).toEqual(missingUnderA);
    });

    it("never returns another person's or out-of-scope summary from findNearestSummaries, even when it would out-score every authorized row (SC4, D-06, Pitfall 1)", async () => {
      // The unauthorized vector is an exact match for the query; every authorized vector is
      // deliberately weaker, so a boundary bug (score-before-filter) would surface it first.
      const queryVector = [1, 0, 0, 0];

      await store.saveSummaryVector(
        vectorRecord({
          summaryId: "summary_other_person",
          personId: "person_2",
          scopeIds: ["personal"],
          vector: [1, 0, 0, 0]
        })
      );
      await store.saveSummaryVector(
        vectorRecord({
          summaryId: "summary_out_of_scope",
          personId: "person_1",
          scopeIds: ["work"],
          vector: [1, 0, 0, 0]
        })
      );
      await store.saveSummaryVector(
        vectorRecord({
          summaryId: "summary_authorized",
          personId: "person_1",
          scopeIds: ["personal"],
          vector: [0.6, 0.4, 0, 0]
        })
      );

      const query: FindNearestSummariesQuery = {
        vector: queryVector,
        provider: PROVIDER_A,
        model: MODEL_A,
        personId: "person_1",
        allowedScopeIds: ["personal"],
        topK: 10
      };

      const matches = await store.findNearestSummaries(query);
      const matchedIds = matches.map((match) => match.summaryId);

      expect(matchedIds).toContain("summary_authorized");
      expect(matchedIds).not.toContain("summary_other_person");
      expect(matchedIds).not.toContain("summary_out_of_scope");
    });

    it("tombstones a summary's vector rows across both (provider, model) rows (SC4, D-09)", async () => {
      const summaryId = "summary_tombstone";

      await store.saveSummaryVector(
        vectorRecord({ summaryId, provider: PROVIDER_A, model: MODEL_A, vector: [1, 0, 0, 0] })
      );
      await store.saveSummaryVector(
        vectorRecord({ summaryId, provider: PROVIDER_B, model: MODEL_B, vector: [1, 0, 0, 0] })
      );

      await store.deleteSummaryVectors([summaryId]);

      const afterDeleteA = await store.getSummaryVector(summaryId, PROVIDER_A, MODEL_A);
      const afterDeleteB = await store.getSummaryVector(summaryId, PROVIDER_B, MODEL_B);
      expect(afterDeleteA).toBeNull();
      expect(afterDeleteB).toBeNull();

      const matches = await store.findNearestSummaries({
        vector: [1, 0, 0, 0],
        provider: PROVIDER_A,
        model: MODEL_A,
        personId: "person_1",
        allowedScopeIds: ["personal"],
        topK: 10
      });
      expect(matches.map((match) => match.summaryId)).not.toContain(summaryId);
    });

    // Authored once both SqliteStore and InMemoryStore implement the vector surface (plan 08-04):
    // asserts both backends return identical (summaryId, score) sequences for the same corpus/query.
    it.todo("SqliteStore and InMemoryStore return identical (summaryId, score) sequences");
  });
}
