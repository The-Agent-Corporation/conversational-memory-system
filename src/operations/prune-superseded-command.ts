import { statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { SqliteStore } from "../storage/sqlite-store.js";

/**
 * `memory prune-superseded` (REQ-052/REQ-053/REQ-054, GAP-11-A closure, Plan 11-12). The operator
 * command that will be pointed at the live corpus's 87,727 superseded rows (~155 MB) left behind
 * by the Phase 11 derivation-hygiene rebuild — pure derivations, fully reproducible from the
 * immutable canonical timeline via `memory rebuild-derivations` (see ADR 0050).
 *
 * The command owns NO deletion SQL. Every removal goes through
 * `store.commitSupersededSummaryPrune`, which recomputes eligibility authoritatively inside its own
 * transaction (Plan 11-11) — this command's job is paging, gating, accumulation, and reporting.
 *
 * Resumability comes from the id-ascending cursor over LIVE state, not a checkpoint table: each
 * page re-queries `listSupersededSummaryIds`, so an interrupted run simply resumes where the data
 * is — a still-superseded row shows up again, an already-pruned row does not. Do not add a
 * checkpoint row here; it would be redundant with the cursor and could itself drift from reality.
 *
 * Safety properties this command adds beyond `rebuild-derivations`' resumable/checkpointed shape:
 *   - Dry-run is the DEFAULT. `--apply` is required to delete anything (T-11-41).
 *   - The backup gate FAILS CLOSED: `--apply` additionally requires `--confirm-backup <path>`,
 *     verified via `statSync` to exist, be a regular file, and be non-empty (T-11-42).
 *   - The cursor advances to the highest id in each page regardless of skips, so a referenced
 *     summary at the head of the cursor can never wedge the loop (T-11-43).
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

export interface PruneSupersededCommandOptions {
  databasePath: string;
  personId: string;
  apply?: boolean;
  confirmBackupPath?: string;
  batchSize?: number;
}

export interface PruneSupersededCommandDeps {
  /** Called after each committed batch (the test's kill-simulation hook). */
  onBatchComplete?: (prunedCount: number) => void | Promise<void>;
  /** Progress line sink; defaults to process.stdout.write. */
  progressSink?: (line: string) => void;
}

export interface PruneSupersededCommandResult {
  ok: true;
  applied: boolean;
  personId: string;
  candidateCount: number;
  estimatedBytes: number;
  referencedSkipCount: number;
  prunedCount: number;
  skippedByReason: Record<string, number>;
  deletedVectorRows: number;
  deletedInjectionIds: string[];
  freedPayloadBytes: number;
  batches: number;
  backupPath?: string;
  backupBytes?: number;
}

const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 1000;
const REFERENCED_SKIP_REASONS = new Set([
  "referenced_by_box",
  "referenced_by_trace",
  "referenced_by_proposal",
  "referenced_by_summary"
]);

function resolveBatchSize(requested: number | undefined): number {
  return Math.min(requested ?? DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE);
}

/**
 * Read-only estimate of which superseded ids are currently reference-protected, for dry-run
 * reporting only. This duplicates none of the deletion logic — it is a report, not an authority;
 * the real eligibility recompute lives inside `commitSupersededSummaryPrune`'s own transaction and
 * is the only thing that ever deletes a row.
 */
async function computeReferencedSummaryIds(store: SqliteStore): Promise<Set<string>> {
  const [boxes, traces, proposals, summaries] = await Promise.all([
    store.listBoxes(),
    store.listTraces(),
    store.listProposals(),
    store.listSummaries()
  ]);
  const referenced = new Set<string>();
  for (const box of boxes) for (const id of box.summaryIds ?? []) referenced.add(id);
  for (const trace of traces) for (const id of trace.summaryIds ?? []) referenced.add(id);
  for (const proposal of proposals) for (const id of proposal.sourceSummaryIds ?? []) referenced.add(id);
  for (const summary of summaries) for (const id of summary.sourceSummaryIds ?? []) referenced.add(id);
  return referenced;
}

async function runDryRun(store: SqliteStore, personId: string, batchSize: number): Promise<PruneSupersededCommandResult> {
  const [{ count, payloadBytes }, referencedIds] = await Promise.all([
    store.summarizeSupersededSummaries(personId),
    computeReferencedSummaryIds(store)
  ]);

  let referencedSkipCount = 0;
  let afterId: string | undefined;
  for (;;) {
    const page = await store.listSupersededSummaryIds(personId, { limit: batchSize, afterId });
    if (page.length === 0) break;
    for (const id of page) if (referencedIds.has(id)) referencedSkipCount += 1;
    afterId = page[page.length - 1];
  }

  return {
    ok: true,
    applied: false,
    personId,
    candidateCount: count,
    estimatedBytes: payloadBytes,
    referencedSkipCount,
    prunedCount: 0,
    skippedByReason: {},
    deletedVectorRows: 0,
    deletedInjectionIds: [],
    freedPayloadBytes: 0,
    batches: 0
  };
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

async function runApply(
  store: SqliteStore,
  personId: string,
  batchSize: number,
  confirmBackupPath: string,
  deps: PruneSupersededCommandDeps
): Promise<PruneSupersededCommandResult> {
  const { backupPath, backupBytes } = verifyBackup(confirmBackupPath);
  const progressSink = deps.progressSink ?? ((line: string) => process.stdout.write(`${line}\n`));

  let afterId: string | undefined;
  let prunedCount = 0;
  let deletedVectorRows = 0;
  const deletedInjectionIds: string[] = [];
  let freedPayloadBytes = 0;
  let batches = 0;
  let referencedSkipCount = 0;
  const skippedByReason: Record<string, number> = {};

  for (;;) {
    const page = await store.listSupersededSummaryIds(personId, { limit: batchSize, afterId });
    if (page.length === 0) break;

    const receipt = await store.commitSupersededSummaryPrune({
      operation: "superseded_summary_prune",
      personId,
      summaryIds: page,
      requestedAt: new Date().toISOString()
    });

    prunedCount += receipt.prunedSummaryIds.length;
    deletedVectorRows += receipt.deletedVectorRows;
    deletedInjectionIds.push(...receipt.deletedInjectionIds);
    freedPayloadBytes += receipt.freedPayloadBytes;
    for (const skip of receipt.skipped) {
      skippedByReason[skip.reason] = (skippedByReason[skip.reason] ?? 0) + 1;
      if (REFERENCED_SKIP_REASONS.has(skip.reason)) referencedSkipCount += 1;
    }
    batches += 1;

    // Advance past skipped ids to the highest id in the batch, so a reference-protected summary
    // at the head of the cursor never wedges the loop (T-11-43).
    afterId = page[page.length - 1];

    progressSink(
      JSON.stringify({
        event: "progress",
        batches,
        prunedCount,
        deletedVectorRows,
        freedPayloadBytes
      })
    );

    await deps.onBatchComplete?.(prunedCount);
  }

  const candidateCount = prunedCount + Object.values(skippedByReason).reduce((sum, value) => sum + value, 0);

  return {
    ok: true,
    applied: true,
    personId,
    candidateCount,
    estimatedBytes: freedPayloadBytes,
    referencedSkipCount,
    prunedCount,
    skippedByReason,
    deletedVectorRows,
    deletedInjectionIds,
    freedPayloadBytes,
    batches,
    backupPath,
    backupBytes
  };
}

export async function runPruneSupersededCommand(
  options: PruneSupersededCommandOptions,
  deps: PruneSupersededCommandDeps = {}
): Promise<PruneSupersededCommandResult> {
  const parsed = OptionsSchema.parse(options);
  const databasePath = resolve(parsed.databasePath);
  const batchSize = resolveBatchSize(parsed.batchSize);

  const store = new SqliteStore(databasePath);
  try {
    // Fail loud for an unknown person rather than silently reporting a zero-candidate prune
    // (T-11-45): personId is bound in options and never inferred.
    if (!(await store.getPerson(parsed.personId))) {
      throw new Error(`Cannot prune superseded summaries for unknown person ${parsed.personId}`);
    }

    if (!parsed.apply) {
      return await runDryRun(store, parsed.personId, batchSize);
    }

    if (!parsed.confirmBackupPath) {
      throw new Error(
        "Refusing to apply a superseded-summary prune without a verified backup. Pass --confirm-backup <path-to-backup-file>."
      );
    }

    return await runApply(store, parsed.personId, batchSize, parsed.confirmBackupPath, deps);
  } finally {
    store.close();
  }
}

function parseArgs(args: string[]): PruneSupersededCommandOptions {
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
  const result = await runPruneSupersededCommand(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
