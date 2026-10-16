import { describe, expect, it, vi } from "vitest";
import { DaemonLoop } from "../../src/daemon/daemon.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import { DaemonScheduler } from "../../src/daemon/scheduler.js";
import { watchPaths } from "../../src/daemon/watch-controller.js";

describe("unattended daemon", () => {
  it("re-acquires an expired lease when recovery is enabled and stops on SIGTERM", async () => {
    let now = Date.parse("2026-10-16T00:00:00.000Z");
    const clock = { now: () => new Date(now).toISOString(), monotonicNow: () => now };
    const store = new InMemoryStore({ clock });
    const ownerToken = "owner-a";
    const loop = new DaemonLoop({
      store,
      scheduler: new DaemonScheduler(store, { clock, authority: { kind: "daemon", databaseId: "memory-db", ownerToken } }),
      clock,
      timers: { setTimeout: () => 1, clearTimeout: () => undefined },
      watcherFactory: { watch: () => ({ close() {} }) },
      power: { getPowerState: async () => "unknown" as const },
      notifier: { notify: async () => ({ capable: false, commandAccepted: false, presentation: "unverified" as const, identity: { displayName: "noop", bundleIdentifier: "noop" } }) },
      sourceRunner: { run: async () => ({ ok: true }) },
      contractionRunner: { drainSlice: async () => ({ complete: true }) },
      proposalScheduler: { runDue: async () => ({ ran: false }) }
    }, { databaseId: "memory-db", ownerToken, pid: 42, recoverExpiredLease: true });

    const acquire = vi.spyOn(store, "acquireDaemonLease");
    await loop.tick();
    now += 31_000;
    await loop.tick();
    expect(acquire.mock.calls.length).toBeGreaterThanOrEqual(2);
    const beforeStop = acquire.mock.calls.length;
    await loop.requestStop();
    await loop.tick();
    expect(acquire.mock.calls.length).toBe(beforeStop);
  });

  it("watches sqlite WAL files and leaves directory sources as one path", () => {
    expect(watchPaths("/tmp/notes")).toEqual(["/tmp/notes"]);
    expect(watchPaths("/tmp/journal.sqlite")).toEqual([
      "/tmp/journal.sqlite",
      "/tmp/journal.sqlite-wal",
      "/tmp"
    ]);
  });
});
