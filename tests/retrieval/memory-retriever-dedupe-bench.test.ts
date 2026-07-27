import { beforeAll, describe, expect, it } from "vitest";
import { dedupeRankedMemory, type RankedMemory } from "../../src/retrieval/memory-retriever.js";
import { generateDedupeCases, naiveDedupeReference } from "./memory-retriever-dedupe.test.js";

// ---------------------------------------------------------------------------
// GAP-11-B deterministic in-process benchmark.
//
// Imports `naiveDedupeReference` (the oracle) and `generateDedupeCases` (the fixture generator)
// by name from Task 1's file rather than re-transcribing the algorithm a third time. Importing a
// `.test.ts` file re-registers its suites here too, so Task 1's equivalence suite runs twice in a
// full `npx vitest run` pass -- accepted, costs milliseconds, and is the price of transcribing
// the oracle exactly once.
//
// This file opens no database, touches no filesystem, and references no owner-corpus path. It
// drives the exported pure `dedupeRankedMemory`/`naiveDedupeReference` functions directly, never
// `prepareInjection`.
// ---------------------------------------------------------------------------

// Live baseline (GAP-11-B, instrumented against the real store): ~48,900 pairs/sec, dominated by
// normalizedMemoryText(summary.text) over summary bodies with a mean of ~5-10 KB and a documented
// tail reaching ~800 KB. The fixture below reproduces that SIZE DISTRIBUTION, not just the mean,
// so the naive arm's throughput is a defensible proxy for the live corpus (assertion 2) and the
// naive:optimized ratio measured against it is a defensible proxy for the live gain.
const SUMMARY_TIERS: Array<{ tierIndex: number; targetBytes: number; count: number }> = [
  { tierIndex: 0, targetBytes: 800_000, count: 2 }, // ~0.5% of 400 -- the documented tail
  { tierIndex: 1, targetBytes: 100_000, count: 8 }, // ~2%
  { tierIndex: 2, targetBytes: 10_000, count: 30 }, // ~7.5%
  { tierIndex: 3, targetBytes: 1_000, count: 360 } // ~90%
];
const ANCHOR_COUNT = 500;
const COVERED_ANCHOR_COUNT = 50;
const DUPLICATE_ANCHOR_PAIR_COUNT = 5;
// Reuse Task 1's generator too (not just its oracle) so the case-type diversity pinned there --
// empty box ids, disjoint threads, duplicate anchor texts, trace/box_context entries interleaved
// among summaries/anchors -- is also exercised at benchmark scale.
const REUSED_GENERATOR_CASE_COUNT = 40;
const REUSED_GENERATOR_SEED = 987_654;

const BENCH_WORD_POOL = [
  "orbit", "ledger", "triage", "cadence", "lumen", "fjord", "quartz", "ember", "thicket", "paragon",
  "cobalt", "drift", "harbor", "kernel", "meadow", "nimbus", "opal", "pillar", "quiver", "ripple"
];

function benchPoolWord(index: number): string {
  return BENCH_WORD_POOL[index % BENCH_WORD_POOL.length];
}

function benchFillerText(wordCount: number, seedOffset: number): string {
  const words: string[] = [];
  for (let i = 0; i < wordCount; i += 1) {
    words.push(benchPoolWord(i + seedOffset));
  }
  return words.join(" ");
}

function buildTierSummaries(
  tierIndex: number,
  targetBytes: number,
  count: number
): { summaries: RankedMemory[]; coverageMarkers: string[] } {
  // ~6 chars/pool-word plus a separating space ~ 7 bytes/word.
  const wordCount = Math.max(3, Math.round(targetBytes / 7));
  const summaries: RankedMemory[] = [];
  const coverageMarkers: string[] = [];

  for (let i = 0; i < count; i += 1) {
    const id = `bench_sum_t${tierIndex}_${i}`;
    const isMarker = i % 5 === 0;
    const body = benchFillerText(wordCount, tierIndex * 100_000 + i);
    const marker = `bench-marker-t${tierIndex}-${i}z`;
    const text = isMarker ? `${marker} ${body}` : body;
    if (isMarker) {
      coverageMarkers.push(marker);
    }

    summaries.push({
      kind: "summary",
      id,
      text,
      score: 0.5,
      tokenCount: wordCount,
      canUseStub: true,
      scoringMethod: "keyword overlap",
      summaryId: id,
      summaryIds: [id],
      traceId: null,
      // Half the tier (plus every marker summary, to guarantee coverage) carries turn ranges, so
      // the optimized arm's thread guard actually rejects a meaningful share of pairs before the
      // substring search -- matching the interface note that the reorder's own contribution is
      // small on realistically-shaped data, since anchors always have empty sourceTurnRanges.
      sourceTurnRanges:
        isMarker || i % 2 === 0
          ? [{ threadId: `bench_thread_t${tierIndex}_${i % 11}`, startSequence: 0, endSequence: 1 }]
          : [],
      boxIds: i % 3 === 0 ? [`bench_box_t${tierIndex}_${i % 7}`] : []
    });
  }

  return { summaries, coverageMarkers };
}

function makeBenchAnchor(id: string, text: string): RankedMemory {
  return {
    kind: "anchor",
    id,
    text,
    score: 0.4,
    tokenCount: 5,
    canUseStub: false,
    scoringMethod: "keyword overlap",
    summaryId: null,
    summaryIds: [],
    traceId: null,
    // Anchors' sourceTurnRanges is always [] in the real shape (rankAnchor never populates it);
    // boxIds is [] or a single id -- kept empty here since box coverage is already exercised by
    // Task 1's reused fixture cases.
    sourceTurnRanges: [],
    boxIds: []
  };
}

function buildAnchors(count: number, coverageMarkers: string[]): RankedMemory[] {
  const anchors: RankedMemory[] = [];
  const coveredCount = Math.min(COVERED_ANCHOR_COUNT, coverageMarkers.length);

  for (let i = 0; i < coveredCount; i += 1) {
    anchors.push(makeBenchAnchor(`bench_anc_covered_${i}`, coverageMarkers[i]));
  }

  for (let pair = 0; pair < DUPLICATE_ANCHOR_PAIR_COUNT; pair += 1) {
    const text = `Duplicate   Bench   Anchor Marker ${pair}z`;
    anchors.push(makeBenchAnchor(`bench_anc_dup_a_${pair}`, text));
    anchors.push(makeBenchAnchor(`bench_anc_dup_b_${pair}`, text.toLowerCase().replace(/\s+/g, " ")));
  }

  let uncoveredIndex = 0;
  while (anchors.length < count) {
    anchors.push(makeBenchAnchor(`bench_anc_uncovered_${uncoveredIndex}`, `bench-uncovered-anchor-${uncoveredIndex}z`));
    uncoveredIndex += 1;
  }

  return anchors;
}

function buildBenchmarkFixture(): RankedMemory[] {
  const ranked: RankedMemory[] = [];
  const coverageMarkers: string[] = [];

  for (const tier of SUMMARY_TIERS) {
    const { summaries, coverageMarkers: tierMarkers } = buildTierSummaries(tier.tierIndex, tier.targetBytes, tier.count);
    ranked.push(...summaries);
    coverageMarkers.push(...tierMarkers);
  }

  ranked.push(...buildAnchors(ANCHOR_COUNT, coverageMarkers));

  const { ranked: reusedCases } = generateDedupeCases(REUSED_GENERATOR_CASE_COUNT, REUSED_GENERATOR_SEED, { padWords: 0 });
  ranked.push(...reusedCases);

  return ranked;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function timePasses<T>(run: () => T, passes: number): { samplesMs: number[]; lastResult: T } {
  const samplesMs: number[] = [];
  let lastResult: T | undefined;
  for (let pass = 0; pass < passes; pass += 1) {
    const startedAt = performance.now();
    lastResult = run();
    samplesMs.push(performance.now() - startedAt);
  }
  return { samplesMs, lastResult: lastResult as T };
}

describe("dedupeRankedMemory in-process benchmark (GAP-11-B / Plan 11-13 sufficiency gate)", () => {
  let anchorCount: number;
  let summaryCount: number;
  let naiveSamplesMs: number[];
  let optimizedSamplesMs: number[];
  let naiveMs: number;
  let optimizedMs: number;
  let pairsPerSecond: number;
  let naivePairsPerSecond: number;
  let naiveIds: string[];
  let optimizedIds: string[];

  beforeAll(() => {
    const ranked = buildBenchmarkFixture();
    anchorCount = ranked.filter((memory) => memory.kind === "anchor").length;
    summaryCount = ranked.filter((memory) => memory.kind === "summary").length;
    const pairs = anchorCount * summaryCount;

    // One warm-up pass of each arm over a ~10%-sized fixture, discarded.
    const warmupSlice = ranked.slice(0, Math.ceil(ranked.length * 0.1));
    naiveDedupeReference(warmupSlice);
    dedupeRankedMemory(warmupSlice);

    // Then 3 timed passes of the naive arm and 5 timed passes of the optimized arm over the
    // identical full fixture, in the same process. MEDIAN of each arm's samples, never the mean,
    // never a single sample.
    const naiveRun = timePasses(() => naiveDedupeReference(ranked).map((memory) => memory.id), 3);
    const optimizedRun = timePasses(() => dedupeRankedMemory(ranked).map((memory) => memory.id), 5);

    naiveSamplesMs = naiveRun.samplesMs;
    optimizedSamplesMs = optimizedRun.samplesMs;
    naiveIds = naiveRun.lastResult;
    optimizedIds = optimizedRun.lastResult;
    naiveMs = median(naiveSamplesMs);
    optimizedMs = median(optimizedSamplesMs);
    naivePairsPerSecond = pairs / (naiveMs / 1000);
    pairsPerSecond = pairs / (optimizedMs / 1000);

    console.log(
      JSON.stringify({
        anchorCount,
        summaryCount,
        pairs,
        naiveMs,
        optimizedMs,
        naiveSamplesMs,
        optimizedSamplesMs,
        ratio: naiveMs / optimizedMs,
        naivePairsPerSecond,
        pairsPerSecond
      })
    );
  }, 60_000);

  it("naive and optimized agree at benchmark scale", () => {
    // The benchmark doubles as a large-fixture equivalence check.
    expect(optimizedIds).toEqual(naiveIds);
  });

  it("the fixture reproduces the GAP-11-B live baseline throughput", () => {
    // Proxy-FIDELITY check, not a performance gate: if the naive arm is outside this band the
    // fixture does not model the live corpus and the optimized number below means nothing. Fix
    // the fixture size distribution, not these thresholds, if this goes red.
    expect(naivePairsPerSecond).toBeGreaterThanOrEqual(5_000);
    expect(naivePairsPerSecond).toBeLessThanOrEqual(500_000);
  });

  it("hoisting removes the per-pair normalization cost", () => {
    // Deliberately an order-of-magnitude floor set well below the expected result, so it fails on
    // a real regression and not on a GC pause.
    expect(naiveMs / optimizedMs).toBeGreaterThanOrEqual(2);
  });

  it("throughput clears the floor Plan 11-13 needs", () => {
    // SUFFICIENCY gate -- the one assertion that may legitimately go red (see 11-15-PLAN.md's
    // <threshold_derivation>). ~5B pairs across two full 12-query runs (11-13 Task 1); ~28h at the
    // 48,900 live baseline, ~1.4h at 1,000,000 pairs/sec, worst single query 4.5h -> ~13min. That
    // is why 1,000,000 pairs/sec (~20x the baseline) is the floor 11-13 needs to be practical.
    expect(pairsPerSecond).toBeGreaterThanOrEqual(1_000_000);
  });
});
