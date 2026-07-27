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
  // All four values are exactly representable in float32 so SqliteStore's Float32 BLOB round-trip
  // (encode -> decode) yields the identical JS number that InMemoryStore keeps verbatim (Wave 2 handoff).
  vector: [0.5, -0.25, 0.75, 0.125],
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

      // GAP-11-A sweep: findNearestSummaries now also drops a vector whose summary row is
      // absent or non-retrievable, so every summaryId used below needs a matching retrievable
      // summary row for this SC4/D-06 boundary assertion to still exercise person/scope, not
      // orphan-dropping.
      await store.saveSummary(summaryRecord({ id: "summary_other_person", state: "active", personId: "person_2" }));
      await store.saveSummary(summaryRecord({ id: "summary_out_of_scope", state: "active", personId: "person_1" }));
      await store.saveSummary(summaryRecord({ id: "summary_authorized", state: "active", personId: "person_1" }));

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

    it("drops a vector whose summary is superseded even when it is the nearest match (GAP-11-A sweep, T-11-26)", async () => {
      // Deterministic literal vectors, not random: query is an exact match for the superseded
      // row and a weaker (but still authorized) match for the active row.
      await store.saveSummary(summaryRecord({ id: "summary_active_state", state: "active", personId: "person_1" }));
      await store.saveSummary(summaryRecord({ id: "summary_superseded_state", state: "superseded", personId: "person_1" }));
      await store.saveSummaryVector(
        vectorRecord({ summaryId: "summary_active_state", vector: [0.6, 0.4, 0, 0] })
      );
      await store.saveSummaryVector(
        vectorRecord({ summaryId: "summary_superseded_state", vector: [1, 0, 0, 0] })
      );

      const matches = await store.findNearestSummaries({
        vector: [1, 0, 0, 0],
        provider: PROVIDER_A,
        model: MODEL_A,
        personId: "person_1",
        allowedScopeIds: ["personal"],
        topK: 10
      });
      const matchedIds = matches.map((match) => match.summaryId);

      expect(matchedIds).toContain("summary_active_state");
      expect(matchedIds).not.toContain("summary_superseded_state");
    });

    it("drops a vector whose summary row does not exist at all, an orphan (GAP-11-A sweep, T-11-26)", async () => {
      await store.saveSummary(summaryRecord({ id: "summary_present", state: "active", personId: "person_1" }));
      await store.saveSummaryVector(
        vectorRecord({ summaryId: "summary_present", vector: [0.6, 0.4, 0, 0] })
      );
      // "summary_orphan" is never saved via saveSummary -- only its vector row exists.
      await store.saveSummaryVector(
        vectorRecord({ summaryId: "summary_orphan", vector: [1, 0, 0, 0] })
      );

      const matches = await store.findNearestSummaries({
        vector: [1, 0, 0, 0],
        provider: PROVIDER_A,
        model: MODEL_A,
        personId: "person_1",
        allowedScopeIds: ["personal"],
        topK: 10
      });
      const matchedIds = matches.map((match) => match.summaryId);

      expect(matchedIds).toContain("summary_present");
      expect(matchedIds).not.toContain("summary_orphan");
    });

    it("rejects saveSummaryVector when dimensions !== vector.length (CR-01)", async () => {
      const record = vectorRecord({ dimensions: 8, vector: [1, 0, 0, 0] });
      await expect(store.saveSummaryVector(record)).rejects.toThrow(/dimensions/);
    });

    it("rejects saveSummaryVector when the vector contains a non-finite value (WR-02)", async () => {
      const record = vectorRecord({ vector: [1, Number.NaN, 0, 0] });
      await expect(store.saveSummaryVector(record)).rejects.toThrow(/non-finite/);
    });

    it("rejects saveSummaryVector when a value overflows float32 to Infinity (WR-06)", async () => {
      const record = vectorRecord({ vector: [1, 1e39, 0, 0] });
      await expect(store.saveSummaryVector(record)).rejects.toThrow(/non-finite/);
    });

    describe("saveSummaryVectors (batch write)", () => {
      it("produces byte-identical stored records to N sequential saveSummaryVector calls (parity)", async () => {
        const batch = [
          vectorRecord({ summaryId: "summary_batch_a", vector: [0.5, -0.25, 0.75, 0.125] }),
          vectorRecord({ summaryId: "summary_batch_b", vector: [1, 0, 0, 0] }),
          vectorRecord({ summaryId: "summary_batch_c", vector: [0, 1, 0, 0] })
        ];

        await store.saveSummaryVectors(batch);

        for (const record of batch) {
          const loaded = await store.getSummaryVector(record.summaryId, record.provider, record.model);
          expect(loaded).not.toBeNull();
          expect(loaded!.vector).toEqual(record.vector);
          expect(loaded!.provider).toBe(record.provider);
          expect(loaded!.model).toBe(record.model);
          expect(loaded!.dimensions).toBe(record.dimensions);
          expect(loaded!.personId).toBe(record.personId);
          expect(loaded!.scopeIds).toEqual(record.scopeIds);
        }

        // Compare against a fresh store populated one-record-at-a-time.
        const fresh = await backend.create();
        try {
          for (const record of batch) {
            await fresh.store.saveSummaryVector(record);
          }
          for (const record of batch) {
            const viaBatch = await store.getSummaryVector(record.summaryId, record.provider, record.model);
            const viaLoop = await fresh.store.getSummaryVector(record.summaryId, record.provider, record.model);
            expect(viaBatch).toEqual(viaLoop);
          }
        } finally {
          await fresh.cleanup();
        }
      });

      it("treats an empty array as a no-op that touches no rows", async () => {
        await store.saveSummary(summaryRecord({ id: "summary_untouched" }));

        await store.saveSummaryVectors([]);

        const missing = await store.listSummaryIdsMissingVector(PROVIDER_A, MODEL_A);
        expect(missing).toContain("summary_untouched");
        const loaded = await store.getSummaryVector("summary_untouched", PROVIDER_A, MODEL_A);
        expect(loaded).toBeNull();
      });

      it("upserts an already-present (summaryId, provider, model) row in place, no duplicate row", async () => {
        const original = vectorRecord({ summaryId: "summary_upsert", vector: [0.5, 0.5, 0.5, 0.5] });
        await store.saveSummaryVector(original);

        const updated = vectorRecord({ summaryId: "summary_upsert", vector: [1, 0, 0, 0] });
        await store.saveSummaryVectors([updated]);

        const loaded = await store.getSummaryVector("summary_upsert", PROVIDER_A, MODEL_A);
        expect(loaded).not.toBeNull();
        expect(loaded!.vector).toEqual(updated.vector);
      });

      it("rejects a batch containing one record with dimensions !== vector.length, same error as saveSummaryVector (CR-01)", async () => {
        const good = vectorRecord({ summaryId: "summary_batch_good_1" });
        const bad = vectorRecord({ summaryId: "summary_batch_bad", dimensions: 8, vector: [1, 0, 0, 0] });

        await expect(store.saveSummaryVectors([good, bad])).rejects.toThrow(/dimensions/);
      });

      it("rejects a batch containing one record with a non-finite value, same error as saveSummaryVector (WR-02)", async () => {
        const good = vectorRecord({ summaryId: "summary_batch_good_2" });
        const bad = vectorRecord({ summaryId: "summary_batch_nonfinite", vector: [1, Number.NaN, 0, 0] });

        await expect(store.saveSummaryVectors([good, bad])).rejects.toThrow(/non-finite/);
      });

      if (backend.name === "SqliteStore") {
        it("leaves zero rows from the batch committed when the LAST record fails validation (atomicity)", async () => {
          const summaryIds = ["summary_atomic_1", "summary_atomic_2", "summary_atomic_3"];
          for (const summaryId of summaryIds) {
            await store.saveSummary(summaryRecord({ id: summaryId }));
          }

          const batch = [
            vectorRecord({ summaryId: "summary_atomic_1" }),
            vectorRecord({ summaryId: "summary_atomic_2" }),
            vectorRecord({ summaryId: "summary_atomic_3", dimensions: 8, vector: [1, 0, 0, 0] })
          ];

          await expect(store.saveSummaryVectors(batch)).rejects.toThrow(/dimensions/);

          const missing = await store.listSummaryIdsMissingVector(PROVIDER_A, MODEL_A);
          for (const summaryId of summaryIds) {
            expect(missing).toContain(summaryId);
          }
          for (const summaryId of summaryIds) {
            const loaded = await store.getSummaryVector(summaryId, PROVIDER_A, MODEL_A);
            expect(loaded).toBeNull();
          }
        });
      }
    });

  });
}

// Cross-store exact-parity suite (plan 08-04): replaces the 08-01 `it.todo` placeholder.
// Asserts both backends return identical (summaryId, score) sequences for the same corpus/query.
describe("cross-store exact parity (SC3, D-07)", () => {
  // All vectors below use only float32-exact values (0.5, -0.25, 0.75, 0.125, 1, 0) so SqliteStore's
  // Float32 BLOB round-trip and InMemoryStore's exact number[] retention produce byte-identical
  // cosine scores -- toEqual, not toBeCloseTo, is the whole point of this test.
  const corpus: SummaryVectorRecord[] = [
    vectorRecord({ summaryId: "summary_alpha", vector: [0.5, -0.25, 0.75, 0.125] }),
    vectorRecord({ summaryId: "summary_beta", vector: [1, 0, 0, 0] }),
    vectorRecord({ summaryId: "summary_gamma", vector: [0, 1, 0, 0] }),
    // Engineered exact tie: summary_delta and summary_epsilon carry identical vectors, so they
    // must score identically against the query -- proving the summary_id-ascending tie-break
    // (D-07) resolves the order, not incidental corpus/backend iteration order.
    vectorRecord({ summaryId: "summary_delta", vector: [0.5, 0.5, 0.5, 0.5] }),
    vectorRecord({ summaryId: "summary_epsilon", vector: [0.5, 0.5, 0.5, 0.5] })
  ];

  const query: FindNearestSummariesQuery = {
    vector: [0.5, 0.5, 0.5, 0.5],
    provider: PROVIDER_A,
    model: MODEL_A,
    personId: "person_1",
    allowedScopeIds: ["personal"],
    topK: 10
  };

  async function seed(store: MemoryStore): Promise<void> {
    // GAP-11-A sweep: findNearestSummaries now drops a vector whose summary row is absent or
    // non-retrievable, so every corpus entry needs a matching active summary row in both stores.
    for (const record of corpus) {
      await store.saveSummary(summaryRecord({ id: record.summaryId, state: "active", personId: record.personId }));
      await store.saveSummaryVector(record);
    }
  }

  it("returns byte-identical (summaryId, score) sequences from SqliteStore and InMemoryStore, including tie-break order", async () => {
    const inMemory = await backends[0]!.create();
    const sqlite = await backends[1]!.create();

    try {
      await seed(inMemory.store);
      await seed(sqlite.store);

      const inMemoryResult = await inMemory.store.findNearestSummaries(query);
      const sqliteResult = await sqlite.store.findNearestSummaries(query);

      expect(sqliteResult).toEqual(inMemoryResult);
      // summary_delta and summary_epsilon are an exact cosine tie; ascending summary_id must win.
      const tieIds = sqliteResult
        .filter((match) => match.summaryId === "summary_delta" || match.summaryId === "summary_epsilon")
        .map((match) => match.summaryId);
      expect(tieIds).toEqual(["summary_delta", "summary_epsilon"]);
    } finally {
      await inMemory.cleanup();
      await sqlite.cleanup();
    }
  });

  it("slices to the same top segment when topK is smaller than the corpus", async () => {
    const inMemory = await backends[0]!.create();
    const sqlite = await backends[1]!.create();

    try {
      await seed(inMemory.store);
      await seed(sqlite.store);

      const narrowedQuery: FindNearestSummariesQuery = { ...query, topK: 3 };
      const inMemoryResult = await inMemory.store.findNearestSummaries(narrowedQuery);
      const sqliteResult = await sqlite.store.findNearestSummaries(narrowedQuery);

      expect(sqliteResult).toHaveLength(3);
      expect(sqliteResult).toEqual(inMemoryResult);
    } finally {
      await inMemory.cleanup();
      await sqlite.cleanup();
    }
  });

  it("applies an identical minimumScore keep-condition in both stores (SC3 gap 1)", async () => {
    const inMemory = await backends[0]!.create();
    const sqlite = await backends[1]!.create();

    try {
      await seed(inMemory.store);
      await seed(sqlite.store);

      // summary_beta = [1,0,0,0] against query [0.5,0.5,0.5,0.5] scores exactly 0.5 (float32-exact),
      // which sits at the minimumScore boundary -- both stores must keep it identically, and both
      // must drop summary_gamma = [0,1,0,0] (also exactly 0.5)... instead pick a threshold that
      // excludes at least one row unambiguously: 0.9 excludes summary_beta/gamma (score 0.5) but
      // keeps summary_delta/summary_epsilon (score 1.0, exact match to the query direction).
      const minimumScoreQuery: FindNearestSummariesQuery = { ...query, minimumScore: 0.9 };

      const inMemoryResult = await inMemory.store.findNearestSummaries(minimumScoreQuery);
      const sqliteResult = await sqlite.store.findNearestSummaries(minimumScoreQuery);

      expect(sqliteResult).toEqual(inMemoryResult);
      expect(sqliteResult.map((match) => match.summaryId)).not.toContain("summary_beta");
      expect(sqliteResult.map((match) => match.summaryId)).not.toContain("summary_gamma");
      expect(sqliteResult.map((match) => match.summaryId)).toEqual(
        expect.arrayContaining(["summary_delta", "summary_epsilon"])
      );
    } finally {
      await inMemory.cleanup();
      await sqlite.cleanup();
    }
  });

  it("skips a dimension-drifted row identically in both stores (WR-04)", async () => {
    const inMemory = await backends[0]!.create();
    const sqlite = await backends[1]!.create();

    try {
      const wellFormed = vectorRecord({ summaryId: "summary_wellformed", dimensions: 4, vector: [0.5, 0.5, 0.5, 0.5] });
      const drifted = vectorRecord({
        summaryId: "summary_drifted",
        dimensions: 2,
        vector: [0.5, 0.5]
      });

      for (const store of [inMemory.store, sqlite.store]) {
        await store.saveSummary(summaryRecord({ id: "summary_wellformed", state: "active", personId: "person_1" }));
        await store.saveSummary(summaryRecord({ id: "summary_drifted", state: "active", personId: "person_1" }));
      }
      await inMemory.store.saveSummaryVector(wellFormed);
      await inMemory.store.saveSummaryVector(drifted);
      await sqlite.store.saveSummaryVector(wellFormed);
      await sqlite.store.saveSummaryVector(drifted);

      const inMemoryResult = await inMemory.store.findNearestSummaries(query);
      const sqliteResult = await sqlite.store.findNearestSummaries(query);

      expect(sqliteResult).toEqual(inMemoryResult);
      const ids = sqliteResult.map((match) => match.summaryId);
      expect(ids).toContain("summary_wellformed");
      expect(ids).not.toContain("summary_drifted");
    } finally {
      await inMemory.cleanup();
      await sqlite.cleanup();
    }
  });
});
