import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { createProfileAuthority, type ProfileAuthority } from "../mcp/authority.js";
import { SqliteStore } from "../storage/sqlite-store.js";
import { readFlags } from "../imports/history-discover-command.js";
import { explain, type ExplainTrace } from "./explain-service.js";

const OptionsSchema = z.object({
  databasePath: z.string().min(1),
  personId: z.string().min(1),
  itemId: z.string().min(1),
  allScopes: z.boolean().optional()
});

export interface ExplainCommandOptions {
  databasePath: string;
  personId: string;
  itemId: string;
  allScopes?: boolean;
}

export interface ExplainCommandResult {
  ok: true;
  trace: ExplainTrace;
}

/**
 * CLI `memory explain <id>` (D-01a). Runs with local-owner authority: the CLI operator is the
 * profile owner, so `--all-scopes` is available to inspect every scope they own. The MCP
 * `memory_explain` tool (read-tools.ts) never sets `allScopes` — it always routes through the
 * caller's already-bound ProfileAuthority, exactly like every other read tool.
 */
export async function runExplainCommand(options: ExplainCommandOptions): Promise<ExplainCommandResult> {
  const parsed = OptionsSchema.parse(options);
  const store = new SqliteStore(parsed.databasePath);
  try {
    const authority = ownerAuthority(parsed.personId, parsed.databasePath);
    const trace = await explain(store, parsed.itemId, authority, { allScopes: parsed.allScopes });
    return { ok: true, trace };
  } finally {
    store.close();
  }
}

const ownerAuthority = (personId: string, databasePath: string): ProfileAuthority =>
  createProfileAuthority({
    profileName: "cli-owner",
    databasePath,
    personId,
    allowedScopeIds: [],
    ingestScopeId: "personal",
    sourceRoots: {},
    scopeAliases: {}
  });

function parseArgs(args: string[]): ExplainCommandOptions {
  const values = readFlags(args);
  const databasePath = values.get("--db");
  const personId = values.get("--person");
  const itemId = values.get("--id");
  if (!databasePath) throw new Error("Missing memory database path. Pass --db <path>.");
  if (!personId) throw new Error("Missing person identity. Pass --person <person-id>.");
  if (!itemId) throw new Error("Missing item id to explain. Pass --id <item-id>.");
  return {
    databasePath: resolve(databasePath),
    personId,
    itemId,
    // readFlags requires `=` form for boolean flags (it always consumes a following bare
    // token as a value); `--all-scopes` alone as the final argument would be silently dropped.
    allScopes: values.get("--all-scopes") === "true"
  };
}

export async function main(argv: string[]): Promise<void> {
  const result = await runExplainCommand(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
