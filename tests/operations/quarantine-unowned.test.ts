import { linkSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import type { Anchor, Box, MemoryTrace, Summary } from "../../src/domain/types.js";
import { LEGACY_UNOWNED_MARKER } from "../../src/operations/legacy-unowned.js";
import { quarantineUnownedLegacyRows } from "../../src/operations/quarantine-unowned-command.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";

const NOW = "2026-11-05T18:00:00.000Z";
const SECRET = "sk-liveFixtureSecretValue99";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (location: string) => {
    prepare(sql: string): {
      get(...args: unknown[]): { c: number; payload: string } | undefined;
      run(...args: unknown[]): void;
    };
    close(): void;
  };
};

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

const summary = (overrides: Partial<Summary> = {}): Summary => ({
  id: "summary_owned",
  personId: "person_owned",
  scopeIds: ["personal"],
  summaryText: "Owned summary stays with its person.",
  sourceTurnRanges: [{ threadId: "session", startSequence: 1, endSequence: 1 }],
  sourceSummaryIds: [],
  boxIds: [],
  embedding: null,
  createdAt: NOW,
  model: "test",
  promptVersion: "v1",
  confidence: 0.5,
  state: "active",
  detailLevel: "brief",
  tokenCount: 4,
  lastAccessedAt: null,
  version: 1,
  strength: 0.5,
  retrievalCount: 0,
  retrievedAt: null,
  halfLifeHours: 24,
  outcomeScore: null,
  ...overrides
});

const box = (overrides: Partial<Box> = {}): Box => ({
  id: "box_owned",
  personId: "person_owned",
  title: "Owned box",
  description: "stays",
  parentBoxId: null,
  childBoxIds: [],
  summaryIds: [],
  turnRanges: [],
  state: "active",
  createdAt: NOW,
  updatedAt: NOW,
  caseId: null,
  boxType: "general",
  summary: "owned",
  lastActivityAt: NOW,
  ...overrides
});

const trace = (overrides: Partial<MemoryTrace> = {}): MemoryTrace => ({
  id: "trace_owned",
  personId: "person_owned",
  title: "Owned trace",
  description: "stays",
  traceType: "case_issue",
  state: "approved",
  summaryIds: ["summary_a", "summary_b"],
  boxIds: [],
  turnRanges: [{ threadId: "session", startSequence: 1, endSequence: 1 }],
  createdAt: NOW,
  updatedAt: NOW,
  lastActivityAt: NOW,
  confidence: 0.5,
  rationale: "owned",
  ...overrides
});

const anchor = (overrides: Partial<Anchor> = {}): Anchor => ({
  id: "anchor_owned",
  personId: "person_owned",
  turnId: "turn_1",
  threadId: "session",
  boxId: null,
  anchorType: "key_fact",
  content: "Owned anchor",
  embedding: null,
  createdAt: NOW,
  trustLevel: "medium",
  source: "direct_user_input",
  ...overrides
});

const withoutOwner = <T extends { personId?: string }>(record: T): T => {
  const copy = { ...record };
  delete copy.personId;
  return copy;
};

describe("legacy unowned quarantine", () => {
  it("quarantines rows with no person and leaves owned rows untouched", async () => {
    const store = new InMemoryStore();
    await store.saveSummary(summary());
    await store.saveSummary(withoutOwner(summary({
      id: "summary_unowned",
      summaryText: `Unowned note with ${SECRET}`
    })));
    await store.saveBox(box());
    await store.saveBox(withoutOwner(box({ id: "box_unowned", title: "Unowned box" })));
    await store.saveTrace(trace());
    await store.saveTrace(withoutOwner(trace({ id: "trace_unowned", title: "Unowned trace" })));
    await store.saveAnchor(anchor());
    await store.saveAnchor(withoutOwner(anchor({ id: "anchor_unowned", content: "Unowned anchor" })));
    await store.saveSummaryVector({
      summaryId: "summary_unowned",
      provider: "hash",
      model: "test",
      dimensions: 1,
      vector: [1],
      personId: "person_owned",
      scopeIds: ["personal"],
      createdAt: NOW
    });

    const receipt = await store.commitLegacyUnownedQuarantine({
      operation: "legacy_unowned_quarantine",
      summaryIds: ["summary_unowned", "summary_owned", "summary_missing"],
      boxIds: ["box_unowned"],
      traceIds: ["trace_unowned"],
      anchorIds: ["anchor_unowned"],
      requestedAt: NOW
    });

    expect(receipt.marker).toBe(LEGACY_UNOWNED_MARKER);
    expect(receipt.quarantinedSummaryIds).toEqual(["summary_unowned"]);
    expect(receipt.quarantinedBoxIds).toEqual(["box_unowned"]);
    expect(receipt.quarantinedTraceIds).toEqual(["trace_unowned"]);
    expect(receipt.quarantinedAnchorIds).toEqual(["anchor_unowned"]);
    expect(receipt.skipped).toEqual(expect.arrayContaining([
      { kind: "summary", id: "summary_owned", reason: "already_owned" },
      { kind: "summary", id: "summary_missing", reason: "not_found" }
    ]));
    expect((await store.listSummaries()).map((item) => item.id)).toEqual(["summary_owned"]);
    expect((await store.listSummaries())[0]?.personId).toBe("person_owned");
    expect(await store.listBoxes()).toHaveLength(1);
    expect(await store.listTraces()).toHaveLength(1);
    expect(await store.listAnchors()).toHaveLength(1);
    const records = await store.listQuarantineRecords(LEGACY_UNOWNED_MARKER);
    expect(records).toHaveLength(4);
    expect(records.every((record) => record.personId === LEGACY_UNOWNED_MARKER)).toBe(true);
    expect(records.every((record) => record.reason === "unsupported_record")).toBe(true);
    expect(records.map((record) => record.sanitizedRecord).join("\n")).toContain("[REDACTED]");
    expect(records.map((record) => record.sanitizedRecord).join("\n")).not.toContain(SECRET);
    expect(await store.findNearestSummaries({
      personId: "person_owned",
      allowedScopeIds: ["personal"],
      vector: [1],
      provider: "hash",
      model: "test",
      topK: 5
    })).toEqual([]);
  });
});

describe("quarantine-unowned command", () => {
  it("dry-run lists unowned ids and apply requires a backup before removing them", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cms-unowned-"));
    const databasePath = join(tempDir, "memory.sqlite");
    const store = new SqliteStore(databasePath);
    await store.saveSummary(summary());
    await store.saveSummary(withoutOwner(summary({ id: "summary_unowned", summaryText: "legacy row" })));
    await store.saveSummaryVector({
      summaryId: "summary_unowned",
      provider: "hash",
      model: "test",
      dimensions: 1,
      vector: [1],
      personId: "person_owned",
      scopeIds: ["personal"],
      createdAt: NOW
    });
    store.close();

    const preview = await quarantineUnownedLegacyRows({ databasePath });
    expect(preview.applied).toBe(false);
    expect(preview.summaryIds).toEqual(["summary_unowned"]);
    expect(preview.marker).toBe("legacy-unowned");

    const stillThere = new SqliteStore(databasePath, { readOnly: true });
    expect((await stillThere.listSummaries()).map((item) => item.id).sort()).toEqual(["summary_owned", "summary_unowned"]);
    stillThere.close();

    await expect(quarantineUnownedLegacyRows({ databasePath, apply: true })).rejects.toThrow(/confirm-backup/);

    const backupPath = join(tempDir, "backup.bin");
    await writeFile(backupPath, "backup-bytes");
    const applied = await quarantineUnownedLegacyRows({
      databasePath,
      apply: true,
      confirmBackupPath: backupPath,
      now: NOW
    });
    expect(applied.quarantinedSummaryIds).toEqual(["summary_unowned"]);
    const after = new SqliteStore(databasePath, { readOnly: true });
    try {
      expect((await after.listSummaries()).map((item) => item.personId)).toEqual(["person_owned"]);
      const quarantined = await after.listQuarantineRecords(LEGACY_UNOWNED_MARKER);
      expect(quarantined.map((record) => record.candidateId)).toEqual(["summary_unowned"]);
      expect(quarantined[0]?.personId).not.toBe("person_owned");
    } finally {
      after.close();
    }
    const database = new DatabaseSync(databasePath);
    try {
      expect(database.prepare("select count(*) as c from summary_vectors").get()?.c).toBe(0);
    } finally {
      database.close();
    }
  });

  it("dry-run does not create a missing database", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cms-unowned-"));
    const databasePath = join(tempDir, "missing.sqlite");
    await expect(quarantineUnownedLegacyRows({ databasePath })).rejects.toThrow();
    await expect(stat(databasePath)).rejects.toThrow();
  });

  it("apply mode refuses a missing database instead of creating one", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cms-unowned-"));
    const databasePath = join(tempDir, "missing.sqlite");
    const backupPath = join(tempDir, "backup.bin");
    await writeFile(backupPath, "backup-bytes");
    await expect(quarantineUnownedLegacyRows({
      databasePath,
      apply: true,
      confirmBackupPath: backupPath
    })).rejects.toThrow(/does not exist or is unreadable/);
    await expect(stat(databasePath)).rejects.toThrow();
  });

  it("apply mode refuses a directory where a database file was expected", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cms-unowned-"));
    const databasePath = join(tempDir, "not-a-database");
    await mkdir(databasePath);
    const backupPath = join(tempDir, "backup.bin");
    await writeFile(backupPath, "backup-bytes");
    await expect(quarantineUnownedLegacyRows({
      databasePath,
      apply: true,
      confirmBackupPath: backupPath
    })).rejects.toThrow(/not a regular file/);
    expect((await stat(databasePath)).isDirectory()).toBe(true);
  });

  it("apply mode refuses a backup that is the database or a link to it", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cms-unowned-"));
    const databasePath = join(tempDir, "memory.sqlite");
    const store = new SqliteStore(databasePath);
    await store.saveSummary(withoutOwner(summary({ id: "summary_unowned", summaryText: "legacy row" })));
    store.close();
    const symlinkPath = join(tempDir, "db-symlink");
    const hardlinkPath = join(tempDir, "db-hardlink");
    symlinkSync(databasePath, symlinkPath);
    linkSync(databasePath, hardlinkPath);

    for (const confirmBackupPath of [
      databasePath,
      join(tempDir, ".", "memory.sqlite"),
      symlinkPath,
      hardlinkPath
    ]) {
      await expect(quarantineUnownedLegacyRows({
        databasePath: symlinkPath,
        apply: true,
        confirmBackupPath,
        now: NOW
      })).rejects.toThrow(/database file or a link to it/);
    }

    const after = new SqliteStore(databasePath, { readOnly: true });
    try {
      expect((await after.listSummaries()).map((item) => item.id)).toEqual(["summary_unowned"]);
    } finally {
      after.close();
    }
  });

  it("quarantines a requested summary without parsing unrelated rows", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cms-unowned-"));
    const databasePath = join(tempDir, "memory.sqlite");
    const store = new SqliteStore(databasePath);
    await store.saveSummary(withoutOwner(summary({ id: "summary_unowned", summaryText: "legacy row" })));
    store.close();
    const seeded = new DatabaseSync(databasePath);
    seeded.prepare("insert into summaries (id, payload) values (?, ?)").run(
      "summary_malformed",
      JSON.stringify({ id: "summary_malformed" })
    );
    seeded.close();

    const reopened = new SqliteStore(databasePath);
    try {
      const receipt = await reopened.commitLegacyUnownedQuarantine({
        operation: "legacy_unowned_quarantine",
        summaryIds: ["summary_unowned"],
        boxIds: [],
        traceIds: [],
        anchorIds: [],
        requestedAt: NOW
      });
      expect(receipt.quarantinedSummaryIds).toEqual(["summary_unowned"]);
    } finally {
      reopened.close();
    }

    const database = new DatabaseSync(databasePath);
    try {
      expect(database.prepare("select payload from summaries where id = ?").get("summary_malformed")?.payload).toBe(
        JSON.stringify({ id: "summary_malformed" })
      );
    } finally {
      database.close();
    }
  });
});
