import { createRequire } from "node:module";
import { open, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { SqliteStore } from "../sqlite-store.js";
import { LibsodiumCryptoProvider } from "../../sync/crypto/libsodium-crypto-provider.js";
import { sealBackup } from "./backup-crypto.js";

/**
 * Encrypted-by-default backup command (D-07). Opens the live database
 * read-only (no side effects, `migrate()` is skipped entirely), builds a
 * schema-versioned logical dump of every application table, seals it under
 * the `cms.backup.v1` domain (see `backup-crypto.ts`), and writes the result
 * atomically (temp file in the same directory, fsync, rename) so a killed
 * process can never leave a truncated backup file mistaken for a real one
 * (07-RESEARCH.md Pitfall 2).
 */

export const LOGICAL_DUMP_FORMAT = "cms.backup.dump.v1";

interface RawStatement {
  all(...parameters: unknown[]): unknown[];
  get(...parameters: unknown[]): unknown;
  run(...parameters: unknown[]): void;
}

interface RawDatabase {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): RawStatement;
}

interface RawDatabaseConstructor {
  new (location: string, options?: { readOnly?: boolean; timeout?: number }): RawDatabase;
}

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: RawDatabaseConstructor };

/** Tables that are runtime/migration bookkeeping, not application data — never included in a logical dump; a fresh restore target recreates them via its own `migrate()`. */
const EXCLUDED_TABLES = new Set(["schema_migrations"]);

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function openRawDatabase(location: string, readOnly: boolean): RawDatabase {
  return new DatabaseSync(location, { readOnly });
}

function listApplicationTableNames(database: RawDatabase): string[] {
  const rows = database
    .prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name).filter((name) => !EXCLUDED_TABLES.has(name));
}

function tableColumns(database: RawDatabase, table: string): string[] {
  const rows = database.prepare(`pragma table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

/**
 * Builds a newline-delimited JSON logical dump: a header line followed by
 * one line per row across every application table, in a fixed
 * schema-versioned envelope. Restore replays this into a freshly migrated
 * database rather than requiring exact on-disk SQLite fidelity, decoupling
 * the backup format from SQLite's own file format (07-RESEARCH.md Open
 * Question 1, resolved).
 */
export function buildLogicalDump(database: RawDatabase, schemaVersion: number, generatedAt: string): Uint8Array {
  const lines: string[] = [
    JSON.stringify({ kind: "header", format: LOGICAL_DUMP_FORMAT, schemaVersion, generatedAt })
  ];
  for (const table of listApplicationTableNames(database)) {
    const columns = tableColumns(database, table);
    const rows = database.prepare(`select * from ${quoteIdentifier(table)} order by rowid`).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      lines.push(JSON.stringify({ kind: "row", table, values: columns.map((column) => row[column] ?? null) }));
    }
  }
  return new TextEncoder().encode(lines.join("\n"));
}

export interface LogicalDumpHeader {
  schemaVersion: number;
  generatedAt: string;
}

/** Parses only the header line of a logical dump without applying any rows — used by restore's pre-write schema-version guard. */
export function readLogicalDumpHeader(dumpBytes: Uint8Array): LogicalDumpHeader {
  const text = new TextDecoder().decode(dumpBytes);
  const firstLine = text.split("\n").find((line) => line.trim().length > 0);
  if (!firstLine) {
    throw new Error("Malformed backup dump: empty payload");
  }
  const header = JSON.parse(firstLine) as { kind?: unknown; format?: unknown; schemaVersion?: unknown; generatedAt?: unknown };
  if (header.kind !== "header" || header.format !== LOGICAL_DUMP_FORMAT || typeof header.schemaVersion !== "number" || typeof header.generatedAt !== "string") {
    throw new Error("Malformed backup dump: invalid header");
  }
  return { schemaVersion: header.schemaVersion, generatedAt: header.generatedAt };
}

/**
 * Replays a logical dump into `database` (expected to already have every
 * table created by a fresh `SqliteStore` migration). Table names in the dump
 * are validated against `database`'s own current table set before any
 * insert runs (defense in depth against a malicious/self-crafted dump,
 * T-07-19) — an unrecognized table name aborts the whole transaction rather
 * than attempting a dynamic insert against an unknown identifier.
 */
export function applyLogicalDump(database: RawDatabase, dumpBytes: Uint8Array): { rowCount: number } {
  const text = new TextDecoder().decode(dumpBytes);
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    throw new Error("Malformed backup dump: empty payload");
  }
  const header = JSON.parse(lines[0]!) as { kind?: unknown; format?: unknown };
  if (header.kind !== "header" || header.format !== LOGICAL_DUMP_FORMAT) {
    throw new Error("Malformed backup dump: invalid header");
  }
  const knownTables = new Set(listApplicationTableNames(database));
  const insertStatements = new Map<string, RawStatement>();

  database.exec("begin immediate");
  try {
    let rowCount = 0;
    for (let index = 1; index < lines.length; index += 1) {
      const entry = JSON.parse(lines[index]!) as { kind?: unknown; table?: unknown; values?: unknown };
      if (entry.kind !== "row") continue;
      if (typeof entry.table !== "string" || !knownTables.has(entry.table) || !Array.isArray(entry.values)) {
        throw new Error("Malformed backup dump: unrecognized row entry");
      }
      let statement = insertStatements.get(entry.table);
      if (!statement) {
        const columns = tableColumns(database, entry.table);
        const placeholders = columns.map(() => "?").join(", ");
        statement = database.prepare(
          `insert into ${quoteIdentifier(entry.table)} (${columns.map(quoteIdentifier).join(", ")}) values (${placeholders})`
        );
        insertStatements.set(entry.table, statement);
      }
      statement.run(...entry.values);
      rowCount += 1;
    }
    database.exec("commit");
    return { rowCount };
  } catch (error) {
    database.exec("rollback");
    throw error;
  }
}

async function atomicWriteFile(finalPath: string, contents: string): Promise<void> {
  const tmpPath = `${finalPath}.tmp`;
  const handle = await open(tmpPath, "w");
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmpPath, finalPath);
}

const RunBackupOptionsSchema = z.object({
  databasePath: z.string().min(1),
  outPath: z.string().min(1),
  passphrase: z.string().min(1)
});

export interface RunBackupCommandOptions {
  databasePath: string;
  outPath: string;
  passphrase: string;
  now?: string;
}

export interface RunBackupCommandResult {
  ok: true;
  /** Content-free receipt: byte count only, never paths/keys/content. */
  bytesWritten: number;
}

export async function runBackupCommand(options: RunBackupCommandOptions): Promise<RunBackupCommandResult> {
  const parsed = RunBackupOptionsSchema.parse({
    databasePath: options.databasePath,
    outPath: options.outPath,
    passphrase: options.passphrase
  });
  const now = options.now ?? new Date().toISOString();

  const readOnlyStore = new SqliteStore(parsed.databasePath, { readOnly: true });
  let schemaVersion: number;
  try {
    schemaVersion = readOnlyStore.getSchemaVersion();
  } finally {
    readOnlyStore.close();
  }

  const rawDatabase = openRawDatabase(parsed.databasePath, true);
  let dumpBytes: Uint8Array;
  try {
    dumpBytes = buildLogicalDump(rawDatabase, schemaVersion, now);
  } finally {
    rawDatabase.close();
  }

  const provider = new LibsodiumCryptoProvider();
  await provider.ready();
  const envelope = sealBackup(provider, parsed.passphrase, dumpBytes, schemaVersion, now);

  const serialized = JSON.stringify(envelope);
  await atomicWriteFile(parsed.outPath, serialized);

  return { ok: true, bytesWritten: Buffer.byteLength(serialized, "utf8") };
}

function parseArgs(args: string[]): RunBackupCommandOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith("--") && arg.includes("=")) {
      const separator = arg.indexOf("=");
      values.set(arg.slice(0, separator), arg.slice(separator + 1));
    } else if (arg.startsWith("--") && args[index + 1]) {
      values.set(arg, args[index + 1]!);
      index += 1;
    }
  }
  const databasePath = values.get("--db");
  const outPath = values.get("--out");
  const passphrase = values.get("--passphrase");
  if (!databasePath) throw new Error("Missing memory database path. Pass --db <path>.");
  if (!outPath) throw new Error("Missing backup output path. Pass --out <path>.");
  if (!passphrase) throw new Error("Missing backup passphrase. Pass --passphrase <value>.");
  return { databasePath: resolve(databasePath), outPath: resolve(outPath), passphrase };
}

export async function main(argv: string[]): Promise<void> {
  const result = await runBackupCommand(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
