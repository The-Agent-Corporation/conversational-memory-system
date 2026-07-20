import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { SqliteStore } from "../storage/sqlite-store.js";
import { HistoricalBootstrapper } from "./historical-bootstrapper.js";
import type { HistoricalBootstrapResult } from "./types.js";

const OptionsSchema = z.object({
  databasePath: z.string().min(1),
  personId: z.string().min(1)
});

export interface BootstrapCommandOptions {
  databasePath: string;
  personId: string;
}

export interface BootstrapCommandResult {
  ok: true;
  bootstrap: HistoricalBootstrapResult;
}

export async function runBootstrapCommand(
  options: BootstrapCommandOptions
): Promise<BootstrapCommandResult> {
  const parsed = OptionsSchema.parse(options);
  const store = new SqliteStore(parsed.databasePath);
  try {
    return {
      ok: true,
      bootstrap: await new HistoricalBootstrapper(store).bootstrap(parsed.personId)
    };
  } finally {
    store.close();
  }
}

function parseArgs(args: string[]): BootstrapCommandOptions {
  const values = readFlagValues(args);
  const databasePath = values.get("--db");
  const personId = values.get("--person");
  if (!databasePath) throw new Error("Missing memory database path. Pass --db <path>.");
  if (!personId) throw new Error("Missing person identity. Pass --person <person-id>.");
  return { databasePath: resolve(databasePath), personId };
}

function readFlagValues(args: string[]): Map<string, string> {
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
  return values;
}

export async function main(argv: string[]): Promise<void> {
  const result = await runBootstrapCommand(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
