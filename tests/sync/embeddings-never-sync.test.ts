import { describe, expect, it } from "vitest";
import { ContractionRunner } from "../../src/daemon/contraction-runner.js";
import type { ContractionJob, WriteAuthority } from "../../src/daemon/types.js";
import type { CanonicalEvent, MemorySource, Person } from "../../src/domain/canonical.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import {
  CommitLocalSyncOperationInputSchema,
  SyncOperationKindSchema,
  syncEffectFingerprint,
  type CommitLocalSyncOperationInput
} from "../../src/storage/sync-contracts.js";
import { DifferingIdentityEmbedder } from "../embeddings/fixtures.js";

/**
 * SC3 (REQ-043, ADR 0047): embeddings are a PER-DEVICE cache. A slice that writes vectors must add
 * nothing to the sync outbox, and no vector may ride any sync payload.
 *
 * This asserts a negative, so each assertion below states exactly what it pins — a negative test
 * that only checks "no row that looks like a vector" is worth very little, because it passes on the
 * day someone invents a differently-shaped row.
 *
 * No model files, no network, no LLM: `DifferingIdentityEmbedder` is the shared fixture from Plan
 * 12-01. It is imported rather than re-implemented on purpose — a locally-defined fake whose
 * advertised and emitted identities coincide is the exact fixture shape that hid GAP-12-A for a
 * whole phase.
 */

const PERSON_ID = "person_sc3";
const SCOPE_ID = "scope_sc3";
const DEVICE_ID = "device_sc3";
const FIXED_NOW = "2026-07-28T12:00:00.000Z";

describe("embeddings never reach the sync wire (SC3)", () => {
  it("adds no sync outbox operation for a slice that writes summaries and vectors", async () => {
    const store = await seededStore();
    const embedder = new DifferingIdentityEmbedder();
    await store.commitLocalSyncOperation(existingOutboxOperation());
    const before = await store.listSyncOutboxOperations(PERSON_ID);
    expect(before).toHaveLength(1);

    const slice = await runSlice(store, embedder);
    expect(slice.embedded.persisted).toBeGreaterThan(0);

    // ASSERTION 1 — no outbox growth, pinned by DEEP EQUALITY against a pre-slice snapshot, not by
    // "no new vector-shaped row". Same length, same rows, byte-for-byte the same fields.
    expect(await store.listSyncOutboxOperations(PERSON_ID)).toEqual(before);
  });

  it("pins the sync operation-kind enum to its exact seven closed values", async () => {
    // ASSERTION 2 — the tripwire, and the assertion with the real long-term value. ADR 0047 makes
    // `SyncOperationKind` a CLOSED enum, which is the architectural reason a vector cannot cross the
    // wire: there is no kind that could carry one. This turns that invariant into a test that fails
    // loudly the day someone adds an eighth kind, forcing them to think about vectors first.
    expect(SyncOperationKindSchema.options).toEqual([
      "canonical_append",
      "host_event_ingest",
      "proposal_decision",
      "reviewed_box_decision",
      "source_revocation",
      "source_deletion",
      "quarantine_resolution"
    ]);
  });

  it("keeps vectors in the sidecar table only, with Summary.embedding left null", async () => {
    const store = await seededStore();
    const embedder = new DifferingIdentityEmbedder();
    await runSlice(store, embedder);

    const summaries = await store.listSummaries();
    expect(summaries.length).toBeGreaterThan(0);
    for (const summary of summaries) {
      // ASSERTION 3 — `SummarySchema.embedding` carries a full `vector: number[]`, so a populated
      // field is the one latent path by which a vector could ride a future summary-bearing sync
      // operation. The daemon must leave it null while the sidecar row exists.
      expect(summary.embedding).toBeNull();
      const vector = await store.getSummaryVector(summary.id, embedder.provider, embedder.model);
      expect(vector).not.toBeNull();
      expect(vector?.dimensions).toBe(embedder.dimensions);
      expect(vector?.vector).toHaveLength(embedder.dimensions);
    }
  });

  it("has no vector bytes anywhere in the serialized outbox", async () => {
    const store = await seededStore();
    const embedder = new DifferingIdentityEmbedder();
    await store.commitLocalSyncOperation(existingOutboxOperation());
    await runSlice(store, embedder);

    const summary = (await store.listSummaries())[0]!;
    const vector = await store.getSummaryVector(summary.id, embedder.provider, embedder.model);
    expect(vector).not.toBeNull();
    const serialized = JSON.stringify(await store.listSyncOutboxOperations(PERSON_ID));

    // ASSERTION 4 — DEFENCE IN DEPTH, and deliberately the WEAKEST of the four. A byte scan proves
    // nothing about shapes it was not told to look for; assertions 1-3 are the load-bearing ones.
    // It is here only to catch an accidental blob smuggled through an unexpected field.
    const probe = String(vector!.vector[0]);
    // Guard the guard: a degenerate probe like "0" appears in every JSON payload and would make the
    // assertion below silently vacuous.
    expect(probe.length).toBeGreaterThan(3);
    expect(serialized).not.toContain("summary_vectors");
    expect(serialized).not.toContain(probe);
  });
});

async function runSlice(store: InMemoryStore, embedder: DifferingIdentityEmbedder) {
  await seedEvents(store, [
    event("sc3-1", 1, "Alpha roadmap milestones.", 0),
    event("sc3-2", 2, "Switch to Beta pricing negotiation.", 1)
  ]);
  const job = await enqueue(store, "job-sc3", "sc3-1", "sc3-2");
  return new ContractionRunner(store, {
    clock: { now: () => FIXED_NOW, monotonicNow: () => 0 },
    authority: foregroundAuthority(),
    summaryEmbedder: embedder
  }).drainSlice(PERSON_ID, job.id);
}

function foregroundAuthority(): WriteAuthority {
  return { kind: "foreground", personId: PERSON_ID, operation: "historical-bootstrap" };
}

const existingOutboxOperation = (): CommitLocalSyncOperationInput =>
  CommitLocalSyncOperationInputSchema.parse({
    operation: "local_sync_operation",
    personId: PERSON_ID,
    deviceId: DEVICE_ID,
    operationKind: "canonical_append",
    targetId: "event_pre_existing",
    outboxId: "outbox_sc3_1",
    expectedFrontierSequence: 0,
    deviceSequence: 1,
    predecessorDigest: null,
    effectFingerprint: syncEffectFingerprint({ targetId: "event_pre_existing" }),
    committedAt: FIXED_NOW,
    receipt: {
      operation: "local_sync_operation",
      status: "COMMITTED",
      personId: PERSON_ID,
      targetId: "event_pre_existing",
      committedAt: FIXED_NOW
    }
  });

async function seededStore(): Promise<InMemoryStore> {
  const store = new InMemoryStore();
  const person: Person = { id: PERSON_ID, displayName: null, createdAt: FIXED_NOW };
  const source: MemorySource = {
    id: `source_${PERSON_ID}`,
    personId: PERSON_ID,
    application: "synthetic",
    profileId: "default",
    instanceId: "test",
    scopeId: SCOPE_ID,
    createdAt: FIXED_NOW,
    lastImportedAt: FIXED_NOW
  };
  await store.savePerson(person);
  await store.saveSource(source);
  return store;
}

async function seedEvents(store: InMemoryStore, events: CanonicalEvent[]): Promise<void> {
  for (const item of events) await store.saveCanonicalEvent(item);
}

function event(id: string, nativeSequence: number, content: string, minuteOffset: number): CanonicalEvent {
  return {
    id,
    personId: PERSON_ID,
    sourceId: `source_${PERSON_ID}`,
    sourceApplication: "synthetic",
    sourceProfileId: "default",
    scopeId: SCOPE_ID,
    nativeSessionId: "session-synthetic",
    nativeEventId: id,
    nativeSequence,
    causalParentId: null,
    eventKind: "message",
    role: "user",
    content,
    occurredAt: new Date(Date.parse(FIXED_NOW) + minuteOffset * 60_000).toISOString(),
    importedAt: FIXED_NOW,
    provenance: "direct_user_input",
    trustLevel: "high",
    contentHash: `hash-${id}`,
    parserVersion: "synthetic/v1",
    metadata: {}
  };
}

async function enqueue(
  store: InMemoryStore,
  id: string,
  earliestId: string,
  latestId: string
): Promise<ContractionJob> {
  const events = await store.listCanonicalEvents(PERSON_ID);
  const byId = new Map(events.map((item) => [item.id, item]));
  const orderKey = (eventId: string) => {
    const item = byId.get(eventId);
    if (!item) throw new Error(`Missing synthetic event ${eventId}`);
    return { occurredAt: item.occurredAt, nativeSequence: item.nativeSequence, id: item.id };
  };
  const job: ContractionJob = {
    id,
    personId: PERSON_ID,
    generation: 1,
    earliestAffected: orderKey(earliestId),
    latestAffected: orderKey(latestId),
    state: "pending",
    attempts: 0,
    immediateDirty: true,
    proposalDirty: true,
    lastProposalRunAt: null,
    lastActivityAt: FIXED_NOW,
    nextDueAt: FIXED_NOW,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW
  };
  await store.saveContractionJob(job);
  return job;
}
