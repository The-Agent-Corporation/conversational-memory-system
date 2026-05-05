import { createHash } from "node:crypto";
import type { Anchor, InjectionPacket, Summary, TurnRange } from "../domain/types.js";
import type { InjectionRequest } from "../service/memory-service.js";
import type { MemoryStore } from "../storage/memory-store.js";

interface RankedMemory {
  kind: "summary" | "anchor";
  id: string;
  text: string;
  score: number;
  summaryId: string | null;
  sourceTurnRanges: TurnRange[];
  boxIds: string[];
}

export class MemoryRetriever {
  constructor(private readonly store: MemoryStore) {}

  async prepareInjection(request: InjectionRequest): Promise<InjectionPacket | null> {
    const [summaries, anchors] = await Promise.all([
      this.store.listSummaries(),
      this.store.listAnchors()
    ]);
    const ranked = rankMemories(request.currentTopicSummary, summaries, anchors);

    if (ranked.length === 0) {
      return null;
    }

    const selected = ranked.slice(0, 3);
    const createdAt = request.requestedAt ?? new Date().toISOString();
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
      disclosureText: `Retrieved ${selected.length} memory item${selected.length === 1 ? "" : "s"} for ${request.currentTopicSummary}.`,
      createdAt
    };

    await this.store.saveInjection(packet);
    return packet;
  }
}

function rankMemories(
  topicSummary: string,
  summaries: Summary[],
  anchors: Anchor[]
): RankedMemory[] {
  const topicWords = significantWords(topicSummary);
  const ranked: RankedMemory[] = [
    ...summaries.map((summary) => rankSummary(topicWords, summary)),
    ...anchors.map((anchor) => rankAnchor(topicWords, anchor))
  ].filter((memory) => memory.score > 0);

  return ranked.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

function rankSummary(topicWords: Set<string>, summary: Summary): RankedMemory {
  return {
    kind: "summary",
    id: summary.id,
    text: summary.summaryText,
    score: scoreText(topicWords, summary.summaryText) * summary.confidence,
    summaryId: summary.id,
    sourceTurnRanges: summary.sourceTurnRanges,
    boxIds: summary.boxIds
  };
}

function rankAnchor(topicWords: Set<string>, anchor: Anchor): RankedMemory {
  const anchorWeight = anchor.anchorType === "deadline" || anchor.anchorType === "decision" ? 1.1 : 1;

  return {
    kind: "anchor",
    id: anchor.id,
    text: anchor.content,
    score: scoreText(topicWords, anchor.content) * anchorWeight,
    summaryId: null,
    sourceTurnRanges: [],
    boxIds: anchor.boxId ? [anchor.boxId] : []
  };
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
  return `Top ${first.kind} match ${first.id} scored ${first.score.toFixed(2)} by keyword overlap.`;
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
