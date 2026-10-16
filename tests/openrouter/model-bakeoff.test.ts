import { describe, expect, it } from "vitest";
import { runChatBakeoff, summarizeRows, type ChatBakeoffRow } from "../../scripts/model-bakeoff.js";
import { CHAT_BAKEOFF_MODELS } from "../../src/openrouter/bakeoff-score.js";
import { SUMMARY_PROMPT_VERSION } from "../../src/summarization/openrouter-summarizer.js";

const row = (overrides: Partial<ChatBakeoffRow>): ChatBakeoffRow => ({
  model: CHAT_BAKEOFF_MODELS[0],
  caseId: "coverage-decision",
  run: 1,
  ok: true,
  ms: 100,
  costUsd: 0.001,
  promptTokens: 10,
  completionTokens: 10,
  quality: 1,
  schemaValid: true,
  requiredMisses: [],
  forbiddenHits: [],
  title: "t",
  error: null,
  ...overrides
});

describe("model bakeoff harness", () => {
  it("skips without a key and reports the summarizer prompt version", async () => {
    const result = await runChatBakeoff({ BAKEOFF_REPEATS: "3" });
    expect(result).toMatchObject({ skipped: true, promptVersion: SUMMARY_PROMPT_VERSION, repeats: 3, rows: [] });
  });

  it("summarizes pass counts, mean quality, median latency, and cost per model", () => {
    const [model] = CHAT_BAKEOFF_MODELS;
    const summary = summarizeRows([
      row({ ms: 300, quality: 1, costUsd: 0.002 }),
      row({ ms: 100, quality: 0.6, ok: false, schemaValid: false, costUsd: null }),
      row({ ms: 200, quality: 0.8, ok: false })
    ]);
    expect(summary).toHaveLength(CHAT_BAKEOFF_MODELS.length);
    expect(summary.find((entry) => entry.model === model)).toEqual({
      model,
      calls: 3,
      passed: 1,
      schemaValid: 2,
      meanQuality: 0.8,
      medianMs: 200,
      totalCostUsd: 0.003
    });
  });
});
