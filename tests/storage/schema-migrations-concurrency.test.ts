import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../../src/storage/sqlite-store.js";
import { runSchemaMigrations, type SchemaMigration } from "../../src/storage/schema-migrations.js";

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

describe("schema-migrations concurrency", () => {
  let tempDir: string;
  let databasePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "memory-schema-migrations-concurrency-"));
    databasePath = join(tempDir, "memory.db");
  });

  afterEach(async () => {
    await rm(tempDir, { force: true, recursive: true });
  });

  it("does not double-apply or corrupt schema_migrations when two stores open the same file", async () => {
    const first = new SqliteStore(databasePath);
    const firstVersion = first.getSchemaVersion();
    first.close();

    const second = new SqliteStore(databasePath);
    const secondVersion = second.getSchemaVersion();
    second.close();

    expect(secondVersion).toBe(firstVersion);

    const raw = new DatabaseSync(databasePath, { readOnly: true });
    const rows = raw.prepare("select version from schema_migrations order by version asc").all() as Array<{
      version: number;
    }>;
    const versions = rows.map((row) => row.version);
    expect(new Set(versions).size).toBe(versions.length);
    raw.close();
  });

  it("fails the losing writer atomically instead of double-applying or corrupting state when a migration is pending and the file is locked by another writer", () => {
    const pendingMigrations: readonly SchemaMigration[] = [
      { version: 1, description: "baseline", apply: () => {} },
      {
        version: 2,
        description: "pending migration under contention",
        apply: (database) => {
          database.exec("create table if not exists concurrency_marker (id text primary key)");
          database.prepare("insert into concurrency_marker (id) values (?)").run("applied");
        }
      }
    ];

    const holder = new DatabaseSync(databasePath, { timeout: 200 });
    holder.exec("begin immediate");

    const contender = new DatabaseSync(databasePath, { timeout: 200 });
    expect(() => runSchemaMigrations(contender, pendingMigrations)).toThrow();

    // Losing writer must not have recorded a partial migration.
    const duringHoldRows = holder.prepare(
      "select count(*) as c from sqlite_master where type = 'table' and name = 'schema_migrations'"
    ).get() as { c: number };
    expect(duringHoldRows.c).toBe(1);

    holder.exec("commit");
    holder.close();
    contender.close();

    // Once the lock is released, a fresh writer converges to the pending version exactly once.
    const winner = new DatabaseSync(databasePath, { timeout: 2000 });
    const result = runSchemaMigrations(winner, pendingMigrations);
    expect(result.to).toBe(2);

    const versionRows = winner
      .prepare("select version from schema_migrations order by version asc")
      .all() as Array<{ version: number }>;
    expect(versionRows.map((row) => row.version)).toEqual([1, 2]);

    const markerRows = winner.prepare("select count(*) as c from concurrency_marker").get() as { c: number };
    expect(markerRows.c).toBe(1);

    winner.close();
  });
});
