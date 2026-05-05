import type { Summary } from "../domain/types.js";
import type { Embedder } from "../embeddings/embedder.js";
import {
  DeterministicSummarizer,
  type Summarizer
} from "../summarization/summarizer.js";
import type { MemoryStore } from "../storage/memory-store.js";
import type { CompletedTopicSpan } from "../topic/topic-monitor.js";

export interface PreCompactionResult {
  summary: Summary;
  sourceTurnCount: number;
}

export class PreCompactor {
  constructor(
    private readonly store: MemoryStore,
    private readonly summarizer: Summarizer = new DeterministicSummarizer(),
    private readonly embedder?: Embedder
  ) {}

  async compactCompletedTopic(span: CompletedTopicSpan): Promise<PreCompactionResult> {
    const sourceTurns = await this.store.listTurns(span.hostSessionId);
    const turnsInSpan = sourceTurns.filter(
      (turn) =>
        turn.sequence >= span.sourceTurnRange.startSequence &&
        turn.sequence <= span.sourceTurnRange.endSequence
    );
    const draft = await this.summarizer.summarize({ span, sourceTurns: turnsInSpan });
    const embedding = this.embedder ? await this.embedder.embed(draft.summaryText) : null;

    const summary: Summary = {
      id: summaryIdForSpan(span),
      summaryText: draft.summaryText,
      sourceTurnRanges: [span.sourceTurnRange],
      sourceSummaryIds: [],
      boxIds: [],
      embedding,
      createdAt: span.completedAt,
      model: draft.model,
      promptVersion: draft.promptVersion,
      confidence: draft.confidence,
      state: "compacted",
      detailLevel: draft.detailLevel,
      tokenCount: draft.tokenCount,
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
