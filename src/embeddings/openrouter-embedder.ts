import type { Embedding } from "../domain/types.js";
import { OpenRouterClient, type FetchLike } from "../openrouter/client.js";
import type { OpenRouterLedger, OpenRouterProviderPolicy } from "../openrouter/types.js";
import type { AsymmetricEmbedder } from "./embedder.js";
import { composeModelIdentity } from "./embedder-identity.js";

export interface OpenRouterEmbedderOptions {
  model: string;
  apiKey?: string;
  baseUrl?: string;
  dimensions?: number;
  fetch?: FetchLike;
  ledger?: OpenRouterLedger;
  provider?: OpenRouterProviderPolicy;
  dailySpendCapUsd?: number;
  createdAt?: string;
}

export class OpenRouterEmbedder implements AsymmetricEmbedder {
  readonly provider = "openrouter";
  private readonly apiModel: string;
  private readonly client: OpenRouterClient;
  private readonly requestedDimensions: number | undefined;
  private readonly createdAt?: string;
  private lockedDimensions: number | null;

  constructor(options: OpenRouterEmbedderOptions) {
    if (!options.model.trim()) throw new Error("OpenRouter embedding model is required.");
    this.apiModel = options.model.trim();
    this.requestedDimensions = options.dimensions;
    this.lockedDimensions = options.dimensions ?? null;
    this.createdAt = options.createdAt;
    this.client = new OpenRouterClient({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      fetch: options.fetch,
      ledger: options.ledger,
      provider: options.provider,
      dailySpendCapUsd: options.dailySpendCapUsd
    });
  }

  /** Persisted vector identity. The API still receives `apiModel` alone. */
  get model(): string {
    const dimensions = this.requestedDimensions ?? this.lockedDimensions;
    return dimensions === null ? this.apiModel : composeModelIdentity(this.apiModel, String(dimensions));
  }

  get dimensions(): number {
    return this.requestedDimensions ?? this.lockedDimensions ?? 0;
  }

  async embed(text: string): Promise<Embedding> {
    const [embedding] = await this.embedBatch([text], "search_document");
    return embedding!;
  }

  async embedQuery(text: string): Promise<Embedding> {
    const [embedding] = await this.embedBatch([text], "search_query");
    return embedding!;
  }

  async embedBatch(
    texts: string[],
    inputType: "search_document" | "search_query" = "search_document"
  ): Promise<Embedding[]> {
    const result = await this.client.embeddings({
      model: this.apiModel,
      input: texts,
      stage: "embed",
      dimensions: this.requestedDimensions,
      inputType
    });
    return result.vectors.map((vector) => {
      if (this.lockedDimensions === null) this.lockedDimensions = vector.length;
      if (vector.length !== this.lockedDimensions) {
        throw new Error(`OpenRouter embedding dimension ${vector.length} does not match ${this.lockedDimensions}.`);
      }
      return {
        provider: this.provider,
        model: this.model,
        dimensions: vector.length,
        vector,
        createdAt: this.createdAt ?? new Date().toISOString()
      };
    });
  }
}
