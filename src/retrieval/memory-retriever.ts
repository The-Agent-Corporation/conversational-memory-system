import { createHash } from "node:crypto";
import type { Anchor, Box, InjectionPacket, MemoryTrace, Summary, TurnRange } from "../domain/types.js";
import { cosineSimilarity, type Embedder } from "../embeddings/embedder.js";
import type { InjectionRequest } from "../service/memory-service.js";
import type { MemoryStore } from "../storage/memory-store.js";
import { RETRIEVAL_CANDIDATE_STATES, REVIVABLE_MEMORY_STATE, isRetrievableState } from "./retrievable-state.js";

export interface RankedMemory {
  kind: "summary" | "anchor" | "trace" | "box_context";
  id: string;
  text: string;
  score: number;
  tokenCount: number;
  canUseStub: boolean;
  scoringMethod: "keyword overlap" | "vector similarity";
  summaryId: string | null;
  summaryIds: string[];
  traceId: string | null;
  sourceTurnRanges: TurnRange[];
  boxIds: string[];
}

export class MemoryRetriever {
  constructor(
    private readonly store: MemoryStore,
    private readonly options: { embedder?: Embedder; allowLegacyUnscoped?: boolean } = {}
  ) {}

  async prepareInjection(request: InjectionRequest): Promise<InjectionPacket | null> {
    // Store-level filter is an optimization for query shape only, never the authority boundary:
    // applyRetrievalBoundary below re-applies the person, scope, and state predicates over
    // whatever this call returns. RETRIEVAL_CANDIDATE_STATES covers both the retrievable and
    // revivable partitions, so one call here is enough — no second query for stale summaries.
    const summaryFilter =
      request.personId !== undefined
        ? { personId: request.personId, scopeIds: request.allowedScopeIds, states: RETRIEVAL_CANDIDATE_STATES }
        : { states: RETRIEVAL_CANDIDATE_STATES };
    const [allSummaries, allAnchors, allTraces, allBoxes] = await Promise.all([
      this.store.listSummaries(summaryFilter),
      this.store.listAnchors(),
      this.store.listTraces({ state: "approved" }),
      this.store.listBoxes()
    ]);
    const { summaries, anchors, traces, boxes, allowedScopeIds, revivableSummaries } = applyRetrievalBoundary(
      request,
      allSummaries,
      allAnchors,
      allTraces,
      allBoxes,
      this.options.allowLegacyUnscoped ?? false
    );
    const topicEmbedding = this.options.embedder
      ? await this.options.embedder.embed(request.currentTopicSummary)
      : null;
    const rankingOptions = { embedder: this.options.embedder, topicEmbedding };
    const ranked = rankMemories(request.currentTopicSummary, summaries, anchors, traces, rankingOptions);

    if (ranked.length === 0) {
      return null;
    }

    const primarySelected = selectMemories(ranked, request.maxMemoryTokens);
    const selected = addParentBoxContext(primarySelected, boxes, request.maxMemoryTokens);
    if (selected.length === 0) {
      return null;
    }

    const createdAt = request.requestedAt ?? new Date().toISOString();
    const selectedTokenCount = selected.reduce((sum, memory) => sum + memory.tokenCount, 0);
    const packet: InjectionPacket = {
      id: injectionId(request, selected, createdAt),
      ...(request.personId ? { personId: request.personId } : {}),
      ...(allowedScopeIds ? { allowedScopeIds } : {}),
      hostSessionId: request.hostSessionId,
      currentTopicSummary: request.currentTopicSummary,
      selectedMemory: selected.map((memory) => memory.text).join("\n\n"),
      sourceSummaryIds: [...new Set(selected.flatMap((memory) => memory.summaryIds))],
      sourceTraceIds: selected
        .map((memory) => memory.traceId)
        .filter((traceId): traceId is string => traceId !== null),
      sourceTurnRanges: dedupeTurnRanges(selected.flatMap((memory) => memory.sourceTurnRanges)),
      boxIds: [...new Set(selected.flatMap((memory) => memory.boxIds))],
      relevanceReason: buildRelevanceReason(selected),
      confidence: Math.min(0.95, Math.max(0.1, selected[0].score)),
      disclosureText: buildDisclosureText(selected, request.currentTopicSummary, selectedTokenCount, request.maxMemoryTokens),
      createdAt
    };

    await this.store.saveInjection(packet);
    await this.recordSelectedSummaryAccess(summaries, selected, createdAt);
    await this.promoteRevivableSummaries(revivableSummaries, request.currentTopicSummary, selected, rankingOptions, createdAt);
    return packet;
  }

  private async recordSelectedSummaryAccess(
    summaries: Summary[],
    selected: RankedMemory[],
    accessedAt: string
  ): Promise<void> {
    const selectedSummaryIds = new Set(
      selected.flatMap((memory) => memory.summaryIds)
    );

    for (const summary of summaries) {
      if (!selectedSummaryIds.has(summary.id)) {
        continue;
      }

      await this.store.saveSummary({
        ...summary,
        lastAccessedAt: accessedAt,
        retrievedAt: accessedAt,
        retrievalCount: summary.retrievalCount + 1,
        strength: strengthen(summary.strength),
        // A selected summary is retrievable by construction (isRetrievableState gates it before
        // ranking), so no state promotion can occur here. Deferred revival of REVIVABLE_MEMORY_STATE
        // ("stale") summaries is handled separately by promoteRevivableSummaries.
        state: summary.state
      });
    }
  }

  /**
   * Deferred revival (GAP-11-A / ADR 0049): a "stale" summary is never itself retrievable, but
   * one that would have ranked into THIS packet is promoted to "revived" so it becomes
   * retrievable on the NEXT query. It never enters `ranked`, `selected`, `packet.selectedMemory`,
   * or `packet.sourceSummaryIds` for the packet that triggered its promotion.
   */
  private async promoteRevivableSummaries(
    revivableSummaries: Summary[],
    currentTopicSummary: string,
    selected: RankedMemory[],
    rankingOptions: { embedder?: Embedder; topicEmbedding: Summary["embedding"] },
    accessedAt: string
  ): Promise<void> {
    if (revivableSummaries.length === 0 || selected.length === 0) {
      return;
    }

    const topicWords = significantWords(currentTopicSummary);
    const selectedFloor = Math.min(...selected.map((memory) => memory.score));

    for (const summary of revivableSummaries) {
      const score = rankSummary(topicWords, summary, rankingOptions).score;
      if (score <= 0 || score < selectedFloor) {
        continue;
      }

      await this.store.saveSummary({
        ...summary,
        state: "revived",
        lastAccessedAt: accessedAt,
        retrievedAt: accessedAt,
        retrievalCount: summary.retrievalCount + 1,
        strength: strengthen(summary.strength)
      });
    }
  }
}

function applyRetrievalBoundary(
  request: InjectionRequest,
  summaries: Summary[],
  anchors: Anchor[],
  traces: MemoryTrace[],
  boxes: Box[],
  allowLegacyUnscoped: boolean
): {
  summaries: Summary[];
  anchors: Anchor[];
  traces: MemoryTrace[];
  boxes: Box[];
  allowedScopeIds: string[] | null;
  revivableSummaries: Summary[];
} {
  const hasPerson = request.personId !== undefined;
  const hasScopes = request.allowedScopeIds !== undefined;
  if (hasPerson !== hasScopes) {
    throw new Error("Scoped retrieval requires both personId and allowedScopeIds");
  }
  if (!hasPerson || !hasScopes) {
    if (!allowLegacyUnscoped) {
      throw new Error("Unscoped retrieval is disabled; provide personId and allowedScopeIds");
    }
    // Legacy unscoped retrieval must not become a bypass for the state boundary (T-11-21):
    // apply the same isRetrievableState / REVIVABLE_MEMORY_STATE partition here as the scoped path.
    return {
      summaries: summaries.filter((summary) => isRetrievableState(summary.state)),
      anchors,
      traces,
      boxes,
      allowedScopeIds: null,
      revivableSummaries: summaries.filter((summary) => summary.state === REVIVABLE_MEMORY_STATE)
    };
  }

  const personId = request.personId!;
  const allowedScopeIds = [...new Set(request.allowedScopeIds!)].sort();
  const allowed = new Set(allowedScopeIds);
  const inScope = (summary: Summary): boolean =>
    summary.personId === personId &&
    (summary.scopeIds ?? ["personal"]).every((scopeId) => allowed.has(scopeId));
  // isRetrievableState is applied INSIDE this function (D-GAP-2) so anchors/traces/boxes inherit
  // it through the summaryIds.every(...) membership tests below, rather than being filtered at
  // each call site (T-11-20).
  const scopedSummaries = summaries.filter((summary) => inScope(summary) && isRetrievableState(summary.state));
  const revivableSummaries = summaries.filter(
    (summary) => inScope(summary) && summary.state === REVIVABLE_MEMORY_STATE
  );
  const summaryIds = new Set(scopedSummaries.map((summary) => summary.id));
  const scopedAnchors = anchors.filter((anchor) =>
    anchor.personId === personId && allowed.has(anchor.scopeId ?? "personal")
  );
  const scopedTraces = traces.filter((trace) =>
    trace.personId === personId &&
    trace.summaryIds.length > 0 &&
    trace.summaryIds.every((summaryId) => summaryIds.has(summaryId))
  );
  const scopedBoxes = boxes.filter((box) =>
    box.personId === personId &&
    box.summaryIds.length > 0 &&
    box.summaryIds.every((summaryId) => summaryIds.has(summaryId))
  );
  return {
    summaries: scopedSummaries,
    anchors: scopedAnchors,
    traces: scopedTraces,
    boxes: scopedBoxes,
    allowedScopeIds,
    revivableSummaries
  };
}

function selectMemories(ranked: RankedMemory[], maxMemoryTokens?: number): RankedMemory[] {
  const deduped = dedupeRankedMemory(ranked);

  if (maxMemoryTokens === undefined) {
    return deduped.slice(0, 3);
  }

  const selected: RankedMemory[] = [];
  let usedTokens = 0;

  for (const memory of deduped) {
    if (selected.length >= 3) {
      break;
    }
    if (usedTokens + memory.tokenCount > maxMemoryTokens) {
      if (selected.length === 0 && memory.kind === "trace") {
        const stub = buildMemoryStub(memory, maxMemoryTokens);
        if (stub) {
          selected.push(stub);
          break;
        }
      }
      continue;
    }

    selected.push(memory);
    usedTokens += memory.tokenCount;
  }

  if (selected.length === 0) {
    const stub = buildMemoryStub(deduped[0], maxMemoryTokens);
    if (stub) {
      return [stub];
    }
  }

  return selected;
}

function addParentBoxContext(
  selected: RankedMemory[],
  boxes: Box[],
  maxMemoryTokens?: number
): RankedMemory[] {
  const boxesById = new Map(boxes.map((box) => [box.id, box]));
  const selectedBoxIds = new Set(selected.flatMap((memory) => memory.boxIds));
  const usedTokens = selected.reduce((sum, memory) => sum + memory.tokenCount, 0);

  for (const boxId of selectedBoxIds) {
    const child = boxesById.get(boxId);
    if (!child?.parentBoxId) {
      continue;
    }

    const parent = boxesById.get(child.parentBoxId);
    if (!parent || !["active", "approved", "revived"].includes(parent.state)) {
      continue;
    }

    const text = `[Parent Box: ${parent.title}]\n${parent.summary}`;
    const candidate: RankedMemory = {
      kind: "box_context",
      id: parent.id,
      text,
      score: 0.01,
      tokenCount: estimateTokenCount(text),
      canUseStub: false,
      scoringMethod: "keyword overlap",
      summaryId: null,
      summaryIds: [],
      traceId: null,
      sourceTurnRanges: parent.turnRanges,
      boxIds: [parent.id]
    };

    if (maxMemoryTokens !== undefined && usedTokens + candidate.tokenCount > maxMemoryTokens) {
      return selected;
    }

    return selected.some((memory) => memory.boxIds.includes(parent.id)) ? selected : [...selected, candidate];
  }

  return selected;
}

// Exported for the GAP-11-B differential equivalence test (tests/retrieval/memory-retriever-dedupe.test.ts);
// not a public retrieval API.
export function dedupeRankedMemory(ranked: RankedMemory[]): RankedMemory[] {
  const summaries = ranked.filter((memory) => memory.kind === "summary");
  const seenAnchorTexts = new Set<string>();

  return ranked.filter((memory) => {
    if (memory.kind !== "anchor") {
      return true;
    }

    const textKey = normalizedMemoryText(memory.text);
    if (seenAnchorTexts.has(textKey) || isAnchorCoveredBySummary(memory, summaries)) {
      return false;
    }

    seenAnchorTexts.add(textKey);
    return true;
  });
}

function isAnchorCoveredBySummary(anchor: RankedMemory, summaries: RankedMemory[]): boolean {
  const anchorText = normalizedMemoryText(anchor.text);

  return summaries.some((summary) => {
    const summaryText = normalizedMemoryText(summary.text);
    return (
      summaryText.includes(anchorText) &&
      sharesBox(anchor, summary) &&
      sharesThread(anchor, summary)
    );
  });
}

function sharesBox(left: RankedMemory, right: RankedMemory): boolean {
  if (left.boxIds.length === 0 || right.boxIds.length === 0) {
    return true;
  }

  return left.boxIds.some((boxId) => right.boxIds.includes(boxId));
}

function sharesThread(left: RankedMemory, right: RankedMemory): boolean {
  const leftThreads = new Set(left.sourceTurnRanges.map((range) => range.threadId));
  if (leftThreads.size === 0) {
    return right.sourceTurnRanges.length > 0;
  }

  return right.sourceTurnRanges.some((range) => leftThreads.has(range.threadId));
}

function buildMemoryStub(memory: RankedMemory, maxTokens: number): RankedMemory | null {
  if (!memory.canUseStub || maxTokens < 3) {
    return null;
  }

  const words = memory.text.split(/\s+/).filter(Boolean);
  if (words.length <= maxTokens) {
    return memory;
  }

  return {
    ...memory,
    text: `${words.slice(0, maxTokens - 1).join(" ")}...`,
    tokenCount: maxTokens,
    scoringMethod: memory.scoringMethod
  };
}

function strengthen(strength: number): number {
  return Math.min(1, Number((strength + 0.05).toFixed(2)));
}

function rankMemories(
  topicSummary: string,
  summaries: Summary[],
  anchors: Anchor[],
  traces: MemoryTrace[],
  options: {
    embedder?: Embedder;
    topicEmbedding: Summary["embedding"];
  } = { topicEmbedding: null }
): RankedMemory[] {
  const topicWords = significantWords(topicSummary);
  const summariesById = new Map(summaries.map((summary) => [summary.id, summary]));
  const traceCandidates = traces
    .map((trace) =>
      rankTrace(
        topicWords,
        trace,
        trace.summaryIds
          .map((summaryId) => summariesById.get(summaryId))
          .filter((summary): summary is Summary => summary !== undefined)
      )
    )
    .filter((memory): memory is RankedMemory => memory !== null);
  const ranked: RankedMemory[] = [
    ...summaries.map((summary) => rankSummary(topicWords, summary, options)),
    ...traceCandidates,
    ...anchors.map((anchor) => rankAnchor(topicWords, anchor, options))
  ].filter((memory) => memory.score > 0);

  return ranked.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

function rankSummary(
  topicWords: Set<string>,
  summary: Summary,
  options: {
    embedder?: Embedder;
    topicEmbedding: Summary["embedding"];
  }
): RankedMemory {
  const vectorScore = embeddingScore(options, summary.embedding);
  if (vectorScore !== null) {
    return {
      kind: "summary",
      id: summary.id,
      text: summary.summaryText,
      score: vectorScore * summary.confidence,
      tokenCount: summary.tokenCount,
      canUseStub: true,
      scoringMethod: "vector similarity",
      summaryId: summary.id,
      summaryIds: [summary.id],
      traceId: null,
      sourceTurnRanges: summary.sourceTurnRanges,
      boxIds: summary.boxIds
    };
  }

  return {
    kind: "summary",
    id: summary.id,
    text: summary.summaryText,
    score: scoreText(topicWords, summary.summaryText) * summary.confidence,
    tokenCount: summary.tokenCount,
    canUseStub: true,
    scoringMethod: "keyword overlap",
    summaryId: summary.id,
    summaryIds: [summary.id],
    traceId: null,
    sourceTurnRanges: summary.sourceTurnRanges,
    boxIds: summary.boxIds
  };
}

function rankAnchor(
  topicWords: Set<string>,
  anchor: Anchor,
  options: {
    embedder?: Embedder;
    topicEmbedding: Summary["embedding"];
  }
): RankedMemory {
  const anchorWeight = anchor.anchorType === "deadline" || anchor.anchorType === "decision" ? 1.1 : 1;
  const vectorScore = embeddingScore(options, anchor.embedding);
  if (vectorScore !== null) {
    return {
      kind: "anchor",
      id: anchor.id,
      text: anchor.content,
      score: vectorScore * anchorWeight,
      tokenCount: estimateTokenCount(anchor.content),
      canUseStub: false,
      scoringMethod: "vector similarity",
      summaryId: null,
      summaryIds: [],
      traceId: null,
      sourceTurnRanges: [],
      boxIds: anchor.boxId ? [anchor.boxId] : []
    };
  }

  return {
    kind: "anchor",
    id: anchor.id,
    text: anchor.content,
    score: scoreText(topicWords, anchor.content) * anchorWeight,
    tokenCount: estimateTokenCount(anchor.content),
    canUseStub: false,
    scoringMethod: "keyword overlap",
    summaryId: null,
    summaryIds: [],
    traceId: null,
    sourceTurnRanges: [],
    boxIds: anchor.boxId ? [anchor.boxId] : []
  };
}

function rankTrace(
  topicWords: Set<string>,
  trace: MemoryTrace,
  linkedSummaries: Summary[]
): RankedMemory | null {
  const traceText = [
    trace.title,
    trace.description,
    trace.rationale,
    ...linkedSummaries.map((summary) => summary.summaryText)
  ].join(" ");
  const overlap = overlappingWords(topicWords, significantWords(traceText));
  const specificOverlap = overlap.filter((word) => !TRACE_BROAD_WORDS.has(word));

  if (specificOverlap.length < 2) {
    return null;
  }

  const linkedSummaryText = linkedSummaries
    .slice(0, 3)
    .map((summary) => `- ${summary.summaryText}`)
    .join("\n");
  const text = [
    `[Trace: ${trace.title}]`,
    trace.description,
    linkedSummaryText ? `Linked summaries:\n${linkedSummaryText}` : "",
    `Rationale: ${trace.rationale}`
  ].filter(Boolean).join("\n");

  return {
    kind: "trace",
    id: trace.id,
    text,
    score: Math.min(0.98, scoreText(topicWords, traceText) * trace.confidence * 1.05),
    tokenCount: estimateTokenCount(text),
    canUseStub: true,
    scoringMethod: "keyword overlap",
    summaryId: linkedSummaries[0]?.id ?? null,
    summaryIds: trace.summaryIds,
    traceId: trace.id,
    sourceTurnRanges: trace.turnRanges,
    boxIds: trace.boxIds
  };
}

function embeddingScore(
  options: {
    embedder?: Embedder;
    topicEmbedding: Summary["embedding"];
  },
  memoryEmbedding: Summary["embedding"]
): number | null {
  if (!options.embedder || !options.topicEmbedding || !memoryEmbedding) {
    return null;
  }
  if (
    memoryEmbedding.provider !== options.embedder.provider ||
    memoryEmbedding.model !== options.embedder.model ||
    memoryEmbedding.dimensions !== options.embedder.dimensions ||
    memoryEmbedding.dimensions !== options.topicEmbedding.dimensions
  ) {
    return null;
  }

  return Math.max(0, cosineSimilarity(options.topicEmbedding.vector, memoryEmbedding.vector));
}

function scoreText(topicWords: Set<string>, text: string): number {
  if (topicWords.size === 0) {
    return 0;
  }

  const memoryWords = significantWords(text);
  let overlap = 0;

  for (const word of topicWords) {
    if (memoryWords.has(word)) {
      overlap += 1;
    }
  }

  return overlap / topicWords.size;
}

function overlappingWords(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((word) => right.has(word));
}

function significantWords(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2)
      .filter((word) => !STOP_WORDS.has(word))
  );
}

function injectionId(request: InjectionRequest, selected: RankedMemory[], createdAt: string): string {
  const hash = createHash("sha256")
    .update(request.hostSessionId)
    .update(request.currentTopicSummary)
    .update(request.personId ?? "legacy-unscoped")
    .update((request.allowedScopeIds ?? []).slice().sort().join("|"))
    .update(createdAt)
    .update(selected.map((memory) => memory.id).join("|"))
    .digest("hex")
    .slice(0, 16);

  return `inject_${hash}`;
}

function dedupeTurnRanges(ranges: TurnRange[]): TurnRange[] {
  const seen = new Set<string>();
  const deduped: TurnRange[] = [];

  for (const range of ranges) {
    const key = `${range.threadId}:${range.startSequence}:${range.endSequence}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(range);
    }
  }

  return deduped;
}

function normalizedMemoryText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function buildRelevanceReason(selected: RankedMemory[]): string {
  const [first] = selected;
  return `Top ${first.kind} match ${first.id} scored ${first.score.toFixed(2)} by ${first.scoringMethod}.`;
}

function buildDisclosureText(
  selected: RankedMemory[],
  currentTopicSummary: string,
  selectedTokenCount: number,
  maxMemoryTokens?: number
): string {
  const parentContextCount = selected.filter((memory) => memory.kind === "box_context").length;
  const primaryCount = selected.length - parentContextCount;
  const parentText = parentContextCount > 0
    ? ` Included ${parentContextCount} parent box context item${parentContextCount === 1 ? "" : "s"}.`
    : "";
  const base = `Retrieved ${primaryCount} memory item${primaryCount === 1 ? "" : "s"} for ${currentTopicSummary}.${parentText}`;

  if (maxMemoryTokens === undefined) {
    return base;
  }

  return `${base} Packed using ${selectedTokenCount}/${maxMemoryTokens} memory tokens.`;
}

function estimateTokenCount(value: string): number {
  return Math.max(1, Math.ceil(value.split(/\s+/).filter(Boolean).length * 1.3));
}

const STOP_WORDS = new Set([
  "about",
  "again",
  "and",
  "are",
  "coverage",
  "current",
  "discussing",
  "for",
  "from",
  "memory",
  "prior",
  "the",
  "this",
  "turns",
  "user",
  "with"
]);

const TRACE_BROAD_WORDS = new Set(["case", "matter", "client", "claim", "overview", "general"]);
