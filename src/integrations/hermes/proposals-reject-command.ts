import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ProposalReviewer, type ProposalRejectionResult } from "../../proposals/proposal-reviewer.js";
import { SqliteStore } from "../../storage/sqlite-store.js";

const RejectOptionsSchema = z.object({
  databasePath: z.string().min(1),
  input: z.string().min(1)
});

const HermesProposalDecisionRequestSchema = z.object({
  proposal_id: z.string().min(1),
  decided_at: z.string().datetime().optional(),
  reviewer: z.string().min(1).optional(),
  note: z.string().optional()
});

export type HermesProposalRejectResult = ProposalRejectionResult;

export async function rejectHermesProposal(options: {
  databasePath: string;
  input: string;
}): Promise<HermesProposalRejectResult> {
  const parsedOptions = RejectOptionsSchema.parse(options);
  const request = HermesProposalDecisionRequestSchema.parse(JSON.parse(parsedOptions.input));
  const store = new SqliteStore(parsedOptions.databasePath);

  try {
    const reviewer = new ProposalReviewer(store);
    return await reviewer.rejectProposal({
      proposalId: request.proposal_id,
      decidedAt: request.decided_at ?? new Date().toISOString(),
      reviewer: request.reviewer,
      note: request.note
    });
  } finally {
    store.close();
  }
}

async function main(): Promise<void> {
  const databasePath = parseDatabasePath(process.argv.slice(2));
  const input = await readStdin();
  const result = await rejectHermesProposal({ databasePath, input });
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
