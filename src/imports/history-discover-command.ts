import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { discoverClaudeHistory } from "./claude-discovery.js";
import { discoverCordisHistory } from "./cordis-discovery.js";
import { discoverHermesHistory } from "./hermes-discovery.js";
import { discoverOpenClawHistory } from "./openclaw-discovery.js";
import type {
  ClaudeHistoryCandidate,
  CordisHistoryCandidate,
  HermesHistoryCandidate,
  OpenClawHistoryCandidate
} from "./types.js";

export type ImportSource = "claude-code" | "openclaw" | "hermes" | "cordis";
export type UniversalHistoryCandidate =
  | ClaudeHistoryCandidate
  | OpenClawHistoryCandidate
  | HermesHistoryCandidate
  | CordisHistoryCandidate;

export interface HistoryDiscoverCommandOptions {
  source: ImportSource;
  sourcePath?: string;
  discoveredAt?: string;
}

export interface HistoryDiscoverCommandResult {
  ok: true;
  approvalRequired: true;
  candidate: UniversalHistoryCandidate;
}

export async function runHistoryDiscoverCommand(
  options: HistoryDiscoverCommandOptions
): Promise<HistoryDiscoverCommandResult> {
  const sourcePath = resolve(options.sourcePath ?? defaultSourcePath(options.source));
  const discoveredAt = options.discoveredAt ?? new Date().toISOString();
  const candidate = options.source === "claude-code"
    ? await discoverClaudeHistory(sourcePath, discoveredAt)
    : options.source === "openclaw"
      ? await discoverOpenClawHistory(sourcePath, discoveredAt)
      : options.source === "hermes"
        ? await discoverHermesHistory(sourcePath, discoveredAt)
        : await discoverCordisHistory(sourcePath, discoveredAt);
  return { ok: true, approvalRequired: true, candidate };
}

function defaultSourcePath(source: ImportSource): string {
  if (source === "claude-code") return join(homedir(), ".claude");
  if (source === "openclaw") return join(homedir(), ".openclaw");
  if (source === "cordis") return join(homedir(), ".cordis");
  return join(homedir(), ".hermes");
}

function parseArgs(args: string[]): HistoryDiscoverCommandOptions {
  const values = readFlags(args);
  const source = parseSource(values.get("--source"));
  return {
    source,
    sourcePath: values.get("--root")
  };
}

function parseSource(value: string | undefined): ImportSource {
  if (value === "claude-code" || value === "openclaw" || value === "hermes" || value === "cordis") return value;
  throw new Error("Missing or unsupported --source. Use claude-code, openclaw, hermes, or cordis.");
}

export function readFlags(args: string[]): Map<string, string> {
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
  const result = await runHistoryDiscoverCommand(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
