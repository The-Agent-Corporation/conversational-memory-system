---
phase: 07-onboarding-and-operational-readiness
plan: 06
subsystem: storage
tags: [libsodium, argon2id, xchacha20poly1305, sqlite, backup, cli, adr-0047]

# Dependency graph
requires:
  - phase: 07-01
    provides: main(argv) export refactor + command-registry.ts dispatcher shape
  - phase: 07-04
    provides: SqliteStore.getSchemaVersion() and schema-migrations.ts MIGRATIONS list
  - phase: 07-05
    provides: health/status surface conventions (readOnly store open pattern reuse)
provides:
  - Encrypted-by-default backup (memory backup) under an independent cms.backup.v1 crypto domain
  - Safe-by-construction restore (memory restore) that never writes a live --db in place
  - Explicit plaintext export escape hatch (memory export --plaintext), never the default
  - Generic schema-versioned newline-delimited-JSON logical dump format shared by backup and export
affects: [future-phases-touching-storage, future-phases-touching-cli-dispatch]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Domain-separated passphrase crypto: a new subsystem composes only low-level CryptoProvider primitives (randomBytes/aeadSeal/aeadOpen/canonicalBytes/zero) plus its own Argon2id derivation and AAD domain label, rather than reusing another subsystem's higher-level wrap/unwrap helper, even when the underlying algorithm choice is identical (ADR 0047)."
    - "Generic logical dump/restore: enumerate application tables via sqlite_master + pragma table_info instead of hand-listing every table, so the dump format tracks schema changes automatically."
    - "Atomic file write: write to <path>.tmp in the same directory, fsync via FileHandle.sync(), then rename() to the final path — never write the destination filename directly."
    - "Destructive-confirmation flag pattern: require the caller to repeat the exact target path via a --confirm-* flag before an operation can touch something that already exists (mirrors source-delete-command.ts)."

key-files:
  created:
    - src/storage/backup/backup-crypto.ts
    - src/storage/backup/backup-command.ts
    - src/storage/backup/restore-command.ts
    - src/storage/backup/export-plaintext-command.ts
    - tests/storage/backup/backup-restore.test.ts
    - tests/storage/backup/export-plaintext.test.ts
  modified:
    - src/cli/command-registry.ts

key-decisions:
  - "Backup crypto derives its own Argon2id key via sodium.crypto_pwhash directly (CryptoProvider exposes no generic Argon2id KDF) rather than adding a new CryptoProvider method — keeps the sync-domain interface untouched and the backup-specific derivation visibly local to backup-crypto.ts."
  - "Logical dump is newline-delimited JSON (one header line + one row line per table row), built generically from sqlite_master/pragma table_info rather than a hand-maintained per-table list, so it tracks schema changes without further backup-code edits."
  - "Restore fully replaces (deletes + recreates) an existing --out target once --confirm-overwrite is supplied, rather than merging rows into whatever the file already contained, to avoid silent duplicate-row or stale-data hazards."
  - "export-plaintext-command.ts reuses backup-command.ts's buildLogicalDump (exported) rather than duplicating the table-enumeration logic, so backup and plaintext export can never structurally drift apart."

requirements-completed: [REQ-040]

# Metrics
duration: 55min
completed: 2026-07-20
---

# Phase 7 Plan 6: Encrypted Backup, Safe Restore, Plaintext Export Summary

**Encrypted-by-default `memory backup`/`memory restore` under an independent `cms.backup.v1` Argon2id+XChaCha20-Poly1305 domain, plus a clearly-separated `memory export --plaintext` escape hatch — deterministic, local-only (REQ-040), with atomic writes and safe-by-construction restore.**

## Performance

- **Duration:** 55 min
- **Started:** 2026-07-20T16:24:00Z
- **Completed:** 2026-07-20T16:35:00Z
- **Tasks:** 3
- **Files modified:** 7 (4 created source, 2 created test, 1 modified)

## Accomplishments
- `sealBackup`/`openBackup` (backup-crypto.ts) implement a backup-specific Argon2id + XChaCha20-Poly1305-IETF envelope under the `cms.backup.v1/passphrase-package` AAD domain, built only from `CryptoProvider` primitives — verified by both a source-grep test and a cross-domain non-interoperability test (a sync passphrase package cannot open as a backup envelope and vice versa).
- `memory backup` opens the live database read-only (no side effects, `migrate()` never runs), builds a schema-versioned logical dump, seals it, and writes atomically (temp file + fsync + rename) so a killed process can never leave a truncated backup mistaken for a real one.
- `memory restore` never opens an existing `--db` in place: it always creates a brand-new `SqliteStore` at `--out`, refuses a backup whose embedded schema version exceeds this build's latest known migration before touching any file, and requires an explicit `--confirm-overwrite <exact-path>` before replacing an already-existing `--out` target.
- `memory export --plaintext` reuses the identical read-only dump path but skips encryption, requires the literal `--plaintext` flag (rejected otherwise), and prints an explicit stderr risk warning before writing a distinctly-named (`.plaintext.json`-style) file.
- All three subcommands registered in `src/cli/command-registry.ts`.

## Task Commits

Each task was committed atomically:

1. **Task 1: Wave 0 — failing backup/restore + plaintext-export tests** - `2d23cd3` (test)
2. **Task 2: backup-crypto (cms.backup.v1) + encrypted backup command** - `4b6dff5` (feat)
3. **Task 3: restore command + plaintext export escape hatch** - `cbd796a` (feat)

**Plan metadata:** (this commit, docs)

## Files Created/Modified
- `src/storage/backup/backup-crypto.ts` - `sealBackup`/`openBackup`: Argon2id (ARGON2ID_REVIEWED_FLOOR, verbatim) + XChaCha20-Poly1305-IETF AEAD under `cms.backup.v1/passphrase-package`; uniform `BackupIntegrityError` on any decrypt-time failure, floor-rejection before derivation.
- `src/storage/backup/backup-command.ts` - `runBackupCommand`/`main`; generic `buildLogicalDump`/`readLogicalDumpHeader`/`applyLogicalDump` (exported, shared with restore + export); atomic temp+fsync+rename write.
- `src/storage/backup/restore-command.ts` - `runRestoreCommand`/`main`; schema-version-newer refusal, existing-path confirmation gate, full-replace-on-confirm semantics.
- `src/storage/backup/export-plaintext-command.ts` - `runExportPlaintextCommand`/`main`; explicit `--plaintext` requirement, stderr warning, plaintext JSON output via the shared dump builder.
- `src/cli/command-registry.ts` - added `backup`, `restore`, `export` entries.
- `tests/storage/backup/backup-restore.test.ts` - round-trip, uniform wrong-passphrase/tamper failure, cross-domain non-interoperability, no-sync-wrapper-import source assertion, atomic-write discipline.
- `tests/storage/backup/export-plaintext.test.ts` - plaintext inspectability, distinct filename, stderr warning, required-flag enforcement, backup/export dump-shape parity.

## Decisions Made
See `key-decisions` in frontmatter.

## Deviations from Plan

None - plan executed exactly as written. The generic logical-dump table enumeration (via `sqlite_master`/`pragma table_info` rather than a hand-maintained table list) was an implementation-detail choice within Task 2's stated scope ("a schema-versioned logical dump...across tables"), not a deviation from any stated interface or acceptance criterion.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required. Backup/restore/export are fully local and deterministic (REQ-040).

## Next Phase Readiness
- `memory backup`/`memory restore`/`memory export --plaintext` are complete, tested, and registered in the CLI dispatcher.
- `npm run typecheck` clean; full `npm test` suite green (88 files, 716 tests, including the 9 new backup/export tests).
- `grep -r "wrapWithPassphrase\|unwrapWithPassphrase" src/storage/backup/` returns nothing — domain separation from ADR 0047 confirmed by both grep and a runtime cross-domain test.
- This is the final plan of Phase 7 wave 5; no further plans are queued in this phase.

---
*Phase: 07-onboarding-and-operational-readiness*
*Completed: 2026-07-20*

## Self-Check: PASSED

All created files verified present on disk; all four task/summary commit hashes (`2d23cd3`, `4b6dff5`, `cbd796a`, `e2670ac`) verified present in git log.
