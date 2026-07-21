import { createHash } from "node:crypto";
import type { Embedding } from "../domain/types.js";

export interface Embedder {
  provider: string;
  model: string;
  dimensions: number;
  embed(text: string): Promise<Embedding>;
}

export interface DeterministicEmbedderOptions {
  dimensions?: number;
  createdAt?: string;
}

export class DeterministicEmbedder implements Embedder {
  readonly provider = "deterministic";
  readonly model = "keyword-hash-v1";
  readonly dimensions: number;

  private readonly createdAt?: string;

  constructor(options: DeterministicEmbedderOptions = {}) {
    this.dimensions = options.dimensions ?? 64;
    this.createdAt = options.createdAt;
  }

  async embed(text: string): Promise<Embedding> {
    const vector = new Array<number>(this.dimensions).fill(0);

    for (const token of tokenize(text)) {
      const hash = createHash("sha256").update(token).digest();
      const index = hash[0] % this.dimensions;
      const direction = hash[1] % 2 === 0 ? 1 : -1;
      vector[index] += direction;
    }

    return {
      provider: this.provider,
      model: this.model,
      dimensions: this.dimensions,
      vector: normalize(vector),
      createdAt: this.createdAt ?? new Date().toISOString()
    };
  }
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) {
    return 0;
  }

  let dotProduct = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    dotProduct += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value ** 2, 0));
  if (magnitude === 0) {
    return vector;
  }

  return vector.map((value) => value / magnitude);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/**
 * D-03: opt-in extension surface for embedders that support bge's asymmetric
 * embedding recipe (queries prefixed with an instruction string, stored
 * passages/summaries embedded bare). Extends, does not replace, `Embedder` —
 * `DeterministicEmbedder` never implements this, since it has no asymmetric
 * recipe; its `embed()` alone remains its passage-equivalent.
 */
export interface AsymmetricEmbedder extends Embedder {
  /** Embeds text as a search query (bge instruction-prefixed). */
  embedQuery(text: string): Promise<Embedding>;
}

export function isAsymmetricEmbedder(embedder: Embedder): embedder is AsymmetricEmbedder {
  return typeof (embedder as Partial<AsymmetricEmbedder>).embedQuery === "function";
}
