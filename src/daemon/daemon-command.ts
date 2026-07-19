import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { z } from "zod";
import { readDaemonStatusSnapshot, type DaemonStatusSnapshot } from "../bootstrap/status-command.js";
import { SqliteStore } from "../storage/sqlite-store.js";
import { ApprovedSourceRunner } from "./approved-source-runner.js";
import { ContractionRunner } from "./contraction-runner.js";
import { DaemonLoop, type DaemonOnceResult, type DaemonRunResult } from "./daemon.js";
import { MacOSLaunchAgent, type LaunchAgentStatus } from "./macos/launch-agent.js";
import { MacOSNotificationAdapter } from "./macos/notification.js";
import { MacOSPowerSource } from "./macos/power-source.js";
import { ProposalScheduler } from "./proposal-scheduler.js";
import type { CommandRunner, SignalAdapter } from "./runtime-adapters.js";
import { DaemonScheduler } from "./scheduler.js";

export const DaemonSubcommandSchema = z.enum(["run", "start", "stop", "restart", "status", "once"]);
export type DaemonSubcommand = z.infer<typeof DaemonSubcommandSchema>;

const DaemonCommandOptionsSchema = z.object({
  subcommand: DaemonSubcommandSchema,
  databasePath: z.string().min(1),
  personId: z.string().min(1).optional()
}).strict().superRefine((value, context) => {
  if (value.personId && value.subcommand !== "status") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "--person is valid only for status" });
  }
});

export interface DaemonCommandOptions {
  subcommand: DaemonSubcommand;
  databasePath: string;
  personId?: string;
}

type CommandError = { code: "lease_conflict" | "capability_unavailable" | "invalid_request"; message: string };

export type DaemonCommandResult =
  | { ok: true; subcommand: "run"; result: DaemonRunResult }
  | { ok: true; subcommand: "once"; result: DaemonOnceResult }
  | { ok: true; subcommand: "status"; status: DaemonStatusSnapshot | Record<string, unknown> }
  | { ok: true; subcommand: "start" | "stop" | "restart"; service: LaunchAgentStatus }
  | { ok: false; subcommand: DaemonSubcommand; error: CommandError };

export interface DaemonCommandDependencies {
  createLoop(databasePath: string): {
    run(signal?: AbortSignal): Promise<DaemonRunResult>;
    runOnce(): Promise<DaemonOnceResult>;
  };
  launchAgent: {
    start(): Promise<LaunchAgentStatus>;
    stop(): Promise<LaunchAgentStatus>;
    status(): Promise<LaunchAgentStatus>;
  };
  readStatus(databasePath: string, personId?: string, serviceStatus?: LaunchAgentStatus): Promise<DaemonStatusSnapshot | Record<string, unknown>>;
  requestStop(databasePath: string): Promise<DaemonStatusSnapshot | Record<string, unknown>>;
  signal(pid: number, ownerToken: string): Promise<void>;
  waitForRelease?(databasePath: string, ownerToken: string): Promise<void>;
}

export function parseDaemonCommandArgs(args: string[]): DaemonCommandOptions {
  const subcommand = args[0];
  if (!subcommand || !DaemonSubcommandSchema.safeParse(subcommand).success) {
    throw new Error("Missing or unknown daemon subcommand; use run, start, stop, restart, status, or once.");
  }
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) throw new Error(`Unknown daemon argument: ${argument}`);
    const separator = argument.indexOf("=");
    const flag = separator >= 0 ? argument.slice(0, separator) : argument;
    if (flag !== "--db" && flag !== "--person") throw new Error(`Unknown daemon option: ${flag}`);
    const value = separator >= 0 ? argument.slice(separator + 1) : args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    values.set(flag, value);
  }
  const databasePath = values.get("--db");
  if (!databasePath) throw new Error("Missing memory database path. Pass --db <path>.");
  const parsed = DaemonCommandOptionsSchema.parse({
    subcommand,
    databasePath: resolve(databasePath),
    personId: values.get("--person")
  });
  return parsed;
}

export async function runDaemonCommand(
  options: DaemonCommandOptions,
  dependencies?: DaemonCommandDependencies
): Promise<DaemonCommandResult> {
  const parsed = DaemonCommandOptionsSchema.parse({ ...options, databasePath: resolve(options.databasePath) });
  const runtime = dependencies ?? createDefaultDependencies(parsed.databasePath);
  try {
    if (parsed.subcommand === "run") {
      return { ok: true, subcommand: "run", result: await runtime.createLoop(parsed.databasePath).run() };
    }
    if (parsed.subcommand === "once") {
      return { ok: true, subcommand: "once", result: await runtime.createLoop(parsed.databasePath).runOnce() };
    }
    if (parsed.subcommand === "status") {
      const service = await runtime.launchAgent.status();
      return {
        ok: true,
        subcommand: "status",
        status: await runtime.readStatus(parsed.databasePath, parsed.personId, service)
      };
    }
    if (parsed.subcommand === "start") {
      const service = await runtime.launchAgent.start();
      if (!service.capable) return capabilityError(parsed.subcommand);
      return { ok: true, subcommand: "start", service };
    }
    if (parsed.subcommand === "stop") {
      const service = await gracefulStop(runtime, parsed.databasePath);
      return { ok: true, subcommand: "stop", service };
    }
    await gracefulStop(runtime, parsed.databasePath, false);
    const service = await runtime.launchAgent.start();
    if (!service.capable) return capabilityError(parsed.subcommand);
    return { ok: true, subcommand: "restart", service };
  } catch (error) {
    return {
      ok: false,
      subcommand: parsed.subcommand,
      error: classifyCommandError(error)
    };
  }
}

async function gracefulStop(
  runtime: DaemonCommandDependencies,
  databasePath: string,
  signalOwner = true
): Promise<LaunchAgentStatus> {
  const status = await runtime.requestStop(databasePath);
  if (status.state === "running" || status.state === "stopping") {
    const pid = status.pid;
    const token = status.ownerToken;
    if (signalOwner && typeof pid === "number" && Number.isInteger(pid) && pid > 0 && typeof token === "string" && token) {
      await runtime.signal(pid, token);
    }
    if (typeof token === "string" && token) await runtime.waitForRelease?.(databasePath, token);
  }
  return runtime.launchAgent.stop();
}

function createDefaultDependencies(databasePath: string): DaemonCommandDependencies {
  const commandRunner = new NodeCommandRunner();
  const root = resolve(process.cwd());
  const logs = dirname(databasePath);
  const launchAgent = new MacOSLaunchAgent({
    databasePath,
    repositoryRoot: root,
    plistPath: join(homedir(), "Library/LaunchAgents", "com.conversational-memory.daemon.plist"),
    stdoutPath: join(logs, "memory-daemon.out.log"),
    stderrPath: join(logs, "memory-daemon.err.log"),
    commandRunner,
    userDomain: `gui/${typeof process.getuid === "function" ? process.getuid() : 0}`,
    commandAvailable: (command) => process.platform === "darwin" && command === "/bin/launchctl"
  });
  return {
    createLoop: () => {
      const store = new SqliteStore(databasePath);
      const ownerToken = randomUUID();
      const authority = { kind: "daemon" as const, databaseId: "memory-db", ownerToken };
      const clock = { now: () => new Date().toISOString(), monotonicNow: () => performance.now() };
      const scheduler = new DaemonScheduler(store, { clock, authority });
      const signals: SignalAdapter = {
        on: (signal, listener) => process.on(signal, listener),
        off: (signal, listener) => process.off(signal, listener)
      };
      const notification = new MacOSNotificationAdapter({ commandRunner });
      const loop = new DaemonLoop({
        store,
        scheduler,
        clock,
        timers: {
          setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
          clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout)
        },
        watcherFactory: {
          watch: (path, listener) => {
            const handle = watch(path, (eventType, filename) => listener({
              path: filename ? join(path, filename.toString()) : path,
              eventType: eventType === "rename" ? "rename" : "change"
            }));
            return { close: () => handle.close() };
          }
        },
        power: new MacOSPowerSource({ commandRunner }),
        notifier: { notify: (item) => notification.notify(item) },
        signals,
        sourceRunner: {
          run: ({ personId, candidateId, authority: captured }) =>
            new ApprovedSourceRunner(store, { authority: captured }).runGrant(personId, candidateId)
        },
        contractionRunner: {
          drainSlice: (personId, jobId, captured) =>
            new ContractionRunner(store, { clock, authority: captured }).drainSlice(personId, jobId)
        },
        proposalScheduler: {
          runDue: (personId, captured) =>
            new ProposalScheduler(store, { clock, authority: captured }).runDue(personId)
        }
      }, { databaseId: "memory-db", ownerToken, pid: process.pid });
      return {
        run: async (signal) => { try { return await loop.run(signal); } finally { store.close(); } },
        runOnce: async () => { try { return await loop.runOnce(); } finally { store.close(); } }
      };
    },
    launchAgent,
    readStatus: async (_path, personId, service) => withStore(databasePath, (store) =>
      readDaemonStatusSnapshot(store, new Date().toISOString(), service ?? null, personId)),
    requestStop: async () => withStore(databasePath, async (store) => {
      const status = await readDaemonStatusSnapshot(store, new Date().toISOString());
      if (status.ownerToken) await store.requestDaemonStop("memory-db", status.ownerToken, new Date().toISOString());
      return readDaemonStatusSnapshot(store, new Date().toISOString());
    }),
    signal: async (pid, ownerToken) => {
      await signalFreshDaemonOwner(databasePath, pid, ownerToken);
    },
    waitForRelease: async (_path, ownerToken) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const released = await withStore(databasePath, async (store) => {
          const lease = await store.getDaemonLease("memory-db");
          return !lease || lease.ownerToken !== ownerToken;
        });
        if (released) return;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
    }
  };
}

export async function signalFreshDaemonOwner(
  databasePath: string,
  pid: number,
  ownerToken: string,
  options: {
    now?: () => string;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
  } = {}
): Promise<boolean> {
  return withStore(databasePath, async (store) => {
    const lease = await store.getDaemonLease("memory-db");
    const now = options.now?.() ?? new Date().toISOString();
    if (!lease || lease.ownerToken !== ownerToken || lease.pid !== pid || Date.parse(lease.expiresAt) <= Date.parse(now)) {
      return false;
    }
    (options.kill ?? process.kill)(pid, "SIGTERM");
    return true;
  });
}

async function withStore<T>(databasePath: string, action: (store: SqliteStore) => Promise<T>): Promise<T> {
  const store = new SqliteStore(databasePath);
  try { return await action(store); } finally { store.close(); }
}

class NodeCommandRunner implements CommandRunner {
  async run(command: string, args: string[] = []) {
    try { await access(command); } catch { return { exitCode: 127, stdout: "", stderr: "" }; }
    return new Promise<{ exitCode: number; stdout: string; stderr: string }>((complete) => {
      execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
        complete({ exitCode: typeof error?.code === "number" ? error.code : error ? 1 : 0, stdout, stderr });
      });
    });
  }
}

function classifyCommandError(error: unknown): CommandError {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("lease") || message.includes("writer") || message.includes("already running")) {
    return { code: "lease_conflict", message: "Memory daemon is already running." };
  }
  if (message.includes("capability") || message.includes("launchctl")) {
    return { code: "capability_unavailable", message: "Requested operating-system capability is unavailable." };
  }
  return { code: "invalid_request", message: "Memory daemon request could not be completed." };
}

function capabilityError(subcommand: DaemonSubcommand): DaemonCommandResult {
  return {
    ok: false,
    subcommand,
    error: { code: "capability_unavailable", message: "macOS LaunchAgent capability is unavailable." }
  };
}

async function main(): Promise<void> {
  const options = parseDaemonCommandArgs(process.argv.slice(2));
  const result = await runDaemonCommand(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("Memory daemon command failed.\n");
    process.exitCode = 1;
  });
}
