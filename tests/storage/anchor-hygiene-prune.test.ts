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
import {
  CommitUnhygienicAnchorPruneInputSchema,
  type CommitUnhygienicAnchorPruneInput,
  type UnhygienicAnchorPruneReceipt
} from "../../src/storage/mcp-mutation-contracts.js";
import { HYGIENE_RULE_VERSION } from "../../src/topic/derivation-hygiene.js";

// `commitUnhygienicAnchorPrune` is declared here, not on `MemoryStore`, until Task 2 adds it to
// the interface -- this keeps the RED suite (Task 1) type-checking clean while the store methods
// genuinely do not exist yet (they fail at runtime with "is not a function", not a compile error).
type StoreUnderTest = MemoryStore & {
  commitUnhygienicAnchorPrune(input: CommitUnhygienicAnchorPruneInput): Promise<UnhygienicAnchorPruneReceipt>;
};

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
  occurredAt: "2026-07-27T10:00:00.000Z",
  importedAt: "2026-07-27T10:00:00.000Z",
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
  createdAt: "2026-07-27T10:00:00.000Z",
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
  content: "Fixture conversational anchor content, because it matters.",
  embedding: null,
  createdAt: "2026-07-27T10:00:00.000Z",
  trustLevel: "high",
  source: "direct_user_input",
  ...overrides
});

const makeSummary = (overrides: Partial<Summary> = {}): Summary => ({
  id: "summary_1",
  personId: "person_1",
  scopeIds: ["personal"],
  summaryText: "Fixture summary text for anchor-hygiene-prune control counts.",
  sourceTurnRanges: [{ threadId: "session_1", startSequence: 1, endSequence: 2 }],
  sourceCanonicalEventIds: [],
  sourceSummaryIds: [],
  boxIds: [],
  embedding: null,
  createdAt: "2026-07-27T10:00:00.000Z",
  model: "test-summarizer",
  promptVersion: "v1",
  confidence: 0.9,
  state: "active",
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
  description: "Fixture box for anchor-hygiene-prune control counts",
  parentBoxId: null,
  childBoxIds: [],
  summaryIds: [],
  turnRanges: [{ threadId: "session_1", startSequence: 1, endSequence: 2 }],
  state: "active",
  createdAt: "2026-07-27T10:00:00.000Z",
  updatedAt: "2026-07-27T10:00:00.000Z",
  caseId: null,
  boxType: "general",
  summary: "Fixture box summary",
  lastActivityAt: "2026-07-27T10:00:00.000Z",
  ...overrides
});

const makeTrace = (overrides: Partial<MemoryTrace> = {}): MemoryTrace => ({
  id: "trace_1",
  personId: "person_1",
  title: "Fixture trace",
  description: "Fixture trace for anchor-hygiene-prune control counts",
  traceType: "case_issue",
  state: "approved",
  summaryIds: ["summary_a", "summary_b"],
  boxIds: [],
  turnRanges: [{ threadId: "session_1", startSequence: 1, endSequence: 2 }],
  createdAt: "2026-07-27T10:00:00.000Z",
  updatedAt: "2026-07-27T10:00:00.000Z",
  lastActivityAt: "2026-07-27T10:00:00.000Z",
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
  rationale: "Fixture rationale for anchor-hygiene-prune control counts",
  confidence: 0.7,
  createdAt: "2026-07-27T10:00:00.000Z",
  reviewedAt: "2026-07-27T10:00:00.000Z",
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
  createdAt: "2026-07-27T10:00:00.000Z",
  ...overrides
});

const pruneInput = (overrides: Partial<{
  personId: string;
  anchorIds: string[];
  requestedAt: string;
}> = {}) =>
  CommitUnhygienicAnchorPruneInputSchema.parse({
    operation: "unhygienic_anchor_prune",
    personId: "person_1",
    anchorIds: ["anchor_1"],
    requestedAt: "2026-07-27T10:05:00.000Z",
    ...overrides
  });

const backends: Array<{
  name: string;
  create: (faultInjector?: FaultInjector) => Promise<{ store: StoreUnderTest; cleanup(): Promise<void> }>;
}> = [
  {
    name: "InMemoryStore",
    create: async (faultInjector) => {
      const store = new InMemoryStore({ faultInjector, clock: { now: () => "2026-07-27T10:05:00.000Z" } });
      return { store: store as unknown as StoreUnderTest, cleanup: async () => {} };
    }
  },
  {
    name: "SqliteStore",
    create: async (faultInjector) => {
      const tempDir = await mkdtemp(join(tmpdir(), "anchor-hygiene-prune-"));
      const databasePath = join(tempDir, "memory.db");
      const store = new SqliteStore(databasePath, { faultInjector, clock: { now: () => "2026-07-27T10:05:00.000Z" } });
      return {
        store: store as unknown as StoreUnderTest,
        cleanup: async () => {
          store.close();
          await rm(tempDir, { force: true, recursive: true });
        }
      };
    }
  }
];

// Control rows every case seeds so before/after equality (case j) has something to prove.
const seedControls = async (store: MemoryStore): Promise<void> => {
  await store.saveCanonicalEvent(makeCanonicalEvent({ id: "control_event" }));
  await store.saveTurn(makeTurn({ id: "control_turn" }));
  await store.saveSummary(makeSummary({ id: "control_summary" }));
  await store.saveBox(makeBox({ id: "control_box" }));
  await store.saveTrace(makeTrace({ id: "control_trace" }));
  await store.saveProposal(makeProposal({
    id: "control_proposal",
    sourceSummaryIds: ["control_summary"],
    payload: {
      boxId: "box_from_control_proposal",
      title: "Fixture proposal box",
      description: "",
      summary: "Fixture proposal box summary",
      boxType: "general",
      candidateParentBoxId: null,
      keywords: [],
      evidence: [],
      sourceSummaryIds: ["control_summary"],
      sourceTurnRanges: [{ threadId: "session_1", startSequence: 1, endSequence: 2 }]
    }
  }));
  await store.saveInjection(makeInjection({ id: "control_injection" }));
};

interface ControlCounts {
  events: number;
  turns: number;
  summaries: number;
  boxes: number;
  traces: number;
  proposals: number;
  injections: number;
}

const readControlCounts = async (store: MemoryStore): Promise<ControlCounts> => ({
  events: (await store.listCanonicalEvents("person_1")).length,
  turns: (await store.listTurns("session_1")).length,
  summaries: (await store.listSummaries()).length,
  boxes: (await store.listBoxes()).length,
  traces: (await store.listTraces()).length,
  proposals: (await store.listProposals()).length,
  injections: (await store.listInjections("session_1")).length
});

for (const backend of backends) {
  describe(`${backend.name} commitUnhygienicAnchorPrune`, () => {
    let store: StoreUnderTest;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      const created = await backend.create();
      store = created.store;
      cleanup = created.cleanup;
    });

    afterEach(async () => {
      await cleanup();
    });

    it("(a) prunes a [Tool call: ...] anchor", async () => {
      await seedControls(store);
      await store.saveAnchor(makeAnchor({
        id: "anchor_1",
        content: '[Tool call: Write] {"file_path":"/tmp/foo.ts","content":"..."}'
      }));

      const receipt = await store.commitUnhygienicAnchorPrune(pruneInput());

      expect(receipt.prunedAnchorIds).toEqual(["anchor_1"]);
      expect(receipt.prunedByClass.tool_activity).toBe(1);
      expect(receipt.prunedByClass.synthetic_injected).toBe(0);
      expect(receipt.freedPayloadBytes).toBeGreaterThan(0);
      expect(receipt.ruleVersion).toBe(HYGIENE_RULE_VERSION);
      expect(receipt.skipped).toEqual([]);

      const remaining = await store.listAnchors();
      expect(remaining.map((anchor) => anchor.id)).not.toContain("anchor_1");
    });

    it("(a) prunes a [SYSTEM: ...] anchor", async () => {
      await seedControls(store);
      await store.saveAnchor(makeAnchor({ id: "anchor_1", content: "[SYSTEM: background reminder text]" }));

      const receipt = await store.commitUnhygienicAnchorPrune(pruneInput());

      expect(receipt.prunedAnchorIds).toEqual(["anchor_1"]);
      expect(receipt.prunedByClass.synthetic_injected).toBe(1);
      expect(receipt.prunedByClass.tool_activity).toBe(0);
      const remaining = await store.listAnchors();
      expect(remaining.map((anchor) => anchor.id)).not.toContain("anchor_1");
    });

    it("retains an ordinary conversational anchor with reason retained_conversational", async () => {
      await seedControls(store);
      await store.saveAnchor(makeAnchor({ id: "anchor_1", content: "We decided to ship the fix because it is safe." }));

      const receipt = await store.commitUnhygienicAnchorPrune(pruneInput());

      expect(receipt.prunedAnchorIds).toEqual([]);
      expect(receipt.skipped).toEqual([{ anchorId: "anchor_1", reason: "retained_conversational" }]);
      const remaining = await store.listAnchors();
      expect(remaining.map((anchor) => anchor.id)).toContain("anchor_1");
    });

    it("(d) retains a conversational anchor even when its id is explicitly passed by the caller", async () => {
      await seedControls(store);
      await store.saveAnchor(makeAnchor({ id: "anchor_1", content: "A genuinely conversational fact worth keeping." }));

      const receipt = await store.commitUnhygienicAnchorPrune(pruneInput({ anchorIds: ["anchor_1"] }));

      expect(receipt.prunedAnchorIds).toEqual([]);
      expect(receipt.skipped).toEqual([{ anchorId: "anchor_1", reason: "retained_conversational" }]);
      const remaining = await store.listAnchors();
      expect(remaining.map((anchor) => anchor.id)).toContain("anchor_1");
    });

    it("prunes an anchor whose content is innocuous prose but whose canonical event has role: tool", async () => {
      await seedControls(store);
      await store.saveCanonicalEvent(makeCanonicalEvent({ id: "event_tool_role", role: "tool" }));
      await store.saveAnchor(makeAnchor({
        id: "anchor_1",
        canonicalEventId: "event_tool_role",
        content: "This looks like ordinary decision prose but the event says otherwise."
      }));

      const receipt = await store.commitUnhygienicAnchorPrune(pruneInput());

      expect(receipt.prunedAnchorIds).toEqual(["anchor_1"]);
      expect(receipt.prunedByClass.tool_activity).toBe(1);
    });

    it("prunes an anchor whose canonical event has eventKind: tool_call (role/eventKind enrichment)", async () => {
      await seedControls(store);
      await store.saveCanonicalEvent(makeCanonicalEvent({ id: "event_tool_kind", role: "assistant", eventKind: "tool_call" }));
      await store.saveAnchor(makeAnchor({
        id: "anchor_1",
        canonicalEventId: "event_tool_kind",
        content: "Innocuous prose that would otherwise stay conversational."
      }));

      const receipt = await store.commitUnhygienicAnchorPrune(pruneInput());

      expect(receipt.prunedAnchorIds).toEqual(["anchor_1"]);
      expect(receipt.prunedByClass.tool_activity).toBe(1);
    });

    it("prunes an assistant-role [SILENT] anchor via the role-gated silent-sentinel rule", async () => {
      await seedControls(store);
      await store.saveCanonicalEvent(makeCanonicalEvent({ id: "event_silent", role: "assistant" }));
      await store.saveAnchor(makeAnchor({
        id: "anchor_1",
        canonicalEventId: "event_silent",
        content: "[SILENT] internal bookkeeping note"
      }));

      const receipt = await store.commitUnhygienicAnchorPrune(pruneInput());

      expect(receipt.prunedAnchorIds).toEqual(["anchor_1"]);
      expect(receipt.prunedByClass.synthetic_injected).toBe(1);
    });

    it("does not prune a [SILENT] anchor whose canonical event role is not assistant (content-only cannot fire it)", async () => {
      await seedControls(store);
      await store.saveCanonicalEvent(makeCanonicalEvent({ id: "event_user_silent", role: "user" }));
      await store.saveAnchor(makeAnchor({
        id: "anchor_1",
        canonicalEventId: "event_user_silent",
        content: "[SILENT] this looks like the rule but the role does not match"
      }));

      const receipt = await store.commitUnhygienicAnchorPrune(pruneInput());

      expect(receipt.prunedAnchorIds).toEqual([]);
      expect(receipt.skipped).toEqual([{ anchorId: "anchor_1", reason: "retained_conversational" }]);
    });

    it("retains an anchor whose canonicalEventId does not resolve, falling back to content-only classification", async () => {
      await seedControls(store);
      await store.saveAnchor(makeAnchor({
        id: "anchor_1",
        canonicalEventId: "event_does_not_exist",
        content: "Ordinary conversational content with a dangling event reference."
      }));

      const receipt = await store.commitUnhygienicAnchorPrune(pruneInput());

      expect(receipt.prunedAnchorIds).toEqual([]);
      expect(receipt.skipped).toEqual([{ anchorId: "anchor_1", reason: "retained_conversational" }]);
    });

    it("(f) skips an anchor with a different personId as person_mismatch, row survives", async () => {
      await seedControls(store);
      await store.saveAnchor(makeAnchor({ id: "anchor_1", personId: "person_2", content: "[Tool call: Write] {}" }));

      const receipt = await store.commitUnhygienicAnchorPrune(pruneInput({ personId: "person_1", anchorIds: ["anchor_1"] }));

      expect(receipt.prunedAnchorIds).toEqual([]);
      expect(receipt.skipped).toEqual([{ anchorId: "anchor_1", reason: "person_mismatch" }]);
      const remaining = await store.listAnchors();
      expect(remaining.map((anchor) => anchor.id)).toContain("anchor_1");
    });

    it("(f) skips an anchor with no personId as person_unattributed, row survives", async () => {
      await seedControls(store);
      const anchorWithoutPerson: Anchor = makeAnchor({ content: "[Tool call: Write] {}" });
      delete (anchorWithoutPerson as { personId?: string }).personId;
      await store.saveAnchor(anchorWithoutPerson);

      const receipt = await store.commitUnhygienicAnchorPrune(pruneInput());

      expect(receipt.prunedAnchorIds).toEqual([]);
      expect(receipt.skipped).toEqual([{ anchorId: "anchor_1", reason: "person_unattributed" }]);
      const remaining = await store.listAnchors();
      expect(remaining.map((anchor) => anchor.id)).toContain("anchor_1");
    });

    it("(j) never touches canonical events, turns, summaries, boxes, traces, proposals, or injections", async () => {
      await seedControls(store);
      await store.saveAnchor(makeAnchor({ id: "anchor_1", content: "[Tool call: Write] {}" }));

      const before = await readControlCounts(store);
      await store.commitUnhygienicAnchorPrune(pruneInput());
      const after = await readControlCounts(store);

      expect(after).toEqual(before);
    });

    it("(k) is idempotent: a second commit over the same ids prunes nothing and reports not_found", async () => {
      await seedControls(store);
      await store.saveAnchor(makeAnchor({ id: "anchor_1", content: "[Tool call: Write] {}" }));

      const first = await store.commitUnhygienicAnchorPrune(pruneInput());
      expect(first.prunedAnchorIds).toEqual(["anchor_1"]);

      const second = await store.commitUnhygienicAnchorPrune(pruneInput());
      expect(second.prunedAnchorIds).toEqual([]);
      expect(second.skipped).toEqual([{ anchorId: "anchor_1", reason: "not_found" }]);
    });

    it("(l) a fault injected at anchor_hygiene_prune_before_write leaves the store unchanged", async () => {
      const faultInjector = createFaultInjector();
      const created = await backend.create(faultInjector);
      store = created.store;
      cleanup = created.cleanup;
      await seedControls(store);
      await store.saveAnchor(makeAnchor({ id: "anchor_1", content: "[Tool call: Write] {}" }));

      const before = await readControlCounts(store);
      const anchorsBefore = await store.listAnchors();

      faultInjector.failAt("anchor_hygiene_prune_before_write");
      await expect(store.commitUnhygienicAnchorPrune(pruneInput())).rejects.toThrow();

      const after = await readControlCounts(store);
      const anchorsAfter = await store.listAnchors();
      expect(after).toEqual(before);
      expect(anchorsAfter).toEqual(anchorsBefore);
    });
  });
}
