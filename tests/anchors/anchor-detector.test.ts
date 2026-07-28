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

  // GAP-11-D: anchor detection previously ran on every turn with no hygiene gate, so tool-call and
  // harness-injected turns minted anchors carrying raw payload text straight into injection packets.
  // The frozen 12-query recall probe measured 10/12 packets containing tool-call text AFTER the full
  // summary-hygiene rebuild, because the winning memory was an anchor, not a summary.
  describe("derivation-input hygiene (GAP-11-D)", () => {
    it("creates no anchors for a tool-call turn whose payload reads like planning prose", async () => {
      const store = new InMemoryStore();
      const detector = new AnchorDetector(store);

      const result = await detector.detectForTurn(makeTurn({
        id: "turn_tool",
        role: "assistant",
        content:
          '[Tool call: Write] {"file_path":"/repo/.planning/ADR-0007.md","content":"We decided the ' +
          'strategy is to wait because the coverage limit creates leverage."}',
        provenance: "assistant_output"
      }));

      expect(result.anchors).toEqual([]);
      await expect(store.listAnchors()).resolves.toEqual([]);
    });

    it("creates no anchors for a turn with role tool even without the bracket prefix", async () => {
      const store = new InMemoryStore();
      const detector = new AnchorDetector(store);

      const result = await detector.detectForTurn(makeTurn({
        id: "turn_tool_role",
        role: "tool",
        content: "We decided the deadline is June 1 because the policy limit is confirmed."
      }));

      expect(result.anchors).toEqual([]);
      await expect(store.listAnchors()).resolves.toEqual([]);
    });

    it("still creates anchors for genuine conversational turns carrying the same signals", async () => {
      const store = new InMemoryStore();
      const detector = new AnchorDetector(store);

      const result = await detector.detectForTurn(makeTurn({
        id: "turn_human",
        content: "We decided the strategy is to wait because the coverage limit creates leverage."
      }));

      expect(result.anchors.map((anchor) => anchor.anchorType)).toEqual([
        "decision",
        "key_fact",
        "strategic_insight"
      ]);
    });
  });

  // GAP-11-G defect 2: the gate classified on (content, role) only, while the store's prune
  // classifies on (content, eventKind, role). An event the prune calls `tool_activity` on eventKind —
  // content CONTAINING `[Tool call: ` without starting with it — was `conversational` to the gate,
  // so the gate admitted anchors the prune would delete. See 11-GAP-11-G.md.
  describe("eventKind-aware gate (GAP-11-G)", () => {
    const EMBEDDED_TOOL_CONTENT =
      'Checking the build first.\n[Tool call: Bash] {"command":"npm test","note":"we decided this ' +
      'because of the deadline risk"}';

    it("creates no anchors for a tool_call-kind turn whose content does not start with the prefix", async () => {
      const store = new InMemoryStore();
      const detector = new AnchorDetector(store);

      const result = await detector.detectForTurn(
        makeTurn({ id: "turn_kind_tool", role: "assistant", content: EMBEDDED_TOOL_CONTENT }),
        { eventKind: "tool_call" }
      );

      expect(result.anchors).toEqual([]);
      await expect(store.listAnchors()).resolves.toEqual([]);
    });

    it("leaves the no-eventKind path exactly as it was: the same turn still mints anchors", async () => {
      const store = new InMemoryStore();
      const detector = new AnchorDetector(store);

      const result = await detector.detectForTurn(
        makeTurn({ id: "turn_kind_tool", role: "assistant", content: EMBEDDED_TOOL_CONTENT })
      );

      expect(result.anchors.map((anchor) => anchor.anchorType)).toEqual([
        "deadline",
        "decision",
        "strategic_insight"
      ]);
    });

    it("mints byte-identical anchors for a conversational turn with or without eventKind", async () => {
      const conversational = makeTurn({
        id: "turn_kind_conv",
        content: "We decided the strategy is to wait because the coverage limit creates leverage."
      });

      const withoutKind = await new AnchorDetector(new InMemoryStore()).detectForTurn(conversational);
      const withKind = await new AnchorDetector(new InMemoryStore()).detectForTurn(conversational, {
        eventKind: "message"
      });

      expect(withKind.anchors).toEqual(withoutKind.anchors);
      expect(withKind.anchors.map((anchor) => anchor.content)).toEqual([
        "We decided the strategy is to wait because the coverage limit creates leverage.",
        "We decided the strategy is to wait because the coverage limit creates leverage.",
        "We decided the strategy is to wait because the coverage limit creates leverage."
      ]);
    });
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
