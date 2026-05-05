import { describe, expect, it } from "vitest";
import type { Turn } from "../../src/domain/types.js";
import { MemoryService } from "../../src/service/memory-service.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";

const makeTurn = (overrides: Partial<Turn> = {}): Turn => ({
  id: "turn_1",
  threadId: "session_1",
  sequence: 1,
  role: "user",
  content: "Let's talk about Smith PIP.",
  createdAt: "2026-05-04T10:00:00.000Z",
  provenance: "direct_user_input",
  trustLevel: "high",
  metadata: { sourceMetadata: { channel: "telegram" } },
  contentHash: "hash_1",
  ...overrides
});

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

  it("keeps canonical metadata separate from source event metadata", async () => {
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
      metadata: {
        host: "spoofed-host",
        profileId: "spoofed-profile",
        hostSessionId: "spoofed-session",
        channel: "telegram"
      }
    });

    const turns = await store.listTurns("session_1");
    expect(turns[0].metadata).toEqual({
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      sourceMetadata: {
        host: "spoofed-host",
        profileId: "spoofed-profile",
        hostSessionId: "spoofed-session",
        channel: "telegram"
      }
    });
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

describe("InMemoryStore", () => {
  it("clones saved and listed turns", async () => {
    const store = new InMemoryStore();
    const turn = makeTurn();

    await store.saveTurn(turn);
    turn.content = "mutated original";
    turn.metadata.sourceMetadata = { channel: "mutated original" };

    const firstList = await store.listTurns("session_1");
    expect(firstList[0].content).toBe("Let's talk about Smith PIP.");
    expect(firstList[0].metadata.sourceMetadata).toEqual({ channel: "telegram" });

    firstList[0].content = "mutated listed";
    firstList[0].metadata.sourceMetadata = { channel: "mutated listed" };

    const secondList = await store.listTurns("session_1");
    expect(secondList[0].content).toBe("Let's talk about Smith PIP.");
    expect(secondList[0].metadata.sourceMetadata).toEqual({ channel: "telegram" });
  });

  it("replaces duplicate turn ids instead of appending", async () => {
    const store = new InMemoryStore();

    await store.saveTurn(makeTurn({ id: "turn_1", content: "first" }));
    await store.saveTurn(makeTurn({ id: "turn_1", content: "replacement" }));

    const turns = await store.listTurns("session_1");
    expect(turns).toHaveLength(1);
    expect(turns[0].content).toBe("replacement");
  });

  it("lists turns in sequence order", async () => {
    const store = new InMemoryStore();

    await store.saveTurn(makeTurn({ id: "turn_2", sequence: 2, content: "second" }));
    await store.saveTurn(makeTurn({ id: "turn_1", sequence: 1, content: "first" }));

    const turns = await store.listTurns("session_1");
    expect(turns.map((turn) => turn.sequence)).toEqual([1, 2]);
  });

  it("rejects invalid direct turn saves", async () => {
    const store = new InMemoryStore();

    await expect(
      store.saveTurn({
        ...makeTurn(),
        metadata: { transform: () => "not JSON" }
      } as unknown as Turn)
    ).rejects.toThrow();
  });
});
