import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SourceLifecycleService } from "../service/source-lifecycle-service.js";
import { SqliteStore } from "../storage/sqlite-store.js";
import { readFlags } from "./history-discover-command.js";

export async function runSourceDeleteCommand(options: {
  databasePath: string;
  personId: string;
  candidateId: string;
  confirmedCandidateId: string;
  requestedAt?: string;
}) {
  const store = new SqliteStore(options.databasePath);
  try {
    const result = await new SourceLifecycleService(store).deleteRevokedSource({
      personId: options.personId,
      candidateId: options.candidateId,
      confirmedCandidateId: options.confirmedCandidateId,
      actor: "user",
      deletedAt: options.requestedAt ?? new Date().toISOString()
    });
    return { ok: true as const, deletion: result };
  } finally {
    store.close();
  }
}

async function main(): Promise<void> {
  const flags = readFlags(process.argv.slice(2));
  const databasePath = flags.get("--db");
  const personId = flags.get("--person");
  const candidateId = flags.get("--candidate");
  const confirmedCandidateId = flags.get("--confirm");
  if (!databasePath || !personId || !candidateId || !confirmedCandidateId) {
    throw new Error("Pass --db <path> --person <person-id> --candidate <candidate-id> --confirm <candidate-id>.");
  }
  const result = await runSourceDeleteCommand({
    databasePath: resolve(databasePath),
    personId,
    candidateId,
    confirmedCandidateId
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
