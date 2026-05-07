import { pathToFileURL } from "node:url";
import { z } from "zod";
import { SleepReviewer } from "../../sleep/sleep-reviewer.js";
import { SqliteStore } from "../../storage/sqlite-store.js";

const SleepOptionsSchema = z.object({
  databasePath: z.string().min(1),
  input: z.string().min(1)
});

const HermesSleepRequestSchema = z.object({
  reviewed_at: z.string().datetime().optional(),
  minimum_summaries_per_box: z.number().int().positive().optional(),
  stale_strength_threshold: z.number().min(0).max(1).optional()
});

export interface HermesSleepResult {
  ok: true;
  reviewedAt: string;
  updatedSummaryIds: string[];
  updatedBoxIds: string[];
  proposedBoxIds: string[];
  noopReason: string | null;
}

export async function sleepHermesMemory(options: {
  databasePath: string;
  input: string;
}): Promise<HermesSleepResult> {
  const parsedOptions = SleepOptionsSchema.parse(options);
  const request = HermesSleepRequestSchema.parse(JSON.parse(parsedOptions.input));
  const reviewedAt = request.reviewed_at ?? new Date().toISOString();
  const store = new SqliteStore(parsedOptions.databasePath);

  try {
    const reviewer = new SleepReviewer(store);
    const decay = await reviewer.decaySummaries({
      reviewedAt,
      staleStrengthThreshold: request.stale_strength_threshold
    });
    const refresh = await reviewer.refreshBoxStates({ reviewedAt });
    const proposals = await reviewer.proposeBoxes({
      reviewedAt,
      minimumSummariesPerBox: request.minimum_summaries_per_box
    });

    const updatedSummaryIds = decay.updatedSummaries.map((summary) => summary.id);
    const updatedBoxIds = refresh.updatedBoxes.map((box) => box.id);
    const proposedBoxIds = proposals.proposedBoxes.map((box) => box.id);
    const hasChanges = updatedSummaryIds.length > 0 || updatedBoxIds.length > 0 || proposedBoxIds.length > 0;

    return {
      ok: true,
      reviewedAt,
      updatedSummaryIds,
      updatedBoxIds,
      proposedBoxIds,
      noopReason: hasChanges ? null : "No summaries or boxes needed sleep review changes."
    };
  } finally {
    store.close();
  }
}

async function main(): Promise<void> {
  const databasePath = parseDatabasePath(process.argv.slice(2));
  const input = await readStdin();
  const result = await sleepHermesMemory({ databasePath, input: input.trim() || "{}" });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseDatabasePath(args: string[]): string {
  const dbIndex = args.indexOf("--db");
  if (dbIndex >= 0 && args[dbIndex + 1]) {
    return args[dbIndex + 1];
  }

  const equalsArg = args.find((arg) => arg.startsWith("--db="));
  if (equalsArg) {
    return equalsArg.slice("--db=".length);
  }

  const envPath = process.env.HERMES_CONVERSATIONAL_MEMORY_DB;
  if (envPath) {
    return envPath;
  }

  throw new Error("Missing memory database path. Pass --db <path> or set HERMES_CONVERSATIONAL_MEMORY_DB.");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
