import { afterEach, describe, expect, it } from "vitest";
import {
  CommitHistoryImportInputSchema,
  CommitProposalDecisionInputSchema,
  CommitSourceDeletionInputSchema,
  CommitSourceRevocationInputSchema,
  mutationEffectsFingerprint
} from "../../src/storage/mcp-mutation-contracts.js";
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
      decidedAt: null, decidedBy: null, decisionNote: null, sourceSummaryIds: [],
      sourceTurnRanges: [], targetBoxIds: [], targetTraceIds: [], payload: {}
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
    const exact = { sourceIds: ["source-1"], eventIds: ["event-1"], checkpointIds: ["checkpoint-1"], auditEventIds: ["audit-1"] };
    const base = { operation: "history_import", personId: "person-alpha", candidateId: "candidate-1", normalizedParameters: { importer: "synthetic/v1" }, expectedSource: null, expectedSourceStateFingerprint: mutationEffectsFingerprint(null), expectedCheckpoint: null, expectedGrant: { id: "grant-1", personId: "person-alpha", candidateId: "candidate-1", application: "synthetic", format: "jsonl", sourceLocator: "synthetic://candidate", profileId: "profile", scopeId: "scope-alpha", state: "approved", approvedAt: "2026-07-18T12:00:00.000Z", revokedAt: null, updatedAt: "2026-07-18T12:00:00.000Z" }, targetCanonicalEventIds: ["event-1"], nextSources: [], nextCanonicalEvents: [], nextCheckpoint: { id: "checkpoint-1", personId: "person-alpha", candidateId: "candidate-1", resourcePath: "synthetic.jsonl", fileIdentity: "synthetic-1", byteOffset: 1, recordIndex: 1, nativeSessionId: "session-1", parserVersion: "synthetic/v1", updatedAt: "2026-07-18T12:01:00.000Z" }, auditEvents: [], effects: exact, effectsFingerprint: mutationEffectsFingerprint(exact), receipt: { operation: "history_import", status: "COMMITTED", personId: "person-alpha", targetId: "candidate-1", effectCounts: { sources: 0, events: 0, checkpoints: 1, audits: 0 }, committedAt: "2026-07-18T12:01:00.000Z" } };
    expect(CommitHistoryImportInputSchema.parse(base).targetCanonicalEventIds).toEqual(["event-1"]);
    expect(() => CommitHistoryImportInputSchema.parse({ ...base, effectsFingerprint: "drift" })).toThrow();
  });
  it.todo("05-04 Task 2 configures bounded concurrent-writer behavior and rejects stale state");
  it.todo("05-04 Task 2 rolls back every durable effect at each injected transaction boundary");
  it.todo("05-05 Task 2 previews history ingestion without opening an unconfigured source root");
  it.todo("05-05 Task 2 executes history ingestion only for the exact confirmed preview effects");
  it.todo("05-05 Task 2 previews and executes scoped proposal approval or rejection atomically");
  it.todo("05-05 Task 3 keeps source revocation distinct from source deletion");
  it.todo("05-05 Task 3 rejects deletion until the exact already-revoked source is confirmed");
  it.todo("05-05 Task 3 revalidates state drift inside the execute transaction");
  it.todo("05-07 Task 2 routes each preview tool to one scoped application operation");
  it.todo("05-07 Task 2 routes each execute tool with exact ticket binding and truthful annotations");
});
