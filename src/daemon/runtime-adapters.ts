export type PowerState = "external" | "battery" | "unknown";

export interface DaemonClock {
  now(): string;
  monotonicNow(): number;
}

export interface DaemonTimer {
  setTimeout(callback: () => void | Promise<void>, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface WatchEvent {
  path: string;
  eventType: "change" | "rename";
}

export interface WatchHandle {
  close(): void;
}

export interface WatcherFactory {
  watch(path: string, listener: (event: WatchEvent) => void): WatchHandle;
}

export interface PowerStateProvider {
  getPowerState(): Promise<PowerState>;
}

export interface DaemonNotification {
  title: string;
  body: string;
  sourceId?: string;
}

export interface NotificationApplicationIdentity {
  displayName: string;
  bundleIdentifier: string;
}

export interface NotificationAttempt {
  capable: boolean;
  commandAccepted: boolean;
  presentation: "unverified";
  identity: NotificationApplicationIdentity;
}

export interface NotificationAdapter {
  notify(notification: DaemonNotification): Promise<NotificationAttempt>;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args?: string[]): Promise<CommandResult>;
}

export interface SignalAdapter {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
}
