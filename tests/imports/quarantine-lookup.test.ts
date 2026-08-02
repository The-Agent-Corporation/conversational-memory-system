import { appendFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeHistoryImporter } from "../../src/imports/claude-importer.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import { createSyntheticClaudeCodeSource } from "../daemon/fixtures.js";
import type { SourceGrant } from "../../src/domain/source-lifecycle.js";

/**
 * `seedStagingImportState` used to copy every existing quarantine record for the candidate into the
 * staging store, purely so `QuarantineService.capture` could find the prior record and preserve its
 * `replay_requested` state and original `createdAt`. On the live corpus that was 174,149 records for
 * a single source, inserted one at a time through a linear-scan upsert — quadratic, and it dominated
 * the whole import before any history was read.
 *
 * The service now reads prior records straight from the durable store, so nothing is staged. These
 * tests pin the behaviour that justified the seed in the first place, so it cannot be lost silently.
 */
describe("quarantine state survives a re-import without being staged", () => {
  let source: Awaited<ReturnType<typeof createSyntheticClaudeCodeSource>>;
  let store: InMemoryStore;
  let grant: SourceGrant;

  const authority = (personId: string) =>
    ({ kind: "foreground" as const, personId, operation: "approved-import" as const });

  beforeEach(async () => {
    source = await createSyntheticClaudeCodeSource();
    // A record the parser cannot read, so the import quarantines it.
    await appendFile(source.nativePath, "{ this is not valid json\n");
    store = new InMemoryStore();
    grant = source.grant;
    await store.saveSourceGrant(grant);
  });

  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(source.rootPath, { recursive: true, force: true });
  });

  /** Invalidate every checkpoint so the next import re-reads the file and re-captures. */
  const forceFullReread = async () => {
    for (const checkpoint of await store.listImportCheckpoints(grant.personId)) {
      await store.saveImportCheckpoint({ ...checkpoint, parserVersion: "forced-reset/v0" });
    }
  };

  it("preserves replay_requested state and the original createdAt across a re-import", async () => {
    const importer = new ClaudeHistoryImporter(store);
    await importer.importApprovedGrantBatch(grant, { authority: authority(grant.personId) });

    const [captured] = await store.listQuarantineRecords(grant.personId, grant.candidateId);
    expect(captured).toBeDefined();

    // An operator asks for this record to be replayed.
    await store.saveQuarantineRecord({
      ...captured,
      state: "replay_requested",
      replayRequestedAt: "2026-08-02T00:00:00.000Z"
    });

    await forceFullReread();
    await importer.importApprovedGrantBatch(grant, { authority: authority(grant.personId) });

    const [after] = await store.listQuarantineRecords(grant.personId, grant.candidateId);
    // Without a durable lookup the staging store is empty, `existing` is undefined, and this record
    // silently reverts to `pending` with a fresh createdAt -- losing the operator's replay request.
    expect(after.state).toBe("replay_requested");
    expect(after.replayRequestedAt).toBe("2026-08-02T00:00:00.000Z");
    expect(after.createdAt).toBe(captured.createdAt);
  });

  it("does not stage pre-existing quarantine records as if they were new changes", async () => {
    const importer = new ClaudeHistoryImporter(store);
    await importer.importApprovedGrantBatch(grant, { authority: authority(grant.personId) });
    const afterFirst = await store.listQuarantineRecords(grant.personId, grant.candidateId);

    await forceFullReread();
    await importer.importApprovedGrantBatch(grant, { authority: authority(grant.personId) });

    // Re-importing must not duplicate or multiply the quarantine set.
    const afterSecond = await store.listQuarantineRecords(grant.personId, grant.candidateId);
    expect(afterSecond).toHaveLength(afterFirst.length);
  });
});
