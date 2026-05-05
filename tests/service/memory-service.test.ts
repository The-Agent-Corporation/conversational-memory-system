import { describe, expect, it } from "vitest";
import { MemoryService } from "../../src/service/memory-service.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";

describe("MemoryService", () => {
  it("ingests host conversation events as durable turns", async () => {
    const store = new InMemoryStore();
    const service = new MemoryService(store);

    await service.ingestEvent({
      id: "event_1",
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      sequence: 1,
      type: "conversation_turn",
      role: "user",
      content: "Let's talk about Smith PIP.",
      createdAt: "2026-05-04T10:00:00.000Z",
      metadata: {}
    });

    const turns = await store.listTurns("session_1");
    expect(turns).toHaveLength(1);
    expect(turns[0].content).toBe("Let's talk about Smith PIP.");
    expect(turns[0].provenance).toBe("direct_user_input");
  });

  it("returns no injection packet before retrieval exists", async () => {
    const store = new InMemoryStore();
    const service = new MemoryService(store);

    const packet = await service.prepareInjection({
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      currentTopicSummary: "Smith PIP coverage"
    });

    expect(packet).toBeNull();
  });
});
