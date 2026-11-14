import { describe, expect, it, vi } from "vitest";
import { cosineSimilarity } from "../../src/embeddings/embedder.js";
import { SummarySchema, type MemoryProposal, type MemoryTrace, type Summary } from "../../src/domain/types.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import type { MemoryStore } from "../../src/storage/memory-store.js";
import { createCountingStore } from "./counting-store.js";
import { assertFlatCost, assertOncePerProcess } from "./cost-contract.js";
import { buildVectorCorpus, LARGE_CORPUS, SMALL_CORPUS } from "./vector-corpus-fixture.js";

const NOW = "2026-01-01T00:00:00.000Z";

describe("counting MemoryStore", () => {
  it("exhaustively delegates, counts calls and returned rows, and preserves values", async () => {
    const delegate = new InMemoryStore();
    const summary = makeSummary("summary_1");
    const proposal = makeProposal();
    const trace = makeTrace();
    await delegate.saveSummary(summary);
    await delegate.saveProposal(proposal);
    await delegate.saveTrace(trace);
    await delegate.saveSummaryVector(vectorRow("summary_1", [1, 0]));
    vi.spyOn(delegate, "getProposal").mockResolvedValue(proposal);
    const handle = createCountingStore(delegate);
    const _exhaustive: MemoryStore = handle.store;

    const summaries = await _exhaustive.listSummaries();
    const byIds = await _exhaustive.listSummariesByIds([summary.id]);
    const proposals = await _exhaustive.listProposals();
    const traces = await _exhaustive.listTraces();
    const matches = await _exhaustive.findNearestSummaries({
      vector: [1, 0], provider: "fixture", model: "model", personId: "person_1",
      allowedScopeIds: ["scope_1"], topK: 1
    });
    const returnedProposal = await _exhaustive.getProposal(proposal.id);

    expect(Object.keys(handle.counts.calls)).toHaveLength(
      countDelegateMethods(delegate, new Set(Object.keys(handle.counts.calls)))
    );
    expect(summaries).toEqual([summary]);
    expect(byIds).toEqual([summary]);
    expect(proposals).toEqual([proposal]);
    expect(traces).toEqual([trace]);
    expect(matches).toHaveLength(1);
    expect(returnedProposal).toBe(proposal);
    for (const method of ["listSummaries", "listSummariesByIds", "listProposals", "listTraces", "findNearestSummaries"] as const) {
      expect(handle.counts.calls[method]).toBe(1);
      expect(handle.counts.rows[method]).toBe(1);
    }
    expect(handle.counts.rows.getProposal).toBe(0);
  });

  it("counts a throwing call, propagates the same error, and resets all counts", async () => {
    const delegate = new InMemoryStore();
    const failure = new Error("delegate failed");
    vi.spyOn(delegate, "savePerson").mockRejectedValue(failure);
    const handle = createCountingStore(delegate);

    let caught: unknown;
    try {
      await handle.store.savePerson({ id: "person_1", displayName: "Person", createdAt: NOW });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(handle.counts.calls.savePerson).toBe(1);
    expect(handle.counts.rows.savePerson).toBe(0);

    handle.reset();
    expect(Object.values(handle.counts.calls).every((count) => count === 0)).toBe(true);
    expect(Object.values(handle.counts.rows).every((count) => count === 0)).toBe(true);
  });
});

describe("vector corpus fixture", () => {
  it("is deterministic, clustered, provenance-complete, and time ordered", async () => {
    const firstStore = new InMemoryStore();
    const secondStore = new InMemoryStore();
    const options = { personId: "person_1", summaryCount: 20, dimensions: 16, seed: 42 };
    const first = await buildVectorCorpus({ store: firstStore, ...options });
    const second = await buildVectorCorpus({ store: secondStore, ...options });

    expect(first).toEqual(second);
    expect(await firstStore.listSummaries()).toEqual(await secondStore.listSummaries());
    const summaries = await firstStore.listSummaries();
    for (const [index, summary] of summaries.entries()) {
      expect(SummarySchema.parse(summary)).toEqual(summary);
      expect(summary.personId).toBeTruthy();
      expect(summary.scopeIds?.length).toBeGreaterThan(0);
      expect(summary.sourceCanonicalEventIds?.length).toBeGreaterThan(0);
      expect(summary.sourceTurnRanges.length).toBeGreaterThan(0);
      expect(await firstStore.getSummaryVector(summary.id, "fixture", "clustered-xorshift32-v1")).toEqual({
        summaryId: summary.id,
        provider: "fixture",
        model: "clustered-xorshift32-v1",
        dimensions: options.dimensions,
        vector: first.vectors[index],
        personId: summary.personId,
        scopeIds: summary.scopeIds,
        createdAt: summary.createdAt
      });
    }
    expect(summaries.every((summary, index) => index === 0 || summary.createdAt > summaries[index - 1].createdAt)).toBe(true);
    expect(cosineSimilarity(first.vectors[0], first.vectors[2])).toBeGreaterThan(0.8);
    expect(cosineSimilarity(first.vectors[0], first.vectors[1])).toBeLessThan(0.3);
  });

  it.each([0, 3, 8])("plants exactly %i requested incomplete-provenance cases", async (provenanceIncomplete) => {
    const store = new InMemoryStore();
    await buildVectorCorpus({ store, personId: "person_1", summaryCount: 8, dimensions: 8, seed: 7, provenanceIncomplete });
    const summaries = await store.listSummaries();
    expect(summaries.filter((summary) => summary.scopeIds?.length === 0)).toHaveLength(provenanceIncomplete);
    expect(summaries.filter((summary) => summary.scopeIds?.length !== 0)).toHaveLength(8 - provenanceIncomplete);
  });

  it("rejects empty default provenance scopes before writing", async () => {
    const store = new InMemoryStore();
    await expect(buildVectorCorpus({
      store, personId: "person_1", summaryCount: 8, dimensions: 8, seed: 7, scopeIds: []
    })).rejects.toThrow("scopeIds must contain at least one scope");
    expect(await store.listSummaries()).toEqual([]);
  });
});

describe("cost contracts", () => {
  it("rejects an O(n) cost at fixed corpus sizes that a small ceiling misses", () => {
    const small = createCountingStore(new InMemoryStore()).counts;
    const large = createCountingStore(new InMemoryStore()).counts;
    small.calls.listSummaries = 1;
    large.calls.listSummaries = 1;
    small.rows.listSummaries = SMALL_CORPUS;
    large.rows.listSummaries = LARGE_CORPUS;

    expect(5).toBeLessThan(10);
    expect(() => assertFlatCost({ small, large, methods: ["listSummaries"] }))
      .toThrow(/listSummaries.*calls small=1, large=1.*rows small=50, large=500/);
  });

  it("accepts equal calls and rows and requires one warm load regardless of cycles", () => {
    const small = createCountingStore(new InMemoryStore()).counts;
    const large = createCountingStore(new InMemoryStore()).counts;
    small.calls.listSummaries = large.calls.listSummaries = 1;
    small.rows.listSummaries = large.rows.listSummaries = 50;
    expect(() => assertFlatCost({ small, large, methods: ["listSummaries"] })).not.toThrow();
    expect(() => assertOncePerProcess({ counts: large, method: "listSummaries", cycles: 100 })).not.toThrow();
  });
});

function makeSummary(id: string): Summary {
  return SummarySchema.parse({
    id, personId: "person_1", scopeIds: ["scope_1"], summaryText: "Summary", sourceTurnRanges: [],
    sourceCanonicalEventIds: [], sourceSummaryIds: [], boxIds: [], embedding: null, createdAt: NOW,
    model: "test", promptVersion: "v1", confidence: 1, state: "active", detailLevel: "brief",
    tokenCount: 1, lastAccessedAt: null, version: 1, strength: 1, retrievalCount: 0,
    retrievedAt: null, halfLifeHours: 1, outcomeScore: null
  });
}

function makeProposal(): MemoryProposal {
  return {
    id: "proposal_1", personId: "person_1", proposalType: "box", state: "proposed", title: "Proposal",
    rationale: "Rationale", confidence: 1, createdAt: NOW, reviewedAt: NOW, decidedAt: null, decidedBy: null,
    decisionNote: null, sourceSummaryIds: ["summary_1"], sourceTurnRanges: [{ threadId: "thread", startSequence: 0, endSequence: 0 }],
    targetBoxIds: [], targetTraceIds: [], payload: { boxId: "box_1", title: "Box", description: "", summary: "Summary",
      boxType: "topic", candidateParentBoxId: null, keywords: ["key"], evidence: ["evidence"], sourceSummaryIds: ["summary_1"],
      sourceTurnRanges: [{ threadId: "thread", startSequence: 0, endSequence: 0 }] }
  };
}

function makeTrace(): MemoryTrace {
  return { id: "trace_1", personId: "person_1", title: "Trace", description: "", traceType: "task_thread",
    state: "proposed", summaryIds: ["summary_1", "summary_2"], boxIds: [],
    turnRanges: [{ threadId: "thread", startSequence: 0, endSequence: 0 }], createdAt: NOW, updatedAt: NOW,
    lastActivityAt: NOW, confidence: 1, rationale: "Rationale" };
}

function vectorRow(summaryId: string, vector: number[]) {
  return { summaryId, provider: "fixture", model: "model", dimensions: vector.length, vector,
    personId: "person_1", scopeIds: ["scope_1"], createdAt: NOW };
}

function countDelegateMethods(delegate: object, publicNames: ReadonlySet<string>): number {
  const methods = new Set<string>();
  let prototype = Object.getPrototypeOf(delegate) as object | null;
  while (prototype && prototype !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (publicNames.has(name) && typeof Reflect.get(prototype, name) === "function") methods.add(name);
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
  return methods.size;
}
