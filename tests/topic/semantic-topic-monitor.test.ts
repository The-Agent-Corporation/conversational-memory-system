import { describe, expect, it } from "vitest";
import type { Embedding } from "../../src/domain/types.js";
import type { Embedder } from "../../src/embeddings/embedder.js";
import { SemanticTopicMonitor } from "../../src/topic/semantic-topic-monitor.js";

function embedder(vectors: number[][]): Embedder {
  let index = 0;
  return {
    provider: "test",
    model: "test",
    dimensions: 2,
    async embed(): Promise<Embedding> {
      const vector = vectors[index] ?? vectors.at(-1)!;
      index += 1;
      return { provider: "test", model: "test", dimensions: vector.length, vector, createdAt: "2026-10-16T00:00:00.000Z" };
    }
  };
}

const turn = (id: string, sequence: number, content: string) => ({
  id,
  host: "cordis" as const,
  profileId: "person",
  hostSessionId: "session",
  sequence,
  type: "conversation_turn" as const,
  role: "user" as const,
  content,
  createdAt: "2026-10-16T00:00:00.000Z",
  metadata: {}
});

describe("SemanticTopicMonitor", () => {
  it("keeps a similar turn in the same span and splits a dissimilar one", async () => {
    const monitor = new SemanticTopicMonitor(embedder([[1, 0], [0.9, 0.1], [0, 1]]), 0.72);
    const first = await monitor.observe(turn("e1", 1, "coverage PIP"));
    expect(first.completed).toBeNull();
    const second = await monitor.observe(turn("e2", 2, "coverage PIP follow up"));
    expect(second.topicChanged).toBe(false);
    expect(second.current?.turnCount).toBe(2);
    const third = await monitor.observe(turn("e3", 3, "garden tomatoes"));
    expect(third.topicChanged).toBe(true);
    expect(third.completed?.lastEventId).toBe("e2");
    expect(third.current?.turnCount).toBe(1);
    expect(third.current?.lastEventId).toBe("e3");
  });
});
