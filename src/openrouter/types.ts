export interface OpenRouterProviderPolicy {
  only?: string[];
  order?: string[];
  ignore?: string[];
  allow_fallbacks?: boolean;
  data_collection?: "deny" | "allow";
  zdr?: boolean;
}

export interface OpenRouterUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number | null;
}

export interface ModelUsageEntry {
  id: string;
  day: string;
  stage: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number | null;
  createdAt: string;
}

export interface ModelOutputCacheEntry {
  cacheKey: string;
  stage: string;
  promptVersion: string;
  model: string;
  inputSha256: string;
  outputJson: string;
  createdAt: string;
}

export interface OpenRouterLedger {
  spentOnDay(day: string): Promise<number>;
  recordUsage(entry: ModelUsageEntry): Promise<void>;
  getCachedOutput(cacheKey: string): Promise<string | null>;
  putCachedOutput(entry: ModelOutputCacheEntry): Promise<void>;
}

export class SpendCapPausedError extends Error {
  constructor(readonly day: string, readonly spentUsd: number, readonly capUsd: number) {
    super(`OpenRouter daily spend cap reached (${spentUsd} of ${capUsd} USD on ${day}). Semantic stages are paused.`);
    this.name = "SpendCapPausedError";
  }
}

export class OpenRouterRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly responseText?: string
  ) {
    super(message);
    this.name = "OpenRouterRequestError";
  }
}
