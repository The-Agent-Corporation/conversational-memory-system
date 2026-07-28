import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteStore } from "../../src/storage/sqlite-store.js";
import type { Summary } from "../../src/domain/types.js";
import type { Embedder } from "../../src/embeddings/embedder.js";
import { DifferingIdentityEmbedder } from "../embeddings/fixtures.js";
import { writeEmbeddingsConfig } from "../../src/embeddings/embeddings-config.js";
import { runBackfillEmbeddingsCommand } from "../../src/operations/backfill-embeddings-command.js";

const PROVIDER = "deterministic";
const MODEL = "keyword-hash-v1";

const ONNX_MODEL_PATH = resolvePath(process.env.MEMORY_MODEL_PATH ?? "tests/fixtures/models");
const ONNX_MODEL_PRESENT = existsSync(join(ONNX_MODEL_PATH, "Xenova/bge-small-en-v1.5/onnx/model.onnx"));

/**
 * GAP-12-A: the command resolves its embedder internally, so a test that needs a
 * two-identity embedder overrides the resolver. `null` (the default) leaves the
 * real resolver in place, which is what the deterministic and ONNX cases use.
 */
const resolverOverride = vi.hoisted(() => ({ embedder: null as Embedder | null }));

vi.mock("../../src/embeddings/embedder-resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/embeddings/embedder-resolver.js")>();
  return {
    ...actual,
    resolveEmbedder: async (databasePath: string) =>
      resolverOverride.embedder ?? (await actual.resolveEmbedder(databasePath))
  };
});

const summaryRecord = (overrides: Partial<Summary> = {}): Summary => ({
  id: "summary_1",
  personId: "person_1",
  scopeIds: ["personal"],
  summaryText: "Fixture summary text for backfill testing purposes.",
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
} as Summary);

describe("backfill-embeddings-command", () => {
  let tempDir: string;
  let databasePath: string;
  let store: SqliteStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "backfill-embeddings-"));
    databasePath = join(tempDir, "memory.db");
    store = new SqliteStore(databasePath, { clock: { now: () => "2026-07-21T12:00:00.000Z" } });
  });

  afterEach(async () => {
    resolverOverride.embedder = null;
    store.close();
    await rm(tempDir, { force: true, recursive: true });
  });

  it("completes full corpus: leaves listSummaryIdsMissingVector empty after a full run", async () => {
    const total = 250;
    for (let i = 0; i < total; i += 1) {
      await store.saveSummary(
        summaryRecord({ id: `summary_${i}`, summaryText: `Summary body number ${i} about topic ${i % 7}.` })
      );
    }

    const result = await runBackfillEmbeddingsCommand({ databasePath });

    expect(result.ok).toBe(true);
    expect(result.provider).toBe(PROVIDER);
    expect(result.model).toBe(MODEL);
    expect(result.processed).toBe(total);
    expect(result.totalMissingAtStart).toBe(total);

    const missing = await store.listSummaryIdsMissingVector(PROVIDER, MODEL);
    expect(missing).toEqual([]);
  });

  it("resumes after interruption: kill mid-run via onBatchComplete then rerun reaches empty missing set with no duplicate re-embedding", async () => {
    const total = 30;
    for (let i = 0; i < total; i += 1) {
      await store.saveSummary(
        summaryRecord({ id: `summary_${i}`, summaryText: `Summary body number ${i} about resuming interrupted work.` })
      );
    }

    let batchCount = 0;
    await expect(
      runBackfillEmbeddingsCommand(
        { databasePath, batchSize: 5 },
        {
          onBatchComplete: async () => {
            batchCount += 1;
            if (batchCount === 2) {
              throw new Error("simulated kill mid-run");
            }
          }
        }
      )
    ).rejects.toThrow("simulated kill mid-run");

    const missingAfterKill = await store.listSummaryIdsMissingVector(PROVIDER, MODEL);
    expect(missingAfterKill.length).toBeGreaterThan(0);
    expect(missingAfterKill.length).toBeLessThan(total);

    const resumeResult = await runBackfillEmbeddingsCommand({ databasePath, batchSize: 5 });
    expect(resumeResult.ok).toBe(true);
    expect(resumeResult.processed).toBe(missingAfterKill.length);

    const missingAfterResume = await store.listSummaryIdsMissingVector(PROVIDER, MODEL);
    expect(missingAfterResume).toEqual([]);

    // No corrupt/duplicate vectors: every summary has exactly one vector row.
    for (let i = 0; i < total; i += 1) {
      const vector = await store.getSummaryVector(`summary_${i}`, PROVIDER, MODEL);
      expect(vector).not.toBeNull();
    }
  });

  it("idempotent rerun: a second complete run performs zero additional writes", async () => {
    const total = 20;
    for (let i = 0; i < total; i += 1) {
      await store.saveSummary(summaryRecord({ id: `summary_${i}`, summaryText: `Idempotent body ${i}.` }));
    }

    const first = await runBackfillEmbeddingsCommand({ databasePath });
    expect(first.processed).toBe(total);

    const saveSpy = vi.spyOn(store, "saveSummaryVectors");
    const saveSingleSpy = vi.spyOn(store, "saveSummaryVector");

    const second = await runBackfillEmbeddingsCommand({ databasePath });

    expect(second.processed).toBe(0);
    expect(saveSpy).not.toHaveBeenCalled();
    expect(saveSingleSpy).not.toHaveBeenCalled();

    const missingBefore = await store.listSummaryIdsMissingVector(PROVIDER, MODEL);
    expect(missingBefore).toEqual([]);
  });

  it("progress: emits one progress object per batch with processed/total monotonic to total", async () => {
    const total = 12;
    for (let i = 0; i < total; i += 1) {
      await store.saveSummary(summaryRecord({ id: `summary_${i}`, summaryText: `Progress body ${i}.` }));
    }

    const progressEvents: Array<{ processed: number; total: number }> = [];
    await runBackfillEmbeddingsCommand(
      { databasePath, batchSize: 5 },
      {
        progressSink: (line: string) => {
          const parsed = JSON.parse(line) as { event: string; processed: number; total: number };
          if (parsed.event === "progress") {
            progressEvents.push({ processed: parsed.processed, total: parsed.total });
          }
        }
      }
    );

    expect(progressEvents.length).toBeGreaterThan(0);
    for (const event of progressEvents) {
      expect(event.total).toBe(total);
    }
    let previousProcessed = 0;
    for (const event of progressEvents) {
      expect(event.processed).toBeGreaterThan(previousProcessed);
      expect(event.processed).toBeLessThanOrEqual(total);
      previousProcessed = event.processed;
    }
    expect(previousProcessed).toBe(total);
  });

  it("tags each saved vector with its own summary's personId/scopeIds, never a caller override", async () => {
    await store.saveSummary(
      summaryRecord({ id: "summary_person_a", personId: "person_a", scopeIds: ["work"], summaryText: "Person A body." })
    );
    await store.saveSummary(
      summaryRecord({ id: "summary_person_b", personId: "person_b", scopeIds: ["personal"], summaryText: "Person B body." })
    );

    await runBackfillEmbeddingsCommand({ databasePath });

    const vectorA = await store.getSummaryVector("summary_person_a", PROVIDER, MODEL);
    const vectorB = await store.getSummaryVector("summary_person_b", PROVIDER, MODEL);

    expect(vectorA).not.toBeNull();
    expect(vectorA!.personId).toBe("person_a");
    expect(vectorA!.scopeIds).toEqual(["work"]);

    expect(vectorB).not.toBeNull();
    expect(vectorB!.personId).toBe("person_b");
    expect(vectorB!.scopeIds).toEqual(["personal"]);
  });

  it("fails loud when a summary has no personId, instead of tagging a sentinel", async () => {
    await store.saveSummary(
      summaryRecord({ id: "summary_no_person", personId: undefined, summaryText: "No person body." })
    );

    await expect(runBackfillEmbeddingsCommand({ databasePath })).rejects.toThrow();

    const vector = await store.getSummaryVector("summary_no_person", PROVIDER, MODEL);
    expect(vector).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // GAP-12-A: convergence under an embedder whose two identities would differ.
  // The cases above all run `DeterministicEmbedder`, the one embedder whose class
  // `model` and emitted `model` coincide — which is why they passed while the
  // missing set never shrank for the ONNX embedder.
  // ---------------------------------------------------------------------------

  it("tripwire: a two-identity embedder advertises exactly what it stamps", async () => {
    const embedder = new DifferingIdentityEmbedder({ revision: "r1" });

    expect(embedder.revision).not.toBe("");
    expect(embedder.model).not.toBe(embedder.repo);
    expect(embedder.model).toBe((await embedder.embed("x")).model);
  });

  it("converges under a two-identity embedder: missing set empties and a rerun writes nothing", async () => {
    const embedder = new DifferingIdentityEmbedder({ revision: "r1" });
    resolverOverride.embedder = embedder;

    const total = 25;
    for (let i = 0; i < total; i += 1) {
      await store.saveSummary(
        summaryRecord({ id: `summary_${i}`, summaryText: `Two-identity body number ${i}.` })
      );
    }

    const first = await runBackfillEmbeddingsCommand({ databasePath, batchSize: 10 });
    expect(first.model).toBe(embedder.model);
    expect(first.totalMissingAtStart).toBe(total);
    expect(first.processed).toBe(total);

    // The query key that produced the missing set is the same key the rows were
    // written under, so the missing set actually shrinks to zero.
    const missing = await store.listSummaryIdsMissingVector(embedder.provider, embedder.model);
    expect(missing).toEqual([]);

    const embedCallsAfterFirst = embedder.embedCalls;
    const second = await runBackfillEmbeddingsCommand({ databasePath, batchSize: 10 });

    expect(second.totalMissingAtStart).toBe(0);
    expect(second.processed).toBe(0);
    // Not one re-embed: this is the property whose absence would make a daemon
    // repair pass re-embed the whole corpus every tick.
    expect(embedder.embedCalls).toBe(embedCallsAfterFirst);
  });

  it("skips non-retrievable summaries' state load without failing on them", async () => {
    const embedder = new DifferingIdentityEmbedder({ revision: "r1" });
    resolverOverride.embedder = embedder;

    await store.saveSummary(summaryRecord({ id: "summary_active", state: "active", summaryText: "Active body." }));
    await store.saveSummary(
      summaryRecord({ id: "summary_superseded", state: "superseded", summaryText: "Superseded body." })
    );

    const result = await runBackfillEmbeddingsCommand({ databasePath });

    expect(result.ok).toBe(true);
    expect(await store.getSummaryVector("summary_active", embedder.provider, embedder.model)).not.toBeNull();
    // A superseded id the store's missing-set query still returns falls through
    // the command's defensive `if (!summary) continue` rather than throwing.
    expect(await store.getSummaryVector("summary_superseded", embedder.provider, embedder.model)).toBeNull();
  });

  it.runIf(ONNX_MODEL_PRESENT)(
    "converges under the real TransformerEmbedder: missing set empties and a rerun writes nothing",
    async () => {
      writeEmbeddingsConfig(databasePath, {
        enabled: true,
        provider: "onnx-transformers",
        model: "Xenova/bge-small-en-v1.5",
        revision: "main",
        modelPath: ONNX_MODEL_PATH
      });

      const total = 3;
      for (let i = 0; i < total; i += 1) {
        await store.saveSummary(summaryRecord({ id: `summary_${i}`, summaryText: `ONNX body number ${i}.` }));
      }

      const first = await runBackfillEmbeddingsCommand({ databasePath });
      expect(first.provider).toBe("onnx-transformers");
      expect(first.model).toBe("Xenova/bge-small-en-v1.5@main");
      expect(first.processed).toBe(total);

      const missing = await store.listSummaryIdsMissingVector(first.provider, first.model);
      expect(missing).toEqual([]);

      const second = await runBackfillEmbeddingsCommand({ databasePath });
      expect(second.totalMissingAtStart).toBe(0);
      expect(second.processed).toBe(0);
    },
    120_000
  );
});
