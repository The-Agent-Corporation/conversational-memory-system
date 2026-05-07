import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InjectionPacket, Summary, Turn } from "../../src/domain/types.js";
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
});
