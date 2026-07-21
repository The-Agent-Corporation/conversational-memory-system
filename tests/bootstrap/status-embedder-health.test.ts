import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMemoryStatusCommand } from "../../src/bootstrap/status-command.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";
import { writeEmbeddingsConfig } from "../../src/embeddings/embeddings-config.js";

describe("memory status embedder health (D-06)", () => {
  let tempDirectory: string | undefined;

  afterEach(async () => {
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
  });

  it("reports enabled:false healthy:true for a fresh db with no embeddings config", async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "memory-status-embedder-default-"));
    const databasePath = join(tempDirectory, "memory.db");
    const store = new SqliteStore(databasePath);
    await store.savePerson({ id: "person_1", displayName: null, createdAt: "2026-07-16T10:00:00.000Z" });
    store.close();

    const status = await runMemoryStatusCommand({ databasePath, personId: "person_1" });

    expect(status.embedder).toEqual({
      enabled: false,
      provider: "onnx-transformers",
      model: "Xenova/bge-small-en-v1.5",
      revision: "",
      healthy: true,
      reason: null
    });
  });

  it("reports healthy:false with a reason (never throwing) when enabled but the model is broken/missing", async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "memory-status-embedder-broken-"));
    const databasePath = join(tempDirectory, "memory.db");
    const store = new SqliteStore(databasePath);
    await store.savePerson({ id: "person_1", displayName: null, createdAt: "2026-07-16T10:00:00.000Z" });
    store.close();

    writeEmbeddingsConfig(databasePath, {
      enabled: true,
      provider: "onnx-transformers",
      model: "Xenova/bge-small-en-v1.5",
      revision: "does-not-exist",
      modelPath: join(tempDirectory, "no-such-model-dir")
    });

    // The D-06 contract: runMemoryStatusCommand must RESOLVE (not reject),
    // reporting the broken embedder as unhealthy rather than crashing.
    const status = await runMemoryStatusCommand({ databasePath, personId: "person_1" });

    expect(status.ok).toBe(true);
    expect(status.embedder.enabled).toBe(true);
    expect(status.embedder.healthy).toBe(false);
    expect(status.embedder.reason).toEqual(expect.any(String));
    expect(status.embedder.reason).not.toBeNull();
  });
});
