import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runBootstrapCommand } from "../../src/bootstrap/bootstrap-command.js";
import { runMemoryStatusCommand } from "../../src/bootstrap/status-command.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";

describe("historical bootstrap commands", () => {
  let tempDirectory: string | undefined;

  afterEach(async () => {
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
  });

  it("processes an imported personal timeline and reports its status", async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "memory-bootstrap-command-"));
    const databasePath = join(tempDirectory, "memory.db");
    const store = new SqliteStore(databasePath);
    await store.savePerson({
      id: "person_1",
      displayName: null,
      createdAt: "2026-07-16T10:00:00.000Z"
    });
    await store.saveSource({
      id: "source_1",
      personId: "person_1",
      application: "codex",
      profileId: "default",
      instanceId: "test",
      createdAt: "2026-07-16T10:00:00.000Z",
      lastImportedAt: "2026-07-16T10:01:00.000Z"
    });
    await store.saveCanonicalEvent({
      id: "event_1",
      personId: "person_1",
      sourceId: "source_1",
      sourceApplication: "codex",
      sourceProfileId: "default",
      nativeSessionId: "session_1",
      nativeEventId: "message_1",
      nativeSequence: 1,
      causalParentId: null,
      role: "user",
      content: "Let's talk about universal memory architecture.",
      occurredAt: "2026-07-16T10:00:00.000Z",
      importedAt: "2026-07-16T10:01:00.000Z",
      provenance: "direct_user_input",
      trustLevel: "high",
      contentHash: "hash_1",
      parserVersion: "codex-rollout/v1",
      metadata: {}
    });
    store.close();

    const bootstrap = await runBootstrapCommand({ databasePath, personId: "person_1" });
    const status = await runMemoryStatusCommand({ databasePath, personId: "person_1" });

    expect(bootstrap).toMatchObject({
      ok: true,
      bootstrap: { eventsProcessed: 1, summariesUpdated: 1 }
    });
    expect(status).toMatchObject({
      ok: true,
      personId: "person_1",
      sourceCount: 1,
      canonicalEventCount: 1,
      historicalSummaryCount: 1,
      bootstrapCheckpoint: { processedEventCount: 1 }
    });
  });
});
