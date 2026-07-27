import { describe, expect, it } from "vitest";
import { createProfileAuthority } from "../../src/mcp/authority.js";
import { MemoryQueryService } from "../../src/retrieval/memory-query-service.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import type { Box, MemoryTrace, Summary } from "../../src/domain/types.js";

// Plan 11-09 (GAP-11-A sweep): the MCP read/search surface (`loadAuthorizedMemory`) never
// consulted `isRetrievableState`, so a superseded summary sharing query vocabulary with an
// active one was still returned by `search`, counted by `status().memoryCount`, and could
// authorize a box/trace whose `summaryIds` were all superseded.

const PERSON_ID = "person_gap11a_mqs";
const SCOPE_ID = "personal";

const makeAuthority = () =>
  createProfileAuthority({
    profileName: "gap11a-mqs",
    databasePath: "/tmp/gap11a-mqs.db",
    personId: PERSON_ID,
    allowedScopeIds: [SCOPE_ID],
    ingestScopeId: SCOPE_ID,
    sourceRoots: {},
    scopeAliases: {}
  });

const makeSummary = (overrides: Partial<Summary> = {}): Summary => ({
  id: "summary_1",
  summaryText: "Smith PIP demand strategy and coverage timing.",
  sourceTurnRanges: [{ threadId: "session_1", startSequence: 1, endSequence: 2 }],
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

const makeBox = (overrides: Partial<Box> = {}): Box => ({
  id: "box_1",
  title: "Smith PIP",
  description: "Smith no-fault benefits and provider bills.",
  parentBoxId: null,
  childBoxIds: [],
  summaryIds: [],
  turnRanges: [],
  state: "approved",
  createdAt: "2026-05-04T10:00:00.000Z",
  updatedAt: "2026-05-04T10:05:00.000Z",
  caseId: "case_smith",
  boxType: "topic",
  summary: "Smith PIP coverage and provider bill issues.",
  lastActivityAt: "2026-05-04T10:05:00.000Z",
  personId: PERSON_ID,
  ...overrides
});

const makeTrace = (overrides: Partial<MemoryTrace> = {}): MemoryTrace => ({
  id: "trace_1",
  title: "Smith PIP Provider Bills",
  description: "Recurring Smith PIP provider bill dispute and no-fault payment timing.",
  traceType: "case_issue",
  state: "approved",
  summaryIds: [],
  boxIds: [],
  turnRanges: [{ threadId: "session_1", startSequence: 1, endSequence: 2 }],
  createdAt: "2026-05-04T10:05:00.000Z",
  updatedAt: "2026-05-04T10:05:00.000Z",
  lastActivityAt: "2026-05-04T10:05:00.000Z",
  confidence: 0.88,
  rationale: "The same provider bill issue recurred across separated turns.",
  personId: PERSON_ID,
  ...overrides
});

describe("MemoryQueryService (GAP-11-A sweep)", () => {
  it("excludes a superseded summary from search results even when it out-scores on vocabulary", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({
      id: "summary_active",
      state: "active",
      summaryText: "Smith PIP demand strategy and coverage timing."
    }));
    await store.saveSummary(makeSummary({
      id: "summary_superseded",
      state: "superseded",
      summaryText: 'Smith PIP demand strategy and coverage timing. [Tool call: Bash] {"cmd":"make"}'
    }));

    const service = new MemoryQueryService(store, makeAuthority());
    const result = await service.search({ query: "Smith PIP demand strategy coverage timing", limit: 20 });

    const ids = result.candidates.map((candidate) => candidate.id);
    expect(ids).toContain("summary_active");
    expect(ids).not.toContain("summary_superseded");
  });

  it("excludes a superseded summary from status().memoryCount", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({ id: "summary_active", state: "active" }));
    await store.saveSummary(makeSummary({ id: "summary_superseded", state: "superseded" }));

    const service = new MemoryQueryService(store, makeAuthority());
    const status = await service.status("2026-05-04T10:10:00.000Z");

    expect(status.memoryCount).toBe(1);
  });

  it("excludes a box whose summaryIds are all superseded", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({ id: "summary_superseded", state: "superseded" }));
    await store.saveBox(makeBox({ id: "box_superseded", summaryIds: ["summary_superseded"] }));

    const service = new MemoryQueryService(store, makeAuthority());
    const result = await service.review({ kinds: ["box"], states: ["approved"], limit: 20 });

    expect(result.items.map((item) => item.id)).not.toContain("box_superseded");
  });

  it("excludes a trace whose summaryIds are all superseded", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(makeSummary({ id: "summary_superseded_a", state: "superseded" }));
    await store.saveSummary(makeSummary({ id: "summary_superseded_b", state: "superseded" }));
    await store.saveTrace(makeTrace({
      id: "trace_superseded",
      summaryIds: ["summary_superseded_a", "summary_superseded_b"]
    }));

    const service = new MemoryQueryService(store, makeAuthority());
    const result = await service.review({ kinds: ["trace"], states: ["approved"], limit: 20 });

    expect(result.items.map((item) => item.id)).not.toContain("trace_superseded");
  });
});
