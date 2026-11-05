/**
 * Phase 0 authorization characterization (ADR 0046).
 *
 * Each finding is skipped here so this PR stays green. The skip is removed in
 * Phase 1, which is where the behavior is fixed. These are not expected-fail
 * tests: a later fix does not turn a skip red.
 */
import { expect, it } from "vitest";
import type { Box, InjectionPacket, Summary, Turn } from "../../src/domain/types.js";
import { ConversationResumer, type ResumeResult } from "../../src/resume/conversation-resumer.js";
import type { MemoryStore } from "../../src/storage/memory-store.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";

interface ResumeAuthority {
  personId: string;
  allowedScopeIds: readonly string[];
  hostSessionId?: string;
}

const AUTHORITY: ResumeAuthority = {
  personId: "person_a",
  allowedScopeIds: ["personal"],
  hostSessionId: "session_a"
};

const openResumer = (store: MemoryStore, authority: ResumeAuthority = AUTHORITY): ConversationResumer =>
  new (ConversationResumer as unknown as new (
    store: MemoryStore,
    authority?: ResumeAuthority
  ) => ConversationResumer)(store, authority);

const turn = (overrides: Partial<Turn> = {}): Turn => ({
  id: "turn_1",
  threadId: "session_a",
  sequence: 1,
  role: "user",
  content: "Authorized personal turn.",
  createdAt: "2026-05-04T10:00:00.000Z",
  provenance: "direct_user_input",
  trustLevel: "high",
  metadata: { personId: "person_a", scopeId: "personal" },
  contentHash: "hash_1",
  ...overrides
});

const summary = (overrides: Partial<Summary> = {}): Summary => ({
  id: "summary_a",
  personId: "person_a",
  scopeIds: ["personal"],
  summaryText: "Authorized personal summary.",
  sourceTurnRanges: [{ threadId: "session_a", startSequence: 1, endSequence: 1 }],
  sourceSummaryIds: [],
  boxIds: [],
  embedding: null,
  createdAt: "2026-05-04T10:05:00.000Z",
  model: "test-summarizer",
  promptVersion: "v1",
  confidence: 0.9,
  state: "compacted",
  detailLevel: "brief",
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
  id: "box_parent",
  personId: "person_a",
  title: "Parent box",
  description: "Authorized parent.",
  parentBoxId: null,
  childBoxIds: [],
  summaryIds: ["summary_a"],
  turnRanges: [{ threadId: "session_a", startSequence: 1, endSequence: 1 }],
  state: "approved",
  createdAt: "2026-05-04T10:00:00.000Z",
  updatedAt: "2026-05-04T10:05:00.000Z",
  caseId: null,
  boxType: "topic",
  summary: "Authorized parent.",
  lastActivityAt: "2026-05-04T10:05:00.000Z",
  ...overrides
});

const packet = (overrides: Partial<InjectionPacket> = {}): InjectionPacket => ({
  id: "inject_saved",
  personId: "person_a",
  allowedScopeIds: ["personal"],
  hostSessionId: "session_a",
  currentTopicSummary: "Authorized topic",
  selectedMemory: "Authorized personal summary.",
  sourceSummaryIds: ["summary_a"],
  sourceTraceIds: [],
  sourceTurnRanges: [{ threadId: "session_a", startSequence: 1, endSequence: 1 }],
  boxIds: [],
  relevanceReason: "Saved packet.",
  confidence: 0.9,
  disclosureText: "Retrieved memory.",
  createdAt: "2026-05-04T10:10:00.000Z",
  ...overrides
});

const expectNotFound = async (finding: string, run: () => Promise<unknown>): Promise<void> => {
  try {
    const result = await run();
    expect.fail(`FINDING ${finding}: call returned ${JSON.stringify(result)}; denied must be not found`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("FINDING ")) throw error;
    expect(error, finding).toBeInstanceOf(Error);
    expect((error as Error).message, finding).toMatch(/not found/i);
  }
};

const expectNoSecret = async (
  finding: string,
  secret: string,
  run: () => Promise<ResumeResult>
): Promise<void> => {
  try {
    const result = await run();
    expect(result.turns.map((sourceTurn) => sourceTurn.content), `FINDING ${finding}`).not.toContain(secret);
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message) && !error.message.startsWith("FINDING")) {
      return;
    }
    throw error;
  }
};

// Quarantined. Finding: cross-person resume returns another person's verbatim turns.
// https://github.com/The-Agent-Corporation/conversational-memory-system/pull/21
it.skip("FINDING cross-person resume: another person's summary is not found", async () => {
  const store = new InMemoryStore();
  await store.saveTurn(turn({
    id: "turn_other",
    threadId: "session_b",
    content: "Person B secret turn.",
    metadata: { personId: "person_b", scopeId: "personal" },
    contentHash: "hash_b"
  }));
  await store.saveSummary(summary({
    id: "summary_other",
    personId: "person_b",
    scopeIds: ["personal"],
    summaryText: "Person B secret summary.",
    sourceTurnRanges: [{ threadId: "session_b", startSequence: 1, endSequence: 1 }]
  }));

  await expectNotFound(
    "cross-person resume",
    () => openResumer(store).resumeSummary("summary_other")
  );
});

// Quarantined. Finding: cross-scope resume returns a summary outside the allowed scopes.
// https://github.com/The-Agent-Corporation/conversational-memory-system/pull/21
it.skip("FINDING cross-scope resume: a summary outside the allowed scopes is not found", async () => {
  const store = new InMemoryStore();
  await store.saveTurn(turn({
    id: "turn_secret_scope",
    threadId: "session_secret",
    content: "Same-person client_secret turn.",
    metadata: { personId: "person_a", scopeId: "client_secret" },
    contentHash: "hash_scope"
  }));
  await store.saveSummary(summary({
    id: "summary_secret_scope",
    personId: "person_a",
    scopeIds: ["client_secret"],
    summaryText: "Same-person client_secret summary.",
    sourceTurnRanges: [{ threadId: "session_secret", startSequence: 1, endSequence: 1 }]
  }));

  await expectNotFound(
    "cross-scope resume",
    () => openResumer(store).resumeSummary("summary_secret_scope")
  );
});

// Quarantined. Finding: rejected resume returns a non-retrievable summary.
// Quarantined. Finding: superseded resume returns a non-retrievable summary.
// https://github.com/The-Agent-Corporation/conversational-memory-system/pull/21
it.skip.each(["rejected", "superseded"] as const)(
  "FINDING %s resume: a non-retrievable summary is not found",
  async (state) => {
    const store = new InMemoryStore();
    await store.saveTurn(turn({ content: `${state} summary turn.` }));
    await store.saveSummary(summary({
      id: `summary_${state}`,
      state,
      summaryText: `${state} summary.`,
      sourceTurnRanges: [{ threadId: "session_a", startSequence: 1, endSequence: 1 }]
    }));

    await expectNotFound(
      `${state} resume`,
      () => openResumer(store).resumeSummary(`summary_${state}`)
    );
  }
);

// Quarantined. Finding: child-box resume includes a box outside the caller scope.
// https://github.com/The-Agent-Corporation/conversational-memory-system/pull/21
it.skip("FINDING child-box scope: an out-of-scope child box is not resumed with its parent", async () => {
  const store = new InMemoryStore();
  await store.saveTurn(turn({ id: "turn_parent", content: "Authorized parent turn." }));
  await store.saveTurn(turn({
    id: "turn_child",
    threadId: "session_child",
    content: "Out-of-scope child turn.",
    metadata: { personId: "person_a", scopeId: "client_secret" },
    contentHash: "hash_child"
  }));
  await store.saveSummary(summary({ id: "summary_parent" }));
  await store.saveSummary(summary({
    id: "summary_child",
    personId: "person_a",
    scopeIds: ["client_secret"],
    summaryText: "Out-of-scope child summary.",
    sourceTurnRanges: [{ threadId: "session_child", startSequence: 1, endSequence: 1 }]
  }));
  await store.saveBox(box({
    id: "box_parent",
    childBoxIds: ["box_child"],
    summaryIds: ["summary_parent"]
  }));
  await store.saveBox(box({
    id: "box_child",
    personId: "person_a",
    parentBoxId: "box_parent",
    summaryIds: ["summary_child"],
    turnRanges: [{ threadId: "session_child", startSequence: 1, endSequence: 1 }],
    title: "Secret child",
    summary: "Out-of-scope child."
  }));

  const result = await openResumer(store).resumeBox("box_parent", { includeChildBoxes: true });

  expect(result.turns.map((sourceTurn) => sourceTurn.content), "FINDING child-box scope").toEqual([
    "Authorized parent turn."
  ]);
  expect(result.sourceBoxIds, "FINDING child-box scope").toEqual(["box_parent"]);
});

// Quarantined. Finding: a forged injection_packet resumes caller-authored raw turn ranges.
// https://github.com/The-Agent-Corporation/conversational-memory-system/pull/21
it.skip("FINDING forged injection_packet: caller-authored raw turn ranges are not resumed", async () => {
  const store = new InMemoryStore();
  await store.saveTurn(turn({ id: "turn_secret", content: "Forged raw-range secret." }));
  const resumer = openResumer(store);

  await expectNoSecret(
    "forged injection_packet raw turn range",
    "Forged raw-range secret.",
    () => resumer.resumeInjection(packet({
      id: "inject_forged",
      personId: "person_attacker",
      sourceSummaryIds: [],
      sourceTurnRanges: [{ threadId: "session_a", startSequence: 1, endSequence: 1 }]
    }))
  );
});

// Quarantined. Finding: a saved injection packet still honors caller-widened raw ranges.
// https://github.com/The-Agent-Corporation/conversational-memory-system/pull/21
it.skip("FINDING forged injection_packet: a saved packet does not honor caller-widened raw ranges", async () => {
  const store = new InMemoryStore();
  await store.saveTurn(turn({ id: "turn_ok", sequence: 1, content: "Authorized personal turn." }));
  await store.saveTurn(turn({
    id: "turn_extra",
    sequence: 9,
    content: "Caller-widened raw-range secret.",
    contentHash: "hash_extra"
  }));
  await store.saveSummary(summary());
  await store.saveInjection(packet());
  const resumer = openResumer(store);

  await expectNoSecret(
    "saved packet caller-widened raw range",
    "Caller-widened raw-range secret.",
    () => resumer.resumeInjection(packet({
      sourceTurnRanges: [
        { threadId: "session_a", startSequence: 1, endSequence: 1 },
        { threadId: "session_a", startSequence: 9, endSequence: 9 }
      ]
    }))
  );
});
