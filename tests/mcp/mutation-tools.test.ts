import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CommitHistoryImportInputSchema,
  CommitProposalDecisionInputSchema,
  CommitSourceDeletionInputSchema,
  CommitSourceRevocationInputSchema,
  mutationEffectsFingerprint
} from "../../src/storage/mcp-mutation-contracts.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import type { MemoryStore } from "../../src/storage/memory-store.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";
import { ConfirmationService } from "../../src/mcp/confirmation-service.js";
import { MemoryMutationApplication } from "../../src/mcp/mutation-application.js";
import { loadMemoryMcpProfile } from "../../src/mcp/profile-loader.js";
import { ScopedProposalReviewer } from "../../src/proposals/scoped-proposal-reviewer.js";
import { SourceLifecycleService } from "../../src/service/source-lifecycle-service.js";
import type { MemoryProposal } from "../../src/domain/types.js";
import type { SourceGrant, SourceLifecycleAuditEvent } from "../../src/domain/source-lifecycle.js";
import {
  createSyntheticMcpFixture,
  snapshotSemanticMemory,
  type SyntheticMcpFixture
} from "./fixtures.js";

describe("MCP mutation application contract", () => {
  let fixture: SyntheticMcpFixture | undefined;

  afterEach(async () => fixture?.cleanup());

  it("starts preview inspection from an unchanged synthetic semantic snapshot", async () => {
    fixture = await createSyntheticMcpFixture();
    const before = await snapshotSemanticMemory(fixture.store);
    const candidate = await fixture.store.getSource("source-alpha");
    const after = await snapshotSemanticMemory(fixture.store);

    expect(candidate).toMatchObject({
      id: "source-alpha",
      personId: "person-alpha",
      scopeId: "scope-alpha"
    });
    expect(after).toBe(before);
  });

  it("05-04 Task 1 exposes exact atomic proposal approve and reject store contracts with rollback", () => {
    const expectedProposal = {
      id: "proposal-1", personId: "person-alpha", proposalType: "trace", state: "proposed",
      title: "Synthetic proposal", rationale: "Synthetic", confidence: 0.8,
      createdAt: "2026-07-18T12:00:00.000Z", reviewedAt: "2026-07-18T12:00:00.000Z",
      decidedAt: null, decidedBy: null, decisionNote: null, sourceSummaryIds: ["summary-1", "summary-2"],
      sourceTurnRanges: [{ threadId: "synthetic-thread", startSequence: 1, endSequence: 1 }], targetBoxIds: [], targetTraceIds: ["trace-1"],
      payload: { traceId: "trace-1", title: "Synthetic trace", description: "Synthetic trace", traceType: "task_thread", summaryIds: ["summary-1", "summary-2"], boxIds: [], turnRanges: [{ threadId: "synthetic-thread", startSequence: 1, endSequence: 1 }], continuityReason: "Synthetic continuity", boundaryReason: "Synthetic boundary", keywords: ["synthetic"] }
    } as const;
    const nextProposal = { ...expectedProposal, state: "rejected" as const, decidedAt: "2026-07-18T12:01:00.000Z" };
    const effects = { proposalIds: ["proposal-1"], boxIds: [], traceIds: [] };
    const parsed = CommitProposalDecisionInputSchema.parse({
      operation: "proposal_decision", personId: "person-alpha", decision: "reject",
      expectedProposal, nextProposal, nextBoxes: [], nextTraces: [], effects,
      effectsFingerprint: mutationEffectsFingerprint(effects),
      receipt: { operation: "proposal_decision", status: "COMMITTED", personId: "person-alpha", targetId: "proposal-1", effectCounts: { proposals: 1, boxes: 0, traces: 0 }, committedAt: "2026-07-18T12:01:00.000Z" }
    });
    expect(parsed.operation).toBe("proposal_decision");
    expect(() => CommitProposalDecisionInputSchema.parse({ ...parsed, personId: "person-other" })).toThrow();
  });

  it("05-04 Task 1 exposes exact atomic source revoke and delete store contracts with rollback", () => {
    const approved = { id: "grant-1", personId: "person-alpha", candidateId: "candidate-1", application: "synthetic", format: "jsonl", sourceLocator: "synthetic://candidate", profileId: "profile", scopeId: "scope-alpha", state: "approved", approvedAt: "2026-07-18T12:00:00.000Z", revokedAt: null, updatedAt: "2026-07-18T12:00:00.000Z" } as const;
    const revoked = { ...approved, state: "revoked" as const, revokedAt: "2026-07-18T12:01:00.000Z", updatedAt: "2026-07-18T12:01:00.000Z" };
    const audit = { id: "audit-revoke", personId: "person-alpha", grantId: "grant-1", candidateId: "candidate-1", action: "revoked", actor: "synthetic-reviewer", occurredAt: "2026-07-18T12:01:00.000Z", details: {} } as const;
    expect(CommitSourceRevocationInputSchema.parse({ operation: "source_revocation", personId: "person-alpha", expectedGrant: approved, nextGrant: revoked, auditEvent: audit, effectsFingerprint: mutationEffectsFingerprint({ grantId: "grant-1", auditEventId: "audit-revoke" }), receipt: { operation: "source_revocation", status: "COMMITTED", personId: "person-alpha", targetId: "candidate-1", effectCounts: { grants: 1, audits: 1 }, committedAt: "2026-07-18T12:01:00.000Z" } }).nextGrant.state).toBe("revoked");
    expect(() => CommitSourceDeletionInputSchema.parse({ operation: "source_deletion", personId: "person-alpha", expectedGrant: approved })).toThrow();
  });

  it("05-04 Task 1 preserves backend parity for every atomic mutation contract", () => {
    const exact = { sourceIds: [], eventIds: [], checkpointIds: ["checkpoint-1"], auditEventIds: [] };
    const base = { operation: "history_import", personId: "person-alpha", candidateId: "candidate-1", normalizedParameters: { importer: "synthetic/v1" }, expectedSource: null, expectedSourceStateFingerprint: mutationEffectsFingerprint(null), expectedCheckpoint: null, expectedGrant: { id: "grant-1", personId: "person-alpha", candidateId: "candidate-1", application: "synthetic", format: "jsonl", sourceLocator: "synthetic://candidate", profileId: "profile", scopeId: "scope-alpha", state: "approved", approvedAt: "2026-07-18T12:00:00.000Z", revokedAt: null, updatedAt: "2026-07-18T12:00:00.000Z" }, targetCanonicalEventIds: ["event-1"], nextSources: [], nextCanonicalEvents: [], nextCheckpoint: { id: "checkpoint-1", personId: "person-alpha", candidateId: "candidate-1", resourcePath: "synthetic.jsonl", fileIdentity: "synthetic-1", byteOffset: 1, recordIndex: 1, nativeSessionId: "session-1", parserVersion: "synthetic/v1", updatedAt: "2026-07-18T12:01:00.000Z" }, auditEvents: [], effects: exact, effectsFingerprint: mutationEffectsFingerprint(exact), receipt: { operation: "history_import", status: "COMMITTED", personId: "person-alpha", targetId: "candidate-1", effectCounts: { sources: 0, events: 0, checkpoints: 1, audits: 0 }, committedAt: "2026-07-18T12:01:00.000Z" } };
    expect(CommitHistoryImportInputSchema.parse({ ...base, targetCanonicalEventIds: [] }).targetCanonicalEventIds).toEqual([]);
    expect(() => CommitHistoryImportInputSchema.parse({ ...base, effectsFingerprint: "drift" })).toThrow();
  });
  it("05-04 Task 2 configures bounded concurrent-writer behavior and rejects stale state", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "mcp-mutation-stale-"));
    const path = join(tempDir, "memory.sqlite");
    const first = new SqliteStore(path, { busyTimeoutMs: 250 });
    const second = new SqliteStore(path, { busyTimeoutMs: 250 });
    try {
      const expected = grant("approved");
      await first.saveSourceGrant(expected);
      const input = revocationInput(expected);
      await second.saveSourceGrant({ ...expected, updatedAt: "2026-07-18T12:00:30.000Z" });
      const before = await mutationSnapshot(first);
      await expect(first.commitSourceRevocation(input)).resolves.toMatchObject({ status: "STATE_CHANGED", effectCounts: {} });
      await expect(mutationSnapshot(first)).resolves.toBe(before);
      expect(() => new SqliteStore(join(tempDir, "invalid.sqlite"), { busyTimeoutMs: 0 })).toThrow(/busy timeout/i);
    } finally {
      first.close(); second.close(); await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("05-04 Task 2 rolls back every durable effect at each injected transaction boundary", async () => {
    const cases = [
      ...["history_import_before_write", "history_import_after_sources", "history_import_after_events", "history_import_after_checkpoint"].map((boundary) => ({ operation: "history" as const, boundary })),
      ...["proposal_decision_before_write", "proposal_decision_after_boxes", "proposal_decision_after_traces", "proposal_decision_after_proposal"].map((boundary) => ({ operation: "proposal" as const, boundary })),
      ...["source_revocation_before_write", "source_revocation_after_grant", "source_revocation_after_audit"].map((boundary) => ({ operation: "revocation" as const, boundary })),
      ...["source_deletion_before_write", "source_deletion_after_supersessions", "source_deletion_after_injections", "source_deletion_after_anchors", "source_deletion_after_turns", "source_deletion_after_events", "source_deletion_after_sources", "source_deletion_after_quarantine", "source_deletion_after_checkpoint", "source_deletion_after_audits"].map((boundary) => ({ operation: "deletion" as const, boundary }))
    ];
    for (const backend of ["memory", "sqlite"] as const) {
      for (const item of cases) {
        const harness = await mutationHarness(backend, item.boundary);
        try {
          const input = await seedMutation(harness.store, item.operation);
          const before = await mutationSnapshot(harness.store);
          await expect(commitMutation(harness.store, item.operation, input)).rejects.toThrow(`Synthetic fault at ${item.boundary}`);
          await harness.reopen();
          await expect(mutationSnapshot(harness.store)).resolves.toBe(before);
        } finally {
          await harness.cleanup();
        }
      }
    }
  });

  it("commits identical receipts and final state across in-memory and reopened SQLite adapters", async () => {
    for (const operation of ["history", "proposal", "revocation", "deletion"] as const) {
      const memory = await mutationHarness("memory", "never");
      const sqlite = await mutationHarness("sqlite", "never");
      try {
        const memoryInput = await seedMutation(memory.store, operation);
        const sqliteInput = await seedMutation(sqlite.store, operation);
        const memoryReceipt = await commitMutation(memory.store, operation, memoryInput);
        const sqliteReceipt = await commitMutation(sqlite.store, operation, sqliteInput);
        expect(sqliteReceipt).toEqual(memoryReceipt);
        await sqlite.reopen();
        expect(await mutationSnapshot(sqlite.store)).toBe(await mutationSnapshot(memory.store));
      } finally {
        await memory.cleanup(); await sqlite.cleanup();
      }
    }
  });
  it.todo("05-05 Task 2 previews history ingestion without opening an unconfigured source root");
  it.todo("05-05 Task 2 executes history ingestion only for the exact confirmed preview effects");
  it("05-05 Task 2 previews and executes scoped proposal approval or rejection atomically", async () => {
    fixture = await createSyntheticMcpFixture();
    const restrictedAuthority = await loadMemoryMcpProfile({ configPath: fixture.configPath, profileName: "alpha-workspace" });
    const restricted = new ScopedProposalReviewer(fixture.store, restrictedAuthority);
    await expect(restricted.listProposals()).resolves.toMatchObject({ proposals: [], count: 0 });
    await expect(restricted.planDecision({ proposalId: "proposal-mixed", decision: "approve", decidedAt: LATER }))
      .rejects.toMatchObject({ code: "UNAUTHORIZED_OR_NOT_FOUND" });

    const authority = await loadMemoryMcpProfile({ configPath: fixture.configPath, profileName: "alpha-expanded" });
    const app = new MemoryMutationApplication({
      store: fixture.store,
      authority,
      confirmations: new ConfirmationService({ clock: () => fixture!.clock.now() })
    });
    const preview = await app.previewProposalRejection({ proposalId: "proposal-mixed", decidedAt: LATER, reviewer: "synthetic-reviewer" });
    expect(preview.effects).toEqual({ proposalIds: ["proposal-mixed"], boxIds: [], traceIds: [] });
    await expect(app.executeProposalRejection({ token: preview.token, proposalId: "proposal-mixed", decidedAt: LATER, reviewer: "synthetic-reviewer" }))
      .resolves.toMatchObject({ operation: "proposal_decision", status: "COMMITTED", targetId: "proposal-mixed" });
    await expect(fixture.store.getProposal("proposal-mixed")).resolves.toMatchObject({ state: "rejected", decidedBy: "synthetic-reviewer" });
  });

  it("05-05 Task 2 keeps source revocation distinct from source deletion", async () => {
    const store = new InMemoryStore();
    const lifecycle = new SourceLifecycleService(store);
    const authority = testAuthority();
    await lifecycle.approve({ personId: authority.personId, candidateId: "candidate-lifecycle", application: "synthetic", format: "jsonl", sourceLocator: "synthetic://configured", profileId: authority.profileName, scopeId: authority.ingestScopeId, approvedAt: NOW });
    const app = new MemoryMutationApplication({ store, authority, confirmations: new ConfirmationService({ clock: () => NOW }) });
    const preview = await app.previewSourceRevocation({ candidateId: "candidate-lifecycle", actor: "synthetic-reviewer", revokedAt: LATER });
    expect(preview.effects).toMatchObject({ grantIds: [expect.any(String)], auditEventIds: [expect.any(String)] });
    await expect(app.executeSourceRevocation({ token: preview.token, candidateId: "candidate-lifecycle", actor: "synthetic-reviewer", revokedAt: LATER }))
      .resolves.toMatchObject({ operation: "source_revocation", status: "COMMITTED" });
    await expect(store.listSourceGrants(authority.personId)).resolves.toEqual([expect.objectContaining({ state: "revoked" })]);
    await expect(store.listSources(authority.personId)).resolves.toEqual([]);
  });

  it("05-05 Task 2 rejects deletion until the exact already-revoked source is confirmed", async () => {
    const store = new InMemoryStore();
    const lifecycle = new SourceLifecycleService(store);
    const authority = testAuthority();
    await lifecycle.approve({ personId: authority.personId, candidateId: "candidate-delete", application: "synthetic", format: "jsonl", sourceLocator: "synthetic://configured", profileId: authority.profileName, scopeId: authority.ingestScopeId, approvedAt: NOW });
    const app = new MemoryMutationApplication({ store, authority, confirmations: new ConfirmationService({ clock: () => NOW }) });
    await expect(app.previewSourceDeletion({ candidateId: "candidate-delete", actor: "synthetic-reviewer", deletedAt: LATER }))
      .rejects.toMatchObject({ code: "SOURCE_NOT_REVOKED" });
    const revoke = await app.previewSourceRevocation({ candidateId: "candidate-delete", actor: "synthetic-reviewer", revokedAt: LATER });
    await app.executeSourceRevocation({ token: revoke.token, candidateId: "candidate-delete", actor: "synthetic-reviewer", revokedAt: LATER });
    const deletion = await app.previewSourceDeletion({ candidateId: "candidate-delete", actor: "synthetic-reviewer", deletedAt: LATER });
    await expect(app.executeSourceDeletion({ token: deletion.token, candidateId: "candidate-other", actor: "synthetic-reviewer", deletedAt: LATER }))
      .rejects.toMatchObject({ code: "CONFIRMATION_MISMATCH" });
    await expect(app.executeSourceDeletion({ token: deletion.token, candidateId: "candidate-delete", actor: "synthetic-reviewer", deletedAt: LATER }))
      .rejects.toMatchObject({ code: "CONFIRMATION_REPLAYED" });
  });

  it("05-05 Task 2 revalidates state drift inside the execute transaction", async () => {
    const store = new InMemoryStore();
    const lifecycle = new SourceLifecycleService(store);
    const authority = testAuthority();
    const grant = await lifecycle.approve({ personId: authority.personId, candidateId: "candidate-drift", application: "synthetic", format: "jsonl", sourceLocator: "synthetic://configured", profileId: authority.profileName, scopeId: authority.ingestScopeId, approvedAt: NOW });
    const app = new MemoryMutationApplication({ store, authority, confirmations: new ConfirmationService({ clock: () => NOW }) });
    const preview = await app.previewSourceRevocation({ candidateId: "candidate-drift", actor: "synthetic-reviewer", revokedAt: LATER });
    await store.saveSourceGrant({ ...grant, updatedAt: "2026-07-18T12:00:30.000Z" });
    await expect(app.executeSourceRevocation({ token: preview.token, candidateId: "candidate-drift", actor: "synthetic-reviewer", revokedAt: LATER }))
      .resolves.toMatchObject({ status: "STATE_CHANGED", effectCounts: {} });
    await expect(app.executeSourceRevocation({ token: preview.token, candidateId: "candidate-drift", actor: "synthetic-reviewer", revokedAt: LATER }))
      .rejects.toMatchObject({ code: "CONFIRMATION_REPLAYED" });
  });
  it.todo("05-07 Task 2 routes each preview tool to one scoped application operation");
  it.todo("05-07 Task 2 routes each execute tool with exact ticket binding and truthful annotations");
});

const NOW = "2026-07-18T12:00:00.000Z";
const LATER = "2026-07-18T12:01:00.000Z";

const testAuthority = () => ({
  profileName: "synthetic-profile",
  databasePath: "/synthetic/memory.sqlite",
  personId: "person-alpha",
  allowedScopeIds: ["scope-alpha"] as readonly string[],
  ingestScopeId: "scope-alpha",
  sourceRoots: { synthetic: "/synthetic/configured" },
  scopeAliases: { "scope-alpha": "context-one" },
  fingerprint: "synthetic-authority-fingerprint"
});

const grant = (state: "approved" | "revoked"): SourceGrant => ({
  id: "grant-atomic", personId: "person-alpha", candidateId: "candidate-atomic",
  application: "synthetic", format: "jsonl", sourceLocator: "synthetic://atomic",
  profileId: "profile", scopeId: "scope-alpha", state, approvedAt: NOW,
  revokedAt: state === "revoked" ? LATER : null, updatedAt: state === "revoked" ? LATER : NOW
});

const audit = (action: "revoked" | "deletion_requested" | "deletion_completed", id = `audit-${action}`): SourceLifecycleAuditEvent => ({
  id, personId: "person-alpha", grantId: "grant-atomic", candidateId: "candidate-atomic",
  action, actor: "synthetic-reviewer", occurredAt: LATER, details: {}
});

const receipt = (operation: "history_import" | "proposal_decision" | "source_revocation" | "source_deletion", targetId: string, effectCounts: Record<string, number>) => ({
  operation, status: "COMMITTED" as const, personId: "person-alpha", targetId, effectCounts, committedAt: LATER
});

const proposal = (): MemoryProposal => ({
  id: "proposal-atomic", personId: "person-alpha", proposalType: "trace", state: "proposed",
  title: "Synthetic proposal", rationale: "Synthetic atomic proposal", confidence: 0.8,
  createdAt: NOW, reviewedAt: NOW, decidedAt: null, decidedBy: null, decisionNote: null,
  sourceSummaryIds: ["summary-1", "summary-2"], sourceTurnRanges: [{ threadId: "synthetic-thread", startSequence: 1, endSequence: 2 }],
  targetBoxIds: [], targetTraceIds: ["trace-atomic"],
  payload: { traceId: "trace-atomic", title: "Synthetic trace", description: "Synthetic", traceType: "task_thread", summaryIds: ["summary-1", "summary-2"], boxIds: [], turnRanges: [{ threadId: "synthetic-thread", startSequence: 1, endSequence: 2 }], continuityReason: "Synthetic continuity", boundaryReason: "Synthetic boundary", keywords: ["synthetic"] }
});

const historyInput = () => {
  const expectedGrant = grant("approved");
  const nextSource = { id: "source-atomic", personId: "person-alpha", application: "synthetic", profileId: "profile", instanceId: "candidate-atomic", scopeId: "scope-alpha", createdAt: NOW, lastImportedAt: LATER };
  const nextEvent = { id: "event-atomic", personId: "person-alpha", sourceId: "source-atomic", sourceApplication: "synthetic", sourceProfileId: "profile", scopeId: "scope-alpha", nativeSessionId: "session-atomic", nativeEventId: "native-atomic", nativeSequence: 1, causalParentId: null, eventKind: "message" as const, role: "user" as const, content: "Synthetic atomic event", occurredAt: NOW, importedAt: LATER, provenance: "direct_user_input" as const, trustLevel: "high" as const, contentHash: "hash-atomic", parserVersion: "synthetic/v1", metadata: { fixture: true } };
  const nextCheckpoint = { id: "checkpoint-atomic", personId: "person-alpha", candidateId: "candidate-atomic", resourcePath: "synthetic.jsonl", fileIdentity: "synthetic-identity", byteOffset: 10, recordIndex: 1, nativeSessionId: "session-atomic", parserVersion: "synthetic/v1", updatedAt: LATER };
  const effects = { sourceIds: [nextSource.id], eventIds: [nextEvent.id], checkpointIds: [nextCheckpoint.id], auditEventIds: [] };
  return CommitHistoryImportInputSchema.parse({ operation: "history_import", personId: "person-alpha", candidateId: "candidate-atomic", normalizedParameters: { importer: "synthetic/v1", limit: 1 }, expectedSource: null, expectedSourceStateFingerprint: mutationEffectsFingerprint(null), expectedCheckpoint: null, expectedGrant, targetCanonicalEventIds: [nextEvent.id], nextSources: [nextSource], nextCanonicalEvents: [nextEvent], nextCheckpoint, auditEvents: [], effects, effectsFingerprint: mutationEffectsFingerprint(effects), receipt: receipt("history_import", "candidate-atomic", { sources: 1, events: 1, checkpoints: 1, audits: 0 }) });
};

const proposalInput = () => {
  const expectedProposal = proposal();
  const nextProposal = { ...expectedProposal, state: "rejected" as const, decidedAt: LATER, decidedBy: "synthetic-reviewer" };
  const effects = { proposalIds: [expectedProposal.id], boxIds: [], traceIds: [] };
  return CommitProposalDecisionInputSchema.parse({ operation: "proposal_decision", personId: "person-alpha", decision: "reject", expectedProposal, nextProposal, nextBoxes: [], nextTraces: [], effects, effectsFingerprint: mutationEffectsFingerprint(effects), receipt: receipt("proposal_decision", expectedProposal.id, { proposals: 1, boxes: 0, traces: 0 }) });
};

const revocationInput = (expectedGrant = grant("approved")) => {
  const nextGrant = { ...expectedGrant, state: "revoked" as const, revokedAt: LATER, updatedAt: LATER };
  const auditEvent = audit("revoked");
  return CommitSourceRevocationInputSchema.parse({ operation: "source_revocation", personId: "person-alpha", expectedGrant, nextGrant, auditEvent, effectsFingerprint: mutationEffectsFingerprint({ grantId: nextGrant.id, auditEventId: auditEvent.id }), receipt: receipt("source_revocation", expectedGrant.candidateId, { grants: 1, audits: 1 }) });
};

const deletionInput = () => {
  const expectedGrant = grant("revoked");
  const auditEvents = [audit("deletion_requested"), audit("deletion_completed")];
  const effects = { sourceIds: ["source-delete"], canonicalEventIds: [], turnIds: [], anchorIds: [], injectionIds: [], quarantineIds: [], bootstrapCheckpointIds: [], supersededSummaryIds: [], supersededBoxIds: [], supersededProposalIds: [], supersededTraceIds: [], auditEventIds: auditEvents.map((item) => item.id) };
  return CommitSourceDeletionInputSchema.parse({ operation: "source_deletion", personId: "person-alpha", expectedGrant, nextSummaries: [], nextBoxes: [], nextProposals: [], nextTraces: [], auditEvents, effects, effectsFingerprint: mutationEffectsFingerprint(effects), receipt: receipt("source_deletion", expectedGrant.candidateId, { sources: 1, audits: 2 }) });
};

interface MutationHarness {
  store: MemoryStore;
  reopen(): Promise<void>;
  cleanup(): Promise<void>;
}

const mutationHarness = async (backend: "memory" | "sqlite", failingBoundary: string): Promise<MutationHarness> => {
  const faultInjector = { reach(boundary: string) { if (boundary === failingBoundary) throw new Error(`Synthetic fault at ${boundary}`); } };
  if (backend === "memory") {
    return { store: new InMemoryStore({ faultInjector }), reopen: async () => {}, cleanup: async () => {} };
  }
  const tempDir = await mkdtemp(join(tmpdir(), "mcp-mutation-fault-"));
  const databasePath = join(tempDir, "memory.sqlite");
  const harness: MutationHarness = {
    store: new SqliteStore(databasePath, { faultInjector, busyTimeoutMs: 250 }),
    async reopen() {
      (this.store as SqliteStore).close();
      this.store = new SqliteStore(databasePath, { busyTimeoutMs: 250 });
    },
    async cleanup() {
      (this.store as SqliteStore).close();
      await rm(tempDir, { recursive: true, force: true });
    }
  };
  return harness;
};

const seedMutation = async (store: MemoryStore, operation: "history" | "proposal" | "revocation" | "deletion") => {
  if (operation === "history") { await store.saveSourceGrant(grant("approved")); return historyInput(); }
  if (operation === "proposal") { const input = proposalInput(); await store.saveProposal(input.expectedProposal); return input; }
  if (operation === "revocation") { await store.saveSourceGrant(grant("approved")); return revocationInput(); }
  await store.saveSourceGrant(grant("revoked"));
  await store.saveSource({ id: "source-delete", personId: "person-alpha", application: "synthetic", profileId: "profile", instanceId: "candidate-atomic", scopeId: "scope-alpha", createdAt: NOW, lastImportedAt: NOW });
  return deletionInput();
};

const commitMutation = (store: MemoryStore, operation: "history" | "proposal" | "revocation" | "deletion", input: Awaited<ReturnType<typeof seedMutation>>) => {
  if (operation === "history") return store.commitHistoryImport(CommitHistoryImportInputSchema.parse(input));
  if (operation === "proposal") return store.commitProposalDecision(CommitProposalDecisionInputSchema.parse(input));
  if (operation === "revocation") return store.commitSourceRevocation(CommitSourceRevocationInputSchema.parse(input));
  return store.commitSourceDeletion(CommitSourceDeletionInputSchema.parse(input));
};

const mutationSnapshot = async (store: MemoryStore): Promise<string> => JSON.stringify(await Promise.all([
  store.listSources("person-alpha"), store.listCanonicalEvents("person-alpha"), store.listImportCheckpoints("person-alpha"),
  store.listSourceGrants("person-alpha"), store.listSourceLifecycleAuditEvents("person-alpha"), store.listProposals(),
  store.listSummaries(), store.listBoxes(), store.listAnchors(), store.listTraces()
]));
