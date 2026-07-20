import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SqliteStore } from "../storage/sqlite-store.js";
import { SourceLifecycleService } from "../service/source-lifecycle-service.js";
import { readFlags } from "./history-discover-command.js";

export async function runSourceRevokeCommand(options: {
  databasePath: string;
  personId: string;
  candidateId: string;
  requestedAt?: string;
}) {
  const store = new SqliteStore(options.databasePath);
  try {
    const revokedAt = options.requestedAt ?? new Date().toISOString();
    const grant = await new SourceLifecycleService(store).revoke(
      options.personId,
      options.candidateId,
      "user",
      revokedAt
    );
    return { ok: true as const, grant };
  } finally {
    store.close();
  }
}

export async function main(argv: string[]): Promise<void> {
  const flags = readFlags(argv);
  const databasePath = flags.get("--db");
  const personId = flags.get("--person");
  const candidateId = flags.get("--candidate");
  if (!databasePath || !personId || !candidateId) {
    throw new Error("Pass --db <path> --person <person-id> --candidate <candidate-id>.");
  }
  const result = await runSourceRevokeCommand({
    databasePath: resolve(databasePath),
    personId,
    candidateId
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
