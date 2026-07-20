import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runExplainCommand } from "../../src/audit/explain-command.js";
import { SourceLifecycleService } from "../../src/service/source-lifecycle-service.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";

const NOW = "2026-07-20T12:00:00.000Z";
const PERSON_ID = "person-explain-cli";

describe("runExplainCommand (memory explain <id> CLI)", () => {
  let tempDir: string | undefined;
  let databasePath: string | undefined;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
    databasePath = undefined;
  });

  const seed = async (): Promise<string> => {
    tempDir = await mkdtemp(join(tmpdir(), "memory-explain-cli-"));
    databasePath = join(tempDir, "memory.sqlite");
    const store = new SqliteStore(databasePath);
    try {
      await new SourceLifecycleService(store).approve({
        personId: PERSON_ID,
        candidateId: "candidate-cli",
        application: "synthetic-host",
        format: "jsonl",
        sourceLocator: "/synthetic/root",
        profileId: "synthetic-profile",
        scopeId: "scope-a",
        approvedAt: NOW
      });
    } finally {
      store.close();
    }
    return databasePath;
  };

  it("returns the lifecycle trace for an authorized id with --all-scopes", async () => {
    const dbPath = await seed();

    const result = await runExplainCommand({
      databasePath: dbPath,
      personId: PERSON_ID,
      itemId: "candidate-cli",
      allScopes: true
    });

    expect(result.ok).toBe(true);
    expect(result.trace.kind).toBe("source");
    expect(result.trace.events.map((event) => event.verb)).toContain("imported");
  });

  it("returns the uniform UNAUTHORIZED_OR_NOT_FOUND failure for an unauthorized/nonexistent id", async () => {
    const dbPath = await seed();

    await expect(runExplainCommand({
      databasePath: dbPath,
      personId: "someone-else-entirely",
      itemId: "candidate-cli"
    })).rejects.toThrow("UNAUTHORIZED_OR_NOT_FOUND");

    await expect(runExplainCommand({
      databasePath: dbPath,
      personId: PERSON_ID,
      itemId: "totally-unknown-id"
    })).rejects.toThrow("UNAUTHORIZED_OR_NOT_FOUND");
  });
});
