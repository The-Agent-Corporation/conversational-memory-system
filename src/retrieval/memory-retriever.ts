import { createHash } from "node:crypto";
import type { Anchor, InjectionPacket, Summary, TurnRange } from "../domain/types.js";
import { cosineSimilarity, type Embedder } from "../embeddings/embedder.js";
import type { InjectionRequest } from "../service/memory-service.js";
import type { MemoryStore } from "../storage/memory-store.js";

interface RankedMemory {
  kind: "summary" | "anchor";
  id: string;
  text: string;
  score: number;
  tokenCount: number;
  scoringMethod: "keyword overlap" | "vector similarity";
  summaryId: string | null;
  sourceTurnRanges: TurnRange[];
  boxIds: string[];
}

export class MemoryRetriever {
  constructor(
    private readonly store: MemoryStore,
    private readonly options: { embedder?: Embedder } = {}
  ) {}

  async prepareInjection(request: InjectionRequest): Promise<InjectionPacket | null> {
    const [summaries, anchors] = await Promise.all([
      this.store.listSummaries(),
      this.store.listAnchors()
    ]);
    const topicEmbedding = this.options.embedder
      ? await this.options.embedder.embed(request.currentTopicSummary)
      : null;
    const ranked = rankMemories(request.currentTopicSummary, summaries, anchors, {
      embedder: this.options.embedder,
      topicEmbedding
    });

    if (ranked.length === 0) {
      return null;
    }

    const selected = selectMemories(ranked, request.maxMemoryTokens);
    if (selected.length === 0) {
      return null;
    }

    const createdAt = request.requestedAt ?? new Date().toISOString();
    const selectedTokenCount = selected.reduce((sum, memory) => sum + memory.tokenCount, 0);
    const packet: InjectionPacket = {
      id: injectionId(request, selected, createdAt),
      hostSessionId: request.hostSessionId,
      currentTopicSummary: request.currentTopicSummary,
      selectedMemory: selected.map((memory) => memory.text).join("\n\n"),
      sourceSummaryIds: selected
        .map((memory) => memory.summaryId)
        .filter((summaryId): summaryId is string => summaryId !== null),
      sourceTurnRanges: dedupeTurnRanges(selected.flatMap((memory) => memory.sourceTurnRanges)),
      boxIds: [...new Set(selected.flatMap((memory) => memory.boxIds))],
      relevanceReason: buildRelevanceReason(selected),
      confidence: Math.min(0.95, Math.max(0.1, selected[0].score)),
      disclosureText: buildDisclosureText(selected.length, request.currentTopicSummary, selectedTokenCount, request.maxMemoryTokens),
      createdAt
    };

    await this.store.saveInjection(packet);
    await this.recordSelectedSummaryAccess(summaries, selected, createdAt);
    return packet;
  }

  private async recordSelectedSummaryAccess(
    summaries: Summary[],
    selected: RankedMemory[],
    accessedAt: string
  ): Promise<void> {
    const selectedSummaryIds = new Set(
      selected
        .map((memory) => memory.summaryId)
        .filter((summaryId): summaryId is string => summaryId !== null)
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
        state: summary.state === "stale" ? "revived" : summary.state
      });
    }
  }
}

function selectMemories(ranked: RankedMemory[], maxMemoryTokens?: number): RankedMemory[] {
  if (maxMemoryTokens === undefined) {
    return ranked.slice(0, 3);
  }

  const selected: RankedMemory[] = [];
  let usedTokens = 0;

  for (const memory of ranked) {
    if (selected.length >= 3) {
      break;
    }
    if (usedTokens + memory.tokenCount > maxMemoryTokens) {
      continue;
    }

    selected.push(memory);
    usedTokens += memory.tokenCount;
  }

  return selected;
}

function strengthen(strength: number): number {
  return Math.min(1, Number((strength + 0.05).toFixed(2)));
}

function rankMemories(
  topicSummary: string,
  summaries: Summary[],
  anchors: Anchor[],
  options: {
    embedder?: Embedder;
    topicEmbedding: Summary["embedding"];
  } = { topicEmbedding: null }
): RankedMemory[] {
  const topicWords = significantWords(topicSummary);
  const ranked: RankedMemory[] = [
    ...summaries.map((summary) => rankSummary(topicWords, summary, options)),
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
      scoringMethod: "vector similarity",
      summaryId: summary.id,
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
    scoringMethod: "keyword overlap",
    summaryId: summary.id,
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
      scoringMethod: "vector similarity",
      summaryId: null,
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
    scoringMethod: "keyword overlap",
    summaryId: null,
    sourceTurnRanges: [],
    boxIds: anchor.boxId ? [anchor.boxId] : []
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

function buildRelevanceReason(selected: RankedMemory[]): string {
  const [first] = selected;
  return `Top ${first.kind} match ${first.id} scored ${first.score.toFixed(2)} by ${first.scoringMethod}.`;
}

function buildDisclosureText(
  selectedCount: number,
  currentTopicSummary: string,
  selectedTokenCount: number,
  maxMemoryTokens?: number
): string {
  const base = `Retrieved ${selectedCount} memory item${selectedCount === 1 ? "" : "s"} for ${currentTopicSummary}.`;

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
