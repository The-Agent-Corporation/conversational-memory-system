import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { resolveEmbedder } from "../embeddings/embedder-resolver.js";
import { RETRIEVABLE_MEMORY_STATES } from "../retrieval/retrievable-state.js";
import { SqliteStore } from "../storage/sqlite-store.js";
import type { SummaryVectorRecord } from "../storage/memory-store.js";
import type { Summary } from "../domain/types.js";

/**
 * `memory backfill-embeddings` (REQ-042). Resolves the active embedder once
 * (D-05 hard-error propagates — never caught, never a silent fallback to
 * DeterministicEmbedder), queries `listSummaryIdsMissingVector` once as the
 * resume key, then embeds and persists in ~500-record transactional batches
 * via Plan 01's `saveSummaryVectors`. The missing-set-as-checkpoint pattern
 * plus per-batch transactions is what makes SC1 (zero missing after a full
 * run), SC2 (kill+restart resumes cleanly), and SC3 (idempotent rerun) all
 * true without a separate checkpoint table.
 */
const DEFAULT_BATCH_SIZE = 500;

const OptionsSchema = z
  .object({
    databasePath: z.string().min(1),
    batchSize: z.number().int().positive().optional()
  })
  .strict();

export interface BackfillEmbeddingsCommandOptions {
  databasePath: string;
  batchSize?: number;
}

export interface BackfillEmbeddingsCommandDeps {
  /** Called after each committed batch (the test's kill-simulation hook). */
  onBatchComplete?: (processed: number) => void | Promise<void>;
  /** Progress line sink; defaults to process.stdout.write. */
  progressSink?: (line: string) => void;
}

export interface BackfillEmbeddingsCommandResult {
  ok: true;
  provider: string;
  model: string;
  processed: number;
  totalMissingAtStart: number;
}

export async function runBackfillEmbeddingsCommand(
  options: BackfillEmbeddingsCommandOptions,
  deps: BackfillEmbeddingsCommandDeps = {}
): Promise<BackfillEmbeddingsCommandResult> {
  const parsed = OptionsSchema.parse(options);
  const databasePath = resolve(parsed.databasePath);
  const batchSize = parsed.batchSize ?? DEFAULT_BATCH_SIZE;
  const progressSink = deps.progressSink ?? ((line: string) => process.stdout.write(`${line}\n`));

  const store = new SqliteStore(databasePath);
  try {
    // Resolved exactly once; this instance's provider/model drives BOTH the
    // missing-set query and every written record for the entire run — never
    // re-resolved mid-loop, never a hardcoded string (T-10-08).
    const embedder = await resolveEmbedder(databasePath);

    // INVARIANT (GAP-12-A): the query key here and the write key below
    // (`embedding.model`) are the same identity BY CONSTRUCTION — every embedder
    // composes both through `composeModelIdentity` in `embedder-identity.ts`, so
    // it is one expression rather than two strings that happen to agree. If a
    // future edit makes these two reads diverge, the missing set stops shrinking:
    // resume restarts from zero and a repair pass re-embeds the corpus per tick.
    const missingIds = await store.listSummaryIdsMissingVector(embedder.provider, embedder.model);
    const totalMissingAtStart = missingIds.length;

    // One-time load into an id->Summary map, scoped to the retrievable states —
    // an unfiltered load Zod-parses every summary in the store (138k rows on the
    // live corpus, one of them 818 KB). Non-retrievable ids that the missing-set
    // query still returns simply miss this map and hit the defensive
    // `if (!summary) continue` below.
    const allSummaries = await store.listSummaries({ states: [...RETRIEVABLE_MEMORY_STATES] });
    const summaryById = new Map<string, Summary>();
    for (const summary of allSummaries) {
      summaryById.set(summary.id, summary);
    }

    let processed = 0;

    for (let start = 0; start < missingIds.length; start += batchSize) {
      const idsSlice = missingIds.slice(start, start + batchSize);
      const records: SummaryVectorRecord[] = [];

      for (const id of idsSlice) {
        const summary = summaryById.get(id);
        // A summary absent from the map (removed between query and
        // processing) is skipped defensively — it does not throw.
        if (!summary) continue;

        if (!summary.personId) {
          // Fail loud: never substitute an "unscoped" sentinel (T-10-05).
          throw new Error(
            `Cannot backfill embedding for summary "${summary.id}": missing personId. ` +
              `Vectors must be tagged with their own summary's personId, never a caller override.`
          );
        }

        // Passages/summaries use the passage-embedding method only (never the
        // asymmetric query-prefixed variant).
        const embedding = await embedder.embed(summary.summaryText);

        records.push({
          summaryId: summary.id,
          provider: embedding.provider,
          model: embedding.model,
          dimensions: embedding.dimensions,
          vector: embedding.vector,
          personId: summary.personId,
          scopeIds: summary.scopeIds ?? [],
          createdAt: embedding.createdAt
        });
      }

      if (records.length > 0) {
        await store.saveSummaryVectors(records);
        processed += records.length;

        progressSink(
          JSON.stringify({
            event: "progress",
            processed,
            total: totalMissingAtStart,
            provider: embedder.provider,
            model: embedder.model
          })
        );
      }

      await deps.onBatchComplete?.(processed);
    }

    return {
      ok: true,
      provider: embedder.provider,
      model: embedder.model,
      processed,
      totalMissingAtStart
    };
  } finally {
    store.close();
  }
}

function parseArgs(args: string[]): BackfillEmbeddingsCommandOptions {
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
  const databasePath = values.get("--db");
  if (!databasePath) throw new Error("Missing memory database path. Pass --db <path>.");
  const batchSizeRaw = values.get("--batch-size");
  const batchSize = batchSizeRaw ? Number.parseInt(batchSizeRaw, 10) : undefined;
  return {
    databasePath: resolve(databasePath),
    batchSize
  };
}

export async function main(argv: string[]): Promise<void> {
  const result = await runBackfillEmbeddingsCommand(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
