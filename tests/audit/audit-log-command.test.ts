import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAuditLogCommand } from "../../src/audit/audit-log-command.js";
import { SourceLifecycleService } from "../../src/service/source-lifecycle-service.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";

const PERSON_ID = "person-audit-log";
const T1 = "2026-07-20T10:00:00.000Z";
const T2 = "2026-07-20T11:00:00.000Z";
const T3 = "2026-07-20T12:00:00.000Z";

describe("runAuditLogCommand (append-only, metadata-only audit export)", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  const seed = async (): Promise<string> => {
    tempDir = await mkdtemp(join(tmpdir(), "memory-audit-log-"));
    const databasePath = join(tempDir, "memory.sqlite");
    const store = new SqliteStore(databasePath);
    try {
      const service = new SourceLifecycleService(store);
      await service.approve({
        personId: PERSON_ID,
        candidateId: "candidate-one",
        application: "synthetic-host",
        format: "jsonl",
        sourceLocator: "/synthetic/root-one",
        profileId: "synthetic-profile",
        scopeId: "scope-a",
        approvedAt: T1
      });
      await service.approve({
        personId: PERSON_ID,
        candidateId: "candidate-two",
        application: "synthetic-host",
        format: "jsonl",
        sourceLocator: "/synthetic/root-two",
        profileId: "synthetic-profile",
        scopeId: "scope-a",
        approvedAt: T2
      });
      await service.revoke(PERSON_ID, "candidate-two", "user", T3);
    } finally {
      store.close();
    }
    return databasePath;
  };

  it("exports every persisted audit row as bounded metadata with no free-text content field", async () => {
    const databasePath = await seed();

    const result = await runAuditLogCommand({ databasePath, personId: PERSON_ID });

    expect(result.ok).toBe(true);
    expect(result.count).toBe(3);
    for (const entry of result.entries) {
      expect(entry.actor).toBeTypeOf("string");
      expect(entry.occurredAt).toBeTypeOf("string");
      expect(["approved", "revoked", "deletion_requested", "deletion_completed", "quarantine_replay_requested"])
        .toContain(entry.action);
      for (const value of Object.values(entry.detail)) {
        if (typeof value === "string") expect(value.length).toBeLessThanOrEqual(2_000);
      }
      // Metadata-only discipline (ADR 0044, Pitfall 5): no field on the entry itself is an
      // unbounded free-text message/content field — every top-level key is identity/action/time.
      expect(Object.keys(entry)).toEqual(["id", "personId", "candidateId", "action", "actor", "occurredAt", "detail"]);
    }
  });

  it("filters by action", async () => {
    const databasePath = await seed();

    const result = await runAuditLogCommand({ databasePath, personId: PERSON_ID, action: "approved" });

    expect(result.count).toBe(2);
    expect(result.entries.every((entry) => entry.action === "approved")).toBe(true);
  });

  it("filters by candidateId", async () => {
    const databasePath = await seed();

    const result = await runAuditLogCommand({ databasePath, personId: PERSON_ID, candidateId: "candidate-two" });

    expect(result.count).toBe(2);
    expect(result.entries.every((entry) => entry.candidateId === "candidate-two")).toBe(true);
  });

  it("filters by time range (from/to)", async () => {
    const databasePath = await seed();

    const result = await runAuditLogCommand({ databasePath, personId: PERSON_ID, from: T2, to: T2 });

    expect(result.count).toBe(1);
    expect(result.entries[0].occurredAt).toBe(T2);
  });
});
