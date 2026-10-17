import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { historicalContractionJobId } from "../bootstrap/historical-bootstrapper.js";
import { ContractionRunner, PROCESSOR_VERSION, type ContractionSliceResult } from "../daemon/contraction-runner.js";
import type { CanonicalOrderKey, ContractionJob, WriteAuthority } from "../daemon/types.js";
import type { CanonicalEvent } from "../domain/canonical.js";
import { readSemanticConfig, semanticSummaryModel } from "../openrouter/config.js";
import { ledgerFor } from "../openrouter/ledger.js";
import { SqliteStore } from "../storage/sqlite-store.js";
import { OpenRouterSummarizer } from "../summarization/openrouter-summarizer.js";
import { DeterministicSummarizer } from "../summarization/summarizer.js";
import { HYGIENE_RULE_VERSION } from "../topic/derivation-hygiene.js";

/**
 * `memory rebuild-derivations` (REQ-054, SC5). A full, resumable, checkpointed re-derivation of a
 * person's summaries under the current hygiene rule version. The command owns no derivation loop of
 * its own: it bumps the existing contraction job's generation and rewinds `earliestAffected` to the
 * first canonical event, then drives the same `ContractionRunner.drainSlice` the daemon and the
 * historical bootstrapper use — whose non-resume path already runs the full `DerivationInvalidator`
 * closure (supersession, never deletion) over summaries, anchors, boxes, proposals, and traces. The
 * only work this command does beyond driving that loop is tombstoning vectors for summaries the slice
 * reports as superseded (T-11-18) and reporting progress.
 *
 * Reuses `historicalContractionJobId(personId)` for the job/checkpoint identity — inventing a second
 * job id would derive a parallel set of summaries alongside the existing ones instead of superseding
 * them.
 */
const OptionsSchema = z
  .object({
    databasePath: z.string().min(1),
    personId: z.string().min(1),
    force: z.boolean().optional()
  })
  .strict();

export interface RebuildDerivationsCommandOptions {
  databasePath: string;
  personId: string;
  force?: boolean;
}

export interface RebuildDerivationsCommandDeps {
  /** Called after each committed slice (the test's kill-simulation hook). */
  onBatchComplete?: (processedEvents: number) => void | Promise<void>;
  /** Progress line sink; defaults to process.stdout.write. */
  progressSink?: (line: string) => void;
}

export interface RebuildDerivationsCommandResult {
  ok: true;
  rebuilt: boolean;
  personId: string;
  hygieneRuleVersion: string;
  processorVersion: string;
  slices: number;
  processedEvents: number;
  summariesWritten: number;
  supersededSummaries: number;
}

function noRebuildNeeded(personId: string): RebuildDerivationsCommandResult {
  return {
    ok: true,
    rebuilt: false,
    personId,
    hygieneRuleVersion: HYGIENE_RULE_VERSION,
    processorVersion: PROCESSOR_VERSION,
    slices: 0,
    processedEvents: 0,
    summariesWritten: 0,
    supersededSummaries: 0
  };
}

function orderKey(event: CanonicalEvent): CanonicalOrderKey {
  return { occurredAt: event.occurredAt, nativeSequence: event.nativeSequence, id: event.id };
}

export async function runRebuildDerivationsCommand(
  options: RebuildDerivationsCommandOptions,
  deps: RebuildDerivationsCommandDeps = {}
): Promise<RebuildDerivationsCommandResult> {
  const parsed = OptionsSchema.parse(options);
  const databasePath = resolve(parsed.databasePath);
  const progressSink = deps.progressSink ?? ((line: string) => process.stdout.write(`${line}\n`));

  const store = new SqliteStore(databasePath);
  try {
    // Fail loud for an unknown person rather than silently rebuilding nothing (T-11-17).
    if (!(await store.getPerson(parsed.personId))) {
      throw new Error(`Cannot rebuild derivations for unknown person ${parsed.personId}`);
    }

    const events = await store.listCanonicalEvents(parsed.personId);
    if (events.length === 0) return noRebuildNeeded(parsed.personId);

    const jobId = historicalContractionJobId(parsed.personId);
    const checkpointId = `contraction_checkpoint_${jobId}`;
    const existingJob = await store.getContractionJob(jobId);
    const checkpoint = await store.getContractionCheckpoint(checkpointId);

    const isStale = checkpoint === null || checkpoint.processorVersion !== PROCESSOR_VERSION || parsed.force === true;

    let job: ContractionJob;
    if (isStale) {
      // Generation bump + full rewind to the first event marks the WHOLE corpus stale — the locked
      // decision is a full rebuild, not a selection predicate (59% of summaries disappear and the
      // survivors' text changes under the current hygiene rules).
      const now = new Date().toISOString();
      const firstKey = orderKey(events[0]!);
      const lastKey = orderKey(events.at(-1)!);
      job = {
        id: jobId,
        personId: parsed.personId,
        generation: (existingJob?.generation ?? 0) + 1,
        earliestAffected: firstKey,
        latestAffected: lastKey,
        state: "pending",
        attempts: existingJob?.attempts ?? 0,
        immediateDirty: true,
        proposalDirty: existingJob?.proposalDirty ?? true,
        lastProposalRunAt: existingJob?.lastProposalRunAt ?? null,
        lastActivityAt: now,
        nextDueAt: now,
        createdAt: existingJob?.createdAt ?? now,
        updatedAt: now
      };
      await store.saveContractionJob(job);
    } else if (
      existingJob !== null &&
      checkpoint !== null &&
      checkpoint.generation === existingJob.generation &&
      checkpoint.immediateStage !== "complete"
    ) {
      // A rebuild is already in flight under the current processor version — resume without
      // bumping the generation again (T-11-16: never restart from zero on every invocation).
      job = existingJob;
    } else {
      // Everything is current and complete: write nothing.
      return noRebuildNeeded(parsed.personId);
    }

    const authority: WriteAuthority = {
      kind: "foreground",
      personId: parsed.personId,
      operation: "historical-bootstrap"
    };
    const semantic = readSemanticConfig(databasePath);
    const summaryModel = semanticSummaryModel(semantic);
    const runner = new ContractionRunner(store, {
      authority,
      ...(summaryModel ? {
        summarizer: OpenRouterSummarizer.fromEnv({
          OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
          OPENROUTER_MODEL: summaryModel,
          OPENROUTER_BASE_URL: semantic.baseUrl || process.env.OPENROUTER_BASE_URL
        }, { dailySpendCapUsd: semantic.dailySpendCapUsd, ledger: ledgerFor(store) }),
        provisionalSummarizer: new DeterministicSummarizer(),
        summaryIdentity: "span-boundary",
        summarizePolicy: "on-completion",
        boundaryVersion: semantic.boundaryVersion
      } : {})
    });
    // Canonical events are immutable for the duration of this pass, so load them once and inject
    // them into every slice — the same fast path HistoricalBootstrapper uses to avoid an O(n^2) walk.
    const eventIndexById = new Map(events.map((event, index) => [event.id, index]));
    let scopesAsserted = false;
    let slices = 0;
    let processedEvents = 0;
    let summariesWritten = 0;
    let supersededSummaries = 0;

    for (;;) {
      const slice: ContractionSliceResult = await runner.drainSlice(
        parsed.personId,
        jobId,
        {},
        { preloadedEvents: events, scopesAlreadyAsserted: scopesAsserted, eventIndexById }
      );
      scopesAsserted = true;
      slices += 1;
      processedEvents += slice.processedEvents;
      summariesWritten += slice.immediate.summaries;

      const supersededSummaryIds = slice.supersessions
        .filter((supersession) => supersession.kind === "summary")
        .map((supersession) => supersession.id);
      if (supersededSummaryIds.length > 0) {
        // Tombstone vectors for superseded summaries so future semantic recall never surfaces a
        // pre-hygiene summary alongside its hygiene-clean replacement (T-11-18).
        await store.deleteSummaryVectors(supersededSummaryIds);
        supersededSummaries += supersededSummaryIds.length;
      }

      progressSink(
        JSON.stringify({
          event: "progress",
          slices,
          processedEvents,
          complete: slice.complete
        })
      );

      await deps.onBatchComplete?.(processedEvents);

      if (slice.complete) break;
      if (slice.processedEvents === 0) {
        throw new Error("Rebuild-derivations contraction made no progress");
      }
    }

    return {
      ok: true,
      rebuilt: true,
      personId: parsed.personId,
      hygieneRuleVersion: HYGIENE_RULE_VERSION,
      processorVersion: PROCESSOR_VERSION,
      slices,
      processedEvents,
      summariesWritten,
      supersededSummaries
    };
  } finally {
    store.close();
  }
}

function parseArgs(args: string[]): RebuildDerivationsCommandOptions {
  const values = new Map<string, string>();
  let force = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--force") {
      force = true;
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
  return {
    databasePath: resolve(databasePath),
    personId,
    force: force || undefined
  };
}

export async function main(argv: string[]): Promise<void> {
  const result = await runRebuildDerivationsCommand(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
