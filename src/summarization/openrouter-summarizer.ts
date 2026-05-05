import { z } from "zod";
import type { Summarizer, SummarizerInput, SummaryDraft } from "./summarizer.js";

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
  }
) => Promise<FetchResponseLike>;

export interface OpenRouterSummarizerOptions {
  apiKey: string;
  model: string;
  endpoint?: string;
  referer?: string;
  title?: string;
  fetch?: FetchLike;
}

export type OpenRouterEnvironment = Partial<Record<
  "OPENROUTER_API_KEY" | "OPENROUTER_MODEL" | "OPENROUTER_REFERER" | "OPENROUTER_TITLE",
  string | undefined
>>;

export class OpenRouterSummarizerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly responseText?: string
  ) {
    super(message);
    this.name = "OpenRouterSummarizerError";
  }
}

const DEFAULT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const PROMPT_VERSION = "openrouter-summarizer-v1";

const ChatCompletionResponseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      content: z.string().min(1)
    })
  })).min(1)
});

const SummaryContentSchema = z.object({
  summaryText: z.string().min(1),
  confidence: z.number().min(0).max(1),
  detailLevel: z.enum(["full", "medium", "brief", "stub"]),
  tokenCount: z.number().int().nonnegative()
});

export class OpenRouterSummarizer implements Summarizer {
  readonly providerModel: string;

  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly referer?: string;
  private readonly title?: string;
  private readonly fetchFn: FetchLike;

  constructor(options: OpenRouterSummarizerOptions) {
    if (!options.apiKey.trim()) {
      throw new OpenRouterSummarizerError("OpenRouter API key is required.");
    }
    if (!options.model.trim()) {
      throw new OpenRouterSummarizerError("OpenRouter model is required.");
    }

    this.apiKey = options.apiKey;
    this.providerModel = options.model;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.referer = options.referer;
    this.title = options.title;
    this.fetchFn = options.fetch ?? globalFetch;
  }

  static fromEnv(
    env: OpenRouterEnvironment = process.env,
    overrides: Partial<Omit<OpenRouterSummarizerOptions, "apiKey" | "model">> = {}
  ): OpenRouterSummarizer {
    return new OpenRouterSummarizer({
      apiKey: env.OPENROUTER_API_KEY ?? "",
      model: env.OPENROUTER_MODEL ?? "",
      referer: env.OPENROUTER_REFERER,
      title: env.OPENROUTER_TITLE,
      ...overrides
    });
  }

  async summarize(input: SummarizerInput): Promise<SummaryDraft> {
    const response = await this.fetchFn(this.endpoint, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify({
        model: this.providerModel,
        messages: [
          {
            role: "system",
            content: [
              "You summarize completed conversation topic spans for a source-linked memory system.",
              "Return JSON only with summaryText, confidence, detailLevel, and tokenCount.",
              "Preserve legal case names, coverage types, deadlines, decisions, and uncertainty."
            ].join(" ")
          },
          {
            role: "user",
            content: JSON.stringify(toPromptPayload(input))
          }
        ],
        response_format: { type: "json_object" }
      })
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new OpenRouterSummarizerError(
        `OpenRouter request failed with status ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`,
        response.status,
        responseText
      );
    }

    const chatResponse = parseJson(responseText, "OpenRouter returned invalid chat JSON.");
    const parsedChatResponse = ChatCompletionResponseSchema.safeParse(chatResponse);
    if (!parsedChatResponse.success) {
      throw new OpenRouterSummarizerError(
        `OpenRouter chat response did not match the expected shape: ${parsedChatResponse.error.message}`,
        response.status,
        responseText
      );
    }

    const content = parsedChatResponse.data.choices[0].message.content;
    const summaryContent = parseJson(content, "OpenRouter model returned invalid summary JSON.");
    const parsedSummary = SummaryContentSchema.safeParse(summaryContent);
    if (!parsedSummary.success) {
      throw new OpenRouterSummarizerError(
        `OpenRouter summary JSON did not match the expected shape: ${parsedSummary.error.message}`,
        response.status,
        content
      );
    }

    return {
      ...parsedSummary.data,
      model: `openrouter:${this.providerModel}`,
      promptVersion: PROMPT_VERSION
    };
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json"
    };

    if (this.referer) {
      headers["HTTP-Referer"] = this.referer;
    }
    if (this.title) {
      headers["X-OpenRouter-Title"] = this.title;
    }

    return headers;
  }
}

function parseJson(value: string, message: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new OpenRouterSummarizerError(message, undefined, value);
  }
}

function toPromptPayload(input: SummarizerInput): unknown {
  return {
    topic: {
      label: input.span.topicLabel,
      summary: input.span.currentTopicSummary,
      sourceTurnRange: input.span.sourceTurnRange,
      turnCount: input.span.turnCount,
      completedAt: input.span.completedAt
    },
    sourceTurns: input.sourceTurns.map((turn) => ({
      id: turn.id,
      sequence: turn.sequence,
      role: turn.role,
      content: turn.content,
      createdAt: turn.createdAt,
      trustLevel: turn.trustLevel
    }))
  };
}

const globalFetch: FetchLike = async (url, init) => {
  if (typeof fetch !== "function") {
    throw new OpenRouterSummarizerError("No fetch implementation is available.");
  }

  const response = await fetch(url, init);
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    text: () => response.text()
  };
};
