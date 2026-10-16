import { describe, expect, it } from "vitest";
import { CHAT_BAKEOFF_CASES, qualityPoints, scoreSummary } from "../../src/openrouter/bakeoff-score.js";

describe("chat bakeoff scoring", () => {
  it("credits a schema-valid summary that keeps required terms and drops forbidden ones", () => {
    const testCase = CHAT_BAKEOFF_CASES[0]!;
    const score = scoreSummary(JSON.stringify({
      title: "BI tender on Martinez v. Hale",
      summaryText: "Tender BI and leave PIP alone. Hearing is 2026-11-03 on Martinez v. Hale.",
      confidence: 0.8,
      detailLevel: "brief",
      tokenCount: 20,
      anchors: [{ anchorType: "decision", content: "Tender BI, not PIP.", turnSequence: 1 }]
    }), testCase);
    expect(score.schemaValid).toBe(true);
    expect(score.requiredMisses).toEqual([]);
    expect(score.forbiddenHits).toEqual([]);
    expect(qualityPoints(score, testCase)).toBe(1);
  });

  it("rejects invented terms and invalid JSON", () => {
    const testCase = CHAT_BAKEOFF_CASES[0]!;
    const invented = scoreSummary(JSON.stringify({
      title: "Case settled",
      summaryText: "The criminal case settled.",
      confidence: 0.4,
      detailLevel: "brief",
      tokenCount: 8
    }), testCase);
    expect(invented.forbiddenHits).toEqual(["settled", "criminal"]);
    expect(scoreSummary("not json", testCase).parsed).toBe(false);
  });
});
