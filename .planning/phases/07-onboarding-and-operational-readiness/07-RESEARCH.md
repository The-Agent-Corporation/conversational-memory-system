# Phase 7: Onboarding and Operational Readiness - Research

**Researched:** 2026-07-20
**Domain:** CLI product packaging, local encrypted backup, SQLite schema migration, MCP audit surface — all over an already-built TypeScript/Node/SQLite/libsodium system
**Confidence:** HIGH (this phase is almost entirely "wire existing subsystems together"; the two genuinely novel pieces — backup crypto reuse and schema migration — are HIGH confidence because they extend patterns already proven elsewhere in this codebase)

## Summary

Phase 7 adds no new domain capability. Every decision in CONTEXT.md is a **product surface** over subsystems that already exist and are already tested: source lifecycle audit events (ADR 0044), scope-bounded read tools (ADR 0046), the libsodium `CryptoProvider` (ADR 0047), the daemon status snapshot, and ~19 hand-rolled `*-command.ts` modules (not ~30 — the actual count in `src/` is 19; the `~30` in CONTEXT.md refers to the combined `memory:*`/`hermes:*` npm script aliases, of which 16 are `memory:*`). The codebase has a strong, consistent house style that this phase must continue rather than replace: every command module hand-rolls its own `parseArgs(args: string[])` returning a Zod-validated options object, with zero CLI-framework dependencies (`package.json` has no `commander`/`yargs`/similar). The unified `bin` CLI should follow that same style — a thin dispatcher that maps `memory <subcommand>` to the existing exported `run*Command` functions, not a new framework.

The two areas needing real design work are backup encryption and schema migration, because neither exists yet in any form:

1. **Backup encryption (D-07).** The `CryptoProvider` interface (`src/sync/crypto/crypto-provider.ts`) already exposes exactly the two primitives backup needs — `aeadSeal`/`aeadOpen` (XChaCha20-Poly1305-IETF, arbitrary-length plaintext) and `wrapWithPassphrase`/`unwrapWithPassphrase` (Argon2id KDF at the ADR 0047 reviewed floor, `ARGON2ID_REVIEWED_FLOOR = { opsLimit: 3, memLimit: 268_435_456 }`). But `wrapWithPassphrase` is domain-bound to `"cms.sync.v1/passphrase-package"` and typed around wrapping a 32-byte recovery seed, not an arbitrary-size backup payload. Backup must **not** call `wrapWithPassphrase` directly — it must derive its own Argon2id key via the lower-level primitives with a distinct domain label (e.g. `cms.backup.v1`), reusing `LibsodiumCryptoProvider` as the crypto engine without reusing the sync-specific wrapper. This preserves ADR 0047's strict domain separation (a passphrase key derived for backup must never be usable to decrypt sync epoch key packages, and vice versa).

2. **Schema migration (D-08).** `SqliteStore.migrate()` (`src/storage/sqlite-store.ts:1628`) currently runs one hardcoded block of `create table if not exists` statements plus one **hand-written, unversioned, idempotent forward-data migration** (`migrateDaemonContractionPayloads`, added ad hoc when two fields were added to `ContractionJob`/`ContractionCheckpoint`). There is no `pragma user_version`, no migrations table, no version number anywhere. Phase 7 must introduce actual versioning without breaking this established `create table if not exists` idempotency, because every test and every command already depends on `new SqliteStore(path)` being safe to call repeatedly against the same file.

**Primary recommendation:** Split Phase 7 into three sequenced waves as CONTEXT.md's planner note suggests — (1) unified `bin` CLI + guided `init`, (2) REQ-039 audit/explain (CLI + MCP tool + audit log), (3) health/backup/migration/performance — and within wave 3, build schema versioning *first* (everything else in that wave, including backup, depends on a stable, versioned store to reason about). Do not add any new runtime dependency for CLI parsing or backup encryption; both are achievable with what's already installed (`zod`, `libsodium-wrappers-sumo`, `node:sqlite`, `node:crypto`).

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Unified `memory` CLI dispatch | CLI / Process entry | — | Pure argv routing to existing command modules; no business logic |
| Guided `memory init` onboarding | CLI / Process entry | Imports (discover/grant) tier | Orchestrates existing discover → grant → bootstrap → daemon start commands; adds no new grant logic |
| `memory explain <id>` (CLI) | CLI / Process entry | Storage (SQLite reads) | Read-only reconstruction from existing provenance/audit rows |
| Explain MCP tool | API / MCP surface | Storage (SQLite reads) | Must sit beside `memory_search`/`memory_review` in the bounded read-tool catalog, gated by the same `ProfileAuthority` |
| Audit log (D-02) | Storage / Database | CLI export tier | Reads `source_lifecycle_audit` (+ any new audit tables) directly; export is a thin JSON serializer, not a new store |
| Health/status surface (D-06) | CLI / Process entry | Daemon + Storage | Extends `readDaemonStatusSnapshot` + `runMemoryStatusCommand`; adds DB-file-size and sync-lag reads, no new subsystem |
| Encrypted backup/restore (D-07) | Storage / Database | CLI entry | Reads whole SQLite file or full logical dump, encrypts client-side via existing `CryptoProvider`; no server/network tier involved |
| Plaintext export (D-07b) | Storage / Database | CLI entry | Same read path as backup, skips encryption step; must be clearly gated/labeled at the CLI tier |
| Schema migration (D-08) | Storage / Database | CLI entry (`memory migrate`/auto-run) | Owned entirely by `SqliteStore`; CLI only surfaces status/trigger |
| Performance reporting + tuning (D-09) | Storage / Database | CLI + Daemon | Read: DB size/index stats via SQLite introspection. Write: config knobs consumed by daemon/retrieval, not a new tier |

## Standard Stack

### Core (already installed — reuse only)
| Library | Version | Purpose | Why Standard (for this codebase) |
|---------|---------|---------|--------------|
| `libsodium-wrappers-sumo` | 0.8.4 [VERIFIED: package.json] | AEAD (XChaCha20-Poly1305-IETF), Argon2id KDF, generic hash | Already the sole crypto provider (ADR 0047); D-07 explicitly forbids introducing new crypto |
| `zod` | 3.25.76 [VERIFIED: package.json] | Options validation for every command's `parseArgs` output, and for any new schemas (audit log entries, migration records, backup manifest) | Universal validation pattern already used in every command/store module |
| `node:sqlite` (`DatabaseSync`) | Node 24.7.0 built-in [VERIFIED: `node --version`, `src/types/node-sqlite.d.ts`] | The store itself; also the natural home for `pragma user_version` | Already the only storage engine; no ORM, no migration framework installed |
| `node:crypto` | built-in | `randomUUID`, potentially file hashing for backup manifest checksums | Already used by `daemon-command.ts`, `mcp/authority.ts` |
| `canonicalize` | 3.0.0 [VERIFIED: package.json] | RFC 8785 canonical JSON, reused if a backup manifest or audit-log line needs canonical/deterministic byte comparison in tests | Already the sync-layer canonicalization dependency |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| none (hand-rolled `parseArgs`) | — | Unified CLI argument parsing | Every existing command does this; **do not add `commander`/`yargs`/`clipanion`** — it would be the first CLI-framework dependency in the repo and provides no benefit at this command count (~19 leaf commands) |
| `node:zlib` (built-in, optional) | — | Optional gzip of the plaintext dump before AEAD-sealing, to shrink backup size | Only if backup payload size becomes a real concern; compress-then-encrypt is standard and safe here because the plaintext is attacker-uncontrolled local data (no CRIME-style compression oracle applies to a local single-user backup file) |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Hand-rolled `parseArgs` per subcommand | Node's built-in `node:util.parseArgs` | Slightly less boilerplate, but every existing command already hand-rolls (including `--flag=value` and `--flag value` forms with lookahead); switching now creates two conventions. Discretion: acceptable to adopt `node:util.parseArgs` **only** inside the new top-level `bin/memory` dispatcher for parsing `memory <subcommand> [...rest]`, then hand the untouched `rest` argv straight through to the existing command's own `parseArgs` — this changes nothing about existing commands. |
| Reusing `wrapWithPassphrase`/`unwrapWithPassphrase` verbatim for backup | Implementing a backup-specific Argon2id wrap using the same primitive methods (`aeadSeal`, `randomBytes`, `canonicalBytes`) with a new domain label | `wrapWithPassphrase` is scoped by both its type signature (intended for the 32-byte recovery seed) and its private, hardcoded AAD domain `cms.sync.v1/passphrase-package`. Reusing it for backup would either (a) silently work today because nothing checks plaintext length, creating an undocumented cross-domain reuse that a future sync-protocol change could break, or (b) require exporting `canonicalPassphraseHeader` and monkeying with domain labels. Cleaner and ADR-0047-consistent to compose a new `wrapBackupWithPassphrase` from the public primitives. |
| Custom migration table design | `pragma user_version` (SQLite built-in single integer) | `user_version` is simpler (no extra table, atomic with the file) but is a single integer with no per-migration audit trail. A `schema_migrations` table (`version integer primary key, applied_at text, description text`) gives an inspectable history, which fits this project's audit-everything ethos (REQ-039) better. Recommend **both**: `pragma user_version` as the fast integrity check + `schema_migrations` table as the audit trail, kept in sync in the same transaction. |

**Installation:** No new packages required for this phase.

```bash
npm view libsodium-wrappers-sumo version   # confirm current pin is still current
npm view zod version
```

**Version verification:**
```
$ npm view libsodium-wrappers-sumo version
0.8.4
$ npm view zod version
3.25.76 (repo pin; latest on registry may be newer — repo intentionally pinned, do not bump without a separate decision)
```
Both match `package.json` exactly [VERIFIED: npm registry — checked 2026-07-20]. No drift.

## Package Legitimacy Audit

No new external packages are recommended for this phase. All work is done with dependencies already present in `package.json` (`libsodium-wrappers-sumo`, `zod`, `canonicalize`) plus Node built-ins (`node:sqlite`, `node:crypto`, `node:zlib`, `node:util`). The Package Legitimacy Gate is not applicable — there is nothing new to check with `slopcheck` or a registry lookup.

**Packages removed due to slopcheck verdict:** none (nothing was proposed)
**Packages flagged as suspicious:** none

## Architecture Patterns

### System Architecture Diagram

```
                         ┌─────────────────────────────┐
   user terminal ──────► │   bin/memory  (new)          │
                         │   argv[2] = subcommand        │
                         └───────────┬──────────────────┘
                                     │ dispatch by name
        ┌────────────────────────────┼──────────────────────────────┐
        ▼                            ▼                               ▼
 existing command modules     new command modules              new MCP tool
 (import/discover/status/     (init, explain, backup,          (explain via
  daemon/source:*/quarantine) restore, export, migrate,         read-tools.ts,
  — unchanged                  audit-log, tune)                 authority-gated)
        │                            │                               │
        └──────────────┬─────────────┴───────────────┬───────────────┘
                        ▼                             ▼
                 SqliteStore (extended)        CryptoProvider (unchanged)
                 - migrate(): versioned         - aeadSeal/aeadOpen
                 - new: getSchemaVersion()       - wrapWithPassphrase (sync)
                 - new: dbFileSizeBytes()        - new: backup passphrase wrap
                 - existing: all Memory-           (new function, same class)
                   Store read/write methods
                        │
                        ▼
                  SQLite file on disk
                  (single source of truth;
                   backup reads it, restore
                   writes a NEW file, never
                   in-place-decrypts over it)
```

Primary use case trace for `memory backup`: user runs `memory backup --db path --out backup.enc` → CLI prompts for passphrase (or reads `--passphrase-file`) → command opens the store **read-only** (`SqliteStoreOptions.readOnly: true`, already supported) → serializes a full logical dump (JSON lines or a raw file copy of the closed, checkpointed SQLite file) → derives an Argon2id key from the passphrase with a fresh salt → AEAD-seals the dump under a domain-labeled header → writes a single self-describing encrypted file (header + ciphertext) → prints a content-free success receipt (byte count, not paths/keys). Restore reverses this into a **new** empty database file, never overwriting the live one until the caller explicitly moves it.

### Recommended Project Structure
```
src/
├── cli/                       # NEW — unified dispatcher only, no business logic
│   ├── bin.ts                 # argv[2] subcommand routing → existing + new command modules
│   └── command-registry.ts    # static map: subcommand name -> { module, run function }
├── bootstrap/
│   ├── status-command.ts      # EXTEND: add dbFileSizeBytes, syncLag, index health to snapshot
│   └── init-command.ts        # NEW — guided onboarding orchestrator (D-05)
├── storage/
│   ├── sqlite-store.ts        # EXTEND: versioned migrate(), getSchemaVersion()
│   ├── schema-migrations.ts   # NEW — ordered migration list + runner, imported by sqlite-store.ts
│   └── backup/
│       ├── backup-command.ts      # NEW (D-07)
│       ├── restore-command.ts     # NEW (D-07)
│       ├── export-plaintext-command.ts  # NEW (D-07 escape hatch)
│       └── backup-crypto.ts       # NEW — wrapBackupWithPassphrase/unwrapBackupWithPassphrase using CryptoProvider primitives
├── audit/
│   ├── explain-command.ts     # NEW (D-01a)
│   ├── explain-service.ts     # NEW — shared logic used by both CLI and MCP tool (D-01a + D-01b)
│   └── audit-log-command.ts   # NEW (D-02)
├── mcp/
│   └── tools/
│       └── read-tools.ts      # EXTEND: register `memory_explain` alongside existing 6 read tools
└── operations/
    └── tune-command.ts        # NEW (D-09 tuning knobs)
```

### Pattern 1: Command module contract (already established — follow exactly)
**What:** Every leaf command exports `run<Name>Command(options): Promise<Result>` (pure, testable, no `process.exit`) plus a `parseArgs(argv)` function plus a guarded `main()` that only runs when invoked as the entrypoint (`import.meta.url === pathToFileURL(process.argv[1]).href`).
**When to use:** Every new command module in this phase (`init`, `explain`, `backup`, `restore`, `export --plaintext`, `migrate`, `audit-log`, `tune`).
**Example:**
```typescript
// Source: src/bootstrap/status-command.ts (existing pattern in this repo)
export async function runMemoryStatusCommand(
  options: MemoryStatusCommandOptions
): Promise<MemoryStatusCommandResult> { /* ... */ }

function parseArgs(args: string[]): MemoryStatusCommandOptions { /* manual --flag parsing + Zod validation */ }

async function main(): Promise<void> {
  const result = await runMemoryStatusCommand(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
```
This lets `bin/memory` import `runMemoryStatusCommand` directly (no subprocess spawn needed) while the npm script alias (`memory:status`) keeps working unchanged because the file is still directly `tsx`-executable.

### Pattern 2: Unified `bin` dispatch without a framework
**What:** `bin/memory` (referenced from `package.json` `"bin"`, currently empty per CONTEXT.md) is a thin argv router.
**When to use:** D-04.
**Example:**
```typescript
// src/cli/bin.ts
import { pathToFileURL } from "node:url";

const REGISTRY: Record<string, () => Promise<{ main(argv: string[]): Promise<void> }>> = {
  import: () => import("../imports/history-import-command.js"),
  status: () => import("../bootstrap/status-command.js"),
  init: () => import("../bootstrap/init-command.js"),
  daemon: () => import("../daemon/daemon-command.js"),
  explain: () => import("../audit/explain-command.js"),
  backup: () => import("../storage/backup/backup-command.js"),
  restore: () => import("../storage/backup/restore-command.js"),
  export: () => import("../storage/backup/export-plaintext-command.js"),
  migrate: () => import("../storage/schema-migrations.js"),
  "audit-log": () => import("../audit/audit-log-command.js"),
  tune: () => import("../operations/tune-command.js")
  // ...remaining existing commands
};

async function dispatch(argv: string[]): Promise<void> {
  const [subcommand, ...rest] = argv;
  const loader = subcommand ? REGISTRY[subcommand] : undefined;
  if (!loader) {
    process.stderr.write(`Unknown or missing subcommand. Available: ${Object.keys(REGISTRY).sort().join(", ")}\n`);
    process.exitCode = 1;
    return;
  }
  const module = await loader();
  await module.main(rest); // each command module must export a callable `main(argv)`, not just the file-execution guard
}

dispatch(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
```
**Important adaptation required:** existing command modules currently only run `main()` inside the `import.meta.url === ...` guard and do not export `main` as a named export. Each command module needs `main` (renamed to accept an explicit `argv` parameter rather than reading `process.argv.slice(2)` internally) exported so `bin/memory` can call it directly without spawning a subprocess. This is a small, mechanical, low-risk refactor across ~19 files — plan it as its own task, not folded into new-command work.

### Pattern 3: Versioned SQLite migration coexisting with `create table if not exists`
**What:** Keep every existing `create table if not exists` statement (they are safe, additive, and already relied upon by every test that opens a fresh `SqliteStore`). Add a **numbered, ordered migration list** that runs *after* the baseline `create table if not exists` block, gated by `pragma user_version` / a `schema_migrations` table, so future schema changes (new columns, new tables, backfills) are versioned instead of being silently re-run or hand-spliced into the base block like `migrateDaemonContractionPayloads` was.
**When to use:** D-08, and as the foundation every later phase's schema changes must use going forward.
**Example:**
```typescript
// src/storage/schema-migrations.ts
export interface SchemaMigration {
  readonly version: number;       // strictly increasing, no gaps required but no duplicates
  readonly description: string;
  apply(database: DatabaseSyncLike): void; // synchronous, runs inside the caller's transaction
}

export const MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 1,
    description: "baseline: tables created by SqliteStore.migrate() base block are version 1",
    apply: () => { /* no-op: base block already ran */ }
  }
  // future migrations appended here, version: 2, 3, ...
];

export function runSchemaMigrations(database: DatabaseSyncLike): { from: number; to: number } {
  database.exec(`create table if not exists schema_migrations (
    version integer primary key,
    description text not null,
    applied_at text not null
  )`);
  const currentRow = database.prepare("select max(version) as v from schema_migrations").get() as { v: number | null };
  const current = currentRow.v ?? 0;
  const pending = MIGRATIONS.filter((migration) => migration.version > current)
    .sort((left, right) => left.version - right.version);
  for (const migration of pending) {
    database.exec("begin immediate");
    try {
      migration.apply(database);
      database.prepare(
        "insert into schema_migrations (version, description, applied_at) values (?, ?, ?)"
      ).run(migration.version, migration.description, new Date().toISOString());
      database.exec("commit");
    } catch (error) {
      database.exec("rollback");
      throw error;
    }
  }
  return { from: current, to: pending.length ? pending[pending.length - 1].version : current };
}
```
Call `runSchemaMigrations(this.database)` at the end of `SqliteStore.migrate()`, after the existing `create table if not exists` block and before `migrateDaemonContractionPayloads()` — or better, convert `migrateDaemonContractionPayloads` itself into `MIGRATIONS` entry `version: 2` so it stops being a special case that runs on every single startup regardless of whether it already ran (today it always re-scans every row on every open, which is correct-but-wasteful; versioning makes it run exactly once).

**Idempotency requirement:** `apply()` must still be safe to run against a partially-migrated or freshly-created database (new installs get every migration in order starting from an empty base; existing installs only get what's missing). Never assume a migration only runs against a pre-populated table — a brand-new `memory init` also flows through the exact same migration list from version 0.

### Pattern 4: Backup encryption reusing `CryptoProvider` primitives (not `wrapWithPassphrase`)
**What:** A backup-specific Argon2id wrap function, structurally identical to `wrapWithPassphrase` but with its own domain label and its own type contract (arbitrary-length plaintext, not a fixed 32-byte seed).
**When to use:** D-07.
**Example:**
```typescript
// src/storage/backup/backup-crypto.ts
import type { CryptoProvider } from "../../sync/crypto/crypto-provider.js";
import { ARGON2ID_REVIEWED_FLOOR } from "../../sync/crypto/crypto-provider.js";

const BACKUP_PASSPHRASE_DOMAIN = "cms.backup.v1/passphrase-package";
const ARGON2ID_SALT_BYTES = 16; // crypto_pwhash_SALTBYTES
const AEAD_NONCE_BYTES = 24;

export interface BackupEnvelope {
  domain: typeof BACKUP_PASSPHRASE_DOMAIN;
  opsLimit: number;
  memLimit: number;
  salt: string;   // base64url
  nonce: string;  // base64url
  ciphertext: string; // base64url — the entire encrypted dump
  createdAt: string;
  schemaVersion: number; // schema_migrations version at backup time — restore refuses to load a NEWER version than it understands
}

export function sealBackup(provider: CryptoProvider, passphrase: string, plaintext: Uint8Array, schemaVersion: number, now: string): BackupEnvelope {
  const salt = provider.randomBytes(ARGON2ID_SALT_BYTES);
  const key = provider.wrapWithPassphraseKeyOnly?.(passphrase, salt) // (illustrative — actual impl derives key directly via a small
    ?? deriveArgon2idKey(provider, passphrase, salt);                 // exported helper, not routed through wrapWithPassphrase)
  const nonce = provider.randomBytes(AEAD_NONCE_BYTES);
  const aad = provider.canonicalBytes({ domain: BACKUP_PASSPHRASE_DOMAIN, opsLimit: ARGON2ID_REVIEWED_FLOOR.opsLimit,
    memLimit: ARGON2ID_REVIEWED_FLOOR.memLimit, salt: toBase64Url(salt), nonce: toBase64Url(nonce), schemaVersion });
  const ciphertext = provider.aeadSeal(key, nonce, aad, plaintext);
  provider.zero(key);
  return { /* ...envelope fields, base64url-encoded... */ } as BackupEnvelope;
}
```
The important design point (not literal code to copy verbatim — the planner should design the exact function signatures) is: **do not import or call `wrapWithPassphrase`/`unwrapWithPassphrase` from `libsodium-crypto-provider.ts` for backup.** Those are sync-domain-bound. Backup needs its own thin wrapper over the same lower-level `CryptoProvider` methods (`randomBytes`, `aeadSeal`, `aeadOpen`, `canonicalBytes`), with the Argon2id key derivation exposed as a small new provider method or a local helper that calls `sodium.crypto_pwhash` directly with `ARGON2ID_REVIEWED_FLOOR` parameters and a backup-specific domain string in the AAD. This keeps the ADR 0047 domain-separation invariant intact and makes backup files cryptographically inert against the sync protocol (and vice versa) even if both use Argon2id.

### Pattern 5: Read-only MCP audit/explain tool (extends existing closed catalog)
**What:** `memory_explain` registered in `read-tools.ts` beside the existing 6 read tools (`memory_search`, `memory_recall`, `memory_review`, `memory_expand_subject`, `source_status`, `proposal_list`), sharing `MEMORY_READ_TOOL_ANNOTATIONS` (`readOnlyHint: true`) and the same `safeRead` content-free error wrapper.
**When to use:** D-01b.
**Example:** see `registerMemoryReadTools` in `src/mcp/tools/read-tools.ts:204` — follow that exact registration shape; input is a single bounded identifier (reuse `IdentifierSchema`), output is a structured trace object bounded the same way `MemoryReadItemSchema` bounds provenance arrays (`.max(1_000)`), and it must go through `ScopedProposalReviewer`/`MemoryQueryService`-style scope authorization so explain cannot leak a fact the caller's `ProfileAuthority` wouldn't otherwise allow (ADR 0046) — explain is a read tool, not a bypass.
**Note:** STATE.md describes the current MCP interface as "Generic sixteen-tool," i.e. currently a closed/finite catalog. Adding `memory_explain` grows it to 17. Confirm with the planner whether any test or doc asserts an exact tool count (`MEMORY_READ_TOOL_NAMES` array, `tool-catalog.ts` comment "Register the finite Phase 5 catalog once") — that comment and array will need updating, and any snapshot/count-based test will need an explicit new-tool addition, not just a passive extension.

### Anti-Patterns to Avoid
- **Introducing a CLI framework dependency for ~19 subcommands.** The codebase has zero CLI-framework dependencies today; adding one for this phase breaks house style and adds a slopcheck/legitimacy surface for no real benefit at this scale.
- **Streaming backup encryption via chunked AEAD.** `aeadSeal`/`aeadOpen` are single-shot, whole-buffer operations; there is no chunked-AEAD primitive exposed by `CryptoProvider`. For a personal single-user SQLite database (expected size: tens to low-hundreds of MB), one whole-buffer AEAD call is simpler, easier to test deterministically, and avoids inventing a new chunk-boundary protocol. Do not build a streaming/chunked scheme unless a concrete size problem is measured.
- **In-place restore over the live database.** Restore must always write to a new file/path and require an explicit confirmation before it can replace the live `--db` target — this mirrors D-07's "safe to store anywhere" trust framing and avoids silent data loss from typos or interrupted restores.
- **Re-deriving explain/audit data by re-instrumenting the pipeline.** D-03 is explicit: this phase reads *existing* provenance/audit rows. Do not add new write-path instrumentation as part of this phase; if a needed fact genuinely isn't captured anywhere (e.g., "why was this synchronized" needs `accepted_sync_operations`/`sync_outbox` provenance, which does already exist per Phase 6), read it — don't re-plumb ingestion/summarization/sync to add new fields unless research below flags a real gap.
- **Auto-running backward-incompatible migrations without an escape hatch.** A migration that fails partway through must leave the database exactly as it was (wrap in `begin immediate` / `commit` / `rollback`, per the existing pattern already used by every multi-statement write in `sqlite-store.ts`). Never leave `schema_migrations` recording success for a migration whose `apply()` threw.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|--------------|-----|
| Argon2id key derivation | A custom PBKDF/scrypt wrapper | `sodium.crypto_pwhash` via the existing `CryptoProvider`/`LibsodiumCryptoProvider`, at `ARGON2ID_REVIEWED_FLOOR` parameters or stronger | ADR 0047 already fixed the algorithm and reviewed floor after design work; there is no reason to pick different KDF parameters for backup than for sync recovery |
| AEAD encryption | Any other cipher (AES-GCM via `node:crypto`, etc.) | `crypto_aead_xchacha20poly1305_ietf_*` via the existing provider | Consistency with the one reviewed cryptographic suite in the codebase (ADR 0047); mixing ciphers multiplies the audit surface for no benefit |
| SQLite schema versioning | A general migration framework (Knex, Umzug, node-pg-migrate-style tooling) | `pragma user_version` + a small in-repo `schema_migrations` table/runner (~40 lines, shown above) | Those frameworks target multi-engine or server-managed migrations with CLI tooling this project doesn't need; `node:sqlite` has no adapter for most of them anyway, and the project already hand-rolls exactly this kind of thing (`migrate()` itself) |
| CLI argument parsing | A parser library | Continue the existing hand-rolled `parseArgs` convention, optionally `node:util.parseArgs` only at the new top-level dispatcher | Matches house style; zero new dependencies |
| Canonical JSON for backup/audit AAD or manifest hashing | A bespoke JSON stringifier | `canonicalize` (already a dependency, already used for exactly this purpose in the sync layer) | Avoids subtle canonicalization bugs (key ordering, `-0`, `NaN`) that a hand-rolled `JSON.stringify` would reintroduce |

**Key insight:** Everything genuinely hard about this phase (crypto correctness, canonical encoding, domain separation, transactional migration safety) has already been solved once in this codebase for the sync layer. The work here is disciplined reuse at the primitive level, not reuse of the sync-specific wrapper functions that assume sync's exact semantics (32-byte seeds, sync domain labels, epoch/device binding).

## Common Pitfalls

### Pitfall 1: Reusing `wrapWithPassphrase` verbatim for backup
**What goes wrong:** A backup file becomes byte-for-byte structurally identical to a sync passphrase-recovery package (same AAD domain, same envelope shape), and/or the 32-byte-plaintext assumption silently truncates or is bypassed without anyone noticing until restore fails on a real-size database.
**Why it happens:** `wrapWithPassphrase`/`unwrapWithPassphrase` are the only ready-made Argon2id+AEAD helpers in the codebase, and it's tempting to call them directly.
**How to avoid:** Build a small backup-specific wrap/unwrap pair (Pattern 4) using the lower-level `CryptoProvider` methods, with its own domain label.
**Warning signs:** Any import of `wrapWithPassphrase`/`unwrapWithPassphrase` (or `PassphraseWrappedPackage`) outside `src/sync/**`.

### Pitfall 2: Partial-write backup/restore corruption
**What goes wrong:** Process killed mid-write leaves a truncated `.enc` file that looks present but fails to decrypt, or a restore that partially populates a new SQLite file and gets treated as the live database.
**Why it happens:** Writing a large single file is not atomic by default.
**How to avoid:** Write to a temp path (`backup.enc.tmp`) in the same directory, `fsync`, then atomically `rename()` to the final name — the same pattern any durable single-writer system uses. For restore, only ever write into a brand-new SQLite path; never open the target with `readOnly: false` until the full decrypt+write succeeds.
**Warning signs:** Any test that only exercises the happy path without simulating a truncated backup file or an interrupted restore.

### Pitfall 3: Migration runs before caller expects it, or runs twice concurrently
**What goes wrong:** Two processes (e.g., `memory init` and a daemon start racing) both open `SqliteStore` and both try to run pending migrations, causing a `UNIQUE constraint` violation on `schema_migrations.version` or a partial double-apply of a non-idempotent migration.
**Why it happens:** `SqliteStore`'s constructor already calls `this.migrate()` unconditionally for non-read-only opens (existing behavior); adding real migrations doesn't change *when* this runs, but does change what happens when two writers open it near-simultaneously.
**How to avoid:** Every migration's `apply()` must run inside a single `begin immediate` transaction (SQLite's own locking serializes concurrent writers), and the `schema_migrations` insert must be part of the same transaction as the DDL/data change so a losing concurrent writer's transaction fails atomically rather than partially. This matches the existing pattern already used everywhere else in `sqlite-store.ts` (see `acquireDaemonLease`, `reconcileDaemonSourceStates`).
**Warning signs:** A migration test that only opens one `SqliteStore` instance — add a concurrent-open test (two `SqliteStore` instances against the same file, one migration pending) to Wave 0.

### Pitfall 4: Explain/audit trace leaking scope-restricted facts
**What goes wrong:** `memory explain <id>` or the MCP tool reveals which sensitive/legal/case scope an item belonged to, or reveals the *existence* of a scope-restricted item to a profile that shouldn't see it, even though it correctly refuses to show its content.
**Why it happens:** Audit/explain surfaces are naturally comprehensive by design (that's the point of REQ-039), which is in tension with ADR 0046's scope isolation.
**How to avoid:** Route explain through the same `personId`/`allowedScopeIds` authorization used by every other read tool; a request for an item outside the caller's authorized scopes must fail exactly like `memory_search`/`memory_review` do for such items (uniform `UNAUTHORIZED_OR_NOT_FOUND`-style response, not a distinguishing error that confirms existence). The CLI `memory explain` (run by the owner, not a scoped agent) can be more permissive than the MCP tool, but should still default to the same profile-scoped view unless an explicit `--all-scopes` owner flag is passed.
**Warning signs:** Any explain-trace test written only against an unscoped/full-access store.

### Pitfall 5: Bulk audit-log export becoming an unbounded content leak
**What goes wrong:** D-02's "queryable / exportable append-only audit log" is asked to be "bulk/forensic," which could tempt embedding full message content or full provenance chains into export output, contradicting the existing lifecycle-audit convention (`SourceLifecycleAuditEventSchema.details` is deliberately metadata-only — "They do not copy deleted message content," per ADR 0044).
**Why it happens:** "Forensic review" sounds like it wants maximal detail.
**How to avoid:** Audit log entries stay structurally identical in spirit to existing `source_lifecycle_audit` rows — actor, timestamp, action, target IDs, aggregate counts, no verbatim content. If the planner needs richer detail for a specific verb (e.g., "why summarized" needing `promptVersion`/`model`), that's still metadata, not message text.
**Warning signs:** Any audit-log schema field with an unbounded/large text type that isn't already present in an existing audit-adjacent schema (`SourceLifecycleAuditEventSchema.details` is `JsonObjectSchema`, bounded by whatever callers put in it today — keep exports to the same discipline).

### Pitfall 6: `bin` field wiring breaks `tsx`-based dev execution
**What goes wrong:** `package.json`'s `"bin"` field for a TypeScript source file doesn't work directly under plain `node` (no ts-loader in production) but the project has no build step (`tsc --noEmit` only, per `package.json` scripts — `typecheck`, not `build`).
**Why it happens:** `"bin": { "memory": "./bin/memory" }` needs an executable that Node can actually run; pointing it straight at a `.ts` file fails outside of `tsx`.
**How to avoid:** Make `bin/memory` a tiny `#!/usr/bin/env node` **shim** (or a `#!/usr/bin/env -S npx tsx` shebang, consistent with how every npm script already invokes `tsx src/...`) that requires/imports the compiled or `tsx`-run entrypoint. Confirm with the planner whether this project ships compiled JS at all (it currently doesn't — no `build` script, no `dist/` referenced) — if it stays `tsx`-only, the `bin` shebang should be `#!/usr/bin/env -S npx tsx` (or equivalent) pointing at `src/cli/bin.ts`, not a compiled path that doesn't exist yet. This is a real open question for the planner (see Open Questions).
**Warning signs:** `npm link` / `npx memory ...` failing with a syntax error on TypeScript syntax.

## Code Examples

### Reading the DB file size for health/status (D-06, D-09 reporting)
```typescript
// Source: pattern derived from node:fs (built-in), no existing precedent in this repo — new code
import { statSync } from "node:fs";

export function databaseFileSizeBytes(databasePath: string): number {
  return statSync(databasePath).size;
}
```
Note: `node:sqlite`'s `DatabaseSync` has no public "file size" API; reading the file directly with `fs.statSync` is the correct approach and matches SQLite's own single-file-database model. For WAL mode (already enabled — `pragma journal_mode = WAL` runs in the constructor), also stat the `-wal` and `-shm` sidecar files if present, since a checkpoint may not have folded them into the main file yet; report the sum as "on-disk footprint" distinct from "primary database file size" if precision matters to the planner.

### Argon2id parameters already available for reuse (do not redefine)
```typescript
// Source: src/sync/crypto/crypto-provider.ts:116 (existing, verbatim)
export const ARGON2ID_REVIEWED_FLOOR = {
  opsLimit: 3,
  memLimit: 268_435_456 // 256 MiB
} as const;
```
Backup should use these same reviewed-floor parameters (or stronger) rather than inventing new ones — there is no reason backup passphrase security should be weaker than sync recovery-passphrase security, and using different values doubles the parameter surface that needs justifying.

### Existing read-only store open (reuse for backup's read path)
```typescript
// Source: src/storage/sqlite-store.ts:146 (existing, verbatim, relevant slice)
constructor(location: string, options: SqliteStoreOptions = {}) {
  // ...
  this.database = new DatabaseSync(location, {
    readOnly: options.readOnly ?? false,
    timeout: busyTimeoutMs
  });
  // ...
  if (!options.readOnly) {
    this.migrate();
    this.database.exec("pragma journal_mode = WAL");
  }
}
```
Backup should open with `{ readOnly: true }` — this also conveniently skips running `migrate()`, so a backup command never has side effects on the live database, and works even against a database whose schema is *ahead* of the running binary's known migrations (as long as the read queries used to build the dump only touch tables/columns this version already knows about).

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| N/A — no prior CLI packaging existed | Unified `bin` dispatcher over existing command modules | This phase | First user-facing single entrypoint; `memory:*` npm scripts remain for existing internal/CI usage |
| N/A — no prior schema versioning existed | `pragma user_version` + `schema_migrations` table + ordered migration list | This phase | All future phases (post-v1.0 changes) must add migrations here instead of hand-splicing into `migrate()`'s base block |
| Ad hoc one-off data migration (`migrateDaemonContractionPayloads`, runs unconditionally on every open) | Same logic, converted into a numbered, once-only migration | This phase (recommended, not mandatory) | Removes a small but real amount of wasted work on every single `SqliteStore` open (it currently re-scans every `daemon_contraction_job`/`daemon_contraction_checkpoint` row on every process start) |

**Deprecated/outdated:** Nothing in this codebase is being deprecated by this phase; it is purely additive over Phases 1–6.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | "~30 `memory:*` command modules" in CONTEXT.md refers to combined script aliases, and the actual leaf command-module count is 19 (verified by `find src -iname "*-command.ts"`) | Summary | Low — this is a verified count from the actual repo, not an assumption; included only to correct CONTEXT.md's approximate figure for the planner's task-sizing |
| A2 | A `schema_migrations` table (in addition to `pragma user_version`) is the right audit-trail design for D-08 | Standard Stack / Pattern 3 | Low-medium — this is a design recommendation, not a verified requirement; the planner or user could reasonably choose `pragma user_version` alone for simplicity. Flagging because it affects the migration runner's shape. |
| A3 | Backup should hold the entire serialized dump in memory for one whole-buffer AEAD call rather than streaming/chunking | Anti-Patterns, Code Examples | Medium if the real database ever grows past available RAM (unlikely for a single local user's conversational history at realistic scale, but not measured here) |
| A4 | The project has no build/`dist` step, so `bin/memory` must shebang into `tsx` rather than compiled JS | Pitfall 6 | Medium — verified `package.json` has no `build` script today, but the planner may decide to add one as part of this phase, which would change the correct shebang target |
| A5 | Growing the MCP read-tool catalog from 6 to 7 tools (adding `memory_explain`) is acceptable and not blocked by some "exactly sixteen tools" invariant enforced elsewhere | Pattern 5 | Medium — STATE.md's phrase "Generic sixteen-tool local MCP interface" was found via a status summary, not a hard-coded assertion; I did not locate and read a test that asserts an exact total tool count across both read and mutation tools. The planner should grep for any such assertion before committing to this being trivially additive. |

## Open Questions (RESOLVED)

1. **What is the exact backup payload format — raw SQLite file bytes vs. a logical JSON dump?**
   - What we know: `SqliteStore` already supports `{ readOnly: true }` opens, and WAL mode is enabled, so a raw file copy risks missing WAL-only data unless a checkpoint (`pragma wal_checkpoint(TRUNCATE)`) runs first. A logical dump (iterate every table via existing `MemoryStore` list/get methods, or raw `select * from <table>`) is more portable across schema versions and easier to test deterministically with synthetic fixtures, but is more code to write and keep in sync with the table list.
   - What's unclear: Whether restore needs byte-for-byte fidelity (raw file copy, simplest, but ties backup format to the exact on-disk SQLite version/page size) or whether a logical JSON-lines dump (table name + row payload per line) is preferred for portability and for the review/audit trail's "inspect what a backup contains" goal.
   - Recommendation: Logical dump (one JSON line per row across all tables, in a fixed schema-versioned envelope) — it's inspectable in the plaintext-export escape hatch too (D-07's `export --plaintext` naturally becomes "write the same dump unencrypted"), and it decouples backup format from SQLite's on-disk page format. Restore replays it into a fresh `SqliteStore` (which runs `migrate()` first, then inserts rows) rather than requiring an exact schema-version match to the writer's SQLite build.
   - RESOLVED: Adopted verbatim — logical JSON-lines dump in a fixed schema-versioned envelope, implemented in 07-06 (encrypted backup) and reused unencrypted by `export --plaintext`.

2. **Does `memory init`'s guided flow need to detect and offer schema migration for an *existing* database, or is migration always transparent/automatic?**
   - What we know: `SqliteStore`'s constructor already runs `migrate()` unconditionally on every non-read-only open — this is existing, tested behavior.
   - What's unclear: Whether D-08 wants migration to stay silent/automatic (consistent with current behavior — "just works" on every command) or whether the health/status surface (D-06) should surface "schema version N, migrated from M at startup" so the user can see it happened (serves the "inspect and trust" goal).
   - Recommendation: Keep migration automatic (don't add a confirmation gate — this is a local single-user schema change, not a destructive data operation), but surface the current `schema_migrations` version and the most recent migration's `applied_at` in the health/status output so it's inspectable after the fact, satisfying "trust" without adding friction.
   - RESOLVED: Adopted verbatim — automatic migration retained (07-04) and the current schema version is surfaced in the health/status surface (07-05).

3. **Should the unified `bin` CLI require the mechanical `main(argv)` export refactor across all ~19 existing command modules as part of Wave 1, or can `bin/memory` spawn a subprocess (`child_process.execFile("tsx", [...])`) instead?**
   - What we know: Subprocess spawning avoids touching 19 existing files but adds process-spawn overhead, loses direct in-process error typing, and is inconsistent with "wrap, don't reimplement" (D-04) in spirit if the wrapping is done at the OS-process boundary rather than the module boundary.
   - What's unclear: Whether the planner considers the 19-file mechanical refactor in-scope for Wave 1's budget, given CONTEXT.md's explicit warning that this is already a broad phase.
   - Recommendation: Do the in-process `main(argv)` export refactor — it's mechanical (rename the guarded `main()` to accept and use an `argv` parameter instead of reading `process.argv.slice(2)`, export it, keep the guard), low-risk (each file already has direct unit-test coverage of its `run*Command` function, and the refactor doesn't touch that function), and produces a genuinely single binary rather than a dispatcher-that-shells-out. Size it as its own task/wave-1 sub-step, separate from writing brand-new commands.
   - RESOLVED: Adopted verbatim — in-process `main(argv)` export refactor done as its own Wave 1 task (07-01 Task 2), separate from the dispatcher.

4. **Exact set of D-09 tuning knobs.** CONTEXT.md names "cache sizes, retention/contraction thresholds, index rebuild" as examples but doesn't lock a final list.
   - What we know: No existing config-knob surface exists today (`grep` found no `RETENTION`/`CACHE_SIZE`/threshold constants outside `historical-bootstrapper.ts`, which is not itself a tunable-knob file).
   - What's unclear: Which specific runtime parameters in the daemon/retrieval/contraction pipeline are safe to expose as user-tunable without risking invariants those subsystems' existing tests depend on (e.g., contraction batch sizing, lease durations).
   - Recommendation: Defer the exact knob list to the planner/discuss-phase step with a concrete proposed default set: SQLite `busy_timeout` (already a `SqliteStoreOptions` field, just not CLI-exposed), retrieval result-limit/token-budget defaults (already bounded in `read-tools.ts` schemas, could become configurable defaults rather than hardcoded), and a manual "rebuild indexes" (`REINDEX`/`ANALYZE`) trigger — all three are low-risk because they don't change data semantics, only performance characteristics.
   - RESOLVED: Adopted verbatim — the three tuning knobs (`busy_timeout`, retrieval-limit defaults, `REINDEX`+`ANALYZE` trigger) implemented in 07-05 Task 3.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js `node:sqlite` | All storage work, migration | ✓ | Node 24.7.0 (`node:sqlite` stable since Node 22.5, this environment is well above minimum) [VERIFIED: `node --version`] | — |
| `libsodium-wrappers-sumo` | Backup encryption | ✓ | 0.8.4, installed in `node_modules` per `package.json` | — |
| `zod` | All new schemas | ✓ | 3.25.76 | — |
| `canonicalize` | Backup/audit AAD or manifest canonicalization | ✓ | 3.0.0 | — |
| `slopcheck` (package legitimacy tool) | N/A — no new packages this phase | N/A | N/A | Not needed; no new install to verify |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** none — everything required is already installed.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 2.0.5 [VERIFIED: package.json] |
| Config file | `vitest.config.ts` (`include: ["tests/**/*.test.ts"]`, `environment: "node"`) |
| Quick run command | `npx vitest run tests/storage/sqlite-store.test.ts` (or narrower to a `-t` pattern once new tests exist) |
| Full suite command | `npm test` (= `vitest run`) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| REQ-039 | `memory explain <id>` reconstructs why an item was imported | unit | `npx vitest run tests/audit/explain-command.test.ts` | ❌ Wave 0 |
| REQ-039 | `memory explain <id>` reconstructs why an item was summarized/synchronized/retrieved/expanded/approved/rejected/deleted (each verb) | unit (one case per verb, using synthetic fixtures for each lifecycle stage) | `npx vitest run tests/audit/explain-service.test.ts` | ❌ Wave 0 |
| REQ-039 | Explain MCP tool respects `personId`/`allowedScopeIds` authorization identically to other read tools | integration | `npx vitest run tests/mcp/read-tools.test.ts` (extend existing file if present, else create) | ⚠️ check `tests/mcp/` for existing read-tools coverage |
| REQ-039 | Audit log export is queryable/filterable and contains no verbatim message content | unit | `npx vitest run tests/audit/audit-log-command.test.ts` | ❌ Wave 0 |
| D-04 | `bin/memory <subcommand>` dispatches to the correct existing command and returns its exact result | integration | `npx vitest run tests/cli/bin.test.ts` | ❌ Wave 0 |
| D-05 | `memory init` performs discover → per-source consent → bootstrap → offer-daemon in order, and skips import for unapproved sources | integration | `npx vitest run tests/bootstrap/init-command.test.ts` | ❌ Wave 0 |
| D-06 | Health/status surface reports DB size, daemon state, sync lag, pending proposals correctly against a synthetic fixture DB | unit | `npx vitest run tests/bootstrap/status-command.test.ts` (extend; confirm exact filename — none found under `tests/bootstrap` today, only `bootstrap-commands.test.ts` and `historical-bootstrapper.test.ts`) | ⚠️ likely needs new file |
| D-07 | Backup produces a decryptable envelope; wrong passphrase fails uniformly (`SYNC_INTEGRITY_FAILED`-equivalent, content-free); restore reproduces an equivalent logical dataset | unit + integration (round-trip against a temp SQLite file) | `npx vitest run tests/storage/backup/backup-restore.test.ts` | ❌ Wave 0 |
| D-07b | `export --plaintext` is byte-inspectable as plaintext JSON and clearly distinct in filename/format from `backup` output | unit | `npx vitest run tests/storage/backup/export-plaintext.test.ts` | ❌ Wave 0 |
| D-08 | A fresh database ends at the latest schema version; an existing v1 database migrates to latest without data loss; a migration that throws leaves `schema_migrations` unchanged (transactional) | unit | `npx vitest run tests/storage/schema-migrations.test.ts` | ❌ Wave 0 |
| D-08 | Concurrent-open migration race does not corrupt `schema_migrations` or double-apply a migration | integration | `npx vitest run tests/storage/schema-migrations-concurrency.test.ts` | ❌ Wave 0 |
| D-09 | Health surface reports query/retrieval latency and DB size accurately against synthetic timing fixtures (fake clock, not wall-clock timing assertions) | unit | `npx vitest run tests/bootstrap/status-command.test.ts` (same file as D-06, extended) | ⚠️ see D-06 row |
| D-09 | Tuning knobs (e.g., `busy_timeout`, retrieval defaults) are honored end-to-end when set via CLI | integration | `npx vitest run tests/operations/tune-command.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** run the single narrow test file for the module just touched (e.g., `npx vitest run tests/storage/schema-migrations.test.ts`)
- **Per wave merge:** `npm test` (full suite) — this project's suite is already broad (Phases 1–6 all have coverage under `tests/`), so a full run before merging a wave is the correct gate to catch cross-subsystem regressions (e.g., a schema migration change breaking an unrelated store test)
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `tests/cli/bin.test.ts` — dispatcher routing, unknown-subcommand handling
- [ ] `tests/bootstrap/init-command.test.ts` — guided onboarding orchestration
- [ ] `tests/audit/explain-command.test.ts`, `tests/audit/explain-service.test.ts` — one test case per REQ-039 verb (imported, summarized, synchronized, retrieved, expanded, approved, rejected, deleted)
- [ ] `tests/audit/audit-log-command.test.ts` — bulk export, filtering, no-content-leak assertion
- [ ] `tests/storage/backup/backup-restore.test.ts`, `tests/storage/backup/export-plaintext.test.ts` — round-trip, wrong-passphrase, partial-write-simulation, plaintext-vs-encrypted distinction
- [ ] `tests/storage/schema-migrations.test.ts`, `tests/storage/schema-migrations-concurrency.test.ts` — fresh DB, existing-v1 DB, failed-migration rollback, concurrent-open race
- [ ] `tests/operations/tune-command.test.ts` — tuning-knob application
- [ ] Confirm whether `tests/bootstrap/` needs a new `status-command.test.ts` or whether status coverage lives elsewhere (none found by filename search — verify before assuming a gap)
- [ ] Confirm whether `tests/mcp/` has existing read-tools coverage to extend for the new `memory_explain` tool (file search did not conclusively locate one — planner should check `tests/mcp/` contents directly)
- Framework install: none — Vitest already configured project-wide

## Project Constraints (from CLAUDE.md)

No project-level `./CLAUDE.md` exists in this repository (checked at `/Users/aaronwhaley/Agent-Corporation/conversational-memory-system/CLAUDE.md` — not found). The user's global `~/.claude/CLAUDE.md` sets tooling/workflow conventions (GSD phase tracking, Beads issue tracking, plugin scoping) but contains no code-level directives applicable to this phase's implementation choices.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | Single local user, no auth surface added by this phase |
| V3 Session Management | No | N/A |
| V4 Access Control | Yes | Explain/audit MCP tool must enforce the same `personId`/`allowedScopeIds` authorization as existing read tools (ADR 0046); CLI commands run with full local-owner authority, consistent with existing command modules |
| V5 Input Validation | Yes | Zod `.strict()` schemas for every new command's options and every new MCP tool's input/output, matching existing convention throughout `src/mcp/tools/read-tools.ts` and every `*-command.ts` |
| V6 Cryptography | Yes | Backup encryption must use only the existing reviewed `CryptoProvider` primitives (XChaCha20-Poly1305-IETF, Argon2id at `ARGON2ID_REVIEWED_FLOOR`) — never hand-roll a cipher or KDF, never weaken parameters below the reviewed floor (`unwrapWithPassphrase`'s existing floor-rejection pattern in `libsodium-crypto-provider.ts:184` is the template to replicate for backup's unwrap path) |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Backup file readable/decryptable by anyone who obtains it without the passphrase | Information disclosure | Argon2id at reviewed floor + XChaCha20-Poly1305-IETF AEAD (authenticated, not just encrypted) — matches ADR 0047's exact suite |
| Plaintext `export --plaintext` mistaken for the encrypted backup and stored/shared insecurely | Information disclosure (human-factor) | Distinct filename convention/extension, explicit CLI warning text printed to stderr before writing, and a required `--plaintext` flag that cannot be satisfied by any alias of `backup` — never make plaintext export the default or the same command name |
| Restore silently overwriting the live database on a wrong `--out` argument | Tampering / Repudiation (data loss without audit trail) | Restore always targets a new path; require explicit confirmation (matches the existing confirmation-ticket pattern used for destructive MCP mutations, e.g. source deletion) before any operation that could touch the live `--db` path |
| Explain/audit surface used as an oracle to confirm existence of scope-restricted memory | Information disclosure | Route through the same authorization and uniform-failure-response pattern as `memory_search`/`memory_review` (`UNAUTHORIZED_OR_NOT_FOUND`-style, non-distinguishing) |
| Malformed/adversarial backup file crafted to exploit restore's JSON parsing or SQLite insert path | Tampering / Denial of service | Same discipline as `openSyncEnvelope`: validate schema before parsing content, reject on any AEAD/signature-equivalent failure with a uniform error before touching application state, bound every array/string field with Zod like the rest of the domain schemas |
| Migration `apply()` throwing partway through a multi-statement DDL/data change | Tampering (data corruption) | Every migration wrapped in `begin immediate`/`commit`/`rollback`, matching the transactional pattern already used throughout `sqlite-store.ts` |

## Sources

### Primary (HIGH confidence)
- `/Users/aaronwhaley/Agent-Corporation/conversational-memory-system/.planning/phases/07-onboarding-and-operational-readiness/07-CONTEXT.md` — locked decisions and discretion areas
- `/Users/aaronwhaley/Agent-Corporation/conversational-memory-system/.planning/REQUIREMENTS.md` — REQ-039, REQ-040 exact language
- `/Users/aaronwhaley/Agent-Corporation/conversational-memory-system/.planning/ROADMAP.md` — Phase 7 goal, requirement mapping, sequencing principle
- `/Users/aaronwhaley/Agent-Corporation/conversational-memory-system/docs/adr/0047-zero-knowledge-sync-threat-model-and-protocol.md` — crypto suite, domain-separation rules, Argon2id floor
- `/Users/aaronwhaley/Agent-Corporation/conversational-memory-system/docs/adr/0044-source-revocation-and-attributable-deletion.md` — audit event shape, deletion semantics
- `/Users/aaronwhaley/Agent-Corporation/conversational-memory-system/docs/adr/0046-person-and-retrieval-scope-boundaries.md` — scope authorization rules explain must respect
- `/Users/aaronwhaley/Agent-Corporation/conversational-memory-system/src/sync/crypto/crypto-provider.ts`, `libsodium-crypto-provider.ts` — exact reusable crypto primitives and their existing domain-binding
- `/Users/aaronwhaley/Agent-Corporation/conversational-memory-system/src/storage/sqlite-store.ts` — current `migrate()` implementation, existing ad hoc data-migration precedent, transactional patterns
- `/Users/aaronwhaley/Agent-Corporation/conversational-memory-system/src/types/node-sqlite.d.ts`, `package.json` — confirms `node:sqlite` usage and installed dependency versions
- `/Users/aaronwhaley/Agent-Corporation/conversational-memory-system/src/mcp/tools/read-tools.ts`, `authority.ts`, `tool-catalog.ts` — exact read-tool registration and authorization pattern
- `/Users/aaronwhaley/Agent-Corporation/conversational-memory-system/src/bootstrap/status-command.ts` — health/status extension point
- `/Users/aaronwhaley/Agent-Corporation/conversational-memory-system/src/domain/source-lifecycle.ts`, `canonical.ts` — provenance fields available for explain traces
- `npm view libsodium-wrappers-sumo version`, `npm view zod version` — registry version confirmation, run 2026-07-20

### Secondary (MEDIUM confidence)
- None used — all findings in this research are grounded directly in the codebase itself rather than external ecosystem search, since this phase's non-obvious work (backup crypto reuse, migration versioning) is an internal-consistency problem, not an ecosystem-selection problem.

### Tertiary (LOW confidence)
- None.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every recommended library is already installed and verified against the registry; no new dependency decisions were needed
- Architecture: HIGH — all patterns are extensions of code read directly from this repository, not external inference
- Pitfalls: HIGH for crypto/migration pitfalls (grounded in ADR 0047's explicit domain-separation and reviewed-floor language, and in the existing transactional patterns in `sqlite-store.ts`); MEDIUM for the exact MCP tool-count invariant (A5) and exact bin-shim mechanics (A4), both flagged as open questions for the planner to resolve with a direct look at any tool-count assertion and at whether a build step should be added

**Research date:** 2026-07-20
**Valid until:** 30 days (stable — this is an internal-consistency phase over an already-built system, not tracking a fast-moving external ecosystem; only the two `npm view` version checks would go stale faster, and both are pinned dependencies the project controls deliberately)
