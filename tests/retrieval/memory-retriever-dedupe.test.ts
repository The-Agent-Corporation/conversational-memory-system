import { describe, expect, it } from "vitest";
import { dedupeRankedMemory, type RankedMemory } from "../../src/retrieval/memory-retriever.js";
import type { TurnRange } from "../../src/domain/types.js";

// ---------------------------------------------------------------------------
// GAP-11-B differential equivalence test.
//
// `naiveDedupeReference` below is a verbatim transcription of the CURRENT
// (pre-fix) `dedupeRankedMemory` / `isAnchorCoveredBySummary` semantics in
// src/retrieval/memory-retriever.ts:319-349, using LOCAL copies of
// `sharesBox`, `sharesThread`, and `normalizedMemoryText` — it must never
// import those helpers from the source module, and it must never be edited
// once Task 2 starts hoisting/reordering the real implementation. This file
// is the oracle Plan 11-15 Task 2 and Task 3 are held against; `git diff` on
// this file must be empty in both of those tasks.
// ---------------------------------------------------------------------------

function naiveNormalizedMemoryText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function naiveSharesBox(left: RankedMemory, right: RankedMemory): boolean {
  if (left.boxIds.length === 0 || right.boxIds.length === 0) {
    return true;
  }

  return left.boxIds.some((boxId) => right.boxIds.includes(boxId));
}

function naiveSharesThread(left: RankedMemory, right: RankedMemory): boolean {
  const leftThreads = new Set(left.sourceTurnRanges.map((range) => range.threadId));
  if (leftThreads.size === 0) {
    return right.sourceTurnRanges.length > 0;
  }

  return right.sourceTurnRanges.some((range) => leftThreads.has(range.threadId));
}

/** Verbatim transcription of the pre-fix `dedupeRankedMemory`/`isAnchorCoveredBySummary` algorithm. */
export function naiveDedupeReference(ranked: RankedMemory[]): RankedMemory[] {
  const summaries = ranked.filter((memory) => memory.kind === "summary");
  const seenAnchorTexts = new Set<string>();

  return ranked.filter((memory) => {
    if (memory.kind !== "anchor") {
      return true;
    }

    const textKey = naiveNormalizedMemoryText(memory.text);
    const isCovered = summaries.some((summary) => {
      const summaryText = naiveNormalizedMemoryText(summary.text);
      return (
        summaryText.includes(textKey) &&
        naiveSharesBox(memory, summary) &&
        naiveSharesThread(memory, summary)
      );
    });

    if (seenAnchorTexts.has(textKey) || isCovered) {
      return false;
    }

    seenAnchorTexts.add(textKey);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Deterministic fixture generator.
// ---------------------------------------------------------------------------

/** Every case shape the generator guarantees to produce at least once. */
export const DEDUPE_CASE_TYPES = [
  "anchor_text_is_substring_of_summary",
  "anchor_text_absent_from_all_summaries",
  "anchor_shares_box_with_covering_summary",
  "anchor_box_disjoint_from_covering_summary",
  "anchor_with_empty_box_ids",
  "summary_with_empty_box_ids",
  "summary_with_no_turn_ranges",
  "summary_threads_overlap_anchor",
  "summary_threads_disjoint_from_anchor",
  "duplicate_anchor_texts_differing_by_case",
  "duplicate_anchor_texts_differing_by_whitespace",
  "interleaved_trace_and_box_context_entries",
  "covering_summary_before_anchor",
  "covering_summary_after_anchor"
] as const;

export type DedupeCaseType = (typeof DEDUPE_CASE_TYPES)[number];

/** Seeded linear congruential generator — deterministic, never the platform's random source. */
function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function turnRange(threadId: string, start = 0, end = 1): TurnRange {
  return { threadId, startSequence: start, endSequence: end };
}

// Fixed deterministic word pool — used to pad summary bodies so Task 3 can request larger
// (KB-scale) fixtures through the same generator without reaching for a non-deterministic source.
const WORD_POOL = [
  "orbit", "ledger", "triage", "cadence", "lumen", "fjord", "quartz", "ember", "thicket", "paragon",
  "cobalt", "drift", "harbor", "kernel", "meadow", "nimbus", "opal", "pillar", "quiver", "ripple",
  "solstice", "tundra", "umbra", "vellum", "wharf"
];

function poolWord(index: number): string {
  return WORD_POOL[index % WORD_POOL.length];
}

function paddingText(wordCount: number, seedOffset: number): string {
  const words: string[] = [];
  for (let i = 0; i < wordCount; i += 1) {
    words.push(poolWord(i + seedOffset));
  }
  return words.join(" ");
}

/** `content <word> wrap[ <padding>]` — the shared shape covering-summary case builders use. */
function summaryBodyText(word: string, padWords: number, seedOffset: number): string {
  const padding = padWords > 0 ? ` ${paddingText(padWords, seedOffset)}` : "";
  return `content ${word} wrap${padding}`;
}

function uniqueToken(tag: string, idx: number): string {
  // Trailing non-digit terminator ("z") prevents accidental substring collisions between
  // e.g. token("alpha", 5) === "alpha5z" and token("alpha", 50) === "alpha50z".
  return `${tag}${idx}z`;
}

function makeSummaryEntry(id: string, text: string, overrides: Partial<RankedMemory> = {}): RankedMemory {
  return {
    kind: "summary",
    id,
    text,
    score: 0.5,
    tokenCount: 10,
    canUseStub: true,
    scoringMethod: "keyword overlap",
    summaryId: id,
    summaryIds: [id],
    traceId: null,
    sourceTurnRanges: [],
    boxIds: [],
    ...overrides
  };
}

function makeAnchorEntry(id: string, text: string, overrides: Partial<RankedMemory> = {}): RankedMemory {
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
    sourceTurnRanges: [],
    boxIds: [],
    ...overrides
  };
}

function makeTraceEntry(id: string, text: string): RankedMemory {
  return {
    kind: "trace",
    id,
    text,
    score: 0.3,
    tokenCount: 8,
    canUseStub: true,
    scoringMethod: "keyword overlap",
    summaryId: null,
    summaryIds: [],
    traceId: id,
    sourceTurnRanges: [],
    boxIds: []
  };
}

function makeBoxContextEntry(id: string, text: string): RankedMemory {
  return {
    kind: "box_context",
    id,
    text,
    score: 0.2,
    tokenCount: 6,
    canUseStub: false,
    scoringMethod: "keyword overlap",
    summaryId: null,
    summaryIds: [],
    traceId: null,
    sourceTurnRanges: [],
    boxIds: [id]
  };
}

// Each builder returns the entries one "case" contributes to the shared fixture. `idx` keeps ids
// (and unique text tokens) distinct across repeated invocations of the same case type; `padWords`
// is the size hook Task 3 uses to inflate summary bodies toward the live-corpus size distribution
// without touching this generator's logic.

function caseAnchorSubstring(idx: number, padWords: number): RankedMemory[] {
  const word = uniqueToken("sub", idx);
  const summary = makeSummaryEntry(`sum_sub_${idx}`, summaryBodyText(word, padWords, idx), {
    sourceTurnRanges: [turnRange(`thread_sub_${idx}`)]
  });
  const anchor = makeAnchorEntry(`anc_sub_${idx}`, word);
  return [summary, anchor];
}

function caseAnchorAbsent(idx: number, padWords: number): RankedMemory[] {
  const summary = makeSummaryEntry(
    `sum_absent_${idx}`,
    summaryBodyText(uniqueToken("absentfiller", idx), padWords, idx)
  );
  const anchor = makeAnchorEntry(`anc_absent_${idx}`, uniqueToken("absent", idx));
  return [summary, anchor];
}

function caseSharedBox(idx: number, padWords: number): RankedMemory[] {
  const word = uniqueToken("box", idx);
  const summary = makeSummaryEntry(`sum_box_${idx}`, summaryBodyText(word, padWords, idx), {
    boxIds: [`box_${idx}`],
    sourceTurnRanges: [turnRange(`thread_box_${idx}`)]
  });
  const anchor = makeAnchorEntry(`anc_box_${idx}`, word, { boxIds: [`box_${idx}`] });
  return [summary, anchor];
}

function caseBoxDisjoint(idx: number, padWords: number): RankedMemory[] {
  const word = uniqueToken("boxdis", idx);
  const summary = makeSummaryEntry(`sum_boxdis_${idx}`, summaryBodyText(word, padWords, idx), {
    boxIds: [`boxA_${idx}`],
    sourceTurnRanges: [turnRange(`thread_boxdis_${idx}`)]
  });
  const anchor = makeAnchorEntry(`anc_boxdis_${idx}`, word, { boxIds: [`boxB_${idx}`] });
  return [summary, anchor];
}

function caseAnchorEmptyBox(idx: number, padWords: number): RankedMemory[] {
  const word = uniqueToken("aeb", idx);
  const summary = makeSummaryEntry(`sum_aeb_${idx}`, summaryBodyText(word, padWords, idx), {
    boxIds: [`box_x_${idx}`],
    sourceTurnRanges: [turnRange(`thread_aeb_${idx}`)]
  });
  const anchor = makeAnchorEntry(`anc_aeb_${idx}`, word, { boxIds: [] });
  return [summary, anchor];
}

function caseSummaryEmptyBox(idx: number, padWords: number): RankedMemory[] {
  const word = uniqueToken("seb", idx);
  const summary = makeSummaryEntry(`sum_seb_${idx}`, summaryBodyText(word, padWords, idx), {
    boxIds: [],
    sourceTurnRanges: [turnRange(`thread_seb_${idx}`)]
  });
  const anchor = makeAnchorEntry(`anc_seb_${idx}`, word, { boxIds: [`box_y_${idx}`] });
  return [summary, anchor];
}

function caseSummaryNoTurnRanges(idx: number, padWords: number): RankedMemory[] {
  const word = uniqueToken("ntr", idx);
  const summary = makeSummaryEntry(`sum_ntr_${idx}`, summaryBodyText(word, padWords, idx), {
    sourceTurnRanges: []
  });
  const anchor = makeAnchorEntry(`anc_ntr_${idx}`, word);
  return [summary, anchor];
}

function caseThreadsOverlap(idx: number, padWords: number): RankedMemory[] {
  const word = uniqueToken("ov", idx);
  const thread = `thread_ov_${idx}`;
  const summary = makeSummaryEntry(`sum_ov_${idx}`, summaryBodyText(word, padWords, idx), {
    sourceTurnRanges: [turnRange(thread)]
  });
  const anchor = makeAnchorEntry(`anc_ov_${idx}`, word, { sourceTurnRanges: [turnRange(thread)] });
  return [summary, anchor];
}

function caseThreadsDisjoint(idx: number, padWords: number): RankedMemory[] {
  const word = uniqueToken("disj", idx);
  const summary = makeSummaryEntry(`sum_disj_${idx}`, summaryBodyText(word, padWords, idx), {
    sourceTurnRanges: [turnRange(`thread_disjA_${idx}`)]
  });
  const anchor = makeAnchorEntry(`anc_disj_${idx}`, word, {
    sourceTurnRanges: [turnRange(`thread_disjB_${idx}`)]
  });
  return [summary, anchor];
}

function caseDupCase(idx: number): RankedMemory[] {
  const baseText = `Unique Marker Duplicate ${uniqueToken("dupcase", idx)}`;
  const anchor1 = makeAnchorEntry(`anc_dupcase_a_${idx}`, baseText);
  const anchor2 = makeAnchorEntry(`anc_dupcase_b_${idx}`, baseText.toUpperCase());
  return [anchor1, anchor2];
}

function caseDupWhitespace(idx: number): RankedMemory[] {
  const baseText = `Whitespace   Duplicate    ${uniqueToken("dupws", idx)}`;
  const anchor1 = makeAnchorEntry(`anc_dupws_a_${idx}`, baseText);
  const anchor2 = makeAnchorEntry(`anc_dupws_b_${idx}`, baseText.replace(/\s+/g, " "));
  return [anchor1, anchor2];
}

function caseInterleaved(idx: number, padWords: number): RankedMemory[] {
  const trace = makeTraceEntry(`trace_${idx}`, `trace text ${summaryBodyText(uniqueToken("tracetext", idx), padWords, idx)}`);
  const boxCtx = makeBoxContextEntry(`boxctx_${idx}`, `box context text ${uniqueToken("boxctxtext", idx)}`);
  const summary = makeSummaryEntry(`sum_inter_${idx}`, summaryBodyText(uniqueToken("intersummary", idx), padWords, idx));
  const anchor = makeAnchorEntry(`anc_inter_${idx}`, uniqueToken("inter", idx));
  return [trace, summary, boxCtx, anchor];
}

function caseSummaryBeforeAnchor(idx: number, padWords: number): RankedMemory[] {
  const word = uniqueToken("before", idx);
  const summary = makeSummaryEntry(`sum_before_${idx}`, summaryBodyText(word, padWords, idx), {
    sourceTurnRanges: [turnRange(`thread_before_${idx}`)]
  });
  const anchor = makeAnchorEntry(`anc_before_${idx}`, word);
  return [summary, anchor];
}

function caseSummaryAfterAnchor(idx: number, padWords: number): RankedMemory[] {
  const word = uniqueToken("after", idx);
  const summary = makeSummaryEntry(`sum_after_${idx}`, summaryBodyText(word, padWords, idx), {
    sourceTurnRanges: [turnRange(`thread_after_${idx}`)]
  });
  const anchor = makeAnchorEntry(`anc_after_${idx}`, word);
  return [anchor, summary];
}

const CASE_BUILDERS: Record<DedupeCaseType, (idx: number, padWords: number) => RankedMemory[]> = {
  anchor_text_is_substring_of_summary: caseAnchorSubstring,
  anchor_text_absent_from_all_summaries: caseAnchorAbsent,
  anchor_shares_box_with_covering_summary: caseSharedBox,
  anchor_box_disjoint_from_covering_summary: caseBoxDisjoint,
  anchor_with_empty_box_ids: caseAnchorEmptyBox,
  summary_with_empty_box_ids: caseSummaryEmptyBox,
  summary_with_no_turn_ranges: caseSummaryNoTurnRanges,
  summary_threads_overlap_anchor: caseThreadsOverlap,
  summary_threads_disjoint_from_anchor: caseThreadsDisjoint,
  duplicate_anchor_texts_differing_by_case: caseDupCase,
  duplicate_anchor_texts_differing_by_whitespace: caseDupWhitespace,
  interleaved_trace_and_box_context_entries: caseInterleaved,
  covering_summary_before_anchor: caseSummaryBeforeAnchor,
  covering_summary_after_anchor: caseSummaryAfterAnchor
};

/**
 * Deterministic fixture generator. Emits one hand-shaped case per `DEDUPE_CASE_TYPES` entry
 * first (coverage guaranteed by construction), then fills the remainder up to `caseCount` with
 * LCG-selected case types. `options.padWords` is a size hook: Task 3 passes a larger value to
 * grow summary bodies toward the live-corpus size distribution, without editing this function.
 */
export function generateDedupeCases(
  caseCount: number,
  seed: number,
  options: { padWords?: number } = {}
): { ranked: RankedMemory[]; counts: Record<DedupeCaseType, number> } {
  const padWords = options.padWords ?? 0;
  const rng = makeLcg(seed);
  const ranked: RankedMemory[] = [];
  const counts = Object.fromEntries(DEDUPE_CASE_TYPES.map((type) => [type, 0])) as Record<DedupeCaseType, number>;
  const nextIdxByType = Object.fromEntries(DEDUPE_CASE_TYPES.map((type) => [type, 0])) as Record<DedupeCaseType, number>;

  const emit = (type: DedupeCaseType): void => {
    const idx = nextIdxByType[type];
    nextIdxByType[type] = idx + 1;
    ranked.push(...CASE_BUILDERS[type](idx, padWords));
    counts[type] += 1;
  };

  // Guarantee coverage: one hand-shaped case per type first, so removing a generator branch
  // fails the coverage-regression test instead of silently degrading coverage.
  for (const type of DEDUPE_CASE_TYPES) {
    emit(type);
  }

  let produced = DEDUPE_CASE_TYPES.length;
  while (produced < caseCount) {
    const typeIndex = Math.floor(rng() * DEDUPE_CASE_TYPES.length);
    emit(DEDUPE_CASE_TYPES[typeIndex]);
    produced += 1;
  }

  return { ranked, counts };
}

// ---------------------------------------------------------------------------
// Equivalence assertions.
// ---------------------------------------------------------------------------

const FIXTURE_CASE_COUNT = 220;
const FIXTURE_SEED = 1_234_567;

describe("dedupeRankedMemory equivalence", () => {
  it("matches the naive reference across 200+ generated cases (ordered id sequence)", () => {
    const { ranked, counts } = generateDedupeCases(FIXTURE_CASE_COUNT, FIXTURE_SEED);
    const totalCases = Object.values(counts).reduce((sum, count) => sum + count, 0);
    expect(totalCases).toBeGreaterThanOrEqual(200);

    const optimizedIds = dedupeRankedMemory(ranked).map((memory) => memory.id);
    const naiveIds = naiveDedupeReference(ranked).map((memory) => memory.id);
    expect(optimizedIds).toEqual(naiveIds);
  });

  it("preserves referential identity and relative input order of surviving entries", () => {
    const { ranked } = generateDedupeCases(FIXTURE_CASE_COUNT, FIXTURE_SEED);
    const optimized = dedupeRankedMemory(ranked);
    const naive = naiveDedupeReference(ranked);

    expect(optimized.map((memory) => memory.id)).toEqual(naive.map((memory) => memory.id));

    const originalIndexById = new Map(ranked.map((memory, index) => [memory.id, index]));
    let lastIndex = -1;
    for (const memory of optimized) {
      expect(ranked.includes(memory)).toBe(true); // same object reference, not a copy
      const index = originalIndexById.get(memory.id);
      expect(index).toBeDefined();
      expect(index as number).toBeGreaterThan(lastIndex);
      lastIndex = index as number;
    }
  });

  it("asserts per-case-type coverage (deleting a generator branch fails this)", () => {
    const { counts } = generateDedupeCases(FIXTURE_CASE_COUNT, FIXTURE_SEED);
    for (const type of DEDUPE_CASE_TYPES) {
      expect(counts[type], `expected the generator to produce at least one "${type}" case`).toBeGreaterThan(0);
    }
  });

  it("handles empty input", () => {
    expect(dedupeRankedMemory([])).toEqual([]);
    expect(naiveDedupeReference([])).toEqual([]);
  });

  it("handles anchors-only input (nothing to be covered by)", () => {
    const ranked: RankedMemory[] = [
      makeAnchorEntry("anc_only_1", "hello world"),
      makeAnchorEntry("anc_only_2", "a distinctly different phrase")
    ];
    expect(dedupeRankedMemory(ranked).map((memory) => memory.id)).toEqual(
      naiveDedupeReference(ranked).map((memory) => memory.id)
    );
    expect(dedupeRankedMemory(ranked)).toEqual(ranked);
  });

  it("handles summaries-only input (nothing to dedupe)", () => {
    const ranked: RankedMemory[] = [
      makeSummaryEntry("sum_only_1", "hello world"),
      makeSummaryEntry("sum_only_2", "other text")
    ];
    expect(dedupeRankedMemory(ranked)).toEqual(ranked);
    expect(naiveDedupeReference(ranked)).toEqual(ranked);
  });

  it("covers an anchor whose text exactly equals a whole summary text", () => {
    const summary = makeSummaryEntry("sum_exact_1", "exact match text", {
      sourceTurnRanges: [turnRange("thread_exact_1")]
    });
    const anchor = makeAnchorEntry("anc_exact_1", "exact match text");
    const ranked = [summary, anchor];

    expect(dedupeRankedMemory(ranked).map((memory) => memory.id)).toEqual(
      naiveDedupeReference(ranked).map((memory) => memory.id)
    );
    expect(dedupeRankedMemory(ranked).map((memory) => memory.id)).toEqual(["sum_exact_1"]);
  });

  it("(d) an anchor contained in a summary's text but sharing no box survives dedup in both implementations", () => {
    const summary = makeSummaryEntry("sum_guard_1", "content unique-guard-marker wrap", {
      boxIds: ["box_guard_a"],
      sourceTurnRanges: [turnRange("thread_guard_1")]
    });
    const anchor = makeAnchorEntry("anc_guard_1", "unique-guard-marker", { boxIds: ["box_guard_b"] });
    const ranked = [summary, anchor];

    const optimizedIds = dedupeRankedMemory(ranked).map((memory) => memory.id);
    const naiveIds = naiveDedupeReference(ranked).map((memory) => memory.id);
    expect(optimizedIds).toEqual(naiveIds);
    expect(optimizedIds).toEqual(["sum_guard_1", "anc_guard_1"]);
  });
});
