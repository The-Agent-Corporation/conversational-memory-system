import type { Summary } from "../domain/types.js";
import type { MemoryStore } from "../storage/memory-store.js";
import type { CompletedTopicSpan } from "../topic/topic-monitor.js";

export interface PreCompactionResult {
  summary: Summary;
  sourceTurnCount: number;
}

export class PreCompactor {
  constructor(private readonly store: MemoryStore) {}

  async compactCompletedTopic(span: CompletedTopicSpan): Promise<PreCompactionResult> {
    const sourceTurns = await this.store.listTurns(span.hostSessionId);
    const turnsInSpan = sourceTurns.filter(
      (turn) =>
        turn.sequence >= span.sourceTurnRange.startSequence &&
        turn.sequence <= span.sourceTurnRange.endSequence
    );

    const summary: Summary = {
      id: summaryIdForSpan(span),
      summaryText: buildSummaryText(span, turnsInSpan.map((turn) => turn.content)),
      sourceTurnRanges: [span.sourceTurnRange],
      sourceSummaryIds: [],
      boxIds: [],
      embedding: null,
      createdAt: span.completedAt,
      model: "deterministic-pre-compactor",
      promptVersion: "pre-compaction-v1",
      confidence: 0.7,
      state: "compacted",
      detailLevel: "brief",
      tokenCount: estimateTokenCount(span.currentTopicSummary),
      lastAccessedAt: null,
      version: 1,
      strength: 0.5,
      retrievalCount: 0,
      retrievedAt: null,
      halfLifeHours: 168,
      outcomeScore: null
    };

    await this.store.saveSummary(summary);

    return {
      summary,
      sourceTurnCount: turnsInSpan.length
    };
  }
}

function summaryIdForSpan(span: CompletedTopicSpan): string {
  return [
    "summary",
    span.hostSessionId,
    span.sourceTurnRange.startSequence,
    span.sourceTurnRange.endSequence
  ].join("_");
}

function buildSummaryText(span: CompletedTopicSpan, sourceContents: string[]): string {
  const sourcePreview = sourceContents
    .map((content) => content.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" ");

  if (!sourcePreview) {
    return span.currentTopicSummary;
  }

  return `${span.currentTopicSummary}: ${sourcePreview}`;
}

function estimateTokenCount(value: string): number {
  return Math.max(1, Math.ceil(value.split(/\s+/).filter(Boolean).length * 1.3));
}
