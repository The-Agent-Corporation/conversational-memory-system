import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readTuneConfig, runTuneCommand } from "../../src/operations/tune-command.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";

describe("tune command", () => {
  let tempDirectory: string | undefined;

  afterEach(async () => {
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
  });

  it("shows default knob values against a fresh database", async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "memory-tune-command-"));
    const databasePath = join(tempDirectory, "memory.db");
    new SqliteStore(databasePath).close();

    const result = await runTuneCommand({ databasePath, action: "show" });

    expect(result).toMatchObject({
      ok: true,
      action: "show",
      config: {
        busyTimeoutMs: 5_000,
        retrievalDefaultLimit: 20,
        retrievalDefaultTokenBudget: 2_000
      }
    });
  });

  it("sets busy_timeout and honors it on the next store open", async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "memory-tune-command-busy-"));
    const databasePath = join(tempDirectory, "memory.db");
    new SqliteStore(databasePath).close();

    const result = await runTuneCommand({
      databasePath,
      action: "set",
      knob: "busy_timeout",
      value: 12_345
    });

    expect(result.ok).toBe(true);
    expect(result.config.busyTimeoutMs).toBe(12_345);
    expect(result.appliedBusyTimeoutMs).toBe(12_345);

    const persisted = readTuneConfig(databasePath);
    expect(persisted.busyTimeoutMs).toBe(12_345);

    const reopened = new SqliteStore(databasePath, { busyTimeoutMs: persisted.busyTimeoutMs });
    try {
      expect(reopened.getBusyTimeoutMs()).toBe(12_345);
    } finally {
      reopened.close();
    }
  });

  it("rejects an out-of-bound busy_timeout value", async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "memory-tune-command-bounds-"));
    const databasePath = join(tempDirectory, "memory.db");
    new SqliteStore(databasePath).close();

    await expect(
      runTuneCommand({ databasePath, action: "set", knob: "busy_timeout", value: 999_999 })
    ).rejects.toThrow();
  });

  it("sets retrieval defaults and reflects them on show", async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "memory-tune-command-retrieval-"));
    const databasePath = join(tempDirectory, "memory.db");
    new SqliteStore(databasePath).close();

    await runTuneCommand({ databasePath, action: "set", knob: "retrieval_default_limit", value: 42 });
    await runTuneCommand({ databasePath, action: "set", knob: "retrieval_default_token_budget", value: 3_500 });

    const shown = await runTuneCommand({ databasePath, action: "show" });
    expect(shown.config.retrievalDefaultLimit).toBe(42);
    expect(shown.config.retrievalDefaultTokenBudget).toBe(3_500);
  });

  it("runs REINDEX/ANALYZE without error and reports success", async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "memory-tune-command-reindex-"));
    const databasePath = join(tempDirectory, "memory.db");
    new SqliteStore(databasePath).close();

    const result = await runTuneCommand({ databasePath, action: "reindex" });

    expect(result.ok).toBe(true);
    expect(result.reindexed).toBe(true);
  });
});
