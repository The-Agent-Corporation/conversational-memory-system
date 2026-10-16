import { dirname } from "node:path";
import type { SourceGrant } from "../domain/source-lifecycle.js";
import type { DaemonTimer, WatchHandle, WatcherFactory } from "./runtime-adapters.js";

export const WATCH_DEBOUNCE_MS = 2_000;

export interface WatchControllerOptions {
  timers: DaemonTimer;
  watcherFactory: WatcherFactory;
  enqueueWatchHint(personId: string, candidateId: string): void | Promise<void>;
}

export class WatchController {
  private readonly handles = new Map<string, {
    grantId: string;
    sourceLocator: string;
    handles: WatchHandle[];
  }>();
  private readonly pending = new Map<string, unknown>();
  private readonly unavailable = new Set<string>();

  constructor(private readonly options: WatchControllerOptions) {}

  watch(grant: SourceGrant): boolean {
    const key = this.key(grant.personId, grant.candidateId);
    const current = this.handles.get(key);
    if (current?.grantId === grant.id && current.sourceLocator === grant.sourceLocator) return true;
    this.closeHandle(key);
    const opened: WatchHandle[] = [];
    try {
      for (const path of watchPaths(grant.sourceLocator)) {
        opened.push(this.options.watcherFactory.watch(path, () => this.onEvent(grant)));
      }
      this.handles.set(key, { grantId: grant.id, sourceLocator: grant.sourceLocator, handles: opened });
      this.unavailable.delete(key);
      return true;
    } catch {
      // Watch delivery is advisory. The scheduler's durable periodic rescan remains authoritative.
      for (const handle of opened) handle.close();
      this.unavailable.add(key);
      return false;
    }
  }

  sync(grants: readonly SourceGrant[]): void {
    const approved = grants.filter((grant) => grant.state === "approved");
    const active = new Set(approved.map((grant) => this.key(grant.personId, grant.candidateId)));
    for (const key of [...this.handles.keys(), ...this.unavailable]) {
      if (active.has(key)) continue;
      this.closeKey(key);
    }
    for (const grant of approved) this.watch(grant);
  }

  isWatchAvailable(personId: string, candidateId: string): boolean {
    return !this.unavailable.has(this.key(personId, candidateId));
  }

  close(): void {
    for (const timer of this.pending.values()) this.options.timers.clearTimeout(timer);
    this.pending.clear();
    for (const entry of this.handles.values()) {
      for (const handle of entry.handles) handle.close();
    }
    this.handles.clear();
    this.unavailable.clear();
  }

  private onEvent(grant: SourceGrant): void {
    const key = this.key(grant.personId, grant.candidateId);
    if (this.pending.has(key)) return;
    const timer = this.options.timers.setTimeout(async () => {
      this.pending.delete(key);
      await this.options.enqueueWatchHint(grant.personId, grant.candidateId);
    }, WATCH_DEBOUNCE_MS);
    this.pending.set(key, timer);
  }

  private closeHandle(key: string): void {
    for (const handle of this.handles.get(key)?.handles ?? []) handle.close();
    this.handles.delete(key);
  }

  private closeKey(key: string): void {
    const timer = this.pending.get(key);
    if (timer !== undefined) this.options.timers.clearTimeout(timer);
    this.pending.delete(key);
    this.closeHandle(key);
    this.unavailable.delete(key);
  }

  private key(personId: string, candidateId: string): string {
    return `${personId}\u0000${candidateId}`;
  }
}

/** SQLite journals append to `-wal`. Directory sources stay a single watch. */
export function watchPaths(sourceLocator: string): string[] {
  if (!/\.(db|sqlite)$/i.test(sourceLocator)) return [sourceLocator];
  return [...new Set([sourceLocator, `${sourceLocator}-wal`, dirname(sourceLocator)])];
}
