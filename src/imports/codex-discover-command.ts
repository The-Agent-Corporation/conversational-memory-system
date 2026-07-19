import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { discoverCodexHistory } from "./codex-discovery.js";
import type { CodexHistoryCandidate } from "./types.js";

export interface CodexDiscoverCommandOptions {
  rootPath?: string;
  discoveredAt?: string;
}

export interface CodexDiscoverCommandResult {
  ok: true;
  approvalRequired: true;
  candidate: CodexHistoryCandidate;
}

export const runCodexDiscoverCommand = async (
  options: CodexDiscoverCommandOptions = {}
): Promise<CodexDiscoverCommandResult> => ({
  ok: true,
  approvalRequired: true,
  candidate: await discoverCodexHistory(
    resolve(options.rootPath ?? defaultCodexRoot()),
    options.discoveredAt
  )
});

const defaultCodexRoot = (): string => process.env.CODEX_HOME ?? join(homedir(), ".codex");

const parseRootPath = (args: string[]): string | undefined => {
  const rootIndex = args.indexOf("--root");
  if (rootIndex >= 0 && args[rootIndex + 1]) {
    return args[rootIndex + 1];
  }
  const equalsArg = args.find((arg) => arg.startsWith("--root="));
  return equalsArg?.slice("--root=".length);
};

const main = async (): Promise<void> => {
  const result = await runCodexDiscoverCommand({
    rootPath: parseRootPath(process.argv.slice(2))
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
