import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { OpenRouterClient } from "../src/openrouter/client.js";
import {
  CHAT_BAKEOFF_CASES,
  CHAT_BAKEOFF_MODELS,
  EMBEDDING_MODEL,
  qualityPoints,
  scoreSummary
} from "../src/openrouter/bakeoff-score.js";
import { OpenRouterRequestError, type OpenRouterLedger } from "../src/openrouter/types.js";
import {
  PERSONAL_AGENT_SUMMARY_PROMPT,
  SUMMARY_PROMPT_VERSION
} from "../src/summarization/openrouter-summarizer.js";

const SPEND_CAP_USD = 5;

export interface ChatBakeoffRow {
  model: string;
  caseId: string;
  run: number;
  ok: boolean;
  ms: number;
  costUsd: number | null;
  promptTokens: number;
  completionTokens: number;
  quality: number;
  schemaValid: boolean;
  requiredMisses: string[];
  forbiddenHits: string[];
  title: string | null;
  error: string | null;
}

export interface ChatBakeoffModelSummary {
  model: string;
  calls: number;
  passed: number;
  schemaValid: number;
  meanQuality: number;
  medianMs: number;
  totalCostUsd: number;
}

export async function runChatBakeoff(env: NodeJS.ProcessEnv = process.env): Promise<{
  ok: true;
  skipped: boolean;
  reason?: string;
  promptVersion: string;
  repeats: number;
  embeddingModel: string;
  chatModels: readonly string[];
  embedding?: { ms: number; dimensions: number; costUsd: number | null; error: string | null };
  summary?: ChatBakeoffModelSummary[];
  totalCostUsd?: number;
  rows: ChatBakeoffRow[];
}> {
  const repeats = Math.max(1, Math.floor(Number(env.BAKEOFF_REPEATS ?? "1")) || 1);
  if (!env.OPENROUTER_API_KEY?.trim()) {
    return {
      ok: true,
      skipped: true,
      reason: "OPENROUTER_API_KEY is unset. No live chat comparison was run.",
      promptVersion: SUMMARY_PROMPT_VERSION,
      repeats,
      embeddingModel: EMBEDDING_MODEL,
      chatModels: CHAT_BAKEOFF_MODELS,
      rows: []
    };
  }
  const ledger = runLedger();
  const client = new OpenRouterClient({
    apiKey: env.OPENROUTER_API_KEY,
    dailySpendCapUsd: SPEND_CAP_USD,
    ledger: ledger.ledger,
    provider: { data_collection: "deny" }
  });
  const embedStarted = Date.now();
  let embedding: { ms: number; dimensions: number; costUsd: number | null; error: string | null };
  try {
    const embedded = await client.embeddings({
      model: EMBEDDING_MODEL,
      input: ["Martinez v. Hale BI hearing"],
      stage: "bakeoff-embed",
      dimensions: 768
    });
    embedding = {
      ms: Date.now() - embedStarted,
      dimensions: embedded.vectors[0]?.length ?? 0,
      costUsd: embedded.usage.costUsd,
      error: null
    };
  } catch (error) {
    embedding = {
      ms: Date.now() - embedStarted,
      dimensions: 0,
      costUsd: null,
      error: errorText(error)
    };
  }
  const rows: ChatBakeoffRow[] = [];
  const plan = Array.from({ length: repeats }, (_, index) => index + 1).flatMap((run) =>
    CHAT_BAKEOFF_MODELS.flatMap((model) => CHAT_BAKEOFF_CASES.map((testCase) => ({ run, model, testCase }))));
  for (const { run, model, testCase } of plan) {
    const started = Date.now();
    try {
      const chat = await client.chatJson({
        model,
        stage: "bakeoff-chat",
        promptVersion: SUMMARY_PROMPT_VERSION,
        messages: [
          { role: "system", content: PERSONAL_AGENT_SUMMARY_PROMPT },
          { role: "user", content: JSON.stringify(testCase.payload) }
        ]
      });
      const score = scoreSummary(chat.content, testCase);
      rows.push({
        model,
        caseId: testCase.id,
        run,
        ok: score.schemaValid && score.requiredMisses.length === 0 && score.forbiddenHits.length === 0,
        ms: Date.now() - started,
        costUsd: chat.usage.costUsd,
        promptTokens: chat.usage.promptTokens,
        completionTokens: chat.usage.completionTokens,
        quality: qualityPoints(score, testCase),
        schemaValid: score.schemaValid,
        requiredMisses: score.requiredMisses,
        forbiddenHits: score.forbiddenHits,
        title: score.title,
        error: null
      });
    } catch (error) {
      rows.push({
        model,
        caseId: testCase.id,
        run,
        ok: false,
        ms: Date.now() - started,
        costUsd: null,
        promptTokens: 0,
        completionTokens: 0,
        quality: 0,
        schemaValid: false,
        requiredMisses: testCase.requiredTerms,
        forbiddenHits: [],
        title: null,
        error: errorText(error)
      });
    }
  }
  return {
    ok: true,
    skipped: false,
    promptVersion: SUMMARY_PROMPT_VERSION,
    repeats,
    embeddingModel: EMBEDDING_MODEL,
    chatModels: CHAT_BAKEOFF_MODELS,
    embedding,
    summary: summarizeRows(rows),
    totalCostUsd: Number(ledger.spent().toFixed(6)),
    rows
  };
}

export function summarizeRows(rows: ChatBakeoffRow[]): ChatBakeoffModelSummary[] {
  return CHAT_BAKEOFF_MODELS.map((model) => {
    const mine = rows.filter((row) => row.model === model);
    const ms = mine.map((row) => row.ms).sort((left, right) => left - right);
    return {
      model,
      calls: mine.length,
      passed: mine.filter((row) => row.ok).length,
      schemaValid: mine.filter((row) => row.schemaValid).length,
      meanQuality: mine.length === 0 ? 0 : Number((mine.reduce((sum, row) => sum + row.quality, 0) / mine.length).toFixed(3)),
      medianMs: ms.length === 0 ? 0 : ms[Math.floor((ms.length - 1) / 2)]!,
      totalCostUsd: Number(mine.reduce((sum, row) => sum + (row.costUsd ?? 0), 0).toFixed(6))
    };
  });
}

function runLedger(): { ledger: OpenRouterLedger; spent: () => number } {
  let spent = 0;
  return {
    spent: () => spent,
    ledger: {
      spentOnDay: async () => spent,
      recordUsage: async (entry) => {
        spent += entry.costUsd ?? 0;
      },
      getCachedOutput: async () => null,
      putCachedOutput: async () => undefined
    }
  };
}

function errorText(error: unknown): string {
  if (error instanceof OpenRouterRequestError && error.responseText) {
    return `${error.message} ${error.responseText.slice(0, 300)}`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const result = await runChatBakeoff();
  const outPath = resolve(".planning/phases/14-semantic-recall/bakeoff-results.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.skipped) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
