import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Box, MemoryProposal, Summary } from "../../src/domain/types.js";
import { createProfileAuthority } from "../../src/mcp/authority.js";
import { MemoryQueryService } from "../../src/retrieval/memory-query-service.js";
import { rejectedValueHash } from "../../src/retrieval/rejected-value.js";
import { reinforceSummary } from "../../src/retrieval/reinforce.js";
import { MemoryRetriever } from "../../src/retrieval/memory-retriever.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";

const NOW = "2026-11-05T18:00:00.000Z";
const LATER = "2026-11-05T18:30:00.000Z";
const NEXT_HOUR = "2026-11-05T19:00:00.000Z";
const TITLE = "Smith PIP";

const summary = (overrides: Partial<Summary> = {}): Summary => ({
  id: "summary_1",
  personId: "person_a",
  scopeIds: ["personal"],
  summaryText: "Smith PIP demand strategy and coverage timing.",
  sourceTurnRanges: [{ threadId: "session", startSequence: 1, endSequence: 2 }],
  sourceSummaryIds: [],
  boxIds: [],
  embedding: null,
  createdAt: NOW,
  model: "test",
  promptVersion: "v1",
  confidence: 0.9,
  state: "active",
  detailLevel: "brief",
  tokenCount: 8,
  lastAccessedAt: null,
  version: 1,
  strength: 0.98,
  retrievalCount: 0,
  retrievedAt: null,
  halfLifeHours: 24,
  outcomeScore: null,
  ...overrides
});

const proposal = (overrides: Partial<MemoryProposal> = {}): MemoryProposal => ({
  id: "proposal_new",
  personId: "person_a",
  proposalType: "box",
  state: "proposed",
  title: `  ${TITLE.toLowerCase()}   `,
  rationale: "Automated reentry attempt.",
  confidence: 0.5,
  createdAt: NOW,
  reviewedAt: NOW,
  decidedAt: null,
  decidedBy: null,
  decisionNote: null,
  sourceSummaryIds: ["summary_1"],
  sourceTurnRanges: [{ threadId: "session", startSequence: 1, endSequence: 2 }],
  targetBoxIds: ["box_new"],
  targetTraceIds: [],
  payload: {
    boxId: "box_new",
    title: TITLE,
    description: "New id for a rejected title.",
    summary: "Smith PIP coverage.",
    boxType: "topic",
    candidateParentBoxId: null,
    keywords: ["smith"],
    evidence: ["smith"],
    sourceSummaryIds: ["summary_1"],
    sourceTurnRanges: [{ threadId: "session", startSequence: 1, endSequence: 2 }]
  },
  ...overrides
});

const box = (overrides: Partial<Box> = {}): Box => ({
  id: "box_new",
  personId: "person_a",
  title: TITLE,
  description: "Automated box.",
  parentBoxId: null,
  childBoxIds: [],
  summaryIds: ["summary_1"],
  turnRanges: [{ threadId: "session", startSequence: 1, endSequence: 2 }],
  state: "proposed",
  createdAt: NOW,
  updatedAt: NOW,
  caseId: null,
  boxType: "topic",
  summary: "Smith PIP coverage.",
  lastActivityAt: NOW,
  ...overrides
});

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("read-only reads", () => {
  it("search, recall, and review leave strength, state, and audits unchanged", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(summary());
    const before = await store.listSummaries();
    const service = new MemoryQueryService(store, createProfileAuthority({
      profileName: "workspace",
      databasePath: "/tmp/unused.sqlite",
      personId: "person_a",
      allowedScopeIds: ["personal"],
      ingestScopeId: "personal",
      sourceRoots: { synthetic: "/tmp/sources" },
      scopeAliases: { personal: "workspace" },
      allowedHosts: null
    }));
    await service.search({ query: "Smith PIP", limit: 5 });
    await service.recall({ task: "Smith PIP", tokenBudget: 100 });
    await service.review({ limit: 10 });
    expect(await store.listSummaries()).toEqual(before);
    expect(await store.listMutationAudits("person_a")).toEqual([]);
    expect(await store.listInjections("session")).toEqual([]);
  });
});

describe("explicit reinforcement", () => {
  it("bounds strength, rate-limits a repeat, revives a stale summary, and audits without content", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(summary({ strength: 0.98 }));
    const capped = await reinforceSummary(store, {
      summaryId: "summary_1",
      personId: "person_a",
      allowedScopeIds: ["personal"],
      now: NOW
    });
    expect(capped).toMatchObject({ status: "REINFORCED", strength: 1 });
    const blocked = await reinforceSummary(store, {
      summaryId: "summary_1",
      personId: "person_a",
      allowedScopeIds: ["personal"],
      now: LATER
    });
    expect(blocked.status).toBe("RATE_LIMITED");
    expect((await store.listSummaries())[0]?.strength).toBe(1);

    await store.saveSummary(summary({
      id: "summary_stale",
      state: "stale",
      strength: 0.2,
      summaryText: "A different stale note."
    }));
    const revived = await reinforceSummary(store, {
      summaryId: "summary_stale",
      personId: "person_a",
      allowedScopeIds: ["personal"],
      now: NEXT_HOUR
    });
    expect(revived).toMatchObject({ status: "REINFORCED", strength: 0.25 });
    expect((await store.listSummaries()).find((item) => item.id === "summary_stale")?.state).toBe("revived");

    const denied = await reinforceSummary(store, {
      summaryId: "summary_1",
      personId: "person_b",
      allowedScopeIds: ["personal"],
      now: NEXT_HOUR
    });
    expect(denied.status).toBe("NOT_FOUND");

    const audits = await store.listMutationAudits("person_a");
    expect(audits.map((record) => record.action)).toEqual(["reinforce", "reinforce"]);
    expect(JSON.stringify(audits)).not.toContain("coverage timing");
    expect(JSON.stringify(audits)).not.toContain("stale note");
  });
});

describe("rejected-value fingerprints", () => {
  it("stores only a hash and blocks a new id in the same person and scope", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(summary({ scopeIds: ["personal"] }));
    await store.saveSummary(summary({ id: "summary_work", scopeIds: ["work"], summaryText: "Work scope note." }));
    const valueHash = rejectedValueHash(`  ${TITLE}  `);
    await store.recordRejectedValueFingerprint({
      personId: "person_a",
      scopeId: "personal",
      valueHash,
      recordedAt: NOW
    });
    const stored = await store.listRejectedValueFingerprints("person_a");
    expect(stored).toEqual([{ personId: "person_a", scopeId: "personal", valueHash, recordedAt: NOW }]);
    expect(JSON.stringify(stored)).not.toContain(TITLE);
    expect(valueHash).not.toContain(TITLE.toLowerCase());

    await expect(store.saveProposal(proposal())).rejects.toThrow("REJECTED_VALUE");
    await expect(store.saveBox(box())).rejects.toThrow("REJECTED_VALUE");
    await expect(store.saveProposal(proposal({
      id: "proposal_work",
      sourceSummaryIds: ["summary_work"],
      payload: {
        ...(proposal().payload as object),
        sourceSummaryIds: ["summary_work"]
      }
    }))).resolves.toBeUndefined();
    await expect(store.saveProposal(proposal({
      id: "proposal_other_person",
      personId: "person_b"
    }))).resolves.toBeUndefined();
    expect(await store.listProposals()).toHaveLength(2);
  });

  it("records the hash from a sqlite rejection commit path", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cms-reject-hash-"));
    const databasePath = join(tempDir, "memory.sqlite");
    const store = new SqliteStore(databasePath);
    await store.saveSummary(summary());
    await store.recordRejectedValueFingerprint({
      personId: "person_a",
      scopeId: "personal",
      valueHash: rejectedValueHash(TITLE),
      recordedAt: NOW
    });
    store.close();
    const read = new SqliteStore(databasePath, { readOnly: true });
    try {
      const rows = await read.listRejectedValueFingerprints("person_a");
      expect(rows[0]?.valueHash).toBe(rejectedValueHash(TITLE));
      expect(JSON.stringify(rows)).not.toContain(TITLE);
    } finally {
      read.close();
    }
  });
});

describe("injection audit", () => {
  it("records an inject audit and does not change strength", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(summary({ strength: 0.4 }));
    const packet = await new MemoryRetriever(store).prepareInjection({
      host: "field-notes",
      profileId: "workspace",
      hostSessionId: "session",
      currentTopicSummary: "Smith PIP",
      personId: "person_a",
      allowedScopeIds: ["personal"],
      requestedAt: NOW
    });
    expect(packet).not.toBeNull();
    expect((await store.listSummaries())[0]).toMatchObject({ strength: 0.4, state: "active", retrievalCount: 0 });
    const audits = await store.listMutationAudits("person_a");
    expect(audits.map((record) => record.action)).toEqual(["inject"]);
    expect(JSON.stringify(audits)).not.toContain("coverage timing");
  });
});
