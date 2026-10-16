import { createHash } from "node:crypto";
import { appendFile, readFile, rename, stat, truncate, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovedSourceRunner } from "../../src/daemon/approved-source-runner.js";
import type { CommitImportBatchInput, ImportBatchReceipt, WriteAuthority } from "../../src/daemon/types.js";
import type { SourceGrant } from "../../src/domain/source-lifecycle.js";
import { SourceLifecycleService } from "../../src/service/source-lifecycle-service.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import {
  FIXED_NOW,
  FakeDaemonClock,
  createSyntheticApprovedSources,
  type SyntheticApprovedSource,
  type SyntheticDaemonSources
} from "./fixtures.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("ApprovedSourceRunner", () => {
  it("rejects token-A publication after native reads for every format and lets token B replay once", async () => {
    const sources = await syntheticSources();
    const nativeBefore = await fixtureHashes(sources);

    for (const source of allSources(sources)) {
      const clock = new FakeDaemonClock();
      const store = new InMemoryStore({ clock });
      await store.saveSourceGrant(source.grant);
      await store.acquireDaemonLease({ databaseId: "memory-db", ownerToken: "token-a", pid: 100, now: clock.now() });
      let turnedOver = false;
      const staleRunner = new ApprovedSourceRunner(store, {
        clock: clock.now,
        authority: daemonAuthority("token-a"),
        beforeCommit: async () => {
          if (turnedOver) return;
          turnedOver = true;
          await store.releaseDaemonLease("memory-db", "token-a");
          await store.acquireDaemonLease({ databaseId: "memory-db", ownerToken: "token-b", pid: 101, now: clock.now() });
        }
      });
      const before = await importPublicationSnapshot(store, source.grant.personId, source.grant.candidateId);

      await expect(staleRunner.runGrant(source.grant.personId, source.grant.candidateId))
        .resolves.toMatchObject({ ok: false });
      expect(await importPublicationSnapshot(store, source.grant.personId, source.grant.candidateId)).toEqual(before);

      const replacement = new ApprovedSourceRunner(store, {
        clock: clock.now,
        authority: daemonAuthority("token-b")
      });
      const replay = await replacement.runGrant(source.grant.personId, source.grant.candidateId);
      expect(replay.ok && replay.receipt.canonicalEventIds).toHaveLength(1);
      const idempotent = await replacement.runGrant(source.grant.personId, source.grant.candidateId);
      expect(idempotent.ok && idempotent.receipt.canonicalEventIds).toEqual([]);
      expect((await store.listCanonicalEvents(source.grant.personId))).toHaveLength(1);
    }

    expect(await fixtureHashes(sources)).toEqual(nativeBefore);
  });

  it("requires explicit approved-import authority for foreground source imports", async () => {
    const sources = await syntheticSources();
    const store = new InMemoryStore();
    await store.saveSourceGrant(sources.codex.grant);

    await expect(new ApprovedSourceRunner(store).runGrant(
      sources.codex.grant.personId,
      sources.codex.grant.candidateId
    )).resolves.toMatchObject({ ok: false });
    await expect(new ApprovedSourceRunner(store, {
      authority: { kind: "foreground", personId: sources.codex.grant.personId, operation: "historical-bootstrap" }
    }).runGrant(sources.codex.grant.personId, sources.codex.grant.candidateId)).resolves.toMatchObject({ ok: false });
    expect(await store.listCanonicalEvents(sources.codex.grant.personId)).toEqual([]);
  });

  it("dispatches all four exact durable grant pairs without ever reapproving", async () => {
    const sources = await syntheticSources();
    const store = new InMemoryStore();
    const lifecycle = new SourceLifecycleService(store);
    const approve = vi.spyOn(lifecycle, "approve");
    await seedGrants(store, sources);
    const called: string[] = [];
    const runner = new ApprovedSourceRunner(store, {
      lifecycle,
      importers: importerSpies(called),
      authority: foregroundAuthority(sources.codex.grant.personId)
    });

    for (const source of allSources(sources)) {
      await expect(runner.runGrant(source.grant.personId, source.grant.candidateId))
        .resolves.toMatchObject({ ok: true, candidateId: source.grant.candidateId });
    }

    expect(called).toEqual([
      "codex/codex-rollout-jsonl",
      "claude-code/claude-project-jsonl",
      "openclaw/openclaw-session-jsonl",
      "hermes/hermes-state-sqlite"
    ]);
    expect(approve).not.toHaveBeenCalled();
  });

  it("fails closed for an unsupported exact pair without opening the source", async () => {
    const sources = await syntheticSources();
    const store = new InMemoryStore();
    const lifecycle = new SourceLifecycleService(store);
    const unsupported = { ...sources.codex.grant, format: "codex-unknown-v99" };
    await store.saveSourceGrant(unsupported);
    const open = vi.fn();
    const runner = new ApprovedSourceRunner(store, {
      lifecycle,
      importers: importerSpies([], open),
      authority: foregroundAuthority(unsupported.personId)
    });

    await expect(runner.runGrant(unsupported.personId, unsupported.candidateId)).resolves.toMatchObject({
      ok: false,
      category: "unsupported_format"
    });
    expect(open).not.toHaveBeenCalled();
  });

  it("checks approval before opening and again inside the atomic commit", async () => {
    const sources = await syntheticSources();
    const store = new InMemoryStore();
    const lifecycle = new SourceLifecycleService(store);
    await seedGrants(store, sources);
    await lifecycle.revoke(
      sources.codex.grant.personId,
      sources.codex.grant.candidateId,
      "user",
      "2026-07-17T12:01:00.000Z"
    );
    const open = vi.fn();
    const runner = new ApprovedSourceRunner(store, {
      lifecycle,
      importers: importerSpies([], open),
      authority: foregroundAuthority(sources.codex.grant.personId)
    });

    await expect(runner.runGrant(sources.codex.grant.personId, sources.codex.grant.candidateId))
      .resolves.toMatchObject({ ok: false, category: "grant_revoked" });
    expect(open).not.toHaveBeenCalled();
    expect(await store.listCanonicalEvents(sources.codex.grant.personId)).toEqual([]);
    expect(await store.listImportCheckpoints(sources.codex.grant.personId)).toEqual([]);

    const grant = sources.claudeCode.grant;
    const originalCommit = store.commitImportBatch.bind(store);
    const commit = vi.spyOn(store, "commitImportBatch").mockImplementationOnce(async (input) => {
      await lifecycle.revoke(grant.personId, grant.candidateId, "user", "2026-07-17T12:02:00.000Z");
      return originalCommit(input);
    });
    const commitRunner = new ApprovedSourceRunner(store, {
      lifecycle,
      authority: foregroundAuthority(grant.personId),
      importers: {
        ...importerSpies([]),
        claudeCode: {
          importApprovedGrantBatch: async (approvedGrant: SourceGrant) =>
            store.commitImportBatch(emptyCommit(approvedGrant))
        }
      }
    });
    await expect(commitRunner.runGrant(grant.personId, grant.candidateId)).resolves.toMatchObject({
      ok: false,
      category: "grant_revoked"
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(await store.listCanonicalEvents(grant.personId)).toEqual([]);
  });

  it("imports appended complete records, returns only changed canonical IDs, and converges on replay", async () => {
    const sources = await syntheticSources();
    const store = new InMemoryStore();
    await seedGrants(store, sources);
    const runner = new ApprovedSourceRunner(store, {
      clock: () => FIXED_NOW,
      authority: foregroundAuthority(sources.codex.grant.personId)
    });

    const first = await runner.runGrant(sources.codex.grant.personId, sources.codex.grant.candidateId);
    expect(first.ok && first.receipt.canonicalEventIds).toHaveLength(1);
    expect(first.ok && first.receipt.canonicalOrderKeys).toHaveLength(1);

    const noOp = await runner.runGrant(sources.codex.grant.personId, sources.codex.grant.candidateId);
    expect(noOp.ok && noOp.receipt.canonicalEventIds).toEqual([]);
    expect(noOp.ok && noOp.receipt.canonicalOrderKeys).toEqual([]);

    await appendFile(sources.codex.nativePath, `${JSON.stringify({
      timestamp: "2026-07-17T12:01:00.000Z",
      type: "response_item",
      payload: { type: "message", id: "codex-appended", role: "assistant", content: "Appended synthetic event." }
    })}\n`);
    const appended = await runner.runGrant(sources.codex.grant.personId, sources.codex.grant.candidateId);
    expect(appended.ok && appended.receipt.canonicalEventIds).toHaveLength(1);
    expect(new Set((await store.listCanonicalEvents(sources.codex.grant.personId)).map((event) => event.id)).size)
      .toBe(2);
  });

  it("does not advance beyond an incomplete JSONL record and excludes tool results from events and quarantine", async () => {
    const sources = await syntheticSources();
    const store = new InMemoryStore();
    await seedGrants(store, sources);
    const runner = new ApprovedSourceRunner(store, {
      clock: () => FIXED_NOW,
      authority: foregroundAuthority(sources.codex.grant.personId)
    });
    await runner.runGrant(sources.codex.grant.personId, sources.codex.grant.candidateId);
    const partial = JSON.stringify({
      timestamp: "2026-07-17T12:02:00.000Z",
      type: "response_item",
      payload: { type: "message", id: "partial-event", role: "user", content: "Wait for newline." }
    });
    await appendFile(sources.codex.nativePath, partial);

    const before = await store.listImportCheckpoints(sources.codex.grant.personId);
    const incomplete = await runner.runGrant(sources.codex.grant.personId, sources.codex.grant.candidateId);
    expect(incomplete.ok && incomplete.receipt.canonicalEventIds).toEqual([]);
    expect(await store.listImportCheckpoints(sources.codex.grant.personId)).toEqual(before);

    await appendFile(sources.codex.nativePath, `\n${JSON.stringify({
      timestamp: "2026-07-17T12:03:00.000Z",
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call-1", output: "SECRET_RESULT" }
    })}\n`);
    const complete = await runner.runGrant(sources.codex.grant.personId, sources.codex.grant.candidateId);
    expect(complete.ok && complete.receipt.canonicalEventIds).toHaveLength(1);
    expect(await store.listQuarantineRecords(sources.codex.grant.personId, sources.codex.grant.candidateId))
      .toEqual([]);
    expect(JSON.stringify(await store.listCanonicalEvents(sources.codex.grant.personId))).not.toContain("SECRET_RESULT");
  });

  it("resets safely after JSONL truncation or rotation and preserves deterministic IDs", async () => {
    const sources = await syntheticSources();
    const store = new InMemoryStore();
    await seedGrants(store, sources);
    const runner = new ApprovedSourceRunner(store, {
      clock: () => FIXED_NOW,
      authority: foregroundAuthority(sources.openClaw.grant.personId)
    });
    await runner.runGrant(sources.openClaw.grant.personId, sources.openClaw.grant.candidateId);
    const originalIds = (await store.listCanonicalEvents(sources.openClaw.grant.personId)).map((event) => event.id);

    const rotatedPath = `${sources.openClaw.nativePath}.old`;
    await rename(sources.openClaw.nativePath, rotatedPath);
    await writeFile(sources.openClaw.nativePath, await readFile(rotatedPath));
    const rotation = await runner.runGrant(sources.openClaw.grant.personId, sources.openClaw.grant.candidateId);
    expect(rotation.ok && rotation.receipt.canonicalEventIds).toEqual([]);
    expect((await store.listCanonicalEvents(sources.openClaw.grant.personId)).map((event) => event.id)).toEqual(originalIds);

    await truncate(sources.openClaw.nativePath, 0);
    await expect(runner.runGrant(sources.openClaw.grant.personId, sources.openClaw.grant.candidateId))
      .resolves.toMatchObject({ ok: true });
    expect((await store.listCanonicalEvents(sources.openClaw.grant.personId)).map((event) => event.id)).toEqual(originalIds);
  });

  it("uses Hermes row IDs as a high-water mark and isolates a temporarily absent source", async () => {
    const sources = await syntheticSources();
    const store = new InMemoryStore();
    await seedGrants(store, sources);
    const runner = new ApprovedSourceRunner(store, {
      clock: () => FIXED_NOW,
      authority: foregroundAuthority(sources.hermes.grant.personId)
    });
    await runner.runGrant(sources.hermes.grant.personId, sources.hermes.grant.candidateId);
    const replay = await runner.runGrant(sources.hermes.grant.personId, sources.hermes.grant.candidateId);
    expect(replay.ok && replay.receipt.canonicalEventIds).toEqual([]);
    expect((await store.listImportCheckpoints(sources.hermes.grant.personId))[0]?.rowHighWaterMark).toBe("1");

    await rename(sources.codex.nativePath, `${sources.codex.nativePath}.temporarily-absent`);
    const outcomes = await runner.runAllApproved(sources.codex.grant.personId);
    expect(outcomes.find((outcome) => outcome.candidateId === sources.codex.grant.candidateId))
      .toMatchObject({ ok: false, category: "temporarily_absent" });
    expect(outcomes.some((outcome) => outcome.candidateId === sources.claudeCode.grant.candidateId && outcome.ok))
      .toBe(true);
  });

  it("never changes any approved native fixture", async () => {
    const sources = await syntheticSources();
    const store = new InMemoryStore();
    await seedGrants(store, sources);
    const before = await fixtureHashes(sources);
    await new ApprovedSourceRunner(store, {
      clock: () => FIXED_NOW,
      authority: foregroundAuthority(sources.codex.grant.personId)
    }).runAllApproved(sources.codex.grant.personId);
    expect(await fixtureHashes(sources)).toEqual(before);
  });
});

async function syntheticSources(): Promise<SyntheticDaemonSources> {
  const sources = await createSyntheticApprovedSources();
  cleanups.push(sources.cleanup);
  return sources;
}

function daemonAuthority(ownerToken: string): WriteAuthority {
  return { kind: "daemon", databaseId: "memory-db", ownerToken };
}

function foregroundAuthority(personId: string): WriteAuthority {
  return { kind: "foreground", personId, operation: "approved-import" };
}

async function importPublicationSnapshot(store: InMemoryStore, personId: string, candidateId: string) {
  return {
    grants: await store.listSourceGrants(personId),
    sources: await store.listSources(personId),
    events: await store.listCanonicalEvents(personId),
    turns: await store.listTurns(`person:${personId}`),
    quarantine: await store.listQuarantineRecords(personId, candidateId),
    checkpoints: await store.listImportCheckpoints(personId),
    receipts: await store.listImportBatchReceipts(personId),
    jobs: await store.listContractionJobs(personId)
  };
}

function allSources(sources: SyntheticDaemonSources): SyntheticApprovedSource[] {
  return [sources.codex, sources.claudeCode, sources.openClaw, sources.hermes];
}

async function seedGrants(store: InMemoryStore, sources: SyntheticDaemonSources): Promise<void> {
  for (const source of allSources(sources)) await store.saveSourceGrant(source.grant);
}

function importerSpies(calls: string[], onOpen: () => void = () => undefined) {
  const importer = (pair: string) => ({
    importApprovedGrantBatch: vi.fn(async (grant: SourceGrant): Promise<ImportBatchReceipt> => {
      onOpen();
      calls.push(pair);
      return receipt(grant);
    })
  });
  return {
    codex: importer("codex/codex-rollout-jsonl"),
    claudeCode: importer("claude-code/claude-project-jsonl"),
    openClaw: importer("openclaw/openclaw-session-jsonl"),
    hermes: importer("hermes/hermes-state-sqlite"),
    cordis: importer("cordis/cordis-journal-sqlite")
  };
}

function receipt(grant: SourceGrant): ImportBatchReceipt {
  return {
    id: `receipt_${grant.candidateId}`,
    personId: grant.personId,
    grantId: grant.id,
    candidateId: grant.candidateId,
    scopeId: grant.scopeId,
    canonicalEventIds: [],
    canonicalOrderKeys: [],
    checkpointIds: [],
    committedAt: FIXED_NOW
  };
}

function emptyCommit(grant: SourceGrant): CommitImportBatchInput {
  const checkpointId = `checkpoint_${grant.candidateId}`;
  const batchReceipt = { ...receipt(grant), checkpointIds: [checkpointId] };
  return {
    authority: { kind: "foreground", personId: grant.personId, operation: "approved-import" },
    personId: grant.personId,
    expectedGrant: {
      id: grant.id,
      personId: grant.personId,
      candidateId: grant.candidateId,
      updatedAt: grant.updatedAt
    },
    sources: [],
    canonicalEvents: [],
    turns: [],
    quarantineChanges: [],
    checkpoint: {
      id: checkpointId,
      personId: grant.personId,
      candidateId: grant.candidateId,
      resourcePath: "synthetic.jsonl",
      fileIdentity: "synthetic:1",
      byteOffset: 0,
      recordIndex: 0,
      nativeSessionId: null,
      parserVersion: "synthetic/v1",
      updatedAt: FIXED_NOW
    },
    receipt: batchReceipt,
    contractionJob: null
  };
}

async function fixtureHashes(sources: SyntheticDaemonSources): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(allSources(sources).map(async (source) => {
    const metadata = await stat(source.nativePath);
    const bytes = await readFile(source.nativePath);
    return [source.application, `${metadata.size}:${createHash("sha256").update(bytes).digest("hex")}`];
  })));
}
