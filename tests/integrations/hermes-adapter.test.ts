import { describe, expect, it } from "vitest";
import { HermesMemoryAdapter } from "../../src/integrations/hermes/adapter.js";
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
