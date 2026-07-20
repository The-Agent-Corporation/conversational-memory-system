import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import { MemoryService } from "../../src/service/memory-service.js";
import { BoxReviewer } from "../../src/boxes/box-reviewer.js";
import { ProposalReviewer } from "../../src/proposals/proposal-reviewer.js";
import { SourceLifecycleService } from "../../src/service/source-lifecycle-service.js";
import { CodexHistoryImporter } from "../../src/imports/codex-importer.js";
import { discoverCodexHistory } from "../../src/imports/codex-discovery.js";
import { ConfirmationService } from "../../src/mcp/confirmation-service.js";
import { MemoryMutationApplication } from "../../src/mcp/mutation-application.js";
import { createProfileAuthority } from "../../src/mcp/authority.js";
import type { Box, MemoryProposal } from "../../src/domain/types.js";
import {
  emitLocalSyncOperation,
  getNonCommittedLocalSyncEmissionCount,
  resetNonCommittedLocalSyncEmissionCount
} from "../../src/sync/materialization/sync-materializer.js";

/**
 * Inventory and adapter-parity proof that every authoritative local producer named in Plan
 * 06-07 emits exactly one atomic sync-outbox operation of the correct kind through the Plan
 * 06-04 `commitLocalSyncOperation` seam, and that automatic derived recomputation (box-summary
 * attachment as a side effect, not a standalone reviewed decision) never emits its own operation.
 */

const NOW = "2030-02-01T00:00:00.000Z";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function outboxKinds(store: InMemoryStore, personId: string): Promise<string[]> {
  return (await store.listSyncOutboxOperations(personId)).map((row) => row.operationKind);
}

describe("Authoritative producer inventory: every local producer emits exactly one sync operation", () => {
  it("MemoryService.ingestEvent emits one host_event_ingest operation", async () => {
    const store = new InMemoryStore();
    const service = new MemoryService(store, { personId: "person-a", clock: () => NOW });

    await service.ingestEvent({
      id: "evt-1", type: "conversation_turn", host: "codex", profileId: "default",
      hostSessionId: "session-1", role: "user", content: "hello", sequence: 1, createdAt: NOW,
      metadata: {}
    } as never);

    expect(await outboxKinds(store, "person-a")).toEqual(["host_event_ingest"]);
  });

  it("BoxReviewer.approveBox/rejectBox each emit one reviewed_box_decision operation and never emit for the derived summary attachment", async () => {
    const store = new InMemoryStore();
    const box: Box = {
      id: "box-1", personId: "person-a", title: "t", description: "d", parentBoxId: null,
      childBoxIds: [], summaryIds: ["summary-1"], turnRanges: [], state: "proposed",
      createdAt: NOW, updatedAt: NOW, caseId: null, boxType: "topic", summary: "s", lastActivityAt: NOW
    };
    const turnRange = { threadId: "person:person-a", startSequence: 1, endSequence: 3 };
    await store.saveBox(box);
    await store.saveSummary({
      id: "summary-1", personId: "person-a", scopeIds: ["scope-a"], state: "active",
      summaryText: "text", sourceTurnRanges: [turnRange], sourceSummaryIds: [], boxIds: [],
      embedding: null, createdAt: NOW, model: "synthetic", promptVersion: "v1", confidence: 1,
      detailLevel: "full", tokenCount: 10, lastAccessedAt: null, version: 1, strength: 1,
      retrievalCount: 0, retrievedAt: null, halfLifeHours: 48, outcomeScore: null
    } as never);

    const reviewer = new BoxReviewer(store);
    await reviewer.approveBox({ boxId: "box-1", reviewedAt: NOW });

    // Exactly one operation for the reviewed decision itself; attaching the summary to the box is
    // a bound side effect of that same decision, not an independent unreviewed producer.
    expect(await outboxKinds(store, "person-a")).toEqual(["reviewed_box_decision"]);

    const store2 = new InMemoryStore();
    await store2.saveBox({ ...box, id: "box-2" });
    const reviewer2 = new BoxReviewer(store2);
    await reviewer2.rejectBox({ boxId: "box-2", reviewedAt: NOW });
    expect(await outboxKinds(store2, "person-a")).toEqual(["reviewed_box_decision"]);
  });

  it("ProposalReviewer (direct) approveProposal and rejectProposal each emit one proposal_decision operation", async () => {
    const store = new InMemoryStore();
    const turnRange = { threadId: "person:person-a", startSequence: 1, endSequence: 3 };
    const proposal: MemoryProposal = {
      id: "proposal-1", personId: "person-a", proposalType: "box", title: "t", rationale: "r",
      confidence: 1, state: "proposed", createdAt: NOW, reviewedAt: NOW, decidedAt: null,
      decidedBy: null, decisionNote: null, sourceSummaryIds: ["summary-1"], sourceTurnRanges: [turnRange],
      targetBoxIds: ["box-1"], targetTraceIds: [],
      payload: {
        boxId: "box-1", title: "t", description: "d", boxType: "topic", summary: "s",
        candidateParentBoxId: null, keywords: ["k"], evidence: ["e"],
        sourceSummaryIds: ["summary-1"], sourceTurnRanges: [turnRange]
      }
    } as never;
    await store.saveProposal(proposal);

    const reviewer = new ProposalReviewer(store);
    await reviewer.approveProposal({ proposalId: "proposal-1", decidedAt: NOW });
    expect(await outboxKinds(store, "person-a")).toEqual(["proposal_decision"]);

    const store2 = new InMemoryStore();
    await store2.saveProposal({ ...proposal, id: "proposal-2" });
    const reviewer2 = new ProposalReviewer(store2);
    await reviewer2.rejectProposal({ proposalId: "proposal-2", decidedAt: NOW });
    expect(await outboxKinds(store2, "person-a")).toEqual(["proposal_decision"]);
  });

  it("SourceLifecycleService.revoke and .deleteRevokedSource each emit exactly one sync operation in sequence", async () => {
    const store = new InMemoryStore();
    const lifecycle = new SourceLifecycleService(store);
    await lifecycle.approve({
      personId: "person-a", candidateId: "cand-1", application: "codex", format: "jsonl",
      sourceLocator: "/tmp/x", profileId: "profile-1", approvedAt: NOW
    });
    await lifecycle.revoke("person-a", "cand-1", "user", NOW);
    await lifecycle.deleteRevokedSource({
      personId: "person-a", candidateId: "cand-1", confirmedCandidateId: "cand-1", actor: "user", deletedAt: NOW
    });

    expect(await outboxKinds(store, "person-a")).toEqual(["source_revocation", "source_deletion"]);
  });

  it("MemoryMutationApplication (scoped MCP path) executeProposalApproval emits exactly one proposal_decision operation", async () => {
    const store = new InMemoryStore();
    const authority = createProfileAuthority({
      profileName: "p", databasePath: "/synthetic/db.sqlite", personId: "person-a",
      allowedScopeIds: ["scope-a"], ingestScopeId: "scope-a", sourceRoots: {}, scopeAliases: { "scope-a": "context" }
    });
    const turnRange = { threadId: "person:person-a", startSequence: 1, endSequence: 3 };
    await store.saveSummary({
      id: "summary-a", personId: "person-a", scopeIds: ["scope-a"], state: "active",
      summaryText: "text", sourceTurnRanges: [turnRange], sourceSummaryIds: [], boxIds: [],
      embedding: null, createdAt: NOW, model: "synthetic", promptVersion: "v1", confidence: 1,
      detailLevel: "full", tokenCount: 10, lastAccessedAt: null, version: 1, strength: 1,
      retrievalCount: 0, retrievedAt: null, halfLifeHours: 48, outcomeScore: null
    } as never);
    await store.saveSummary({
      id: "summary-b", personId: "person-a", scopeIds: ["scope-a"], state: "active",
      summaryText: "text", sourceTurnRanges: [turnRange], sourceSummaryIds: [], boxIds: [],
      embedding: null, createdAt: NOW, model: "synthetic", promptVersion: "v1", confidence: 1,
      detailLevel: "full", tokenCount: 10, lastAccessedAt: null, version: 1, strength: 1,
      retrievalCount: 0, retrievedAt: null, halfLifeHours: 48, outcomeScore: null
    } as never);
    await store.saveProposal({
      id: "proposal-mcp", personId: "person-a", proposalType: "trace", title: "t", rationale: "r",
      confidence: 1, state: "proposed", createdAt: NOW, reviewedAt: NOW, decidedAt: null,
      decidedBy: null, decisionNote: null, sourceSummaryIds: ["summary-a", "summary-b"],
      sourceTurnRanges: [turnRange], targetBoxIds: [], targetTraceIds: ["trace-1"],
      payload: {
        traceId: "trace-1", title: "t", description: "d", traceType: "fact_development",
        summaryIds: ["summary-a", "summary-b"], boxIds: [], turnRanges: [turnRange],
        continuityReason: "c", boundaryReason: "b", keywords: ["k"]
      }
    } as never);
    const app = new MemoryMutationApplication({ store, authority, confirmations: new ConfirmationService({ clock: () => NOW }) });

    const preview = await app.previewProposalApproval({ proposalId: "proposal-mcp", decidedAt: NOW });
    await app.executeProposalApproval({ proposalId: "proposal-mcp", decidedAt: NOW, token: preview.token });

    expect(await outboxKinds(store, "person-a")).toEqual(["proposal_decision"]);
  });

  it("CodexHistoryImporter.importApprovedGrantBatch (shared importer/daemon path) emits one canonical_append operation per non-empty batch", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sync-producers-codex-"));
    cleanups.push(() => rm(tempDir, { recursive: true, force: true }));
    const rolloutPath = join(tempDir, "sessions", "2030", "02", "01", "rollout-synthetic.jsonl");
    await mkdir(dirname(rolloutPath), { recursive: true });
    await writeFile(rolloutPath, [
      JSON.stringify({ timestamp: NOW, type: "session_meta", payload: { id: "synthetic-session" } }),
      JSON.stringify({ timestamp: NOW, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Synthetic history line" }] } }),
      ""
    ].join("\n"));
    const candidate = await discoverCodexHistory(tempDir, NOW);
    const store = new InMemoryStore();
    await new SourceLifecycleService(store).approve({
      personId: "person-a", candidateId: candidate.id, application: candidate.application,
      format: candidate.format, sourceLocator: candidate.rootPath, profileId: "profile-1", approvedAt: NOW
    });
    const grant = await store.getSourceGrant(new SourceLifecycleService(store).grantId("person-a", candidate.id));

    const importer = new CodexHistoryImporter(store, { clock: () => NOW });
    await importer.importApprovedGrantBatch(grant!, {
      authority: { kind: "foreground", personId: "person-a", operation: "approved-import" }
    });

    expect(await outboxKinds(store, "person-a")).toEqual(["canonical_append"]);
  });
});

describe("WR-06: non-COMMITTED local outbox emissions are surfaced, not silently dropped", () => {
  it("emitLocalSyncOperation returns the receipt status instead of discarding it", async () => {
    const store = new InMemoryStore();
    const status = await emitLocalSyncOperation(store, {
      personId: "person-a",
      deviceId: "device-1",
      operationKind: "canonical_append",
      targetId: "target-1",
      effectFingerprint: "a".repeat(64),
      committedAt: NOW
    });
    expect(status).toBe("COMMITTED");
  });

  it("a racing pair of emissions against the same device sequence surfaces a non-fatal, content-free EQUIVOCATION signal", async () => {
    resetNonCommittedLocalSyncEmissionCount();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new InMemoryStore();

    // Both calls read the frontier before either commits, so both compute the same next
    // device-sequence (and thus the same outboxId) but bind different targets -- the loser of the
    // race is a non-identical write against an already-occupied device sequence, i.e. EQUIVOCATION,
    // not a real cross-device conflict.
    const [first, second] = await Promise.all([
      emitLocalSyncOperation(store, {
        personId: "person-a",
        deviceId: "device-1",
        operationKind: "canonical_append",
        targetId: "target-race-1",
        effectFingerprint: "a".repeat(64),
        committedAt: NOW
      }),
      emitLocalSyncOperation(store, {
        personId: "person-a",
        deviceId: "device-1",
        operationKind: "canonical_append",
        targetId: "target-race-2",
        effectFingerprint: "b".repeat(64),
        committedAt: NOW
      })
    ]);

    const statuses = [first, second].sort();
    expect(statuses).toEqual(["COMMITTED", "EQUIVOCATION"]);
    expect(getNonCommittedLocalSyncEmissionCount()).toBe(1);

    // The surfaced signal is content-free: it names only the closed status/operation-kind enums,
    // never a personId, targetId, or any plaintext/semantic field.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [warnMessage] = warnSpy.mock.calls[0] ?? [];
    expect(warnMessage).toContain("status=EQUIVOCATION");
    expect(warnMessage).toContain("operationKind=canonical_append");
    expect(warnMessage).not.toContain("person-a");
    expect(warnMessage).not.toContain("target-race-1");
    expect(warnMessage).not.toContain("target-race-2");

    warnSpy.mockRestore();
  });
});
