import { createRequire } from "node:module";
import { lstat, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { historyCandidateId } from "./file-history-utils.js";
import {
  HermesHistoryApprovalSchema,
  HermesHistoryCandidateSchema,
  type HermesHistoryApproval,
  type HermesHistoryCandidate
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

export function hermesCandidateId(databasePath: string): string {
  return historyCandidateId("hermes", databasePath);
}

export async function resolveHermesDatabasePath(inputPath: string): Promise<string> {
  const absolute = resolve(inputPath);
  const metadata = await lstat(absolute);
  return realpath(metadata.isDirectory() ? join(absolute, "state.db") : absolute);
}

export async function discoverHermesHistory(
  inputPath: string,
  discoveredAt = new Date().toISOString()
): Promise<HermesHistoryCandidate> {
  const databasePath = await resolveHermesDatabasePath(inputPath);
  const metadata = await lstat(databasePath);
  if (!metadata.isFile()) throw new Error("Hermes history source is not a regular SQLite file");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assertHermesSchema(database);
    const row = database.prepare(
      "select count(*) as count, min(started_at) as earliest, max(started_at) as latest from sessions"
    ).get() as { count: number; earliest: number | null; latest: number | null };
    return HermesHistoryCandidateSchema.parse({
      id: hermesCandidateId(databasePath),
      application: "hermes",
      format: "hermes-state-sqlite",
      databasePath,
      sessionCount: Number(row.count),
      estimatedBytes: metadata.size,
      earliestSessionAt: epochToIso(row.earliest),
      latestSessionAt: epochToIso(row.latest),
      discoveredAt
    });
  } finally {
    database.close();
  }
}

export function approveHermesHistory(
  candidate: HermesHistoryCandidate,
  personId: string,
  profileId: string,
  approvedAt = new Date().toISOString(),
  scopeId = "personal"
): HermesHistoryApproval {
  const parsed = HermesHistoryCandidateSchema.parse(candidate);
  return HermesHistoryApprovalSchema.parse({
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

export function openHermesReadonlyDatabase(databasePath: string): ReadonlyDatabase {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  assertHermesSchema(database);
  return database;
}

function assertHermesSchema(database: ReadonlyDatabase): void {
  const tables = database.prepare(
    "select name from sqlite_master where type = 'table' and name in ('sessions', 'messages')"
  ).all() as { name: string }[];
  if (new Set(tables.map((row) => row.name)).size !== 2) {
    throw new Error("Unsupported Hermes database: sessions/messages tables are required");
  }
  const messageColumns = new Set(
    (database.prepare("pragma table_info(messages)").all() as { name: string }[])
      .map((row) => row.name)
  );
  for (const required of ["id", "session_id", "role", "content", "timestamp"]) {
    if (!messageColumns.has(required)) {
      throw new Error(`Unsupported Hermes database: messages.${required} is required`);
    }
  }
  const sessionColumns = new Set(
    (database.prepare("pragma table_info(sessions)").all() as { name: string }[])
      .map((row) => row.name)
  );
  for (const required of ["id", "source", "started_at"]) {
    if (!sessionColumns.has(required)) {
      throw new Error(`Unsupported Hermes database: sessions.${required} is required`);
    }
  }
}

function epochToIso(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  return new Date(value > 1_000_000_000_000 ? value : value * 1000).toISOString();
}

export function hermesResourceName(databasePath: string): string {
  return basename(databasePath);
}
