import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../../src/storage/sqlite-store.js";
import type { MemoryStore } from "../../src/storage/memory-store.js";
import { MemoryRetriever } from "../../src/retrieval/memory-retriever.js";
import type { Summary } from "../../src/domain/types.js";
import type { InjectionRequest } from "../../src/service/memory-service.js";

const PERSON = "person_scale";
const OTHER_PERSON = "person_other";

const makeSummary = (overrides: Partial<Summary> = {}): Summary => ({
  id: "summary_0",
  personId: PERSON,
  scopeIds: ["personal"],
  summaryText: "Fixed fixture text for the scale acceptance test.",
  sourceTurnRanges: [],
  sourceSummaryIds: [],
  boxIds: [],
  embedding: null,
  createdAt: "2026-07-21T12:00:00.000Z",
  model: "test-summarizer",
  promptVersion: "v1",
  confidence: 0.9,
  state: "active",
  detailLevel: "brief",
  tokenCount: 10,
  lastAccessedAt: null,
  version: 1,
  strength: 0.8,
  retrievalCount: 0,
  retrievedAt: null,
  halfLifeHours: 168,
  outcomeScore: null,
  ...overrides
});

/** Wraps a real store and counts every Summary object returned across all listSummaries calls. */
function wrapWithSummaryCounter(store: MemoryStore): { store: MemoryStore; totalSummariesReturned: () => number } {
  let total = 0;
  const proxy = new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "listSummaries" && typeof value === "function") {
        return async (...args: unknown[]) => {
          const result = await (value as (...a: unknown[]) => Promise<Summary[]>).apply(target, args);
          total += result.length;
          return result;
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  return { store: proxy, totalSummariesReturned: () => total };
}

describe("MemoryRetriever prepareInjection at scale", () => {
  let tempDir: string;
  let sqlite: SqliteStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "memory-retriever-scale-"));
    const databasePath = join(tempDir, "memory.db");
    sqlite = new SqliteStore(databasePath, { clock: { now: () => "2026-07-21T12:00:00.000Z" } });

    // 19,700 superseded rows (noise, must never be loaded), 100 belonging to a different person,
    // 180 active + 20 stale for the person under test. Deterministic content, no Math.random/Date.now.
    const seeds: Summary[] = [];
    for (let index = 0; index < 19_700; index += 1) {
      seeds.push(
        makeSummary({
          id: `superseded_${index}`,
          personId: PERSON,
          state: "superseded",
          summaryText: `Superseded noise summary number ${index}.`
        })
      );
    }
    for (let index = 0; index < 100; index += 1) {
      seeds.push(
        makeSummary({
          id: `other_person_${index}`,
          personId: OTHER_PERSON,
          state: "active",
          summaryText: `Other person's summary number ${index}.`
        })
      );
    }
    for (let index = 0; index < 180; index += 1) {
      seeds.push(
        makeSummary({
          id: `active_${index}`,
          personId: PERSON,
          state: "active",
          summaryText: `Active candidate summary about the migration project number ${index}.`
        })
      );
    }
    for (let index = 0; index < 20; index += 1) {
      seeds.push(
        makeSummary({
          id: `stale_${index}`,
          personId: PERSON,
          state: "stale",
          summaryText: `Stale candidate summary about the migration project number ${index}.`
        })
      );
    }

    for (const summary of seeds) {
      await sqlite.saveSummary(summary);
    }
  });

  afterEach(async () => {
    sqlite.close();
    await rm(tempDir, { force: true, recursive: true });
  });

  it("loads only candidate-state summaries for the person, not the whole corpus, and stays fast", async () => {
    const { store, totalSummariesReturned } = wrapWithSummaryCounter(sqlite);
    const retriever = new MemoryRetriever(store);

    const request: InjectionRequest = {
      host: "test-host",
      profileId: "default",
      hostSessionId: "session_scale",
      currentTopicSummary: "migration project",
      personId: PERSON,
      allowedScopeIds: ["personal"]
    };

    const started = Date.now();
    let packet = null;
    for (let call = 0; call < 8; call += 1) {
      packet = await retriever.prepareInjection(request);
    }
    const elapsedMs = Date.now() - started;

    expect(packet).not.toBeNull();
    expect(elapsedMs).toBeLessThan(20_000);

    // 180 active + 20 stale = 200 candidates for this person, well under the 400 ceiling asserted
    // as a bound on total Summary objects returned to the retriever across the whole call.
    expect(totalSummariesReturned()).toBeLessThanOrEqual(400 * 8);

    for (const id of packet!.sourceSummaryIds) {
      expect(id.startsWith("superseded_")).toBe(false);
    }
  });
});
