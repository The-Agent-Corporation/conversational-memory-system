import { describe, expect, it } from "vitest";
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

  it("revives stale summaries when retrieval selects them", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({
      id: "summary_stale",
      state: "stale",
      strength: 0.2,
      retrievalCount: 4,
      lastAccessedAt: "2026-05-01T10:00:00.000Z",
      retrievedAt: "2026-05-01T10:00:00.000Z"
    }));

    const retriever = legacyRetriever(store);
    const packet = await retriever.prepareInjection({
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      currentTopicSummary: "Smith PIP demand",
      requestedAt: "2026-05-04T10:10:00.000Z"
    });

    expect(packet?.sourceSummaryIds).toEqual(["summary_stale"]);
    await expect(store.listSummaries()).resolves.toEqual([
      expect.objectContaining({
        id: "summary_stale",
        state: "revived",
        strength: 0.25,
        retrievalCount: 5,
        lastAccessedAt: "2026-05-04T10:10:00.000Z",
        retrievedAt: "2026-05-04T10:10:00.000Z"
      })
    ]);
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
});
