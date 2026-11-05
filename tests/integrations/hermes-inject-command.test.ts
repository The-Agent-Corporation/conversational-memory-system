import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { injectHermesMemory } from "../../src/integrations/hermes/inject-command.js";
import { writeHermesMcpProfile } from "../../src/integrations/hermes/profile-file.js";
import type { MemoryTrace, Summary } from "../../src/domain/types.js";
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
  personId: "person_default",
  scopeIds: ["personal"],
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

const trace = (overrides: Partial<MemoryTrace> = {}): MemoryTrace => ({
  id: "trace_smith_pip_provider_bills",
  personId: "person_default",
  title: "Smith PIP Provider Bills",
  description: "Recurring Smith PIP provider bill dispute and no-fault payment timing.",
  traceType: "case_issue",
  state: "approved",
  summaryIds: ["summary_smith_pip", "summary_smith_provider_bill"],
  boxIds: ["box_smith_pip"],
  turnRanges: [
    { threadId: "profile:default", startSequence: 1, endSequence: 2 },
    { threadId: "profile:default", startSequence: 10, endSequence: 12 }
  ],
  createdAt: "2024-05-04T12:50:00.000Z",
  updatedAt: "2024-05-04T12:50:00.000Z",
  lastActivityAt: "2024-05-04T12:50:00.000Z",
  confidence: 0.9,
  rationale: "The provider bill issue recurred across separated turns.",
  ...overrides
});

describe("Hermes inject command", () => {
  it("returns a delimited memory context block for a matching Hermes query", async () => {
    const dir = await makeTempDir();
    const databasePath = join(dir, "memory.sqlite");
    const store = new SqliteStore(databasePath);
    await store.saveSummary(summary());
    await store.saveSummary(summary({
      id: "summary_smith_provider_bill",
      summaryText: "Smith PIP provider bill ledger must be reviewed before demand finalization.",
      sourceTurnRanges: [{ threadId: "profile:default", startSequence: 10, endSequence: 12 }],
      boxIds: ["box_smith_pip"],
      tokenCount: 10
    }));
    await store.saveTrace(trace());
    store.close();

    const profile = await writeHermesMcpProfile({
      directory: dirname(databasePath),
      databasePath,
      personId: "person_default",
      scopeId: "personal"
    });
    const result = await injectHermesMemory({
      configPath: profile.configPath,
      profileName: profile.profileName,
      input: JSON.stringify({
        query: "Smith PIP provider bill ledger",
        requested_at: "2024-05-04T13:00:00.000Z",
        limit: 20
      })
    });

    expect(result.ok).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.packet).toBeNull();
    expect(result.candidates.map((candidate) => candidate.id)).toEqual(expect.arrayContaining([
      "trace_smith_pip_provider_bills",
      "summary_smith_provider_bill"
    ]));
    expect(result.contextBlock).toContain("<memory-context>");
    expect(result.contextBlock).toContain("Smith PIP Provider Bills");
    expect(result.contextBlock).toContain("</memory-context>");
    const readBack = new SqliteStore(databasePath, { readOnly: true });
    try {
      expect(await readBack.listInjections("profile:default")).toEqual([]);
      const summaryRow = (await readBack.listSummaries()).find((item) => item.id === "summary_smith_pip");
      expect(summaryRow?.retrievalCount).toBe(0);
    } finally {
      readBack.close();
    }
  });

  it("returns an empty result when no memory matches", async () => {
    const dir = await makeTempDir();
    const databasePath = join(dir, "memory.sqlite");
    const store = new SqliteStore(databasePath);
    await store.saveSummary(summary());
    store.close();

    const profile = await writeHermesMcpProfile({
      directory: dirname(databasePath),
      databasePath,
      personId: "person_default",
      scopeId: "personal"
    });
    const result = await injectHermesMemory({
      configPath: profile.configPath,
      profileName: profile.profileName,
      input: JSON.stringify({
        query: "unrelated cooking recipe",
        requested_at: "2024-05-04T13:00:00.000Z"
      })
    });

    expect(result.packet).toBeNull();
    expect(result.candidates).toEqual([]);
    expect(result.contextBlock).toBeNull();
  });
});
