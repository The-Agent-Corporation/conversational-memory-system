import { SummarySchema, type Summary } from "../../src/domain/types.js";
import type { MemoryStore, SummaryVectorRecord } from "../../src/storage/memory-store.js";

// Tenfold separation exposes a growing term while both fixtures remain quick to build.
export const SMALL_CORPUS = 50;
export const LARGE_CORPUS = 500;

export interface VectorCorpusOptions {
  store: MemoryStore;
  personId: string;
  summaryCount: number;
  dimensions?: number;
  seed: number;
  scopeIds?: string[];
  provenanceIncomplete?: number;
  createdAtStart?: string;
  createdAtStepMinutes?: number;
}

export interface VectorCorpus {
  summaryIds: string[];
  vectors: number[][];
}

export async function buildVectorCorpus(options: VectorCorpusOptions): Promise<VectorCorpus> {
  const dimensions = options.dimensions ?? 384;
  const clusterCount = Math.max(2, Math.floor(options.summaryCount / 10));
  const scopeIds = options.scopeIds ?? ["personal"];
  const incompleteCount = options.provenanceIncomplete ?? 0;
  const start = Date.parse(options.createdAtStart ?? "2026-01-01T00:00:00.000Z");
  const step = options.createdAtStepMinutes ?? 1;

  if (!Number.isInteger(options.summaryCount) || options.summaryCount < 0) {
    throw new Error("summaryCount must be a non-negative integer");
  }
  if (!Number.isInteger(dimensions) || dimensions < clusterCount) {
    throw new Error("dimensions must be an integer at least as large as clusterCount");
  }
  if (!Number.isInteger(incompleteCount) || incompleteCount < 0 || incompleteCount > options.summaryCount) {
    throw new Error("provenanceIncomplete must be between zero and summaryCount");
  }
  if (scopeIds.length === 0) {
    throw new Error("scopeIds must contain at least one scope");
  }
  if (!Number.isFinite(start) || !Number.isFinite(step) || step <= 0) {
    throw new Error("createdAtStart and createdAtStepMinutes must define increasing timestamps");
  }

  const random = xorshift32(options.seed);
  const summaryIds: string[] = [];
  const vectors: number[][] = [];
  const vectorRows: SummaryVectorRecord[] = [];

  for (let index = 0; index < options.summaryCount; index += 1) {
    const id = `summary_${options.seed}_${String(index).padStart(4, "0")}`;
    const createdAt = new Date(start + index * step * 60_000).toISOString();
    const vector = clusteredVector(index % clusterCount, dimensions, random);
    const summary = SummarySchema.parse({
      id,
      personId: options.personId,
      scopeIds: index < incompleteCount ? [] : [...scopeIds],
      origin: "historical_bootstrap",
      summaryText: `Deterministic clustered summary ${index}`,
      sourceTurnRanges: [{ threadId: `thread_${options.seed}`, startSequence: index, endSequence: index }],
      sourceCanonicalEventIds: [`event_${options.seed}_${index}`],
      sourceSummaryIds: [],
      boxIds: [],
      embedding: null,
      createdAt,
      model: "fixture-summarizer",
      promptVersion: "fixture-v1",
      confidence: 1,
      state: "active",
      detailLevel: "brief",
      tokenCount: 4,
      lastAccessedAt: null,
      version: 1,
      strength: 1,
      retrievalCount: 0,
      retrievedAt: null,
      halfLifeHours: 168,
      outcomeScore: null
    }) satisfies Summary;

    await options.store.saveSummary(summary);
    summaryIds.push(id);
    vectors.push(vector);
    vectorRows.push({
      summaryId: id,
      provider: "fixture",
      model: "clustered-xorshift32-v1",
      dimensions,
      vector,
      personId: options.personId,
      scopeIds: [...summary.scopeIds!],
      createdAt
    });
  }

  await options.store.saveSummaryVectors(vectorRows);
  return { summaryIds, vectors };
}

function xorshift32(seed: number): () => number {
  let state = seed | 0;
  if (state === 0) state = 0x6d2b79f5;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function clusteredVector(cluster: number, dimensions: number, random: () => number): number[] {
  const vector = Array.from({ length: dimensions }, (_, dimension) =>
    (dimension === cluster ? 1 : 0) + (random() - 0.5) * 0.01
  );
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map((value) => value / magnitude);
}
