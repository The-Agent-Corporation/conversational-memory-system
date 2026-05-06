import { pathToFileURL } from "node:url";
import { z } from "zod";
import { SqliteStore } from "../../storage/sqlite-store.js";
import { HermesMemoryAdapter } from "./adapter.js";
import { HermesTimelineRowSchema } from "./contract.js";

const IngestOptionsSchema = z.object({
  databasePath: z.string().min(1),
  input: z.string().min(1)
});

export interface HermesIngestResult {
  ok: true;
  turnId: string | null;
  completedTopic: string | null;
  summaryId: string | null;
}

export async function ingestHermesTimelineRow(options: {
  databasePath: string;
  input: string;
}): Promise<HermesIngestResult> {
  const parsedOptions = IngestOptionsSchema.parse(options);
  const row = HermesTimelineRowSchema.parse(JSON.parse(parsedOptions.input));
  const store = new SqliteStore(parsedOptions.databasePath);

  try {
    const adapter = new HermesMemoryAdapter(store);
    const result = await adapter.processTimelineRow(row);

    return {
      ok: true,
      turnId: result.turn?.id ?? null,
      completedTopic: result.completedTopic?.topicLabel ?? null,
      summaryId: result.compaction?.summary.id ?? null
    };
  } finally {
    store.close();
  }
}

async function main(): Promise<void> {
  const databasePath = parseDatabasePath(process.argv.slice(2));
  const input = await readStdin();
  const result = await ingestHermesTimelineRow({ databasePath, input });
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
