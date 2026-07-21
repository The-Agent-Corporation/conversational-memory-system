import { createHash } from "node:crypto";
import type { Box, Summary } from "../domain/types.js";
import { significantTerms, slugify, titleCase } from "../proposals/proposal-utils.js";

export interface TraceCandidate {
  title: string;
  traceId: string;
  summaries: Summary[];
  keywords: string[];
  continuityTerms: string[];
  boxIds: string[];
}

/**
 * Partial trace candidate keyed by traceId, referencing summaries by their GLOBAL index so partials
 * produced by different left-index shards (workers) merge cleanly. Sets keep membership O(1) and
 * dedup keywords/continuity terms in first-seen order.
 */
export interface PartialTraceCandidate {
  title: string;
  summaryIndices: Set<number>;
  keywords: Set<string>;
  continuityTerms: Set<string>;
}

export const BROAD_TRACE_TERMS = new Set(["smith", "jones", "case", "matter", "claim", "coverage"]);

// A term that appears in a large fraction of ALL summaries carries no continuity signal — two
// summaries both mentioning a word that pervades the whole corpus tells you nothing, and pairing on
// it also creates enormous index buckets. Such terms are excluded from candidate generation. The
// absolute floor keeps small corpora (e.g. test fixtures) fully intact: nothing is ever trimmed
// unless a term appears in more than this many summaries.
const NON_DISCRIMINATING_DOCUMENT_FLOOR = 200;
const NON_DISCRIMINATING_DOCUMENT_FRACTION = 0.004;

export function maxDocumentFrequencyFor(summaryCount: number): number {
  return Math.max(
    NON_DISCRIMINATING_DOCUMENT_FLOOR,
    Math.ceil(NON_DISCRIMINATING_DOCUMENT_FRACTION * summaryCount)
  );
}

export function namespaceSuffixFor(idNamespace?: string): string {
  return idNamespace ? createHash("sha256").update(idNamespace).digest("hex").slice(0, 12) : "";
}

export function significantTermsBySummary(summaries: Summary[]): string[][] {
  return summaries.map((summary) => significantTerms(summary.summaryText));
}

/**
 * Build the per-summary term sets and the discriminating-term inverted index used to find candidate
 * pairs. A term appearing in more than `maxDocumentFrequency` summaries is non-discriminating and
 * gets no postings, so pairs whose only overlap is such a term are never generated.
 */
export function buildTraceIndex(
  termsBySummary: string[][],
  maxDocumentFrequency: number
): { termSetsBySummary: Set<string>[]; postingsByTerm: Map<string, number[]> } {
  const termSetsBySummary = termsBySummary.map((terms) => new Set(terms));
  const documentFrequency = new Map<string, number>();
  for (const terms of termsBySummary) {
    for (const term of terms) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  const postingsByTerm = new Map<string, number[]>();
  for (let index = 0; index < termsBySummary.length; index += 1) {
    for (const term of termsBySummary[index]) {
      if ((documentFrequency.get(term) ?? 0) > maxDocumentFrequency) continue;
      const postings = postingsByTerm.get(term);
      if (postings) postings.push(index);
      else postingsByTerm.set(term, [index]);
    }
  }
  return { termSetsBySummary, postingsByTerm };
}

/**
 * Core pairing loop over left indices in [leftStart, leftEnd). Each unordered pair (a < b) is
 * produced exactly once by whichever shard owns leftIndex a, so sharding the left range across
 * workers and unioning the partials reproduces the whole-corpus result. Pure and worker-safe:
 * no I/O, no dependency on Summary objects (only their precomputed terms + global index).
 */
export function collectTracePartials(params: {
  termsBySummary: string[][];
  termSetsBySummary: Set<string>[];
  postingsByTerm: Map<string, number[]>;
  namespaceSuffix: string;
  idNamespace?: string;
  leftStart: number;
  leftEnd: number;
}): Map<string, PartialTraceCandidate> {
  const { termsBySummary, termSetsBySummary, postingsByTerm, namespaceSuffix, idNamespace } = params;
  const partials = new Map<string, PartialTraceCandidate>();

  for (let leftIndex = params.leftStart; leftIndex < params.leftEnd; leftIndex += 1) {
    const leftTerms = termsBySummary[leftIndex];
    const rightIndexes = new Set<number>();
    for (const term of leftTerms) {
      const postings = postingsByTerm.get(term);
      if (!postings) continue;
      for (const candidateIndex of postings) if (candidateIndex > leftIndex) rightIndexes.add(candidateIndex);
    }
    if (rightIndexes.size === 0) continue;

    for (const rightIndex of [...rightIndexes].sort((a, b) => a - b)) {
      const rightTermSet = termSetsBySummary[rightIndex];
      const shared = leftTerms.filter((term) => rightTermSet.has(term));
      if (shared.length === 0) {
        continue;
      }

      const continuityTerms = shared.filter((term) => !BROAD_TRACE_TERMS.has(term));
      const titleTerms = shared
        .filter((term, index, terms) => terms.indexOf(term) === index)
        .slice(0, 4);
      const title = titleCase(titleTerms.join(" "));
      const baseTraceId = `trace_${slugify(title)}`;
      const traceId = idNamespace ? `${baseTraceId}_${namespaceSuffix}` : baseTraceId;
      let candidate = partials.get(traceId);
      if (!candidate) {
        candidate = { title, summaryIndices: new Set(), keywords: new Set(), continuityTerms: new Set() };
        partials.set(traceId, candidate);
      }
      candidate.summaryIndices.add(leftIndex);
      candidate.summaryIndices.add(rightIndex);
      for (const term of shared) candidate.keywords.add(term);
      for (const term of continuityTerms) candidate.continuityTerms.add(term);
    }
  }

  return partials;
}

/** Map partials (index-keyed) back onto Summary objects, id-sorting each candidate's summaries. */
export function materializeTraceCandidates(
  partials: Map<string, PartialTraceCandidate>,
  summaries: Summary[],
  boxes: Box[]
): TraceCandidate[] {
  return [...partials.entries()].map(([traceId, candidate]) => {
    const summariesForCandidate = [...candidate.summaryIndices]
      .map((index) => summaries[index])
      .sort((left, right) => left.id.localeCompare(right.id));
    return {
      title: candidate.title,
      traceId,
      summaries: summariesForCandidate,
      keywords: [...candidate.keywords],
      continuityTerms: [...candidate.continuityTerms],
      boxIds: matchingBoxIds(summariesForCandidate, boxes)
    };
  });
}

export function matchingBoxIds(summaries: Summary[], boxes: Box[]): string[] {
  const summaryIds = new Set(summaries.map((summary) => summary.id));
  return boxes
    .filter((box) => box.summaryIds.some((summaryId) => summaryIds.has(summaryId)))
    .map((box) => box.id)
    .sort();
}

/** Single-threaded whole-corpus candidate build (used by the daemon's small incremental runs and tests). */
export function buildTraceCandidates(
  summaries: Summary[],
  boxes: Box[],
  idNamespace?: string
): TraceCandidate[] {
  const termsBySummary = significantTermsBySummary(summaries);
  const { termSetsBySummary, postingsByTerm } = buildTraceIndex(
    termsBySummary,
    maxDocumentFrequencyFor(summaries.length)
  );
  const partials = collectTracePartials({
    termsBySummary,
    termSetsBySummary,
    postingsByTerm,
    namespaceSuffix: namespaceSuffixFor(idNamespace),
    idNamespace,
    leftStart: 0,
    leftEnd: summaries.length
  });
  return materializeTraceCandidates(partials, summaries, boxes);
}
