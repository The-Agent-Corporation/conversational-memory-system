import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { z } from "zod";
import { readDaemonStatusSnapshot, type DaemonStatusSnapshot } from "../bootstrap/status-command.js";
import type { Embedder } from "../embeddings/embedder.js";
import { probeEmbedderHealth, resolveEmbedder } from "../embeddings/embedder-resolver.js";
import { SqliteStore } from "../storage/sqlite-store.js";
import type { MemoryStore } from "../storage/memory-store.js";
import { ApprovedSourceRunner } from "./approved-source-runner.js";
import { ContractionRunner } from "./contraction-runner.js";
import { DaemonLoop, type DaemonLoopDependencies, type DaemonOnceResult, type DaemonRunResult } from "./daemon.js";
import { EmbeddingRepairRunner } from "./embedding-repair.js";
import { MacOSLaunchAgent, type LaunchAgentStatus } from "./macos/launch-agent.js";
import { MacOSNotificationAdapter } from "./macos/notification.js";
import { MacOSPowerSource } from "./macos/power-source.js";
import { ProposalScheduler } from "./proposal-scheduler.js";
import type { CommandRunner, SignalAdapter } from "./runtime-adapters.js";
import { DaemonScheduler } from "./scheduler.js";
import { HttpSyncRelay } from "../sync/transport/http-sync-relay.js";
import { LibsodiumCryptoProvider } from "../sync/crypto/libsodium-crypto-provider.js";
import { SyncReplicationService, type ResolveOperationContent } from "../sync/replication/sync-replication-service.js";
import type { ActiveDeviceMembership } from "../sync/replication/replay-verifier.js";
import type { DeviceSecretStore } from "../sync/secrets/device-secret-store.js";

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

/**
 * Resolves the optional production sync-replication daemon dependency from environment
 * configuration (Task 06-08-02). Absent (`undefined`) is the default and fully supported state --
 * the daemon behaves identically to Phase 05 with no sync configured. When
 * `MEMORY_SYNC_RELAY_BASE_URL` IS set, this function enforces HTTPS (or an explicit
 * `MEMORY_SYNC_RELAY_ALLOW_INSECURE_LOOPBACK=true` acknowledgement for a loopback test
 * deployment only) and constructs the real Plan 06 `HttpSyncRelay` -- there is no code path here
 * that can select a fake/in-process relay from this env-driven composition point; fake relays
 * reach `DaemonLoopDependencies.syncReplication` only through explicit test injection.
 *
 * Device signing/AEAD secret retrieval uses the exact `DeviceSecretStore` binding/byte
 * convention `SyncControlService.createDeviceIdentity`/`storeEpochKey` (Plan 06-06) already
 * writes (`device_signing_seed` = concatenated publicKey(32)+secretKey(64);
 * `epoch_key` secretId `epoch:{n}`), so a device already enrolled through that control-service
 * flow is directly consumable here without any new secret-retention convention. Selecting the
 * concrete `DeviceSecretStore` adapter (production `MacosKeychainSecretStore` vs. a test double)
 * is the caller's responsibility -- spawning/packaging the Swift Keychain helper binary is Plan
 * 06-03's own deployment concern and stays outside this plan's declared file scope.
 */
export function resolveProductionSyncReplicationDependency(
  store: MemoryStore,
  clock: { now(): string },
  deviceSecretStore: DeviceSecretStore | undefined
): DaemonLoopDependencies["syncReplication"] | undefined {
  const baseUrl = process.env.MEMORY_SYNC_RELAY_BASE_URL;
  if (!baseUrl) return undefined;

  const allowInsecureLoopback = process.env.MEMORY_SYNC_RELAY_ALLOW_INSECURE_LOOPBACK === "true";
  if (!baseUrl.startsWith("https://") && !allowInsecureLoopback) {
    throw new Error(
      "MEMORY_SYNC_RELAY_BASE_URL must be an https:// URL in production. Set " +
      "MEMORY_SYNC_RELAY_ALLOW_INSECURE_LOOPBACK=true only for an explicit local loopback test deployment."
    );
  }
  const tokenPath = process.env.MEMORY_SYNC_RELAY_TOKEN_PATH;
  const personId = process.env.MEMORY_SYNC_PERSON_ID;
  const syncId = process.env.MEMORY_SYNC_ID;
  const deviceId = process.env.MEMORY_SYNC_DEVICE_ID;
  const epoch = process.env.MEMORY_SYNC_EPOCH ? Number(process.env.MEMORY_SYNC_EPOCH) : NaN;
  if (!tokenPath || !personId || !syncId || !deviceId || !Number.isInteger(epoch) || epoch < 1) {
    throw new Error(
      "MEMORY_SYNC_RELAY_BASE_URL is configured but one or more of MEMORY_SYNC_RELAY_TOKEN_PATH, " +
      "MEMORY_SYNC_PERSON_ID, MEMORY_SYNC_ID, MEMORY_SYNC_DEVICE_ID, MEMORY_SYNC_EPOCH is missing or invalid."
    );
  }
  if (!deviceSecretStore) {
    // Transport configuration is present and valid, but no device-secret adapter was injected
    // (e.g. the production macOS Keychain helper is not wired into this process). Sync stays a
    // documented no-op rather than fabricating placeholder crypto identity.
    return undefined;
  }

  const relay = new HttpSyncRelay({
    baseUrl,
    bearerToken: async () => (await readFile(tokenPath, "utf8")).trim(),
    allowInsecureLoopback,
    logger: () => {} // content-free: never logs the bearer token, URL, or any plaintext
  });
  const crypto = new LibsodiumCryptoProvider();
  const binding = { personId, syncId, deviceId };

  return {
    runCycle: async () => {
      const signingSecret = await deviceSecretStore.read({ binding, kind: "device_signing_seed", secretId: deviceId });
      const epochKeySecret = await deviceSecretStore.read({ binding: { ...binding, epoch }, kind: "epoch_key", secretId: `epoch:${epoch}` });
      const signingSecretKey = signingSecret.bytes.slice(32); // publicKey(32) + secretKey(64) convention
      const aeadKey = epochKeySecret.bytes;

      // Real per-device active membership resolution (control-record parsing) is
      // SyncControlService/relay-client wiring outside this plan's declared file scope; this
      // composition point pushes/pulls this device's own stream only until a follow-up plan
      // supplies the durable membership snapshot needed for full multi-device pull fan-out.
      const membership = new Map<string, ActiveDeviceMembership>([
        [deviceId, { deviceId, signingPublicKey: signingSecret.bytes.slice(0, 32), active: true }]
      ]);
      const resolveOperationContent: ResolveOperationContent = async () => null; // no wire-schema producer wiring yet (see SUMMARY)

      const replication = new SyncReplicationService({
        store,
        relay,
        crypto,
        personId,
        syncId,
        deviceId,
        signingSecretKey,
        aeadKey,
        epoch,
        membership: () => membership,
        resolveOperationContent,
        buildMaterializationContext: async () => ({
          personId,
          activeScopeIds: new Set<string>(),
          activeSourceIds: new Set<string>(),
          knownOperationIds: new Set<string>()
        }),
        clock: () => clock.now()
      });
      const pushResult = await replication.pushPending();
      const pullResult = await replication.pullAndApply();
      return { pushResult, pullResult };
    }
  };
}

function createDefaultDependencies(databasePath: string, deviceSecretStore?: DeviceSecretStore): DaemonCommandDependencies {
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

      // REQ-043 / ADR 0052 — ONE embedder per PROCESS, never one per tick.
      //
      // `createLoop` is synchronous and `new DaemonLoop({...})` below takes every dependency
      // synchronously, while an embedder can only be resolved asynchronously (72-121 ms of ONNX
      // session construction, T-12-17). So the embedder cannot be a conditionally-spread
      // dependency the way `syncReplication` is: it is resolved into this closure variable by the
      // memoized initializer, awaited at the top of both `run` and `runOnce` below, and read by
      // the per-slice `contractionRunner` closure at call time — by which point it has settled.
      //
      // Plan 12-04 wires a second dependency that reads this same variable. Do not rename it.
      let summaryEmbedder: Embedder | undefined;
      // REQ-043 / Plan 12-04 — the bounded repair pass, built in the SAME initializer so it reuses
      // the one resolved embedder. Never resolve a second one here: that is a second ONNX session
      // per process, 72-121 ms (T-12-23).
      let repairRunner: EmbeddingRepairRunner | undefined;
      let embedderInitialization: Promise<void> | undefined;
      const initializeEmbedder = async (): Promise<void> => {
        embedderInitialization ??= (async () => {
          // Probe FIRST (D-06): unlike the resolver, the probe never throws. A corrupt model file
          // therefore degrades the daemon to "no new vectors, reason surfaced" instead of stopping
          // memory formation. Nothing silently falls back — when the embedder is unhealthy or
          // disabled, ZERO vectors are written by anything, which is the only safe non-ONNX
          // behavior given that a mixed-provider store is hard-errored by design (D-05, T-12-16).
          const health = await probeEmbedderHealth(databasePath);
          if (!health.enabled) return;
          if (!health.healthy) {
            process.stderr.write(`${JSON.stringify({
              event: "embedder_unhealthy",
              provider: health.provider,
              model: health.model,
              reason: health.reason
            })}\n`);
            return;
          }
          summaryEmbedder = await resolveEmbedder(databasePath);
          repairRunner = new EmbeddingRepairRunner({ store, embedder: summaryEmbedder, clock });
        })();
        await embedderInitialization;
      };

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
            new ContractionRunner(store, { clock, authority: captured, summaryEmbedder }).drainSlice(personId, jobId)
        },
        proposalScheduler: {
          runDue: (personId, captured) =>
            new ProposalScheduler(store, { clock, authority: captured }).runDue(personId)
        },
        // ALWAYS spread, never conditionally (F2). `syncReplication` below can be conditional
        // because it is resolved synchronously, right here; the repair runner cannot, because it
        // depends on an embedder that does not exist until `initializeEmbedder()` runs inside
        // `run`/`runOnce` — after this object is constructed. So the dependency is always present
        // and "no embedder" is expressed as a `runDue` that no-ops without touching the store.
        embeddingRepair: { runDue: async () => repairRunner?.runDue() },
        ...(() => {
          const syncReplication = resolveProductionSyncReplicationDependency(store, clock, deviceSecretStore);
          return syncReplication ? { syncReplication } : {};
        })()
      }, { databaseId: "memory-db", ownerToken, pid: process.pid });
      return {
        run: async (signal) => {
          try {
            await initializeEmbedder();
            return await loop.run(signal);
          } finally { store.close(); }
        },
        runOnce: async () => {
          try {
            await initializeEmbedder();
            return await loop.runOnce();
          } finally { store.close(); }
        }
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

export async function main(argv: string[]): Promise<void> {
  const options = parseDaemonCommandArgs(argv);
  const result = await runDaemonCommand(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write("Memory daemon command failed.\n");
    process.exitCode = 1;
  });
}
