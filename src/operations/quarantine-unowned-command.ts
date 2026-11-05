import { statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { isLegacyUnowned, LEGACY_UNOWNED_MARKER } from "./legacy-unowned.js";
import { SqliteStore } from "../storage/sqlite-store.js";

const OptionsSchema = z.object({
  databasePath: z.string().min(1),
  apply: z.boolean().optional(),
  confirmBackupPath: z.string().min(1).optional(),
  now: z.string().datetime().optional()
}).strict();

export interface QuarantineUnownedCommandOptions {
  databasePath: string;
  apply?: boolean;
  confirmBackupPath?: string;
  now?: string;
}

export interface QuarantineUnownedCommandResult {
  ok: true;
  applied: boolean;
  marker: typeof LEGACY_UNOWNED_MARKER;
  summaryIds: string[];
  boxIds: string[];
  traceIds: string[];
  anchorIds: string[];
  quarantinedSummaryIds: string[];
  quarantinedBoxIds: string[];
  quarantinedTraceIds: string[];
  quarantinedAnchorIds: string[];
  skipped: Array<{ kind: "summary" | "box" | "trace" | "anchor"; id: string; reason: string }>;
  backupPath?: string;
}

export async function quarantineUnownedLegacyRows(
  options: QuarantineUnownedCommandOptions
): Promise<QuarantineUnownedCommandResult> {
  const parsed = OptionsSchema.parse(options);
  if (parsed.apply) {
    if (!parsed.confirmBackupPath) {
      throw new Error("quarantine-unowned --apply requires --confirm-backup <path> to a non-empty backup file.");
    }
    const backup = statSync(parsed.confirmBackupPath);
    if (!backup.isFile() || backup.size < 1) {
      throw new Error("The confirmed backup must be a non-empty file. Refusing to quarantine unowned rows.");
    }
  }

  const store = new SqliteStore(parsed.databasePath, { readOnly: parsed.apply !== true });
  try {
    const summaryIds = (await store.listSummaries()).filter(isLegacyUnowned).map((row) => row.id);
    const boxIds = (await store.listBoxes()).filter(isLegacyUnowned).map((row) => row.id);
    const traceIds = (await store.listTraces()).filter(isLegacyUnowned).map((row) => row.id);
    const anchorIds = (await store.listAnchors()).filter(isLegacyUnowned).map((row) => row.id);
    if (!parsed.apply) {
      return {
        ok: true,
        applied: false,
        marker: LEGACY_UNOWNED_MARKER,
        summaryIds,
        boxIds,
        traceIds,
        anchorIds,
        quarantinedSummaryIds: [],
        quarantinedBoxIds: [],
        quarantinedTraceIds: [],
        quarantinedAnchorIds: [],
        skipped: []
      };
    }

    const requestedAt = parsed.now ?? new Date().toISOString();
    const skipped: QuarantineUnownedCommandResult["skipped"] = [];
    const quarantinedSummaryIds: string[] = [];
    const quarantinedBoxIds: string[] = [];
    const quarantinedTraceIds: string[] = [];
    const quarantinedAnchorIds: string[] = [];
    const width = Math.max(summaryIds.length, boxIds.length, traceIds.length, anchorIds.length);
    for (let index = 0; index < width; index += 1000) {
      const receipt = await store.commitLegacyUnownedQuarantine({
        operation: "legacy_unowned_quarantine",
        summaryIds: summaryIds.slice(index, index + 1000),
        boxIds: boxIds.slice(index, index + 1000),
        traceIds: traceIds.slice(index, index + 1000),
        anchorIds: anchorIds.slice(index, index + 1000),
        requestedAt
      });
      quarantinedSummaryIds.push(...receipt.quarantinedSummaryIds);
      quarantinedBoxIds.push(...receipt.quarantinedBoxIds);
      quarantinedTraceIds.push(...receipt.quarantinedTraceIds);
      quarantinedAnchorIds.push(...receipt.quarantinedAnchorIds);
      skipped.push(...receipt.skipped);
    }
    return {
      ok: true,
      applied: true,
      marker: LEGACY_UNOWNED_MARKER,
      summaryIds,
      boxIds,
      traceIds,
      anchorIds,
      quarantinedSummaryIds,
      quarantinedBoxIds,
      quarantinedTraceIds,
      quarantinedAnchorIds,
      skipped,
      backupPath: parsed.confirmBackupPath
    };
  } finally {
    store.close();
  }
}

function parseArgs(argv: string[]): QuarantineUnownedCommandOptions {
  const options: Partial<QuarantineUnownedCommandOptions> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db" && argv[index + 1]) {
      options.databasePath = resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg?.startsWith("--db=")) {
      options.databasePath = resolve(arg.slice("--db=".length));
      continue;
    }
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--confirm-backup" && argv[index + 1]) {
      options.confirmBackupPath = resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg?.startsWith("--confirm-backup=")) {
      options.confirmBackupPath = resolve(arg.slice("--confirm-backup=".length));
    }
  }
  if (!options.databasePath) {
    throw new Error("Missing database path. Pass --db <path>.");
  }
  return { databasePath: options.databasePath, apply: options.apply, confirmBackupPath: options.confirmBackupPath };
}

export async function main(argv: string[]): Promise<void> {
  const result = await quarantineUnownedLegacyRows(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
