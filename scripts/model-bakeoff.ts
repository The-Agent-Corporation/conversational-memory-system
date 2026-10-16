import { readFileSync } from "node:fs";
import { OpenRouterClient } from "../src/openrouter/client.js";

const EMBEDDING_MODELS = [
  "qwen/qwen3-embedding-8b",
  "qwen/qwen3-embedding-4b",
  "openai/text-embedding-3-small"
];
const CHAT_MODELS = [
  "google/gemini-2.5-flash",
  "anthropic/claude-3.5-haiku",
  "openai/gpt-4o-mini"
];

const queries = [
  "What did we decide about coverage?",
  "When is the next deadline?",
  "What preference did I state?",
  "Which project was active?",
  "What should be remembered?",
  "What changed in the plan?",
  "Who owns the follow-up?",
  "What was the budget?",
  "Which case names came up?",
  "What is still open?",
  "What did the journal say about routines?",
  "What should not be injected?"
];

async function main(): Promise<void> {
  const slicePath = process.argv[2];
  const slice = slicePath ? readFileSync(slicePath, "utf8").slice(0, 4_000) : "No corpus slice was provided.";
  if (!process.env.OPENROUTER_API_KEY) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      skipped: true,
      reason: "OPENROUTER_API_KEY is unset and this workspace has no ~/.memory/aaron.db clone.",
      embeddingModels: EMBEDDING_MODELS,
      chatModels: CHAT_MODELS,
      queries
    }, null, 2)}\n`);
    return;
  }
  const client = new OpenRouterClient({ dailySpendCapUsd: 10 });
  const rows = [];
  for (const model of EMBEDDING_MODELS) {
    const started = Date.now();
    const embedded = await client.embeddings({ model, input: queries, stage: "bakeoff-embed" });
    rows.push({ kind: "embedding", model, ms: Date.now() - started, dimensions: embedded.vectors[0]?.length ?? 0, costUsd: embedded.usage.costUsd });
  }
  for (const model of CHAT_MODELS) {
    const started = Date.now();
    const chat = await client.chatJson({
      model,
      stage: "bakeoff-chat",
      promptVersion: "bakeoff-v1",
      messages: [
        { role: "system", content: "Summarize the slice in one sentence. Preserve domain terms." },
        { role: "user", content: slice }
      ]
    });
    rows.push({ kind: "chat", model, ms: Date.now() - started, costUsd: chat.usage.costUsd, preview: chat.content.slice(0, 180) });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, skipped: false, rows }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
