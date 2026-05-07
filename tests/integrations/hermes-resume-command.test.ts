import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Box, InjectionPacket, MemoryTrace, Summary, Turn } from "../../src/domain/types.js";
import { resumeHermesMemory } from "../../src/integrations/hermes/resume-command.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";

let tempDir: string | null = null;

const makeTempDir = async (): Promise<string> => {
  tempDir = await mkdtemp(join(tmpdir(), "cms-hermes-resume-"));
  return tempDir;
};

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

const turn = (overrides: Partial<Turn> = {}): Turn => ({
  id: "turn_1",
  threadId: "profile:default",
  sequence: 1,
  role: "user",
  content: "Let's talk about Smith PIP.",
  createdAt: "2024-05-04T12:40:00.000Z",
  provenance: "direct_user_input",
  trustLevel: "high",
  metadata: {},
  contentHash: "hash_1",
  ...overrides
});

const summary = (overrides: Partial<Summary> = {}): Summary => ({
  id: "summary_smith_pip",
  summaryText: "Smith PIP demand timing.",
  sourceTurnRanges: [{ threadId: "profile:default", startSequence: 1, endSequence: 2 }],
  sourceSummaryIds: [],
  boxIds: ["box_smith"],
  embedding: null,
  createdAt: "2024-05-04T12:45:00.000Z",
  model: "test",
  promptVersion: "v1",
  confidence: 0.9,
  state: "compacted",
  detailLevel: "medium",
  tokenCount: 8,
  lastAccessedAt: null,
  version: 1,
  strength: 0.8,
  retrievalCount: 0,
  retrievedAt: null,
  halfLifeHours: 168,
  outcomeScore: null,
  ...overrides
});

const box = (overrides: Partial<Box> = {}): Box => ({
  id: "box_smith_pip",
  title: "Smith PIP",
  description: "Smith PIP issue.",
  parentBoxId: null,
  childBoxIds: [],
  summaryIds: ["summary_smith_pip", "summary_smith_provider_bill"],
  turnRanges: [{ threadId: "profile:default", startSequence: 1, endSequence: 2 }],
  state: "approved",
  createdAt: "2024-05-04T12:45:00.000Z",
  updatedAt: "2024-05-04T12:45:00.000Z",
  caseId: "case_smith",
  boxType: "topic",
  summary: "Smith PIP issue.",
  lastActivityAt: "2024-05-04T12:45:00.000Z",
  ...overrides
});

const trace = (overrides: Partial<MemoryTrace> = {}): MemoryTrace => ({
  id: "trace_smith_pip_provider_bills",
  title: "Smith PIP Provider Bills",
  description: "Smith PIP provider bill dispute.",
  traceType: "case_issue",
  state: "approved",
  summaryIds: ["summary_smith_pip", "summary_smith_provider_bill"],
  boxIds: ["box_smith_pip"],
  turnRanges: [
    { threadId: "profile:default", startSequence: 1, endSequence: 2 },
    { threadId: "profile:default", startSequence: 4, endSequence: 4 }
  ],
  createdAt: "2024-05-04T12:50:00.000Z",
  updatedAt: "2024-05-04T12:50:00.000Z",
  lastActivityAt: "2024-05-04T12:50:00.000Z",
  confidence: 0.9,
  rationale: "Recurring provider bill issue.",
  ...overrides
});

const injection = (overrides: Partial<InjectionPacket> = {}): InjectionPacket => ({
  id: "inject_1",
  hostSessionId: "profile:default",
  currentTopicSummary: "Smith PIP",
  selectedMemory: "Smith PIP demand timing.",
  sourceSummaryIds: ["summary_smith_pip"],
  sourceTraceIds: [],
  sourceTurnRanges: [{ threadId: "profile:default", startSequence: 1, endSequence: 2 }],
  boxIds: ["box_smith"],
  relevanceReason: "Top summary match.",
  confidence: 0.9,
  disclosureText: "Retrieved memory.",
  createdAt: "2024-05-04T13:00:00.000Z",
  ...overrides
});

describe("Hermes resume command", () => {
  it("expands a summary id into verbatim turns and a resume context block", async () => {
    const dir = await makeTempDir();
    const databasePath = join(dir, "memory.sqlite");
    const store = new SqliteStore(databasePath);
    await store.saveTurn(turn());
    await store.saveTurn(turn({
      id: "turn_2",
      sequence: 2,
      role: "assistant",
      content: "The Smith PIP demand deadline is June 1.",
      provenance: "assistant_output",
      trustLevel: "medium",
      contentHash: "hash_2"
    }));
    await store.saveSummary(summary());
    store.close();

    const result = await resumeHermesMemory({
      databasePath,
      input: JSON.stringify({ summary_id: "summary_smith_pip" })
    });

    expect(result.ok).toBe(true);
    expect(result.turnCount).toBe(2);
    expect(result.turns.map((sourceTurn) => sourceTurn.content)).toEqual([
      "Let's talk about Smith PIP.",
      "The Smith PIP demand deadline is June 1."
    ]);
    expect(result.contextBlock).toContain("<memory-resume>");
    expect(result.contextBlock).toContain("[USER]: Let's talk about Smith PIP.");
    expect(result.contextBlock).toContain("[ASSISTANT]: The Smith PIP demand deadline is June 1.");
    expect(result.contextBlock).toContain("</memory-resume>");
  });

  it("expands an injection packet into verbatim turns", async () => {
    const dir = await makeTempDir();
    const databasePath = join(dir, "memory.sqlite");
    const store = new SqliteStore(databasePath);
    await store.saveTurn(turn());
    await store.saveTurn(turn({ id: "turn_2", sequence: 2, content: "Second turn." }));
    store.close();

    const result = await resumeHermesMemory({
      databasePath,
      input: JSON.stringify({ injection_packet: injection() })
    });

    expect(result.sourceSummaryIds).toEqual(["summary_smith_pip"]);
    expect(result.turnCount).toBe(2);
    expect(result.contextBlock).toContain("Expanded 1 summary into 2 verbatim turns.");
  });

  it("expands a trace id into verbatim turns", async () => {
    const dir = await makeTempDir();
    const databasePath = join(dir, "memory.sqlite");
    const store = new SqliteStore(databasePath);
    await store.saveTurn(turn());
    await store.saveTurn(turn({ id: "turn_2", sequence: 2, role: "assistant", content: "Second turn." }));
    await store.saveTurn(turn({ id: "turn_4", sequence: 4, content: "Provider bill ledger arrived." }));
    await store.saveTrace(trace());
    store.close();

    const result = await resumeHermesMemory({
      databasePath,
      input: JSON.stringify({ trace_id: "trace_smith_pip_provider_bills" })
    });

    expect(result.sourceTraceIds).toEqual(["trace_smith_pip_provider_bills"]);
    expect(result.sourceBoxIds).toEqual(["box_smith_pip"]);
    expect(result.turns.map((sourceTurn) => sourceTurn.id)).toEqual(["turn_1", "turn_2", "turn_4"]);
    expect(result.contextBlock).toContain("Expanded trace trace_smith_pip_provider_bills into 3 verbatim turns.");
  });

  it("expands a box id with explicit child inclusion and range cap", async () => {
    const dir = await makeTempDir();
    const databasePath = join(dir, "memory.sqlite");
    const store = new SqliteStore(databasePath);
    await store.saveTurn(turn());
    await store.saveTurn(turn({ id: "turn_2", sequence: 2, role: "assistant", content: "Second turn." }));
    await store.saveTurn(turn({ id: "turn_3", sequence: 3, content: "Child box turn." }));
    await store.saveBox(box({
      childBoxIds: ["box_child"],
      turnRanges: [{ threadId: "profile:default", startSequence: 1, endSequence: 1 }]
    }));
    await store.saveBox(box({
      id: "box_child",
      parentBoxId: "box_smith_pip",
      summaryIds: ["summary_child"],
      turnRanges: [
        { threadId: "profile:default", startSequence: 2, endSequence: 2 },
        { threadId: "profile:default", startSequence: 3, endSequence: 3 }
      ]
    }));
    store.close();

    const result = await resumeHermesMemory({
      databasePath,
      input: JSON.stringify({
        box_id: "box_smith_pip",
        include_child_boxes: true,
        max_turn_ranges: 2
      })
    });

    expect(result.sourceBoxIds).toEqual(["box_smith_pip", "box_child"]);
    expect(result.turns.map((sourceTurn) => sourceTurn.id)).toEqual(["turn_1", "turn_2"]);
    expect(result.contextBlock).toContain("Omitted 1 additional source range due to the resume range cap.");
  });

  it("rejects requests with multiple resume targets", async () => {
    const dir = await makeTempDir();
    const databasePath = join(dir, "memory.sqlite");

    await expect(resumeHermesMemory({
      databasePath,
      input: JSON.stringify({
        summary_id: "summary_smith_pip",
        trace_id: "trace_smith_pip_provider_bills"
      })
    })).rejects.toThrow("Provide exactly one of summary_id, trace_id, box_id, or injection_packet.");
  });
});
