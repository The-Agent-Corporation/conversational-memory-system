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
import { PERSONAL_AGENT_SUMMARY_PROMPT } from "../src/summarization/openrouter-summarizer.js";

export interface ChatBakeoffRow {
  model: string;
  caseId: string;
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

export async function runChatBakeoff(env: NodeJS.ProcessEnv = process.env): Promise<{
  ok: true;
  skipped: boolean;
  reason?: string;
  embeddingModel: string;
  chatModels: readonly string[];
  embedding?: { ms: number; dimensions: number; costUsd: number | null; error: string | null };
  rows: ChatBakeoffRow[];
}> {
  if (!env.OPENROUTER_API_KEY?.trim()) {
    return {
      ok: true,
      skipped: true,
      reason: "OPENROUTER_API_KEY is unset. No live chat comparison was run.",
      embeddingModel: EMBEDDING_MODEL,
      chatModels: CHAT_BAKEOFF_MODELS,
      rows: []
    };
  }
  const client = new OpenRouterClient({
    apiKey: env.OPENROUTER_API_KEY,
    dailySpendCapUsd: 5,
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
      error: error instanceof Error ? error.message : String(error)
    };
  }
  const rows: ChatBakeoffRow[] = [];
  for (const model of CHAT_BAKEOFF_MODELS) {
    for (const testCase of CHAT_BAKEOFF_CASES) {
      const started = Date.now();
      try {
        const chat = await client.chatJson({
          model,
          stage: "bakeoff-chat",
          promptVersion: "openrouter-summarizer-v2",
          messages: [
            { role: "system", content: PERSONAL_AGENT_SUMMARY_PROMPT },
            { role: "user", content: JSON.stringify(testCase.payload) }
          ]
        });
        const score = scoreSummary(chat.content, testCase);
        rows.push({
          model,
          caseId: testCase.id,
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
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
  return { ok: true, skipped: false, embeddingModel: EMBEDDING_MODEL, chatModels: CHAT_BAKEOFF_MODELS, embedding, rows };
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
