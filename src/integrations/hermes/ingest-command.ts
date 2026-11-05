import { pathToFileURL } from "node:url";
import { z } from "zod";
import { HERMES_WRAPPER_DEPRECATION } from "./deprecation.js";
import { callHermesMemoryTool, type HermesMcpTarget } from "./mcp-session.js";
import { HermesTimelineRowSchema, type HermesTimelineRow } from "./contract.js";

const IngestOptionsSchema = z.object({
  configPath: z.string().min(1),
  profileName: z.string().min(1),
  input: z.string().min(1)
});

export interface HermesIngestResult {
  ok: true;
  turnId: string | null;
  completedTopic: null;
  summaryId: null;
  status: "APPENDED" | "REPLAYED" | "IGNORED_CONTROL";
  deprecation: string;
}

const CONTROL = /^\/(new|clear|reset|compress|resume)(?:\s|$)/i;

export async function ingestHermesTimelineRow(options: {
  configPath: string;
  profileName: string;
  input: string;
}): Promise<HermesIngestResult> {
  const parsed = IngestOptionsSchema.parse(options);
  const row = HermesTimelineRowSchema.parse(JSON.parse(parsed.input));
  if (CONTROL.test(row.content.trim())) {
    return {
      ok: true,
      turnId: null,
      completedTopic: null,
      summaryId: null,
      status: "IGNORED_CONTROL",
      deprecation: HERMES_WRAPPER_DEPRECATION
    };
  }

  const target: HermesMcpTarget = { configPath: parsed.configPath, profileName: parsed.profileName };
  const result = await callHermesMemoryTool(target, "memory_append_turn", appendArguments(row));
  if (result.isError || !result.structuredContent) {
    throw new Error(result.text || "Hermes ingest failed.");
  }
  const turnId = typeof result.structuredContent.turnId === "string" ? result.structuredContent.turnId : null;
  const status = result.structuredContent.status === "REPLAYED" ? "REPLAYED" : "APPENDED";
  return {
    ok: true,
    turnId,
    completedTopic: null,
    summaryId: null,
    status,
    deprecation: HERMES_WRAPPER_DEPRECATION
  };
}

const appendArguments = (row: HermesTimelineRow): Record<string, unknown> => ({
  host: "hermes",
  hostSessionId: row.session_id,
  turnId: row.id,
  sequence: row.sequence,
  role: row.role,
  content: row.content,
  createdAt: row.created_at,
  metadata: {
    channel: row.channel,
    hermesProfileId: row.profile_id,
    sourceMetadata: parseMetadata(row.metadata_json)
  }
});

const parseMetadata = (metadataJson: string | null): Record<string, unknown> => {
  if (!metadataJson) return {};
  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

export async function main(argv: string[]): Promise<void> {
  const target = parseTarget(argv);
  const input = await readStdin();
  const result = await ingestHermesTimelineRow({ ...target, input });
  process.stderr.write(`${HERMES_WRAPPER_DEPRECATION}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseTarget(args: string[]): { configPath: string; profileName: string } {
  if (args.includes("--db") || args.some((arg) => arg.startsWith("--db="))) {
    throw new Error("hermes:ingest does not accept --db. Pass --config <profiles.json> and --profile <name>.");
  }
  const configPath = flag(args, "--config");
  const profileName = flag(args, "--profile");
  if (!configPath || !profileName) {
    throw new Error("Pass --config <profiles.json> and --profile <name>.");
  }
  return { configPath, profileName };
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  const prefixed = args.find((arg) => arg.startsWith(`${name}=`));
  return prefixed ? prefixed.slice(name.length + 1) : undefined;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
