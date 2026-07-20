import { createRequire } from "node:module";
import { open, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { SqliteStore } from "../sqlite-store.js";
import { buildLogicalDump } from "./backup-command.js";

/**
 * `export --plaintext` escape hatch (D-07b, T-07-18). Reads the SAME
 * read-only logical-dump path as `backup-command.ts` but skips encryption
 * entirely, writing an inspectable plaintext JSON file. This is deliberately
 * NOT the default (`memory backup` alone is always encrypted): reaching this
 * command requires the caller to pass the literal `--plaintext` flag, and it
 * prints an explicit stderr warning before writing so the resulting file is
 * never mistaken for the encrypted backup.
 */

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

async function atomicWriteFile(finalPath: string, contents: Uint8Array): Promise<void> {
  const tmpPath = `${finalPath}.tmp`;
  const handle = await open(tmpPath, "w");
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmpPath, finalPath);
}

const RunExportPlaintextOptionsSchema = z.object({
  databasePath: z.string().min(1),
  outPath: z.string().min(1),
  plaintext: z.literal(true)
});

export interface RunExportPlaintextCommandOptions {
  databasePath: string;
  outPath: string;
  /** Must be explicitly `true`; there is no default/implicit way to reach this command. */
  plaintext: boolean;
  now?: string;
}

export interface RunExportPlaintextCommandResult {
  ok: true;
  bytesWritten: number;
}

export async function runExportPlaintextCommand(
  options: RunExportPlaintextCommandOptions
): Promise<RunExportPlaintextCommandResult> {
  if (options.plaintext !== true) {
    throw new Error(
      "Plaintext export requires the explicit --plaintext flag. `memory backup` alone is always encrypted; there is no plaintext-by-default path."
    );
  }
  const parsed = RunExportPlaintextOptionsSchema.parse({
    databasePath: options.databasePath,
    outPath: options.outPath,
    plaintext: options.plaintext
  });
  const now = options.now ?? new Date().toISOString();

  process.stderr.write(
    "WARNING: writing an UNENCRYPTED plaintext export. This file contains your full memory database in the clear — " +
      "anyone who obtains it can read everything. Prefer `memory backup` (encrypted) unless you specifically need a " +
      "plaintext dump for migration/inspection.\n"
  );

  const readOnlyStore = new SqliteStore(parsed.databasePath, { readOnly: true });
  let schemaVersion: number;
  try {
    schemaVersion = readOnlyStore.getSchemaVersion();
  } finally {
    readOnlyStore.close();
  }

  const database = new DatabaseSync(parsed.databasePath, { readOnly: true });
  let dumpBytes: Uint8Array;
  try {
    dumpBytes = buildLogicalDump(database, schemaVersion, now);
  } finally {
    database.close();
  }

  await atomicWriteFile(parsed.outPath, dumpBytes);
  return { ok: true, bytesWritten: dumpBytes.byteLength };
}

function parseArgs(args: string[]): RunExportPlaintextCommandOptions {
  const values = new Map<string, string>();
  let plaintextFlag = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--plaintext") {
      plaintextFlag = true;
      continue;
    }
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
  if (!databasePath) throw new Error("Missing memory database path. Pass --db <path>.");
  if (!outPath) throw new Error("Missing export output path. Pass --out <path>.");
  if (!plaintextFlag) {
    throw new Error(
      "Plaintext export requires the explicit --plaintext flag. `memory backup` alone is always encrypted; there is no plaintext-by-default path."
    );
  }
  return { databasePath: resolve(databasePath), outPath: resolve(outPath), plaintext: true };
}

export async function main(argv: string[]): Promise<void> {
  const result = await runExportPlaintextCommand(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
