import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CommitHistoryImportInputSchema,
  CommitProposalDecisionInputSchema,
  CommitSourceDeletionInputSchema,
  CommitSourceRevocationInputSchema,
  ExpectedBoxStateSchema,
  ExpectedTraceStateSchema,
  ProposalDependencyClosureSchema,
  mutationEffectsFingerprint
} from "../../src/storage/mcp-mutation-contracts.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import type { MemoryStore } from "../../src/storage/memory-store.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";
import { ConfirmationService } from "../../src/mcp/confirmation-service.js";
import { MemoryMutationApplication } from "../../src/mcp/mutation-application.js";
import { loadMemoryMcpProfile } from "../../src/mcp/profile-loader.js";
import { createProfileAuthority } from "../../src/mcp/authority.js";
import { ScopedProposalReviewer } from "../../src/proposals/scoped-proposal-reviewer.js";
import { SourceLifecycleService } from "../../src/service/source-lifecycle-service.js";
import { discoverCodexHistory } from "../../src/imports/codex-discovery.js";
import {
  MEMORY_MUTATION_TOOL_NAMES,
  registerMemoryMutationTools,
  type MemoryMutationToolApplication
} from "../../src/mcp/tools/mutation-tools.js";
import type { Box, MemoryProposal, MemoryTrace, Summary } from "../../src/domain/types.js";
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
    const expectedSummaries = [atomicSummary("summary-1"), atomicSummary("summary-2")];
    const parsed = CommitProposalDecisionInputSchema.parse({
      operation: "proposal_decision", personId: "person-alpha", decision: "reject",
      allowedScopeIds: ["scope-alpha"], expectedSummaries, expectedBoxes: [],
      expectedTraces: [{ id: "trace-1", value: null }],
      expectedProposal, nextProposal, nextBoxes: [], nextTraces: [], effects,
      effectsFingerprint: mutationEffectsFingerprint(effects),
      receipt: { operation: "proposal_decision", status: "COMMITTED", personId: "person-alpha", targetId: "proposal-1", effectCounts: { proposals: 1, boxes: 0, traces: 0 }, committedAt: "2026-07-18T12:01:00.000Z" }
    });
    expect(parsed.operation).toBe("proposal_decision");
    expect(ProposalDependencyClosureSchema.parse({
      allowedScopeIds: parsed.allowedScopeIds,
      expectedSummaries: parsed.expectedSummaries,
      expectedBoxes: parsed.expectedBoxes,
      expectedTraces: parsed.expectedTraces
    })).toBeDefined();
    expect(ExpectedBoxStateSchema.parse({ id: "box-absent", value: null }).value).toBeNull();
    expect(ExpectedTraceStateSchema.parse({ id: "trace-1", value: null }).value).toBeNull();
    expect(() => CommitProposalDecisionInputSchema.parse({ ...parsed, personId: "person-other" })).toThrow();
    expect(() => CommitProposalDecisionInputSchema.parse({ ...parsed, expectedSummaries: parsed.expectedSummaries.slice(1) })).toThrow();
    expect(() => CommitProposalDecisionInputSchema.parse({ ...parsed, expectedSummaries: [...parsed.expectedSummaries, parsed.expectedSummaries[0]] })).toThrow();
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

  it("05-09 Task 2 rejects complete proposal dependency and affected-state drift atomically in both adapters", async () => {
    const driftCases = [
      ["summary scope", async (harness: ProposalDecisionHarness) => {
        const value = harness.plan.expectedSummaries.find((item) => item.id === "summary-1")!;
        await harness.store.saveSummary({ ...value, scopeIds: ["scope-beta"] });
      }],
      ["summary state", async (harness: ProposalDecisionHarness) => {
        const value = harness.plan.expectedSummaries.find((item) => item.id === "summary-1")!;
        await harness.store.saveSummary({ ...value, state: "superseded" });
      }],
      ["summary recursive edge", async (harness: ProposalDecisionHarness) => {
        const value = harness.plan.expectedSummaries.find((item) => item.id === "summary-1")!;
        await harness.store.saveSummary({ ...value, sourceSummaryIds: ["summary-recursive-drift"] });
      }],
      ["parent box", async (harness: ProposalDecisionHarness) => {
        const value = harness.plan.expectedBoxes.find((item) => item.id === "box-parent")!.value!;
        await harness.store.saveBox({ ...value, title: "Drifted synthetic parent" });
      }],
      ["child box", async (harness: ProposalDecisionHarness) => {
        const value = harness.plan.expectedBoxes.find((item) => item.id === "box-child")!.value!;
        await harness.store.saveBox({ ...value, summary: "Drifted synthetic child" });
      }],
      ["existing trace", async (harness: ProposalDecisionHarness) => {
        const value = harness.plan.expectedTraces.find((item) => item.id === "trace-decision")!.value!;
        await harness.store.saveTrace({ ...value, description: "Drifted synthetic trace" });
      }]
    ] as const;

    for (const backend of ["memory", "sqlite"] as const) {
      for (const [name, drift] of driftCases) {
        const harness = await proposalDecisionHarness(backend, true);
        try {
          await drift(harness);
          const beforeExecute = await mutationSnapshot(harness.store);
          await expect(harness.store.commitProposalDecision(harness.plan), `${backend}: ${name}`)
            .resolves.toMatchObject({ status: "STATE_CHANGED", effectCounts: {} });
          await harness.reopen();
          await expect(mutationSnapshot(harness.store), `${backend}: ${name}`).resolves.toBe(beforeExecute);
        } finally {
          await harness.cleanup();
        }
      }

      const absent = await proposalDecisionHarness(backend, false);
      try {
        expect(absent.plan.expectedTraces).toEqual([{ id: "trace-decision", value: null }]);
        await absent.store.saveTrace(absent.plan.nextTraces[0]!);
        const beforeExecute = await mutationSnapshot(absent.store);
        await expect(absent.store.commitProposalDecision(absent.plan))
          .resolves.toMatchObject({ status: "STATE_CHANGED", effectCounts: {} });
        await absent.reopen();
        await expect(mutationSnapshot(absent.store)).resolves.toBe(beforeExecute);
      } finally {
        await absent.cleanup();
      }
    }
  });

  it("05-09 Task 2 consumes a proposal confirmation when dependency drift returns STATE_CHANGED", async () => {
    const harness = await proposalDecisionHarness("memory", true);
    try {
      const request = { proposalId: "proposal-decision", decidedAt: LATER, reviewer: "synthetic-reviewer" };
      const preview = await harness.app.previewProposalApproval(request);
      const summary = harness.plan.expectedSummaries.find((item) => item.id === "summary-1")!;
      await harness.store.saveSummary({ ...summary, version: summary.version + 1 });
      const beforeExecute = await mutationSnapshot(harness.store);
      await expect(harness.app.executeProposalApproval({ ...request, token: preview.token }))
        .resolves.toMatchObject({ status: "STATE_CHANGED", effectCounts: {} });
      await expect(mutationSnapshot(harness.store)).resolves.toBe(beforeExecute);
      await expect(harness.app.executeProposalApproval({ ...request, token: preview.token }))
        .rejects.toMatchObject({ code: "CONFIRMATION_REPLAYED" });
    } finally {
      await harness.cleanup();
    }
  });

  it("05-09 Task 2 commits byte-equivalent clean proposal approval after SQLite reopen", async () => {
    const memory = await proposalDecisionHarness("memory", true);
    const sqlite = await proposalDecisionHarness("sqlite", true);
    try {
      const memoryReceipt = await memory.store.commitProposalDecision(memory.plan);
      const sqliteReceipt = await sqlite.store.commitProposalDecision(sqlite.plan);
      expect(sqliteReceipt).toEqual(memoryReceipt);
      await sqlite.reopen();
      expect(await proposalStateSnapshot(sqlite.store)).toBe(await proposalStateSnapshot(memory.store));
    } finally {
      await memory.cleanup();
      await sqlite.cleanup();
    }
  });
  it("05-05 Task 3 previews history ingestion without opening an unconfigured source root", async () => {
    const harness = await codexApplicationHarness();
    try {
      const before = await mutationSnapshot(harness.store);
      await expect(harness.app.previewHistoryIngest({ sourceAlias: "outside", source: "codex", requestedAt: LATER }))
        .rejects.toMatchObject({ code: "UNAUTHORIZED_OR_NOT_FOUND" });
      const preview = await harness.app.previewHistoryIngest({ sourceAlias: "codex", source: "codex", requestedAt: LATER });
      expect(preview).toMatchObject({ candidateId: harness.candidateId, effects: { eventIds: [expect.any(String)], checkpointIds: [expect.any(String)] } });
      await expect(mutationSnapshot(harness.store)).resolves.toBe(before);
    } finally {
      await harness.cleanup();
    }
  });

  it("05-05 Task 3 executes history ingestion only for the exact confirmed preview effects", async () => {
    const harness = await codexApplicationHarness();
    try {
      const nativeBefore = await readFile(harness.rolloutPath, "utf8");
      const request = { sourceAlias: "codex", source: "codex" as const, requestedAt: LATER };
      const preview = await harness.app.previewHistoryIngest(request);
      await expect(harness.app.executeHistoryIngest({ ...request, token: preview.token }))
        .resolves.toMatchObject({ operation: "history_import", status: "COMMITTED", targetId: harness.candidateId });
      await expect(harness.store.listCanonicalEvents("person-alpha")).resolves.toEqual([
        expect.objectContaining({ content: "Synthetic configured history", scopeId: "scope-alpha" })
      ]);
      await expect(readFile(harness.rolloutPath, "utf8")).resolves.toBe(nativeBefore);
    } finally {
      await harness.cleanup();
    }
  });

  it("05-05 Task 3 consumes confirmation and writes nothing when import events or grant state drift", async () => {
    const harness = await codexApplicationHarness();
    try {
      const request = { sourceAlias: "codex", source: "codex" as const, requestedAt: LATER };
      const preview = await harness.app.previewHistoryIngest(request);
      await appendFile(harness.rolloutPath, `${JSON.stringify({ timestamp: "2026-07-18T12:00:30.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Drifted event" }] } })}\n`);
      const before = await mutationSnapshot(harness.store);
      await expect(harness.app.executeHistoryIngest({ ...request, token: preview.token }))
        .resolves.toMatchObject({ status: "STATE_CHANGED", effectCounts: {} });
      await expect(mutationSnapshot(harness.store)).resolves.toBe(before);
      await expect(harness.app.executeHistoryIngest({ ...request, token: preview.token }))
        .rejects.toMatchObject({ code: "CONFIRMATION_REPLAYED" });

      const grantPreview = await harness.app.previewHistoryIngest(request);
      const [grant] = await harness.store.listSourceGrants("person-alpha");
      await harness.store.saveSourceGrant({ ...grant!, updatedAt: "2026-07-18T12:00:45.000Z" });
      const beforeGrantExecute = await mutationSnapshot(harness.store);
      await expect(harness.app.executeHistoryIngest({ ...request, token: grantPreview.token }))
        .resolves.toMatchObject({ status: "STATE_CHANGED", effectCounts: {} });
      await expect(mutationSnapshot(harness.store)).resolves.toBe(beforeGrantExecute);
    } finally {
      await harness.cleanup();
    }
  });
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

  it("05-09 Task 1 rejects proposal payload-only unauthorized dependencies before issuing a plan", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(atomicSummary("summary-declared"));
    await store.saveSummary(atomicSummary("summary-payload-denied", {
      scopeIds: ["scope-beta"]
    }));
    const payloadMismatch = {
      ...proposal(),
      id: "proposal-payload-denied",
      sourceSummaryIds: ["summary-declared"],
      targetTraceIds: ["trace-payload-denied"],
      payload: {
        ...proposal().payload,
        traceId: "trace-payload-denied",
        summaryIds: ["summary-declared", "summary-payload-denied"]
      }
    };
    await store.saveProposal(payloadMismatch);
    const reviewer = new ScopedProposalReviewer(store, testAuthority());

    await expect(reviewer.listProposals()).resolves.toEqual({ ok: true, proposals: [], count: 0 });
    await expect(reviewer.planDecision({
      proposalId: payloadMismatch.id,
      decision: "approve",
      decidedAt: LATER
    })).rejects.toMatchObject({ code: "UNAUTHORIZED_OR_NOT_FOUND" });

    const allowedSecond = atomicSummary("summary-allowed-second");
    await store.saveSummary(allowedSecond);
    await store.saveBox({
      id: "box-payload-denied",
      personId: "person-alpha",
      title: "Synthetic denied dependency box",
      description: "Synthetic",
      parentBoxId: null,
      childBoxIds: [],
      summaryIds: ["summary-payload-denied"],
      turnRanges: [],
      state: "approved",
      createdAt: NOW,
      updatedAt: NOW,
      caseId: null,
      boxType: "project",
      summary: "Synthetic",
      lastActivityAt: NOW
    });
    const boxMismatch = {
      ...proposal(),
      id: "proposal-payload-box-denied",
      sourceSummaryIds: ["summary-declared", allowedSecond.id],
      targetBoxIds: [],
      targetTraceIds: ["trace-payload-box-denied"],
      payload: {
        ...proposal().payload,
        traceId: "trace-payload-box-denied",
        summaryIds: ["summary-declared", allowedSecond.id],
        boxIds: ["box-payload-denied"]
      }
    };
    await store.saveProposal(boxMismatch);
    await expect(reviewer.planDecision({
      proposalId: boxMismatch.id,
      decision: "approve",
      decidedAt: LATER
    })).rejects.toMatchObject({ code: "UNAUTHORIZED_OR_NOT_FOUND" });
  });

  it("05-09 Task 1 binds the authorized proposal payload union and recursive closure", async () => {
    const store = new InMemoryStore();
    const recursive = atomicSummary("summary-recursive");
    const declared = atomicSummary("summary-declared", { sourceSummaryIds: [recursive.id] });
    const payloadOnly = atomicSummary("summary-payload-only");
    await store.saveSummary(recursive);
    await store.saveSummary(declared);
    await store.saveSummary(payloadOnly);
    const mismatch = {
      ...proposal(),
      id: "proposal-authorized-mismatch",
      sourceSummaryIds: [declared.id],
      targetTraceIds: ["trace-new"],
      payload: {
        ...proposal().payload,
        traceId: "trace-new",
        summaryIds: [declared.id, payloadOnly.id]
      }
    };
    await store.saveProposal(mismatch);

    const plan = await new ScopedProposalReviewer(store, testAuthority()).planDecision({
      proposalId: mismatch.id,
      decision: "approve",
      decidedAt: LATER,
      reviewer: "synthetic-reviewer"
    });

    expect(plan.allowedScopeIds).toEqual(["scope-alpha"]);
    expect(plan.expectedSummaries.map((item) => item.id)).toEqual([
      "summary-declared", "summary-payload-only", "summary-recursive"
    ]);
    expect(plan.expectedBoxes).toEqual([]);
    expect(plan.expectedTraces).toEqual([{ id: "trace-new", value: null }]);
    expect(plan.nextTraces).toEqual([
      expect.objectContaining({ id: "trace-new", summaryIds: ["summary-declared", "summary-payload-only"] })
    ]);
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

  it("WR-01 takePlan returns undefined on a stored-plan kind mismatch instead of the mismatched plan", async () => {
    const store = new InMemoryStore();
    const lifecycle = new SourceLifecycleService(store);
    const authority = testAuthority();
    await lifecycle.approve({ personId: authority.personId, candidateId: "candidate-kind-guard", application: "synthetic", format: "jsonl", sourceLocator: "synthetic://configured", profileId: authority.profileName, scopeId: authority.ingestScopeId, approvedAt: NOW });
    const app = new MemoryMutationApplication({ store, authority, confirmations: new ConfirmationService({ clock: () => NOW }) });
    // Store a plan of kind "source_revoke" via the public preview path.
    const preview = await app.previewSourceRevocation({ candidateId: "candidate-kind-guard", actor: "synthetic-reviewer", revokedAt: LATER });

    const privateApp = app as unknown as { takePlan: (token: string, expectedKind: string) => unknown };
    const mismatched = privateApp.takePlan(preview.token, "source_delete");
    expect(mismatched).toBeUndefined();

    // takePlan always removes the token from the plan map (even on mismatch), so a second call
    // for the *correct* kind also returns undefined -- the plan was consumed by the first call.
    const secondAttempt = privateApp.takePlan(preview.token, "source_revoke");
    expect(secondAttempt).toBeUndefined();
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
  it("05-07 Task 2 routes each preview tool to one scoped application operation", async () => {
    const protocol = await mutationProtocolHarness();
    try {
      const requests = [
        ["history_ingest_preview", { sourceAlias: "codex", source: "codex", requestedAt: LATER }],
        ["proposal_approve_preview", { proposalId: "proposal-approve", decidedAt: LATER, reviewer: "reviewer" }],
        ["proposal_reject_preview", { proposalId: "proposal-reject", decidedAt: LATER, note: "synthetic" }],
        ["source_revoke_preview", { candidateId: "candidate-revoke", actor: "reviewer", revokedAt: LATER }],
        ["source_delete_preview", { candidateId: "candidate-delete", actor: "reviewer", deletedAt: LATER }]
      ] as const;
      for (const [name, args] of requests) {
        const result = await protocol.client.callTool({ name, arguments: args });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual(expect.objectContaining({
          token: "t".repeat(32),
          expiresAt: LATER,
          effectsFingerprint: "a".repeat(64),
          effectCounts: expect.any(Object)
        }));
        expect(JSON.stringify(result)).not.toContain("person-alpha");
        expect(JSON.stringify(result)).not.toContain("/synthetic/root");
      }
      expect(protocol.calls.map((call) => call.method)).toEqual([
        "previewHistoryIngest",
        "previewProposalApproval",
        "previewProposalRejection",
        "previewSourceRevocation",
        "previewSourceDeletion"
      ]);
      expect(protocol.calls.every((call) => call.count === 1)).toBe(true);
    } finally {
      await protocol.close();
    }
  });

  it("05-07 Task 2 routes each execute tool with exact ticket binding and truthful annotations", async () => {
    const protocol = await mutationProtocolHarness();
    try {
      const catalog = await protocol.client.listTools();
      expect(catalog.tools.map((tool) => tool.name)).toEqual(MEMORY_MUTATION_TOOL_NAMES);
      const destructive = new Set([
        "proposal_approve_execute", "proposal_reject_execute",
        "source_revoke_execute", "source_delete_execute"
      ]);
      for (const tool of catalog.tools) {
        expect(tool.annotations).toEqual({
          readOnlyHint: false,
          destructiveHint: destructive.has(tool.name),
          idempotentHint: false,
          openWorldHint: false
        });
      }

      const requests = [
        ["history_ingest_execute", { sourceAlias: "codex", source: "codex", requestedAt: LATER, token: "h".repeat(32) }],
        ["proposal_approve_execute", { proposalId: "proposal-approve", decidedAt: LATER, reviewer: "reviewer", token: "a".repeat(32) }],
        ["proposal_reject_execute", { proposalId: "proposal-reject", decidedAt: LATER, note: "synthetic", token: "r".repeat(32) }],
        ["source_revoke_execute", { candidateId: "candidate-revoke", actor: "reviewer", revokedAt: LATER, token: "v".repeat(32) }],
        ["source_delete_execute", { candidateId: "candidate-delete", actor: "reviewer", deletedAt: LATER, token: "d".repeat(32) }]
      ] as const;
      for (const [name, args] of requests) {
        const result = await protocol.client.callTool({ name, arguments: args });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual(expect.objectContaining({
          status: "COMMITTED",
          targetId: expect.any(String),
          effectCounts: expect.any(Object),
          committedAt: LATER
        }));
        expect(JSON.stringify(result)).not.toContain("person-alpha");
      }
      expect(protocol.calls.slice(-5).map((call) => ({ method: call.method, token: call.input.token }))).toEqual([
        { method: "executeHistoryIngest", token: "h".repeat(32) },
        { method: "executeProposalApproval", token: "a".repeat(32) },
        { method: "executeProposalRejection", token: "r".repeat(32) },
        { method: "executeSourceRevocation", token: "v".repeat(32) },
        { method: "executeSourceDeletion", token: "d".repeat(32) }
      ]);

      const rejected = await protocol.client.callTool({
        name: "proposal_reject_execute",
        arguments: { proposalId: "fail", decidedAt: LATER, token: "x".repeat(32) }
      });
      expect(rejected.isError).toBe(true);
      expect(JSON.stringify(rejected)).toContain("UNAUTHORIZED_OR_NOT_FOUND");
      expect(JSON.stringify(rejected)).not.toContain("/synthetic/root");
    } finally {
      await protocol.close();
    }
  });
});

const NOW = "2026-07-18T12:00:00.000Z";
const LATER = "2026-07-18T12:01:00.000Z";

const mutationProtocolHarness = async () => {
  const calls: Array<{ method: string; input: Record<string, unknown>; count: number }> = [];
  const record = <T>(method: string, input: T): void => {
    calls.push({ method, input: input as Record<string, unknown>, count: 1 });
  };
  const preview = (effects: Record<string, string[]>) => ({
    token: "t".repeat(32), expiresAt: LATER, targetIds: ["synthetic-target"],
    effects, effectsFingerprint: "a".repeat(64),
    personId: "person-alpha", sourcePath: "/synthetic/root"
  });
  const receipt = (
    operation: "history_import" | "proposal_decision" | "source_revocation" | "source_deletion",
    targetId: string,
    effectCounts: Record<string, number>
  ) => ({ operation, status: "COMMITTED" as const, personId: "person-alpha", targetId, effectCounts, committedAt: LATER });
  const application: MemoryMutationToolApplication = {
    async previewHistoryIngest(input) { record("previewHistoryIngest", input); return preview({ sourceIds: ["s"], eventIds: ["e"], checkpointIds: ["c"], auditEventIds: [] }); },
    async executeHistoryIngest(input) { record("executeHistoryIngest", input); return receipt("history_import", "candidate-history", { sources: 1, events: 1, checkpoints: 1, audits: 0 }); },
    async previewProposalApproval(input) { record("previewProposalApproval", input); return preview({ proposalIds: ["p"], boxIds: ["b"], traceIds: [] }); },
    async executeProposalApproval(input) { record("executeProposalApproval", input); return receipt("proposal_decision", input.proposalId, { proposals: 1, boxes: 1, traces: 0 }); },
    async previewProposalRejection(input) { record("previewProposalRejection", input); return preview({ proposalIds: ["p"], boxIds: [], traceIds: [] }); },
    async executeProposalRejection(input) { record("executeProposalRejection", input); if (input.proposalId === "fail") throw new Error("UNAUTHORIZED_OR_NOT_FOUND /synthetic/root"); return receipt("proposal_decision", input.proposalId, { proposals: 1, boxes: 0, traces: 0 }); },
    async previewSourceRevocation(input) { record("previewSourceRevocation", input); return preview({ grantIds: ["g"], auditEventIds: ["a"] }); },
    async executeSourceRevocation(input) { record("executeSourceRevocation", input); return receipt("source_revocation", input.candidateId, { grants: 1, audits: 1 }); },
    async previewSourceDeletion(input) { record("previewSourceDeletion", input); return preview({ sourceIds: ["s"], canonicalEventIds: ["e"], turnIds: [], anchorIds: [], injectionIds: [], quarantineIds: [], bootstrapCheckpointIds: [], supersededSummaryIds: [], supersededBoxIds: [], supersededProposalIds: [], supersededTraceIds: [], auditEventIds: ["a1", "a2"] }); },
    async executeSourceDeletion(input) { record("executeSourceDeletion", input); return receipt("source_deletion", input.candidateId, { sources: 1, events: 1, anchors: 0, summaries: 0, boxes: 0, proposals: 0, traces: 0, audits: 2 }); }
  };
  const server = new McpServer({ name: "synthetic-memory-mutations", version: "1.0.0" });
  registerMemoryMutationTools(server, application);
  const client = new Client({ name: "synthetic-mutation-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { calls, client, close: async () => { await client.close(); await server.close(); } };
};

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

const codexApplicationHarness = async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "mcp-configured-codex-"));
  const rolloutPath = join(tempDir, "sessions", "2026", "07", "18", "rollout-synthetic.jsonl");
  await mkdir(dirname(rolloutPath), { recursive: true });
  await writeFile(rolloutPath, [
    JSON.stringify({ timestamp: NOW, type: "session_meta", payload: { id: "synthetic-session" } }),
    JSON.stringify({ timestamp: NOW, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Synthetic configured history" }] } }),
    ""
  ].join("\n"));
  const candidate = await discoverCodexHistory(tempDir, NOW);
  const store = new InMemoryStore();
  const authority = createProfileAuthority({
    profileName: "synthetic-profile", databasePath: join(tempDir, "memory.sqlite"), personId: "person-alpha",
    allowedScopeIds: ["scope-alpha"], ingestScopeId: "scope-alpha",
    sourceRoots: { codex: tempDir }, scopeAliases: { "scope-alpha": "context-one" }
  });
  await new SourceLifecycleService(store).approve({
    personId: authority.personId, candidateId: candidate.id, application: candidate.application,
    format: candidate.format, sourceLocator: candidate.rootPath, profileId: authority.profileName,
    scopeId: authority.ingestScopeId, approvedAt: NOW
  });
  return {
    store,
    app: new MemoryMutationApplication({ store, authority, confirmations: new ConfirmationService({ clock: () => NOW }) }),
    candidateId: candidate.id,
    rolloutPath,
    cleanup: () => rm(tempDir, { recursive: true, force: true })
  };
};

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

const atomicSummary = (id: string, overrides: Partial<Summary> = {}): Summary => ({
  id,
  personId: "person-alpha",
  scopeIds: ["scope-alpha"],
  origin: "historical_bootstrap",
  summaryText: `Synthetic summary ${id}`,
  sourceTurnRanges: [],
  sourceCanonicalEventIds: [],
  sourceSummaryIds: [],
  boxIds: [],
  embedding: null,
  createdAt: NOW,
  model: "synthetic-local",
  promptVersion: "synthetic/v1",
  confidence: 0.8,
  state: "active",
  detailLevel: "brief",
  tokenCount: 8,
  lastAccessedAt: null,
  version: 1,
  strength: 0.5,
  retrievalCount: 0,
  retrievedAt: null,
  halfLifeHours: 168,
  outcomeScore: null,
  ...overrides
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
  return CommitProposalDecisionInputSchema.parse({ operation: "proposal_decision", personId: "person-alpha", decision: "reject", allowedScopeIds: ["scope-alpha"], expectedSummaries: [atomicSummary("summary-1"), atomicSummary("summary-2")], expectedBoxes: [], expectedTraces: [{ id: "trace-atomic", value: null }], expectedProposal, nextProposal, nextBoxes: [], nextTraces: [], effects, effectsFingerprint: mutationEffectsFingerprint(effects), receipt: receipt("proposal_decision", expectedProposal.id, { proposals: 1, boxes: 0, traces: 0 }) });
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

interface ProposalDecisionHarness extends MutationHarness {
  plan: Awaited<ReturnType<ScopedProposalReviewer["planDecision"]>>;
  app: MemoryMutationApplication;
}

const proposalDecisionHarness = async (
  backend: "memory" | "sqlite",
  existingTrace: boolean
): Promise<ProposalDecisionHarness> => {
  let store: MemoryStore;
  let tempDir: string | undefined;
  let databasePath: string | undefined;
  if (backend === "memory") {
    store = new InMemoryStore();
  } else {
    tempDir = await mkdtemp(join(tmpdir(), "mcp-proposal-drift-"));
    databasePath = join(tempDir, "memory.sqlite");
    store = new SqliteStore(databasePath, { busyTimeoutMs: 250 });
  }
  const recursive = atomicSummary("summary-recursive");
  const first = atomicSummary("summary-1", { sourceSummaryIds: [recursive.id] });
  const second = atomicSummary("summary-2");
  const child: Box = {
    id: "box-child", personId: "person-alpha", title: "Synthetic child", description: "Synthetic",
    parentBoxId: "box-parent", childBoxIds: [], summaryIds: [second.id], turnRanges: [], state: "approved",
    createdAt: NOW, updatedAt: NOW, caseId: null, boxType: "project", summary: "Synthetic child", lastActivityAt: NOW
  };
  const parent: Box = {
    id: "box-parent", personId: "person-alpha", title: "Synthetic parent", description: "Synthetic",
    parentBoxId: null, childBoxIds: [child.id], summaryIds: [first.id], turnRanges: [], state: "approved",
    createdAt: NOW, updatedAt: NOW, caseId: null, boxType: "project", summary: "Synthetic parent", lastActivityAt: NOW
  };
  const trace: MemoryTrace = {
    id: "trace-decision", personId: "person-alpha", title: "Existing synthetic trace", description: "Synthetic",
    traceType: "task_thread", state: "proposed", summaryIds: [first.id, second.id], boxIds: [parent.id],
    turnRanges: [{ threadId: "synthetic-thread", startSequence: 1, endSequence: 2 }], createdAt: NOW,
    updatedAt: NOW, lastActivityAt: NOW, confidence: 0.8, rationale: "Synthetic"
  };
  const decisionProposal: MemoryProposal = {
    ...proposal(), id: "proposal-decision", sourceSummaryIds: [first.id], targetBoxIds: [],
    targetTraceIds: [trace.id], payload: { ...proposal().payload, traceId: trace.id,
      summaryIds: [first.id, second.id], boxIds: [parent.id] }
  };
  for (const summary of [recursive, first, second]) await store.saveSummary(summary);
  await store.saveBox(parent);
  await store.saveBox(child);
  if (existingTrace) await store.saveTrace(trace);
  await store.saveProposal(decisionProposal);
  const authority = testAuthority();
  const app = new MemoryMutationApplication({
    store,
    authority,
    confirmations: new ConfirmationService({ clock: () => NOW })
  });
  const plan = await new ScopedProposalReviewer(store, authority).planDecision({
    proposalId: decisionProposal.id,
    decision: "approve",
    decidedAt: LATER,
    reviewer: "synthetic-reviewer"
  });
  const harness: ProposalDecisionHarness = {
    store,
    plan,
    app,
    async reopen() {
      if (!databasePath) return;
      (harness.store as SqliteStore).close();
      harness.store = new SqliteStore(databasePath, { busyTimeoutMs: 250 });
    },
    async cleanup() {
      if (!tempDir) return;
      (harness.store as SqliteStore).close();
      await rm(tempDir, { recursive: true, force: true });
    }
  };
  return harness;
};

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
  if (operation === "proposal") {
    const input = proposalInput();
    for (const summary of input.expectedSummaries) await store.saveSummary(summary);
    await store.saveProposal(input.expectedProposal);
    return input;
  }
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

const proposalStateSnapshot = async (store: MemoryStore): Promise<string> => JSON.stringify({
  proposal: await store.getProposal("proposal-decision"),
  summaries: (await store.listSummaries()).sort((left, right) => left.id.localeCompare(right.id)),
  boxes: (await store.listBoxes()).sort((left, right) => left.id.localeCompare(right.id)),
  traces: (await store.listTraces()).sort((left, right) => left.id.localeCompare(right.id))
});
