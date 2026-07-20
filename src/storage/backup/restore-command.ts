import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { SqliteStore } from "../sqlite-store.js";
import { MIGRATIONS } from "../schema-migrations.js";
import { LibsodiumCryptoProvider } from "../../sync/crypto/libsodium-crypto-provider.js";
import { openBackup } from "./backup-crypto.js";
import { applyLogicalDump, readLogicalDumpHeader } from "./backup-command.js";

/**
 * Safe-by-construction restore (D-07, T-07-20). Restore NEVER opens an
 * existing `--db` target for in-place writing: it only ever creates a
 * brand-new `SqliteStore` at `--out` (which runs `migrate()` normally on
 * construction, bringing the target to the latest known schema) and then
 * replays the decrypted logical dump into it. If `--out` already exists, an
 * explicit `--confirm-overwrite <out-path>` flag (mirroring
 * `source-delete-command.ts`'s destructive-confirmation shape — the caller
 * must repeat the exact target path) is required before anything is
 * touched. A backup whose embedded schema version is newer than this
 * binary's latest known migration is refused before any file is created.
 */

const CURRENT_KNOWN_SCHEMA_VERSION = Math.max(...MIGRATIONS.map((migration) => migration.version));

const RunRestoreOptionsSchema = z.object({
  backupPath: z.string().min(1),
  outPath: z.string().min(1),
  passphrase: z.string().min(1),
  confirmOverwrite: z.string().min(1).optional()
});

export interface RunRestoreCommandOptions {
  backupPath: string;
  outPath: string;
  passphrase: string;
  /** Must exactly equal `outPath` to permit restoring over an already-existing file at that path. */
  confirmOverwrite?: string;
}

export interface RunRestoreCommandResult {
  ok: true;
  rowCount: number;
  schemaVersion: number;
}

export async function runRestoreCommand(options: RunRestoreCommandOptions): Promise<RunRestoreCommandResult> {
  const parsed = RunRestoreOptionsSchema.parse({
    backupPath: options.backupPath,
    outPath: options.outPath,
    passphrase: options.passphrase,
    confirmOverwrite: options.confirmOverwrite
  });

  const envelopeRaw = JSON.parse(await readFile(parsed.backupPath, "utf8"));
  const provider = new LibsodiumCryptoProvider();
  await provider.ready();
  // Decrypt-time failure is content-free and uniform, and happens before any
  // application state (files, tables) is touched.
  const dumpBytes = openBackup(provider, parsed.passphrase, envelopeRaw);

  const header = readLogicalDumpHeader(dumpBytes);
  if (header.schemaVersion > CURRENT_KNOWN_SCHEMA_VERSION) {
    throw new Error(
      `Backup schema version ${header.schemaVersion} is newer than the latest schema version this build understands (${CURRENT_KNOWN_SCHEMA_VERSION}). Refusing to restore.`
    );
  }

  const outExists = existsSync(parsed.outPath);
  if (outExists && parsed.confirmOverwrite !== parsed.outPath) {
    throw new Error(
      `Restore target already exists: ${parsed.outPath}. Pass --confirm-overwrite <exact-same-path> to confirm restoring over it. Restore never writes to a live --db in place.`
    );
  }
  if (outExists) {
    // Confirmed: fully replace the existing file (and WAL/SHM sidecars)
    // rather than merging rows into whatever it already contained.
    for (const path of [parsed.outPath, `${parsed.outPath}-wal`, `${parsed.outPath}-shm`]) {
      await rm(path, { force: true });
    }
  }

  // Creates the target file and runs migrate() normally, bringing it to
  // CURRENT_KNOWN_SCHEMA_VERSION before any row is inserted.
  const freshStore = new SqliteStore(parsed.outPath);
  freshStore.close();

  const database = openRawWritableDatabase(parsed.outPath);
  let rowCount: number;
  try {
    ({ rowCount } = applyLogicalDump(database, dumpBytes));
  } finally {
    database.close();
  }

  return { ok: true, rowCount, schemaVersion: header.schemaVersion };
}

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

function openRawWritableDatabase(location: string): RawDatabase {
  return new DatabaseSync(location, { readOnly: false });
}

function parseArgs(args: string[]): RunRestoreCommandOptions {
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
  const backupPath = values.get("--backup");
  const outPath = values.get("--out");
  const passphrase = values.get("--passphrase");
  const confirmOverwrite = values.get("--confirm-overwrite");
  if (!backupPath) throw new Error("Missing backup file path. Pass --backup <path>.");
  if (!outPath) throw new Error("Missing restore output path. Pass --out <path>.");
  if (!passphrase) throw new Error("Missing backup passphrase. Pass --passphrase <value>.");
  const resolvedOut = resolve(outPath);
  return {
    backupPath: resolve(backupPath),
    outPath: resolvedOut,
    passphrase,
    confirmOverwrite: confirmOverwrite ? resolve(confirmOverwrite) : undefined
  };
}

export async function main(argv: string[]): Promise<void> {
  const result = await runRestoreCommand(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
