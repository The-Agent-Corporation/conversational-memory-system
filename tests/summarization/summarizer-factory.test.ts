import { describe, expect, it } from "vitest";
import { OpenRouterSummarizer } from "../../src/summarization/openrouter-summarizer.js";
import {
  DeterministicSummarizer,
  createSummarizerFromEnv
} from "../../src/summarization/summarizer.js";

describe("createSummarizerFromEnv", () => {
  it("keeps the deterministic summarizer as the default", () => {
    const summarizer = createSummarizerFromEnv({});

    expect(summarizer).toBeInstanceOf(DeterministicSummarizer);
  });

  it("selects OpenRouter when API key and model are configured", () => {
    const summarizer = createSummarizerFromEnv(
      {
        OPENROUTER_API_KEY: "test-key",
        OPENROUTER_MODEL: "anthropic/claude-3.5-sonnet",
        OPENROUTER_REFERER: "https://memory.test",
        OPENROUTER_TITLE: "Conversational Memory System"
      },
      { fetch: async () => ({ ok: true, status: 200, async text() { return "{}"; } }) }
    );

    expect(summarizer).toBeInstanceOf(OpenRouterSummarizer);
    expect((summarizer as OpenRouterSummarizer).providerModel).toBe("anthropic/claude-3.5-sonnet");
  });

  it("stays deterministic when OpenRouter configuration is incomplete", () => {
    const summarizer = createSummarizerFromEnv({
      OPENROUTER_API_KEY: "test-key"
    });

    expect(summarizer).toBeInstanceOf(DeterministicSummarizer);
  });
});
