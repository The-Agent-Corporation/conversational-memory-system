import type { Embedder } from "../embeddings/embedder.js";
import type { MemoryStore, SummaryVectorRecord } from "../storage/memory-store.js";
import type { ContractionClock } from "./contraction-runner.js";

/** Per-invocation budget. 200 summaries is ~1.5 s of ONNX work, which a 15-minute tick absorbs. */
export const DEFAULT_EMBEDDING_REPAIR_BUDGET = 200;
/** Minimum monotonic gap between two working invocations. */
export const DEFAULT_EMBEDDING_REPAIR_INTERVAL_MS = 15 * 60 * 1000;

export interface EmbeddingRepairOptions {
  store: MemoryStore;
  /**
   * The embedder the daemon already resolved for the contraction stage. NEVER resolve a second one
   * here: `resolveEmbedder` builds an ONNX session at 72-121 ms a time (T-12-23).
   */
  embedder: Embedder;
  clock: ContractionClock;
  budget?: number;
  minimumIntervalMs?: number;
}

export interface EmbeddingRepairResult {
  /** True when the minimum interval had not elapsed — no store call was made. */
  skipped: boolean;
  /** Ids the pass actually saw this invocation. Capped at the budget by construction. */
  examined: number;
  persisted: number;
  failed: number;
  /**
   * `examined - persisted` from THIS batch only — deliberately not "how many remain overall",
   * which would need a second unbounded query. Because the query is limited, `examined === budget`
   * means "at least this many remain", never "exactly this many".
   */
  remainingInBatch: number;
}

const SKIPPED: EmbeddingRepairResult = Object.freeze({
  skipped: true,
  examined: 0,
  persisted: 0,
  failed: 0,
  remainingInBatch: 0
});

/**
 * REQ-043 / ADR 0052 — the bounded repair pass for the one hole the post-commit embed stage leaves.
 *
 * A crash between `commitContractionSlice` returning and `saveSummaryVectors` completing (or a
 * transient embedder fault) leaves a summary committed with no vector. That state is detectable —
 * it is exactly the missing set — and this pass heals it on a later tick so an operator never has
 * to notice `missingVectors > 0` in `memory status` and hand-run a backfill.
 *
 * **The budget is the whole design.** Two things bound the per-tick cost, and both matter:
 *
 * 1. The budget goes INTO the query as `{ limit }` (Plan 12-02 added the parameter for this
 *    caller), so the store returns K ids rather than 49,314 that JS then discards 99.6% of.
 * 2. Summaries are fetched by id via `listSummariesByIds`, never a whole-table load. The named
 *    anti-pattern is `ProposalScheduler.createStagingStore` (`proposal-scheduler.ts:83-103`),
 *    which re-loads and re-Zod-parses every summary, box, anchor, proposal, and trace for the
 *    person on every cycle. Per-tick cost here is O(budget), never O(corpus) — that is SC2.
 *
 * Forward progress is structural rather than cursor-based: `listSummaryIdsMissingVector` is
 * ascending-by-id and each pass removes what it embeds, so taking the first K every time converges.
 * A convergence failure would mean the query key and the write key had drifted apart (GAP-12-A),
 * which would show up as an endless K-per-tick re-embed — which is why the convergence assertion
 * in the test uses the two-identity fixture rather than a coinciding-identity fake.
 *
 * **What it cannot do (D-12-1, ADR 0052 decision 6):** it heals a MISSING vector, never a STALE
 * one. A vector whose summary text changed after embedding still has a row, so it is never in the
 * missing set. `SummarySchema` has no `updatedAt` and `contraction-runner.ts` sets `version: 1`
 * unconditionally, so there is no monotonic field to detect it with. Do not invent a heuristic.
 *
 * `runDue` returns a result on every path and throws on none — the daemon wires it like
 * `syncReplication`, and a best-effort second line must never be a liveness dependency.
 */
export class EmbeddingRepairRunner {
  private readonly store: MemoryStore;
  private readonly embedder: Embedder;
  private readonly clock: ContractionClock;
  private readonly budget: number;
  private readonly minimumIntervalMs: number;
  /** Monotonic and injected — this module reads no host wall clock and no host monotonic clock. */
  private nextDueAt: number | null = null;

  constructor(options: EmbeddingRepairOptions) {
    this.store = options.store;
    this.embedder = options.embedder;
    this.clock = options.clock;
    this.budget = Math.max(1, options.budget ?? DEFAULT_EMBEDDING_REPAIR_BUDGET);
    this.minimumIntervalMs = Math.max(0, options.minimumIntervalMs ?? DEFAULT_EMBEDDING_REPAIR_INTERVAL_MS);
  }

  async runDue(): Promise<EmbeddingRepairResult> {
    let examined = 0;
    let persisted = 0;
    let failed = 0;
    try {
      const now = this.clock.monotonicNow();
      if (this.nextDueAt !== null && now < this.nextDueAt) return SKIPPED;
      // Set BEFORE the work, so a persistently failing query is still rate limited rather than
      // retried on every drain.
      this.nextDueAt = now + this.minimumIntervalMs;

      // The budget goes into the query. Never `listSummaryIdsMissingVector(...)` unbounded followed
      // by `.slice(0, budget)`. The query is also state-predicated (GAP-12-B), so a superseded row
      // is never a candidate and this pass can never chase the 89,059 unembeddable rows.
      const ids = await this.store.listSummaryIdsMissingVector(
        this.embedder.provider,
        this.embedder.model,
        { limit: this.budget }
      );
      if (ids.length === 0) return { skipped: false, examined: 0, persisted: 0, failed: 0, remainingInBatch: 0 };
      examined = ids.length;

      const summaries = await this.store.listSummariesByIds(ids);
      const records: SummaryVectorRecord[] = [];
      for (const summary of summaries) {
        if (!summary.personId) {
          // Skip and count. NEVER substitute a sentinel personId (T-10-05/T-12-22): a mis-tagged
          // vector row is cross-person retrieval.
          failed += 1;
          continue;
        }
        try {
          // Passage mode. NEVER `embedQuery` — bge is asymmetric and only queries carry the
          // instruction prefix (Phase 9, locked).
          const embedding = await this.embedder.embed(summary.summaryText);
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
        } catch {
          failed += 1;
        }
      }
      // An id the fetch did not resolve (deleted between query and fetch) is neither persisted nor
      // an error worth reporting — it is simply no longer missing.
      failed += Math.max(0, ids.length - summaries.length);

      if (records.length > 0) {
        // One batched, all-or-nothing call for the whole pass, not a per-record loop.
        try {
          await this.store.saveSummaryVectors(records);
          persisted = records.length;
        } catch {
          failed += records.length;
        }
      }
    } catch {
      // Defence in depth: nothing above is expected to escape its own catch, but a throw here would
      // reach the daemon drain loop, and this pass must never be able to affect it.
      failed = Math.max(failed, examined - persisted);
    }

    if (failed > 0) {
      // Counts, provider, and model ONLY (V7/T-12-15). Never a summary id, never summary text,
      // never an error message that could quote the input — the same discipline as
      // `contraction-runner.ts`'s embed stage and `backfill-embeddings-command.ts:125-133`.
      process.stderr.write(`${JSON.stringify({
        event: "summary_embed_repair_incomplete",
        examined,
        persisted,
        failed,
        provider: this.embedder.provider,
        model: this.embedder.model
      })}\n`);
    }

    return { skipped: false, examined, persisted, failed, remainingInBatch: examined - persisted };
  }
}
