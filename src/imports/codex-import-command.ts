import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { SqliteStore } from "../storage/sqlite-store.js";
import { approveCodexHistory, discoverCodexHistory } from "./codex-discovery.js";
import { CodexHistoryImporter } from "./codex-importer.js";
import { SourceLifecycleService } from "../service/source-lifecycle-service.js";
import type { CodexImportResult } from "./types.js";
export { planConfiguredHistoryImport } from "./history-import-command.js";

const CodexImportCommandOptionsSchema = z.object({
  databasePath: z.string().min(1),
  rootPath: z.string().min(1),
  approvedCandidateId: z.string().min(1),
  personId: z.string().min(1),
  profileId: z.string().min(1).default("default"),
  scopeId: z.string().min(1).default("personal"),
  requestedAt: z.string().datetime().optional()
});

export interface CodexImportCommandOptions {
  databasePath: string;
  rootPath: string;
  approvedCandidateId: string;
  personId: string;
  profileId?: string;
  scopeId?: string;
  requestedAt?: string;
}

export interface CodexImportCommandResult {
  ok: true;
  candidateId: string;
  import: CodexImportResult;
  canonicalEventCount: number;
  checkpointCount: number;
}

export const runCodexImportCommand = async (
  options: CodexImportCommandOptions
): Promise<CodexImportCommandResult> => {
  const parsed = CodexImportCommandOptionsSchema.parse(options);
  const candidate = await discoverCodexHistory(parsed.rootPath, parsed.requestedAt);
  if (candidate.id !== parsed.approvedCandidateId) {
    throw new Error(
      `Codex history import requires approval for candidate ${candidate.id}`
    );
  }

  const requestedAt = parsed.requestedAt ?? new Date().toISOString();
  const approval = approveCodexHistory(
    candidate,
    parsed.personId,
    parsed.profileId,
    requestedAt,
    parsed.scopeId
  );
  const store = new SqliteStore(parsed.databasePath);

  try {
    const lifecycle = new SourceLifecycleService(store);
    await lifecycle.approve({
      personId: parsed.personId,
      candidateId: candidate.id,
      application: candidate.application,
      format: candidate.format,
      sourceLocator: candidate.rootPath,
      profileId: parsed.profileId,
      scopeId: parsed.scopeId,
      approvedAt: requestedAt
    });
    await lifecycle.assertApproved(parsed.personId, candidate.id);
    const importer = new CodexHistoryImporter(store, { clock: () => requestedAt });
    const importResult = await importer.importApprovedSource(approval);
    const [canonicalEvents, checkpoints] = await Promise.all([
      store.listCanonicalEvents(parsed.personId),
      store.listImportCheckpoints(parsed.personId)
    ]);
    return {
      ok: true,
      candidateId: candidate.id,
      import: importResult,
      canonicalEventCount: canonicalEvents.length,
      checkpointCount: checkpoints.length
    };
  } finally {
    store.close();
  }
};

const defaultCodexRoot = (): string => process.env.CODEX_HOME ?? join(homedir(), ".codex");

const parseArgs = (args: string[]): CodexImportCommandOptions => {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--") && arg.includes("=")) {
      const separator = arg.indexOf("=");
      values.set(arg.slice(0, separator), arg.slice(separator + 1));
      continue;
    }
    if (arg.startsWith("--") && args[index + 1]) {
      values.set(arg, args[index + 1]);
      index += 1;
    }
  }

  const databasePath = values.get("--db");
  const approvedCandidateId = values.get("--approve");
  const personId = values.get("--person");
  if (!databasePath) {
    throw new Error("Missing memory database path. Pass --db <path>.");
  }
  if (!approvedCandidateId) {
    throw new Error("Missing explicit source approval. Pass --approve <candidate-id> from discovery.");
  }
  if (!personId) {
    throw new Error("Missing person identity. Pass --person <person-id>.");
  }

  return {
    databasePath,
    rootPath: resolve(values.get("--root") ?? defaultCodexRoot()),
    approvedCandidateId,
    personId,
    profileId: values.get("--profile") ?? "default",
    scopeId: values.get("--scope") ?? "personal"
  };
};

export const main = async (argv: string[]): Promise<void> => {
  const result = await runCodexImportCommand(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
