import type { Anchor, Summary } from "../domain/types.js";
import type { CompletedTopicSpan } from "../topic/topic-monitor.js";
import type { Turn } from "../domain/types.js";
import {
  OpenRouterSummarizer,
  type OpenRouterEnvironment,
  type OpenRouterSummarizerOptions
} from "./openrouter-summarizer.js";

export interface SummarizerInput {
  span: CompletedTopicSpan;
  sourceTurns: Turn[];
}

export type SummaryDraft = Pick<
  Summary,
  "summaryText" | "model" | "promptVersion" | "confidence" | "detailLevel" | "tokenCount"
> & {
  title?: string;
  anchors?: Array<{
    anchorType: Anchor["anchorType"];
    content: string;
    turnSequence?: number;
  }>;
};

export interface Summarizer {
  summarize(input: SummarizerInput): Promise<SummaryDraft>;
}

export type SummarizerEnvironment = OpenRouterEnvironment;
export type SummarizerFactoryOptions = Partial<Omit<OpenRouterSummarizerOptions, "apiKey" | "model">>;

export function createSummarizerFromEnv(
  env: SummarizerEnvironment = process.env,
  options: SummarizerFactoryOptions = {}
): Summarizer {
  if (env.OPENROUTER_API_KEY?.trim() && env.OPENROUTER_MODEL?.trim()) {
    return OpenRouterSummarizer.fromEnv(env, options);
  }

  return new DeterministicSummarizer();
}

export class DeterministicSummarizer implements Summarizer {
  async summarize(input: SummarizerInput): Promise<SummaryDraft> {
    return {
      summaryText: buildSummaryText(input.span, input.sourceTurns.map((turn) => turn.content)),
      model: "deterministic-summarizer",
      promptVersion: "deterministic-v1",
      confidence: 0.7,
      detailLevel: "brief",
      tokenCount: estimateTokenCount(input.span.currentTopicSummary)
    };
  }
}

function buildSummaryText(span: CompletedTopicSpan, sourceContents: string[]): string {
  const sourcePreview = sourceContents
    .map((content) => content.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" ");

  if (!sourcePreview) {
    return span.currentTopicSummary;
  }

  return `${span.currentTopicSummary}: ${sourcePreview}`;
}

function estimateTokenCount(value: string): number {
  return Math.max(1, Math.ceil(value.split(/\s+/).filter(Boolean).length * 1.3));
}
