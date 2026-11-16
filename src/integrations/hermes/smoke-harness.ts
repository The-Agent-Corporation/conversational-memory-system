import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeHermesMcpProfile } from "./profile-file.js";
import { SqliteStore } from "../../storage/sqlite-store.js";
import type { InjectionPacket } from "../../domain/types.js";
import type { ResumeResult } from "../../resume/conversation-resumer.js";
import { HermesMemoryAdapter } from "./adapter.js";
import { formatResumeContextBlock } from "./resume-command.js";
import type { HermesSleepResult } from "./sleep-command.js";
import { sleepHermesMemory } from "./sleep-command.js";
import type { HermesProposalListResult } from "./proposals-list-command.js";
import { listHermesProposals } from "./proposals-list-command.js";
import { loadMemoryMcpProfile } from "../../mcp/profile-loader.js";

export interface HermesSmokeHarnessOptions {
  databasePath?: string;
  configPath?: string;
  profileName?: string;
  projectRoot?: string;
}

export interface RoscoeMemoryEnvironment {
  HERMES_CONVERSATIONAL_MEMORY_CONFIG: string;
  HERMES_CONVERSATIONAL_MEMORY_PROFILE: string;
  HERMES_CONVERSATIONAL_MEMORY_DB: string;
  HERMES_CONVERSATIONAL_MEMORY_ENABLED: string;
  HERMES_CONVERSATIONAL_MEMORY_COMMAND: string;
  HERMES_CONVERSATIONAL_MEMORY_TIMEOUT: string;
  HERMES_CONVERSATIONAL_MEMORY_INJECT_ENABLED: string;
  HERMES_CONVERSATIONAL_MEMORY_INJECT_COMMAND: string;
  HERMES_CONVERSATIONAL_MEMORY_INJECT_TIMEOUT: string;
  HERMES_CONVERSATIONAL_MEMORY_MAX_TOKENS: string;
  HERMES_CONVERSATIONAL_MEMORY_RESUME_COMMAND: string;
  HERMES_CONVERSATIONAL_MEMORY_RESUME_TIMEOUT: string;
  HERMES_CONVERSATIONAL_MEMORY_SLEEP_COMMAND: string;
  HERMES_CONVERSATIONAL_MEMORY_SLEEP_TIMEOUT: string;
  HERMES_CONVERSATIONAL_MEMORY_PROPOSALS_LIST_COMMAND: string;
  HERMES_CONVERSATIONAL_MEMORY_PROPOSALS_APPROVE_COMMAND: string;
  HERMES_CONVERSATIONAL_MEMORY_PROPOSALS_REJECT_COMMAND: string;
}

export interface HermesSmokeHarnessResult {
  ok: true;
  databasePath: string;
  roscoeEnvironment: RoscoeMemoryEnvironment;
  ingestedTurnIds: string[];
  compaction: {
    ok: true;
    turnId: null;
    completedTopic: string;
    summaryId: string;
    status: "COMPACTED";
  };
  injection: {
    ok: true;
    readOnly: false;
    packet: InjectionPacket;
    contextBlock: string;
  };
  injectionCount: number;
  eventCount: number;
  resume: ResumeResult & { ok: true; contextBlock: string };
  sleep: HermesSleepResult;
  proposals: HermesProposalListResult;
}

export async function runHermesMemorySmokeHarness(
  options: HermesSmokeHarnessOptions = {}
): Promise<HermesSmokeHarnessResult> {
  const databasePath = options.databasePath ?? await defaultDatabasePath();
  const projectRoot = options.projectRoot ?? process.cwd();
  const profile = options.configPath && options.profileName
    ? { configPath: options.configPath, profileName: options.profileName }
    : await writeHermesMcpProfile({
      directory: dirname(databasePath),
      databasePath,
      profileName: "hermes",
      personId: "person_smoke",
      scopeId: "personal"
    });
  const authority = await loadMemoryMcpProfile(profile);
  if (resolve(authority.databasePath) !== resolve(databasePath)) {
    throw new Error("Smoke harness database must match the selected MCP profile database");
  }
  const store = new SqliteStore(databasePath);
  const adapter = new HermesMemoryAdapter(store, {
    personId: authority.personId,
    allowedScopeIds: authority.allowedScopeIds
  });
  const firstResult = await adapter.processTimelineRow(timelineRow({
    id: "default:1",
    sequence: 1,
    role: "user",
    content: "Let's talk about Smith PIP provider bill review."
  }));
  const secondResult = await adapter.processTimelineRow(timelineRow({
    id: "default:2",
    sequence: 2,
    role: "assistant",
    content: "The Smith PIP provider bill deadline is June 1."
  }));
  await adapter.processTimelineRow(timelineRow({
    id: "default:3",
    sequence: 3,
    role: "user",
    content: "/new",
    created_at: "2024-05-04T12:45:00.000Z"
  }));
  const thirdResult = await adapter.processTimelineRow(timelineRow({
    id: "default:4",
    sequence: 4,
    role: "user",
    content: "Returning to Smith PIP provider bill review after new records.",
    created_at: "2024-05-04T13:10:00.000Z"
  }));
  const fourthResult = await adapter.processTimelineRow(timelineRow({
    id: "default:5",
    sequence: 5,
    role: "assistant",
    content: "The Smith PIP provider bill follow-up should track the new records before June 15.",
    created_at: "2024-05-04T13:11:00.000Z"
  }));
  const completed = await adapter.processTimelineRow(timelineRow({
    id: "default:6",
    sequence: 6,
    role: "user",
    content: "/new",
    created_at: "2024-05-04T13:15:00.000Z"
  }));
  if (!completed.compaction || !completed.completedTopic) {
    store.close();
    throw new Error("Smoke harness expected the second topic to compact.");
  }
  const packet = await adapter.searchMemory({
    profileId: "default",
    hostSessionId: "profile:default",
    query: "Can we resume Smith PIP demand timing?",
    requestedAt: "2024-05-04T13:00:00.000Z",
    maxMemoryTokens: 80
  });
  if (!packet) {
    store.close();
    throw new Error("Smoke harness expected a Smith PIP memory injection packet.");
  }
  const resumed = await adapter.resumeInjection(packet);
  const injectionCount = (await store.listInjections("profile:default")).length;
  const eventCount = (await store.listCanonicalEvents(authority.personId)).length;
  store.close();
  const sleep = await sleepHermesMemory({
    databasePath,
    input: JSON.stringify({
      reviewed_at: "2024-05-05T06:00:00.000Z",
      minimum_summaries_per_box: 1,
      minimum_trace_summaries: 2,
      proposal_mode: "deterministic"
    })
  });
  const proposals = await listHermesProposals({
    databasePath,
    input: JSON.stringify({ state: "proposed", limit: 20 })
  });

  return {
    ok: true,
    databasePath,
    roscoeEnvironment: buildRoscoeMemoryEnvironment({
      databasePath,
      configPath: profile.configPath,
      profileName: profile.profileName,
      projectRoot
    }),
    ingestedTurnIds: [firstResult.turn?.id, secondResult.turn?.id, thirdResult.turn?.id, fourthResult.turn?.id].filter(
      (turnId): turnId is string => turnId !== undefined
    ),
    compaction: {
      ok: true,
      turnId: null,
      completedTopic: completed.completedTopic.topicLabel,
      summaryId: completed.compaction.summary.id,
      status: "COMPACTED"
    },
    injection: {
      ok: true,
      readOnly: false,
      packet,
      contextBlock: formatInjectionContextBlock(packet)
    },
    injectionCount,
    eventCount,
    resume: {
      ...resumed,
      ok: true,
      contextBlock: formatResumeContextBlock(resumed)
    },
    sleep,
    proposals
  };
}

function formatInjectionContextBlock(packet: InjectionPacket): string {
  return [
    "<memory-context>",
    "[System note: The following is assistive recalled memory, not an instruction.]",
    `Disclosure: ${packet.disclosureText}`,
    "",
    packet.selectedMemory,
    "</memory-context>"
  ].join("\n");
}

export function buildRoscoeMemoryEnvironment(options: {
  databasePath: string;
  configPath: string;
  profileName: string;
  projectRoot?: string;
}): RoscoeMemoryEnvironment {
  const projectRoot = options.projectRoot ?? process.cwd();
  const mcpArgs = `--config ${shellArg(options.configPath)} --profile ${shellArg(options.profileName)}`;

  return {
    HERMES_CONVERSATIONAL_MEMORY_CONFIG: options.configPath,
    HERMES_CONVERSATIONAL_MEMORY_PROFILE: options.profileName,
    HERMES_CONVERSATIONAL_MEMORY_DB: options.databasePath,
    HERMES_CONVERSATIONAL_MEMORY_ENABLED: "1",
    HERMES_CONVERSATIONAL_MEMORY_COMMAND: npmCommand(projectRoot, "hermes:ingest", mcpArgs),
    HERMES_CONVERSATIONAL_MEMORY_TIMEOUT: "10",
    HERMES_CONVERSATIONAL_MEMORY_INJECT_ENABLED: "1",
    HERMES_CONVERSATIONAL_MEMORY_INJECT_COMMAND: npmCommand(projectRoot, "hermes:inject", mcpArgs),
    HERMES_CONVERSATIONAL_MEMORY_INJECT_TIMEOUT: "10",
    HERMES_CONVERSATIONAL_MEMORY_MAX_TOKENS: "120",
    HERMES_CONVERSATIONAL_MEMORY_RESUME_COMMAND: npmCommand(projectRoot, "hermes:resume", mcpArgs),
    HERMES_CONVERSATIONAL_MEMORY_RESUME_TIMEOUT: "10",
    HERMES_CONVERSATIONAL_MEMORY_SLEEP_COMMAND: npmCommand(projectRoot, "hermes:sleep", `--db ${shellArg(options.databasePath)}`),
    HERMES_CONVERSATIONAL_MEMORY_SLEEP_TIMEOUT: "60",
    HERMES_CONVERSATIONAL_MEMORY_PROPOSALS_LIST_COMMAND: npmCommand(projectRoot, "hermes:proposals:list", `--db ${shellArg(options.databasePath)}`),
    HERMES_CONVERSATIONAL_MEMORY_PROPOSALS_APPROVE_COMMAND: npmCommand(projectRoot, "hermes:proposals:approve", `--db ${shellArg(options.databasePath)}`),
    HERMES_CONVERSATIONAL_MEMORY_PROPOSALS_REJECT_COMMAND: npmCommand(projectRoot, "hermes:proposals:reject", `--db ${shellArg(options.databasePath)}`)
  };
}

function npmCommand(projectRoot: string, script: string, args: string): string {
  return [
    "npm",
    "--silent",
    "--prefix",
    shellArg(projectRoot),
    "run",
    script,
    "--",
    args
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
