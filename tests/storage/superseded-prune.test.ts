import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";
import type { MemoryStore } from "../../src/storage/memory-store.js";
import type {
  Anchor,
  Box,
  InjectionPacket,
  MemoryProposal,
  MemoryTrace,
  Summary,
  Turn
} from "../../src/domain/types.js";
import type { CanonicalEvent } from "../../src/domain/canonical.js";
import { CommitSupersededSummaryPruneInputSchema } from "../../src/storage/mcp-mutation-contracts.js";

interface FaultInjector {
  failAt(boundary: string | null): void;
  reach(boundary: string): void;
}

const createFaultInjector = (): FaultInjector => {
  let failBoundary: string | null = null;
  return {
    failAt(boundary) {
      failBoundary = boundary;
    },
    reach(boundary) {
      if (boundary === failBoundary) {
        throw new Error(`Injected fault at ${boundary}`);
      }
    }
  };
};

const makeSummary = (overrides: Partial<Summary> = {}): Summary => ({
  id: "summary_1",
  personId: "person_1",
  scopeIds: ["personal"],
  summaryText: "Fixture summary text for superseded-prune tests.",
  sourceTurnRanges: [{ threadId: "session_1", startSequence: 1, endSequence: 2 }],
  sourceCanonicalEventIds: [],
  sourceSummaryIds: [],
  boxIds: [],
  embedding: null,
  createdAt: "2026-07-26T10:00:00.000Z",
  model: "test-summarizer",
  promptVersion: "v1",
  confidence: 0.9,
  state: "superseded",
  detailLevel: "brief",
  tokenCount: 12,
  lastAccessedAt: null,
  version: 1,
  strength: 0.8,
  retrievalCount: 0,
  retrievedAt: null,
  halfLifeHours: 168,
  outcomeScore: null,
  ...overrides
});

const makeBox = (overrides: Partial<Box> = {}): Box => ({
  id: "box_1",
  personId: "person_1",
  title: "Fixture box",
  description: "Fixture box for superseded-prune tests",
  parentBoxId: null,
  childBoxIds: [],
  summaryIds: [],
  turnRanges: [{ threadId: "session_1", startSequence: 1, endSequence: 2 }],
  state: "active",
  createdAt: "2026-07-26T10:00:00.000Z",
  updatedAt: "2026-07-26T10:00:00.000Z",
  caseId: null,
  boxType: "general",
  summary: "Fixture box summary",
  lastActivityAt: "2026-07-26T10:00:00.000Z",
  ...overrides
});

const makeTrace = (overrides: Partial<MemoryTrace> = {}): MemoryTrace => ({
  id: "trace_1",
  personId: "person_1",
  title: "Fixture trace",
  description: "Fixture trace for superseded-prune tests",
  traceType: "case_issue",
  state: "approved",
  summaryIds: [],
  boxIds: [],
  turnRanges: [{ threadId: "session_1", startSequence: 1, endSequence: 2 }],
  createdAt: "2026-07-26T10:00:00.000Z",
  updatedAt: "2026-07-26T10:00:00.000Z",
  lastActivityAt: "2026-07-26T10:00:00.000Z",
  confidence: 0.8,
  rationale: "Fixture rationale",
  ...overrides
});

const makeProposal = (overrides: Partial<MemoryProposal> = {}): MemoryProposal => ({
  id: "proposal_1",
  personId: "person_1",
  proposalType: "box",
  state: "proposed",
  title: "Fixture proposal",
  rationale: "Fixture rationale for superseded-prune tests",
  confidence: 0.7,
  createdAt: "2026-07-26T10:00:00.000Z",
  reviewedAt: "2026-07-26T10:00:00.000Z",
  decidedAt: null,
  decidedBy: null,
  decisionNote: null,
  sourceSummaryIds: [],
  sourceTurnRanges: [{ threadId: "session_1", startSequence: 1, endSequence: 2 }],
  targetBoxIds: [],
  targetTraceIds: [],
  payload: {
    boxId: "box_from_proposal",
    title: "Fixture proposal box",
    description: "",
    summary: "Fixture proposal box summary",
    boxType: "general",
    candidateParentBoxId: null,
    keywords: [],
    evidence: [],
    sourceSummaryIds: [],
    sourceTurnRanges: [{ threadId: "session_1", startSequence: 1, endSequence: 2 }]
  },
  ...overrides
});

const makeInjection = (overrides: Partial<InjectionPacket> = {}): InjectionPacket => ({
  id: "injection_1",
  personId: "person_1",
  allowedScopeIds: ["personal"],
  hostSessionId: "session_1",
  currentTopicSummary: "Fixture topic",
  selectedMemory: "Fixture memory text",
  sourceSummaryIds: [],
  sourceTraceIds: [],
  sourceTurnRanges: [{ threadId: "session_1", startSequence: 1, endSequence: 2 }],
  boxIds: [],
  relevanceReason: "Fixture relevance",
  confidence: 0.8,
  disclosureText: "Fixture disclosure",
  createdAt: "2026-07-26T10:00:00.000Z",
  ...overrides
});

const makeCanonicalEvent = (overrides: Partial<CanonicalEvent> = {}): CanonicalEvent => ({
  id: "event_1",
  personId: "person_1",
  sourceId: "source_1",
  sourceApplication: "codex",
  sourceProfileId: "default",
  nativeSessionId: "session_1",
  nativeEventId: "native_1",
  nativeSequence: 1,
  causalParentId: null,
  role: "user",
  content: "Fixture canonical event content.",
  occurredAt: "2026-07-26T10:00:00.000Z",
  importedAt: "2026-07-26T10:00:00.000Z",
  provenance: "direct_user_input",
  trustLevel: "high",
  contentHash: "hash_event_1",
  parserVersion: "codex-jsonl/v1",
  metadata: {},
  ...overrides
});

const makeTurn = (overrides: Partial<Turn> = {}): Turn => ({
  id: "turn_1",
  threadId: "session_1",
  sequence: 1,
  role: "user",
  content: "Fixture turn content.",
  createdAt: "2026-07-26T10:00:00.000Z",
  provenance: "direct_user_input",
  trustLevel: "high",
  metadata: {},
  contentHash: "hash_turn_1",
  ...overrides
});

const makeAnchor = (overrides: Partial<Anchor> = {}): Anchor => ({
  id: "anchor_1",
  personId: "person_1",
  turnId: "turn_1",
  threadId: "session_1",
  boxId: null,
  anchorType: "key_fact",
  content: "Fixture anchor content.",
  embedding: null,
  createdAt: "2026-07-26T10:00:00.000Z",
  trustLevel: "high",
  source: "direct_user_input",
  ...overrides
});

const pruneInput = (overrides: Partial<{
  personId: string;
  summaryIds: string[];
  requestedAt: string;
}> = {}) =>
  CommitSupersededSummaryPruneInputSchema.parse({
    operation: "superseded_summary_prune",
    personId: "person_1",
    summaryIds: ["summary_1"],
    requestedAt: "2026-07-26T10:05:00.000Z",
    ...overrides
  });

const backends: Array<{
  name: string;
  create: (faultInjector?: FaultInjector) => Promise<{ store: MemoryStore; cleanup(): Promise<void> }>;
}> = [
  {
    name: "InMemoryStore",
    create: async (faultInjector) => {
      const store = new InMemoryStore({ faultInjector, clock: { now: () => "2026-07-26T10:05:00.000Z" } });
      return { store, cleanup: async () => {} };
    }
  },
  {
    name: "SqliteStore",
    create: async (faultInjector) => {
      const tempDir = await mkdtemp(join(tmpdir(), "superseded-prune-"));
      const databasePath = join(tempDir, "memory.db");
      const store = new SqliteStore(databasePath, { faultInjector, clock: { now: () => "2026-07-26T10:05:00.000Z" } });
      return {
        store,
        cleanup: async () => {
          store.close();
          await rm(tempDir, { force: true, recursive: true });
        }
      };
    }
  }
];

for (const backend of backends) {
  describe(`${backend.name} commitSupersededSummaryPrune`, () => {
    let store: MemoryStore;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      const created = await backend.create();
      store = created.store;
      cleanup = created.cleanup;
    });

    afterEach(async () => {
      await cleanup();
    });

    it("(a) prunes an unreferenced superseded summary along with its vectors and injections", async () => {
      await store.saveSummary(makeSummary({ id: "summary_1", state: "superseded" }));
      await store.saveSummaryVector({
        summaryId: "summary_1",
        provider: "deterministic",
        model: "hash-v1",
        dimensions: 2,
        vector: [0.1, 0.2],
        personId: "person_1",
        scopeIds: ["personal"],
        createdAt: "2026-07-26T10:00:00.000Z"
      });
      await store.saveSummaryVector({
        summaryId: "summary_1",
        provider: "deterministic",
        model: "hash-v2",
        dimensions: 2,
        vector: [0.3, 0.4],
        personId: "person_1",
        scopeIds: ["personal"],
        createdAt: "2026-07-26T10:00:00.000Z"
      });
      await store.saveInjection(makeInjection({ id: "injection_1", sourceSummaryIds: ["summary_1"] }));

      const receipt = await store.commitSupersededSummaryPrune(pruneInput());

      expect(receipt.prunedSummaryIds).toEqual(["summary_1"]);
      expect(receipt.deletedVectorRows).toBe(2);
      expect(receipt.deletedInjectionIds).toEqual(["injection_1"]);
      expect(receipt.freedPayloadBytes).toBeGreaterThan(0);
      expect(receipt.skipped).toEqual([]);

      const remaining = await store.listSummaries();
      expect(remaining.map((summary) => summary.id)).not.toContain("summary_1");
      expect(await store.getSummaryVector("summary_1", "deterministic", "hash-v1")).toBeNull();
      expect(await store.getSummaryVector("summary_1", "deterministic", "hash-v2")).toBeNull();
      expect(await store.listInjections("session_1")).toEqual([]);
    });

    it("(b) refuses a summary referenced by a box, still exists afterward", async () => {
      await store.saveSummary(makeSummary({ id: "summary_1", state: "superseded" }));
      await store.saveBox(makeBox({ id: "box_1", summaryIds: ["summary_1"] }));

      const receipt = await store.commitSupersededSummaryPrune(pruneInput());

      expect(receipt.prunedSummaryIds).toEqual([]);
      expect(receipt.skipped).toEqual([{ summaryId: "summary_1", reason: "referenced_by_box" }]);
      const remaining = await store.listSummaries();
      expect(remaining.map((summary) => summary.id)).toContain("summary_1");
    });

    it("(b) refuses a summary referenced by an approved trace, still exists afterward", async () => {
      await store.saveSummary(makeSummary({ id: "summary_1", state: "superseded" }));
      await store.saveTrace(makeTrace({ id: "trace_1", state: "approved", summaryIds: ["summary_1", "summary_2"] }));
      await store.saveSummary(makeSummary({ id: "summary_2", state: "superseded" }));

      const receipt = await store.commitSupersededSummaryPrune(pruneInput({ summaryIds: ["summary_1"] }));

      expect(receipt.prunedSummaryIds).toEqual([]);
      expect(receipt.skipped).toEqual([{ summaryId: "summary_1", reason: "referenced_by_trace" }]);
      const remaining = await store.listSummaries();
      expect(remaining.map((summary) => summary.id)).toContain("summary_1");
    });

    it("(b) refuses a summary referenced by a proposal, still exists afterward", async () => {
      await store.saveSummary(makeSummary({ id: "summary_1", state: "superseded" }));
      await store.saveProposal(makeProposal({
        id: "proposal_1",
        sourceSummaryIds: ["summary_1"],
        payload: {
          boxId: "box_from_proposal",
          title: "Fixture proposal box",
          description: "",
          summary: "Fixture proposal box summary",
          boxType: "general",
          candidateParentBoxId: null,
          keywords: [],
          evidence: [],
          sourceSummaryIds: ["summary_1"],
          sourceTurnRanges: [{ threadId: "session_1", startSequence: 1, endSequence: 2 }]
        }
      }));

      const receipt = await store.commitSupersededSummaryPrune(pruneInput());

      expect(receipt.prunedSummaryIds).toEqual([]);
      expect(receipt.skipped).toEqual([{ summaryId: "summary_1", reason: "referenced_by_proposal" }]);
      const remaining = await store.listSummaries();
      expect(remaining.map((summary) => summary.id)).toContain("summary_1");
    });

    it("(b) refuses a summary referenced by another summary's sourceSummaryIds, still exists afterward", async () => {
      await store.saveSummary(makeSummary({ id: "summary_1", state: "superseded" }));
      await store.saveSummary(makeSummary({ id: "summary_2", state: "active", sourceSummaryIds: ["summary_1"] }));

      const receipt = await store.commitSupersededSummaryPrune(pruneInput());

      expect(receipt.prunedSummaryIds).toEqual([]);
      expect(receipt.skipped).toEqual([{ summaryId: "summary_1", reason: "referenced_by_summary" }]);
      const remaining = await store.listSummaries();
      expect(remaining.map((summary) => summary.id)).toContain("summary_1");
    });

    it("(c) refuses a non-superseded summary, never deleted", async () => {
      await store.saveSummary(makeSummary({ id: "summary_1", state: "active" }));

      const receipt = await store.commitSupersededSummaryPrune(pruneInput());

      expect(receipt.prunedSummaryIds).toEqual([]);
      expect(receipt.skipped).toEqual([{ summaryId: "summary_1", reason: "not_superseded" }]);
      const remaining = await store.listSummaries();
      expect(remaining.map((summary) => summary.id)).toContain("summary_1");
    });

    it("(d) refuses a cross-person id", async () => {
      await store.saveSummary(makeSummary({ id: "summary_1", personId: "person_2", state: "superseded" }));

      const receipt = await store.commitSupersededSummaryPrune(pruneInput({ personId: "person_1", summaryIds: ["summary_1"] }));

      expect(receipt.prunedSummaryIds).toEqual([]);
      expect(receipt.skipped).toEqual([{ summaryId: "summary_1", reason: "person_mismatch" }]);
      const remaining = await store.listSummaries();
      expect(remaining.map((summary) => summary.id)).toContain("summary_1");
    });

    it("(f) is idempotent: committing the same id twice reports zero pruned the second time", async () => {
      await store.saveSummary(makeSummary({ id: "summary_1", state: "superseded" }));

      const first = await store.commitSupersededSummaryPrune(pruneInput());
      expect(first.prunedSummaryIds).toEqual(["summary_1"]);

      const second = await store.commitSupersededSummaryPrune(pruneInput());
      expect(second.prunedSummaryIds).toEqual([]);
      expect(second.skipped).toEqual([{ summaryId: "summary_1", reason: "not_found" }]);
    });

    it("(g) never touches canonical events, turns, or anchors, and a surviving summary in the same window is untouched", async () => {
      await store.saveCanonicalEvent(makeCanonicalEvent({ id: "event_1" }));
      await store.saveTurn(makeTurn({ id: "turn_1" }));
      await store.saveAnchor(makeAnchor({ id: "anchor_1" }));
      await store.saveSummary(makeSummary({ id: "summary_1", state: "superseded", sourceCanonicalEventIds: ["event_1"] }));
      await store.saveSummary(makeSummary({ id: "summary_2", state: "active", sourceCanonicalEventIds: ["event_1"] }));

      const eventsBefore = await store.listCanonicalEvents("person_1");
      const turnsBefore = await store.listTurns("session_1");
      const anchorsBefore = await store.listAnchors();

      await store.commitSupersededSummaryPrune(pruneInput({ summaryIds: ["summary_1"] }));

      const eventsAfter = await store.listCanonicalEvents("person_1");
      const turnsAfter = await store.listTurns("session_1");
      const anchorsAfter = await store.listAnchors();

      expect(eventsAfter.length).toBe(eventsBefore.length);
      expect(turnsAfter.length).toBe(turnsBefore.length);
      expect(anchorsAfter.length).toBe(anchorsBefore.length);

      const remaining = await store.listSummaries();
      expect(remaining.map((summary) => summary.id)).toEqual(["summary_2"]);
    });

    it("(h) listSupersededSummaryIds paginates ascending without overlap or gaps", async () => {
      for (let index = 0; index < 25; index += 1) {
        const id = `summary_${String(index).padStart(2, "0")}`;
        await store.saveSummary(makeSummary({ id, state: "superseded" }));
      }

      const firstPage = await store.listSupersededSummaryIds("person_1", { limit: 10 });
      expect(firstPage).toEqual(Array.from({ length: 10 }, (_, index) => `summary_${String(index).padStart(2, "0")}`));

      const secondPage = await store.listSupersededSummaryIds("person_1", {
        limit: 10,
        afterId: firstPage[firstPage.length - 1]
      });
      expect(secondPage).toEqual(Array.from({ length: 10 }, (_, index) => `summary_${String(index + 10).padStart(2, "0")}`));

      const thirdPage = await store.listSupersededSummaryIds("person_1", {
        limit: 10,
        afterId: secondPage[secondPage.length - 1]
      });
      expect(thirdPage).toEqual(["summary_20", "summary_21", "summary_22", "summary_23", "summary_24"]);

      const allIds = [...firstPage, ...secondPage, ...thirdPage];
      expect(new Set(allIds).size).toBe(25);
    });

    it("(i) summarizeSupersededSummaries reports count and total byte size", async () => {
      const summaries = [
        makeSummary({ id: "summary_a", state: "superseded" }),
        makeSummary({ id: "summary_b", state: "superseded" }),
        makeSummary({ id: "summary_c", state: "active" })
      ];
      for (const summary of summaries) await store.saveSummary(summary);

      const result = await store.summarizeSupersededSummaries("person_1");
      expect(result.count).toBe(2);
      expect(result.payloadBytes).toBeGreaterThan(0);

      const stored = await store.listSummaries({ personId: "person_1", states: ["superseded"] });
      const expectedBytes = stored.reduce((sum, summary) => sum + JSON.stringify(summary).length, 0);
      expect(result.payloadBytes).toBe(expectedBytes);
    });
  });
}

for (const backend of backends) {
  describe(`${backend.name} commitSupersededSummaryPrune atomicity`, () => {
    it("(e) leaves summary, vector, and injection counts unchanged when a fault is injected partway through", async () => {
      const faultInjector = createFaultInjector();
      const created = await backend.create(faultInjector);
      const store = created.store;

      await store.saveSummary(makeSummary({ id: "summary_1", state: "superseded" }));
      await store.saveSummary(makeSummary({ id: "summary_2", state: "superseded" }));
      await store.saveSummaryVector({
        summaryId: "summary_1",
        provider: "deterministic",
        model: "hash-v1",
        dimensions: 2,
        vector: [0.1, 0.2],
        personId: "person_1",
        scopeIds: ["personal"],
        createdAt: "2026-07-26T10:00:00.000Z"
      });
      await store.saveInjection(makeInjection({ id: "injection_1", sourceSummaryIds: ["summary_1"] }));

      faultInjector.failAt("superseded_prune_after_vectors");

      await expect(
        store.commitSupersededSummaryPrune(pruneInput({ summaryIds: ["summary_1", "summary_2"] }))
      ).rejects.toThrow(/Injected fault/);

      const summariesAfter = await store.listSummaries();
      expect(summariesAfter.map((summary) => summary.id).sort()).toEqual(["summary_1", "summary_2"]);
      expect(await store.getSummaryVector("summary_1", "deterministic", "hash-v1")).not.toBeNull();
      expect(await store.listInjections("session_1")).toHaveLength(1);

      await created.cleanup();
    });
  });
}
