import { describe, expect, it } from "vitest";
import type { Turn } from "../../src/domain/types.js";
import type { CompletedTopicSpan } from "../../src/topic/topic-monitor.js";
import {
  OpenRouterSummarizer,
  OpenRouterSummarizerError,
  type FetchLike
} from "../../src/summarization/openrouter-summarizer.js";

const completedSpan = (overrides: Partial<CompletedTopicSpan> = {}): CompletedTopicSpan => ({
  host: "roscoe-hermes",
  profileId: "default",
  hostSessionId: "session_1",
  topicLabel: "Smith PIP",
  currentTopicSummary: "Smith PIP (2 turns, seq 1-2)",
  sourceTurnRange: {
    threadId: "session_1",
    startSequence: 1,
    endSequence: 2
  },
  turnCount: 2,
  lastEventId: "event_2",
  updatedAt: "2026-05-04T10:00:10.000Z",
  completedAt: "2026-05-04T10:05:00.000Z",
  ...overrides
});

const makeTurn = (overrides: Partial<Turn> = {}): Turn => ({
  id: "turn_1",
  threadId: "session_1",
  sequence: 1,
  role: "user",
  content: "Let's talk about Smith PIP.",
  createdAt: "2026-05-04T10:00:00.000Z",
  provenance: "direct_user_input",
  trustLevel: "high",
  metadata: {},
  contentHash: "hash_1",
  ...overrides
});

describe("OpenRouterSummarizer", () => {
  it("requests a JSON summary from OpenRouter and returns a summary draft", async () => {
    const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        async text() {
          return JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summaryText: "Smith PIP demand timing and coverage issues.",
                    confidence: 0.82,
                    detailLevel: "brief",
                    tokenCount: 12
                  })
                }
              }
            ]
          });
        }
      };
    };

    const summarizer = new OpenRouterSummarizer({
      apiKey: "test-key",
      model: "anthropic/claude-3.5-sonnet",
      referer: "https://example.test",
      title: "Conversational Memory System",
      fetch
    });

    const draft = await summarizer.summarize({
      span: completedSpan(),
      sourceTurns: [
        makeTurn({ id: "turn_1", sequence: 1, content: "Let's talk about Smith PIP." }),
        makeTurn({
          id: "turn_2",
          sequence: 2,
          role: "assistant",
          content: "The Smith PIP issue is about demand timing."
        })
      ]
    });

    expect(draft).toEqual({
      summaryText: "Smith PIP demand timing and coverage issues.",
      model: "openrouter:anthropic/claude-3.5-sonnet",
      promptVersion: "openrouter-summarizer-v3",
      confidence: 0.82,
      detailLevel: "brief",
      tokenCount: 12
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calls[0].init.headers).toMatchObject({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
      "HTTP-Referer": "https://example.test",
      "X-OpenRouter-Title": "Conversational Memory System"
    });

    const body = JSON.parse(calls[0].init.body);
    expect(body.model).toBe("anthropic/claude-3.5-sonnet");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("detailLevel is exactly one of full, medium, brief, stub");
    expect(body.messages[1].content).toContain("Smith PIP (2 turns, seq 1-2)");
    expect(body.messages[1].content).toContain("The Smith PIP issue is about demand timing.");
  });

  it("can be configured from OpenRouter environment variables", () => {
    const summarizer = OpenRouterSummarizer.fromEnv(
      {
        OPENROUTER_API_KEY: "env-key",
        OPENROUTER_MODEL: "openai/gpt-4.1",
        OPENROUTER_REFERER: "https://memory.test",
        OPENROUTER_TITLE: "Memory"
      },
      { fetch: async () => ({ ok: true, status: 200, async text() { return "{}"; } }) }
    );

    expect(summarizer.providerModel).toBe("openai/gpt-4.1");
  });

  it("throws a typed error for non-OK OpenRouter responses", async () => {
    const summarizer = new OpenRouterSummarizer({
      apiKey: "test-key",
      model: "anthropic/claude-3.5-sonnet",
      fetch: async () => ({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        async text() {
          return "rate limited";
        }
      })
    });

    await expect(summarizer.summarize({ span: completedSpan(), sourceTurns: [] }))
      .rejects
      .toMatchObject({
        name: "OpenRouterSummarizerError",
        status: 429,
        responseText: "rate limited"
      } satisfies Partial<OpenRouterSummarizerError>);
  });

  it("throws a typed error when the model does not return valid summary JSON", async () => {
    const summarizer = new OpenRouterSummarizer({
      apiKey: "test-key",
      model: "anthropic/claude-3.5-sonnet",
      fetch: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        async text() {
          return JSON.stringify({
            choices: [{ message: { content: "not-json" } }]
          });
        }
      })
    });

    await expect(summarizer.summarize({ span: completedSpan(), sourceTurns: [] }))
      .rejects
      .toBeInstanceOf(OpenRouterSummarizerError);
  });
});
