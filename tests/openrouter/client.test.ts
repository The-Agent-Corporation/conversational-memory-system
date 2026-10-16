import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { OpenRouterClient } from "../../src/openrouter/client.js";
import { SpendCapPausedError } from "../../src/openrouter/types.js";

describe("OpenRouterClient", () => {
  it("posts chat JSON through an injected fetch and caches the output", async () => {
    const calls: string[] = [];
    const client = new OpenRouterClient({
      apiKey: "test-key",
      baseUrl: "https://openrouter.ai/api/v1",
      fetch: async (url, init) => {
        calls.push(url);
        expect(init.headers.Authorization).toBe("Bearer test-key");
        expect(JSON.parse(init.body).provider.data_collection).toBe("deny");
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" } }], usage: { cost: 0.01 } })
        };
      },
      ledger: {
        spentOnDay: async () => 0,
        recordUsage: async () => undefined,
        getCachedOutput: async () => null,
        putCachedOutput: async () => undefined
      }
    });
    const first = await client.chatJson({
      model: "test-model",
      stage: "summarize",
      promptVersion: "v",
      cacheInput: { a: 1 },
      messages: [{ role: "user", content: "hi" }]
    });
    expect(first.content).toContain("ok");
    expect(calls).toHaveLength(1);
  });

  it("does not retry a 400 and does retry a 429", async () => {
    let attempts = 0;
    const client = new OpenRouterClient({
      apiKey: "test-key",
      baseUrl: "https://openrouter.ai/api/v1",
      maxRetries: 1,
      baseDelayMs: 1,
      sleep: async () => undefined,
      fetch: async () => {
        attempts += 1;
        if (attempts === 1) return { ok: false, status: 429, headers: { get: () => null }, text: async () => "rate limited" };
        return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }) };
      }
    });
    await expect(client.chatJson({
      model: "m",
      stage: "summarize",
      promptVersion: "v",
      messages: [{ role: "user", content: "hi" }]
    })).resolves.toMatchObject({ content: "ok" });
    expect(attempts).toBe(2);

    const rejected = new OpenRouterClient({
      apiKey: "test-key",
      baseUrl: "https://openrouter.ai/api/v1",
      fetch: async () => ({ ok: false, status: 400, text: async () => "bad" })
    });
    await expect(rejected.chatJson({
      model: "m",
      stage: "summarize",
      promptVersion: "v",
      messages: [{ role: "user", content: "hi" }]
    })).rejects.toMatchObject({ status: 400 });
  });

  it("pauses when the daily cap is already spent", async () => {
    const client = new OpenRouterClient({
      apiKey: "test-key",
      baseUrl: "https://openrouter.ai/api/v1",
      dailySpendCapUsd: 1,
      clock: () => "2026-10-16T00:00:00.000Z",
      ledger: {
        spentOnDay: async () => 1,
        recordUsage: async () => undefined,
        getCachedOutput: async () => null,
        putCachedOutput: async () => undefined
      },
      fetch: async () => { throw new Error("should not fetch"); }
    });
    await expect(client.chatJson({
      model: "m",
      stage: "summarize",
      promptVersion: "v",
      messages: [{ role: "user", content: "hi" }]
    })).rejects.toBeInstanceOf(SpendCapPausedError);
  });

  it("calls a local server without an API key", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "local" } }] }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    try {
      const client = new OpenRouterClient({
        baseUrl: `http://127.0.0.1:${address.port}/v1`
      });
      await expect(client.chatJson({
        model: "m",
        stage: "summarize",
        promptVersion: "v",
        messages: [{ role: "user", content: "hi" }]
      })).resolves.toMatchObject({ content: "local" });
    } finally {
      server.close();
    }
  });
});
