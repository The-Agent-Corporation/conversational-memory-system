import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SourceLifecycleService } from "../service/source-lifecycle-service.js";
import { SqliteStore } from "../storage/sqlite-store.js";
import { readFlags } from "./history-discover-command.js";

export async function runQuarantineListCommand(options: {
  databasePath: string;
  personId: string;
  candidateId?: string;
}) {
  const store = new SqliteStore(options.databasePath);
  try {
    const records = await store.listQuarantineRecords(options.personId, options.candidateId);
    return { ok: true as const, records, count: records.length };
  } finally {
    store.close();
  }
}

export async function runQuarantineReplayCommand(options: {
  databasePath: string;
  personId: string;
  candidateId: string;
  confirmedCandidateId: string;
  requestedAt?: string;
}) {
  const store = new SqliteStore(options.databasePath);
  try {
    const recordCount = await new SourceLifecycleService(store).requestQuarantineReplay({
      personId: options.personId,
      candidateId: options.candidateId,
      confirmedCandidateId: options.confirmedCandidateId,
      actor: "user",
      requestedAt: options.requestedAt ?? new Date().toISOString()
    });
    return { ok: true as const, candidateId: options.candidateId, recordCount };
  } finally {
    store.close();
  }
}

function required(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

export async function main(argv: string[]): Promise<void> {
  const [operation, ...args] = argv;
  const flags = readFlags(args);
  const databasePath = resolve(required(flags, "--db"));
  const personId = required(flags, "--person");
  const result = operation === "list"
    ? await runQuarantineListCommand({
        databasePath,
        personId,
        candidateId: flags.get("--candidate")
      })
    : operation === "replay"
      ? await runQuarantineReplayCommand({
          databasePath,
          personId,
          candidateId: required(flags, "--candidate"),
          confirmedCandidateId: required(flags, "--confirm")
        })
      : (() => { throw new Error("Use list or replay."); })();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
