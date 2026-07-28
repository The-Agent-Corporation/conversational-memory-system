import { describe, expect, it, vi } from "vitest";
import { AnchorDetector } from "../../src/anchors/anchor-detector.js";
import { HermesMemoryAdapter } from "../../src/integrations/hermes/adapter.js";
import type { Summary } from "../../src/domain/types.js";
import type { Embedder } from "../../src/embeddings/embedder.js";
import type { HermesTimelineRow } from "../../src/integrations/hermes/contract.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import type { Summarizer } from "../../src/summarization/summarizer.js";

const row = (overrides: Partial<HermesTimelineRow> = {}): HermesTimelineRow => ({
  id: "1",
  profile_id: "default",
  session_id: "hermes-session",
  sequence: 1,
  role: "user",
  content: "Let's talk about Smith PIP.",
  created_at: "2026-05-04T10:00:00.000Z",
  channel: "telegram",
  metadata_json: "{\"platform\":\"telegram\"}",
  ...overrides
});

const summary = (overrides: Partial<Summary> = {}): Summary => ({
  id: "summary_seeded",
  summaryText: "Smith PIP demand strategy coverage timing provider bill review wage loss benefits and deadline planning.",
  sourceTurnRanges: [{ threadId: "hermes-session", startSequence: 1, endSequence: 2 }],
  sourceSummaryIds: [],
  boxIds: ["box_1"],
  embedding: null,
  createdAt: "2026-05-04T10:05:00.000Z",
  model: "test-summarizer",
  promptVersion: "v1",
  confidence: 0.91,
  state: "compacted",
  detailLevel: "medium",
  tokenCount: 14,
  lastAccessedAt: null,
  version: 1,
  strength: 0.8,
  retrievalCount: 0,
  retrievedAt: null,
  halfLifeHours: 168,
  outcomeScore: null,
  ...overrides
});

describe("HermesMemoryAdapter", () => {
  it("processes Hermes rows through ingest, anchors, topic monitoring, and pre-compaction", async () => {
    const store = new InMemoryStore();
    const adapter = new HermesMemoryAdapter(store);

    await adapter.processTimelineRow(row());
    await adapter.processTimelineRow(row({
      id: "2",
      sequence: 2,
      role: "assistant",
      content: "The Smith PIP demand deadline is June 1.",
      created_at: "2026-05-04T10:00:10.000Z"
    }));
    const result = await adapter.processTimelineRow(row({
      id: "3",
      sequence: 3,
      content: "Switch to Jones BI coverage.",
      created_at: "2026-05-04T10:05:00.000Z"
    }));

    expect(result.completedTopic?.topicLabel).toBe("Smith PIP");
    expect(result.compaction?.summary.sourceTurnRanges).toEqual([
      { threadId: "hermes-session", startSequence: 1, endSequence: 2 }
    ]);

    const turns = await store.listTurns("hermes-session");
    expect(turns).toHaveLength(3);
    expect(turns[0].metadata).toMatchObject({
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "hermes-session",
      sourceMetadata: {
        channel: "telegram",
        sourceMetadata: {
          platform: "telegram"
        }
      }
    });

    const anchors = await store.listAnchors();
    expect(anchors.map((anchor) => anchor.anchorType)).toContain("deadline");

    const summaries = await store.listSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].summaryText).toContain("Smith PIP");
  });

  // GAP-11-G / T-11-93: the anchor gate gained an optional `eventKind`, and this is the live agent
  // bridge, so the seam gets explicit coverage. Hermes rows carry no eventKind today, so the
  // observable behavior here must be exactly what it was; what the seam guarantees going forward is
  // that the anchor gate receives the SAME third classification input the topic gate on the line
  // above already receives, instead of silently diverging the way it did before this plan.
  describe("anchor gate eventKind forwarding (GAP-11-G)", () => {
    it("forwards the host event's eventKind to the anchor gate", async () => {
      const store = new InMemoryStore();
      const adapter = new HermesMemoryAdapter(store);
      const spy = vi.spyOn(AnchorDetector.prototype, "detectForTurn");

      try {
        await adapter.processTimelineRow(row({ content: "The Smith PIP demand deadline is June 1." }));

        expect(spy).toHaveBeenCalledTimes(1);
        const [, options] = spy.mock.calls[0]!;
        expect(options).toEqual({ eventKind: undefined });
      } finally {
        spy.mockRestore();
      }
    });

    it("keeps live-bridge anchor behavior unchanged: conversational mints, role tool does not", async () => {
      const store = new InMemoryStore();
      const adapter = new HermesMemoryAdapter(store);

      const conversational = await adapter.processTimelineRow(
        row({ content: "The Smith PIP demand deadline is June 1." })
      );
      const toolRole = await adapter.processTimelineRow(row({
        id: "2",
        sequence: 2,
        role: "tool",
        content: "We decided the deadline is June 1 because the policy limit is confirmed.",
        created_at: "2026-05-04T10:00:10.000Z"
      }));

      expect(conversational.anchors.map((anchor) => anchor.anchorType)).toEqual(["deadline", "key_fact"]);
      expect(conversational.anchors[0]?.content).toBe("The Smith PIP demand deadline is June 1.");
      expect(toolRole.anchors).toEqual([]);
    });
  });

  it("compacts the active topic when Hermes sends a new-conversation command", async () => {
    const store = new InMemoryStore();
    const adapter = new HermesMemoryAdapter(store);

    await adapter.processTimelineRow(row());
    await adapter.processTimelineRow(row({
      id: "2",
      sequence: 2,
      role: "assistant",
      content: "The Smith PIP demand deadline is June 1.",
      created_at: "2026-05-04T10:00:10.000Z"
    }));

    const result = await adapter.processTimelineRow(row({
      id: "3",
      sequence: 3,
      content: "/new",
      created_at: "2026-05-04T10:05:00.000Z"
    }));

    expect(result.turn).toBeNull();
    expect(result.completedTopic?.topicLabel).toBe("Smith PIP");
    expect(result.compaction?.summary.sourceTurnRanges).toEqual([
      { threadId: "hermes-session", startSequence: 1, endSequence: 2 }
    ]);
    await expect(store.listTurns("hermes-session")).resolves.toHaveLength(2);
  });

  it("prepares injection from the current Hermes topic", async () => {
    const store = new InMemoryStore();
    const adapter = new HermesMemoryAdapter(store);

    await adapter.processTimelineRow(row());
    await adapter.processTimelineRow(row({
      id: "2",
      sequence: 2,
      role: "assistant",
      content: "The Smith PIP demand deadline is June 1.",
      created_at: "2026-05-04T10:00:10.000Z"
    }));
    await adapter.processTimelineRow(row({
      id: "3",
      sequence: 3,
      content: "Switch to Jones BI coverage.",
      created_at: "2026-05-04T10:05:00.000Z"
    }));
    await adapter.processTimelineRow(row({
      id: "4",
      sequence: 4,
      content: "Resume Smith PIP.",
      created_at: "2026-05-04T10:10:00.000Z"
    }));

    const packet = await adapter.prepareCurrentTopicInjection(
      "hermes-session",
      "2026-05-04T10:10:05.000Z"
    );

    expect(packet).not.toBeNull();
    expect(packet?.currentTopicSummary).toBe("Smith PIP (1 turn, seq 4-4)");
    expect(packet?.selectedMemory).toContain("Smith PIP");
    await expect(store.listInjections("hermes-session")).resolves.toEqual([packet]);
  });

  it("expands a summary into source Hermes timeline turns on request", async () => {
    const store = new InMemoryStore();
    const adapter = new HermesMemoryAdapter(store);

    await adapter.processTimelineRow(row());
    await adapter.processTimelineRow(row({
      id: "2",
      sequence: 2,
      role: "assistant",
      content: "The Smith PIP demand deadline is June 1.",
      created_at: "2026-05-04T10:00:10.000Z"
    }));
    await store.saveSummary(summary());

    const result = await adapter.resumeSummary("summary_seeded");

    expect(result.sourceSummaryIds).toEqual(["summary_seeded"]);
    expect(result.sourceTurnRanges).toEqual([
      { threadId: "hermes-session", startSequence: 1, endSequence: 2 }
    ]);
    expect(result.turns.map((turn) => turn.content)).toEqual([
      "Let's talk about Smith PIP.",
      "The Smith PIP demand deadline is June 1."
    ]);
    expect(result.disclosureText).toBe("Expanded 1 summary into 2 verbatim turns.");
  });

  it("passes an explicit memory token budget into current-topic injection", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(summary());
    const adapter = new HermesMemoryAdapter(store);

    await adapter.processTimelineRow(row({
      id: "1",
      sequence: 1,
      content: "Let's talk about Smith matter.",
      created_at: "2026-05-04T10:10:00.000Z"
    }));

    const packet = await adapter.prepareCurrentTopicInjection("hermes-session", {
      requestedAt: "2026-05-04T10:10:05.000Z",
      maxMemoryTokens: 5
    });

    expect(packet?.selectedMemory).toBe("Smith PIP demand strategy...");
    expect(packet?.disclosureText).toContain("using 5/5 memory tokens");
  });

  it("searches memory explicitly without relying on the current topic monitor", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(summary());
    const adapter = new HermesMemoryAdapter(store);

    const packet = await adapter.searchMemory({
      profileId: "default",
      hostSessionId: "hermes-session",
      query: "Smith PIP demand deadline",
      requestedAt: "2026-05-04T10:15:00.000Z"
    });

    expect(packet).not.toBeNull();
    expect(packet?.currentTopicSummary).toBe("Smith PIP demand deadline");
    expect(packet?.selectedMemory).toContain("Smith PIP demand strategy");
    expect(packet?.sourceSummaryIds).toEqual(["summary_seeded"]);
    expect(packet?.disclosureText).toContain("Searched memory for");
  });

  it("uses an injected summarizer for completed topic compaction", async () => {
    const store = new InMemoryStore();
    const summarizer: Summarizer = {
      async summarize({ span, sourceTurns }) {
        return {
          summaryText: `runtime ${span.topicLabel} from ${sourceTurns.length} turns`,
          model: "runtime-test-summarizer",
          promptVersion: "runtime-test-v1",
          confidence: 0.91,
          detailLevel: "medium",
          tokenCount: 7
        };
      }
    };
    const adapter = new HermesMemoryAdapter(store, { summarizer });

    await adapter.processTimelineRow(row());
    await adapter.processTimelineRow(row({
      id: "2",
      sequence: 2,
      role: "assistant",
      content: "The Smith PIP demand deadline is June 1.",
      created_at: "2026-05-04T10:00:10.000Z"
    }));
    const result = await adapter.processTimelineRow(row({
      id: "3",
      sequence: 3,
      content: "Switch to Jones BI coverage.",
      created_at: "2026-05-04T10:05:00.000Z"
    }));

    expect(result.compaction?.summary).toMatchObject({
      summaryText: "runtime Smith PIP from 2 turns",
      model: "runtime-test-summarizer",
      promptVersion: "runtime-test-v1",
      confidence: 0.91,
      detailLevel: "medium"
    });
  });

  it("uses an injected embedder for summary compaction and current-topic retrieval", async () => {
    const store = new InMemoryStore();
    const embedder: Embedder = {
      provider: "test",
      model: "tiny",
      dimensions: 2,
      async embed(text) {
        return {
          provider: "test",
          model: "tiny",
          dimensions: 2,
          vector: text.toLowerCase().includes("pip") ? [1, 0] : [0, 1],
          createdAt: "2026-05-04T10:10:00.000Z"
        };
      }
    };
    const adapter = new HermesMemoryAdapter(store, { embedder });

    await adapter.processTimelineRow(row());
    await adapter.processTimelineRow(row({
      id: "2",
      sequence: 2,
      role: "assistant",
      content: "The Smith PIP demand deadline is June 1.",
      created_at: "2026-05-04T10:00:10.000Z"
    }));
    await adapter.processTimelineRow(row({
      id: "3",
      sequence: 3,
      content: "Switch to Jones BI coverage.",
      created_at: "2026-05-04T10:05:00.000Z"
    }));

    const summaries = await store.listSummaries();
    expect(summaries[0].embedding).toMatchObject({
      provider: "test",
      model: "tiny",
      dimensions: 2,
      vector: [1, 0]
    });

    await adapter.processTimelineRow(row({
      id: "4",
      sequence: 4,
      content: "Resume Smith PIP.",
      created_at: "2026-05-04T10:10:00.000Z"
    }));
    const packet = await adapter.prepareCurrentTopicInjection(
      "hermes-session",
      "2026-05-04T10:10:05.000Z"
    );

    expect(packet?.sourceSummaryIds).toEqual(["summary_hermes-session_1_2"]);
    expect(packet?.relevanceReason).toContain("vector similarity");
  });
});
