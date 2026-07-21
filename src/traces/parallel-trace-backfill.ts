import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Box, Summary } from "../domain/types.js";
import {
  maxDocumentFrequencyFor,
  namespaceSuffixFor,
  materializeTraceCandidates,
  significantTermsBySummary,
  type PartialTraceCandidate,
  type TraceCandidate
} from "./trace-candidate-core.js";

/** Serialized shape a worker posts back: traceId -> its partial candidate with array-encoded sets. */
interface SerializedPartials {
  [traceId: string]: {
    title: string;
    summaryIndices: number[];
    keywords: string[];
    continuityTerms: string[];
  };
}

interface WorkerInput {
  termsFilePath: string;
  maxDocumentFrequency: number;
  namespaceSuffix: string;
  idNamespace?: string;
  leftStart: number;
  leftEnd: number;
}

const workerUrl = new URL("./trace-backfill-worker.mjs", import.meta.url);

/** Recommended worker count: leave two cores for the main thread and OS, cap at a sane maximum. */
export function defaultBackfillWorkerCount(): number {
  return Math.max(1, Math.min(16, availableParallelism() - 2));
}

function runWorker(input: WorkerInput): Promise<SerializedPartials> {
  return new Promise((resolve, reject) => {
    // The worker is a plain .mjs entry that loads natively and pulls in the .ts core via tsx's
    // tsImport, so it needs no special execArgv. Give it ample heap for the full inverted index.
    const worker = new Worker(fileURLToPath(workerUrl), {
      workerData: input,
      resourceLimits: { maxOldGenerationSizeMb: 4096 }
    });
    worker.once("message", (value: SerializedPartials) => resolve(value));
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`trace backfill worker exited with code ${code}`));
    });
  });
}

/**
 * Whole-corpus trace candidate generation, sharded across worker threads. The pairing work is
 * embarrassingly parallel: each unordered pair (a < b) is produced once by whichever shard owns
 * leftIndex a, so a contiguous partition of the left-index range covers every pair exactly once and
 * the partials union back to the single-threaded result. Summaries are shared with workers as a
 * compact per-summary term file (no summary text, no per-worker DB load), so peak memory stays flat.
 */
export async function buildTraceCandidatesParallel(
  summaries: Summary[],
  boxes: Box[],
  idNamespace: string | undefined,
  workerCount: number
): Promise<TraceCandidate[]> {
  const summaryCount = summaries.length;
  const workers = Math.max(1, Math.min(workerCount, summaryCount));
  const termsBySummary = significantTermsBySummary(summaries);
  const maxDocumentFrequency = maxDocumentFrequencyFor(summaryCount);
  const namespaceSuffix = namespaceSuffixFor(idNamespace);

  const termsFilePath = join(tmpdir(), `cms-trace-terms-${process.pid}-${summaryCount}.json`);
  await writeFile(termsFilePath, JSON.stringify(termsBySummary));

  try {
    const chunkSize = Math.ceil(summaryCount / workers);
    const inputs: WorkerInput[] = [];
    for (let start = 0; start < summaryCount; start += chunkSize) {
      inputs.push({
        termsFilePath,
        maxDocumentFrequency,
        namespaceSuffix,
        idNamespace,
        leftStart: start,
        leftEnd: Math.min(start + chunkSize, summaryCount)
      });
    }

    const partialsPerWorker = await Promise.all(inputs.map((input) => runWorker(input)));

    // Merge: union summary indices per traceId; keep keywords/continuity terms in first-seen order.
    const merged = new Map<string, PartialTraceCandidate>();
    for (const partials of partialsPerWorker) {
      for (const traceId of Object.keys(partials)) {
        const incoming = partials[traceId];
        let candidate = merged.get(traceId);
        if (!candidate) {
          candidate = { title: incoming.title, summaryIndices: new Set(), keywords: new Set(), continuityTerms: new Set() };
          merged.set(traceId, candidate);
        }
        for (const index of incoming.summaryIndices) candidate.summaryIndices.add(index);
        for (const term of incoming.keywords) candidate.keywords.add(term);
        for (const term of incoming.continuityTerms) candidate.continuityTerms.add(term);
      }
    }

    return materializeTraceCandidates(merged, summaries, boxes);
  } finally {
    await unlink(termsFilePath).catch(() => { /* best-effort temp cleanup */ });
  }
}
