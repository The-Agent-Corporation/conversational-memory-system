import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { SqliteStore } from "../storage/sqlite-store.js";
import { CommitEventDeletionInputSchema } from "../storage/mcp-mutation-contracts.js";

const OptionsSchema = z.object({
  databasePath: z.string().min(1),
  personId: z.string().min(1),
  canonicalEventId: z.string().min(1).optional(),
  nativeEventId: z.string().min(1).optional(),
  sourceId: z.string().min(1).optional(),
  actor: z.string().min(1),
  reason: z.string().min(1),
  deletedAt: z.string().datetime().optional()
}).strict();

export async function runEventDeleteCommand(options: z.infer<typeof OptionsSchema>) {
  const parsed = OptionsSchema.parse(options);
  const store = new SqliteStore(resolve(parsed.databasePath));
  try {
    const input = CommitEventDeletionInputSchema.parse({
      personId: parsed.personId,
      ...(parsed.canonicalEventId ? { canonicalEventId: parsed.canonicalEventId } : {}),
      ...(parsed.nativeEventId ? { nativeEventId: parsed.nativeEventId } : {}),
      ...(parsed.sourceId ? { sourceId: parsed.sourceId } : {}),
      actor: parsed.actor,
      reason: parsed.reason,
      deletedAt: parsed.deletedAt ?? new Date().toISOString()
    });
    return { ok: true as const, receipt: await store.commitEventDeletion(input) };
  } finally {
    store.close();
  }
}

function parseArgs(args: string[]): z.infer<typeof OptionsSchema> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--") && args[index + 1] && !args[index + 1]!.startsWith("--")) {
      values.set(arg, args[index + 1]!);
      index += 1;
    }
  }
  return {
    databasePath: values.get("--db") ?? "",
    personId: values.get("--person") ?? "",
    ...(values.get("--event") ? { canonicalEventId: values.get("--event") } : {}),
    ...(values.get("--native-event") ? { nativeEventId: values.get("--native-event") } : {}),
    ...(values.get("--source") ? { sourceId: values.get("--source") } : {}),
    actor: values.get("--actor") ?? "operator",
    reason: values.get("--reason") ?? ""
  };
}

export async function main(argv: string[]): Promise<void> {
  const result = await runEventDeleteCommand(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
