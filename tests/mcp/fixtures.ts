import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonicalEvent, MemorySource, Person } from "../../src/domain/canonical.js";
import type {
  Anchor,
  Box,
  MemoryProposal,
  MemoryTrace,
  Summary
} from "../../src/domain/types.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";

const NOW = "2026-07-18T12:00:00.000Z";
const SYNTHETIC_SESSIONS = ["synthetic-alpha", "synthetic-beta", "synthetic-other"];

export interface SyntheticProfileConfig {
  version: 1;
  profiles: Record<string, {
    databasePath: string;
    personId: string;
    allowedScopeIds: string[];
    ingestScopeId: string;
    scopeAliases: Record<string, string>;
    sourceRoots: Record<string, string>;
  }>;
}

export interface FakeClock {
  now(): string;
  advance(milliseconds: number): void;
}

export interface FaultInjector {
  readonly reached: readonly string[];
  failAt(boundary: string | null): void;
  reach(boundary: string): void;
}

export interface SyntheticMcpFixture {
  tempDir: string;
  databasePath: string;
  configPath: string;
  config: SyntheticProfileConfig;
  store: SqliteStore;
  clock: FakeClock;
  faultInjector: FaultInjector;
  cleanup(): Promise<void>;
}

const person = (id: string, displayName: string): Person => ({
  id,
  displayName,
  createdAt: NOW
});

const source = (
  id: string,
  personId: string,
  profileId: string,
  scopeId: string
): MemorySource => ({
  id,
  personId,
  application: "synthetic-host",
  profileId,
  instanceId: `synthetic-instance-${id}`,
  scopeId,
  createdAt: NOW,
  lastImportedAt: NOW
});

const canonicalEvent = (input: {
  id: string;
  personId: string;
  sourceId: string;
  scopeId: string;
  sessionId: string;
  sequence: number;
  occurredAt: string;
  content: string;
}): CanonicalEvent => ({
  id: input.id,
  personId: input.personId,
  sourceId: input.sourceId,
  sourceApplication: "synthetic-host",
  sourceProfileId: "synthetic-profile",
  scopeId: input.scopeId,
  nativeSessionId: input.sessionId,
  nativeEventId: `native-${input.id}`,
  nativeSequence: input.sequence,
  causalParentId: null,
  eventKind: "message",
  role: "user",
  content: input.content,
  occurredAt: input.occurredAt,
  importedAt: NOW,
  provenance: "direct_user_input",
  trustLevel: "high",
  contentHash: `hash-${input.id}`,
  parserVersion: "synthetic/v1",
  metadata: { fixture: true }
});

const summary = (input: {
  id: string;
  personId: string;
  scopeIds: string[];
  eventIds: string[];
  text: string;
}): Summary => ({
  id: input.id,
  personId: input.personId,
  scopeIds: input.scopeIds,
  origin: "historical_bootstrap",
  summaryText: input.text,
  sourceTurnRanges: [],
  sourceCanonicalEventIds: input.eventIds,
  sourceSummaryIds: [],
  boxIds: [],
  embedding: null,
  createdAt: NOW,
  model: "synthetic-local",
  promptVersion: "fixture-v1",
  confidence: 0.8,
  state: "active",
  detailLevel: "brief",
  tokenCount: 12,
  lastAccessedAt: null,
  version: 1,
  strength: 0.5,
  retrievalCount: 0,
  retrievedAt: null,
  halfLifeHours: 168,
  outcomeScore: null
});

const box = (input: {
  id: string;
  personId: string;
  summaryIds: string[];
  title: string;
}): Box => ({
  id: input.id,
  personId: input.personId,
  title: input.title,
  description: "Synthetic derived-memory box",
  parentBoxId: null,
  childBoxIds: [],
  summaryIds: input.summaryIds,
  turnRanges: [],
  state: "approved",
  createdAt: NOW,
  updatedAt: NOW,
  caseId: null,
  boxType: "project",
  summary: "Synthetic box summary",
  lastActivityAt: NOW
});

const anchor = (): Anchor => ({
  id: "anchor-alpha",
  personId: "person-alpha",
  scopeId: "scope-alpha",
  canonicalEventId: "event-alpha-1",
  turnId: "synthetic-turn-alpha",
  threadId: "synthetic-alpha",
  boxId: "box-alpha",
  anchorType: "decision",
  content: "Synthetic alpha decision",
  embedding: null,
  createdAt: NOW,
  trustLevel: "high",
  source: "direct_user_input"
});

const trace = (): MemoryTrace => ({
  id: "trace-mixed",
  personId: "person-alpha",
  title: "Synthetic mixed dependency trace",
  description: "Depends on two differently scoped synthetic summaries.",
  traceType: "task_thread",
  state: "proposed",
  summaryIds: ["summary-alpha", "summary-beta"],
  boxIds: ["box-mixed"],
  turnRanges: [{ threadId: "synthetic-alpha", startSequence: 1, endSequence: 2 }],
  createdAt: NOW,
  updatedAt: NOW,
  lastActivityAt: NOW,
  confidence: 0.7,
  rationale: "Synthetic cross-scope dependency for authorization tests."
});

const proposal = (): MemoryProposal => ({
  id: "proposal-mixed",
  personId: "person-alpha",
  proposalType: "trace",
  state: "proposed",
  title: "Synthetic mixed trace proposal",
  rationale: "Exercises mixed-scope proposal filtering.",
  confidence: 0.7,
  createdAt: NOW,
  reviewedAt: NOW,
  decidedAt: null,
  decidedBy: null,
  decisionNote: null,
  sourceSummaryIds: ["summary-alpha", "summary-beta"],
  sourceTurnRanges: [{ threadId: "synthetic-alpha", startSequence: 1, endSequence: 2 }],
  targetBoxIds: ["box-mixed"],
  targetTraceIds: ["trace-mixed"],
  payload: {
    traceId: "trace-mixed",
    title: "Synthetic mixed dependency trace",
    description: "Synthetic proposal payload",
    traceType: "task_thread",
    summaryIds: ["summary-alpha", "summary-beta"],
    boxIds: ["box-mixed"],
    turnRanges: [{ threadId: "synthetic-alpha", startSequence: 1, endSequence: 2 }],
    continuityReason: "Synthetic continuity",
    boundaryReason: "Synthetic boundary",
    keywords: ["synthetic", "boundary"]
  }
});

export const createFakeClock = (initial = NOW): FakeClock => {
  let current = Date.parse(initial);
  return {
    now: () => new Date(current).toISOString(),
    advance(milliseconds) {
      current += milliseconds;
    }
  };
};

export const createFaultInjector = (): FaultInjector => {
  const reached: string[] = [];
  let failingBoundary: string | null = null;
  return {
    get reached() {
      return reached;
    },
    failAt(boundary) {
      failingBoundary = boundary;
    },
    reach(boundary) {
      reached.push(boundary);
      if (boundary === failingBoundary) throw new Error(`Synthetic fault at ${boundary}`);
    }
  };
};

export const createSyntheticProfileConfig = (
  databasePath: string,
  sourceRoot: string
): SyntheticProfileConfig => ({
  version: 1,
  profiles: {
    "alpha-workspace": {
      databasePath,
      personId: "person-alpha",
      allowedScopeIds: ["scope-alpha"],
      ingestScopeId: "scope-alpha",
      scopeAliases: {
        "scope-alpha": "context-one",
        "scope-beta": "context-two",
        "scope-shared": "context-three"
      },
      sourceRoots: { synthetic: sourceRoot }
    },
    "alpha-expanded": {
      databasePath,
      personId: "person-alpha",
      allowedScopeIds: ["scope-alpha", "scope-beta"],
      ingestScopeId: "scope-alpha",
      scopeAliases: {
        "scope-alpha": "context-one",
        "scope-beta": "context-two",
        "scope-shared": "context-three"
      },
      sourceRoots: { synthetic: sourceRoot }
    },
    "other-person": {
      databasePath,
      personId: "person-beta",
      allowedScopeIds: ["scope-shared"],
      ingestScopeId: "scope-shared",
      scopeAliases: {
        "scope-alpha": "context-one",
        "scope-beta": "context-two",
        "scope-shared": "context-three"
      },
      sourceRoots: { synthetic: sourceRoot }
    }
  }
});

export const snapshotSemanticMemory = async (store: SqliteStore): Promise<string> => {
  const [
    people,
    sourcesAlpha,
    sourcesBeta,
    eventsAlpha,
    eventsBeta,
    summaries,
    anchors,
    boxes,
    proposals,
    traces,
    ...sessionRows
  ] = await Promise.all([
    store.listPeople(),
    store.listSources("person-alpha"),
    store.listSources("person-beta"),
    store.listCanonicalEvents("person-alpha"),
    store.listCanonicalEvents("person-beta"),
    store.listSummaries(),
    store.listAnchors(),
    store.listBoxes(),
    store.listProposals(),
    store.listTraces(),
    ...SYNTHETIC_SESSIONS.flatMap((sessionId) => [
      store.listTurns(sessionId),
      store.listInjections(sessionId)
    ])
  ]);
  return JSON.stringify({
    people,
    sources: [...sourcesAlpha, ...sourcesBeta],
    events: [...eventsAlpha, ...eventsBeta],
    summaries,
    anchors,
    boxes,
    proposals,
    traces,
    sessions: sessionRows
  });
};

export const createSyntheticMcpFixture = async (): Promise<SyntheticMcpFixture> => {
  const tempDir = await mkdtemp(join(tmpdir(), "memory-mcp-synthetic-"));
  const databasePath = join(tempDir, "memory.sqlite");
  const sourceRoot = join(tempDir, "configured-synthetic-source");
  const configPath = join(tempDir, "profiles.json");
  await mkdir(sourceRoot);

  const clock = createFakeClock();
  const faultInjector = createFaultInjector();
  const store = new SqliteStore(databasePath, { clock, faultInjector });
  const config = createSyntheticProfileConfig(databasePath, sourceRoot);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  await store.savePerson(person("person-alpha", "Synthetic Person Alpha"));
  await store.savePerson(person("person-beta", "Synthetic Person Beta"));
  await store.saveSource(source("source-alpha", "person-alpha", "alpha", "scope-alpha"));
  await store.saveSource(source("source-beta", "person-alpha", "beta", "scope-beta"));
  await store.saveSource(source("source-other", "person-beta", "other", "scope-shared"));

  await store.saveCanonicalEvent(canonicalEvent({
    id: "event-alpha-2",
    personId: "person-alpha",
    sourceId: "source-alpha",
    scopeId: "scope-alpha",
    sessionId: "synthetic-alpha",
    sequence: 2,
    occurredAt: "2026-07-18T12:02:00.000Z",
    content: "Synthetic alpha follow-up"
  }));
  await store.saveCanonicalEvent(canonicalEvent({
    id: "event-alpha-1",
    personId: "person-alpha",
    sourceId: "source-alpha",
    scopeId: "scope-alpha",
    sessionId: "synthetic-alpha",
    sequence: 1,
    occurredAt: "2026-07-18T12:01:00.000Z",
    content: "Synthetic alpha subject"
  }));
  await store.saveCanonicalEvent(canonicalEvent({
    id: "event-beta-1",
    personId: "person-alpha",
    sourceId: "source-beta",
    scopeId: "scope-beta",
    sessionId: "synthetic-beta",
    sequence: 1,
    occurredAt: "2026-07-18T12:03:00.000Z",
    content: "Synthetic restricted subject"
  }));
  await store.saveCanonicalEvent(canonicalEvent({
    id: "event-other-1",
    personId: "person-beta",
    sourceId: "source-other",
    scopeId: "scope-shared",
    sessionId: "synthetic-other",
    sequence: 1,
    occurredAt: "2026-07-18T12:00:00.000Z",
    content: "Synthetic other-person subject"
  }));

  await store.saveSummary(summary({
    id: "summary-alpha",
    personId: "person-alpha",
    scopeIds: ["scope-alpha"],
    eventIds: ["event-alpha-1", "event-alpha-2"],
    text: "Synthetic alpha summary"
  }));
  await store.saveSummary(summary({
    id: "summary-beta",
    personId: "person-alpha",
    scopeIds: ["scope-beta"],
    eventIds: ["event-beta-1"],
    text: "Synthetic restricted summary"
  }));
  await store.saveSummary(summary({
    id: "summary-mixed",
    personId: "person-alpha",
    scopeIds: ["scope-alpha", "scope-beta"],
    eventIds: ["event-alpha-2", "event-beta-1"],
    text: "Synthetic mixed-scope summary"
  }));
  await store.saveSummary(summary({
    id: "summary-other",
    personId: "person-beta",
    scopeIds: ["scope-shared"],
    eventIds: ["event-other-1"],
    text: "Synthetic other-person summary"
  }));
  await store.saveBox(box({
    id: "box-alpha",
    personId: "person-alpha",
    summaryIds: ["summary-alpha"],
    title: "Synthetic alpha box"
  }));
  await store.saveBox(box({
    id: "box-mixed",
    personId: "person-alpha",
    summaryIds: ["summary-alpha", "summary-beta"],
    title: "Synthetic mixed dependency box"
  }));
  await store.saveAnchor(anchor());
  await store.saveTrace(trace());
  await store.saveProposal(proposal());

  let closed = false;
  return {
    tempDir,
    databasePath,
    configPath,
    config,
    store,
    clock,
    faultInjector,
    async cleanup() {
      if (!closed) {
        store.close();
        closed = true;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  };
};
