import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { injectHermesMemory } from "../../src/integrations/hermes/inject-command.js";
import type { Summary } from "../../src/domain/types.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";

let tempDir: string | null = null;

const makeTempDir = async (): Promise<string> => {
  tempDir = await mkdtemp(join(tmpdir(), "cms-hermes-inject-"));
  return tempDir;
};

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

const summary = (overrides: Partial<Summary> = {}): Summary => ({
  id: "summary_smith_pip",
  summaryText: "Smith PIP demand strategy coverage timing provider bill review wage loss benefits and deadline planning.",
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

describe("Hermes inject command", () => {
  it("returns a delimited memory context block for a matching Hermes query", async () => {
    const dir = await makeTempDir();
    const databasePath = join(dir, "memory.sqlite");
    const store = new SqliteStore(databasePath);
    await store.saveSummary(summary());
    store.close();

    const result = await injectHermesMemory({
      databasePath,
      input: JSON.stringify({
        profile_id: "default",
        session_id: "profile:default",
        query: "Can we resume Smith PIP demand timing?",
        requested_at: "2024-05-04T13:00:00.000Z",
        max_memory_tokens: 50
      })
    });

    expect(result.ok).toBe(true);
    expect(result.packet?.sourceSummaryIds).toEqual(["summary_smith_pip"]);
    expect(result.contextBlock).toContain("<memory-context>");
    expect(result.contextBlock).toContain("Smith PIP demand strategy");
    expect(result.contextBlock).toContain("Top summary match summary_smith_pip");
    expect(result.contextBlock).toContain("</memory-context>");
  });

  it("returns an empty result when no memory matches", async () => {
    const dir = await makeTempDir();
    const databasePath = join(dir, "memory.sqlite");
    const store = new SqliteStore(databasePath);
    await store.saveSummary(summary());
    store.close();

    const result = await injectHermesMemory({
      databasePath,
      input: JSON.stringify({
        profile_id: "default",
        session_id: "profile:default",
        query: "unrelated cooking recipe",
        requested_at: "2024-05-04T13:00:00.000Z"
      })
    });

    expect(result).toEqual({
      ok: true,
      packet: null,
      contextBlock: null
    });
  });
});
