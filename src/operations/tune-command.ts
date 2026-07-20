import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { SqliteStore } from "../storage/sqlite-store.js";

/**
 * Bounded, low-risk performance tuning knobs (D-09). This is a deliberately
 * closed set — SQLite busy_timeout, retrieval result-limit/token-budget
 * defaults, and a manual REINDEX/ANALYZE trigger — chosen because none of
 * them change data semantics, only performance characteristics. Not an
 * open-ended optimization surface.
 */
const TuneConfigSchema = z
  .object({
    busyTimeoutMs: z.number().int().min(1).max(30_000).default(5_000),
    retrievalDefaultLimit: z.number().int().min(1).max(100).default(20),
    retrievalDefaultTokenBudget: z.number().int().min(1).max(8_000).default(2_000)
  })
  .strict();

export type TuneConfig = z.infer<typeof TuneConfigSchema>;

const KNOBS = ["busy_timeout", "retrieval_default_limit", "retrieval_default_token_budget"] as const;
export type TuneKnob = (typeof KNOBS)[number];

const OptionsSchema = z
  .object({
    databasePath: z.string().min(1),
    action: z.enum(["set", "show", "reindex"]),
    knob: z.enum(KNOBS).optional(),
    value: z.number().int().optional()
  })
  .strict();

export interface TuneCommandOptions {
  databasePath: string;
  action: "set" | "show" | "reindex";
  knob?: TuneKnob;
  value?: number;
}

export interface TuneCommandResult {
  ok: true;
  action: "set" | "show" | "reindex";
  config: TuneConfig;
  appliedBusyTimeoutMs?: number;
  reindexed?: boolean;
}

function tuneConfigPath(databasePath: string): string {
  return `${databasePath}.tune.json`;
}

/**
 * Reads the persisted tune config for a database, or the schema defaults if
 * none has been written yet. Exported so other commands/tests can read back
 * what was set without going through the CLI.
 */
export function readTuneConfig(databasePath: string): TuneConfig {
  const path = tuneConfigPath(databasePath);
  if (!existsSync(path)) return TuneConfigSchema.parse({});
  return TuneConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function writeTuneConfig(databasePath: string, config: TuneConfig): void {
  writeFileSync(tuneConfigPath(databasePath), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function applyKnob(config: TuneConfig, knob: TuneKnob, value: number): TuneConfig {
  switch (knob) {
    case "busy_timeout":
      return { ...config, busyTimeoutMs: value };
    case "retrieval_default_limit":
      return { ...config, retrievalDefaultLimit: value };
    case "retrieval_default_token_budget":
      return { ...config, retrievalDefaultTokenBudget: value };
  }
}

export async function runTuneCommand(options: TuneCommandOptions): Promise<TuneCommandResult> {
  const parsed = OptionsSchema.parse(options);
  const databasePath = resolve(parsed.databasePath);
  const config = readTuneConfig(databasePath);

  if (parsed.action === "show") {
    return { ok: true, action: "show", config };
  }

  if (parsed.action === "reindex") {
    const store = new SqliteStore(databasePath, { busyTimeoutMs: config.busyTimeoutMs });
    try {
      store.reindexAndAnalyze();
    } finally {
      store.close();
    }
    return { ok: true, action: "reindex", config, reindexed: true };
  }

  // action === "set"
  if (!parsed.knob || parsed.value === undefined) {
    throw new Error("tune set requires --knob and --value.");
  }
  const nextConfig = TuneConfigSchema.parse(applyKnob(config, parsed.knob, parsed.value));
  writeTuneConfig(databasePath, nextConfig);

  let appliedBusyTimeoutMs: number | undefined;
  if (parsed.knob === "busy_timeout") {
    const store = new SqliteStore(databasePath, { busyTimeoutMs: nextConfig.busyTimeoutMs });
    try {
      appliedBusyTimeoutMs = store.getBusyTimeoutMs();
    } finally {
      store.close();
    }
  }

  return { ok: true, action: "set", config: nextConfig, appliedBusyTimeoutMs };
}

function parseArgs(args: string[]): TuneCommandOptions {
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
  const action = values.get("--action");
  if (!databasePath) throw new Error("Missing memory database path. Pass --db <path>.");
  if (!action || !["set", "show", "reindex"].includes(action)) {
    throw new Error("Pass --action <set|show|reindex>.");
  }
  const knob = values.get("--knob");
  const rawValue = values.get("--value");
  return {
    databasePath: resolve(databasePath),
    action: action as TuneCommandOptions["action"],
    knob: knob as TuneKnob | undefined,
    value: rawValue !== undefined ? Number(rawValue) : undefined
  };
}

export async function main(argv: string[]): Promise<void> {
  const result = await runTuneCommand(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
