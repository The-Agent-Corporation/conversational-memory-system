import { describe, expect, it } from "vitest";
import { HermesMemoryAdapter } from "../../src/integrations/hermes/adapter.js";
import type { HermesTimelineRow } from "../../src/integrations/hermes/contract.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import { DeterministicSummarizer } from "../../src/summarization/summarizer.js";

/**
 * Live-path regression coverage for HermesMemoryAdapter.processTimelineRow (11-CONTEXT
 * decision 5): tool rows and harness-injected rows must never open or close a topic span
 * on the running agent bridge, matching the daemon/contraction path, while still being
 * ingested into the canonical timeline unchanged (D-1).
 */
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

describe("HermesMemoryAdapter derivation hygiene (live bridge)", () => {
  it("does not open or close a topic span for tool rows, but still ingests them", async () => {
    const store = new InMemoryStore();
    const adapter = new HermesMemoryAdapter(store, { summarizer: new DeterministicSummarizer() });

    const first = await adapter.processTimelineRow(row({
      id: "1",
      sequence: 1,
      role: "user",
      content: "Let's talk about Smith PIP.",
      created_at: "2026-05-04T10:00:00.000Z"
    }));
    expect(first.currentTopic?.topicLabel).toBe("Smith PIP");

    const toolContents = [
      "[Tool call: Bash] {\"command\":\"grep -R foo\"}",
      "[Tool call: Read] {\"path\":\"/etc/hosts\"}",
      "[Tool call: Grep] {\"pattern\":\"xyzzy\"}"
    ];

    for (let i = 0; i < toolContents.length; i += 1) {
      const sequence = i + 2;
      const result = await adapter.processTimelineRow(row({
        id: String(sequence),
        sequence,
        role: "tool",
        content: toolContents[i],
        created_at: `2026-05-04T10:00:${10 + i}.000Z`
      }));

      // (a) no completedTopic while tool rows stream in
      expect(result.completedTopic).toBeNull();
      // (b) currentTopic is still returned for tool rows
      expect(result.currentTopic?.topicLabel).toBe("Smith PIP");
      // (c) each tool row still yields a persisted Turn
      expect(result.turn).not.toBeNull();
    }

    const turns = await store.listTurns("hermes-session");
    expect(turns).toHaveLength(4);

    const followUp = await adapter.processTimelineRow(row({
      id: "5",
      sequence: 5,
      role: "user",
      content: "Any update on the Smith PIP deadline?",
      created_at: "2026-05-04T10:00:20.000Z"
    }));
    // The topic label did not change even though 3 unrelated tool rows streamed through.
    expect(followUp.completedTopic).toBeNull();
    expect(followUp.currentTopic?.topicLabel).toBe("Smith PIP");
  });

  it("does not open or close a topic span for a harness-injected [SYSTEM: ...] row", async () => {
    const store = new InMemoryStore();
    const adapter = new HermesMemoryAdapter(store, { summarizer: new DeterministicSummarizer() });

    await adapter.processTimelineRow(row({
      id: "1",
      sequence: 1,
      role: "user",
      content: "Let's talk about Smith PIP.",
      created_at: "2026-05-04T10:00:00.000Z"
    }));

    const systemResult = await adapter.processTimelineRow(row({
      id: "2",
      sequence: 2,
      role: "user",
      content: "[SYSTEM: harness reconnect notice, ignore]",
      created_at: "2026-05-04T10:00:05.000Z"
    }));

    expect(systemResult.completedTopic).toBeNull();
    expect(systemResult.currentTopic?.topicLabel).toBe("Smith PIP");
    expect(systemResult.turn).not.toBeNull();
  });

  it("still closes the span on a control_signal row (e.g. /new)", async () => {
    const store = new InMemoryStore();
    const adapter = new HermesMemoryAdapter(store, { summarizer: new DeterministicSummarizer() });

    await adapter.processTimelineRow(row({
      id: "1",
      sequence: 1,
      role: "user",
      content: "Let's talk about Smith PIP.",
      created_at: "2026-05-04T10:00:00.000Z"
    }));
    await adapter.processTimelineRow(row({
      id: "2",
      sequence: 2,
      role: "assistant",
      content: "The Smith PIP issue is about demand timing.",
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
  });
});
