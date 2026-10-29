import { describe, expect, it } from "vitest";
import { dedupeRankedMemory, type RankedMemory } from "../../src/retrieval/memory-retriever.js";
import { naiveDedupeReference } from "./memory-retriever-dedupe.test.js";

function memory(kind: "summary" | "anchor", id: string, text: string): RankedMemory {
  return {
    kind, id, text, score: 1, tokenCount: 1, canUseStub: false,
    scoringMethod: "keyword overlap", summaryId: null, summaryIds: [], traceId: null,
    sourceTurnRanges: kind === "summary" ? [{ threadId: "thread", startSequence: 0, endSequence: 1 }] : [],
    boxIds: []
  };
}

describe("large-summary substring rejection preserves exact deduplication", () => {
  it("keeps absent anchors even when their prefix resembles a present substring", () => {
    const summary = memory("summary", "summary", "aaz ".repeat(400));
    const absent = memory("anchor", "absent", "ab[");
    const covered = memory("anchor", "covered", "aaz");
    expect(dedupeRankedMemory([absent, summary, covered])).toEqual([absent, summary]);
  });

  it("preserves normalized Unicode, overlapping substrings, and short anchors", () => {
    const texts = ["", "a", "ab", "ABA", "BAb", "İ", "i\u0307", "😀", "😀x", "\ud83d", "\ude00", "é\t\n猫", "猫", "not present"];
    const summary = memory("summary", "summary", "filler ".repeat(200) + " ABABA İ 😀x É  猫 ");
    const ranked = [summary, ...texts.map((text, i) => memory("anchor", String(i), text))];
    expect(dedupeRankedMemory(ranked)).toEqual(naiveDedupeReference(ranked));
  });

  it("still requires the original box and thread coverage boundaries", () => {
    const summary = { ...memory("summary", "summary", "filler ".repeat(200) + "target"), boxIds: ["box"] };
    const wrongBox = { ...memory("anchor", "box", "target"), boxIds: ["other"] };
    const wrongThread = { ...memory("anchor", "thread", "target"), sourceTurnRanges: [{ threadId: "other", startSequence: 0, endSequence: 1 }] };
    for (const anchor of [wrongBox, wrongThread]) {
      expect(dedupeRankedMemory([summary, anchor])).toEqual([summary, anchor]);
    }
  });

  it("matches the frozen oracle over deterministic arbitrary UTF-16 strings", () => {
    let state = 42;
    const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
    const alphabet = ["A", "b", " ", "\n", "é", "猫", "\ud83d", "\ude00", "\0", "İ", "["];
    for (let trial = 0; trial < 20; trial += 1) {
      const text = Array.from({ length: 1200 }, () => alphabet[random() % alphabet.length]).join("");
      const summary = memory("summary", "summary", text);
      const anchors = Array.from({ length: 40 }, (_, i) => {
        const start = random() % text.length;
        return memory("anchor", String(i), i % 2 ? text.slice(start, start + random() % 15) : `absent-${i}`);
      });
      const ranked = [summary, ...anchors];
      expect(dedupeRankedMemory(ranked)).toEqual(naiveDedupeReference(ranked));
    }
  });
});
