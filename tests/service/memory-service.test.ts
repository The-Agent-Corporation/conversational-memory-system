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
  it("also records a person-scoped canonical event with source provenance", async () => {
    const store = new InMemoryStore();
    const service = new MemoryService(store, {
      personId: "person_aaron",
      personDisplayName: "Aaron",
      parserVersion: "hermes-timeline/v1",
      clock: () => "2026-07-16T10:10:00.000Z"
    });

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
      metadata: { channel: "telegram" }
    });

    await expect(store.getPerson("person_aaron")).resolves.toMatchObject({
      id: "person_aaron",
      displayName: "Aaron"
    });
    await expect(store.listSources("person_aaron")).resolves.toEqual([
      expect.objectContaining({
        personId: "person_aaron",
        application: "roscoe-hermes",
        profileId: "default"
      })
    ]);
    await expect(store.listCanonicalEvents("person_aaron")).resolves.toEqual([
      expect.objectContaining({
        personId: "person_aaron",
        sourceApplication: "roscoe-hermes",
        sourceProfileId: "default",
        nativeSessionId: "session_1",
        nativeEventId: "event_1",
        nativeSequence: 1,
        importedAt: "2026-07-16T10:10:00.000Z",
        parserVersion: "hermes-timeline/v1",
        metadata: { sourceMetadata: { channel: "telegram" } }
      })
    ]);
  });

  it("orders native sessions in one personal timeline and isolates other people", async () => {
    const store = new InMemoryStore();
    const firstPerson = new MemoryService(store, {
      personId: "person_1",
      clock: () => "2026-07-16T10:10:00.000Z"
    });
    const secondPerson = new MemoryService(store, {
      personId: "person_2",
      clock: () => "2026-07-16T10:10:00.000Z"
    });

    await firstPerson.ingestEvent({
      id: "codex_later",
      host: "codex",
      profileId: "default",
      hostSessionId: "codex_session",
      sequence: 1,
      type: "conversation_turn",
      role: "assistant",
      content: "Later Codex event",
      createdAt: "2026-07-16T10:05:00.000Z",
      metadata: {}
    });
    await firstPerson.ingestEvent({
      id: "claude_earlier",
      host: "claude-code",
      profileId: "default",
      hostSessionId: "claude_session",
      sequence: 8,
      type: "conversation_turn",
      role: "user",
      content: "Earlier Claude event",
      createdAt: "2026-07-16T10:00:00.000Z",
      metadata: {}
    });
    await secondPerson.ingestEvent({
      id: "other_person",
      host: "codex",
      profileId: "default",
      hostSessionId: "other_session",
      sequence: 1,
      type: "conversation_turn",
      role: "user",
      content: "Private to another person",
      createdAt: "2026-07-16T09:00:00.000Z",
      metadata: {}
    });

    const events = await store.listCanonicalEvents("person_1");
    expect(events.map((event) => event.content)).toEqual([
      "Earlier Claude event",
      "Later Codex event"
    ]);
    expect(events.every((event) => event.personId === "person_1")).toBe(true);
    await expect(store.listCanonicalEvents("person_2")).resolves.toHaveLength(1);
  });

  it("re-ingests the same native event idempotently", async () => {
    const store = new InMemoryStore();
    const service = new MemoryService(store, {
      personId: "person_1",
      clock: () => "2026-07-16T10:10:00.000Z"
    });
    const event = {
      id: "event_1",
      host: "codex" as const,
      profileId: "default",
      hostSessionId: "session_1",
      sequence: 1,
      type: "conversation_turn" as const,
      role: "user" as const,
      content: "Build the universal memory system.",
      createdAt: "2026-07-16T10:00:00.000Z",
      metadata: {}
    };

    await service.ingestEvent(event);
    await service.ingestEvent(event);

    await expect(store.listCanonicalEvents("person_1")).resolves.toHaveLength(1);
    await expect(store.listSources("person_1")).resolves.toHaveLength(1);
  });

  it("keeps repeated native event ids distinct across native sessions", async () => {
    const store = new InMemoryStore();
    const service = new MemoryService(store, {
      personId: "person_1",
      clock: () => "2026-07-16T10:10:00.000Z"
    });
    const baseEvent = {
      id: "message_1",
      host: "codex" as const,
      profileId: "default",
      sequence: 1,
      type: "conversation_turn" as const,
      role: "user" as const,
      content: "Same native message id",
      createdAt: "2026-07-16T10:00:00.000Z",
      metadata: {}
    };

    await service.ingestEvent({ ...baseEvent, hostSessionId: "session_1" });
    await service.ingestEvent({ ...baseEvent, hostSessionId: "session_2" });

    const events = await store.listCanonicalEvents("person_1");
    expect(events).toHaveLength(2);
    expect(new Set(events.map((event) => event.id)).size).toBe(2);
  });

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
    const canonicalEvents = await store.listCanonicalEvents("person_default");
    expect(turns[0].metadata).toEqual({
      personId: "person_default",
      canonicalEventId: canonicalEvents[0].id,
      sourceId: canonicalEvents[0].sourceId,
      sourceInstanceId: "default",
      scopeId: "personal",
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
      currentTopicSummary: "Smith PIP coverage",
      personId: "person_default",
      allowedScopeIds: ["personal"]
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
