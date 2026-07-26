import { BoxAssigner } from "../boxes/box-assigner.js";
import type { Summary } from "../domain/types.js";
import type { Embedder } from "../embeddings/embedder.js";
import {
  DeterministicSummarizer,
  type Summarizer
} from "../summarization/summarizer.js";
import type { MemoryStore } from "../storage/memory-store.js";
import type { CompletedTopicSpan } from "../topic/topic-monitor.js";
import { derivationContents } from "../topic/derivation-hygiene.js";

export interface PreCompactionResult {
  summary: Summary;
  sourceTurnCount: number;
}

export class PreCompactor {
  private readonly boxAssigner: BoxAssigner;

  constructor(
    private readonly store: MemoryStore,
    private readonly summarizer: Summarizer = new DeterministicSummarizer(),
    private readonly embedder?: Embedder
  ) {
    this.boxAssigner = new BoxAssigner(store);
  }

  async compactCompletedTopic(span: CompletedTopicSpan): Promise<PreCompactionResult> {
    const sourceTurns = await this.store.listTurns(span.hostSessionId);
    const turnsInSpan = sourceTurns.filter(
      (turn) =>
        turn.sequence >= span.sourceTurnRange.startSequence &&
        turn.sequence <= span.sourceTurnRange.endSequence
    );
    // 11-CONTEXT decision 5: hygiene-transform the summarizer input via the SAME shared
    // module the daemon/contraction path uses. This changes text only; sourceTurnRanges and
    // sourceTurnCount below are still computed from the raw turnsInSpan — hygiene never
    // changes provenance.
    const hygieneTurns = derivationContents(turnsInSpan).map(({ index, content }) => ({
      ...turnsInSpan[index],
      content
    }));
    const draft = await this.summarizer.summarize({ span, sourceTurns: hygieneTurns });
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
    const assignedSummary = await this.boxAssigner.assignSummary(summary);

    await this.store.saveSummary(assignedSummary);

    return {
      summary: assignedSummary,
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
