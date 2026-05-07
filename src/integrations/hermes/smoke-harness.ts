import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { HermesIngestResult } from "./ingest-command.js";
import { ingestHermesTimelineRow } from "./ingest-command.js";
import type { HermesInjectResult } from "./inject-command.js";
import { injectHermesMemory } from "./inject-command.js";
import type { HermesResumeCommandResult } from "./resume-command.js";
import { resumeHermesMemory } from "./resume-command.js";

export interface HermesSmokeHarnessOptions {
  databasePath?: string;
  projectRoot?: string;
}

export interface RoscoeMemoryEnvironment {
  HERMES_CONVERSATIONAL_MEMORY_DB: string;
  HERMES_CONVERSATIONAL_MEMORY_ENABLED: string;
  HERMES_CONVERSATIONAL_MEMORY_COMMAND: string;
  HERMES_CONVERSATIONAL_MEMORY_INJECT_ENABLED: string;
  HERMES_CONVERSATIONAL_MEMORY_INJECT_COMMAND: string;
  HERMES_CONVERSATIONAL_MEMORY_RESUME_COMMAND: string;
  HERMES_CONVERSATIONAL_MEMORY_SLEEP_COMMAND: string;
  HERMES_CONVERSATIONAL_MEMORY_PROPOSALS_LIST_COMMAND: string;
  HERMES_CONVERSATIONAL_MEMORY_PROPOSALS_APPROVE_COMMAND: string;
  HERMES_CONVERSATIONAL_MEMORY_PROPOSALS_REJECT_COMMAND: string;
}

export interface HermesSmokeHarnessResult {
  ok: true;
  databasePath: string;
  roscoeEnvironment: RoscoeMemoryEnvironment;
  ingestedTurnIds: string[];
  compaction: HermesIngestResult;
  injection: HermesInjectResult;
  resume: HermesResumeCommandResult;
}

export async function runHermesMemorySmokeHarness(
  options: HermesSmokeHarnessOptions = {}
): Promise<HermesSmokeHarnessResult> {
  const databasePath = options.databasePath ?? await defaultDatabasePath();
  const projectRoot = options.projectRoot ?? process.cwd();
  const firstTurn = await ingestHermesTimelineRow({
    databasePath,
    input: JSON.stringify(timelineRow({
      id: "default:1",
      sequence: 1,
      role: "user",
      content: "Let's talk about Smith PIP."
    }))
  });
  const secondTurn = await ingestHermesTimelineRow({
    databasePath,
    input: JSON.stringify(timelineRow({
      id: "default:2",
      sequence: 2,
      role: "assistant",
      content: "The Smith PIP demand deadline is June 1."
    }))
  });
  const compaction = await ingestHermesTimelineRow({
    databasePath,
    input: JSON.stringify(timelineRow({
      id: "default:3",
      sequence: 3,
      role: "user",
      content: "/new",
      created_at: "2024-05-04T12:45:00.000Z"
    }))
  });
  const injection = await injectHermesMemory({
    databasePath,
    input: JSON.stringify({
      profile_id: "default",
      session_id: "profile:default",
      query: "Can we resume Smith PIP demand timing?",
      requested_at: "2024-05-04T13:00:00.000Z",
      max_memory_tokens: 80
    })
  });

  if (!injection.packet) {
    throw new Error("Smoke harness expected a Smith PIP memory injection packet.");
  }

  const resume = await resumeHermesMemory({
    databasePath,
    input: JSON.stringify({ injection_packet: injection.packet })
  });

  return {
    ok: true,
    databasePath,
    roscoeEnvironment: buildRoscoeMemoryEnvironment({ databasePath, projectRoot }),
    ingestedTurnIds: [firstTurn.turnId, secondTurn.turnId].filter(
      (turnId): turnId is string => turnId !== null
    ),
    compaction,
    injection,
    resume
  };
}

export function buildRoscoeMemoryEnvironment(options: {
  databasePath: string;
  projectRoot?: string;
}): RoscoeMemoryEnvironment {
  const projectRoot = options.projectRoot ?? process.cwd();

  return {
    HERMES_CONVERSATIONAL_MEMORY_DB: options.databasePath,
    HERMES_CONVERSATIONAL_MEMORY_ENABLED: "1",
    HERMES_CONVERSATIONAL_MEMORY_COMMAND: npmCommand(projectRoot, "hermes:ingest", options.databasePath),
    HERMES_CONVERSATIONAL_MEMORY_INJECT_ENABLED: "1",
    HERMES_CONVERSATIONAL_MEMORY_INJECT_COMMAND: npmCommand(projectRoot, "hermes:inject", options.databasePath),
    HERMES_CONVERSATIONAL_MEMORY_RESUME_COMMAND: npmCommand(projectRoot, "hermes:resume", options.databasePath),
    HERMES_CONVERSATIONAL_MEMORY_SLEEP_COMMAND: npmCommand(projectRoot, "hermes:sleep", options.databasePath),
    HERMES_CONVERSATIONAL_MEMORY_PROPOSALS_LIST_COMMAND: npmCommand(projectRoot, "hermes:proposals:list", options.databasePath),
    HERMES_CONVERSATIONAL_MEMORY_PROPOSALS_APPROVE_COMMAND: npmCommand(projectRoot, "hermes:proposals:approve", options.databasePath),
    HERMES_CONVERSATIONAL_MEMORY_PROPOSALS_REJECT_COMMAND: npmCommand(projectRoot, "hermes:proposals:reject", options.databasePath)
  };
}

function npmCommand(projectRoot: string, script: string, databasePath: string): string {
  return [
    "npm",
    "--silent",
    "--prefix",
    shellArg(projectRoot),
    "run",
    script,
    "--",
    "--db",
    shellArg(databasePath)
  ].join(" ");
}

function shellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}

function timelineRow(overrides: {
  id: string;
  sequence: number;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  created_at?: string;
}) {
  return {
    profile_id: "default",
    session_id: "profile:default",
    created_at: "2024-05-04T12:40:00.000Z",
    channel: "smoke-harness",
    metadata_json: null,
    ...overrides
  };
}

async function defaultDatabasePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cms-hermes-smoke-"));
  return join(dir, "memory.sqlite");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await runHermesMemorySmokeHarness(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseArgs(args: string[]): HermesSmokeHarnessOptions {
  const options: HermesSmokeHarnessOptions = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--db" && args[index + 1]) {
      options.databasePath = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--db=")) {
      options.databasePath = arg.slice("--db=".length);
      continue;
    }
    if (arg === "--project-root" && args[index + 1]) {
      options.projectRoot = resolve(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--project-root=")) {
      options.projectRoot = resolve(arg.slice("--project-root=".length));
    }
  }

  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
