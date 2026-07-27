import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanonicalEvent, Person } from "../../src/domain/canonical.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";
import { MIGRATIONS, runSchemaMigrations, type SchemaMigration } from "../../src/storage/schema-migrations.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (
    location: string,
    options?: { readOnly?: boolean; timeout?: number }
  ) => {
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): {
      all(...anonymousParameters: unknown[]): unknown[];
      get(...anonymousParameters: unknown[]): unknown;
      run(...anonymousParameters: unknown[]): void;
    };
  };
};

const latestVersion = Math.max(...MIGRATIONS.map((migration) => migration.version));

const makePerson = (overrides: Partial<Person> = {}): Person => ({
  id: "person_1",
  displayName: "Test Person",
  createdAt: "2026-07-16T10:00:00.000Z",
  ...overrides
});

const makeCanonicalEvent = (overrides: Partial<CanonicalEvent> = {}): CanonicalEvent => ({
  id: "event_1",
  personId: "person_1",
  sourceId: "source_1",
  sourceApplication: "codex",
  sourceProfileId: "default",
  nativeSessionId: "session_1",
  nativeEventId: "native_1",
  nativeSequence: 1,
  causalParentId: null,
  role: "user",
  content: "Build the universal memory system.",
  occurredAt: "2026-07-16T10:00:00.000Z",
  importedAt: "2026-07-16T10:01:00.000Z",
  provenance: "direct_user_input",
  trustLevel: "high",
  contentHash: "hash_1",
  parserVersion: "codex-jsonl/v1",
  metadata: {},
  ...overrides
});

describe("schema-migrations", () => {
  let tempDir: string;
  let databasePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "memory-schema-migrations-"));
    databasePath = join(tempDir, "memory.db");
  });

  afterEach(async () => {
    await rm(tempDir, { force: true, recursive: true });
  });

  it("brings a fresh database to the latest schema version", () => {
    const store = new SqliteStore(databasePath);
    expect(store.getSchemaVersion()).toBe(latestVersion);
    store.close();

    const raw = new DatabaseSync(databasePath, { readOnly: true });
    const row = raw.prepare("pragma user_version").get() as { user_version: number };
    expect(row.user_version).toBe(latestVersion);
    raw.close();
  });

  it("migrates a pre-versioning database forward without losing data", async () => {
    const store = new SqliteStore(databasePath);
    await store.savePerson(makePerson());
    await store.saveCanonicalEvent(makeCanonicalEvent());
    store.close();

    // Simulate a database created before schema_migrations existed.
    const raw = new DatabaseSync(databasePath);
    raw.exec("drop table if exists schema_migrations");
    raw.exec("pragma user_version = 0");
    raw.close();

    const reopened = new SqliteStore(databasePath);
    expect(reopened.getSchemaVersion()).toBe(latestVersion);
    await expect(reopened.getPerson("person_1")).resolves.toEqual(makePerson());
    await expect(reopened.listCanonicalEvents("person_1")).resolves.toEqual([makeCanonicalEvent()]);
    reopened.close();
  });

  it("leaves data and schema_migrations unchanged when a migration throws", () => {
    const raw = new DatabaseSync(databasePath);
    const throwingMigrations: readonly SchemaMigration[] = [
      { version: 1, description: "baseline", apply: () => {} },
      {
        version: 2,
        description: "intentionally broken migration",
        apply: (database) => {
          database.exec("create table if not exists throwing_migration_marker (id text primary key)");
          database.prepare("insert into throwing_migration_marker (id) values (?)").run("marker");
          throw new Error("boom");
        }
      }
    ];

    expect(() => runSchemaMigrations(raw, throwingMigrations)).toThrow("boom");

    const versionRow = raw.prepare("select max(version) as v from schema_migrations").get() as {
      v: number | null;
    };
    expect(versionRow.v).toBe(1);

    const userVersionRow = raw.prepare("pragma user_version").get() as { user_version: number };
    expect(userVersionRow.user_version).toBe(1);

    const markerExists = raw
      .prepare("select name from sqlite_master where type = 'table' and name = 'throwing_migration_marker'")
      .get();
    expect(markerExists).toBeUndefined();

    raw.close();
  });

  it("applies version 3 (idx_summaries_person_state) when upgrading from version 2", () => {
    const store = new SqliteStore(databasePath);
    store.close();

    // Simulate a database that stopped at version 2, before migration 3 existed.
    const raw = new DatabaseSync(databasePath);
    raw.exec("drop index if exists idx_summaries_person_state");
    raw.exec("delete from schema_migrations where version = 3");
    raw.exec("pragma user_version = 2");

    const result = runSchemaMigrations(raw);
    expect(result.from).toBe(2);
    expect(result.to).toBe(latestVersion);

    const userVersionRow = raw.prepare("pragma user_version").get() as { user_version: number };
    expect(userVersionRow.user_version).toBe(latestVersion);

    const indexRow = raw
      .prepare("select name from sqlite_master where type = 'index' and name = 'idx_summaries_person_state'")
      .get();
    expect(indexRow).toBeDefined();

    raw.close();
  });

  it("is idempotent when run again against an already-migrated database", () => {
    // Base tables (including `summaries`, which migration 3's index targets) are created by
    // SqliteStore.migrate()'s base DDL block before runSchemaMigrations ever runs in production;
    // open through SqliteStore once to establish that precondition, matching real usage.
    const store = new SqliteStore(databasePath);
    store.close();

    const raw = new DatabaseSync(databasePath);
    const result = runSchemaMigrations(raw);
    expect(result.to).toBe(latestVersion);

    const second = runSchemaMigrations(raw);
    expect(second.from).toBe(latestVersion);
    expect(second.to).toBe(latestVersion);

    const rows = raw.prepare("select version from schema_migrations order by version asc").all() as Array<{
      version: number;
    }>;
    expect(rows.map((row) => row.version)).toEqual(MIGRATIONS.map((migration) => migration.version));

    raw.close();
  });
});
