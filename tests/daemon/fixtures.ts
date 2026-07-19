import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SourceGrant } from "../../src/domain/source-lifecycle.js";
import type {
  DaemonNotification,
  NotificationApplicationIdentity,
  NotificationAttempt
} from "../../src/daemon/runtime-adapters.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export const FIXED_NOW = "2026-07-17T12:00:00.000Z";

export class FakeDaemonClock {
  private wallTimeMs: number;
  private monotonicTimeMs = 0;

  constructor(iso = FIXED_NOW) {
    this.wallTimeMs = Date.parse(iso);
  }

  now = (): string => new Date(this.wallTimeMs).toISOString();

  monotonicNow = (): number => this.monotonicTimeMs;

  advanceBy(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new Error("FakeDaemonClock can only advance by a non-negative finite duration");
    }
    this.wallTimeMs += milliseconds;
    this.monotonicTimeMs += milliseconds;
  }
}

interface PendingTimer {
  id: number;
  dueAt: number;
  callback: () => void | Promise<void>;
}

export class FakeTimerQueue {
  private nextId = 1;
  private readonly timers: PendingTimer[] = [];

  constructor(private readonly clock: FakeDaemonClock) {}

  setTimeout = (callback: () => void | Promise<void>, delayMs: number): number => {
    const id = this.nextId++;
    this.timers.push({ id, dueAt: this.clock.monotonicNow() + delayMs, callback });
    return id;
  };

  clearTimeout = (id: number): void => {
    const index = this.timers.findIndex((timer) => timer.id === id);
    if (index >= 0) this.timers.splice(index, 1);
  };

  pendingCount(): number {
    return this.timers.length;
  }

  async advanceBy(milliseconds: number): Promise<void> {
    this.clock.advanceBy(milliseconds);
    await this.runDue();
  }

  async runDue(): Promise<void> {
    for (;;) {
      this.timers.sort((left, right) => left.dueAt - right.dueAt || left.id - right.id);
      const next = this.timers[0];
      if (!next || next.dueAt > this.clock.monotonicNow()) return;
      this.timers.shift();
      await next.callback();
    }
  }
}

export interface FakeWatchEvent {
  path: string;
  eventType: "change" | "rename";
}

export class FakeWatcherFactory {
  readonly watchedPaths: string[] = [];
  readonly closedPaths: string[] = [];
  private readonly listeners = new Map<string, Set<(event: FakeWatchEvent) => void>>();

  watch(path: string, listener: (event: FakeWatchEvent) => void): { close(): void } {
    this.watchedPaths.push(path);
    const listeners = this.listeners.get(path) ?? new Set();
    listeners.add(listener);
    this.listeners.set(path, listeners);
    return {
      close: () => {
        listeners.delete(listener);
        this.closedPaths.push(path);
      }
    };
  }

  emit(path: string, eventType: FakeWatchEvent["eventType"] = "change"): void {
    for (const listener of this.listeners.get(path) ?? []) listener({ path, eventType });
  }
}

export type FakePowerState = "external" | "battery" | "unknown";

export class FakePowerStateProvider {
  private state: FakePowerState;

  constructor(initialState: FakePowerState = "external") {
    this.state = initialState;
  }

  getPowerState = async (): Promise<FakePowerState> => this.state;

  setPowerState(state: FakePowerState): void {
    this.state = state;
  }
}

export type FakeNotificationCall = DaemonNotification;

export const FAKE_NOTIFICATION_IDENTITY: NotificationApplicationIdentity = {
  displayName: "Injected Test Notifier",
  bundleIdentifier: "test.invalid.injected-notifier"
};

export class FakeNotificationAdapter {
  readonly calls: FakeNotificationCall[] = [];

  notify = async (notification: FakeNotificationCall): Promise<NotificationAttempt> => {
    this.calls.push(structuredClone(notification));
    return {
      capable: true,
      commandAccepted: true,
      presentation: "unverified",
      identity: FAKE_NOTIFICATION_IDENTITY
    };
  };
}

export interface FakeCommandCall {
  command: string;
  args: string[];
}

export interface FakeCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class FakeCommandRunner {
  readonly calls: FakeCommandCall[] = [];
  private readonly results: Array<FakeCommandResult | Error> = [];

  enqueueResult(result: Partial<FakeCommandResult>): void {
    this.results.push({ exitCode: 0, stdout: "", stderr: "", ...result });
  }

  enqueueError(error: Error): void {
    this.results.push(error);
  }

  run = async (command: string, args: string[] = []): Promise<FakeCommandResult> => {
    this.calls.push({ command, args: [...args] });
    const result = this.results.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
    if (result instanceof Error) throw result;
    return result;
  };
}

export class FaultBoundaryInjector {
  private readonly armed = new Set<string>();
  readonly reached: string[] = [];

  arm(boundary: string): void {
    this.armed.add(boundary);
  }

  reach(boundary: string): void {
    this.reached.push(boundary);
    if (this.armed.delete(boundary)) throw new Error(`Injected fault at ${boundary}`);
  }
}

type SupportedApplication = "codex" | "claude-code" | "openclaw" | "hermes";

export interface SyntheticApprovedSource {
  application: SupportedApplication;
  rootPath: string;
  nativePath: string;
  grant: SourceGrant;
}

export interface SyntheticSourceOptions {
  root?: string;
  personId?: string;
  scopeId?: string;
  profileId?: string;
  approvedAt?: string;
}

export interface SyntheticDaemonSources {
  tempRoot: string;
  codex: SyntheticApprovedSource;
  claudeCode: SyntheticApprovedSource;
  openClaw: SyntheticApprovedSource;
  hermes: SyntheticApprovedSource;
  cleanup(): Promise<void>;
}

export async function createSyntheticApprovedSources(
  options: SyntheticSourceOptions = {}
): Promise<SyntheticDaemonSources> {
  const tempRoot = options.root ?? await mkdtemp(join(tmpdir(), "daemon-sources-"));
  const shared = { ...options, root: tempRoot };
  const codex = await createSyntheticCodexSource(shared);
  const claudeCode = await createSyntheticClaudeCodeSource(shared);
  const openClaw = await createSyntheticOpenClawSource(shared);
  const hermes = await createSyntheticHermesSource(shared);
  return {
    tempRoot,
    codex,
    claudeCode,
    openClaw,
    hermes,
    cleanup: async () => rm(tempRoot, { recursive: true, force: true })
  };
}

export async function createSyntheticCodexSource(
  options: SyntheticSourceOptions = {}
): Promise<SyntheticApprovedSource> {
  const rootPath = await sourceRoot("codex", options);
  const nativePath = join(rootPath, "sessions/2026/07/17/rollout-daemon-codex.jsonl");
  await writeResource(nativePath, [
    JSON.stringify({ timestamp: FIXED_NOW, type: "session_meta", payload: { id: "codex-daemon-session" } }),
    JSON.stringify({
      timestamp: FIXED_NOW,
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Synthetic Codex event." }] }
    }),
    ""
  ].join("\n"));
  return approvedSource("codex", "codex-rollout-jsonl", rootPath, nativePath, options);
}

export async function createSyntheticClaudeCodeSource(
  options: SyntheticSourceOptions = {}
): Promise<SyntheticApprovedSource> {
  const rootPath = await sourceRoot("claude-code", options);
  const nativePath = join(rootPath, "projects/-synthetic/daemon-claude.jsonl");
  await writeResource(nativePath, `${JSON.stringify({
    type: "assistant",
    uuid: "claude-daemon-event",
    parentUuid: null,
    sessionId: "claude-daemon-session",
    timestamp: FIXED_NOW,
    message: { role: "assistant", content: [{ type: "text", text: "Synthetic Claude event." }] }
  })}\n`);
  return approvedSource("claude-code", "claude-project-jsonl", rootPath, nativePath, options);
}

export async function createSyntheticOpenClawSource(
  options: SyntheticSourceOptions = {}
): Promise<SyntheticApprovedSource> {
  const rootPath = await sourceRoot("openclaw", options);
  const nativePath = join(rootPath, "agents/main/sessions/daemon-openclaw.jsonl");
  await writeResource(nativePath, [
    JSON.stringify({ type: "session", version: 3, id: "openclaw-daemon-session", timestamp: FIXED_NOW }),
    JSON.stringify({
      type: "message",
      id: "openclaw-daemon-event",
      parentId: null,
      timestamp: FIXED_NOW,
      message: { role: "user", content: [{ type: "text", text: "Synthetic OpenClaw event." }] }
    }),
    ""
  ].join("\n"));
  return approvedSource("openclaw", "openclaw-session-jsonl", rootPath, nativePath, options);
}

export async function createSyntheticHermesSource(
  options: SyntheticSourceOptions = {}
): Promise<SyntheticApprovedSource> {
  const rootPath = await sourceRoot("hermes", options);
  const nativePath = join(rootPath, "state.db");
  const database = new DatabaseSync(nativePath);
  database.exec(`
    create table sessions (id text primary key, source text not null, started_at real not null);
    create table messages (
      id integer primary key autoincrement,
      session_id text not null,
      role text not null,
      content text,
      timestamp real not null
    );
    insert into sessions values ('hermes-daemon-session', 'cli', 1784289600);
    insert into messages (session_id, role, content, timestamp)
      values ('hermes-daemon-session', 'assistant', 'Synthetic Hermes event.', 1784289600);
  `);
  database.close();
  return approvedSource("hermes", "hermes-state-sqlite", rootPath, nativePath, options);
}

export function normalizePersistedDaemonState<T>(value: T): T {
  return normalize(value) as T;
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalize).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !["heartbeatAt", "expiresAt", "updatedAt"].includes(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, normalize(nested)]));
  }
  return value;
}

async function sourceRoot(application: SupportedApplication, options: SyntheticSourceOptions): Promise<string> {
  const root = options.root ?? await mkdtemp(join(tmpdir(), `daemon-${application}-`));
  const path = options.root ? join(root, application) : root;
  await mkdir(path, { recursive: true });
  return path;
}

function approvedSource(
  application: SupportedApplication,
  format: string,
  rootPath: string,
  nativePath: string,
  options: SyntheticSourceOptions
): SyntheticApprovedSource {
  const personId = options.personId ?? "person_daemon";
  const profileId = options.profileId ?? "default";
  const approvedAt = options.approvedAt ?? FIXED_NOW;
  const candidateId = `${application}_candidate_synthetic`;
  const id = `grant_${createHash("sha256").update(JSON.stringify([personId, candidateId])).digest("hex")}`;
  return {
    application,
    rootPath,
    nativePath,
    grant: {
      id,
      personId,
      candidateId,
      application,
      format,
      sourceLocator: application === "hermes" ? nativePath : rootPath,
      profileId,
      scopeId: options.scopeId ?? "scope_daemon",
      state: "approved",
      approvedAt,
      revokedAt: null,
      updatedAt: approvedAt
    }
  };
}

async function writeResource(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
