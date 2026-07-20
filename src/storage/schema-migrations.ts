export interface DatabaseSyncLike {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...anonymousParameters: unknown[]): unknown[];
    get(...anonymousParameters: unknown[]): unknown;
    run(...anonymousParameters: unknown[]): void;
  };
}

export interface SchemaMigration {
  readonly version: number;
  readonly description: string;
  apply(database: DatabaseSyncLike): void;
}

/**
 * Ordered, append-only list of schema migrations. Version 1 is the baseline:
 * every table created by SqliteStore.migrate()'s `create table if not exists`
 * block is considered version 1 and requires no migration work of its own.
 * New migrations must be appended with a strictly increasing `version` and
 * must never mutate or reorder an earlier entry.
 */
export const MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 1,
    description: "baseline: tables created by SqliteStore.migrate() base block are version 1",
    apply: () => {
      /* no-op: base block already ran before runSchemaMigrations is invoked */
    }
  }
];

/**
 * Runs every migration in `migrations` whose version is greater than the
 * highest version already recorded in `schema_migrations`, in ascending
 * order. Each migration's DDL/data change and its `schema_migrations` audit
 * row are applied inside a single `begin immediate` / `commit` transaction so
 * a throwing migration leaves both the data and the schema version exactly as
 * they were (SQLite's own locking also serializes concurrent writers, so a
 * losing writer's whole transaction fails atomically instead of double
 * applying or corrupting `schema_migrations`).
 *
 * `pragma user_version` is kept in sync with the highest applied version so
 * the current schema version is inspectable without joining against
 * `schema_migrations`.
 */
export function runSchemaMigrations(
  database: DatabaseSyncLike,
  migrations: readonly SchemaMigration[] = MIGRATIONS
): { from: number; to: number } {
  database.exec(`create table if not exists schema_migrations (
    version integer primary key,
    description text not null,
    applied_at text not null
  )`);

  const currentRow = database.prepare("select max(version) as v from schema_migrations").get() as {
    v: number | null;
  };
  const current = currentRow.v ?? 0;
  const pending = migrations
    .filter((migration) => migration.version > current)
    .sort((left, right) => left.version - right.version);

  let latestApplied = current;
  for (const migration of pending) {
    database.exec("begin immediate");
    try {
      migration.apply(database);
      database
        .prepare("insert into schema_migrations (version, description, applied_at) values (?, ?, ?)")
        .run(migration.version, migration.description, new Date().toISOString());
      database.exec(`pragma user_version = ${migration.version}`);
      database.exec("commit");
      latestApplied = migration.version;
    } catch (error) {
      database.exec("rollback");
      throw error;
    }
  }

  return { from: current, to: latestApplied };
}
