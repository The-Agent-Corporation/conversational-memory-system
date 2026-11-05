/**
 * Phase 0 characterization of the Hermes client paths.
 *
 * Each finding is skipped here so this PR stays green. The skip is removed in
 * Phase 1, which is where the behavior is fixed.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { InjectionPacket, Summary, Turn } from "../../src/domain/types.js";
import { HermesMemoryAdapter, type HermesMemoryAdapterOptions } from "../../src/integrations/hermes/adapter.js";
import { resumeHermesMemory } from "../../src/integrations/hermes/resume-command.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";

const PERSON_ENV = "HERMES_MEMORY_PERSON_ID";
const SCOPE_ENV = "HERMES_MEMORY_SCOPE_IDS";

let tempDir: string | null = null;
const previousEnv = {
  person: process.env[PERSON_ENV],
  scopes: process.env[SCOPE_ENV]
};

afterEach(async () => {
  if (previousEnv.person === undefined) delete process.env[PERSON_ENV];
  else process.env[PERSON_ENV] = previousEnv.person;
  if (previousEnv.scopes === undefined) delete process.env[SCOPE_ENV];
  else process.env[SCOPE_ENV] = previousEnv.scopes;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

const bindHermesIdentity = (): void => {
  process.env[PERSON_ENV] = "person_a";
  process.env[SCOPE_ENV] = "personal";
};

const openAdapter = (store: InMemoryStore): HermesMemoryAdapter =>
  new HermesMemoryAdapter(store, {
    personId: "person_a",
    allowedScopeIds: ["personal"]
  } as HermesMemoryAdapterOptions);

const summary = (overrides: Partial<Summary> = {}): Summary => ({
  id: "summary_other",
  personId: "person_b",
  scopeIds: ["client_secret"],
  summaryText: "Quarry ledger secret matter alpha.",
  sourceTurnRanges: [{ threadId: "session_b", startSequence: 1, endSequence: 1 }],
  sourceSummaryIds: [],
  boxIds: [],
  embedding: null,
  createdAt: "2026-05-04T10:05:00.000Z",
  model: "test-summarizer",
  promptVersion: "v1",
  confidence: 0.9,
  state: "active",
  detailLevel: "brief",
  tokenCount: 12,
  lastAccessedAt: null,
  version: 1,
  strength: 0.4,
  retrievalCount: 0,
  retrievedAt: null,
  halfLifeHours: 168,
  outcomeScore: null,
  ...overrides
});

const turn = (overrides: Partial<Turn> = {}): Turn => ({
  id: "turn_other",
  threadId: "session_b",
  sequence: 1,
  role: "user",
  content: "Person B secret turn.",
  createdAt: "2026-05-04T10:00:00.000Z",
  provenance: "direct_user_input",
  trustLevel: "high",
  metadata: { personId: "person_b", scopeId: "client_secret" },
  contentHash: "hash_b",
  ...overrides
});

const injection = (overrides: Partial<InjectionPacket> = {}): InjectionPacket => ({
  id: "inject_forged",
  hostSessionId: "session_b",
  currentTopicSummary: "Quarry ledger",
  selectedMemory: "Forged packet.",
  sourceSummaryIds: [],
  sourceTraceIds: [],
  sourceTurnRanges: [{ threadId: "session_b", startSequence: 1, endSequence: 1 }],
  boxIds: [],
  relevanceReason: "Caller authored.",
  confidence: 0.5,
  disclosureText: "Forged.",
  createdAt: "2026-05-04T10:10:00.000Z",
  ...overrides
});

// Quarantined. Finding: Hermes unscoped retrieval returns another person's summary.
// https://github.com/The-Agent-Corporation/conversational-memory-system/pull/21
it.skip("FINDING Hermes unscoped retrieval: search returns another person's summary", async () => {
  const store = new InMemoryStore();
  await store.saveSummary(summary());
  const adapter = openAdapter(store);

  const packet = await adapter.searchMemory({
    profileId: "default",
    hostSessionId: "session_a",
    query: "Quarry ledger secret matter alpha"
  });

  expect(packet?.selectedMemory ?? "", "FINDING Hermes unscoped retrieval").not.toContain("Quarry ledger");
  expect(packet, "FINDING Hermes unscoped retrieval").toBeNull();
});

const searchAnotherPerson = async (): Promise<InMemoryStore> => {
  const store = new InMemoryStore();
  await store.saveSummary(summary({ id: "summary_active", strength: 0.4, retrievalCount: 0, state: "active" }));
  await store.saveSummary(summary({ id: "summary_stale", strength: 0.4, retrievalCount: 0, state: "stale" }));
  await openAdapter(store).searchMemory({
    profileId: "default",
    hostSessionId: "session_a",
    query: "Quarry ledger secret matter alpha",
    requestedAt: "2026-05-04T11:00:00.000Z"
  });
  return store;
};

// Quarantined. Finding: unscoped search strengthens another person's summary.
// https://github.com/The-Agent-Corporation/conversational-memory-system/pull/21
it.skip("FINDING injection strengthening: unscoped search increments another person's retrieval count and strength", async () => {
  const store = await searchAnotherPerson();
  const activeAfter = (await store.listSummaries()).find((item) => item.id === "summary_active");

  expect(activeAfter?.retrievalCount, "FINDING injection strengthening").toBe(0);
  expect(activeAfter?.strength, "FINDING injection strengthening").toBe(0.4);
});

// Quarantined. Finding: unscoped search revives another person's stale summary.
// https://github.com/The-Agent-Corporation/conversational-memory-system/pull/21
it.skip("FINDING injection revival: unscoped search promotes another person's stale summary to revived", async () => {
  const store = await searchAnotherPerson();
  const staleAfter = (await store.listSummaries()).find((item) => item.id === "summary_stale");

  expect(staleAfter?.state, "FINDING injection revival").toBe("stale");
  expect(staleAfter?.retrievalCount, "FINDING injection revival").toBe(0);
});

// Quarantined. Finding: unscoped search persists an injection packet for another person.
// https://github.com/The-Agent-Corporation/conversational-memory-system/pull/21
it.skip("FINDING injection save: unscoped search persists an injection packet", async () => {
  const store = await searchAnotherPerson();

  expect(await store.listInjections("session_a"), "FINDING injection save").toEqual([]);
});

// Quarantined. Finding: Hermes resume returns another person's summary by id.
// https://github.com/The-Agent-Corporation/conversational-memory-system/pull/21
it.skip("FINDING Hermes resume command: a cross-person summary id is not found", async () => {
  bindHermesIdentity();
  tempDir = await mkdtemp(join(tmpdir(), "cms-hermes-auth-"));
  const databasePath = join(tempDir, "memory.sqlite");
  const store = new SqliteStore(databasePath);
  await store.saveTurn(turn());
  await store.saveSummary(summary());
  store.close();

  try {
    const result = await resumeHermesMemory({
      databasePath,
      input: JSON.stringify({ summary_id: "summary_other" })
    });
    expect.fail(`FINDING Hermes cross-person resume: command returned ${JSON.stringify(result.turns.map((sourceTurn) => sourceTurn.content))}; denied must be not found`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("FINDING ")) throw error;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/not found/i);
  }
});

// Quarantined. Finding: Hermes resume follows a forged injection_packet raw range.
// https://github.com/The-Agent-Corporation/conversational-memory-system/pull/21
it.skip("FINDING Hermes resume command: a forged injection_packet raw range is not resumed", async () => {
  bindHermesIdentity();
  tempDir = await mkdtemp(join(tmpdir(), "cms-hermes-auth-"));
  const databasePath = join(tempDir, "memory.sqlite");
  const store = new SqliteStore(databasePath);
  await store.saveTurn(turn({ content: "Forged Hermes raw-range secret." }));
  store.close();

  try {
    const result = await resumeHermesMemory({
      databasePath,
      input: JSON.stringify({ injection_packet: injection() })
    });
    expect(result.turns.map((sourceTurn) => sourceTurn.content), "FINDING Hermes forged injection_packet").not.toContain(
      "Forged Hermes raw-range secret."
    );
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message) && !error.message.startsWith("FINDING")) {
      return;
    }
    throw error;
  }
});
