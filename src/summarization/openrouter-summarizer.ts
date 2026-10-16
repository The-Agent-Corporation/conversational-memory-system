import { z } from "zod";
import { OpenRouterClient, type FetchLike } from "../openrouter/client.js";
import { OpenRouterRequestError } from "../openrouter/types.js";
import type { Summarizer, SummarizerInput, SummaryDraft } from "./summarizer.js";

export type { FetchLike };

export interface OpenRouterSummarizerOptions {
  apiKey?: string;
  model: string;
  endpoint?: string;
  baseUrl?: string;
  referer?: string;
  title?: string;
  fetch?: FetchLike;
  dailySpendCapUsd?: number;
  ledger?: import("../openrouter/types.js").OpenRouterLedger;
}

export type OpenRouterEnvironment = Partial<Record<
  "OPENROUTER_API_KEY" | "OPENROUTER_MODEL" | "OPENROUTER_BASE_URL" | "OPENROUTER_REFERER" | "OPENROUTER_TITLE",
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

const PROMPT_VERSION = "openrouter-summarizer-v2";

export const PERSONAL_AGENT_SUMMARY_PROMPT = [
  "You summarize a completed conversation span for a personal agent's source-linked memory.",
  "Return JSON only with title, summaryText, confidence, detailLevel, tokenCount, and anchors.",
  "title is a short human description of the span, not a keyword list.",
  "summaryText states what was decided and why, facts about the person and their preferences,",
  "commitments, deadlines, open questions, and uncertainty.",
  "When the conversation uses a specialized domain, preserve its exact terms: project and repository names,",
  "legal case names, coverage types, identifiers, and distinctions such as PIP versus BI.",
  "anchors is an array of { anchorType, content, turnSequence } where anchorType is one of",
  "deadline, decision, key_fact, strategic_insight, bookmark. Only anchor conversational turns.",
  "Do not invent facts that are not in the turns."
].join(" ");

const SummaryContentSchema = z.object({
  title: z.string().min(1).optional(),
  summaryText: z.string().min(1),
  confidence: z.number().min(0).max(1),
  detailLevel: z.enum(["full", "medium", "brief", "stub"]),
  tokenCount: z.number().int().nonnegative(),
  anchors: z.array(z.object({
    anchorType: z.enum(["deadline", "decision", "key_fact", "strategic_insight", "bookmark"]),
    content: z.string().min(1),
    turnSequence: z.number().int().nonnegative().optional()
  })).optional()
});

export class OpenRouterSummarizer implements Summarizer {
  readonly providerModel: string;
  private readonly client: OpenRouterClient;

  constructor(options: OpenRouterSummarizerOptions) {
    if (!options.model.trim()) {
      throw new OpenRouterSummarizerError("OpenRouter model is required.");
    }
    this.providerModel = options.model;
    this.client = new OpenRouterClient({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      chatEndpoint: options.endpoint,
      referer: options.referer,
      title: options.title,
      fetch: options.fetch,
      dailySpendCapUsd: options.dailySpendCapUsd,
      ledger: options.ledger
    });
  }

  static fromEnv(
    env: OpenRouterEnvironment = process.env,
    overrides: Partial<Omit<OpenRouterSummarizerOptions, "apiKey" | "model">> = {}
  ): OpenRouterSummarizer {
    return new OpenRouterSummarizer({
      apiKey: env.OPENROUTER_API_KEY ?? "",
      model: env.OPENROUTER_MODEL ?? "",
      baseUrl: env.OPENROUTER_BASE_URL,
      referer: env.OPENROUTER_REFERER,
      title: env.OPENROUTER_TITLE,
      ...overrides
    });
  }

  async summarize(input: SummarizerInput): Promise<SummaryDraft> {
    let content: string;
    try {
      const result = await this.client.chatJson({
        model: this.providerModel,
        stage: "summarize",
        promptVersion: PROMPT_VERSION,
        cacheInput: toPromptPayload(input),
        messages: [
          { role: "system", content: PERSONAL_AGENT_SUMMARY_PROMPT },
          { role: "user", content: JSON.stringify(toPromptPayload(input)) }
        ]
      });
      content = result.content;
    } catch (error) {
      if (error instanceof OpenRouterRequestError) {
        throw new OpenRouterSummarizerError(error.message, error.status, error.responseText);
      }
      throw error;
    }

    const summaryContent = parseJson(content, "OpenRouter model returned invalid summary JSON.");
    const parsedSummary = SummaryContentSchema.safeParse(summaryContent);
    if (!parsedSummary.success) {
      throw new OpenRouterSummarizerError(
        `OpenRouter summary JSON did not match the expected shape: ${parsedSummary.error.message}`,
        undefined,
        content
      );
    }

    return {
      summaryText: parsedSummary.data.summaryText,
      confidence: parsedSummary.data.confidence,
      detailLevel: parsedSummary.data.detailLevel,
      tokenCount: parsedSummary.data.tokenCount,
      ...(parsedSummary.data.title ? { title: parsedSummary.data.title } : {}),
      ...(parsedSummary.data.anchors ? { anchors: parsedSummary.data.anchors } : {}),
      model: `openrouter:${this.providerModel}`,
      promptVersion: PROMPT_VERSION
    };
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
