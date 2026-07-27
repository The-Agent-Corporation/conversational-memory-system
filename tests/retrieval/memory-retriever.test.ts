import { describe, expect, it } from "vitest";
import { ContractionRunner } from "../../src/daemon/contraction-runner.js";
import type { CanonicalEvent } from "../../src/domain/canonical.js";
import type { Anchor, Box, MemoryTrace, Summary } from "../../src/domain/types.js";
import type { Embedder } from "../../src/embeddings/embedder.js";
import { MemoryRetriever } from "../../src/retrieval/memory-retriever.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";

const makeSummary = (overrides: Partial<Summary> = {}): Summary => ({
  id: "summary_1",
  summaryText: "Smith PIP demand strategy and coverage timing.",
  sourceTurnRanges: [{ threadId: "session_1", startSequence: 1, endSequence: 2 }],
  sourceSummaryIds: [],
  boxIds: ["box_1"],
  embedding: null,
  createdAt: "2026-05-04T10:05:00.000Z",
  model: "test-summarizer",
  promptVersion: "v1",
  confidence: 0.9,
  state: "compacted",
  detailLevel: "brief",
  tokenCount: 72,
  lastAccessedAt: null,
  version: 1,
  strength: 0.8,
  retrievalCount: 0,
  retrievedAt: null,
  halfLifeHours: 168,
  outcomeScore: null,
  ...overrides
});

const makeAnchor = (overrides: Partial<Anchor> = {}): Anchor => ({
  id: "anchor_1",
  turnId: "turn_1",
  threadId: "session_1",
  boxId: "box_1",
  anchorType: "deadline",
  content: "PIP demand deadline is June 1.",
  embedding: null,
  createdAt: "2026-05-04T10:02:00.000Z",
  trustLevel: "high",
  source: "direct_user_input",
  ...overrides
});

const makeBox = (overrides: Partial<Box> = {}): Box => ({
  id: "box_smith_pip",
  title: "Smith PIP",
  description: "Smith no-fault benefits and provider bills.",
  parentBoxId: null,
  childBoxIds: [],
  summaryIds: ["summary_1", "summary_provider_bill"],
  turnRanges: [{ threadId: "session_1", startSequence: 1, endSequence: 12 }],
  state: "approved",
  createdAt: "2026-05-04T10:00:00.000Z",
  updatedAt: "2026-05-04T10:05:00.000Z",
  caseId: "case_smith",
  boxType: "topic",
  summary: "Smith PIP coverage and provider bill issues.",
  lastActivityAt: "2026-05-04T10:05:00.000Z",
  ...overrides
});

const makeTrace = (overrides: Partial<MemoryTrace> = {}): MemoryTrace => ({
  id: "trace_smith_pip_provider_bills",
  title: "Smith PIP Provider Bills",
  description: "Recurring Smith PIP provider bill dispute and no-fault payment timing.",
  traceType: "case_issue",
  state: "approved",
  summaryIds: ["summary_1", "summary_provider_bill"],
  boxIds: ["box_smith_pip"],
  turnRanges: [
    { threadId: "session_1", startSequence: 1, endSequence: 2 },
    { threadId: "session_1", startSequence: 10, endSequence: 12 }
  ],
  createdAt: "2026-05-04T10:05:00.000Z",
  updatedAt: "2026-05-04T10:05:00.000Z",
  lastActivityAt: "2026-05-04T10:05:00.000Z",
  confidence: 0.88,
  rationale: "The same provider bill issue recurred across separated turns.",
  ...overrides
});

const legacyRetriever = (
  store: InMemoryStore,
  options: { embedder?: Embedder } = {}
): MemoryRetriever => new MemoryRetriever(store, { ...options, allowLegacyUnscoped: true });

describe("MemoryRetriever", () => {
  it("enforces exact person and allowed-scope boundaries across derived memory", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({
      id: "summary_allowed",
      personId: "person_1",
      scopeIds: ["case_alpha"],
      summaryText: "Alpha deadline strategy",
      boxIds: ["box_allowed"]
    }));
    await store.saveSummary(makeSummary({
      id: "summary_denied",
      personId: "person_1",
      scopeIds: ["case_beta"],
      summaryText: "Beta deadline strategy"
    }));
    await store.saveSummary(makeSummary({
      id: "summary_mixed",
      personId: "person_1",
      scopeIds: ["case_alpha", "case_beta"],
      summaryText: "Mixed Alpha Beta deadline strategy"
    }));
    await store.saveSummary(makeSummary({
      id: "summary_other_person",
      personId: "person_2",
      scopeIds: ["case_alpha"],
      summaryText: "Other person Alpha deadline strategy"
    }));
    await store.saveAnchor(makeAnchor({
      id: "anchor_allowed",
      personId: "person_1",
      scopeId: "case_alpha",
      content: "Alpha filing deadline"
    }));
    await store.saveAnchor(makeAnchor({
      id: "anchor_denied",
      personId: "person_1",
      scopeId: "case_beta",
      content: "Beta filing deadline"
    }));
    await store.saveTrace(makeTrace({
      id: "trace_mixed",
      personId: "person_1",
      summaryIds: ["summary_allowed", "summary_denied"],
      title: "Alpha Beta deadline",
      description: "Mixed scope trace"
    }));
    await store.saveBox(makeBox({
      id: "box_allowed",
      personId: "person_1",
      summaryIds: ["summary_allowed"],
      summary: "Allowed parent context"
    }));

    const packet = await new MemoryRetriever(store).prepareInjection({
      host: "codex",
      profileId: "default",
      hostSessionId: "consumer",
      currentTopicSummary: "Alpha deadline strategy",
      personId: "person_1",
      allowedScopeIds: ["case_alpha"],
      requestedAt: "2026-05-04T10:10:00.000Z"
    });

    expect(packet).toMatchObject({
      personId: "person_1",
      allowedScopeIds: ["case_alpha"]
    });
    expect(packet?.selectedMemory).toContain("Alpha deadline strategy");
    expect(packet?.selectedMemory).toContain("Alpha filing deadline");
    expect(packet?.selectedMemory).not.toContain("Beta deadline strategy");
    expect(packet?.selectedMemory).not.toContain("Other person");
    expect(packet?.sourceTraceIds).not.toContain("trace_mixed");
  });

  it("fails closed when only half of the scoped retrieval context is supplied", async () => {
    const retriever = new MemoryRetriever(new InMemoryStore());
    await expect(retriever.prepareInjection({
      host: "codex",
      profileId: "default",
      hostSessionId: "consumer",
      currentTopicSummary: "deadline"
    })).rejects.toThrow(/Unscoped retrieval is disabled/);
    await expect(retriever.prepareInjection({
      host: "codex",
      profileId: "default",
      hostSessionId: "consumer",
      currentTopicSummary: "deadline",
      personId: "person_1"
    })).rejects.toThrow(/both personId and allowedScopeIds/);
    await expect(retriever.prepareInjection({
      host: "codex",
      profileId: "default",
      hostSessionId: "consumer",
      currentTopicSummary: "deadline",
      allowedScopeIds: ["case_alpha"]
    })).rejects.toThrow(/both personId and allowedScopeIds/);
  });

  it("returns and audits a ranked injection packet for matching memory", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary());
    await store.saveAnchor(makeAnchor());

    const retriever = legacyRetriever(store);
    const packet = await retriever.prepareInjection({
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      currentTopicSummary: "Smith PIP demand",
      requestedAt: "2026-05-04T10:10:00.000Z"
    });

    expect(packet).not.toBeNull();
    expect(packet).toMatchObject({
      hostSessionId: "session_1",
      currentTopicSummary: "Smith PIP demand",
      sourceSummaryIds: ["summary_1"],
      sourceTraceIds: [],
      sourceTurnRanges: [{ threadId: "session_1", startSequence: 1, endSequence: 2 }],
      boxIds: ["box_1"],
      createdAt: "2026-05-04T10:10:00.000Z"
    });
    expect(packet?.selectedMemory).toContain("Smith PIP demand strategy");
    expect(packet?.selectedMemory).toContain("PIP demand deadline");
    expect(packet?.confidence).toBeGreaterThan(0.5);
    await expect(store.listInjections("session_1")).resolves.toEqual([packet]);
  });

  it("returns null when no memory matches the current topic", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({
      summaryText: "Jones BI coverage limits."
    }));

    const retriever = legacyRetriever(store);
    const packet = await retriever.prepareInjection({
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      currentTopicSummary: "Smith PIP demand",
      requestedAt: "2026-05-04T10:10:00.000Z"
    });

    expect(packet).toBeNull();
    await expect(store.listInjections("session_1")).resolves.toEqual([]);
  });

  it("keeps separate audit packets for repeated retrievals at different times", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary());

    const retriever = legacyRetriever(store);
    const first = await retriever.prepareInjection({
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      currentTopicSummary: "Smith PIP demand",
      requestedAt: "2026-05-04T10:10:00.000Z"
    });
    const second = await retriever.prepareInjection({
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      currentTopicSummary: "Smith PIP demand",
      requestedAt: "2026-05-04T10:11:00.000Z"
    });

    expect(first?.id).not.toBe(second?.id);
    await expect(store.listInjections("session_1")).resolves.toEqual([first, second]);
  });

  it("packs selected memory within an explicit token budget", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({
      id: "summary_short",
      summaryText: "Smith PIP demand.",
      tokenCount: 3
    }));
    await store.saveSummary(makeSummary({
      id: "summary_medium",
      summaryText: "Smith PIP demand timing and provider bill review.",
      tokenCount: 8
    }));
    await store.saveSummary(makeSummary({
      id: "summary_long",
      summaryText: "Smith PIP demand strategy coverage timing provider bill review and wage loss benefits.",
      tokenCount: 12
    }));

    const retriever = legacyRetriever(store);
    const packet = await retriever.prepareInjection({
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      currentTopicSummary: "Smith PIP demand",
      requestedAt: "2026-05-04T10:10:00.000Z",
      maxMemoryTokens: 11
    });

    expect(packet?.sourceSummaryIds).toEqual(["summary_medium", "summary_short"]);
    expect(packet?.selectedMemory).toContain("Smith PIP demand.");
    expect(packet?.selectedMemory).toContain("provider bill review");
    expect(packet?.selectedMemory).not.toContain("wage loss benefits");
    expect(packet?.disclosureText).toContain("using 11/11 memory tokens");
  });

  it("deduplicates selected memory that points at the same source turn span", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({
      id: "summary_smith_pip",
      summaryText: "Smith PIP demand deadline is June 1.",
      tokenCount: 8
    }));
    await store.saveAnchor(makeAnchor({
      id: "anchor_smith_pip_deadline",
      content: "Smith PIP demand deadline is June 1."
    }));

    const retriever = legacyRetriever(store);
    const packet = await retriever.prepareInjection({
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      currentTopicSummary: "Smith PIP demand deadline",
      requestedAt: "2026-05-04T10:10:00.000Z",
      maxMemoryTokens: 80
    });

    expect(packet?.selectedMemory).toBe("Smith PIP demand deadline is June 1.");
    expect(packet?.sourceSummaryIds).toEqual(["summary_smith_pip"]);
    expect(packet?.sourceTurnRanges).toEqual([
      { threadId: "session_1", startSequence: 1, endSequence: 2 }
    ]);
    expect(packet?.disclosureText).toContain("Retrieved 1 memory item");
  });

  it("returns null when no ranked memory fits the explicit token budget", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({
      id: "summary_large",
      summaryText: "Smith PIP demand strategy and coverage timing.",
      tokenCount: 10
    }));

    const retriever = legacyRetriever(store);
    const packet = await retriever.prepareInjection({
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      currentTopicSummary: "Smith PIP demand",
      requestedAt: "2026-05-04T10:10:00.000Z",
      maxMemoryTokens: 2
    });

    expect(packet).toBeNull();
    await expect(store.listInjections("session_1")).resolves.toEqual([]);
  });

  it("uses a stub summary when the full summary exceeds the explicit token budget", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({
      id: "summary_large",
      summaryText: "Smith PIP demand strategy coverage timing provider bill review wage loss benefits and deadline planning.",
      tokenCount: 14
    }));

    const retriever = legacyRetriever(store);
    const packet = await retriever.prepareInjection({
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      currentTopicSummary: "Smith PIP demand",
      requestedAt: "2026-05-04T10:10:00.000Z",
      maxMemoryTokens: 5
    });

    expect(packet?.sourceSummaryIds).toEqual(["summary_large"]);
    expect(packet?.selectedMemory).toBe("Smith PIP demand strategy...");
    expect(packet?.disclosureText).toContain("using 5/5 memory tokens");
    await expect(store.listSummaries()).resolves.toEqual([
      expect.objectContaining({
        id: "summary_large",
        retrievalCount: 1
      })
    ]);
  });

  it("updates selected summary access metadata when memory is retrieved", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({
      strength: 0.8,
      retrievalCount: 2,
      lastAccessedAt: "2026-05-04T09:00:00.000Z",
      retrievedAt: "2026-05-04T09:00:00.000Z"
    }));

    const retriever = legacyRetriever(store);
    await retriever.prepareInjection({
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      currentTopicSummary: "Smith PIP demand",
      requestedAt: "2026-05-04T10:10:00.000Z"
    });

    await expect(store.listSummaries()).resolves.toEqual([
      expect.objectContaining({
        id: "summary_1",
        strength: 0.85,
        retrievalCount: 3,
        lastAccessedAt: "2026-05-04T10:10:00.000Z",
        retrievedAt: "2026-05-04T10:10:00.000Z"
      })
    ]);
  });

  it("caps strengthened summaries at one and leaves unselected summaries unchanged", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({
      id: "summary_selected",
      strength: 0.98
    }));
    await store.saveSummary(makeSummary({
      id: "summary_unselected",
      summaryText: "Jones BI coverage limits.",
      strength: 0.3
    }));

    const retriever = legacyRetriever(store);
    await retriever.prepareInjection({
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      currentTopicSummary: "Smith PIP demand",
      requestedAt: "2026-05-04T10:10:00.000Z"
    });

    await expect(store.listSummaries()).resolves.toEqual([
      expect.objectContaining({
        id: "summary_selected",
        strength: 1,
        retrievalCount: 1
      }),
      expect.objectContaining({
        id: "summary_unselected",
        strength: 0.3,
        retrievalCount: 0,
        lastAccessedAt: null,
        retrievedAt: null
      })
    ]);
  });

  // Phase 11 Plan 08 (GAP-11-A) contract change: stale summaries are no longer retrievable
  // directly (D-GAP-1). A stale summary that would have ranked into the packet is instead
  // promoted to "revived" without its text entering THAT packet — revival is deferred, not
  // immediate — so a follow-up retrieval on the same topic returns it.
  it("promotes an out-ranking stale summary to revived without injecting it this call, then returns it on the next retrieval", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({
      id: "summary_active",
      state: "active",
      summaryText: "Smith PIP demand strategy baseline note.",
      strength: 0.5
    }));
    await store.saveSummary(makeSummary({
      id: "summary_stale",
      state: "stale",
      summaryText: "Smith PIP demand strategy and coverage timing.",
      strength: 0.2,
      retrievalCount: 4,
      lastAccessedAt: "2026-05-01T10:00:00.000Z",
      retrievedAt: "2026-05-01T10:00:00.000Z"
    }));

    const retriever = legacyRetriever(store);
    const firstPacket = await retriever.prepareInjection({
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      currentTopicSummary: "Smith PIP demand",
      requestedAt: "2026-05-04T10:10:00.000Z"
    });

    expect(firstPacket?.sourceSummaryIds).not.toContain("summary_stale");
    expect(firstPacket?.selectedMemory).not.toContain("coverage timing");

    const afterFirst = await store.listSummaries();
    expect(afterFirst.find((summary) => summary.id === "summary_stale")).toMatchObject({
      state: "revived",
      strength: 0.25,
      retrievalCount: 5,
      lastAccessedAt: "2026-05-04T10:10:00.000Z",
      retrievedAt: "2026-05-04T10:10:00.000Z"
    });

    const secondPacket = await retriever.prepareInjection({
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      currentTopicSummary: "Smith PIP demand",
      requestedAt: "2026-05-04T10:20:00.000Z"
    });

    expect(secondPacket?.sourceSummaryIds).toContain("summary_stale");
  });

  it("leaves a stale summary stale when it scores below the selected floor", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({
      id: "summary_active",
      state: "active",
      summaryText: "Smith PIP demand strategy baseline note."
    }));
    await store.saveSummary(makeSummary({
      id: "summary_stale_unrelated",
      state: "stale",
      summaryText: "Jones BI coverage limits and an entirely unrelated topic."
    }));

    const retriever = legacyRetriever(store);
    const packet = await retriever.prepareInjection({
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      currentTopicSummary: "Smith PIP demand",
      requestedAt: "2026-05-04T10:10:00.000Z"
    });

    expect(packet?.sourceSummaryIds).toEqual(["summary_active"]);
    const summaries = await store.listSummaries();
    expect(summaries.find((summary) => summary.id === "summary_stale_unrelated")?.state).toBe("stale");
  });

  it("uses vector similarity for embedded summaries when an embedder is configured", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({
      id: "summary_pip",
      summaryText: "Personal injury protection wage loss benefits.",
      embedding: {
        provider: "test",
        model: "tiny",
        dimensions: 2,
        vector: [1, 0],
        createdAt: "2026-05-04T10:05:00.000Z"
      }
    }));
    await store.saveSummary(makeSummary({
      id: "summary_bi",
      summaryText: "Bodily injury liability carrier tender.",
      embedding: {
        provider: "test",
        model: "tiny",
        dimensions: 2,
        vector: [0, 1],
        createdAt: "2026-05-04T10:06:00.000Z"
      }
    }));
    const embedder: Embedder = {
      provider: "test",
      model: "tiny",
      dimensions: 2,
      async embed() {
        return {
          provider: "test",
          model: "tiny",
          dimensions: 2,
          vector: [1, 0],
          createdAt: "2026-05-04T10:10:00.000Z"
        };
      }
    };

    const retriever = legacyRetriever(store, { embedder });
    const packet = await retriever.prepareInjection({
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      currentTopicSummary: "lost wages no fault benefits",
      requestedAt: "2026-05-04T10:10:00.000Z"
    });

    expect(packet).not.toBeNull();
    expect(packet?.sourceSummaryIds[0]).toBe("summary_pip");
    expect(packet?.selectedMemory).toContain("Personal injury protection");
    expect(packet?.relevanceReason).toContain("vector similarity");
  });

  it("falls back to keyword ranking when stored embedding metadata is incompatible", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({
      id: "summary_vector_only",
      summaryText: "Personal injury protection wage loss benefits.",
      embedding: {
        provider: "other-provider",
        model: "tiny",
        dimensions: 2,
        vector: [1, 0],
        createdAt: "2026-05-04T10:05:00.000Z"
      }
    }));
    await store.saveSummary(makeSummary({
      id: "summary_keyword",
      summaryText: "Smith PIP demand strategy and coverage timing."
    }));
    const embedder: Embedder = {
      provider: "test",
      model: "tiny",
      dimensions: 2,
      async embed() {
        return {
          provider: "test",
          model: "tiny",
          dimensions: 2,
          vector: [1, 0],
          createdAt: "2026-05-04T10:10:00.000Z"
        };
      }
    };

    const retriever = legacyRetriever(store, { embedder });
    const packet = await retriever.prepareInjection({
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      currentTopicSummary: "Smith PIP demand",
      requestedAt: "2026-05-04T10:10:00.000Z"
    });

    expect(packet?.sourceSummaryIds[0]).toBe("summary_keyword");
    expect(packet?.relevanceReason).toContain("keyword overlap");
  });

  it("retrieves approved traces with linked summary provenance", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({
      id: "summary_provider_bill",
      summaryText: "Smith PIP provider bill review needs the ledger before demand finalization.",
      sourceTurnRanges: [{ threadId: "session_1", startSequence: 10, endSequence: 12 }],
      boxIds: ["box_smith_pip"],
      tokenCount: 12
    }));
    await store.saveTrace(makeTrace());

    const retriever = legacyRetriever(store);
    const packet = await retriever.prepareInjection({
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      currentTopicSummary: "Smith PIP provider bill ledger",
      requestedAt: "2026-05-04T10:10:00.000Z",
      maxMemoryTokens: 80
    });

    expect(packet?.sourceTraceIds).toEqual(["trace_smith_pip_provider_bills"]);
    expect(packet?.sourceSummaryIds).toContain("summary_provider_bill");
    expect(packet?.selectedMemory).toContain("[Trace: Smith PIP Provider Bills]");
    expect(packet?.relevanceReason).toContain("Top trace match trace_smith_pip_provider_bills");
  });

  it("uses a trace stub when the full trace exceeds the explicit token budget", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({
      id: "summary_1",
      summaryText: "Smith PIP provider bill review audit deadline June 1 ".repeat(6),
      tokenCount: 60
    }));
    await store.saveSummary(makeSummary({
      id: "summary_provider_bill",
      summaryText: "Smith PIP provider bill review records deadline June 15 ".repeat(6),
      sourceTurnRanges: [{ threadId: "session_1", startSequence: 10, endSequence: 12 }],
      tokenCount: 60
    }));
    await store.saveTrace(makeTrace({
      description: "Recurring Smith PIP provider bill deadline issue. ".repeat(10),
      rationale: "The provider bill issue recurred across separated turns and should stay linked. ".repeat(10)
    }));

    const retriever = legacyRetriever(store);
    const packet = await retriever.prepareInjection({
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      currentTopicSummary: "Smith PIP provider bill deadline",
      requestedAt: "2026-05-04T10:10:00.000Z",
      maxMemoryTokens: 80
    });

    expect(packet?.sourceTraceIds).toEqual(["trace_smith_pip_provider_bills"]);
    expect(packet?.selectedMemory).toContain("[Trace: Smith PIP Provider Bills]");
    expect(packet?.selectedMemory).toContain("...");
    expect(packet?.disclosureText).toContain("using 80/80 memory tokens");
  });

  it("ignores traces that are not approved", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({
      id: "summary_provider_bill",
      summaryText: "Smith PIP provider bill review needs the ledger.",
      tokenCount: 8
    }));
    await store.saveTrace(makeTrace({ state: "proposed" }));
    await store.saveTrace(makeTrace({
      id: "trace_rejected_provider_bills",
      state: "rejected"
    }));

    const retriever = legacyRetriever(store);
    const packet = await retriever.prepareInjection({
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      currentTopicSummary: "Smith PIP provider bill ledger",
      requestedAt: "2026-05-04T10:10:00.000Z",
      maxMemoryTokens: 80
    });

    expect(packet?.sourceTraceIds).toEqual([]);
    expect(packet?.relevanceReason).toContain("Top summary match summary_provider_bill");
  });

  it("adds bounded parent box context for selected child memories", async () => {
    const store = new InMemoryStore();
    await store.saveBox(makeBox({
      id: "box_case_smith",
      title: "Smith Case",
      description: "Smith car accident matter.",
      childBoxIds: ["box_smith_pip"],
      summaryIds: ["summary_case_smith"],
      boxType: "case",
      summary: "Smith car accident case with PIP and BI coverage issues.",
      turnRanges: [{ threadId: "session_1", startSequence: 1, endSequence: 20 }]
    }));
    await store.saveBox(makeBox({
      id: "box_smith_pip",
      parentBoxId: "box_case_smith"
    }));
    await store.saveSummary(makeSummary({
      id: "summary_provider_bill",
      summaryText: "Smith PIP provider bill review needs the ledger before demand finalization.",
      boxIds: ["box_smith_pip"],
      tokenCount: 10
    }));

    const retriever = legacyRetriever(store);
    const packet = await retriever.prepareInjection({
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      currentTopicSummary: "Smith PIP provider bill ledger",
      requestedAt: "2026-05-04T10:10:00.000Z",
      maxMemoryTokens: 80
    });

    expect(packet?.selectedMemory).toContain("[Parent Box: Smith Case]");
    expect(packet?.selectedMemory).toContain("Smith car accident case");
    expect(packet?.boxIds).toEqual(["box_smith_pip", "box_case_smith"]);
    expect(packet?.disclosureText).toContain("parent box context");
  });

  it("omits parent box context when the explicit token budget is too small", async () => {
    const store = new InMemoryStore();
    await store.saveBox(makeBox({
      id: "box_case_smith",
      title: "Smith Case",
      childBoxIds: ["box_smith_pip"],
      summary: "Smith car accident case with PIP and BI coverage issues."
    }));
    await store.saveBox(makeBox({
      id: "box_smith_pip",
      parentBoxId: "box_case_smith"
    }));
    await store.saveSummary(makeSummary({
      id: "summary_provider_bill",
      summaryText: "Smith PIP provider bill ledger.",
      boxIds: ["box_smith_pip"],
      tokenCount: 5
    }));

    const retriever = legacyRetriever(store);
    const packet = await retriever.prepareInjection({
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      currentTopicSummary: "Smith PIP provider bill ledger",
      requestedAt: "2026-05-04T10:10:00.000Z",
      maxMemoryTokens: 6
    });

    expect(packet?.selectedMemory).not.toContain("[Parent Box: Smith Case]");
    expect(packet?.boxIds).toEqual(["box_smith_pip"]);
  });

  it("does not retrieve a child trace for a broad parent-only query", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({
      id: "summary_case_smith",
      summaryText: "Smith car accident case overview and general planning.",
      boxIds: ["box_case_smith"],
      tokenCount: 8
    }));
    await store.saveSummary(makeSummary({
      id: "summary_provider_bill",
      summaryText: "Smith PIP provider bill ledger dispute.",
      boxIds: ["box_smith_pip"],
      tokenCount: 8
    }));
    await store.saveTrace(makeTrace({
      description: "Recurring Smith case PIP provider bill dispute and no-fault payment timing.",
      rationale: "The same Smith case provider bill issue recurred across separated turns."
    }));

    const retriever = legacyRetriever(store);
    const packet = await retriever.prepareInjection({
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      currentTopicSummary: "Smith case overview",
      requestedAt: "2026-05-04T10:10:00.000Z",
      maxMemoryTokens: 80
    });

    expect(packet?.sourceTraceIds).toEqual([]);
    expect(packet?.sourceSummaryIds[0]).toBe("summary_case_smith");
  });

  // Phase 11 Plan 06, Task 2 (SC7, T-11-20): a topic discussed across two sessions with heavy
  // tool use between the human turns must retrieve at least as well after hygiene as it did
  // before. Drives the real ContractionRunner end to end (not a reimplementation), the same
  // way Task 1's ratio test does, then feeds the resulting summaries into the real
  // MemoryRetriever and compares top-match scores between a pre-hygiene reference (tool calls
  // relabeled as ordinary label-driving messages, reproducing pre-Phase-11 fragmentation) and
  // the unmodified hygiene run.
  it("ranks a topic discussed across two tool-interrupted sessions at least as high after hygiene as before it", async () => {
    const hygieneSummaries = await deriveSummaries(buildCrossSessionCorpus());
    const preHygieneSummaries = await deriveSummaries(buildCrossSessionCorpus().map(relabelForPreHygiene));

    // Sanity: hygiene keeps the topic in ONE summary; pre-hygiene fragments it (T-11-20 guard —
    // this positive assertion would be meaningless if both variants already behaved the same).
    expect(hygieneSummaries).toHaveLength(1);
    expect(preHygieneSummaries.length).toBeGreaterThan(1);

    const query =
      "budget forecast kickoff outlining followup finalizing revision numbers deadline";

    const hygieneScore = await topMatchScore(hygieneSummaries, query);
    const preHygieneScore = await topMatchScore(preHygieneSummaries, query);

    expect(hygieneScore).toBeGreaterThanOrEqual(preHygieneScore);
    // Hygiene keeps both sessions' vocabulary in the one merged summary; no pre-hygiene fragment
    // ever holds both halves, so this is a genuine (not merely tied) improvement.
    expect(hygieneScore).toBeGreaterThan(preHygieneScore);
  });
});

// Phase 11 Plan 08 — GAP-11-A regression describe block. Mirrors the isolation reproduction in
// 11-MEASUREMENT-VERIFIED.md: one active + one superseded summary on the same topic, asserting
// the superseded summary is never returned and its text never enters selectedMemory.
describe("GAP-11-A: retrievable-state boundary", () => {
  const GAP_PERSON_ID = "person_gap11a";
  const GAP_SCOPE_ID = "scope_gap11a";
  const GAP_TOPIC = "Smith PIP demand strategy coverage timing";

  const scopedRetrieval = (
    store: InMemoryStore,
    overrides: { hostSessionId?: string; currentTopicSummary?: string; requestedAt?: string } = {}
  ) =>
    new MemoryRetriever(store).prepareInjection({
      host: "codex",
      profileId: "default",
      hostSessionId: overrides.hostSessionId ?? "session_gap11a",
      currentTopicSummary: overrides.currentTopicSummary ?? GAP_TOPIC,
      personId: GAP_PERSON_ID,
      allowedScopeIds: [GAP_SCOPE_ID],
      requestedAt: overrides.requestedAt ?? "2026-05-04T10:10:00.000Z",
      maxMemoryTokens: 200
    });

  it("(a)+(b) a superseded summary is never retrieved and its text never reaches selectedMemory", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({
      id: "summary_active_gap",
      personId: GAP_PERSON_ID,
      scopeIds: [GAP_SCOPE_ID],
      state: "active",
      summaryText: "Smith PIP demand strategy and coverage timing."
    }));
    await store.saveSummary(makeSummary({
      id: "summary_superseded_gap",
      personId: GAP_PERSON_ID,
      scopeIds: [GAP_SCOPE_ID],
      state: "superseded",
      summaryText: 'Smith PIP demand strategy and coverage timing. [Tool call: Bash] {"cmd":"make"}'
    }));

    const packet = await scopedRetrieval(store);

    expect(packet).not.toBeNull();
    expect(packet?.sourceSummaryIds).not.toContain("summary_superseded_gap");
    expect(packet?.sourceSummaryIds).toContain("summary_active_gap");
    expect(packet?.selectedMemory).not.toContain("[Tool call:");
  });

  it.each(["proposed", "approved", "rejected", "disputed"] as const)(
    "(c) a %s summary never ranks into the packet",
    async (state) => {
      const store = new InMemoryStore();
      await store.saveSummary(makeSummary({
        id: "summary_active_gap",
        personId: GAP_PERSON_ID,
        scopeIds: [GAP_SCOPE_ID],
        state: "active",
        summaryText: "Smith PIP demand strategy and coverage timing."
      }));
      await store.saveSummary(makeSummary({
        id: `summary_${state}_gap`,
        personId: GAP_PERSON_ID,
        scopeIds: [GAP_SCOPE_ID],
        state,
        summaryText: "Smith PIP demand strategy and coverage timing."
      }));

      const packet = await scopedRetrieval(store);

      expect(packet?.sourceSummaryIds).not.toContain(`summary_${state}_gap`);
    }
  );

  it("(d) a trace whose linked summaries are all superseded is excluded and its title never reaches selectedMemory", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({
      id: "summary_active_gap",
      personId: GAP_PERSON_ID,
      scopeIds: [GAP_SCOPE_ID],
      state: "active",
      summaryText: "Smith PIP demand strategy and coverage timing."
    }));
    await store.saveSummary(makeSummary({
      id: "summary_superseded_a",
      personId: GAP_PERSON_ID,
      scopeIds: [GAP_SCOPE_ID],
      state: "superseded",
      summaryText: "Smith PIP provider bill review needs the ledger."
    }));
    await store.saveSummary(makeSummary({
      id: "summary_superseded_b",
      personId: GAP_PERSON_ID,
      scopeIds: [GAP_SCOPE_ID],
      state: "superseded",
      summaryText: "Smith PIP provider bill review records the deadline."
    }));
    await store.saveTrace(makeTrace({
      id: "trace_all_superseded",
      personId: GAP_PERSON_ID,
      summaryIds: ["summary_superseded_a", "summary_superseded_b"],
      title: "Smith PIP Provider Bill Trace (all-superseded)",
      description: "Recurring Smith PIP provider bill dispute and no-fault payment timing."
    }));

    const packet = await scopedRetrieval(store);

    expect(packet?.sourceTraceIds).not.toContain("trace_all_superseded");
    expect(packet?.selectedMemory).not.toContain("Smith PIP Provider Bill Trace (all-superseded)");
  });

  it("(e) a box whose only linked summary is superseded is excluded from parent-box context", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({
      id: "summary_superseded_box_child",
      personId: GAP_PERSON_ID,
      scopeIds: [GAP_SCOPE_ID],
      state: "superseded",
      summaryText: "Smith PIP provider bill review needs the ledger."
    }));
    await store.saveBox(makeBox({
      id: "box_parent_all_superseded",
      personId: GAP_PERSON_ID,
      title: "Smith Case (all-superseded)",
      parentBoxId: null,
      childBoxIds: ["box_child_gap"],
      summaryIds: ["summary_superseded_box_child"],
      summary: "Smith case parent whose only linked summary is superseded."
    }));
    await store.saveBox(makeBox({
      id: "box_child_gap",
      personId: GAP_PERSON_ID,
      parentBoxId: "box_parent_all_superseded",
      summaryIds: ["summary_active_child_gap"]
    }));
    await store.saveSummary(makeSummary({
      id: "summary_active_child_gap",
      personId: GAP_PERSON_ID,
      scopeIds: [GAP_SCOPE_ID],
      state: "active",
      boxIds: ["box_child_gap"],
      summaryText: "Smith PIP demand strategy and coverage timing."
    }));

    const packet = await scopedRetrieval(store);

    expect(packet?.boxIds).not.toContain("box_parent_all_superseded");
    expect(packet?.selectedMemory).not.toContain("[Parent Box: Smith Case (all-superseded)]");
  });

  it("(f) anchors are unaffected — Anchor carries no state field, so there is nothing to exclude", async () => {
    const store = new InMemoryStore();
    await store.saveAnchor(makeAnchor({
      id: "anchor_gap11a",
      personId: GAP_PERSON_ID,
      scopeId: GAP_SCOPE_ID,
      content: "Smith PIP demand strategy coverage timing filing deadline."
    }));

    const packet = await scopedRetrieval(store);

    expect(packet?.selectedMemory).toContain("Smith PIP demand strategy coverage timing filing deadline.");
  });
});

const CROSS_SESSION_PERSON_ID = "person_hygiene_sc7";
const CROSS_SESSION_SCOPE_ID = "scope_hygiene_sc7";
const CROSS_SESSION_FIXED_NOW = "2026-01-01T00:00:00.000Z";

/**
 * Session A discusses a budget forecast, then ~15 unrelated tool calls run, then session B
 * continues the SAME topic (shares "budget"/"forecast" vocabulary with session A) with new
 * details. Real `[Tool call: NAME] ...` content, `eventKind: "tool_call"`, matching
 * `derivation-hygiene.ts`'s classifier exactly.
 */
function buildCrossSessionCorpus(): CanonicalEvent[] {
  const events: CanonicalEvent[] = [];
  let sequence = 0;
  const push = (content: string, role: CanonicalEvent["role"], eventKind?: CanonicalEvent["eventKind"]): void => {
    const occurredAt = new Date(Date.parse(CROSS_SESSION_FIXED_NOW) + sequence * 60_000).toISOString();
    events.push({
      id: `sc7-${sequence}`,
      personId: CROSS_SESSION_PERSON_ID,
      sourceId: `source_${CROSS_SESSION_PERSON_ID}`,
      sourceApplication: "synthetic",
      sourceProfileId: "default",
      scopeId: CROSS_SESSION_SCOPE_ID,
      nativeSessionId: "session-sc7",
      nativeEventId: `sc7-${sequence}`,
      nativeSequence: sequence,
      causalParentId: null,
      eventKind,
      role,
      content,
      occurredAt,
      importedAt: occurredAt,
      provenance: role === "user" ? "direct_user_input" : "assistant_output",
      trustLevel: role === "user" ? "high" : "medium",
      contentHash: `hash-sc7-${sequence}`,
      parserVersion: "hygiene-sc7/v1",
      metadata: {}
    });
    sequence += 1;
  };

  push("Budget forecast kickoff review outlining revenue assumptions for Q3.", "user");
  for (let i = 0; i < 15; i += 1) {
    const name = i % 2 === 0 ? "Bash" : "Read";
    push(
      `[Tool call: ${name}] argument payload for tool invocation ${i} carrying representative filler text of realistic tool call length`,
      "assistant",
      "tool_call"
    );
  }
  push("Budget forecast followup finalizing revision numbers before the deadline.", "assistant");

  return events;
}

/** Mirrors Task 1's `relabelForPreHygiene`: strips the bracket marker and drops `eventKind`. */
function relabelForPreHygiene(event: CanonicalEvent): CanonicalEvent {
  if (event.eventKind !== "tool_call") return event;
  return {
    ...event,
    eventKind: "message",
    content: event.content.replace(/^\[[^\]]*\]\s*/, "")
  };
}

async function deriveSummaries(events: CanonicalEvent[]): Promise<Summary[]> {
  const store = new InMemoryStore();
  await store.savePerson({ id: CROSS_SESSION_PERSON_ID, displayName: null, createdAt: CROSS_SESSION_FIXED_NOW });
  await store.saveSource({
    id: `source_${CROSS_SESSION_PERSON_ID}`,
    personId: CROSS_SESSION_PERSON_ID,
    application: "synthetic",
    profileId: "default",
    instanceId: "test",
    scopeId: CROSS_SESSION_SCOPE_ID,
    createdAt: CROSS_SESSION_FIXED_NOW,
    lastImportedAt: CROSS_SESSION_FIXED_NOW
  });
  for (const event of events) await store.saveCanonicalEvent(event);

  const first = events[0]!;
  const last = events.at(-1)!;
  const job = {
    id: "job-sc7",
    personId: CROSS_SESSION_PERSON_ID,
    generation: 1,
    earliestAffected: { occurredAt: first.occurredAt, nativeSequence: first.nativeSequence, id: first.id },
    latestAffected: { occurredAt: last.occurredAt, nativeSequence: last.nativeSequence, id: last.id },
    state: "pending" as const,
    attempts: 0,
    immediateDirty: true,
    proposalDirty: true,
    lastProposalRunAt: null,
    lastActivityAt: CROSS_SESSION_FIXED_NOW,
    nextDueAt: CROSS_SESSION_FIXED_NOW,
    createdAt: CROSS_SESSION_FIXED_NOW,
    updatedAt: CROSS_SESSION_FIXED_NOW
  };
  await store.saveContractionJob(job);

  const runner = new ContractionRunner(store, {
    authority: { kind: "foreground", personId: CROSS_SESSION_PERSON_ID, operation: "historical-bootstrap" }
  });
  for (;;) {
    const result = await runner.drainSlice(CROSS_SESSION_PERSON_ID, job.id);
    if (result.complete) break;
  }

  return store.listSummaries();
}

/** Highest keyword-overlap score across every summary for `query`, via the real MemoryRetriever. */
async function topMatchScore(summaries: Summary[], query: string): Promise<number> {
  const store = new InMemoryStore();
  for (const summary of summaries) await store.saveSummary(summary);

  const retriever = new MemoryRetriever(store);
  const packet = await retriever.prepareInjection({
    host: "test",
    profileId: "default",
    hostSessionId: "session_sc7",
    currentTopicSummary: query,
    requestedAt: CROSS_SESSION_FIXED_NOW,
    maxMemoryTokens: 10_000,
    personId: CROSS_SESSION_PERSON_ID,
    allowedScopeIds: [CROSS_SESSION_SCOPE_ID]
  });

  return packet?.confidence ?? 0;
}
