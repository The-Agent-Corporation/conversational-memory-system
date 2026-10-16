import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  openRouterApiKeyRequired,
  resolveBaseUrl
} from "./config.js";
import {
  OpenRouterRequestError,
  SpendCapPausedError,
  type ModelOutputCacheEntry,
  type ModelUsageEntry,
  type OpenRouterLedger,
  type OpenRouterProviderPolicy,
  type OpenRouterUsage
} from "./types.js";

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  statusText?: string;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  }
) => Promise<FetchResponseLike>;

export interface OpenRouterClientOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Full chat completions URL. Overrides baseUrl derivation. Kept for existing callers. */
  chatEndpoint?: string;
  /** Full embeddings URL. Overrides baseUrl derivation. */
  embeddingsEndpoint?: string;
  referer?: string;
  title?: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  concurrency?: number;
  provider?: OpenRouterProviderPolicy;
  dailySpendCapUsd?: number;
  fetch?: FetchLike;
  ledger?: OpenRouterLedger;
  clock?: () => string;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const ChatCompletionSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string().min(1) })
  })).min(1),
  usage: z.object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
    cost: z.number().optional()
  }).optional()
});

const EmbeddingsSchema = z.object({
  data: z.array(z.object({
    index: z.number().int().nonnegative().optional(),
    embedding: z.array(z.number())
  })).min(1),
  usage: z.object({
    prompt_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
    cost: z.number().optional()
  }).optional()
});

const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);

export class OpenRouterClient {
  readonly baseUrl: string;
  readonly chatEndpoint: string;
  readonly embeddingsEndpoint: string;
  private readonly apiKey: string;
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly options: OpenRouterClientOptions = {}) {
    this.baseUrl = resolveBaseUrl(process.env, options.baseUrl ?? "");
    this.chatEndpoint = options.chatEndpoint ?? `${this.baseUrl}/chat/completions`;
    this.embeddingsEndpoint = options.embeddingsEndpoint ?? `${this.baseUrl}/embeddings`;
    this.apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY ?? "";
    if (openRouterApiKeyRequired(this.baseUrl) && !this.apiKey.trim()) {
      throw new OpenRouterRequestError("OpenRouter API key is required for the public OpenRouter API.");
    }
  }

  async chatJson(input: {
    model: string;
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    stage: string;
    promptVersion: string;
    cacheInput?: unknown;
    responseFormat?: "json_object" | null;
  }): Promise<{ content: string; usage: OpenRouterUsage; cached: boolean }> {
    const cacheKey = input.cacheInput === undefined
      ? null
      : cacheKeyFor(input.stage, input.promptVersion, input.model, input.cacheInput);
    if (cacheKey && this.options.ledger) {
      const cached = await this.options.ledger.getCachedOutput(cacheKey);
      if (cached !== null) {
        return { content: cached, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 }, cached: true };
      }
    }
    await this.assertSpendCap(input.stage);
    const body: Record<string, unknown> = {
      model: input.model,
      messages: input.messages
    };
    if (input.responseFormat !== null) body.response_format = { type: "json_object" };
    const provider = this.providerBody();
    if (provider) body.provider = provider;
    const responseText = await this.post(this.chatEndpoint, body, input.stage);
    const parsed = ChatCompletionSchema.parse(JSON.parse(responseText));
    const content = parsed.choices[0]!.message.content;
    const usage = usageFrom(parsed.usage);
    await this.record(input.stage, input.model, usage);
    if (cacheKey && this.options.ledger) {
      await this.options.ledger.putCachedOutput({
        cacheKey,
        stage: input.stage,
        promptVersion: input.promptVersion,
        model: input.model,
        inputSha256: cacheKey.split(":").at(-1) ?? cacheKey,
        outputJson: content,
        createdAt: this.now()
      });
    }
    return { content, usage, cached: false };
  }

  async embeddings(input: {
    model: string;
    input: string[];
    stage: string;
    dimensions?: number;
    inputType?: "search_document" | "search_query";
  }): Promise<{ vectors: number[][]; usage: OpenRouterUsage }> {
    if (input.input.length === 0) {
      return { vectors: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 } };
    }
    await this.assertSpendCap(input.stage);
    const body: Record<string, unknown> = {
      model: input.model,
      input: input.input.length === 1 ? input.input[0] : input.input
    };
    if (input.dimensions) body.dimensions = input.dimensions;
    if (input.inputType) body.input_type = input.inputType;
    const provider = this.providerBody();
    if (provider) body.provider = provider;
    const responseText = await this.post(this.embeddingsEndpoint, body, input.stage);
    const parsed = EmbeddingsSchema.parse(JSON.parse(responseText));
    const ordered = [...parsed.data].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
    const usage = usageFrom(parsed.usage);
    await this.record(input.stage, input.model, usage);
    return { vectors: ordered.map((row) => row.embedding), usage };
  }

  private providerBody(): OpenRouterProviderPolicy | undefined {
    const policy = this.options.provider ?? { data_collection: "deny" };
    return policy;
  }

  private async assertSpendCap(stage: string): Promise<void> {
    const cap = this.options.dailySpendCapUsd;
    if (cap === undefined || !this.options.ledger) return;
    const day = this.now().slice(0, 10);
    const spent = await this.options.ledger.spentOnDay(day);
    if (spent >= cap) throw new SpendCapPausedError(day, spent, cap);
    void stage;
  }

  private async record(stage: string, model: string, usage: OpenRouterUsage): Promise<void> {
    if (!this.options.ledger) return;
    const createdAt = this.now();
    const entry: ModelUsageEntry = {
      id: `usage_${randomUUID()}`,
      day: createdAt.slice(0, 10),
      stage,
      model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      costUsd: usage.costUsd,
      createdAt
    };
    await this.options.ledger.recordUsage(entry);
  }

  private async post(url: string, body: unknown, stage: string): Promise<string> {
    const maxRetries = this.options.maxRetries ?? 2;
    let attempt = 0;
    let lastError: unknown;
    while (attempt <= maxRetries) {
      await this.acquire();
      try {
        const timeoutMs = this.options.timeoutMs ?? 60_000;
        const response = await (this.options.fetch ?? defaultFetch)(url, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs)
        });
        const responseText = await response.text();
        if (response.ok) return responseText;
        const error = new OpenRouterRequestError(
          `OpenRouter ${stage} request failed with status ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`,
          response.status,
          responseText
        );
        if (!RETRYABLE.has(response.status) || attempt === maxRetries) throw error;
        lastError = error;
        const retryAfter = retryAfterMs(response.headers?.get("retry-after") ?? null);
        await this.backoff(attempt, retryAfter);
      } catch (error) {
        if (error instanceof OpenRouterRequestError && error.status !== undefined && !RETRYABLE.has(error.status)) {
          throw error;
        }
        if (error instanceof OpenRouterRequestError && attempt === maxRetries) throw error;
        if (attempt === maxRetries) {
          throw error instanceof OpenRouterRequestError
            ? error
            : new OpenRouterRequestError(error instanceof Error ? error.message : String(error));
        }
        lastError = error;
        await this.backoff(attempt, null);
      } finally {
        this.release();
      }
      attempt += 1;
    }
    throw lastError instanceof Error ? lastError : new OpenRouterRequestError("OpenRouter request failed.");
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey.trim()) headers.Authorization = `Bearer ${this.apiKey}`;
    const referer = this.options.referer ?? process.env.OPENROUTER_REFERER;
    const title = this.options.title ?? process.env.OPENROUTER_TITLE;
    if (referer) headers["HTTP-Referer"] = referer;
    if (title) headers["X-OpenRouter-Title"] = title;
    return headers;
  }

  private async acquire(): Promise<void> {
    const limit = this.options.concurrency ?? 4;
    if (this.inFlight < limit) {
      this.inFlight += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.inFlight += 1;
  }

  private release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const next = this.waiters.shift();
    if (next) next();
  }

  private async backoff(attempt: number, retryAfter: number | null): Promise<void> {
    const base = this.options.baseDelayMs ?? 25;
    const jitter = this.options.random?.() ?? Math.random();
    const delay = retryAfter ?? Math.round(base * (2 ** attempt) * (0.5 + jitter));
    await (this.options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(delay);
  }

  private now(): string {
    return this.options.clock?.() ?? new Date().toISOString();
  }
}

export function cacheKeyFor(stage: string, promptVersion: string, model: string, input: unknown): string {
  const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return `${stage}:${promptVersion}:${model}:${hash}`;
}

function usageFrom(usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number } | undefined): OpenRouterUsage {
  const promptTokens = usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: usage?.total_tokens ?? promptTokens + completionTokens,
    costUsd: usage?.cost ?? null
  };
}

function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - Date.now());
}

const defaultFetch: FetchLike = async (url, init) => {
  const response = await fetch(url, init);
  return response;
};

export type { ModelOutputCacheEntry };
