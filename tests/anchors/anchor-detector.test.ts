import { describe, expect, it } from "vitest";
import { AnchorDetector } from "../../src/anchors/anchor-detector.js";
import type { Turn } from "../../src/domain/types.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";

const makeTurn = (overrides: Partial<Turn> = {}): Turn => ({
  id: "turn_1",
  threadId: "session_1",
  sequence: 1,
  role: "user",
  content: "PIP demand deadline is June 1.",
  createdAt: "2026-05-04T10:00:00.000Z",
  provenance: "direct_user_input",
  trustLevel: "high",
  metadata: {},
  contentHash: "hash_1",
  ...overrides
});

describe("AnchorDetector", () => {
  it("creates deadline anchors for obvious deadline turns", async () => {
    const store = new InMemoryStore();
    const detector = new AnchorDetector(store);

    const result = await detector.detectForTurn(makeTurn());

    expect(result.anchors).toHaveLength(2);
    expect(result.anchors.map((anchor) => anchor.anchorType)).toEqual(["deadline", "key_fact"]);
    expect(result.anchors[0]).toMatchObject({
      id: "anchor_turn_1_deadline",
      turnId: "turn_1",
      threadId: "session_1",
      boxId: null,
      content: "PIP demand deadline is June 1.",
      embedding: null,
      trustLevel: "high",
      source: "direct_user_input"
    });
    await expect(store.listAnchors()).resolves.toEqual(result.anchors);
  });

  it("creates decision and strategic insight anchors when both signals appear", async () => {
    const store = new InMemoryStore();
    const detector = new AnchorDetector(store);

    const result = await detector.detectForTurn(makeTurn({
      id: "turn_2",
      content: "We decided the strategy is to wait because the coverage limit creates leverage.",
      provenance: "assistant_output",
      trustLevel: "medium"
    }));

    expect(result.anchors.map((anchor) => anchor.anchorType)).toEqual([
      "decision",
      "key_fact",
      "strategic_insight"
    ]);
    expect(result.anchors.map((anchor) => anchor.id)).toEqual([
      "anchor_turn_2_decision",
      "anchor_turn_2_key_fact",
      "anchor_turn_2_strategic_insight"
    ]);
  });

  it("does not create anchors for low-signal turns", async () => {
    const store = new InMemoryStore();
    const detector = new AnchorDetector(store);

    const result = await detector.detectForTurn(makeTurn({
      content: "Okay, sounds good."
    }));

    expect(result.anchors).toEqual([]);
    await expect(store.listAnchors()).resolves.toEqual([]);
  });

  it("upserts deterministic anchor ids when the same turn is processed again", async () => {
    const store = new InMemoryStore();
    const detector = new AnchorDetector(store);

    await detector.detectForTurn(makeTurn());
    await detector.detectForTurn(makeTurn({
      content: "PIP demand deadline is June 1."
    }));

    const anchors = await store.listAnchors();
    expect(anchors).toHaveLength(2);
    expect(anchors.map((anchor) => anchor.id)).toEqual([
      "anchor_turn_1_deadline",
      "anchor_turn_1_key_fact"
    ]);
  });
});
