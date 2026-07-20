# Phase 7: Onboarding and Operational Readiness - Pattern Map

**Mapped:** 2026-07-20
**Files analyzed:** 20 (new) + 4 (modified)
**Analogs found:** 24 / 24

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/cli/bin.ts` | controller (dispatcher) | request-response | `src/daemon/daemon-command.ts` (subcommand dispatch inside one file) | role-match |
| `src/cli/command-registry.ts` | config | request-response | `src/mcp/tool-catalog.ts` (static registration map) | role-match |
| `src/bootstrap/init-command.ts` | controller | event-driven (orchestrates approve/consent then bootstrap) | `src/imports/source-revoke-command.ts` + `src/bootstrap/bootstrap-command.ts` | role-match |
| `src/bootstrap/status-command.ts` (EXTEND) | controller | CRUD (read aggregate) | itself (existing) | exact |
| `src/audit/explain-command.ts` | controller | request-response | `src/bootstrap/status-command.ts` (read-aggregate CLI command) | role-match |
| `src/audit/explain-service.ts` | service | CRUD (read) | `src/bootstrap/status-command.ts::readDaemonStatusSnapshot` (shared read helper used by both CLI and MCP) | role-match |
| `src/audit/audit-log-command.ts` | controller | batch (export) | `src/bootstrap/status-command.ts` (multi-store read + JSON stdout) | role-match |
| `src/mcp/tools/read-tools.ts` (EXTEND: `memory_explain`) | route/controller | request-response | itself — `memory_review`/`source_status` registrations (lines 232-266) | exact |
| `src/mcp/tool-catalog.ts` (EXTEND) | config | request-response | itself (existing) | exact |
| `src/storage/backup/backup-command.ts` | controller | file-I/O | `src/bootstrap/status-command.ts` (readOnly store open) + `src/sync/crypto/libsodium-crypto-provider.ts` (seal) | role-match |
| `src/storage/backup/restore-command.ts` | controller | file-I/O | `src/imports/source-revoke-command.ts` (single-purpose write command) | role-match |
| `src/storage/backup/export-plaintext-command.ts` | controller | file-I/O | `src/storage/backup/backup-command.ts` (sibling, minus crypto step) | role-match (new sibling) |
| `src/storage/backup/backup-crypto.ts` | utility | transform | `src/sync/crypto/libsodium-crypto-provider.ts` (`wrapWithPassphrase`/`unwrapWithPassphrase`, lines 152-215) | role-match, explicit non-reuse |
| `src/storage/sqlite-store.ts` (EXTEND: `migrate()`, `getSchemaVersion()`, `dbFileSizeBytes()`) | model/store | CRUD | itself — `migrate()` (line 1628) and `migrateDaemonContractionPayloads()` (line 1894) | exact |
| `src/storage/schema-migrations.ts` | model | transform/batch | `src/storage/sqlite-store.ts::migrateDaemonContractionPayloads` (transactional versioned-migration precedent) | role-match |
| `src/operations/tune-command.ts` | controller | CRUD (config write) | `src/imports/source-revoke-command.ts` (single-flag mutation command) | role-match |
| `package.json` (`bin` field, EXTEND) | config | — | n/a (new) | no analog |
| `bin/memory` (shim) | config | — | n/a (new; see Pitfall 6 in RESEARCH.md) | no analog |
| `src/imports/*-command.ts` (19 files, MODIFY: export `main(argv)`) | controller | request-response | itself — mechanical refactor of existing guard pattern | exact |

## Pattern Assignments

### `src/cli/bin.ts` (controller, request-response)

**Analog:** `src/daemon/daemon-command.ts` (subcommand-in-one-file dispatch, lines 72-134) and `src/mcp/tool-catalog.ts` (static registration map, lines 1-23)

**Dispatch-by-name pattern** (`src/daemon/daemon-command.ts:72-134`):
```typescript
const subcommand = args[0];
if (!subcommand || !DaemonSubcommandSchema.safeParse(subcommand).success) {
  throw new Error("Missing or unknown daemon subcommand; use run, start, stop, restart, status, or once.");
}
// ...
if (parsed.subcommand === "run") {
  return { ok: true, subcommand: "run", result: await runtime.createLoop(parsed.databasePath).run() };
}
```
Adapt this to a `Record<string, () => Promise<{ main(argv: string[]): Promise<void> }>>` keyed by top-level subcommand name (`import`, `status`, `init`, `daemon`, `explain`, `backup`, `restore`, `export`, `migrate`, `audit-log`, `tune`, …), dynamically `import()`ing each module and calling its exported `main(argv)`. See RESEARCH.md Pattern 2 for the exact skeleton — do not deviate from it; it is already fully designed.

**Static registry pattern** (`src/mcp/tool-catalog.ts:1-23`):
```typescript
export const registerMemoryTools = (
  server: McpServer,
  application: MemoryToolApplication
): void => {
  registerMemoryReadTools(server, application.reads);
  registerMemoryMutationTools(server, application.mutations);
};
```
Mirror this "one file, one flat map, no framework" shape for `command-registry.ts`.

**Error handling pattern** (every command's `main()`, e.g. `src/bootstrap/status-command.ts:196-201`):
```typescript
main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
```
`bin.ts` must use this exact stderr + `process.exitCode = 1` shape (not `process.exit`), consistent with every existing command.

---

### `src/imports/*-command.ts` (19 files) — mechanical `main(argv)` export refactor

**Analog:** itself, e.g. `src/bootstrap/status-command.ts:191-201` and `src/imports/source-revoke-command.ts:28-49`

**Current pattern (to be changed minimally):**
```typescript
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
**Required change:** rename `main()` to accept `main(argv: string[])`, replace internal `process.argv.slice(2)` with the `argv` parameter, and `export` it. Keep the `import.meta.url` guard calling `main(process.argv.slice(2))` unchanged so `npm run memory:status` still works standalone. This is a pure signature change — `run*Command`/`parseArgs` bodies are untouched. Apply identically across all 19 files listed by `find src -iname "*-command.ts"`.

---

### `src/bootstrap/init-command.ts` (controller, event-driven orchestration)

**Analog:** `src/imports/source-revoke-command.ts` (single-purpose command wrapping a service call) composed with `src/bootstrap/status-command.ts`'s multi-await orchestration style (lines 125-139)

**Orchestration pattern to mirror** (`src/bootstrap/status-command.ts:124-139`):
```typescript
const store = new SqliteStore(parsed.databasePath);
try {
  const [sources, events, imports, ...] = await Promise.all([ /* independent reads */ ]);
  return { ok: true, ... };
} finally {
  store.close();
}
```
For `init`, sequence is NOT parallel (discover → consent → bootstrap → offer-daemon must run in order), so instead sequence awaited calls to the existing exported command functions: `runHistoryDiscoverCommand` (or codex equivalent) → per-source approve calls (mirror `SourceLifecycleService` usage in `source-revoke-command.ts:16-21`, but calling `.approve` not `.revoke`) → `runBootstrapCommand` (from `src/bootstrap/bootstrap-command.ts`) → optionally `runDaemonCommand({ subcommand: "start", ... })`.

**Store lifecycle:** open one `SqliteStore`, pass it (or its path) through each stage, `store.close()` in a `finally` exactly like every existing command — do not open multiple stores for one `init` invocation.

---

### `src/audit/explain-service.ts` + `src/audit/explain-command.ts` (service + controller, CRUD read)

**Analog:** `src/bootstrap/status-command.ts` — both the shared-snapshot function pattern (`readDaemonStatusSnapshot`, lines 59-117, exported and reused by both the CLI command and the MCP `source_status` tool's underlying query service) and the CLI wrapper (`runMemoryStatusCommand`, lines 119-170).

**Shared-logic-behind-two-surfaces pattern** (`src/bootstrap/status-command.ts:59-64, 119-123`):
```typescript
export async function readDaemonStatusSnapshot(
  store: MemoryStore,
  now: string,
  serviceStatus: LaunchAgentStatus | null = null,
  personId?: string
): Promise<DaemonStatusSnapshot> { /* pure read, no CLI concerns */ }

export async function runMemoryStatusCommand(
  options: MemoryStatusCommandOptions
): Promise<MemoryStatusCommandResult> {
  const parsed = OptionsSchema.parse(options);
  const store = new SqliteStore(parsed.databasePath);
  try { /* calls readDaemonStatusSnapshot + other reads */ } finally { store.close(); }
}
```
`explain-service.ts` should export a pure `explain(store, itemId, options): Promise<ExplainTrace>` function (no CLI/MCP concerns, takes an already-open `MemoryStore`), exactly like `readDaemonStatusSnapshot`. `explain-command.ts` wraps it with `parseArgs`/`main(argv)`/store-open-close, exactly like `runMemoryStatusCommand`. The MCP tool (in `read-tools.ts`) calls the same `explain()` function directly — no duplication.

**Zod options schema pattern** (`src/bootstrap/status-command.ts:30-33`):
```typescript
const OptionsSchema = z.object({
  databasePath: z.string().min(1),
  personId: z.string().min(1)
});
```
Reuse this shape for `ExplainCommandOptions` (add `itemId: z.string().min(1)`).

---

### `src/mcp/tools/read-tools.ts` (EXTEND) — new `memory_explain` tool

**Analog:** itself — `memory_review` and `source_status` registrations, lines 232-266

**Exact registration shape to copy:**
```typescript
server.registerTool(
  "source_status",
  {
    title: "Inspect memory synchronization status",
    description: "Return profile-scoped source and memory counts, including an explicit offline daemon state.",
    inputSchema: SourceStatusInputSchema,
    outputSchema: SourceStatusOutputSchema,
    annotations: MEMORY_READ_TOOL_ANNOTATIONS
  },
  async () => safeRead(() => application.queries.status(application.now?.()))
);
```
For `memory_explain`: input schema is a single bounded identifier — reuse `IdentifierSchema` (line 9: `z.string().min(1).max(512)`) exactly as `MemoryExpandSubjectInputSchema`/others do. Output must be `.strict()` and bound any array fields the same way `MemoryReadItemSchema.provenance` is bounded (`ProvenanceSchema`, line 13-16, `.max(1_000)`). Route through `safeRead` (lines 284-300) so failures return the same uniform `UNAUTHORIZED_OR_NOT_FOUND`/`INVALID_REQUEST` shape via `sanitizedErrorCode` (lines 302-309) — add a branch there if explain introduces a new distinguishable error message, but keep it non-content-revealing.

**Tool list + annotations to update:**
```typescript
export const MEMORY_READ_TOOL_NAMES = [
  "memory_search", "memory_recall", "memory_review",
  "memory_expand_subject", "source_status", "proposal_list"
] as const;
```
Add `"memory_explain"` to this array (line 179-186) and update the `tool-catalog.ts:16` comment "Register the finite Phase 5 catalog once" — per RESEARCH.md Assumption A5, grep for any hardcoded tool-count assertion in tests before finalizing (`grep -rn "MEMORY_READ_TOOL_NAMES\|sixteen" tests/`).

**Authority/scope gating:** `MemoryReadToolApplication` (lines 195-200) takes `queries`, `expansion`, `proposals`, `now?` — the explain tool needs an equivalent authority-bound service reference so it enforces `personId`/`allowedScopeIds` (`ProfileAuthority`, `src/mcp/authority.ts:3-12`) exactly like `MemoryQueryService`/`ScopedProposalReviewer` already do. Do not bypass `ProfileAuthority`.

---

### `src/storage/backup/backup-crypto.ts` (utility, transform)

**Analog:** `src/sync/crypto/libsodium-crypto-provider.ts:152-215` (`wrapWithPassphrase`/`unwrapWithPassphrase`) — structural template ONLY, must not be called directly (domain separation, see RESEARCH.md Pattern 4 and Pitfall 1).

**Structural pattern to replicate with a new domain label** (`src/sync/crypto/libsodium-crypto-provider.ts:152-175`):
```typescript
wrapWithPassphrase(passphrase: string, plaintext: Uint8Array, parameters: Argon2idParameters): PassphraseWrappedPackage {
  const key = sodium.crypto_pwhash(
    AEAD_KEY_BYTES, passphrase, parameters.salt,
    parameters.opsLimit, parameters.memLimit, ARGON2ID_ALGORITHM
  );
  const nonce = this.randomBytes(AEAD_NONCE_BYTES);
  try {
    const ciphertext = this.aeadSeal(key, nonce, this.canonicalPassphraseHeader(parameters, nonce), plaintext);
    return { algorithm: "argon2id", opsLimit: parameters.opsLimit, memLimit: parameters.memLimit, salt: parameters.salt, nonce, ciphertext };
  } finally {
    this.zero(key);
  }
}
```
**Uniform-failure unwrap pattern** (`src/sync/crypto/libsodium-crypto-provider.ts:177-209`):
```typescript
unwrapWithPassphrase(passphrase: string, packageValue: PassphraseWrappedPackage): Uint8Array {
  if (packageValue.opsLimit < ARGON2ID_REVIEWED_FLOOR.opsLimit || packageValue.memLimit < ARGON2ID_REVIEWED_FLOOR.memLimit) {
    throw new SyncProtocolError("SYNC_INTEGRITY_FAILED");
  }
  const key = sodium.crypto_pwhash(/* ... */);
  try {
    const aad = this.canonicalPassphraseHeader(/* ... */);
    return this.aeadOpen(key, packageValue.nonce, aad, packageValue.ciphertext);
  } catch {
    throw new SyncProtocolError("SYNC_INTEGRITY_FAILED"); // uniform — never distinguishes wrong-passphrase from tamper
  } finally {
    this.zero(key);
  }
}
```
**Domain-label AAD pattern** (`canonicalPassphraseHeader`, line 211-215):
```typescript
private canonicalPassphraseHeader(parameters: Pick<Argon2idParameters, "opsLimit" | "memLimit" | "salt">, nonce: Uint8Array): Uint8Array {
  return this.canonicalBytes({
    domain: "cms.sync.v1/passphrase-package",
    opsLimit: parameters.opsLimit,
    // ...
  });
}
```
`backup-crypto.ts` must build its own `wrapBackupWithPassphrase`/`unwrapBackupWithPassphrase` functions (NOT methods on `LibsodiumCryptoProvider`) that take a `CryptoProvider` instance as a parameter and call only the public primitives (`randomBytes`, `aeadSeal`, `aeadOpen`, `canonicalBytes`, `zero`) plus a locally-implemented Argon2id derivation using `sodium.crypto_pwhash` directly (or a small new exported helper) — with AAD domain `"cms.backup.v1/passphrase-package"` instead of `"cms.sync.v1/passphrase-package"`. **Never import `wrapWithPassphrase`/`unwrapWithPassphrase` outside `src/sync/**`** (RESEARCH.md Pitfall 1). Reuse `ARGON2ID_REVIEWED_FLOOR` (`src/sync/crypto/crypto-provider.ts:116-119`) verbatim — do not redefine parameters.

**Available primitives contract** (`src/sync/crypto/crypto-provider.ts:35-113`, interface only — this is what backup-crypto.ts is allowed to call):
```typescript
export interface CryptoProvider {
  ready(): Promise<void>;
  randomBytes(byteLength: number): Uint8Array;
  canonicalBytes(value: unknown): Uint8Array;
  aeadSeal(key: Uint8Array, nonce: Uint8Array, associatedData: Uint8Array, plaintext: Uint8Array): Uint8Array;
  aeadOpen(key: Uint8Array, nonce: Uint8Array, associatedData: Uint8Array, ciphertext: Uint8Array): Uint8Array;
  constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean;
  zero(buffer: Uint8Array): void;
  // ... (do not use wrapWithPassphrase/unwrapWithPassphrase from here for backup)
}
```

---

### `src/storage/backup/backup-command.ts` (controller, file-I/O)

**Analog:** `src/bootstrap/status-command.ts` (read-only store open + `parseArgs`/`main` shape)

**Read-only open pattern** (`src/storage/sqlite-store.ts:146-160`):
```typescript
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
`backup-command.ts` must open with `new SqliteStore(parsed.databasePath, { readOnly: true })` — this both prevents side effects on the live DB and skips `migrate()`, per RESEARCH.md's "Existing read-only store open" code example. Follow the same `parseArgs`/`main`/`import.meta.url` guard triple as every other command (`src/bootstrap/status-command.ts:172-201`).

**Atomic-write requirement (RESEARCH.md Pitfall 2, no existing in-repo precedent — new code):** write to `<out>.tmp` in the same directory, `fsync`, then `rename()` to the final path; never write the final filename directly.

---

### `src/storage/backup/restore-command.ts` (controller, file-I/O)

**Analog:** `src/imports/source-revoke-command.ts` (single-purpose mutation command, full file, lines 1-49) — same shape: parse required flags, call one service/helper, return `{ ok: true, ... }`.

Restore must never open the target `--out` path as the live database; it must construct a *brand-new* `SqliteStore` at a fresh path (which will run `migrate()` normally on construction, per the constructor pattern above), then insert the decrypted logical dump's rows. Require an explicit confirmation flag before allowing any operation that could touch a `--db` path that already exists (mirrors the destructive-mutation confirmation pattern discussed in RESEARCH.md's Security Domain table; look at `source-delete-command.ts` for the sibling destructive-command shape).

---

### `src/storage/sqlite-store.ts` (EXTEND) + `src/storage/schema-migrations.ts` (NEW)

**Analog:** itself — `migrate()` (`src/storage/sqlite-store.ts:1628-1892`) and the existing ad hoc versioned-migration precedent `migrateDaemonContractionPayloads()` (lines 1894-1930).

**Base-block idempotency pattern to preserve exactly** (`src/storage/sqlite-store.ts:1628-1630`):
```typescript
private migrate(): void {
  this.database.exec(`
    create table if not exists daemon_lease ( ... );
    create index if not exists idx_daemon_lease_heartbeat on daemon_lease (heartbeat_at, expires_at);
    -- ... ~20 more create-table-if-not-exists + create-index-if-not-exists statements ...
  `);
  this.migrateDaemonContractionPayloads();
}
```
Do not touch or reorder any existing `create table if not exists` statement. Append `runSchemaMigrations(this.database)` (from the new `schema-migrations.ts`, per RESEARCH.md Pattern 3) at the end of `migrate()`, after the base block. Consider converting `migrateDaemonContractionPayloads` itself into `MIGRATIONS` version 2 (RESEARCH.md explicitly recommends this — it currently reruns unconditionally on every open).

**Transactional migration pattern to copy** (`src/storage/sqlite-store.ts:1894-1930`, `migrateDaemonContractionPayloads`):
```typescript
private migrateDaemonContractionPayloads(): void {
  this.database.exec("begin immediate");
  try {
    // ... prepare/select/update statements ...
    this.database.exec("commit");
  } catch (error) {
    this.database.exec("rollback");
    throw error;
  }
}
```
Every entry in the new `MIGRATIONS` array's `apply()` (RESEARCH.md Pattern 3 code block) must follow this exact `begin immediate` / `commit` / `rollback` shape — this is the established transactional-write convention throughout `sqlite-store.ts` (also used by `acquireDaemonLease`, `reconcileDaemonSourceStates` per RESEARCH.md Pitfall 3).

**Full `runSchemaMigrations` design:** see RESEARCH.md Pattern 3 (lines 217-259 of RESEARCH.md) — this is a complete, ready-to-copy implementation; no further code discovery needed.

---

### `src/operations/tune-command.ts` (controller, CRUD config write)

**Analog:** `src/imports/source-revoke-command.ts` (single-flag mutation command, full file)

Same `parseArgs`/service-call/`main(argv)` shape. Exact knob set is an open planning decision (RESEARCH.md Open Question 4); default candidates: `busy_timeout` (already a `SqliteStoreOptions` field — see `src/storage/sqlite-store.ts:137`, just needs CLI exposure), retrieval result-limit/token-budget defaults (already bounded in `read-tools.ts` schemas), and a manual `REINDEX`/`ANALYZE` trigger.

## Shared Patterns

### Command module contract (imports, auth, error handling — applies to ALL new CLI commands)
**Source:** `src/bootstrap/status-command.ts:1-9` (imports), `172-201` (parseArgs/main/guard)
**Apply to:** every new command module (`init`, `explain`, `audit-log`, `backup`, `restore`, `export`, `migrate`-status, `tune`)
```typescript
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { SqliteStore } from "../storage/sqlite-store.js";

function parseArgs(args: string[]): SomeOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--") && arg.includes("=")) {
      const separator = arg.indexOf("=");
      values.set(arg.slice(0, separator), arg.slice(separator + 1));
    } else if (arg.startsWith("--") && args[index + 1]) {
      values.set(arg, args[index + 1]);
      index += 1;
    }
  }
  // ... required-flag checks throw plain Error with a usage hint ...
}

async function main(argv: string[]): Promise<void> {
  const result = await runSomeCommand(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
export { main };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
```

### Store open/close discipline
**Source:** `src/bootstrap/status-command.ts:123-169`, `src/imports/source-revoke-command.ts:13-25`
**Apply to:** every command that touches `SqliteStore` directly
```typescript
const store = new SqliteStore(parsed.databasePath /*, { readOnly: true } for read-only commands */);
try {
  // ... work ...
} finally {
  store.close();
}
```

### Zod strict options schema
**Source:** `src/bootstrap/status-command.ts:30-33`, `src/mcp/tools/read-tools.ts:9-50` (`.strict()` throughout)
**Apply to:** every new command's options type and every new MCP tool's input/output schema
```typescript
const OptionsSchema = z.object({
  databasePath: z.string().min(1),
  personId: z.string().min(1)
});
```

### MCP read-tool registration + authority gating
**Source:** `src/mcp/tools/read-tools.ts:204-282` (registration), `src/mcp/authority.ts:3-12` (`ProfileAuthority`)
**Apply to:** `memory_explain` tool only (the sole new MCP surface this phase adds)
```typescript
server.registerTool(
  "<name>",
  { title: "...", description: "...", inputSchema, outputSchema, annotations: MEMORY_READ_TOOL_ANNOTATIONS },
  async (input) => safeRead(() => application.<service>.<method>(input))
);
```

### Crypto domain separation
**Source:** `src/sync/crypto/libsodium-crypto-provider.ts:152-215`, `src/sync/crypto/crypto-provider.ts:35-119`
**Apply to:** `backup-crypto.ts` only
Reuse `ARGON2ID_REVIEWED_FLOOR`, `aeadSeal`/`aeadOpen`, `randomBytes`, `canonicalBytes` from `CryptoProvider`. Never call `wrapWithPassphrase`/`unwrapWithPassphrase` from backup code. Use a distinct AAD domain string (`"cms.backup.v1/passphrase-package"`).

### Transactional multi-statement writes
**Source:** `src/storage/sqlite-store.ts:1894-1930` (`migrateDaemonContractionPayloads`)
**Apply to:** `schema-migrations.ts` (`MIGRATIONS[n].apply`), and any backup/restore step that writes multiple rows
```typescript
this.database.exec("begin immediate");
try {
  // ... writes ...
  this.database.exec("commit");
} catch (error) {
  this.database.exec("rollback");
  throw error;
}
```

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `bin/memory` (shim executable) | config | — | No prior `bin` entry point exists in this repo (`package.json`'s `bin` field is currently empty); this is genuinely new plumbing. See RESEARCH.md Pitfall 6 for the shebang decision the planner must make explicit (tsx-shim vs. compiled JS). |
| DB file-size / WAL sidecar reading for health surface | utility | file-I/O | No existing precedent reads `node:fs.statSync` against the SQLite file or its `-wal`/`-shm` sidecars in this repo; RESEARCH.md's "Reading the DB file size" code example is the only guidance — treat it as the pattern source instead of a codebase analog. |

## Metadata

**Analog search scope:** `src/bootstrap/`, `src/imports/`, `src/daemon/`, `src/mcp/`, `src/sync/crypto/`, `src/storage/`
**Files scanned:** `src/bootstrap/status-command.ts`, `src/imports/source-revoke-command.ts`, `src/imports/source-delete-command.ts`, `src/daemon/daemon-command.ts`, `src/mcp/tools/read-tools.ts`, `src/mcp/tool-catalog.ts`, `src/mcp/authority.ts`, `src/sync/crypto/libsodium-crypto-provider.ts`, `src/sync/crypto/crypto-provider.ts`, `src/storage/sqlite-store.ts` (migrate + migrateDaemonContractionPayloads sections), plus a directory listing of all 19 `*-command.ts` files
**Pattern extraction date:** 2026-07-20
