import { describe, expect, it } from "vitest";
import { cosineSimilarity, DeterministicEmbedder } from "../../src/embeddings/embedder.js";

describe("embedding utilities", () => {
  it("computes cosine similarity for equal-dimension vectors", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it("returns zero similarity for incompatible vectors", () => {
    expect(cosineSimilarity([1, 0], [1])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it("creates deterministic embeddings with provider, model, dimensions, and timestamp metadata", async () => {
    const embedder = new DeterministicEmbedder({
      dimensions: 8,
      createdAt: "2026-05-05T10:00:00.000Z"
    });

    const embedding = await embedder.embed("Smith PIP demand strategy");

    expect(embedding).toMatchObject({
      provider: "deterministic",
      model: "keyword-hash-v1",
      dimensions: 8,
      createdAt: "2026-05-05T10:00:00.000Z"
    });
    expect(embedding.vector).toHaveLength(8);
    await expect(embedder.embed("Smith PIP demand strategy")).resolves.toEqual(embedding);
  });
});
