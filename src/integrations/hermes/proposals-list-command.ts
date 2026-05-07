import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ProposalStateSchema, ProposalTypeSchema } from "../../domain/types.js";
import { ProposalReviewer, type ProposalListResult } from "../../proposals/proposal-reviewer.js";
import { SqliteStore } from "../../storage/sqlite-store.js";

const ListOptionsSchema = z.object({
  databasePath: z.string().min(1),
  input: z.string().min(1)
});

const HermesProposalListRequestSchema = z.object({
  state: ProposalStateSchema.optional(),
  proposal_type: ProposalTypeSchema.optional(),
  limit: z.number().int().positive().optional(),
  include_payload: z.boolean().optional()
});

export type HermesProposalListResult = ProposalListResult;

export async function listHermesProposals(options: {
  databasePath: string;
  input: string;
}): Promise<HermesProposalListResult> {
  const parsedOptions = ListOptionsSchema.parse(options);
  const request = HermesProposalListRequestSchema.parse(JSON.parse(parsedOptions.input));
  const store = new SqliteStore(parsedOptions.databasePath);

  try {
    const reviewer = new ProposalReviewer(store);
    return await reviewer.listProposals({
      state: request.state,
      proposalType: request.proposal_type,
      limit: request.limit,
      includePayload: request.include_payload
    });
  } finally {
    store.close();
  }
}

async function main(): Promise<void> {
  const databasePath = parseDatabasePath(process.argv.slice(2));
  const input = await readStdin();
  const result = await listHermesProposals({ databasePath, input: input.trim() || "{}" });
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
