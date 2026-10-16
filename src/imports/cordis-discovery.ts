import { createRequire } from "node:module";
import { lstat, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { historyCandidateId } from "./file-history-utils.js";
import {
  CordisHistoryApprovalSchema,
  CordisHistoryCandidateSchema,
  type CordisHistoryApproval,
  type CordisHistoryCandidate
} from "./types.js";

interface StatementSync {
  all(...parameters: unknown[]): unknown[];
  get(...parameters: unknown[]): unknown;
}

interface ReadonlyDatabase {
  close(): void;
  prepare(sql: string): StatementSync;
}

interface ReadonlyDatabaseConstructor {
  new (location: string, options: { readOnly: boolean }): ReadonlyDatabase;
}

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: ReadonlyDatabaseConstructor };

export function cordisCandidateId(databasePath: string): string {
  return historyCandidateId("cordis", databasePath);
}

export function openCordisReadonlyDatabase(databasePath: string): ReadonlyDatabase {
  return new DatabaseSync(databasePath, { readOnly: true });
}

export async function resolveCordisDatabasePath(inputPath: string): Promise<string> {
  const absolute = resolve(inputPath);
  const metadata = await lstat(absolute);
  return realpath(metadata.isDirectory() ? join(absolute, "journal.sqlite") : absolute);
}

export async function discoverCordisHistory(
  inputPath: string,
  discoveredAt = new Date().toISOString()
): Promise<CordisHistoryCandidate> {
  const databasePath = await resolveCordisDatabasePath(inputPath);
  const metadata = await lstat(databasePath);
  if (!metadata.isFile()) throw new Error("Cordis journal source is not a regular SQLite file");
  const database = openCordisReadonlyDatabase(databasePath);
  try {
    assertCordisSchema(database);
    const row = database.prepare(
      "select count(distinct session_key) as count, min(created_at) as earliest, max(created_at) as latest from journal"
    ).get() as { count: number; earliest: string | null; latest: string | null };
    return CordisHistoryCandidateSchema.parse({
      id: cordisCandidateId(databasePath),
      application: "cordis",
      format: "cordis-journal-sqlite",
      databasePath,
      sessionCount: Number(row.count),
      estimatedBytes: metadata.size,
      earliestSessionAt: row.earliest,
      latestSessionAt: row.latest,
      discoveredAt
    });
  } finally {
    database.close();
  }
}

export function approveCordisHistory(
  candidate: CordisHistoryCandidate,
  personId: string,
  profileId: string,
  approvedAt = new Date().toISOString(),
  scopeId = "personal"
): CordisHistoryApproval {
  const parsed = CordisHistoryCandidateSchema.parse(candidate);
  return CordisHistoryApprovalSchema.parse({
    candidateId: parsed.id,
    personId,
    application: parsed.application,
    format: parsed.format,
    databasePath: parsed.databasePath,
    profileId,
    scopeId,
    approvedAt
  });
}

export function cordisResourceName(databasePath: string): string {
  return basename(databasePath);
}

function assertCordisSchema(database: ReadonlyDatabase): void {
  const tables = new Set(
    (database.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[])
      .map((row) => row.name)
  );
  if (!tables.has("journal")) throw new Error("Cordis journal is missing the journal table");
  const columns = new Set(
    (database.prepare("pragma table_info(journal)").all() as { name: string }[]).map((row) => row.name)
  );
  for (const column of ["seq", "session_key", "kind", "origin", "schema_version", "payload", "created_at"]) {
    if (!columns.has(column)) throw new Error(`Cordis journal is missing column ${column}`);
  }
}
