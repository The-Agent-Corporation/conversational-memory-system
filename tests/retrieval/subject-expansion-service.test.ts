import { describe, expect, it } from "vitest";
import { createProfileAuthority } from "../../src/mcp/authority.js";
import { ContinuationCursorCodec } from "../../src/mcp/continuation-cursor.js";
import { SubjectExpansionService } from "../../src/retrieval/subject-expansion-service.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import type { CanonicalEvent } from "../../src/domain/canonical.js";
import type { Summary } from "../../src/domain/types.js";

// Plan 11-09 (GAP-11-A sweep): `resolveSummary`'s fail-closed condition filtered person/scope
// only, so a subject whose only matching summary was superseded still resolved, and the
// recursive `sourceSummaryIds` walk could pass straight through a superseded dependency to
// return its canonical events.

const PERSON_ID = "person_gap11a_sub";
const SCOPE_ID = "personal";

const makeAuthority = () =>
  createProfileAuthority({
    profileName: "gap11a-sub",
    databasePath: "/tmp/gap11a-sub.db",
    personId: PERSON_ID,
    allowedScopeIds: [SCOPE_ID],
    ingestScopeId: SCOPE_ID,
    sourceRoots: {},
    scopeAliases: {}
  });

const makeCursors = () =>
  new ContinuationCursorCodec("gap11a-subject-expansion-secret-32-bytes", {
    now: () => "2026-05-04T10:10:00.000Z"
  });

const makeSummary = (overrides: Partial<Summary> = {}): Summary => ({
  id: "summary_1",
  summaryText: "Smith PIP demand strategy and coverage timing.",
  sourceTurnRanges: [{ threadId: "session_1", startSequence: 1, endSequence: 2 }],
  sourceCanonicalEventIds: [],
  sourceSummaryIds: [],
  boxIds: [],
  embedding: null,
  createdAt: "2026-05-04T10:05:00.000Z",
  model: "test-summarizer",
  promptVersion: "v1",
  confidence: 0.9,
  state: "compacted",
  detailLevel: "brief",
  tokenCount: 10,
  lastAccessedAt: null,
  version: 1,
  strength: 0.8,
  retrievalCount: 0,
  retrievedAt: null,
  halfLifeHours: 168,
  outcomeScore: null,
  personId: PERSON_ID,
  scopeIds: [SCOPE_ID],
  ...overrides
});

const makeEvent = (overrides: Partial<CanonicalEvent> = {}): CanonicalEvent => ({
  id: "event_1",
  personId: PERSON_ID,
  sourceId: "source_1",
  sourceApplication: "synthetic-host",
  sourceProfileId: "default",
  scopeId: SCOPE_ID,
  nativeSessionId: "session_1",
  nativeEventId: "native_event_1",
  nativeSequence: 1,
  causalParentId: null,
  eventKind: "message",
  role: "user",
  content: "Smith PIP demand strategy details.",
  occurredAt: "2026-05-04T10:00:00.000Z",
  importedAt: "2026-05-04T10:01:00.000Z",
  provenance: "direct_user_input",
  trustLevel: "high",
  contentHash: "hash_event_1",
  parserVersion: "v1",
  metadata: {},
  ...overrides
});

describe("SubjectExpansionService (GAP-11-A sweep)", () => {
  it("(a) a subject whose only matching summary is superseded resolves to no subject", async () => {
    const store = new InMemoryStore();
    await store.saveCanonicalEvent(makeEvent({ id: "event_superseded" }));
    await store.saveSummary(makeSummary({
      id: "summary_superseded",
      state: "superseded",
      sourceCanonicalEventIds: ["event_superseded"]
    }));

    const service = new SubjectExpansionService(store, makeAuthority(), makeCursors());

    await expect(service.expand({
      subject: "Smith PIP demand strategy and coverage timing.",
      tokenBudget: 500
    })).rejects.toThrow("Subject is unavailable");
  });

  it("(b) an active summary whose sourceSummaryIds chain reaches a superseded summary does not expand", async () => {
    const store = new InMemoryStore();
    await store.saveCanonicalEvent(makeEvent({ id: "event_root" }));
    await store.saveCanonicalEvent(makeEvent({
      id: "event_dependency",
      nativeEventId: "native_event_dependency",
      nativeSequence: 2,
      content: "Coverage timing dependency detail."
    }));
    await store.saveSummary(makeSummary({
      id: "summary_superseded_dependency",
      state: "superseded",
      sourceCanonicalEventIds: ["event_dependency"]
    }));
    await store.saveSummary(makeSummary({
      id: "summary_active_root",
      state: "active",
      summaryText: "Root subject summary referencing a superseded dependency.",
      sourceCanonicalEventIds: ["event_root"],
      sourceSummaryIds: ["summary_superseded_dependency"]
    }));

    const service = new SubjectExpansionService(store, makeAuthority(), makeCursors());

    await expect(service.expand({
      subject: "Root subject summary referencing a superseded dependency.",
      tokenBudget: 500
    })).rejects.toThrow("Subject is unavailable");
  });
});
