import { cosineSimilarity, type Embedder } from "../embeddings/embedder.js";
import type { HostEvent } from "../domain/events.js";
import {
  TopicMonitor,
  type CompletedTopicSpan,
  type RollingTopicState,
  type TopicMonitorResult
} from "./topic-monitor.js";

export const DEFAULT_TOPIC_SIMILARITY_THRESHOLD = 0.72;

/**
 * Topic boundaries from embedding similarity against the running topic vector.
 * The provisional label stays on the deterministic monitor until a model title
 * replaces it at span completion. Summary identity must not hash that label.
 */
export class SemanticTopicMonitor {
  private readonly fallback = new TopicMonitor();
  private readonly vectors = new Map<string, number[]>();

  constructor(
    private readonly embedder: Embedder,
    private readonly threshold = DEFAULT_TOPIC_SIMILARITY_THRESHOLD
  ) {}

  async observe(event: HostEvent): Promise<TopicMonitorResult> {
    if (event.type !== "conversation_turn") return this.fallback.observe(event);
    const embedding = await this.embedder.embed(event.content);
    const existing = this.fallback.current(event.hostSessionId);
    const previous = this.vectors.get(event.hostSessionId) ?? null;
    if (!existing || !previous) {
      const current = freshState(event);
      this.fallback.restore(current);
      this.vectors.set(event.hostSessionId, embedding.vector);
      return { current, topicChanged: false, completed: null };
    }
    if (cosineSimilarity(previous, embedding.vector) < this.threshold) {
      const completed: CompletedTopicSpan = { ...existing, completedAt: event.createdAt };
      const current = freshState(event);
      this.fallback.restore(current);
      this.vectors.set(event.hostSessionId, embedding.vector);
      return { current, topicChanged: true, completed };
    }
    const current = extendState(existing, event);
    this.fallback.restore(current);
    this.vectors.set(event.hostSessionId, average(previous, embedding.vector));
    return { current, topicChanged: false, completed: null };
  }

  current(hostSessionId: string): RollingTopicState | null {
    return this.fallback.current(hostSessionId);
  }

  restore(state: RollingTopicState): void {
    this.fallback.restore(state);
  }
}

function freshState(event: Extract<HostEvent, { type: "conversation_turn" }>): RollingTopicState {
  return {
    host: event.host,
    profileId: event.profileId,
    hostSessionId: event.hostSessionId,
    topicLabel: "open topic",
    currentTopicSummary: "open topic",
    sourceTurnRange: {
      threadId: event.hostSessionId,
      startSequence: event.sequence,
      endSequence: event.sequence
    },
    turnCount: 1,
    lastEventId: event.id,
    updatedAt: event.createdAt
  };
}

function extendState(existing: RollingTopicState, event: Extract<HostEvent, { type: "conversation_turn" }>): RollingTopicState {
  const startSequence = Math.min(existing.sourceTurnRange.startSequence, event.sequence);
  const endSequence = Math.max(existing.sourceTurnRange.endSequence, event.sequence);
  const turnCount = existing.turnCount + 1;
  return {
    ...existing,
    currentTopicSummary: `${existing.topicLabel} (${turnCount} turns, seq ${startSequence}-${endSequence})`,
    sourceTurnRange: { threadId: existing.hostSessionId, startSequence, endSequence },
    turnCount,
    lastEventId: event.id,
    updatedAt: event.createdAt
  };
}

function average(left: number[], right: number[]): number[] {
  if (left.length !== right.length) return right;
  return left.map((value, index) => (value + right[index]!) / 2);
}
