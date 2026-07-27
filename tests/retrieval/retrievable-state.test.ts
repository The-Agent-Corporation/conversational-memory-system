import { describe, expect, it } from "vitest";
import { MemoryStateSchema } from "../../src/domain/types.js";
import {
  RETRIEVABLE_MEMORY_STATES,
  RETRIEVAL_CANDIDATE_STATES,
  REVIVABLE_MEMORY_STATE,
  isRetrievableState
} from "../../src/retrieval/retrievable-state.js";

describe("retrievable-state", () => {
  it("exposes exactly three retrievable states", () => {
    expect(RETRIEVABLE_MEMORY_STATES).toHaveLength(3);
    expect([...RETRIEVABLE_MEMORY_STATES].sort()).toEqual(["active", "compacted", "revived"]);
  });

  it("exhaustively partitions MemoryStateSchema.options into retrievable vs excluded", () => {
    const retrievable = new Set(RETRIEVABLE_MEMORY_STATES);

    for (const state of MemoryStateSchema.options) {
      const expected = retrievable.has(state);
      expect(isRetrievableState(state)).toBe(expected);
    }

    const excludedStates = MemoryStateSchema.options.filter((state) => !retrievable.has(state));
    expect(excludedStates.sort()).toEqual(
      ["approved", "disputed", "proposed", "rejected", "stale", "superseded"].sort()
    );
  });

  it("names the single revivable state", () => {
    expect(REVIVABLE_MEMORY_STATE).toBe("stale");
    expect(isRetrievableState(REVIVABLE_MEMORY_STATE)).toBe(false);
  });

  it("candidate states are the retrievable set plus the revivable state", () => {
    expect([...RETRIEVAL_CANDIDATE_STATES].sort()).toEqual(
      ["active", "compacted", "revived", "stale"].sort()
    );
  });
});
