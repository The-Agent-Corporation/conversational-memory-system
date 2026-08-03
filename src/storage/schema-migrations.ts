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
  },
  {
    version: 2,
    description: "REQ-041: add summary_vectors table for local vector-native summary embeddings",
    apply: (database) => {
      database.exec(`
        create table if not exists summary_vectors (
          summary_id text not null,
          provider text not null,
          model text not null,
          dimensions integer not null,
          vector blob not null,
          person_id text not null,
          scope_ids_json text not null,
          created_at text not null,
          primary key (summary_id, provider, model)
        );

        create index if not exists idx_summary_vectors_provider_model_person
          on summary_vectors (provider, model, person_id, summary_id);
      `);
    }
  },
  {
    version: 3,
    description: "GAP-11-A: index summaries by person and state for filtered retrieval",
    apply: (database) => {
      database.exec(`
        create index if not exists idx_summaries_person_state
          on summaries (json_extract(payload,'$.personId'), json_extract(payload,'$.state'), id);
      `);
    }
  },
  {
    version: 4,
    description: "REQ-043: covering index for the state-predicated missing-vector query",
    apply: (database) => {
      // GAP-12-B (T-12-09a). `listSummaryIdsMissingVector` gained a state predicate so a
      // superseded row is no longer a backfill candidate. Without this index that predicate
      // degrades an id-only covering scan into one that reads `payload` for every summary row
      // (measured on the 5.0 GB live corpus: 329 ms -> 4,090 ms). This index restores covering
      // behavior at 45 ms -- 7x faster than the unfiltered query in production today. It leads on
      // state, unlike v3's idx_summaries_person_state, because the missing-vector query takes no
      // personId and therefore cannot use a personId-leading index. Build cost on the full live
      // corpus is 1.16 s.
      database.exec(`
        create index if not exists idx_summaries_state_id
          on summaries (json_extract(payload,'$.state'), id);
      `);
    }
  },
  {
    version: 5,
    description: "REQ-043: index (sourceId, scopeId) so a contraction slice need not read every payload",
    apply: (database) => {
      // `ContractionRunner.assertEventScopes` validates that every canonical event's scope still
      // matches its source's. It did that by materializing all 292,407 events and looping in JS,
      // which is a large part of why one slice cost ~22 s on the live corpus while processing 250
      // events -- and why the daemon's 30 s write lease could lapse inside a single slice.
      //
      // The predicate only ever needs the DISTINCT (sourceId, scopeId) pairs, of which the whole
      // live corpus has 18. Expressed as SQL that is a group-by, but without this index it still
      // reads `payload` for every row (measured: 15.18 s). With it the group-by is index-covered:
      // 0.024 s. The invariant is unchanged -- same pairs, same comparison, same failure -- only
      // the cost of obtaining it.
      //
      // Additive DDL, no table rewrite. Build cost on the full 5.0 GB live corpus is 13.49 s, paid
      // once, and `coalesce(...,'personal')` mirrors the runner's own `event.scopeId ?? "personal"`
      // default exactly so the index matches the query the store issues.
      database.exec(`
        create index if not exists idx_canonical_events_person_scope
          on canonical_events (
            person_id,
            json_extract(payload,'$.sourceId'),
            coalesce(json_extract(payload,'$.scopeId'),'personal')
          );
      `);
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
