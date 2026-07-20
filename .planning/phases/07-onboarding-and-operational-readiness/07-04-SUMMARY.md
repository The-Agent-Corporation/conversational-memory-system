---
phase: 07-onboarding-and-operational-readiness
plan: 04
subsystem: database
tags: [sqlite, node:sqlite, schema-migrations, pragma-user-version]

# Dependency graph
requires:
  - phase: 07-onboarding-and-operational-readiness
    provides: "07-01 unified memory CLI dispatcher (bin/memory main(argv) export pattern)"
provides:
  - "src/storage/schema-migrations.ts: SchemaMigration interface, ordered MIGRATIONS list, runSchemaMigrations() runner"
  - "SqliteStore.getSchemaVersion() and SqliteStore.dbFileSizeBytes() helpers"
  - "Versioned, transactional, concurrency-safe schema migration foundation for all future schema changes"
affects: [07-05-health-status-surface, 07-06-backup-and-restore]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Versioned schema migrations coexist with the existing create-table-if-not-exists base block; new migrations append to MIGRATIONS with a strictly increasing version"
    - "Each migration apply() + its schema_migrations audit row run inside one begin immediate/commit/rollback transaction, matching the existing migrateDaemonContractionPayloads convention"
    - "pragma user_version mirrors the highest applied schema_migrations version for cheap inspection"

key-files:
  created:
    - src/storage/schema-migrations.ts
    - tests/storage/schema-migrations.test.ts
    - tests/storage/schema-migrations-concurrency.test.ts
  modified:
    - src/storage/sqlite-store.ts

key-decisions:
  - "Kept migrateDaemonContractionPayloads() as its own private method (not converted into a MIGRATIONS version 2 entry) to minimize risk to the existing daemon-contraction-payload normalization path; runSchemaMigrations() is appended after it, unaffected by that decision, and future migrations can still be added as MIGRATIONS entries going forward"
  - "runSchemaMigrations() accepts an optional migrations list parameter (defaulting to MIGRATIONS) purely as a test seam so the throwing-migration and concurrency tests can inject fixture migrations without mutating the exported readonly list"
  - "dbFileSizeBytes() sums the primary db file plus -wal/-shm sidecars when present (ENOENT tolerated, other errors rethrown), per 07-RESEARCH.md guidance"

patterns-established:
  - "runSchemaMigrations(database, migrations = MIGRATIONS): { from, to } — call at the end of SqliteStore.migrate(), after the untouched base block"

requirements-completed: [REQ-040]

# Metrics
duration: 25min
completed: 2026-07-20
---

# Phase 07 Plan 04: Versioned SQLite Schema Migration Summary

**Added a `pragma user_version` + `schema_migrations`-table-backed migration runner (`runSchemaMigrations`) that runs after the existing `create table if not exists` base block, plus `SqliteStore.getSchemaVersion()`/`dbFileSizeBytes()` inspection helpers for the upcoming health and backup plans.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-07-20T19:35:00Z (approx)
- **Completed:** 2026-07-20T19:59:50Z
- **Tasks:** 2
- **Files modified:** 4 (1 new source file, 1 modified source file, 2 new test files)

## Accomplishments
- `src/storage/schema-migrations.ts`: `SchemaMigration` interface, ordered `MIGRATIONS` list (baseline version 1 no-op — the existing base block), and `runSchemaMigrations(database, migrations?)` that creates `schema_migrations` if absent, applies every pending migration inside its own `begin immediate`/`commit`/`rollback` transaction, and keeps `pragma user_version` synced to the latest applied version.
- `SqliteStore.migrate()` now calls `runSchemaMigrations(this.database)` at the end, after the untouched base `create table if not exists` block (still 29 statements, byte-identical before/after).
- `SqliteStore.getSchemaVersion()` reads `pragma user_version`; `SqliteStore.dbFileSizeBytes()` sums the db file and any `-wal`/`-shm` sidecars.
- RED→GREEN test coverage: fresh-DB convergence to latest version, pre-versioning-DB forward migration with data preservation, transactional rollback of both data and `schema_migrations` on a throwing migration, idempotent re-run, and two concurrency scenarios (sequential re-open with no double-apply; a losing writer under lock contention failing atomically instead of partially applying).

## Task Commits

Each task was committed atomically:

1. **Task 1: Wave 0 — failing migration + concurrency tests** - `fe24abb` (test)
2. **Task 2: Implement schema-migrations runner and wire into SqliteStore** - `bc9388f` (feat)

**Plan metadata:** (this commit, see below)

## Files Created/Modified
- `src/storage/schema-migrations.ts` - `SchemaMigration` interface, `MIGRATIONS` list, `runSchemaMigrations()` runner
- `src/storage/sqlite-store.ts` - wired `runSchemaMigrations()` into `migrate()`; added `location` field, `getSchemaVersion()`, `dbFileSizeBytes()`
- `tests/storage/schema-migrations.test.ts` - fresh-DB, pre-versioning-forward-migration, transactional-rollback, idempotent-rerun tests
- `tests/storage/schema-migrations-concurrency.test.ts` - sequential double-open and lock-contention concurrency tests

## Decisions Made
- Did not convert `migrateDaemonContractionPayloads()` into a `MIGRATIONS` version-2 entry (the plan flagged this as "recommended," not required). Converting it would require threading `reconstructProcessedThroughOrderKey`'s `this.database`-scoped query logic through the migration's `apply(database)` signature, and the existing method is already correctly transactional and idempotent (it only updates rows whose normalized payload differs from the stored one). Deferred to a future plan if/when it becomes a maintenance concern; `runSchemaMigrations()` is unaffected and future schema changes should use `MIGRATIONS` going forward.
- Added a `migrations` parameter to `runSchemaMigrations()` (default `MIGRATIONS`) purely as a test seam, per the plan's own suggestion ("injected via a test seam or a fixture migration list").

## Deviations from Plan

None - plan executed exactly as written (the `migrateDaemonContractionPayloads` conversion was explicitly optional/"recommended", see Decisions Made above).

## Issues Encountered
- An early version of the concurrency test asserted the losing writer had already created the `schema_migrations` table before failing; in practice `create table if not exists schema_migrations` itself blocks under the other writer's `begin immediate` lock (SQLite locks at the file/connection level, not per-statement), so that assertion was corrected to only assert the losing writer's whole call throws, matching the actual transactional-serialization guarantee (Threat T-07-08).
- `npm test` full suite has 2 pre-existing failures in `tests/mcp/stdio-server.test.ts` (05-08) unrelated to this plan: `node_modules/tsx/dist/cli.mjs` is missing from this worktree's `node_modules` (the `tsx` package itself, not just its bin symlink). This is out of scope for 07-04 (files_modified doesn't include MCP/stdio-server code) and is a worktree environment gap, not a code defect introduced here. Logged for orchestrator visibility; not auto-fixed per the scope-boundary rule (pre-existing failure in an unrelated file).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- `runSchemaMigrations`, `getSchemaVersion()`, and `dbFileSizeBytes()` are ready for 07-05 (health/status surface) and 07-06 (backup/restore) to consume directly.
- Future schema changes across the codebase should be added as new `MIGRATIONS` entries (strictly increasing `version`, never mutating an earlier entry) rather than hand-spliced into the base block.
- Known gap: the worktree's `node_modules` is missing the `tsx` package, causing 2 pre-existing failures in `tests/mcp/stdio-server.test.ts` unrelated to this plan's files. The orchestrator/next wave should verify `npm install` resolves this before treating that suite as a regression signal.

---
*Phase: 07-onboarding-and-operational-readiness*
*Completed: 2026-07-20*

## Self-Check: PASSED

All created files verified present on disk; both task commit hashes (`fe24abb`, `bc9388f`) verified present in git log.
