import { statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { SqliteStore } from "../storage/sqlite-store.js";

/**
 * `memory prune-unhygienic-anchors` (REQ-052/REQ-053/REQ-054, GAP-11-D closure, Plan 11-17). The
 * operator command that will be pointed at the live corpus's 25,792+ (floor, not a target -- ADR
 * 0051) tool_activity / synthetic_injected anchors the forward-gated `AnchorDetector.detectForTurn`
 * would never have created since it started refusing them.
 *
 * The command owns NO deletion SQL. Every removal goes through
 * `store.commitUnhygienicAnchorPrune`, which recomputes eligibility authoritatively inside its own
 * transaction (Plan 11-16) from the anchor's persisted content plus its resolved canonical event's
 * role/eventKind -- this command's job is paging, gating, accumulation, and reporting.
 *
 * `listAnchorIds` is person-scoped, so the apply loop's cursor walks exactly ONE person's anchors;
 * it structurally cannot reach a second person's rows. `person_mismatch` / `person_unattributed`
 * remain live refusal paths at the store level (the commit method takes an untrusted id list), but
 * this command's own cursor never produces them.
 *
 * Resumability comes from the id-ascending cursor over LIVE state, not a checkpoint table: each
 * page re-queries `listAnchorIds`, so an interrupted run simply resumes where the data is -- a
 * still-unhygienic anchor shows up again, an already-pruned one does not. Do not add a checkpoint
 * row here; it would be redundant with the cursor and could itself drift from reality.
 *
 * Safety properties, mirroring `prune-superseded-command.ts`:
 *   - Dry-run is the DEFAULT. `--apply` is required to delete anything (T-11-66).
 *   - The backup gate FAILS CLOSED: `--apply` additionally requires `--confirm-backup <path>`,
 *     verified via `statSync` to exist, be a regular file, and be non-empty (T-11-67).
 *   - The cursor advances to the highest id in each page regardless of skips, so a
 *     retained-conversational anchor at the head of the cursor can never wedge the loop (T-11-68).
 */
const OptionsSchema = z
  .object({
    databasePath: z.string().min(1),
    personId: z.string().min(1),
    apply: z.boolean().optional(),
    confirmBackupPath: z.string().min(1).optional(),
    batchSize: z.number().int().positive().optional()
  })
  .strict();

export interface PruneUnhygienicAnchorsCommandOptions {
  databasePath: string;
  personId: string;
  apply?: boolean;
  confirmBackupPath?: string;
  batchSize?: number;
}

export interface PruneUnhygienicAnchorsCommandDeps {
  /** Called after each committed batch (the test's kill-simulation hook). */
  onBatchComplete?: (prunedCount: number) => void | Promise<void>;
  /** Progress line sink; defaults to process.stdout.write. */
  progressSink?: (line: string) => void;
}

export interface PruneUnhygienicAnchorsCommandResult {
  ok: true;
  applied: boolean;
  personId: string;
  totalCount: number;
  countsByClass: { conversational: number; tool_activity: number; synthetic_injected: number };
  unhygienicCount: number;
  unhygienicPayloadBytes: number;
  unattributedCount: number;
  prunedCount: number;
  prunedByClass: { tool_activity: number; synthetic_injected: number };
  skippedByReason: Record<string, number>;
  freedPayloadBytes: number;
  batches: number;
  backupPath?: string;
  backupBytes?: number;
}

const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 1000;

function resolveBatchSize(requested: number | undefined): number {
  return Math.min(requested ?? DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE);
}

function verifyBackup(confirmBackupPath: string): { backupPath: string; backupBytes: number } {
  const backupPath = resolve(confirmBackupPath);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(backupPath);
  } catch {
    throw new Error(`Backup path does not exist or is unreadable: ${backupPath}. Refusing to prune.`);
  }
  if (!stat.isFile()) {
    throw new Error(`Backup path is not a regular file: ${backupPath}. Refusing to prune.`);
  }
  if (stat.size === 0) {
    throw new Error(`Backup file is empty: ${backupPath}. Refusing to prune.`);
  }
  return { backupPath, backupBytes: stat.size };
}

async function summarize(store: SqliteStore, personId: string) {
  return store.summarizeAnchorDerivationClasses(personId);
}

async function runDryRun(store: SqliteStore, personId: string): Promise<PruneUnhygienicAnchorsCommandResult> {
  const summary = await summarize(store, personId);
  return {
    ok: true,
    applied: false,
    personId,
    totalCount: summary.totalCount,
    countsByClass: summary.countsByClass,
    unhygienicCount: summary.unhygienicCount,
    unhygienicPayloadBytes: summary.unhygienicPayloadBytes,
    unattributedCount: summary.unattributedCount,
    prunedCount: 0,
    prunedByClass: { tool_activity: 0, synthetic_injected: 0 },
    skippedByReason: {},
    freedPayloadBytes: 0,
    batches: 0
  };
}

async function runApply(
  store: SqliteStore,
  personId: string,
  batchSize: number,
  confirmBackupPath: string,
  deps: PruneUnhygienicAnchorsCommandDeps
): Promise<PruneUnhygienicAnchorsCommandResult> {
  const { backupPath, backupBytes } = verifyBackup(confirmBackupPath);
  const summary = await summarize(store, personId);
  const progressSink = deps.progressSink ?? ((line: string) => process.stdout.write(`${line}\n`));

  let afterId: string | undefined;
  let prunedCount = 0;
  let freedPayloadBytes = 0;
  let batches = 0;
  const prunedByClass = { tool_activity: 0, synthetic_injected: 0 };
  const skippedByReason: Record<string, number> = {};

  for (;;) {
    const page = await store.listAnchorIds(personId, { limit: batchSize, afterId });
    if (page.length === 0) break;

    const receipt = await store.commitUnhygienicAnchorPrune({
      operation: "unhygienic_anchor_prune",
      personId,
      anchorIds: page,
      requestedAt: new Date().toISOString()
    });

    prunedCount += receipt.prunedAnchorIds.length;
    prunedByClass.tool_activity += receipt.prunedByClass.tool_activity;
    prunedByClass.synthetic_injected += receipt.prunedByClass.synthetic_injected;
    freedPayloadBytes += receipt.freedPayloadBytes;
    for (const skip of receipt.skipped) {
      skippedByReason[skip.reason] = (skippedByReason[skip.reason] ?? 0) + 1;
    }
    batches += 1;

    // Advance past skipped ids to the highest id in the page, so a retained-conversational anchor
    // at the head of the cursor never wedges the loop (T-11-68).
    afterId = page[page.length - 1];

    progressSink(
      JSON.stringify({
        event: "progress",
        batches,
        prunedCount,
        freedPayloadBytes
      })
    );

    await deps.onBatchComplete?.(prunedCount);
  }

  return {
    ok: true,
    applied: true,
    personId,
    totalCount: summary.totalCount,
    countsByClass: summary.countsByClass,
    unhygienicCount: summary.unhygienicCount,
    unhygienicPayloadBytes: summary.unhygienicPayloadBytes,
    unattributedCount: summary.unattributedCount,
    prunedCount,
    prunedByClass,
    skippedByReason,
    freedPayloadBytes,
    batches,
    backupPath,
    backupBytes
  };
}

export async function runPruneUnhygienicAnchorsCommand(
  options: PruneUnhygienicAnchorsCommandOptions,
  deps: PruneUnhygienicAnchorsCommandDeps = {}
): Promise<PruneUnhygienicAnchorsCommandResult> {
  const parsed = OptionsSchema.parse(options);
  const databasePath = resolve(parsed.databasePath);
  const batchSize = resolveBatchSize(parsed.batchSize);

  const store = new SqliteStore(databasePath);
  try {
    // Fail loud for an unknown person rather than silently reporting a zero-candidate prune:
    // personId is bound in options and never inferred.
    if (!(await store.getPerson(parsed.personId))) {
      throw new Error(`Cannot prune unhygienic anchors for unknown person ${parsed.personId}`);
    }

    if (!parsed.apply) {
      return await runDryRun(store, parsed.personId);
    }

    if (!parsed.confirmBackupPath) {
      throw new Error(
        "Refusing to apply an unhygienic-anchor prune without a verified backup. Pass --confirm-backup <path-to-backup-file>."
      );
    }

    return await runApply(store, parsed.personId, batchSize, parsed.confirmBackupPath, deps);
  } finally {
    store.close();
  }
}

function parseArgs(args: string[]): PruneUnhygienicAnchorsCommandOptions {
  const values = new Map<string, string>();
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") {
      apply = true;
    } else if (arg.startsWith("--") && arg.includes("=")) {
      const separator = arg.indexOf("=");
      values.set(arg.slice(0, separator), arg.slice(separator + 1));
    } else if (arg.startsWith("--") && args[index + 1]) {
      values.set(arg, args[index + 1]);
      index += 1;
    }
  }
  const databasePath = values.get("--db");
  if (!databasePath) throw new Error("Missing memory database path. Pass --db <path>.");
  const personId = values.get("--person");
  if (!personId) throw new Error("Missing person identity. Pass --person <person-id>.");
  const batchSizeRaw = values.get("--batch-size");
  const batchSize = batchSizeRaw ? Number.parseInt(batchSizeRaw, 10) : undefined;
  return {
    databasePath: resolve(databasePath),
    personId,
    apply: apply || undefined,
    confirmBackupPath: values.get("--confirm-backup"),
    batchSize
  };
}

export async function main(argv: string[]): Promise<void> {
  const result = await runPruneUnhygienicAnchorsCommand(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
