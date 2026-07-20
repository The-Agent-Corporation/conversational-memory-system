import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInitCommand } from "../../src/bootstrap/init-command.js";
import { SourceLifecycleService } from "../../src/service/source-lifecycle-service.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";
import { historicalBootstrapCheckpointId } from "../../src/bootstrap/historical-bootstrapper.js";

describe("guided init orchestration (discover -> per-source consent -> bootstrap -> offer daemon)", () => {
  let tempDirectory: string | undefined;

  afterEach(async () => {
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
  });

  it("discovers before granting, skips declined sources, bootstraps only approved ones, and offers the daemon last", async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "memory-init-command-"));
    const databasePath = join(tempDirectory, "memory.db");
    const approvedRoot = join(tempDirectory, "claude-src");
    const declinedRoot = join(tempDirectory, "openclaw-src");
    await mkdir(approvedRoot, { recursive: true });
    await mkdir(declinedRoot, { recursive: true });

    const personId = "person_1";
    const store = new SqliteStore(databasePath);
    await store.savePerson({ id: personId, displayName: null, createdAt: "2026-07-16T10:00:00.000Z" });
    await store.saveSource({
      id: "source_1",
      personId,
      application: "codex",
      profileId: "default",
      instanceId: "seed",
      createdAt: "2026-07-16T10:00:00.000Z",
      lastImportedAt: "2026-07-16T10:01:00.000Z"
    });
    await store.saveCanonicalEvent({
      id: "event_1",
      personId,
      sourceId: "source_1",
      sourceApplication: "codex",
      sourceProfileId: "default",
      nativeSessionId: "session_1",
      nativeEventId: "message_1",
      nativeSequence: 1,
      causalParentId: null,
      role: "user",
      content: "Pre-existing canonical event to force a real bootstrap pass.",
      occurredAt: "2026-07-16T10:00:00.000Z",
      importedAt: "2026-07-16T10:01:00.000Z",
      provenance: "direct_user_input",
      trustLevel: "high",
      contentHash: "hash_1",
      parserVersion: "codex-rollout/v1",
      metadata: {}
    });
    store.close();

    const callOrder: string[] = [];

    const result = await runInitCommand({
      databasePath,
      personId,
      sources: [
        { source: "claude-code", sourcePath: approvedRoot },
        { source: "openclaw", sourcePath: declinedRoot }
      ],
      consent: async (candidate) => {
        // Discover-before-grant: the candidate exists (proving discovery already ran) but
        // no grant has been persisted for it yet at the moment consent is requested.
        const checkStore = new SqliteStore(databasePath);
        try {
          const grant = await checkStore.getSourceGrant(new SourceLifecycleService(checkStore).grantId(personId, candidate.id));
          expect(grant).toBeNull();
        } finally {
          checkStore.close();
        }
        callOrder.push(`consent:${candidate.application}`);
        return candidate.application === "claude-code";
      },
      offerDaemon: async ({ approvedCandidateIds }) => {
        // By the time the daemon offer happens, the approved source must already be granted
        // and bootstrap must already have run (its checkpoint persisted).
        const checkStore = new SqliteStore(databasePath);
        try {
          for (const candidateId of approvedCandidateIds) {
            const grant = await checkStore.getSourceGrant(new SourceLifecycleService(checkStore).grantId(personId, candidateId));
            expect(grant).toMatchObject({ state: "approved" });
          }
          const checkpoint = await checkStore.getBootstrapCheckpoint(historicalBootstrapCheckpointId(personId));
          expect(checkpoint).not.toBeNull();
        } finally {
          checkStore.close();
        }
        callOrder.push("offerDaemon");
        return false;
      }
    });

    expect(callOrder).toEqual(["consent:claude-code", "consent:openclaw", "offerDaemon"]);

    expect(result.ok).toBe(true);
    expect(result.approvedCandidateIds).toHaveLength(1);
    expect(result.declinedCandidateIds).toHaveLength(1);
    expect(result.bootstrap).toMatchObject({ eventsProcessed: 1 });
    expect(result.daemonOffered).toBe(true);
    expect(result.daemonStarted).toBe(false);

    const finalStore = new SqliteStore(databasePath);
    try {
      const lifecycle = new SourceLifecycleService(finalStore);
      const approvedGrant = await finalStore.getSourceGrant(lifecycle.grantId(personId, result.approvedCandidateIds[0]));
      expect(approvedGrant).toMatchObject({ state: "approved" });

      const declinedGrant = await finalStore.getSourceGrant(lifecycle.grantId(personId, result.declinedCandidateIds[0]));
      expect(declinedGrant).toBeNull();

      // No import for a declined source: the only canonical event present is the pre-seeded
      // one, unrelated to the declined openclaw candidate.
      const events = await finalStore.listCanonicalEvents(personId);
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe("event_1");
    } finally {
      finalStore.close();
    }
  });

  it("never bootstraps or grants when every discovered source is declined", async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "memory-init-command-declined-"));
    const databasePath = join(tempDirectory, "memory.db");
    const declinedRoot = join(tempDirectory, "claude-src");
    await mkdir(declinedRoot, { recursive: true });

    const personId = "person_1";
    const store = new SqliteStore(databasePath);
    await store.savePerson({ id: personId, displayName: null, createdAt: "2026-07-16T10:00:00.000Z" });
    store.close();

    const result = await runInitCommand({
      databasePath,
      personId,
      sources: [{ source: "claude-code", sourcePath: declinedRoot }],
      consent: async () => false,
      offerDaemon: async () => false
    });

    expect(result.approvedCandidateIds).toHaveLength(0);
    expect(result.declinedCandidateIds).toHaveLength(1);
    expect(result.bootstrap).toBeNull();
    expect(result.daemonOffered).toBe(true);
    expect(result.daemonStarted).toBe(false);

    const finalStore = new SqliteStore(databasePath);
    try {
      const lifecycle = new SourceLifecycleService(finalStore);
      const grant = await finalStore.getSourceGrant(lifecycle.grantId(personId, result.declinedCandidateIds[0]));
      expect(grant).toBeNull();
    } finally {
      finalStore.close();
    }
  });
});
